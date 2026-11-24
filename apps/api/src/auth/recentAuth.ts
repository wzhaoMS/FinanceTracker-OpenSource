/**
 * Recent authentication (E1b design §10 items 9, 11 and 14; the E8-M
 * proposal Q2): a signed-in session that re-entered its password through
 * POST /auth/reverify within the last five minutes. Only that session counts,
 * never the user's other sessions, and the confirmation lives in this
 * process's memory alone: a restart, a sign-out or five minutes end it, so
 * nothing about it can outlive the process or be restored from a backup.
 * Bounded: the oldest confirmations give way first.
 */

export const RECENT_AUTH_MS = 5 * 60 * 1000;
export const RECENT_AUTH_MAX_SESSIONS = 1_000;

export class RecentAuth {
  private readonly until = new Map<string, number>();

  constructor(private readonly windowMs = RECENT_AUTH_MS, private readonly maxSessions = RECENT_AUTH_MAX_SESSIONS) {}

  /** Records the session's password re-check at `nowMs`; returns when it lapses. */
  confirm(sessionId: string, nowMs: number): number {
    for (const [id, lapse] of this.until) if (lapse <= nowMs) this.until.delete(id);
    this.until.delete(sessionId);
    while (this.until.size >= this.maxSessions) this.until.delete(this.until.keys().next().value!);
    const lapse = nowMs + this.windowMs;
    this.until.set(sessionId, lapse);
    return lapse;
  }

  /** Whether the session re-checked its password within the window. */
  isRecent(sessionId: string, nowMs: number): boolean {
    const lapse = this.until.get(sessionId);
    if (lapse === undefined) return false;
    if (lapse > nowMs) return true;
    this.until.delete(sessionId);
    return false;
  }

  /** Ends the session's confirmation (sign-out). */
  forget(sessionId: string): void {
    this.until.delete(sessionId);
  }

  get size(): number {
    return this.until.size;
  }
}
