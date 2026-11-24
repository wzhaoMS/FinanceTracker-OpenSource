import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { importAmazonCapture } from '../services/amazon/importer.js';
import { syntheticCapture } from '../services/amazon/fixtures.testSupport.js';
import { opaque } from '../services/amazon/policy.js';
import { hasAmazonSchema } from '../services/amazon/schema.js';
import { hasAmazonFreshSchema } from '../services/amazon/freshSchema.js';
import { AMAZON_TAXONOMY_DIGEST } from '../services/amazon/taxonomy.js';
import { each, freshLine, installFreshTables, seedFreshList, usd, weighed } from '../services/amazon/freshFixtures.testSupport.js';

// Entirely synthetic: the made-up order of fixtures.testSupport.ts, and made-up Fresh lines for it.
const ORIGIN = 'http://127.0.0.1:5173', TOKEN = '9a'.repeat(32), FAST = { ln: 10, r: 8, p: 1 };
let repo: SqliteStateRepo, app: Express, dir: string, cookie: string, logs: string[];
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-fresh-api-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  logs = [];
  const built = createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false,
    scryptParams: FAST, log: line => logs.push(line) });
  app = built.app;
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN)
    .set('X-Holdr-Request', '1').send({ username: 'alex', password: 'synthetic password' });
  expect(login.status).toBe(200);
  cookie = (login.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('holdr_session='))!.split(';')[0];
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const owner = (req: request.Test) => req.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
const get = async (url: string) => owner(request(await listenLoopback(app)).get(url));
/** Every object in the database and every Amazon row, to prove a read changed nothing. */
const state = () => {
  const db = repo.internalGetDb();
  const objects = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all() as Array<{ type: string; name: string }>;
  return { objects, rows: objects.filter(o => o.type === 'table' && o.name.startsWith('amazon_'))
    .map(o => [o.name, db.prepare(`SELECT * FROM "${o.name}" ORDER BY rowid`).all()]) };
};

describe('Amazon Fresh read API through the actual guarded mount', () => {
  it('answers the owner only, refusing bad windows, dates, refs and queries with fixed messages that echo nothing', async () => {
    const someRef = opaque('order', 'synthetic-unknown');
    for (const url of ['/amazon/fresh', `/amazon/fresh/orders/${someRef}`]) {
      expect((await request(await listenLoopback(app)).get(url)).status, url).toBe(401);
      expect((await request(await listenLoopback(app)).get(url).set('Authorization', `Bearer ${TOKEN}`)).status, url).toBe(403);
    }
    for (const query of ['window=5Y', 'window=ytd', 'window=', 'today=2026-02-30', 'today=1899-12-31', 'today=yesterday',
      'window=30D&window=60D', 'extra=secret']) {
      const res = await get(`/amazon/fresh?${query}`);
      expect(res.status, query).toBe(400);
      for (const echoed of ['secret', 'yesterday', '5Y', 'ytd', '1899']) expect(res.text, query).not.toContain(echoed);
    }
    expect((await get('/amazon/fresh?window=1Y&today=2026-02-30')).body).toEqual({ error: 'today must be a valid YYYY-MM-DD date' });
    expect((await get('/amazon/fresh?window=5Y')).body).toEqual({ error: 'invalid window' });
    const card = await get('/amazon/fresh?today=4111111111111111');
    expect(card.status).toBe(422);
    expect(card.text).not.toContain('4111111111111111');
    for (const ref of ['not-a-ref', someRef, `${someRef}0`, someRef.toUpperCase()]) {
      const res = await get(`/amazon/fresh/orders/${ref}`);
      expect(res.status, ref).toBe(404);
      expect(res.body, ref).toEqual({ error: 'amazon fresh order not found' });
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const extra = await get(`/amazon/fresh/orders/${someRef}?size=secret`);
    expect(extra.status).toBe(400);
    expect(extra.text).not.toContain('secret');
    expect(hasAmazonSchema(repo.internalGetDb())).toBe(false);
  });

  it('reads as never captured before any Fresh import, and migrates or creates nothing', async () => {
    const empty = await get('/amazon/fresh?window=1Y&today=2026-10-19');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ measure: 'amazon-fresh-item-prices-not-card-spending',
      window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' }, captured: false,
      taxonomy: { version: 1, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'absent' },
      orders: { count: 0, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 },
      lines: { count: 0, priced: 0, noPrice: 0, missing: 0, substituted: 0, estimated: 0, categorized: 0, suggested: 0, needsReview: 0,
        refunded: 0, unreadable: 0 },
      totals: [], categories: [], products: [], orderList: [] });
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(hasAmazonSchema(repo.internalGetDb())).toBe(false);
    // Without parameters: the last 30 days, to the server's date.
    const fallback = await get('/amazon/fresh');
    expect(fallback.body.window.key).toBe('30D');
    expect(fallback.body.window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Ordinary orders imported, no Fresh list: still never captured, and no Fresh table appears.
    const capture = syntheticCapture();
    await importAmazonCapture(repo.internalGetDb(), capture, path.join(dir, 'import-backup.db'));
    const before = state();
    const orders = await get('/amazon/fresh?window=60D&today=2026-10-19');
    expect(orders.body).toMatchObject({ captured: false, orders: { count: 0 }, orderList: [] });
    const orderRef = opaque('order', capture.staging.orders[0].orderId);
    expect((await get(`/amazon/fresh/orders/${orderRef}`)).status).toBe(404);
    expect(hasAmazonFreshSchema(repo.internalGetDb())).toBe(false);
    expect(state()).toEqual(before);
  });

  it('serves a Fresh order\'s window and item list once the gated import installed them, changing no other answer', async () => {
    const db = repo.internalGetDb(), capture = syntheticCapture(), order = capture.staging.orders[0];
    await importAmazonCapture(db, capture, path.join(dir, 'import-backup.db'));
    const orderRef = opaque('order', order.orderId);
    // Every other existing Amazon answer, byte for byte, before any Fresh table exists. The two item views count the
    // order by its Item List once it has one (asserted below), never by its order item too.
    const existing = ['/amazon/summary', '/amazon/orders', '/amazon/orders?limit=1&beneficiary=unknown', `/amazon/orders/${orderRef}`];
    const views = ['/amazon/spending?window=60D&today=2026-10-19', '/amazon/spending?window=2Y&today=2026-10-19',
      '/amazon/spending/taxonomy?window=60D&today=2026-10-19', '/amazon/spending/taxonomy?window=2Y&today=2026-10-19'];
    const answers = async (urls: string[]) => Promise.all(urls.map(async (url) => {
      const res = await get(url);
      return [url, res.status, res.headers['content-type'], res.text];
    }));
    const before = await answers(existing), viewsBefore = await answers(views);
    expect([...before, ...viewsBefore].every(([, status]) => status === 200)).toBe(true);
    // Without a Fresh list, the item views count the order by its item: the synthetic blue widget.
    expect(JSON.parse((await get(views[0])).text).totals[0]).toMatchObject({ itemMinor: 1000 });

    // What only the gated Fresh import does: install its tables and store the order's Item List (synthetic lines that
    // add up to the order's own item subtotal).
    installFreshTables(db);
    expect(await answers(views)).toEqual(viewsBefore);
    seedFreshList(db, orderRef, [
      freshLine('Synthetic Pork Shoulder', { asin: 'SYNTHPORK4', quantity: 1, ...weighed('1.5', 400, 600) }),
      freshLine('Synthetic Brown Eggs, 12 Count', { asin: 'SYNTHEGGS4', ...each(2, 200) }),
      freshLine('Synthetic Sold-Out Bread', { status: 'missing', quantity: 1 }),
    ]);
    expect(await answers(existing)).toEqual(before);
    // Both item views now count the order by its Item List only: its two delivered lines, never also its order item.
    const freshPart = { orders: 1, lines: { priced: 2, missing: 1, unreadable: 0 },
      totals: [{ currency: 'USD', lineMinor: 1000, refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 1000 }] };
    for (const url of views) {
      const view = (await get(url)).body;
      expect(view.fresh, url).toEqual(freshPart);
      expect(view.orders.count, url).toBe(1);
      expect(view.lines, url).toMatchObject({ count: 2, priced: 2 });
      expect(view.totals.map((t: { currency: string; itemMinor: number }) => [t.currency, t.itemMinor]), url).toEqual([['USD', 1000]]);
      expect(view.products.map((p: { title: string; amountMinor: number }) => [p.title, p.amountMinor]), url)
        .toEqual([['Synthetic Pork Shoulder', 600], ['Synthetic Brown Eggs, 12 Count', 400]]);
    }

    const reads = state();
    const window = await get('/amazon/fresh?window=60D&today=2026-10-19');
    expect(window.status).toBe(200);
    expect(window.headers['cache-control']).toBe('no-store');
    expect(window.body).toMatchObject({ captured: true, taxonomy: { assignments: 'absent' },
      orders: { count: 1, withTotal: 1, complete: 1, reconciled: 1, refunded: 0, unreadable: 0, noLines: 0 },
      lines: { count: 3, priced: 2, missing: 1, needsReview: 2 },
      totals: [{ currency: 'USD', orderTotalMinor: 1100, lineMinor: 1000, needsReviewMinor: 1000, netLineMinor: 1000 }],
      categories: [{ currency: 'USD', category: 'needs-review', amountMinor: 1000, lines: 2, products: 2, orders: 1 }],
      orderList: [{ ref: orderRef, date: '2026-09-01', total: usd(1100), lines: 3, priced: 2, missing: 1, lineTotal: usd(1000),
        complete: true, reconciled: true, refund: null }] });
    expect(window.body.products.map((p: { title: string; amountMinor: number }) => [p.title, p.amountMinor]))
      .toEqual([['Synthetic Pork Shoulder', 600], ['Synthetic Brown Eggs, 12 Count', 400]]);
    const list = await get(`/amazon/fresh/orders/${orderRef}`);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.order).toMatchObject({ ref: orderRef, date: '2026-09-01', total: usd(1100), refund: null,
      list: { statedCount: 3, rows: 3, unreadRows: 0, lines: 3, unreadable: 0, complete: true, reconciled: true } });
    expect(list.body.order.lines.map((l: { title: string; status: string; weight: unknown; linePrice: unknown }) =>
      [l.title, l.status, l.weight, l.linePrice])).toEqual([
      ['Synthetic Pork Shoulder', 'listed', { value: '1.5', unit: 'lb', basis: 'actual' }, usd(600)],
      ['Synthetic Brown Eggs, 12 Count', 'listed', null, usd(400)],
      ['Synthetic Sold-Out Bread', 'missing', null, null]]);
    // HEAD answers as GET does, without a body.
    expect((await owner(request(await listenLoopback(app)).head(`/amazon/fresh/orders/${orderRef}`))).status).toBe(200);
    for (const text of [window.text, list.text]) expect(text).not.toContain(order.orderId);
    expect(state()).toEqual(reads);
    expect(logs.join('\n')).not.toMatch(/Synthetic|amz-/);
  });
});
