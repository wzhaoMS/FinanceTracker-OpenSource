/**
 * The owner's assignment policy (contract `MetalsAssignmentMethod`): `HOLDR_METALS_FUNGIBLE`, one holdr.conf line read
 * like `HOLDR_METALS_PRICES` (control/holdrConf.ts refuses any other value; index.ts reads it from the effective
 * environment), a comma list of the metals whose units the owner holds fungible: `XAU`, or `XAU,XAG`. Unset, every read
 * is metals-assignment-v1's byte for byte. A metal it names is assigned oldest first across forms (one class per fine
 * troy oz per unit, form `any`), and a unit a sale took from awaiting reads delivered as of the sale's agreed day.
 *
 * The owner's estimate switch (contract `MetalsCostEstimateMethod`): `HOLDR_METALS_ESTIMATE_UNMATCHED`, one holdr.conf
 * line read the same way and of the same grammar, the metals whose sold units with no recorded purchase take a cost
 * estimated from the nearest purchase of their class (`metals-estimate-nearest-v1`). Unset, every read is as before
 * byte for byte.
 */

import { METALS, type Metal } from '@finance-tracker/shared/metals-ledger';

/** A value's metals, in METALS order: a comma list of distinct metals, each exactly as METALS spells it; else null. */
export function parseMetalsFungible(value: string): Metal[] | null {
  const names = value.split(',');
  if (new Set(names).size !== names.length || names.some((name) => !(METALS as readonly string[]).includes(name))) return null;
  return METALS.filter((metal) => names.includes(metal));
}

/** The metals an environment's `HOLDR_METALS_FUNGIBLE` names; none when it is unset, or anything but such a list. */
export function metalsFungibleOf(env: NodeJS.ProcessEnv): Metal[] {
  const value = env.HOLDR_METALS_FUNGIBLE;
  return value === undefined ? [] : parseMetalsFungible(value) ?? [];
}

/** `HOLDR_METALS_ESTIMATE_UNMATCHED`'s metals: the same grammar as `HOLDR_METALS_FUNGIBLE`'s (`parseMetalsFungible`). */
export function parseMetalsEstimateUnmatched(value: string): Metal[] | null {
  return parseMetalsFungible(value);
}

/** The metals an environment's `HOLDR_METALS_ESTIMATE_UNMATCHED` names; none when it is unset, or anything but such a list. */
export function metalsEstimateUnmatchedOf(env: NodeJS.ProcessEnv): Metal[] {
  const value = env.HOLDR_METALS_ESTIMATE_UNMATCHED;
  return value === undefined ? [] : parseMetalsEstimateUnmatched(value) ?? [];
}
