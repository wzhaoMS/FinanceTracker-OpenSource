import type { Database } from 'better-sqlite3';

import { mergeCheckingRanges, type CheckingImportCoverage } from '@finance-tracker/shared';

import { toValueFreeDbError } from '../dbErrors.js';
import { checkingSchemaState } from './schema.js';

/**
 * The read side of the checking tables, as the card-payment reconciliation reads them (the interface agreed with it):
 * accounts, rows by posting date, and the days imports covered. Read-only and value-free on failure. Without the
 * installed tables (or with a conflicting object of their names) every answer is empty and `installed()` is false.
 * Rows are posted bank activity only; checking rows are never spending.
 */
export interface CheckingLedgerAccount {
  /** `chk-acct-` + 32 letters a-p. */
  id: string;
  /** Lowercase bank slug, e.g. `wellsfargo`, `fifththird`. */
  institution: string;
  /** Display name, with no digits. */
  label: string;
  last4: string;
  currency: string;
  status: 'active' | 'closed';
}

export interface CheckingLedgerRow {
  /** `chk-txn-` + 32 letters a-p; stable across re-imports. */
  id: string;
  checkingAccountId: string;
  /** YYYY-MM-DD, the bank's posting date. */
  date: string;
  /** Imports carry posted rows only. */
  status: 'posted';
  /** Integer minor units: negative = money out of the account. */
  amountMinor: number;
  currency: string;
  /** Redacted, as stored. */
  description: string;
  checkNumber: string | null;
}

export interface CheckingLedgerCoverage {
  checkingAccountId: string;
  /** Inclusive, merged and sorted: the days imports covered completely. */
  ranges: CheckingImportCoverage[];
}

export interface CheckingLedgerReader {
  installed(): boolean;
  listAccounts(): CheckingLedgerAccount[];
  /** Rows posted from `from` to `to` (inclusive YYYY-MM-DD), every account, by date then id. */
  listRows(range: { from: string; to: string }): CheckingLedgerRow[];
  coverage(): CheckingLedgerCoverage[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createCheckingLedgerReader(db: Database): CheckingLedgerReader {
  const installed = () => checkingSchemaState(db) === 'present';
  return Object.freeze({
    installed,
    listAccounts(): CheckingLedgerAccount[] {
      try {
        if (!installed()) return [];
        return db.prepare(`SELECT id, institution, label, last4, currency, status FROM checking_accounts ORDER BY institution, last4, id`)
          .all() as CheckingLedgerAccount[];
      } catch (error) {
        throw toValueFreeDbError('list checking accounts', error);
      }
    },
    listRows(range: { from: string; to: string }): CheckingLedgerRow[] {
      if (!range || typeof range.from !== 'string' || typeof range.to !== 'string' || !DATE.test(range.from) || !DATE.test(range.to)) {
        throw new TypeError('listRows needs { from, to } as YYYY-MM-DD dates');
      }
      try {
        if (!installed() || range.from > range.to) return [];
        return db.prepare(`SELECT id, checking_account_id AS checkingAccountId, posted_date AS date, 'posted' AS status,
            amount_minor AS amountMinor, currency, description, check_number AS checkNumber
          FROM checking_transactions WHERE posted_date BETWEEN ? AND ? ORDER BY posted_date, id`)
          .safeIntegers(false).all(range.from, range.to) as CheckingLedgerRow[];
      } catch (error) {
        throw toValueFreeDbError('list checking rows', error);
      }
    },
    coverage(): CheckingLedgerCoverage[] {
      try {
        if (!installed()) return [];
        const rows = db.prepare(`SELECT checking_account_id AS account, start_date AS start, end_date AS end FROM checking_coverage
          ORDER BY checking_account_id`).all() as Array<{ account: string; start: string; end: string }>;
        const byAccount = new Map<string, CheckingImportCoverage[]>();
        for (const row of rows) {
          const list = byAccount.get(row.account) ?? [];
          list.push({ start: row.start, end: row.end });
          byAccount.set(row.account, list);
        }
        return [...byAccount.entries()].map(([checkingAccountId, ranges]) => ({ checkingAccountId, ranges: mergeCheckingRanges(ranges) }));
      } catch (error) {
        throw toValueFreeDbError('read checking coverage', error);
      }
    },
  });
}
