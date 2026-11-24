import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { migrateJsonToSqlite } from './migrateState.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-migrate-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fixture = {
  accounts: [
    { id: 'a', name: 'A', cashBalance: 100, currency: 'USD' },
    { id: 'b', name: 'B', cashBalance: 0, currency: 'USD' },
  ],
  transactions: [
    { id: 't1', accountId: 'a', symbol: 'AAPL', date: '2026-05-04', quantity: 10, pricePerUnit: 150, currency: 'USD' },
  ],
};

describe('migrateJsonToSqlite', () => {
  it('no-op when there is no state.json', async () => {
    const res = await migrateJsonToSqlite({
      jsonFile: path.join(dir, 'state.json'),
      dbFile: path.join(dir, 'finance.db'),
    });
    expect(res.performed).toBe(false);
    expect(res.reason).toMatch(/no state\.json/);
  });

  it('migrates a valid state.json and archives the original', async () => {
    const jsonFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'finance.db');
    await writeFile(jsonFile, JSON.stringify(fixture, null, 2), 'utf8');

    const res = await migrateJsonToSqlite({ jsonFile, dbFile });
    expect(res.performed).toBe(true);
    expect(res.accountCount).toBe(2);
    expect(res.transactionCount).toBe(1);
    expect(res.backupPath).toBeDefined();
    expect(res.archivedPath).toBeDefined();

    // Original is gone, replaced by the archived + backup files.
    expect(fs.existsSync(jsonFile)).toBe(false);
    expect(fs.existsSync(res.backupPath!)).toBe(true);
    expect(fs.existsSync(res.archivedPath!)).toBe(true);
    // Backup byte-equals original.
    expect(await readFile(res.backupPath!, 'utf8')).toBe(JSON.stringify(fixture, null, 2));

    // SQLite has the data.
    const repo = new SqliteStateRepo({ file: dbFile });
    try {
      expect(repo.read()).toEqual(fixture);
    } finally {
      repo.close();
    }
  });

  it('no-op when the SQLite DB is already populated (idempotent)', async () => {
    const jsonFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'finance.db');
    await writeFile(jsonFile, JSON.stringify(fixture, null, 2), 'utf8');
    await migrateJsonToSqlite({ jsonFile, dbFile });
    // After a clean migration state.json is gone (it was renamed). The
    // populated-DB-only branch is what reboots see.

    const res = await migrateJsonToSqlite({ jsonFile, dbFile });
    expect(res.performed).toBe(false);
    expect(res.reason).toMatch(/already populated/);

    const repo = new SqliteStateRepo({ file: dbFile });
    try {
      expect(repo.read()).toEqual(fixture);
    } finally {
      repo.close();
    }
  });

  it('refuses to migrate corrupt JSON (DB stays empty, original untouched)', async () => {
    const jsonFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'finance.db');
    await writeFile(jsonFile, '{ this is not json', 'utf8');

    await expect(migrateJsonToSqlite({ jsonFile, dbFile })).rejects.toThrow();
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(false);
  });

  it('dry-run reports counts without touching disk', async () => {
    const jsonFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'finance.db');
    await writeFile(jsonFile, JSON.stringify(fixture), 'utf8');

    const res = await migrateJsonToSqlite({ jsonFile, dbFile, apply: false });
    expect(res.performed).toBe(false);
    expect(res.reason).toBe('dry run');
    expect(res.accountCount).toBe(2);
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('detects split-brain (populated DB + leftover state.json) and refuses to act', async () => {
    const jsonFile = path.join(dir, 'state.json');
    const dbFile = path.join(dir, 'finance.db');
    await writeFile(jsonFile, JSON.stringify(fixture), 'utf8');

    // First migration: succeeds, state.json gets archived.
    const first = await migrateJsonToSqlite({ jsonFile, dbFile });
    expect(first.performed).toBe(true);

    // Recreate state.json (simulating a failed rename or a manual restore).
    await writeFile(jsonFile, JSON.stringify(fixture), 'utf8');

    const second = await migrateJsonToSqlite({ jsonFile, dbFile });
    expect(second.performed).toBe(false);
    expect(second.reason).toMatch(/split-brain/);
    // Both files still exist; nothing was clobbered.
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(true);
  });
});
