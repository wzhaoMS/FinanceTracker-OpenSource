import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { backedUpWrite, importAmazonCapture } from '../services/amazon/importer.js';
import { syntheticCapture } from '../services/amazon/fixtures.testSupport.js';
import { productKey } from '../services/amazon/products.js';
import { applyTaxonomyMapping, installAmazonTaxonomySchema } from '../services/amazon/taxonomy.js';

/**
 * The taxonomy panel's contract with the API: the web client's own parser (apps/web/.../amazonTaxonomyApi.ts, which
 * refuses any answer that doesn't add up) reads the real route's answers for every way an item can be filed. An answer
 * it would refuse fails here. The parser is loaded at run time, so the API's typecheck never compiles the web workspace.
 * Synthetic only: the made-up widget, order and amounts of fixtures.testSupport.ts.
 */
const WEB_AMAZON = fileURLToPath(new URL('../../../web/src/components/amazon/', import.meta.url));
interface Parsed {
  assignments: 'present' | 'absent';
  lines: { priced: number; assigned: number; suggested: number; needsReview: number };
  totals: Array<{ itemMinor: number; assignedMinor: number; suggestedMinor: number; needsReviewMinor: number; itemRefundMinor: number;
    netItemMinor: number }>;
  nodes: Array<{ node: string; amountMinor: number; refundMinor: number; netMinor: number }>;
  products: Array<{ node: string; source: string | null; confidence: number | null; suggested: boolean;
    suggestion: { node: string; confidence: number } | null; refundMinor: number; netMinor: number }>;
}
let parse: (raw: unknown, window: string) => Parsed;

const ORIGIN = 'http://127.0.0.1:5173', TOKEN = '9a'.repeat(32), FAST = { ln: 10, r: 8, p: 1 };
let repo: SqliteStateRepo, app: Express, dir: string, cookie: string, backups = 0;
beforeEach(async () => {
  ({ parseAmazonTaxonomySpending: parse } = await import(/* @vite-ignore */ path.join(WEB_AMAZON, 'amazonTaxonomyApi.ts')) as
    { parseAmazonTaxonomySpending: typeof parse });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-taxonomy-contract-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const built = createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, log: () => {} });
  app = built.app;
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN)
    .set('X-Holdr-Request', '1').send({ username: 'alex', password: 'synthetic password' });
  cookie = (login.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('holdr_session='))!.split(';')[0];
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const read = async (): Promise<Parsed> => {
  const res = await request(await listenLoopback(app)).get('/amazon/spending/taxonomy?window=60D&today=2026-10-19')
    .set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
  expect(res.status).toBe(200);
  // What the page receives: the response body as text, parsed and checked whole by the web client.
  return parse(JSON.parse(res.text), '60D');
};
const assign = (key: string, node: string, confidence: number, source: 'agent' | 'owner' = 'agent') => {
  const db = repo.internalGetDb();
  return backedUpWrite(db, path.join(dir, `taxonomy-backup-${backups++}.db`), () => applyTaxonomyMapping(db, {
    format: 'holdr.amazon-item-taxonomy-mapping', version: 1, taxonomyVersion: 1, reviewed: true,
    entries: [{ productKey: key, node, confidence, source }],
  }, '2026-10-21T00:00:00.000Z'), installAmazonTaxonomySchema);
};

describe('taxonomy spending: API answers the web client reads', () => {
  it('reads every way the one $10 item can be filed, refunded or not, with Needs review outside the assigned counts', async () => {
    const capture = syntheticCapture(), item = capture.staging.orders[0].items[0];
    await importAmazonCapture(repo.internalGetDb(), structuredClone(capture), path.join(dir, 'import-backup.db'));
    const key = productKey({ asin: item.itemId, title: item.title });
    const expectFiled = (view: Parsed, node: string, source: string | null, suggested: boolean) => {
      expect(view.products).toHaveLength(1);
      expect(view.products[0]).toMatchObject({ node, source, suggested });
      const inReview = node === 'needs-review';
      expect(view.lines).toMatchObject({ priced: 1, assigned: inReview ? 0 : 1, suggested: suggested ? 1 : 0, needsReview: inReview ? 1 : 0 });
      expect(view.totals[0]).toMatchObject({ itemMinor: 1000, assignedMinor: inReview ? 0 : 1000, suggestedMinor: suggested ? 1000 : 0,
        needsReviewMinor: inReview ? 1000 : 0 });
    };

    const none = await read();
    expect(none.assignments).toBe('absent');
    expectFiled(none, 'needs-review', null, false);
    // The review's reproduction: an agent's own Needs review, at every confidence, the 0.6–0.8 band included.
    for (const confidence of [0.59, 0.6, 0.7, 0.799, 0.8, 0.9]) {
      await assign(key, 'needs-review', confidence);
      const view = await read();
      expectFiled(view, 'needs-review', confidence >= 0.6 ? 'agent' : null, false);
      expect(view.products[0].suggestion).toBeNull();
    }
    // A category: a guess below 0.6 waits in Needs review as a suggestion; 0.6–0.8 counts, suggested; 0.8 on, classified.
    await assign(key, 'electronics/smart-home', 0.59);
    const weak = await read();
    expectFiled(weak, 'needs-review', null, false);
    expect(weak.products[0].suggestion).toEqual({ node: 'electronics/smart-home', confidence: 0.59 });
    for (const [confidence, suggested] of [[0.6, true], [0.7, true], [0.799, true], [0.8, false], [0.95, false]] as const) {
      await assign(key, 'electronics/smart-home', confidence);
      const view = await read();
      expectFiled(view, 'electronics/smart-home', 'agent', suggested);
      expect(view.nodes.map(n => n.node)).toEqual(['electronics', 'electronics/smart-home']);
    }
    await assign(key, 'electronics', 0.7);
    expectFiled(await read(), 'electronics', 'agent', true);

    // Amazon's Refund Total equal to the order's grand total: the whole item comes back, off it and its nodes.
    capture.staging.orders[0].refundSummary = { currency: 'USD', amountMinor: 1100 };
    await importAmazonCapture(repo.internalGetDb(), structuredClone(capture), path.join(dir, 'refund-import-backup.db'));
    const refunded = await read();
    expectFiled(refunded, 'electronics', 'agent', true);
    expect(refunded.totals[0]).toMatchObject({ itemRefundMinor: 1000, netItemMinor: 0 });
    expect(refunded.products[0]).toMatchObject({ refundMinor: 1000, netMinor: 0 });
    expect(refunded.nodes).toEqual([expect.objectContaining({ node: 'electronics', amountMinor: 1000, refundMinor: 1000, netMinor: 0 })]);
    await assign(key, 'needs-review', 0.7);
    expectFiled(await read(), 'needs-review', 'agent', false);

    // The owner's choice wins over every agent row, Needs review included, and is never suggested.
    await assign(key, 'needs-review', 1, 'owner');
    expectFiled(await read(), 'needs-review', 'owner', false);
  });
});
