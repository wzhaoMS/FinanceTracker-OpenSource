import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import {
  buildCardImportPayload, serializeCardImportPayload, type CardAccount, type CardImportCoverage, type CardImportDraftRow,
} from '@finance-tracker/shared';

import { mountCardSpendingRoutes } from '../routes/cardSpending.js';
import { livePermit, type PermitMode } from '../services/cardImport/proof/permit.js';
import { encodeProofDeadline, encodeProofJob } from '../services/cardImport/proof/request.js';
import { installProofSchema } from '../services/cardImport/proof/schema.js';
import { checkingSchemaState, installCheckingSchema } from '../services/checking/schema.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from './loopback.js';

/**
 * A synthetic world for the W4 pre-commit proof: an in-memory repository behind the real card spending routes, with the
 * principal chosen per request (the loopback service, a signed-in owner, or none). Fictional merchants and made-up
 * amounts only.
 */

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const goId = () => randomBytes(16).toString('hex');

export type Principal = 'service' | 'session' | 'none';

export interface ProofParams {
  jobId: string;
  attempt?: number;
  deadlineMs?: number;
  mode?: 'automatic' | 'supervised' | 'resolve';
  policy?: 'require-match' | 'allow-unchecked-no-figures';
}

/** A payload's JSON. With `statement`, its posted totals are copied as statement figures, so it reconciles (`match`). */
export function payloadText(issuer: string, rows: CardImportDraftRow[], coverage: CardImportCoverage,
  options: { statement?: boolean | 'mismatch' } = {}): string {
  const draft = { source: 'proof-test', parserVersion: 'proof-test@1', issuer, currency: 'USD', coverage, rows };
  const built = buildCardImportPayload(draft).payload;
  if (!options.statement) return serializeCardImportPayload(built);
  const { chargesMinor, creditsMinor } = built.totals.posted;
  return serializeCardImportPayload(buildCardImportPayload({
    ...draft, statement: { chargesMinor: options.statement === 'mismatch' ? chargesMinor + 1 : chargesMinor, creditsMinor },
  }).payload);
}

export class ProofWorld {
  readonly logs: string[] = [];
  readonly repo: SqliteStateRepo;
  readonly app = express();

  constructor(options: { install?: boolean; file?: string } = {}) {
    this.repo = new SqliteStateRepo({ file: options.file ?? ':memory:' });
    mountCardSpendingRoutes(this.app, {
      repo: this.repo,
      log: (line) => this.logs.push(line),
      requireAuth: (req, _res, next) => {
        const who = req.get('x-test-principal');
        if (who === 'service') req.holdrAuth = { kind: 'service' };
        if (who === 'session') req.holdrAuth = { kind: 'session', userId: 'proof-owner', username: 'proof-owner', sessionId: 'proof-session' };
        next();
      },
    });
    if (options.install !== false) installProofSchema(this.db);
  }

  get db(): Database {
    return this.repo.internalGetDb();
  }

  /** The whole database, byte for byte. */
  image(): Buffer {
    return this.db.serialize();
  }

  close(): void {
    this.repo.close();
  }

  /** ROOT's GO for `*` and the issuer, in `mode`. */
  live(issuer: string, mode: PermitMode = 'auto'): void {
    livePermit(this.db, '*', 'auto', goId(), new Date());
    livePermit(this.db, issuer, mode, goId(), new Date());
  }

  account(issuer = 'amex', last4 = '0003'): CardAccount {
    return this.repo.createCardAccount({ issuer, owner: 'alex', last4, currency: 'USD' });
  }

  async post(path: string, body: string, principal: Principal = 'service') {
    const test = request(await listenLoopback(this.app)).post(path).set('Content-Type', 'application/json');
    return (principal === 'none' ? test : test.set('x-test-principal', principal)).send(body);
  }

  /** The owner's own commit, without the proof: how a test gives an account its first coverage. */
  async seed(account: CardAccount, body: string): Promise<void> {
    const res = await this.post(`/card-imports/commit?cardAccountId=${account.id}`, body, 'session');
    if (res.status !== 201) throw new Error(`seed refused: ${res.status}`);
  }

  proofQuery(account: CardAccount, proof: ProofParams, extra: Record<string, string> = {}): string {
    const params: Record<string, string> = {
      cardAccountId: account.id, ...extra, proofJob: encodeProofJob(proof.jobId), proofAttempt: String(proof.attempt ?? 1),
      proofMode: proof.mode ?? 'automatic',
    };
    if (proof.mode !== 'resolve') {
      params.proofDeadline = encodeProofDeadline(proof.deadlineMs ?? Date.now() + 30_000);
      params.proofStatementPolicy = proof.policy ?? 'require-match';
    }
    return new URLSearchParams(params).toString();
  }

  async commit(account: CardAccount, body: string, proof: ProofParams, extra: Record<string, string> = {}, principal: Principal = 'service') {
    return this.post(`/card-imports/commit?${this.proofQuery(account, proof, extra)}`, body, principal);
  }

  async resolve(account: CardAccount, body: string, jobId: string, attempt = 1) {
    return this.commit(account, body, { jobId, attempt, mode: 'resolve' });
  }

  receiptCount(): number {
    return this.db.prepare('SELECT count(*) FROM card_import_proof_receipts').pluck().get() as number;
  }

  private checkingAccounts = 0;

  /**
   * A synthetic checking account, the checking tables installed first when absent, with `debits` as its posted rows and
   * `coverage` imported. Answers the rows' ids, in order. Made-up descriptors and amounts only.
   */
  checking(debits: Array<{ date: string; amountMinor: number; description: string }>,
    coverage: CardImportCoverage = { start: '2026-09-01', end: '2026-10-31' }): string[] {
    if (checkingSchemaState(this.db) !== 'present') installCheckingSchema(this.db);
    const n = ++this.checkingAccounts;
    const letters = (seed: string, length = 32) => [...sha256(`synthetic-checking-${n}-${seed}`)].slice(0, length)
      .map((digit) => 'abcdefghijklmnop'[parseInt(digit, 16)]).join('');
    const account = `chk-acct-${letters('account')}`, imported = `chk-imp-${letters('import')}`;
    this.db.prepare(`INSERT INTO checking_accounts (id, institution, account_type, last4, label, currency, status, created_at)
      VALUES (?, 'wellsfargo', 'checking', ?, 'Sample Everyday Checking', 'USD', 'active', '2026-09-01T00:00:00.000Z')`)
      .run(account, String(n).padStart(4, '0'));
    this.db.prepare(`INSERT INTO checking_imports (id, checking_account_id, payload_digest, parser_version, go_id, purpose,
      rows_inserted, rows_matched, imported_at) VALUES (?, ?, ?, 'synthetic@1', ?, 'copy-rehearsal', ?, 0, '2026-09-01T00:00:00.000Z')`)
      .run(imported, account, sha256(`synthetic-checking-payload-${n}`), sha256(`synthetic-checking-go-${n}`).slice(0, 32), debits.length);
    this.db.prepare(`INSERT INTO checking_coverage (import_id, ordinal, checking_account_id, source, start_date, end_date, row_count)
      VALUES (?, 0, ?, 'synthetic', ?, ?, ?)`).run(imported, account, coverage.start, coverage.end, debits.length);
    return debits.map((debit, index) => {
      const id = `chk-txn-${letters(`row-${index}`)}`;
      this.db.prepare(`INSERT INTO checking_transactions (id, checking_account_id, import_id, row_key, posted_date, amount_minor,
        currency, description) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?)`)
        .run(id, account, imported, `chkd1:${letters(`key-${index}`, 64)}`, debit.date, debit.amountMinor, debit.description);
      return id;
    });
  }
}
