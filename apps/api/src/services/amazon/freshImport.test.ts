import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { importAmazonCapture } from './importer.js';
import { syntheticCapture } from './fixtures.testSupport.js';
import { validateCapture } from './capture.js';
import { ensureAmazonSchema } from './schema.js';
import { opaque } from './policy.js';
import { AMAZON_FRESH_TABLES, hasAmazonFreshSchema, installAmazonFreshSchema } from './freshSchema.js';
import { singleCardProven } from './tender.js';
import type { Money, OrderObservation } from './types.js';

// Entirely synthetic: made-up order IDs, titles, weights and prices.
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const ORDER = '000-0000001-0000001';
const line = (lineOrdinal: number, title: string, patch: Record<string, unknown>) => ({ lineOrdinal, title, asin: null, status: 'listed',
  quantity: 1, weight: null, unitPrice: null, linePrice: null, replaces: null, ...patch });
/** The synthetic capture's order with its Fresh Item List: two lines adding up to its $10.00 item subtotal. */
function freshCapture(lines = [
  line(0, 'Synthetic Pork Shoulder', { weight: { value: '1.25', unit: 'lb', basis: 'unlabeled' },
    unitPrice: { money: usd(399), per: 'lb' }, linePrice: usd(499) }),
  line(1, 'Synthetic Large Eggs', { linePrice: usd(501) }),
]) {
  const capture = syntheticCapture() as ReturnType<typeof syntheticCapture> & { fresh?: unknown };
  const reconciled = lines.reduce((n, l) => n + ((l.linePrice as Money | null)?.amountMinor ?? 0), 0) === 1000;
  capture.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
    lists: [{ orderId: ORDER, statedCount: lines.length, rows: lines.length, proof: { complete: true, unreadRows: 0 }, reconciled, lines }],
    diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: lines.length, lines: lines.length, unread: [] }] };
  return capture;
}

let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const rows = (sql: string, ...args: unknown[]) => db().prepare(sql).all(...args) as Array<Record<string, unknown>>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-fresh-synthetic-'));
  backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('Amazon Fresh Item Lists through the GO-gated importer', () => {
  it('installs the additive Fresh tables only inside an import that carries a list, and never at boot', async () => {
    expect(hasAmazonFreshSchema(db())).toBe(false);
    await importAmazonCapture(db(), syntheticCapture(), backup());
    expect(hasAmazonFreshSchema(db()), 'a capture without Fresh lists installs nothing').toBe(false);
    expect(rows("SELECT name FROM sqlite_master WHERE name LIKE 'amazon_fresh_%'")).toEqual([]);
    await importAmazonCapture(db(), freshCapture(), backup());
    expect(hasAmazonFreshSchema(db())).toBe(true);
    // Reopening the repository (boot) neither repairs nor drops them.
    repo.close();
    repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
    expect(hasAmazonFreshSchema(db())).toBe(true);
  });

  it('stores each list once with its lines, makes it the order latest, and audits only real changes', async () => {
    const capture = freshCapture();
    await importAmazonCapture(db(), capture, backup());
    const orderRef = opaque('order', ORDER);
    const [list] = rows('SELECT digest,order_ref,data_json FROM amazon_fresh_lists');
    expect(list.order_ref).toBe(orderRef);
    expect(JSON.parse(list.data_json as string)).toEqual({
      provenance: { format: 'holdr.amazon-fresh-item-lists', version: 1, runId: capture.staging.runId, page: 'uff-itemmod' },
      statedCount: 2, rows: 2, proof: { complete: true, unreadRows: 0 }, reconciled: true, lines: 2 });
    const lines = rows('SELECT ref,list_digest,line_ordinal,data_json FROM amazon_fresh_lines ORDER BY line_ordinal');
    expect(lines.map(l => [l.ref, l.list_digest, l.line_ordinal])).toEqual([
      [opaque('fresh-line', [list.digest, 0]), list.digest, 0], [opaque('fresh-line', [list.digest, 1]), list.digest, 1]]);
    expect(JSON.parse(lines[0].data_json as string)).toMatchObject({ title: 'Synthetic Pork Shoulder',
      weight: { value: '1.25', unit: 'lb', basis: 'unlabeled' }, unitPrice: { money: usd(399), per: 'lb' }, linePrice: usd(499) });
    expect(rows('SELECT order_ref,latest_digest FROM amazon_fresh_orders')).toEqual([{ order_ref: orderRef, latest_digest: list.digest }]);
    // Fresh lines are never order items: the order's own item observations are untouched by them.
    expect(rows('SELECT count(*) AS n FROM amazon_items')[0].n).toBe(capture.staging.orders[0].items.length);
    expect(rows("SELECT count(*) AS n FROM amazon_audit WHERE action='fresh-list-observation'")[0].n).toBe(1);

    // The same capture again changes nothing.
    await importAmazonCapture(db(), capture, backup());
    expect(rows('SELECT count(*) AS n FROM amazon_fresh_lists')[0].n).toBe(1);
    expect(rows('SELECT count(*) AS n FROM amazon_fresh_lines')[0].n).toBe(2);
    expect(rows("SELECT count(*) AS n FROM amazon_audit WHERE action='fresh-list-observation'")[0].n).toBe(1);

    // A later observation that proves less (its lines no longer add up) is kept as history and never displaces the
    // richer list; the order's projection and its products stay those of the reconciled list.
    const later = freshCapture([line(0, 'Synthetic Pork Shoulder', { weight: { value: '1.25', unit: 'lb', basis: 'unlabeled' },
      unitPrice: { money: usd(399), per: 'lb' }, linePrice: usd(499) }), line(1, 'Synthetic Large Eggs', { linePrice: usd(500) })]);
    later.staging.runId = '00000000-0000-4000-8000-000000000002';
    await importAmazonCapture(db(), later, backup());
    expect(rows('SELECT count(*) AS n FROM amazon_fresh_lists')[0].n).toBe(2);
    expect(rows('SELECT latest_digest FROM amazon_fresh_orders')[0].latest_digest).toBe(list.digest);
    expect(rows("SELECT count(*) AS n FROM amazon_audit WHERE action='fresh-list-observation'")[0].n).toBe(1);
  });

  it('lets a better-proven later list replace a partial one, never the reverse', async () => {
    const partial = freshCapture([line(0, 'Synthetic Pork Shoulder', { weight: { value: '1.25', unit: 'lb', basis: 'unlabeled' },
      unitPrice: { money: usd(399), per: 'lb' }, linePrice: usd(499) })]);
    const section = partial.fresh as { lists: Array<{ statedCount: number; rows: number; proof: { complete: boolean; unreadRows: number };
      reconciled: boolean }>; diagnostics: Array<{ rows: number; unread: Array<[string, number]> }> };
    Object.assign(section.lists[0], { statedCount: 2, rows: 2, proof: { complete: false, unreadRows: 1 }, reconciled: false });
    Object.assign(section.diagnostics[0], { rows: 2, unread: [['note', 1]] });
    await importAmazonCapture(db(), partial, backup());
    const first = rows('SELECT latest_digest FROM amazon_fresh_orders')[0].latest_digest;
    const whole = freshCapture();
    whole.staging.runId = '00000000-0000-4000-8000-000000000003';
    await importAmazonCapture(db(), whole, backup());
    const latest = rows('SELECT latest_digest FROM amazon_fresh_orders')[0].latest_digest;
    expect(latest).not.toBe(first);
    expect(JSON.parse(rows('SELECT data_json FROM amazon_fresh_lists WHERE digest=?', latest)[0].data_json as string))
      .toMatchObject({ reconciled: true, lines: 2 });
    // The partial one again, from another run: history, not the projection.
    partial.staging.runId = '00000000-0000-4000-8000-000000000004';
    await importAmazonCapture(db(), partial, backup());
    expect(rows('SELECT latest_digest FROM amazon_fresh_orders')[0].latest_digest).toBe(latest);
    expect(rows('SELECT count(*) AS n FROM amazon_fresh_lists')[0].n).toBe(3);
  });

  it('refuses a list for an order the capture does not stage, malformed lines and listed status rows, before any write', async () => {
    const unstaged = freshCapture();
    (unstaged.fresh as { lists: Array<{ orderId: string }> }).lists[0].orderId = '000-0000002-0000002';
    await expect(validateCapture(unstaged)).rejects.toThrow();
    const malformed = freshCapture([line(0, 'Synthetic item', { linePrice: usd(1000), quantity: 0 })]);
    await expect(validateCapture(malformed)).rejects.toThrow();
    const falseClaim = freshCapture();
    (falseClaim.fresh as { lists: Array<{ reconciled: boolean; lines: Array<{ linePrice: Money }> }> }).lists[0].lines[1].linePrice = usd(1);
    await expect(validateCapture(falseClaim)).rejects.toThrow();
    // A row state the grammar doesn't read can never arrive as a listed line, even from a modified producer.
    const refunded = freshCapture([line(0, 'Synthetic Potato Chips (Refunded)', { linePrice: usd(1000) })]);
    await expect(validateCapture(refunded)).rejects.toThrow();
    for (const input of [unstaged, malformed, falseClaim, refunded]) {
      await expect(importAmazonCapture(db(), input, backup())).rejects.toThrow();
    }
    expect(rows("SELECT name FROM sqlite_master WHERE name LIKE 'amazon_%'")).toEqual([]);
  });

  it('installs only in a write transaction, only beside the Amazon schema, and never over a different table', () => {
    const memory = new Database(':memory:');
    expect(() => memory.transaction(() => installAmazonFreshSchema(memory))()).toThrow();
    ensureAmazonSchema(memory);
    expect(() => installAmazonFreshSchema(memory)).toThrow();
    memory.exec('CREATE TABLE amazon_fresh_lines (ref TEXT)');
    expect(() => memory.transaction(() => installAmazonFreshSchema(memory))()).toThrow();
    expect(hasAmazonFreshSchema(memory)).toBe(false);
    memory.exec('DROP TABLE amazon_fresh_lines');
    memory.transaction(() => installAmazonFreshSchema(memory))();
    memory.transaction(() => installAmazonFreshSchema(memory))();
    expect(hasAmazonFreshSchema(memory)).toBe(true);
    expect(AMAZON_FRESH_TABLES.every(name => memory.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))).toBe(true);
  });
});

describe('a Fresh order summary with a driver tip', () => {
  const order = (patch: Partial<OrderObservation> = {}): OrderObservation => ({ orderId: ORDER, date: '2026-09-01', total: usd(1800), items: [],
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '9001' }],
    summary: [{ kind: 'items-subtotal', money: usd(1500) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(100) },
      { kind: 'tip', money: usd(200) }, { kind: 'grand-total', money: usd(1800) }],
    tenderCoverage: 'single-card-proven',
    tenderProof: { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false }, ...patch });
  it('proves single-card tender only when items, delivery, tax and tip add up to the grand total', () => {
    expect(singleCardProven(order())).toBe(true);
    const short = order({ summary: order().summary!.filter(s => s.kind !== 'tip') });
    expect(singleCardProven(short)).toBe(false);
    const negative = order({ summary: order().summary!.map(s => s.kind === 'tip' ? { kind: 'tip', money: usd(-200) } : s) });
    expect(singleCardProven(negative)).toBe(false);
  });
  it('accepts the tip kind in a v3 capture and refuses unknown summary kinds', async () => {
    const capture = syntheticCapture();
    const o = capture.staging.orders[0];
    o.total = usd(1300);
    o.summary = [{ kind: 'items-subtotal', money: usd(1000) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(100) },
      { kind: 'tip', money: usd(200) }, { kind: 'grand-total', money: usd(1300) }];
    await expect(validateCapture(capture)).resolves.toBeDefined();
    (o.summary[3] as { kind: string }).kind = 'gratuity';
    await expect(validateCapture(capture)).rejects.toThrow();
  });
});
