import { Router } from 'express';
import { createVerifiedRouter } from '../ingress/expressIdentity.js';

import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { isDatabaseFailure } from '../services/dbErrors.js';
import type { Account, Transaction } from '@finance-tracker/shared';
import { aggregateOptionPosition, parseOccSymbol } from '@finance-tracker/shared';

/**
 * Per-resource API for Phase 3. Replaces the whole-blob `PUT /state` contract
 * with normal REST endpoints:
 *
 *   GET    /accounts                          → Account[]
 *   POST   /accounts                          → Account
 *   PATCH  /accounts/:id                      → Account
 *   DELETE /accounts/:id                      → 204 (refused with 409 if it has transactions)
 *
 *   GET    /transactions                      → Transaction[]
 *   GET    /accounts/:id/transactions         → Transaction[]
 *   POST   /accounts/:id/transactions         → Transaction
 *   DELETE /transactions/:id                  → 204
 *
 *   GET    /export                            → { accounts, transactions, schemaVersion, exportedAt }
 *
 * The repo is injected so route tests can hand in an in-memory DB. All
 * write operations validate inputs at the boundary so the repo never sees a
 * malformed object.
 */

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateAccountCreate(body: unknown): { ok: true; value: Account } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (!isString(b.id) || !b.id.trim()) return { ok: false, error: 'id is required' };
  if (!isString(b.name)) return { ok: false, error: 'name is required' };
  if (!isFiniteNumber(b.cashBalance)) return { ok: false, error: 'cashBalance must be a finite number' };
  if (!isString(b.currency)) return { ok: false, error: 'currency is required' };
  if (b.type !== undefined && !isString(b.type)) return { ok: false, error: 'type must be a string' };
  if (b.accountNumber !== undefined && b.accountNumber !== null && !isString(b.accountNumber)) {
    return { ok: false, error: 'accountNumber must be a string' };
  }
  return {
    ok: true,
    value: {
      id: b.id.trim(),
      name: b.name,
      type: (b.type as string | undefined) ?? undefined,
      cashBalance: b.cashBalance,
      currency: b.currency,
      accountNumber:
        typeof b.accountNumber === 'string' && b.accountNumber.trim()
          ? b.accountNumber.trim()
          : undefined,
    },
  };
}

function validateAccountPatch(body: unknown): { ok: true; value: Partial<Account> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: Partial<Account> = {};
  if (b.name !== undefined) {
    if (!isString(b.name)) return { ok: false, error: 'name must be a string' };
    out.name = b.name;
  }
  if (b.type !== undefined) {
    if (b.type !== null && !isString(b.type)) return { ok: false, error: 'type must be a string or null' };
    out.type = b.type === null ? undefined : (b.type as string);
  }
  if (b.cashBalance !== undefined) {
    if (!isFiniteNumber(b.cashBalance)) return { ok: false, error: 'cashBalance must be a finite number' };
    out.cashBalance = b.cashBalance;
  }
  if (b.currency !== undefined) {
    if (!isString(b.currency)) return { ok: false, error: 'currency must be a string' };
    out.currency = b.currency;
  }
  if (b.accountNumber !== undefined) {
    if (b.accountNumber !== null && !isString(b.accountNumber)) {
      return { ok: false, error: 'accountNumber must be a string or null' };
    }
    // Allow setting empty string to clear; treat as undefined so the
    // repo writes NULL.
    out.accountNumber =
      typeof b.accountNumber === 'string' && b.accountNumber.trim()
        ? b.accountNumber.trim()
        : undefined;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'no fields to update' };
  return { ok: true, value: out };
}

function validateTransaction(
  body: unknown,
  accountId: string,
): { ok: true; value: Transaction } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (!isString(b.id) || !b.id.trim()) return { ok: false, error: 'id is required' };
  if (!isString(b.symbol) || !b.symbol.trim()) return { ok: false, error: 'symbol is required' };
  if (!isString(b.date) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
  if (!isFiniteNumber(b.quantity) || b.quantity === 0) return { ok: false, error: 'quantity must be a non-zero finite number' };
  if (!isFiniteNumber(b.pricePerUnit) || b.pricePerUnit < 0) return { ok: false, error: 'pricePerUnit must be a non-negative number' };
  if (!isString(b.currency)) return { ok: false, error: 'currency is required' };
  if (b.fees !== undefined && (!isFiniteNumber(b.fees) || b.fees < 0)) {
    return { ok: false, error: 'fees must be a non-negative finite number' };
  }
  if (b.notes !== undefined && b.notes !== null && !isString(b.notes)) return { ok: false, error: 'notes must be a string' };
  if (
    b.sourceFingerprint !== undefined &&
    b.sourceFingerprint !== null &&
    !isString(b.sourceFingerprint)
  ) {
    return { ok: false, error: 'sourceFingerprint must be a string' };
  }
  const symbol = b.symbol.trim().toUpperCase();
  if (b.instrumentType === 'option') {
    if (!parseOccSymbol(symbol)) return { ok: false, error: 'option symbol must be a valid OCC contract' };
    if (!Number.isInteger(b.quantity)) return { ok: false, error: 'option quantity must be an integer contract count' };
    if (!isFiniteNumber(b.contractMultiplier) || !Number.isInteger(b.contractMultiplier) || b.contractMultiplier <= 0) {
      return { ok: false, error: 'option contractMultiplier must be a positive integer' };
    }
    if (b.positionEffect !== 'open' && b.positionEffect !== 'close') {
      return { ok: false, error: 'option positionEffect must be open or close' };
    }
  } else if (
    b.instrumentType !== undefined
    || b.contractMultiplier !== undefined
    || b.positionEffect !== undefined
  ) {
    return { ok: false, error: 'option fields require instrumentType=option' };
  }
  return {
    ok: true,
    value: {
      id: b.id.trim(),
      accountId,
      // Normalize symbols at the boundary so "aapl", " AAPL ", "AAPL"
      // all round-trip to a single canonical row in the combined view.
      symbol,
      date: b.date,
      quantity: b.quantity,
      pricePerUnit: b.pricePerUnit,
      ...(b.instrumentType === 'option'
        ? {
            instrumentType: 'option' as const,
            contractMultiplier: b.contractMultiplier as number,
            positionEffect: b.positionEffect as 'open' | 'close',
          }
        : {}),
      fees: b.fees as number | undefined,
      currency: b.currency.trim().toUpperCase(),
      notes: typeof b.notes === 'string' ? b.notes : undefined,
      // Empty-string is treated as "no fingerprint" so the activity
      // importer can clear the field by sending '' without a custom
      // sentinel. The repo layer translates undefined → SQL NULL.
      sourceFingerprint:
        typeof b.sourceFingerprint === 'string' && b.sourceFingerprint.trim()
          ? b.sourceFingerprint.trim()
          : undefined,
    },
  };
}

/**
 * aggregateOptionPosition's refusals name the contract, a symbol the request
 * or the stored ledger supplied; the API answers with the rule alone.
 */
const OPTION_LEDGER_RULES = [
  'requires a positive integer contractMultiplier',
  'has incomplete or inconsistent metadata',
  'mixes currencies',
  'opening trade crosses the existing position',
  'close has no open position',
  'close does not oppose the open position',
  'close exceeds the open contract count',
] as const;

function optionLedgerRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid OCC option symbol')) return 'option symbol must be a valid OCC contract';
  const rule = OPTION_LEDGER_RULES.find((suffix) => message.endsWith(` ${suffix}`));
  return rule ? `option ${rule}` : 'option transaction does not fit the account\'s option ledger';
}

function validateOptionLedger(
  repo: SqliteStateRepo,
  candidate: Transaction,
  replacingId?: string,
): string | null {
  if (candidate.instrumentType !== 'option') return null;
  if (!Number.isInteger(candidate.quantity)) {
    return 'option quantity must be an integer contract count';
  }
  const existing = repo.listTransactions(candidate.accountId);
  const ledger = replacingId
    ? existing.map((transaction) => transaction.id === replacingId ? candidate : transaction)
    : [...existing, candidate];
  try {
    aggregateOptionPosition(
      candidate.symbol,
      ledger.filter((transaction) => transaction.symbol === candidate.symbol),
    );
    return null;
  } catch (error) {
    return optionLedgerRefusal(error);
  }
}

function validateOptionLedgerAfterDelete(
  repo: SqliteStateRepo,
  removed: Transaction,
): string | null {
  if (removed.instrumentType !== 'option') return null;
  const remaining = repo.listTransactions(removed.accountId)
    .filter((transaction) => transaction.id !== removed.id && transaction.symbol === removed.symbol);
  try {
    aggregateOptionPosition(removed.symbol, remaining);
    return null;
  } catch (error) {
    return optionLedgerRefusal(error);
  }
}

function validateTransactionPatch(
  body: unknown,
): { ok: true; value: Partial<Pick<Transaction, 'quantity' | 'pricePerUnit' | 'fees' | 'notes'>> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: Partial<Pick<Transaction, 'quantity' | 'pricePerUnit' | 'fees' | 'notes'>> = {};
  if (b.quantity !== undefined) {
    if (!isFiniteNumber(b.quantity) || b.quantity === 0) {
      return { ok: false, error: 'quantity must be a non-zero finite number' };
    }
    out.quantity = b.quantity;
  }
  if (b.pricePerUnit !== undefined) {
    if (!isFiniteNumber(b.pricePerUnit) || b.pricePerUnit < 0) {
      return { ok: false, error: 'pricePerUnit must be a non-negative number' };
    }
    out.pricePerUnit = b.pricePerUnit;
  }
  if (b.fees !== undefined) {
    if (b.fees !== null && !isFiniteNumber(b.fees)) {
      return { ok: false, error: 'fees must be a finite number or null' };
    }
    out.fees = b.fees === null ? undefined : b.fees;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && !isString(b.notes)) {
      return { ok: false, error: 'notes must be a string or null' };
    }
    out.notes = b.notes === null ? undefined : b.notes;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'no fields to update' };
  return { ok: true, value: out };
}

export function createResourceRouter(repo: SqliteStateRepo): Router {
  const router = createVerifiedRouter();

  // ---- accounts ---------------------------------------------------------
  router.get('/accounts', (_req, res) => {
    res.json({ accounts: repo.listAccounts() });
  });

  router.post('/accounts', (req, res) => {
    const parsed = validateAccountCreate(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (repo.getAccount(parsed.value.id)) {
      return res.status(409).json({ error: 'an account with this id already exists' });
    }
    const created = repo.createAccount(parsed.value);
    res.status(201).json(created);
  });

  router.patch('/accounts/:id', (req, res) => {
    const parsed = validateAccountPatch(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const updated = repo.updateAccount(req.params.id, parsed.value);
    if (!updated) return res.status(404).json({ error: 'account not found' });
    res.json(updated);
  });

  router.delete('/accounts/:id', (req, res) => {
    const result = repo.deleteAccount(req.params.id);
    if (result.deleted) return res.status(204).end();
    if (result.reason === 'not found') return res.status(404).json({ error: 'account not found' });
    return res.status(409).json({ error: result.reason ?? 'cannot delete' });
  });

  // ---- transactions -----------------------------------------------------
  router.get('/transactions', (_req, res) => {
    res.json({ transactions: repo.listTransactions() });
  });

  router.get('/accounts/:id/transactions', (req, res) => {
    if (!repo.getAccount(req.params.id)) {
      return res.status(404).json({ error: 'account not found' });
    }
    res.json({ transactions: repo.listTransactions(req.params.id) });
  });

  router.post('/accounts/:id/transactions', (req, res, next) => {
    if (!repo.getAccount(req.params.id)) {
      return res.status(404).json({ error: 'account not found' });
    }
    const parsed = validateTransaction(req.body, req.params.id);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const ledgerError = validateOptionLedger(repo, parsed.value);
    if (ledgerError) return res.status(400).json({ error: ledgerError });
    try {
      const created = repo.createTransaction(parsed.value);
      res.status(201).json(created);
    } catch (err) {
      if (isDatabaseFailure(err)) return next(err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch('/transactions/:id', (req, res) => {
    const parsed = validateTransactionPatch(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const existing = repo.listTransactions().find((transaction) => transaction.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'transaction not found' });
    const candidate: Transaction = { ...existing, ...parsed.value };
    const ledgerError = validateOptionLedger(repo, candidate, existing.id);
    if (ledgerError) return res.status(400).json({ error: ledgerError });
    const updated = repo.updateTransaction(req.params.id, parsed.value);
    res.json(updated);
  });

  router.get('/transactions/:id/cost-basis-check', (req, res) => {
    const check = repo.getCostBasisCheck(req.params.id);
    if (!check) return res.status(404).json({ error: 'transaction not found' });
    res.json(check);
  });

  /**
   * Replace the broker-positions snapshot for an account.
   *
   * Used by the "Pull positions" flow. Given an array of transactions —
   * each tagged with `sourceFingerprint = "pos:<symbol>"` — this endpoint
   * deletes every existing snapshot-tagged row in the account, then
   * inserts the new set, all in one DB transaction.
   *
   * Why a dedicated endpoint instead of looping POST /transactions?
   *   - Atomic: the user never sees a half-replaced state.
   *   - Idempotent: clicking commit twice produces the same result.
   *   - Preserves manual / activity-imported / old-screenshot rows: only
   *     rows whose fingerprint starts with `pos:` are touched. Activity
   *     fingerprints are sha256 hex (no colon) so they're safe.
   */
  router.post('/accounts/:id/snapshot-positions', (req, res, next) => {
    if (!repo.getAccount(req.params.id)) {
      return res.status(404).json({ error: 'account not found' });
    }
    const body = req.body as { transactions?: unknown };
    if (!Array.isArray(body?.transactions)) {
      return res.status(400).json({ error: 'transactions must be an array' });
    }
    const validated: Transaction[] = [];
    for (const raw of body.transactions) {
      const parsed = validateTransaction(raw, req.params.id);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }
      const fp = parsed.value.sourceFingerprint;
      if (!fp || !fp.startsWith('pos:')) {
        return res.status(400).json({ error: 'every transaction must have sourceFingerprint starting with "pos:"' });
      }
      validated.push(parsed.value);
    }
    try {
      const result = repo.replaceSnapshotPositions(req.params.id, validated);
      return res.status(200).json({ ok: true, ...result, transactions: validated });
    } catch (err) {
      if (isDatabaseFailure(err)) return next(err);
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/transactions/:id', (req, res) => {
    const existing = repo.listTransactions().find((transaction) => transaction.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'transaction not found' });
    const ledgerError = validateOptionLedgerAfterDelete(repo, existing);
    if (ledgerError) return res.status(409).json({ error: ledgerError });
    const ok = repo.deleteTransaction(req.params.id);
    if (!ok) return res.status(404).json({ error: 'transaction not found' });
    res.status(204).end();
  });

  // ---- export -----------------------------------------------------------
  router.get('/export', (_req, res) => {
    const accounts = repo.listAccounts();
    res.json({
      schemaVersion: repo.schemaVersion(),
      exportedAt: new Date().toISOString(),
      accounts,
      transactions: repo.listTransactions(),
      cashEvents: accounts.flatMap((account) => repo.listCashEvents(account.id)),
      cashHistory: accounts.flatMap((account) => repo.listCashHistory(account.id)),
    });
  });

  return router;
}
