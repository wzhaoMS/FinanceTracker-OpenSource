import type { Quote } from '@finance-tracker/shared';

import { retirePage } from './browserCache';

/**
 * Single source of truth for talking to the Holdr API.
 *
 * Every call is a same-origin request through the web server's proxy
 * (apps/web/apiProxy.ts); the API itself listens on 127.0.0.1 only. The
 * HttpOnly session cookie rides along automatically, and every request
 * carries `X-Holdr-Request: 1`, which the API requires on state-changing
 * requests (together with an allowlisted Origin) as CSRF protection.
 *
 * A 401 from any route means the session is gone; the registered auth
 * listener then shows the sign-in form. That holds for the session the
 * request was sent in: a 401 that answers a request sent before this tab's
 * latest auth event (a new session epoch) is ignored, and a sign-in cancels
 * the requests of earlier epochs that are still unanswered.
 */

export const CSRF_HEADER = 'X-Holdr-Request';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly body: string,
  ) {
    super(`${status} ${statusText}: ${body}`);
    this.name = 'ApiError';
  }
}

export type AuthFailure = 'unauthorized' | 'setup-required';
type AuthFailureListener = (failure: AuthFailure) => void;

let authFailureListener: AuthFailureListener | null = null;

/**
 * The session epoch. The auth store starts a new one at every auth event in this tab: when a
 * sign-in or a sign-out begins, when a session ends, when the tab catches up with another tab's
 * sign-out. Every request remembers the epoch it was sent in, and a 401 (or a first-run 503)
 * reaches the listener only for a request of the current epoch. An older request was sent with a
 * session this tab has left since, so its 401 says nothing about the session it holds now, and
 * must not end it.
 */
let sessionEpoch = 0;

/** Starts a new session epoch: auth failures of the requests sent until now no longer count. */
export function startSessionEpoch(): void {
  sessionEpoch += 1;
}

/**
 * Requests in flight that carry the auth check (all but the auth store's own calls) and no signal of
 * their caller's, with the epoch each was sent in.
 */
const inFlight = new Map<AbortController, number>();

/**
 * Cancels the requests of earlier session epochs that are still unanswered. The auth store calls it
 * when a sign-in begins: an answer to the session that sign-in replaces must not arrive after the new
 * session's own. Besides a 401 that would no longer count, it can carry the server's cookie for the
 * old session (cleared once refused, renewed while alive), which the browser would apply over the new
 * session's cookie. The browser drops a cancelled request's answer, its cookies included. Each
 * cancelled call rejects with an AbortError, which its caller must take like any other failure (a
 * fire-and-forget caller too). This reaches only this tab's requests in `inFlight`: another tab's, and
 * the auth store's own, can still change the cookie. Nor does it undo anything on the server: a write
 * the server had already accepted completes.
 */
export function cancelEarlierRequests(): void {
  for (const [controller, epoch] of inFlight) if (epoch !== sessionEpoch) controller.abort();
}

/**
 * The auth store registers here so a 401 (or first-run 503) of the current session epoch reaches
 * it. Returns a function that unregisters the listener again, if it is still the registered one.
 */
export function onAuthFailure(listener: AuthFailureListener | null): () => void {
  authFailureListener = listener;
  return () => {
    if (authFailureListener === listener) authFailureListener = null;
  };
}

/** Reports an auth failure to the listener, unless the request was sent in an earlier session epoch. */
async function reportAuthFailure(res: Response, sentIn: number, request: string): Promise<void> {
  if (!authFailureListener) return;
  let failure: AuthFailure | null = null;
  if (res.status === 401) {
    failure = 'unauthorized';
  } else if (res.status === 503) {
    const body = await res.clone().json().catch(() => null) as { setupRequired?: boolean } | null;
    if (body?.setupRequired) failure = 'setup-required';
  }
  if (!failure) return;
  if (sentIn !== sessionEpoch) {
    console.info(`[auth] ignored HTTP ${res.status} for ${request}: sent before this tab's session changed`);
    return;
  }
  authFailureListener(failure);
}

/**
 * fetch() for API paths. Pass `{ authCheck: false }` for the sign-in calls
 * themselves, whose 401s are answers rather than an ended session.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  options: { authCheck?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, '1');
  const url = path.startsWith('/') ? path : `/${path}`;
  const authCheck = options.authCheck !== false;
  const sentIn = sessionEpoch;
  // Only requests with the auth check can be cancelled (cancelEarlierRequests): the sign-in calls are
  // the auth store's own, and a caller that passes its own signal stays in charge of it.
  const cancel = authCheck && !init.signal ? new AbortController() : null;
  if (cancel) inFlight.set(cancel, sentIn);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, credentials: 'same-origin', ...(cancel ? { signal: cancel.signal } : {}) });
  } finally {
    if (cancel) inFlight.delete(cancel);
  }
  if (authCheck) await reportAuthFailure(res, sentIn, `${init.method ?? 'GET'} ${url.split('?')[0]}`);
  return res;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
}

async function throwIfFailed(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => res.statusText);
  throw new ApiError(res.status, res.statusText, text);
}

/** Issue a JSON request to the API. Throws ApiError on non-2xx. */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await apiFetch(path, init);
  await throwIfFailed(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Issue a POST whose body is already encoded (PDF, CSV, etc.). */
export async function apiRaw<T>(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<T> {
  const res = await apiFetch(path, { method: 'POST', body, headers });
  await throwIfFailed(res);
  return (await res.json()) as T;
}

export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const json = await api<{ quotes: Quote[] }>(
    `/quotes?symbols=${encodeURIComponent(symbols.join(','))}`,
  );
  return json.quotes;
}

/**
 * This module's hot-update dispose. The page retires first; the 401 hook is then not removed but
 * replaced, so a 401 that still arrives retires and reloads the page.
 */
export function retireApiModule(): void {
  retirePage();
  authFailureListener = () => retirePage();
}

// Never hot-swapped (apps/web/hmrReload.ts): a second copy would keep the auth store's 401 hook
// apart from the requests made through the first. An update retires the page and reloads it instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => retireApiModule());
  import.meta.hot.accept(() => window.location.reload());
}
