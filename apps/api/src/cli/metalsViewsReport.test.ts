import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import request from 'supertest';

import type { CheckingImportPayload } from '@finance-tracker/shared';
import { METALS, type Metal, type MetalsEvent, type MetalsImportPayload, type MetalsOrder } from '@finance-tracker/shared/metals-ledger';
import {
  delivered,
  inStore,
  metalItem,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
} from '@finance-tracker/shared/metals-ledger-fixtures';
import type { MetalsCardCheck, MetalsOverview, MetalsPurchases, MetalsSales, MetalsTimeline } from '@finance-tracker/shared/metals-api';

import { createApp } from '../app.js';
import { ADMINISTRATORS_SID, readCurrentUserSid, readWindowsAcls, restrictToUser, SYSTEM_SID, system32, type WindowsAcl } from '../e2e/windowsAcl.js';
import { digest } from '../services/amazon/policy.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import {
  METALS_SCHEMA_DIGEST,
  MetalsRefusal,
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
import { MetalsCardCheckState } from '../services/metalsRead/cardCheck.js';
import { MetalsCorrectionUnsupported, MetalsReadModel, MetalsSchemaClosed } from '../services/metalsRead/source.js';
import { MetalsViews } from '../services/metalsRead/views.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { METALS_CLI_USAGE, runMetalsCli } from './metals.js';
import {
  METALS_VIEWS_REPORT_CODE,
  METALS_VIEWS_REPORT_COMMAND,
  METALS_VIEWS_REPORT_FORMAT,
  formatMetalsViewsReport,
  metalsViewsReport,
  renderMetalsViewsReport,
  type MetalsViewsReportLine,
} from './metalsViewsReport.js';
import { withReadOnlyDatabase } from './operatorIo.js';
import { ownerOnlyAcl, platformOutputAccess, type OutputAccess } from './ownerOnlyOutput.js';

// Synthetic only: invented orders, titles, amounts, last 4s, closes and GO ids, on scratch databases this build made,
// through the real install and import (G2), the real card and checking importers, and the real app (createApp).

/** Wednesday, 2030-03-20 in New York. */
const NOW = new Date('2030-03-20T16:00:00.000Z');
const TODAY = '2030-03-20';
const IMPORTED_AT = '2030-03-20T12:00:00.000Z';
const DATABASE_REF = 'c'.repeat(64);
const TOKEN = '7c'.repeat(32);
const BAR_TITLE = 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999';
/** The synthetic values that must never reach the line: amounts, last 4s, labels, titles, keys and dates but today's. */
const VALUES = /200000|400000|205000|210000|213000|215000|240000|30000|1111|2222|3333|Walmart account|CollectPure account|Costco membership|Sample|walmart|collectpure|costco|mtl-|2029-|2030-0[12]-|2030-03-(?!20)/;

const BASE_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD', 'HOLDR_CONFIG'].includes(name)));
const DISPOSABLE = { ...BASE_ENV, HOLDR_CONFIG: 'none' };
/** A synthetic SID and a stand-in Windows ACL reader for the output's place: owner-only unless a test adds an entry. */
const USER_SID = 'S-synthetic-owner';
const USERS_SID = 'S-1-5-32-545';
const standIn = (extra: WindowsAcl['aces'] = []): OutputAccess => ({
  platform: 'win32', currentUserSid: () => USER_SID,
  readAcls: (paths) => paths.map(() => {
    const aces: WindowsAcl['aces'] = [{ sid: USER_SID, rights: 0x1f01ff, type: 'Allow' }, { sid: SYSTEM_SID, rights: 0x1f01ff, type: 'Allow' },
      { sid: ADMINISTRATORS_SID, rights: 0x1f01ff, type: 'Allow' }, ...extra];
    return { owner: USER_SID, aces, aceTypes: aces.map((ace) => (ace.type === 'Allow' ? 'AccessAllowed' : 'AccessDenied')) };
  }),
});
const OWNER_ONLY = standIn();

let dir: string;
let file: string;
let repo: SqliteStateRepo;
let stdout: string;
let stderr: string;
let imports: number;
/**
 * What a catch on a report test's path turned into data, observed only (the lane's kill-kit witness reads it; no test
 * asserts on it, and observing changes no outcome): each snapshot refusal the allowlist below takes by its class
 * (MetalsSchemaClosed, MetalsCorrectionUnsupported, by name), each line G2's catch-all prints
 * (`holdr-metals: operation-failed <type> [code]`, as `<type> [code]`), and each view a report or a line records as
 * failed (`view-failed`, the report's own catch). Emptied before every test.
 */
const witnessed: string[] = [];
const CATCH_ALL = 'holdr-metals: operation-failed ';
const observeCatchAll = (text: string) => {
  for (const line of text.split('\n')) if (line.startsWith(CATCH_ALL)) witnessed.push(line.slice(CATCH_ALL.length));
};
const observeViews = (text: string) => {
  witnessed.push(...(text.match(/"failed":"view-failed"/g) ?? []).map(() => 'view-failed'));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-views-report-'));
  file = path.join(dir, 'finance.db');
  repo = new SqliteStateRepo({ file });
  stdout = '';
  stderr = '';
  imports = 0;
  witnessed.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const db = () => repo.internalGetDb();
const at = (name: string) => path.join(dir, name);
const sha256 = (target: string) => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const run = (args: string[], env: NodeJS.ProcessEnv = DISPOSABLE, outputAccess: OutputAccess = OWNER_ONLY) => runMetalsCli(args, {
  env, now: () => NOW, outputAccess,
  io: { stdout: { write: (s: string) => { stdout += s; observeViews(s); } }, stderr: { write: (s: string) => { stderr += s; observeCatchAll(s); } } },
});
const viewsReport = (out = at('views.json'), env: NodeJS.ProcessEnv = DISPOSABLE, outputAccess: OutputAccess = OWNER_ONLY) =>
  run([METALS_VIEWS_REPORT_COMMAND, '--db', file, '--out', out], env, outputAccess);
/** The report through the module, on the read-only `query_only` handle the command reads with (its failed views observed). */
const report = (now = NOW) => {
  const built = withReadOnlyDatabase(file, (handle) => metalsViewsReport(handle, { now, databaseRef: DATABASE_REF }));
  observeViews(JSON.stringify(built?.summary ?? null) ?? '');
  return built;
};
/** A line already asserted non-null in the test's own body, parsed. */
const lineOf = (text: string | null) => JSON.parse(text ?? 'null') as MetalsViewsReportLine;
/**
 * An answer with its snapshot token set aside. The token hashes the reading connection's own data version (its
 * `total_changes()` included), so the API's connection and the report's read-only one never share it: compared apart.
 */
const setAside = (answer: unknown): unknown => {
  if (answer === null || typeof answer !== 'object') return answer;
  const entry = answer as { snapshot?: unknown; coverageProof?: Record<string, unknown> };
  if (entry.coverageProof !== undefined) return { ...entry, coverageProof: { ...entry.coverageProof, snapshot: 'set aside' } };
  return entry.snapshot === undefined ? answer : { ...entry, snapshot: 'set aside' };
};
/** A refusal's printed line, as the command prints it. */
const refusalLine = (code: string) => `${JSON.stringify({ code })}\n`;
/** The command's line for a report that passed: its code first, no failure last. */
const PASSED = new RegExp(`^\\{"code":"${METALS_VIEWS_REPORT_CODE}",[^\\n]*,"failures":\\[\\]\\}\\n$`);
/**
 * What `fn` threw, as data, for its declared errors only (a per-kill allowlist, kill standard §9a and 3(e)): a
 * MetalsRefusal by its code, and A0's two snapshot refusals by their class, name and constant message (the literals at
 * their constructors in source.ts), each observed by name. Anything else is re-thrown unchanged; no throw at all is
 * 'not refused'.
 */
const refusalOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof MetalsRefusal) return error.code;
    if (error instanceof MetalsSchemaClosed && error.name === 'MetalsSchemaClosed' && error.message === 'schema-closed') {
      witnessed.push(error.name);
      return error.name;
    }
    if (error instanceof MetalsCorrectionUnsupported && error.name === 'MetalsCorrectionUnsupported' && error.message === 'correction-unsupported') {
      witnessed.push(error.name);
      return error.name;
    }
    throw error;
  }
  return 'not refused';
};

// ---------------------------------------------------------------------------
// Synthetic ledger
// ---------------------------------------------------------------------------

const agreed = (date: string): MetalsEvent => ({ kind: 'agreed', date, dateBasis: 'stated', quantity: 1, occurrence: 1 });

/** A Walmart order of 1 ozt gold bars (fine by stated mass), one card, delivered four days later. */
function walmartBar(id: number, date: string, quantity = 1): MetalsOrder {
  const amount = 200000 * quantity;
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
      pack: 'single', purity: null, massBasis: 'fine', design: null, quantity, unitPriceMinor: 200000,
      events: [delivered(quantity, addDays(date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}

/** A Walmart order of one 10 ozt silver bar. */
function walmartSilver(id: number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 30000)],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 30000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 30000,
    },
    lines: [{
      ordinal: 0, title: 'Sample Refinery 10 ozt Silver Bar FINE SILVER .999', productRef: 'walmart:200001', metal: 'XAG', form: 'bar',
      statedMass: { value: '10', unit: 'ozt' }, pack: 'single', purity: null, massBasis: 'fine', design: null,
      quantity: 1, unitPriceMinor: 30000, events: [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}

/** A Costco warehouse receipt of one bare-"oz" gold bar: its content is unknown until the owner confirms it. */
function costcoReceipt(id: string, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'warehouse', id, date,
    skeleton: [metalItem(0, 205000, { taxFlag: 'non-taxable' })],
    admission: {
      fulfilment: 'in-store', methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 205000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 205000,
    },
    lines: [{
      ordinal: 0, title: '1 OZ GOLD BAR SAMPLE PAMP', productRef: 'costco:300001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'oz' },
      pack: 'single', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: null, events: [inStore(1, date)],
    }],
  });
}

/** A CollectPure sale of one 1 ozt gold bar ($2,100.00, a $20.00 fee, $30.00 insured shipping), paid out in full. */
function barSale(id: number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 210000)],
    components: [{ kind: 'platform-fee', amountMinor: -2000 }, { kind: 'insured-shipping', amountMinor: -3000 }],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 205000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: null, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000,
      events: [agreed(date)], sale: { program: 'Sell to Dealer', premium: null, inspection: 'passed' },
    }],
  });
}

/** A CollectPure sale of one 1 oz gold Eagle coin (by coin specification), which no recorded purchase matches. */
function coinSale(id: number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 215000)],
    components: [{ kind: 'platform-fee', amountMinor: -2000 }],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 213000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'collectpure:SKU-EAGLE', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1, unitPriceMinor: 215000,
      events: [agreed(date)],
    }],
  });
}

/** A CollectPure sale of a gold bar whose weight isn't stated: its content is unknown. */
function unconfirmedSale(id: number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 205000)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 205000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: 'Sample Refinery Gold Bullion Bar', productRef: 'collectpure:SKU-BARX', metal: 'XAU', form: 'bar', statedMass: null,
      pack: 'single', purity: null, massBasis: 'unknown', design: null, quantity: 1, unitPriceMinor: 205000, events: [agreed(date)],
    }],
  });
}

/** A CollectPure sale of a 1 ozt gold bar, cancelled: it realized nothing and paid nothing out. */
function cancelledSale(id: number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'cancelled',
    skeleton: [metalItem(0, 210000)],
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: null, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000,
      events: [agreed(date)],
    }],
  });
}

/** A CollectPure sale of a 1 ozt gold bar and a 10 ozt silver bar in one order, paid out in full: its payout is no one metal's. */
function mixedSale(id: number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 210000), metalItem(1, 30000)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 240000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [
      { ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' }, pack: 'single',
        purity: null, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000, events: [agreed(date)] },
      { ordinal: 1, title: 'Sample Refinery 10 ozt Silver Bar FINE SILVER .999', productRef: 'collectpure:SKU-AG10', metal: 'XAG', form: 'bar',
        statedMass: { value: '10', unit: 'ozt' }, pack: 'single', purity: null, massBasis: 'fine', design: null,
        quantity: 1, unitPriceMinor: 30000, events: [agreed(date)] },
    ],
  });
}

const W1 = walmartBar(1, '2030-01-10');
const W3 = walmartBar(3, '2030-02-15', 2);
const WS = walmartSilver(5, '2030-01-20');
const K1 = costcoReceipt('r1', '2030-02-10');
const C1 = barSale(1, '2030-02-03');
const C2 = coinSale(2, '2030-02-20');
const C3 = unconfirmedSale(3, '2030-03-01');
const C4 = cancelledSale(4, '2030-03-05');
const C5 = mixedSale(5, '2030-03-10');

const walmartPayload = (orders: MetalsOrder[]) => syntheticPayload('walmart', { orders, coverage: [syntheticCoverage('online', '2029-01-01', TODAY, 9, 9)] });
const collectpurePayload = (orders: MetalsOrder[]) => syntheticPayload('collectpure', {
  orders, coverage: [syntheticCoverage('sell-orders', '2029-01-01', TODAY, 9, 9), syntheticCoverage('payouts', '2029-01-01', TODAY, 9, 9)],
});
const costcoPayload = (orders: MetalsOrder[]) => syntheticPayload('costco', {
  orders, coverage: [syntheticCoverage('online', '2029-01-01', TODAY, 9, 9), syntheticCoverage('warehouse', '2029-01-01', TODAY, 9, 9)],
});

/** Imports a payload through G2's real importer, planning and writing in one step, under a synthetic GO. */
function importPayload(payload: MetalsImportPayload, account: MetalsAccountChoice): string {
  const now = new Date(Date.parse(IMPORTED_AT) + (imports++) * 60_000).toISOString();
  const receipt = importMetalsPayload(db(), { payload, account },
    { now, goId: randomBytes(16).toString('hex'), purpose: 'copy-rehearsal', inputSha256: metalsPayloadSha256(payload), planDigest: null });
  expect(receipt.code).toBe('metals-imported');
  return receipt.accountId!;
}

const cardRow = (patch: Partial<CardImportRow>): CardImportRow => ({
  transactionDate: '2030-01-11', postedDate: null, status: 'posted', amountMinor: 0, currency: 'USD', kind: 'purchase',
  description: 'WALMART.COM SAMPLE', merchant: null, issuerCategory: null, ...patch,
});

function approve(pairs: MetalsBindingPair[]): void {
  const { proposal } = proposeMetalsBindings(db(), DATABASE_REF);
  approveMetalsBindings(db(), proposal, { proposalSha256: sha256Hex(serializeMetalsBindingProposal(proposal)), inventoryDigest: proposal.inventoryDigest, pairs },
    { now: IMPORTED_AT, goId: randomBytes(16).toString('hex'), purpose: 'copy-rehearsal', planDigest: null, databaseRef: DATABASE_REF });
}

/** Daily closes of a metal on every weekday from `from` to `to`, as the price store keeps them. */
function seedCloses(metal: Metal, from: string, to: string, close: number): void {
  const insert = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'daily', ?, ?, 'cnbc-spot-daily')`);
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) insert.run(`holdr:metal:${metal}`, date, close);
  }
}

/**
 * The ledger: Walmart gold bars (one in January, two in February) and a silver bar; a Costco warehouse bar of unknown content;
 * CollectPure sales of a gold bar (matched), an Eagle coin (no purchase), a bar of unknown content, a cancelled bar and a
 * gold-and-silver order. Card charges and a dealer credit, bound; gold closes, no silver ones.
 */
function seedLedger(): void {
  installMetalsSchema(db());
  importPayload(walmartPayload([W1, W3, WS]), { label: 'Walmart account' });
  importPayload(collectpurePayload([C1, C2, C3, C4, C5]), { label: 'CollectPure account' });
  importPayload(costcoPayload([K1]), { label: 'Costco membership' });
  const visa = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', nickname: 'Sample Visa', last4: '1111', currency: 'USD' });
  const costcoCard = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '3333', currency: 'USD' });
  const coverage = { start: '2030-01-01', end: '2030-03-19' };
  repo.importCardTransactions({ cardAccountId: visa.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
    cardRow({ transactionDate: '2030-01-11', amountMinor: 200000 }),
    cardRow({ transactionDate: '2030-02-16', amountMinor: 400000 }),
  ] });
  repo.importCardTransactions({ cardAccountId: costcoCard.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
    cardRow({ transactionDate: '2030-02-10', amountMinor: 205000, description: 'COSTCO WHSE #0001 SAMPLETOWN WA' }),
  ] });
  installCheckingSchema(db());
  const checking: CheckingImportPayload = {
    format: 'holdr.checking-import', version: 1, parserVersion: 'holdr-checking-import@1.0.0',
    account: { institution: 'wellsfargo', type: 'checking', last4: '2222', label: 'Sample Bank Everyday Checking', currency: 'USD' },
    segments: [{
      source: 'ofx', coverage: { start: '2030-01-01', end: '2030-03-19' }, anchors: [],
      rows: [{ postedDate: '2030-02-07', amountMinor: 205000, description: 'SAMPLE DEALER ACH CREDIT', checkNumber: null, bankType: 'CREDIT', externalIdHash: null }],
    }],
  };
  importCheckingPayload(db(), checking, { now: IMPORTED_AT, goId: 'c'.repeat(32), purpose: 'copy-rehearsal' });
  approve([
    { kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: visa.id },
    { kind: 'card', source: 'costco', network: 'visa', last4: '3333', accountId: costcoCard.id },
    { kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: db().prepare('SELECT id FROM checking_accounts').pluck().get() as string },
  ]);
  seedCloses('XAU', '2029-12-01', '2030-03-19', 2000);
}

/**
 * The card check's diagnostic rows (as routes/metalsCardCheck.test.ts seeds them) on the seed's Visa: a dealer no source
 * captures, an unresolved processor, a Walmart and a Costco online charge no captured order explains, a credit at the
 * dealer, and the rows it only counts (a Costco warehouse, a Walmart store sale under an online name, no class at all).
 */
function seedCardDiagnostics(): void {
  const visa = repo.listCardAccounts().find((account) => account.nickname === 'Sample Visa')!;
  repo.importCardTransactions({ cardAccountId: visa.id, source: 'test-sync', parserVersion: 'test@1', rows: [
    cardRow({ transactionDate: '2030-02-20', amountMinor: 410, description: 'SAMPLE BULLION CO' }),
    cardRow({ transactionDate: '2030-02-21', amountMinor: 420, description: 'PM TECHNOLOGIES' }),
    cardRow({ transactionDate: '2030-03-01', amountMinor: 430, description: 'WALMART.COM SAMPLE' }),
    cardRow({ transactionDate: '2030-03-02', amountMinor: 440, description: 'COSTCO.COM SAMPLE' }),
    cardRow({ transactionDate: '2030-03-03', amountMinor: 450, description: 'COSTCO WHSE SAMPLETOWN WA' }),
    cardRow({ transactionDate: '2030-03-04', amountMinor: 460, merchant: 'WALMART.COM', description: 'WALMART SAMPLETOWN WA' }),
    cardRow({ transactionDate: '2030-03-05', amountMinor: 470, description: 'SAMPLE COFFEE' }),
    cardRow({ transactionDate: '2030-02-25', amountMinor: -410, kind: 'refund', description: 'SAMPLE BULLION CO' }),
  ] });
}

/** The quarantine marker exactly as corrections r6 §1's template, with the given reason. */
const marker = (reason: string) => `CREATE VIEW metals_quarantine AS SELECT '${reason}' AS reason, '${'d'.repeat(32)}' AS go_id, `
  + `'${NOW.toISOString()}' AS since, '' AS ref, '${'e'.repeat(32)}' AS nonce`;
const QUARANTINE_REASONS = ['upgrade-unconfirmed', 'import-wrong-account', 'import-wrong-payload', 'capture-contradiction', 'owner-reported-error'];

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe('metals views report: every view of every metal, one snapshot, read-only', () => {
  it('reports each view value-free, with the identities holding, and the file holding the full answers', () => {
    seedLedger();
    const built = report();
    const rendered = renderMetalsViewsReport(built);
    expect(rendered.failed).toBe(false);
    expect(rendered.line).not.toBeNull();
    expect(rendered.line!.endsWith('\n')).toBe(true);
    expect(rendered.line!.split('\n')).toHaveLength(2);
    const line = lineOf(rendered.line!);
    expect(line).toMatchObject({ code: METALS_VIEWS_REPORT_CODE, schemaDigest: METALS_SCHEMA_DIGEST, today: TODAY, outSha256: sha256Hex(rendered.file),
      identities: { classes: { holds: 3, fails: 0 }, metals: { holds: 4, fails: 0 } }, failures: [] });
    expect(Object.keys(line.metals)).toEqual([...METALS]);
    // Value-free: no amount, last 4, label, title, key or other date; no run of digits outside the two digests.
    const text = rendered.line!.replace(line.outSha256, '').replace(METALS_SCHEMA_DIGEST, '');
    expect(text).not.toMatch(VALUES);
    expect(text).not.toMatch(/[0-9]{5,}/);

    const gold = line.metals.XAU as Record<string, Record<string, unknown>>;
    expect(gold.purchases).toMatchObject({ lots: 3, units: { ordered: 4, cancelled: 0, returned: 0, delivered: 4, awaiting: 0 },
      content: { known: 2, unknown: 1, bases: { 'stated-mass-basis': 2 } }, cards: { count: 3, proofs: 3, states: { linked: 3 } }, assignedSales: 2 });
    expect(gold.sales).toMatchObject({ lines: 5, status: { complete: 4, cancelled: 1 }, content: { known: 4, unknown: 1 },
      units: { quantity: 5, matched: 2, unmatched: 1 }, unmatched: { 'no-recorded-purchase': 1 }, known: 2, cycles: 2 });
    // Prices off, the default (ROOT O110): no stored close values anything, though gold's are stored, so gold's held bar is
    // valued at no price.
    expect(gold.overview).toMatchObject({ holdings: { units: { delivered: 3, awaiting: 0, sold: 3, soldFromDelivered: 2, soldFromAwaiting: 0, unmatched: 1,
      held: 1, awaitingUnassigned: 0 }, classes: { count: 2, unbalanced: 1 }, contentUnknown: { lots: 1, units: 1, sales: 1 },
      valueMinor: { state: 'unknown', reasons: { 'price-missing': 1 } } },
      price: { close: false, stale: false, thinHistory: false, levelShift: false, fetching: false } });
    // A measure's reasons with their record counts (two records of one code), and a list's measures tallied by state.
    expect((gold.overview.holdings as Record<string, unknown> | undefined)?.troyOz).toEqual({ state: 'partial', reasons: { 'content-unknown': 2, 'unmatched-sales': 1 } });
    expect(gold.sales.profitMinor).toEqual({ complete: 2, partial: 1, unknown: 2, reasons: { 'content-unknown': 3, 'unmatched-sales': 1 } });
    expect(gold.timeline).toMatchObject({ months: 3, recorded: 3 });
    // Every admissible stored close: the 77 weekday closes before today (the file holds their dates and closes).
    expect(gold.closes).toEqual({ count: 77 });
    const toCheck = gold.overview.toCheck as { needsYou: unknown; forInformation: unknown } | undefined;
    expect([toCheck?.needsYou, toCheck?.forInformation]).toEqual([{ 'confirm-content': 1 }, { 'unmatched-sales': 1, 'deposit-not-linked': 1 }]);
    expect(line.funding).toMatchObject({ purchases: { count: 4, allMetal: 4, cards: { count: 4, proofs: 3 }, receiptCharges: 3 },
      sales: { count: 5, payouts: { count: 4 } } });
    // The card check by count alone: Walmart's two captured charges explained, Costco's warehouse row only counted. No
    // roster answer can exist yet, so the proof keeps every scope with a need incomplete, with named gaps.
    expect(line.cardCheck).toEqual({
      rows: {
        'gold-only': { explained: 0, 'possible-aggregate': 0, held: 0, 'outside-coverage': 0, 'no-capture-match': 0, credits: 0 },
        'mixed-online': { explained: 2, 'possible-aggregate': 0, held: 0, 'outside-coverage': 0, 'no-capture-match': 0, credits: 0 },
      },
      outOfScope: { warehouse: 1, samsClub: 0, store: 0, unclassed: 0 },
      unchecked: {},
      cardHistory: { accounts: 2 },
      exemptions: { current: 0, stale: 0 },
    });
    expect(line.coverageProof).toMatchObject({ roster: { state: 'not-installed' }, asOf: { state: 'incomplete', gaps: { roster: 1, 'unproven-prefix': 1 } } });
    // Silver proves it holds nothing (all sold, none on the way, its ounces known): valued at 0, known, with no price.
    expect((line.metals.XAG as Record<string, Record<string, unknown>>).overview).toMatchObject({
      holdings: { units: { delivered: 1, sold: 1, held: 0 }, classes: { count: 1, unbalanced: 0 }, troyOz: { state: 'complete', reasons: {} },
        valueMinor: { state: 'complete', reasons: {} } },
      price: { close: false } });
    expect((line.metals.XAG as Record<string, unknown>).closes).toEqual({ count: 0 });
    expect(line.metals.XPT).toMatchObject({ purchases: { lots: 0 }, sales: { lines: 0 }, products: { products: 0 } });

    // The file: every view's full answer and each identity's terms.
    const document = JSON.parse(rendered.file) as Record<string, unknown> & { metals: Record<Metal, Record<string, unknown>>; identities: Record<Metal, unknown> };
    expect(document).toMatchObject({ format: METALS_VIEWS_REPORT_FORMAT, version: 1, today: TODAY, schemaDigest: METALS_SCHEMA_DIGEST,
      databaseRef: DATABASE_REF, failures: [] });
    expect((document.metals.XAU.purchases as Partial<MetalsPurchases>).purchases?.map((entry) => entry.orderKey).sort()).toEqual([W1.key, W3.key, K1.key].sort());
    expect(document.identities.XAU).toEqual({
      classes: [
        { key: 'XAU|bar|1/1', delivered: 3, awaiting: 0, held: 1, awaitingUnassigned: 0, sold: 2, unmatched: 0, holds: true },
        { key: 'XAU|coin|1/1', delivered: 0, awaiting: 0, held: 0, awaitingUnassigned: 0, sold: 1, unmatched: 1, holds: true },
      ],
      nets: { saleNets: 833000, cycleNets: 415000, unmatchedNets: 213000, contentUnknownNets: 205000, holds: true },
    });
    expect(document.identities.XAG).toEqual({
      classes: [{ key: 'XAG|bar|10/1', delivered: 1, awaiting: 0, held: 0, awaitingUnassigned: 0, sold: 1, unmatched: 0, holds: true }],
      nets: { saleNets: 30000, cycleNets: 30000, unmatchedNets: 0, contentUnknownNets: 0, holds: true },
    });
    expect(document.identities.XPD).toEqual({ classes: [], nets: { saleNets: 0, cycleNets: 0, unmatchedNets: 0, contentUnknownNets: 0, holds: true } });
  });

  it('reads today as New York\'s day, not the UTC one', () => {
    seedLedger();
    // 03:30Z on 2030-03-21 is still 2030-03-20 in New York (daylight time, UTC-4).
    const rendered = renderMetalsViewsReport(report(new Date('2030-03-21T03:30:00.000Z')));
    expect(rendered.line).not.toBeNull();
    expect(lineOf(rendered.line).today).toBe(TODAY);
  });

  it('holds exactly the answers the API serves the Gold page, view by view, with their defaults', async () => {
    seedLedger();
    const document = JSON.parse(renderMetalsViewsReport(report()).file) as { metals: Record<Metal, Record<string, unknown>>; funding: unknown;
      cardCheck: unknown };
    const { app } = createApp({ repo, serviceToken: TOKEN, allowedOrigins: ['http://127.0.0.1:5173'], snapshotsEnabled: false,
      scryptParams: { ln: 10, r: 8, p: 1 }, now: () => NOW, log: () => undefined });
    const served = async (url: string) => {
      const res = await request(await listenLoopback(app)).get(url).set('Authorization', ['Bearer', TOKEN].join(' '));
      expect([url, res.status]).toEqual([url, 200]);
      return res.body as unknown;
    };
    for (const metal of METALS) {
      for (const view of ['overview', 'purchases', 'sales', 'timeline', 'products', 'closes']) {
        expect([metal, view, setAside(document.metals[metal][view])]).toEqual([metal, view, setAside(await served(`/metals/${view}?metal=${metal}`))]);
      }
    }
    expect(document.funding).toEqual(await served('/metals/funding'));
    expect(setAside(document.cardCheck)).toEqual(setAside(await served('/metals/card-check')));
    // One snapshot: every overview's proof and the card check carry the one token of the report's own read.
    const tokens = [...METALS.map((metal) => (document.metals[metal].overview as Partial<MetalsOverview>).coverageProof?.snapshot),
      (document.cardCheck as MetalsCardCheck).snapshot];
    expect([new Set(tokens).size, /^[a-p]{64}$/.test(tokens[0] ?? '')]).toEqual([1, true]);
  });

  it('counts the card check and its coverage proof with nothing named: rows per scope and status, credits, gaps per variant', () => {
    seedLedger();
    seedCardDiagnostics();
    const rendered = renderMetalsViewsReport(report());
    expect(rendered.line).not.toBeNull();
    const line = lineOf(rendered.line);
    // Walmart's two captured charges explained; the dealer's charge outside coverage and its credit listed; the processor
    // held; a Walmart and a Costco online charge no captured order explains (both sources' captures cover their days);
    // three rows only counted.
    expect(line.cardCheck).toEqual({
      rows: {
        'gold-only': { explained: 0, 'possible-aggregate': 0, held: 1, 'outside-coverage': 1, 'no-capture-match': 0, credits: 1 },
        'mixed-online': { explained: 2, 'possible-aggregate': 0, held: 0, 'outside-coverage': 0, 'no-capture-match': 2, credits: 0 },
      },
      outOfScope: { warehouse: 2, samsClub: 0, store: 1, unclassed: 1 },
      unchecked: {},
      cardHistory: { accounts: 2 },
      exemptions: { current: 0, stale: 0 },
    });
    // No roster answer can exist yet, so every scope with a need is incomplete with named gaps, counted per variant; the
    // whole summary, so every count the line holds is checked.
    expect(line.coverageProof).toEqual({
      roster: { state: 'not-installed', problems: {}, bindings: {} },
      asOf: { state: 'incomplete', gaps: { 'imported-window': 3, 'unsupported-dealer': 1, 'alias-unresolved': 1, 'unexplained-charges': 2, roster: 1,
        'unproven-prefix': 1 } },
      sales: {
        XAU: { state: 'incomplete', gaps: { 'imported-window': 3, 'unsupported-dealer': 1, 'alias-unresolved': 1, 'unexplained-charges': 2, roster: 1,
          'unproven-prefix': 1 } },
        XAG: { state: 'incomplete', gaps: { 'imported-window': 3, 'unsupported-dealer': 1, 'alias-unresolved': 1, 'unexplained-charges': 2, roster: 1,
          'unproven-prefix': 1 } },
      },
      totals: { realized: { state: 'incomplete', metals: { XAU: 1, XAG: 1 } }, estimate: { state: 'incomplete', metals: { XAU: 1, XAG: 1 } },
        metalUnknown: { lots: 0, saleLines: 0 } },
      limits: { 'card-check-only': 1, 'non-card-funding': 1, 'stored-value-only': 1, 'warehouse-and-store': 1, 'cards-not-in-holdr': 1,
        'undiscovered-dealers': 1, 'card-history': 1 },
    });
    // Value-free: no group, merchant, amount, date or id, and no digest but the two. The line's own key `outSha256` holds
    // the one run of three digits that names no value, so it is set aside with the digests and today.
    const text = rendered.line!.replace(line.outSha256, '').replace(METALS_SCHEMA_DIGEST, '').replace(TODAY, '').replace('"outSha256"', '');
    expect(text).not.toMatch(VALUES);
    expect(text).not.toMatch(/BULLION|TECHNOLOGIES|COFFEE|SAMPLE|dealer:|merchant:|unresolved:|[0-9]{3,}/);
    expect(line.failures).toEqual([]);
  });

  it('fails when the card check can\'t be computed, while every overview answers with its unavailable proof', () => {
    seedLedger();
    const ledgerSnapshot = MetalsReadModel.prototype.ledgerSnapshot;
    vi.spyOn(MetalsReadModel.prototype, 'ledgerSnapshot').mockImplementation(function (this: MetalsReadModel) {
      return { ...ledgerSnapshot.call(this), check: { failed: 'SqliteError SQLITE_IOERR' } };
    });
    const rendered = renderMetalsViewsReport(report());
    expect(rendered.line).not.toBeNull();
    const line = lineOf(rendered.line);
    expect(line.failures).toEqual(['view-failed', 'card-check-failed']);
    expect(line.cardCheck).toEqual({ failed: 'view-failed' });
    expect(line.coverageProof).toMatchObject({ roster: { state: 'not-installed' }, asOf: { state: 'unavailable', gaps: { 'card-check-unavailable': 1 } },
      totals: { realized: { state: 'unavailable' }, estimate: { state: 'unavailable' } } });
    for (const metal of METALS) expect([metal, line.metals[metal].overview]).toEqual([metal, expect.objectContaining({ holdings: expect.any(Object) })]);
    const document = JSON.parse(rendered.file) as { metals: Record<Metal, Record<string, unknown>>; cardCheck: unknown; cardCheckFailures: unknown;
      failures: unknown };
    expect(document.cardCheck).toEqual({ failed: 'view-failed', error: 'MetalsCardCheckUnavailable' });
    // As the API logs it: the reads' failure, by its type and code only, once.
    expect(document.cardCheckFailures).toEqual(['[metals] card check unavailable: reads SqliteError SQLITE_IOERR']);
    expect((document.metals.XAU.overview as Partial<MetalsOverview>).coverageProof?.asOfScope.state).toBe('unavailable');
    expect(document.failures).toEqual(['view-failed', 'card-check-failed']);
    expect(rendered.failed).toBe(true);
  });

  it('counts by the same rules what this build can\'t produce yet: unchecked occurrences, exemptions, roster problems and bindings', () => {
    seedLedger();
    // Patched answers, as the identity tests patch theirs: no roster answer or ambiguous card identity exists in this build.
    const serve = MetalsCardCheckState.prototype.serve;
    vi.spyOn(MetalsCardCheckState.prototype, 'serve').mockImplementation(function (this: MetalsCardCheckState, what: string, build: () => unknown) {
      const answer = serve.call(this, what, build) as MetalsCardCheck;
      for (const group of answer.groups) group.exemption = { key: `source:${group.group}`, claim: 'accounts-complete', state: 'stale' };
      answer.unchecked = [{ source: 'walmart', cardNotInHoldr: 1, identityAmbiguous: 2 }, { source: 'costco', cardNotInHoldr: 0, identityAmbiguous: 1 }];
      return answer;
    } as unknown as typeof serve);
    const overviewProof = MetalsCardCheckState.prototype.overviewProof;
    vi.spyOn(MetalsCardCheckState.prototype, 'overviewProof').mockImplementation(function (this: MetalsCardCheckState,
      ...args: Parameters<typeof overviewProof>) {
      const proof = overviewProof.apply(this, args);
      return { ...proof, roster: { ...proof.roster, problems: ['evidence-changed', 'accounts-changed'], bindings: [
        { key: 'source:walmart', claim: 'accounts-complete', rows: 1, state: 'stale' }, { key: 'group:dealer', claim: 'no-metal-purchases', rows: 2, state: 'current' },
      ] }, totals: { realized: { metals: ['XAU', 'XAG'], state: 'complete' }, estimate: { metals: ['XAG'], state: 'incomplete' },
        metalUnknown: { lots: 1, saleLines: 2 } } };
    });
    const rendered = renderMetalsViewsReport(report());
    expect(rendered.line).not.toBeNull();
    const line = lineOf(rendered.line);
    const check = line.cardCheck as unknown as Record<string, unknown>;
    const proof = line.coverageProof as unknown as Record<string, Record<string, unknown> | undefined>;
    expect([check.unchecked, check.exemptions]).toEqual([
      { walmart: { cardNotInHoldr: 1, identityAmbiguous: 2 }, costco: { cardNotInHoldr: 0, identityAmbiguous: 1 } }, { current: 0, stale: 1 }]);
    expect([proof.roster?.problems, proof.roster?.bindings]).toEqual([{ 'accounts-changed': 1, 'evidence-changed': 1 }, { current: 1, stale: 1 }]);
    expect(proof.totals).toEqual({ realized: { state: 'complete', metals: { XAU: 1, XAG: 1 } }, estimate: { state: 'incomplete', metals: { XAG: 1 } },
      metalUnknown: { lots: 1, saleLines: 2 } });
    expect(line.failures).toEqual([]);
  });

  it('starts each default timeline where the route does: at most 240 months back, and never after this month', async () => {
    installMetalsSchema(db());
    // A gold bar first ordered 2009-06 (250 months through 2030-03), and silver ordered only after today.
    importPayload(syntheticPayload('walmart', { orders: [walmartBar(9, '2009-06-15'), walmartSilver(6, '2030-04-15')], coverage: [] }),
      { label: 'Walmart account' });
    const document = JSON.parse(renderMetalsViewsReport(report()).file) as { metals: Record<Metal, Record<string, unknown>> };
    const monthsOf = (metal: Metal) => ((document.metals[metal].timeline as Partial<MetalsTimeline>).months ?? []).map((month) => month.month);
    // Gold: 240 consecutive months through this month (not 250); silver: this month alone (not none).
    const gold = monthsOf('XAU');
    expect([gold.length, gold[gold.length - 1], monthsOf('XAG')]).toEqual([240, TODAY.slice(0, 7), [TODAY.slice(0, 7)]]);
    const { app } = createApp({ repo, serviceToken: TOKEN, allowedOrigins: ['http://127.0.0.1:5173'], snapshotsEnabled: false,
      scryptParams: { ln: 10, r: 8, p: 1 }, now: () => NOW, log: () => undefined });
    const served = async (url: string) => {
      const res = await request(await listenLoopback(app)).get(url).set('Authorization', ['Bearer', TOKEN].join(' '));
      expect([url, res.status]).toEqual([url, 200]);
      return res.body as unknown;
    };
    expect(document.metals.XAU.timeline).toEqual(await served('/metals/timeline?metal=XAU'));
    expect(document.metals.XAG.timeline).toEqual(await served('/metals/timeline?metal=XAG'));
  });

  it('reads one snapshot: a close another connection stores after the snapshot was read is not seen', () => {
    seedLedger();
    const ledgerSnapshot = MetalsReadModel.prototype.ledgerSnapshot;
    vi.spyOn(MetalsReadModel.prototype, 'ledgerSnapshot').mockImplementation(function (this: MetalsReadModel) {
      const read = ledgerSnapshot.call(this);
      db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('holdr:metal:XAG', 'daily', '2030-03-19', 25, 'cnbc-spot-daily')`).run();
      return read;
    });
    const first = renderMetalsViewsReport(report());
    expect(first.line).not.toBeNull();
    expect((lineOf(first.line).metals.XAG as Record<string, unknown>).closes).toEqual({ count: 0 });
    // The close is stored, and a later report reads it.
    vi.restoreAllMocks();
    const later = renderMetalsViewsReport(report());
    expect(later.line).not.toBeNull();
    expect((lineOf(later.line).metals.XAG as Record<string, unknown>).closes).toEqual({ count: 1 });
  });

  it('records a view that throws, by its error\'s type only, and still runs the others: the report fails', () => {
    seedLedger();
    vi.spyOn(MetalsViews.prototype, 'purchases').mockImplementation(() => {
      throw new TypeError('SYNTHETIC-MESSAGE-NEVER-WRITTEN');
    });
    vi.spyOn(MetalsViews.prototype, 'funding').mockImplementation(() => {
      throw new RangeError('SYNTHETIC-MESSAGE-NEVER-WRITTEN');
    });
    const rendered = renderMetalsViewsReport(report());
    expect(rendered.failed).toBe(true);
    expect(rendered.line).not.toBeNull();
    const line = lineOf(rendered.line);
    expect(line.failures).toEqual(['view-failed']);
    for (const metal of METALS) expect(line.metals[metal]).toMatchObject({ purchases: { failed: 'view-failed' }, sales: { lines: expect.any(Number) } });
    expect(line.funding).toEqual({ failed: 'view-failed' });
    expect(line.identities).toEqual({ classes: { holds: 3, fails: 0 }, metals: { holds: 4, fails: 0 } });
    const document = JSON.parse(rendered.file) as { metals: Record<Metal, Record<string, unknown>>; funding: unknown; failures: string[] };
    expect(document.metals.XAU.purchases).toEqual({ failed: 'view-failed', error: 'TypeError' });
    expect(document.funding).toEqual({ failed: 'view-failed', error: 'RangeError' });
    expect(document.failures).toEqual(['view-failed']);
    expect(rendered.file).not.toContain('SYNTHETIC-MESSAGE-NEVER-WRITTEN');
  });

  it('fails a class whose units don\'t conserve, and a metal whose nets don\'t add up, each side alone', () => {
    seedLedger();
    const overview = MetalsViews.prototype.overview;
    const sales = MetalsViews.prototype.sales;
    const cases: Array<{ patch: () => void; failures: string[]; classes: { holds: number; fails: number }; metals: { holds: number; fails: number } }> = [
      // Recorded holdings one unit more than delivered less sold from delivered: the class's right side moves.
      { patch: () => vi.spyOn(MetalsViews.prototype, 'overview').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['overview']>) {
        const answer = overview.apply(this, args);
        if (args[0] === 'XAU' && answer.holdings.classes.length > 0) answer.holdings.classes[0].units.held += 1;
        return answer;
      }), failures: ['class-identity-fails'], classes: { holds: 2, fails: 1 }, metals: { holds: 4, fails: 0 } },
      // One more unit delivered: the class's left side moves.
      { patch: () => vi.spyOn(MetalsViews.prototype, 'overview').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['overview']>) {
        const answer = overview.apply(this, args);
        if (args[0] === 'XAG' && answer.holdings.classes.length > 0) answer.holdings.classes[0].units.delivered += 1;
        return answer;
      }), failures: ['class-identity-fails'], classes: { holds: 2, fails: 1 }, metals: { holds: 4, fails: 0 } },
      // A sale's stated net a cent more than its cycles and unmatched parts: the metal's left side moves.
      { patch: () => vi.spyOn(MetalsViews.prototype, 'sales').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['sales']>) {
        const answer: MetalsSales = sales.apply(this, args);
        if (args[0] === 'XAU' && answer.sales.length > 0) answer.sales[0].netMinor += 1;
        return answer;
      }), failures: ['metal-identity-fails'], classes: { holds: 3, fails: 0 }, metals: { holds: 3, fails: 1 } },
      // A cycle's proceeds a cent more: the metal's right side moves.
      { patch: () => vi.spyOn(MetalsViews.prototype, 'sales').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['sales']>) {
        const answer: MetalsSales = sales.apply(this, args);
        const sale = answer.sales.find((entry) => entry.cycles.length > 0);
        if (args[0] === 'XAG' && sale) sale.cycles[0].proceedsMinor += 1;
        return answer;
      }), failures: ['metal-identity-fails'], classes: { holds: 3, fails: 0 }, metals: { holds: 3, fails: 1 } },
      // The content-unknown nets a cent more, in the overview: the metal's right side moves.
      { patch: () => vi.spyOn(MetalsViews.prototype, 'overview').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['overview']>) {
        const answer = overview.apply(this, args);
        if (args[0] === 'XPT') answer.holdings.contentUnknown.saleNetMinor += 1;
        return answer;
      }), failures: ['metal-identity-fails'], classes: { holds: 3, fails: 0 }, metals: { holds: 3, fails: 1 } },
      // A cancelled sale counted in: its net has no cycle, so the metal fails (cancelled sales are left out of both sides).
      { patch: () => vi.spyOn(MetalsViews.prototype, 'sales').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['sales']>) {
        const answer: MetalsSales = sales.apply(this, args);
        for (const sale of answer.sales) if (sale.status === 'cancelled') sale.status = 'complete';
        return answer;
      }), failures: ['metal-identity-fails'], classes: { holds: 3, fails: 0 }, metals: { holds: 3, fails: 1 } },
    ];
    for (const entry of cases) {
      entry.patch();
      const rendered = renderMetalsViewsReport(report());
      expect(rendered.line).not.toBeNull();
      const line = lineOf(rendered.line);
      expect([rendered.failed, line.failures, line.identities]).toEqual([true, entry.failures, { classes: entry.classes, metals: entry.metals }]);
      vi.restoreAllMocks();
    }
    expect(renderMetalsViewsReport(report()).failed).toBe(false);
  });

  it('reads nothing but a present ledger with no correction: G2\'s gate first, then the tripwire', () => {
    // No tables at all.
    expect(refusalOf(report)).toBe('metals-not-installed');
    seedLedger();
    expect(refusalOf(report)).toBe('not refused');
    // Each quarantine reason (this build reads the marker as another shape; #327 makes it metals-quarantined).
    for (const reason of QUARANTINE_REASONS) {
      db().exec(marker(reason));
      expect([reason, refusalOf(report)]).toEqual([reason, 'metals-conflict']);
      db().exec('DROP VIEW metals_quarantine');
    }
    db().exec('CREATE TABLE metals_stray (x TEXT)');
    expect(refusalOf(report)).toBe('metals-conflict');
    db().exec('DROP TABLE metals_stray');
    // A voided import (voided after it was imported): a correction this build can't read.
    const importId = db().prepare('SELECT import_id FROM metals_imports ORDER BY import_seq DESC LIMIT 1').pluck().get() as string;
    db().prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-payload', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-payload' WHERE import_id = ?`).run('a'.repeat(32), NOW.toISOString(), 'b'.repeat(64), importId);
    expect(refusalOf(report)).toBe('metals-correction-unsupported');
  });
});

describe('metals views report: the value-free line', () => {
  it('refuses anything outside its closed shape', () => {
    seedLedger();
    const built = renderMetalsViewsReport(report());
    expect(built.line).not.toBeNull();
    const base = lineOf(built.line);
    expect(formatMetalsViewsReport(base)).not.toBeNull();
    const refused = (patch: (line: Record<string, unknown>) => void) => {
      const line = structuredClone(base) as unknown as Record<string, unknown>;
      patch(line);
      return formatMetalsViewsReport(line as unknown as MetalsViewsReportLine);
    };
    const gold = (line: Record<string, unknown>) => (line.metals as Record<string, Record<string, Record<string, unknown>>>).XAU;
    expect(refused((line) => { line.code = 'metals-report'; })).toBeNull();
    expect(refused((line) => { line.code = 'complete'; })).toBeNull();
    expect(refused((line) => { line.today = '2030-3-20'; })).toBeNull();
    expect(refused((line) => { line.outSha256 = 'A'.repeat(64); })).toBeNull();
    expect(refused((line) => { line.schemaDigest = 'a'.repeat(63); })).toBeNull();
    expect(refused((line) => { line.failures = ['metal-identity-fails', 'value']; })).toBeNull();
    expect(refused((line) => { line.failures = 'view-failed'; })).toBeNull();
    // A value-shaped key or string: a title, a key, an ounce figure, a date that isn't today's.
    expect(refused((line) => { gold(line).purchases.delivery = { [BAR_TITLE]: 1 }; })).toBeNull();
    expect(refused((line) => { gold(line).purchases.delivery = { [W1.key]: 1 }; })).toBeNull();
    expect(refused((line) => { gold(line).overview.holdings = { troyOz: { state: '1/1', reasons: {} } }; })).toBeNull();
    expect(refused((line) => { gold(line).overview.price = { close: '2030-03-19' }; })).toBeNull();
    // A number that isn't a count: cents past the bound, negative, a fraction; a null; a list.
    expect(refused((line) => { gold(line).purchases.lots = 10_000_000; })).toBeNull();
    expect(refused((line) => { gold(line).purchases.lots = -1; })).toBeNull();
    expect(refused((line) => { gold(line).purchases.lots = 0.5; })).toBeNull();
    expect(refused((line) => { gold(line).purchases.lots = null; })).toBeNull();
    expect(refused((line) => { gold(line).purchases.lots = [1]; })).toBeNull();
    expect(refused((line) => { gold(line).purchases.lots = []; })).toBeNull();
    // The bound itself is a count.
    expect(refused((line) => { gold(line).purchases.lots = 9_999_999; })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('holdr-metals views-report', () => {
  it('lists itself in the usage, apart from UP-D9\'s read-report', async () => {
    const code = await run(['--help']);
    expect(stdout).toBe(METALS_CLI_USAGE);
    expect(code).toBe(0);
    expect(METALS_CLI_USAGE).toContain(`\n  ${METALS_VIEWS_REPORT_COMMAND} --db DB --out NEW_FILE\n`);
    expect(METALS_CLI_USAGE.replace(/\s+/g, ' ')).toContain('report, ROOT\'s read-report, is the one read that runs under the marker');
    // ROOT's ruling (A): the file holds the full answers, so it stays on the Mac; only the line leaves.
    expect(METALS_CLI_USAGE.replace(/\s+/g, ' ')).toContain(`That line is the only output that leaves the Mac: run ${METALS_VIEWS_REPORT_COMMAND} `
      + 'on the Mac only, and never copy its file off the Mac or into chat, logs or reports.');
  });

  it('writes the owner-only file and prints one value-free line naming its SHA-256', async () => {
    seedLedger();
    const before = fs.readFileSync(file);
    const code = await viewsReport();
    expect(stderr).toBe('');
    expect(stdout).toMatch(PASSED);
    expect(code).toBe(0);
    expect(lineOf(stdout)).toMatchObject({ code: METALS_VIEWS_REPORT_CODE, today: TODAY, outSha256: sha256(at('views.json')), failures: [] });
    expect(JSON.parse(fs.readFileSync(at('views.json'), 'utf8'))).toMatchObject({ format: METALS_VIEWS_REPORT_FORMAT, version: 1, today: TODAY,
      databaseRef: digest(path.resolve(file)) });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('exits 1 when an identity fails, with the file written and the line naming the failure', async () => {
    seedLedger();
    const sales = MetalsViews.prototype.sales;
    vi.spyOn(MetalsViews.prototype, 'sales').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['sales']>) {
      const answer = sales.apply(this, args);
      if (args[0] === 'XAU' && answer.sales.length > 0) answer.sales[0].netMinor += 1;
      return answer;
    });
    const code = await viewsReport();
    expect(stderr).toBe('');
    expect(stdout).toMatch(new RegExp(`^\\{"code":"${METALS_VIEWS_REPORT_CODE}",[^\\n]*,"failures":\\["metal-identity-fails"\\]\\}\\n$`));
    expect(code).toBe(1);
    expect(lineOf(stdout)).toMatchObject({ failures: ['metal-identity-fails'], outSha256: sha256(at('views.json')) });
  });

  it('refuses, with no file, without the lease protocol outside a disposable stack', async () => {
    seedLedger();
    const code = await viewsReport(at('views.json'), BASE_ENV);
    expect(stderr).toBe(`holdr-metals: ${METALS_VIEWS_REPORT_COMMAND}-refused no-shared-lease\n`);
    expect(stdout).toBe('');
    expect(code).toBe(1);
    expect(fs.existsSync(at('views.json'))).toBe(false);
  });

  it('checks the output\'s place before it opens the database, and writes only where its owner alone can open it', async () => {
    // No database at all: the place is refused first.
    const shared = standIn([{ sid: USERS_SID, rights: 0x120089, type: 'Allow' }]);
    const missing = await run([METALS_VIEWS_REPORT_COMMAND, '--db', at('missing.db'), '--out', at('views.json')], DISPOSABLE, shared);
    expect(stderr).toBe('');
    expect(stdout).toBe(refusalLine('metals-output-not-owner-only'));
    expect(missing).toBe(1);
    stdout = '';
    seedLedger();
    // The directory passes and the new empty file fails: it is removed before a byte of the report is written.
    const checked: string[] = [];
    const fileOpen: OutputAccess = {
      ...OWNER_ONLY,
      readAcls: (paths) => paths.map((target) => {
        checked.push(path.basename(target));
        return (target.endsWith('views.json') ? shared : OWNER_ONLY).readAcls([target])[0];
      }),
    };
    const opened = await viewsReport(at('views.json'), DISPOSABLE, fileOpen);
    expect(stderr).toBe('');
    expect(stdout).toBe(refusalLine('metals-output-not-owner-only'));
    expect(opened).toBe(1);
    expect(checked.filter((name) => name === 'views.json')).toHaveLength(1);
    expect(checked.filter((name) => name !== 'views.json')).toHaveLength(2);
    expect(fs.existsSync(at('views.json'))).toBe(false);
  });

  it('refuses a relative, existing or missing output path and any other option, before anything is read', async () => {
    seedLedger();
    fs.writeFileSync(at('exists.json'), '{}');
    for (const args of [
      ['--db', file, '--out', 'views.json'],
      ['--db', file, '--out', at('exists.json')],
      ['--db', file, '--out', at(path.join('no-such-dir', 'views.json'))],
      ['--db', file],
      ['--db', file, '--out', at('views.json'), '--go', at('go.json')],
    ]) {
      stderr = '';
      const code = await run([METALS_VIEWS_REPORT_COMMAND, ...args]);
      expect(stderr).toBe('holdr-metals: input-refused HoldrRefusal\n');
      expect(code).toBe(1);
    }
    expect(stdout).toBe('');
    expect(fs.existsSync(at('views.json'))).toBe(false);
  });

  it('is refused under every quarantine reason, on another shape and over a correction, with no file', async () => {
    const empty = await viewsReport();
    expect(stderr).toBe('');
    expect(stdout).toBe(refusalLine('metals-not-installed'));
    expect(empty).toBe(1);
    seedLedger();
    for (const reason of QUARANTINE_REASONS) {
      stdout = '';
      db().exec(marker(reason));
      const code = await viewsReport();
      expect([reason, stderr]).toEqual([reason, '']);
      expect([reason, stdout]).toEqual([reason, refusalLine('metals-conflict')]);
      expect([reason, code]).toEqual([reason, 1]);
      db().exec('DROP VIEW metals_quarantine');
    }
    stdout = '';
    db().prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-payload', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-payload' WHERE import_seq = 1`).run('a'.repeat(32), NOW.toISOString(), 'b'.repeat(64));
    const corrected = await viewsReport();
    expect(stderr).toBe('');
    expect(stdout).toBe(refusalLine('metals-correction-unsupported'));
    expect(corrected).toBe(1);
    expect(fs.existsSync(at('views.json'))).toBe(false);
  });

  it('refuses a line outside its shape, and writes no file', async () => {
    seedLedger();
    const purchases = MetalsViews.prototype.purchases;
    vi.spyOn(MetalsViews.prototype, 'purchases').mockImplementation(function (this: MetalsViews, ...args: Parameters<MetalsViews['purchases']>) {
      const answer = purchases.apply(this, args);
      for (const entry of answer.purchases) (entry.delivery as { state: string }).state = BAR_TITLE;
      return answer;
    });
    const code = await viewsReport();
    expect(stderr).toBe(`holdr-metals: ${METALS_VIEWS_REPORT_COMMAND}-refused value-shaped-output\n`);
    expect(stdout).toBe('');
    expect(code).toBe(1);
    expect(fs.existsSync(at('views.json'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('on Windows, writes the report only into a directory its real ACL keeps owner-only', async () => {
    seedLedger();
    const sid = readCurrentUserSid();
    const owned = at('owned');
    fs.mkdirSync(owned);
    restrictToUser(owned, sid);
    const written = await viewsReport(path.join(owned, 'views.json'), DISPOSABLE, platformOutputAccess);
    expect(stderr).toBe('');
    expect(stdout).toMatch(PASSED);
    expect(written).toBe(0);
    expect(ownerOnlyAcl(readWindowsAcls([path.join(owned, 'views.json')])[0], sid)).toBe(true);
    stdout = '';
    const shared = at('shared');
    fs.mkdirSync(shared);
    restrictToUser(shared, sid);
    execFileSync(system32('icacls.exe'), [shared, '/grant', `*${USERS_SID}:(OI)(CI)R`], { stdio: 'ignore' });
    const refused = await viewsReport(path.join(shared, 'views.json'), DISPOSABLE, platformOutputAccess);
    expect(stderr).toBe('');
    expect(stdout).toBe(refusalLine('metals-output-not-owner-only'));
    expect(refused).toBe(1);
    expect(fs.existsSync(path.join(shared, 'views.json'))).toBe(false);
  }, 60_000);
});

// Holdr's BetterSqlite3 is the one the read handle uses; a direct handle shows the report never changed the database.
describe('metals views report: nothing written', () => {
  it('leaves the database byte for byte as it was, and reads on a handle that can\'t write', async () => {
    seedLedger();
    repo.close();
    const before = fs.readFileSync(file);
    const code = await viewsReport();
    expect(stderr).toBe('');
    expect(stdout).toMatch(PASSED);
    expect(code).toBe(0);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    const handle = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
      expect(handle.prepare('SELECT count(*) FROM metals_owner_decisions').pluck().get()).toBe(0);
    } finally {
      handle.close();
    }
    repo = new SqliteStateRepo({ file });
  });
});
