import type { Metal, MetalsFunding, MetalsOverview, MetalsPurchases, MetalsRead, MetalsSales, MetalsTimeline } from './goldApi';

/*
 * Which answers the page may show for the metal and period chosen (5b01e72f's N9 and its siblings; the Gold lead's
 * ruling). A read keeps its last answer while the next is under way (useGoldRead), so right after a change of period it
 * still holds the period before. A section shows an answer only when it was read for the metal and period chosen, as the
 * answer names them; until then the section shows its reading state, never the period before under the new period's name.
 * A section that puts two reads together (the price chart's trades; the cancelled list, counted over both) also waits
 * while either is under way, so it never joins answers read at different moments. A section of one read keeps the chosen
 * period's own answer on screen while that period is read again after a write, marked as updating as before, so an
 * opened row, an open fold and the control the charge drawer gives focus back to all stay (G1d). The rewards line keeps
 * its own rule (goldRewardsStatus: rewardsReadsCurrent).
 */

/** What the page shows: one metal over one period. */
export interface GoldScope {
  metal: Metal;
  from: string | null;
  to: string;
}

/** A read as the page holds it (useGoldRead): its answer, kept while the next is under way, and whether one is. */
export interface GoldHeldRead<T> {
  answer: T | null;
  busy: boolean;
}

/** The timeline's answer names no period of its own: the page keeps beside it the period it asked for. */
export interface GoldTimelineAnswer {
  read: MetalsRead<MetalsTimeline>;
  from: string | null;
  to: string;
}

const installed = <T extends { installed: true }>(answer: MetalsRead<T> | null): T | null =>
  (answer !== null && answer.installed ? answer as T : null);

const samePeriod = (period: { from: string | null; to: string }, scope: GoldScope) => period.from === scope.from && period.to === scope.to;

/** The overview, for its period's figures: only when it answers the metal and period chosen (its activity names the period). */
export function periodOverview(read: GoldHeldRead<MetalsRead<MetalsOverview>>, scope: GoldScope): MetalsOverview | null {
  const answer = installed(read.answer);
  return answer !== null && answer.metal === scope.metal && samePeriod(answer.activity, scope) ? answer : null;
}

/** A list (purchases or sales): only when it answers the metal and period chosen. */
export function periodList<T extends MetalsPurchases | MetalsSales>(read: GoldHeldRead<MetalsRead<T>>, scope: GoldScope): T | null {
  const answer = installed(read.answer);
  return answer !== null && answer.metal === scope.metal && samePeriod(answer, scope) ? answer : null;
}

/** The funding read, for the receipts: only when it answers the period chosen (it is the household's, every metal's). */
export function periodFunding(read: GoldHeldRead<MetalsRead<MetalsFunding>>, scope: GoldScope): MetalsFunding | null {
  const answer = installed(read.answer);
  return answer !== null && samePeriod(answer, scope) ? answer : null;
}

/** The timeline: only when it was read for the metal and period chosen (the period the page asked it for). */
export function periodTimeline(read: GoldHeldRead<GoldTimelineAnswer>, scope: GoldScope): MetalsTimeline | null {
  if (read.answer === null || !samePeriod(read.answer, scope)) return null;
  const answer = installed(read.answer.read);
  return answer !== null && answer.metal === scope.metal ? answer : null;
}

/**
 * The price chart's trades, purchases and sales drawn together: neither while either read is under way, then each that
 * answers the metal and period chosen. A read that failed has no answer; the chart says so apart.
 */
export function periodTrades(
  purchases: GoldHeldRead<MetalsRead<MetalsPurchases>>,
  sales: GoldHeldRead<MetalsRead<MetalsSales>>,
  scope: GoldScope,
): { purchases: MetalsPurchases | null; sales: MetalsSales | null } {
  if (purchases.busy || sales.busy) return { purchases: null, sales: null };
  return { purchases: periodList(purchases, scope), sales: periodList(sales, scope) };
}

/**
 * The cancelled, returned and refunded list, counted over purchases and sales together: only when neither read is under
 * way and both answer the metal and period chosen.
 */
export function periodCancelled(
  purchases: GoldHeldRead<MetalsRead<MetalsPurchases>>,
  sales: GoldHeldRead<MetalsRead<MetalsSales>>,
  scope: GoldScope,
): { purchases: MetalsPurchases; sales: MetalsSales } | null {
  if (purchases.busy || sales.busy) return null;
  const bought = periodList(purchases, scope);
  const sold = periodList(sales, scope);
  return bought !== null && sold !== null ? { purchases: bought, sales: sold } : null;
}

/** Which of the page's reads are under way. */
export interface GoldReadsBusy {
  overview: boolean;
  purchases: boolean;
  sales: boolean;
  timeline: boolean;
  funding: boolean;
}

/**
 * Which sections are being read again, each marked as updating (its heading's spinner) and aria-busy until every read it
 * shows from is in: the summary (the overview); what was held (the timeline, and the overview's spot and unresolved
 * line); the purchases (theirs, and the funding read's receipts); the sales (theirs, and the overview's spot); Details'
 * sections as of today (what to check, the holdings, where the figures come from: the overview). The page is busy while
 * any of them is.
 */
export function goldSectionsBusy(busy: GoldReadsBusy): {
  summary: boolean; held: boolean; purchases: boolean; sales: boolean; details: boolean; page: boolean;
} {
  return {
    summary: busy.overview,
    held: busy.timeline || busy.overview,
    purchases: busy.purchases || busy.funding,
    sales: busy.sales || busy.overview,
    details: busy.overview,
    page: busy.overview || busy.purchases || busy.sales || busy.timeline || busy.funding,
  };
}

/** A read's own state (useGoldRead): the request it answers or is under way for, the answer it keeps, and how it stands. */
export interface GoldReadState<T> {
  view: string;
  request: string;
  answer: T | null;
  error: string | null;
  missing: boolean;
  pending: boolean;
}

/** A read as a section sees it: its answer (kept while the next is under way), its error, a missing route, and `busy`. */
export type GoldReadShown<T> = GoldHeldRead<T> & { error: string | null; missing: boolean };

/** A read starts: the same view's last answer is kept, under way; another view (metal) starts clean. */
export function goldReadStarted<T>(last: GoldReadState<T> | null, view: string, request: string): GoldReadState<T> {
  return { view, request, answer: last?.view === view ? last.answer : null, error: null, missing: false, pending: true };
}

/** Its answer is in. */
export function goldReadLanded<T>(view: string, request: string, answer: T): GoldReadState<T> {
  return { view, request, answer, error: null, missing: false, pending: false };
}

/**
 * It failed: no answer is kept, so an answer from before (the period's, before a write) never stands as current; the
 * section says the error instead (the Gold lead's condition).
 */
export function goldReadFailed<T>(view: string, request: string, error: string, missing: boolean): GoldReadState<T> {
  return { view, request, answer: null, error, missing, pending: false };
}

/** The read as the page sees it for `view` and `request` (null: the read is off): busy from the render its request changes. */
export function goldReadShown<T>(state: GoldReadState<T> | null, view: string, request: string | null): GoldReadShown<T> {
  if (request === null) return { answer: null, error: null, missing: false, busy: false };
  const own = state !== null && state.view === view ? state : null;
  const current = own !== null && own.request === request;
  return {
    answer: own === null ? null : own.answer,
    error: own !== null && current ? own.error : null,
    missing: own !== null && current ? own.missing : false,
    busy: own === null || !current || own.pending,
  };
}
