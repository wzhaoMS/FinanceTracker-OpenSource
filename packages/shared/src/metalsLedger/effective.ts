/**
 * The read side's effective projection of one stored order after the owner's bullion decisions (contract follow-up 1,
 * design 4c.2). "Not bullion" rebuilds the whole order, never one line: the line becomes no metal, and the fee and
 * coupon lines attached to it go with it (a fee or coupon always carries its principal's metal flag); then the
 * allocation is recomputed for the WHOLE order, since a newly mixed skeleton changes the surviving lines' shares and
 * completeness too. A line decided bullion, and a flagged line still undecided (its order is held for metals), stay
 * metal as stored.
 *
 * It returns new values and changes nothing it reads: the stored keys, the raw skeleton, the gross funding, every amount,
 * and every line's raw flag and content fingerprint stay as they are. Nothing patches one line's cached totals: every
 * figure the read side derives for the order (its lots, card links, charge parts, deposits) comes from this projection.
 *
 * Pure: no file system, network or clock.
 */

import { metalsAllocation, type MetalsAllocation } from './allocation.js';
import { metalsBullionAnswer, type MetalsContentDecision } from './contentRule.js';
import type { MetalsBullionAnswer, MetalsSkeletonLine, MetalsSource } from './model.js';
import { metalsLineEvidence, type MetalsLine, type MetalsOrder } from './payload.js';

/** Where an order's lines stand for the owner's decisions; the read side supplies it. */
export interface MetalsOrderDecisions {
  /** The order's active evidence digest: a lot decision answers only while it is the one it approved. */
  evidenceDigest: string;
  /** Every live decision of the order's lots and of its lines' refs, of both kinds, never pre-filtered. */
  decisions: readonly MetalsContentDecision[];
  /** Whether a ref names one product only: a ref shared by different products answers for none of them. */
  productRefUnique: (productRef: string) => boolean;
}

export interface MetalsEffectiveOrder {
  /**
   * Each flagged line's standing, in line order, from metalsBullionAnswer: `bullion`, `not-bullion`, or null while
   * undecided, with whether a decision for it drifted. The read side's "held for metals" predicate reads these.
   */
  answers: Array<{ key: string; ordinal: number; answer: MetalsBullionAnswer | null; drift: boolean }>;
  /** A new skeleton: the stored one, with every not-bullion line and its fee and coupon lines no metal. */
  skeleton: MetalsSkeletonLine[];
  /** The allocation of the whole order over that skeleton. */
  allocation: MetalsAllocation;
}

/** The order as the read side counts it, from its stored facts and the owner's live decisions. */
export function metalsEffectiveSkeleton(order: MetalsOrder, source: MetalsSource, standing: MetalsOrderDecisions): MetalsEffectiveOrder {
  const answers = order.lines.filter((line) => line.metalUncertain !== null).map((line: MetalsLine) => ({
    key: line.key,
    ordinal: line.ordinal,
    ...metalsBullionAnswer(metalsLineEvidence(line, source), {
      lotKey: line.key,
      productRef: line.productRef,
      productRefUnique: line.productRef !== null && standing.productRefUnique(line.productRef),
      evidenceDigest: standing.evidenceDigest,
      decisions: standing.decisions,
    }),
  }));
  const rejected = new Set(answers.filter((entry) => entry.answer === 'not-bullion').map((entry) => entry.ordinal));
  const skeleton = order.skeleton.map((line): MetalsSkeletonLine => {
    const principal = line.kind === 'fee' ? line.feeParent : line.kind === 'coupon' ? line.couponTarget : line.ordinal;
    return { ...line, metal: principal !== null && rejected.has(principal) ? false : line.metal };
  });
  return { answers, skeleton, allocation: metalsAllocation(skeleton, order.components) };
}
