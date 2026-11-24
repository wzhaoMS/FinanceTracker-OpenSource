/**
 * localStorage keys holding copies of server data. They exist only so a
 * signed-in browser can paint before the network answers, and are wiped on
 * sign-out or when the server reports the session has ended. UI preferences
 * (`finance-tracker:pref:*`) and the locally entered goal are kept.
 */
export const PORTFOLIO_CACHE_KEY = 'finance-tracker:state:v2';
export const QUOTE_CACHE_KEY = 'finance-tracker:quotes:v1';

/** This tab's localStorage, or null where it is unavailable (storage disabled, no window). */
export function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Page retirement. Whenever a module holding sign-in, portfolio, ledger or cache state is about to
 * be replaced under this page (its hot-update dispose, apps/web/hmrReload.ts), retirePage() runs
 * first: every store operation on the page turns stale for good, no cached server data may be
 * written by anyone, the caches are cleared, registered in-memory copies are dropped, and the page
 * reloads. The state lives on the window, which every copy of every module on the page shares and
 * only a fresh page load replaces.
 */
const RETIREMENT = Symbol.for('holdr.page.retirement');

interface Retirement {
  retired: boolean;
  drops: Set<() => void>;
}

function retirement(): Retirement {
  const page = (typeof window === 'undefined' ? globalThis : window) as unknown as { [RETIREMENT]?: Retirement };
  page[RETIREMENT] ??= { retired: false, drops: new Set() };
  return page[RETIREMENT];
}

/** Whether this page was retired: nothing may commit or cache server data until a fresh page load. */
export function pageRetired(): boolean {
  return retirement().retired;
}

/** Registers an in-memory copy of server data to drop when the page retires. */
export function onPageRetired(drop: () => void): void {
  retirement().drops.add(drop);
}

/** Retires the page (see above); a page retires once. */
export function retirePage(): void {
  const state = retirement();
  if (state.retired) return;
  state.retired = true;
  clearCachedFinancialData();
  for (const drop of state.drops) {
    try {
      drop();
    } catch {
      // Every other copy is still dropped.
    }
  }
  if (typeof window !== 'undefined') window.location.reload();
}

export function clearCachedFinancialData(getStorage: () => Storage | null = storage): void {
  for (const key of [PORTFOLIO_CACHE_KEY, QUOTE_CACHE_KEY]) {
    try {
      getStorage()?.removeItem(key);
    } catch {
      // Unavailable storage holds nothing to clear; a failed removal is caught when the cache is read.
    }
  }
}

/**
 * The sign-out ledger: one localStorage record per sign-out, shared by every tab of the origin.
 *
 *   finance-tracker:sign-out:<id>   'pending:<ms>'  the user signed out; the server has not confirmed it
 *                                   'done:<ms>'     a confirmed revocation, or a later sign-in, covered it
 *
 * Web Storage has no cross-tab locking, so no step reads a shared value and writes it back:
 *  - every sign-out writes its own record under a fresh random id;
 *  - a record only ever changes from pending to done, written by a tab that read it as pending
 *    before the request that covers it (a confirmed revocation or a sign-in) began. A sign-out that
 *    starts later has a different key, so nothing written for an older one can touch it;
 *  - done records stay for a day, so a sign-in or session check that began before a sign-out still
 *    finds it when its answer arrives. Only then are they pruned.
 *
 * Reads are tri-state: when storage cannot be read, the ledger is unknown, which callers treat as
 * "a sign-out may be pending", never as "none".
 */
export const SIGN_OUT_RECORD_PREFIX = 'finance-tracker:sign-out:';
/**
 * Written by earlier, never deployed builds of the sign-in work: one shared pending mark. It is still
 * honoured as a pending sign-out, settled by any confirmed revocation in this browser.
 */
export const LEGACY_SIGN_OUT_PENDING_KEY = 'finance-tracker:sign-out-pending:v1';
const LEGACY_SIGN_OUT_LATEST_KEY = 'finance-tracker:sign-out-latest:v1';
export const LEGACY_SIGN_OUT_ID = 'legacy';
export const STORAGE_PROBE_KEY = 'finance-tracker:storage-probe';
export const DONE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export type LedgerView =
  | { known: true; /** every sign-out on record */ ids: string[]; /** those not yet confirmed */ pending: string[] }
  | { known: false };

export const UNKNOWN_LEDGER: LedgerView = { known: false };

export function isLedgerKey(key: string): boolean {
  return key.startsWith(SIGN_OUT_RECORD_PREFIX) || key === LEGACY_SIGN_OUT_PENDING_KEY;
}

export function newSignOutId(): string {
  // getRandomValues, unlike randomUUID, also exists on plain-HTTP pages.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---- Single storage operations. The ledger below and its interleaving tests are built from these. ----

/** The whole ledger, read in one synchronous pass (browsers serve a task's reads from one view). Throws if storage does. */
export function readLedger(store: Storage): LedgerView {
  const ids: string[] = [];
  const pending: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key === null || !isLedgerKey(key)) continue;
    const value = store.getItem(key);
    if (value === null) continue;
    const id = key === LEGACY_SIGN_OUT_PENDING_KEY ? LEGACY_SIGN_OUT_ID : key.slice(SIGN_OUT_RECORD_PREFIX.length);
    ids.push(id);
    // Anything but a well-formed done record counts as pending.
    if (id === LEGACY_SIGN_OUT_ID || !/^done:\d+$/.test(value)) pending.push(id);
  }
  return { known: true, ids, pending };
}

export function readRecord(store: Storage, id: string): string | null {
  return store.getItem(id === LEGACY_SIGN_OUT_ID ? LEGACY_SIGN_OUT_PENDING_KEY : SIGN_OUT_RECORD_PREFIX + id);
}

export function writePendingRecord(store: Storage, id: string, now: number): string {
  const value = `pending:${now}`;
  store.setItem(SIGN_OUT_RECORD_PREFIX + id, value);
  return value;
}

/** Marks one sign-out done; returns the value a read-back must find (null: the record must be gone). */
export function writeDoneRecord(store: Storage, id: string, now: number): string | null {
  if (id === LEGACY_SIGN_OUT_ID) {
    store.removeItem(LEGACY_SIGN_OUT_PENDING_KEY);
    store.removeItem(LEGACY_SIGN_OUT_LATEST_KEY);
    return null;
  }
  const value = `done:${now}`;
  store.setItem(SIGN_OUT_RECORD_PREFIX + id, value);
  return value;
}

/**
 * Whether a sign-out began between two reads of the ledger: then an answer to a request sent after
 * the first read (a sign-in, a session check) is outranked. Unknown at the end means it cannot be
 * ruled out. Unknown throughout means storage is unusable, so no tab could have recorded one.
 */
export function signOutBeganBetween(before: LedgerView, after: LedgerView): boolean {
  if (!after.known) return before.known;
  if (!before.known) return after.ids.length > 0;
  const seen = new Set(before.ids);
  return after.ids.some((id) => !seen.has(id));
}

export interface SignOutLedger {
  /** The ledger now, or unknown if storage cannot be read. */
  read(): LedgerView;
  /** Whether storage accepts a write right now (it may be full or disabled). */
  writable(): boolean;
  /** Records a pending sign-out and reads it back: false if it did not persist. */
  record(id: string): boolean;
  /** Marks sign-outs done (each read back): false if any of them did not persist. */
  settle(ids: readonly string[]): boolean;
  /** Removes done records older than a day. */
  prune(): void;
}

export function signOutLedger(getStorage: () => Storage | null = storage, now: () => number = Date.now): SignOutLedger {
  const attempt = <T>(fallback: T, use: (store: Storage) => T): T => {
    try {
      const store = getStorage();
      return store ? use(store) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    read: () => attempt<LedgerView>(UNKNOWN_LEDGER, readLedger),
    writable: () => attempt(false, (store) => {
      // Larger than a pending record (key and value), so a probe that fits means a record would.
      const nonce = newSignOutId() + newSignOutId();
      store.setItem(STORAGE_PROBE_KEY, nonce);
      const ok = store.getItem(STORAGE_PROBE_KEY) === nonce;
      store.removeItem(STORAGE_PROBE_KEY);
      return ok;
    }),
    record: (id) => attempt(false, (store) => {
      const written = writePendingRecord(store, id, now());
      return readRecord(store, id) === written;
    }),
    // Every id is attempted, even after a failure.
    settle: (ids) => ids.map((id) => attempt(false, (store) => {
      const written = writeDoneRecord(store, id, now());
      return readRecord(store, id) === written;
    })).every(Boolean),
    prune: () => attempt(undefined, (store) => {
      const cutoff = now() - DONE_RECORD_TTL_MS;
      const view = readLedger(store);
      if (!view.known) return;
      for (const id of view.ids) {
        const done = /^done:(\d+)$/.exec(readRecord(store, id) ?? '');
        if (done && Number(done[1]) < cutoff) store.removeItem(SIGN_OUT_RECORD_PREFIX + id);
      }
    }),
  };
}

/** One tab's view of the ledger, shared by its auth and portfolio stores. */
export interface TabLedger {
  readonly ledger: SignOutLedger;
  /**
   * The sign-outs this tab's state already accounts for. A record outside this set means the tab
   * missed a sign-out and must drop what it holds. Null when the ledger could not be read.
   */
  known: Set<string> | null;
  /** Set by the auth store: called when a store operation finds a sign-out this tab missed. */
  onMissedSignOut: () => void;
}

export function createTabLedger(getStorage: () => Storage | null = storage): TabLedger {
  const ledger = signOutLedger(getStorage);
  const view = ledger.read();
  return { ledger, known: view.known ? new Set(view.ids) : null, onMissedSignOut: () => undefined };
}

/**
 * This tab's, created when this module loads: before the portfolio store reads its cache, so any
 * sign-out recorded after that read is one this tab has not accounted for.
 */
export const browserTabLedger = createTabLedger();

/**
 * Cached server data carries the sign-outs its writer had accounted for (`signOuts`): those its
 * store operation knew when its request began (stores/storeOp.ts). A tab that missed another tab's
 * sign-out may still write data from before it, so a reader discards the copy if the ledger names a
 * sign-out the writer did not know, or if the ledger cannot be read. A bare array (an untagged
 * copy) accounts for no sign-out at all.
 */
export function readCachedServerData(tab: TabLedger, getStorage: () => Storage | null, key: string): Record<string, unknown> | null {
  let raw: string | null;
  try {
    raw = getStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  const view = tab.ledger.read();
  if (!view.known) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const accountedFor = Array.isArray(record.signOuts) ? record.signOuts : [];
  if (view.ids.some((id) => !accountedFor.includes(id))) {
    try {
      getStorage()?.removeItem(key);
    } catch {
      // Left in place, it is refused on every read.
    }
    return null;
  }
  return record;
}

/**
 * Which store instance may write cached server data into each storage area. It lives on globalThis,
 * not in this module, so it outlasts any one evaluation of the modules involved: when a hot update
 * (or anything else) creates a second portfolio store for the same storage, the newest one claims
 * it and the older one can no longer write, whatever state its operations are in.
 */
const CACHE_WRITERS = Symbol.for('holdr.cacheWriters');

function cacheWriters(): WeakMap<object, symbol> {
  const registry = globalThis as typeof globalThis & { [CACHE_WRITERS]?: WeakMap<object, symbol> };
  registry[CACHE_WRITERS] ??= new WeakMap();
  return registry[CACHE_WRITERS];
}

function storageArea(getStorage: () => Storage | null): Storage | null {
  try {
    return getStorage();
  } catch {
    return null;
  }
}

/** Makes a new writer the only one allowed to write cached server data into this storage area. */
export function claimCacheWriter(getStorage: () => Storage | null): symbol {
  const writer = Symbol('cache writer');
  const area = storageArea(getStorage);
  if (area) cacheWriters().set(area, writer);
  return writer;
}

/**
 * Writes cached server data tagged with the sign-outs it accounts for. Callers pass the ids their
 * operation began with and write only while it is still current; the current ledger is never used.
 * A writer that has been replaced (claimCacheWriter) writes nothing.
 */
export function writeCachedServerData(
  getStorage: () => Storage | null,
  key: string,
  data: object,
  signOuts: readonly string[],
  writer: symbol,
): void {
  if (pageRetired()) return;
  const area = storageArea(getStorage);
  if (!area || cacheWriters().get(area) !== writer) return;
  try {
    area.setItem(key, JSON.stringify({ ...data, signOuts }));
  } catch (err) {
    console.warn('[cache] write failed', err);
  }
}

/** This module's hot-update dispose: retires the page before anything is removed. */
export function retireBrowserCacheModule(): void {
  retirePage();
  browserTabLedger.onMissedSignOut = () => undefined;
}

// Never hot-swapped (apps/web/hmrReload.ts): a second copy would hold its own view of the sign-out
// ledger next to the one the stores already use. An update reloads the page instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => retireBrowserCacheModule());
  import.meta.hot.accept(() => window.location.reload());
}
