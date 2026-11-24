import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import {
  checkCheckingBalanceChain,
  checkingDayAmounts,
  checkingDayKeys,
  checkingImportDays,
  findCardNumberPaths,
  mergeCheckingRanges,
  sameCheckingAmounts,
  toLetterHex,
  validateCheckingImportPayload,
  type CheckingImportCoverage,
  type CheckingImportIssue,
  type CheckingImportPayload,
  type CheckingImportRow,
} from '@finance-tracker/shared';

import { digest } from '../amazon/policy.js';
import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';
import { requireCheckingSchema } from './schema.js';

/**
 * Imports a `holdr.checking-import` payload into the checking tables, from the operator's Root-GO'd CLI only. The
 * payload is re-validated here, whoever made it. A day is either fully known or not imported, so:
 * - a day the account already covers must hold exactly the same amounts in the payload, or the whole import refuses
 *   (`checking-overlap-disagrees`), and nothing of that day is written again;
 * - a day it does not cover gets every payload row of that day, keyed by content and given a new random id;
 * - every stated balance (stored and new) must follow from the rows between it and the one before it wherever the
 *   days between are covered, or the whole import refuses (`checking-balance-mismatch`).
 * Nothing is ever updated or deleted. Refusals name dates and counts, never amounts or text.
 */

export type CheckingImportPurpose = 'copy-rehearsal' | 'production-import';

export interface CheckingImportContext {
  /** 24-character ISO instant. */
  now: string;
  /** The Root GO's id (32 hex). */
  goId: string;
  purpose: CheckingImportPurpose;
}

export interface CheckingImportPlan {
  payloadDigest: string;
  account: { exists: boolean; institution: string; last4: string };
  /** The payload was imported before, as these exact bytes' digest: nothing to do. */
  alreadyImported: boolean;
  rowsNew: number;
  /** Payload rows on days the account already covered, which agreed with what is stored. */
  rowsMatched: number;
  daysNew: number;
  daysAlreadyCovered: number;
  anchorsNew: number;
  balanceChain: { checked: number; gaps: number };
  /** The account's covered days once this import is in. */
  coverageAfter: CheckingImportCoverage[];
}

export interface CheckingImportReceipt extends CheckingImportPlan {
  code: 'checking-imported' | 'checking-already-imported';
}

/** A refusal whose message is a stable code; `details` holds dates and counts only. */
export class CheckingImportRefusal extends HoldrRefusal {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const letters = () => toLetterHex(randomBytes(16));

interface StoredDay {
  amounts: number[];
  net: number;
}

interface Prepared {
  payload: CheckingImportPayload;
  plan: CheckingImportPlan;
  accountId: string | null;
  newRows: Array<{ row: CheckingImportRow; key: string }>;
  newAnchors: Array<{ date: string; balanceMinor: number; kind: string }>;
}

/** The payload as validated, or a refusal naming paths only. */
export function validCheckingPayload(value: unknown): CheckingImportPayload {
  const cardPaths = findCardNumberPaths(value);
  if (cardPaths.length > 0) throw new CheckingImportRefusal('checking-payload-card-data', { paths: cardPaths.slice(0, 20) });
  const validation = validateCheckingImportPayload(value);
  if (!validation.ok) {
    throw new CheckingImportRefusal('checking-payload-invalid', { issues: validation.issues.map((issue: CheckingImportIssue) => ({ ...issue })) });
  }
  return validation.payload;
}

function prepare(db: Database, value: unknown): Prepared {
  const payload = validCheckingPayload(value);
  const payloadDigest = digest(payload);
  const { institution, last4, currency } = payload.account;
  const account = db.prepare(`SELECT id, currency FROM checking_accounts WHERE institution = ? AND account_type = 'checking' AND last4 = ?`)
    .get(institution, last4) as { id: string; currency: string } | undefined;
  if (account && account.currency !== currency) throw new CheckingImportRefusal('checking-currency-differs');
  const accountId = account?.id ?? null;
  const alreadyImported = accountId !== null
    && db.prepare('SELECT 1 FROM checking_imports WHERE checking_account_id = ? AND payload_digest = ?').get(accountId, payloadDigest) !== undefined;

  const storedCoverage: CheckingImportCoverage[] = accountId === null ? [] : (db.prepare(
    'SELECT start_date AS start, end_date AS end FROM checking_coverage WHERE checking_account_id = ?',
  ).all(accountId) as CheckingImportCoverage[]);
  const covered = mergeCheckingRanges(storedCoverage);
  const isCovered = (date: string) => covered.some((range) => range.start <= date && range.end >= date);
  const storedDays = new Map<string, StoredDay>();
  if (accountId !== null) {
    for (const row of db.prepare('SELECT posted_date AS date, amount_minor AS amount FROM checking_transactions WHERE checking_account_id = ?')
      .all(accountId) as Array<{ date: string; amount: number }>) {
      const day = storedDays.get(row.date) ?? { amounts: [], net: 0 };
      day.amounts.push(row.amount);
      day.net += row.amount;
      storedDays.set(row.date, day);
    }
  }

  const { days } = checkingImportDays(payload.segments);
  const disagreements: string[] = [];
  const newRows: Prepared['newRows'] = [];
  const nets = new Map<string, number>();
  let rowsMatched = 0;
  let daysAlreadyCovered = 0;
  for (const day of days) {
    if (isCovered(day.date)) {
      daysAlreadyCovered += 1;
      const stored = storedDays.get(day.date)?.amounts ?? [];
      if (!sameCheckingAmounts(checkingDayAmounts(stored.map((amountMinor) => ({ amountMinor }))), checkingDayAmounts(day.rows))) {
        disagreements.push(day.date);
      }
      rowsMatched += day.rows.length;
      continue;
    }
    const keys = checkingDayKeys(day.rows);
    day.rows.forEach((row, index) => newRows.push({ row, key: keys[index] }));
    nets.set(day.date, day.rows.reduce((sum, row) => sum + row.amountMinor, 0));
  }
  if (disagreements.length > 0) {
    throw new CheckingImportRefusal('checking-overlap-disagrees', { days: disagreements.length, dates: disagreements.slice(0, 20) });
  }
  // Days an earlier import covered: their stored rows (none on an empty day).
  for (const range of covered) {
    for (let date = range.start; date <= range.end; date = nextDay(date)) nets.set(date, storedDays.get(date)?.net ?? 0);
  }

  const storedAnchors = accountId === null ? [] : (db.prepare(
    'SELECT as_of_date AS date, balance_minor AS balanceMinor FROM checking_balances WHERE checking_account_id = ?',
  ).all(accountId) as Array<{ date: string; balanceMinor: number }>);
  const storedByDate = new Map(storedAnchors.map((anchor) => [anchor.date, anchor.balanceMinor]));
  const newAnchors: Prepared['newAnchors'] = [];
  const conflicting: string[] = [];
  const seen = new Set<string>();
  for (const anchor of payload.segments.flatMap((segment) => segment.anchors)) {
    const stored = storedByDate.get(anchor.date);
    if (stored !== undefined) {
      if (stored !== anchor.balanceMinor) conflicting.push(anchor.date);
    } else if (!seen.has(anchor.date)) {
      seen.add(anchor.date);
      newAnchors.push({ date: anchor.date, balanceMinor: anchor.balanceMinor, kind: anchor.kind });
    }
  }
  const chain = checkCheckingBalanceChain([...storedAnchors, ...payload.segments.flatMap((segment) => segment.anchors)],
    (date) => nets.get(date) ?? null);
  const mismatches = [...new Set([...conflicting, ...chain.mismatches])].sort();
  if (mismatches.length > 0) {
    throw new CheckingImportRefusal('checking-balance-mismatch', { balances: mismatches.length, dates: mismatches.slice(0, 20) });
  }
  const coverageAfter = mergeCheckingRanges([...covered, ...payload.segments.map((segment) => segment.coverage)]);
  return {
    payload,
    accountId,
    newRows,
    newAnchors,
    plan: {
      payloadDigest,
      account: { exists: accountId !== null, institution, last4 },
      alreadyImported,
      rowsNew: newRows.length,
      rowsMatched,
      daysNew: days.length - daysAlreadyCovered,
      daysAlreadyCovered,
      anchorsNew: newAnchors.length,
      balanceChain: { checked: chain.checked, gaps: chain.gaps },
      coverageAfter,
    },
  };
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Read-only: what importing `value` would do, or the refusal it would meet. Requires the installed tables. */
export function planCheckingImport(db: Database, value: unknown): CheckingImportPlan {
  requireCheckingSchema(db);
  try {
    return db.transaction(() => prepare(db, value).plan)();
  } catch (error) {
    if (error instanceof CheckingImportRefusal) throw error;
    throw toValueFreeDbError('plan checking import', error);
  }
}

/**
 * Writes `value` (the operator's backed-up IMMEDIATE transaction calls this; alone, it runs in one of its own). A
 * payload already imported writes nothing.
 */
export function importCheckingPayload(db: Database, value: unknown, context: CheckingImportContext): CheckingImportReceipt {
  if (!/^[0-9a-f]{32}$/.test(context.goId)) throw new CheckingImportRefusal('checking-go-id-invalid');
  if (context.purpose !== 'copy-rehearsal' && context.purpose !== 'production-import') throw new CheckingImportRefusal('checking-purpose-invalid');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.now)) throw new CheckingImportRefusal('checking-time-invalid');
  requireCheckingSchema(db);
  try {
    return db.transaction((): CheckingImportReceipt => {
      const prepared = prepare(db, value);
      const { payload, plan } = prepared;
      if (plan.alreadyImported) return { code: 'checking-already-imported', ...plan };
      const { institution, last4, label, currency } = payload.account;
      const accountId = prepared.accountId ?? `chk-acct-${letters()}`;
      if (prepared.accountId === null) {
        db.prepare(`INSERT INTO checking_accounts (id, institution, account_type, last4, label, currency, status, created_at)
          VALUES (?, ?, 'checking', ?, ?, ?, 'active', ?)`).run(accountId, institution, last4, label, currency, context.now);
      }
      const importId = `chk-imp-${letters()}`;
      db.prepare(`INSERT INTO checking_imports (id, checking_account_id, payload_digest, parser_version, go_id, purpose, rows_inserted,
        rows_matched, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(importId, accountId, plan.payloadDigest, payload.parserVersion, context.goId, context.purpose, plan.rowsNew, plan.rowsMatched, context.now);
      const coverage = db.prepare(`INSERT INTO checking_coverage (import_id, ordinal, checking_account_id, source, start_date, end_date, row_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      payload.segments.forEach((segment, ordinal) => {
        coverage.run(importId, ordinal, accountId, segment.source, segment.coverage.start, segment.coverage.end, segment.rows.length);
      });
      const insertRow = db.prepare(`INSERT INTO checking_transactions (id, checking_account_id, import_id, row_key, posted_date, amount_minor,
        currency, description, check_number, bank_type, external_id_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const { row, key } of prepared.newRows) {
        insertRow.run(`chk-txn-${letters()}`, accountId, importId, key, row.postedDate, row.amountMinor, currency, row.description,
          row.checkNumber, row.bankType, row.externalIdHash);
      }
      const insertAnchor = db.prepare(`INSERT INTO checking_balances (checking_account_id, as_of_date, balance_minor, kind, import_id)
        VALUES (?, ?, ?, ?, ?)`);
      for (const anchor of prepared.newAnchors) insertAnchor.run(accountId, anchor.date, anchor.balanceMinor, anchor.kind, importId);
      return { code: 'checking-imported', ...plan, account: { ...plan.account, exists: true } };
    }).immediate();
  } catch (error) {
    if (error instanceof CheckingImportRefusal) throw error;
    throw toValueFreeDbError('import checking payload', error);
  }
}
