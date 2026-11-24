import { pageRetired, retirePage, type TabLedger } from '../services/browserCache';

/**
 * One asynchronous operation of a tab's portfolio store, from the request it sends to the state
 * it commits. An answer may arrive after the session it was meant for has ended: the user signed
 * out, another tab did, or the store was reset for any other reason. Every async store update goes
 * through a token so such an answer changes nothing, here or in the cache.
 */
export interface StoreOp {
  /**
   * The sign-outs this tab had accounted for when the operation began (null: its ledger could not
   * be read). Cached copies written by the operation are tagged with these, never the current ones.
   */
  readonly signOuts: readonly string[] | null;
  /** Whether results may still be applied: the store was not reset, and no other sign-out is on record. */
  current(): boolean;
  /** Runs `update` only while the operation is current; returns whether it ran. */
  commit(update: () => void): boolean;
}

/** An operation whose session ended before it could apply its result. */
export class StaleOperationError extends Error {
  constructor() {
    super('Signed out before this change finished. Sign in again to see it.');
    this.name = 'StaleOperationError';
  }
}

/**
 * Starts an operation. `generation` reads the store's reset counter, or null once the store is
 * retired (replaced by a newer instance, e.g. by a hot update); every auth event that ends or
 * replaces a session resets the store (stores/auth.ts forget()). The sign-outs come from the tab's
 * own baseline (TabLedger.known), not from the ledger: a sign-out this tab has not caught up with
 * yet makes the operation stale from its first step.
 */
export function beginStoreOp(tab: TabLedger, generation: () => number | null): StoreOp {
  const started = generation();
  const signOuts = tab.known === null ? null : [...tab.known];
  const current = () => {
    // A retired page (a stateful module is being replaced) commits nothing again.
    if (pageRetired()) return false;
    const now = generation();
    if (started === null || now === null || now !== started) return false;
    const view = tab.ledger.read();
    // Storage that never worked holds no ledger that could outdate the operation.
    if (signOuts === null) return !view.known;
    return view.known && view.ids.every((id) => signOuts.includes(id));
  };
  return {
    signOuts,
    current,
    commit: (update) => {
      if (!current()) {
        // Not reset (or retired) yet, so this tab missed a sign-out: have the auth store catch up.
        if (!pageRetired() && started !== null && generation() === started) tab.onMissedSignOut();
        return false;
      }
      update();
      return true;
    },
  };
}

/** This module's hot-update dispose: retires the page, which outdates every operation. */
export function retireStoreOpModule(): void {
  retirePage();
}

// Never hot-swapped (apps/web/hmrReload.ts): StaleOperationError must stay one class for every
// store. An update retires the page and reloads it instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => retireStoreOpModule());
  import.meta.hot.accept(() => window.location.reload());
}
