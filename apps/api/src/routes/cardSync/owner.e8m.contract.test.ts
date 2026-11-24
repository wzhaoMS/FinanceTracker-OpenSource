import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { cardSyncActorRef } from '../../services/cardSyncDigests.js';
import type { CardSourceBindingView } from '../../services/sqliteStateRepo.js';
import { writeV14CardLedger } from '../../testing/cardSyncLedgerSeed.js';
import { CardSyncOwnerWorld, OWNER_ORIGIN, OWNER_PASSWORD } from '../../testing/cardSyncOwnerWorld.js';
import type { ScenarioDevice, ScenarioRow } from '../../testing/cardSyncScenario.js';

/**
 * E8-M's side of E2a and E2b (handoff items 1, 2, 4, 6 and 7): the web client itself
 * (apps/web/.../sync/ownerClient.ts, with its exact-key strict schemas) drives the real API through the answers its first
 * version did not know, so what the Spending tab reads is the server's own answer. Item 3 (a v1 file set's rows) is pinned
 * in owner.contract.test.ts, item 5 (`/state`) in authorization.contract.test.ts. The client is loaded at run time, as there,
 * so the API's typecheck never compiles the web workspace.
 */

const WEB_SYNC = fileURLToPath(new URL('../../../../web/src/components/spending/sync/', import.meta.url));
const DAY_SECONDS = 86_400;

type OwnerClient = Record<string, (...args: never[]) => Promise<Record<string, unknown>>>;
interface ClientModule {
  createOwnerClient(transport: { request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> }, mode?: string): OwnerClient;
  isOwnerApiError(error: unknown, code?: string): boolean;
  isUnknownOutcome(error: unknown): boolean;
}

const worlds: CardSyncOwnerWorld[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) world.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A signed-in owner's world with the web client over its real routes. */
async function open(options: Parameters<typeof CardSyncOwnerWorld.create>[0] = {}) {
  const web = await import(/* @vite-ignore */ path.join(WEB_SYNC, 'ownerClient.ts')) as ClientModule;
  const w = await CardSyncOwnerWorld.create(options);
  worlds.push(w);
  const client = web.createOwnerClient({
    async request(method, target, body) {
      const http = await w.http();
      const res = method === 'GET'
        ? await http.get(target).set('Cookie', w.cookie)
        : await http.post(target).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1').send(body as object);
      if (!String(res.headers['content-type'] ?? '').startsWith('application/json')) return { kind: 'other', status: res.status };
      return { kind: 'json', status: res.status, body: JSON.parse(res.text) };
    },
  }, 'live');
  const call = <T = Record<string, unknown>>(name: string, ...args: unknown[]) => (client[name] as (...a: unknown[]) => Promise<T>)(...args);
  const refusal = async (name: string, ...args: unknown[]): Promise<{ status: number; code: string | null }> => {
    try {
      await call(name, ...args);
    } catch (error) {
      return error as { status: number; code: string | null };
    }
    throw new Error(`${name} was not refused`);
  };
  return { web, w, call, refusal };
}

/** Chase on, one binding with two known cards, and an approved browser for it. */
function syncing(w: CardSyncOwnerWorld): { binding: CardSourceBindingView; device: ScenarioDevice; known: string[] } {
  w.enable('chase');
  const binding = w.binding();
  return { binding, device: w.device([binding.bindingId]), known: w.scopes(binding).known };
}

const row = (scope: string, id: string, amount: number, description: string): ScenarioRow => ({
  scope, date: '2026-10-01', amount, description, id,
});

describe('E2a\'s answers the E8-M client reads as the server sends them (handoff 10/18 02:30)', () => {
  it('item 1: a charge Holdr doesn\'t have is 404 transaction-not-found, which the client names', async () => {
    const { web, refusal } = await open();
    const missing = await refusal('getTransactionSources', `card-txn-${'f'.repeat(32)}`);
    expect(web.isOwnerApiError(missing, 'transaction-not-found')).toBe(true);
    expect(missing.status).toBe(404);
  });

  it('item 1: an unmerge the merge can no longer undo exactly is 409 link-not-reversible; a row that isn\'t merged stays '
    + 'merge-not-allowed; both are refusals, nothing changed', async () => {
    const { web, w, call, refusal } = await open();
    const { binding, device, known } = syncing(w);
    w.ingest(device, binding, [row(known[0], 'sor-keep', 1250, 'FOURTH COFFEE'), row(known[0], 'sor-dup', 1251, 'FOURTH COFFEE DUP'),
      row(known[0], 'sor-market', 4999, 'CONTOSO MARKET')]);
    const id = (description: string) => w.db.prepare('SELECT id FROM card_transactions WHERE description = ?').pluck().get(description) as string;
    const [keep, dup, market] = [id('FOURTH COFFEE'), id('FOURTH COFFEE DUP'), id('CONTOSO MARKET')];
    type Sources = { transaction: { revision: number }; identities: Array<{ identityId: string }> };
    const own = (await call<Sources>('getTransactionSources', keep)).identities.map((identity) => identity.identityId);
    w.repo.mergeCardTransactions({ survivorId: keep, loserId: dup, reason: 'superseded', expectedRevisions: [1, 1],
      categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: w.owner });
    expect(await call('confirmPassword', OWNER_PASSWORD)).toEqual({ verifiedUntil: expect.any(String) });

    const notMerged = await refusal('unmergeTransaction', keep, { expectedRevision: 1, expectedSurvivorRevision: 1 });
    expect([web.isOwnerApiError(notMerged, 'merge-not-allowed'), notMerged.status, web.isUnknownOutcome(notMerged)]).toEqual([true, 409, false]);

    // The alias the merge moved onto the survivor moves on again: the merge can't be undone as it was.
    const survivor = await call<Sources>('getTransactionSources', keep);
    const moved = survivor.identities.find((identity) => !own.includes(identity.identityId))!;
    const marketBefore = await call<Sources>('getTransactionSources', market);
    w.tick(1);
    await call('repointIdentity', moved.identityId, { fromTransactionId: keep, expectedRevision: survivor.transaction.revision,
      toTransactionId: market, expectedToRevision: marketBefore.transaction.revision });
    const merged = await call<Sources>('getTransactionSources', dup);
    const after = await call<Sources>('getTransactionSources', keep);
    const notExact = await refusal('unmergeTransaction', dup, { expectedRevision: merged.transaction.revision,
      expectedSurvivorRevision: after.transaction.revision });
    expect([web.isOwnerApiError(notExact, 'link-not-reversible'), notExact.status, web.isUnknownOutcome(notExact)]).toEqual([true, 409, false]);
  });

  it('item 1: a change to the charge a row was merged into doesn\'t stop separating them; a change to the merged row does', async () => {
    const { web, w, call, refusal } = await open();
    const { binding, device, known } = syncing(w);
    w.ingest(device, binding, [row(known[0], 'sor-keep', 1250, 'FOURTH COFFEE'), row(known[0], 'sor-dup', 1251, 'FOURTH COFFEE DUP'),
      row(known[0], 'sor-keep-2', 3300, 'NORTHWIND'), row(known[0], 'sor-dup-2', 3301, 'NORTHWIND DUP')]);
    const id = (description: string) => w.db.prepare('SELECT id FROM card_transactions WHERE description = ?').pluck().get(description) as string;
    const [keep, dup, keep2, dup2] = [id('FOURTH COFFEE'), id('FOURTH COFFEE DUP'), id('NORTHWIND'), id('NORTHWIND DUP')];
    for (const [survivorId, loserId] of [[keep, dup], [keep2, dup2]]) {
      w.repo.mergeCardTransactions({ survivorId, loserId, reason: 'superseded', expectedRevisions: [1, 1],
        categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: w.owner });
    }
    expect(await call('confirmPassword', OWNER_PASSWORD)).toEqual({ verifiedUntil: expect.any(String) });
    type Sources = { transaction: { revision: number; values: { status: string }; removedReason: string | null; mergedIntoId: string | null } };
    const revisions = async (loserId: string, survivorId: string) => ({
      expectedRevision: (await call<Sources>('getTransactionSources', loserId)).transaction.revision,
      expectedSurvivorRevision: (await call<Sources>('getTransactionSources', survivorId)).transaction.revision,
    });

    // The survivor's notes change after the merge (a user-edited event on it): separating still works at its new revision.
    w.tick(1);
    w.repo.updateCardTransaction(keep, { notes: 'checked after the merge' }, { actorRef: w.owner });
    const separated = await call<Sources>('unmergeTransaction', dup, await revisions(dup, keep));
    expect([separated.transaction.values.status, separated.transaction.removedReason, separated.transaction.mergedIntoId])
      .toEqual(['posted', null, null]);

    // The merged row's own notes change after its merge: the merge is no longer its latest change.
    w.tick(1);
    w.repo.updateCardTransaction(dup2, { notes: 'checked after the merge' }, { actorRef: w.owner });
    const notExact = await refusal('unmergeTransaction', dup2, await revisions(dup2, keep2));
    expect([web.isOwnerApiError(notExact, 'link-not-reversible'), notExact.status]).toEqual([true, 409]);
  });

  it('item 1: a plan while no authorization gate is wired is 503 authorization-blocked, which the client reads as a refusal', async () => {
    const { web, w, call, refusal } = await open({ gate: 'not-wired' });
    const { binding, device, known } = syncing(w);
    const setId = w.accept(device, binding, [row(known[0], 'sor-blocked', 2100, 'SYNTHETIC BLOCKED')]).receipt.observationSetId;
    const summary = await call<{ version: number }>('getSetSummary', setId);
    const blocked = await refusal('preparePlan', setId, { expectedVersion: summary.version, sourceReviewed: false });
    expect([web.isOwnerApiError(blocked, 'authorization-blocked'), blocked.status, web.isUnknownOutcome(blocked)]).toEqual([true, 503, false]);
  });

  it('item 2: a charge an earlier Holdr removed without recording why reads as removed for the reason `legacy`', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'holdr-e8m-legacy-'));
    dirs.push(dir);
    const file = path.join(dir, 'finance.db');
    const v14 = writeV14CardLedger(file);
    const { call } = await open({ file });
    for (const legacyId of v14.legacyRemovedIds) {
      const sources = await call<{ transaction: Record<string, unknown> }>('getTransactionSources', legacyId);
      expect(sources.transaction).toMatchObject({ transactionId: legacyId, removedReason: 'legacy', mergedIntoId: null,
        values: expect.objectContaining({ status: 'removed' }) });
    }
  });

  it('item 4: a run whose review expired lists no row of its own, though its content is still kept', async () => {
    const { w, call } = await open();
    const { binding, device, known } = syncing(w);
    const { runId } = w.accept(device, binding, [row(known[0], 'sor-late-1', 3100, 'SYNTHETIC LATE ONE'),
      row(known[1], 'sor-late-2', 3200, 'SYNTHETIC LATE TWO')]);
    const before = await call<{ results: unknown[] }>('getRun', runId);
    expect(before.results).toHaveLength(2);
    w.tick(31 * DAY_SECONDS);
    w.cookie = await w.signIn();
    expect(await call('getRun', runId)).toMatchObject({ acceptance: 'expired-unreviewed', contentRetained: true, rowCount: 2, results: [] });
  });

  it('item 6: both views list the newest accepted set first, whenever a set was closed', async () => {
    const { w, call } = await open();
    const { binding, device, known } = syncing(w);
    const accepted: string[] = [];
    for (const n of [1, 2, 3]) {
      accepted.push(w.accept(device, binding, [row(known[0], `sor-order-${n}`, 500 + n, `SYNTHETIC ORDER ${n}`)]).receipt.observationSetId);
      w.tick(60);
    }
    const [first, second, third] = accepted;
    type Page = { observationSets: Array<{ observationSetId: string; version: number }>; nextCursor: string | null };
    const ids = (page: Page) => page.observationSets.map((set) => set.observationSetId);
    expect(ids(await call<Page>('listObservationSets', 'open'))).toEqual([third, second, first]);
    // The second is discarded first and the first last: by closing time the first would lead; by acceptance the second does.
    for (const setId of [second, first]) {
      const summary = await call<{ version: number }>('getSetSummary', setId);
      await call('discardObservationSet', setId, { expectedVersion: summary.version, reason: 'not-mine' });
      w.tick(60);
    }
    expect(ids(await call<Page>('listObservationSets', 'closed'))).toEqual([second, first]);
    expect(ids(await call<Page>('listObservationSets', 'open'))).toEqual([third]);
  });

  it('item 7: a set\'s summary shows the plan the signed-in owner prepared, never another owner\'s', async () => {
    const { w, call } = await open();
    const { binding, device, known } = syncing(w);
    const setId = w.accept(device, binding, [row(known[0], 'sor-plan', 2600, 'SYNTHETIC PLAN')]).receipt.observationSetId;
    const theirs = w.repo.prepareCardSyncPlan({ principal: { kind: 'session', actorRef: cardSyncActorRef('local-user-other-owner') },
      setId, expectedVersion: 1, expectedGeneration: w.generation() });
    expect(theirs.status).toBe('executable');
    const summary = await call<{ version: number; plan: unknown }>('getSetSummary', setId);
    expect(summary.plan).toBeNull();
    const mine = await call<{ previewId: string }>('preparePlan', setId, { expectedVersion: summary.version, sourceReviewed: false });
    expect((await call<{ plan: unknown }>('getSetSummary', setId)).plan).toMatchObject({ previewId: mine.previewId, state: 'valid' });
  });
});
