/**
 * Run budgets (plan §4.2) and storage limits (plan §3.4). These are our own
 * limits, not a promise about what an issuer tolerates. The production
 * target uses them unchanged (a unit test pins every value); the test target
 * may only shorten waits so the fake-issuer suite runs in reasonable time.
 */
export interface Timings {
  /** Minimum gap between two active issuer requests from one document. */
  readonly requestIntervalMs: number;
  readonly requestTimeoutMs: number;
  /** Whole read run (discovery or transactions), including waits. */
  readonly runLimitMs: number;
  readonly maxPagesPerAccount: number;
  /** Active requests per issuer per run, discovery included. */
  readonly maxRequestsPerRun: number;
  /** Default overlap window for isolated reads. */
  readonly defaultWindowDays: number;
  /** Decoded response text processed per issuer response. */
  readonly maxResponseBytes: number;
  /** Pause after a 429 without Retry-After. */
  readonly rateLimitPauseMs: number;
  /** A frozen, unsent batch lives this long. */
  readonly previewTtlMs: number;
  /** Everything the extension keeps in storage.session. */
  readonly sessionBudgetBytes: number;
  readonly holdrTimeoutMs: number;
  /** Bounded Holdr retries after 502/503/timeout/network: at most two. */
  readonly holdrRetryDelaysMs: readonly number[];
  readonly shapeModeMs: number;
  /**
   * Allowance for the clock difference between this browser and Holdr when judging that a plan has expired at Holdr
   * (a commit of it that may still land is then settled by a receipt asked for afterwards).
   */
  readonly planSettleMarginMs: number;
}

export const PLAN_TIMINGS: Timings = Object.freeze({
  requestIntervalMs: 5_000,
  requestTimeoutMs: 15_000,
  runLimitMs: 180_000,
  maxPagesPerAccount: 10,
  maxRequestsPerRun: 20,
  defaultWindowDays: 30,
  maxResponseBytes: 2 * 1024 * 1024,
  rateLimitPauseMs: 30 * 60 * 1_000,
  previewTtlMs: 10 * 60 * 1_000,
  sessionBudgetBytes: 8 * 1024 * 1024,
  holdrTimeoutMs: 15_000,
  holdrRetryDelaysMs: Object.freeze([2_000, 8_000]),
  shapeModeMs: 10 * 60 * 1_000,
  planSettleMarginMs: 2 * 60 * 1_000,
});
