import { createHash, randomBytes } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';

import type { SqliteStateRepo } from './sqliteStateRepo.js';

/**
 * Auth + household repo. Backed by the same SQLite DB as the portfolio data
 * (separation of concerns lives in the schema, not in the file).
 *
 * All write operations are wrapped in transactions so an aborted upgrade
 * leaves the prior state untouched.
 *
 * Tokens (sessions, invites, oauth_state cookie) are NEVER stored raw.
 * Callers see a one-time secret returned from creation; the DB only keeps
 * a sha256 hex digest. Lookups happen by hashing the inbound secret and
 * matching the digest column.
 */

export interface User {
  id: string;
  householdId: string;
  email: string;
  name: string;
  googleSub: string;
  picture?: string;
  createdAt: string;
}

export interface Household {
  id: string;
  name: string;
  createdAt: string;
}

export type Role = 'owner' | 'member';

export interface Membership {
  householdId: string;
  userId: string;
  role: Role;
  joinedAt: string;
}

export interface Session {
  id: string;          // sha256 hex of the cookie value (never the secret itself)
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface OAuthStateRow {
  state: string;
  csrfHash: string;
  inviteTokenHash?: string;
  expiresAt: string;
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Random opaque secret used as a cookie / token value. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Hash a secret for at-rest storage. */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;       // 10 minutes

export class AuthRepo {
  private readonly db: DB;

  constructor(state: SqliteStateRepo) {
    // Reuse the SqliteStateRepo's DB handle so both repos hit the same
    // file/transaction context. The schema bootstrap on SqliteStateRepo
    // already creates the auth tables, so we don't repeat it here.
    this.db = state.internalGetDb();
  }

  // -------------------------------------------------------------------------
  // Households + users + memberships
  // -------------------------------------------------------------------------

  /** True iff at least one user exists. Drives the lockdown-after-first-member rule. */
  hasAnyUser(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n > 0;
  }

  /** Returns the single household, or null if uninitialized. */
  getSingleHousehold(): Household | null {
    const r = this.db
      .prepare('SELECT id, name, created_at FROM households ORDER BY created_at LIMIT 1')
      .get() as { id: string; name: string; created_at: string } | undefined;
    if (!r) return null;
    return { id: r.id, name: r.name, createdAt: r.created_at };
  }

  /** Create the bootstrap household. v1 hosts at most one. */
  createHousehold(name: string): Household {
    if (this.getSingleHousehold()) {
      throw new Error('createHousehold: a household already exists (v1 is single-household)');
    }
    const id = makeId('hh');
    this.db.prepare('INSERT INTO households (id, name) VALUES (?, ?)').run(id, name);
    return this.getHousehold(id)!;
  }

  getHousehold(id: string): Household | null {
    const r = this.db
      .prepare('SELECT id, name, created_at FROM households WHERE id = ?')
      .get(id) as { id: string; name: string; created_at: string } | undefined;
    if (!r) return null;
    return { id: r.id, name: r.name, createdAt: r.created_at };
  }

  getUserByGoogleSub(sub: string): User | null {
    const r = this.db
      .prepare('SELECT id, household_id, email, name, google_sub, picture, created_at FROM users WHERE google_sub = ?')
      .get(sub) as
      | { id: string; household_id: string; email: string; name: string; google_sub: string; picture: string | null; created_at: string }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      householdId: r.household_id,
      email: r.email,
      name: r.name,
      googleSub: r.google_sub,
      picture: r.picture ?? undefined,
      createdAt: r.created_at,
    };
  }

  getUserById(id: string): User | null {
    const r = this.db
      .prepare('SELECT id, household_id, email, name, google_sub, picture, created_at FROM users WHERE id = ?')
      .get(id) as
      | { id: string; household_id: string; email: string; name: string; google_sub: string; picture: string | null; created_at: string }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      householdId: r.household_id,
      email: r.email,
      name: r.name,
      googleSub: r.google_sub,
      picture: r.picture ?? undefined,
      createdAt: r.created_at,
    };
  }

  /**
   * Create a user, attach to a household, record membership. All in one
   * transaction so a partial state never escapes.
   */
  createUserWithMembership(input: {
    householdId: string;
    email: string;
    name: string;
    googleSub: string;
    picture?: string;
    role: Role;
  }): User {
    const id = makeId('u');
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO users (id, household_id, email, name, google_sub, picture) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.householdId, input.email, input.name, input.googleSub, input.picture ?? null);
      this.db
        .prepare('INSERT INTO memberships (household_id, user_id, role) VALUES (?, ?, ?)')
        .run(input.householdId, id, input.role);
    });
    tx();
    return this.getUserById(id)!;
  }

  listMembers(householdId: string): Array<User & { role: Role; joinedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.household_id, u.email, u.name, u.google_sub, u.picture, u.created_at,
                m.role, m.joined_at
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.household_id = u.household_id
         WHERE u.household_id = ?
         ORDER BY m.joined_at`,
      )
      .all(householdId) as Array<{
        id: string;
        household_id: string;
        email: string;
        name: string;
        google_sub: string;
        picture: string | null;
        created_at: string;
        role: Role;
        joined_at: string;
      }>;
    return rows.map((r) => ({
      id: r.id,
      householdId: r.household_id,
      email: r.email,
      name: r.name,
      googleSub: r.google_sub,
      picture: r.picture ?? undefined,
      createdAt: r.created_at,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Issue a new session for a user. Returns the raw secret (cookie value) —
   * stored only as sha256 hex in the DB. Only ever returned to the caller of
   * this method; impossible to recover later.
   */
  createSession(userId: string, ttlMs = SESSION_TTL_MS): { secret: string; expiresAt: string } {
    const secret = newSecret();
    const id = hashToken(secret);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(id, userId, expiresAt);
    return { secret, expiresAt };
  }

  /** Look up an active session by its raw cookie value. */
  findActiveSession(secret: string): { userId: string; expiresAt: string } | null {
    if (!secret) return null;
    const id = hashToken(secret);
    const r = this.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
      .get(id) as { user_id: string; expires_at: string } | undefined;
    if (!r) return null;
    if (Date.parse(r.expires_at) <= Date.now()) {
      this.deleteSessionByHash(id);
      return null;
    }
    return { userId: r.user_id, expiresAt: r.expires_at };
  }

  deleteSession(secret: string): boolean {
    return this.deleteSessionByHash(hashToken(secret));
  }

  private deleteSessionByHash(id: string): boolean {
    const info = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** Drop expired session rows. Cheap GC. */
  reapSessions(): number {
    const info = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
      .run();
    return info.changes;
  }

  // -------------------------------------------------------------------------
  // OAuth state (CSRF + invite-token binding)
  // -------------------------------------------------------------------------

  createOAuthState(opts: {
    csrfSecret: string;        // raw cookie value (will be hashed)
    inviteToken?: string;      // raw invite token (will be hashed)
    ttlMs?: number;
  }): string {
    const state = newSecret(16); // shorter, query-safe
    const expiresAt = new Date(Date.now() + (opts.ttlMs ?? OAUTH_STATE_TTL_MS)).toISOString();
    this.db
      .prepare(
        'INSERT INTO oauth_state (state, csrf_hash, invite_token_hash, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        state,
        hashToken(opts.csrfSecret),
        opts.inviteToken ? hashToken(opts.inviteToken) : null,
        expiresAt,
      );
    return state;
  }

  /**
   * Consume an OAuth state row. Returns the bound invite-token hash if any.
   * Single-use: the row is deleted on success or on csrf mismatch.
   */
  consumeOAuthState(state: string, csrfSecret: string): { inviteTokenHash: string | null } | null {
    const r = this.db
      .prepare('SELECT csrf_hash, invite_token_hash, expires_at FROM oauth_state WHERE state = ?')
      .get(state) as { csrf_hash: string; invite_token_hash: string | null; expires_at: string } | undefined;
    if (!r) return null;
    // Delete unconditionally (single-use, even on mismatch).
    this.db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
    if (Date.parse(r.expires_at) <= Date.now()) return null;
    if (r.csrf_hash !== hashToken(csrfSecret)) return null;
    return { inviteTokenHash: r.invite_token_hash };
  }

  reapOAuthState(): number {
    const info = this.db
      .prepare("DELETE FROM oauth_state WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
      .run();
    return info.changes;
  }
}
