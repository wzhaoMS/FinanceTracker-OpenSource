/**
 * `METALS_COIN_SPECS` v1 ('metals-coin-specs-v1'): a closed, reviewed table of sovereign gold bullion coins whose
 * issuer states each legal denomination as the coin's fine gold content, from the issuers' public specifications (no
 * household data). The American Gold Eagle's "1 oz" is one troy ounce of fine gold in a 22-karat coin that weighs more,
 * so a stated purity is never applied to a denomination.
 *
 * v1 holds gold coins only. Silver, platinum and palladium coins, the Panda (gram denominations at a stated fineness)
 * and every denomination not listed are for the owner to confirm. Any change to the table is a new version.
 *
 * Pure: no file system, network or clock.
 */

import type { Metal, MetalsCoinDesign, MetalsStatedMass } from './model.js';
import { METALS_RULES } from './model.js';
import { equals, parseRational, rational, type Rational } from './rational.js';

export const METALS_COIN_SPECS_VERSION = METALS_RULES.coinSpecs;

/** One coin design in one metal: each denomination in troy ounces, mapped to its fine troy ounces per coin. */
export interface MetalsCoinSpec {
  design: MetalsCoinDesign;
  metal: Metal;
  denominations: ReadonlyArray<{ troyOz: Rational; fineTroyOz: Rational }>;
}

const ounces = (...denominations: Array<[bigint, bigint]>) =>
  denominations.map(([num, den]) => ({ troyOz: rational(num, den), fineTroyOz: rational(num, den) }));

export const METALS_COIN_SPECS: readonly MetalsCoinSpec[] = Object.freeze([
  { design: 'eagle', metal: 'XAU', denominations: ounces([1n, 1n], [1n, 2n], [1n, 4n], [1n, 10n]) },
  { design: 'buffalo', metal: 'XAU', denominations: ounces([1n, 1n]) },
  { design: 'maple-leaf', metal: 'XAU', denominations: ounces([1n, 1n], [1n, 2n], [1n, 4n], [1n, 10n], [1n, 20n]) },
  { design: 'krugerrand', metal: 'XAU', denominations: ounces([1n, 1n], [1n, 2n], [1n, 4n], [1n, 10n]) },
  { design: 'britannia', metal: 'XAU', denominations: ounces([1n, 1n], [1n, 2n], [1n, 4n], [1n, 10n]) },
  { design: 'philharmonic', metal: 'XAU', denominations: ounces([1n, 1n], [1n, 2n], [1n, 4n], [1n, 10n], [1n, 25n]) },
  { design: 'kangaroo', metal: 'XAU', denominations: ounces([1n, 1n], [1n, 2n], [1n, 4n], [1n, 10n], [1n, 20n]) },
] satisfies MetalsCoinSpec[]);

/**
 * The fine troy ounces per coin a specification gives a title's stated mass, or null: the design and metal must be
 * listed, and the stated mass, in troy ounces as written (`oz` or `ozt`; a bare `oz` is read as troy only here), must
 * equal one of that design's denominations exactly. The caller decides whether a specification may apply at all
 * (§4.4.1: Walmart and CollectPure only, a `single` pack, mass basis `none`).
 */
export function metalsCoinSpecification(
  design: MetalsCoinDesign | null,
  metal: Metal | null,
  statedMass: MetalsStatedMass | null,
): Rational | null {
  if (design === null || metal === null || statedMass === null) return null;
  if (statedMass.unit !== 'oz' && statedMass.unit !== 'ozt') return null;
  const stated = parseRational(statedMass.value);
  if (stated === null) return null;
  const spec = METALS_COIN_SPECS.find((entry) => entry.design === design && entry.metal === metal);
  return spec?.denominations.find((denomination) => equals(denomination.troyOz, stated))?.fineTroyOz ?? null;
}
