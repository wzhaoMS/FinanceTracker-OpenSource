/**
 * `METALS_PREMIUM_TEXT_RULE` ('metals-premium-text-v1', design v8 §9): reads the dealer's stated spot premium, as a sale
 * line stores it (`sale.premium`, CollectPure's converter), into the dealer's implied spot for a cycle's
 * decomposition.
 *
 * The stored text has one closed form, built by the converter from CollectPure's two stated figures:
 *
 *   spot <±S, 4 decimals>% / <±$D, cents, thousands separated> per <troy ounce | unit>
 *
 * S is the percent over spot (`spotPremium`; 1.5 is +1.5%), D the exact dollar premium on the stated basis
 * (`spotPremiumDollar`), and the basis words must be the line's `premium.basis`. Anything else reads as nothing.
 *
 * §9 implies the dealer's spot only from a premium per troy ounce. On basis `troy_ounce` it is U ÷ W − D, in US dollars
 * per troy ounce (U the unit price, W the fine troy ounces per unit). S is only a cross-check: the percent D implies,
 * 100 × D ÷ (U ÷ W − D), must reach S within the stated roundings, computed exactly: S at 4 decimals (± 0.00005 points),
 * D and U in cents (± half a cent each), so a figure that is exact to its stated precision always agrees, at any price
 * level. A text that can't be read, or doesn't reconcile, is a `premium-disagreement`: the sale's spot is then the agreed
 * day's close, labelled as a proxy. Unknown is never zero.
 *
 * A premium stated per unit (basis `unit`) gives no dealer spot (`none`), whatever its text: the sale's spot is the
 * agreed day's close, labelled as a proxy, and nothing is flagged. On that basis S checks D against U alone, so wrong
 * content would pass the check and give a wrong spot.
 *
 * Pure: no file system, network or clock.
 */

import {
  add,
  compare,
  divide,
  multiply,
  parseRational,
  rational,
  subtract,
  type MetalsPremiumBasis,
  type Rational,
} from '@finance-tracker/shared/metals-ledger';

export const METALS_PREMIUM_TEXT_RULE = 'metals-premium-text-v1' as const;

const PREMIUM = /^spot ([+-])(\d{1,3}\.\d{4})% \/ ([+-])\$(\d{1,3}(?:,\d{3})*\.\d{2}) per (troy ounce|unit)$/;
const BASIS_WORDS: Readonly<Record<MetalsPremiumBasis, string>> = { troy_ounce: 'troy ounce', unit: 'unit' };
const HALF_CENT = rational(1n, 2n);
/** Half a unit in S's last stated decimal (4 decimals). */
const HALF_PERCENT_STEP = rational(1n, 20_000n);

export interface MetalsStatedPremium {
  /** Percent over spot, signed. */
  percent: Rational;
  /** The dollar premium on the basis, in cents, signed. */
  amountMinor: bigint;
  basis: MetalsPremiumBasis;
}

/** The dealer's implied spot (US dollars per troy ounce), no stated premium, or a premium that can't be trusted. */
export type MetalsDealerSpot =
  | { kind: 'implied'; spot: Rational }
  | { kind: 'none' }
  | { kind: 'premium-disagreement' };

/** The stated premium, or null when the text isn't the closed form, its basis words disagree, or its signs do. */
export function metalsStatedPremium(premium: { text: string; basis: MetalsPremiumBasis }): MetalsStatedPremium | null {
  if (typeof premium.text !== 'string' || !(premium.basis in BASIS_WORDS)) return null;
  const match = PREMIUM.exec(premium.text);
  if (!match || match[5] !== BASIS_WORDS[premium.basis]) return null;
  const percent = parseRational(match[2]);
  const dollars = parseRational(match[4].replace(/,/g, ''));
  if (percent === null || dollars === null) return null;
  const cents = multiply(dollars, rational(100n));
  if (cents.den !== 1n) return null;
  const zero = percent.num === 0n && cents.num === 0n;
  // Closed: a zero premium is written "+" both ways; any other has a non-zero percent and dollar figure of one sign.
  if (zero ? match[1] !== '+' || match[3] !== '+' : percent.num === 0n || cents.num === 0n || match[1] !== match[3]) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  return { percent: rational(sign * percent.num, percent.den), amountMinor: sign * cents.num, basis: premium.basis };
}

/**
 * The percent over spot a premium `d` per troy ounce implies on a unit price `u` (cents), or null when its spot isn't
 * positive.
 */
function impliedPercent(d: Rational, u: Rational, fine: Rational): Rational | null {
  const base = subtract(divide(u, fine), d);
  return base.num <= 0n ? null : divide(multiply(d, rational(100n)), base);
}

/**
 * Whether S agrees with D and U within their stated roundings: the implied percent over the box D ± ½¢, U ± ½¢ (it is
 * monotone in each, so its range is spanned by the corners) must meet S ± 0.00005.
 */
function reconciles(stated: MetalsStatedPremium, unitPriceMinor: bigint, fine: Rational): boolean {
  const d = rational(stated.amountMinor);
  const u = rational(unitPriceMinor);
  const corners: Rational[] = [];
  for (const dd of [subtract(d, HALF_CENT), add(d, HALF_CENT)]) {
    for (const uu of [subtract(u, HALF_CENT), add(u, HALF_CENT)]) {
      const percent = impliedPercent(dd, uu, fine);
      if (percent === null) return false;
      corners.push(percent);
    }
  }
  const low = corners.reduce((min, value) => (compare(value, min) < 0 ? value : min));
  const high = corners.reduce((max, value) => (compare(value, max) > 0 ? value : max));
  return compare(low, add(stated.percent, HALF_PERCENT_STEP)) <= 0 && compare(high, subtract(stated.percent, HALF_PERCENT_STEP)) >= 0;
}

/**
 * The dealer's implied spot for a sale line, from its stored premium, unit price and fine troy ounces per unit; none for
 * a premium stated per unit.
 */
export function metalsDealerSpot(
  premium: { text: string; basis: MetalsPremiumBasis } | null | undefined,
  unitPriceMinor: number | null,
  fineTroyOzPerUnit: Rational | null,
): MetalsDealerSpot {
  if (!premium || premium.basis === 'unit') return { kind: 'none' };
  if (unitPriceMinor === null || fineTroyOzPerUnit === null || fineTroyOzPerUnit.num <= 0n) return { kind: 'none' };
  const stated = metalsStatedPremium(premium);
  if (stated === null || unitPriceMinor <= 0) return { kind: 'premium-disagreement' };
  const spotMinor = subtract(divide(rational(BigInt(unitPriceMinor)), fineTroyOzPerUnit), rational(stated.amountMinor));
  if (spotMinor.num <= 0n || !reconciles(stated, BigInt(unitPriceMinor), fineTroyOzPerUnit)) return { kind: 'premium-disagreement' };
  return { kind: 'implied', spot: divide(spotMinor, rational(100n)) };
}
