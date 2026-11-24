import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  CARD_ASSET_CATEGORY,
  CARD_UNCATEGORIZED,
  type CardAccount,
  type CardCategoryBasis,
  type CardTransactionView,
} from '@finance-tracker/shared';

import { EVERYDAY_AREAS } from '../../modes/route';
import { X } from '../icons';
import { AmazonItemThumb } from '../amazon/AmazonItemThumb';
import type { MerchantFilter } from './SpendingInsights';
import { PaymentMatchSection } from './PaymentMatchSection';
import { ApiError } from '../../services/api';
import {
  apiErrorMessage,
  fetchCardTransaction,
  fetchPaymentMatch,
  updateCardTransaction,
  type AmazonCardDetail,
  type CardTransactionCategorized,
  type CardTransactionChange,
  type CardTransactionDetailResponse,
  type PaymentMatchView,
} from './spendingApi';
import {
  OWNER_LABELS,
  STALE_PENDING_DAYS,
  amazonEvidenceText,
  amazonLineCategorySource,
  amazonOrderLines,
  amazonOrderStatusText,
  amazonWholeRowReasonText,
  cardNameLabel,
  cashOutflowLabel,
  categoryInferenceText,
  dateRangeLabel,
  dayOffsetLabel,
  formatRowAmount,
  kindLabel,
  longDate,
  ownCategoryFromInput,
  paymentSourceWindowLabel,
  pendingDays,
  sourceLabel,
} from './spendingFormat';

interface Props {
  id: string;
  accountById: Map<string, CardAccount>;
  categories: string[];
  /** The panel's category basis: under the enriched one, an inferred category shows with why. */
  categoryBasis?: CardCategoryBasis;
  writesDisabled: boolean;
  onClose: () => void;
  onChanged: (row: CardTransactionView) => void;
  /** Lists every charge from the merchant; left out where no list is beside the drawer (the Gold page). */
  onShowMerchant?: (merchant: MerchantFilter) => void;
  /** Open another transaction in this drawer. */
  onOpen: (id: string) => void;
  /** Where it came from and its history (E8-M, proposal §3.8); absent while this Holdr has no extension sync. */
  onSources?: () => void;
}

function statusText(row: CardTransactionView): string {
  if (row.status === 'pending') {
    const pending = 'Pending: not counted as spending. It turns posted when an import brings it under the same reference, '
      + 'or when you confirm that a posted row is it.';
    const days = pendingDays(row.transactionDate);
    return days > STALE_PENDING_DAYS
      ? `${pending} It has been pending ${days} days: if it was cancelled, dismiss it; if it posted under another reference, `
        + 'pick its posted row; if it is a hold still open (a hotel or car rental, say), leave it.'
      : pending;
  }
  if (row.status === 'posted') return `Posted ${longDate(row.postedDate ?? row.transactionDate)}.`;
  if (row.dismissedAt) return `Was pending; dismissed ${longDate(row.dismissedAt.slice(0, 10))}. Not counted as spending.`;
  return 'Removed by the issuer. Not counted as spending.';
}

/** A linked order opens in the Amazon view once it is one of Everyday's areas. */
const AMAZON_VIEW = (EVERYDAY_AREAS as readonly string[]).includes('amazon');

/** A payment's standing against the checking debits as read for one row, or why it could not be read. */
type PaymentMatchRead =
  | { id: string; match: PaymentMatchView | null; decisionsInstalled: boolean }
  | { id: string; error: string };

/** A payment to the card, not removed: it stands against the checking debits. */
function isPaymentToCard(row: CardTransactionView): boolean {
  return row.kind === 'payment' && row.amountMinor < 0 && row.status !== 'removed';
}

/** On whose word an asset purchase is not spending. */
function exclusionDetailText(source: NonNullable<CardTransactionView['exclusion']>['source']): string {
  if (source === 'owner-category') return 'your category';
  if (source === 'owner-rule') return 'one of your rules';
  return 'the exact refund of a precious-metals purchase';
}

/**
 * Whose category the rest of a split charge counts under: the card's own (the owner's, the issuer's, or none), or,
 * for a charge with none of its own, the one enriched categories infer for it, with why when the answer says.
 */
function residualText(row: CardTransactionCategorized, category: string | null): string {
  if (row.categoryInference) return categoryInferenceText(row.categoryInference);
  return row.userCategory || row.issuerCategory || category === row.category
    ? 'the card’s own category'
    : 'inferred: the charge has no category of its own';
}

/**
 * The charge's Amazon order. Linked: how it was tied, every item of the order (full title, quantity, ASIN) and,
 * where Spending files the charge under its items, each item's category and amount, its share of tax, shipping and
 * discounts said apart (or, for an amount wholly allocated by price share, that). Held: only why and how many
 * candidates, never their items. Nothing without an order.
 */
function AmazonOrderSection(props: { amazon: AmazonCardDetail; row: CardTransactionCategorized; onClose: () => void }) {
  const { amazon, row } = props;
  if (amazon.match === 'held') {
    const count = amazon.hold?.candidateCount ?? 0;
    return (
      <section className="spending-detail-amazon" aria-label="Amazon order">
        <p>
          <strong>Amazon order on hold:</strong> {amazonWholeRowReasonText(amazon.hold?.reason)}
          {count > 0 ? ` (${count} possible ${count === 1 ? 'order' : 'orders'})` : ''}. The charge counts whole, under its own category.
        </p>
      </section>
    );
  }
  if (amazon.match !== 'linked') return null;
  const lines = amazonOrderLines(amazon);
  return (
    <section className="spending-detail-amazon" aria-label="Amazon order">
      <p>
        <strong>Amazon order</strong>{amazon.evidenceClass ? `, ${amazonEvidenceText(amazon.evidenceClass)}` : ''}.{' '}
        {amazonOrderStatusText(amazon, row.userCategory)}
      </p>
      {lines.length > 0 ? (
        <ul className="spending-amazon-items">
          {lines.map((line) => {
            if (line.kind === 'rest') {
              return (
                <li key={line.key}>
                  <span className="spending-amazon-title">Rest of the charge</span>
                  <span className="num">{formatRowAmount(line.amountMinor ?? 0, row.currency)}</span>
                  <span className="spending-amazon-meta">{line.category} ({residualText(row, line.category)})</span>
                </li>
              );
            }
            const meta = [
              line.category && line.categoryPart ? `${line.category} (${amazonLineCategorySource(line.categoryPart)})` : null,
              line.quantity && line.quantity > 1 ? `× ${line.quantity}` : null,
              line.asin ? `ASIN ${line.asin}` : null,
            ].filter((text): text is string => text !== null);
            return (
              <li key={line.key}>
                <AmazonItemThumb itemRef={line.itemRef} image={line.image} size="medium" />
                <span className={`spending-amazon-title${line.title ? '' : ' hidden'}`} title={line.title ?? undefined}>
                  {line.title ?? 'Item title not shown'}
                </span>
                <span className="num">{line.amountMinor !== null ? formatRowAmount(line.amountMinor, row.currency) : ''}</span>
                {meta.length > 0 ? <span className="spending-amazon-meta">{meta.join(' · ')}</span> : null}
                {line.allocatedOnly ? (
                  <span className="spending-amazon-meta">amount allocated by price share</span>
                ) : line.allocatedMinor !== 0 ? (
                  <span className="spending-amazon-meta">
                    includes {formatRowAmount(line.allocatedMinor, row.currency)} of tax, shipping and discounts, shared by price
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {AMAZON_VIEW ? (amazon.orderRefs ?? []).map((ref, index, refs) => (
        <a
          key={ref}
          className="spending-link"
          href={`#/everyday/amazon/orders/${encodeURIComponent(ref)}`}
          onClick={(event) => { if (event.nativeEvent.defaultPrevented) props.onClose(); }}
        >
          {refs.length > 1 ? `Open order ${index + 1} in Amazon` : 'Open the order in Amazon'}
        </a>
      )) : null}
    </section>
  );
}

/** One transaction: a side drawer on wide screens, full screen on phones. */
export function SpendingDetail(props: Props) {
  const [detail, setDetail] = useState<CardTransactionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  /** A payment's standing against the checking debits, read on its own for the row on show (or why it could not be). */
  const [paymentMatch, setPaymentMatch] = useState<PaymentMatchRead | null>(null);
  const [matchVersion, setMatchVersion] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // The transaction on show, and a number per save: a save's answer only lands on the
  // transaction it was made for, and only if no later save or opening came in between.
  const shownId = useRef(props.id);
  shownId.current = props.id;
  const saveSeq = useRef(0);
  const titleId = useId();
  const listId = useId();
  const formId = useId();

  useEffect(() => {
    let cancelled = false;
    saveSeq.current += 1;
    setSaving(false);
    setDetail(null);
    setError(null);
    fetchCardTransaction(props.id, props.categoryBasis)
      .then((body) => {
        if (cancelled) return;
        setDetail(body);
        setCategory(body.transaction.userCategory ?? '');
        setNotes(body.transaction.notes ?? '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(apiErrorMessage(reason));
      });
    return () => { cancelled = true; };
  }, [props.id, props.categoryBasis]);

  // A payment to the card: where it stands against checking, from the reconciliation's own route.
  const matchId = detail && isPaymentToCard(detail.transaction) ? detail.transaction.id : null;
  useEffect(() => {
    setPaymentMatch(null);
    if (!matchId) return undefined;
    let cancelled = false;
    fetchPaymentMatch(matchId)
      .then((body) => {
        if (!cancelled) setPaymentMatch({ id: matchId, match: body.paymentMatch, decisionsInstalled: body.decisions.installed });
      })
      .catch((reason: unknown) => {
        // An API that predates the reconciliation has no such route: nothing to show.
        if (cancelled || (reason instanceof ApiError && reason.status === 404)) return;
        setPaymentMatch({ id: matchId, error: apiErrorMessage(reason) });
      });
    return () => { cancelled = true; };
  }, [matchId, matchVersion]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  /** Saves a change; true when the API took it (whatever is open by then). */
  const apply = async (change: CardTransactionChange): Promise<boolean> => {
    if (!detail) return false;
    const id = detail.transaction.id;
    const seq = ++saveSeq.current;
    const current = () => saveSeq.current === seq && shownId.current === id;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCardTransaction(id, change);
      // The list shows the change whatever is open now.
      props.onChanged(updated);
      if (!current()) return true;
      const fresh = await fetchCardTransaction(updated.id, props.categoryBasis);
      if (!current()) return true;
      setDetail(fresh);
      setCategory(updated.userCategory ?? '');
      setNotes(updated.notes ?? '');
      return true;
    } catch (reason) {
      if (current()) setError(apiErrorMessage(reason));
      return false;
    } finally {
      if (saveSeq.current === seq) setSaving(false);
    }
  };

  /** The owner's word on this payment against the checking debits; then where it stands is read again. */
  const decidePayment = async (run: () => Promise<unknown>) => {
    if (!detail) return;
    const transaction = detail.transaction;
    const seq = ++saveSeq.current;
    const current = () => saveSeq.current === seq && shownId.current === transaction.id;
    setSaving(true);
    setError(null);
    try {
      await run();
      // The row itself is unchanged; what reads the reconciliation refreshes.
      props.onChanged(transaction);
    } catch (reason) {
      if (current()) setError(apiErrorMessage(reason));
    } finally {
      if (saveSeq.current === seq) setSaving(false);
      // Answered or refused, what was shown may be out of date: nothing of it stays to act on until it is read again.
      if (current()) {
        setPaymentMatch(null);
        setMatchVersion((value) => value + 1);
      }
    }
  };

  /** The owner's word that this pending row posted as `postedId`: then show that row. */
  const matchPosted = async (postedId: string) => {
    const id = detail?.transaction.id;
    if (await apply({ postedAs: postedId }) && shownId.current === id) props.onOpen(postedId);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    const row = detail.transaction;
    const nextNotes = notes.trim();
    const change: CardTransactionChange = {};
    // As the list's editor: the issuer's category, Uncategorized or an inferred one, unchanged, is not the owner's.
    const userCategory = ownCategoryFromInput(row, category);
    if ((userCategory ?? '') !== (row.userCategory ?? '')) change.userCategory = userCategory;
    if (nextNotes !== (row.notes ?? '')) change.notes = nextNotes || null;
    if (Object.keys(change).length > 0) void apply(change);
  };

  const row = detail?.transaction;
  const account = row ? detail?.cardAccount ?? props.accountById.get(row.cardAccountId) : undefined;
  const batch = detail?.importBatch;
  const restorable = row?.status === 'removed' && Boolean(row.dismissedAt);
  const suggestions = row?.status === 'pending' ? detail?.possiblyPostedAs ?? [] : [];
  const paidFrom = row?.kind === 'payment' && row.status !== 'removed' ? detail?.possiblyPaidFrom ?? [] : [];
  const matchRead = row && paymentMatch?.id === row.id ? paymentMatch : null;
  const matchError = matchRead && 'error' in matchRead ? matchRead.error : null;
  const matchShown = matchRead && !('error' in matchRead) ? matchRead : null;
  return (
    <div className="spending-detail-backdrop" onClick={() => props.onClose()}>
      <div
        ref={dialogRef}
        className="spending-detail with-footer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="spending-detail-head">
          <h3 id={titleId}>{row?.merchantName ?? 'Transaction'}</h3>
          <button type="button" className="spending-icon-button" aria-label="Close details" onClick={() => props.onClose()}>
            <X size={16} />
          </button>
        </header>
        {/* The body scrolls; the footer's actions stay in reach, however long the details. */}
        <div className="spending-detail-body">
          {error ? <div className="spending-error" role="alert">{error}</div> : null}
          {!row ? (!error ? <p className="spending-muted">Loading…</p> : null) : (
            <>
              <div className="spending-detail-amount" data-role={row.role}>
                <strong className={`num ${row.amountMinor < 0 ? 'credit' : ''}`}>{formatRowAmount(row.amountMinor, row.currency)}</strong>
                <span className={`spending-status ${row.status}`}>{row.status === 'removed' ? 'Removed' : row.status === 'pending' ? 'Pending' : 'Posted'}</span>
              </div>
              <p className="spending-detail-status">{statusText(row)}</p>
              {suggestions.length > 0 ? (
                <section className="spending-detail-suggestions" aria-label="Possibly posted as">
                  <p>
                    <strong>Possibly posted as</strong> (same card and amount, nearby date). If one of these is this
                    charge, pick it: this pending row is dismissed and kept, so no import brings it back, and its
                    category and notes go to the posted row where that row has none. Holdr does not decide that for you.
                  </p>
                  <ul>
                    {suggestions.map((item) => (
                      <li key={item.id}>
                        <span>{longDate(item.transactionDate)} · {item.description}</span>
                        <span className="num">{formatRowAmount(item.amountMinor, item.currency)}</span>
                        <button type="button" className="spending-button ghost" disabled={saving} onClick={() => props.onOpen(item.id)}>
                          Open
                        </button>
                        <button
                          type="button"
                          className="spending-button"
                          disabled={props.writesDisabled || saving}
                          aria-label={`This is its posted row: ${longDate(item.transactionDate)}, ${item.description}`}
                          onClick={() => { void matchPosted(item.id); }}
                        >
                          This is its posted row
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {matchError ? (
                <section className="spending-detail-suggestions paid-from payment-match" aria-label="Paid from checking" data-status="error">
                  <p role="alert">Where this payment stands against checking could not be read: {matchError}</p>
                  <button type="button" className="spending-link inline" onClick={() => setMatchVersion((value) => value + 1)}>Read again</button>
                </section>
              ) : matchShown?.match && row ? (
                <PaymentMatchSection
                  paymentId={row.id}
                  match={matchShown.match}
                  disabled={props.writesDisabled || saving || !matchShown.decisionsInstalled}
                  onDecide={(run) => { void decidePayment(run); }}
                />
              ) : null}
              {paidFrom.length > 0 ? (
                <section className="spending-detail-suggestions paid-from" aria-label="Possibly paid from">
                  <p>
                    <strong>Possibly paid from</strong> (a brokerage withdrawal or transfer out of the same amount and
                    currency, {paymentSourceWindowLabel()}). A suggestion only: Holdr links nothing, and brokerage cash,
                    holdings and returns stay as they are.
                  </p>
                  <ul>
                    {paidFrom.map((item, index) => (
                      <li key={`${item.date}-${index}`}>
                        <span>
                          {longDate(item.date)} · {item.accountName} · {cashOutflowLabel(item.eventType)}, {dayOffsetLabel(item.dayOffset)}
                          {item.description ? <span className="spending-detail-suggestion-text">{item.description}</span> : null}
                        </span>
                        <span className="num">{formatRowAmount(item.amountMinor, item.currency)}</span>
                      </li>
                    ))}
                  </ul>
                  {/* The brokerage side lives in Investing: its Transactions tab opens on the cash ledger.
                      Followed here (the app's router takes a plain click), it closes these details, so a step
                      back finds the list as it was; a click that opens another tab leaves them open. */}
                  <a
                    className="spending-link"
                    href="#/investing/transactions"
                    onClick={(event) => { if (event.nativeEvent.defaultPrevented) props.onClose(); }}
                  >
                    Open the cash ledger in Investing
                  </a>
                </section>
              ) : null}
              {detail?.amazon ? <AmazonOrderSection amazon={detail.amazon} row={row} onClose={props.onClose} /> : null}
              <dl className="spending-detail-fields">
                <dt>Description</dt>
                <dd>{row.description}</dd>
                {row.merchant ? (<><dt>Merchant</dt><dd>{row.merchant}</dd></>) : null}
                <dt>Transaction date</dt>
                <dd>{longDate(row.transactionDate)}</dd>
                <dt>Posted date</dt>
                <dd>{row.postedDate ? longDate(row.postedDate) : '—'}</dd>
                <dt>Card</dt>
                <dd>
                  {cardNameLabel(account)}
                  {account ? ` · ${OWNER_LABELS[account.owner]}` : ''}
                </dd>
                <dt>Kind</dt>
                <dd>
                  {kindLabel(row.kind)}
                  {row.role === 'transfer' ? ' · a transfer, not spending'
                    : row.exclusion ? ` · precious metals: an asset purchase, not spending (${exclusionDetailText(row.exclusion.source)})`
                      : row.role === 'excluded' ? ' · not counted as spending' : ''}
                </dd>
                {row.originalCurrency && row.originalAmountMinor !== undefined ? (
                  <>
                    <dt>Original amount</dt>
                    <dd>{formatRowAmount(row.originalAmountMinor, row.originalCurrency)} (charged in {row.currency})</dd>
                  </>
                ) : null}
                <dt>Issuer category</dt>
                <dd>{row.issuerCategory ?? '—'}</dd>
                {row.categorySource === 'inferred' && row.categoryInference ? (
                  <>
                    <dt>Inferred category</dt>
                    <dd data-inferred-category>
                      {row.categoryInference.category} · {categoryInferenceText(row.categoryInference)}
                    </dd>
                  </>
                ) : null}
                <dt>Source</dt>
                <dd>{sourceLabel(row.source)}</dd>
                {batch ? (
                  <>
                    <dt>Import</dt>
                    <dd>
                      {new Date(batch.importedAt).toLocaleString()} · {batch.parserVersion}
                      {batch.coverage ? ` · covers ${dateRangeLabel(batch.coverage.start, batch.coverage.end)}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
              <form id={formId} className="spending-detail-form" onSubmit={save}>
                <label>
                  <span>Your category</span>
                  <input
                    value={category}
                    list={listId}
                    maxLength={100}
                    placeholder={row.categorySource === 'inferred' ? row.category : row.issuerCategory ?? CARD_UNCATEGORIZED}
                    disabled={props.writesDisabled || saving}
                    onChange={(event) => setCategory(event.target.value)}
                  />
                  <datalist id={listId}>
                    {props.categories.map((item) => <option key={item} value={item} />)}
                  </datalist>
                </label>
                <label>
                  <span>Notes</span>
                  <textarea
                    value={notes}
                    maxLength={1000}
                    rows={3}
                    disabled={props.writesDisabled || saving}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </label>
              </form>
              <div className="spending-detail-actions">
                {props.onShowMerchant ? (
                  <button type="button" className="spending-button ghost"
                    onClick={() => props.onShowMerchant?.({ key: row.merchantKey, name: row.merchantName })}>
                    All from this merchant
                  </button>
                ) : null}
                {row.role === 'spending' && (row.kind === 'purchase' || row.kind === 'refund') && row.status !== 'removed'
                  // Not for a charge linked to an Amazon order: the Amazon view counts its items on their own.
                  && detail?.amazon?.match !== 'linked' ? (
                  <button
                    type="button"
                    className="spending-button ghost"
                    disabled={props.writesDisabled || saving}
                    title="Bullion and coins are an asset purchase: kept in your transactions, left out of spending"
                    onClick={() => { void apply({ userCategory: CARD_ASSET_CATEGORY }); }}
                  >
                    Precious metals (not spending)
                  </button>
                ) : null}
                {props.onSources ? (
                  <button type="button" className="spending-button ghost" disabled={saving} onClick={props.onSources}>
                    Sources and history…
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
        {row ? (
          <footer className="spending-detail-footer">
            <button type="submit" form={formId} className="spending-button primary" disabled={props.writesDisabled || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {row.status === 'pending' ? (
              <button
                type="button"
                className="spending-button"
                disabled={props.writesDisabled || saving}
                title="For a pending charge that will not post as it is: a hold, a tip that changed the amount, or one that posted under another reference"
                onClick={() => { void apply({ status: 'removed' }); }}
              >
                Dismiss pending
              </button>
            ) : null}
            {restorable ? (
              <button
                type="button"
                className="spending-button"
                disabled={props.writesDisabled || saving}
                onClick={() => { void apply({ status: 'pending' }); }}
              >
                Restore as pending
              </button>
            ) : null}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
