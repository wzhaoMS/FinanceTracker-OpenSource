import type { Database } from 'better-sqlite3';

import {
  BALANCE_ANCHOR_EXTRACTORS,
  BALANCE_CHAIN_REPORT_FORMAT,
  BALANCE_CHAIN_REPORT_VERSION,
  BALANCE_CHAIN_TIMING_WINDOW_DAYS,
  BALANCE_CHAIN_VERIFIER,
  balanceAnchorRefFromSha256,
  balanceCardRowClass,
  balanceChainReportAccount,
  balanceChainRules,
  verifyBalanceChain,
  type BalanceAnchorInput,
  type BalanceAnchorKind,
  type BalanceChainInput,
  type BalanceChainReport,
  type BalanceChainReportAccount,
  type BalanceChainResult,
  type BalanceChainStoreState,
  type BalanceCoverageRange,
  type BalanceRowInput,
} from '@finance-tracker/shared';

import { cashPlanSchemaState } from './cashPlan.js';
import { checkingSchemaState } from './checking/schema.js';
import { toValueFreeDbError } from './dbErrors.js';

/**
 * The balance-chain verifier's reads (design W6 v1, approved by Root): read-only, value-free on failure, and the same for
 * the operator's `holdr-balance-chain report`, the API's GET /spending/balance-chains and W4's admission hook (inside
 * its transaction). Nothing here writes, and nothing needs a table of its own.
 *
 * - Checking: anchors from `checking_balances` (every kind, with its import as the ref), posted rows from
 *   `checking_transactions` (posting dates) and `checking_coverage`.
 * - Cards: live rows from `card_transactions` (pending and posted; removed rows are left out), classed by the shared
 *   date-basis registry; the declared coverage of `card_import_batches`; anchors from P1's `statement-pdf` rows in
 *   `card_schedule_observations`: bound, C and S present, the account's currency, accepted or held for the minimum's
 *   basis only, from an allowlisted extractor version. Other statement rows are counted, never chained.
 * A store in another shape is reported as `conflict` and never read.
 */

export interface BalanceChainReadOptions {
  /** One account (a `card-acct-` or `chk-acct-` id); every account by default. */
  accountId?: string;
  /** Every anchor and every step per account: the baseline's form. */
  detail?: boolean;
  timingWindowDays?: number;
  /** For tests: the extractor allowlist; the shared `BALANCE_ANCHOR_EXTRACTORS` by default. */
  anchorExtractors?: Readonly<Record<string, string>>;
}

interface Identity {
  kind: 'card' | 'checking';
  id: string;
  issuer: string;
  last4: string | null;
  status: 'active' | 'closed';
  currency: string;
}

interface Prepared {
  identity: Identity;
  input: BalanceChainInput;
  counts: { untrusted: number; excluded: number };
}

const CHECKING_KINDS: Readonly<Record<string, BalanceAnchorKind>> = Object.freeze({
  closing: 'statement-closing', opening: 'statement-opening', ledger: 'ledger', daily: 'daily',
});

function tableExists(db: Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function grouped<T extends { account: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.account);
    if (list) list.push(row);
    else map.set(row.account, [row]);
  }
  return map;
}

function prepareChecking(db: Database, accountId: string | undefined): Prepared[] {
  const accounts = db.prepare(`SELECT id, institution AS issuer, last4, currency, status FROM checking_accounts
    WHERE (? IS NULL OR id = ?) ORDER BY institution, last4, id`).all(accountId ?? null, accountId ?? null) as Array<Omit<Identity, 'kind'>>;
  if (accounts.length === 0) return [];
  const only = accountId ?? null;
  const anchors = grouped(db.prepare(`SELECT checking_account_id AS account, as_of_date AS date, balance_minor AS balance, kind, import_id AS ref
    FROM checking_balances WHERE (? IS NULL OR checking_account_id = ?)`).safeIntegers(false).all(only, only) as Array<{ account: string; date: string; balance: number; kind: string; ref: string }>);
  const rows = grouped(db.prepare(`SELECT checking_account_id AS account, id, posted_date AS date, amount_minor AS amount, currency
    FROM checking_transactions WHERE (? IS NULL OR checking_account_id = ?)`).safeIntegers(false).all(only, only) as Array<{ account: string; id: string; date: string; amount: number; currency: string }>);
  const coverage = grouped(db.prepare(`SELECT checking_account_id AS account, start_date AS start, end_date AS "end"
    FROM checking_coverage WHERE (? IS NULL OR checking_account_id = ?)`).all(only, only) as Array<{ account: string; start: string; end: string }>);
  return accounts.map((account) => ({
    identity: { kind: 'checking', ...account },
    counts: { untrusted: 0, excluded: 0 },
    input: {
      accountId: account.id,
      currency: account.currency,
      anchors: (anchors.get(account.id) ?? []).map((anchor): BalanceAnchorInput => ({
        date: anchor.date, balanceMinor: anchor.balance, kind: CHECKING_KINDS[anchor.kind] ?? 'daily', source: 'checking-import', ref: anchor.ref,
      })),
      rows: (rows.get(account.id) ?? []).map((row): BalanceRowInput => ({
        id: row.id, date: row.date, amountMinor: row.amount, rowClass: 'posting', currency: row.currency,
      })),
      coverage: (coverage.get(account.id) ?? []).map((range): BalanceCoverageRange => ({ start: range.start, end: range.end })),
    },
  }));
}

function prepareCards(db: Database, accountId: string | undefined, statementFacts: BalanceChainStoreState,
  extractors: Readonly<Record<string, string>>): Prepared[] {
  if (!tableExists(db, 'card_accounts')) return [];
  const only = accountId ?? null;
  const accounts = db.prepare(`SELECT id, issuer, last4, currency, status FROM card_accounts WHERE (? IS NULL OR id = ?)
    ORDER BY issuer, last4, id`).all(only, only) as Array<Omit<Identity, 'kind'>>;
  if (accounts.length === 0) return [];
  const versions = tableExists(db, 'card_transaction_versions')
    ? '(SELECT COUNT(*) FROM card_transaction_versions v WHERE v.card_transaction_id = t.id)' : '0';
  const rows = grouped(db.prepare(`SELECT t.card_account_id AS account, t.id, t.source, t.transaction_date AS transactionDate,
      t.posted_date AS postedDate, t.status, t.amount_minor AS amount, t.currency, ${versions} AS version
    FROM card_transactions t WHERE t.status IN ('pending', 'posted') AND (? IS NULL OR t.card_account_id = ?)`).safeIntegers(false).all(only, only) as Array<{
      account: string; id: string; source: string; transactionDate: string; postedDate: string | null; status: 'pending' | 'posted'; amount: number;
      currency: string; version: number;
    }>);
  const coverage = grouped(db.prepare(`SELECT card_account_id AS account, coverage_start AS start, coverage_end AS "end" FROM card_import_batches
    WHERE coverage_start IS NOT NULL AND coverage_end IS NOT NULL AND (? IS NULL OR card_account_id = ?)`).all(only, only) as Array<{ account: string; start: string; end: string }>);
  const facts = grouped(statementFacts !== 'present' ? [] : db.prepare(`SELECT card_account_id AS account, currency, source_ref AS sourceRef,
      extractor_version AS extractor, statement_closing_date AS date, statement_balance_minor AS balance, status, held_reason AS heldReason
    FROM card_schedule_observations WHERE source_kind = 'statement-pdf' AND card_account_id IS NOT NULL AND (? IS NULL OR card_account_id = ?)`)
    .safeIntegers(false).all(only, only) as Array<{
      account: string; currency: string; sourceRef: string; extractor: string; date: string | null; balance: number | null; status: string; heldReason: string | null;
    }>);
  return accounts.map((account) => {
    const counts = { untrusted: 0, excluded: 0 };
    const anchors: BalanceAnchorInput[] = [];
    for (const fact of facts.get(account.id) ?? []) {
      const ref = balanceAnchorRefFromSha256(fact.sourceRef);
      const usable = fact.date !== null && fact.balance !== null && fact.currency === account.currency && ref !== null
        && (fact.status === 'accepted' || (fact.status === 'held' && fact.heldReason === 'minimum-basis'));
      if (!usable) counts.excluded += 1;
      else if (!Object.hasOwn(extractors, fact.extractor)) counts.untrusted += 1;
      else anchors.push({ date: fact.date!, balanceMinor: fact.balance!, kind: 'statement-closing', source: 'statement-facts', ref: ref! });
    }
    return {
      identity: { kind: 'card', ...account },
      counts,
      input: {
        accountId: account.id,
        currency: account.currency,
        anchors,
        rows: (rows.get(account.id) ?? []).map((row): BalanceRowInput => {
          const rowClass = balanceCardRowClass({ status: row.status, postedDate: row.postedDate, source: row.source }, account.issuer);
          return { id: row.id, date: rowClass === 'posting' ? row.postedDate! : row.transactionDate, amountMinor: row.amount, rowClass,
            currency: row.currency, version: row.version };
        }),
        coverage: (coverage.get(account.id) ?? []).map((range): BalanceCoverageRange => ({ start: range.start, end: range.end })),
      },
    };
  });
}

function readAll(db: Database, options: BalanceChainReadOptions): { prepared: Prepared[]; stores: BalanceChainReport['stores'] } {
  return db.transaction(() => {
    const checking = checkingSchemaState(db);
    const statementFacts = cashPlanSchemaState(db);
    const extractors = options.anchorExtractors ?? BALANCE_ANCHOR_EXTRACTORS;
    const prepared = [
      ...(checking === 'present' ? prepareChecking(db, options.accountId) : []),
      ...prepareCards(db, options.accountId, statementFacts, extractors),
    ];
    return { prepared, stores: { checking, statementFacts } };
  })();
}

/** Every account's chain (or one account's), as the strict-schema report. Read-only; one consistent snapshot. */
export function readBalanceChainReport(db: Database, options: BalanceChainReadOptions = {}): BalanceChainReport {
  const timingWindowDays = options.timingWindowDays ?? BALANCE_CHAIN_TIMING_WINDOW_DAYS;
  const rules = balanceChainRules({ timingWindowDays, anchorExtractors: options.anchorExtractors });
  try {
    const { prepared, stores } = readAll(db, options);
    const accounts: BalanceChainReportAccount[] = prepared.map(({ identity, input, counts }) => balanceChainReportAccount(identity,
      verifyBalanceChain(input, { timingWindowDays, rules }), counts, options.detail === true));
    accounts.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'checking' ? -1 : 1));
    return {
      format: BALANCE_CHAIN_REPORT_FORMAT, version: BALANCE_CHAIN_REPORT_VERSION, verifier: BALANCE_CHAIN_VERIFIER, rules, timingWindowDays,
      stores, accounts,
    };
  } catch (error) {
    throw toValueFreeDbError('read balance chains', error);
  }
}

/**
 * One card account's chain, for W4's G-ADMISSION hook: run on BEFORE and AFTER with the transaction's own connection,
 * then `admitBalanceChain`. Null when the account doesn't exist.
 */
export function verifyCardAccountChain(db: Database, cardAccountId: string, options: Omit<BalanceChainReadOptions, 'accountId' | 'detail'> = {}):
  BalanceChainResult | null {
  const timingWindowDays = options.timingWindowDays ?? BALANCE_CHAIN_TIMING_WINDOW_DAYS;
  const rules = balanceChainRules({ timingWindowDays, anchorExtractors: options.anchorExtractors });
  try {
    const card = db.transaction(() => prepareCards(db, cardAccountId, cashPlanSchemaState(db), options.anchorExtractors ?? BALANCE_ANCHOR_EXTRACTORS))();
    return card.length === 0 ? null : verifyBalanceChain(card[0].input, { timingWindowDays, rules });
  } catch (error) {
    throw toValueFreeDbError('verify card balance chain', error);
  }
}
