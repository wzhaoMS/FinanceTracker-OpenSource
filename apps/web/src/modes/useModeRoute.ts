import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  DEFAULT_ROUTES,
  formatRoute,
  parseRoute,
  readStoredMode,
  resolveRoute,
  routeTitle,
  storeMode,
  type EverydayRoute,
  type InvestingRoute,
  type Mode,
  type ModeRoute,
} from './route';

/** Announces an address change made with pushState/replaceState, which fire no event of their own. */
const ROUTE_EVENT = 'holdr:route';

/**
 * Where each history entry of this visit was left. The browser restores a position on back and forward
 * only against the page as it is at that moment: Spending fetches its rows again when it opens, so it
 * is too short then, and the position was lost. Each entry carries a key in its state; leaving it
 * records where it was, and coming back scrolls there once the page is tall enough.
 */
const ENTRY_KEY = 'holdrEntry';
const leftAt = new Map<string, number>();
const MAX_REMEMBERED = 200;
let entryCount = 0;
let shownEntry: string | null = null;
/** How the shown route was reached: a new entry (a link, a tab, the switch) or a step back or forward. */
let arrivedBy: 'push' | 'step' = 'push';
let stopRestoring: () => void = () => {};
/** How long a return waits for its page to be tall enough; the reader scrolling first ends it sooner. */
const RESTORE_WAIT_MS = 5000;
/** Once there, how long the page must stay still before the place is no longer held. */
const RESTORE_SETTLE_MS = 400;
const READER_SCROLLS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

function entryKey(): string | null {
  const state: unknown = window.history.state;
  if (!state || typeof state !== 'object') return null;
  const key = (state as Record<string, unknown>)[ENTRY_KEY];
  return typeof key === 'string' ? key : null;
}

function newEntryKey(): string {
  entryCount += 1;
  return `${Date.now().toString(36)}.${entryCount}`;
}

/** The shown entry's key, given one first if it has none (the first page, or an address typed by hand). */
function ensureEntryKey(): string {
  const existing = entryKey();
  if (existing) return existing;
  const key = newEntryKey();
  const state: unknown = window.history.state;
  window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), [ENTRY_KEY]: key }, '');
  return key;
}

function rememberShownEntry(): void {
  if (shownEntry === null) return;
  leftAt.delete(shownEntry);
  leftAt.set(shownEntry, window.scrollY);
  if (leftAt.size > MAX_REMEMBERED) leftAt.delete(leftAt.keys().next().value as string);
}

/** Scrolls back to `top` once the page is tall enough, and keeps it there while the rest of the page still loads. */
function restoreWhenReachable(top: number): () => void {
  let stopped = false;
  let settle = 0;
  const attempt = () => {
    if (stopped || document.documentElement.scrollHeight - window.innerHeight < top - 1) return;
    window.scrollTo(0, top);
    // Content above may still arrive and move things: hold the place until the page has been still for a moment.
    window.clearTimeout(settle);
    settle = window.setTimeout(stop, RESTORE_SETTLE_MS);
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(attempt);
  const frame = window.requestAnimationFrame(() => {
    // After the route has rendered and the browser has put back what it could.
    const content = document.querySelector('.app');
    if (content) observer?.observe(content);
    attempt();
  });
  const timer = window.setTimeout(() => stop(), RESTORE_WAIT_MS);
  function stop(): void {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    window.clearTimeout(settle);
    observer?.disconnect();
    for (const type of READER_SCROLLS) window.removeEventListener(type, stop, true);
  }
  for (const type of READER_SCROLLS) window.addEventListener(type, stop, { capture: true, passive: true });
  return stop;
}

/**
 * Back, forward, or an address typed by hand: before the new route renders, while the page is still where it was.
 * Once per entry (popstate and hashchange can both report one step).
 */
function onHistoryStep(): void {
  const key = entryKey();
  if (key !== null && key === shownEntry) return;
  stopRestoring();
  rememberShownEntry();
  shownEntry = key ?? ensureEntryKey();
  arrivedBy = 'step';
  const top = leftAt.get(shownEntry);
  if (top !== undefined && top > 0) stopRestoring = restoreWhenReachable(top);
}

function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStep = () => {
    onHistoryStep();
    onChange();
  };
  window.addEventListener('hashchange', onStep);
  window.addEventListener('popstate', onStep);
  window.addEventListener(ROUTE_EVENT, onChange);
  return () => {
    window.removeEventListener('hashchange', onStep);
    window.removeEventListener('popstate', onStep);
    window.removeEventListener(ROUTE_EVENT, onChange);
  };
}

const currentHash = () => window.location.hash;
const serverHash = () => '';

function writeAddress(hash: string, replace: boolean): void {
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (replace) window.history.replaceState(window.history.state, '', url);
  else {
    stopRestoring();
    rememberShownEntry();
    shownEntry = newEntryKey();
    arrivedBy = 'push';
    window.history.pushState({ [ENTRY_KEY]: shownEntry }, '', url);
  }
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/** The section last shown in each mode during this visit, so switching back returns to it. */
const lastRoutes: { investing: InvestingRoute; everyday: EverydayRoute } = { ...DEFAULT_ROUTES };

/** How long a switch's colour change runs (modes.css); reduced motion skips it there. */
const SWITCH_TRANSITION_MS = 320;

/**
 * Set by a link (or an entry such as Investing's Spending) that takes the page
 * somewhere new: once that route has rendered, the page goes back to its top
 * and focus moves to the new section's tab, as after loading a page. Back and
 * forward return to where the reader was (see `leftAt`) and leave focus alone.
 */
let focusSectionAfterRender = false;

/** The selected tab of whichever mode is showing. */
const SELECTED_SECTION_TAB = '[role="tablist"][aria-label="Sections"] [role="tab"][aria-selected="true"], '
  + '[role="tablist"][aria-label="Spending areas"] [role="tab"][aria-selected="true"]';
/** A dialog open in Everyday's view (all of Spending's dialogs render inside its section). */
const OPEN_EVERYDAY_DIALOG = '.app > .spending [role="dialog"]';

export interface NavigateOptions {
  /** Go to the top and focus the new section's tab once it shows (links and cross-mode entries). */
  focusSection?: boolean;
}

export interface ModeRouter {
  route: ModeRoute;
  /**
   * Everyday's view, from the first time it shows: its section, and a key that changes when Everyday is
   * opened afresh. It stays mounted (hidden) while Investing shows, so a step back or forward finds its
   * month, filters, loaded pages and place as they were; opening Everyday any other way (the switch, a
   * link, Investing's Spending entry) starts it afresh, as opening the Spending tab always did. A view
   * that holds a dialog while hidden is not kept.
   */
  everyday: { route: EverydayRoute; key: number } | null;
  /** Shows a route as a new history entry (back returns to the one before). */
  navigate: (route: ModeRoute, options?: NavigateOptions) => void;
  /** Opens a mode where it was left during this visit (its first section otherwise). */
  switchMode: (mode: Mode) => void;
}

/**
 * The address's hash is the source of truth for the mode and its section.
 * The mode is mirrored to `<html data-mode>` (each mode's palette is scoped
 * there, so dialogs and the page background follow it). The mode last chosen
 * with the switch, its name alone, is kept in localStorage for a bare address.
 */
export function useModeRoute(): ModeRouter {
  const hash = useSyncExternalStore(subscribe, currentHash, serverHash);
  const { route, canonical } = useMemo(() => resolveRoute(hash, readStoredMode(localStore())), [hash]);

  // Spell the route out in the address, in place, so a reload or a bookmark keeps it.
  useLayoutEffect(() => {
    if (!canonical) writeAddress(formatRoute(route), true);
  }, [canonical, route]);

  // The entry shown on arrival (or on signing in again) gets its key, so leaving it records where it was.
  useLayoutEffect(() => {
    shownEntry = ensureEntryKey();
    return () => stopRestoring();
  }, []);

  // Everyday's view: kept across a step back or forward, started afresh on any other way in (see ModeRouter).
  const [everydayView, setEverydayView] = useState(() => ({ key: 0, mounted: route.mode === 'everyday' }));
  const [viewedMode, setViewedMode] = useState<Mode>(route.mode);
  if (route.mode !== viewedMode) {
    setViewedMode(route.mode);
    if (route.mode === 'everyday' && (arrivedBy === 'push' || !everydayView.mounted)) {
      setEverydayView({ key: everydayView.key + 1, mounted: true });
    }
  }
  const everyday = everydayView.mounted
    ? { route: route.mode === 'everyday' ? route : lastRoutes.everyday, key: everydayView.key }
    : null;

  // A dialog open in the hidden view (back or forward was used while it was open, or an answer that arrives
  // after leaving opens one, say "Confirm it's you") would keep its document-level keyboard handling, and
  // some trap Tab, in Investing. Such a view is let go instead of kept; Everyday opens afresh next time.
  // First checked once the event that left has finished, so a link that closes its dialog on the way out
  // (the cash-ledger link) keeps the view; then watched for as long as the view stays hidden.
  useEffect(() => {
    if (route.mode !== 'investing' || !everydayView.mounted) return undefined;
    const holdsDialog = () => document.querySelector(OPEN_EVERYDAY_DIALOG) !== null;
    const letGo = () => setEverydayView((view) => (view.mounted ? { ...view, mounted: false } : view));
    let watcher: MutationObserver | null = null;
    const timer = window.setTimeout(() => {
      if (holdsDialog()) {
        letGo();
        return;
      }
      const view = document.querySelector('.app > .spending');
      if (!view || typeof MutationObserver === 'undefined') return;
      watcher = new MutationObserver(() => { if (holdsDialog()) letGo(); });
      watcher.observe(view, { childList: true, subtree: true });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      watcher?.disconnect();
    };
  }, [route.mode, everydayView.mounted]);

  // Before paint, so a mode never shows in the other's colours. Removed on unmount
  // (sign-out), so the sign-in screen keeps the app's default look. A change of mode
  // (not the first render) marks <html> for a short colour transition.
  const shownMode = useRef<Mode | null>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = route.mode;
    const changed = shownMode.current !== null && shownMode.current !== route.mode;
    shownMode.current = route.mode;
    if (!changed) return () => { delete root.dataset.mode; };
    root.classList.add('mode-switching');
    const timer = window.setTimeout(() => root.classList.remove('mode-switching'), SWITCH_TRANSITION_MS);
    return () => {
      window.clearTimeout(timer);
      root.classList.remove('mode-switching');
      delete root.dataset.mode;
    };
  }, [route.mode]);

  useEffect(() => {
    if (route.mode === 'investing') lastRoutes.investing = route;
    else lastRoutes.everyday = route;
    document.title = routeTitle(route);
    if (!focusSectionAfterRender) return;
    focusSectionAfterRender = false;
    window.scrollTo({ top: 0, left: 0 });
    // The shown mode's tab: a kept Everyday view is in the page too, hidden.
    Array.from(document.querySelectorAll<HTMLElement>(SELECTED_SECTION_TAB))
      .find((tab) => tab.getClientRects().length > 0)
      ?.focus({ preventScroll: true });
  }, [route]);
  // Signed out (the dashboard unmounts): back to the app's plain title.
  useEffect(() => () => { document.title = 'Holdr'; }, []);

  const navigate = useCallback((next: ModeRoute, options?: NavigateOptions) => {
    const target = formatRoute(next);
    if (target === window.location.hash) return;
    if (options?.focusSection) focusSectionAfterRender = true;
    writeAddress(target, false);
  }, []);
  // Only a choice made with the switch is remembered: a link or Investing's Spending entry
  // visits Everyday without changing where a bare address opens.
  const switchMode = useCallback((mode: Mode) => {
    storeMode(localStore(), mode);
    navigate(lastRoutes[mode]);
  }, [navigate]);

  // In-app links (`#/everyday/…`, `#/investing/…`) navigate like the app's own entries. Captured before
  // components see the click: a dialog that stops propagation must not leave its link to the browser alone.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#/"]') : null;
      if (!link || (link.target && link.target !== '_self')) return;
      const next = parseRoute(link.getAttribute('href') ?? '');
      if (!next) return;
      event.preventDefault();
      navigate(next, { focusSection: true });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [navigate]);

  return { route, everyday, navigate, switchMode };
}
