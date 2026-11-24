import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OwnerApiError, type CardSyncOwnerClient } from './ownerClient';
import type { SetSummary } from './ownerApi';
import { CommitWatcher } from './useCommitSettlement';

const MINUTE = 60_000;

/** One read of a set the test answers when it likes (or never). */
interface PendingRead {
  observationSetId: string;
  answer: (plan: { previewId: string; state: 'valid' | 'committed' | 'expired' | 'superseded' } | null) => void;
  fail: (error: unknown) => void;
}

function harness() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const reads: PendingRead[] = [];
  let ledger = 0;
  let count = 0;
  const client = {
    getSetSummary: (observationSetId: string) => new Promise<SetSummary>((resolve, reject) => {
      reads.push({
        observationSetId,
        answer: (plan) => resolve({ observationSetId, plan } as unknown as SetSummary),
        fail: reject,
      });
    }),
    // The watcher needs only a set's own fields: assembling every page of a large set would outlast its 30 seconds.
    getObservationSet: () => { throw new Error('the watcher must not read whole sets'); },
  } as unknown as CardSyncOwnerClient;
  const watcher = new CommitWatcher(() => client, () => { ledger += 1; }, (value) => { count = value; }, {
    now: () => now,
    after: (ms, run) => { timers.push({ at: now + ms, run }); },
  });
  return {
    watcher,
    reads,
    readsOf: (observationSetId: string) => reads.filter((read) => read.observationSetId === observationSetId),
    ledger: () => ledger,
    count: () => count,
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

/** Lets the promise callbacks of answered reads run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('watching commits whose answer was lost', () => {
  test('a slow answer is used, and checks asked for meanwhile run after it, one at a time', async () => {
    const h = harness();
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    assert.equal(h.reads.length, 1);
    h.watcher.checkAll();
    h.watcher.checkAll();
    h.watcher.checkAll();
    assert.equal(h.reads.length, 1, 'no second read while one is on its way');
    h.reads[0].answer({ previewId: 'plan-a', state: 'valid' });
    await settle();
    assert.equal(h.reads.length, 2, 'the checks asked for meanwhile become one more read');
    h.reads[1].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    assert.deepEqual([h.ledger(), h.count(), h.watcher.size], [1, 0, 0]);
  });

  test('a read that never answers holds up no other commit, and past the limit its watch ends', async () => {
    const h = harness();
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    h.watcher.watch({ observationSetId: 'set-c', previewId: 'plan-c' });
    assert.equal(h.readsOf('set-c').length, 1, 'read at once, while the other commit\'s read is still on its way');
    h.readsOf('set-c')[0].answer({ previewId: 'plan-c', state: 'committed' });
    await settle();
    assert.deepEqual([h.ledger(), h.watcher.size], [1, 1]);
    h.advance(15 * MINUTE + 1);
    h.watcher.expireOverdue();
    assert.deepEqual([h.ledger(), h.watcher.size], [2, 0], 'expired without waiting for its read, and Spending is read again');
    h.watcher.watch({ observationSetId: 'set-b', previewId: 'plan-b' });
    assert.equal(h.readsOf('set-b').length, 1, 'the new commit is read at once');
    h.readsOf('set-b')[0].answer({ previewId: 'plan-b', state: 'committed' });
    await settle();
    assert.deepEqual([h.ledger(), h.watcher.size], [3, 0]);
    // The expired commit's read finally answers: it changes nothing.
    h.readsOf('set-a')[0].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    assert.equal(h.ledger(), 3);
  });

  test('a read that hasn\'t answered in 30 seconds frees its turn, and its late answer is ignored', async () => {
    const h = harness();
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    h.watcher.checkAll();
    h.advance(30_000);
    assert.equal(h.readsOf('set-a').length, 2, 'the check asked for meanwhile runs once the first read times out');
    h.readsOf('set-a')[0].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    assert.deepEqual([h.ledger(), h.watcher.size], [0, 1], 'the timed-out read no longer counts');
    h.readsOf('set-a')[1].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    assert.deepEqual([h.ledger(), h.watcher.size], [1, 0]);
  });

  test('a commit that was forgotten (its answer arrived) is never settled again by an old read', async () => {
    const h = harness();
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    h.watcher.forget('plan-a');
    h.reads[0].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    assert.deepEqual([h.ledger(), h.watcher.size], [0, 0]);
    // Watching it again starts a fresh turn, unaffected by the old read.
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    assert.equal(h.reads.length, 2);
  });

  test('another plan, an expired plan or a missing set end the watch; other failures keep it', async () => {
    const h = harness();
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    h.watcher.watch({ observationSetId: 'set-b', previewId: 'plan-b' });
    h.watcher.watch({ observationSetId: 'set-c', previewId: 'plan-c' });
    h.watcher.watch({ observationSetId: 'set-d', previewId: 'plan-d' });
    h.readsOf('set-a')[0].answer({ previewId: 'plan-other', state: 'valid' });
    h.readsOf('set-b')[0].answer({ previewId: 'plan-b', state: 'expired' });
    h.readsOf('set-c')[0].fail(new OwnerApiError('http', 404, 'not-found'));
    h.readsOf('set-d')[0].fail(new OwnerApiError('network'));
    await settle();
    assert.deepEqual([h.ledger(), h.watcher.size], [3, 1]);
    h.watcher.checkAll();
    assert.equal(h.readsOf('set-d').length, 2, 'the commit whose read failed is read again');
  });

  test('once stopped (the Spending tab closed), nothing is read and Spending isn\'t asked to refresh', async () => {
    const h = harness();
    h.watcher.watch({ observationSetId: 'set-a', previewId: 'plan-a' });
    h.watcher.stop();
    h.reads[0].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    h.watcher.checkAll();
    assert.deepEqual([h.ledger(), h.reads.length], [0, 1]);
    // React's development double mount stops and starts it again: it carries on.
    h.watcher.start();
    h.watcher.checkAll();
    assert.equal(h.reads.length, 2);
    h.reads[1].answer({ previewId: 'plan-a', state: 'committed' });
    await settle();
    assert.equal(h.ledger(), 1);
  });
});
