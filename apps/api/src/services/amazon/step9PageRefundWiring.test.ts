import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, importAmazonCapture } from './importer.js';
import { syntheticCapture, syntheticEvidence, syntheticReturnsCapture, withRefundEvidence } from './fixtures.testSupport.js';
import { amazonFresh, amazonFreshOrder } from './fresh.js';
import { opaque } from './policy.js';
import { hasRefundEventSchema } from './schema.js';
import { amazonSpending } from './spending.js';
import { amazonTaxonomySpending } from './taxonomySpending.js';
import type { Money, RefundEvidence, RefundEvidencePhrase } from './types.js';

// STEP 9 integration (#166 × #161, #169), Root ruling 2: GET /amazon/spending/taxonomy and GET /amazon/fresh take page
// refund statements off exactly as GET /amazon/spending does, and answer byte for byte as before without them.
// Entirely synthetic: invented order IDs, ASINs, titles and amounts.
const TODAY = '2026-10-19';
const ORDER = '000-0000001-0000001';
const WINDOWS = ['30D', '60D', 'YTD', '1Y', '2Y'] as const;
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const sum = (values: readonly number[]) => values.reduce((n, v) => n + v, 0);
type Capture = ReturnType<typeof syntheticCapture> & { fresh?: unknown };
type Json = Record<string, any>;

let dir: string, repo: SqliteStateRepo, backups: number, runs: number;
const db = () => repo.internalGetDb();
const runId = () => `00000000-0000-4000-8000-${String(++runs).padStart(12, '0')}`;
const save = (capture: Capture) => importAmazonCapture(db(), structuredClone(capture), path.join(dir, `backup-${++backups}.db`));
function open() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-step9-page-refunds-synthetic-'));
  backups = 0;
  runs = 100;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
}
function close() { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); }
beforeEach(open);
afterEach(close);
/** A database last written before #155's tables: what every route read before page refund statements existed. */
const dropEventTables = () => backedUpWrite(db(), path.join(dir, `backup-${++backups}.db`), () => {
  db().exec('DROP TABLE amazon_refund_event_members; DROP TABLE amazon_refund_events;');
}, () => undefined);

interface Line { lineOrdinal: number; itemId: string | null; title: string; quantity: number; unitPrice: Money }
/** The order as a capture reads it, with its Fresh Item List line for line its items, so every route sees one cart. */
function orderCapture(lines: Line[], tax: number, shipping: number, refundSummary?: number, promotion = 0): Capture {
  const capture: Capture = syntheticCapture();
  capture.staging.runId = runId();
  const order = capture.staging.orders[0];
  const subtotal = sum(lines.map(line => line.quantity * line.unitPrice.amountMinor));
  const total = subtotal + tax + shipping - promotion;
  order.items = lines.map(line => ({ ...line, unitPrice: { ...line.unitPrice } }));
  order.total = usd(total);
  order.summary = [{ kind: 'items-subtotal', money: usd(subtotal) }, { kind: 'shipping', money: usd(shipping) },
    { kind: 'tax', money: usd(tax) }, ...(promotion ? [{ kind: 'promotion' as const, money: usd(promotion) }] : []),
    { kind: 'grand-total', money: usd(total) }];
  order.itemProof = { complete: true, unknownLine: false, conflict: false };
  if (refundSummary !== undefined) order.refundSummary = usd(refundSummary);
  capture.staging.coverage.details.records = lines.length;
  capture.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
    lists: [{ orderId: ORDER, statedCount: lines.length, rows: lines.length, proof: { complete: true, unreadRows: 0 }, reconciled: true,
      lines: lines.map(line => ({ lineOrdinal: line.lineOrdinal, title: line.title, asin: line.itemId, status: 'listed',
        quantity: line.quantity, weight: null, unitPrice: { money: usd(line.unitPrice.amountMinor), per: 'each' },
        linePrice: usd(line.quantity * line.unitPrice.amountMinor), replaces: null })) }],
    diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: lines.length, lines: lines.length, unread: [] }] };
  return capture;
}

/** What each route says of refunds and nets: orders refunded, per currency, and per item (its ASIN, else its title). */
function items(products: Json[]) {
  const byItem = new Map<string, number[]>();
  for (const p of products) {
    const key = JSON.stringify([p.currency, p.asin ?? p.title]), entry = byItem.get(key) ?? [0, 0];
    byItem.set(key, [entry[0] + p.amountMinor, entry[1] + p.refundMinor]);
  }
  return [...byItem].sort(([a], [b]) => (a < b ? -1 : 1));
}
const categoryNets = (v: Json) => ({ refunded: v.orders.refunded, items: items(v.products),
  totals: v.totals.map((t: Json) => [t.currency, t.itemMinor, t.refundMinor, t.itemRefundMinor, t.unattributedRefundMinor, t.netItemMinor]) });
const taxonomyNets = categoryNets;
const freshNets = (v: Json) => ({ refunded: v.orders.refunded, items: items(v.products),
  totals: v.totals.map((t: Json) => [t.currency, t.lineMinor, t.refundMinor, t.lineRefundMinor, t.unattributedRefundMinor, t.netLineMinor]) });
const routes = (window: string) => ({
  category: JSON.parse(JSON.stringify(amazonSpending(db(), window as never, TODAY))) as Json,
  taxonomy: JSON.parse(JSON.stringify(amazonTaxonomySpending(db(), window as never, TODAY))) as Json,
  fresh: JSON.parse(JSON.stringify(amazonFresh(db(), window as never, TODAY))) as Json,
});

describe('page refund statements in the taxonomy and Fresh views', () => {
  it('takes a fully refunded order off to nothing by category, by taxonomy node and in Fresh, from order details alone', async () => {
    const lines: Line[] = [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: 'Synthetic oat milk', quantity: 2, unitPrice: usd(450) },
      { lineOrdinal: 1, itemId: null, title: 'Synthetic sourdough loaf', quantity: 1, unitPrice: usd(600) }];
    await save(withRefundEvidence(orderCapture(lines, 150, 0), [syntheticEvidence({ money: usd(1650), items: [],
      provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-issued' } })]));
    const { category, taxonomy, fresh } = routes('2Y');
    expect(category.totals[0]).toMatchObject({ itemMinor: 1500, refundMinor: 1650, itemRefundMinor: 1500, netItemMinor: 0 });
    expect(taxonomy.totals[0]).toMatchObject({ itemMinor: 1500, refundMinor: 1650, itemRefundMinor: 1500, unattributedRefundMinor: 0,
      netItemMinor: 0 });
    expect(taxonomy.nodes.every((node: Json) => node.netMinor === 0)).toBe(true);
    expect(fresh.totals[0]).toMatchObject({ lineMinor: 1500, refundMinor: 1650, lineRefundMinor: 1500, unattributedRefundMinor: 0,
      netLineMinor: 0 });
    expect(amazonFreshOrder(db(), opaque('order', ORDER))?.refund).toEqual({ currency: 'USD', refundMinor: 1650, basis: 'whole-order',
      lineRefundMinor: 1500, unattributedMinor: 0 });
    expect(taxonomyNets(taxonomy)).toEqual(categoryNets(category));
    expect(freshNets(fresh)).toEqual(categoryNets(category));
    // Before #155's tables, nothing was refunded on any route.
    await dropEventTables();
    expect(hasRefundEventSchema(db())).toBe(false);
    const before = routes('2Y');
    expect([before.category.totals[0].refundMinor, before.taxonomy.totals[0].refundMinor, before.fresh.totals[0].refundMinor])
      .toEqual([0, 0, 0]);
  });

  it('keeps a composed whole-order refund\'s exact cents after a promotion on every route, Fresh list and order alike', async () => {
    // 4000 of items, 400 off: 3600 refunded in full takes 3600 off them (by price: 900 and 2700), never 4000.
    const lines: Line[] = [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: 'Synthetic olive oil', quantity: 1, unitPrice: usd(1000) },
      { lineOrdinal: 1, itemId: 'SYNTH00002', title: 'Synthetic coffee beans', quantity: 1, unitPrice: usd(3000) }];
    await save(withRefundEvidence(orderCapture(lines, 0, 0, undefined, 400), [syntheticEvidence({ money: usd(3600), items: [],
      provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-issued' } })]));
    const { category, taxonomy, fresh } = routes('2Y');
    expect(category.totals[0]).toMatchObject({ itemMinor: 4000, refundMinor: 3600, itemRefundMinor: 3600, netItemMinor: 400 });
    expect(fresh.totals[0]).toMatchObject({ lineMinor: 4000, refundMinor: 3600, lineRefundMinor: 3600, unattributedRefundMinor: 0,
      netLineMinor: 400 });
    expect(taxonomyNets(taxonomy)).toEqual(categoryNets(category));
    expect(freshNets(fresh)).toEqual(categoryNets(category));
    const order = amazonFreshOrder(db(), opaque('order', ORDER))!;
    expect(order.refund).toEqual({ currency: 'USD', refundMinor: 3600, basis: 'whole-order', lineRefundMinor: 3600, unattributedMinor: 0 });
    expect(order.lines.map(line => line.refundMinor)).toEqual([900, 2700]);
  });

  it('nets exactly as by category on every route, over generated histories, and answers byte for byte as before without them', async () => {
    // A seeded generator (mulberry32): the same histories every run.
    let state = 20261022;
    const rand = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T>(list: readonly T[]): T => list[int(list.length)];
    const ISSUED: RefundEvidencePhrase[] = ['refund-issued', 'refund-complete', 'refund-processed', 'refunded'];
    const RETURNS: Array<[RefundEvidencePhrase, string]> = [['return-created', 'started'], ['return-started', 'started'],
      ['return-in-transit', 'in-transit'], ['return-received', 'received'], ['return-complete', 'completed'], ['return-cancelled', 'cancelled']];
    const seen = { scenarios: 0, issued: 0, unissued: 0, promotedIssued: 0, windows: 0, changed: { taxonomy: 0, fresh: 0 } };
    for (let s = 0; s < 60; s++) {
      if (s > 0) { close(); open(); }
      // A cart of one to four lines (some without an ASIN), tax, shipping and a promotion or not; a Refund Total, ledger
      // refunds, order-details and Returns-page statements in every status, later runs and any import order.
      const lines: Line[] = Array.from({ length: 1 + int(4) }, (_, k) => ({ lineOrdinal: k,
        itemId: rand() < 0.8 ? `SYNTH${String(k + 1).padStart(5, '0')}` : null, title: `Synthetic pantry item ${k}`,
        quantity: 1 + int(3), unitPrice: usd(100 + int(4900)) }));
      const subtotal = sum(lines.map(line => line.quantity * line.unitPrice.amountMinor));
      const tax = rand() < 0.3 ? 0 : Math.round(subtotal * (0.05 + rand() * 0.05)), shipping = rand() < 0.6 ? 0 : int(1000);
      const promotion = rand() < 0.4 ? 1 + int(Math.floor(subtotal / 4)) : 0;
      const total = subtotal + tax + shipping - promotion;
      const share = (price: number) => price + Math.round(price * tax / subtotal);
      const amount = () => {
        const line = pick(lines);
        return [share(line.unitPrice.amountMinor), share(line.quantity * line.unitPrice.amountMinor), total, 1 + int(total),
          line.unitPrice.amountMinor, share(sum(lines.slice(0, 1 + int(lines.length)).map(l => l.unitPrice.amountMinor)))][int(6)];
      };
      let issued = false;
      const statement = (source: 'order-details' | 'returns-page', ordinal: number): RefundEvidence => {
        const roll = rand();
        let kind = 'refund', status = 'pending', phrase: RefundEvidencePhrase, money: Money | null = null, date: string | null = null;
        if (roll < 0.5) {
          phrase = pick(ISSUED); status = 'completed'; issued = true;
          money = rand() < 0.8 ? usd(amount()) : null;
          date = rand() < 0.5 ? (source === 'returns-page' ? '2026-09-04' : '2026-09-10') : null;
        } else if (roll < 0.75) {
          phrase = pick(['refund-pending', 'refund-for-return'] as RefundEvidencePhrase[]);
        } else {
          [phrase, status] = pick(RETURNS); kind = 'return';
          date = source === 'returns-page' ? '2026-09-04' : (rand() < 0.5 ? '2026-09-10' : null);
        }
        const chosen = lines.filter(() => rand() < 0.5);
        const units = (line: Line) => (rand() < 0.75 ? null : 1 + int(line.quantity));
        const named = source === 'order-details'
          ? (rand() < 0.2 ? [] : chosen.map(line => ({ lineOrdinal: line.lineOrdinal, itemId: line.itemId, title: null, units: units(line) })))
          : (rand() < 0.1 ? [] : chosen.map(line => ({ lineOrdinal: null, itemId: line.itemId, title: line.itemId ? null : line.title,
            units: units(line) })));
        return syntheticEvidence({ kind, status, money, items: named, date,
          provenance: { source, page: 0, ordinal, phrase } } as Partial<RefundEvidence>);
      };
      const first = orderCapture(lines, tax, shipping, rand() < 0.4 ? amount() : undefined, promotion);
      if (rand() < 0.3) {
        first.staging.payments.push({ date: '2026-09-12', money: usd(-amount()), kind: 'refund', status: 'completed',
          method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [ORDER], identity: 'native-row',
          provenance: { source: 'ledger', status: 'Refunded', page: 0, ordinal: 0 } });
        first.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
      }
      const captures: Capture[] = [withRefundEvidence(first, rand() < 0.6
        ? Array.from({ length: 1 + int(3) }, (_, i) => statement('order-details', i)) : [])];
      if (rand() < 0.5) {
        const returns: Capture = syntheticReturnsCapture(Array.from({ length: 1 + int(3) }, (_, i) => statement('returns-page', i)));
        returns.staging.runId = runId();
        captures.push(returns);
      }
      if (rand() < 0.35) {
        // A later run of the same order: the same reads, or each statement re-rolled (a status or amount moved on).
        const again = structuredClone(captures[0]);
        again.staging.runId = runId();
        if (rand() < 0.5) again.staging.refundEvidence = (again.staging.refundEvidence ?? [])
          .map(record => ({ ...statement('order-details', record.provenance.ordinal), items: record.items }));
        captures.push(withRefundEvidence(again, []));
      }
      for (const capture of rand() < 0.5 ? captures : [...captures].sort(() => rand() - 0.5)) await save(capture);
      seen.scenarios++;
      if (issued) seen.issued++; else seen.unissued++;
      if (issued && promotion) seen.promotedIssued++;

      const after = new Map<string, ReturnType<typeof routes>>();
      for (const window of WINDOWS) {
        const views = routes(window);
        after.set(window, views);
        expect(taxonomyNets(views.taxonomy), `scenario ${s} ${window}: taxonomy`).toEqual(categoryNets(views.category));
        expect(freshNets(views.fresh), `scenario ${s} ${window}: Fresh`).toEqual(categoryNets(views.category));
        seen.windows++;
      }
      const order = JSON.stringify(amazonFreshOrder(db(), opaque('order', ORDER)));
      expect(JSON.parse(order).refund, `scenario ${s}: Fresh order`).toEqual(after.get('2Y')!.fresh.orderList[0].refund);
      // Without #155's tables, every route reads exactly as before page refund statements: unchanged unless one was issued.
      await dropEventTables();
      for (const window of WINDOWS) {
        const before = routes(window), now = after.get(window)!;
        for (const route of ['category', 'taxonomy', 'fresh'] as const) {
          const same = JSON.stringify(before[route]) === JSON.stringify(now[route]);
          if (!issued) expect(same, `scenario ${s} ${window}: ${route} without an issued statement`).toBe(true);
          else if (!same && route !== 'category' && window === '2Y') seen.changed[route]++;
        }
      }
      if (!issued) expect(JSON.stringify(amazonFreshOrder(db(), opaque('order', ORDER)))).toBe(order);
    }
    // Every route was compared on every window, with and without issued statements, and the wiring changed both views.
    expect(seen.scenarios).toBe(60);
    expect(seen.windows).toBe(300);
    expect(seen.issued).toBeGreaterThan(20);
    expect(seen.unissued).toBeGreaterThan(10);
    expect(seen.promotedIssued).toBeGreaterThan(8);
    expect(seen.changed.taxonomy).toBeGreaterThan(10);
    expect(seen.changed.fresh).toBeGreaterThan(10);
  }, 600_000);
});
