import { create } from 'zustand';

import { apiFetch, cancelEarlierRequests, onAuthFailure, startSessionEpoch } from '../services/api';
import {
  UNKNOWN_LEDGER,
  browserTabLedger,
  clearCachedFinancialData,
  isLedgerKey,
  newSignOutId,
  retirePage,
  signOutBeganBetween,
  storage as browserStorage,
  type LedgerView,
  type TabLedger,
} from '../services/browserCache';
import { clearSymbolHistoryCache } from '../services/symbolHistoryCache';
import { usePortfolioStore, type PortfolioStore } from './portfolio';

/**
 * Who is signed in, as far as the browser knows.
 *
 *   checking        GET /auth/me in flight (nothing rendered yet)
 *   signed-in       session cookie accepted
 *   signed-out      sign-in form
 *   setup-required  sign-in form with "create a user on the server" help
 *   signing-out     the user signed out; data is already hidden, but the
 *                   server has not yet confirmed the session is gone
 *   offline         the server could not be reached; the app shows the
 *                   read-only cache until the server answers again
 *
 * Any 401 from the API (reported by services/api.ts) ends the session in
 * the UI: cached server data is wiped and the sign-in form appears. Only a
 * 401 for a request sent in the current session epoch counts: one that
 * answers a request sent before this tab began a sign-in or a sign-out, or
 * before a session ended, is ignored, so that 401 cannot end a newer session
 * (its cookie could: see cancelEarlierRequests in services/api.ts).
 *
 * Sign-out is only complete once POST /auth/logout succeeded AND /auth/me
 * no longer accepts the browser's cookie. Until then its record in the
 * shared sign-out ledger (services/browserCache.ts, one record per
 * sign-out) stays pending. The record survives reloads, every start
 * retries the revocation first, and /auth/me is never allowed to restore
 * the dashboard.
 *
 * Answers arrive late, and so do other tabs' storage events (or never), so
 * every decision re-reads the ledger from storage instead of trusting events:
 *  - Before any session check, and whenever the tab is shown again
 *    (pageshow, visibilitychange) or hears from another tab, the tab
 *    catches up: if the ledger names a sign-out it has not accounted for,
 *    its server data goes first, whatever the network then says.
 *  - A /auth/me answer is dropped, success or failure, if a sign-out is
 *    pending, if one began after the request was sent, or if this tab saw
 *    another auth event since: a sign-in, a session ended by a 401, a sign-out.
 *  - A sign-in whose answer arrives after any tab began a sign-out lost: its
 *    new session is revoked by a sign-out of its own. Otherwise it settles
 *    the sign-outs that were pending when it began, and only those.
 *  - A confirmed revocation settles the sign-outs on record when it began,
 *    and only those; a newer one waits for its own confirmation.
 *  - Storage that cannot be read, or written when a session would be
 *    trusted, never means "no sign-out": the browser then ends any saved
 *    session instead of reopening it, and the user signs in by hand.
 */

export type AuthStatus = 'checking' | 'signed-in' | 'signed-out' | 'setup-required' | 'signing-out' | 'offline';

interface AuthState {
  status: AuthStatus;
  username: string | null;
  /** Shown above the sign-in form, e.g. after the session expired. */
  notice: string | null;
  /** Why the last attempt to end the server session failed (status 'signing-out'). */
  signOutError: string | null;
  /** A revocation request is in flight. */
  signOutBusy: boolean;
  /** Why this browser cannot keep its sign-out record (storage full or blocked). */
  storageWarning: string | null;
  check: () => Promise<void>;
  /** Resolves when signed in; rejects with a user-facing message. */
  signIn: (username: string, password: string) => Promise<void>;
  /** Hides all data at once, then ends the server session (see retrySignOut). */
  signOut: () => Promise<void>;
  retrySignOut: () => Promise<void>;
}

export const SESSION_ENDED_NOTICE = 'Your session has ended. Sign in again.';
export const SIGN_OUT_UNRECORDED = 'This browser could not save the sign-out (its storage is full or blocked). '
  + 'Keep this page open until the server confirms it; Holdr keeps retrying.';
export const STORAGE_UNUSABLE = 'This browser\'s storage for Holdr is full or blocked, so it cannot remember a sign-out. '
  + 'Holdr ends a saved session instead of reopening it: sign in each time until the storage works again.';
const UNREACHABLE = 'The Holdr server could not be reached.';

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

type Revocation = { ok: true; setupRequired: boolean } | { ok: false; reason: string };

/** Ends the server session and proves the browser's cookie no longer authenticates. */
async function revokeServerSession(): Promise<Revocation> {
  let logout: Response;
  try {
    logout = await apiFetch('/auth/logout', { method: 'POST' }, { authCheck: false });
  } catch {
    return { ok: false, reason: UNREACHABLE };
  }
  if (!logout.ok) return { ok: false, reason: `The server did not end the session (HTTP ${logout.status}).` };
  let me: Response;
  try {
    me = await apiFetch('/auth/me', {}, { authCheck: false });
  } catch {
    return { ok: false, reason: UNREACHABLE };
  }
  if (me.status === 401) return { ok: true, setupRequired: Boolean((await readJson(me)).setupRequired) };
  return {
    ok: false,
    reason: me.ok ? 'The server still accepts this browser\'s session.' : `The server could not confirm it (HTTP ${me.status}).`,
  };
}

/** What a store needs from its browser tab. Tests use it to simulate several tabs. */
export interface AuthTab {
  /** localStorage as this tab sees it (shared by every tab of the origin). */
  storage: () => Storage | null;
  /** This tab's view of the sign-out ledger, shared with its portfolio store. */
  ledger: TabLedger;
  /** This tab's portfolio store. */
  portfolio: PortfolioStore;
  /**
   * Calls `listener` when another tab changed localStorage (the 'storage' event; key null =
   * cleared). Returns a function that removes the listener.
   */
  onStorageChange: (listener: (key: string | null) => void) => () => void;
  /**
   * Calls `listener` when the page is shown again: pageshow (back/forward cache or not),
   * visibilitychange to visible. Returns a function that removes the listener.
   */
  onResume: (listener: () => void) => () => void;
}

const browserTab: AuthTab = {
  storage: browserStorage,
  ledger: browserTabLedger,
  portfolio: usePortfolioStore,
  onStorageChange: (listener) => {
    if (typeof window === 'undefined') return () => undefined;
    const onStorage = (event: StorageEvent) => listener(event.key);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  },
  onResume: (listener) => {
    const onPageShow = () => listener();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') listener();
    };
    if (typeof window !== 'undefined') window.addEventListener('pageshow', onPageShow);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('pageshow', onPageShow);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  },
};

function ledgerSignature(view: LedgerView): string {
  return view.known ? `${[...view.ids].sort().join(',')}|${[...view.pending].sort().join(',')}` : '?';
}

export function createAuthStore(tab: AuthTab = browserTab) {
  const lifecycle = { retire: () => undefined as void };
  const store = create<AuthState>((set, get) => {
    const { ledger } = tab.ledger;
    /** Set once by retire(): this store no longer reacts to anything. */
    let retired = false;
    /** Bumped by every auth event in this tab that an older answer must not override. */
    let generation = 0;
    /**
     * An auth event that leaves the session this tab had: older answers lose their say, and so do
     * the 401s of requests sent before it (a new session epoch, services/api.ts).
     */
    const authEvent = () => {
      generation += 1;
      startSessionEpoch();
    };
    /** This tab's sign-outs whose record storage refused: it keeps revoking until the server confirms. */
    const unrecorded = new Set<string>();
    let checking: { generation: number; ledger: string; promise: Promise<void> } | null = null;
    let revoking: Promise<void> | null = null;

    const forget = () => {
      clearCachedFinancialData(tab.storage);
      clearSymbolHistoryCache();
      tab.portfolio.getState().reset();
    };

    /** Drops this tab's server data. A tab holding none has accounted for every sign-out on record. */
    const forgetAll = () => {
      forget();
      const view = ledger.read();
      tab.ledger.known = view.known ? new Set(view.ids) : null;
    };

    /**
     * Catches up with sign-outs this tab missed (their storage events arrive late, or never):
     * a record this tab has not accounted for, or a ledger that can no longer be read, drops
     * this tab's server data before anything else is decided. Returns whether it did.
     */
    const reconcile = (view: LedgerView): boolean => {
      const known = tab.ledger.known;
      let missed: boolean;
      if (!view.known) missed = known !== null;
      else if (known === null) missed = view.ids.length > 0;
      else missed = view.ids.some((id) => !known.has(id));
      if (!missed) return false;
      authEvent();
      forget();
      tab.ledger.known = view.known ? new Set(view.ids) : null;
      return true;
    };

    const showing = () => {
      const { status } = get();
      return status === 'signed-in' || status === 'offline' || status === 'checking';
    };

    /** All data goes at once; older answers lose their say; the sign-in screen waits for the server. */
    const hide = () => {
      authEvent();
      forgetAll();
      set({ status: 'signing-out', username: null, notice: null });
    };

    const endSession = (status: 'signed-out' | 'setup-required', notice: string | null) => {
      authEvent();
      forgetAll();
      set({ status, username: null, notice, signOutError: null });
    };

    const recordSignOut = (id: string): boolean => {
      if (ledger.record(id)) return true;
      // Make room: the cache (normally gone already) and day-old records are all that can go.
      clearCachedFinancialData(tab.storage);
      ledger.prune();
      return ledger.record(id);
    };

    /** Starts a sign-out in this tab: data first (evicting the cache also frees storage), then its record. */
    const startSignOut = () => {
      hide();
      const id = newSignOutId();
      if (recordSignOut(id)) {
        tab.ledger.known?.add(id);
      } else {
        unrecorded.add(id);
        set({ storageWarning: SIGN_OUT_UNRECORDED });
      }
      set({ signOutError: null });
    };

    const finishSignOut = (): Promise<void> => {
      if (revoking) return revoking;
      revoking = (async () => {
        set({ signOutBusy: true });
        // Storage may have room by now for what this tab carries.
        for (const id of [...unrecorded]) {
          if (!recordSignOut(id)) continue;
          unrecorded.delete(id);
          tab.ledger.known?.add(id);
        }
        if (unrecorded.size === 0 && get().storageWarning === SIGN_OUT_UNRECORDED) set({ storageWarning: null });
        // What this revocation can confirm: the sign-outs on record now, and the ones this tab carries.
        const covered = ledger.read();
        const coveredPending = covered.known ? covered.pending : [];
        const carried = [...unrecorded];
        const result = await revokeServerSession();
        if (get().status !== 'signing-out') return; // signed in again meanwhile (that rotated the session)
        if (!result.ok) {
          set({ signOutError: result.reason });
          return;
        }
        const settled = ledger.settle(coveredPending);
        for (const id of carried) unrecorded.delete(id);
        ledger.prune();
        const after = ledger.read();
        if (unrecorded.size > 0 || (after.known && after.pending.some((id) => !coveredPending.includes(id)))) {
          // A newer sign-out still waits for its own confirmation; the retry loop gets to it.
          set({ signOutError: null });
          return;
        }
        // Storage that could not record this, or cannot be written now, makes every later start
        // end the session instead of reopening it: fail closed, but say why.
        const usable = settled && covered.known && after.known && ledger.writable();
        set({
          status: result.setupRequired ? 'setup-required' : 'signed-out',
          signOutError: null,
          notice: null,
          storageWarning: usable ? null : STORAGE_UNUSABLE,
        });
      })().finally(() => {
        revoking = null;
        set({ signOutBusy: false });
      });
      return revoking;
    };

    const stopAuthFailures = onAuthFailure((failure) => {
      if (retired) return;
      const { status } = get();
      if (status === 'signing-out') return;
      if (failure === 'setup-required') {
        if (status !== 'setup-required') endSession('setup-required', null);
        return;
      }
      if (status === 'signed-in' || status === 'offline') endSession('signed-out', SESSION_ENDED_NOTICE);
    });

    /** Brings this tab in line with the ledger, which another tab may have changed. */
    const follow = () => {
      if (retired) return;
      const view = ledger.read();
      const missed = reconcile(view);
      const pending = view.known && view.pending.length > 0;
      if (missed || pending) {
        // A tab showing data (or about to) hides it; any tab drops answers from before.
        if (showing()) {
          hide();
          // Unreadable storage: nobody can tell this tab whether to stop, so it ends the session itself.
          if (!view.known) void finishSignOut();
        } else {
          authEvent();
        }
      }
      // Confirmed elsewhere, or another tab signed in again: ask the server which.
      if (get().status === 'signing-out' && view.known && !pending && unrecorded.size === 0) void get().check();
    };

    // Storage events arrive late, possibly after further changes: act on what storage holds now.
    const stopStorage = tab.onStorageChange((key) => {
      if (key === null || isLedgerKey(key)) follow();
    });
    const stopResume = tab.onResume(follow);
    const onMissedSignOut = () => queueMicrotask(follow);
    tab.ledger.onMissedSignOut = onMissedSignOut;

    lifecycle.retire = () => {
      retired = true;
      stopAuthFailures();
      stopStorage();
      stopResume();
      if (tab.ledger.onMissedSignOut === onMissedSignOut) tab.ledger.onMissedSignOut = () => undefined;
    };

    /** A sign-in answered after a later sign-out began: it lost, and its new session is ended too. */
    const endLateSession = async () => {
      // A revocation already in flight may have used the cookie from before this sign-in.
      if (revoking) await revoking;
      startSignOut();
      await finishSignOut();
    };

    /** The ledger as a decision to trust the session needs it: unknown unless storage can also be written. */
    const decisionView = (): LedgerView => {
      const view = ledger.read();
      if (!view.known || ledger.writable()) return view;
      // Full storage: the disposable cache is what fills it.
      clearCachedFinancialData(tab.storage);
      return ledger.writable() ? ledger.read() : UNKNOWN_LEDGER;
    };

    const runCheck = async (started: number, before: LedgerView) => {
      if (!before.known || before.pending.length > 0 || unrecorded.size > 0) {
        // A sign-out is pending, or storage cannot say: never let a cookie that may still be valid sign this browser in.
        hide();
        if (!before.known) set({ storageWarning: STORAGE_UNUSABLE });
        await finishSignOut();
        return;
      }
      // Anything newer outranks this answer: another auth event in this tab, or a sign-out that
      // any tab started (and maybe finished) since the request was sent.
      const superseded = () => {
        const after = ledger.read();
        return started !== generation || signOutBeganBetween(before, after) || !after.known
          || after.pending.length > 0 || unrecorded.size > 0;
      };
      let res: Response;
      let body: Record<string, unknown>;
      try {
        res = await apiFetch('/auth/me', {}, { authCheck: false });
        body = await readJson(res);
      } catch {
        if (superseded()) follow();
        else set({ status: 'offline' });
        return;
      }
      if (superseded()) {
        follow();
        return;
      }
      if (res.ok) {
        const user = body.user as { username?: string } | undefined;
        set({ status: 'signed-in', username: user?.username ?? null, notice: null, storageWarning: null });
      } else if (res.status === 401) {
        endSession(body.setupRequired ? 'setup-required' : 'signed-out', get().notice);
      } else {
        set({ status: 'offline' });
      }
    };

    return {
      status: 'checking',
      username: null,
      notice: null,
      signOutError: null,
      signOutBusy: false,
      storageWarning: null,

      check: () => {
        // Before any network or cache decision: catch up with sign-outs this tab missed.
        const before = decisionView();
        if (reconcile(before) && showing()) hide();
        // Join a check only if nothing happened since it started, here or in the ledger.
        const signature = ledgerSignature(before);
        if (checking && checking.generation === generation && checking.ledger === signature) return checking.promise;
        const started = generation;
        const promise = runCheck(started, before).finally(() => {
          if (checking?.promise === promise) checking = null;
        });
        checking = { generation: started, ledger: signature, promise };
        return promise;
      },

      signIn: async (username, password) => {
        // The new session's epoch starts with this request, not with its answer: requests sent until
        // now carry the session it replaces (their 401s no longer count, and those still unanswered
        // are cancelled, so no answer of theirs can follow the new session's cookie), while the
        // browser may hold the new cookie before this code sees the answer, so a 401 for anything sent
        // from now on must still end the session. A sign-in that fails changes no session the page shows.
        startSessionEpoch();
        cancelEarlierRequests();
        // Read from storage, not from events: another tab's sign-out may not have reached this tab yet.
        const before = ledger.read();
        const carried = [...unrecorded];
        const res = await apiFetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }, { authCheck: false });
        const body = await readJson(res);
        if (res.ok) {
          if (signOutBeganBetween(before, ledger.read())) {
            // A tab started a sign-out after this sign-in began; that sign-out wins.
            await endLateSession();
            return;
          }
          // An auth event: older answers lose their say (the session epoch started with the request).
          generation += 1;
          // The server ended the session this browser presented, so the sign-outs pending when this
          // sign-in began are done. Later ones are not touched (and would have outranked it).
          const settled = before.known ? ledger.settle(before.pending) : true;
          for (const id of carried) unrecorded.delete(id);
          // A different household member may sign in on this browser; start clean.
          forgetAll();
          const user = body.user as { username?: string } | undefined;
          set({
            status: 'signed-in',
            username: user?.username ?? username.trim().toLowerCase(),
            notice: null,
            signOutError: null,
            storageWarning: settled ? null : STORAGE_UNUSABLE,
          });
          return;
        }
        if (res.status === 503 && body.setupRequired) {
          if (get().status !== 'signing-out') set({ status: 'setup-required' });
          throw new Error('Create a user on the server first (see above).');
        }
        // 401 and 429 come after the server's "any users?" check, so users exist by now.
        if ((res.status === 401 || res.status === 429) && get().status === 'setup-required') set({ status: 'signed-out' });
        if (res.status === 401) throw new Error('Invalid username or password');
        if (res.status === 429) throw new Error(String(body.error ?? 'Too many sign-in attempts. Try again later.'));
        if (res.status === 403) {
          throw new Error('This address is not allowed to sign in. Open Holdr at one of its configured addresses (WEB_ORIGIN).');
        }
        throw new Error(res.status >= 500 ? 'The Holdr server is unreachable. Try again shortly.' : `Sign-in failed (${res.status})`);
      },

      signOut: async () => {
        startSignOut();
        await finishSignOut();
      },

      retrySignOut: () => {
        if (get().status !== 'signing-out') return Promise.resolve();
        // Nothing pending any more: another tab confirmed the sign-out or signed in again. Ask the server.
        const view = ledger.read();
        if (view.known && view.pending.length === 0 && unrecorded.size === 0) return get().check();
        return finishSignOut();
      },
    };
  });
  return Object.assign(store, {
    /**
     * Retires this store for good, before a newer instance takes over (a hot update): its storage,
     * pageshow and visibilitychange listeners and its 401 hook are removed, and it reacts to nothing.
     */
    retire: () => lifecycle.retire(),
  });
}

export const useAuthStore = createAuthStore();

/**
 * This module's hot-update dispose. The page retires first (no operation commits and no cache is
 * written again, and the page reloads); only then does the auth store drop its hooks.
 */
export function retireAuthModule(store: ReturnType<typeof createAuthStore> = useAuthStore): void {
  retirePage();
  store.retire();
}

// Never hot-swapped (apps/web/hmrReload.ts): a second auth store would end sessions in its own
// portfolio store only. An update retires the page and reloads it instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => retireAuthModule());
  import.meta.hot.accept(() => window.location.reload());
}
