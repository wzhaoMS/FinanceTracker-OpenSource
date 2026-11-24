/**
 * `METALS_PAYOUT_DESCRIPTORS` (design v8 §4.4.5): the closed, reviewed origin texts of each source's ACH payouts, keyed
 * by source and frozen at both levels. A checking credit whose description names a source's text can prove, and
 * contest, a deposit link of that source's payouts only (`originSources`, G1d's `metalsDepositLinks`).
 *
 * It holds one text, for CollectPure's payouts only: the counterparty name they carry, PM Technologies, as whole words,
 * in any case, with any spaces, dots or hyphens between them. Never ACH entry text, digits or a value. Reviewed from
 * ROOT's value-free clone count. A credit that names no source's text is at most a possible deposit, never a link, and
 * classifies nothing.
 */

import { METALS_SOURCES, type MetalsSource } from '@finance-tracker/shared/metals-ledger';

export const METALS_PAYOUT_DESCRIPTORS: Readonly<Partial<Record<MetalsSource, readonly RegExp[]>>> = Object.freeze({
  collectpure: Object.freeze([/\bpm[\s.\-]*technologies\b/i]),
});

/** The sources whose reviewed origin text a checking credit's description names, in METALS_SOURCES order. */
export function metalsPayoutOriginSources(description: string): MetalsSource[] {
  if (typeof description !== 'string') return [];
  return METALS_SOURCES.filter((source) => (METALS_PAYOUT_DESCRIPTORS[source] ?? []).some((pattern) => pattern.test(description)));
}
