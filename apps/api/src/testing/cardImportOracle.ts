import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { buildCardImportPayload, serializeCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from '../routes/cardSpending.js';
import { createCardTransactionsRouter } from '../routes/cardTransactions.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from './loopback.js';

/*
 * E1b design §7.4 test 69 (A9): v1 imports against the integrated Phase 4 code over random multi-step sequences. Each
 * sequence imports random files through the real routes (a preview, then commits that answer every 409 with a random
 * decision) and interleaves the owner's PATCHes (dismiss, restore, postedAs, category, notes); every request's status,
 * response body and the ledger after it are compared.
 *
 * This module runs unchanged on both builds, so it uses only what both have: the card spending routes, the repository's
 * constructor and createCardAccount, the v14 columns of card_transactions and card_import_batches, the shared
 * payload builder and testing/loopback.ts (requests reach the app on 127.0.0.1, never another local process). A sequence is a seed: its random choices depend only on the seed and on the answers before them, so
 * while two builds answer alike they make the same requests. `generateCardImportOracle` records, for each request, the
 * digests of the request, the status, the normalized body and the ledger (cardImportOracle.generate.test.ts, run in a
 * checkout of main 89c568b, the last schema-v14 main); routes/cardImportA9.test.ts runs the same seeds here and compares.
 */

export interface OracleRow {
  ref: string | null;
  date: string;
  posted: string | null;
  status: 'pending' | 'posted';
  amount: number;
  description: string;
}

export interface OracleImport {
  op: 'preview' | 'commit';
  query: string;
  rows: OracleRow[];
  coverage: { start: string; end: string } | null;
  /** The file states a statement figure its rows do not add up to (a 409 until acceptMismatch=true). */
  mismatch: boolean;
  /** sha256 of the payload JSON the recording build sent: both builds must send the same bytes. */
  payloadDigest: string;
}

export interface OraclePatch {
  op: 'patch';
  /** The row's short key (see shortKey). */
  target: string;
  body: Record<string, unknown>;
  /** For `{postedAs}`: the posted row's short key, resolved to its id on the build that runs it. */
  postedAs: string | null;
}

export type OracleRequest = OracleImport | OraclePatch;

/** The ledger as both schemas store it: card_transactions' v14 columns (by short key) and the import batches in order. */
export interface OracleLedger {
  rows: unknown[][];
  batches: unknown[][];
}

/** One request as recorded: the digests of the request, the normalized body and the ledger after it, and the status. */
export type OracleRecord = [request: string, status: number, body: string, ledger: string];

export interface CardImportOracle {
  oracle: string;
  /** The card account's issuer (Chase when absent): one the browser extension syncs, or another (E2d-D22). */
  issuer?: string;
  steps: number;
  sequences: Array<{ seed: number; records: OracleRecord[] }>;
}

/** What one request did on this build, in full. */
export interface OracleObservation {
  request: OracleRequest;
  status: number;
  body: unknown;
  ledger: OracleLedger;
  /** The answer as sent, and the world that answered it (the comparison of declared exceptions reads both). */
  raw?: unknown;
  world?: CardImportOracleWorld;
}

const CLOCK = new Date('2026-10-16T12:00:00.000Z');
const OWNER_AUTH = { kind: 'session', userId: 'a9-owner', username: 'a9-owner', sessionId: 'a9-session' };
/** A key's first 16 characters (`xid1:`/`cfp1:` and 11 letters): unique within a sequence, and short. */
const SHORT_KEY = 16;
const KEY_SQL = `substr(coalesce(external_id_hash, fingerprint), 1, ${SHORT_KEY})`;

export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** JSON with every object's keys sorted, so two builds that order a body's keys differently still agree. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

/** The first 16 hex digits of the sha256 of a value's canonical JSON. */
export const oracleDigest = (value: unknown) => sha256(JSON.stringify(canonical(value))).slice(0, 16);

/**
 * What a v15 import response adds to Phase 4's (E2d), each with the value it has when no row meets the browser
 * extension's: dropped only with that value, so a held row or a review item in a v1-only sequence is a difference.
 */
const V15_IMPORT_ADDITIONS: Record<string, (value: unknown) => boolean> = {
  heldCount: (value) => value === 0,
  heldRows: (value) => Array.isArray(value) && value.length === 0,
  reviewCount: (value) => value === 0,
  reviewRows: (value) => Array.isArray(value) && value.length === 0,
  previewDigest: (value) => typeof value === 'string',
};

/** The payload a request sends, for a card of `issuer` (its source is the issuer's CSV; Chase's bytes are the original ones). */
export function oraclePayloadJson(input: Pick<OracleImport, 'rows' | 'coverage' | 'mismatch'>, issuer = 'chase'): string {
  const rows: CardImportDraftRow[] = input.rows.map((row) => ({
    transactionDate: row.date, postedDate: row.posted, status: row.status, amountMinor: row.amount,
    kind: row.amount < 0 ? 'refund' : 'purchase', description: row.description, ...(row.ref ? { externalId: row.ref } : {}),
  }));
  const { payload } = buildCardImportPayload({
    source: `${issuer}-csv`, parserVersion: 'holdr-card-import@1.0.0', issuer, currency: 'USD', rows,
    ...(input.coverage ? { coverage: input.coverage } : {}), ...(input.mismatch ? { statement: { chargesMinor: 1 } } : {}),
  });
  return serializeCardImportPayload(payload);
}

interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  raw(): { all(...params: unknown[]): unknown[][] };
  pluck(): { get(...params: unknown[]): unknown };
}

/** One card account behind the real card spending routes, signed in as the owner, on an in-memory database. */
export class CardImportOracleWorld {
  readonly repo = new SqliteStateRepo({ file: ':memory:', now: () => CLOCK });
  private readonly app = express();
  private readonly accountId: string;
  /**
   * Import batches the comparison leaves out: on a build with E1b's declared exceptions, a batch v14 never recorded
   * (A16: a covered file whose only news is a review item). Always empty when recording v14.
   */
  private readonly hidden = new Set<string>();

  constructor(readonly issuer = 'chase') {
    this.accountId = this.repo.createCardAccount({ issuer, owner: 'joint', last4: '3391', currency: 'USD' }).id;
    this.app.use((req, _res, next) => {
      (req as unknown as { holdrAuth: unknown }).holdrAuth = OWNER_AUTH;
      next();
    });
    this.app.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
    mountCardSpendingRoutes(this.app, {
      repo: this.repo, requireAuth: (_req, _res, next) => next(), log: () => undefined,
      routers: [createCardTransactionsRouter(this.repo, { log: () => undefined })],
    });
  }

  close(): void {
    this.repo.close();
  }

  private prepare(sql: string): Statement {
    return (this.repo as unknown as { db: { prepare(sql: string): Statement } }).db.prepare(sql);
  }

  private idOf(shortKey: string): string {
    const id = this.prepare(`SELECT id FROM card_transactions WHERE ${KEY_SQL} = ?`).pluck().get(shortKey);
    if (typeof id !== 'string') throw new Error(`no card transaction has the key ${shortKey}`);
    return id;
  }

  /** The stored rows as the owner's PATCHes choose among them. */
  rows(): Array<{ key: string; status: string; dismissed: boolean }> {
    return (this.prepare(`SELECT ${KEY_SQL} AS key, status, dismissed_at IS NOT NULL AS dismissed FROM card_transactions ORDER BY key`)
      .all() as Array<{ key: string; status: string; dismissed: number }>).map((row) => ({ ...row, dismissed: row.dismissed === 1 }));
  }

  /** Leaves an import batch out of every later ledger and body (see `hidden`). */
  hideBatch(id: string): void {
    this.hidden.add(id);
  }

  private batchIds(): unknown[][] {
    return this.prepare('SELECT id FROM card_import_batches ORDER BY rowid').raw().all().filter((row) => !this.hidden.has(String(row[0])));
  }

  ledger(): OracleLedger {
    const batches = this.prepare(`SELECT id, source, parser_version, row_count, new_count, duplicate_count, rejected_count, coverage_start,
      coverage_end FROM card_import_batches ORDER BY rowid`).raw().all().filter((row) => !this.hidden.has(String(row[0])));
    const ordinal = new Map(batches.map((batch, index) => [batch[0], index + 1]));
    const rows = this.prepare(`SELECT ${KEY_SQL}, source, transaction_date, posted_date, status, amount_minor, currency,
      original_amount_minor, original_currency, kind, description, merchant, issuer_category, user_category, notes, import_batch_id,
      dismissed_at IS NOT NULL FROM card_transactions ORDER BY 1`).raw().all();
    return {
      rows: rows.map((row) => [...row.slice(0, 15), ordinal.get(row[15]) ?? null, row[16]]),
      batches: batches.map((batch) => batch.slice(1)),
    };
  }

  /**
   * A response body without what differs between builds for the same outcome: ids (a transaction's becomes `txn:` and
   * its short key, a batch's `batch:` and its ordinal, the account's `account`), timestamps (keys ending in `At`),
   * warning texts (their code and sha256) and v15's inert additions to an import response (V15_IMPORT_ADDITIONS).
   */
  normalize(body: unknown, imported = false): unknown {
    const names = new Map<string, string>([[this.accountId, 'account']]);
    for (const row of this.prepare(`SELECT id, ${KEY_SQL} FROM card_transactions`).raw().all()) names.set(String(row[0]), `txn:${row[1]}`);
    this.batchIds().forEach((row, index) => names.set(String(row[0]), `batch:${index + 1}`));
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (typeof value === 'string') return names.get(value) ?? value;
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !key.endsWith('At')).map(([key, entry]) => [key,
        key === 'warnings' && Array.isArray(entry)
          ? entry.map((warning: { code: string; message: string }) => [warning.code, sha256(warning.message)])
          : walk(entry)]));
    };
    const normalized = walk(body);
    if (!imported || !normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    return Object.fromEntries(Object.entries(normalized).filter(([key, value]) => !V15_IMPORT_ADDITIONS[key]?.(value)));
  }

  async perform(input: OracleRequest): Promise<{ status: number; body: unknown; raw: unknown }> {
    if (input.op === 'patch') {
      const body = input.postedAs ? { postedAs: this.idOf(input.postedAs) } : input.body;
      const res = await request(await listenLoopback(this.app)).patch(`/card-transactions/${this.idOf(input.target)}`)
        .set('Content-Type', 'application/json').send(JSON.stringify(body));
      return { status: res.status, body: this.normalize(res.body), raw: res.body };
    }
    const res = await request(await listenLoopback(this.app)).post(`/card-imports/${input.op}?cardAccountId=${this.accountId}${input.query}`)
      .set('Content-Type', 'application/json').send(oraclePayloadJson(input, this.issuer));
    return { status: res.status, body: this.normalize(res.body, true), raw: res.body };
  }
}

/** mulberry32: a small seeded generator, so a sequence is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY0 = Date.UTC(2026, 7, 1);
const iso = (day: number) => new Date(DAY0 + day * 86_400_000).toISOString().slice(0, 10);
const DESCRIPTIONS = ['FOURTH COFFEE', 'NORTHWIND TRADERS', 'CONTOSO MARKET', 'ADVENTURE WORKS'];
const AMOUNTS = [1250, 990, 4200, 1250, -500];

interface Purchase { ref: string; day: number; amount: number; description: string; lag: number }

function setParam(query: string, name: string, value: string): string {
  const kept = query.split('&').filter((part) => part && !part.startsWith(`${name}=`));
  return [...kept, `${name}=${value}`].map((part) => `&${part}`).join('');
}

/**
 * Runs sequence `seed` (`steps` imports, each previewed, committed until no 409 is left, and sometimes followed by a
 * PATCH) on this build, handing each request's outcome to `observe` as it happens.
 */
export async function runCardImportSequence(seed: number, steps: number,
  observe: (observation: OracleObservation) => void | Promise<void>,
  /** Called before each request, on the world as it stands (A9 reads what the request must do from it; unused on v14). */
  before?: (request: OracleRequest, world: CardImportOracleWorld) => void,
  /** The card account's issuer: Chase, which the browser extension syncs, unless another is named (E2d-D22). */
  issuer = 'chase'): Promise<void> {
  const rnd = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rnd() * values.length)];
  const world = new CardImportOracleWorld(issuer);
  const perform = async (input: OracleRequest) => {
    before?.(input, world);
    const answer = await world.perform(input);
    await observe({ request: input, status: answer.status, body: answer.body, ledger: world.ledger(), raw: answer.raw, world });
    return answer;
  };
  // The card's purchases: some identical to an earlier one (an id-less group), each with its own issuer reference.
  const purchases: Purchase[] = [];
  const count = 4 + Math.floor(rnd() * 5);
  for (let i = 0; i < count; i += 1) {
    const ref = `REF-${seed}-${i}`;
    if (i > 0 && rnd() < 0.3) purchases.push({ ...pick(purchases), ref });
    else purchases.push({ ref, day: Math.floor(rnd() * 40), amount: pick(AMOUNTS), description: pick(DESCRIPTIONS), lag: Math.floor(rnd() * 4) });
  }
  try {
    for (let step = 0; step < steps; step += 1) {
      // A file: some of the purchases, with or without their references, pending or posted, now and then with another
      // day, amount or text than before, a declared coverage, or statement figures that do not add up.
      const withRefs = rnd() < 0.7;
      const chosen = purchases.filter(() => rnd() < 0.6);
      if (chosen.length === 0) chosen.push(purchases[0]);
      const rows: OracleRow[] = chosen.map((purchase) => {
        const status = rnd() < 0.35 ? 'pending' : 'posted';
        const day = purchase.day + (rnd() < 0.05 ? 1 : 0);
        return {
          ref: withRefs ? purchase.ref : null, date: iso(day), posted: status === 'posted' ? iso(Math.max(day, purchase.day + purchase.lag)) : null,
          status, amount: purchase.amount + (rnd() < 0.05 ? 1 : 0), description: purchase.description + (rnd() < 0.08 ? ' #12' : ''),
        };
      });
      const days = rows.map((row) => Math.round((Date.parse(`${row.date}T00:00:00Z`) - DAY0) / 86_400_000));
      const coverage = rnd() < 0.5 ? null
        : { start: iso(Math.min(...days) - Math.floor(rnd() * 5)), end: iso(Math.max(...days) + Math.floor(rnd() * 20)) };
      const mismatch = rnd() < 0.06;
      const file = { rows, coverage, mismatch, payloadDigest: sha256(oraclePayloadJson({ rows, coverage, mismatch }, issuer)) };
      const preview = await perform({ op: 'preview', query: '', ...file });
      let query = '';
      const stale = (preview.body as { stalePendingCount?: number }).stalePendingCount ?? 0;
      if (stale > 0 && rows.every((row) => row.status === 'posted') && rnd() < 0.5) query = setParam(query, 'stalePending', 'dismiss');
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const answer = await perform({ op: 'commit', query, ...file });
        if (answer.status !== 409) break;
        const body = answer.body as Record<string, unknown>;
        if ('reconciliation' in body) query = setParam(query, 'acceptMismatch', 'true');
        else if ('possibleDuplicateRows' in body) query = setParam(query, 'possibleDuplicates', pick(['skip', 'import']));
        else if ('pendingMatchRows' in body) {
          query = setParam(query, 'pendingMatches', String(body.error).includes('already stored')
            ? pick(['skip', 'split', 'post']) : pick(['post', 'skip', 'split', 'import']));
        } else if ('dismissedMatchRows' in body) query = setParam(query, 'dismissedMatches', pick(['post', 'keep']));
        else break;
      }
      if (rnd() < 0.45) {
        const stored = world.rows();
        const posted = stored.filter((row) => row.status === 'posted');
        const choices: OraclePatch[] = [];
        for (const row of stored) {
          if (row.status === 'pending') {
            choices.push({ op: 'patch', target: row.key, body: { status: 'removed' }, postedAs: null });
            if (posted.length > 0) choices.push({ op: 'patch', target: row.key, body: {}, postedAs: pick(posted).key });
          } else if (row.status === 'removed' && row.dismissed) {
            choices.push({ op: 'patch', target: row.key, body: { status: 'pending' }, postedAs: null });
          } else if (row.status === 'posted') {
            choices.push({ op: 'patch', target: row.key, body: pick([{ userCategory: 'Dining' }, { notes: 'shared dinner' }]), postedAs: null });
          }
        }
        if (choices.length > 0) await perform(pick(choices));
      }
    }
  } finally {
    world.close();
  }
}

/** The digests of one observation, as the oracle records them. */
export const oracleRecord = (observation: OracleObservation): OracleRecord => [oracleDigest(observation.request), observation.status,
  oracleDigest(observation.body), oracleDigest(observation.ledger)];

/** Records what this build answers to sequences 1..`sequences` of `steps` steps each, on a card of `issuer` (Chase by default). */
export async function generateCardImportOracle(options: { sequences: number; steps: number; oracle: string; issuer?: string }):
  Promise<CardImportOracle> {
  const issuer = options.issuer ?? 'chase';
  const sequences: CardImportOracle['sequences'] = [];
  for (let seed = 1; seed <= options.sequences; seed += 1) {
    const records: OracleRecord[] = [];
    await runCardImportSequence(seed, options.steps, (observation) => {
      records.push(oracleRecord(observation));
    }, undefined, issuer);
    sequences.push({ seed, records });
  }
  return { oracle: options.oracle, ...(issuer === 'chase' ? {} : { issuer }), steps: options.steps, sequences };
}
