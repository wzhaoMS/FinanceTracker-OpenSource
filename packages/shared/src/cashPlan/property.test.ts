import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from './dates.js';
import { CURE_POSTING_DAYS, observationAsOf, type CardPlan, type CashPlanCycle } from './engine.js';
import type { CardScheduleObservation } from './observations.js';
import { economicCardPayments } from './payments.js';
import {
  CARD,
  V9,
  et,
  lastPaymentRead,
  ofxPayment,
  plan,
  refund,
  v9History,
  type History,
} from './__fixtures__/history.js';
import { randomHistory } from './__fixtures__/random.js';

/**
 * The relative gate (Root's full-pipeline ruling; spec v9 §6). The whole engine runs over random synthetic histories at
 * every first-appearance offset w in {0, 1, 2, 3, 4}; for every pair w1 < w2, per card and cycle:
 * - bindings(w2) ⊆ bindings(w1), as identical (fact, identity, date, provenance) tuples;
 * - A(w2) ⊆ A(w1), and A(w2) ∪ U(w2) ⊇ A(w1) ∪ U(w1), as identity sets;
 * - every red item at w2 is red at w1, and every neutral cycle at w2 is neutral at w1.
 * Widening may only move outcomes toward amber, never create red or a binding (gained bindings and lost vetoes alike).
 * CASH_PLAN_PROPERTY_HISTORIES raises the history count (default 1500).
 */

const OFFSETS = [0, 1, 2, 3, 4];

const bindingKey = (b: CardPlan['bindings'][number]) => JSON.stringify([b.factId, b.identityId, b.receivedOn, b.financialAsOf, b.sourceKind]);
const redKeys = (result: CardPlan) => new Set(result.attention.filter((item) => item.severity === 'red')
  .map((item) => `${item.rule}|${item.subject}|${item.closingDate}|${item.dueDate}`));

/** Checks the relative property for one history; returns how many (pair, cycle) outcomes differ between the offsets. */
function checkMonotone(history: History, label: string): number {
  const results = OFFSETS.map((w) => plan(history, w));
  let changed = 0;
  for (let i = 0; i < OFFSETS.length; i++) {
    for (let j = i + 1; j < OFFSETS.length; j++) {
      const narrow = results[i], wide = results[j];
      const where = `${label} w1=${OFFSETS[i]} w2=${OFFSETS[j]}`;
      const narrowBindings = new Set(narrow.bindings.map(bindingKey));
      for (const binding of wide.bindings) assert.ok(narrowBindings.has(bindingKey(binding)), `${where}: binding gained under widening`);
      const narrowRed = redKeys(narrow);
      for (const key of redKeys(wide)) assert.ok(narrowRed.has(key), `${where}: red ${key} created by widening`);
      for (const wideCycle of wide.cycles) {
        const narrowCycle = narrow.cycles.find((cycle) => cycle.closingDate === wideCycle.closingDate);
        assert.ok(narrowCycle, `${where}: cycle set changed`);
        const cycleWhere = `${where} C=${wideCycle.closingDate}`;
        const narrowProven = new Set(narrowCycle.ledger.proven);
        for (const id of wideCycle.ledger.proven) assert.ok(narrowProven.has(id), `${cycleWhere}: A grew under widening (${id})`);
        const wideAll = new Set([...wideCycle.ledger.proven, ...wideCycle.ledger.possible]);
        for (const id of [...narrowCycle.ledger.proven, ...narrowCycle.ledger.possible]) assert.ok(wideAll.has(id), `${cycleWhere}: A ∪ U shrank under widening (${id})`);
        if (wideCycle.attention.length === 0) assert.deepEqual(narrowCycle.attention, [], `${cycleWhere}: neutral only under widening`);
        if (JSON.stringify(wideCycle.attention) !== JSON.stringify(narrowCycle.attention)) changed++;
      }
    }
  }
  return changed;
}

describe('the full-pipeline relative property (the gate)', () => {
  it('holds for the reviewer witnesses as seeds: witness A, witness B, the genuine collision and the bound identity', () => {
    const kRead = (asOf: string, d: string) => lastPaymentRead(asOf, d, 5000, { C: V9.C, D: V9.D });
    const prevRead = (asOf: string, d: string) => lastPaymentRead(asOf, d, 5000, { C: V9.prevC, D: V9.prevD });
    const seeds: Record<string, History> = {
      'witness A': v9History({ observations: [kRead(et('2026-10-13', 12), '2026-10-10'), prevRead(et('2026-10-08', 12), '2026-10-06')],
        rows: [ofxPayment('x', 5000, '2026-10-12'), refund('y', 5000, et('2026-10-03', 12))] }),
      'witness B': v9History({ observations: [kRead(et('2026-10-13', 12), '2026-10-10')], rows: [ofxPayment('x', 5000, '2026-10-12'), refund('y', 5000, et('2026-10-07', 12))] }),
      collision: v9History({ observations: [kRead(et('2026-10-13', 12), '2026-10-10')], rows: [ofxPayment('x1', 5000, '2026-10-12'), ofxPayment('x2', 5000, '2026-10-12')] }),
      'bound identity': v9History({ observations: [prevRead(et('2026-10-06', 12), '2026-10-05'), kRead(et('2026-10-22', 12), '2026-10-20')],
        rows: [ofxPayment('x-old', 5000, '2026-10-07'), ofxPayment('x', 5000, '2026-10-21')] }),
    };
    let changed = 0;
    for (const [label, history] of Object.entries(seeds)) changed += checkMonotone(history, label);
    // Witness B changes outcome (R2a at w = 0, A11 at w ≥ 1): the gate is not vacuous on its own seeds.
    assert.ok(changed > 0);
  });

  it('holds over random synthetic histories for every offset pair in {0, 1, 2, 3, 4}', () => {
    const histories = Number(process.env.CASH_PLAN_PROPERTY_HISTORIES ?? 1500);
    let changed = 0;
    for (let seed = 1; seed <= histories; seed++) changed += checkMonotone(randomHistory(seed), `seed ${seed}`);
    // Widening must actually move outcomes in some histories, or the property proves nothing.
    assert.ok(changed > 0, 'no history changed outcome under widening');
  });

  it('an unknown is never 0 and never red: a cycle without a minimum or due date has no ledger-absence claim', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const result = plan(randomHistory(seed));
      for (const cycle of result.cycles) {
        if (cycle.minimumDueMinor === null || cycle.dueDate === null) {
          assert.ok(!cycle.attention.some((item) => item.rule === 'R2a' || item.rule === 'R1b'), `seed ${seed}`);
          if (cycle.minimumDueMinor === null && cycle.state !== 'not-required' && cycle.state !== 'held') {
            assert.notEqual(cycle.answers.minimumMetSoFar, false, `seed ${seed}: an unknown minimum read as unmet`);
          }
        }
      }
    }
  });

  it('ledger-absence claims (R2a) never occur without coverage over (C, E_c] with E_c ≥ T − 2; R1b never occurs in A1', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const history = randomHistory(seed);
      const result = plan(history);
      for (const cycle of result.cycles) {
        for (const item of cycle.attention) {
          assert.notEqual(item.rule, 'R1b', `seed ${seed}`);
          if (item.rule === 'R2a') assert.ok(cycle.coverageThrough !== null && cycle.coverageThrough >= addDays(result.today, -2), `seed ${seed}`);
        }
      }
    }
  });
});

/**
 * Root's ruling (a) of 2026-11-08: a returned payment can underlie only reassurances dated d with its posting date (or,
 * with none, its earliest transaction date) ≤ d + 4, and voids only those dated on or before its return: its relevance
 * window. Each returned or possibly reversed payment is compared against the same history with that return dated before
 * every fact (it voids nothing). A closed cycle none of whose evidence is dated in the window keeps its state, retention,
 * deadline answer and guard; the card's delinquency is unchanged when no P = 0 read is dated in the window.
 */
describe("Root's ruling (a): one return never flips cycles outside its relevance window", () => {
  it('holds over random synthetic histories', () => {
    const dateOf = (o: CardScheduleObservation) => observationAsOf(o).date;
    const key = (cycle: CashPlanCycle) => JSON.stringify([cycle.state, cycle.shown, cycle.answers.minimumMetByDue, cycle.predecessor]);
    let outside = 0;
    let flipped = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const history = randomHistory(seed);
      const reversed = [...(history.returned ?? []), ...(history.uncertain ?? [])];
      if (reversed.length === 0) continue;
      const identities = economicCardPayments(history.rows, CARD, {
        returnedPaymentIds: new Set(history.returned), uncertainPaymentIds: new Set(history.uncertain),
        reversalDates: new Map(Object.entries(history.reversalDates ?? {})),
      });
      const live = plan(history);
      const closings = live.cycles.map((cycle) => cycle.closingDate).sort();
      for (const id of reversed) {
        const identity = identities.find((item) => item.rowIds.includes(id));
        if (identity === undefined || identity.undo === null) continue;
        const from = addDays(identity.registryPostedOn ?? identity.transactionDates[0], -CURE_POSTING_DAYS);
        const until = identity.undo.date ?? '9999-12-31';
        const inWindow = (o: CardScheduleObservation) => dateOf(o) >= from && dateOf(o) <= until;
        const where = `seed ${seed}, return ${id} [${from}, ${until}]`;
        const reflected = plan({ ...history, reversalDates: { ...history.reversalDates, [id]: '2000-01-01' } });
        if (JSON.stringify(live) !== JSON.stringify(reflected)) flipped++;
        for (const cycle of live.cycles) {
          if (cycle.dueDate === null || live.today <= cycle.dueDate) continue;
          const i = closings.indexOf(cycle.closingDate);
          const near = new Set([closings[i - 1], cycle.closingDate, closings[i + 1]]);
          // Its evidence: its own, its neighbours' and unlinked reads, every P = 0 read, and everything by its close (the guard).
          const evidence = history.observations.filter((o) => o.statementClosingDate === null || near.has(o.statementClosingDate)
            || o.pastDueMinor === 0 || dateOf(o) <= cycle.closingDate);
          if (evidence.some(inWindow)) continue;
          outside++;
          const other = reflected.cycles.find((item) => item.closingDate === cycle.closingDate);
          assert.ok(other !== undefined && key(other) === key(cycle), `${where}: C=${cycle.closingDate} flipped outside the window`);
        }
        if (!history.observations.some((o) => o.pastDueMinor === 0 && inWindow(o))) {
          assert.deepEqual(reflected.delinquency, live.delinquency, `${where}: the delinquency flipped outside the window`);
        }
      }
    }
    assert.ok(outside > 0, 'no closed cycle lay outside a return\'s window: the property checked nothing');
    assert.ok(flipped > 0, 'no return voided anything: the property proves nothing');
  });
});
