import { useEffect, useState } from 'react';

import { ApiError } from '../../services/api';
import { categoryTone } from '../../modes/category';
import { apiErrorMessage } from '../spending/spendingApi';
import { dateRangeLabel, formatMinor, longDate, rankedCategoryLabels, todayIso } from '../spending/spendingFormat';
import {
  AMAZON_SPENDING_WINDOWS,
  fetchAmazonSpending,
  type AmazonSpending,
  type AmazonSpendingCategory,
  type AmazonSpendingProduct,
  type AmazonSpendingWindow,
} from './amazonApi';
import {
  SPENDING_WINDOW_WORDS,
  amazonOrderHref,
  itemCategory,
  plural,
  shareText,
  spendingCategoryName,
  spendingCoverageLines,
  spendingCurrency,
  spendingRefundTaken,
  spendingWindowPhrase,
} from './amazonFormat';
import { AmazonItemThumb } from './AmazonItemThumb';
import { AmazonCategoryTag } from './AmazonCategoryTag';
import { freshProductMeasureText } from './amazonFreshFormat';
import { FRESH_ITEM_LABEL, freshPartLines } from './amazonFreshItemsFormat';

/** Items and categories shown before "Show all". */
const TOP_ITEMS = 10;
const TOP_CATEGORIES = 10;

/** The panel's title: where the orders' "Go to spending by item" takes a reader, and focus with them. */
export const AMAZON_SPENDING_TITLE_ID = 'amazon-spending-title';

/**
 * What the household's Amazon orders' items cost over the last 30 or 60 days, the year to date, or the last one or
 * two years, by Amazon's order date: per category and per item, before and after refunds. Amazon's own measure, from
 * GET /amazon/spending: never card spending, never added to it. An Amazon Fresh order counts by its Fresh item list's
 * lines, as the Amazon Fresh tab counts them, under each line's item category's card category. Every figure comes with
 * what it covers (items without a price, orders not linked to a card charge, refunds not tied to an item, Fresh
 * orders), so a total never reads as more complete than it is.
 */
export function AmazonSpendingPanel() {
  const [shownWindow, setShownWindow] = useState<AmazonSpendingWindow>('30D');
  // Each window's answer, kept for this visit, so switching back shows it at once.
  const [answers, setAnswers] = useState<Partial<Record<AmazonSpendingWindow, AmazonSpending>>>({});
  const [failure, setFailure] = useState<{ window: AmazonSpendingWindow; message: string } | null>(null);
  // An API without this read: said once, never shown as an error or as no spending.
  const [unreported, setUnreported] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The category the item list is narrowed to (null: the uncategorized items), kept across windows to compare them.
  const [selected, setSelected] = useState<{ category: string | null } | null>(null);
  const answer = answers[shownWindow];
  const failed = failure?.window === shownWindow ? failure : null;

  useEffect(() => {
    if (answer || unreported || failed) return undefined;
    let cancelled = false;
    const requested = shownWindow;
    fetchAmazonSpending(requested, todayIso())
      .then((body) => {
        if (cancelled) return;
        setAnswers((current) => ({ ...current, [requested]: body }));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 404) setUnreported(true);
        else setFailure({ window: requested, message: apiErrorMessage(reason) });
      });
    return () => { cancelled = true; };
  }, [shownWindow, attempt, answer, unreported, failed]);

  const loading = !answer && !unreported && !failed;
  return (
    <section className="spending-panel amazon-spending" aria-labelledby={AMAZON_SPENDING_TITLE_ID} aria-busy={loading}>
      <header className="spending-panel-head amazon-spending-head">
        <h3 id={AMAZON_SPENDING_TITLE_ID} tabIndex={-1}>Amazon spending by item and category</h3>
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
      </header>
      <p className="amazon-spending-measure">
        <span className="amazon-measure">Item prices by order date: not card spending</span>
        {answer ? <span className="spending-muted">{dateRangeLabel(answer.window.from, answer.window.to)}</span> : null}
      </p>
      {unreported ? <p className="spending-muted">Spending by item isn&apos;t reported by this version of Holdr.</p> : null}
      {failed ? (
        <div className="spending-error amazon-error" role="alert">
          <span>Amazon spending: {failed.message}</span>
          <button type="button" className="spending-button" onClick={() => { setFailure(null); setAttempt((value) => value + 1); }}>
            Try again
          </button>
        </div>
      ) : null}
      {loading ? <p className="spending-muted" role="status">Loading Amazon spending…</p> : null}
      {answer ? <SpendingWindow spending={answer} selected={selected} onSelect={setSelected} /> : null}
    </section>
  );
}

function SpendingWindow({ spending, selected, onSelect }: {
  spending: AmazonSpending;
  selected: { category: string | null } | null;
  onSelect: (value: { category: string | null } | null) => void;
}) {
  const currency = spendingCurrency(spending);
  const total = spending.totals.find((entry) => entry.currency === currency);
  const coverage = (
    <ul className="amazon-spending-coverage" aria-label="What these figures cover">
      {[...spendingCoverageLines(spending, currency ?? ''), ...freshPartLines(spending.fresh, currency ?? '', true)]
        .map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
  if (spending.orders.count === 0) {
    return <p className="spending-muted" role="status">{`No Amazon orders ${spendingWindowPhrase(spending.window)}.`}</p>;
  }
  if (!currency || !total) {
    // Orders, but neither a total nor a priced item: what is missing, not a figure of nothing.
    return (
      <>
        <p className="spending-muted" role="status">{`No item prices or order totals ${spendingWindowPhrase(spending.window)}.`}</p>
        {coverage}
      </>
    );
  }
  const categories = spending.categories.filter((entry) => entry.currency === currency);
  const items = categories.reduce((sum, entry) => sum + entry.lines, 0);
  // Refunds come off only when this API takes them off; an older one's figures are before refunds, as it says.
  const reported = spending.refunds !== undefined;
  const taken = spendingRefundTaken(total);
  const unattributed = total.unattributedRefundMinor ?? 0;
  const figures = [
    { label: 'Spent on items', value: formatMinor(total.itemMinor, currency),
      note: `${plural(items, 'item')} in ${plural(spending.orders.count, 'order')}, before tax and shipping` },
    ...(reported ? [
      { label: 'Refunded', value: taken > 0 ? `−${formatMinor(taken, currency)}` : formatMinor(0, currency),
        note: spending.orders.refunded === 0 ? 'no refunds for these orders'
          : `${plural(spending.orders.refunded, 'order')}${unattributed > 0 ? `, ${formatMinor(unattributed, currency)} not tied to an item` : ''}` },
      { label: 'Net of refunds', value: formatMinor(total.netItemMinor ?? total.itemMinor, currency),
        note: 'what the items cost after refunds' },
    ] : []),
    { label: 'Order totals', value: formatMinor(total.orderTotalMinor, currency),
      note: spending.orders.withTotal < spending.orders.count
        ? `${spending.orders.withTotal.toLocaleString('en-US')} of ${plural(spending.orders.count, 'order')} with a total, tax and shipping included`
        : 'Amazon\'s totals, with tax and shipping' },
    { label: 'Categorized', value: formatMinor(total.categorizedMinor, currency),
      note: total.itemMinor > 0 ? `${shareText(total.categorizedMinor, total.itemMinor)} of item prices` : 'no item prices' },
  ];
  return (
    <>
      <dl className="amazon-figures">
        {figures.map((figure) => (
          <div key={figure.label} className="amazon-figure" data-figure={figure.label === 'Net of refunds' ? 'net' : undefined}>
            <dt>{figure.label}</dt>
            <dd>
              <span className="amazon-figure-value">{figure.value}</span>
              <span className="amazon-figure-note">{figure.note}</span>
            </dd>
          </div>
        ))}
      </dl>
      {coverage}
      <div className="spending-breakdowns amazon-spending-breakdowns">
        <CategoryList categories={categories} reported={reported} unattributed={unattributed} currency={currency}
          selected={selected} onSelect={onSelect} />
        <div className="amazon-spending-column">
          <ItemList spending={spending} currency={currency} categories={categories} selected={selected} onClear={() => onSelect(null)} />
          {reported ? <RefundedList spending={spending} currency={currency} selected={selected} /> : null}
        </div>
      </div>
    </>
  );
}

/** A category's or an item's amount as the list shows it: after refunds when the API takes them off. */
const shownAmount = (entry: { amountMinor: number; netMinor?: number }) => entry.netMinor ?? entry.amountMinor;

function CategoryList({ categories, reported, unattributed, currency, selected, onSelect }: {
  categories: AmazonSpendingCategory[];
  reported: boolean;
  /** Refunds tied to no item: they lower the total, never a category. */
  unattributed: number;
  currency: string;
  selected: { category: string | null } | null;
  onSelect: (value: { category: string | null } | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? categories : categories.slice(0, TOP_CATEGORIES);
  const labels = rankedCategoryLabels(shown.map((entry) => spendingCategoryName(entry.category)));
  const total = categories.reduce((sum, entry) => sum + shownAmount(entry), 0);
  const max = Math.max(1, ...categories.map(shownAmount));
  return (
    <section className="amazon-spending-part" aria-labelledby="amazon-spending-categories">
      <h4 id="amazon-spending-categories">{reported ? 'By category, after refunds' : 'By category'}</h4>
      <ul className="spending-rank amazon-spending-categories">
        {shown.map((entry) => {
          const name = spendingCategoryName(entry.category);
          const label = labels.get(name) ?? name;
          const amount = formatMinor(shownAmount(entry), entry.currency);
          const share = shareText(shownAmount(entry), total);
          const refunded = entry.refundMinor ?? 0;
          const note = [plural(entry.lines, 'item'), plural(entry.orders, 'order'),
            refunded > 0 ? `${formatMinor(refunded, entry.currency)} refunded of ${formatMinor(entry.amountMinor, entry.currency)}` : null]
            .filter((part): part is string => part !== null).join(' · ');
          const isSelected = selected !== null && selected.category === entry.category;
          return (
            <li key={JSON.stringify(entry.category)} data-category-tone={categoryTone(name)}>
              <button
                type="button"
                className={`spending-rank-row${isSelected ? ' selected' : ''}`}
                aria-pressed={isSelected}
                aria-label={label !== name ? `${name}: ${amount}${share ? `, ${share}` : ''}, ${note}` : undefined}
                onClick={() => onSelect(isSelected ? null : { category: entry.category })}
              >
                <span className="spending-rank-name" title={label !== name ? name : undefined}>{label}</span>
                <span className="spending-rank-bar" aria-hidden>
                  <span style={{ width: `${Math.max(0, shownAmount(entry) / max) * 100}%` }} />
                </span>
                <span className="spending-rank-amount num">{amount}</span>
                <span className="spending-rank-share num">{share}</span>
                <span className="spending-rank-note">{note}</span>
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
      {categories.length > TOP_CATEGORIES ? (
        <button type="button" className="spending-link" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? `Show the top ${TOP_CATEGORIES}` : `Show all ${categories.length.toLocaleString('en-US')} categories`}
        </button>
      ) : null}
    </section>
  );
}

function ItemList({ spending, currency, categories, selected, onClear }: {
  spending: AmazonSpending;
  currency: string;
  categories: AmazonSpendingCategory[];
  selected: { category: string | null } | null;
  onClear: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const inView = (entry: { currency: string; category: string | null }) =>
    entry.currency === currency && (selected === null || entry.category === selected.category);
  const listed = spending.products.filter(inView);
  // Every thing bought, counted by the categories whether or not the answer lists it.
  const all = categories.filter(inView).reduce((sum, entry) => sum + entry.products, 0);
  const shown = showAll ? listed : listed.slice(0, TOP_ITEMS);
  const name = selected ? spendingCategoryName(selected.category) : null;
  return (
    <section className="amazon-spending-part" aria-labelledby="amazon-spending-items">
      <div className="amazon-spending-part-head">
        <h4 id="amazon-spending-items">{name ? `Items in ${name}` : 'By item'}</h4>
        {name ? (
          <button type="button" className="spending-link inline" onClick={onClear}>Show every category</button>
        ) : null}
      </div>
      {all === 0 ? (
        <p className="spending-muted">{name ? `No items in ${name} ${spendingWindowPhrase(spending.window)}.` : 'No priced items.'}</p>
      ) : listed.length === 0 ? (
        // The category has items, all smaller than the largest the API lists: never "no items".
        <p className="spending-muted">
          {`${name ? `${name}'s` : 'This window\'s'} ${plural(all, 'item')} ${all === 1 ? 'isn\'t' : 'aren\'t'} among the`
            + ` ${spending.products.length.toLocaleString('en-US')} largest listed; the totals count ${all === 1 ? 'it' : 'them all'}.`}
        </p>
      ) : (
        <ol className="amazon-spend-items" aria-label={name ? `Items in ${name}, largest first` : 'Items, largest first'}>
          {shown.map((product) => <ProductRow key={product.ref} product={product} />)}
        </ol>
      )}
      {listed.length > 0 && listed.length < all ? (
        <p className="spending-muted">
          {`Listing the ${listed.length.toLocaleString('en-US')} largest of ${plural(all, 'item')}; the totals count them all.`}
        </p>
      ) : null}
      {listed.length > TOP_ITEMS ? (
        <button type="button" className="spending-link" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? `Show the top ${TOP_ITEMS}` : `Show all ${plural(listed.length, 'item')}`}
        </button>
      ) : null}
    </section>
  );
}

/** Refunded items, most refunded first, in the chosen category: each marked, its net beside what it cost. */
function RefundedList({ spending, currency, selected }: {
  spending: AmazonSpending;
  currency: string;
  selected: { category: string | null } | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const refunded = spending.products.filter((product) => product.currency === currency && (product.refundMinor ?? 0) > 0
    && (selected === null || product.category === selected.category))
    .sort((a, b) => (b.refundMinor ?? 0) - (a.refundMinor ?? 0) || a.ref.localeCompare(b.ref));
  const listing = spending.refunds?.refundedProducts;
  // The API lists the most refunded items, bounded; it says how many there are in all.
  const all = selected === null && listing ? Math.max(listing.count, refunded.length) : refunded.length;
  if (refunded.length === 0 && all === 0) return null;
  const shown = showAll ? refunded : refunded.slice(0, TOP_ITEMS);
  return (
    <section className="amazon-spending-part amazon-refunded-items" aria-labelledby="amazon-spending-refunded">
      <h4 id="amazon-spending-refunded">{`Refunded items (${all.toLocaleString('en-US')})`}</h4>
      {refunded.length > 0 ? (
        <ol className="amazon-spend-items" aria-label="Refunded items, most refunded first">
          {shown.map((product) => <ProductRow key={product.ref} product={product} />)}
        </ol>
      ) : null}
      {refunded.length < all || (selected !== null && listing?.truncated) || spending.productsTruncated ? (
        <p className="spending-muted">
          {`Listing the ${refunded.length.toLocaleString('en-US')} most refunded`
            + `${selected === null ? ` of ${plural(all, 'refunded item')}` : ' this answer carries'}; the totals count them all.`}
        </p>
      ) : null}
      {refunded.length > TOP_ITEMS ? (
        <button type="button" className="spending-link" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? `Show the top ${TOP_ITEMS}` : `Show all ${plural(refunded.length, 'refunded item')}`}
        </button>
      ) : null}
    </section>
  );
}

function ProductRow({ product }: { product: AmazonSpendingProduct }) {
  const category = itemCategory({ category: product.category, categorySource: product.categorySource, confidence: null });
  const refund = product.refundMinor ?? 0;
  const whole = refund > 0 && refund >= product.amountMinor;
  // An Amazon Fresh product: what its Item Lists showed (count and weight), not order-item units.
  const measure = product.fresh ? freshProductMeasureText(product.fresh) : `Qty ${product.quantity.toLocaleString('en-US')}`;
  return (
    <li className="amazon-spend-item" data-refunded={refund > 0 ? (whole ? 'whole' : 'part') : undefined}>
      <AmazonItemThumb itemRef={product.ref} image={product.image} size="medium" />
      <span className="amazon-item-title amazon-spend-title" dir="auto" title={product.title ?? undefined}>
        {product.title ?? <em className="amazon-hidden-title">Title hidden: it looked like card details</em>}
      </span>
      <span className="amazon-spend-amount">
        {refund > 0 ? (
          <>
            <s className="amazon-spend-gross" aria-label={`${formatMinor(product.amountMinor, product.currency)} before refunds`}>
              {formatMinor(product.amountMinor, product.currency)}
            </s>{' '}
          </>
        ) : null}
        {formatMinor(product.netMinor ?? product.amountMinor, product.currency)}
      </span>
      <span className="amazon-item-meta">
        {refund > 0 ? (
          <span className="amazon-refund-badge" data-whole={whole ? 'true' : undefined}>
            {whole ? 'Refunded' : 'Partly refunded'}
            {(product.refundedQuantity ?? 0) > 0 && !(whole && product.refundedQuantity === product.quantity)
              ? ` · ${product.refundedQuantity!.toLocaleString('en-US')} of ${product.quantity.toLocaleString('en-US')}` : ''}
            {` · −${formatMinor(refund, product.currency)}`}
          </span>
        ) : null}
        {measure ? <span className={product.fresh ? 'amazon-fresh-measure' : undefined}>{measure}</span> : null}
        <span>{plural(product.orders, 'order')}</span>
        <span>
          Last ordered{' '}
          <a href={amazonOrderHref(product.lastOrderRef)} aria-label={`Amazon order of ${longDate(product.lastOrderDate)}`}>
            {longDate(product.lastOrderDate)}
          </a>
        </span>
        {product.asin ? <span>ASIN {product.asin}</span> : null}
        {product.fresh ? <span className="amazon-taxonomy-badge">{FRESH_ITEM_LABEL}</span> : null}
      </span>
      <AmazonCategoryTag name={category.name} source={category.source} tone={category.tone} fromTitle={category.tone === 'agent'} />
    </li>
  );
}
