/**
 * `holdr-metals views-report` (G3-report, the rollout plan's row 16c): G3's reads of the metals ledger, every view of
 * every metal as the Gold page reads it today, for the operator's verification of a clone rehearsal or of production.
 * Not UP-D9's "read-report": that is G2's `report`, the one read admitted under the quarantine marker (corrections r6
 * §1, §3). This one reads figures, so it is admitted under no marker reason. Its name is `METALS_VIEWS_REPORT_COMMAND`.
 *
 * Read-only. The caller hands it the shared lease's read-only `query_only` handle (operatorIo.ts `withSharedRead`), and
 * it reads one snapshot, in one read transaction:
 * - the schema, through G2's gate (`requireMetalsSchema`), and nothing else until it returns: this build never maps a
 *   schema state itself, so every state but `present`, one a later build adds included, is refused by G2's code;
 * - the snapshot, through A0's `MetalsReadModel` over Holdr's card rows read by `metalsCardRowsReadOnly`: the graph, with
 *   its own schema check and the correction tripwire (a correction this build can't read is
 *   `metals-correction-unsupported`), and beside it, in the same transaction, the card cross-check's own reads;
 * - each metal's stored closes (`readMetalsPriceBars`). The views are built as the routes build them while this Holdr
 *   doesn't fetch prices, the default (the report never fetches): stored closes value nothing (ROOT O110), and the
 *   closes view still lists them.
 * Never SqliteStateRepo (opening it migrates), never a statement that writes, never the network: no price is fetched.
 *
 * Two outputs, rendered by `renderMetalsViewsReport`:
 * - the owner-only file: every view's full answer, as the API serves it to the owner's Gold page (each overview with its
 *   coverage proof, and the card check), each identity's terms, and the card check's failures as the API logs them
 *   (type and code only). The caller writes it through ownerOnlyOutput.ts;
 * - one strict JSON line, value-free: each measure's state and reason codes with record counts, list measures tallied
 *   by state, counts, the card check's rows by scope and status, the coverage proof's states and gap variants per scope,
 *   the identities as holds and fails, closed failure codes, and the file's SHA-256. Never an amount, ounces, a title, a
 *   label, a key, an ending, a date other than today, or a digest but those two: anything outside its closed shape
 *   refuses it.
 *
 * The conservation identities (design v8 §4.4.3), each side from a different computation:
 * - per class, as of today (the overview's classes, G1d's assignment): D + A = H + (A − S_A) + (S − U);
 * - per metal: the nets the sales view states for its lines that aren't cancelled = their cycles' proceeds plus their
 *   unmatched nets (the assignment's split of those nets over units) plus the overview's content-unknown sale nets.
 * A view that throws is `view-failed` (in the file, its error's type and code only); the other views still run. A card
 * check that can't be computed (its reads, the capture or a proof failed: what the API logs) is `card-check-failed`,
 * even while each overview answers with its unavailable proof. Ordinary incomplete coverage is no failure. Any failure,
 * an identity that fails included, fails the report (exit 1).
 */

import type { Database } from 'better-sqlite3';

import {
  METALS,
  METALS_CARD_LINK_STATES,
  METALS_COMPLETENESS_CODES,
  METALS_CONTENT_HOLDS,
  METALS_DEPOSIT_LINK_STATES,
  METALS_FINE_BASES,
  METALS_SELL_STATUSES,
  METALS_SOURCES,
  METAL_PACKS,
  type Metal,
  type MetalsCompletenessState,
  type MetalsMeasure,
} from '@finance-tracker/shared/metals-ledger';
import {
  METALS_UNMATCHED_REASONS,
  type MetalsCardCheck,
  type MetalsCardCheckStatus,
  type MetalsCloses,
  type MetalsContent,
  type MetalsCoverageGap,
  type MetalsCoverageLimit,
  type MetalsCoverageProof,
  type MetalsDeliveryState,
  type MetalsForInformation,
  type MetalsFunding,
  type MetalsNeedsYou,
  type MetalsOverview,
  type MetalsProducts,
  type MetalsPurchases,
  type MetalsRosterProblem,
  type MetalsSalePayout,
  type MetalsSales,
  type MetalsTimeline,
} from '@finance-tracker/shared/metals-api';

import { errorTypeAndCode } from '../services/dbErrors.js';
import { METALS_SCHEMA_DIGEST, MetalsRefusal, requireMetalsSchema, sha256Hex } from '../services/metals/index.js';
import { MetalsCardCheckState, metalsCardCheckView } from '../services/metalsRead/cardCheck.js';
import { metalsScreenClosesV2 } from '../services/metalsRead/closeScreen.js';
import { readMetalsPriceBars } from '../services/metalsRead/prices.js';
import { MetalsCorrectionUnsupported, MetalsReadModel, metalsCardRowsReadOnly, type MetalsLedgerSnapshot } from '../services/metalsRead/source.js';
import { MetalsViews, addMonths } from '../services/metalsRead/views.js';
import { marketDate } from '../services/symbolHistory.js';

/** The command's name (provisional, the lead decides), and with it its success code, file format and refusal lines. */
export const METALS_VIEWS_REPORT_COMMAND = 'views-report' as const;
export const METALS_VIEWS_REPORT_CODE = `metals-${METALS_VIEWS_REPORT_COMMAND}` as const;
export const METALS_VIEWS_REPORT_FORMAT = `holdr.metals-${METALS_VIEWS_REPORT_COMMAND}` as const;
/** Each metal's views, as the routes answer them with their defaults. */
export const METALS_VIEWS_REPORT_VIEWS = ['overview', 'purchases', 'sales', 'timeline', 'products', 'closes'] as const;
/** Why a computed report fails, in this order. */
export const METALS_VIEWS_REPORT_FAILURES = ['view-failed', 'card-check-failed', 'class-identity-fails', 'metal-identity-fails'] as const;
export type MetalsViewsReportFailure = (typeof METALS_VIEWS_REPORT_FAILURES)[number];

type Counts = Record<string, number>;

const DELIVERY_STATES: readonly MetalsDeliveryState[] = ['delivered', 'in-store', 'shipped', 'awaiting', 'partly-delivered', 'cancelled', 'returned'];
const NEEDS_YOU: ReadonlyArray<MetalsNeedsYou['code']> = ['bullion-answer', 'confirm-content', 'confirmation-drift', 'exclusion-rule'];
const FOR_INFORMATION: ReadonlyArray<MetalsForInformation['code']> = ['unmatched-sales', 'card-not-linked', 'deposit-not-linked', 'source-held',
  'conflict', 'date-unknown', 'cost-unattributed', 'metal-unknown', 'premium-disagreement'];
const CARD_EVIDENCE = ['admitted', 'aggregate', 'none'] as const;
const SALE_SPOTS = ['dealer-implied', 'close-proxy', 'none'] as const;
const SCOPE_KINDS = ['product', 'lot'] as const;
const LOT_SCOPES = ['pack-multiple', 'pack-unknown', 'ref-missing', 'ref-not-unique'] as const;
const FUNDING_KINDS: ReadonlyArray<MetalsFunding['purchases'][number]['byKind'][number]['kind']> = ['card', 'shop-card', 'gift-card', 'store-balance',
  'other', 'not-stated'];
const CARD_CHECK_SCOPES = ['gold-only', 'mixed-online'] as const;
const CARD_CHECK_STATUSES: readonly MetalsCardCheckStatus[] = ['explained', 'possible-aggregate', 'held', 'outside-coverage', 'no-capture-match'];
const OUT_OF_SCOPE = ['warehouse', 'samsClub', 'store', 'unclassed'] as const;
const EXEMPTION_STATES = ['current', 'stale'] as const;
const PROOF_STATES = ['complete', 'incomplete', 'no-sales', 'unavailable'] as const;
const ROSTER_STATES = ['not-installed', 'unanswered', 'current', 'stale', 'contradicted'] as const;
const GAP_VARIANTS: ReadonlyArray<MetalsCoverageGap['variant']> = ['imported-window', 'missing-account', 'missing-kind', 'unsupported-dealer',
  'alias-unresolved', 'unexplained-charges', 'missing-source', 'other-acquisition', 'roster', 'unproven-prefix', 'card-check-unavailable'];
const ROSTER_PROBLEMS: readonly MetalsRosterProblem[] = ['accounts-changed', 'sources-changed', 'evidence-changed', 'start-after-admitted-record',
  'start-after-gold-row', 'unused-source-has-buys', 'unused-source-has-sales', 'all-imported-but-none', 'exemption-disagrees', 'sources-incomplete',
  'answer-shape'];
const COVERAGE_LIMITS: readonly MetalsCoverageLimit[] = ['card-check-only', 'non-card-funding', 'stored-value-only', 'warehouse-and-store',
  'cards-not-in-holdr', 'undiscovered-dealers', 'card-history'];

const sum = <T>(items: Iterable<T>, of: (item: T) => number): number => {
  let total = 0;
  for (const item of items) total += of(item);
  return total;
};
const count = <T>(items: Iterable<T>, test: (item: T) => boolean): number => sum(items, (item) => (test(item) ? 1 : 0));

/**
 * Items summed by a key (each counts 1, or `amountOf`), the keys in the closed list's order. A key outside the list is
 * kept, after the list's, so the line's check refuses it: never dropped silently.
 */
function countIn<T>(list: readonly string[], items: Iterable<T>, keyOf: (item: T) => string, amountOf: (item: T) => number = () => 1): Counts {
  const totals = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    totals.set(key, (totals.get(key) ?? 0) + amountOf(item));
  }
  const keys = [...list.filter((key) => totals.has(key)), ...[...totals.keys()].filter((key) => !list.includes(key))];
  return Object.fromEntries(keys.map((key) => [key, totals.get(key)!]));
}

/** A measure without its value: its state, and each reason with the records it concerns. */
function stateOf(measure: MetalsMeasure<unknown>): { state: MetalsCompletenessState; reasons: Counts } {
  return { state: measure.state, reasons: countIn(METALS_COMPLETENESS_CODES, measure.reasons, (reason) => reason.code, (reason) => reason.records) };
}

/** A list's measures without their values: how many are complete, partial and unknown, and how many carry each reason. */
function tally(measures: ReadonlyArray<MetalsMeasure<unknown>>) {
  return {
    complete: count(measures, (measure) => measure.state === 'complete'),
    partial: count(measures, (measure) => measure.state === 'partial'),
    unknown: count(measures, (measure) => measure.state === 'unknown'),
    reasons: countIn(METALS_COMPLETENESS_CODES, measures.flatMap((measure) => measure.reasons), (reason) => reason.code),
  };
}

function contentSummary(contents: readonly MetalsContent[]) {
  return {
    known: count(contents, (content) => content.known),
    unknown: count(contents, (content) => !content.known),
    holds: countIn(METALS_CONTENT_HOLDS, contents.flatMap((content) => (content.known ? [] : [content.hold])), (hold) => hold),
    bases: countIn(METALS_FINE_BASES, contents.flatMap((content) => (content.known ? [content.basis] : [])), (basis) => basis),
  };
}

/** Payouts, each once (a sale order's payouts are shared by all its lines), by their deposit's link state. */
function payoutsSummary(payouts: Iterable<MetalsSalePayout>) {
  const byKey = new Map<string, MetalsSalePayout>();
  for (const payout of payouts) byKey.set(payout.key, payout);
  const list = [...byKey.values()];
  return {
    count: list.length,
    proofs: count(list, (payout) => payout.deposit.proof),
    deposits: countIn(METALS_DEPOSIT_LINK_STATES, list, (payout) => payout.deposit.state),
  };
}

function overviewSummary(overview: MetalsOverview) {
  const { holdings, activity, price, toCheck, needsAnswer, coverage } = overview;
  const { coverage: profitCoverage } = activity.profit;
  return {
    holdings: {
      troyOz: stateOf(holdings.troyOz),
      costMinor: stateOf(holdings.costMinor),
      valueMinor: stateOf(holdings.valueMinor),
      gainMinor: stateOf(holdings.gainMinor),
      awaitingTroyOz: stateOf(holdings.awaitingTroyOz),
      awaitingUnassignedTroyOz: stateOf(holdings.awaitingUnassignedTroyOz),
      units: { ...holdings.units },
      classes: {
        count: holdings.classes.length,
        unbalanced: count(holdings.classes, (entry) => !entry.reconciliation.balanced),
        troyOz: tally(holdings.classes.map((entry) => entry.troyOz)),
        costMinor: tally(holdings.classes.map((entry) => entry.costMinor)),
        valueMinor: tally(holdings.classes.map((entry) => entry.valueMinor)),
        gainMinor: tally(holdings.classes.map((entry) => entry.gainMinor)),
      },
      bySource: {
        count: holdings.bySource.length,
        units: sum(holdings.bySource, (row) => row.units),
        troyOz: tally(holdings.bySource.map((row) => row.troyOz)),
        costMinor: tally(holdings.bySource.map((row) => row.costMinor)),
        valueMinor: tally(holdings.bySource.map((row) => row.valueMinor)),
      },
      contentUnknown: { lots: holdings.contentUnknown.lots, units: holdings.contentUnknown.units, sales: holdings.contentUnknown.sales },
    },
    metalUnknown: { lots: overview.metalUnknown.lots, units: overview.metalUnknown.units, sales: overview.metalUnknown.sales },
    activity: {
      bought: { lots: activity.bought.lots, units: activity.bought.units, troyOz: stateOf(activity.bought.troyOz), costMinor: stateOf(activity.bought.costMinor) },
      sold: {
        lines: activity.sold.lines,
        units: activity.sold.units,
        troyOz: stateOf(activity.sold.troyOz),
        grossMinor: stateOf(activity.sold.grossMinor),
        feesMinor: stateOf(activity.sold.feesMinor),
        netMinor: stateOf(activity.sold.netMinor),
        unmatchedUnits: activity.sold.unmatched.units,
        unmatched: countIn(METALS_UNMATCHED_REASONS, activity.sold.unmatched.reasons, (part) => part.reason, (part) => part.units),
      },
      profit: {
        valueMinor: stateOf(activity.profit.valueMinor),
        // On the troy-oz basis, known and total are ounces: in the file only.
        coverage: profitCoverage.basis === 'sale-lines'
          ? { basis: profitCoverage.basis, known: profitCoverage.known, total: profitCoverage.total, unknownContentLines: profitCoverage.unknownContentLines }
          : { basis: profitCoverage.basis, unknownContentLines: profitCoverage.unknownContentLines },
      },
      payouts: {
        count: activity.payouts.count,
        amountMinor: stateOf(activity.payouts.amountMinor),
        mixedMetal: { count: activity.payouts.mixedMetal.count, amountMinor: stateOf(activity.payouts.mixedMetal.amountMinor) },
      },
    },
    price: { close: price.closeDate !== null, stale: price.stale, thinHistory: price.thinHistory, levelShift: price.levelShift !== null, fetching: price.fetching },
    toCheck: {
      // The records To check counts, and which of its closed codes are present (their own counts are in the file).
      records: toCheck.records,
      needsYou: countIn(NEEDS_YOU, toCheck.needsYou, (entry) => entry.code),
      forInformation: countIn(FOR_INFORMATION, toCheck.forInformation, (entry) => entry.code),
    },
    needsAnswer: { orders: needsAnswer.orders, flaggedLines: needsAnswer.flaggedLines },
    coverage: {
      accounts: coverage.length,
      kinds: sum(coverage, (entry) => entry.kinds.length),
      completeKinds: sum(coverage, (entry) => count(entry.kinds, (kind) => kind.complete)),
      held: sum(coverage, (entry) => entry.held),
    },
  };
}

function purchasesSummary({ purchases }: MetalsPurchases) {
  const cards = purchases.flatMap((entry) => entry.cards);
  return {
    lots: purchases.length,
    units: {
      ordered: sum(purchases, (entry) => entry.units.ordered),
      cancelled: sum(purchases, (entry) => entry.units.cancelled),
      returned: sum(purchases, (entry) => entry.units.returned),
      delivered: sum(purchases, (entry) => entry.units.delivered),
      awaiting: sum(purchases, (entry) => entry.units.awaiting),
    },
    delivery: countIn(DELIVERY_STATES, purchases, (entry) => entry.delivery.state),
    content: contentSummary(purchases.map((entry) => entry.content)),
    cardEvidence: countIn(CARD_EVIDENCE, purchases, (entry) => entry.cardEvidence),
    cards: { count: cards.length, proofs: count(cards, (card) => card.proof), states: countIn(METALS_CARD_LINK_STATES, cards, (card) => card.state) },
    quarantined: count(purchases, (entry) => entry.quarantined),
    dateUnknown: count(purchases, (entry) => entry.dateUnknown),
    assignedSales: sum(purchases, (entry) => entry.sales.length),
    costMinor: tally(purchases.map((entry) => entry.costMinor)),
  };
}

function salesSummary({ sales }: MetalsSales) {
  return {
    lines: sales.length,
    status: countIn(METALS_SELL_STATUSES, sales, (sale) => sale.status),
    content: contentSummary(sales.map((sale) => sale.content)),
    units: {
      quantity: sum(sales, (sale) => sale.quantity),
      matched: sum(sales, (sale) => sale.matched.units),
      unmatched: sum(sales, (sale) => sale.unmatched.units),
    },
    unmatched: countIn(METALS_UNMATCHED_REASONS, sales.flatMap((sale) => sale.unmatched.reasons), (part) => part.reason, (part) => part.units),
    known: count(sales, (sale) => sale.known),
    quarantined: count(sales, (sale) => sale.quarantined),
    purchaseConflict: count(sales, (sale) => sale.purchaseConflict),
    dateUnknown: count(sales, (sale) => sale.dateUnknown),
    premiumDisagreement: count(sales, (sale) => sale.premiumDisagreement),
    saleSpot: countIn(SALE_SPOTS, sales, (sale) => sale.saleSpot?.basis ?? 'none'),
    cycles: sum(sales, (sale) => sale.cycles.length),
    payouts: payoutsSummary(sales.flatMap((sale) => sale.payouts)),
    costMinor: tally(sales.map((sale) => sale.costMinor)),
    profitMinor: tally(sales.map((sale) => sale.profitMinor)),
  };
}

function timelineSummary({ months }: MetalsTimeline) {
  return {
    months: months.length,
    recorded: count(months, (month) => month.recorded),
    troyOz: tally(months.map((month) => month.troyOz)),
    costMinor: tally(months.map((month) => month.costMinor)),
    valueMinor: tally(months.map((month) => month.valueMinor)),
  };
}

/** The admissible stored closes the page charts: how many (their dates and closes are in the file only). */
function closesSummary({ closes }: MetalsCloses) {
  return { count: closes.length };
}

function productsSummary({ products }: MetalsProducts) {
  return {
    products: products.length,
    scopes: countIn(SCOPE_KINDS, products, (product) => product.scope.kind),
    lotScopes: countIn(LOT_SCOPES, products.flatMap((product) => (product.scope.kind === 'lot' ? [product.scope.why] : [])), (why) => why),
    decisions: count(products, (product) => product.decision !== null),
    drift: count(products, (product) => product.drift),
    proposals: count(products, (product) => product.proposal !== null),
    holds: countIn(METALS_CONTENT_HOLDS, products.flatMap((product) => (product.hold === null ? [] : [product.hold])), (hold) => hold),
    bases: countIn(METALS_FINE_BASES, products.flatMap((product) => (product.basis === null ? [] : [product.basis])), (basis) => basis),
    packs: countIn(METAL_PACKS, products, (product) => product.pack),
    lots: sum(products, (product) => product.lots),
    saleLines: sum(products, (product) => product.saleLines),
    units: sum(products, (product) => product.units),
  };
}

function fundingSummary({ purchases, sales, deposits }: MetalsFunding) {
  const cards = purchases.flatMap((entry) => entry.cards);
  return {
    purchases: {
      count: purchases.length,
      allMetal: count(purchases, (entry) => entry.allMetal),
      quarantined: count(purchases, (entry) => entry.quarantined),
      cardEvidence: countIn(CARD_EVIDENCE, purchases, (entry) => entry.cardEvidence),
      cards: { count: cards.length, proofs: count(cards, (card) => card.proof), states: countIn(METALS_CARD_LINK_STATES, cards, (card) => card.state) },
      receiptCharges: sum(purchases, (entry) => entry.receiptCharges.length),
      refunds: sum(purchases, (entry) => entry.refunds.length),
      kinds: countIn(FUNDING_KINDS, purchases.flatMap((entry) => entry.byKind), (kind) => kind.kind),
    },
    sales: {
      count: sales.length,
      quarantined: count(sales, (sale) => sale.quarantined),
      payouts: payoutsSummary(sales.flatMap((sale) => sale.payouts)),
    },
    deposits: {
      count: deposits.length,
      proofs: count(deposits, (deposit) => deposit.proof),
      states: countIn(METALS_DEPOSIT_LINK_STATES, deposits, (deposit) => deposit.state),
      assetSaleProceeds: count(deposits, (deposit) => deposit.classification === 'asset-sale-proceeds'),
    },
  };
}

/** Adds each of `more`'s counts into `into`, every key kept: one outside the line's closed lists refuses the line. */
function addCounts(into: Counts, more: Readonly<Record<string, number>>): Counts {
  for (const [key, value] of Object.entries(more)) into[key] = (into[key] ?? 0) + value;
  return into;
}

/**
 * The card check (`GET /metals/card-check`, design v3.2 §8.1) without a group, a merchant, an amount, a date, an id or a
 * digest: its purchase rows per scope and status with its credits, its out-of-scope rows per reason, the occurrences it
 * couldn't check per source, the card accounts with unsynced days, and its exemptions by state (none while the roster
 * reads `not-installed`).
 */
function cardCheckSummary(check: MetalsCardCheck) {
  const zero = (): Counts => ({ ...Object.fromEntries(CARD_CHECK_STATUSES.map((status) => [status, 0])), credits: 0 });
  const rows: Record<string, Counts> = Object.fromEntries(CARD_CHECK_SCOPES.map((scope) => [scope, zero()]));
  for (const group of check.groups) addCounts(rows[group.scope] ??= zero(), { ...group.purchases, credits: group.credits });
  const unchecked: Record<string, Counts> = {};
  for (const entry of check.unchecked) {
    addCounts(unchecked[entry.source] ??= {}, { cardNotInHoldr: entry.cardNotInHoldr, identityAmbiguous: entry.identityAmbiguous });
  }
  const exemptions: Counts = { current: 0, stale: 0 };
  for (const group of check.groups) if (group.exemption !== null) addCounts(exemptions, { [group.exemption.state]: 1 });
  return {
    rows,
    outOfScope: addCounts(Object.fromEntries(OUT_OF_SCOPE.map((reason) => [reason, 0])), check.outOfScope),
    unchecked,
    cardHistory: { accounts: check.cardHistory.length },
    exemptions,
  };
}

/** A proof scope without its need or its gaps' names, ids and dates: its state, and its gaps per variant. */
const proofScope = (scope: { state: string; gaps: readonly MetalsCoverageGap[] }) => ({
  state: scope.state, gaps: countIn(GAP_VARIANTS, scope.gaps, (gap) => gap.variant),
});

/**
 * The coverage proof (each overview's `coverageProof`, the same for every metal; design v3.2 §6.7) without a date, an
 * id, a name or a digest: the roster's state, problems and bindings by state; each scope's state and gaps per variant
 * (`asOf`, and `sales` per metal); the totals' states and metals; and the limits.
 */
function proofSummary(proof: MetalsCoverageProof) {
  const sales: Record<string, ReturnType<typeof proofScope>> = {};
  for (const scope of proof.sales) sales[scope.metal] = proofScope(scope);
  return {
    roster: {
      state: proof.roster.state,
      problems: countIn(ROSTER_PROBLEMS, proof.roster.problems, (problem) => problem),
      bindings: countIn(EXEMPTION_STATES, proof.roster.bindings, (binding) => binding.state),
    },
    asOf: proofScope(proof.asOfScope),
    sales,
    totals: {
      realized: { state: proof.totals.realized.state, metals: countIn(METALS, proof.totals.realized.metals, (metal) => metal) },
      estimate: { state: proof.totals.estimate.state, metals: countIn(METALS, proof.totals.estimate.metals, (metal) => metal) },
      metalUnknown: { ...proof.totals.metalUnknown },
    },
    limits: countIn(COVERAGE_LIMITS, proof.limits, (limit) => limit),
  };
}

/** A view's answer, or why it has none (its error's type and code only). */
type Answer<T> = { answer: T } | { failed: string };

function attempt<T>(read: () => T): Answer<T> {
  try {
    return { answer: read() };
  } catch (error) {
    return { failed: errorTypeAndCode(error) };
  }
}

/** The answer as the file holds it, or the failure with its error's type and code. */
const fileEntry = <T>(entry: Answer<T>) => ('answer' in entry ? entry.answer : { failed: 'view-failed' as const, error: entry.failed });
/** The answer as the line summarizes it, or only that it failed. */
const lineEntry = <T, S>(entry: Answer<T>, summarize: (answer: T) => S) => ('answer' in entry ? summarize(entry.answer) : { failed: 'view-failed' as const });

export interface MetalsClassIdentity {
  key: string;
  delivered: number;
  awaiting: number;
  held: number;
  awaitingUnassigned: number;
  sold: number;
  unmatched: number;
  holds: boolean;
}

export interface MetalsNetIdentity {
  saleNets: number;
  cycleNets: number;
  unmatchedNets: number;
  contentUnknownNets: number;
  holds: boolean;
}

/** Per class, as of today: D + A = H + (A − S_A) + (S − U). */
export function metalsClassIdentities(overview: MetalsOverview): MetalsClassIdentity[] {
  return overview.holdings.classes.map(({ key, units }) => ({
    key, delivered: units.delivered, awaiting: units.awaiting, held: units.held, awaitingUnassigned: units.awaitingUnassigned, sold: units.sold,
    unmatched: units.unmatched, holds: units.delivered + units.awaiting === units.held + units.awaitingUnassigned + (units.sold - units.unmatched),
  }));
}

/**
 * Per metal: the nets the sales view states for its lines that aren't cancelled = their cycles' proceeds + their
 * unmatched nets + the overview's content-unknown sale nets (sales of the metal whose content isn't known, as of today).
 */
export function metalsNetIdentity(overview: MetalsOverview, sales: MetalsSales): MetalsNetIdentity {
  const counted = sales.sales.filter((sale) => sale.status !== 'cancelled');
  const saleNets = sum(counted, (sale) => sale.netMinor);
  const cycleNets = sum(counted, (sale) => sum(sale.cycles, (cycle) => cycle.proceedsMinor));
  const unmatchedNets = sum(counted, (sale) => sale.unmatched.netMinor);
  const contentUnknownNets = overview.holdings.contentUnknown.saleNetMinor;
  return { saleNets, cycleNets, unmatchedNets, contentUnknownNets, holds: saleNets === cycleNets + unmatchedNets + contentUnknownNets };
}

/** A report's views: valuation's (no close, while this Holdr doesn't fetch) and the stored closes' (the closes view only). */
type ReportViews = { valuation: MetalsViews; stored: MetalsViews };

/** The most months a default timeline spans, as the route's (routes/metals.ts MAX_TIMELINE_MONTHS). */
const DEFAULT_TIMELINE_MONTHS = 240;

/** One metal's views as the routes answer them with their defaults: all time to today, holdings as of today. */
function readMetal(views: ReportViews, check: MetalsCardCheckState, metal: Metal, today: string) {
  const period = { from: null, to: today };
  return {
    // As the route composes it: the coverage proof first (an overview never answers without one), the same for every metal.
    overview: attempt(() => {
      const coverageProof = check.overviewProof(views.valuation, today, today);
      return { ...views.valuation.overview(metal, period, today), coverageProof };
    }),
    purchases: attempt(() => views.valuation.purchases(metal, period)),
    sales: attempt(() => views.valuation.sales(metal, period)),
    timeline: attempt(() => {
      // As the route defaults it: from the metal's first order or agreed month, but never more than
      // DEFAULT_TIMELINE_MONTHS months before this month, nor after it (routes/metals.ts; a test checks the API's).
      const { fromMonth: first, toMonth } = views.valuation.defaultMonths(metal);
      const earliest = addMonths(toMonth, 1 - DEFAULT_TIMELINE_MONTHS);
      return views.valuation.timeline(metal, first < earliest ? earliest : first > toMonth ? toMonth : first, toMonth);
    }),
    products: attempt(() => views.valuation.products(metal)),
    closes: attempt(() => views.stored.dailyCloses(metal, period)),
  };
}

/**
 * The report over one snapshot's views and card check. `logged`: the card check's failures as the API logs them (type and
 * code only), filled while the views are read.
 */
function reportOf(views: ReportViews, check: MetalsCardCheckState, logged: readonly string[], today: string, databaseRef: string) {
  const read = Object.fromEntries(METALS.map((metal) => [metal, readMetal(views, check, metal, today)])) as Record<Metal, ReturnType<typeof readMetal>>;
  const funding = attempt(() => views.valuation.funding({ from: null, to: today }));
  // As `GET /metals/card-check` answers it, as of today: never without its catalog.
  const cardCheck = attempt(() => {
    const proved = check.cardCheck(views.valuation, today, today);
    return check.serve('card check', () => metalsCardCheckView({ ...proved, asOf: today, views: views.valuation }));
  });
  const coverageProof = attempt(() => check.overviewProof(views.valuation, today, today));
  const identities = Object.fromEntries(METALS.map((metal) => {
    const { overview, sales } = read[metal];
    return [metal, {
      classes: 'answer' in overview ? metalsClassIdentities(overview.answer) : [],
      nets: 'answer' in overview && 'answer' in sales ? metalsNetIdentity(overview.answer, sales.answer) : null,
    }];
  })) as Record<Metal, { classes: MetalsClassIdentity[]; nets: MetalsNetIdentity | null }>;
  const classes = METALS.flatMap((metal) => identities[metal].classes);
  const nets = METALS.flatMap((metal) => identities[metal].nets ?? []);
  const viewFailed = 'failed' in funding || 'failed' in cardCheck
    || METALS.some((metal) => METALS_VIEWS_REPORT_VIEWS.some((view) => 'failed' in read[metal][view]));
  const failed: Record<MetalsViewsReportFailure, boolean> = {
    'view-failed': viewFailed,
    'card-check-failed': logged.length > 0,
    'class-identity-fails': classes.some((entry) => !entry.holds),
    'metal-identity-fails': nets.some((entry) => !entry.holds),
  };
  const failures = METALS_VIEWS_REPORT_FAILURES.filter((failure) => failed[failure]);
  return {
    file: {
      format: METALS_VIEWS_REPORT_FORMAT,
      version: 1,
      today,
      schemaDigest: METALS_SCHEMA_DIGEST,
      databaseRef,
      metals: Object.fromEntries(METALS.map((metal) => [metal, {
        overview: fileEntry(read[metal].overview),
        purchases: fileEntry(read[metal].purchases),
        sales: fileEntry(read[metal].sales),
        timeline: fileEntry(read[metal].timeline),
        products: fileEntry(read[metal].products),
        closes: fileEntry(read[metal].closes),
      }])),
      funding: fileEntry(funding),
      cardCheck: fileEntry(cardCheck),
      cardCheckFailures: [...logged],
      identities,
      failures,
    },
    summary: {
      metals: Object.fromEntries(METALS.map((metal) => [metal, {
        overview: lineEntry(read[metal].overview, overviewSummary),
        purchases: lineEntry(read[metal].purchases, purchasesSummary),
        sales: lineEntry(read[metal].sales, salesSummary),
        timeline: lineEntry(read[metal].timeline, timelineSummary),
        products: lineEntry(read[metal].products, productsSummary),
        closes: lineEntry(read[metal].closes, closesSummary),
      }])),
      funding: lineEntry(funding, fundingSummary),
      cardCheck: lineEntry(cardCheck, cardCheckSummary),
      coverageProof: lineEntry(coverageProof, proofSummary),
      identities: {
        classes: { holds: count(classes, (entry) => entry.holds), fails: count(classes, (entry) => !entry.holds) },
        metals: { holds: count(nets, (entry) => entry.holds), fails: count(nets, (entry) => !entry.holds) },
      },
    },
    today,
    failures,
  };
}

export type MetalsViewsReport = ReturnType<typeof reportOf>;

/**
 * The report over one read snapshot of `db` (the caller's read-only handle), as of New York's day at `now`. G2's gate
 * (`requireMetalsSchema`) refuses every schema state but `present` before anything else is read, and a ledger holding a
 * correction is refused (`metals-correction-unsupported`) before any figure is.
 */
export function metalsViewsReport(db: Database, context: { now: Date; databaseRef: string }): MetalsViewsReport {
  const today = marketDate(context.now);
  const model = new MetalsReadModel({ internalGetDb: () => db, ...metalsCardRowsReadOnly(db) });
  // One read transaction: the gate, the snapshot (its own transaction is a savepoint of this one) and the closes read one
  // snapshot, whatever another connection commits meanwhile.
  return db.transaction(() => {
    requireMetalsSchema(db);
    let snapshot: MetalsLedgerSnapshot;
    try {
      snapshot = model.ledgerSnapshot();
    } catch (error) {
      if (error instanceof MetalsCorrectionUnsupported) throw new MetalsRefusal('metals-correction-unsupported');
      throw error;
    }
    const { graph } = snapshot;
    // The card check's failures, logged as the API logs them (type and code only): each one fails the report. A state of
    // its own, so no earlier logger is kept.
    const logged: string[] = [];
    const check = new MetalsCardCheckState(snapshot, (line) => logged.push(line));
    const closes = new Map(METALS.map((metal) => [metal, readMetalsPriceBars(db, metal)]));
    // As the routes build them while this Holdr doesn't fetch prices, the default (the report never fetches): stored
    // closes value nothing (ROOT O110), and the closes view still lists them (the routes' `closes: 'stored'`).
    const views = {
      valuation: new MetalsViews({ graph, today, screen: () => ({ admissible: [], levelShifts: [] }), fetching: false }),
      stored: new MetalsViews({ graph, today, screen: (metal) => metalsScreenClosesV2(metal, closes.get(metal) ?? [], today), fetching: false }),
    };
    return reportOf(views, check, logged, today, context.databaseRef);
  })();
}

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COUNT_MAX = 9_999_999;
/** Every string the line may hold, beside today's date and the two digests. */
const WORDS = new Set<string>([METALS_VIEWS_REPORT_CODE, 'complete', 'partial', 'unknown', 'troy-oz', 'sale-lines', 'view-failed', ...PROOF_STATES,
  ...ROSTER_STATES]);
const FAILURES = new Set<string>(METALS_VIEWS_REPORT_FAILURES);
/** Every key the line may hold: its own field names and the closed vocabularies it counts by. */
const KEYS = new Set<string>([
  'code', 'schemaDigest', 'today', 'outSha256', 'metals', 'funding', 'identities', 'failures', 'failed', ...METALS, ...METALS_VIEWS_REPORT_VIEWS,
  'state', 'reasons', 'complete', 'partial', 'unknown', 'count', 'known', 'total', 'basis', 'holds', 'fails', 'classes',
  'holdings', 'troyOz', 'costMinor', 'valueMinor', 'gainMinor', 'awaitingTroyOz', 'awaitingUnassignedTroyOz', 'units', 'delivered', 'awaiting',
  'sold', 'soldFromDelivered', 'soldFromAwaiting', 'unmatched', 'held', 'awaitingUnassigned', 'unbalanced', 'bySource', 'contentUnknown', 'lots',
  'sales', 'metalUnknown', 'activity', 'bought', 'lines', 'grossMinor', 'feesMinor', 'netMinor', 'unmatchedUnits', 'profit', 'coverage',
  'unknownContentLines', 'payouts', 'amountMinor', 'mixedMetal', 'price', 'close', 'stale', 'thinHistory', 'levelShift', 'fetching', 'toCheck',
  'records', 'needsYou', 'forInformation', 'needsAnswer', 'orders', 'flaggedLines', 'accounts', 'kinds', 'completeKinds',
  'ordered', 'cancelled', 'returned', 'delivery', 'content', 'holds', 'bases', 'cardEvidence', 'cards', 'proofs', 'states', 'quarantined',
  'dateUnknown', 'assignedSales', 'status', 'quantity', 'matched', 'purchaseConflict', 'premiumDisagreement', 'saleSpot', 'cycles', 'deposits',
  'profitMinor', 'months', 'recorded', 'products', 'scopes', 'lotScopes', 'decisions', 'drift', 'proposals', 'packs', 'saleLines', 'allMetal',
  'receiptCharges', 'refunds', 'assetSaleProceeds', 'cardCheck', 'coverageProof', 'rows', 'credits', 'outOfScope', 'unchecked', 'cardNotInHoldr',
  'identityAmbiguous', 'cardHistory', 'exemptions', 'roster', 'problems', 'bindings', 'asOf', 'gaps', 'totals', 'realized', 'estimate', 'limits',
  ...METALS_COMPLETENESS_CODES, ...METALS_UNMATCHED_REASONS, ...DELIVERY_STATES, ...METALS_CONTENT_HOLDS, ...METALS_FINE_BASES, ...CARD_EVIDENCE,
  ...METALS_CARD_LINK_STATES, ...METALS_DEPOSIT_LINK_STATES, ...METALS_SELL_STATUSES, ...SALE_SPOTS, ...NEEDS_YOU, ...FOR_INFORMATION,
  ...SCOPE_KINDS, ...LOT_SCOPES, ...METAL_PACKS, ...FUNDING_KINDS, ...CARD_CHECK_SCOPES, ...CARD_CHECK_STATUSES, ...OUT_OF_SCOPE, ...METALS_SOURCES,
  ...EXEMPTION_STATES, ...ROSTER_PROBLEMS, ...GAP_VARIANTS, ...COVERAGE_LIMITS,
]);

export type MetalsViewsReportLine = { code: typeof METALS_VIEWS_REPORT_CODE; schemaDigest: string; today: string; outSha256: string }
  & MetalsViewsReport['summary'] & { failures: MetalsViewsReportFailure[] };

/**
 * The line, or null when anything in it falls outside its closed shape: a key not in the closed list, a string not in
 * its closed words (today's date and the two digests aside, each only under its own key), a number that isn't a count
 * (a safe integer from 0 to 9,999,999), a list other than the failures, or a null.
 */
export function formatMetalsViewsReport(line: MetalsViewsReportLine): string | null {
  const valid = (value: unknown, key: string): boolean => {
    if (key === 'today') return typeof value === 'string' && DATE.test(value);
    if (key === 'schemaDigest' || key === 'outSha256') return typeof value === 'string' && HEX64.test(value);
    if (key === 'failures') return Array.isArray(value) && value.every((item) => typeof item === 'string' && FAILURES.has(item));
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= COUNT_MAX;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return WORDS.has(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).every(([name, child]) => KEYS.has(name) && valid(child, name));
  };
  return line.code === METALS_VIEWS_REPORT_CODE && valid(line, '') ? `${JSON.stringify(line)}\n` : null;
}

/**
 * The owner-only file's text (one JSON document) and the value-free line naming its SHA-256 (null when the line falls
 * outside its shape: then nothing is written). `failed`: the command exits 1.
 */
export function renderMetalsViewsReport(report: MetalsViewsReport): { file: string; line: string | null; failed: boolean } {
  const file = `${JSON.stringify(report.file)}\n`;
  const line = formatMetalsViewsReport({
    code: METALS_VIEWS_REPORT_CODE, schemaDigest: METALS_SCHEMA_DIGEST, today: report.today, outSha256: sha256Hex(file), ...report.summary,
    failures: report.failures,
  });
  return { file, line, failed: report.failures.length > 0 };
}
