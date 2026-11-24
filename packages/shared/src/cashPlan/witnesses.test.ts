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
  lastPaymentRead,
  observation,
  ofxPayment,
  pendingPayment,
  plan,
  redOf,
  refund,
  rulesOf,
  statement,
  v9History,
  type History,
} from './__fixtures__/history.js';
import { economicCardPayments, matchIssuerReceipts, type IssuerReceiptFact } from './payments.js';
import { observationAsOf } from './engine.js';

/** Synthetic regressions for every reviewer witness (spec v9 §6). Cents only; never real data. */

const kRead = (asOf: string, d: string, minor = 5000) => lastPaymentRead(asOf, d, minor, { C: V9.C, D: V9.D });
const prevRead = (asOf: string, d: string, minor = 5000) => lastPaymentRead(asOf, d, minor, { C: V9.prevC, D: V9.prevD });
const X = () => ofxPayment('x', 5000, '2026-10-12');

describe('v9 regressions: 5b01e72f sealed v2.8 verdict 0b1a901f and Root\'s full-pipeline ruling', () => {
  it('witness A: releasing a collision under widening never creates a binding; X stays possible, A11', () => {
    const history = v9History({
      observations: [kRead(et('2026-10-13', 12), '2026-10-10'), prevRead(et('2026-10-08', 12), '2026-10-06')],
      rows: [X(), refund('y', 5000, et('2026-10-03', 12))],
    });
    for (const w of [0, 4]) {
      const result = plan(history, w);
      assert.deepEqual(result.bindings, [], `w=${w}`);
      const k = cycleOf(result, V9.C);
      assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed'], `w=${w}`);
      assert.deepEqual(k.ledger.proven, []);
      assert.ok(k.ledger.possible.includes('x'));
      assert.equal(k.answers.minimumMetSoFar, false);
      assert.deepEqual(redOf(result), []);
    }
  });

  it('witness B: a lost veto keeps X possible at w = 4 (A11, never assigned, never R2a); w = 0 binds, vetoes and gives R2a', () => {
    const history = v9History({ observations: [kRead(et('2026-10-13', 12), '2026-10-10')], rows: [X(), refund('y', 5000, et('2026-10-07', 12))] });
    const widened = plan(history);
    assert.deepEqual(widened.bindings, []);
    const k4 = cycleOf(widened, V9.C);
    assert.deepEqual(rulesOf(k4), ['A11:payment-unconfirmed']);
    assert.deepEqual(k4.ledger.proven, []);
    assert.ok(k4.ledger.possible.includes('x'));
    assert.equal(k4.answers.minimumMetSoFar, false);
    const sameDay = plan(history, 0);
    assert.deepEqual(sameDay.bindings.map((b) => [b.identityId, b.receivedOn]), [['x', '2026-10-10']]);
    const k0 = cycleOf(sameDay, V9.C);
    assert.deepEqual(rulesOf(k0), ['R2a:no-payment-seen']);
    assert.equal(k0.attention[0].copy, 'no payment seen since the 2026-10-11 statement, through 2026-11-03');
  });

  it('a genuine collision under both readings: both payments stay possible (A11); no fallback to the posted-date rule', () => {
    const history = v9History({ observations: [kRead(et('2026-10-13', 12), '2026-10-10')], rows: [ofxPayment('x1', 5000, '2026-10-12'), ofxPayment('x2', 5000, '2026-10-12')] });
    for (const w of [0, 4]) {
      const k = cycleOf(plan(history, w), V9.C);
      assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
      assert.deepEqual(k.ledger.proven, []);
      assert.deepEqual([...k.ledger.possible].sort(), ['x1', 'x2']);
    }
  });

  it('a bound identity keeps its own date: F_new binds X after the close and F_old does not disqualify it', () => {
    const fOld = prevRead(et('2026-10-06', 12), '2026-10-05');
    const fNew = kRead(et('2026-10-22', 12), '2026-10-20');
    const rows = [ofxPayment('x-old', 5000, '2026-10-07'), ofxPayment('x', 5000, '2026-10-21')];
    const result = plan(v9History({ observations: [fOld, fNew], rows }));
    assert.deepEqual(result.bindings.map((b) => [b.factId, b.identityId, b.receivedOn]), [[fNew.id, 'x', '2026-10-20']]);
    const k = cycleOf(result, V9.C);
    assert.deepEqual(k.ledger.proven, ['x']);
    assert.equal(k.answers.minimumMetSoFar, true);
    assert.ok(!rulesOf(k).some((rule) => rule.startsWith('A11')));
    assert.deepEqual(redOf(result), []);
    // Before F_new exists, F_old (unbound, dated before the close) disqualifies X: A11. The documented Phase B cost.
    const before = cycleOf(plan(v9History({ observations: [fOld], rows })), V9.C);
    assert.deepEqual(rulesOf(before), ['A11:payment-unconfirmed']);
    assert.ok(before.ledger.possible.includes('x'));
  });

  it('an unbound fact dated after the close never disqualifies for that cycle', () => {
    const history = v9History({ observations: [kRead(et('2026-10-22', 12), '2026-10-20')], rows: [ofxPayment('x1', 5000, '2026-10-21'), ofxPayment('x2', 5000, '2026-10-21')] });
    const result = plan(history);
    assert.deepEqual(result.bindings, []);
    const k = cycleOf(result, V9.C);
    assert.deepEqual([...k.ledger.proven].sort(), ['x1', 'x2']);
    assert.equal(k.answers.minimumMetSoFar, true);
  });

  it('a binding dated by D refines "received by D" only for a payment the posted-date rule placed', () => {
    const fact = kRead(et('2026-11-09', 8), '2026-11-05');
    const placed = plan({ ...v9History({ observations: [fact], rows: [ofxPayment('x', 5000, '2026-11-08')] }), asOf: et('2026-11-09', 12) });
    assert.deepEqual(placed.bindings.map((b) => b.receivedOn), ['2026-11-05']);
    const k = cycleOf(placed, V9.C);
    assert.equal(k.answers.minimumMetByDue, true);
    assert.deepEqual(rulesOf(k), ['A5']);
    // A source with no posting date can't be bound (no registry date), is never assigned, and stays possible: A11.
    const unplaced = plan({ ...v9History({ observations: [fact], rows: [csvPayment('x', 5000, '2026-11-08', et('2026-11-09', 6))] }), asOf: et('2026-11-09', 12) });
    assert.deepEqual(unplaced.bindings, []);
    const k2 = cycleOf(unplaced, V9.C);
    assert.equal(k2.answers.minimumMetByDue, false);
    assert.deepEqual(rulesOf(k2), ['A11:past-due-unconfirmed']);
  });
});

describe('v8 regressions: 5b01e72f sealed v2.7 verdict b48b0164 and Root\'s first-appearance ruling', () => {
  // The missing-transition-cycle witness: C_k = Oct 3, D_k = Oct 28; the captured Aug 20 cycle was paid; the Sep 3 cycle is missing.
  const aug20 = () => statement('2026-08-20', { D: '2026-09-14', S: 20000, M: 3000, P: 0 });
  const augPaid = () => ofxPayment('aug-pay', 3000, '2026-09-01');
  const late = () => ofxPayment('pay-12000', 12000, '2026-10-05');
  const T = et('2026-10-20', 12);

  it('finding 1: with an earlier cycle and no printed start, k−1 is unidentified: the payment is possible, A11; Aug 20 is never selected', () => {
    const result = plan({ observations: [aug20(), statement('2026-10-03', { D: '2026-10-28', S: 30000, M: 10000 })], rows: [augPaid(), late()], asOf: T });
    const k = cycleOf(result, '2026-10-03');
    assert.deepEqual(k.predecessor, { kind: 'unidentified', resolved: false });
    assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
    assert.deepEqual(k.ledger.proven, []);
    assert.ok(k.ledger.possible.includes('pay-12000'));
    assert.equal(k.answers.minimumMetSoFar, false);
  });

  it('finding 1 variants: printed start without the cycle (uncaptured; P > 0 so no exception), a captured cycle met in its window, a contradiction, a held cycle', () => {
    const uncaptured = cycleOf(plan({ observations: [aug20(), statement('2026-10-03', { start: '2026-09-04', D: '2026-10-28', S: 30000, M: 10000, P: 8000 })], rows: [augPaid(), late()], asOf: T }), '2026-10-03');
    assert.deepEqual(uncaptured.predecessor, { kind: 'uncaptured', resolved: false });
    assert.deepEqual(rulesOf(uncaptured), ['A11:payment-unconfirmed']);

    // Captured Sep 3 (its printed start proves continuity from Aug 20, which was not required), met in its own window.
    const chain = plan({
      observations: [
        statement('2026-08-20', { D: '2026-09-14', S: 0, M: 0, P: 0 }),
        statement('2026-09-03', { start: '2026-08-21', D: '2026-09-28', S: 20000, M: 20000 }),
        statement('2026-10-03', { start: '2026-09-04', D: '2026-10-28', S: 10000, M: 10000 }),
      ],
      rows: [ofxPayment('sep-pay', 20000, '2026-09-25'), ofxPayment('autopay', 10000, '2026-10-28')],
      asOf: et('2026-10-30', 12),
    });
    const k = cycleOf(chain, '2026-10-03');
    assert.deepEqual(k.predecessor, { kind: 'captured', resolved: true });
    assert.equal(k.answers.minimumMetByDue, true);
    assert.deepEqual(rulesOf(k), []);
    assert.equal(k.state, 'paid-in-full');

    const contradiction = plan({ observations: [aug20(), statement('2026-09-20', { D: '2026-10-15', M: 1000 }), statement('2026-10-03', { start: '2026-09-04', D: '2026-10-28', M: 10000 })], rows: [late()], asOf: T });
    const held = cycleOf(contradiction, '2026-10-03');
    assert.equal(held.status, 'held');
    assert.equal(held.heldReason, 'predecessor-contradiction');
    assert.deepEqual(rulesOf(held), ['A8']);

    const heldPrev = observation({ statementClosingDate: '2026-09-03', paymentDueDate: '2026-09-28', status: 'held', heldReason: 'minimum-basis', observedAt: et('2026-09-05', 8) });
    const atHeld = cycleOf(plan({ observations: [heldPrev, statement('2026-10-03', { start: '2026-09-04', D: '2026-10-28', M: 10000, P: 0 })], rows: [late()], asOf: T }), '2026-10-03');
    assert.deepEqual(atHeld.predecessor, { kind: 'held', resolved: false });
    assert.deepEqual(rulesOf(atHeld), ['A11:payment-unconfirmed']);
  });

  it('finding 1 variants: the first captured cycle resolves only by its own P = 0 (Root\'s exception); an earlier cycle makes it unidentified; a due date in [C_k, D_k) blocks', () => {
    const first = (extra: History['observations'] = []) => plan({
      observations: [statement('2026-10-03', { D: '2026-10-28', S: 10000, M: 10000, P: 0 }), ...extra],
      rows: [ofxPayment('autopay', 10000, '2026-10-28')],
      asOf: et('2026-10-30', 12),
    });
    const resolved = cycleOf(first(), '2026-10-03');
    assert.deepEqual(resolved.predecessor, { kind: 'uncaptured', resolved: true });
    assert.equal(resolved.answers.minimumMetByDue, true);
    assert.deepEqual(rulesOf(resolved), []);

    const withEarlier = cycleOf(first([statement('2026-09-03', { D: '2026-09-28', S: 0, M: 0, P: 0 })]), '2026-10-03');
    assert.deepEqual(withEarlier.predecessor, { kind: 'unidentified', resolved: false });
    assert.deepEqual(rulesOf(withEarlier), ['A11:past-due-unconfirmed']);

    const blocked = cycleOf(first([dashboard(et('2026-10-01', 12), { D: '2026-10-10' })]), '2026-10-03');
    assert.deepEqual(blocked.predecessor, { kind: 'uncaptured', resolved: false });
    assert.deepEqual(rulesOf(blocked), ['A11:past-due-unconfirmed']);
  });

  it('veto precedence: a bound receipt on or before C_k vetoes the payment for k (never in A or U), whatever its posting date', () => {
    const base = (prevPaid: boolean): History => ({
      observations: [
        statement('2026-09-01', { D: '2026-09-26', S: 12000, M: 12000, P: 0 }),
        statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 5000, M: 5000 }),
        lastPaymentRead(et('2026-10-05', 12), '2026-09-30', 12000, { C: '2026-10-01', D: '2026-10-26' }),
      ],
      rows: [ofxPayment('x', 12000, '2026-10-03'), ...(prevPaid ? [ofxPayment('y', 12000, '2026-09-20')] : [])],
      asOf: et('2026-10-24', 12),
    });
    const paid = plan(base(true));
    assert.deepEqual(paid.bindings.map((b) => [b.identityId, b.receivedOn]), [['x', '2026-09-30']]);
    const k = cycleOf(paid, '2026-10-01');
    assert.ok(!k.ledger.proven.includes('x') && !k.ledger.possible.includes('x'));
    assert.deepEqual(rulesOf(k), ['R2a:no-payment-seen']);
    assert.equal(k.attention[0].copy, 'no payment seen since the 2026-10-01 statement, through 2026-10-24');
    // It counts in U for k−1: when k−1 relied on it, k−1 shows A11.
    const relied = plan(base(false));
    const prev = cycleOf(relied, '2026-09-01');
    assert.ok(prev.ledger.possible.includes('x'));
    assert.deepEqual(rulesOf(prev), ['A11:past-due-unconfirmed']);
    assert.equal(prev.shown, true);
  });

  it('a registry posting date on or before C_k vetoes the payment for k', () => {
    const k = cycleOf(plan(v9History({ rows: [ofxPayment('x', 5000, V9.C)] })), V9.C);
    assert.ok(!k.ledger.proven.includes('x') && !k.ledger.possible.includes('x'));
    assert.deepEqual(rulesOf(k), ['R2a:no-payment-seen']);
  });

  it('witness A (cut-off): a covering pending payment first seen at 21:00 ET on D is A1c "made by the due date", never met by D', () => {
    const history: History = {
      observations: [statement('2026-10-02', { D: '2026-10-27', S: 5000, M: 5000, P: 0 })],
      rows: [pendingPayment('p', 5000, et('2026-10-27', 21))],
      asOf: et('2026-10-28', 9),
    };
    const k = cycleOf(plan(history), '2026-10-02');
    assert.deepEqual(rulesOf(k), ['A1c']);
    assert.equal(k.attention[0].copy, 'a payment made by the due date is waiting to post');
    assert.equal(k.answers.minimumMetByDue, false);
    assert.equal(k.answers.awaitingPosting, true);
  });

  it('witness A on a close: first seen on the evening of C_k, its bound is C_k + 4, so it is not vetoed and stays possible for k: never R2a', () => {
    const history: History = {
      observations: [
        statement('2026-09-30', { D: '2026-10-27', S: 5000, M: 5000, P: 0 }),
        statement('2026-10-27', { start: '2026-10-01', D: '2026-10-30', S: 5000, M: 5000, seenAt: et('2026-10-27', 23) }),
      ],
      rows: [pendingPayment('p', 5000, et('2026-10-27', 21))],
      asOf: et('2026-10-28', 9),
    };
    const result = plan(history);
    const k = cycleOf(result, '2026-10-27');
    assert.ok(k.ledger.possible.includes('p'));
    assert.ok(!rulesOf(k).some((rule) => rule.startsWith('R2a')));
    assert.deepEqual(redOf(result), []);
    // First seen on C_k − 5 (+ 4 = C_k − 1): vetoed for k.
    const early = plan({ ...history, rows: [csvPayment('q', 5000, '2026-10-22', et('2026-10-22', 12))] });
    const k2 = cycleOf(early, '2026-10-27');
    assert.ok(!k2.ledger.possible.includes('q') && !k2.ledger.proven.includes('q'));
  });

  const julyGraph = (variant: 'registry' | 'first-appearance' | 'replacement-alone') => {
    const original = variant === 'registry'
      ? [cardRow({ id: 'orig-pending', status: 'removed', removedReason: 'superseded', removedFromStatus: 'pending', mergedIntoId: 'orig', source: 'chase-api', transactionDate: '2026-07-02', createdAt: et('2026-07-02', 21) }),
        ofxPayment('orig', 5000, '2026-07-06', { createdAt: et('2026-07-07', 6) })]
      : variant === 'first-appearance' ? [csvPayment('orig', 5000, '2026-07-02', et('2026-07-02', 21))] : [];
    const replacement = [
      cardRow({ id: 'repl-pending', status: 'removed', removedReason: 'superseded', removedFromStatus: 'pending', mergedIntoId: 'repl', source: 'chase-api', transactionDate: '2026-07-06', createdAt: et('2026-07-06', 21) }),
      ofxPayment('repl', 5000, '2026-07-08', { createdAt: et('2026-07-09', 6) }),
    ];
    return {
      observations: [
        statement('2026-06-20', { D: '2026-07-06', S: 5000, M: 5000, P: 0 }),
        lastPaymentRead(et('2026-07-06', 22), '2026-07-06', 5000, { C: '2026-06-20', D: '2026-07-06' }),
      ],
      rows: [...original, ...replacement],
      asOf: et('2026-07-09', 12),
      returned: variant === 'replacement-alone' ? [] : ['orig'],
    } satisfies History;
  };

  it('witness B (July graph): the late replacement never borrows the issuer\'s July 6 (both variants, and the replacement alone)', () => {
    for (const variant of ['registry', 'first-appearance', 'replacement-alone'] as const) {
      const history = julyGraph(variant);
      const result = plan(history);
      assert.deepEqual(result.bindings, [], variant);
      const k = cycleOf(result, '2026-06-20');
      assert.equal(k.answers.minimumMetByDue, false, variant);
      assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed'], variant);
    }
    // The graph itself: the original keeps its edge (registry July 6, or July 2 + 4) and the fact has two candidates.
    for (const variant of ['registry', 'first-appearance'] as const) {
      const history = julyGraph(variant);
      const identities = economicCardPayments(history.rows, CARD, { returnedPaymentIds: new Set(history.returned) });
      const fact = history.observations[1];
      const facts: IssuerReceiptFact[] = [{ id: fact.id, date: '2026-07-06', minor: 5000, asOf: observationAsOf(fact), sourceKind: fact.sourceKind }];
      const match = matchIssuerReceipts(facts, identities, FULL_COVERAGE, 4);
      assert.deepEqual(match.unbound.map((item) => [...item.candidates].sort()), [['orig', 'repl']], variant);
    }
  });

  it('a scheduled (future-dated) pending row has no bound: possible in every window, never a veto, never A1c, never in flight', () => {
    const scheduled = pendingPayment('s', 5000, et('2026-10-14', 12), { txn: '2026-11-05' });
    const result = plan(v9History({ rows: [scheduled] }));
    const k = cycleOf(result, V9.C);
    assert.ok(k.ledger.possible.includes('s'));
    assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
    assert.equal(k.answers.awaitingPosting, false);
    assert.equal(k.answers.inFlight, false);
    // It is still a candidate for any fact of its cents.
    const identities = economicCardPayments([scheduled], CARD);
    assert.equal(identities[0].firstAppearance, null);
  });

  it('with a registry posting date the first appearance is ignored; a pending row seen by C_k disqualifies through its transaction date', () => {
    const rows = [
      cardRow({ id: 'x-pending', status: 'removed', removedReason: 'settled-into', removedFromStatus: 'pending', mergedIntoId: 'x', source: 'chase-api', transactionDate: '2026-10-10', createdAt: et('2026-10-10', 15) }),
      ofxPayment('x', 5000, '2026-10-13', { txn: '2026-10-13' }),
    ];
    const k = cycleOf(plan(v9History({ rows })), V9.C);
    assert.ok(k.ledger.possible.includes('x'));
    assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
  });

  it('a first appearance never satisfies "received by the read": a first-appearance-only payment is never bound, never A, never met by D', () => {
    const result = plan(v9History({ observations: [kRead(et('2026-10-20', 12), '2026-10-13')], rows: [csvPayment('x', 5000, '2026-10-13', et('2026-10-13', 20))] }));
    assert.deepEqual(result.bindings, []);
    const k = cycleOf(result, V9.C);
    assert.deepEqual(k.ledger.proven, []);
    assert.ok(k.ledger.possible.includes('x'));
  });

  it('A1c never says received, never pays and never clears R1a', () => {
    const history: History = {
      observations: [
        statement('2026-10-02', { D: '2026-10-27', S: 5000, M: 5000, P: 0 }),
        dashboard(et('2026-10-26', 10), { C: '2026-10-02', D: '2026-10-27', P: 3000 }),
      ],
      rows: [pendingPayment('p', 5000, et('2026-10-27', 9))],
      asOf: et('2026-10-28', 9),
    };
    const result = plan(history);
    assert.deepEqual(rulesOf(cycleOf(result, '2026-10-02')), ['A1c']);
    assert.ok(redOf(result).includes('R1a@card'));
    assert.ok(!/received|paid/i.test(cycleOf(result, '2026-10-02').attention[0].copy.replace('made by the due date', '')));
  });
});

describe('v7 regressions: 5b01e72f sealed v2.6 verdict c90c8b21 (findings 1–4) and Root\'s 14:05 ET exception', () => {
  const cycle = () => statement('2026-10-02', { D: '2026-10-27', S: 5000, M: 5000, P: 0 });
  const fact = (asOf: string, d: string, minor = 5000) => lastPaymentRead(asOf, d, minor, { C: '2026-10-02', D: '2026-10-27' });

  it('the returned-original witness: the replacement never borrows the returned original\'s date (held), A11 never met', () => {
    const history: History = {
      observations: [cycle(), fact(et('2026-10-29', 22), '2026-10-27')],
      rows: [ofxPayment('a', 5000, '2026-10-27'), ofxPayment('b', 5000, '2026-10-29')],
      returned: ['a'],
      asOf: et('2026-10-30', 12),
    };
    const result = plan(history);
    assert.deepEqual(result.bindings, []);
    const k = cycleOf(result, '2026-10-02');
    assert.equal(k.answers.minimumMetByDue, false);
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
  });

  it('identity graph: a merged pending→posted pair is one identity and binds; a cancelled same-cents pending stays a candidate', () => {
    const merged = [
      cardRow({ id: 'x-p', status: 'removed', removedReason: 'superseded', removedFromStatus: 'pending', mergedIntoId: 'x', source: 'chase-api', transactionDate: '2026-10-20', createdAt: et('2026-10-20', 9) }),
      ofxPayment('x', 5000, '2026-10-22', { txn: '2026-10-22' }),
    ];
    const bound = plan({ observations: [cycle(), fact(et('2026-10-23', 12), '2026-10-21')], rows: merged, asOf: et('2026-10-24', 12) });
    assert.deepEqual(bound.bindings.map((b) => b.identityId), ['x']);
    const cancelled = cardRow({ id: 'c', status: 'removed', removedReason: 'cancelled', removedFromStatus: 'pending', source: 'chase-api', transactionDate: '2026-10-20', createdAt: et('2026-10-20', 9) });
    const held = plan({ observations: [cycle(), fact(et('2026-10-23', 12), '2026-10-21')], rows: [ofxPayment('x', 5000, '2026-10-22'), cancelled], asOf: et('2026-10-24', 12) });
    assert.deepEqual(held.bindings, []);
  });

  it('identity graph: two facts with the same sole candidate are both held; late or early bounds; a non-payment credit\'s first appearance; a coverage gap', () => {
    const rows = [ofxPayment('x', 5000, '2026-10-22')];
    const twoFacts = plan({ observations: [cycle(), fact(et('2026-10-23', 12), '2026-10-21'), fact(et('2026-10-23', 13), '2026-10-20')], rows, asOf: et('2026-10-24', 12) });
    assert.deepEqual(twoFacts.bindings, []);
    const tooEarlyRead = plan({ observations: [cycle(), fact(et('2026-10-22', 12), '2026-10-21')], rows, asOf: et('2026-10-24', 12) });
    assert.deepEqual(tooEarlyRead.bindings, [], 'X posts after the read: not received by the read');
    const identities = economicCardPayments(rows, CARD);
    const f = fact(et('2026-10-24', 12), '2026-10-23');
    const noEdge = matchIssuerReceipts([{ id: f.id, date: '2026-10-23', minor: 5000, asOf: observationAsOf(f), sourceKind: f.sourceKind }], identities, FULL_COVERAGE);
    assert.deepEqual(noEdge.unbound.map((item) => item.candidates), [[]], 'X posted before d: no edge');
    // A refund from a registry source posted before d, first seen on/after d: its bound is its first appearance, so it is a candidate.
    const credit = cardRow({ id: 'r', kind: 'refund', description: 'REFUND', amountMinor: -5000, postedDate: '2026-10-15', transactionDate: '2026-10-15', createdAt: et('2026-10-21', 9) });
    const withCredit = plan({ observations: [cycle(), fact(et('2026-10-23', 12), '2026-10-21')], rows: [...rows, credit], asOf: et('2026-10-24', 12) });
    assert.deepEqual(withCredit.bindings, []);
    const gapped = plan({ observations: [cycle(), fact(et('2026-10-23', 12), '2026-10-21')], rows, asOf: et('2026-10-24', 12),
      coverage: [{ start: '2026-01-01', end: '2026-10-21' }, { start: '2026-10-23', end: '2026-12-31' }] });
    assert.deepEqual(gapped.bindings, []);
  });

  it('a bound payment later returned keeps its binding, leaves counting, and the deadline answer re-derives', () => {
    const history: History = {
      observations: [cycle(), fact(et('2026-10-23', 12), '2026-10-21')],
      rows: [ofxPayment('x', 5000, '2026-10-22')],
      asOf: et('2026-10-30', 12),
    };
    const before = plan(history);
    assert.equal(cycleOf(before, '2026-10-02').answers.minimumMetByDue, true);
    const after = plan({ ...history, returned: ['x'] });
    assert.deepEqual(after.bindings.map((b) => b.identityId), ['x']);
    const k = cycleOf(after, '2026-10-02');
    assert.equal(k.answers.minimumMetByDue, false);
    assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed']);
  });

  it('the output is a pure function of what is known: shuffling observations and rows changes nothing', () => {
    const history = v9History({
      observations: [kRead(et('2026-10-13', 12), '2026-10-10'), prevRead(et('2026-10-08', 12), '2026-10-06'), dashboard(et('2026-11-02', 9), { C: V9.C, D: V9.D, R: 20000 })],
      rows: [X(), refund('y', 5000, et('2026-10-03', 12)), ofxPayment('z', 2500, '2026-10-20'), pendingPayment('p', 1000, et('2026-11-01', 9))],
    });
    const expected = JSON.stringify(plan(history));
    for (let seed = 1; seed <= 5; seed++) {
      const shuffle = <T>(list: T[]) => list.map((value, i) => ({ value, key: (i * 7919 + seed * 104729) % 97 })).sort((a, b) => a.key - b.key).map((item) => item.value);
      assert.equal(JSON.stringify(plan({ ...history, observations: shuffle(history.observations), rows: shuffle(history.rows) })), expected);
    }
  });

  it('finding 2, the aggregate guard (M = 5000)', () => {
    const near = (rows: History['rows'], extra: Partial<History> = {}) => cycleOf(plan({ ...v9History({ rows }), ...extra }), V9.C);
    // Two uncertain-window payments of 2500 (dated before the close by DTUSER): A11, never R2a.
    assert.deepEqual(rulesOf(near([ofxPayment('a', 2500, '2026-10-13', { txn: '2026-10-10' }), ofxPayment('b', 2500, '2026-10-14', { txn: '2026-10-09' })])), ['A11:payment-unconfirmed']);
    // A proven 2500 plus an uncertain 2500: A11.
    assert.deepEqual(rulesOf(near([ofxPayment('a', 2500, '2026-10-13'), ofxPayment('b', 2500, '2026-10-14', { txn: '2026-10-09' })])), ['A11:payment-unconfirmed']);
    // A pending 2500 settled into its posted 2500 is one identity: A + U = 2500, R2a "payments seen don't cover".
    const settled = near([
      cardRow({ id: 'a-p', status: 'removed', removedReason: 'settled-into', removedFromStatus: 'pending', mergedIntoId: 'a', source: 'chase-api', amountMinor: -2500, transactionDate: '2026-10-12', createdAt: et('2026-10-12', 9) }),
      ofxPayment('a', 2500, '2026-10-13'),
    ]);
    assert.deepEqual(rulesOf(settled), ['R2a:payments-dont-cover']);
    assert.equal(settled.attention[0].copy, "payments seen through 2026-11-03 don't cover the minimum");
    // A genuinely insufficient partial, nothing possible: R2a "payments seen don't cover", never "no payment seen".
    assert.deepEqual(rulesOf(near([ofxPayment('a', 2500, '2026-10-13')])), ['R2a:payments-dont-cover']);
    // Nothing at all: R2a "no payment seen".
    assert.deepEqual(rulesOf(near([])), ['R2a:no-payment-seen']);
    // Proven-met precedence: a proven 5000 plus uncertain rows is met.
    const met = near([ofxPayment('a', 5000, '2026-10-13'), ofxPayment('b', 2500, '2026-10-14', { txn: '2026-10-09' })]);
    assert.equal(met.answers.minimumMetSoFar, true);
    assert.ok(!rulesOf(met).some((rule) => rule.startsWith('A11') || rule.startsWith('R2a')));
    // Removed rows are never possible.
    const removed = near([cardRow({ id: 'c', status: 'removed', removedReason: 'cancelled', removedFromStatus: 'pending', source: 'chase-api', transactionDate: '2026-10-20', createdAt: et('2026-10-20', 9) })]);
    assert.deepEqual(removed.ledger.possible, []);
    assert.deepEqual(rulesOf(removed), ['R2a:no-payment-seen']);
  });

  it('finding 2: one payment can be possible in two cycles; each cycle whose A + U reaches M gives A11', () => {
    const history: History = {
      observations: [
        statement('2026-10-01', { D: '2026-11-05', S: 5000, M: 5000, P: 0 }),
        statement('2026-10-31', { start: '2026-10-02', D: '2026-11-25', S: 5000, M: 5000 }),
      ],
      rows: [ofxPayment('u', 5000, '2026-11-01')],
      uncertain: ['u'],
      asOf: et('2026-11-03', 12),
    };
    const result = plan(history);
    for (const C of ['2026-10-01', '2026-10-31']) {
      const k = cycleOf(result, C);
      assert.ok(k.ledger.possible.includes('u'), C);
      assert.ok(rulesOf(k).includes('A11:payment-unconfirmed'), C);
    }
  });

  it('finding 3, the historical guard: the X1/X2 witness with a total M; a later P = 0 clears R1a and k−1\'s display but never the guard', () => {
    const history: History = {
      observations: [
        statement('2026-09-01', { D: '2026-09-27', S: 20000, M: 20000, P: 0 }),
        statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 30000, M: 10000, P: 8000 }),
        dashboard(et('2026-10-24', 9), { C: '2026-10-01', D: '2026-10-26', P: 0 }),
      ],
      rows: [ofxPayment('x1', 12000, '2026-10-03'), ofxPayment('x2', 8000, '2026-10-05')],
      asOf: et('2026-10-24', 12),
    };
    const result = plan(history);
    const k = cycleOf(result, '2026-10-01');
    assert.deepEqual(k.predecessor, { kind: 'captured', resolved: false });
    assert.deepEqual(rulesOf(k), ['A11:payment-unconfirmed']);
    assert.equal(k.answers.minimumMetSoFar, false);
    assert.equal(result.delinquency, null);
    assert.equal(cycleOf(result, '2026-09-01').shown, false);
  });

  it('finding 3: what resolves k−1 at C_k (P = 0 after D_{k−1}, statement k\'s own P = 0, a chain) and what never does', () => {
    const run = (prev: Parameters<typeof statement>[1], extra: History['observations'], prevRows: History['rows'] = []) => cycleOf(plan({
      observations: [statement('2026-09-01', prev), statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 10000, M: 10000 }), ...extra],
      rows: [...prevRows, ofxPayment('autopay', 10000, '2026-10-26')],
      asOf: et('2026-10-28', 12),
    }), '2026-10-01');
    const prev = { D: '2026-09-27', S: 20000, M: 20000 };
    assert.equal(run(prev, [dashboard(et('2026-09-29', 12), { C: '2026-09-01', D: '2026-09-27', P: 0 })]).answers.minimumMetByDue, true);
    assert.equal(run(prev, [statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 10000, M: 10000, P: 0 })]).answers.minimumMetByDue, true);
    assert.equal(run({ ...prev, P: 0 }, [], [ofxPayment('prev-pay', 20000, '2026-09-20')]).answers.minimumMetByDue, true, 'a chain (k−1 bootstrapped by its own P = 0, then met in its own window)');
    assert.equal(run(prev, [], [ofxPayment('prev-pay', 20000, '2026-09-20')]).predecessor?.resolved, false, 'k−1 itself unresolved: its payment never assigned');
    // Never: P = 0 before the end of D_{k−1}; P = 0 after C_k; a known D_{k−1} ≥ C_k; a due date stated in [C_k, D_k); a captured k−1 with no D.
    const never = [
      run(prev, [dashboard(et('2026-09-26', 12), { C: '2026-09-01', D: '2026-09-27', P: 0 })]),
      run(prev, [dashboard(et('2026-10-02', 12), { C: '2026-10-01', D: '2026-10-26', P: 0 })]),
      run({ D: '2026-10-05', S: 20000, M: 20000 }, [statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 10000, M: 10000, P: 0 })]),
      run(prev, [statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 10000, M: 10000, P: 0 }), dashboard(et('2026-09-30', 12), { D: '2026-10-05' })]),
      run({ S: 20000, M: 20000 }, [statement('2026-10-01', { start: '2026-09-02', D: '2026-10-26', S: 10000, M: 10000, P: 0 })]),
    ];
    for (const [i, k] of never.entries()) {
      assert.equal(k.predecessor?.resolved, false, `case ${i}`);
      assert.deepEqual(rulesOf(k), ['A11:past-due-unconfirmed'], `case ${i}`);
    }
  });

  it('Root\'s bounded exception (14:05 ET) and its grace disqualifier', () => {
    const first = (k: Parameters<typeof statement>[1], extra: History['observations'] = []) => cycleOf(plan({
      observations: [statement('2026-10-03', k), ...extra],
      rows: [ofxPayment('autopay', 10000, '2026-10-28')],
      asOf: et('2026-10-30', 12),
    }), '2026-10-03');
    const base = { D: '2026-10-28', S: 10000, M: 10000 };
    assert.equal(first({ ...base, P: 0 }).answers.minimumMetByDue, true, 'statement k\'s own P = 0');
    assert.equal(first(base, [dashboard(et('2026-10-03', 20), { C: '2026-10-03', D: '2026-10-28', P: 0, asOfDate: '2026-10-03' })]).answers.minimumMetByDue, true, 'explicit as-of C_k');
    assert.equal(first(base, [dashboard(et('2026-10-03', 20), { C: '2026-10-03', D: '2026-10-28', P: 0, implicit: true })]).answers.minimumMetByDue, false, 'implicit-capture');
    assert.equal(first(base, [dashboard(et('2026-10-04', 9), { C: '2026-10-03', D: '2026-10-28', P: 0 })]).answers.minimumMetByDue, false, 'explicit, not C_k');
    // Grace: D − C = 25. A printed start with C − S = 25 (equality) or less withholds the exception card-wide.
    assert.equal(first({ ...base, P: 0, start: '2026-09-08' }).answers.minimumMetByDue, false, 'D − C = C − S');
    assert.equal(first({ ...base, P: 0, start: '2026-09-10' }).answers.minimumMetByDue, false, 'D − C > C − S');
    assert.equal(first({ ...base, P: 0, start: '2026-09-04' }).answers.minimumMetByDue, true, 'D − C < C − S');
    // S is never derived from C_{k−1}: without a printed start, an earlier cycle makes k−1 unidentified.
    const derived = cycleOf(plan({
      observations: [statement('2026-09-03', { D: '2026-09-28', S: 0, M: 0, P: 0 }), statement('2026-10-03', { ...base, P: 0 })],
      rows: [ofxPayment('autopay', 10000, '2026-10-28')],
      asOf: et('2026-10-30', 12),
    }), '2026-10-03');
    assert.deepEqual(derived.predecessor, { kind: 'unidentified', resolved: false });
  });

  it('finding 4, the total M: a post-close payment of the current part never meets a total M; no minimum means A2, never R2a', () => {
    const total = cycleOf(plan({ ...v9History({ rows: [ofxPayment('a', 5000, '2026-10-13')] }),
      observations: [statement(V9.prevC, { D: V9.prevD, S: 0, M: 0, P: 0 }), statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 10000, P: 5000 })] }), V9.C);
    assert.equal(total.answers.minimumMetSoFar, false);
    assert.deepEqual(rulesOf(total), ['R2a:payments-dont-cover']);
    const noMinimum = cycleOf(plan({ ...v9History({}), observations: [statement(V9.prevC, { D: V9.prevD, S: 0, M: 0, P: 0 }), statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, P: 0 })] }), V9.C);
    assert.deepEqual(rulesOf(noMinimum), ['A2']);
    assert.equal(noMinimum.answers.minimumMetSoFar, null);
  });

  it('registry scope: a non-payment row from a registry source is never source-proven; its bound is its first appearance', () => {
    const credit = cardRow({ id: 'r', kind: 'refund', description: 'REFUND', amountMinor: -5000, postedDate: '2026-10-15', transactionDate: '2026-10-15', createdAt: et('2026-10-16', 9) });
    const [identity] = economicCardPayments([credit], CARD);
    assert.equal(identity.isPayment, false);
    assert.equal(identity.registryPostedOn, null);
    assert.equal(identity.firstAppearance, '2026-10-16');
    assert.equal(identity.counting, null);
  });
});
