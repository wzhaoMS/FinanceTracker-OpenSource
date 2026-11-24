import { afterEach, describe, expect, it } from 'vitest';

import { checkCoverage } from './coverage.js';
import { checkLivePermit, livePermit, readPermitRows, stopPermit, stoppingLabel, STOPPING_SKEW_MS } from './permit.js';
import { assertProofReceipt, ProofReceiptInvalid, timingBucket, type ProofReceipt } from './receipt.js';
import {
  encodeProofDeadline, encodeProofJob, hexToLetters, lettersToHex, parseProofRequest, PROOF_MAX_DEADLINE_MS, ProofRequestError,
} from './request.js';
import { checkRows } from './rows.js';
import { installProofSchema, proofSchemaState } from './schema.js';
import type { ProofSnapshot, StoredRow } from './snapshot.js';
import { goId, payloadText, ProofWorld, sha256 } from '../../../testing/cardImportProofWorld.js';
import { SqliteStateRepo } from '../../sqliteStateRepo.js';

// Synthetic only.
const repos: SqliteStateRepo[] = [];
const worlds: ProofWorld[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const world of worlds.splice(0)) world.close();
});

describe('G-COVERAGE (C1-C5, D4)', () => {
  const r = (start: string, end: string) => ({ start, end });
  it.each([
    ['a first import', [], [r('2026-09-01', '2026-09-30')], r('2026-09-01', '2026-09-30'), 'proof-coverage-first'],
    ['a covered day lost', [r('2026-09-01', '2026-09-30')], [r('2026-09-01', '2026-09-15')], r('2026-09-01', '2026-09-15'), 'proof-coverage-lost'],
    ['days from outside the payload', [r('2026-09-01', '2026-09-30')], [r('2026-09-01', '2026-10-10')], r('2026-10-01', '2026-10-05'), 'proof-coverage-outside'],
    ['a backward extension', [r('2026-09-01', '2026-09-30')], [r('2026-08-25', '2026-09-30')], r('2026-08-25', '2026-08-31'), 'proof-coverage-backward'],
    ['a new gap', [r('2026-09-01', '2026-09-30')], [r('2026-09-01', '2026-09-30'), r('2026-11-01', '2026-11-05')], r('2026-11-01', '2026-11-05'), 'proof-coverage-gap'],
  ])('holds %s', (_, before, after, payload, code) => {
    expect(checkCoverage(before, after, payload).code).toBe(code);
  });
  it.each([
    ['an adjacent forward chunk', [r('2026-09-01', '2026-09-30')], [r('2026-09-01', '2026-10-05')], r('2026-10-01', '2026-10-05'), 'forward'],
    ['a filled gap', [r('2026-09-01', '2026-09-10'), r('2026-09-20', '2026-09-30')], [r('2026-09-01', '2026-09-30')], r('2026-09-11', '2026-09-19'), 'gap-fill'],
    ['both', [r('2026-09-01', '2026-09-10'), r('2026-09-20', '2026-09-30')], [r('2026-09-01', '2026-10-05')], r('2026-09-11', '2026-10-05'), 'forward+gap-fill'],
    ['nothing new', [r('2026-09-01', '2026-09-30')], [r('2026-09-01', '2026-09-30')], r('2026-09-10', '2026-09-20'), 'none'],
    ['part of an old gap filled', [r('2026-09-01', '2026-09-10'), r('2026-09-20', '2026-09-30')],
      [r('2026-09-01', '2026-09-12'), r('2026-09-20', '2026-09-30')], r('2026-09-11', '2026-09-12'), 'gap-fill'],
  ])('passes %s', (_, before, after, payload, move) => {
    expect(checkCoverage(before, after, payload)).toEqual({ code: null, move });
  });
});

describe('the proof request', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const job = sha256('synthetic-job');
  const query = (patch: Record<string, string | undefined>) => new Map(Object.entries({
    proofJob: encodeProofJob(job), proofAttempt: '3', proofDeadline: encodeProofDeadline(now + 30_000), proofMode: 'automatic',
    proofStatementPolicy: 'require-match', ...patch,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  it('round-trips hex through the letter encoding the card-data scan accepts', () => {
    expect(lettersToHex(hexToLetters(job))).toBe(job);
    expect(encodeProofJob(job)).toMatch(/^h1:[a-p]{64}$/);
  });
  it('parses the runner\'s commit and a resolve', () => {
    expect(parseProofRequest(query({}), now)).toEqual({ mode: 'automatic', jobId: job, attempt: 3, deadlineMs: now + 30_000,
      statementPolicy: 'require-match' });
    expect(parseProofRequest(query({ proofMode: 'resolve', proofDeadline: undefined, proofStatementPolicy: undefined }), now))
      .toEqual({ mode: 'resolve', jobId: job, attempt: 3 });
  });
  it.each([
    ['proofMode', { proofMode: 'manual' }],
    ['proofJob', { proofJob: 'h1:abc' }],
    ['proofJob', { proofJob: `h1:${'q'.repeat(64)}` }],
    ['proofAttempt', { proofAttempt: '0' }],
    ['proofAttempt', { proofAttempt: '1000000' }],
    ['proofAttempt', { proofAttempt: '01' }],
    ['proofDeadline', { proofDeadline: encodeProofDeadline(now + PROOF_MAX_DEADLINE_MS + 1) }],
    ['proofDeadline', { proofDeadline: undefined }],
    ['proofStatementPolicy', { proofStatementPolicy: 'trust-me' }],
    ['proofDeadline', { proofMode: 'resolve' }],
  ])('refuses a bad %s by name only', (parameter, patch) => {
    let error: unknown;
    try { parseProofRequest(query(patch), now); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProofRequestError);
    expect((error as ProofRequestError).parameter).toBe(parameter);
  });
  it('leaves a deadline already passed to the fence (409), not the parser', () => {
    expect(parseProofRequest(query({ proofDeadline: encodeProofDeadline(now - 1) }), now)).toMatchObject({ deadlineMs: now - 1 });
  });
});

describe('the receipt is exactly its schema', () => {
  async function realReceipt(): Promise<ProofReceipt> {
    const w = new ProofWorld();
    worlds.push(w);
    w.live('amex');
    const card = w.account();
    await w.seed(card, payloadText('amex', [{ transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase',
      description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' }], { start: '2026-09-01', end: '2026-09-30' }));
    const res = await w.commit(card, payloadText('amex', [{ transactionDate: '2026-10-02', postedDate: '2026-10-03', amountMinor: 999,
      kind: 'purchase', description: 'SAMPLE STREAMING', externalId: 'proof-ref-3' }], { start: '2026-10-01', end: '2026-10-05' },
    { statement: true }), { jobId: sha256('synthetic-receipt-job') });
    expect(res.status, res.text).toBe(201);
    return res.body.proof as ProofReceipt;
  }
  it('accepts a real receipt and refuses every deviation, naming only the schema path', async () => {
    const receipt = await realReceipt();
    expect(() => assertProofReceipt(receipt)).not.toThrow();
    const mutate = (fn: (copy: Record<string, any>) => void) => {
      const copy = JSON.parse(JSON.stringify(receipt));
      fn(copy);
      return copy;
    };
    for (const [path, broken] of [
      ['$', mutate((c) => { c.description = 'NORTHWIND GROCERY'; })],
      ['$.counts.new', mutate((c) => { c.counts.new = -1; })],
      ['$.payments.returnedAdded', mutate((c) => { c.payments.returnedAdded = 1; })],
      ['$.payments.conflicts', mutate((c) => { c.payments.conflicts = 1; })],
      ['$.links.moved', mutate((c) => { c.links.moved = 1; })],
      ['$.rows.gone', mutate((c) => { c.rows.gone = 1; })],
      ['$.replay.new', mutate((c) => { c.replay.new = 1; })],
      ['$.permit', mutate((c) => { c.permit = null; })],
      ['$.committedAt', mutate((c) => { c.committedAt = '2026-10-20'; })],
      ['$.jobId', mutate((c) => { c.jobId = '4111111111111111'; })],
      ['$.counts', mutate((c) => { c.counts.duplicate += 1; })],
    ] as const) {
      let error: unknown;
      try { assertProofReceipt(broken); } catch (caught) { error = caught; }
      expect(error, path).toBeInstanceOf(ProofReceiptInvalid);
      expect((error as ProofReceiptInvalid).path, path).toBe(path);
      expect((error as Error).message).not.toMatch(/NORTHWIND|4111/);
    }
  });
  it('reports time only as a coarse bucket', () => {
    expect([0, 999, 1000, 4999, 29_999, 30_000].map(timingBucket)).toEqual(['lt1s', 'lt1s', '1to2s', '2to5s', '5to30s', 'gt30s']);
  });
});

describe('G-ROWS and D12 on synthetic snapshots', () => {
  const TARGET = `card-acct-${'a'.repeat(32)}`, OTHER = `card-acct-${'b'.repeat(32)}`;
  const pendingRow: StoredRow = { id: 'r1', card_account_id: TARGET, status: 'pending', transaction_date: '2026-09-28', posted_date: null,
    amount_minor: 2500, original_amount_minor: null, original_currency: null, currency: 'USD', kind: 'purchase',
    description: 'FABRIKAM CAFE PENDING', merchant: null, issuer_category: 'Pending', user_category: null, notes: null, revision: 1,
    removed_reason: null, removed_from_status: null, removed_at: null, dismissed_at: null, merged_into_id: null,
    reversal_snapshot_revision: null, external_id_hash: 'x', fingerprint: null, updated_at: '2026-09-28T00:00:00.000Z' };
  const promoted = (patch: StoredRow = {}): StoredRow => ({ ...pendingRow, status: 'posted', posted_date: '2026-10-02', revision: 2,
    description: 'FABRIKAM CAFE', issuer_category: 'Restaurant', updated_at: '2026-10-02T00:00:00.000Z', ...patch });
  const snapshot = (rows: StoredRow[]): ProofSnapshot => ({
    rows: new Map(rows.map((row) => [row.id as string, { accountId: row.card_account_id as string, digest: sha256(JSON.stringify(row)), row }])),
    accounts: new Map([[TARGET, { id: TARGET, ledger_revision: 1 }], [OTHER, { id: OTHER, ledger_revision: 1 }]]),
    coverage: new Map(), windows: new Map(), batches: new Map(), cardTables: new Map(), cutoverReceipts: new Map(), foreign: {},
  });
  const one = { newCount: 0, promotedCount: 1 };
  it('passes a promotion whose text changed, and counts it', () => {
    expect(checkRows(snapshot([pendingRow]), snapshot([promoted()]), TARGET, one))
      .toMatchObject({ code: null, promoted: ['r1'], promotedTextChanged: 1, changed: 0 });
  });
  // D12 (v1.2 §1): each of the three text columns counts on its own.
  it.each([
    ['description', { issuer_category: 'Pending' }],
    ['merchant', { description: 'FABRIKAM CAFE PENDING', issuer_category: 'Pending', merchant: 'FABRIKAM' }],
    ['issuer_category', { description: 'FABRIKAM CAFE PENDING' }],
  ])('counts a promotion whose only text change is its %s', (_, patch) => {
    expect(checkRows(snapshot([pendingRow]), snapshot([promoted(patch as StoredRow)]), TARGET, one))
      .toMatchObject({ code: null, promoted: ['r1'], promotedTextChanged: 1, changed: 0 });
  });
  it('counts no text change for a promotion that keeps all three', () => {
    expect(checkRows(snapshot([pendingRow]), snapshot([promoted({ description: 'FABRIKAM CAFE PENDING', issuer_category: 'Pending' })]),
      TARGET, one)).toMatchObject({ code: null, promoted: ['r1'], promotedTextChanged: 0, changed: 0 });
  });
  it.each([
    ['the amount', { amount_minor: 2650 }],
    ['the original amount', { original_amount_minor: 2500, original_currency: 'EUR' }],
    ['the currency', { currency: 'EUR' }],
    ['the kind', { kind: 'refund' }],
    ['the transaction date', { transaction_date: '2026-09-27' }],
    ['an owner\'s category', { user_category: 'Dining' }],
    ['an owner\'s notes', { notes: 'changed' }],
    ['the account', { card_account_id: OTHER }],
    ['a missing posted date', { posted_date: null }],
    ['a revision that skips', { revision: 3 }],
    ['a removal', { removed_at: '2026-10-02T00:00:00.000Z', removed_reason: 'mistaken-import' }],
  ])('holds a promotion that changes %s as a revision', (_, patch) => {
    expect(checkRows(snapshot([pendingRow]), snapshot([promoted(patch as StoredRow)]), TARGET, one).code).toBe('proof-revision');
  });
  it('holds a row posted already, then changed just as a promotion changes a pending row, as a revision (D12 posts only pending rows)', () => {
    const postedBefore: StoredRow = { ...pendingRow, status: 'posted', posted_date: '2026-09-29' };
    expect(checkRows(snapshot([postedBefore]), snapshot([promoted()]), TARGET, one))
      .toMatchObject({ code: 'proof-revision', promoted: [], changed: 1 });
  });
  it('holds rows that vanish, appear elsewhere, or do not match the batch', () => {
    expect(checkRows(snapshot([pendingRow]), snapshot([]), TARGET, { newCount: 0, promotedCount: 0 }).code).toBe('proof-rows');
    const elsewhere = { ...pendingRow, id: 'r2', card_account_id: OTHER };
    expect(checkRows(snapshot([pendingRow]), snapshot([pendingRow, elsewhere]), TARGET, { newCount: 1, promotedCount: 0 }).code).toBe('proof-rows');
    const fresh = { ...pendingRow, id: 'r3' };
    expect(checkRows(snapshot([pendingRow]), snapshot([pendingRow, fresh]), TARGET, { newCount: 2, promotedCount: 0 }).code).toBe('proof-rows');
    expect(checkRows(snapshot([pendingRow]), snapshot([pendingRow, fresh]), TARGET, { newCount: 1, promotedCount: 0 }).code).toBeNull();
  });
});

describe('the schema', () => {
  it('is absent until installed, present after, and a conflict in any other shape that install never repairs', () => {
    const repo = new SqliteStateRepo({ file: ':memory:' });
    repos.push(repo);
    const db = repo.internalGetDb();
    expect(proofSchemaState(db)).toBe('absent');
    installProofSchema(db);
    expect(proofSchemaState(db)).toBe('present');
    installProofSchema(db);
    expect(proofSchemaState(db)).toBe('present');
    db.exec('CREATE INDEX synthetic_extra ON card_import_proof_fences(card_account_id)');
    expect(proofSchemaState(db)).toBe('conflict');
    expect(() => installProofSchema(db)).toThrow();
    const other = new SqliteStateRepo({ file: ':memory:' });
    repos.push(other);
    other.internalGetDb().exec('CREATE TABLE card_import_live_permit (issuer TEXT)');
    expect(proofSchemaState(other.internalGetDb())).toBe('conflict');
  });
});

describe('the LIVE PERMIT and STOPPING-PENDING', () => {
  function permitWorld() {
    const repo = new SqliteStateRepo({ file: ':memory:' });
    repos.push(repo);
    installProofSchema(repo.internalGetDb());
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD' });
    return { db: repo.internalGetDb(), card };
  }
  const T = Date.parse('2026-10-20T12:00:00.000Z');
  const receiptAt = (cardAccountId: string, committedMs: number, permit: ProofReceipt['permit'] = { globalGeneration: 1, issuerGeneration: 1 }) =>
    ({ mode: permit ? 'automatic' : 'supervised', cardAccountId, committedAt: new Date(committedMs).toISOString(), permit }) as ProofReceipt;

  it('starts dead, needs both rows live in an automatic mode, and journals every change with its generation', () => {
    const { db } = permitWorld();
    expect(checkLivePermit(db, 'amex')).toEqual({ live: false, globalGeneration: 0, issuerGeneration: 0 });
    livePermit(db, '*', 'auto', goId(), new Date(T));
    expect(checkLivePermit(db, 'amex').live).toBe(false);
    const go = goId();
    expect(livePermit(db, 'amex', 'daily-interim', go, new Date(T))).toMatchObject({ state: 'live', generation: 1, reason: 'go' });
    expect(checkLivePermit(db, 'amex')).toEqual({ live: true, globalGeneration: 1, issuerGeneration: 1 });
    expect(() => livePermit(db, 'citi', 'auto', go, new Date(T))).toThrow(/used already/);
    expect(() => livePermit(db, 'amex', 'supervised', goId(), new Date(T))).toThrow();
    expect(stopPermit(db, 'amex', 'operator-stop', new Date(T).toISOString(), new Date(T))).toMatchObject({ state: 'dead', generation: 2 });
    expect(checkLivePermit(db, 'amex').live).toBe(false);
    expect(() => stopPermit(db, 'amex', 'operator-stop', '2026-10-20 12:00', new Date(T))).toThrow();
    expect(readPermitRows(db).map((row) => [row.issuer, row.state, row.generation])).toEqual([['*', 'live', 1], ['amex', 'dead', 2]]);
    expect(db.prepare('SELECT issuer, generation, state FROM card_import_live_permit_journal ORDER BY issuer, generation').all())
      .toEqual([{ issuer: '*', generation: 1, state: 'live' }, { issuer: 'amex', generation: 1, state: 'live' },
        { issuer: 'amex', generation: 2, state: 'dead' }]);
  });

  it('labels an automatic receipt committed after a later STOP was declared (with the skew margin) and nothing else', () => {
    const { db, card } = permitWorld();
    livePermit(db, '*', 'auto', goId(), new Date(T));
    livePermit(db, 'amex', 'auto', goId(), new Date(T));
    const before = receiptAt(card.id, T - 10 * 60_000), during = receiptAt(card.id, T + 30_000);
    const justBefore = receiptAt(card.id, T - 60_000);
    expect(stoppingLabel(db, during)).toBe('committed');
    stopPermit(db, 'amex', 'consent-off', new Date(T).toISOString(), new Date(T + 60_000));
    expect(stoppingLabel(db, during)).toBe('committed-during-stopping');
    expect(stoppingLabel(db, justBefore)).toBe('committed-during-stopping');
    expect(stoppingLabel(db, before)).toBe('committed');
    expect(stoppingLabel(db, receiptAt(card.id, T + 30_000, null))).toBe('committed');
    // A receipt made under the next live generation is not this STOP's.
    livePermit(db, 'amex', 'auto', goId(), new Date(T + 120_000));
    expect(stoppingLabel(db, receiptAt(card.id, T + 180_000, { globalGeneration: 1, issuerGeneration: 3 }))).toBe('committed');
    // A global STOP labels every scope's receipts under the global generation before it.
    stopPermit(db, '*', 'holdr-off', new Date(T + 240_000).toISOString(), new Date(T + 240_000));
    expect(stoppingLabel(db, receiptAt(card.id, T + 250_000, { globalGeneration: 1, issuerGeneration: 3 }))).toBe('committed-during-stopping');
  });

  it('never refuses a STOP for its time: one declared too far ahead is recorded when the generation it ends went live', () => {
    const { db, card } = permitWorld();
    livePermit(db, '*', 'auto', goId(), new Date(T));
    livePermit(db, 'amex', 'auto', goId(), new Date(T));
    const early = receiptAt(card.id, T + 60_000);
    // Applied half an hour later, by a ROG clock 13 h ahead: clamped to now, `early` would read plain committed.
    const ahead = new Date(T + 30 * 60_000 + 13 * 3_600_000).toISOString();
    expect(stopPermit(db, 'amex', 'consent-off', ahead, new Date(T + 30 * 60_000)))
      .toMatchObject({ state: 'dead', generation: 2, declaredAt: new Date(T).toISOString(), declaredAtClamped: true });
    expect(stoppingLabel(db, early)).toBe('committed-during-stopping');
    // Within the skew, the declared time stands.
    livePermit(db, 'amex', 'auto', goId(), new Date(T + 40 * 60_000));
    const within = new Date(T + 41 * 60_000 + STOPPING_SKEW_MS).toISOString();
    expect(stopPermit(db, 'amex', 'consent-off', within, new Date(T + 41 * 60_000)))
      .toMatchObject({ generation: 4, declaredAt: within, declaredAtClamped: false });
    // A row that is not live ends no generation: recorded now.
    expect(stopPermit(db, 'amex', 'consent-off', ahead, new Date(T + 50 * 60_000)))
      .toMatchObject({ generation: 5, declaredAt: new Date(T + 50 * 60_000).toISOString(), declaredAtClamped: true });
  });
});
