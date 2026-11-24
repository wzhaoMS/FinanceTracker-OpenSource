import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CardAccount } from '@finance-tracker/shared';

import { usePortfolioStore } from '../../stores/portfolio';
import { EmptyState } from '../EmptyState';
import { Spinner } from '../Spinner';
import { SpendingDetail } from '../spending/SpendingDetail';
import { fetchCardAccounts } from '../spending/spendingApi';
import { requestSpendingIntent } from '../spending/spendingIntent';
import {
  fetchMetalsFunding,
  fetchMetalsOverview,
  fetchMetalsProducts,
  fetchMetalsPurchases,
  fetchMetalsSales,
  fetchMetalsTimeline,
  type GoldPeriod,
  type Metal,
  type MetalsNotInstalled,
  type MetalsRead,
} from './goldApi';
import { GoldHeldChart, GoldPriceChart } from './GoldChart';
import { GoldConfirmations } from './GoldConfirm';
import { GoldHoldings } from './GoldHoldings';
import { GoldCancelled, GoldPurchases, GoldSales } from './GoldLists';
import { GoldRewards } from './GoldRewards';
import { GoldSources } from './GoldSources';
import { GoldResult, GoldToCheck } from './GoldSummary';
import { GoldTotalsBlock } from './GoldTotalsBlock';
import {
  PERIOD_CHOICES,
  PERIOD_LABELS,
  goldPageView,
  metalTitle,
  periodDates,
  periodScope,
  spotShown,
  switchMetals,
  unresolvedMetalHeldLine,
  type GoldPeriodChoice,
} from './goldText';
import { TOTALS_CHIPS_NOTE, combinedTotals, goldTotals, type GoldCoverageProof, type GoldTotalsInput } from './goldTotals';
import {
  goldSectionsBusy, periodCancelled, periodFunding, periodList, periodOverview, periodTimeline, periodTrades, type GoldScope,
  type GoldTimelineAnswer,
} from './goldReads';
import { useGoldRead } from './useGoldRead';
import { useGoldTotalsRead } from './useGoldTotals';
import './gold.css';

const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Today's date in New York, the day the ledger's dates and closes are kept in. */
export const newYorkToday = (now = new Date()) => NEW_YORK_DATE.format(now);

const installed = <T extends { installed: true }>(read: MetalsRead<T> | null): T | null =>
  read && read.installed ? read as T : null;
const notInstalled = (read: { installed: boolean } | null): read is MetalsNotInstalled => read?.installed === false;

/** A charge to open in Card transactions: the drawer there, over the charge's month. */
export interface OpenInCardTransactions {
  (charge: { id: string; date: string }): void;
}

/**
 * Investing › Gold (design v8 §11, as Astra accepted the redesign): the precious-metals ledger's own page, one metal at a
 * time. Reading order: the metal; the totals over all recorded history (Alex's three numbers: bought, sold, profit or
 * loss), which never move with the period; the period (rolling back from today); what to confirm, compact; the chosen
 * period's money (paid, brought in, profit or loss on those sales) apart from what is held as of today; the rewards
 * estimate apart from both; the price with each trade, then what was held over time; everything else under Details.
 * Gold stays outside Portfolio's totals.
 */
export function GoldPage({ onOpenCardTransactions }: { onOpenCardTransactions: () => void }) {
  const writesDisabled = usePortfolioStore((s) => s.apiStatus) === 'cache';
  const [metal, setMetal] = useState<Metal>('XAU');
  const [choice, setChoice] = useState<GoldPeriodChoice>('6m');
  const [version, setVersion] = useState(0);
  const today = newYorkToday();
  const period = useMemo<GoldPeriod>(() => periodDates(choice, today), [choice, today]);
  const request = JSON.stringify([metal, period.from, period.to, version]);

  const overview = useGoldRead(metal, request, () => fetchMetalsOverview(metal, period));
  const purchases = useGoldRead(metal, request, () => fetchMetalsPurchases(metal, period));
  const sales = useGoldRead(metal, request, () => fetchMetalsSales(metal, period));
  // Its answer names no period, so the period it was asked for is kept beside it (goldReads: periodTimeline).
  const timeline = useGoldRead(metal, request, () => fetchMetalsTimeline(metal, period)
    .then((read): GoldTimelineAnswer => ({ read, from: period.from, to: period.to })));
  const products = useGoldRead(metal, JSON.stringify([metal, version]), () => fetchMetalsProducts(metal));
  const funding = useGoldRead('funding', JSON.stringify([period.from, period.to, version]), () => fetchMetalsFunding(period));

  const shown = installed(overview.answer);
  const headingId = useId();
  const confirmRef = useRef<HTMLElement | null>(null);
  const toCheckRef = useRef<HTMLElement | null>(null);
  const sourcesRef = useRef<HTMLElement | null>(null);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [cancelledOpen, setCancelledOpen] = useState(false);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  // The totals: all recorded history to today, for this metal and for each metal with records (the metals together).
  const recorded = useMemo(() => (shown?.metals ?? []).filter((entry) => entry.lots + entry.sales > 0).map((entry) => entry.metal), [shown]);
  const totalsMetals = useMemo(() => switchMetals(shown).filter((item) => item === metal || recorded.includes(item)), [shown, metal, recorded]);
  const totalsRead = useGoldTotalsRead(totalsMetals, today, version, shown !== null);
  /**
   * The served proof that the purchase and sale history is complete (5b01e72f's gate b). G3 doesn't serve it yet (its
   * coverage gaps are being revised), so the totals' profit or loss is unavailable; Bought and Sold still show. Only the
   * opt-in review captures (tests/gold-proven.e2e.ts, until PR-E) replace this null, in their own browser page, to show
   * the complete states. That run fails unless this stays the module's one null proof, written as it is below.
   */
  const proof: GoldCoverageProof | null = null;
  const totalsInputs = totalsRead.answer;
  const ownTotals = totalsInputs?.find((input) => input.overview.metal === metal) ?? null;
  const totals = ownTotals ? goldTotals(ownTotals, proof) : null;
  // The metals together need every metal with records, sold or not (5b01e72f, C2-H4): while one isn't read yet (a read
  // under way), no panel shows, never a total over some of them.
  const combinedInputs = recorded.map((item) => totalsInputs?.find((input) => input.overview.metal === item));
  const combined = combinedInputs.every((input): input is GoldTotalsInput => input !== undefined)
    ? combinedTotals(combinedInputs.map((input) => ({ input, totals: goldTotals(input, proof) }))) : null;

  // A linked card charge, opened in place: one drawer, over this page.
  const [chargeId, setChargeId] = useState<string | null>(null);
  const [cards, setCards] = useState<Map<string, CardAccount>>(() => new Map());
  useEffect(() => {
    if (!chargeId || cards.size > 0) return undefined;
    let cancelled = false;
    fetchCardAccounts().then((list) => { if (!cancelled) setCards(new Map(list.map((card) => [card.id, card]))); }).catch(() => {});
    return () => { cancelled = true; };
  }, [chargeId, cards.size]);

  const openInCardTransactions = useCallback<OpenInCardTransactions>((charge) => {
    requestSpendingIntent({ transactionId: charge.id, month: charge.date.slice(0, 7) });
    setChargeId(null);
    window.scrollTo({ top: 0, left: 0 });
    onOpenCardTransactions();
  }, [onOpenCardTransactions]);

  const showConfirmations = useCallback(() => {
    setConfirmOpen(true);
    // Once it is drawn open: the section's heading takes focus, so the owner's next step is right there.
    window.requestAnimationFrame(() => {
      const section = confirmRef.current;
      section?.scrollIntoView({ block: 'start' });
      section?.querySelector<HTMLElement>('[data-confirm-heading]')?.focus({ preventScroll: true });
    });
  }, []);
  // The completeness line's Review: the products to confirm when their card shows; otherwise what to check, in Details
  // (a coverage gap, a sale with no purchase or an order held for an answer has no product to confirm).
  const review = useCallback(() => {
    if (confirmRef.current) {
      showConfirmations();
      return;
    }
    setDetailsOpen(true);
    window.requestAnimationFrame(() => {
      const target = toCheckRef.current ?? detailsRef.current?.querySelector<HTMLElement>(':scope > summary') ?? null;
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    });
  }, [showConfirmations]);
  // The totals' "Review coverage": where the figures come from, in Details, opened and focused.
  const reviewCoverage = useCallback(() => {
    setDetailsOpen(true);
    setCoverageOpen(true);
    window.requestAnimationFrame(() => {
      const section = sourcesRef.current;
      section?.scrollIntoView({ block: 'start' });
      section?.querySelector<HTMLElement>('.fold-toggle')?.focus({ preventScroll: true });
    });
  }, []);
  const metals = switchMetals(shown);
  const page = goldPageView({ notInstalled: notInstalled(overview.answer), missing: overview.missing, error: overview.error }, shown);
  const scope = periodScope(choice, period);
  // A read keeps its last answer while the next is under way, so after a change of period it can still answer the period
  // before: each section is given only answers for the metal and period chosen (goldReads), else it shows its reading
  // state. The rewards line keeps its own rule (rewardsReadsCurrent).
  const chosen: GoldScope = { metal, from: period.from, to: period.to };
  const periodRead = periodOverview(overview, chosen);
  const trades = periodTrades(purchases, sales, chosen);
  const cancelled = periodCancelled(purchases, sales, chosen);
  const timelineRead = periodTimeline(timeline, chosen);
  const heldStart = period.from ?? (timelineRead?.months[0] ? `${timelineRead.months[0].month}-01` : period.to);
  // Each section is marked as being read again until every read it shows from is in (the overview's spot, say).
  const reading = goldSectionsBusy({
    overview: overview.busy, purchases: purchases.busy, sales: sales.busy, timeline: timeline.busy, funding: funding.busy,
  });

  return (
    <section className="gold" aria-labelledby={headingId} aria-busy={reading.page} data-testid="gold-page">
      <header className="gold-head">
        <h2 id={headingId} className="gold-title">{metalTitle(metal)}</h2>
        <div className="gold-switch" role="group" aria-label="Metal">
          {metals.map((item) => (
            <button key={item} type="button" className={`gold-chip${item === metal ? ' active' : ''}`} aria-pressed={item === metal}
              onClick={() => setMetal(item)}>
              {metalTitle(item)}
            </button>
          ))}
        </div>
      </header>
      {page.kind === 'not-installed' ? (
        <EmptyState
          title="Gold isn't set up yet"
          body={(
            <>
              The precious-metals ledger needs a one-time install on this Holdr by its operator
              (<code>holdr-metals install</code>), then an import of each source&apos;s file (<code>holdr-metals import</code>).
              Until then there is nothing to show here.
            </>
          )}
        />
      ) : page.kind === 'error' ? (
        <div className="gold-error" role="alert">
          <p>The Gold page couldn&apos;t be read: {overview.error}</p>
          <button type="button" className="gold-button" onClick={refresh}>Read again</button>
        </div>
      ) : page.kind === 'loading' ? (
        <p className="gold-loading"><Spinner label="Reading the precious-metals ledger" deferred /></p>
      ) : page.kind === 'nothing-imported' ? (
        <EmptyState
          title="Nothing imported yet"
          body={(
            <>
              The precious-metals ledger is installed, but no source&apos;s file has been imported yet: its operator imports each one
              with <code>holdr-metals import</code>. Until then there is nothing to count, so nothing is shown as zero.
            </>
          )}
        />
      ) : (
        <>
          <GoldTotalsBlock totals={totals} combined={combined} busy={totalsRead.busy} error={totalsRead.error} onRetry={refresh}
            onReviewCoverage={reviewCoverage} onReview={review} />
          <div className="gold-periods">
            <p className="gold-help" data-testid="gold-totals-chips-note">{TOTALS_CHIPS_NOTE}</p>
            <div className="gold-chips" role="group" aria-label="Period">
              {PERIOD_CHOICES.map((item) => (
                <button key={item} type="button" className={`gold-chip${item === choice ? ' active' : ''}`} aria-pressed={item === choice}
                  onClick={() => setChoice(item)} data-testid={`gold-period-${item}`}>
                  {PERIOD_LABELS[item]}
                </button>
              ))}
            </div>
            <p className="gold-help" data-testid="gold-period-scope">
              Over {scope}: the period&apos;s figures, the price chart and the lists. What you hold is as of today. Defaults you can change:
              periods roll back from today; sale cost uses the earliest units first.
            </p>
          </div>
          <GoldConfirmations
            sectionRef={confirmRef}
            metal={metal}
            read={installed(products.answer)}
            error={products.error}
            busy={products.busy}
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            writesDisabled={writesDisabled}
            onChanged={refresh}
          />
          <GoldResult overview={page.overview} choice={choice} period={period} busy={reading.summary} current={periodRead !== null}
            onReview={review} totalsKind={totals?.result.kind ?? null} />
          <GoldRewards purchases={installed(purchases.answer)} overview={page.overview} busy={{ purchases: purchases.busy, overview: overview.busy }}
            open={rewardsOpen} onOpenChange={setRewardsOpen} />
          <GoldPriceChart metal={metal} period={period} purchases={trades.purchases} sales={trades.sales}
            tradesError={purchases.error ?? sales.error} />
          <GoldHeldChart metal={metal} start={heldStart} end={period.to} timeline={timelineRead} error={timeline.error} busy={reading.held}
            spot={spotShown(page.overview.price)} unresolved={unresolvedMetalHeldLine(page.overview.metalUnknown, true)} />
          <details ref={detailsRef} className="gold-details-all" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
            data-testid="gold-details">
            <summary>Details: what to check, each purchase with its card charge, sales, holdings and coverage</summary>
            <div className="gold-details-body">
              <GoldToCheck overview={page.overview} onConfirm={showConfirmations} busy={reading.details}
                sectionRef={(node) => { toCheckRef.current = node; }} />
              <GoldPurchases
                metal={metal}
                read={periodList(purchases, chosen)}
                funding={periodFunding(funding, chosen)}
                fundingError={funding.error}
                error={purchases.error}
                busy={reading.purchases}
                scope={scope}
                onOpenCharge={setChargeId}
                onOpenInCardTransactions={openInCardTransactions}
                onConfirm={showConfirmations}
              />
              <GoldSales metal={metal} read={periodList(sales, chosen)} error={sales.error} busy={reading.sales} scope={scope}
                spot={spotShown(page.overview.price)} onConfirm={showConfirmations} />
              <GoldHoldings overview={page.overview} busy={reading.details} />
              {cancelled ? (
                <GoldCancelled metal={metal} purchases={cancelled.purchases} sales={cancelled.sales} scope={scope}
                  open={cancelledOpen} onOpenChange={setCancelledOpen} />
              ) : null}
              <GoldSources overview={page.overview} open={coverageOpen} onOpenChange={setCoverageOpen} busy={reading.details}
                sectionRef={(node) => { sourcesRef.current = node; }} />
            </div>
          </details>
        </>
      )}
      {chargeId ? (
        <SpendingDetail
          id={chargeId}
          accountById={cards}
          categories={[]}
          writesDisabled={writesDisabled}
          onClose={() => setChargeId(null)}
          onChanged={refresh}
          onOpen={setChargeId}
        />
      ) : null}
    </section>
  );
}
