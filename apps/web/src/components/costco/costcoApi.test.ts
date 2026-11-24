import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CostcoAnswerError,
  CostcoRequestError,
  costcoReceiptsPath,
  fetchCostcoReceipt,
  fetchCostcoReceipts,
  fetchCostcoSummary,
  parseCostcoConflict,
  parseCostcoReceipt,
  parseCostcoReceipts,
  parseCostcoSummary,
} from './costcoApi';
import {
  MEMBERSHIP_A,
  MEMBERSHIP_B,
  categoryFixture,
  gasDetailFixture,
  lineRef,
  onlineDetailFixture,
  receiptFixture,
  receiptRef,
  receiptsFixture,
  rowsFixture,
  summaryFixture,
  warehouseDetailFixture,
  wire,
} from './costcoFixtures';

// Synthetic bodies only (costcoFixtures.ts): made-up refs, labels, titles, amounts and last fours.

type Parse = (raw: unknown) => unknown;
type Path = Array<string | number>;

// Each route's format and its own version: the summary and the list at 1, the receipt detail at 2 (its lines' categories).
const SUMMARY = { format: 'holdr.retail-costco-summary', version: 1, parse: parseCostcoSummary as Parse };
const RECEIPTS = { format: 'holdr.retail-costco-receipts', version: 1, parse: parseCostcoReceipts as Parse };
const RECEIPT = { format: 'holdr.retail-costco-receipt', version: 2, parse: parseCostcoReceipt as Parse };

/** Each route's present bodies, every nested object of the contract among them. */
const PRESENT: Array<{ name: string; version: number; parse: Parse; body: () => Record<string, unknown> }> = [
  { name: 'summary', version: 1, parse: SUMMARY.parse, body: () => wire(summaryFixture()) },
  { name: 'receipts', version: 1, parse: RECEIPTS.parse, body: () => wire(receiptsFixture()) },
  { name: 'warehouse receipt', version: 2, parse: RECEIPT.parse, body: () => wire(receiptFixture(warehouseDetailFixture())) },
  { name: 'online receipt', version: 2, parse: RECEIPT.parse, body: () => wire(receiptFixture(onlineDetailFixture())) },
  { name: 'gas receipt', version: 2, parse: RECEIPT.parse, body: () => wire(receiptFixture(gasDetailFixture())) },
];
const ABSENT = [SUMMARY, RECEIPTS, RECEIPT].map(({ format, version, parse }) => ({
  format, version, parse, body: () => ({ format, version, state: 'absent' }),
}));

/** Every object (not an array, not null) in a body, by its path: the body itself first. */
function objectPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => objectPaths(entry, [...path, index]));
  if (typeof value !== 'object' || value === null) return [];
  return [path, ...Object.entries(value).flatMap(([key, entry]) => objectPaths(entry, [...path, key]))];
}
const at = (body: unknown, path: Path): any => path.reduce((node: any, key) => node[key], body);

function assertRefused(parse: Parse, body: unknown, what: string): void {
  assert.throws(() => parse(body), (error: unknown) => error instanceof CostcoAnswerError, what);
}

/** The body changed by `change`, refused. */
function refusedWith(parse: Parse, make: () => Record<string, unknown>, change: (body: any) => void, what: string): void {
  const body = make();
  change(body);
  assertRefused(parse, body, what);
}

test('every route\'s bodies read whole at its own version (the detail\'s at 2), present and absent, nothing dropped or added', () => {
  assert.deepEqual(parseCostcoSummary(wire(summaryFixture())), summaryFixture());
  assert.deepEqual(parseCostcoReceipts(wire(receiptsFixture())), receiptsFixture());
  for (const detail of [warehouseDetailFixture(), onlineDetailFixture(), gasDetailFixture()]) {
    assert.deepEqual(parseCostcoReceipt(wire(receiptFixture(detail))), receiptFixture(detail));
  }
  for (const { format, version, parse, body } of ABSENT) assert.deepEqual(parse(body()), { format, version, state: 'absent' });
  // An empty but installed store: no membership, no receipt, every count 0.
  const empty = { ...wire(summaryFixture()), memberships: [], held: 0 };
  assert.equal((parseCostcoSummary(empty) as { memberships: unknown[] }).memberships.length, 0);
  assert.deepEqual(parseCostcoReceipts(wire(receiptsFixture([]))), receiptsFixture([]));
});

test('an unknown key is refused in every object of every body, nested ones too, and the refusal never names it', () => {
  let checked = 0;
  const reached = new Set<string>();
  for (const { name, parse, body } of [...PRESENT, ...ABSENT.map((absent) => ({ name: absent.format, ...absent }))]) {
    for (const path of objectPaths(body())) {
      const changed = body();
      at(changed, path).sneakyExtra0007 = 'SAMPLE WIDGET';
      assert.throws(() => parse(changed), (error: unknown) => error instanceof CostcoAnswerError
        && !error.message.includes('sneaky') && !error.message.includes('SAMPLE'), `${name} at ${path.join('.') || 'top'}`);
      checked += 1;
      reached.add(path.filter((key) => typeof key === 'string').join('.'));
    }
  }
  // Rows, their tenders, lines, metal, fuel, events, shipments, tenders, memberships, counts and captures all reached;
  // so are a line's category and the suggestion kept with Needs review.
  assert.ok(checked > 60, `${checked} objects checked`);
  for (const path of ['receipt.lines.category', 'receipt.lines.category.suggestion']) assert.ok(reached.has(path), path);
});

test('a missing key is refused in every object of every body', () => {
  const reached = new Set<string>();
  for (const { name, parse, body } of [...PRESENT, ...ABSENT.map((absent) => ({ name: absent.format, ...absent }))]) {
    for (const path of objectPaths(body())) {
      for (const key of Object.keys(at(body(), path))) {
        const changed = body();
        delete at(changed, path)[key];
        assertRefused(parse, changed, `${name} without ${[...path, key].join('.')}`);
        reached.add([...path, key].filter((part) => typeof part === 'string').join('.'));
      }
    }
  }
  // Every key of a line's category and of its suggestion among them, and the line's `category` itself.
  for (const key of ['category', ...['node', 'cardCategory', 'source', 'confidenceBp', 'suggested', 'suggestion', 'metalHold'].map((name) => `category.${name}`),
    'category.suggestion.node', 'category.suggestion.confidenceBp']) {
    assert.ok(reached.has(`receipt.lines.${key}`), key);
  }
});

test('another version, format or state is refused, on present and absent bodies alike', () => {
  for (const { name, version, parse, body } of [...PRESENT, ...ABSENT.map((absent) => ({ name: absent.format, ...absent }))]) {
    for (const other of [version + 1, version - 1, 0, String(version), null, version + 0.5]) {
      refusedWith(parse, body, (changed) => { changed.version = other; }, `${name} version ${other}`);
    }
    refusedWith(parse, body, (changed) => { changed.format = 'holdr.retail-costco-other'; }, `${name} format`);
    for (const state of ['partial', 'ABSENT', null]) refusedWith(parse, body, (changed) => { changed.state = state; }, `${name} state ${state}`);
  }
  // A v1 detail, present or absent, is refused: with its lines' categories or without them.
  assertRefused(parseCostcoReceipt, { ...wire(receiptFixture()), version: 1 }, 'a v1 detail');
  const v1 = wire(receiptFixture()) as any;
  for (const line of v1.receipt.lines) delete line.category;
  assertRefused(parseCostcoReceipt, { ...v1, version: 1 }, 'a v1 detail without categories');
  assertRefused(parseCostcoReceipt, { format: RECEIPT.format, version: 1, state: 'absent' }, 'a v1 absent detail');
  // The summary and the list stay at version 1: a version 2 of either is refused.
  for (const { format, parse } of [SUMMARY, RECEIPTS]) assertRefused(parse, { format, version: 2, state: 'absent' }, `${format} at 2`);
  // Each route reads its own format only, an absent body's too.
  for (const { format, version } of ABSENT) {
    for (const { format: other, parse } of ABSENT) {
      if (other !== format) assertRefused(parse, { format, version, state: 'absent' }, `${format} read as ${other}`);
    }
  }
  assertRefused(parseCostcoReceipts, wire(summaryFixture()), 'a summary read as receipts');
  for (const raw of [null, [], 'present', 1, undefined]) {
    for (const { parse } of ABSENT) assertRefused(parse, raw, String(raw));
  }
  // An absent body with a present body's keys is neither.
  assertRefused(parseCostcoSummary, { ...wire(summaryFixture()), state: 'absent' }, 'absent with present keys');
  assertRefused(parseCostcoSummary, { format: SUMMARY.format, version: 1, state: 'present' }, 'present without its keys');
});

test('values outside the closed vocabularies are refused', () => {
  const receipts = () => wire(receiptsFixture());
  const summary = () => wire(summaryFixture());
  const warehouse = () => wire(receiptFixture(warehouseDetailFixture()));
  const online = () => wire(receiptFixture(onlineDetailFixture()));
  const cases: Array<[Parse, () => Record<string, unknown>, (body: any) => void, string]> = [
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].channel = 'store'; }, 'channel'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].sign = 'void'; }, 'sign'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].state = 'deleted'; }, 'state'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[1].status = 'lost'; }, 'online status'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].status = 'delivered'; }, 'a status on a warehouse receipt'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].quarantineReason = 'receipt-changed'; }, 'a reason on an active receipt'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[2].quarantineReason = null; }, 'a quarantined receipt without its reason'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[2].quarantineReason = 'suspicious'; }, 'quarantine reason'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].currency = 'CAD'; }, 'currency'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].tenders.kinds = ['check']; }, 'tender kind'],
    [RECEIPTS.parse, receipts, (body) => { body.receipts[0].tenders.kinds = ['card', 'card']; }, 'a tender kind twice'],
    [SUMMARY.parse, summary, (body) => { body.memberships[0].owner = 'guest'; }, 'owner'],
    [SUMMARY.parse, summary, (body) => { body.memberships[0].capture.ranges[0].channel = 'gas'; }, 'coverage channel'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].kind = 'discount'; }, 'line kind'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].storedValue = 'gift-card'; }, 'stored value'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].taxFlag = 'YES'; }, 'tax flag'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[2].metal.metal = 'XRH'; }, 'metal'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[2].metal.form = 'chain'; }, 'metal form'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[2].metal.statedWeight.unit = 'lb'; }, 'weight unit'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[2].metal.pack = 'some'; }, 'pack'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[2].metal.rule = 'Title Rule'; }, 'rule label'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[6].metalUncertain.evidence = ['shiny']; }, 'guard evidence'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[6].metalUncertain.evidence = ['purity', 'purity']; }, 'evidence twice'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[2].metalUncertain = { guard: 'metal-guard-v1', evidence: [], metal: null }; },
      'metal facts and the guard\'s flag together'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].fuel = { gallons: '1', unitPrice: '1' }; }, 'fuel on an item'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].couponFor = lineRef(3); }, 'a coupon target on an item'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].feeOf = lineRef(4); }, 'a fee parent on an item'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.lines[0].events = { shipped: [], delivered: [], cancelled: [], returned: [] }; },
      'events on a warehouse line'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.tenders[0].kind = 'check'; }, 'tender kind'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.tenders[0].network = 'amex'; }, 'network'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.tenders[0].cardSpending = false; }, 'a card tender not in Spending'],
    [RECEIPT.parse, warehouse, (body) => { body.receipt.tenders[0].last4 = '07'; }, 'a short last four'],
    [RECEIPT.parse, online, (body) => { body.receipt.tenders[1].last4 = '0011'; }, 'a last four on a Shop Card'],
    [RECEIPT.parse, online, (body) => { body.receipt.tenders[1].cardSpending = true; }, 'a Shop Card in Spending'],
    [RECEIPT.parse, online, (body) => { body.receipt.lines[0].fulfilment = 'drone'; }, 'fulfilment'],
    [RECEIPT.parse, online, (body) => { body.receipt.lines[0].shipments[0].carrier = 'dhl'; }, 'carrier'],
    [RECEIPT.parse, online, (body) => { body.receipt.lines[0].events.shipped[0].quantity = 0; }, 'an event of no unit'],
    [RECEIPT.parse, online, (body) => { body.receipt.status = 'lost'; }, 'receipt status'],
    [RECEIPT.parse, () => wire(receiptFixture(gasDetailFixture())), (body) => { body.receipt.lines[0].fuel.gallons = '13.2.03'; }, 'gallons'],
    [RECEIPT.parse, () => wire(receiptFixture(gasDetailFixture())), (body) => { body.receipt.lines[0].fuel.unitPrice = 3.459; }, 'price per gallon'],
  ];
  for (const [parse, make, change, what] of cases) refusedWith(parse, make, change, what);
});

test('a line\'s category reads whole: a node of the item tree (v2) with its own card category, a closed source, basis points, flags', () => {
  const read = (category: unknown, n = 0) => {
    const body = wire(receiptFixture()) as any;
    body.receipt.lines[n].category = category;
    return parseCostcoReceipt(body) as { receipt: { lines: Array<{ category: unknown }> } };
  };
  // Each source, none, both confidence bounds, a top level, a subcategory with its own card category, and the tree's own
  // two top levels: each reads as sent.
  for (const category of [
    categoryFixture('groceries', { source: 'owner' }),
    categoryFixture('household/storage-organization', { source: 'agent', confidenceBp: 10_000 }),
    categoryFixture('electronics/networking', { source: 'agent', confidenceBp: 6000, suggested: true }),
    categoryFixture('automotive/fuel', { source: 'department-review' }),
    categoryFixture('precious-metals', { source: 'title-rule', metalHold: true }),
    categoryFixture('needs-review', { suggestion: { node: 'dining', confidenceBp: 0 }, metalHold: true }),
  ]) {
    assert.deepEqual(read(wire(category)).receipt.lines[0].category, category, category.node);
  }
  // A category on a line of every kind that carries one: the fee and the fuel line read theirs (the fixtures').
  const good = () => wire(categoryFixture('groceries/beverages', { source: 'owner' })) as any;
  const asset = categoryFixture('precious-metals').cardCategory;
  const cases: Array<[unknown, string]> = [
    ...['groceries/unknown', 'meat-seafood', 'Groceries', 'groceries/', '', '__proto__', 'constructor', null, 7].map((node): [unknown, string] =>
      [{ ...good(), node }, `node ${String(node)}`]),
    // The card category is the node's own in the tree: not another node's, nor its top level's for a subcategory with its own.
    [{ ...good(), cardCategory: asset }, 'another node\'s card category'],
    [{ ...wire(categoryFixture('household/storage-organization')), cardCategory: categoryFixture('household').cardCategory }, 'its top level\'s'],
    ...['', null, 'groceries/beverages', 7].map((cardCategory): [unknown, string] => [{ ...good(), cardCategory }, `card category ${String(cardCategory)}`]),
    ...['classifier', 'Owner', 'title rule', '', 0, true].map((source): [unknown, string] => [{ ...good(), source }, `source ${String(source)}`]),
    ...[-1, 10_001, 72.5, '7200', Number.NaN, true].map((confidenceBp): [unknown, string] => [{ ...good(), confidenceBp }, `confidence ${confidenceBp}`]),
    ...['true', 1, null].map((suggested): [unknown, string] => [{ ...good(), suggested }, `suggested ${String(suggested)}`]),
    ...['false', 0, null].map((metalHold): [unknown, string] => [{ ...good(), metalHold }, `metal hold ${String(metalHold)}`]),
    ...[
      { node: 'groceries/unknown', confidenceBp: 4500 }, { node: 'dining', confidenceBp: 10_001 }, { node: 'dining', confidenceBp: -1 },
      { node: 'dining', confidenceBp: null }, { node: 'dining', confidenceBp: 45.5 }, { node: 'dining' }, { confidenceBp: 4500 },
      { node: 'dining', confidenceBp: 4500, source: 'agent' }, 'dining', [], 4500,
    ].map((suggestion): [unknown, string] => [{ ...good(), suggestion }, `suggestion ${JSON.stringify(suggestion)}`]),
    ['groceries/beverages', 'a node alone'], [[], 'a list'], [true, 'a flag'],
  ];
  for (const [category, what] of cases) assert.throws(() => read(category), CostcoAnswerError, what);
  // Exactly the kinds that carry a category have one: never a coupon (the item's or the receipt's own), always an item,
  // a fee or a fuel line.
  for (const n of [1, 5]) assert.throws(() => read(good(), n), CostcoAnswerError, `a category on coupon line ${n}`);
  for (const n of [0, 2, 4, 6]) assert.throws(() => read(null, n), CostcoAnswerError, `no category on line ${n}`);
  refusedWith(RECEIPT.parse, () => wire(receiptFixture(gasDetailFixture())), (body) => { body.receipt.lines[0].category = null; }, 'a fuel line without one');
  refusedWith(RECEIPT.parse, () => wire(receiptFixture(onlineDetailFixture())), (body) => { body.receipt.lines[0].category = null; }, 'an online item without one');
});

test('refs of another shape are refused', () => {
  const bad = ['rcp-' + 'q'.repeat(32), receiptRef(1).toUpperCase(), 'rcp-abc', `${receiptRef(1)}a`, `x${receiptRef(1)}`, MEMBERSHIP_A, 7];
  for (const value of bad) {
    refusedWith(parseCostcoReceipts, () => wire(receiptsFixture()), (body) => { body.receipts[0].receiptRef = value; }, `receipt ref ${value}`);
    refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.receiptRef = value; }, `detail ref ${value}`);
  }
  const cases: Array<[Parse, () => Record<string, unknown>, (body: any) => void, string]> = [
    [SUMMARY.parse, () => wire(summaryFixture()), (body) => { body.memberships[0].membershipRef = 'rtl-mbr-' + 'z'.repeat(32); }, 'membership'],
    [SUMMARY.parse, () => wire(summaryFixture()), (body) => { body.memberships[1].membershipRef = MEMBERSHIP_A; }, 'a membership twice'],
    [RECEIPTS.parse, () => wire(receiptsFixture()), (body) => { body.receipts[0].memberships = ['rtl-mbr-short']; }, 'row membership'],
    [RECEIPTS.parse, () => wire(receiptsFixture()), (body) => { body.receipts[0].memberships = [MEMBERSHIP_B, MEMBERSHIP_B]; }, 'a row membership twice'],
    [RECEIPTS.parse, () => wire(receiptsFixture()), (body) => { body.receipts[1].receiptRef = receiptRef(1); }, 'a receipt twice'],
    [RECEIPT.parse, () => wire(receiptFixture()), (body) => { body.receipt.lines[0].lineRef = receiptRef(9); }, 'line ref'],
    [RECEIPT.parse, () => wire(receiptFixture()), (body) => { body.receipt.lines[1].lineRef = lineRef(1); }, 'a line twice'],
    [RECEIPT.parse, () => wire(receiptFixture()), (body) => { body.receipt.lines[1].couponFor = 'rli-bad'; }, 'coupon target'],
    [RECEIPT.parse, () => wire(receiptFixture()), (body) => { body.receipt.lines[4].feeOf = receiptRef(4); }, 'fee parent'],
    [RECEIPT.parse, () => wire(receiptFixture(onlineDetailFixture())), (body) => { body.receipt.lines[0].shipments[0].shipmentRef = lineRef(1); },
      'shipment ref'],
  ];
  for (const [parse, make, change, what] of cases) refusedWith(parse, make, change, what);
});

test('money that isn\'t whole cents, counts that aren\'t counts, and dates that aren\'t days are refused', () => {
  for (const amount of [10.5, '1000', null, 2e10, Number.MAX_SAFE_INTEGER + 1]) {
    refusedWith(parseCostcoReceipts, () => wire(receiptsFixture()), (body) => { body.receipts[0].totalMinor = amount; }, `total ${amount}`);
    refusedWith(parseCostcoReceipts, () => wire(receiptsFixture()), (body) => { body.receipts[0].tenders.otherMinor = amount; }, `other ${amount}`);
    refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.lines[0].amountMinor = amount; }, `line ${amount}`);
    refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.tenders[0].amountMinor = amount; }, `tender ${amount}`);
    refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.totals.totalMinor = amount; }, `totals ${amount}`);
  }
  refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.totals.taxMinor = '50'; }, 'tax as text');
  refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.lines[0].quantity = 1.5; }, 'quantity');
  for (const value of [-1, 1.5, '1']) {
    refusedWith(parseCostcoReceipts, () => wire(receiptsFixture()), (body) => { body.receipts[0].itemLines = value; }, `item lines ${value}`);
    refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => { body.held = value; }, `held ${value}`);
    refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => { body.receipts.gas.active = value; }, `count ${value}`);
    refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => { body.quarantine['receipt-changed'] = value; }, `reason count ${value}`);
  }
  for (const date of ['2026-02-30', '2026-11-2', '2026-11-02T00:00:00Z', '11/02/2026', '']) {
    refusedWith(parseCostcoReceipts, () => wire(receiptsFixture()), (body) => { body.receipts[0].date = date; }, `row date ${date}`);
    refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => { body.memberships[0].capture.ranges[0].to = date; }, `range ${date}`);
  }
  // `capturedThrough` is a capture date, never an instant.
  for (const value of ['2026-11-03T10:00:00.000Z', '2026-13-01', 20261103]) {
    refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => { body.memberships[0].capture.capturedThrough = value; }, `${value}`);
  }
  refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => {
    body.memberships[0].capture.ranges[0] = { channel: 'online', from: '2026-10-31', to: '2026-01-01' };
  }, 'a range that ends before it starts');
  for (const time of ['25:00', '2pm', '14:5', '14:05:60']) {
    refusedWith(parseCostcoReceipt, () => wire(receiptFixture()), (body) => { body.receipt.localTime = time; }, `local time ${time}`);
  }
  for (const label of ['', ' Sample', 'x'.repeat(61), 'Sample\nHousehold', 42]) {
    refusedWith(parseCostcoSummary, () => wire(summaryFixture()), (body) => { body.memberships[0].label = label; }, `label ${String(label)}`);
  }
});

test('a page says no more receipts than it may: its limit, and what is left after its offset', () => {
  const make = () => wire(receiptsFixture());
  for (const limit of [0, 101, 1.5]) refusedWith(parseCostcoReceipts, make, (body) => { body.limit = limit; }, `limit ${limit}`);
  refusedWith(parseCostcoReceipts, make, (body) => { body.offset = -1; }, 'offset');
  refusedWith(parseCostcoReceipts, make, (body) => { body.limit = 3; }, 'more rows than the limit');
  refusedWith(parseCostcoReceipts, make, (body) => { body.total = 3; }, 'more rows than the total');
  refusedWith(parseCostcoReceipts, make, (body) => { body.offset = 2; }, 'more rows than are left after the offset');
  assert.equal((parseCostcoReceipts({ ...make(), total: 104, offset: 100 }) as { receipts: unknown[] }).receipts.length, 4);
});

test('a searched row\'s matching lines read whole; none, an empty list, an unknown key or a line twice is refused', () => {
  const searched = receiptsFixture(rowsFixture().map((row, index) => ({ ...row, matchingLines: [
    { lineRef: lineRef(index + 1), kind: 'item' as const, itemNumber: '1234567', title: 'SAMPLE WIDGET', title2: null, quantity: 1, amountMinor: 799 },
  ] })));
  assert.deepEqual(parseCostcoReceipts(wire(searched)), searched);
  const make = () => wire(searched);
  refusedWith(parseCostcoReceipts, make, (body) => { body.receipts[0].matchingLines = []; }, 'an empty match list');
  refusedWith(parseCostcoReceipts, make, (body) => { body.receipts[0].matchingLines[0].category = 'x'; }, 'an unknown key');
  refusedWith(parseCostcoReceipts, make, (body) => { delete body.receipts[0].matchingLines[0].title2; }, 'a missing key');
  refusedWith(parseCostcoReceipts, make, (body) => { body.receipts[0].matchingLines[0].lineRef = 'rli-bad'; }, 'a bad line ref');
  refusedWith(parseCostcoReceipts, make, (body) => { body.receipts[0].matchingLines[0].kind = 'gift'; }, 'a kind');
  refusedWith(parseCostcoReceipts, make, (body) => { body.receipts[0].matchingLines.push(body.receipts[0].matchingLines[0]); }, 'a line twice');
  refusedWith(parseCostcoReceipts, make, (body) => { body.receipts[0].matchingLines[0].amountMinor = 1.5; }, 'an amount');
});

test('a row\'s tender kinds read each once, in the contract\'s order', () => {
  const body = wire(receiptsFixture());
  (body.receipts as any)[1].tenders.kinds = ['shop-card', 'card'];
  const parsed = parseCostcoReceipts(body);
  assert.ok(parsed.state === 'present');
  assert.deepEqual(parsed.receipts[1].tenders.kinds, ['card', 'shop-card']);
});

test('a 409 body reads only as one of the closed reasons', () => {
  assert.equal(parseCostcoConflict({ error: 'refused', reason: 'schema-conflict' }), 'schema-conflict');
  assert.equal(parseCostcoConflict({ error: 'refused', reason: 'retail-reserved-value' }), 'retail-reserved-value');
  for (const body of [{ error: 'refused', reason: 'reserved-value' }, { error: 'refused', reason: 'schema-conflict', extra: 1 },
    { reason: 'schema-conflict' }, { error: 1, reason: 'schema-conflict' }, null, 'schema-conflict']) {
    assert.equal(parseCostcoConflict(body), null, JSON.stringify(body));
  }
});

test('the list\'s query names only the contract\'s parameters, each value checked, then encoded', () => {
  assert.equal(costcoReceiptsPath(), '/retail/costco/receipts');
  assert.equal(costcoReceiptsPath({ membership: MEMBERSHIP_A, channel: 'gas', offset: 50, limit: 25 }),
    `/retail/costco/receipts?membership=${MEMBERSHIP_A}&channel=gas&offset=50&limit=25`);
  // The search: trimmed, encoded; empty is no search; longer than the API's bound, or with a control character, never sent.
  assert.equal(costcoReceiptsPath({ q: '  milk & eggs ' }), '/retail/costco/receipts?q=milk+%26+eggs');
  assert.equal(costcoReceiptsPath({ q: '   ' }), '/retail/costco/receipts');
  assert.equal(costcoReceiptsPath({ q: 'w'.repeat(100) }), `/retail/costco/receipts?q=${'w'.repeat(100)}`);
  for (const q of ['w'.repeat(101), 'wid\u0001get']) assert.throws(() => costcoReceiptsPath({ q }), CostcoRequestError, q);
  // A category: one node of the item tree (v2), encoded, after every other name; anything else is never sent.
  assert.equal(costcoReceiptsPath({ category: 'groceries/meat-seafood' }), '/retail/costco/receipts?category=groceries%2Fmeat-seafood');
  assert.equal(costcoReceiptsPath({ category: 'needs-review', q: 'milk', limit: 25, offset: 50, channel: 'gas', membership: MEMBERSHIP_A }),
    `/retail/costco/receipts?membership=${MEMBERSHIP_A}&channel=gas&offset=50&limit=25&q=milk&category=needs-review`);
  assert.equal(costcoReceiptsPath({ category: 'precious-metals' }), '/retail/costco/receipts?category=precious-metals');
  for (const category of ['groceries/unknown', 'Groceries', '', '__proto__', 'groceries&channel=gas', 'meat-seafood']) {
    assert.throws(() => costcoReceiptsPath({ category: category as never }), CostcoRequestError, category);
  }
  for (const query of [{ membership: `${MEMBERSHIP_A}&channel=online` }, { membership: 'Sample Household' }, { channel: 'store' as never },
    { offset: -1 }, { offset: 1.5 }, { offset: 1_000_001 }, { limit: 0 }, { limit: 101 }]) {
    assert.throws(() => costcoReceiptsPath(query), CostcoRequestError, JSON.stringify(query));
  }
});

/** Answers every request with `body` (status 200), recording what was asked for. */
async function withAnswers(answer: (url: string) => unknown, run: (asked: string[]) => Promise<void>): Promise<void> {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = original;
  }
}

test('the fetchers only read: a ref of another shape is never sent, and an answer for another receipt or page is refused', async () => {
  await withAnswers((url) => (url.includes('/summary') ? wire(summaryFixture()) : url.includes('/receipts/') ? wire(receiptFixture())
    : wire(receiptsFixture())), async (asked) => {
    assert.deepEqual(await fetchCostcoSummary(), summaryFixture());
    assert.deepEqual(await fetchCostcoReceipt(receiptRef(1)), receiptFixture());
    assert.deepEqual(await fetchCostcoReceipts(), receiptsFixture());
    for (const ref of ['rcp-bad', '../summary', `${receiptRef(1)}?x=1`, receiptRef(1).toUpperCase()]) {
      await assert.rejects(fetchCostcoReceipt(ref), CostcoRequestError, ref);
    }
    // The answer is receipt 1's: asked for receipt 2, it is refused.
    await assert.rejects(fetchCostcoReceipt(receiptRef(2)), CostcoAnswerError);
    // The answer is the first page, of every channel: asked for another page or one channel, it is refused.
    await assert.rejects(fetchCostcoReceipts({ offset: 50 }), CostcoAnswerError);
    await assert.rejects(fetchCostcoReceipts({ channel: 'gas' }), CostcoAnswerError);
    await assert.rejects(fetchCostcoReceipts({ membership: MEMBERSHIP_B }), CostcoAnswerError);
    // Asked to search, rows without their matching lines are refused.
    await assert.rejects(fetchCostcoReceipts({ q: 'widget' }), CostcoAnswerError);
    // A category is asked as such (rows carry none to check); one outside the item tree is never sent.
    assert.deepEqual(await fetchCostcoReceipts({ category: 'groceries/beverages' }), receiptsFixture());
    await assert.rejects(fetchCostcoReceipts({ category: 'beverages' as never }), CostcoRequestError);
    assert.deepEqual(asked, [
      'GET /retail/costco/summary',
      `GET /retail/costco/receipts/${receiptRef(1)}`,
      'GET /retail/costco/receipts',
      `GET /retail/costco/receipts/${receiptRef(2)}`,
      'GET /retail/costco/receipts?offset=50',
      'GET /retail/costco/receipts?channel=gas',
      `GET /retail/costco/receipts?membership=${MEMBERSHIP_B}`,
      'GET /retail/costco/receipts?q=widget',
      'GET /retail/costco/receipts?category=groceries%2Fbeverages',
    ]);
  });
  // Absent tables: every route's answer reads as nothing imported, each at its own format's version.
  await withAnswers((url) => (url.includes('/summary') ? { format: SUMMARY.format, version: 1, state: 'absent' }
    : url.includes('/receipts/') ? { format: RECEIPT.format, version: 2, state: 'absent' }
      : { format: RECEIPTS.format, version: 1, state: 'absent' }), async () => {
    assert.equal((await fetchCostcoSummary()).state, 'absent');
    assert.equal((await fetchCostcoReceipts({ channel: 'gas', offset: 50 })).state, 'absent');
    assert.equal((await fetchCostcoReceipt(receiptRef(7))).state, 'absent');
  });
});
