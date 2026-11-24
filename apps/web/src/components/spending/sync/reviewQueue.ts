/**
 * The review queue's pages as Sync & coverage shows them. Holdr lists every observation set, newest accepted first
 * (E2a), whichever source sent it. Without Holdr's sync state (`/state` answers that this Holdr has no extension sync, as
 * in `vite` or `local` mode) the queue lists only file imports' sets: an extension capture needs the sync gate and its card
 * binding, and neither is there. Captures left in the database from a time with extension sync stay out of that queue.
 */
import type { SetSummary } from './ownerApi';
import type { Page } from './usePagedList';

/** Pages of the list read for one page of the file-only queue before it hands back an empty page and the cursor to go on. */
export const FILE_ONLY_PAGE_READS = 20;

/**
 * One page of the queue from `read` (one page of Holdr's list per call). With `fileOnly`, only file sets are kept, and
 * pages that hold none are read past, so file reviews behind a page of extension captures are still listed; after
 * {@link FILE_ONLY_PAGE_READS} such pages the queue gets an empty page with Holdr's cursor, and "Show more" goes on.
 */
export async function reviewQueuePage(
  read: (cursor: string | null) => Promise<{ observationSets: SetSummary[]; nextCursor: string | null }>,
  cursor: string | null,
  fileOnly: boolean,
): Promise<Page<SetSummary>> {
  let next = cursor;
  for (let reads = 1; ; reads += 1) {
    const page = await read(next);
    const items = fileOnly ? page.observationSets.filter((set) => set.sourceKind === 'file') : page.observationSets;
    if (!fileOnly || items.length > 0 || page.nextCursor === null || reads >= FILE_ONLY_PAGE_READS) {
      return { items, nextCursor: page.nextCursor };
    }
    next = page.nextCursor;
  }
}
