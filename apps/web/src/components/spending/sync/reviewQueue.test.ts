import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, FakeOwnerServer, HOUR, fakeOwnerTransport } from './fakeOwnerServer';
import type { SetSummary } from './ownerApi';
import { createOwnerClient } from './ownerClient';
import { FILE_ONLY_PAGE_READS, reviewQueuePage } from './reviewQueue';

const set = (id: string, sourceKind: SetSummary['sourceKind']) => ({ observationSetId: id, sourceKind }) as SetSummary;
const ids = (page: { items: SetSummary[] }) => page.items.map((item) => item.observationSetId);

/** Holdr's list as pages of `kinds` ('e' an extension capture, 'f' a file import), counting the reads. */
function lister(pages: string[]) {
  const reads: Array<string | null> = [];
  const read = async (cursor: string | null) => {
    reads.push(cursor);
    const index = cursor === null ? 0 : Number(cursor.slice(1));
    const observationSets = [...pages[index]].map((kind, position) => set(`${index}.${position}`, kind === 'f' ? 'file' : 'extension'));
    return { observationSets, nextCursor: index + 1 < pages.length ? `c${index + 1}` : null };
  };
  return { read, reads };
}

test('with Holdr\'s sync state, the queue lists every set as Holdr pages them', async () => {
  const { read, reads } = lister(['eef', 'e']);
  const page = await reviewQueuePage(read, null, false);
  assert.deepEqual([ids(page), page.nextCursor, reads], [['0.0', '0.1', '0.2'], 'c1', [null]]);
});

test('without it, only file imports are listed, and pages that hold none are read past (Astra round 5)', async () => {
  // Mixed: the extension's captures are left out of the page.
  const mixed = lister(['efe', 'f']);
  assert.deepEqual([ids(await reviewQueuePage(mixed.read, null, true)), mixed.reads], [['0.1'], [null]]);
  // An extension-only first page doesn't hide the file reviews behind it: the next page is read at once.
  const behind = lister(['eee', 'eef', 'ef']);
  const first = await reviewQueuePage(behind.read, null, true);
  assert.deepEqual([ids(first), first.nextCursor, behind.reads], [['1.2'], 'c2', [null, 'c1']]);
  const second = await reviewQueuePage(behind.read, first.nextCursor, true);
  assert.deepEqual([ids(second), second.nextCursor], [['2.1'], null]);
  // Only captures: an empty queue, and nothing more to read.
  const none = lister(['ee', 'e']);
  assert.deepEqual(await reviewQueuePage(none.read, null, true), { items: [], nextCursor: null });
  // Past the read bound, an empty page with Holdr's cursor: "Show more" goes on from there.
  const long = lister([...Array.from({ length: FILE_ONLY_PAGE_READS + 2 }, () => 'e'), 'f']);
  const bounded = await reviewQueuePage(long.read, null, true);
  assert.deepEqual([ids(bounded), bounded.nextCursor, long.reads.length], [[], `c${FILE_ONLY_PAGE_READS}`, FILE_ONLY_PAGE_READS]);
});

test('against the fake Holdr: a file review behind a page of the extension\'s closed captures is still found', async () => {
  const server = new FakeOwnerServer({ recentAuth: 'granted' });
  const owner = createOwnerClient(fakeOwnerTransport(server), 'mock');
  server.addCommittedHistory(110);
  const open = server.addFileReviewSet();
  const older = server.addFileReviewSet();
  const record = server.store.sets.find((item) => item.observationSetId === older)!;
  server.core.discard(older, record.version, 'other');
  // Accepted before 74 of the history's captures: Holdr lists it on the second page of closed sets, after 50 captures.
  record.acceptedAt = server.now() - 11 * DAY - 75 * HOUR;
  const firstClosed = await owner.listObservationSets('closed', null);
  assert.ok(firstClosed.observationSets.every((item) => item.sourceKind === 'extension'), 'an extension-only first page');
  const closed = await reviewQueuePage((cursor) => owner.listObservationSets('closed', cursor), null, true);
  assert.deepEqual(ids(closed), [older]);
  const rest = await reviewQueuePage((cursor) => owner.listObservationSets('closed', cursor), closed.nextCursor, true);
  assert.deepEqual(rest, { items: [], nextCursor: null });
  const waiting = await reviewQueuePage((cursor) => owner.listObservationSets('open', cursor), null, true);
  assert.deepEqual([ids(waiting), waiting.nextCursor], [[open], null]);
  // With the sync state, the same lists keep the extension's captures.
  const all = await reviewQueuePage((cursor) => owner.listObservationSets('open', cursor), null, false);
  assert.ok(all.items.some((item) => item.sourceKind === 'extension') && ids(all).includes(open));
});
