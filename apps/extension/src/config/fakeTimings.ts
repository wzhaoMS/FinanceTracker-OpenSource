/**
 * The timings of the fake-issuer builds (test and acceptance): waits are
 * shortened so a suite runs in minutes; every other budget is the plan's.
 */
import type { Timings } from './timings.js';
import { PLAN_TIMINGS } from './timings.js';

export const FAKE_TARGET_TIMINGS: Timings = Object.freeze({
  ...PLAN_TIMINGS,
  requestIntervalMs: 150,
  requestTimeoutMs: 3_000,
  runLimitMs: 30_000,
  holdrTimeoutMs: 3_000,
  holdrRetryDelaysMs: Object.freeze([200, 400]),
  planSettleMarginMs: 1_000,
});
