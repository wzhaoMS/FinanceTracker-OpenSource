import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../spendingApi';

/**
 * A read of one view: another view starts clean, and the same view read again (a new `version`) keeps its last answer
 * until the new one is in. Only the view's own answer, and the latest request's error, are returned. `enabled` false
 * reads nothing (a part not shown), and returns no answer.
 */
export function useViewRead<T>(viewKey: string, version: number, load: () => Promise<T>, enabled = true):
  { answer: T | null; error: string | null; busy: boolean } {
  const requestKey = enabled ? JSON.stringify([viewKey, version]) : null;
  const [state, setState] = useState<{ key: string; viewKey: string; answer: T | null; error: string | null; pending: boolean } | null>(null);
  useEffect(() => {
    if (requestKey === null) return undefined;
    let cancelled = false;
    const key = requestKey;
    setState((last) => ({ key, viewKey, answer: last?.viewKey === viewKey ? last.answer : null, error: null, pending: true }));
    load()
      .then((answer) => { if (!cancelled) setState({ key, viewKey, answer, error: null, pending: false }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ key, viewKey, answer: null, error: apiErrorMessage(reason), pending: false }); });
    return () => { cancelled = true; };
    // requestKey holds every input of the request: `load` reads only what viewKey names.
  }, [requestKey]);
  if (requestKey === null) return { answer: null, error: null, busy: false };
  const own = state?.viewKey === viewKey ? state : null;
  return { answer: own?.answer ?? null, error: own?.key === requestKey ? own.error : null, busy: own === null || own.key !== requestKey || own.pending };
}
