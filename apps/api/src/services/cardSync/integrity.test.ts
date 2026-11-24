import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardExternalIdHash } from '@finance-tracker/shared';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView, CardSyncPlanView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';
import { cardSyncPayloadSealed, readSet } from './sets.js';

// E1b design §5.4, slice 2 review r2, finding 1: commit checks the integrity of the payload it commits, as prepare does,
// so a set whose stored payload no longer rebuilds to its `pd1:` commits nothing. Commit uses the sealed form of the
// check (sets.ts, cardSyncPayloadSealed): the same components, assembled exactly as E1a's builder does, without the
// builder's re-validation. Here the full check (rehydrateCardSyncPayload) and the sealed one agree on every change to every
// payload component: the reviewer's two, made with SQL that passes every installed guard, and planted ones (the table's
// triggers dropped and put back, CHECK constraints ignored while planting). Each change makes the commit refuse
// `observation-integrity` with nothing written, while a replay of a consumed plan still answers its stored result.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known } = w.scopes(binding));
});

afterEach(() => {
  w.close();
});

const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };
const one = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params);
const rows = (): ScenarioRow[] => [
  { scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', id: 'sor-1' },
  { scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2', secondary: [['chase-api:derived:v1', 'derived-2']] },
  { scope: known[1], date: '2026-10-03', status: 'pending', amount: 800, description: 'NORTHWIND PARKING', id: 'sor-3' },
];

/** An accepted set (two coverage entries, one card hint) and the owner's executable plan for it. */
function prepared(): { setId: string; plan: CardSyncPlanView } {
  const { receipt } = w.accept(device, binding, rows(), { cards: ['3391'] });
  const setId = receipt.observationSetId;
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: 1, expectedGeneration: w.generation() });
  expect(plan).toMatchObject({ status: 'executable' });
  return { setId, plan: plan as CardSyncPlanView };
}
const commit = (plan: CardSyncPlanView) => w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId,
  payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, expectedGeneration: w.generation() });
const fullCheck = (setId: string) => w.repo.rehydrateCardSyncPayload(setId).ok;
const sealedCheck = (setId: string) => cardSyncPayloadSealed(w.db, readSet(w.db, setId)!);
const observationId = (setId: string, ordinal: number) => one('SELECT id FROM card_source_observations WHERE observation_set_id = ? AND ordinal = ?',
  setId, ordinal) as string;
/** What a refused commit must leave as it was. */
const state = (setId: string, plan: CardSyncPlanView) => ({
  set: w.db.prepare('SELECT state, version, inserted_count, open_count FROM card_sync_observation_sets WHERE id = ?').get(setId),
  plan: one('SELECT status FROM card_sync_commit_plans WHERE id = ?', plan.previewId),
  transactions: one('SELECT count(*) FROM card_transactions'),
  coverage: w.db.prepare('SELECT entry_ordinal, ledger_state FROM card_coverage_windows WHERE observation_set_id = ? ORDER BY entry_ordinal')
    .all(setId),
  ledgerRevision: one('SELECT ledger_revision FROM card_accounts WHERE id = ?', binding.cardAccountRef),
});

/** Plants a change no guard would let through: the tables' triggers dropped and put back, CHECKs ignored meanwhile. */
function planted(tables: string[], write: () => void): void {
  const triggers = w.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${tables.map(() => '?').join(', ')})`)
    .all(...tables) as Array<{ name: string; sql: string }>;
  w.db.pragma('ignore_check_constraints = ON');
  for (const trigger of triggers) w.db.exec(`DROP TRIGGER "${trigger.name}"`);
  try {
    write();
  } finally {
    for (const trigger of triggers) w.db.exec(trigger.sql);
    w.db.pragma('ignore_check_constraints = OFF');
  }
}

const COVER_ID = `card-cover-${'p'.repeat(32)}`;
const SECONDARY_ID = `card-secid-${'p'.repeat(32)}`;

/** Each change to a component of the stored payload, made after a valid prepare. */
const CHANGES: Array<[string, (setId: string) => void]> = [
  // The reviewer's two, through every installed guard.
  ['a coverage entry appended (guarded SQL)', (setId) => {
    w.db.prepare(`INSERT INTO card_coverage_windows (id, card_account_id, card_scope_id, source_kind, source, import_batch_id,
        observation_set_id, entry_ordinal, status, requested_start, requested_end, requested_basis, observed_start, observed_end,
        observed_basis, claimed_completeness, verified_completeness, termination, page_count, evidence, ledger_state, observed_at,
        recorded_at, updated_at)
      SELECT ?, card_account_id, ?, source_kind, source, import_batch_id, observation_set_id, 2, 'posted', requested_start,
        requested_end, requested_basis, observed_start, observed_end, observed_basis, claimed_completeness, verified_completeness,
        termination, page_count, evidence, ledger_state, observed_at, recorded_at, updated_at
      FROM card_coverage_windows WHERE observation_set_id = ? AND entry_ordinal = 0`).run(COVER_ID, known[1], setId);
  }],
  ['a sorted card hint appended (guarded SQL)', (setId) => {
    w.db.prepare("INSERT INTO card_sync_set_card_hints (observation_set_id, origin, ordinal, last4) VALUES (?, 'extension', 1, '9999')")
      .run(setId);
  }],
  // Planted: every other component.
  ['a coverage entry removed', (setId) => planted(['card_coverage_windows'], () => {
    w.db.prepare('DELETE FROM card_coverage_windows WHERE observation_set_id = ? AND entry_ordinal = 1').run(setId);
  })],
  ['coverage entries reordered', (setId) => planted(['card_coverage_windows'], () => {
    w.db.prepare(`UPDATE card_coverage_windows SET entry_ordinal = CASE entry_ordinal WHEN 0 THEN 39 ELSE entry_ordinal END
      WHERE observation_set_id = ?`).run(setId);
    w.db.prepare('UPDATE card_coverage_windows SET entry_ordinal = 0 WHERE observation_set_id = ? AND entry_ordinal = 1').run(setId);
    w.db.prepare('UPDATE card_coverage_windows SET entry_ordinal = 1 WHERE observation_set_id = ? AND entry_ordinal = 39').run(setId);
  })],
  ['a coverage entry\'s page count changed', (setId) => planted(['card_coverage_windows'], () => {
    w.db.prepare('UPDATE card_coverage_windows SET page_count = page_count + 1 WHERE observation_set_id = ? AND entry_ordinal = 0').run(setId);
  })],
  ['a coverage entry\'s observed range changed', (setId) => planted(['card_coverage_windows'], () => {
    w.db.prepare(`UPDATE card_coverage_windows SET observed_start = date(observed_start, '-1 day')
      WHERE observation_set_id = ? AND entry_ordinal = 0`).run(setId);
  })],
  ['a coverage entry\'s termination changed', (setId) => planted(['card_coverage_windows'], () => {
    w.db.prepare(`UPDATE card_coverage_windows SET termination = 'end-marker' WHERE observation_set_id = ? AND entry_ordinal = 0`).run(setId);
  })],
  ['a card hint removed', (setId) => planted(['card_sync_set_card_hints'], () => {
    w.db.prepare('DELETE FROM card_sync_set_card_hints WHERE observation_set_id = ?').run(setId);
  })],
  ['a card hint changed', (setId) => planted(['card_sync_set_card_hints'], () => {
    w.db.prepare("UPDATE card_sync_set_card_hints SET last4 = '3392' WHERE observation_set_id = ?").run(setId);
  })],
  ['an observation\'s description changed', (setId) => planted(['card_source_observations'], () => {
    w.db.prepare("UPDATE card_source_observations SET description = 'FOURTH COFFEE ROASTERS' WHERE id = ?").run(observationId(setId, 0));
  })],
  ['an observation\'s amount changed', (setId) => planted(['card_source_observations'], () => {
    w.db.prepare('UPDATE card_source_observations SET amount_minor = amount_minor + 1 WHERE id = ?').run(observationId(setId, 1));
  })],
  ['an observation\'s status changed', (setId) => planted(['card_source_observations'], () => {
    w.db.prepare("UPDATE card_source_observations SET status = 'posted', posted_date = transaction_date WHERE id = ?").run(observationId(setId, 2));
  })],
  ['an observation\'s card scope changed', (setId) => planted(['card_source_observations'], () => {
    w.db.prepare('UPDATE card_source_observations SET source_scope_id = ? WHERE id = ?').run(known[1], observationId(setId, 0));
  })],
  ['an observation\'s issuer id changed', (setId) => planted(['card_source_observations'], () => {
    const hash = cardExternalIdHash('sor-9');
    w.db.prepare('UPDATE card_source_observations SET external_id_hash = ?, identity_hash = ? WHERE id = ?').run(hash, hash, observationId(setId, 0));
  })],
  ['an observation\'s stored fingerprint changed', (setId) => planted(['card_source_observations'], () => {
    w.db.prepare(`UPDATE card_source_observations SET fingerprint = 'cfp1:' || substr(external_id_hash, 6) WHERE id = ?`).run(observationId(setId, 0));
  })],
  ['an observation removed', (setId) => planted(['card_source_observations', 'card_observation_secondary_ids'], () => {
    w.db.prepare('DELETE FROM card_source_observations WHERE id = ?').run(observationId(setId, 2));
  })],
  ['a secondary id appended', (setId) => planted(['card_observation_secondary_ids'], () => {
    w.db.prepare(`INSERT INTO card_observation_secondary_ids (id, observation_id, ordinal, namespace, namespace_kind, id_hash)
      VALUES (?, ?, 1, 'chase-api:derived:v1', 'stable', ?)`).run(SECONDARY_ID, observationId(setId, 0), cardExternalIdHash('derived-1'));
  })],
  ['a secondary id removed', (setId) => planted(['card_observation_secondary_ids'], () => {
    w.db.prepare('DELETE FROM card_observation_secondary_ids WHERE observation_id = ?').run(observationId(setId, 1));
  })],
  ['a secondary id changed', (setId) => planted(['card_observation_secondary_ids'], () => {
    w.db.prepare('UPDATE card_observation_secondary_ids SET id_hash = ? WHERE observation_id = ?').run(cardExternalIdHash('derived-9'),
      observationId(setId, 1));
  })],
  ['the header\'s parser version changed', (setId) => planted(['card_sync_observation_sets'], () => {
    w.db.prepare("UPDATE card_sync_observation_sets SET parser_version = parser_version || '-x' WHERE id = ?").run(setId);
  })],
  ['the header\'s capture time changed', (setId) => planted(['card_sync_observation_sets'], () => {
    w.db.prepare("UPDATE card_sync_observation_sets SET observed_at = '2026-10-15T00:00:00.000Z' WHERE id = ?").run(setId);
  })],
  ['the producer\'s rejected count changed', (setId) => planted(['card_sync_observation_sets'], () => {
    w.db.prepare('UPDATE card_sync_observation_sets SET producer_rejected_count = producer_rejected_count + 1 WHERE id = ?').run(setId);
  })],
  ['a statement added to the header', (setId) => planted(['card_sync_observation_sets'], () => {
    w.db.prepare(`UPDATE card_sync_observation_sets SET statement_present = 1, statement_charges_minor = 7049, statement_credits_minor = 0,
      statement_net_minor = 7049 WHERE id = ?`).run(setId);
  })],
];

describe('commit checks the payload it commits (§5.4; review r2, finding 1)', () => {
  it('commits an intact set: both checks pass, and exactly its two coverage entries are committed', () => {
    const { setId, plan } = prepared();
    expect([fullCheck(setId), sealedCheck(setId)]).toEqual([true, true]);
    expect(commit(plan)).toMatchObject({ status: 'committed', replayed: false });
    expect(state(setId, plan)).toMatchObject({ plan: 'consumed', transactions: 3,
      coverage: [{ entry_ordinal: 0, ledger_state: 'committed' }, { entry_ordinal: 1, ledger_state: 'committed' }] });
  });

  it.each(CHANGES)('refuses %s: both checks fail, the commit refuses observation-integrity and writes nothing', (_label, change) => {
    const { setId, plan } = prepared();
    change(setId);
    expect([fullCheck(setId), sealedCheck(setId)]).toEqual([false, false]);
    const before = state(setId, plan);
    let error: unknown;
    try {
      commit(plan);
    } catch (caught) {
      error = caught;
    }
    expect(cardSyncRefusalCode(error), String(error)).toBe('observation-integrity');
    expect(state(setId, plan)).toEqual(before);
    expect(before).toMatchObject({ plan: 'prepared', transactions: 0 });
  });

  it('answers a consumed plan\'s replay from the plan alone, after its payload changed or its content was purged', () => {
    const { setId, plan } = prepared();
    const first = commit(plan);
    CHANGES[1][1](setId);
    expect(commit(plan)).toEqual({ ...first, replayed: true });
    planted(['card_sync_observation_sets'], () => {
      w.db.prepare('UPDATE card_sync_observation_sets SET content_purged_at = ? WHERE id = ?').run(w.now(), setId);
    });
    expect([fullCheck(setId), sealedCheck(setId)]).toEqual([false, false]);
    expect(commit(plan)).toEqual({ ...first, replayed: true });
  });
});
