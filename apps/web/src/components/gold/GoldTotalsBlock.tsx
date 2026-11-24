import { useId } from 'react';

import { Disclosure } from '../Disclosure';
import { Spinner } from '../Spinner';
import {
  TOTALS_AFFECTS,
  TOTALS_FIGURES,
  TOTALS_INCLUDES,
  TOTALS_REVIEW_COVERAGE,
  TOTALS_WHY,
  type GoldCombinedTotals,
  type GoldTotals,
  type GoldTotalsReason,
  type GoldTotalsResult,
  type GoldTotalsRow,
} from './goldTotals';

/** One of the totals' numbers: its figure (or the words standing for it) with its limitation in short beside it, then its sub-line. */
function TotalsRow({ label, row, testId }: { label: string; row: GoldTotalsRow; testId: string }) {
  return (
    <div data-testid={testId} data-state={row.state}>
      <dt>{label}</dt>
      <dd>
        <span className="gold-totals-figure">
          {row.state === 'none'
            ? <span className="gold-totals-words">{row.figure}</span>
            : <span className="gold-figure gold-money" data-state={row.state}><span className="num">{row.figure}</span></span>}
          {row.short ? <span className="gold-totals-short" data-testid={`${testId}-short`}>{row.short}</span> : null}
        </span>
        <span className="gold-row-sub">{row.sub}</span>
      </dd>
    </div>
  );
}

const signClass = (valueMinor: number) => (valueMinor === 0 ? 'gold-zero' : valueMinor > 0 ? 'gain' : 'loss');

/**
 * The third number: the figure with its basis, or why there is none: the refusal, its principal reason, and the one
 * action that helps (where the figures come from when the history isn't proven, otherwise what waits to be checked).
 * Every other reason is under "Why these totals are incomplete".
 */
function TotalsResult({ label, result, testId, onReviewCoverage, onReview }: {
  label: string | null;
  result: GoldTotalsResult;
  testId: string;
  onReviewCoverage: () => void;
  onReview: () => void;
}) {
  if (result.kind === 'unavailable') {
    const coverage = result.action === 'coverage';
    return (
      <div className="gold-result-main gold-totals-result" data-testid={testId} data-kind={result.kind}>
        {label ? <span className="gold-result-label">{label}</span> : null}
        <span className="gold-totals-words">{result.title}</span>
        {result.lead ? <p className="gold-totals-lead" data-testid={`${testId}-lead`}>{result.lead}</p> : null}
        <button type="button" className="gold-link" onClick={coverage ? onReviewCoverage : onReview}>{coverage ? TOTALS_REVIEW_COVERAGE : 'Review'}</button>
      </div>
    );
  }
  return (
    <div className="gold-result-main gold-totals-result" data-testid={testId} data-kind={result.kind}>
      {label ? <span className="gold-result-label">{label}</span> : null}
      {result.figure !== null ? (
        <span className={`gold-figure gold-money big ${signClass(result.valueMinor)}`}><span className="num">{result.figure}</span></span>
      ) : null}
      <ul className="gold-result-lines">{result.lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}

/** Every reason the figures are incomplete, once each, with the figures it affects: folded under one toggle. */
function TotalsWhy({ why, testId }: { why: readonly GoldTotalsReason[]; testId: string }) {
  if (why.length === 0) return null;
  return (
    <div className="gold-totals-why" data-testid={testId}>
      <Disclosure summary={TOTALS_WHY}>
        <ul className="gold-why">
          {why.map((reason) => (
            <li key={reason.text}>
              <span>{reason.text}</span>
              <span className="gold-why-for">{TOTALS_AFFECTS}: {reason.figures.join(' · ')}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

/**
 * The totals (Alex's three numbers): what was bought, what was sold and the profit or loss, over all recorded history as
 * of one day, above the period and never moving with it; what the figures include, folded; and the metals together,
 * folded, money only.
 */
export function GoldTotalsBlock({ totals, combined, busy, error, onRetry, onReviewCoverage, onReview }: {
  totals: GoldTotals | null;
  combined: GoldCombinedTotals | null;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onReviewCoverage: () => void;
  onReview: () => void;
}) {
  const headingId = useId();
  if (error) {
    return (
      <section className="gold-totals" aria-label="Totals" data-testid="gold-totals">
        <div className="gold-error" role="alert">
          <p>The totals couldn&apos;t be read: {error}</p>
          <button type="button" className="gold-button" onClick={onRetry}>Read again</button>
        </div>
      </section>
    );
  }
  if (!totals) {
    return (
      <section className="gold-totals" aria-label="Totals" aria-busy="true" data-testid="gold-totals">
        <p className="gold-loading"><Spinner label="Reading the totals" deferred /></p>
      </section>
    );
  }
  return (
    <section className="gold-totals" aria-labelledby={headingId} data-testid="gold-totals" data-updating={busy ? 'true' : undefined}>
      <div className="gold-totals-head">
        <h3 id={headingId}>{totals.heading}</h3>
        <p className="gold-help" data-testid="gold-totals-as-of">{totals.asOf}</p>
      </div>
      <dl className="gold-money-list">
        <TotalsRow label={TOTALS_FIGURES.bought} row={totals.bought} testId="gold-totals-bought" />
        <TotalsRow label={TOTALS_FIGURES.sold} row={totals.sold} testId="gold-totals-sold" />
      </dl>
      <TotalsResult label={totals.resultLabel} result={totals.result} testId="gold-totals-result"
        onReviewCoverage={onReviewCoverage} onReview={onReview} />
      <TotalsWhy why={totals.why} testId="gold-totals-why" />
      <Disclosure summary="What this includes" className="gold-totals-includes">
        {TOTALS_INCLUDES.map((text) => <p key={text} className="gold-help">{text}</p>)}
      </Disclosure>
      {combined ? (
        <div className="gold-totals-combined" data-testid="gold-totals-combined">
          <Disclosure summary={combined.heading}>
            <dl className="gold-money-list">
              <TotalsRow label={TOTALS_FIGURES.bought} row={combined.bought} testId="gold-combined-bought" />
              <TotalsRow label={TOTALS_FIGURES.sold} row={combined.sold} testId="gold-combined-sold" />
            </dl>
            <TotalsResult label={combined.resultLabel} result={combined.result} testId="gold-combined-result"
              onReviewCoverage={onReviewCoverage} onReview={onReview} />
            <TotalsWhy why={combined.why} testId="gold-combined-why" />
          </Disclosure>
        </div>
      ) : null}
    </section>
  );
}
