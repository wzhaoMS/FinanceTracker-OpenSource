import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isCardCategoryBasis, primaryCardCurrency } from '@finance-tracker/shared';
import type {
  CardAccount,
  CardAccountCoverage,
  CardCategoryBasis,
  CardOwner,
  CardTransactionView,
} from '@finance-tracker/shared';

import { usePortfolioPref } from '../../hooks/usePortfolioPref';
import { usePortfolioStore } from '../../stores/portfolio';
import { Disclosure } from '../Disclosure';
import { ChevronRight, Search, X } from '../icons';
import { Spinner, TitleWithSpinner } from '../Spinner';
import { useUpdatingMark } from '../useUpdatingMark';
import {
  apiErrorMessage,
  fetchCardAccounts,
  fetchCardTransactions,
  fetchSpendingAccounting,
  fetchSpendingCoverage,
  fetchSpendingInsights,
  fetchSpendingSummary,
  type CardTransactionListRow,
  type SpendingAccountingResponse,
  type SpendingFilters,
  type SpendingInsightsResponse,
  type SpendingSummaryResponse,
} from './spendingApi';
import {
  OWNERS,
  OWNER_LABELS,
  SPENDING_PERIODS,
  cardOptionLabel,
  cardShortLabel,
  currentMonth,
  dateRangeLabel,
  addDays,
  merchantDisplayName,
  monthLabel,
  rememberCardAccounts,
  shiftMonth,
  sourceLabel,
  spendingPeriodRange,
  todayIso,
  type SpendingPeriod,
} from './spendingFormat';
import { SpendingTransactions } from './SpendingTransactions';
import { SpendingDetail } from './SpendingDetail';
import { SpendingImport } from './SpendingImport';
import { SpendingCardPicker } from './SpendingCardPicker';
import { peekSpendingIntent, releaseSpendingIntent } from './spendingIntent';
import { WhatCountsPanel } from './WhatCountsPanel';
import { PaymentReconciliationPanel } from './PaymentReconciliationPanel';
import { OwedNowPanel } from './owed/OwedNowPanel';
import { OverviewBreakdown, OverviewByCategory, OverviewMonths, SpendingOverview } from './overview/SpendingOverview';
import { OverviewHeadline } from './overview/OverviewHeadline';
import { coverageSummary, scopeWords } from './overview/headlineText';
import { RecurringPanel, SpendingInsightsPanel, type MerchantFilter } from './SpendingInsights';
import { SpendingForecastPanel } from './forecast/SpendingForecast';
import { insightQuery, type InsightContext } from './insightCards';
import { BenefitsArea } from '../benefits/BenefitsArea';
import { AmazonArea } from '../amazon/AmazonArea';
import { CostcoReceipts } from '../costco/CostcoReceipts';
import type { AmazonView } from '../../modes/route';
import { DevicesArea } from './sync/DevicesArea';
import { OwnerActionsProvider } from './sync/OwnerActions';
import { SourcesDialog } from './sync/SourcesDialog';
import { AREA_PANEL_ID, SpendingAreaTabs, SyncWaitingNotice, areaTabId, type SpendingArea } from './sync/SpendingAreas';
import { SyncArea } from './sync/SyncArea';
import { useCommitSettlement } from './sync/useCommitSettlement';
import { useOwnerSync } from './sync/useOwnerSync';
import { useOnScreen } from './sync/useOnScreen';

const POSTED_PAGE = 100;
const PENDING_LIMIT = 200;

interface PostedState {
  rows: CardTransactionListRow[];
  total: number;
  nextOffset: number | null;
}

/** A read that failed while none of its view's figures were on screen: the view (as a key) and its error. */
interface ReadFailure {
  view: string;
  message: string;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function SpendingPanel({ area: shownArea, amazonOrder, amazonView, onAreaChange, onAmazonView }: {
  /** Set by Everyday, whose address names the area; left out, the panel keeps its own. */
  area?: SpendingArea;
  /** In the Amazon area, the order the address names (shown on its own page). */
  amazonOrder?: string;
  /** In the Amazon area, the tab the address names (null: its orders); left out, the area keeps its own. */
  amazonView?: AmazonView | null;
  onAreaChange?: (area: SpendingArea) => void;
  onAmazonView?: (view: AmazonView | null) => void;
} = {}) {
  const apiStatus = usePortfolioStore((s) => s.apiStatus);
  const writesDisabled = apiStatus === 'cache';
  // Another page may ask Card transactions to open on a charge (the Gold page's "Open in Card transactions").
  const [intent] = useState(peekSpendingIntent);
  useEffect(() => { if (intent) releaseSpendingIntent(intent); }, [intent]);
  const [month, setMonth] = useState(() => intent?.month ?? currentMonth());
  // A calendar month (with the arrows), or the last 60 or 90 days, the last 6 or 12 months, or the year to date, up to today.
  const [period, setPeriod] = useState<SpendingPeriod>('month');
  const today = todayIso();
  const range = useMemo(() => spendingPeriodRange(period, month, today), [period, month, today]);
  // The insights cover the period shown, against what its comparison card compares it with.
  const insightAsk = useMemo(() => insightQuery(period, range, month, today), [period, range, month, today]);
  const [owner, setOwner] = useState<CardOwner | ''>('');
  const [cardAccountId, setCardAccountId] = useState('');
  // Pending charges are listed (and totalled on their own card) or hidden; never added to spending.
  const [showPending, setShowPending] = useState(true);
  const [searchText, setSearchText] = useState('');
  const search = useDebouncedValue(searchText.trim(), 300);
  const [category, setCategory] = useState<string | null>(null);
  const [merchant, setMerchant] = useState<MerchantFilter | null>(null);
  // The list only: the Amazon card charges not itemized in one currency, from the coverage line (enriched only).
  const [amazonFilter, setAmazonFilter] = useState<{ currency: string } | null>(null);
  // Split categories (Amazon items, where a reviewed source has them) or every charge's own; persisted per browser.
  const [categoryBasis, setPreferredBasis] = usePortfolioPref<CardCategoryBasis>('spending-category-basis', 'enriched', isCardCategoryBasis);
  const setCategoryBasis = useCallback((next: CardCategoryBasis) => {
    setPreferredBasis(next);
    // Which Amazon charges are itemized is an enriched question.
    if (next === 'original') setAmazonFilter(null);
  }, [setPreferredBasis]);

  const [accounts, setAccounts] = useState<CardAccount[] | null>(null);
  // Labels stay unique among all the cards known, closed ones too (cardDisplayNames): set before anything below names
  // one, again whenever the list changes (a card updated in place too), and drawn again when an import creates a card.
  useMemo(() => rememberCardAccounts(accounts ?? []), [accounts]);
  const [, redrawCardLabels] = useReducer((count: number) => count + 1, 0);
  const [coverage, setCoverage] = useState<CardAccountCoverage[]>([]);
  /** The cards and their imported dates are being read (again, after an import). */
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [monthSummary, setMonthSummary] = useState<SpendingSummaryResponse | null>(null);
  /** What counts in the view (the summary's filters): the parts of the card activity, suggestions, asset purchases, rules. */
  const [accounting, setAccounting] = useState<SpendingAccountingResponse | null>(null);
  // An answer and the words of the period it answers, kept together while the next period loads.
  const [insights, setInsights] = useState<{ body: SpendingInsightsResponse; context: InsightContext } | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  /**
   * The list's or the insights' read that failed while none of its view's figures were on screen (another view's were,
   * and went, or none yet): said in their place, and on the page with "Try again", until a read of that view succeeds.
   */
  const [listFailure, setListFailure] = useState<ReadFailure | null>(null);
  const [insightsFailure, setInsightsFailure] = useState<ReadFailure | null>(null);
  /**
   * What counts' own read failed, for the same view or another, while the list's other parts were read: never a panel
   * that goes silently, nor a page error, as the other panels show. Said in What counts, with its own Try again.
   */
  const [accountingFailure, setAccountingFailure] = useState<ReadFailure | null>(null);
  /** What counts is being read again on its own (its Try again). */
  const [accountingLoading, setAccountingLoading] = useState(false);
  /** Whose view the list's figures (rows, summary, What counts) and the insights on screen are; null: none. */
  const listShownFor = useRef<string | null>(null);
  const insightsShownFor = useRef<string | null>(null);
  const [pendingRows, setPendingRows] = useState<CardTransactionListRow[]>([]);
  const [posted, setPosted] = useState<PostedState>({ rows: [], total: 0, nextOffset: null });
  /** Whose view the list above is (the filters, as a key): its count for the headline's link is said only under it. */
  const [readFor, setReadFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(intent?.transactionId ?? null);
  /** A charge's sources and history (proposal §3.8), open in place of its drawer. */
  const [sourcesId, setSourcesId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [accountsVersion, setAccountsVersion] = useState(0);
  // Plan §8: the extension's controls live in this tab's own areas, never in a second top-level tab.
  const [ownArea, setOwnArea] = useState<SpendingArea>('transactions');
  const area = shownArea ?? ownArea;
  const setArea = useCallback((next: SpendingArea) => {
    setOwnArea(next);
    onAreaChange?.(next);
  }, [onAreaChange]);
  // Holdr's sync state refreshes only while this tab is on screen (another mode may keep it mounted but hidden).
  const rootRef = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(rootRef);
  const sync = useOwnerSync(onScreen);

  const filters = useMemo<SpendingFilters>(() => ({
    from: range.from,
    to: range.to,
    owner: owner || undefined,
    cardAccountId: cardAccountId || undefined,
    category: category ?? undefined,
    merchant: merchant?.key,
    q: search || undefined,
    categoryBasis,
    amazon: categoryBasis === 'enriched' && amazonFilter ? 'unitemized' : undefined,
    amazonCurrency: categoryBasis === 'enriched' ? amazonFilter?.currency : undefined,
  }), [range.from, range.to, owner, cardAccountId, category, merchant, search, categoryBasis, amazonFilter]);

  // The view the insights answer: what they are asked for, on whose cards, by which categories.
  const insightsKey = useMemo(
    () => JSON.stringify([insightAsk.request, owner, cardAccountId, categoryBasis]),
    [insightAsk, owner, cardAccountId, categoryBasis],
  );

  // Insights look at the whole history of the cards in view, not at the category, merchant or text filters.
  useEffect(() => {
    let cancelled = false;
    setInsightsLoading(true);
    const view = insightsKey;
    const { request, context } = insightAsk;
    fetchSpendingInsights({ ...request, owner: owner || undefined, cardAccountId: cardAccountId || undefined, categoryBasis })
      .then((body) => {
        if (cancelled) return;
        setInsights({ body, context });
        insightsShownFor.current = view;
        setInsightsFailure(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const message = apiErrorMessage(reason);
        // Read again, the view keeps its own insights, and the page says what failed.
        if (insightsShownFor.current === view) {
          setError(message);
          return;
        }
        // Another view's insights never pass as this one's: they go, and the error is said in their place.
        insightsShownFor.current = null;
        setInsights(null);
        setInsightsFailure({ view, message });
      })
      .finally(() => { if (!cancelled) setInsightsLoading(false); });
    return () => { cancelled = true; };
  }, [insightsKey, insightAsk, owner, cardAccountId, categoryBasis, dataVersion]);

  useEffect(() => {
    let cancelled = false;
    setAccountsLoading(true);
    Promise.all([fetchCardAccounts(), fetchSpendingCoverage()])
      .then(([cards, covered]) => {
        if (cancelled) return;
        setAccounts(cards);
        setCoverage(covered);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setAccounts([]);
        setError(apiErrorMessage(reason));
      })
      .finally(() => { if (!cancelled) setAccountsLoading(false); });
    return () => { cancelled = true; };
  }, [accountsVersion]);

  // Each reload of the list starts a generation; a "Show more" answer from an earlier one is
  // dropped, and "Show more" waits until the current generation's first page is in.
  const listGeneration = useRef(0);
  const loadedGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  // Each read of What counts, with the list or on its own (its Try again), takes the next number: only the latest
  // one's answer is what What counts says, whichever lands first.
  const accountingRead = useRef(0);

  useEffect(() => {
    const generation = ++listGeneration.current;
    const counting = ++accountingRead.current;
    const readKey = JSON.stringify(filters);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    let cancelled = false;
    setLoading(true);
    // What counts is read with the list: a read again of What counts alone, still on its way, is retired.
    setAccountingLoading(false);
    setError(null);
    Promise.all([
      fetchSpendingSummary(filters),
      fetchCardTransactions(filters, { status: 'pending', limit: PENDING_LIMIT }),
      fetchCardTransactions(filters, { status: 'posted', limit: POSTED_PAGE }),
      // What counts is said beside the figures; without it they still show, and What counts says why it can't.
      fetchSpendingAccounting(filters).then(
        (body) => ({ body, failure: null }),
        (reason: unknown) => ({ body: null, failure: apiErrorMessage(reason) }),
      ),
    ])
      .then(([summary, pending, page, counted]) => {
        if (cancelled) return;
        setMonthSummary(summary);
        // What counts read again on its own since this read began answers What counts.
        if (accountingRead.current === counting) {
          setAccounting(counted.body);
          setAccountingFailure(counted.failure === null ? null : { view: readKey, message: counted.failure });
        }
        setPendingRows(pending.transactions);
        setPosted({ rows: page.transactions, total: page.total, nextOffset: page.nextOffset });
        setReadFor(readKey);
        listShownFor.current = readKey;
        setListFailure(null);
        loadedGeneration.current = generation;
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const message = apiErrorMessage(reason);
        // Read again, the view keeps its own rows, and the page says what failed.
        if (listShownFor.current === readKey) {
          setError(message);
          return;
        }
        // Another view's rows, What counts and summary never pass as this one's: they go, and the error is said in
        // their place. What counts read on its own meanwhile goes too: no figures beside the list's error.
        listShownFor.current = null;
        accountingRead.current += 1;
        setMonthSummary(null);
        setAccounting(null);
        setAccountingFailure(null);
        setAccountingLoading(false);
        setPendingRows([]);
        setPosted({ rows: [], total: 0, nextOffset: null });
        setReadFor(null);
        setListFailure({ view: readKey, message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filters, dataVersion]);

  const loadMore = useCallback(() => {
    const generation = listGeneration.current;
    if (posted.nextOffset === null || loadingMoreRef.current || loadedGeneration.current !== generation) return;
    const current = () => listGeneration.current === generation;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    fetchCardTransactions(filters, { status: 'posted', limit: POSTED_PAGE, offset: posted.nextOffset })
      .then((page) => {
        if (!current()) return;
        setPosted((state) => ({
          rows: [...state.rows, ...page.transactions],
          total: page.total,
          nextOffset: page.nextOffset,
        }));
      })
      .catch((reason: unknown) => { if (current()) setError(apiErrorMessage(reason)); })
      .finally(() => {
        if (!current()) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [filters, posted.nextOffset]);

  /**
   * What counts' Try again: What counts alone is read again, for the view shown; the other panels, read, stay as they
   * are. Only the latest read of What counts answers it: a read of the list started meanwhile reads What counts too, and
   * retires this one; one started before it is retired by it.
   */
  const retryAccounting = useCallback(() => {
    const counting = ++accountingRead.current;
    const view = JSON.stringify(filters);
    const latest = () => accountingRead.current === counting;
    setAccountingLoading(true);
    fetchSpendingAccounting(filters).then(
      (body) => {
        if (!latest()) return;
        setAccounting(body);
        setAccountingFailure(null);
        setAccountingLoading(false);
      },
      (reason: unknown) => {
        if (!latest()) return;
        // Its error never stands beside figures.
        setAccounting(null);
        setAccountingFailure({ view, message: apiErrorMessage(reason) });
        setAccountingLoading(false);
      },
    );
  }, [filters]);

  /** A row changed in place (category, notes, status): show it at once, then refresh the figures. */
  const onRowChanged = useCallback((row: CardTransactionView) => {
    setPendingRows((rows) => rows.map((item) => (item.id === row.id ? row : item)));
    setPosted((state) => ({ ...state, rows: state.rows.map((item) => (item.id === row.id ? row : item)) }));
    setDataVersion((version) => version + 1);
  }, []);

  const onImported = useCallback(() => {
    setAccountsVersion((version) => version + 1);
    setDataVersion((version) => version + 1);
  }, []);
  // Kept here, above the sync areas, so a commit Holdr finishes after its answer was lost still refreshes Spending.
  const commits = useCommitSettlement(sync, onImported);

  const accountById = useMemo(() => new Map((accounts ?? []).map((account) => [account.id, account])), [accounts]);
  // The headline figures use the currency most cards in view use, for the card and the person
  // chosen, as the insights do; other currencies are shown beside them.
  const currency = useMemo(
    () => primaryCardCurrency(accounts ?? [], { cardAccountId: cardAccountId || undefined, owner: owner || undefined }),
    [accounts, cardAccountId, owner],
  );
  const categories = monthSummary?.categories ?? [];
  const noCards = accounts !== null && accounts.length === 0;
  /** Rows waiting for the owner's word on precious metals: the list marks them. */
  const suggestedIds = useMemo(() => new Set((accounting?.suggestions ?? []).map((item) => item.id)), [accounting]);
  // The list's count for the filters in use is said only under its own view (a new period never shows the last one's).
  const viewKey = useMemo(() => JSON.stringify(filters), [filters]);
  const ownRead = readFor === viewKey;
  const scope = scopeWords({ owner, card: accountById.get(cardAccountId) ?? null });
  // Narrowed by search, category, merchant or the Amazon line: how many rows the list shows, and a way down to them.
  const filtered = Boolean(search || category || merchant || filters.amazon);
  const matching = filtered && ownRead ? posted.total + (showPending ? pendingRows.length : 0) : null;
  const transactionsRef = useRef<HTMLElement>(null);
  const showTransactions = useCallback(() => {
    const list = transactionsRef.current;
    if (!list) return;
    list.scrollIntoView({ block: 'start' });
    list.focus({ preventScroll: true });
  }, []);
  // A failed read is said under its own view only: another view is read on its own.
  const listFailed = listFailure !== null && listFailure.view === viewKey ? listFailure.message : null;
  const insightsFailed = insightsFailure !== null && insightsFailure.view === insightsKey ? insightsFailure.message : null;
  const accountingFailed = accountingFailure !== null && accountingFailure.view === viewKey ? accountingFailure.message : null;
  const readFailure = listFailed ?? insightsFailed;
  const retrying = (listFailed !== null && loading) || (insightsFailed !== null && insightsLoading);
  const insightsRef = useRef<HTMLElement>(null);
  /**
   * "Try again" was pressed while focused: once the view it retried is read and its error goes, focus goes to what was
   * read (scrolled to from the keyboard). Another view chosen meanwhile moves nothing.
   */
  const retryFocus = useRef<{ target: 'list' | 'insights'; view: string; scroll: boolean } | null>(null);
  const retryReads = (button: HTMLButtonElement) => {
    const scroll = button.matches(':focus-visible');
    retryFocus.current = document.activeElement !== button ? null
      : listFailed !== null ? { target: 'list', view: viewKey, scroll }
        : { target: 'insights', view: insightsKey, scroll };
    // Everything is read again, as after a change: a part of the overview that failed with them is too.
    setDataVersion((version) => version + 1);
  };
  const failureShown = readFailure !== null;
  useLayoutEffect(() => {
    if (failureShown) return;
    const focus = retryFocus.current;
    retryFocus.current = null;
    if (focus === null) return;
    // Only the view retried, still chosen, and read: its own figures are what focus goes to.
    const list = focus.target === 'list';
    if ((list ? viewKey : insightsKey) !== focus.view || (list ? listShownFor : insightsShownFor).current !== focus.view) return;
    // Only when the button went with its error and focus fell to the page.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    (list ? transactionsRef.current : insightsRef.current)?.focus({ preventScroll: !focus.scroll });
  }, [failureShown]);
  // A card closed or opened again: the cards change in place, and every figure that reads coverage is read again.
  const onAccountUpdated = useCallback((updated: CardAccount) => {
    setAccounts((cards) => (cards ?? []).map((card) => (card.id === updated.id ? updated : card)));
    setDataVersion((version) => version + 1);
  }, []);

  return (
    <section ref={rootRef} className="spending" aria-label="Spending" data-on-screen={onScreen}>
      <OwnerActionsProvider client={sync.client}>
        <SpendingAreaTabs area={area} onArea={setArea} sync={sync} />
        <div id={AREA_PANEL_ID} className="spending-area-panel" role="tabpanel" aria-labelledby={areaTabId(area)}>
          {area === 'transactions' ? (
            <>
              <SpendingToolbar
                month={month}
                onMonth={setMonth}
                period={period}
                onPeriod={setPeriod}
                rangeLabel={range.label}
                owner={owner}
                onOwner={setOwner}
                cardAccountId={cardAccountId}
                onCard={setCardAccountId}
                accounts={accounts ?? []}
                onAccountUpdated={onAccountUpdated}
                showPending={showPending}
                onShowPending={setShowPending}
                searchText={searchText}
                onSearch={setSearchText}
                onImport={() => setImportOpen(true)}
                importDisabled={writesDisabled}
              />

              {filtered ? (
                <div className="spending-active-filters" role="group" aria-label="Active filters">
                  {search ? <FilterChip label={`Search: “${search}”`} onClear={() => setSearchText('')} /> : null}
                  {category ? (
                    <FilterChip label={`Category: ${category}`} onClear={() => setCategory(null)} />
                  ) : null}
                  {merchant ? (
                    <FilterChip label={`Merchant: ${merchantDisplayName(merchant.name, merchant.key)}`} onClear={() => setMerchant(null)} />
                  ) : null}
                  {filters.amazon ? (
                    <FilterChip label={`Amazon charges not itemized (${filters.amazonCurrency})`} onClear={() => setAmazonFilter(null)} />
                  ) : null}
                </div>
              ) : null}

              <SyncWaitingNotice sync={sync} onOpen={() => setArea('sync')} />

              {/* A read whose view shows none of its figures: what failed, until a read of the view succeeds. */}
              {readFailure !== null ? (
                <div className="spending-error" role="alert" data-testid="spending-read-error">
                  {readFailure}{' '}
                  {/* Already being read again: pressed again, nothing more is asked for. */}
                  <button type="button" className="spending-link inline" aria-disabled={retrying || undefined}
                    onClick={(event) => { if (!retrying) retryReads(event.currentTarget); }}>
                    {retrying ? <Spinner label="Trying again" testId="spending-retrying" /> : 'Try again'}
                  </button>
                </div>
              ) : null}
              {error && error !== readFailure ? <div className="spending-error" role="alert">{error}</div> : null}

              {noCards ? (
                <div className="spending-empty" role="status">
                  <strong>No card spending yet</strong>
                  <p>
                    Import the redacted JSON that Holdr&apos;s offline tool writes from an issuer export. Raw exports
                    never come here; see docs/importing-data.md.
                  </p>
                  <button type="button" className="spending-button primary" disabled={writesDisabled} onClick={() => setImportOpen(true)}>
                    Import redacted JSON
                  </button>
                </div>
              ) : (
                <>
                  {/* What every card owes now, as its issuer last showed it: a figure of the whole household, whatever
                      the period or person below, so it comes before the period's answer. */}
                  <OwedNowPanel accountById={accountById} dataVersion={dataVersion} />
                  {/* The period's answer, in reading order: the headline, where it went and what changed, by category, the
                      transactions, the months. The panels after it read the cards in view on their own terms. */}
                  <SpendingOverview filters={filters} period={period} range={range} month={month} today={today} currency={currency} dataVersion={dataVersion}>
                    {(read) => (
                      <>
                        <OverviewHeadline
                          read={read}
                          periodKind={period}
                          previous={range.previous}
                          scope={scope}
                          matching={matching}
                          matchingUpdating={loading}
                          onShowTransactions={showTransactions}
                        />
                        <OverviewBreakdown read={read} previous={range.previous} onOpen={setDetailId} />
                        <OverviewByCategory
                          read={read}
                          onOpen={setDetailId}
                          basis={categoryBasis}
                          onBasis={setCategoryBasis}
                          onFilterCategory={setCategory}
                          onFilterMerchant={setMerchant}
                          onAmazonUnitemized={() => {
                            // The list then shows exactly the charges the line counts: every category's, in its currency.
                            setCategory(null);
                            setAmazonFilter({ currency });
                          }}
                        />
                        <SpendingTransactions
                          anchorRef={transactionsRef}
                          periodPhrase={range.phrase}
                          pending={showPending ? pendingRows : []}
                          posted={posted.rows}
                          postedTotal={posted.total}
                          hasMore={posted.nextOffset !== null}
                          loading={loading}
                          failure={listFailed}
                          loadingMore={loadingMore}
                          onLoadMore={loadMore}
                          accountById={accountById}
                          categories={categories}
                          category={category}
                          suggestedIds={suggestedIds}
                          writesDisabled={writesDisabled}
                          onOpen={setDetailId}
                          onChanged={onRowChanged}
                          onError={setError}
                        />
                        <OverviewMonths
                          read={read}
                          cards={accounts ?? []}
                          selected={period === 'month' ? month : null}
                          onMonth={(next) => { setPeriod('month'); setMonth(next); }}
                          onDataChanged={() => setDataVersion((version) => version + 1)}
                        />
                      </>
                    )}
                  </SpendingOverview>
                  <SpendingInsightsPanel
                    anchorRef={insightsRef}
                    insights={insights?.body ?? null}
                    context={insights?.context ?? null}
                    loading={insightsLoading}
                    failure={insightsFailed}
                    category={category}
                    onCategory={setCategory}
                    onMerchant={setMerchant}
                    onOpen={setDetailId}
                  />
                  <RecurringPanel insights={insights?.body ?? null} loading={insightsLoading} failure={insightsFailed} accountById={accountById}
                    onMerchant={setMerchant} />
                  <WhatCountsPanel
                    accounting={accounting}
                    currency={currency}
                    periodPhrase={range.phrase}
                    loading={loading || accountingLoading}
                    failure={listFailed ?? accountingFailed}
                    // The list's own failure is retried from the page's error; What counts' alone, from What counts.
                    onRetry={listFailed === null && accountingFailed !== null ? retryAccounting : undefined}
                    writesDisabled={writesDisabled}
                    onChanged={(row) => (row ? onRowChanged(row) : setDataVersion((version) => version + 1))}
                    onOpen={setDetailId}
                  />
                  <PaymentReconciliationPanel
                    accountById={accountById}
                    currency={currency}
                    dataVersion={dataVersion}
                    writesDisabled={writesDisabled}
                    onOpen={setDetailId}
                  />
                  <SpendingForecastPanel
                    today={today}
                    owner={owner || undefined}
                    cardAccountId={cardAccountId || undefined}
                    categoryBasis={categoryBasis}
                    dataVersion={dataVersion}
                    ready={!loading && !insightsLoading}
                    cards={accounts ?? []}
                    onCategory={setCategory}
                    onMerchant={setMerchant}
                  />
                  <CoverageList coverage={coverage} accountById={accountById} updating={accountsLoading} onShowSync={() => setArea('sync')} />
                </>
              )}
            </>
          ) : area === 'benefits' ? (
            <BenefitsArea writesDisabled={writesDisabled} onOpenTransaction={setDetailId} />
          ) : area === 'amazon' ? (
            <AmazonArea orderRef={amazonOrder} view={amazonView} onView={onAmazonView} accountById={accountById}
              onOpenTransaction={setDetailId} />
          ) : area === 'costco' ? (
            <CostcoReceipts />
          ) : area === 'sync' ? (
            <SyncArea
              sync={sync}
              accounts={accounts ?? []}
              onOpenDevices={() => setArea('devices')}
              onImport={writesDisabled ? undefined : () => setImportOpen(true)}
              onLedgerChanged={onImported}
              commits={commits}
              dataVersion={dataVersion}
            />
          ) : (
            <DevicesArea sync={sync} accounts={accounts ?? []} onImport={writesDisabled ? undefined : () => setImportOpen(true)} />
          )}
        </div>

        {detailId ? (
          <SpendingDetail
            id={detailId}
            accountById={accountById}
            categories={categories}
            categoryBasis={categoryBasis}
            writesDisabled={writesDisabled}
            onClose={() => setDetailId(null)}
            onChanged={onRowChanged}
            onShowMerchant={(value) => {
              setMerchant(value);
              setDetailId(null);
            }}
            onOpen={setDetailId}
            onSources={sync.status === 'ready' && sync.client ? () => {
              // In place of the drawer, not on top of it: both answer Escape. Closing comes back to the drawer.
              setSourcesId(detailId);
              setDetailId(null);
            } : undefined}
          />
        ) : null}
        {sourcesId && sync.client ? (
          <SourcesDialog
            sync={sync}
            transactionId={sourcesId}
            onClose={() => {
              setDetailId(sourcesId);
              setSourcesId(null);
            }}
            onLedgerChanged={onImported}
          />
        ) : null}
        {importOpen ? (
          <SpendingImport
            accounts={accounts ?? []}
            onClose={() => setImportOpen(false)}
            onImported={onImported}
            onAccountCreated={redrawCardLabels}
            onReview={() => {
              setImportOpen(false);
              setArea('sync');
              // The import's sets are new: the queue reads Holdr's state again now, not at its next refresh.
              void sync.refresh();
            }}
          />
        ) : null}
      </OwnerActionsProvider>
    </section>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="spending-chip active">
      {label}
      <button type="button" aria-label={`Clear ${label}`} onClick={onClear}>
        <X size={12} />
      </button>
    </span>
  );
}

interface ToolbarProps {
  month: string;
  onMonth: (month: string) => void;
  period: SpendingPeriod;
  onPeriod: (period: SpendingPeriod) => void;
  /** The dates of a period other than a month ("Dec 22, 2023 – Mar 20, 2024"). */
  rangeLabel: string;
  owner: CardOwner | '';
  onOwner: (owner: CardOwner | '') => void;
  cardAccountId: string;
  onCard: (id: string) => void;
  accounts: CardAccount[];
  onAccountUpdated: (account: CardAccount) => void;
  showPending: boolean;
  onShowPending: (value: boolean) => void;
  searchText: string;
  onSearch: (value: string) => void;
  onImport: () => void;
  importDisabled: boolean;
}

function SpendingToolbar(props: ToolbarProps) {
  const { month, onMonth, period } = props;
  return (
    <div className="spending-toolbar">
      <div className="spending-when">
        <div className="spending-month" role="group" aria-label={period === 'month' ? 'Month' : 'Dates'}>
          {period === 'month' ? (
            <button type="button" className="spending-icon-button" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>
              <ChevronRight size={14} className="flip" />
            </button>
          ) : null}
          <span className={`spending-month-label${period === 'month' ? '' : ' range'}`} aria-live="polite">
            {period === 'month' ? monthLabel(month) : props.rangeLabel}
          </span>
          {period === 'month' ? (
            <button type="button" className="spending-icon-button" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>
              <ChevronRight size={14} />
            </button>
          ) : null}
        </div>
        {/* A month, or a span that ends today: what the cards, rankings and list below cover. */}
        <div className="spending-periods" role="group" aria-label="Period">
          {SPENDING_PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`spending-period${period === item.id ? ' active' : ''}`}
              aria-pressed={period === item.id}
              title={item.title}
              onClick={() => props.onPeriod(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="spending-controls">
        {/* Phones: Person, Card and Show pending scroll sideways in their own row; search and Import keep a row of their own. */}
        <div className="spending-filters">
          <label className="spending-select">
            <span>Person</span>
            <select aria-label="Person" value={props.owner} onChange={(event) => props.onOwner(event.target.value as CardOwner | '')}>
              <option value="">Everyone</option>
              {OWNERS.map((owner) => <option key={owner} value={owner}>{OWNER_LABELS[owner]}</option>)}
            </select>
          </label>
          <SpendingCardPicker
            accounts={props.accounts}
            value={props.cardAccountId}
            onChange={props.onCard}
            onUpdated={props.onAccountUpdated}
            writesDisabled={props.importDisabled}
          />
          <label className="spending-toggle">
            <input
              type="checkbox"
              checked={props.showPending}
              onChange={(event) => props.onShowPending(event.target.checked)}
            />
            <span>Show pending</span>
          </label>
        </div>
        <div className="spending-find">
          <label className="spending-search">
            <Search size={14} />
            <input
              type="search"
              value={props.searchText}
              placeholder="Search merchant or description"
              aria-label="Search merchant or description"
              maxLength={100}
              onChange={(event) => props.onSearch(event.target.value)}
            />
          </label>
          <button type="button" className="spending-button primary" disabled={props.importDisabled} onClick={props.onImport}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What each card's imports cover, with the gaps between: a diagnostic, so its list is folded under the line saying how
 * many cards and gaps there are (the Sync area has the same per card).
 */
function CoverageList({ coverage, accountById, updating, onShowSync }: {
  coverage: CardAccountCoverage[];
  accountById: Map<string, CardAccount>;
  /** Read again (after an import): the dates shown are the last read's. */
  updating: boolean;
  onShowSync: () => void;
}) {
  // Dimmed at once while they are read again, until a moment after the new ones land.
  const marked = useUpdatingMark(updating && coverage.length > 0);
  if (coverage.length === 0) return null;
  const gapsOf = (card: CardAccountCoverage) => card.ranges.slice(1).map((range, index) => ({
    start: addDays(card.ranges[index].end, 1),
    end: addDays(range.start, -1),
  }));
  const gapCount = coverage.reduce((sum, card) => sum + gapsOf(card).length, 0);
  return (
    <section className="spending-panel spending-coverage" aria-label="Import coverage" data-updating={marked ? 'true' : undefined}>
      <header className="spending-panel-head">
        <TitleWithSpinner busy={marked} testId="coverage-updating"><h3>Imported dates</h3></TitleWithSpinner>
        <button type="button" className="spending-link" onClick={onShowSync}>View sync &amp; coverage</button>
      </header>
      <p className="overview-help">What each card&apos;s imports cover; a gap may be missing spending.</p>
      <Disclosure className="spending-coverage-fold" summary={coverageSummary(coverage.length, gapCount)} label={`Imported dates: ${coverageSummary(coverage.length, gapCount)}`}>
        <ul>
          {coverage.map((card) => {
            const account = accountById.get(card.cardAccountId);
            const last = card.imports[0];
            const gaps = gapsOf(card);
            return (
              <li key={card.cardAccountId} className="spending-coverage-row">
                <strong>{account ? cardOptionLabel(account) : cardShortLabel(undefined)}</strong>
                <span className="spending-coverage-ranges">
                  {card.ranges.length > 0
                    ? card.ranges.map((range) => (
                      <span key={range.start} className="spending-coverage-range">{dateRangeLabel(range.start, range.end)}</span>
                    ))
                    : card.transactions
                      ? <span className="spending-muted">Rows from {dateRangeLabel(card.transactions.first, card.transactions.last)}; no recorded range</span>
                      : <span className="spending-muted">Nothing imported yet</span>}
                  {gaps.map((gap) => (
                    <span key={gap.start} className="spending-coverage-gap" title="No import covers these dates">
                      Gap {dateRangeLabel(gap.start, gap.end)}
                    </span>
                  ))}
                </span>
                {last ? (
                  <span className="spending-muted">
                    Last import {new Date(last.importedAt).toLocaleString()} · {sourceLabel(last.source)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Disclosure>
    </section>
  );
}
