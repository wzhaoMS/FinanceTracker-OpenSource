import path from 'node:path';
import fs from 'node:fs';

import { JsonStateRepo } from './jsonStateRepo.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';

export interface MigrationOptions {
  jsonFile: string;
  dbFile: string;
  /** If false, perform a dry run that reports what *would* happen. */
  apply?: boolean;
}

export interface MigrationResult {
  performed: boolean;
  reason: string;
  accountCount?: number;
  transactionCount?: number;
  backupPath?: string;
  archivedPath?: string;
}

/**
 * One-shot migration from `state.json` to a SQLite DB.
 *
 * Idempotent: if the DB already has data, this is a no-op. Safe to call on
 * every server boot.
 *
 * Steps when migration is needed:
 *   1. Read + validate state.json (JsonStateRepo throws on corruption).
 *   2. Snapshot state.json → state.json.preauth-bak.<UTC timestamp> next to it.
 *   3. Open the SQLite file (creates it) and write the full state in a tx.
 *   4. Rename state.json → state.json.migrated.<UTC timestamp> so the old
 *      blob can never be re-read by an older build of the server.
 */
export async function migrateJsonToSqlite(opts: MigrationOptions): Promise<MigrationResult> {
  const { jsonFile, dbFile, apply = true } = opts;

  // Quick exit: if the DB exists and already has data, nothing to do.
  if (fs.existsSync(dbFile)) {
    const existing = new SqliteStateRepo({ file: dbFile });
    try {
      if (!existing.isEmpty()) {
        // Split-brain check: a populated DB plus an unrenamed state.json means
        // an earlier migration succeeded the SQLite write but failed the
        // rename. Surface that loudly so the operator can decide which is
        // authoritative; do not silently overwrite either side.
        if (fs.existsSync(jsonFile)) {
          return {
            performed: false,
            reason:
              `split-brain: SQLite is populated AND ${path.basename(jsonFile)} still exists. ` +
              'Move state.json out of the way (e.g. rename to state.json.manual-bak) and restart.',
          };
        }
        return { performed: false, reason: 'sqlite already populated' };
      }
    } finally {
      existing.close();
    }
  }

  if (!fs.existsSync(jsonFile)) {
    return { performed: false, reason: 'no state.json to migrate' };
  }

  const json = new JsonStateRepo(jsonFile);
  const state = await json.read();
  if (!state) {
    return { performed: false, reason: 'state.json is empty/missing' };
  }

  if (!apply) {
    return {
      performed: false,
      reason: 'dry run',
      accountCount: state.accounts.length,
      transactionCount: state.transactions.length,
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${jsonFile}.preauth-bak.${stamp}`;
  fs.copyFileSync(jsonFile, backupPath);

  const sqlite = new SqliteStateRepo({ file: dbFile });
  try {
    sqlite.write(state);
  } finally {
    sqlite.close();
  }

  const archivedPath = `${jsonFile}.migrated.${stamp}`;
  fs.renameSync(jsonFile, archivedPath);

  return {
    performed: true,
    reason: 'migrated',
    accountCount: state.accounts.length,
    transactionCount: state.transactions.length,
    backupPath,
    archivedPath,
  };
}
