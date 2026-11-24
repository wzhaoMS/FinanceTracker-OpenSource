import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { containsCardData, containsCardSecret } from '@finance-tracker/shared';
import { createHealthHandler, type HealthDeps } from './health.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// Synthetic values only: a published test card number and a labeled code.
const PAN = '4111111111111111';
const SECRET = 'CVV 123';

let dir: string;
let repo: SqliteStateRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-health-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

/** The handler behind a stand-in for the auth middleware: signed in (as the service principal) unless told otherwise. */
const appFor = (deps: HealthDeps, { signedIn = true } = {}) => express()
  .use((req, _res, next) => {
    if (signedIn) req.holdrAuth = { kind: 'service' };
    next();
  })
  .get('/health', createHealthHandler(deps));

function expectValueFree(text: string): void {
  for (const value of [PAN, SECRET]) expect(text).not.toContain(value);
  expect(containsCardData(text), text).toBe(false);
  expect(containsCardSecret(text), text).toBe(false);
}

describe('GET /health', () => {
  it('reports the database and snapshot status', async () => {
    const res = await request(await listenLoopback(appFor({ repo, snapshotsEnabled: true }))).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, db: 'sqlite', schemaVersion: 15, accounts: 0, transactions: 0,
      snapshots: { enabled: true, count: 0, latest: null },
    });
  });

  it('shows only ok and schemaVersion without a session, plus the e2e run identity when the stack has one', async () => {
    const anonymous = await request(await listenLoopback(appFor({ repo, snapshotsEnabled: true }, { signedIn: false }))).get('/health');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ ok: true, schemaVersion: repo.schemaVersion() });

    const e2e = { runId: 'ab'.repeat(16), disposableDataDir: true };
    const deps = { repo, snapshotsEnabled: true, e2eIdentity: () => e2e };
    expect((await request(await listenLoopback(appFor(deps, { signedIn: false }))).get('/health')).body).toEqual({ ok: true, schemaVersion: repo.schemaVersion(), e2e });
    expect((await request(await listenLoopback(appFor(deps))).get('/health')).body).toMatchObject({ ok: true, service: 'holdr-api', accounts: 0, e2e });
  });

  it('awaits an e2e identity that is a promise (on Windows the check reads ACLs off the event loop); a rejection stays value-free', async () => {
    const e2e = { runId: 'cd'.repeat(16), disposableDataDir: true };
    const later = () => new Promise<typeof e2e>((resolve) => setTimeout(() => resolve(e2e), 20));
    expect((await request(await listenLoopback(appFor({ repo, snapshotsEnabled: true, e2eIdentity: later }, { signedIn: false }))).get('/health')).body)
      .toEqual({ ok: true, schemaVersion: repo.schemaVersion(), e2e });
    expect((await request(await listenLoopback(appFor({ repo, snapshotsEnabled: true, e2eIdentity: later }))).get('/health')).body)
      .toMatchObject({ ok: true, service: 'holdr-api', accounts: 0, e2e });

    const rejecting = () => Promise.reject(new Error(`${SECRET} ${PAN}`));
    for (const signedIn of [false, true]) {
      const res = await request(await listenLoopback(appFor({ repo, snapshotsEnabled: false, e2eIdentity: rejecting }, { signedIn }))).get('/health');
      expect(res.status).toBe(503);
      expect(res.body).toEqual(signedIn ? { ok: false, error: 'unavailable', code: 'UNKNOWN' } : { ok: false, error: 'unavailable' });
      expectValueFree(res.text);
    }
  });

  it('answers a failing snapshot query with a fixed body and SQLite\'s result code only', async () => {
    // The snapshot table becomes a view over a dropped table named with a test
    // card number, so SQLite's own message would quote it.
    repo.internalGetDb().exec(`
      ALTER TABLE account_snapshots RENAME TO account_snapshots_kept;
      CREATE TABLE pan_${PAN} (taken_at TEXT);
      CREATE VIEW account_snapshots AS SELECT taken_at FROM pan_${PAN};
      DROP TABLE pan_${PAN};
    `);
    expect(() => repo.internalGetDb().prepare('SELECT COUNT(*) FROM account_snapshots').get()).toThrow(PAN);

    const res = await request(await listenLoopback(appFor({ repo, snapshotsEnabled: true }))).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'unavailable', code: 'SQLITE_ERROR' });
    expectValueFree(res.text);
  });

  it('answers any other failure without its message', async () => {
    const failing: HealthDeps['repo'] = {
      counts: () => {
        throw Object.assign(new Error(`${SECRET} ${PAN}`), { code: `SQLITE_${PAN}` });
      },
      schemaVersion: () => 13,
      internalGetDb: () => repo.internalGetDb(),
    };
    const res = await request(await listenLoopback(appFor({ repo: failing, snapshotsEnabled: false }))).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'unavailable', code: 'UNKNOWN' });
    expectValueFree(res.text);

    const busy: HealthDeps['repo'] = {
      ...failing,
      counts: () => {
        throw new Database.SqliteError(`database is locked by ${PAN}`, 'SQLITE_BUSY');
      },
    };
    const locked = await request(await listenLoopback(appFor({ repo: busy, snapshotsEnabled: false }))).get('/health');
    expect(locked.body).toEqual({ ok: false, error: 'unavailable', code: 'SQLITE_BUSY' });
    expectValueFree(locked.text);
  });

  it('answers a failure without a session with the fixed body only', async () => {
    const failing: HealthDeps['repo'] = {
      counts: () => repo.counts(),
      schemaVersion: () => {
        throw new Database.SqliteError(`no such table: pan_${PAN}`, 'SQLITE_ERROR');
      },
      internalGetDb: () => repo.internalGetDb(),
    };
    const anonymous = await request(await listenLoopback(appFor({ repo: failing, snapshotsEnabled: false }, { signedIn: false }))).get('/health');
    expect(anonymous.status).toBe(503);
    expect(anonymous.body).toEqual({ ok: false, error: 'unavailable' });
    expectValueFree(anonymous.text);

    const throwingIdentity = () => {
      throw new Error(`${SECRET} ${PAN}`);
    };
    for (const signedIn of [false, true]) {
      const res = await request(await listenLoopback(appFor({ repo, snapshotsEnabled: false, e2eIdentity: throwingIdentity }, { signedIn }))).get('/health');
      expect(res.status).toBe(503);
      expect(res.body).toEqual(signedIn ? { ok: false, error: 'unavailable', code: 'UNKNOWN' } : { ok: false, error: 'unavailable' });
      expectValueFree(res.text);
    }
  });
});
