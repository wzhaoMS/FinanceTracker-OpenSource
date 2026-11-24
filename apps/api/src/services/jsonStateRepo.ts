import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Account, Transaction } from '@finance-tracker/shared';
import { parseOccSymbol } from '@finance-tracker/shared';

export interface PersistedState {
  accounts: Account[];
  transactions: Transaction[];
}

/**
 * Minimal validator: the API must reject malformed payloads (missing arrays,
 * wrong types) so a bad `PUT /state` never corrupts the on-disk file.
 *
 * Returns null if the input is the right shape, otherwise a human-readable
 * error message describing the first problem found.
 */
export function validatePersistedState(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'state must be an object';
  const s = input as Record<string, unknown>;
  if (!Array.isArray(s.accounts)) return 'state.accounts must be an array';
  if (!Array.isArray(s.transactions)) return 'state.transactions must be an array';

  for (const [i, a] of (s.accounts as unknown[]).entries()) {
    if (!a || typeof a !== 'object') return `accounts[${i}] must be an object`;
    const acc = a as Record<string, unknown>;
    if (typeof acc.id !== 'string' || !acc.id) return `accounts[${i}].id must be a non-empty string`;
    if (typeof acc.name !== 'string') return `accounts[${i}].name must be a string`;
    if (typeof acc.cashBalance !== 'number' || !Number.isFinite(acc.cashBalance))
      return `accounts[${i}].cashBalance must be a finite number`;
    if (typeof acc.currency !== 'string') return `accounts[${i}].currency must be a string`;
  }

  for (const [i, t] of (s.transactions as unknown[]).entries()) {
    if (!t || typeof t !== 'object') return `transactions[${i}] must be an object`;
    const tx = t as Record<string, unknown>;
    if (typeof tx.id !== 'string' || !tx.id) return `transactions[${i}].id must be a non-empty string`;
    if (typeof tx.accountId !== 'string') return `transactions[${i}].accountId must be a string`;
    if (typeof tx.symbol !== 'string') return `transactions[${i}].symbol must be a string`;
    if (typeof tx.date !== 'string') return `transactions[${i}].date must be a string`;
    if (typeof tx.quantity !== 'number' || !Number.isFinite(tx.quantity))
      return `transactions[${i}].quantity must be a finite number`;
    if (typeof tx.pricePerUnit !== 'number' || !Number.isFinite(tx.pricePerUnit))
      return `transactions[${i}].pricePerUnit must be a finite number`;
    if (typeof tx.currency !== 'string') return `transactions[${i}].currency must be a string`;
    if (tx.instrumentType === 'option') {
      if (!parseOccSymbol(tx.symbol as string)) return `transactions[${i}].symbol must be a valid OCC option symbol`;
      if (!Number.isInteger(tx.quantity)) return `transactions[${i}].quantity must be an integer contract count`;
      if (!Number.isInteger(tx.contractMultiplier) || (tx.contractMultiplier as number) <= 0) {
        return `transactions[${i}].contractMultiplier must be a positive integer`;
      }
      if (tx.positionEffect !== 'open' && tx.positionEffect !== 'close') {
        return `transactions[${i}].positionEffect must be open or close`;
      }
    } else if (
      tx.instrumentType !== undefined
      || tx.contractMultiplier !== undefined
      || tx.positionEffect !== undefined
    ) {
      return `transactions[${i}] option fields require instrumentType=option`;
    }
  }

  // Referential integrity: every transaction's accountId must exist.
  const accountIds = new Set((s.accounts as Array<{ id: string }>).map((a) => a.id));
  for (const [i, tx] of (s.transactions as Array<{ accountId: string }>).entries()) {
    if (!accountIds.has(tx.accountId)) {
      return `transactions[${i}].accountId "${tx.accountId}" does not match any account`;
    }
  }

  return null;
}

/**
 * File-backed key-value-style store for the whole `{ accounts, transactions }`
 * blob. Atomic writes via tmp-and-rename so a crash mid-write cannot corrupt
 * the live file. No locking — the API server is single-process, requests
 * arrive serially through the event loop.
 */
export class JsonStateRepo {
  constructor(private readonly file: string) {}

  /** Returns null if the file does not exist. Throws on parse error. */
  async read(): Promise<PersistedState | null> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const err = validatePersistedState(parsed);
      if (err) throw new Error(`corrupt state file: ${err}`);
      return parsed as PersistedState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(state: PersistedState): Promise<void> {
    const err = validatePersistedState(state);
    if (err) throw new Error(`refusing to write invalid state: ${err}`);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}
