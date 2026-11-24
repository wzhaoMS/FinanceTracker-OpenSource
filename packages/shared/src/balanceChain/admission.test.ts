import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { admitBalanceChain, type BalanceChainBaseline } from './admission.js';
import {
  BALANCE_CHAIN_REPORT_FORMAT,
  BALANCE_CHAIN_REPORT_VERSION,
  balanceChainAccountKey,
  balanceChainReportAccount,
  parseBalanceChainBaseline,
  type BalanceChainReport,
} from './report.js';
import {
  BALANCE_CHAIN_VERIFIER,
  balanceChainRules,
  verifyBalanceChain,
  type BalanceAnchorInput,
  type BalanceChainResult,
  type BalanceCoverageRange,
  type BalanceRowInput,
} from './verify.js';

// Synthetic only: made-up ids, dates, refs and cents. Each test plays W4's part: the chain before an import's apply and
// after it, in one account, then the admission.

const ACCOUNT = `card-acct-${'c'.repeat(32)}`;
const REF = `lh1:${'d'.repeat(64)}`;
const anchor = (date: string, balanceMinor: number): BalanceAnchorInput => ({ date, balanceMinor, kind: 'statement-closing', source: 'statement-facts', ref: REF });
const row = (id: string, date: string, amountMinor: number, rowClass: BalanceRowInput['rowClass'] = 'posting', currency = 'USD'): BalanceRowInput => ({
  id: `card-txn-${id}`, date, amountMinor, rowClass, currency,
});
const range = (start: string, end: string): BalanceCoverageRange => ({ start, end });
const chain = (anchors: BalanceAnchorInput[], rows: BalanceRowInput[], coverage: BalanceCoverageRange[]) =>
  verifyBalanceChain({ accountId: ACCOUNT, currency: 'USD', anchors, rows, coverage });

/** The baseline line `holdr-balance-chain report --detail` would print for this one account, read back. */
function baselineOf(result: BalanceChainResult): BalanceChainBaseline {
  const report: BalanceChainReport = {
    format: BALANCE_CHAIN_REPORT_FORMAT, version: BALANCE_CHAIN_REPORT_VERSION, verifier: BALANCE_CHAIN_VERIFIER, rules: result.rules, timingWindowDays: 10,
    stores: { checking: 'absent', statementFacts: 'present' },
    accounts: [balanceChainReportAccount({ kind: 'card', id: ACCOUNT, issuer: 'testbank', last4: '1234', status: 'active' }, result, { untrusted: 0, excluded: 0 }, true)],
  };
  return parseBalanceChainBaseline(`${JSON.stringify(report)}\n`);
}
const admit = (before: BalanceChainResult | null, after: BalanceChainResult | null, baseline: BalanceChainBaseline | null = null) =>
  admitBalanceChain({ accountKey: balanceChainAccountKey(ACCOUNT), before, after, baseline });

// A posting-dated card (non-Amex OFX): statements close at month end.
const anchors = [anchor('2026-05-31', 0), anchor('2026-06-30', 300), anchor('2026-07-31', 500)];
const june = [row('aaaaaaaa', '2026-06-10', 300)];
const july = [row('aaaaaaab', '2026-07-10', 200)];
const juneAndJuly = [range('2026-05-01', '2026-07-31')];

describe('admitting an import into a posting-dated card', () => {
  it('admits an import that keeps every step passing, and reports pass with both dates', () => {
    const before = chain(anchors, june, [range('2026-05-01', '2026-06-30')]);
    const after = chain(anchors, [...june, ...july], juneAndJuly);
    assert.equal(before.reconciledThrough, '2026-06-30');
    assert.deepEqual(admit(before, after), {
      id: 'balance-chain', result: 'pass', hold: false, code: null, cause: null,
      reconciledThroughBefore: '2026-06-30', reconciledThroughAfter: '2026-07-31',
    });
  });

  it('holds an import that makes a step fail: a duplicate in a passing period', () => {
    const before = chain(anchors, [...june, ...july], juneAndJuly);
    const after = chain(anchors, [...june, ...july, row('aaaaaaac', '2026-06-11', 300)], juneAndJuly);
    assert.deepEqual(admit(before, after), {
      id: 'balance-chain', result: 'fail', hold: true, code: 'balance-chain-fail', cause: 'import',
      reconciledThroughBefore: '2026-07-31', reconciledThroughAfter: null,
    });
  });

  it('never grandfathers a failure through BEFORE: with no baseline every failing step holds, as pre-existing', () => {
    const failing = chain(anchors, [...june, row('aaaaaaac', '2026-06-11', 300), ...july], juneAndJuly);
    const next = chain([...anchors, anchor('2026-08-31', 500)], [...june, row('aaaaaaac', '2026-06-11', 300), ...july], [range('2026-05-01', '2026-08-31')]);
    assert.equal(failing.state, 'failing');
    assert.deepEqual(admit(failing, next), {
      id: 'balance-chain', result: 'fail', hold: true, code: 'balance-chain-fail', cause: 'pre-existing',
      reconciledThroughBefore: null, reconciledThroughAfter: null,
    });
  });

  it('a failure Root accepted in the baseline is admitted while it stays exactly as accepted', () => {
    const failing = chain(anchors, [...june, row('aaaaaaac', '2026-06-11', 300), ...july], juneAndJuly);
    const baseline = baselineOf(failing);
    const later = chain([...anchors, anchor('2026-08-31', 500)], [...june, row('aaaaaaac', '2026-06-11', 300), ...july], [range('2026-05-01', '2026-08-31')]);
    const decision = admit(failing, later, baseline);
    assert.equal(decision.hold, false);
    assert.equal(decision.result, 'fail');
    assert.equal(decision.code, null);
  });

  it('an accepted failure that changes holds: its pin no longer matches', () => {
    const failing = chain(anchors, [...june, row('aaaaaaac', '2026-06-11', 300), ...july], juneAndJuly);
    const baseline = baselineOf(failing);
    const worse = chain(anchors, [...june, row('aaaaaaac', '2026-06-11', 300), row('aaaaaaad', '2026-06-12', 1), ...july], juneAndJuly);
    assert.deepEqual(admit(failing, worse, baseline), {
      id: 'balance-chain', result: 'fail', hold: true, code: 'balance-chain-fail', cause: 'import',
      reconciledThroughBefore: null, reconciledThroughAfter: null,
    });
  });

  it('holds a lost pass that does not fail: a step reopened to unknown', () => {
    const before = chain(anchors, [...june, ...july], juneAndJuly);
    const after = chain(anchors, [...june, ...july, row('aaaaaaae', '2026-07-12', 5, 'posting', 'EUR')], juneAndJuly);
    assert.equal(after.steps[1].reason, 'currency');
    assert.deepEqual(admit(before, after), {
      id: 'balance-chain', result: 'fail', hold: true, code: 'balance-chain-regressed', cause: 'import',
      reconciledThroughBefore: '2026-07-31', reconciledThroughAfter: '2026-06-30',
    });
  });

  it('holds when the chain is already behind the baseline, as pre-existing', () => {
    const good = chain(anchors, [...june, ...july], juneAndJuly);
    const baseline = baselineOf(good);
    const reopened = chain(anchors, [...june, ...july, row('aaaaaaae', '2026-07-12', 5, 'posting', 'EUR')], juneAndJuly);
    const decision = admit(reopened, reopened, baseline);
    assert.equal(decision.code, 'balance-chain-regressed');
    assert.equal(decision.cause, 'pre-existing');
  });

  it('never holds on unknown: gaps, unanchored history', () => {
    const before = chain(anchors, june, [range('2026-05-01', '2026-06-30')]);
    const after = chain(anchors, [...june, row('aaaaaaaf', '2026-07-05', 1)], [range('2026-05-01', '2026-07-20')]);
    assert.deepEqual(after.steps.map((step) => step.reason), ['exact', 'gap']);
    assert.deepEqual(admit(before, after), {
      id: 'balance-chain', result: 'unknown', hold: false, code: null, cause: null,
      reconciledThroughBefore: '2026-06-30', reconciledThroughAfter: '2026-06-30',
    });
  });

  it('a stale baseline holds: another verifier or other rules', () => {
    const result = chain(anchors, [...june, ...july], juneAndJuly);
    const baseline = baselineOf(result);
    assert.equal(admit(result, result, { ...baseline, rules: balanceChainRules({ timingWindowDays: 14 }) }).code, 'balance-chain-baseline-stale');
    assert.equal(admit(result, result, { ...baseline, verifier: 'balance-chain@0' }).code, 'balance-chain-baseline-stale');
    assert.equal(admit(result, result, baseline).hold, false);
  });

  it('an account the verifier does not cover is not applicable, never held', () => {
    assert.deepEqual(admit(null, null), {
      id: 'balance-chain', result: 'not-applicable', hold: false, code: null, cause: null, reconciledThroughBefore: null, reconciledThroughAfter: null,
    });
  });
});

describe('admitting Amex imports (a timing account), traced through a statement cycle', () => {
  const C0 = '2026-06-15', C1 = '2026-07-15', C2 = '2026-08-15';
  const amexAnchors = [anchor('2026-05-15', 9_900), anchor(C0, 10_000), anchor(C1, 2_800), anchor(C2, 5_000)];
  const statements01 = [
    row('baaaaaaa', '2026-06-10', 100, 'timing'),
    row('baaaaaab', '2026-06-14', 300, 'timing'),
    row('baaaaaac', '2026-07-01', 2_000, 'timing'), row('baaaaaad', '2026-07-05', -10_000, 'timing'), row('baaaaaae', '2026-07-14', 500, 'timing'),
  ];
  // The open cycle, captured on 08-10 with every row pending: a charge made the day of the July closing, and one later.
  const openCycle = [row('baaaaaaf', '2026-07-15', 700, 'pending'), row('baaaaaag', '2026-08-01', 1_500, 'pending')];
  // The August statement posts both (promoted in place, same ids).
  const statement2 = [row('baaaaaaf', '2026-07-15', 700, 'timing'), row('baaaaaag', '2026-08-01', 1_500, 'timing')];
  const before01 = [range('2026-05-16', C1)];

  it('the open-cycle capture and the statement import are admitted; nothing ever passes', () => {
    const s0 = chain(amexAnchors, statements01, before01);
    const s1 = chain(amexAnchors, [...statements01, ...openCycle], [...before01, range(C1, '2026-08-10')]);
    const s2 = chain(amexAnchors, [...statements01, ...statement2], [...before01, range(C1, C2)]);
    assert.deepEqual(s1.steps.map((step) => `${step.verdict}/${step.reason}`), ['unknown/date-basis', 'unknown/gap']);
    assert.deepEqual(s2.steps.map((step) => `${step.verdict}/${step.reason}`), ['unknown/date-basis', 'unknown/date-basis']);
    for (const [before, after] of [[s0, s1], [s1, s2]]) {
      const decision = admit(before, after);
      assert.equal(decision.hold, false);
      assert.equal(decision.result, 'unknown');
    }
  });

  it('a statement import with a duplicate beyond the band holds', () => {
    const s1 = chain(amexAnchors, [...statements01, ...openCycle], [...before01, range(C1, '2026-08-10')]);
    const bad = chain(amexAnchors, [...statements01, ...statement2, row('baaaaaah', '2026-08-01', 1_500, 'timing')], [...before01, range(C1, C2)]);
    assert.equal(bad.steps[1].verdict, 'fail');
    const decision = admit(s1, bad);
    assert.equal(decision.code, 'balance-chain-fail');
    assert.equal(decision.cause, 'import');
  });
});
