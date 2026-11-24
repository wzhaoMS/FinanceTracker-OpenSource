import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardMonthInsightPeriod, computeCardInsights, findRecurringCharges, type CardInsightRow } from './cardInsights.js';

// Synthetic rows: fictional merchants and made-up amounts.
let next = 0;
function tx(transactionDate: string, amountMinor: number, description: string, extra: Partial<CardInsightRow> = {}): CardInsightRow {
  next += 1;
  return {
    id: `card-txn-${next}`,
    cardAccountId: 'card-a',
    transactionDate,
    status: 'posted',
    amountMinor,
    currency: 'USD',
    kind: amountMinor < 0 ? 'refund' : 'purchase',
    description,
    merchant: null,
    issuerCategory: null,
    userCategory: null,
    ...extra,
  };
}

function monthly(description: string, amounts: number[], startMonth: number, day = 3, year = 2026): CardInsightRow[] {
  return amounts.map((amount, index) => tx(`${year}-${String(startMonth + index).padStart(2, '0')}-${String(day).padStart(2, '0')}`, amount, description));
}

const TODAY = '2026-10-16';

describe('findRecurringCharges', () => {
  it('keeps wallet merchants and their price changes separate and ignores non-merchant remnants', () => {
    const rows = [
      ...monthly('AplPay SQ *SAMPLE STREAMING', [1500, 1500, 1500, 1800], 7),
      ...monthly('AplPay SAMPLE NEWS', [700, 700, 700, 700], 7),
      ...monthly('APLPAY', [900, 900, 900, 900], 7),
      ...monthly('APPLE PAY #A123', [900, 900, 900, 900], 7),
      ...monthly('PADDLE.NET', [900, 900, 900, 900], 7),
    ];
    const charges = findRecurringCharges(rows, TODAY);
    assert.deepEqual(charges.map((charge) => [charge.key, charge.occurrences, charge.priceChange]), [
      ['SAMPLE STREAMING', 4, { fromMinor: 1500, toMinor: 1800, since: '2026-10-03' }],
      ['SAMPLE NEWS', 4, null],
    ]);
  });

  it('finds a fixed monthly charge with its next date and monthly cost', () => {
    const [charge] = findRecurringCharges(monthly('NETFLIX.COM', [1549, 1549, 1549, 1549, 1549, 1549], 5), TODAY);
    assert.deepEqual({ ...charge, cardAccountIds: charge.cardAccountIds }, {
      key: 'NETFLIX.COM', merchant: 'NETFLIX.COM', cadence: 'monthly', fixed: true, typicalMinor: 1549, lastMinor: 1549,
      firstDate: '2026-05-03', lastDate: '2026-10-03', nextDate: '2026-11-02', occurrences: 6, monthlyMinor: 1549, active: true, priceChange: null,
      cardAccountIds: ['card-a'],
    });
  });

  it('reports a price change, from the first new charge on', () => {
    const [once] = findRecurringCharges(monthly('SAMPLE STREAMING', [1549, 1549, 1549, 1549, 1549, 1799], 5), TODAY);
    assert.deepEqual(once.priceChange, { fromMinor: 1549, toMinor: 1799, since: '2026-10-03' });
    assert.equal(once.typicalMinor, 1799);
    assert.equal(once.fixed, true);
    const [twice] = findRecurringCharges(monthly('SAMPLE STREAMING', [1549, 1549, 1549, 1549, 1799, 1799], 5), TODAY);
    assert.deepEqual(twice.priceChange, { fromMinor: 1549, toMinor: 1799, since: '2026-09-03' });
    const [cents] = findRecurringCharges(monthly('SAMPLE STREAMING', [1549, 1549, 1549, 1549, 1549, 1550], 5), TODAY);
    assert.equal(cents.priceChange, null);
  });

  it('treats a monthly charge whose amount keeps changing as a bill', () => {
    const [bill] = findRecurringCharges(monthly('WIDE WORLD UTILITIES', [9000, 12000, 10500, 14000, 9800], 6, 12), TODAY);
    assert.equal(bill.cadence, 'monthly');
    assert.equal(bill.fixed, false);
    assert.equal(bill.priceChange, null);
    assert.equal(bill.typicalMinor, 10500);
  });

  it('separates subscriptions billed under one descriptor', () => {
    const rows = [
      ...monthly('APPLE.COM/BILL 866-712-7753 CA', [299, 299, 299, 299, 299, 299], 5, 10),
      ...monthly('APPLE.COM/BILL 866-712-7753 CA', [999, 999, 999, 999, 999, 999], 5, 20),
    ];
    const charges = findRecurringCharges(rows, TODAY);
    assert.deepEqual(charges.map((charge) => [charge.key, charge.cadence, charge.typicalMinor]), [
      ['APPLE.COM/BILL', 'monthly', 999],
      ['APPLE.COM/BILL', 'monthly', 299],
    ]);
  });

  it('finds weekly and annual charges, and marks a stopped one inactive', () => {
    const weekly = ['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25', '2026-10-02', '2026-10-09']
      .map((date) => tx(date, 2500, 'SAMPLE GYM CLASS'));
    const annual = [tx('2025-10-20', 9999, 'SAMPLE CLOUD STORAGE'), tx('2026-10-12', 11999, 'SAMPLE CLOUD STORAGE')];
    const stopped = monthly('SAMPLE MAGAZINE', [500, 500, 500, 500], 4);
    const charges = findRecurringCharges([...weekly, ...annual, ...stopped], TODAY);
    const byKey = new Map(charges.map((charge) => [charge.key, charge]));
    assert.equal(byKey.get('SAMPLE GYM CLASS')?.cadence, 'weekly');
    assert.equal(byKey.get('SAMPLE GYM CLASS')?.monthlyMinor, Math.round(2500 * 30.44 / 7));
    assert.equal(byKey.get('SAMPLE CLOUD STORAGE')?.cadence, 'annual');
    assert.equal(byKey.get('SAMPLE CLOUD STORAGE')?.active, true);
    // A renewal at a new price: fixed, with the change reported.
    assert.equal(byKey.get('SAMPLE CLOUD STORAGE')?.fixed, true);
    assert.equal(byKey.get('SAMPLE CLOUD STORAGE')?.typicalMinor, 11999);
    assert.deepEqual(byKey.get('SAMPLE CLOUD STORAGE')?.priceChange, { fromMinor: 9999, toMinor: 11999, since: '2026-10-12' });
    assert.equal(byKey.get('SAMPLE MAGAZINE')?.active, false);
    assert.equal(charges[charges.length - 1].key, 'SAMPLE MAGAZINE');
  });

  it('keeps a yearly charge listed and active all year, until its renewal is overdue', () => {
    const rows = [tx('2025-10-12', 12000, 'SAMPLE ANTIVIRUS'), tx('2026-10-12', 12000, 'SAMPLE ANTIVIRUS')];
    // Over 400 days after the first payment, which a yearly charge needs.
    assert.deepEqual(findRecurringCharges(rows, '2026-11-17').map((charge) => [charge.key, charge.cadence, charge.active, charge.nextDate]), [
      ['SAMPLE ANTIVIRUS', 'annual', true, '2027-10-12'],
    ]);
    assert.equal(findRecurringCharges(rows, '2027-09-30')[0]?.active, true);
    // Not renewed: listed as stopped for a while, then gone.
    assert.equal(findRecurringCharges(rows, '2027-11-25')[0]?.active, false);
    assert.deepEqual(findRecurringCharges(rows, '2027-12-25'), []);
    // The long look back finds yearly charges only: a monthly series that stopped long ago stays out.
    assert.deepEqual(findRecurringCharges(monthly('SAMPLE OLD GYM', [3000, 3000, 3000, 3000], 1, 5, 2025), TODAY), []);
  });

  it('ignores irregular, too few, pending and refund rows', () => {
    const rows = [
      tx('2026-07-01', 500, 'SAMPLE BAKERY'), tx('2026-07-19', 500, 'SAMPLE BAKERY'), tx('2026-09-30', 500, 'SAMPLE BAKERY'),
      ...monthly('SAMPLE PODCAST', [800, 800], 8),
      // Three weekly charges could be chance; weekly series need four.
      ...['2026-09-21', '2026-09-28', '2026-10-05'].map((date) => tx(date, 1200, 'SAMPLE CAR WASH')),
      // Two same-price purchases a year apart among many others are not an annual charge.
      tx('2025-10-20', 4500, 'SAMPLE FUEL'), tx('2026-01-09', 3800, 'SAMPLE FUEL'), tx('2026-05-02', 6100, 'SAMPLE FUEL'),
      tx('2026-10-13', 4510, 'SAMPLE FUEL'),
      // Nor are two visits a year apart that cost very different amounts.
      tx('2025-10-25', 4500, 'SAMPLE HARDWARE'), tx('2026-10-10', 12000, 'SAMPLE HARDWARE'),
      ...monthly('SAMPLE NEWS', [700, 700, 700], 7).map((row) => ({ ...row, status: 'pending' as const })),
      ...monthly('SAMPLE RETURNS', [-700, -700, -700], 7),
    ];
    assert.deepEqual(findRecurringCharges(rows, TODAY), []);
  });
});

describe('computeCardInsights', () => {
  const options = { month: '2026-10', today: TODAY, currency: 'USD' };

  it('keeps swipe and wallet history for the same brand without a false first-time finding', () => {
    const rows = [
      tx('2026-01-03', 1000, 'SAMPLE BASELINE'),
      tx('2026-05-03', 40000, 'TARGET 00012345 DULUTH GA'),
      tx('2026-06-09', 40000, 'TARGET'),
      tx('2026-07-13', 40000, 'AplPay TARGET SAN MATEO CA'),
      tx('2026-08-19', 40000, 'TARGET DULUTH GA'),
      tx('2026-10-05', 42000, 'AplPay TARGET DULUTH GA'),
    ];
    const findings = computeCardInsights(rows, options);
    assert.deepEqual(findings.newMerchants, []);
    assert.equal(findings.largePurchases, null);
    for (const [swipe, wallet] of [
      ['MICRO ELECTRONICS', 'AplPay MICRO ELECTROMARIETTA GA'],
      ['HYATT REGENCY', 'AplPay HYATT REGENCYCLEARWATER FL'],
      ['TARGET.COM', 'AplPay TARGET DULUTH GA'],
      ['GREAT WALL SUPERMARKDULUTH', 'AplPay GREAT WALL SUDULUTH GA'],
    ]) {
      const history = [
        tx('2026-01-03', 1000, 'SAMPLE BASELINE'),
        tx('2026-05-03', 40000, swipe),
        tx('2026-10-05', 42000, wallet),
      ];
      assert.deepEqual(computeCardInsights(history, options).newMerchants, [], wallet);
    }
  });

  it('uses the real merchant history and each finding row own name, not the popular group label', () => {
    const target = monthly('AplPay TARGET DULUTH GA', [1700, 1700, 1700, 1700], 5);
    const micro = tx('2026-10-05', 620000, 'AplPay MICRO CENTER DULUTH GA');
    const first = tx('2026-10-06', 20000, 'TARGET 00012345 DULUTH GA');
    const twin = tx('2026-10-07', 20000, 'AplPay TARGET DULUTH GA');
    const findings = computeCardInsights([
      ...target, micro, first, twin, tx('2026-09-01', 1000, 'AplPay 8005550100 GA'),
      tx('2026-09-02', 1000, 'AplPay IN *SAMPLE PLUMBING'),
      tx('2026-10-05', 100, 'MICRO CENTER DULUTH GA'), tx('2026-10-05', 200, 'MICRO CENTER DULUTH GA'),
    ], options);
    // The large purchase keeps its own name; its group is the family the Show filter reaches.
    assert.deepEqual(findings.largePurchases?.items.map((item) => [item.id, item.merchant, item.key, item.firstTime]), [
      [micro.id, micro.description, 'MICRO CENTER', true],
    ]);
    assert.deepEqual(findings.newMerchants, []);
    assert.equal(findings.duplicates[0]?.merchant, twin.description);
    assert.deepEqual(findings.duplicates[0]?.ids, [first.id, twin.id]);
  });

  it('does not create cross-merchant duplicates or clear a duplicate with another merchant refund', () => {
    const target = tx('2026-10-05', 12000, 'AplPay TARGET DULUTH GA');
    const micro = tx('2026-10-06', 12000, 'AplPay MICRO CENTER DULUTH GA');
    const noise = tx('2026-09-01', 1000, 'APLPAY');
    assert.deepEqual(computeCardInsights([target, micro, noise], options).duplicates, []);
    const twin = tx('2026-10-07', 12000, 'TARGET 00012345 DULUTH GA');
    const refund = tx('2026-10-08', -12000, micro.description);
    assert.equal(computeCardInsights([target, twin, refund, noise], options).duplicates.length, 1);
  });

  it('never uses an arbitrary city or processor prefix to combine unrelated histories', () => {
    for (const prefix of ['SAN MATEO', 'BALTIMORE', 'MINNEAPOLIS', 'PADDLE.NET']) {
      const rows = [
        tx('2026-09-01', 1000, prefix),
        tx('2026-10-05', 12000, `${prefix} SAMPLE CAFE`),
        tx('2026-10-06', 12000, `${prefix} SAMPLE HARDWARE`),
      ];
      assert.deepEqual(computeCardInsights(rows, options).duplicates, [], prefix);
    }
  });

  it('recognizes a refund-only descriptor extension of an established purchase merchant', () => {
    const rows = [
      tx('2026-10-05', 12000, 'SAMPLE CAFE'),
      tx('2026-10-06', 12000, 'SAMPLE CAFE'),
      tx('2026-10-07', -12000, 'AplPay SQ *SAMPLE CAFE SEATTLE WA'),
    ];
    assert.deepEqual(computeCardInsights(rows, options).duplicates, []);
  });

  it('compares this month with the same days of earlier months and projects the month end', () => {
    const rows = [
      ...['2026-07', '2026-08', '2026-09'].flatMap((month) => [tx(`${month}-05`, 100000, 'SAMPLE MART'), tx(`${month}-20`, 100000, 'SAMPLE MART')]),
      tx('2026-10-03', 150000, 'SAMPLE MART'),
      tx('2026-10-15', 5000, 'SAMPLE TAXI', { status: 'pending' }),
      tx('2026-10-17', 99999, 'AFTER TODAY'),
      tx('2026-10-04', -50000, 'AUTOPAY PAYMENT', { kind: 'payment' }),
    ];
    const { pace } = computeCardInsights(rows, options);
    // Posted spending so far plus what the 17th to the month end usually adds; the pending taxi is reported on its own.
    assert.deepEqual(pace, {
      daysElapsed: 16, daysInMonth: 31, spentMinor: 150000, pendingMinor: 5000, typicalToDateMinor: 100000, typicalMonthMinor: 200000,
      projectedMinor: 150000 + 100000, historyMonths: 3, largeMinor: 0, largeCount: 0,
    });
    assert.equal(computeCardInsights(rows, { ...options, today: '2026-10-05' }).pace?.projectedMinor, null);
    assert.equal(computeCardInsights(rows, { ...options, month: '2026-09' }).pace, null);
    assert.equal(computeCardInsights(rows.slice(4), options).pace, null);
  });

  it('ranks category movers that pass both thresholds', () => {
    const cat = (date: string, amount: number, category: string) => tx(date, amount, `SAMPLE ${category.toUpperCase()}`, { issuerCategory: category });
    const rows = [
      ...['2026-06', '2026-07', '2026-08'].flatMap((month) => [
        cat(`${month}-10`, 10000, 'Dining'), cat(`${month}-11`, 10000, 'Groceries'), cat(`${month}-12`, 20000, 'Shopping'),
      ]),
      cat('2026-09-10', 30000, 'Dining'),
      cat('2026-09-11', 10500, 'Groceries'),
      cat('2026-09-15', 8000, 'Travel'),
    ];
    const { movers } = computeCardInsights(rows, { ...options, month: '2026-09' });
    assert.deepEqual(movers.map((mover) => [mover.category, mover.deltaMinor, mover.share]), [
      ['Dining', 20000, 2],
      ['Shopping', -20000, -1],
      ['Travel', 8000, null],
    ]);
  });

  it('flags possible duplicates unless refunded on the same card, small or on another card', () => {
    const rows = [
      tx('2026-10-02', 41200, 'CONTOSO AIRLINES'),
      tx('2026-10-03', 41200, 'CONTOSO AIRLINES'),
      tx('2026-10-06', 450, 'SAMPLE COFFEE'), tx('2026-10-06', 450, 'SAMPLE COFFEE'),
      tx('2026-10-07', 9000, 'SAMPLE HOTEL'), tx('2026-10-08', 9000, 'SAMPLE HOTEL', { cardAccountId: 'card-b' }),
      tx('2026-10-09', 12000, 'SAMPLE SHOES'), tx('2026-10-09', 12000, 'SAMPLE SHOES'), tx('2026-10-12', -12000, 'SAMPLE SHOES'),
      // A refund of the same amount on another card settles nothing.
      tx('2026-10-13', 12500, 'SAMPLE GEAR'), tx('2026-10-14', 12500, 'SAMPLE GEAR'),
      tx('2026-10-15', -12500, 'SAMPLE GEAR', { cardAccountId: 'card-b' }),
    ];
    const { duplicates } = computeCardInsights(rows, options);
    assert.deepEqual(duplicates.map((item) => [item.merchant, item.amountMinor, item.dates]), [
      ['CONTOSO AIRLINES', 41200, ['2026-10-02', '2026-10-03']],
      ['SAMPLE GEAR', 12500, ['2026-10-13', '2026-10-14']],
    ]);
  });

  it('reports large one-off purchases together, with the period and its baseline without them', () => {
    const day = (offset: number) => new Date(Date.parse('2025-10-25T12:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
    // A year of small purchases, each at its own shop: the 99th percentile of the year's purchases sets the bar.
    const small = Array.from({ length: 400 }, (_, i) => tx(day(i % 300), 1000 + (i % 7) * 100, `SAMPLE SHOP ${i}`));
    const sofa = tx('2026-09-09', 90000, 'SAMPLE SOFA SHOP');
    const jeweler = tx('2026-10-08', 120000, 'SAMPLE JEWELER', { issuerCategory: 'Jewelry' });
    const camera = tx('2026-10-09', 80000, 'SAMPLE CAMERA');
    // A large charge on a monthly rhythm is recurring, not a one-off.
    const insurance = ['2026-07-15', '2026-08-15', '2026-09-15', '2026-10-15'].map((date) => tx(date, 70000, 'SAMPLE INSURANCE'));
    const rows = [...small, sofa, tx('2026-09-12', 3000, 'SAMPLE BOOKS'), jeweler, camera, tx('2026-10-11', 2000, 'SAMPLE KIOSK'), ...insurance];
    const insights = computeCardInsights(rows, options);
    assert.deepEqual(insights.period, { from: '2026-10-01', to: '2026-10-16', baseline: { from: '2026-09-01', to: '2026-09-16' } });
    assert.deepEqual([insights.spendingMinor, insights.baselineMinor], [272000, 163000]);
    const large = insights.largePurchases!;
    assert.deepEqual([large.thresholdMinor, large.count, large.totalMinor, large.coreMinor, large.baselineCoreMinor], [70000, 2, 200000, 72000, 73000]);
    assert.equal(large.share, 200000 / 272000);
    assert.deepEqual(large.items.map((item) => [item.id, item.merchant, item.category, item.firstTime]), [
      [jeweler.id, 'SAMPLE JEWELER', 'Jewelry', true],
      [camera.id, 'SAMPLE CAMERA', 'Uncategorized', true],
    ]);
    // Without them nothing moved (72,000 against 73,000), and they are not listed again as new merchants.
    assert.deepEqual(insights.movers, []);
    assert.deepEqual(insights.newMerchants, []);
    // The month's pace says how much of it they are.
    assert.deepEqual([insights.pace?.largeMinor, insights.pace?.largeCount], [200000, 2]);
    // Few purchases: four times their median keeps an ordinary one from counting as large.
    const sparse = computeCardInsights([tx('2026-06-01', 60000, 'SAMPLE TV'), tx('2026-08-01', 50000, 'SAMPLE DESK'), tx('2026-10-05', 70000, 'SAMPLE BIKE')], options);
    assert.deepEqual([sparse.largePurchases?.thresholdMinor ?? null, sparse.largePurchases], [null, null]);
  });

  it('leaves an earlier month large one-off out of the usual month the pace compares with', () => {
    const shop = (date: string, amount: number, name: string) => tx(date, amount, name);
    const rows = [
      shop('2026-07-05', 10000, 'SAMPLE BAKERY'), shop('2026-07-20', 10000, 'SAMPLE GROCER'),
      shop('2026-08-05', 10000, 'SAMPLE BAKERY'), shop('2026-08-10', 300000, 'SAMPLE TV'), shop('2026-08-20', 10000, 'SAMPLE GROCER'),
      shop('2026-09-05', 10000, 'SAMPLE BAKERY'), shop('2026-09-20', 10000, 'SAMPLE GROCER'),
      shop('2026-10-05', 10000, 'SAMPLE BAKERY'),
    ];
    assert.deepEqual(computeCardInsights(rows, options).pace, {
      daysElapsed: 16, daysInMonth: 31, spentMinor: 10000, pendingMinor: 0, typicalToDateMinor: 10000, typicalMonthMinor: 20000,
      projectedMinor: 20000, historyMonths: 3, largeMinor: 0, largeCount: 0,
    });
  });

  it('follows the period: each compares with its own baseline, naming the merchants behind each change', () => {
    const dining = (date: string, amount: number, name: string) => tx(date, amount, name, { issuerCategory: 'Dining' });
    const grocer = (date: string) => tx(date, 10000, 'SAMPLE GROCER', { issuerCategory: 'Groceries' });
    const rows = [
      dining('2026-07-01', 3000, 'SAMPLE BISTRO'), dining('2026-07-20', 3000, 'SAMPLE BISTRO'), dining('2026-07-05', 2000, 'SAMPLE CAFE'),
      grocer('2026-07-03'), grocer('2026-08-01'),
      dining('2026-09-01', 3000, 'SAMPLE BISTRO'), dining('2026-09-20', 3000, 'SAMPLE BISTRO'), dining('2026-09-05', 2000, 'SAMPLE CAFE'),
      dining('2026-09-10', 12000, 'SAMPLE NOODLES'), dining('2026-10-02', 9000, 'SAMPLE NOODLES'),
      grocer('2026-09-03'),
    ];
    // The last 60 days against the 60 days before.
    const period = { from: '2026-08-18', to: '2026-10-16', baseline: { from: '2026-06-19', to: '2026-08-17' } };
    const span = computeCardInsights(rows, { ...options, period });
    assert.deepEqual([span.period, span.spendingMinor, span.baselineMinor], [period, 39000, 28000]);
    assert.equal(span.pace, null);
    assert.deepEqual(span.movers.map((mover) => [mover.category, mover.deltaMinor, mover.share, mover.drivers.map((driver) => [driver.merchant, driver.deltaMinor])]), [
      ['Dining', 21000, 21000 / 8000, [['SAMPLE NOODLES', 21000]]],
      ['Groceries', -10000, -0.5, [['SAMPLE GROCER', -10000]]],
    ]);
    assert.deepEqual(span.merchantMovers.map((mover) => [mover.merchant, mover.key, mover.deltaMinor, mover.share]), [
      ['SAMPLE NOODLES', 'SAMPLE NOODLES', 21000, null],
      ['SAMPLE GROCER', 'SAMPLE GROCER', -10000, -0.5],
    ]);
    // The same rows as a month: October so far against September to the same day.
    const month = computeCardInsights(rows, options);
    assert.deepEqual([month.spendingMinor, month.baselineMinor], [9000, 27000]);
    assert.deepEqual(month.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Groceries', -10000], ['Dining', -8000]]);
    // Nothing spent in the baseline: nothing to compare, no movers.
    assert.deepEqual(computeCardInsights(rows, { ...options, period: { ...period, baseline: { from: '2025-01-01', to: '2025-02-28' } } }).movers, []);
    assert.deepEqual(computeCardInsights(rows, { ...options, period: { ...period, baseline: null } }).merchantMovers, []);
    // A second merchant is named only when it makes a tenth of the change or more.
    const small = computeCardInsights([...rows, dining('2026-10-03', 1500, 'SAMPLE KIOSK'), dining('2026-10-04', 3000, 'SAMPLE DELI')], { ...options, period });
    assert.deepEqual(small.movers[0].drivers.map((driver) => [driver.merchant, driver.deltaMinor]), [['SAMPLE NOODLES', 21000], ['SAMPLE DELI', 3000]]);
    const tiny = computeCardInsights([...rows, dining('2026-10-03', 1500, 'SAMPLE KIOSK')], { ...options, period });
    assert.deepEqual(tiny.movers[0].drivers.map((driver) => driver.merchant), ['SAMPLE NOODLES']);
  });

  it('lists recurring charges that started, went up or stopped within the period', () => {
    const rows = [
      ...monthly('SAMPLE STREAM', [1549, 1549, 1549, 1799, 1799], 6, 7),
      ...monthly('SAMPLE GYM', [4000, 4000, 4000, 4000, 4000], 3, 10),
      ...monthly('SAMPLE MUSIC', [999, 999, 999], 8, 12),
    ];
    const names = (charges: Array<{ merchant: string }>) => charges.map((charge) => charge.merchant);
    const span = computeCardInsights(rows, { ...options, period: { from: '2026-07-19', to: '2026-10-16', baseline: { from: '2026-04-20', to: '2026-07-18' } } });
    assert.deepEqual([names(span.recurringChanges.started), names(span.recurringChanges.priceUps), names(span.recurringChanges.stopped)], [
      ['SAMPLE MUSIC'], ['SAMPLE STREAM'], ['SAMPLE GYM'],
    ]);
    assert.equal(span.recurring.find((charge) => charge.merchant === 'SAMPLE MUSIC')?.firstDate, '2026-08-12');
    // Where the cards' history begins with the series, its first charge says nothing about when it started.
    const fresh = computeCardInsights(monthly('SAMPLE MUSIC', [999, 999, 999], 8, 12), { ...options, period: span.period });
    assert.deepEqual([fresh.recurring.length, fresh.recurringChanges.started], [1, []]);
    const month = computeCardInsights(rows, options).recurringChanges;
    // The rise came on Sep 7: it belongs to September, not to every month after.
    assert.deepEqual([names(month.started), names(month.priceUps), names(month.stopped)], [[], [], []]);
    const september = computeCardInsights(rows, { ...options, month: '2026-09' }).recurringChanges;
    assert.deepEqual(names(september.priceUps), ['SAMPLE STREAM']);
    assert.equal(span.recurring.find((charge) => charge.merchant === 'SAMPLE STREAM')?.priceChange?.since, '2026-09-07');
  });

  it('reports pending refunds dated in the period', () => {
    const shoes = tx('2026-10-10', -4500, 'SAMPLE SHOES', { status: 'pending' });
    const socks = tx('2026-09-20', -1000, 'SAMPLE SOCKS', { status: 'pending' });
    const rows = [shoes, socks, tx('2026-10-11', -700, 'SAMPLE HATS'), tx('2026-10-12', 2500, 'SAMPLE CAFE', { status: 'pending' })];
    assert.deepEqual(computeCardInsights(rows, options).pendingRefunds, {
      count: 1, totalMinor: 4500, ids: [shoes.id], items: [{ id: shoes.id, merchant: 'SAMPLE SHOES', key: 'SAMPLE SHOES', amountMinor: 4500, date: '2026-10-10' }],
    });
    const span = computeCardInsights(rows, { ...options, period: { from: '2026-08-18', to: '2026-10-16', baseline: null } });
    assert.deepEqual([span.pendingRefunds?.count, span.pendingRefunds?.totalMinor, span.pendingRefunds?.ids], [2, 5500, [shoes.id, socks.id]]);
    assert.deepEqual(span.pendingRefunds?.items.map((item) => [item.merchant, item.amountMinor]), [['SAMPLE SHOES', 4500], ['SAMPLE SOCKS', 1000]]);
    assert.equal(computeCardInsights(rows.slice(2), options).pendingRefunds, null);
  });

  it('gives the Month period its days and the month before, to the same day while the month is current', () => {
    assert.deepEqual(cardMonthInsightPeriod('2026-10', '2026-10-16'), {
      from: '2026-10-01', to: '2026-10-16', baseline: { from: '2026-09-01', to: '2026-09-16' },
    });
    // The 31st against a 30-day month ends on its last day; a past month is whole against the whole month before.
    assert.deepEqual(cardMonthInsightPeriod('2026-03', '2026-03-31').baseline, { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(cardMonthInsightPeriod('2026-09', '2026-10-16'), {
      from: '2026-09-01', to: '2026-09-30', baseline: { from: '2026-08-01', to: '2026-08-31' },
    });
    assert.deepEqual(cardMonthInsightPeriod('2026-01', '2026-10-16').baseline, { from: '2025-12-01', to: '2025-12-31' });
  });

  it('flags large first charges at merchants new in a year, once there is history to tell', () => {
    const history = ['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05', '2026-07-05'].map((date) => tx(date, 5000, 'SAMPLE MART'));
    const rows = [tx('2026-01-02', 3000, 'SAMPLE BAKERY'), ...history, tx('2026-10-10', 30000, 'SAMPLE TAILOR'), tx('2026-10-11', 2000, 'SAMPLE KIOSK')];
    assert.deepEqual(computeCardInsights(rows, options).newMerchants.map((item) => [item.merchant, item.amountMinor]), [['SAMPLE TAILOR', 30000]]);
    // Without 90 days of history every merchant is new: nothing is flagged.
    const young = computeCardInsights([tx('2026-09-20', 3000, 'SAMPLE BAKERY'), tx('2026-10-10', 30000, 'SAMPLE TAILOR')], options);
    assert.deepEqual(young.newMerchants, []);
  });

  it('does not call another store of a known merchant new, and lists one first charge per merchant and day', () => {
    const rows = [
      tx('2026-01-05', 3000, 'SAMPLE BAKERY'),
      tx('2026-04-10', 40000, 'SAMPLE TOOL WORKS DULUTH GA'),
      tx('2026-06-10', 40000, 'SAMPLE TOOL WORKS DULUTH GA'),
      tx('2026-10-05', 45000, 'SAMPLE TOOL WORKS ATHENS GA'),
      tx('2026-10-08', 50000, 'SAMPLE PRINTERS'),
      tx('2026-10-08', 50000, 'SAMPLE PRINTERS'),
    ];
    const insights = computeCardInsights(rows, options);
    assert.deepEqual(insights.newMerchants.map((item) => [item.merchant, item.amountMinor]), [['SAMPLE PRINTERS', 50000]]);
    assert.equal(insights.duplicates.length, 1);
    // Without the earlier store, the other one is new.
    const alone = computeCardInsights(rows.filter((row) => !row.description.includes('DULUTH')), options);
    assert.deepEqual(alone.newMerchants.map((item) => item.merchant), ['SAMPLE PRINTERS', 'SAMPLE TOOL WORKS ATHENS GA']);
  });

  it('leaves fees, adjustments, statement credits and payments taken back out of what changed, and reversed fees out of costs', () => {
    const shop = (date: string, amount: number, name: string, category: string) => tx(date, amount, name, { issuerCategory: category });
    const rows = [
      shop('2026-09-05', 10000, 'SAMPLE GROCER', 'Groceries'), shop('2026-10-05', 10000, 'SAMPLE GROCER', 'Groceries'),
      shop('2026-09-02', 30000, 'SAMPLE OUTFITTER', 'Clothing'), shop('2026-10-08', 30000, 'SAMPLE OUTFITTER', 'Clothing'),
      // A refund from a merchant bought from counts against it.
      tx('2026-10-09', -30000, 'SAMPLE OUTFITTER', { issuerCategory: 'Clothing' }),
      // A payment misposted and taken back, filed under fees, and credited on another card: a transfer, not a cost.
      tx('2026-10-02', 840000, 'DEBIT - MISPOSTED PYMT', { kind: 'fee', issuerCategory: 'Fees & Adjustments' }),
      tx('2026-10-03', -840000, 'CREDIT - MISPOSTED PYMT', { cardAccountId: 'card-b' }),
      // An annual fee the issuer credited back: neither a cost nor a reversal to report.
      tx('2026-10-04', 69500, 'SAMPLE ANNUAL FEE', { kind: 'fee' }),
      tx('2026-10-05', -69500, 'SAMPLE ANNUAL FEE CREDIT', { kind: 'adjustment' }),
      // A statement credit from no merchant bought from; fees that are fees, payment words and all; an adjustment.
      tx('2026-10-06', -21500, 'SAMPLE STATEMENT CREDIT'),
      tx('2026-10-07', 9500, 'SAMPLE MEMBERSHIP FEE', { kind: 'fee', issuerCategory: 'Fees & Adjustments' }),
      tx('2026-10-08', 3900, 'LATE PAYMENT FEE', { kind: 'fee' }),
      tx('2026-10-08', 2900, 'RETURNED PAYMENT FEE', { kind: 'fee' }),
      tx('2026-10-10', -2000, 'SAMPLE FEE ADJUSTMENT', { kind: 'adjustment' }),
    ];
    const insights = computeCardInsights(rows, options);
    assert.deepEqual(insights.movers.map((mover) => [mover.category, mover.deltaMinor, mover.drivers.map((driver) => driver.merchant)]), [
      ['Clothing', -30000, ['SAMPLE OUTFITTER']],
    ]);
    assert.deepEqual(insights.merchantMovers.map((mover) => [mover.merchant, mover.deltaMinor]), [['SAMPLE OUTFITTER', -30000]]);
    assert.deepEqual(insights.costs.period, { feesMinor: 9500 + 3900 + 2900, interestMinor: 0, foreignFeesMinor: 0, reversalsMinor: -2000 });
    // A fee is credited back only by an issuer adjustment of exactly its amount, on its card, within 60 days.
    const later = rows.map((row) => (row.description === 'SAMPLE ANNUAL FEE CREDIT' ? { ...row, transactionDate: '2026-12-15' } : row));
    assert.equal(computeCardInsights(later, options).costs.period.feesMinor, 69500 + 9500 + 3900 + 2900);
    // A merchant refund of the same amount never cancels a fee, and still counts against its merchant.
    const returned = [...rows.filter((row) => !row.description.startsWith('SAMPLE ANNUAL FEE')),
      tx('2026-10-04', 9500, 'SAMPLE CARD FEE', { kind: 'fee' }), tx('2026-10-05', -9500, 'SAMPLE OUTFITTER', { issuerCategory: 'Clothing' })];
    const both = computeCardInsights(returned, options);
    assert.equal(both.costs.period.feesMinor, 9500 + 9500 + 3900 + 2900);
    assert.deepEqual(both.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Clothing', -39500]]);
    // A payment taken back of the same amount, earlier, never takes the credit meant for a fee.
    const first = computeCardInsights([
      tx('2026-10-01', 69500, 'DEBIT - MISPOSTED PYMT', { kind: 'fee' }),
      tx('2026-10-04', 69500, 'SAMPLE ANNUAL FEE', { kind: 'fee' }),
      tx('2026-10-05', -69500, 'SAMPLE ANNUAL FEE CREDIT', { kind: 'adjustment' }),
    ], options);
    assert.deepEqual(first.costs.period, { feesMinor: 0, interestMinor: 0, foreignFeesMinor: 0, reversalsMinor: 0 });
  });

  it('nets a large purchase against its refunds: one returned in full is neither a large purchase nor a drop in spending', () => {
    const cafe = ['2026-08-05', '2026-09-05'].map((date) => tx(date, 5000, 'SAMPLE CAFE'));
    const tv = tx('2026-10-06', 200000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' });
    const base = [...cafe, tx('2026-10-05', 10000, 'SAMPLE CAFE'), tv];
    const returned = computeCardInsights([...base, tx('2026-10-12', -200000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' })], options);
    assert.equal(returned.largePurchases, null);
    assert.deepEqual(returned.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Uncategorized', 5000]]);
    assert.deepEqual([returned.pace?.largeMinor, returned.pace?.largeCount], [0, 0]);
    const partly = computeCardInsights([...base, tx('2026-10-12', -50000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' })], options);
    assert.deepEqual([partly.largePurchases?.totalMinor, partly.largePurchases?.coreMinor, partly.largePurchases?.share], [150000, 10000, 150000 / 160000]);
    assert.deepEqual(partly.largePurchases?.items.map((item) => [item.id, item.amountMinor, item.refundedMinor]), [[tv.id, 150000, 50000]]);
    // A refund of last month's large purchase is not a drop in this month's everyday spending.
    const earlier = computeCardInsights([...cafe, tx('2026-10-05', 10000, 'SAMPLE CAFE'), tx('2026-09-20', 200000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' }),
      tx('2026-10-03', -200000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' })], { ...options, period: { from: '2026-10-01', to: '2026-10-16', baseline: { from: '2026-09-01', to: '2026-09-16' } } });
    assert.deepEqual(earlier.movers.map((mover) => mover.category), ['Uncategorized']);
    // One refund for two large purchases at once is set against both, each up to its amount.
    const pair = [tx('2026-10-06', 100000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' }), tx('2026-10-07', 100000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' })];
    const together = (refundMinor: number) => computeCardInsights([...cafe, tx('2026-10-05', 10000, 'SAMPLE CAFE'), ...pair,
      tx('2026-10-12', -refundMinor, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' })], options);
    const all = together(200000);
    assert.equal(all.largePurchases, null);
    assert.deepEqual(all.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Uncategorized', 5000]]);
    const most = together(150000).largePurchases;
    assert.deepEqual([most?.count, most?.totalMinor, most?.coreMinor], [1, 50000, 10000]);
    assert.deepEqual(most?.items.map((item) => [item.id, item.amountMinor, item.refundedMinor]), [[pair[1].id, 50000, 50000]]);
    // What a refund has left after the large purchases stays an ordinary refund from that merchant.
    const more = together(230000);
    assert.equal(more.largePurchases, null);
    assert.deepEqual(more.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Electronics', -30000], ['Uncategorized', 5000]]);
  });

  it('never counts a recurring bill as a one-off, however its older history groups its name', () => {
    const rows = [
      tx('2024-01-10', 70000, 'SAMPLE INSURANCE'),
      ...monthly('SAMPLE INSURANCE SEATTLE WA', [70000, 70000, 70000, 70000], 7, 15),
      ...['2026-09-01', '2026-09-08', '2026-10-02'].map((date) => tx(date, 2000, 'SAMPLE CAFE')),
    ];
    const insights = computeCardInsights(rows, options);
    assert.equal(insights.recurring.filter((charge) => charge.active).length, 1);
    assert.equal(insights.largePurchases, null);
  });

  it('reports every possible duplicate in the period, not only the first few', () => {
    const names = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF'];
    const rows = names.flatMap((name, index) => [tx(`2026-10-0${index + 1}`, 3000 + index * 100, `SAMPLE ${name} CAFE`), tx(`2026-10-0${index + 1}`, 3000 + index * 100, `SAMPLE ${name} CAFE`)]);
    assert.equal(computeCardInsights(rows, options).duplicates.length, 7);
  });

  it('adds up fees, foreign transaction fees, interest and reversals for the month and the year', () => {
    const rows = [
      tx('2026-02-01', 9500, 'ANNUAL MEMBERSHIP FEE', { kind: 'fee' }),
      tx('2026-10-12', 737, 'FOREIGN TRANSACTION FEE', { kind: 'fee' }),
      tx('2026-10-15', 1999, 'INTEREST CHARGE ON PURCHASES', { kind: 'interest' }),
      tx('2026-10-16', -1999, 'INTEREST CHARGE REVERSAL', { kind: 'adjustment' }),
      tx('2026-10-16', 500, 'LATE FEE', { kind: 'fee', status: 'pending' }),
      tx('2025-12-01', 800, 'FOREIGN TRANSACTION FEE', { kind: 'fee' }),
    ];
    const { costs } = computeCardInsights(rows, options);
    assert.deepEqual(costs, {
      period: { feesMinor: 737, interestMinor: 1999, foreignFeesMinor: 737, reversalsMinor: -1999 },
      year: { year: '2026', feesMinor: 10237, interestMinor: 1999, foreignFeesMinor: 737, reversalsMinor: -1999 },
    });
  });

  it('looks at one currency only', () => {
    const rows = monthly('SAMPLE STREAMING', [1549, 1549, 1549, 1549], 7).map((row) => ({ ...row, currency: 'EUR' }));
    const insights = computeCardInsights(rows, options);
    assert.deepEqual(insights.recurring, []);
    assert.equal(computeCardInsights(rows, { ...options, currency: 'EUR' }).recurring.length, 1);
  });
});
