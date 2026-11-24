import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BALANCE_CHAIN_REPORT_FORMAT,
  BALANCE_CHAIN_REPORT_VERSION,
  BalanceChainBaselineRefusal,
  balanceChainAccountKey,
  balanceChainReportAccount,
  formatBalanceChainReport,
  isValueFreeBalanceChainReport,
  parseBalanceChainBaseline,
  type BalanceChainReport,
} from './report.js';
import { BALANCE_CHAIN_VERIFIER, verifyBalanceChain, type BalanceChainResult } from './verify.js';

// Synthetic only: made-up ids, dates, refs and cents.

const CARD = `card-acct-${'e'.repeat(32)}`;
const CHECKING = `chk-acct-${'f'.repeat(32)}`;
const REF = `lh1:${'g'.repeat(64)}`;

function failingCard(): BalanceChainResult {
  return verifyBalanceChain({
    accountId: CARD, currency: 'USD', coverage: [{ start: '2026-05-01', end: '2026-07-31' }],
    anchors: [
      { date: '2026-05-31', balanceMinor: 8_311_207, kind: 'statement-closing', source: 'statement-facts', ref: REF },
      { date: '2026-06-30', balanceMinor: 8_342_651, kind: 'statement-closing', source: 'statement-facts', ref: REF },
      { date: '2026-07-31', balanceMinor: 8_342_651, kind: 'statement-closing', source: 'statement-facts', ref: REF },
    ],
    rows: [{ id: 'card-txn-aaaaaaaa', date: '2026-06-10', amountMinor: 31_443, rowClass: 'posting', currency: 'USD' },
      { id: 'card-txn-aaaaaaab', date: '2026-06-11', amountMinor: 2, rowClass: 'posting', currency: 'USD' }],
  });
}

function checkingChain(): BalanceChainResult {
  return verifyBalanceChain({
    accountId: CHECKING, currency: 'USD', coverage: [{ start: '2026-06-01', end: '2026-06-30' }],
    anchors: [
      { date: '2026-05-31', balanceMinor: 12_345_678, kind: 'statement-opening', source: 'checking-import', ref: `chk-imp-${'h'.repeat(32)}` },
      { date: '2026-06-30', balanceMinor: 12_345_000, kind: 'statement-closing', source: 'checking-import', ref: `chk-imp-${'h'.repeat(32)}` },
    ],
    rows: [{ id: 'chk-txn-aaaaaaaa', date: '2026-06-15', amountMinor: -678, rowClass: 'posting', currency: 'USD' }],
  });
}

function report(detail: boolean): BalanceChainReport {
  const card = failingCard();
  return {
    format: BALANCE_CHAIN_REPORT_FORMAT, version: BALANCE_CHAIN_REPORT_VERSION, verifier: BALANCE_CHAIN_VERIFIER, rules: card.rules, timingWindowDays: 10,
    stores: { checking: 'present', statementFacts: 'present' },
    accounts: [
      balanceChainReportAccount({ kind: 'checking', id: CHECKING, issuer: 'fifththird', last4: '0101', status: 'active' }, checkingChain(), { untrusted: 0, excluded: 0 }, detail),
      balanceChainReportAccount({ kind: 'card', id: CARD, issuer: 'testbank', last4: '1234', status: 'closed' }, card, { untrusted: 2, excluded: 1 }, detail),
    ],
  };
}

describe('the report entry', () => {
  it('summarizes verdicts as counts and dates, and lists anchors and steps only with detail', () => {
    const [checking, card] = report(false).accounts;
    assert.deepEqual(checking, {
      kind: 'checking', id: CHECKING, issuer: 'fifththird', last4: '0101', status: 'active', readable: true, dateBasis: 'posting',
      state: 'balanced', result: 'pass', reconciledFrom: '2026-05-31', reconciledThrough: '2026-06-30',
      latestRun: { from: '2026-05-31', through: '2026-06-30', steps: 1 }, latestAnchor: '2026-06-30', latestStatementAnchor: '2026-06-30',
      history: { from: '2026-06-01', through: '2026-06-30', uncoveredRuns: 0 },
      anchors: { total: 2, chained: 2, beforeHistory: 0, conflicted: 0, untrusted: 0, excluded: 0, byKind: { 'statement-opening': 1, 'statement-closing': 1 } },
      steps: { total: 1, pass: 1, fail: 0, unknown: 0, byReason: { exact: 1 } },
      firstProblem: null,
    });
    assert.equal(card.state, 'failing');
    assert.deepEqual(card.firstProblem, { from: '2026-05-31', to: '2026-06-30', verdict: 'fail', reason: 'mismatch' });
    assert.deepEqual(card.anchors, { total: 3, chained: 3, beforeHistory: 0, conflicted: 0, untrusted: 2, excluded: 1, byKind: { 'statement-closing': 3 } });
    assert.equal(card.detail, undefined);
    const detailed = report(true).accounts[1];
    assert.equal(detailed.detail!.steps.length, 2);
    assert.match(detailed.detail!.steps[0].pin!, /^lh1:[a-p]{64}$/);
    assert.equal(detailed.detail!.anchors[0].ref, REF);
    assert.deepEqual(detailed.detail!.anchors[0].refs, [REF]);
  });

  it('keys a standard id as itself and anything else by a letter digest; an issuer that isn\'t words is `other`', () => {
    assert.equal(balanceChainAccountKey(CARD), CARD);
    assert.equal(balanceChainAccountKey(CHECKING), CHECKING);
    const odd = balanceChainAccountKey('card-acct-1234567');
    assert.match(odd, /^lh1:[a-p]{64}$/);
    assert.equal(balanceChainAccountKey('card-acct-1234567'), odd);
    const entry = balanceChainReportAccount({ kind: 'card', id: 'card-acct-1234567', issuer: 'bank 12345', last4: '12345', status: 'active' },
      failingCard(), { untrusted: 0, excluded: 0 }, false);
    assert.deepEqual([entry.id, entry.issuer, entry.last4], [odd, 'other', null]);
  });
});

describe('the strict value-free schema', () => {
  it('passes a report made by the builder, as one line, with no amount or balance in it', () => {
    for (const detail of [false, true]) {
      const line = formatBalanceChainReport(report(detail));
      assert.ok(line !== null && line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
      for (const value of ['8311207', '8342651', '31443', '12345678', '12345000', '678']) {
        assert.equal(line.includes(value), false, value);
      }
    }
  });

  it('refuses an unlisted key, a count past 9,999, a malformed id, date or ref, and any run of five digits', () => {
    const base = () => JSON.parse(JSON.stringify(report(true))) as BalanceChainReport & Record<string, unknown>;
    const refused: Array<[string, (r: ReturnType<typeof base>) => void]> = [
      ['extra top key', (r) => { r.amountMinor = 1; }],
      ['extra account key', (r) => { (r.accounts[0] as unknown as Record<string, unknown>).balanceMinor = 1; }],
      ['count past 9999', (r) => { r.accounts[0].steps.total = 10_000; }],
      ['negative count', (r) => { r.accounts[0].anchors.total = -1; }],
      ['fractional count', (r) => { r.accounts[0].anchors.total = 1.5; }],
      ['id with digits', (r) => { r.accounts[0].id = 'chk-acct-12345678901234567890123456789012'; }],
      ['bad date', (r) => { r.accounts[0].reconciledThrough = '2026-6-30'; }],
      ['bad ref', (r) => { r.accounts[1].detail!.anchors[0].ref = 'sha256:abc'; }],
      ['no refs', (r) => { r.accounts[1].detail!.anchors[0].refs = []; }],
      ['bad ref among refs', (r) => { r.accounts[1].detail!.anchors[0].refs = [REF, 'sha256:abc']; }],
      ['bad pin', (r) => { r.accounts[1].detail!.steps[0].pin = 'lh1:12345'; }],
      ['unknown reason', (r) => { r.accounts[1].detail!.steps[0].reason = 'close-enough' as never; }],
      ['unknown byReason word', (r) => { r.accounts[0].steps.byReason = { tolerance: 1 }; }],
      ['last4 of five', (r) => { r.accounts[0].last4 = '01011'; }],
      ['other format', (r) => { (r as Record<string, unknown>).format = 'holdr.other'; }],
      ['other verifier', (r) => { (r as Record<string, unknown>).verifier = 'balance-chain@2'; }],
      ['missing key', (r) => { delete (r.accounts[0] as unknown as Record<string, unknown>).history; }],
    ];
    assert.equal(isValueFreeBalanceChainReport(base()), true);
    for (const [name, mutate] of refused) {
      const value = base();
      mutate(value);
      assert.equal(isValueFreeBalanceChainReport(value), false, name);
      assert.equal(formatBalanceChainReport(value), null, name);
    }
  });
});

describe('the baseline', () => {
  it('reads every account\'s steps from the detail line', () => {
    const baseline = parseBalanceChainBaseline(formatBalanceChainReport(report(true))!);
    assert.equal(baseline.verifier, BALANCE_CHAIN_VERIFIER);
    assert.deepEqual([...baseline.accounts.keys()], [CHECKING, CARD]);
    const card = baseline.accounts.get(CARD)!;
    assert.equal(card.reconciledThrough, null);
    assert.deepEqual(card.steps.map((step) => `${step.verdict}/${step.reason}/${step.pin ? 'pinned' : '-'}`), ['fail/mismatch/pinned', 'pass/exact/-']);
  });

  it('refuses a summary line, a schema failure, garbage, and an account listed twice', () => {
    const refusal = (text: string) => {
      try {
        parseBalanceChainBaseline(text);
        return 'accepted';
      } catch (error) {
        assert.ok(error instanceof BalanceChainBaselineRefusal);
        assert.equal(error.message.includes('{'), false);
        return error.code;
      }
    };
    assert.equal(refusal(formatBalanceChainReport(report(false))!), 'baseline-summary-only');
    assert.equal(refusal('{"format":'), 'baseline-not-json');
    assert.equal(refusal(JSON.stringify({ ...report(true), rules: 'lh1:short' })), 'baseline-schema');
    const twice = report(true);
    twice.accounts.push(twice.accounts[0]);
    assert.equal(refusal(JSON.stringify(twice)), 'baseline-duplicate-account');
  });
});
