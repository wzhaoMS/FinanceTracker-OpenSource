import type { Database as DB } from 'better-sqlite3';

import type { SqliteStateRepo } from './sqliteStateRepo.js';
import { hashToken, makeId, newSecret } from './authRepo.js';

/**
 * Local username/password accounts and their sessions (tables `local_users`
 * and `local_sessions`). Accounts are created and reset only by the
 * server-side `holdr-user` CLI; there is no signup endpoint. Every household
 * member sees everything, so a user row carries no ownership data.
 *
 * Session tokens are random 32-byte secrets handed to the browser once. Only
 * their sha256 digest is stored (same scheme as AuthRepo).
 */

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** A user-facing problem with a normalized username, or null when valid. */
export function usernameProblem(username: string): string | null {
  return USERNAME_PATTERN.test(username)
    ? null
    : 'username must be 1-32 characters: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit';
}

export interface LocalUser {
  id: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalUserWithHash extends LocalUser {
  passwordHash: string;
}

export interface LocalSession {
  /** sha256 hex of the cookie token. */
  id: string;
  userId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  renewedAt: string;
  /** Issued as a Secure cookie in HTTPS mode. */
  secure: boolean;
}

export class UserExistsError extends Error {
  constructor(username: string) {
    super(`user "${username}" already exists`);
    this.name = 'UserExistsError';
  }
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

function toUser(row: UserRow): LocalUserWithHash {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LocalAuthRepo {
  private readonly db: DB;

  constructor(state: SqliteStateRepo) {
    // Same handle as the portfolio data; SqliteStateRepo creates the tables.
    this.db = state.internalGetDb();
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM local_users').get() as { n: number }).n;
  }

  listUsers(now: Date = new Date()): Array<LocalUser & { activeSessions: number }> {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.created_at, u.updated_at,
                (SELECT COUNT(*) FROM local_sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active
           FROM local_users u
          ORDER BY u.username`,
      )
      .all(now.toISOString()) as Array<Omit<UserRow, 'password_hash'> & { active: number }>;
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeSessions: row.active,
    }));
  }

  findUser(username: string): LocalUserWithHash | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, created_at, updated_at FROM local_users WHERE username = ?')
      .get(username) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  createUser(username: string, passwordHash: string, now: Date = new Date()): LocalUser {
    const problem = usernameProblem(username);
    if (problem) throw new Error(problem);
    const id = makeId('lu');
    const stamp = now.toISOString();
    try {
      this.db
        .prepare(
          'INSERT INTO local_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, username, passwordHash, stamp, stamp);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new UserExistsError(username);
      throw err;
    }
    return { id, username, createdAt: stamp, updatedAt: stamp };
  }

  /**
   * Replace a user's password hash. With `revokeSessions` every existing
   * session of that user ends, so a password reset signs out all devices.
   * Returns null when the user does not exist. BEGIN IMMEDIATE takes the
   * write lock up front, so this serializes with startSession() even across
   * processes (the CLI and the API).
   */
  setPasswordHash(
    username: string,
    passwordHash: string,
    options: { revokeSessions: boolean; expectedUserId?: string },
    now: Date = new Date(),
  ): { revokedSessions: number } | null {
    const tx = this.db.transaction(() => {
      const user = this.findUser(username);
      if (!user || (options.expectedUserId !== undefined && user.id !== options.expectedUserId)) return null;
      this.db
        .prepare('UPDATE local_users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, now.toISOString(), user.id);
      const revokedSessions = options.revokeSessions
        ? this.db.prepare('DELETE FROM local_sessions WHERE user_id = ?').run(user.id).changes
        : 0;
      return { revokedSessions };
    });
    return tx.immediate();
  }

  /** Deletes the user; their sessions go with them (ON DELETE CASCADE). */
  removeUser(username: string, expectedUserId?: string): boolean {
    return expectedUserId === undefined
      ? this.db.prepare('DELETE FROM local_users WHERE username = ?').run(username).changes > 0
      : this.db.prepare('DELETE FROM local_users WHERE username = ? AND id = ?').run(username, expectedUserId).changes > 0;
  }

  /**
   * Completes a sign-in in ONE write transaction: the user must still exist
   * with exactly the password hash the caller verified against (a reset or
   * removal while scrypt ran makes this return null), an optional rehash is
   * swapped in only over that same hash, the session presented with the
   * login request (if any) is ended, and the new session is created.
   */
  startSession(input: {
    userId: string;
    verifiedPasswordHash: string;
    rehashedPasswordHash?: string;
    replaceToken?: string | null;
    ttlMs: number;
    now?: Date;
    /** HTTPS mode: the token only ever travels in a Secure cookie. */
    secure?: boolean;
  }): { token: string; expiresAt: string } | null {
    const now = input.now ?? new Date();
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT password_hash FROM local_users WHERE id = ?')
        .get(input.userId) as { password_hash: string } | undefined;
      if (!current || current.password_hash !== input.verifiedPasswordHash) return null;
      if (input.rehashedPasswordHash) {
        this.db
          .prepare('UPDATE local_users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ?')
          .run(input.rehashedPasswordHash, now.toISOString(), input.userId, input.verifiedPasswordHash);
      }
      if (input.replaceToken) this.deleteSession(input.replaceToken);
      return this.createSession(input.userId, input.ttlMs, now, input.secure ?? false);
    });
    return tx.immediate();
  }

  createSession(
    userId: string,
    ttlMs: number,
    now: Date = new Date(),
    secure = false,
  ): { token: string; expiresAt: string } {
    const token = newSecret();
    const stamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db
      .prepare('INSERT INTO local_sessions (id, user_id, created_at, expires_at, renewed_at, secure) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(token), userId, stamp, expiresAt, stamp, secure ? 1 : 0);
    return { token, expiresAt };
  }

  /**
   * The live session for a raw cookie token. Expired rows are deleted on
   * sight, and so are plain-HTTP rows when `secureOnly` (HTTPS mode) is set.
   */
  findSession(token: string, now: Date = new Date(), options: { secureOnly?: boolean } = {}): LocalSession | null {
    if (!token) return null;
    const id = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT s.id, s.user_id, u.username, s.created_at, s.expires_at, s.renewed_at, s.secure
           FROM local_sessions s JOIN local_users u ON u.id = s.user_id
          WHERE s.id = ?`,
      )
      .get(id) as
      | {
          id: string; user_id: string; username: string;
          created_at: string; expires_at: string; renewed_at: string; secure: number;
        }
      | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime() || (options.secureOnly && row.secure !== 1)) {
      this.deleteSessionById(id);
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      renewedAt: row.renewed_at,
      secure: row.secure === 1,
    };
  }

  /**
   * Read-only write-boundary proof of the original session and user. The digest of the durable password verifier is a
   * per-user credential epoch: every CLI reset changes it even when resetting to the same password. It never leaves auth.
   */
  sessionCredentialEpoch(sessionId: string, userId: string, now: Date, secureOnly: boolean): string | null {
    const row = this.db.prepare(`SELECT u.password_hash FROM local_sessions s JOIN local_users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND (? = 0 OR s.secure = 1)`)
      .get(sessionId, userId, now.toISOString(), secureOnly ? 1 : 0) as { password_hash: string } | undefined;
    return row ? hashToken(row.password_hash) : null;
  }

  /** Slide a session's expiry forward. */
  renewSession(sessionId: string, ttlMs: number, now: Date = new Date()): string {
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db
      .prepare('UPDATE local_sessions SET expires_at = ?, renewed_at = ? WHERE id = ?')
      .run(expiresAt, now.toISOString(), sessionId);
    return expiresAt;
  }

  deleteSession(token: string): boolean {
    return this.deleteSessionById(hashToken(token));
  }

  deleteSessionById(sessionId: string): boolean {
    return this.db.prepare('DELETE FROM local_sessions WHERE id = ?').run(sessionId).changes > 0;
  }

  reapExpiredSessions(now: Date = new Date()): number {
    return this.db.prepare('DELETE FROM local_sessions WHERE expires_at <= ?').run(now.toISOString()).changes;
  }

  /** HTTPS mode start-up: end every session whose token was handed out over plain HTTP. */
  deleteInsecureSessions(): number {
    return this.db.prepare('DELETE FROM local_sessions WHERE secure = 0').run().changes;
  }
}
