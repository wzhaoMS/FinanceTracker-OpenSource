import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type Ref } from 'react';
import { ITEM_TAXONOMY_V2_VIEW, type ItemTaxonomyV2NodeId } from '@finance-tracker/shared';
import { Search } from '../icons';
import {
  RETAIL_API_CHANNELS,
  RETAIL_API_QUARANTINE_REASONS,
  RETAIL_API_SEARCH,
  type RetailApiChannel,
  type RetailApiLine,
  type RetailApiOnlineStatus,
  type RetailApiQuarantineReason,
  type RetailApiReceipt,
  type RetailApiReceiptDetail,
  type RetailApiReceiptRow,
  type RetailApiReceipts,
  type RetailApiReceiptsPresent,
  type RetailApiReceiptState,
  type RetailApiSign,
  type RetailApiSummary,
  type RetailApiSummaryPresent,
} from '@finance-tracker/shared/retail-api';

import { OWNER_LABELS } from '../spending/spendingFormat';
import { fetchCostcoReceipt, fetchCostcoReceipts, fetchCostcoSummary, type CostcoReceiptsQuery } from './costcoApi';
import {
  CHANNEL_LABELS,
  COSTCO_ABSENT,
  COSTCO_BANNER,
  COSTCO_METAL_TAG,
  COSTCO_SUGGESTED,
  FULFILMENT_LABELS,
  ONLINE_STATUS_LABELS,
  QUARANTINE_REASON_TEXT,
  SIGN_LABELS,
  captureRangeText,
  captureText,
  categoryChip,
  categoryFilterOptions,
  channelCountsText,
  costcoDate,
  costcoErrorText,
  costcoMoney,
  fuelText,
  groupCostcoLines,
  heldText,
  isMetalLine,
  lineEventTexts,
  lineKindText,
  lineTitle,
  matchingLineText,
  membershipLabels,
  membershipsText,
  metalDetailText,
  metalUncertainText,
  pageText,
  plural,
  quantityText,
  receiptCountText,
  receiptNameText,
  receiptWhenText,
  rowItemsText,
  rowSplitText,
  shipmentText,
  shownLineTitle,
  tenderKindsText,
  tenderText,
  totalsRows,
  underReviewText,
  type CostcoCategoryChip,
  type CostcoLineGroup,
} from './costcoFormat';

/**
 * Everyday's Costco receipts page: the receipts and online orders Holdr's retail import stored, read-only, each with
 * its item lines. Receipt detail only: each purchase is already in Spending as its card charge, so nothing here adds
 * to any total, and no figure on the page is a sum across receipts. A list row shows its receipt's own stated total
 * and how that receipt was paid (its tender kinds, and its own card and other parts); a receipt opens in place, with
 * every line in order, its coupons and fees under their lines, each item, fee or fuel line's category from the shared
 * item tree (a precious metal keeps its own tag), its totals and tax legends as stated, and its tenders with the card's
 * network and last four. Categories are only shown and filtered on, never added up. Quarantined receipts are listed,
 * marked under review with their reason; records the import held (not receipts) are only counted. The summary is
 * counts only.
 */

export type CostcoLoad<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

export interface CostcoFilters {
  /** A membership's ref, or '' for every membership. */
  membership: string;
  channel: RetailApiChannel | '';
  /** The search box's text, sent trimmed once typing pauses. */
  q: string;
  /** A node of the shared item tree (v2), or '' for every category. A top level takes its subcategories. */
  category: ItemTaxonomyV2NodeId | '';
}

/** The receipt open in place of the list, and its read. */
export interface CostcoOpenReceipt {
  ref: string;
  load: CostcoLoad<RetailApiReceipt>;
}

const NO_FILTERS: CostcoFilters = { membership: '', channel: '', q: '', category: '' };
/** How long typing pauses before the search is sent. */
const SEARCH_PAUSE_MS = 300;
const SEARCH_LABEL = 'Search item, item number or amount';
const openerId = (ref: string) => `costco-open-${ref}`;
const RECEIPT_TITLE_ID = 'costco-receipt-title';

/** The list as asked: the filters as chosen (the box's text among them), the search as sent, and the page. */
export interface CostcoListState {
  filters: CostcoFilters;
  /** The box's text, trimmed, as sent once typing paused ('' for none). */
  search: string;
  offset: number;
}

/** A filter chosen, a page asked, or typing paused (the box's text is sent). */
export type CostcoListEvent = { kind: 'filters'; filters: CostcoFilters } | { kind: 'page'; offset: number } | { kind: 'paused' };

const NO_LIST: CostcoListState = { filters: NO_FILTERS, search: '', offset: 0 };

/**
 * The list's state, event by event. A membership, channel or category is asked at once, from the first page. The box's
 * text is asked only once typing pauses, and a changed search then starts from its first page too, whatever page was
 * asked in the pause.
 */
export function costcoListStep(state: CostcoListState, event: CostcoListEvent): CostcoListState {
  if (event.kind === 'page') return { ...state, offset: event.offset };
  if (event.kind === 'filters') {
    const now = event.filters.membership !== state.filters.membership || event.filters.channel !== state.filters.channel
      || event.filters.category !== state.filters.category;
    return { ...state, filters: event.filters, offset: now ? 0 : state.offset };
  }
  const search = state.filters.q.trim();
  return search === state.search ? state : { ...state, search, offset: 0 };
}

/** What the list asks: its membership, channel, category and page, and the search as sent, never the box's text. */
export function costcoListQuery(
  asked: Pick<CostcoFilters, 'membership' | 'channel' | 'category'> & Pick<CostcoListState, 'search' | 'offset'>,
): CostcoReceiptsQuery {
  return {
    membership: asked.membership || undefined,
    channel: asked.channel || undefined,
    offset: asked.offset > 0 ? asked.offset : undefined,
    q: asked.search || undefined,
    category: asked.category || undefined,
  };
}

export function CostcoReceipts() {
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<CostcoLoad<RetailApiSummary>>({ status: 'loading' });
  const [{ filters, search, offset }, step] = useReducer(costcoListStep, NO_LIST);
  // The list's read, under the filters and page it answers: another view's answer is never shown as this one's.
  const [list, setList] = useState<{ key: string; load: CostcoLoad<RetailApiReceipts> } | null>(null);
  const [open, setOpen] = useState<CostcoOpenReceipt | null>(null);
  const [receiptAttempt, setReceiptAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** The receipt just closed: focus goes back to its row. */
  const returnTo = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary({ status: 'loading' });
    fetchCostcoSummary()
      .then((value) => { if (!cancelled) setSummary({ status: 'ready', value }); })
      .catch((error: unknown) => { if (!cancelled) setSummary({ status: 'error', message: costcoErrorText(error, 'receipts') }); });
    return () => { cancelled = true; };
  }, [attempt]);

  // Typing pauses: the box's text is sent, unless it is the search already sent.
  useEffect(() => {
    if (filters.q.trim() === search) return undefined;
    const timer = setTimeout(() => step({ kind: 'paused' }), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [filters.q, search]);

  const listKey = JSON.stringify([filters.membership, filters.channel, filters.category, search, offset, attempt]);
  useEffect(() => {
    let cancelled = false;
    const key = JSON.stringify([filters.membership, filters.channel, filters.category, search, offset, attempt]);
    setList({ key, load: { status: 'loading' } });
    fetchCostcoReceipts(costcoListQuery({ membership: filters.membership, channel: filters.channel, category: filters.category, search, offset }))
      .then((value) => { if (!cancelled) setList({ key, load: { status: 'ready', value } }); })
      .catch((error: unknown) => {
        if (!cancelled) setList({ key, load: { status: 'error', message: costcoErrorText(error, 'receipts') } });
      });
    return () => { cancelled = true; };
  }, [filters.membership, filters.channel, filters.category, search, offset, attempt]);

  const openRef = open?.ref ?? null;
  useEffect(() => {
    if (openRef === null) return undefined;
    let cancelled = false;
    const settle = (load: CostcoLoad<RetailApiReceipt>) => {
      if (!cancelled) setOpen((current) => (current?.ref === openRef ? { ref: openRef, load } : current));
    };
    settle({ status: 'loading' });
    fetchCostcoReceipt(openRef)
      .then((value) => settle({ status: 'ready', value }))
      .catch((error: unknown) => settle({ status: 'error', message: costcoErrorText(error, 'receipt') }));
    return () => { cancelled = true; };
  }, [openRef, receiptAttempt]);

  // A receipt opened: focus on its heading (which brings it into view). Back: focus on its row's button.
  useLayoutEffect(() => {
    if (openRef !== null) {
      headingRef.current?.focus();
      return;
    }
    const ref = returnTo.current;
    returnTo.current = null;
    if (ref !== null) document.getElementById(openerId(ref))?.focus();
  }, [openRef]);

  const onOpen = useCallback((ref: string) => setOpen({ ref, load: { status: 'loading' } }), []);
  const onBack = useCallback(() => {
    returnTo.current = openRef;
    setOpen(null);
  }, [openRef]);
  const onFilters = useCallback((next: CostcoFilters) => step({ kind: 'filters', filters: next }), []);
  const onPage = useCallback((next: number) => step({ kind: 'page', offset: next }), []);

  return (
    <CostcoReceiptsView
      summary={summary}
      list={list !== null && list.key === listKey ? list.load : { status: 'loading' }}
      filters={filters}
      search={search}
      receipt={open}
      onFilters={onFilters}
      onPage={onPage}
      onOpen={onOpen}
      onBack={onBack}
      onRetry={() => setAttempt((value) => value + 1)}
      onRetryReceipt={() => setReceiptAttempt((value) => value + 1)}
      headingRef={headingRef}
    />
  );
}

export interface CostcoReceiptsViewProps {
  summary: CostcoLoad<RetailApiSummary>;
  /** The list under `filters`, at its page, and under `search`. */
  list: CostcoLoad<RetailApiReceipts>;
  filters: CostcoFilters;
  /** The search the list answers: the box's text, trimmed, as sent once typing paused ('' for none). */
  search?: string;
  /** The receipt shown in place of the list, if any. */
  receipt?: CostcoOpenReceipt | null;
  onFilters?: (filters: CostcoFilters) => void;
  onPage?: (offset: number) => void;
  onOpen?: (ref: string) => void;
  onBack?: () => void;
  onRetry?: () => void;
  onRetryReceipt?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

/** The page as loaded: what each read answered so far, drawn without any read of its own. */
export function CostcoReceiptsView({
  summary, list, filters, search = '', receipt = null, onFilters, onPage, onOpen, onBack, onRetry, onRetryReceipt, headingRef,
}: CostcoReceiptsViewProps) {
  const labels = membershipLabels(summary.status === 'ready' ? summary.value : null);
  const busy = receipt !== null ? receipt.load.status === 'loading' : summary.status === 'loading' || list.status === 'loading';
  return (
    <div className="costco" aria-busy={busy}>
      {/* Said in every state: loading, failed, nothing imported, the list and a receipt. */}
      <p className="costco-banner" role="note" data-testid="costco-banner">{COSTCO_BANNER}</p>
      {receipt !== null ? (
        <ReceiptPage receipt={receipt} labels={labels} onBack={onBack} onRetry={onRetryReceipt} headingRef={headingRef} />
      ) : summary.status === 'loading' ? (
        <p className="spending-muted" role="status">Loading Costco receipts…</p>
      ) : summary.status === 'error' ? (
        <Failure message={summary.message} onRetry={onRetry} />
      ) : summary.value.state === 'absent' || (list.status === 'ready' && list.value.state === 'absent') ? (
        <Absent />
      ) : (
        <>
          <SummaryPanel summary={summary.value} />
          <ReceiptList summary={summary.value} list={list} filters={filters} search={search} labels={labels} onFilters={onFilters}
            onPage={onPage} onOpen={onOpen} onRetry={onRetry} />
        </>
      )}
    </div>
  );
}

function Absent() {
  return (
    <div className="spending-empty costco-empty" role="status" data-testid="costco-absent">
      <strong>{COSTCO_ABSENT}</strong>
      <p>Receipts appear here once Holdr&apos;s retail import stores them. Card charges stay in Card transactions either way.</p>
    </div>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="spending-error costco-error" role="alert">
      <span>{message}</span>
      {onRetry ? <button type="button" className="spending-button" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

/** Counts only: receipts by channel (each once), each membership's and its latest capture, and what is under review. */
function SummaryPanel({ summary }: { summary: RetailApiSummaryPresent }) {
  const reviewed = RETAIL_API_QUARANTINE_REASONS.filter((reason) => summary.quarantine[reason] > 0);
  return (
    <section className="spending-panel costco-summary" aria-labelledby="costco-summary-title" data-testid="costco-summary">
      <header className="spending-panel-head">
        <h3 id="costco-summary-title">Costco receipts</h3>
        <span className="costco-measure">Counts only</span>
      </header>
      <dl className="costco-figures">
        {RETAIL_API_CHANNELS.map((channel) => (
          <div key={channel} className="costco-figure">
            <dt>{CHANNEL_LABELS[channel]}</dt>
            <dd>{channelCountsText(summary.receipts[channel])}</dd>
          </div>
        ))}
      </dl>
      {summary.memberships.length > 0 ? (
        <ul className="costco-memberships" aria-label="Memberships">
          {summary.memberships.map((membership) => (
            <li key={membership.membershipRef} className="costco-membership">
              <div className="costco-membership-head">
                <strong dir="auto">{membership.label}</strong>{' '}
                <span className="costco-membership-owner">{OWNER_LABELS[membership.owner]}</span>
              </div>
              <ul className="costco-membership-counts">
                {RETAIL_API_CHANNELS.map((channel) => (
                  <li key={channel}>{CHANNEL_LABELS[channel]}: {channelCountsText(membership.receipts[channel])}</li>
                ))}
              </ul>
              <p className="costco-capture">{captureText(membership.capture.capturedThrough)}</p>
              {membership.capture.ranges.length > 0 ? (
                <ul className="costco-ranges" aria-label={`What ${membership.label}'s captures cover`}>
                  {membership.capture.ranges.map((range) => (
                    <li key={`${range.channel}-${range.from}`}>{captureRangeText(range)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {reviewed.length > 0 ? (
        <div className="costco-review-counts">
          <h4>Under review</h4>
          <ul>
            {reviewed.map((reason) => (
              <li key={reason}>{plural(summary.quarantine[reason], 'receipt')}: {QUARANTINE_REASON_TEXT[reason]}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="spending-muted costco-review-none">No receipt is under review.</p>
      )}
      <p className="spending-muted costco-held" data-testid="costco-held">{heldText(summary.held)}</p>
    </section>
  );
}

function ReceiptList({ summary, list, filters, search, labels, onFilters, onPage, onOpen, onRetry }: {
  summary: RetailApiSummaryPresent;
  list: CostcoLoad<RetailApiReceipts>;
  filters: CostcoFilters;
  search: string;
  labels: ReadonlyMap<string, string>;
  onFilters?: (filters: CostcoFilters) => void;
  onPage?: (offset: number) => void;
  onOpen?: (ref: string) => void;
  onRetry?: () => void;
}) {
  const page = list.status === 'ready' && list.value.state === 'present' ? list.value : null;
  // Filtered as the shown list was asked: the search as sent, not the box's text while typing pauses.
  const filtered = filters.membership !== '' || filters.channel !== '' || filters.category !== '' || search !== '';
  return (
    <section className="costco-receipts" aria-labelledby="costco-receipts-title">
      <h3 id="costco-receipts-title" className="costco-title">Receipts</h3>
      <div className="spending-toolbar costco-toolbar">
        <label className="spending-select">
          <span>Membership</span>
          <select value={filters.membership} onChange={(event) => onFilters?.({ ...filters, membership: event.target.value })}>
            <option value="">All memberships</option>
            {summary.memberships.map((membership) => (
              <option key={membership.membershipRef} value={membership.membershipRef}>{membership.label}</option>
            ))}
          </select>
        </label>
        <label className="spending-select">
          <span>Channel</span>
          <select value={filters.channel}
            onChange={(event) => onFilters?.({ ...filters, channel: event.target.value as RetailApiChannel | '' })}>
            <option value="">All channels</option>
            {RETAIL_API_CHANNELS.map((channel) => <option key={channel} value={channel}>{CHANNEL_LABELS[channel]}</option>)}
          </select>
        </label>
        <label className="spending-select">
          <span>Category</span>
          <select value={filters.category} onChange={(event) => {
            const value = event.target.value;
            onFilters?.({ ...filters, category: ITEM_TAXONOMY_V2_VIEW.isNode(value) ? value : '' });
          }}>
            <option value="">All categories</option>
            {categoryFilterOptions().map((choice) => (choice.kind === 'node' ? (
              <option key={choice.option.node} value={choice.option.node}>{choice.option.text}</option>
            ) : (
              <optgroup key={choice.label} label={choice.label}>
                {choice.options.map((option) => <option key={option.node} value={option.node}>{option.text}</option>)}
              </optgroup>
            )))}
          </select>
        </label>
        <label className="spending-search costco-search">
          <Search size={14} />
          <input type="search" value={filters.q} maxLength={RETAIL_API_SEARCH.maxLength} placeholder={SEARCH_LABEL} aria-label={SEARCH_LABEL}
            onChange={(event) => onFilters?.({ ...filters, q: event.target.value })} />
        </label>
        {page ? <span className="spending-muted costco-count" aria-live="polite">{receiptCountText(page.total)}</span> : null}
      </div>

      {list.status === 'error' ? <Failure message={list.message} onRetry={onRetry} /> : null}
      {list.status === 'loading' ? <p className="spending-muted" role="status">Loading receipts…</p> : null}
      {page && page.total === 0 ? (
        filtered ? (
          <div className="spending-empty costco-empty" role="status">
            <strong>No receipts match these filters.</strong>
          </div>
        ) : <Absent />
      ) : null}
      {page && page.receipts.length > 0 ? (
        <ol className="costco-list" aria-label="Costco receipts">
          {page.receipts.map((row) => <ReceiptRow key={row.receiptRef} row={row} labels={labels} onOpen={onOpen} />)}
        </ol>
      ) : null}
      {page && (page.offset > 0 || page.offset + page.receipts.length < page.total) ? <Pager page={page} onPage={onPage} /> : null}
    </section>
  );
}

function Tags({ channel, sign, status, state, reason }: {
  channel: RetailApiChannel;
  sign: RetailApiSign;
  status: RetailApiOnlineStatus | null;
  state: RetailApiReceiptState;
  reason: RetailApiQuarantineReason | null;
}) {
  return (
    <div className="costco-tags">
      <span className="costco-tag" data-channel={channel}>{CHANNEL_LABELS[channel]}</span>
      {sign === 'refund' ? <span className="costco-tag" data-tone="refund">{SIGN_LABELS.refund}</span> : null}
      {status !== null ? <span className="costco-tag">{ONLINE_STATUS_LABELS[status]}</span> : null}
      {state === 'quarantined' && reason !== null ? (
        <span className="costco-review" data-testid="costco-under-review">{underReviewText(reason)}</span>
      ) : null}
    </div>
  );
}

function ReceiptRow({ row, labels, onOpen }: {
  row: RetailApiReceiptRow;
  labels: ReadonlyMap<string, string>;
  onOpen?: (ref: string) => void;
}) {
  const titleId = `costco-row-${row.receiptRef}`;
  return (
    <li className="costco-row" data-receipt={row.receiptRef} data-state={row.state} data-sign={row.sign}>
      <article aria-labelledby={titleId}>
        <header className="costco-row-head">
          <h4 id={titleId} className="costco-row-date">
            <button type="button" id={openerId(row.receiptRef)} className="costco-open"
              aria-label={`Open the ${receiptNameText(row.channel, row.sign, row.date)}`} onClick={() => onOpen?.(row.receiptRef)}>
              {costcoDate(row.date)}
            </button>
          </h4>
          <span className="costco-amount costco-row-total">
            <span className="visually-hidden">Receipt total </span>{costcoMoney(row.totalMinor)}
          </span>
        </header>
        <Tags channel={row.channel} sign={row.sign} status={row.status} state={row.state} reason={row.quarantineReason} />
        <dl className="costco-row-facts">
          <div><dt>Membership</dt><dd dir="auto">{membershipsText(row.memberships, labels)}</dd></div>
          <div><dt>Items</dt><dd>{rowItemsText(row)}</dd></div>
          <div><dt>Paid with</dt><dd>{tenderKindsText(row.tenders.kinds)}</dd></div>
          <div><dt>This receipt&apos;s tenders</dt><dd className="costco-amount">{rowSplitText(row.tenders)}</dd></div>
        </dl>
        {row.matchingLines !== null ? (
          <ul className="costco-matches" aria-label="Matching items">
            {row.matchingLines.map((line) => (
              <li key={line.lineRef} className="costco-match" data-line={line.lineRef}>
                <span dir="auto">{matchingLineText(line)}</span>
                <span className="costco-amount">{costcoMoney(line.amountMinor)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
    </li>
  );
}

function Pager({ page, onPage }: { page: RetailApiReceiptsPresent; onPage?: (offset: number) => void }) {
  const hasNext = page.offset + page.receipts.length < page.total;
  return (
    <nav className="costco-pager" aria-label="Receipt pages">
      <button type="button" className="spending-button" disabled={page.offset === 0}
        onClick={() => onPage?.(Math.max(0, page.offset - page.limit))}>
        Previous
      </button>
      <span className="spending-muted" aria-live="polite">{pageText(page.offset, page.receipts.length, page.total)}</span>
      <button type="button" className="spending-button" disabled={!hasNext} onClick={() => onPage?.(page.offset + page.limit)}>
        Next
      </button>
    </nav>
  );
}

function ReceiptPage({ receipt, labels, onBack, onRetry, headingRef }: {
  receipt: CostcoOpenReceipt;
  labels: ReadonlyMap<string, string>;
  onBack?: () => void;
  onRetry?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const { load } = receipt;
  const detail = load.status === 'ready' && load.value.state === 'present' ? load.value.receipt : null;
  return (
    <article className="costco-receipt" aria-labelledby={RECEIPT_TITLE_ID} data-testid="costco-receipt">
      <button type="button" className="spending-link costco-back" onClick={onBack}>
        <span aria-hidden="true">←</span> Back to receipts
      </button>
      <h3 id={RECEIPT_TITLE_ID} className="costco-title" ref={headingRef} tabIndex={-1}>
        {detail ? receiptNameText(detail.channel, detail.sign, detail.date, true) : 'Costco receipt'}
      </h3>
      {load.status === 'loading' ? <p className="spending-muted" role="status">Loading the receipt…</p> : null}
      {load.status === 'error' ? <Failure message={load.message} onRetry={onRetry} /> : null}
      {load.status === 'ready' && load.value.state === 'absent' ? <Absent /> : null}
      {detail ? <ReceiptDetail receipt={detail} labels={labels} /> : null}
    </article>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="spending-panel costco-section" aria-labelledby={id}>
      <header className="spending-panel-head">
        <h4 id={id}>{title}</h4>
        {note ? <span className="costco-measure">{note}</span> : null}
      </header>
      {children}
    </section>
  );
}

function ReceiptDetail({ receipt, labels }: { receipt: RetailApiReceiptDetail; labels: ReadonlyMap<string, string> }) {
  const groups = groupCostcoLines(receipt.lines);
  return (
    <>
      <div className="spending-panel costco-receipt-head">
        <Tags channel={receipt.channel} sign={receipt.sign} status={receipt.status} state={receipt.state} reason={receipt.quarantineReason} />
        <dl className="costco-facts">
          <div><dt>Date</dt><dd>{receiptWhenText(receipt.date, receipt.localTime)}</dd></div>
          <div><dt>Membership</dt><dd dir="auto">{membershipsText(receipt.memberships, labels)}</dd></div>
          <div><dt>Receipt total</dt><dd className="costco-amount">{costcoMoney(receipt.totals.totalMinor)}</dd></div>
        </dl>
      </div>

      <Section id="costco-receipt-lines" title="Lines" note="As the receipt states them, in its order">
        {groups.length === 0 ? <p className="spending-muted">No lines stated</p> : (
          <ol className="costco-lines" aria-label="Lines">
            {groups.map((group) => <LineGroup key={group.line.lineRef} group={group} />)}
          </ol>
        )}
      </Section>

      <Section id="costco-receipt-totals" title="Totals" note="As stated">
        <dl className="costco-totals">
          {totalsRows(receipt.totals).map((row) => (
            <div key={row.key} data-total={row.key}>
              <dt>{row.label}</dt>
              <dd className="costco-amount">{row.amount}</dd>
            </div>
          ))}
        </dl>
        {receipt.taxLegends.length > 0 ? (
          <div className="costco-legends">
            <h5>Tax legends</h5>
            <ul>
              {receipt.taxLegends.map((legend, index) => (
                <li key={index}>
                  <span dir="auto">{legend.legend ?? 'Legend not shown'}</span>
                  <span className="costco-amount">{costcoMoney(legend.amountMinor)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="costco-receipt-tenders" title="Paid with">
        {receipt.tenders.length === 0 ? <p className="spending-muted">No tender stated</p> : (
          <ul className="costco-tenders">
            {receipt.tenders.map((tender, index) => (
              <li key={index} className="costco-tender" data-card-spending={tender.cardSpending ? 'true' : 'false'}>
                <span className="costco-tender-name">{tenderText(tender)}</span>
                <span className="costco-amount">{costcoMoney(tender.amountMinor)}</span>
                <span className="costco-tender-note">{tender.cardSpending ? 'In Spending as a card charge' : 'Not a card charge'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function LineGroup({ group }: { group: CostcoLineGroup }) {
  return (
    <li className="costco-line-group" data-orphan={group.orphan ? 'true' : undefined}>
      <LineRow line={group.line} orphan={group.orphan} />
      {group.children.length > 0 ? (
        <ul className="costco-sublines" aria-label={`Under ${lineTitle(group.line)}`}>
          {group.children.map((child) => <li key={child.lineRef}><LineRow line={child} orphan={false} nested /></li>)}
        </ul>
      ) : null}
    </li>
  );
}

function LineRow({ line, orphan, nested = false }: { line: RetailApiLine; orphan: boolean; nested?: boolean }) {
  const kind = lineKindText(line, orphan);
  const title = shownLineTitle(line);
  const facts = [
    line.title !== null && line.itemNumber !== null ? `Item ${line.itemNumber}` : null,
    quantityText(line),
    line.fuel !== null ? fuelText(line.fuel) : null,
    line.taxFlag !== null ? `Tax ${line.taxFlag}` : null,
    line.storedValue !== null ? 'Shop Card' : null,
    line.fulfilment !== null ? FULFILMENT_LABELS[line.fulfilment] : null,
    line.shippingMinor !== null ? `Shipping ${costcoMoney(line.shippingMinor)}` : null,
  ].filter((fact): fact is string => fact !== null);
  const events = lineEventTexts(line.events);
  const chip = categoryChip(line);
  return (
    <div className="costco-line" data-kind={line.kind} data-nested={nested ? 'true' : undefined} data-line={line.lineRef}>
      <div className="costco-line-main">
        <span className="costco-line-title" dir="auto">
          {kind ? <span className="costco-line-kind">{kind}</span> : null}
          {kind && title ? ' ' : null}
          {title}
        </span>
        <span className="costco-amount costco-line-amount">{costcoMoney(line.amountMinor)}</span>
      </div>
      {line.title2 !== null ? <span className="costco-line-title2" dir="auto">{line.title2}</span> : null}
      {facts.length > 0 ? (
        <span className="costco-line-meta">{facts.map((fact) => <span key={fact}>{fact}</span>)}</span>
      ) : null}
      {/* A precious metal (its facts, the asset node or a metal hold) keeps its one tag in place of a category chip. */}
      {isMetalLine(line) ? (
        <span className="costco-metal" data-testid="costco-metal">
          <span className="costco-metal-tag">{COSTCO_METAL_TAG}</span>
          {line.metal !== null ? <>{' '}<span className="costco-metal-detail">{metalDetailText(line.metal)}</span></> : null}
        </span>
      ) : null}
      {chip !== null ? <CategoryChip chip={chip} /> : null}
      {line.metalUncertain !== null ? <p className="costco-metal-note">{metalUncertainText(line.metalUncertain)}</p> : null}
      {events.length > 0 || line.shipments.length > 0 ? (
        <ul className="costco-line-events" aria-label="Shipping">
          {events.map((text, index) => <li key={`event-${index}`}>{text}</li>)}
          {line.shipments.map((shipment) => <li key={shipment.shipmentRef}>{shipmentText(shipment)}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** A line's category from the shared item tree: Needs review muted, and an agent's unconfirmed category marked. */
function CategoryChip({ chip }: { chip: CostcoCategoryChip }) {
  return (
    <span className="costco-line-category" data-testid="costco-category">
      <span className="costco-category" data-node={chip.node} data-tone={chip.review ? 'review' : undefined}
        data-suggested={chip.suggested ? 'true' : undefined}>
        <span className="visually-hidden">Category: </span>{chip.text}
      </span>
      {chip.suggested ? <span className="costco-category-mark"><span className="visually-hidden">, </span>{COSTCO_SUGGESTED}</span> : null}
    </span>
  );
}
