import { useState, type Ref } from 'react';
import type { CardAccount, CardSpendingInsights, RecurringCharge } from '@finance-tracker/shared';

import { ChevronDown, ChevronRight } from '../icons';
import { Spinner, TitleWithSpinner } from '../Spinner';
import { useUpdatingMark } from '../useUpdatingMark';
import { buildInsightCards, VISIBLE_INSIGHTS, type InsightContext, type InsightTarget } from './insightCards';
import { FILTER_SCOPE, recurringPeriod } from './overview/headlineText';
import type { SpendingInsightsResponse } from './spendingApi';
import { cardNameLabel, formatMinor, longDate, shortDate } from './spendingFormat';

export interface MerchantFilter {
  /** Group key sent to the API. */
  key: string;
  /** What people read. */
  name: string;
}

interface Actions {
  onCategory: (category: string) => void;
  onMerchant: (merchant: MerchantFilter) => void;
  onOpen: (id: string) => void;
}

const CADENCE_LABELS: Record<RecurringCharge['cadence'], string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly',
};

/**
 * The period's insights as a grid that wraps to the panel's width (one
 * column on a phone): the first few by what they are about, then "Show all".
 * The answer and its words come together, so a card never says one period's
 * words over another period's figures. What the categories are based on is
 * said once, in Spending by category.
 */
export function SpendingInsightsPanel(props: {
  insights: SpendingInsightsResponse | null;
  context: InsightContext | null;
  loading: boolean;
  /**
   * The insights couldn't be read for this view while none of the view's were on screen (another view's went): their
   * error, said in their place until a read of the view succeeds.
   */
  failure?: string | null;
  /** The panel, which focus can move to (once "Try again" has read it). */
  anchorRef?: Ref<HTMLElement>;
  /** The category filter in use: a split large purchase says its part in it. */
  category: string | null;
} & Actions) {
  const [expanded, setExpanded] = useState(false);
  const { insights, context } = props;
  const failure = props.failure ?? null;
  const cards = insights && context ? buildInsightCards(insights, context, { category: props.category }) : [];
  const shown = expanded ? cards : cards.slice(0, VISIBLE_INSIGHTS);
  // Another period, or after a change: the insights shown are the last read's, dimmed at once until a moment after the
  // new ones land. A read that failed is not held: its error says what happened.
  const updating = useUpdatingMark(props.loading && insights !== null, { failed: failure !== null });
  // A failed read read again: nothing is shown to mark, only that it is being read.
  const reading = failure !== null && props.loading;
  const run = (target: InsightTarget) => {
    if (target.type === 'row') props.onOpen(target.id);
    else if (target.type === 'merchant') props.onMerchant({ key: target.key, name: target.name });
    else props.onCategory(target.category);
  };
  return (
    <section ref={props.anchorRef} tabIndex={-1} className="spending-panel spending-insights" aria-label="Insights"
      data-updating={updating ? 'true' : undefined}>
      <header className="spending-panel-head">
        <TitleWithSpinner busy={updating || reading} label={updating ? 'Updating' : 'Looking for insights'}
          testId={updating ? 'insights-updating' : 'insights-looking'} deferred={!updating}>
          <h3>Insights</h3>
        </TitleWithSpinner>
        <span className="spending-muted">{context?.heading ?? 'What changed, what repeats, what to check'}</span>
      </header>
      <p className="overview-scope-line" data-testid="insights-scope">{FILTER_SCOPE}</p>
      {props.loading && !insights && failure === null
        ? <p className="spending-muted"><Spinner label="Looking for insights" testId="insights-looking" deferred /></p>
        : null}
      {failure !== null ? <p className="overview-error" data-testid="insights-error">{`Couldn't read the insights: ${failure}`}</p> : null}
      {insights && context && cards.length === 0 ? (
        <p className="spending-muted">Nothing stands out {context.period}.</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="spending-insight-list">
          {shown.map((card) => (
            <li key={card.id} className={`spending-insight tone-${card.tone}`} data-insight={card.kind} title={card.hint}>
              <div className="spending-insight-body">
                <div className="spending-insight-text">
                  <strong>{card.title}</strong>
                  <span>{card.detail}</span>
                </div>
                {card.action ? (
                  <button
                    type="button"
                    className="spending-button ghost"
                    onClick={() => run(card.action!.target)}
                    aria-label={`${card.action.label}: ${card.title}`}
                  >
                    {card.action.label}
                  </button>
                ) : null}
              </div>
              {card.items.length > 0 ? (
                <ul className="spending-insight-items" aria-label={card.title}>
                  {card.items.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="spending-insight-item"
                        onClick={() => run(item.target)}
                        aria-label={`${item.target.type === 'row' ? 'Open' : 'Show'}: ${item.label}, ${item.amount}, ${item.note}`}
                      >
                        <span className="spending-insight-item-name">{item.label}</span>
                        <span className="spending-insight-item-amount num">{item.amount}</span>
                        <span className="spending-insight-item-note">{item.note}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {cards.length > VISIBLE_INSIGHTS ? (
        <button type="button" className="spending-link spending-insight-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? 'Show fewer' : `Show all (${cards.length})`}
        </button>
      ) : null}
    </section>
  );
}

function RecurringRow({ charge, currency, accountById, onMerchant }: {
  charge: RecurringCharge;
  currency: string;
  accountById: Map<string, CardAccount>;
  onMerchant: (merchant: MerchantFilter) => void;
}) {
  const cards = charge.cardAccountIds.map((id) => cardNameLabel(accountById.get(id))).join(', ');
  const amount = formatMinor(charge.typicalMinor, currency);
  const cadence = CADENCE_LABELS[charge.cadence];
  return (
    <li className={`spending-recurring-row${charge.active ? '' : ' inactive'}`}>
      <button
        type="button"
        className="spending-recurring-main"
        aria-label={`${charge.merchant}, ${cadence.toLowerCase()} ${amount}: show its charges`}
        onClick={() => onMerchant({ key: charge.key, name: charge.merchant })}
      >
        <span className="spending-recurring-name">
          {charge.merchant}
          {charge.priceChange ? (
            <span className={`spending-badge${charge.priceChange.toMinor > charge.priceChange.fromMinor ? ' warn' : ''}`}>
              {charge.priceChange.toMinor > charge.priceChange.fromMinor ? 'Price up' : 'Price down'}
            </span>
          ) : null}
          {!charge.fixed ? <span className="spending-badge">Amount varies</span> : null}
        </span>
        <span className="spending-recurring-meta">
          {cadence} · {charge.active ? `next about ${shortDate(charge.nextDate)}` : `last ${longDate(charge.lastDate)}`} · {cards}
        </span>
      </button>
      <span className="spending-recurring-amount num">
        {amount}
        {charge.cadence !== 'monthly' ? (
          <span className="spending-row-original">{formatMinor(charge.monthlyMinor, currency)} a month</span>
        ) : null}
      </span>
    </li>
  );
}

export function RecurringPanel(props: {
  insights: CardSpendingInsights | null;
  /** The insights are being read again: the charges shown are the last read's. */
  loading?: boolean;
  /** The insights couldn't be read for this view, and no other view's are shown: their error, in place of the charges. */
  failure?: string | null;
  accountById: Map<string, CardAccount>;
  onMerchant: (merchant: MerchantFilter) => void;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const failure = props.failure ?? null;
  // Read again with the insights: the charges shown are the last read's, dimmed at once until a moment after. A read
  // that failed is not held: its error says what happened.
  const updating = useUpdatingMark(Boolean(props.loading) && props.insights !== null, { failed: failure !== null });
  if (!props.insights) {
    if (failure === null) return null;
    // Unknown, never "none found": "—" for how many, and why, until a read of the view succeeds.
    return (
      <section className="spending-panel spending-recurring" aria-label="Recurring charges">
        <header className="spending-panel-head">
          <TitleWithSpinner busy={Boolean(props.loading)} label="Reading recurring charges" testId="recurring-reading" deferred>
            <h3>Recurring charges</h3>
          </TitleWithSpinner>
          {props.loading ? null : <span className="spending-muted">—</span>}
        </header>
        <p className="overview-error" data-testid="recurring-error">{`Couldn't read the recurring charges: ${failure}`}</p>
      </section>
    );
  }
  const { currency, today } = props.insights;
  const active = props.insights.recurring.filter((charge) => charge.active);
  const inactive = props.insights.recurring.filter((charge) => !charge.active);
  const monthly = active.reduce((total, charge) => total + charge.monthlyMinor, 0);
  const row = (charge: RecurringCharge) => (
    <RecurringRow
      key={`${charge.key}-${charge.typicalMinor}-${charge.cadence}`}
      charge={charge}
      currency={currency}
      accountById={props.accountById}
      onMerchant={props.onMerchant}
    />
  );
  return (
    <section className="spending-panel spending-recurring" aria-label="Recurring charges" data-updating={updating ? 'true' : undefined}>
      <header className="spending-panel-head">
        <TitleWithSpinner busy={updating} testId="recurring-updating"><h3>Recurring charges</h3></TitleWithSpinner>
        <span className="spending-muted">
          {active.length > 0
            ? `${active.length} active · about ${formatMinor(monthly, currency)} a month`
            : 'None found yet: a charge needs three payments on a regular rhythm'}
        </span>
      </header>
      <p className="overview-scope-line" data-testid="recurring-scope">{`${recurringPeriod(today)}. ${FILTER_SCOPE}`}</p>
      {active.length > 0 ? <ul className="spending-recurring-list">{active.map(row)}</ul> : null}
      {inactive.length > 0 ? (
        <div className="spending-recurring-inactive">
          <button type="button" className="spending-link" aria-expanded={showInactive} onClick={() => setShowInactive((open) => !open)}>
            {showInactive ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {inactive.length} not charged lately (maybe cancelled)
          </button>
          {showInactive ? <ul className="spending-recurring-list">{inactive.map(row)}</ul> : null}
        </div>
      ) : null}
    </section>
  );
}
