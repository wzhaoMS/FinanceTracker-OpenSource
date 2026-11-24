import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardMetalsMerchantClass, cardRefundSeller } from '../../cardSpendingExclusions.js';
import { METALS_CARD_CAPTURE_RULE as API_CAPTURE_RULE } from '../../metalsApi.js';
import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import {
  METALS_CAPTURE_SCHEMAS,
  type MetalsAdmissionFacts,
  type MetalsNetwork,
  type MetalsSource,
  type MetalsTender,
} from '../model.js';
import { metalsBindingDigest, metalsBindingEvidence } from './bindingDigest.js';
import {
  METALS_CAPTURE_ALIASES,
  METALS_CAPTURE_ALIAS_POLICY,
  METALS_CAPTURE_PROCESSORS,
  METALS_CARD_CAPTURE_RULE,
  metalsCaptureGroup,
  metalsCardCapture,
  metalsLatestFactVersions,
  type MetalsCaptureCardAccount,
  type MetalsCaptureCardRow,
  type MetalsCaptureHold,
  type MetalsCardCaptureInput,
  type MetalsCaptureOrder,
  type MetalsCardCaptureResult,
  type MetalsCardCaptureRow,
} from './capture.js';
import { metalsMerchantClass } from './cardGraph.js';
import { metalsCardLinks, type MetalsCardBinding } from './cardLinks.js';

/** Synthetic ledgers only: invented orders, rows, accounts, last 4s and merchant texts. */
const card = (last4: string | null, amountMinor: number | null, network: MetalsNetwork = 'visa'): MetalsTender =>
  ({ kind: 'card', network, last4, amountMinor });
const facts = (amountMinor: number | null, overrides: Partial<MetalsAdmissionFacts> = {}): MetalsAdmissionFacts => ({
  fulfilment: { shipments: 1 }, methods: [card('0001', amountMinor)], refunded: false, cancelled: false, partlyCancelled: false,
  grossTotalMinor: amountMinor, ...overrides,
});
const order = (orderKey: string, date: string, amountMinor = 25_000, overrides: Partial<MetalsCaptureOrder> = {}): MetalsCaptureOrder => ({
  orderKey, source: 'walmart', channel: 'online', date, admission: facts(amountMinor), active: true, ...overrides,
});
const paidWith = (method: MetalsTender) => facts(method.amountMinor, { methods: [method] });
const row = (id: string, date: string, amountMinor = 25_000, overrides: Partial<MetalsCaptureCardRow> = {}): MetalsCaptureCardRow => ({
  id, accountId: 'card-a', date, amountMinor, kind: 'purchase', currency: 'USD', usable: true, merchant: null, description: 'WALMART.COM',
  ...overrides,
});
const ACCOUNTS: MetalsCaptureCardAccount[] = [
  { id: 'card-a', issuer: 'chase', last4: '0001', status: 'active' },
  { id: 'card-b', issuer: 'citi', last4: '0002', status: 'active' },
];
function capture(orders: readonly MetalsCaptureOrder[], rows: readonly MetalsCaptureCardRow[], overrides: Partial<MetalsCardCaptureInput> = {}) {
  return metalsCardCapture({ orders, holds: [], rows, accounts: ACCOUNTS, bindings: [], importedAccounts: [], coverage: [], ...overrides });
}
function outcome(result: MetalsCardCaptureResult, rowId: string) {
  const found = result.rows.find((entry) => entry.rowId === rowId);
  assert.ok(found, `row ${rowId} is listed`);
  return { status: found.status, reasons: found.reasons, explainedBy: found.explainedBy };
}
const explainedBy = (subject: string) => ({ status: 'explained', reasons: [], explainedBy: subject });
const unexplained = (status: string, reasons: string[]) => ({ status, reasons, explainedBy: null });
const OUTSIDE = unexplained('outside-coverage', ['outside-coverage']);

const W1 = order('walmart-1', '2030-03-10');
const R1 = row('row-1', '2030-03-15');

describe('card capture: the control', () => {
  it('explains a row by the one subject that wants it, naming the rule and the alias policy', () => {
    const result = capture([W1], [R1]);
    assert.deepEqual(result, {
      rule: 'metals-card-capture-v1', aliasPolicy: 'metals-capture-alias-v1',
      rows: [{
        rowId: 'row-1', accountId: 'card-a', date: '2030-03-15', amountMinor: 25_000, merchantClass: 'walmart-online', group: 'walmart',
        scope: 'mixed-online', source: 'walmart', status: 'explained', reasons: [], explainedBy: 'walmart-1#0',
      }],
      credits: [], outOfScope: { warehouse: 0, samsClub: 0, store: 0, unclassed: 0 }, unchecked: [],
    });
    assert.equal(METALS_CARD_CAPTURE_RULE, 'metals-card-capture-v1');
    assert.equal(METALS_CARD_CAPTURE_RULE, API_CAPTURE_RULE);
    assert.equal(METALS_CAPTURE_ALIAS_POLICY, 'metals-capture-alias-v1');
  });

  it('takes rows in the settlement window only, both ends inclusive', () => {
    assert.deepEqual(outcome(capture([W1], [row('r', '2030-03-10')]), 'r'), explainedBy('walmart-1#0'));
    assert.deepEqual(outcome(capture([W1], [row('r', '2030-04-09')]), 'r'), explainedBy('walmart-1#0'));
    assert.deepEqual(outcome(capture([W1], [row('r', '2030-04-10')]), 'r'), OUTSIDE);
    assert.deepEqual(outcome(capture([W1], [row('r', '2030-03-09')]), 'r'), OUTSIDE);
  });

  it('never takes another amount, account or class; unusable and non-USD rows are read nowhere', () => {
    for (const overrides of [{ amountMinor: 25_001 }, { accountId: 'card-b' }, { description: 'COSTCO.COM' }]) {
      assert.deepEqual(outcome(capture([W1], [row('r', '2030-03-15', 25_000, overrides)]), 'r'), OUTSIDE, JSON.stringify(overrides));
    }
    for (const overrides of [{ usable: false }, { currency: 'CAD' }]) {
      const result = capture([W1], [row('r', '2030-03-15', 25_000, overrides)]);
      assert.deepEqual([result.rows, result.credits, result.outOfScope], [[], [], { warehouse: 0, samsClub: 0, store: 0, unclassed: 0 }]);
    }
  });

  it('candidates are class-based: a store-channel row is out of scope, yet still a candidate (§3.4)', () => {
    const store = row('row-store', '2030-03-16', 25_000, { description: 'WALMART MARKETPLACE SAMPLETOWN WA' });
    const result = capture([W1], [R1, store]);
    assert.deepEqual(outcome(result, 'row-1'), unexplained('held', ['ambiguous']));
    assert.equal(result.rows.length, 1);
    assert.equal(result.outOfScope.store, 1);
  });
});

describe('card capture: control 2 (an aggregate never matches an unrelated row of its total)', () => {
  it('several shipments: the row is possibly part of the order, never explained, up to its gross total', () => {
    const shipments = order('walmart-agg', '2030-03-05', 25_000, { admission: facts(25_000, { fulfilment: { shipments: 2 } }) });
    const result = capture([shipments], [row('r-equal', '2030-03-15', 25_000), row('r-above', '2030-03-16', 30_000)]);
    assert.deepEqual(outcome(result, 'r-equal'), unexplained('possible-aggregate', ['aggregate']));
    assert.deepEqual(outcome(result, 'r-above'), OUTSIDE);
  });

  it('split methods with known totals: no tender is a subject, and every row up to the total is possibly part of it', () => {
    const split = order('walmart-split', '2030-03-05', 25_000, {
      admission: facts(null, { methods: [card('0001', 15_000), card('0002', 10_000)], grossTotalMinor: 25_000 }),
    });
    const costcoSplit = order('costco-split', '2030-03-05', 25_000, {
      source: 'costco', admission: facts(null, { methods: [card('0001', 15_000), card('0002', 10_000)], grossTotalMinor: 25_000 }),
    });
    const rows = [row('r-15', '2030-03-15', 15_000), row('r-10', '2030-03-15', 10_000, { accountId: 'card-b' }), row('r-25', '2030-03-15', 25_000),
      row('c-15', '2030-03-15', 15_000, { description: 'COSTCO.COM' })];
    const result = capture([split, costcoSplit], rows);
    for (const rowId of ['r-15', 'r-10', 'r-25', 'c-15']) {
      assert.deepEqual(outcome(result, rowId), unexplained('possible-aggregate', ['aggregate']), rowId);
    }
  });
});

describe('card capture: control 3 (one subject per event, no self-contest)', () => {
  it('two proven separate settled occurrences each explain their own row', () => {
    const W2 = order('walmart-2', '2030-03-12', 10_000);
    const C1 = order('costco-1', '2030-03-11', 40_000, { source: 'costco' });
    const result = capture([W1, W2, C1], [R1, row('row-2', '2030-03-16', 10_000), row('row-3', '2030-03-17', 40_000, { description: 'COSTCO.COM' })]);
    assert.deepEqual(result.rows.map((entry) => [entry.rowId, entry.explainedBy]), [['row-1', 'walmart-1#0'], ['row-2', 'walmart-2#0'], ['row-3', 'costco-1#0']]);
  });

  it('refuses an order or a row listed twice', () => {
    assert.throws(() => capture([W1, W1], [R1]), { name: 'RangeError', message: 'metalsCardCapture: an order is listed twice' });
    assert.throws(() => capture([W1], [R1, R1]), { name: 'RangeError', message: 'metalsCardCapture: a row is listed twice' });
  });

  it('a promoted competitor, the same order passed metal or not, changes nothing', () => {
    const W2 = order('walmart-2', '2030-03-12', 10_000);
    const rows = [R1, row('row-2', '2030-03-16', 10_000)];
    const plain = capture([W1, W2], rows);
    assert.deepStrictEqual(capture([W1, W2].map((entry) => ({ ...entry, metal: true })), rows), plain);
    assert.deepStrictEqual(capture([W1, W2].map((entry) => ({ ...entry, metal: false })), rows), plain);
  });
});

describe('card capture: control 4, pure part (stored value)', () => {
  const shopCard: MetalsTender = { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 25_000 };

  it('a Shop Card-only order is no subject and no barrier: its row has no explanation', () => {
    const shopCardOnly = order('walmart-shop-card', '2030-03-10', 25_000, { admission: paidWith(shopCard) });
    const result = capture([shopCardOnly], [R1]);
    assert.deepEqual(outcome(result, 'row-1'), OUTSIDE);
    assert.deepEqual(result.unchecked, []);
  });

  it('a card-funded Shop Card load is an ordinary subject; a later redemption adds no second subject', () => {
    const load = order('costco-load', '2030-03-10', 25_000, { source: 'costco' });
    const redemption = order('costco-redemption', '2030-03-20', 25_000, { source: 'costco', admission: paidWith(shopCard) });
    const loadRow = row('row-load', '2030-03-12', 25_000, { description: 'COSTCO.COM' });
    assert.deepEqual(outcome(capture([load], [loadRow]), 'row-load'), explainedBy('costco-load#0'));
    assert.deepEqual(outcome(capture([load, redemption], [loadRow]), 'row-load'), explainedBy('costco-load#0'));
  });
});

describe('card capture: control 5 (credits are listed, never matched)', () => {
  it('lists every in-scope credit, matches none, and changes no purchase row', () => {
    const credits = [
      row('credit-1', '2030-03-20', -25_000, { kind: 'credit' }),
      row('credit-2', '2030-03-21', -5_000, { kind: 'credit', description: 'COSTCO WHOLESALE' }),
      row('credit-3', '2030-03-22', -25_000, { kind: 'credit', description: 'SAMPLE BULLION CO' }),
      row('credit-4', '2030-03-23', -25_000, { kind: 'credit', usable: false }),
    ];
    const result = capture([W1], [R1, ...credits]);
    const generic = cardRefundSeller({ merchant: null, description: 'SAMPLE BULLION CO' }).merchant;
    assert.deepEqual(result.credits, [
      { rowId: 'credit-1', accountId: 'card-a', date: '2030-03-20', amountMinor: -25_000, group: 'walmart', scope: 'mixed-online' },
      { rowId: 'credit-3', accountId: 'card-a', date: '2030-03-22', amountMinor: -25_000, group: generic, scope: 'gold-only' },
    ]);
    assert.deepStrictEqual(result.rows, capture([W1], [R1]).rows);
    assert.deepEqual(result.outOfScope, { warehouse: 0, samsClub: 0, store: 0, unclassed: 0 });
  });
});

describe('card capture: control 6 (no false certainty)', () => {
  it('duplicate suffixes: the identity is ambiguous, explains nothing, holds its rows and is counted unchecked', () => {
    const accounts = [...ACCOUNTS, { id: 'card-c', issuer: 'chase', last4: '0001', status: 'closed' }];
    const result = capture([W1], [R1, row('row-c', '2030-03-16', 25_000, { accountId: 'card-c' })], { accounts });
    assert.deepEqual(outcome(result, 'row-1'), unexplained('held', ['identity-ambiguous']));
    assert.deepEqual(outcome(result, 'row-c'), unexplained('held', ['identity-ambiguous']));
    assert.deepEqual(result.unchecked, [{ source: 'walmart', cardNotInHoldr: 0, identityAmbiguous: 1 }]);
    // An active binding resolves it, before any amount or date.
    const bindings: MetalsCardBinding[] = [{ source: 'walmart', network: 'visa', last4: '0001', accountId: 'card-a', state: 'active' }];
    assert.deepEqual(outcome(capture([W1], [R1], { accounts, bindings }), 'row-1'), explainedBy('walmart-1#0'));
  });

  it('a tender stating no last 4 is ambiguous and contests every account; one no account shows is not in Holdr', () => {
    const anonymous = order('walmart-anon', '2030-03-11', 25_000, { admission: paidWith(card(null, 25_000)) });
    const stranger = order('walmart-stranger', '2030-03-11', 25_000, { admission: paidWith(card('0099', 25_000)) });
    const result = capture([W1, anonymous, stranger], [R1, row('row-b', '2030-03-16', 25_000, { accountId: 'card-b' })]);
    assert.deepEqual(outcome(result, 'row-1'), unexplained('held', ['identity-ambiguous', 'contested']));
    assert.deepEqual(outcome(result, 'row-b'), unexplained('held', ['identity-ambiguous']));
    assert.deepEqual(result.unchecked, [{ source: 'walmart', cardNotInHoldr: 1, identityAmbiguous: 1 }]);
  });

  it('another dealer with equal cents: a gold-only row is never explained', () => {
    const rows = [R1, row('dealer-1', '2030-03-15', 25_000, { description: 'APMEX' }), row('generic-1', '2030-03-15', 25_000, { description: 'SAMPLE BULLION CO' })];
    const result = capture([W1], rows);
    assert.deepEqual(outcome(result, 'row-1'), explainedBy('walmart-1#0'));
    assert.deepEqual(outcome(result, 'dealer-1'), OUTSIDE);
    assert.deepEqual(outcome(result, 'generic-1'), OUTSIDE);
    const dealer = result.rows.find((entry) => entry.rowId === 'dealer-1');
    assert.deepEqual([dealer?.group, dealer?.scope, dealer?.source, dealer?.merchantClass], ['dealer:APMEX', 'gold-only', null, 'bullion-dealer']);
  });

  it('the generic bullion-word fallback is its own merchant: group, gold-only', () => {
    const generic = cardRefundSeller({ merchant: null, description: 'SAMPLE BULLION CO' }).merchant;
    assert.ok(generic.startsWith('merchant:'), generic);
    assert.deepEqual(metalsCaptureGroup({ merchant: null, description: 'SAMPLE BULLION CO' }),
      { inScope: true, merchantClass: 'bullion-dealer', group: generic, scope: 'gold-only', source: null });
  });

  it('PM TECHNOLOGIES is a processor: unresolved:pm-technologies, held alias-unresolved, attributed to no dealer', () => {
    assert.deepEqual(METALS_CAPTURE_PROCESSORS.map((entry) => entry.id), ['pm-technologies']);
    assert.ok(Object.isFrozen(METALS_CAPTURE_PROCESSORS));
    const result = capture([W1], [row('pm-1', '2030-03-15', 25_000, { description: 'PM TECHNOLOGIES' }),
      row('pm-2', '2030-03-16', 25_000, { description: 'SAMPLE BULLION PM TECHNOLOGIES' }),
      row('pm-3', '2030-03-17', 25_000, { merchant: 'PMTECHNOLOGIES', description: 'SAMPLE PAYMENT' })]);
    for (const rowId of ['pm-1', 'pm-2', 'pm-3']) assert.deepEqual(outcome(result, rowId), unexplained('held', ['alias-unresolved']), rowId);
    assert.deepEqual(result.rows.map((entry) => [entry.group, entry.source, entry.merchantClass]), [
      ['unresolved:pm-technologies', null, null], ['unresolved:pm-technologies', null, 'bullion-dealer'], ['unresolved:pm-technologies', null, null],
    ]);
  });

  it('a named dealer: row is never regrouped by a processor or an alias; aliases match whole tokens after processors', () => {
    const aliases = [{ id: 'samplepure', source: 'collectpure' as MetalsSource, token: /SAMPLEPURE/ }];
    const group = (description: string, merchant: string | null = null) => metalsCaptureGroup({ merchant, description }, aliases);
    assert.deepEqual(group('APMEX PM TECHNOLOGIES'), { inScope: true, merchantClass: 'bullion-dealer', group: 'dealer:APMEX', scope: 'gold-only', source: null });
    assert.deepEqual(group('APMEX SAMPLEPURE'), { inScope: true, merchantClass: 'bullion-dealer', group: 'dealer:APMEX', scope: 'gold-only', source: null });
    assert.deepEqual(group('SamplePure'), { inScope: true, merchantClass: null, group: 'alias:samplepure', scope: 'gold-only', source: 'collectpure' });
    assert.deepEqual(group('SAMPLE PAYMENT', 'SAMPLEPURE'), { inScope: true, merchantClass: null, group: 'alias:samplepure', scope: 'gold-only', source: 'collectpure' });
    assert.deepEqual(group('SAMPLE BULLION SAMPLEPURE'),
      { inScope: true, merchantClass: 'bullion-dealer', group: 'alias:samplepure', scope: 'gold-only', source: 'collectpure' });
    assert.deepEqual(group('SAMPLEPURE PM TECHNOLOGIES'),
      { inScope: true, merchantClass: null, group: 'unresolved:pm-technologies', scope: 'gold-only', source: null });
    for (const embedded of ['SAMPLEPUREX', 'XSAMPLEPURE', 'SAMPLE PURE']) {
      assert.deepEqual(group(embedded), { inScope: false, merchantClass: null, outOfScope: 'unclassed' }, embedded);
    }
    assert.deepEqual(group('WALMART.COM SAMPLEPURE'), { inScope: true, merchantClass: 'walmart-online', group: 'walmart', scope: 'mixed-online', source: 'walmart' });
  });

  it('R5: the alias list is empty and frozen, so the capture reads no alias yet', () => {
    assert.deepEqual([...METALS_CAPTURE_ALIASES], []);
    assert.ok(Object.isFrozen(METALS_CAPTURE_ALIASES));
    assert.deepEqual(metalsCaptureGroup({ merchant: null, description: 'SAMPLEPURE' }), { inScope: false, merchantClass: null, outOfScope: 'unclassed' });
  });

  it('a network an issuer implies: a conflicting known network is not in Holdr; an unknown or matching one resolves', () => {
    const accounts = [...ACCOUNTS, { id: 'card-d', issuer: 'amex', last4: '0004', status: 'active' }];
    const rowD = row('row-d', '2030-03-15', 25_000, { accountId: 'card-d' });
    for (const [network, expected] of [['amex', explainedBy('walmart-d#0')], ['unknown', explainedBy('walmart-d#0')], ['visa', OUTSIDE]] as const) {
      const tender = order('walmart-d', '2030-03-10', 25_000, { admission: paidWith(card('0004', 25_000, network)) });
      assert.deepEqual(outcome(capture([tender], [rowD], { accounts }), 'row-d'), expected, network);
    }
  });
});

describe('card capture: statuses and reasons (§5.2)', () => {
  it('a barrier comes first; held reasons follow, all in the canonical order', () => {
    const W2 = order('walmart-2', '2030-03-12');
    const aggregate = order('walmart-agg', '2030-03-05', 30_000, { admission: facts(30_000, { methods: [card('0002', 30_000)], fulfilment: { shipments: 2 } }) });
    const holds: MetalsCaptureHold[] = [{ source: 'walmart', channel: 'online', date: '2030-03-01' }];
    assert.deepEqual(outcome(capture([W1, W2, aggregate], [R1], { holds }), 'row-1'),
      unexplained('possible-aggregate', ['aggregate', 'held-record', 'contested']));
    assert.deepEqual(outcome(capture([W1, W2], [R1], { holds }), 'row-1'), unexplained('possible-aggregate', ['held-record', 'contested']));
  });

  it('every held reason that applies, in order: quarantined, drift, ambiguous identity, contested, ambiguous', () => {
    const drift = order('walmart-drift', '2030-03-11', 25_000, { admission: paidWith(card('0001', 25_000, 'mastercard')) });
    const anonymous = order('walmart-anon', '2030-03-11', 25_000, { admission: paidWith(card(null, 25_000)) });
    const quarantined = order('walmart-quarantined', '2030-03-12', 25_000, { active: false });
    const bindings: MetalsCardBinding[] = [{ source: 'walmart', network: 'mastercard', last4: '0001', accountId: 'card-a', state: 'suspended' }];
    const result = capture([W1, drift, anonymous, quarantined], [R1, row('row-2', '2030-03-20')], { bindings });
    const all = unexplained('held', ['source-quarantined', 'binding-drift', 'identity-ambiguous', 'contested', 'ambiguous']);
    assert.deepEqual(outcome(result, 'row-1'), all);
    assert.deepEqual(outcome(result, 'row-2'), all);
  });

  it('one reason at a time', () => {
    assert.deepEqual(outcome(capture([{ ...W1, active: false }], [R1]), 'row-1'), unexplained('held', ['source-quarantined']));
    const suspended: MetalsCardBinding[] = [{ source: 'walmart', network: 'visa', last4: '0001', accountId: 'card-a', state: 'suspended' }];
    assert.deepEqual(outcome(capture([W1], [R1], { bindings: suspended }), 'row-1'), unexplained('held', ['binding-drift']));
    assert.deepEqual(outcome(capture([W1, order('walmart-2', '2030-03-12')], [R1]), 'row-1'), unexplained('held', ['contested']));
    assert.deepEqual(outcome(capture([W1], [R1, row('row-2', '2030-03-20')]), 'row-1'), unexplained('held', ['ambiguous']));
  });

  it('labels a mixed row inside only when every imported account of its source covers [t − 30, t] online (§5.1)', () => {
    const covering = (accountId: string, from: string) => ({
      accountId, source: 'walmart' as const, kind: 'online' as const, from, to: '2030-12-31', complete: true,
      captureSchema: METALS_CAPTURE_SCHEMAS.walmart, converterVersion: 'holdr-metals-convert 1.0.0',
    });
    const stray = row('row-stray', '2030-03-15', 30_000);
    const one = [{ accountId: 'acct-w1', source: 'walmart' as const }];
    const two = [...one, { accountId: 'acct-w2', source: 'walmart' as const }];
    const inside = unexplained('no-capture-match', ['no-capture-match']);
    assert.deepEqual(outcome(capture([], [stray], { importedAccounts: one, coverage: [covering('acct-w1', '2030-02-13')] }), 'row-stray'), inside);
    assert.deepEqual(outcome(capture([], [stray], { importedAccounts: one, coverage: [covering('acct-w1', '2030-02-14')] }), 'row-stray'), OUTSIDE);
    assert.deepEqual(outcome(capture([], [stray], { importedAccounts: two, coverage: [covering('acct-w1', '2030-01-01')] }), 'row-stray'), OUTSIDE);
    assert.deepEqual(outcome(capture([], [stray], {
      importedAccounts: two, coverage: [covering('acct-w1', '2030-01-01'), covering('acct-w2', '2030-01-01')],
    }), 'row-stray'), inside);
    assert.deepEqual(outcome(capture([], [stray], { coverage: [covering('acct-w1', '2030-01-01')] }), 'row-stray'), OUTSIDE);
    // A gold-only row has no source capturing purchases: outside coverage, whatever is covered.
    const dealer = row('row-dealer', '2030-03-15', 30_000, { description: 'APMEX' });
    assert.deepEqual(outcome(capture([], [dealer], { importedAccounts: one, coverage: [covering('acct-w1', '2030-01-01')] }), 'row-dealer'), OUTSIDE);
  });

  it('counts out-of-scope purchases per reason', () => {
    const rows = [row('o-1', '2030-03-15', 1_000, { description: 'COSTCO WHOLESALE' }), row('o-2', '2030-03-15', 1_000, { description: 'SAMS CLUB' }),
      row('o-3', '2030-03-15', 1_000, { description: 'WALMART MARKETPLACE SAMPLETOWN WA' }), row('o-4', '2030-03-15', 1_000, { description: 'SAMPLE GROCER' }),
      row('o-5', '2030-03-15', 1_000, { description: 'COSTCO.COM' })];
    const result = capture([], rows);
    assert.deepEqual(result.outOfScope, { warehouse: 1, samsClub: 1, store: 1, unclassed: 1 });
    assert.deepEqual(result.rows.map((entry) => entry.rowId), ['o-5']);
  });
});

/** A seeded generator (mulberry32), as cardLinks.test.ts's. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}
const day = (offset: number) => new Date(Date.UTC(2030, 2, 1) + offset * 86_400_000).toISOString().slice(0, 10);
const AMOUNTS = [10_000, 25_000, 40_000];
const DESCRIPTION: Readonly<Record<'walmart' | 'costco', string>> = { walmart: 'WALMART.COM', costco: 'COSTCO.COM' };

/**
 * A generated ledger: online orders at Costco and Walmart (single charges, aggregates, unknown amounts; active or not),
 * their charges and stray ones on in-scope descriptors, accounts with duplicate or missing suffixes, and bindings active or
 * suspended (the bound account still showing its suffix; control 27 adds reissued cards, whose account shows another, C4).
 */
function generated(next: (bound: number) => number, round: number): MetalsCardCaptureInput {
  const pick = <T>(list: readonly T[]): T => list[next(list.length)];
  const accounts: MetalsCaptureCardAccount[] = [
    { id: 'card-a', issuer: 'chase', last4: '0001', status: 'active' },
    { id: 'card-b', issuer: pick(['citi', 'amex']), last4: '0002', status: 'active' },
    { id: 'card-c', issuer: pick(['chase', 'discover']), last4: pick(['0001', '0003', null]), status: pick(['active', 'closed']) },
  ];
  const bindings: MetalsCardBinding[] = [{ source: 'walmart', network: 'visa', last4: '0001', accountId: 'card-a', state: next(4) === 0 ? 'suspended' : 'active' }];
  if (next(3) !== 0) bindings.push({ source: 'costco', network: 'visa', last4: '0002', accountId: 'card-b', state: next(4) === 0 ? 'suspended' : 'active' });
  const accountFor = (last4: string | null) => (last4 === '0001' ? pick(['card-a', 'card-a', 'card-c']) : last4 === '0002' ? 'card-b'
    : last4 === '0003' ? 'card-c' : 'card-new');
  const orders: MetalsCaptureOrder[] = [];
  const rows: MetalsCaptureCardRow[] = [];
  for (let index = 0; index < 1 + next(5); index += 1) {
    const source = pick<'walmart' | 'costco'>(['walmart', 'walmart', 'costco']);
    const amount = pick(AMOUNTS);
    const last4 = pick(['0001', '0001', '0001', '0002', '0003', '0009', null]);
    const network = pick<MetalsNetwork>(['visa', 'visa', 'visa', 'amex', 'unknown']);
    const offset = next(30);
    const funding = next(8);
    const admission = funding === 0 ? facts(amount, { methods: [card(last4, amount, network)], fulfilment: { shipments: 2 } })
      : funding === 1 ? facts(null, { methods: [card(last4, null, network)] }) : paidWith(card(last4, amount, network));
    orders.push({ orderKey: `order-${round}-${index}`, source, channel: 'online', date: day(offset), admission, active: next(5) !== 0 });
    if (next(3) !== 0) {
      rows.push(row(`row-${round}-${rows.length}`, day(offset + next(31)), amount, { accountId: accountFor(last4), description: DESCRIPTION[source] }));
    }
  }
  for (let index = 0; index < next(3); index += 1) {
    rows.push(row(`row-${round}-${rows.length}`, day(next(60)), pick(AMOUNTS), {
      accountId: pick(['card-a', 'card-b', 'card-c', 'card-new']), description: pick(['WALMART.COM', 'COSTCO.COM']), kind: next(6) === 0 ? 'credit' : 'purchase',
    }));
  }
  const holds: MetalsCaptureHold[] = next(4) === 0
    ? [{ source: pick<MetalsSource>(['walmart', 'costco']), channel: 'online', date: next(3) === 0 ? null : day(next(40)) }] : [];
  return { orders, holds, rows, accounts, bindings, importedAccounts: [], coverage: [] };
}
const shuffled = <T>(list: readonly T[], next: (bound: number) => number): T[] => {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = next(index + 1);
    const kept = copy[index];
    copy[index] = copy[other];
    copy[other] = kept;
  }
  return copy;
};
const pairsOf = (result: MetalsCardCaptureResult) =>
  new Set(result.rows.filter((entry) => entry.status === 'explained').map((entry) => `${entry.rowId}>${entry.explainedBy}`));

describe('card capture: control 11 (order, conservation, the affected association removed)', () => {
  it('shuffled orders, rows, holds and accounts give a deep-equal result; every purchase is counted once (seeded)', () => {
    const next = seeded(11);
    for (let round = 0; round < 300; round += 1) {
      const input = generated(next, round);
      const result = metalsCardCapture(input);
      const reordered = metalsCardCapture({
        ...input, orders: shuffled(input.orders, next), rows: shuffled(input.rows, next), holds: shuffled(input.holds, next),
        accounts: shuffled(input.accounts, next),
      });
      assert.deepStrictEqual(reordered, result, `round ${round}`);
      const purchases = input.rows.filter((entry) => entry.usable && entry.currency === 'USD' && entry.kind === 'purchase').length;
      const out = result.outOfScope;
      assert.equal(purchases, result.rows.length + out.warehouse + out.samsClub + out.store + out.unclassed, `round ${round}`);
      for (const entry of result.rows) {
        assert.equal(entry.status === 'explained', entry.explainedBy !== null, `round ${round}: ${entry.rowId}`);
        assert.equal(entry.status === 'explained', entry.reasons.length === 0, `round ${round}: never both explained and held (${entry.rowId})`);
      }
    }
  });

  it('a contester of exactly an explained row\'s amount, interval and scope removes that pair', () => {
    const next = seeded(111);
    let removed = 0;
    for (let round = 0; round < 300; round += 1) {
      const input = generated(next, round);
      for (const pair of pairsOf(metalsCardCapture(input))) {
        const subject = pair.slice(pair.indexOf('>') + 1);
        const explaining = input.orders.find((entry) => `${entry.orderKey}#0` === subject);
        assert.ok(explaining, subject);
        const twin = { ...explaining, orderKey: `${explaining.orderKey}-twin` };
        assert.ok(!pairsOf(metalsCardCapture({ ...input, orders: [...input.orders, twin] })).has(pair), `round ${round}: ${pair}`);
        removed += 1;
      }
    }
    assert.ok(removed > 10, `the generated ledgers explain rows (${removed})`);
  });
});

describe('card capture: control 24 (C2 (a): one occurrence per order key, at the latest import\'s version)', () => {
  type Version = MetalsCaptureOrder & { factsDigest: string };
  const reObserved: Version[] = [
    { ...order('walmart-re', '2030-03-10'), factsDigest: 'facts-a' },
    { ...order('walmart-re', '2030-03-11'), factsDigest: 'facts-b' },
  ];
  const unchanged: Version = { ...order('walmart-same', '2030-03-12', 10_000), factsDigest: 'facts-c' };
  const listings = [
    { orderKey: 'walmart-re', factsDigest: 'facts-a', importSeq: 1 },
    { orderKey: 'walmart-re', factsDigest: 'facts-b', importSeq: 2 },
    { orderKey: 'walmart-same', factsDigest: 'facts-c', importSeq: 1 },
    { orderKey: 'walmart-same', factsDigest: 'facts-c', importSeq: 2 },
  ];
  const rows = [row('row-re', '2030-03-15'), row('row-same', '2030-03-16', 10_000)];

  it('keeps one version per key, the one the latest import listing it names, by order key', () => {
    const latest = metalsLatestFactVersions([...reObserved, unchanged], listings);
    assert.deepEqual(latest.map((version) => [version.orderKey, version.factsDigest, version.date]),
      [['walmart-re', 'facts-b', '2030-03-11'], ['walmart-same', 'facts-c', '2030-03-12']]);
    assert.deepStrictEqual(metalsLatestFactVersions([unchanged, ...reObserved].reverse(), [...listings].reverse()), latest);
  });

  it('each order is one occurrence that explains its own row; a superseded version contests nothing', () => {
    const result = capture(metalsLatestFactVersions([...reObserved, unchanged], listings), rows);
    assert.deepEqual(outcome(result, 'row-re'), explainedBy('walmart-re#0'));
    assert.deepEqual(outcome(result, 'row-same'), explainedBy('walmart-same#0'));
    // Links' expansion of every fact-version into `key~n` competitors would contest the order's own row in capture.
    const expanded = capture([reObserved[0], { ...reObserved[1], orderKey: 'walmart-re~2' }, unchanged], rows);
    assert.deepEqual(outcome(expanded, 'row-re'), unexplained('held', ['contested']));
  });

  it('drops a key no listing names, or whose named facts have no version; a tie goes to the greatest digest', () => {
    const unlisted: Version = { ...order('walmart-unlisted', '2030-03-12'), factsDigest: 'facts-d' };
    const missing = [{ orderKey: 'walmart-same', factsDigest: 'facts-z', importSeq: 3 }];
    assert.deepEqual(metalsLatestFactVersions([...reObserved, unchanged, unlisted], [...listings, ...missing]).map((version) => version.orderKey),
      ['walmart-re']);
    const tie = [{ orderKey: 'walmart-re', factsDigest: 'facts-a', importSeq: 5 }, { orderKey: 'walmart-re', factsDigest: 'facts-b', importSeq: 5 }];
    assert.deepEqual(metalsLatestFactVersions(reObserved, tie).map((version) => version.factsDigest), ['facts-b']);
    assert.deepEqual(metalsLatestFactVersions(reObserved, [...tie].reverse()).map((version) => version.factsDigest), ['facts-b']);
  });
});

describe('card capture: control 25 (C2 (b): capture is metal-independent)', () => {
  const aggregate = order('walmart-agg', '2030-04-20', 25_000, { admission: facts(25_000, { methods: [card('0002', 25_000)], fulfilment: { shipments: 2 } }) });
  const orders = [W1, order('walmart-2', '2030-03-12', 10_000), aggregate];
  const rows = [R1, row('row-2', '2030-03-16', 10_000), row('row-agg', '2030-04-25', 20_000, { accountId: 'card-b' }),
    row('row-big', '2030-04-26', 99_000, { accountId: 'card-b' })];

  it('an order held for metals takes its role from its admission: a subject explains its row; an aggregate bars up to its total', () => {
    const result = capture(orders.map((entry) => ({ ...entry, heldForMetals: true })), rows);
    assert.deepEqual(outcome(result, 'row-1'), explainedBy('walmart-1#0'));
    assert.deepEqual(outcome(result, 'row-2'), explainedBy('walmart-2#0'));
    assert.deepEqual(outcome(result, 'row-agg'), unexplained('possible-aggregate', ['aggregate']));
    assert.deepEqual(outcome(result, 'row-big'), OUTSIDE);
  });

  it('a bullion answer or a metal promotion changes no status, no byte and no binding digest', () => {
    const accounts = [{ accountId: 'acct-w', source: 'walmart' as const, retired: false }];
    const digest = (result: MetalsCardCaptureResult) => metalsBindingDigest(metalsBindingEvidence(result, 'source:walmart', accounts));
    const plain = capture(orders, rows);
    for (const marks of [{ metal: true, heldForMetals: true }, { metal: true, heldForMetals: false }, { metal: false, heldForMetals: true }]) {
      const marked = capture(orders.map((entry) => ({ ...entry, ...marks })), rows);
      assert.equal(JSON.stringify(marked), JSON.stringify(plain), JSON.stringify(marks));
      assert.equal(digest(marked), digest(plain));
    }
  });

  it('an open held record still bars at any amount, in its interval, or at any date when undated', () => {
    const result = capture(orders, rows, { holds: [{ source: 'walmart', channel: 'online', date: '2030-04-01' }] });
    assert.deepEqual(outcome(result, 'row-big'), unexplained('possible-aggregate', ['held-record']));
    assert.deepEqual(outcome(result, 'row-agg'), unexplained('possible-aggregate', ['aggregate', 'held-record']));
    assert.deepEqual(outcome(result, 'row-1'), explainedBy('walmart-1#0'));
    const undated = capture(orders, [row('row-late', '2030-09-30', 99_000)], { holds: [{ source: 'walmart', channel: 'online', date: null }] });
    assert.deepEqual(outcome(undated, 'row-late'), unexplained('possible-aggregate', ['held-record']));
  });
});

describe('card capture: control 26 (C4: a drifted identity\'s contest scope; a network conflict still contests)', () => {
  it('a suspended binding whose bound account\'s last 4 changed holds rows on that account and on every account showing the suffix', () => {
    const accounts: MetalsCaptureCardAccount[] = [
      { id: 'card-a', issuer: 'chase', last4: '0009', status: 'active' },
      { id: 'card-b', issuer: 'citi', last4: '0002', status: 'active' },
      { id: 'card-c', issuer: 'chase', last4: '0001', status: 'active' },
    ];
    const bindings: MetalsCardBinding[] = [{ source: 'walmart', network: 'visa', last4: '0001', accountId: 'card-a', state: 'suspended' }];
    const other = order('walmart-other', '2030-03-11', 25_000, { admission: paidWith(card('0009', 25_000)) });
    const rows = [row('row-a', '2030-03-15'), row('row-c', '2030-03-16', 25_000, { accountId: 'card-c' }),
      row('row-b', '2030-03-17', 25_000, { accountId: 'card-b' })];
    const result = capture([W1, other], rows, { accounts, bindings });
    assert.deepEqual(outcome(result, 'row-a'), unexplained('held', ['binding-drift', 'contested']));
    assert.deepEqual(outcome(result, 'row-c'), unexplained('held', ['binding-drift']));
    assert.deepEqual(outcome(result, 'row-b'), OUTSIDE);
    assert.deepEqual(outcome(capture([other], rows, { accounts, bindings }), 'row-a'), explainedBy('walmart-other#0'));
    // Once the bound account is gone, the accounts showing the suffix remain.
    const orphaned = capture([W1], rows, { accounts: accounts.filter((account) => account.id !== 'card-a'), bindings });
    assert.deepEqual(outcome(orphaned, 'row-a'), OUTSIDE);
    assert.deepEqual(outcome(orphaned, 'row-c'), unexplained('held', ['binding-drift']));
  });

  it('a network conflict on the one suffix account reads card-not-in-holdr, explains nothing and still contests that account', () => {
    const accounts = [...ACCOUNTS, { id: 'card-d', issuer: 'amex', last4: '0004', status: 'active' }];
    const conflict = order('walmart-conflict', '2030-03-10', 25_000, { admission: paidWith(card('0004', 25_000, 'visa')) });
    const resolved = order('walmart-amex', '2030-03-11', 25_000, { admission: paidWith(card('0004', 25_000, 'amex')) });
    const rowD = row('row-d', '2030-03-15', 25_000, { accountId: 'card-d' });
    const result = capture([conflict, resolved], [rowD], { accounts });
    assert.deepEqual(outcome(result, 'row-d'), unexplained('held', ['contested']));
    assert.deepEqual(result.unchecked, [{ source: 'walmart', cardNotInHoldr: 1, identityAmbiguous: 0 }]);
    assert.deepEqual(outcome(capture([resolved], [rowD], { accounts }), 'row-d'), explainedBy('walmart-amex#0'));
    assert.deepEqual(outcome(capture([conflict], [rowD], { accounts }), 'row-d'), OUTSIDE);
  });
});

describe('card capture: control 27 (C1: every card-link proof is a capture explanation)', () => {
  /**
   * C4, a reissued card: card-a shows 0004 now, so its 0001 binding drifted and a 0004 one is active. Half its orders pay
   * with the new number, and a crafted pair puts an old-number order's possible charge on a new-number order's candidate.
   */
  const reissued = (input: MetalsCardCaptureInput, drift: (bound: number) => number, round: number): MetalsCardCaptureInput => {
    const amount = AMOUNTS[drift(AMOUNTS.length)];
    const offset = drift(20);
    const newNumber = (method: MetalsTender): MetalsTender => (method.last4 === '0001' ? { ...method, last4: '0004' } : method);
    return {
      ...input,
      accounts: input.accounts.map((account) => (account.id === 'card-a' ? { ...account, last4: '0004' } : account)),
      bindings: [
        ...input.bindings.map((binding) => (binding.accountId === 'card-a' ? { ...binding, state: 'suspended' as const } : binding)),
        { source: 'walmart', network: 'visa', last4: '0004', accountId: 'card-a', state: 'active' },
      ],
      orders: [
        ...input.orders.map((entry) => (drift(2) === 0 ? entry
          : { ...entry, admission: { ...entry.admission, methods: entry.admission.methods.map(newNumber) } })),
        order(`order-${round}-old-card`, day(offset), amount, { admission: paidWith(card('0001', amount)) }),
        order(`order-${round}-new-card`, day(offset + drift(5)), amount, { admission: paidWith(card('0004', amount)) }),
      ],
      rows: [...input.rows, row(`row-${round}-new-card`, day(offset + 5 + drift(5)), amount)],
    };
  };

  it('on identical inputs, each metalsCardLinks proof link (s, r) is explained by s in capture, reissued cards too (seeded, 400 rounds)', () => {
    const next = seeded(27);
    const drift = seeded(2_704);
    let proofs = 0;
    let driftContested = 0;
    const unexplained: string[] = [];
    for (let round = 0; round < 400; round += 1) {
      const generatedInput = generated(next, round);
      const reissue = drift(3) === 0;
      const input = reissue ? reissued(generatedInput, drift, round) : generatedInput;
      const links = metalsCardLinks({
        orders: input.orders.map((entry) => ({ ...entry, metal: next(4) !== 0 })),
        held: input.holds,
        rows: input.rows.map((entry) => ({
          id: entry.id, accountId: entry.accountId, date: entry.date, amountMinor: entry.amountMinor, kind: entry.kind, currency: entry.currency,
          usable: entry.usable, merchantClass: cardMetalsMerchantClass(entry),
        })),
        accounts: input.accounts.map((account) => ({ id: account.id, last4: account.last4 })),
        bindings: input.bindings,
      });
      const captured = metalsCardCapture(input);
      const byRow = new Map(captured.rows.map((entry) => [entry.rowId, entry]));
      for (const link of links.links) {
        // The case C4 is about: a subject's one candidate on the reissued account, which an old-number tender could have made.
        const candidate = link.candidates.length === 1 ? byRow.get(link.candidates[0]) : undefined;
        if (reissue && candidate?.accountId === 'card-a' && candidate.reasons.includes('binding-drift')) driftContested += 1;
        if (!link.proof) continue;
        proofs += 1;
        if (byRow.get(link.rowId ?? '')?.explainedBy !== link.subject) unexplained.push(`round ${round}: ${link.subject} > ${link.rowId}`);
      }
    }
    assert.ok(driftContested > 10, `reissued cards put an old-number tender's possible charge on a new-number candidate (${driftContested})`);
    assert.ok(proofs > 5, `the generated ledgers prove links (${proofs})`);
    assert.deepEqual(unexplained, [], 'every card-link proof is a capture explanation');
  });
});

describe('card capture: control 28 (C3: the extended monotonicity property)', () => {
  it('an explanation created by adding e has row e, subject e, or an identity e resolved or narrowed (seeded, 400 rounds)', () => {
    const next = seeded(28);
    const pick = <T>(list: readonly T[]): T => list[next(list.length)];
    const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const keyOf = (pair: string) => pair.slice(pair.indexOf('>') + 1, pair.lastIndexOf('#'));
    const matches = (entry: MetalsCaptureOrder, binding: MetalsCardBinding) => entry.source === binding.source
      && entry.admission.methods.some((method) => method.network === binding.network && method.last4 === binding.last4);
    const couldContest = (entry: MetalsCaptureOrder, target: MetalsCardCaptureRow) => {
      const admission = metalsAdmission(entry.source, entry.channel, entry.admission);
      if (admission === null || admission.basis !== 'single-charge') return false;
      const { from, to } = metalsSettlementInterval(entry.date, entry.channel);
      return metalsMerchantClass(entry.source, entry.channel) === target.merchantClass && target.date >= from && target.date <= to
        && admission.evidence.some((evidence) => evidence.amountMinor === target.amountMinor);
    };
    const suffixOf: Readonly<Record<string, string>> = { 'card-a': '0001', 'card-b': '0002', 'card-c': '0003', 'card-new': '0009' };
    let created = 0;
    let removed = 0;
    for (let round = 0; round < 400; round += 1) {
      const input = generated(next, round);
      const before = pairsOf(metalsCardCapture(input));
      const amount = pick(AMOUNTS);
      const date = day(next(30));
      const source = pick<'walmart' | 'costco'>(['walmart', 'costco']);
      const tender = card(pick(['0001', '0002', '0003', '0009']), amount, pick<MetalsNetwork>(['visa', 'amex', 'unknown']));
      // A new row: the charge an existing order would make; a new subject: the order an existing row would have.
      const charged = pick(input.orders);
      const chargedLast4 = charged.admission.methods[0]?.last4 ?? null;
      const fresh = row(`e-row-${round}`, shift(charged.date, next(31)), charged.admission.methods[0]?.amountMinor ?? amount, {
        accountId: chargedLast4 === '0001' ? 'card-a' : chargedLast4 === '0002' ? 'card-b' : chargedLast4 === '0003' ? 'card-c' : 'card-new',
        description: DESCRIPTION[charged.source === 'costco' ? 'costco' : 'walmart'],
      });
      const target = input.rows.length > 0 ? pick(input.rows) : fresh;
      const subject = order(`e-subject-${round}`, shift(target.date, -next(31)), target.amountMinor, {
        source: target.description === 'COSTCO.COM' ? 'costco' : 'walmart', admission: paidWith(card(suffixOf[target.accountId] ?? '0009', target.amountMinor)),
      });
      const account: MetalsCaptureCardAccount = { id: 'card-new', issuer: pick(['chase', 'amex']), last4: pick(['0001', '0002', '0003', '0009']), status: 'active' };
      const binding: MetalsCardBinding = {
        source, network: pick<MetalsNetwork>(['visa', 'amex', 'unknown']), last4: pick(['0001', '0002', '0003', '0009']),
        accountId: pick(['card-a', 'card-b', 'card-c', 'card-new']), state: 'active',
      };
      const never = () => false;
      const variants: Array<{ label: string; input: MetalsCardCaptureInput; allows: (pair: string, entry: MetalsCardCaptureRow) => boolean }> = [
        { label: 'a competitor stating no last 4', allows: never,
          input: { ...input, orders: [...input.orders, order(`e-anonymous-${round}`, date, amount, { source, admission: paidWith(card(null, amount)) })] } },
        { label: 'a quarantined order', allows: never,
          input: { ...input, orders: [...input.orders, order(`e-quarantined-${round}`, date, amount, { source, admission: paidWith(tender), active: false })] } },
        { label: 'an aggregate', allows: never, input: { ...input, orders: [...input.orders, order(`e-aggregate-${round}`, date, amount, {
          source, admission: next(2) === 0 ? facts(amount, { methods: [tender], fulfilment: { shipments: 2 } }) : facts(null, { methods: [card(tender.last4, null)] }),
        })] } },
        { label: 'a hold', allows: never,
          input: { ...input, holds: [...input.holds, { source, channel: 'online', date: next(3) === 0 ? null : day(next(40)) }] } },
        { label: 'a duplicate candidate row', allows: never,
          input: { ...input, rows: input.rows.length === 0 ? input.rows : [...input.rows, { ...pick(input.rows), id: `e-again-${round}` }] } },
        { label: 'a new row', allows: (pair) => pair.startsWith(`${fresh.id}>`), input: { ...input, rows: [...input.rows, fresh] } },
        { label: 'a new subject order', allows: (pair) => keyOf(pair) === subject.orderKey, input: { ...input, orders: [...input.orders, subject] } },
        { label: 'a new card account sharing a suffix', allows: (_pair, entry) => entry.accountId === account.id,
          input: { ...input, accounts: [...input.accounts, account] } },
        {
          label: 'a new active binding', input: { ...input, bindings: [...input.bindings, binding] },
          allows: (pair, entry) => {
            const explaining = input.orders.find((candidate) => candidate.orderKey === keyOf(pair));
            return explaining !== undefined && (matches(explaining, binding)
              || input.orders.some((other) => other !== explaining && matches(other, binding) && couldContest(other, entry)));
          },
        },
      ];
      for (const variant of variants) {
        const after = metalsCardCapture(variant.input);
        const pairs = pairsOf(after);
        for (const pair of pairs) {
          if (before.has(pair)) continue;
          const entry = after.rows.find((candidate) => `${candidate.rowId}>${candidate.explainedBy}` === pair);
          assert.ok(entry, pair);
          assert.ok(variant.allows(pair, entry), `round ${round}, ${variant.label}: a new explanation ${pair}`);
          created += 1;
        }
        for (const pair of before) if (!pairs.has(pair)) removed += 1;
      }
    }
    assert.ok(created > 5 && removed > 5, `the property is exercised (${created} created, ${removed} removed)`);
  });
});
