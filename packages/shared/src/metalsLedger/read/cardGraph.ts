/**
 * The card-association engine that `metalsCardLinks` (cardLinks.ts) and `metalsCardCapture` (capture.ts) share (G1d C1):
 * the occurrences, candidates, contests and barriers of design v8 §4.4.4, built once over the whole ledger. A rule
 * chooses only its subjects (`isSubject`) and how a tender's card identity resolves (`identify`): the accounts whose rows
 * it contests, and the one account its candidates must be on, or why it has none.
 *
 * - Occurrences: each card tender of an order whose funding metalsAdmission admits as single charges, in the order's
 *   settlement interval. A subject's occurrence contests as itself, never as a second competitor; any other occurrence
 *   contests every subject.
 * - Barriers: an aggregate order bars every row of its merchant class, on any account, in its interval, up to its cap
 *   (any amount when it has none); a dated held record bars every row of its class in its interval, an undated one every
 *   row of its class at any date. Barriers and contests are tested against each row's own date and account.
 * - Candidates: a subject's usable USD purchase rows of its merchant class and exact amount, dated in its interval, on its
 *   candidate account; none without one.
 *
 * Pure: no file system, network or clock.
 */

import type { CardMetalsMerchantClass } from '../../cardSpendingExclusions.js';
import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import type { MetalsAdmissionFacts, MetalsCardEvidence, MetalsChannel, MetalsSource, MetalsTender } from '../model.js';

/** The merchant class of a source's channel, or null for a source with no card purchases. */
export function metalsMerchantClass(source: MetalsSource, channel: MetalsChannel): CardMetalsMerchantClass | null {
  if (source === 'costco') return channel === 'warehouse' ? 'costco-warehouse' : 'costco-online';
  return source === 'walmart' ? 'walmart-online' : null;
}

/** A captured order with its admission facts, on its active version. */
export interface MetalsCardGraphOrder {
  orderKey: string;
  source: MetalsSource;
  channel: MetalsChannel;
  date: string;
  admission: MetalsAdmissionFacts;
  /** Its version is active and the order is not quarantined. */
  active: boolean;
}

/** A held record: a barrier for its merchant class. */
export interface MetalsCardGraphHeld {
  source: MetalsSource;
  channel: MetalsChannel;
  date: string | null;
}

/** A card row, its merchant class already read. */
export interface MetalsCardGraphRow {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  kind: string;
  currency: string;
  usable: boolean;
  merchantClass: CardMetalsMerchantClass | null;
}

/** How a tender's identity resolves: its contest scope, and its candidate account or the reason it has none. */
export type MetalsCardIdentity<R extends string> =
  | { inScope: (accountId: string) => boolean; account: string; reason: null }
  | { inScope: (accountId: string) => boolean; account: null; reason: R };

/** One single-charge card tender, `<order key>#<tender index>`. */
export interface MetalsCardOccurrence<O extends MetalsCardGraphOrder, R extends string> {
  id: string;
  order: O;
  evidence: MetalsCardEvidence;
  merchantClass: CardMetalsMerchantClass;
  from: string;
  to: string;
  /** Its own id when it is a subject, which never contests itself; null for a competitor, which contests every subject. */
  self: string | null;
  identity: MetalsCardIdentity<R>;
}

export interface MetalsCardBarrier {
  merchantClass: CardMetalsMerchantClass;
  from: string | null;
  to: string | null;
  /** The most it bars; null: any amount. */
  capMinor: number | null;
  held: boolean;
}

export interface MetalsCardGraph<O extends MetalsCardGraphOrder, Row extends MetalsCardGraphRow, R extends string> {
  /** The subjects' occurrences, in order and tender order. */
  subjects: Array<MetalsCardOccurrence<O, R>>;
  /** Every occurrence, subject or competitor, in order and tender order. */
  contesters: Array<MetalsCardOccurrence<O, R>>;
  /** Aggregates in order, then held records in order. */
  barriers: MetalsCardBarrier[];
  /** A subject's candidates in row order; none without a candidate account. */
  candidatesOf: (subject: MetalsCardOccurrence<O, R>) => Row[];
  /** Whether a barrier covers a row: its merchant class, its interval when dated, and its cap. */
  bars: (barrier: MetalsCardBarrier, row: MetalsCardGraphRow) => boolean;
  /** A held record covering the row first, else an aggregate, else null. */
  barrierOn: (row: MetalsCardGraphRow) => 'competitor-held' | 'competitor-unknown' | null;
  /** Whether an occurrence contests a row: its merchant class, its exact amount, its interval and its account scope. */
  covers: (occurrence: MetalsCardOccurrence<O, R>, row: MetalsCardGraphRow) => boolean;
  /** Whether any occurrence but the subject's own contests the row. */
  contested: (row: MetalsCardGraphRow, subject: string) => boolean;
}

/** Builds the occurrences and barriers of the whole ledger at once. */
export function metalsCardGraph<O extends MetalsCardGraphOrder, Row extends MetalsCardGraphRow, R extends string>(input: {
  orders: readonly O[];
  held: readonly MetalsCardGraphHeld[];
  rows: readonly Row[];
  isSubject: (order: O) => boolean;
  identify: (source: MetalsSource, method: MetalsTender) => MetalsCardIdentity<R>;
}): MetalsCardGraph<O, Row, R> {
  const subjects: Array<MetalsCardOccurrence<O, R>> = [];
  const contesters: Array<MetalsCardOccurrence<O, R>> = [];
  const barriers: MetalsCardBarrier[] = [];
  for (const order of input.orders) {
    const merchantClass = metalsMerchantClass(order.source, order.channel);
    const admission = metalsAdmission(order.source, order.channel, order.admission);
    if (merchantClass === null || admission === null) continue;
    const { from, to } = metalsSettlementInterval(order.date, order.channel);
    if (admission.basis === 'aggregate') {
      barriers.push({ merchantClass, from, to, capMinor: admission.capMinor, held: false });
      continue;
    }
    for (const evidence of admission.evidence) {
      const method = order.admission.methods[evidence.tender];
      const id = `${order.orderKey}#${evidence.tender}`;
      const subject = input.isSubject(order);
      const occurrence: MetalsCardOccurrence<O, R> = {
        id, order, evidence, merchantClass, from, to, self: subject ? id : null, identity: input.identify(order.source, method),
      };
      if (subject) subjects.push(occurrence);
      contesters.push(occurrence);
    }
  }
  for (const held of input.held) {
    const merchantClass = metalsMerchantClass(held.source, held.channel);
    if (merchantClass === null) continue;
    const interval = held.date === null ? null : metalsSettlementInterval(held.date, held.channel);
    barriers.push({ merchantClass, from: interval?.from ?? null, to: interval?.to ?? null, capMinor: null, held: true });
  }

  const bars = (barrier: MetalsCardBarrier, row: MetalsCardGraphRow): boolean => {
    if (barrier.merchantClass !== row.merchantClass) return false;
    if (barrier.from !== null && (row.date < barrier.from || row.date > barrier.to!)) return false;
    return !(barrier.capMinor !== null && row.amountMinor > barrier.capMinor);
  };
  const barrierOn = (row: MetalsCardGraphRow): 'competitor-held' | 'competitor-unknown' | null => {
    let found: 'competitor-held' | 'competitor-unknown' | null = null;
    for (const barrier of barriers) {
      if (!bars(barrier, row)) continue;
      if (barrier.held) return 'competitor-held';
      found = 'competitor-unknown';
    }
    return found;
  };
  const covers = (occurrence: MetalsCardOccurrence<O, R>, row: MetalsCardGraphRow): boolean =>
    occurrence.merchantClass === row.merchantClass && occurrence.evidence.amountMinor === row.amountMinor
    && row.date >= occurrence.from && row.date <= occurrence.to && occurrence.identity.inScope(row.accountId);
  const contested = (row: MetalsCardGraphRow, subject: string): boolean =>
    contesters.some((contester) => contester.self !== subject && covers(contester, row));
  const candidateRow = (row: Row) => row.usable && row.kind === 'purchase' && row.currency === 'USD';
  const candidatesOf = (subject: MetalsCardOccurrence<O, R>): Row[] => {
    const account = subject.identity.account;
    if (account === null) return [];
    return input.rows.filter((row) => candidateRow(row) && row.accountId === account && row.merchantClass === subject.merchantClass
      && row.amountMinor === subject.evidence.amountMinor && row.date >= subject.from && row.date <= subject.to);
  };
  return { subjects, contesters, barriers, candidatesOf, bars, barrierOn, covers, contested };
}
