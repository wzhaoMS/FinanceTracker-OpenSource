import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardExternalIdHash } from '@finance-tracker/shared';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardImportRow, CardSourceBindingView } from '../sqliteStateRepo.js';
import { CARD_SYNC_ADMISSIONS } from './admissions.js';
import { nearContentCandidates, nearContentCandidatesByScan, type ClassifyContext, type PlanObservation } from './classify.js';
import { LedgerOverlay, LedgerView, type LedgerRow } from './ledgerView.js';

// `near-content:v1` walks an amount's indexed rows tier by tier (slice 2 review r1, finding 8). It must name exactly the
// candidates, in exactly the order, that scanning the whole pool and ranking it would: a seeded random ledger of v1 rows
// (legacy scope) and synced rows with stable ids (known scopes, so established distinctness applies), with few amounts,
// merchants and descriptions (spelling variants that normalize alike), both statuses, every distance and excluded rows.

const AMOUNTS = [1250, 1999, 4200];
const MERCHANTS = ['Corner Cafe', 'CORNER CAFE', 'Book Nook', 'Gas & Go', null];
const DESCRIPTIONS = ['CORNER CAFE 12', 'corner cafe 12', 'BOOK NOOK', 'GAS AND GO 7', 'MISC PURCHASE'];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const day = (offset: number) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + offset * 86_400_000).toISOString().slice(0, 10);

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let known: string[];
let unknown: string;
let stable: Array<{ scopeId: string; namespace: string; idHash: string }>;
let rowIds: string[];

beforeAll(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  const device = w.device([binding.bindingId]);
  ({ known, unknown } = w.scopes(binding));
  const next = random(7);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
  const files: CardImportRow[] = Array.from({ length: 600 }, (_, i) => {
    const date = day(Math.floor(next() * 30));
    const pending = next() < 0.3;
    return {
      externalIdHash: cardExternalIdHash(`near-file-${i}`), transactionDate: date, postedDate: pending ? null : date,
      status: pending ? 'pending' : 'posted', currency: 'USD', amountMinor: pick(AMOUNTS), kind: 'purchase',
      description: pick(DESCRIPTIONS), merchant: pick(MERCHANTS),
    };
  });
  w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
    rows: files, actorRef: SCENARIO_OWNER });
  // Then synced rows, each a new row by the owner's decision: stable ids in the known scopes, first seen posted.
  const synced = Array.from({ length: 80 }, (_, i): ScenarioRow => ({
    scope: known[i % 2], date: day(Math.floor(next() * 30)), amount: pick(AMOUNTS), merchant: pick(MERCHANTS),
    description: pick(DESCRIPTIONS), id: `near-synced-${i}`,
  }));
  const setId = w.accept(device, binding, synced).receipt.observationSetId;
  const items = w.db.prepare('SELECT id FROM card_reconciliation_suggestions WHERE observation_set_id = ?').pluck().all(setId) as string[];
  const version = w.repo.recordCardReviewDecisions({ setId, expectedVersion: 1, actorRef: SCENARIO_OWNER,
    decisions: items.map((itemId) => ({ itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })) }).version;
  const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: version, expectedGeneration: w.generation() });
  if (plan.status !== 'executable') throw new Error('expected an executable plan');
  w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId, payloadDigest: plan.payloadDigest, planDigest: plan.planDigest,
    expectedGeneration: w.generation() });
  stable = w.db.prepare(`SELECT source_scope_id AS scopeId, namespace, id_hash AS idHash FROM card_source_identities
    WHERE namespace_kind = 'stable' ORDER BY id`).all() as typeof stable;
  rowIds = w.db.prepare('SELECT id FROM card_transactions ORDER BY id').pluck().all() as string[];
  expect(stable.length).toBe(80);
  expect(rowIds.length).toBe(680);
});

afterAll(() => {
  w.close();
});

function observations(seed: number, count: number): PlanObservation[] {
  const next = random(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
  return Array.from({ length: count }, (_, i): PlanObservation => {
    const scopeId = next() < 0.15 ? unknown : pick(known);
    const scopeKind = scopeId === unknown ? 'unknown' as const : 'known' as const;
    const reuse = next() < 0.2 ? pick(stable) : null;
    // Most share a synced row's (scope, namespace), so its other ids make rows established distinct.
    const namespace = reuse?.namespace ?? stable[0].namespace;
    const pending = next() < 0.35;
    const date = day(Math.floor(next() * 40) - 5);
    return {
      ordinal: i, id: `card-obsrow-near${i}`, itemId: null, origin: 'extension', scopeId, scopeKind,
      tuples: [{ scopeId: reuse?.scopeId ?? scopeId, scopeKind, namespace, namespaceKind: next() < 0.9 ? 'stable' : 'capture',
        idHash: reuse?.idHash ?? cardExternalIdHash(`near-observed-${seed}-${i}`) }],
      values: {
        transactionDate: date, postedDate: pending ? null : date, status: pending ? 'pending' : 'posted', amountMinor: pick(AMOUNTS),
        originalAmountMinor: null, originalCurrency: null, kind: 'purchase', description: pick(DESCRIPTIONS), merchant: pick(MERCHANTS),
        issuerCategory: null,
      },
      content: 'rcd1:near',
    };
  });
}

function context(overlay: LedgerOverlay, excluded: ReadonlySet<string>): ClassifyContext {
  return { overlay, admissions: CARD_SYNC_ADMISSIONS, excluded, knownScopes: new Set(known) };
}

describe('near-content candidates through the amount index (review r1, finding 8)', () => {
  it('names the candidates a full scan ranks, in its order, for 600 random observations', () => {
    const view = new LedgerView(w.db, binding.cardAccountRef, 'USD');
    const next = random(11);
    const excluded = new Set(rowIds.filter(() => next() < 0.05));
    const ctx = context(new LedgerOverlay(view), excluded);
    let full = 0;
    let fewer = 0;
    let distinct = 0;
    for (const observation of observations(3, 600)) {
      const indexed = nearContentCandidates(observation, ctx);
      expect(indexed).toEqual(nearContentCandidatesByScan(observation, ctx));
      if (indexed.length === 5) full += 1;
      else fewer += 1;
      // The same observation with a capture id, which no row is established distinct from.
      const capture = { ...observation, tuples: [{ ...observation.tuples[0], namespaceKind: 'capture' as const }] };
      if (observation.tuples[0].namespaceKind === 'stable'
        && JSON.stringify(nearContentCandidates(capture, ctx)) !== JSON.stringify(indexed)) {
        distinct += 1;
      }
    }
    // The random ledger reaches a full five and fewer, and established distinctness changes many answers.
    expect(full).toBeGreaterThan(300);
    expect(fewer).toBeGreaterThan(25);
    expect(distinct).toBeGreaterThan(30);
  });

  it('narrows by `eligible` before ranking, both ways: the best posted rows, not the posted rows among the best five (E2d r2, finding 1)',
    () => {
      const view = new LedgerView(w.db, binding.cardAccountRef, 'USD');
      const next = random(17);
      const excluded = new Set(rowIds.filter(() => next() < 0.05));
      const ctx = context(new LedgerOverlay(view), excluded);
      const postedOnly = (row: LedgerRow) => row.status === 'posted';
      let hidden = 0;
      for (const observation of observations(13, 600)) {
        const narrowed = nearContentCandidates(observation, ctx, postedOnly);
        expect(narrowed).toEqual(nearContentCandidatesByScan(observation, ctx, postedOnly));
        expect(narrowed.every((candidate) => candidate.status === 'posted')).toBe(true);
        // The posted rows the best five hold are the best posted rows, in order; the narrowed search may find more.
        const afterCut = nearContentCandidates(observation, ctx).filter((candidate) => candidate.status === 'posted');
        expect(narrowed.slice(0, afterCut.length)).toEqual(afterCut);
        if (narrowed.length > afterCut.length) hidden += 1;
      }
      // Pending rows ranked above them hid posted rows from a filter after the cut in many answers.
      console.info(`near-content: the narrowed search found posted rows a filter after the cut missed for ${hidden} of 600 observations`);
      expect(hidden).toBeGreaterThan(30);
    });

  it('reads a pool the plan changed through the overlay, row by row, so a changed row ranks by its new values', () => {
    const view = new LedgerView(w.db, binding.cardAccountRef, 'USD');
    const overlay = new LedgerOverlay(view);
    const ctx = context(overlay, new Set());
    const [observation] = observations(5, 1);
    const values = { ...observation.values, status: 'posted' as const, postedDate: day(10), transactionDate: day(10),
      amountMinor: 1999, merchant: 'Renamed Merchant', description: 'RENAMED MERCHANT 1' };
    const probe: PlanObservation = { ...observation, values, tuples: [{ ...observation.tuples[0], namespaceKind: 'capture' }] };
    const before = nearContentCandidates(probe, ctx);
    expect(before.every((candidate) => (candidate.matchedOn & 4) === 0)).toBe(true);
    const target = view.rowsNear(1999, day(9), day(11)).find((row) => row.status === 'posted' && row.transactionDate === day(11));
    expect(target).toBeDefined();
    const changed: LedgerRow = { ...target!, merchant: 'renamed merchant', revision: target!.revision + 1 };
    overlay.setRow(changed);
    expect(overlay.changedAmount(1999)).toBe(true);
    expect(overlay.changedAmount(1250)).toBe(false);
    const after = nearContentCandidates(probe, ctx);
    expect(after).toEqual(nearContentCandidatesByScan(probe, ctx));
    expect(after[0]).toMatchObject({ transactionId: target!.id, matchedOn: 2 | 4 });
    for (const other of observations(9, 200)) {
      expect(nearContentCandidates(other, ctx)).toEqual(nearContentCandidatesByScan(other, ctx));
      const postedOnly = (row: LedgerRow) => row.status === 'posted';
      expect(nearContentCandidates(other, ctx, postedOnly)).toEqual(nearContentCandidatesByScan(other, ctx, postedOnly));
    }
  });
});
