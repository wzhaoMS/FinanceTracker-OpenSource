import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  MetalsCompletenessCode, MetalsCoverageEntry, MetalsOverview, MetalsProfitEstimate, MetalsSaleEstimate, MetalsTroyOz, MetalsUnmatchedReason,
} from '@finance-tracker/shared/metals-api';

import {
  complete,
  fundingPurchaseFixture,
  overviewFixture,
  oz,
  partial,
  priceMissingAnswer,
  productFixture,
  purchaseFixture,
  saleFixture,
  soldOutOverview,
  timelineFixture,
  unknown,
} from './goldFixtures';
import {
  AGGREGATE_CARD_TEXT,
  ASSIGNMENT_NOTE,
  ASSIGNMENT_NOTE_FUNGIBLE,
  CARD_LINK_WHY,
  CONTENT_HOLD_WORDS,
  CYCLE_PROFIT_LABEL,
  PERIOD_CHOICES,
  PERIOD_LABELS,
  PERIOD_NO_SALES,
  PRICE_JOIN_DAYS,
  PROFIT_COVERED_LABEL,
  PROFIT_SALES_LABEL,
  REFUSED_WRITE_TEXT,
  SALE_PURCHASE_CONFLICT_TEXT,
  activityWarnings,
  affectsText,
  assignmentMethodText,
  assignmentNote,
  awaitingLine,
  batchPreviewText,
  cardText,
  chartCaption,
  chartMarks,
  chartSeriesFor,
  chartSeriesOf,
  classMetaParts,
  closesInRange,
  confirmCardText,
  confirmableAll,
  contentText,
  contentUnknownLine,
  coverageLines,
  coverageTail,
  deliveryInferredText,
  depositSummary,
  forInformationText,
  fungibleFor,
  goldPageView,
  headlineWarning,
  heldForAnswerLine,
  heldUnknownText,
  holdingsClassesTitle,
  holdingsFigure,
  levelShiftText,
  lineText,
  linesNoun,
  measureWarning,
  metalUnknownLine,
  moneyFigure,
  monthSentence,
  needsYouText,
  ouncesTick,
  ouncesTop,
  ownerReasons,
  parseTroyOzInput,
  payoutLines,
  payoutText,
  periodDates,
  periodSalesNone,
  periodScope,
  premiumText,
  previewText,
  priceChartStart,
  priceLine,
  priceNote,
  pricePerTroyOz,
  productGroups,
  profitCoverageText,
  profitMethod,
  profitUnknownText,
  proposalQuestion,
  purchaseSummary,
  reasonText,
  receiptCounts,
  receiptText,
  reconciliationLines,
  refundsText,
  refusedBatchText,
  saleNotes,
  saleSummary,
  scopeText,
  setAside,
  setAsideMeta,
  soldDetail,
  soldUnmatchedText,
  sourceMetaParts,
  SPOT_OFF_WORDS,
  spotFigure,
  spotShown,
  summaryWarning,
  switchMetals,
  troyOzLine,
  troyOzNumber,
  unitsText,
  unmatchedReasonsOf,
  unmatchedReasonsText,
  unmatchedSaleText,
  unresolvedMetalHeldLine,
  withState,
} from './goldText';

test('the headline says what recorded holdings are as of, and the close they are valued at', () => {
  const overview = overviewFixture();
  assert.deepEqual(holdingsFigure(overview), { figure: '2.000 troy oz', short: null });
  assert.equal(priceNote(overview.price, 'XAU'),
    'Estimated value at spot · gold, CNBC daily close of Nov 6, 2026 · not a price you could sell at today');
  assert.equal(priceNote({ ...overview.price, stale: true }, 'XAG'),
    'Estimated value at spot · silver, CNBC daily close of Nov 6, 2026 · not a price you could sell at today · that close is more than 5 weekdays old');
  assert.equal(moneyFigure(unknown<number>(['price-missing', 1])), '—');
  assert.equal(moneyFigure(complete(130_080), true), '+$1,300.80');
  assert.equal(moneyFigure(complete(-500), true), '−$5.00');
});

test('values at spot show only on a Holdr that fetches closes and has one: else "Prices off" or "No price yet", never a number (v0)', () => {
  const { price } = overviewFixture();
  assert.equal(spotShown(price), 'shown');
  // Doesn't fetch: prices off, whatever closes are stored, a stale one included.
  for (const stored of [price, { ...price, stale: true }, { ...price, closeDate: null, close: null }]) {
    assert.equal(spotShown({ ...stored, fetching: false }), 'prices-off');
    assert.equal(priceNote({ ...stored, fetching: false }, 'XAU'),
      'Prices off: this Holdr doesn\'t fetch CNBC daily closes, so no value or gain at spot shows. Ounces and costs still show.');
  }
  // Fetches, but no close yet.
  const none = { ...price, closeDate: null, close: null };
  assert.equal(spotShown(none), 'no-price-yet');
  assert.equal(priceNote(none, 'XPT'),
    'No price yet: no usable CNBC daily close for platinum is stored yet, so no value or gain at spot shows. Ounces and costs still show.');
  // Fetches, with a stale close: values show, with their stale words.
  const stale = { ...price, stale: true };
  assert.equal(spotShown(stale), 'shown');
  // A value or gain: its figure while values show, else the words alone, never its amount.
  assert.equal(spotFigure(complete(530_080), 'shown'), '$5,300.80');
  assert.equal(spotFigure(complete(130_080), 'shown', true), '+$1,300.80');
  assert.equal(spotFigure(unknown<number>(['price-missing', 1]), 'shown'), '—');
  assert.equal(spotFigure(complete(530_080), 'prices-off'), 'Prices off');
  assert.equal(spotFigure(complete(130_080), 'prices-off', true), 'Prices off');
  assert.equal(spotFigure(unknown<number>(['price-missing', 1]), 'no-price-yet', true), 'No price yet');
  assert.deepEqual(SPOT_OFF_WORDS, { 'prices-off': 'Prices off', 'no-price-yet': 'No price yet' });
});

test('recorded deliveries short of what was sold say so instead of a bare zero', () => {
  const overview = overviewFixture();
  overview.holdings.troyOz = partial(oz('0', '0.000'), ['unmatched-sales', 1]);
  overview.holdings.units = { ...overview.holdings.units, delivered: 0, sold: 1, soldFromDelivered: 0, unmatched: 1, held: 0 };
  assert.deepEqual(holdingsFigure(overview), { figure: null, short: 'Recorded deliveries are short by 1 unit' });
});

test('a partial headline names what waits for the owner, never a bare code', () => {
  const overview = overviewFixture({
    toCheck: {
      records: 4, needsYou: [{ code: 'confirm-content', products: 3 }],
      forInformation: [{ code: 'unmatched-sales', units: 1, reasons: [{ reason: 'no-recorded-purchase', units: 1 }] }],
    },
  });
  overview.holdings.units = { ...overview.holdings.units, unmatched: 1 };
  const troyOz = partial(oz('2', '2.000'), ['content-unknown', 3], ['unmatched-sales', 1]);
  assert.equal(measureWarning(troyOz, 'XAU', ownerReasons(overview)),
    'Partial: 3 products need your answer: what each contains · 1 unit sold has no recorded purchase');
  assert.equal(measureWarning(complete(1), 'XAU'), null);
  assert.equal(measureWarning(unknown(['price-missing', 1]), 'XAU'), 'Unknown: no CNBC daily close for gold is recorded');
  assert.equal(measureWarning(partial(1, ['cost-unattributed', 2]), 'XAU'),
    'Partial: 2 purchases have part of their order\'s cost not assigned to them');
  assert.equal(measureWarning(partial(1, ['cost-unattributed', 1]), 'XAU'),
    'Partial: 1 purchase has part of its order\'s cost not assigned to it');
});

test('awaiting delivery is said in full and as what no sale took (Astra v2)', () => {
  const overview = overviewFixture();
  overview.holdings.units = { ...overview.holdings.units, awaiting: 2, soldFromAwaiting: 1, awaitingUnassigned: 1 };
  overview.holdings.awaitingTroyOz = complete(oz('2', '2.000'));
  overview.holdings.awaitingUnassignedTroyOz = complete(oz('1', '1.000'));
  assert.equal(awaitingLine(overview), 'Awaiting delivery: 2.000 troy oz, of which 1.000 not assigned to a sale');
  assert.equal(awaitingLine(overviewFixture()), null);
  // Each figure says its state: partial beside its number.
  overview.holdings.awaitingTroyOz = partial(oz('2', '2.000'), ['not-covered', 1]);
  overview.holdings.awaitingUnassignedTroyOz = partial(oz('1', '1.000'), ['not-covered', 1]);
  assert.equal(awaitingLine(overview), 'Awaiting delivery: 2.000 troy oz (partial), of which 1.000 (partial) not assigned to a sale');
  // Unknown is said, never a number: a zero with reasons comes unknown (G3), and so can every awaiting ounce.
  overview.holdings.units = { ...overview.holdings.units, awaitingUnassigned: 0 };
  overview.holdings.awaitingUnassignedTroyOz = unknown<MetalsTroyOz>(['not-covered', 1]);
  assert.equal(awaitingLine(overview), 'Awaiting delivery: 2.000 troy oz (partial), of which — (unknown) not assigned to a sale');
  overview.holdings.awaitingTroyOz = unknown<MetalsTroyOz>(['content-unknown', 1]);
  assert.equal(awaitingLine(overview), 'Awaiting delivery: 2 units (ounces unknown), of which — (unknown) not assigned to a sale');
  assert.doesNotMatch(awaitingLine(overview)!, /\b0\b|0\.000/);
});

test('reconciliation names the sale assigned to an awaiting purchase and the unmatched sale, holdings unchanged', () => {
  // Delivered 2, awaiting 1; sold 2: one from the awaiting purchase, one with no recorded purchase. Holdings stay 2.
  const units = { delivered: 2, awaiting: 1, sold: 2, soldFromDelivered: 0, soldFromAwaiting: 1, unmatched: 1, held: 2, awaitingUnassigned: 0 };
  assert.deepEqual(reconciliationLines(units, [{ reason: 'no-recorded-purchase', units: 1 }]), [
    'Delivered 2 · Sold 2 · Recorded holdings 2',
    '1 unit was sold while awaiting delivery: assigned to a purchase not delivered yet',
    '1 unit was sold with no recorded purchase: likely bought before a source\'s records begin, or from a source not captured',
  ]);
  // Each reason with its count; reasons that don't add up to the units are left unsaid rather than misattributed.
  assert.equal(reconciliationLines({ ...units, sold: 3, unmatched: 2 }, [
    { reason: 'no-recorded-purchase', units: 1 }, { reason: 'purchase-cancelled-or-returned', units: 1 },
  ])[2], '2 units were sold with no recorded purchase: 1 likely bought before a source\'s records begin, or from a source not captured; '
    + '1 whose purchase was cancelled or returned after the sale');
  assert.equal(reconciliationLines(units, [{ reason: 'purchase-cancelled-or-returned', units: 2 }])[2], '1 unit was sold with no recorded purchase');
  assert.deepEqual(reconciliationLines({ ...units, sold: 0, soldFromAwaiting: 0, unmatched: 0 }), ['Delivered 2 · Sold 0 · Recorded holdings 2']);
});

test('reconciliation under the owner\'s fungible policy: the units counted delivered because a sale took them, right under the sum', () => {
  // A class of form `any`: the awaiting unit a sale took reads delivered (D and S_D rise, A and S_A fall), so D − S = H.
  const units = { delivered: 2, awaiting: 0, sold: 2, soldFromDelivered: 2, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0 };
  assert.deepEqual(reconciliationLines(units, [], 1), [
    'Delivered 2 · Sold 2 · Recorded holdings 0',
    '1 unit counts as delivered because a sale took it (your rule); no delivery is recorded for it',
  ]);
  // Beside the other lines it comes first: it explains the Delivered figure.
  assert.deepEqual(reconciliationLines({ ...units, sold: 3, unmatched: 1 }, [{ reason: 'no-recorded-purchase', units: 1 }], 2), [
    'Delivered 2 · Sold 3 · Recorded holdings 0',
    '2 units count as delivered because a sale took them (your rule); no delivery is recorded for them',
    '1 unit was sold with no recorded purchase: likely bought before a source\'s records begin, or from a source not captured',
  ]);
  // None inferred (0, or no field, as metals-assignment-v1 serves every class): the lines are as before.
  const before = { ...units, delivered: 1, awaiting: 1, soldFromDelivered: 1, soldFromAwaiting: 1, held: 0 };
  assert.deepEqual(reconciliationLines(before, [], 0), reconciliationLines(before));
  assert.deepEqual(reconciliationLines(before, [], undefined), [
    'Delivered 1 · Sold 2 · Recorded holdings 0',
    '1 unit was sold while awaiting delivery: assigned to a purchase not delivered yet',
  ]);
  assert.equal(deliveryInferredText(1), '1 unit counts as delivered because a sale took it (your rule); no delivery is recorded for it');
  assert.equal(deliveryInferredText(3), '3 units count as delivered because a sale took them (your rule); no delivery is recorded for them');
});

test('the owner\'s fungible policy: "across all forms (your rule)" only for a metal a read says it names; unset, the words as before', () => {
  const policy = (fungible: Array<'XAU' | 'XAG'>) => ({ assignment: { rule: 'metals-assignment-v1+fungible' as const, fungible } });
  // Unset, no read carries `assignment`; a metal the policy doesn't name keeps metals-assignment-v1's words.
  assert.equal(fungibleFor(null, 'XAU'), false);
  assert.equal(fungibleFor(undefined, 'XAU'), false);
  assert.equal(fungibleFor({}, 'XAU'), false);
  assert.equal(fungibleFor(overviewFixture(), 'XAU'), false);
  assert.equal(fungibleFor(policy(['XAG']), 'XAU'), false);
  assert.equal(fungibleFor(policy(['XAU']), 'XAG'), false);
  assert.equal(fungibleFor(policy(['XAU']), 'XAU'), true);
  assert.equal(fungibleFor(policy(['XAU', 'XAG']), 'XAG'), true);
  assert.equal(assignmentNote(false), ASSIGNMENT_NOTE);
  assert.equal(assignmentNote(true), ASSIGNMENT_NOTE_FUNGIBLE);
  assert.equal(ASSIGNMENT_NOTE_FUNGIBLE, 'Purchases assigned oldest first across all forms (your rule) — not a confirmed physical match.');
  // Where these figures come from: unset, the sentence the page said before the policy, word for word.
  assert.equal(assignmentMethodText(false), 'Purchases assigned oldest first — not a confirmed physical match. Within each kind of item '
    + '(metal, form and fine content per unit), the earliest purchase not yet assigned goes to each sale.');
  assert.equal(assignmentMethodText(true), 'Purchases assigned oldest first across all forms (your rule) — not a confirmed physical match. '
    + 'Within each kind of item (metal and fine content per unit, every form together), the earliest purchase not yet assigned goes to '
    + 'each sale; a unit a sale took before its delivery was recorded counts as delivered from the day the sale was agreed.');
  // The period's method under its profit or loss.
  assert.equal(profitMethod(false), 'What the sales brought in minus what those units cost, earliest units first');
  assert.equal(profitMethod(true), 'What the sales brought in minus what those units cost, earliest units first across all forms (your rule)');
  // Holdings' classes: by form, or by fine content with every form together.
  assert.equal(holdingsClassesTitle(false), 'By form');
  assert.equal(holdingsClassesTitle(true), 'By fine content, all forms together (your rule)');
});

test('a period\'s sales are known none only with no sale line, a complete measure and no sale of unresolved metal (Astra\'s R5)', () => {
  const base = overviewFixture();
  const sold = base.activity.sold;
  const at = (patch: Partial<typeof sold>, metalUnknown = base.metalUnknown) =>
    periodSalesNone({ ...base, metalUnknown, activity: { ...base.activity, sold: { ...sold, ...patch } } });
  assert.equal(PERIOD_NO_SALES, 'No sales recorded in this period');
  assert.equal(at({ lines: 0, units: 0, netMinor: complete(0) }), true);
  // Sales that may be missing or unread are never said as none.
  assert.equal(at({ lines: 0, units: 0, netMinor: partial(0, ['not-covered', 1]) }), false);
  assert.equal(at({ lines: 0, units: 0, netMinor: unknown<number>(['not-covered', 1]) }), false);
  // A sale of unresolved metal is in no metal's sales: its record keeps the figures.
  assert.equal(at({ lines: 0, units: 0, netMinor: complete(0) }, { ...base.metalUnknown, sales: 1, saleNetMinor: 28_600 }), false);
  // Recorded sales, whatever their result.
  assert.equal(at({}), false);
});

test('the period\'s profit or loss is labelled before rewards: never read as a final result (ROOT, from the owner\'s reaction)', () => {
  assert.equal(PROFIT_SALES_LABEL, 'Profit or loss on these sales, before rewards');
  assert.equal(PROFIT_COVERED_LABEL, 'Profit or loss on covered sales, before rewards');
  // A sale's assigned purchase, in its details, too.
  assert.equal(CYCLE_PROFIT_LABEL, 'Profit/loss before rewards');
});

test('everything recorded sold, and units sold with no purchase recorded at all: what you hold says why it is unknown, never a zero (ROOT)', () => {
  const soldOut = soldOutOverview();
  const because = 'Unknown because all your recorded purchases kept or on the way are sold, but 2 units you sold have no recorded '
    + 'purchase yet. Finding those purchases would confirm whether you hold 0 troy oz.';
  assert.equal(heldUnknownText(soldOut), because);
  /** The same state with one thing changed. */
  const withHoldings = (patch: Partial<MetalsOverview['holdings']>): MetalsOverview => ({ ...soldOut, holdings: { ...soldOut.holdings, ...patch } });
  const withUnits = (patch: Partial<MetalsOverview['holdings']['units']>) => withHoldings({ units: { ...soldOut.holdings.units, ...patch } });
  const withReasons = (...reasons: Array<[MetalsCompletenessCode, number]>) => withHoldings({ troyOz: unknown<MetalsTroyOz>(...reasons) });
  const withUnmatched = (count: number, reasons: Array<{ reason: MetalsUnmatchedReason; units: number }>): MetalsOverview => ({
    ...withUnits({ unmatched: count, sold: 1 + count }),
    toCheck: { records: 1, needsYou: [], forInformation: [{ code: 'unmatched-sales', units: count, reasons }] },
  });
  assert.equal(heldUnknownText(withUnmatched(1, [{ reason: 'no-recorded-purchase', units: 1 }])),
    'Unknown because all your recorded purchases kept or on the way are sold, but 1 unit you sold has no recorded purchase '
    + 'yet. Finding that purchase would confirm whether you hold 0 troy oz.');
  // Coverage gaps too: the facts alone, never as the only cause, and nothing said of what finding them would settle.
  assert.equal(heldUnknownText(withReasons(['unmatched-sales', 1], ['not-covered', 2])),
    'Unknown: all your recorded purchases kept or on the way are sold, but 2 units you sold have no recorded purchase yet.');
  // Units on the way that a sale took while they waited: still every recorded purchase sold.
  assert.equal(heldUnknownText(withUnits({ awaiting: 1, soldFromAwaiting: 1, sold: 4 })), because);
  // The owner's estimate switch naming the metal: an estimated cost is never a holding, so the words are the same.
  const switched: MetalsOverview = {
    ...soldOut,
    holdings: {
      ...soldOut.holdings,
      classes: soldOut.holdings.classes.map((entry) => ({ ...entry, estimate: { units: 2, costMinor: 400_000, unestimatedUnits: 0 } })),
    },
    activity: {
      ...soldOut.activity,
      profit: {
        ...soldOut.activity.profit,
        estimate: {
          recordedMinor: 45_000, estimatedMinor: 14_000, costOfSales: { recordedMinor: 200_000, estimatedMinor: 400_000 },
          estimated: { lines: 1, units: 2, troyOz: oz('2', '2.000') }, unestimatedUnits: 0,
        },
      },
    },
  };
  assert.equal(heldUnknownText(switched), because);
  // No such line otherwise. A unit whose purchase was cancelled or returned after its sale had a recorded purchase, alone or
  // beside units that never had one; and To check must account for every unit.
  assert.equal(heldUnknownText(withUnmatched(2, [{ reason: 'purchase-cancelled-or-returned', units: 2 }])), null);
  assert.equal(heldUnknownText(withUnmatched(2, [{ reason: 'no-recorded-purchase', units: 1 }, { reason: 'purchase-cancelled-or-returned', units: 1 }])), null);
  assert.equal(heldUnknownText(withUnmatched(2, [{ reason: 'no-recorded-purchase', units: 1 }])), null);
  assert.equal(heldUnknownText({ ...soldOut, toCheck: { records: 0, needsYou: [], forInformation: [] } }), null);
  // Any reason that can keep a recorded purchase out of the units; or none naming the unmatched sales.
  for (const code of ['content-unknown', 'conflict', 'date-unknown', 'source-held'] as const) {
    assert.equal(heldUnknownText(withReasons(['unmatched-sales', 1], [code, 1])), null, code);
  }
  assert.equal(heldUnknownText(withReasons()), null);
  assert.equal(heldUnknownText(withReasons(['not-covered', 1])), null);
  // Anything held, or on the way and not sold; a purchase kept of unknown content or of unresolved metal (any could be
  // this metal's holding).
  assert.equal(heldUnknownText(withUnits({ delivered: 2, held: 1 })), null);
  assert.equal(heldUnknownText(withUnits({ awaiting: 1, awaitingUnassigned: 1 })), null);
  const kept = { lots: 1, units: 1, costMinor: 200_000, sales: 0, saleNetMinor: 0 };
  assert.equal(heldUnknownText(withHoldings({ contentUnknown: kept })), null);
  assert.equal(heldUnknownText({ ...soldOut, metalUnknown: kept }), null);
  // Ounces with a figure, or no sale without a purchase.
  assert.equal(heldUnknownText(overviewFixture()), null);
  assert.equal(heldUnknownText(withHoldings({ troyOz: partial(oz('0/1', '0.000'), ['unmatched-sales', 1]) })), null);
  assert.equal(heldUnknownText(withUnits({ unmatched: 0, sold: 1 })), null);
});

test('sold with no recorded purchase: each reason said, never "bought before" for a purchase cancelled or returned since', () => {
  assert.equal(unmatchedReasonsText([]), null);
  assert.equal(unmatchedReasonsText([{ reason: 'purchase-cancelled-or-returned', units: 1 }]), 'its purchase was cancelled or returned after the sale');
  assert.equal(unmatchedReasonsText([{ reason: 'purchase-cancelled-or-returned', units: 2 }]),
    'their purchases were cancelled or returned after the sale');
  assert.equal(soldUnmatchedText({ units: 0, netMinor: 0, reasons: [] }), null);
  assert.equal(soldUnmatchedText({ units: 3, netMinor: 300_000, reasons: [
    { reason: 'no-recorded-purchase', units: 1, netMinor: 100_000 }, { reason: 'purchase-cancelled-or-returned', units: 2, netMinor: 200_000 },
  ] }), 'Sold with no recorded purchase: 3 units, $3,000.00 net (1 likely bought before a source\'s records begin, or from a source not '
    + 'captured; 2 whose purchases were cancelled or returned after the sale)');
  const overview = overviewFixture({
    toCheck: { records: 1, needsYou: [], forInformation: [{ code: 'unmatched-sales', units: 1, reasons: [{ reason: 'purchase-cancelled-or-returned', units: 1 }] }] },
  });
  assert.deepEqual(unmatchedReasonsOf(overview), [{ reason: 'purchase-cancelled-or-returned', units: 1 }]);
  assert.deepEqual(unmatchedReasonsOf(overviewFixture()), []);
});

test('content-unknown purchases and sales stay out of the ounces, said once beside them', () => {
  const overview = overviewFixture();
  overview.holdings.contentUnknown = { lots: 1, units: 2, costMinor: 410_000, sales: 1, saleNetMinor: 120_000 };
  assert.equal(contentUnknownLine(overview),
    'Not in the ounces above: 1 purchase (2 units kept or on the way, cost $4,100.00) with unknown content · 1 sale (net $1,200.00) with unknown content');
  assert.equal(contentUnknownLine(overviewFixture()), null);
});

test('profit or loss says its coverage: troy oz only when every sale line has known content', () => {
  assert.equal(profitCoverageText({ basis: 'troy-oz', known: oz('1', '1.000'), total: oz('2', '2.000'), unknownContentLines: 0 }),
    'known for 1.000 of 2.000 troy oz sold');
  // One fully costed sale and one content-unknown sale stay partial, in sale lines.
  assert.equal(profitCoverageText({ basis: 'sale-lines', known: 1, total: 2, unknownContentLines: 1 }),
    'known for 1 of 2 sale lines · 1 has unknown content');
  assert.equal(profitUnknownText({ basis: 'sale-lines', known: 0, total: 1, unknownContentLines: 1 }, 1),
    'Not known for any sale line in this period: known for 0 of 1 sale line · 1 has unknown content.');
  assert.equal(profitUnknownText({ basis: 'troy-oz', known: oz('0', '0.000'), total: oz('0', '0.000'), unknownContentLines: 0 }, 0),
    'No sales in this period.');
});

test('the owner\'s estimate switch: the profit basis counts the estimated part, and a sale says its cost as estimated', () => {
  const troyOz = { basis: 'troy-oz', known: oz('1', '1.000'), total: oz('3', '3.000'), unknownContentLines: 0 } as const;
  const lines = { basis: 'sale-lines', known: 1, total: 3, unknownContentLines: 1 } as const;
  const estimate = (units: number, display: string): MetalsProfitEstimate => ({
    recordedMinor: 7_000, estimatedMinor: units * 7_000, costOfSales: { recordedMinor: 200_000, estimatedMinor: units * 200_000 },
    estimated: { lines: units, units, troyOz: oz(`${units}`, display) }, unestimatedUnits: 1,
  });
  // Without the switch, or with nothing estimated in the period: today's words exactly.
  assert.equal(profitCoverageText(troyOz), 'known for 1.000 of 3.000 troy oz sold');
  assert.equal(profitCoverageText(troyOz, estimate(0, '0.000')), 'known for 1.000 of 3.000 troy oz sold');
  assert.equal(profitCoverageText(lines, estimate(0, '0.000')), 'known for 1 of 3 sale lines · 1 has unknown content');
  // The figure sums the estimated units too, so the basis counts them apart from what is known.
  assert.equal(profitCoverageText(troyOz, estimate(1, '1.000')), 'known for 1.000 and estimated for 1.000 of 3.000 troy oz sold');
  assert.equal(profitCoverageText(lines, estimate(1, '1.000')), 'known for 1 and estimated for 1 of 3 sale lines · 1 has unknown content');

  // A sale's units with no recorded purchase: their cost and result said as estimated, with the purchase read; else as before.
  const unmatched = { units: 1, netMinor: 207_000, reasons: [{ reason: 'no-recorded-purchase' as const, units: 1, netMinor: 207_000 }] };
  const unknownCost = '1 unit has no recorded purchase (likely bought before a source\'s records begin, or from a source not captured): '
    + '$2,070.00 of proceeds with unknown cost and result';
  assert.equal(unmatchedSaleText(saleFixture({ unmatched })), unknownCost);
  assert.equal(unmatchedSaleText(saleFixture({ unmatched, estimate: null })), unknownCost);
  const estimated: MetalsSaleEstimate = {
    units: 1, unitCostMinor: 200_000, costMinor: 200_000, proceedsMinor: 207_000, profitMinor: 7_000, recorded: { costMinor: null, profitMinor: null },
    from: {
      lotKey: 'walmart-line-aaaa', orderKey: 'walmart-order-aaaa', orderDate: '2026-01-10',
      account: { accountId: 'mtl-acct-aaaa', source: 'walmart', label: 'Walmart account 1' }, daysFromOrderToSale: -5,
    },
  };
  assert.equal(unmatchedSaleText(saleFixture({ unmatched, estimate: estimated })),
    '1 unit has no recorded purchase (likely bought before a source\'s records begin, or from a source not captured). Estimated from '
    + 'your nearest purchase of the same kind (Jan 10, 2026, Walmart account 1): cost $2,000.00, result +$70.00 on $2,070.00 of '
    + 'proceeds, before rewards.');
  assert.match(unmatchedSaleText(saleFixture({ unmatched, estimate: { ...estimated, costMinor: 210_000, profitMinor: -3_000 } })) ?? '',
    /: cost \$2,100\.00, result −\$30\.00 on \$2,070\.00 of proceeds, before rewards\.$/);
});

test('the period chips: 1M, 3M, 6M rolling back from today, this year so far, all; and what they apply to', () => {
  assert.deepEqual(PERIOD_CHOICES.map((choice) => PERIOD_LABELS[choice]), ['1M', '3M', '6M', 'YTD', 'All']);
  assert.deepEqual(periodDates('1m', '2026-11-08'), { from: '2026-10-09', to: '2026-11-08' });
  assert.deepEqual(periodDates('3m', '2026-11-08'), { from: '2026-08-09', to: '2026-11-08' });
  assert.deepEqual(periodDates('6m', '2026-11-08'), { from: '2026-05-09', to: '2026-11-08' });
  // A shorter month's last day stands in for a missing one; the year rolls back with the month.
  assert.deepEqual(periodDates('1m', '2026-03-31'), { from: '2026-03-01', to: '2026-03-31' });
  assert.deepEqual(periodDates('6m', '2026-08-31'), { from: '2026-03-01', to: '2026-08-31' });
  assert.deepEqual(periodDates('1m', '2026-01-15'), { from: '2025-12-16', to: '2026-01-15' });
  assert.deepEqual(periodDates('ytd', '2026-11-08'), { from: '2026-01-01', to: '2026-11-08' });
  assert.deepEqual(periodDates('all', '2026-11-08'), { from: null, to: '2026-11-08' });
  assert.equal(periodScope('6m', periodDates('6m', '2026-11-08')), 'last 6 months (May 9, 2026 – Nov 8, 2026)');
  assert.equal(periodScope('ytd', periodDates('ytd', '2026-11-08')), 'this year so far (Jan 1, 2026 – Nov 8, 2026)');
  assert.equal(periodScope('all', periodDates('all', '2026-11-08')), 'all recorded history');
});

test('to check: what needs the owner, and what is for their information, each with why', () => {
  // Only what the page lets the owner answer says "needs your answer" (v0); the rest is information, said as not counted.
  assert.equal(needsYouText({ code: 'confirm-content', products: 3 }), '3 products need your answer: what each contains');
  assert.equal(needsYouText({ code: 'confirm-content', products: 1 }), '1 product needs your answer: what it contains');
  assert.equal(needsYouText({ code: 'confirmation-drift', products: 1 }), '1 purchase differs from what you confirmed');
  assert.equal(forInformationText({ code: 'unmatched-sales', units: 1, reasons: [{ reason: 'no-recorded-purchase', units: 1 }] }),
    '1 unit sold has no recorded purchase: likely bought before a source\'s records begin, or from a source not captured');
  assert.equal(forInformationText({ code: 'unmatched-sales', units: 1, reasons: [{ reason: 'purchase-cancelled-or-returned', units: 1 }] }),
    '1 unit sold has no recorded purchase: its purchase was cancelled or returned after the sale');
  assert.equal(forInformationText({ code: 'card-not-linked', charges: 2, states: [{ state: 'binding-missing', count: 2 }] }),
    '2 card charges not linked (card not approved yet)');
  assert.equal(forInformationText({ code: 'deposit-not-linked', deposits: 1, states: [{ state: 'not-covered', count: 1, coveredThrough: '2026-10-31' }], mixedMetal: 0 }),
    '1 deposit not linked (checking not imported after Oct 31, 2026)');
  // Deposits of sales of more than one metal, or with a line of unknown metal: listed apart, in no one metal.
  assert.equal(forInformationText({ code: 'deposit-not-linked', deposits: 1, states: [{ state: 'binding-missing', count: 1, coveredThrough: null }], mixedMetal: 2 }),
    '1 deposit not linked (checking account not approved yet); 2 deposits of sales of more than one metal, or with a line of unknown metal, '
      + 'not linked, counted in no one metal');
  assert.equal(forInformationText({ code: 'deposit-not-linked', deposits: 0, states: [], mixedMetal: 1 }),
    '1 deposit of sales of more than one metal, or with a line of unknown metal, not linked, counted in no one metal');
  assert.equal(forInformationText({ code: 'source-held', records: 2, reasons: [{ reason: 'return-unlinked', count: 2 }] }),
    '2 records a source couldn\'t read are held and not counted (a return not tied to a purchase)');
  assert.equal(forInformationText({ code: 'source-held', records: 1, reasons: [] }), '1 record a source couldn\'t read is held and not counted');
  assert.equal(forInformationText({ code: 'conflict', orders: 2 }), '2 orders have records that disagree, waiting for review, not counted');
  assert.equal(reasonText({ code: 'source-held', records: 1 }, 'XAU'), '1 record is held and not counted');
  assert.equal(reasonText({ code: 'conflict', records: 1 }, 'XAU'), '1 order has records that disagree, waiting for review, not counted');
  // Only while the owner's estimate switch names the metal (HOLDR_METALS_ESTIMATE_UNMATCHED).
  assert.equal(reasonText({ code: 'cost-estimated', records: 2 }, 'XAU'),
    '2 sales have units with no recorded purchase, at a cost estimated from your nearest purchase of the same kind');
  assert.equal(CARD_LINK_WHY['competitor-held'], 'a held record could be that charge');
  assert.equal(forInformationText({ code: 'metal-unknown', records: 1 }), '1 record has an unresolved metal, so it is not included in any metal\'s figures');
  assert.equal(forInformationText({ code: 'metal-unknown', records: 3 }), '3 records have an unresolved metal, so they are not included in any metal\'s figures');
  assert.equal(forInformationText({ code: 'premium-disagreement', records: 1 }),
    '1 sale states a premium that can\'t be read or doesn\'t match the price, so the agreed day\'s close stands in for its spot, a proxy');
  assert.equal(forInformationText({ code: 'premium-disagreement', records: 2 }),
    '2 sales state premiums that can\'t be read or don\'t match the price, so the agreed day\'s close stands in for their spot, a proxy');
});

test('a purchase\'s card line: a link names the card and its ending; otherwise why not', () => {
  const linked = purchaseFixture().cards[0];
  assert.equal(cardText(linked), 'Paid by Sample Rewards ending 1111 · card charge of Mar 11, 2026');
  assert.equal(cardText({ ...linked, state: 'binding-missing', proof: false, row: null }), 'Card charge not linked: card not approved yet');
  assert.equal(cardText({ ...linked, state: 'ineligible', proof: false }),
    'Possible card charge: Sample Rewards ending 1111 on Mar 11, 2026, not linked: the order\'s records changed, so a match proves nothing');
  assert.match(AGGREGATE_CARD_TEXT, /^Card charge not linked: /);
  assert.equal(premiumText(purchaseFixture()), 'premium paid $45.00 per troy oz over the spot at the close of Mar 9, 2026, a proxy');
  assert.equal(premiumText(purchaseFixture({ premiumPaidPerOzMinor: null })), null);
});

test('units and what is set aside: cancelled or returned purchases count in nothing', () => {
  assert.equal(unitsText({ ordered: 1, cancelled: 0, returned: 0, delivered: 1, awaiting: 0 }), '1');
  assert.equal(unitsText({ ordered: 3, cancelled: 1, returned: 0, delivered: 1, awaiting: 1 }), '3 ordered: 1 delivered, 1 awaiting delivery, 1 cancelled');
  assert.equal(setAside(purchaseFixture({ units: { ordered: 1, cancelled: 1, returned: 0, delivered: 0, awaiting: 0 } })), true);
  assert.equal(setAside(purchaseFixture()), false);
});

test('a sale: net and its deposit state; each payout paid to its account, possible, or not linked with why', () => {
  const sale = saleFixture();
  assert.equal(saleSummary(sale), '$2,450.00 net · Deposit linked');
  assert.equal(payoutText(sale.payouts[0]), '$2,450.00 paid to Sample Checking ending 0001 on Jun 10, 2026');
  const possible = { ...sale.payouts[0], deposit: { ...sale.payouts[0].deposit, state: 'possible' as const, proof: false } };
  assert.equal(payoutText(possible),
    '$2,450.00 paid out on Jun 10, 2026 · Possible deposit: Sample Checking ending 0001 on Jun 11, 2026, not confirmed as this payout');
  assert.equal(depositSummary([possible]), 'Possible deposit');
  const uncovered = { ...sale.payouts[0], deposit: { state: 'not-covered' as const, proof: false, row: null, coveredThrough: '2026-05-31' } };
  assert.equal(payoutText(uncovered), '$2,450.00 paid out on Jun 10, 2026 · Deposit not linked: checking not imported after May 31, 2026');
  assert.equal(depositSummary([uncovered]), 'Deposit not linked');
  assert.equal(depositSummary([]), 'No payout');
  assert.equal(unmatchedSaleText(saleFixture({ unmatched: { units: 1, netMinor: 120_000, reasons: [{ reason: 'no-recorded-purchase', units: 1, netMinor: 120_000 }] } })),
    '1 unit has no recorded purchase (likely bought before a source\'s records begin, or from a source not captured): $1,200.00 of proceeds '
    + 'with unknown cost and result');
  assert.equal(unmatchedSaleText(saleFixture({ unmatched: { units: 2, netMinor: 240_000, reasons: [
    { reason: 'no-recorded-purchase', units: 1, netMinor: 120_000 }, { reason: 'purchase-cancelled-or-returned', units: 1, netMinor: 120_000 },
  ] } })), '2 units have no recorded purchase (1 likely bought before a source\'s records begin, or from a source not captured; 1 whose '
    + 'purchase was cancelled or returned after the sale): $2,400.00 of proceeds with unknown cost and result');
  assert.equal(ASSIGNMENT_NOTE, 'Purchases assigned oldest first — not a confirmed physical match.');
});

test('content: its authority, or why it is unknown', () => {
  assert.equal(contentText(saleFixture().content), '1.000 troy oz (by coin specification)');
  assert.equal(contentText(purchaseFixture().content), '1.000 troy oz (you confirmed)');
  assert.equal(contentText({ known: false, hold: 'unit-unconfirmed', missing: ['unit-unconfirmed'] }), 'Content unknown: the title says oz, not troy oz');
});

test('confirming what a product contains: per ordered unit, scoped, previewed, undoable', () => {
  const single = productFixture();
  assert.equal(proposalQuestion(single, 'XAU'), '1.000 troy oz of fine gold per unit?');
  assert.equal(scopeText(single), 'Applies to 2 purchases (2 units) of this product, and to later ones with the same details.');
  const pack = productFixture({ pack: 'multiple', scope: { kind: 'lot', lotKey: 'costco-line-bbbb', evidenceDigest: 'd'.repeat(8), why: 'pack-multiple' },
    lots: 1, units: 1, proposal: { metal: 'XAU', troyOzPerUnit: oz('10', '10.000') } });
  assert.equal(proposalQuestion(pack, 'XAU'), '10.000 troy oz of fine gold per unit (the whole pack)?');
  assert.equal(scopeText(pack), 'A pack is confirmed on its own: this applies to this purchase only (1 unit).');
  assert.equal(scopeText({ ...pack, scope: { ...pack.scope, why: 'pack-unknown' } as typeof pack.scope }),
    'A purchase whose pack is unclear is confirmed on its own: this applies to this purchase only (1 unit).');
  assert.equal(scopeText({ ...pack, scope: { ...pack.scope, why: 'ref-missing' } as typeof pack.scope }),
    'A purchase with no usable product reference is confirmed on its own: this applies to this purchase only (1 unit).');
  const preview = { digest: 'x', lots: 2, units: 2, holdingsTroyOz: { before: complete(oz('0', '0.000')), after: complete(oz('2', '2.000')) }, saleLines: 1 };
  assert.equal(previewText(preview), 'Confirming would: 2 purchases (2 units) counted with this content · recorded holdings 0.000 troy oz → 2.000 troy oz · 1 sale line\'s profit or loss becomes known.');
  // Either side can be unknown (a zero with a reason is unknown, G3): said so, never as 0.
  assert.equal(previewText({ ...preview, saleLines: 0, holdingsTroyOz: { before: unknown<MetalsTroyOz>(['content-unknown', 2]),
    after: partial(oz('2', '2.000'), ['not-covered', 1]) } }),
  'Confirming would: 2 purchases (2 units) counted with this content · recorded holdings — (unknown) → 2.000 troy oz (partial).');
  assert.equal(previewText({ ...preview, holdingsTroyOz: { before: preview.holdingsTroyOz.after, after: preview.holdingsTroyOz.before } }, true),
    'Undoing would: 2 purchases (2 units) held again until confirmed · recorded holdings 2.000 troy oz → 0.000 troy oz · 1 sale line\'s profit or loss unknown again.');
  // The preview counts a product's sales too: its noun is the row's own.
  assert.deepEqual(linesNoun({ lots: 3, saleLines: 0 }), ['purchase', 'purchases']);
  assert.deepEqual(linesNoun({ lots: 0, saleLines: 1 }), ['sale', 'sales']);
  assert.deepEqual(linesNoun({ lots: 2, saleLines: 1 }), ['purchase or sale', 'purchases and sales']);
  assert.match(previewText({ ...preview, lots: 1, units: 1 }, false, linesNoun({ lots: 0, saleLines: 1 })), /^Confirming would: 1 sale \(1 unit\) counted/);
  // "Confirm all": what each product covers, never holdings before and after.
  assert.equal(batchPreviewText(preview), 'Would count 2 purchases (2 units) with this content.');
  assert.equal(batchPreviewText({ lots: 3, units: 4 }, linesNoun({ lots: 2, saleLines: 1 })), 'Would count 3 purchases and sales (4 units) with this content.');
  // A refused write (not found, or a conflict other than a stale preview): nothing saved, and it still needs the owner's answer.
  assert.equal(REFUSED_WRITE_TEXT, 'Nothing was saved: this product needs your answer: what it contains.');
  assert.equal(refusedBatchText(0), 'Nothing was saved: the products listed need your answer: what each contains.');
  assert.equal(refusedBatchText(2), '2 products were confirmed. Nothing more was saved: the products listed need your answer: what each contains.');
  assert.equal(refusedBatchText(1), '1 product was confirmed. Nothing more was saved: the products listed need your answer: what each contains.');
  // A line the title guard flagged waits for the owner's answer before anything else.
  assert.equal(CONTENT_HOLD_WORDS['bullion-unconfirmed'], 'needs your answer: is this bullion?');
});

test('what the owner types for a unit\'s fine content: a positive decimal, nothing else', () => {
  assert.equal(parseTroyOzInput('1'), '1');
  assert.equal(parseTroyOzInput(' 0.1 '), '0.1');
  assert.equal(parseTroyOzInput('007.5'), '7.5');
  for (const bad of ['', '0', '0.000', '-1', '1/10', '1e3', 'one', '1.12345678', '12345']) assert.equal(parseTroyOzInput(bad), null, bad);
});

test('the receipt block names each metal, from the receipt-confirmed charges the funding view lists', () => {
  const gold = fundingPurchaseFixture();
  const silver = fundingPurchaseFixture({ orderKey: 'walmart-order-bbbb', metals: ['XAG'],
    receiptCharges: [{ rowId: 'card-txn-bbbb', evidenceClass: 'walmart-order-total@1', metals: ['XAG'] }] });
  const several = fundingPurchaseFixture({ orderKey: 'walmart-order-cccc',
    receiptCharges: [{ rowId: 'card-txn-cccc', evidenceClass: 'walmart-order-total@1', metals: ['XAU', 'metal-unknown'] }] });
  const none = fundingPurchaseFixture({ orderKey: 'costco-order-dddd', receiptCharges: [] });
  const counts = receiptCounts([gold, silver, several, none]);
  assert.deepEqual(counts, [{ metal: 'XAU', charges: 2 }, { metal: 'XAG', charges: 1 }, { metal: 'metal-unknown', charges: 1 }]);
  assert.equal(receiptText(counts), 'Receipts show gold (2) · silver (1) · metal unclear (1)');
});

test('an order\'s refunds are shown as the store shows them, never linked', () => {
  assert.equal(refundsText([]), null);
  assert.equal(refundsText([{ amountMinor: -12_500, date: '2026-04-02' }]),
    '$125.00 refunded on Apr 2, 2026 (the order\'s refunds as the store shows them; not linked to a card charge)');
});

test('chart months: a sentence each, a gap is not recorded, never a zero', () => {
  const months = timelineFixture().months;
  assert.equal(monthSentence(months[0], 'ounces'), 'January 2026: not recorded');
  assert.equal(monthSentence(months[1], 'ounces'), '0.000 troy oz held at the end of February 2026');
  assert.equal(monthSentence(months[3], 'ounces'), '2.000 troy oz held at the end of April 2026 (partial)');
  assert.equal(monthSentence(months[2], 'value'),
    'At the end of March 2026: cost $2,000.00, estimated value at spot $2,650.00 (close of Mar 31, 2026)');
});

test('where the figures come from: dates covered, complete or partial, captured or imported, held records', () => {
  const entry = overviewFixture().coverage[0];
  assert.deepEqual(coverageLines(entry), [
    'Online orders: Jan 1, 2025 – Nov 8, 2026 · complete', 'Warehouse receipts: Jan 1, 2025 – Nov 8, 2026 · complete', 'Imported on Nov 8, 2026',
    'No records held',
  ]);
  const partialEntry = { ...entry, capturedAt: '2026-11-07T10:00:00Z', held: 2,
    kinds: [{ ...entry.kinds[0], complete: false, stated: 14, seen: 12 }] };
  assert.deepEqual(coverageLines(partialEntry), [
    'Online orders: Jan 1, 2025 – Nov 8, 2026 · partial: 12 of 14 read', 'Captured on Nov 7, 2026, imported on Nov 8, 2026', '2 records held',
  ]);
  assert.equal(coverageTail(overviewFixture().coverage), 'Costco: covered through Nov 8, 2026');
});

test('beside the as-of line, calmly: through which day each source\'s complete captures reach', () => {
  const kind = (name: MetalsCoverageEntry['kinds'][number]['kind'], to: string, complete = true) => ({
    kind: name, from: '2025-01-01', to, complete, stated: complete ? 3 : 4, seen: 3, ranges: complete ? [{ from: '2025-01-01', to }] : [],
  });
  const account = (source: MetalsCoverageEntry['source'], kinds: MetalsCoverageEntry['kinds']): MetalsCoverageEntry => ({
    accountId: `mtl-acct-${source}`, source, label: source, capturedAt: null, importedAt: '2026-11-08T12:00:00.000Z', kinds, held: 0,
  });
  assert.equal(coverageTail([]), null);
  // Each source through the earliest last day of the kinds its holdings need; payouts count for none.
  assert.equal(coverageTail([
    account('collectpure', [kind('sell-orders', '2026-11-06'), kind('payouts', '2026-10-01', false)]),
    account('walmart', [kind('online', '2026-11-07')]),
    account('costco', [kind('online', '2026-11-05'), kind('warehouse', '2026-11-06')]),
  ]), 'Costco: covered through Nov 5, 2026 · Walmart: covered through Nov 7, 2026 · CollectPure: covered through Nov 6, 2026');
  // A kind no complete capture covers, or one the source never stated: said, never a date.
  assert.equal(coverageTail([account('costco', [kind('online', '2026-11-05')])]), 'Costco: no complete capture yet');
  assert.equal(coverageTail([account('collectpure', [kind('sell-orders', '2026-11-06', false)])]), 'CollectPure: no complete capture yet');
  // Two accounts of one source: the earlier one bounds it; ranges after a gap still end the account's coverage.
  const gapped = { ...kind('online', '2026-11-07'), ranges: [{ from: '2025-01-01', to: '2025-06-30' }, { from: '2025-08-01', to: '2026-11-07' }] };
  assert.equal(coverageTail([account('walmart', [gapped]), { ...account('walmart', [kind('online', '2026-11-04')]), accountId: 'mtl-acct-w2' }]),
    'Walmart: covered through Nov 4, 2026');
});

test('a figure that misses days says so plainly, without a count of records', () => {
  assert.equal(reasonText({ code: 'not-covered', records: 3 }, 'XAU'), 'not every day is covered by a source\'s capture');
});

test('in running text a partial or unknown figure carries its state word', () => {
  assert.equal(withState('$2,140.00', complete(1)), '$2,140.00');
  assert.equal(withState('$2,140.00', partial(1, ['cost-unattributed', 1])), '$2,140.00 (partial)');
  assert.equal(withState('—', unknown(['price-missing', 1])), '— (unknown)');
  assert.equal(purchaseSummary(purchaseFixture({ costMinor: partial(214_000, ['cost-unattributed', 1]) })), '$2,140.00 (partial) · Delivered');
  assert.equal(purchaseSummary(purchaseFixture({ costMinor: unknown(['conflict', 1]) })), 'Cost unknown · Delivered');
  const preview = { digest: 'x', lots: 1, units: 1, saleLines: 0,
    holdingsTroyOz: { before: partial(oz('1/1', '0.322'), ['not-covered', 1]), after: partial(oz('4/1', '4.322'), ['not-covered', 1]) } };
  assert.equal(previewText(preview), 'Confirming would: 1 purchase (1 unit) counted with this content · recorded holdings 0.322 troy oz (partial) → '
    + '4.322 troy oz (partial).');
});

test('the chart: exact ounces drawn, ticks with the decimals they need, unknown and partial captioned apart', () => {
  assert.equal(troyOzNumber(oz('1/2', '0.500')), 0.5);
  assert.equal(troyOzNumber(oz('2', '2.000')), 2);
  // 0.322 oz tops out at 0.5: its middle gridline is 0.25, never "0.3"; a 1 g bar's scale is 0.05, never "0.1".
  assert.deepEqual([0.5, 0.25, 0].map(ouncesTick), ['0.5 oz', '0.25 oz', '0 oz']);
  assert.deepEqual([0.05, 0.025, 0].map(ouncesTick), ['0.05 oz', '0.025 oz', '0 oz']);
  assert.deepEqual([20, 10, 0].map(ouncesTick), ['20 oz', '10 oz', '0 oz']);
  assert.equal(chartCaption('ounces', 'ounces', 'unknown', 'January 2026 – March 2026', ['3 purchases or sales have unknown content']),
    'Unknown (?): January 2026 – March 2026, because 3 purchases or sales have unknown content.');
  assert.equal(chartCaption('ounces', 'ounces', 'partial', 'April 2026', []), 'Partial (hatched): April 2026.');
  assert.equal(chartCaption('value', 'value', 'unknown', 'April 2026', ['no CNBC daily close for gold is recorded']),
    'Estimated value at spot unknown (?): April 2026, because no CNBC daily close for gold is recorded.');
  assert.equal(chartCaption('value', 'cost', 'partial', 'April 2026', ['1 purchase has part of its order\'s cost not assigned to it']),
    'Cost partial (hatched): April 2026, because 1 purchase has part of its order\'s cost not assigned to it.');
  // The cost and value sentence says each figure's state.
  const month = { ...timelineFixture().months[3], costMinor: partial(400_000, ['cost-unattributed', 1]), valueMinor: partial(530_000, ['not-covered', 1]) };
  assert.equal(monthSentence(month, 'value'),
    'At the end of April 2026: cost $4,000.00 (partial), estimated value at spot $5,300.00 (partial, close of Apr 30, 2026)');
  assert.equal(monthSentence({ ...month, valueMinor: unknown(['price-missing', 1]), closeDate: null }, 'value'),
    'At the end of April 2026: cost $4,000.00 (partial), estimated value at spot unknown');
  // While values at spot don't show, the month says why instead of any value it has.
  assert.equal(monthSentence(month, 'value', 'prices-off'), 'At the end of April 2026: cost $4,000.00 (partial), estimated value at spot: Prices off');
  assert.equal(monthSentence(month, 'value', 'no-price-yet'), 'At the end of April 2026: cost $4,000.00 (partial), estimated value at spot: No price yet');
  assert.equal(monthSentence(month, 'ounces', 'prices-off'), '2.000 troy oz held at the end of April 2026 (partial)');
});

test('prices off: one consistent price-missing state across every read', () => {
  const overview = priceMissingAnswer('/metals/overview') as ReturnType<typeof overviewFixture>;
  assert.equal(overview.price.closeDate, null);
  assert.equal(spotShown(overview.price), 'prices-off');
  assert.equal(spotShown((priceMissingAnswer('/metals/overview', true) as ReturnType<typeof overviewFixture>).price), 'no-price-yet');
  assert.ok([overview.holdings.valueMinor, overview.holdings.gainMinor, ...overview.holdings.classes.flatMap((item) => [item.valueMinor, item.gainMinor])]
    .every((measure) => measure.value === null && measure.state === 'unknown' && measure.reasons[0].code === 'price-missing'));
  assert.equal(overview.holdings.costMinor.state, 'complete');
  const timeline = priceMissingAnswer('/metals/timeline') as ReturnType<typeof timelineFixture>;
  assert.ok(timeline.months.filter((item) => item.recorded).every((item) => item.valueMinor.value === null && item.costMinor.value !== null));
  assert.deepEqual(priceMissingAnswer('/metals/unknown-route'), { installed: false });
});

test('the switch offers gold and silver, and another metal only once the ledger holds it', () => {
  assert.deepEqual(switchMetals(null), ['XAU', 'XAG']);
  assert.deepEqual(switchMetals(overviewFixture()), ['XAU', 'XAG']);
  assert.deepEqual(switchMetals({ metals: [{ metal: 'XPT', lots: 1, sales: 0 }] }), ['XAU', 'XAG', 'XPT']);
});

test('the price guard\'s level shift is said beside the price line, with its dates (D-G3-1)', () => {
  assert.equal(levelShiftText(null), null);
  assert.equal(levelShiftText({ movedOn: '2026-08-14', admittedOn: '2026-08-21', days: 7 }),
    'Price moved more than 20% on Aug 14, 2026; admitted after 7 days, on Aug 21, 2026.');
  // A refusal still running: the close used is the last before the move, and stale says how old it is.
  assert.equal(levelShiftText({ movedOn: '2026-10-28', admittedOn: null, days: 11 }),
    'Price moved more than 20% on Oct 28, 2026; not admitted yet, 11 days on: values use the last close before the move.');
});

test('sales and purchases whose metal is unknown are said beside a metal\'s figures, never inside them', () => {
  assert.equal(metalUnknownLine(overviewFixture().metalUnknown), null);
  assert.equal(metalUnknownLine({ lots: 0, units: 0, costMinor: 0, sales: 1, saleNetMinor: 30_000 }),
    'Sales with unknown metal: 1 (net $300.00). Their metal is unresolved, so they are not included in any metal\'s figures.');
  assert.equal(metalUnknownLine({ lots: 1, units: 2, costMinor: 50_000, sales: 1, saleNetMinor: 30_000 }),
    'Sales with unknown metal: 1 (net $300.00) · Purchases with unknown metal: 1 (2 units kept or on the way, cost $500.00). Their metal '
      + 'is unresolved, so they are not included in any metal\'s figures.');
});

test('units of unresolved metal, kept or on the way, are said beside a metal\'s holdings, so a holding of none is never proof (G1d)', () => {
  assert.equal(unresolvedMetalHeldLine(overviewFixture().metalUnknown), null);
  // Recorded, but neither kept nor on the way (cancelled or returned since), or only sales: nothing beside the holdings.
  assert.equal(unresolvedMetalHeldLine({ lots: 2, units: 0, costMinor: 0, sales: 1, saleNetMinor: 30_000 }), null);
  assert.equal(unresolvedMetalHeldLine({ lots: 1, units: 1, costMinor: 50_000, sales: 0, saleNetMinor: 0 }),
    'Not counted: 1 unit bought whose metal is unresolved.');
  assert.equal(unresolvedMetalHeldLine({ lots: 3, units: 3, costMinor: 750_000, sales: 0, saleNetMinor: 0 }),
    'Not counted: 3 units bought whose metal is unresolved.');
  // Under the chart of what was held: scoped to it, never implying the units were held in every month shown.
  assert.equal(unresolvedMetalHeldLine({ lots: 3, units: 3, costMinor: 750_000, sales: 0, saleNetMinor: 0 }, true),
    'Not counted in this chart: 3 units bought whose metal is unresolved.');
  assert.equal(unresolvedMetalHeldLine({ lots: 2, units: 0, costMinor: 0, sales: 1, saleNetMinor: 30_000 }, true), null);
});

test('the period\'s sold money and payouts carry their state; payouts of sales that mix metals stand apart', () => {
  const sold = overviewFixture().activity.sold;
  assert.equal(soldDetail(sold), '$2,450.00 net · by day agreed, after $50.00 fees');
  assert.equal(soldDetail({ ...sold, netMinor: partial(245_000, ['conflict', 1]), feesMinor: partial(5_000, ['conflict', 1]) }),
    '$2,450.00 (partial) net · by day agreed, after $50.00 (partial) fees');
  assert.deepEqual(payoutLines(overviewFixture().activity.payouts), ['Paid out over the period: $2,450.00 in 1 payout, by payout date.']);
  assert.deepEqual(payoutLines({ count: 2, amountMinor: partial(300_000, ['source-held', 1]),
    mixedMetal: { count: 1, amountMinor: partial(28_600, ['not-covered', 1]) } }), [
    'Paid out over the period: $3,000.00 (partial) in 2 payouts, by payout date.',
    'Payouts of sales of more than one metal, or with a line of unknown metal: $286.00 (partial) in 1 payout, counted in no one metal\'s totals.',
  ]);
  assert.deepEqual(payoutLines({ count: 0, amountMinor: complete(0), mixedMetal: { count: 0, amountMinor: complete(0) } }), []);
});

test('a cancelled or returned purchase keeps its cost state in the list set apart', () => {
  const cancelled = { ordered: 1, cancelled: 1, returned: 0, delivered: 0, awaiting: 0 };
  assert.equal(setAsideMeta(purchaseFixture({ delivery: { state: 'cancelled', date: null }, units: cancelled })), 'Cancelled · 1 · cost $2,000.00');
  assert.equal(setAsideMeta(purchaseFixture({ delivery: { state: 'cancelled', date: null }, units: cancelled, costMinor: partial(199_000, ['cost-unattributed', 1]) })),
    'Cancelled · 1 · cost $1,990.00 (partial)');
  assert.equal(setAsideMeta(purchaseFixture({ delivery: { state: 'returned', date: '2026-04-02' }, units: { ...cancelled, ordered: 2, cancelled: 0, returned: 2 },
    costMinor: unknown(['conflict', 1]) })), 'Returned · 2 · cost — (unknown)');
});

test('the page shows, in order: the set-up step, a failed read, the first read, nothing imported yet, then the ledger', () => {
  const ok = { notInstalled: false, missing: false, error: null };
  const ledger = overviewFixture();
  assert.deepEqual(goldPageView(ok, overviewFixture({ coverage: [] })), { kind: 'nothing-imported' });
  assert.deepEqual(goldPageView(ok, ledger), { kind: 'ledger', overview: ledger });
  assert.deepEqual(goldPageView({ ...ok, notInstalled: true }, null), { kind: 'not-installed' });
  assert.deepEqual(goldPageView({ ...ok, missing: true }, null), { kind: 'not-installed' });
  assert.deepEqual(goldPageView({ ...ok, error: 'offline' }, null), { kind: 'error' });
  assert.deepEqual(goldPageView({ ...ok, error: 'offline' }, ledger), { kind: 'ledger', overview: ledger });
  assert.deepEqual(goldPageView(ok, null), { kind: 'loading' });
});

test('the chart: a figure no one knows has no amount, so it is marked, never drawn as a zero bar', () => {
  const months = timelineFixture().months;
  const contentHeld = { ...months[2], troyOz: unknown<MetalsTroyOz>(['content-unknown', 1]) };
  assert.deepEqual(chartSeriesOf(contentHeld, 'ounces'), { amount: null, state: 'unknown', reasons: [{ code: 'content-unknown', records: 1 }] });
  const pricesOff = { ...months[3], valueMinor: unknown<number>(['price-missing', 1]), closeDate: null };
  assert.deepEqual(chartSeriesOf(pricesOff, 'value'), { amount: null, state: 'unknown', reasons: [{ code: 'price-missing', records: 1 }] });
  assert.deepEqual(chartSeriesOf(months[3], 'ounces'), { amount: 2, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] });
});

test('the chart draws a month no source covers as a gap, and a figure no one knows as a marked ?, never a zero-height bar', () => {
  const months = timelineFixture().months;
  assert.deepEqual(chartMarks(months[0], 'ounces', 2), [{ kind: 'gap' }]);
  const pricesOff = { ...months[3], valueMinor: unknown<number>(['price-missing', 1]), closeDate: null };
  assert.deepEqual(chartMarks(pricesOff, 'value', 800_000), [{ kind: 'bar', series: 'cost', state: 'complete', height: 50 }, { kind: 'unknown', series: 'value' }]);
  assert.deepEqual(chartMarks(months[3], 'ounces', 2), [{ kind: 'bar', series: 'ounces', state: 'partial', height: 100 }]);
  // A recorded zero is known: drawn as a bar of no height, unlike a figure no one knows.
  assert.deepEqual(chartMarks(months[1], 'ounces', 2), [{ kind: 'bar', series: 'ounces', state: 'complete', height: 0 }]);
  // While values at spot don't show, cost and value draws cost alone: no value bar, and no "?" for it either.
  assert.deepEqual(chartMarks(months[3], 'value', 800_000, 'prices-off'), [{ kind: 'bar', series: 'cost', state: 'complete', height: 50 }]);
  assert.deepEqual(chartMarks(pricesOff, 'value', 800_000, 'no-price-yet'), [{ kind: 'bar', series: 'cost', state: 'complete', height: 50 }]);
  assert.deepEqual(chartSeriesFor('value', 'shown'), ['cost', 'value']);
  assert.deepEqual(chartSeriesFor('value', 'prices-off'), ['cost']);
  assert.deepEqual(chartSeriesFor('ounces', 'no-price-yet'), ['ounces']);
});

test('the chart: cost and value each keep their own state, neither marks the other', () => {
  const month = timelineFixture().months[3];
  const pricesOff = { ...month, valueMinor: unknown<number>(['price-missing', 1]), closeDate: null };
  assert.deepEqual(chartSeriesOf(pricesOff, 'cost'), { amount: 400_000, state: 'complete', reasons: [] });
  const partialCost = { ...month, costMinor: partial(400_000, ['cost-unattributed', 1]) };
  assert.deepEqual(chartSeriesOf(partialCost, 'value'), { amount: 530_000, state: 'complete', reasons: [] });
});

test('a holding class row says its troy oz with their state', () => {
  const item = overviewFixture().holdings.classes[0];
  assert.equal(lineText(classMetaParts(item)), '2 held · 2.000 troy oz');
  assert.equal(lineText(classMetaParts({ ...item, troyOz: partial(oz('2/1', '2.000'), ['conflict', 1]), units: { ...item.units, awaiting: 1 } })),
    '2 held · 2.000 troy oz (partial) · 1 awaiting delivery');
});

test('a source row says its value at spot with its state while values show, and why not otherwise, never a value', () => {
  const [source] = overviewFixture().holdings.bySource;
  assert.equal(lineText(sourceMetaParts(source)), 'Costco · 2 units · 2.000 troy oz · cost $4,000.00 · value at spot $5,300.80');
  const [missing] = (priceMissingAnswer('/metals/overview', true) as ReturnType<typeof overviewFixture>).holdings.bySource;
  assert.equal(lineText(sourceMetaParts(missing)), 'Costco · 2 units · 2.000 troy oz · cost $4,000.00 · value at spot — (unknown)');
  assert.equal(lineText(sourceMetaParts(source, 'prices-off')), 'Costco · 2 units · 2.000 troy oz · cost $4,000.00 · value at spot: Prices off');
  assert.equal(lineText(sourceMetaParts(missing, 'no-price-yet')), 'Costco · 2 units · 2.000 troy oz · cost $4,000.00 · value at spot: No price yet');
});

test('a sale says when a purchase with records that disagree could change its assigned purchases', () => {
  const sale = { dateUnknown: false, purchaseConflict: false, quarantined: false };
  assert.deepEqual(saleNotes(sale), []);
  assert.deepEqual(saleNotes({ ...sale, purchaseConflict: true }), [{ key: 'purchase-conflict', text: SALE_PURCHASE_CONFLICT_TEXT, warning: false }]);
  assert.deepEqual(saleNotes({ dateUnknown: true, purchaseConflict: true, quarantined: true }).map((note) => note.key),
    ['date-unknown', 'purchase-conflict', 'quarantined']);
  assert.match(SALE_PURCHASE_CONFLICT_TEXT, /records that disagree/);
});

test('holdings and profit say records disagree while an order waits for review', () => {
  const overview = overviewFixture();
  overview.holdings.troyOz = partial(oz('2/1', '2.000'), ['conflict', 1]);
  overview.holdings.costMinor = partial(400_000, ['conflict', 1]);
  overview.activity.profit = { ...overview.activity.profit, valueMinor: partial(45_000, ['conflict', 1]) };
  assert.equal(headlineWarning(overview), 'Partial: 1 order has records that disagree, waiting for review, not counted');
  assert.equal(activityWarnings(overview).profit, 'Partial: 1 order has records that disagree, waiting for review, not counted');
  assert.equal(headlineWarning(overviewFixture()), null);
});

test('the ounces scale tops out at the next round step: a 1 g bar at 0.05 oz, never 0.1', () => {
  assert.equal(ouncesTop(0.0321507466), 0.05);
  assert.equal(ouncesTop(0.322), 0.5);
  assert.equal(ouncesTop(2), 2);
  assert.equal(ouncesTop(3), 5);
  assert.equal(ouncesTop(0), 0);
});

test('confirm all as proposed takes single products only; packs and unclear packs are confirmed per purchase', () => {
  const single = productFixture();
  const pack = productFixture({ pack: 'multiple', scope: { kind: 'lot', lotKey: 'costco-line-bbbb', evidenceDigest: 'd'.repeat(8), why: 'pack-multiple' },
    lots: 1, units: 1, proposal: { metal: 'XAU', troyOzPerUnit: oz('10/1', '10.000') } });
  const unclear = productFixture({ pack: 'unknown', scope: { kind: 'lot', lotKey: 'costco-line-cccc', evidenceDigest: 'e'.repeat(8), why: 'pack-unknown' },
    lots: 1, units: 1 });
  const refMissing = productFixture({ scope: { kind: 'lot', lotKey: 'walmart-line-dddd', evidenceDigest: 'f'.repeat(8), why: 'ref-missing' }, lots: 1, units: 1 });
  const drifted = productFixture({ scope: { kind: 'product', ref: 'costco:1000002', fingerprint: 'fp-bbbb' }, hold: 'confirmation-drift', drift: true });
  const noProposal = productFixture({ scope: { kind: 'product', ref: 'costco:1000003', fingerprint: 'fp-cccc' }, hold: 'weight-unstated', proposal: null });
  assert.deepEqual(confirmableAll([single, pack, unclear, refMissing, drifted, noProposal]), [single]);
});

// ---------------------------------------------------------------------------
// The redesign (Astra's accepted mock, round 4)
// ---------------------------------------------------------------------------

test('the summary says one completeness line over all its figures, what waits for the owner said as such', () => {
  assert.equal(summaryWarning(overviewFixture()), null);
  const overview = overviewFixture({
    holdings: { ...overviewFixture().holdings, troyOz: partial(oz('2/1', '2.000'), ['content-unknown', 2]), costMinor: partial(400_000, ['source-held', 1]) },
    toCheck: { records: 2, needsYou: [{ code: 'confirm-content', products: 2 }], forInformation: [] },
  });
  assert.equal(summaryWarning(overview), 'Totals are partial: 2 products need your answer: what each contains · 1 record is held and not counted');
  // Value and gain reasons count only while values show: prices off is said by the figures themselves.
  const off = overviewFixture({
    price: { ...overviewFixture().price, fetching: false },
    holdings: { ...overviewFixture().holdings, valueMinor: unknown(['price-missing', 1]), gainMinor: unknown(['price-missing', 1]) },
  });
  assert.equal(summaryWarning(off), null);
  const shownMissing = overviewFixture({
    holdings: { ...overviewFixture().holdings, valueMinor: unknown(['price-stale', 1]), gainMinor: unknown(['price-stale', 1]) },
  });
  assert.equal(summaryWarning(shownMissing), 'Totals are partial: the latest gold close is more than 5 weekdays old');
});

test('orders held for a bullion answer are said for information, never "needs your answer" while the page can\'t take it', () => {
  assert.equal(heldForAnswerLine(overviewFixture()), null);
  const one = { needsAnswer: { orders: 1, flaggedLines: 1, bySource: [], byMerchantClass: [], items: [] } };
  assert.equal(heldForAnswerLine(one), '1 order waits for a bullion answer: held, not counted until then');
  assert.equal(heldForAnswerLine({ needsAnswer: { ...one.needsAnswer, orders: 3 } }), '3 orders wait for a bullion answer: held, not counted until then');
  assert.doesNotMatch(heldForAnswerLine(one) ?? '', /needs your answer/);
});

test('troy ounces as a secondary line carry their state, and unknown is said, never zero', () => {
  assert.equal(troyOzLine(complete(oz('4/1', '4.000'))), '4.000 troy oz');
  assert.equal(troyOzLine(partial(oz('4/1', '4.000'), ['content-unknown', 1])), '4.000 troy oz (partial)');
  assert.equal(troyOzLine(unknown(['content-unknown', 1])), 'troy oz unknown');
});

test('products to confirm group by exact product and content; packs stay one by one; different variants never share a group', () => {
  const single = productFixture({ lots: 3, units: 3 });
  const pack = (key: string, patch: Partial<ReturnType<typeof productFixture>> = {}) => productFixture({
    scope: { kind: 'lot', lotKey: key, evidenceDigest: `ev-${key}`, why: 'pack-multiple' }, pack: 'multiple', lots: 1, units: 1, saleLines: 0,
    titles: ['Sample 10 x 1 oz Silver Rounds'], proposal: null, ...patch,
  });
  const confirmedRow = productFixture({ scope: { kind: 'product', ref: 'costco:2', fingerprint: 'fp-b' }, hold: null, decision: null });
  const groups = productGroups([single, pack('l1'), pack('l2'), pack('l3', { titles: ['Sample 20 x 1 oz Silver Rounds'] }), confirmedRow]);
  // The confirmed row (no hold, no drift) waits for nothing; the two identical packs share a group; the third pack differs.
  assert.equal(groups.length, 3);
  const shared = groups.find((group) => group.rows.length === 2);
  assert.ok(shared);
  assert.deepEqual(shared.rows.map((row) => row.scope.kind === 'lot' ? row.scope.lotKey : ''), ['l1', 'l2']);
  assert.equal(groups.filter((group) => group.rows.length === 1).length, 2);
  // Most records first: the single product covers 3 purchase lines.
  assert.equal(groups[0].rows[0], single);
  assert.equal(affectsText({ lots: 2, saleLines: 0 }), 'affects 2 purchases');
  assert.equal(affectsText({ lots: 1, saleLines: 3 }), 'affects 1 purchase and 3 sales');
  assert.equal(affectsText({ lots: 0, saleLines: 0 }), 'affects no recorded line yet');
  assert.equal(confirmCardText(groups), '3 products wait, affecting 6 records: confirm contents to calculate more of your totals.');
});

test('the price line: closes joined up to the join days, a longer gap broken and listed, nothing outside its dates', () => {
  assert.equal(PRICE_JOIN_DAYS, 4);
  const closes = [
    { date: '2026-05-01', close: '2400.5' },
    { date: '2026-05-04', close: '2410' },
    { date: '2026-05-12', close: '2450.25' },
    { date: '2026-04-20', close: '2300' },
    { date: '2026-05-13', close: 'n/a' },
  ];
  const points = closesInRange(closes, '2026-05-01', '2026-05-31');
  assert.deepEqual(points, [{ date: '2026-05-01', minor: 240_050 }, { date: '2026-05-04', minor: 241_000 }, { date: '2026-05-12', minor: 245_025 }]);
  const line = priceLine(points, '2026-05-01', '2026-05-31');
  // A weekend (3 days) joins; 8 days is broken and shaded; the end of the dates is more than 4 days past the last close.
  assert.deepEqual(line.points.map((point) => point.value), [240_050, 241_000, null, 245_025]);
  assert.deepEqual(line.gaps, [{ from: '2026-05-04', to: '2026-05-12' }, { from: '2026-05-12', to: '2026-05-31' }]);
  assert.deepEqual(priceLine([], '2026-05-01', '2026-05-31'), { points: [], gaps: [{ from: '2026-05-01', to: '2026-05-31' }] });
  assert.deepEqual(priceLine(points, '2026-04-20', '2026-05-12').gaps[0], { from: '2026-04-20', to: '2026-05-01' });
});

test('the price chart\'s own dates start with the period, or for all history with its earliest close or trade', () => {
  assert.equal(priceChartStart('2026-05-09', ['2025-01-02'], '2026-11-08'), '2026-05-09');
  assert.equal(priceChartStart(null, ['2025-03-01', '2025-01-02', '2025-06-30'], '2026-11-08'), '2025-01-02');
  assert.equal(priceChartStart(null, [], '2026-11-08'), '2026-11-08');
});

test('a trade\'s price per troy oz is its money over its fine ounces; unknown when either is', () => {
  assert.equal(pricePerTroyOz(400_000, oz('1/1', '1.000'), 2), 200_000);
  assert.equal(pricePerTroyOz(100_000, oz('1/10', '0.100'), 4), 250_000);
  assert.equal(pricePerTroyOz(null, oz('1/1', '1.000'), 1), null);
  assert.equal(pricePerTroyOz(100_000, null, 1), null);
  assert.equal(pricePerTroyOz(100_000, oz('1/1', '1.000'), 0), null);
});
