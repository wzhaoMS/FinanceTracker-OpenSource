import type { MetalsEvent, MetalsImportPayload, MetalsOrder, MetalsPayout } from '@finance-tracker/shared/metals-ledger';
import {
  metalItem,
  otherItem,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
  type SyntheticLineInput,
} from '@finance-tracker/shared/metals-ledger-fixtures';

/**
 * The Gold page's synthetic precious-metals ledger, as `holdr.metals-import` v1 payloads for the e2e stack (loaded
 * through the operator's own commands by tests/metalsStack.ts) and checked here by the unit tests against G1a's
 * validator. Invented orders, titles, amounts and last 4s only; every date is relative to `today` (New York), so the
 * period chips have something to tell apart. Every derived field comes from the rules (G1a's synthetic fixtures).
 *
 * What it holds, each a case the page must say (design v8 §11–§12):
 * - Costco: one product bought three times (over a year ago, half a year ago, and in a mixed order whose shipping no
 *   line states, delivered on a day the capture doesn't show), which only the owner can confirm; a 5-pack confirmed
 *   on its own; a cancelled order; a held record. Its card is not approved, so no Costco charge links.
 * - Walmart: a bar whose card charge links (the approved card, one row of its amount); a coin awaiting delivery that a
 *   sale took while it waited, whose charge has no row; a returned and refunded bar (an aggregate that never links);
 *   a 10 g bar whose link holds until a later capture contradicts it (a conflict: quarantined, a possible charge only);
 *   a silver bar returned after the silver sale its delivery covered (that sale's unit is now with no recorded purchase,
 *   because its purchase was returned since; the sale's other unit never had one).
 * - CollectPure: a bar sale (assigned oldest first) whose stated premium reconciles (the dealer's implied spot), a coin
 *   sold while its purchase awaited delivery, a coin with no recorded purchase whose stated premium disagrees with its
 *   price (the day's close stands in), a sale of unknown content, two silver sales (one of unknown content; silver's
 *   deliveries short), a sale whose title names two metals, a cancelled sale, a held record, a payouts capture that read
 *   fewer than it states.
 * - Coverage: each source's capture ends on its own day before today (Costco 3 days ago, CollectPure 2, Walmart 1), so
 *   holdings as of today are partial for that tail alone, and the page says through when each source is covered.
 */

/** The approved card: Walmart's orders on it can link. */
export const GOLD_CARD_LAST4 = '4826';
/** Costco's card, which no Holdr account has: its charges stay "not linked (card not approved yet)". */
export const COSTCO_CARD_LAST4 = '4827';
export const GOLD_CARD_NICKNAME = 'Gold sample card';
/**
 * The approved card's Walmart rows: a Walmart online descriptor (`walmart-online`), so they can link. A descriptor with a
 * bullion word ("… BULLION") is a bullion dealer's (cardMetalsMerchantClass reads it first) and never links to a
 * Walmart order.
 */
export const WALMART_ROW = 'WALMART.COM SAMPLE ORDER';
/** The product the owner confirms in the e2e: three purchases, four units. */
export const COSTCO_PRODUCT_TITLE = 'Sample Mint 1 oz Gold Bar';
/** The other product "Confirm all as proposed" holds: one sale, whose "min." weight only the owner can confirm. */
export const TEN_GRAM_SALE_TITLE = 'Sample Gold Bar 10 g min .999';

export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const event = (kind: MetalsEvent['kind'], date: string | null, quantity = 1): MetalsEvent =>
  ({ kind, date, dateBasis: date === null ? null : 'stated', quantity, occurrence: 1 });
const card = (last4: string, amountMinor: number | null) => ({ kind: 'card' as const, network: 'visa' as const, last4, amountMinor });
const facts = (methods: Array<ReturnType<typeof card>>, grossTotalMinor: number | null,
  patch: Partial<{ refunded: boolean; cancelled: boolean; shipments: number }> = {}) => ({
  fulfilment: { shipments: patch.shipments ?? 1 },
  methods,
  refunded: patch.refunded ?? false,
  cancelled: patch.cancelled ?? false,
  partlyCancelled: false,
  grossTotalMinor,
});

/** Costco lines carry no raw purity, mass basis or design: only the owner can say what one unit contains. */
const COSTCO_BAR = {
  title: COSTCO_PRODUCT_TITLE, productRef: 'costco:1000001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'oz' },
  pack: 'single', purity: null, massBasis: null, design: null,
} as const;
const fineBar = (title: string, productRef: string, mass: { value: string; unit: 'ozt' | 'g' }) => ({
  title, productRef, metal: 'XAU', form: 'bar', statedMass: mass, pack: 'single',
  purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null,
} as const);

type LinePatch = Partial<SyntheticLineInput> & Pick<SyntheticLineInput, 'quantity' | 'unitPriceMinor' | 'events'>;

function costcoOrder(id: string, date: string, lines: LinePatch[], skeleton: Parameters<typeof syntheticOrder>[0]['skeleton'],
  extra: Partial<Parameters<typeof syntheticOrder>[0]> = {}): MetalsOrder {
  return syntheticOrder({
    source: 'costco', channel: 'online', id, date, skeleton,
    lines: lines.map((line, ordinal) => ({ ordinal, ...COSTCO_BAR, ...line }) as SyntheticLineInput),
    ...extra,
  });
}

function costcoPayload(day: (back: number) => string): MetalsImportPayload {
  const once = costcoOrder('c1', day(400), [{ quantity: 1, unitPriceMinor: 205_000, events: [event('delivered', day(396))] }],
    [metalItem(0, 205_000)], { admission: facts([card(COSTCO_CARD_LAST4, 205_000)], 205_000) });
  const twice = costcoOrder('c2', day(200), [{ quantity: 2, unitPriceMinor: 200_000, events: [event('delivered', day(196), 2)] }],
    [metalItem(0, 400_000)], { admission: facts([card(COSTCO_CARD_LAST4, 400_000)], 400_000) });
  // A pack: the owner says what the whole pack holds, for this purchase alone.
  const pack = costcoOrder('c3', day(100), [{
    title: 'Sample Mint 1 g Gold Bar 5-Pack', productRef: 'costco:1000002', statedMass: { value: '1', unit: 'g' }, pack: 'multiple',
    quantity: 1, unitPriceMinor: 45_000, events: [event('delivered', day(95))],
  }], [metalItem(0, 45_000)], { admission: facts([card(COSTCO_CARD_LAST4, 45_000)], 45_000) });
  const cancelled = costcoOrder('c4', day(250), [{ quantity: 1, unitPriceMinor: 199_000, events: [event('cancelled', day(249))] }],
    [metalItem(0, 199_000)], { admission: facts([card(COSTCO_CARD_LAST4, 199_000)], 199_000, { cancelled: true }) });
  // A mixed order whose shipping no line states (cost-unattributed), delivered on a day the capture doesn't show.
  const mixed = costcoOrder('c5', day(60), [{ quantity: 1, unitPriceMinor: 210_000, events: [event('delivered', null)] }],
    [metalItem(0, 210_000), otherItem(1, 2_500)],
    { components: [{ kind: 'shipping', amountMinor: 1_500 }], admission: facts([card(COSTCO_CARD_LAST4, 214_000)], 214_000) });
  return syntheticPayload('costco', {
    orders: [once, twice, pack, cancelled, mixed],
    held: [{ key: syntheticKey('costco', 'order', 'held-1'), channel: 'online', date: day(120), reason: 'retail-held', check: 'retail-held' }],
    coverage: [syntheticCoverage('online', day(420), day(3), 6, 6), syntheticCoverage('warehouse', day(420), day(3), 0, 0)],
  });
}

function walmartOrder(id: string, date: string, line: Omit<SyntheticLineInput, 'ordinal'>, admission: ReturnType<typeof facts>,
  refunds: MetalsOrder['refunds'] = []): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, (line.unitPriceMinor ?? 0) * line.quantity)], components: [{ kind: 'tax', amountMinor: 0 }],
    admission, refunds, lines: [{ ordinal: 0, seller: 'Sample Bullion Shop', ...line }],
  });
}

/** `later` changes the 10 g bar's price: a later capture that contradicts the first (a factual conflict). */
function walmartPayload(day: (back: number) => string, later: boolean): MetalsImportPayload {
  const linked = walmartOrder('w1', day(150), {
    ...fineBar('Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', 'walmart:200001', { value: '1', unit: 'ozt' }),
    quantity: 1, unitPriceMinor: 200_000, events: [event('delivered', day(145))],
  }, facts([card(GOLD_CARD_LAST4, 200_000)], 200_000));
  const awaiting = walmartOrder('w2', day(20), {
    title: 'Sample 1 oz Gold Buffalo Coin', productRef: 'walmart:200002', metal: 'XAU', form: 'coin', statedMass: { value: '1', unit: 'oz' },
    pack: 'single', purity: null, massBasis: 'none', design: 'buffalo', quantity: 1, unitPriceMinor: 265_000, events: [event('shipped', day(18))],
  }, facts([card(GOLD_CARD_LAST4, 265_000)], 265_000));
  const refunded = walmartOrder('w3', day(200), {
    ...fineBar('Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', 'walmart:200001', { value: '1', unit: 'ozt' }),
    quantity: 1, unitPriceMinor: 205_000, events: [event('delivered', day(195)), event('returned', day(185))],
  }, facts([card(GOLD_CARD_LAST4, 205_000)], 205_000, { refunded: true }), [{ amountMinor: -205_000, date: day(184) }]);
  const tenGrams = later ? 87_500 : 87_000;
  const quarantined = walmartOrder('w4', day(120), {
    ...fineBar('Sample Refinery 10 g Gold Bar FINE GOLD .9999', 'walmart:200003', { value: '10', unit: 'g' }),
    quantity: 1, unitPriceMinor: tenGrams, events: [event('delivered', day(115))],
  }, facts([card(GOLD_CARD_LAST4, tenGrams)], tenGrams));
  // Silver, delivered before the silver bar sale and returned after it: on the sale's agreed day it covered one of the
  // sale's units, today none (sold with no recorded purchase: its purchase was cancelled or returned after the sale).
  const returnedSilver = walmartOrder('w5', day(130), {
    title: 'Sample Refinery 10 ozt Silver Bar FINE SILVER .999', productRef: 'walmart:200004', metal: 'XAG', form: 'bar',
    statedMass: { value: '10', unit: 'ozt' }, pack: 'single', purity: { text: '.999', value: '999/1000' }, massBasis: 'fine', design: null,
    quantity: 1, unitPriceMinor: 32_000, events: [event('delivered', day(124)), event('returned', day(80))],
  }, facts([card(GOLD_CARD_LAST4, 32_000)], 32_000, { refunded: true }), [{ amountMinor: -32_000, date: day(79) }]);
  const payload = syntheticPayload('walmart', {
    orders: [linked, awaiting, refunded, quarantined, returnedSilver],
    coverage: [syntheticCoverage('online', day(420), day(1), 5, 5)],
  });
  return {
    ...payload,
    input: { ...payload.input, capturedAt: `${day(later ? 0 : 1)}T12:00:00Z`, captureDigest: (later ? 'c' : 'b').repeat(64) } as MetalsImportPayload['input'],
  };
}

function sale(id: string, date: string, line: Omit<SyntheticLineInput, 'ordinal' | 'events'>,
  money: { grossMinor: number; feeMinor: number; shippingMinor: number }, status: NonNullable<MetalsOrder['status']>, payoutOn: string | null): MetalsOrder {
  const net = money.grossMinor - money.feeMinor - money.shippingMinor;
  const payouts: MetalsPayout[] = status === 'complete' && payoutOn ? [{
    key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '5555', amountMinor: net,
    initiatedDate: shiftDate(payoutOn, -1), payoutDate: payoutOn, status: 'complete',
  }] : [];
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date, tradeMoment: `${date}T15:00:00Z`,
    completedDate: status === 'complete' ? payoutOn : null,
    skeleton: [metalItem(0, money.grossMinor)],
    components: [{ kind: 'platform-fee', amountMinor: -money.feeMinor }, { kind: 'insured-shipping', amountMinor: -money.shippingMinor }],
    lines: [{
      ordinal: 0, ...line,
      events: status === 'cancelled' ? [event('cancelled', null, line.quantity)] : [event('agreed', date, line.quantity)],
      sale: line.sale ?? { program: null, premium: null, inspection: status === 'complete' ? 'passed' : null },
    }],
    status, payouts,
  });
}

const coin = (title: string, productRef: string, design: 'buffalo' | 'eagle' | 'maple-leaf', metal: 'XAU' | 'XAG', quantity: number,
  unitPriceMinor: number) => ({
  title, productRef, metal, form: 'coin', statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design,
  quantity, unitPriceMinor,
} as const);

function collectpurePayload(day: (back: number) => string): MetalsImportPayload {
  const orders = [
    sale('s1', day(60), {
      ...fineBar('1 oz Gold Bar Sample Refinery FINE GOLD .9999', 'collectpure:sample-bar', { value: '1', unit: 'ozt' }),
      // The converter's closed form, and it reconciles: $2,600.00 − $40.00 = a $2,560.00 spot, 1.5625% under the price.
      quantity: 1, unitPriceMinor: 260_000,
      sale: { program: null, premium: { text: 'spot +1.5625% / +$40.00 per troy ounce', basis: 'troy_ounce' }, inspection: 'passed' },
    }, { grossMinor: 260_000, feeMinor: 5_200, shippingMinor: 1_500 }, 'complete', day(52)),
    sale('s2', day(10), coin('1 oz Gold Buffalo Coin Sample', 'collectpure:sample-buffalo', 'buffalo', 'XAU', 1, 265_000),
      { grossMinor: 265_000, feeMinor: 5_300, shippingMinor: 1_500 }, 'received', null),
    // A premium whose percent and dollars disagree with the price: no dealer's spot, the day's close stands in.
    sale('s3', day(30), {
      ...coin('1 oz Gold American Eagle Sample', 'collectpure:sample-eagle', 'eagle', 'XAU', 1, 262_000),
      sale: { program: null, premium: { text: 'spot +5.0000% / +$40.00 per troy ounce', basis: 'troy_ounce' }, inspection: 'passed' },
    }, { grossMinor: 262_000, feeMinor: 5_240, shippingMinor: 1_500 }, 'complete', day(25)),
    sale('s4', day(5), {
      title: TEN_GRAM_SALE_TITLE, productRef: 'collectpure:sample-10g', metal: 'XAU', form: 'bar', statedMass: { value: '10', unit: 'g' },
      pack: 'single', purity: { text: '.999', value: '999/1000' }, massBasis: 'approximate', design: null, quantity: 1, unitPriceMinor: 84_000,
    }, { grossMinor: 84_000, feeMinor: 1_680, shippingMinor: 1_000 }, 'agreed', null),
    sale('s5', day(90), {
      title: 'Sample 10 oz Silver Bar FINE SILVER .999', productRef: 'collectpure:sample-ag-bar', metal: 'XAG', form: 'bar',
      statedMass: { value: '10', unit: 'ozt' }, pack: 'single', purity: { text: '.999', value: '999/1000' }, massBasis: 'fine', design: null,
      quantity: 2, unitPriceMinor: 32_000,
    }, { grossMinor: 64_000, feeMinor: 1_280, shippingMinor: 1_000 }, 'complete', day(82)),
    sale('s6', day(40), coin('1 oz Silver Maple Leaf Sample', 'collectpure:sample-maple', 'maple-leaf', 'XAG', 10, 3_300),
      { grossMinor: 33_000, feeMinor: 660, shippingMinor: 800 }, 'complete', day(33)),
    sale('s7', day(45), {
      title: 'Gold and Silver Sample Medal', productRef: 'collectpure:sample-medal', metal: null, form: null, statedMass: null,
      pack: 'unknown', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 30_000,
    }, { grossMinor: 30_000, feeMinor: 600, shippingMinor: 800 }, 'complete', day(38)),
    sale('s8', day(70), {
      ...fineBar('1 oz Gold Bar Sample Refinery FINE GOLD .9999', 'collectpure:sample-bar', { value: '1', unit: 'ozt' }),
      quantity: 1, unitPriceMinor: 255_000,
    }, { grossMinor: 255_000, feeMinor: 5_100, shippingMinor: 1_500 }, 'cancelled', null),
  ];
  const payload = syntheticPayload('collectpure', {
    orders,
    held: [{ key: syntheticKey('collectpure', 'sell', 'held-1'), channel: 'online', date: day(80), reason: 'inspection-failed', check: 'inspection' }],
    coverage: [syntheticCoverage('sell-orders', day(420), day(2), 9, 9), syntheticCoverage('payouts', day(420), day(2), 6, 5)],
  });
  return { ...payload, input: { ...payload.input, capturedAt: `${day(1)}T12:00:00Z` } as MetalsImportPayload['input'] };
}

export interface GoldLedgerPayloads {
  costco: MetalsImportPayload;
  walmart: MetalsImportPayload;
  /** The later Walmart capture that contradicts the 10 g bar's price. */
  walmartLater: MetalsImportPayload;
  collectpure: MetalsImportPayload;
  /** The dates the specs name. */
  dates: Record<'costcoFirst' | 'costcoSecond' | 'costcoPack' | 'costcoMixed' | 'walmartLinked' | 'walmartLinkedRow' | 'walmartAwaiting'
    | 'walmartQuarantined' | 'walmartQuarantinedRow' | 'barSale' | 'coinSale' | 'unmatchedSale' | 'unknownSale' | 'costcoCovered'
    | 'walmartCovered' | 'collectpureCovered' | 'coverageFrom', string>;
  /** The approved card's rows: the linked bar's charge and the 10 g bar's (a candidate once the conflict lands). */
  cardRows: Array<{ transactionDate: string; amountMinor: number }>;
}

/** Every payload of the ledger for `today` (a New York date, YYYY-MM-DD). */
export function goldLedgerPayloads(today: string): GoldLedgerPayloads {
  const day = (back: number) => shiftDate(today, -back);
  return {
    costco: costcoPayload(day),
    walmart: walmartPayload(day, false),
    walmartLater: walmartPayload(day, true),
    collectpure: collectpurePayload(day),
    dates: {
      costcoFirst: day(400), costcoSecond: day(200), costcoPack: day(100), costcoMixed: day(60), walmartLinked: day(150),
      walmartLinkedRow: day(148), walmartAwaiting: day(20), walmartQuarantined: day(120), walmartQuarantinedRow: day(118), barSale: day(60),
      coinSale: day(10), unmatchedSale: day(30), unknownSale: day(5), costcoCovered: day(3), walmartCovered: day(1), collectpureCovered: day(2),
      coverageFrom: day(420),
    },
    cardRows: [{ transactionDate: day(148), amountMinor: 200_000 }, { transactionDate: day(118), amountMinor: 87_000 }],
  };
}
