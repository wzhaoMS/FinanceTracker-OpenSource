import { create, type StateCreator } from 'zustand';
import type { Account, ActionError, Quote, Transaction } from '@finance-tracker/shared';

import { api, apiFetch, fetchQuotes } from '../services/api';
import {
  PORTFOLIO_CACHE_KEY,
  QUOTE_CACHE_KEY,
  browserTabLedger,
  claimCacheWriter,
  onPageRetired,
  readCachedServerData,
  retirePage,
  storage as browserStorage,
  writeCachedServerData,
  type TabLedger,
} from '../services/browserCache';
import { mergeQuotesByRecency, normalizeCachedQuotes } from '../services/quotes';
import { StaleOperationError, beginStoreOp, type StoreOp } from './storeOp';

/**
 * Server-first portfolio store (Phase 3).
 *
 * Reads come from /accounts and /transactions on app boot.
 * Writes go to per-resource endpoints; on success the local store is
 * updated. localStorage is a read-only cache that lets the first paint
 * happen without waiting on the network; it is cleared on sign-out, and a
 * copy written by a tab that missed a sign-out is refused
 * (services/browserCache.ts).
 *
 * Every async update (hydrate, each mutation, quote refreshes, and the
 * loading/error bookkeeping around them) applies its result through the
 * StoreOp it began with (stores/storeOp.ts). An answer that arrives after a
 * sign-out, or after the store was reset, changes nothing and writes no
 * cache. Callers that chain several requests (imports, bulk deletes) begin
 * one operation and pass it to every step, so the chain stops at the first
 * step after a sign-out.
 *
 * A previous version of this file synced state to /state in a debounced
 * timer; that endpoint no longer exists.
 */

interface PersistedState {
  accounts: Account[];
  transactions: Transaction[];
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One tab's ledger view and storage. Tests give every simulated tab its own. */
export interface PortfolioTab {
  ledger: TabLedger;
  storage: () => Storage | null;
}

export function portfolioTab(ledger: TabLedger, storage: () => Storage | null = browserStorage): PortfolioTab {
  return { ledger, storage };
}

function loadPortfolioCache(tab: PortfolioTab): PersistedState | null {
  const cached = readCachedServerData(tab.ledger, tab.storage, PORTFOLIO_CACHE_KEY);
  if (!cached || !Array.isArray(cached.accounts) || !Array.isArray(cached.transactions)) return null;
  return { accounts: cached.accounts as Account[], transactions: cached.transactions as Transaction[] };
}

function loadQuoteCache(tab: PortfolioTab): Quote[] {
  const cached = readCachedServerData(tab.ledger, tab.storage, QUOTE_CACHE_KEY);
  return normalizeCachedQuotes(Array.isArray(cached) ? cached : cached?.quotes);
}

/** What a quote refresh came to: applied, failed (with the API's message), or outdated by a sign-out. */
export type QuoteRefresh = { status: 'ok' } | { status: 'failed'; error: string } | { status: 'stale' };

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface PortfolioState extends PersistedState {
  /** Set only by a successful hydrate whose operation was still current: the data came from the server. */
  hydrated: boolean;
  /** API connectivity. 'live' = server reachable; 'cache' = serving from
   *  localStorage because the last hydrate or refresh threw. The UI uses
   *  this to render a banner and disable mutations. */
  apiStatus: 'live' | 'cache';
  /** When the cache was last refreshed (ms epoch). */
  cacheUpdatedAt: number | null;
  /** Last hydrate error message, for the banner. */
  apiError: string | null;
  /** In-flight mutation IDs, e.g. `updateTransaction:t1`. */
  loadingActions: string[];
  /** Last mutation error by action ID. */
  actionErrors: Record<string, ActionError>;
  isLoading: (actionId: string) => boolean;
  getActionError: (actionId: string) => string | null;
  clearActionError: (actionId: string) => void;
  /** Latest quotes for held symbols: the cached copy at start, then whatever refreshQuotes brings. */
  quotes: Quote[];
  /**
   * Starts an operation for a chain of requests (an import, a bulk delete). Pass it to every
   * mutation in the chain: once a sign-out or reset outdates it, the next step sends nothing and
   * throws StaleOperationError.
   */
  beginOp: () => StoreOp;
  hydrate: () => Promise<void>;
  /** Mutations throw StaleOperationError, and change nothing, if a sign-out outdated `op` before they finished. */
  addAccount: (
    input: { name: string; type?: string; cashBalance?: number; accountNumber?: string },
    op?: StoreOp,
  ) => Promise<Account>;
  renameAccount: (
    id: string,
    patch: { name?: string; type?: string; accountNumber?: string | null },
    op?: StoreOp,
  ) => Promise<void>;
  setCash: (id: string, cashBalance: number, op?: StoreOp) => Promise<void>;
  removeAccount: (id: string, op?: StoreOp) => Promise<{ ok: true } | { ok: false; reason: string }>;
  addTransaction: (t: Transaction, op?: StoreOp) => Promise<void>;
  updateTransaction: (
    id: string,
    patch: Partial<Pick<Transaction, 'quantity' | 'pricePerUnit' | 'fees' | 'notes'>>,
    op?: StoreOp,
  ) => Promise<Transaction>;
  removeTransaction: (id: string, op?: StoreOp) => Promise<void>;
  /**
   * Replace every snapshot-tagged (`sourceFingerprint` starts with `pos:`)
   * transaction in `accountId` with the supplied list, in one round-trip.
   * Used by the broker-positions importer ("Pull positions") so re-syncs
   * are idempotent: same broker pull -> same DB state.
   */
  replaceSnapshotPositions: (
    accountId: string,
    txs: Transaction[],
    op?: StoreOp,
  ) => Promise<{ deleted: number; inserted: number }>;
  /** Fetches quotes for `symbols` (an empty list clears them) and caches them. */
  refreshQuotes: (symbols: string[]) => Promise<QuoteRefresh>;
  /** Forget everything loaded from the server (sign-out / ended session). */
  reset: () => void;
}

/** A store holding nothing from the server (start, reset, retire). */
const EMPTY: Pick<PortfolioState,
  'accounts' | 'transactions' | 'hydrated' | 'apiStatus' | 'cacheUpdatedAt' | 'apiError' | 'loadingActions' | 'actionErrors' | 'quotes'> = {
  accounts: [],
  transactions: [],
  hydrated: false,
  apiStatus: 'live',
  cacheUpdatedAt: null,
  apiError: null,
  loadingActions: [],
  actionErrors: {},
  quotes: [],
};

export function createPortfolioStore(tab: PortfolioTab = portfolioTab(browserTabLedger)) {
  const lifecycle = { retire: () => undefined as void };
  const store = create<PortfolioState>((set, get) => portfolioState(tab, set, get, lifecycle));
  return Object.assign(store, {
    /**
     * Retires this store for good, before a newer instance takes over (a hot update): every
     * operation it began is outdated, its data is dropped and it never writes the cache again.
     */
    retire: () => lifecycle.retire(),
  });
}

export type PortfolioStore = ReturnType<typeof createPortfolioStore>;

export const usePortfolioStore = createPortfolioStore();
onPageRetired(() => usePortfolioStore.retire());

/** This module's hot-update dispose: retires the page (this store included) before anything else. */
export function retirePortfolioModule(): void {
  retirePage();
  usePortfolioStore.retire();
}

// Never hot-swapped (apps/web/hmrReload.ts): a second store would run next to this one, and the
// auth store would reset only one of them. An update retires the page and reloads it instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => retirePortfolioModule());
  import.meta.hot.accept(() => window.location.reload());
}

function portfolioState(
  tab: PortfolioTab,
  set: Parameters<StateCreator<PortfolioState>>[0],
  get: Parameters<StateCreator<PortfolioState>>[1],
  lifecycle: { retire: () => void },
): PortfolioState {
  // From now on only this store may write cached server data into this tab's storage.
  const writer = claimCacheWriter(tab.storage);
  const cached = loadPortfolioCache(tab) ?? { accounts: [], transactions: [] };
  let hydration: Promise<void> | null = null;
  // Bumped by reset(): every operation that began before it is outdated.
  let generation = 0;
  // Set once by retire(): outdates every operation, now and later.
  let retired = false;
  const beginOp = () => beginStoreOp(tab.ledger, () => (retired ? null : generation));
  lifecycle.retire = () => {
    retired = true;
    hydration = null;
    set(EMPTY);
  };

  /** Cache writes are tagged with the sign-outs the operation began with, and only while it is current. */
  const writeCache = (op: StoreOp, key: string, data: object): void => {
    if (retired || op.signOuts === null || !op.current()) return;
    writeCachedServerData(tab.storage, key, data, op.signOuts, writer);
  };

  /**
   * Applies a change to accounts and transactions, and caches the result, only while `op` is
   * current. Throws StaleOperationError otherwise. The cache is written only once a hydrate has
   * brought live data: before that the store may hold nothing but the copy it started from.
   */
  const commitData = (op: StoreOp, change: (state: PersistedState) => PersistedState): void => {
    const applied = op.commit(() => {
      const { accounts, transactions, hydrated } = get();
      const next = change({ accounts, transactions });
      set(next);
      if (hydrated) writeCache(op, PORTFOLIO_CACHE_KEY, next);
    });
    if (!applied) throw new StaleOperationError();
  };

  const beginAction = (actionId: string) => {
    set((state) => {
      const actionErrors = { ...state.actionErrors };
      delete actionErrors[actionId];
      return {
        loadingActions: state.loadingActions.includes(actionId)
          ? state.loadingActions
          : [...state.loadingActions, actionId],
        actionErrors,
      };
    });
  };

  const endAction = (actionId: string) => {
    set((state) => ({
      loadingActions: state.loadingActions.filter((id) => id !== actionId),
    }));
  };

  const failAction = (actionId: string, action: string, err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    set((state) => ({
      loadingActions: state.loadingActions.filter((id) => id !== actionId),
      actionErrors: {
        ...state.actionErrors,
        [actionId]: { action, error, timestamp: Date.now() },
      },
    }));
  };

  /** A mutation's loading and error bookkeeping, every piece of it through `op`. */
  const withAction = async <T>(op: StoreOp, actionId: string, action: string, fn: () => Promise<T>): Promise<T> => {
    // A chain whose session ended sends nothing more.
    if (!op.commit(() => beginAction(actionId))) throw new StaleOperationError();
    try {
      const result = await fn();
      op.commit(() => endAction(actionId));
      return result;
    } catch (err) {
      op.commit(() => failAction(actionId, action, err));
      throw err;
    }
  };

  return {
    ...EMPTY,
    ...cached,
    quotes: loadQuoteCache(tab),
    isLoading: (actionId) => get().loadingActions.includes(actionId),
    getActionError: (actionId) => get().actionErrors[actionId]?.error ?? null,
    clearActionError: (actionId) => {
      set((state) => {
        const actionErrors = { ...state.actionErrors };
        delete actionErrors[actionId];
        return { actionErrors };
      });
    },
    beginOp,

    hydrate: () => {
      if (hydration) return hydration;
      const op = beginOp();
      const run = async () => {
        try {
          const [accountsRes, transactionsRes] = await Promise.all([
            api<{ accounts: Account[] }>('/accounts'),
            api<{ transactions: Transaction[] }>('/transactions'),
          ]);
          op.commit(() => {
            const next: PersistedState = {
              accounts: accountsRes.accounts,
              transactions: transactionsRes.transactions,
            };
            set({ ...next, hydrated: true, apiStatus: 'live', apiError: null, cacheUpdatedAt: Date.now() });
            writeCache(op, PORTFOLIO_CACHE_KEY, next);
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          op.commit(() => {
            console.warn('[portfolio] hydrate failed; using cached state', err);
            // Surface failure to the UI: persistent banner + writes disabled. Not `hydrated`:
            // what is shown is still the copy the store started from, if any.
            set({ apiStatus: 'cache', apiError: msg });
          });
        }
      };
      const promise: Promise<void> = run().finally(() => {
        // After a reset, a newer hydrate may already own the slot.
        if (hydration === promise) hydration = null;
      });
      hydration = promise;
      return promise;
    },

    addAccount: ({ name, type, cashBalance = 0, accountNumber }, op = beginOp()) => {
      const draftId = makeId('acc');
      return withAction(op, `addAccount:${draftId}`, 'addAccount', async () => {
        assertLive(get().apiStatus);
        const draft: Account = {
          id: draftId,
          name: name.trim() || 'Account',
          type,
          cashBalance,
          currency: 'USD',
          accountNumber: accountNumber && accountNumber.trim() ? accountNumber.trim() : undefined,
        };
        const created = await api<Account>('/accounts', { method: 'POST', body: draft });
        commitData(op, (state) => ({ ...state, accounts: [...state.accounts, created] }));
        return created;
      });
    },

    renameAccount: (id, patch, op = beginOp()) => withAction(op, `renameAccount:${id}`, 'renameAccount', async () => {
      assertLive(get().apiStatus);
      const updated = await api<Account>(`/accounts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      commitData(op, (state) => ({ ...state, accounts: state.accounts.map((a) => (a.id === id ? updated : a)) }));
    }),

    setCash: (id, cashBalance, op = beginOp()) => withAction(op, `setCash:${id}`, 'setCash', async () => {
      assertLive(get().apiStatus);
      const next = Number.isFinite(cashBalance) ? cashBalance : 0;
      const updated = await api<Account>(`/accounts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { cashBalance: next },
      });
      commitData(op, (state) => ({ ...state, accounts: state.accounts.map((a) => (a.id === id ? updated : a)) }));
    }),

    removeAccount: (id, op = beginOp()) => withAction(op, `removeAccount:${id}`, 'removeAccount', async () => {
      assertLive(get().apiStatus);
      // DELETE returns 204 on success, 4xx on refusal — don't throw, surface the reason.
      const res = await apiFetch(`/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.status === 204) {
        commitData(op, (state) => ({ ...state, accounts: state.accounts.filter((a) => a.id !== id) }));
        return { ok: true } as const;
      }
      let reason = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) reason = body.error;
      } catch {
        /* ignore */
      }
      return { ok: false, reason } as const;
    }),

    addTransaction: (t, op = beginOp()) => withAction(op, `addTransaction:${t.id}`, 'addTransaction', async () => {
      assertLive(get().apiStatus);
      const created = await api<Transaction>(
        `/accounts/${encodeURIComponent(t.accountId)}/transactions`,
        { method: 'POST', body: t },
      );
      commitData(op, (state) => ({ ...state, transactions: [...state.transactions, created] }));
    }),

    updateTransaction: (id, patch, op = beginOp()) => withAction(op, `updateTransaction:${id}`, 'updateTransaction', async () => {
      assertLive(get().apiStatus);
      const updated = await api<Transaction>(`/transactions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      commitData(op, (state) => ({ ...state, transactions: state.transactions.map((t) => (t.id === id ? updated : t)) }));
      return updated;
    }),

    removeTransaction: (id, op = beginOp()) => withAction(op, `removeTransaction:${id}`, 'removeTransaction', async () => {
      assertLive(get().apiStatus);
      const res = await apiFetch(`/transactions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.status !== 204 && res.status !== 404) {
        throw new Error(`delete failed: ${res.status} ${res.statusText}`);
      }
      commitData(op, (state) => ({ ...state, transactions: state.transactions.filter((t) => t.id !== id) }));
    }),

    replaceSnapshotPositions: (accountId, txs, op = beginOp()) => (
      withAction(op, `replaceSnapshotPositions:${accountId}`, 'replaceSnapshotPositions', async () => {
        assertLive(get().apiStatus);
        const stamped = txs.map((t) => ({ ...t, accountId }));
        const result = await api<{ ok: true; deleted: number; inserted: number; transactions: Transaction[] }>(
          `/accounts/${encodeURIComponent(accountId)}/snapshot-positions`,
          { method: 'POST', body: { transactions: stamped } },
        );
        // Local-state mirror of the server-side replace: drop the previous
        // pos:* rows for this account, append the new ones.
        commitData(op, (state) => ({
          ...state,
          transactions: [
            ...state.transactions.filter(
              (t) => !(t.accountId === accountId && (t.sourceFingerprint ?? '').startsWith('pos:')),
            ),
            ...result.transactions,
          ],
        }));
        return { deleted: result.deleted, inserted: result.inserted };
      })
    ),

    refreshQuotes: async (symbols) => {
      const op = beginOp();
      if (symbols.length === 0) return op.commit(() => set({ quotes: [] })) ? { status: 'ok' } : { status: 'stale' };
      let next: Quote[];
      try {
        next = await fetchQuotes(symbols);
      } catch (err) {
        // A failure is reported only while the session it belongs to lasts.
        const error = err instanceof Error ? err.message : 'Failed to load quotes';
        let failed = false;
        op.commit(() => { failed = true; });
        return failed ? { status: 'failed', error } : { status: 'stale' };
      }
      const applied = op.commit(() => {
        const quotes = mergeQuotesByRecency(get().quotes, next, symbols);
        set({ quotes });
        writeCache(op, QUOTE_CACHE_KEY, { quotes });
      });
      return applied ? { status: 'ok' } : { status: 'stale' };
    },

    reset: () => {
      generation += 1;
      hydration = null;
      set(EMPTY);
    },
  };
}

/**
 * Throws if the store is in cache-only mode. Mutators call this before
 * issuing the network request so a write that would silently fail (or
 * worse, write to an out-of-date cache) instead surfaces a clear error
 * the form can display. The CacheBanner already disables submit buttons
 * via `apiStatus`, but this guard catches anything that bypasses the
 * banner (e.g. keyboard shortcuts, programmatic calls).
 */
function assertLive(apiStatus: 'live' | 'cache'): void {
  if (apiStatus === 'cache') {
    throw new Error('Server unreachable — writes are disabled. Click "Retry server" to reconnect.');
  }
}
