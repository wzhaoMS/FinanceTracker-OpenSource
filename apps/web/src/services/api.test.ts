import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { ApiError, api, apiFetch, apiRaw, cancelEarlierRequests, onAuthFailure, startSessionEpoch, type AuthFailure } from './api';
import {
  commitCardImport,
  createCardAccount,
  fetchCardAccounts,
  fetchCardTransaction,
  fetchSpendingSummary,
  previewCardImport,
  updateCardTransaction,
} from '../components/spending/spendingApi';

// What the browser would send: every API call, the Spending tab's card import upload included,
// is a same-origin request through the web server's proxy, with the session cookie and the
// X-Holdr-Request header the API requires (with the page's Origin) on state-changing requests.

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  body: BodyInit | null | undefined;
}

const realFetch = globalThis.fetch;
let sent: Sent[];
let answer: (init: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  sent = [];
  answer = () => new Response('{"cardAccounts":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      credentials: init.credentials,
      body: init.body,
    });
    return answer(init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  onAuthFailure(null);
});

function assertSameOriginWithCsrf(request: Sent): void {
  assert.ok(request.url.startsWith('/') && !request.url.startsWith('//'), `${request.url} is same-origin`);
  assert.equal(request.headers.get('X-Holdr-Request'), '1', `${request.method} ${request.url} carries X-Holdr-Request`);
  assert.equal(request.credentials, 'same-origin');
}

test('api() and apiRaw() send the CSRF header on every request, same-origin', async () => {
  await api('/card-accounts', { method: 'POST', body: { issuer: 'amex' } });
  await apiRaw('/card-imports/preview?cardAccountId=card-acct-x', '{"format":"holdr.card-import"}', { 'Content-Type': 'application/json' });
  assert.equal(sent.length, 2);
  for (const request of sent) assertSameOriginWithCsrf(request);
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].headers.get('Content-Type'), 'application/json');
  assert.equal(sent[1].body, '{"format":"holdr.card-import"}', 'the redacted JSON goes up as the file\'s own text');
});

test('every Spending tab call goes through them: reads, edits and the import upload', async () => {
  const json = '{"format":"holdr.card-import"}';
  await fetchCardAccounts();
  await fetchSpendingSummary({ from: '2026-09-01', to: '2026-09-30' });
  await fetchCardTransaction('card-tx-1');
  await createCardAccount({ issuer: 'amex', owner: 'alex', currency: 'USD', last4: '0003' });
  await updateCardTransaction('card-tx-1', { notes: 'synthetic' });
  await previewCardImport('card-acct-1', json);
  await commitCardImport('card-acct-1', json, { possibleDuplicates: 'skip', pendingMatches: 'post' });
  assert.deepEqual(sent.map((request) => `${request.method} ${request.url.split('?')[0]}`), [
    'GET /card-accounts',
    'GET /spending/summary',
    'GET /card-transactions/card-tx-1',
    'POST /card-accounts',
    'PATCH /card-transactions/card-tx-1',
    'POST /card-imports/preview',
    'POST /card-imports/commit',
  ]);
  for (const request of sent) assertSameOriginWithCsrf(request);
});

test('a 401 from a card route ends the session in the app, like any other route', async () => {
  const failures: AuthFailure[] = [];
  onAuthFailure((failure) => failures.push(failure));
  answer = () => new Response('{"error":"Sign in required"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(previewCardImport('card-acct-1', '{}'), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.deepEqual(failures, ['unauthorized']);
});

// ---- Session epochs: an auth failure counts only for a request of the current epoch ----------

const unauthorized = () => new Response('{"error":"Sign in required"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
const setupRequired = () => new Response('{"error":"No users yet","setupRequired":true}', { status: 503, headers: { 'Content-Type': 'application/json' } });

/** Every way a page request reaches the API with its auth check, the dashboard's /health poll included. */
const REQUESTS: Record<string, () => Promise<unknown>> = {
  'api()': () => api('/accounts'),
  'the /health poll': () => api('/health'),
  'apiRaw()': () => apiRaw('/card-imports/preview?cardAccountId=card-acct-x', '{}', { 'Content-Type': 'application/json' }),
  'apiFetch()': () => apiFetch('/transactions/tx-1', { method: 'DELETE' }),
};

for (const [name, send] of Object.entries(REQUESTS)) {
  for (const [kind, failed, failure] of [['401', unauthorized, 'unauthorized'], ['first-run 503', setupRequired, 'setup-required']] as const) {
    test(`${name}: a ${kind} counts only for a request sent in the current session epoch`, async (t) => {
      const logged = t.mock.method(console, 'info', () => undefined);
      const failures: AuthFailure[] = [];
      onAuthFailure((reported) => failures.push(reported));
      let deliver!: () => void;
      const late = new Promise<Response>((resolve) => { deliver = () => resolve(failed()); });
      answer = () => late;
      const before = send().catch(() => undefined);
      // A sign-in or sign-out begins: requests sent until now belong to the session it leaves.
      startSessionEpoch();
      deliver();
      await before;
      assert.deepEqual(failures, [], 'the older request\'s failure is dropped');
      assert.equal(logged.mock.callCount(), 1, 'and logged');
      assert.match(String(logged.mock.calls[0].arguments[0]), new RegExp(`ignored HTTP ${failed().status} for `));

      answer = failed;
      await send().catch(() => undefined);
      assert.deepEqual(failures, [failure], 'a request of the current epoch counts');
    });
  }
}

test('requests across an epoch change: each failure is judged by when its request was sent, not when it is answered', async (t) => {
  t.mock.method(console, 'info', () => undefined);
  const failures: AuthFailure[] = [];
  onAuthFailure((failure) => failures.push(failure));
  const releases: Array<() => void> = [];
  answer = () => new Promise<Response>((resolve) => { releases.push(() => resolve(unauthorized())); });
  const older = [api('/accounts'), api('/transactions')].map((sent) => sent.catch(() => undefined));
  startSessionEpoch();
  const newer = api('/accounts').catch(() => undefined);
  const [olderFirst, olderSecond, current] = releases;
  // The newer request is answered first, the older ones after it: only the newer one counts.
  current();
  await newer;
  olderSecond();
  olderFirst();
  await Promise.all(older);
  assert.deepEqual(failures, ['unauthorized']);
});

test('the sign-in calls themselves report nothing, whatever their epoch', async () => {
  const failures: AuthFailure[] = [];
  onAuthFailure((failure) => failures.push(failure));
  answer = unauthorized;
  const res = await apiFetch('/auth/login', { method: 'POST' }, { authCheck: false });
  assert.equal(res.status, 401);
  assert.deepEqual(failures, []);
});

test('cancelEarlierRequests() cancels the unanswered requests of earlier epochs, and only those', async (t) => {
  t.mock.method(console, 'info', () => undefined);
  // As in a browser: a cancelled request rejects with an AbortError, and its answer never arrives.
  const answers = new Map<string, () => void>();
  answer = (init) => new Promise<Response>((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    answers.set(String(sent.at(-1)?.url), () => resolve(unauthorized()));
  });
  const failures: AuthFailure[] = [];
  onAuthFailure((failure) => failures.push(failure));
  const settled = (request: Promise<unknown>) => request.then(
    () => 'answered',
    (error: unknown) => (error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed'),
  );
  const older = settled(api('/accounts'));
  const olderRaw = settled(apiRaw('/card-imports/preview?cardAccountId=card-acct-x', '{}', { 'Content-Type': 'application/json' }));
  const signInCall = settled(apiFetch('/auth/me', {}, { authCheck: false }));
  const ownSignal = settled(apiFetch('/transactions', { signal: new AbortController().signal }));
  startSessionEpoch();
  const current = settled(api('/health'));
  cancelEarlierRequests();
  for (const deliver of answers.values()) deliver();
  // The sign-in call and the request with its caller's own signal are answered (apiFetch() returns a 401
  // as it is); the current epoch's request fails with its 401 (api() throws).
  assert.deepEqual(await Promise.all([older, olderRaw, signInCall, ownSignal, current]), ['cancelled', 'cancelled', 'answered', 'answered', 'failed']);
  assert.deepEqual(failures, ['unauthorized'], 'only the current epoch\'s 401 counts; the older one with its own signal is ignored');
});
