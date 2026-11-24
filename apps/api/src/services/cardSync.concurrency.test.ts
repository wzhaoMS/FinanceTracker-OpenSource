import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { cardSchemaDump } from '../testing/cardSchemaDump.js';
import { CARD_TEST_T0, cardFileRow, writeV14CardLedger } from '../testing/cardSyncLedgerSeed.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { SqliteStateRepo, type CardImportInput } from './sqliteStateRepo.js';

// Card-sync schema v15 (E1b design §3.7, §7.1 M8–M9, §7.7): real processes on
// one database file. A process killed anywhere inside the upgrade leaves the
// v14 file as it was (its uncommitted pages in the WAL are discarded), and
// this build then upgrades it. A second process that opens or imports while
// another holds the IMMEDIATE write lock waits for it, then sees what it
// committed: the upgrade runs once, a row is imported once.

type RawDb = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../..');
const CHILD = path.join(here, '..', 'testing', 'cardSyncProcess.ts');
const GOLDEN = fileURLToPath(new URL('./__fixtures__/card-schema-v15.sql', import.meta.url));
const clock = () => new Date(CARD_TEST_T0);

const pause = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => { Atomics.wait(pause, 0, 0, ms); };
function waitForFileSync(file: string, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    sleepSync(5);
  }
}
async function waitForFile(file: string, child: Child, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (child.exited) throw new Error(`the child exited before ${path.basename(file)}:\n${child.output()}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function withRaw<T>(file: string, read: (db: RawDb) => T): T {
  const db = new Database(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function wholeDatabase(db: RawDb) {
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
  const rows = Object.fromEntries(schema.filter((o) => o.type === 'table')
    .map(({ name }) => [name, db.prepare(`SELECT rowid AS "(rowid)", * FROM "${name}" ORDER BY rowid`).all()]));
  return { version: db.pragma('user_version', { simple: true }), schema, rows };
}

interface Child {
  exited: boolean;
  output(): string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; report: Record<string, unknown> | null }>;
}

/** Starts cardSyncProcess.ts with `args`; `done` settles when it exits, with the JSON line it printed. */
function startChild(args: Record<string, unknown>): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, JSON.stringify(args)], {
    cwd: apiDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const handle: Child = {
    exited: false,
    output: () => `${stdout}${stderr}`,
    done: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        handle.exited = true;
        const line = stdout.trim().split('\n').filter(Boolean).at(-1);
        resolve({ code, signal, report: line ? JSON.parse(line) as Record<string, unknown> : null });
      });
    }),
  };
  return handle;
}

let dir: string;
let fixtureDir: string;
let v14File: string;

beforeAll(async () => {
  fixtureDir = await makeScratchDir('card-sync-v14-');
  v14File = path.join(fixtureDir, 'v14.db');
  writeV14CardLedger(v14File);
});

afterAll(async () => {
  await removeScratchDir(fixtureDir);
});

beforeEach(async () => {
  dir = await makeScratchDir('card-sync-procs-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeScratchDir(dir);
});

const copyOfV14 = () => {
  const file = path.join(dir, 'finance.db');
  fs.copyFileSync(v14File, file);
  return file;
};

describe('card schema v15: a process killed inside the upgrade (M8)', () => {
  it.each([
    'after step 3 (scopes)',
    'inside the copy (rows copied, old table kept)',
    'after the drop of the old table',
    'after the backfill',
    'after the invariant triggers',
    'during the guard installs',
    'at the version stamp',
  ])('killed %s, leaves the v14 file as it was; this build then upgrades it', async (hook) => {
    const file = copyOfV14();
    const before = withRaw(file, wholeDatabase);
    const sha = sha256(file);

    const { code, signal, report } = await startChild({ mode: 'kill-at', file, hook }).done;

    // On Windows, Node's SIGKILL is TerminateProcess: the child exits with code 1 and no signal.
    expect({ code, signal, report }).toEqual(process.platform === 'win32'
      ? { code: 1, signal: null, report: null }
      : { code: null, signal: 'SIGKILL', report: null });
    expect(sha256(file), 'the main file was never written').toBe(sha);
    const walBytes = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;
    expect(walBytes, 'the dead upgrade left uncommitted pages in the WAL').toBeGreaterThan(0);
    withRaw(file, (db) => {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(wholeDatabase(db)).toEqual(before);
    });
    expect(sha256(file)).toBe(sha);
    expect(fs.existsSync(`${file}-wal`), 'recovery discarded the dead WAL').toBe(false);

    new SqliteStateRepo({ file, now: clock }).close();
    expect(withRaw(file, cardSchemaDump)).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });
});

describe('card schema v15: two processes on one file (M9, §7.7)', () => {
  it('a process opening during another\'s upgrade waits for its write lock, then finds v15 and upgrades nothing', async () => {
    const file = copyOfV14();
    const child = startChild({ mode: 'open', file, dir });
    await waitForFile(path.join(dir, 'ready'), child);

    const exec = Database.prototype.exec;
    let releasedAt = 0;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: RawDb, source: string) {
      if (releasedAt === 0 && source.startsWith('-- @block 2.10\n')) {
        // Mid-upgrade (card_transactions renamed, its rebuild next), under the write lock: let the other process try.
        fs.writeFileSync(path.join(dir, 'go'), '');
        waitForFileSync(path.join(dir, 'opening'));
        sleepSync(500);
        releasedAt = Date.now();
      }
      return exec.call(this, source);
    } as RawDb['exec']);
    new SqliteStateRepo({ file, now: clock }).close();
    vi.restoreAllMocks();
    const committedAt = Date.now();

    const { code, report } = await child.done;
    expect(code, child.output()).toBe(0);
    expect(report).toMatchObject({ ok: true, version: 15 });
    const { startedAt, openedAt } = report as { startedAt: number; openedAt: number };
    expect(startedAt, 'it started opening while the upgrade held the lock').toBeLessThanOrEqual(releasedAt - 400);
    expect(openedAt, 'it opened only after the upgrade committed').toBeGreaterThanOrEqual(releasedAt);
    expect(committedAt).toBeGreaterThanOrEqual(releasedAt);
    withRaw(file, (db) => {
      expect(cardSchemaDump(db)).toBe(fs.readFileSync(GOLDEN, 'utf8'));
      expect(db.prepare("SELECT count(*) AS n FROM card_sync_audit_events WHERE event_type = 'migration-completed'").get())
        .toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM card_scopes WHERE kind = 'legacy'").get()).toEqual({ n: 2 });
    });
  });

  it('a process importing during another\'s import of the same file waits for its write lock, then finds every row', async () => {
    const file = path.join(dir, 'finance.db');
    const setup = new SqliteStateRepo({ file, now: clock });
    const cardAccountId = setup.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' }).id;
    setup.close();
    const input: CardImportInput = {
      cardAccountId, source: 'chase-csv', parserVersion: 'csv@1.0.0', coverage: { start: '2026-09-01', end: '2026-09-30' },
      rows: [
        cardFileRow(),
        cardFileRow({ transactionDate: '2026-09-12', postedDate: null, status: 'pending', amountMinor: 4500, description: 'SYNTHETIC HARDWARE' }),
        cardFileRow({ transactionDate: '2026-09-20', postedDate: '2026-09-21', amountMinor: -1250, kind: 'refund', description: 'SYNTHETIC REFUND' }),
      ],
    };
    const child = startChild({ mode: 'import', file, dir, input });
    await waitForFile(path.join(dir, 'ready'), child);

    let holding = false;
    let releasedAt = 0;
    const repo = new SqliteStateRepo({
      file,
      now: () => {
        if (holding) {
          // Inside the import's IMMEDIATE transaction (its first statement reads the clock): let the other process try.
          holding = false;
          fs.writeFileSync(path.join(dir, 'go'), '');
          waitForFileSync(path.join(dir, 'importing'));
          sleepSync(500);
          releasedAt = Date.now();
        }
        return clock();
      },
    });
    try {
      holding = true;
      const first = repo.importCardTransactions(input);
      expect(first).toMatchObject({ newCount: 3, duplicateCount: 0 });

      const { code, report } = await child.done;
      expect(code, child.output()).toBe(0);
      expect(report).toMatchObject({ ok: true, batch: { newCount: 0, duplicateCount: 3 } });
      const { startedAt, finishedAt } = report as { startedAt: number; finishedAt: number };
      expect(startedAt, 'it started importing while the first import held the lock').toBeLessThanOrEqual(releasedAt - 400);
      expect(finishedAt, 'it finished only after the first import committed').toBeGreaterThanOrEqual(releasedAt);

      const db = repo.internalGetDb();
      expect(repo.listCardTransactions()).toHaveLength(3);
      expect(db.prepare('SELECT count(*) AS n FROM card_source_identities').get()).toEqual({ n: 3 });
      expect(db.prepare("SELECT count(*) AS n FROM card_transaction_events WHERE event_type = 'created'").get()).toEqual({ n: 3 });
      expect(db.prepare('SELECT ledger_revision FROM card_accounts').get()).toEqual({ ledger_revision: 1 });
      expect(repo.listCardImportBatches().map((b) => [b.newCount, b.duplicateCount])).toEqual(expect.arrayContaining([[3, 0], [0, 3]]));
    } finally {
      repo.close();
    }
  });
});
