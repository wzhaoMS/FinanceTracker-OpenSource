import { useCallback, useEffect, useRef, useState } from 'react';
import { isOwnerApiError, type CardSyncOwnerClient } from './ownerClient';
import { loadOwnerClient } from './ownerClientFactory';
import type { OwnerState } from './ownerApi';
import { serverNow } from './syncStatus';

export type OwnerSyncStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface OwnerSync {
  client: CardSyncOwnerClient | null;
  status: OwnerSyncStatus;
  state: OwnerState | null;
  /** Goes up on every successful refresh, even when Holdr's clock didn't move: lists that hang off the state reload on it. */
  revision: number;
  /** The last refresh's failure while an older state is still shown (or the first load's). */
  error: unknown;
  refresh: () => Promise<void>;
  /** "Now" on Holdr's clock. */
  now: () => number;
  /** Faster refreshes while something on screen waits for Holdr (a pairing code waiting for the extension). */
  setFastPoll: (on: boolean) => void;
}

const SLOW_POLL_MS = 30_000;
const FAST_POLL_MS = 3_000;

/**
 * Holdr's sync state for the Spending tab: loaded once, refreshed on demand, and every 30 seconds while the tab is on
 * screen. While it isn't (`onScreen` false: another mode hides the mounted panel), or while the browser tab is hidden, no
 * refresh runs; on coming back, an answer older than the interval is read again at once.
 */
export function useOwnerSync(onScreen = true): OwnerSync {
  const [client, setClient] = useState<CardSyncOwnerClient | null>(null);
  const [state, setState] = useState<OwnerState | null>(null);
  const [status, setStatus] = useState<OwnerSyncStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  const [fastPoll, setFastPollState] = useState(false);
  const [revision, setRevision] = useState(0);
  const receivedAt = useRef(0);
  const generation = useRef(0);
  const hasState = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadOwnerClient()
      .then((loaded) => { if (!cancelled) setClient(loaded); })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(reason);
      });
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    const current = ++generation.current;
    try {
      const next = await client.getState();
      if (current !== generation.current) return;
      receivedAt.current = Date.now();
      hasState.current = true;
      setState(next);
      setRevision((value) => value + 1);
      setStatus('ready');
      setError(null);
    } catch (reason) {
      if (current !== generation.current) return;
      if (isOwnerApiError(reason) && reason.kind === 'unavailable') {
        hasState.current = false;
        setState(null);
        setStatus('unavailable');
        setError(null);
        return;
      }
      setError(reason);
      if (!hasState.current) setStatus('error');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client || status === 'unavailable' || !onScreen) return undefined;
    const doc = typeof document === 'undefined' ? null : document;
    const browserTabShown = () => doc === null || doc.visibilityState !== 'hidden';
    // Back on screen after a while (or polling again after a pause): what is shown may be old, so read it now.
    const catchUp = () => {
      if (browserTabShown() && hasState.current && Date.now() - receivedAt.current >= SLOW_POLL_MS) void refresh();
    };
    catchUp();
    const timer = setInterval(() => {
      if (browserTabShown()) void refresh();
    }, fastPoll ? FAST_POLL_MS : SLOW_POLL_MS);
    doc?.addEventListener('visibilitychange', catchUp);
    return () => {
      clearInterval(timer);
      doc?.removeEventListener('visibilitychange', catchUp);
    };
  }, [client, refresh, fastPoll, status, onScreen]);

  const now = useCallback(() => (state ? serverNow(state, receivedAt.current, Date.now()) : Date.now()), [state]);
  const setFastPoll = useCallback((on: boolean) => setFastPollState(on), []);

  return { client, status, state, revision, error, refresh, now, setFastPoll };
}
