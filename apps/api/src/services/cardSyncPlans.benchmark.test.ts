import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../testing/cardSyncScenario.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import type { CardSourceBindingView, CardSyncPlanView } from './sqliteStateRepo.js';

// E1b design §7.11's budgets for the extension path, on a file-backed
// database with every card guard installed: P1 (acceptance of a 2,000-row
// payload, re-validation and first items included, ≤ 2.5 s), P3 (commit of
// 2,000 inserts with the recomputation ≤ 2.5 s; of 2,000 replays ≤ 1.5 s) and
// P2 (a prepare of 2,000 observations ≤ 1.5 s, rehydration included). The
// bound is wall-clock time on a shared machine, so each case gets up to
// three attempts on fresh databases; one must meet every bound.

const ROWS = 2000;
const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };

let dir: string;
beforeEach(async () => {
  dir = await makeScratchDir('card-sync-plans-');
});
afterEach(async () => {
  await removeScratchDir(dir);
});

function world(attempt: number): { w: CardSyncScenario; binding: CardSourceBindingView; device: ScenarioDevice; rows: ScenarioRow[] } {
  const w = new CardSyncScenario(`${dir}/attempt-${attempt}.db`);
  w.enable('chase');
  const binding = w.binding();
  const device = w.device([binding.bindingId]);
  const { known } = w.scopes(binding);
  const rows = Array.from({ length: ROWS }, (_, i): ScenarioRow => ({
    scope: known[i % 2], date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`,
    amount: 100 + i, description: `SYNTHETIC MERCHANT ${i % 97} STORE ${i}`, merchant: `Synthetic Merchant ${i % 97}`,
    category: i % 3 === 0 ? 'Dining' : null, id: `sor-bench-${i}`,
  }));
  return { w, binding, device, rows };
}

const timed = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const value = run();
  return [value, performance.now() - started];
};

describe('the extension path at its largest legal set (P1–P3)', () => {
  it(`accepts, prepares and commits ${ROWS} new rows, then a device replays them, within the budgets`, () => {
    const reports: string[] = [];
    let met = false;
    for (let attempt = 1; attempt <= 3 && !met; attempt += 1) {
      const { w, binding, device, rows } = world(attempt);
      try {
        const runId = w.run(device, binding);
        const payload = w.payload(binding, rows);
        const clientRunId = w.repo.getCardSyncRun(runId)!.clientRunId;
        const [receipt, accept] = timed(() => w.repo.acceptCardSyncObservations({ deviceId: device.deviceId, runId, clientRunId,
          ...CardSyncScenario.wire(payload), expectedGeneration: w.generation() }));
        expect(receipt).toMatchObject({ rowCount: ROWS, reviewCount: 0 });
        const [plan, prepare] = timed(() => w.repo.prepareCardSyncPlan({ principal: owner, setId: receipt.observationSetId,
          expectedVersion: 1, expectedGeneration: w.generation() }) as CardSyncPlanView);
        expect(plan.counts.insert).toBe(ROWS);
        const [, commit] = timed(() => w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId,
          payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, expectedGeneration: w.generation() }));
        expect(w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(ROWS);

        const other = w.device([binding.bindingId]);
        const replayRun = w.run(other, binding);
        const replayPayload = w.payload(binding, rows);
        const replay = w.repo.acceptCardSyncObservations({ deviceId: other.deviceId, runId: replayRun,
          clientRunId: w.repo.getCardSyncRun(replayRun)!.clientRunId, ...CardSyncScenario.wire(replayPayload),
          expectedGeneration: w.generation() });
        const [devicePlan, devicePrepare] = timed(() => w.repo.prepareCardSyncPlan({ principal: { kind: 'device', deviceId: other.deviceId },
          setId: replay.observationSetId, expectedGeneration: w.generation() }) as CardSyncPlanView);
        expect(devicePlan).toMatchObject({ status: 'executable', counts: expect.objectContaining({ unchanged: ROWS }) });
        const [, replayCommit] = timed(() => w.repo.commitCardSyncPlan({ principal: { kind: 'device', deviceId: other.deviceId },
          previewId: devicePlan.previewId, payloadDigest: devicePlan.payloadDigest, planDigest: devicePlan.planDigest,
          expectedGeneration: w.generation() }));
        expect(w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(ROWS);
        reports.push(`attempt ${attempt}: accept ${accept.toFixed(0)} ms, prepare ${prepare.toFixed(0)} ms, commit ${commit.toFixed(0)} ms, `
          + `device prepare ${devicePrepare.toFixed(0)} ms, replay commit ${replayCommit.toFixed(0)} ms`);
        met = accept <= 2500 && prepare <= 1500 && commit <= 2500 && devicePrepare <= 1500 && replayCommit <= 1500;
      } finally {
        w.close();
      }
    }
    console.log(`card sync P1–P3 at ${ROWS} rows (budgets: accept 2500, prepare 1500, commit 2500, replay 1500 ms): ${reports.join('; ')}`);
    expect(met, reports.join('; ')).toBe(true);
  }, 300_000);
});
