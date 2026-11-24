import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { add, parseRational, rational, troyOunces, type Rational } from '../rational.js';
import {
  METALS_PRICE_SOURCE,
  metalsCloseOnOrBefore,
  metalsCycleBySpot,
  metalsPriceStale,
  metalsPriceSymbol,
  metalsScreenCloses,
  metalsValueMinor,
  metalsValueParts,
  metalsWeekdaysBetween,
  type MetalsPriceBar,
} from './valuation.js';

/** Synthetic series only: invented round closes, no feed and no network. 2030-03-01 is a Friday. */
const bar = (date: string, close: string): MetalsPriceBar => ({ date, close });
const usd = (text: string): Rational => parseRational(text)!;
const TODAY = '2030-12-31';
const dates = (screen: ReturnType<typeof metalsScreenCloses>) => screen.admissible.map((entry) => entry.date);

describe('valuation: which daily close may value a date (GD-11)', () => {
  it('today\'s bar never counts, nor a later one: only completed New York sessions', () => {
    const screen = metalsScreenCloses([bar('2030-03-04', '2000'), bar('2030-03-05', '2001'), bar('2030-03-06', '2002')], '2030-03-05');
    assert.deepEqual(dates(screen), ['2030-03-04']);
    assert.deepEqual(screen.refused, [{ date: '2030-03-05', reason: 'incomplete' }, { date: '2030-03-06', reason: 'incomplete' }]);
    assert.equal(metalsCloseOnOrBefore(screen.admissible, '2030-03-05')!.date, '2030-03-04');
  });

  it('a weekend, holiday or month-end date uses the prior close, with its date; never a later one', () => {
    const screen = metalsScreenCloses([
      bar('2030-03-07', '2000'), bar('2030-03-08', '2010'), bar('2030-03-11', '2020'),
      bar('2030-03-28', '2030'), bar('2030-03-29', '2040'), bar('2030-04-01', '2050'),
      bar('2030-07-03', '2060'), bar('2030-07-05', '2070'),
    ], TODAY);
    const on = (date: string) => {
      const close = metalsCloseOnOrBefore(screen.admissible, date)!;
      return [close.date, close.close];
    };
    assert.deepEqual(on('2030-03-09'), ['2030-03-08', usd('2010')]);
    assert.deepEqual(on('2030-03-10'), ['2030-03-08', usd('2010')]);
    assert.deepEqual(on('2030-03-11'), ['2030-03-11', usd('2020')]);
    assert.deepEqual(on('2030-03-31'), ['2030-03-29', usd('2040')]);
    assert.deepEqual(on('2030-07-04'), ['2030-07-03', usd('2060')]);
    assert.equal(metalsCloseOnOrBefore(screen.admissible, '2030-03-06'), null);
  });

  it('duplicate identical bars count once; two different closes for one date refuse it, and the close before stands in', () => {
    const screen = metalsScreenCloses([
      bar('2030-03-04', '2000'), bar('2030-03-04', '2000.00'), bar('2030-03-05', '2001'), bar('2030-03-05', '2002'),
    ], TODAY);
    assert.deepEqual(screen.admissible, [{ date: '2030-03-04', close: usd('2000'), thinHistory: true }]);
    assert.deepEqual(screen.refused, [{ date: '2030-03-05', reason: 'bar-conflict' }]);
    assert.equal(metalsCloseOnOrBefore(screen.admissible, '2030-03-05')!.date, '2030-03-04');
  });

  it('refuses a close that is not a finite positive decimal, and a date that is not a real day', () => {
    const closes = ['0', '0.000', '-1', '1e3', 'abc', '', '2000.1234567', '12345678', ' 2000'];
    const screen = metalsScreenCloses(closes.map((close, index) => bar(`2030-03-${String(index + 1).padStart(2, '0')}`, close)), TODAY);
    assert.deepEqual(screen.admissible, []);
    assert.deepEqual(screen.refused.map((entry) => entry.reason), closes.map(() => 'unreadable'));
    const malformed = metalsScreenCloses([bar('2030-02-30', '2000'), bar('2030-3-4', '2000'), bar('30-03-04', '2000')], TODAY);
    assert.deepEqual(malformed.refused.map((entry) => entry.reason), ['unreadable', 'unreadable', 'unreadable']);
    const conflict = metalsScreenCloses([bar('2030-03-04', 'abc'), bar('2030-03-04', '2000')], TODAY);
    assert.deepEqual(conflict.refused, [{ date: '2030-03-04', reason: 'bar-conflict' }]);
  });

  it('thin history: the first three admissible closes are flagged and the outlier check can\'t run on them', () => {
    const screen = metalsScreenCloses([
      bar('2030-03-01', '2000'), bar('2030-03-04', '2400'), bar('2030-03-05', '1600'), bar('2030-03-06', '2000'),
    ], TODAY);
    assert.deepEqual(screen.admissible.map((entry) => [entry.date, entry.thinHistory]), [
      ['2030-03-01', true], ['2030-03-04', true], ['2030-03-05', true], ['2030-03-06', false],
    ]);
    assert.deepEqual(screen.refused, []);
  });

  it('the 20% rule against the median of up to five previous admissible closes; exactly 20% passes, and a refused bar never enters a later median', () => {
    const screen = metalsScreenCloses([
      bar('2030-03-01', '2000'), bar('2030-03-04', '2000'), bar('2030-03-05', '2000'), bar('2030-03-06', '2000'), bar('2030-03-07', '2000'),
      bar('2030-03-08', '2400'),
      bar('2030-03-11', '2400.01'),
      bar('2030-03-12', '1600'),
      bar('2030-03-13', '1599.99'),
    ], TODAY);
    assert.deepEqual(dates(screen), ['2030-03-01', '2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08', '2030-03-12']);
    assert.deepEqual(screen.refused, [{ date: '2030-03-11', reason: 'outlier' }, { date: '2030-03-13', reason: 'outlier' }]);
    assert.equal(metalsCloseOnOrBefore(screen.admissible, '2030-03-11')!.date, '2030-03-08');
  });

  it('an even count of previous closes uses the mean of the middle two; only the last five count', () => {
    const even = (close: string) => metalsScreenCloses([
      bar('2030-03-01', '2000'), bar('2030-03-04', '2100'), bar('2030-03-05', '2000'), bar('2030-03-06', '2100'), bar('2030-03-07', close),
    ], TODAY);
    assert.deepEqual(even('2460').refused, []);
    assert.deepEqual(even('2460.01').refused, [{ date: '2030-03-07', reason: 'outlier' }]);
    assert.deepEqual(even('1640').refused, []);
    assert.deepEqual(even('1639.99').refused, [{ date: '2030-03-07', reason: 'outlier' }]);
    const recent = metalsScreenCloses([
      ...['01', '04', '05', '06', '07'].map((day) => bar(`2030-03-${day}`, '1000')),
      ...['08', '11', '12', '13'].map((day) => bar(`2030-03-${day}`, '1190')),
      bar('2030-03-14', '1400'),
    ], TODAY);
    assert.deepEqual(recent.refused, []);
  });

  it('missing history gives no close (price-missing), never zero', () => {
    assert.equal(metalsCloseOnOrBefore([], '2030-03-04'), null);
    const later = metalsScreenCloses([bar('2030-03-05', '2000')], TODAY);
    assert.equal(metalsCloseOnOrBefore(later.admissible, '2030-03-04'), null);
    const refusedOnly = metalsScreenCloses([bar('2030-03-01', '0'), bar('2030-03-04', '2000'), bar('2030-03-04', '2001')], TODAY);
    assert.equal(metalsCloseOnOrBefore(refusedOnly.admissible, '2030-03-08'), null);
  });

  it('a close more than five weekdays older than the date is stale', () => {
    assert.equal(metalsWeekdaysBetween('2030-03-01', '2030-03-01'), 0);
    assert.equal(metalsWeekdaysBetween('2030-03-01', '2030-03-04'), 1);
    assert.equal(metalsWeekdaysBetween('2030-03-01', '2030-03-08'), 5);
    assert.equal(metalsWeekdaysBetween('2030-03-01', '2030-03-10'), 5);
    assert.equal(metalsWeekdaysBetween('2030-03-01', '2030-03-11'), 6);
    assert.equal(metalsPriceStale('2030-03-01', '2030-03-08'), false);
    assert.equal(metalsPriceStale('2030-03-01', '2030-03-10'), false);
    assert.equal(metalsPriceStale('2030-03-01', '2030-03-11'), true);
  });

  it('names its source and its cache symbol, never a ticker', () => {
    assert.equal(METALS_PRICE_SOURCE, 'cnbc-spot-daily');
    assert.equal(metalsPriceSymbol('XAU'), 'holdr:metal:XAU');
  });
});

describe('valuation: value at spot', () => {
  it('rounds once, half to even, from exact ounces', () => {
    const close = usd('2000.01');
    assert.equal(metalsValueMinor(rational(1n, 2n), close), 100000);
    assert.equal(metalsValueMinor(rational(3n, 2n), close), 300002);
    assert.equal(metalsValueMinor(add(rational(1n, 2n), rational(1n, 2n)), close), 200001);
    assert.equal(metalsValueMinor(troyOunces(usd('10'), 'g'), usd('3110.34768')), 100000);
    assert.equal(metalsValueMinor(troyOunces(usd('31.1034768'), 'g'), close), 200001);
    assert.throws(() => metalsValueMinor(rational(10n ** 12n), usd('2000')), RangeError);
  });

  it('values a holding once and splits it over its parts by largest remainder, the parts adding up exactly', () => {
    const close = usd('2000.01');
    assert.deepEqual(metalsValueParts([rational(1n, 2n), rational(1n, 2n)], close), { totalMinor: 200001, partsMinor: [100001, 100000] });
    assert.deepEqual(metalsValueParts([rational(1n, 10n), rational(1n), rational(1n, 2n)], usd('2000')), { totalMinor: 320000, partsMinor: [20000, 200000, 100000] });
    const thirds = metalsValueParts([rational(1n, 3n), rational(1n, 3n), rational(1n, 3n)], usd('1'));
    assert.deepEqual(thirds, { totalMinor: 100, partsMinor: [34, 33, 33] });
    assert.deepEqual(metalsValueParts([], close), { totalMinor: 0, partsMinor: [] });
    assert.deepEqual(metalsValueParts([rational(0n), rational(0n)], close), { totalMinor: 0, partsMinor: [0, 0] });
    assert.throws(() => metalsValueParts([rational(-1n)], close), RangeError);
  });
});

describe('valuation: a cycle\'s result by spot (GD-06)', () => {
  const cycle = { fineTroyOz: rational(1n), costMinor: 210000, costComplete: true, proceedsMinor: 230000, profitMinor: 20000 };

  it('splits a known result into the spot price\'s change and premiums and fees', () => {
    assert.deepEqual(metalsCycleBySpot({ ...cycle, purchaseSpot: usd('2000'), saleSpot: usd('2150') }), {
      premiumPaidPerOzMinor: 10000, salePremiumPerOzMinor: 15000, fromSpotMinor: 15000, fromPremiumsMinor: 5000,
    });
  });

  it('missing prices leave the decomposition unknown, never zero', () => {
    assert.deepEqual(metalsCycleBySpot({ ...cycle, purchaseSpot: null, saleSpot: usd('2150') }), {
      premiumPaidPerOzMinor: null, salePremiumPerOzMinor: 15000, fromSpotMinor: null, fromPremiumsMinor: null,
    });
    assert.deepEqual(metalsCycleBySpot({ ...cycle, purchaseSpot: usd('2000'), saleSpot: null }), {
      premiumPaidPerOzMinor: 10000, salePremiumPerOzMinor: null, fromSpotMinor: null, fromPremiumsMinor: null,
    });
  });

  it('an incomplete cost leaves the premium paid and the premiums part unknown; the spot part still shows', () => {
    assert.deepEqual(metalsCycleBySpot({ ...cycle, costComplete: false, profitMinor: null, purchaseSpot: usd('2000'), saleSpot: usd('2150') }), {
      premiumPaidPerOzMinor: null, salePremiumPerOzMinor: 15000, fromSpotMinor: 15000, fromPremiumsMinor: null,
    });
  });

  it('rounds per-ounce figures once, half to even, and refuses a cycle with no ounces', () => {
    const three = { fineTroyOz: rational(3n), costMinor: 1000000, costComplete: true, proceedsMinor: 1000001, profitMinor: 1, purchaseSpot: usd('3000'), saleSpot: usd('3000.005') };
    assert.deepEqual(metalsCycleBySpot(three), { premiumPaidPerOzMinor: 33333, salePremiumPerOzMinor: 33333, fromSpotMinor: 2, fromPremiumsMinor: -1 });
    assert.throws(() => metalsCycleBySpot({ ...cycle, fineTroyOz: rational(0n), purchaseSpot: null, saleSpot: null }), RangeError);
  });
});
