import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkCheckingBalanceChain } from '../checkingImport.js';
import {
  BALANCE_CHAIN_TIMING_WINDOW_DAYS,
  balanceAnchorRefFromSha256,
  balanceCardRowClass,
  balanceChainRules,
  balancePayloadDateBasis,
  balanceSourceDateBasis,
  verifyBalanceChain,
  type BalanceAnchorInput,
  type BalanceChainResult,
  type BalanceCoverageRange,
  type BalanceRowInput,
} from './verify.js';

// Synthetic only: made-up ids, dates, refs and cents.

const ACCOUNT = `card-acct-${'a'.repeat(32)}`;
const REF_A = `lh1:${'a'.repeat(64)}`;
const REF_B = `lh1:${'b'.repeat(64)}`;

const anchor = (date: string, balanceMinor: number, patch: Partial<BalanceAnchorInput> = {}): BalanceAnchorInput => ({
  date, balanceMinor, kind: 'statement-closing', source: 'statement-facts', ref: REF_A, ...patch,
});
let nextRow = 0;
/** A fresh row id: `card-txn-` and eight letters a–p. */
const nextId = () => `card-txn-${(nextRow++).toString(16).padStart(8, '0').replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))}`;
const row = (date: string, amountMinor: number, patch: Partial<BalanceRowInput> = {}): BalanceRowInput => ({
  id: nextId(), date, amountMinor, rowClass: 'posting', currency: 'USD', ...patch,
});
const timing = (date: string, amountMinor: number, patch: Partial<BalanceRowInput> = {}) => row(date, amountMinor, { rowClass: 'timing', ...patch });
const pending = (date: string, amountMinor: number) => row(date, amountMinor, { rowClass: 'pending' });
const covered = (...ranges: Array<[string, string]>): BalanceCoverageRange[] => ranges.map(([start, end]) => ({ start, end }));
const verify = (anchors: BalanceAnchorInput[], rows: BalanceRowInput[], coverage: BalanceCoverageRange[], timingWindowDays?: number) =>
  verifyBalanceChain({ accountId: ACCOUNT, currency: 'USD', anchors, rows, coverage }, timingWindowDays === undefined ? {} : { timingWindowDays });
const verdicts = (result: BalanceChainResult) => result.steps.map((step) => `${step.from}>${step.to} ${step.verdict}/${step.reason}`);

describe('a posting account: the exact cents rule', () => {
  const rows = () => [row('2026-07-01', 2_000), row('2026-07-05', -10_000), row('2026-07-15', 500)];

  it('passes when the rows explain the balance change to the cent, and reconciles through the last anchor', () => {
    const result = verify([anchor('2026-06-15', 10_000), anchor('2026-07-15', 2_500)], rows(), covered(['2026-05-01', '2026-07-31']));
    assert.deepEqual(verdicts(result), ['2026-06-15>2026-07-15 pass/exact']);
    assert.equal(result.state, 'balanced');
    assert.equal(result.result, 'pass');
    assert.equal(result.reconciledFrom, '2026-06-15');
    assert.equal(result.reconciledThrough, '2026-07-15');
    assert.deepEqual(result.latestRun, { from: '2026-06-15', through: '2026-07-15', steps: 1 });
    assert.equal(result.dateBasis, 'posting');
  });

  it('fails a single cent either way (no tolerance)', () => {
    for (const closing of [2_499, 2_501]) {
      const result = verify([anchor('2026-06-15', 10_000), anchor('2026-07-15', closing)], rows(), covered(['2026-05-01', '2026-07-31']));
      assert.deepEqual(verdicts(result), ['2026-06-15>2026-07-15 fail/mismatch']);
      assert.equal(result.state, 'failing');
      assert.equal(result.result, 'fail');
      assert.equal(result.reconciledThrough, null);
    }
  });

  it('counts a row dated on the later anchor and not one dated on the earlier one: (t0, t1]', () => {
    const anchors = [anchor('2026-06-15', 10_000), anchor('2026-07-15', 10_700)];
    const coverage = covered(['2026-05-01', '2026-07-31']);
    assert.equal(verify(anchors, [row('2026-06-15', 300), row('2026-07-15', 700)], coverage).steps[0].verdict, 'pass');
    assert.equal(verify(anchors, [row('2026-06-15', 700)], coverage).steps[0].verdict, 'fail');
    assert.equal(verify(anchors, [row('2026-07-16', 700)], coverage).steps[0].verdict, 'fail');
  });

  it('a credit balance is negative: owed-positive both sides of zero, and a flipped sign fails', () => {
    const anchors = [anchor('2026-06-15', -500), anchor('2026-07-15', 200)];
    const coverage = covered(['2026-05-01', '2026-07-31']);
    assert.equal(verify(anchors, [row('2026-07-01', 700)], coverage).steps[0].verdict, 'pass');
    assert.equal(verify([anchor('2026-06-15', 500), anchor('2026-07-15', 200)], [row('2026-07-01', 700)], coverage).steps[0].verdict, 'fail');
    assert.equal(verify([anchor('2026-06-15', -500), anchor('2026-07-15', -200)], [row('2026-07-01', 700)], coverage).steps[0].verdict, 'fail');
    assert.equal(verify(anchors, [row('2026-07-01', -700)], coverage).steps[0].verdict, 'fail');
  });

  it('sums exactly where partial sums pass 2^53', () => {
    const big = 999_999_999_999;
    // Ten thousand charges in the first half of the month, as many credits in the second: the running sum reaches about
    // 10^16, where a Number can no longer hold an odd value.
    const up = Array.from({ length: 10_000 }, (_, i) => row(`2026-07-${String(1 + (i % 14)).padStart(2, '0')}`, big));
    const down = Array.from({ length: 10_000 }, (_, i) => row(`2026-07-${String(15 + (i % 14)).padStart(2, '0')}`, -big));
    assert.ok(big * 10_000 > Number.MAX_SAFE_INTEGER);
    const coverage = covered(['2026-06-01', '2026-07-31']);
    assert.equal(verify([anchor('2026-06-30', 0), anchor('2026-07-31', 0)], [...up, ...down], coverage).steps[0].verdict, 'pass');
    assert.equal(verify([anchor('2026-06-30', 0), anchor('2026-07-31', 1)], [...up, ...down], coverage).steps[0].verdict, 'fail');
    assert.equal(verify([anchor('2026-06-30', 0), anchor('2026-07-31', -1)], [...up, ...down], coverage).steps[0].verdict, 'fail');
    // Deterministic: one odd step past 2^53 (2^53 + 1) is a tie a Number rounds down to 2^53, which loses the cent.
    const max = Number.MAX_SAFE_INTEGER;
    const odd = [row('2026-07-01', max), row('2026-07-02', 2), row('2026-07-03', -max)];
    assert.equal(verify([anchor('2026-06-30', 0), anchor('2026-07-31', 2)], odd, coverage).steps[0].verdict, 'pass');
    assert.equal(verify([anchor('2026-06-30', 0), anchor('2026-07-31', 1)], odd, coverage).steps[0].verdict, 'fail');
  });
});

describe('never green without an anchor', () => {
  const coverage = covered(['2026-01-01', '2026-12-31']);

  it('no anchor and one anchor check nothing: not yet checked', () => {
    for (const anchors of [[], [anchor('2026-06-15', 0)]]) {
      const result = verify(anchors, [row('2026-07-01', 100)], coverage);
      assert.deepEqual(result.steps, []);
      assert.equal(result.state, 'not-yet-checked');
      assert.equal(result.result, 'unknown');
      assert.equal(result.reconciledThrough, null);
      assert.equal(result.latestRun, null);
    }
  });

  it('a gap day is unknown, even when the rows that are there balance', () => {
    const anchors = [anchor('2026-06-15', 0), anchor('2026-07-15', 100)];
    const gapped = covered(['2026-06-01', '2026-06-30'], ['2026-07-02', '2026-07-31']);
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 100)], gapped)), ['2026-06-15>2026-07-15 unknown/gap']);
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 999)], gapped)), ['2026-06-15>2026-07-15 unknown/gap']);
    assert.equal(verify(anchors, [row('2026-07-10', 100)], gapped).state, 'not-yet-checked');
  });

  it('chains from where history starts: anchors before it are listed, never chained', () => {
    const anchors = [anchor('2026-01-31', 7_777), anchor('2026-03-31', 0), anchor('2026-04-30', 100)];
    const result = verify(anchors, [row('2026-04-10', 100)], covered(['2026-04-01', '2026-04-30']));
    assert.deepEqual(verdicts(result), ['2026-03-31>2026-04-30 pass/exact']);
    assert.equal(result.state, 'balanced');
    assert.equal(result.reconciledFrom, '2026-03-31');
    assert.deepEqual(result.anchors.list.map((item) => `${item.date} ${item.state}`),
      ['2026-01-31 before-history', '2026-03-31 chained', '2026-04-30 chained']);
    assert.equal(result.anchors.beforeHistory, 1);
    assert.equal(result.anchors.chained, 2);
  });

  it('no coverage at all chains nothing', () => {
    const result = verify([anchor('2026-03-31', 0), anchor('2026-04-30', 0)], [], []);
    assert.deepEqual(result.steps, []);
    assert.equal(result.history, null);
    assert.equal(result.anchors.beforeHistory, 2);
  });
});

describe('reconciledThrough is strict from the chain start', () => {
  it('stops at the first step that does not pass; latestRun shows the later run; state partly-balanced', () => {
    const anchors = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'].map((date) => anchor(date, 0));
    const result = verify(anchors, [], covered(['2026-01-01', '2026-03-15'], ['2026-04-01', '2026-06-30']));
    assert.deepEqual(verdicts(result), [
      '2026-01-31>2026-02-28 pass/exact', '2026-02-28>2026-03-31 unknown/gap', '2026-03-31>2026-04-30 pass/exact',
      '2026-04-30>2026-05-31 pass/exact',
    ]);
    assert.equal(result.reconciledThrough, '2026-02-28');
    assert.equal(result.reconciledFrom, '2026-01-31');
    assert.deepEqual(result.latestRun, { from: '2026-03-31', through: '2026-05-31', steps: 2 });
    assert.equal(result.state, 'partly-balanced');
    assert.equal(result.result, 'unknown');
    assert.deepEqual(result.history, { from: '2026-01-01', through: '2026-06-30', uncoveredRuns: 1 });
  });

  it('a first step that does not pass leaves it null', () => {
    const anchors = [anchor('2026-01-31', 0), anchor('2026-02-28', 5), anchor('2026-03-31', 5)];
    const result = verify(anchors, [], covered(['2026-01-01', '2026-03-31']));
    assert.deepEqual(verdicts(result), ['2026-01-31>2026-02-28 fail/mismatch', '2026-02-28>2026-03-31 pass/exact']);
    assert.equal(result.reconciledThrough, null);
    assert.equal(result.state, 'failing');
  });
});

describe('anchors of one date', () => {
  const coverage = covered(['2026-06-01', '2026-08-31']);

  it('agreeing sources merge, the highest rank first; disagreeing ones fail both steps at that date', () => {
    const agree = verify([anchor('2026-06-30', 0), anchor('2026-07-31', 100, { ref: REF_B }), anchor('2026-07-31', 100, { kind: 'daily', source: 'checking-import', ref: REF_A })],
      [row('2026-07-10', 100)], coverage);
    assert.deepEqual(verdicts(agree), ['2026-06-30>2026-07-31 pass/exact']);
    assert.deepEqual(agree.anchors.list[1], { date: '2026-07-31', kind: 'statement-closing', source: 'statement-facts', rank: 2, state: 'chained', ref: REF_B,
      refs: [REF_A, REF_B] });
    assert.deepEqual(agree.anchors.byKind, { 'statement-closing': 2, daily: 1 });
    const conflict = verify([anchor('2026-06-30', 0), anchor('2026-07-31', 100), anchor('2026-07-31', 101, { ref: REF_B }), anchor('2026-08-31', 100)],
      [row('2026-07-10', 100)], coverage);
    assert.deepEqual(verdicts(conflict), ['2026-06-30>2026-07-31 fail/anchor-conflict', '2026-07-31>2026-08-31 fail/anchor-conflict']);
    assert.equal(conflict.anchors.conflicted, 1);
    assert.equal(conflict.anchors.list[1].state, 'conflict');
    assert.match(conflict.steps[0].pin!, /^lh1:[a-p]{64}$/);
  });

  it('a conflicted anchor never starts the chain', () => {
    const result = verify([anchor('2026-06-30', 0), anchor('2026-06-30', 1, { ref: REF_B }), anchor('2026-07-31', 0), anchor('2026-08-31', 0)], [], coverage);
    assert.deepEqual(verdicts(result), ['2026-07-31>2026-08-31 pass/exact']);
    assert.equal(result.reconciledFrom, '2026-07-31');
  });
});

describe('pending rows and other currencies', () => {
  const anchors = [anchor('2026-06-30', 0), anchor('2026-07-31', 100)];
  const coverage = covered(['2026-06-01', '2026-08-31']);

  it('a pending row is never summed: the posted rows alone must explain the change', () => {
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 100), pending('2026-07-20', 40)], coverage)), ['2026-06-30>2026-07-31 pass/as-dated']);
  });

  it('a pending row that may have posted inside the step explains a residual as unknown, never pass', () => {
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 60), pending('2026-07-20', 40)], coverage)), ['2026-06-30>2026-07-31 unknown/pending']);
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 60), pending('2026-06-25', 40)], coverage)), ['2026-06-30>2026-07-31 unknown/pending']);
    // Dated more than L days before the step, it can't have posted inside it.
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 60), pending('2026-06-10', 40)], coverage)), ['2026-06-30>2026-07-31 fail/mismatch']);
    // More than it could explain.
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 50), pending('2026-07-20', 40)], coverage)), ['2026-06-30>2026-07-31 fail/mismatch']);
  });

  it('a row in another currency in the window makes the step unknown', () => {
    assert.deepEqual(verdicts(verify(anchors, [row('2026-07-10', 100), row('2026-07-11', 5, { currency: 'EUR' })], coverage)),
      ['2026-06-30>2026-07-31 unknown/currency']);
  });
});

describe('a timing account (dates that may be transaction dates)', () => {
  // Statements close on the 15th. s0 was made before C0 and posted after it (on statement 1); s1 was made before C1 and
  // posted after it (on statement 2). The rows keep only the date they were made.
  const C0 = '2026-06-15', C1 = '2026-07-15', C2 = '2026-08-15';
  const anchors = [anchor('2026-05-15', 9_900), anchor(C0, 10_000), anchor(C1, 2_800), anchor(C2, 5_000)];
  const history = () => [
    timing('2026-06-10', 100), // statement 0
    timing('2026-06-14', 300), // s0: statement 1
    timing('2026-07-01', 2_000), timing('2026-07-05', -10_000), timing('2026-07-14', 500), // statement 1
    timing('2026-07-15', 700), // s1: statement 2
    timing('2026-08-01', 1_500), // statement 2
  ];
  const coverage = covered(['2026-05-16', '2026-08-15']);

  it('rows straddling a closing date are explained by the band: unknown date-basis, never a false fail', () => {
    const result = verify(anchors, history(), coverage);
    assert.equal(result.dateBasis, 'timing');
    // The May closing can't start the chain: the ten days before it aren't claimed.
    assert.deepEqual(verdicts(result), [`${C0}>${C1} unknown/date-basis`, `${C1}>${C2} unknown/date-basis`]);
    assert.deepEqual(result.anchors.list.map((item) => item.state), ['before-history', 'chained', 'chained', 'chained']);
    assert.equal(result.state, 'not-yet-checked');
    assert.equal(result.reconciledThrough, null);
    assert.equal(result.latestRun, null);
  });

  it('read as posting dates, the same rows fail at every closing (the false fail the registry prevents)', () => {
    const asPosting = history().map((item) => ({ ...item, rowClass: 'posting' as const }));
    const result = verify(anchors, asPosting, coverage);
    assert.deepEqual(verdicts(result), [`2026-05-15>${C0} fail/mismatch`, `${C0}>${C1} fail/mismatch`, `${C1}>${C2} fail/mismatch`]);
    assert.deepEqual(result.steps.map((step) => step.timingWouldExplain), [true, true, true]);
  });

  it('a timing account never passes, even on an exact as-dated match', () => {
    const result = verify([anchor('2026-05-15', 0), anchor('2026-06-15', 100)], [timing('2026-05-20', 100)], covered(['2026-05-01', '2026-06-30']));
    assert.deepEqual(verdicts(result), ['2026-05-15>2026-06-15 unknown/as-dated']);
    assert.equal(result.result, 'unknown');
  });

  it('fails what the straddling rows can\'t explain: a dropped row, a duplicate, a flipped balance', () => {
    const dropped = history().filter((item) => item.date !== '2026-08-01');
    assert.deepEqual(verdicts(verify(anchors, dropped, coverage)), [`${C0}>${C1} unknown/date-basis`, `${C1}>${C2} fail/mismatch`]);
    const duplicated = [...history(), timing('2026-07-01', 2_000)];
    assert.deepEqual(verdicts(verify(anchors, duplicated, coverage)), [`${C0}>${C1} fail/mismatch`, `${C1}>${C2} unknown/date-basis`]);
    const flipped = verify([...anchors.slice(0, 3), anchor(C2, -5_000)], history(), coverage);
    assert.deepEqual(verdicts(flipped), [`${C0}>${C1} unknown/date-basis`, `${C1}>${C2} fail/mismatch`]);
    assert.equal(flipped.steps[1].timingWouldExplain, undefined);
    assert.equal(flipped.state, 'failing');
  });

  it('needs the L days before each anchor claimed: the chain starts only where they are', () => {
    const late = verify(anchors, history().filter((item) => item.date > C0), covered(['2026-06-16', C2]));
    assert.deepEqual(verdicts(late), [`${C1}>${C2} unknown/date-basis`]);
    assert.deepEqual(late.anchors.list.map((item) => item.state), ['before-history', 'before-history', 'chained', 'chained']);
  });

  it('a step\'s support is (t0 − L, t1]: a gap in the L days before t0 is a gap', () => {
    const holed = covered(['2026-05-01', '2026-06-04'], ['2026-06-06', C2]);
    const anchorsHere = [anchor('2026-05-31', 0), anchor(C0, 0), anchor(C1, 0)];
    const rows = [timing('2026-06-20', 50), timing('2026-06-21', -50)];
    assert.deepEqual(verdicts(verify(anchorsHere, rows, holed)), [`2026-05-31>${C0} unknown/gap`, `${C0}>${C1} unknown/as-dated`]);
    // With a 20-day window the hole on 06-05 falls inside the second step's support too.
    assert.deepEqual(verdicts(verify(anchorsHere, rows, holed, 20)), [`2026-05-31>${C0} unknown/gap`, `${C0}>${C1} unknown/gap`]);
  });

  it('the window is the default ten days', () => {
    assert.equal(BALANCE_CHAIN_TIMING_WINDOW_DAYS, 10);
    assert.throws(() => verify([], [], [], 0), RangeError);
  });
});

describe('pins and value-free results', () => {
  const anchors = [anchor('2026-06-30', 0), anchor('2026-07-31', 100)];
  const coverage = covered(['2026-06-01', '2026-08-31']);

  it('pin a failing step to its rows\' ids, dates, classes and change counts and its anchors\' refs, never amounts', () => {
    const rows = [row('2026-07-10', 60)];
    const first = verify(anchors, rows, coverage).steps[0].pin;
    assert.match(first!, /^lh1:[a-p]{64}$/);
    assert.equal(verify(anchors, rows, coverage).steps[0].pin, first);
    assert.equal(verify(anchors, [{ ...rows[0], amountMinor: 61 }], coverage).steps[0].pin, first);
    assert.equal(verify(anchors, [{ ...rows[0], version: 0 }], coverage).steps[0].pin, first);
    // A card row changed in place (its amount, say) carries a new change count, so an accepted failure lapses.
    assert.notEqual(verify(anchors, [{ ...rows[0], amountMinor: 61, version: 1 }], coverage).steps[0].pin, first);
    assert.notEqual(verify(anchors, [...rows, row('2026-07-11', 1)], coverage).steps[0].pin, first);
    assert.notEqual(verify(anchors, [{ ...rows[0], date: '2026-07-12' }], coverage).steps[0].pin, first);
    assert.notEqual(verify([anchors[0], { ...anchors[1], ref: REF_B }], rows, coverage).steps[0].pin, first);
    assert.equal(verify(anchors, [row('2026-07-10', 100)], coverage).steps[0].pin, undefined);
    for (const version of [-1, 1.5, Number.NaN]) assert.equal(verify(anchors, [{ ...rows[0], version }], coverage).readable, false);
  });

  it('never return an amount or a balance', () => {
    const result = verify([anchor('2026-06-30', 4_731_917), anchor('2026-07-31', 8_266_011)], [row('2026-07-10', 3_534_093), row('2026-07-20', 2)], coverage);
    assert.equal(result.steps[0].verdict, 'fail');
    const text = JSON.stringify(result);
    for (const value of ['4731917', '8266011', '3534093', '3534095']) assert.equal(text.includes(value), false, value);
  });

  it('refuse to check what is not a safe integer or a real date', () => {
    for (const bad of [
      { rows: [row('2026-07-10', 1.5)] },
      { rows: [row('2026-02-30', 1)] },
      { anchors: [anchor('2026-06-30', Number.MAX_SAFE_INTEGER + 1), anchors[1]] },
      { coverage: covered(['2026-08-31', '2026-06-01']) },
    ]) {
      const result = verifyBalanceChain({ accountId: ACCOUNT, currency: 'USD', anchors, rows: [], coverage, ...bad });
      assert.equal(result.readable, false);
      assert.deepEqual(result.steps, []);
      assert.equal(result.result, 'unknown');
    }
  });
});

describe('the date-basis registry and rules', () => {
  it('trusts DTPOSTED except for Amex, Bilt\'s and Discover A\'s posted dates; everything else is timing', () => {
    const posted = (source: string, issuer: string) => balanceCardRowClass({ status: 'posted', postedDate: '2026-07-01', source }, issuer);
    assert.equal(posted('ofx', 'chase'), 'posting');
    assert.equal(posted('ofx', 'citi-costco'), 'posting');
    assert.equal(posted('ofx', 'amex'), 'timing');
    assert.equal(posted('ofx', 'american-express'), 'timing');
    assert.equal(posted('bilt-csv', 'bilt'), 'posting');
    assert.equal(posted('discover-statement', 'discover'), 'posting');
    assert.equal(posted('amex-csv', 'amex'), 'timing');
    assert.equal(posted('chase-api', 'chase'), 'timing');
    assert.equal(posted('constructor', 'chase'), 'timing');
    assert.equal(balanceCardRowClass({ status: 'posted', postedDate: null, source: 'ofx' }, 'chase'), 'timing');
    assert.equal(balanceCardRowClass({ status: 'pending', postedDate: null, source: 'ofx' }, 'chase'), 'pending');
    assert.deepEqual(['ofx|chase', 'ofx|amex', 'bilt-csv|bilt', 'amex-csv|amex', 'wf-csv|wellsfargo', 'discover-statement|discover']
      .map((pair) => balanceSourceDateBasis(pair.split('|')[0], pair.split('|')[1])), ['posting', 'timing', 'posting', 'timing', 'timing', 'posting']);
    const payload = (source: string, issuer: string, postedDate: string | null) => ({ source, issuer,
      rows: [{ status: 'posted', postedDate: '2026-07-02' }, { status: 'pending', postedDate: null }, { status: 'posted', postedDate }] });
    assert.equal(balancePayloadDateBasis(payload('discover-statement', 'discover', '2026-07-03')), 'posting');
    assert.equal(balancePayloadDateBasis(payload('discover-statement', 'discover', null)), 'timing');
    assert.equal(balancePayloadDateBasis(payload('ofx', 'amex', '2026-07-03')), 'timing');
    assert.equal(balancePayloadDateBasis({ source: 'ofx', issuer: 'citi', rows: [] }), 'posting');
  });

  it('a sha256 ref becomes letters; anything else is refused', () => {
    assert.equal(balanceAnchorRefFromSha256(`sha256:${'0123456789abcdef'.repeat(4)}`), `lh1:${'abcdefghijklmnop'.repeat(4)}`);
    assert.equal(balanceAnchorRefFromSha256(`sha256:${'A'.repeat(64)}`), null);
    assert.equal(balanceAnchorRefFromSha256(`sha256:${'a'.repeat(63)}`), null);
    assert.equal(balanceAnchorRefFromSha256('/statements'), null);
  });

  it('the rules digest follows the window and the allowlist, not their order', () => {
    const base = balanceChainRules();
    assert.match(base, /^lh1:[a-p]{64}$/);
    assert.equal(balanceChainRules({ timingWindowDays: 10, anchorExtractors: {} }), base);
    assert.notEqual(balanceChainRules({ timingWindowDays: 14 }), base);
    const one = balanceChainRules({ anchorExtractors: { 'amex-statement-a@1': 'x', 'citi-statement-a@1': 'y' } });
    assert.notEqual(one, base);
    assert.equal(balanceChainRules({ anchorExtractors: { 'citi-statement-a@1': 'z', 'amex-statement-a@1': 'w' } }), one);
  });
});

describe('equivalence with checkCheckingBalanceChain on checking-shaped data', () => {
  /** A seeded generator, so a failure names its case. */
  function generator(seed: number) {
    let state = seed >>> 0;
    return (n: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % n;
    };
  }
  const day = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  it('agrees on checked steps, gaps and mismatch dates over 400 random histories', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = generator(seed);
      const coverage: BalanceCoverageRange[] = [];
      let at = next(5);
      for (let i = 0; i < 1 + next(4); i += 1) {
        const length = 3 + next(40);
        coverage.push({ start: day(at), end: day(at + length) });
        at += length + 1 + next(6);
      }
      const coveredDays = new Set<string>();
      for (const range of coverage) for (let d = range.start; d <= range.end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) coveredDays.add(d);
      const days = [...coveredDays].sort();
      const rows = Array.from({ length: next(60) }, () => row(days[next(days.length)], next(20_001) - 10_000));
      const net = new Map<string, number>();
      for (const item of rows) net.set(item.date, (net.get(item.date) ?? 0) + item.amountMinor);
      // Anchors from the true running balance, some nudged by a cent; the first on or after the first covered day minus one.
      const anchorDays = [...new Set([day(Math.max(0, Date.parse(`${coverage[0].start}T00:00:00Z`) / 86_400_000 - Date.UTC(2026, 0, 1) / 86_400_000 - 1)),
        ...Array.from({ length: 2 + next(8) }, () => days[next(days.length)])])].sort();
      let balance = 1_000;
      const anchors = anchorDays.map((date) => {
        balance = 1_000 + [...net.entries()].filter(([d]) => d <= date).reduce((sum, [, v]) => sum + v, 0);
        return anchor(date, balance + (next(5) === 0 ? 1 : 0), { kind: 'daily', source: 'checking-import', ref: `chk-imp-${'a'.repeat(32)}` });
      });
      const ours = verifyBalanceChain({ accountId: `chk-acct-${'a'.repeat(32)}`, currency: 'USD', anchors, rows, coverage });
      const theirs = checkCheckingBalanceChain(anchors, (date) => (coveredDays.has(date) ? net.get(date) ?? 0 : null));
      const checked = ours.steps.filter((step) => step.verdict === 'pass' || step.reason === 'mismatch').length;
      const gaps = ours.steps.filter((step) => step.reason === 'gap').length;
      const mismatches = ours.steps.filter((step) => step.reason === 'mismatch').map((step) => step.to).sort();
      assert.deepEqual({ checked, gaps, mismatches }, theirs, `seed ${seed}`);
    }
  });
});
