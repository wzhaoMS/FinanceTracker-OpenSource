import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardMetalsMerchantClass } from '@finance-tracker/shared';
import { serializeMetalsImportPayload, validateMetalsImportPayload, type MetalsImportPayload } from '@finance-tracker/shared/metals-ledger';

import { COSTCO_CARD_LAST4, GOLD_CARD_LAST4, WALMART_ROW, goldLedgerPayloads } from './goldLedgerSeed';

/** Days the e2e may run on: an ordinary one, either side of the daylight-time changes, a new year's day and a leap day. */
const TODAYS = ['2026-11-08', '2026-03-09', '2026-11-02', '2027-01-01', '2028-02-29'];

const payloadsOf = (today: string): Array<[string, MetalsImportPayload]> => {
  const ledger = goldLedgerPayloads(today);
  return [['costco', ledger.costco], ['walmart', ledger.walmart], ['walmartLater', ledger.walmartLater], ['collectpure', ledger.collectpure]];
};

test('every payload of the synthetic ledger is valid under G1a, as the canonical bytes the importer reads, on any day', () => {
  for (const today of TODAYS) {
    for (const [name, payload] of payloadsOf(today)) {
      const text = serializeMetalsImportPayload(payload);
      const result = validateMetalsImportPayload(JSON.parse(text));
      assert.equal(result.ok, true, `${today} ${name}: ${result.ok ? '' : JSON.stringify(result.issues)}`);
      // Canonical: what the importer is given is exactly what serializing it again gives.
      assert.equal(serializeMetalsImportPayload(JSON.parse(text) as MetalsImportPayload), text, `${today} ${name}`);
    }
  }
});

test('the later Walmart capture differs from the first in one order\'s money only: a factual conflict, a new file', () => {
  const ledger = goldLedgerPayloads('2026-11-08');
  assert.notEqual(serializeMetalsImportPayload(ledger.walmartLater), serializeMetalsImportPayload(ledger.walmart));
  const changed = ledger.walmart.orders.filter((order, index) => JSON.stringify(order) !== JSON.stringify(ledger.walmartLater.orders[index]));
  assert.deepEqual(changed.map((order) => order.lines[0].title), ['Sample Refinery 10 g Gold Bar FINE GOLD .9999']);
});

test('the ledger holds every case the page must say', () => {
  const ledger = goldLedgerPayloads('2026-11-08');
  const [linked, awaiting, refunded, quarantined] = ledger.walmart.orders;
  // Card evidence: admitted subjects on the approved card, none for the refunded order (an aggregate).
  assert.deepEqual([linked, awaiting, refunded, quarantined].map((order) => order.evidence.length), [1, 1, 0, 1]);
  assert.ok([linked, awaiting, quarantined].every((order) => order.admission?.methods[0].last4 === GOLD_CARD_LAST4));
  assert.deepEqual(ledger.cardRows.map((row) => row.amountMinor), [linked.fullPriceMinor, quarantined.fullPriceMinor]);
  // The card rows read as Walmart online, the class a Walmart order links in (a bullion word would make them a dealer's).
  assert.equal(cardMetalsMerchantClass({ description: WALMART_ROW }), 'walmart-online');
  assert.equal(refunded.refunds.length, 1);
  assert.deepEqual(awaiting.lines[0].events.map((event) => event.kind), ['shipped']);
  // Silver: a bar delivered before the silver bar sale's agreed day and returned after it; refunded, so never a subject.
  const silverBar = ledger.walmart.orders[4];
  const silverSale = ledger.collectpure.orders[4];
  assert.deepEqual([silverBar.lines[0].metal, silverSale.lines[0].metal], ['XAG', 'XAG']);
  const [delivered, returned] = silverBar.lines[0].events.map((event) => event.date ?? '');
  assert.ok(delivered < silverSale.date && silverSale.date < returned, `${delivered} < ${silverSale.date} < ${returned}`);
  assert.equal(silverBar.evidence.length, 0);
  // Costco: every unit needs the owner (no raw content evidence); one pack; one cancelled; one mixed order.
  const costco = ledger.costco.orders;
  assert.ok(costco.every((order) => order.admission?.methods.every((method) => method.last4 === COSTCO_CARD_LAST4)));
  assert.ok(costco.flatMap((order) => order.lines).every((line) => 'hold' in line.fine));
  assert.deepEqual(costco.map((order) => order.lines[0].pack), ['single', 'single', 'multiple', 'single', 'single']);
  assert.equal(costco[4].lines[0].complete, false, 'the mixed order\'s shipping stays unattributed');
  assert.equal(costco[4].lines[0].events[0].date, null);
  assert.equal(ledger.costco.held.length, 1);
  // CollectPure: content known by coin specification or stated basis, or held with why; silver; two metals; cancelled.
  const fine = Object.fromEntries(ledger.collectpure.orders.map((order) => [order.lines[0].title, order.lines[0].fine]));
  assert.deepEqual(fine['1 oz Gold Bar Sample Refinery FINE GOLD .9999'], { troyOz: '1/1', basis: 'stated-mass-basis' });
  assert.deepEqual(fine['1 oz Gold American Eagle Sample'], { troyOz: '1/1', basis: 'coin-specification' });
  assert.equal((fine['Sample Gold Bar 10 g min .999'] as { hold: string }).hold, 'mass-basis-unknown');
  assert.equal((fine['Gold and Silver Sample Medal'] as { hold: string }).hold, 'metal-unknown');
  assert.ok('hold' in fine['1 oz Silver Maple Leaf Sample']);
  assert.deepEqual(ledger.collectpure.orders.map((order) => order.status),
    ['complete', 'received', 'complete', 'agreed', 'complete', 'complete', 'complete', 'cancelled']);
  // Premiums: the bar's reconciles (the dealer's spot); the Eagle's percent and dollars disagree with its price.
  const premiums = ledger.collectpure.orders.map((order) => order.lines[0].sale?.premium?.text ?? null);
  assert.equal(premiums[0], 'spot +1.5625% / +$40.00 per troy ounce');
  assert.equal(premiums[2], 'spot +5.0000% / +$40.00 per troy ounce');
  // Coverage: complete where holdings need it, each source ending on its own day before today; the payouts read short.
  const tail = (payload: MetalsImportPayload) => payload.coverage.map((entry) => [entry.kind, entry.to, entry.complete]);
  assert.deepEqual(tail(ledger.costco), [['online', ledger.dates.costcoCovered, true], ['warehouse', ledger.dates.costcoCovered, true]]);
  assert.deepEqual(tail(ledger.walmart), [['online', ledger.dates.walmartCovered, true]]);
  assert.deepEqual(tail(ledger.collectpure), [['sell-orders', ledger.dates.collectpureCovered, true], ['payouts', ledger.dates.collectpureCovered, false]]);
  assert.ok([ledger.dates.costcoCovered, ledger.dates.walmartCovered, ledger.dates.collectpureCovered].every((date) => date < '2026-11-08'));
  assert.equal(new Set([ledger.dates.costcoCovered, ledger.dates.walmartCovered, ledger.dates.collectpureCovered]).size, 3);
});
