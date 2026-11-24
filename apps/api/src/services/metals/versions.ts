import { createHash } from 'node:crypto';

import { toLetterHex } from '@finance-tracker/shared';
import {
  metalsAdmission,
  metalsAllocation,
  type MetalsAdmissionFacts,
  type MetalsEvent,
  type MetalsInspection,
  type MetalsLine,
  type MetalsOrder,
  type MetalsPayout,
  type MetalsSellStatus,
  type MetalsSource,
  type MetalsTender,
} from '@finance-tracker/shared/metals-ledger';

/**
 * Versions of one order aggregate (design v8 §4.2). An order with its lines, skeleton, tenders, card evidence, events and
 * payouts is one aggregate, versioned by the digest of its canonical facts: the validated `MetalsOrder` with its
 * collections in a canonical order (lines by ordinal; each line's events by kind, date, quantity and date basis, their
 * occurrences numbered in that order; methods sorted, with the evidence that names them recomputed; components by kind,
 * with every line's shares recomputed; refunds by date and amount; payouts by key), so a re-capture that lists the same
 * facts in another order is the same version. The canonical form is itself a valid `MetalsOrder` (the importer
 * re-validates it before storing it).
 *
 * An incoming version is compared with the active one by its **source facts** (money, lines, quantities, tenders,
 * refunds, payouts, destinations, events and statuses) and its **derived facts** (which skeleton lines are metal, each
 * line's title and seller text, metal evidence, pack, purity, mass basis, design, fingerprint, fine content, and the
 * allocation they give):
 * - the same digest: `observation`;
 * - its source facts are a strict predecessor of the active one's: `predecessor` (an observation only, whatever its
 *   derived facts) when the payload is provably from an older capture, and otherwise `conflict`;
 * - its source facts only progress the active one's (events and refunds only grow as multisets, statuses only advance
 *   along their closed order, unknown facts become known: a date, a stated amount, a last 4, a network, a payout's
 *   completion, a shipment count that grows, a refunded or cancelled flag that turns on) with the same derived facts:
 *   `progression`, unless the payload is provably from a capture older than one that observed the active version
 *   (then that later observation showed less: `conflict`);
 * - the same or progressed source facts with other derived facts (a newer converter or retail policy): `proposal`,
 *   which waits for a Root-GO'd `supersede` (a policy change never applies itself); progressed ones from a provably
 *   older capture are a `conflict` first, as above;
 * - anything else (money, lines, quantities, tenders or payouts that differ, a destination or a date that changes, an
 *   event or status that regresses): `conflict`.
 * "Provably older" means the payload's capture time is strictly earlier than the newest capture time among the imports
 * that observed the active version; a retail payload has no capture time and is never provably older.
 */

export type MetalsVersionRelation = 'observation' | 'predecessor' | 'progression' | 'proposal' | 'conflict';

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === 'object') {
    // A null-prototype object, so an own `__proto__` key stays data (as the payload's canonical JSON keeps it).
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortedValue((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: keys sorted at every level, arrays in their order, no whitespace. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortedValue(value));

/** A canonical owner-only file: keys sorted at every level, two-space indents, one final newline. */
export const canonicalFileText = (value: unknown): string => `${JSON.stringify(sortedValue(value), null, 2)}\n`;

/** SHA-256 of a tagged canonical JSON text, in letter hex (no digits). */
export function letterDigest(tag: string, value: unknown): string {
  return toLetterHex(createHash('sha256').update(`${tag}\u0000${canonicalJson(value)}`).digest());
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareNumber = (a: number | null, b: number | null): number => (a ?? -Infinity) - (b ?? -Infinity) || 0;

function compareTender(a: MetalsTender, b: MetalsTender): number {
  return compareText(a.kind, b.kind) || compareText(a.network, b.network) || compareText(a.last4 ?? '', b.last4 ?? '')
    || compareNumber(a.amountMinor, b.amountMinor);
}

/**
 * Events in identity order with their occurrences numbered again in that order, so the canonical form depends only on
 * the multiset of (kind, date, date basis, quantity) a capture lists, never on the order it lists them in.
 */
function canonicalEvents(events: readonly MetalsEvent[]): MetalsEvent[] {
  const sorted = [...events].sort((a, b) => compareText(a.kind, b.kind) || compareText(a.date ?? '', b.date ?? '') || a.quantity - b.quantity
    || compareText(a.dateBasis ?? '', b.dateBasis ?? '') || a.occurrence - b.occurrence);
  const seen = new Map<string, number>();
  return sorted.map((event) => {
    const identity = `${event.kind}\u0000${event.date ?? ''}\u0000${event.quantity}`;
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    return { ...event, occurrence };
  });
}

/** The admission facts with their methods in canonical order. */
export function canonicalAdmission(facts: MetalsAdmissionFacts): MetalsAdmissionFacts {
  return { ...facts, methods: [...facts.methods].sort(compareTender) };
}

/** The canonical form of a validated order of `source` (see the module comment). */
export function canonicalMetalsOrder(source: MetalsSource, order: MetalsOrder): MetalsOrder {
  const components = [...order.components].sort((a, b) => compareText(a.kind, b.kind));
  const shares = new Map(metalsAllocation(order.skeleton, components).lines.map((line) => [line.ordinal, line.allocated]));
  const admission = order.admission === null ? null : canonicalAdmission(order.admission);
  return {
    ...order,
    components,
    admission,
    // The contract's rule (payload.ts): an order with a line the title guard flagged carries no card evidence, whatever
    // its admission facts would admit; any other order carries exactly the evidence they admit.
    evidence: admission === null || order.lines.some((line) => line.metalUncertain !== null)
      ? []
      : (metalsAdmission(source, order.channel, admission)?.evidence ?? []),
    refunds: [...order.refunds].sort((a, b) => compareText(a.date ?? '', b.date ?? '') || a.amountMinor - b.amountMinor),
    payouts: [...order.payouts].sort((a, b) => compareText(a.key, b.key)),
    lines: [...order.lines].sort((a, b) => a.ordinal - b.ordinal).map((line) => ({
      ...line,
      allocated: shares.get(line.ordinal) ?? line.allocated,
      events: canonicalEvents(line.events),
    })),
  };
}

const VERSION_TAG = 'holdr.metals-order-version';

/** The version digest of a canonical order: SHA-256 of its canonical JSON, in letter hex. */
export const metalsOrderDigest = (order: MetalsOrder): string => letterDigest(VERSION_TAG, order);

// ---------------------------------------------------------------------------
// Source facts: does `next` only progress `prior`?
// ---------------------------------------------------------------------------

/** An unknown fact may become known; a known fact never changes. */
const known = <T>(prior: T | null, next: T | null): boolean => prior === null || prior === next;

/** Whether every item of `from` can take a distinct item of `to` that it fits (augmenting paths). */
function injects<A, B>(from: readonly A[], to: readonly B[], fits: (a: A, b: B) => boolean): boolean {
  if (from.length > to.length) return false;
  const owner = new Array<number>(to.length).fill(-1);
  const assign = (index: number, seen: boolean[]): boolean => {
    for (let candidate = 0; candidate < to.length; candidate += 1) {
      if (seen[candidate] || !fits(from[index], to[candidate])) continue;
      seen[candidate] = true;
      if (owner[candidate] === -1 || assign(owner[candidate], seen)) {
        owner[candidate] = index;
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < from.length; index += 1) if (!assign(index, new Array<boolean>(to.length).fill(false))) return false;
  return true;
}

const SELL_RANK: Readonly<Partial<Record<MetalsSellStatus, number>>> = { agreed: 0, shipped: 1, received: 2, inspected: 3, complete: 4 };

function statusAdvances(prior: MetalsSellStatus | null, next: MetalsSellStatus | null): boolean {
  if (prior === next) return true;
  if (prior === null || next === null) return false;
  if (next === 'cancelled') return prior !== 'complete' && prior !== 'cancelled';
  const from = SELL_RANK[prior];
  const to = SELL_RANK[next];
  return from !== undefined && to !== undefined && to > from;
}

const inspectionAdvances = (prior: MetalsInspection | null, next: MetalsInspection | null): boolean =>
  prior === next || prior === null || (prior === 'pending' && next !== null);

const tenderAdvances = (prior: MetalsTender, next: MetalsTender): boolean => prior.kind === next.kind
  && (prior.network === 'unknown' || prior.network === next.network) && known(prior.last4, next.last4) && known(prior.amountMinor, next.amountMinor);

/** A dated event keeps its date; an undated one may gain one; a year-inferred date may become stated as itself. */
const eventAdvances = (prior: MetalsEvent, next: MetalsEvent): boolean => prior.kind === next.kind && prior.quantity === next.quantity
  && (prior.date === null || (prior.date === next.date
    && (prior.dateBasis === next.dateBasis || (prior.dateBasis === 'year-inferred' && next.dateBasis === 'stated'))));

function admissionAdvances(prior: MetalsAdmissionFacts | null, next: MetalsAdmissionFacts | null): boolean {
  if (prior === null || next === null) return prior === next;
  if (prior.fulfilment === 'in-store' || next.fulfilment === 'in-store') {
    if (prior.fulfilment !== next.fulfilment) return false;
  } else if (prior.fulfilment.shipments !== null
    && (next.fulfilment.shipments === null || next.fulfilment.shipments < prior.fulfilment.shipments)) return false;
  for (const flag of ['refunded', 'cancelled', 'partlyCancelled'] as const) if (prior[flag] && !next[flag]) return false;
  if (!known(prior.grossTotalMinor, next.grossTotalMinor)) return false;
  // The methods paid at checkout stay the same; only card refunds may appear later.
  const paid = (facts: MetalsAdmissionFacts) => facts.methods.filter((method) => method.kind !== 'card-refund');
  const refunds = (facts: MetalsAdmissionFacts) => facts.methods.filter((method) => method.kind === 'card-refund');
  return paid(prior).length === paid(next).length && injects(paid(prior), paid(next), tenderAdvances)
    && injects(refunds(prior), refunds(next), tenderAdvances);
}

function payoutsAdvance(prior: readonly MetalsPayout[], next: readonly MetalsPayout[]): boolean {
  const byKey = new Map(next.map((payout) => [payout.key, payout]));
  return prior.every((payout) => {
    const later = byKey.get(payout.key);
    return later !== undefined && later.method === payout.method && later.amountMinor === payout.amountMinor
      && known(payout.destinationLast4, later.destinationLast4) && known(payout.initiatedDate, later.initiatedDate)
      && known(payout.payoutDate, later.payoutDate) && (payout.status === later.status || payout.status === 'pending');
  });
}

const lineAdvances = (prior: MetalsLine, next: MetalsLine): boolean => prior.key === next.key && known(prior.productRef, next.productRef)
  && prior.quantity === next.quantity && known(prior.unitPriceMinor, next.unitPriceMinor) && prior.amountMinor === next.amountMinor
  && injects(prior.events, next.events, eventAdvances) && inspectionAdvances(prior.sale?.inspection ?? null, next.sale?.inspection ?? null);

const skeletonFacts = (order: MetalsOrder) => order.skeleton.map(({ metal: _metal, ...facts }) => facts);

/** Whether `next`'s source facts equal or only progress `prior`'s. Lines are compared where both versions carry them. */
function progresses(prior: MetalsOrder, next: MetalsOrder): boolean {
  if (prior.key !== next.key || prior.side !== next.side || prior.channel !== next.channel || prior.date !== next.date
    || prior.tradeMoment !== next.tradeMoment || prior.currency !== next.currency) return false;
  if (!known(prior.completedDate, next.completedDate) || !statusAdvances(prior.status, next.status)) return false;
  if (canonicalJson(skeletonFacts(prior)) !== canonicalJson(skeletonFacts(next))) return false;
  if (canonicalJson(prior.components) !== canonicalJson(next.components)) return false;
  if (!admissionAdvances(prior.admission, next.admission)) return false;
  if (!injects(prior.refunds, next.refunds, (a, b) => a.amountMinor === b.amountMinor && known(a.date, b.date))) return false;
  if (!payoutsAdvance(prior.payouts, next.payouts)) return false;
  const ordinalOf = new Map(prior.lines.map((line) => [line.key, line.ordinal]));
  if (next.lines.some((line) => ordinalOf.has(line.key) && ordinalOf.get(line.key) !== line.ordinal)) return false;
  const nextLines = new Map(next.lines.map((line) => [line.ordinal, line]));
  return prior.lines.every((line) => {
    const later = nextLines.get(line.ordinal);
    return later === undefined || lineAdvances(line, later);
  });
}

/** The facts a converter or retail policy derives: which lines are metal (or flagged), their text, content evidence and allocation. */
function derivedFacts(order: MetalsOrder): unknown {
  return {
    metal: order.skeleton.map((line) => line.metal),
    unattributedMinor: order.unattributedMinor,
    lines: order.lines.map((line) => ({
      key: line.key, ordinal: line.ordinal, title: line.title, metal: line.metal, metalUncertain: line.metalUncertain, form: line.form,
      statedMass: line.statedMass, pack: line.pack, purity: line.purity, massBasis: line.massBasis, design: line.design,
      contentFingerprint: line.contentFingerprint, fine: line.fine, directMinor: line.directMinor, allocated: line.allocated,
      costMinor: line.costMinor, netMinor: line.netMinor, complete: line.complete, seller: line.seller, program: line.sale?.program ?? null,
      premium: line.sale?.premium ?? null,
    })),
  };
}

/**
 * How a canonical incoming version relates to the canonical active one (see the module comment). `olderCapture` says
 * whether the incoming payload provably comes from an older capture than one that observed the active version (its
 * capture time strictly earlier than the newest of theirs; unknown is never older). Time decides only when the source
 * facts moved one way:
 * - they only regress the active one's: a `predecessor` (an observation only) from a provably older capture, and
 *   otherwise a factual `conflict`: a newer capture showing less (a completed sale back at inspected, a payout back to
 *   pending, a delivery gone, a refund flag off) contradicts the active version;
 * - they strictly progress it, but from a capture provably older than an observation of the active version: that later
 *   observation showed less, so this is a `conflict` too. Either way the outcome does not depend on the order the
 *   captures were imported in, and it fails closed.
 */
export function classifyMetalsVersion(incoming: MetalsOrder, active: MetalsOrder, olderCapture: boolean): MetalsVersionRelation {
  if (metalsOrderDigest(incoming) === metalsOrderDigest(active)) return 'observation';
  const forward = progresses(active, incoming);
  const backward = progresses(incoming, active);
  if (!forward && !backward) return 'conflict';
  if (!forward) return olderCapture ? 'predecessor' : 'conflict';
  if (!backward && olderCapture) return 'conflict';
  if (canonicalJson(derivedFacts(active)) !== canonicalJson(derivedFacts(incoming))) return 'proposal';
  // Equal facts both ways with another digest cannot happen; it fails closed.
  return backward ? 'conflict' : 'progression';
}
