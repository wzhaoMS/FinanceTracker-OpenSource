/**
 * In-memory login throttling, keyed per client IP and per username.
 *
 * Every attempt is counted as a failure *before* the password is checked and
 * cleared only when it succeeds, so a burst of concurrent guesses cannot all
 * slip through while scrypt is still running. After `freeFailures` failures a
 * key is locked for baseDelayMs, doubling with each further failure up to
 * maxDelayMs. History is forgotten after forgetAfterMs without a failure, and
 * on successful sign-in. State resets when the API restarts; that is
 * acceptable for a two-person home server.
 */

export interface ThrottlePolicy {
  /** Failures allowed before any lock applies. */
  freeFailures: number;
  baseDelayMs: number;
  maxDelayMs: number;
  forgetAfterMs: number;
}

export const DEFAULT_USER_POLICY: Readonly<ThrottlePolicy> = Object.freeze({
  freeFailures: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
});

export const DEFAULT_IP_POLICY: Readonly<ThrottlePolicy> = Object.freeze({
  freeFailures: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
});

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export interface LoginAttemptKeys {
  ip: string;
  username: string;
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface LoginThrottleOptions {
  ipPolicy?: ThrottlePolicy;
  userPolicy?: ThrottlePolicy;
  /** Upper bound on tracked keys; the least recently used are evicted first. */
  maxEntries?: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly ipPolicy: ThrottlePolicy;
  private readonly userPolicy: ThrottlePolicy;
  private readonly maxEntries: number;

  constructor(options: LoginThrottleOptions = {}) {
    this.ipPolicy = options.ipPolicy ?? DEFAULT_IP_POLICY;
    this.userPolicy = options.userPolicy ?? DEFAULT_USER_POLICY;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /**
   * Reserve an attempt. Refuses while either key is locked; otherwise records
   * the attempt as a failure until `succeed` clears it.
   */
  begin(keys: LoginAttemptKeys, now: number): ThrottleDecision {
    const targets = this.targets(keys);
    let retryAfterMs = 0;
    for (const { key, policy } of targets) {
      const entry = this.current(key, policy, now);
      if (entry && entry.lockedUntil > now) retryAfterMs = Math.max(retryAfterMs, entry.lockedUntil - now);
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
    for (const { key, policy } of targets) this.recordFailure(key, policy, now);
    return { allowed: true };
  }

  succeed(keys: LoginAttemptKeys): void {
    for (const { key } of this.targets(keys)) this.entries.delete(key);
  }

  /** Test/diagnostic view of a key's failure count. */
  failures(kind: 'ip' | 'user', value: string): number {
    return this.entries.get(`${kind}:${value}`)?.failures ?? 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private targets(keys: LoginAttemptKeys): Array<{ key: string; policy: ThrottlePolicy }> {
    return [
      { key: `ip:${keys.ip}`, policy: this.ipPolicy },
      { key: `user:${keys.username}`, policy: this.userPolicy },
    ];
  }

  private current(key: string, policy: ThrottlePolicy, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && now - entry.lastFailureAt > policy.forgetAfterMs && entry.lockedUntil <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private recordFailure(key: string, policy: ThrottlePolicy, now: number): void {
    const entry = this.current(key, policy, now) ?? { failures: 0, lockedUntil: 0, lastFailureAt: now };
    entry.failures += 1;
    entry.lastFailureAt = now;
    if (entry.failures >= policy.freeFailures) {
      const exponent = Math.min(entry.failures - policy.freeFailures, 30);
      entry.lockedUntil = now + Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
    }
    // Re-insert so Map order tracks recency for eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
