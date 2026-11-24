import { describe, expect, it } from 'vitest';

import { formatRational, rational } from '@finance-tracker/shared/metals-ledger';

import { metalsDealerSpot, metalsStatedPremium } from './premiumText.js';

// Synthetic premiums only: invented prices and premiums in the converter's closed form.

const ONE = rational(1n);
const spotOf = (result: ReturnType<typeof metalsDealerSpot>) => (result.kind === 'implied' ? formatRational(result.spot) : result.kind);

describe('metals premium text (metals-premium-text-v1)', () => {
  it('computes the dealer\'s spot from a dollar premium per troy ounce', () => {
    // $2,075.00 for one troy ounce with $75.00 per troy ounce over spot: spot $2,000.00, +3.75%.
    expect(spotOf(metalsDealerSpot({ text: 'spot +3.7500% / +$75.00 per troy ounce', basis: 'troy_ounce' }, 207500, ONE))).toBe('2000/1');
    // A ten-ounce bar at $20,750.00 with $75.00 per troy ounce over spot: 20750 ÷ 10 − 75 = $2,000.00 per troy ounce.
    expect(spotOf(metalsDealerSpot({ text: 'spot +3.7500% / +$75.00 per troy ounce', basis: 'troy_ounce' }, 2075000, rational(10n)))).toBe('2000/1');
    // Below spot, thousands separated, and at spot.
    expect(spotOf(metalsDealerSpot({ text: 'spot -1.0000% / -$20.20 per troy ounce', basis: 'troy_ounce' }, 199980, ONE))).toBe('2020/1');
    expect(spotOf(metalsDealerSpot({ text: 'spot +50.0000% / +$1,000.00 per troy ounce', basis: 'troy_ounce' }, 300000, ONE))).toBe('2000/1');
    expect(spotOf(metalsDealerSpot({ text: 'spot +0.0000% / +$0.00 per troy ounce', basis: 'troy_ounce' }, 200000, ONE))).toBe('2000/1');
  });

  it('gives no dealer spot for a premium stated per unit, whatever its text, and flags nothing (§9: per troy ounce only)', () => {
    // A ten-ounce bar at $20,750.00 with $750.00 per unit over spot: per unit, S checks D against U alone.
    expect(metalsDealerSpot({ text: 'spot +3.7500% / +$750.00 per unit', basis: 'unit' }, 2075000, rational(10n)).kind).toBe('none');
    // So wrong content (one ounce, not ten) passes that check: read per unit, it would imply a spot of $20,000.00.
    expect(metalsDealerSpot({ text: 'spot +3.7500% / +$750.00 per unit', basis: 'unit' }, 2075000, ONE).kind).toBe('none');
    for (const text of ['spot +3.7500% / +$1,500.00 per unit', 'spot +9.0000% / +$750.00 per unit', 'spot +3.7500% / +$75.00 per troy ounce', '2.5']) {
      expect(metalsDealerSpot({ text, basis: 'unit' }, 2075000, rational(10n)).kind).toBe('none');
    }
    // Per troy ounce, the same wrong content fails the check: flagged, never valued.
    expect(metalsDealerSpot({ text: 'spot +3.7500% / +$75.00 per troy ounce', basis: 'troy_ounce' }, 2075000, ONE).kind).toBe('premium-disagreement');
  });

  it('checks the percent within the stated roundings, so silver\'s half cent is no disagreement', () => {
    // True premium 36.5¢ on $25.37: +1.4597% (to 4 decimals), and the dollar premium states $0.37. A fixed 0.01-point
    // tolerance would refuse it (37 ÷ 2500 = 1.48%, 0.02 points away); the stated roundings admit it.
    expect(spotOf(metalsDealerSpot({ text: 'spot +1.4597% / +$0.37 per troy ounce', basis: 'troy_ounce' }, 2537, ONE))).toBe('25/1');
  });

  it('flags a premium whose percent and dollars disagree, or that can\'t be read; nothing stated is no flag', () => {
    const disagree = [
      { text: 'spot +9.0000% / +$75.00 per troy ounce', basis: 'troy_ounce' as const },
      { text: 'spot +3.7500% / +$75.00 per unit', basis: 'troy_ounce' as const },
      { text: 'spot +3.7500% / -$75.00 per troy ounce', basis: 'troy_ounce' as const },
      { text: 'spot +3.75% / +$75.00 per troy ounce', basis: 'troy_ounce' as const },
      { text: '2.5', basis: 'troy_ounce' as const },
      { text: 'spot +3.7500% / +$75.00 per troy ounce ', basis: 'troy_ounce' as const },
      { text: 'spot +3.7500% / +$75.00 per troy ounce', basis: 'troy_ounce' as const, price: 7000 },
    ];
    for (const premium of disagree) {
      expect(metalsDealerSpot({ text: premium.text, basis: premium.basis }, premium.price ?? 207500, ONE).kind).toBe('premium-disagreement');
    }
    expect(metalsDealerSpot(null, 207500, ONE).kind).toBe('none');
    expect(metalsDealerSpot({ text: 'spot +3.7500% / +$75.00 per troy ounce', basis: 'troy_ounce' }, 207500, null).kind).toBe('none');
    expect(metalsDealerSpot({ text: 'spot +3.7500% / +$75.00 per troy ounce', basis: 'troy_ounce' }, null, ONE).kind).toBe('none');
  });

  it('reads the closed form exactly, signs and basis words included', () => {
    expect(metalsStatedPremium({ text: 'spot -0.5000% / -$1,234.56 per unit', basis: 'unit' }))
      .toEqual({ percent: rational(-1n, 2n), amountMinor: -123456n, basis: 'unit' });
    expect(metalsStatedPremium({ text: 'spot +0.0000% / +$0.00 per unit', basis: 'unit' })).toEqual({ percent: rational(0n), amountMinor: 0n, basis: 'unit' });
    expect(metalsStatedPremium({ text: 'spot +0.0000% / -$0.00 per unit', basis: 'unit' })).toBeNull();
    expect(metalsStatedPremium({ text: 'spot +1.0000% / +$0.00 per unit', basis: 'unit' })).toBeNull();
    expect(metalsStatedPremium({ text: 'spot +1.0000% / +$1234.56 per unit', basis: 'unit' })).toBeNull();
  });
});
