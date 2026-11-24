/**
 * A buy line's merchandise (ROOT's ruling 5 on the owner's rewards ask, G4's delta, and the Gold lead's ruling on what
 * "attributed" means): what the line's items cost before tax, shipping and fees, the basis of Costco's Executive reward.
 * For a principal line (an item or fuel), from its order's skeleton and components:
 * - its own amount, never its own shipping;
 * - plus the amount of every coupon line that targets it, never a coupon's own shipping;
 * - plus its attributed shares of the order-level discounts: the `discount` component and every coupon line that targets
 *   no line (`coupon@n`). METALS_ALLOCATION_RULE splits them over the same bases as the ledger's allocation, so each
 *   share is the one the ledger gives the line. A coupon that targets no line counts by its amount alone, like one that
 *   targets a line: its own shipping is never merchandise. No converter writes a coupon with its own shipping, so on real
 *   data each such share equals the ledger's `coupon@n` share.
 * Never its fee lines, an order-level fee, or a share of the order's tax or shipping (nor a sale's platform fee or insured
 * shipping). Incomplete exactly when an order-level discount that could have reached the line stayed unattributed (mixed
 * metal, or no positive base: the allocation's own rule). An unattributed tax, shipping or fee leaves it complete.
 *
 * Pure: no file system, network or clock.
 */

import { metalsAllocation } from '../allocation.js';
import type { MetalsAllocatedShare, MetalsOrderComponent, MetalsSkeletonLine } from '../model.js';

export interface MetalsMerchandise {
  /** The line's amount, plus the amounts of the coupons that target it, plus its attributed order-level discount shares. */
  totalMinor: number;
  /** Its attributed order-level discount shares (`discount`, `coupon@n`), non-zero only, in component order. */
  discounts: MetalsAllocatedShare[];
  /** False when an order-level discount that could have reached the line stayed unattributed. */
  complete: boolean;
}

/**
 * The merchandise of the principal line `ordinal`. Throws a RangeError when that line is no item or fuel line of the
 * skeleton, or when the skeleton has a structural fault (metalsSkeletonProblem).
 */
export function metalsMerchandise(
  skeleton: readonly MetalsSkeletonLine[],
  components: readonly MetalsOrderComponent[],
  ordinal: number,
): MetalsMerchandise {
  // Only the order-level discounts are allocated: an order-level fee places nothing (amount 0), every other component is
  // left out, and a coupon that targets no line keeps its amount without its own shipping. No principal line's base
  // changes (an order-level line is in no line's direct cost), so each discount is split as the ledger splits it.
  const discountsOnly = skeleton.map((line): MetalsSkeletonLine => {
    if (line.kind === 'fee' && line.feeParent === null) return { ...line, amountMinor: 0, shippingMinor: null };
    if (line.kind === 'coupon' && line.couponTarget === null) return { ...line, shippingMinor: null };
    return line;
  });
  const allocation = metalsAllocation(discountsOnly, components.filter((component) => component.kind === 'discount'));
  const own = allocation.lines.find((line) => line.ordinal === ordinal);
  if (own === undefined) throw new RangeError(`metalsMerchandise: line ${ordinal} is no item or fuel line of the skeleton`);
  const coupons = skeleton.filter((line) => line.kind === 'coupon' && line.couponTarget === ordinal)
    .reduce((total, line) => total + line.amountMinor, 0);
  const discounts = own.allocated;
  return {
    totalMinor: skeleton[ordinal].amountMinor + coupons + discounts.reduce((total, share) => total + share.amountMinor, 0),
    discounts,
    complete: own.complete,
  };
}
