import { copyFileSync } from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARD_SYNC_V2_MAX_BYTES, cardExternalIdHash } from '@finance-tracker/shared';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../testing/cardSyncScenario.js';
import { type QuietDisk, flushFile, waitForQuietDisk } from '../testing/quietDisk.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import type { CardImportRow, CardSourceBindingView, CardSyncPlanView } from './sqliteStateRepo.js';

// E1b design §7.11 P1–P3 on a candidate-heavy first sync against a pre-existing ledger (slice 2 review r1, finding 8): a
// file-backed, fully guarded ledger of 50,000 transactions (P2's size), 1,000 of them near candidates of every uploaded
// row. A valid 2,000-row upload of almost 2 MiB (P1's size, the wire's limit), whose every row becomes a review item with
// five candidates, is accepted (P1 ≤ 2.5 s); the owner decides every item `insert-new`; the plan is prepared (P2 ≤ 1.5 s
// against P2's 50,000-row ledger, rehydration and reclassification included) and committed (P3 ≤ 2.5 s for its 2,000
// inserts, the payload-integrity check included; review r2, finding 4). P8 (no API transaction holds the write lock over
// 3 s at the limits) is an extra ceiling on every phase, not a replacement. The ledger is built once (v1 imports) and
// copied for each attempt.
//
// Wall-clock time on a machine other processes share: up to five attempts, every attempt reported, and each phase judged
// by its best attempt, the least contended measure of the same work, against the original thresholds. When no attempt
// meets them and every attempt ran with the machine's 1-minute load average at or above its number of cores, the
// measurement is inconclusive: the test reports so and is skipped, never passed. Any attempt on a machine below that
// load makes a miss a failure. Each attempt's copy of the ledger is flushed to disk when it is made, and its timed phases
// start on a quiet disk (testing/quietDisk.ts), so writeback still pending from the copy or an earlier test stays out.

const LEDGER_ROWS = 50_000;
const NEAR_ROWS = 1_000;
const UPLOAD_ROWS = 2_000;
const IMPORT_CHUNK = 2_000;
const DECISION_CHUNK = 200;
const PAD = ' LOREM IPSUM DOLOR SIT AMET CONSECTETUR ADIPISCING ELIT SED DO EIUSMOD TEMPOR INCIDIDUNT UT LABORE ET DOLORE MAGNA'
  + ' ALIQUA UT ENIM AD MINIM VENIAM QUIS NOSTRUD EXERCITATION ULLAMCO LABORIS NISI UT ALIQUIP EX EA COMMODO CONSEQUAT DUIS AUTE'
  + ' IRURE DOLOR IN REPREHENDERIT IN VOLUPTATE VELIT ESSE CILLUM DOLORE EU FUGIAT NULLA PARIATUR EXCEPTEUR SINT OCCAECAT'
  + ' CUPIDATAT NON PROIDENT SUNT IN CULPA QUI OFFICIA DESERUNT MOLLIT ANIM ID EST LABORUM';
const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };

let dir: string;
let template: string;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];

const day = (base: string, offset: number) => new Date(Date.parse(`${base}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const merchant = (i: number) => `Near Shop ${i % 50} General Merchandise And Household Goods`;
const timed = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const value = run();
  return [value, performance.now() - started];
};

beforeAll(async () => {
  dir = await makeScratchDir('card-sync-candidates-');
  template = `${dir}/ledger.db`;
  const w = new CardSyncScenario(template);
  try {
    w.enable('chase');
    binding = w.binding();
    device = w.device([binding.bindingId]);
    ({ known } = w.scopes(binding));
    const ledger: CardImportRow[] = Array.from({ length: LEDGER_ROWS }, (_, i) => {
      const near = i < NEAR_ROWS;
      const date = near ? day('2026-10-01', i % 20) : day('2024-01-01', i % 600);
      return {
        externalIdHash: cardExternalIdHash(`ledger-${i}`), transactionDate: date, postedDate: date, status: 'posted', currency: 'USD',
        amountMinor: near ? 1250 : 10_000 + i, kind: 'purchase', description: near ? `NEAR SHOP ${i % 50} ORDER ${i}` : `LEDGER SHOP ${i}`,
        merchant: near ? merchant(i) : null,
      };
    });
    for (let start = 0; start < LEDGER_ROWS; start += IMPORT_CHUNK) {
      w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
        rows: ledger.slice(start, start + IMPORT_CHUNK), actorRef: SCENARIO_OWNER });
    }
    expect(w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(LEDGER_ROWS);
  } finally {
    w.close();
  }
}, 900_000);

afterAll(async () => {
  await removeScratchDir(dir);
});

/** The original thresholds (ms): P1, P2 and P3, and P8's ceiling on every phase. */
const BUDGETS = { accept: 2500, prepare: 1500, commit: 2500 } as const;
const P8 = 3000;

describe('a candidate-heavy first sync on a 50,000-row ledger (P1, P2, P3 and P8; review r1 finding 8, r2 finding 4)', () => {
  it(`accepts, prepares and commits ${UPLOAD_ROWS} rows that each have ${NEAR_ROWS} near rows within the budgets`, (ctx) => {
    const attempts: Array<{ bytes: number; accept: number; prepare: number; commit: number; load: number; disk: QuietDisk }> = [];
    const best = { accept: Infinity, prepare: Infinity, commit: Infinity };
    const meets = () => (Object.keys(BUDGETS) as Array<keyof typeof BUDGETS>)
      .every((phase) => best[phase] <= BUDGETS[phase] && best[phase] <= P8);
    for (let attempt = 1; attempt <= 5 && !meets(); attempt += 1) {
      const file = `${dir}/attempt-${attempt}.db`;
      copyFileSync(template, file);
      flushFile(file);
      const w = new CardSyncScenario(file);
      try {
        const rows = Array.from({ length: UPLOAD_ROWS }, (_, i): ScenarioRow => ({
          scope: known[i % 2], date: day('2026-10-04', i % 14), amount: 1250, merchant: merchant(i),
          description: `NEAR SHOP ${i % 50} UPLOAD ${i}${PAD}`.slice(0, 500), category: `SHOPPING ${i % 7}${PAD}`.slice(0, 100),
          id: `upload-${i}`,
        }));
        const runId = w.run(device, binding);
        const wire = CardSyncScenario.wire(w.payload(binding, rows));
        const bytes = Buffer.byteLength(wire.canonicalJson);
        expect(bytes).toBeGreaterThan(0.95 * CARD_SYNC_V2_MAX_BYTES);
        expect(bytes).toBeLessThanOrEqual(CARD_SYNC_V2_MAX_BYTES);
        const clientRunId = w.repo.getCardSyncRun(runId)!.clientRunId;
        const disk = waitForQuietDisk(dir);
        const [receipt, accept] = timed(() => w.repo.acceptCardSyncObservations({ deviceId: device.deviceId, runId, clientRunId, ...wire,
          expectedGeneration: w.generation() }));
        expect(receipt).toMatchObject({ rowCount: UPLOAD_ROWS, reviewCount: UPLOAD_ROWS });
        const setId = receipt.observationSetId;
        expect(w.db.prepare(`SELECT count(*) FROM card_reconciliation_candidates c JOIN card_reconciliation_suggestions s
          ON s.id = c.review_item_id WHERE s.observation_set_id = ?`).pluck().get(setId)).toBe(UPLOAD_ROWS * 5);

        const items = w.db.prepare('SELECT id FROM card_reconciliation_suggestions WHERE observation_set_id = ? ORDER BY id').pluck()
          .all(setId) as string[];
        let version = 1;
        for (let start = 0; start < items.length; start += DECISION_CHUNK) {
          version = w.repo.recordCardReviewDecisions({ setId, expectedVersion: version, actorRef: SCENARIO_OWNER,
            decisions: items.slice(start, start + DECISION_CHUNK).map((itemId) => ({ itemId, action: 'insert-new' as const,
              transactionId: null, cardScopeId: null })) }).version;
        }
        const [plan, prepare] = timed(() => w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: version,
          expectedGeneration: w.generation() }) as CardSyncPlanView);
        expect(plan).toMatchObject({ status: 'executable', counts: expect.objectContaining({ insert: UPLOAD_ROWS }) });
        const [, commit] = timed(() => w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId,
          payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, expectedGeneration: w.generation() }));
        expect(w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(LEDGER_ROWS + UPLOAD_ROWS);

        attempts.push({ bytes, accept, prepare, commit, load: os.loadavg()[0], disk });
        best.accept = Math.min(best.accept, accept);
        best.prepare = Math.min(best.prepare, prepare);
        best.commit = Math.min(best.commit, commit);
      } finally {
        w.close();
      }
    }
    const cores = os.cpus().length;
    const report = `budgets: accept ${BUDGETS.accept} (P1), prepare ${BUDGETS.prepare} (P2), commit ${BUDGETS.commit} (P3), each ${P8} (P8) ms; `
      + attempts.map((a, index) => `attempt ${index + 1}: ${a.bytes} bytes accepted in ${a.accept.toFixed(0)} ms, `
        + `prepared in ${a.prepare.toFixed(0)} ms, `
        + `committed in ${a.commit.toFixed(0)} ms (1-minute load ${a.load.toFixed(1)} on ${cores} cores; started after `
        + `${a.disk.waitedMs.toFixed(0)} ms for a ${a.disk.quiet ? 'quiet' : 'still busy'} disk)`).join('; ')
      + `; best: accept ${best.accept.toFixed(0)}, prepare ${best.prepare.toFixed(0)}, commit ${best.commit.toFixed(0)} ms`;
    if (!meets() && attempts.every((a) => a.load >= cores)) {
      console.log(`card sync candidate-heavy: INCONCLUSIVE, every attempt ran on a machine loaded at or above its ${cores} cores; ${report}`);
      ctx.skip();
    }
    console.log(`card sync candidate-heavy: ${meets() ? 'met' : 'NOT MET'}; ${report}`);
    expect(meets(), report).toBe(true);
  }, 900_000);
});
