import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { heldSymbolsAcrossAccounts, type Quote } from '@finance-tracker/shared';

import { api } from './services/api';
import { usePortfolioStore } from './stores/portfolio';
import { useAuthStore } from './stores/auth';
import { AddTransactionForm } from './components/AddTransactionForm';
import { TransactionList } from './components/TransactionList';
import { PortfolioBreakdown } from './components/PortfolioBreakdown';
import { AccountsManager } from './components/AccountsManager';
import { ImportPanel } from './components/ImportPanel';
import { SpendingPanel } from './components/spending/SpendingPanel';
import { GoldPage } from './components/gold/GoldPage';
import { LoginScreen } from './components/LoginScreen';
import { TickerBanner } from './components/TickerBanner';
import { HoldrMark, Lock, RefreshCw, Clock } from './components/icons';
import { quoteBadge } from './components/quoteStatus';
import { Tabs } from './components/Tabs';
import { ModeSwitch } from './components/ModeSwitch';
import { DEFAULT_ROUTES, type AmazonView, type EverydayArea, type InvestingTab } from './modes/route';
import { useModeRoute } from './modes/useModeRoute';

const AUTO_REFRESH_MS = 60_000;

/**
 * Sign-in gate. Nothing renders until GET /auth/me answers, and any later
 * 401 returns here. Only when the server cannot be reached at all does the
 * dashboard open on this browser's read-only cache (writes stay disabled).
 */
export function App() {
  const status = useAuthStore((s) => s.status);
  const check = useAuthStore((s) => s.check);

  useEffect(() => { void check(); }, [check]);

  // Server unreachable at boot: the dashboard shows the read-only cache.
  // Keep asking so the session is confirmed (or ended) once it is back.
  useEffect(() => {
    if (status !== 'offline') return undefined;
    const timer = setInterval(() => { void check(); }, 30_000);
    return () => clearInterval(timer);
  }, [status, check]);

  if (status === 'checking') return <div className="auth-splash" aria-busy="true" />;
  if (status === 'signed-out' || status === 'setup-required' || status === 'signing-out') return <LoginScreen />;
  return <Dashboard />;
}

function Dashboard() {
  // The address names the mode (Investing or Everyday) and its section: see modes/route.ts.
  const { route, everyday, navigate, switchMode } = useModeRoute();
  const mode = route.mode;
  const tab = route.mode === 'investing' ? route.tab : null;
  const setTab = useCallback((next: InvestingTab) => navigate({ mode: 'investing', tab: next }), [navigate]);
  const setArea = useCallback((area: EverydayArea) => navigate({ mode: 'everyday', area }), [navigate]);
  const setAmazonView = useCallback((view: AmazonView | null) => navigate(view
    ? { mode: 'everyday', area: 'amazon', amazonView: view } : { mode: 'everyday', area: 'amazon' }), [navigate]);
  // The Gold page's "Open in Card transactions": Everyday's card transactions, which open on the charge it asked for.
  const openCardTransactions = useCallback(() => navigate({ mode: 'everyday', area: 'transactions' }), [navigate]);
  const username = useAuthStore((s) => s.username);
  const authStatus = useAuthStore((s) => s.status);
  const checkSession = useAuthStore((s) => s.check);
  const signOut = useAuthStore((s) => s.signOut);
  const accounts = usePortfolioStore((s) => s.accounts);
  const transactions = usePortfolioStore((s) => s.transactions);
  const hydrate = usePortfolioStore((s) => s.hydrate);
  const apiStatus = usePortfolioStore((s) => s.apiStatus);
  const apiError = usePortfolioStore((s) => s.apiError);
  const loadingActions = usePortfolioStore((s) => s.loadingActions);
  const actionErrors = usePortfolioStore((s) => s.actionErrors);
  const clearActionError = usePortfolioStore((s) => s.clearActionError);
  const cacheUpdatedAt = usePortfolioStore((s) => s.cacheUpdatedAt);
  const quotes = usePortfolioStore((s) => s.quotes);
  const refreshQuotes = usePortfolioStore((s) => s.refreshQuotes);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setHydrated] = useState(false);
  const [snapshotInfo, setSnapshotInfo] = useState<SnapshotInfo | null>(null);
  const latestActionError = useMemo(
    () => Object.entries(actionErrors)
      .map(([id, error]) => ({ id, error }))
      .sort((a, b) => b.error.timestamp - a.error.timestamp)[0] ?? null,
    [actionErrors],
  );

  // Pull saved state from the API once at boot (cross-browser persistence).
  useEffect(() => {
    let cancelled = false;
    hydrate().finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [hydrate]);

  const symbols = useMemo(
    () => heldSymbolsAcrossAccounts(transactions),
    [transactions],
  );
  const activeQuotes = useMemo(() => {
    const held = new Set(symbols);
    return quotes.filter((quote) => held.has(quote.symbol));
  }, [quotes, symbols]);
  // Stable join key for effect deps + a ref so the auto-refresh tick
  // always reads the latest symbol list without re-creating the timer.
  const symbolsKey = symbols.join(',');
  const symbolsRef = useRef(symbols);
  useEffect(() => { symbolsRef.current = symbols; }, [symbolsKey, symbols]);

  // Single quote-refresh entry point used by:
  //   - the symbol-list change effect (initial load + when txs change)
  //   - the periodic auto-refresh tick
  //   - the manual "Refresh quotes" button
  // Kept as useCallback so the auto-refresh effect's dependency stays stable.
  // The store applies (and caches) quotes only while the session they were fetched for lasts.
  const refresh = useCallback(async () => {
    const syms = symbolsRef.current;
    if (syms.length === 0) { void refreshQuotes([]); return; }
    setLoading(true); setError(null);
    try {
      const result = await refreshQuotes(syms);
      // Translate the raw `api()` error (often "500 Internal Server Error: …")
      // into a short status line. The verbose original is preserved as a
      // tooltip so power users can still see it via hover.
      if (result.status === 'failed') setError(friendlyQuoteError(result.error));
    } finally {
      setLoading(false);
    }
  }, [refreshQuotes]);

  // Re-fetch when the symbol set changes (account/tx add/remove).
  useEffect(() => {
    void refresh();
  }, [symbolsKey, refresh]);

  // Periodic auto-refresh. Pauses while the tab is hidden so we don't
  // hammer providers from a backgrounded window; runs once immediately
  // when the tab becomes visible again so the headline number is fresh
  // by the time the user looks at it. Window focus is handled too because
  // VS Code/browser webviews can remain `visible` while the whole window is
  // unfocused, which means `visibilitychange` never fires when the user
  // returns.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => { void refresh(); }, AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onFocus);
    window.addEventListener('online', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onFocus);
      window.removeEventListener('online', onVisibility);
    };
  }, [refresh]);

  // Poll /health every 30s for snapshot status. Cheap (single SQLite
  // count + max). Pauses while tab is hidden.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const h = await api<HealthResponse>('/health');
        if (!cancelled && h.snapshots) setSnapshotInfo(h.snapshots);
      } catch {
        // Health failure is already surfaced via apiStatus banner.
      }
    };
    void tick();
    const start = () => {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, 30_000);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
    const onVis = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') { void tick(); start(); }
      else stop();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return (
    <>
      {/* Pure / Bloomberg style: ticker bar is the top-most chrome,
          spanning full viewport width above everything else — not nested
          inside the .app card. Hides itself when there are no priced
          holdings yet. Investing only: Everyday is about card spending. */}
      {mode === 'investing' ? <TickerBanner accounts={accounts} transactions={transactions} quotes={activeQuotes} /> : null}

    <div className="app" data-mode={mode}>
      <header>
        <div className="header-row">
          <div className="header-brand">
            <div className="header-logo">
              <HoldrMark size={26} className="brand-mark" />
              <h1>Holdr</h1>
            </div>
            <ModeSwitch mode={mode} onChange={switchMode} />
          </div>
          <div className="header-actions">
            {mode === 'investing' ? (
              <>
                <SnapshotStatus info={snapshotInfo} />
                <QuoteStatus quotes={activeQuotes} symbols={symbols} />
                <button
                  className="refresh icon"
                  onClick={refresh}
                  disabled={loading || apiStatus === 'cache'}
                  aria-label={loading ? 'Refreshing quotes' : 'Refresh quotes'}
                  title={loading ? 'Refreshing…' : 'Refresh quotes'}
                >
                  <span aria-hidden className={loading ? 'spin' : undefined}>
                    <RefreshCw size={14} />
                  </span>
                </button>
              </>
            ) : null}
            <LocalOnlyChip />
            {username ? (
              <span className="user-chip" title={`Signed in as ${username}`}>{username}</span>
            ) : null}
            <button type="button" className="signout-button" onClick={() => { void signOut(); }}>
              Sign out
            </button>
          </div>
        </div>
        {apiStatus === 'cache' ? (
          <CacheBanner
            cacheUpdatedAt={cacheUpdatedAt}
            apiError={apiError}
            onRetry={() => {
              if (authStatus === 'offline') void checkSession();
              void hydrate();
            }}
          />
        ) : null}
        {loadingActions.length > 0 ? <div className="action-status saving">Saving changes…</div> : null}
        {latestActionError ? (
          <div className="action-status error-toast" role="alert">
            <span>{latestActionError.error.error}</span>
            <button type="button" onClick={() => clearActionError(latestActionError.id)}>
              Dismiss
            </button>
          </div>
        ) : null}
      </header>

      {/* Tabs as underline navigation — modern (Linear / Vercel /
          Robinhood web) replacement for the previous pill row. The
          1px sliding underline is driven by --tab-x / --tab-w custom
          properties measured in useLayoutEffect (Round 3, 3.B3).
          Investing only; Everyday's sections are the Spending areas. */}
      {tab ? <Tabs value={tab} onChange={setTab} onOpenSpending={() => navigate(DEFAULT_ROUTES.everyday, { focusSection: true })} /> : null}

      {/* When apiStatus === 'cache' we already render <CacheBanner/> above which says
          "Server unreachable" — don't also dump the raw quote-error here. */}
      {error && apiStatus !== 'cache' && mode === 'investing' ? (
        <div className="error" title={error}>{error}</div>
      ) : null}

      {tab === 'portfolio' ? <PortfolioBreakdown quotes={activeQuotes} /> : null}
      {tab === 'gold' ? <GoldPage onOpenCardTransactions={openCardTransactions} /> : null}
      {tab === 'transactions' ? <TransactionList /> : null}
      {/* Everyday's view stays (hidden by modes.css) while Investing shows, so back returns to it as it was. */}
      {everyday ? (
        <SpendingPanel key={everyday.key} area={everyday.route.area} amazonOrder={everyday.route.amazonOrder}
          amazonView={everyday.route.amazonView ?? null} onAreaChange={setArea} onAmazonView={setAmazonView} />
      ) : null}
      {tab === 'add' ? <AddTransactionForm onSaved={() => setTab('transactions')} /> : null}
      {tab === 'import' ? <ImportPanel /> : null}
      {tab === 'accounts' ? <AccountsManager quotes={activeQuotes} /> : null}
    </div>
    </>
  );
}

/* ---------------- helpers ---------------- */

interface SnapshotInfo {
  enabled: boolean;
  count: number;
  latest: string | null;
}
interface HealthResponse {
  ok: boolean;
  snapshots?: SnapshotInfo;
}

/** Compact lock chip in the header row: the data lives on this home
 *  server, reachable only from the LAN/tailnet and only after sign-in. */
function LocalOnlyChip() {
  return (
    <span
      className="local-only-chip"
      title="Local only — data stays on this home server; access requires sign-in"
      aria-label="Local only — data stays on this home server; access requires sign-in"
    >
      <Lock size={11} />
      local
    </span>
  );
}

/** Banner shown when the API is unreachable and we're serving from
 *  localStorage. Disables write actions across the app via the store's
 *  `apiStatus`; this banner just makes the state visible and offers retry. */
function CacheBanner({
  cacheUpdatedAt,
  apiError,
  onRetry,
}: {
  cacheUpdatedAt: number | null;
  apiError: string | null;
  onRetry: () => void;
}) {
  const ageMin = cacheUpdatedAt
    ? Math.round((Date.now() - cacheUpdatedAt) / 60_000)
    : null;
  const ageLabel = ageMin == null
    ? 'never'
    : ageMin < 1 ? 'just now'
    : ageMin < 60 ? `${ageMin}m ago`
    : ageMin < 24 * 60 ? `${Math.round(ageMin / 60)}h ago`
    : `${Math.round(ageMin / 60 / 24)}d ago`;
  return (
    // Keep the verbose raw error as a tooltip so the curious can still
    // see it, but don't render it as body text — a long "500 Internal
    // Server Error: {...}" string in the page is jarring and adds no
    // actionable info beyond the headline.
    <div
      className="banner cache-banner"
      role="alert"
      title={apiError ?? undefined}
    >
      <strong>Server unreachable.</strong>
      <span> Showing cached data (last sync: {ageLabel}). Writes are disabled. </span>
      <button className="banner-action" onClick={onRetry}>Retry server</button>
    </div>
  );
}

/**
 * Map a raw `api()` error string to a short, human-friendly status line.
 * The full original is kept around (as a tooltip on the cache banner / on
 * the inline error’s title attribute) so debug info isn’t lost.
 */
function friendlyQuoteError(raw: string): string {
  if (/^\s*5\d\d\b/.test(raw)) return 'Server error — quotes unavailable';
  if (/^\s*4\d\d\b/.test(raw)) return 'Quotes unavailable';
  if (/Failed to fetch|NetworkError|ERR_CONNECTION|ECONNREFUSED/i.test(raw)) {
    return 'Server unreachable — quotes unavailable';
  }
  return 'Quotes unavailable';
}

/** Compact status pill for the snapshot scheduler. Hidden when snapshots
 *  are disabled to avoid header clutter. */
function SnapshotStatus({ info }: { info: SnapshotInfo | null }) {
  if (!info) return null;
  if (!info.enabled) return null;
  if (info.count === 0) {
    return (
      <span
        className="header-clock"
        title="Snapshots: starting… (scheduler running, first tick pending)"
        aria-label="Snapshots starting"
      >
        <Clock size={12} />
      </span>
    );
  }
  const latestMs = info.latest ? Date.parse(info.latest) : 0;
  const ageMin = latestMs ? Math.round((Date.now() - latestMs) / 60_000) : null;
  const when = ageMin == null ? '?' : ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
  return (
    <span
      className="header-clock"
      title={`Snapshots · ${when}\nLast: ${info.latest}`}
      aria-label={`Snapshots ${when}`}
    >
      <Clock size={12} />
    </span>
  );
}

/** The header's quote badge: the session and freshness of the current quotes, or "Synthetic" for the demo's (quoteStatus.ts). */
function QuoteStatus({ quotes, symbols }: { quotes: Quote[]; symbols: string[] }) {
  const badge = quoteBadge(quotes, symbols);
  return (
    <span className={badge.kind ? `quote-status quote-${badge.kind}` : 'quote-status muted'} title={badge.title}>
      {badge.text}
    </span>
  );
}
