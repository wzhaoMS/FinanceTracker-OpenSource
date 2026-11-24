/**
 * Another Holdr process on the same database file, for
 * services/cardSync.concurrency.test.ts. Run as
 * `node --import tsx cardSyncProcess.ts '<json>'`, it opens the file with this
 * build's repository, as a second server process would, and prints one JSON
 * line on stdout. Synthetic data only; nothing leaves the machine.
 *
 *   { "mode": "kill-at", "file", "hook" }
 *       upgrade the file and SIGKILL this process when the upgrade reaches
 *       `hook` (see HOOKS). The connection's page cache is kept at 8 pages,
 *       so the upgrade spills uncommitted pages into the WAL before it dies.
 *   { "mode": "open", "file", "dir" }
 *       write <dir>/ready, wait for <dir>/go, write <dir>/opening, then open
 *       the file (waiting for another connection's write lock) and report.
 *   { "mode": "import", "file", "dir", "input" }
 *       open the file, write <dir>/ready, wait for <dir>/go, write
 *       <dir>/importing, then run the import (waiting for another
 *       connection's write lock) and report its batch.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteStateRepo, type CardImportInput } from '../services/sqliteStateRepo.js';

type Args =
  | { mode: 'kill-at'; file: string; hook: string }
  | { mode: 'open'; file: string; dir: string }
  | { mode: 'import'; file: string; dir: string; input: CardImportInput };

const args = JSON.parse(process.argv[2] ?? 'null') as Args | null;
if (!args || !args.file) throw new Error('run this from cardSync.concurrency.test.ts');

const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => { Atomics.wait(pause, 0, 0, ms); };
function waitFor(file: string, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    sleep(5);
  }
}
const report = (result: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(result)}\n`);

/** Where the upgrade dies: before the statement that starts a step, or right after one ran. */
type Hook = { exec?: (sql: string) => boolean; prepare?: (sql: string) => boolean; afterRun?: (sql: string) => boolean;
  pragma?: (sql: string) => boolean };
const block = (name: string) => (sql: string) => sql.startsWith(`-- @block ${name}\n`);
const HOOKS: Record<string, Hook> = {
  'after step 3 (scopes)': { exec: block('2.4') },
  'inside the copy (rows copied, old table kept)': { afterRun: (sql) => sql.includes('FROM card_transactions_v14 t') },
  'after the drop of the old table': { exec: block('2.8') },
  'after the backfill': { exec: block('2.19') },
  'after the invariant triggers': { prepare: (sql) => sql.includes("'migration-completed'") },
  'during the guard installs': { exec: (sql) => sql.startsWith('CREATE TRIGGER trg_card_sync_audit_events_guard_') },
  'at the version stamp': { pragma: (sql) => sql === 'user_version = 15' },
};

function killAt(file: string, name: string): void {
  const hook = HOOKS[name];
  if (!hook) throw new Error(`no hook ${name}`);
  const die = () => {
    process.kill(process.pid, 'SIGKILL');
    sleep(60_000);
  };
  const proto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const exec = proto.exec;
  proto.exec = function (this: unknown, sql: unknown) {
    if (typeof sql === 'string' && hook.exec?.(sql)) die();
    return exec.call(this, sql);
  };
  const prepare = proto.prepare;
  proto.prepare = function (this: unknown, sql: unknown) {
    if (typeof sql === 'string' && hook.prepare?.(sql)) die();
    return prepare.call(this, sql);
  };
  const pragma = proto.pragma;
  proto.pragma = function (this: unknown, sql: unknown, options: unknown) {
    if (sql === 'foreign_keys = ON') pragma.call(this, 'cache_size = 8');
    if (typeof sql === 'string' && hook.pragma?.(sql)) die();
    return pragma.call(this, sql, options);
  };
  const probe = new Database(':memory:');
  const statement = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Record<string, (...a: unknown[]) => unknown>;
  probe.close();
  const run = statement.run;
  statement.run = function (this: { source: string }, ...params: unknown[]) {
    const result = run.apply(this, params);
    if (hook.afterRun?.(this.source)) die();
    return result;
  };
  new SqliteStateRepo({ file }).close();
  report({ survived: true });
}

if (args.mode === 'kill-at') {
  killAt(args.file, args.hook);
} else if (args.mode === 'open') {
  fs.writeFileSync(path.join(args.dir, 'ready'), '');
  waitFor(path.join(args.dir, 'go'));
  const startedAt = Date.now();
  fs.writeFileSync(path.join(args.dir, 'opening'), '');
  try {
    const repo = new SqliteStateRepo({ file: args.file });
    const openedAt = Date.now();
    report({ ok: true, version: repo.schemaVersion(), startedAt, openedAt });
    repo.close();
  } catch (error) {
    report({ ok: false, message: (error as Error).message, startedAt, failedAt: Date.now() });
  }
} else {
  const repo = new SqliteStateRepo({ file: args.file });
  fs.writeFileSync(path.join(args.dir, 'ready'), '');
  waitFor(path.join(args.dir, 'go'));
  const startedAt = Date.now();
  fs.writeFileSync(path.join(args.dir, 'importing'), '');
  try {
    const batch = repo.importCardTransactions(args.input);
    report({ ok: true, batch, startedAt, finishedAt: Date.now() });
  } catch (error) {
    report({ ok: false, message: (error as Error).message, startedAt, failedAt: Date.now() });
  } finally {
    repo.close();
  }
}
