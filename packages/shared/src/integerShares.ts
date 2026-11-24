/**
 * Integer shares of amounts in minor units, exact: BigInt arithmetic, no floating point. Extracted from the Amazon
 * domain (Costco receipts 4/7 §2.1), whose largestRemainder, taxShare and lineAmount are these, so every source of card
 * category splits rounds by one arithmetic. Pure and deterministic.
 */

/** One weight to share by: its key, its positive weight, and the stable key that breaks a tied remainder. */
export interface IntegerShareWeight {
  readonly ref: string;
  readonly weight: bigint;
  readonly tie: string;
}

/**
 * `total` units shared by weight: each weight first gets its floor share, then the units left over go one each to the
 * largest remainders, and a tied remainder goes to the lower `tie` by JS string order. A tie is a stable identity, so
 * reading the same facts again moves no unit. The shares add up to the total exactly, and the map lists the weights
 * from the largest remainder down. Refused unless the total is nonnegative and there is at least one weight, each
 * positive, with no ref or tie used twice.
 */
export function largestRemainderUnits(total: bigint, weights: readonly IntegerShareWeight[]): Map<string, bigint> {
  if (total < 0n || weights.length === 0 || weights.some((w) => w.weight <= 0n)
    || new Set(weights.map((w) => w.ref)).size !== weights.length || new Set(weights.map((w) => w.tie)).size !== weights.length) {
    throw new RangeError('integer shares refused');
  }
  const denominator = weights.reduce((n, w) => n + w.weight, 0n);
  const parts = weights.map((w) => ({ ref: w.ref, tie: w.tie, units: total * w.weight / denominator, remainder: total * w.weight % denominator }));
  let left = total - parts.reduce((n, p) => n + p.units, 0n);
  parts.sort((a, b) => (a.remainder === b.remainder ? (a.tie < b.tie ? -1 : 1) : a.remainder > b.remainder ? -1 : 1));
  for (const p of parts) if (left > 0n) { p.units++; left--; }
  return new Map(parts.map((p) => [p.ref, p.units]));
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * A pre-tax base's share of a tax, base × tax / items subtotal, rounded half up to the unit, in BigInt. Zero unless
 * the tax and the subtotal are positive safe integers.
 */
export function taxShare(baseMinor: number, taxMinor: number, itemsSubtotalMinor: number | null): number {
  if (!positive(taxMinor) || !positive(itemsSubtotalMinor)) return 0;
  const subtotal = BigInt(itemsSubtotalMinor);
  return Number((2n * BigInt(baseMinor) * BigInt(taxMinor) + subtotal) / (2n * subtotal));
}

/** The tax-inclusive amount of `units` units of one line: the share is taken on the line's units together. */
export function lineAmount(
  order: { readonly taxMinor: number; readonly itemsSubtotalMinor: number | null },
  line: { readonly unitMinor: number },
  units: number,
): number {
  const base = line.unitMinor * units;
  return base + taxShare(base, order.taxMinor, order.itemsSubtotalMinor);
}
