import { describe, expect, it } from 'vitest';

import { metalsEstimateUnmatchedOf, metalsFungibleOf, parseMetalsEstimateUnmatched, parseMetalsFungible } from './policy.js';

// Synthetic values only: no file, network or clock.

describe('the owner\'s metals assignment policy, HOLDR_METALS_FUNGIBLE', () => {
  it('reads a comma list of distinct metals, as METALS spells them, in METALS order', () => {
    expect(parseMetalsFungible('XAU')).toEqual(['XAU']);
    expect(parseMetalsFungible('XAG,XAU')).toEqual(['XAU', 'XAG']);
    expect(parseMetalsFungible('XPD,XPT,XAG,XAU')).toEqual(['XAU', 'XAG', 'XPT', 'XPD']);
  });

  it('refuses anything else: empty, a repeat, another spelling, spaces, an empty item, another metal', () => {
    for (const value of ['', 'XAU,XAU', 'xau', 'Xau', ' XAU', 'XAU ', 'XAU, XAG', 'XAU,', ',XAU', 'XAU,,XAG', 'GOLD', 'XAU;XAG', 'XAU XAG', '1']) {
      expect(parseMetalsFungible(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('is none unless the environment names such a list', () => {
    expect(metalsFungibleOf({})).toEqual([]);
    expect(metalsFungibleOf({ HOLDR_METALS_FUNGIBLE: 'XAU' })).toEqual(['XAU']);
    expect(metalsFungibleOf({ HOLDR_METALS_FUNGIBLE: 'XAG,XAU' })).toEqual(['XAU', 'XAG']);
    for (const value of ['', 'xau', 'XAU,XAU', '1']) expect(metalsFungibleOf({ HOLDR_METALS_FUNGIBLE: value }), JSON.stringify(value)).toEqual([]);
  });
});

describe('the owner\'s estimate switch, HOLDR_METALS_ESTIMATE_UNMATCHED', () => {
  it('reads the same grammar as HOLDR_METALS_FUNGIBLE, and refuses the same values', () => {
    expect(parseMetalsEstimateUnmatched('XAU')).toEqual(['XAU']);
    expect(parseMetalsEstimateUnmatched('XAG,XAU')).toEqual(['XAU', 'XAG']);
    for (const value of ['', 'XAU,XAU', 'xau', ' XAU', 'XAU, XAG', 'XAU,', 'GOLD', '1']) {
      expect(parseMetalsEstimateUnmatched(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('is none unless the environment names such a list, and is independent of the fungible policy', () => {
    expect(metalsEstimateUnmatchedOf({})).toEqual([]);
    expect(metalsEstimateUnmatchedOf({ HOLDR_METALS_FUNGIBLE: 'XAU' })).toEqual([]);
    expect(metalsEstimateUnmatchedOf({ HOLDR_METALS_ESTIMATE_UNMATCHED: 'XAU' })).toEqual(['XAU']);
    expect(metalsFungibleOf({ HOLDR_METALS_ESTIMATE_UNMATCHED: 'XAU' })).toEqual([]);
    for (const value of ['', 'xau', 'XAU,XAU', '1']) {
      expect(metalsEstimateUnmatchedOf({ HOLDR_METALS_ESTIMATE_UNMATCHED: value }), JSON.stringify(value)).toEqual([]);
    }
  });
});
