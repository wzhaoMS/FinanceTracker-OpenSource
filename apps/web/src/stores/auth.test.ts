import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Quote } from '@finance-tracker/shared';

// ---- A simulated browser ---------------------------------------------------------------
//
// One origin's localStorage, shared by several tabs. As in real browsers, a write in one tab
// reaches the OTHER tabs as a 'storage' event that is queued and delivered later (here each in
// its own macrotask), never synchronously. A test can also hold a tab's events back to model a
// slow delivery, or drop them for good. Every tab has its own JS heap: its own auth store, its own
// view of the sign-out ledger and its own portfolio store, so nothing one tab holds in memory
// leaks into another.

const shared = new Map<string, string>();
const openTabs = new Set<Tab>();

/** Faults in the origin's storage, as browsers produce them. */
const faults = {
  /** getItem, key() and length throw. */
  reads: false,
  /** Every setItem throws. */
  writes: false,
  /** removeItem throws. */
  removals: false,
  /** localStorage cannot be reached at all (blocked site data, for example). */
  disabled: false,
  /** The origin's quota in UTF-16 code units (keys and values), like a browser's 5 MB limit. */
  quota: Number.POSITIVE_INFINITY,
};

function quotaExceeded(): Error {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

/** Storage in use, optionally without some keys. */
function used(...except: string[]): number {
  let total = 0;
  for (const [key, value] of shared) if (!except.includes(key)) total += key.length + value.length;
  return total;
}

/** localStorage as one tab sees it; `writer` null = page code that is not tied to a tab. */
class TabStorage {
  constructor(private readonly writer: Tab | null) {}
  get length() { this.read(); return shared.size; }
  key(index: number) { this.read(); return [...shared.keys()][index] ?? null; }
  getItem(key: string) { this.read(); return shared.get(key) ?? null; }
  setItem(key: string, value: string) {
    const next = String(value);
    if (faults.writes || used(key) + key.length + next.length > faults.quota) throw quotaExceeded();
    this.change(key, next);
  }
  removeItem(key: string) {
    if (faults.removals) throw new Error('removeItem failed');
    this.change(key, null);
  }
  clear() { for (const key of [...shared.keys()]) this.removeItem(key); }
  private read() {
    if (faults.reads) throw new Error('getItem failed');
  }
  private change(key: string, value: string | null) {
    if ((shared.get(key) ?? null) === value) return; // browsers fire no event for a no-op write
    if (value === null) shared.delete(key);
    else shared.set(key, value);
    for (const tab of openTabs) if (tab !== this.writer) tab.queueEvent(key);
  }
}

const pageStorage = new TabStorage(null);
/** Reloads the current page asked for (window.location.reload()). */
let reloads = 0;

/** A new page: a fresh window (page-wide state such as retirement starts over) on the same storage. */
function freshPage(): void {
  reloads = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get localStorage() {
        if (faults.disabled) throw new Error('SecurityError: access to localStorage is denied');
        return pageStorage;
      },
      location: { reload: () => { reloads += 1; } },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}
freshPage();

// ---- A fake Holdr API with one cookie jar for the whole browser -------------------------

type Outcome = number | 'network-error';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ACCOUNTS = [{ id: 'a', name: 'Private account', cashBalance: 1, currency: 'USD' }];
const TRANSACTIONS = [{ id: 'tx-1', accountId: 'a', symbol: 'NBIS', date: '2026-01-02', quantity: 3, pricePerUnit: 100, currency: 'USD' }];
const QUOTES: Quote[] = [{ symbol: 'NBIS', price: 216.2, currency: 'USD', asOf: Date.now(), source: 'cboe' }];
const NEW_ACCOUNT = { id: 'acc-new', name: 'Private new account', cashBalance: 0, currency: 'USD' };
const POSITION = { id: 'pos-1', accountId: 'a', symbol: 'NVDA', date: '2026-01-03', quantity: 7, pricePerUnit: 180, currency: 'USD', sourceFingerprint: 'pos:NVDA' };

class FakeServer {
  /** The browser's session cookie, shared by every tab. */
  jar: string | null = null;
  /** Nothing answers: every request fails as a network error. */
  down = false;
  readonly calls: string[] = [];
  private readonly sessions = new Set<string>();
  private readonly scripted = new Map<string, Outcome[]>();
  private readonly gates = new Map<string, Array<Promise<void>>>();
  /** While set, every request's answer waits for this gate (see holdRequests). */
  private heldGate: Promise<void> | null = null;
  private minted = 0;

  reset(): void {
    this.jar = null;
    this.down = false;
    this.calls.length = 0;
    this.sessions.clear();
    this.scripted.clear();
    this.gates.clear();
    this.heldGate = null;
  }

  /** A browser that is already signed in. */
  signIn(): void {
    this.jar = this.mint();
  }

  get sessionIsLive(): boolean {
    return this.jar !== null && this.sessions.has(this.jar);
  }

  /** The server ends the browser's session on its own (expiry, a password reset): no sign-out record anywhere. */
  expireSession(): void {
    if (this.jar) this.sessions.delete(this.jar);
  }

  /** The next `request` gets `outcome` (a proxy error or a network failure) and changes nothing. */
  fail(request: string, outcome: Outcome): void {
    this.scripted.set(request, [...(this.scripted.get(request) ?? []), outcome]);
  }

  /** The next `request` reaches the server at once, but its answer reaches the browser only on release(). */
  holdAnswer(request: string): { release: () => Promise<void> } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    this.gates.set(request, [...(this.gates.get(request) ?? []), gate]);
    return {
      release: async () => {
        open();
        await settle();
      },
    };
  }

  /**
   * Every request sent until stop() reaches the server at once, but its answer reaches the
   * browser only on release(). Requests sent after stop() are answered normally.
   */
  holdRequests(): { stop: () => void; release: () => Promise<void> } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    this.heldGate = gate;
    return {
      stop: () => { if (this.heldGate === gate) this.heldGate = null; },
      release: async () => {
        open();
        await settle();
      },
    };
  }

  async fetch(request: string): Promise<Response> {
    this.calls.push(request);
    const outcome = this.down ? 'network-error' : this.scripted.get(request)?.shift();
    const answer = outcome === undefined ? this.process(request, this.jar) : scriptedAnswer(outcome);
    const gate = this.heldGate ?? this.gates.get(request)?.shift();
    if (gate) await gate;
    return answer();
  }

  /** Server-side effects happen now; the returned answer applies its Set-Cookie when it arrives. */
  private process(request: string, presented: string | null): () => Response {
    const live = presented !== null && this.sessions.has(presented);
    if (request === 'POST /auth/login') {
      if (presented) this.sessions.delete(presented); // the API ends the session the login presented
      const token = this.mint();
      return () => {
        this.jar = token;
        return json(200, { user: { username: 'alex' } });
      };
    }
    if (request === 'POST /auth/logout') {
      if (presented) this.sessions.delete(presented);
      return () => {
        this.jar = null;
        return new Response(null, { status: 204 });
      };
    }
    if (request === 'GET /auth/me') {
      return () => (live ? json(200, { user: { username: 'alex' } }) : json(401, { error: 'Sign in required' }));
    }
    const data = (body: unknown, status = 200) => () => (live ? json(status, body) : json(401, { error: 'Sign in required' }));
    if (request === 'GET /accounts') return data({ accounts: ACCOUNTS });
    if (request === 'GET /transactions') return data({ transactions: TRANSACTIONS });
    if (request === 'POST /accounts') return data(NEW_ACCOUNT, 201);
    if (/^PATCH \/accounts\/[^/]+$/.test(request)) return data({ ...ACCOUNTS[0], name: 'Renamed private account' });
    if (/^DELETE \/(accounts|transactions)\/[^/]+$/.test(request)) {
      return () => (live ? new Response(null, { status: 204 }) : json(401, { error: 'Sign in required' }));
    }
    if (/^POST \/accounts\/[^/]+\/transactions$/.test(request)) return data({ ...TRANSACTIONS[0], id: 'tx-new' }, 201);
    if (/^PATCH \/transactions\/[^/]+$/.test(request)) return data({ ...TRANSACTIONS[0], notes: 'edited' });
    if (/^POST \/accounts\/[^/]+\/snapshot-positions$/.test(request)) {
      return data({ ok: true, deleted: 0, inserted: 1, transactions: [POSITION] });
    }
    if (request.startsWith('GET /quotes?symbols=')) return data({ quotes: QUOTES });
    throw new Error(`unexpected ${request}`);
  }

  private mint(): string {
    const token = `session-${++this.minted}`;
    this.sessions.add(token);
    return token;
  }
}

function scriptedAnswer(outcome: Outcome): () => Response {
  return () => {
    if (outcome === 'network-error') throw new TypeError('fetch failed');
    return new Response(outcome === 204 ? null : 'scripted', { status: outcome });
  };
}

const server = new FakeServer();
globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
  const answered = server.fetch(`${init.method ?? 'GET'} ${String(input)}`);
  const { signal } = init;
  if (!signal) return answered;
  // As in a browser: a cancelled request's answer never reaches the page, whenever the server sends it.
  return new Promise<Response>((resolve, reject) => {
    const cancel = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    answered.then(resolve, reject);
  });
}) as typeof fetch;

const { SESSION_ENDED_NOTICE, SIGN_OUT_UNRECORDED, STORAGE_UNUSABLE, createAuthStore, retireAuthModule } = await import('./auth');
const { createPortfolioStore, portfolioTab } = await import('./portfolio');
const { StaleOperationError } = await import('./storeOp');
const {
  LEGACY_SIGN_OUT_PENDING_KEY,
  PORTFOLIO_CACHE_KEY,
  QUOTE_CACHE_KEY,
  SIGN_OUT_RECORD_PREFIX,
  browserTabLedger,
  createTabLedger,
  pageRetired,
  retireBrowserCacheModule,
  storage: browserStorage,
} = await import('../services/browserCache');
const { ApiError, api, apiFetch, retireApiModule } = await import('../services/api');
const { retireStoreOpModule } = await import('./storeOp');
const { retireSymbolHistoryModule } = await import('../services/symbolHistoryCache');

class Tab {
  readonly ledger: ReturnType<typeof createTabLedger>;
  readonly portfolio: ReturnType<typeof createPortfolioStore>;
  readonly store: ReturnType<typeof createAuthStore>;
  private readonly storage = new TabStorage(this);
  private readonly listeners: Array<(key: string | null) => void> = [];
  private readonly resumeListeners: Array<() => void> = [];
  private readonly queue: Array<string | null> = [];
  private holding = false;
  private dropping = false;
  private scheduled = false;

  constructor() {
    openTabs.add(this);
    const getStorage = () => (faults.disabled ? null : this.storage as unknown as Storage);
    // As on a page load: the ledger is read before the portfolio store reads its cache.
    this.ledger = createTabLedger(getStorage);
    this.portfolio = createPortfolioStore(portfolioTab(this.ledger, getStorage));
    this.store = createAuthStore({
      storage: getStorage,
      ledger: this.ledger,
      portfolio: this.portfolio,
      onStorageChange: (listener) => {
        this.listeners.push(listener);
        return () => this.listeners.splice(this.listeners.indexOf(listener) >>> 0, 1);
      },
      onResume: (listener) => {
        this.resumeListeners.push(listener);
        return () => this.resumeListeners.splice(this.resumeListeners.indexOf(listener) >>> 0, 1);
      },
    });
  }

  /** Storage and resume listeners currently registered by this tab's auth store. */
  get listenerCount(): number {
    return this.listeners.length + this.resumeListeners.length;
  }

  get state() {
    return this.store.getState();
  }

  get accounts() {
    return this.portfolio.getState().accounts;
  }

  get deliverable(): boolean {
    return !this.holding && this.queue.length > 0;
  }

  queueEvent(key: string | null): void {
    if (this.dropping) return;
    this.queue.push(key);
    this.schedule();
  }

  /** Keeps this tab's storage events queued until release(). */
  hold(): void {
    this.holding = true;
  }

  async release(): Promise<void> {
    this.holding = false;
    this.schedule();
    await settle();
  }

  /** Loses this tab's storage events from now on, as a frozen or discarded page can. */
  dropEvents(): void {
    this.dropping = true;
    this.queue.length = 0;
  }

  /** The page is shown again: pageshow (from the back/forward cache or not) or visibilitychange to visible. */
  resume(): void {
    for (const listener of this.resumeListeners) listener();
  }

  close(): void {
    openTabs.delete(this);
    this.queue.length = 0;
  }

  private schedule(): void {
    if (this.holding || this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (this.holding || this.queue.length === 0) return;
      const key = this.queue.shift()!;
      for (const listener of this.listeners) listener(key);
      this.schedule();
    }, 0);
  }
}

/** Lets queued storage events, and whatever they start, run to completion. Held answers stay held. */
async function settle(): Promise<void> {
  let quiet = 0;
  for (let round = 0; round < 500 && quiet < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    quiet = [...openTabs].some((tab) => tab.deliverable) ? 0 : quiet + 1;
  }
}

/** What a page reload looks like: a fresh tab with fresh stores; only localStorage and cookies survive. */
async function reload(tab: Tab): Promise<Tab> {
  tab.close();
  const next = new Tab();
  await next.state.check();
  return next;
}

/** The ledger's records: id -> 'pending:<ms>' or 'done:<ms>'. */
function records(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of shared) if (key.startsWith(SIGN_OUT_RECORD_PREFIX)) found.set(key.slice(SIGN_OUT_RECORD_PREFIX.length), value);
  return found;
}

const pendingIds = () => [...records()].filter(([, value]) => value.startsWith('pending:')).map(([id]) => id);
const doneIds = () => [...records()].filter(([, value]) => value.startsWith('done:')).map(([id]) => id);

/** A signed-in tab showing the portfolio and quotes, with the copies a hydrate leaves in localStorage. */
function showDashboard(tab: Tab): void {
  if (!server.sessionIsLive) server.signIn();
  const ids = [...records().keys()];
  tab.ledger.known = new Set(ids);
  shared.set(PORTFOLIO_CACHE_KEY, JSON.stringify({ accounts: ACCOUNTS, transactions: TRANSACTIONS, signOuts: ids }));
  shared.set(QUOTE_CACHE_KEY, JSON.stringify({ quotes: QUOTES, signOuts: ids }));
  tab.portfolio.setState({ accounts: ACCOUNTS, transactions: TRANSACTIONS, quotes: QUOTES, hydrated: true });
  tab.store.setState({ status: 'signed-in', username: 'alex', notice: null, signOutError: null, signOutBusy: false });
}

beforeEach(() => {
  freshPage();
  for (const tab of [...openTabs]) tab.close();
  Object.assign(faults, { reads: false, writes: false, removals: false, disabled: false, quota: Number.POSITIVE_INFINITY });
  shared.clear();
  server.reset();
});

// ---- One tab ------------------------------------------------------------------------------

test('sign-out hides data at once and completes only after the server confirms', async () => {
  const tab = new Tab();
  showDashboard(tab);
  const logout = server.holdAnswer('POST /auth/logout');
  const done = tab.state.signOut();
  assert.equal(tab.state.status, 'signing-out');
  assert.equal(tab.state.username, null);
  assert.deepEqual(tab.accounts, []);
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
  const [id] = pendingIds();
  assert.ok(id);

  await logout.release();
  await done;
  assert.equal(tab.state.status, 'signed-out');
  assert.deepEqual(pendingIds(), []);
  assert.deepEqual(doneIds(), [id], 'the sign-out stays on record, as done');
  assert.deepEqual(server.calls, ['POST /auth/logout', 'GET /auth/me']);
  assert.equal(server.sessionIsLive, false);
});

for (const failure of [502, 'network-error'] as const) {
  test(`a ${failure} sign-out stays pending across reloads until the server confirms`, async () => {
    let tab = new Tab();
    showDashboard(tab);
    server.fail('POST /auth/logout', failure);
    await tab.state.signOut();
    assert.equal(tab.state.status, 'signing-out');
    assert.match(tab.state.signOutError ?? '', failure === 502 ? /HTTP 502/ : /could not be reached/);
    assert.equal(pendingIds().length, 1);
    assert.equal(server.sessionIsLive, true, 'the failed request ended nothing');

    server.calls.length = 0;
    server.fail('POST /auth/logout', failure);
    tab = await reload(tab);
    assert.equal(tab.state.status, 'signing-out', 'reload must not sign back in');
    assert.deepEqual(server.calls, ['POST /auth/logout'], '/auth/me is not consulted while revocation fails');

    await tab.state.retrySignOut();
    assert.equal(tab.state.status, 'signed-out');
    assert.equal(tab.state.signOutError, null);
    assert.deepEqual(pendingIds(), []);
    assert.equal(server.sessionIsLive, false);
  });
}

test('a 204 that leaves the cookie accepted is not a completed sign-out', async () => {
  const tab = new Tab();
  showDashboard(tab);
  server.fail('POST /auth/logout', 204); // answered, but the session survived
  await tab.state.signOut();
  assert.equal(tab.state.status, 'signing-out');
  assert.match(tab.state.signOutError ?? '', /still accepts/);
  assert.equal(pendingIds().length, 1);
});

for (const mark of ['ledger', 'previous build'] as const) {
  test(`a reload with a pending sign-out (${mark} mark) revokes first, then shows the sign-in form`, async () => {
    server.signIn();
    if (mark === 'ledger') shared.set(`${SIGN_OUT_RECORD_PREFIX}f00d`, 'pending:1');
    else shared.set(LEGACY_SIGN_OUT_PENDING_KEY, '2026-10-16T00:00:00.000Z');
    const tab = new Tab();
    await tab.state.check();
    assert.equal(tab.state.status, 'signed-out');
    assert.deepEqual(server.calls, ['POST /auth/logout', 'GET /auth/me']);
    assert.deepEqual(pendingIds(), []);
    assert.equal(shared.get(LEGACY_SIGN_OUT_PENDING_KEY), undefined);
    assert.equal(server.sessionIsLive, false);
  });
}

for (const mark of ['ledger', 'previous build'] as const) {
  test(`signing in again completes a pending sign-out (${mark} mark): the old session is rotated out`, async () => {
    const tab = new Tab();
    showDashboard(tab);
    if (mark === 'ledger') {
      server.fail('POST /auth/logout', 502);
      await tab.state.signOut();
    } else {
      shared.set(LEGACY_SIGN_OUT_PENDING_KEY, '2026-10-16T00:00:00.000Z');
      tab.store.setState({ status: 'signing-out', username: null });
    }
    await tab.state.signIn('alex', 'correct horse battery');
    assert.equal(tab.state.status, 'signed-in');
    assert.deepEqual(pendingIds(), []);
    assert.equal(shared.get(LEGACY_SIGN_OUT_PENDING_KEY), undefined);
    assert.equal(server.sessionIsLive, true);
  });
}

test('API 401s during a pending sign-out do not change its state', async () => {
  const tab = new Tab();
  showDashboard(tab);
  server.fail('POST /auth/logout', 502);
  await tab.state.signOut();
  server.fail('GET /accounts', 401);
  const { api } = await import('../services/api');
  await assert.rejects(api('/accounts'));
  assert.equal(tab.state.status, 'signing-out');
});

for (const status of ['signed-in', 'offline'] as const) {
  for (const late of ['success', 'failure'] as const) {
    test(`a late ${late} of a session check started while ${status} cannot undo a pending sign-out`, async () => {
      const tab = new Tab();
      showDashboard(tab);
      tab.store.setState({ status });
      if (late === 'failure') server.fail('GET /auth/me', 'network-error');
      const me = server.holdAnswer('GET /auth/me');
      // For example the offline-recovery poll, still waiting when the user signs out.
      const staleCheck = tab.state.check();
      server.fail('POST /auth/logout', 502);
      await tab.state.signOut();
      assert.equal(tab.state.status, 'signing-out');

      await me.release();
      await staleCheck;
      assert.equal(tab.state.status, 'signing-out', 'the older answer must not show the dashboard again');
      assert.equal(tab.state.username, null);
      assert.match(tab.state.signOutError ?? '', /HTTP 502/);
      assert.equal(pendingIds().length, 1);
      assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);

      // The retry UI is still in charge and still works.
      await tab.state.retrySignOut();
      assert.equal(tab.state.status, 'signed-out');
      assert.deepEqual(pendingIds(), []);
      assert.equal(server.sessionIsLive, false);
    });
  }
}

test('a session check answered after a newer sign-in cannot sign the browser out', async () => {
  const tab = new Tab();
  tab.store.setState({ status: 'signed-out' });
  const me = server.holdAnswer('GET /auth/me'); // computed now: no session yet, so 401
  const staleCheck = tab.state.check();
  await tab.state.signIn('alex', 'correct horse battery');
  assert.equal(tab.state.status, 'signed-in');
  await me.release();
  await staleCheck;
  assert.equal(tab.state.status, 'signed-in');
  assert.equal(tab.state.username, 'alex');
});

// ---- API 401s: only those of the current session epoch end the session --------------------------

/** The settled outcome of a request: its error, or undefined. */
const outcome = (sent: Promise<unknown>) => sent.then(() => undefined, (error: unknown) => error);

for (const status of ['signed-in', 'offline'] as const) {
  test(`a 401 for the current session ends it at once (${status}): the sign-in form says so, and none of its data is left`, async () => {
    const tab = new Tab();
    showDashboard(tab);
    tab.store.setState({ status });
    server.expireSession();
    await assert.rejects(api('/accounts'));
    assert.equal(tab.state.status, 'signed-out');
    assert.equal(tab.state.notice, SESSION_ENDED_NOTICE);
    assert.equal(tab.state.username, null);
    assert.deepEqual(tab.accounts, []);
    assert.deepEqual(tab.portfolio.getState().quotes, []);
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
    assert.equal(shared.get(QUOTE_CACHE_KEY), undefined);
  });
}

/** A request's state, read without waiting for it: 'pending', 'answered', 'cancelled' (an AbortError), or its error. */
function watch(sent: Promise<unknown>): () => unknown {
  let state: unknown = 'pending';
  sent.then(
    () => { state = 'answered'; },
    (error: unknown) => { state = error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : error; },
  );
  return () => state;
}

for (const ended of ['by a 401', 'by a sign-out'] as const) {
  test(`a request of the old session still unanswered when the user signs in again is cancelled, and the new session stays (the old one ended ${ended})`, async (t) => {
    const logged = t.mock.method(console, 'info', () => undefined);
    const tab = new Tab();
    showDashboard(tab);
    // A request of the first session, refused, whose answer has not reached the page.
    server.fail('GET /accounts', 401);
    const late = server.holdAnswer('GET /accounts');
    const stale = watch(api('/accounts'));
    if (ended === 'by a 401') {
      server.expireSession();
      await assert.rejects(api('/transactions'));
      assert.equal(tab.state.notice, SESSION_ENDED_NOTICE);
    } else {
      await tab.state.signOut();
    }
    assert.equal(tab.state.status, 'signed-out');

    // The user signs in again: the old request is cancelled as the sign-in begins.
    await tab.state.signIn('alex', 'correct horse battery');
    await settle();
    assert.equal(stale(), 'cancelled');
    await tab.portfolio.getState().hydrate();
    assert.equal(tab.state.status, 'signed-in');
    assert.deepEqual(tab.accounts, ACCOUNTS);
    const cached = shared.get(PORTFOLIO_CACHE_KEY);
    assert.ok(cached);

    // Its answer leaves the server only now, and never reaches the page: nothing of it counts.
    await late.release();
    assert.equal(tab.state.status, 'signed-in');
    assert.equal(tab.state.username, 'alex');
    assert.equal(tab.state.notice, null);
    assert.deepEqual(tab.accounts, ACCOUNTS);
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), cached);
    assert.equal(logged.mock.callCount(), 0);
  });
}

test('requests in flight across a sign-in: those sent before it began are cancelled, and a 401 for one sent since still ends it', async (t) => {
  const logged = t.mock.method(console, 'info', () => undefined);
  const tab = new Tab();
  showDashboard(tab);
  // The first session expires with three requests out; their 401s come late. A fourth one's ends it.
  server.expireSession();
  const late = ['GET /accounts', 'GET /transactions', 'DELETE /transactions/tx-1', 'GET /quotes?symbols=NVDA']
    .map((request) => server.holdAnswer(request));
  const stale = [api('/accounts'), api('/transactions'), apiFetch('/transactions/tx-1', { method: 'DELETE' })].map(watch);
  await assert.rejects(api('/quotes?symbols=NBIS'));
  assert.equal(tab.state.status, 'signed-out');
  // A straggler still goes out from the signed-out page, before the user signs in again.
  stale.push(watch(api('/quotes?symbols=NVDA')));

  // The sign-in cancels all four as it begins, the straggler included.
  const login = server.holdAnswer('POST /auth/login');
  const signingIn = tab.state.signIn('alex', 'correct horse battery');
  await settle();
  assert.deepEqual(stale.map((state) => state()), ['cancelled', 'cancelled', 'cancelled', 'cancelled']);
  // Their answers leave the server while the sign-in is in flight and after it landed: none counts.
  await late[0].release();
  await login.release();
  await signingIn;
  for (const answer of late.slice(1)) await answer.release();
  assert.equal(tab.state.status, 'signed-in');
  assert.equal(tab.state.notice, null);
  assert.equal(logged.mock.callCount(), 0);

  // A request of the new session whose 401 comes late still ends it: what counts is when it was sent.
  server.expireSession();
  const current = server.holdAnswer('GET /accounts');
  const sent = outcome(api('/accounts'));
  await current.release();
  assert.ok((await sent) instanceof ApiError);
  assert.equal(tab.state.status, 'signed-out');
  assert.equal(tab.state.notice, SESSION_ENDED_NOTICE);
});

test('a request sent while a sign-in is in flight belongs to the new session: its 401 still ends it', async () => {
  // The browser may already hold the new cookie when such a request goes out, so its 401 cannot be
  // told from one about the new session. Ending the session is the safe answer (the sign-in screen
  // sends no such request).
  const tab = new Tab();
  tab.store.setState({ status: 'signed-out' });
  const login = server.holdAnswer('POST /auth/login');
  const signingIn = tab.state.signIn('alex', 'correct horse battery');
  const during = server.holdAnswer('GET /accounts');
  const sent = outcome(api('/accounts')); // computed now, without a session: 401
  await login.release();
  await signingIn;
  assert.equal(tab.state.status, 'signed-in');
  await during.release();
  assert.ok((await sent) instanceof ApiError);
  assert.equal(tab.state.status, 'signed-out');
  assert.equal(tab.state.notice, SESSION_ENDED_NOTICE);
});

test('a tab that takes up the session another tab signed in ignores 401s to requests it sent before its own sign-out', async (t) => {
  t.mock.method(console, 'info', () => undefined);
  const tab = new Tab();
  showDashboard(tab);
  // A request of the first session, refused, whose answer comes late.
  server.fail('GET /accounts', 401);
  const late = server.holdAnswer('GET /accounts');
  const stale = outcome(api('/accounts'));
  // This tab signs out, but the server cannot confirm it yet.
  server.fail('POST /auth/logout', 502);
  await tab.state.signOut();
  assert.equal(tab.state.status, 'signing-out');
  // Another tab signs in again: the browser holds a new session, and that sign-in settled the sign-out.
  server.signIn();
  for (const id of pendingIds()) shared.set(`${SIGN_OUT_RECORD_PREFIX}${id}`, `done:${Date.now()}`);
  // Retrying, this tab finds nothing pending and asks the server, which accepts the new session.
  await tab.state.retrySignOut();
  assert.equal(tab.state.status, 'signed-in');

  await late.release();
  assert.ok((await stale) instanceof ApiError);
  assert.equal(tab.state.status, 'signed-in', 'the old 401 does not end the session taken up');
});

// ---- Storage that is full, failing or disabled -------------------------------------------------

test('full storage: sign-out evicts the cached portfolio first, so its record fits and a reload revokes instead of signing in', async () => {
  let tab = new Tab();
  showDashboard(tab);
  // The cached portfolio fills the quota: not even a sign-out record fits next to it.
  shared.set(PORTFOLIO_CACHE_KEY, JSON.stringify({ accounts: ACCOUNTS, transactions: [], signOuts: [], notes: 'x'.repeat(5000) }));
  faults.quota = used();
  server.fail('POST /auth/logout', 502);
  await tab.state.signOut();
  assert.equal(tab.state.status, 'signing-out');
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
  assert.equal(pendingIds().length, 1, 'with the cache gone, the record fits');
  assert.equal(tab.state.storageWarning, null);

  server.calls.length = 0;
  server.fail('POST /auth/logout', 502);
  tab = await reload(tab);
  assert.equal(tab.state.status, 'signing-out');
  assert.deepEqual(server.calls, ['POST /auth/logout'], '/auth/me never gets to restore the session');
  assert.deepEqual(tab.accounts, []);
});

test('storage that refuses the sign-out record even without the cache: the tab carries the sign-out, a reload revokes instead of signing in', async () => {
  let tab = new Tab();
  showDashboard(tab);
  shared.set('another-app:blob', 'x'.repeat(5000));
  faults.quota = used(PORTFOLIO_CACHE_KEY, QUOTE_CACHE_KEY); // full once the caches are gone
  server.fail('POST /auth/logout', 502);
  await tab.state.signOut();
  assert.equal(tab.state.status, 'signing-out');
  assert.equal(tab.state.storageWarning, SIGN_OUT_UNRECORDED);
  assert.deepEqual(pendingIds(), []);
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined, 'the cache went first');

  // The tab keeps revoking, and still never lets /auth/me decide.
  server.calls.length = 0;
  server.fail('POST /auth/logout', 502);
  await tab.state.retrySignOut();
  assert.deepEqual(server.calls, ['POST /auth/logout']);
  assert.equal(tab.state.status, 'signing-out');

  // A reload cannot store anything either (its probe write fails), so the ledger is unknown, not empty.
  server.calls.length = 0;
  server.fail('POST /auth/logout', 502);
  tab = await reload(tab);
  assert.equal(tab.state.status, 'signing-out');
  assert.equal(tab.state.storageWarning, STORAGE_UNUSABLE);
  assert.deepEqual(server.calls, ['POST /auth/logout']);

  // Once the server answers, the session ends for real and the user signs in by hand.
  await tab.state.retrySignOut();
  assert.equal(tab.state.status, 'signed-out');
  assert.equal(tab.state.storageWarning, STORAGE_UNUSABLE);
  assert.equal(server.sessionIsLive, false);
});

for (const write of ['the storage probe', 'the sign-out record', 'marking it done'] as const) {
  test(`a failed write (${write}) never lets a later start restore the session`, async () => {
    let tab = new Tab();
    showDashboard(tab);
    if (write === 'the storage probe') {
      // Full storage at start-up, nothing pending: the ledger cannot be trusted to say so.
      faults.quota = used(PORTFOLIO_CACHE_KEY, QUOTE_CACHE_KEY);
      tab.close();
      tab = new Tab();
      await tab.state.check();
      assert.equal(server.calls[0], 'POST /auth/logout', 'the saved session is ended, not reopened');
      assert.equal(tab.state.status, 'signed-out');
      assert.equal(tab.state.storageWarning, STORAGE_UNUSABLE);
      assert.equal(server.sessionIsLive, false);
      return;
    }
    if (write === 'the sign-out record') faults.writes = true;
    server.fail('POST /auth/logout', 502);
    await tab.state.signOut();
    assert.equal(tab.state.status, 'signing-out');
    if (write === 'the sign-out record') {
      assert.equal(tab.state.storageWarning, SIGN_OUT_UNRECORDED, 'until the server confirms, this page carries the sign-out');
      assert.deepEqual(pendingIds(), []);
    } else {
      assert.equal(pendingIds().length, 1);
      faults.writes = true; // the record went in, but now it cannot be marked done
    }
    await tab.state.retrySignOut();
    assert.equal(tab.state.status, 'signed-out');
    assert.equal(tab.state.storageWarning, STORAGE_UNUSABLE);
    if (write === 'marking it done') assert.equal(pendingIds().length, 1, 'the record stays pending: later starts revoke again');
    // Someone signs in again later, and storage still cannot be written: a reload must not trust it.
    await tab.state.signIn('alex', 'correct horse battery');
    assert.equal(server.sessionIsLive, true);
    server.calls.length = 0;
    tab = await reload(tab);
    assert.equal(server.calls[0], 'POST /auth/logout');
    assert.notEqual(tab.state.status, 'signed-in');
    assert.equal(server.sessionIsLive, false);
  });
}

test('a ledger that cannot be read is unknown, never "no sign-out": a fresh tab does not let /auth/me restore the session', async () => {
  server.signIn();
  shared.set(`${SIGN_OUT_RECORD_PREFIX}f00d`, 'pending:1');
  shared.set(PORTFOLIO_CACHE_KEY, JSON.stringify({ accounts: ACCOUNTS, transactions: [], signOuts: [] }));
  faults.reads = true;
  server.fail('POST /auth/logout', 502);
  const tab = new Tab();
  assert.deepEqual(tab.accounts, [], 'an unreadable cache is not shown either');
  await tab.state.check();
  assert.equal(tab.state.status, 'signing-out');
  assert.equal(tab.state.storageWarning, STORAGE_UNUSABLE);
  assert.deepEqual(server.calls, ['POST /auth/logout']);
  assert.equal(server.sessionIsLive, true);

  faults.reads = false;
  await tab.state.retrySignOut();
  assert.equal(tab.state.status, 'signed-out');
  assert.deepEqual(pendingIds(), []);
  assert.equal(server.sessionIsLive, false);
});

test('storage that starts failing reads makes a signed-in tab hide its data and end the session', async () => {
  const tab = new Tab();
  showDashboard(tab);
  faults.reads = true;
  tab.resume();
  assert.equal(tab.state.status, 'signing-out');
  assert.deepEqual(tab.accounts, []);
  await tab.state.retrySignOut();
  assert.equal(server.sessionIsLive, false);
  assert.equal(tab.state.status, 'signed-out');
});

test('a cache that cannot be evicted is refused on the next start: it was written before the sign-out on record', async () => {
  const tab = new Tab();
  showDashboard(tab);
  faults.removals = true;
  server.fail('POST /auth/logout', 502);
  await tab.state.signOut();
  assert.ok(shared.get(PORTFOLIO_CACHE_KEY), 'the old copy is still in storage');
  assert.equal(pendingIds().length, 1);

  tab.close();
  server.down = true;
  const next = new Tab();
  assert.deepEqual(next.accounts, [], 'refused when read, before anything is shown');
  await next.state.check();
  assert.equal(next.state.status, 'signing-out');
  assert.deepEqual(next.accounts, []);
});

test('with storage disabled, a start never restores a session, but signing in by hand works and lasts', async () => {
  server.signIn();
  faults.disabled = true;
  const tab = new Tab();
  await tab.state.check();
  assert.equal(tab.state.status, 'signed-out');
  assert.equal(tab.state.storageWarning, STORAGE_UNUSABLE);
  assert.deepEqual(server.calls, ['POST /auth/logout', 'GET /auth/me']);
  assert.equal(server.sessionIsLive, false);

  await tab.state.signIn('alex', 'correct horse battery');
  assert.equal(tab.state.status, 'signed-in');
  tab.resume();
  await settle();
  assert.equal(tab.state.status, 'signed-in', 'storage that never worked has nothing new to say');

  server.fail('POST /auth/logout', 502);
  await tab.state.signOut();
  assert.equal(tab.state.status, 'signing-out');
  assert.equal(tab.state.storageWarning, SIGN_OUT_UNRECORDED);
  await tab.state.retrySignOut();
  assert.equal(tab.state.status, 'signed-out');
  assert.equal(server.sessionIsLive, false);
});

// ---- Several tabs, with storage events delivered late ---------------------------------------

test('storage events reach other tabs asynchronously', async () => {
  const a = new Tab();
  const b = new Tab();
  showDashboard(a);
  b.store.setState({ status: 'signed-in', username: 'alex' });
  const logout = server.holdAnswer('POST /auth/logout');
  const signingOut = b.state.signOut();
  assert.equal(a.state.status, 'signed-in', 'nothing is delivered synchronously');
  assert.deepEqual(a.accounts, ACCOUNTS, 'each tab holds its own data');
  await settle();
  assert.equal(a.state.status, 'signing-out', 'the other tab hides its data once the event arrives');
  assert.deepEqual(a.accounts, []);
  await logout.release();
  await signingOut;
  await settle();
  assert.equal(b.state.status, 'signed-out');
  assert.equal(a.state.status, 'signed-out', 'the confirmation makes the other tab ask the server again');
});

for (const late of ['success', 'failure'] as const) {
  test(`a late ${late} of a session check cannot undo another tab's sign-out, whose confirmation checks afresh`, async () => {
    const a = new Tab();
    const b = new Tab();
    showDashboard(a);
    b.store.setState({ status: 'signed-in', username: 'alex' });
    if (late === 'failure') server.fail('GET /auth/me', 'network-error');
    const me = server.holdAnswer('GET /auth/me');
    const staleCheck = a.state.check();
    server.fail('POST /auth/logout', 502);
    await b.state.signOut();
    await settle();
    assert.equal(a.state.status, 'signing-out');

    await me.release();
    await staleCheck;
    assert.equal(a.state.status, 'signing-out');
    assert.equal(a.state.username, null);

    await b.state.retrySignOut();
    await settle();
    assert.equal(b.state.status, 'signed-out');
    assert.equal(a.state.status, 'signed-out');
  });
}

test('another tab confirming while an older check is unanswered: the confirmation checks afresh', async () => {
  const a = new Tab();
  const b = new Tab();
  showDashboard(a);
  b.store.setState({ status: 'signed-in', username: 'alex' });
  const me = server.holdAnswer('GET /auth/me'); // computed now: the session is still live
  const staleCheck = a.state.check();
  await b.state.signOut(); // confirmed at once
  await settle();
  assert.equal(a.state.status, 'signed-out', 'the confirmation must not wait for the older request');
  await me.release();
  await staleCheck;
  assert.equal(a.state.status, 'signed-out');
});

test('a check answered after another tab finished signing out is dropped even before the events arrive', async () => {
  const a = new Tab();
  const b = new Tab();
  showDashboard(a);
  b.store.setState({ status: 'signed-in', username: 'alex' });
  a.hold();
  const me = server.holdAnswer('GET /auth/me'); // computed now: the session is still live
  const staleCheck = a.state.check();
  await b.state.signOut();
  assert.equal(b.state.status, 'signed-out');
  await me.release();
  await staleCheck;
  assert.equal(a.state.status, 'signed-out', 'the ledger in storage, not the queued events, decides');
  await a.release();
  assert.equal(a.state.status, 'signed-out');
});

test('an older sign-in cannot cancel another tab\'s pending sign-out while its storage events are queued', async () => {
  // Same browser, so one cookie: tab A shows the sign-in form, tab B the dashboard.
  server.signIn();
  const a = new Tab();
  const b = new Tab();
  a.store.setState({ status: 'signed-out' });
  showDashboard(b);
  a.hold();
  const login = server.holdAnswer('POST /auth/login');
  const signingIn = a.state.signIn('alex', 'correct horse battery');

  server.fail('POST /auth/logout', 502);
  await b.state.signOut();
  assert.equal(b.state.status, 'signing-out');
  const [requested] = pendingIds();
  assert.ok(requested);

  // A's sign-in answers before A has heard of B's sign-out.
  await login.release();
  await signingIn;
  assert.notEqual(a.state.status, 'signed-in');
  await a.release();
  await settle();

  assert.equal(a.state.status, 'signed-out');
  assert.equal(b.state.status, 'signed-out', 'B must not read A\'s sign-in as the confirmation of its sign-out');
  assert.equal(server.sessionIsLive, false, 'the late sign-in leaves no live session behind');
  assert.deepEqual(pendingIds(), []);
  assert.equal(records().size, 2, 'the late session was ended by a sign-out of its own');
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
});

test('an older sign-in cannot undo another tab\'s sign-out that completed before it answered', async () => {
  server.signIn();
  const a = new Tab();
  const b = new Tab();
  a.store.setState({ status: 'signed-out' });
  showDashboard(b);
  a.hold();
  const login = server.holdAnswer('POST /auth/login');
  const signingIn = a.state.signIn('alex', 'correct horse battery');

  await b.state.signOut(); // revoked and confirmed: its record is done already
  assert.equal(b.state.status, 'signed-out');
  assert.deepEqual(pendingIds(), []);

  await login.release();
  await signingIn;
  await a.release();
  await settle();

  assert.equal(a.state.status, 'signed-out');
  assert.equal(b.state.status, 'signed-out');
  assert.equal(server.sessionIsLive, false, 'the late sign-in leaves no live session behind');
  assert.deepEqual(pendingIds(), []);
});

test('a confirmation settles only the sign-outs on record when its request began; a newer one stays pending', async () => {
  const a = new Tab();
  const b = new Tab();
  showDashboard(a);
  b.store.setState({ status: 'signed-in', username: 'alex' });
  const logout = server.holdAnswer('POST /auth/logout');
  const aSigningOut = a.state.signOut();
  const [older] = pendingIds();

  server.fail('POST /auth/logout', 502);
  await b.state.signOut(); // a newer sign-out, not confirmed
  const newer = pendingIds().find((id) => id !== older);
  assert.ok(newer);

  await logout.release();
  await aSigningOut;
  assert.deepEqual(pendingIds(), [newer], 'the newer record is not touched');
  assert.deepEqual(doneIds(), [older]);
  assert.equal(a.state.status, 'signing-out');

  await a.state.retrySignOut();
  await settle();
  assert.deepEqual(pendingIds(), []);
  assert.equal(a.state.status, 'signed-out');
  assert.equal(b.state.status, 'signed-out');
});

// ---- Tabs that missed a sign-out (events late or lost; separate heaps and portfolio stores) -----

test('an offline tab that missed another tab\'s completed sign-out drops its accounts before its next check', async () => {
  server.signIn();
  shared.set(PORTFOLIO_CACHE_KEY, JSON.stringify({ accounts: ACCOUNTS, transactions: [], signOuts: [] }));
  // A opened while the server was unreachable: it shows the read-only cache.
  server.down = true;
  const a = new Tab();
  await a.state.check();
  assert.equal(a.state.status, 'offline');
  assert.deepEqual(a.accounts, ACCOUNTS);
  a.dropEvents();

  // B signs out while the server is back; A hears nothing of it.
  server.down = false;
  const b = new Tab();
  showDashboard(b);
  await b.state.signOut();
  assert.equal(b.state.status, 'signed-out');
  assert.equal(server.sessionIsLive, false);

  // A's offline-recovery check, with the server unreachable again.
  server.down = true;
  await a.state.check();
  assert.deepEqual(a.accounts, [], 'A dropped its data before deciding anything');
  assert.equal(a.state.status, 'offline');
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
});

for (const pending of [false, true]) {
  test(`a tab shown again (pageshow, visibilitychange) catches up with a ${pending ? 'pending' : 'completed'} sign-out it missed`, async () => {
    const a = new Tab();
    const b = new Tab();
    showDashboard(a);
    b.store.setState({ status: 'signed-in', username: 'alex' });
    a.dropEvents();
    if (pending) server.fail('POST /auth/logout', 502);
    await b.state.signOut();
    assert.deepEqual(a.accounts, ACCOUNTS, 'A has heard nothing');

    server.down = true;
    a.resume();
    assert.deepEqual(a.accounts, [], 'dropped at once, before any request');
    assert.notEqual(a.state.status, 'signed-in');
    await a.state.check();
    assert.deepEqual(a.accounts, []);
    if (pending) assert.equal(a.state.status, 'signing-out');
  });
}

test('a tab that missed a sign-out cannot write its older data back into the cache', async () => {
  const a = new Tab();
  const b = new Tab();
  showDashboard(b);
  a.store.setState({ status: 'signed-in', username: 'alex' });
  a.dropEvents();
  // A's hydrate is answered, with the data from before, only after B's sign-out.
  const accounts = server.holdAnswer('GET /accounts');
  const transactions = server.holdAnswer('GET /transactions');
  const hydrating = a.portfolio.getState().hydrate();
  await b.state.signOut();
  assert.equal(server.sessionIsLive, false);
  await accounts.release();
  await transactions.release();
  await hydrating;
  await settle();
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined, 'the copy from before the sign-out is not written back');
  assert.deepEqual(a.accounts, [], 'and the write attempt made A catch up');
  assert.notEqual(a.state.status, 'signed-in');

  // A later start while the server is unreachable finds nothing from before the sign-out.
  server.down = true;
  const c = new Tab();
  await c.state.check();
  assert.deepEqual(c.accounts, []);
});

test('a copy written by a tab that missed a sign-out is refused by every reader', async () => {
  server.signIn();
  shared.set(`${SIGN_OUT_RECORD_PREFIX}f00d`, 'done:1');
  // Written without that sign-out among the ones it accounts for.
  shared.set(PORTFOLIO_CACHE_KEY, JSON.stringify({ accounts: ACCOUNTS, transactions: [], signOuts: [] }));
  server.down = true;
  const tab = new Tab();
  assert.deepEqual(tab.accounts, []);
  assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
  await tab.state.check();
  assert.equal(tab.state.status, 'offline');
  assert.deepEqual(tab.accounts, []);
});

// ---- Answers that arrive after a sign-out ------------------------------------------------------

type PortfolioState = ReturnType<Tab['portfolio']['getState']>;

/**
 * Every async action of the portfolio store, called so that it sends its request. A new async
 * action fails the coverage test below until it is listed here, and then has to pass the late-answer
 * test like every other one.
 */
const ASYNC_ACTIONS: Record<string, (store: PortfolioState) => Promise<unknown>> = {
  hydrate: (store) => store.hydrate(),
  addAccount: (store) => store.addAccount({ name: 'Private new account' }),
  renameAccount: (store) => store.renameAccount('a', { name: 'Renamed private account' }),
  setCash: (store) => store.setCash('a', 5),
  removeAccount: (store) => store.removeAccount('a'),
  addTransaction: (store) => store.addTransaction({ ...TRANSACTIONS[0], id: 'tx-new' }),
  updateTransaction: (store) => store.updateTransaction('tx-1', { notes: 'edited' }),
  removeTransaction: (store) => store.removeTransaction('tx-1'),
  replaceSnapshotPositions: (store) => store.replaceSnapshotPositions('a', [POSITION]),
  refreshQuotes: (store) => store.refreshQuotes(['NBIS']),
};
const SYNC_ACTIONS = ['isLoading', 'getActionError', 'clearActionError', 'beginOp', 'reset'];

test('every async action of the portfolio store is covered by the late-answer test', () => {
  const tab = new Tab();
  const actions = Object.entries(tab.portfolio.getState())
    .filter(([name, value]) => typeof value === 'function' && !SYNC_ACTIONS.includes(name))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(actions, Object.keys(ASYNC_ACTIONS).sort(), 'add the new async action to ASYNC_ACTIONS');
});

for (const [name, run] of Object.entries(ASYNC_ACTIONS)) {
  test(`a late answer to ${name} after another tab's sign-out, the catch-up and a failed offline hydration changes nothing`, async () => {
    const a = new Tab();
    const b = new Tab();
    showDashboard(a);
    b.store.setState({ status: 'signed-in', username: 'alex' });
    a.dropEvents();

    // (1) A's request is authorised before the sign-out; its answer is held.
    const held = server.holdRequests();
    const outcome = run(a.portfolio.getState()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    held.stop();
    assert.ok(server.calls.length > 0, 'the request went out');

    // (2) B signs out; the session is revoked.
    await b.state.signOut();
    assert.equal(server.sessionIsLive, false);

    // (3) A is shown again and catches up; its session check and hydration fail offline.
    server.down = true;
    a.resume();
    await a.state.check();
    await a.portfolio.getState().hydrate();
    assert.equal(a.state.status, 'offline');
    assert.equal(a.portfolio.getState().hydrated, false, 'a failed hydration never marks the store hydrated');

    // (4) The old answer arrives.
    await held.release();
    const result = await outcome;
    if (name === 'refreshQuotes') assert.deepEqual(result, { value: { status: 'stale' } });
    else if (name !== 'hydrate') assert.ok('error' in result && result.error instanceof StaleOperationError, `${name} reports a stale operation`);

    const state = a.portfolio.getState();
    assert.deepEqual(state.accounts, [], 'no private account comes back');
    assert.deepEqual(state.transactions, []);
    assert.deepEqual(state.quotes, []);
    assert.equal(state.hydrated, false);
    assert.deepEqual(state.loadingActions, []);
    assert.deepEqual(state.actionErrors, {});
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined, 'nothing is cached');
    assert.equal(shared.get(QUOTE_CACHE_KEY), undefined);

    // (5) A fresh tab, offline, shows nothing either.
    const fresh = new Tab();
    await fresh.state.check();
    assert.equal(fresh.state.status, 'offline');
    assert.deepEqual(fresh.accounts, []);
    assert.deepEqual(fresh.portfolio.getState().transactions, []);
    assert.deepEqual(fresh.portfolio.getState().quotes, []);
  });
}

test('a chain of requests stops at its first step after a sign-out: nothing more is sent', async () => {
  const a = new Tab();
  const b = new Tab();
  showDashboard(a);
  b.store.setState({ status: 'signed-in', username: 'alex' });
  a.dropEvents();
  const op = a.portfolio.getState().beginOp(); // an import begins
  await b.state.signOut();
  server.calls.length = 0;
  await assert.rejects(a.portfolio.getState().replaceSnapshotPositions('a', [POSITION], op), StaleOperationError);
  await settle();
  assert.ok(!server.calls.some((call) => call.includes('snapshot-positions')), 'the next step was never sent');
  assert.deepEqual(a.accounts, [], 'and the refusal made A catch up with the sign-out');
});

test('cached copies are tagged with the sign-outs known when the request began, not the current ones', async () => {
  // A sign-out from the day before, pruned while a hydrate is under way.
  shared.set(`${SIGN_OUT_RECORD_PREFIX}0ld`, 'done:1');
  server.signIn();
  const tab = new Tab();
  tab.store.setState({ status: 'signed-in', username: 'alex' });
  const held = server.holdRequests();
  const hydrating = tab.portfolio.getState().hydrate();
  held.stop();
  shared.delete(`${SIGN_OUT_RECORD_PREFIX}0ld`);
  await held.release();
  await hydrating;
  assert.equal(tab.portfolio.getState().hydrated, true);
  assert.deepEqual(JSON.parse(shared.get(PORTFOLIO_CACHE_KEY)!).signOuts, ['0ld']);
});

// ---- Hot updates: a module evaluated again under the same page --------------------------------

test('retiring the stores (dispose) outdates their operations, empties them and removes their listeners', async () => {
  const tab = new Tab();
  showDashboard(tab);
  assert.equal(tab.listenerCount, 2);
  const op = tab.portfolio.getState().beginOp();
  assert.equal(op.current(), true);

  tab.portfolio.retire();
  tab.store.retire();
  assert.equal(op.current(), false);
  assert.equal(op.commit(() => assert.fail('a retired store commits nothing')), false);
  assert.equal(tab.portfolio.getState().beginOp().current(), false, 'nor can it start a current operation');
  assert.deepEqual(tab.accounts, []);
  assert.deepEqual(tab.portfolio.getState().quotes, []);
  assert.equal(tab.listenerCount, 0);
  await assert.rejects(tab.portfolio.getState().addAccount({ name: 'x' }), StaleOperationError);
  tab.resume();
  assert.equal(tab.state.status, 'signed-in', 'the retired auth store reacts to nothing');
});

for (const disposed of [true, false]) {
  test(`a portfolio module evaluated again cannot have its old store recreate either cache (${disposed ? 'old store retired by dispose' : 'old store never retired'})`, async () => {
    // The page's own store (module level, on window.localStorage), signed in, with both caches.
    // Each variant evaluates the module afresh, so neither inherits the other's instances.
    const variant = disposed ? 'disposed' : 'plain';
    const before = (await import(`./portfolio.ts?hot-update=${variant}-before`)) as typeof import('./portfolio');
    const old = before.usePortfolioStore;
    server.signIn();
    await old.getState().hydrate();
    await old.getState().refreshQuotes(['NBIS']);
    assert.ok(shared.get(PORTFOLIO_CACHE_KEY));
    assert.ok(shared.get(QUOTE_CACHE_KEY));

    // Requests authorised before the update; their answers are held.
    const held = server.holdRequests();
    const adding = old.getState().addAccount({ name: 'Private new account' }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const quoting = old.getState().refreshQuotes(['NBIS']);
    held.stop();

    // The hot update: Vite calls dispose on the module (when it does), then evaluates it again.
    // Its dependencies (the ledger and cache module) keep their instances.
    if (disposed) old.retire();
    const after = (await import(`./portfolio.ts?hot-update=${variant}-after`)) as typeof import('./portfolio');
    const current = after.usePortfolioStore;
    const auth = createAuthStore({
      storage: () => window.localStorage,
      ledger: browserTabLedger,
      portfolio: current,
      onStorageChange: () => () => undefined,
      onResume: () => () => undefined,
    });

    // The session ends on the server without any sign-out record: it expired, or a password reset revoked it.
    server.expireSession();
    await auth.getState().check();
    assert.equal(auth.getState().status, 'signed-out');
    assert.equal(records().size, 0, 'no sign-out record exists to outdate anything');
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined);
    assert.equal(shared.get(QUOTE_CACHE_KEY), undefined);

    // The old store's answers arrive.
    await held.release();
    const added = await adding;
    const quoted = await quoting;
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined, 'the old store cannot recreate the portfolio cache');
    assert.equal(shared.get(QUOTE_CACHE_KEY), undefined, 'nor the quote cache');
    assert.deepEqual(current.getState().accounts, [], 'the page shows nothing');
    assert.deepEqual(current.getState().quotes, []);
    if (disposed) {
      assert.ok('error' in added && added.error instanceof StaleOperationError);
      assert.deepEqual(quoted, { status: 'stale' });
      assert.deepEqual(old.getState().accounts, []);
    }

    // A fresh reader, offline, shows nothing either.
    server.down = true;
    const fresh = new Tab();
    await fresh.state.check();
    assert.deepEqual(fresh.accounts, []);
    assert.deepEqual(fresh.portfolio.getState().quotes, []);
    auth.retire();
  });
}

// ---- The hot-update fallback: a stateful module disposed while its replacement loads -----------
//
// Vite's client (fetchUpdate) runs the module's dispose, awaits the replacement module, and only
// then calls the accept callback that reloads. These tests replay it with the replacement held:
// dispose, then a 401 and late answers while nothing has reloaded yet.

const FALLBACK_DISPOSES: Record<string, (page: { auth: ReturnType<typeof createAuthStore>; portfolio: typeof import('./portfolio') }) => void> = {
  'auth-only': ({ auth }) => retireAuthModule(auth),
  'API-only': () => retireApiModule(),
  'portfolio-only': ({ portfolio }) => portfolio.retirePortfolioModule(),
  'storeOp-only': () => retireStoreOpModule(),
  'ledger-and-cache-only': () => retireBrowserCacheModule(),
  'symbol-history-only': () => retireSymbolHistoryModule(),
};

for (const [update, dispose] of Object.entries(FALLBACK_DISPOSES)) {
  test(`the hot-update fallback (${update}), held while its replacement loads, lets nothing write the caches after a 401`, async () => {
    // The page: its own copy of the portfolio module (the current cache writer) and an auth store.
    const portfolio = (await import(`./portfolio.ts?page=${update}`)) as typeof import('./portfolio');
    const store = portfolio.usePortfolioStore;
    browserTabLedger.known = new Set();
    const auth = createAuthStore({
      storage: browserStorage,
      ledger: browserTabLedger,
      portfolio: store,
      onStorageChange: () => () => undefined,
      onResume: () => () => undefined,
    });
    server.signIn();
    auth.setState({ status: 'signed-in', username: 'alex' });
    await store.getState().hydrate();
    await store.getState().refreshQuotes(['NBIS']);
    assert.ok(shared.get(PORTFOLIO_CACHE_KEY));
    assert.ok(shared.get(QUOTE_CACHE_KEY));

    // (1) An authorised account creation and quote refresh are pending.
    const held = server.holdRequests();
    const adding = store.getState().addAccount({ name: 'Private new account' }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const quoting = store.getState().refreshQuotes(['NBIS']);
    held.stop();

    // (2) The fallback update disposes the module; loading its replacement is held (never resumed here).
    dispose({ auth, portfolio });
    assert.equal(pageRetired(), true);
    assert.equal(reloads, 1, 'the page reloads at once');
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined, 'the caches are cleared');
    assert.equal(shared.get(QUOTE_CACHE_KEY), undefined);

    // (3) The session expires; a protected request answers 401.
    server.expireSession();
    await assert.rejects(api('/accounts'));

    // (4) The old answers arrive.
    await held.release();
    const added = await adding;
    assert.ok('error' in added && added.error instanceof StaleOperationError, 'the account creation commits nothing');
    assert.deepEqual(await quoting, { status: 'stale' });
    assert.equal(shared.get(PORTFOLIO_CACHE_KEY), undefined, 'nothing writes the portfolio cache');
    assert.equal(shared.get(QUOTE_CACHE_KEY), undefined, 'nor the quote cache');
    assert.deepEqual(store.getState().accounts, [], 'the page shows nothing');
    assert.deepEqual(store.getState().quotes, []);
    assert.equal(store.getState().beginOp().current(), false, 'nor can it start anything');

    // (5) After the reload, with the API unavailable, a fresh reader shows nothing.
    freshPage();
    server.down = true;
    const fresh = new Tab();
    await fresh.state.check();
    assert.equal(fresh.state.status, 'offline');
    assert.deepEqual(fresh.accounts, []);
    assert.deepEqual(fresh.portfolio.getState().quotes, []);
    auth.retire();
  });
}
