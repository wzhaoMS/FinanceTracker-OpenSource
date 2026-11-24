import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CardAccount } from '@finance-tracker/shared';

import { Disclosure } from '../Disclosure';
import { TitleWithSpinner } from '../Spinner';
import { useUpdatingMark } from '../useUpdatingMark';
import { ApiError } from '../../services/api';
import {
  apiErrorMessage,
  decideCardPayment,
  fetchPaymentReconciliation,
  undoCardPaymentDecision,
  type PaymentDecisionInput,
  type PaymentReconciliationResponse,
  type ReconciledDebit,
  type ReconciledPayment,
} from './spendingApi';
import { formatRowAmount, longDate } from './spendingFormat';
import {
  ANSWER_CONSEQUENCE,
  ambiguityGroupText,
  answerLabel,
  answerText,
  checkingAccountLabel,
  checkingCoverageText,
  countText,
  debitOffsetText,
  debitReasonText,
  debitText,
  EVIDENCE_LIST_UNDO_TEXT,
  knownPayeeLabel,
  notCardPaymentsText,
  pairEvidenceText,
  paymentReasonText,
  paymentReviewCounts,
  possibleReversalsText,
  reconciliationBreakdown,
  reconciliationCardLabel,
  reconciliationHeadline,
  reconciliationStatusLines,
  reviewCountText,
  staleAnswersText,
} from './paymentReconciliation';
import './payments.css';

/** Matched pairs shown before "Show all": the newest first. */
const SHOWN_PAIRS = 20;

interface Props {
  accountById: ReadonlyMap<string, CardAccount>;
  /**
   * The page's currency. Nothing here depends on it: the panel counts payments and withdrawals in every currency, and
   * each row shows its amount in its own currency.
   */
  currency?: string;
  /** Bumped when card rows change (an import, an edit): the reconciliation is read again. */
  dataVersion: number;
  writesDisabled: boolean;
  /** Opens a card row's details. */
  onOpen: (id: string) => void;
}

/** The last answer given or undone here, kept in sight; `id` while it can be undone from this line. */
interface Saved {
  id: string | null;
  said: string;
  undone: boolean;
}

/**
 * Card payments against the checking withdrawals that paid them, from every checking account, over the whole history,
 * whatever the page's period or person. Compact until asked: its headline is the next action ("3 payments to review"),
 * counted in payments (withdrawals left over are counted apart, in withdrawals), with Review and Details folds the
 * panel owns. Review lists what needs the owner: the groups held for their word (never picked by Holdr), each counted
 * by what it holds, the pairs Holdr matched by itself from evidence inside such groups (each with why, and an Undo that
 * hands the group back), and what is left on either side with why. Details lists every posted payment's accurate state
 * (matched only when matched; paid from another account and returned by the card said as such), the checking
 * coverage, the settled pairs and the owner's answers, each with its Undo. The owner confirms a pairing, rejects one,
 * says a payment was paid from another account or a withdrawal is no card payment, and can undo any of it; the last
 * answer stays in sight with its Undo. Every answer acts on what was last read: while a read is under way, and after
 * one fails until another succeeds, nothing can be answered or undone. Payments are transfers: nothing here changes a
 * spending figure.
 */
export function PaymentReconciliationPanel(props: Props) {
  const [data, setData] = useState<PaymentReconciliationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why the last read failed, until a read succeeds. */
  const [readError, setReadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [showAllPairs, setShowAllPairs] = useState(false);
  // The panel's own compact state: both folds start closed; the count and the Review action stay in sight.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  /** Where focus goes once an answer settles: the button pressed may be gone with its row. */
  const focusNext = useRef<'saved' | 'error' | null>(null);
  // Read again: what is shown is the last read's, dimmed at once until a moment after the new answer lands.
  const updating = useUpdatingMark(reading && data !== null, { failed: readError !== null });

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    fetchPaymentReconciliation()
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setReadError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setReadError({ message: apiErrorMessage(reason), missing: reason instanceof ApiError && reason.status === 404 });
      })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [props.dataVersion, version]);

  useEffect(() => {
    if (busy || focusNext.current === null) return;
    const target = focusNext.current === 'saved' ? savedRef.current : errorRef.current;
    focusNext.current = null;
    target?.focus();
  }, [busy, saved, error]);

  const accounts = useMemo(() => new Map((data?.checking.accounts ?? []).map((account) => [account.id, account])), [data]);
  const readAgain = () => {
    setReading(true);
    setVersion((value) => value + 1);
  };
  if (!data) {
    // An API that predates the reconciliation has no route for it: nothing to show, nothing in Spending's way.
    if (!readError || readError.missing) return null;
    return (
      <section className="spending-panel spending-payments" aria-label="Card payments and checking" aria-busy={reading}>
        <PanelHead />
        <div className="spending-error" role="alert" data-testid="payments-read-error">Card payments and checking could not be read: {readError.message}</div>
        <button type="button" className="spending-button ghost payments-read-again" disabled={reading} onClick={readAgain}>Read again</button>
      </section>
    );
  }

  const installed = data.checking.installed;
  // A withdrawal names its checking account only where there is more than one (or its account is not listed).
  const accountPart = (debit: ReconciledDebit) => (data.checking.accounts.length === 1 && accounts.has(debit.checkingAccountId)
    ? '' : `${checkingAccountLabel(accounts.get(debit.checkingAccountId))} · `);
  // Every currency counts, in payments (and withdrawals apart): nothing is called settled while anything remains.
  const counts = paymentReviewCounts(data.totals);
  const returned = data.returned ?? [];
  const answers = data.decisions.answers ?? [];
  // Without checking no gap list shows: the payments the card's own rows may have taken back show on their own.
  const hinted = installed ? [] : data.unmatchedPayments.filter((item) => (item.possibleReversals ?? []).length > 0);
  const headline = reconciliationHeadline(counts, installed);
  const lines = reconciliationStatusLines(counts, installed, hinted.length);
  const breakdown = reconciliationBreakdown(counts, installed);
  const paymentsLeft = installed ? counts.ambiguous + counts.unmatched : 0;
  const withdrawalsLeft = installed ? counts.withdrawals : 0;
  // Pairs Holdr matched by itself inside a group it holds for the owner, each with why: listed under Review apart, each
  // with its Undo, the owner's "not this one", which hands the group back (#231).
  const fromEvidence = installed ? data.pairs.filter((pair) => pair.status === 'matched' && pair.evidence) : [];
  const listed = installed
    ? data.ambiguous.length + data.unmatchedPayments.length + data.unmatchedDebits.length + data.biltHousing.length + fromEvidence.length
    : hinted.length;
  const canReview = paymentsLeft + withdrawalsLeft > 0 || listed > 0;
  // Only on what was read last, and read well: never on an answer a failed or unfinished read left behind.
  const canDecide = data.decisions.installed && !props.writesDisabled && !busy && !reading && readError === null;
  const settle = async (run: () => Promise<Saved>) => {
    setBusy(true);
    setError(null);
    try {
      setSaved(await run());
      focusNext.current = 'saved';
    } catch (reason) {
      setError(apiErrorMessage(reason));
      focusNext.current = 'error';
    } finally {
      setBusy(false);
      readAgain();
    }
  };
  const post = (input: PaymentDecisionInput, said: string) =>
    settle(async () => ({ id: (await decideCardPayment(input)).id, said, undone: false }));
  const undo = (id: string, said: string) =>
    settle(async () => {
      await undoCardPaymentDecision(id);
      return { id: null, said, undone: true };
    });

  const paymentLine = (payment: ReconciledPayment) => (
    <button type="button" className="spending-payments-open" onClick={() => props.onOpen(payment.id)}>
      <span>{longDate(payment.date)} · {reconciliationCardLabel(props.accountById.get(payment.cardAccountId))}</span>
      <span className="num">{formatRowAmount(payment.amountMinor, payment.currency)}</span>
    </button>
  );
  const debitLine = (debit: ReconciledDebit, offset?: number) => (
    <span className="spending-payments-debit">
      <span>
        {/* With one checking account, its name on every line says nothing new: it is under Details. */}
        {longDate(debit.date)} · {accountPart(debit)}{debitText(debit)}
        {offset !== undefined ? `, ${debitOffsetText(offset)}` : ''}
        {debit.descriptor && debitText(debit) !== debit.descriptor ? <span className="spending-detail-suggestion-text">{debit.descriptor}</span> : null}
      </span>
      <span className="num">{formatRowAmount(debit.amountMinor, debit.currency)}</span>
    </span>
  );
  // A card row adding a payment's amount back: what it is, when against the payment, and its masked text.
  const reversalLine = (reversal: ReconciledPayment, offset: number, label: string) => (
    <span className="spending-payments-debit">
      <span>
        {longDate(reversal.date)} · {label}, {debitOffsetText(offset)}
        {reversal.description ? <span className="spending-detail-suggestion-text">{reversal.description}</span> : null}
      </span>
      <span className="num">{formatRowAmount(reversal.amountMinor, reversal.currency)}</span>
    </span>
  );
  const pairs = [...data.pairs].reverse();
  const reversalHint = (options: Array<{ reversal: ReconciledPayment; dayOffset: number }>) => (
    <>
      <p className="spending-muted" data-testid="reversal-hint">{possibleReversalsText(options.length)}</p>
      <ul className="spending-payments-options" aria-label="Rows on this card adding this amount back">
        {options.map((option) => (
          <li key={option.reversal.id}>{reversalLine(option.reversal, option.dayOffset, 'Adds this amount back')}</li>
        ))}
      </ul>
    </>
  );
  const shownPairs = showAllPairs ? pairs : pairs.slice(0, SHOWN_PAIRS);
  const left = reviewCountText(paymentsLeft, withdrawalsLeft);

  const review = installed ? (
    <>
      {left ? <p className="payments-review-count" data-testid="payments-review-count">To review: {left}</p> : null}
      <p className="payments-help" data-testid="payments-consequence">{ANSWER_CONSEQUENCE}</p>

      {data.ambiguous.length > 0 ? (
        <Block title="Which withdrawal paid it?" testId="payments-ambiguous">
          <p className="payments-help">
            Holdr does not pair these by itself: confirm the withdrawal that paid each payment, or say it was not this one.
          </p>
          {data.ambiguous.map((group) => (
            <div key={group.id} className="spending-payments-group">
              <p className="payments-help" data-testid="payments-ambiguous-why">{ambiguityGroupText(group.payments.length, group.debits.length)}</p>
              {/* Each card payment is its own part, labeled and ruled off, with the withdrawals that could pay it under it. */}
              {group.payments.map((payment) => (
                <div key={payment.id} className="spending-payments-item payments-candidates" data-testid="payments-candidates">
                  <p className="payments-part-label">Card payment</p>
                  {paymentLine(payment)}
                  <p className="payments-part-label">Possible checking withdrawals</p>
                  <ul className="spending-payments-options" aria-label={`Possible checking withdrawals for the ${longDate(payment.date)} card payment`}>
                    {group.candidates.filter((item) => item.paymentId === payment.id).map((item) => {
                      const debit = group.debits.find((entry) => entry.id === item.debitId)!;
                      return (
                        <li key={item.debitId}>
                          {debitLine(debit, item.dayOffset)}
                          <span className="spending-payments-buttons">
                            <button type="button" className="spending-button" disabled={!canDecide}
                              onClick={() => void post({ decision: 'confirmed', cardTransactionId: payment.id, checkingTransactionId: debit.id },
                                answerText('confirmed', payment, debit))}>
                              Paid by this withdrawal
                            </button>
                            <button type="button" className="spending-button ghost" disabled={!canDecide}
                              onClick={() => void post({ decision: 'rejected', cardTransactionId: payment.id, checkingTransactionId: debit.id },
                                answerText('rejected', payment, debit))}>
                              Not this one
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </Block>
      ) : null}

      {fromEvidence.length > 0 ? (
        <Block title={`Matched by Holdr from evidence: ${countText(fromEvidence.length, 'payment')}`} testId="payments-evidence">
          <p className="payments-help" data-testid="payments-evidence-lead">
            Holdr matched these by itself, from the evidence shown under each pair. {EVIDENCE_LIST_UNDO_TEXT}
          </p>
          <ul className="spending-payments-options">
            {fromEvidence.map((pair) => (
              <li key={pair.payment.id} className="spending-payments-pair">
                {paymentLine(pair.payment)}
                {debitLine(pair.debit, pair.dayOffset)}
                <span className="spending-payments-buttons">
                  <button type="button" className="spending-button ghost" disabled={!canDecide}
                    onClick={() => void post({ decision: 'rejected', cardTransactionId: pair.payment.id, checkingTransactionId: pair.debit.id },
                      answerText('rejected', pair.payment, pair.debit))}>
                    Undo
                  </button>
                </span>
                <p className="payments-help spending-payments-why" data-testid="payments-evidence-why">{pairEvidenceText(pair.evidence!)}</p>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {data.unmatchedPayments.length > 0 ? (
        <Block title="No checking withdrawal found" testId="payments-unmatched">
          {data.unmatchedPayments.map((item) => (
            <div key={item.payment.id} className="spending-payments-item">
              {paymentLine(item.payment)}
              <p className="spending-muted">{paymentReasonText(item.reason)}</p>
              {item.brokerageSuggestions ? (
                <p className="spending-muted" data-testid="brokerage-hint">
                  A brokerage withdrawal or transfer out of this amount is close by: possibly paid from brokerage cash.
                </p>
              ) : null}
              {item.possibleReversals && item.possibleReversals.length > 0 ? reversalHint(item.possibleReversals) : null}
              {item.possibleDebits.length > 0 ? (
                <>
                  <p className="payments-part-label">Withdrawals of this amount that do not read as this card&apos;s payment</p>
                  <ul className="spending-payments-options" aria-label="Withdrawals of this amount that do not read as this card's payment">
                    {item.possibleDebits.map((option) => (
                      <li key={option.debit.id}>
                        {debitLine(option.debit, option.dayOffset)}
                        <span className="spending-payments-buttons">
                          <button type="button" className="spending-button" disabled={!canDecide}
                            onClick={() => void post({ decision: 'confirmed', cardTransactionId: item.payment.id, checkingTransactionId: option.debit.id },
                              answerText('confirmed', item.payment, option.debit))}>
                            Paid by this withdrawal
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {item.reason === 'no-checking-debit' ? (
                <button type="button" className="spending-button ghost" disabled={!canDecide}
                  onClick={() => void post({ decision: 'elsewhere', cardTransactionId: item.payment.id }, answerText('elsewhere', item.payment))}>
                  Paid from another account
                </button>
              ) : null}
            </div>
          ))}
        </Block>
      ) : null}

      {data.unmatchedDebits.length > 0 ? (
        <Block title="Withdrawals with no card payment" testId="debits-unmatched">
          {data.unmatchedDebits.map((item) => (
            <div key={item.debit.id} className="spending-payments-item">
              {debitLine(item.debit)}
              <p className="spending-muted">{debitReasonText(item.reason, knownPayeeLabel(item.debit), item.debit)}</p>
              {item.possiblePayments.length > 0 ? (
                <>
                  <p className="payments-part-label">Card payments of this amount on other cards</p>
                  <ul className="spending-payments-options" aria-label="Card payments of this amount on other cards">
                    {item.possiblePayments.map((option) => (
                      <li key={option.payment.id}>
                        {paymentLine(option.payment)}
                        <span className="spending-payments-buttons">
                          <button type="button" className="spending-button" disabled={!canDecide}
                            onClick={() => void post({ decision: 'confirmed', cardTransactionId: option.payment.id, checkingTransactionId: item.debit.id },
                              answerText('confirmed', option.payment, item.debit))}>
                            Paid this payment
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <button type="button" className="spending-button ghost" disabled={!canDecide}
                onClick={() => void post({ decision: 'not-card-payment', checkingTransactionId: item.debit.id }, answerText('not-card-payment', null, item.debit))}>
                Not a card payment
              </button>
            </div>
          ))}
        </Block>
      ) : null}

      {data.biltHousing.length > 0 ? (
        <Block title="Bilt housing pulls with no housing payment" testId="debits-bilt-housing">
          <p className="payments-help">
            Rent or mortgage Bilt took from the bank to clear a housing charge on the Bilt card. Each pays only that
            card&apos;s housing payment row, never an ordinary Bilt payment.
          </p>
          {data.biltHousing.map((item) => (
            <div key={item.debit.id} className="spending-payments-item">
              {debitLine(item.debit)}
              <p className="spending-muted">{debitReasonText(item.reason, 'Bilt', item.debit)}</p>
              {item.possiblePayments.length > 0 ? (
                <>
                  <p className="payments-part-label">Bilt housing payments of this amount</p>
                  <ul className="spending-payments-options" aria-label="Bilt housing payments of this amount">
                    {item.possiblePayments.map((option) => (
                      <li key={option.payment.id}>
                        {paymentLine(option.payment)}
                        <span className="spending-payments-buttons">
                          <button type="button" className="spending-button" disabled={!canDecide}
                            onClick={() => void post({ decision: 'confirmed', cardTransactionId: option.payment.id, checkingTransactionId: item.debit.id },
                              answerText('confirmed', option.payment, item.debit))}>
                            Paid this payment
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <button type="button" className="spending-button ghost" disabled={!canDecide}
                onClick={() => void post({ decision: 'not-card-payment', checkingTransactionId: item.debit.id }, answerText('not-card-payment', null, item.debit))}>
                Not a card payment
              </button>
            </div>
          ))}
        </Block>
      ) : null}
    </>
  ) : hinted.length > 0 ? (
    // Read only: without checking nothing pairs, and the card's own row settles nothing by itself.
    <Block title="Possibly taken back by the card" testId="payments-reversal-hints">
      {hinted.map((item) => (
        <div key={item.payment.id} className="spending-payments-item">
          {paymentLine(item.payment)}
          {reversalHint(item.possibleReversals!)}
        </div>
      ))}
    </Block>
  ) : null;

  const details = (
    <>
      {breakdown ? (
        <div className="payments-breakdown" data-testid="payments-breakdown">
          <p>{breakdown.lead}</p>
          <ul>{breakdown.items.map((item) => <li key={item}>{item}</li>)}</ul>
          {counts.notCardPayments > 0 ? <p className="payments-help">{notCardPaymentsText(counts.notCardPayments)}.</p> : null}
        </div>
      ) : null}

      {installed ? (
        <Block title="Checking accounts" testId="payments-checking">
          <ul className="spending-payments-accounts" aria-label="Checking accounts">
            {data.checking.accounts.map((account) => (
              <li key={account.id}>
                <strong>{checkingAccountLabel(account)}</strong> <span className="spending-muted">{checkingCoverageText(account.coverage)}</span>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {pairs.length > 0 ? (
        <Block title={`Matched: ${countText(pairs.length, 'payment')}`} testId="payments-matched">
          <p className="payments-help">Each card payment, then the checking withdrawal that paid it.</p>
          <ul className="spending-payments-options">
            {shownPairs.map((pair) => (
              <li key={pair.payment.id} className="spending-payments-pair">
                {paymentLine(pair.payment)}
                {debitLine(pair.debit, pair.dayOffset)}
                {pair.status === 'confirmed' && pair.decisionId ? (
                  <span className="spending-payments-buttons">
                    <span className="spending-badge">Confirmed by you</span>
                    <button type="button" className="spending-button ghost" disabled={!canDecide}
                      onClick={() => void undo(pair.decisionId!, answerText('confirmed', pair.payment, pair.debit))}>
                      Undo
                    </button>
                  </span>
                ) : pair.evidence ? (
                  <span className="spending-payments-buttons"><span className="spending-badge">From evidence</span></span>
                ) : null}
              </li>
            ))}
          </ul>
          {pairs.length > SHOWN_PAIRS ? (
            <button type="button" className="spending-link inline" onClick={() => setShowAllPairs((value) => !value)}>
              {showAllPairs ? 'Show fewer' : `Show all ${pairs.length}`}
            </button>
          ) : null}
        </Block>
      ) : null}

      {/* The card's own rows say what they say whether or not checking is imported. */}
      {returned.length > 0 ? (
        <Block title={`Returned by the card: ${countText(returned.length, 'payment')}`} testId="payments-returned">
          <p className="payments-help">
            The card took these payments back: never paid, so no checking withdrawal is owed. Holdr settles one only
            where the card&apos;s row says so and nothing else fits either of them.
          </p>
          <ul className="spending-payments-options">
            {returned.map((item) => (
              <li key={item.payment.id} className="spending-payments-pair">
                {paymentLine(item.payment)}
                {reversalLine(item.reversal, item.dayOffset, 'Taken back by the card')}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {/* The owner's answers stand whether or not checking is imported: each shows with its Undo. */}
      {data.elsewhere.length > 0 ? (
        <Block title={`Paid from another account: ${countText(data.elsewhere.length, 'payment')}`} testId="payments-elsewhere">
          <ul className="spending-payments-options">
            {data.elsewhere.map((item) => (
              <li key={item.payment.id}>
                {paymentLine(item.payment)}
                <button type="button" className="spending-button ghost" disabled={!canDecide}
                  onClick={() => void undo(item.decisionId, answerText('elsewhere', item.payment))}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {data.notCardPayments.length > 0 ? (
        <Block title={`Not card payments: ${countText(data.notCardPayments.length, 'withdrawal')}`} testId="debits-not-card">
          <ul className="spending-payments-options">
            {data.notCardPayments.map((item) => (
              <li key={item.debit.id}>
                {debitLine(item.debit)}
                <button type="button" className="spending-button ghost" disabled={!canDecide}
                  onClick={() => void undo(item.decisionId, answerText('not-card-payment', null, item.debit))}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {answers.length > 0 ? (
        <Block title={`Your other answers: ${answers.length}`} testId="payments-answers">
          <p className="payments-help">
            Pairings you said did not happen, and answers that no longer fit their rows. Undo one to let the rules (or
            you) pair those rows again.
          </p>
          <ul className="spending-payments-options">
            {answers.map((answer) => (
              <li key={answer.id}>
                <span className="spending-payments-answer">
                  <strong>{answerLabel(answer.decision, answer.stale)}</strong>
                  {answer.payment ? paymentLine(answer.payment) : null}
                  {answer.debit ? debitLine(answer.debit) : null}
                </span>
                <button type="button" className="spending-button ghost" disabled={!canDecide}
                  onClick={() => void undo(answer.id, answerText(answer.decision, answer.payment, answer.debit))}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
    </>
  );

  return (
    <section className="spending-panel spending-payments" aria-label="Card payments and checking" aria-busy={busy || reading}
      data-updating={updating ? 'true' : undefined}>
      <PanelHead updating={updating} />
      <div className="payments-summary">
        <p className="payments-headline" data-testid="payments-headline">{headline}</p>
        {lines.length > 0 ? (
          <ul className="payments-lines" data-testid="payments-status">
            {lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
        {!installed ? (
          <p className="payments-note">
            Once checking history is imported, each card payment is matched with the checking withdrawal that paid it:
            same amount to the cent, within {data.rules.daysAfter} days.
          </p>
        ) : !data.decisions.installed ? (
          <p className="payments-note">Answering needs the operator install of card payment decisions; the rules&apos; matches show already.</p>
        ) : null}
        {data.decisions.stale.length > 0 ? (
          <p className="payments-note" data-testid="stale-decisions">{staleAnswersText(data.decisions.stale.length)}</p>
        ) : null}
      </div>
      {readError ? (
        <div className="spending-error" role="alert" data-testid="payments-read-error">
          Card payments and checking could not be read again: {readError.message}. What shows is from the last read and
          cannot be answered or undone until a read succeeds.{' '}
          <button type="button" className="spending-link inline" disabled={reading} onClick={readAgain}>Read again</button>
        </div>
      ) : null}
      {error ? <div ref={errorRef} tabIndex={-1} className="spending-error" role="alert" data-testid="payments-error">{error}</div> : null}
      {saved ? (
        <p ref={savedRef} tabIndex={-1} className="payments-saved" role="status" data-testid="payments-saved">
          {saved.undone ? 'Undone' : 'Saved'}: {saved.said}.
          {saved.id ? (
            <>
              {' '}
              <button type="button" className="spending-link inline" disabled={!canDecide} onClick={() => void undo(saved.id!, saved.said)}>Undo</button>
            </>
          ) : null}
        </p>
      ) : null}
      {canReview ? (
        <Disclosure className="payments-fold payments-review-fold" summary="Review" open={reviewOpen} onOpenChange={setReviewOpen}>
          <div className="payments-review" data-testid="payments-review">{review}</div>
        </Disclosure>
      ) : null}
      <Disclosure className="payments-fold payments-details-fold" summary="Details" open={detailsOpen} onOpenChange={setDetailsOpen}>
        <div className="payments-details" data-testid="payments-details">{details}</div>
      </Disclosure>
    </section>
  );
}

/** The title, and the scope: this panel reads every imported payment, whatever the page's period or person. */
function PanelHead({ updating = false }: { updating?: boolean }) {
  return (
    <header className="spending-panel-head payments-head">
      <TitleWithSpinner busy={updating} testId="payments-updating"><h3>Card payments and checking</h3></TitleWithSpinner>
      <p className="payments-scope" data-testid="payments-scope">All imported card payments, any date or person</p>
    </header>
  );
}

/** One part of a fold, under its own heading: never a fold inside a fold. */
function Block(props: { title: string; testId: string; children: ReactNode }) {
  return (
    <div className="payments-block" data-testid={props.testId}>
      <h4>{props.title}</h4>
      {props.children}
    </div>
  );
}
