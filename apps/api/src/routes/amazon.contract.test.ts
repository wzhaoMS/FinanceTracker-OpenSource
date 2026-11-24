import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from '../services/amazon/importer.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { rootApproval, syntheticCapture } from '../services/amazon/fixtures.testSupport.js';
import { opaque } from '../services/amazon/policy.js';
import type { OrderObservation } from '../services/amazon/types.js';

/**
 * The Amazon order page's contract with the web: the real guarded route's JSON goes through the web's own parser
 * (apps/web/.../amazon/amazonApi.ts, which keeps an order's summary only when every line is a kind it knows) and its
 * own labels (amazonFormat.ts). A summary kind the API serves that the web doesn't know would drop the whole summary
 * ("Order summary not reported"): it fails here instead. The web modules are loaded at run time so the API's typecheck
 * never compiles the web workspace (another module system), as owner.contract.test.ts does. Synthetic data only.
 */
const WEB_AMAZON = fileURLToPath(new URL('../../../web/src/components/amazon/', import.meta.url));

interface WebMoney { currency: string; amountMinor: number }
interface WebSummaryLine { kind: string; money: WebMoney }
interface WebAmazon {
  parseAmazonOrder(raw: unknown, full: boolean): { ref: string; total: WebMoney | null; summary?: WebSummaryLine[]; matches?: unknown[] };
  summaryLineText(line: WebSummaryLine): { label: string; amount: string };
}

const ORIGIN = 'http://127.0.0.1:5173', TOKEN = '9a'.repeat(32), FAST = { ln: 10, r: 8, p: 1 };
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
let repo: SqliteStateRepo, app: Express, dir: string, cookie: string, web: WebAmazon;
beforeAll(async () => {
  const api = await import(/* @vite-ignore */ path.join(WEB_AMAZON, 'amazonApi.ts')) as Pick<WebAmazon, 'parseAmazonOrder'>;
  const format = await import(/* @vite-ignore */ path.join(WEB_AMAZON, 'amazonFormat.ts')) as Pick<WebAmazon, 'summaryLineText'>;
  web = { parseAmazonOrder: api.parseAmazonOrder, summaryLineText: format.summaryLineText };
});
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-contract-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const built = createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, log: () => {} });
  app = built.app;
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN)
    .set('X-Holdr-Request', '1').send({ username: 'alex', password: 'synthetic password' });
  expect(login.status).toBe(200);
  cookie = (login.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('holdr_session='))!.split(';')[0];
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const owner = (req: request.Test) => req.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');

type Summary = NonNullable<OrderObservation['summary']>;
/** The synthetic capture's one order, as another run captured another order. */
function captured(run: number, orderId: string, patch: Partial<OrderObservation>) {
  const capture = syntheticCapture() as ReturnType<typeof syntheticCapture> & { fresh?: unknown };
  capture.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  Object.assign(capture.staging.orders[0], { orderId, ...patch });
  return capture;
}
/** A Fresh (UFF) order: no items on its details page, a driver tip, and a whole Item List adding up to its item subtotal. */
function freshWithTip(run = 2, orderId = '000-0000002-0000002', tip = 200) {
  const capture = captured(run, orderId, { items: [], total: usd(1600 + tip), summary: [
    { kind: 'items-subtotal', money: usd(1500) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(100) },
    { kind: 'tip', money: usd(tip) }, { kind: 'grand-total', money: usd(1600 + tip) }] satisfies Summary });
  capture.staging.coverage.details = { status: 'held', reason: 'selector-failed', pages: 0, records: 0, rejected: 0 };
  capture.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
    lists: [{ orderId, statedCount: 2, rows: 2, proof: { complete: true, unreadRows: 0 }, reconciled: true, lines: [
      { lineOrdinal: 0, title: 'Synthetic Fresh apples', asin: null, status: 'listed', quantity: 1,
        weight: { value: '2.00', unit: 'lb', basis: 'unlabeled' }, unitPrice: { money: usd(400), per: 'lb' }, linePrice: usd(800), replaces: null },
      { lineOrdinal: 1, title: 'Synthetic Fresh eggs', asin: null, status: 'listed', quantity: 2, weight: null, unitPrice: null,
        linePrice: usd(700), replaces: null },
    ] }],
    diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: 2, lines: 2, unread: [] }] };
  return capture;
}
/** Every summary kind the capture validators admit (capture.ts, amazon-capture.mjs), on one order paid two ways. */
function everyKind() {
  return captured(3, '000-0000003-0000003', { total: usd(1049), tenderCoverage: 'multi-tender',
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '9001' }, { kind: 'balance', network: 'unknown', last4: null }],
    summary: [{ kind: 'items-subtotal', money: usd(1000) }, { kind: 'shipping', money: usd(599) }, { kind: 'tax', money: usd(100) },
      { kind: 'tip', money: usd(300) }, { kind: 'promotion', money: usd(200) }, { kind: 'gift-card', money: usd(500) },
      { kind: 'rewards', money: usd(250) }, { kind: 'grand-total', money: usd(1049) }] satisfies Summary });
}
/** The order's own arithmetic: items, delivery, tax and tip add up; promotions, gift cards and points come off. */
const SIGN: Record<string, number> = { 'items-subtotal': 1, shipping: 1, tax: 1, tip: 1, promotion: -1, 'gift-card': -1, rewards: -1 };

describe('the Amazon order page reads every summary the API serves', () => {
  it('an ordinary order, a Fresh order with a tip and an order with every kind reach the page whole, and add up exactly', async () => {
    const cases: Array<[ReturnType<typeof captured>, string[]]> = [
      [syntheticCapture(), ['Items', 'Shipping & handling', 'Tax', 'Order total']],
      [freshWithTip(), ['Items', 'Shipping & handling', 'Tax', 'Tip', 'Order total']],
      [everyKind(), ['Items', 'Shipping & handling', 'Tax', 'Tip', 'Promotions', 'Gift card applied', 'Points & rewards applied',
        'Order total']],
    ];
    for (const [n, [capture]] of cases.entries()) {
      await importAmazonCapture(repo.internalGetDb(), capture, path.join(dir, `backup-${n}.db`));
    }
    for (const [capture, labels] of cases) {
      const ref = opaque('order', capture.staging.orders[0].orderId);
      const answer = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${ref}`));
      expect(answer.status).toBe(200);
      expect(answer.body.order.summary).toEqual(capture.staging.orders[0].summary);
      // The web client's own unwrapping (fetchAmazonOrder): the answer's `order`, read as an order page.
      const page = web.parseAmazonOrder(answer.body.order, true);
      expect(page.ref).toBe(ref);
      expect(page.summary).toEqual(answer.body.order.summary);
      expect(page.summary!.map(line => web.summaryLineText(line).label)).toEqual(labels);
      // Nothing recomputed or dropped: the page's lines add up to its grand total, which is the order's total.
      const grand = page.summary!.find(line => line.kind === 'grand-total')!.money;
      expect(page.summary!.filter(line => line.kind !== 'grand-total')
        .reduce((sum, line) => sum + SIGN[line.kind] * Math.abs(line.money.amountMinor), 0)).toBe(grand.amountMinor);
      expect(page.total).toEqual(grand);
    }
  });
});

describe("the Amazon order page keeps every card match the API serves (TIP_SPLIT_POLICY's split parts)", () => {
  it('a tipped order linked on its whole total, and one linked by its order charge, reach the page whole', async () => {
    const db = repo.internalGetDb();
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db));
    await recordBindingProposal(db, proposal, path.join(dir, 'binding-proposal.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(dir, 'binding-approval.db'));
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: ([[1800, 'AMAZON.COM*SYNTH WHOLE'], [1600, 'AMAZON.COM*SYNTH ORDER'], [300, 'AMAZON TIPS*SYNTH']] as const)
        .map(([amountMinor, description]) => ({ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD',
          amountMinor, description, issuerCategory: 'Shopping' })) });
    // 1800 charged whole (its split parts superseded, so inert); 1900 charged as 1600 and its 300 tip apart.
    const whole = freshWithTip(), apart = freshWithTip(4, '000-0000004-0000004', 300);
    for (const [n, capture] of [whole, apart].entries()) {
      await importAmazonCapture(db, capture, path.join(dir, `backup-tip-${n}.db`));
    }
    const rowOf = (amount: number) => db.prepare('SELECT id FROM card_transactions WHERE amount_minor=?').pluck().get(amount) as string;
    const linked = (amount: number) => ({ state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: rowOf(amount),
      cardAccountId: card.id });
    const pageMatches = async (capture: ReturnType<typeof freshWithTip>) => {
      const answer = await owner(request(await listenLoopback(app)).get(`/amazon/orders/${opaque('order', capture.staging.orders[0].orderId)}`));
      expect(answer.status).toBe(200);
      // The web keeps an order's matches only when it knows every one (a closed set of held reasons): none may drop.
      const page = web.parseAmazonOrder(answer.body.order, true);
      expect(page.matches).toEqual(answer.body.order.matches);
      return page.matches;
    };
    expect(await pageMatches(whole)).toEqual([linked(1800)]);
    // The order charge links; the tip part is deferred (Root 06:36Z), so the tips row stays unlinked and out of the view.
    const split = await pageMatches(apart);
    expect(split).toHaveLength(2);
    expect(split).toEqual(expect.arrayContaining([linked(1600),
      { state: 'held', evidenceClass: 'unique-total-match', reason: 'no-candidate', candidateCount: 0 }]));
  });
});
