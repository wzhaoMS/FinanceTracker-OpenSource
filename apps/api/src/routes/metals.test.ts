import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

import type { CheckingImportPayload } from '@finance-tracker/shared';
import {
  METALS,
  METALS_PRODUCT_REF_MAX,
  METALS_TITLE_GUARD,
  rational,
  type Metal,
  type MetalsEvent,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsLineMetalUncertain,
  type MetalsOrder,
} from '@finance-tracker/shared/metals-ledger';
import {
  delivered,
  inStore,
  metalItem,
  otherItem,
  syntheticCompetitor,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
} from '@finance-tracker/shared/metals-ledger-fixtures';
import type {
  MetalsAnswers,
  MetalsBullionFigures,
  MetalsBullionPreview,
  MetalsCloses,
  MetalsFunding,
  MetalsOverview,
  MetalsProduct,
  MetalsPurchase,
  MetalsPurchases,
  MetalsSale,
  MetalsSales,
  MetalsTimeline,
} from '@finance-tracker/shared/metals-api';

import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import type { MetalSpotBarFetcher } from '../providers/metalSpotBars.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { MetalsPreviewStale, writeMetalsBullionChange, writeMetalsContentChange } from '../services/metalsRead/decisions.js';
import { MetalsPriceRefresher } from '../services/metalsRead/prices.js';
import { MetalsCorrectionUnsupported, MetalsReadModel, MetalsSchemaClosed } from '../services/metalsRead/source.js';
import {
  approveMetalsBindings,
  importMetalsPayload,
  installMetalsSchema,
  metalsPayloadSha256,
  metalsSchemaState,
  proposeMetalsBindings,
  serializeMetalsBindingProposal,
  sha256Hex,
  type MetalsAccountChoice,
  type MetalsBindingPair,
} from '../services/metals/index.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// Synthetic only: invented orders, titles, amounts, last 4s, closes and GO ids, on a scratch database this build made,
// through the real install and import (G2) and the real app (createApp).

const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '7c'.repeat(32);
const FAST = { ln: 10, r: 8, p: 1 };
/** Wednesday, 2030-03-20 in New York. */
const NOW = new Date('2030-03-20T16:00:00.000Z');
const TODAY = '2030-03-20';
const IMPORTED_AT = '2030-03-20T12:00:00.000Z';
const DATABASE_REF = 'c'.repeat(64);
const BAR_TITLE = 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999';

let dir: string;
let repo: SqliteStateRepo;
let app: Express;
let cookie: string;
let logs: string[];
/** Imports so far: each is made a minute after the one before, so "a later import" is well defined (ids are random). */
let imports: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-api-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  logs = [];
  imports = 0;
});

afterEach(() => {
  vi.useRealTimers();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const db = () => repo.internalGetDb();
const goId = () => randomBytes(16).toString('hex');

/**
 * Builds the app with its clock at `now` (NOW unless given), prices off unless a fetcher is given, the owner's metals
 * assignment policy and estimate switch if given, and signs the owner in (created on the first start).
 */
async function start(options: { metalSpotBars?: MetalSpotBarFetcher; now?: Date; metalsFungible?: Metal[]; metalsEstimateUnmatched?: Metal[] } = {}): Promise<void> {
  const { now = NOW, ...rest } = options;
  vi.setSystemTime(now);
  const built = createApp({
    repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, now: () => now,
    log: (line) => logs.push(line), ...rest,
  });
  app = built.app;
  if (built.users.countUsers() === 0) built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN).set('X-Holdr-Request', '1')
    .send({ username: 'alex', password: 'synthetic password' });
  expect(login.status).toBe(200);
  cookie = (login.headers['set-cookie'] as unknown as string[]).find((entry) => entry.startsWith('holdr_session='))!.split(';')[0];
}

/**
 * A Holdr that fetches closes (HOLDR_METALS_PRICES=1) whose provider has nothing new: its reads value with the closes a
 * test stored, and a refresh writes nothing. Every test that values uses it: with prices off, stored closes value
 * nothing (ROOT O110). Nothing leaves the process.
 */
const PRICES_ON: { metalSpotBars: MetalSpotBarFetcher } = { metalSpotBars: async () => [] };

const signedIn = (test: request.Test) => test.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
const get = async (url: string) => signedIn(request(await listenLoopback(app)).get(url));
const post = async (url: string, body: unknown) => signedIn(request(await listenLoopback(app)).post(url)).set('Content-Type', 'application/json')
  .send(JSON.stringify(body));
const del = async (url: string) => signedIn(request(await listenLoopback(app)).delete(url));
const service = async (url: string) => request(await listenLoopback(app)).get(url).set('Authorization', ['Bearer', TOKEN].join(' '));

// ---------------------------------------------------------------------------
// Synthetic ledger
// ---------------------------------------------------------------------------

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A Walmart order of 1 ozt gold bars (fine content by stated mass basis), one card, one shipment group. */
function walmartBar(id: string | number, options: { date: string; quantity?: number; events?: MetalsEvent[]; unitMinor?: number; productRef?: string }): MetalsOrder {
  const quantity = options.quantity ?? 1;
  const unit = options.unitMinor ?? 200000;
  const amount = unit * quantity;
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date: options.date,
    skeleton: [metalItem(0, amount)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: amount }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amount,
    },
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: options.productRef ?? 'walmart:100001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity, unitPriceMinor: unit,
      events: options.events ?? [delivered(quantity, addDays(options.date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}

/** A Walmart order of one gold bar and one other item with an order-level shipping fee: the fee stays unattributed. */
function walmartMixed(id: string | number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 200000), otherItem(1, 5000)],
    components: [{ kind: 'shipping', amountMinor: 999 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 205999 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 205999,
    },
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'walmart:100001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 200000,
      events: [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}

/** A Walmart order of one 10 ozt silver bar. */
function walmartSilver(id: string | number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 30000)],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 30000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 30000,
    },
    lines: [{
      ordinal: 0, title: 'Sample Refinery 10 ozt Silver Bar FINE SILVER .999', productRef: 'walmart:200001', metal: 'XAG', form: 'bar',
      statedMass: { value: '10', unit: 'ozt' }, pack: 'single', purity: { text: '.999', value: '999/1000' }, massBasis: 'fine', design: null,
      quantity: 1, unitPriceMinor: 30000, events: [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}

const PREMIUM = 'spot +5.0000% / +$100.00 per troy ounce';

/** A CollectPure sale of 1 ozt gold bars at $2,100.00 each, a $20.00 fee and $10.00 insured shipping, paid out in full. */
function barSale(id: string | number, options: { date: string; payoutDate?: string; premium?: string | null }): MetalsOrder {
  const payoutDate = options.payoutDate ?? addDays(options.date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date: options.date, tradeMoment: `${options.date}T15:00:00Z`, status: 'complete',
    completedDate: payoutDate,
    skeleton: [metalItem(0, 210000)],
    components: [{ kind: 'platform-fee', amountMinor: -2000 }, { kind: 'insured-shipping', amountMinor: -1000 }],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 207000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000,
      events: [{ kind: 'agreed', date: options.date, dateBasis: 'stated', quantity: 1, occurrence: 1 }],
      sale: { program: 'Sell to Dealer', premium: options.premium === null ? null : { text: options.premium ?? PREMIUM, basis: 'troy_ounce' }, inspection: 'passed' },
    }],
  });
}

/** A CollectPure sale of one 1 oz gold Eagle coin (by coin specification), which no recorded purchase matches. */
function coinSale(id: string | number, date: string): MetalsOrder {
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
      events: [{ kind: 'agreed', date, dateBasis: 'stated', quantity: 1, occurrence: 1 }],
    }],
  });
}

/** A Costco warehouse receipt of one bare-"oz" gold bar: in v1 only the owner can say what it contains. */
function costcoReceipt(id: string | number, date: string, mass = '1', amountMinor = 205000): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'warehouse', id, date,
    skeleton: [metalItem(0, amountMinor, { taxFlag: 'non-taxable' })],
    admission: {
      fulfilment: 'in-store', methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amountMinor,
    },
    lines: [{
      ordinal: 0, title: 'GOLD BULLION BAR SAMPLE PAMP', productRef: 'costco:300001', metal: 'XAU', form: 'bar', statedMass: { value: mass, unit: 'oz' },
      pack: 'single', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: null, events: [inStore(1, date)],
    }],
  });
}

/** A Costco online order of a two-bar pack: a lot only its own confirmation answers. */
function costcoPack(id: string | number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'online', id, date,
    skeleton: [metalItem(0, 420000, { shippingMinor: 0 })],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 420000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 420000,
    },
    lines: [{
      ordinal: 0, title: '1 oz Gold Bar Sample Refinery (2 pack)', productRef: 'costco:300003', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'oz' }, pack: 'multiple', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: 420000,
      events: [delivered(1, addDays(date, 4))],
    }],
  });
}

const agreed = (date: string): MetalsEvent => ({ kind: 'agreed', date, dateBasis: 'stated', quantity: 1, occurrence: 1 });

/** A Walmart order of one 1 oz gold Eagle coin, its content read by coin specification. */
function walmartCoin(id: string | number, date: string, unitMinor = 215000): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, unitMinor)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: unitMinor }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: unitMinor,
    },
    lines: [{
      ordinal: 0, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'walmart:400001', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1,
      unitPriceMinor: unitMinor, events: [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}

/** A CollectPure sale of a 1 ozt gold bar and a 10 ozt silver bar in one order, paid out in full: its payout is no one metal's. */
function mixedSale(id: string | number, date: string, silverMinor = 30000): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 210000), metalItem(1, silverMinor)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 210000 + silverMinor,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [
      { ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' }, pack: 'single',
        purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000, events: [agreed(date)] },
      { ordinal: 1, title: 'Sample Refinery 10 ozt Silver Bar FINE SILVER .999', productRef: 'collectpure:SKU-AG10', metal: 'XAG', form: 'bar',
        statedMass: { value: '10', unit: 'ozt' }, pack: 'single', purity: { text: '.999', value: '999/1000' }, massBasis: 'fine', design: null,
        quantity: 1, unitPriceMinor: silverMinor, events: [agreed(date)] },
    ],
  });
}

/** A Walmart order of two bars whose title names two metals (its metal is unknown); one is cancelled, one delivered. */
function walmartMetalUnknown(id: string | number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 60000)],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 60000 }],
      refunded: false, cancelled: false, partlyCancelled: true, grossTotalMinor: 60000,
    },
    lines: [{
      ordinal: 0, title: 'Sample Refinery Gold and Silver Bullion Bar', productRef: 'walmart:300001', metal: null, form: 'bar', statedMass: null, pack: 'single',
      purity: null, massBasis: 'unknown', design: null, quantity: 2, unitPriceMinor: 30000, seller: 'Sample Bullion Shop',
      events: [{ kind: 'cancelled', date: addDays(date, 1), dateBasis: 'stated', quantity: 1, occurrence: 1 }, delivered(1, addDays(date, 4))],
    }],
  });
}

/** A CollectPure sale of a bar whose title names two metals: its metal is unknown. */
function metalUnknownSale(id: string | number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 50000)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 50000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: 'Sample Refinery Gold and Silver Bullion Bar', productRef: 'collectpure:SKU-SET1', metal: null, form: 'bar', statedMass: null,
      pack: 'single', purity: null, massBasis: 'unknown', design: null, quantity: 1, unitPriceMinor: 50000, events: [agreed(date)],
    }],
  });
}

/** A CollectPure sale of a gold bar whose weight isn't stated: its content is unknown until confirmed. */
function unconfirmedSale(id: string | number, date: string): MetalsOrder {
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

/**
 * A CollectPure sale of a 1 ozt gold bar and a $50.00 non-metal item in one order, with a $20.00 fee and $10.00 insured
 * shipping: the allocation can't split them between metal and non-metal, so the bar's net proceeds are approximate.
 */
function saleWithOtherItem(id: string | number, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 210000), otherItem(1, 5000)],
    components: [{ kind: 'platform-fee', amountMinor: -2000 }, { kind: 'insured-shipping', amountMinor: -1000 }],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 212000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000,
      events: [agreed(date)],
    }],
  });
}

/** A CollectPure sale of a 1 ozt gold bar, cancelled: it realized nothing and paid nothing out. */
function cancelledSale(id: string | number, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'cancelled',
    skeleton: [metalItem(0, 210000)],
    lines: [{
      ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
      pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000,
      events: [agreed(date)],
    }],
  });
}

/** The title guard's flag (contract follow-up 1): the guard, what fired, in its closed order, and the metal the title names. */
const flagOf = (metal: Metal | null): MetalsLineMetalUncertain => ({ guard: METALS_TITLE_GUARD, evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal });
/** Titles that read as no metal, though they name one with bullion evidence: what the guard flags. */
const FLAGGED_TITLES: Record<'XAU' | 'XAG' | 'several', string> = {
  XAU: 'Sample Refinery 1 ozt Gold Bar Assay Card',
  XAG: 'Sample Refinery 10 ozt Silver Bar Assay Card',
  several: 'Sample Refinery Gold and Silver Bar Assay Card',
};

/**
 * A Walmart order the title guard holds for metals (G3-int A0): a $1,500.00 line it flagged, its flag naming `flag`, and
 * with `bar` a $2,000.00 1 ozt gold bar beside it, by the Visa card ending 1111. Its lines are in no figure until the owner
 * answers.
 */
function walmartHeld(id: string, date: string, flag: 'XAU' | 'XAG' | null, bar = false): MetalsOrder {
  const total = bar ? 350000 : 150000;
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: bar ? [metalItem(0, 150000), metalItem(1, 200000)] : [metalItem(0, 150000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: total }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: total,
    },
    lines: [
      { ordinal: 0, title: FLAGGED_TITLES[flag ?? 'several'], productRef: `walmart:card-${id}`, metal: null, metalUncertain: flagOf(flag), form: null,
        statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 150000,
        events: [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop' },
      ...(bar ? [{ ordinal: 1, title: BAR_TITLE, productRef: `walmart:bar-${id}`, metal: 'XAU' as const, form: 'bar' as const,
        statedMass: { value: '1', unit: 'ozt' as const }, pack: 'single' as const, purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine' as const,
        design: null, quantity: 1, unitPriceMinor: 200000, events: [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop' }] : []),
    ],
  });
}

/**
 * A CollectPure sale the title guard holds for metals: a $70.00 line it flagged (naming gold) and a $2,000.00 1 ozt gold
 * bar, with no fees, paid out in full ($2,070.00 on the third day, to the account ending 2222).
 */
function heldSale(id: string, date: string): MetalsOrder {
  const payoutDate = addDays(date, 3);
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`, status: 'complete', completedDate: payoutDate,
    skeleton: [metalItem(0, 7000), metalItem(1, 200000)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 207000,
      initiatedDate: payoutDate, payoutDate, status: 'complete' }],
    lines: [
      { ordinal: 0, title: FLAGGED_TITLES.XAU, productRef: 'collectpure:SKU-CARD1', metal: null, metalUncertain: flagOf('XAU'), form: null,
        statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 7000, events: [agreed(date)] },
      { ordinal: 1, title: BAR_TITLE, productRef: 'collectpure:SKU-HELD1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
        pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [agreed(date)] },
    ],
  });
}

/**
 * A Costco.com order the title guard holds for metals: one $1,500.00 line it flagged (naming gold), by the card ending
 * 3333.
 */
function costcoHeld(id: string, date: string): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'online', id, date,
    skeleton: [metalItem(0, 150000, { shippingMinor: 0 })],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 150000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 150000,
    },
    lines: [{
      ordinal: 0, title: FLAGGED_TITLES.XAU, productRef: `costco:card-${id}`, metal: null, metalUncertain: flagOf('XAU'), form: null, statedMass: null,
      pack: 'single', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: 150000, events: [delivered(1, addDays(date, 4))],
    }],
  });
}

/**
 * A Walmart order of one line the title guard flagged ($1,500.00, by the Visa card ending 1111), its product ref
 * `walmart:card-<id>` unless given (or none), its flag naming gold unless given, delivered on the fourth day unless its
 * events are given: what a later capture can progress.
 */
function walmartFlagged(id: string, date: string, options: { productRef?: string | null; flag?: MetalsLineMetalUncertain; events?: MetalsEvent[] } = {}): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 150000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 150000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 150000,
    },
    lines: [{
      ordinal: 0, title: FLAGGED_TITLES.XAU, productRef: options.productRef === undefined ? `walmart:card-${id}` : options.productRef, metal: null,
      metalUncertain: options.flag ?? flagOf('XAU'), form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1,
      unitPriceMinor: 150000, events: options.events ?? [delivered(1, addDays(date, 4))], seller: 'Sample Bullion Shop',
    }],
  });
}
const walmartPayload = (orders: MetalsOrder[], extra: { held?: MetalsHeldRecord[]; complete?: boolean; competitors?: MetalsImportPayload['competitors']; coverage?: boolean } = {}) =>
  syntheticPayload('walmart', {
    orders, held: extra.held, competitors: extra.competitors,
    coverage: extra.coverage === false ? [] : [syntheticCoverage('online', '2029-01-01', TODAY, extra.complete === false ? 99 : 9, 9)],
  });
const collectpurePayload = (orders: MetalsOrder[]) => syntheticPayload('collectpure', {
  orders, coverage: [syntheticCoverage('sell-orders', '2029-01-01', TODAY, 9, 9), syntheticCoverage('payouts', '2029-01-01', TODAY, 9, 9)],
});
const costcoPayload = (orders: MetalsOrder[]) => syntheticPayload('costco', {
  orders, coverage: [syntheticCoverage('online', '2029-01-01', TODAY, 9, 9), syntheticCoverage('warehouse', '2029-01-01', TODAY, 9, 9)],
});

/** Imports a payload through G2's real importer, planning and writing in one step, under a synthetic GO. */
function importReceipt(payload: MetalsImportPayload, account: MetalsAccountChoice) {
  const now = new Date(Date.parse(IMPORTED_AT) + (imports++) * 60_000).toISOString();
  return importMetalsPayload(db(), { payload, account },
    { now, goId: goId(), purpose: 'copy-rehearsal', inputSha256: metalsPayloadSha256(payload), planDigest: null });
}

function importPayload(payload: MetalsImportPayload, account: MetalsAccountChoice): string {
  const receipt = importReceipt(payload, account);
  expect(receipt.code).toBe('metals-imported');
  return receipt.accountId!;
}

const W1 = walmartBar(1, { date: '2030-01-10' });
const W3 = walmartBar(3, { date: '2030-02-15', quantity: 2 });
const C1 = barSale(1, { date: '2030-02-03' });
const K1 = costcoReceipt('r1', '2030-02-10');

/**
 * The base ledger: two Walmart bar orders (1 ozt on 01-10, 2 ozt on 02-15), a CollectPure sale of 1 ozt on 02-03 (net
 * $2,070.00), and a Costco warehouse bar whose content is unknown until confirmed.
 */
function seedBase(): { walmart: string; collectpure: string; costco: string } {
  installMetalsSchema(db());
  return {
    walmart: importPayload(walmartPayload([W1, W3]), { label: 'Walmart account' }),
    collectpure: importPayload(collectpurePayload([C1]), { label: 'CollectPure account' }),
    costco: importPayload(costcoPayload([K1]), { label: 'Costco membership' }),
  };
}

const cardRow = (patch: Partial<CardImportRow>): CardImportRow => ({
  transactionDate: '2030-01-11', postedDate: null, status: 'posted', amountMinor: 0, currency: 'USD', kind: 'purchase',
  description: 'WALMART.COM SAMPLE', merchant: null, issuerCategory: null, ...patch,
} as CardImportRow);

/** Card accounts ending 1111 and 3333 with the charges the base ledger's orders made. */
function seedCards(): { visa: string; costcoCard: string; rows: Record<string, string> } {
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
  const all = repo.listCardTransactionsMatching({ statuses: ['posted'] });
  const id = (amountMinor: number) => all.find((row) => row.amountMinor === amountMinor)!.id;
  return { visa: visa.id, costcoCard: costcoCard.id, rows: { w1: id(200000), w3: id(400000), k1: id(205000) } };
}

/** A checking account ending 2222 with one dealer credit the size of the base sale's payout, covered through 2030-03-19. */
function seedChecking(
  /** Or these credits of that size instead, each with its own day and description. */
  credits: ReadonlyArray<{ postedDate: string; description: string }> = [{ postedDate: '2030-02-07', description: 'SAMPLE DEALER ACH CREDIT' }],
): { account: string; credit: string; credits: string[] } {
  installCheckingSchema(db());
  const payload: CheckingImportPayload = {
    format: 'holdr.checking-import', version: 1, parserVersion: 'holdr-checking-import@1.0.0',
    account: { institution: 'wellsfargo', type: 'checking', last4: '2222', label: 'Sample Bank Everyday Checking', currency: 'USD' },
    segments: [{
      source: 'ofx', coverage: { start: '2030-01-01', end: '2030-03-19' }, anchors: [],
      rows: credits.map(({ postedDate, description }) => ({
        postedDate, amountMinor: C1.payouts[0].amountMinor, description, checkNumber: null, bankType: 'CREDIT', externalIdHash: null,
      })),
    }],
  };
  importCheckingPayload(db(), payload, { now: IMPORTED_AT, goId: 'c'.repeat(32), purpose: 'copy-rehearsal' });
  const ids = db().prepare('SELECT id FROM checking_transactions ORDER BY posted_date, id').pluck().all() as string[];
  return { account: db().prepare('SELECT id FROM checking_accounts').pluck().get() as string, credit: ids[0], credits: ids };
}

function approve(pairs: MetalsBindingPair[]): void {
  const { proposal } = proposeMetalsBindings(db(), DATABASE_REF);
  approveMetalsBindings(db(), proposal, { proposalSha256: sha256Hex(serializeMetalsBindingProposal(proposal)), inventoryDigest: proposal.inventoryDigest, pairs },
    { now: IMPORTED_AT, goId: goId(), purpose: 'copy-rehearsal', planDigest: null, databaseRef: DATABASE_REF });
}

/** Stores one more conflicting version of a Walmart order as raw text, which the importer would never write. */
function storeConflictingVersion(orderKey: string, canonicalJson: string): void {
  const { importId, version } = db().prepare(`SELECT created_by_import AS importId, max(version) AS version FROM metals_order_versions WHERE order_key = ?`)
    .get(orderKey) as { importId: string; version: number };
  db().prepare(`INSERT INTO metals_order_versions (order_key, version, source, side, digest, canonical_json, state, reason, created_by_import, created_at)
    VALUES (?, ?, 'walmart', 'buy', ?, ?, 'conflict', 'conflict', ?, ?)`).run(orderKey, version + 1, 'p'.repeat(64), canonicalJson, importId, IMPORTED_AT);
}

/** Daily closes of a metal on every weekday from `from` to `to`, as the price store keeps them (or another source). */
function seedCloses(metal: Metal, from: string, to: string, close: number | ((date: string) => number), source = 'cnbc-spot-daily'): void {
  const insert = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'daily', ?, ?, ?)`);
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) insert.run(`holdr:metal:${metal}`, date, typeof close === 'number' ? close : close(date), source);
  }
}

const oz = (exact: string, display: string) => ({ exact, display });
const complete = (value: number) => ({ value, state: 'complete', reasons: [] });
const codes = (measure: { reasons: Array<{ code: string }> }) => measure.reasons.map((reason) => reason.code);
/** Whether every, some or none of the measures carry conflict. */
const conflictIn = (measures: ReadonlyArray<{ reasons: Array<{ code: string }> }>) => {
  const carrying = measures.filter((measure) => codes(measure).includes('conflict')).length;
  return carrying === measures.length ? 'every' : carrying === 0 ? 'none' : 'some';
};
/** Holdings' ounces, cost and value, then every class's and every source account's. */
const holdingFigures = (holdings: MetalsOverview['holdings']) => [holdings.troyOz, holdings.costMinor, holdings.valueMinor,
  ...holdings.classes.flatMap((entry) => [entry.troyOz, entry.costMinor, entry.valueMinor]),
  ...holdings.bySource.flatMap((row) => [row.troyOz, row.costMinor, row.valueMinor])];
const overview = async (query = 'metal=XAU') => (await get(`/metals/overview?${query}`)).body as MetalsOverview;
const purchaseOf = (purchases: MetalsPurchase[], order: MetalsOrder) => purchases.find((entry) => entry.orderKey === order.key)!;
/** Every measure in an answer (a value with its state and reasons), with its path. */
function measuresIn(value: unknown, at = '$'): Array<[string, { value: unknown; state: string; reasons: unknown[] }]> {
  if (Array.isArray(value)) return value.flatMap((entry, index) => measuresIn(entry, `${at}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if ('state' in record && 'reasons' in record) return [[at, record as { value: unknown; state: string; reasons: unknown[] }]];
  return Object.entries(record).flatMap(([key, child]) => measuresIn(child, `${at}.${key}`));
}

/** The quarantine marker exactly as corrections r6 §1's template (a correction reason, its GO, since, no ref, a nonce). */
const QUARANTINE_MARKER = `CREATE VIEW metals_quarantine AS SELECT 'import-wrong-payload' AS reason, '${'d'.repeat(32)}' AS go_id, `
  + `'2030-03-20T16:00:00.000Z' AS since, '' AS ref, '${'e'.repeat(32)}' AS nonce`;

describe('metals reads: installation and access', () => {
  it('answers installed: false without the tables, refuses writes, and never reads tables of another shape', async () => {
    await start();
    for (const url of ['/metals/overview', '/metals/purchases', '/metals/sales', '/metals/timeline', '/metals/products', '/metals/funding',
      '/metals/answers', '/metals/closes']) {
      const res = await get(url);
      expect([url, res.status, res.body]).toEqual([url, 200, { installed: false }]);
    }
    const write = await post(`/metals/products/${'costco:300001'}/content`,
      { fingerprint: 'a'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect([write.status, write.body.reason]).toEqual([409, 'not-installed']);
    expect(metalsSchemaState(db())).toBe('absent');
    db().exec('CREATE TABLE metals_stray (x TEXT)');
    const read = await get('/metals/overview');
    expect([read.status, read.body.reason]).toEqual([409, 'schema-conflict']);
    const conflicting = await post(`/metals/products/${'costco:300001'}/content`,
      { fingerprint: 'a'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect([conflicting.status, conflicting.body.reason]).toEqual([409, 'schema-conflict']);
  });

  it('answers the fixed 409 for every state but present and absent, one added later included, never as not installed', async () => {
    await start();
    seedBase();
    // A state this build has no name for (#327's `quarantined` before it lands, or any later one) is closed like the rest.
    const later = vi.spyOn(MetalsReadModel.prototype, 'schemaState').mockReturnValue('quarantined' as unknown as ReturnType<MetalsReadModel['schemaState']>);
    try {
      const read = await get('/metals/overview?metal=XAU');
      const write = await del(`/metals/products/collectpure:${'x'.repeat(8)}/content?decision=mtl-dec-${'a'.repeat(32)}`);
      expect([read.status, read.body.reason, write.status, write.body.reason]).toEqual([409, 'schema-conflict', 409, 'schema-conflict']);
    } finally {
      later.mockRestore();
    }
    expect((await get('/metals/overview?metal=XAU')).status).toBe(200);
  });

  it('refuses in the graph\'s own snapshot a marker set after the route\'s check, with the same fixed 409', async () => {
    await start();
    seedBase();
    db().exec(QUARANTINE_MARKER);
    // The route's check still sees the tables as they were: the marker was set between that check and the read.
    const missed = vi.spyOn(MetalsReadModel.prototype, 'schemaState').mockReturnValue('present');
    try {
      for (const url of ['/metals/overview?metal=XAU', '/metals/closes?metal=XAU']) {
        const read = await get(url);
        expect([url, read.status, read.body.reason]).toEqual([url, 409, 'schema-conflict']);
      }
    } finally {
      missed.mockRestore();
    }
  });

  it('needs sign-in; the service token may read and never write', async () => {
    await start();
    seedBase();
    expect((await request(await listenLoopback(app)).get('/metals/overview')).status).toBe(401);
    const read = await service('/metals/overview?metal=XAU');
    expect([read.status, read.body.installed]).toEqual([200, true]);
    const write = await request(await listenLoopback(app)).post(`/metals/products/${'costco:300001'}/content`)
      .set('Authorization', ['Bearer', TOKEN].join(' ')).set('Content-Type', 'application/json').send('{}');
    expect(write.status).toBe(403);
  });

  it('refuses the service token every write, products and lines, confirm and revoke, with the owner\'s own previews: 403 each, nothing written', async () => {
    await start();
    const accounts = seedBase();
    importPayload(costcoPayload([costcoPack('o1', '2030-02-12')]), { accountId: accounts.costco });
    const products = (await get('/metals/products?metal=XAU')).body.products as MetalsProduct[];
    const bar = products.find((row) => row.scope.kind === 'product' && row.scope.ref === 'costco:300001')!.scope as { ref: string; fingerprint: string };
    const pack = products.find((row) => row.scope.kind === 'lot')!.scope as { lotKey: string; evidenceDigest: string };
    const productRoute = `/metals/products/${bar.ref}/content`;
    const lineRoute = `/metals/lots/${pack.lotKey}/content`;
    const productBody = { fingerprint: bar.fingerprint, metal: 'XAU', troyOzPerUnit: '1' };
    const lineBody = { evidenceDigest: pack.evidenceDigest, metal: 'XAU', troyOzPerUnit: '2' };
    const asService = async (method: 'post' | 'delete', url: string, body?: unknown) => {
      const sent = request(await listenLoopback(app))[method](url).set('Authorization', ['Bearer', TOKEN].join(' '));
      return body === undefined ? sent : sent.set('Content-Type', 'application/json').send(JSON.stringify(body));
    };
    const refused = (responses: request.Response[]) => responses.map((res) => [res.status, res.body.code]);
    const rows = () => db().prepare('SELECT rowid AS seq, * FROM metals_owner_decisions ORDER BY rowid').all();

    // Confirming: the service token presents the owner's previews, and nothing is written.
    const productPreview = (await post(productRoute, { ...productBody, preview: null })).body.preview.digest as string;
    const linePreview = (await post(lineRoute, { ...lineBody, preview: null })).body.preview.digest as string;
    expect(refused([await asService('post', productRoute, { ...productBody, preview: productPreview }),
      await asService('post', lineRoute, { ...lineBody, preview: linePreview })])).toEqual([[403, 'principal-not-allowed'], [403, 'principal-not-allowed']]);
    expect(rows()).toEqual([]);

    // Revoking: the owner confirms both, previews both revokes, and the service token's revokes change nothing.
    const productId = (await post(productRoute, { ...productBody, preview: productPreview })).body.decision.id as string;
    const lineAgain = (await post(lineRoute, { ...lineBody, preview: null })).body.preview.digest as string;
    const lineId = (await post(lineRoute, { ...lineBody, preview: lineAgain })).body.decision.id as string;
    const productUndo = (await del(`${productRoute}?decision=${productId}`)).body.preview.digest as string;
    const lineUndo = (await del(`${lineRoute}?decision=${lineId}`)).body.preview.digest as string;
    const written = rows();
    expect(refused([await asService('delete', `${productRoute}?decision=${productId}&preview=${productUndo}`),
      await asService('delete', `${lineRoute}?decision=${lineId}&preview=${lineUndo}`)])).toEqual([[403, 'principal-not-allowed'], [403, 'principal-not-allowed']]);
    expect([written.length, rows()]).toEqual([2, written]);
    // The owner's revoke preview still holds: nothing the service token sent changed anything.
    expect((await del(`${productRoute}?decision=${productId}&preview=${productUndo}`)).body).toEqual({ revoked: true,
      decision: { id: productId, revokedAt: NOW.toISOString() } });
  });

  it('answers each write, products and lines, confirm and revoke, not-installed without the tables and schema-conflict while closed', async () => {
    await start();
    const decision = `mtl-dec-${'a'.repeat(32)}`;
    const lineKey = `walmart-line-${'a'.repeat(64)}`;
    const writes = async () => [
      await post(`/metals/products/${'costco:300001'}/content`, { fingerprint: 'a'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null }),
      await del(`/metals/products/${'costco:300001'}/content?decision=${decision}`),
      await post(`/metals/lots/${lineKey}/content`, { evidenceDigest: 'a'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null }),
      await del(`/metals/lots/${lineKey}/content?decision=${decision}`),
    ].map((res) => [res.status, res.body.reason ?? res.body.error]);
    expect(await writes()).toEqual(Array(4).fill([409, 'not-installed']));
    db().exec('CREATE TABLE metals_stray (x TEXT)');
    expect(await writes()).toEqual(Array(4).fill([409, 'schema-conflict']));
    db().exec('DROP TABLE metals_stray');
    installMetalsSchema(db());
    db().exec(QUARANTINE_MARKER);
    expect(await writes()).toEqual(Array(4).fill([409, 'schema-conflict']));
    // Open again, each reaches its own lookup, and finds nothing.
    db().exec('DROP VIEW metals_quarantine');
    expect(await writes()).toEqual([[404, 'product not found'], [404, 'decision not found'], [404, 'line not found'], [404, 'decision not found']]);
  });

  it('answers every read of an installed ledger holding nothing with its empty figures, each a true zero with no reason', async () => {
    // Prices on: its answers name the stored close, which values nothing while this Holdr doesn't fetch (ROOT O110).
    await start(PRICES_ON);
    installMetalsSchema(db());
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const ZERO_OZ = oz('0/1', '0.000');
    /** The paths of an answer's measures that aren't a complete zero (0, or no troy ounces) with no reason. */
    const notTrueZero = (body: unknown) => measuresIn(body).filter(([, measure]) => measure.state !== 'complete' || measure.reasons.length > 0
      || (measure.value !== 0 && JSON.stringify(measure.value) !== JSON.stringify(ZERO_OZ))).map(([at]) => at);
    const reads = async () => {
      const answers: Record<string, Record<string, unknown>> = {};
      for (const url of ['/metals/overview?metal=XAU', '/metals/purchases?metal=XAU', '/metals/sales?metal=XAU', '/metals/timeline?metal=XAU',
        '/metals/products?metal=XAU', '/metals/funding']) {
        const res = await get(url);
        expect([url, res.status, res.body.installed]).toEqual([url, 200, true]);
        answers[url.slice('/metals/'.length).split('?')[0]] = res.body;
      }
      return answers;
    };
    const units = { delivered: 0, awaiting: 0, sold: 0, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0 };
    const empty = {
      metals: [], asOf: TODAY, price: { closeDate: '2030-03-19', close: '2000' },
      holdings: { units, contentUnknown: { lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 }, classes: [], bySource: [] },
      metalUnknown: { lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 },
      activity: { bought: { lots: 0, units: 0 }, sold: { lines: 0, units: 0, unmatched: { units: 0, netMinor: 0, reasons: [] } },
        payouts: { count: 0, mixedMetal: { count: 0 } } },
      toCheck: { records: 0, needsYou: [], forInformation: [] },
      needsAnswer: { orders: 0, flaggedLines: 0, bySource: [], byMerchantClass: [], items: [] },
    };
    const lists = (answers: Record<string, Record<string, unknown>>) => [answers.purchases.purchases, answers.sales.sales, answers.products.products,
      answers.funding.purchases, answers.funding.sales, answers.funding.deposits];

    // Nothing imported: no lot, no sale and no account, so no gap; no import covers a month, so none is recorded.
    const before = await reads();
    expect(before.overview).toMatchObject({ ...empty, coverage: [] });
    expect([measuresIn(before.overview).length, notTrueZero(before.overview)]).toEqual([15, []]);
    expect(lists(before)).toEqual([[], [], [], [], [], []]);
    const notCovered = { value: null, state: 'unknown', reasons: [{ code: 'not-covered', records: 1 }] };
    expect(before.timeline.months).toEqual([{ month: '2030-03', endDate: TODAY, recorded: false, troyOz: notCovered, costMinor: notCovered,
      valueMinor: notCovered, closeDate: null }]);

    // An import whose complete coverage spans the days and holds no order: its month is recorded, a true zero too.
    importPayload(walmartPayload([]), { label: 'Walmart account' });
    const after = await reads();
    expect(after.overview).toMatchObject(empty);
    expect([(after.overview.coverage as unknown[]).length, measuresIn(after.overview).length, notTrueZero(after.overview)]).toEqual([1, 15, []]);
    expect(lists(after)).toEqual([[], [], [], [], [], []]);
    expect([(after.timeline.months as MetalsTimeline['months']).map((month) => [month.month, month.endDate, month.recorded, month.closeDate]),
      measuresIn(after.timeline).length, notTrueZero(after.timeline)]).toEqual([[['2030-03', TODAY, true, '2030-03-19']], 3, []]);
  });

  /**
   * A linked ledger with a preview made, then closed by `close`: every read and write answers the fixed 409 `reason`, the
   * model serves none, and a write past the route's check meets `refusal` inside its own IMMEDIATE transaction. With a
   * `clear`, reads answer again once it ran.
   */
  const closes = (close: (accounts: ReturnType<typeof seedBase>) => void, reason: string, refusal: { type: new () => Error; words: string },
    clear?: () => void) => async () => {
    await start();
    const accounts = seedBase();
    const cards = seedCards();
    approve([{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: cards.visa },
      { kind: 'card', source: 'costco', network: 'visa', last4: '3333', accountId: cards.costcoCard }]);
    const model = new MetalsReadModel(repo);
    const served = () => [model.receiptCharges().length, model.chargeParts(cards.rows.w1).provable, model.depositEvidence()];
    expect(served()).toEqual([3, true, []]);
    // A preview made before the void, which a write could still present.
    const route = `/metals/products/${'costco:300001'}/content`;
    const product = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
      .find((entry) => entry.scope.kind === 'product' && entry.scope.ref === 'costco:300001')!;
    const fingerprint = (product.scope as { fingerprint: string }).fingerprint;
    const preview = (await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null })).body.preview.digest as string;
    close(accounts);
    for (const url of ['/metals/overview', '/metals/purchases', '/metals/sales', '/metals/timeline', '/metals/products', '/metals/funding',
      '/metals/answers', '/metals/closes']) {
      const res = await get(url);
      expect([url, res.status, res.body.reason]).toEqual([url, 409, reason]);
    }
    const write = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview });
    expect([write.status, write.body.reason]).toEqual([409, reason]);
    const bullion = await post(`/metals/products/${'costco:300001'}/bullion`, { fingerprint, answer: 'bullion', preview });
    expect([bullion.status, bullion.body.reason]).toEqual([409, reason]);
    expect(served()).toEqual([0, false, []]);
    // A write past the route's check finds the correction again inside its own IMMEDIATE transaction, and writes nothing.
    const writePastRoute = () => writeMetalsContentChange({ db: db(), repo, today: TODAY, at: NOW.toISOString(), actorRef: `usr_${'c'.repeat(32)}`,
      previewDigest: preview }, { action: 'confirm', scope: { kind: 'product', ref: 'costco:300001', fingerprint }, metal: 'XAU', troyOzPerUnit: rational(1n) }, 'XAU');
    // Only the model's own refusal is caught, as data: by its constructor, name and exact words (the allowlist, kill
    // standard §8 and §9a). Anything else is re-thrown as it is, so no other error can pass for this assertion.
    let wrote: string;
    try {
      writePastRoute();
      wrote = 'written';
    } catch (error) {
      const refused = error instanceof refusal.type && error.constructor === refusal.type && error.name === refusal.type.name
        && error.message === refusal.words;
      if (!refused) throw error;
      wrote = error.message;
    }
    expect(wrote).toBe(refusal.words);
    expect(db().prepare('SELECT count(*) FROM metals_owner_decisions').pluck().get()).toBe(0);
    if (clear === undefined) return;
    clear();
    expect((await get('/metals/overview')).status).toBe(200);
  };

  it('reads nothing and writes nothing once the ledger holds a correction (a void): a fixed 409, and the model serves none', closes((accounts) => {
    // A void as only v1's void-import writes one (every void field at once, one way); this build reads none (the tripwire).
    db().prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-payload', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-payload' WHERE account_id = ?`).run('a'.repeat(32), NOW.toISOString(), 'b'.repeat(64), accounts.costco);
  }, 'correction-unsupported', { type: MetalsCorrectionUnsupported, words: 'correction-unsupported' }));

  it('reads nothing and writes nothing under the quarantine marker, as under every state but present, and reads again after the clear', closes(() => {
    // The marker as corrections r6 §1's template: `quarantined` with G2's #327 classifier, `conflict` before it; both closed.
    db().exec(QUARANTINE_MARKER);
  }, 'schema-conflict', { type: MetalsSchemaClosed, words: 'schema-closed' }, () => db().exec('DROP VIEW metals_quarantine')));
});

describe('metals reads: holdings as of a day, activity over a period', () => {
  it('replays holdings as of a day, counts activity on its own date basis, and values at the close before today', async () => {
    await start(PRICES_ON);
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    seedCloses('XAU', TODAY, TODAY, 2500);
    const today = await overview();
    expect(today.asOf).toBe(TODAY);
    expect(today.metals).toEqual([{ metal: 'XAU', lots: 3, sales: 1 }]);
    expect(today.price).toEqual({ source: 'cnbc-spot-daily', closeDate: '2030-03-19', close: '2000', stale: false, thinHistory: false, levelShift: null,
      fetching: true });
    const partial = [{ code: 'content-unknown', records: 1 }];
    expect(today.holdings.troyOz).toEqual({ value: oz('2/1', '2.000'), state: 'partial', reasons: partial });
    expect(today.holdings.units).toMatchObject({ delivered: 3, awaiting: 0, sold: 1, soldFromDelivered: 1, unmatched: 0, held: 2 });
    expect(today.holdings.costMinor).toEqual({ value: 400000, state: 'partial', reasons: partial });
    expect(today.holdings.valueMinor).toEqual({ value: 400000, state: 'partial', reasons: partial });
    expect(today.holdings.gainMinor).toEqual({ value: 0, state: 'partial', reasons: partial });
    expect(today.holdings.contentUnknown).toEqual({ lots: 1, units: 1, costMinor: 205000, sales: 0, saleNetMinor: 0 });
    expect(today.holdings.classes.map((entry) => [entry.form, entry.fineTroyOzPerUnit.exact, entry.reconciliation]))
      .toEqual([['bar', '1/1', { balanced: true, soldWhileAwaiting: 0, unmatched: 0 }]]);
    expect(today.metalUnknown).toEqual({ lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 });
    expect(today.activity.bought).toEqual({ lots: 3, units: 4, troyOz: { value: oz('3/1', '3.000'), state: 'partial', reasons: partial },
      costMinor: { value: 805000, state: 'partial', reasons: partial } });
    expect(today.activity.sold).toEqual({ lines: 1, units: 1, troyOz: { value: oz('1/1', '1.000'), state: 'complete', reasons: [] },
      grossMinor: complete(210000), feesMinor: complete(3000), netMinor: complete(207000), unmatched: { units: 0, netMinor: 0, reasons: [] } });
    expect(today.activity.profit).toEqual({ valueMinor: { value: 7000, state: 'complete', reasons: [] },
      coverage: { basis: 'troy-oz', known: oz('1/1', '1.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 } });
    expect(today.activity.payouts).toEqual({ count: 1, amountMinor: complete(207000), mixedMetal: { count: 0, amountMinor: complete(0) } });
    expect(today.toCheck.needsYou).toEqual([{ code: 'confirm-content', products: 1 }]);

    // The day before the sale one bar is held; after it no known bar is, beside a lot of unknown content: unknown, never 0.
    const before = await overview('metal=XAU&asOf=2030-02-01');
    expect(before.holdings.troyOz).toEqual({ value: oz('1/1', '1.000'), state: 'complete', reasons: [] });
    expect(before.price.closeDate).toBe('2030-02-01');
    const after = await overview('metal=XAU&asOf=2030-02-12');
    expect(after.holdings.troyOz).toEqual({ value: null, state: 'unknown', reasons: partial });
    // A weekend is valued at the Friday close, with its date.
    expect((await overview('metal=XAU&asOf=2030-03-16')).price.closeDate).toBe('2030-03-15');

    // A period changes activity, never holdings.
    const february = await overview('metal=XAU&from=2030-02-01&to=2030-02-28');
    expect(february.holdings).toEqual(today.holdings);
    expect(february.activity.bought).toMatchObject({ lots: 2, units: 3 });
    expect(february.activity.sold.lines).toBe(1);
    const march = await overview('metal=XAU&from=2030-03-01&to=2030-03-20');
    expect(march.activity.sold).toMatchObject({ lines: 0, grossMinor: complete(0), netMinor: complete(0) });
    expect(march.activity.profit.valueMinor).toEqual({ value: 0, state: 'complete', reasons: [] });
  });

  it('lists purchases and sales of the period with their lifecycle, content, cycles and spot decomposition', async () => {
    await start(PRICES_ON);
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const purchases = (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
    expect(purchases.map((entry) => entry.orderKey)).toEqual([W3.key, K1.key, W1.key]);
    const first = purchaseOf(purchases, W1);
    expect(first).toMatchObject({
      orderDate: '2030-01-10', quantity: 1, units: { ordered: 1, cancelled: 0, returned: 0, delivered: 1, awaiting: 0 },
      delivery: { state: 'delivered', date: '2030-01-14' }, costMinor: { value: 200000, state: 'complete', reasons: [] },
      content: { known: true, troyOzPerUnit: oz('1/1', '1.000'), troyOz: oz('1/1', '1.000'), basis: 'stated-mass-basis' },
      premiumPaidPerOzMinor: 0, purchaseSpot: { closeDate: '2030-01-10' }, cardEvidence: 'admitted', seller: 'Sample Bullion Shop',
      sales: [{ saleKey: C1.lines[0].key, agreedDate: '2030-02-03', units: 1 }], quarantined: false, refunds: [],
    });
    expect(first.cards).toEqual([{ evidenceClass: 'walmart-order-total@1', amountMinor: 200000, state: 'binding-missing', proof: false, row: null }]);
    expect(purchaseOf(purchases, K1)).toMatchObject({ delivery: { state: 'in-store', date: '2030-02-10' },
      content: { known: false, hold: 'unit-unconfirmed' } });
    expect((await get('/metals/purchases?metal=XAU&from=2030-02-11&to=2030-02-20')).body.purchases.map((entry: MetalsPurchase) => entry.orderKey))
      .toEqual([W3.key]);

    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale).toMatchObject({
      orderKey: C1.key, agreedDate: '2030-02-03', status: 'complete', grossMinor: 210000, feesMinor: 3000, netMinor: 207000,
      matched: { units: 1, netMinor: 207000 }, unmatched: { units: 0, netMinor: 0 }, known: true, saleSpot: { basis: 'dealer-implied' },
      premiumDisagreement: false,
    });
    // Bought at the purchase day's close and sold at the dealer's implied spot of $2,000.00: all of the $70.00 is premium.
    expect(sale.cycles).toEqual([expect.objectContaining({
      lotKey: W1.lines[0].key, units: 1, troyOz: oz('1/1', '1.000'), orderDate: '2030-01-10', daysFromOrderToSale: 24, costMinor: 200000,
      proceedsMinor: 207000, profitMinor: 7000, premiumPaidPerOzMinor: 0, salePremiumPerOzMinor: 7000, fromSpotMinor: 0, fromPremiumsMinor: 7000,
      purchaseSpot: { closeDate: '2030-01-10' },
    })]);
    expect(sale.payouts).toEqual([{ key: C1.payouts[0].key, amountMinor: 207000, payoutDate: '2030-02-06', status: 'complete',
      deposit: { state: 'binding-missing', proof: false, row: null, coveredThrough: null } }]);
  });

  it('lists a lot ordered after today, which a period ending later reaches, as activity counts it: not yet, and never a 500', async () => {
    await start();
    const accounts = seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    // Synthetic only: no stored Walmart date is after New York's today, and the Gold page asks up to today (G1d's latent case).
    importPayload(walmartPayload([walmartBar('later', { date: '2030-04-02' })], { coverage: false }), { accountId: accounts.walmart });
    const period = 'metal=XAU&from=2030-01-01&to=2030-12-31';
    const listed = await get(`/metals/purchases?${period}`);
    expect(listed.status).toBe(200);
    expect((listed.body.purchases as MetalsPurchase[]).map((entry) => entry.orderKey)).toEqual([W3.key, K1.key, W1.key]);
    const counted = await overview(period);
    expect([counted.activity.bought.lots, counted.activity.bought.units]).toEqual([3, 4]);
    // The ledger holds it all the same: the metal counts its line.
    expect(counted.metals).toEqual([{ metal: 'XAU', lots: 4, sales: 1 }]);
  });

  it('answers a period ending after today on every period route as the same period through today: days to come add nothing', async () => {
    await start();
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const later = '2030-12-31';
    /** An answer with its period's end replaced (the overview's is its activity's). */
    const endingOn = (body: Record<string, unknown>, to: string) => ('activity' in body
      ? { ...body, activity: { ...(body.activity as Record<string, unknown>), to } } : { ...body, to });
    for (const route of ['overview?metal=XAU&', 'purchases?metal=XAU&', 'sales?metal=XAU&', 'funding?']) {
      for (const from of ['', 'from=2030-01-01&']) {
        const through = await get(`/metals/${route}${from}to=${TODAY}`);
        const beyond = await get(`/metals/${route}${from}to=${later}`);
        expect([route, from, through.status, beyond.status]).toEqual([route, from, 200, 200]);
        expect(endingOn(beyond.body, TODAY)).toEqual(through.body);
      }
    }
    expect((await overview(`metal=XAU&to=${later}`)).activity.bought.costMinor).toEqual({ value: 805000, state: 'partial',
      reasons: [{ code: 'content-unknown', records: 1 }] });
  });
});

describe('metals reads: New York\'s day across the daylight-saving changes (GD-11)', () => {
  // New York's changes in 2030: to daylight time on Sunday 03-10 at 07:00Z, back to standard time on Sunday 11-03 at
  // 06:00Z. Its midnight is 04:00Z in daylight time and 05:00Z in standard time: at 03:30Z it is still the day before
  // either way, at 04:30Z only in standard time. So 03:30Z tells New York from UTC, and 04:30Z tells it from one fixed
  // offset on either side of each change.
  it.each([
    // [clock, New York's day, the close a read as of that day uses: the weekday before it, since that day's bar never counts]
    ['2030-03-08T03:30:00.000Z', '2030-03-07', '2030-03-06'],
    ['2030-03-08T04:30:00.000Z', '2030-03-07', '2030-03-06'],
    ['2030-03-12T03:30:00.000Z', '2030-03-11', '2030-03-08'],
    ['2030-03-12T04:30:00.000Z', '2030-03-12', '2030-03-11'],
    ['2030-11-01T03:30:00.000Z', '2030-10-31', '2030-10-30'],
    ['2030-11-01T04:30:00.000Z', '2030-11-01', '2030-10-31'],
    ['2030-11-05T03:30:00.000Z', '2030-11-04', '2030-11-01'],
    ['2030-11-05T04:30:00.000Z', '2030-11-04', '2030-11-01'],
  ])('at %s the read\'s day is %s: its as-of day, period end, close (%s), month, and lots ordered by then', async (clock, day, closeDate) => {
    // Prices on: the close a read uses is a stored one only while this Holdr fetches (ROOT O110).
    await start({ ...PRICES_ON, now: new Date(clock) });
    installMetalsSchema(db());
    // A bar ordered on New York's day, and one ordered the day after (UTC's day at 03:30Z).
    const ordered = walmartBar('ny-day', { date: day });
    importPayload(walmartPayload([ordered, walmartBar('ny-next-day', { date: addDays(day, 1) })]), { label: 'Walmart account' });
    seedCloses('XAU', '2030-01-01', '2030-11-29', 2000);
    const read = await overview();
    expect([read.asOf, read.activity.to, read.price.closeDate, read.activity.bought.lots]).toEqual([day, day, closeDate, 1]);
    const asOf = [await get(`/metals/overview?metal=XAU&asOf=${day}`), await get(`/metals/overview?metal=XAU&asOf=${addDays(day, 1)}`)];
    expect(asOf.map((res) => [res.status, res.body.error ?? null])).toEqual([[200, null], [400, 'asOf must not be after today']]);
    const purchases = (await get('/metals/purchases?metal=XAU')).body;
    expect([purchases.to, (purchases.purchases as MetalsPurchase[]).map((entry) => entry.orderKey)]).toEqual([day, [ordered.key]]);
    const months = ((await get('/metals/timeline?metal=XAU')).body as MetalsTimeline).months;
    expect(months.map((month) => [month.month, month.endDate])).toEqual([[day.slice(0, 7), day]]);
  });
});

describe('metals reads: a timeline\'s default months', () => {
  /** The months a timeline answers: its status, how many, the first and the last. */
  const monthsOf = async (query: string) => {
    const res = await get(`/metals/timeline?metal=XAU${query}`);
    const months = res.status === 200 ? (res.body as MetalsTimeline).months.map((month) => month.month) : [];
    return [res.status, months.length, months[0] ?? null, months[months.length - 1] ?? null];
  };

  it('starts at most 240 months back by default, so a metal first ordered longer ago never refuses its own default; a range asked over 240 is a 400', async () => {
    await start();
    const accounts = seedBase();
    // A gold bar ordered 2009-06-15: 250 months through this one (2030-03).
    importPayload(walmartPayload([walmartBar('old', { date: '2009-06-15' })], { coverage: false }), { accountId: accounts.walmart });
    /** The month `count` months before a YYYY-MM month. */
    const monthsBefore = (month: string, count: number) => {
      const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 - count;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    };
    // The 240 months through this one start 239 months before it.
    const first = monthsBefore('2030-03', 239);
    expect(await monthsOf('')).toEqual([200, 240, first, '2030-03']);
    expect(await monthsOf('&toMonth=2025-12')).toEqual([200, 199, '2009-06', '2025-12']);
    expect(await monthsOf(`&fromMonth=${first}`)).toEqual([200, 240, first, '2030-03']);
    expect(await monthsOf(`&fromMonth=${monthsBefore('2030-03', 240)}`)).toEqual([400, 0, null, null]);
    expect(await monthsOf('&fromMonth=2009-06&toMonth=2030-03')).toEqual([400, 0, null, null]);
  });

  it('never starts a default after toMonth: one before the metal\'s first order lists that month alone; a fromMonth asked after it is a 400', async () => {
    await start();
    seedBase();
    expect(await monthsOf('&toMonth=2029-06')).toEqual([200, 1, '2029-06', '2029-06']);
    expect(await monthsOf('&fromMonth=2029-07&toMonth=2029-06')).toEqual([400, 0, null, null]);
  });
});

describe('metals reads: completeness on every measure', () => {
  it('names every reason a figure is not complete, and unknown is never zero', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    const held: MetalsHeldRecord = { key: syntheticKey('walmart', 'order', 'held-1'), channel: 'online', date: '2030-01-05', reason: 'field-unsupported',
      check: 'driver-tip' };
    const undated = walmartBar(5, { date: '2030-01-25', events: [{ kind: 'delivered', date: '2030-01-29', dateBasis: 'year-inferred', quantity: 1, occurrence: 1 }] });
    const walmart = importPayload(walmartPayload([W1, walmartMixed(4, '2030-01-20'), undated, walmartSilver(6, '2030-02-01')], { held: [held], complete: false }),
      { label: 'Walmart account' });
    importPayload(collectpurePayload([coinSale(2, '2030-03-01')]), { label: 'CollectPure account' });
    const costco = importPayload(costcoPayload([K1]), { label: 'Costco membership' });
    // A later capture contradicts the first order's money: it is quarantined until a GO'd supersede.
    const conflict = importReceipt(walmartPayload([walmartBar(1, { date: '2030-01-10', unitMinor: 210000 })], { coverage: false }), { accountId: walmart });
    expect(conflict.orders.conflict).toBe(1);
    seedCloses('XAU', '2029-12-03', '2030-03-08', 2000);

    const gold = await overview();
    const holding = ['content-unknown', 'unmatched-sales', 'conflict', 'date-unknown', 'source-held', 'not-covered'];
    expect(codes(gold.holdings.troyOz)).toEqual(holding);
    expect(codes(gold.holdings.costMinor)).toEqual(['content-unknown', 'unmatched-sales', 'cost-unattributed', 'conflict', 'date-unknown', 'source-held',
      'not-covered']);
    expect(codes(gold.holdings.valueMinor)).toEqual(['content-unknown', 'unmatched-sales', 'conflict', 'date-unknown', 'price-stale', 'source-held',
      'not-covered']);
    expect(gold.holdings.troyOz.state).toBe('partial');
    expect(gold.price).toMatchObject({ closeDate: '2030-03-08', stale: true });
    expect(gold.holdings.units.unmatched).toBe(1);
    expect(gold.toCheck.forInformation.map((entry) => entry.code)).toEqual(['unmatched-sales', 'card-not-linked', 'deposit-not-linked', 'source-held',
      'conflict', 'date-unknown', 'cost-unattributed']);
    expect(gold.toCheck.forInformation).toEqual(expect.arrayContaining([
      { code: 'unmatched-sales', units: 1, reasons: [{ reason: 'no-recorded-purchase', units: 1 }] }, { code: 'conflict', orders: 1 },
      { code: 'date-unknown', records: 1 }, { code: 'cost-unattributed', orders: 1 },
      { code: 'source-held', records: 1, reasons: [{ reason: 'field-unsupported', count: 1 }] },
    ]));
    // A sale with no recorded purchase keeps its proceeds; its result is unknown, never zero.
    expect(gold.activity.profit.valueMinor).toEqual({ value: null, state: 'unknown', reasons: expect.arrayContaining([{ code: 'unmatched-sales', records: 1 }]) });
    expect(gold.activity.profit.coverage).toEqual({ basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 });

    // Sub-figures carry their own share (§8): the bar class its lots' conflict and uncertain delivery date, the metal's
    // unconfirmed content (K1) and the ledger-wide held record and gap; the coin class its unmatched sale; the Walmart
    // account the full reasons of the class it holds lots in; Costco, with no class, its own.
    const classOf = (form: string) => gold.holdings.classes.find((entry) => entry.form === form)!;
    expect(codes(classOf('bar').troyOz)).toEqual(['content-unknown', 'conflict', 'date-unknown', 'source-held', 'not-covered']);
    expect(codes(classOf('bar').costMinor)).toEqual(['content-unknown', 'cost-unattributed', 'conflict', 'date-unknown', 'source-held', 'not-covered']);
    expect(codes(classOf('bar').valueMinor)).toEqual(['content-unknown', 'conflict', 'date-unknown', 'price-stale', 'source-held', 'not-covered']);
    expect(codes(classOf('coin').valueMinor)).toEqual(['content-unknown', 'unmatched-sales', 'conflict', 'price-stale', 'source-held', 'not-covered']);
    const bySource = (accountId: string) => gold.holdings.bySource.find((row) => row.accountId === accountId)!;
    expect(codes(bySource(walmart).troyOz)).toEqual(['content-unknown', 'conflict', 'date-unknown', 'source-held', 'not-covered']);
    expect(bySource(costco).troyOz).toEqual({ value: null, state: 'unknown', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'conflict', records: 1 }] });
    expect(bySource(costco).valueMinor).toMatchObject({ value: null, state: 'unknown' });
    // Silver has no closes at all: its value is unknown (price-missing) while its ounces and cost still show.
    const silver = await overview('metal=XAG');
    expect(silver.holdings.troyOz.value).toEqual(oz('10/1', '10.000'));
    expect(silver.holdings.costMinor.value).toBe(30000);
    expect(silver.holdings.valueMinor).toMatchObject({ value: null, state: 'unknown' });
    expect(codes(silver.holdings.valueMinor)).toContain('price-missing');
    expect(silver.metals.map((entry) => entry.metal)).toEqual(['XAU', 'XAG']);

    const purchases = (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
    expect(purchaseOf(purchases, W1).quarantined).toBe(true);
    expect(purchaseOf(purchases, W1).costMinor).toEqual({ value: 200000, state: 'partial', reasons: [{ code: 'conflict', records: 1 }] });
    expect(purchaseOf(purchases, undated).dateUnknown).toBe(true);
    expect(purchases.find((entry) => entry.orderKey === walmartMixed(4, '2030-01-20').key)!.costMinor.reasons).toEqual([{ code: 'cost-unattributed', records: 1 }]);
  });

  it('marks profit or loss partial when a counted cycle\'s purchase is quarantined, and says so on the cycle', async () => {
    await start(PRICES_ON);
    const accounts = seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    // A later capture contradicts W1's money: W1 is quarantined, and the base sale C1 was assigned W1's bar.
    expect(importReceipt(walmartPayload([walmartBar(1, { date: '2030-01-10', unitMinor: 210000 })], { coverage: false }), { accountId: accounts.walmart })
      .orders.conflict).toBe(1);
    expect((await overview()).activity.profit.valueMinor).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'conflict', records: 1 }] });
    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale.cycles.map((cycle) => [cycle.lotKey, cycle.lotQuarantined])).toEqual([[W1.lines[0].key, true]]);
    expect(sale).toMatchObject({ known: true, dateUnknown: false, purchaseConflict: true, quarantined: false });
  });

  it('marks profit or loss partial when a quarantined lot of the class could change a sale\'s purchases, taken or not', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    // Two bars bought in January, one sold on 02-03 and one on 02-10: first-in, first-out gives the first sale W1's bar
    // and the second W8's.
    const W8 = walmartBar(8, { date: '2030-01-20' });
    const walmart = importPayload(walmartPayload([W1, W8]), { label: 'Walmart account' });
    const second = barSale(12, { date: '2030-02-10' });
    importPayload(collectpurePayload([C1, second]), { label: 'CollectPure account' });
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const early = async () => (await overview('metal=XAU&to=2030-02-04')).activity.profit.valueMinor;
    const later = async () => (await overview('metal=XAU&from=2030-02-05&to=2030-03-20')).activity.profit.valueMinor;
    expect([await early(), await later()]).toEqual([complete(7000), complete(7000)]);
    const contested = (records: number) => ({ value: 7000, state: 'partial', reasons: [{ code: 'conflict', records }] });
    // A later capture contradicts W1: had it held another bar, the second sale would have taken it, not W8's.
    expect(importReceipt(walmartPayload([walmartBar(1, { date: '2030-01-10', unitMinor: 210000 })], { coverage: false }), { accountId: walmart })
      .orders.conflict).toBe(1);
    expect([await early(), await later()]).toEqual([contested(1), contested(1)]);
    let sales = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    const saleOf = (order: MetalsOrder) => sales.find((entry) => entry.orderKey === order.key)!;
    expect(saleOf(second)).toMatchObject({ purchaseConflict: true });
    expect(saleOf(second).cycles.map((cycle) => [cycle.orderKey, cycle.lotQuarantined])).toEqual([[W8.key, false]]);
    // W8 contradicted too: outside the first sale's reach (an earlier W1 served it), yet fail-closed, every sale's profit
    // carries every quarantined purchase of the metal, since the read side never reads the contradicting version.
    expect(importReceipt(walmartPayload([walmartBar(8, { date: '2030-01-20', unitMinor: 210000 })], { coverage: false }), { accountId: walmart })
      .orders.conflict).toBe(1);
    expect([await early(), await later()]).toEqual([contested(2), contested(2)]);
    sales = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect([saleOf(C1).purchaseConflict, saleOf(second).purchaseConflict]).toEqual([true, true]);
  });

  it('fail-closed: one contradicted purchase makes every class, source row and sale of the metal partial, whatever its class, date, account or reach', async () => {
    await start(PRICES_ON);
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const secondAccount = (payload: MetalsImportPayload): MetalsImportPayload => ({ ...payload, account: { folder: 'walmart-2', identityLast4: null } });
    // A gold coin bought on another account on 03-01: after the only sale (02-03), in another class.
    const coins = importPayload(secondAccount(walmartPayload([walmartCoin(31, '2030-03-01')])), { label: 'Second Walmart account' });
    const classCodes = (view: MetalsOverview) => Object.fromEntries(view.holdings.classes.map((entry) => [entry.form, codes(entry.troyOz)]));
    let view = await overview();
    expect(view.activity.profit.valueMinor).toEqual(complete(7000));
    expect(classCodes(view)).toEqual({ bar: ['content-unknown'], coin: ['content-unknown'] });
    // A later capture contradicts the coin's money.
    expect(importReceipt(secondAccount(walmartPayload([walmartCoin(31, '2030-03-01', 220000)], { coverage: false })), { accountId: coins })
      .orders.conflict).toBe(1);
    view = await overview();
    expect(view.activity.profit.valueMinor).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'conflict', records: 1 }] });
    expect(classCodes(view)).toEqual({ bar: ['content-unknown', 'conflict'], coin: ['content-unknown', 'conflict'] });
    // Every source row, its own lots contradicted or not, with or without a class.
    expect(view.holdings.bySource.map((row) => [row.label, codes(row.troyOz), codes(row.costMinor)])).toEqual([
      ['Costco membership', ['content-unknown', 'conflict'], ['content-unknown', 'conflict']],
      ['Second Walmart account', ['content-unknown', 'conflict'], ['content-unknown', 'conflict']],
      ['Walmart account', ['content-unknown', 'conflict'], ['content-unknown', 'conflict']],
    ]);
    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale).toMatchObject({ orderKey: C1.key, purchaseConflict: true, quarantined: false });
    // Holdings as of a day before its order date too: the contradicting version could be dated earlier.
    expect(codes((await overview('metal=XAU&asOf=2030-02-20')).holdings.troyOz)).toContain('conflict');
    // A contradicted purchase can't change what was sold or paid out.
    expect(view.activity.sold.netMinor).toEqual(complete(207000));
    expect(view.activity.payouts.amountMinor).toEqual(complete(207000));
  });

  it('fail-closed: a contradicted order with a line of unknown metal reaches every metal\'s holdings, classes, rows, bought and To-check', async () => {
    await start();
    const accounts = seedBase();
    importPayload(walmartPayload([walmartSilver(6, '2030-02-01'), walmartMetalUnknown(8, '2030-01-20')], { coverage: false }), { accountId: accounts.walmart });
    // A later capture moves the order of unknown metal by a day: it is quarantined, and its other version could be any metal's.
    expect(importReceipt(walmartPayload([walmartMetalUnknown(8, '2030-01-21')], { coverage: false }), { accountId: accounts.walmart }).orders.conflict)
      .toBe(1);
    for (const metal of ['XAU', 'XAG'] as const) {
      const page = await overview(`metal=${metal}`);
      const figures = { classesAndRows: page.holdings.classes.length > 0 && page.holdings.bySource.length > 0, holdings: conflictIn(holdingFigures(page.holdings)),
        bought: conflictIn([page.activity.bought.troyOz, page.activity.bought.costMinor]), toCheck: page.toCheck.forInformation.find((entry) => entry.code === 'conflict') };
      expect([metal, figures]).toEqual([metal, { classesAndRows: true, holdings: 'every', bought: 'every', toCheck: { code: 'conflict', orders: 1 } }]);
    }
    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale).toMatchObject({ orderKey: C1.key, purchaseConflict: true, quarantined: false });
  });

  it('fail-closed by metal: a contradicted order with no line of a metal, in any version, leaves that metal\'s figures alone', async () => {
    await start();
    const accounts = seedBase();
    importPayload(walmartPayload([walmartSilver(6, '2030-02-01')], { coverage: false }), { accountId: accounts.walmart });
    // A later capture moves the silver bar's order by a day: it is quarantined, on the silver page only.
    expect(importReceipt(walmartPayload([walmartSilver(6, '2030-02-02')], { coverage: false }), { accountId: accounts.walmart }).orders.conflict).toBe(1);
    const gold = await overview();
    const figures = { holdings: conflictIn(holdingFigures(gold.holdings)), bought: conflictIn([gold.activity.bought.troyOz, gold.activity.bought.costMinor]),
      profit: conflictIn([gold.activity.profit.valueMinor]), toCheck: gold.toCheck.forInformation.find((entry) => entry.code === 'conflict') ?? null };
    expect(figures).toEqual({ holdings: 'none', bought: 'none', profit: 'none', toCheck: null });
    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale).toMatchObject({ orderKey: C1.key, purchaseConflict: false, quarantined: false });
    expect(conflictIn(holdingFigures((await overview('metal=XAG')).holdings))).toBe('every');
  });

  it('reads the metals of a contradicted order\'s other versions: a silver bar captured again as a gold one reaches the gold page', async () => {
    await start();
    installMetalsSchema(db());
    const walmart = importPayload(walmartPayload([walmartSilver(6, '2030-02-01')]), { label: 'Walmart account' });
    // The active version stays the silver bar; the later capture's gold bar is a conflicting version.
    expect(importReceipt(walmartPayload([walmartBar(6, { date: '2030-02-01' })], { coverage: false }), { accountId: walmart }).orders.conflict).toBe(1);
    const gold = await overview();
    expect([codes(gold.holdings.troyOz), gold.toCheck.forInformation.find((entry) => entry.code === 'conflict')]).toEqual([['conflict'], { code: 'conflict', orders: 1 }]);
    // Another silver bar captured again with a line of unknown metal: that version could be any metal's, gold's too.
    importPayload(walmartPayload([walmartSilver(7, '2030-02-02')], { coverage: false }), { accountId: walmart });
    expect(importReceipt(walmartPayload([walmartMetalUnknown(7, '2030-02-02')], { coverage: false }), { accountId: walmart }).orders.conflict).toBe(1);
    expect((await overview()).toCheck.forInformation.find((entry) => entry.code === 'conflict')).toEqual({ code: 'conflict', orders: 2 });
  });

  it('reads a conflicting version it can\'t take as its order, or a line naming no metal it knows, as of unknown metal: on every page', async () => {
    await start();
    installMetalsSchema(db());
    const [six, seven] = [walmartSilver(6, '2030-02-01'), walmartSilver(7, '2030-02-02')];
    importPayload(walmartPayload([six, seven]), { label: 'Walmart account' });
    // Text the importer would never store: a line without its metal, and a version that isn't an order with lines.
    const { metal: _metal, ...noMetal } = six.lines[0];
    storeConflictingVersion(six.key, JSON.stringify({ ...six, lines: [noMetal] }));
    storeConflictingVersion(seven.key, JSON.stringify({ key: seven.key, lines: 'not lines' }));
    const [xau, xag] = [await get('/metals/overview?metal=XAU'), await get('/metals/overview?metal=XAG')];
    // Both pages answer, whatever the stored versions hold; then each carries the conflict.
    expect([xau.status, xag.status]).toEqual([200, 200]);
    const conflictOn = (res: typeof xau) => (res.body as MetalsOverview).toCheck.forInformation.find((entry) => entry.code === 'conflict') ?? null;
    expect([conflictOn(xau), conflictOn(xag)]).toEqual([{ code: 'conflict', orders: 2 }, { code: 'conflict', orders: 2 }]);
  });

  it('fail-closed: a contradicted sale reaches every timeline month, holdings at any day, every sale and the sell side\'s activity, never bought', async () => {
    await start();
    const accounts = seedBase();
    const later = barSale(12, { date: '2030-02-20' });
    importPayload(collectpurePayload([later]), { accountId: accounts.collectpure });
    // A later capture says it was paid out on 02-27: the sale is quarantined.
    expect(importReceipt(collectpurePayload([barSale(12, { date: '2030-02-20', payoutDate: '2030-02-27' })]), { accountId: accounts.collectpure })
      .orders.conflict).toBe(1);
    // Every month's recorded holdings, though the sale was agreed in February: its other version could be agreed earlier.
    const months = (await get('/metals/timeline?metal=XAU')).body.months as MetalsTimeline['months'];
    expect(months.map((month) => [month.month, conflictIn([month.troyOz, month.costMinor, month.valueMinor])])).toEqual([['2030-01', 'every'], ['2030-02', 'every'], ['2030-03', 'every']]);
    // Holdings as of a day before it, every class and every source account's row.
    const january = (await overview('metal=XAU&asOf=2030-01-31')).holdings;
    expect([january.classes.length > 0 && january.bySource.length > 0, conflictIn(holdingFigures(january))]).toEqual([true, 'every']);
    // The sale says it is contradicted, and its own cost basis and profit carry it (it took one of W3's bars); the other
    // sale's purchases could change.
    const sales = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    const own = (value: number) => ({ value, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'conflict', records: 1 }] });
    expect(sales.find((entry) => entry.orderKey === later.key)).toMatchObject({ quarantined: true, purchaseConflict: false, costMinor: own(200000), profitMinor: own(7000) });
    expect(sales.find((entry) => entry.orderKey === C1.key)).toMatchObject({ quarantined: false, purchaseConflict: true, profitMinor: { value: 7000, state: 'partial', reasons: [{ code: 'conflict', records: 1 }] } });
    // In March, with no sale: what was sold, paid out and realized carries it; what was bought doesn't.
    const march = (await overview('metal=XAU&from=2030-03-01&to=2030-03-20')).activity;
    const contested = { value: 0, state: 'partial', reasons: [{ code: 'conflict', records: 1 }] };
    expect(march.sold.netMinor).toEqual(contested);
    expect(march.payouts).toEqual({ count: 0, amountMinor: contested, mixedMetal: { count: 0, amountMinor: contested } });
    expect(march.profit.valueMinor).toEqual(contested);
    expect(march.bought.costMinor).toEqual(complete(0));
  });

  it('fail-closed by side: a contradicted purchase reaches bought in any period, never sold, payouts or a period\'s profit or loss without a sale', async () => {
    await start();
    const accounts = seedBase();
    expect(importReceipt(walmartPayload([walmartBar(1, { date: '2030-01-10', unitMinor: 210000 })], { coverage: false }), { accountId: accounts.walmart })
      .orders.conflict).toBe(1);
    const march = (await overview('metal=XAU&from=2030-03-01&to=2030-03-20')).activity;
    expect(march.bought.costMinor).toEqual({ value: 0, state: 'partial', reasons: [{ code: 'conflict', records: 1 }] });
    expect(march.profit.valueMinor).toEqual(complete(0));
    expect([march.sold.netMinor, march.payouts.amountMinor, march.payouts.mixedMetal.amountMinor]).toEqual([complete(0), complete(0), complete(0)]);
  });

  it('carries every contradicted order on profit or loss of a period with no sale while a sale is contradicted: its other version could fall in it', async () => {
    await start();
    const accounts = seedBase();
    expect(importReceipt(walmartPayload([walmartBar(1, { date: '2030-01-10', unitMinor: 210000 })], { coverage: false }), { accountId: accounts.walmart })
      .orders.conflict).toBe(1);
    expect(importReceipt(collectpurePayload([barSale(1, { date: '2030-02-03', payoutDate: '2030-02-20' })]), { accountId: accounts.collectpure })
      .orders.conflict).toBe(1);
    const march = (await overview('metal=XAU&from=2030-03-01&to=2030-03-20')).activity;
    expect(march.profit.valueMinor).toEqual({ value: 0, state: 'partial', reasons: [{ code: 'conflict', records: 2 }] });
  });

  it('names a quarantined lot behind a cycle profit doesn\'t count (an incomplete cost)', async () => {
    await start();
    installMetalsSchema(db());
    const walmart = importPayload(walmartPayload([walmartMixed(4, '2030-01-20')]), { label: 'Walmart account' });
    importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    const profit = async () => (await overview()).activity.profit.valueMinor;
    // The sale took the bar of an order whose shipping fee stayed unattributed: its cycle has no complete cost.
    expect(await profit()).toEqual({ value: null, state: 'unknown', reasons: [{ code: 'cost-unattributed', records: 1 }] });
    // A later capture moves that order's date: it is quarantined, and profit names it though no cycle of it counts.
    expect(importReceipt(walmartPayload([walmartMixed(4, '2030-01-21')], { coverage: false }), { accountId: walmart }).orders.conflict).toBe(1);
    expect(await profit()).toEqual({ value: null, state: 'unknown', reasons: [{ code: 'cost-unattributed', records: 1 }, { code: 'conflict', records: 1 }] });
  });

  it('carries the held records and gaps of the buy side up to a sale\'s day on its profit or loss, and on the sale row', async () => {
    await start(PRICES_ON);
    const accounts = seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const profit = async () => (await overview()).activity.profit.valueMinor;
    const saleRow = async () => ((await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[])[0];
    const held = (id: string, date: string): MetalsHeldRecord => ({ key: syntheticKey('walmart', 'order', id), channel: 'online', date,
      reason: 'unreadable', check: 'detail-shape' });
    const heldBy = (value: number) => ({ value, state: 'partial', reasons: [{ code: 'source-held', records: 1 }] });
    // An order that can't be read, dated after the only sale (02-03), can't change its purchases.
    importPayload(walmartPayload([], { coverage: false, held: [held('held-late', '2030-03-01')] }), { accountId: accounts.walmart });
    expect(await saleRow()).toMatchObject({ costMinor: complete(200000), profitMinor: complete(7000), purchaseConflict: false });
    expect(await profit()).toEqual(complete(7000));
    // One dated before it could be an earlier bar, which first-in, first-out would have given the sale: the sale row says so.
    importPayload(walmartPayload([], { coverage: false, held: [held('held-early', '2030-01-05')] }), { accountId: accounts.walmart });
    expect(await saleRow()).toMatchObject({ costMinor: heldBy(200000), profitMinor: heldBy(7000), purchaseConflict: false });
    expect(await profit()).toEqual(heldBy(7000));
  });

  it('carries the unconfirmed content first-in, first-out could reach before a sale: a lot ordered by its day', async () => {
    await start();
    const accounts = seedBase();
    const profit = async () => (await overview()).activity.profit.valueMinor;
    // K1, a bar whose content isn't confirmed, was bought after the only sale (02-03): it can't change its purchases.
    expect(await profit()).toEqual(complete(7000));
    // One bought before it could: confirmed as a 1 ozt bar, first-in, first-out would give the sale that bar, not W1's.
    importPayload(costcoPayload([costcoReceipt('r0', '2030-01-05')]), { accountId: accounts.costco });
    expect(await profit()).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale.profitMinor).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
  });

  it('and a sale of unconfirmed content agreed by its day', async () => {
    await start();
    const accounts = seedBase();
    const february = async () => (await overview('metal=XAU&from=2030-02-01&to=2030-03-20')).activity.profit.valueMinor;
    expect(await february()).toEqual(complete(7000));
    // A sale of a gold bar whose weight isn't stated, agreed 01-20: confirmed, it would take W1's bar before the 02-03 sale.
    importPayload(collectpurePayload([unconfirmedSale(14, '2030-01-20')]), { accountId: accounts.collectpure });
    expect(await february()).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
  });

  it('counts unconfirmed content of the sale\'s own day as able to reach it: a lot bought, then a sale agreed, that day', async () => {
    await start();
    const accounts = seedBase();
    const c1 = async () => ((await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[]).find((entry) => entry.orderKey === C1.key)?.profitMinor;
    expect(await c1()).toEqual(complete(7000));
    // A bar of unconfirmed content bought on 02-03, the day of the sale.
    importPayload(costcoPayload([costcoReceipt('r2', '2030-02-03')]), { accountId: accounts.costco });
    expect(await c1()).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
    // A sale of unconfirmed content agreed that day too.
    importPayload(collectpurePayload([unconfirmedSale(16, '2030-02-03')]), { accountId: accounts.collectpure });
    expect(await c1()).toEqual({ value: 7000, state: 'partial', reasons: [{ code: 'content-unknown', records: 2 }] });
  });

  it('carries a sale\'s own unattributed fees on its fees and net, its row and profit or loss, and lists its payout apart', async () => {
    await start();
    installMetalsSchema(db());
    importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    const sale = saleWithOtherItem(17, '2030-02-03');
    importPayload(collectpurePayload([sale]), { label: 'CollectPure account' });
    const unattributed = (value: number) => ({ value, state: 'partial', reasons: [{ code: 'cost-unattributed', records: 1 }] });
    const { activity } = await overview();
    // Its fee and shipping couldn't be split between the bar and the other item: the bar's net proceeds are approximate.
    expect(activity.sold).toMatchObject({ grossMinor: complete(210000), feesMinor: unattributed(0), netMinor: unattributed(210000) });
    const [row] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(row).toMatchObject({ orderKey: sale.key, costMinor: unattributed(200000), profitMinor: unattributed(210000 - 200000) });
    expect(activity.profit.valueMinor).toEqual(unattributed(210000 - 200000));
    // The sale isn't provably gold alone: its whole payout is listed apart, never in gold's figures.
    expect(activity.payouts).toEqual({ count: 0, amountMinor: complete(0), mixedMetal: { count: 1, amountMinor: complete(212000) } });
  });

  it('carries an open held record of a cancelled sale\'s own key on its row', async () => {
    await start();
    installMetalsSchema(db());
    const cancelled = cancelledSale(15, '2030-02-12');
    const collectpure = importPayload(collectpurePayload([cancelled]), { label: 'CollectPure account' });
    const row = async () => ((await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[]).find((entry) => entry.orderKey === cancelled.key);
    expect(await row()).toMatchObject({ status: 'cancelled', costMinor: complete(0), profitMinor: complete(0) });
    // A later import couldn't read it: it may no longer be cancelled.
    importPayload(syntheticPayload('collectpure', { orders: [], held: [{ key: cancelled.key, channel: 'online', date: '2030-02-12', reason: 'unreadable',
      check: 'detail-shape' }] }), { accountId: collectpure });
    const held = { value: 0, state: 'partial', reasons: [{ code: 'source-held', records: 1 }] };
    expect(await row()).toMatchObject({ costMinor: held, profitMinor: held });
  });

  it('gives a class and a source account their full reasons: the metal\'s unconfirmed content, then a quarantined lot', async () => {
    await start(PRICES_ON);
    const accounts = seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const figures = (holdings: MetalsOverview['holdings']) => holdings.classes.map((entry) => [entry.troyOz, entry.costMinor, entry.valueMinor, entry.gainMinor]);
    // K1's content isn't confirmed yet: it could join the class, so the class's figures are partial.
    const unconfirmed = (value: unknown) => ({ value, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
    expect(figures((await overview()).holdings)).toEqual([[unconfirmed(oz('2/1', '2.000')), unconfirmed(400000), unconfirmed(400000), unconfirmed(0)]]);
    importReceipt(walmartPayload([walmartBar(3, { date: '2030-02-15', quantity: 2, unitMinor: 210000 })], { coverage: false }), { accountId: accounts.walmart });
    const { holdings } = await overview();
    const contested = (value: unknown) => ({ value, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'conflict', records: 1 }] });
    expect(figures(holdings)).toEqual([[contested(oz('2/1', '2.000')), contested(400000), contested(400000), contested(0)]]);
    expect(holdings.bySource.find((row) => row.accountId === accounts.walmart)).toMatchObject({
      units: 2, troyOz: contested(oz('2/1', '2.000')), costMinor: contested(400000), valueMinor: contested(400000),
    });
  });

  it('gives a source account another account\'s gap: one first-in, first-out queue per class runs across accounts', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    const walmart = importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    // The dealer account's sell orders are covered only until ten days ago: a sale in those days could take W1's bar.
    importPayload(syntheticPayload('collectpure', { orders: [], coverage: [syntheticCoverage('sell-orders', '2029-01-01', '2030-03-10', 9, 9),
      syntheticCoverage('payouts', '2029-01-01', '2030-03-10', 9, 9)] }), { label: 'CollectPure account' });
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const { holdings } = await overview();
    const gap = (value: unknown) => ({ value, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] });
    expect(holdings.troyOz).toEqual(gap(oz('1/1', '1.000')));
    expect(holdings.classes.map((entry) => entry.troyOz)).toEqual([gap(oz('1/1', '1.000'))]);
    expect(holdings.bySource).toEqual([expect.objectContaining({ accountId: walmart, units: 1, troyOz: gap(oz('1/1', '1.000')), costMinor: gap(200000),
      valueMinor: gap(200000) })]);
  });

  it('and another buy account\'s held record, uncertain delivery date and quarantine in the class', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    const first = importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    const secondAccount = (payload: MetalsImportPayload): MetalsImportPayload => ({ ...payload, account: { folder: 'walmart-2', identityLast4: null } });
    const second = importPayload(secondAccount(walmartPayload([walmartBar(21, { date: '2030-01-05' })])), { label: 'Second Walmart account' });
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const row = async () => (await overview()).holdings.bySource.find((entry) => entry.accountId === first)!;
    const rowCodes = async () => {
      const found = await row();
      return [codes(found.troyOz), codes(found.costMinor), codes(found.valueMinor)];
    };
    expect(await rowCodes()).toEqual([[], [], []]);
    expect((await row()).troyOz).toEqual({ value: oz('1/1', '1.000'), state: 'complete', reasons: [] });
    // Each is the other account's, never the first's own records.
    importPayload(secondAccount(walmartPayload([], { coverage: false, held: [{ key: syntheticKey('walmart', 'order', 'held-21'), channel: 'online',
      date: '2030-01-06', reason: 'unreadable', check: 'detail-shape' }] })), { accountId: second });
    expect(await rowCodes()).toEqual(Array(3).fill(['source-held']));
    importPayload(secondAccount(walmartPayload([walmartBar(22, { date: '2030-01-07', events: [{ kind: 'delivered', date: '2030-01-11',
      dateBasis: 'year-inferred', quantity: 1, occurrence: 1 }] })], { coverage: false })), { accountId: second });
    expect(await rowCodes()).toEqual(Array(3).fill(['date-unknown', 'source-held']));
    expect(importReceipt(secondAccount(walmartPayload([walmartBar(21, { date: '2030-01-05', unitMinor: 210000 })], { coverage: false })),
      { accountId: second }).orders.conflict).toBe(1);
    expect(await rowCodes()).toEqual(Array(3).fill(['conflict', 'date-unknown', 'source-held']));
  });

  it('starts an account\'s covered history at its earliest stated day, order or held record, not its first complete day', async () => {
    await start();
    installMetalsSchema(db());
    // The first import states 2029-01..06 but admits it missed an order (2 stated, 1 seen); the second covers from 2029-07.
    const walmart = importPayload(syntheticPayload('walmart', { orders: [walmartBar(20, { date: '2029-03-01' })],
      coverage: [syntheticCoverage('online', '2029-01-01', '2029-06-30', 2, 1)] }), { label: 'Walmart account' });
    importPayload(syntheticPayload('walmart', { orders: [], coverage: [syntheticCoverage('online', '2029-07-01', TODAY, 9, 9)] }), { accountId: walmart });
    const sale = barSale(30, { date: '2029-08-01' });
    importPayload(collectpurePayload([sale]), { label: 'CollectPure account' });
    // The missed order could be an earlier bar: what is held today, and the sale's purchases, could differ. No known bar is
    // held, so the ounces are unknown, never a partial zero.
    const missed = (value: unknown) => ({ value, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] });
    expect((await overview()).holdings.troyOz).toEqual({ value: null, state: 'unknown', reasons: [{ code: 'not-covered', records: 1 }] });
    const [row] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(row).toMatchObject({ orderKey: sale.key, costMinor: missed(200000), profitMinor: missed(7000) });
  });

  it('and counts each: a stated range that missed records, an order or an open held record before the first complete range, a kind never covered', async () => {
    await start();
    installMetalsSchema(db());
    const as = (n: number, payload: MetalsImportPayload): MetalsImportPayload => ({ ...payload, account: { folder: n === 1 ? 'walmart' : `walmart-${n}`, identityLast4: null } });
    const fromJuly = syntheticCoverage('online', '2029-07-01', TODAY, 9, 9);
    importPayload(as(1, syntheticPayload('walmart', { coverage: [syntheticCoverage('online', '2029-01-01', '2029-06-30', 1, 0), fromJuly] })),
      { label: 'Walmart account' });
    const second = importPayload(as(2, syntheticPayload('walmart', { orders: [walmartBar(21, { date: '2029-03-01' })] })), { label: 'Second Walmart account' });
    importPayload(as(2, syntheticPayload('walmart', { coverage: [fromJuly] })), { accountId: second });
    importPayload(as(3, syntheticPayload('walmart', { held: [{ key: syntheticKey('walmart', 'order', 'held-22'), channel: 'online', date: '2029-03-01',
      reason: 'unreadable', check: 'detail-shape' }], coverage: [fromJuly] })), { label: 'Third Walmart account' });
    importPayload(as(4, syntheticPayload('walmart', { coverage: [syntheticCoverage('online', '2029-07-01', TODAY, 9, 8)] })), { label: 'Fourth Walmart account' });
    expect((await overview()).holdings.troyOz.reasons).toEqual([{ code: 'source-held', records: 1 }, { code: 'not-covered', records: 4 }]);
    // Before any of it, only the kind never covered completely.
    expect((await overview('metal=XAU&asOf=2028-06-30')).holdings.troyOz.reasons).toEqual([{ code: 'not-covered', records: 1 }]);
  });

  it('carries the sell side\'s gaps on sold money and payouts', async () => {
    await start();
    installMetalsSchema(db());
    importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    importPayload(syntheticPayload('collectpure', { orders: [C1],
      coverage: [syntheticCoverage('sell-orders', '2029-01-01', TODAY, 99, 9), syntheticCoverage('payouts', '2029-01-01', TODAY, 9, 9)] }),
    { label: 'CollectPure account' });
    const { activity } = await overview();
    const gap = (value: number) => ({ value, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] });
    expect(activity.sold).toMatchObject({ grossMinor: gap(210000), feesMinor: gap(3000), netMinor: gap(207000) });
    expect(activity.payouts).toEqual({ count: 1, amountMinor: gap(207000), mixedMetal: { count: 0, amountMinor: gap(0) } });
    expect(activity.profit.valueMinor).toEqual(gap(7000));
  });

  it('keeps a payout of an order mixing metals out of each metal\'s totals, and lists it apart', async () => {
    await start();
    installMetalsSchema(db());
    importPayload(collectpurePayload([C1, mixedSale(5, '2030-02-20')]), { label: 'CollectPure account' });
    const gold = await overview('metal=XAU');
    expect(gold.activity.payouts).toEqual({ count: 1, amountMinor: complete(207000), mixedMetal: { count: 1, amountMinor: complete(240000) } });
    expect(gold.toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked')).toEqual({ code: 'deposit-not-linked', deposits: 1,
      states: [{ state: 'binding-missing', count: 1, coveredThrough: null }], mixedMetal: 1 });
    const silver = await overview('metal=XAG');
    expect(silver.activity.payouts).toEqual({ count: 0, amountMinor: complete(0), mixedMetal: { count: 1, amountMinor: complete(240000) } });
    expect(silver.toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked')).toEqual({ code: 'deposit-not-linked', deposits: 0,
      states: [], mixedMetal: 1 });
    // Sold money is per line, so each metal keeps its own lines' money.
    expect([gold.activity.sold.grossMinor.value, silver.activity.sold.grossMinor.value]).toEqual([420000, 30000]);
  });

  it('carries the held and coverage gaps on those payouts too, and their own orders\' quarantine', async () => {
    await start();
    installMetalsSchema(db());
    const collectpure = importPayload(syntheticPayload('collectpure', { orders: [mixedSale(5, '2030-02-20')],
      coverage: [syntheticCoverage('sell-orders', '2029-01-01', TODAY, 99, 9), syntheticCoverage('payouts', '2029-01-01', TODAY, 9, 9)] }),
    { label: 'CollectPure account' });
    const mixed = async () => (await overview()).activity.payouts.mixedMetal;
    expect(await mixed()).toEqual({ count: 1, amountMinor: { value: 240000, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] } });
    // A later capture contradicts the order's money: it is quarantined, and its payout says so.
    expect(importReceipt(syntheticPayload('collectpure', { orders: [mixedSale(5, '2030-02-20', 31000)] }), { accountId: collectpure }).orders.conflict)
      .toBe(1);
    expect(await mixed()).toEqual({ count: 1, amountMinor: { value: 240000, state: 'partial',
      reasons: [{ code: 'conflict', records: 1 }, { code: 'not-covered', records: 1 }] } });
  });

  it('carries a held sale record from before the period on the period\'s payouts, since its payout can fall after it', async () => {
    await start();
    installMetalsSchema(db());
    const collectpure = importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    // A sale agreed late in February can't be read; its payout would fall in March.
    importPayload(syntheticPayload('collectpure', { orders: [], held: [{ key: syntheticKey('collectpure', 'sell', 'held-9'), channel: 'online',
      date: '2030-02-27', reason: 'unreadable', check: 'detail-shape' }] }), { accountId: collectpure });
    const march = (await overview('metal=XAU&from=2030-03-01&to=2030-03-20')).activity;
    const held = (value: number) => ({ value, state: 'partial', reasons: [{ code: 'source-held', records: 1 }] });
    expect(march.payouts).toEqual({ count: 0, amountMinor: held(0), mixedMetal: { count: 0, amountMinor: held(0) } });
    // What was agreed in March doesn't depend on it.
    expect(march.sold).toMatchObject({ lines: 0, grossMinor: complete(0), netMinor: complete(0) });
  });

  it('needs sell coverage for payouts from the earlier of the period\'s start and the first covered day', async () => {
    await start();
    installMetalsSchema(db());
    // Sell orders are covered from 2029-01-01 and payouts only from 2030-03-01; one sale was agreed before any coverage.
    const collectpure = importPayload(syntheticPayload('collectpure', { orders: [C1],
      coverage: [syntheticCoverage('sell-orders', '2029-01-01', TODAY, 9, 9), syntheticCoverage('payouts', '2030-03-01', TODAY, 9, 9)] }),
    { label: 'CollectPure account' });
    importPayload(syntheticPayload('collectpure', { orders: [barSale(13, { date: '2028-10-02' })] }), { accountId: collectpure });
    const payouts = async (query: string) => (await overview(query)).activity.payouts.amountMinor;
    // (a) A period wholly before coverage began is never "0 complete".
    expect(await payouts('metal=XAU&from=2028-01-01&to=2028-06-30')).toMatchObject({ value: 0, state: 'partial', reasons: [{ code: 'not-covered' }] });
    // (b) Only payouts coverage starts after the period.
    expect(await payouts('metal=XAU&from=2030-02-10&to=2030-02-28')).toEqual({ value: 0, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] });
    // (c) All time, with a sale agreed before coverage began.
    expect(await payouts('metal=XAU')).toEqual({ value: 414000, state: 'partial', reasons: [{ code: 'not-covered', records: 2 }] });
    // (e) Coverage continuous from before the period: complete.
    expect(await payouts('metal=XAU&from=2030-03-05&to=2030-03-20')).toEqual(complete(0));
  });

  it('needs it across a gap between the first covered day and the period\'s start', async () => {
    await start();
    installMetalsSchema(db());
    // Sell orders were covered in the first half of 2029 and again from 2030; payouts throughout.
    importPayload(syntheticPayload('collectpure', { orders: [C1], coverage: [syntheticCoverage('sell-orders', '2029-01-01', '2029-06-30', 9, 9),
      syntheticCoverage('sell-orders', '2030-01-01', TODAY, 9, 9), syntheticCoverage('payouts', '2029-01-01', TODAY, 9, 9)] }),
    { label: 'CollectPure account' });
    // (d) A sale agreed in the gap could be paid in February.
    const february = (await overview('metal=XAU&from=2030-02-01&to=2030-02-28')).activity;
    expect(february.payouts.amountMinor).toEqual({ value: 207000, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] });
  });

  it('never reads a window ending before a kind\'s first covered day, or a kind never covered, as complete: payouts, sold and bought', async () => {
    await start();
    installMetalsSchema(db());
    importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    // Sell orders are covered from 2029-01-01 and payouts from 2030-03-01; one sale was agreed before any coverage.
    importPayload(syntheticPayload('collectpure', { orders: [C1, barSale(13, { date: '2028-10-02' })],
      coverage: [syntheticCoverage('sell-orders', '2029-01-01', TODAY, 9, 9), syntheticCoverage('payouts', '2030-03-01', TODAY, 9, 9)] }),
    { label: 'CollectPure account' });
    // A second dealer account: sell orders covered from 2029-07-01, payouts never.
    importPayload({ ...syntheticPayload('collectpure', { orders: [], coverage: [syntheticCoverage('sell-orders', '2029-07-01', TODAY, 9, 9)] }),
      account: { folder: 'collectpure-2', identityLast4: null } }, { label: 'Second CollectPure account' });
    // All time up to mid-2028: the first sale and the first purchase both fall after it, yet nothing before coverage is known.
    const { activity } = await overview('metal=XAU&to=2028-06-30');
    expect(activity.payouts.amountMinor).toEqual({ value: 0, state: 'partial', reasons: [{ code: 'not-covered', records: 4 }] });
    expect(activity.sold.netMinor).toEqual({ value: 0, state: 'partial', reasons: [{ code: 'not-covered', records: 2 }] });
    expect(activity.bought.costMinor).toEqual({ value: 0, state: 'partial', reasons: [{ code: 'not-covered', records: 1 }] });
  });

  /** A figure's value and state. */
  const shown = (measure: { value: unknown; state: string }) => [measure.value, measure.state];
  const UNKNOWN = [null, 'unknown'];
  const done = (value: unknown) => [value, 'complete'];
  /** Every figure built on held ounces: the metal's (with both awaiting figures), each class's, each source row's and each timeline month's. */
  const heldFigures = async () => {
    const { holdings } = await overview();
    const { months } = (await get('/metals/timeline?metal=XAU')).body as MetalsTimeline;
    return {
      metal: [holdings.troyOz, holdings.costMinor, holdings.valueMinor, holdings.gainMinor, holdings.awaitingTroyOz, holdings.awaitingUnassignedTroyOz]
        .map(shown),
      classes: holdings.classes.map((entry) => [entry.troyOz, entry.costMinor, entry.valueMinor, entry.gainMinor].map(shown)),
      bySource: holdings.bySource.map((row) => [row.troyOz, row.costMinor, row.valueMinor].map(shown)),
      months: months.map((month) => [month.month, ...[month.troyOz, month.costMinor, month.valueMinor].map(shown)]),
    };
  };
  const unknownMonths = (...names: string[]) => names.map((month) => [month, UNKNOWN, UNKNOWN, UNKNOWN]);

  it('reads held ounces as unknown, never a partial zero, when the only known content is a sale\'s, and so every figure built on them', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    // A Costco bar whose content is unknown until confirmed, and a CollectPure sale of a 1 ozt bar, known by its stated
    // mass: the assignment opens a class for the sale, which holds nothing (G1d's P1 at 27b70e7d).
    importPayload(costcoPayload([K1]), { label: 'Costco membership' });
    importPayload(collectpurePayload([barSale(7, { date: '2030-02-20' })]), { label: 'CollectPure account' });
    expect(await heldFigures()).toEqual({ metal: Array(6).fill(UNKNOWN), classes: [Array(4).fill(UNKNOWN)], bySource: [Array(3).fill(UNKNOWN)],
      months: unknownMonths('2030-02', '2030-03') });
    const reasons = [{ code: 'content-unknown', records: 1 }, { code: 'unmatched-sales', records: 1 }];
    expect((await overview()).holdings.troyOz).toEqual({ value: null, state: 'unknown', reasons });

    // A content preview reads the same: confirmed, the sale takes the receipt's bar, and with nothing missing none is held,
    // a true zero; revoking it reads unknown again.
    const route = `/metals/products/${'costco:300001'}/content`;
    const product = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
      .find((row) => row.scope.kind === 'product' && row.scope.ref === 'costco:300001')!;
    const fingerprint = (product.scope as { fingerprint: string }).fingerprint;
    const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    const trueZero = { value: oz('0/1', '0.000'), state: 'complete', reasons: [] };
    expect(preview.body.preview.holdingsTroyOz).toEqual({ before: { value: null, state: 'unknown', reasons }, after: trueZero });
    const written = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: preview.body.preview.digest });
    expect(written.status).toBe(201);
    const undo = await del(`${route}?decision=${written.body.decision.id as string}`);
    expect(undo.body.preview.holdingsTroyOz).toEqual({ before: trueZero, after: { value: null, state: 'unknown', reasons } });
  });

  it('reads them unknown with no lot at all: sales of unknown content, then one of known content too', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    // No purchase, and a sale whose content is unknown (the lead's first shape on real data).
    const collectpure = importPayload(collectpurePayload([unconfirmedSale(9, '2030-02-20')]), { label: 'CollectPure account' });
    expect(await heldFigures()).toEqual({ metal: Array(6).fill(UNKNOWN), classes: [], bySource: [], months: unknownMonths('2030-02', '2030-03') });
    expect(codes((await overview()).holdings.troyOz)).toEqual(['content-unknown']);
    // And a sale of a bar known by its stated mass, with no recorded purchase: its class holds nothing.
    importPayload(collectpurePayload([barSale(7, { date: '2030-02-25' })]), { accountId: collectpure });
    expect(await heldFigures()).toEqual({ metal: Array(6).fill(UNKNOWN), classes: [Array(4).fill(UNKNOWN)], bySource: [],
      months: unknownMonths('2030-02', '2030-03') });
    expect(codes((await overview()).holdings.costMinor)).toEqual(['content-unknown', 'unmatched-sales']);
  });

  it('reads them unknown when sales consume every known lot and more, and a true zero only when nothing is missing', async () => {
    await start(PRICES_ON);
    installMetalsSchema(db());
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    const collectpure = importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    // The bar bought was sold, and every source is covered: none is held, a true zero.
    const none = done(oz('0/1', '0.000'));
    const january = ['2030-01', done(oz('1/1', '1.000')), done(200000), done(200000)];
    expect(await heldFigures()).toEqual({ metal: [none, done(0), done(0), done(0), none, none], classes: [[none, done(0), done(0), done(0)]],
      bySource: [[none, done(0), done(0)]], months: [january, ['2030-02', none, done(0), done(0)], ['2030-03', none, done(0), done(0)]] });
    // A second sale with no recorded purchase (the lead's second shape, a shortfall): the known lot is consumed and a sold
    // unit is unmatched, so what is held can't be told. The units still read as recorded.
    importPayload(collectpurePayload([barSale(12, { date: '2030-02-20' })]), { accountId: collectpure });
    expect(await heldFigures()).toEqual({ metal: Array(6).fill(UNKNOWN), classes: [Array(4).fill(UNKNOWN)], bySource: [Array(3).fill(UNKNOWN)],
      months: [january, ...unknownMonths('2030-02', '2030-03')] });
    expect((await overview()).holdings.units).toMatchObject({ held: 0, unmatched: 1 });
    // A lot of unknown content beside it: still unknown, its cost too, never $0.00 partial.
    importPayload(costcoPayload([K1]), { label: 'Costco membership' });
    const { holdings } = await overview();
    expect([holdings.troyOz.reasons, holdings.costMinor.reasons]).toEqual(Array(2).fill([{ code: 'content-unknown', records: 1 },
      { code: 'unmatched-sales', records: 1 }]));
    expect(await heldFigures()).toEqual({ metal: Array(6).fill(UNKNOWN), classes: [Array(4).fill(UNKNOWN)],
      bySource: [Array(3).fill(UNKNOWN), Array(3).fill(UNKNOWN)], months: [january, ...unknownMonths('2030-02', '2030-03')] });
  });

  it('values a holding that proves it holds nothing at exactly 0, known, with no close stored: zero ounces need no price', async () => {
    await start();
    installMetalsSchema(db());
    // No close is stored. The bar bought was sold, and every source is covered: none is held or awaited, as proven.
    const walmart = importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    const zero = { value: 0, state: 'complete', reasons: [] };
    const missing = { value: null, state: 'unknown', reasons: [{ code: 'price-missing', records: 1 }] };
    /** The metal's value and gain at spot, each class's, and each source row's value. */
    const atSpot = async (query = 'metal=XAU') => {
      const { holdings } = await overview(query);
      return { metal: [holdings.valueMinor, holdings.gainMinor], classes: holdings.classes.map((entry) => [entry.valueMinor, entry.gainMinor]),
        bySource: holdings.bySource.map((row) => row.valueMinor) };
    };
    expect(await atSpot()).toEqual({ metal: [zero, zero], classes: [[zero, zero]], bySource: [zero] });
    // So does a metal with no lot at all, and each month with nothing held; January held the bar, so it needs a price.
    expect(await atSpot('metal=XAG')).toEqual({ metal: [zero, zero], classes: [], bySource: [] });
    const { months } = (await get('/metals/timeline?metal=XAU')).body as MetalsTimeline;
    expect(months.map((month) => [month.month, month.valueMinor])).toEqual([['2030-01', missing], ['2030-02', zero], ['2030-03', zero]]);
    // A unit awaiting delivery is something: the ounces are still a true zero (none delivered and kept), yet the metal's
    // value, its class's and its source row's need a price.
    importPayload(walmartPayload([walmartBar('awaiting', { date: '2030-03-18', events: [] })], { coverage: false }), { accountId: walmart });
    const { holdings } = await overview();
    expect([holdings.troyOz, holdings.units.held, holdings.units.awaiting]).toEqual([{ value: oz('0/1', '0.000'), state: 'complete', reasons: [] }, 0, 1]);
    expect(await atSpot()).toEqual({ metal: [missing, missing], classes: [[missing, missing]], bySource: [missing] });
  });

  it('never proves nothing held beside a lot of unknown content kept: its value and gain stay unknown, for its content and a price', async () => {
    await start();
    installMetalsSchema(db());
    importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    // A Costco bar whose content is unknown until confirmed: in no class, so no class holds a unit, yet it is kept.
    importPayload(costcoPayload([K1]), { label: 'Costco membership' });
    const { holdings } = await overview();
    expect([holdings.units.held, holdings.units.awaiting, holdings.contentUnknown.units]).toEqual([0, 0, 1]);
    const unknown = { value: null, state: 'unknown', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'price-missing', records: 1 }] };
    expect([holdings.valueMinor, holdings.gainMinor, ...holdings.classes.flatMap((entry) => [entry.valueMinor, entry.gainMinor]),
      ...holdings.bySource.map((row) => row.valueMinor)]).toEqual(Array(6).fill(unknown));
  });

  it('never proves nothing held while a lot of unknown metal is kept in the ledger, held or awaiting: it could be any metal\'s', async () => {
    await start();
    installMetalsSchema(db());
    // No close is stored. The gold bar bought was sold: gold holds nothing, as proven, and silver never held any.
    const walmart = importPayload(walmartPayload([W1]), { label: 'Walmart account' });
    importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    const zero = { value: 0, state: 'complete', reasons: [] };
    const missing = { value: null, state: 'unknown', reasons: [{ code: 'price-missing', records: 1 }] };
    /** A page's value and gain at spot, each class's, and each source row's value. */
    const atSpot = async (query: string) => {
      const { holdings } = await overview(query);
      return [holdings.valueMinor, holdings.gainMinor, ...holdings.classes.flatMap((entry) => [entry.valueMinor, entry.gainMinor]),
        ...holdings.bySource.map((row) => row.valueMinor)];
    };
    /** walmartMetalUnknown's two bars of unknown metal, ordered on 2030-02-10, with other events. */
    const unknownMetal = (id: string, events: MetalsEvent[]) => {
      const order = walmartMetalUnknown(id, '2030-02-10');
      return { ...order, lines: [{ ...order.lines[0], events }] };
    };
    const both = (kind: 'cancelled' | 'returned', date: string): MetalsEvent => ({ kind, date, dateBasis: 'stated', quantity: 2, occurrence: 1 });
    // Both cancelled, and both delivered then returned: neither lot is kept, so neither blocks the zero.
    importPayload(walmartPayload([unknownMetal('cancelled', [both('cancelled', '2030-02-11')]),
      unknownMetal('returned', [delivered(2, '2030-02-14'), both('returned', '2030-02-20')])], { coverage: false }), { accountId: walmart });
    expect([await atSpot('metal=XAU'), await atSpot('metal=XAG')]).toEqual([Array(5).fill(zero), Array(2).fill(zero)]);
    // Two ordered on 2030-03-01, one cancelled the next day and one delivered on 2030-03-05: kept, awaiting and then held,
    // it could be either metal's, so neither page proves it holds nothing, and its value and gain need a price again.
    importPayload(walmartPayload([walmartMetalUnknown('kept', '2030-03-01')], { coverage: false }), { accountId: walmart });
    expect([await atSpot('metal=XAU&asOf=2030-03-03'), await atSpot('metal=XAU'), await atSpot('metal=XAG')])
      .toEqual([Array(5).fill(missing), Array(5).fill(missing), Array(2).fill(missing)]);
    // As of each day: before it was ordered nothing blocks; while the returned lot was still kept, it did.
    expect([await atSpot('metal=XAU&asOf=2030-02-28'), await atSpot('metal=XAU&asOf=2030-02-15')]).toEqual([Array(5).fill(zero), Array(5).fill(missing)]);
    // Each timeline month as of its own end: January held the bar, February ended before the kept lot was ordered.
    const { months } = (await get('/metals/timeline?metal=XAU')).body as MetalsTimeline;
    expect(months.map((month) => [month.month, month.valueMinor])).toEqual([['2030-01', missing], ['2030-02', zero], ['2030-03', missing]]);
  });

  it('counts purchases and sales of unknown metal beside the metals, with the cost of the units kept', async () => {
    await start();
    installMetalsSchema(db());
    importPayload(walmartPayload([W1, walmartMetalUnknown(8, '2030-02-05')]), { label: 'Walmart account' });
    importPayload(collectpurePayload([metalUnknownSale(8, '2030-03-02')]), { label: 'CollectPure account' });
    // Two bars of $300.00 each, one cancelled: one unit kept, and its cost.
    const unknown = { lots: 1, units: 1, costMinor: 30000, sales: 1, saleNetMinor: 50000 };
    const gold = await overview('metal=XAU');
    expect(gold.metalUnknown).toEqual(unknown);
    expect((await overview('metal=XAG')).metalUnknown).toEqual(unknown);
    expect(gold.toCheck.forInformation).toEqual(expect.arrayContaining([{ code: 'metal-unknown', records: 2 }]));
    expect(gold.holdings.troyOz).toEqual({ value: oz('1/1', '1.000'), state: 'complete', reasons: [] });
    // The sale of unknown metal is no one metal's: its payout and its unlinked deposit show apart, on every page.
    for (const page of [gold, await overview('metal=XAG'), await overview('metal=XPD')]) {
      expect(page.activity.payouts).toEqual({ count: 0, amountMinor: complete(0), mixedMetal: { count: 1, amountMinor: complete(50000) } });
      expect(page.toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked')).toEqual({ code: 'deposit-not-linked', deposits: 0,
        states: [], mixedMetal: 1 });
    }
    // Before the cancellation both units were on the way.
    expect((await overview('metal=XAU&asOf=2030-02-05')).metalUnknown).toEqual({ ...unknown, units: 2, costMinor: 60000, sales: 0, saleNetMinor: 0 });
  });

  it('replays recorded holdings, cost and value at each month\'s end', async () => {
    await start(PRICES_ON);
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const res = await get('/metals/timeline?metal=XAU');
    expect(res.status).toBe(200);
    const partial = (value: unknown) => ({ value, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
    expect((res.body as MetalsTimeline).months).toEqual([
      { month: '2030-01', endDate: '2030-01-31', recorded: true, troyOz: { value: oz('1/1', '1.000'), state: 'complete', reasons: [] },
        costMinor: complete(200000), valueMinor: complete(200000), closeDate: '2030-01-31' },
      { month: '2030-02', endDate: '2030-02-28', recorded: true, troyOz: partial(oz('2/1', '2.000')), costMinor: partial(400000),
        valueMinor: partial(400000), closeDate: '2030-02-28' },
      { month: '2030-03', endDate: TODAY, recorded: true, troyOz: partial(oz('2/1', '2.000')), costMinor: partial(400000),
        valueMinor: partial(400000), closeDate: '2030-03-19' },
    ]);
    expect((await get('/metals/timeline?metal=XAU&fromMonth=2030-02&toMonth=2030-02')).body.months.map((month: { month: string }) => month.month))
      .toEqual(['2030-02']);
  });

  it('shows a level shift for 30 days after its admission, then no more', async () => {
    await start(PRICES_ON);
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-01-31', 2000);
    seedCloses('XAU', '2030-02-01', '2030-03-19', 2500);
    // Refused on 02-01, 02-04 and 02-05; the fourth close at the new level, on 02-06, is admitted.
    expect((await overview('metal=XAU&asOf=2030-03-08')).price.levelShift).toEqual({ movedOn: '2030-02-01', admittedOn: '2030-02-06', days: 5 });
    expect((await overview('metal=XAU&asOf=2030-03-09')).price.levelShift).toBeNull();
    expect((await overview()).price).toMatchObject({ closeDate: '2030-03-19', close: '2500', levelShift: null });
  });
});

describe('metals reads: held records close when a later import reads their key', () => {
  const competitor = (id: string, date: string, amountMinor: number) => syntheticCompetitor('walmart', 'online', id, date, {
    fulfilment: { shipments: 2 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor }],
    refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amountMinor,
  });
  const held = (key: string, date: string): MetalsHeldRecord => ({ key, channel: 'online', date, reason: 'unreadable', check: 'detail-shape' });
  const openHeld = async () => (await overview()).toCheck.forInformation.find((entry) => entry.code === 'source-held')?.records ?? 0;

  it('as an order, or as an unchanged competitor; an import that doesn\'t list the key leaves its hold open', async () => {
    await start();
    installMetalsSchema(db());
    const c1 = competitor('c1', '2030-01-09', 500000);
    const c2 = competitor('c2', '2030-01-12', 600000);
    const order = walmartBar('h2', { date: '2030-01-20' });
    const walmart = importPayload(walmartPayload([], { coverage: false, competitors: [c1] }), { label: 'Walmart account' });
    importPayload(walmartPayload([], { coverage: false, held: [held(c1.orderKey, '2030-01-09'), held(order.key, '2030-01-20')] }), { accountId: walmart });
    expect(await openHeld()).toBe(2);
    importPayload(walmartPayload([order], { coverage: false }), { accountId: walmart });
    expect(await openHeld()).toBe(1);
    importPayload(walmartPayload([], { coverage: false, competitors: [c2] }), { accountId: walmart });
    expect(await openHeld()).toBe(1);
    // Read again unchanged: its fact-version was stored by the first import, and this import's observation closes the hold.
    importPayload(walmartPayload([], { coverage: false, competitors: [c1, c2] }), { accountId: walmart });
    expect(await openHeld()).toBe(0);
  });
});

describe('metals reads: a sale whose purchase was later cancelled or returned', () => {
  it('shows it sold with no recorded purchase today, and why, while holdings as of before stay as they were', async () => {
    await start();
    installMetalsSchema(db());
    // A 1 ozt bar ordered on 02-01 is still on its way when a bar of its class is sold on 02-10; it is cancelled on 02-20.
    const onTheWay = walmartBar(7, { date: '2030-02-01', events: [{ kind: 'cancelled', date: '2030-02-20', dateBasis: 'stated', quantity: 1, occurrence: 1 }] });
    importPayload(walmartPayload([onTheWay]), { label: 'Walmart account' });
    importPayload(collectpurePayload([barSale(7, { date: '2030-02-10' })]), { label: 'CollectPure account' });
    const later = [{ reason: 'purchase-cancelled-or-returned', units: 1, netMinor: 207000 }];

    const [sale] = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sale.unmatched).toEqual({ units: 1, netMinor: 207000, reasons: later });
    const today = await overview();
    expect(today.activity.sold.unmatched).toEqual({ units: 1, netMinor: 207000, reasons: later });
    expect(today.toCheck.forInformation).toEqual(expect.arrayContaining([
      { code: 'unmatched-sales', units: 1, reasons: [{ reason: 'purchase-cancelled-or-returned', units: 1 }] },
    ]));
    expect(today.holdings.units).toMatchObject({ awaiting: 0, sold: 1, unmatched: 1 });
    // As of a day before the cancellation, the bar on its way covered the sale.
    expect((await overview('metal=XAU&asOf=2030-02-15')).holdings.units).toMatchObject({ awaiting: 1, sold: 1, soldFromAwaiting: 1, unmatched: 0 });
  });
});

describe('metals reads: card and deposit links, computed when read', () => {
  const pairs = (cards: { visa: string; costcoCard: string }): MetalsBindingPair[] => [
    { kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: cards.visa },
    { kind: 'card', source: 'costco', network: 'visa', last4: '3333', accountId: cards.costcoCard },
  ];
  const cardsOf = async () => {
    const purchases = (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
    return (order: MetalsOrder) => purchaseOf(purchases, order).cards.map((card) => [card.state, card.proof, card.row?.id ?? null]);
  };

  it('links a charge through an approved binding, and suspends it when the bound account drifts', async () => {
    await start();
    seedBase();
    const cards = seedCards();
    approve(pairs(cards));
    let state = await cardsOf();
    expect(state(W1)).toEqual([['linked', true, cards.rows.w1]]);
    expect(state(W3)).toEqual([['linked', true, cards.rows.w3]]);
    expect(state(K1)).toEqual([['linked', true, cards.rows.k1]]);
    const linked = purchaseOf((await get('/metals/purchases?metal=XAU')).body.purchases, W1).cards[0];
    expect(linked.row).toEqual({ id: cards.rows.w1, date: '2030-01-11', account: { id: cards.visa, name: 'Sample Visa', ending: '1111', issuer: 'samplebank',
      owner: 'alex' } });
    // The bound account's status changes: suspended until a new approval; back as approved, the link stands again.
    repo.updateCardAccount(cards.visa, { status: 'closed' });
    state = await cardsOf();
    expect(state(W1)).toEqual([['binding-drift', false, null]]);
    expect(state(K1)).toEqual([['linked', true, cards.rows.k1]]);
    repo.updateCardAccount(cards.visa, { status: 'active' });
    expect((await cardsOf())(W1)).toEqual([['linked', true, cards.rows.w1]]);
    // Another account with the same last 4 appears: the binding can't tell them apart any more.
    repo.createCardAccount({ issuer: 'thirdbank', owner: 'joint', last4: '1111', currency: 'USD' });
    state = await cardsOf();
    expect(state(W1)).toEqual([['binding-drift', false, null]]);
    expect(state(W3)).toEqual([['binding-drift', false, null]]);
  });

  it('removes a link when a competitor or a held record bars its row, and when its order is quarantined', async () => {
    await start();
    const accounts = seedBase();
    const cards = seedCards();
    approve(pairs(cards));
    // A two-shipment order on the same card, before the gold order, up to $5,000.00: it bars the January row, not February's.
    importPayload(walmartPayload([], { coverage: false, competitors: [syntheticCompetitor('walmart', 'online', 'c9', '2030-01-09', {
      fulfilment: { shipments: 2 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 500000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 500000,
    })] }), { accountId: accounts.walmart });
    let state = await cardsOf();
    expect(state(W1)).toEqual([['competitor-unknown', false, null]]);
    expect(state(W3)).toEqual([['linked', true, cards.rows.w3]]);
    // An undated held record of the same merchant bars its class at any date.
    importPayload(walmartPayload([], { coverage: false, held: [{ key: null, channel: 'online', date: null, reason: 'unreadable', check: 'detail-shape' }] }),
      { accountId: accounts.walmart });
    state = await cardsOf();
    expect(state(W3)).toEqual([['competitor-held', false, null]]);
    expect(state(K1)).toEqual([['linked', true, cards.rows.k1]]);
    // A later Costco capture contradicts the receipt's money: quarantined, its match is only a candidate.
    importPayload(costcoPayload([costcoReceipt('r1', '2030-02-10', '1', 215000)]), { accountId: accounts.costco });
    const purchases = (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
    expect(purchaseOf(purchases, K1)).toMatchObject({ quarantined: true });
    expect(purchaseOf(purchases, K1).cards.map((card) => [card.state, card.proof, card.row?.id])).toEqual([['ineligible', false, cards.rows.k1]]);
  });

  it('bars a row of any amount for a competitor whose funding contradicts itself', async () => {
    await start();
    const accounts = seedBase();
    const cards = seedCards();
    approve(pairs(cards));
    // The day before the 2-bar order, a card stated at $50.00 against a $10.00 gross total: capped at the gross total it
    // could not bar the $4,000.00 row, but contradictory funding bars any amount in its interval (G1A-05).
    importPayload(walmartPayload([], { coverage: false, competitors: [syntheticCompetitor('walmart', 'online', 'c8', '2030-02-14', {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 5000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 1000,
    })] }), { accountId: accounts.walmart });
    const state = await cardsOf();
    expect(state(W3)).toEqual([['competitor-unknown', false, null]]);
    expect(state(W1)).toEqual([['linked', true, cards.rows.w1]]);
  });

  it('closes a hold when a competitor is read again with other facts, and lets both of its fact-versions contest', async () => {
    await start();
    const accounts = seedBase();
    const cards = seedCards();
    approve(pairs(cards));
    const version = (date: string, amountMinor: number) => syntheticCompetitor('walmart', 'online', 'c7', date, {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amountMinor,
    });
    // One charge of $2,000.00 the day of W1: it contests W1's row.
    const first = version('2030-01-10', 200000);
    importPayload(walmartPayload([], { coverage: false, competitors: [first] }), { accountId: accounts.walmart });
    let state = await cardsOf();
    expect(state(W1)).toEqual([['ambiguous', false, null]]);
    expect(state(W3)).toEqual([['linked', true, cards.rows.w3]]);
    // The order can't be read for a while: its hold bars W3's row.
    importPayload(walmartPayload([], { coverage: false, held: [{ key: first.orderKey, channel: 'online', date: '2030-02-15', reason: 'unreadable',
      check: 'detail-shape' }] }), { accountId: accounts.walmart });
    expect((await cardsOf())(W3)).toEqual([['competitor-held', false, null]]);
    // Read again with other facts (a charge of $4,000.00 the day of W3): the hold closes, and both fact-versions contest.
    importPayload(walmartPayload([], { coverage: false, competitors: [version('2030-02-15', 400000)] }), { accountId: accounts.walmart });
    state = await cardsOf();
    expect(state(W1)).toEqual([['ambiguous', false, null]]);
    expect(state(W3)).toEqual([['ambiguous', false, null]]);
    expect((await overview()).toCheck.forInformation.find((entry) => entry.code === 'source-held')).toBeUndefined();
  });

  it('finds a payout\'s deposit only as possible without reviewed origin texts, and says when checking does not cover it', async () => {
    await start();
    const accounts = seedBase();
    const checking = seedChecking();
    approve([{ kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: checking.account }]);
    importPayload(collectpurePayload([barSale(9, { date: '2030-03-14', payoutDate: '2030-03-18' })]), { accountId: accounts.collectpure });
    const sales = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    const deposit = (order: MetalsOrder) => sales.find((sale) => sale.orderKey === order.key)!.payouts[0].deposit;
    expect(deposit(C1)).toEqual({ state: 'possible', proof: false, coveredThrough: '2030-03-19',
      row: { id: checking.credit, date: '2030-02-07', account: { id: checking.account, name: 'Sample Bank Everyday Checking', ending: '2222' } } });
    expect(deposit(barSale(9, { date: '2030-03-14', payoutDate: '2030-03-18' }))).toEqual({ state: 'not-covered', proof: false, row: null,
      coveredThrough: '2030-03-19' });
    const funding = (await get('/metals/funding')).body;
    expect(funding.deposits).toEqual([{ rowId: checking.credit, saleKey: C1.key, payoutKey: C1.payouts[0].key, state: 'possible', proof: false,
      classification: null }]);
    const toCheck = (await overview()).toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked');
    expect(toCheck).toEqual({ code: 'deposit-not-linked', deposits: 2, states: [{ state: 'not-covered', count: 1, coveredThrough: '2030-03-19' },
      { state: 'possible', count: 1, coveredThrough: null }], mixedMetal: 0 });
  });

  it('links a payout to the one credit in its window that names CollectPure\'s payout origin, and that link classifies it as asset-sale proceeds', async () => {
    await start();
    seedBase();
    const checking = seedChecking([{ postedDate: '2030-02-07', description: 'PM TECHNOLOGIES PO BALANCE' }]);
    const last4 = C1.payouts[0].destinationLast4!;
    approve([{ kind: 'checking', source: 'collectpure', network: null, last4, accountId: checking.account }]);
    const sales = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sales.find((sale) => sale.orderKey === C1.key)!.payouts[0].deposit).toEqual({ state: 'linked', proof: true, coveredThrough: '2030-03-19',
      row: { id: checking.credit, date: '2030-02-07', account: { id: checking.account, name: 'Sample Bank Everyday Checking', ending: last4 } } });
    expect((await get('/metals/funding')).body.deposits).toEqual([{ rowId: checking.credit, saleKey: C1.key, payoutKey: C1.payouts[0].key,
      state: 'linked', proof: true, classification: 'asset-sale-proceeds' }]);
    expect((await overview()).toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked')).toBeUndefined();
  });

  it('links neither of two credits in a payout\'s window that name CollectPure\'s payout origin: ambiguous, with no row, and nothing classified', async () => {
    await start();
    seedBase();
    const checking = seedChecking([
      { postedDate: '2030-02-07', description: 'PM TECHNOLOGIES PO BALANCE' },
      { postedDate: '2030-02-09', description: 'PM Technologies sample credit' },
    ]);
    expect(checking.credits).toHaveLength(2);
    approve([{ kind: 'checking', source: 'collectpure', network: null, last4: C1.payouts[0].destinationLast4!, accountId: checking.account }]);
    const sales = (await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[];
    expect(sales.find((sale) => sale.orderKey === C1.key)!.payouts[0].deposit).toEqual({ state: 'ambiguous', proof: false, row: null,
      coveredThrough: '2030-03-19' });
    expect((await get('/metals/funding')).body.deposits).toEqual([]);
    expect((await overview()).toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked')).toEqual({ code: 'deposit-not-linked',
      deposits: 1, states: [{ state: 'ambiguous', count: 1, coveredThrough: null }], mixedMetal: 0 });
  });

  it('serves P1\'s funding view: funding by kind, receipt-confirmed charges by metal, payouts', async () => {
    await start();
    seedBase();
    const cards = seedCards();
    approve(pairs(cards));
    const funding = (await get('/metals/funding?from=2030-01-01&to=2030-02-28')).body;
    const w1 = funding.purchases.find((entry: { orderKey: string }) => entry.orderKey === W1.key);
    expect(w1).toMatchObject({ fullPriceMinor: 200000, metals: ['XAU'], allMetal: true, quarantined: false, cardEvidence: 'admitted',
      byKind: [{ kind: 'card', methods: 1, amountMinor: 200000 }], receiptCharges: [{ rowId: cards.rows.w1, evidenceClass: 'walmart-order-total@1', metals: ['XAU'] }] });
    expect(funding.purchases.map((entry: { orderKey: string }) => entry.orderKey)).toEqual([W3.key, K1.key, W1.key]);
    expect(funding.sales).toEqual([expect.objectContaining({ orderKey: C1.key, agreedDate: '2030-02-03', netMinor: 207000, metals: ['XAU'] })]);
    expect((await get('/metals/funding?from=2030-03-01&to=2030-03-20')).body).toEqual({ installed: true, from: '2030-03-01', to: '2030-03-20',
      purchases: [], sales: [], deposits: [] });
  });

  it('counts each funding row\'s lines of unknown metal beside the metals it names: a row never lists only its known metals', async () => {
    await start();
    const accounts = seedBase();
    /** A line whose title names two metals: its metal is unknown. */
    const unknownLine = (ordinal: number, productRef: string, unitPriceMinor: number, events: MetalsEvent[]) => ({
      ordinal, title: 'Gold and Silver Sample Refinery Bar', productRef, metal: null, form: 'bar' as const, statedMass: null, pack: 'single' as const,
      purity: null, massBasis: 'unknown' as const, design: null, quantity: 1, unitPriceMinor, events,
    });
    // A Walmart order of a 1 ozt gold bar (walmartBar's line, its key made anew) and a bar of unknown metal; a CollectPure
    // sale of a gold bar (barSale's line) and a bar of unknown metal.
    const [goldBought] = walmartBar('template', { date: '2030-03-02' }).lines;
    const [goldSold] = barSale('template', { date: '2030-03-04' }).lines;
    const bought = syntheticOrder({
      source: 'walmart', channel: 'online', id: 'gold-and-unknown', date: '2030-03-02',
      skeleton: [metalItem(0, 200000), metalItem(1, 30000)],
      components: [{ kind: 'tax', amountMinor: 0 }],
      admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 230000 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 230000 },
      lines: [{ ...goldBought, key: undefined }, { ...unknownLine(1, 'walmart:300001', 30000, [delivered(1, '2030-03-06')]), seller: 'Sample Bullion Shop' }],
    });
    const sold = syntheticOrder({
      source: 'collectpure', channel: 'online', id: 'gold-and-unknown', date: '2030-03-04', tradeMoment: '2030-03-04T15:00:00Z', status: 'complete',
      completedDate: '2030-03-07',
      skeleton: [metalItem(0, 210000), metalItem(1, 50000)],
      payouts: [{ key: syntheticKey('collectpure', 'payout', 'gold-and-unknown'), method: 'ach', destinationLast4: '2222', amountMinor: 260000,
        initiatedDate: '2030-03-07', payoutDate: '2030-03-07', status: 'complete' }],
      lines: [{ ...goldSold, key: undefined }, unknownLine(1, 'collectpure:SKU-SET1', 50000, [agreed('2030-03-04')])],
    });
    const boughtUnknown = walmartMetalUnknown('unknown-only', '2030-03-01');
    const soldUnknown = metalUnknownSale('unknown-only', '2030-03-05');
    const soldTwoMetals = mixedSale('two-metals', '2030-03-06');
    importPayload(walmartPayload([bought, boughtUnknown], { coverage: false }), { accountId: accounts.walmart });
    importPayload(collectpurePayload([sold, soldUnknown, soldTwoMetals]), { accountId: accounts.collectpure });

    const funding = (await get('/metals/funding')).body as MetalsFunding;
    const named = (rows: ReadonlyArray<{ orderKey: string; metals: string[]; metalUnknownLines: number }>, order: MetalsOrder) => {
      const row = rows.find((entry) => entry.orderKey === order.key)!;
      return [row.metals, row.metalUnknownLines];
    };
    const counted = [named(funding.purchases, bought), named(funding.purchases, boughtUnknown), named(funding.purchases, W1),
      named(funding.sales, sold), named(funding.sales, soldUnknown), named(funding.sales, soldTwoMetals), named(funding.sales, C1)];
    expect(counted).toEqual([[['XAU'], 1], [[], 1], [['XAU'], 0], [['XAU'], 1], [[], 1], [['XAG', 'XAU'], 0], [['XAU'], 0]]);
    // Every row says how many lines of unknown metal it has, none included.
    expect([...funding.purchases, ...funding.sales].map((row) => row.metalUnknownLines).reduce((total, count) => total + count, 0)).toBe(4);
  });
});

describe('metals reads: an order held for metals (G3-int A0, ROOT\'s binding condition 1)', () => {
  // A held Walmart order (a flagged line and a gold bar, 2030-01-09) and a held CollectPure sale (a flagged line and a gold
  // bar, paid out $2,070.00 on 2030-02-06, as C1 is). Each counts as the base ledger without it, and is counted as held.
  const HELD = walmartHeld('h1', '2030-01-09', 'XAU', true);
  const HELD_SALE = heldSale('hs1', '2030-02-03');
  const seedHeld = (accounts: { walmart: string; collectpure: string }) => {
    importPayload(walmartPayload([HELD], { coverage: false }), { accountId: accounts.walmart });
    importPayload(collectpurePayload([HELD_SALE]), { accountId: accounts.collectpure });
  };
  const heldOf = (measure: { reasons: Array<{ code: string; records: number }> }) => measure.reasons.find((reason) => reason.code === 'source-held')?.records ?? 0;

  it('counts in no holding: ounces, cost, value, classes, source rows, the unknown blocks and every month stay as without it', async () => {
    await start(PRICES_ON);
    const accounts = seedBase();
    seedCloses('XAU', '2029-12-03', '2030-03-19', 2000);
    const timeline = async () => (await get('/metals/timeline?metal=XAU&fromMonth=2030-01&toMonth=2030-03')).body as MetalsTimeline;
    const values = (view: MetalsOverview) => ({
      troyOz: view.holdings.troyOz.value, cost: view.holdings.costMinor.value, value: view.holdings.valueMinor.value, units: view.holdings.units,
      awaiting: view.holdings.awaitingTroyOz.value, contentUnknown: view.holdings.contentUnknown, metalUnknown: view.metalUnknown, metals: view.metals,
      classes: view.holdings.classes.map((entry) => [entry.key, entry.units, entry.troyOz.value, entry.costMinor.value, entry.valueMinor.value]),
      bySource: view.holdings.bySource.map((row) => [row.accountId, row.units, row.troyOz.value, row.costMinor.value, row.valueMinor.value]),
    });
    const before = await overview();
    const beforeMonths = (await timeline()).months;
    seedHeld(accounts);
    importPayload(costcoPayload([costcoHeld('ch1', '2030-02-12')]), { accountId: accounts.costco });
    const after = await overview();
    expect(values(after)).toEqual(values(before));
    // Counted with the held records instead (Option A: source-held), each order once, on every holding figure it could change.
    expect(after.holdings.troyOz.reasons).toEqual([{ code: 'content-unknown', records: 1 }, { code: 'source-held', records: 3 }]);
    const classesCostValueHeld = [...after.holdings.classes.map((entry) => heldOf(entry.troyOz)), heldOf(after.holdings.costMinor), heldOf(after.holdings.valueMinor)];
    expect(classesCostValueHeld).toEqual([3, 3, 3]);
    // A source row carries its classes' (Walmart, every held order) and its own account's (Costco, whose one lot is in no class).
    const rowHeld = (accountId: string) => heldOf(after.holdings.bySource.find((row) => row.accountId === accountId)!.troyOz);
    expect([rowHeld(accounts.walmart), rowHeld(accounts.costco)]).toEqual([3, 1]);
    // Every month's end, through holdings: the same values, and the orders held by then.
    const afterMonths = (await timeline()).months;
    const monthValues = (months: typeof afterMonths) => months.map((month) => [month.month, month.troyOz.value, month.costMinor.value, month.valueMinor.value]);
    expect(monthValues(afterMonths)).toEqual(monthValues(beforeMonths));
    expect(afterMonths.map((month) => heldOf(month.troyOz))).toEqual([1, 3, 3]);
  });

  it('counts in no activity: bought, sold, profit or loss and payouts, own or apart, stay as without it', async () => {
    await start();
    const accounts = seedBase();
    const values = (activity: MetalsOverview['activity']) => ({
      bought: [activity.bought.lots, activity.bought.units, activity.bought.troyOz.value, activity.bought.costMinor.value],
      sold: [activity.sold.lines, activity.sold.units, activity.sold.troyOz.value, activity.sold.grossMinor.value, activity.sold.netMinor.value,
        activity.sold.unmatched],
      profit: [activity.profit.valueMinor.value, activity.profit.coverage],
      payouts: [activity.payouts.count, activity.payouts.amountMinor.value, activity.payouts.mixedMetal.count, activity.payouts.mixedMetal.amountMinor.value],
    });
    const before = (await overview()).activity;
    seedHeld(accounts);
    const after = (await overview()).activity;
    expect(values(after)).toEqual(values(before));
    // Each side's figures carry its own held order; profit or loss both (the sale's, and the purchase held by its day).
    const sidesHeld = [heldOf(after.bought.troyOz), heldOf(after.sold.grossMinor), heldOf(after.payouts.amountMinor), heldOf(after.payouts.mixedMetal.amountMinor), heldOf(after.profit.valueMinor)];
    expect(sidesHeld).toEqual([1, 1, 1, 1, 2]);
  });

  it('lists it in no purchase, sale, product or funding row, and none of its payouts\' deposits', async () => {
    await start();
    const accounts = seedBase();
    const checking = seedChecking();
    approve([{ kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: checking.account }]);
    const rows = async () => {
      const funding = (await get('/metals/funding')).body;
      return {
        purchases: ((await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[]).map((entry) => entry.key),
        sales: ((await get('/metals/sales?metal=XAU')).body.sales as MetalsSale[]).map((entry) => entry.key),
        products: ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[]).map((row) => JSON.stringify(row.scope)),
        funding: [funding.purchases.map((entry: { orderKey: string }) => entry.orderKey), funding.sales.map((entry: { orderKey: string }) => entry.orderKey),
          funding.deposits],
        deposits: (await overview()).toCheck.forInformation.find((entry) => entry.code === 'deposit-not-linked'),
      };
    };
    const before = await rows();
    seedHeld(accounts);
    expect(await rows()).toEqual(before);
  });

  it('finds nothing to confirm on its lines: a content write naming one, flagged or not, is a 404', async () => {
    await start();
    const accounts = seedBase();
    seedHeld(accounts);
    const [flagged, bar] = HELD.lines;
    const lot = await post(`/metals/lots/${flagged.key}/content`, { evidenceDigest: 'b'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null });
    const product = await post(`/metals/products/${bar.productRef}/content`, { fingerprint: bar.contentFingerprint, metal: 'XAU', troyOzPerUnit: '1',
      preview: null });
    expect([lot.status, product.status]).toEqual([404, 404]);
  });

  it('bars every walmart.com charge in its 30-day window, as a held record does: the January bar\'s no longer links', async () => {
    await start();
    const accounts = seedBase();
    const cards = seedCards();
    approve([{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: cards.visa },
      { kind: 'card', source: 'costco', network: 'visa', last4: '3333', accountId: cards.costcoCard }]);
    const states = async () => {
      const purchases = (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
      return [W1, W3, K1].map((order) => purchaseOf(purchases, order).cards.map((card) => [card.state, card.proof]));
    };
    expect(await states()).toEqual([[['linked', true]], [['linked', true]], [['linked', true]]]);
    seedHeld(accounts);
    // Ordered 2030-01-09: W1's charge (2030-01-11) is in its window, W3's (2030-02-16) isn't; Costco is another class.
    expect(await states()).toEqual([[['competitor-held', false]], [['linked', true]], [['linked', true]]]);
  });

  it('shows each held order\'s flagged lines as needing the owner\'s answer, in To check too, never as held records or metal unknown', async () => {
    await start();
    const accounts = seedBase();
    const before = (await overview()).toCheck;
    seedHeld(accounts);
    const page = await overview();
    const [heldLine] = HELD.lines;
    const [saleLine] = HELD_SALE.lines;
    const evidence = ['shape-with-weight', 'troy-or-metric-weight'];
    const wanted = {
      orders: 2,
      flaggedLines: 2,
      bySource: [{ source: 'walmart', orders: 1, flaggedLines: 1 }, { source: 'collectpure', orders: 1, flaggedLines: 1 }],
      byMerchantClass: [{ merchantClass: 'walmart-online', orders: 1 }],
      items: [
        { lineKey: heldLine.key, orderKey: HELD.key, side: 'buy', account: { accountId: accounts.walmart, source: 'walmart', label: 'Walmart account' },
          date: '2030-01-09', title: FLAGGED_TITLES.XAU, productRef: 'walmart:card-h1', units: 1, amountMinor: 150000, flag: { metal: 'XAU', evidence },
          state: 'needs-your-answer', scope: { kind: 'product', ref: 'walmart:card-h1', fingerprint: heldLine.contentFingerprint }, decision: null,
          orderHeld: true },
        { lineKey: saleLine.key, orderKey: HELD_SALE.key, side: 'sell',
          account: { accountId: accounts.collectpure, source: 'collectpure', label: 'CollectPure account' }, date: '2030-02-03', title: FLAGGED_TITLES.XAU,
          productRef: 'collectpure:SKU-CARD1', units: 1, amountMinor: 7000, flag: { metal: 'XAU', evidence }, state: 'needs-your-answer',
          scope: { kind: 'product', ref: 'collectpure:SKU-CARD1', fingerprint: saleLine.contentFingerprint }, decision: null, orderHeld: true },
      ],
    };
    expect(page.needsAnswer).toEqual(wanted);
    expect(page.toCheck.needsYou).toEqual([{ code: 'bullion-answer', orders: 2, flaggedLines: 2 }, ...before.needsYou]);
    expect(page.toCheck.records).toBe(before.records + 2);
    // The held records' note stays stored records only, and a flagged line is no line of unknown metal.
    expect(page.toCheck.forInformation).toEqual(before.forInformation);
  });

  it('lists a held order on a metal\'s page if and only if it puts the held reason on that metal\'s figures', async () => {
    await start();
    const accounts = seedBase();
    const gold = walmartHeld('g', '2030-01-20', 'XAU', true);
    const several = walmartHeld('n', '2030-01-21', null);
    const silverAndGold = walmartHeld('sg', '2030-01-22', 'XAG', true);
    const silver = walmartHeld('s', '2030-01-23', 'XAG');
    importPayload(walmartPayload([gold, several, silverAndGold, silver], { coverage: false }), { accountId: accounts.walmart });
    // A flag's metal, every metal for a flag naming several, and an unflagged line's own metal.
    const pages: Record<Metal, MetalsOrder[]> = { XAU: [gold, several, silverAndGold], XAG: [several, silverAndGold, silver], XPT: [several], XPD: [several] };
    for (const metal of METALS) {
      const page = await overview(`metal=${metal}`);
      const listed = [...new Set(page.needsAnswer.items.map((item) => item.orderKey))].sort();
      const expected = pages[metal].map((order) => order.key).sort();
      const needsYou = page.toCheck.needsYou.find((item) => item.code === 'bullion-answer');
      const seen = [metal, listed, page.needsAnswer.orders, needsYou, heldOf(page.holdings.troyOz), heldOf(page.activity.bought.troyOz)];
      const counts = { code: 'bullion-answer', orders: expected.length, flaggedLines: expected.length };
      expect(seen).toEqual([metal, expected, expected.length, counts, expected.length, expected.length]);
    }
  });
});

describe('metals reads: a period\'s Bought carries its own holds only, the rewards line\'s gate (PR-R, 5b01e72f)', () => {
  // January 2030 holds only W1 in the base ledger: its Bought is complete. The Gold page's rewards line reads the period's
  // purchases as complete exactly when Bought's cost is; the needs-your-answer list names held orders of any date.
  const JANUARY = 'metal=XAU&from=2030-01-01&to=2030-01-31';
  const heldOf = (measure: { reasons: Array<{ code: string; records: number }> }) => measure.reasons.find((reason) => reason.code === 'source-held')?.records ?? 0;
  const record = (id: string | null, date: string | null): MetalsHeldRecord => ({ key: id === null ? null : syntheticKey('walmart', 'order', id),
    channel: 'online', date, reason: 'unreadable', check: 'detail-shape' });

  it('a held order and a held record dated after the period leave its Bought complete; the order is still listed to answer', async () => {
    await start();
    const accounts = seedBase();
    const before = (await overview(JANUARY)).activity.bought;
    expect([before.costMinor.state, before.troyOz.state]).toEqual(['complete', 'complete']);
    importPayload(walmartPayload([walmartHeld('m1', '2030-03-05', 'XAU', true)], { coverage: false, held: [record('held-m2', '2030-03-06')] }),
      { accountId: accounts.walmart });
    const january = await overview(JANUARY);
    expect(january.activity.bought).toEqual(before);
    expect(january.needsAnswer.orders).toBe(1);
    // All recorded history includes March: both are counted there.
    expect(heldOf((await overview()).activity.bought.costMinor)).toBe(2);
  });

  it('a held order and a held record dated in the period put source-held on its Bought, each once', async () => {
    await start();
    const accounts = seedBase();
    importPayload(walmartPayload([walmartHeld('j1', '2030-01-20', 'XAU', true)], { coverage: false }), { accountId: accounts.walmart });
    let bought = (await overview(JANUARY)).activity.bought;
    expect(bought.costMinor.state).not.toBe('complete');
    expect([heldOf(bought.costMinor), heldOf(bought.troyOz)]).toEqual([1, 1]);
    importPayload(walmartPayload([], { coverage: false, held: [record('held-j2', '2030-01-25')] }), { accountId: accounts.walmart });
    bought = (await overview(JANUARY)).activity.bought;
    expect(bought.costMinor.state).not.toBe('complete');
    expect([heldOf(bought.costMinor), heldOf(bought.troyOz)]).toEqual([2, 2]);
  });

  it('an undated open held record counts in every period: no period\'s Bought is complete while it is open', async () => {
    await start();
    const accounts = seedBase();
    importPayload(walmartPayload([], { coverage: false, held: [record(null, null)] }), { accountId: accounts.walmart });
    for (const query of [JANUARY, 'metal=XAU&from=2030-03-01&to=2030-03-20']) {
      const { costMinor } = (await overview(query)).activity.bought;
      expect(costMinor.state, query).not.toBe('complete');
      expect(heldOf(costMinor), query).toBe(1);
    }
  });
});

describe('metals reads: a purchase\'s merchandise, what its kept units cost before tax, shipping and fees (G4\'s rewards basis)', () => {
  const measure = (value: number, ...reasons: Array<[string, number]>) => ({ value, state: reasons.length > 0 ? 'partial' : 'complete',
    reasons: reasons.map(([code, records]) => ({ code, records })) });
  const purchasesRead = async () => (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
  const lotOf = (purchases: MetalsPurchase[], key: string) => purchases.find((entry) => entry.key === key)!;
  /** A Costco line of one bare-"oz" gold bar per unit (its content waits for the owner's confirmation; its money doesn't). */
  const COSTCO_BAR = { title: 'GOLD BULLION BAR SAMPLE PAMP', metal: 'XAU' as const, form: 'bar' as const, statedMass: { value: '1', unit: 'oz' as const },
    pack: 'single' as const, purity: null, massBasis: null, design: null };
  const card = (amountMinor: number) => ({ kind: 'card' as const, network: 'visa' as const, last4: '3333', amountMinor });

  it('a receipt: each line\'s amount, its coupons and its share of a coupon on the receipt, never the tax or a fee', async () => {
    await start();
    installMetalsSchema(db());
    // One bar, then two bars, with a $100.00 coupon on the second, a $9.00 coupon on the receipt, a $0.50 fee and $12.00
    // tax: over the bases 205000 and 400000 the receipt's coupon is -305 and -595, the fee 17 and 33, the tax 407 and 793.
    const receipt = syntheticOrder({
      source: 'costco', channel: 'warehouse', id: 'mc1', date: '2030-02-12',
      skeleton: [
        metalItem(0, 205000, { taxFlag: 'taxable' }), metalItem(1, 410000, { taxFlag: 'taxable' }), { ...metalItem(2, -10000), kind: 'coupon', couponTarget: 1 },
        { ...otherItem(3, -900), kind: 'coupon' }, { ...otherItem(4, 50), kind: 'fee' },
      ],
      components: [{ kind: 'tax', amountMinor: 1200 }],
      admission: { fulfilment: 'in-store', methods: [card(605350)], refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 605350 },
      lines: [
        { ordinal: 0, ...COSTCO_BAR, productRef: 'costco:300101', quantity: 1, unitPriceMinor: null, events: [inStore(1, '2030-02-12')] },
        { ordinal: 1, ...COSTCO_BAR, productRef: 'costco:300102', quantity: 2, unitPriceMinor: null, events: [inStore(2, '2030-02-12')] },
      ],
    });
    importPayload(costcoPayload([receipt]), { label: 'Costco membership' });
    const purchases = await purchasesRead();
    expect(receipt.lines.map((line) => [lotOf(purchases, line.key).costMinor, lotOf(purchases, line.key).merchandiseMinor]))
      .toEqual([[measure(205119), measure(204695)], [measure(400231), measure(399405)]]);
  });

  it('a mixed order: a discount it can\'t attribute leaves the merchandise partial; a shipping charge it can\'t attribute doesn\'t', async () => {
    await start();
    installMetalsSchema(db());
    // A bar beside another item: the $4.00 coupon on the receipt can't be split between them; the tax is the other item's.
    const receipt = syntheticOrder({
      source: 'costco', channel: 'warehouse', id: 'mc2', date: '2030-02-12',
      skeleton: [metalItem(0, 205000, { taxFlag: 'non-taxable' }), otherItem(1, 3000, { taxFlag: 'taxable' }), { ...otherItem(2, -400), kind: 'coupon' }],
      components: [{ kind: 'tax', amountMinor: 240 }],
      admission: { fulfilment: 'in-store', methods: [card(207840)], refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 207840 },
      lines: [{ ordinal: 0, ...COSTCO_BAR, productRef: 'costco:300103', quantity: 1, unitPriceMinor: null, events: [inStore(1, '2030-02-12')] }],
    });
    importPayload(costcoPayload([receipt]), { label: 'Costco membership' });
    // A bar beside another item whose order-level shipping ($9.99) can't be split between them either.
    const mixed = walmartMixed('mw1', '2030-02-14');
    importPayload(walmartPayload([mixed]), { label: 'Walmart account' });
    const purchases = await purchasesRead();
    const coupon = lotOf(purchases, receipt.lines[0].key);
    const shipping = purchaseOf(purchases, mixed);
    expect([coupon.costMinor, coupon.merchandiseMinor]).toEqual([measure(205000, ['cost-unattributed', 1]), measure(205000, ['cost-unattributed', 1])]);
    expect([shipping.costMinor, shipping.merchandiseMinor]).toEqual([measure(200000, ['cost-unattributed', 1]), measure(200000)]);
  });

  it('an online order: the kept units\' share, earlier units first, of the line\'s amount and discount share; its cost stays the whole line\'s', async () => {
    await start();
    installMetalsSchema(db());
    // Three bars at $2,000.00 with $15.00 shipping, a $3.00 fee on the line, a $2.00 order fee, $48.00 tax and a $10.00
    // discount; one bar cancelled, two delivered and one of them returned, so one bar is kept.
    const order = syntheticOrder({
      source: 'costco', channel: 'online', id: 'mo1', date: '2030-02-01',
      skeleton: [metalItem(0, 600000, { shippingMinor: 1500 }), { ...metalItem(1, 300), kind: 'fee', feeParent: 0 }, { ...otherItem(2, 200), kind: 'fee' }],
      components: [{ kind: 'tax', amountMinor: 4800 }, { kind: 'discount', amountMinor: -1000 }],
      admission: { fulfilment: { shipments: 1 }, methods: [card(605800)], refunded: true, cancelled: false, partlyCancelled: true, grossTotalMinor: 605800 },
      lines: [{
        ordinal: 0, ...COSTCO_BAR, productRef: 'costco:300104', quantity: 3, unitPriceMinor: 200000, events: [
          { kind: 'cancelled', date: '2030-02-02', dateBasis: 'stated', quantity: 1, occurrence: 1 }, delivered(2, '2030-02-05'),
          { kind: 'returned', date: '2030-02-11', dateBasis: 'stated', quantity: 1, occurrence: 1 },
        ],
      }],
    });
    importPayload(costcoPayload([order]), { label: 'Costco membership' });
    const lot = purchaseOf(await purchasesRead(), order);
    // $5,990.00 over three bars is 1996.67, 1996.67 and 1996.66: the kept bar is the first.
    expect([lot.units, lot.costMinor, lot.merchandiseMinor])
      .toEqual([{ ordered: 3, cancelled: 1, returned: 1, delivered: 1, awaiting: 0 }, measure(605800), measure(199667)]);
  });

  it('a quarantined order: conflict on its merchandise, as on its cost', async () => {
    await start();
    const accounts = seedBase();
    // A later capture contradicts W1's money: W1 is quarantined, and its figures are its version in force, partial.
    const contradicted = importReceipt(walmartPayload([walmartBar(1, { date: '2030-01-10', unitMinor: 210000 })], { coverage: false }),
      { accountId: accounts.walmart });
    const lot = purchaseOf(await purchasesRead(), W1);
    expect([contradicted.orders.conflict, lot.quarantined, lot.costMinor, lot.merchandiseMinor])
      .toEqual([1, true, measure(200000, ['conflict', 1]), measure(200000, ['conflict', 1])]);
  });

  it('a lot whose kept units are uncertain: date-unknown on its merchandise; a lot whose delivery date alone is uncertain stays complete', async () => {
    await start();
    installMetalsSchema(db());
    // Two bars, one delivered; the other's cancellation is year-inferred to a day after today, so today counts it nowhere
    // and how many bars are kept is uncertain. Beside it, one bar whose delivery date alone is year-inferred.
    const uncertainOrder = walmartBar('mu1', { date: '2030-03-01', quantity: 2, events: [
      delivered(1, '2030-03-05'), { kind: 'cancelled', date: '2030-03-25', dateBasis: 'year-inferred', quantity: 1, occurrence: 1 },
    ] });
    const inferredDelivery = walmartBar('mu2', { date: '2030-03-01', events: [{ kind: 'delivered', date: '2030-03-05', dateBasis: 'year-inferred', quantity: 1,
      occurrence: 1 }] });
    importPayload(walmartPayload([uncertainOrder, inferredDelivery]), { label: 'Walmart account' });
    // A bar returned on 03-19 but delivered on 03-21, after today: today the return precedes its delivery, so the lifecycle
    // clamps it and can't say whether the bar is kept.
    const clampOrder = syntheticOrder({
      source: 'costco', channel: 'online', id: 'mu3', date: '2030-03-01',
      skeleton: [metalItem(0, 205000, { shippingMinor: 0 })],
      admission: { fulfilment: { shipments: 1 }, methods: [card(205000)], refunded: true, cancelled: false, partlyCancelled: false, grossTotalMinor: 205000 },
      lines: [{ ordinal: 0, ...COSTCO_BAR, productRef: 'costco:300105', quantity: 1, unitPriceMinor: 205000, events: [
        { kind: 'returned', date: '2030-03-19', dateBasis: 'stated', quantity: 1, occurrence: 1 }, delivered(1, '2030-03-21'),
      ] }],
    });
    importPayload(costcoPayload([clampOrder]), { label: 'Costco membership' });
    const purchases = await purchasesRead();
    const uncertain = purchaseOf(purchases, uncertainOrder);
    const clamped = purchaseOf(purchases, clampOrder);
    const deliveryOnly = purchaseOf(purchases, inferredDelivery);
    expect([uncertain.units, uncertain.dateUnknown, uncertain.costMinor, uncertain.merchandiseMinor, deliveryOnly.dateUnknown, deliveryOnly.merchandiseMinor])
      .toEqual([{ ordered: 2, cancelled: 0, returned: 0, delivered: 1, awaiting: 1 }, true, measure(400000), measure(400000, ['date-unknown', 1]), true,
        measure(200000)]);
    expect([clamped.units, clamped.dateUnknown, clamped.costMinor, clamped.merchandiseMinor])
      .toEqual([{ ordered: 1, cancelled: 0, returned: 0, delivered: 0, awaiting: 1 }, true, measure(205000), measure(205000, ['date-unknown', 1])]);
  });

  it('reads the order as every figure reads it: once a line is answered not bullion, the discount it shared can\'t be attributed', async () => {
    await start();
    installMetalsSchema(db());
    // A line the title guard flagged ($1,500.00) beside a gold bar ($2,000.00), with a $35.00 discount, held until answered.
    // As stored, both lines are metal and the discount is split (the bar's share -2000); answered not bullion, it can't be.
    const order = syntheticOrder({
      source: 'walmart', channel: 'online', id: 'md1', date: '2030-02-20',
      skeleton: [metalItem(0, 150000), metalItem(1, 200000)],
      components: [{ kind: 'tax', amountMinor: 0 }, { kind: 'discount', amountMinor: -3500 }],
      admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 346500 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 346500 },
      lines: [
        { ordinal: 0, title: FLAGGED_TITLES.XAU, productRef: 'walmart:card-md1', metal: null, metalUncertain: flagOf('XAU'), form: null, statedMass: null,
          pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 150000, events: [delivered(1, '2030-02-24')],
          seller: 'Sample Bullion Shop' },
        { ordinal: 1, title: BAR_TITLE, productRef: 'walmart:bar-md1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' }, pack: 'single',
          purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 200000,
          events: [delivered(1, '2030-02-24')], seller: 'Sample Bullion Shop' },
      ],
    });
    importPayload(walmartPayload([order]), { label: 'Walmart account' });
    const [flagged, bar] = order.lines;
    expect([bar.costMinor, bar.complete]).toEqual([198000, true]);
    const route = `/metals/products/${flagged.productRef}/bullion`;
    const body = { fingerprint: flagged.contentFingerprint, answer: 'not-bullion' };
    const preview = await post(route, { ...body, preview: null });
    expect((await post(route, { ...body, preview: preview.body.preview.digest })).status).toBe(201);
    const lot = lotOf(await purchasesRead(), bar.key);
    expect([lot.costMinor, lot.merchandiseMinor]).toEqual([measure(200000, ['cost-unattributed', 1]), measure(200000, ['cost-unattributed', 1])]);
  });
});

describe('metals reads: prices', () => {
  it('fetches nothing when prices are off; when on, refreshes only for a signed-in owner and at most every 6 hours', async () => {
    const calls: Array<[Metal, string, string]> = [];
    await start({ metalSpotBars: async (metal, from, to) => {
      calls.push([metal, from, to]);
      return [{ date: '2030-03-19', close: '2000' }];
    } });
    seedBase();
    expect((await service('/metals/overview?metal=XAU')).status).toBe(200);
    expect(calls).toEqual([]);
    const body = await overview();
    expect(calls).toEqual([['XAU', '2029-01-01', '2030-03-19']]);
    expect(body.price).toMatchObject({ fetching: true, closeDate: '2030-03-19', close: '2000', thinHistory: true });
    await overview();
    expect(calls).toHaveLength(1);
  });

  it('never uses today\'s bar, refuses a date two sources disagree on, and notes a level shift', async () => {
    await start(PRICES_ON);
    seedBase();
    seedCloses('XAU', '2029-12-03', '2030-02-28', 2000);
    seedCloses('XAU', '2030-03-01', '2030-03-19', 2500);
    seedCloses('XAU', '2030-03-19', '2030-03-19', 2600, 'other-feed');
    seedCloses('XAU', TODAY, TODAY, 9000);
    expect((await overview()).price).toEqual({ source: 'cnbc-spot-daily', closeDate: '2030-03-18', close: '2500', stale: false, thinHistory: false,
      levelShift: { movedOn: '2030-03-01', admittedOn: '2030-03-06', days: 5 }, fetching: true });
    expect((await overview('metal=XAU&asOf=2030-03-05')).price).toMatchObject({ closeDate: '2030-02-28',
      levelShift: { movedOn: '2030-03-01', admittedOn: null, days: 4 } });
  });

  /**
   * Every Gold read: the overview today, as of a day a level shift is still refused, as of a day with a thin history and
   * over a period, and a metal whose last close is stale; purchases, sales, the timeline, products and funding.
   */
  const GOLD_READS = [
    '/metals/overview?metal=XAU', '/metals/overview?metal=XAU&asOf=2030-03-05', '/metals/overview?metal=XAU&asOf=2029-12-04',
    '/metals/overview?metal=XAU&from=2030-02-01&to=2030-02-28', '/metals/overview?metal=XPT', '/metals/purchases?metal=XAU',
    '/metals/sales?metal=XAU', '/metals/timeline?metal=XAU', '/metals/products?metal=XAU', '/metals/funding',
  ];
  /**
   * The overview's `coverageProof.snapshot` (card check PR-B, design v3.2 §8.3): an opaque token of SQLite's data
   * version, which any write moves, storing a close too. It values nothing, so it alone is masked; every other field of
   * the proof is compared byte for byte.
   */
  const PROOF_SNAPSHOT = /"coverageProof":\{"rule":"metals-coverage-proof-v1","snapshot":"[a-p]{64}"/;
  /** Each Gold read's status and body, byte for byte, in order, but the proof's snapshot token. */
  const goldReads = async () => {
    const answers: string[] = [];
    for (const url of GOLD_READS) {
      const res = await get(url);
      if (url.startsWith('/metals/overview')) expect(res.text).toMatch(PROOF_SNAPSHOT);
      answers.push(`${url} ${res.status} ${res.text.replace(PROOF_SNAPSHOT, '"coverageProof":{"rule":"metals-coverage-proof-v1","snapshot":"<data version>"')}`);
    }
    return answers;
  };
  /** Closes for every price field: a level shift, today's bar, a date two sources disagree on, and platinum's, stale today. */
  const storeCloses = () => {
    seedCloses('XAU', '2029-12-03', '2030-02-28', 2000);
    seedCloses('XAU', '2030-03-01', '2030-03-19', 2500);
    seedCloses('XAU', '2030-03-19', '2030-03-19', 2600, 'other-feed');
    seedCloses('XAU', TODAY, TODAY, 9000);
    seedCloses('XPT', '2029-12-03', '2030-02-28', 900);
  };

  it('values nothing with stored closes while this Holdr doesn\'t fetch: every Gold read answers byte for byte as with none (ROOT O110, R2\')', async () => {
    await start();
    seedBase();
    const none = await goldReads();
    storeCloses();
    expect(db().prepare(`SELECT count(*) FROM symbol_price_bars WHERE symbol LIKE 'holdr:metal:%'`).pluck().get()).toBeGreaterThan(0);
    expect(await goldReads()).toEqual(none);
    // As if no close were stored: no close and none of its notes, `fetching` as it is, each value at spot unknown for want of one.
    const today = await overview();
    expect(today.price).toEqual({ source: 'cnbc-spot-daily', closeDate: null, close: null, stale: false, thinHistory: false, levelShift: null,
      fetching: false });
    expect([today.holdings.valueMinor, today.holdings.gainMinor].map((measure) => [measure.value, codes(measure).includes('price-missing')]))
      .toEqual([[null, true], [null, true]]);
  });

  it('and with prices on, the same closes reach every read that values: each answers otherwise than with none stored', async () => {
    await start(PRICES_ON);
    seedBase();
    const none = await goldReads();
    storeCloses();
    const stored = await goldReads();
    expect(GOLD_READS.filter((_url, index) => stored[index] !== none[index]))
      .toEqual(GOLD_READS.filter((url) => !url.startsWith('/metals/products') && !url.startsWith('/metals/funding')));
  });

  it('with prices on, a refresh answered with nothing new replaces no stored close, the provisional window\'s included (PRICES_ON)', async () => {
    const calls: Array<[Metal, string, string]> = [];
    await start({ metalSpotBars: async (metal, from, to) => {
      calls.push([metal, from, to]);
      return PRICES_ON.metalSpotBars(metal, from, to);
    } });
    seedBase();
    storeCloses();
    const bars = () => db().prepare('SELECT symbol, t, close, source, fetched_at FROM symbol_price_bars ORDER BY symbol, t, source').all();
    const before = bars();
    await goldReads();
    // The history before the first stored close, then the last 7 days, whose stored bars a fresh answer would replace.
    expect(calls).toEqual([['XAU', '2029-01-01', '2029-12-02'], ['XAU', '2030-03-13', '2030-03-19']]);
    expect(bars()).toEqual(before);
  });
});

describe('metals reads: the stored closes (GET /metals/closes), never fetched by this read', () => {
  /** Gold's close on a day: odd days at a half dollar; 03-11 outside gold's band (a price per gram), 03-13 an outlier. */
  const goldClose = (date: string) => ({ '2030-03-11': 65, '2030-03-13': 2600 } as Record<string, number>)[date]
    ?? 2000 + Number(date.slice(8)) + (Number(date.slice(8)) % 2) / 2;
  /** The weekdays from 03-04 to 03-19, later days stored first; a second source disagrees on 03-15, and today has a bar. */
  const seedGold = () => {
    seedCloses('XAU', '2030-03-11', '2030-03-19', goldClose);
    seedCloses('XAU', '2030-03-04', '2030-03-08', goldClose);
    seedCloses('XAU', '2030-03-15', '2030-03-15', 2115.5, 'other-feed');
    seedCloses('XAU', TODAY, TODAY, 2020);
  };
  /** What the screen admits of them, oldest first: never 03-11 (out of band), 03-13 (outlier), 03-15 (conflict) or today's. */
  const ADMITTED = [['2030-03-04', '2004'], ['2030-03-05', '2005.5'], ['2030-03-06', '2006'], ['2030-03-07', '2007.5'], ['2030-03-08', '2008'],
    ['2030-03-12', '2012'], ['2030-03-14', '2014'], ['2030-03-18', '2018'], ['2030-03-19', '2019.5']].map(([date, close]) => ({ date, close }));
  const closesAt = async (query: string) => (await get(`/metals/closes?${query}`)).body as MetalsCloses;
  const datesAt = async (query: string) => (await closesAt(query)).closes.map((entry) => entry.date);

  it('answers the admissible closes stored, oldest first, with fetching false while prices are off: none on a fresh install', async () => {
    await start();
    installMetalsSchema(db());
    expect(await closesAt('metal=XAU')).toEqual({ installed: true, metal: 'XAU', fetching: false, closes: [] });
    seedGold();
    const res = await get('/metals/closes?metal=XAU');
    expect([res.status, res.headers['cache-control'], res.body]).toEqual([200, 'no-store', { installed: true, metal: 'XAU', fetching: false, closes: ADMITTED }]);
    // Gold when no metal is named; another metal's closes are its own.
    expect((await get('/metals/closes')).body).toEqual(res.body);
    expect(await closesAt('metal=XAG')).toEqual({ installed: true, metal: 'XAG', fetching: false, closes: [] });
    // Listed while prices are off, though then they value nothing (ROOT O110): the overview has no close.
    expect((await overview()).price).toMatchObject({ closeDate: null, close: null, fetching: false });
    // The service token may read them too.
    const read = await service('/metals/closes?metal=XAU');
    expect([read.status, read.body]).toEqual([200, res.body]);
  });

  it('lists the days of [from, to], both included, every day without from, and ends on today in New York without to', async () => {
    await start();
    installMetalsSchema(db());
    seedGold();
    expect(await datesAt('metal=XAU&from=2030-03-06&to=2030-03-14')).toEqual(['2030-03-06', '2030-03-07', '2030-03-08', '2030-03-12', '2030-03-14']);
    expect(await datesAt('to=2030-03-07')).toEqual(['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07']);
    expect(await datesAt('from=2030-03-14')).toEqual(['2030-03-14', '2030-03-18', '2030-03-19']);
    // A refused bar's own day lists nothing: out of band, an outlier, two closes in conflict, and today's.
    for (const day of ['2030-03-11', '2030-03-13', '2030-03-15', TODAY]) expect([day, await datesAt(`from=${day}&to=${day}`)]).toEqual([day, []]);
    // Without `to` the period ends today: from today is empty, and from tomorrow comes after its end (400).
    expect(await datesAt(`from=${TODAY}`)).toEqual([]);
    expect((await get(`/metals/closes?from=${addDays(TODAY, 1)}`)).status).toBe(400);
  });

  it('never fetches: no provider call and no refresh on the owner\'s or the service\'s read with prices on, which says fetching', async () => {
    const calls: Array<[Metal, string, string]> = [];
    await start({ metalSpotBars: async (metal, from, to) => {
      calls.push([metal, from, to]);
      return [{ date: '2030-03-18', close: '2000' }, { date: '2030-03-19', close: '2001.25' }];
    } });
    seedBase();
    const refreshes = vi.spyOn(MetalsPriceRefresher.prototype, 'refresh');
    try {
      // Nothing is stored and gold has lines, so an owner's valuing read would fetch at once: this read asks for nothing.
      for (const query of ['', 'metal=XAU', 'metal=XAU&from=2029-01-01', 'from=2030-01-01&to=2030-03-19', ...METALS.map((metal) => `metal=${metal}`)]) {
        const owner = await get(`/metals/closes?${query}`);
        const token = await service(`/metals/closes?${query}`);
        expect([query, owner.status, owner.body.fetching, owner.body.closes, token.status, token.body]).toEqual([query, 200, true, [], 200, owner.body]);
      }
      expect([calls.length, refreshes.mock.calls.length]).toEqual([0, 0]);
      // This Holdr does fetch: the owner's overview stores the closes, and this read answers them, still asking for nothing.
      await overview();
      expect([calls.length, refreshes.mock.calls.length]).toEqual([1, 1]);
      expect(await closesAt('metal=XAU')).toEqual({ installed: true, metal: 'XAU', fetching: true,
        closes: [{ date: '2030-03-18', close: '2000' }, { date: '2030-03-19', close: '2001.25' }] });
      expect([calls.length, refreshes.mock.calls.length]).toEqual([1, 1]);
    } finally {
      refreshes.mockRestore();
    }
  });

  it('needs sign-in, and refuses card data in its query (422) and a malformed metal or date (400), echoing neither', async () => {
    await start();
    installMetalsSchema(db());
    expect((await request(await listenLoopback(app)).get('/metals/closes')).status).toBe(401);
    const cards: Array<[string, string]> = [['/metals/closes?metal=4111111111111111', 'query.metal'], ['/metals/closes?from=4111111111111111', 'query.from'],
      ['/metals/closes?to=4111111111111111', 'query.to'], ['/metals/closes?4111111111111111=XAU', 'query.<key>']];
    for (const [url, path] of cards) {
      const res = await get(url);
      expect([url, res.status, res.body.paths]).toEqual([url, 422, [path]]);
      expect(res.text).not.toContain('4111');
    }
    for (const url of ['/metals/closes?metal=SECRET', '/metals/closes?metal=xau', '/metals/closes?from=2030-13-01', '/metals/closes?from=2030-02-30',
      '/metals/closes?to=SECRET', '/metals/closes?from=2030-03-02&to=2030-03-01', '/metals/closes?asOf=2030-03-01', '/metals/closes?extra=SECRET',
      '/metals/closes?metal=XAU&metal=XAG']) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 400]);
      expect(res.text).not.toContain('SECRET');
    }
  });
});

describe('metals writes: what one ordered unit contains', () => {
  const route = `/metals/products/${'costco:300001'}/content`;
  const k1Row = async () => ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
    .find((row) => row.scope.kind === 'product' && row.scope.ref === 'costco:300001' && row.stated.mass?.value === '1')!;

  it('previews, confirms and revokes a product\'s content; a stale preview is refused', async () => {
    await start();
    seedBase();
    const row = await k1Row();
    expect(row).toMatchObject({ source: 'costco', titles: ['GOLD BULLION BAR SAMPLE PAMP'], pack: 'single', packCount: null, lots: 1, saleLines: 0, units: 1,
      hold: 'unit-unconfirmed', decision: null, drift: false, basis: null, proposal: { metal: 'XAU', troyOzPerUnit: oz('1/1', '1.000') },
      stated: { metal: 'XAU', form: 'bar', mass: { value: '1', unit: 'oz' }, purity: null, massBasis: null, design: null } });
    expect(((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])[0]).toEqual(row);
    const fingerprint = (row.scope as { fingerprint: string }).fingerprint;
    const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ written: false, preview: { lots: 1, units: 1, saleLines: 0 } });
    expect(preview.body.preview.holdingsTroyOz).toEqual({
      before: { value: oz('2/1', '2.000'), state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] },
      after: { value: oz('3/1', '3.000'), state: 'complete', reasons: [] },
    });
    expect((await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '0.5', preview: null })).body.preview.digest).not.toBe(preview.body.preview.digest);
    const written = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1/1', preview: preview.body.preview.digest });
    expect(written.status).toBe(201);
    expect(written.body).toEqual({ written: true, decision: { id: expect.stringMatching(/^mtl-dec-[a-p]{32}$/), metal: 'XAU', troyOzPerUnit: oz('1/1', '1.000'),
      decidedAt: NOW.toISOString() } });
    expect((await overview()).holdings.troyOz).toEqual({ value: oz('3/1', '3.000'), state: 'complete', reasons: [] });
    expect(await k1Row()).toMatchObject({ hold: null, basis: 'owner-confirmed', decision: { id: written.body.decision.id } });
    const stale = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: preview.body.preview.digest });
    expect([stale.status, stale.body.reason]).toEqual([409, 'preview-stale']);

    const id = written.body.decision.id as string;
    const undo = await del(`${route}?decision=${id}`);
    expect(undo.body).toMatchObject({ revoked: false, preview: { lots: 1, units: 1 } });
    expect(undo.body.preview.holdingsTroyOz.after.value).toEqual(oz('2/1', '2.000'));
    const revoked = await del(`${route}?decision=${id}&preview=${undo.body.preview.digest}`);
    expect(revoked.body).toEqual({ revoked: true, decision: { id, revokedAt: NOW.toISOString() } });
    expect((await overview()).holdings.troyOz).toEqual({ value: oz('2/1', '2.000'), state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
    expect((await del(`${route}?decision=${id}`)).status).toBe(404);
  });

  it('previews and revokes a line\'s content on its own route; a revoke preview gone stale on either route is refused, and nothing is revoked', async () => {
    await start();
    const accounts = seedBase();
    const pack = costcoPack('o1', '2030-02-12');
    importPayload(costcoPayload([pack]), { accountId: accounts.costco });
    const scope = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[]).find((entry) => entry.scope.kind === 'lot')!
      .scope as { lotKey: string; evidenceDigest: string };
    const lineRoute = `/metals/lots/${scope.lotKey}/content`;
    const confirm = async (url: string, body: Record<string, unknown>) => {
      const preview = await post(url, { ...body, preview: null });
      return post(url, { ...body, preview: preview.body.preview.digest });
    };
    const lineId = (await confirm(lineRoute, { evidenceDigest: scope.evidenceDigest, metal: 'XAU', troyOzPerUnit: '2' })).body.decision.id as string;
    const fingerprint = ((await k1Row()).scope as { fingerprint: string }).fingerprint;
    const productId = (await confirm(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1' })).body.decision.id as string;
    const live = () => db().prepare('SELECT decision_id FROM metals_owner_decisions WHERE revoked_at IS NULL ORDER BY rowid').pluck().all();
    expect(live()).toEqual([lineId, productId]);
    // Each decision is found on its own route only.
    expect([(await del(`${route}?decision=${lineId}`)).status, (await del(`${lineRoute}?decision=${productId}`)).status]).toEqual([404, 404]);

    const undo = await del(`${lineRoute}?decision=${lineId}`);
    expect([undo.status, undo.body.revoked, undo.body.preview.lots, undo.body.preview.units, undo.body.preview.saleLines]).toEqual([200, false, 1, 1, 0]);
    expect(undo.body.preview.holdingsTroyOz).toEqual({ before: { value: oz('5/1', '5.000'), state: 'complete', reasons: [] },
      after: { value: oz('3/1', '3.000'), state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] } });
    const productUndo = await del(`${route}?decision=${productId}`);
    // A later purchase changes what either revoke would do: both previews are stale, and nothing is revoked.
    importPayload(walmartPayload([walmartBar(5, { date: '2030-03-01' })], { coverage: false }), { accountId: accounts.walmart });
    const stale = [await del(`${lineRoute}?decision=${lineId}&preview=${undo.body.preview.digest}`),
      await del(`${route}?decision=${productId}&preview=${productUndo.body.preview.digest}`)];
    expect(stale.map((res) => [res.status, res.body.reason])).toEqual([[409, 'preview-stale'], [409, 'preview-stale']]);
    expect(live()).toEqual([lineId, productId]);

    // Previewed again, the line's revoke is written: its content is held again, and its decision is found no more.
    const again = await del(`${lineRoute}?decision=${lineId}`);
    expect(again.body.preview.digest).not.toBe(undo.body.preview.digest);
    expect((await del(`${lineRoute}?decision=${lineId}&preview=${again.body.preview.digest}`)).body)
      .toEqual({ revoked: true, decision: { id: lineId, revokedAt: NOW.toISOString() } });
    expect(live()).toEqual([productId]);
    expect(purchaseOf((await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[], pack).content)
      .toMatchObject({ known: false, hold: 'pack-count' });
    expect((await del(`${lineRoute}?decision=${lineId}`)).status).toBe(404);
  });

  it('refuses a malformed revoke on both routes without echoing it: no, a malformed or a repeated decision, an unknown parameter, a malformed preview', async () => {
    await start();
    const accounts = seedBase();
    importPayload(costcoPayload([costcoPack('o1', '2030-02-12')]), { accountId: accounts.costco });
    const lotKey = (((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[]).find((entry) => entry.scope.kind === 'lot')!
      .scope as { lotKey: string }).lotKey;
    const decision = `mtl-dec-${'a'.repeat(32)}`;
    const cases: Array<[string, number, unknown]> = [
      ['', 400, 'decision must be a decision id'],
      ['?decision=SECRET', 400, 'decision must be a decision id'],
      [`?decision=mtl-dec-${'q'.repeat(32)}`, 400, 'decision must be a decision id'],
      [`?decision=${decision}&decision=${decision}`, 400, 'decision must be given once'],
      [`?decision=${decision}&extra=SECRET`, 400, 'unexpected query parameter'],
      [`?decision=${decision}&preview=SECRET`, 400, 'preview must be null or a preview\'s digest'],
      [`?decision=${decision}`, 404, 'decision not found'],
      [`?decision=${decision}&preview=${'a'.repeat(64)}`, 404, 'decision not found'],
      ['?decision=4111111111111111', 422, expect.stringContaining('card data')],
    ];
    for (const base of [route, `/metals/lots/${lotKey}/content`]) {
      for (const [query, status, error] of cases) {
        const res = await del(`${base}${query}`);
        expect([base, query, res.status, res.body.error]).toEqual([base, query, status, error]);
        expect(res.text).not.toMatch(/SECRET|4111/);
      }
    }
    expect(db().prepare('SELECT count(*) FROM metals_owner_decisions').pluck().get()).toBe(0);
  });

  it('gives each decision the next rowid itself, the largest so far plus one, and changes one only by its one-way revoke', async () => {
    await start();
    seedBase();
    // A past decision of another kind at rowid 41, born live and then revoked one way (G2's protected table refuses a row
    // born revoked): the next is 42, whatever the count.
    const actor = `usr_${'c'.repeat(32)}`;
    db().prepare(`INSERT INTO metals_owner_decisions (rowid, decision_id, kind, scope, rule_id, preview_digest, decided_at, decided_by)
      VALUES (41, ?, 'spending-rule', 'rule', 'synthetic-rule', ?, '2030-01-01T00:00:00.000Z', ?)`).run(`mtl-dec-${'a'.repeat(32)}`, 'b'.repeat(64), actor);
    db().prepare(`UPDATE metals_owner_decisions SET revoked_at = '2030-01-02T00:00:00.000Z', revoked_by = ? WHERE rowid = 41`).run(actor);
    const rows = () => db().prepare('SELECT rowid AS seq, * FROM metals_owner_decisions ORDER BY rowid').all() as Array<Record<string, unknown>>;
    const fingerprint = ((await k1Row()).scope as { fingerprint: string }).fingerprint;
    const confirm = async (troyOzPerUnit: string) => {
      const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit, preview: null });
      return post(route, { fingerprint, metal: 'XAU', troyOzPerUnit, preview: preview.body.preview.digest });
    };
    const seeded = rows();
    const first = await confirm('1');
    const one = rows();
    expect([first.status, one.map((row) => [row.seq, row.decision_id])]).toEqual([201, [[41, seeded[0].decision_id], [42, first.body.decision.id]]]);
    // A second confirmation revokes the live one, one way, and appends the next rowid; nothing else of any row changes.
    const second = await confirm('0.5');
    const two = rows();
    const revokedBy = expect.stringMatching(/^usr_[a-p]{32}$/);
    expect([second.status, two]).toEqual([201, [one[0], { ...one[1], revoked_at: NOW.toISOString(), revoked_by: revokedBy },
      expect.objectContaining({ seq: 43, decision_id: second.body.decision.id, revoked_at: null, revoked_by: null })]]);
    // Revoking it is the same one-way change, and no row is ever deleted.
    const id = second.body.decision.id as string;
    const undo = await del(`${route}?decision=${id}`);
    expect((await del(`${route}?decision=${id}&preview=${undo.body.preview.digest}`)).body).toMatchObject({ revoked: true });
    expect(rows()).toEqual([two[0], two[1], { ...two[2], revoked_at: NOW.toISOString(), revoked_by: revokedBy }]);
  });

  it('refuses a write when a conflicting capture arrived after its preview, though the active version is unchanged', async () => {
    await start();
    const accounts = seedBase();
    const fingerprint = ((await k1Row()).scope as { fingerprint: string }).fingerprint;
    const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect(preview.status).toBe(200);
    // A later Costco capture contradicts the receipt's money: the receipt is quarantined, its active version as it was.
    expect(importReceipt(costcoPayload([costcoReceipt('r1', '2030-02-10', '1', 215000)]), { accountId: accounts.costco }).orders.conflict).toBe(1);
    const stale = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: preview.body.preview.digest });
    expect([stale.status, stale.body.reason]).toEqual([409, 'preview-stale']);
    const again = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect(again.body.preview.digest).not.toBe(preview.body.preview.digest);
    expect(again.body.preview.holdingsTroyOz.before.reasons).toEqual([{ code: 'content-unknown', records: 1 }, { code: 'conflict', records: 1 }]);
    expect((await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: again.body.preview.digest })).status).toBe(201);
  });

  it('confirms a pack on its own line, and holds a later purchase whose details differ from a confirmed product', async () => {
    await start();
    const accounts = seedBase();
    const pack = costcoPack('o1', '2030-02-12');
    importPayload(costcoPayload([pack]), { accountId: accounts.costco });
    const row = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[]).find((entry) => entry.scope.kind === 'lot')!;
    expect(row).toMatchObject({ scope: { kind: 'lot', lotKey: pack.lines[0].key, why: 'pack-multiple' }, hold: 'pack-count', proposal: null });
    const scope = row.scope as { lotKey: string; evidenceDigest: string };
    const lotRoute = `/metals/lots/${scope.lotKey}/content`;
    const elsewhere = await post(lotRoute, { evidenceDigest: 'b'.repeat(64), metal: 'XAU', troyOzPerUnit: '2', preview: null });
    expect([elsewhere.status, elsewhere.body.reason]).toEqual([409, 'preview-stale']);
    const preview = await post(lotRoute, { evidenceDigest: scope.evidenceDigest, metal: 'XAU', troyOzPerUnit: '2', preview: null });
    expect(preview.body.preview).toMatchObject({ lots: 1, units: 1 });
    expect((await post(lotRoute, { evidenceDigest: scope.evidenceDigest, metal: 'XAU', troyOzPerUnit: '2', preview: preview.body.preview.digest })).status).toBe(201);
    const purchases = (await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[];
    expect(purchaseOf(purchases, pack).content).toEqual({ known: true, troyOzPerUnit: oz('2/1', '2.000'), troyOz: oz('2/1', '2.000'), basis: 'owner-confirmed' });
    expect((await post(`/metals/lots/${K1.lines[0].key}/content`, { evidenceDigest: 'b'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null })).status)
      .toBe(400);

    // The bar product confirmed; a later receipt under its ref states half an ounce: it counts for nothing until confirmed.
    const bar = await k1Row();
    const fingerprint = (bar.scope as { fingerprint: string }).fingerprint;
    const barPreview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect((await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: barPreview.body.preview.digest })).status).toBe(201);
    importPayload(costcoPayload([costcoReceipt('r2', '2030-03-01', '1/2')]), { accountId: accounts.costco });
    const drifted = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[]).filter((entry) => entry.drift);
    expect(drifted).toEqual([expect.objectContaining({ hold: 'confirmation-drift', decision: null, stated: expect.objectContaining({ mass: { value: '1/2', unit: 'oz' } }) })]);
    expect(await k1Row()).toMatchObject({ hold: null, drift: false, basis: 'owner-confirmed' });
    expect((await overview()).toCheck.needsYou).toEqual([{ code: 'confirmation-drift', products: 1 }]);
    // Confirmed for its own fingerprint, the half-ounce receipt counts, and the first confirmation still answers its line:
    // one ref holds one live decision per fingerprint (#282 951593b4).
    const half = drifted[0].scope as { kind: 'product'; ref: string; fingerprint: string };
    const halfPreview = await post(route, { fingerprint: half.fingerprint, metal: 'XAU', troyOzPerUnit: '1/2', preview: null });
    expect((await post(route, { fingerprint: half.fingerprint, metal: 'XAU', troyOzPerUnit: '1/2', preview: halfPreview.body.preview.digest })).status)
      .toBe(201);
    const confirmed = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
      .filter((entry) => entry.scope.kind === 'product' && entry.scope.ref === 'costco:300001');
    expect(confirmed.map((entry) => [entry.hold, entry.drift, entry.basis])).toEqual([[null, false, 'owner-confirmed'], [null, false, 'owner-confirmed']]);
    expect((await overview()).toCheck.needsYou).toEqual([]);
  });

  it('takes a product ref of up to the contract\'s 80 characters (METALS_PRODUCT_REF_MAX), and refuses one more', async () => {
    await start();
    const accounts = seedBase();
    const longest = `walmart:${'R'.repeat(METALS_PRODUCT_REF_MAX)}`;
    importPayload(walmartPayload([walmartBar(80, { date: '2030-03-02', productRef: longest })], { coverage: false }), { accountId: accounts.walmart });
    const row = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
      .find((entry) => entry.scope.kind === 'product' && entry.scope.ref === longest)!;
    const fingerprint = (row.scope as { fingerprint: string }).fingerprint;
    const preview = await post(`/metals/products/${longest}/content`, { fingerprint, metal: 'XAU', troyOzPerUnit: '1/2', preview: null });
    // Each answer is asserted with its own words: a refused ref (a 404 body, no preview) never reads as a TypeError on the
    // missing preview, and a malformed body's 400 never passes for a refused ref's 404, or the reverse.
    expect([preview.status, preview.body.error, preview.body.preview?.lots]).toEqual([200, undefined, 1]);
    // At the cap the ref is admitted and a malformed body is what's refused (400); one more is refused as a ref first (404).
    const atCap = await post(`/metals/products/${longest}/content`, {});
    expect([atCap.status, atCap.body.error]).toEqual([400, 'body must hold fingerprint, metal, troyOzPerUnit and preview']);
    const over = await post(`/metals/products/walmart:${'R'.repeat(METALS_PRODUCT_REF_MAX + 1)}/content`, {});
    expect([over.status, over.body.error]).toEqual([404, 'product not found']);
  });

  it('refuses malformed requests without echoing them, and logs nothing of value', async () => {
    await start();
    seedBase();
    const fingerprint = 'a'.repeat(64);
    const writes: Array<[string, unknown, number]> = [
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: 'SECRET', preview: null }, 400],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '0', preview: null }, 400],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '10001', preview: null }, 400],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '0.12345678', preview: null }, 400],
      [route, { fingerprint: 'SECRET', metal: 'XAU', troyOzPerUnit: '1', preview: null }, 400],
      [route, { fingerprint, metal: 'SECRET', troyOzPerUnit: '1', preview: null }, 400],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null, extra: 'SECRET' }, 400],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: 'SECRET' }, 400],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null }, 404],
      [`/metals/products/${'SECRET:1'}/content`, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null }, 404],
      [route, { fingerprint, metal: 'XAU', troyOzPerUnit: '4111111111111111', preview: null }, 422],
    ];
    for (const [url, body, status] of writes) {
      const res = await post(url, body);
      expect([url, JSON.stringify(body), res.status]).toEqual([url, JSON.stringify(body), status]);
      expect(res.text).not.toMatch(/SECRET|4111/);
    }
    for (const url of ['/metals/overview?metal=SECRET', '/metals/overview?from=2030-13-01', '/metals/overview?asOf=2031-01-01', '/metals/overview?extra=SECRET',
      '/metals/overview?from=2030-03-02&to=2030-03-01', '/metals/timeline?fromMonth=SECRET', '/metals/timeline?fromMonth=2010-01&toMonth=2030-12',
      '/metals/funding?to=SECRET']) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 400]);
      expect(res.text).not.toContain('SECRET');
    }
    const card = await get('/metals/overview?metal=4111111111111111');
    expect(card.status).toBe(422);
    expect(card.text).not.toContain('4111');
    await overview();
    expect(logs.join('\n')).not.toMatch(/207000|200000|205000|1111|2222|3333|GOLD BAR|Sample/);
  });

  // 10 g in fine troy ounces, exactly: 15 digits around one slash, a card number's length (G4's preview found it refused).
  const GRAMS_10 = '6250000/19439673';

  it('confirms a product\'s exact gram content, though its digits span a card number\'s length; card data elsewhere is still a 422', async () => {
    await start();
    seedBase();
    const fingerprint = ((await k1Row()).scope as { fingerprint: string }).fingerprint;
    const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: GRAMS_10, preview: null });
    const written = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: GRAMS_10, preview: preview.body.preview.digest });
    const elsewhere = await post(route, { fingerprint: '4111111111111111', metal: 'XAU', troyOzPerUnit: GRAMS_10, preview: null });
    expect([preview.status, written.status, written.body.decision?.troyOzPerUnit.exact, elsewhere.status, elsewhere.body.paths])
      .toEqual([200, 201, GRAMS_10, 422, ['$.fingerprint']]);
  });

  it('and a line\'s exact gram content; card data elsewhere in its body is still a 422', async () => {
    await start();
    const accounts = seedBase();
    importPayload(costcoPayload([costcoPack('o1', '2030-02-12')]), { accountId: accounts.costco });
    const scope = ((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[]).find((entry) => entry.scope.kind === 'lot')!
      .scope as { lotKey: string; evidenceDigest: string };
    const lineRoute = `/metals/lots/${scope.lotKey}/content`;
    const preview = await post(lineRoute, { evidenceDigest: scope.evidenceDigest, metal: 'XAU', troyOzPerUnit: GRAMS_10, preview: null });
    const written = await post(lineRoute, { evidenceDigest: scope.evidenceDigest, metal: 'XAU', troyOzPerUnit: GRAMS_10, preview: preview.body.preview.digest });
    const elsewhere = await post(lineRoute, { evidenceDigest: '4111111111111111', metal: 'XAU', troyOzPerUnit: GRAMS_10, preview: null });
    expect([preview.status, written.status, written.body.decision?.troyOzPerUnit.exact, elsewhere.status, elsewhere.body.paths])
      .toEqual([200, 201, GRAMS_10, 422, ['$.evidenceDigest']]);
  });

  it('takes a product ref of the contract\'s full length on its routes, and refuses one character more', async () => {
    await start();
    seedBase();
    // Past the path check a ref reaches the decision lookup; a ref the check refuses is a product not found.
    const decision = `mtl-dec-${'a'.repeat(32)}`;
    const atCap = await del(`/metals/products/collectpure:${'x'.repeat(METALS_PRODUCT_REF_MAX)}/content?decision=${decision}`);
    const over = await del(`/metals/products/collectpure:${'x'.repeat(METALS_PRODUCT_REF_MAX + 1)}/content?decision=${decision}`);
    expect([atCap.status, atCap.body.error, over.status, over.body.error]).toEqual([404, 'decision not found', 404, 'product not found']);
  });
});

describe('metals reads and writes: a flagged line holds its order (v1 replaces v0\'s tripwire)', () => {
  it('never answers flagged-unsupported: with a stored flag every read and write answers as before, and the order waits for the owner\'s answer', async () => {
    await start();
    const accounts = seedBase();
    const contentRoute = `/metals/products/${'costco:300001'}/content`;
    const requests = async () => [await get('/metals/overview?metal=XAU'), await get('/metals/funding'),
      await post(contentRoute, { fingerprint: 'a'.repeat(64), metal: 'XAU', troyOzPerUnit: '1', preview: null }),
      await del(`${contentRoute}?decision=mtl-dec-${'a'.repeat(32)}`)];
    const before = (await requests()).map((res) => res.status);
    // A Walmart line the title guard flagged (contract follow-up 1), stored whole, as G2 stores it.
    const flag: MetalsLineMetalUncertain = { guard: 'metal-guard-v1', evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU' };
    importPayload(walmartPayload([syntheticOrder({
      source: 'walmart', channel: 'online', id: 'f1', date: '2030-01-10', skeleton: [metalItem(0, 200000)],
      components: [{ kind: 'tax', amountMinor: 0 }],
      admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000 },
      lines: [{ ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar Assay Card', productRef: 'walmart:100002', metal: null, metalUncertain: flag,
        form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [delivered(1, '2030-01-14')], seller: 'Sample Bullion Shop' }],
    })]), { accountId: accounts.walmart });
    const after = (await requests()).map((res) => res.status);
    const held = (await get('/metals/overview?metal=XAU')).body as MetalsOverview;
    expect(before).toEqual([200, 200, 404, 404]);
    expect(after).toEqual(before);
    expect(held.needsAnswer.items.map((item) => [item.title, item.flag.metal, item.state])).toEqual([['Sample Refinery 1 ozt Gold Bar Assay Card', 'XAU', 'needs-your-answer']]);
  });
});

describe('metals writes: the owner\'s bullion answers (G3-dec)', () => {
  // A Walmart order of a line the title guard flagged (walmart:card-h1, naming gold) and a gold bar: held until answered.
  const HELD = walmartHeld('h1', '2030-01-09', 'XAU', true);
  const [FLAGGED, HELD_BAR] = HELD.lines;
  const productRoute = `/metals/products/${FLAGGED.productRef}/bullion`;
  const answers = async (metal = 'XAU') => ((await get(`/metals/answers?metal=${metal}`)).body as MetalsAnswers).items;
  const seedHeldOrder = () => {
    const accounts = seedBase();
    importPayload(walmartPayload([HELD], { coverage: false }), { accountId: accounts.walmart });
    return accounts;
  };
  /** The figures of a metal a preview shows that the overview shows too. */
  const shownFigures = (figures: MetalsBullionFigures) => ({ holdingsTroyOz: figures.holdingsTroyOz, holdingsCostMinor: figures.holdingsCostMinor,
    boughtCostMinor: figures.boughtCostMinor, soldNetMinor: figures.soldNetMinor });
  const pageFigures = (page: MetalsOverview) => ({ holdingsTroyOz: page.holdings.troyOz, holdingsCostMinor: page.holdings.costMinor,
    boughtCostMinor: page.activity.bought.costMinor, soldNetMinor: page.activity.sold.netMinor });
  /** Previews an answer, then writes it with the preview's digest (a refused preview is only previewed again: no write). */
  const answer = async (route: string, body: Record<string, unknown>) => {
    const preview = await post(route, { ...body, preview: null });
    return post(route, { ...body, preview: preview.body.preview?.digest ?? null });
  };
  const decisionRows = () => db().prepare('SELECT rowid AS seq, * FROM metals_owner_decisions ORDER BY rowid').all() as Array<Record<string, unknown>>;
  /** A0's display fields of a flagged line's row, the same in every state: G4 names the product an answer, a drift or an undo is for by them. */
  const displayOf = (order: MetalsOrder, line: MetalsOrder['lines'][number], accountId: string) => ({
    lineKey: line.key, orderKey: order.key, side: order.side, account: { accountId, source: 'walmart', label: 'Walmart account' }, date: order.date,
    title: line.title, productRef: line.productRef, units: line.quantity, amountMinor: line.amountMinor,
    flag: { metal: line.metalUncertain?.metal ?? null, evidence: [...(line.metalUncertain?.evidence ?? [])] },
  });
  /**
   * Runs a write past its route and says how it ended: 'written', or the one refusal it may meet, caught as data by its
   * constructor, name and exact words (the allowlist; kill standard §8 and §9a). Anything else is re-thrown as it is, so
   * no other error can pass for the caller's assertion, which the test body makes on this result.
   */
  const writeOutcome = (write: () => unknown, refusal: { type: new () => Error; words: string }): string => {
    try {
      write();
      return 'written';
    } catch (error) {
      const refused = error instanceof refusal.type && error.constructor === refusal.type && error.name === refusal.type.name
        && error.message === refusal.words;
      if (!refused) throw error;
      return error.message;
    }
  };

  it('previews, answers and revokes a product\'s answer: its order joins exactly the figures the preview showed; a stale preview is refused', async () => {
    await start();
    const accounts = seedHeldOrder();
    const fingerprint = FLAGGED.contentFingerprint;
    expect(await answers()).toEqual([{
      lineKey: FLAGGED.key, orderKey: HELD.key, side: 'buy', account: { accountId: accounts.walmart, source: 'walmart', label: 'Walmart account' },
      date: '2030-01-09', title: FLAGGED_TITLES.XAU, productRef: 'walmart:card-h1', units: 1, amountMinor: 150000,
      flag: { metal: 'XAU', evidence: ['shape-with-weight', 'troy-or-metric-weight'] }, state: 'needs-your-answer',
      scope: { kind: 'product', ref: 'walmart:card-h1', fingerprint }, decision: null, orderHeld: true,
    }]);
    const before = await overview();
    const preview = await post(productRoute, { fingerprint, answer: 'bullion', preview: null });
    expect([preview.status, preview.body.written]).toEqual([200, false]);
    const shown = preview.body.preview as MetalsBullionPreview;
    const summary = { lines: shown.lines, units: shown.units, orders: shown.orders, metals: shown.metals.map((entry) => entry.metal),
      metalUnknown: shown.metalUnknown, cardLinks: shown.cardLinks, deposits: shown.deposits };
    expect(summary).toEqual({ lines: 1, units: 1, orders: { before: { held: 1, counted: 0, left: 0 }, after: { held: 0, counted: 1, left: 0 } },
      metals: ['XAU'], metalUnknown: { before: { lots: 0, saleLines: 0 }, after: { lots: 0, saleLines: 0 } }, cardLinks: 1, deposits: 0 });
    // Both of the order's lines join the gold lots; the page shows now exactly what the preview calls before.
    const [gold] = shown.metals;
    expect([gold.before.lots, gold.after.lots, gold.before.saleLines, gold.after.saleLines]).toEqual([3, 5, 1, 1]);
    expect(shownFigures(gold.before)).toEqual(pageFigures(before));
    const written = await post(productRoute, { fingerprint, answer: 'bullion', preview: shown.digest });
    expect(written.status).toBe(201);
    expect(written.body).toEqual({ written: true, decision: { id: expect.stringMatching(/^mtl-dec-[a-p]{32}$/), answer: 'bullion',
      scope: { kind: 'product', ref: 'walmart:card-h1', fingerprint }, decidedAt: NOW.toISOString() } });
    // ... and after the write, exactly what it called after.
    const after = await overview();
    expect([pageFigures(after), after.needsAnswer]).toEqual([shownFigures(gold.after), { orders: 0, flaggedLines: 0, bySource: [], byMerchantClass: [], items: [] }]);
    const id = written.body.decision.id as string;
    const productScope = { kind: 'product', ref: 'walmart:card-h1', fingerprint };
    const row = { ...displayOf(HELD, FLAGGED, accounts.walmart), scope: productScope };
    expect(await answers()).toEqual([{ ...row, state: 'bullion', decision: { id, answer: 'bullion', scope: productScope, decidedAt: NOW.toISOString() },
      orderHeld: false }]);
    const stale = await post(productRoute, { fingerprint, answer: 'bullion', preview: shown.digest });
    expect([stale.status, stale.body.reason]).toEqual([409, 'preview-stale']);
    // Revoked, its line needs an answer again and its order is held as before.
    const undo = await del(`${productRoute}?decision=${id}`);
    expect([undo.status, undo.body.revoked, undo.body.preview?.orders]).toEqual([200, false,
      { before: { held: 0, counted: 1, left: 0 }, after: { held: 1, counted: 0, left: 0 } }]);
    const revoked = await del(`${productRoute}?decision=${id}&preview=${undo.body.preview.digest}`);
    expect(revoked.body).toEqual({ revoked: true, decision: { id, revokedAt: NOW.toISOString() } });
    expect(pageFigures(await overview())).toEqual(pageFigures(before));
    expect(await answers()).toEqual([{ ...row, state: 'needs-your-answer', decision: null, orderHeld: true }]);
    expect((await del(`${productRoute}?decision=${id}`)).status).toBe(404);
  });

  it('answers not bullion: the order is read without the line; with no metal line left, the order leaves the ledger', async () => {
    await start();
    const accounts = seedHeldOrder();
    const alone = walmartFlagged('f2', '2030-02-20');
    importPayload(walmartPayload([alone], { coverage: false }), { accountId: accounts.walmart });
    const lots = async () => ((await get('/metals/purchases?metal=XAU')).body.purchases as MetalsPurchase[])
      .filter((entry) => [HELD.key, alone.key].includes(entry.orderKey)).map((entry) => entry.key);
    expect(await lots()).toEqual([]);
    const heldAnswer = await answer(productRoute, { fingerprint: FLAGGED.contentFingerprint, answer: 'not-bullion' });
    expect(heldAnswer.status).toBe(201);
    expect(await lots()).toEqual([HELD_BAR.key]);
    const [line] = alone.lines;
    const aloneRoute = `/metals/products/${line.productRef}/bullion`;
    const preview = await post(aloneRoute, { fingerprint: line.contentFingerprint, answer: 'not-bullion', preview: null });
    expect(preview.body.preview?.orders).toEqual({ before: { held: 1, counted: 0, left: 0 }, after: { held: 0, counted: 0, left: 1 } });
    const written = await post(aloneRoute, { fingerprint: line.contentFingerprint, answer: 'not-bullion', preview: preview.body.preview.digest });
    expect(written.status).toBe(201);
    const funded = ((await get('/metals/funding')).body.purchases as Array<{ orderKey: string }>).map((entry) => entry.orderKey);
    expect([await lots(), funded.includes(HELD.key), funded.includes(alone.key)]).toEqual([[HELD_BAR.key], true, false]);
    const rowOf = (order: MetalsOrder, decisionId: string) => {
      const [flagged] = order.lines;
      const scope = { kind: 'product', ref: flagged.productRef, fingerprint: flagged.contentFingerprint };
      return { ...displayOf(order, flagged, accounts.walmart), state: 'not-bullion', scope,
        decision: { id: decisionId, answer: 'not-bullion', scope, decidedAt: NOW.toISOString() }, orderHeld: false };
    };
    expect(await answers()).toEqual([rowOf(HELD, heldAnswer.body.decision.id), rowOf(alone, written.body.decision.id)]);
    expect((await overview()).needsAnswer.orders).toBe(0);
  });

  it('answers a line with no product ref on its own lot, pinned to its order\'s evidence; a later capture drifts it until answered again', async () => {
    await start();
    const accounts = seedHeldOrder();
    const shipped: MetalsEvent = { kind: 'shipped', date: '2030-02-21', dateBasis: 'stated', quantity: 1, occurrence: 1 };
    const noRef = walmartFlagged('l1', '2030-02-20', { productRef: null, events: [shipped] });
    importPayload(walmartPayload([noRef], { coverage: false }), { accountId: accounts.walmart });
    const [line] = noRef.lines;
    const lotRoute = `/metals/lots/${line.key}/bullion`;
    const listed = (await answers()).find((item) => item.lineKey === line.key);
    const { evidenceDigest } = (listed?.scope ?? {}) as { evidenceDigest?: string };
    expect([listed?.scope.kind, (listed?.scope as { lotKey?: string } | undefined)?.lotKey, evidenceDigest])
      .toEqual(['lot', line.key, expect.stringMatching(/^[a-p]{64}$/)]);
    // Another digest than the one it is shown with is refused, as a stale preview is; a line with a ref is answered with its product.
    const other = await post(lotRoute, { evidenceDigest: 'b'.repeat(64), answer: 'bullion', preview: null });
    const withRef = await post(`/metals/lots/${FLAGGED.key}/bullion`, { evidenceDigest, answer: 'bullion', preview: null });
    expect([other.status, other.body.reason, withRef.status]).toEqual([409, 'preview-stale', 400]);
    const lotPreview = (await post(lotRoute, { evidenceDigest, answer: 'bullion', preview: null })).body.preview;
    expect([lotPreview?.lines, lotPreview?.orders.after]).toEqual([1, { held: 0, counted: 1, left: 0 }]);
    const written = await answer(lotRoute, { evidenceDigest, answer: 'bullion' });
    expect([written.status, written.body.decision?.scope]).toEqual([201, { kind: 'lot', lotKey: line.key, evidenceDigest }]);
    expect((await answers()).find((item) => item.lineKey === line.key)?.state).toBe('bullion');
    // A later capture progressed the order (delivered since): another active version, so the answer no longer applies.
    const progressed = walmartPayload([walmartFlagged('l1', '2030-02-20', { productRef: null, events: [shipped, delivered(1, '2030-02-24')] })],
      { coverage: false });
    const later = { ...progressed, input: { ...progressed.input, captureDigest: 'c'.repeat(64), capturedAt: '2030-03-01T12:00:00Z' } } as MetalsImportPayload;
    expect(importReceipt(later, { accountId: accounts.walmart }).orders.progression).toBe(1);
    const drifted = (await answers()).find((item) => item.lineKey === line.key);
    const newDigest = (drifted?.scope as { evidenceDigest?: string } | undefined)?.evidenceDigest;
    expect(newDigest === evidenceDigest).toBe(false);
    expect(drifted).toEqual({ ...displayOf(noRef, line, accounts.walmart), state: 'drift', scope: { kind: 'lot', lotKey: line.key, evidenceDigest: newDigest },
      decision: { id: written.body.decision.id, answer: 'bullion', scope: { kind: 'lot', lotKey: line.key, evidenceDigest }, decidedAt: NOW.toISOString() },
      orderHeld: true });
    // Answered again on the new evidence: the drifted answer is revoked one way and the new one appended.
    const again = await answer(lotRoute, { evidenceDigest: newDigest, answer: 'bullion' });
    const rows = decisionRows().map((row) => [row.decision_id, row.evidence_digest, row.revoked_at]);
    expect([again.status, rows]).toEqual([201, [[written.body.decision.id, evidenceDigest, NOW.toISOString()], [again.body.decision?.id, newDigest, null]]]);
  });

  it('gives each answer the next rowid itself, replaces the live answer of exactly its own scope, and changes one only by its one-way revoke', async () => {
    await start();
    const accounts = seedHeldOrder();
    // The same product ref in another order, the guard having read other evidence on it: another content fingerprint.
    const sibling = walmartFlagged('h1b', '2030-02-20', { productRef: FLAGGED.productRef, flag: { ...flagOf('XAU'), evidence: ['shape-with-weight'] } });
    importPayload(walmartPayload([sibling], { coverage: false }), { accountId: accounts.walmart });
    const siblingPrint = sibling.lines[0].contentFingerprint;
    expect(siblingPrint === FLAGGED.contentFingerprint).toBe(false);
    // A past decision of another kind at rowid 41, born live and then revoked one way: the next is 42, whatever the count.
    const actor = `usr_${'c'.repeat(32)}`;
    db().prepare(`INSERT INTO metals_owner_decisions (rowid, decision_id, kind, scope, rule_id, preview_digest, decided_at, decided_by)
      VALUES (41, ?, 'spending-rule', 'rule', 'synthetic-rule', ?, '2030-01-01T00:00:00.000Z', ?)`).run(`mtl-dec-${'a'.repeat(32)}`, 'b'.repeat(64), actor);
    db().prepare(`UPDATE metals_owner_decisions SET revoked_at = '2030-01-02T00:00:00.000Z', revoked_by = ? WHERE rowid = 41`).run(actor);
    const seeded = decisionRows();
    // The first answer for the ref moves its own line and the other fingerprint's, which drifts: its order stays held.
    const firstPreview = (await post(productRoute, { fingerprint: FLAGGED.contentFingerprint, answer: 'bullion', preview: null })).body.preview;
    expect([firstPreview?.lines, firstPreview?.orders]).toEqual([2, { before: { held: 2, counted: 0, left: 0 }, after: { held: 1, counted: 1, left: 0 } }]);
    const first = await answer(productRoute, { fingerprint: FLAGGED.contentFingerprint, answer: 'bullion' });
    const second = await answer(productRoute, { fingerprint: siblingPrint, answer: 'not-bullion' });
    const two = decisionRows();
    expect([first.status, second.status, two.map((row) => [row.seq, row.decision_id, row.kind, row.answer, row.revoked_at])]).toEqual([201, 201, [
      [41, seeded[0].decision_id, 'spending-rule', null, '2030-01-02T00:00:00.000Z'],
      [42, first.body.decision?.id, 'bullion', 'bullion', null],
      [43, second.body.decision?.id, 'bullion', 'not-bullion', null]]]);
    // Each answers its own fingerprint's line only.
    expect((await answers()).map((item) => [item.lineKey, item.state])).toEqual([[FLAGGED.key, 'bullion'], [sibling.lines[0].key, 'not-bullion']]);
    // Answered again, the product's live answer is revoked one way and the next rowid appended; the other fingerprint's stays.
    const third = await answer(productRoute, { fingerprint: FLAGGED.contentFingerprint, answer: 'not-bullion' });
    const three = decisionRows();
    const revokedBy = expect.stringMatching(/^usr_[a-p]{32}$/);
    expect([third.status, three]).toEqual([201, [two[0], { ...two[1], revoked_at: NOW.toISOString(), revoked_by: revokedBy }, two[2], {
      seq: 44, decision_id: third.body.decision?.id, kind: 'bullion', scope: 'product', rule_id: null, product_ref: FLAGGED.productRef,
      fingerprint: FLAGGED.contentFingerprint, lot_key: null, evidence_digest: null, payout_key: null, checking_row_id: null, metal: null,
      troy_oz_per_unit: null, value_json: null, answer: 'not-bullion', preview_digest: expect.stringMatching(/^[a-p]{64}$/), decided_at: NOW.toISOString(),
      decided_by: revokedBy, revoked_at: null, revoked_by: null }]]);
    // Revoking is the same one-way change, and no row is ever deleted.
    const id = third.body.decision.id as string;
    const undo = await del(`${productRoute}?decision=${id}`);
    expect((await del(`${productRoute}?decision=${id}&preview=${undo.body.preview?.digest}`)).body).toMatchObject({ revoked: true });
    expect(decisionRows()).toEqual([three[0], three[1], three[2], { ...three[3], revoked_at: NOW.toISOString(), revoked_by: revokedBy }]);
  });

  it('lets a content write confirm a bullion line only as a line of its flag\'s metal', async () => {
    await start();
    seedHeldOrder();
    const content = { fingerprint: FLAGGED.contentFingerprint, troyOzPerUnit: '1', preview: null };
    const contentRoute = `/metals/products/${FLAGGED.productRef}/content`;
    expect((await post(contentRoute, { ...content, metal: 'XAU' })).status).toBe(404);
    expect((await answer(productRoute, { fingerprint: FLAGGED.contentFingerprint, answer: 'bullion' })).status).toBe(201);
    const silver = await post(contentRoute, { ...content, metal: 'XAG' });
    const gold = await post(contentRoute, { ...content, metal: 'XAU' });
    expect([silver.status, silver.body.error, gold.status, gold.body.preview?.lots]).toEqual([400, 'metal is not the metal this product names', 200, 1]);
  });

  it('binds today: a preview made before midnight in New York is stale after it', async () => {
    await start();
    seedHeldOrder();
    const fingerprint = FLAGGED.contentFingerprint;
    const previewed = await post(productRoute, { fingerprint, answer: 'bullion', preview: null });
    expect(previewed.status).toBe(200);
    const digest = previewed.body.preview.digest as string;
    const write = (today: string) => () => writeMetalsBullionChange({ db: db(), repo, today, at: NOW.toISOString(), actorRef: `usr_${'c'.repeat(32)}`,
      previewDigest: digest }, { action: 'answer', scope: { kind: 'product', ref: FLAGGED.productRef!, fingerprint }, answer: 'bullion' });
    expect(writeOutcome(write('2030-03-21'), { type: MetalsPreviewStale, words: 'preview-stale' })).toBe('preview-stale');
    const kinds = () => db().prepare('SELECT kind FROM metals_owner_decisions').pluck().all();
    expect(kinds()).toEqual([]);
    write(TODAY)();
    expect(kinds()).toEqual(['bullion']);
  });

  it('refuses a write when a figure its preview showed changed since, though no flagged line did', async () => {
    await start();
    const accounts = seedHeldOrder();
    const fingerprint = FLAGGED.contentFingerprint;
    const previewed = await post(productRoute, { fingerprint, answer: 'bullion', preview: null });
    expect(previewed.status).toBe(200);
    // Another gold bar bought since: the gold figures the preview showed changed; the flagged line and its order didn't.
    importPayload(walmartPayload([walmartBar('later', { date: '2030-03-01' })]), { accountId: accounts.walmart });
    const stale = await post(productRoute, { fingerprint, answer: 'bullion', preview: previewed.body.preview.digest });
    expect([stale.status, stale.body.reason, decisionRows()]).toEqual([409, 'preview-stale', []]);
  });

  it('finds a marker or a correction set after its preview again inside its own transaction, and writes nothing', async () => {
    await start();
    const accounts = seedHeldOrder();
    const fingerprint = FLAGGED.contentFingerprint;
    const digest = (await post(productRoute, { fingerprint, answer: 'bullion', preview: null })).body.preview?.digest as string;
    const write = () => writeMetalsBullionChange({ db: db(), repo, today: TODAY, at: NOW.toISOString(), actorRef: `usr_${'c'.repeat(32)}`,
      previewDigest: digest }, { action: 'answer', scope: { kind: 'product', ref: FLAGGED.productRef!, fingerprint }, answer: 'bullion' });
    db().exec(QUARANTINE_MARKER);
    expect(writeOutcome(write, { type: MetalsSchemaClosed, words: 'schema-closed' })).toBe('schema-closed');
    db().exec('DROP VIEW metals_quarantine');
    // A void as only v1's void-import writes one; this build reads none (the tripwire).
    db().prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-payload', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-payload' WHERE account_id = ?`).run('a'.repeat(32), NOW.toISOString(), 'b'.repeat(64), accounts.costco);
    expect(writeOutcome(write, { type: MetalsCorrectionUnsupported, words: 'correction-unsupported' })).toBe('correction-unsupported');
    expect(decisionRows()).toEqual([]);
  });

  it('refuses malformed answers without echoing them; card data is a 422 with paths only; the service token never answers', async () => {
    await start();
    seedHeldOrder();
    const fingerprint = FLAGGED.contentFingerprint;
    const writes: Array<[string, unknown, number]> = [
      [productRoute, { fingerprint, answer: 'SECRET', preview: null }, 400],
      [productRoute, { fingerprint, answer: 'bullion', preview: 'SECRET' }, 400],
      [productRoute, { fingerprint: 'SECRET', answer: 'bullion', preview: null }, 400],
      [productRoute, { fingerprint, answer: 'bullion', preview: null, extra: 'SECRET' }, 400],
      [productRoute, { fingerprint, preview: null }, 400],
      [productRoute, { fingerprint: 'a'.repeat(64), answer: 'bullion', preview: null }, 404],
      [`/metals/products/${'SECRET:1'}/bullion`, { fingerprint, answer: 'bullion', preview: null }, 404],
      [`/metals/lots/${FLAGGED.key}/bullion`, { evidenceDigest: 'SECRET', answer: 'bullion', preview: null }, 400],
      [`/metals/lots/walmart-line-${'a'.repeat(64)}/bullion`, { evidenceDigest: 'a'.repeat(64), answer: 'bullion', preview: null }, 404],
      [productRoute, { fingerprint: '4111111111111111', answer: 'bullion', preview: null }, 422],
    ];
    for (const [url, answerBody, status] of writes) {
      const res = await post(url, answerBody);
      expect([url, JSON.stringify(answerBody), res.status]).toEqual([url, JSON.stringify(answerBody), status]);
      expect(res.text).not.toMatch(/SECRET|4111/);
    }
    const card = await post(productRoute, { fingerprint: '4111111111111111', answer: 'bullion', preview: null });
    expect(card.body.paths).toEqual(['$.fingerprint']);
    const revokes = [`${productRoute}?decision=SECRET`, `${productRoute}?decision=mtl-dec-${'a'.repeat(32)}&extra=SECRET`,
      `${productRoute}?decision=mtl-dec-${'a'.repeat(32)}`, `/metals/lots/${FLAGGED.key}/bullion?decision=mtl-dec-${'a'.repeat(32)}`];
    const statuses: number[] = [];
    for (const url of revokes) {
      const res = await del(url);
      statuses.push(res.status);
      expect(res.text).not.toContain('SECRET');
    }
    expect(statuses).toEqual([400, 400, 404, 404]);
    const token = await request(await listenLoopback(app)).post(productRoute).set('Authorization', ['Bearer', TOKEN].join(' '))
      .set('Content-Type', 'application/json').send(JSON.stringify({ fingerprint, answer: 'bullion', preview: null }));
    const read = await service('/metals/answers?metal=XAU');
    expect([token.status, read.status, (await get('/metals/answers?metal=SECRET')).status]).toEqual([403, 200, 400]);
    expect(decisionRows()).toEqual([]);
    expect(logs.join('\n')).not.toMatch(/150000|200000|1111|GOLD BAR|Sample/);
  });
});

describe('metals reads and writes: the owner\'s fungible policy (HOLDR_METALS_FUNGIBLE)', () => {
  const METHOD = { rule: 'metals-assignment-v1+fungible', fungible: ['XAU'] };
  /** Every read of a page, and whether the policy changes it (it then carries `assignment`). */
  const READS: Array<[string, boolean]> = [
    ['/metals/overview?metal=XAU', true], ['/metals/purchases?metal=XAU', true], ['/metals/sales?metal=XAU', true],
    ['/metals/timeline?metal=XAU', true], ['/metals/overview?metal=XAG', true], ['/metals/products?metal=XAU', false],
    ['/metals/funding', false], ['/metals/answers?metal=XAU', false], ['/metals/closes?metal=XAU', false],
  ];
  /** An answer's text with its snapshot token blanked: each app here signs in, a write that moves the data version. */
  const blanked = (text: string) => text.replace(/"snapshot":"[^"]*"/g, '"snapshot":""');
  const bodies = async () => {
    const texts: string[] = [];
    for (const [url] of READS) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 200]);
      texts.push(blanked(res.text));
    }
    return texts;
  };
  /** A CollectPure sale of one 1 oz gold coin (by coin specification), which by form no recorded purchase matches. */
  const COIN = coinSale('c2', '2030-03-01');
  const seedCoinSale = () => {
    const accounts = seedBase();
    importPayload(collectpurePayload([COIN]), { accountId: accounts.collectpure });
    return accounts;
  };

  it('unset reads metals-assignment-v1 byte for byte; naming only another metal adds `assignment` to the reads it changes, nothing else', async () => {
    await start();
    seedCoinSale();
    const off = await bodies();
    expect(off.join('\n')).not.toMatch(/"assignment"|deliveryInferred|\|any\|/);
    await start({ metalsFungible: [] });
    expect(await bodies()).toEqual(off);
    await start({ metalsFungible: ['XAG'] });
    const silver = await bodies();
    READS.forEach(([url, changed], index) => {
      const { assignment, ...rest } = JSON.parse(silver[index]) as Record<string, unknown>;
      expect([url, assignment]).toEqual([url, changed ? { rule: 'metals-assignment-v1+fungible', fungible: ['XAG'] } : undefined]);
      expect([url, JSON.stringify(rest)]).toEqual([url, off[index]]);
    });
    // The policy's metals are named in METALS order, whatever the line's.
    await start({ metalsFungible: ['XPD', 'XAG'] });
    expect((await overview()).assignment).toEqual({ rule: 'metals-assignment-v1+fungible', fungible: ['XAG', 'XPD'] });
  });

  it('assigns gold oldest first across forms: the coin sale takes the earliest bar left, in one class; products and silver as v1', async () => {
    await start();
    const accounts = seedCoinSale();
    importPayload(walmartPayload([walmartSilver(8, '2030-01-20')], { coverage: false }), { accountId: accounts.walmart });
    const v1 = await overview();
    expect(v1.holdings.classes.map((entry) => [entry.key, entry.units.sold, entry.units.unmatched, entry.units.held]))
      .toEqual([['XAU|bar|1/1', 1, 0, 2], ['XAU|coin|1/1', 1, 1, 0]]);
    expect(v1.toCheck.forInformation.find((item) => item.code === 'unmatched-sales')).toMatchObject({ units: 1 });
    const offSilver = blanked((await get('/metals/overview?metal=XAG')).text);
    const offProducts = (await get('/metals/products?metal=XAU')).text;

    await start({ metalsFungible: ['XAU'] });
    const page = await overview();
    expect(page.assignment).toEqual(METHOD);
    expect(page.holdings.classes.map((entry) => [entry.key, entry.form, entry.units, entry.reconciliation])).toEqual([['XAU|any|1/1', 'any',
      { delivered: 3, awaiting: 0, sold: 2, soldFromDelivered: 2, soldFromAwaiting: 0, unmatched: 0, held: 1, awaitingUnassigned: 0 },
      { balanced: true, soldWhileAwaiting: 0, unmatched: 0, deliveryInferred: 0 }]]);
    expect(page.toCheck.forInformation.filter((item) => item.code === 'unmatched-sales')).toEqual([]);
    // A source row inherits the reasons of the class its lots are in, found by the policy's class form: here the metal's
    // unconfirmed content (the Costco bar), on the Walmart row as on the Costco row.
    expect(page.holdings.bySource.map((row) => [row.label, codes(row.troyOz)]))
      .toEqual([['Costco membership', ['content-unknown']], ['Walmart account', ['content-unknown']]]);
    // The coin sale takes W3's first bar, the earliest left (C1 took W1's), and W3 lists it.
    const sales = (await get('/metals/sales?metal=XAU')).body as MetalsSales;
    const coin = sales.sales.find((entry) => entry.orderKey === COIN.key)!;
    expect([sales.assignment, coin.matched.units, coin.unmatched.units, coin.cycles.map((cycle) => cycle.lotKey)])
      .toEqual([METHOD, 1, 0, [W3.lines[0].key]]);
    const purchases = (await get('/metals/purchases?metal=XAU')).body as MetalsPurchases;
    expect([purchases.assignment, purchaseOf(purchases.purchases, W3).sales])
      .toEqual([METHOD, [{ saleKey: COIN.lines[0].key, agreedDate: '2030-03-01', units: 1 }]]);
    expect(((await get('/metals/timeline?metal=XAU')).body as MetalsTimeline).assignment).toEqual(METHOD);
    // Products are unchanged, and silver, which the policy doesn't name, reads as v1 but for `assignment`.
    expect((await get('/metals/products?metal=XAU')).text).toBe(offProducts);
    const { assignment, ...silver } = JSON.parse(blanked((await get('/metals/overview?metal=XAG')).text)) as Record<string, unknown>;
    expect([assignment, JSON.stringify(silver)]).toEqual([METHOD, offSilver]);
  });

  it('reads a unit a sale took from awaiting as delivered: its class says so, and a holding of nothing proves it with no price', async () => {
    await start();
    installMetalsSchema(db());
    // A bar never delivered, sold on 2030-02-03; every source is covered and no close is stored.
    importPayload(walmartPayload([walmartBar('w9', { date: '2030-01-05', events: [] })]), { label: 'Walmart account' });
    importPayload(collectpurePayload([C1]), { label: 'CollectPure account' });
    const zero = { value: 0, state: 'complete', reasons: [] };
    const missing = { value: null, state: 'unknown', reasons: [{ code: 'price-missing', records: 1 }] };
    const read = async (query = 'metal=XAU') => {
      const { holdings } = await overview(query);
      return { units: holdings.units, classes: holdings.classes.map((entry) => [entry.key, entry.reconciliation, entry.valueMinor]),
        bySource: holdings.bySource.map((row) => row.valueMinor), value: holdings.valueMinor, awaiting: holdings.awaitingTroyOz.value };
    };
    // v1: the sale took the unit while it awaited delivery, so a unit is on the way, and the holding needs a price.
    expect(await read()).toEqual({
      units: { delivered: 0, awaiting: 1, sold: 1, soldFromDelivered: 0, soldFromAwaiting: 1, unmatched: 0, held: 0, awaitingUnassigned: 0 },
      classes: [['XAU|bar|1/1', { balanced: false, soldWhileAwaiting: 1, unmatched: 0 }, missing]],
      bySource: [missing], value: missing, awaiting: oz('1/1', '1.000'),
    });
    await start({ metalsFungible: ['XAU'] });
    expect(await read()).toEqual({
      units: { delivered: 1, awaiting: 0, sold: 1, soldFromDelivered: 1, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0 },
      classes: [['XAU|any|1/1', { balanced: true, soldWhileAwaiting: 0, unmatched: 0, deliveryInferred: 1 }, zero]],
      bySource: [zero], value: zero, awaiting: oz('0/1', '0.000'),
    });
    // As of a day before the sale nothing was sold, so nothing is inferred: the unit still awaits delivery.
    const before = await read('metal=XAU&asOf=2030-02-01');
    expect([before.units.awaiting, before.classes])
      .toEqual([1, [['XAU|any|1/1', { balanced: true, soldWhileAwaiting: 0, unmatched: 0, deliveryInferred: 0 }, missing]]]);
  });

  it('previews and writes the owner\'s decisions under it: each write recomputes its preview with the same policy', async () => {
    await start({ metalsFungible: ['XAU'] });
    const accounts = seedCoinSale();
    // A content confirmation: its preview reads the policy's holdings (the coin sale took a bar: 1 oz held, not 2), and
    // the write recomputes the same digest.
    const route = `/metals/products/${'costco:300001'}/content`;
    const fingerprint = (((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
      .find((row) => row.scope.kind === 'product' && row.scope.ref === 'costco:300001')!.scope as { fingerprint: string }).fingerprint;
    const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect(preview.body.preview.holdingsTroyOz.before.value).toEqual(oz('1/1', '1.000'));
    expect((await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: preview.body.preview.digest })).status).toBe(201);
    expect((await overview()).holdings.troyOz).toEqual(preview.body.preview.holdingsTroyOz.after);
    // A bullion answer, likewise: the page then shows what its preview called after.
    const held = walmartHeld('h9', '2030-01-09', 'XAU', true);
    importPayload(walmartPayload([held], { coverage: false }), { accountId: accounts.walmart });
    const bullionRoute = `/metals/products/${held.lines[0].productRef}/bullion`;
    const body = { fingerprint: held.lines[0].contentFingerprint, answer: 'bullion' };
    const shown = (await post(bullionRoute, { ...body, preview: null })).body.preview as MetalsBullionPreview;
    expect(shown.metals[0].before.holdingsTroyOz.value).toEqual(oz('2/1', '2.000'));
    expect((await post(bullionRoute, { ...body, preview: shown.digest })).status).toBe(201);
    expect((await overview()).holdings.troyOz).toEqual(shown.metals[0].after.holdingsTroyOz);
  });
});

describe('metals reads: the owner\'s estimate for sold units with no recorded purchase (HOLDR_METALS_ESTIMATE_UNMATCHED)', () => {
  const METHOD = { rule: 'metals-estimate-nearest-v1', metals: ['XAU'] };
  /** Every read of a page, and whether the switch changes it (it then carries `costEstimate`). */
  const READS: Array<[string, boolean]> = [
    ['/metals/overview?metal=XAU', true], ['/metals/overview?metal=XAU&asOf=2030-02-01', true], ['/metals/purchases?metal=XAU', false],
    ['/metals/sales?metal=XAU', true], ['/metals/timeline?metal=XAU', false], ['/metals/overview?metal=XAG', true],
    ['/metals/sales?metal=XAG', true], ['/metals/products?metal=XAU', false], ['/metals/funding', false], ['/metals/answers?metal=XAU', false],
    ['/metals/closes?metal=XAU', false],
  ];
  /** An answer's text with its snapshot token blanked: each app here signs in, a write that moves the data version. */
  const blanked = (text: string) => text.replace(/"snapshot":"[^"]*"/g, '"snapshot":""');
  const bodies = async () => {
    const texts: string[] = [];
    for (const [url] of READS) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 200]);
      texts.push(blanked(res.text));
    }
    return texts;
  };
  /** Where an answer says estimate (`estimate`, `costEstimate`), but the coverage proof's own `totals.estimate`. */
  const estimatePaths = (value: unknown, at = '$'): string[] => {
    if (Array.isArray(value)) return value.flatMap((entry, index) => estimatePaths(entry, `${at}[${index}]`));
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      ...((key === 'estimate' || key === 'costEstimate') && !at.endsWith('.coverageProof.totals') ? [`${at}.${key}`] : []),
      ...estimatePaths(child, `${at}.${key}`),
    ]);
  };
  /** A 1 ozt bar sold on 2030-01-05, before the first bar bought (W1, ordered 2030-01-10): no recorded purchase. */
  const EARLY = barSale('e1', { date: '2030-01-05' });
  /** A 1 oz gold coin sold on 2030-03-01: no coin was bought, so its class has no purchase to estimate from. */
  const COIN = coinSale('c3', '2030-03-01');
  const seedSales = () => {
    const accounts = seedBase();
    importPayload(collectpurePayload([EARLY, COIN]), { accountId: accounts.collectpure });
    return accounts;
  };
  const saleOf = (sales: MetalsSale[], order: MetalsOrder) => sales.find((entry) => entry.orderKey === order.key)!;
  const salesRead = async (query = 'metal=XAU') => (await get(`/metals/sales?${query}`)).body as MetalsSales;

  it('golden: unset reads are as before byte for byte; naming only another metal adds `costEstimate` to the overview and sales, nothing else', async () => {
    await start();
    seedSales();
    const off = await bodies();
    expect(off.flatMap((text) => estimatePaths(JSON.parse(text)))).toEqual([]);
    expect(off.join('\n')).not.toMatch(/cost-estimated|unestimatedUnits|metals-estimate-nearest-v1/);
    await start({ metalsEstimateUnmatched: [] });
    expect(await bodies()).toEqual(off);
    await start({ metalsEstimateUnmatched: ['XPT'] });
    const platinum = await bodies();
    READS.forEach(([url, changed], index) => {
      const { costEstimate, ...rest } = JSON.parse(platinum[index]) as Record<string, unknown>;
      expect([url, costEstimate]).toEqual([url, changed ? { rule: 'metals-estimate-nearest-v1', metals: ['XPT'] } : undefined]);
      expect([url, JSON.stringify(rest)]).toEqual([url, off[index]]);
    });
  });

  it('estimates a bar sold before any bar was bought from the nearest bar, in its cost and profit only, each part said', async () => {
    await start();
    seedSales();
    const off = await overview();
    const offSales = await salesRead();
    const offPurchases = (await get('/metals/purchases?metal=XAU')).text;
    const offTimeline = (await get('/metals/timeline?metal=XAU')).text;
    const w1 = purchaseOf((JSON.parse(offPurchases) as MetalsPurchases).purchases, W1);
    // Without the switch the period counts the matched sale alone (C1 on W1: $2,070.00 net less $2,000.00).
    expect([off.activity.profit.valueMinor.value, codes(off.activity.profit.valueMinor)]).toEqual([7000, ['content-unknown', 'unmatched-sales']]);

    await start({ metalsEstimateUnmatched: ['XAU'] });
    const page = await overview();
    expect(page.costEstimate).toEqual(METHOD);
    // The period: C1's recorded result and the early bar's at W1's cost (the nearest bar, 5 days after it); the coin has none.
    expect(page.activity.profit).toEqual({
      valueMinor: { value: 14000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'unmatched-sales', records: 1 },
        { code: 'cost-estimated', records: 1 }] },
      coverage: off.activity.profit.coverage,
      estimate: {
        recordedMinor: 7000, estimatedMinor: 7000, costOfSales: { recordedMinor: 200000, estimatedMinor: 200000 },
        estimated: { lines: 1, units: 1, troyOz: oz('1/1', '1.000') }, unestimatedUnits: 1,
      },
    });
    // Each class says its units with no recorded purchase, with and without an estimate; nothing else of the holdings moves.
    expect(page.holdings.classes.map((entry) => [entry.key, entry.units.unmatched, entry.estimate])).toEqual([
      ['XAU|bar|1/1', 1, { units: 1, costMinor: 200000, unestimatedUnits: 0 }],
      ['XAU|coin|1/1', 1, { units: 0, costMinor: 0, unestimatedUnits: 1 }],
    ]);
    const { classes, ...holdings } = page.holdings;
    const { classes: offClasses, ...offHoldings } = off.holdings;
    expect(holdings).toEqual(offHoldings);
    expect(classes.map(({ estimate: _estimate, ...rest }) => rest)).toEqual(offClasses);
    expect([page.activity.bought, page.activity.sold, page.activity.payouts, page.toCheck])
      .toEqual([off.activity.bought, off.activity.sold, off.activity.payouts, off.toCheck]);
    expect(estimatePaths(page)).toEqual(['$.holdings.classes[0].estimate', '$.holdings.classes[1].estimate', '$.activity.profit.estimate',
      '$.costEstimate']);
    // As of a day before any bar was bought, the assignment read no lot of its class: no estimate then.
    expect((await overview('metal=XAU&asOf=2030-01-08')).holdings.classes.map((entry) => [entry.key, entry.estimate]))
      .toEqual([['XAU|bar|1/1', { units: 0, costMinor: 0, unestimatedUnits: 1 }]]);

    // The early bar: its estimate beside its recorded parts (none), at W1's unit cost; still a sale with no recorded purchase.
    const sales = await salesRead();
    expect(sales.costEstimate).toEqual(METHOD);
    const early = saleOf(sales.sales, EARLY);
    const offEarly = saleOf(offSales.sales, EARLY);
    expect(early.estimate).toEqual({
      units: 1, unitCostMinor: 200000, costMinor: 200000, proceedsMinor: 207000, profitMinor: 7000, recorded: { costMinor: null, profitMinor: null },
      from: { lotKey: w1.key, orderKey: W1.key, orderDate: '2030-01-10', account: w1.account, daysFromOrderToSale: -5 },
    });
    const estimated = { state: 'partial', reasons: [{ code: 'cost-estimated', records: 1 }] };
    expect([early.costMinor, early.profitMinor]).toEqual([{ value: 200000, ...estimated }, { value: 7000, ...estimated }]);
    const unmatched = { value: null, state: 'unknown', reasons: [{ code: 'unmatched-sales', records: 1 }] };
    expect([offEarly.costMinor, offEarly.profitMinor]).toEqual([unmatched, unmatched]);
    const { estimate: _early, costMinor: _cost, profitMinor: _profit, ...earlyRest } = early;
    const { costMinor: _offCost, profitMinor: _offProfit, ...offEarlyRest } = offEarly;
    expect(earlyRest).toEqual(offEarlyRest);
    expect([early.unmatched.units, early.cycles, early.known]).toEqual([1, [], false]);
    // The coin's class has no purchase: `estimate: null`, its figures as before. The matched sale has no estimate at all.
    const { estimate: coinEstimate, ...coin } = saleOf(sales.sales, COIN);
    expect([coinEstimate, coin]).toEqual([null, saleOf(offSales.sales, COIN)]);
    expect(saleOf(sales.sales, C1)).toEqual(saleOf(offSales.sales, C1));
    expect(estimatePaths(sales).sort()).toEqual([`$.sales[${sales.sales.indexOf(early)}].estimate`,
      `$.sales[${sales.sales.findIndex((entry) => entry.orderKey === COIN.key)}].estimate`, '$.costEstimate'].sort());
    // Never a purchase: W1 lists only the sale assigned to it, and purchases and the timeline read as before.
    expect((await get('/metals/purchases?metal=XAU')).text).toBe(offPurchases);
    expect((await get('/metals/timeline?metal=XAU')).text).toBe(offTimeline);
  });

  it('reads the assignment\'s own class: under the fungible policy, the nearest purchase of any form', async () => {
    await start();
    const accounts = seedBase();
    importPayload(collectpurePayload([EARLY]), { accountId: accounts.collectpure });
    // A gold coin bought 2030-01-07: 2 days after the early bar was sold, nearer than W1 (5 days), but another class in v1.
    const WC = walmartCoin('wc', '2030-01-07');
    importPayload(walmartPayload([WC], { coverage: false }), { accountId: accounts.walmart });
    const purchases = ((await get('/metals/purchases?metal=XAU')).body as MetalsPurchases).purchases;
    const [w1, wc] = [purchaseOf(purchases, W1), purchaseOf(purchases, WC)];
    const earlyFrom = async () => {
      const { estimate } = saleOf((await salesRead()).sales, EARLY);
      return [estimate?.from.lotKey, estimate?.unitCostMinor, estimate?.from.daysFromOrderToSale];
    };

    await start({ metalsEstimateUnmatched: ['XAU'] });
    expect(await earlyFrom()).toEqual([w1.key, 200000, -5]);
    expect((await overview()).holdings.classes.map((entry) => [entry.key, entry.estimate])).toEqual([
      ['XAU|bar|1/1', { units: 1, costMinor: 200000, unestimatedUnits: 0 }], ['XAU|coin|1/1', { units: 0, costMinor: 0, unestimatedUnits: 0 }],
    ]);

    // Fungible: one class across forms. C1 takes the coin (the earliest bought), and the early bar reads the coin's cost.
    await start({ metalsFungible: ['XAU'], metalsEstimateUnmatched: ['XAU'] });
    expect(await earlyFrom()).toEqual([wc.key, 215000, -2]);
    const page = await overview();
    expect([page.assignment?.rule, page.costEstimate]).toEqual(['metals-assignment-v1+fungible', METHOD]);
    expect(page.holdings.classes.map((entry) => [entry.key, entry.estimate])).toEqual([['XAU|any|1/1', { units: 1, costMinor: 215000, unestimatedUnits: 0 }]]);
  });

  it('leaves every preview and write as it is: no figure a preview binds moves, so each write recomputes the same digest', async () => {
    await start({ metalsEstimateUnmatched: ['XAU'] });
    const accounts = seedSales();
    // A content confirmation: previewed, then written (the write recomputes its preview without reading any estimate).
    const route = `/metals/products/${'costco:300001'}/content`;
    const fingerprint = (((await get('/metals/products?metal=XAU')).body.products as MetalsProduct[])
      .find((row) => row.scope.kind === 'product' && row.scope.ref === 'costco:300001')!.scope as { fingerprint: string }).fingerprint;
    const preview = await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: null });
    expect(preview.status).toBe(200);
    expect((await post(route, { fingerprint, metal: 'XAU', troyOzPerUnit: '1', preview: preview.body.preview.digest })).status).toBe(201);
    // A bullion answer, likewise. Once answered, its bar (ordered 2030-01-09) is the early bar's nearest: estimates are read.
    const held = walmartHeld('h9', '2030-01-09', 'XAU', true);
    importPayload(walmartPayload([held], { coverage: false }), { accountId: accounts.walmart });
    const bullionRoute = `/metals/products/${held.lines[0].productRef}/bullion`;
    const body = { fingerprint: held.lines[0].contentFingerprint, answer: 'bullion' };
    const shown = await post(bullionRoute, { ...body, preview: null });
    expect(shown.status).toBe(200);
    expect((await post(bullionRoute, { ...body, preview: shown.body.preview.digest })).status).toBe(201);
    expect(saleOf((await salesRead()).sales, EARLY).estimate?.from).toMatchObject({ lotKey: held.lines[1].key, orderDate: '2030-01-09', daysFromOrderToSale: -4 });
  });
});
