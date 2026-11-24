import { Router } from 'express';
import { aggregateOptionPosition } from '@finance-tracker/shared';
import type { Account, CashEventType, Transaction } from '@finance-tracker/shared';

import {
  type ActivityRow,
  parseActivityRow,
  computeFingerprint,
  classifyForImport,
  type ImportDecision,
  type ParsedAction,
} from '../services/activityParser.js';
import {
  cashEventFromActivity,
  cashEventOccurrenceKey,
  computeCashEventFingerprint,
} from '../services/cashEvents.js';
import { isDatabaseFailure } from '../services/dbErrors.js';
import { asyncRoute } from '../asyncRoute.js';

/**
 * POST /import/activity-from-broker
 *
 * Body: { broker: 'fidelity' | ..., importSweep?: boolean }
 *
 * Pulls the broker's "Activity & Orders" feed via the portfolio-bridge
 * sidecar, parses each row, dedups against existing transactions in the
 * matching account, and returns a preview the UI commits row-by-row.
 *
 * Why preview-only (no auto-write):
 *   - Activity rows can carry corporate actions (REINVEST FDRXX, etc.)
 *     the user may want to opt-in to selectively.
 *   - The user should always see what's about to land in the DB before
 *     it lands. The existing `POST /accounts/:id/transactions` is the
 *     single write path; the partial unique index on
 *     (account_id, source_fingerprint) is the last-line safety net.
 */

/** Per-row outcome surfaced to the UI. */
export type ActivityRowStatus =
  /** Will become a Transaction when the user clicks Commit. */
  | { kind: 'new'; accountId: string; fingerprint: string }
  /** Already in the DB with the same (account, fingerprint). */
  | { kind: 'duplicate'; accountId: string; existingId: string }
  /** Typed cash movement ready for explicit user commit. */
  | { kind: 'new-cash'; accountId: string; fingerprint: string }
  /** Cash movement already stored with the same source fingerprint. */
  | { kind: 'duplicate-cash'; accountId: string; existingId: string }
  /** Account in the row's "Account" column doesn't match any stored
   *  account by last-4. User must add the account or fix the number. */
  | { kind: 'no-account-match'; accountLast4: string | null }
  /** More than one stored account has this last-4. Never choose one
   *  automatically because the activity UI has no per-row account picker. */
  | { kind: 'ambiguous-account-match'; accountLast4: string; accountIds: string[] }
  /** Cash event we deliberately don't store. */
  | { kind: 'skip-cash'; reason: string }
  /** Money-market sweep reinvestment, off by default. */
  | { kind: 'skip-sweep'; reason: string }
  /** Bridge handed us a row missing qty/price for a buy/sell. */
  | { kind: 'reject-incomplete'; reason: string }
  /** Parsed option row conflicts with the account's persisted lifecycle. */
  | { kind: 'reject-option-ledger'; reason: string }
  /** A recognized cash event whose date/account/amount was incomplete. */
  | { kind: 'reject-cash-incomplete'; reason: string }
  /** Description didn't match any known pattern. */
  | { kind: 'reject-unknown'; reason: string };

/** What the UI receives for each row in the activity feed. */
export interface ActivityPreviewRow {
  /** Display fields (kept verbatim for the user). */
  date: string;
  accountLabel: string;
  accountLast4: string | null;
  description: string;
  amount: string;
  /** Action the parser inferred. Always present, even for skip/reject. */
  action: ParsedAction;
  symbol: string | null;
  /** Signed quantity (negative = sell). Null for cash events. */
  quantity: number | null;
  pricePerUnit: number | null;
  fees: number | null;
  instrumentType?: 'option';
  contractMultiplier?: number;
  positionEffect?: 'open' | 'close';
  cashEventType: CashEventType | null;
  cashAmount: number | null;
  cashOccurrence: number | null;
  /** Fingerprint computed from the canonical fields. Present for any row
   *  that parsed enough to fingerprint, which includes skip-sweep so the
   *  UI can show it stably across reloads. */
  fingerprint: string | null;
  /** What the importer is going to do with this row. */
  status: ActivityRowStatus;
}

export interface ActivityImportResponse {
  rows: ActivityPreviewRow[];
  summary: {
    total: number;
    new: number;
    duplicates: number;
    newCash: number;
    duplicateCash: number;
    rejectedCash: number;
    skippedCash: number;
    skippedSweep: number;
    rejected: number;
    noAccountMatch: number;
    ambiguousAccountMatch: number;
  };
  source: {
    broker: string;
    sourceUrl: string | null;
  };
  /** Account list echoed back so the UI can render dropdowns / error
   *  hints without a separate `/accounts` round-trip. */
  accounts: Array<Pick<Account, 'id' | 'name' | 'type' | 'accountNumber'>>;
}

export interface CreateActivityRouterOptions {
  bridgeUrl?: string;
  fetchImpl?: typeof fetch;
  /** Repo for accounts list + dedup lookup. */
  state: {
    listAccounts: () => Account[];
    findTransactionByFingerprint: (
      accountId: string,
      fingerprint: string | null | undefined,
    ) => { id: string } | null;
    findCashEventByFingerprint: (
      accountId: string,
      fingerprint: string | null | undefined,
    ) => { id: string } | null;
    listTransactions: (accountId?: string) => Transaction[];
  };
}

/**
 * Index accounts by last-4 of `accountNumber`. Every match is retained so
 * duplicate last-4 values can be surfaced as ambiguous instead of silently
 * assigning a financial row to the first account.
 */
function indexAccountsByLast4(accounts: Account[]): Map<string, Account[]> {
  const out = new Map<string, Account[]>();
  for (const a of accounts) {
    const num = a.accountNumber;
    if (!num) continue;
    const stripped = num.replace(/[^A-Za-z0-9]/g, '');
    if (stripped.length < 4) continue;
    const key = stripped.slice(-4);
    const arr = out.get(key) ?? [];
    arr.push(a);
    out.set(key, arr);
  }
  return out;
}

export function createActivityImportRouter(opts: CreateActivityRouterOptions) {
  const bridgeUrl =
    opts.bridgeUrl ?? process.env.BROKER_BRIDGE_URL ?? 'http://127.0.0.1:3003';
  const doFetch = opts.fetchImpl ?? fetch;

  const router = Router();

  router.post('/activity-from-broker', asyncRoute(async (req, res, next) => {
    const { broker, importSweep } = req.body ?? {};
    if (typeof broker !== 'string' || !broker.trim()) {
      return res.status(400).json({ error: 'broker is required' });
    }

    const normalizedBroker = broker.trim().toLowerCase();
    let bridgeRes: Response;
    try {
      bridgeRes = await doFetch(`${bridgeUrl}/extract-activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker: normalizedBroker }),
      });
    } catch (err) {
      return res.status(502).json({
        error: `bridge unreachable at ${bridgeUrl}: ${(err as Error).message}`,
        hint: 'start it with: .venv/bin/python apps/portfolio-bridge/server.py',
      });
    }

    let bridgeJson: any;
    try {
      bridgeJson = await bridgeRes.json();
    } catch {
      return res.status(502).json({ error: `bridge returned non-JSON (status ${bridgeRes.status})` });
    }
    if (!bridgeRes.ok) {
      return res.status(bridgeRes.status).json({
        error: bridgeJson?.error ?? `bridge error ${bridgeRes.status}`,
        bridge: bridgeJson,
      });
    }
    if (bridgeJson?.loggedIn === false) {
      return res.status(504).json({
        error: 'login timed out — finish logging in before the timeout next time',
        bridge: bridgeJson,
      });
    }

    const rawRows: ActivityRow[] = Array.isArray(bridgeJson?.rows) ? bridgeJson.rows : [];
    const accounts = opts.state.listAccounts();
    const byLast4 = indexAccountsByLast4(accounts);

    const cashOccurrences = new Map<string, number>();
    const previewRow = (raw: ActivityRow): ActivityPreviewRow => {
      const parsed = parseActivityRow(raw);
      const decision: ImportDecision = classifyForImport(parsed, { importSweep: !!importSweep });
      const cashResult = cashEventFromActivity(parsed);
      const cashEvent = cashResult.kind === 'cash-event' ? cashResult.event : null;

      let fingerprint: string | null = null;
      let cashOccurrence: number | null = null;
      if (cashEvent) {
        const occurrenceKey = cashEventOccurrenceKey(normalizedBroker, cashEvent);
        const occurrence = cashOccurrences.get(occurrenceKey) ?? 0;
        cashOccurrences.set(occurrenceKey, occurrence + 1);
        cashOccurrence = occurrence;
        fingerprint = computeCashEventFingerprint(normalizedBroker, cashEvent, occurrence);
      } else if (cashResult.kind !== 'invalid-cash-event' && decision.kind !== 'reject-unknown') {
        fingerprint = computeFingerprint({
              date: parsed.date,
              accountLast4: parsed.accountLast4,
              action: parsed.action,
              symbol: parsed.symbol,
              quantity: parsed.quantity,
              pricePerUnit: parsed.pricePerUnit,
            });
      }

      // Decision precedence over account matching: skip-cash / skip-sweep
      // / reject still surface even if we have no matching account.
      let status: ActivityRowStatus;
      if (cashResult.kind === 'invalid-cash-event') {
        status = { kind: 'reject-cash-incomplete', reason: cashResult.reason };
      } else if (cashEvent) {
        const matches = byLast4.get(cashEvent.accountLast4) ?? [];
        if (matches.length === 0) {
          status = { kind: 'no-account-match', accountLast4: cashEvent.accountLast4 };
        } else if (matches.length > 1) {
          status = {
            kind: 'ambiguous-account-match',
            accountLast4: cashEvent.accountLast4,
            accountIds: matches.map((account) => account.id),
          };
        } else {
          const account = matches[0];
          const existing = opts.state.findCashEventByFingerprint(account.id, fingerprint);
          status = existing
            ? { kind: 'duplicate-cash', accountId: account.id, existingId: existing.id }
            : { kind: 'new-cash', accountId: account.id, fingerprint: fingerprint! };
        }
      } else if (decision.kind === 'skip-cash') {
        status = { kind: 'skip-cash', reason: decision.reason };
      } else if (decision.kind === 'skip-sweep') {
        status = { kind: 'skip-sweep', reason: decision.reason };
      } else if (decision.kind === 'reject-incomplete') {
        status = { kind: 'reject-incomplete', reason: decision.reason };
      } else if (decision.kind === 'reject-unknown') {
        status = { kind: 'reject-unknown', reason: decision.reason };
      } else {
        // import: now check account + dedup.
        const matches = parsed.accountLast4 ? byLast4.get(parsed.accountLast4) ?? [] : [];
        if (matches.length === 0) {
          status = { kind: 'no-account-match', accountLast4: parsed.accountLast4 };
        } else if (matches.length > 1) {
          status = {
            kind: 'ambiguous-account-match',
            accountLast4: parsed.accountLast4!,
            accountIds: matches.map((account) => account.id),
          };
        } else {
          const account = matches[0];
          const existing = opts.state.findTransactionByFingerprint(account.id, fingerprint);
          if (existing) {
            status = { kind: 'duplicate', accountId: account.id, existingId: existing.id };
          } else if (parsed.instrumentType === 'option') {
            const candidate: Transaction = {
              id: `preview-${fingerprint}`,
              accountId: account.id,
              symbol: parsed.symbol!,
              date: parsed.date,
              quantity: parsed.quantity!,
              pricePerUnit: parsed.pricePerUnit!,
              fees: parsed.fees ?? undefined,
              currency: 'USD',
              instrumentType: 'option',
              contractMultiplier: parsed.contractMultiplier,
              positionEffect: parsed.positionEffect,
              sourceFingerprint: fingerprint!,
            };
            try {
              const persistedLedger = opts.state.listTransactions(account.id)
                .filter((transaction) => transaction.symbol === candidate.symbol);
              aggregateOptionPosition(candidate.symbol, [...persistedLedger, candidate]);
              status = { kind: 'new', accountId: account.id, fingerprint: fingerprint! };
            } catch (error) {
              // A database failure is the request's (below), never a row's reason: its message can quote the database.
              if (isDatabaseFailure(error)) throw error;
              status = { kind: 'reject-option-ledger', reason: (error as Error).message };
            }
          } else {
            status = { kind: 'new', accountId: account.id, fingerprint: fingerprint! };
          }
        }
      }

      return {
        date: raw.date,
        accountLabel: raw.accountLabel,
        accountLast4: parsed.accountLast4,
        description: raw.description,
        amount: raw.amount,
        action: parsed.action,
        symbol: parsed.symbol,
        quantity: parsed.quantity,
        pricePerUnit: parsed.pricePerUnit,
        fees: parsed.fees,
        ...(parsed.instrumentType === 'option'
          ? {
              instrumentType: 'option' as const,
              contractMultiplier: parsed.contractMultiplier,
              positionEffect: parsed.positionEffect,
            }
          : {}),
        cashEventType: cashEvent?.eventType ?? null,
        cashAmount: cashEvent?.amount ?? null,
        cashOccurrence,
        fingerprint,
        status,
      };
    };
    let previews: ActivityPreviewRow[];
    try {
      previews = rawRows.map((raw) => previewRow(raw));
    } catch (error) {
      // To the app's value-free error handler, never into the preview.
      return next(error);
    }

    const summary = {
      total: previews.length,
      new: previews.filter((p) => p.status.kind === 'new').length,
      duplicates: previews.filter((p) => p.status.kind === 'duplicate').length,
      newCash: previews.filter((p) => p.status.kind === 'new-cash').length,
      duplicateCash: previews.filter((p) => p.status.kind === 'duplicate-cash').length,
      rejectedCash: previews.filter((p) => p.status.kind === 'reject-cash-incomplete').length,
      skippedCash: previews.filter((p) => p.status.kind === 'skip-cash').length,
      skippedSweep: previews.filter((p) => p.status.kind === 'skip-sweep').length,
      rejected: previews.filter(
        (p) => p.status.kind === 'reject-incomplete'
          || p.status.kind === 'reject-option-ledger'
          || p.status.kind === 'reject-unknown',
      ).length,
      noAccountMatch: previews.filter((p) => p.status.kind === 'no-account-match').length,
      ambiguousAccountMatch: previews.filter((p) => p.status.kind === 'ambiguous-account-match').length,
    };

    const response: ActivityImportResponse = {
      rows: previews,
      summary,
      source: {
        broker: normalizedBroker,
        sourceUrl: bridgeJson?.sourceUrl ?? null,
      },
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        accountNumber: a.accountNumber,
      })),
    };
    res.json(response);
  }));

  return router;
}
