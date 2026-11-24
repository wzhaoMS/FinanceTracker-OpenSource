import type {
  MetalsCompletenessCode,
  MetalsFunding,
  MetalsFundingPurchase,
  MetalsMeasure,
  MetalsOverview,
  MetalsProduct,
  MetalsProducts,
  MetalsPurchase,
  MetalsPurchases,
  MetalsSale,
  MetalsSales,
  MetalsTimeline,
  MetalsTroyOz,
} from '@finance-tracker/shared/metals-api';

import type { GoldCloses } from './goldCloses';

/**
 * Typed synthetic answers of the metals reads, for the page's unit tests and for the states an e2e stack can't reach
 * (served in the browser). Invented titles, labels and amounts only; no household's data.
 */

export const oz = (exact: string, display: string): MetalsTroyOz => ({ exact, display });

/**
 * Synthetic daily closes for a served closes read: every weekday from `from` to `to`, except the eight days after
 * `gapFrom` (a gap longer than the line joins), at an invented price that drifts so the line has a shape.
 */
export function closesFixture(from: string, to: string, gapFrom: string | null = null, fetching = true): GoldCloses {
  const closes: GoldCloses['closes'] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  const gapStart = gapFrom ? Date.parse(`${gapFrom}T00:00:00Z`) : null;
  for (let day = Date.parse(`${from}T00:00:00Z`), index = 0; day <= end; day += 86_400_000, index += 1) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (gapStart !== null && day > gapStart && day <= gapStart + 8 * 86_400_000) continue;
    closes.push({ date: new Date(day).toISOString().slice(0, 10), close: (2400 + (index % 40) * 2.5).toFixed(1) });
  }
  return { installed: true, metal: 'XAU', fetching, closes };
}

export const complete = <T,>(value: T): MetalsMeasure<T> => ({ value, state: 'complete', reasons: [] });

export const partial = <T,>(value: T, ...reasons: Array<[MetalsCompletenessCode, number]>): MetalsMeasure<T> =>
  ({ value, state: 'partial', reasons: reasons.map(([code, records]) => ({ code, records })) });

export const unknown = <T,>(...reasons: Array<[MetalsCompletenessCode, number]>): MetalsMeasure<T> =>
  ({ value: null, state: 'unknown', reasons: reasons.map(([code, records]) => ({ code, records })) });

const units = (patch: Partial<MetalsOverview['holdings']['units']> = {}): MetalsOverview['holdings']['units'] => ({
  delivered: 0, awaiting: 0, sold: 0, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0, ...patch,
});

/** One gold class, three 1 oz bars delivered, one sold, two held; complete figures. */
export function overviewFixture(patch: Partial<MetalsOverview> = {}): MetalsOverview {
  return {
    installed: true,
    metal: 'XAU',
    metals: [{ metal: 'XAU', lots: 3, sales: 1 }, { metal: 'XAG', lots: 0, sales: 2 }],
    asOf: '2026-11-08',
    price: { source: 'cnbc-spot-daily', closeDate: '2026-11-06', close: '2650.4', stale: false, thinHistory: false, fetching: true, levelShift: null },
    holdings: {
      troyOz: complete(oz('2/1', '2.000')),
      costMinor: complete(400_000),
      valueMinor: complete(530_080),
      gainMinor: complete(130_080),
      units: units({ delivered: 3, sold: 1, soldFromDelivered: 1, held: 2 }),
      awaitingTroyOz: complete(oz('0/1', '0.000')),
      awaitingUnassignedTroyOz: complete(oz('0/1', '0.000')),
      contentUnknown: { lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 },
      classes: [{
        key: 'XAU|bar|1', form: 'bar', fineTroyOzPerUnit: oz('1/1', '1.000'),
        units: units({ delivered: 3, sold: 1, soldFromDelivered: 1, held: 2 }),
        troyOz: complete(oz('2/1', '2.000')), costMinor: complete(400_000), valueMinor: complete(530_080), gainMinor: complete(130_080),
        reconciliation: { balanced: true, soldWhileAwaiting: 0, unmatched: 0 },
      }],
      bySource: [{ accountId: 'mtl-acct-aaaa', source: 'costco', label: 'Costco membership 1', units: 2, troyOz: complete(oz('2/1', '2.000')),
        costMinor: complete(400_000), valueMinor: complete(530_080) }],
      storage: null,
    },
    metalUnknown: { lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 },
    activity: {
      from: null,
      to: '2026-11-08',
      bought: { lots: 3, units: 3, troyOz: complete(oz('3/1', '3.000')), costMinor: complete(600_000) },
      sold: {
        lines: 1, units: 1, troyOz: complete(oz('1/1', '1.000')), grossMinor: complete(250_000), feesMinor: complete(5_000),
        netMinor: complete(245_000), unmatched: { units: 0, netMinor: 0, reasons: [] },
      },
      profit: { valueMinor: complete(45_000), coverage: { basis: 'troy-oz', known: oz('1/1', '1.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 } },
      payouts: { count: 1, amountMinor: complete(245_000), mixedMetal: { count: 0, amountMinor: complete(0) } },
    },
    toCheck: { records: 0, needsYou: [], forInformation: [] },
    needsAnswer: { orders: 0, flaggedLines: 0, bySource: [], byMerchantClass: [], items: [] },
    coverage: [{
      accountId: 'mtl-acct-aaaa', source: 'costco', label: 'Costco membership 1', capturedAt: null, importedAt: '2026-11-08T12:00:00Z',
      kinds: [
        { kind: 'online', from: '2025-01-01', to: '2026-11-08', complete: true, stated: 12, seen: 12, ranges: [{ from: '2025-01-01', to: '2026-11-08' }] },
        { kind: 'warehouse', from: '2025-01-01', to: '2026-11-08', complete: true, stated: 0, seen: 0, ranges: [{ from: '2025-01-01', to: '2026-11-08' }] },
      ],
      held: 0,
    }],
    // The coverage proof as this build serves it (card cross-check PR-B): the roster isn't installed, so every scope
    // with a need is incomplete, with at least `prefix` and `roster` named, and both totals are refused.
    coverageProof: {
      rule: 'metals-coverage-proof-v1',
      snapshot: 'abcdefghijklmnop'.repeat(4),
      asOf: '2026-11-08',
      roster: { state: 'not-installed', asking: false, decidedAt: null, acquisitionStart: null, problems: [], bindings: [] },
      asOfScope: {
        state: 'incomplete',
        need: { buy: { from: null, to: '2026-11-08' }, sell: { from: null, to: '2026-11-08' } },
        gaps: [{ id: 'prefix', variant: 'unproven-prefix' }, { id: 'roster', variant: 'roster', state: 'not-installed', problems: [], rows: 0 }],
      },
      sales: [{
        metal: 'XAU', state: 'incomplete',
        need: { buy: { from: null, to: '2026-10-01' }, sell: { from: null, to: '2026-11-08' } },
        gaps: [{ id: 'prefix', variant: 'unproven-prefix' }, { id: 'roster', variant: 'roster', state: 'not-installed', problems: [], rows: 0 }],
      }],
      totals: {
        realized: { metals: ['XAU'], state: 'incomplete' },
        estimate: { metals: ['XAU'], state: 'incomplete' },
        metalUnknown: { lots: 0, saleLines: 0 },
      },
      limits: ['card-check-only', 'non-card-funding', 'stored-value-only', 'warehouse-and-store', 'cards-not-in-holdr', 'undiscovered-dealers'],
    },
    ...patch,
  };
}

export function purchaseFixture(patch: Partial<MetalsPurchase> = {}): MetalsPurchase {
  return {
    key: 'costco-line-aaaa',
    orderKey: 'costco-order-aaaa',
    account: { accountId: 'mtl-acct-aaaa', source: 'costco', label: 'Costco membership 1' },
    channel: 'online',
    orderDate: '2026-03-10',
    dateUnknown: false,
    title: 'Sample Mint 1 oz Gold Bar',
    productRef: 'costco:1000001',
    form: 'bar',
    seller: null,
    quantity: 1,
    units: { ordered: 1, cancelled: 0, returned: 0, delivered: 1, awaiting: 0 },
    delivery: { state: 'delivered', date: '2026-03-14' },
    costMinor: complete(200_000),
    merchandiseMinor: complete(200_000),
    content: { known: true, troyOzPerUnit: oz('1/1', '1.000'), troyOz: oz('1/1', '1.000'), basis: 'owner-confirmed' },
    premiumPaidPerOzMinor: 4_500,
    purchaseSpot: { closeDate: '2026-03-09' },
    funding: [{ kind: 'card', network: 'visa', amountMinor: 200_000 }],
    cardEvidence: 'admitted',
    cards: [{
      evidenceClass: 'costco-settled-tender@1', amountMinor: 200_000, state: 'linked', proof: true,
      row: { id: 'card-txn-aaaa', date: '2026-03-11', account: { id: 'card-acct-aaaa', name: 'Sample Rewards', ending: '1111' } },
    }],
    refunds: [],
    sales: [],
    quarantined: false,
    ...patch,
  };
}

export function saleFixture(patch: Partial<MetalsSale> = {}): MetalsSale {
  return {
    key: 'collectpure-sline-aaaa',
    orderKey: 'collectpure-sell-aaaa',
    account: { accountId: 'mtl-acct-bbbb', source: 'collectpure', label: 'CollectPure' },
    agreedDate: '2026-06-02',
    tradeMoment: '2026-06-02T15:00:00Z',
    status: 'complete',
    inspection: 'passed',
    program: null,
    premium: null,
    title: '1 oz Gold Buffalo Coin',
    productRef: 'collectpure:sample-1',
    form: 'coin',
    quantity: 1,
    grossMinor: 250_000,
    feesMinor: 5_000,
    netMinor: 245_000,
    content: { known: true, troyOzPerUnit: oz('1/1', '1.000'), troyOz: oz('1/1', '1.000'), basis: 'coin-specification' },
    matched: { units: 1, netMinor: 245_000 },
    unmatched: { units: 0, netMinor: 0, reasons: [] },
    known: true,
    costMinor: complete(200_000),
    profitMinor: complete(45_000),
    payouts: [{
      key: 'collectpure-payout-aaaa', amountMinor: 245_000, payoutDate: '2026-06-10', status: 'complete',
      deposit: { state: 'linked', proof: true, row: { id: 'chk-aaaa', date: '2026-06-11', account: { id: 'chk-acct', name: 'Sample Checking', ending: '0001' } },
        coveredThrough: '2026-10-31' },
    }],
    cycles: [{
      lotKey: 'costco-line-aaaa', orderKey: 'costco-order-aaaa', units: 1, troyOz: oz('1/1', '1.000'), orderDate: '2026-03-10',
      account: { accountId: 'mtl-acct-aaaa', source: 'costco', label: 'Costco membership 1' }, daysFromOrderToSale: 84,
      costMinor: 200_000, proceedsMinor: 245_000, profitMinor: 45_000, premiumPaidPerOzMinor: 4_500, salePremiumPerOzMinor: 1_000,
      fromSpotMinor: 50_000, fromPremiumsMinor: -5_000, purchaseSpot: { closeDate: '2026-03-09' }, lotQuarantined: false,
    }],
    saleSpot: { basis: 'close-proxy', closeDate: '2026-06-01' },
    premiumDisagreement: false,
    dateUnknown: false,
    purchaseConflict: false,
    quarantined: false,
    ...patch,
  };
}

export function productFixture(patch: Partial<MetalsProduct> = {}): MetalsProduct {
  return {
    scope: { kind: 'product', ref: 'costco:1000001', fingerprint: 'fp-aaaa' },
    source: 'costco',
    titles: ['Sample Mint 1 oz Gold Bar'],
    stated: { metal: 'XAU', form: 'bar', mass: { value: '1', unit: 'oz' }, purity: null, massBasis: null, design: null },
    pack: 'single',
    packCount: null,
    proposal: { metal: 'XAU', troyOzPerUnit: oz('1/1', '1.000') },
    lots: 2,
    saleLines: 0,
    units: 2,
    hold: 'fine-content-unknown',
    decision: null,
    drift: false,
    basis: null,
    ...patch,
  };
}

export function timelineFixture(): MetalsTimeline {
  const month = (m: string, endDate: string, value: string | null, extra: Partial<MetalsTimeline['months'][number]> = {}) => ({
    month: m, endDate, recorded: value !== null,
    troyOz: value === null ? unknown<MetalsTroyOz>() : complete(oz(`${value}/1`, `${value}.000`)),
    costMinor: value === null ? unknown<number>() : complete(Number(value) * 200_000),
    valueMinor: value === null ? unknown<number>() : complete(Number(value) * 265_000),
    closeDate: value === null ? null : endDate,
    ...extra,
  });
  return {
    installed: true,
    metal: 'XAU',
    months: [
      month('2026-01', '2026-01-31', null),
      month('2026-02', '2026-02-27', '0'),
      month('2026-03', '2026-03-31', '1'),
      month('2026-04', '2026-04-30', '2', { troyOz: partial(oz('2/1', '2.000'), ['content-unknown', 1]) }),
    ],
  };
}

export function fundingPurchaseFixture(patch: Partial<MetalsFundingPurchase> = {}): MetalsFundingPurchase {
  const purchase = purchaseFixture();
  return {
    orderKey: purchase.orderKey,
    account: purchase.account,
    orderDate: purchase.orderDate,
    fullPriceMinor: 200_000,
    metals: ['XAU'],
    metalUnknownLines: 0,
    allMetal: true,
    quarantined: false,
    cardEvidence: 'admitted',
    cards: purchase.cards,
    receiptCharges: [{ rowId: 'card-txn-aaaa', evidenceClass: 'costco-settled-tender@1', metals: ['XAU'] }],
    refunds: [],
    byKind: [{ kind: 'card', methods: 1, amountMinor: 200_000 }],
    ...patch,
  };
}

/**
 * Every read as a Holdr answers with no daily close stored: each value at spot, gain and spot unknown with
 * `price-missing`, in the headline, each class, every chart month and every cycle; ounces and costs still known. One
 * consistent state, served for every `/metals/` read. `fetching` false is a Holdr that doesn't fetch closes (prices
 * off, as Holdr ships); true is one that fetches but has none yet (no price yet).
 */
export function priceMissingAnswer(pathname: string, fetching = false): unknown {
  const missing = <T,>() => unknown<T>(['price-missing', 1]);
  const to = '2026-11-08';
  if (pathname === '/metals/overview') {
    const base = overviewFixture();
    return {
      ...base,
      price: { ...base.price, closeDate: null, close: null, stale: false, levelShift: null, fetching },
      holdings: {
        ...base.holdings,
        valueMinor: missing<number>(),
        gainMinor: missing<number>(),
        classes: base.holdings.classes.map((item) => ({ ...item, valueMinor: missing<number>(), gainMinor: missing<number>() })),
        bySource: base.holdings.bySource.map((item) => ({ ...item, valueMinor: missing<number>() })),
      },
    } satisfies MetalsOverview;
  }
  if (pathname === '/metals/timeline') {
    const base = timelineFixture();
    return {
      ...base,
      months: base.months.map((month) => (month.recorded ? { ...month, valueMinor: missing<number>(), closeDate: null } : month)),
    } satisfies MetalsTimeline;
  }
  if (pathname === '/metals/purchases') {
    return {
      installed: true, metal: 'XAU', from: null, to, purchases: [purchaseFixture({ premiumPaidPerOzMinor: null, purchaseSpot: null })],
    } satisfies MetalsPurchases;
  }
  if (pathname === '/metals/sales') {
    const base = saleFixture();
    return {
      installed: true, metal: 'XAU', from: null, to,
      sales: [{
        ...base,
        saleSpot: null,
        cycles: base.cycles.map((cycle) => ({
          ...cycle, premiumPaidPerOzMinor: null, salePremiumPerOzMinor: null, fromSpotMinor: null, fromPremiumsMinor: null, purchaseSpot: null,
        })),
      }],
    } satisfies MetalsSales;
  }
  if (pathname === '/metals/products') return { installed: true, metal: 'XAU', products: [] } satisfies MetalsProducts;
  // The closes read succeeds and has none stored (never a failure): "no usable close", prices off or not.
  if (pathname === '/metals/closes') return { installed: true, metal: 'XAU', fetching, closes: [] } satisfies GoldCloses;
  if (pathname === '/metals/funding') {
    return { installed: true, from: null, to, purchases: [fundingPurchaseFixture()], sales: [], deposits: [] } satisfies MetalsFunding;
  }
  return { installed: false };
}

/** The unmatched sale's reason on every figure it keeps unknown; a value at spot adds the missing close. */
const SOLD_OUT_WHY: [MetalsCompletenessCode, number] = ['unmatched-sales', 1];
const SOLD_OUT_PRICE: [MetalsCompletenessCode, number] = ['price-missing', 1];
const SOLD_OUT_UNITS: MetalsOverview['holdings']['units'] = units({ delivered: 1, sold: 3, soldFromDelivered: 1, unmatched: 2 });
const SOLD_OUT_UNMATCHED = { units: 2, netMinor: 490_000, reasons: [{ reason: 'no-recorded-purchase' as const, units: 2, netMinor: 490_000 }] };

/**
 * Every recorded purchase kept or on the way sold, and units sold with no purchase recorded at all (ROOT's holdings
 * copy), as the routes would answer it over All: one 1 oz bar bought and delivered, then one sale of three 1 oz bars
 * that took it, whose other 2 units have no recorded purchase (and never had one). Gold alone is recorded. What is held
 * is unknown, a zero with a reason, never 0, the unmatched sale its only reason (both accounts covered through the day
 * held); values at spot are off (`fetching` false, as Holdr ships) or not priced yet. The period's figures, To check, the
 * class, the source row, the coverage, the months, the purchases and the sales all agree.
 */
export function soldOutOverview(fetching = false): MetalsOverview {
  const base = overviewFixture({ metals: [{ metal: 'XAU', lots: 1, sales: 1 }] });
  const unknownOz = unknown<MetalsTroyOz>(SOLD_OUT_WHY);
  const figures = {
    troyOz: unknownOz, costMinor: unknown<number>(SOLD_OUT_WHY),
    valueMinor: unknown<number>(SOLD_OUT_WHY, SOLD_OUT_PRICE), gainMinor: unknown<number>(SOLD_OUT_WHY, SOLD_OUT_PRICE),
  };
  return {
    ...base,
    price: { ...base.price, closeDate: null, close: null, stale: false, levelShift: null, fetching },
    holdings: {
      ...base.holdings,
      ...figures,
      units: SOLD_OUT_UNITS,
      awaitingTroyOz: unknownOz,
      awaitingUnassignedTroyOz: unknownOz,
      classes: base.holdings.classes.map((item) => ({
        ...item, ...figures, units: SOLD_OUT_UNITS, reconciliation: { balanced: false, soldWhileAwaiting: 0, unmatched: 2 },
      })),
      bySource: base.holdings.bySource.map((item) => ({
        ...item, units: 0, troyOz: unknownOz, costMinor: figures.costMinor, valueMinor: figures.valueMinor,
      })),
    },
    activity: {
      ...base.activity,
      bought: { lots: 1, units: 1, troyOz: complete(oz('1/1', '1.000')), costMinor: complete(200_000) },
      sold: {
        lines: 1, units: 3, troyOz: complete(oz('3/1', '3.000')), grossMinor: complete(750_000), feesMinor: complete(15_000),
        netMinor: complete(735_000), unmatched: SOLD_OUT_UNMATCHED,
      },
      // Over the sale's one assigned purchase: known for that unit's ounce only.
      profit: {
        valueMinor: partial(45_000, SOLD_OUT_WHY),
        coverage: { basis: 'troy-oz', known: oz('1/1', '1.000'), total: oz('3/1', '3.000'), unknownContentLines: 0 },
      },
      payouts: { count: 1, amountMinor: complete(735_000), mixedMetal: { count: 0, amountMinor: complete(0) } },
    },
    toCheck: {
      records: 1, needsYou: [],
      forInformation: [{ code: 'unmatched-sales', units: 2, reasons: [{ reason: 'no-recorded-purchase', units: 2 }] }],
    },
    // The sale's account too: its sell orders and payouts covered through the day held, so no coverage gap.
    coverage: [...base.coverage, {
      accountId: 'mtl-acct-bbbb', source: 'collectpure', label: 'CollectPure', capturedAt: '2026-11-08T12:00:00Z',
      importedAt: '2026-11-08T12:00:00Z',
      kinds: [
        { kind: 'sell-orders', from: '2025-01-01', to: '2026-11-08', complete: true, stated: 1, seen: 1, ranges: [{ from: '2025-01-01', to: '2026-11-08' }] },
        { kind: 'payouts', from: '2025-01-01', to: '2026-11-08', complete: true, stated: 1, seen: 1, ranges: [{ from: '2025-01-01', to: '2026-11-08' }] },
      ],
      held: 0,
    }],
  };
}

/** Every read of the sold-out state (soldOutOverview), for the metal and period asked once served through answeredFor. */
export function soldOutAnswer(pathname: string, fetching = false): unknown {
  const to = '2026-11-08';
  const sale = saleFixture();
  if (pathname === '/metals/overview') return soldOutOverview(fetching);
  if (pathname === '/metals/purchases') {
    return {
      installed: true, metal: 'XAU', from: null, to,
      purchases: [purchaseFixture({
        premiumPaidPerOzMinor: null, purchaseSpot: null, sales: [{ saleKey: sale.key, agreedDate: sale.agreedDate, units: 1 }],
      })],
    } satisfies MetalsPurchases;
  }
  if (pathname === '/metals/sales') {
    return {
      installed: true, metal: 'XAU', from: null, to,
      sales: [{
        ...sale,
        title: '1 oz Gold Bar Sample', productRef: 'collectpure:sample-bar', form: 'bar',
        quantity: 3, grossMinor: 750_000, feesMinor: 15_000, netMinor: 735_000,
        content: { known: true, troyOzPerUnit: oz('1/1', '1.000'), troyOz: oz('3/1', '3.000'), basis: 'stated-mass-basis' },
        matched: { units: 1, netMinor: 245_000 },
        unmatched: SOLD_OUT_UNMATCHED,
        known: false,
        costMinor: partial(200_000, SOLD_OUT_WHY),
        profitMinor: partial(45_000, SOLD_OUT_WHY),
        payouts: sale.payouts.map((payout) => ({ ...payout, amountMinor: 735_000 })),
        cycles: sale.cycles.map((cycle) => ({
          ...cycle, premiumPaidPerOzMinor: null, salePremiumPerOzMinor: null, fromSpotMinor: null, fromPremiumsMinor: null, purchaseSpot: null,
        })),
        saleSpot: null,
      }],
    } satisfies MetalsSales;
  }
  if (pathname === '/metals/timeline') {
    // The bar held to the end of May; from the sale in June, unknown for the unmatched units.
    const month = (key: string, endDate: string, held: boolean): MetalsTimeline['months'][number] => ({
      month: key, endDate, recorded: true,
      troyOz: held ? complete(oz('1/1', '1.000')) : unknown<MetalsTroyOz>(SOLD_OUT_WHY),
      costMinor: held ? complete(200_000) : unknown<number>(SOLD_OUT_WHY),
      valueMinor: held ? unknown<number>(SOLD_OUT_PRICE) : unknown<number>(SOLD_OUT_WHY, SOLD_OUT_PRICE),
      closeDate: null,
    });
    return {
      installed: true,
      metal: 'XAU',
      months: [
        month('2026-03', '2026-03-31', true), month('2026-04', '2026-04-30', true), month('2026-05', '2026-05-31', true),
        month('2026-06', '2026-06-30', false), month('2026-07', '2026-07-31', false), month('2026-08', '2026-08-31', false),
        month('2026-09', '2026-09-30', false), month('2026-10', '2026-10-31', false), month('2026-11', to, false),
      ],
    } satisfies MetalsTimeline;
  }
  return priceMissingAnswer(pathname, fetching);
}

/**
 * A served answer as the routes answer the request `url` (G3 echoes what was asked): the overview's activity, the
 * purchases, the sales and the funding read name the period asked (`from`, `to`), and every read that names a metal
 * names the metal asked. The page shows an answer only for the metal and period it asked (goldReads), so an answer served
 * in the browser says them too. An error, or `installed: false`, is served as it is.
 */
export function answeredFor(url: URL, answer: unknown): unknown {
  if (typeof answer !== 'object' || answer === null || (answer as { installed?: unknown }).installed !== true) return answer;
  const query = url.searchParams;
  const metal = query.get('metal');
  const to = query.get('to');
  const period = to === null ? null : { from: query.get('from'), to };
  const served: Record<string, unknown> = { ...answer };
  if (metal !== null && 'metal' in served) served.metal = metal;
  if (period !== null && url.pathname === '/metals/overview') served.activity = { ...(served.activity as MetalsOverview['activity']), ...period };
  if (period !== null && ['/metals/purchases', '/metals/sales', '/metals/funding'].includes(url.pathname)) Object.assign(served, period);
  return served;
}
