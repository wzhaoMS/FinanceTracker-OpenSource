import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CardAccount } from '@finance-tracker/shared';

import { ApiError } from '../../services/api';
import type { AmazonView } from '../../modes/route';
import { Disclosure } from '../Disclosure';
import { apiErrorMessage } from '../spending/spendingApi';
import { amazonEvidenceText, cardNameLabel, longDate } from '../spending/spendingFormat';
import { AmazonFreshPanel } from './AmazonFresh';
import { AMAZON_SPENDING_TITLE_ID, AmazonSpendingPanel } from './AmazonSpending';
import { AmazonTaxonomyPanel } from './AmazonTaxonomySpending';
import {
  AMAZON_BENEFICIARIES,
  AMAZON_PAGE_SIZE,
  fetchAmazonOrder,
  fetchAmazonOrders,
  fetchAmazonSummary,
  type AmazonBeneficiary,
  type AmazonCoverageFamily,
  type AmazonItem,
  type AmazonMatch,
  type AmazonOrder,
  type AmazonPaymentMethod,
  type AmazonRefund,
  type AmazonSummary,
  type AmazonSummaryLine,
} from './amazonApi';
import {
  AMAZON_LIST_HREF,
  BENEFICIARY_LABELS,
  NON_CARD_LINES,
  amazonOrderHref,
  candidateText,
  coverageFamilyLabel,
  formatMoney,
  groupMatches,
  heldReasonText,
  itemCategory,
  orderMatchStatus,
  paymentMethodText,
  plural,
  purchaseChannelText,
  refundCountText,
  refundObservationNote,
  refundText,
  cardMatchFigure,
  summaryCountedLines,
  summaryLimit,
  summaryLineText,
  tenderText,
} from './amazonFormat';
import { AmazonItemThumb } from './AmazonItemThumb';
import { AMAZON_AGENT_EDGE_NOTE, AmazonCategoryTag } from './AmazonCategoryTag';

/**
 * The Amazon area of Everyday: the shared household Amazon account's orders and items, read-only. Amazon order
 * activity is a separately labelled measure, counted by Amazon's order date; card spending stays in Card
 * transactions, by its posting date, and nothing here is added to it. Purchases first: the summary (how many orders,
 * how many card matches are linked, refund observations, and that the history may be incomplete; how they were counted
 * folds away), then the orders themselves, then the analysis: what the orders' items cost, per category and per item
 * over a window (AmazonSpending.tsx), and what the items were, by the Amazon item taxonomy (AmazonTaxonomySpending.tsx),
 * Amazon's own measure too, one step away from the orders' heading. Each order's card says its card match in one plain
 * line: a linked order opens its card transaction there; one that needs review says so, and its own page says why (the
 * fixed reason and how many card charges were candidates, never which). Who an order was for ("For:") is whoever was
 * explicitly assigned, else Unknown; it is never the card's owner. Its second tab, Amazon Fresh (AmazonFresh.tsx), shows
 * the Fresh orders' groceries by category.
 */
export function AmazonArea({ orderRef, view: shownView, onView, accountById, onOpenTransaction }: {
  /** The order shown on its own page, as the address names it; a tab otherwise. */
  orderRef?: string;
  /** The tab the address names (null: the orders); left out, the area keeps its own. */
  view?: AmazonView | null;
  onView?: (view: AmazonView | null) => void;
  accountById: ReadonlyMap<string, CardAccount>;
  /** Opens a linked card charge's details. */
  onOpenTransaction: (id: string) => void;
}) {
  const [ownView, setOwnView] = useState<AmazonView | null>(null);
  const view = shownView === undefined ? ownView : shownView;
  const setView = (next: AmazonView | null) => {
    setOwnView(next);
    onView?.(next);
  };
  const showing = orderRef !== undefined ? 'order' : view === 'fresh' ? 'fresh' : 'orders';
  // Each tab loads once it is first shown (not behind an order opened from elsewhere), then stays, hidden behind the
  // other tab or an order's page, so returning to it keeps its filters, windows and the pages already loaded.
  const [listMounted, setListMounted] = useState(showing === 'orders');
  const [freshMounted, setFreshMounted] = useState(showing === 'fresh');
  if (showing === 'orders' && !listMounted) setListMounted(true);
  if (showing === 'fresh' && !freshMounted) setFreshMounted(true);
  return (
    <div className="amazon">
      {showing !== 'order' ? <AmazonViewTabs view={view} onView={setView} /> : null}
      {listMounted ? (
        <div id={viewPanelId(null)} role="tabpanel" aria-labelledby={viewTabId(null)} hidden={showing !== 'orders'}>
          <AmazonOrders accountById={accountById} onOpenTransaction={onOpenTransaction} />
        </div>
      ) : null}
      {freshMounted ? (
        <div id={viewPanelId('fresh')} role="tabpanel" aria-labelledby={viewTabId('fresh')} hidden={showing !== 'fresh'}>
          <AmazonFreshPanel />
        </div>
      ) : null}
      {orderRef ? <AmazonOrderPage key={orderRef} orderRef={orderRef} accountById={accountById} onOpenTransaction={onOpenTransaction} /> : null}
    </div>
  );
}

const VIEWS: ReadonlyArray<{ id: AmazonView | null; label: string }> = [
  { id: null, label: 'Amazon orders' },
  { id: 'fresh', label: 'Amazon Fresh' },
];
const viewTabId = (view: AmazonView | null) => `amazon-view-${view ?? 'orders'}`;
const viewPanelId = (view: AmazonView | null) => `amazon-view-panel-${view ?? 'orders'}`;

/** The Amazon area's two big tabs: every order, and Amazon Fresh. Arrow keys move between them, as in any tab list. */
function AmazonViewTabs({ view, onView }: { view: AmazonView | null; onView: (view: AmazonView | null) => void }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = VIEWS.findIndex((item) => item.id === view);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % VIEWS.length;
    if (event.key === 'ArrowLeft') next = (index + VIEWS.length - 1) % VIEWS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = VIEWS.length - 1;
    if (next === null) return;
    event.preventDefault();
    onView(VIEWS[next].id);
    refs.current.get(viewTabId(VIEWS[next].id))?.focus();
  };
  return (
    <div className="amazon-views" role="tablist" aria-label="Amazon views">
      {VIEWS.map((item) => {
        const selected = item.id === view;
        return (
          <button
            key={viewTabId(item.id)}
            ref={(element) => { if (element) refs.current.set(viewTabId(item.id), element); else refs.current.delete(viewTabId(item.id)); }}
            id={viewTabId(item.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={viewPanelId(item.id)}
            tabIndex={selected ? 0 : -1}
            className={`amazon-view-tab${selected ? ' active' : ''}`}
            onClick={() => onView(item.id)}
            onKeyDown={onKey}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

interface OrderList {
  beneficiary: AmazonBeneficiary | '';
  total: number;
  orders: AmazonOrder[];
}

function appendOrders(shown: AmazonOrder[], next: AmazonOrder[]): AmazonOrder[] {
  const seen = new Set(shown.map((order) => order.ref));
  return [...shown, ...next.filter((order) => !seen.has(order.ref))];
}

function AmazonOrders({ accountById, onOpenTransaction }: {
  accountById: ReadonlyMap<string, CardAccount>;
  onOpenTransaction: (id: string) => void;
}) {
  const [summary, setSummary] = useState<AmazonSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [beneficiary, setBeneficiary] = useState<AmazonBeneficiary | ''>('');
  const [list, setList] = useState<OrderList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Each request for more orders, so an answer that arrives after the filter changed (or a newer request) is dropped.
  const moreRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetchAmazonSummary()
      .then((body) => {
        if (cancelled) return;
        setSummary(body);
        setSummaryError(null);
      })
      .catch((reason: unknown) => { if (!cancelled) setSummaryError(apiErrorMessage(reason)); });
    return () => { cancelled = true; };
  }, [attempt]);

  useEffect(() => {
    let cancelled = false;
    moreRequest.current += 1;
    setLoading(true);
    setLoadingMore(false);
    fetchAmazonOrders({ offset: 0, beneficiary: beneficiary || undefined })
      .then((page) => {
        if (cancelled) return;
        setList({ beneficiary, total: page.total, orders: page.orders });
        setListError(null);
      })
      .catch((reason: unknown) => { if (!cancelled) setListError(apiErrorMessage(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [beneficiary, attempt]);

  const shown = list !== null && list.beneficiary === beneficiary ? list : null;

  const loadMore = useCallback(() => {
    // While the first page reloads, the rows shown may be an older answer's: an offset taken from them could skip
    // or repeat orders once the new first page replaces them, so more waits for that page.
    if (!shown || loading) return;
    const request = ++moreRequest.current;
    setLoadingMore(true);
    fetchAmazonOrders({ offset: shown.orders.length, beneficiary: shown.beneficiary || undefined })
      .then((page) => {
        if (request !== moreRequest.current) return;
        setList((current) => (current && current.beneficiary === shown.beneficiary
          ? { ...current, total: page.total, orders: appendOrders(current.orders, page.orders) }
          : current));
        setListError(null);
      })
      .catch((reason: unknown) => { if (request === moreRequest.current) setListError(apiErrorMessage(reason)); })
      .finally(() => { if (request === moreRequest.current) setLoadingMore(false); });
  }, [shown, loading]);

  const retry = () => setAttempt((value) => value + 1);
  // No order at all (the API counts the same table either way): one empty state, not a list's. Production starts here.
  const nothingImported = (summary !== null && summary.orders === 0 && (shown === null || shown.total === 0))
    || (beneficiary === '' && shown !== null && shown.total === 0);
  const remaining = shown ? shown.total - shown.orders.length : 0;
  // Spending by item is asked for only once there are orders, and then stays, with the windows it has read.
  const [spendingMounted, setSpendingMounted] = useState(false);
  if (!spendingMounted && !nothingImported && ((summary?.orders ?? 0) > 0 || (shown?.total ?? 0) > 0)) setSpendingMounted(true);
  // The analysis follows the orders; this takes a reader there in one step, focus included.
  const goToSpending = () => {
    const title = document.getElementById(AMAZON_SPENDING_TITLE_ID);
    title?.scrollIntoView({ block: 'start' });
    title?.focus({ preventScroll: true });
  };

  // Purchases first: the summary, then the orders, then the analysis of what their items cost and were.
  return (
    <div className="amazon-orders" aria-busy={loading}>
      {summary && !nothingImported ? <SummaryPanel summary={summary} /> : null}
      {summaryError ? (
        <div className="spending-error amazon-error" role="alert">
          <span>Amazon summary: {summaryError}</span>
          <button type="button" className="spending-button" onClick={retry}>Try again</button>
        </div>
      ) : null}

      {nothingImported ? (
        <div className="spending-empty amazon-empty" role="status">
          <strong>No Amazon data imported yet</strong>
          <p>
            Orders from the household Amazon account appear here once a capture is imported. Card spending
            doesn't depend on them: card charges stay in Card transactions.
          </p>
        </div>
      ) : (
        <>
          <section className="amazon-order-section" aria-labelledby="amazon-orders-title">
            <header className="amazon-orders-head">
              <h3 id="amazon-orders-title" className="amazon-orders-title">Orders</h3>
              {spendingMounted ? (
                <button type="button" className="spending-link" onClick={goToSpending}>
                  Go to spending by item <span aria-hidden="true">↓</span>
                </button>
              ) : null}
            </header>
            <div className="spending-toolbar amazon-toolbar">
              <label className="spending-select">
                <span>For</span>
                <select value={beneficiary} onChange={(event) => setBeneficiary(event.target.value as AmazonBeneficiary | '')}>
                  <option value="">Everyone</option>
                  {AMAZON_BENEFICIARIES.map((value) => <option key={value} value={value}>{BENEFICIARY_LABELS[value]}</option>)}
                </select>
              </label>
              {shown ? (
                <span className="spending-muted" aria-live="polite">
                  {shown.total === 0 ? 'No orders' : `Showing ${shown.orders.length.toLocaleString('en-US')} of ${plural(shown.total, 'order')}`}
                </span>
              ) : null}
            </div>

            {listError ? (
              <div className="spending-error amazon-error" role="alert">
                <span>Amazon orders: {listError}</span>
                <button type="button" className="spending-button" onClick={retry}>Try again</button>
              </div>
            ) : null}
            {!shown && loading && !listError ? <p className="spending-muted" role="status">Loading Amazon orders…</p> : null}

            {shown && shown.total === 0 && beneficiary ? (
              <div className="spending-empty amazon-empty" role="status">
                <strong>No orders for {BENEFICIARY_LABELS[beneficiary]}</strong>
                <p>An order is for someone only when it was assigned explicitly; the others stay Unknown.</p>
              </div>
            ) : null}

            {shown && shown.orders.length > 0 ? (
              <>
                {shown.orders.some((order) => (order.items ?? []).some((item) => itemCategory(item).tone === 'agent')) ? (
                  <p className="spending-muted amazon-legend">{AMAZON_AGENT_EDGE_NOTE}</p>
                ) : null}
                <ol className="amazon-order-list" aria-label="Amazon orders">
                  {shown.orders.map((order) => (
                    <OrderCard key={order.ref} order={order} accountById={accountById} onOpenTransaction={onOpenTransaction} />
                  ))}
                </ol>
              </>
            ) : null}

            {shown && remaining > 0 ? (
              <button type="button" className="spending-button amazon-more" onClick={loadMore} disabled={loadingMore || loading}>
                {loadingMore ? 'Loading…' : `Show ${Math.min(AMAZON_PAGE_SIZE, remaining).toLocaleString('en-US')} more`}
              </button>
            ) : null}
          </section>
          {spendingMounted ? <AmazonSpendingPanel /> : null}
          {spendingMounted ? <AmazonTaxonomyPanel /> : null}
        </>
      )}
    </div>
  );
}

const FAMILIES: readonly AmazonCoverageFamily[] = ['orders', 'details', 'payments', 'refunds'];

/**
 * The orders first, in three figures: how many; card matches (Amazon payment records matched against card
 * transactions, not orders), how many are linked and how many need review; and refund observations, named as such
 * (each time one was seen, never a count of unique refunds). Their limit stays beside them (imported records only, and
 * a partial capture's history may be incomplete); how they were counted (what each count counts, the other counts, the
 * latest capture's coverage and the evidence revision) folds.
 */
function SummaryPanel({ summary }: { summary: AmazonSummary }) {
  const matches = cardMatchFigure(summary.linked, summary.held);
  const limit = summaryLimit(summary.latestCoverage);
  const figures: Array<{ label: string; value: string; note?: string }> = [
    { label: 'Orders', value: summary.orders.toLocaleString('en-US') },
    { label: 'Card matches', value: matches.value, note: matches.note },
    { label: 'Refund observations', value: summary.refundObservations.toLocaleString('en-US'),
      note: refundObservationNote(summary.issuedRefundObservations) },
  ];
  const coverage = summary.latestCoverage;
  return (
    <section className="spending-panel amazon-summary" aria-labelledby="amazon-summary-title">
      <header className="spending-panel-head">
        <h3 id="amazon-summary-title">Amazon order activity</h3>
        <span className="amazon-measure">Its own measure, by order date: not card spending</span>
      </header>
      <dl className="amazon-figures">
        {figures.map((figure) => (
          <div key={figure.label} className="amazon-figure">
            <dt>{figure.label}</dt>
            <dd>
              <span className="amazon-figure-value">{figure.value}</span>
              {figure.note ? <span className="amazon-figure-note">{figure.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {/* The figures' limit stays beside them; only how they were counted folds. */}
      <p className="amazon-limit" data-complete={limit.complete ? 'true' : undefined}>{limit.text}</p>
      <Disclosure className="amazon-fold amazon-counted" summary="How this was counted">
        <p className="spending-muted amazon-note">
          Order totals come from Amazon and are never added to card spending. Card matches count Amazon&apos;s payment
          records matched against card transactions, not orders: an order can have several. Refund observations count
          each time a refund was seen, so one refund can count more than once. Returns aren&apos;t captured yet, and a
          return alone isn&apos;t a refund.
        </p>
        <ul className="amazon-counted-lines">
          {summaryCountedLines(summary).map((line) => <li key={line}>{line}</li>)}
        </ul>
        {coverage ? (
          <p className="amazon-coverage">
            <span className="amazon-coverage-label">
              Coverage, latest of {plural(summary.captures, 'capture')}:
            </span>
            {FAMILIES.map((family) => {
              const entry = coverage[family];
              return (
                <span key={family} className="amazon-coverage-entry" data-status={entry?.status ?? 'unreported'}>
                  {coverageFamilyLabel(family)} {entry ? `${entry.status} · ${plural(entry.records, 'record')}` : 'not reported'}
                </span>
              );
            })}
          </p>
        ) : null}
        {summary.version ? <p className="amazon-version">Evidence revision {summary.version}</p> : null}
      </Disclosure>
    </section>
  );
}

function OrderCard({ order, accountById, onOpenTransaction }: {
  order: AmazonOrder;
  accountById: ReadonlyMap<string, CardAccount>;
  onOpenTransaction: (id: string) => void;
}) {
  // A list row of an API that doesn't carry items: its items load from the order's own answer, when asked for.
  const [loaded, setLoaded] = useState<AmazonOrder | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const items = order.items ?? loaded?.items;
  const titleId = `amazon-order-${order.ref}`;
  // A Whole Foods store's receipt says so; an ordinary Amazon order says nothing of where it was bought.
  const source = purchaseChannelText(order.purchaseChannel);

  const loadItems = () => {
    setLoadingItems(true);
    setItemsError(null);
    fetchAmazonOrder(order.ref)
      .then(setLoaded)
      .catch((reason: unknown) => setItemsError(apiErrorMessage(reason)))
      .finally(() => setLoadingItems(false));
  };

  return (
    <li className="amazon-order" data-order={order.ref}>
      <article aria-labelledby={titleId}>
        <header className="amazon-order-head">
          <h4 id={titleId} className="amazon-order-date">
            <a href={amazonOrderHref(order.ref)} aria-label={`Amazon order of ${longDate(order.date)}`}>{longDate(order.date)}</a>
          </h4>
          <span className="amazon-order-total">{order.total ? formatMoney(order.total) : 'Total not captured'}</span>
          {source ? <div className="amazon-order-source">{source}</div> : null}
          <div className="amazon-order-for">For: {BENEFICIARY_LABELS[order.beneficiary]}</div>
        </header>
        {items ? (
          <Items items={items} itemCount={order.itemCount} detailed={false} />
        ) : loaded ? (
          <p className="spending-muted">Items not reported</p>
        ) : order.itemCount > 0 ? (
          <div className="amazon-items-pending">
            <button type="button" className="spending-button" onClick={loadItems} disabled={loadingItems} aria-describedby={titleId}>
              {loadingItems ? 'Loading items…' : `Show ${plural(order.itemCount, 'item')}`}
            </button>
            {itemsError ? <span className="spending-error" role="alert">{itemsError}</span> : null}
          </div>
        ) : (
          <p className="spending-muted">No items observed</p>
        )}
        {/* One plain line for the card match; its payment, refunds and evidence are on the order's own page. */}
        <MatchStatus matches={order.matches} accountById={accountById} onOpenTransaction={onOpenTransaction} />
      </article>
    </li>
  );
}

/**
 * An order's card match in one plain line: "Linked to a card transaction", with the card and a way to open the
 * transaction (the order's charge or a refund credit: the answer doesn't say which); "Card match needs review" (any
 * match held); "No card match"; or "Card match not reported". Never a candidate transaction.
 */
function MatchStatus({ matches, accountById, onOpenTransaction }: {
  matches: AmazonMatch[] | undefined;
  accountById: ReadonlyMap<string, CardAccount>;
  onOpenTransaction: (id: string) => void;
}) {
  const { status, text, linked } = orderMatchStatus(matches);
  return (
    <div className="amazon-order-status" data-status={status}>
      <span className="amazon-order-status-text">{text}</span>
      {linked.length > 0 ? (
        <>
          {' '}
          {status === 'review' ? <><span className="amazon-order-also">Also linked:</span>{' '}</> : null}
          {linked.map((match, index) => {
            const card = cardNameLabel(accountById.get(match.cardAccountId));
            // The spaces are for reading and copied text (none after the last); the flex gap lays out.
            return (
              <span key={match.cardTransactionId} className="amazon-order-charge">
                {index > 0 ? ' ' : null}
                <span className="amazon-order-card">{card}</span>{' '}
                <button
                  type="button"
                  className="spending-link inline"
                  aria-label={`Open card transaction, ${card}`}
                  onClick={() => onOpenTransaction(match.cardTransactionId)}
                >
                  Open transaction
                </button>
              </span>
            );
          })}
        </>
      ) : null}
    </div>
  );
}

/**
 * Why the order's card match reads as it does, folded under "Why?" on its page: how each linked charge was tied (in
 * Spending's own words), and why each hold needs review with how many card charges were candidates (never which),
 * holds alike once with how many there were.
 */
function MatchWhy({ matches, accountById }: { matches: AmazonMatch[] | undefined; accountById: ReadonlyMap<string, CardAccount> }) {
  if (!matches || matches.length === 0) return null;
  const held = matches.some((match) => match.state === 'held');
  return (
    <Disclosure className="amazon-fold amazon-why" summary="Why?" label="Why? How this card match was decided">
      <ul className="amazon-why-list">
        {groupMatches(matches).map(({ match, count }, index) => {
          if (match.state === 'held') {
            // The spaces are for reading and for copied text.
            return (
              <li key={`held-${index}`} className="amazon-why-match" data-tone="held" data-count={count > 1 ? count : undefined}>
                <span className="amazon-why-state">Needs review:</span>{' '}
                <span>{heldReasonText(match.reason)}</span>{' '}
                <span className="amazon-match-count">({candidateText(match.candidateCount)})</span>
                {count > 1 ? (
                  <>
                    {' '}
                    <span className="amazon-match-times">
                      <span aria-hidden="true">{`×${count}`}</span>
                      <span className="visually-hidden">{` (${count} times)`}</span>
                    </span>
                  </>
                ) : null}
              </li>
            );
          }
          const card = cardNameLabel(accountById.get(match.cardAccountId));
          return (
            <li key={match.cardTransactionId} className="amazon-why-match" data-tone="linked">
              <span className="amazon-why-state">Linked:</span>{' '}
              <span className="amazon-match-card">{`${card},`}</span>{' '}
              <span className="amazon-match-evidence">{amazonEvidenceText(match.evidenceClass)}</span>
            </li>
          );
        })}
      </ul>
      {held ? (
        <p className="spending-muted">
          A match that needs review shows why and how many card charges could match, never which. Until it is linked, no
          card transaction is filed under the order&apos;s items through it.
        </p>
      ) : null}
    </Disclosure>
  );
}

function Items({ items, itemCount, detailed }: { items: AmazonItem[]; itemCount: number; detailed: boolean }) {
  if (items.length === 0) {
    return (
      <p className="spending-muted">
        {itemCount > 0 ? `${plural(itemCount, 'item')} observed; their lines weren't kept by this capture` : 'No items observed'}
      </p>
    );
  }
  return (
    <ul className="amazon-items" aria-label="Items">
      {items.map((item) => {
        const category = itemCategory(item);
        return (
          <li key={item.ref} className="amazon-item">
            <AmazonItemThumb itemRef={item.ref} image={item.image} size={detailed ? 'large' : 'medium'} />
            <span className="amazon-item-title" dir="auto">
              {item.title ?? <em className="amazon-hidden-title">Title hidden: it looked like card details</em>}
            </span>
            <span className="amazon-item-meta">
              {item.quantity !== null ? <span>Qty {item.quantity.toLocaleString('en-US')}</span> : null}
              {detailed && item.unitPrice ? <span>{formatMoney(item.unitPrice)} each</span> : null}
              {detailed && item.unitPrice === null ? <span>Price not captured</span> : null}
              {detailed && item.asin ? <span>ASIN {item.asin}</span> : null}
            </span>
            <AmazonCategoryTag name={category.name} source={category.source} tone={category.tone}
              fromTitle={!detailed && category.tone === 'agent'} />
          </li>
        );
      })}
    </ul>
  );
}

function AmazonOrderPage({ orderRef, accountById, onOpenTransaction }: {
  orderRef: string;
  accountById: ReadonlyMap<string, CardAccount>;
  onOpenTransaction: (id: string) => void;
}) {
  const [order, setOrder] = useState<AmazonOrder | null>(null);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAmazonOrder(orderRef)
      .then((body) => {
        if (cancelled) return;
        setOrder(body);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError({ notFound: reason instanceof ApiError && reason.status === 404, message: apiErrorMessage(reason) });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orderRef, attempt]);

  return (
    <article className="amazon-page" aria-labelledby="amazon-page-title" aria-busy={loading}>
      <a className="spending-link amazon-back" href={AMAZON_LIST_HREF}>
        <span aria-hidden="true">←</span> All Amazon orders
      </a>
      {error?.notFound ? (
        <div className="spending-empty amazon-empty" role="status">
          <strong id="amazon-page-title">This Amazon order isn&apos;t in Holdr</strong>
          <p>It may come from a capture that hasn&apos;t been imported here.</p>
        </div>
      ) : null}
      {error && !error.notFound ? (
        <div className="spending-error amazon-error" role="alert">
          <span>Amazon order: {error.message}</span>
          <button type="button" className="spending-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      ) : null}
      {!order && loading ? <p className="spending-muted" role="status">Loading the order…</p> : null}
      {order && !error?.notFound ? <OrderDetails order={order} accountById={accountById} onOpenTransaction={onOpenTransaction} /> : null}
    </article>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="spending-panel amazon-section" aria-labelledby={id}>
      <header className="spending-panel-head"><h4 id={id}>{title}</h4></header>
      {children}
    </section>
  );
}

function OrderDetails({ order, accountById, onOpenTransaction }: {
  order: AmazonOrder;
  accountById: ReadonlyMap<string, CardAccount>;
  onOpenTransaction: (id: string) => void;
}) {
  const source = purchaseChannelText(order.purchaseChannel);
  return (
    <>
      <header className="spending-panel amazon-page-head">
        <div className="amazon-page-title-row">
          <h3 id="amazon-page-title">Amazon order · {longDate(order.date)}</h3>
          <span className="amazon-order-total">{order.total ? formatMoney(order.total) : 'Total not captured'}</span>
        </div>
        <p className="spending-muted">
          Amazon&apos;s order date and total: its own measure, never added to card spending.
        </p>
        <dl className="amazon-page-facts">
          {source ? <div><dt>Source</dt><dd>{source}</dd></div> : null}
          <div><dt>For</dt><dd>{BENEFICIARY_LABELS[order.beneficiary]}</dd></div>
          <div><dt>Payment</dt><dd>{tenderText(order.tenderCoverage)}</dd></div>
          <div><dt>Items observed</dt><dd>{order.itemCount.toLocaleString('en-US')}</dd></div>
          <div><dt>Refunds</dt><dd>{refundCountText(order.refunds)}</dd></div>
        </dl>
      </header>

      <Section id="amazon-page-items" title="Items">
        {order.items ? <Items items={order.items} itemCount={order.itemCount} detailed /> : <p className="spending-muted">Items not reported</p>}
      </Section>

      <Section id="amazon-page-match" title="Card match">
        <MatchStatus matches={order.matches} accountById={accountById} onOpenTransaction={onOpenTransaction} />
        <MatchWhy matches={order.matches} accountById={accountById} />
      </Section>

      <Section id="amazon-page-payment" title="Payment">
        <Payment methods={order.paymentMethods} lines={order.summary} />
      </Section>

      <Section id="amazon-page-refunds" title="Refunds">
        <Refunds refunds={order.refunds} />
      </Section>
    </>
  );
}

function Payment({ methods, lines }: { methods: AmazonPaymentMethod[] | undefined; lines: AmazonSummaryLine[] | undefined }) {
  const cards = methods?.filter((method) => method.kind === 'card') ?? [];
  const others = methods?.filter((method) => method.kind !== 'card') ?? [];
  const nonCardLines = lines?.filter((line) => NON_CARD_LINES.has(line.kind)) ?? [];
  return (
    <div className="amazon-payment">
      <div className="amazon-payment-group">
        <h5>Paid with</h5>
        {methods === undefined ? <p className="spending-muted">Payment methods not reported</p>
          : cards.length === 0 ? <p className="spending-muted">No card captured</p>
            : <ul>{cards.map((method, index) => <li key={index}>{paymentMethodText(method)}</li>)}</ul>}
      </div>
      {others.length > 0 || nonCardLines.length > 0 ? (
        <div className="amazon-payment-group amazon-non-card">
          <h5>Gift card, balance and points <span className="amazon-measure">not card spending</span></h5>
          <ul>
            {others.map((method, index) => <li key={`method-${index}`}>{paymentMethodText(method)}</li>)}
            {nonCardLines.map((line) => {
              const text = summaryLineText(line);
              return <li key={line.kind}>{text.label} <span className="amazon-amount">{text.amount}</span></li>;
            })}
          </ul>
        </div>
      ) : null}
      <div className="amazon-payment-group">
        <h5>Order summary</h5>
        {lines === undefined ? <p className="spending-muted">Order summary not reported</p>
          : lines.length === 0 ? <p className="spending-muted">No order summary captured</p> : (
            <dl className="amazon-lines">
              {lines.map((line) => {
                const text = summaryLineText(line);
                return (
                  <div key={line.kind} data-kind={line.kind}>
                    <dt>{text.label}</dt>
                    <dd className="amazon-amount">{text.amount}</dd>
                  </div>
                );
              })}
            </dl>
          )}
      </div>
    </div>
  );
}

function Refunds({ refunds }: { refunds: AmazonRefund[] | undefined }) {
  if (refunds === undefined) return <p className="spending-muted">Refunds not reported</p>;
  return (
    <>
      {refunds.length === 0 ? <p className="spending-muted">No refunds observed for this order</p> : (
        <ul className="amazon-refunds">
          {refunds.map((refund) => (
            <li key={refund.ref} data-status={refund.status} data-destination={refund.destination}>
              <span>{refundText(refund)}</span>
              {refund.date ? <span className="spending-muted">{longDate(refund.date)}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="spending-muted">
        A refund to the Amazon balance or points never reduces card spending. Returns aren&apos;t captured yet.
      </p>
    </>
  );
}
