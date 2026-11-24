import type { CardAccount, CardOwner } from '../types.js';
import { addDays, addMonths, daysBetween, isBenefitDate, monthNumber } from './dates.js';
import { ISSUER_TRACKER_STALE_DAYS, type IssuerBenefitTrackerRecord } from './issuerTrackers.js';
import { benefitSpansBetween, benefitYearSpans, cadenceLabel, type BenefitPeriodSpan } from './periods.js';
import { benefitAppliesDuring, benefitAppliesOn, benefitPattern, benefitVersions, resolveBenefitProduct } from './products.js';
import type {
  BenefitCatalog,
  BenefitCreditRow,
  BenefitCurrentView,
  BenefitDefinition,
  BenefitIssuerFigure,
  BenefitMatchView,
  BenefitPeriodView,
  BenefitProduct,
  BenefitReminder,
  BenefitTotals,
  BenefitView,
  CardBenefitMark,
  CardBenefitSettings,
  CardBenefitsCardView,
  CardBenefitsReport,
} from './types.js';

/**
 * Credits post after the purchase they reward, sometimes in the next period:
 * a credit dated this many days or fewer into a period that is already full
 * counts for the period before, when that one still has room.
 */
export const BENEFIT_CREDIT_GRACE_DAYS = 10;

/** A current period ending within this many days, with something left, is a "use it before it resets" reminder. */
export const BENEFIT_REMINDER_DAYS = { month: 7, quarter: 21, half: 30, year: 45 } as const;

/** Statement credits: money back that is not a card payment. */
const CREDIT_KINDS = new Set(['adjustment', 'refund', 'other']);
/** A credit taken back posts as a charge of one of these kinds. */
const CLAWBACK_KINDS = new Set(['adjustment', 'other']);

const OWNERS: readonly CardOwner[] = ['alex', 'casey', 'joint'];

export interface CardBenefitsReportInput {
  catalog: BenefitCatalog;
  year: number;
  /** The viewer's date (YYYY-MM-DD): current periods, days left, reminders. */
  today: string;
  cards: ReadonlyArray<{ account: CardAccount; settings: CardBenefitSettings | null }>;
  /** Posted card transactions in `benefitCreditWindow`, any kind (non-credits are ignored). */
  credits: readonly BenefitCreditRow[];
  marks: readonly CardBenefitMark[];
  trackers: readonly IssuerBenefitTrackerRecord[];
}

/** The transaction dates a report for `year` reads: back far enough for a credit allowed once every few years. */
export function benefitCreditWindow(year: number, today: string): { from: string; to: string } {
  const todayYear = Number(today.slice(0, 4));
  return { from: `${Math.min(year, todayYear) - 5}-01-01`, to: `${Math.max(year, todayYear) + 2}-01-31` };
}

/** What a posted row is worth to a benefit: positive for a credit, negative for a credit taken back, null otherwise. */
export function benefitCreditValue(row: Pick<BenefitCreditRow, 'amountMinor' | 'kind'>): number | null {
  if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor === 0) return null;
  if (row.amountMinor < 0) return CREDIT_KINDS.has(row.kind) ? -row.amountMinor : null;
  return CLAWBACK_KINDS.has(row.kind) ? -row.amountMinor : null;
}

/**
 * The benefit of `product` a posted row is a statement credit for: the first
 * of the product's statement-credit benefits, in catalog order, with a version
 * in force on the row's date whose pattern matches its description or
 * merchant (an adjustment row also by the version's adjustment patterns).
 * Null for anything else, payments included.
 */
export function matchBenefitCredit(product: BenefitProduct, row: BenefitCreditRow): string | null {
  if (benefitCreditValue(row) === null) return null;
  const texts = [row.description, row.merchant ?? ''].filter((text) => text !== '');
  for (const benefit of product.benefits) {
    if (benefit.tracking.method !== 'statement-credit' || !benefitAppliesOn(benefit, row.date)) continue;
    const patterns = row.kind === 'adjustment'
      ? [...benefit.tracking.patterns, ...(benefit.tracking.adjustmentPatterns ?? [])]
      : benefit.tracking.patterns;
    if (patterns.some((source) => texts.some((text) => benefitPattern(source).test(text)))) return benefit.id;
  }
  return null;
}

interface Allocated {
  span: BenefitPeriodSpan;
  capMinor: number;
  totalMinor: number;
  rows: Array<{ row: BenefitCreditRow; value: number }>;
}

/**
 * Places matched credits in periods: each in the period of its date, then a
 * credit early in a period that is over its amount moves back to the period
 * before while that one has room (it rewarded a purchase made there).
 */
function allocate(spans: BenefitPeriodSpan[], caps: number[], rows: Array<{ row: BenefitCreditRow; value: number }>): Allocated[] {
  const periods: Allocated[] = spans.map((span, i) => ({ span, capMinor: caps[i], totalMinor: 0, rows: [] }));
  for (const entry of rows) {
    const period = periods.find(({ span }) => entry.row.date >= span.start && entry.row.date <= span.end);
    if (!period) continue;
    period.rows.push(entry);
    period.totalMinor += entry.value;
  }
  for (let i = 1; i < periods.length; i += 1) {
    const period = periods[i];
    const before = periods[i - 1];
    const lastGraceDay = addDays(period.span.start, BENEFIT_CREDIT_GRACE_DAYS - 1);
    const early = period.rows
      .filter((entry) => entry.value > 0 && entry.row.date <= lastGraceDay)
      .sort((a, b) => a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id));
    for (const entry of early) {
      if (period.totalMinor <= period.capMinor || before.totalMinor >= before.capMinor) break;
      period.rows.splice(period.rows.indexOf(entry), 1);
      period.totalMinor -= entry.value;
      before.rows.push(entry);
      before.totalMinor += entry.value;
    }
  }
  return periods;
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** The version of a benefit in force at the end of a period, else any version during it. */
function versionFor(versions: BenefitDefinition[], span: BenefitPeriodSpan): BenefitDefinition | null {
  return versions.find((version) => benefitAppliesOn(version, span.end))
    ?? [...versions].reverse().find((version) => benefitAppliesDuring(version, span.start, span.end))
    ?? null;
}

function amountFor(version: BenefitDefinition, span: BenefitPeriodSpan): number {
  if (version.value.unit === 'count') return version.value.count;
  return version.value.byStartMonth?.[(monthNumber(span.start) % 12) + 1] ?? version.value.amountMinor;
}

/**
 * What one period of a benefit gives (cents, or a count), by the version in
 * force at the period's end, or null when no version applies during it.
 */
export function benefitPeriodAmount(versions: BenefitDefinition[], span: { start: string; end: string }): number | null {
  const version = versionFor(versions, { ...span, label: '' });
  return version ? amountFor(version, { ...span, label: '' }) : null;
}

function stateOf(span: BenefitPeriodSpan, today: string): BenefitPeriodView['state'] {
  if (span.end < today) return 'past';
  return span.start > today ? 'future' : 'current';
}

function issuerFigure(tracker: IssuerBenefitTrackerRecord, today: string): BenefitIssuerFigure {
  return {
    issuerBenefitId: tracker.issuerBenefitId,
    name: tracker.name,
    observedAt: tracker.observedAt,
    stale: daysBetween(tracker.observedAt.slice(0, 10), today) > ISSUER_TRACKER_STALE_DAYS,
    usedMinor: tracker.usedMinor,
    totalMinor: tracker.totalMinor,
    enrollment: tracker.enrollment,
    resetDate: tracker.resetDate,
  };
}

/** The latest observation per card, tracker id and period. */
function latestTrackers(trackers: readonly IssuerBenefitTrackerRecord[]): IssuerBenefitTrackerRecord[] {
  const latest = new Map<string, IssuerBenefitTrackerRecord>();
  for (const tracker of trackers) {
    const key = JSON.stringify([tracker.cardAccountId, tracker.issuerBenefitId, tracker.periodStart, tracker.periodEnd]);
    const seen = latest.get(key);
    if (!seen || tracker.observedAt > seen.observedAt) latest.set(key, tracker);
  }
  return [...latest.values()];
}

interface BenefitContext {
  today: string;
  year: number;
  anniversaryMonth: number | null;
  credits: Array<{ row: BenefitCreditRow; value: number }>;
  marks: Map<string, CardBenefitMark>;
  trackers: IssuerBenefitTrackerRecord[];
}

function periodView(
  span: BenefitPeriodSpan,
  versions: BenefitDefinition[],
  allocated: Allocated | undefined,
  context: BenefitContext,
  tracker: IssuerBenefitTrackerRecord | undefined,
): BenefitPeriodView {
  const version = versionFor(versions, span);
  const unit = versions[0].value.unit;
  const active = version !== null;
  const catalogAmount = version ? amountFor(version, span) : 0;
  const derivedMinor = allocated ? clamp(allocated.totalMinor, catalogAmount) : 0;
  const matches: BenefitMatchView[] = (allocated?.rows ?? [])
    .map(({ row }) => ({ id: row.id, date: row.date, amountMinor: row.amountMinor, description: row.description }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const mark = context.marks.get(span.start) ?? null;
  const issuer = tracker ? issuerFigure(tracker, context.today) : null;
  // An issuer figure applies in the benefit's own unit (cents in US dollars, or a count), even when it says
  // the use is unknown: unknown stays unknown, never zero, and outranks marks and matched credits.
  const issuerUsable = tracker !== undefined && active
    && (unit === 'usd' ? tracker.unit === 'money' && tracker.currency === 'USD' : tracker.unit === 'count');
  let availableMinor = catalogAmount;
  let usedMinor: number | null;
  let source: BenefitPeriodView['source'];
  if (issuerUsable) {
    availableMinor = tracker.totalMinor ?? catalogAmount;
    usedMinor = tracker.usedMinor;
    source = 'issuer';
  } else if (mark && active) {
    usedMinor = mark.status === 'used' ? catalogAmount : mark.status === 'unused' ? 0 : clamp(mark.usedMinor ?? 0, catalogAmount);
    source = 'manual';
  } else if (version?.tracking.method === 'statement-credit') {
    usedMinor = derivedMinor;
    source = 'derived';
  } else {
    usedMinor = active ? null : 0;
    source = 'none';
  }
  return {
    start: span.start,
    end: span.end,
    label: span.label,
    state: stateOf(span, context.today),
    active,
    availableMinor,
    usedMinor,
    source,
    derivedMinor,
    matches,
    mark: mark ? { status: mark.status, usedMinor: mark.usedMinor, markedAt: mark.markedAt } : null,
    issuer,
  };
}

/**
 * What a benefit row says about itself, from the versions in force during
 * the shown year (the latest of them for its name, note and tracking).
 */
function benefitBase(versions: BenefitDefinition[], start: string, end: string) {
  const shown = versions.filter((version) => benefitAppliesDuring(version, start, end));
  const relevant = shown.length > 0 ? shown : versions;
  const [first] = versions;
  const latest = relevant[relevant.length - 1];
  return {
    id: first.id,
    name: latest.name,
    kind: latest.kind,
    unit: first.value.unit,
    noun: first.value.unit === 'count' ? first.value.noun : undefined,
    cadence: first.cadence,
    cadenceLabel: cadenceLabel(first.cadence),
    enrollment: relevant.some((version) => version.enrollment),
    tracking: latest.tracking.method,
    manualReason: latest.tracking.method === 'manual' ? latest.tracking.reason : undefined,
    verify: relevant.some((version) => version.verify === true),
    note: latest.note,
    ...(latest.compareAs === undefined ? {} : { compareAs: latest.compareAs }),
    ...(latest.category === undefined ? {} : { category: latest.category }),
  };
}

function rollingBenefit(versions: BenefitDefinition[], context: BenefitContext): Omit<BenefitView, 'window'> {
  const cadence = versions[0].cadence as Extract<BenefitDefinition['cadence'], { basis: string }>;
  const yearSpans = benefitYearSpans(cadence, context.year, context.anniversaryMonth);
  if (!yearSpans) {
    return {
      ...benefitBase(versions, `${context.year}-01-01`, `${context.year}-12-31`),
      inTotals: versions[0].value.unit === 'usd',
      needsAnniversary: true,
      periods: [],
      current: null,
      year: { capturedMinor: 0, availableMinor: 0, unknownPeriods: 0 },
    };
  }
  const yearStart = yearSpans[0].start;
  const yearEnd = yearSpans[yearSpans.length - 1].end;
  const base = { ...benefitBase(versions, yearStart, yearEnd), inTotals: versions[0].value.unit === 'usd' };
  // One period either side, so credits can move back across the edges, and today's period wherever it falls.
  const from = addDays(context.today < yearStart ? context.today : yearStart, -1);
  const to = addDays(context.today > yearEnd ? context.today : yearEnd, 1);
  const spans = benefitSpansBetween(cadence, from, to, context.anniversaryMonth)!;
  const caps = spans.map((span) => {
    const version = versionFor(versions, span);
    return version ? amountFor(version, span) : 0;
  });
  const allocated = allocate(spans, caps, context.credits);
  const trackerFor = (span: BenefitPeriodSpan) => context.trackers
    .filter((tracker) => (tracker.periodStart >= span.start && tracker.periodStart <= span.end))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const views = new Map(spans.map((span, i) => [span.start, periodView(span, versions, allocated[i], context, trackerFor(span))]));
  const periods = yearSpans.map((span) => views.get(span.start)!);
  const currentPeriod = [...views.values()].find((view) => view.state === 'current' && view.active) ?? null;
  let current: BenefitCurrentView | null = null;
  if (currentPeriod) {
    const daysLeft = daysBetween(context.today, currentPeriod.end) + 1;
    const remainingMinor = currentPeriod.usedMinor === null ? null : Math.max(currentPeriod.availableMinor - currentPeriod.usedMinor, 0);
    const window = BENEFIT_REMINDER_DAYS[cadence.every];
    current = { ...currentPeriod, daysLeft, remainingMinor, resetsSoon: daysLeft <= window && (remainingMinor === null || remainingMinor > 0) };
  }
  const active = periods.filter((period) => period.active);
  return {
    ...base,
    needsAnniversary: false,
    periods,
    current,
    year: {
      capturedMinor: active.reduce((sum, period) => sum + (period.usedMinor ?? 0), 0),
      availableMinor: active.reduce((sum, period) => sum + period.availableMinor, 0),
      unknownPeriods: active.filter((period) => period.state !== 'future' && period.usedMinor === null).length,
    },
  };
}

/** A credit allowed once per window of several years (a Global Entry fee): shown by calendar year, never in totals. */
function windowBenefit(versions: BenefitDefinition[], context: BenefitContext): BenefitView {
  const [first] = versions;
  const cadence = first.cadence as Extract<BenefitDefinition['cadence'], { every: 'years' }>;
  const yearView = (year: number): BenefitPeriodView => {
    const span: BenefitPeriodSpan = { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
    const version = versionFor(versions, span);
    const rows = context.credits.filter(({ row }) => row.date >= span.start && row.date <= span.end);
    const allocated: Allocated = {
      span,
      capMinor: version ? amountFor(version, span) : 0,
      totalMinor: rows.reduce((sum, entry) => sum + entry.value, 0),
      rows,
    };
    const tracker = context.trackers
      .filter((entry) => entry.periodStart <= span.end && entry.periodEnd >= span.start)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    return periodView(span, versions, allocated, context, tracker);
  };
  const period = yearView(context.year);
  // The last use Holdr knows: each calendar year of the window by its effective figure (issuer, mark, then matched
  // credits; a reversed credit, a "not used" mark or a zero amount is no use), dated by its latest credit, else the
  // day it was marked or observed in that year, else the year's last day.
  const windowStart = addMonths(context.today, -cadence.months);
  let lastUsed: string | null = null;
  for (let year = Number(windowStart.slice(0, 4)); year <= Number(context.today.slice(0, 4)); year += 1) {
    const view = year === context.year ? period : yearView(year);
    if (!view.active || view.usedMinor === null || view.usedMinor <= 0) continue;
    const credited = view.matches.filter((match) => match.amountMinor < 0).map((match) => match.date).sort().pop();
    const noted = view.source === 'manual' ? view.mark?.markedAt.slice(0, 10) : view.issuer?.observedAt.slice(0, 10);
    // A mark or an issuer figure confirms a use; it does not date one a credit already dates.
    const day = credited
      ?? (noted?.slice(0, 4) === String(year) && isBenefitDate(noted) ? noted : undefined)
      ?? `${year}-12-31`;
    if (day >= windowStart && day <= context.today && (lastUsed === null || day > lastUsed)) lastUsed = day;
  }
  return {
    ...benefitBase(versions, period.start, period.end),
    needsAnniversary: false,
    periods: [period],
    current: null,
    window: { lastUsed, nextEligible: lastUsed ? addMonths(lastUsed, cadence.months) : null },
    year: {
      capturedMinor: period.active ? period.usedMinor ?? 0 : 0,
      availableMinor: period.active ? period.availableMinor : 0,
      unknownPeriods: period.active && period.state !== 'future' && period.usedMinor === null ? 1 : 0,
    },
    inTotals: false,
  };
}

/** Whether any version of a benefit applies during the selected year (its cardmember year, when placed). */
function inYear(versions: BenefitDefinition[], year: number, anniversaryMonth: number | null): boolean {
  const spans = benefitYearSpans(versions[0].cadence, year, anniversaryMonth)
    ?? benefitYearSpans({ every: 'year', basis: 'calendar' }, year, null)!;
  const start = spans[0].start;
  const end = spans[spans.length - 1].end;
  return versions.some((version) => benefitAppliesDuring(version, start, end));
}

function emptyTotals(): BenefitTotals {
  return { capturedMinor: 0, availableMinor: 0, annualFeesMinor: 0 };
}

function addTotals(into: BenefitTotals, from: BenefitTotals): void {
  into.capturedMinor += from.capturedMinor;
  into.availableMinor += from.availableMinor;
  into.annualFeesMinor += from.annualFeesMinor;
}

/**
 * The Benefits tab's report for one year: per card account, its product's
 * benefits with each period's figure and where it came from (issuer, the
 * owner's mark, matched statement credits), today's period with the days
 * left, and the totals: per card, per owner and for the household (active
 * cards, dollar benefits only), against the annual fees.
 */
export function computeCardBenefitsReport(input: CardBenefitsReportInput): CardBenefitsReport {
  const { catalog, year, today } = input;
  const marksByCard = new Map<string, CardBenefitMark[]>();
  for (const mark of input.marks) marksByCard.set(mark.cardAccountId, [...(marksByCard.get(mark.cardAccountId) ?? []), mark]);
  const trackersByCard = new Map<string, IssuerBenefitTrackerRecord[]>();
  for (const tracker of latestTrackers(input.trackers)) {
    trackersByCard.set(tracker.cardAccountId, [...(trackersByCard.get(tracker.cardAccountId) ?? []), tracker]);
  }
  const creditsByCard = new Map<string, BenefitCreditRow[]>();
  for (const row of input.credits) creditsByCard.set(row.cardAccountId, [...(creditsByCard.get(row.cardAccountId) ?? []), row]);

  const household = { ...emptyTotals(), byOwner: Object.fromEntries(OWNERS.map((owner) => [owner, emptyTotals()])) as Record<CardOwner, BenefitTotals> };
  const reminders: BenefitReminder[] = [];

  const cards = input.cards.map(({ account, settings }): CardBenefitsCardView => {
    const { product, source } = resolveBenefitProduct(catalog, account, settings);
    const anniversaryMonth = settings?.anniversaryMonth ?? null;
    const cardTrackers = trackersByCard.get(account.id) ?? [];
    const mapped = new Set<IssuerBenefitTrackerRecord>();
    const benefits: BenefitView[] = [];
    if (product) {
      // Every credit row of the card goes to at most one benefit.
      const byBenefit = new Map<string, Array<{ row: BenefitCreditRow; value: number }>>();
      for (const row of creditsByCard.get(account.id) ?? []) {
        if (row.amountMinor === 0 || account.currency !== 'USD') continue;
        const id = matchBenefitCredit(product, row);
        if (id) byBenefit.set(id, [...(byBenefit.get(id) ?? []), { row, value: benefitCreditValue(row)! }]);
      }
      for (const versions of benefitVersions(product)) {
        if (!inYear(versions, year, anniversaryMonth)) continue;
        const ids = new Set(versions.flatMap((version) => version.issuerTrackerIds ?? []));
        const trackers = cardTrackers.filter((tracker) => ids.has(tracker.issuerBenefitId));
        for (const tracker of trackers) mapped.add(tracker);
        const context: BenefitContext = {
          today,
          year,
          anniversaryMonth,
          credits: byBenefit.get(versions[0].id) ?? [],
          marks: new Map((marksByCard.get(account.id) ?? []).filter((mark) => mark.benefitId === versions[0].id).map((mark) => [mark.periodStart, mark])),
          trackers,
        };
        benefits.push(versions[0].cadence.every === 'years' ? windowBenefit(versions, context) : rollingBenefit(versions, context));
      }
    }
    const totals = emptyTotals();
    for (const benefit of benefits) {
      if (!benefit.inTotals) continue;
      totals.capturedMinor += benefit.year.capturedMinor;
      totals.availableMinor += benefit.year.availableMinor;
    }
    totals.annualFeesMinor = product?.annualFeeMinor ?? 0;
    if (account.status === 'active') {
      addTotals(household, totals);
      addTotals(household.byOwner[account.owner], totals);
      for (const benefit of benefits) {
        if (!benefit.current?.resetsSoon) continue;
        reminders.push({
          cardAccountId: account.id,
          benefitId: benefit.id,
          benefitName: benefit.name,
          unit: benefit.unit,
          end: benefit.current.end,
          daysLeft: benefit.current.daysLeft,
          remainingMinor: benefit.current.remainingMinor,
          source: benefit.current.source,
        });
      }
    }
    return {
      cardAccountId: account.id,
      issuer: account.issuer,
      owner: account.owner,
      nickname: account.nickname ?? null,
      last4: account.last4 ?? null,
      last5: account.last5 ?? null,
      status: account.status,
      product: product
        ? {
          id: product.id,
          name: product.name,
          shortName: product.shortName,
          annualFeeMinor: product.annualFeeMinor,
          feeVerify: product.feeVerify === true,
          sourceUrl: product.sourceUrl,
        }
        : null,
      productSource: source,
      productChoice: settings?.productChoice ?? 'auto',
      anniversaryMonth,
      needsAnniversary: benefits.some((benefit) => benefit.needsAnniversary),
      benefits,
      issuerTrackers: cardTrackers
        .filter((tracker) => !mapped.has(tracker))
        .sort((a, b) => a.issuerBenefitId.localeCompare(b.issuerBenefitId) || b.periodStart.localeCompare(a.periodStart))
        .map((tracker) => issuerFigure(tracker, today)),
      totals,
    };
  });

  reminders.sort((a, b) => a.daysLeft - b.daysLeft || (b.remainingMinor ?? 0) - (a.remainingMinor ?? 0)
    || a.cardAccountId.localeCompare(b.cardAccountId) || a.benefitId.localeCompare(b.benefitId));
  return {
    catalogVersion: catalog.version,
    year,
    today,
    cards,
    household,
    resetsSoon: reminders,
    products: catalog.products.map((product) => ({ id: product.id, issuer: product.issuer, name: product.name, shortName: product.shortName })),
  };
}
