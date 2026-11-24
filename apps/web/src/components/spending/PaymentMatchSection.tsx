import {
  decideCardPayment,
  undoCardPaymentDecision,
  type PaymentDecisionInput,
  type PaymentMatchView,
  type ReconciledDebitOption,
  type ReconciledReversal,
} from './spendingApi';
import { dayOffsetLabel, formatRowAmount, longDate } from './spendingFormat';
import {
  ANSWER_CONSEQUENCE,
  debitText,
  EVIDENCE_UNDO_TEXT,
  pairEvidenceText,
  paymentAmbiguityText,
  paymentReasonText,
  possibleReversalsText,
  returnedPaymentText,
} from './paymentReconciliation';
import './payments.css';

/**
 * In a card payment's details: where it stands against the checking withdrawals (card payment reconciliation).
 * Matched or confirmed: the withdrawal that paid it; matched by Holdr from evidence inside a group it holds for the
 * owner: why, with an Undo that hands the group back. Ambiguous: the withdrawals that fit, for the owner to say which
 * (Holdr never picks). Unmatched: why, the withdrawals of its amount the rules could not tie to it (and the card's own
 * rows adding its amount back), and "paid from another account". Returned: the card's row taking it back; no
 * withdrawal is owed. Every answer can be undone, said beside the buttons that give one. Payments are transfers:
 * nothing here changes spending.
 */
export function PaymentMatchSection(props: {
  paymentId: string;
  match: PaymentMatchView;
  disabled: boolean;
  /** Runs a decision, then reads the details again; errors show in the drawer. */
  onDecide: (run: () => Promise<unknown>) => void;
}) {
  const { match, paymentId } = props;
  const post = (input: PaymentDecisionInput) => props.onDecide(() => decideCardPayment(input));
  const undo = (id: string) => props.onDecide(() => undoCardPaymentDecision(id));
  const line = (debit: ReconciledDebitOption) => (
    <span>
      {longDate(debit.date)} · {debit.accountLabel} · {debitText(debit)}, {dayOffsetLabel(debit.dayOffset)}
      {debit.descriptor ? <span className="spending-detail-suggestion-text">{debit.descriptor}</span> : null}
    </span>
  );
  const options = (debits: ReconciledDebitOption[], reject: boolean) => (
    <ul>
      {debits.map((debit) => (
        <li key={debit.id}>
          {line(debit)}
          <span className="num">{formatRowAmount(debit.amountMinor, debit.currency)}</span>
          <button type="button" className="spending-button" disabled={props.disabled}
            onClick={() => post({ decision: 'confirmed', cardTransactionId: paymentId, checkingTransactionId: debit.id })}>
            Paid by this withdrawal
          </button>
          {reject ? (
            <button type="button" className="spending-button ghost" disabled={props.disabled}
              onClick={() => post({ decision: 'rejected', cardTransactionId: paymentId, checkingTransactionId: debit.id })}>
              Not this one
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
  // How many withdrawals fit, said as counted: one alone asks for a confirmation.
  const ask = match.status === 'ambiguous' ? paymentAmbiguityText(match.candidates.length, match.otherPayments) : null;
  const consequence = <p className="payment-match-consequence" data-testid="payment-consequence">{ANSWER_CONSEQUENCE}</p>;
  const reversal = (row: ReconciledReversal) => (
    <li key={row.id}>
      <span>
        {longDate(row.date)}, {dayOffsetLabel(row.dayOffset)}
        {row.description ? <span className="spending-detail-suggestion-text">{row.description}</span> : null}
      </span>
      <span className="num">{formatRowAmount(row.amountMinor, row.currency)}</span>
    </li>
  );

  return (
    <section className="spending-detail-suggestions paid-from payment-match" aria-label="Paid from checking" data-status={match.status}>
      {match.status === 'matched' || match.status === 'confirmed' ? (
        <>
          <p>
            <strong>Paid from checking</strong>
            {match.status === 'confirmed' ? ' (you confirmed it)' : match.evidence ? ' (matched by Holdr from evidence)' : ' (same amount, one withdrawal fits)'}.
            A transfer, not spending.
          </p>
          {match.status === 'matched' && match.evidence ? (
            <p className="payments-help" data-testid="payment-evidence-why">{pairEvidenceText(match.evidence)} {EVIDENCE_UNDO_TEXT}</p>
          ) : null}
          <ul>
            <li>
              {line(match.debit)}
              <span className="num">{formatRowAmount(match.debit.amountMinor, match.debit.currency)}</span>
              {match.status === 'confirmed' && match.decisionId ? (
                <button type="button" className="spending-button ghost" disabled={props.disabled} onClick={() => undo(match.decisionId!)}>Undo</button>
              ) : match.evidence ? (
                <button type="button" className="spending-button ghost" disabled={props.disabled}
                  onClick={() => post({ decision: 'rejected', cardTransactionId: paymentId, checkingTransactionId: match.debit.id })}>
                  Undo
                </button>
              ) : null}
            </li>
          </ul>
        </>
      ) : match.status === 'ambiguous' ? (
        <>
          <p data-testid="payment-ambiguous-why">
            <strong>{ask!.heading}</strong> {ask!.text}
          </p>
          {options(match.candidates, true)}
          {consequence}
        </>
      ) : match.status === 'unmatched' ? (
        <>
          <p><strong>No checking withdrawal matched.</strong> {paymentReasonText(match.reason)}</p>
          {match.possibleDebits.length > 0 ? (
            <>
              <p>Withdrawals of this amount that do not read as this card&apos;s payment:</p>
              {options(match.possibleDebits, false)}
            </>
          ) : null}
          {match.possibleReversals && match.possibleReversals.length > 0 ? (
            <>
              <p data-testid="payment-reversal-hint">{possibleReversalsText(match.possibleReversals.length)}</p>
              <ul>{match.possibleReversals.map(reversal)}</ul>
            </>
          ) : null}
          {match.reason === 'no-checking-debit' ? (
            <button type="button" className="spending-button ghost" disabled={props.disabled}
              onClick={() => post({ decision: 'elsewhere', cardTransactionId: paymentId })}>
              Paid from another account
            </button>
          ) : null}
          {match.possibleDebits.length > 0 || match.reason === 'no-checking-debit' ? consequence : null}
        </>
      ) : match.status === 'returned' ? (
        <>
          <p data-testid="payment-returned">
            <strong>Returned by the card.</strong> {returnedPaymentText(match.reversal.dayOffset)} A transfer, not spending.
          </p>
          <ul>{reversal(match.reversal)}</ul>
        </>
      ) : match.status === 'elsewhere' ? (
        <p>
          <strong>Paid from another account</strong>, as you said.{' '}
          <button type="button" className="spending-link inline" disabled={props.disabled} onClick={() => undo(match.decisionId)}>Undo</button>
        </p>
      ) : (
        <p><strong>Pending.</strong> Checked against checking once it posts.</p>
      )}
    </section>
  );
}
