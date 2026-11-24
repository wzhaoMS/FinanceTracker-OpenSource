import { useEffect, useState } from 'react';
import { AMAZON_TAXONOMY_NEEDS_REVIEW, type AmazonTaxonomyNodeId } from '@finance-tracker/shared';

import { ApiError } from '../../services/api';
import { categoryTone } from '../../modes/category';
import { Disclosure } from '../Disclosure';
import { apiErrorMessage } from '../spending/spendingApi';
import { dateRangeLabel, formatMinor, longDate, todayIso } from '../spending/spendingFormat';
import { AMAZON_SPENDING_WINDOWS, type AmazonSpendingWindow } from './amazonApi';
import { SPENDING_WINDOW_WORDS, amazonOrderHref, formatMoney, plural, purchaseChannelText, shareText, spendingWindowPhrase } from './amazonFormat';
import {
  fetchAmazonFresh,
  fetchAmazonFreshOrder,
  type AmazonFresh,
  type AmazonFreshCategory,
  type AmazonFreshLine,
  type AmazonFreshOrder,
  type AmazonFreshOrderSummary,
  type AmazonFreshProduct,
  type AmazonFreshPurchase,
} from './amazonFreshApi';
import {
  andList,
  emptyGroceryLabels,
  freshCategoryLabel,
  freshCategoryRows,
  freshCurrency,
  freshListText,
  freshMayMissText,
  freshMeasureText,
  freshNetDetailText,
  freshOrderTotalsNote,
  freshPricedIn,
  freshProductMeasureText,
  freshTotalsCaptured,
  freshTotalsMissingText,
  freshUnitPriceText,
  groceryLabels,
  orList,
} from './amazonFreshFormat';
import { taxonomyPathText, taxonomySourceText } from './amazonTaxonomyFormat';
import { AmazonCategoryTag } from './AmazonCategoryTag';

/** Items shown before "Show all", each item's purchases before "Show all purchases", and orders before "Show more". */
const TOP_ITEMS = 10;
const TOP_PURCHASES = 3;
const ORDER_PAGE = 10;

/**
 * The Amazon area's Amazon Fresh tab: the household's Fresh orders over a window and what their items were, by grocery
 * subcategory (Meat & Seafood, Dairy & Eggs, Snacks & Sweets, …) and what else was bought on Fresh (Household
 * Supplies, …), each item with every purchase (its weight or quantity, unit price, price and order date), refunds
 * taken off, and each order's Item List. From GET /amazon/fresh: Amazon's own measure by order date, never card
 * spending, and never added to it. The net item cost leads, saying beside it that it excludes tax, delivery and tips,
 * with how it adds up under it; how many orders may be missing items stays in view, and the rest of what the figures
 * may miss folds under "What may be missing"; the orders' own totals come apart, as another measure. Before any Fresh
 * Item List was imported it says so; until a classification is imported every item is under Not yet classified. An
 * API without this read says Amazon Fresh isn't available.
 */
export function AmazonFreshPanel() {
  const [shownWindow, setShownWindow] = useState<AmazonSpendingWindow>('1Y');
  const [answers, setAnswers] = useState<Partial<Record<AmazonSpendingWindow, AmazonFresh>>>({});
  const [failure, setFailure] = useState<{ window: AmazonSpendingWindow; message: string } | null>(null);
  const [unreported, setUnreported] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Kept across windows, to compare one category's items over them.
  const [selected, setSelected] = useState<AmazonTaxonomyNodeId | null>(null);
  const answer = answers[shownWindow];
  const failed = failure?.window === shownWindow ? failure : null;

  useEffect(() => {
    if (answer || unreported || failed) return undefined;
    let cancelled = false;
    const requested = shownWindow;
    fetchAmazonFresh(requested, todayIso())
      .then((body) => { if (!cancelled) setAnswers((current) => ({ ...current, [requested]: body })); })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 404) setUnreported(true);
        else setFailure({ window: requested, message: apiErrorMessage(reason) });
      });
    return () => { cancelled = true; };
  }, [shownWindow, attempt, answer, unreported, failed]);

  const loading = !answer && !failed && !unreported;
  return (
    <section className="spending-panel amazon-spending amazon-fresh" aria-labelledby="amazon-fresh-title" aria-busy={loading}>
      <header className="spending-panel-head amazon-spending-head">
        <h3 id="amazon-fresh-title">Amazon Fresh</h3>
        {unreported ? null : (
          <div className="spending-periods" role="group" aria-label="Period">
            {AMAZON_SPENDING_WINDOWS.map((key) => (
              <button
                key={key}
                type="button"
                className={`spending-period${shownWindow === key ? ' active' : ''}`}
                aria-pressed={shownWindow === key}
                title={SPENDING_WINDOW_WORDS[key].title}
                onClick={() => setShownWindow(key)}
              >
                {SPENDING_WINDOW_WORDS[key].label}
              </button>
            ))}
          </div>
        )}
      </header>
      {unreported ? (
        <p className="spending-muted" role="status">Amazon Fresh isn&apos;t available in this version of Holdr.</p>
      ) : (
        <p className="amazon-spending-measure">
          <span className="amazon-measure">Fresh item prices by order date: not card spending</span>
          {answer ? <span className="spending-muted">{dateRangeLabel(answer.window.from, answer.window.to)}</span> : null}
        </p>
      )}
      {failed ? (
        <div className="spending-error amazon-error" role="alert">
          <span>Amazon Fresh: {failed.message}</span>
          <button type="button" className="spending-button" onClick={() => { setFailure(null); setAttempt((value) => value + 1); }}>
            Try again
          </button>
        </div>
      ) : null}
      {loading ? <p className="spending-muted" role="status">Loading Amazon Fresh…</p> : null}
      {answer ? <FreshWindow fresh={answer} selected={selected} onSelect={setSelected} /> : null}
    </section>
  );
}

function FreshWindow({ fresh, selected, onSelect }: {
  fresh: AmazonFresh;
  selected: AmazonTaxonomyNodeId | null;
  onSelect: (value: AmazonTaxonomyNodeId | null) => void;
}) {
  if (!fresh.captured) {
    return (
      <div className="spending-empty amazon-empty amazon-fresh-empty" role="status">
        <strong>Amazon Fresh items haven&apos;t been captured yet</strong>
        <p>
          Fresh orders show here, with what was in them by grocery category, once their Item Lists are captured and
          imported. Until then they count with every other order under Amazon orders, by their order totals.
        </p>
      </div>
    );
  }
  const phrase = spendingWindowPhrase(fresh.window);
  const currency = freshCurrency(fresh);
  const total = currency ? fresh.totals.find((entry) => entry.currency === currency) : undefined;
  if (fresh.orders.count === 0) {
    return <p className="spending-muted" role="status">{`No Amazon Fresh orders ${phrase}.`}</p>;
  }
  if (!currency || !total) {
    // Orders, but neither a total nor a priced item of any of them: say so, and still list them.
    return (
      <>
        <p className="spending-muted" role="status">
          {`${plural(fresh.orders.count, 'Amazon Fresh order')} ${phrase}, but no order total or item price of ${fresh.orders.count === 1 ? 'it' : 'them'} was captured yet.`}
        </p>
        <FreshOrders fresh={fresh} />
      </>
    );
  }
  const { orders, lines } = fresh;
  // The answer counts items and orders across the window's currencies: a window-wide count sits beside an amount only
  // when it has one currency.
  const single = fresh.totals.length === 1;
  // Whether an item price, or an order total, was captured in this currency, from its own evidence: unknown is said,
  // never shown as $0.00, and a captured $0.00 is shown as such.
  const { priced: pricedHere, unclassified: unclassifiedHere } = freshPricedIn(fresh, currency);
  const itemsKnown = pricedHere > 0;
  const totalsCaptured = freshTotalsCaptured(fresh, currency);
  // What refunds took off the items: tied to items or not (the second lowers only the total, never a category).
  const taken = total.lineRefundMinor + total.unattributedRefundMinor;
  const split = [
    { label: 'Groceries', value: formatMinor(total.groceryMinor, currency),
      note: total.lineMinor > 0 ? `${shareText(total.groceryMinor, total.lineMinor)} of item prices, before refunds` : 'before refunds' },
    { label: 'Not yet classified', value: formatMinor(total.needsReviewMinor, currency),
      note: unclassifiedHere > 0 ? `${plural(unclassifiedHere, 'item')} not classified yet`
        : single ? 'every item classified' : `every ${currency} item classified` },
  ];
  const mayMiss = freshMayMissText(orders);
  const incomplete = orders.count - orders.complete - orders.noLines;
  const coverage = [
    fresh.assignments === 'absent' ? `No classification has been imported yet, so every Fresh item is under Not yet classified. Once classified, groceries count under ${andList(groceryLabels())}, and household items under Household Supplies.` : null,
    orders.noLines > 0 ? `Items not captured yet for ${plural(orders.noLines, 'order')}: no line of ${orders.noLines === 1 ? 'its' : 'their'} Item List could be read. ${orders.noLines === 1 ? 'Its order total' : 'Their order totals'} still count.` : null,
    incomplete > 0 ? `${plural(incomplete, 'order')} ${incomplete === 1 ? 'has an Item List' : 'have Item Lists'} not proven complete, so ${incomplete === 1 ? 'it' : 'they'} may have more items than counted.` : null,
    lines.unreadable > 0 ? `${plural(lines.unreadable, 'stored item line')} couldn't be read and ${lines.unreadable === 1 ? 'isn\'t' : 'aren\'t'} counted.` : null,
    lines.missing > 0 ? `${plural(lines.missing, 'item')} marked missing (not delivered) cost nothing here.` : null,
    lines.substituted > 0 ? `${plural(lines.substituted, 'item')} delivered as a substitute, at ${lines.substituted === 1 ? 'its' : 'their'} own price.` : null,
    lines.estimated > 0 ? `${plural(lines.estimated, 'weight')} ${lines.estimated === 1 ? 'is' : 'are'} Amazon's estimate.` : null,
    total.suggestedMinor > 0 ? `${formatMinor(total.suggestedMinor, currency)} of the classified items is only suggested by the classifier.` : null,
    total.refundMinor > 0 ? `Amazon refunded ${formatMinor(total.refundMinor, currency)} for these orders in all, tax and delivery included; a refund counts in its order's window.` : null,
    ...fresh.totals.filter((entry) => entry.currency !== currency && (entry.lineMinor > 0 || entry.orderTotalMinor > 0))
      .map((entry) => `Also ${formatMinor(entry.lineMinor, entry.currency)} of Fresh items in ${entry.currency}, not converted.`),
  ].filter((line): line is string => line !== null);
  const rows = freshCategoryRows(fresh, currency);
  const empty = fresh.assignments === 'present' ? emptyGroceryLabels(fresh, currency) : [];
  return (
    <>
      <div className="amazon-fresh-summary">
        <dl className="amazon-figures amazon-fresh-lead">
          <div className="amazon-figure" data-figure={itemsKnown ? 'net' : 'unknown'}>
            <dt>Net item cost</dt>
            {itemsKnown ? (
              <dd>
                <span className="amazon-figure-value">{formatMinor(total.netLineMinor, currency)}</span>
                <span className="amazon-figure-note">excludes tax, delivery and tips</span>
              </dd>
            ) : (
              <dd>
                <span className="amazon-figure-value amazon-figure-unknown">Not captured</span>
                <span className="amazon-figure-note">{single ? 'no item price was captured for these orders' : `no item price in ${currency}`}</span>
              </dd>
            )}
          </div>
        </dl>
        {itemsKnown ? (
          <p className="amazon-fresh-net-detail">
            {freshNetDetailText(total, taken, pricedHere, single ? orders.refunded : null, currency)}
          </p>
        ) : null}
        {mayMiss || coverage.length > 0 ? (
          <div className="amazon-fresh-gaps">
            {mayMiss ? <p className="amazon-fresh-gap">{mayMiss}.</p> : null}
            {coverage.length > 0 ? (
              <Disclosure className="amazon-fold" summary="What may be missing">
                <ul className="amazon-spending-coverage" aria-label="What these figures cover">
                  {coverage.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </Disclosure>
            ) : null}
          </div>
        ) : null}
        {itemsKnown ? (
          <dl className="amazon-figures amazon-fresh-split">
            {split.map((figure) => (
              <div key={figure.label} className="amazon-figure">
                <dt>{figure.label}</dt>
                <dd>
                  <span className="amazon-figure-value">{figure.value}</span>
                  <span className="amazon-figure-note">{figure.note}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {/* The orders' own totals, apart from what their items cost: another measure, with tax, delivery and tips. */}
        <div className="amazon-fresh-totals">
          <span className="amazon-fresh-totals-label">Order totals</span>{' '}
          {totalsCaptured === 'captured' ? (
            <>
              <span className="amazon-fresh-totals-value">{formatMinor(total.orderTotalMinor, currency)}</span>{' '}
              <span>{freshOrderTotalsNote(orders, single)}</span>
            </>
          ) : <span>{freshTotalsMissingText(totalsCaptured, single, currency)}</span>}
        </div>
      </div>
      <div className="spending-breakdowns amazon-spending-breakdowns">
        <section className="amazon-spending-part" aria-labelledby="amazon-fresh-categories">
          <h4 id="amazon-fresh-categories">By grocery category, after refunds</h4>
          {rows.length > 0 ? (
            <CategoryList rows={rows} currency={currency} selected={selected} unattributed={total.unattributedRefundMinor}
              onPick={(row) => onSelect(selected === row.category ? null : row.category)} />
          ) : <p className="spending-muted">No priced items {phrase}.</p>}
          {empty.length > 0 && rows.length > 0 ? <p className="spending-muted">{`Nothing in ${orList(empty)} ${phrase}.`}</p> : null}
        </section>
        <FreshItems fresh={fresh} currency={currency} selected={selected} onSelect={onSelect} />
      </div>
      <FreshOrders fresh={fresh} />
    </>
  );
}

/** Rows ranked after refunds, groceries first; `unattributed`: refunds tied to no item, which lower the total, never a row. */
function CategoryList({ rows, currency, selected, unattributed, onPick }: {
  rows: AmazonFreshCategory[];
  currency: string;
  selected: AmazonTaxonomyNodeId | null;
  unattributed: number;
  onPick: (row: AmazonFreshCategory) => void;
}) {
  const total = rows.reduce((sum, row) => sum + row.netMinor, 0);
  const max = Math.max(1, ...rows.map((row) => row.netMinor));
  return (
    <ul className="spending-rank amazon-spending-categories amazon-fresh-categories" aria-label="Fresh categories, groceries first">
      {rows.map((row) => {
        const name = freshCategoryLabel(row.category);
        const pressed = selected === row.category;
        return (
          <li key={row.category} data-group={row.group}
            data-category-tone={row.category === AMAZON_TAXONOMY_NEEDS_REVIEW ? 'none' : categoryTone(name)}>
            <button type="button" className={`spending-rank-row${pressed ? ' selected' : ''}`} aria-pressed={pressed} onClick={() => onPick(row)}>
              <span className="spending-rank-name">{name}</span>
              <span className="spending-rank-bar" aria-hidden>
                <span style={{ width: `${Math.max(0, row.netMinor / max) * 100}%` }} />
              </span>
              <span className="spending-rank-amount num">{formatMinor(row.netMinor, currency)}</span>
              <span className="spending-rank-share num">{shareText(row.netMinor, total)}</span>
              <span className="spending-rank-note">
                {[plural(row.lines, 'item'), plural(row.orders, 'order'),
                  row.refundMinor > 0 ? `${formatMinor(row.refundMinor, currency)} refunded of ${formatMinor(row.amountMinor, currency)}` : null]
                  .filter((part): part is string => part !== null).join(' · ')}
              </span>
            </button>
          </li>
        );
      })}
      {unattributed > 0 ? (
        <li className="amazon-unattributed-refunds">
          <span className="spending-rank-name">Refunded, not tied to an item</span>
          <span className="spending-rank-amount num">{`−${formatMinor(unattributed, currency)}`}</span>
          <span className="spending-rank-note">Taken off the total only: Amazon&apos;s records don&apos;t prove which items</span>
        </li>
      ) : null}
    </ul>
  );
}

function FreshItems({ fresh, currency, selected, onSelect }: {
  fresh: AmazonFresh;
  currency: string;
  selected: AmazonTaxonomyNodeId | null;
  onSelect: (value: AmazonTaxonomyNodeId | null) => void;
}) {
  const row = selected === null ? undefined : fresh.categories.find((entry) => entry.currency === currency && entry.category === selected);
  const products = fresh.products.filter((product) => product.currency === currency && (selected === null || product.category === selected));
  const name = selected === null ? null : freshCategoryLabel(selected);
  const review = selected === AMAZON_TAXONOMY_NEEDS_REVIEW;
  const label = name ? `Items in ${name}, largest first` : 'Fresh items, largest first';
  return (
    <section className="amazon-spending-part" aria-labelledby="amazon-fresh-items">
      <div className="amazon-spending-part-head">
        <h4 id="amazon-fresh-items">{review ? 'Not yet classified: what each item is' : name ? `Items in ${name}` : 'Largest Fresh items'}</h4>
        {selected !== null ? <button type="button" className="spending-link inline" onClick={() => onSelect(null)}>Every category</button> : null}
      </div>
      {review ? (
        <p className="spending-muted">
          Nothing here is guessed: each item shows its full name, and the classifier&apos;s best guess when it had one. They
          count in a category once a classification is imported for them.
        </p>
      ) : null}
      {selected !== null && !row ? <p className="spending-muted">{`No items in ${name} ${spendingWindowPhrase(fresh.window)}.`}</p> : (
        <ProductList products={products} all={row?.products ?? null} label={label} />
      )}
    </section>
  );
}

/** `all`: how many items the list's category holds, when the API says (the list may be capped). */
function ProductList({ products, all, label }: { products: AmazonFreshProduct[]; all: number | null; label: string }) {
  const [showAll, setShowAll] = useState(false);
  if (products.length === 0) {
    return <p className="spending-muted">{all ? `Its ${plural(all, 'item')} aren't among the largest listed; the totals count them all.` : 'No priced items.'}</p>;
  }
  const shown = showAll ? products : products.slice(0, TOP_ITEMS);
  return (
    <>
      <ol className="amazon-spend-items" aria-label={label}>
        {shown.map((product) => <ProductRow key={product.ref} product={product} />)}
      </ol>
      {all !== null && products.length < all ? (
        <p className="spending-muted">{`Listing the ${products.length.toLocaleString('en-US')} largest of ${plural(all, 'item')}; the totals count them all.`}</p>
      ) : null}
      {products.length > TOP_ITEMS ? (
        <button type="button" className="spending-link" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? `Show the top ${TOP_ITEMS}` : `Show all ${plural(products.length, 'item')}`}
        </button>
      ) : null}
    </>
  );
}

function ProductRow({ product }: { product: AmazonFreshProduct }) {
  const review = product.category === AMAZON_TAXONOMY_NEEDS_REVIEW;
  const tone = review ? 'uncategorized' : product.source === 'owner' ? 'user' : 'agent';
  const refunded = product.refundMinor > 0;
  const measure = freshProductMeasureText(product);
  return (
    <li className="amazon-spend-item amazon-fresh-item"
      data-refunded={refunded ? (product.refundMinor >= product.amountMinor ? 'whole' : 'part') : undefined}>
      <span className="amazon-item-title amazon-spend-title" dir="auto" title={product.title ?? undefined}>
        {product.title ?? <em className="amazon-hidden-title">Title hidden: it looked like card details</em>}
      </span>
      <span className="amazon-spend-amount">
        {refunded ? (
          <>
            <s className="amazon-spend-gross" aria-label={`${formatMinor(product.amountMinor, product.currency)} before refunds`}>
              {formatMinor(product.amountMinor, product.currency)}
            </s>{' '}
          </>
        ) : null}
        {formatMinor(product.netMinor, product.currency)}
      </span>
      <span className="amazon-item-meta">
        {measure ? <span>{measure}</span> : null}
        {product.lastUnitPrice ? <span>{`latest ${freshUnitPriceText(product.lastUnitPrice)}`}</span> : null}
        <span>{plural(product.orders, 'order')}</span>
        {product.asin ? <span>ASIN {product.asin}</span> : null}
      </span>
      <AmazonCategoryTag name={review ? 'Not yet classified' : taxonomyPathText(product.node)}
        source={review && product.source === null && product.suggestion === null ? '' : taxonomySourceText(product)} tone={tone}
        fromTitle={product.source === 'agent' && !review}>
        {product.suggested ? <span className="amazon-taxonomy-badge">Suggested</span> : null}
      </AmazonCategoryTag>
      <Purchases product={product} />
    </li>
  );
}

function Purchases({ product }: { product: AmazonFreshProduct }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? product.purchases : product.purchases.slice(0, TOP_PURCHASES);
  const name = product.title ?? 'this item';
  return (
    <div className="amazon-purchases">
      <ul aria-label={`Purchases of ${name}, latest first`}>
        {shown.map((purchase) => <PurchaseRow key={purchase.ref} purchase={purchase} currency={product.currency} />)}
      </ul>
      {product.purchases.length > TOP_PURCHASES ? (
        <button type="button" className="spending-link inline" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show the latest purchases' : `Show all ${plural(product.purchases.length, 'purchase')}`}
        </button>
      ) : null}
      {product.purchases.length < product.lines ? (
        <span className="spending-muted">{`Latest ${product.purchases.length.toLocaleString('en-US')} of ${plural(product.lines, 'purchase')}`}</span>
      ) : null}
    </div>
  );
}

function PurchaseRow({ purchase, currency }: { purchase: AmazonFreshPurchase; currency: string }) {
  const measure = freshMeasureText(purchase);
  return (
    <li>
      <a href={amazonOrderHref(purchase.orderRef)} aria-label={`Amazon order of ${longDate(purchase.orderDate)}`}>{longDate(purchase.orderDate)}</a>
      {measure ? <span className="amazon-fresh-measure">{measure}</span> : null}
      <span className="amazon-amount">{formatMinor(purchase.amountMinor, currency)}</span>
      {purchase.status === 'substituted' ? <span className="amazon-fact">Substitute</span> : null}
      {purchase.refundMinor > 0 ? <span className="amazon-fact" data-tone="refund">{`Refunded ${formatMinor(purchase.refundMinor, currency)}`}</span> : null}
    </li>
  );
}

function FreshOrders({ fresh }: { fresh: AmazonFresh }) {
  const [shown, setShown] = useState(ORDER_PAGE);
  const list = fresh.orderList.slice(0, shown);
  // A Whole Foods store's receipt reads like a Fresh list, but it's no Fresh order: the list says it holds both.
  const stores = fresh.orderList.some((order) => purchaseChannelText(order.purchaseChannel) !== null);
  return (
    <section className="amazon-spending-part amazon-fresh-orders" aria-labelledby="amazon-fresh-orders-title">
      <h4 id="amazon-fresh-orders-title">{stores ? 'Fresh and Whole Foods orders, newest first' : 'Fresh orders, newest first'}</h4>
      <ol className="amazon-fresh-order-list" aria-label={stores ? 'Amazon Fresh and Whole Foods orders' : 'Amazon Fresh orders'}>
        {list.map((order) => <FreshOrderRow key={order.ref} order={order} />)}
      </ol>
      {fresh.orderList.length > shown ? (
        <button type="button" className="spending-button amazon-more" onClick={() => setShown((value) => value + ORDER_PAGE)}>
          {`Show ${Math.min(ORDER_PAGE, fresh.orderList.length - shown).toLocaleString('en-US')} more`}
        </button>
      ) : null}
      {fresh.orderList.length < fresh.orders.count ? (
        <p className="spending-muted">{`Listing the newest ${fresh.orderList.length.toLocaleString('en-US')} of ${plural(fresh.orders.count, 'order')}; the figures count them all.`}</p>
      ) : null}
    </section>
  );
}

function FreshOrderRow({ order }: { order: AmazonFreshOrderSummary }) {
  const [open, setOpen] = useState(false);
  const titleId = `amazon-fresh-order-${order.ref}`;
  const source = purchaseChannelText(order.purchaseChannel);
  const net = order.lineTotal && order.refund && order.refund.currency === order.lineTotal.currency
    ? order.lineTotal.amountMinor - order.refund.lineRefundMinor - order.refund.unattributedMinor : null;
  return (
    <li className="amazon-fresh-order" data-order={order.ref}>
      <article aria-labelledby={titleId}>
        <div className="amazon-order-head">
          <h5 id={titleId} className="amazon-order-date">
            <a href={amazonOrderHref(order.ref)} aria-label={`Amazon order of ${longDate(order.date)}`}>{longDate(order.date)}</a>
          </h5>
          <span className="amazon-order-total">{order.total ? formatMoney(order.total) : 'Total not captured'}</span>
          {source ? <div className="amazon-order-source">{source}</div> : null}
        </div>
        <div className="amazon-order-facts">
          <span className="amazon-fact" data-tone={order.lines === 0 ? 'unread' : undefined}>{freshListText(order)}</span>
          {order.lineTotal ? <span className="amazon-fact">{`Items ${formatMoney(order.lineTotal)}`}</span> : null}
          {order.missing > 0 ? <span className="amazon-fact">{`${order.missing.toLocaleString('en-US')} missing`}</span> : null}
          {order.substituted > 0 ? <span className="amazon-fact">{`${order.substituted.toLocaleString('en-US')} substituted`}</span> : null}
          {order.refund ? (
            <span className="amazon-fact" data-tone="refund">
              {`Refunded ${formatMinor(order.refund.refundMinor, order.refund.currency)}${net !== null ? ` · items net ${formatMinor(net, order.refund.currency)}` : ''}`}
            </span>
          ) : null}
        </div>
        {order.lines > 0 ? (
          <button type="button" className="spending-link inline amazon-fresh-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide items' : `Show ${plural(order.lines, 'item')}`}
          </button>
        ) : null}
        {open ? <FreshOrderItems order={order} /> : null}
      </article>
    </li>
  );
}

function FreshOrderItems({ order }: { order: AmazonFreshOrderSummary }) {
  const [answer, setAnswer] = useState<AmazonFreshOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchAmazonFreshOrder(order.ref)
      .then((body) => { if (!cancelled) { setAnswer(body); setError(null); } })
      .catch((reason: unknown) => { if (!cancelled) setError(apiErrorMessage(reason)); });
    return () => { cancelled = true; };
  }, [order.ref, attempt]);
  if (error) {
    return (
      <div className="spending-error amazon-error" role="alert">
        <span>Fresh items: {error}</span>
        <button type="button" className="spending-button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
      </div>
    );
  }
  if (!answer) return <p className="spending-muted" role="status">Loading the order&apos;s items…</p>;
  const unread = (answer.list.unreadRows ?? 0) + answer.list.unreadable;
  const kind = purchaseChannelText(order.purchaseChannel ?? answer.purchaseChannel) ? 'Whole Foods' : 'Fresh';
  return (
    <div className="amazon-fresh-list">
      <ul className="amazon-fresh-lines" aria-label={`Items of the ${kind} order of ${longDate(answer.date)}`}>
        {answer.lines.map((line) => <FreshLineRow key={line.ref} line={line} />)}
      </ul>
      {unread > 0 ? <p className="spending-muted">{`${plural(unread, 'row')} of this Item List couldn't be read and ${unread === 1 ? 'isn\'t' : 'aren\'t'} listed.`}</p> : null}
    </div>
  );
}

function FreshLineRow({ line }: { line: AmazonFreshLine }) {
  const measure = freshMeasureText(line);
  const review = line.category === AMAZON_TAXONOMY_NEEDS_REVIEW;
  return (
    <li className="amazon-fresh-line" data-status={line.status}>
      <span className="amazon-item-title" dir="auto">
        {line.title ?? <em className="amazon-hidden-title">Title hidden: it looked like card details</em>}
      </span>
      <span className="amazon-amount amazon-fresh-line-price">
        {line.status === 'missing' ? (
          <>
            {line.linePrice ? (
              <>
                <s className="amazon-spend-gross" aria-label={`listed at ${formatMoney(line.linePrice)}`}>{formatMoney(line.linePrice)}</s>{' '}
              </>
            ) : null}
            Not charged
          </>
        ) : line.linePrice ? formatMoney(line.linePrice) : 'Not charged'}
      </span>
      <span className="amazon-item-meta">
        {measure ? <span>{measure}</span> : null}
        {line.asin ? <span>ASIN {line.asin}</span> : null}
        <span className="amazon-fresh-line-category">
          {review ? 'Not yet classified' : taxonomyPathText(line.node)}
          {line.suggested ? ' (suggested)' : ''}
        </span>
      </span>
      {line.status !== 'listed' || line.refundMinor > 0 ? (
        <span className="amazon-order-facts">
          {line.status === 'missing' ? <span className="amazon-fact">Missing: not delivered</span> : null}
          {line.status === 'substituted' ? <span className="amazon-fact">{line.replaces ? `Substitute for ${line.replaces}` : 'Substitute'}</span> : null}
          {line.refundMinor > 0 && line.linePrice ? (
            <span className="amazon-fact" data-tone="refund">{`Refunded ${formatMinor(line.refundMinor, line.linePrice.currency)}`}</span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}
