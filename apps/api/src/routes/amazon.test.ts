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
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from '../services/amazon/importer.js';
import { rootApproval, syntheticCapture, syntheticJpeg, withSyntheticItems } from '../services/amazon/fixtures.testSupport.js';
import { opaque } from '../services/amazon/policy.js';
import { hasAmazonSchema } from '../services/amazon/schema.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { hasAmazonImageSchema, installAmazonImageSchema, writeAmazonImageIds, writeAmazonImages } from '../services/amazon/images.js';
import { AMAZON_TAXONOMY_DIGEST, applyTaxonomyMapping, hasAmazonTaxonomySchema, installAmazonTaxonomySchema } from '../services/amazon/taxonomy.js';
import { productKey } from '../services/amazon/products.js';
import { API_CSP } from '../ingress/securityHeaders.js';

const ORIGIN = 'http://127.0.0.1:5173', TOKEN = '9a'.repeat(32), FAST = { ln: 10, r: 8, p: 1 };
let repo: SqliteStateRepo, app: Express, dir: string, cookie: string, logs: string[];
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-api-synthetic-'));
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

describe('Amazon owner-only read API through the actual guarded mount', () => {
  it('rejects unauthenticated and service principals and has no write/import endpoint', async () => {
    expect((await request(await listenLoopback(app)).get('/amazon/orders')).status).toBe(401);
    expect((await request(await listenLoopback(app)).get('/amazon/orders').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(403);
    expect((await owner(request(await listenLoopback(app)).post('/amazon/import')).set('Content-Type', 'application/json').send('invalid-json')).status).toBe(404);
    expect(hasAmazonSchema(repo.internalGetDb())).toBe(false);
  });
  it('reads empty state without migration, validates pagination/beneficiary, and never echoes private input', async () => {
    const empty = await owner(request(await listenLoopback(app)).get('/amazon/orders'));
    expect(empty.status).toBe(200); expect(empty.body).toEqual({ total: 0, orders: [] });
    expect(hasAmazonSchema(repo.internalGetDb())).toBe(false);
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'beneficiary=not-a-person', 'extra=secret']) {
      const res = await owner(request(await listenLoopback(app)).get(`/amazon/orders?${query}`));
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('secret'); expect(res.text).not.toContain('not-a-person');
    }
  });
  it('serves labelled observation counts, unknown beneficiaries and opaque paged refs with no native order IDs', async () => {
    const capture = syntheticCapture();
    await importAmazonCapture(repo.internalGetDb(), capture, path.join(dir, 'backup.db'));
    const list = await owner(request(await listenLoopback(app)).get('/amazon/orders?beneficiary=unknown&limit=1'));
    expect(list.status).toBe(200);
    expect(list.body.orders[0]).toMatchObject({ beneficiary: 'unknown', tenderCoverage: 'single-card-proven', paymentCoverage: 'held' });
    expect(list.text).not.toContain(capture.staging.orders[0].orderId);
    const summary = await owner(request(await listenLoopback(app)).get('/amazon/summary'));
    expect(summary.body).toMatchObject({ measure: 'amazon-order-observations-not-card-spending', orders: 1, held: 1,
      itemAttribution: 'unproven', unknownBeneficiary: 1 });
    const detail = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${opaque('order', capture.staging.orders[0].orderId)}`));
    expect(detail.status).toBe(200);
    expect(detail.body.order.items[0]).toMatchObject({ title: 'Synthetic blue widget', attribution: 'observation-only' });
    expect(detail.text).not.toContain(capture.staging.orders[0].orderId);
    expect(detail.headers['cache-control']).toBe('no-store');
  });
  it('returns and logs only fixed errors when the private database fails', async () => {
    repo.close();
    const response = await owner(request(await listenLoopback(app)).get('/amazon/summary'));
    expect(response.status).toBe(500);
    expect(response.text).not.toContain(dir);
    expect(logs.join('\n')).not.toContain(dir);
  });
  it('preserves safe full titles and ASINs on bounded owner reads, redacts card-bearing text on both surfaces', async () => {
    const capture = syntheticCapture(), item = capture.staging.orders[0].items[0];
    const fullTitle = 'Synthetic full product model '.repeat(30);
    item.title = fullTitle;
    await importAmazonCapture(repo.internalGetDb(), capture, path.join(dir, 'full-title-backup.db'));
    const orderRef = opaque('order', capture.staging.orders[0].orderId);
    const list = await owner(request(await listenLoopback(app)).get('/amazon/orders?limit=100'));
    expect(list.body.orders[0].items[0]).toMatchObject({ title: fullTitle, asin: item.itemId });
    expect(list.body.orders[0].matches[0]).toEqual({ state: 'held', evidenceClass: 'unique-total-match', reason: 'binding-held', candidateCount: 0 });
    expect(list.body.orders[0].refunds).toEqual([]);
    const detail = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${orderRef}`));
    expect(detail.body.order.items[0]).toMatchObject({ title: fullTitle, asin: item.itemId, category: null, confidence: null });
    expect((await request(await listenLoopback(app)).get(`/amazon/orders/${orderRef}`)).status).toBe(401);
    // A card-bearing title on its own order: a re-read of the first order with a different title is a conflict, history only.
    const second = syntheticCapture(), other = second.staging.orders[0];
    second.staging.runId = '00000000-0000-4000-8000-000000000002';
    other.orderId = '000-0000002-0000002';
    other.items[0].title = 'Synthetic 4111111111111111';
    await importAmazonCapture(repo.internalGetDb(), second, path.join(dir, 'redaction-backup.db'));
    for (const url of ['/amazon/orders', `/amazon/orders/${opaque('order', other.orderId)}`]) {
      const response = await owner(request(await listenLoopback(app)).get(url));
      expect(response.status).toBe(200);
      expect(response.text).toContain('[redacted]');
      expect(response.text).not.toContain(other.items[0].title);
      expect(response.text).not.toContain(other.orderId);
      expect(response.text).not.toContain(capture.staging.orders[0].orderId);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(logs.join('\n')).not.toContain(other.items[0].title);
  });
  it('serves Amazon\'s own item spending per window to the owner only, refusing bad windows and dates without echoing them', async () => {
    expect((await request(await listenLoopback(app)).get('/amazon/spending')).status).toBe(401);
    expect((await request(await listenLoopback(app)).get('/amazon/spending').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(403);
    const empty = await owner(request(await listenLoopback(app)).get('/amazon/spending?window=1Y&today=2026-10-19'));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ measure: 'amazon-order-item-prices-not-card-spending',
      window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' }, orders: { count: 0 }, totals: [], categories: [], products: [] });
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(hasAmazonSchema(repo.internalGetDb())).toBe(false);
    // Without parameters: the last 30 days, to the server's date.
    const fallback = await owner(request(await listenLoopback(app)).get('/amazon/spending'));
    expect(fallback.body.window.key).toBe('30D');
    expect(fallback.body.window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const query of ['window=5Y', 'window=ytd', 'window=', 'today=2026-02-30', 'today=1899-12-31', 'today=yesterday',
      'window=30D&window=60D', 'extra=secret']) {
      const res = await owner(request(await listenLoopback(app)).get(`/amazon/spending?${query}`));
      expect(res.status, query).toBe(400);
      for (const echoed of ['secret', 'yesterday', '5Y', 'ytd', '1899']) expect(res.text, query).not.toContain(echoed);
    }
    const card = await owner(request(await listenLoopback(app)).get('/amazon/spending?today=4111111111111111'));
    expect(card.status).toBe(422);
    expect(card.text).not.toContain('4111111111111111');
  });
  it('totals a linked order\'s items, says how many of its card charges Spending itemizes, and never shows native IDs', async () => {
    const prime = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: prime.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [600, 500].map(amountMinor => ({ transactionDate: '2026-09-03', status: 'posted' as const, kind: 'purchase' as const,
        amountMinor, currency: 'USD', description: 'AMAZON SYNTHETIC RETAIL', issuerCategory: 'Shopping' })) });
    const db = repo.internalGetDb(), capture = syntheticCapture(), o = capture.staging.orders[0];
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    capture.staging.payments = [600, 500].map((amountMinor, ordinal) => ({
      date: '2026-09-03', money: { currency: 'USD', amountMinor }, kind: 'charge' as const, status: 'completed' as const,
      method: { kind: 'card' as const, network: 'visa' as const, last4: '9001' }, orderIds: [o.orderId], identity: 'native-row' as const,
      provenance: { source: 'ledger' as const, status: 'Charged' as const, page: 0, ordinal },
    }));
    capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 2, rejected: 0 };
    await importAmazonCapture(db, capture, path.join(dir, 'ledger-backup-1.db'));
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: prime.id }], readCardInventory(db));
    await recordBindingProposal(db, proposal, path.join(dir, 'ledger-backup-2.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(dir, 'ledger-backup-3.db'));
    await backedUpWrite(db, path.join(dir, 'ledger-backup-4.db'), () => {
      db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(db.prepare('SELECT ref FROM amazon_items').pluck().get(), 'Synthetic Household');
    });
    const read = async (query: string) => (await owner(request(await listenLoopback(app)).get(`/amazon/spending?${query}`)));
    const window = await read('window=60D&today=2026-10-19');
    expect(window.status).toBe(200);
    // The capture proved the order's item list complete (itemProof, and its line adds up to the item subtotal).
    expect(window.body.orders).toEqual({ count: 1, withTotal: 1, itemsComplete: 1, noLines: 0, refunded: 0, linked: 1, held: 0, unmatched: 0 });
    // Both of the order's card charges are filed under its items in Spending.
    expect(window.body.cardCharges).toEqual({ linked: 2, itemized: 2 });
    expect(window.body.totals).toEqual([{ currency: 'USD', orderTotalMinor: 1100, itemsCompleteOrderTotalMinor: 1100,
      itemMinor: 1000, categorizedMinor: 1000, refundMinor: 0, itemRefundMinor: 0, unattributedRefundMinor: 0, netItemMinor: 1000 }]);
    expect(window.body.categories).toEqual([{ currency: 'USD', category: 'Synthetic Household', amountMinor: 1000, refundMinor: 0,
      netMinor: 1000, lines: 1, refundedLines: 0, products: 1, orders: 1 }]);
    expect(window.body.products).toEqual([{ ref: expect.stringMatching(/^amz-[a-f0-9]{48}$/), currency: 'USD', title: 'Synthetic blue widget',
      asin: 'SYNTH00001', category: 'Synthetic Household', categorySource: 'item-override', quantity: 1, lines: 1, orders: 1,
      amountMinor: 1000, refundMinor: 0, netMinor: 1000, refundedQuantity: 0, lastOrderDate: '2026-09-01',
      lastOrderRef: opaque('order', o.orderId) }]);
    expect(window.text).not.toContain(o.orderId);
    // The order is older than 30 days: that window is empty.
    expect((await read('window=30D&today=2026-10-19')).body.orders.count).toBe(0);
    // The owner's own category on a charge keeps it whole in Spending: still linked, no longer itemized.
    const [charge] = repo.queryCardTransactions({}).transactions;
    repo.updateCardTransaction(charge.id, { userCategory: 'Synthetic gifts' }, { actorRef: cardSyncActorRef('synthetic-owner') });
    expect((await read('window=60D&today=2026-10-19')).body.cardCharges).toEqual({ linked: 2, itemized: 1 });
  });
  it('serves a cached thumbnail to the owner only, from this origin, and 404s anything not cached', async () => {
    const capture = withSyntheticItems(syntheticCapture(), 2);
    await importAmazonCapture(repo.internalGetDb(), capture, path.join(dir, 'import-backup.db'));
    const orderRef = opaque('order', capture.staging.orders[0].orderId);
    const before = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${orderRef}`));
    const [cachedRef, uncachedRef] = before.body.order.items.map((item: { ref: string }) => item.ref);
    expect(before.body.order.items.map((item: object) => 'image' in item)).toEqual([false, false]);
    const image = (ref: string) => `/amazon/items/${ref}/image`;
    const notCached = await owner(request(await listenLoopback(app)).get(image(cachedRef)));
    expect(notCached.status).toBe(404);
    expect(notCached.body).toEqual({ error: 'amazon item image not found' });
    expect(hasAmazonImageSchema(repo.internalGetDb())).toBe(false);

    await backedUpWrite(repo.internalGetDb(), path.join(dir, 'image-backup.db'), () => writeAmazonImages(repo.internalGetDb(), [
      { asin: 'SYNTH00001', outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg() },
      { asin: 'SYNTH00002', outcome: 'missing', reason: 'not-found' },
    ], '2026-10-21T00:00:00.000Z'), installAmazonImageSchema);
    const served = await owner(request(await listenLoopback(app)).get(image(cachedRef))).buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
    expect(served.status).toBe(200);
    expect(served.body).toEqual(syntheticJpeg());
    expect(served.headers).toMatchObject({ 'content-type': 'image/jpeg', 'content-length': String(syntheticJpeg().length),
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': API_CSP });
    const head = await owner(request(await listenLoopback(app)).head(image(cachedRef)));
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('image/jpeg');
    const after = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${orderRef}`));
    expect(after.body.order.items.map((item: { image?: boolean }) => item.image)).toEqual([true, undefined]);
    const list = await owner(request(await listenLoopback(app)).get('/amazon/orders'));
    expect(list.body.orders[0].items.map((item: { image?: boolean }) => item.image)).toEqual([true, undefined]);

    expect((await request(await listenLoopback(app)).get(image(cachedRef))).status).toBe(401);
    expect((await request(await listenLoopback(app)).get(image(cachedRef)).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(403);
    for (const ref of [uncachedRef, opaque('item', 'synthetic-unknown'), 'not-a-ref', `${cachedRef}0`, cachedRef.toUpperCase()]) {
      expect((await owner(request(await listenLoopback(app)).get(image(ref)))).status, ref).toBe(404);
    }
    const query = await owner(request(await listenLoopback(app)).get(`${image(cachedRef)}?size=large`));
    expect(query.status).toBe(400);
    repo.internalGetDb().prepare("UPDATE amazon_product_images SET bytes=? WHERE asin='SYNTH00001'").run(syntheticJpeg('tampered'));
    expect((await owner(request(await listenLoopback(app)).get(image(cachedRef)))).status).toBe(404);
    expect(logs.join('\n')).not.toMatch(/SYNTH|Synthetic|amz-|image/);
  });
  it('serves an item\'s thumbnail by its captured image ID when its ASIN has none, the ASIN\'s first', async () => {
    const capture = withSyntheticItems(syntheticCapture(), 2);
    [capture.staging.orders[0].items[0].imageId, capture.staging.orders[0].items[1].imageId] = ['91SynthAA0L', '91SynthAB0L'];
    await importAmazonCapture(repo.internalGetDb(), capture, path.join(dir, 'import-backup.db'));
    const orderRef = opaque('order', capture.staging.orders[0].orderId);
    await backedUpWrite(repo.internalGetDb(), path.join(dir, 'image-backup.db'), () => {
      writeAmazonImages(repo.internalGetDb(), [{ asin: 'SYNTH00001', outcome: 'missing', reason: 'placeholder' },
        { asin: 'SYNTH00002', outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg('by-asin') }], '2026-10-23T00:00:00.000Z');
      writeAmazonImageIds(repo.internalGetDb(), [{ imageId: '91SynthAA0L', outcome: 'cached', contentType: 'image/jpeg',
        bytes: syntheticJpeg('by-id') }, { imageId: '91SynthAB0L', outcome: 'cached', contentType: 'image/jpeg',
        bytes: syntheticJpeg('unused') }], '2026-10-23T00:00:00.000Z');
    }, installAmazonImageSchema);
    const order = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${orderRef}`));
    expect(order.body.order.items.map((item: { image?: boolean }) => item.image)).toEqual([true, true]);
    const bytes = async (ref: string) => {
      const res = await owner(request(await listenLoopback(app)).get(`/amazon/items/${ref}/image`)).buffer(true)
        .parse((r, done) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => done(null, Buffer.concat(chunks))); });
      return [res.status, res.headers['content-type'], res.body];
    };
    const [byId, byAsin] = order.body.order.items.map((item: { ref: string }) => item.ref);
    expect(await bytes(byId)).toEqual([200, 'image/jpeg', syntheticJpeg('by-id')]);
    expect(await bytes(byAsin)).toEqual([200, 'image/jpeg', syntheticJpeg('by-asin')]);
    expect((await request(await listenLoopback(app)).get(`/amazon/items/${byId}/image`)).status).toBe(401);
    expect(logs.join('\n')).not.toMatch(/SYNTH|Synthetic|91Synth|amz-|image/);
  });
  it('serves the window\'s items by taxonomy to the owner only, in Needs review until a gated import assigns them', async () => {
    const url = '/amazon/spending/taxonomy';
    expect((await request(await listenLoopback(app)).get(url)).status).toBe(401);
    expect((await request(await listenLoopback(app)).get(url).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(403);
    const empty = await owner(request(await listenLoopback(app)).get(`${url}?window=1Y&today=2026-10-19`));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ measure: 'amazon-order-item-prices-not-card-spending', window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' },
      taxonomy: { version: 1, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'absent' }, totals: [], nodes: [], products: [] });
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(hasAmazonSchema(repo.internalGetDb())).toBe(false);
    for (const query of ['window=5Y', 'today=2026-02-30', 'window=30D&window=60D', 'extra=secret']) {
      const res = await owner(request(await listenLoopback(app)).get(`${url}?${query}`));
      expect(res.status, query).toBe(400);
      for (const echoed of ['secret', '5Y']) expect(res.text, query).not.toContain(echoed);
    }
    const db = repo.internalGetDb(), capture = syntheticCapture(), o = capture.staging.orders[0], item = o.items[0];
    await importAmazonCapture(db, capture, path.join(dir, 'taxonomy-import-backup.db'));
    const read = async () => (await owner(request(await listenLoopback(app)).get(`${url}?window=60D&today=2026-10-19`)));
    const before = await read();
    expect(before.body.products).toMatchObject([{ title: item.title, asin: item.itemId, node: 'needs-review', source: null,
      purchases: [{ orderRef: opaque('order', o.orderId), orderDate: o.date, quantity: 1, unitPriceMinor: 1000, amountMinor: 1000, orderRefunded: false }] }]);
    expect(hasAmazonTaxonomySchema(db)).toBe(false);
    const key = productKey({ asin: item.itemId, title: item.title });
    await backedUpWrite(db, path.join(dir, 'taxonomy-backup.db'), () => applyTaxonomyMapping(db, { format: 'holdr.amazon-item-taxonomy-mapping',
      version: 1, taxonomyVersion: 1, reviewed: true, entries: [{ productKey: key, node: 'electronics/smart-home', confidence: 0.9, source: 'agent' }] },
    '2026-10-21T00:00:00.000Z'), installAmazonTaxonomySchema);
    const after = await read();
    expect(after.body.taxonomy.assignments).toBe('present');
    expect(after.body.nodes.map((n: { node: string; amountMinor: number }) => [n.node, n.amountMinor]))
      .toEqual([['electronics', 1000], ['electronics/smart-home', 1000]]);
    expect(after.body.products[0]).toMatchObject({ node: 'electronics/smart-home', source: 'agent', confidence: 0.9, suggested: false });
    expect(after.text).not.toContain(o.orderId);
    expect(after.text).not.toContain(key);
  });
});
