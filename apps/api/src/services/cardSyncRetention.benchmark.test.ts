import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CardSyncRetentionResult, type CardSyncValidatorRun, runCardSyncValidator } from '../testing/cardSyncValidator.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

// Card-sync schema v15 (E1b): the design validator's guarded retention
// benchmark (design §5.9, §2.20 step 6), the heavy check, kept in its own file.
// A long-lived ledger (30,000 identities and events, 5,000 purgeable
// observations, a due 2,000-row set with 2,000 open items, every phase at its
// worst legal size) is opened by the repository, which migrates it and puts
// this build's real card guards on all 31 card tables. Retention then runs as
// whole calls of the seven phases, the clock read before every chunk; every
// call, commit included, must stay under the design's 250 ms. A call's commit
// leaves its frames in the WAL, and the repository's checkpoint copies them
// back after the call, in a slice of its own that must stay under 250 ms too
// (O100). The bound is wall-clock time, so a busy machine gets up to five
// attempts, each on a byte-identical copy of the ledger: every attempt must
// settle everything, and one must keep every call and every checkpoint within
// the bound. A checkpoint flushes to a disk that may still be writing back
// earlier data (this benchmark's own ledger copies, another test's heavy
// writes), so each copy is flushed when it is made and each attempt starts on
// a quiet disk; the report gives every attempt's wait, its calls and
// checkpoints, and each over-bound call's commit.

const LIMIT_MS = 250;

let dir: string;
let run: CardSyncValidatorRun;
let retention: CardSyncRetentionResult;

/** Every attempt's disk wait, calls and checkpoints, and what went over the bound. */
const report = () => retention.attempts.map((attempt, i) => {
  const { quiet, waitedMs, probes, slowestMs } = attempt.disk;
  const over = [
    ...attempt.calls.flatMap((ms, call) => (ms > LIMIT_MS
      ? [`call ${call + 1} ${ms.toFixed(0)} ms (commit ${attempt.commits[call].toFixed(0)})`] : [])),
    ...attempt.checkpoints.flatMap((ms, call) => (ms > LIMIT_MS ? [`the checkpoint after call ${call + 1} ${ms.toFixed(0)} ms`] : [])),
  ];
  return `attempt ${i + 1}, after ${waitedMs.toFixed(0)} ms for a ${quiet ? 'quiet' : 'still busy'} disk (${probes} probes,`
    + ` slowest ${slowestMs.toFixed(0)} ms): ${attempt.calls.map((ms) => ms.toFixed(0)).join('/')} ms`
    + `, checkpoints ${attempt.checkpoints.map((ms) => ms.toFixed(0)).join('/')} ms`
    + (over.length ? `, over ${LIMIT_MS}: ${over.join(', ')}` : '');
}).join('; ');

beforeAll(async () => {
  dir = await makeScratchDir('card-sync-retention-');
  run = runCardSyncValidator({ workDir: dir, sections: { retention: true } });
  if (!run.results.retention) throw new Error(`the benchmark did not finish: ${JSON.stringify(run.sectionFailures)}`);
  retention = run.results.retention;
}, 900_000);

afterAll(async () => {
  await removeScratchDir(dir);
});

describe('card-sync retention under the real card guards, at worst legal sizes', () => {
  it('runs on a migrated ledger with every card table guarded', () => {
    expect(run.sectionFailures.migration).toEqual([]);
    // `current`: reopening the benchmark ledger rewrote no guard, so they are this build's own.
    expect(retention.guardInfo).toEqual({ tables: 31, triggers: 62, current: true });
    expect(retention.consentGrants).toBe(116);
  });

  it(`settles all seven phases in whole calls of at most ${LIMIT_MS} ms each, commit included`, () => {
    const { worst, worstCheckpoint, left, done, attempts } = retention;
    const text = report();
    console.log(`card sync retention: ${Math.max(worst, worstCheckpoint) <= LIMIT_MS ? 'met' : 'NOT MET'}; ${text}`);
    expect(attempts.every((attempt) => attempt.settledAll), text).toBe(true);
    expect(done, 'the last call found nothing left').toBe(true);
    expect(Object.entries(left).filter(([, n]) => n !== 0)).toEqual([]);
    expect(worst, text).toBeLessThanOrEqual(LIMIT_MS);
    expect(run.sectionFailures.retention).toEqual([]);
    expect(run.results.behaviour).toBe(1);
  });

  it(`checkpoints after every call, in a slice of its own of at most ${LIMIT_MS} ms (O100)`, () => {
    expect(retention.checkpoints).toHaveLength(retention.calls.length);
    expect(retention.worstCheckpoint, report()).toBeLessThanOrEqual(LIMIT_MS);
  });
});
