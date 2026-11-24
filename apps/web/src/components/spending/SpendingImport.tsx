import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { cardSpendingRole, type CardAccount, type CardOwner, type CardTransactionKind } from '@finance-tracker/shared';

import { X } from '../icons';
import {
  apiErrorMessage,
  commitCardImport,
  createCardAccount,
  isImportPreviewOutdated,
  previewCardImport,
  type CardImportCommitResponse,
  type CardImportKindTotal,
  type CardImportPreviewResponse,
  type CardImportStoredRow,
  type CardImportTotalsSummary,
} from './spendingApi';
import {
  OWNERS,
  OWNER_LABELS,
  cardOptionLabel,
  dateRangeLabel,
  formatMinor,
  formatRowAmount,
  importResultText,
  importReviewCounts,
  importReviewText,
  issuerLabel,
  longDate,
} from './spendingFormat';
import { readChosenFile } from './spendingImportFile';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const NEW_ACCOUNT = '__new__';

/** What the dialog reads from a chosen file before sending it: only the payload's envelope. */
interface PayloadEnvelope {
  issuer: string;
  currency: string;
  owner: CardOwner | null;
  cards: string[];
  coverage: { start: string; end: string } | null;
  rowCount: number;
}

function readEnvelope(text: string): PayloadEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.format !== 'holdr.card-import' || payload.version !== 1) return null;
  if (typeof payload.issuer !== 'string' || typeof payload.currency !== 'string' || !Array.isArray(payload.rows)) return null;
  const coverage = payload.coverage as { start?: unknown; end?: unknown } | null | undefined;
  return {
    issuer: payload.issuer,
    currency: payload.currency,
    owner: payload.owner === 'alex' || payload.owner === 'casey' || payload.owner === 'joint' ? payload.owner : null,
    cards: Array.isArray(payload.cards) ? payload.cards.filter((card): card is string => typeof card === 'string' && /^\d{4}$/.test(card)) : [],
    coverage: coverage && typeof coverage.start === 'string' && typeof coverage.end === 'string'
      ? { start: coverage.start, end: coverage.end }
      : null,
    rowCount: payload.rows.length,
  };
}

interface Props {
  accounts: CardAccount[];
  onClose: () => void;
  onImported: () => void;
  /** Takes the owner to the card sync review (Sync & coverage) once an import left rows there. */
  onReview?: () => void;
  /** A card account was created here (before any import): every card's label is drawn again with it. */
  onAccountCreated?: (account: CardAccount) => void;
}

/** A file's rows of one status, as the Spending tab counts them: spending (refunds offset it), payments apart. */
function figuresOf(summary: CardImportTotalsSummary) {
  let spending = 0;
  let refunds = 0;
  let payments = 0;
  let other = 0;
  for (const [kind, total] of Object.entries(summary.byKind ?? {}) as Array<[CardTransactionKind, CardImportKindTotal | undefined]>) {
    if (!total || total.count === 0) continue;
    const role = cardSpendingRole(kind);
    if (role === 'transfer') payments += total.amountMinor;
    else if (role === 'excluded') other += total.amountMinor;
    else if (kind === 'refund') refunds += total.amountMinor;
    else spending += total.amountMinor;
  }
  return { spending, refunds, net: spending + refunds, payments, other };
}

const countRows = (count: number) => `${count} ${count === 1 ? 'row' : 'rows'}`;

/** One status's figures: purchases (or charges), refunds, their net, then payments and other rows apart. */
function FigureParts({ figures, purchases, money, notes }: {
  figures: ReturnType<typeof figuresOf>;
  purchases: string;
  money: (amountMinor: number) => string;
  /** Say that payments and other rows are not spending (the pending line says so of all its rows). */
  notes: boolean;
}) {
  return (
    <>
      {purchases} <span className="num">{money(figures.spending)}</span>
      {figures.refunds !== 0 ? <>, refunds <span className="num">{money(figures.refunds)}</span></> : null}
      , net <span className="num">{money(figures.net)}</span>
      {figures.payments !== 0 ? <>; payments <span className="num">{money(figures.payments)}</span>{notes ? ' (not spending)' : null}</> : null}
      {figures.other !== 0 ? <>; other <span className="num">{money(figures.other)}</span>{notes ? ' (not counted)' : null}</> : null}
    </>
  );
}

/** What the file holds, posted and pending apart: pending is never spending. */
function ImportFigures({ preview, currency }: { preview: CardImportPreviewResponse; currency: string }) {
  const posted = figuresOf(preview.totals.posted);
  const pending = figuresOf(preview.totals.pending);
  const newPosted = figuresOf(preview.newTotals.posted);
  const money = (amountMinor: number) => formatRowAmount(amountMinor, currency);
  return (
    <div className="spending-import-split" aria-label="What the file holds">
      <p>
        <strong>Posted</strong> · {countRows(preview.totals.posted.count)}: <FigureParts figures={posted} purchases="spending" money={money} notes />
      </p>
      <p>
        <strong>Pending</strong> · {countRows(preview.totals.pending.count)}
        {preview.totals.pending.count > 0 ? <>: <FigureParts figures={pending} purchases="charges" money={money} notes={false} /></> : null}. Pending
        is not spending: it is shown on its own until it posts.
      </p>
      <p>
        New in this import: {countRows(preview.newTotals.posted.count)} posted (spending{' '}
        <span className="num">{money(newPosted.net)}</span>) and {countRows(preview.newTotals.pending.count)} pending
        {preview.pendingPostedCount > 0
          ? <>; {preview.pendingPostedCount} stored pending {preview.pendingPostedCount === 1 ? 'charge posts' : 'charges post'} (from pending into spending)</>
          : null}
        .
      </p>
    </div>
  );
}

function storedRowLine(row: CardImportStoredRow): string {
  return `${longDate(row.transactionDate)} · ${row.description} · ${formatRowAmount(row.amountMinor, row.currency)}`;
}

/**
 * Import the redacted `holdr.card-import` JSON that the offline tool (or
 * another producer) writes. Raw issuer exports are refused here and by the
 * API: only the JSON is read, and the API re-checks every field.
 */
export function SpendingImport({ accounts, onClose, onImported, onReview, onAccountCreated }: Props) {
  const [json, setJson] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<PayloadEnvelope | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [owner, setOwner] = useState<CardOwner>('alex');
  const [ending, setEnding] = useState('');
  const [nickname, setNickname] = useState('');
  const [preview, setPreview] = useState<CardImportPreviewResponse | null>(null);
  const [possibleDuplicates, setPossibleDuplicates] = useState<'skip' | 'import'>('skip');
  // No default: only the owner can tell whether a reference-less posted row is a pending charge that went through,
  // a purchase already stored, or another purchase. `split` posts the matches without a posted twin and skips the others.
  const [pendingMatches, setPendingMatches] = useState<'post' | 'skip' | 'split' | 'import' | null>(null);
  // "Another purchase" adds a row: the owner confirms it separately.
  const [newPurchaseChecked, setNewPurchaseChecked] = useState(false);
  // "Keep them dismissed" until the owner says otherwise: a pending charge matched to its posted row with "This is its
  // posted row" was dismissed (#22), so counting its own reference's posted row would add that purchase a second time.
  const [dismissedMatches, setDismissedMatches] = useState<'post' | 'keep'>('keep');
  // Pending rows an import without pending rows leaves out stay pending unless the owner dismisses them,
  // and only after saying the file is the complete, closed statement.
  const [stalePending, setStalePending] = useState<'keep' | 'dismiss'>('keep');
  const [statementComplete, setStatementComplete] = useState(false);
  const [acceptMismatch, setAcceptMismatch] = useState(false);
  const [result, setResult] = useState<CardImportCommitResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the preview shown is a new one: the import its predecessor showed was refused, and nothing was written. */
  const [notice, setNotice] = useState<string | null>(null);
  const [createdAccount, setCreatedAccount] = useState<CardAccount | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const titleId = useId();
  const hintsId = useId();
  const endingHelpId = useId();
  const matchesHelpId = useId();
  const dismissedHelpId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  const matching = useMemo(
    () => (envelope ? [...accounts, ...(createdAccount ? [createdAccount] : [])]
      .filter((account) => account.issuer === envelope.issuer && account.currency === envelope.currency) : []),
    [accounts, createdAccount, envelope],
  );

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setJson(null);
    setEnvelope(null);
    setPreview(null);
    setResult(null);
    setError(null);
    setNotice(null);
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError('The file is larger than 10 MB; split the export.');
      return;
    }
    const chosen = await readChosenFile(file);
    if ('error' in chosen) {
      // A file chosen meanwhile has replaced this one, and has its own read.
      if (event.target.files?.[0] !== file) return;
      setFileError(chosen.error);
      // Clear the choice: the browser fires no change when the same file is chosen again, so it would not be read again.
      event.target.value = '';
      return;
    }
    const { text } = chosen;
    const read = readEnvelope(text);
    if (!read) {
      setFileError('This is not a redacted Holdr card import (holdr.card-import version 1). Run the offline redaction tool on the export first; raw exports are never imported.');
      return;
    }
    setJson(text);
    setEnvelope(read);
    setOwner(read.owner ?? 'alex');
    setEnding(read.cards.length === 1 ? read.cards[0] : '');
    const candidates = accounts.filter((account) => account.issuer === read.issuer && account.currency === read.currency);
    const hits = candidates.filter((account) => account.last4 && read.cards.includes(account.last4));
    // Pick a card only when there is no doubt: two cards can share their last four digits.
    setTarget(candidates.length === 0 ? NEW_ACCOUNT
      : hits.length === 1 ? hits[0].id
        : candidates.length === 1 && read.cards.length === 0 ? candidates[0].id
          : '');
  };

  /** Every question a preview asks starts unanswered, or at its safe default, each time a preview is shown. */
  const resetDecisions = () => {
    setPossibleDuplicates('skip');
    setPendingMatches(null);
    setNewPurchaseChecked(false);
    setDismissedMatches('keep');
    setStalePending('keep');
    setStatementComplete(false);
    setAcceptMismatch(false);
  };

  const runPreview = async () => {
    if (!json || !envelope) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    resetDecisions();
    try {
      let accountId = target;
      if (target === NEW_ACCOUNT) {
        if (ending && !/^\d{4,5}$/.test(ending)) {
          setError('The card ending is the last 4 digits, or the 5 that American Express shows.');
          return;
        }
        const created = await createCardAccount({
          issuer: envelope.issuer,
          owner,
          currency: envelope.currency,
          last4: ending.length === 4 ? ending : undefined,
          last5: ending.length === 5 ? ending : undefined,
          nickname: nickname.trim() || undefined,
        });
        setCreatedAccount(created);
        onAccountCreated?.(created);
        setTarget(created.id);
        accountId = created.id;
      }
      setPreview(await previewCardImport(accountId, json));
    } catch (reason) {
      setError(apiErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const runCommit = async () => {
    if (!json || !preview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const committed = await commitCardImport(preview.cardAccountId, json, {
        possibleDuplicates: preview.possibleDuplicateCount > 0 ? possibleDuplicates : undefined,
        pendingMatches: preview.pendingMatchCount > 0 ? pendingMatches ?? undefined : undefined,
        dismissedMatches: preview.dismissedMatchCount > 0 ? dismissedMatches : undefined,
        stalePending: (preview.stalePendingCount ?? 0) > 0 && stalePending === 'dismiss' ? 'dismiss' : undefined,
        acceptMismatch: preview.reconciliation.status === 'mismatch' ? acceptMismatch : undefined,
        // What the owner saw is what is imported: any change since this preview refuses the commit (409).
        previewDigest: preview.previewDigest,
      });
      setResult(committed);
      onImported();
    } catch (reason) {
      if (!isImportPreviewOutdated(reason)) {
        setError(apiErrorMessage(reason));
        return;
      }
      // Nothing was written. The owner decides again on a new preview; it is never imported without them.
      setPreview(null);
      resetDecisions();
      try {
        setPreview(await previewCardImport(preview.cardAccountId, json));
        setNotice('Card spending changed since that preview (another import, a sync or an edit), so nothing was imported. '
          + 'This is a new preview: check it, answer its questions again, then import.');
      } catch (again) {
        setError(apiErrorMessage(again));
      }
    } finally {
      setBusy(false);
    }
  };

  const mismatchBlocked = preview?.reconciliation.status === 'mismatch' && !acceptMismatch;
  const undecided = Boolean(preview && (
    (preview.pendingMatchCount > 0 && pendingMatches === null)
    || (preview.pendingMatchCount > 0 && pendingMatches === 'import' && !newPurchaseChecked)
    || ((preview.stalePendingCount ?? 0) > 0 && stalePending === 'dismiss' && !statementComplete)));
  const currency = envelope?.currency ?? 'USD';
  const matchDetails = preview?.pendingMatchDetails ?? [];
  const matchCount = preview?.pendingMatchCount ?? 0;
  const twinned = preview?.pendingMatchesWithPostedTwinCount ?? 0;
  const staleRows = preview?.stalePendingRows ?? [];
  const staleCount = preview?.stalePendingCount ?? 0;
  const { held: previewHeld, differing: previewDiffering } = importReviewCounts(preview ?? {});
  const resultReview = result ? importReviewText(result) : null;
  const one = (count: number, singular: string, plural: string) => (count === 1 ? singular : plural);
  return (
    <div className="spending-detail-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div
        ref={dialogRef}
        className="spending-detail spending-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="spending-detail-head">
          <h3 id={titleId}>Import card spending</h3>
          <button type="button" className="spending-icon-button" aria-label="Close import" disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="spending-muted">
          Choose the redacted JSON from Holdr&apos;s offline tool. Raw issuer files (CSV, OFX, QFX) are never imported here.
        </p>
        <label className="spending-file">
          <span>Redacted JSON</span>
          <input type="file" accept=".json,application/json" disabled={busy || result !== null} onChange={(event) => { void onFile(event); }} />
        </label>
        {fileError ? <div className="spending-error" role="alert">{fileError}</div> : null}

        {envelope && !result ? (
          <>
            <dl className="spending-detail-fields">
              <dt>Issuer</dt>
              <dd>{issuerLabel(envelope.issuer)} · {envelope.currency}</dd>
              <dt>Rows</dt>
              <dd>{envelope.rowCount}</dd>
              {envelope.coverage ? (<><dt>Covers</dt><dd>{dateRangeLabel(envelope.coverage.start, envelope.coverage.end)}</dd></>) : null}
              {envelope.cards.length > 0 ? (<><dt>Cards seen</dt><dd>{envelope.cards.map((card) => `··${card}`).join(', ')}</dd></>) : null}
            </dl>
            <label className="spending-select block">
              <span>Card account</span>
              <select value={target} disabled={busy || preview !== null} onChange={(event) => setTarget(event.target.value)}>
                {target === '' ? <option value="" disabled>Choose the card…</option> : null}
                {matching.map((account) => <option key={account.id} value={account.id}>{cardOptionLabel(account)}</option>)}
                <option value={NEW_ACCOUNT}>New card account…</option>
              </select>
            </label>
            {target === NEW_ACCOUNT ? (
              <div className="spending-new-account">
                <label className="spending-select">
                  <span>Whose card</span>
                  <select value={owner} disabled={busy} onChange={(event) => setOwner(event.target.value as CardOwner)}>
                    {OWNERS.map((item) => <option key={item} value={item}>{OWNER_LABELS[item]}</option>)}
                  </select>
                </label>
                <label className="spending-select">
                  <span>Card ending</span>
                  <input
                    value={ending}
                    inputMode="numeric"
                    maxLength={5}
                    placeholder="4 digits, or the 5 Amex shows"
                    disabled={busy}
                    list={hintsId}
                    aria-describedby={endingHelpId}
                    onChange={(event) => setEnding(event.target.value.replace(/\D/g, '').slice(0, 5))}
                  />
                  <datalist id={hintsId}>
                    {envelope.cards.map((card) => <option key={card} value={card} />)}
                  </datalist>
                </label>
                <span id={endingHelpId} className="spending-muted">
                  Only the trailing digits the issuer shows; never the card number.
                </span>
                <label className="spending-select">
                  <span>Nickname</span>
                  <input value={nickname} maxLength={80} disabled={busy} placeholder="e.g. Gold card" onChange={(event) => setNickname(event.target.value)} />
                </label>
              </div>
            ) : null}
            {!preview ? (
              <button type="button" className="spending-button primary" disabled={busy || target === ''} onClick={() => { void runPreview(); }}>
                {busy ? 'Checking…' : 'Preview'}
              </button>
            ) : null}
          </>
        ) : null}

        {error ? <div className="spending-error" role="alert">{error}</div> : null}

        {preview && !result ? (
          <div className="spending-import-preview" aria-label="Import preview">
            {notice ? <p className="spending-import-notice" role="status">{notice}</p> : null}
            <ul className="spending-import-facts">
              <li><strong className="num">{preview.newCount}</strong> new</li>
              <li><strong className="num">{preview.duplicateCount}</strong> already stored</li>
              {preview.pendingPostedCount > 0 ? <li><strong className="num">{preview.pendingPostedCount}</strong> pending → posted</li> : null}
              {previewHeld > 0 ? <li><strong className="num">{previewHeld}</strong> held for review, not imported</li> : null}
              {previewDiffering > 0 ? (
                <li><strong className="num">{previewDiffering}</strong> stored {one(previewDiffering, 'row differs', 'rows differ')} from the file: kept, and left for review</li>
              ) : null}
              <li>Posted charges <strong className="num">{formatMinor(preview.newTotals.posted.chargesMinor, currency)}</strong></li>
              <li>
                Statement check{' '}
                <strong className={`spending-check ${preview.reconciliation.status}`}>
                  {preview.reconciliation.status === 'match' ? 'matches' : preview.reconciliation.status === 'mismatch' ? 'does not match' : 'not given'}
                </strong>
              </li>
            </ul>
            <ImportFigures preview={preview} currency={currency} />
            {preview.warnings.length > 0 ? (
              <ul className="spending-warnings">
                {preview.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}
              </ul>
            ) : null}
            {preview.possibleDuplicateCount > 0 ? (
              <fieldset className="spending-choice">
                <legend>{preview.possibleDuplicateCount} new rows look like rows already stored</legend>
                <label><input type="radio" name="possible" checked={possibleDuplicates === 'skip'} onChange={() => setPossibleDuplicates('skip')} /> Skip them (usual)</label>
                <label><input type="radio" name="possible" checked={possibleDuplicates === 'import'} onChange={() => setPossibleDuplicates('import')} /> Import them too</label>
              </fieldset>
            ) : null}
            {matchCount > 0 ? (
              <fieldset className="spending-choice" aria-describedby={matchesHelpId}>
                <legend>
                  {matchCount} posted {one(matchCount, 'row has', 'rows have')} no issuer reference and the same date, amount and
                  description as a stored pending charge, or one you dismissed. That alone does not prove {one(matchCount, 'it is', 'they are')} that charge.
                </legend>
                <ul className="spending-match-list">
                  {matchDetails.map((match) => (
                    <li key={match.row}>
                      <span>
                        {match.pending.dismissed ? 'Dismissed pending charge' : 'Pending charge'}: {storedRowLine(match.pending)}
                      </span>
                      <span className="spending-muted">
                        {match.postedTwinCount > 0
                          ? `Already stored as posted with the same date, amount and description: ${match.postedTwins
                            .map((twin) => `${longDate(twin.transactionDate)}${twin.postedDate ? `, posted ${longDate(twin.postedDate)}` : ''}`)
                            .join('; ')}${match.postedTwinCount > match.postedTwins.length ? ` and ${match.postedTwinCount - match.postedTwins.length} more` : ''}`
                          : (match.postedTwinsInFileCount ?? 0) > 0
                            ? 'A posted row like it is stored, and another row of this file is that one, so this row does not repeat it.'
                            : 'No posted row like it is stored.'}
                      </span>
                    </li>
                  ))}
                  {matchCount > matchDetails.length ? <li className="spending-muted">and {matchCount - matchDetails.length} more</li> : null}
                </ul>
                <p id={matchesHelpId} className="spending-muted">
                  {twinned > 0 && twinned < matchCount
                    ? `${twinned} of ${one(twinned, 'them has', 'them have')} a posted row like ${one(twinned, 'it', 'them')} stored, most likely that purchase again; `
                      + `${matchCount - twinned} ${one(matchCount - twinned, 'has', 'have')} none, most likely the pending charge, now posted. `
                      + 'One choice covers them all, so posting the ones without and skipping the others is usually right.'
                    : twinned > 0
                      ? 'A posted row like it is already stored: the file most likely shows that purchase again, so skipping is usually right.'
                      : matchDetails.some((match) => (match.postedTwinsInFileCount ?? 0) > 0)
                        ? 'The posted rows like it that are stored are other rows of this file: it is most likely the pending charge, now posted.'
                        : 'No posted row like it is stored: it is most likely the pending charge, now posted.'}
                </p>
                {twinned > 0 && twinned < matchCount ? (
                  <label>
                    <input type="radio" name="pending-matches" checked={pendingMatches === 'split'} onChange={() => setPendingMatches('split')} />
                    {' '}Post the {matchCount - twinned} with no posted row like {one(matchCount - twinned, 'it', 'them')} stored, and skip
                    the {twinned} with one ({one(twinned, 'its pending charge stays as it is', 'their pending charges stay as they are')})
                  </label>
                ) : null}
                <label>
                  <input type="radio" name="pending-matches" checked={pendingMatches === 'post'} onChange={() => setPendingMatches('post')} />
                  {' '}{one(matchCount, 'It is the pending charge, now posted: the pending row turns posted (no new row)',
                    'They are the pending charges, now posted: the pending rows turn posted (no new rows)')}
                </label>
                <label>
                  <input type="radio" name="pending-matches" checked={pendingMatches === 'skip'} onChange={() => setPendingMatches('skip')} />
                  {' '}{one(matchCount, 'Skip this row: the pending charge stays as it is', 'Skip these rows: the pending charges stay as they are')}
                </label>
                {twinned === 0 ? (
                  <label>
                    <input
                      type="radio"
                      name="pending-matches"
                      checked={pendingMatches === 'import'}
                      onChange={() => { setPendingMatches('import'); setNewPurchaseChecked(false); }}
                    />
                    {' '}{one(matchCount, 'It is a different, new purchase: add it, and leave the pending charge as it is',
                      'They are different, new purchases: add them, and leave the pending charges as they are')}
                  </label>
                ) : null}
                {pendingMatches === 'import' && twinned === 0 ? (
                  <label className="spending-toggle">
                    <input type="checkbox" checked={newPurchaseChecked} onChange={(event) => setNewPurchaseChecked(event.target.checked)} />
                    <span>I checked: {one(matchCount, 'it is', 'they are')} neither the pending {one(matchCount, 'charge', 'charges')} nor a purchase already stored</span>
                  </label>
                ) : null}
              </fieldset>
            ) : null}
            {preview.dismissedMatchCount > 0 ? (
              <fieldset className="spending-choice" aria-describedby={dismissedHelpId}>
                <legend>
                  {preview.dismissedMatchCount} posted {preview.dismissedMatchCount === 1 ? 'row has' : 'rows have'} the issuer reference
                  of a pending charge you dismissed
                </legend>
                <p id={dismissedHelpId} className="spending-muted">
                  If you matched {one(preview.dismissedMatchCount, 'that charge', 'those charges')} to {one(preview.dismissedMatchCount, 'its', 'their')} posted
                  {one(preview.dismissedMatchCount, ' row', ' rows')} (&quot;This is its posted row&quot; in its details), {one(preview.dismissedMatchCount, 'it is', 'they are')} already
                  counted there: keep {one(preview.dismissedMatchCount, 'it', 'them')} dismissed, or {one(preview.dismissedMatchCount, 'that purchase', 'those purchases')} would
                  count twice. Count {one(preview.dismissedMatchCount, 'it', 'them')} only for a charge you dismissed that did post after all.
                </p>
                <label>
                  <input type="radio" name="dismissed-matches" checked={dismissedMatches === 'keep'} onChange={() => setDismissedMatches('keep')} />
                  {' '}Keep them dismissed
                </label>
                <label>
                  <input type="radio" name="dismissed-matches" checked={dismissedMatches === 'post'} onChange={() => setDismissedMatches('post')} />
                  {' '}They did post after all: count them
                </label>
              </fieldset>
            ) : null}
            {staleCount > 0 ? (
              <fieldset className="spending-choice">
                <legend>
                  {staleCount} pending {one(staleCount, 'charge is', 'charges are')} dated in this file&apos;s period, a week or more
                  before it ends, and not in it
                </legend>
                <ul className="spending-match-list">
                  {staleRows.map((row) => <li key={row.id}>{storedRowLine(row)}</li>)}
                  {staleCount > staleRows.length ? <li className="spending-muted">and {staleCount - staleRows.length} more</li> : null}
                </ul>
                <p className="spending-muted">
                  Missing is not proof of cancelled. A file without pending rows need not be a closed statement: some downloads
                  (Amex&apos;s, for one) hold posted rows only, even for the open cycle. And even a complete, closed statement
                  leaves out a charge that posted under another reference, or a hold that settles after it closes, as hotel,
                  car rental and fuel holds often do. Keep any you are not sure of: pending charges are not counted either way,
                  and you can dismiss a single one from its details. Nothing is dismissed unless you say so.
                </p>
                <label>
                  <input type="radio" name="stale-pending" checked={stalePending === 'keep'} onChange={() => setStalePending('keep')} />
                  {' '}{one(staleCount, 'Keep it pending (not counted either way)', 'Keep them pending (not counted either way)')}
                </label>
                <label>
                  <input type="radio" name="stale-pending" checked={stalePending === 'dismiss'} onChange={() => setStalePending('dismiss')} />
                  {' '}{one(staleCount, 'Dismiss it: I know it will not post as it is', 'Dismiss them: I know none of them will post as it is')}
                </label>
                {stalePending === 'dismiss' ? (
                  <label className="spending-toggle">
                    <input type="checkbox" checked={statementComplete} onChange={(event) => setStatementComplete(event.target.checked)} />
                    <span>This file is the complete, closed statement for {dateRangeLabel(preview.coverage.start, preview.coverage.end)}</span>
                  </label>
                ) : null}
              </fieldset>
            ) : null}
            {preview.reconciliation.status === 'mismatch' ? (
              <label className="spending-toggle">
                <input type="checkbox" checked={acceptMismatch} onChange={(event) => setAcceptMismatch(event.target.checked)} />
                <span>Import even though the statement figures do not match</span>
              </label>
            ) : null}
            <button type="button" className="spending-button primary" disabled={busy || mismatchBlocked || undecided} onClick={() => { void runCommit(); }}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        ) : null}

        {result ? (
          <div className="spending-import-result" role="status">
            <p>{importResultText(result)}</p>
            {resultReview ? <p>{resultReview}</p> : null}
            <div className="spending-import-actions">
              {resultReview && onReview ? (
                <button type="button" className="spending-button primary" onClick={onReview}>Review in Sync &amp; coverage</button>
              ) : null}
              <button type="button" className={`spending-button${resultReview && onReview ? '' : ' primary'}`} onClick={onClose}>Done</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
