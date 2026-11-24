import { useEffect, useMemo, useState } from 'react';
import {
  cardSpendingLineRows,
  cardSpendingOtherLines,
  cardSpendingOtherMerchants,
  type CardCategoryBasis,
  type CardSpendingCategoryLine,
  type CardSpendingMerchant,
  type CardSpendingMerchantLine,
  type CardSpendingOtherMerchants,
} from '@finance-tracker/shared';

import { CategoryBasisNote } from '../CategoryBasisNote';
import { Spinner, TitleWithSpinner } from '../../Spinner';
import { useUpdatingMark } from '../../useUpdatingMark';
import type { MerchantFilter } from '../SpendingInsights';
import { apiErrorMessage, type CardTransactionListRow, type SpendingFilters, type SpendingSummaryResponse } from '../spendingApi';
import { amazonCoverageText, formatMinor, formatRowAmount, merchantDisplayName, rankedCategoryLabels, shortDate } from '../spendingFormat';
import {
  fetchCategoryTransactions, fetchLineTransactions, fetchMerchantTransactions, fetchViewTransactions, type OverviewWindow,
} from './overviewApi';
import { lineTieOut, othersTieOut } from './overviewLines';
import { chargesText, netText, otherMerchantsText, signedMoney } from './overviewText';

/** What the page does when asked from here: the explicit narrowing, the category basis, the Amazon charges not itemized. */
export interface CategoryActions {
  basis: CardCategoryBasis;
  onBasis: (basis: CardCategoryBasis) => void;
  /** "Filter this spending view": the whole page (total, transactions) narrows to the category or the merchant. */
  onFilterCategory: (category: string) => void;
  onFilterMerchant: (merchant: MerchantFilter) => void;
  /** Lists the Amazon card charges the coverage line counts as not itemized. */
  onAmazonUnitemized: () => void;
}

type By = 'category' | 'merchant';

/**
 * A row's charges, read inline: one merchant line of a category, one merchant's every charge, or what is behind an
 * "N other merchants" row: a category's (`category`), or the By merchant view's (`category` null).
 */
type Target =
  | { kind: 'line'; category: string; line: CardSpendingMerchantLine }
  | { kind: 'merchant'; key: string; amountMinor: number }
  | { kind: 'others'; category: string | null };

/** What a row's read gave: its rows, what they add up to in the view's currency, and whether every page was read. */
interface RowsRead {
  /** A line's or a merchant's own rows; behind "other merchants", every counted row they are picked from, in any currency. */
  rows: CardTransactionListRow[];
  sumMinor: number;
  complete: boolean;
}

type ChargesRead =
  | { key: string; identity: string; status: 'loading' }
  /** `pending`: the same row read again after a change, its last rows still shown until the new ones are in. */
  | ({ key: string; identity: string; status: 'done'; pending?: boolean } & RowsRead)
  | { key: string; identity: string; status: 'failed'; message: string };

/** Each charge as it is shown: its part in the category under a category filter, else all of it. */
const shownAmount = (row: CardTransactionListRow) => row.categoryPortionMinor ?? row.amountMinor;

/** The rows a row opens to, read to the last page of the list (overviewApi.ts). */
function readTarget(target: Target, filters: SpendingFilters, window: OverviewWindow, currency: string): Promise<RowsRead> {
  const dates = { from: window.from, to: window.to };
  if (target.kind === 'line') {
    // Every page first, then exactly the line's rows: posted spending in this currency at the line's merchant group,
    // split rows on their own line.
    return fetchLineTransactions(filters, { ...dates, category: target.category, merchant: target.line.key })
      .then((pages) => ({ ...cardSpendingLineRows(pages.rows, target.line, currency), complete: pages.complete }));
  }
  if (target.kind === 'merchant') {
    return fetchMerchantTransactions(filters, { ...dates, merchant: target.key }).then((pages) => {
      const rows = pages.rows.filter((row) => row.status === 'posted' && row.role === 'spending' && row.currency === currency);
      return { rows, sumMinor: rows.reduce((sum, row) => sum + shownAmount(row), 0), complete: pages.complete };
    });
  }
  // Every counted row, in every currency (the summary groups merchants over all of them): which are behind the row,
  // and how they group, is picked where they show, against the named lines or merchants of the answer on screen.
  const pages = target.category === null
    ? fetchViewTransactions(filters, dates)
    : fetchCategoryTransactions(filters, { ...dates, category: target.category });
  return pages.then((read) => {
    const rows = read.rows.filter((row) => row.status === 'posted' && row.role === 'spending');
    return { rows, sumMinor: rows.filter((row) => row.currency === currency).reduce((sum, row) => sum + shownAmount(row), 0), complete: read.complete };
  });
}

/**
 * The open row's charges: loading, its rows, or its error. Another row's read clears what an earlier one left; the
 * same row read again after a change (`version`) keeps its rows until the new ones are in.
 */
function useCharges(target: Target | null, filters: SpendingFilters, window: OverviewWindow, version: number, currency: string): ChargesRead | null {
  const identity = target === null ? null : JSON.stringify([window.from, window.to, target.kind,
    target.kind === 'line' ? [target.category, target.line.key, target.line.itemized] : target.kind === 'merchant' ? target.key : target.category]);
  const key = identity === null ? null : JSON.stringify([identity, version]);
  const [read, setRead] = useState<ChargesRead | null>(null);
  useEffect(() => {
    if (key === null || identity === null || target === null) {
      setRead(null);
      return undefined;
    }
    let cancelled = false;
    setRead((last) => (last?.identity === identity && last.status === 'done' ? { ...last, key, pending: true } : { key, identity, status: 'loading' }));
    readTarget(target, filters, window, currency)
      .then((done) => { if (!cancelled) setRead({ key, identity, status: 'done', ...done }); })
      .catch((reason: unknown) => { if (!cancelled) setRead({ key, identity, status: 'failed', message: apiErrorMessage(reason) }); });
    return () => { cancelled = true; };
    // key holds the target's identity and the data version; filters only change with a new view, which closes the rows.
  }, [key]);
  return read !== null && read.identity === identity ? read : null;
}

/**
 * The overview's one category view (plan D3): each category (or, By merchant, each merchant) as one row, its name, its
 * net amount and its charges; a click opens it in place: its merchants and their charges, each level adding up to the
 * one above. "N other merchants" opens the same way, to each merchant it holds and their charges, adding up to it.
 * Narrowing the whole page is its own button, "Filter this spending view". What the categories are based
 * on is said above them, with its change; what Amazon items add to a category only once it is open, as its signed
 * amount and what is known of it. Beside a total that is not known (its read failed, or not on record) it says why,
 * never $0.
 */
export function OverviewCategories(props: CategoryActions & {
  window: OverviewWindow;
  /** The period's own summary (its merchants, the Amazon items and coverage, the category basis); null until in. */
  summary: SpendingSummaryResponse | null;
  summaryFailure: string | null;
  /** Why nothing is shown beside the headline's total, when it is not known (its read failed, or not on record), else null. */
  blocked: string | null;
  periodName: string;
  filters: SpendingFilters;
  version: number;
  currency: string;
  onOpen: (id: string) => void;
  /** The same view is being read again: the figures shown are the last read's. */
  updating?: boolean;
}) {
  const { window, summary, currency } = props;
  const [by, setBy] = useState<By>('category');
  const [open, setOpen] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  // A new view starts closed.
  useEffect(() => { setOpen(null); setTarget(null); }, [props.filters]);
  const charges = useCharges(target, props.filters, window, props.version, currency);
  const toggleRow = (id: string) => {
    setOpen((now) => (now === id ? null : id));
    setTarget(null);
  };
  const choose = (next: By) => {
    setBy(next);
    setOpen(null);
    setTarget(null);
  };
  const headingId = `overview-by-${by}`;
  // By merchant, "N other merchants" opens in place of any one merchant, as one merchant opens in place of another.
  const othersOpen = target?.kind === 'others' && target.category === null;
  // The view read again, or an open row's charges: what shows is the last read's, dimmed, with the spinner by the title,
  // until a moment after the new answer lands.
  const chargesUpdating = useUpdatingMark(charges?.status === 'done' && charges.pending === true,
    { view: charges?.identity, failed: charges?.status === 'failed' });
  const updating = Boolean(props.updating) || chargesUpdating;
  return (
    <div className="overview-block overview-categories" role="group" aria-labelledby={headingId} data-updating={updating ? 'true' : undefined}>
      <div className="overview-block-head">
        <TitleWithSpinner busy={updating}><h3 id={headingId}>{by === 'category' ? 'Categories' : 'Merchants'}</h3></TitleWithSpinner>
        <div className="overview-tabs" role="group" aria-label="Show spending by">
          {(['category', 'merchant'] as const).map((value) => (
            <button key={value} type="button" className={`overview-toggle${by === value ? ' active' : ''}`} aria-pressed={by === value}
              onClick={() => choose(value)}>
              {value === 'category' ? 'By category' : 'By merchant'}
            </button>
          ))}
        </div>
      </div>
      {props.blocked !== null ? (
        <p className="overview-unknown" data-testid="overview-categories-unknown">{props.blocked}</p>
      ) : by === 'category' ? (
        <CategoryRows {...props} open={open} onToggle={toggleRow} target={target} onTarget={setTarget} charges={charges} />
      ) : (
        <MerchantRows {...props} open={open} onToggle={(key, amountMinor) => {
          const opening = open !== key;
          toggleRow(key);
          if (opening) setTarget({ kind: 'merchant', key, amountMinor });
        }} charges={charges} othersOpen={othersOpen} onOthers={() => {
          setOpen(null);
          setTarget(othersOpen ? null : { kind: 'others', category: null });
        }} />
      )}
    </div>
  );
}

/** A period with no spending on record, said as such: never $0, and nothing split. */
export function unknownSentence(unknown: string, periodName: string): string {
  return unknown === 'No card data' ? `No card data for ${periodName}` : `Not recorded: no posted spending on record for ${periodName}`;
}

function CategoryRows(props: CategoryActions & {
  window: OverviewWindow;
  summary: SpendingSummaryResponse | null;
  periodName: string;
  filters: SpendingFilters;
  currency: string;
  onOpen: (id: string) => void;
  open: string | null;
  onToggle: (category: string) => void;
  target: Target | null;
  onTarget: (target: Target | null) => void;
  charges: ChargesRead | null;
}) {
  const { window, summary, currency } = props;
  const labels = rankedCategoryLabels(window.categories.map((line) => line.category));
  // What Amazon items put in the categories, from the same answer, and how many of its charges are itemized.
  const fromItems = (summary?.fromAmazonItems ?? []).filter((item) => item.currency === currency);
  const itemsTotal = fromItems.reduce((sum, item) => sum + item.amountMinor, 0);
  const coverage = amazonCoverageText(summary?.amazonCoverage, currency);
  return (
    <>
      {/* Always said, from the period's own answer, with its change: what the categories are based on is never a guess. */}
      {summary ? <CategoryBasisNote marker={summary.categoryBasis} preference={props.basis} onBasis={props.onBasis} /> : null}
      {fromItems.length > 0 ? (
        <p className="overview-help" data-testid="overview-amazon-items">
          {`Includes ${formatMinor(itemsTotal, currency)} of Amazon items, each counted under its own category.`}
        </p>
      ) : null}
      {coverage ? (
        <div className="overview-amazon-coverage" role="group" aria-label="Amazon coverage">
          <p>
            <strong>{coverage.headline}</strong>
            {coverage.unitemized > 0 ? (
              <>
                {' '}
                <button type="button" className="overview-link" onClick={props.onAmazonUnitemized}>{`Show the ${coverage.unitemized} not itemized`}</button>
              </>
            ) : null}
          </p>
          <p className="overview-help">{coverage.notCounted}</p>
        </div>
      ) : null}
      {window.categories.length === 0 ? <p className="overview-help">{`No posted spending in ${props.periodName}`}</p> : null}
      <ul className="overview-list overview-rows" data-testid="overview-categories">
        {window.categories.map((line) => {
          const expanded = props.open === line.category;
          return (
            <li key={line.category} className={expanded ? 'open' : undefined} data-category={line.category}>
              <button type="button" className="overview-row" aria-expanded={expanded} onClick={() => props.onToggle(line.category)} title={line.category}>
                <span className="overview-row-name">{labels.get(line.category) ?? line.category}</span>
                <span className="spending-muted">{chargesText(line.count)}</span>
                <strong className="num">{netText(line.amountMinor, line.count, currency)}</strong>
              </button>
              {expanded ? (
                <CategoryDetail {...props} line={line} items={fromItems.find((item) => item.category === line.category)?.rows ?? null} />
              ) : null}
            </li>
          );
        })}
        <li className="overview-list-total"><span>Total</span><span /><strong className="num">{formatMinor(window.spendingMinor, currency)}</strong></li>
      </ul>
    </>
  );
}

/**
 * An open category: the page's narrowing, what Amazon items contribute (its signed amount, and in how many charges, as
 * the answer has it), and its merchant lines, each opening its charges; the lines not named open under "N other
 * merchants".
 */
function CategoryDetail(props: CategoryActions & {
  line: CardSpendingCategoryLine;
  /** How many charges its Amazon items come from, when the answer says. */
  items: number | null;
  filters: SpendingFilters;
  currency: string;
  onOpen: (id: string) => void;
  target: Target | null;
  onTarget: (target: Target | null) => void;
  charges: ChargesRead | null;
}) {
  const { line, currency } = props;
  const openLine = props.target?.kind === 'line' && props.target.category === line.category ? props.target.line : null;
  const othersOpen = props.target?.kind === 'others' && props.target.category === line.category;
  return (
    <div className="overview-detail" data-testid="overview-category-detail">
      <FilterButton active={props.filters.category === line.category} onFilter={() => props.onFilterCategory(line.category)} />
      {line.itemsMinor !== 0 ? (
        <p className="overview-items" data-testid="overview-item-contribution">
          <span>Amazon item contribution</span>
          <strong className="num">{signedMoney(line.itemsMinor, currency)}</strong>
          {props.items !== null ? <span className="spending-muted">{`items in ${chargesText(props.items)}`}</span> : null}
        </p>
      ) : null}
      <ul className="overview-list" aria-label={`${line.category} by merchant`} data-testid="overview-merchants">
        {line.merchants.map((merchant) => {
          const expanded = openLine !== null && openLine.key === merchant.key && openLine.itemized === merchant.itemized;
          return (
            <li key={`${merchant.key} ${merchant.itemized}`}>
              <button type="button" className="overview-row" aria-expanded={expanded}
                onClick={() => props.onTarget(expanded ? null : { kind: 'line', category: line.category, line: merchant })}>
                <span className="overview-row-name" title={merchant.name}>{lineName(merchant)}</span>
                <span className="spending-muted">{chargesText(merchant.count)}</span>
                <strong className="num">{netText(merchant.amountMinor, merchant.count, currency)}</strong>
              </button>
              {expanded ? <Charges read={props.charges} amountMinor={merchant.amountMinor} currency={currency} onOpen={props.onOpen} /> : null}
            </li>
          );
        })}
        {line.otherMerchants ? (
          <li>
            <button type="button" className="overview-row" aria-expanded={othersOpen}
              onClick={() => props.onTarget(othersOpen ? null : { kind: 'others', category: line.category })}>
              <span className="overview-row-name">{otherMerchantsText(line.otherMerchants.lines)}</span>
              <span className="spending-muted">{chargesText(line.otherMerchants.count)}</span>
              <strong className="num">{formatMinor(line.otherMerchants.amountMinor, currency)}</strong>
            </button>
            {othersOpen ? (
              <OtherLines read={props.charges} category={line.category} named={line.merchants} rest={line.otherMerchants}
                currency={currency} onOpen={props.onOpen} />
            ) : null}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * An open "N other merchants" row of a category: its merchant lines, picked from the category's rows as one line's
 * rows are (cardSpendingOtherLines), largest first, each opening its charges; then how they add up to the row, their
 * total only when every row was read.
 */
function OtherLines(props: {
  read: ChargesRead | null;
  category: string;
  /** The category's named lines, above the row: never behind it. */
  named: readonly CardSpendingMerchantLine[];
  rest: { lines: number; count: number; amountMinor: number };
  currency: string;
  onOpen: (id: string) => void;
}) {
  const { read, named, currency } = props;
  const [open, setOpen] = useState<string | null>(null);
  const others = useMemo(() => (read?.status === 'done' ? cardSpendingOtherLines(read.rows, named, currency) : null), [read, named, currency]);
  if (read?.status !== 'done' || others === null) return <ReadStatus read={read} label="Loading merchants" testId="overview-others-loading" />;
  const tie = othersTieOut(
    { complete: read.complete, merchants: others.lines.length, count: others.count, sumMinor: others.sumMinor },
    { merchants: props.rest.lines, count: props.rest.count, amountMinor: props.rest.amountMinor },
  );
  return (
    <ul className="overview-list overview-others" aria-label={`${props.category}: other merchants`} data-testid="overview-other-merchants">
      {others.lines.map((other) => {
        const id = JSON.stringify([other.key, other.itemized]);
        const expanded = open === id;
        return (
          <li key={id}>
            <button type="button" className="overview-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : id)}>
              <span className="overview-row-name" title={other.name}>{lineName(other)}</span>
              <RestFigures count={other.count} amountMinor={other.amountMinor} complete={read.complete} currency={currency} />
            </button>
            {expanded ? (
              <ChargeList rows={other.rows} complete={read.complete} sumMinor={other.amountMinor} amountMinor={other.amountMinor}
                currency={currency} onOpen={props.onOpen} />
            ) : null}
          </li>
        );
      })}
      <OthersTie tie={tie} currency={currency} />
    </ul>
  );
}

function MerchantRows(props: CategoryActions & {
  summary: SpendingSummaryResponse | null;
  summaryFailure: string | null;
  periodName: string;
  filters: SpendingFilters;
  currency: string;
  onOpen: (id: string) => void;
  open: string | null;
  onToggle: (key: string, amountMinor: number) => void;
  charges: ChargesRead | null;
  /** "N other merchants" is open: it holds the read rows (`charges`) in place of any one merchant's. */
  othersOpen: boolean;
  onOthers: () => void;
}) {
  const { summary, currency } = props;
  if (summary === null) {
    return props.summaryFailure
      ? <p className="overview-error" role="status">{props.summaryFailure}</p>
      : <p className="overview-help"><Spinner label="Loading merchants" testId="overview-merchants-loading" deferred /></p>;
  }
  const merchants = summary.byMerchant.filter((item) => item.currency === currency);
  const others = summary.otherMerchants.find((item) => item.currency === currency) ?? null;
  const total = summary.totals.find((item) => item.currency === currency)?.spendingMinor ?? 0;
  return (
    <>
      {merchants.length === 0 ? <p className="overview-help">{`No posted spending in ${props.periodName}`}</p> : null}
      <ul className="overview-list overview-rows" data-testid="overview-merchant-rows">
        {merchants.map((item) => {
          const expanded = props.open === item.merchantKey;
          const name = merchantDisplayName(item.merchant, item.merchantKey);
          return (
            <li key={item.merchantKey} className={expanded ? 'open' : undefined}>
              <button type="button" className="overview-row" aria-expanded={expanded} onClick={() => props.onToggle(item.merchantKey, item.spendingMinor)}
                title={name !== item.merchant ? item.merchant : undefined}>
                <span className="overview-row-name">{name}</span>
                <span className="spending-muted">{chargesText(item.count)}</span>
                <strong className="num">{netText(item.spendingMinor, item.count, currency)}</strong>
              </button>
              {expanded ? (
                <div className="overview-detail" data-testid="overview-merchant-detail">
                  <FilterButton active={props.filters.merchant === item.merchantKey}
                    onFilter={() => props.onFilterMerchant({ key: item.merchantKey, name: item.merchant })} />
                  <Charges read={props.charges} amountMinor={item.spendingMinor} currency={currency} onOpen={props.onOpen} />
                </div>
              ) : null}
            </li>
          );
        })}
        {others && others.merchants > 0 ? (
          <li className={props.othersOpen ? 'open' : undefined}>
            <button type="button" className="overview-row" aria-expanded={props.othersOpen} onClick={props.onOthers}>
              <span className="overview-row-name">{otherMerchantsText(others.merchants)}</span>
              <span className="spending-muted">{chargesText(others.count)}</span>
              <strong className="num">{formatMinor(others.spendingMinor, currency)}</strong>
            </button>
            {props.othersOpen ? (
              <div className="overview-detail" data-testid="overview-other-merchants-detail">
                <OtherMerchants read={props.charges} listed={summary.byMerchant} rest={others} filters={props.filters} currency={currency}
                  onOpen={props.onOpen} onFilterMerchant={props.onFilterMerchant} />
              </div>
            ) : null}
          </li>
        ) : null}
        <li className="overview-list-total"><span>Total</span><span /><strong className="num">{formatMinor(total, currency)}</strong></li>
      </ul>
    </>
  );
}

/**
 * An open "N other merchants" row of the By merchant view: its merchants, picked from the view's rows and grouped and
 * named as the summary groups and names them (cardSpendingOtherMerchants), largest first, each opening as a named
 * merchant does (the page's narrowing, then its charges); then how they add up to the row, their total only when every
 * row was read.
 */
function OtherMerchants(props: {
  read: ChargesRead | null;
  /** The merchants the summary names, above the row: never behind it. */
  listed: readonly CardSpendingMerchant[];
  rest: CardSpendingOtherMerchants;
  filters: SpendingFilters;
  currency: string;
  onOpen: (id: string) => void;
  onFilterMerchant: (merchant: MerchantFilter) => void;
}) {
  const { read, listed, currency } = props;
  const [open, setOpen] = useState<string | null>(null);
  const others = useMemo(() => (read?.status === 'done' ? cardSpendingOtherMerchants(read.rows, listed, currency, { complete: read.complete }) : null),
    [read, listed, currency]);
  if (read?.status !== 'done' || others === null) return <ReadStatus read={read} label="Loading merchants" testId="overview-others-loading" />;
  const tie = othersTieOut(
    { complete: read.complete, merchants: others.merchants.length, count: others.count, sumMinor: others.spendingMinor },
    { merchants: props.rest.merchants, count: props.rest.count, amountMinor: props.rest.spendingMinor },
  );
  return (
    <ul className="overview-list" aria-label="Other merchants" data-testid="overview-other-merchants">
      {others.merchants.map((item) => {
        const expanded = open === item.merchantKey;
        const name = merchantDisplayName(item.merchant, item.merchantKey);
        return (
          <li key={item.merchantKey}>
            <button type="button" className="overview-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.merchantKey)}
              title={name !== item.merchant ? item.merchant : undefined}>
              <span className="overview-row-name">{name}</span>
              <RestFigures count={item.count} amountMinor={item.spendingMinor} complete={read.complete} currency={currency} />
            </button>
            {expanded ? (
              <div className="overview-detail" data-testid="overview-other-merchant-detail">
                <FilterButton active={props.filters.merchant === item.merchantKey}
                  onFilter={() => props.onFilterMerchant({ key: item.merchantKey, name: item.merchant })} />
                <ChargeList rows={item.rows} complete={read.complete} sumMinor={item.spendingMinor} amountMinor={item.spendingMinor}
                  currency={currency} onOpen={props.onOpen} />
              </div>
            ) : null}
          </li>
        );
      })}
      <OthersTie tie={tie} currency={currency} />
    </ul>
  );
}

/**
 * A merchant's charges and amount behind "other merchants": as a named row's, when every row was read; else only how
 * many of its charges are shown, and no amount.
 */
function RestFigures({ count, amountMinor, complete, currency }: { count: number; amountMinor: number; complete: boolean; currency: string }) {
  return complete ? (
    <>
      <span className="spending-muted">{chargesText(count)}</span>
      <strong className="num">{netText(amountMinor, count, currency)}</strong>
    </>
  ) : (
    <>
      <span className="spending-muted">{`${chargesText(count)} shown`}</span>
      <span />
    </>
  );
}

/** The last row behind "other merchants": how many there are, and whether they add up to the row (othersTieOut). */
function OthersTie({ tie, currency }: { tie: ReturnType<typeof othersTieOut>; currency: string }) {
  return (
    <li className="overview-list-total" data-testid="overview-others-tie">
      <span>{tie.label}</span>
      <span className="spending-muted">{tie.note}</span>
      {tie.totalMinor !== null ? <strong className="num" data-testid="overview-others-total">{formatMinor(tie.totalMinor, currency)}</strong> : <span />}
    </li>
  );
}

/** A read not in yet, or why it failed: what shows in place of the rows it opens to. */
function ReadStatus({ read, label, testId }: { read: ChargesRead | null; label: string; testId: string }) {
  if (read?.status === 'failed') return <p className="overview-error overview-charges-status" role="status">{read.message}</p>;
  return <p className="overview-help overview-charges-status"><Spinner label={label} testId={testId} deferred /></p>;
}

/** Narrowing the whole page is its own, explicit step; once narrowed to this row, it says so instead. */
function FilterButton({ active, onFilter }: { active: boolean; onFilter: () => void }) {
  return (
    <p className="overview-filter">
      {active ? <span className="overview-help">This spending view is filtered to it</span> : (
        <>
          <button type="button" className="spending-button overview-filter-button" onClick={onFilter}>Filter this spending view</button>
          <span className="overview-help">Updates total and transactions</span>
        </>
      )}
    </p>
  );
}

/** A row's charges, and their total only when every row was read (a capped read says how many it shows instead). */
function Charges(props: { read: ChargesRead | null; amountMinor: number; currency: string; onOpen: (id: string) => void }) {
  const { read } = props;
  if (read?.status !== 'done') return <ReadStatus read={read} label="Loading charges" testId="overview-charges-loading" />;
  return <ChargeList rows={read.rows} complete={read.complete} sumMinor={read.sumMinor} amountMinor={props.amountMinor} currency={props.currency} onOpen={props.onOpen} />;
}

/** Charges read for a row, each opening its details; then how they add up to the row (lineTieOut). */
function ChargeList(props: {
  rows: readonly CardTransactionListRow[];
  complete: boolean;
  sumMinor: number;
  /** The row's own amount, which the charges add up to. */
  amountMinor: number;
  currency: string;
  onOpen: (id: string) => void;
}) {
  const { currency } = props;
  const tie = lineTieOut({ complete: props.complete, count: props.rows.length, sumMinor: props.sumMinor }, props.amountMinor);
  return (
    <ul className="overview-list overview-charges" data-testid="overview-transactions">
      {props.rows.map((row) => (
        <li key={row.id}>
          <button type="button" className="overview-row" onClick={() => props.onOpen(row.id)}>
            <span title={row.description}>{merchantDisplayName(row.merchantName, row.merchantKey)}</span>
            <span className="spending-muted">{shortDate(row.transactionDate)}{row.split ? ' · its part in this category' : ''}</span>
            <strong className="num">{formatRowAmount(shownAmount(row), currency)}</strong>
          </button>
        </li>
      ))}
      <li className="overview-list-total" data-testid="overview-line-tie">
        <span>{tie.label}</span>
        <span className="spending-muted">{tie.note}</span>
        {tie.totalMinor !== null ? <strong className="num" data-testid="overview-line-total">{formatRowAmount(tie.totalMinor, currency)}</strong> : <span />}
      </li>
    </ul>
  );
}

function lineName(line: Pick<CardSpendingMerchantLine, 'name' | 'key' | 'itemized'>): string {
  return `${merchantDisplayName(line.name, line.key)}${line.itemized ? ' · items' : ''}`;
}
