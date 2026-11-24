import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../spending/spendingApi';
import { isMissingRoute } from './goldApi';
import { goldReadFailed, goldReadLanded, goldReadShown, goldReadStarted, type GoldReadState } from './goldReads';

/** A read's state: its answer (the last one kept while the same view is read again), its error, and whether it is in flight. */
export interface GoldRead<T> {
  answer: T | null;
  error: string | null;
  /** The API has no such route (it predates the metals ledger). */
  missing: boolean;
  busy: boolean;
}

/**
 * One of the page's reads. `view` names what is shown (the metal): another view starts clean. `request` names
 * everything the read depends on (the metal, the period, a data version): a new request keeps the view's last answer
 * on screen, marked busy, until its own answer is in. Only the latest request's answer or error lands; a read that fails
 * keeps no answer (goldReads: goldReadFailed). Its states are goldReads' pure steps, tested there.
 */
export function useGoldRead<T>(view: string, request: string, load: () => Promise<T>, enabled = true): GoldRead<T> {
  const [state, setState] = useState<GoldReadState<T> | null>(null);
  const key = enabled ? request : null;
  useEffect(() => {
    if (key === null) return undefined;
    let cancelled = false;
    setState((last) => goldReadStarted(last, view, key));
    load()
      .then((answer) => { if (!cancelled) setState(goldReadLanded(view, key, answer)); })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setState(goldReadFailed<T>(view, key, apiErrorMessage(reason), isMissingRoute(reason)));
      });
    return () => { cancelled = true; };
    // `key` holds every input of the request; `load` reads only what it names.
  }, [key]);
  return goldReadShown(state, view, key);
}
