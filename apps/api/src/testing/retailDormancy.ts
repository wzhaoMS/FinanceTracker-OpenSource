import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Express } from 'express';

import type { CheckingImportPayload } from '@finance-tracker/shared';
import type { MetalsEvent, MetalsImportPayload, MetalsOrder } from '@finance-tracker/shared/metals-ledger';
import {
  delivered,
  inStore,
  metalItem,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
} from '@finance-tracker/shared/metals-ledger-fixtures';

import { validateCapture } from '../services/amazon/capture.js';
import { syntheticCapture } from '../services/amazon/fixtures.testSupport.js';
import { writeValidatedCapture } from '../services/amazon/importer.js';
import { digest, opaque } from '../services/amazon/policy.js';
import { ensureAmazonSchema } from '../services/amazon/schema.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { importMetalsPayload, installMetalsSchema, metalsPayloadSha256, type MetalsAccountChoice } from '../services/metals/index.js';
import type { CardImportRow, SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { declaration, importPayload } from './retailDb.js';
import {
  SYNTHETIC_RETAIL,
  couponLine,
  gasReceipt,
  goldBar,
  heldRecord,
  onlineOrder,
  syntheticRetailPayload,
  warehouseKey,
  warehouseLine,
  warehouseReceipt,
  warehouseRefund,
} from './retailPayloads.js';

/**
 * The world the retail dormancy suite (app.retailDormant.test.ts) compares every existing answer over: card rows, the
 * metals ledger (Costco gold included), checking, Amazon and a brokerage account, then the retail receipts. Synthetic
 * only: made-up descriptors, amounts, card endings, ids and dates, through each domain's real importer.
 */

export const DORMANCY_TODAY = '2031-03-01';
const IMPORTED_AT = Date.parse('2031-02-28T12:00:00.000Z');
const BAR_TITLE = 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999';

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** A GO id per write: 32 lowercase hex, made up and distinct. */
const goId = (n: number) => n.toString(16).padStart(32, 'f');

// ---- the existing domains -------------------------------------------------------------------------------------------

const cardRow = (patch: Partial<CardImportRow>): CardImportRow => ({
  transactionDate: '2031-01-10', postedDate: null, status: 'posted', amountMinor: 1_080, currency: 'USD', kind: 'purchase',
  description: 'SAMPLE WAREHOUSE CLUB', merchant: null, issuerCategory: null, ...patch,
} as CardImportRow);

/** A Walmart order of 1 ozt gold bars, one card (ending 1111), delivered on the fourth day. */
function walmartBar(id: number, date: string, quantity = 1): MetalsOrder {
  const amount = 200_000 * quantity;
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, amount)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: amount }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amount,
    },
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'walmart:100001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity, unitPriceMinor: 200_000,
      events: [delivered(quantity, addDays(date, 4))] as MetalsEvent[], seller: 'Sample Bullion Shop',
    }],
  });
}

/** A CollectPure sale of one 1 ozt gold bar at $2,100.00, a $20.00 fee and $10.00 shipping, paid out on the third day (2222). */
function barSale(id: number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 210_000)],
    components: [{ kind: 'platform-fee', amountMinor: -2_000 }, { kind: 'insured-shipping', amountMinor: -1_000 }],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 207_000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210_000,
      events: [{ kind: 'agreed', date, dateBasis: 'stated', quantity: 1, occurrence: 1 }],
      sale: { program: 'Sell to Dealer', premium: { text: 'spot +5.0000% / +$100.00 per troy ounce', basis: 'troy_ounce' }, inspection: 'passed' },
    }],
  });
}

/** A Costco warehouse receipt of one bare-"oz" gold bar (card ending 3333): Costco gold, in the Gold ledger. */
function costcoGold(id: string, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'warehouse', id, date,
    skeleton: [metalItem(0, 205_000, { taxFlag: 'non-taxable' })],
    admission: {
      fulfilment: 'in-store', methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 205_000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 205_000,
    },
    lines: [{
      ordinal: 0, title: 'GOLD BULLION BAR SAMPLE PAMP', productRef: 'costco:300001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'oz' },
      pack: 'single', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: null, events: [inStore(1, date)],
    }],
  });
}

/** Daily closes of gold on every weekday from `from` to `to`, as the metals price store keeps them. */
function seedGoldCloses(db: Database.Database, from: string, to: string): void {
  const insert = db.prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('holdr:metal:XAU', 'daily', ?, ?, 'cnbc-spot-daily')`);
  for (let date = from, close = 2_000; date <= to; date = addDays(date, 1), close += 1) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) insert.run(date, close);
  }
}

/** The ids the comparison's URLs name, from the seeded world. */
export interface DormancyWorld {
  /** Every card transaction, pending or posted (PR 2's rows first). */
  cardTransactions: string[];
  /** A card payment the checking ledger paid. */
  cardPayment: string;
  checkingAccount: string;
  amazonOrder: string;
  account: string;
  transaction: string;
}

/**
 * Seeds every existing domain: PR 2's card rows (the Costco-like charges a later retail PR links), the metals ledger
 * (Walmart bars, a CollectPure sale, Costco gold) with the cards that paid it and gold closes, a checking account with the
 * sale's payout and a card payment's debit, one Amazon capture, and a brokerage account with one purchase.
 */
export async function seedExistingWorld(repo: SqliteStateRepo): Promise<DormancyWorld> {
  const db = repo.internalGetDb();
  const coverage = { start: '2030-12-01', end: '2031-02-28' };
  const card = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0007', currency: 'USD' });
  const other = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0011', currency: 'USD' });
  const visa = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', nickname: 'Sample Visa', last4: '1111', currency: 'USD' });
  const costcoCard = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '3333', currency: 'USD' });
  repo.importCardTransactions({
    cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      cardRow({}), cardRow({ transactionDate: '2031-01-11', amountMinor: 5_400, description: 'SAMPLE WAREHOUSE CLUB ONLINE' }),
      cardRow({ transactionDate: '2031-01-20', amountMinor: -1_080, kind: 'refund' }),
      cardRow({ transactionDate: '2031-02-02', amountMinor: 2_500, description: 'SAMPLE GROCER' }),
      cardRow({ transactionDate: '2031-02-12', amountMinor: -8_980, kind: 'payment', description: 'SAMPLE AUTOPAY PAYMENT' }),
    ],
  });
  repo.importCardTransactions({
    cardAccountId: other.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      cardRow({ transactionDate: '2031-01-15', amountMinor: 900, description: 'SAMPLE WAREHOUSE CLUB GAS' }),
    ],
  });
  repo.importCardTransactions({
    cardAccountId: visa.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      cardRow({ transactionDate: '2031-01-06', amountMinor: 200_000, description: 'WALMART.COM SAMPLE' }),
      cardRow({ transactionDate: '2031-02-04', amountMinor: 400_000, description: 'WALMART.COM SAMPLE' }),
    ],
  });
  repo.importCardTransactions({
    cardAccountId: costcoCard.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      cardRow({ transactionDate: '2031-01-18', amountMinor: 205_000, description: 'COSTCO WHSE #0001 SAMPLETOWN WA' }),
    ],
  });

  installMetalsSchema(db);
  let imports = 0;
  const metals = (payload: MetalsImportPayload, account: MetalsAccountChoice) => {
    const receipt = importMetalsPayload(db, { payload, account }, {
      now: new Date(IMPORTED_AT + imports * 60_000).toISOString(), goId: goId(++imports), purpose: 'copy-rehearsal',
      inputSha256: metalsPayloadSha256(payload), planDigest: null,
    });
    if (receipt.code !== 'metals-imported') throw new Error(`synthetic metals import refused: ${receipt.code}`);
  };
  metals(syntheticPayload('walmart', { orders: [walmartBar(1, '2031-01-05'), walmartBar(2, '2031-02-03', 2)],
    coverage: [syntheticCoverage('online', '2030-12-01', DORMANCY_TODAY, 9, 9)] }), { label: 'Walmart account' });
  metals(syntheticPayload('collectpure', { orders: [barSale(1, '2031-01-25')],
    coverage: [syntheticCoverage('sell-orders', '2030-12-01', DORMANCY_TODAY, 9, 9), syntheticCoverage('payouts', '2030-12-01', DORMANCY_TODAY, 9, 9)] }),
  { label: 'CollectPure account' });
  metals(syntheticPayload('costco', { orders: [costcoGold('r1', '2031-01-18')],
    coverage: [syntheticCoverage('online', '2030-12-01', DORMANCY_TODAY, 9, 9), syntheticCoverage('warehouse', '2030-12-01', DORMANCY_TODAY, 9, 9)] }),
  { label: 'Costco membership' });
  seedGoldCloses(db, '2030-12-01', '2031-02-28');

  installCheckingSchema(db);
  const checking: CheckingImportPayload = {
    format: 'holdr.checking-import', version: 1, parserVersion: 'holdr-checking-import@1.0.0',
    account: { institution: 'wellsfargo', type: 'checking', last4: '2222', label: 'Sample Bank Everyday Checking', currency: 'USD' },
    segments: [{
      source: 'ofx', coverage: { start: '2030-12-01', end: '2031-02-28' }, anchors: [],
      rows: [
        { postedDate: '2031-01-30', amountMinor: 207_000, description: 'SAMPLE DEALER ACH CREDIT', checkNumber: null, bankType: 'CREDIT', externalIdHash: null },
        { postedDate: '2031-02-12', amountMinor: -8_980, description: 'SAMPLE CARD AUTOPAY', checkNumber: null, bankType: 'DEBIT', externalIdHash: null },
      ],
    }],
  };
  importCheckingPayload(db, checking, { now: new Date(IMPORTED_AT).toISOString(), goId: goId(100), purpose: 'copy-rehearsal' });

  const capture = syntheticCapture();
  const validated = await validateCapture(capture);
  db.transaction(() => {
    ensureAmazonSchema(db);
    writeValidatedCapture(db, validated, digest(capture), new Date(IMPORTED_AT).toISOString());
  }).immediate();

  repo.createAccount({ id: 'sample-brokerage', name: 'Sample Brokerage', cashBalance: 1_000, currency: 'USD' });
  repo.createTransaction({ id: 'sample-buy', accountId: 'sample-brokerage', symbol: 'SAMPLE', date: '2031-01-05', quantity: 2, pricePerUnit: 50,
    currency: 'USD' });

  const transactions = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
  return {
    cardTransactions: transactions.map((transaction) => transaction.id),
    cardPayment: transactions.find((transaction) => transaction.kind === 'payment')!.id,
    checkingAccount: db.prepare('SELECT id FROM checking_accounts').pluck().get() as string,
    amazonOrder: opaque('order', capture.staging.orders[0].orderId),
    account: 'sample-brokerage',
    transaction: 'sample-buy',
  };
}

// ---- the retail receipts ----------------------------------------------------------------------------------------------

/** How many receipts `seedRetailReceipts` stores. */
export const RETAIL_FULL_RECEIPTS = 7;

/**
 * Fills the installed retail tables through PR 2's real importer: warehouse receipts (one a gold bar's, one with a
 * coupon), an online order, a gas receipt, a refund and held records; a second capture that changed a receipt
 * (quarantined); and a second membership, `costco-2`, whose capture holds a receipt the first one holds too.
 */
export function seedRetailReceipts(db: Database.Database): void {
  const gold = warehouseReceipt(7, { date: '2031-01-18', taxMinor: 0, lines: [
    warehouseLine(0, 205_000, { title: SYNTHETIC_RETAIL.bar, taxFlag: 'N', metal: goldBar() }),
  ] });
  const coupon = warehouseReceipt(9, { date: '2031-01-24', lines: [warehouseLine(0, 2_000), couponLine(1, 0, -300)] });
  importPayload(db, syntheticRetailPayload({
    receipts: [warehouseReceipt(1), onlineOrder(2), warehouseReceipt(3, { date: '2031-01-15' }), gold, gasReceipt(5, { date: '2031-01-15' }),
      warehouseRefund(6, { date: '2031-01-20' }), coupon],
    held: [heldRecord({ naturalKey: warehouseKey(4) }), heldRecord({ naturalKey: warehouseKey(8), date: '2031-01-22' })],
  }));
  importPayload(db, syntheticRetailPayload({ capture: 'c', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] }));
  importPayload(db, syntheticRetailPayload({ folder: 'costco-2', capture: 'd', receipts: [warehouseReceipt(3, { date: '2031-01-15' })] }),
    { declaration: declaration('costco-2', 'casey') });
}

// ---- the routes ---------------------------------------------------------------------------------------------------------

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: unknown[];
}

/** The literal mount path of an Express 4 router layer (as app.routes.test.ts reads it). */
function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const match = /^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!match || (layer.keys?.length ?? 0) > 0) throw new Error('cannot read a mount path');
  return match[1].replace(/\\\//g, '/');
}

function listRoutes(stack: Layer[], prefix = ''): string[] {
  const routes: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled && method !== '_all') routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...listRoutes(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return routes;
}

/** Every GET route registered on the app, as `GET /path/:param`, sorted, each once. */
export function registeredGetRoutes(app: Express): string[] {
  const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  return [...new Set(listRoutes(stack).filter((route) => route.startsWith('GET ')))].sort();
}

/** Whether a concrete URL's path is one a route pattern matches (`:param` one segment; an optional trailing slash). */
export function routeMatches(route: string, url: string): boolean {
  const pattern = route.slice('GET '.length).replace(/\/$/, '').split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${pattern}/?$`).test(url.split('?')[0]);
}

/** A placeholder for a path parameter no seeded record has: a well-formed id nothing holds, so its answer is a stable 404. */
const NONE = 'a'.repeat(32);

/**
 * The URLs each existing GET route is asked: real ids from the seeded world where a route names one, a placeholder
 * (a stable 404) elsewhere, and the query variants the pages send. Keyed by every registered GET route outside /retail.
 */
export function existingRouteUrls(world: DormancyWorld): Record<string, string[]> {
  const today = DORMANCY_TODAY;
  const window = '&from=2031-01-01&to=2031-01-31';
  return {
    'GET /accounts': ['/accounts'],
    'GET /accounts/:id/cash-events': [`/accounts/${world.account}/cash-events`],
    'GET /accounts/:id/cash-history': [`/accounts/${world.account}/cash-history`],
    'GET /accounts/:id/history': [`/accounts/${world.account}/history`, `/accounts/${world.account}/history?range=1M`],
    'GET /accounts/:id/nav-history': [`/accounts/${world.account}/nav-history`],
    'GET /accounts/:id/transactions': [`/accounts/${world.account}/transactions`, '/accounts/sample-none/transactions'],
    'GET /amazon/fresh': ['/amazon/fresh', `/amazon/fresh?window=2Y&today=${today}`],
    'GET /amazon/fresh/orders/:ref': [`/amazon/fresh/orders/${world.amazonOrder}`],
    'GET /amazon/items/:ref/image': [`/amazon/items/${world.amazonOrder}/image`],
    'GET /amazon/orders': ['/amazon/orders', '/amazon/orders?beneficiary=unknown&limit=1'],
    'GET /amazon/orders/:ref': [`/amazon/orders/${world.amazonOrder}`],
    'GET /amazon/spending': ['/amazon/spending', '/amazon/spending?window=2Y&today=2026-10-19'],
    'GET /amazon/spending/taxonomy': ['/amazon/spending/taxonomy', '/amazon/spending/taxonomy?window=2Y&today=2026-10-19'],
    'GET /amazon/summary': ['/amazon/summary'],
    'GET /auth/me': ['/auth/me'],
    'GET /card-accounts': ['/card-accounts'],
    'GET /card-imports/cutover-capability': ['/card-imports/cutover-capability'],
    'GET /card-imports/cutover-receipt': ['/card-imports/cutover-receipt'],
    'GET /card-sync/owner/bindings': ['/card-sync/owner/bindings'],
    'GET /card-sync/owner/bindings/:bindingId/devices': [`/card-sync/owner/bindings/${NONE}/devices`],
    'GET /card-sync/owner/devices': ['/card-sync/owner/devices'],
    'GET /card-sync/owner/observation-sets': ['/card-sync/owner/observation-sets?view=open', '/card-sync/owner/observation-sets?view=closed'],
    'GET /card-sync/owner/observation-sets/:observationSetId': [`/card-sync/owner/observation-sets/${NONE}`],
    'GET /card-sync/owner/pairings': ['/card-sync/owner/pairings'],
    'GET /card-sync/owner/plans/:previewId/effects': [`/card-sync/owner/plans/${NONE}/effects`],
    'GET /card-sync/owner/runs': ['/card-sync/owner/runs'],
    'GET /card-sync/owner/runs/:runId': [`/card-sync/owner/runs/${NONE}`],
    'GET /card-sync/owner/runs/:runId/payload': [`/card-sync/owner/runs/${NONE}/payload`],
    'GET /card-sync/owner/state': ['/card-sync/owner/state'],
    'GET /card-sync/owner/transactions/:transactionId/sources': [`/card-sync/owner/transactions/${world.cardTransactions[0]}/sources`],
    'GET /card-transactions': ['/card-transactions?limit=200', '/card-transactions?kind=purchase', '/card-transactions?status=posted'],
    'GET /card-transactions/:id': world.cardTransactions.flatMap((id) => [`/card-transactions/${id}`, `/card-transactions/${id}?categoryBasis=enriched`]),
    'GET /cash-events': ['/cash-events'],
    'GET /cash/owed': ['/cash/owed'],
    'GET /cash/payments': ['/cash/payments'],
    'GET /checking/accounts': ['/checking/accounts'],
    'GET /checking/transactions': ['/checking/transactions?from=2030-12-01&to=2031-03-01',
      `/checking/transactions?from=2031-01-01&to=2031-02-28&accountId=${world.checkingAccount}&limit=1`],
    'GET /export': ['/export'],
    'GET /health': ['/health'],
    'GET /manual-prices/': ['/manual-prices'],
    'GET /manual-prices/:symbol': ['/manual-prices/SAMPLE'],
    'GET /metals/answers': ['/metals/answers', '/metals/answers?metal=XAG'],
    'GET /metals/card-check': ['/metals/card-check', '/metals/card-check?asOf=2031-02-01'],
    'GET /metals/closes': ['/metals/closes', '/metals/closes?metal=XAU&from=2031-01-01&to=2031-02-28'],
    'GET /metals/funding': ['/metals/funding', `/metals/funding?from=2031-01-01&to=${today}`],
    'GET /metals/overview': ['/metals/overview', `/metals/overview?metal=XAU${window}`, '/metals/overview?metal=XAU&asOf=2031-02-01',
      '/metals/overview?metal=XAG'],
    'GET /metals/products': ['/metals/products', '/metals/products?metal=XAU'],
    'GET /metals/purchases': ['/metals/purchases', `/metals/purchases?metal=XAU${window}`],
    'GET /metals/sales': ['/metals/sales', `/metals/sales?metal=XAU${window}`],
    'GET /metals/sources/roster/preview': ['/metals/sources/roster/preview'],
    'GET /metals/timeline': ['/metals/timeline', '/metals/timeline?metal=XAU&fromMonth=2030-12&toMonth=2031-03'],
    'GET /portfolio/history': ['/portfolio/history', '/portfolio/history?range=1M'],
    'GET /portfolio/performance': ['/portfolio/performance'],
    'GET /quotes/': ['/quotes?symbols=SAMPLE'],
    'GET /release/attestation': ['/release/attestation'],
    'GET /spending/accounting': ['/spending/accounting'],
    'GET /spending/balance-chains': ['/spending/balance-chains', `/spending/balance-chains?accountId=${world.checkingAccount}`],
    'GET /spending/benefits': ['/spending/benefits'],
    'GET /spending/card-openings': ['/spending/card-openings'],
    'GET /spending/compare': [`/spending/compare?from=2031-01-01&to=2031-01-31&baselineFrom=2030-12-01&baselineTo=2030-12-31&today=${today}`],
    'GET /spending/coverage': ['/spending/coverage'],
    'GET /spending/coverage/months': ['/spending/coverage/months'],
    'GET /spending/forecast': ['/spending/forecast'],
    'GET /spending/insights': [`/spending/insights?month=2031-01&today=${today}`],
    'GET /spending/patterns': ['/spending/patterns'],
    'GET /spending/payment-reconciliation': ['/spending/payment-reconciliation'],
    'GET /spending/payment-reconciliation/payments/:id': [`/spending/payment-reconciliation/payments/${world.cardPayment}`],
    'GET /spending/rules/preview': ['/spending/rules/preview?merchantClass=costco-warehouse&currency=USD&minAmountMinor=100000',
      '/spending/rules/preview?merchantClass=bullion-dealer&currency=USD&minAmountMinor=1'],
    'GET /spending/summary': ['/spending/summary', '/spending/summary?from=2031-01-01&to=2031-01-31'],
    'GET /spending/trend': ['/spending/trend'],
    'GET /symbols/:symbol/history': ['/symbols/SAMPLE/history'],
    'GET /transactions': ['/transactions'],
    'GET /transactions/:id/cost-basis-check': [`/transactions/${world.transaction}/cost-basis-check`],
  };
}

// ---- the module graph ---------------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/api/src. */
export const API_SRC = path.resolve(here, '..');
const SHARED_PACKAGE = path.resolve(API_SRC, '../../../packages/shared');
// The package exports compiled files; the closure follows each one back to its TypeScript source.
const SHARED_EXPORTS: Record<string, string> = Object.fromEntries(Object.entries(
  (JSON.parse(fs.readFileSync(path.join(SHARED_PACKAGE, 'package.json'), 'utf8')) as { exports: Record<string, { import: string }> }).exports,
).map(([key, target]) => [key, target.import.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')]));
export const SHARED_SRC = path.join(SHARED_PACKAGE, 'src');

/**
 * A module's import specifiers: imports, re-exports, side-effect and dynamic imports. `import type` and `export type`
 * are erased at runtime, so they count only with `types` (a module that names one still mentions it).
 */
export function moduleSpecifiers(source: string, types = false): string[] {
  const statics = types
    ? /^\s*(?:import|export)\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm
    : /^\s*(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  const dynamics = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...[...source.matchAll(statics)].map((match) => match[1] ?? match[2]), ...[...source.matchAll(dynamics)].map((match) => match[1])];
}

/** The shared package's source file a bare `@finance-tracker/shared[/sub]` specifier loads, through its exports map. */
function sharedTarget(specifier: string): string | null {
  const sub = specifier === '@finance-tracker/shared' ? '.' : specifier.startsWith('@finance-tracker/shared/') ? `./${specifier.slice(24)}` : null;
  if (sub === null) return null;
  const target = SHARED_EXPORTS[sub];
  if (target === undefined) throw new Error(`no shared export: ${specifier}`);
  return path.join(SHARED_PACKAGE, target);
}

/**
 * The modules an entry point loads at runtime, by path (read statically from its imports), and any relative import it
 * could not resolve. With `shared`, bare `@finance-tracker/shared[/sub]` imports are followed into the shared package.
 */
export function moduleClosure(entry: string, options: { shared?: boolean } = {}): { files: Map<string, string>; unresolved: string[] } {
  const files = new Map<string, string>();
  const unresolved: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    const source = fs.readFileSync(file, 'utf8');
    files.set(file, source);
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        const shared = options.shared ? sharedTarget(specifier) : null;
        if (shared !== null) visit(shared);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (fs.existsSync(target)) visit(target);
      else if (fs.existsSync(path.join(target, 'index.ts'))) visit(path.join(target, 'index.ts'));
      else if (!/\.(json|node)$/.test(specifier)) unresolved.push(specifier);
    }
  };
  visit(entry);
  return { files, unresolved };
}

/** A path relative to apps/api/src (or `shared/…` under packages/shared/src), with forward slashes. */
export function sourcePath(file: string): string {
  const inShared = !path.relative(SHARED_SRC, file).startsWith('..');
  return (inShared ? `shared/${path.relative(SHARED_SRC, file)}` : path.relative(API_SRC, file)).split(path.sep).join('/');
}
