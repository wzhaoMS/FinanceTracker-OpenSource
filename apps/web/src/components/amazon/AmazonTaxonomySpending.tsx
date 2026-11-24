import { useEffect, useState } from 'react';
import { AMAZON_TAXONOMY_NEEDS_REVIEW, amazonTaxonomyNode, type AmazonTaxonomyNodeId, type AmazonTaxonomyTopId } from '@finance-tracker/shared';

import { ApiError } from '../../services/api';
import { categoryTone } from '../../modes/category';
import { apiErrorMessage } from '../spending/spendingApi';
import { dateRangeLabel, formatMinor, longDate, todayIso } from '../spending/spendingFormat';
import { AMAZON_SPENDING_WINDOWS, type AmazonSpendingWindow } from './amazonApi';
import { SPENDING_WINDOW_WORDS, amazonOrderHref, plural, shareText, spendingWindowPhrase } from './amazonFormat';
import {
  fetchAmazonTaxonomySpending,
  type AmazonTaxonomyProduct,
  type AmazonTaxonomyPurchase,
  type AmazonTaxonomySpending,
} from './amazonTaxonomyApi';
import {
  cardCategoryText,
  nodeNote,
  otherLabel,
  subcategoryRows,
  taxonomyCurrency,
  taxonomyLabel,
  taxonomyPathText,
  taxonomySourceText,
  topRows,
  type TaxonomyRow,
} from './amazonTaxonomyFormat';
import { AmazonItemThumb } from './AmazonItemThumb';
import { AmazonCategoryTag } from './AmazonCategoryTag';
import { freshMeasureText, freshProductMeasureText } from './amazonFreshFormat';
import { FRESH_ITEM_LABEL, freshPartLines } from './amazonFreshItemsFormat';

/** Items shown before "Show all", and each item's purchases before "Show all purchases". */
const TOP_ITEMS = 10;
const TOP_PURCHASES = 3;

/** What the item list is narrowed to: a top level, and in it a subcategory, its own items ('other'), or all of it (null). */
interface Selection { top: AmazonTaxonomyTopId; sub: AmazonTaxonomyNodeId | 'other' | null }

/**
 * What the household's Amazon items were, over a window: each top level of the Amazon item taxonomy (Groceries,
 * Household Supplies, Electronics, …), its subcategories, and the items in each with every purchase (its quantity,
 * price, order date, and the refund tied to it or that its order has one). The same item prices and refunds as
 * spending by category above, from GET /amazon/spending/taxonomy: Amazon's own measure by order date, ranked after
 * refunds, never card spending, and never added to it. An Amazon Fresh order counts by its Fresh item list's lines (each
 * weight and price as its list showed it), as the Amazon Fresh tab counts them. Needs review lists exactly what each item
 * without a usable classification is, with the classifier's best guess. An API without this read shows nothing here.
 */
export function AmazonTaxonomyPanel() {
  const [shownWindow, setShownWindow] = useState<AmazonSpendingWindow>('1Y');
  const [answers, setAnswers] = useState<Partial<Record<AmazonSpendingWindow, AmazonTaxonomySpending>>>({});
  const [failure, setFailure] = useState<{ window: AmazonSpendingWindow; message: string } | null>(null);
  const [unreported, setUnreported] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Kept across windows, to compare one category's items over them.
  const [selected, setSelected] = useState<Selection | null>(null);
  const answer = answers[shownWindow];
  const failed = failure?.window === shownWindow ? failure : null;

  useEffect(() => {
    if (answer || unreported || failed) return undefined;
    let cancelled = false;
    const requested = shownWindow;
    fetchAmazonTaxonomySpending(requested, todayIso())
      .then((body) => { if (!cancelled) setAnswers((current) => ({ ...current, [requested]: body })); })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 404) setUnreported(true);
        else setFailure({ window: requested, message: apiErrorMessage(reason) });
      });
    return () => { cancelled = true; };
  }, [shownWindow, attempt, answer, unreported, failed]);

  if (unreported) return null;
  const loading = !answer && !failed;
  return (
    <section className="spending-panel amazon-spending amazon-taxonomy" aria-labelledby="amazon-taxonomy-title" aria-busy={loading}>
      <header className="spending-panel-head amazon-spending-head">
        <h3 id="amazon-taxonomy-title">What the Amazon items were</h3>
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
      {failed ? (
        <div className="spending-error amazon-error" role="alert">
          <span>Amazon items by category: {failed.message}</span>
          <button type="button" className="spending-button" onClick={() => { setFailure(null); setAttempt((value) => value + 1); }}>
            Try again
          </button>
        </div>
      ) : null}
      {loading ? <p className="spending-muted" role="status">Loading what the Amazon items were…</p> : null}
      {answer ? <TaxonomyWindow spending={answer} selected={selected} onSelect={setSelected} /> : null}
    </section>
  );
}

function TaxonomyWindow({ spending, selected, onSelect }: {
  spending: AmazonTaxonomySpending;
  selected: Selection | null;
  onSelect: (value: Selection | null) => void;
}) {
  const currency = taxonomyCurrency(spending);
  const total = spending.totals.find((entry) => entry.currency === currency);
  if (spending.orders.count === 0) {
    return <p className="spending-muted" role="status">{`No Amazon orders ${spendingWindowPhrase(spending.window)}.`}</p>;
  }
  if (!currency || !total) {
    return <p className="spending-muted" role="status">{`No item prices ${spendingWindowPhrase(spending.window)}.`}</p>;
  }
  const { lines } = spending;
  const taken = total.itemRefundMinor + total.unattributedRefundMinor;
  const figures = [
    { label: 'Spent on items', value: formatMinor(total.itemMinor, currency),
      note: `${plural(lines.priced, 'item')} in ${plural(spending.orders.count, 'order')}, before tax and shipping` },
    { label: 'Refunded', value: taken > 0 ? `−${formatMinor(taken, currency)}` : formatMinor(0, currency),
      note: spending.orders.refunded === 0 ? 'no refunds for these orders'
        : `${plural(spending.orders.refunded, 'order')}${total.unattributedRefundMinor > 0
          ? `, ${formatMinor(total.unattributedRefundMinor, currency)} not tied to an item` : ''}` },
    { label: 'Net of refunds', value: formatMinor(total.netItemMinor, currency), note: 'what the items cost after refunds' },
    { label: 'Classified', value: formatMinor(total.assignedMinor, currency),
      note: [total.itemMinor > 0 ? `${shareText(total.assignedMinor, total.itemMinor)} of item prices` : 'no item prices',
        total.suggestedMinor > 0 ? `${formatMinor(total.suggestedMinor, currency)} only suggested` : null]
        .filter((part): part is string => part !== null).join(' · ') },
    { label: 'Needs review', value: formatMinor(total.needsReviewMinor, currency),
      note: lines.needsReview > 0 ? `${plural(lines.needsReview, 'item')} not classified yet` : 'every item classified' },
  ];
  const coverage = [
    spending.assignments === 'absent' ? 'No classification has been imported yet, so every item is listed under Needs review.' : null,
    lines.noPrice + lines.noQuantity > 0
      ? `Left out of item prices: ${[lines.noPrice > 0 ? `${plural(lines.noPrice, 'item')} without a price` : null,
        lines.noQuantity > 0 ? `${plural(lines.noQuantity, 'item')} without a quantity` : null].filter(Boolean).join(' · ')}`
      : null,
    ...spending.totals.filter((entry) => entry.currency !== currency && entry.itemMinor > 0)
      .map((entry) => `Also ${formatMinor(entry.itemMinor, entry.currency)} of items in ${entry.currency}, not converted`),
    ...freshPartLines(spending.fresh, currency),
  ].filter((line): line is string => line !== null);
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
      {coverage.length > 0 ? (
        <ul className="amazon-spending-coverage" aria-label="What these figures cover">
          {coverage.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      <div className="spending-breakdowns amazon-spending-breakdowns">
        <section className="amazon-spending-part" aria-labelledby="amazon-taxonomy-tops">
          <h4 id="amazon-taxonomy-tops">By category, after refunds</h4>
          <RankList
            label="Categories, largest first"
            rows={topRows(spending, currency)}
            currency={currency}
            isSelected={(row) => selected !== null && row.node === selected.top}
            name={(row) => taxonomyLabel(row.node!)}
            onPick={(row) => onSelect(selected?.top === row.node ? null : { top: row.node as AmazonTaxonomyTopId, sub: null })}
            unattributed={total.unattributedRefundMinor}
          />
        </section>
        <Drill spending={spending} currency={currency} selected={selected} onSelect={onSelect} />
      </div>
    </>
  );
}

/** Rows ranked after refunds; `unattributed`: refunds tied to no item, which lower the total, never a row. */
function RankList({ label, rows, currency, isSelected, name, onPick, unattributed = 0 }: {
  label: string;
  rows: TaxonomyRow[];
  currency: string;
  isSelected: (row: TaxonomyRow) => boolean;
  name: (row: TaxonomyRow) => string;
  onPick: (row: TaxonomyRow) => void;
  unattributed?: number;
}) {
  const total = rows.reduce((sum, row) => sum + row.netMinor, 0);
  const max = Math.max(1, ...rows.map((row) => row.netMinor));
  return (
    <ul className="spending-rank amazon-spending-categories" aria-label={label}>
      {rows.map((row) => {
        const shown = name(row);
        const pressed = isSelected(row);
        return (
          <li key={row.node ?? 'other'} data-category-tone={row.node === AMAZON_TAXONOMY_NEEDS_REVIEW ? 'none' : categoryTone(shown)}>
            <button
              type="button"
              className={`spending-rank-row${pressed ? ' selected' : ''}`}
              aria-pressed={pressed}
              onClick={() => onPick(row)}
            >
              <span className="spending-rank-name">{shown}</span>
              <span className="spending-rank-bar" aria-hidden>
                <span style={{ width: `${Math.max(0, row.netMinor / max) * 100}%` }} />
              </span>
              <span className="spending-rank-amount num">{formatMinor(row.netMinor, currency)}</span>
              <span className="spending-rank-share num">{shareText(row.netMinor, total)}</span>
              <span className="spending-rank-note">{nodeNote(row, currency)}</span>
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

function Drill({ spending, currency, selected, onSelect }: {
  spending: AmazonTaxonomySpending;
  currency: string;
  selected: Selection | null;
  onSelect: (value: Selection | null) => void;
}) {
  const top = selected ? spending.nodes.find((entry) => entry.currency === currency && entry.node === selected.top) : undefined;
  if (!selected || !top) {
    // Nothing chosen (or nothing in the chosen category in this window): the window's largest items, wherever filed.
    const empty = selected ? `No items in ${taxonomyLabel(selected.top)} ${spendingWindowPhrase(spending.window)}.` : null;
    return (
      <section className="amazon-spending-part" aria-labelledby="amazon-taxonomy-items">
        <div className="amazon-spending-part-head">
          <h4 id="amazon-taxonomy-items">{empty ? taxonomyLabel(selected!.top) : 'Largest items'}</h4>
          {empty ? <button type="button" className="spending-link inline" onClick={() => onSelect(null)}>Every category</button> : null}
        </div>
        {empty ? <p className="spending-muted">{empty}</p> : (
          <ProductList products={spending.products.filter((product) => product.currency === currency)} all={null}
            label="Items, largest first" />
        )}
      </section>
    );
  }
  const subs = subcategoryRows(spending, currency, selected.top);
  const inSub = (product: AmazonTaxonomyProduct) => {
    if (selected.sub === 'other') return product.node === selected.top;
    if (selected.sub !== null) return product.node === selected.sub;
    return product.node === selected.top || amazonTaxonomyNode(product.node)?.parent === selected.top;
  };
  const sub = selected.sub !== null && selected.sub !== 'other'
    ? spending.nodes.find((entry) => entry.currency === currency && entry.node === selected.sub) : undefined;
  const heading = selected.sub === 'other' ? otherLabel(selected.top) : selected.sub !== null ? taxonomyLabel(selected.sub) : taxonomyLabel(selected.top);
  const needsReview = selected.top === AMAZON_TAXONOMY_NEEDS_REVIEW;
  return (
    <section className="amazon-spending-part amazon-taxonomy-drill" aria-labelledby="amazon-taxonomy-items">
      <nav className="amazon-taxonomy-path" aria-label="Category path">
        <button type="button" className="spending-link inline" onClick={() => onSelect(null)}>Every category</button>
        <span aria-hidden> › </span>
        {selected.sub === null ? <span aria-current="location">{taxonomyLabel(selected.top)}</span> : (
          <>
            <button type="button" className="spending-link inline" onClick={() => onSelect({ top: selected.top, sub: null })}>
              {taxonomyLabel(selected.top)}
            </button>
            <span aria-hidden> › </span>
            <span aria-current="location">{heading}</span>
          </>
        )}
      </nav>
      {subs.length > 0 && selected.sub === null ? (
        <RankList
          label={`${taxonomyLabel(selected.top)} by subcategory, largest first`}
          rows={subs}
          currency={currency}
          isSelected={() => false}
          name={(row) => (row.node === null ? otherLabel(selected.top) : taxonomyLabel(row.node))}
          onPick={(row) => onSelect({ top: selected.top, sub: row.node ?? 'other' })}
        />
      ) : null}
      <h4 id="amazon-taxonomy-items">{needsReview ? 'Needs review: what each item is' : `Items in ${heading}`}</h4>
      {needsReview ? (
        <p className="spending-muted">
          Nothing here is guessed: each item shows its full name, and the classifier's best guess when it had one. They
          count in a category once a classification is imported for them.
        </p>
      ) : null}
      {selected.sub !== null && selected.sub !== 'other' && !sub ? (
        <p className="spending-muted">{`No items in ${heading} ${spendingWindowPhrase(spending.window)}.`}</p>
      ) : (
        <ProductList
          products={spending.products.filter((product) => product.currency === currency && inSub(product))}
          all={selected.sub === 'other' ? null : (sub ?? top).products}
          label={`Items in ${heading}, largest first`}
        />
      )}
    </section>
  );
}

/** `all`: how many items the list's node holds, when the API says (the list may be capped). */
function ProductList({ products, all, label }: { products: AmazonTaxonomyProduct[]; all: number | null; label: string }) {
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

function ProductRow({ product }: { product: AmazonTaxonomyProduct }) {
  const needsReview = product.node === AMAZON_TAXONOMY_NEEDS_REVIEW;
  const tone = needsReview ? 'uncategorized' : product.source === 'owner' ? 'user' : 'agent';
  const refunded = product.refundMinor > 0;
  // An Amazon Fresh product: what its Item Lists showed (count and weight), and no card category of its own.
  const measure = product.fresh ? freshProductMeasureText(product.fresh) : `Qty ${product.quantity.toLocaleString('en-US')}`;
  return (
    <li className="amazon-spend-item amazon-taxonomy-item"
      data-refunded={refunded ? (product.refundMinor >= product.amountMinor ? 'whole' : 'part') : undefined}>
      <AmazonItemThumb itemRef={product.ref} image={product.image} size="medium" />
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
        {measure ? <span className={product.fresh ? 'amazon-fresh-measure' : undefined}>{measure}</span> : null}
        {product.refundedQuantity > 0 ? <span>{`${product.refundedQuantity.toLocaleString('en-US')} refunded`}</span> : null}
        <span>{plural(product.orders, 'order')}</span>
        {product.asin ? <span>ASIN {product.asin}</span> : null}
        {product.fresh ? <span className="amazon-taxonomy-badge">{FRESH_ITEM_LABEL}</span>
          : <span title={product.cardCategory ?? undefined}>{cardCategoryText(product)}</span>}
      </span>
      <AmazonCategoryTag name={needsReview ? 'Needs review' : taxonomyPathText(product.node)} source={taxonomySourceText(product)} tone={tone}
        fromTitle={product.source === 'agent' && !needsReview}>
        {product.suggested ? <span className="amazon-taxonomy-badge">Suggested</span> : null}
      </AmazonCategoryTag>
      <Purchases product={product} />
    </li>
  );
}

function Purchases({ product }: { product: AmazonTaxonomyProduct }) {
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

function PurchaseRow({ purchase, currency }: { purchase: AmazonTaxonomyPurchase; currency: string }) {
  // A Fresh line reads as its Item List showed it: its count or weight and unit price, then its price.
  const measure = purchase.fresh ? freshMeasureText(purchase.fresh) : '';
  return (
    <li>
      <a href={amazonOrderHref(purchase.orderRef)} aria-label={`Amazon order of ${longDate(purchase.orderDate)}`}>{longDate(purchase.orderDate)}</a>
      {measure ? <span className="amazon-fresh-measure">{measure}</span> : null}
      <span className="amazon-amount">
        {purchase.fresh || purchase.quantity === 1 ? formatMinor(purchase.amountMinor, currency)
          : `${purchase.quantity.toLocaleString('en-US')} × ${formatMinor(purchase.unitPriceMinor, currency)} = ${formatMinor(purchase.amountMinor, currency)}`}
      </span>
      {purchase.fresh?.status === 'substituted' ? <span className="amazon-fact">Substitute</span> : null}
      {purchase.refundMinor > 0 ? (
        <span className="amazon-fact" data-tone="refund">
          {`Refunded ${formatMinor(purchase.refundMinor, currency)}${purchase.refundedQuantity > 0 ? ` (${plural(purchase.refundedQuantity, 'unit')})` : ''}`}
        </span>
      ) : purchase.orderRefunded ? <span className="amazon-fact">Order has a refund</span> : null}
    </li>
  );
}
