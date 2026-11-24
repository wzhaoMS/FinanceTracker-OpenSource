import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';

/** Where a test may look at a fenced write while it runs (production passes no probe). */
export type MetalsFencePoint = 'fenced' | 'backed-up' | 'written';

/**
 * ROOT's rollback rule for every metals write (install, import, supersede, bindings approve and revoke): the write lock
 * first, then the backup inside it, then the write, then COMMIT.
 *
 * `BEGIN IMMEDIATE` on the writer connection takes SQLite's write lock before anything else, so no other connection,
 * the API's included, can commit a write until this one commits or rolls back: it waits on its busy timeout, or fails
 * SQLITE_BUSY before its own write begins. The backup is taken inside that fence, through a second, read-only
 * connection, so it is exactly the state the write starts from. `prepare` (install, or the installed-schema check) and
 * `write` then run in the same transaction. A failure anywhere inside the fence rolls it back and needs no restore.
 *
 * The backup is a disaster-recovery artifact only: nothing here or in the runbook restores it, and only ROOT may
 * decide to, with an accounting of every write committed after it. Cash and checking keep the shared `backedUpWrite`.
 */
export async function fencedMetalsWrite<T>(db: Database.Database, backupPath: string, write: () => T,
  prepare: (db: Database.Database) => void, probe?: (point: MetalsFencePoint) => void): Promise<T> {
  const canonical = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
  const source = canonical(db.name), target = canonical(backupPath);
  if (db.inTransaction || !path.isAbsolute(backupPath)
    || [source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(target)) {
    throw new HoldrRefusal('metals backup refused');
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      probe?.('fenced');
      fs.closeSync(fs.openSync(backupPath, 'wx', 0o600));
      const reader = new Database(db.name, { readonly: true, fileMustExist: true });
      try {
        await reader.backup(backupPath);
      } finally {
        reader.close();
      }
      fs.chmodSync(backupPath, 0o600);
      probe?.('backed-up');
      prepare(db);
      const result = write();
      probe?.('written');
      db.exec('COMMIT');
      return result;
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
    }
  } catch (error) {
    // The backup is kept on failure; the command reports the failure, never a usable receipt.
    throw toValueFreeDbError('metals fenced write', error);
  }
}
