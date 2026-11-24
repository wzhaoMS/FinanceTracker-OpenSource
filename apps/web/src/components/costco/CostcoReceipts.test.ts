import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup as staticMarkup } from 'react-dom/server';

import { ITEM_TAXONOMY_V2_VIEW } from '@finance-tracker/shared';
import type { RetailApiReceiptRow } from '@finance-tracker/shared/retail-api';

import {
  CostcoReceiptsView,
  costcoListQuery,
  costcoListStep,
  type CostcoFilters,
  type CostcoListState,
  type CostcoLoad,
  type CostcoReceiptsViewProps,
} from './CostcoReceipts';
import { costcoReceiptsPath } from './costcoApi';
import { COSTCO_ABSENT, COSTCO_BANNER, COSTCO_METAL_TAG, costcoMoney } from './costcoFormat';
import {
  MEMBERSHIP_A,
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
} from './costcoFixtures';

// The page as the server renders it (no DOM, no fetch), from synthetic answers only (costcoFixtures.ts).

const ready = <T>(value: T): CostcoLoad<T> => ({ status: 'ready', value });
const LOADING = { status: 'loading' } as const;
const NO_FILTERS = { membership: '', channel: '', q: '', category: '' } as const;
const PRESENT: CostcoReceiptsViewProps = { summary: ready(summaryFixture()), list: ready(receiptsFixture()), filters: NO_FILTERS };
const ABSENT_SUMMARY = ready({ format: 'holdr.retail-costco-summary', version: 1, state: 'absent' } as const);

/** Static markup, without the separators a renderer puts between adjacent texts. */
const render = (props: CostcoReceiptsViewProps) => staticMarkup(createElement(CostcoReceiptsView, props)).replace(/<!-- -->/g, '');
/** What a reader reads: tags dropped, entities read, spaces collapsed. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The markup of the element whose opening tag carries `marker`, up to the next element that carries `next` (or the end). */
function slice(html: string, marker: string, next?: string): string {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `${marker} is drawn`);
  const end = next === undefined ? -1 : html.indexOf(next, at + marker.length);
  return html.slice(at, end < 0 ? undefined : end);
}
const rowOf = (html: string, n: number) => slice(html, `data-receipt="${receiptRef(n)}"`, 'data-receipt="');

const STATES: Array<[string, CostcoReceiptsViewProps]> = [
  ['loading', { summary: LOADING, list: LOADING, filters: NO_FILTERS }],
  ['failed', { summary: { status: 'error', message: 'Holdr couldn\'t load the Costco receipts (HTTP 500).' }, list: LOADING, filters: NO_FILTERS }],
  ['absent', { summary: ABSENT_SUMMARY, list: LOADING, filters: NO_FILTERS }],
  ['list loading', { ...PRESENT, list: LOADING }],
  ['list failed', { ...PRESENT, list: { status: 'error', message: 'Holdr couldn\'t load the Costco receipts (HTTP 500).' } }],
  ['present', PRESENT],
  ['filtered by category', { ...PRESENT, filters: { ...NO_FILTERS, category: 'groceries' } }],
  ['empty', { ...PRESENT, list: ready(receiptsFixture([])) }],
  ['receipt loading', { ...PRESENT, receipt: { ref: receiptRef(1), load: LOADING } }],
  ['receipt failed', { ...PRESENT, receipt: { ref: receiptRef(1), load: { status: 'error', message: 'This receipt isn\'t in Holdr.' } } }],
  ['receipt', { ...PRESENT, receipt: { ref: receiptRef(1), load: ready(receiptFixture()) } }],
  ['online order', { ...PRESENT, receipt: { ref: receiptRef(2), load: ready(receiptFixture(onlineDetailFixture())) } }],
  ['gas receipt', { ...PRESENT, receipt: { ref: receiptRef(4), load: ready(receiptFixture(gasDetailFixture())) } }],
];

test('the banner is said first in every state: loading, failed, nothing imported, the list and a receipt', () => {
  for (const [name, props] of STATES) {
    const text = textOf(render(props));
    assert.ok(text.startsWith(COSTCO_BANNER), name);
  }
  assert.equal(COSTCO_BANNER,
    'Receipt detail only. Each purchase is already in Spending as its card charge; nothing on this page adds to any total.');
});

test('without the retail tables, the page says nothing was imported, and shows no list or summary', () => {
  const html = render({ summary: ABSENT_SUMMARY, list: LOADING, filters: NO_FILTERS });
  assert.ok(textOf(html).includes(COSTCO_ABSENT));
  assert.doesNotMatch(html, /costco-summary|costco-list|<select/);
  // The list's answer absent too (the tables went between two reads): the same.
  const listAbsent = render({ ...PRESENT, list: ready({ format: 'holdr.retail-costco-receipts', version: 1, state: 'absent' }) });
  assert.ok(textOf(listAbsent).includes(COSTCO_ABSENT));
  assert.doesNotMatch(listAbsent, /costco-list/);
  // Installed, but nothing stored: the same words, while a filter that matches nothing says so instead.
  assert.ok(textOf(render({ ...PRESENT, list: ready(receiptsFixture([])) })).includes(COSTCO_ABSENT));
  const filtered = textOf(render({ ...PRESENT, list: ready(receiptsFixture([])),
    filters: { membership: MEMBERSHIP_A, channel: 'gas', q: '', category: '' } }));
  assert.ok(filtered.includes('No receipts match these filters.') && !filtered.includes(COSTCO_ABSENT));
  // A category alone is a filter too.
  const byCategory = textOf(render({ ...PRESENT, list: ready(receiptsFixture([])), filters: { ...NO_FILTERS, category: 'precious-metals' } }));
  assert.ok(byCategory.includes('No receipts match these filters.') && !byCategory.includes(COSTCO_ABSENT));
});

test('the search box sits with the filters; a searched row lists its matching items with their own amounts', () => {
  const html = render(PRESENT);
  assert.match(html, /<input type="search"/);
  assert.match(html, /placeholder="Search item, item number or amount" aria-label="Search item, item number or amount"/);
  assert.doesNotMatch(html, /costco-matches/);
  const rows = rowsFixture().slice(0, 1).map((row) => ({ ...row, matchingLines: [
    { lineRef: lineRef(1), kind: 'item' as const, itemNumber: '1234567', title: 'SAMPLE WIDGET', title2: 'PACK OF 2', quantity: 2, amountMinor: 799 },
    { lineRef: lineRef(2), kind: 'coupon' as const, itemNumber: '7654321', title: null, title2: null, quantity: null, amountMinor: -100 },
  ] }));
  const searched = textOf(rowOf(render({ ...PRESENT, list: ready(receiptsFixture(rows)), filters: { ...NO_FILTERS, q: 'widget' } }), 1));
  assert.ok(searched.includes('SAMPLE WIDGET · PACK OF 2 · Item 1234567 · Qty 2 $7.99'), searched);
  assert.ok(searched.includes('Coupon · Item 7654321 −$1.00'), searched);
  // An empty answer to a search says the filters matched nothing, while the box still holds it and once it's cleared, until
  // the next answer; text typed but not yet sent doesn't make an unsearched empty list a filtered one.
  const none = (q: string, search: string) => textOf(render({ ...PRESENT, list: ready(receiptsFixture([])), filters: { ...NO_FILTERS, q }, search }));
  for (const q of ['no such item', '']) {
    const text = none(q, 'no such item');
    assert.ok(text.includes('No receipts match these filters.') && !text.includes(COSTCO_ABSENT), q);
  }
  const typed = none('no such item', '');
  assert.ok(typed.includes(COSTCO_ABSENT) && !typed.includes('No receipts match these filters.'));
});

test('a search is asked from its first page once typing pauses, even when Next was pressed during the pause', () => {
  const asked = (state: CostcoListState) => costcoReceiptsPath(costcoListQuery({ ...state.filters, search: state.search, offset: state.offset }));
  const typed = (state: CostcoListState, q: string) => costcoListStep(state, { kind: 'filters', filters: { ...state.filters, q } });
  // Typed on the first page: nothing more is asked until typing pauses, and Next pages the list still shown.
  let state = typed({ filters: NO_FILTERS, search: '', offset: 0 }, 'widget');
  assert.equal(asked(state), '/retail/costco/receipts');
  state = costcoListStep(state, { kind: 'page', offset: 50 });
  assert.equal(asked(state), '/retail/costco/receipts?offset=50');
  // Typing pauses: the new search is asked from its first page.
  state = costcoListStep(state, { kind: 'paused' });
  assert.equal(asked(state), '/retail/costco/receipts?q=widget');
  // Its own pages page it. Sent again unchanged (spaces only), it keeps its page; while another waits, the page stays, and
  // once sent, it starts again. A membership or channel is asked at once, from the first page.
  state = costcoListStep(state, { kind: 'page', offset: 50 });
  assert.equal(asked(costcoListStep(typed(state, ' widget '), { kind: 'paused' })), '/retail/costco/receipts?offset=50&q=widget');
  assert.equal(asked(typed(state, 'gadget')), '/retail/costco/receipts?offset=50&q=widget');
  assert.equal(asked(costcoListStep(typed(state, 'gadget'), { kind: 'paused' })), '/retail/costco/receipts?q=gadget');
  assert.equal(asked(costcoListStep(state, { kind: 'filters', filters: { ...state.filters, channel: 'gas' } })),
    '/retail/costco/receipts?channel=gas&q=widget');
});

test('the category filter sits with Membership and Channel: All categories, then the whole item tree (v2) in its order', () => {
  const html = render(PRESENT);
  const at = ['<span>Membership</span>', '<span>Channel</span>', '<span>Category</span>', '<input type="search"'].map((marker) => html.indexOf(marker));
  assert.ok(at.every((index, n) => index >= 0 && (n === 0 || index > at[n - 1])), String(at));
  const select = slice(html, '<span>Category</span>', '</select>');
  assert.match(select, /^<span>Category<\/span><select><option value="" selected="">All categories<\/option>/);
  // Every node once, in the tree's display order: each top level, then its subcategories.
  assert.deepEqual([...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]), ['', ...ITEM_TAXONOMY_V2_VIEW.nodes.map((node) => node.id)]);
  // A top level with subcategories is a group by its label, led by the whole top level; one without is a single choice.
  assert.deepEqual([...select.matchAll(/<optgroup label="([^"]*)">/g)].map((match) => match[1].replace(/&amp;/g, '&')),
    ITEM_TAXONOMY_V2_VIEW.nodes.filter((node) => node.parent === null && node.children.length > 0).map((node) => node.label));
  assert.ok(select.includes('<optgroup label="Groceries"><option value="groceries">All Groceries</option>'
    + '<option value="groceries/meat-seafood">Meat &amp; Seafood</option>'));
  assert.ok(select.includes('<optgroup label="Automotive"><option value="automotive">All Automotive</option><option value="automotive/fuel">Fuel</option>'));
  assert.ok(select.includes('</optgroup><option value="dining">Food Court &amp; Dining</option><optgroup label="Household Supplies">'));
  assert.ok(select.endsWith('<option value="precious-metals">Precious metals</option><option value="needs-review">Needs review</option>'), select.slice(-200));
  // The chosen category shows as chosen, and only it.
  const chosen = slice(render({ ...PRESENT, filters: { ...NO_FILTERS, category: 'groceries/beverages' } }), '<span>Category</span>', '</select>');
  assert.ok(chosen.includes('<option value="groceries/beverages" selected="">Beverages</option>'));
  assert.equal(chosen.split('selected=""').length - 1, 1);
});

test('a category is asked at once, from the first page, and sent after the other filters; All categories sends none', () => {
  const asked = (state: CostcoListState) => costcoReceiptsPath(costcoListQuery({ ...state.filters, search: state.search, offset: state.offset }));
  const chose = (state: CostcoListState, category: CostcoFilters['category']) =>
    costcoListStep(state, { kind: 'filters', filters: { ...state.filters, category } });
  let state: CostcoListState = { filters: { ...NO_FILTERS, membership: MEMBERSHIP_A, channel: 'gas', q: 'widget' }, search: 'widget', offset: 50 };
  const others = `membership=${MEMBERSHIP_A}&channel=gas`;
  assert.equal(asked(state), `/retail/costco/receipts?${others}&offset=50&q=widget`);
  state = chose(state, 'automotive/fuel');
  assert.equal(asked(state), `/retail/costco/receipts?${others}&q=widget&category=automotive%2Ffuel`);
  // Its own pages page it, and chosen again unchanged it keeps its page; another category, or none, starts again.
  state = costcoListStep(state, { kind: 'page', offset: 50 });
  assert.equal(asked(chose(state, 'automotive/fuel')), `/retail/costco/receipts?${others}&offset=50&q=widget&category=automotive%2Ffuel`);
  assert.equal(asked(chose(state, 'automotive')), `/retail/costco/receipts?${others}&q=widget&category=automotive`);
  assert.equal(asked(chose(state, '')), `/retail/costco/receipts?${others}&q=widget`);
  assert.deepEqual(costcoListQuery({ membership: '', channel: '', category: 'needs-review', search: '', offset: 0 }),
    { membership: undefined, channel: undefined, offset: undefined, q: undefined, category: 'needs-review' });
  assert.equal(costcoListQuery({ membership: '', channel: '', category: '', search: '', offset: 0 }).category, undefined);
});

test('each row says its date, channel, memberships, items, its own total and how it was paid; a refund as a refund', () => {
  const html = render(PRESENT);
  const text = textOf(html);
  assert.ok(text.includes('4 receipts'));
  const warehouse = textOf(rowOf(html, 1));
  for (const words of ['Nov 2, 2026', 'Warehouse', 'Sample Household', '4 items', '$10.00', 'Paid with Card', 'Card $10.00 · Other $0.00']) {
    assert.ok(warehouse.includes(words), words);
  }
  const online = textOf(rowOf(html, 2));
  for (const words of ['Online', 'Delivered', '1 item', '$15.00', 'Card, Shop Card', 'Card $15.00 · Other $5.00']) assert.ok(online.includes(words), words);
  const refund = textOf(rowOf(html, 3));
  for (const words of ['Refund', '−$12.34', 'Card refund', 'Sample Household, Sample Executive']) assert.ok(refund.includes(words), words);
  assert.ok(textOf(rowOf(html, 4)).includes('Fuel'));
  // Each row opens its receipt from the keyboard: a button named for it.
  assert.match(rowOf(html, 3), /<button type="button" id="costco-open-rcp-[a-p]{32}" class="costco-open" aria-label="Open the warehouse refund of Oct 5, 2026"/);
  // The filters: every membership by its own label, and every channel.
  assert.match(html, new RegExp(`<option value="${MEMBERSHIP_A}">Sample Household</option>`));
  assert.match(html, /<option value="gas">Gas<\/option>/);
});

test('a quarantined receipt is listed, marked under review with its reason, never hidden', () => {
  const html = render(PRESENT);
  const row = rowOf(html, 3);
  assert.match(row, /data-state="quarantined"/);
  assert.ok(textOf(row).includes('Under review — a later capture shows this receipt with different details'));
  for (const n of [1, 2, 4]) assert.ok(!textOf(rowOf(html, n)).includes('Under review'), `receipt ${n}`);
  // The summary counts it by its reason, and the held records only as a count.
  const summary = textOf(slice(html, 'data-testid="costco-summary"', '</section>'));
  assert.ok(summary.includes('1 receipt: a later capture shows this receipt with different details'));
  assert.ok(summary.includes('2 records held (not receipts)'));
  assert.ok(summary.includes('Captured through Nov 3, 2026'));
  assert.ok(summary.includes('Warehouse 1 active, 1 under review'));
});

test('no rendered figure is a sum across receipts', () => {
  // Two receipts of $10.00 and $20.00: each is shown, and $30.00 never is.
  const two: RetailApiReceiptRow[] = [rowsFixture()[0], { ...rowsFixture()[3], totalMinor: 2000, tenders: { kinds: ['card'], cardSpendingMinor: 2000, otherMinor: 0 } }];
  const html = render({ ...PRESENT, list: ready(receiptsFixture(two)) });
  assert.ok(html.includes('$10.00') && html.includes('$20.00'));
  assert.ok(!html.includes('$30.00'));

  // Every sum of two or more of the fixture's receipts' own figures (totals, card parts, other parts), on the page as a
  // whole, in any state: none is drawn. None of them equals a figure of one receipt, so the check means something.
  const rows = rowsFixture();
  const own = new Set(rows.flatMap((row) => [row.totalMinor, row.tenders.cardSpendingMinor, row.tenders.otherMinor]));
  const sums = new Set<number>();
  for (const figures of [rows.map((row) => row.totalMinor), rows.map((row) => row.tenders.cardSpendingMinor), rows.map((row) => row.tenders.otherMinor)]) {
    const nonZero = figures.filter((figure) => figure !== 0);
    for (let mask = 0; mask < 1 << nonZero.length; mask += 1) {
      const chosen = nonZero.filter((_, index) => mask & (1 << index));
      if (chosen.length >= 2) sums.add(chosen.reduce((total, figure) => total + figure, 0));
    }
  }
  assert.ok(sums.size >= 10);
  for (const sum of sums) assert.ok(!own.has(sum), `${sum} is also one receipt's own figure`);
  for (const [name, props] of STATES) {
    const page = render(props);
    for (const sum of sums) assert.ok(!page.includes(costcoMoney(sum)), `${name} shows ${costcoMoney(sum)}`);
  }
});

test('a receipt shows every line in order, coupons under their item, fees under their parent, metal tagged, tenders with the card', () => {
  const html = render({ ...PRESENT, receipt: { ref: receiptRef(1), load: ready(receiptFixture()) } });
  const text = textOf(html);
  assert.ok(text.includes('Back to receipts'));
  assert.match(html, /<h3 id="costco-receipt-title" class="costco-title" tabindex="-1">Warehouse receipt · Nov 2, 2026<\/h3>/);
  assert.ok(text.includes('Nov 2, 2026, 14:05'));
  assert.doesNotMatch(html, /costco-list|costco-summary/);
  // Every line, in the receipt's order.
  const at = warehouseDetailFixture().lines.map((line) => html.indexOf(`data-line="${line.lineRef}"`));
  assert.ok(at.every((index) => index >= 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  // The coupon sits under its item and the fee under its parent; the receipt's own coupon stands alone.
  assert.match(slice(html, `data-line="${lineRef(1)}"`, `data-line="${lineRef(3)}"`), new RegExp(`costco-sublines[^]*data-line="${lineRef(2)}"`));
  assert.match(slice(html, `data-line="${lineRef(4)}"`, `data-line="${lineRef(6)}"`), new RegExp(`costco-sublines[^]*data-line="${lineRef(5)}"`));
  assert.doesNotMatch(slice(html, `data-line="${lineRef(6)}"`, `data-line="${lineRef(7)}"`), /costco-sublines/);
  assert.ok(textOf(slice(html, `data-line="${lineRef(6)}"`, `data-line="${lineRef(7)}"`)).includes('Coupon on the whole receipt SAMPLE SAVINGS −$1.00'));
  assert.ok(textOf(slice(html, `data-line="${lineRef(1)}"`, `data-line="${lineRef(2)}"`)).includes('SAMPLE WIDGET $7.99 Item 1234567 1 × $7.99 Tax Y'));
  // The metal tag on the line with metal facts only; the guard's flag as a note, untagged.
  assert.equal(html.split(COSTCO_METAL_TAG).length - 1, 1);
  assert.ok(textOf(slice(html, `data-line="${lineRef(3)}"`, `data-line="${lineRef(4)}"`)).includes(`${COSTCO_METAL_TAG} Silver · round · 1 ozt`));
  const untitled = textOf(slice(html, `data-line="${lineRef(7)}"`, '</ol>'));
  assert.ok(untitled.includes('Item 7654321') && untitled.includes('Uncertain metal: its title names gold with a purity'));
  // Totals and the tax legend as stated; the tender with its network and last four, already in Spending.
  for (const words of ['Subtotal $9.50', 'Instant savings (in the lines above) $3.00', 'Tax $0.50', 'Total $10.00', 'Tax legends A $0.50',
    'Card · Visa ···0007 $10.00 In Spending as a card charge']) {
    assert.ok(text.includes(words), words);
  }
});

test('each item, fee or fuel line shows its category from the item tree: Needs review muted, a suggested one marked, a coupon none', () => {
  const html = render({ ...PRESENT, receipt: { ref: receiptRef(1), load: ready(receiptFixture()) } });
  assert.ok(textOf(html).startsWith(COSTCO_BANNER));
  const line = (n: number) => slice(html, `data-line="${lineRef(n)}"`, 'data-line="');
  // An agent's category it is only fairly sure of: the node's path, marked suggested, in words a screen reader says too.
  assert.ok(line(1).includes('<span class="costco-line-category" data-testid="costco-category"><span class="costco-category" '
    + 'data-node="tools-home-improvement/tools" data-suggested="true"><span class="visually-hidden">Category: </span>'
    + 'Tools &amp; Home Improvement › Tools</span><span class="costco-category-mark"><span class="visually-hidden">, </span>Suggested</span></span>'),
  line(1));
  // The owner's, and its fee's (filed by its department's review): the same chip, unmarked.
  for (const n of [4, 5]) {
    assert.ok(textOf(line(n)).includes('Category: Groceries › Beverages'), `line ${n}`);
    assert.doesNotMatch(line(n), /Suggested|data-suggested|data-tone/, `line ${n}`);
  }
  // Needs review, muted; the agent's low suggestion kept with it isn't shown.
  assert.ok(slice(html, `data-line="${lineRef(7)}"`, '</ol>').includes('<span class="costco-category" data-node="needs-review" data-tone="review">'
    + '<span class="visually-hidden">Category: </span>Needs review</span>'));
  assert.doesNotMatch(html, /Snacks/);
  // No chip on the item's coupon or the receipt's own, nor on the silver round, which keeps its metal tag instead.
  for (const n of [2, 3, 6]) assert.doesNotMatch(line(n), /costco-category/, `line ${n}`);
  assert.equal(html.split('data-testid="costco-category"').length - 1, 4);
  assert.equal(html.split('Suggested').length - 1, 1);
  // Nothing is added up by category: both Beverages lines' own amounts are shown, never their sum.
  assert.ok(html.includes(costcoMoney(71)) && html.includes(costcoMoney(30)) && !html.includes(costcoMoney(101)));
  // A line filed on a top level itself reads as the top level.
  const top = warehouseDetailFixture();
  top.lines[0] = { ...top.lines[0], category: categoryFixture('dining', { source: 'owner' }) };
  assert.ok(render({ ...PRESENT, receipt: { ref: receiptRef(1), load: ready(receiptFixture(top)) } })
    .includes('<span class="costco-category" data-node="dining"><span class="visually-hidden">Category: </span>Food Court &amp; Dining</span></span>'));
  // The fuel line, and the online order's line an agent was sure of.
  const gas = textOf(render({ ...PRESENT, receipt: { ref: receiptRef(4), load: ready(receiptFixture(gasDetailFixture())) } }));
  assert.ok(gas.includes('Fuel SAMPLE REGULAR $45.67 13.203 gal at $3.459/gal Category: Automotive › Fuel'), gas);
  const online = render({ ...PRESENT, receipt: { ref: receiptRef(2), load: ready(receiptFixture(onlineDetailFixture())) } });
  assert.ok(textOf(online).includes('Category: Home & Kitchen › Small Appliances'));
  assert.doesNotMatch(online, /Suggested/);
});

test('a precious metal keeps its one tag in place of a chip: by its facts, the asset node, or a metal hold without facts', () => {
  const receipt = warehouseDetailFixture();
  // The widget filed under Precious metals by the owner, and the sparkling water held for metal evidence whatever its
  // node: neither has stored metal facts.
  receipt.lines[0] = { ...receipt.lines[0], category: categoryFixture('precious-metals', { source: 'owner' }) };
  receipt.lines[3] = { ...receipt.lines[3], category: { ...receipt.lines[3].category!, metalHold: true } };
  const html = render({ ...PRESENT, receipt: { ref: receiptRef(1), load: ready(receiptFixture(receipt)) } });
  const line = (n: number) => slice(html, `data-line="${lineRef(n)}"`, 'data-line="');
  for (const n of [1, 3, 4]) {
    assert.equal(line(n).split(COSTCO_METAL_TAG).length - 1, 1, `line ${n}`);
    assert.doesNotMatch(line(n), /costco-category/, `line ${n}`);
  }
  assert.equal(html.split(COSTCO_METAL_TAG).length - 1, 3);
  // Only the silver round has facts to say beside its tag.
  assert.equal(html.split('costco-metal-detail').length - 1, 1);
  assert.ok(textOf(line(3)).includes(`${COSTCO_METAL_TAG} Silver · round · 1 ozt`));
  assert.ok(textOf(line(4)).includes(`Tax Y ${COSTCO_METAL_TAG}`));
  // A hold is the line's own: the fee under the held water keeps its chip.
  assert.ok(textOf(line(5)).includes('Category: Groceries › Beverages'));
});

test('an online order shows its events and shipments; a Shop Card is not a card charge; fuel reads as stated', () => {
  const online = textOf(render({ ...PRESENT, receipt: { ref: receiptRef(2), load: ready(receiptFixture(onlineDetailFixture())) } }));
  for (const words of ['Online order · Oct 20, 2026', 'Delivered', 'Parcel', 'Shipped 1 on Oct 21, 2026', 'Delivered 1 on Oct 23, 2026',
    'UPS · shipped Oct 21, 2026 · delivered Oct 23, 2026', 'Card · Mastercard ···0011 $15.00 In Spending as a card charge',
    'Shop Card $5.00 Not a card charge', 'Shop Card applied $5.00']) {
    assert.ok(online.includes(words), words);
  }
  const gas = textOf(render({ ...PRESENT, receipt: { ref: receiptRef(4), load: ready(receiptFixture(gasDetailFixture())) } }));
  assert.ok(gas.includes('Fuel SAMPLE REGULAR $45.67 13.203 gal at $3.459/gal'));
});

test('a receipt that failed to load says why, with a way back, and offers to try again', () => {
  const html = render({ ...PRESENT, receipt: { ref: receiptRef(1), load: { status: 'error', message: 'This receipt isn\'t in Holdr.' } } });
  const text = textOf(html);
  assert.ok(text.includes('Back to receipts') && text.includes('This receipt isn\'t in Holdr.'));
  assert.match(html, /role="alert"/);
  assert.ok(!text.includes('Try again'), 'no retry without a handler');
  const retry = textOf(render({ ...PRESENT, receipt: { ref: receiptRef(1), load: { status: 'error', message: 'x' } }, onRetryReceipt: () => {} }));
  assert.ok(retry.includes('Try again'));
});
