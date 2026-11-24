// Spending through the composite category source (Costco receipts 4/7 §9) answers exactly as through the Amazon
// domain's own resolver, byte for byte: every route of the three routers it is injected into, on both category bases,
// over a live synthetic Amazon scenario with split, held, refunded and unitemized charges. And which rows a source
// links is said explicitly, and read as untrusted. Synthetic data only: fictional merchants, made-up amounts and last-4s.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CardCategoryResolution } from '@finance-tracker/shared';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from '../routes/cardSpending.js';
import { createCardTransactionsRouter, type CardCategorySource } from '../routes/cardTransactions.js';
import { createCardSpendingOverviewRouter } from '../routes/cardSpendingOverview.js';
import { createCardSpendingForecastRouter } from '../routes/cardSpendingForecast.js';
import { listenLoopback } from '../testing/loopback.js';
import { cardSyncActorRef } from './cardSyncDigests.js';
import { SqliteStateRepo, type CardImportRow } from './sqliteStateRepo.js';
import { createAmazonCategoryResolver, type AmazonResolver } from './amazon/resolver.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from './amazon/importer.js';
import { proposeBindings, readCardInventory } from './amazon/bindings.js';
import { rootApproval, syntheticCapture } from './amazon/fixtures.testSupport.js';
import { createCompositeCategoryResolver } from './categorySources.js';

let dir: string;
let repo: SqliteStateRepo;
let backups = 0;
/** What Spending's routers log, line by line: a request failing through their catch-all logs here. */
let logs: string[] = [];
const TODAY = '2026-11-15';
const auth: RequestHandler = (req, _res, next) => {
  req.holdrAuth = { kind: 'session', userId: 'test-owner', username: 'test-owner', sessionId: 'test-session' };
  next();
};
const backup = () => path.join(dir, `backup-${++backups}.db`);
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-category-sources-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date(`${TODAY}T12:00:00.000Z`) });
  backups = 0;
  logs = [];
});
afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function row(patch: Partial<CardImportRow>): CardImportRow {
  return { transactionDate: '2026-09-10', postedDate: null, status: 'posted', amountMinor: 1000, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE STORE', merchant: null, issuerCategory: null, ...patch } as CardImportRow;
}

/**
 * The card rows, by name: Amazon charges split (one of them kept whole by the owner's own category), held (two charges
 * for one order), refunded (in full, and a credit for one line of another order) and unitemized, and others. A credit
 * set against its own order's charge, not by the merchant rule, needs the source's order matches.
 */
const ROWS = {
  order1: row({ transactionDate: '2026-09-02', amountMinor: 1200, description: 'AMAZON MKTPL*SYNTH21', issuerCategory: 'Shopping' }),
  order2: row({ transactionDate: '2026-09-03', amountMinor: 1430, description: 'AMAZON MKTPL*SYNTH22', issuerCategory: 'Shopping' }),
  order1Refund: row({ transactionDate: '2026-09-20', amountMinor: -1200, kind: 'refund', description: 'AMAZON MKTPL*SYNTH23', issuerCategory: 'Shopping' }),
  order2Credit: row({ transactionDate: '2026-10-05', amountMinor: -660, kind: 'refund', description: 'AMAZON MKTPL*SYNTH24', issuerCategory: 'Shopping' }),
  unlinkedCredit: row({ transactionDate: '2026-10-07', amountMinor: -250, kind: 'refund', description: 'AMAZON MKTPL*SYNTH25', issuerCategory: 'Shopping' }),
  order3: row({ transactionDate: '2026-10-01', amountMinor: 62000, description: 'AMAZON MKTPL*SYNTH26', issuerCategory: 'Shopping' }),
  order3Refund: row({ transactionDate: '2026-10-20', amountMinor: -62000, kind: 'refund', description: 'AMAZON MKTPL*SYNTH27', issuerCategory: 'Shopping' }),
  order4: row({ transactionDate: '2026-10-15', amountMinor: 4321, description: 'AMAZON MKTPL*SYNTH28', issuerCategory: 'Shopping' }),
  order4Twin: row({ transactionDate: '2026-10-16', amountMinor: 4321, description: 'AMAZON MKTPL*SYNTH29', issuerCategory: 'Shopping' }),
  digital: row({ transactionDate: '2026-10-03', amountMinor: 999, description: 'AMAZON DIGITAL SVCS SYNTH30', issuerCategory: 'Shopping' }),
  unmatched: row({ transactionDate: '2026-10-09', amountMinor: 2345, description: 'AMAZON MKTPL*SYNTH31', issuerCategory: 'Shopping' }),
  pending: row({ transactionDate: '2026-11-12', amountMinor: 777, status: 'pending', description: 'AMAZON MKTPL*SYNTH32', issuerCategory: 'Shopping' }),
  hardware: row({ transactionDate: '2026-10-08', amountMinor: 5000, description: 'SYNTHETIC HARDWARE STORE', issuerCategory: 'Home' }),
  hardwareRefund: row({ transactionDate: '2026-10-10', amountMinor: -1000, kind: 'refund', description: 'SYNTHETIC HARDWARE STORE', issuerCategory: 'Home' }),
  cafe: row({ transactionDate: '2026-10-12', amountMinor: 800, description: 'SYNTHETIC CAFE', issuerCategory: 'Dining' }),
  books: row({ transactionDate: '2026-11-02', amountMinor: 2400, description: 'SYNTHETIC BOOKS' }),
};
type RowName = keyof typeof ROWS;

/**
 * Four complete, single-card synthetic orders: 1 (700 + 500, no tax), 2 (600 + 400 + 300, tax 130), 3 (300.00 +
 * 320.00) and 4 (4000 + 321, no tax, charged twice).
 */
function capture() {
  const c = syntheticCapture();
  const base = c.staging.orders[0];
  const order = (orderId: string, date: string, lines: Array<[number, number]>, tax: number) => {
    const subtotal = lines.reduce((sum, [unit, qty]) => sum + unit * qty, 0), total = subtotal + tax;
    return { ...structuredClone(base), orderId, date, total: usd(total),
      items: lines.map(([unit, qty], lineOrdinal) => ({ lineOrdinal, itemId: `SYNTH${String(Number(orderId.slice(-2)) * 10 + lineOrdinal + 1).padStart(5, '0')}`,
        title: `Synthetic composite item ${orderId.slice(-2)}-${lineOrdinal}`, quantity: qty, unitPrice: usd(unit) })),
      summary: [{ kind: 'items-subtotal' as const, money: usd(subtotal) }, { kind: 'shipping' as const, money: usd(0) },
        { kind: 'tax' as const, money: usd(tax) }, { kind: 'grand-total' as const, money: usd(total) }],
      itemProof: { complete: true, unknownLine: false, conflict: false } };
  };
  c.staging.orders = [order('000-0000021-0000001', '2026-09-01', [[700, 1], [500, 1]], 0),
    order('000-0000021-0000002', '2026-09-02', [[600, 1], [400, 1], [300, 1]], 130),
    order('000-0000021-0000003', '2026-09-30', [[30000, 1], [32000, 1]], 0),
    order('000-0000021-0000004', '2026-10-14', [[4000, 1], [321, 1]], 0)];
  c.staging.coverage.orders = { status: 'partial', reason: 'budget', pages: 1, records: 4, rejected: 0 };
  c.staging.coverage.details = { status: 'partial', reason: 'budget', pages: 1, records: 9, rejected: 0 };
  return c;
}

/** The card, its rows, the capture, the approved binding, the item categories and one row of the owner's own category. */
async function seed() {
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
  const names = Object.keys(ROWS) as RowName[];
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: names.map((name) => ROWS[name]) });
  const db = repo.internalGetDb();
  await importAmazonCapture(db, capture(), backup());
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db));
  await recordBindingProposal(db, proposal, backup());
  await recordRootApproval(db, proposal, rootApproval(proposal), backup());
  const categories = ['Synthetic Kitchen', 'Synthetic Garden', 'Synthetic Toys'];
  await backedUpWrite(db, backup(), () => {
    for (const item of db.prepare('SELECT ref,data_json FROM amazon_items').all() as Array<{ ref: string; data_json: string }>) {
      db.prepare('INSERT OR REPLACE INTO amazon_item_overrides VALUES(?,?)').run(item.ref, categories[JSON.parse(item.data_json).lineOrdinal]);
    }
  });
  const listed = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] });
  const ids = Object.fromEntries(names.map((name) => [name,
    listed.find((t) => t.description === ROWS[name].description && t.amountMinor === ROWS[name].amountMinor)!.id])) as Record<RowName, string>;
  repo.updateCardTransaction(ids.order1, { userCategory: 'Synthetic Gifts' }, { actorRef: cardSyncActorRef('test-owner') });
  return { card, ids, amazon: createAmazonCategoryResolver(db) };
}

/** Spending's three category-reading routers, as the app mounts them, with one category source. */
function spending(source: CardCategorySource): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => { logs.push(line); };
  mountCardSpendingRoutes(server, { repo, requireAuth: auth, log, routers: [
    createCardTransactionsRouter(repo, { log, categoryResolver: source }),
    createCardSpendingOverviewRouter(repo, { log, categoryResolver: source }),
    createCardSpendingForecastRouter(repo, { log, categoryResolver: source }),
  ] });
  return server;
}

/** One answer, as its bytes: status, content type and body text. */
async function answer(server: express.Express, url: string) {
  const res = await request(await listenLoopback(server)).get(url);
  return { status: res.status, type: res.headers['content-type'] as string | undefined, text: res.text };
}

/** The category marker of Spending's summary, through one source. */
async function markerOf(source: CardCategorySource) {
  const body = JSON.parse((await answer(spending(source), '/spending/summary')).text) as {
    categoryBasis: { splitRows: number; heldOrDeclined: unknown[]; invalid: unknown[] };
  };
  return body.categoryBasis;
}

/** Every route of the three routers, each on both category bases, under the filters the Spending tab sends, and more. */
function urls(ids: Record<RowName, string>, cardAccountId: string): string[] {
  const bases = (url: string) => [url, `${url}${url.includes('?') ? '&' : '?'}categoryBasis=original`];
  const compare = `/spending/compare?from=2026-10-01&to=2026-10-31&baselineFrom=2026-09-01&baselineTo=2026-09-30&today=${TODAY}`;
  return [
    ...['', 'limit=200', 'status=pending', 'status=posted&limit=5&offset=5', 'kind=refund', 'sort=amount-desc',
      'category=Synthetic%20Kitchen', 'category=Shopping', 'category=Synthetic%20Gifts', 'q=amazon', `cardAccountId=${cardAccountId}`]
      .flatMap((query) => bases(`/card-transactions${query ? `?${query}` : ''}`)),
    ...bases('/card-transactions?amazon=unitemized'),
    '/card-transactions?amazon=unitemized&currency=USD',
    '/card-transactions?amazon=unitemized&category=Shopping',
    ...(Object.keys(ids) as RowName[]).flatMap((name) => bases(`/card-transactions/${ids[name]}`)),
    ...['', 'from=2026-09-01&to=2026-09-30', 'from=2026-10-01&to=2026-10-31', 'category=Synthetic%20Garden', 'category=Shopping',
      'owner=casey', 'q=synth'].flatMap((query) => bases(`/spending/summary${query ? `?${query}` : ''}`)),
    ...bases('/spending/accounting'),
    ...bases('/spending/coverage'),
    ...[`month=2026-10&today=${TODAY}`, `month=2026-09&today=${TODAY}`, `owner=casey&today=${TODAY}`]
      .flatMap((query) => bases(`/spending/insights?${query}`)),
    `/spending/coverage/months?today=${TODAY}`,
    ...bases(compare),
    ...bases(`${compare}&category=Synthetic%20Toys`),
    ...bases(`/spending/trend?fromMonth=2026-09&toMonth=2026-11&today=${TODAY}`),
    ...bases(`/spending/forecast?today=${TODAY}`),
    ...bases(`/spending/patterns?today=${TODAY}`),
  ];
}

describe('Spending through the composite category source', () => {
  it('answers every route exactly as the Amazon domain\'s own resolver did, byte for byte, on both bases', async () => {
    const { card, ids, amazon } = await seed();
    const direct = spending(amazon), composite = spending(createCompositeCategoryResolver([amazon]));
    const differences: string[] = [];
    const statuses = new Map<number, number>();
    for (const url of urls(ids, card.id)) {
      const [before, after] = [await answer(direct, url), await answer(composite, url)];
      if (JSON.stringify(after) !== JSON.stringify(before)) differences.push(url);
      statuses.set(before.status, (statuses.get(before.status) ?? 0) + 1);
    }
    // The scenario is what it claims: split, held and refunded Amazon charges, and a refusal answered alike.
    const summary = JSON.parse((await answer(direct, '/spending/summary')).text) as { categoryBasis: Record<string, any> };
    expect([summary.categoryBasis.splitRows > 0, summary.categoryBasis.heldOrDeclined.length > 0,
      summary.categoryBasis.keptWholeByUserCategory > 0, statuses.get(400) !== undefined]).toEqual([true, true, true, true]);
    expect(differences).toEqual([]);
    // And no request, through either source, failed through Spending's catch-all.
    expect(logs.filter((line) => line.includes(' request failed'))).toEqual([]);
  });

  it('gives the Amazon domain\'s version and answers while Amazon is its only source', async () => {
    const { ids, amazon } = await seed();
    const snapshot = createCompositeCategoryResolver([amazon]).snapshot(), own = amazon.snapshot();
    expect(snapshot.version).toBe(own.version);
    const rows = (Object.keys(ids) as RowName[]).map((name) => ({ id: ids[name], currency: 'USD', amountMinor: ROWS[name].amountMinor }));
    expect(JSON.stringify([...snapshot.resolve(rows)])).toBe(JSON.stringify([...own.resolve(rows)]));
  });
});

describe('which rows a source links', () => {
  it('is said by Amazon\'s card detail, row by row', async () => {
    const { ids, amazon } = await seed();
    const snapshot = createCompositeCategoryResolver([amazon]).snapshot(), own = amazon.snapshot();
    const said = Object.values(ids).map((id) => snapshot.isLinkedRow(id));
    expect(said).toEqual(Object.values(ids).map((id) => own.getCardDetail(id).match === 'linked'));
    expect([said.includes(true), said.includes(false)]).toEqual([true, true]);
  });

  /** A card with two plain charges, and a stand-in source splitting the first of them (500 to Home, the rest its own). */
  function stand(detail: (id: string, first: string) => 'linked' | 'held' | 'none', isLinkedRow?: (id: string, first: string) => unknown) {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      row({ transactionDate: '2026-10-12', amountMinor: 800, description: 'SYNTHETIC CAFE', issuerCategory: 'Dining' }),
      row({ transactionDate: '2026-10-13', amountMinor: 900, description: 'SYNTHETIC GARDEN SHOP', issuerCategory: 'Home' }),
    ] });
    const first = repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((t) => t.description === 'SYNTHETIC CAFE')!.id;
    const resolution: CardCategoryResolution = { kind: 'split', cardTransactionId: first, currency: 'USD', evidenceClass: 'unique-total-match',
      contributions: [{ amountMinor: 500, category: 'Home', categorySource: 'reviewed-mapping', classification: 'source', itemRef: 'synthetic-item-1' },
        { amountMinor: 300, category: null, categorySource: null, classification: 'residual' }] };
    const snapshot = {
      version: 'rev-stand-in',
      resolve: (rows: ReadonlyArray<{ id: string }>) => new Map(rows.some((r) => r.id === first) ? [[first, resolution]] : []),
      getCardDetail: (id: string) => ({ version: 'rev-stand-in', match: detail(id, first), coverage: { complete: false } }),
      getOrderMatches: () => [],
      isAmazonCharge: () => false,
      ...(isLinkedRow ? { isLinkedRow: (id: string) => isLinkedRow(id, first) } : {}),
    };
    return { first, snapshot };
  }

  it('lets a split stand for a row Amazon\'s card detail links', async () => {
    const linked = stand((id, first) => (id === first ? 'linked' : 'none'));
    const marker = await markerOf(createCompositeCategoryResolver([{ snapshot: () => linked.snapshot } as unknown as AmazonResolver]));
    expect([marker.splitRows, marker.invalid]).toEqual([1, []]);
  });

  it('refuses a split of a row Amazon\'s card detail holds, as not linked', async () => {
    const held = stand((id, first) => (id === first ? 'held' : 'none'));
    const marker = await markerOf(createCompositeCategoryResolver([{ snapshot: () => held.snapshot } as unknown as AmazonResolver]));
    expect([marker.splitRows, marker.invalid]).toEqual([0, [{ reason: 'not-linked', count: 1 }]]);
  });

  it('reads a source\'s explicit isLinkedRow before its card detail, and only true links', async () => {
    // The card detail says linked; the explicit answer is what counts, and anything but true is no link.
    const said = new Map<string, unknown>();
    const source = stand((id, first) => (id === first ? 'linked' : 'none'), (id) => said.get(id) ?? false);
    const asSource = { snapshot: () => source.snapshot } as unknown as CardCategorySource;
    said.set(source.first, true);
    const linked = await markerOf(asSource);
    expect([linked.splitRows, linked.invalid]).toEqual([1, []]);
    for (const answerGiven of [false, 'true', 1]) {
      said.set(source.first, answerGiven);
      const marker = await markerOf(asSource);
      expect([marker.splitRows, marker.invalid], String(answerGiven)).toEqual([0, [{ reason: 'not-linked', count: 1 }]]);
    }
  });
});

describe('a receipt\'s precious metals, as a source holds them', () => {
  it('keeps each row whole under its own reason, counted apart, and refuses none', async () => {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9003', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      row({ transactionDate: '2026-10-12', amountMinor: 250000, description: 'SYNTHETIC WAREHOUSE CLUB', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-10-13', amountMinor: 90000, description: 'SYNTHETIC WAREHOUSE CLUB', issuerCategory: 'Shopping' }),
    ] });
    const [metal, maybe] = repo.listCardTransactionsMatching({ statuses: ['posted'] })
      .sort((a, b) => b.amountMinor - a.amountMinor).map((t) => t.id);
    const holds = new Map([[metal, 'asset-purchase'], [maybe, 'asset-uncertain']]);
    const snapshot = {
      version: 'rev-receipts',
      resolve: (rows: ReadonlyArray<{ id: string }>) => new Map(rows.filter((r) => holds.has(r.id))
        .map((r) => [r.id, { kind: 'whole-row', cardTransactionId: r.id, reason: holds.get(r.id) }])),
      getCardDetail: () => ({ version: 'rev-receipts', match: 'none', coverage: { complete: false } }),
      getOrderMatches: () => [],
      isAmazonCharge: () => false,
    };
    const marker = await markerOf(createCompositeCategoryResolver([{ snapshot: () => snapshot } as unknown as AmazonResolver]));
    expect([marker.heldOrDeclined, marker.invalid]).toEqual([[{ reason: 'asset-purchase', count: 1 }, { reason: 'asset-uncertain', count: 1 }], []]);
  });
});
