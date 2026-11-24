/**
 * The balance chain as a card source's admission predicate (roadmap §5.3; W4's G-ADMISSION hook; design W6 v1 §7, D10).
 * W4 runs `verifyCardAccountChain` on the database before and after the import's apply, inside its transaction, and
 * this decides. Root's rulings:
 * - a failing step holds, unless a recorded baseline accepted that very step with the same pin (no baseline accepts
 *   nothing, so then every failing step holds; BEFORE never grandfathers a failure);
 * - a step that passed in BEFORE or in the baseline and no longer passes holds, and so does `reconciledThrough` moving
 *   back;
 * - a baseline of another verifier or rules is stale and holds;
 * - `unknown` never holds, and never passes as reconciled.
 * The answer carries W4's receipt entry (`id`, `result`, both dates) plus the hold decision. It is value-free.
 */
import {
  BALANCE_CHAIN_VERIFIER,
  type BalanceChainResult,
  type BalanceStepReason,
  type BalanceStepVerdict,
} from './verify.js';

export interface BalanceChainBaselineStep {
  from: string;
  to: string;
  verdict: BalanceStepVerdict;
  reason: BalanceStepReason;
  pin?: string;
}

export interface BalanceChainBaselineAccount {
  /** The account's report key (`balanceChainAccountKey`). */
  id: string;
  reconciledThrough: string | null;
  steps: BalanceChainBaselineStep[];
}

/** A recorded baseline, as `parseBalanceChainBaseline` reads the `holdr-balance-chain report --detail` line. */
export interface BalanceChainBaseline {
  verifier: string;
  rules: string;
  accounts: ReadonlyMap<string, BalanceChainBaselineAccount>;
}

export type BalanceChainAdmissionCode = 'balance-chain-fail' | 'balance-chain-regressed' | 'balance-chain-baseline-stale';

export interface BalanceChainAdmission {
  id: 'balance-chain';
  result: 'pass' | 'fail' | 'unknown' | 'not-applicable';
  hold: boolean;
  code: BalanceChainAdmissionCode | null;
  /** `pre-existing` when BEFORE already failed the same test; `import` when the import made it fail. */
  cause: 'import' | 'pre-existing' | null;
  reconciledThroughBefore: string | null;
  reconciledThroughAfter: string | null;
}

const key = (step: { from: string; to: string }) => `${step.from}|${step.to}`;

/** True when `a` is earlier than `b`; no date is earlier than any date. */
function earlier(a: string | null, b: string | null): boolean {
  if (b === null) return false;
  return a === null || a < b;
}

/**
 * Decides whether an import into one account may commit. `before` and `after` are null for an account kind the verifier
 * does not cover (`not-applicable`, never held). `baseline` is the whole recorded baseline, or null when none is
 * recorded; `accountKey` picks the account's entry from it.
 */
export function admitBalanceChain(args: {
  accountKey: string;
  before: BalanceChainResult | null;
  after: BalanceChainResult | null;
  baseline: BalanceChainBaseline | null;
}): BalanceChainAdmission {
  const { before, after, baseline } = args;
  const answer = (result: BalanceChainAdmission['result'], code: BalanceChainAdmissionCode | null, cause: BalanceChainAdmission['cause']):
    BalanceChainAdmission => ({
    id: 'balance-chain', result, hold: code !== null, code, cause,
    reconciledThroughBefore: before?.reconciledThrough ?? null, reconciledThroughAfter: after?.reconciledThrough ?? null,
  });
  if (before === null || after === null) return answer('not-applicable', null, null);
  if (baseline !== null && (baseline.verifier !== BALANCE_CHAIN_VERIFIER || baseline.verifier !== after.verifier || baseline.rules !== after.rules)) {
    return answer('fail', 'balance-chain-baseline-stale', null);
  }
  const recorded = baseline?.accounts.get(args.accountKey) ?? null;

  // 1. Failing steps, unless the baseline accepted that very step with the same pin.
  const accepted = new Map((recorded?.steps ?? []).filter((step) => step.verdict === 'fail').map((step) => [key(step), step.pin ?? null]));
  const unaccepted = (result: BalanceChainResult) => result.steps
    .filter((step) => step.verdict === 'fail' && accepted.get(key(step)) !== (step.pin ?? null))
    .map((step) => `${key(step)}|${step.reason}|${step.pin ?? ''}`);
  const failsAfter = unaccepted(after);
  if (failsAfter.length > 0) {
    const failsBefore = new Set(unaccepted(before));
    return answer('fail', 'balance-chain-fail', failsAfter.every((fail) => failsBefore.has(fail)) ? 'pre-existing' : 'import');
  }

  // 2. Regressions: a lost pass, or reconciledThrough moving back, against BEFORE and against the baseline.
  const verdictAfter = new Map(after.steps.map((step) => [key(step), step.verdict]));
  const verdictBefore = new Map(before.steps.map((step) => [key(step), step.verdict]));
  const passedBefore = before.steps.filter((step) => step.verdict === 'pass').map(key);
  const passedRecorded = (recorded?.steps ?? []).filter((step) => step.verdict === 'pass').map(key);
  const lostByImport = passedBefore.some((step) => verdictAfter.get(step) !== 'pass') || earlier(after.reconciledThrough, before.reconciledThrough);
  const lostSinceBaseline = passedRecorded.some((step) => verdictAfter.get(step) !== 'pass')
    || (recorded !== null && earlier(after.reconciledThrough, recorded.reconciledThrough));
  if (lostByImport || lostSinceBaseline) {
    const alreadyLost = passedRecorded.some((step) => verdictBefore.get(step) !== 'pass')
      || (recorded !== null && earlier(before.reconciledThrough, recorded.reconciledThrough));
    return answer('fail', 'balance-chain-regressed', lostByImport || !alreadyLost ? 'import' : 'pre-existing');
  }
  return answer(after.result, null, null);
}
