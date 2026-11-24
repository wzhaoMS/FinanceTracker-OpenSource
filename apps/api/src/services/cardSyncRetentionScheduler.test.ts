import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CardSyncScenario, type ScenarioRow } from '../testing/cardSyncScenario.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CARD_SYNC_RETENTION_BUDGET_MS, type CardSyncRetentionReport } from './cardSync/retention.js';
import { HoldrDbError } from './dbErrors.js';
import {
  CARD_SYNC_RETENTION_CALL_BUDGET_MS, CARD_SYNC_RETENTION_INTERVAL_MS, startCardSyncRetention,
} from './cardSyncRetentionScheduler.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';

// E1b design §10 items 5 and 23: retention at startup and every 10 minutes, again while it reports work left.

const report = (done: boolean, auditCutoffAhead = false): CardSyncRetentionReport =>
  ({ done, deferred: false, phases: [], expiringSets: done ? 0 : 1, auditCutoffAhead });

/** One accepted set of `rows` synthetic rows, past its 30 days; then the WAL is checkpointed empty. The set's id. */
function dueSet(w: CardSyncScenario, rows: number): string {
  w.enable('chase');
  const binding = w.binding();
  const device = w.device([binding.bindingId]);
  const known = w.scopes(binding).known;
  const setId = w.accept(device, binding, Array.from({ length: rows }, (_, i): ScenarioRow => ({ scope: known[0], date: '2026-10-01',
    amount: 100 + i, description: `SYNTHETIC ${i}` }))).receipt.observationSetId;
  w.tick(31 * 86_400);
  w.db.pragma('wal_checkpoint(TRUNCATE)');
  return setId;
}

/** The retention calls that wrote: each one audits `retention-completed` with the code `retention`. */
const retentionWrites = (w: CardSyncScenario) => w.db.prepare(
  "SELECT count(*) FROM card_sync_audit_events WHERE event_type = 'retention-completed' AND code = 'retention'").pluck().get() as number;

/**
 * Retention's work budget is wall-clock time (process.hrtime). On a busy machine a call can spend a whole small budget
 * before its first chunk and write nothing (batch 15's gate), so the tests that count calls or writes on a WAL file give
 * retention this clock instead: each read moves it `stepMs` (0: it stands still, and no call runs out of budget), and a
 * call runs the same chunks however busy the machine is. `afterEach` puts the real clock back.
 */
function retentionClock(stepMs: number): { step: (ms: number) => void } {
  let now = 0n;
  let step = BigInt(stepMs) * 1_000_000n;
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => (now += step));
  return { step: (ms: number) => { step = BigInt(ms) * 1_000_000n; } };
}

function fakeTimers() {
  const ticks: Array<() => void> = [];
  let cleared = 0;
  return {
    ticks,
    cleared: () => cleared,
    setInterval: (run: () => void, ms: number) => {
      expect(ms).toBe(CARD_SYNC_RETENTION_INTERVAL_MS);
      ticks.push(run);
      return { unref: () => undefined };
    },
    clearInterval: () => { cleared += 1; },
    yieldToEventLoop: () => Promise.resolve(),
  };
}

let scenario: CardSyncScenario | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  scenario?.close();
  scenario = undefined;
});

describe('the card sync retention schedule', () => {
  it('runs at once, calls again while work is left, checkpoints before the first call and after each one in turns of their own, and logs audit-cutoff-ahead once per call that reports it', async () => {
    const reports = [report(false, true), report(false), report(true, true)];
    const budgets: Array<number | undefined> = [];
    const steps: string[] = [];
    const logs: string[] = [];
    const timers = fakeTimers();
    const scheduler = startCardSyncRetention({
      repo: {
        runCardSyncRetention: (input) => { budgets.push(input.budgetMs); steps.push('call'); return reports.shift() ?? report(true); },
        checkpointAfterCardSyncRetention: () => { steps.push('checkpoint'); return { complete: true }; },
      },
      log: (line) => logs.push(line), ...timers,
      yieldToEventLoop: () => { steps.push('yield'); return Promise.resolve(); },
    });
    const pass = await scheduler.runNow();
    expect(pass).toEqual({ calls: 3, done: true, failed: false, auditCutoffAhead: 2 });
    // 50 ms a call, the same as retention's own default (O100)
    expect(budgets).toEqual([50, 50, 50]);
    expect(CARD_SYNC_RETENTION_CALL_BUDGET_MS).toBe(CARD_SYNC_RETENTION_BUDGET_MS);
    // a checkpoint before the first call and after each one, each in a turn of its own (O100)
    expect(steps).toEqual(['yield', 'checkpoint', 'yield', 'call', 'yield', 'checkpoint', 'yield', 'call', 'yield', 'checkpoint',
      'yield', 'call', 'yield', 'checkpoint']);
    expect(logs).toEqual(['[card-sync] retention: audit-cutoff-ahead', '[card-sync] retention: audit-cutoff-ahead']);
    // Every 10 minutes after that.
    expect(timers.ticks).toHaveLength(1);
    timers.ticks[0]();
    expect(await scheduler.runNow()).toEqual({ calls: 1, done: true, failed: false, auditCutoffAhead: 0 });
    scheduler.stop();
    expect(timers.cleared()).toBe(1);
    expect(await scheduler.runNow()).toMatchObject({ calls: 0 });
  });

  it('ends a pass on a failed call, logging its type only, and tries again at the next tick', async () => {
    const logs: string[] = [];
    let calls = 0;
    const timers = fakeTimers();
    const scheduler = startCardSyncRetention({
      repo: {
        runCardSyncRetention: () => {
          calls += 1;
          if (calls === 1) throw new HoldrDbError('run card sync retention', 'SQLITE_BUSY');
          return report(true);
        },
        checkpointAfterCardSyncRetention: () => ({ complete: true }),
      },
      log: (line) => logs.push(line), ...timers,
    });
    expect(await scheduler.runNow()).toEqual({ calls: 0, done: false, failed: true, auditCutoffAhead: 0 });
    expect(logs).toEqual(['[card-sync] retention call failed: HoldrDbError SQLITE_BUSY']);
    timers.ticks[0]();
    expect(await scheduler.runNow()).toMatchObject({ done: true, failed: false });
    scheduler.stop();
  });

  it('stops a pass at its call bound, and one pass at a time', async () => {
    let calls = 0;
    const timers = fakeTimers();
    const scheduler = startCardSyncRetention({
      repo: { runCardSyncRetention: () => { calls += 1; return report(false); }, checkpointAfterCardSyncRetention: () => ({ complete: true }) },
      maxCallsPerPass: 4, ...timers,
    });
    const first = scheduler.runNow();
    expect(scheduler.runNow()).toBe(first);
    expect(await first).toEqual({ calls: 4, done: false, failed: false, auditCutoffAhead: 0 });
    expect(calls).toBe(4);
    scheduler.stop();
  });

  it('ends a pass when the checkpoint after a call cannot finish (O100)', async () => {
    const logs: string[] = [];
    let calls = 0;
    const finished = [true];
    const scheduler = startCardSyncRetention({
      repo: {
        runCardSyncRetention: () => { calls += 1; return report(false); },
        checkpointAfterCardSyncRetention: () => ({ complete: finished.shift() ?? false }),
      },
      log: (line) => logs.push(line), ...fakeTimers(),
    });
    expect(await scheduler.runNow()).toEqual({ calls: 1, done: false, failed: false, auditCutoffAhead: 0 });
    expect(calls).toBe(1);
    expect(logs).toEqual(['[card-sync] retention: checkpoint-incomplete']);
    scheduler.stop();
  });

  it('copies the WAL back before its first call, and makes no call while that cannot finish (O100)', async () => {
    const logs: string[] = [];
    let calls = 0;
    const scheduler = startCardSyncRetention({
      repo: { runCardSyncRetention: () => { calls += 1; return report(false); }, checkpointAfterCardSyncRetention: () => ({ complete: false }) },
      log: (line) => logs.push(line), ...fakeTimers(),
    });
    expect(await scheduler.runNow()).toEqual({ calls: 0, done: false, failed: false, auditCutoffAhead: 0 });
    expect(calls).toBe(0);
    expect(logs).toEqual(['[card-sync] retention: checkpoint-incomplete']);
    scheduler.stop();
  });

  it('ends a pass on a failed checkpoint, logging its type only', async () => {
    const logs: string[] = [];
    let checkpoints = 0;
    const scheduler = startCardSyncRetention({
      repo: {
        runCardSyncRetention: () => report(false),
        checkpointAfterCardSyncRetention: () => {
          checkpoints += 1;
          if (checkpoints === 1) return { complete: true };
          throw new HoldrDbError('checkpoint after card sync retention', 'SQLITE_BUSY');
        },
      },
      log: (line) => logs.push(line), ...fakeTimers(),
    });
    expect(await scheduler.runNow()).toEqual({ calls: 1, done: false, failed: true, auditCutoffAhead: 0 });
    expect(logs).toEqual(['[card-sync] retention checkpoint failed: HoldrDbError SQLITE_BUSY']);
    scheduler.stop();
  });

  it('ends a pass at a deferred call, counting no call and checkpointing nothing after it (O100)', async () => {
    const logs: string[] = [];
    let checkpoints = 0;
    const scheduler = startCardSyncRetention({
      repo: {
        runCardSyncRetention: () => ({ ...report(false), deferred: true }),
        checkpointAfterCardSyncRetention: () => { checkpoints += 1; return { complete: true }; },
      },
      log: (line) => logs.push(line), ...fakeTimers(),
    });
    expect(await scheduler.runNow()).toEqual({ calls: 0, done: false, failed: false, auditCutoffAhead: 0 });
    expect(checkpoints).toBe(1);
    expect(logs).toEqual(['[card-sync] retention: checkpoint-incomplete']);
    scheduler.stop();
  });

  it('expires a set past its deadline in the real repository, within its pass', async () => {
    scenario = new CardSyncScenario();
    scenario.enable('chase');
    const binding = scenario.binding();
    const device = scenario.device([binding.bindingId]);
    const known = scenario.scopes(binding).known;
    const rows: ScenarioRow[] = Array.from({ length: 250 }, (_, i) => ({ scope: known[0], date: '2026-10-01', amount: 100 + i,
      description: `SYNTHETIC ${i}` }));
    const setId = scenario.accept(device, binding, rows).receipt.observationSetId;
    scenario.tick(31 * 86_400);
    const scheduler = startCardSyncRetention({ repo: scenario.repo, ...fakeTimers() });
    const pass = await scheduler.runNow();
    scheduler.stop();
    expect(pass).toMatchObject({ done: true, failed: false });
    expect(scenario.db.prepare('SELECT state, close_reason, expired_count FROM card_sync_observation_sets WHERE id = ?').get(setId))
      .toEqual({ state: 'expired-unreviewed', close_reason: 'expired', expired_count: 250 });
  });

  it('turns the auto-checkpoint off only for the call, back on whatever happens, and checkpoints after it on a WAL file (O100)', async () => {
    const dir = await makeScratchDir('card-sync-retention-checkpoint-');
    try {
      const file = path.join(dir, 'retention.db');
      const w = new CardSyncScenario(file);
      try {
        const autoCheckpoint = () => w.db.pragma('wal_autocheckpoint', { simple: true });
        expect(w.db.pragma('journal_mode', { simple: true })).toBe('wal');
        expect(autoCheckpoint()).toBe(1000);
        dueSet(w, 50);
        // 5 ms a read and the 50 ms budget: the call runs 9 chunks, however busy the machine is, so it settles some of
        // the work (the set's 50 rows among it) and leaves the rest
        retentionClock(5);
        const report = w.repo.runCardSyncRetention();
        expect(report.phases.some((phase) => phase.processed > 0)).toBe(true);
        expect(report.phases.some((phase) => phase.remaining)).toBe(true);
        expect(autoCheckpoint()).toBe(1000);
        // the call's commit left its frames in the WAL; the checkpoint after it copies every one back
        const checkpoint = w.repo.checkpointAfterCardSyncRetention();
        expect(checkpoint.complete).toBe(true);
        expect(checkpoint.frames).toBeGreaterThan(0);
        expect(checkpoint.checkpointed).toBe(checkpoint.frames);
        // a refused call never turns it off
        expect(() => w.repo.runCardSyncRetention({ budgetMs: 0 })).toThrow();
        expect(autoCheckpoint()).toBe(1000);
        // a call that fails inside its write puts it back: another connection holds the write lock past this one's wait
        const holder = new Database(file);
        try {
          holder.exec('BEGIN IMMEDIATE');
          w.db.pragma('busy_timeout = 100');
          expect(() => w.repo.runCardSyncRetention()).toThrow(HoldrDbError);
          expect(autoCheckpoint()).toBe(1000);
        } finally {
          holder.exec('ROLLBACK');
          holder.close();
        }
      } finally {
        w.close();
      }
    } finally {
      await removeScratchDir(dir);
    }
  });

  it('writes no retention call over frames a reader still needs: not in a later pass, an explicit call or after a restart (O100)', async () => {
    const dir = await makeScratchDir('card-sync-retention-reader-');
    try {
      const file = path.join(dir, 'retention.db');
      const w = new CardSyncScenario(file);
      let reader: Database.Database | undefined;
      let restarted: SqliteStateRepo | undefined;
      try {
        const setId = dueSet(w, 2_000);
        const frames = () => w.repo.checkpointAfterCardSyncRetention().frames;
        const rows = (state: string) => w.db.prepare(
          'SELECT count(*) FROM card_source_observations WHERE observation_set_id = ? AND state = ?').pluck().get(setId, state) as number;
        // another connection reads, and holds the database as it is now
        reader = new Database(file);
        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) FROM card_sync_observation_sets').pluck().get();
        const logs: string[] = [];
        const log = (line: string) => { logs.push(line); };
        // 1 ms a read and a 10 ms budget: each call runs 9 chunks, however busy the machine is, so pass 1's call
        // settles some of the set (its expiry comes sixth in retention's order) and leaves the rest
        const clock = retentionClock(1);
        const scheduler = startCardSyncRetention({ repo: w.repo, budgetMs: 10, log, ...fakeTimers() });
        // pass 1: its call writes, the reader keeps the checkpoint after it from finishing, and the pass ends there
        expect(await scheduler.runNow()).toEqual({ calls: 1, done: false, failed: false, auditCutoffAhead: 0 });
        // the budget stopped that call partway: some of the set's rows are expired, the rest still open
        expect(rows('expired')).toBeGreaterThan(0);
        expect(rows('open')).toBeGreaterThan(0);
        const held = { frames: frames(), writes: retentionWrites(w) };
        expect(held.frames).toBeGreaterThan(0);
        expect(held.writes).toBe(1);
        // pass 2, the next tick: no call writes while those frames are still needed, and neither does an explicit one
        expect(await scheduler.runNow()).toEqual({ calls: 0, done: false, failed: false, auditCutoffAhead: 0 });
        expect(w.repo.runCardSyncRetention({ budgetMs: 10 })).toMatchObject({ done: false, deferred: true });
        expect({ frames: frames(), writes: retentionWrites(w) }).toEqual(held);
        // a restart: another connection to the same file, as a restarted API or another process opens it
        restarted = new SqliteStateRepo({ file, now: () => new Date(w.clock) });
        const atRestart = frames();
        expect(restarted.runCardSyncRetention({ budgetMs: 10 })).toMatchObject({ done: false, deferred: true });
        const again = startCardSyncRetention({ repo: restarted, budgetMs: 10, log, ...fakeTimers() });
        expect(await again.runNow()).toEqual({ calls: 0, done: false, failed: false, auditCutoffAhead: 0 });
        again.stop();
        expect({ frames: frames(), writes: retentionWrites(w) }).toEqual({ frames: atRestart, writes: 1 });
        expect(logs).toEqual(Array.from({ length: 3 }, () => '[card-sync] retention: checkpoint-incomplete'));
        // once the reader lets go, the next pass first copies those frames back, then finishes: with the clock standing
        // still, its first call settles the rest and its second finds nothing left
        reader.exec('COMMIT');
        reader.close();
        reader = undefined;
        clock.step(0);
        expect(await scheduler.runNow()).toMatchObject({ done: true, failed: false });
        scheduler.stop();
        expect(retentionWrites(w)).toBeGreaterThan(1);
        expect(w.repo.checkpointAfterCardSyncRetention().complete).toBe(true);
        expect(w.db.prepare('SELECT state, expired_count FROM card_sync_observation_sets WHERE id = ?').get(setId))
          .toEqual({ state: 'expired-unreviewed', expired_count: 2_000 });
      } finally {
        reader?.close();
        restarted?.close();
        w.close();
      }
    } finally {
      await removeScratchDir(dir);
    }
  });

  it('writes nothing when another process commits while the call waits for the write lock, then goes on (O100, C30)', async () => {
    const dir = await makeScratchDir('card-sync-retention-race-');
    try {
      const file = path.join(dir, 'retention.db');
      const w = new CardSyncScenario(file);
      let other: ReturnType<typeof spawn> | undefined;
      try {
        dueSet(w, 200);
        w.db.exec('CREATE TABLE o100_probe (x INTEGER)');
        w.db.pragma('wal_checkpoint(TRUNCATE)');
        // another process takes the write lock, then commits about a second later
        other = spawn(process.execPath, ['-e', [
          'const Database = require(process.env.O100_SQLITE);',
          'const db = new Database(process.env.O100_DB);',
          "db.exec('BEGIN IMMEDIATE');",
          "db.prepare('INSERT INTO o100_probe (x) VALUES (1)').run();",
          "process.stdout.write('locked\\n');",
          "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 1000);",
        ].join(' ')], {
          env: { ...process.env, O100_SQLITE: createRequire(import.meta.url).resolve('better-sqlite3'), O100_DB: file },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        const exited = once(other, 'exit');
        const started = other;
        await new Promise<void>((resolve, reject) => {
          let out = '';
          started.stdout?.on('data', (chunk) => { out += String(chunk); if (out.includes('locked')) resolve(); });
          started.on('exit', () => reject(new Error('the other process ended before it held the write lock')));
        });
        // this call finds no frames left to copy back, then waits for the write lock while the other process commits
        expect(w.repo.runCardSyncRetention({ budgetMs: 50 })).toMatchObject({ done: false, deferred: true });
        expect(retentionWrites(w)).toBe(0);
        expect(w.db.prepare('SELECT count(*) FROM o100_probe').pluck().get()).toBe(1);
        expect((await exited)[0]).toBe(0);
        other = undefined;
        // nothing in between now: the next call copies the other process's frames back, then writes; 5 ms a read and its
        // 50 ms budget give it 9 chunks, however busy the machine is, so it settles some of the work and leaves the rest
        retentionClock(5);
        const report = w.repo.runCardSyncRetention({ budgetMs: 50 });
        expect(report.deferred).toBe(false);
        expect(report.phases.some((phase) => phase.remaining)).toBe(true);
        expect(retentionWrites(w)).toBe(1);
      } finally {
        other?.kill();
        w.close();
      }
    } finally {
      await removeScratchDir(dir);
    }
  });
});
