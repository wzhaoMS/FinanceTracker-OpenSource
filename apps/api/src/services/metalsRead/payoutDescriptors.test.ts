import { describe, expect, it } from 'vitest';

import { METALS_SOURCES } from '@finance-tracker/shared/metals-ledger';

import { METALS_PAYOUT_DESCRIPTORS, metalsPayoutOriginSources } from './payoutDescriptors.js';

// Synthetic descriptions only: the counterparty name and invented texts, letters only, with no digits or values.

describe('metals payout descriptors: the counterparty name, for CollectPure payouts only', () => {
  it('names CollectPure for a credit that carries the counterparty name, in any case, with spaces, dots or hyphens between its words', () => {
    for (const description of ['PM TECHNOLOGIES PO BALANCE', 'PM Technologies', 'pm-technologies', 'PM. TECHNOLOGIES', 'ACH CREDIT PM TECHNOLOGIES']) {
      expect(metalsPayoutOriginSources(description), description).toEqual(['collectpure']);
    }
  });

  it('names no source for entry text alone, half the name, the name inside longer words, the dealer\'s own name, or nothing', () => {
    for (const description of ['PO BALANCE', 'PM', 'TECHNOLOGIES', 'XPM TECHNOLOGIES', 'PM TECHNOLOGIESX', 'COLLECTPURE ACH CREDIT', '']) {
      expect(metalsPayoutOriginSources(description), description).toEqual([]);
    }
    expect(metalsPayoutOriginSources(undefined as unknown as string)).toEqual([]);
  });

  it('is closed and keyed by source, frozen at both levels: CollectPure only, no digits, and no pattern that keeps state', () => {
    expect(Object.isFrozen(METALS_PAYOUT_DESCRIPTORS)).toBe(true);
    expect(Object.keys(METALS_PAYOUT_DESCRIPTORS)).toEqual(['collectpure']);
    for (const source of METALS_SOURCES) {
      const patterns = METALS_PAYOUT_DESCRIPTORS[source];
      if (patterns === undefined) continue;
      expect(Object.isFrozen(patterns), source).toBe(true);
      for (const pattern of patterns) {
        expect([pattern.global, pattern.sticky], String(pattern)).toEqual([false, false]);
        expect(/\d/.test(pattern.source), String(pattern)).toBe(false);
      }
    }
    // Asked again, the same answer: no pattern carries its last match into the next call.
    expect(['PM TECHNOLOGIES', 'PM TECHNOLOGIES', 'pm technologies'].map((description) => metalsPayoutOriginSources(description)))
      .toEqual([['collectpure'], ['collectpure'], ['collectpure']]);
  });
});
