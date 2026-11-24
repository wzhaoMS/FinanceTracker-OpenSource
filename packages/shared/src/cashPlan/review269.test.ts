import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileCardPayments } from '../cardPaymentReconciliation.js';
import { addDays } from './dates.js';
import {
  CARD,
  V9,
  cardRow,
  csvPayment,
  cycleOf,
  dashboard,
  et,
  lastPaymentRead,
  ofxPayment,
  pendingPayment,
  plan,
  redOf,
  rulesOf,
  statement,
  v9History,
  type History,
} from './__fixtures__/history.js';

/**
 * Regressions for 5b01e72f's sealed review of #269 at 2ea9105c (FAIL, report 9fe6f694…): each probe scenario of
 * pr269-review-repro-2ea9105c.mts, with the outcome the contract requires. Synthetic cents only.
 */

describe('#269 finding 1: a payment-state contradiction is never red', () => {
  const conflictingSchedules = () => [
    dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, scheduled: ['2026-11-05', 5000] }),
    dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, scheduled: ['2026-11-05', 2500] }),
  ];

  it('tied covering and non-covering schedules, D in three days, full coverage: A11 confirmation-needed only, no R2a or A1', () => {
    const result = plan(v9History({ observations: conflictingSchedules() }));
    const k = cycleOf(result, V9.C);
    assert.deepEqual(k.live.conflicts, ['scheduled']);
    assert.equal(k.state, 'confirmation-needed');
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(result), []);
  });

  it('the same contradiction with a current owed read: still no R2b', () => {
    const result = plan(v9History({ observations: [...conflictingSchedules(), dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 20000 })] }));
    assert.deepEqual(rulesOf(cycleOf(result, V9.C)), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(result), []);
  });

  it('tied remaining balances (R = 0 against R > 0) or tied autopay are held the same way', () => {
    for (const reads of [
      [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 0 }), dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 20000 })],
      [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, autopay: 'on-minimum' }), dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, autopay: 'off' })],
    ]) {
      const result = plan(v9History({ observations: reads }));
      assert.deepEqual(rulesOf(cycleOf(result, V9.C)), ['A11:confirmation-needed']);
      assert.deepEqual(redOf(result), []);
    }
  });

  it('an unlinked bank read group with a held contradiction: A11, never R2b', () => {
    const due = '2026-11-05';
    const result = plan({
      observations: [
        dashboard(et('2026-11-02', 9), { D: due, R: 5000, scheduled: [due, 5000] }),
        dashboard(et('2026-11-02', 9), { D: due, R: 5000, scheduled: [due, 1000] }),
      ],
      rows: [], asOf: V9.T,
    });
    assert.deepEqual(result.bankReads.map((read) => read.attention.map((item) => `${item.rule}:${item.reason}`)), [['A11:confirmation-needed']]);
    assert.deepEqual(redOf(result), []);
  });

  it('an unlinked owed read is not red while another current read shows a covering schedule', () => {
    const due = '2026-11-05';
    const result = plan({
      observations: [dashboard(et('2026-11-02', 9), { D: due, R: 5000, M: 5000 }), dashboard(et('2026-11-02', 10), { D: due, scheduled: ['2026-11-04', 5000] })],
      rows: [], asOf: V9.T,
    });
    assert.deepEqual(redOf(result), []);
  });
});

describe('#269 finding 2: historical phrase proofs use the merged fact at their cutoff', () => {
  it('a tied "paid" and "none" proves nothing: neither minimum answer is true, confirmation-needed', () => {
    const k = cycleOf(plan(v9History({ observations: [
      dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, phrase: 'paid' }),
      dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, phrase: 'none' }),
    ] })), V9.C);
    assert.deepEqual(k.live.conflicts, ['phrase']);
    assert.equal(k.answers.minimumMetByDue, false);
    assert.equal(k.answers.minimumMetSoFar, false);
    assert.equal(k.state, 'confirmation-needed');
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
  });

  it('the conflicted predecessor stays shown, and never resolves its successor\'s guard or admits a new payment', () => {
    const result = plan({
      observations: [
        statement(V9.prevC, { D: V9.prevD, S: 5000, M: 5000, P: 0 }),
        dashboard(et('2026-10-05', 9), { C: V9.prevC, D: V9.prevD, phrase: 'paid' }),
        dashboard(et('2026-10-05', 9), { C: V9.prevC, D: V9.prevD, phrase: 'none' }),
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000 }),
      ],
      rows: [ofxPayment('new-cycle-payment', 5000, '2026-10-20')],
      asOf: V9.T,
    });
    const predecessor = cycleOf(result, V9.prevC);
    assert.equal(predecessor.shown, true);
    assert.equal(predecessor.answers.minimumMetByDue, false);
    assert.deepEqual(rulesOf(predecessor), ['A11:confirmation-needed']);
    const successor = cycleOf(result, V9.C);
    assert.deepEqual(successor.predecessor, { kind: 'captured', resolved: false });
    assert.deepEqual(successor.ledger.proven, []);
    assert.ok(successor.ledger.possible.includes('new-cycle-payment'));
    assert.equal(successor.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(successor), ['A11:payment-unconfirmed']);
  });

  it('a later adverse read before D undoes an earlier phrase proof (phrase, or P > 0 alone)', () => {
    const C = '2026-10-02';
    const D = '2026-10-27';
    const old = dashboard(et('2026-10-20', 12), { C, D, phrase: 'not-required', R: 0 });
    for (const adverse of [
      dashboard(et('2026-10-26', 12), { C, D, P: 5000, R: 5000, phrase: 'past-due' }),
      dashboard(et('2026-10-26', 12), { C, D, P: 5000 }),
    ]) {
      const k = cycleOf(plan({ observations: [statement(C, { D, S: 5000, M: 5000, P: 0 }), old, adverse], rows: [], asOf: et('2026-10-28', 12) }), C);
      assert.equal(k.answers.minimumMetByDue, false);
      assert.notEqual(k.state, 'minimum-met');
      assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
    }
  });

  it('the guard accepts only a merged, uncorrected, not-undone not-required phrase for k−1; never "paid"', () => {
    const run = (prevReads: History['observations'], extra: Pick<History, 'returned' | 'reversalDates'> & { rows?: History['rows'] } = {}) => cycleOf(plan({
      observations: [
        statement(V9.prevC, { D: '2026-10-15', S: 5000, M: 5000 }),
        ...prevReads,
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000 }),
      ],
      rows: [ofxPayment('k-payment', 5000, '2026-10-20'), ...(extra.rows ?? [])],
      asOf: V9.T,
      returned: extra.returned,
      reversalDates: extra.reversalDates,
    }), V9.C).predecessor;
    const notRequired = dashboard(et('2026-10-05', 9), { C: V9.prevC, D: '2026-10-15', phrase: 'not-required' });
    assert.deepEqual(run([notRequired]), { kind: 'captured', resolved: true });
    assert.deepEqual(run([dashboard(et('2026-10-05', 9), { C: V9.prevC, D: '2026-10-15', phrase: 'paid' })]), { kind: 'captured', resolved: false });
    assert.deepEqual(run([notRequired, dashboard(et('2026-10-05', 9), { C: V9.prevC, D: '2026-10-15', phrase: 'none' })]), { kind: 'captured', resolved: false });
    assert.deepEqual(run([notRequired, dashboard(et('2026-10-08', 9), { C: V9.prevC, D: '2026-10-15', P: 2500 })]), { kind: 'captured', resolved: false });
    // A payment it may rest on, returned after it: undone. Returned before it: the read already reflects the return.
    const prevPayment = ofxPayment('prev-payment', 5000, '2026-10-01');
    assert.deepEqual(run([notRequired], { rows: [prevPayment], returned: ['prev-payment'], reversalDates: { 'prev-payment': '2026-10-07' } }),
      { kind: 'captured', resolved: false });
    assert.deepEqual(run([notRequired], { rows: [prevPayment], returned: ['prev-payment'], reversalDates: { 'prev-payment': '2026-10-03' } }),
      { kind: 'captured', resolved: true });
  });
});

describe('#269 finding 3: an undone payment undoes the issuer reassurance that may rest on it', () => {
  const C = '2026-10-02';
  const D = '2026-10-27';
  const observations = () => [
    statement(C, { D, S: 5000, M: 5000, P: 0 }),
    dashboard(et(D, 12), { C, D, R: 0, phrase: 'not-required', lastPayment: ['2026-10-26', 5000] }),
  ];
  const rows = () => [ofxPayment('only-payment', 5000, '2026-10-26')];

  it('the reviewer\'s real reconciliation case: the Oct 28 return of the sole payment re-derives the deadline and current answers', () => {
    const input: History = { observations: observations(), rows: rows(), asOf: et('2026-10-28', 12) };
    assert.equal(cycleOf(plan(input), C).state, 'paid-in-full');
    const reconciliation = reconcileCardPayments({
      cardAccounts: [{ id: CARD.id, issuer: CARD.issuer }],
      cardRows: [
        { id: 'only-payment', cardAccountId: CARD.id, transactionDate: '2026-10-26', postedDate: '2026-10-26', status: 'posted', amountMinor: -5000,
          currency: 'USD', kind: 'payment', description: 'PAYMENT THANK YOU' },
        { id: 'later-return', cardAccountId: CARD.id, transactionDate: '2026-10-28', postedDate: '2026-10-28', status: 'posted', amountMinor: 5000,
          currency: 'USD', kind: 'payment', description: 'RETURNED PAYMENT' },
      ],
      checkingAccounts: [], checkingRows: [],
    });
    assert.deepEqual(reconciliation.returned.map((item) => item.paymentId), ['only-payment']);
    for (const reversalDates of [{ 'only-payment': '2026-10-28' }, undefined]) {
      const k = cycleOf(plan({ ...input, returned: ['only-payment'], reversalDates }), C);
      assert.equal(k.ledger.provenMinor, 0);
      assert.equal(k.ledger.possibleMinor, 0);
      assert.equal(k.answers.minimumMetByDue, false);
      assert.equal(k.answers.statementSatisfied, false);
      assert.equal(k.state, 'past-due-unconfirmed');
      assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
    }
  });

  it('before D: a returned payment undoes the current "paid" and R = 0; a fresh read after the return stands again', () => {
    const due = '2026-11-06';
    const base: History = {
      observations: [statement(C, { D: due, S: 5000, M: 5000, P: 0 }), dashboard(et('2026-10-27', 12), { C, D: due, R: 0, phrase: 'paid' })],
      rows: rows(), asOf: et('2026-10-29', 12), returned: ['only-payment'], reversalDates: { 'only-payment': '2026-10-28' },
    };
    const undone = cycleOf(plan(base), C);
    assert.equal(undone.answers.minimumMetSoFar, false);
    assert.equal(undone.answers.statementSatisfied, false);
    assert.deepEqual(rulesOf(undone), ['A1']);
    const fresh = cycleOf(plan({ ...base, observations: [...base.observations, dashboard(et('2026-10-29', 10), { C, D: due, R: 0, phrase: 'paid' })] }), C);
    assert.equal(fresh.answers.minimumMetSoFar, true);
    assert.equal(fresh.state, 'paid-in-full');
    // A return dated before the read: the read already reflects it.
    const earlier = cycleOf(plan({ ...base, reversalDates: { 'only-payment': '2026-10-26' } }), C);
    assert.equal(earlier.state, 'paid-in-full');
  });

  it('a possible reversal after the read, or a pending payment cancelled after it, undoes the reassurance too', () => {
    const due = '2026-11-06';
    const read = dashboard(et('2026-10-27', 12), { C, D: due, R: 0, phrase: 'paid' });
    const uncertain = cycleOf(plan({
      observations: [statement(C, { D: due, S: 5000, M: 5000, P: 0 }), read], rows: rows(), asOf: et('2026-10-29', 12),
      uncertain: ['only-payment'], reversalDates: { 'only-payment': '2026-10-28' },
    }), C);
    assert.equal(uncertain.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(uncertain), ['A11:payment-unconfirmed']);
    const cancelled = cycleOf(plan({
      observations: [statement(C, { D: due, S: 5000, M: 5000, P: 0 }), read],
      rows: [cardRow({ ...pendingPayment('p', 5000, et('2026-10-26', 9)), status: 'removed', removedReason: 'cancelled', removedFromStatus: 'pending',
        removedAt: et('2026-10-28', 9) })],
      asOf: et('2026-10-29', 12),
    }), C);
    assert.equal(cancelled.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(cancelled), ['A1']);
  });
});

describe('#269 finding 4: a zero minimum is a met minimum, not a statement with nothing due', () => {
  it('total M = 0 with S = R = 20000 and D in three days: minimum-met with A5 under the statement policy', () => {
    const k = cycleOf(plan({
      observations: [statement(V9.C, { D: V9.D, S: 20000, M: 0, P: 0 }), dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 20000 })],
      rows: [], asOf: V9.T,
    }), V9.C);
    assert.equal(k.answers.minimumMetSoFar, true);
    assert.equal(k.answers.statementSatisfied, false);
    assert.equal(k.state, 'minimum-met');
    assert.deepEqual(rulesOf(k), ['A5']);
    const minimumPolicy = cycleOf(plan({
      observations: [statement(V9.C, { D: V9.D, S: 20000, M: 0, P: 0 })], rows: [], asOf: V9.T, rules: { policy: 'minimum' },
    }), V9.C);
    assert.deepEqual(rulesOf(minimumPolicy), []);
  });

  it('an observed S ≤ 0 is still not-required; a k−1 with M = 0 still resolves its successor\'s guard (spec v9 §3)', () => {
    assert.equal(cycleOf(plan({ observations: [statement(V9.C, { D: V9.D, S: -300, M: 0, P: 0 })], rows: [], asOf: V9.T }), V9.C).state, 'not-required');
    const successor = cycleOf(plan({
      observations: [statement(V9.prevC, { D: V9.prevD, S: 3000, M: 0 }), statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000 })],
      rows: [ofxPayment('k-payment', 5000, '2026-10-20')], asOf: V9.T,
    }), V9.C);
    assert.deepEqual(successor.predecessor, { kind: 'captured', resolved: true });
    assert.equal(successor.answers.minimumMetSoFar, true);
  });
});

describe('a current issuer R ≤ 0 is never red (same class as finding 1)', () => {
  it('the bank shows the statement paid but the ledger shows nothing: A11 confirmation-needed, not R2a', () => {
    const result = plan(v9History({ observations: [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 0 })] }));
    const k = cycleOf(result, V9.C);
    assert.equal(k.answers.statementSatisfied, true);
    assert.equal(k.state, 'confirmation-needed');
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(result), []);
  });

  it('a stale R = 0 still gives A10 and never R2a', () => {
    const k = cycleOf(plan(v9History({ observations: [dashboard(et('2026-10-25', 9), { C: V9.C, D: V9.D, R: 0 })] })), V9.C);
    assert.ok(rulesOf(k).includes('A10'));
    assert.ok(!rulesOf(k).some((rule) => rule.startsWith('R')));
  });
});

describe("Root's ruling of 2026-11-08 (b): a late cure of k−1 may post just after the close", () => {
  const prevC = '2026-09-01';
  const prevD = '2026-09-26';
  const C = '2026-10-01';
  const D = '2026-10-26';
  const asOf = et('2026-10-10', 12);
  // k−1 isn't met in its own window; statement k shows P = 0, so the guard resolves only from issuer evidence.
  const statements = () => [statement(prevC, { D: prevD, S: 5000, M: 5000 }), statement(C, { start: '2026-09-02', D, S: 9000, M: 5000, P: 0 })];

  it('the witness: due Sep 26, paid late (received Sep 30), posted Oct 2 with no DTUSER, close Oct 1 with P = 0: A11, never met', () => {
    const k = cycleOf(plan({ observations: statements(), rows: [ofxPayment('late-cure', 5000, '2026-10-02')], asOf }), C);
    assert.deepEqual(k.predecessor, { kind: 'captured', resolved: true });
    assert.deepEqual(k.ledger.proven, []);
    assert.ok(k.ledger.possible.includes('late-cure'));
    assert.equal(k.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
  });

  it('the boundary: posted on C_k + 4 is held; posted on C_k + 5 is assigned', () => {
    const at = (posted: string) => cycleOf(plan({ observations: statements(), rows: [ofxPayment('p', 5000, posted)], asOf }), C);
    const day4 = at('2026-10-05');
    assert.deepEqual(day4.ledger.proven, []);
    assert.deepEqual(rulesOf(day4), ['A11:payment-unconfirmed']);
    const day5 = at('2026-10-06');
    assert.deepEqual(day5.ledger.proven, ['p']);
    assert.equal(day5.answers.minimumMetSoFar, true);
  });

  it('an issuer receipt binding that dates the payment after C_k admits it', () => {
    const read = lastPaymentRead(et('2026-10-03', 12), '2026-10-02', 5000, { C, D });
    const result = plan({ observations: [...statements(), read], rows: [ofxPayment('p', 5000, '2026-10-02')], asOf });
    assert.deepEqual(result.bindings.map((binding) => [binding.identityId, binding.receivedOn]), [['p', '2026-10-02']]);
    const k = cycleOf(result, C);
    assert.deepEqual(k.ledger.proven, ['p']);
    assert.equal(k.answers.minimumMetSoFar, true);
  });

  it('no hold when k−1 was met in its own window, or its statement asked for nothing', () => {
    const ownWindow = cycleOf(plan({
      observations: [statement(prevC, { D: prevD, S: 5000, M: 5000, P: 0 }), statement(C, { start: '2026-09-02', D, S: 9000, M: 5000, P: 0 })],
      rows: [ofxPayment('prev-pay', 5000, '2026-09-20'), ofxPayment('p', 5000, '2026-10-02')], asOf,
    }), C);
    assert.deepEqual(ownWindow.ledger.proven, ['p']);
    const nothingDue = cycleOf(plan({
      observations: [statement(prevC, { D: prevD, S: 0, M: 0 }), statement(C, { start: '2026-09-02', D, S: 9000, M: 5000 })],
      rows: [ofxPayment('p', 5000, '2026-10-02')], asOf,
    }), C);
    assert.deepEqual(nothingDue.ledger.proven, ['p']);
  });

  it('the first captured cycle (Root\'s 14:05 exception) is issuer-only too', () => {
    const first = cycleOf(plan({ observations: [statement(C, { D, S: 9000, M: 5000, P: 0 })], rows: [ofxPayment('p', 5000, '2026-10-03')], asOf }), C);
    assert.deepEqual(first.predecessor, { kind: 'uncaptured', resolved: true });
    assert.deepEqual(rulesOf(first), ['A11:payment-unconfirmed']);
  });
});

describe('#269 at bcdcbfb6, 5b01e72f\'s candidates: reassurances read every known fact; the clearing rule applies across fields', () => {
  it('a same-day date-precision R = 0 read is current at noon: A11 confirmation-needed, never R2a', () => {
    const result = plan(v9History({ observations: [dashboard(et('2026-11-03', 9), { C: V9.C, D: V9.D, R: 0, asOfDate: '2026-11-03' })] }));
    const k = cycleOf(result, V9.C);
    assert.equal(k.answers.statementSatisfied, true);
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(result), []);
  });

  it('a same-day date-precision "paid" phrase is current: the minimum is met', () => {
    const k = cycleOf(plan(v9History({ observations: [dashboard(et('2026-11-03', 9), { C: V9.C, D: V9.D, phrase: 'paid', asOfDate: '2026-11-03' })] })), V9.C);
    assert.equal(k.answers.minimumMetSoFar, true);
    assert.equal(k.state, 'minimum-met');
  });

  it('an implicit-capture not-required read after an explicit P > 0 never resolves the predecessor; an explicit one does', () => {
    const run = (implicit: boolean) => cycleOf(plan({
      observations: [
        statement(V9.prevC, { D: V9.prevD, S: 5000, M: 5000 }),
        dashboard(et('2026-10-07', 12), { C: V9.prevC, D: V9.prevD, P: 2500 }),
        dashboard(et('2026-10-08', 12), { C: V9.prevC, D: V9.prevD, phrase: 'not-required', implicit }),
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000 }),
      ],
      rows: [ofxPayment('k-payment', 5000, '2026-10-20')], asOf: V9.T,
    }), V9.C);
    const contested = run(true);
    assert.deepEqual(contested.predecessor, { kind: 'captured', resolved: false });
    assert.deepEqual(contested.ledger.proven, []);
    assert.deepEqual(rulesOf(contested), ['A11:payment-unconfirmed']);
    const control = run(false);
    assert.deepEqual(control.predecessor, { kind: 'captured', resolved: true });
    assert.deepEqual(control.ledger.proven, ['k-payment']);
  });

  it('an implicit "paid" after a statement showing arrears is contested: amber, never neutral or red; explicit, or ledger proof, settles it', () => {
    const observations = (read: Parameters<typeof dashboard>[1]) => [
      statement(V9.prevC, { D: V9.prevD, S: 0, M: 0, P: 0 }),
      statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000, P: 2500 }),
      dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, ...read }),
    ];
    const contested = plan({ observations: observations({ phrase: 'paid', implicit: true }), rows: [], asOf: V9.T });
    const k = cycleOf(contested, V9.C);
    assert.equal(k.answers.minimumMetSoFar, false);
    assert.equal(k.state, 'confirmation-needed');
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(contested).filter((key) => key.startsWith('R2')), []);
    assert.equal(cycleOf(plan({ observations: observations({ phrase: 'paid' }), rows: [], asOf: V9.T }), V9.C).answers.minimumMetSoFar, true);
    const ledger = cycleOf(plan({ observations: observations({ phrase: 'paid', implicit: true }), rows: [ofxPayment('a', 5000, '2026-10-20')], asOf: V9.T }), V9.C);
    assert.equal(ledger.state, 'minimum-met');
    assert.deepEqual(rulesOf(ledger), ['A5']);
  });

  it('an implicit R = 0 outranked by an earlier explicit R > 0 is contested (amber); a strictly later adverse read keeps it red', () => {
    const reads = [
      dashboard(et('2026-11-01', 9), { C: V9.C, D: V9.D, R: 20000 }),
      dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 0, implicit: true }),
    ];
    const contested = plan(v9History({ observations: reads }));
    const k = cycleOf(contested, V9.C);
    assert.equal(k.state, 'confirmation-needed');
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(contested), []);
    const refuted = cycleOf(plan(v9History({ observations: [...reads, dashboard(et('2026-11-02', 18), { C: V9.C, D: V9.D, P: 2500 })] })), V9.C);
    assert.equal(refuted.state, 'unpaid');
    assert.ok(rulesOf(refuted).includes('R2a:no-payment-seen'));
  });

  it('a clearing read resting on a payment returned since no longer clears: a later implicit "paid" is contested, an explicit one proves', () => {
    const C = '2026-10-02';
    const due = '2026-11-06';
    const history = (implicit: boolean): History => ({
      observations: [
        statement(C, { D: due, S: 5000, M: 5000, P: 0 }),
        dashboard(et('2026-10-25', 12), { C, D: due, P: 2500 }),
        dashboard(et('2026-10-27', 12), { C, D: due, P: 0, phrase: 'paid' }),
        dashboard(et('2026-10-29', 10), { C, D: due, phrase: 'paid', implicit }),
      ],
      rows: [ofxPayment('only-payment', 5000, '2026-10-26')], asOf: et('2026-10-30', 12),
      returned: ['only-payment'], reversalDates: { 'only-payment': '2026-10-28' },
    });
    const contested = cycleOf(plan(history(true)), C);
    assert.equal(contested.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(contested), ['A11:confirmation-needed']);
    assert.equal(cycleOf(plan(history(false)), C).answers.minimumMetSoFar, true);
  });

  it('an unlinked read group: an implicit R = 0 after an explicit owed read is contested (A11, not R2b); a strictly later adverse read keeps R2b', () => {
    const due = '2026-11-05';
    const reads = [dashboard(et('2026-11-01', 9), { D: due, R: 5000 }), dashboard(et('2026-11-02', 9), { D: due, R: 0, implicit: true })];
    const contested = plan({ observations: reads, rows: [], asOf: V9.T });
    assert.deepEqual(contested.bankReads.map((read) => read.attention.map((item) => `${item.rule}:${item.reason}`)), [['A11:confirmation-needed']]);
    assert.deepEqual(redOf(contested), []);
    const refuted = plan({ observations: [...reads, dashboard(et('2026-11-02', 18), { D: due, P: 2500 })], rows: [], asOf: V9.T });
    assert.ok(redOf(refuted).includes(`R2b@${due}`));
  });
});

describe('#269 at 8bd62afe, 5b01e72f\'s raw-read candidates: a held value is no value; a "now" phrase is undo-aware in its own read too', () => {
  const attentionOf = (result: ReturnType<typeof plan>) => result.bankReads.map((read) => read.attention.map((item) => item.rule));

  it('candidate 1: a held not-required/none pair after D(k−1) never resolves the guard through the P-path; the lone not-required read does', () => {
    const run = (pair: boolean) => cycleOf(plan({
      observations: [
        statement(V9.prevC, { D: V9.prevD, S: 5000, M: 5000, P: 0 }),
        dashboard(et('2026-10-07', 9), { C: V9.prevC, D: V9.prevD, phrase: 'not-required' }),
        ...(pair ? [dashboard(et('2026-10-07', 9), { C: V9.prevC, D: V9.prevD, phrase: 'none' })] : []),
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000 }),
      ],
      rows: [ofxPayment('new-cycle-payment', 5000, '2026-10-20')],
      asOf: V9.T,
    }), V9.C);
    const held = run(true);
    assert.deepEqual(held.predecessor, { kind: 'captured', resolved: false });
    assert.deepEqual(held.ledger.proven, []);
    assert.equal(held.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(held), ['A11:payment-unconfirmed']);
    const control = run(false);
    assert.deepEqual(control.predecessor, { kind: 'captured', resolved: true });
    assert.deepEqual(control.ledger.proven, ['new-cycle-payment']);
  });

  it('candidate 2: a held explicit phrase never clears an explicit P > 0 for a later implicit phrase; the lone explicit phrase does', () => {
    const run = (pair: boolean) => plan(v9History({ observations: [
      dashboard(et('2026-11-01', 9), { C: V9.C, D: V9.D, P: 2500 }),
      dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, phrase: 'not-required' }),
      ...(pair ? [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, phrase: 'none' })] : []),
      dashboard(et('2026-11-02', 18), { C: V9.C, D: V9.D, phrase: 'not-required', implicit: true }),
    ] }));
    const held = run(true);
    const k = cycleOf(held, V9.C);
    assert.equal(k.answers.minimumMetSoFar, false);
    assert.equal(k.state, 'confirmation-needed');
    assert.deepEqual(rulesOf(k), ['A11:confirmation-needed']);
    assert.deepEqual(redOf(held).filter((key) => key.startsWith('R2')), []);
    assert.equal(cycleOf(run(false), V9.C).answers.minimumMetSoFar, true);
  });

  it('candidate 3: an unlinked "paid" resting on a payment returned since gives R2b, not A5, in its own read or another; a read dated after the return stands', () => {
    const due = '2026-11-05';
    const paid = dashboard(et('2026-11-02', 9), { D: due, phrase: 'paid' });
    const base: History = {
      observations: [dashboard(et('2026-11-01', 9), { D: due, R: 5000 }), paid],
      rows: [ofxPayment('sole-payment', 5000, '2026-11-01')],
      asOf: V9.T, returned: ['sole-payment'], reversalDates: { 'sole-payment': '2026-11-03' },
    };
    assert.deepEqual(attentionOf(plan(base)), [['R2b']]);
    assert.deepEqual(attentionOf(plan({ ...base, observations: [dashboard(et('2026-11-02', 9), { D: due, R: 5000, phrase: 'paid' })] })), [['R2b']]);
    // Undo is date-granular (reversal rows carry dates): a read on the return's own date may precede it.
    assert.deepEqual(attentionOf(plan({ ...base, observations: [...base.observations, dashboard(et('2026-11-03', 10), { D: due, phrase: 'paid' })] })), [['R2b']]);
    const fresh = plan({
      ...base,
      observations: [dashboard(et('2026-11-01', 12), { D: due, R: 5000 }), paid, dashboard(et('2026-11-04', 9), { D: due, phrase: 'paid' })],
      asOf: et('2026-11-04', 10),
    });
    assert.deepEqual(attentionOf(fresh), [['A5']]);
    assert.deepEqual(redOf(fresh), []);
  });

  it('sweep: a linked owed read\'s own "paid" resting on a payment returned since no longer suppresses R2b; returned before the read, it stands', () => {
    const history = (returnedOn: string): History => ({
      ...v9History({ observations: [dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 20000, phrase: 'paid' })], rows: [ofxPayment('sole-payment', 5000, '2026-10-20')] }),
      returned: ['sole-payment'], reversalDates: { 'sole-payment': returnedOn },
    });
    const undone = plan(history('2026-11-03'));
    assert.equal(cycleOf(undone, V9.C).answers.issuerShowsOwed, true);
    assert.ok(redOf(undone).includes(`R2b@${V9.C}`));
    const reflected = cycleOf(plan(history('2026-11-01')), V9.C);
    assert.equal(reflected.state, 'minimum-met');
    assert.deepEqual(rulesOf(reflected), ['A5']);
  });
});

describe("Root's ruling (a) of 2026-11-08: a return voids only reassurances its payment can underlie (posted, else transaction-dated, by d + 4)", () => {
  const payment = (kind: 'ofx' | 'csv', id: string, date: string) => (kind === 'ofx'
    ? ofxPayment(id, 5000, date) : csvPayment(id, 5000, date, et(addDays(date, 1), 6)));

  it("5b01e72f's witness: P 5000 Oct 2, the sole payment posted Oct 5, P 0 Oct 6, successor P 0 at Oct 11, returned Oct 12: k−1 stays unresolved and R1a stands", () => {
    const history = (returnedOn: string): History => ({
      observations: [
        statement(V9.prevC, { D: V9.prevD, S: 5000, M: 5000 }),
        dashboard(et('2026-10-02', 12), { C: V9.prevC, D: V9.prevD, P: 5000 }),
        dashboard(et('2026-10-06', 12), { C: V9.prevC, D: V9.prevD, P: 0 }),
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000, P: 0 }),
      ],
      rows: [ofxPayment('sole-payment', 5000, '2026-10-05')],
      asOf: V9.T, returned: ['sole-payment'], reversalDates: { 'sole-payment': returnedOn },
    });
    const result = plan(history('2026-10-12'));
    assert.deepEqual(cycleOf(result, V9.C).predecessor, { kind: 'captured', resolved: false });
    const prev = cycleOf(result, V9.prevC);
    assert.equal(prev.shown, true);
    assert.equal(prev.answers.minimumMetByDue, false);
    assert.deepEqual(rulesOf(prev), ['A11:past-due-unconfirmed']);
    assert.notEqual(result.delinquency, null);
    assert.ok(redOf(result).includes('R1a@card'));
    // Control: returned before the Oct 6 read, every read already reflects it.
    const reflected = plan(history('2026-10-05'));
    assert.deepEqual(cycleOf(reflected, V9.C).predecessor, { kind: 'captured', resolved: true });
    assert.equal(cycleOf(reflected, V9.prevC).shown, false);
    assert.equal(reflected.delinquency, null);
  });

  it('a met-by-D phrase (d = Oct 20): voided by a payment posted d + 4, not d + 5; an Amex CSV row by its transaction date', () => {
    const C = '2026-10-02';
    const D = '2026-10-27';
    const metByDue = (kind: 'ofx' | 'csv', date: string) => cycleOf(plan({
      observations: [statement(C, { D, S: 5000, M: 5000, P: 0 }), dashboard(et('2026-10-20', 12), { C, D, phrase: 'paid' })],
      rows: [payment(kind, 'x', date)], asOf: et('2026-10-29', 12), returned: ['x'], reversalDates: { x: '2026-10-28' },
    }), C).answers.minimumMetByDue;
    for (const kind of ['ofx', 'csv'] as const) {
      assert.equal(metByDue(kind, '2026-10-24'), false, `${kind}: d + 4`);
      assert.equal(metByDue(kind, '2026-10-25'), true, `${kind}: d + 5`);
    }
  });

  it("the successor statement's P = 0 carried forward (d = C_k): voided by a payment posted d + 4, not d + 5", () => {
    const shown = (date: string) => cycleOf(plan({
      observations: [
        statement(V9.prevC, { D: V9.prevD, S: 5000, M: 5000 }),
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000, P: 0 }),
      ],
      rows: [ofxPayment('x', 5000, date)], asOf: V9.T, returned: ['x'], reversalDates: { x: '2026-10-20' },
    }), V9.prevC).shown;
    assert.equal(shown('2026-10-15'), true, 'd + 4');
    assert.equal(shown('2026-10-16'), false, 'd + 5');
  });

  it('a later P = 0 read (d = Oct 8): voided by a payment posted d + 4, not d + 5', () => {
    const shown = (date: string) => cycleOf(plan({
      observations: [
        statement(V9.prevC, { D: V9.prevD, S: 5000, M: 5000 }),
        dashboard(et('2026-10-08', 12), { C: V9.prevC, D: V9.prevD, P: 0 }),
        statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000 }),
      ],
      rows: [ofxPayment('x', 5000, date)], asOf: V9.T, returned: ['x'], reversalDates: { x: '2026-10-20' },
    }), V9.prevC).shown;
    assert.equal(shown('2026-10-12'), true, 'd + 4');
    assert.equal(shown('2026-10-13'), false, 'd + 5');
  });

  it('the R1a clearer (d = Oct 22): voided by a payment posted d + 4, not d + 5; an Amex CSV row by its transaction date', () => {
    const C = '2026-10-02';
    const D = '2026-10-27';
    const run = (kind: 'ofx' | 'csv', date: string) => plan({
      observations: [
        statement(C, { D, S: 5000, M: 5000, P: 0 }),
        dashboard(et('2026-10-20', 12), { C, D, P: 2500 }),
        dashboard(et('2026-10-22', 12), { C, D, P: 0 }),
      ],
      rows: [payment(kind, 'x', date)], asOf: et('2026-10-29', 12), returned: ['x'], reversalDates: { x: '2026-10-28' },
    });
    for (const kind of ['ofx', 'csv'] as const) {
      const voided = run(kind, '2026-10-26');
      assert.notEqual(voided.delinquency, null, `${kind}: d + 4`);
      assert.ok(redOf(voided).includes('R1a@card'), `${kind}: d + 4`);
      assert.equal(run(kind, '2026-10-27').delinquency, null, `${kind}: d + 5`);
    }
  });
});
