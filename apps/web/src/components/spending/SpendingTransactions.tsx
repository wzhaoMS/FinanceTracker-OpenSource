import { useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { CardAccount, CardTransactionView } from '@finance-tracker/shared';

import { ChevronDown, ChevronRight } from '../icons';
import { Spinner, TitleWithSpinner } from '../Spinner';
import { useUpdatingMark } from '../useUpdatingMark';
import { AmazonItemThumb } from '../amazon/AmazonItemThumb';
import { apiErrorMessage, updateCardTransaction, type AmazonCardDetail, type CardTransactionListRow } from './spendingApi';
import {
  OWNER_LABELS,
  STALE_PENDING_DAYS,
  amazonEvidenceText,
  amazonMarkerText,
  amazonOrderLines,
  amazonOrderStatusText,
  cardNameLabel,
  cardNameParts,
  categoryInferenceText,
  dayHeading,
  formatRowAmount,
  ownCategoryFromInput,
  pendingDays,
  shortDate,
  splitCategoryLabel,
} from './spendingFormat';
import { categoryShortLabel, categoryTone } from '../../modes/category';

interface Props {
  /** The list's section, for the headline's "N matching charges ↓ Transactions", which moves focus here. */
  anchorRef?: Ref<HTMLElement>;
  /** The period shown, as in a sentence: "March 2024", "the last 90 days", "2024 to date". */
  periodPhrase: string;
  pending: CardTransactionListRow[];
  posted: CardTransactionListRow[];
  postedTotal: number;
  hasMore: boolean;
  loading: boolean;
  /**
   * The list's read failed while none of its view's rows were on screen (another view's went): its error, said in place
   * of the rows, and "—" for the count, until a read of the view succeeds. Unknown is never "no transactions".
   */
  failure?: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  accountById: Map<string, CardAccount>;
  categories: string[];
  /** The category the list is filtered on: an open Amazon order marks its items there. */
  category?: string | null;
  /** Rows that may be precious metals, waiting for the owner's word (What counts). */
  suggestedIds?: ReadonlySet<string>;
  writesDisabled: boolean;
  onOpen: (id: string) => void;
  onChanged: (row: CardTransactionView) => void;
  onError: (message: string) => void;
}

export function SpendingTransactions(props: Props) {
  const groups = useMemo(() => {
    const byDate = new Map<string, CardTransactionListRow[]>();
    for (const row of props.posted) byDate.set(row.transactionDate, [...(byDate.get(row.transactionDate) ?? []), row]);
    return [...byDate.entries()];
  }, [props.posted]);
  const listId = useId();
  const failure = props.failure ?? null;
  const empty = !props.loading && failure === null && props.pending.length === 0 && props.posted.length === 0;
  // Read again (another view, or after a change): the rows shown are the last read's, dimmed at once while the new ones
  // are read, and a moment after they land. A first read, with nothing shown yet, only waits a moment for its spinner.
  // A read that failed is not held: its error says what happened.
  const updating = useUpdatingMark(props.loading && (props.pending.length > 0 || props.posted.length > 0), { failed: failure !== null });
  const busy = props.loading || updating;
  return (
    <section ref={props.anchorRef} tabIndex={-1} className="spending-panel spending-transactions" aria-label="Card transactions"
      data-updating={updating ? 'true' : undefined}>
      <header className="spending-panel-head">
        <TitleWithSpinner busy={busy} label="Loading transactions" testId="transactions-loading" deferred={!updating}>
          <h3>Transactions</h3>
        </TitleWithSpinner>
        {busy ? null : <span className="spending-muted">{failure === null ? `${props.postedTotal} posted` : '—'}</span>}
      </header>
      <datalist id={listId}>
        {props.categories.map((category) => <option key={category} value={category} />)}
      </datalist>
      {failure !== null ? <p className="overview-error" data-testid="transactions-error">{`Couldn't read these transactions: ${failure}`}</p> : null}
      {empty ? <p className="spending-muted">No card transactions in {props.periodPhrase} for these filters.</p> : null}
      {props.pending.length > 0 ? (
        <div className="spending-group pending" role="group" aria-label={`Pending (${props.pending.length})`}>
          <h4>Pending ({props.pending.length})</h4>
          <ul className="spending-rows">
            {props.pending.map((row) => <TransactionRow key={row.id} row={row} {...props} datalistId={listId} />)}
          </ul>
        </div>
      ) : null}
      {groups.map(([date, rows]) => (
        <div key={date} className="spending-group" role="group" aria-label={dayHeading(date)}>
          <h4>{dayHeading(date)}</h4>
          <ul className="spending-rows">
            {rows.map((row) => <TransactionRow key={row.id} row={row} {...props} datalistId={listId} />)}
          </ul>
        </div>
      ))}
      {props.hasMore ? (
        <button type="button" className="spending-button" disabled={props.loadingMore} onClick={props.onLoadMore}>
          {props.loadingMore
            ? <Spinner label="Loading more transactions" testId="transactions-loading-more" />
            : `Show more (${props.postedTotal - props.posted.length} left)`}
        </button>
      ) : null}
    </section>
  );
}

/** On whose word an asset purchase is not spending, as its badge's tooltip says it. */
function exclusionBadgeTitle(source: NonNullable<CardTransactionView['exclusion']>['source']): string {
  if (source === 'owner-category') return 'An asset purchase, not spending: you filed it under Precious metals';
  if (source === 'owner-rule') return 'An asset purchase, not spending: one of your rules covers it';
  return 'Not spending: the exact refund of a precious-metals purchase';
}

function TransactionRow(props: Props & { row: CardTransactionListRow; datalistId: string }) {
  const { row } = props;
  const account = props.accountById.get(row.cardAccountId);
  const card = cardNameParts(account);
  const days = row.status === 'pending' ? pendingDays(row.transactionDate) : 0;
  const stale = days > STALE_PENDING_DAYS;
  // Not spending: a card payment, or an asset purchase, reads muted.
  const amountClass = row.role === 'transfer' || row.exclusion ? 'transfer' : row.amountMinor < 0 ? 'credit' : 'charge';
  const showDescription = row.merchantName !== row.description;
  // Under a category filter a split charge is in view for its part in that category, not its whole amount.
  const portion = row.categoryPortionMinor !== undefined && row.categoryPortionMinor !== row.amountMinor ? row.categoryPortionMinor : null;
  // A charge with an Amazon order says so in its own marker, which lists its items' categories.
  const split = row.split && row.split.length > 1 && !row.amazon ? row.split : null;
  return (
    <li className={`spending-row ${row.status}`} data-transaction-id={row.id}>
      <button
        type="button"
        className="spending-row-main"
        aria-label={`${row.merchantName}, ${formatRowAmount(row.amountMinor, row.currency)}, ${shortDate(row.transactionDate)}: details`}
        onClick={() => props.onOpen(row.id)}
      >
        <span className="spending-row-date num">{shortDate(row.transactionDate)}</span>
        <span className="spending-row-text" title={showDescription ? `${row.merchantName}\n${row.description}` : row.merchantName}>
          <span className="spending-row-merchant">{row.merchantName}</span>
          {showDescription ? <span className="spending-row-description">{row.description}</span> : null}
          {row.role === 'transfer' ? <span className="spending-badge">Card payment · not spending</span> : null}
          {row.role === 'excluded' && row.exclusion ? (
            <span className="spending-badge asset" title={exclusionBadgeTitle(row.exclusion.source)}>
              Precious metals · not spending
            </span>
          ) : row.role === 'excluded' ? <span className="spending-badge">Not counted</span> : null}
          {row.role === 'spending' && props.suggestedIds?.has(row.id) ? (
            <span className="spending-badge warn" title="Counted as spending until you decide, in What counts above">
              Possibly precious metals?
            </span>
          ) : null}
          {split ? (
            <span
              className="spending-badge"
              title={split.map((item) => `${item.category}: ${formatRowAmount(item.amountMinor, row.currency)}`).join('\n')}
            >
              Split across {split.length} categories
            </span>
          ) : null}
          {stale ? (
            <span
              className="spending-badge warn"
              title="Not counted. If it was cancelled, dismiss it; if it posted under another reference, open it and pick its posted row; if it is a hold still open (a hotel or car rental, say), leave it."
            >
              Pending {days} days · may have been cancelled
            </span>
          ) : null}
        </span>
        {/* Name, ending and person apart, so a narrow cell shortens only the name: never the ending or the person. */}
        <span className="spending-row-card" title={`${cardNameLabel(account)}${account ? ` · ${OWNER_LABELS[account.owner]}` : ''}`}>
          <span className="spending-row-card-name">{card.name}</span>
          {card.ending ? <span className="spending-row-card-ending">{` ··${card.ending}`}</span> : null}
          {account ? <span className="spending-row-card-owner">{` · ${OWNER_LABELS[account.owner]}`}</span> : null}
        </span>
        <span className={`spending-row-amount num ${amountClass}`}>
          {formatRowAmount(row.amountMinor, row.currency)}
          {row.originalCurrency && row.originalAmountMinor !== undefined ? (
            <span className="spending-row-original">{formatRowAmount(row.originalAmountMinor, row.originalCurrency)}</span>
          ) : null}
          {portion !== null ? (
            <span className="spending-row-original" title="This charge's part in the category shown">
              {formatRowAmount(portion, row.currency)} in this category
            </span>
          ) : null}
        </span>
      </button>
      {row.role === 'transfer' ? <span className="spending-category-none" aria-hidden /> : <CategoryCell {...props} />}
      {row.amazon ? <AmazonRowOrder row={row} amazon={row.amazon} category={props.category ?? null} /> : null}
    </li>
  );
}

/**
 * A listed charge's Amazon order: a marker that opens its items in place, each with its amount and category in this
 * answer (the rest of the charge under the card's own), and how the order was tied and the charge is filed.
 */
function AmazonRowOrder({ row, amazon, category }: { row: CardTransactionListRow; amazon: AmazonCardDetail; category: string | null }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const lines = useMemo(() => amazonOrderLines(amazon), [amazon]);
  const marker = amazonMarkerText(lines);
  return (
    <div className="spending-row-amazon">
      <button
        type="button"
        className="spending-row-amazon-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${marker}: ${row.merchantName}, ${formatRowAmount(row.amountMinor, row.currency)}`}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {marker}
      </button>
      {open ? (
        <div id={listId} className="spending-row-amazon-items">
          <p>
            Amazon order{amazon.evidenceClass ? `, ${amazonEvidenceText(amazon.evidenceClass)}` : ''}. {amazonOrderStatusText(amazon, row.userCategory)}
          </p>
          {lines.length > 0 ? (
            <ul aria-label={`Items of ${row.merchantName}`}>
              {lines.map((line) => {
                const inCategory = category !== null && line.category === category;
                const meta = [
                  line.quantity && line.quantity > 1 ? `× ${line.quantity}` : null,
                  line.category ? (line.kind === 'rest' ? `${line.category} (the card’s own)` : line.category) : null,
                  inCategory ? 'in this category' : null,
                ].filter((text): text is string => text !== null);
                return (
                  <li key={line.key} className={inCategory ? 'in-category' : undefined} data-category-tone={line.category ? categoryTone(line.category) : undefined}>
                    {line.kind === 'item' ? <AmazonItemThumb itemRef={line.itemRef} image={line.image} size="small" /> : null}
                    <span
                      className={`spending-row-item-title${line.kind === 'item' && !line.title ? ' hidden' : ''}`}
                      title={line.title ?? undefined}
                    >
                      {line.kind === 'rest' ? 'Rest of the charge' : line.title ?? 'Item title not shown'}
                    </span>
                    <span className="spending-row-item-amount num">
                      {line.amountMinor !== null ? formatRowAmount(line.amountMinor, row.currency) : ''}
                    </span>
                    {meta.length > 0 ? <span className="spending-row-item-meta">{meta.join(' · ')}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The category, editable in place: Enter or leaving the field saves, Escape cancels, empty restores the issuer's. */
function CategoryCell(props: Props & { row: CardTransactionListRow; datalistId: string }) {
  const { row } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  // A category Holdr inferred (enriched answers only): shown as such, never saved as the owner's own by accident.
  const inference = row.categorySource === 'inferred' ? row.categoryInference ?? null : null;

  const start = () => {
    cancelled.current = false;
    setValue(row.userCategory ?? row.category);
    setEditing(true);
  };

  const save = async () => {
    if (cancelled.current) return;
    // Enter saves and unmounts the field; a blur that follows must not save again.
    cancelled.current = true;
    const current = row.userCategory ?? '';
    // What the row counts under anyway (or nothing) clears the custom one, and an inferred category left as it is
    // stays inferred.
    const userCategory = ownCategoryFromInput(row, value);
    setEditing(false);
    if ((userCategory ?? '') === current) return;
    setSaving(true);
    try {
      props.onChanged(await updateCardTransaction(row.id, { userCategory }));
    } catch (reason) {
      props.onError(apiErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      cancelled.current = true;
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        className="spending-category-input"
        // The row stays a list item; focus moves here on purpose when editing starts.
        autoFocus
        value={value}
        list={props.datalistId}
        maxLength={100}
        aria-label={`Category for ${row.merchantName}`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { void save(); }}
      />
    );
  }
  // An issuer's long category shows its top level; the full name stays in the tooltip, the accessible name and the details.
  // A charge split by its Amazon items shows their categories: the largest, and how many more.
  const split = row.split && row.split.length > 0 ? row.split : null;
  const label = split ? splitCategoryLabel(split) : row.userCategory ? row.category : categoryShortLabel(row.category);
  const about = row.userCategory
    ? ` · your category (issuer: ${row.issuerCategory ?? 'none'})`
    : `${inference ? ` · ${categoryInferenceText(inference)}` : ''} · click to set your own category`;
  const named = split
    ? split.map((item) => `${item.category} ${formatRowAmount(item.amountMinor, row.currency)}`).join(', ')
    : row.category;
  return (
    <button
      type="button"
      className={`spending-category${row.userCategory ? ' custom' : ''}${inference ? ' inferred' : ''}${split ? ' split' : ''}`}
      data-category-tone={categoryTone(split ? split[0].category : row.category)}
      data-full-category={split ? named : label !== row.category ? row.category : undefined}
      disabled={props.writesDisabled || saving}
      title={split ? `By its items: ${named} · click to set your own category for the whole charge` : `${row.category}${about}`}
      // The label shown comes first, so the name says what is on screen ("Electronics +2") before the full split.
      aria-label={split
        ? `${label}: categories ${named} for ${row.merchantName}; change`
        : `Category ${row.category}${inference ? ' (inferred)' : ''} for ${row.merchantName}; change`}
      onClick={start}
    >
      {saving ? 'Saving…' : label}
    </button>
  );
}
