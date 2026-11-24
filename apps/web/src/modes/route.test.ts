import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ROUTES,
  EVERYDAY_AREAS,
  INVESTING_TABS,
  MODE_STORAGE_KEY,
  formatRoute,
  parseRoute,
  readStoredMode,
  resolveRoute,
  routeTitle,
  storeMode,
  type ModeRoute,
} from './route';

const every: ModeRoute[] = [
  ...INVESTING_TABS.map((tab) => ({ mode: 'investing' as const, tab })),
  ...EVERYDAY_AREAS.map((area) => ({ mode: 'everyday' as const, area })),
];

test('every route round-trips through its hash', () => {
  assert.deepEqual(every.map(formatRoute), [
    '#/investing/portfolio', '#/investing/gold', '#/investing/transactions', '#/investing/add', '#/investing/import', '#/investing/accounts',
    '#/everyday/transactions', '#/everyday/benefits', '#/everyday/amazon', '#/everyday/costco', '#/everyday/sync', '#/everyday/devices',
  ]);
  for (const route of every) assert.deepEqual(parseRoute(formatRoute(route)), route);
});

const ORDER_REF = `amz-${'0123456789abcdef'.repeat(3)}`;

test('an Amazon order has its own page below the Amazon area', () => {
  const route: ModeRoute = { mode: 'everyday', area: 'amazon', amazonOrder: ORDER_REF };
  assert.equal(formatRoute(route), `#/everyday/amazon/orders/${ORDER_REF}`);
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(resolveRoute(`#/everyday/amazon/orders/${ORDER_REF}`, null), { route, canonical: true });
  // Letter case and a trailing slash are tolerated, then rewritten; refs are lowercase by construction.
  assert.deepEqual(resolveRoute(`#/Everyday/Amazon/Orders/${ORDER_REF.toUpperCase()}/`, null), { route, canonical: false });
  // An order ref outside the Amazon area is dropped, so its hash spells the area alone.
  assert.equal(formatRoute({ mode: 'everyday', area: 'benefits', amazonOrder: ORDER_REF }), '#/everyday/benefits');
});

test('a malformed or missing order ref opens the Amazon list instead', () => {
  for (const ref of ['', 'x', `${ORDER_REF}0`, ORDER_REF.slice(0, -1), `amz-${'g'.repeat(48)}`, '000-0000001-0000001']) {
    assert.deepEqual(resolveRoute(`#/everyday/amazon/orders/${ref}`, null), { route: { mode: 'everyday', area: 'amazon' }, canonical: false }, ref);
  }
});

test('the Amazon area\'s Amazon Fresh tab has its own address', () => {
  const route: ModeRoute = { mode: 'everyday', area: 'amazon', amazonView: 'fresh' };
  assert.equal(formatRoute(route), '#/everyday/amazon/fresh');
  assert.deepEqual(parseRoute('#/everyday/amazon/fresh'), route);
  assert.deepEqual(resolveRoute('#/everyday/amazon/fresh', null), { route, canonical: true });
  assert.deepEqual(resolveRoute('#/Everyday/Amazon/FRESH/', 'investing'), { route, canonical: false });
  // An order's own page wins over the tab, and the tab is the Amazon area's alone.
  assert.equal(formatRoute({ mode: 'everyday', area: 'amazon', amazonOrder: ORDER_REF, amazonView: 'fresh' }), `#/everyday/amazon/orders/${ORDER_REF}`);
  assert.equal(formatRoute({ mode: 'everyday', area: 'benefits', amazonView: 'fresh' }), '#/everyday/benefits');
  for (const hash of ['#/everyday/benefits/fresh', '#/investing/amazon/fresh', '#/everyday/amazon/fresh/x', '#/everyday/amazon/freshx',
    '#/everyday/fresh/orders/x']) {
    assert.equal(parseRoute(hash), null, hash);
  }
  assert.equal(routeTitle(route), 'Amazon Fresh · Everyday · Holdr');
});

test('only the Amazon area has pages below it', () => {
  for (const hash of [`#/everyday/sync/orders/${ORDER_REF}`, `#/investing/portfolio/orders/${ORDER_REF}`, `#/everyday/amazon/items/${ORDER_REF}`,
    `#/everyday/amazon/orders/${ORDER_REF}/items`, '#/everyday/orders/x', `#/everyday/costco/orders/${ORDER_REF}`, '#/everyday/costco/fresh',
    `#/everyday/costco/rcp-${'a'.repeat(32)}`]) {
    assert.equal(parseRoute(hash), null, hash);
  }
});

test('the Costco receipts page is an Everyday area of its own, after Amazon; a receipt opens in place, with no address', () => {
  const route: ModeRoute = { mode: 'everyday', area: 'costco' };
  assert.deepEqual(resolveRoute('#/everyday/costco', null), { route, canonical: true });
  assert.deepEqual(resolveRoute('#/Everyday/Costco/', 'investing'), { route, canonical: false });
  // Amazon's own pages stay Amazon's: an order or tab named under Costco is dropped from its address.
  assert.equal(formatRoute({ mode: 'everyday', area: 'costco', amazonOrder: ORDER_REF, amazonView: 'fresh' }), '#/everyday/costco');
  assert.equal(routeTitle(route), 'Costco receipts · Everyday · Holdr');
});

test('a hash that names no mode names no route', () => {
  for (const hash of ['', '#', '#/', '#portfolio', '#/portfolio', '#/settings/x', '#/investingx', '#/everyday/sync/extra', '#holdings']) {
    assert.equal(parseRoute(hash), null, hash);
  }
});

test('a known mode without a known section opens its first section', () => {
  assert.deepEqual(parseRoute('#/investing'), DEFAULT_ROUTES.investing);
  assert.deepEqual(parseRoute('#/investing/'), DEFAULT_ROUTES.investing);
  assert.deepEqual(parseRoute('#/investing/nope'), DEFAULT_ROUTES.investing);
  assert.deepEqual(parseRoute('#/everyday'), DEFAULT_ROUTES.everyday);
  assert.deepEqual(parseRoute('#/everyday/portfolio'), DEFAULT_ROUTES.everyday);
});

test('the Spending tab\'s old place in Investing opens Everyday', () => {
  assert.deepEqual(parseRoute('#/investing/spending'), { mode: 'everyday', area: 'transactions' });
});

test('letter case and a trailing slash are tolerated, then rewritten', () => {
  assert.deepEqual(resolveRoute('#/Everyday/SYNC/', null), { route: { mode: 'everyday', area: 'sync' }, canonical: false });
  assert.deepEqual(resolveRoute('#/everyday/sync', null), { route: { mode: 'everyday', area: 'sync' }, canonical: true });
});

test('without a route in the address, the mode used last opens, and Investing on a first visit', () => {
  assert.deepEqual(resolveRoute('', null), { route: DEFAULT_ROUTES.investing, canonical: false });
  assert.deepEqual(resolveRoute('', 'everyday'), { route: DEFAULT_ROUTES.everyday, canonical: false });
  assert.deepEqual(resolveRoute('#holdings', 'investing'), { route: DEFAULT_ROUTES.investing, canonical: false });
  // The address wins over the stored mode.
  assert.deepEqual(resolveRoute('#/investing/accounts', 'everyday'), { route: { mode: 'investing', tab: 'accounts' }, canonical: true });
});

test('only the mode\'s name is stored, and storage failures are ignored', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readStoredMode(storage), null);
  storeMode(storage, 'everyday');
  assert.deepEqual([...values], [[MODE_STORAGE_KEY, 'everyday']]);
  assert.equal(readStoredMode(storage), 'everyday');
  values.set(MODE_STORAGE_KEY, '{"mode":"everyday"}');
  assert.equal(readStoredMode(storage), null);

  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(readStoredMode(broken), null);
  assert.doesNotThrow(() => storeMode(broken, 'investing'));
  assert.equal(readStoredMode(null), null);
  assert.doesNotThrow(() => storeMode(null, 'investing'));
});

test('each route has its own title', () => {
  assert.equal(routeTitle({ mode: 'investing', tab: 'portfolio' }), 'Portfolio · Investing · Holdr');
  assert.equal(routeTitle({ mode: 'investing', tab: 'gold' }), 'Gold · Investing · Holdr');
  assert.equal(routeTitle({ mode: 'everyday', area: 'sync' }), 'Sync & coverage · Everyday · Holdr');
  assert.equal(routeTitle({ mode: 'everyday', area: 'benefits' }), 'Benefits · Everyday · Holdr');
  assert.equal(routeTitle({ mode: 'everyday', area: 'amazon' }), 'Amazon · Everyday · Holdr');
  assert.equal(routeTitle({ mode: 'everyday', area: 'amazon', amazonOrder: ORDER_REF }), 'Amazon order · Everyday · Holdr');
  assert.equal(routeTitle({ mode: 'everyday', area: 'costco' }), 'Costco receipts · Everyday · Holdr');
  assert.equal(new Set(every.map(routeTitle)).size, every.length);
});
