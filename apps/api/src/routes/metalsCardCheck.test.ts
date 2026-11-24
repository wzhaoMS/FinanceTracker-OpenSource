import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

import {
  METALS_TITLE_GUARD,
  type MetalsAdmissionFacts,
  type MetalsCoverage,
  type MetalsCoverageKind,
  type MetalsImportPayload,
  type MetalsOrder,
} from '@finance-tracker/shared/metals-ledger';
import {
  delivered,
  metalItem,
  syntheticCompetitor,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
  type SyntheticLineInput,
} from '@finance-tracker/shared/metals-ledger-fixtures';
import type { MetalsCardCheck, MetalsCoverageProof, MetalsOverview, MetalsRosterPreview } from '@finance-tracker/shared/metals-api';

import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { installCardSpendingRulesSchema } from '../services/cardSpendingRules.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { installCashPlanSchema } from '../services/cashPlan.js';
import {
  approveMetalsBindings,
  importMetalsPayload,
  installMetalsSchema,
  metalsPayloadSha256,
  proposeMetalsBindings,
  serializeMetalsBindingProposal,
  sha256Hex,
  type MetalsAccountChoice,
  type MetalsBindingPair,
} from '../services/metals/index.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// The card cross-check's served read side (design v3.2 §8, PR-B): the route parts of controls 1, 4, 8, 9, 10, 13, 18,
// 19, 25 and 30-32, with installation, access and the snapshot shared by the overview, the card check and the preview.
// Synthetic only: invented orders, cents, last 4s (0001-0003), merchants and GO ids, on a scratch database this build
// made, through the real install and import (G2), card import and app (createApp). Nothing is fetched.

/** Failures injected into G1d's rules, read by the module mock below: off unless a test turns one on. */
const fail = vi.hoisted(() => ({ capture: false, proof: 'never' as 'never' | 'with-capture' | 'always' }));

vi.mock('@finance-tracker/shared/metals-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@finance-tracker/shared/metals-ledger')>();
  return {
    ...actual,
    metalsCardCapture: (...args: Parameters<typeof actual.metalsCardCapture>) => {
      if (fail.capture) throw new RangeError('synthetic capture failure');
      return actual.metalsCardCapture(...args);
    },
    metalsCoverageProof: (...args: Parameters<typeof actual.metalsCoverageProof>) => {
      if (fail.proof === 'always' || (fail.proof === 'with-capture' && args[0].capture !== null)) throw new TypeError('synthetic proof failure');
      return actual.metalsCoverageProof(...args);
    },
  };
});

const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '7c'.repeat(32);
const FAST = { ln: 10, r: 8, p: 1 };
/** Wednesday, 2030-03-20 in New York. */
const NOW = new Date('2030-03-20T16:00:00.000Z');
const TODAY = '2030-03-20';
const IMPORTED_AT = '2030-03-20T12:00:00.000Z';
const DATABASE_REF = 'c'.repeat(64);
const OWNER = { actorRef: cardSyncActorRef('test-owner') };
const UNAVAILABLE = { error: 'the card check is unavailable on this Holdr now; nothing was read', reason: 'unavailable' };
const LIMITS = ['card-check-only', 'non-card-funding', 'stored-value-only', 'warehouse-and-store', 'cards-not-in-holdr', 'undiscovered-dealers'];

let dir: string;
let repo: SqliteStateRepo;
let app: Express;
let cookie: string;
let logs: string[];
let imports: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-card-check-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  logs = [];
  imports = 0;
  fail.capture = false;
  fail.proof = 'never';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const db = () => repo.internalGetDb();
const goId = () => randomBytes(16).toString('hex');
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function start(): Promise<void> {
  const built = createApp({
    repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, now: () => NOW,
    log: (line) => logs.push(line),
  });
  app = built.app;
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN).set('X-Holdr-Request', '1')
    .send({ username: 'alex', password: 'synthetic password' });
  expect(login.status).toBe(200);
  cookie = (login.headers['set-cookie'] as unknown as string[]).find((entry) => entry.startsWith('holdr_session='))!.split(';')[0];
}

const signedIn = (test: request.Test) => test.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
const get = async (url: string) => signedIn(request(await listenLoopback(app)).get(url));
const service = async (url: string) => request(await listenLoopback(app)).get(url).set('Authorization', ['Bearer', TOKEN].join(' '));

const cardCheck = async (query = '') => (await get(`/metals/card-check${query}`)).body as MetalsCardCheck;
const preview = async () => (await get('/metals/sources/roster/preview')).body as MetalsRosterPreview;
const overview = async (query = 'metal=XAU') => (await get(`/metals/overview?${query}`)).body as MetalsOverview;
const proof = async (query = 'metal=XAU') => (await overview(query)).coverageProof;
const groupOf = (check: MetalsCardCheck, group: string) => check.groups.find((entry) => entry.group === group);
const merchantGroup = (check: MetalsCardCheck) => check.groups.find((entry) => entry.group.startsWith('merchant:'))!;

// ---------------------------------------------------------------------------
// Synthetic ledger
// ---------------------------------------------------------------------------

const card = (last4: string, amountMinor: number): MetalsAdmissionFacts => ({
  fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4, amountMinor }],
  refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amountMinor,
});

/** A Walmart.com order of one 1 oz gold Eagle coin (content by coin specification) for `amountMinor`, paid by one card. */
function walmartCoin(id: string, date: string, amountMinor: number, options: { last4?: string; flagged?: boolean; admission?: MetalsAdmissionFacts } = {}): MetalsOrder {
  const shared = { ordinal: 0, pack: 'single' as const, purity: null, quantity: 1, unitPriceMinor: amountMinor, events: [delivered(1, addDays(date, 4))],
    seller: 'Sample Bullion Shop' };
  // Flagged: a title the guard holds for metals (G3-int A0), naming gold; the order is held until the owner answers.
  const line: SyntheticLineInput = options.flagged
    ? { ...shared, title: 'Sample Refinery 1 ozt Gold Bar Assay Card', productRef: `walmart:card-${id}`, metal: null, form: null, statedMass: null,
      massBasis: 'none', design: null, metalUncertain: { guard: METALS_TITLE_GUARD, evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU' } }
    : { ...shared, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'walmart:400001', metal: 'XAU', form: 'coin', statedMass: { value: '1', unit: 'oz' },
      massBasis: 'none', design: 'eagle' };
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, amountMinor)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: options.admission ?? card(options.last4 ?? '0001', amountMinor),
    lines: [line],
  });
}

/** A Costco.com order of one 1 oz gold bar (Costco states no purity, mass basis or design), paid by the card ending 0003. */
function costcoBar(id: string, date: string, amountMinor: number): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'online', id, date,
    skeleton: [metalItem(0, amountMinor, { shippingMinor: 0 })],
    admission: card('0003', amountMinor),
    lines: [{
      ordinal: 0, title: 'Sample Refinery 1 oz Gold Bar', productRef: 'costco:400003', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: null, design: null, quantity: 1,
      unitPriceMinor: amountMinor, events: [delivered(1, addDays(date, 4))],
    }],
  });
}

/** A CollectPure sale of one 1 oz gold Eagle coin, paid out in full three days later. */
function coinSale(id: string, date: string, amountMinor = 300): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, amountMinor)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '0002', amountMinor, initiatedDate: payoutDate,
      payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'collectpure:SKU-EAGLE', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1,
      unitPriceMinor: amountMinor, events: [{ kind: 'agreed', date, dateBasis: 'stated', quantity: 1, occurrence: 1 }],
    }],
  });
}

const covered = (kind: MetalsCoverageKind, to = TODAY, complete = true): MetalsCoverage => syntheticCoverage(kind, '2029-01-01', to, complete ? 9 : 99, 9);

function importPayload(payload: MetalsImportPayload, account: MetalsAccountChoice): string {
  const now = new Date(Date.parse(IMPORTED_AT) + (imports++) * 60_000).toISOString();
  const receipt = importMetalsPayload(db(), { payload, account },
    { now, goId: goId(), purpose: 'copy-rehearsal', inputSha256: metalsPayloadSha256(payload), planDigest: null });
  expect(receipt.code).toBe('metals-imported');
  return receipt.accountId!;
}

const W1 = walmartCoin('w1', '2030-01-10', 250);
const S1 = coinSale('s1', '2030-02-03');

/**
 * The base ledger: a Walmart account with W1 ($2.50, by the card ending 0001, online coverage complete from
 * 2029-01-01), and a CollectPure account with the sale S1 (sell orders and payouts covered from 2029-01-01).
 */
function seedBase(walmartTo = TODAY): { walmart: string; collectpure: string } {
  installMetalsSchema(db());
  return {
    walmart: importPayload(syntheticPayload('walmart', { orders: [W1], coverage: [covered('online', walmartTo)] }), { label: 'Walmart account' }),
    collectpure: importPayload(syntheticPayload('collectpure', { orders: [S1], coverage: [covered('sell-orders'), covered('payouts')] }),
      { label: 'CollectPure account' }),
  };
}

const cardRow = (patch: Partial<CardImportRow>): CardImportRow => ({
  transactionDate: '2030-01-11', postedDate: null, status: 'posted', amountMinor: 250, currency: 'USD', kind: 'purchase',
  description: 'WALMART.COM SAMPLE', merchant: null, issuerCategory: null, ...patch,
} as CardImportRow);

/** The card ending 0001 with W1's charge, its coverage declared from 2030-01-01 through today. */
function seedCard(): { account: string; w1: string } {
  const account = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', nickname: 'Sample Visa', last4: '0001', currency: 'USD' });
  addRows(account.id, [cardRow({})], { start: '2030-01-01', end: TODAY });
  return { account: account.id, w1: rowId(account.id, 250) };
}

function addRows(cardAccountId: string, rows: CardImportRow[], coverage?: { start: string; end: string }): void {
  repo.importCardTransactions({ cardAccountId, source: 'test-file', parserVersion: 'test@1', rows, ...(coverage ? { coverage } : {}) });
}

/** The posted row of an account with this amount (one per amount in these tests). */
const rowId = (cardAccountId: string, amountMinor: number) => repo.listCardTransactionsMatching({ statuses: ['posted'] })
  .find((row) => row.cardAccountId === cardAccountId && row.amountMinor === amountMinor)!.id;

/** Removes a posted row as a mistaken import (as removed, dismissed and merged rows are: never usable). */
const removeRow = (id: string) => repo.removeCardTransaction({ id, reason: 'mistaken-import', expectedRevision: 1, actorRef: OWNER.actorRef });

/** Adds one row of each kind the check reads or counts, on the card ending 0001. */
function seedDiagnostics(account: string): Record<'dealer' | 'processor' | 'walmart' | 'costco', string> {
  addRows(account, [
    cardRow({ transactionDate: '2030-02-20', amountMinor: 410, description: 'SAMPLE BULLION CO' }),
    cardRow({ transactionDate: '2030-02-21', amountMinor: 420, description: 'PM TECHNOLOGIES' }),
    cardRow({ transactionDate: '2030-03-01', amountMinor: 430, description: 'WALMART.COM SAMPLE' }),
    cardRow({ transactionDate: '2030-03-02', amountMinor: 440, description: 'COSTCO.COM SAMPLE' }),
    // Counted only: a Costco warehouse, a Walmart store sale under an online name, and no class at all.
    cardRow({ transactionDate: '2030-03-03', amountMinor: 450, description: 'COSTCO WHSE SAMPLETOWN WA' }),
    cardRow({ transactionDate: '2030-03-04', amountMinor: 460, merchant: 'WALMART.COM', description: 'WALMART SAMPLETOWN WA' }),
    cardRow({ transactionDate: '2030-03-05', amountMinor: 470, description: 'SAMPLE COFFEE' }),
    // A credit at the dealer: listed only.
    cardRow({ transactionDate: '2030-02-25', amountMinor: -410, kind: 'refund', description: 'SAMPLE BULLION CO' }),
  ]);
  return { dealer: rowId(account, 410), processor: rowId(account, 420), walmart: rowId(account, 430), costco: rowId(account, 440) };
}

function approve(pairs: MetalsBindingPair[]): void {
  const { proposal } = proposeMetalsBindings(db(), DATABASE_REF);
  approveMetalsBindings(db(), proposal, { proposalSha256: sha256Hex(serializeMetalsBindingProposal(proposal)), inventoryDigest: proposal.inventoryDigest, pairs },
    { now: IMPORTED_AT, goId: goId(), purpose: 'copy-rehearsal', planDigest: null, databaseRef: DATABASE_REF });
}

/** Every row of every group, as [group, status, reasons]: what the check says, without its ids. */
const statuses = (check: MetalsCardCheck) => check.groups.flatMap((group) => [
  ...Object.entries(group.purchases).filter(([, count]) => count > 0).map(([status, count]) => [group.group, status, count]),
]);
const withoutProof = (view: MetalsOverview) => {
  const { coverageProof: _proof, ...rest } = view;
  return rest;
};

// ---------------------------------------------------------------------------

describe('the card check: installation and access', () => {
  it('answers installed: false without the tables, and the fixed 409 for tables of another shape', async () => {
    await start();
    for (const url of ['/metals/card-check', '/metals/sources/roster/preview']) {
      const res = await get(url);
      expect([url, res.status, res.body]).toEqual([url, 200, { installed: false }]);
    }
    db().exec('CREATE TABLE metals_stray (x TEXT)');
    for (const url of ['/metals/card-check', '/metals/sources/roster/preview', '/metals/overview']) {
      const res = await get(url);
      expect([url, res.status, res.body.reason]).toEqual([url, 409, 'schema-conflict']);
    }
  });

  it('needs sign-in, lets the service token read, and refuses card data (422) and a bad query (400), echoing neither', async () => {
    await start();
    seedBase();
    for (const url of ['/metals/card-check', '/metals/sources/roster/preview']) {
      expect((await request(await listenLoopback(app)).get(url)).status).toBe(401);
    }
    const read = await service('/metals/card-check');
    expect([read.status, read.body.installed, read.headers['cache-control']]).toEqual([200, true, 'no-store']);
    // The import roster is not among the service token's reads (auth/serviceScope.ts).
    const roster = await service('/metals/sources/roster/preview');
    expect([roster.status, roster.body.code]).toEqual([403, 'principal-not-allowed']);
    const cards: Array<[string, string]> = [['/metals/card-check?asOf=4111111111111111', 'query.asOf'],
      ['/metals/card-check?4111111111111111=1', 'query.<key>'], ['/metals/sources/roster/preview?asOf=4111111111111111', 'query.<key>']];
    for (const [url, at] of cards) {
      const res = await get(url);
      expect([url, res.status, res.body.paths]).toEqual([url, 422, [at]]);
      expect(res.text).not.toContain('4111');
    }
    for (const url of ['/metals/card-check?asOf=2030-02-30', '/metals/card-check?asOf=SECRET', '/metals/card-check?asOf=2030-03-21',
      '/metals/card-check?metal=SECRET', '/metals/card-check?asOf=2030-03-01&asOf=2030-03-02', '/metals/sources/roster/preview?extra=SECRET']) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 400]);
      expect(res.text).not.toContain('SECRET');
      expect(res.text).not.toContain('2030-02-30');
    }
  });
});

describe('the coverage proof as this build serves it: the roster not installed, every gap named', () => {
  it('refuses every scope with a need, with roster and prefix, and the same proof for every metal and period (control 19)', async () => {
    await start();
    const accounts = seedBase();
    seedCard();
    const served = await proof();
    expect(served).toMatchObject({
      rule: 'metals-coverage-proof-v1', asOf: TODAY,
      roster: { state: 'not-installed', asking: false, decidedAt: null, acquisitionStart: null, problems: [], bindings: [] },
      totals: { realized: { metals: ['XAU'], state: 'incomplete' }, estimate: { metals: ['XAU'], state: 'incomplete' }, metalUnknown: { lots: 0, saleLines: 0 } },
      limits: LIMITS,
    });
    expect(served.snapshot).toMatch(/^[a-p]{64}$/);
    const ids = (gaps: MetalsCoverageProof['asOfScope']['gaps']) => gaps.map((gap) => gap.id);
    // Walmart's online window from 2029-01-01 can't show what came before; CollectPure's sell orders are whole history.
    expect([served.asOfScope.state, ids(served.asOfScope.gaps)]).toEqual(['incomplete', [`${accounts.walmart}|online`, 'prefix', 'roster']]);
    expect(served.asOfScope.gaps.find((gap) => gap.id === 'roster')).toEqual({ id: 'roster', variant: 'roster', state: 'not-installed', problems: [], rows: 0 });
    expect(served.sales.map((scope) => [scope.metal, scope.state, scope.need, ids(scope.gaps)])).toEqual([
      ['XAU', 'incomplete', { buy: { from: null, to: S1.date }, sell: { from: null, to: TODAY } }, [`${accounts.walmart}|online`, 'prefix', 'roster']],
    ]);
    // Period chips and the metal never narrow it.
    for (const query of ['metal=XAG', 'metal=XAU&from=2030-03-01&to=2030-03-10', 'metal=XAU&from=2030-01-01']) expect(await proof(query)).toEqual(served);
    // As of an earlier day it is that day's proof, on the same snapshot.
    const earlier = await proof(`metal=XAU&asOf=${S1.date}`);
    expect([earlier.asOf, earlier.snapshot, earlier.totals.realized]).toEqual([S1.date, served.snapshot, { metals: ['XAU'], state: 'incomplete' }]);
  });

  it('carries one snapshot across the overview, the card check and the preview, and a new one after any card write', async () => {
    await start();
    seedBase();
    const { account } = seedCard();
    const snapshots = async () => [(await proof()).snapshot, (await cardCheck()).snapshot, (await preview()).snapshot];
    const first = await snapshots();
    expect(new Set(first).size).toBe(1);
    addRows(account, [cardRow({ transactionDate: '2030-03-10', amountMinor: 480, description: 'SAMPLE COFFEE' })]);
    const next = await snapshots();
    expect(new Set(next).size).toBe(1);
    expect(next[0]).not.toBe(first[0]);
  });
});

describe('the card check: rows, statuses, credits and its own gap catalog', () => {
  it('explains a captured order\'s charge, lists the rest with their reasons, and counts what it doesn\'t read (controls 18 and 30)', async () => {
    await start();
    seedBase();
    const { account, w1 } = seedCard();
    const rows = seedDiagnostics(account);
    const check = await cardCheck();
    expect(check).toMatchObject({
      installed: true, rule: 'metals-card-capture-v1', aliasPolicy: 'metals-capture-alias-v1', asOf: TODAY,
      outOfScope: { warehouse: 1, samsClub: 0, store: 1, unclassed: 1 }, unchecked: [], cardHistory: [], limits: LIMITS,
    });
    const view = { id: account, name: 'Sample Visa', ending: '0001', issuer: 'samplebank', owner: 'alex' };
    expect(groupOf(check, 'walmart')).toMatchObject({
      label: 'Walmart', scope: 'mixed-online', source: 'walmart', exemption: null, credits: 0,
      purchases: { explained: 1, 'possible-aggregate': 0, held: 0, 'outside-coverage': 0, 'no-capture-match': 1 },
      rows: [{ rowId: rows.walmart, date: '2030-03-01', amountMinor: 430, account: view, status: 'no-capture-match', reasons: ['no-capture-match'],
        gapIds: ['unexplained|walmart'] }],
    });
    expect(groupOf(check, 'walmart')!.rows.map((row) => row.rowId)).not.toContain(w1);
    expect(groupOf(check, 'costco')).toMatchObject({
      label: 'Costco', scope: 'mixed-online', source: 'costco',
      rows: [{ rowId: rows.costco, status: 'outside-coverage', reasons: ['outside-coverage'], gapIds: ['missing-account|costco', 'unexplained|costco'] }],
    });
    expect(groupOf(check, 'unresolved:pm-technologies')).toMatchObject({
      label: 'pm-technologies', scope: 'gold-only', source: null,
      rows: [{ rowId: rows.processor, status: 'held', reasons: ['alias-unresolved'], gapIds: ['alias|pm-technologies'] }],
    });
    const dealer = merchantGroup(check);
    expect(dealer).toMatchObject({
      scope: 'gold-only', source: null, credits: 1,
      rows: [{ rowId: rows.dealer, status: 'outside-coverage', reasons: ['outside-coverage'], gapIds: [`dealer|${dealer.group}`] }],
      creditRows: [{ date: '2030-02-25', amountMinor: -410, account: view, status: 'listed', reason: 'no-refund-evidence-contract' }],
    });
    expect(dealer.label).toBe(dealer.group.slice('merchant:'.length));

    // The catalog: financial entries only (no answer, so nothing is before acquisitionStart or exempted), each naming
    // every proof scope that carries it, and every row's citation resolving there.
    const scoped = ['asOf', 'sales:XAU'];
    expect(check.gaps).toEqual([
      { id: 'alias|pm-technologies', kind: 'financial', scopes: scoped, reason: null },
      { id: `dealer|${dealer.group}`, kind: 'financial', scopes: scoped, reason: null },
      { id: 'missing-account|costco', kind: 'financial', scopes: scoped, reason: null },
      { id: 'unexplained|costco', kind: 'financial', scopes: scoped, reason: null },
      { id: 'unexplained|walmart', kind: 'financial', scopes: scoped, reason: null },
    ]);
    const served = await proof();
    const cited = check.groups.flatMap((group) => group.rows.flatMap((row) => row.gapIds));
    for (const entry of check.gaps) {
      for (const scope of entry.scopes) {
        const gaps = scope === 'asOf' ? served.asOfScope.gaps : served.sales.find((sales) => `sales:${sales.metal}` === scope)!.gaps;
        expect(gaps.map((gap) => gap.id), `${entry.id} in ${scope}`).toContain(entry.id);
      }
    }
    // Conservation (control 30): each card-row gap counts exactly the rows citing it, and every listed row cites one.
    for (const gap of served.asOfScope.gaps) {
      const counted = 'rows' in gap && gap.variant !== 'roster' ? gap.rows
        : 'triggers' in gap ? (gap.triggers.find((trigger) => trigger.by === 'card-rows') as { rows: number } | undefined)?.rows ?? 0 : 0;
      expect([gap.id, cited.filter((id) => id === gap.id).length]).toEqual([gap.id, counted]);
    }
    expect(check.groups.every((group) => group.rows.every((row) => row.gapIds.length > 0))).toBe(true);
    expect(JSON.stringify(check)).not.toContain('outside-financial-need');
  });

  it('holds a charge an ambiguous identity could be, and explains it again once a binding names the card (control 9)', async () => {
    await start();
    seedBase();
    const { account, w1 } = seedCard();
    const explained = (await cardCheck()).groups.find((group) => group.group === 'walmart')!.purchases.explained;
    expect(explained).toBe(1);
    // A second card ending 0001: the suffix no longer names one account.
    const other = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '0001', currency: 'USD' });
    let walmart = groupOf(await cardCheck(), 'walmart')!;
    expect(walmart.rows).toMatchObject([{ rowId: w1, status: 'held', reasons: ['identity-ambiguous'] }]);
    expect((await cardCheck()).unchecked).toEqual([{ source: 'walmart', cardNotInHoldr: 0, identityAmbiguous: 1 }]);
    // The owner's approved binding names it: resolved again.
    approve([{ kind: 'card', source: 'walmart', network: 'visa', last4: '0001', accountId: account }]);
    walmart = groupOf(await cardCheck(), 'walmart')!;
    expect([walmart.purchases.explained, walmart.rows]).toEqual([1, []]);
    expect(other.id).not.toBe(account);
  });

  it('reads a backfilled competing row and a removed row at once: a fresh graph, never a stale explanation (control 9)', async () => {
    await start();
    seedBase();
    const { account, w1 } = seedCard();
    const before = await cardCheck();
    addRows(account, [cardRow({ transactionDate: '2030-01-12', description: 'WALMART.COM SAMPLE SECOND' })]);
    const backfilled = await cardCheck();
    const second = repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((row) => row.transactionDate === '2030-01-12')!.id;
    expect(groupOf(backfilled, 'walmart')!.rows.map((row) => [row.rowId, row.status, row.reasons]).sort())
      .toEqual([[second, 'held', ['ambiguous']], [w1, 'held', ['ambiguous']]].sort());
    expect(backfilled.snapshot).not.toBe(before.snapshot);
    removeRow(second);
    const removed = await cardCheck();
    expect([groupOf(removed, 'walmart')!.purchases.explained, groupOf(removed, 'walmart')!.rows]).toEqual([1, []]);
    expect(statuses(removed)).toEqual(statuses(before));
  });

  it('reads a merge and a dismissal each on a fresh snapshot, and never a pending row (control 9)', async () => {
    await start();
    seedBase();
    const { account, w1 } = seedCard();
    const before = await cardCheck();
    // A competing row, then the owner merges it into W1's charge: the duplicate goes, and W1 is explained again.
    addRows(account, [cardRow({ transactionDate: '2030-01-12', description: 'WALMART.COM SAMPLE SECOND' })]);
    const second = repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((row) => row.transactionDate === '2030-01-12')!.id;
    const backfilled = await cardCheck();
    expect(groupOf(backfilled, 'walmart')!.purchases.held).toBe(2);
    repo.mergeCardTransactions({ survivorId: w1, loserId: second, reason: 'superseded', expectedRevisions: [1, 1], categoryFrom: 'survivor',
      notesFrom: 'survivor', actorRef: OWNER.actorRef });
    const merged = await cardCheck();
    expect([merged.snapshot === backfilled.snapshot, statuses(merged)]).toEqual([false, statuses(before)]);
    // A pending charge, then its dismissal: the check reads posted rows only, so neither moves a status.
    addRows(account, [cardRow({ transactionDate: '2030-03-12', amountMinor: 255, status: 'pending' })]);
    const pending = await cardCheck();
    const id = repo.listCardTransactionsMatching({ statuses: ['pending'] }).find((row) => row.amountMinor === 255)!.id;
    repo.removeCardTransaction({ id, reason: 'dismissed', expectedRevision: 1, actorRef: OWNER.actorRef });
    const dismissed = await cardCheck();
    expect(new Set([merged.snapshot, pending.snapshot, dismissed.snapshot]).size).toBe(3);
    expect([statuses(pending), statuses(dismissed)]).toEqual([statuses(before), statuses(before)]);
  });

  it('counts an open held record over its class at any amount, and takes a held-for-metals order by its admission (control 25)', async () => {
    await start();
    const accounts = seedBase();
    const { account } = seedCard();
    // An order the title guard holds for metals is an ordinary occurrence here: it explains its own charge.
    const held = walmartCoin('h1', '2030-02-10', 260, { flagged: true });
    importPayload(syntheticPayload('walmart', { orders: [held], coverage: [covered('online')] }), { accountId: accounts.walmart });
    addRows(account, [cardRow({ transactionDate: '2030-02-11', amountMinor: 260 })]);
    expect((await overview()).needsAnswer.orders).toBe(1);
    expect(groupOf(await cardCheck(), 'walmart')).toMatchObject({ purchases: { explained: 2 }, rows: [] });
    // An undated open held record bars every Walmart.com row, at any amount.
    importPayload(syntheticPayload('walmart', { held: [{ key: null, channel: 'online', date: null, reason: 'unreadable', check: 'detail-shape' }],
      coverage: [covered('online')] }), { accountId: accounts.walmart });
    const barred = groupOf(await cardCheck(), 'walmart')!;
    expect([barred.purchases.explained, barred.rows.map((row) => [row.amountMinor, row.status, row.reasons]).sort()])
      .toEqual([0, [[250, 'possible-aggregate', ['held-record']], [260, 'possible-aggregate', ['held-record']]]]);
  });

  it('leaves statuses and every binding digest as they were when a competitor is promoted to a metal order (control 25)', async () => {
    await start();
    const accounts = seedBase();
    const { account } = seedCard();
    seedDiagnostics(account);
    // A Walmart order captured only as a competitor (card funded), explaining its own charge.
    importPayload(syntheticPayload('walmart', { competitors: [syntheticCompetitor('walmart', 'online', 'p1', '2030-02-12', card('0001', 270))],
      coverage: [covered('online')] }), { accountId: accounts.walmart });
    addRows(account, [cardRow({ transactionDate: '2030-02-13', amountMinor: 270 })]);
    const competing = await cardCheck();
    const promotedKey = syntheticKey('walmart', 'order', 'p1');
    expect(groupOf(competing, 'walmart')!.purchases.explained).toBe(2);
    const digests = (await preview()).bindings;
    // The same order, now read as a metal order of the ledger.
    importPayload(syntheticPayload('walmart', { orders: [walmartCoin('p1', '2030-02-12', 270)], coverage: [covered('online')] }), { accountId: accounts.walmart });
    expect((await overview()).metals).toEqual([{ metal: 'XAU', lots: 2, sales: 1 }]);
    const promoted = await cardCheck();
    expect(promoted.snapshot).not.toBe(competing.snapshot);
    expect({ ...promoted, snapshot: null }).toEqual({ ...competing, snapshot: null });
    expect((await preview()).bindings).toEqual(digests);
    expect(promotedKey).toBe(walmartCoin('p1', '2030-02-12', 270).key);
  });
});

describe('the card check beside Shop Card and warehouse purchases: a matched inventory certifies nothing (controls 4 and 8)', () => {
  it('gives a Shop Card purchase no card subject, and explains a card-funded Shop Card load by its own order', async () => {
    await start();
    const accounts = seedBase();
    const { account } = seedCard();
    // A coin paid with a Shop Card alone: no card charge can be its. A row of its amount stays unexplained.
    const shopCard: MetalsAdmissionFacts = { fulfilment: { shipments: 1 }, methods: [{ kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 290 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 290 };
    importPayload(syntheticPayload('walmart', { orders: [walmartCoin('sc1', '2030-02-14', 290, { admission: shopCard })],
      // The card-funded Shop Card load, captured as a competitor: an ordinary order.
      competitors: [syntheticCompetitor('walmart', 'online', 'load1', '2030-02-01', card('0001', 300))], coverage: [covered('online')] }),
    { accountId: accounts.walmart });
    addRows(account, [cardRow({ transactionDate: '2030-02-02', amountMinor: 300 }), cardRow({ transactionDate: '2030-02-15', amountMinor: 290 })]);
    const walmart = groupOf(await cardCheck(), 'walmart')!;
    expect(walmart.purchases.explained).toBe(2);
    expect(walmart.rows.map((row) => [row.amountMinor, row.status])).toEqual([[290, 'no-capture-match']]);
    // The Shop Card coin is one purchase, at its full cost, with no card evidence: counted once, never a card subject.
    const purchases = ((await get('/metals/purchases?metal=XAU')).body as { purchases: Array<{ orderKey: string; costMinor: { value: number | null };
      cardEvidence: string; cards: unknown[] }> }).purchases.filter((entry) => entry.orderKey === syntheticKey('walmart', 'order', 'sc1'));
    expect(purchases.map((entry) => [entry.costMinor.value, entry.cardEvidence, entry.cards])).toEqual([[290, 'none', []]]);
  });

  it('keeps gate (b) incomplete beside a fully explained card inventory and a warehouse gap', async () => {
    await start();
    const accounts = seedBase();
    const { account } = seedCard();
    const costco = importPayload(syntheticPayload('costco', { orders: [costcoBar('k1', '2030-02-05', 280)],
      coverage: [covered('online'), covered('warehouse', TODAY, false)] }), { label: 'Costco membership' });
    const costcoCard = repo.createCardAccount({ issuer: 'thirdbank', owner: 'joint', last4: '0003', currency: 'USD' });
    addRows(costcoCard.id, [cardRow({ transactionDate: '2030-02-06', amountMinor: 280, description: 'COSTCO.COM SAMPLE' })], { start: '2030-01-01', end: TODAY });
    const check = await cardCheck();
    expect(check.groups.map((group) => [group.group, group.purchases.explained, group.rows.length])).toEqual([['costco', 1, 0], ['walmart', 1, 0]]);
    expect(check.gaps).toEqual([]);
    const served = await proof();
    expect(served.asOfScope.state).toBe('incomplete');
    expect(served.asOfScope.gaps.map((gap) => gap.id)).toEqual(expect.arrayContaining([`${costco}|warehouse`, `${accounts.walmart}|online`, 'prefix', 'roster']));
    expect(served.totals.estimate.state).toBe('incomplete');
    expect(account).not.toBe(costcoCard.id);
  });
});

describe('the roster preview: bindings and their digests (controls 13 and 32)', () => {
  const bindingOf = (view: MetalsRosterPreview, key: string) => view.bindings.find((binding) => binding.key === key);

  it('lists the imported accounts per source and every binding with evidence, digested by the server', async () => {
    await start();
    const accounts = seedBase();
    const { account } = seedCard();
    expect(await preview()).toMatchObject({
      installed: true, bindings: [],
      importedAccounts: [
        { source: 'costco', accounts: [] },
        { source: 'walmart', accounts: [{ accountId: accounts.walmart, label: 'Walmart account', retired: false }] },
        { source: 'collectpure', accounts: [{ accountId: accounts.collectpure, label: 'CollectPure account', retired: false }] },
      ],
    });
    seedDiagnostics(account);
    const view = await preview();
    const dealer = merchantGroup(await cardCheck()).group;
    expect(view.bindings.map((binding) => [binding.key, binding.rows, binding.statuses])).toEqual([
      [`group:${dealer}`, 1, { 'possible-aggregate': 0, held: 0, 'outside-coverage': 1, 'no-capture-match': 0 }],
      ['group:unresolved:pm-technologies', 1, { 'possible-aggregate': 0, held: 1, 'outside-coverage': 0, 'no-capture-match': 0 }],
      ['source:costco', 1, { 'possible-aggregate': 0, held: 0, 'outside-coverage': 1, 'no-capture-match': 0 }],
      ['source:walmart', 1, { 'possible-aggregate': 0, held: 0, 'outside-coverage': 0, 'no-capture-match': 1 }],
    ]);
    for (const binding of view.bindings) expect(binding.digest).toMatch(/^lh1:[a-p]{64}$/);
    expect(view.digest).toMatch(/^lh1:[a-p]{64}$/);
    expect(new Set([...view.bindings.map((binding) => binding.digest), view.digest]).size).toBe(5);
  });

  it('changes a binding\'s digest on a same-count replacement, and reads it current again when the evidence returns', async () => {
    await start();
    seedBase();
    const { account } = seedCard();
    const rows = seedDiagnostics(account);
    const first = await preview();
    const key = first.bindings[0].key;
    // The same count, another row: the binding and the preview are stale (control 13, read side).
    removeRow(rows.dealer);
    addRows(account, [cardRow({ transactionDate: '2030-02-22', amountMinor: 415, description: 'SAMPLE BULLION CO' })]);
    const replaced = await preview();
    expect([bindingOf(replaced, key)!.rows, bindingOf(replaced, key)!.digest === bindingOf(first, key)!.digest, replaced.digest === first.digest])
      .toEqual([1, false, false]);
    // A row added, then removed: the evidence is what it was, and so is the digest (control 32: current again).
    const middle = (await preview()).digest;
    addRows(account, [cardRow({ transactionDate: '2030-02-23', amountMinor: 416, description: 'SAMPLE BULLION CO' })]);
    expect((await preview()).digest).not.toBe(middle);
    removeRow(rowId(account, 416));
    expect((await preview()).digest).toBe(middle);
  });

  it('never lets a warehouse or store row, a credit, or a coverage extension move a digest (control 32)', async () => {
    await start();
    const accounts = seedBase('2030-02-15');
    const { account } = seedCard();
    seedDiagnostics(account);
    const first = await preview();
    const walmartRow = groupOf(await cardCheck(), 'walmart')!.rows.find((row) => row.amountMinor === 430)!;
    expect(walmartRow.status).toBe('outside-coverage');
    addRows(account, [
      cardRow({ transactionDate: '2030-03-06', amountMinor: 451, description: 'COSTCO WHSE SAMPLETOWN WA' }),
      cardRow({ transactionDate: '2030-03-07', amountMinor: 461, merchant: 'WALMART.COM', description: 'WALMART SAMPLETOWN WA' }),
      cardRow({ transactionDate: '2030-03-08', amountMinor: -430, kind: 'refund', description: 'WALMART.COM SAMPLE REFUND' }),
    ]);
    expect((await preview()).digest).toBe(first.digest);
    // Walmart's coverage now reaches the row: its label moves to no-capture-match, and no digest moves.
    importPayload(syntheticPayload('walmart', { coverage: [covered('online')] }), { accountId: accounts.walmart });
    expect(groupOf(await cardCheck(), 'walmart')!.rows.find((row) => row.amountMinor === 430)!.status).toBe('no-capture-match');
    const extended = await preview();
    expect(extended.bindings.map((binding) => [binding.key, binding.digest])).toEqual(first.bindings.map((binding) => [binding.key, binding.digest]));
    expect(extended.digest).toBe(first.digest);
    expect(bindingOf(extended, 'source:walmart')!.statuses).toEqual({ 'possible-aggregate': 0, held: 0, 'outside-coverage': 0, 'no-capture-match': 1 });
  });
});

describe('card history Holdr hasn\'t synced: a limit, never a gap (control 31)', () => {
  it('names each held card account\'s unsynced days from the earliest record while acquisitionStart is unknown, and changes no verdict', async () => {
    await start();
    seedBase();
    const partial = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '0001', currency: 'USD' });
    addRows(partial.id, [cardRow({})], { start: '2030-01-01', end: '2030-02-28' });
    const none = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '0002', currency: 'USD' });
    const check = await cardCheck();
    const ordered = [
      { account: { id: partial.id, name: 'samplebank', ending: '0001', issuer: 'samplebank', owner: 'alex' }, unsynced: [{ from: '2030-03-01', to: TODAY }] },
      { account: { id: none.id, name: 'otherbank', ending: '0002', issuer: 'otherbank', owner: 'casey' }, unsynced: [{ from: W1.date, to: TODAY }] },
    ].sort((a, b) => (a.account.id < b.account.id ? -1 : 1));
    expect(check.cardHistory).toEqual(ordered);
    expect(check.limits).toEqual([...LIMITS, 'card-history']);
    const limited = await proof();
    expect(limited.limits).toEqual([...LIMITS, 'card-history']);
    // Both synced through today: the limit goes, and nothing else of the proof moves.
    addRows(partial.id, [cardRow({ transactionDate: '2030-03-02', amountMinor: 251, description: 'SAMPLE COFFEE' })], { start: '2030-03-01', end: TODAY });
    addRows(none.id, [cardRow({ transactionDate: '2030-03-02', amountMinor: 252, description: 'SAMPLE COFFEE' })], { start: '2030-01-01', end: TODAY });
    const synced = await proof();
    expect((await cardCheck()).cardHistory).toEqual([]);
    expect(synced.limits).toEqual(LIMITS);
    expect({ ...synced, snapshot: null, limits: null }).toEqual({ ...limited, snapshot: null, limits: null });
  });
});

describe('the card check never changes a financial output (controls 1, 9 and 10)', () => {
  /**
   * The financial outputs (design v3.2 §9), as served: Everyday's classifications and signed period totals, the forecast
   * and the cash plan, and the existing asset-proof outputs, the link proofs (each lot's card links in purchases;
   * funding by kind, receipt-confirmed charges and payouts' deposit links in funding), with the sales, the timeline and
   * the overview but its proof (a diagnostic).
   */
  const FINANCIAL = ['/card-transactions?limit=200', '/spending/summary?from=2030-01-01&to=2030-03-20',
    '/spending/accounting?from=2030-01-01&to=2030-03-20', `/spending/forecast?today=${TODAY}`, '/cash/payments',
    '/metals/purchases?metal=XAU', '/metals/funding', '/metals/sales?metal=XAU', '/metals/timeline?metal=XAU', '/metals/overview?metal=XAU'];
  /** Each financial output as text; every one answers, since two equal refusals would prove nothing. */
  const financial = async () => {
    const answers = await Promise.all(FINANCIAL.map(async (url) => {
      const res = await get(url);
      const text = url.startsWith('/metals/overview') ? JSON.stringify(withoutProof(res.body as MetalsOverview)) : res.text;
      return [url, res.status, text] as const;
    }));
    expect(answers.map(([url, status]) => [url, status])).toEqual(FINANCIAL.map((url) => [url, 200]));
    return answers;
  };

  it('leaves Spending\'s owner rule, its paired refund and every row\'s classification as they are, whatever the check reads (control 1)', async () => {
    await start();
    seedBase();
    const { account } = seedCard();
    installCardSpendingRulesSchema(db());
    installCashPlanSchema(db());
    repo.createCardSpendingRule({ merchantClass: 'bullion-dealer', currency: 'USD', minAmountMinor: 100 }, OWNER);
    seedDiagnostics(account);
    const before = await financial();
    // The check recognizes a processor no shared recognizer knows: a diagnostic only.
    expect(groupOf(await cardCheck(), 'unresolved:pm-technologies')!.rows).toHaveLength(1);
    await preview();
    await overview();
    expect(await financial()).toEqual(before);
  });

  it('answers unavailable, never zero rows, when the capture fails; the overview\'s proof says so and the rest answers as before (control 9)', async () => {
    await start();
    seedBase();
    const { account } = seedCard();
    installCashPlanSchema(db());
    seedDiagnostics(account);
    const succeeded = await overview();
    fail.capture = true;
    // A write first: the snapshot read before the failure is never served again.
    addRows(account, [cardRow({ transactionDate: '2030-03-09', amountMinor: 490, description: 'SAMPLE COFFEE' })]);
    const before = await financial();
    for (const url of ['/metals/card-check', '/metals/sources/roster/preview']) {
      const res = await get(url);
      expect([url, res.status, res.body]).toEqual([url, 503, UNAVAILABLE]);
    }
    const failed = await overview();
    const unavailable = { state: 'unavailable', need: null, gaps: [{ id: 'card-check', variant: 'card-check-unavailable' }] };
    expect(failed.coverageProof).toMatchObject({
      asOfScope: unavailable, sales: [{ metal: 'XAU', ...unavailable }],
      totals: { realized: { metals: ['XAU'], state: 'unavailable' }, estimate: { metals: ['XAU'], state: 'unavailable' } },
    });
    expect(withoutProof(failed)).toEqual(withoutProof(succeeded));
    expect(await financial()).toEqual(before);
    // Once per snapshot, by its type only.
    await cardCheck();
    expect(logs.filter((line) => line.startsWith('[metals]'))).toEqual(['[metals] card check unavailable: capture RangeError']);
    // The capture back, on a new snapshot: the same overview, now with its proof.
    fail.capture = false;
    repo.updateCardAccount(account, { nickname: 'Sample Visa Two' });
    const recovered = await overview();
    expect(withoutProof(recovered)).toEqual(withoutProof(failed));
    expect(recovered.coverageProof.asOfScope.state).toBe('incomplete');
  });

  it('serves the overview\'s proof unavailable when only the proof fails, and the fixed 503 when even that does', async () => {
    await start();
    seedBase();
    const { account } = seedCard();
    fail.proof = 'with-capture';
    const fallback = await overview();
    expect(fallback.coverageProof.asOfScope).toEqual({ state: 'unavailable', need: null, gaps: [{ id: 'card-check', variant: 'card-check-unavailable' }] });
    const res = await get('/metals/card-check');
    expect([res.status, res.body]).toEqual([503, UNAVAILABLE]);
    expect(logs.filter((line) => line.startsWith('[metals]'))).toEqual(['[metals] card check unavailable: proof TypeError']);
    fail.proof = 'always';
    addRows(account, [cardRow({ transactionDate: '2030-03-09', amountMinor: 490, description: 'SAMPLE COFFEE' })]);
    const refused = await get('/metals/overview?metal=XAU');
    expect([refused.status, refused.body]).toEqual([503, UNAVAILABLE]);
    expect(logs.filter((line) => line.startsWith('[metals]'))).toEqual(['[metals] card check unavailable: proof TypeError',
      '[metals] card check unavailable: proof TypeError', '[metals] card check unavailable: unavailable proof TypeError']);
  });

  it('answers unavailable when the check\'s own reads fail, while every other metals read serves as before', async () => {
    await start();
    seedBase();
    seedCard();
    const purchases = (await get('/metals/purchases?metal=XAU')).text;
    vi.spyOn(repo, 'listCardCoverage').mockImplementation(() => {
      throw new Error('synthetic failure that names SAMPLE BULLION CO');
    });
    repo.updateCardAccount(repo.listCardAccounts()[0].id, { nickname: 'Sample Visa Two' });
    const res = await get('/metals/card-check');
    expect([res.status, res.body]).toEqual([503, UNAVAILABLE]);
    expect(res.text).not.toContain('SAMPLE');
    expect((await overview()).coverageProof.totals.estimate.state).toBe('unavailable');
    expect((await get('/metals/purchases?metal=XAU')).text).toBe(purchases);
    expect(logs.filter((line) => line.startsWith('[metals]'))).toEqual(['[metals] card check unavailable: reads HoldrDbError UNKNOWN']);
  });
});
