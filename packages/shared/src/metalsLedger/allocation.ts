/**
 * `METALS_ALLOCATION_RULE` v1 ('metals-allocation-v1', design v8 §4.4.2): an order's costs (a buy) or proceeds (a sale)
 * per line, in exact cents, from its anonymous accounting skeleton and its order-level components. Every cent is either
 * on exactly one line or in the order's unattributed cost, so the identity
 *   Σ direct + Σ attributed shares + unattributed = the order's full price
 * always holds; the validator and the importer recompute it all from the skeleton.
 *
 * - Principal lines are items and fuel. A fee line names its parent principal line; a coupon line, the principal line
 *   it discounts. A principal line's direct cost is its amount and own shipping, plus its fee lines and the coupons that
 *   target it (each with its own shipping). Its base is max(direct, 0).
 * - Order-level components: the stated tax, shipping and discount; an unparented fee or untargeted coupon line; on a
 *   sale, the platform fee and insured shipping (negative).
 * - Eligibility first, for every component. Tax: if no principal line states a flag, every principal line ("without
 *   stated tax eligibility"); if every line states one, the taxable lines (a non-taxable line gets exactly zero); if
 *   some do and some don't, the tax is unattributed. Everything else: every principal line.
 * - A component is attributed when its eligible lines with a positive base are all metal or all non-metal: it is split
 *   over them in proportion to their bases by largest remainder, ties to the lower ordinal, a negative one by magnitude
 *   keeping its sign. Otherwise (they mix metal and non-metal, or none has a positive base) it stays unattributed: never
 *   in a line's total, and every line it could have reached is incomplete.
 * - Within a line, its total is split over its units by largest remainder, earlier units first.
 *
 * Pure: no file system, network or clock.
 */

import {
  METALS_RULES,
  type MetalsAllocatedShare,
  type MetalsComponentKind,
  type MetalsOrderComponent,
  type MetalsSkeletonLine,
} from './model.js';
import { largestRemainder } from './rational.js';

export const METALS_ALLOCATION_RULE = METALS_RULES.allocation;

/** Why a component stayed unattributed. */
export const METALS_UNATTRIBUTED_REASONS = ['mixed-metal', 'no-positive-base', 'tax-flags-partial'] as const;
export type MetalsUnattributedReason = (typeof METALS_UNATTRIBUTED_REASONS)[number];

export interface MetalsComponentAllocation {
  /** `tax`, `shipping`, `discount`, `platform-fee`, `insured-shipping`, or `fee@n` / `coupon@n` for skeleton line n. */
  component: string;
  amountMinor: number;
  /** `unstated-tax-eligibility` when tax went to every principal line because none states a flag. */
  eligibility: 'stated' | 'unstated-tax-eligibility';
  attributed: boolean;
  reason: MetalsUnattributedReason | null;
}

export interface MetalsLineAllocation {
  ordinal: number;
  metal: boolean;
  directMinor: number;
  /** Non-zero shares of attributed components, in component order. */
  allocated: MetalsAllocatedShare[];
  /** direct + Σ shares: a buy line's cost, a sale line's net. */
  totalMinor: number;
  /** False when an unattributed component could have reached the line. */
  complete: boolean;
}

export interface MetalsAllocation {
  /** One per principal line, in ordinal order. */
  lines: MetalsLineAllocation[];
  components: MetalsComponentAllocation[];
  unattributedMinor: number;
  fullPriceMinor: number;
}

/** The skeleton's structural faults, which make an allocation meaningless; the validator refuses such a payload. */
export function metalsSkeletonProblem(skeleton: readonly MetalsSkeletonLine[]): string | null {
  if (skeleton.length === 0) return 'has no lines';
  const principal = (ordinal: number | null) => {
    const line = ordinal === null ? undefined : skeleton[ordinal];
    return line !== undefined && (line.kind === 'item' || line.kind === 'fuel');
  };
  for (const [index, line] of skeleton.entries()) {
    if (line.ordinal !== index) return 'has ordinals out of order';
    if (line.kind === 'fee' ? line.couponTarget !== null : line.feeParent !== null) return 'has a parent on a line that is not a fee';
    if (line.kind === 'coupon' ? line.feeParent !== null : line.couponTarget !== null) return 'has a target on a line that is not a coupon';
    if (line.kind === 'fee' && line.feeParent !== null && !principal(line.feeParent)) return 'has a fee whose parent is not an item';
    if (line.kind === 'coupon' && line.couponTarget !== null && !principal(line.couponTarget)) {
      return 'has a coupon whose target is not an item';
    }
    const owner = line.kind === 'fee' ? line.feeParent : line.kind === 'coupon' ? line.couponTarget : null;
    if (owner !== null && skeleton[owner].metal !== line.metal) return 'has a fee or coupon whose metal flag differs from its line';
    if (owner === null && (line.kind === 'fee' || line.kind === 'coupon') && line.metal) return 'has an order-level fee or coupon marked metal';
    if (line.kind === 'fuel' && line.metal) return 'has a fuel line marked metal';
  }
  if (!skeleton.some((line) => line.kind === 'item' || line.kind === 'fuel')) return 'has no item';
  return null;
}

const lineMoney = (line: MetalsSkeletonLine) => line.amountMinor + (line.shippingMinor ?? 0);

/** Allocates one order. Throws on a skeleton with a structural fault (see metalsSkeletonProblem). */
export function metalsAllocation(
  skeleton: readonly MetalsSkeletonLine[],
  components: readonly MetalsOrderComponent[],
): MetalsAllocation {
  const problem = metalsSkeletonProblem(skeleton);
  if (problem !== null) throw new RangeError(`metalsAllocation: the skeleton ${problem}`);

  const principals = skeleton.filter((line) => line.kind === 'item' || line.kind === 'fuel');
  const direct = new Map<number, number>(principals.map((line) => [line.ordinal, lineMoney(line)]));
  const orderLevel: Array<{ component: string; kind: MetalsComponentKind | 'fee' | 'coupon'; amountMinor: number }> = [];
  for (const line of skeleton) {
    const owner = line.kind === 'fee' ? line.feeParent : line.kind === 'coupon' ? line.couponTarget : null;
    if (line.kind !== 'fee' && line.kind !== 'coupon') continue;
    if (owner !== null) direct.set(owner, direct.get(owner)! + lineMoney(line));
    else orderLevel.push({ component: `${line.kind}@${line.ordinal}`, kind: line.kind, amountMinor: lineMoney(line) });
  }
  for (const component of components) orderLevel.push({ component: component.kind, kind: component.kind, amountMinor: component.amountMinor });

  const base = (line: MetalsSkeletonLine) => Math.max(direct.get(line.ordinal)!, 0);
  const shares = new Map<number, MetalsAllocatedShare[]>(principals.map((line) => [line.ordinal, []]));
  const incomplete = new Set<number>();
  const results: MetalsComponentAllocation[] = [];
  let unattributedMinor = 0;

  for (const { component, kind, amountMinor } of orderLevel) {
    let eligible: MetalsSkeletonLine[] = principals;
    let eligibility: MetalsComponentAllocation['eligibility'] = 'stated';
    let reason: MetalsUnattributedReason | null = null;
    if (kind === 'tax') {
      const stated = principals.filter((line) => line.taxFlag !== null);
      if (stated.length === 0) eligibility = 'unstated-tax-eligibility';
      else if (stated.length < principals.length) {
        reason = 'tax-flags-partial';
        eligible = principals.filter((line) => line.taxFlag !== 'non-taxable');
      } else eligible = principals.filter((line) => line.taxFlag === 'taxable');
    }
    const positive = eligible.filter((line) => base(line) > 0);
    if (reason === null && amountMinor !== 0) {
      if (positive.length === 0) reason = 'no-positive-base';
      else if (positive.some((line) => line.metal) && positive.some((line) => !line.metal)) reason = 'mixed-metal';
    }
    if (amountMinor === 0) {
      results.push({ component, amountMinor, eligibility, attributed: true, reason: null });
      continue;
    }
    if (reason !== null) {
      unattributedMinor += amountMinor;
      const reached = reason === 'no-positive-base' ? (eligible.length > 0 ? eligible : principals) : reason === 'mixed-metal' ? positive : eligible;
      for (const line of reached) incomplete.add(line.ordinal);
      results.push({ component, amountMinor, eligibility, attributed: false, reason });
      continue;
    }
    const parts = largestRemainder(BigInt(amountMinor), positive.map((line) => BigInt(base(line))));
    positive.forEach((line, index) => {
      if (parts[index] !== 0n) shares.get(line.ordinal)!.push({ component, amountMinor: Number(parts[index]) });
    });
    results.push({ component, amountMinor, eligibility, attributed: true, reason: null });
  }

  const lines = principals.map((line): MetalsLineAllocation => {
    const allocated = shares.get(line.ordinal)!;
    const directMinor = direct.get(line.ordinal)!;
    return {
      ordinal: line.ordinal,
      metal: line.metal,
      directMinor,
      allocated,
      totalMinor: directMinor + allocated.reduce((total, share) => total + share.amountMinor, 0),
      complete: !incomplete.has(line.ordinal),
    };
  });
  const fullPriceMinor = skeleton.reduce((total, line) => total + lineMoney(line), 0)
    + components.reduce((total, component) => total + component.amountMinor, 0);
  return { lines, components: results, unattributedMinor, fullPriceMinor };
}

/** A line's total split over its units by largest remainder, earlier units first. */
export function metalsUnitSplit(totalMinor: number, quantity: number): number[] {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError('metalsUnitSplit: quantity must be a positive integer');
  return largestRemainder(BigInt(totalMinor), Array.from({ length: quantity }, () => 1n)).map(Number);
}
