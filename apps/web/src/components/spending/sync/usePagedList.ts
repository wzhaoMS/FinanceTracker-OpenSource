import { useCallback, useEffect, useRef, useState } from 'react';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PagedList<T> {
  /** null until the first page is in. */
  items: T[] | null;
  hasMore: boolean;
  loadingMore: boolean;
  error: unknown;
  loadMore: () => void;
}

/** A refresh reads at most this many pages again, so a broken cursor can't loop. */
const MAX_PAGES = 50;

/**
 * Later answers win: an item already listed is replaced in place, a new one is appended. Live lists may serve a member
 * again on a later page (E1b revision 8, X39: a row merged again has a new key); the later copy is the fresher one.
 */
export function mergeById<T>(existing: readonly T[], added: readonly T[], keyOf: (item: T) => string): T[] {
  const index = new Map(existing.map((item, position) => [keyOf(item), position]));
  const result = [...existing];
  for (const item of added) {
    const position = index.get(keyOf(item));
    if (position === undefined) {
      index.set(keyOf(item), result.length);
      result.push(item);
    } else {
      result[position] = item;
    }
  }
  return result;
}

/**
 * A list read page by page with Holdr's opaque cursor. Whenever `reloadKey`
 * changes it is read again from the start, as many pages as were open, so a
 * refresh never hides rows the owner had paged to. A refresh and "show more"
 * never run at once: asking for more during a refresh waits for it and then
 * reads the page after the refreshed ones, and a page still on its way when a
 * refresh starts is read by the refresh instead. `null` pauses the list.
 * When Holdr refuses the cursor of a "show more" (`cursorRefused`: the list
 * changed under it, or Holdr restarted), the list is read again from its first
 * page, as far as the owner had paged and one page further, with no error.
 */
export function usePagedList<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  keyOf: (item: T) => string,
  reloadKey: string | null,
  cursorRefused: (error: unknown) => boolean = () => false,
): PagedList<T> {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  const refusedRef = useRef(cursorRefused);
  refusedRef.current = cursorRefused;
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Bumped when Holdr refused a "show more" cursor: the list is read again from the start. */
  const [restarts, setRestarts] = useState(0);
  /** Bumped by every refresh: an answer that belongs to an older one is dropped. */
  const generation = useRef(0);
  const pagesRead = useRef(1);
  const cursorRef = useRef<string | null>(null);
  const refreshing = useRef(false);
  /** "Show more" was asked for during a refresh. */
  const moreWanted = useRef(false);
  /** A "show more" page is on its way. */
  const moreInFlight = useRef(false);

  const readMore = useCallback((mine: number, asked: string) => {
    moreInFlight.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await fetchRef.current(asked);
        if (generation.current !== mine) return;
        setItems((current) => mergeById(current ?? [], page.items, keyRef.current));
        const next = page.nextCursor === asked ? null : page.nextCursor;
        cursorRef.current = next;
        setCursor(next);
        pagesRead.current += 1;
        setError(null);
      } catch (reason) {
        if (generation.current !== mine) return;
        if (refusedRef.current(reason)) {
          // The refresh this starts reads the page asked for too, so "loading more" stays on until it is in.
          moreInFlight.current = false;
          moreWanted.current = true;
          setRestarts((count) => count + 1);
          return;
        }
        setError(reason);
      }
      moreInFlight.current = false;
      setLoadingMore(false);
    })();
  }, []);

  useEffect(() => {
    if (reloadKey === null) return undefined;
    const mine = ++generation.current;
    // A page the owner asked for that hasn't arrived is read by this refresh.
    const extra = moreWanted.current || moreInFlight.current;
    moreWanted.current = false;
    moreInFlight.current = false;
    refreshing.current = true;
    setLoadingMore(extra);
    const wanted = Math.min(pagesRead.current + (extra ? 1 : 0), MAX_PAGES);
    void (async () => {
      let all: T[] = [];
      let next: string | null = null;
      let pages = 0;
      const seen = new Set<string>();
      do {
        const page: Page<T> = await fetchRef.current(next);
        if (generation.current !== mine) return;
        all = mergeById(all, page.items, keyRef.current);
        pages += 1;
        next = page.nextCursor !== null && !seen.has(page.nextCursor) ? page.nextCursor : null;
        if (next !== null) seen.add(next);
      } while (next !== null && pages < wanted);
      refreshing.current = false;
      pagesRead.current = Math.max(1, pages);
      cursorRef.current = next;
      setItems(all);
      setCursor(next);
      setError(null);
      const more = moreWanted.current;
      moreWanted.current = false;
      if (more && next !== null) readMore(mine, next);
      else setLoadingMore(false);
    })().catch((reason: unknown) => {
      if (generation.current !== mine) return;
      refreshing.current = false;
      moreWanted.current = false;
      setLoadingMore(false);
      setError(reason);
    });
    return () => {
      generation.current += 1;
      refreshing.current = false;
    };
  }, [reloadKey, readMore, restarts]);

  const loadMore = useCallback(() => {
    if (refreshing.current) {
      moreWanted.current = true;
      setLoadingMore(true);
      return;
    }
    if (cursorRef.current === null || moreInFlight.current) return;
    readMore(generation.current, cursorRef.current);
  }, [readMore]);

  return { items, hasMore: cursor !== null, loadingMore, error, loadMore };
}
