import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD,
  FULL_COVERAGE,
  V9,
  cardRow,
  csvPayment,
  cycleOf,
  dashboard,
  et,
  observation,
  ofxPayment,
  pendingPayment,
  plan,
  redOf,
  rulesOf,
  statement,
  v9History,
  type History,
} from './__fixtures__/history.js';
import { cashPlanForCard } from './engine.js';

/** The posted-date rule, the receipt and deadline contracts, and the red/amber rules (spec v9 §6; note v2.9 §5.4–§5.5). */

// One first captured cycle (Root's exception resolves its predecessor by its own P = 0): C Oct 2, D Oct 27, M 5000.
const C = '2026-10-02';
const D = '2026-10-27';
const firstCycle = (f: Parameters<typeof statement>[1] = {}) => statement(C, { D, S: 5000, M: 5000, P: 0, ...f });
const at = (date: string, hour = 12) => et(date, hour);
const run = (rows: History['rows'], asOf: string, extra: Partial<History> = {}) => cycleOf(plan({ observations: [firstCycle()], rows, asOf, ...extra }), C);

describe('Root\'s ruling (b): the posted-date rule', () => {
  it('autopay posted on D (OFX DTPOSTED = D) with k−1 resolved: met by D, neutral; never amber, never R1b', () => {
    const k = run([ofxPayment('auto', 5000, D)], at('2026-10-29'));
    assert.equal(k.answers.minimumMetByDue, true);
    assert.equal(k.state, 'paid-in-full');
    assert.deepEqual(rulesOf(k), []);
  });

  it('posted in (C_k, D] while k−1 is unresolved at C_k: A11, never satisfies k', () => {
    const result = plan({ observations: [statement('2026-09-02', { D: '2026-09-27', S: 3000, M: 3000 }), statement(C, { start: '2026-09-03', D, S: 5000, M: 5000 })],
      rows: [ofxPayment('auto', 5000, D)], asOf: at('2026-10-29') });
    const k = cycleOf(result, C);
    assert.deepEqual(k.predecessor, { kind: 'captured', resolved: false });
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
  });

  it('an uncaptured k−1 with no qualifying P = 0 holds the rule; statement k\'s own P = 0 resolves it; a later P = 0 never does', () => {
    const noP = cycleOf(plan({ observations: [firstCycle({ P: undefined })], rows: [ofxPayment('auto', 5000, D)], asOf: at('2026-10-29') }), C);
    assert.deepEqual(rulesOf(noP), ['A11:past-due-unconfirmed']);
    const laterP = cycleOf(plan({ observations: [firstCycle({ P: undefined }), dashboard(at('2026-10-10'), { C, D, P: 0 })], rows: [ofxPayment('auto', 5000, D)], asOf: at('2026-10-29') }), C);
    assert.deepEqual(rulesOf(laterP), ['A11:past-due-unconfirmed']);
    assert.equal(run([ofxPayment('auto', 5000, D)], at('2026-10-29')).answers.minimumMetByDue, true);
  });

  it('a transaction date (DTUSER) on or before C_k disqualifies; a transaction date never satisfies anything', () => {
    const k = run([ofxPayment('auto', 5000, '2026-10-05', { txn: C })], at('2026-10-29'));
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
  });

  it('posted after D: never "minimum met by D"; A11, never R1b', () => {
    const k = run([ofxPayment('late', 5000, '2026-10-29')], at('2026-10-30'));
    assert.equal(k.answers.minimumMetByDue, false);
    assert.equal(k.answers.minimumMetSoFar, true);
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
  });

  it('sources with no posting date (Amex CSV, WF CSV, Discover B/C) never assign; Bilt "Posted Date" and Discover A "Post Date" do', () => {
    for (const source of ['amex-csv', 'wf-csv']) {
      const k = run([cardRow({ id: 'p', source, amountMinor: -5000, transactionDate: D, postedDate: null, createdAt: at(D, 20) })], at('2026-10-29'));
      assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed'], source);
    }
    const discoverB = run([cardRow({ id: 'p', source: 'discover-statement', amountMinor: -5000, transactionDate: D, postedDate: null, createdAt: at('2026-10-28', 9) })], at('2026-10-29'));
    assert.deepEqual(rulesOf(discoverB), ['A11:past-due-unconfirmed']);
    for (const source of ['bilt-csv', 'discover-statement']) {
      const k = run([cardRow({ id: 'p', source, amountMinor: -5000, transactionDate: D, postedDate: D, createdAt: at('2026-10-28', 9) })], at('2026-10-29'));
      assert.equal(k.answers.minimumMetByDue, true, source);
    }
    // An unregistered sync source with a posted date is not source-proven either.
    const sync = run([cardRow({ id: 'p', source: 'chase-api', amountMinor: -5000, transactionDate: D, postedDate: D, createdAt: at('2026-10-28', 9) })], at('2026-10-29'));
    assert.deepEqual(rulesOf(sync), ['A11:past-due-unconfirmed']);
  });

  it('a returned or reversed payment is netted out before the rule; an unresolved possible reversal is only possible', () => {
    assert.deepEqual(rulesOf(run([ofxPayment('auto', 5000, D)], at('2026-10-29'), { returned: ['auto'] })), ['A11:past-due-unconfirmed']);
    const uncertain = run([ofxPayment('auto', 5000, D)], at('2026-10-29'), { uncertain: ['auto'] });
    assert.ok(uncertain.ledger.possible.includes('auto'));
    assert.deepEqual(rulesOf(uncertain), ['A11:past-due-unconfirmed']);
  });

  it('Bilt housing payments on a Bilt card are not card payments here; on any other card the same words are ordinary', () => {
    const housing = cardRow({ id: 'h', source: 'bilt-csv', amountMinor: -5000, transactionDate: D, postedDate: D, description: 'BILT HOUSING PAYMENT', createdAt: at('2026-10-28', 9) });
    const onBilt = cycleOf(cashPlanForCard({ card: { ...CARD, issuer: 'bilt' }, observations: [firstCycle()], rows: [housing], coverage: FULL_COVERAGE, asOf: at('2026-10-29') }), C);
    assert.equal(onBilt.answers.minimumMetByDue, false);
    assert.ok(!onBilt.ledger.proven.includes('h') && !onBilt.ledger.possible.includes('h'));
    const elsewhere = cycleOf(plan({ observations: [firstCycle()], rows: [housing], asOf: at('2026-10-29') }), C);
    assert.equal(elsewhere.answers.minimumMetByDue, true);
  });
});

describe('the v2.5 receipt contracts and R1b failing closed', () => {
  it('no DTUSER: the parser\'s transaction date is the posting date; an Oct 27 receipt is never called late (A11, never R1b)', () => {
    const k = run([ofxPayment('b', 5000, '2026-10-29')], at('2026-11-02'));
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
    assert.ok(!redOf(plan({ observations: [firstCycle()], rows: [ofxPayment('b', 5000, '2026-10-29')], asOf: at('2026-11-02') })).length);
  });

  it('posted-only coverage complete through any date never gives R1b; nothing at all after D is A11', () => {
    const k = run([], at('2026-11-20'));
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
    assert.equal(k.state, 'past-due-unconfirmed');
  });

  it('D = T − 1 with coverage through T − 2 gives A11', () => {
    const k = run([], at('2026-10-28'), { coverage: [{ start: '2025-01-01', end: '2026-10-26' }] });
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
  });
});

describe('the v2.4 contracts', () => {
  it('F1: a payment received before the close is never eligible for that cycle, even the only captured one; on-close is excluded', () => {
    for (const posted of ['2026-09-15', C]) {
      const k = run([ofxPayment('early', 5000, posted)], at('2026-10-26'));
      assert.ok(!k.ledger.proven.includes('early') && !k.ledger.possible.includes('early'), posted);
      assert.deepEqual(rulesOf(k), ['R2a:no-payment-seen'], posted);
    }
  });

  it('F1: a successor statement re-windows deterministically; an old cycle\'s payments are never reused', () => {
    const rows = [ofxPayment('a', 5000, '2026-10-20'), ofxPayment('b', 5000, '2026-11-10')];
    const alone = plan({ observations: [firstCycle()], rows, asOf: at('2026-11-12') });
    assert.deepEqual([...cycleOf(alone, C).ledger.proven].sort(), ['a', 'b']);
    const withSuccessor = plan({ observations: [firstCycle(), statement('2026-11-02', { start: '2026-10-03', D: '2026-11-27', S: 5000, M: 5000 })], rows, asOf: at('2026-11-12') });
    assert.deepEqual(cycleOf(withSuccessor, C).ledger.proven, ['a']);
    assert.deepEqual(cycleOf(withSuccessor, '2026-11-02').ledger.proven, ['b']);
    assert.equal(cycleOf(withSuccessor, C).window.closed, true);
  });

  it('F2: an older explicit zero never clears a later adverse read; same-date date-vs-instant is incomparable; an implicit later page is A9', () => {
    const adverse = dashboard(at('2026-10-28'), { C, D, R: 5000, P: 2500 });
    const older = dashboard(at('2026-10-29'), { C, D, R: 0, P: 0, asOfDate: '2026-10-15' });
    assert.deepEqual(redOf(plan({ observations: [firstCycle(), adverse, older], rows: [], asOf: at('2026-10-29', 13) })), ['R1a@card']);
    const sameDate = dashboard(at('2026-10-28', 20), { C, D, P: 0, asOfDate: '2026-10-28' });
    assert.deepEqual(redOf(plan({ observations: [firstCycle(), adverse, sameDate], rows: [], asOf: at('2026-10-29') })), ['R1a@card']);
    const implicitLater = dashboard(at('2026-10-29'), { C, D, P: 0, implicit: true });
    const downgraded = plan({ observations: [firstCycle(), adverse, implicitLater], rows: [], asOf: at('2026-10-29', 13) });
    assert.deepEqual(redOf(downgraded), []);
    assert.equal(downgraded.delinquency?.downgraded, 'implicit-later');
    assert.ok(downgraded.attention.some((item) => item.rule === 'A9'));
    // A later explicit P = 0 clears it.
    const cleared = plan({ observations: [firstCycle(), adverse, dashboard(at('2026-10-29'), { C, D, P: 0 })], rows: [], asOf: at('2026-10-29', 13) });
    assert.equal(cleared.delinquency, null);
  });

  it('F2: posted payments covering P after the notice downgrade R1a to A9; pending payments never do', () => {
    const adverse = dashboard(at('2026-10-28'), { C, D, P: 2500 });
    const posted = plan({ observations: [firstCycle(), adverse], rows: [ofxPayment('pay', 2500, '2026-10-29')], asOf: at('2026-10-30') });
    assert.equal(posted.delinquency?.downgraded, 'payments-after');
    const pending = plan({ observations: [firstCycle(), adverse], rows: [pendingPayment('pay', 2500, at('2026-10-29'))], asOf: at('2026-10-30') });
    assert.deepEqual(redOf(pending), ['R1a@card']);
  });

  it('F3: a not-required phrase on D is "minimum met by D" at 72 h, at 72 h + 1 s and later; never R1b', () => {
    const read = dashboard(at(D, 10), { C, D, phrase: 'not-required' });
    for (const offsetMs of [72 * 3_600_000, 72 * 3_600_000 + 1000, 20 * 86_400_000]) {
      const asOf = new Date(Date.parse(read.financialAsOf) + offsetMs).toISOString();
      const k = cycleOf(plan({ observations: [firstCycle(), read], rows: [], asOf }), C);
      assert.equal(k.answers.minimumMetByDue, true);
      assert.ok(!k.attention.some((item) => item.rule === 'R1b' || item.rule === 'A11'));
    }
  });

  it('F4: a fresh unlinked read with R > 0, P = 0 and a not-required phrase is never R2b (A5 under the statement policy); the linked one the same; R2b without the phrase', () => {
    const asOf = at('2026-10-24', 13);
    const unlinked = plan({ observations: [dashboard(at('2026-10-24'), { D, R: 5000, P: 0, phrase: 'not-required', autopay: 'off' })], rows: [], asOf });
    assert.deepEqual(unlinked.attention.map((item) => item.rule), ['A5']);
    const linked = cycleOf(plan({ observations: [firstCycle(), dashboard(at('2026-10-24'), { C, D, R: 5000, P: 0, phrase: 'not-required', autopay: 'off' })], rows: [], asOf }), C);
    assert.deepEqual(rulesOf(linked), ['A5']);
    const owed = plan({ observations: [dashboard(at('2026-10-24'), { D, R: 5000, P: 0, autopay: 'off' })], rows: [], asOf });
    assert.deepEqual(owed.attention.map((item) => item.rule), ['R2b']);
    assert.match(owed.attention[0].copy, /^testbank showed a payment still due on 2026-10-27, as of /);
    // Covering autopay or a covering scheduled payment on the same read: no R2b.
    for (const extra of [{ autopay: 'on-minimum' as const }, { scheduled: ['2026-10-26', 5000] as [string, number] }]) {
      const covered = plan({ observations: [dashboard(at('2026-10-24'), { D, R: 5000, M: 5000, ...extra })], rows: [], asOf });
      assert.deepEqual(covered.attention.filter((item) => item.rule === 'R2b'), []);
    }
  });

  it('F5: a due-day pending payment is A1c; posted after D without a receipt date it is A11; a later return re-derives; pending never clears R1a', () => {
    const pending = pendingPayment('p', 5000, at(D, 9));
    assert.deepEqual(rulesOf(run([pending], at('2026-10-28'))), ['A1c']);
    const posted = [cardRow({ ...pending, status: 'removed', removedReason: 'settled-into', removedFromStatus: 'pending', mergedIntoId: 'p-posted' }),
      ofxPayment('p-posted', 5000, '2026-10-29')];
    assert.deepEqual(rulesOf(run(posted, at('2026-10-30'))), ['A11:past-due-unconfirmed']);
  });
});

describe('the red and amber rules', () => {
  const near = (rows: History['rows'], observations: History['observations'] = []) => cycleOf(plan({ ...v9History({ rows }), observations: [...v9History({}).observations, ...observations] }), V9.C);

  it('R2a needs D within 3 days (due today counts), M > 0, nothing in flight, a clear guard and coverage; A1 within 10 days', () => {
    const today = cycleOf(plan({ ...v9History({}), asOf: et(V9.D, 9) }), V9.C);
    assert.deepEqual(rulesOf(today), ['R2a:no-payment-seen']);
    const sevenDays = cycleOf(plan({ ...v9History({}), asOf: et('2026-10-30', 12) }), V9.C);
    assert.deepEqual(rulesOf(sevenDays), ['A1']);
    const far = cycleOf(plan({ ...v9History({}), asOf: et('2026-10-20', 12) }), V9.C);
    assert.deepEqual(rulesOf(far), []);
    const gap = cycleOf(plan({ ...v9History({}), coverage: [{ start: '2025-01-01', end: '2026-10-30' }] }), V9.C);
    assert.deepEqual(rulesOf(gap), ['A1', 'A2b']);
    assert.equal(gap.state, 'unknown-coverage');
  });

  it('in flight: a covering pending payment (A1c), current scheduled or autopay of the minimum (A1b); fixed autopay below M or unknown is not', () => {
    assert.deepEqual(rulesOf(near([pendingPayment('p', 5000, et('2026-11-02', 9))])), ['A1c']);
    const scheduled = near([], [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, scheduled: ['2026-11-05', 5000] })]);
    assert.deepEqual(rulesOf(scheduled), ['A1b']);
    const autopay = near([], [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, autopay: 'on-statement' })]);
    assert.deepEqual(rulesOf(autopay), ['A1b']);
    for (const fixed of [{ autopay: 'on-fixed' as const, autopayFixed: 2500 }, { autopay: 'on-fixed' as const }, { autopay: 'on-other' as const }]) {
      assert.deepEqual(rulesOf(near([], [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, ...fixed })])), ['R2a:no-payment-seen']);
    }
  });

  it('A5 under the statement policy: the minimum met but the statement not (and S − R never counts as met)', () => {
    const minimumOnly = near([ofxPayment('a', 5000, '2026-10-20')]);
    assert.deepEqual(rulesOf(minimumOnly), ['A5']);
    assert.equal(minimumOnly.answers.statementSatisfied, false);
    const full = near([ofxPayment('a', 20000, '2026-10-20')]);
    assert.deepEqual(rulesOf(full), []);
    assert.equal(full.state, 'paid-in-full');
    const minimumPolicy = cycleOf(plan({ ...v9History({ rows: [ofxPayment('a', 5000, '2026-10-20')] }), rules: { policy: 'minimum' } }), V9.C);
    assert.deepEqual(rulesOf(minimumPolicy), []);
    // An issuer remaining balance below S never counts as a payment.
    const remaining = near([], [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 1000 })]);
    assert.equal(remaining.answers.minimumMetSoFar, false);
  });

  it('A8: a held cycle (statement facts disagree) and held observations', () => {
    const result = plan({ ...v9History({}), observations: [...v9History({}).observations, dashboard(et('2026-10-20', 9), { C: V9.C, D: '2026-11-07' }),
      observation({ status: 'held', heldReason: 'minimum-basis', statementClosingDate: '2026-12-01', observedAt: et('2026-10-20', 9) })] });
    const k = cycleOf(result, V9.C);
    assert.equal(k.status, 'held');
    assert.equal(k.heldReason, 'contradiction');
    assert.deepEqual(rulesOf(k), ['A8']);
    assert.ok(result.attention.some((item) => item.rule === 'A8' && item.subject === 'card'));
  });

  it('A10: an expired current-only reassurance (autopay shown) is the only assurance: amber, never red', () => {
    const stale = near([], [dashboard(et('2026-10-25', 9), { C: V9.C, D: V9.D, autopay: 'on-statement' })]);
    assert.ok(rulesOf(stale).includes('A10'));
    assert.ok(!rulesOf(stale).some((rule) => rule.startsWith('R')));
    // A "paid" phrase dated before D is a deadline fact: met by D, and it never expires.
    const phrase = near([], [dashboard(et('2026-10-25', 9), { C: V9.C, D: V9.D, phrase: 'paid' })]);
    assert.equal(phrase.answers.minimumMetByDue, true);
    assert.ok(!rulesOf(phrase).includes('A10'));
  });

  it('A11 confirmation-needed: two reads at the same as-of disagree on the phrase', () => {
    const k = near([], [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, phrase: 'paid' }), dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, phrase: 'none' })]);
    assert.ok(rulesOf(k).includes('A11:confirmation-needed'));
    assert.equal(k.live.issuerPhrase, null);
    assert.deepEqual(k.live.conflicts, ['phrase']);
  });

  it('issuer-evidence claims need no coverage; ledger-absence claims do', () => {
    const noCoverage = plan({ ...v9History({}), coverage: [], observations: [...v9History({}).observations, dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 5000, P: 2500 })] });
    assert.deepEqual(redOf(noCoverage), ['R1a@card', `R2b@${V9.C}`]);
    assert.ok(!noCoverage.attention.some((item) => item.rule === 'R2a'));
  });

  it('carry-forward: the successor\'s observed P resolves an older cycle (P > 0 moves the arrears there); an absent P carries nothing', () => {
    const base = [statement('2026-09-02', { D: '2026-09-27', S: 5000, M: 5000, P: 0 })];
    const carried = plan({ observations: [...base, statement(C, { start: '2026-09-03', D, S: 9000, M: 7000, P: 2000 })], rows: [], asOf: at('2026-10-10') });
    assert.equal(cycleOf(carried, '2026-09-02').shown, false);
    assert.equal(cycleOf(carried, '2026-09-02').state, 'carried-forward');
    const absent = plan({ observations: [...base, statement(C, { start: '2026-09-03', D, S: 9000, M: 7000 })], rows: [], asOf: at('2026-10-10') });
    const prev = cycleOf(absent, '2026-09-02');
    assert.equal(prev.shown, true);
    assert.deepEqual(rulesOf(prev), ['A11:past-due-unconfirmed']);
    // An old minimum met late while the latest P is larger keeps R1a red.
    const late = plan({ observations: [...base, statement(C, { start: '2026-09-03', D, S: 9000, M: 7000, P: 2000 })], rows: [ofxPayment('late', 5000, '2026-09-29')], asOf: at('2026-10-10') });
    assert.deepEqual(redOf(late), ['R1a@card']);
  });

  it('unresolved older cycles are kept with no age cutoff, and closing a card never resolves them', () => {
    const old = plan({ observations: [statement('2025-01-02', { D: '2025-01-27', S: 5000, M: 5000 }), statement('2026-10-02', { D, S: 0, M: 0 })], rows: [], asOf: at('2026-10-10') });
    assert.equal(cycleOf(old, '2025-01-02').shown, true);
  });

  it('a due-only read links to its one cycle, else stays an unlinked bank read; one statement never becomes two cycles', () => {
    const linked = plan({ observations: [firstCycle(), dashboard(at('2026-10-20'), { D, R: 4000 })], rows: [], asOf: at('2026-10-20', 13) });
    assert.equal(linked.cycles.length, 1);
    assert.equal(linked.bankReads.length, 0);
    assert.equal(cycleOf(linked, C).live.remainingStatementMinor, 4000);
    const unlinked = plan({ observations: [firstCycle(), dashboard(at('2026-10-20'), { D: '2026-11-27', R: 4000 })], rows: [], asOf: at('2026-10-20', 13) });
    assert.equal(unlinked.bankReads.length, 1);
    assert.equal(unlinked.bankReads[0].dueDate, '2026-11-27');
  });

  it('knowledge mode ignores facts and rows Holdr did not have by T; counterfactual replays by effective time, statements two days after close', () => {
    const lateRead = dashboard(at('2026-10-20'), { C, D, R: 5000, seenAt: at('2026-10-30') });
    const knowledge = cycleOf(plan({ observations: [firstCycle(), lateRead], rows: [], asOf: at('2026-10-25') }), C);
    assert.equal(knowledge.live.remainingStatementMinor, null);
    const counterfactual = plan({ observations: [firstCycle(), lateRead], rows: [], asOf: at('2026-10-25'), mode: 'counterfactual' });
    assert.equal(counterfactual.mode, 'counterfactual');
    assert.equal(cycleOf(counterfactual, C).live.remainingStatementMinor, 5000);
    const beforeStatement = plan({ observations: [firstCycle()], rows: [], asOf: at('2026-10-03'), mode: 'counterfactual' });
    assert.deepEqual(beforeStatement.cycles, []);
  });

  it('Eastern boundaries: due today at 23:59 ET is still due today; after midnight ET it is past due (DST and month-end safe)', () => {
    const lastMinute = cycleOf(plan({ observations: [firstCycle()], rows: [], asOf: et(D, 23, 59) }), C);
    assert.deepEqual(rulesOf(lastMinute), ['R2a:no-payment-seen']);
    const nextDay = cycleOf(plan({ observations: [firstCycle()], rows: [], asOf: et('2026-10-28', 0, 1) }), C);
    assert.deepEqual(rulesOf(nextDay), ['A11:past-due-unconfirmed']);
    // DST ends Nov 1, 2026; a cycle due that day.
    const dst = cycleOf(plan({ observations: [statement('2026-10-07', { D: '2026-11-01', S: 5000, M: 5000, P: 0 })], rows: [], asOf: et('2026-11-01', 23, 30) }), '2026-10-07');
    assert.deepEqual(rulesOf(dst), ['R2a:no-payment-seen']);
    // Leap day and month end.
    const leap = cycleOf(plan({ observations: [statement('2028-02-03', { D: '2028-02-29', S: 5000, M: 5000, P: 0 })], rows: [], asOf: et('2028-02-29', 12), coverage: [{ start: '2028-01-01', end: '2028-03-31' }] }), '2028-02-03');
    assert.deepEqual(rulesOf(leap), ['R2a:no-payment-seen']);
  });

  it('a csv payment first seen after the close is only possible: never proven, so before D it is A11, never R2a', () => {
    const k = near([csvPayment('c', 5000, '2026-10-20', et('2026-10-21', 9))]);
    assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
  });
});
