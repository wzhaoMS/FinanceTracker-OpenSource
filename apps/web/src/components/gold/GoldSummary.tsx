import { useId } from 'react';

import { Disclosure } from '../Disclosure';
import { TitleWithSpinner } from '../Spinner';
import type { GoldPeriod, MetalsMeasure, MetalsOverview } from './goldApi';
import {
  HOLDINGS_SUBTITLE,
  PERIOD_NAMES,
  PERIOD_NO_SALES,
  PROFIT_COVERED_LABEL,
  PROFIT_SALES_LABEL,
  SPOT_OFF_WORDS,
  asOfText,
  awaitingLine,
  dateText,
  forInformationText,
  fungibleFor,
  heldForAnswerLine,
  heldUnknownText,
  levelShiftText,
  moneyFigure,
  needsYouText,
  periodSalesNone,
  plural,
  priceNote,
  profitCoverageText,
  profitFullyKnown,
  profitMethod,
  profitUnknownText,
  spotFigure,
  spotShown,
  stateWord,
  summaryWarning,
  troyOzLine,
  unresolvedMetalHeldLine,
  withState,
  type GoldLinePart,
  type GoldPeriodChoice,
  type GoldSpot,
} from './goldText';

/** A figure, and beside it its state word when it is partial or unknown: a partial sum never reads as a total. */
export function Figure({ measure, text, className, testId }: {
  measure: Pick<MetalsMeasure<unknown>, 'state'>;
  text: string;
  className?: string;
  testId?: string;
}) {
  const word = stateWord(measure);
  return (
    <span className={`gold-figure${className ? ` ${className}` : ''}`} data-state={measure.state} data-testid={testId}>
      <span className="num">{text}</span>
      {word ? <span className="gold-state">{word}</span> : null}
    </span>
  );
}

/** A row's line from its parts: words as they are, each figure with its state word beside it. */
export function LineParts({ parts }: { parts: readonly GoldLinePart[] }) {
  return (
    <>
      {parts.map((part, index) => (typeof part === 'string'
        ? part
        : <Figure key={index} measure={part} text={part.figure} />))}
    </>
  );
}

/**
 * A value or gain at spot: its figure with its state while values show, else "Prices off" or "No price yet", never a
 * number. `tone` (a gain or loss colour) goes on a number shown, never on those words (Astra's R5): they say nothing of
 * the value's sign.
 */
export function SpotFigure({ measure, spot, signed = false, className, tone, testId }: {
  measure: MetalsMeasure<number>;
  spot: GoldSpot;
  signed?: boolean;
  className?: string;
  tone?: string;
  testId?: string;
}) {
  if (spot !== 'shown') {
    return <span className={`gold-figure gold-spot-off${className ? ` ${className}` : ''}`} data-state={spot} data-testid={testId}>{SPOT_OFF_WORDS[spot]}</span>;
  }
  const classes = [className, measure.value === null ? null : tone].filter((part): part is string => Boolean(part)).join(' ');
  return <Figure measure={measure} text={spotFigure(measure, spot, signed)} className={classes || undefined} testId={testId} />;
}

const signClass = (measure: MetalsMeasure<number>) =>
  (measure.value === null || measure.value === 0 ? 'gold-zero' : measure.value > 0 ? 'gain' : 'loss');

/**
 * The summary (Astra's accepted redesign): first the chosen period's money, what was paid and what sales brought in
 * (troy oz beside them), and the profit or loss on those sales, its cost earliest units first; then, apart and never
 * added to it, what is held as of today: its gain or loss, cost, value at spot (v0's rule: prices off or no price yet,
 * never a number) and troy oz. One completeness line covers every figure here, with the way to act on it.
 *
 * Over All, the totals above already show what was paid and brought in, so the period doesn't repeat them (Astra's
 * copy ruling); its profit or loss stays only when it adds a basis: the totals include what is held, or have no figure.
 * Identical to the totals' own, it is left out. A figure known for only some of the sales is labelled as covering those,
 * with how many right under the label, never as the sales' whole result (Astra's headline ruling).
 *
 * The overview keeps its last answer while the next is under way, so after a change of period it can still answer the
 * period before: until it answers the period chosen (`current`), the period's heading says it is being read and its
 * figures, and the completeness line over them, wait. What is held as of today stays (the same metal, the same day).
 */
export function GoldResult({ overview, choice, period, busy, current, onReview, totalsKind = null }: {
  overview: MetalsOverview;
  choice: GoldPeriodChoice;
  period: GoldPeriod;
  busy: boolean;
  /** `overview` answers the metal and period chosen (goldReads: periodOverview). */
  current: boolean;
  onReview: () => void;
  /** The totals' third number, once read: what the period section mustn't repeat over All. */
  totalsKind?: 'estimate' | 'sales' | 'unavailable' | null;
}) {
  const periodId = useId();
  const heldId = useId();
  const { activity: { bought, sold, profit }, holdings, price, metal } = overview;
  const spot = spotShown(price);
  const warning = summaryWarning(overview);
  const held = heldForAnswerLine(overview);
  const awaiting = awaitingLine(overview);
  const shift = spot === 'shown' ? levelShiftText(price.levelShift) : null;
  const unresolved = unresolvedMetalHeldLine(overview.metalUnknown);
  const heldUnknown = heldUnknownText(overview);
  const dates = period.from ? `${dateText(period.from)} – ${dateText(period.to)}` : `to ${dateText(period.to)}`;
  const allTime = choice === 'all';
  const showMoney = !allTime;
  const showProfit = !allTime || totalsKind !== 'sales';
  // Known for only some of the sales: the covered sales' figure, never these sales' whole result. A figure for every sale
  // that is itself partial keeps this label, with its "Partial" beside it.
  const covered = profit.valueMinor.value !== null && !profitFullyKnown(profit.coverage);
  const coverage = profitCoverageText(profit.coverage, profit.estimate);
  // No sale recorded in the period, and that is known: the period says so in words (Astra's R5), never "$0.00".
  const noSales = periodSalesNone(overview);
  // Read again (the same period's figures kept, marked) or not yet the period chosen (none shown): busy, said by the heading.
  const periodReading = busy || !current;
  // Across all forms where the owner's fungible policy names the metal.
  const method = profitMethod(fungibleFor(overview, metal));
  return (
    <div className={`gold-summary${showProfit ? '' : ' single'}`} data-testid="gold-summary" data-updating={busy ? 'true' : undefined}
      aria-busy={periodReading || undefined}>
      {showProfit ? (
      <section className="gold-result" aria-labelledby={periodId} data-testid="gold-period" aria-busy={periodReading || undefined}>
        {periodReading ? (
          <TitleWithSpinner busy><h3 id={periodId}>{PERIOD_NAMES[choice]} · {dates}</h3></TitleWithSpinner>
        ) : <h3 id={periodId}>{PERIOD_NAMES[choice]} · {dates}</h3>}
        {current && showMoney ? (
        <dl className="gold-money-list">
          <div data-testid="gold-paid">
            <dt>Paid</dt>
            <dd>
              <Figure measure={bought.costMinor} text={moneyFigure(bought.costMinor)} className="gold-money" />
              <span className="gold-row-sub">
                {plural(bought.lots, 'purchase', 'purchases')} kept or on the way, by order date · {troyOzLine(bought.troyOz)}
              </span>
            </dd>
          </div>
          <div data-testid="gold-brought-in">
            <dt>Sales brought in</dt>
            <dd>
              {noSales ? <span className="gold-period-words" data-testid="gold-brought-in-none">{PERIOD_NO_SALES}</span> : (
                <>
                  <Figure measure={sold.netMinor} text={moneyFigure(sold.netMinor)} className="gold-money" />
                  <span className="gold-row-sub">
                    {plural(sold.lines, 'sale', 'sales')} by day agreed, after {withState(moneyFigure(sold.feesMinor), sold.feesMinor)} fees · {troyOzLine(sold.troyOz)}
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>
        ) : null}
        {current ? (
        <div className="gold-result-main" data-testid="gold-sale-profit" data-scope={noSales ? 'none' : covered ? 'covered' : 'all'}>
          <span className="gold-result-label">{covered ? PROFIT_COVERED_LABEL : PROFIT_SALES_LABEL}</span>
          {covered ? (
            <span className="gold-result-scope" data-testid="gold-sale-profit-scope">{coverage.charAt(0).toUpperCase()}{coverage.slice(1)}</span>
          ) : null}
          {noSales ? <span className="gold-period-words" data-testid="gold-sale-profit-none">{PERIOD_NO_SALES}.</span> : (
            <>
              <Figure measure={profit.valueMinor} text={moneyFigure(profit.valueMinor, true)} className={`gold-money big ${signClass(profit.valueMinor)}`} />
              <span className="gold-row-sub">
                {profit.valueMinor.value === null
                  ? profitUnknownText(profit.coverage, sold.lines)
                  : covered ? method : `${method} · ${coverage}`}
              </span>
            </>
          )}
        </div>
        ) : null}
      </section>
      ) : null}
      <section className="gold-holding" aria-labelledby={heldId} data-testid="gold-holding" aria-busy={busy || undefined}>
        {busy ? (
          <TitleWithSpinner busy><h3 id={heldId}>What you hold · {asOfText(overview.asOf)}</h3></TitleWithSpinner>
        ) : <h3 id={heldId}>What you hold · {asOfText(overview.asOf)}</h3>}
        <div className="gold-result-main">
          <span className="gold-result-label">Gain or loss on current holdings</span>
          <SpotFigure measure={holdings.gainMinor} spot={spot} signed className="gold-money big" tone={signClass(holdings.gainMinor)} testId="gold-gain" />
        </div>
        <dl className="gold-money-list compact">
          <div><dt>Cost</dt><dd><Figure measure={holdings.costMinor} text={moneyFigure(holdings.costMinor)} className="gold-money" testId="gold-cost" /></dd></div>
          <div><dt>Value at spot</dt><dd><SpotFigure measure={holdings.valueMinor} spot={spot} className="gold-money" testId="gold-value" /></dd></div>
          <div>
            <dt>Held</dt>
            <dd><span className="gold-row-sub" data-testid="gold-held-oz">{troyOzLine(holdings.troyOz)} · {HOLDINGS_SUBTITLE.toLowerCase()}</span></dd>
          </div>
        </dl>
        {unresolved ? <p className="gold-help" data-testid="gold-held-unresolved">{unresolved}</p> : null}
        {heldUnknown ? <p className="gold-help" data-testid="gold-held-why">{heldUnknown}</p> : null}
        <p className="gold-note" data-testid="gold-price-note">{priceNote(price, metal)}</p>
        {shift ? <p className="gold-note" data-testid="gold-level-shift">{shift}</p> : null}
        {awaiting ? <p className="gold-help" data-testid="gold-awaiting">{awaiting}</p> : null}
      </section>
      {current && (warning || held) ? (
        <p className="gold-warning gold-summary-warning" data-testid="gold-summary-warning">
          {[warning, held].filter((part): part is string => part !== null).join('. ')}.{' '}
          <button type="button" className="gold-link" onClick={onReview}>Review</button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What waits: what needs the owner, apart from what is only for their information. Shown only when something waits.
 * While the overview is read again (`busy`), what it shows (read before) is marked as being read again.
 */
export function GoldToCheck({ overview, onConfirm, sectionRef, busy = false }: {
  overview: MetalsOverview;
  onConfirm: () => void;
  sectionRef?: (node: HTMLElement | null) => void;
  busy?: boolean;
}) {
  const titleId = useId();
  const { toCheck } = overview;
  // Only what this page can act on: the exclusion rule is Spending's (G5), listed only where its review can open; the
  // bullion answer (A0) is listed for information until the page can take the answer, so the count matches the list.
  const needsYou = toCheck.needsYou.filter((item) => item.code === 'confirm-content' || item.code === 'confirmation-drift');
  const held = heldForAnswerLine(overview);
  const info = toCheck.forInformation;
  if (needsYou.length === 0 && info.length === 0 && !held) return null;
  const notes = [...(held ? [{ key: 'held-for-answer', text: held }] : []), ...info.map((item) => ({ key: item.code, text: forInformationText(item) }))];
  const title = <h3 id={titleId}>To check ({toCheck.records} {toCheck.records === 1 ? 'record' : 'records'})</h3>;
  return (
    <section ref={sectionRef} className="gold-card gold-tocheck" aria-labelledby={titleId} data-testid="gold-to-check" tabIndex={-1}
      aria-busy={busy || undefined}>
      {busy ? <TitleWithSpinner busy>{title}</TitleWithSpinner> : title}
      {needsYou.length > 0 ? (
        <div className="gold-tocheck-group">
          <h4>Needs you</h4>
          <ul>
            {needsYou.map((item) => (
              <li key={item.code}>
                <button type="button" className="gold-link" onClick={onConfirm}>{needsYouText(item)}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div className="gold-tocheck-group">
          <h4>For your information</h4>
          {notes.length > 3 ? (
            <Disclosure summary={`${notes.length} notes`}>
              <ul>{notes.map((note) => <li key={note.key}>{note.text}</li>)}</ul>
            </Disclosure>
          ) : (
            <ul>{notes.map((note) => <li key={note.key}>{note.text}</li>)}</ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
