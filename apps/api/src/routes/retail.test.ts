import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type Database from 'better-sqlite3';
import {
  ITEM_TAXONOMY_ASSET_NODE,
  ITEM_TAXONOMY_MIN_AGENT_BP,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
  ITEM_TAXONOMY_V2_VIEW,
} from '@finance-tracker/shared';
import {
  RETAIL_API_CATEGORY_LINE_KINDS,
  RETAIL_API_CATEGORY_SOURCES,
  RETAIL_API_CHANNELS,
  RETAIL_API_FORMATS,
  RETAIL_API_KEYS,
  RETAIL_API_LINE_EVENT_KINDS,
  RETAIL_API_QUARANTINE_REASONS,
  RETAIL_API_REFUSALS,
  RETAIL_API_VERSIONS,
  type RetailApiKeyList,
  type RetailApiLineCategory,
} from '@finance-tracker/shared/retail-api';
import { RETAIL_METAL_GUARD, RETAIL_METAL_TITLE_RULE, type RetailImportPayload } from '@finance-tracker/shared/retail-import-payload';

import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import {
  RETAIL_LINE_TAXONOMY_SOURCES,
  RETAIL_TAXONOMY_LINE_KINDS,
  RETAIL_TAXONOMY_MAPPING_FORMAT,
  importRetailTaxonomy,
  installRetailSchema,
  planRetailTaxonomyImport,
  retailDepartmentKey,
  retailProductKey,
  retailSchemaState,
  retailTaxonomyMappingOf,
  serializeRetailTaxonomyMapping,
  type RetailTaxonomyEntry,
} from '../services/retail/index.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { NO_RESERVED, RETAIL_RESERVED_FIXTURES, RETAIL_TEST_GO, RETAIL_TEST_NOW, declaration, importPayload, reservedValuesStored,
  retailReservedBase } from '../testing/retailDb.js';
import {
  SYNTHETIC_RETAIL,
  couponLine,
  gasKey,
  gasReceipt,
  goldBar,
  heldRecord,
  onlineLine,
  onlineOrder,
  orderKey,
  shipment,
  syntheticRetailPayload,
  uncertainGold,
  warehouseKey,
  warehouseLine,
  warehouseReceipt,
  warehouseRefund,
} from '../testing/retailPayloads.js';
import { tablesAndCounts } from '../testing/sqliteContents.js';
import { CARD_DATA_MESSAGE } from './cardSpending.js';
import { createRetailRouter } from './retail.js';

// The Costco receipts page's read API (`@finance-tracker/shared/retail-api`: the summary and the list v1, the detail v2)
// through the real app and its guarded mount, over receipts PR 2's own importer stored and taxonomy rows the retail
// taxonomy's own import stored. Synthetic data only: made-up keys, titles, amounts and card endings.

const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '5e'.repeat(32);
const FAST = { ln: 10, r: 8, p: 1 };
const SUMMARY = '/retail/costco/summary';
const RECEIPTS = '/retail/costco/receipts';
const UNKNOWN_REF = `rcp-${'a'.repeat(32)}`;
const NOT_FOUND = { error: 'retail receipt not found', reason: 'receipt-not-found' };
const MEMBERSHIP_NOT_FOUND = { error: 'retail membership not found', reason: 'membership-not-found' };
const UNKNOWN_MEMBERSHIP = `rtl-mbr-${'p'.repeat(32)}`;
/** A 400 `query-invalid` with its fixed message (PR 5 v3 §3.7). */
const invalid = (error: string) => ({ error, reason: 'query-invalid' });
const UNKNOWN_CATEGORY = { error: 'unknown category', reason: 'category-unknown' };
const CHANNEL_LIST = 'channel must be a comma-separated list of warehouse, gas, online';
const CONFLICT_MESSAGES = {
  'schema-conflict': 'the retail tables on this Holdr have another shape; nothing was read',
  'retail-reserved-value': 'the retail tables on this Holdr hold a value reserved for a later rule; nothing was read',
};
const KEYLESS = heldRecord({ naturalKey: null, check: 'record-key', reason: 'unreadable', date: null });

/** The API's repository, whose handle a test can watch, or forbid, once the app and the owner's session exist. */
class ProbeRepo extends SqliteStateRepo {
  probe: ((db: Database.Database) => Database.Database) | undefined;

  override internalGetDb(): Database.Database {
    const db = super.internalGetDb();
    return this.probe ? this.probe(db) : db;
  }
}

interface World {
  repo: ProbeRepo;
  /** The database itself, never watched. */
  db: Database.Database;
  client: ReturnType<typeof request>;
  cookie: string;
  logs: string[];
}

const opened: ProbeRepo[] = [];
afterEach(() => {
  for (const repo of opened.splice(0)) repo.close();
});

async function world(): Promise<World> {
  const repo = new ProbeRepo({ file: ':memory:' });
  opened.push(repo);
  const logs: string[] = [];
  const built = createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST,
    log: (line) => logs.push(line) });
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const client = request(await listenLoopback(built.app));
  const login = await client.post('/auth/login').set('Origin', ORIGIN).set('X-Holdr-Request', '1')
    .send({ username: 'alex', password: 'synthetic password' });
  expect(login.status).toBe(200);
  const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('holdr_session='))!.split(';')[0];
  return { repo, db: repo.internalGetDb(), client, cookie, logs };
}

const get = (w: World, url: string) => w.client.get(url).set('Cookie', w.cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
const install = (db: Database.Database) => installRetailSchema(db, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO });
const receiptRef = (db: Database.Database, naturalKey: string) =>
  db.prepare('SELECT receipt_ref FROM retail_receipts WHERE natural_key = ?').pluck().get(naturalKey) as string;
const membershipRef = (db: Database.Database, folder: string) =>
  db.prepare('SELECT membership_ref FROM retail_memberships WHERE folder = ?').pluck().get(folder) as string;
const withCoverage = (payload: RetailImportPayload, coverage: RetailImportPayload['coverage']): RetailImportPayload => ({ ...payload, coverage });

// ---------------------------------------------------------------------------------------------------------------------
// Each body's keys, recursively, against the contract's pinned lists (in order).
// ---------------------------------------------------------------------------------------------------------------------

type Body = Record<string, unknown>;
const object = (value: unknown) => value as Body;
const list = (value: unknown) => value as unknown[];

function keysAre(value: unknown, keys: RetailApiKeyList, at: string): Body {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), at).toBe(true);
  expect(Object.keys(value as Body), at).toEqual([...RETAIL_API_KEYS[keys]]);
  return value as Body;
}

function channelCountsAre(value: unknown, at: string): void {
  expect(Object.keys(object(value)), at).toEqual([...RETAIL_API_CHANNELS]);
  for (const channel of RETAIL_API_CHANNELS) keysAre(object(value)[channel], 'channelCounts', `${at}.${channel}`);
}

function summaryKeys(body: unknown): void {
  const summary = keysAre(body, 'summary', '$');
  expect(summary.version, '$.version').toBe(RETAIL_API_VERSIONS.summary);
  list(summary.memberships).forEach((entry, index) => {
    const membership = keysAre(entry, 'summaryMembership', `$.memberships[${index}]`);
    channelCountsAre(membership.receipts, `$.memberships[${index}].receipts`);
    const capture = keysAre(membership.capture, 'capture', `$.memberships[${index}].capture`);
    list(capture.ranges).forEach((range, at) => keysAre(range, 'captureRange', `$.memberships[${index}].capture.ranges[${at}]`));
  });
  channelCountsAre(summary.receipts, '$.receipts');
  expect(Object.keys(object(summary.quarantine))).toEqual([...RETAIL_API_QUARANTINE_REASONS]);
}

function receiptsKeys(body: unknown): void {
  const page = keysAre(body, 'receipts', '$');
  expect(page.version, '$.version').toBe(RETAIL_API_VERSIONS.receipts);
  list(page.receipts).forEach((entry, index) => {
    const row = keysAre(entry, 'receiptRow', `$.receipts[${index}]`);
    keysAre(row.tenders, 'rowTenders', `$.receipts[${index}].tenders`);
    if (row.matchingLines !== null) {
      list(row.matchingLines).forEach((line, at) => keysAre(line, 'matchingLine', `$.receipts[${index}].matchingLines[${at}]`));
    }
  });
}

function receiptKeys(body: unknown): void {
  const answer = keysAre(body, 'receipt', '$');
  expect(answer.version, '$.version').toBe(RETAIL_API_VERSIONS.receipt);
  const receipt = keysAre(answer.receipt, 'receiptDetail', '$.receipt');
  keysAre(receipt.totals, 'totals', '$.receipt.totals');
  list(receipt.taxLegends).forEach((legend, index) => keysAre(legend, 'taxLegend', `$.receipt.taxLegends[${index}]`));
  list(receipt.lines).forEach((entry, index) => {
    const at = `$.receipt.lines[${index}]`;
    const line = keysAre(entry, 'line', at);
    if (line.fuel !== null) keysAre(line.fuel, 'fuel', `${at}.fuel`);
    if (line.metal !== null) {
      const metal = keysAre(line.metal, 'metal', `${at}.metal`);
      if (metal.statedWeight !== null) keysAre(metal.statedWeight, 'statedWeight', `${at}.metal.statedWeight`);
    }
    if (line.metalUncertain !== null) keysAre(line.metalUncertain, 'metalUncertain', `${at}.metalUncertain`);
    if (line.events !== null) {
      const events = keysAre(line.events, 'events', `${at}.events`);
      for (const kind of RETAIL_API_LINE_EVENT_KINDS) list(events[kind]).forEach((event, n) => keysAre(event, 'event', `${at}.events.${kind}[${n}]`));
    }
    list(line.shipments).forEach((entry2, n) => keysAre(entry2, 'shipment', `${at}.shipments[${n}]`));
    // An item, fee or fuel line carries its category; a coupon's is null.
    expect(line.category !== null, `${at}.category`).toBe((RETAIL_API_CATEGORY_LINE_KINDS as readonly unknown[]).includes(line.kind));
    if (line.category !== null) {
      const category = keysAre(line.category, 'lineCategory', `${at}.category`);
      if (category.suggestion !== null) keysAre(category.suggestion, 'lineCategorySuggestion', `${at}.category.suggestion`);
    }
  });
  list(receipt.tenders).forEach((tender, index) => keysAre(tender, 'tender', `$.receipt.tenders[${index}]`));
}

/** Every key anywhere in a body. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The synthetic world: every kind of receipt the page shows, imported by PR 2's importer for two memberships.
// ---------------------------------------------------------------------------------------------------------------------

const DEBIT = { kind: 'debit' as const, network: 'unknown' as const, last4: null, amountMinor: 1_080 };
/** A warehouse receipt with a coupon under its item, instant savings, a metal line, a flagged line, two tenders. */
const W1 = warehouseReceipt(1, {
  date: '2031-01-10', instantSavingsMinor: 200, taxLegends: [{ legend: 'A', amountMinor: 80 }],
  lines: [
    warehouseLine(0, 1_000),
    couponLine(1, 0, -200),
    warehouseLine(2, 250_000, { title: SYNTHETIC_RETAIL.bar, title2: 'SAMPLE ONE OUNCE', metal: goldBar() }),
    warehouseLine(3, 1_500, { title: SYNTHETIC_RETAIL.gadget, title2: '[redacted]', metalUncertain: uncertainGold() }),
  ],
  tenders: [
    { kind: 'card', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: 251_880 },
    { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 500 },
  ],
});
const W2 = warehouseReceipt(2, { date: '2031-01-20', tenders: [DEBIT] });
const G1 = gasReceipt(3, { date: '2031-01-15', tenders: [{ kind: 'card', network: 'mastercard', last4: SYNTHETIC_RETAIL.card2, amountMinor: 4_270 }] });
const O1 = onlineOrder(4, {
  date: '2031-01-11', status: 'delivered', shopCards: [1_000],
  lines: [
    onlineLine(4, 0, 5_000, {
      events: { shipped: [{ quantity: 1, date: '2031-01-12' }], delivered: [{ quantity: 1, date: '2031-01-14' }], cancelled: [], returned: [] },
      shipments: [shipment({ deliveredDate: '2031-01-14' })],
    }),
    onlineLine(4, 1, 300, { kind: 'fee', itemNumber: null, title: 'SAMPLE FEE', feeParent: 0, fulfilment: 'unknown',
      events: { shipped: [], delivered: [], cancelled: [], returned: [] }, shipments: [] }),
  ],
});
const R1 = warehouseRefund(5, { date: '2031-01-25' });
const S1 = warehouseReceipt(6, { date: '2031-01-10' });
const Q1 = warehouseReceipt(7, { date: '2031-01-03' });
const O2 = onlineOrder(8, { date: '2031-01-18' });

interface Refs {
  A: string;
  B: string;
  W1: string;
  W2: string;
  G1: string;
  O1: string;
  R1: string;
  S1: string;
  Q1: string;
  O2: string;
}
const RECEIPT_NAMES = ['W1', 'W2', 'G1', 'O1', 'R1', 'S1', 'Q1', 'O2'] as const;

/**
 * Membership A (`costco`) imports W1, W2, G1, O1, R1, S1 and Q1 and holds key 90; B (`costco-2`) shares S1, sights W2
 * with another date (quarantined, duplicate across memberships), adds O2, holds key 90 again and a record without a key;
 * A's third import, of an older capture with coverage before and inside its first, re-reads Q1 with another date
 * (quarantined, receipt changed) and holds key 91 and two records without a key.
 */
function importWorld(db: Database.Database): Refs {
  install(db);
  importPayload(db, syntheticRetailPayload({ capture: 'b', receipts: [W1, W2, G1, O1, R1, S1, Q1], held: [heldRecord({ naturalKey: warehouseKey(90) })] }));
  importPayload(db, syntheticRetailPayload({
    folder: 'costco-2', capture: 'c', capturedAt: '2031-02-10T08:00:00Z',
    receipts: [S1, warehouseReceipt(2, { date: '2031-01-21', tenders: [DEBIT] }), O2], held: [heldRecord({ naturalKey: warehouseKey(90) }), KEYLESS],
  }), { declaration: declaration('costco-2', 'casey', 'Sample Partner') });
  importPayload(db, withCoverage(syntheticRetailPayload({
    capture: 'd', capturedAt: '2031-01-05T00:00:00Z', receipts: [warehouseReceipt(7, { date: '2031-01-04' })],
    held: [heldRecord({ naturalKey: warehouseKey(91) }), KEYLESS, KEYLESS],
  }), {
    online: [{ from: '2030-11-01', to: '2030-11-15', stated: null, seen: 0 }],
    warehouse: [{ from: '2030-12-01', to: '2030-12-31', stated: null, seen: 0 }, { from: '2031-01-02', to: '2031-01-04', stated: null, seen: 1 }],
  }));
  return {
    A: membershipRef(db, 'costco'), B: membershipRef(db, 'costco-2'),
    W1: receiptRef(db, warehouseKey(1)), W2: receiptRef(db, warehouseKey(2)), G1: receiptRef(db, gasKey(3)), O1: receiptRef(db, orderKey(4)),
    R1: receiptRef(db, warehouseKey(5)), S1: receiptRef(db, warehouseKey(6)), Q1: receiptRef(db, warehouseKey(7)), O2: receiptRef(db, orderKey(8)),
  };
}

/** Every receipt, date descending then ref. */
const newestFirst = (refs: Refs) => [refs.R1, refs.W2, refs.O2, refs.G1, refs.O1, ...[refs.W1, refs.S1].sort(), refs.Q1];

const ALL_ROUTES = (ref: string) => [SUMMARY, RECEIPTS, `${RECEIPTS}/${ref}`];

// ---------------------------------------------------------------------------------------------------------------------
// Line categories: taxonomy rows through the retail taxonomy's own planned import, and the resolver's F as the detail shows it.
// ---------------------------------------------------------------------------------------------------------------------

/** The merchant every synthetic receipt stores (`retail_receipts.merchant`), whose subject keys the mappings name. */
const MERCHANT = 'costco';
const MIN_BP = ITEM_TAXONOMY_MIN_AGENT_BP;
const SUGGESTED_BELOW_BP = ITEM_TAXONOMY_SUGGESTED_BELOW_BP;
const owner = (itemNumber: string, node: string): RetailTaxonomyEntry =>
  ({ subjectKind: 'product', subjectKey: retailProductKey(MERCHANT, itemNumber), source: 'owner', node, confidenceBp: null }) as RetailTaxonomyEntry;
const agent = (itemNumber: string, node: string, confidenceBp: number): RetailTaxonomyEntry =>
  ({ subjectKind: 'product', subjectKey: retailProductKey(MERCHANT, itemNumber), source: 'agent', node, confidenceBp }) as RetailTaxonomyEntry;
const reviewed = (department: number, node: string): RetailTaxonomyEntry => ({ subjectKind: 'department',
  subjectKey: retailDepartmentKey(MERCHANT, department), source: 'department-review', node, confidenceBp: null }) as RetailTaxonomyEntry;

let decisions = 0;
/**
 * Imports one reviewed mapping as `holdr-retail taxonomy import` does (planned, then imported under a GO), each under a
 * fresh decision: a later mapping's rows supersede an earlier one's (a higher sequence).
 */
function importTaxonomy(db: Database.Database, entries: RetailTaxonomyEntry[]): void {
  const order = (entry: RetailTaxonomyEntry) => `${entry.subjectKind}\u0000${entry.subjectKey}\u0000${entry.source}`;
  const mapping = retailTaxonomyMappingOf({ format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 2, reviewed: true,
    decisionId: (++decisions).toString(16).padStart(32, '0'), entries: [...entries].sort((a, b) => (order(a) < order(b) ? -1 : 1)) });
  const mappingSha256 = createHash('sha256').update(serializeRetailTaxonomyMapping(mapping)).digest('hex');
  const imported = importRetailTaxonomy(db, mapping, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, mappingSha256,
    planDigest: planRetailTaxonomyImport(db, mapping, mappingSha256).planDigest });
  expect(imported.code).toBe('retail-taxonomy-imported');
}

/** A line's expected category: the resolver's F (Needs review's by default) with its node's card category in the v2 tree. */
const category = (node: string, patch: Partial<RetailApiLineCategory> = {}) => ({
  node, cardCategory: ITEM_TAXONOMY_V2_VIEW.node(node)!.cardCategory, source: null, confidenceBp: null, suggested: false, suggestion: null,
  metalHold: false, ...patch,
});
/** No row and no title rule: Needs review, from nothing. */
const NEEDS_REVIEW = category(ITEM_TAXONOMY_RESIDUAL);
/** The title rule's match: precious metals, held, whatever any row says. */
const TITLE_RULE_GOLD = category(ITEM_TAXONOMY_ASSET_NODE, { source: 'title-rule', metalHold: true });

/** Whether a line's category files it under a node: the node itself or, for a top level, one of its subcategories. */
const filedUnder = (line: RetailApiLineCategory | null, node: string) => line !== null
  && (line.node === node || (ITEM_TAXONOMY_V2_VIEW.isTop(node) && ITEM_TAXONOMY_V2_VIEW.top(line.node) === node));

interface CategoryRefs {
  A: string;
  B: string;
  K1: string;
  K2: string;
  K3: string;
  K4: string;
  K5: string;
  K6: string;
}

/** K2's lines; read again with a line more (product 100130, department 15) in a version that never becomes canonical. */
const K2_LINES = [
  warehouseLine(0, 1_000, { itemNumber: '100110' }), warehouseLine(1, 1_000, { itemNumber: '100111' }),
  warehouseLine(2, 1_000, { itemNumber: '100112' }),
];

/**
 * Receipts whose lines each resolve their own way, every product its own. Membership A: K1 (a product the owner filed,
 * over an agent; a coupon; a title-rule gold bar the owner filed elsewhere; a line without an item number in reviewed
 * department 14), K2 (agents at the minimum, at the suggested bound and below the minimum; read again with a line more,
 * quarantined), K3 (the owner's explicit Needs review over an agent; an agent's precious metals, which a later mapping
 * moves), K4 (gas: a fuel line the owner filed) and K6 (an item, and a coupon in reviewed department 15). Membership B: K5
 * (online: an item no row names, and a fee the owner filed). Department 12 has no row. Newest first: K5, K4, K3, K2, K1, K6.
 */
function categoryWorld(db: Database.Database): CategoryRefs {
  install(db);
  importPayload(db, syntheticRetailPayload({ capture: 'b', receipts: [
    warehouseReceipt(21, { date: '2031-01-21', lines: [
      warehouseLine(0, 1_000, { itemNumber: '100100' }),
      couponLine(1, 0, -100),
      warehouseLine(2, 2_000, { itemNumber: '100102', title: SYNTHETIC_RETAIL.bar, metal: goldBar() }),
      warehouseLine(3, 500, { itemNumber: null, department: 14 }),
    ] }),
    warehouseReceipt(22, { date: '2031-01-22', lines: K2_LINES }),
    warehouseReceipt(23, { date: '2031-01-23', lines: [
      warehouseLine(0, 1_000, { itemNumber: '100120' }),
      warehouseLine(1, 1_000, { itemNumber: '100121', title: SYNTHETIC_RETAIL.gadget }),
    ] }),
    gasReceipt(24, { date: '2031-01-24' }),
    warehouseReceipt(26, { date: '2031-01-20', lines: [warehouseLine(0, 3_000, { itemNumber: '100160' }), couponLine(1, 0, -300, { department: 15 })] }),
  ] }));
  importPayload(db, syntheticRetailPayload({ folder: 'costco-2', capture: 'c', receipts: [onlineOrder(25, { date: '2031-01-25', lines: [
    onlineLine(25, 0, 5_000),
    onlineLine(25, 1, 300, { kind: 'fee', itemNumber: '200299', title: 'SAMPLE FEE', feeParent: 0, fulfilment: 'unknown',
      events: { shipped: [], delivered: [], cancelled: [], returned: [] }, shipments: [] }),
  ] })] }), { declaration: declaration('costco-2', 'casey', 'Sample Partner') });
  importPayload(db, syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(22, { date: '2031-01-22', lines: [
    ...K2_LINES, warehouseLine(3, 700, { itemNumber: '100130', department: 15 }),
  ] })] }));
  expect(db.prepare('SELECT DISTINCT merchant FROM retail_receipts').pluck().all()).toEqual([MERCHANT]);
  return {
    A: membershipRef(db, 'costco'), B: membershipRef(db, 'costco-2'),
    K1: receiptRef(db, warehouseKey(21)), K2: receiptRef(db, warehouseKey(22)), K3: receiptRef(db, warehouseKey(23)), K4: receiptRef(db, gasKey(24)),
    K5: receiptRef(db, orderKey(25)), K6: receiptRef(db, warehouseKey(26)),
  };
}

/** The mapping the category world is first filed under: every subject's rows but the later one's. */
const FIRST_MAPPING: RetailTaxonomyEntry[] = [
  reviewed(14, 'home-kitchen'), reviewed(15, 'office-school'),
  owner('100100', 'groceries/produce'), agent('100100', 'dining', 9_000),
  owner('100102', 'dining'),
  agent('100110', 'household/cleaning', MIN_BP), agent('100111', 'electronics', SUGGESTED_BELOW_BP), agent('100112', 'garden-patio', MIN_BP - 1),
  owner('100120', ITEM_TAXONOMY_RESIDUAL), agent('100120', 'toys-hobbies', 9_000),
  agent('100121', ITEM_TAXONOMY_ASSET_NODE, 9_000),
  owner('100130', 'baby-kids'), owner('100160', 'pet-supplies'), owner('400400', 'automotive/fuel'), owner('200299', 'memberships-fees'),
];
/** A later agent run moves product 100121 off precious metals: its earlier row still holds the line. */
const LATER_MAPPING: RetailTaxonomyEntry[] = [agent('100121', 'household', 9_000)];

describe('the Costco receipts read API: who and what it answers', () => {
  it('refuses a caller without a session (401) and every principal but the owner\'s session, the service token included (Amazon\'s 403)', async () => {
    const w = await world();
    for (const url of [...ALL_ROUTES(UNKNOWN_REF), `${RECEIPTS}/not-a-ref`, `${RECEIPTS}?limit=0`]) {
      expect((await w.client.get(url)).status, url).toBe(401);
      const service = await w.client.get(url).set('Authorization', `Bearer ${TOKEN}`);
      expect(service.status, url).toBe(403);
      expect(service.body, url).toEqual({ error: 'owner session required', code: 'principal-not-allowed' });
      expect(service.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('refuses card data, unknown or repeated names, bad values and anything but a receipt ref, before the database is touched', async () => {
    const w = await world();
    install(w.db);
    importPayload(w.db, syntheticRetailPayload());
    w.repo.probe = () => {
      throw new Error('the database was reached');
    };
    const card = '4111111111111111';
    const refusals: Array<[string, number, Record<string, unknown>]> = [
      [`${RECEIPTS}?membership=${card}`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.membership'] }],
      [`${SUMMARY}?${card}=1`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.<key>'] }],
      [`${RECEIPTS}/${UNKNOWN_REF}?note=${card}`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.<key>'] }],
      [`${RECEIPTS}/${card}`, 422, { error: CARD_DATA_MESSAGE, paths: ['params.ref'] }],
      [`${RECEIPTS}/rcp-${card}`, 422, { error: CARD_DATA_MESSAGE, paths: ['params.ref'] }],
      [`${SUMMARY}?secretname=1`, 400, invalid('unexpected query parameter')],
      [`${RECEIPTS}?secretname=1`, 400, invalid('unexpected query parameter')],
      [`${RECEIPTS}/${UNKNOWN_REF}?limit=1`, 400, invalid('unexpected query parameter')],
      [`${RECEIPTS}?limit=1&limit=2`, 400, invalid('limit must be given once')],
      [`${RECEIPTS}?channel=gas&channel=online`, 400, invalid('channel must be given once')],
      [`${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}&membership=${UNKNOWN_MEMBERSHIP}`, 400, invalid('membership must be given once')],
      [`${RECEIPTS}?offset=1&offset=2`, 400, invalid('offset must be given once')],
      // `q` is Spending's own: given once, at most 100 characters, no control character; card data in it is a 422.
      [`${RECEIPTS}?q=widget&q=gadget`, 400, invalid('q must be given once')],
      [`${RECEIPTS}?q=${'w'.repeat(101)}`, 400, invalid('q must be at most 100 characters')],
      [`${RECEIPTS}?q=wid%01get`, 400, invalid('q must not contain control characters')],
      [`${RECEIPTS}?q=${card}`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.q'] }],
      // `category` is one node id of the shared item tree, v2, exactly as the tree spells it, given once; anything else is a
      // 400 of its own; card data in it is a 422.
      [`${RECEIPTS}?category=groceries&category=dining`, 400, invalid('category must be given once')],
      [`${RECEIPTS}?category[]=groceries`, 400, invalid('category must be given once')],
      [`${RECEIPTS}?category=${card}`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.category'] }],
      ...['secret-node', '', 'Groceries', ' groceries', 'groceries ', 'groceries/', 'groceries/secret', 'secret/produce', 'produce', 'needs_review',
        'groceries,dining', 'GROCERIES/PRODUCE', 'groceries/produce/secret']
        .map((value): [string, number, Record<string, unknown>] => [`${RECEIPTS}?category=${encodeURIComponent(value)}`, 400, UNKNOWN_CATEGORY]),
      ...['limit=0', 'limit=101', 'limit=', 'limit=1.5', 'limit=-1', 'limit=secret7', 'offset=1000001', 'offset=-1', 'offset=12345678', 'offset=+1',
        'offset=%EF%BC%91'].map((query): [string, number, Record<string, unknown>] => [`${RECEIPTS}?${query}`, 400, invalid('invalid pagination')]),
      // `channel` is Spending's comma list: an unknown, empty or differently cased item refuses the whole list.
      ...['secretchannel', 'Gas', '', 'warehouse,,gas', 'warehouse,', ',gas', 'warehouse;gas', 'warehouse,secret', 'warehouse,gas,online,fuel']
        .map((value): [string, number, Record<string, unknown>] => [`${RECEIPTS}?channel=${encodeURIComponent(value)}`, 400, invalid(CHANNEL_LIST)]),
      [`${RECEIPTS}?membership=rtl-mbr-secret`, 400, invalid('invalid membership')],
      [`${RECEIPTS}?membership=rtl-mbr-${'q'.repeat(32)}`, 400, invalid('invalid membership')],
      // §3.7's order, every refusal before the database: card data (422) before a bad query (400) before a malformed
      // ref (404); a bad query before the membership's lookup.
      [`${RECEIPTS}/${card}?secretname=1`, 422, { error: CARD_DATA_MESSAGE, paths: ['params.ref'] }],
      [`${RECEIPTS}?membership=${card}&limit=0`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.membership'] }],
      [`${RECEIPTS}/not-a-secret-ref?secretname=1`, 400, invalid('unexpected query parameter')],
      [`${RECEIPTS}/not-a-secret-ref?limit=1&limit=2`, 400, invalid('unexpected query parameter')],
      [`${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}&limit=0`, 400, invalid('invalid pagination')],
      [`${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}&channel=fuel`, 400, invalid(CHANNEL_LIST)],
      // A malformed query first, then an unknown category; both before the membership's lookup.
      [`${RECEIPTS}?category=secret-node&limit=0`, 400, invalid('invalid pagination')],
      [`${RECEIPTS}?category=secret-node&channel=fuel&q=widget`, 400, invalid(CHANNEL_LIST)],
      [`${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}&category=secret-node`, 400, UNKNOWN_CATEGORY],
      [`${RECEIPTS}?category=${card}&limit=0`, 422, { error: CARD_DATA_MESSAGE, paths: ['query.category'] }],
      [`${RECEIPTS}/not-a-secret-ref`, 404, NOT_FOUND],
      [`${RECEIPTS}/rcp-${'a'.repeat(31)}`, 404, NOT_FOUND],
      [`${RECEIPTS}/RCP-${'a'.repeat(32)}`, 404, NOT_FOUND],
      [`${RECEIPTS}/rli-${'a'.repeat(32)}`, 404, NOT_FOUND],
    ];
    for (const [url, status, body] of refusals) {
      const res = await get(w, url);
      expect(res.status, url).toBe(status);
      expect(res.body, url).toEqual(body);
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.text, url).not.toMatch(/4111|secret/);
      // Every refusal the API owns is `{ error, reason }` with one of RETAIL_API_REFUSALS' fixed messages for its status.
      if (status !== 422) {
        const reason = (res.body as { reason: keyof typeof RETAIL_API_REFUSALS }).reason;
        expect(Object.keys(res.body), url).toEqual([...RETAIL_API_KEYS.refusal]);
        expect(RETAIL_API_REFUSALS[reason].status, url).toBe(status);
        expect(RETAIL_API_REFUSALS[reason].messages, url).toContain(res.body.error);
      }
    }
    // The control: a well-formed request does reach the database (here, the forbidding probe: a fixed 500).
    const reached = await get(w, `${RECEIPTS}/${UNKNOWN_REF}`);
    expect(reached.status).toBe(500);
    expect(reached.body).toEqual({ error: 'card spending request failed' });
    expect(w.logs.join('\n')).not.toMatch(/4111|secret|database was reached/);
  });

  it('answers 200 { format, version, state: absent } at each format\'s own version (the detail\'s 2) on every route without the retail tables, and creates none', async () => {
    const w = await world();
    // The state gate comes before any lookup: an unknown receipt or membership is no 404 without the tables.
    const answers: Array<[string, string, number]> = [
      [SUMMARY, RETAIL_API_FORMATS.summary, 1], [`${RECEIPTS}?channel=gas&limit=1`, RETAIL_API_FORMATS.receipts, 1],
      [`${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}&channel=warehouse,gas`, RETAIL_API_FORMATS.receipts, 1],
      [`${RECEIPTS}?category=needs-review&q=widget`, RETAIL_API_FORMATS.receipts, 1],
      [`${RECEIPTS}/${UNKNOWN_REF}`, RETAIL_API_FORMATS.receipt, 2],
    ];
    for (const [url, format, version] of answers) {
      const res = await get(w, url);
      expect(res.status, url).toBe(200);
      expect(res.body, url).toEqual({ format, version, state: 'absent' });
      expect(Object.keys(res.body), url).toEqual([...RETAIL_API_KEYS.absent]);
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
    expect(retailSchemaState(w.db)).toBe('absent');
    expect(tablesAndCounts(w.db).filter(([name]) => name.startsWith('retail_'))).toEqual([]);
  });

  it('answers a fixed 409 schema-conflict for retail tables of another shape, on every route, never an empty success', async () => {
    const changes = [
      'CREATE TABLE retail_extra (id INTEGER)',
      'CREATE INDEX retail_receipts_by_state ON retail_receipts (state)',
      'DROP TRIGGER retail_audit_no_delete',
    ];
    for (const change of changes) {
      const w = await world();
      install(w.db);
      importPayload(w.db, syntheticRetailPayload());
      const ref = receiptRef(w.db, warehouseKey(1));
      w.db.exec(change);
      expect(retailSchemaState(w.db), change).toBe('conflict');
      for (const url of [...ALL_ROUTES(ref), `${RECEIPTS}/${UNKNOWN_REF}`, `${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}`,
        `${RECEIPTS}?category=needs-review`]) {
        const res = await get(w, url);
        expect(res.status, `${change}: ${url}`).toBe(409);
        expect(res.body, `${change}: ${url}`).toEqual({ error: CONFLICT_MESSAGES['schema-conflict'], reason: 'schema-conflict' });
        expect(Object.keys(res.body)).toEqual([...RETAIL_API_KEYS.refusal]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
  });

  it('answers a fixed 409 retail-reserved-value for each stored reserved value, on every route (PR 2\'s STOP), with no count', async () => {
    for (const [what, add] of Object.entries(RETAIL_RESERVED_FIXTURES)) {
      const w = await world();
      install(w.db);
      importPayload(w.db, syntheticRetailPayload({ capture: 'b' }));
      importPayload(w.db, syntheticRetailPayload({ capture: 'c', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] }));
      add(w.db, retailReservedBase(w.db, warehouseKey(1)));
      expect(reservedValuesStored(w.db), what).not.toEqual(NO_RESERVED);
      for (const url of [...ALL_ROUTES(receiptRef(w.db, warehouseKey(1))), `${RECEIPTS}/${UNKNOWN_REF}`, `${RECEIPTS}?membership=${UNKNOWN_MEMBERSHIP}`,
        `${RECEIPTS}?category=needs-review`]) {
        const res = await get(w, url);
        expect(res.status, `${what}: ${url}`).toBe(409);
        expect(res.body, `${what}: ${url}`).toEqual({ error: CONFLICT_MESSAGES['retail-reserved-value'], reason: 'retail-reserved-value' });
        expect(Object.keys(res.body)).toEqual([...RETAIL_API_KEYS.refusal]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
  });
});

describe('the Costco receipts read API over receipts PR 2\'s importer stored', () => {
  it('summarizes counts only: memberships in registration order, receipts by channel and state, quarantine reasons, held, capture', async () => {
    const w = await world();
    const refs = importWorld(w.db);
    const res = await get(w, SUMMARY);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    summaryKeys(res.body);
    const counts = (warehouse: [number, number], gas: [number, number], online: [number, number]) => ({
      warehouse: { active: warehouse[0], quarantined: warehouse[1] }, gas: { active: gas[0], quarantined: gas[1] },
      online: { active: online[0], quarantined: online[1] },
    });
    expect(res.body).toEqual({
      format: RETAIL_API_FORMATS.summary, version: 1, state: 'present',
      memberships: [
        {
          membershipRef: refs.A, label: 'Sample Household', owner: 'alex', receipts: counts([3, 2], [1, 0], [1, 0]),
          capture: {
            ranges: [
              { channel: 'online', from: '2030-11-01', to: '2030-11-15' },
              { channel: 'online', from: '2031-01-01', to: '2031-01-31' },
              { channel: 'warehouse', from: '2030-12-01', to: '2031-01-31' },
            ],
            capturedThrough: '2031-02-03',
          },
        },
        {
          membershipRef: refs.B, label: 'Sample Partner', owner: 'casey', receipts: counts([1, 1], [0, 0], [1, 0]),
          capture: {
            ranges: [{ channel: 'online', from: '2031-01-01', to: '2031-01-31' }, { channel: 'warehouse', from: '2031-01-01', to: '2031-01-31' }],
            capturedThrough: '2031-02-10',
          },
        },
      ],
      receipts: counts([3, 2], [1, 0], [2, 0]),
      quarantine: { 'duplicate-across-memberships': 1, 'receipt-changed': 1, 'policy-reread-changed': 0, 'receipt-held-later': 0 },
      held: 5,
    });
    // Counts only: no amount anywhere, and nothing that never leaves the database (natural keys, the capture digest).
    expect(allKeys(res.body).filter((key) => /Minor$/.test(key))).toEqual([]);
    expect(res.text).not.toMatch(/costco-(?:receipt|order|line)-|bbbbbbbbbbbbbbbb|0042/);
  });

  it('reads capturedThrough as the latest capture over a membership\'s imports, as its day, when an older capture is imported later', async () => {
    const w = await world();
    install(w.db);
    const capturedThrough = async () => (await get(w, SUMMARY)).body.memberships[0].capture.capturedThrough as string;
    importPayload(w.db, syntheticRetailPayload({ capture: 'b', capturedAt: '2031-02-03T04:05:06Z' }));
    expect(await capturedThrough()).toBe('2031-02-03');
    importPayload(w.db, syntheticRetailPayload({ capture: 'c', capturedAt: '2031-01-05T00:00:00Z', receipts: [warehouseReceipt(2, { date: '2031-01-04' })] }));
    expect(w.db.prepare('SELECT captured_at FROM retail_imports ORDER BY import_seq').pluck().all())
      .toEqual(['2031-02-03T04:05:06.000Z', '2031-01-05T00:00:00.000Z']);
    expect(await capturedThrough()).toBe('2031-02-03');
    importPayload(w.db, syntheticRetailPayload({ capture: 'd', capturedAt: '2031-02-03T23:59:59.5Z', receipts: [warehouseReceipt(3)] }));
    expect(await capturedThrough()).toBe('2031-02-03');
    importPayload(w.db, syntheticRetailPayload({ capture: 'e', capturedAt: '2031-02-04T00:00:00Z', receipts: [warehouseReceipt(4)] }));
    expect(await capturedThrough()).toBe('2031-02-04');
  });

  it('counts held records once per distinct key, and every record without a key once, across imports', async () => {
    const w = await world();
    install(w.db);
    const held = async () => (await get(w, SUMMARY)).body.held as number;
    expect(await held()).toBe(0);
    importPayload(w.db, syntheticRetailPayload({ capture: 'b', held: [heldRecord({ naturalKey: warehouseKey(90) })] }));
    expect(await held()).toBe(1);
    // The same key again, in another import: once.
    importPayload(w.db, syntheticRetailPayload({ capture: 'c', held: [heldRecord({ naturalKey: warehouseKey(90) })] }));
    expect(await held()).toBe(1);
    // Two different keys: two.
    importPayload(w.db, syntheticRetailPayload({ capture: 'd', held: [heldRecord({ naturalKey: warehouseKey(91) })] }));
    expect(await held()).toBe(2);
    // Every record without a key: one each, in one import and across imports.
    importPayload(w.db, syntheticRetailPayload({ capture: 'e', held: [KEYLESS, KEYLESS] }));
    expect(await held()).toBe(4);
    importPayload(w.db, syntheticRetailPayload({ capture: 'f', held: [KEYLESS, heldRecord({ naturalKey: warehouseKey(91) })] }));
    expect(await held()).toBe(5);
    expect(w.db.prepare('SELECT count(*) FROM retail_held').pluck().get()).toBe(7);
  });

  it('lists every receipt from its canonical version, date descending then ref, quarantined ones included, filtered then paged', async () => {
    const w = await world();
    const refs = importWorld(w.db);
    const order = newestFirst(refs);
    const page = async (query: string) => {
      const res = await get(w, `${RECEIPTS}${query}`);
      expect(res.status, query).toBe(200);
      expect(res.headers['cache-control'], query).toBe('no-store');
      receiptsKeys(res.body);
      return res.body as { total: number; offset: number; limit: number; receipts: Array<Record<string, unknown>> };
    };
    const all = await page('');
    expect({ ...all, receipts: all.receipts.map((row) => row.receiptRef) })
      .toEqual({ format: RETAIL_API_FORMATS.receipts, version: 1, state: 'present', total: 8, offset: 0, limit: 50, receipts: order });
    const row = (ref: string) => all.receipts.find((entry) => entry.receiptRef === ref);
    expect(row(refs.W1)).toEqual({
      receiptRef: refs.W1, channel: 'warehouse', sign: 'sale', status: null, date: '2031-01-10', currency: 'USD', totalMinor: 252_380, itemLines: 3,
      memberships: [refs.A], state: 'active', quarantineReason: null, tenders: { kinds: ['card', 'shop-card'], cardSpendingMinor: 251_880, otherMinor: 500 },
      matchingLines: null,
    });
    expect(row(refs.W2)).toEqual({
      receiptRef: refs.W2, channel: 'warehouse', sign: 'sale', status: null, date: '2031-01-20', currency: 'USD', totalMinor: 1_080, itemLines: 1,
      memberships: [refs.A, refs.B], state: 'quarantined', quarantineReason: 'duplicate-across-memberships',
      tenders: { kinds: ['debit'], cardSpendingMinor: 0, otherMinor: 1_080 }, matchingLines: null,
    });
    expect(row(refs.G1)).toMatchObject({ channel: 'gas', date: '2031-01-15', totalMinor: 4_270, itemLines: 0, memberships: [refs.A],
      tenders: { kinds: ['card'], cardSpendingMinor: 4_270, otherMinor: 0 } });
    expect(row(refs.O1)).toMatchObject({ channel: 'online', status: 'delivered', totalMinor: 4_700, itemLines: 1,
      tenders: { kinds: ['card', 'shop-card'], cardSpendingMinor: 4_700, otherMinor: 1_000 } });
    expect(row(refs.R1)).toMatchObject({ sign: 'refund', totalMinor: -1_080, tenders: { kinds: ['card-refund'], cardSpendingMinor: -1_080, otherMinor: 0 } });
    expect(row(refs.S1)).toMatchObject({ memberships: [refs.A, refs.B], state: 'active' });
    expect(row(refs.Q1)).toMatchObject({ date: '2031-01-03', state: 'quarantined', quarantineReason: 'receipt-changed', memberships: [refs.A] });
    expect(row(refs.O2)).toMatchObject({ channel: 'online', status: 'shipped', memberships: [refs.B] });

    // Each row's money is its own receipt's canonical facts: its stated total and its own tenders, never anything across receipts.
    for (const entry of all.receipts) {
      const total = w.db.prepare(`SELECT v.total_minor FROM retail_receipts r JOIN retail_receipt_versions v ON v.version_ref = r.canonical_version
        WHERE r.receipt_ref = ?`).pluck().get(entry.receiptRef);
      const tenders = w.db.prepare(`SELECT t.kind, t.amount_minor AS amount FROM retail_receipts r JOIN retail_tender_facts t
        ON t.version_ref = r.canonical_version WHERE r.receipt_ref = ?`).all(entry.receiptRef) as Array<{ kind: string; amount: number }>;
      const paid = (card: boolean) => tenders.filter((tender) => ['card', 'card-refund'].includes(tender.kind) === card)
        .reduce((sum, tender) => sum + tender.amount, 0);
      expect(entry.totalMinor).toBe(total);
      expect(entry.tenders).toMatchObject({ cardSpendingMinor: paid(true), otherMinor: paid(false) });
    }

    const refsOf = async (query: string) => {
      const body = await page(query);
      expect(body.total, query).toBe(body.receipts.length);
      return body.receipts.map((entry) => entry.receiptRef);
    };
    expect(await refsOf(`?membership=${refs.A}`)).toEqual(order.filter((ref) => ref !== refs.O2));
    expect(await refsOf(`?membership=${refs.B}`)).toEqual([refs.W2, refs.O2, refs.S1]);
    expect(await refsOf('?channel=gas')).toEqual([refs.G1]);
    expect(await refsOf('?channel=online')).toEqual([refs.O2, refs.O1]);
    expect(await refsOf('?channel=warehouse')).toEqual(order.filter((ref) => ![refs.G1, refs.O1, refs.O2].includes(ref)));
    expect(await refsOf(`?membership=${refs.B}&channel=online`)).toEqual([refs.O2]);
    expect(await refsOf(`?channel=gas&membership=${refs.B}`)).toEqual([]);

    // `channel` is a comma list (Spending's `list`): the channels it names, in the list's own order (date descending, then
    // ref) whatever order they're named in; items trimmed, a repeat once; all three is every receipt.
    const warehouseAndGas = order.filter((ref) => ![refs.O1, refs.O2].includes(ref));
    expect(await refsOf('?channel=warehouse,gas')).toEqual(warehouseAndGas);
    const named = await page('?channel=warehouse,gas');
    for (const query of ['?channel=gas,warehouse', '?channel=gas,%20warehouse', '?channel=warehouse,gas,gas', '?channel=%20warehouse%20,gas']) {
      expect(await page(query), query).toEqual(named);
    }
    expect(await page('?channel=online,gas,warehouse')).toEqual(all);
    expect(await refsOf('?channel=gas,gas')).toEqual([refs.G1]);
    expect(await refsOf(`?membership=${refs.B}&channel=warehouse,online`)).toEqual([refs.W2, refs.O2, refs.S1]);
    const channelPage = await page('?channel=online,warehouse&offset=1&limit=2');
    expect({ total: channelPage.total, offset: channelPage.offset, limit: channelPage.limit, refs: channelPage.receipts.map((entry) => entry.receiptRef) })
      .toEqual({ total: 7, offset: 1, limit: 2, refs: order.filter((ref) => ref !== refs.G1).slice(1, 3) });

    // A well-formed membership no membership has: 404 membership-not-found, looked up before any filter or page.
    for (const query of [`?membership=${UNKNOWN_MEMBERSHIP}`, `?membership=${UNKNOWN_MEMBERSHIP}&channel=warehouse,gas&offset=5&limit=1`]) {
      const res = await get(w, `${RECEIPTS}${query}`);
      expect(res.status, query).toBe(404);
      expect(res.body, query).toEqual(MEMBERSHIP_NOT_FOUND);
      expect(Object.keys(res.body), query).toEqual([...RETAIL_API_KEYS.refusal]);
      expect(res.headers['cache-control'], query).toBe('no-store');
    }

    // Filters first, then the page; `total` counts every receipt the filters match.
    const paged = async (query: string) => {
      const body = await page(query);
      return { total: body.total, offset: body.offset, limit: body.limit, refs: body.receipts.map((entry) => entry.receiptRef) };
    };
    expect(await paged('?limit=3')).toEqual({ total: 8, offset: 0, limit: 3, refs: order.slice(0, 3) });
    expect(await paged('?offset=3&limit=3')).toEqual({ total: 8, offset: 3, limit: 3, refs: order.slice(3, 6) });
    expect(await paged('?limit=3&offset=6')).toEqual({ total: 8, offset: 6, limit: 3, refs: order.slice(6) });
    expect(await paged('?offset=8')).toEqual({ total: 8, offset: 8, limit: 50, refs: [] });
    expect(await paged('?offset=1000000&limit=100')).toEqual({ total: 8, offset: 1_000_000, limit: 100, refs: [] });
    expect(await paged(`?membership=${refs.A}&offset=5&limit=1`))
      .toEqual({ total: 7, offset: 5, limit: 1, refs: order.filter((ref) => ref !== refs.O2).slice(5, 6) });
    expect(await paged('?offset=0001&limit=001')).toEqual({ total: 8, offset: 1, limit: 1, refs: order.slice(1, 2) });
  });

  it('searches the item lines (q): a shown title, second description or item number in any case, or an amount; rows list their matches', async () => {
    const w = await world();
    const refs = importWorld(w.db);
    const order = newestFirst(refs);
    const search = async (query: string) => {
      const res = await get(w, `${RECEIPTS}?${query}`);
      expect(res.status, query).toBe(200);
      expect(res.headers['cache-control'], query).toBe('no-store');
      receiptsKeys(res.body);
      return res.body as { total: number; offset: number; limit: number;
        receipts: Array<{ receiptRef: string; matchingLines: Array<Record<string, unknown>> | null }> };
    };
    /** Each matching receipt (filters first, date descending then ref) with its matching lines' titles (or item numbers). */
    const found = async (query: string) => {
      const body = await search(query);
      expect(body.total, query).toBe(body.receipts.length);
      return body.receipts.map((row) => [row.receiptRef, (row.matchingLines ?? []).map((line) => line.title ?? line.itemNumber)]);
    };
    const widgets = order.filter((ref) => [refs.R1, refs.W2, refs.W1, refs.S1, refs.Q1].includes(ref));
    expect(await found('q=widget')).toEqual(widgets.map((ref) => [ref, [SYNTHETIC_RETAIL.widget]]));
    // Any case; trimmed and spaces collapsed; an empty search is no search.
    for (const query of ['q=WiDgEt', 'q=%20%20widget%20', 'q=sample%20%20widget']) expect(await search(query), query).toEqual(await search('q=widget'));
    const plain = await search('offset=0');
    expect(plain.receipts.every((row) => row.matchingLines === null)).toBe(true);
    for (const query of ['q=', 'q=%20%20']) expect(await search(query), query).toEqual(plain);
    // An item number; a second description; a title the API doesn't show is never searched.
    expect(await found('q=100103')).toEqual([[refs.W1, [SYNTHETIC_RETAIL.gadget]]]);
    expect((await search('q=one%20ounce')).receipts).toEqual([{ ...(await search('q=one%20ounce')).receipts[0], receiptRef: refs.W1, matchingLines: [{
      lineRef: expect.stringMatching(/^rli-[a-p]{32}$/), kind: 'item', itemNumber: '100102', title: SYNTHETIC_RETAIL.bar, title2: 'SAMPLE ONE OUNCE',
      quantity: 1, amountMinor: 250_000 }] }]);
    expect(await found('q=redacted')).toEqual([]);
    // An amount: a line's amount or unit price, either sign (a coupon, a refund); bare digits are text only.
    for (const query of ['q=15.00', 'q=%2415.00', 'q=%2415']) expect(await found(query), query).toEqual([[refs.W1, [SYNTHETIC_RETAIL.gadget]]]);
    expect(await found('q=2.00')).toEqual([[refs.W1, ['300301']]]);
    expect(await found('q=10.00')).toEqual(widgets.map((ref) => [ref, [SYNTHETIC_RETAIL.widget]]));
    expect(await found('q=3.00')).toEqual([[refs.O1, ['SAMPLE FEE']]]);
    expect(await found('q=42.70')).toEqual([[refs.G1, ['SAMPLE FUEL']]]);
    expect(await found('q=4270')).toEqual([]);
    expect(await found('q=fuel')).toEqual([[refs.G1, ['SAMPLE FUEL']]]);
    // With the other filters, then the page; `total` counts the matching receipts.
    expect(await found('q=gadget&channel=online')).toEqual([[refs.O2, [SYNTHETIC_RETAIL.gadget]], [refs.O1, [SYNTHETIC_RETAIL.gadget]]]);
    expect(await found(`q=widget&membership=${refs.B}`)).toEqual([refs.W2, refs.S1].map((ref) => [ref, [SYNTHETIC_RETAIL.widget]]));
    const paged = await search('q=widget&offset=1&limit=2');
    expect([paged.total, paged.offset, paged.limit, paged.receipts.map((row) => row.receiptRef)]).toEqual([5, 1, 2, widgets.slice(1, 3)]);
    expect(await found('q=no%20such%20item')).toEqual([]);
  });

  it('shows one receipt as its canonical version states it: lines in order, coupon under its item, fuel, metal, tenders', async () => {
    const w = await world();
    const refs = importWorld(w.db);
    const detail = async (ref: string) => {
      const res = await get(w, `${RECEIPTS}/${ref}`);
      expect(res.status, ref).toBe(200);
      expect(res.headers['cache-control'], ref).toBe('no-store');
      receiptKeys(res.body);
      expect(res.body).toMatchObject({ format: RETAIL_API_FORMATS.receipt, version: 2, state: 'present' });
      expect(res.text).not.toMatch(/costco-(?:receipt|order|line)-|bbbbbbbbbbbbbbbb/);
      return res.body.receipt as Record<string, unknown> & { lines: Array<Record<string, unknown>> };
    };
    const lineRefs = (receipt: { lines: Array<Record<string, unknown>> }) => {
      const found = receipt.lines.map((line) => line.lineRef as string);
      for (const ref of found) expect(ref).toMatch(/^rli-[a-p]{32}$/);
      expect(new Set(found).size).toBe(found.length);
      return found;
    };
    // No taxonomy row is stored: every item, fee and fuel line is in Needs review, but the title rule's gold bar.
    const plain = { title2: null, shippingMinor: null, storedValue: null, fulfilment: null, fuel: null, couponFor: null, feeOf: null, metal: null,
      metalUncertain: null, events: null, shipments: [], category: NEEDS_REVIEW };

    const w1 = await detail(refs.W1);
    const [l0, l1, l2, l3] = lineRefs(w1);
    expect(w1).toEqual({
      receiptRef: refs.W1, channel: 'warehouse', state: 'active', quarantineReason: null, memberships: [refs.A], date: '2031-01-10', localTime: '10:15',
      sign: 'sale', status: null, currency: 'USD',
      totals: { subtotalMinor: 252_300, taxMinor: 80, instantSavingsMinor: 200, discountMinor: null, shippingMinor: null, feesMinor: null,
        storedValueMinor: null, totalMinor: 252_380 },
      taxLegends: [{ legend: 'A', amountMinor: 80 }],
      lines: [
        { ...plain, lineRef: l0, kind: 'item', itemNumber: '100100', title: SYNTHETIC_RETAIL.widget, quantity: 1, unitPriceMinor: 1_000, amountMinor: 1_000,
          taxFlag: 'Y' },
        { ...plain, lineRef: l1, kind: 'coupon', itemNumber: '300301', title: null, quantity: null, unitPriceMinor: null, amountMinor: -200, taxFlag: null,
          couponFor: l0, category: null },
        { ...plain, lineRef: l2, kind: 'item', itemNumber: '100102', title: SYNTHETIC_RETAIL.bar, title2: 'SAMPLE ONE OUNCE', quantity: 1,
          unitPriceMinor: 250_000, amountMinor: 250_000, taxFlag: 'Y',
          metal: { metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'ozt' }, pack: 'single', rule: RETAIL_METAL_TITLE_RULE },
          category: TITLE_RULE_GOLD },
        // Spending's item-title guard: a redacted title is shown as none. The metal guard's flag is no title-rule match.
        { ...plain, lineRef: l3, kind: 'item', itemNumber: '100103', title: SYNTHETIC_RETAIL.gadget, title2: null, quantity: 1, unitPriceMinor: 1_500,
          amountMinor: 1_500, taxFlag: 'Y', metalUncertain: { guard: RETAIL_METAL_GUARD, evidence: ['bullion-word'], metal: 'XAU' } },
      ],
      tenders: [
        { kind: 'card', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: 251_880, cardSpending: true },
        { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 500, cardSpending: false },
      ],
    });

    const g1 = await detail(refs.G1);
    expect(g1).toMatchObject({
      channel: 'gas', localTime: '07:30', taxLegends: [],
      totals: { subtotalMinor: 4_270, taxMinor: 0, instantSavingsMinor: null, discountMinor: null, shippingMinor: null, feesMinor: null,
        storedValueMinor: null, totalMinor: 4_270 },
      tenders: [{ kind: 'card', network: 'mastercard', last4: SYNTHETIC_RETAIL.card2, amountMinor: 4_270, cardSpending: true }],
    });
    expect(g1.lines).toEqual([{ ...plain, lineRef: lineRefs(g1)[0], kind: 'fuel', itemNumber: '400400', title: 'SAMPLE FUEL', quantity: null,
      unitPriceMinor: null, amountMinor: 4_270, taxFlag: null, fuel: { gallons: '12.345', unitPrice: '3.459' } }]);

    const o1 = await detail(refs.O1);
    const [item, fee] = lineRefs(o1);
    const shipmentRef = w.db.prepare('SELECT shipment_ref FROM retail_shipment_refs WHERE line_ref = ?').pluck().get(item) as string;
    expect(shipmentRef).toMatch(/^shp-[a-p]{32}$/);
    expect(o1).toEqual({
      receiptRef: refs.O1, channel: 'online', state: 'active', quarantineReason: null, memberships: [refs.A], date: '2031-01-11', localTime: null,
      sign: 'sale', status: 'delivered', currency: 'USD',
      totals: { subtotalMinor: 5_300, taxMinor: 400, instantSavingsMinor: null, discountMinor: 0, shippingMinor: 0, feesMinor: 0, storedValueMinor: 1_000,
        totalMinor: 4_700 },
      taxLegends: [],
      lines: [
        { ...plain, lineRef: item, kind: 'item', itemNumber: '200200', title: SYNTHETIC_RETAIL.gadget, quantity: 1, unitPriceMinor: 5_000,
          amountMinor: 5_000, shippingMinor: 0, taxFlag: null, fulfilment: 'parcel',
          events: { shipped: [{ quantity: 1, date: '2031-01-12' }], delivered: [{ quantity: 1, date: '2031-01-14' }], cancelled: [], returned: [] },
          shipments: [{ shipmentRef, shippedDate: '2031-01-12', deliveredDate: '2031-01-14', estimatedArrivalDate: '2031-01-15', carrier: 'ups' }] },
        { ...plain, lineRef: fee, kind: 'fee', itemNumber: null, title: 'SAMPLE FEE', quantity: 1, unitPriceMinor: 300, amountMinor: 300,
          shippingMinor: 0, taxFlag: null, fulfilment: 'unknown', feeOf: item,
          events: { shipped: [], delivered: [], cancelled: [], returned: [] }, shipments: [] },
      ],
      tenders: [
        { kind: 'card', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: 4_700, cardSpending: true },
        { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 1_000, cardSpending: false },
      ],
    });

    expect(await detail(refs.R1)).toMatchObject({
      sign: 'refund', totals: { subtotalMinor: -1_000, taxMinor: -80, totalMinor: -1_080 },
      lines: [{ kind: 'item', quantity: -1, unitPriceMinor: 1_000, amountMinor: -1_000 }],
      tenders: [{ kind: 'card-refund', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: -1_080, cardSpending: true }],
    });
    // Quarantined receipts are shown with their first reason, as their canonical (first) version states them.
    expect(await detail(refs.Q1)).toMatchObject({ state: 'quarantined', quarantineReason: 'receipt-changed', date: '2031-01-03', memberships: [refs.A] });
    expect(await detail(refs.W2)).toMatchObject({ state: 'quarantined', quarantineReason: 'duplicate-across-memberships', date: '2031-01-20',
      memberships: [refs.A, refs.B], tenders: [{ kind: 'debit', network: 'unknown', last4: null, amountMinor: 1_080, cardSpending: false }] });
    expect(await detail(refs.S1)).toMatchObject({ memberships: [refs.A, refs.B] });

    // An unknown ref of the right shape is the same 404 as a malformed one.
    const unknown = await get(w, `${RECEIPTS}/${UNKNOWN_REF}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(NOT_FOUND);
    expect(unknown.headers['cache-control']).toBe('no-store');
  });

  it('reads each request in one read transaction on the API\'s handle, every statement read-only, and writes nothing', async () => {
    const w = await world();
    const refs = importWorld(w.db);
    // Taxonomy rows stored: a detail and a category filter read them too, in the same transaction; nothing else does.
    importTaxonomy(w.db, [owner('100100', 'groceries'), agent('200200', 'electronics', 7_000), reviewed(12, 'home-kitchen')]);
    const before = { tables: tablesAndCounts(w.db), changes: w.db.prepare('SELECT total_changes()').pluck().get() };
    let transactions = 0;
    let statements: Array<{ sql: string; inTransaction: boolean; readonly: boolean }> = [];
    let handles = 0;
    w.repo.probe = (db) => {
      handles += 1;
      return new Proxy(db, {
        get(target, key) {
          if (key === 'transaction') {
            return (fn: () => unknown) => {
              transactions += 1;
              return target.transaction(fn);
            };
          }
          if (key === 'prepare') {
            return (sql: string) => {
              const statement = target.prepare(sql);
              statements.push({ sql, inTransaction: target.inTransaction, readonly: statement.readonly });
              return statement;
            };
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const urls = [
      SUMMARY, RECEIPTS, `${RECEIPTS}?membership=${refs.B}&channel=warehouse&offset=1&limit=1`, `${RECEIPTS}/${UNKNOWN_REF}`,
      ...RECEIPT_NAMES.map((name) => `${RECEIPTS}/${refs[name]}`),
      `${RECEIPTS}?category=groceries`, `${RECEIPTS}?category=home-kitchen&membership=${refs.A}&channel=warehouse,gas&q=widget&offset=1&limit=1`,
    ];
    const readsTaxonomy = (url: string) => url.includes('category=') || (url.startsWith(`${RECEIPTS}/`) && !url.endsWith(UNKNOWN_REF));
    for (const url of urls) {
      transactions = 0;
      handles = 0;
      statements = [];
      const res = await get(w, url);
      expect(res.status, url).toBe(url.endsWith(UNKNOWN_REF) ? 404 : 200);
      expect({ handles, transactions }, url).toEqual({ handles: 1, transactions: 1 });
      expect(statements.length, url).toBeGreaterThan(2);
      expect(statements.filter((statement) => !statement.inTransaction || !statement.readonly), url).toEqual([]);
      expect(statements.some((statement) => /\bretail_taxonomy_assignments\b/.test(statement.sql)), url).toBe(readsTaxonomy(url));
    }
    w.repo.probe = undefined;
    expect({ tables: tablesAndCounts(w.db), changes: w.db.prepare('SELECT total_changes()').pluck().get() }).toEqual(before);
    expect(reservedValuesStored(w.db)).toEqual(NO_RESERVED);
  });
});

describe('the Costco receipts read API\'s line categories: the retail taxonomy\'s F, on the detail (v2) and as the list\'s filter', () => {
  /** Each line's category in a receipt's detail, its keys checked. */
  const categories = async (w: World, ref: string): Promise<Array<RetailApiLineCategory | null>> => {
    const res = await get(w, `${RECEIPTS}/${ref}`);
    expect(res.status, ref).toBe(200);
    expect(res.headers['cache-control'], ref).toBe('no-store');
    receiptKeys(res.body);
    expect(res.body, ref).toMatchObject({ format: RETAIL_API_FORMATS.receipt, version: 2, state: 'present' });
    return (res.body.receipt.lines as Array<{ category: RetailApiLineCategory | null }>).map((line) => line.category);
  };
  const NAMES = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'] as const;

  it('files each item, fee and fuel line under the resolver\'s F with its node\'s card category, a coupon under none', async () => {
    const w = await world();
    const refs = categoryWorld(w.db);
    // A subcategory's card category is its own where it has one: fuel's, not automotive's.
    expect(category('automotive/fuel').cardCategory).not.toBe(category('automotive').cardCategory);

    // No row stored: Needs review from nothing (source, confidence and suggestion null, not held), but the title rule's
    // gold bar; a coupon has no category.
    const unfiled = { K1: [NEEDS_REVIEW, null, TITLE_RULE_GOLD, NEEDS_REVIEW], K2: [NEEDS_REVIEW, NEEDS_REVIEW, NEEDS_REVIEW],
      K3: [NEEDS_REVIEW, NEEDS_REVIEW], K4: [NEEDS_REVIEW], K5: [NEEDS_REVIEW, NEEDS_REVIEW], K6: [NEEDS_REVIEW, null] };
    for (const name of NAMES) expect(await categories(w, refs[name]), name).toEqual(unfiled[name]);

    importTaxonomy(w.db, FIRST_MAPPING);
    const filed = {
      K1: [
        // The owner's node, over an agent's at any confidence.
        category('groceries/produce', { source: 'owner' }),
        null,
        // The title rule, over the owner's row naming another node.
        TITLE_RULE_GOLD,
        // A line without an item number: its department's reviewed node.
        category('home-kitchen', { source: 'department-review' }),
      ],
      K2: [
        // An agent from the minimum files its line: suggested below the suggested bound, not from it.
        category('household/cleaning', { source: 'agent', confidenceBp: MIN_BP, suggested: true }),
        category('electronics', { source: 'agent', confidenceBp: SUGGESTED_BELOW_BP }),
        // Below the minimum: Needs review, with the agent's node as its suggestion (department 12 has no row).
        category(ITEM_TAXONOMY_RESIDUAL, { suggestion: { node: 'garden-patio', confidenceBp: MIN_BP - 1 } }),
      ],
      K3: [
        // The owner's explicit Needs review is final, over an agent's node.
        category(ITEM_TAXONOMY_RESIDUAL, { source: 'owner' }),
        category(ITEM_TAXONOMY_ASSET_NODE, { source: 'agent', confidenceBp: 9_000, metalHold: true }),
      ],
      // A fuel line and a fee carry a category; a coupon in a reviewed department still has none.
      K4: [category('automotive/fuel', { source: 'owner' })],
      K5: [NEEDS_REVIEW, category('memberships-fees', { source: 'owner' })],
      K6: [category('pet-supplies', { source: 'owner' }), null],
    };
    for (const name of NAMES) expect(await categories(w, refs[name]), name).toEqual(filed[name]);

    // A later agent row moves product 100121 to another node: its earlier row naming precious metals still holds the line.
    importTaxonomy(w.db, LATER_MAPPING);
    const moved = { ...filed, K3: [filed.K3[0], category('household', { source: 'agent', confidenceBp: 9_000, metalHold: true })] };
    for (const name of NAMES) expect(await categories(w, refs[name]), name).toEqual(moved[name]);
  });

  it('lists the receipts with a canonical item, fee or fuel line in a category or its subcategories, with the other filters, then paged', async () => {
    const w = await world();
    const refs = categoryWorld(w.db);
    const order = [refs.K5, refs.K4, refs.K3, refs.K2, refs.K1, refs.K6];
    const page = async (query: string) => {
      const res = await get(w, `${RECEIPTS}?${query}`);
      expect(res.status, query).toBe(200);
      expect(res.headers['cache-control'], query).toBe('no-store');
      receiptsKeys(res.body);
      return res.body as { total: number; offset: number; limit: number;
        receipts: Array<{ receiptRef: string; state: string; quarantineReason: string | null; matchingLines: Array<Record<string, unknown>> | null }> };
    };
    const refsOf = async (query: string) => {
      const body = await page(query);
      expect(body.total, query).toBe(body.receipts.length);
      return body.receipts.map((row) => row.receiptRef);
    };
    expect(await refsOf('limit=100')).toEqual(order);

    // No row stored: every receipt has a line in Needs review, and only the title rule's gold bar is in precious metals.
    expect(await refsOf('category=needs-review')).toEqual(order);
    expect(await refsOf('category=precious-metals')).toEqual([refs.K1]);
    expect(await refsOf('category=groceries')).toEqual([]);
    // An agent's precious metals files K3's line there, until a later run moves it.
    importTaxonomy(w.db, FIRST_MAPPING);
    expect(await refsOf('category=precious-metals')).toEqual([refs.K3, refs.K1]);
    importTaxonomy(w.db, LATER_MAPPING);

    const expectations: Array<[string, string[]]> = [
      ['groceries/produce', [refs.K1]],
      // A top level keeps its subcategories' lines; a subcategory never keeps its top level's own.
      ['groceries', [refs.K1]],
      ['household', [refs.K3, refs.K2]],
      ['household/cleaning', [refs.K2]],
      ['automotive', [refs.K4]],
      ['automotive/fuel', [refs.K4]],
      ['home-kitchen', [refs.K1]],
      ['electronics', [refs.K2]],
      ['memberships-fees', [refs.K5]],
      ['pet-supplies', [refs.K6]],
      // Needs review: lines nothing resolved, the one below the minimum, and the owner's explicit choice.
      ['needs-review', [refs.K5, refs.K3, refs.K2]],
      // Precious metals: the line's node, never its hold (K3's held line is in household now).
      ['precious-metals', [refs.K1]],
      // Never a coupon's line (K6's, in reviewed department 15), a line of a version that isn't canonical (K2's line
      // more), a suggestion (K2's), nor a row a higher step overrides (the agents under the owner, the owner under the
      // title rule); a node no line is filed under keeps nothing.
      ['office-school', []], ['baby-kids', []], ['garden-patio', []], ['toys-hobbies', []], ['dining', []], ['groceries/meat-seafood', []],
    ];
    for (const [node, expected] of expectations) expect(await refsOf(`category=${encodeURIComponent(node)}`), node).toEqual(expected);
    expect(await refsOf('category=groceries/produce')).toEqual([refs.K1]);
    // A quarantined receipt is listed under its canonical version's categories, with its reason.
    expect((await page('category=household/cleaning')).receipts.map((row) => [row.state, row.quarantineReason]))
      .toEqual([['quarantined', 'receipt-changed']]);

    // With the other filters (each a receipt's own: `q` and `category` need not meet on one line), then the page; `total`
    // counts every receipt they all match.
    expect(await refsOf('category=needs-review&channel=online')).toEqual([refs.K5]);
    expect(await refsOf('category=needs-review&channel=warehouse,gas')).toEqual([refs.K3, refs.K2]);
    expect(await refsOf(`category=needs-review&membership=${refs.B}`)).toEqual([refs.K5]);
    expect(await refsOf(`category=needs-review&membership=${refs.A}`)).toEqual([refs.K3, refs.K2]);
    expect(await refsOf('category=automotive&channel=warehouse')).toEqual([]);
    expect(await refsOf('category=groceries&q=gadget')).toEqual([]);
    const searched = await page('category=household&q=widget');
    expect(searched.receipts.map((row) => [row.receiptRef, (row.matchingLines ?? []).map((line) => line.itemNumber)]))
      .toEqual([[refs.K3, ['100120']], [refs.K2, ['100110', '100111', '100112']]]);
    expect(await refsOf('category=household&q=gadget')).toEqual([refs.K3]);
    const paged = async (query: string) => {
      const body = await page(query);
      return [body.total, body.offset, body.limit, body.receipts.map((row) => row.receiptRef), body.receipts.map((row) => row.matchingLines)];
    };
    expect(await paged('category=needs-review&offset=1&limit=1')).toEqual([3, 1, 1, [refs.K3], [null]]);
    expect(await paged('category=needs-review&limit=1&offset=2')).toEqual([3, 2, 1, [refs.K2], [null]]);
    expect(await paged('category=needs-review&offset=3')).toEqual([3, 3, 50, [], []]);
    expect(await paged(`category=household&membership=${refs.A}&channel=warehouse&q=widget&limit=1`))
      .toEqual([2, 0, 1, [refs.K3], [[expect.objectContaining({ itemNumber: '100120' })]]]);

    // Every node of the tree is a category the list takes (none reads as card data), and keeps exactly the receipts whose
    // detail files an item, fee or fuel line under it, in the list's order.
    const details = new Map<string, Array<RetailApiLineCategory | null>>();
    for (const ref of order) details.set(ref, await categories(w, ref));
    const kept: string[] = [];
    for (const node of ITEM_TAXONOMY_V2_VIEW.nodes) {
      const expected = order.filter((ref) => details.get(ref)!.some((line) => filedUnder(line, node.id)));
      expect(await refsOf(`category=${encodeURIComponent(node.id)}&limit=100`), node.id).toEqual(expected);
      if (expected.length > 0) kept.push(node.id);
    }
    expect(kept.sort()).toEqual(expectations.filter(([, expected]) => expected.length > 0).map(([node]) => node).sort());
  });
});

describe('the Costco receipts read API\'s modules', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = (file: string) => fs.readFileSync(path.join(here, file), 'utf8');
  const imports = (text: string) => [...text.matchAll(/^import\s[^;]*?from\s*'([^']+)';/gm)].map((match) => match[1]);

  it('imports no writer, no CLI and no converter: the read check, the taxonomy\'s resolver, the shared contract and item tree, and Spending\'s query helpers and title guard only', () => {
    expect(imports(source('retail.ts'))).toEqual([
      'better-sqlite3', 'express', '@finance-tracker/shared', '@finance-tracker/shared/retail-api', '../ingress/expressIdentity.js',
      '../services/retail/common.js', '../services/retail/schema.js', '../services/retailRead/receipts.js', '../services/sqliteStateRepo.js',
      './cardSpending.js', './cardTransactions.js',
    ]);
    expect(imports(source('../services/retailRead/receipts.ts'))).toEqual([
      'better-sqlite3', '@finance-tracker/shared', '@finance-tracker/shared/retail-api', '../../routes/cardTransactions.js',
      '../retail/taxonomyResolver.js',
    ]);
  });

  it('pins the contract\'s category sources and line kinds to the retail taxonomy\'s own lists (Q-D1)', () => {
    expect(RETAIL_API_CATEGORY_SOURCES).toEqual(RETAIL_LINE_TAXONOMY_SOURCES);
    expect(RETAIL_API_CATEGORY_LINE_KINDS).toEqual(RETAIL_TAXONOMY_LINE_KINDS);
  });

  it('holds no write, no schema change and no sum in its SQL, and reads nothing at construction', () => {
    for (const file of ['retail.ts', '../services/retailRead/receipts.ts']) {
      const text = source(file);
      expect(text, file).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM)\b/);
      expect(text, file).not.toMatch(/\.(?:run|exec|pragma|immediate|exclusive)\(/);
      expect(text, file).not.toMatch(/\b(?:sum|total|avg)\s*\(/i);
      expect(text, file).not.toMatch(/convert/i);
    }
    let reached = 0;
    createRetailRouter({
      internalGetDb: () => {
        reached += 1;
        throw new Error('the database was reached');
      },
    });
    expect(reached).toBe(0);
  });
});
