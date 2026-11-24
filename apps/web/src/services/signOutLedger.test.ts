import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STORAGE_PROBE_KEY,
  readLedger,
  readRecord,
  signOutBeganBetween,
  writeDoneRecord,
  writePendingRecord,
} from './browserCache';

// Every interleaving of two tabs' ledger operations, one storage call at a time.
//
// Each flow below follows the storage calls stores/auth.ts makes, in the same order, through the
// same functions (writePendingRecord, readRecord, readLedger, writeDoneRecord,
// signOutBeganBetween). A flow yields before every call, and the explorer runs the flows once for
// every possible order of those calls, then checks the invariants. Left out, because they write
// no ledger record: evicting the cache, the read that resyncs a tab's own baseline, and pruning
// day-old done records. readLedger is one step: the store reads the whole ledger in one synchronous
// pass, which browsers serve from one view of storage (another tab's write lands between tasks).

interface World {
  readonly map: Map<string, string>;
  readonly store: Storage;
  /** Storage calls made so far, by every tab: the time of each call. */
  clock: number;
}

function newWorld(initial: Record<string, string> = {}): World {
  const map = new Map(Object.entries(initial));
  const store = {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  } as unknown as Storage;
  return { map, store, clock: 0 };
}

type Flow = Generator<void, void, void>;

/** One storage call. Another tab's call may run before it; returns the result and the call's time. */
function* call<T>(world: World, use: (store: Storage) => T): Generator<void, [T, number], void> {
  yield;
  world.clock += 1;
  return [use(world.store), world.clock];
}

interface SignOutRun {
  id: string;
  recordedAt: number;
  /** When the revocation request was about to start, and the pending records it then covered. */
  coveredAt: number;
  covered: string[];
  /** When this flow marked its own record done (0: it did not). */
  doneAt: number;
}

/** startSignOut + finishSignOut: record, read back, note what the revocation covers, revoke, settle those, read again. */
function* signOut(world: World, run: SignOutRun, revoked: boolean): Flow {
  const [written, recordedAt] = yield* call(world, (store) => writePendingRecord(store, run.id, 1));
  run.recordedAt = recordedAt;
  yield* call(world, (store) => readRecord(store, run.id) === written);
  const [covered, coveredAt] = yield* call(world, readLedger);
  run.coveredAt = coveredAt;
  run.covered = covered.known ? covered.pending : [];
  // POST /auth/logout and GET /auth/me. A failed revocation stops here and retries later.
  if (!revoked) return;
  for (const id of run.covered) {
    const [, doneAt] = yield* call(world, (store) => writeDoneRecord(store, id, 2));
    if (id === run.id) run.doneAt = doneAt;
    yield* call(world, (store) => readRecord(store, id));
  }
  yield* call(world, readLedger);
}

interface SignInRun { beforeAt: number; afterAt: number; lost: boolean; settled: string[] }

/** signIn: read the ledger, POST /auth/login (it succeeds), read it again; settle what was pending, or lose. */
function* signIn(world: World, run: SignInRun): Flow {
  const [before, beforeAt] = yield* call(world, readLedger);
  // POST /auth/login.
  const [after, afterAt] = yield* call(world, readLedger);
  run.beforeAt = beforeAt;
  run.afterAt = afterAt;
  run.lost = signOutBeganBetween(before, after);
  if (run.lost) return; // it ends its new session with a sign-out of its own, a signOut flow of its own
  run.settled = before.known ? before.pending : [];
  for (const id of run.settled) {
    yield* call(world, (store) => writeDoneRecord(store, id, 3));
    yield* call(world, (store) => readRecord(store, id));
  }
}

interface CheckRun { beforeAt: number; afterAt: number; accepted: boolean }

/** check: read the ledger and probe storage, GET /auth/me (it answers 200), read again: accept or drop the answer. */
function* check(world: World, run: CheckRun): Flow {
  const [before, beforeAt] = yield* call(world, readLedger);
  yield* call(world, (store) => store.setItem(STORAGE_PROBE_KEY, 'probe'));
  yield* call(world, (store) => store.getItem(STORAGE_PROBE_KEY));
  yield* call(world, (store) => store.removeItem(STORAGE_PROBE_KEY));
  run.beforeAt = beforeAt;
  if (!before.known || before.pending.length > 0) return; // it revokes instead of asking /auth/me
  // GET /auth/me.
  const [after, afterAt] = yield* call(world, readLedger);
  run.afterAt = afterAt;
  run.accepted = !signOutBeganBetween(before, after) && after.known && after.pending.length === 0;
}

/**
 * Runs a scenario once for every order in which its flows' storage calls can interleave and hands
 * each outcome to `verify`, with the order as a string of flow indexes. Returns how many orders ran.
 */
function everyInterleaving(scenario: () => { flows: Flow[]; verify: (order: string) => void }): number {
  let orders = 0;
  const visit = (schedule: number[]) => {
    const { flows, verify } = scenario();
    // Each flow runs up to its first call; every next() after that makes exactly one call.
    const finished = flows.map((flow) => flow.next().done === true);
    for (const index of schedule) finished[index] = flows[index].next().done === true;
    const runnable = flows.map((_, index) => index).filter((index) => !finished[index]);
    if (runnable.length === 0) {
      orders += 1;
      verify(schedule.join(''));
      return;
    }
    for (const index of runnable) visit([...schedule, index]);
  };
  visit([]);
  return orders;
}

const record = (world: World, id: string) => world.map.get(`finance-tracker:sign-out:${id}`) ?? null;
const pendingRun = (id: string): SignOutRun => ({ id, recordedAt: 0, coveredAt: 0, covered: [], doneAt: 0 });

test('a confirmed sign-out settles only the sign-outs on record before its request, in every order', (t) => {
  for (const bRevoked of [false, true]) {
    const orders = everyInterleaving(() => {
      const world = newWorld();
      const a = pendingRun('aaaa');
      const b = pendingRun('bbbb');
      return {
        flows: [signOut(world, a, true), signOut(world, b, bRevoked)],
        verify: (order) => {
          assert.match(record(world, 'aaaa') ?? '', /^done:/, `A confirmed its own sign-out (order ${order})`);
          const bRecord = record(world, 'bbbb');
          assert.ok(bRecord, `B's record is never lost (order ${order})`);
          const coveredByA = a.coveredAt > b.recordedAt;
          if (bRevoked) assert.match(bRecord, /^done:/, `order ${order}`);
          else assert.equal(bRecord.startsWith('done:'), coveredByA, `B's unconfirmed sign-out is done only if A's request began after it (order ${order})`);
        },
      };
    });
    t.diagnostic(`B's revocation ${bRevoked ? 'confirmed' : 'failed'}: ${orders} orders`);
  }
});

test('a sign-in loses to any sign-out that began after it, and settles only what was pending before it, in every order', (t) => {
  for (const bRevoked of [false, true]) {
    let accepted = 0;
    const orders = everyInterleaving(() => {
      const world = newWorld();
      const a: SignInRun = { beforeAt: 0, afterAt: 0, lost: false, settled: [] };
      const b = pendingRun('bbbb');
      return {
        flows: [signIn(world, a), signOut(world, b, bRevoked)],
        verify: (order) => {
          const began = a.beforeAt < b.recordedAt && b.recordedAt < a.afterAt;
          assert.equal(a.lost, began, `the sign-in loses exactly when a sign-out began meanwhile (order ${order})`);
          if (!a.lost) accepted += 1;
          assert.ok(record(world, 'bbbb'), `B's record is never lost (order ${order})`);
          if (!bRevoked) {
            const settledByA = !a.lost && b.recordedAt < a.beforeAt;
            assert.equal(record(world, 'bbbb')!.startsWith('done:'), settledByA,
              `B's sign-out is settled only by a sign-in that began after it (order ${order})`);
          }
        },
      };
    });
    assert.ok(accepted > 0 && accepted < orders);
    t.diagnostic(`B's revocation ${bRevoked ? 'confirmed' : 'failed'}: ${orders} orders, the sign-in won ${accepted}`);
  }
});

test('a session check accepts an answer only if no sign-out was pending or began meanwhile, in every order', (t) => {
  for (const bRevoked of [false, true]) {
    let accepted = 0;
    const orders = everyInterleaving(() => {
      const world = newWorld();
      const a: CheckRun = { beforeAt: 0, afterAt: 0, accepted: false };
      const b = pendingRun('bbbb');
      return {
        flows: [check(world, a), signOut(world, b, bRevoked)],
        verify: (order) => {
          if (!a.accepted) return;
          accepted += 1;
          assert.ok(!(a.beforeAt < b.recordedAt && b.recordedAt < a.afterAt), `no sign-out began meanwhile (order ${order})`);
          // One that began earlier must have been confirmed before the check read the ledger.
          if (b.recordedAt < a.beforeAt) assert.ok(b.doneAt > 0 && b.doneAt < a.beforeAt, `order ${order}`);
        },
      };
    });
    assert.ok(accepted > 0 && accepted < orders);
    t.diagnostic(`B's revocation ${bRevoked ? 'confirmed' : 'failed'}: ${orders} orders, ${accepted} answers accepted`);
  }
});

test('a pending record left by a closed tab is settled by the next confirmation, never by a sign-in that lost', (t) => {
  const orders = everyInterleaving(() => {
    const world = newWorld({ 'finance-tracker:sign-out:0rph': 'pending:0' });
    const a = pendingRun('aaaa');
    const b: SignInRun = { beforeAt: 0, afterAt: 0, lost: false, settled: [] };
    return {
      flows: [signOut(world, a, true), signIn(world, b)],
      verify: (order) => {
        assert.match(record(world, '0rph') ?? '', /^done:/, `order ${order}`);
        assert.match(record(world, 'aaaa') ?? '', /^done:/, `order ${order}`);
        if (b.beforeAt < a.recordedAt && a.recordedAt < b.afterAt) assert.ok(b.lost, `order ${order}`);
        if (b.lost) assert.deepEqual(b.settled, [], `order ${order}`);
      },
    };
  });
  t.diagnostic(`${orders} orders`);
});

// ---- The explorer finds the bugs these rules prevent -------------------------------------------

/** Counts the orders in which `invariant` fails. */
function violations(scenario: () => { flows: Flow[]; holds: () => boolean }): number {
  let failed = 0;
  everyInterleaving(() => {
    const { flows, holds } = scenario();
    return { flows, verify: () => { if (!holds()) failed += 1; } };
  });
  return failed;
}

test('the explorer catches the previous single-key ledger deleting a newer pending sign-out', () => {
  const LATEST = 'finance-tracker:sign-out-latest:v1';
  const PENDING = 'finance-tracker:sign-out-pending:v1';
  /** The previous ledger: begin() set both keys; settle() was getItem, then removeItem if unchanged. */
  function* previousSignOut(world: World, run: SignOutRun, revoked: boolean): Flow {
    yield* call(world, (store) => store.setItem(LATEST, run.id));
    [, run.recordedAt] = yield* call(world, (store) => store.setItem(PENDING, run.id));
    const [settling, coveredAt] = yield* call(world, (store) => store.getItem(PENDING));
    run.coveredAt = coveredAt;
    // POST /auth/logout and GET /auth/me.
    if (!revoked) return;
    const [current] = yield* call(world, (store) => store.getItem(PENDING));
    if (current === settling) yield* call(world, (store) => store.removeItem(PENDING));
  }
  const failed = violations(() => {
    const world = newWorld();
    const a = pendingRun('aaaa');
    const b = pendingRun('bbbb');
    return {
      flows: [previousSignOut(world, a, true), previousSignOut(world, b, false)],
      // B's revocation failed, so its mark must survive unless A's revocation began after it.
      holds: () => world.map.get(PENDING) === 'bbbb' || a.coveredAt > b.recordedAt,
    };
  });
  assert.ok(failed > 0, 'B begins between A\'s compare and A\'s delete');
});

test('the explorer catches a confirmation that settles whatever is pending when it answers', () => {
  /** Wrong: settles the records pending after the revocation, not the ones it covered when it began. */
  function* settleLate(world: World, run: SignOutRun): Flow {
    // The revocation request begins right after this write.
    [, run.coveredAt] = yield* call(world, (store) => writePendingRecord(store, run.id, 1));
    // POST /auth/logout and GET /auth/me.
    const [pendingNow] = yield* call(world, readLedger);
    for (const id of pendingNow.known ? pendingNow.pending : []) yield* call(world, (store) => writeDoneRecord(store, id, 2));
  }
  const failed = violations(() => {
    const world = newWorld();
    const a = pendingRun('aaaa');
    const b = pendingRun('bbbb');
    return {
      flows: [settleLate(world, a), signOut(world, b, false)],
      // B's revocation failed, so its record must stay pending unless A's request began after it.
      holds: () => record(world, 'bbbb')!.startsWith('pending:') || a.coveredAt > b.recordedAt,
    };
  });
  assert.ok(failed > 0, 'B records after A\'s request began, and A settles it anyway');
});
