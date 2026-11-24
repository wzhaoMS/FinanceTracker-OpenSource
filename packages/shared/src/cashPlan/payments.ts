import { isBiltHousingPayment } from '../cardPaymentReconciliation.js';
import { cardCoverageContains, type CardCoverageRange } from '../cardSpending.js';
import type { CardTransactionKind } from '../types.js';
import { addDays, easternDate, endOfEasternDay, isIsoDate } from './dates.js';
import type { CardScheduleSourceKind } from './observations.js';

/**
 * Economic card payments and issuer receipt dates (A1 spec v9 §3; note v2.9 §5.4). Pure functions of what is known.
 *
 * - One economic payment per real payment: a pending row and its posted row (`superseded`/`settled-into`, merged into one
 *   `merged_into_id` root) are one identity.
 * - `postedOn` is a proven upper bound on receipt. It is proven only on a payment row whose source fills `posted_date`
 *   from a field that is a posting date by definition (`POSTING_DATE_SOURCES`). `transactionDate` is never a receipt
 *   date: it may only disqualify.
 * - `receivedOn` comes only from a binding of an issuer's last-payment fact (`matchIssuerReceipts`), which must hold under
 *   both the same-day and the widened first-appearance readings. It never assigns a window.
 */

/**
 * Card row sources whose `posted_date` is a posting date by definition, on payment rows only (spec v9 §3). Each entry
 * cites the converter field. Amex CSV (amexCsv.ts:161), WF CSV (wfCsv.ts:170), Discover layouts B/C (no posted date)
 * and every unregistered source have no source-proven posting date.
 */
export const POSTING_DATE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  ofx: 'OFX/QFX/QBO DTPOSTED (cardImportTool/ofx.ts:476-481)',
  'bilt-csv': 'Bilt CSV "Posted Date" (cardImportTool/biltCsv.ts:68,151)',
  'discover-statement': 'Discover statement layout A "Post Date" (cardImportTool/discoverStatement.ts:941,1018)',
});

/** Root's ruling of 2026-10-24: a first appearance bounds receipt at its Eastern date + 4 calendar days. */
export const FIRST_APPEARANCE_DAYS = 4;

export type CardRowRemovedReason = 'dismissed' | 'cancelled' | 'mistaken-import' | 'settled-into' | 'superseded' | 'legacy';

/** A card ledger row as the cash plan reads it (raw: removed rows and merges included). */
export interface CashPlanCardRow {
  id: string;
  cardAccountId: string;
  source: string;
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted' | 'removed';
  amountMinor: number;
  currency: string;
  kind: CardTransactionKind;
  description?: string | null;
  merchant?: string | null;
  issuerCategory?: string | null;
  /** When Holdr first stored the row: its first appearance. */
  createdAt: string;
  mergedIntoId: string | null;
  removedReason: CardRowRemovedReason | null;
  removedFromStatus: 'pending' | 'posted' | null;
  /** When the row was removed (an instant), for a removed row. */
  removedAt?: string | null;
}

/** Why a credit identity is not counted as a payment to the card. */
export type CardPaymentExclusion = 'not-a-payment' | 'removed' | 'returned' | 'housing' | 'currency';

/**
 * One credit identity on the card: the receipt graph's domain (every credit, whatever its kind, status or removal), and,
 * when it is a live payment to the card, the counting view.
 */
export interface CardCreditIdentity {
  /** The `merged_into_id` root. */
  id: string;
  rowIds: string[];
  /** Distinct cents of its credit rows in the card currency. */
  cents: number[];
  /** Has at least one payment-kind row. */
  isPayment: boolean;
  /** The earliest source-proven posting date among its payment rows. */
  registryPostedOn: string | null;
  /** The Eastern date of its earliest eligible row's first appearance (posted, or pending with no future source date). */
  firstAppearance: string | null;
  /** The first appearance (instant) of its earliest eligible pending row: "made by", never receipt (A1c). */
  madeBy: string | null;
  /** Every row's non-posting source date: it may only disqualify. */
  transactionDates: string[];
  /** The counting view, or why it is not counted. */
  counting: { status: 'posted' | 'pending'; amountMinor: number; uncertain: boolean } | null;
  /**
   * A payment undone after the fact: returned or possibly reversed (the date of its latest possible reversal), or a
   * pending payment cancelled or dismissed (its removal date). The date is null when unknown. An issuer reassurance may
   * have relied on it (#269 finding 3). Null for anything else.
   */
  undo: { date: string | null } | null;
  exclusion: CardPaymentExclusion | null;
}

const MERGED = new Set<CardRowRemovedReason>(['superseded', 'settled-into']);

/** The status a row had (a removed row keeps the status it was removed from). */
function statusOf(row: CashPlanCardRow): 'pending' | 'posted' | null {
  return row.status === 'removed' ? row.removedFromStatus : row.status;
}

/**
 * Whether a row may speak for a first appearance: posted, or pending with no source date later than its own first
 * appearance. A scheduled or future-dated payment row is never receipt evidence, in either direction.
 */
export function isEligibleFirstAppearanceRow(row: CashPlanCardRow): boolean {
  const status = statusOf(row);
  if (status === 'posted') return true;
  if (status !== 'pending') return false;
  const seen = easternDate(row.createdAt);
  return row.transactionDate <= seen && (row.postedDate === null || row.postedDate <= seen);
}

function rootOf(row: CashPlanCardRow, byId: ReadonlyMap<string, CashPlanCardRow>): string {
  let current = row;
  const seen = new Set<string>([row.id]);
  while (current.mergedIntoId !== null && current.removedReason !== null && MERGED.has(current.removedReason)) {
    const next = byId.get(current.mergedIntoId);
    if (!next) return current.mergedIntoId;
    if (seen.has(next.id)) return next.id;
    seen.add(next.id);
    current = next;
  }
  return current.id;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The card's credit identities (`economicCardPayments`): one per real payment or credit. `returnedPaymentIds` are
 * payments the card itself reversed (`ReturnedCardPayment`), dropped from counting; `uncertainPaymentIds` have an
 * unresolved possible reversal, counted only as possible (`uncertain`). Bilt housing payments are not counted.
 * `reversalDates` gives, per returned or possibly reversed payment row, the Eastern date of its latest possible reversal
 * (absent: unknown).
 */
export function economicCardPayments(
  rows: readonly CashPlanCardRow[],
  card: { id: string; issuer: string; currency: string },
  options: { returnedPaymentIds?: ReadonlySet<string>; uncertainPaymentIds?: ReadonlySet<string>; reversalDates?: ReadonlyMap<string, string> } = {},
): CardCreditIdentity[] {
  const reversalDates = options.reversalDates ?? new Map<string, string>();
  const credits = rows.filter((row) => row.cardAccountId === card.id && Number.isSafeInteger(row.amountMinor) && row.amountMinor < 0);
  const byId = new Map(credits.map((row) => [row.id, row]));
  const groups = new Map<string, CashPlanCardRow[]>();
  for (const row of credits) {
    const root = rootOf(row, byId);
    const group = groups.get(root);
    if (group) group.push(row);
    else groups.set(root, [row]);
  }
  const returned = options.returnedPaymentIds ?? new Set<string>();
  const uncertain = options.uncertainPaymentIds ?? new Set<string>();
  const identities: CardCreditIdentity[] = [];
  for (const [id, members] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    members.sort((a, b) => compareText(a.id, b.id));
    const inCurrency = members.filter((row) => row.currency === card.currency);
    const paymentRows = members.filter((row) => row.kind === 'payment');
    const registry = paymentRows
      .filter((row) => Object.hasOwn(POSTING_DATE_SOURCES, row.source) && isIsoDate(row.postedDate))
      .map((row) => row.postedDate as string)
      .sort(compareText);
    const eligible = members.filter(isEligibleFirstAppearanceRow);
    const firstSeen = eligible.map((row) => row.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    const pendingSeen = eligible.filter((row) => statusOf(row) === 'pending').map((row) => row.createdAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const live = paymentRows.filter((row) => row.status === 'pending' || row.status === 'posted');
    let counting: CardCreditIdentity['counting'] = null;
    let exclusion: CardPaymentExclusion | null = null;
    // An undo the issuer may not have known of when it last reassured (#269 finding 3): the latest possible reversal of a
    // returned or possibly reversed payment, or the removal of a cancelled or dismissed pending payment. Unknown: null.
    const undoDates: Array<string | null> = [];
    const reversalOf = (member: CashPlanCardRow) => {
      const date = reversalDates.get(member.id);
      return date !== undefined && isIsoDate(date) ? date : null;
    };
    if (paymentRows.length === 0) {
      exclusion = 'not-a-payment';
    } else if (live.length === 0) {
      exclusion = 'removed';
      for (const member of paymentRows) {
        if (member.removedFromStatus !== 'pending' || (member.removedReason !== 'cancelled' && member.removedReason !== 'dismissed')) continue;
        const removedAt = member.removedAt;
        undoDates.push(typeof removedAt === 'string' && Number.isFinite(Date.parse(removedAt)) ? easternDate(removedAt) : null);
      }
    } else {
      const inCardCurrency = live.filter((row) => row.currency === card.currency);
      const posted = inCardCurrency.find((row) => row.status === 'posted' && isIsoDate(row.transactionDate));
      const pending = inCardCurrency.find((row) => row.status === 'pending');
      const row = posted ?? pending;
      const reversed = members.filter((member) => returned.has(member.id) || uncertain.has(member.id));
      for (const member of reversed) undoDates.push(reversalOf(member));
      if (!row) exclusion = 'currency';
      else if (members.some((member) => returned.has(member.id))) exclusion = 'returned';
      else if (isBiltHousingPayment({ kind: row.kind, description: row.description ?? undefined, merchant: row.merchant ?? undefined,
        issuerCategory: row.issuerCategory ?? undefined }, card.issuer)) exclusion = 'housing';
      else {
        counting = {
          status: posted ? 'posted' : 'pending',
          amountMinor: -row.amountMinor,
          uncertain: members.some((member) => uncertain.has(member.id)),
        };
      }
    }
    const undo = undoDates.length === 0 ? null
      : { date: undoDates.some((date) => date === null) ? null : [...undoDates as string[]].sort(compareText)[undoDates.length - 1] };
    identities.push({
      id,
      rowIds: members.map((row) => row.id),
      cents: [...new Set(inCurrency.map((row) => -row.amountMinor))].sort((a, b) => a - b),
      isPayment: paymentRows.length > 0,
      registryPostedOn: registry[0] ?? null,
      firstAppearance: firstSeen.length > 0 ? easternDate(firstSeen[0]) : null,
      madeBy: pendingSeen[0] ?? null,
      transactionDates: [...new Set(members.map((row) => row.transactionDate))].sort(compareText),
      counting,
      exclusion,
      undo,
    });
  }
  return identities;
}

/**
 * An identity's receipt upper bound under a reading (a date: the end of that Eastern day). A payment identity's earliest
 * registry `postedOn`; otherwise its first appearance + `offset` days; otherwise none (a candidate for every fact).
 */
export function identityReceiptBound(identity: CardCreditIdentity, offset: number): string | null {
  if (identity.isPayment && identity.registryPostedOn !== null) return identity.registryPostedOn;
  return identity.firstAppearance === null ? null : addDays(identity.firstAppearance, offset);
}

/** A financial effective time: an instant or a date, with the bounds it spans. */
export interface CashPlanAsOf {
  value: string;
  precision: 'instant' | 'date';
  /** The Eastern date. */
  date: string;
  /** The earliest and latest instants it may mean. */
  lowerMs: number;
  upperMs: number;
}

/** An issuer's last-payment fact F: it says a payment of `minor` was received on `date`. */
export interface IssuerReceiptFact {
  /** The observation it came from (after the dedupe, the one with the latest as-of). */
  id: string;
  date: string;
  minor: number;
  asOf: CashPlanAsOf;
  sourceKind: CardScheduleSourceKind;
}

export interface ReceiptBinding {
  factId: string;
  identityId: string;
  receivedOn: string;
  financialAsOf: string;
  sourceKind: CardScheduleSourceKind;
}

export interface UnboundReceiptFact {
  fact: IssuerReceiptFact;
  /** Its candidates under the widened reading. */
  candidates: string[];
}

export interface ReceiptMatch {
  bindings: ReceiptBinding[];
  unbound: UnboundReceiptFact[];
}

/** Dedupe facts on (date, cents), keeping the latest as-of (ties by observation id). */
export function dedupeReceiptFacts(facts: readonly IssuerReceiptFact[]): IssuerReceiptFact[] {
  const kept = new Map<string, IssuerReceiptFact>();
  const sorted = [...facts].sort((a, b) => b.asOf.lowerMs - a.asOf.lowerMs || b.asOf.upperMs - a.asOf.upperMs || compareText(a.id, b.id));
  for (const fact of sorted) {
    const key = `${fact.date}|${fact.minor}`;
    if (!kept.has(key)) kept.set(key, fact);
  }
  return [...kept.values()].sort((a, b) => compareText(a.date, b.date) || a.minor - b.minor);
}

/**
 * The identity graph (`matchIssuerReceipts`, spec v9 §3). Under a reading with offset r, F has an edge to every credit
 * identity of its cents whose bound under r is none or on/after F's date. F matches X under r only if F's candidates
 * are exactly {X}, X has a registry posting date ending by F's as-of (received by the read; a first appearance never
 * counts), X is not the sole candidate of another distinct fact, and the card's coverage is continuous over [F's date,
 * F's as-of date]. F binds X only if it matches under both the same-day reading (r = 0) and the widened reading (r = w).
 * No peeling; excluded identities stay in the graph. Facts must be deduped first.
 */
export function matchIssuerReceipts(
  facts: readonly IssuerReceiptFact[],
  identities: readonly CardCreditIdentity[],
  coverage: readonly CardCoverageRange[],
  firstAppearanceDays: number = FIRST_APPEARANCE_DAYS,
): ReceiptMatch {
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  const candidatesUnder = (fact: IssuerReceiptFact, offset: number) => identities
    .filter((identity) => identity.cents.includes(fact.minor))
    .filter((identity) => {
      const bound = identityReceiptBound(identity, offset);
      return bound === null || bound >= fact.date;
    })
    .map((identity) => identity.id);
  const matchesUnder = (offset: number): Map<string, string> => {
    const candidates = new Map(facts.map((fact) => [fact.id, candidatesUnder(fact, offset)]));
    const soleOf = new Map<string, number>();
    for (const list of candidates.values()) if (list.length === 1) soleOf.set(list[0], (soleOf.get(list[0]) ?? 0) + 1);
    const matched = new Map<string, string>();
    for (const fact of facts) {
      const list = candidates.get(fact.id)!;
      if (list.length !== 1) continue;
      const identity = byId.get(list[0])!;
      if (!identity.isPayment || identity.registryPostedOn === null) continue;
      if (endOfEasternDay(identity.registryPostedOn) > fact.asOf.lowerMs) continue;
      if ((soleOf.get(identity.id) ?? 0) > 1) continue;
      if (!cardCoverageContains(coverage, { start: fact.date, end: fact.asOf.date })) continue;
      matched.set(fact.id, identity.id);
    }
    return matched;
  };
  const sameDay = matchesUnder(0);
  const widened = firstAppearanceDays === 0 ? sameDay : matchesUnder(firstAppearanceDays);
  const bindings: ReceiptBinding[] = [];
  const unbound: UnboundReceiptFact[] = [];
  for (const fact of facts) {
    const identityId = sameDay.get(fact.id);
    if (identityId !== undefined && widened.get(fact.id) === identityId) {
      bindings.push({ factId: fact.id, identityId, receivedOn: fact.date, financialAsOf: fact.asOf.value, sourceKind: fact.sourceKind });
    } else {
      unbound.push({ fact, candidates: candidatesUnder(fact, firstAppearanceDays) });
    }
  }
  return { bindings, unbound };
}
