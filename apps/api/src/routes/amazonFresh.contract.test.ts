import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import request from 'supertest';
import type { Express } from 'express';
import { AMAZON_TAXONOMY_NODES } from '@finance-tracker/shared';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import type { FreshLineRecord } from '../services/amazon/freshSchema.js';
import { digest } from '../services/amazon/policy.js';
import { productKey } from '../services/amazon/products.js';
import { installAmazonTaxonomySchema } from '../services/amazon/taxonomy.js';
import {
  assignFreshHousehold, each, freshDatabase, freshLine, seedFreshHousehold, seedFreshList, seedLedgerRefund, seedOrder, seedRefundTotal, usd,
  weighed,
} from '../services/amazon/freshFixtures.testSupport.js';

/**
 * The Amazon Fresh tab's contract with the API: the web client's own parsers (apps/web/.../amazonFreshApi.ts, which
 * refuse any answer that doesn't add up) read the real routes' answers: before any Fresh import, before any
 * classification, and for every window and order of a household with partial lists, substitutions, missing items,
 * unreadable rows, refunds tied and not tied to lines, another currency and a hidden title. An answer they would refuse
 * fails here. The parsers are loaded at run time, so the API's typecheck never compiles the web workspace. Synthetic
 * only: freshFixtures.testSupport.ts's made-up orders and products.
 */
const WEB_AMAZON = fileURLToPath(new URL('../../../web/src/components/amazon/', import.meta.url));
interface Parsed {
  window: { from: string; to: string };
  captured: boolean;
  assignments: 'present' | 'absent';
  orders: { count: number };
  categories: Array<{ category: string; group: string; netMinor: number }>;
  products: Array<{ title: string | null; category: string }>;
  orderList: Array<{ ref: string; lines: number }>;
}
interface ParsedOrder {
  ref: string;
  refund: { currency: string; refundMinor: number; basis: string; lineRefundMinor: number; unattributedMinor: number } | null;
  lines: Array<{ title: string | null; status: string; category: string; refundMinor: number }>;
}
let parse: (raw: unknown, window: string) => Parsed;
let parseOrder: (raw: unknown) => ParsedOrder;

const ORIGIN = 'http://127.0.0.1:5173', TOKEN = '9a'.repeat(32), FAST = { ln: 10, r: 8, p: 1 };
const WINDOWS = ['30D', '60D', 'YTD', '1Y', '2Y'];
let repo: SqliteStateRepo, app: Express, dir: string, cookie: string;
beforeEach(async () => {
  ({ parseAmazonFresh: parse, parseAmazonFreshOrder: parseOrder } = await import(/* @vite-ignore */ path.join(WEB_AMAZON, 'amazonFreshApi.ts')) as
    { parseAmazonFresh: typeof parse; parseAmazonFreshOrder: typeof parseOrder });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-fresh-contract-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const built = createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, log: () => {} });
  app = built.app;
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN)
    .set('X-Holdr-Request', '1').send({ username: 'alex', password: 'synthetic password' });
  cookie = (login.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('holdr_session='))!.split(';')[0];
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const body = async (url: string): Promise<unknown> => {
  const res = await request(await listenLoopback(app)).get(url).set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
  expect(res.status, url).toBe(200);
  // What the page receives: the response body as text, parsed and checked whole by the web client.
  return JSON.parse(res.text);
};
const read = async (window: string) => parse(await body(`/amazon/fresh?window=${window}&today=2026-10-19`), window);
const readOrder = async (ref: string) => parseOrder(await body(`/amazon/fresh/orders/${ref}`));

/** A deterministic generator (mulberry32): each seed is the same synthetic household on every run. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return { int, chance: (p: number) => next() < p, pick: <T>(list: readonly T[]): T => list[int(0, list.length - 1)] };
}
/** Made-up products: some sold by weight, some without an ASIN, one whose title the card-data guard hides. */
const POOL = [
  { asin: 'SYNTHPORK2', title: 'Synthetic Pork Shoulder', byWeight: true },
  { asin: 'SYNTHBEEF1', title: 'Synthetic Ground Beef', byWeight: true },
  { asin: 'SYNTHBANA1', title: 'Synthetic Organic Bananas', byWeight: true },
  { asin: null, title: 'Synthetic Deli Ham', byWeight: true },
  { asin: 'SYNTHEGGS2', title: 'Synthetic Large Eggs', byWeight: false },
  { asin: 'SYNTHMILK2', title: 'Synthetic Whole Milk', byWeight: false },
  { asin: null, title: 'Synthetic Potato Chips', byWeight: false },
  { asin: 'SYNTHTOWL1', title: 'Synthetic Paper Towels', byWeight: false },
  { asin: 'SYNTHBRED1', title: 'Synthetic Sourdough Loaf', byWeight: false },
  { asin: 'SYNTHJUIC1', title: 'Synthetic Orange Juice', byWeight: false },
  { asin: null, title: 'Synthetic 4111111111111111', byWeight: false },
] as const;
const DAY = 86_400_000;
const GROCERY_NODES = AMAZON_TAXONOMY_NODES.filter((node) => node.id === 'groceries' || node.parent === 'groceries').map((node) => node.id);

/**
 * One random synthetic household: up to a dozen Fresh orders over 26 months (some outside every window), each list
 * whole or partial, with substitutions, missing lines (priced or not), stored rows that can't be read, a list record
 * that can't be read, older lists, euros and a stray currency, orders paid by one card or not, Refund Totals and ledger
 * refunds of any size, and the taxonomy absent, empty or partly filled by the owner and agents at any confidence. Returns
 * each order's ref and date.
 */
function seedRandomHousehold(db: Database, seed: number): Array<{ ref: string; date: string }> {
  const r = generator(seed);
  const line = (currency: string): Omit<FreshLineRecord, 'lineOrdinal'> => {
    const product = r.pick(POOL);
    const status = r.chance(0.12) ? 'substituted' as const : r.chance(0.12) ? 'missing' as const : 'listed' as const;
    const money = (amountMinor: number) => ({ currency, amountMinor });
    let measure: Pick<FreshLineRecord, 'quantity' | 'weight' | 'unitPrice' | 'linePrice'>;
    if (product.byWeight) {
      const value = `${r.int(0, 4)}.${String(r.int(1, 99)).padStart(2, '0')}`, perLb = r.int(49, 1299);
      measure = { quantity: r.chance(0.7) ? 1 : null, weight: { value, unit: 'lb', basis: r.pick(['actual', 'estimated', 'unlabeled'] as const) },
        unitPrice: { money: money(perLb), per: 'lb' }, linePrice: money(Math.max(1, Math.round(Number(value) * perLb))) };
    } else {
      const quantity = r.int(1, 4), unit = r.int(99, 999);
      measure = { quantity, weight: null, unitPrice: r.chance(0.8) ? { money: money(unit), per: 'each' } : null, linePrice: money(quantity * unit) };
    }
    // A missing line shows its listed price or doesn't; rarely, a listed line was stored without one (unreadable).
    const unpriced = status === 'missing' ? r.chance(0.5) : status === 'listed' && r.chance(0.03);
    return freshLine(product.title, { asin: product.asin, status, ...measure, linePrice: unpriced ? null : measure.linePrice,
      replaces: status === 'substituted' ? 'Synthetic Original Item' : null });
  };
  const orders = Array.from({ length: r.int(1, 12) }, (_, n) => {
    const name = `S${seed}-${n}`, date = new Date(Date.UTC(2024, 8, 1) + r.int(0, 790) * DAY).toISOString().slice(0, 10);
    const currency = r.chance(0.15) ? 'EUR' : 'USD', other = currency === 'USD' ? 'EUR' : 'USD';
    const rows: Array<Omit<FreshLineRecord, 'lineOrdinal'> | { raw: unknown }> = Array.from({ length: r.int(0, 7) },
      () => line(r.chance(0.04) ? other : currency));
    if (r.chance(0.1)) rows.splice(r.int(0, rows.length), 0, { raw: { title: 'Synthetic unreadable row' } });
    const delivered = rows.flatMap((row) => ('raw' in row || row.status === 'missing' || row.linePrice?.currency !== currency ? []
      : [row.linePrice.amountMinor]));
    const items = delivered.reduce((sum, amount) => sum + amount, 0);
    const subtotal = r.chance(0.8) ? items : items + r.int(1, 300), tax = r.chance(0.4) ? Math.round(subtotal * r.int(1, 10) / 100) : 0;
    const total = r.chance(0.1) ? null : { currency, amountMinor: subtotal + tax };
    const ref = seedOrder(db, name, date, total, r.chance(0.85) ? subtotal : undefined, tax,
      r.chance(0.5) ? { tenderCoverage: 'single-card-proven' } : {});
    if (r.chance(0.15)) seedFreshList(db, ref, [line(currency)], { label: 'older', latest: false });
    const unreadRows = r.chance(0.25) ? r.int(1, 2) : 0;
    const statedCount = r.chance(0.7) ? undefined : r.chance(0.5) ? null : rows.length + unreadRows + r.int(1, 2);
    const { listDigest } = seedFreshList(db, ref, rows, { unreadRows, statedCount, reconciled: r.chance(0.2) ? false : undefined });
    if (r.chance(0.05)) db.prepare('UPDATE amazon_fresh_lists SET data_json=? WHERE digest=?').run('{"synthetic":"unreadable"}', listDigest);
    // Refunds of a line's price, of the whole order, or of anything up to it, one to three of them.
    const refunds = r.chance(0.45) ? r.int(1, 3) : 0;
    for (let k = 0; k < refunds; k++) {
      const amountMinor = delivered.length > 0 && r.chance(0.5) ? r.pick(delivered)
        : r.chance(0.3) ? total?.amountMinor ?? 0 : r.int(1, Math.max(1, subtotal + tax));
      if (amountMinor < 1) continue;
      if (r.chance(0.4)) seedRefundTotal(db, name, { currency, amountMinor });
      else seedLedgerRefund(db, name, new Date(Date.parse(date) + r.int(1, 20) * DAY).toISOString().slice(0, 10), { currency, amountMinor }, 0, n * 10 + k);
    }
    return { ref, date };
  });
  const taxonomy = r.int(0, 2);
  if (taxonomy > 0) {
    db.transaction(() => {
      installAmazonTaxonomySchema(db);
      for (const product of POOL) {
        if (taxonomy === 1 || !r.chance(0.75)) continue;
        const source = r.chance(0.4) ? 'owner' : 'agent', confidence = source === 'owner' ? 1 : r.pick([0.95, 0.85, 0.7, 0.6, 0.5, 0.3]);
        const node = r.chance(0.6) ? r.pick(GROCERY_NODES) : r.pick(AMAZON_TAXONOMY_NODES).id;
        db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)')
          .run(productKey(product), source, node, confidence, digest('synthetic mapping'));
      }
    })();
  }
  return orders;
}

describe('Amazon Fresh: API answers the web client reads', () => {
  it('reads before any Fresh import as never captured, in every window', async () => {
    for (const window of WINDOWS) expect(await read(window)).toMatchObject({ captured: false, assignments: 'absent', orders: { count: 0 } });
  });

  it('reads every window and every order of the household, before and after its products are classified', async () => {
    const db = repo.internalGetDb();
    freshDatabase(db);
    const refs = seedFreshHousehold(db);
    // Two more ways a refund lands: a whole-order Refund Total (the missing line, listed at a price, is never charged or
    // refunded), and one larger than what the lines still cost.
    const whole = seedOrder(db, 'W1', '2026-10-02', usd(1080), 1000, 80);
    seedFreshList(db, whole, [freshLine('Synthetic Whole Milk', { asin: 'SYNTHMILK2', ...each(2, 300) }),
      freshLine('Synthetic Ground Beef', { quantity: 1, ...weighed('1.00', 400, 400) }),
      freshLine('Synthetic Cream Cheese', { status: 'missing', ...each(1, 250) })]);
    seedRefundTotal(db, 'W1', usd(1080));
    const capped = seedOrder(db, 'G1', '2026-10-01', usd(1000), 450);
    seedFreshList(db, capped, [freshLine('Synthetic Cheddar', { quantity: 1, linePrice: usd(200) }),
      freshLine('Synthetic Bagels', { quantity: 1, linePrice: usd(250) })]);
    seedRefundTotal(db, 'G1', usd(800));
    // And refunds partly tied to a line: two ledger refunds of a whole list paid by one card, one exactly a line's price.
    const partly = seedOrder(db, 'P1', '2026-09-30', usd(8000), 8000, 0, { tenderCoverage: 'single-card-proven' });
    seedFreshList(db, partly, [freshLine('Synthetic Salmon Fillet', each(1, 1500)), freshLine('Synthetic Jasmine Rice', each(1, 2500)),
      freshLine('Synthetic Olive Oil', each(1, 4000))]);
    seedLedgerRefund(db, 'P1', '2026-10-03', usd(1500), 1, 0);
    seedLedgerRefund(db, 'P1', '2026-10-04', usd(700), 1, 1);
    const all = [...Object.values(refs), whole, capped, partly];

    for (const classified of [false, true]) {
      if (classified) assignFreshHousehold(db);
      for (const window of WINDOWS) {
        const view = await read(window);
        expect(view.captured).toBe(true);
        expect(view.assignments).toBe(classified ? 'present' : 'absent');
        expect(view.orders.count, window).toBeGreaterThan(0);
        if (!classified) expect(view.categories.every((row) => row.group === 'needs-review'), window).toBe(true);
      }
      for (const ref of all) expect((await readOrder(ref)).ref).toBe(ref);
    }
    const year = await read('1Y');
    expect(year.categories.map((row) => row.category)).toEqual(expect.arrayContaining(['groceries/meat-seafood', 'groceries/dairy-eggs',
      'groceries/produce', 'groceries/snacks-sweets', 'household', 'needs-review']));
    expect(year.products.find((product) => product.title === null)).toMatchObject({ category: 'needs-review' });
    expect((await readOrder(whole)).lines.map((line) => [line.status, line.refundMinor])).toEqual([['listed', 600], ['listed', 400],
      ['missing', 0]]);
    expect((await readOrder(refs.f2)).lines.map((line) => line.status)).toEqual(['listed', 'substituted', 'missing', 'listed']);
    const split = await readOrder(partly);
    expect([split.refund, split.lines.map((line) => line.refundMinor)]).toEqual([
      { currency: 'USD', refundMinor: 2200, basis: 'partly', lineRefundMinor: 1500, unattributedMinor: 700 }, [1500, 0, 0]]);
  });

  // STEP 9 integration B6 (#158 x #157/#169): an order displayed as charge-free keeps its list as history but counts none of
  // its lines; the answers show the proof, and still add up for the web client.
  it('reads an order whose displayed decision is a charge-free proof: no line counted, the proof shown', async () => {
    const db = repo.internalGetDb();
    freshDatabase(db);
    const proof = { status: 'cancelled-not-charged', shipments: 1 } as const;
    const proven = seedOrder(db, 'C1', '2026-10-05', null, undefined, 0, { chargeFree: { ...proof } });
    seedFreshList(db, proven, [freshLine('Synthetic Fresh Gala Apples', each(2, 250)), freshLine('Synthetic Fresh Rye Bread', each(1, 500))]);
    const counted = seedOrder(db, 'C2', '2026-10-06', usd(700), 700);
    seedFreshList(db, counted, [freshLine('Synthetic Fresh Whole Milk', each(1, 700))]);
    const raw = await body('/amazon/fresh?window=1Y&today=2026-10-19') as { orderList: Array<Record<string, unknown>> };
    expect(raw.orderList.find((order) => order.ref === proven)).toMatchObject({ lines: 0, priced: 0, lineTotal: null, chargeFree: proof });
    expect(Object.hasOwn(raw.orderList.find((order) => order.ref === counted)!, 'chargeFree')).toBe(false);
    const view = parse(raw, '1Y');
    expect(view.orders.count).toBe(2);
    expect(view.products.map((product) => product.title)).toEqual(['Synthetic Fresh Whole Milk']);
    const detail = await body(`/amazon/fresh/orders/${proven}`) as { order: Record<string, unknown> };
    expect(detail.order).toMatchObject({ lines: [], list: { rows: 2, lines: 0, unreadable: 0 }, chargeFree: proof });
    expect(parseOrder(detail)).toMatchObject({ ref: proven, lines: [] });
  });

  // Whatever the household, the web client reads every answer: a refusal here is the client calling true data inconsistent.
  it.each(Array.from({ length: 32 }, (_, n) => 1000 + n))('reads every window and order of random synthetic household %i', async (seed) => {
    const db = repo.internalGetDb();
    freshDatabase(db);
    const orders = seedRandomHousehold(db, seed);
    for (const window of WINDOWS) {
      const view = await read(window);
      const held = orders.filter((order) => order.date >= view.window.from && order.date <= view.window.to);
      expect(view.orders.count, window).toBe(held.length);
      expect(view.orderList.map((order) => order.ref).sort(), window).toEqual(held.map((order) => order.ref).sort());
    }
    for (const { ref } of orders) expect((await readOrder(ref)).ref).toBe(ref);
  });
});
