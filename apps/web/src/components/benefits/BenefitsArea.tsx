import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  BenefitPeriodView,
  BenefitView,
  CardBenefitsCardView,
  CardBenefitsReport,
  CardOwner,
} from '@finance-tracker/shared';

import { usePortfolioPref } from '../../hooks/usePortfolioPref';
import { Disclosure, FOLD_AFTER } from '../Disclosure';
import { ChevronRight } from '../icons';
import { apiErrorMessage } from '../spending/spendingApi';
import { OWNERS, OWNER_LABELS, issuerLabel, todayIso } from '../spending/spendingFormat';
import {
  BENEFIT_SECTIONS,
  benefitCardOrder,
  comparisonName,
  groupCardsByBenefit,
  groupTags,
  groupYearNotes,
  issuerTrackerGroups,
  missingByOwner,
  missingProductLabel,
  normalizeBenefitName,
  sectionYear,
  type BenefitGroup,
  type BenefitSection,
  type BenefitTag,
} from './benefitGroups';
import { clearBenefitMark, fetchBenefitsReport, saveBenefitMark, saveBenefitSettings } from './benefitsApi';
import {
  benefitUsage,
  cardUsageSnapshot,
  groupNow,
  historyIndex,
  memberKey,
  rankCardBenefits,
  rankedTiers,
  rankingFingerprint,
  usageSnapshot,
  usageWindow,
  type GroupNow,
  type GroupUsage,
  type UsageSnapshot,
  type UsageWindow,
} from './benefitUsage';
import {
  MONTH_NAMES,
  SETUP_WHY,
  UNVERIFIED_TITLE,
  annualFeesText,
  cardEndingLabel,
  cardTitle,
  creditsMinusFeesText,
  creditsUsedNote,
  currentLine,
  daysLeftLabel,
  feeCoverage,
  formatBenefitAmount,
  formatBenefitUsd,
  groupBenefitCards,
  manualReasonLabel,
  missingCountText,
  notCountedYetText,
  periodCellLabel,
  periodFill,
  periodRange,
  reminderDeadline,
  reminderLeft,
  setupReason,
  setupSummaryText,
  shortDate,
  sourceLabel,
  unknownUseOf,
  unknownUseText,
  usageTierText,
  usedFraction,
  usedOfAvailable,
} from './benefitsFormat';

/** By benefit (the default): one group per benefit across the cards. By card: issuer, person, then each card's benefits. */
type BenefitsView = 'benefit' | 'card';
const BENEFITS_VIEWS: ReadonlyArray<{ id: BenefitsView; label: string }> = [
  { id: 'benefit', label: 'By benefit' },
  { id: 'card', label: 'By card' },
];
const isBenefitsView = (value: unknown): value is BenefitsView => value === 'benefit' || value === 'card';

/** By benefit's order: the most used first (the default), or by category, as card communities list credits. */
type BenefitsOrder = 'used' | 'category';
const BENEFITS_ORDERS: ReadonlyArray<{ id: BenefitsOrder; label: string }> = [
  { id: 'used', label: 'Most used' },
  { id: 'category', label: 'By category' },
];
const isBenefitsOrder = (value: unknown): value is BenefitsOrder => value === 'used' || value === 'category';

/**
 * Last year's report, for "Most used" in this year's view (its trailing 12 months reach into last year): only for
 * ranking, never shown. `failed` ranks on this year alone, and the view says so.
 */
type BenefitsHistory = { key: string; cards: CardBenefitsCardView[] } | { key: string; failed: true };
type HistoryStatus = { status: 'none' | 'loading' | 'failed' } | { status: 'ok'; cards: CardBenefitsCardView[] };

/** A "Use before it resets" link's benefit: the By benefit view opens its group if it is folded, then goes to its row. */
interface BenefitTarget {
  cardAccountId: string;
  benefitId: string;
  nonce: number;
  /** The view it was followed in: only that view goes to it, and only once. */
  view: BenefitsView;
  /** What had the focus when it was followed: once the focus moved on, the page is not taken to the row. */
  focus: Element | null;
}

/**
 * A value set once per fingerprint and kept while the fingerprint stays the same: the use the benefits were ranked by
 * when the view opened, which marking a period does not change (rankingFingerprint), so nothing moves under the
 * period being marked. Null while there is no fingerprint (no ranking, or last year's report still coming).
 */
function useFrozen<T>(fingerprint: string | null, compute: () => T): T | null {
  const [frozen, setFrozen] = useState<{ fingerprint: string; value: T } | null>(null);
  if (fingerprint === null) {
    if (frozen !== null) setFrozen(null);
    return null;
  }
  if (frozen?.fingerprint === fingerprint) return frozen.value;
  const value = compute();
  setFrozen({ fingerprint, value });
  return value;
}

/**
 * The Benefits area of Everyday: what each card's product gives back each
 * period and how much of it was used, for a year ("每年的进展"), with what to
 * use before it resets and the household's totals against its annual fees.
 * By benefit (the default) groups the cards under each benefit, with the
 * cards that lack it; By card lists each card's benefits. Figures come from
 * the issuer when it reported them, else from the owner's marks, else from
 * posted statement credits; each says which.
 */
export function BenefitsArea({ writesDisabled, onOpenTransaction }: {
  writesDisabled: boolean;
  /** Opens a matched transaction's details. */
  onOpenTransaction: (id: string) => void;
}) {
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [owner, setOwner] = useState<CardOwner | ''>('');
  const [view, setView] = usePortfolioPref<BenefitsView>('benefits-view', 'benefit', isBenefitsView);
  const [order, setOrder] = usePortfolioPref<BenefitsOrder>('benefits-order', 'used', isBenefitsOrder);
  const [report, setReport] = useState<CardBenefitsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [showClosed, setShowClosed] = useState(false);
  const [history, setHistory] = useState<BenefitsHistory | null>(null);
  const [target, setTarget] = useState<BenefitTarget | null>(null);
  // A year still to come has no use to rank: it is listed by category, and the order switch is not offered. Most used
  // orders both views: By benefit's groups, and By card each card's benefits.
  const rankWindow = usageWindow(year, today);
  const ranking = order === 'used' && rankWindow !== null;
  const needsHistory = ranking && rankWindow.trailing;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchBenefitsReport(year, today)
      .then((body) => {
        if (cancelled) return;
        setReport(body);
        setError(null);
      })
      .catch((reason: unknown) => { if (!cancelled) setError(apiErrorMessage(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [year, today, version]);

  // Last year's report, read again after a change (as this year's is), keeping the one it has meanwhile: a failure
  // after a success keeps the success, so nothing moves while a period is being marked. A failure stays until the year
  // or the day changes, or the page opens again: read again after a mark and answered, it would set the order again
  // under the period being marked.
  useEffect(() => {
    if (!needsHistory) return undefined;
    const key = `${year - 1}|${today}`;
    if (history !== null && history.key === key && 'failed' in history) return undefined;
    let cancelled = false;
    fetchBenefitsReport(year - 1, today)
      .then((body) => { if (!cancelled) setHistory({ key, cards: body.cards }); })
      .catch(() => {
        if (!cancelled) setHistory((now) => (now && now.key === key && 'cards' in now ? now : { key, failed: true }));
      });
    return () => { cancelled = true; };
  }, [needsHistory, year, today, version]);
  const historyStatus: HistoryStatus = !needsHistory ? { status: 'none' }
    : history === null || history.key !== `${year - 1}|${today}` ? { status: 'loading' }
      : 'cards' in history ? { status: 'ok', cards: history.cards } : { status: 'failed' };

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  // Only the report of the year shown, as of today, is shown or edited: while another year's answer is still
  // coming, or after it failed, nothing of the year before stays on screen to be marked by mistake.
  const shownReport = report !== null && report.year === year && report.today === today ? report : null;
  const shown = useMemo(() => (shownReport?.cards ?? []).filter((card) => !owner || card.owner === owner), [shownReport, owner]);
  const active = useMemo(() => shown.filter((card) => card.status === 'active'), [shown]);
  const closed = useMemo(() => shown.filter((card) => card.status === 'closed'), [shown]);
  const totals = shownReport ? (owner ? shownReport.household.byOwner[owner] : shownReport.household) : null;
  const cardById = useMemo(() => new Map((shownReport?.cards ?? []).map((card) => [card.cardAccountId, card])), [shownReport]);
  const reminders = (shownReport?.resetsSoon ?? []).filter((reminder) => !owner || cardById.get(reminder.cardAccountId)?.owner === owner);
  // By card, most used first: each card's benefits ranked by the use there was when the order was set (useFrozen), so a
  // mark moves no row.
  const historyCards = historyStatus.status === 'ok' ? historyStatus.cards : null;
  const historyMap = useMemo(() => historyIndex(historyCards ?? []), [historyCards]);
  const byCardFingerprint = view === 'card' && ranking && rankWindow && historyStatus.status !== 'loading'
    ? rankingFingerprint(active.map((card) => ({ key: card.cardAccountId, members: card.benefits.map((benefit) => ({ card, benefit })) })), historyCards, rankWindow)
    : null;
  const byCardUsage = useFrozen(byCardFingerprint, () => cardUsageSnapshot(active, historyMap, rankWindow!));
  const cardBenefits = (card: CardBenefitsCardView): BenefitView[] => (byCardUsage && rankWindow
    ? rankCardBenefits(card, (benefit): GroupUsage => byCardUsage.get(memberKey(card, benefit)) ?? benefitUsage(card, benefit, historyMap, rankWindow))
    : card.benefits);
  // A reminder followed By card: the page goes to its row once the row is drawn (while last year's report is read, the
  // cards wait), once, and only if the focus has not moved on since. One followed By benefit is not, here or later.
  const cardRowsDrawn = view === 'card' && shownReport !== null && !(ranking && historyStatus.status === 'loading');
  const cardFollowed = useRef(0);
  useEffect(() => {
    if (!target || target.nonce === cardFollowed.current) return;
    if (target.view !== 'card' || view !== 'card') {
      cardFollowed.current = target.nonce;
      return;
    }
    if (!cardRowsDrawn) return;
    cardFollowed.current = target.nonce;
    if (document.activeElement === target.focus) goToBenefit(target);
  }, [target, view, cardRowsDrawn]);

  return (
    <div className="benefits" aria-busy={loading}>
      <div className="spending-toolbar benefits-toolbar">
        <div className="spending-when">
          <div className="spending-month" role="group" aria-label="Year">
            <button type="button" className="spending-icon-button" aria-label="Previous year" onClick={() => setYear((value) => value - 1)}>
              <ChevronRight size={14} className="flip" />
            </button>
            <span className="spending-month-label" aria-live="polite">{year}</span>
            <button
              type="button"
              className="spending-icon-button"
              aria-label="Next year"
              disabled={year >= thisYear + 1}
              onClick={() => setYear((value) => value + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="spending-periods benefits-views" role="group" aria-label="Group by">
            {BENEFITS_VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`spending-period${view === item.id ? ' active' : ''}`}
                aria-pressed={view === item.id}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {rankWindow !== null ? (
            <div className="spending-periods benefits-views benefits-order" role="group" aria-label="Order">
              {BENEFITS_ORDERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`spending-period${order === item.id ? ' active' : ''}`}
                  aria-pressed={order === item.id}
                  onClick={() => setOrder(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <label className="spending-select">
          <span>Person</span>
          <select value={owner} onChange={(event) => setOwner(event.target.value as CardOwner | '')}>
            <option value="">Everyone</option>
            {OWNERS.map((value) => <option key={value} value={value}>{OWNER_LABELS[value]}</option>)}
          </select>
        </label>
      </div>

      {error ? <div className="spending-error" role="alert">{error}</div> : null}
      {!shownReport && loading && !error ? <p className="spending-muted" role="status">Loading {year}…</p> : null}

      {/* What to use now comes first: each benefit, what is left (or that its use is unknown), by when, on which card;
          the year's figures follow. */}
      {shownReport && year === thisYear && reminders.length > 0 ? (
        <section className="spending-panel benefits-reminders" aria-labelledby="benefits-reminders-title">
          <header className="spending-panel-head">
            <h3 id="benefits-reminders-title">Use before it resets</h3>
            <span className="spending-muted">{reminders.length} {reminders.length === 1 ? 'benefit resets' : 'benefits reset'} soon</span>
          </header>
          <ul className="benefits-reminder-list">
            {reminders.map((reminder) => {
              const card = cardById.get(reminder.cardAccountId);
              const benefit = card?.benefits.find((entry) => entry.id === reminder.benefitId);
              if (!card || !benefit) return null;
              const left = reminderLeft(benefit, reminder);
              const deadline = reminderDeadline(reminder, today);
              const cardLine = `${[cardTitle(card), cardEndingLabel(card)].filter(Boolean).join(' ')} · ${OWNER_LABELS[card.owner]}`;
              return (
                <li key={`${reminder.cardAccountId}:${reminder.benefitId}`} data-days={reminder.daysLeft}>
                  <a
                    className="benefits-reminder"
                    href={`#${benefitAnchor(card.cardAccountId, benefit.id)}`}
                    // Its parts in the order shown, a pause between each where the layout sets them apart.
                    aria-label={[benefit.name, left.why === null ? left.text : `${left.text} · ${left.why}`, deadline, cardLine].join(', ')}
                    onClick={(event) => {
                      event.preventDefault();
                      // By benefit opens the benefit's group first if it is folded; By card goes straight to the row. Either
                      // goes there once the row is drawn, if the focus is still where it was now.
                      const focus = document.activeElement;
                      setTarget((last) => ({ cardAccountId: card.cardAccountId, benefitId: benefit.id, nonce: (last?.nonce ?? 0) + 1, view, focus }));
                    }}
                  >
                    <span className="benefits-reminder-name">{benefit.name}</span>
                    <span className="benefits-reminder-left num" data-unknown={left.why === null ? undefined : 'true'}>
                      {left.text}
                      {left.why === null ? null : <span className="benefits-reminder-why"> · {left.why}</span>}
                    </span>
                    <span className="benefits-reminder-deadline num" data-urgent={reminder.daysLeft <= 3}>{deadline}</span>
                    <span className="benefits-reminder-card">{cardLine}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {shownReport && totals ? (
        <HouseholdSummary report={shownReport} totals={totals} owner={owner} thisYear={thisYear} />
      ) : null}

      {shownReport && shown.length === 0 ? (
        <div className="spending-empty" role="status">
          <strong>No cards yet</strong>
          <p>Card accounts appear here once they are added in Card transactions.</p>
        </div>
      ) : null}

      {shownReport && view === 'benefit' && active.length > 0 ? (
        <BenefitGroupsView
          cards={active}
          report={shownReport}
          today={today}
          showOwners={!owner}
          ranking={ranking && rankWindow ? { window: rankWindow, history: historyStatus } : null}
          target={target}
          writesDisabled={writesDisabled}
          onChanged={refresh}
          onError={setError}
          onOpenTransaction={onOpenTransaction}
        />
      ) : null}

      {view === 'card' && ranking && historyStatus.status === 'loading' && active.length > 0 ? (
        <p className="spending-muted" role="status">Ordering by use…</p>
      ) : null}
      {view === 'card' && ranking && historyStatus.status === 'failed' ? <HistoryFailedNote year={year} /> : null}
      {view === 'card' && !(ranking && historyStatus.status === 'loading') ? groupBenefitCards(active).map((group) => (
        <section key={group.issuer} className="benefits-issuer" aria-labelledby={`benefits-issuer-${group.issuer}`}>
          <h3 id={`benefits-issuer-${group.issuer}`} className="benefits-issuer-title">{group.label}</h3>
          {group.owners.map(({ owner: person, cards }) => (
            <div key={person} className="benefits-owner" data-owner={person}>
              <h4 className="benefits-owner-title">{OWNER_LABELS[person]}</h4>
              <div className="benefits-card-list">
                {cards.map((card) => (
                  <BenefitCard
                    key={card.cardAccountId}
                    card={card}
                    benefits={cardBenefits(card)}
                    report={shownReport!}
                    year={shownReport!.year}
                    today={today}
                    writesDisabled={writesDisabled}
                    onChanged={refresh}
                    onError={setError}
                    onOpenTransaction={onOpenTransaction}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )) : null}

      {closed.length > 0 ? (
        <section className="benefits-closed" aria-label="Closed cards">
          <button type="button" className="spending-link" aria-expanded={showClosed} onClick={() => setShowClosed((value) => !value)}>
            {showClosed ? 'Hide' : 'Show'} {closed.length} closed {closed.length === 1 ? 'card' : 'cards'}
          </button>
          {showClosed ? (
            <div className="benefits-card-list">
              {closed.map((card) => (
                <BenefitCard
                  key={card.cardAccountId}
                  card={card}
                  report={shownReport!}
                  year={shownReport!.year}
                  today={today}
                  writesDisabled={writesDisabled}
                  onChanged={refresh}
                  onError={setError}
                  onOpenTransaction={onOpenTransaction}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {shownReport ? (
        <p className="spending-muted benefits-footnote">
          Credits used are what the issuer reported, what you marked, or the statement credits matched to a benefit.
          Totals count dollar credits of open cards; certificates and once-every-few-years credits are
          {view === 'card' ? ' shown on each card.'
            : ranking ? ' listed by their use too, the once-every-few-years ones under Occasional, with figures of their own.'
              : ' listed after the credits of their section, with figures of their own.'}
          {ranking ? ' The order is kept while you mark periods, and set again when the page is opened.' : null}
          {' '}Benefits catalog {shownReport.catalogVersion}, from the issuers&apos; public benefit pages; amounts marked unverified
          are still to be confirmed there.
        </p>
      ) : null}
    </div>
  );
}

const benefitAnchor = (cardAccountId: string, benefitId: string) => `benefit-${cardAccountId}-${benefitId}`;

/** Brings a benefit's row into view and moves the focus to it, as following a link within the page does. */
function goToBenefit(target: Pick<BenefitTarget, 'cardAccountId' | 'benefitId'>): void {
  const row = document.getElementById(benefitAnchor(target.cardAccountId, target.benefitId));
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.focus({ preventScroll: true });
}

/** Most used without last year's report: the order counts this year alone, and says so (either view). */
function HistoryFailedNote({ year }: { year: number }) {
  return (
    <p className="spending-muted benefits-rank-note" data-history-failed>
      Ordered by {year} alone: last year&apos;s benefits could not be read, so use before January is not counted.
    </p>
  );
}

/**
 * The By benefit view's sections, in the order card communities' credit
 * checklists use: airlines and other travel, hotels, dining, then everything
 * else, with business services apart.
 */
const SECTION_LABELS: Record<BenefitSection, { title: string; note: string }> = {
  travel: { title: 'Travel', note: 'Airlines, airport programs, rides and car rentals' },
  hotel: { title: 'Hotels', note: 'Hotel credits, stays and free nights' },
  dining: { title: 'Dining', note: 'Restaurants, delivery and Uber' },
  shopping: { title: 'Shopping and lifestyle', note: 'Stores, memberships, fitness and streaming' },
  business: { title: 'Business', note: 'Software, hardware, phone service and hiring' },
  other: { title: 'Other', note: 'Benefits the catalog files under no category' },
};

/**
 * By benefit: one group per benefit across the open cards shown, by section,
 * each card that has it with its own periods and figures, and the compared
 * cards that do not. Cards whose product is unknown, or that need an
 * anniversary month, are set up first. Most used lists the groups by tier
 * instead (benefitUsage.ts), the most used first, and folds those with no
 * recorded use to a line each.
 */
function BenefitGroupsView({ cards, report, today, showOwners, ranking, target, writesDisabled, onChanged, onError, onOpenTransaction }: {
  cards: CardBenefitsCardView[];
  report: CardBenefitsReport;
  today: string;
  /** Everyone is shown: say whose each card is. */
  showOwners: boolean;
  /** Most used: the window use is counted in, and last year's report for it; null lists by category. */
  ranking: { window: UsageWindow; history: HistoryStatus } | null;
  /** A reminder's benefit to go to: its group is opened first when it is folded. */
  target: BenefitTarget | null;
  writesDisabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const grouping = useMemo(() => groupCardsByBenefit(cards, today), [cards, today]);
  const trackers = useMemo(() => issuerTrackerGroups(cards), [cards]);
  // Cards to choose a product for (not those set to track nothing), and cards whose benefits need the anniversary month.
  const setup = useMemo(() => benefitCardOrder(cards)
    .filter((card) => (card.product === null && card.productChoice !== 'none') || card.needsAnniversary), [cards]);

  // Most used: ranked by the use there was when the order was set, kept until the groups, their cards' placing, the
  // window or last year's report change (rankingFingerprint), so marking a period moves nothing on the page.
  const historyCards = ranking?.history.status === 'ok' ? ranking.history.cards : null;
  const history = useMemo(() => historyIndex(historyCards ?? []), [historyCards]);
  const fingerprint = ranking && ranking.history.status !== 'loading'
    ? rankingFingerprint(grouping.groups, historyCards, ranking.window) : null;
  const snapshot: UsageSnapshot | null = useFrozen(fingerprint, () => usageSnapshot(grouping.groups, history, ranking!.window));
  const tiers = ranking && snapshot ? rankedTiers(grouping.groups, snapshot, history, ranking.window) : null;

  // Folded groups (no recorded use) the owner opened, or a reminder did.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const setGroupOpen = useCallback((key: string, open: boolean) => setOpened((keys) => {
    if (keys.has(key) === open) return keys;
    const next = new Set(keys);
    if (open) next.add(key);
    else next.delete(key);
    return next;
  }), []);
  // A reminder's benefit: its group opens (if it is folded), and once its row is drawn the page goes to it: at once, or
  // when the order waiting for last year's report is set, if the focus has not moved on since. Only a reminder followed
  // while this view is open: not one followed By card before it was.
  const followed = useRef(target?.nonce ?? 0);
  const [arriving, setArriving] = useState<BenefitTarget | null>(null);
  useEffect(() => {
    if (!target || target.nonce === followed.current) return;
    followed.current = target.nonce;
    const group = grouping.groups.find(({ members }) => members.some(({ card, benefit }) =>
      card.cardAccountId === target.cardAccountId && benefit.id === target.benefitId));
    if (group) setGroupOpen(group.key, true);
    setArriving(target);
  }, [target]);
  const drawn = !(ranking && ranking.history.status === 'loading');
  useEffect(() => {
    if (!arriving || !drawn) return;
    if (document.activeElement === arriving.focus) goToBenefit(arriving);
    setArriving(null);
  }, [arriving, drawn]);

  const groupPanel = (group: BenefitGroup, folded: boolean) => (
    <BenefitGroupPanel
      key={group.key}
      group={group}
      comparedCount={grouping.compared.length}
      year={report.year}
      today={today}
      showOwners={showOwners}
      fold={folded ? {
        open: opened.has(group.key),
        onOpenChange: (open) => setGroupOpen(group.key, open),
        now: ranking?.window.trailing ? groupNow(group) : null,
      } : undefined}
      writesDisabled={writesDisabled}
      onChanged={onChanged}
      onError={onError}
      onOpenTransaction={onOpenTransaction}
    />
  );
  return (
    <>
      {setup.length > 0 ? (
        <section className="spending-panel benefits-setup" aria-labelledby="benefits-setup-title">
          <header className="spending-panel-head">
            <h3 id="benefits-setup-title">Cards to set up</h3>
            <span className="spending-muted">{setup.length} {setup.length === 1 ? 'card' : 'cards'}</span>
          </header>
          {/* Folded behind one line once it is long, so the benefits come first; open when nothing can be compared yet. */}
          <Disclosure
            className="benefits-setup-fold"
            summary={setupSummaryText(setup)}
            defaultOpen={setup.length <= FOLD_AFTER || grouping.compared.length === 0}
          >
            <p className="spending-muted benefits-setup-why">{SETUP_WHY}</p>
            <ul className="benefits-setup-list">
              {setup.map((card) => (
                <CardSetup key={card.cardAccountId} card={card} report={report} writesDisabled={writesDisabled} onChanged={onChanged} onError={onError} />
              ))}
            </ul>
          </Disclosure>
        </section>
      ) : null}

      {grouping.notTracked.length > 0 ? (
        <p className="spending-muted benefits-untracked" data-not-tracked>
          Set to track no benefits, so not compared:{' '}
          {grouping.notTracked
            .map((card) => [cardTitle(card), cardEndingLabel(card), showOwners ? `(${OWNER_LABELS[card.owner]})` : ''].filter(Boolean).join(' '))
            .join(', ')}
        </p>
      ) : null}

      {grouping.groups.length === 0 ? (
        <p className="spending-muted" role="status">
          {grouping.compared.length > 0
            ? `None of these cards has a benefit to track in ${report.year}.`
            : grouping.unknown.length > 0 ? 'No card here has a known product to compare yet.' : 'No card here tracks benefits.'}
        </p>
      ) : null}

      {ranking && ranking.history.status === 'loading' && grouping.groups.length > 0 ? (
        <p className="spending-muted" role="status">Ordering by use…</p>
      ) : null}
      {ranking && ranking.history.status === 'failed' ? <HistoryFailedNote year={report.year} /> : null}

      {tiers && ranking ? tiers.map(({ tier, groups }) => {
        const { title, note } = usageTierText(tier, ranking.window, report.year);
        const total = sectionYear(groups);
        return (
          <section key={tier} className="benefits-section benefits-tier" data-tier={tier} aria-labelledby={`benefits-tier-${tier}`}>
            <header className="benefits-section-head">
              <h3 id={`benefits-tier-${tier}`} className="benefits-issuer-title">{title}</h3>
              <span className="spending-muted">{note}</span>
              {total ? (
                <span className="benefits-section-figure num" data-section-year>
                  {usedOfAvailable({ unit: 'usd' }, total.capturedMinor, total.availableMinor)} in {report.year}
                </span>
              ) : null}
            </header>
            <div className="benefits-group-list">
              {groups.map((group) => groupPanel(group, tier === 'unused'))}
            </div>
          </section>
        );
      }) : null}

      {ranking ? null : BENEFIT_SECTIONS.map((section) => {
        const groups = grouping.groups.filter((group) => group.section === section);
        if (groups.length === 0) return null;
        const { title, note } = SECTION_LABELS[section];
        const total = sectionYear(groups);
        return (
          <section key={section} className="benefits-section" data-section={section} aria-labelledby={`benefits-section-${section}`}>
            <header className="benefits-section-head">
              <h3 id={`benefits-section-${section}`} className="benefits-issuer-title">{title}</h3>
              <span className="spending-muted">{note}</span>
              {total ? (
                <span className="benefits-section-figure num" data-section-year>
                  {usedOfAvailable({ unit: 'usd' }, total.capturedMinor, total.availableMinor)} in {report.year}
                </span>
              ) : null}
            </header>
            <div className="benefits-group-list">
              {groups.map((group) => groupPanel(group, false))}
            </div>
          </section>
        );
      })}

      {trackers.length > 0 ? (
        <section className="spending-panel benefits-trackers" aria-labelledby="benefits-trackers-title">
          <header className="spending-panel-head">
            <h3 id="benefits-trackers-title">Reported by the issuer, not in the catalog</h3>
          </header>
          {trackers.map((group) => (
            <div key={group.key} className="benefits-issuer-trackers">
              <h6>{group.name}</h6>
              <ul>
                {group.entries.map(({ card, tracker }, index) => (
                  <li key={`${card.cardAccountId}:${tracker.observedAt}:${index}`} data-card={card.cardAccountId}>
                    <span>{cardTitle(card)} <span className="benefits-ending num">{cardEndingLabel(card)}</span></span>
                    <span className="num">
                      {tracker.usedMinor === null ? '—' : tracker.usedMinor} of {tracker.totalMinor === null ? '—' : tracker.totalMinor}
                    </span>
                    <span className="benefits-source" data-source="issuer">
                      as of {shortDate(tracker.observedAt.slice(0, 10), today)}{tracker.stale ? ' (stale)' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

function CardSetup({ card, report, writesDisabled, onChanged, onError }: {
  card: CardBenefitsCardView;
  report: CardBenefitsReport;
  writesDisabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const titleId = useId();
  const reason = setupReason(card);
  // One row per card: who it is and what it needs, then its choices; why is said once, above the list.
  return (
    <li className="benefits-setup-card" data-card={card.cardAccountId} aria-labelledby={titleId}>
      <div className="benefits-card-name">
        <h5 id={titleId}>
          {cardTitle(card)} <span className="benefits-ending num">{cardEndingLabel(card)}</span>
        </h5>
        <p className="spending-muted">
          {OWNER_LABELS[card.owner]} · {card.product ? card.product.name : card.nickname ?? issuerLabel(card.issuer)} · {PRODUCT_SOURCE_LABELS[card.productSource]}
        </p>
        {reason ? <p className="benefits-setup-reason">{reason}</p> : null}
      </div>
      <CardSettings card={card} report={report} writesDisabled={writesDisabled} onSaved={onChanged} onError={onError} compact />
    </li>
  );
}

function BenefitGroupPanel({ group, comparedCount, year, today, showOwners, fold, writesDisabled, onChanged, onError, onOpenTransaction }: {
  group: BenefitGroup;
  /** How many cards the view compares: those that have the benefit and those that do not. */
  comparedCount: number;
  year: number;
  today: string;
  showOwners: boolean;
  /**
   * Most used, no recorded use: one line (what its cards have left now, then the toggle for its cards), and its cards
   * under it once opened.
   */
  fold?: { open: boolean; onOpenChange: (open: boolean) => void; now: GroupNow | null };
  writesDisabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const titleId = useId();
  // Each card's own tags, by its place in the group (the members' order is the view's).
  const tags = useMemo(() => groupTags(group.members.map(({ benefit }) => benefit)), [group]);
  const figure = group.year ? usedOfAvailable(group, group.year.capturedMinor, group.year.availableMinor) : null;
  const notes = groupYearNotes(group);
  const partlyUnknown = (group.year?.unknownPeriods ?? 0) > 0;
  const onCards = `On ${group.cardCount} of ${comparedCount} ${comparedCount === 1 ? 'card' : 'cards'}`;
  const body = (
    <>
      {group.note ? <p className="benefits-group-note">{group.note}</p> : null}
      {group.year && group.year.availableMinor > 0 ? (
        <Meter
          fraction={usedFraction(group.year.capturedMinor, group.year.availableMinor)}
          label={[`${figure} used in ${year}`, ...notes].join(', ')}
          unknown={partlyUnknown}
        />
      ) : null}
      <ul className="benefits-list" aria-label={`Cards with ${group.name}`}>
        {group.members.map(({ card, benefit }, index) => (
          <BenefitRow
            key={`${card.cardAccountId}:${benefit.id}`}
            card={card}
            benefit={benefit}
            year={year}
            today={today}
            member={{ groupName: group.name, ownTags: tags.own[index], showOwner: showOwners, showNote: group.note === undefined }}
            writesDisabled={writesDisabled}
            onChanged={onChanged}
            onError={onError}
            onOpenTransaction={onOpenTransaction}
          />
        ))}
      </ul>
      {group.missing.length > 0 ? (
        // The compared cards without it fold behind their count once the list is long (it names nearly every card).
        <Disclosure
          className="benefits-missing-fold"
          defaultOpen={group.missing.length <= FOLD_AFTER}
          summary={(
            <>
              <span className="benefits-missing-label">Without it in {year}</span>
              <span className="benefits-missing-count">{missingCountText(group.missing.length, comparedCount)}</span>
            </>
          )}
        >
          <MissingCards cards={group.missing} year={year} showOwners={showOwners} />
        </Disclosure>
      ) : null}
    </>
  );
  return (
    <section className="benefits-group" data-kind={group.kind} data-foldable={fold ? 'true' : undefined} aria-labelledby={titleId}>
      <header className="benefits-group-head">
        <div className="benefits-group-name">
          <h4 id={titleId}>{group.name}</h4>
          {group.sharedTags.length > 0 ? <BenefitTags tags={group.sharedTags} /> : null}
        </div>
        <div className="benefits-group-totals">
          {fold?.now ? (
            <>
              <span className="num" data-group-left>{formatBenefitAmount(group, fold.now.leftMinor)} left now</span>
              <span className="spending-muted" data-group-days>{daysLeftLabel(fold.now.daysLeft)}</span>
            </>
          ) : group.year && !(group.year.availableMinor === 0 && group.unplaced > 0) ? (
            // A year of cards none of which is placed yet says nothing: its note says why.
            <span className="num" data-group-year>{figure} in {year}</span>
          ) : null}
          {notes.map((note) => <span key={note} className="spending-muted" data-group-note>{note}</span>)}
          {group.availableNow !== null ? (
            <span className="num" data-group-available>Available now on {group.availableNow} of {group.cardCount}</span>
          ) : null}
          {fold ? null : <span className="spending-muted" data-group-cards>{onCards}</span>}
        </div>
      </header>
      {fold ? (
        <Disclosure className="benefits-group-fold" open={fold.open} onOpenChange={fold.onOpenChange} summary={<span data-group-cards>{onCards}</span>}>
          {body}
        </Disclosure>
      ) : body}
    </section>
  );
}

/** The compared cards that do not have a benefit in the year, by person, then by product with each card's ending. */
function MissingCards({ cards, year, showOwners }: { cards: CardBenefitsCardView[]; year: number; showOwners: boolean }) {
  return (
    <div className="benefits-missing">
      <ul className="benefits-missing-list" aria-label={`Without it in ${year}`}>
        {missingByOwner(cards).map(({ owner: person, products }) => (
          <li key={person} className="benefits-missing-owner" data-owner={person}>
            {showOwners ? (
              <span className="benefits-missing-person" data-owner={person}>
                <span className="benefits-owner-dot" aria-hidden />
                {OWNER_LABELS[person]}
              </span>
            ) : null}
            <ul>
              {products.map((product) => (
                <li key={product.key} className="benefits-missing-card" data-cards={product.cards.map((card) => card.cardAccountId).join(' ')}>
                  {missingProductLabel(product)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BenefitTags({ tags }: { tags: readonly BenefitTag[] }) {
  return (
    <span className="benefits-tags">
      {tags.map((tag) => (
        <span key={tag.key} className="benefits-tag" data-tone={tag.tone} title={tag.title}>{tag.label}</span>
      ))}
    </span>
  );
}

/**
 * The year's figures, after what to use now: the credits used (as the issuer reported them, as marked, or from
 * statement credits) against what was available, with the periods whose use nobody knows yet said apart, never as $0;
 * then, quieter, the annual fees and the credits used minus them, a difference rather than a saving; then each person.
 */
function HouseholdSummary({ report, totals, owner, thisYear }: {
  report: CardBenefitsReport;
  totals: CardBenefitsReport['household'] | CardBenefitsReport['household']['byOwner'][CardOwner];
  owner: CardOwner | '';
  thisYear: number;
}) {
  const { year } = report;
  const share = usedFraction(totals.capturedMinor, totals.availableMinor);
  const who = owner ? OWNER_LABELS[owner] : 'Household';
  // The totals' own scope: open cards (and the person chosen).
  const open = report.cards.filter((card) => card.status === 'active');
  const unknownFor = (person: CardOwner | '') => unknownUseOf(open.filter((card) => !person || card.owner === person));
  const unknown = unknownFor(owner);
  const notCounted = notCountedYetText(open.filter((card) => !owner || card.owner === owner));
  const periodsText = (count: number) => `${count} ${count === 1 ? 'period' : 'periods'}`;
  const people = owner ? [] : OWNERS.filter((person) => report.household.byOwner[person].availableMinor > 0
    || report.household.byOwner[person].annualFeesMinor > 0);
  return (
    <section className="spending-panel benefits-summary" aria-labelledby="benefits-summary-title">
      <header className="spending-panel-head">
        <h3 id="benefits-summary-title">{who} · {year}{year === thisYear ? ' so far' : ''}</h3>
      </header>
      <div className="benefits-figure" data-figure="used">
        <span className="benefits-figure-label">Credits used</span>
        <strong className="benefits-figure-value num">{formatBenefitUsd(totals.capturedMinor)}</strong>
        <span className="benefits-figure-note">{creditsUsedNote(totals, year)}</span>
      </div>
      {totals.availableMinor > 0 ? (
        <Meter
          fraction={share}
          label={`${Math.round(share * 100)}% of available credits used${unknown.periods > 0 ? `; use unknown for ${periodsText(unknown.periods)}` : ''}`}
          unknown={unknown.periods > 0}
        />
      ) : null}
      {unknown.periods > 0 ? (
        <p className="benefits-summary-unknown" data-figure="unknown">
          <strong>Use unknown:</strong> {unknownUseText(unknown)}, not counted in credits used.
        </p>
      ) : null}
      {notCounted ? (
        <p className="benefits-summary-unknown" data-figure="not-counted">
          <strong>Not counted yet:</strong> {notCounted}.
        </p>
      ) : null}
      <div className="benefits-summary-fees">
        <p data-figure="fees">{annualFeesText(totals)}</p>
        {totals.annualFeesMinor > 0 ? <p data-figure="net">{creditsMinusFeesText(totals)}</p> : null}
      </div>
      {people.length > 0 ? (
        <ul className="benefits-owner-totals" aria-label="By person">
          {people.map((person) => {
            const part = report.household.byOwner[person];
            const theirs = unknownFor(person);
            return (
              <li key={person} data-owner={person}>
                <span className="benefits-owner-name" data-owner={person}>
                  <span className="benefits-owner-dot" aria-hidden />
                  {OWNER_LABELS[person]}
                </span>
                <span className="benefits-owner-figures num">
                  {formatBenefitUsd(part.capturedMinor)} of {formatBenefitUsd(part.availableMinor)} used
                  {theirs.periods > 0 ? <span data-owner-unknown> · use unknown for {periodsText(theirs.periods)}</span> : null}
                  <span className="benefits-owner-fees"> · fees {formatBenefitUsd(part.annualFeesMinor)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** A filled bar; `unknown`: some of what it measures has no figure yet, so its track is hatched. */
function Meter({ fraction, label, tone, unknown }: { fraction: number; label: string; tone?: 'over'; unknown?: boolean }) {
  return (
    <span className="benefits-meter" role="img" aria-label={label} data-tone={tone} data-unknown={unknown ? 'true' : undefined}>
      <span style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
    </span>
  );
}

const PRODUCT_SOURCE_LABELS: Record<CardBenefitsCardView['productSource'], string> = {
  auto: 'Product from the card\'s name',
  manual: 'Product chosen by you',
  none: 'No product chosen',
  missing: 'The chosen product is no longer in the catalog',
};

function BenefitCard({ card, benefits = card.benefits, report, year, today, writesDisabled, onChanged, onError, onOpenTransaction }: {
  card: CardBenefitsCardView;
  /** Its benefits in the order the view lists them (Most used); the report's own order by default. */
  benefits?: readonly BenefitView[];
  report: CardBenefitsReport;
  year: number;
  today: string;
  writesDisabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const titleId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fee = card.product?.annualFeeMinor ?? null;
  const coverage = feeCoverage(card.totals.capturedMinor, fee);
  const needsSetup = !card.product || card.needsAnniversary;
  const inTotals = card.product !== null && card.benefits.some((benefit) => benefit.inTotals);
  const unknown = unknownUseOf([card]);
  return (
    <article className="benefits-card" data-card={card.cardAccountId} data-product={card.product?.id ?? ''} aria-labelledby={titleId}>
      <header className="benefits-card-head">
        <div className="benefits-card-name">
          <h5 id={titleId}>
            {cardTitle(card)} <span className="benefits-ending num">{cardEndingLabel(card)}</span>
          </h5>
          <p className="spending-muted">
            {card.product ? card.product.name : card.nickname ?? issuerLabel(card.issuer)} · {PRODUCT_SOURCE_LABELS[card.productSource]}
            {card.status === 'closed' ? ' · closed' : ''}
          </p>
        </div>
        <div className="benefits-card-totals">
          {inTotals ? (
            <span className="num">
              {formatBenefitUsd(card.totals.capturedMinor)} <span className="spending-muted">of {formatBenefitUsd(card.totals.availableMinor)} used</span>
            </span>
          ) : null}
          {inTotals && unknown.periods > 0 ? (
            <span className="spending-muted" data-card-unknown>
              Use unknown for {unknown.periods} {unknown.periods === 1 ? 'period' : 'periods'}
            </span>
          ) : null}
          {fee ? (
            <span className="spending-muted num">
              Annual fee {formatBenefitUsd(fee)}{card.product?.feeVerify ? ' (unverified)' : ''}{coverage === null ? '' : ` · credits used cover ${coverage}%`}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="spending-link benefits-settings-toggle"
          aria-expanded={settingsOpen || needsSetup}
          onClick={() => setSettingsOpen((value) => !value)}
          disabled={needsSetup}
        >
          Card settings
        </button>
      </header>
      {fee && card.benefits.some((benefit) => benefit.inTotals) ? (
        <Meter
          fraction={usedFraction(Math.min(card.totals.capturedMinor, fee), fee)}
          label={`Credits used cover ${coverage ?? 0}% of the annual fee`}
          tone={card.totals.capturedMinor >= fee ? 'over' : undefined}
        />
      ) : null}
      {settingsOpen || needsSetup ? (
        <CardSettings card={card} report={report} writesDisabled={writesDisabled} onSaved={() => { setSettingsOpen(false); onChanged(); }} onError={onError} />
      ) : null}
      {!card.product ? null : card.benefits.length === 0 ? (
        <p className="spending-muted">{card.product.shortName} has no recurring credits to track.</p>
      ) : (
        <ul className="benefits-list">
          {benefits.map((benefit) => (
            <BenefitRow
              key={benefit.id}
              card={card}
              benefit={benefit}
              year={year}
              today={today}
              writesDisabled={writesDisabled}
              onChanged={onChanged}
              onError={onError}
              onOpenTransaction={onOpenTransaction}
            />
          ))}
        </ul>
      )}
      {card.issuerTrackers.length > 0 ? (
        <div className="benefits-issuer-trackers">
          <h6>Reported by {issuerLabel(card.issuer)}, not in the catalog</h6>
          <ul>
            {card.issuerTrackers.map((tracker) => (
              <li key={`${tracker.issuerBenefitId}:${tracker.observedAt}`}>
                <span>{tracker.name}</span>
                <span className="num">
                  {tracker.usedMinor === null ? '—' : tracker.usedMinor} of {tracker.totalMinor === null ? '—' : tracker.totalMinor}
                </span>
                <span className="benefits-source" data-source="issuer">
                  as of {shortDate(tracker.observedAt.slice(0, 10), today)}{tracker.stale ? ' (stale)' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function CardSettings({ card, report, writesDisabled, onSaved, onError, compact = false }: {
  card: CardBenefitsCardView;
  report: CardBenefitsReport;
  writesDisabled: boolean;
  onSaved: () => void;
  onError: (message: string | null) => void;
  /** In the list of cards to set up: the row says what is needed, so no banner repeats it on every card. */
  compact?: boolean;
}) {
  const products = report.products.filter((product) => product.issuer === card.issuer);
  const initialProduct = card.productChoice === 'manual' && card.product ? `manual:${card.product.id}` : card.productChoice;
  const [product, setProduct] = useState(initialProduct);
  const [month, setMonth] = useState(card.anniversaryMonth === null ? '' : String(card.anniversaryMonth));
  const [saving, setSaving] = useState(false);
  const productId = useId();
  const monthId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const [choice, id] = product.split(':') as ['auto' | 'manual' | 'none', string | undefined];
    saveBenefitSettings(card.cardAccountId, {
      productChoice: choice,
      ...(choice === 'manual' ? { productId: id } : {}),
      anniversaryMonth: month === '' ? null : Number(month),
    })
      .then(() => { onError(null); onSaved(); })
      .catch((reason: unknown) => onError(apiErrorMessage(reason)))
      .finally(() => setSaving(false));
  };
  return (
    <form className={compact ? 'benefits-settings compact' : 'benefits-settings'} onSubmit={submit}
      aria-label={`Settings for ${cardTitle(card)} ${cardEndingLabel(card)}`}>
      {!card.product && !compact ? (
        <p className="benefits-hint">
          {card.productSource === 'missing' ? 'The product chosen for this card is no longer in the catalog. ' : ''}
          Choose this card&apos;s product to track its benefits.
        </p>
      ) : null}
      {card.needsAnniversary && !compact ? (
        <p className="benefits-hint">Some benefits renew each cardmember year: set the month this card&apos;s year starts (its anniversary).</p>
      ) : null}
      <div className="benefits-settings-fields">
        <label className="spending-select" htmlFor={productId}>
          <span>Product</span>
          <select id={productId} value={product} onChange={(event) => setProduct(event.target.value)}>
            <option value="auto">From the card&apos;s name</option>
            {products.map((entry) => <option key={entry.id} value={`manual:${entry.id}`}>{entry.name}</option>)}
            <option value="none">No tracked benefits</option>
          </select>
        </label>
        <label className="spending-select" htmlFor={monthId}>
          <span>Anniversary month</span>
          <select id={monthId} value={month} onChange={(event) => setMonth(event.target.value)}>
            <option value="">Not set</option>
            {MONTH_NAMES.map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}
          </select>
        </label>
        <button type="submit" className="spending-button primary" disabled={writesDisabled || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** A benefit row inside a By benefit group: named by its card, with only the tags the group does not say for all. */
interface MemberRow {
  /** The group's name: a card's benefit compared under another name says its own. */
  groupName: string;
  /** This card's own tags: what the group does not say for all its cards (groupTags). */
  ownTags: readonly BenefitTag[];
  /** Say whose card it is. */
  showOwner: boolean;
  /** The group has no note all its cards share: show this card's own. */
  showNote: boolean;
}

function BenefitRow({ card, benefit, year, today, member, writesDisabled, onChanged, onError, onOpenTransaction }: {
  card: CardBenefitsCardView;
  benefit: BenefitView;
  year: number;
  today: string;
  /** Set in the By benefit view; unset, the row is one of a card's (By card). */
  member?: MemberRow;
  writesDisabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const thisYear = Number(today.slice(0, 4));
  const current = benefit.current;
  const showCurrent = current !== null && (year === thisYear || benefit.periods.some((period) => period.start === current.start));
  const selectedPeriod = benefit.periods.find((period) => period.start === selected)
    ?? (current && current.start === selected ? current : null);
  // The year's one period is today's (an annual credit this year): today's line says it and opens it (Details), so it
  // gets no box of its own. One period that is not today's (a past year, a cardmember year still to come) keeps a
  // compact one.
  const onlyToday = benefit.periods.length === 1 && showCurrent && current !== null && benefit.periods[0].start === current.start;
  const nameId = useId();
  // What its controls and details are called: in a group, which card's benefit they are.
  const subject = member ? `${benefit.name} on ${[cardTitle(card), cardEndingLabel(card)].filter(Boolean).join(' ')}` : benefit.name;
  const ownTags = member ? member.ownTags : [];
  const yearFigure = benefit.inTotals || benefit.unit === 'count' ? (
    <span className="benefits-row-year num" data-year-figure>
      {usedOfAvailable(benefit, benefit.year.capturedMinor, benefit.year.availableMinor)} in {year}
    </span>
  ) : null;
  const head = member ? (
    <div className="benefits-row-head">
      <span className="benefits-row-name" id={nameId} title={benefit.note}>
        {cardTitle(card)} <span className="benefits-ending num">{cardEndingLabel(card)}</span>
      </span>
      <span className="benefits-member-meta">
        {member.showOwner ? (
          <span className="benefits-member-owner" data-owner={card.owner}>
            <span className="benefits-owner-dot" aria-hidden />
            {OWNER_LABELS[card.owner]}
          </span>
        ) : null}
        {yearFigure}
      </span>
      {normalizeBenefitName(comparisonName(benefit)) === normalizeBenefitName(member.groupName) ? null : (
        <span className="benefits-member-alias">As {benefit.name}</span>
      )}
      {ownTags.length > 0 ? <BenefitTags tags={ownTags} /> : null}
    </div>
  ) : (
    <div className="benefits-row-head">
      <div className="benefits-row-title">
        <span className="benefits-row-name" id={nameId} title={benefit.note}>{benefit.name}</span>
        <span className="benefits-tags">
          <span className="benefits-tag">{benefit.cadenceLabel}</span>
          {benefit.enrollment ? <span className="benefits-tag" data-tone="warning">Enrollment required</span> : null}
          {benefit.tracking === 'manual' ? (
            <span className="benefits-tag" data-tone="manual" title={manualReasonLabel(benefit.manualReason)}>Mark by hand</span>
          ) : null}
          {benefit.verify ? <span className="benefits-tag" data-tone="muted" title={UNVERIFIED_TITLE}>Unverified</span> : null}
        </span>
      </div>
      {yearFigure}
    </div>
  );
  const ownNote = member?.showNote && benefit.note ? benefit.note : null;
  const hasNow = (showCurrent && current !== null) || benefit.window !== undefined || benefit.needsAnniversary || ownNote !== null;
  const now = (
    <>
      {showCurrent && current ? (
        <div className="benefits-current">
          {/* In a group, the period cells beside the line show how full each period is. */}
          {member ? null : (
            <Meter
              fraction={usedFraction(current.usedMinor, current.availableMinor)}
              label={`${current.label}: ${usedOfAvailable(benefit, current.usedMinor, current.availableMinor)}`}
            />
          )}
          <span className="benefits-current-line">
            <span data-resets-soon={current.resetsSoon}><strong>{current.label}</strong> · {currentLine(benefit, current)}</span>
            <span className="benefits-source" data-source={current.source}>{sourceLabel(current.source, current.issuer, today)}</span>
            {/* Today's period may belong to another year's grid (a cardmember year that began last year). */}
            <button
              type="button"
              className="spending-link benefits-current-open"
              aria-expanded={selected === current.start}
              aria-label={`Details for ${subject}, ${current.label}`}
              onClick={() => setSelected((value) => (value === current.start ? null : current.start))}
            >
              Details
            </button>
          </span>
        </div>
      ) : null}

      {benefit.window ? (
        <p className="benefits-window">
          {benefit.window.lastUsed
            ? `Last used ${shortDate(benefit.window.lastUsed, today)} · available again ${shortDate(benefit.window.nextEligible!, today)}`
            : `Available · ${benefit.cadenceLabel.toLowerCase()}`}
        </p>
      ) : null}
      {benefit.needsAnniversary ? <p className="benefits-hint">Set the card&apos;s anniversary month to place this benefit.</p> : null}
      {ownNote ? <p className="benefits-member-note">{ownNote}</p> : null}
    </>
  );
  const grid = benefit.periods.length > 0 && !onlyToday ? (
    <div className="benefits-grid" role="group" aria-label={`${subject}, ${year}`} data-count={benefit.periods.length}>
      {benefit.periods.map((period) => (
        <button
          key={period.start}
          type="button"
          className="benefits-cell"
          data-fill={periodFill(period)}
          data-state={period.state}
          aria-pressed={selected === period.start}
          aria-label={periodCellLabel(benefit, period, today)}
          title={periodCellLabel(benefit, period, today)}
          onClick={() => setSelected((value) => (value === period.start ? null : period.start))}
        >
          <span className="benefits-cell-label">{period.label}</span>
          <span className="benefits-cell-meter" aria-hidden>
            <span style={{ height: `${Math.round(usedFraction(period.usedMinor, period.availableMinor) * 100)}%` }} />
          </span>
        </button>
      ))}
    </div>
  ) : null;
  return (
    <li
      className={member ? 'benefits-row benefits-member' : 'benefits-row'}
      id={benefitAnchor(card.cardAccountId, benefit.id)}
      // A reminder's link moves the focus here (goToBenefit); never a tab stop of its own.
      tabIndex={-1}
      data-benefit={benefit.id}
      data-card={member ? card.cardAccountId : undefined}
      aria-labelledby={nameId}
    >
      {head}
      {member ? (
        <div className="benefits-member-body" data-periods={grid ? undefined : 'none'}>
          {hasNow ? <div className="benefits-member-now">{now}</div> : null}
          {grid}
        </div>
      ) : (
        <>
          {now}
          {grid}
        </>
      )}

      {selectedPeriod ? (
        <PeriodDetail
          card={card}
          benefit={benefit}
          subject={subject}
          period={selectedPeriod}
          today={today}
          writesDisabled={writesDisabled}
          onChanged={onChanged}
          onError={onError}
          onOpenTransaction={onOpenTransaction}
        />
      ) : null}
    </li>
  );
}

function PeriodDetail({ card, benefit, subject, period, today, writesDisabled, onChanged, onError, onOpenTransaction }: {
  card: CardBenefitsCardView;
  benefit: BenefitView;
  /** What the region is called: the benefit, and in a group its card. */
  subject: string;
  period: BenefitPeriodView;
  today: string;
  writesDisabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState('');
  const amountId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  // The control that saved: disabled while saving, it lets the focus go, so it gets it back once the save settles.
  const returnTo = useRef<HTMLElement | null>(null);
  const key = { cardAccountId: card.cardAccountId, benefitId: benefit.id, periodStart: period.start };
  const run = (action: () => Promise<unknown>) => {
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement && regionRef.current?.contains(active) ? active : null;
    setBusy(true);
    action()
      .then(() => { onError(null); onChanged(); })
      .catch((reason: unknown) => onError(apiErrorMessage(reason)))
      .finally(() => setBusy(false));
  };
  // Saved: the focus goes back where it was in the period, unless it has moved elsewhere meanwhile. A cleared mark's
  // button is about to go, so its period's first action takes it.
  useEffect(() => {
    if (busy) return;
    const target = returnTo.current;
    const region = regionRef.current;
    returnTo.current = null;
    if (!target || !region) return;
    const active = document.activeElement;
    if (active && active !== document.body && !region.contains(active)) return;
    const next = target.isConnected && !target.hasAttribute('data-clear') && !target.matches(':disabled')
      ? target : region.querySelector<HTMLElement>('.benefits-detail-actions button:not(:disabled)') ?? region;
    next.focus();
  }, [busy]);
  const partialMinor = benefit.unit === 'usd' ? Math.round(Number(partial) * 100) : Math.round(Number(partial));
  const partialValid = partial.trim() !== '' && Number.isFinite(partialMinor) && partialMinor >= 0 && partialMinor <= period.availableMinor;
  const disabled = writesDisabled || busy || !period.active;
  return (
    <div className="benefits-detail" role="region" aria-label={`${subject}, ${period.label}`} ref={regionRef} tabIndex={-1}>
      <div className="benefits-detail-head">
        <strong>{period.label}</strong>
        <span className="spending-muted">{periodRange(period)}</span>
      </div>
      {benefit.note ? <p className="spending-muted">{benefit.note}</p> : null}
      {benefit.tracking === 'manual' ? <p className="spending-muted">{manualReasonLabel(benefit.manualReason)}</p> : null}
      {period.active ? (
        <p>
          <span className="num">{usedOfAvailable(benefit, period.usedMinor, period.availableMinor)}</span>
          {' · '}
          <span className="benefits-source" data-source={period.source}>{sourceLabel(period.source, period.issuer, today)}</span>
        </p>
      ) : <p className="spending-muted">This card did not offer this benefit then.</p>}
      {period.issuer ? (
        <p className="spending-muted">
          {card.product ? `${issuerLabel(card.issuer)} reported` : 'Reported'} {period.issuer.usedMinor === null ? 'no figure' : `${period.issuer.usedMinor} used`}
          {period.issuer.totalMinor === null ? '' : ` of ${period.issuer.totalMinor}`} on {shortDate(period.issuer.observedAt.slice(0, 10), today)}
          {period.issuer.enrollment === 'not-enrolled' ? ' · not enrolled' : ''}
        </p>
      ) : null}
      {benefit.tracking === 'statement-credit' ? (
        period.matches.length > 0 ? (
          <ul className="benefits-matches" aria-label="Matched statement credits">
            {period.matches.map((match) => (
              <li key={match.id}>
                <button type="button" className="spending-link" onClick={() => onOpenTransaction(match.id)}>
                  {shortDate(match.date, today)} · {match.description}
                </button>
                <span className="num">{formatBenefitUsd(-match.amountMinor)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="spending-muted">No matching statement credit in this period.</p>
      ) : null}
      {period.source === 'manual' && period.mark && benefit.tracking === 'statement-credit' ? (
        <p className="spending-muted">Your mark replaces the matched credits ({formatBenefitAmount(benefit, period.derivedMinor)}) here.</p>
      ) : null}
      <div className="benefits-detail-actions" role="group" aria-label="Mark this period">
        <button type="button" className="spending-button" disabled={disabled} onClick={() => run(() => saveBenefitMark({ ...key, status: 'used' }))}>
          Mark used
        </button>
        <button type="button" className="spending-button" disabled={disabled} onClick={() => run(() => saveBenefitMark({ ...key, status: 'unused' }))}>
          Mark not used
        </button>
        <label className="benefits-partial" htmlFor={amountId}>
          <span>{benefit.unit === 'usd' ? 'Used $' : 'Used'}</span>
          <input
            id={amountId}
            inputMode="decimal"
            value={partial}
            onChange={(event) => setPartial(event.target.value)}
            disabled={disabled}
            aria-label={benefit.unit === 'usd' ? 'Amount used, in dollars' : 'Number used'}
          />
        </label>
        <button
          type="button"
          className="spending-button"
          disabled={disabled || !partialValid}
          onClick={() => run(() => saveBenefitMark({ ...key, status: 'partial', usedMinor: partialMinor }))}
        >
          Save amount
        </button>
        {period.mark ? (
          <button type="button" className="spending-button" data-clear disabled={writesDisabled || busy} onClick={() => run(() => clearBenefitMark(key))}>
            Clear my mark
          </button>
        ) : null}
      </div>
    </div>
  );
}
