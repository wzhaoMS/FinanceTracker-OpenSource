import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { retailMetalPack } from '../../retailImportTool/metalPackRule.js';
import { sanitizeCardText } from '../../cardImport.js';
import {
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_CLAUSES,
  RETAIL_METAL_GUARD_EVIDENCE,
  retailMetalTitleEvidence,
  retailMetalTitleGuard,
  type RetailMetalGuardEvidence,
} from '../../retailImportTool/metalTitleRule.js';
import {
  intlNewYorkDate,
  syntheticCollectPureCapture,
  syntheticPayoutId,
  syntheticSellOrderId,
  type SyntheticCollectPureCapture,
  type SyntheticCollectPureSpec,
} from '../captures/__fixtures__/collectpureCapture.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire, type MetalsContentEvidence } from '../contentRule.js';
import { METALS_RULES } from '../model.js';
import { metalsTitleObservations } from '../observations.js';
import {
  METALS_PRODUCT_REF_MAX,
  METALS_TITLE_MAX,
  metalsDigest,
  metalsNaturalKey,
  serializeMetalsImportPayload,
  validateMetalsImportPayload,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsLine,
  type MetalsOrder,
} from '../payload.js';
import {
  COLLECTPURE_BARE_OZ_BAR_TITLE,
  COLLECTPURE_EAGLE_TITLE,
  COLLECTPURE_FINE_BAR_TITLE,
  COLLECTPURE_MAPLE_TITLE,
  COLLECTPURE_OPTION_TITLE,
  COLLECTPURE_SILVER_EAGLE_TITLE,
  syntheticCollectPureFiles,
  syntheticCollectPureFolder,
  syntheticCollectPureSales,
  syntheticCollectPureSalesPayloadValues,
  syntheticCollectPureSalesSecrets,
  syntheticCollectPureSalesSpec,
} from './__fixtures__/collectpureConvert.js';
import {
  COLLECTPURE_CAPTURE_LAYOUT,
  COLLECTPURE_COVERAGE_BASES,
  COLLECTPURE_HOLD_CHECKS,
  COLLECTPURE_METALS_CONVERTER,
  collectPureGuardCensus,
  convertCollectPureCapture,
  type CollectPureConvertReport,
} from './collectpure.js';
import { METALS_CONVERTER, MetalsConvertError, type MetalsCaptureFile, type MetalsConvertOutput } from './common.js';

type Json = Record<string, unknown>;

/** The object at a path of keys and indices in a parsed file, to change for a test. */
function at(value: unknown, ...path: Array<string | number>): Json {
  let current = value;
  for (const key of path) current = (current as Json)[key];
  return current as Json;
}

const id = (seed: number) => syntheticSellOrderId(seed);
const sellKey = (seed: number) => metalsNaturalKey('collectpure', 'sell', [id(seed)]);
/** A sale's record in the consolidated file. */
const listed = (capture: SyntheticCollectPureCapture, seed: number) =>
  (capture.consolidated.sellOrders as Json[]).find((order) => order.id === id(seed))!;
/** A sale's raw `sell-order-<id>.json`. */
const raw = (capture: SyntheticCollectPureCapture, seed: number) => capture.rawSellOrders.find((file) => file.id === id(seed))!.json;
/** A sale's row in the raw payout-history pages. */
const historyItem = (capture: SyntheticCollectPureCapture, seed: number) =>
  capture.payoutHistoryPages.flatMap((page) => at(page.json, 'result', 'data', 'json').items as Json[]).find((item) => item.orderId === id(seed))!;
/** A sale's row in the consolidated payouts list. */
const payoutRow = (capture: SyntheticCollectPureCapture, seed: number) =>
  (capture.consolidated.payouts as Json[]).find((row) => row.sellOrderId === id(seed))!;

type Output = MetalsConvertOutput<CollectPureConvertReport>;
const convert = (capture: SyntheticCollectPureCapture, snapshot: string | null = null): Output =>
  convertCollectPureCapture(syntheticCollectPureFolder(capture, snapshot));
const convertFiles = (files: MetalsCaptureFile[], snapshot: string | null = null): Output =>
  convertCollectPureCapture({ folder: 'collectpure', snapshot, files, converterVersion: METALS_CONVERTER });
const fromSpec = (change: (spec: SyntheticCollectPureSpec) => void): SyntheticCollectPureCapture => {
  const spec = syntheticCollectPureSalesSpec();
  change(spec);
  return syntheticCollectPureCapture(spec);
};

/** The payload passes the validator as the exact text written, and that text is canonical. */
function assertWritten(output: Output): void {
  const parsed = JSON.parse(output.json) as unknown;
  const checked = validateMetalsImportPayload(parsed);
  assert.ok(checked.ok, `the payload is refused: ${JSON.stringify(!checked.ok && checked.issues)}`);
  assert.equal(serializeMetalsImportPayload(checked.payload), output.json);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(output.payload)));
}

/**
 * An action helper (kill standard, Addendum 3(e) and §8): runs a conversion, and gives null when it converts, or the
 * converter's own refusal (`MetalsConvertError`) as its code and place, for the test's own assertion. Any other error is
 * rethrown unchanged, never turned into data.
 */
function refusalOf(run: () => unknown): { code: string; at: string | null } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof MetalsConvertError) return { code: error.code, at: error.at ?? null };
    throw error;
  }
}

const saleOf = (payload: MetalsImportPayload, seed: number): MetalsOrder => {
  const sale = payload.orders.find((order) => order.key === sellKey(seed));
  assert.ok(sale, `sale ${seed} is converted`);
  return sale;
};
const heldOf = (payload: MetalsImportPayload, seed: number): MetalsHeldRecord[] => payload.held.filter((record) => record.key === sellKey(seed));

/** A line's content facts as the rules give them for its raw name: the expectations are never hard-coded. */
function expectedContent(title: string): Pick<MetalsLine, 'metal' | 'metalUncertain' | 'form' | 'statedMass' | 'pack' | 'purity' | 'massBasis' | 'design' | 'contentFingerprint' | 'fine'> {
  const evidence = retailMetalTitleEvidence(title)!;
  const observed = metalsTitleObservations(title);
  const content: MetalsContentEvidence = {
    source: 'collectpure', metal: evidence.metal, form: evidence.form, statedMass: evidence.statedWeight, pack: retailMetalPack(title),
    purity: observed.purity, massBasis: observed.massBasis, design: observed.design, metalUncertain: null,
  };
  return {
    metal: content.metal, metalUncertain: content.metalUncertain, form: content.form, statedMass: content.statedMass, pack: content.pack, purity: content.purity,
    massBasis: content.massBasis, design: content.design, contentFingerprint: metalsContentFingerprint(content),
    fine: metalsFineContentWire(metalsFineContent(content)),
  };
}

const events = (quantity: number, steps: Array<[string, string | null]>) =>
  steps.map(([kind, date]) => ({ kind, date, dateBasis: date === null ? null : 'stated', quantity, occurrence: 1 }));

/**
 * A flagged line's content facts, as the rules give them for its raw name: the title rule refused it, so it has no
 * metal, form or stated mass of its own, and metal guard v1's flag (its evidence and metal) holds it.
 */
function expectedFlaggedContent(title: string): Pick<MetalsLine, 'metal' | 'metalUncertain' | 'form' | 'statedMass' | 'pack' | 'purity' | 'massBasis' | 'design' | 'contentFingerprint' | 'fine'> {
  const reading = retailMetalTitleGuard(title, { assessed: true });
  const observed = metalsTitleObservations(title);
  const content: MetalsContentEvidence = {
    source: 'collectpure', metal: null, form: null, statedMass: null, pack: retailMetalPack(title), purity: observed.purity,
    massBasis: observed.massBasis, design: observed.design, metalUncertain: { guard: RETAIL_METAL_GUARD, evidence: reading.evidence, metal: reading.metal },
  };
  return {
    metal: null, metalUncertain: content.metalUncertain, form: null, statedMass: null, pack: content.pack, purity: content.purity,
    massBasis: content.massBasis, design: content.design, contentFingerprint: metalsContentFingerprint(content),
    fine: metalsFineContentWire(metalsFineContent(content)),
  };
}

describe('CollectPure converter: a capture with nothing to hold', () => {
  it('writes every sale as a valid, canonical payload of this capture, with no hold', () => {
    const capture = syntheticCollectPureSales();
    const files = syntheticCollectPureFiles(capture);
    const output = convertFiles(files);
    assertWritten(output);
    const { payload } = output;
    assert.equal(payload.format, 'holdr.metals-import');
    assert.equal(payload.version, 1);
    assert.equal(payload.source, 'collectpure');
    assert.deepEqual(payload.account, { folder: 'collectpure', identityLast4: null });
    assert.equal(payload.converterVersion, METALS_CONVERTER);
    assert.equal(payload.policyVersion, 1);
    assert.deepEqual(payload.rules, METALS_RULES);
    assert.deepEqual(payload.input, {
      schema: 'holdr-retail-capture/collectpure@1', captureDigest: metalsDigest(files[0].bytes), capturedAt: '2026-01-02T03:04:05.000Z',
      files: files.length,
    });
    assert.deepEqual(payload.orders.map((order) => order.key), [11, 12, 13, 14].map(sellKey).sort());
    assert.deepEqual(payload.held, []);
    assert.deepEqual(payload.competitors, []);
  });

  it('dates a sale by its trade moment, placedAt, and its agreed day, placedAt\'s New York date', () => {
    const { payload } = convert(syntheticCollectPureSales());
    // A New York evening placement: the UTC calendar date (the page's orderDate) is the next day, and is never used.
    assert.equal(saleOf(payload, 11).tradeMoment, '2025-10-02T01:30:00.000Z');
    assert.equal(saleOf(payload, 11).date, '2025-10-01');
    // Just after daylight time began, and just after it ended.
    assert.equal(saleOf(payload, 12).date, '2025-03-10');
    assert.equal(saleOf(payload, 13).tradeMoment, '2025-11-03T04:30:00.000Z');
    assert.equal(saleOf(payload, 13).date, '2025-11-02');
    for (const seed of [11, 12, 13, 14]) {
      const sale = saleOf(payload, seed);
      assert.equal(sale.date, intlNewYorkDate(sale.tradeMoment!), `sale ${seed}`);
    }
  });

  it('dates every event, and the completed date, by its step\'s New York date, never its UTC date', () => {
    const capture = syntheticCollectPureSales();
    const { payload } = convert(capture);
    const sale = saleOf(payload, 11);
    const steps = at(listed(capture, 11), 'timeline') as unknown as Array<{ status: string; at: string }>;
    // Placed, checked in and completed on New York evenings: each UTC date is the day after.
    const evening = steps.filter((step) => ['pending_confirmation', 'check_in_complete', 'order_complete'].includes(step.status));
    for (const step of evening) assert.notEqual(step.at.slice(0, 10), intlNewYorkDate(step.at), step.status);
    assert.equal(sale.completedDate, '2025-10-08');
    for (const line of sale.lines) {
      const byKind = Object.fromEntries(line.events.map((event) => [event.kind, event.date]));
      assert.equal(byKind.agreed, sale.date);
      assert.equal(byKind.inspected, '2025-10-07');
      assert.equal(byKind.completed, sale.completedDate);
      assert.ok(line.events.every((event) => event.date === null || event.date >= sale.date));
    }
  });

  it('keeps a step reached without a time as an undated event, and none for a step not yet reached', () => {
    const capture = syntheticCollectPureSales();
    at(listed(capture, 13), 'timeline', 2).at = null;
    at(listed(capture, 13), 'timeline', 2).dateNY = null;
    at(raw(capture, 13), 'order', 'statusHistory', 2).changed_at = null;
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(saleOf(output.payload, 13).lines[0].events, [
      { kind: 'agreed', date: '2025-11-02', dateBasis: 'stated', quantity: 1, occurrence: 1 },
      { kind: 'shipped', date: null, dateBasis: null, quantity: 1, occurrence: 1 },
    ]);
  });

  it('reads both deductions signed, as the site states them: a zero insured shipping, as every real sale has, stays zero', () => {
    const output = convert(fromSpec((spec) => {
      sale11(spec).shipping = 0;
      sale11(spec).breakdown[1].cents = 0;
      sale11(spec).breakdown[3].cents = 790_072;
      sale11(spec).payouts![0].amount = 790_072;
    }));
    assertWritten(output);
    assert.deepEqual(heldOf(output.payload, 11), []);
    const sale = saleOf(output.payload, 11);
    assert.deepEqual(sale.components, [{ kind: 'platform-fee', amountMinor: -7_981 }, { kind: 'insured-shipping', amountMinor: 0 }]);
    assert.equal(sale.fullPriceMinor, 790_072);
  });

  it('takes one optional fee as the platform fee restated only when all agree to the cent, and counts the sales taken', () => {
    // The page's row may state its rate or not: "Platform Fee (1%)" or "Platform Fee".
    const { payload, report, json } = convert(fromSpec((spec) => { sale11(spec).breakdown[2].label = 'Platform Fee'; }));
    assert.deepEqual(heldOf(payload, 11), []);
    // Never a component of its own, nor counted, nor stored.
    assert.deepEqual(saleOf(payload, 11).components, [{ kind: 'platform-fee', amountMinor: -7_981 }, { kind: 'insured-shipping', amountMinor: -3_011 }]);
    assert.equal(saleOf(payload, 11).fullPriceMinor, 787_061);
    assert.ok(!json.includes(COLLECTPURE_OPTION_TITLE) && !JSON.stringify(report).includes(COLLECTPURE_OPTION_TITLE));
    assert.deepEqual(report.optionalFees, { none: 1, restatedPlatformFee: 3 });
    // A sale it doesn't take is held, and not counted as taken: drift shows in both counts.
    const drift = convert(fromSpec((spec) => { sale11(spec).optionalFees![0].fee = -7_980; }));
    assert.deepEqual(drift.report.optionalFees, { none: 1, restatedPlatformFee: 2 });
    assert.deepEqual(drift.report.held, { 'field-unsupported/optional-fee': 1 });
  });

  it('keeps each metal line as a disposition: content read on the raw name, money split by the allocation rule', () => {
    const { payload } = convert(syntheticCollectPureSales());
    const sale = saleOf(payload, 11);
    assert.equal(sale.side, 'sell');
    assert.equal(sale.channel, 'online');
    assert.equal(sale.status, 'complete');
    assert.equal(sale.completedDate, '2025-10-08');
    assert.deepEqual(sale.components, [{ kind: 'platform-fee', amountMinor: -7_981 }, { kind: 'insured-shipping', amountMinor: -3_011 }]);
    assert.equal(sale.fullPriceMinor, 787_061);
    assert.equal(sale.unattributedMinor, 0);
    assert.deepEqual(sale.skeleton.map((line) => [line.ordinal, line.kind, line.amountMinor, line.metal]), [[0, 'item', 530_026, true], [1, 'item', 268_027, true]]);
    const [eagle, bar] = sale.lines;
    assert.deepEqual({ ...eagle, directMinor: 0, allocated: [], netMinor: 0 }, {
      key: metalsNaturalKey('collectpure', 'sline', [id(11), '7101']),
      ordinal: 0,
      title: COLLECTPURE_EAGLE_TITLE,
      productRef: 'collectpure:CP-EAGLE-1OZ',
      ...expectedContent(COLLECTPURE_EAGLE_TITLE),
      quantity: 2,
      unitPriceMinor: 265_013,
      amountMinor: 530_026,
      directMinor: 0,
      allocated: [],
      costMinor: null,
      netMinor: 0,
      complete: true,
      events: events(2, [['agreed', '2025-10-01'], ['shipped', '2025-10-03'], ['received', '2025-10-07'], ['inspected', '2025-10-07'],
        ['completed', '2025-10-08']]),
      seller: null,
      // The premium in its one closed form: the stated percent to four decimals, and the stated dollars on the basis.
      sale: { program: 'Sell to Dealer', premium: { text: 'spot -1.5000% / -$40.13 per troy ounce', basis: 'troy_ounce' }, inspection: 'passed' },
    });
    // A coin by its specification (the year in the title is read as a word, title rule v2), a bar by its stated fine mass.
    assert.deepEqual([eagle.statedMass, eagle.design, eagle.fine], [{ value: '1', unit: 'oz' }, 'eagle', { troyOz: '1/1', basis: 'coin-specification' }]);
    assert.deepEqual(bar, { ...bar, ...expectedContent(COLLECTPURE_FINE_BAR_TITLE), title: COLLECTPURE_FINE_BAR_TITLE, productRef: 'collectpure:CP-BAR-1OZT' });
    assert.deepEqual([bar.massBasis, bar.purity, bar.fine], ['fine', { text: '.9999', value: '9999/10000' }, { troyOz: '1/1', basis: 'stated-mass-basis' }]);
    assert.deepEqual(bar.sale, { program: 'Sell to Dealer', premium: { text: 'spot +2.2500% / +$58.97 per troy ounce', basis: 'troy_ounce' }, inspection: 'passed' });
    // The dealer's two deductions are attributed to the lines; their nets add up to the total payout.
    assert.equal(eagle.netMinor! + bar.netMinor!, 787_061);
    assert.equal(eagle.directMinor, 530_026);
    assert.ok(eagle.allocated.length === 2 && bar.allocated.length === 2);
  });

  it('keeps silver, a bare-ounce bar beside a non-metal line, and a cancelled sale', () => {
    const { payload } = convert(syntheticCollectPureSales());
    const silver = saleOf(payload, 12).lines[0];
    assert.deepEqual(silver, { ...silver, ...expectedContent(COLLECTPURE_SILVER_EAGLE_TITLE), quantity: 20, unitPriceMinor: 3_157, amountMinor: 63_140 });
    assert.equal(silver.metal, 'XAG');
    assert.equal('hold' in silver.fine && silver.fine.hold, 'fine-content-unknown');
    assert.deepEqual(silver.sale, { program: null, premium: { text: 'spot +3.0123% / +$0.93 per unit', basis: 'unit' }, inspection: null });

    const mixed = saleOf(payload, 13);
    assert.equal(mixed.status, 'shipped');
    assert.equal(mixed.completedDate, null);
    assert.deepEqual(mixed.payouts, []);
    assert.deepEqual(mixed.skeleton.map((line) => line.metal), [true, false]);
    assert.equal(mixed.lines.length, 1);
    // The deductions reach a metal and a non-metal line, so they stay unattributed and the metal line is incomplete.
    assert.equal(mixed.unattributedMinor, -4_728);
    assert.deepEqual([mixed.lines[0].netMinor, mixed.lines[0].complete], [270_019, false]);
    assert.deepEqual(mixed.lines[0], { ...mixed.lines[0], ...expectedContent(COLLECTPURE_BARE_OZ_BAR_TITLE) });
    assert.equal('hold' in mixed.lines[0].fine && mixed.lines[0].fine.hold, 'unit-unconfirmed');
    assert.equal(mixed.lines[0].sale!.inspection, 'pending');
    assert.deepEqual(mixed.lines[0].events, events(1, [['agreed', '2025-11-02'], ['shipped', '2025-11-04']]));

    const cancelled = saleOf(payload, 14);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.components, []);
    assert.equal(cancelled.fullPriceMinor, 30_029);
    assert.deepEqual(cancelled.lines[0].fine, { troyOz: '1/10', basis: 'coin-specification' });
    assert.deepEqual(cancelled.lines[0], { ...cancelled.lines[0], ...expectedContent(COLLECTPURE_MAPLE_TITLE) });
    assert.deepEqual(cancelled.lines[0].events, events(1, [['agreed', '2025-06-01'], ['cancelled', null]]));
  });

  it('keeps each payout: ACH, its destination last 4, amount, New York creation date and stated payout date', () => {
    const { payload } = convert(syntheticCollectPureSales());
    assert.deepEqual(saleOf(payload, 11).payouts, [{
      key: metalsNaturalKey('collectpure', 'payout', [syntheticPayoutId(11, 0)]), method: 'ach', destinationLast4: '0007', amountMinor: 787_061,
      initiatedDate: '2025-10-09', payoutDate: '2025-10-10', status: 'complete',
    }]);
    assert.deepEqual(saleOf(payload, 12).payouts.map((payout) => [payout.initiatedDate, payout.payoutDate]), [['2025-03-17', '2025-03-17']]);
  });

  it('reports counts, closed codes, dates and digests only', () => {
    const capture = syntheticCollectPureSales();
    const files = syntheticCollectPureFiles(capture);
    const { report, payload } = convertFiles(files);
    const lines = payload.orders.flatMap((order) => order.lines);
    const byContent: Record<string, number> = {};
    for (const line of lines) {
      const code = 'basis' in line.fine ? line.fine.basis : line.fine.hold;
      byContent[code] = (byContent[code] ?? 0) + 1;
    }
    assert.deepEqual(report, {
      converter: 'collectpure@1',
      snapshot: false,
      capture: { capturedAt: '2026-01-02T03:04:05.000Z', captureDigest: metalsDigest(files[0].bytes), files: files.length },
      sellOrders: {
        listed: 4, converted: 4, held: 0, byStatus: { agreed: 0, shipped: 1, received: 0, inspected: 0, complete: 2, cancelled: 1 },
        agreedDays: { first: '2025-03-10', last: '2025-11-02' },
      },
      lines: {
        dispositions: 5, nonMetal: 1, byMetal: { XAG: 1, XAU: 4 }, byPack: { single: 5, multiple: 0, unknown: 0 },
        byContent: Object.fromEntries(Object.entries(byContent).sort()), stored: { title: 5, productRef: 5, program: 3, premium: 4 },
        withheld: { title: 0, productRef: 0, program: 0, premium: 0 },
        productRefs: {
          metal: { stored: 5, withheld: { absent: 0, form: 0, 'too-long': 0, 'digit-run': 0, 'card-data': 0 } },
          flagged: { stored: 0, withheld: { absent: 0, form: 0, 'too-long': 0, 'digit-run': 0, 'card-data': 0 } },
        },
        titlesWithheld: { text: 0, 'pack-marker': 0, 'metal-guard': 0 },
      },
      guard: {
        flaggedLines: 0,
        byClause: Object.fromEntries(RETAIL_METAL_GUARD_CLAUSES.map((clause) => [clause, 0])),
        byFirstEvidence: Object.fromEntries(RETAIL_METAL_GUARD_EVIDENCE.map((code) => [code, 0])),
        byEvidence: Object.fromEntries(RETAIL_METAL_GUARD_EVIDENCE.map((code) => [code, 0])),
        adjacencyOnly: 0, flaggedOrders: 0, mixedOrders: 0, heldAlsoFlaggedOrders: 0,
      },
      // Every line but the display case names a metal, and the rule reads each as metal.
      census: { universe: 5, heldMetalWordLines: 0, metal: 5, flagged: 0, drift: 0, omissions: 0, omissionsByPlace: {} },
      // The owner's questions count lots, which are buy orders' lines: a sales capture counts none.
      confirmations: {
        needed: 0, neededIncludingFullyCancelledOrReturned: 0, productRefs: 0, productScoped: 0, lotScoped: 0, metalUnknown: 0,
        notCancelledOrReturned: { productScoped: 0, lotScoped: 0, metalUnknown: 0 },
      },
      bullion: { needed: 0, productScoped: 0, lotScoped: 0, includingFullyCancelledOrReturned: { needed: 0, productScoped: 0, lotScoped: 0 } },
      payouts: { listed: 2, unreadableRows: 0, historyPages: 2, historyRows: 2, converted: 2 },
      optionalFees: { none: 1, restatedPlatformFee: 3 },
      rawSellOrders: { files: 4, withoutListing: 0 },
      held: {},
      contractIssues: [],
      coverage: [
        {
          kind: 'sell-orders', from: '2025-03-10', to: '2026-01-01', stated: 4, seen: 4, complete: true,
          statedBasis: COLLECTPURE_COVERAGE_BASES['sell-orders'], statedUnknownBecause: null,
        },
        {
          kind: 'payouts', from: '2025-03-17', to: '2026-01-01', stated: 2, seen: 2, complete: true,
          statedBasis: COLLECTPURE_COVERAGE_BASES.payouts, statedUnknownBecause: null,
        },
      ],
    });
    assert.match(report.coverage[1].statedBasis, /rows read to the pager's end/);
    assert.deepEqual(payload.coverage, report.coverage.map(({ kind, from, to, stated, seen, complete }) => ({ kind, from, to, stated, seen, complete })));
    const kept = (stored: (line: (typeof lines)[number]) => unknown) => lines.filter((line) => stored(line) !== null).length;
    assert.deepEqual(report.lines.stored, {
      title: kept((line) => line.title), productRef: kept((line) => line.productRef), program: kept((line) => line.sale!.program),
      premium: kept((line) => line.sale!.premium),
    });
    const text = JSON.stringify(report);
    for (const value of [...syntheticCollectPureSalesSecrets(), ...syntheticCollectPureSalesPayloadValues()]) {
      assert.ok(!text.includes(value), `the report shows ${value}`);
    }
  });

  it('holds no native id, free text or account record in the payload', () => {
    const { json } = convert(syntheticCollectPureSales());
    for (const value of syntheticCollectPureSalesSecrets()) assert.ok(!json.includes(value), `the payload holds ${value}`);
    assert.ok(!/"[^"]*\b(?:7101|7102|7201|7301|7302|7401)\b[^"]*"/.test(json), 'the payload holds a native line id');
  });

  it('gives the same text for the same files, in any order', () => {
    const files = syntheticCollectPureFiles(syntheticCollectPureSales());
    const first = convertFiles(files).json;
    assert.equal(convertFiles([...files].reverse()).json, first);
    assert.equal(convertFiles(files).json, first);
  });
});

interface HoldCase {
  name: string;
  reason: string;
  check: string;
  /** The held sale (11 unless said) and the date its hold keeps (by default, its agreed day). */
  seed?: number;
  date?: string | null;
  spec?: (spec: SyntheticCollectPureSpec) => void;
  change?: (capture: SyntheticCollectPureCapture) => void;
  files?: (files: MetalsCaptureFile[]) => void;
}

const sale11 = (spec: SyntheticCollectPureSpec) => spec.sellOrders[0];

const HOLDS: HoldCase[] = [
  // The raw detail.
  { name: 'its raw sell order is missing', reason: 'raw-missing', check: 'raw-sell-order', change: (c) => { c.rawSellOrders = c.rawSellOrders.filter((file) => file.id !== id(11)); } },
  {
    name: 'its raw sell order is not JSON', reason: 'unreadable', check: 'raw-json',
    files: (files) => { files.find((file) => file.path === `raw/sell-order-${id(11)}.json`)!.bytes = new TextEncoder().encode('{"order":'); },
  },
  { name: 'its raw sell order has another shape', reason: 'unreadable', check: 'raw-shape', change: (c) => { at(raw(c, 11), 'order', 'lineItems', 0).quantity = 1.5; } },
  { name: 'its raw sell order disagrees', reason: 'capture-disagreement', check: 'raw-detail', change: (c) => { at(raw(c, 11), 'order', 'lineItems', 0).quantity = 3; } },
  // What the raw file states of itself: its own id, and its status in the page's words (the listing's detailStatus).
  { name: 'its raw sell order states another id', reason: 'capture-disagreement', check: 'raw-detail', change: (c) => { at(raw(c, 11), 'order').id = id(98); } },
  { name: 'its raw sell order states another status', reason: 'capture-disagreement', check: 'raw-detail', change: (c) => { at(raw(c, 11), 'order').status = 'In Transit'; } },
  {
    name: 'its raw sell order states a status its listing doesn\'t word', reason: 'capture-disagreement', check: 'raw-detail',
    change: (c) => { at(listed(c, 11), 'status').detailStatus = null; },
  },
  // Its record in the consolidated file.
  { name: 'its consolidated record has another shape', reason: 'unreadable', check: 'sell-order-shape', change: (c) => { at(listed(c, 11), 'lines', 0).qty = 1.5; } },
  {
    name: 'its consolidated record has another shape, on placedAt\'s New York date', reason: 'unreadable', check: 'sell-order-shape', date: '2025-10-01',
    change: (c) => { at(listed(c, 11), 'lines', 0).qty = 1.5; listed(c, 11).placedDateNY = '2025-10-02'; },
  },
  {
    name: 'its consolidated placedAt is not an instant, on its stated New York date', reason: 'unreadable', check: 'sell-order-shape', date: '2025-10-02',
    change: (c) => { listed(c, 11).placedAt = 'not an instant'; listed(c, 11).placedDateNY = '2025-10-02'; },
  },
  { name: 'its status is outside the closed list', reason: 'status-unknown', check: 'status-key', change: (c) => { at(listed(c, 11), 'status').key = 'order_lost'; } },
  { name: 'its status is missing', reason: 'field-missing', check: 'status', change: (c) => { delete listed(c, 11).status; } },
  { name: 'its status has no key', reason: 'field-missing', check: 'status', change: (c) => { delete at(listed(c, 11), 'status').key; } },
  // The timeline: seven steps, in order, with rising instants, opening with the placement.
  {
    name: 'its first step has no time', reason: 'field-missing', check: 'first-step',
    change: (c) => { at(listed(c, 11), 'timeline', 0).at = null; at(raw(c, 11), 'order', 'statusHistory', 0).changed_at = null; },
  },
  {
    name: 'its timeline opens with another step', reason: 'status-ambiguous', check: 'timeline-order',
    spec: (s) => { sale11(s).timeline.shift(); sale11(s).placedAt = sale11(s).timeline[0].at!; },
  },
  {
    name: 'its steps run out of order', reason: 'status-ambiguous', check: 'timeline-order',
    spec: (s) => { const steps = sale11(s).timeline; [steps[2].status, steps[3].status] = [steps[3].status, steps[2].status]; },
  },
  {
    name: 'two steps share an instant', reason: 'status-ambiguous', check: 'timeline-order',
    spec: (s) => { const steps = sale11(s).timeline; steps[2].at = steps[1].at; },
  },
  {
    name: 'a complete sale has not reached every step', reason: 'status-ambiguous', check: 'timeline-incomplete',
    spec: (s) => { sale11(s).timeline.splice(4, 1); },
  },
  { name: 'a step past its status has happened', reason: 'status-ambiguous', check: 'timeline-ahead', spec: (s) => { sale11(s).status = 'check_in_complete'; } },
  {
    name: 'a cancelled sale had completed', reason: 'status-ambiguous', check: 'timeline-ahead', seed: 14,
    spec: (s) => { s.sellOrders[3].timeline = sale11(syntheticCollectPureSalesSpec()).timeline.map((step) => ({ ...step })); s.sellOrders[3].placedAt = s.sellOrders[3].timeline[0].at!; },
    date: '2025-10-01',
  },
  // The trade moment and the agreed day.
  { name: 'placedAt is not the first step', reason: 'capture-disagreement', check: 'trade-moment', change: (c) => { listed(c, 11).placedAt = '2025-10-02T01:30:01.000Z'; } },
  {
    // Held on placedAt's New York date, never the UTC date the capture states.
    name: 'its stated New York date is the UTC date of a New York evening', reason: 'capture-disagreement', check: 'agreed-day', date: '2025-10-01',
    change: (c) => { listed(c, 11).placedDateNY = '2025-10-02'; },
  },
  {
    name: 'a step\'s stated New York date disagrees', reason: 'capture-disagreement', check: 'step-date',
    change: (c) => { at(listed(c, 11), 'timeline', 5).dateNY = '2025-10-08'; },
  },
  { name: 'placedAt is missing', reason: 'field-missing', check: 'placed-at', change: (c) => { listed(c, 11).placedAt = null; } },
  {
    name: 'placedAt is missing, on its stated New York date', reason: 'field-missing', check: 'placed-at', date: '2025-10-02',
    change: (c) => { listed(c, 11).placedAt = null; listed(c, 11).placedDateNY = '2025-10-02'; },
  },
  { name: 'its New York date is missing', reason: 'field-missing', check: 'placed-date-ny', change: (c) => { listed(c, 11).placedDateNY = null; } },
  { name: 'its page states a price lock', reason: 'field-unsupported', check: 'price-lock', spec: (s) => { sale11(s).priceLockStated = true; } },
  // Money no reviewed rule covers, and the identities. An optional fee is taken only as the platform fee restated, with
  // every fact agreeing to the cent (ROOT's ruling); anything else holds.
  { name: 'its optional fee is not its platform fee to the cent', reason: 'field-unsupported', check: 'optional-fee', spec: (s) => { sale11(s).optionalFees![0].fee = -7_980; } },
  {
    name: 'it states two optional fees', reason: 'field-unsupported', check: 'optional-fee',
    spec: (s) => { sale11(s).optionalFees!.push({ title: COLLECTPURE_OPTION_TITLE, fee: -7_981 }); },
  },
  {
    name: 'its optional fee is not negative', reason: 'field-unsupported', check: 'optional-fee',
    spec: (s) => { sale11(s).processingFee = 0; sale11(s).breakdown[2].cents = 0; sale11(s).optionalFees![0].fee = 0; },
  },
  {
    name: 'it states an optional fee and no platform fee', reason: 'field-unsupported', check: 'optional-fee',
    spec: (s) => { sale11(s).processingFee = null; sale11(s).breakdown.splice(2, 1); },
  },
  { name: 'its page states the platform fee otherwise', reason: 'field-unsupported', check: 'optional-fee', spec: (s) => { sale11(s).breakdown[2].cents = -7_980; } },
  {
    // The optional fee and the page's row agree with each other, but not with the stated platform fee.
    name: 'its optional fee and its page row agree, but not with its platform fee', reason: 'field-unsupported', check: 'optional-fee',
    spec: (s) => { sale11(s).optionalFees![0].fee = -7_980; sale11(s).breakdown[2].cents = -7_980; },
  },
  { name: 'its page has no platform fee row', reason: 'field-unsupported', check: 'optional-fee', spec: (s) => { sale11(s).breakdown.splice(2, 1); } },
  {
    name: 'its page has two platform fee rows', reason: 'field-unsupported', check: 'optional-fee',
    spec: (s) => { sale11(s).breakdown.splice(2, 0, { label: 'Platform Fee', cents: -7_981 }); },
  },
  {
    name: 'its total payout counts the restated fee again', reason: 'field-unsupported', check: 'optional-fee',
    change: (c) => { at(listed(c, 11), 'amounts', 'total').cents = 779_080; at(raw(c, 11), 'order').total = 779_080; },
  },
  {
    name: 'a promotion applies', reason: 'field-unsupported', check: 'promotion',
    change: (c) => { at(listed(c, 11), 'amounts').appliedPromotions = 1; at(raw(c, 11), 'order').appliedPromotions = [{ code: 'SAMPLE' }]; },
  },
  { name: 'it states sales tax', reason: 'field-unsupported', check: 'sales-tax', spec: (s) => { sale11(s).salesTax = 120; } },
  {
    name: 'it states an instant payout advance', reason: 'field-unsupported', check: 'instant-payout-advance',
    change: (c) => { at(listed(c, 11), 'amounts').instantPayoutAdvance = { amount: 1 }; at(raw(c, 11), 'order').instantPayoutAdvance = { amount: 1 }; },
  },
  { name: 'it is combined with another sell order', reason: 'field-unsupported', check: 'combined-sell-order', change: (c) => { listed(c, 11).combinedSellOrderIds = [id(99)]; } },
  {
    name: 'a deduction is stated positive', reason: 'field-unsupported', check: 'positive-deduction',
    spec: (s) => { sale11(s).processingFee = 7_981; sale11(s).optionalFees = []; },
  },
  { name: 'it has no lines', reason: 'field-missing', check: 'lines', spec: (s) => { sale11(s).lines = []; } },
  { name: 'two lines share an id', reason: 'duplicate-in-capture', check: 'line-id', spec: (s) => { sale11(s).lines[1].id = sale11(s).lines[0].id; } },
  { name: 'a line has no units', reason: 'quantity-unknown', check: 'line-quantity', spec: (s) => { sale11(s).lines[0].qty = 0; } },
  { name: 'a line has a negative price', reason: 'field-unsupported', check: 'negative-price', spec: (s) => { sale11(s).lines[1].price = -268_027; } },
  {
    name: 'a line total is not quantity × unit price', reason: 'identity-failed', check: 'line-total',
    change: (c) => { at(listed(c, 11), 'lines', 0, 'lineTotal').cents = 530_027; },
  },
  {
    name: 'the line totals are not the subtotal', reason: 'identity-failed', check: 'subtotal', spec: (s) => { sale11(s).optionalFees = []; },
    change: (c) => { at(listed(c, 11), 'amounts', 'subtotal').cents = 798_153; at(raw(c, 11), 'order').subtotal = 798_153; },
  },
  {
    name: 'subtotal − insured shipping − platform fee is not the total payout', reason: 'identity-failed', check: 'payout-identity',
    spec: (s) => { sale11(s).optionalFees = []; },
    change: (c) => { at(listed(c, 11), 'amounts', 'total').cents = 787_062; at(raw(c, 11), 'order').total = 787_062; },
  },
  { name: 'a complete sale is paid a cent short', reason: 'identity-failed', check: 'paid-total', spec: (s) => { sale11(s).payouts![0].amount = 787_060; } },
  // Lines and inspection.
  { name: 'a line is pending on a complete sale', reason: 'status-ambiguous', check: 'line-pending', spec: (s) => { sale11(s).lines[0].status = 'Item Pending'; } },
  {
    name: 'an inspection field is not true or false', reason: 'field-unsupported', check: 'inspection-value',
    change: (c) => { at(listed(c, 11), 'lines', 0, 'inspection').passedInspection = 'yes'; at(raw(c, 11), 'order', 'lineItems', 0, 'tracking').passedInspection = 'yes'; },
  },
  { name: 'a line failed inspection', reason: 'inspection-failed', check: 'inspection', spec: (s) => { sale11(s).lines[1].inspection!.passed = false; } },
  {
    name: 'a sale cancelled after its check-in had failed inspection', reason: 'inspection-failed', check: 'inspection', seed: 14, date: '2025-10-01',
    spec: (s) => {
      const cancelled = s.sellOrders[3];
      cancelled.timeline = sale11(syntheticCollectPureSalesSpec()).timeline.slice(0, 6).map((step) => ({ ...step }));
      cancelled.placedAt = cancelled.timeline[0].at!;
      cancelled.lines[0].inspection = { received: true, passed: false, buyerPaid: false };
    },
  },
  // Payouts.
  {
    name: 'it is paid out other than by ACH', reason: 'payout-unsupported', check: 'payout-method',
    change: (c) => { at(listed(c, 11), 'payout').method = 'check'; at(raw(c, 11), 'order', 'payoutDetails').method = 'check'; },
  },
  {
    name: 'a payout transaction is not ACH', reason: 'payout-unsupported', check: 'payout-method',
    change: (c) => { at(listed(c, 11), 'payout', 'transactions', 0).method = 'WIRE'; at(raw(c, 11), 'order', 'payoutTransactions', 0).method = 'WIRE'; },
  },
  { name: 'a payout is not complete', reason: 'payout-unsupported', check: 'payout-status', spec: (s) => { sale11(s).payouts![0].status = 'paid'; } },
  { name: 'a payout is of no amount', reason: 'payout-unsupported', check: 'payout-amount', spec: (s) => { sale11(s).payouts![0].amount = 0; } },
  {
    name: 'a payout has no creation time', reason: 'field-missing', check: 'payout-date',
    change: (c) => { at(listed(c, 11), 'payout', 'transactions', 0).initiatedAt = null; },
  },
  {
    name: 'a payout was created before the agreed day', reason: 'capture-disagreement', check: 'payout-date-order',
    spec: (s) => { sale11(s).payouts![0].createdAt = '2025-09-30T12:00:00.000Z'; },
  },
  {
    name: 'a payout was paid before it was created', reason: 'capture-disagreement', check: 'payout-date-order',
    spec: (s) => { sale11(s).payouts![0].date = '2025-10-08'; sale11(s).payouts![0].createdAt = '2025-10-09T15:00:00.000Z'; },
  },
  {
    name: 'the payouts list disagrees', reason: 'capture-disagreement', check: 'payout-list',
    change: (c) => { at((c.consolidated.payouts as Json[]).find((row) => row.sellOrderId === id(11)), 'amount').cents = 787_062; },
  },
  // Each other field of the sale's payouts-list row, alone.
  { name: 'the payouts list states another method', reason: 'capture-disagreement', check: 'payout-list', change: (c) => { payoutRow(c, 11).method = 'WIRE'; } },
  { name: 'the payouts list states another status', reason: 'capture-disagreement', check: 'payout-list', change: (c) => { payoutRow(c, 11).status = 'pending'; } },
  {
    name: 'the payouts list states another payout date', reason: 'capture-disagreement', check: 'payout-list',
    change: (c) => { payoutRow(c, 11).payoutDate = '2025-10-11'; },
  },
  {
    name: 'the payouts list words its payout date otherwise', reason: 'capture-disagreement', check: 'payout-list',
    change: (c) => { payoutRow(c, 11).payoutDateRaw = '2025-10-10T00:00:00.000Z'; },
  },
  {
    name: 'the payouts list states another creation time', reason: 'capture-disagreement', check: 'payout-list',
    change: (c) => { payoutRow(c, 11).initiatedAt = '2025-10-10T02:16:00.000Z'; },
  },
  { name: 'a payout-history page disagrees', reason: 'capture-disagreement', check: 'payout-history', change: (c) => { historyItem(c, 11).amount = 787_062; } },
  {
    name: 'a payout-history page dates it otherwise', reason: 'capture-disagreement', check: 'payout-history',
    change: (c) => {
      const item = historyItem(c, 11);
      assert.notEqual(item.payoutDate, '2025-10-11');
      item.payoutDate = '2025-10-11';
    },
  },
  // Each other field of the sale's payout-history item, alone.
  {
    name: 'a payout-history page states another method', reason: 'capture-disagreement', check: 'payout-history',
    change: (c) => { historyItem(c, 11).method = 'WIRE'; },
  },
  {
    name: 'a payout-history page states another status', reason: 'capture-disagreement', check: 'payout-history',
    change: (c) => { historyItem(c, 11).status = 'pending'; },
  },
  {
    name: 'a payout-history page states another creation time', reason: 'capture-disagreement', check: 'payout-history',
    change: (c) => { historyItem(c, 11).createdAt = '2025-10-10T02:16:00.000Z'; },
  },
  { name: 'its total paid is not its payouts', reason: 'capture-disagreement', check: 'total-paid', change: (c) => { at(listed(c, 11), 'payout', 'totalPaid').cents = 787_062; } },
  {
    name: 'a cancelled sale was paid', reason: 'status-ambiguous', check: 'cancelled-with-payout', seed: 14,
    spec: (s) => { s.sellOrders[3].payouts = [{ amount: 30_029, status: 'complete', date: '2025-06-02' }]; },
  },
  // Its content, and the payload's own rules.
  {
    name: 'no line names a metal', reason: 'field-unsupported', check: 'no-metal-line',
    spec: (s) => { sale11(s).lines[0].name = 'Sample Item One'; sale11(s).lines[1].name = 'Sample Item Two'; },
  },
  {
    name: 'the payload\'s rules refuse a line (more units than a line may hold)', reason: 'field-unsupported', check: 'payload-contract',
    spec: (s) => { sale11(s).lines[0].qty = 100_001; sale11(s).lines[0].price = 1; sale11(s).payouts![0].amount = 357_036; },
  },
];

describe('CollectPure converter: a sale that fails a check is held, with its date', () => {
  it('names every hold check of the closed list in a case below', () => {
    const named = new Set(HOLDS.map((hold) => `${hold.reason}/${hold.check}`));
    const elsewhere = ['duplicate-in-capture/sell-order-id', 'duplicate-in-capture/payout-id', 'capture-disagreement/raw-without-listing',
      'capture-disagreement/payout-without-sell-order', 'buy-side-unsupported/buy-order', 'buy-side-unsupported/inventory-row',
      'vault-unsupported/vault-enabled', 'vault-unsupported/vault-holding'];
    for (const [reason, checks] of Object.entries(COLLECTPURE_HOLD_CHECKS)) {
      for (const check of checks) assert.ok(named.has(`${reason}/${check}`) || elsewhere.includes(`${reason}/${check}`), `${reason}/${check}`);
    }
  });

  for (const hold of HOLDS) {
    it(`holds a sale when ${hold.name}`, () => {
      const capture = hold.spec ? fromSpec(hold.spec) : syntheticCollectPureSales();
      hold.change?.(capture);
      const files = syntheticCollectPureFiles(capture);
      hold.files?.(files);
      const output = convertFiles(files);
      assertWritten(output);
      const seed = hold.seed ?? 11;
      const placedAt = (syntheticCollectPureSalesSpec().sellOrders.find((sale) => sale.seed === seed)!).placedAt;
      const date = hold.date !== undefined ? hold.date : intlNewYorkDate(placedAt);
      assert.deepEqual(heldOf(output.payload, seed), [{ key: sellKey(seed), channel: 'online', date, reason: hold.reason, check: hold.check }]);
      assert.equal(output.payload.held.length, 1);
      assert.equal(output.payload.orders.length, 3);
      assert.deepEqual(output.report.held, { [`${hold.reason}/${hold.check}`]: 1 });
      assert.equal(output.report.sellOrders.held, 1);
      const text = `${JSON.stringify(output.report)}\n${output.json}`;
      for (const value of syntheticCollectPureSalesSecrets()) assert.ok(!text.includes(value), `the output shows ${value}`);
    });
  }

  it('compares the raw file\'s own id and status words only where it states them', () => {
    const capture = syntheticCollectPureSales();
    delete at(raw(capture, 11), 'order').id;
    delete at(raw(capture, 11), 'order').status;
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual([output.payload.orders.length, output.payload.held.length], [4, 0]);
  });

  it('reports the payload rule that refused a sale by its path and fixed message', () => {
    const output = convert(fromSpec(HOLDS.find((hold) => hold.check === 'payload-contract')!.spec!));
    assert.deepEqual(output.report.contractIssues, [{ path: '$.orders[0].lines[0].quantity', message: 'must be an integer from 1 to 100000' }]);
  });
});
describe('CollectPure converter: records held across sales, and the account\'s other sides', () => {
  it('holds every sale that shares an id, once, with no date when their dates differ', () => {
    const capture = syntheticCollectPureSales();
    listed(capture, 12).id = id(11);
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(heldOf(output.payload, 11), [{ key: sellKey(11), channel: 'online', date: null, reason: 'duplicate-in-capture', check: 'sell-order-id' }]);
    // Sale 12's raw file and payout now name a sale the list doesn't: held too, never dropped.
    assert.deepEqual(heldOf(output.payload, 12).map((record) => [record.reason, record.check, record.date]), [['capture-disagreement', 'raw-without-listing', '2025-03-10']]);
    assert.deepEqual(output.payload.orders.map((order) => order.key), [13, 14].map(sellKey).sort());
    assert.equal(output.report.sellOrders.listed, 4);
    assert.equal(output.report.coverage[0].seen, 4);
    // Both rows sharing the id still count in the window, though their one hold has no single date.
    assert.equal(output.report.coverage[0].from, '2025-03-10');
  });

  it('holds every sale whose payout id another sale\'s payout also carries', () => {
    const capture = syntheticCollectPureSales();
    const shared = syntheticPayoutId(12, 0);
    at(listed(capture, 11), 'payout', 'transactions', 0).payoutId = shared;
    at(raw(capture, 11), 'order', 'payoutTransactions', 0).id = shared;
    const output = convert(capture);
    assertWritten(output);
    for (const seed of [11, 12]) assert.deepEqual(heldOf(output.payload, seed).map((record) => record.check), ['payout-id'], `sale ${seed}`);
    assert.equal(output.payload.orders.length, 2);
  });

  it('holds both sales when the payouts list names each one\'s payout as the other\'s', () => {
    const capture = syntheticCollectPureSales();
    const [first, second] = [payoutRow(capture, 11), payoutRow(capture, 12)];
    [first.sellOrderId, second.sellOrderId] = [second.sellOrderId, first.sellOrderId];
    const output = convert(capture);
    assertWritten(output);
    // Each sale still has one row and each payout id one row: only the row's own sale id disagrees.
    const checks = [11, 12].map((seed) => heldOf(output.payload, seed).map((record) => record.check));
    assert.deepEqual(checks, [['payout-list'], ['payout-list']]);
  });

  it('holds both sales when the payout-history pages name each one\'s payout as the other\'s', () => {
    const capture = syntheticCollectPureSales();
    const [first, second] = [historyItem(capture, 11), historyItem(capture, 12)];
    [first.orderId, second.orderId] = [second.orderId, first.orderId];
    const output = convert(capture);
    assertWritten(output);
    // Each sale still has one item and each payout id one item: only the item's own sale id disagrees.
    const checks = [11, 12].map((seed) => heldOf(output.payload, seed).map((record) => record.check));
    assert.deepEqual(checks, [['payout-history'], ['payout-history']]);
  });

  it('leaves out a payouts row it can\'t read, so the sale it pays is held', () => {
    const capture = syntheticCollectPureSales();
    at((capture.consolidated.payouts as Json[]).find((row) => row.sellOrderId === id(11)), 'amount').cents = 787_061.5;
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(heldOf(output.payload, 11).map((record) => record.check), ['payout-list']);
    assert.equal(output.report.payouts.unreadableRows, 1);
    assert.equal(output.report.payouts.listed, 2);
  });

  it('holds a raw sell order the list doesn\'t name, dated by its first step, outside the list\'s coverage', () => {
    const capture = syntheticCollectPureSales();
    const copy = JSON.parse(JSON.stringify(raw(capture, 12))) as Json;
    at(copy, 'order', 'statusHistory', 0).changed_at = '2010-01-05T15:00:00.000456+00:00';
    capture.rawSellOrders.push({ name: `sell-order-${id(99)}.json`, id: id(99), json: copy });
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(output.payload.held, [{
      key: metalsNaturalKey('collectpure', 'sell', [id(99)]), channel: 'online', date: '2010-01-05', reason: 'capture-disagreement', check: 'raw-without-listing',
    }]);
    assert.equal(output.payload.orders.length, 4);
    assert.equal(output.report.rawSellOrders.withoutListing, 1);
    // The sell-orders coverage spans only the sales the list names.
    assert.equal(output.report.coverage[0].from, '2025-03-10');
  });

  it('holds a sell order that only a payout names, undated', () => {
    const capture = syntheticCollectPureSales();
    const row = JSON.parse(JSON.stringify((capture.consolidated.payouts as Json[])[0])) as Json;
    row.payoutId = syntheticPayoutId(98, 0);
    row.sellOrderId = id(98);
    (capture.consolidated.payouts as Json[]).push(row);
    const item = { ...historyItem(capture, 11), id: syntheticPayoutId(98, 0), orderId: id(98) };
    (at(capture.payoutHistoryPages[1].json, 'result', 'data', 'json').items as Json[]).push(item);
    at(capture.consolidated, 'provenance', 'pages', 2).rowsSeen = 3;
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(output.payload.held, [{
      key: metalsNaturalKey('collectpure', 'sell', [id(98)]), channel: 'online', date: null, reason: 'capture-disagreement', check: 'payout-without-sell-order',
    }]);
    assert.deepEqual(output.report.coverage[1], { ...output.report.coverage[1], stated: 3, seen: 3, complete: true });
  });

  it('holds every buy order, inventory row and vault record any statement shows, keyless and undated', () => {
    const capture = syntheticCollectPureSales();
    at(capture.consolidated, 'buyOrders').rows = 2;
    at(capture.stats[1].json, 'result', 'data', 'json').total = 3;
    at(capture.consolidated, 'inventory').totalCount = 1;
    at(capture.consolidated, 'vault').enabled = true;
    at(capture.consolidated, 'vault').holdings = [{ sku: 'SAMPLE' }, { sku: 'SAMPLE' }];
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(output.report.held, {
      'buy-side-unsupported/buy-order': 3, 'buy-side-unsupported/inventory-row': 1, 'vault-unsupported/vault-enabled': 1,
      'vault-unsupported/vault-holding': 2,
    });
    assert.ok(output.payload.held.every((record) => record.key === null && record.date === null && record.channel === 'online'));
    assert.equal(output.payload.orders.length, 4);
    assert.equal(output.report.sellOrders.held, 0);
  });
});

describe('CollectPure converter: metal guard v1 on every sale line (guard integration)', () => {
  /** A synthetic name per evidence kind, each refused by the title rule and flagged on that kind alone (the guard's own cases). */
  const ONE_EVIDENCE: Record<RetailMetalGuardEvidence, string> = {
    'bullion-word': 'Gold Assay Card Holder',
    'design-after-metal': 'Gold Eagle Candy',
    'shape-with-weight': 'Gold Chocolate Coin 1.5 oz',
    'troy-or-metric-weight': 'Gold Foil 1 ozt',
    purity: 'Gold Plated .9999 Fine',
    adjacency: 'Gold Bar Candy',
  };
  const ASSAY_CARD_TITLE = 'SAMPLE 1 oz Gold Bar in Assay Card';
  const guardOf = (title: string) => retailMetalTitleGuard(title, { assessed: true });
  /** The four sales, sale 11's second line (its bar) renamed. */
  const withSecondLine = (title: string) => convert(fromSpec((spec) => { sale11(spec).lines[1].name = title; }));
  /** The four sales' census: every line but the display case names a metal, and the rule reads each as metal. */
  const BASE_CENSUS = { universe: 5, heldMetalWordLines: 0, metal: 5, flagged: 0, drift: 0, omissions: 0, omissionsByPlace: {} };
  const NO_TITLE_WITHHELD = { text: 0, 'pack-marker': 0, 'metal-guard': 0 };
  const counted = (counts: Record<string, number>) => Object.entries(counts).filter(([, count]) => count > 0);

  it('reads evidence on every name the title rule reads as metal, and keeps those lines unflagged', () => {
    for (const title of [COLLECTPURE_EAGLE_TITLE, COLLECTPURE_FINE_BAR_TITLE, COLLECTPURE_SILVER_EAGLE_TITLE, COLLECTPURE_BARE_OZ_BAR_TITLE,
      COLLECTPURE_MAPLE_TITLE, ASSAY_CARD_TITLE]) {
      assert.notEqual(retailMetalTitleEvidence(title), null, title);
      const reading = guardOf(title);
      assert.deepEqual([reading.metalWord, reading.uncertain, reading.evidence.length > 0], [true, false, true], title);
    }
    const output = convert(syntheticCollectPureSales());
    assert.ok(output.payload.orders.flatMap((order) => order.lines).every((line) => line.metal !== null && line.metalUncertain === null));
    assert.deepEqual(output.report.census, BASE_CENSUS);
  });

  for (const code of RETAIL_METAL_GUARD_EVIDENCE) {
    it(`flags a line the rule refuses on ${code} alone: a disposition of no metal, held bullion-unconfirmed, in a sale carried in full`, () => {
      const title = ONE_EVIDENCE[code];
      assert.ok(title !== undefined, `a synthetic name for ${code}`);
      const reading = guardOf(title);
      assert.deepEqual([reading.uncertain, reading.evidence], [true, [code]], title);
      const output = withSecondLine(title);
      assertWritten(output);
      assert.deepEqual(heldOf(output.payload, 11), []);
      const sale = saleOf(output.payload, 11);
      const flag = { guard: 'metal-guard-v1', evidence: [code], metal: 'XAU' };
      assert.deepEqual(sale.lines[1], { ...sale.lines[1], ordinal: 1, ...expectedFlaggedContent(title) });
      assert.deepEqual([sale.lines[1].metal, sale.lines[1].metalUncertain, sale.lines[1].form, sale.lines[1].statedMass], [null, flag, null, null]);
      assert.equal((sale.lines[1].fine as { hold: string }).hold, 'bullion-unconfirmed');
      assert.deepEqual(sale.skeleton.map((line) => line.metal), [true, true]);
      const { guard } = output.report;
      assert.deepEqual(counted(guard.byClause), [[reading.clause, 1]]);
      assert.deepEqual([counted(guard.byFirstEvidence), counted(guard.byEvidence)], [[[code, 1]], [[code, 1]]]);
      assert.deepEqual([guard.flaggedLines, guard.flaggedOrders, guard.mixedOrders, guard.adjacencyOnly], [1, 1, 1, code === 'adjacency' ? 1 : 0]);
      // An evidence-bearing line is expected flagged, never drift.
      assert.deepEqual(output.report.census, { ...BASE_CENSUS, metal: 4, flagged: 1 });
    });
  }

  it('lists every evidence kind a name shows, in the closed order, the first naming the clause', () => {
    const title = '1 oz Gold Bar Gift Card';
    const reading = guardOf(title);
    assert.ok(reading.uncertain && reading.evidence.length >= 2, title);
    assert.deepEqual(reading.evidence, RETAIL_METAL_GUARD_EVIDENCE.filter((code) => reading.evidence.includes(code)));
    const output = withSecondLine(title);
    assertWritten(output);
    assert.deepEqual(saleOf(output.payload, 11).lines[1]?.metalUncertain, { guard: 'metal-guard-v1', evidence: reading.evidence, metal: 'XAU' });
    assert.deepEqual(counted(output.report.guard.byClause), [[`near-miss/${reading.evidence[0]}`, 1]]);
    assert.deepEqual(counted(output.report.guard.byFirstEvidence), [[reading.evidence[0], 1]]);
    assert.deepEqual(counted(output.report.guard.byEvidence), reading.evidence.map((code) => [code, 1]));
    assert.equal(output.report.guard.adjacencyOnly, 0, 'adjacency beside other evidence is no adjacency-only flag');
  });

  it('reads a bar in an assay card as metal (title rule v3), and flags an assay card holder, on ASSAY\'s bullion evidence', () => {
    const card = withSecondLine(ASSAY_CARD_TITLE);
    assertWritten(card);
    const bar = saleOf(card.payload, 11).lines[1];
    assert.deepEqual([bar?.metal, bar?.form, bar?.metalUncertain], ['XAU', 'bar', null]);
    assert.deepEqual(card.report.census, BASE_CENSUS);
    const holder = withSecondLine('SAMPLE 1 oz Gold Bar Assay Card Holder');
    assertWritten(holder);
    const flagged = saleOf(holder.payload, 11).lines[1];
    assert.deepEqual([flagged?.metal, flagged?.metalUncertain?.evidence[0]], [null, 'bullion-word']);
    assert.deepEqual(holder.report.census, { ...BASE_CENSUS, metal: 4, flagged: 1 });
  });

  it('carries a sale whose every line is flagged in full, never held as a sale with no metal line', () => {
    const output = convert(fromSpec((spec) => {
      sale11(spec).lines[0].name = ONE_EVIDENCE['design-after-metal'];
      sale11(spec).lines[1].name = ONE_EVIDENCE.adjacency;
    }));
    assertWritten(output);
    assert.deepEqual(heldOf(output.payload, 11), []);
    const sale = saleOf(output.payload, 11);
    assert.deepEqual(sale.lines.map((line) => [line.ordinal, line.metal, line.metalUncertain?.evidence]), [[0, null, ['design-after-metal']], [1, null, ['adjacency']]]);
    assert.deepEqual(sale.skeleton.map((line) => line.metal), [true, true]);
    assert.deepEqual(sale.components, [{ kind: 'platform-fee', amountMinor: -7_981 }, { kind: 'insured-shipping', amountMinor: -3_011 }]);
    assert.deepEqual([sale.status, sale.payouts.length, sale.evidence], ['complete', 1, []]);
    assert.deepEqual([output.report.guard.flaggedOrders, output.report.guard.mixedOrders], [1, 0]);
    assert.deepEqual(output.report.census, { ...BASE_CENSUS, metal: 3, flagged: 2 });
  });

  it('carries a mixed sale in full: its metal and flagged lines are both metal in the skeleton, and share the deductions', () => {
    const output = withSecondLine(ONE_EVIDENCE.adjacency);
    assertWritten(output);
    const sale = saleOf(output.payload, 11);
    assert.deepEqual(sale.lines.map((line) => [line.metal, line.metalUncertain === null]), [['XAU', true], [null, false]]);
    assert.deepEqual(sale.skeleton.map((line) => line.metal), [true, true]);
    assert.deepEqual([sale.unattributedMinor, sale.lines.map((line) => line.complete)], [0, [true, true]]);
    assert.equal(sale.lines[0].netMinor! + sale.lines[1].netMinor!, sale.fullPriceMinor);
    assert.ok(sale.lines.every((line) => line.allocated.length === 2), 'both deductions reach both lines');
    assert.deepEqual(sale.evidence, []);
  });

  it('holds first: a sale held for another reason stays held with that reason, its flag only counted', () => {
    const capture = fromSpec((spec) => { sale11(spec).lines[1].name = ONE_EVIDENCE.adjacency; });
    at(listed(capture, 11), 'amounts').appliedPromotions = 1;
    at(raw(capture, 11), 'order').appliedPromotions = [{ code: 'SAMPLE' }];
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(heldOf(output.payload, 11).map((record) => `${record.reason}/${record.check}`), ['field-unsupported/promotion']);
    assert.deepEqual([output.report.guard.flaggedLines, output.report.guard.heldAlsoFlaggedOrders], [0, 1]);
    assert.deepEqual(output.report.census, { ...BASE_CENSUS, heldMetalWordLines: 2, metal: 3 });
  });

  it('keeps a name with a metal word and no bullion evidence an anonymous non-metal line, unflagged, counted as drift', () => {
    const title = 'SAMPLE Gold Star Membership';
    const reading = guardOf(title);
    assert.deepEqual([reading.metalWord, reading.uncertain, reading.evidence], [true, false, []]);
    const output = convert(fromSpec((spec) => { spec.sellOrders[2].lines[1].name = title; }));
    assertWritten(output);
    const sale = saleOf(output.payload, 13);
    assert.deepEqual([sale.lines.map((line) => line.ordinal), sale.skeleton.map((line) => line.metal)], [[0], [true, false]]);
    assert.deepEqual([output.report.lines.nonMetal, output.report.guard.flaggedLines], [1, 0]);
    assert.deepEqual(output.report.census, { ...BASE_CENSUS, universe: 6, drift: 1 });
  });

  it('withholds the stored title of a line kept unflagged when the guard would flag that title, by its own reason, its facts read on the raw name', () => {
    // The rule reads the raw name as a bar with its weight, but the stored title, cut to the contract's length, ends just
    // before the weight, and the guard would flag that cut (a shape without a weight, the metal right before it).
    const raw = `Sample Refinery Gold Bar${' Gift Edition'.repeat(16)} Display 1 oz`;
    const cut = sanitizeCardText(raw, METALS_TITLE_MAX)!;
    assert.deepEqual([retailMetalTitleEvidence(raw)?.metal, retailMetalPack(raw), guardOf(raw).uncertain, cut.length, guardOf(cut).clause],
      ['XAU', 'single', false, METALS_TITLE_MAX, 'shape-without-weight/adjacency']);
    // The control: the same words with the weight right after the bar, so that the stored cut still reads as metal.
    const control = `Sample Refinery Gold Bar 1 oz${' Gift Edition'.repeat(16)} Display`;
    const kept = withSecondLine(control);
    assertWritten(kept);
    assert.deepEqual([saleOf(kept.payload, 11).lines[1]?.title, kept.report.lines.titlesWithheld], [sanitizeCardText(control, METALS_TITLE_MAX), NO_TITLE_WITHHELD]);
    // A flagged line keeps its stored title: it reads as the flag says, and no stored title sets or clears a flag.
    const flagged = withSecondLine(ONE_EVIDENCE.adjacency);
    assert.deepEqual([saleOf(flagged.payload, 11).lines[1]?.title, flagged.report.lines.titlesWithheld], [ONE_EVIDENCE.adjacency, NO_TITLE_WITHHELD]);
    // A title the stored-text guard refuses (a card secret's label and value, synthetic) is withheld as `text`.
    const secret = withSecondLine(`${COLLECTPURE_FINE_BAR_TITLE} CVV ${'1'.repeat(3)}`);
    assert.deepEqual([saleOf(secret.payload, 11).lines[1]?.title, secret.report.lines.titlesWithheld], [null, { ...NO_TITLE_WITHHELD, text: 1 }]);
    let output: Output | undefined;
    assert.equal(refusalOf(() => { output = withSecondLine(raw); }), null);
    assertWritten(output!);
    const line = saleOf(output!.payload, 11).lines[1];
    assert.deepEqual(line, { ...line, ordinal: 1, title: null, ...expectedContent(raw) });
    assert.deepEqual([output!.report.lines.titlesWithheld, output!.report.lines.withheld.title], [{ ...NO_TITLE_WITHHELD, 'metal-guard': 1 }, 1]);
    assert.deepEqual([output!.report.guard.flaggedLines, output!.report.census], [0, BASE_CENSUS]);
  });

  it('counts no buy-order line: the capture states buy orders only as counts, each a keyless held record', () => {
    const capture = syntheticCollectPureSales();
    at(capture.consolidated, 'buyOrders').rows = 2;
    const output = convert(capture);
    assertWritten(output);
    assert.equal(output.report.held['buy-side-unsupported/buy-order'], 2);
    assert.deepEqual(output.report.census, BASE_CENSUS);
  });

  it('counts every metal-word line of every captured sale once, by its expected position, with no omission', () => {
    const capture = fromSpec((spec) => {
      sale11(spec).lines[1].name = ONE_EVIDENCE.adjacency;
      // Sale 12's one line would be flagged, but the sale holds: its payout isn't complete.
      spec.sellOrders[1].lines[0].name = 'Silver Tone 1 kg';
      spec.sellOrders[1].payouts![0].status = 'paid';
      // Sale 13: a flagged line, its only line in metal, so it alone carries the sale; and a drift line.
      spec.sellOrders[2].lines[0].name = ONE_EVIDENCE['troy-or-metric-weight'];
      spec.sellOrders[2].lines[1].name = 'SAMPLE Gold Star Membership';
    });
    // A sale the list doesn't name (held, read from its raw file), and a listed sale that can't be read (held).
    capture.rawSellOrders.push({ name: `sell-order-${id(99)}.json`, id: id(99), json: JSON.parse(JSON.stringify(raw(capture, 12))) as Json });
    at(listed(capture, 14), 'lines', 0).qty = 1.5;
    // A listed sale whose id doesn't read (sale 14's record under an id of another form): a keyless held record.
    (capture.consolidated.sellOrders as Json[]).push({ ...(JSON.parse(JSON.stringify(listed(capture, 14))) as Json), id: 'SAMPLE ID' });
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual([12, 14].map((seed) => heldOf(output.payload, seed).map((record) => record.check)), [['payout-status'], ['sell-order-shape']]);
    assert.deepEqual(output.payload.held.filter((record) => record.key === metalsNaturalKey('collectpure', 'sell', [id(99)])).map((record) => record.check),
      ['raw-without-listing']);
    assert.deepEqual(output.payload.held.filter((record) => record.key === null && record.reason === 'unreadable').map((record) => record.check), ['sell-order-shape']);
    // Held: sales 12, 14 and 99, and the listed sale whose id doesn't read; metal: 11's eagle; flagged: 11's second line,
    // and 13's first, which alone carries its sale (held as a sale with no metal line, it would count as held); drift:
    // 13's second line.
    assert.deepEqual(output.report.census, { universe: 8, heldMetalWordLines: 4, metal: 1, flagged: 2, drift: 1, omissions: 0, omissionsByPlace: {} });
    assert.deepEqual([output.report.guard.flaggedLines, output.report.guard.heldAlsoFlaggedOrders], [2, 2]);
  });

  it('finds each line a changed payload no longer shows where its raw reading puts it, counted by place', () => {
    // Sale 11 mixed (its eagle and a flagged line); sale 13 carried by its flagged line alone, beside a drift line.
    const folder = syntheticCollectPureFolder(fromSpec((spec) => {
      sale11(spec).lines[1].name = ONE_EVIDENCE.adjacency;
      spec.sellOrders[2].lines[0].name = ONE_EVIDENCE['troy-or-metric-weight'];
      spec.sellOrders[2].lines[1].name = 'SAMPLE Gold Star Membership';
    }), null);
    const output = convertCollectPureCapture(folder);
    assertWritten(output);
    assert.deepEqual(output.report.census, { ...BASE_CENSUS, universe: 6, metal: 3, flagged: 2, drift: 1 });
    /** The census of a changed copy of the payload: its omissions, by place. */
    const censusOf = (change: (payload: MetalsImportPayload) => void) => {
      const payload = structuredClone(output.payload);
      change(payload);
      const { omissions, omissionsByPlace } = collectPureGuardCensus(folder, payload);
      return { omissions, omissionsByPlace };
    };
    const saleIn = (payload: MetalsImportPayload, seed: number) => payload.orders.find((order) => order.key === sellKey(seed))!;
    const cases: Array<[string, (payload: MetalsImportPayload) => void, { omissions: number; omissionsByPlace: Record<string, number> }]> = [
      ['nothing changed (the control)', () => {}, { omissions: 0, omissionsByPlace: {} }],
      ['the sale its flagged line alone carries is gone', (payload) => { payload.orders = payload.orders.filter((order) => order.key !== sellKey(13)); },
        { omissions: 2, omissionsByPlace: { 'drift>elsewhere': 1, 'flagged>elsewhere': 1 } }],
      ['a flag is cleared', (payload) => { saleIn(payload, 11).lines[1].metalUncertain = null; }, { omissions: 1, omissionsByPlace: { 'flagged>metal': 1 } }],
      ['a flagged line is gone', (payload) => { saleIn(payload, 11).lines.splice(1, 1); }, { omissions: 1, omissionsByPlace: { 'flagged>elsewhere': 1 } }],
      ['a metal line is gone, its skeleton line made non-metal', (payload) => {
        saleIn(payload, 11).lines.splice(0, 1);
        saleIn(payload, 11).skeleton[0].metal = false;
      }, { omissions: 1, omissionsByPlace: { 'metal>drift': 1 } }],
      ['a drift line\'s skeleton line is made metal', (payload) => { saleIn(payload, 13).skeleton[1].metal = true; },
        { omissions: 1, omissionsByPlace: { 'drift>elsewhere': 1 } }],
      ['a metal line is kept at another ordinal', (payload) => { saleIn(payload, 11).lines[0].ordinal = 1; },
        { omissions: 1, omissionsByPlace: { 'metal>elsewhere': 1 } }],
    ];
    for (const [name, change, expected] of cases) assert.deepEqual(censusOf(change), expected, name);
  });
});

describe('CollectPure converter: product refs', () => {
  const NO_REFS_WITHHELD = { absent: 0, form: 0, 'too-long': 0, 'digit-run': 0, 'card-data': 0 };
  /**
   * Sale 11's eagle line under another SKU: whether the payload passes the contract's validator, the sale's holds, its
   * stored ref, and the report's product-ref counts (by kind, then the totals). The test asserts them all itself, so a
   * ref the validator would refuse (which holds its sale) fails there, never in this helper.
   */
  const refOf = (sku: string | null) => {
    const output = convert(fromSpec((spec) => { sale11(spec).lines[0].sku = sku; }));
    return {
      valid: validateMetalsImportPayload(JSON.parse(output.json) as unknown).ok,
      held: heldOf(output.payload, 11).map((record) => record.check),
      ref: output.payload.orders.find((order) => order.key === sellKey(11))?.lines[0]?.productRef,
      productRefs: output.report.lines.productRefs,
      totals: [output.report.lines.stored.productRef, output.report.lines.withheld.productRef],
    };
  };

  it('withholds a ref exactly when the contract would refuse it, counted by kind and by the first check it fails in the validator\'s order', () => {
    const atCap = `CP-${'S'.repeat(METALS_PRODUCT_REF_MAX - 3)}`;
    assert.equal(atCap.length, METALS_PRODUCT_REF_MAX);
    // The cap bounds the catalog id (the SKU), not the wire string: the stored ref itself is longer than the cap.
    assert.ok(`collectpure:${atCap}`.length > METALS_PRODUCT_REF_MAX);
    const cases: Array<[string, string | null, keyof typeof NO_REFS_WITHHELD | null]> = [
      ['a SKU at the contract\'s own cap (METALS_PRODUCT_REF_MAX)', atCap, null],
      ['a SKU one past the cap', `${atCap}S`, 'too-long'],
      ['a SKU of another form', 'CP.SKU', 'form'],
      ['a SKU past the cap and of another form: its form is checked first', `${atCap}.`, 'form'],
      ['a run of 13 digits glued to letters', `CP${'7'.repeat(13)}X`, 'digit-run'],
      ['a SKU that could be read as card data, with no run of 13 digits', Array.from({ length: 4 }, () => '5'.repeat(4)).join('-'), 'card-data'],
      ['no SKU', null, 'absent'],
    ];
    for (const [name, sku, reason] of cases) {
      // Every emitted ref passes the contract's validator, and no SKU holds its sale: a ref the validator would refuse
      // is withheld instead. A line that states no SKU counts in neither the stored nor the withheld total.
      assert.deepEqual(refOf(sku), {
        valid: true, held: [], ref: reason === null ? `collectpure:${sku}` : null,
        productRefs: {
          metal: { stored: reason === null ? 5 : 4, withheld: reason === null ? NO_REFS_WITHHELD : { ...NO_REFS_WITHHELD, [reason]: 1 } },
          flagged: { stored: 0, withheld: NO_REFS_WITHHELD },
        },
        totals: [reason === null ? 5 : 4, reason === null || reason === 'absent' ? 0 : 1],
      }, name);
    }
  });

  it('counts a flagged line\'s product ref apart from the metal lines\'', () => {
    // Sale 11's bar renamed so that the guard flags it on adjacency alone (a synthetic name), under a SKU of each kind.
    const flaggedUnder = (sku: string) => convert(fromSpec((spec) => {
      sale11(spec).lines[1].name = 'Gold Bar Candy';
      sale11(spec).lines[1].sku = sku;
    }));
    const refAt = (output: Output) => output.payload.orders.find((order) => order.key === sellKey(11))?.lines[1]?.productRef;
    const kept = flaggedUnder('CP-FLAGGED');
    assert.deepEqual([refAt(kept), kept.report.lines.productRefs], ['collectpure:CP-FLAGGED', {
      metal: { stored: 4, withheld: NO_REFS_WITHHELD }, flagged: { stored: 1, withheld: NO_REFS_WITHHELD },
    }]);
    const withheld = flaggedUnder('CP.FLAGGED');
    assert.deepEqual([refAt(withheld), withheld.report.lines.productRefs], [null, {
      metal: { stored: 4, withheld: NO_REFS_WITHHELD }, flagged: { stored: 0, withheld: { ...NO_REFS_WITHHELD, form: 1 } },
    }]);
  });
});

describe('CollectPure converter: coverage', () => {
  const coverage = (output: Output, kind: 'sell-orders' | 'payouts') => output.report.coverage.find((entry) => entry.kind === kind)!;

  it('counts every row the capture lists as seen, held or not', () => {
    const capture = syntheticCollectPureSales();
    capture.rawSellOrders = capture.rawSellOrders.filter((file) => file.id !== id(11));
    const output = convert(capture);
    assert.deepEqual(coverage(output, 'sell-orders'), { ...coverage(output, 'sell-orders'), stated: 4, seen: 4, complete: true });
  });

  it('knows no sell-orders total when the site\'s statements disagree or are missing', () => {
    const disagree = syntheticCollectPureSales();
    at(disagree.stats[0].json, 'result', 'data', 'json').total = 5;
    const listTotal = syntheticCollectPureSales();
    at(listTotal.consolidated, 'provenance', 'pages', 0).statedTotal = 5;
    const missing = syntheticCollectPureSales();
    missing.stats = missing.stats.filter((file) => file.name !== 'sell-stats.json');
    const noPage = syntheticCollectPureSales();
    at(noPage.consolidated, 'provenance', 'pages', 0).path = '/dashboard/somewhere-new';
    for (const [capture, gap] of [[disagree, 'stated-totals-disagree'], [listTotal, 'stated-totals-disagree'], [missing, 'sell-stats-missing'],
      [noPage, 'sell-orders-page-missing']] as const) {
      const output = convert(capture);
      assertWritten(output);
      assert.deepEqual(coverage(output, 'sell-orders'), { ...coverage(output, 'sell-orders'), stated: null, seen: 4, complete: false, statedUnknownBecause: gap });
    }
  });

  it('counts payouts to the pager\'s end only when the pages run unbroken to a last page', () => {
    const lastHasNext = syntheticCollectPureSales();
    at(lastHasNext.payoutHistoryPages[1].json, 'result', 'data', 'json').nextCursor = 9_100;
    const gapInPages = syntheticCollectPureSales();
    gapInPages.payoutHistoryPages[1].name = 'payout-history-p03.json';
    const repeated = syntheticCollectPureSales();
    (at(repeated.payoutHistoryPages[1].json, 'result', 'data', 'json').items as Json[])[0].id = syntheticPayoutId(11, 0);
    const provenance = syntheticCollectPureSales();
    at(provenance.consolidated, 'provenance', 'pages', 2).rowsSeen = 5;
    const pageTotal = syntheticCollectPureSales();
    at(pageTotal.consolidated, 'provenance', 'pages', 2).statedTotal = 3;
    const none = syntheticCollectPureSales();
    none.payoutHistoryPages = [];
    for (const [capture, gap] of [[lastHasNext, 'pager-incomplete'], [gapInPages, 'pager-incomplete'], [repeated, 'payout-ids-repeat'],
      [provenance, 'pager-provenance-disagrees'], [pageTotal, 'pager-provenance-disagrees'], [none, 'payout-pages-missing']] as const) {
      const output = convert(capture);
      assertWritten(output);
      assert.deepEqual(coverage(output, 'payouts'), { ...coverage(output, 'payouts'), stated: null, seen: 2, complete: false, statedUnknownBecause: gap }, gap);
      assert.match(coverage(output, 'payouts').statedBasis, /rows read to the pager's end/);
    }
    // Without the pages, no payout can be confirmed: each paid sale is held.
    const output = convert(none);
    assert.deepEqual([11, 12].map((seed) => heldOf(output.payload, seed).map((record) => record.check)), [['payout-history'], ['payout-history']]);
  });

  it('keeps the rows read to the pager\'s end when the payouts page states the same total', () => {
    const capture = syntheticCollectPureSales();
    at(capture.consolidated, 'provenance', 'pages', 2).statedTotal = 2;
    const output = convert(capture);
    assertWritten(output);
    assert.deepEqual(coverage(output, 'payouts'), { ...coverage(output, 'payouts'), stated: 2, seen: 2, complete: true, statedUnknownBecause: null });
    assert.match(coverage(output, 'payouts').statedBasis, /rows read to the pager's end/);
  });
});

describe('CollectPure converter: refusals', () => {
  function refused(run: () => unknown, code: string, where: string | null): void {
    let caught: MetalsConvertError | null = null;
    try {
      run();
    } catch (error) {
      // Only the converter's own refusal is taken, with its code; anything else fails the test as it is.
      if (!(error instanceof MetalsConvertError)) throw error;
      caught = error;
    }
    assert.ok(caught !== null, `expected a refusal ${code}`);
    assert.deepEqual([caught.code, caught.at], [code, where]);
    for (const value of [...syntheticCollectPureSalesSecrets(), ...syntheticCollectPureSalesPayloadValues()]) {
      assert.ok(!caught.message.includes(value), `the refusal shows ${value}`);
    }
  }
  const filesWith = (change: (files: MetalsCaptureFile[], capture: SyntheticCollectPureCapture) => void) => {
    const capture = syntheticCollectPureSales();
    const files = syntheticCollectPureFiles(capture);
    change(files, capture);
    return files;
  };
  const bytes = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));

  it('refuses a folder that isn\'t a CollectPure account or snapshot', () => {
    const files = syntheticCollectPureFiles(syntheticCollectPureSales());
    refused(() => convertCollectPureCapture({ folder: 'walmart', snapshot: null, files, converterVersion: METALS_CONVERTER }), 'folder-unsupported', 'folder');
    refused(() => convertFiles(files, 'snapshot-1'), 'folder-unsupported', 'snapshot');
  });

  it('refuses a consolidated file it can\'t read, of another schema, or with a problem outside one sale', () => {
    refused(() => convertFiles(filesWith((files) => { files[0].bytes = new TextEncoder().encode('{"schema":'); })), 'capture-unreadable', '$');
    refused(() => convertFiles(filesWith((files, capture) => {
      capture.consolidated.schema = 'holdr-retail-capture/collectpure@2';
      files[0].bytes = bytes(capture.consolidated);
    })), 'schema-unsupported', '$.schema');
    refused(() => convertFiles(filesWith((files, capture) => {
      at(capture.consolidated, 'provenance').source = 'example.com';
      files[0].bytes = bytes(capture.consolidated);
    })), 'capture-unreadable', '$.provenance.source');
  });

  it('refuses payout-history pages and stats files it can\'t read', () => {
    refused(() => convertFiles(filesWith((files) => {
      files.find((file) => file.path === 'raw/payout-history-p02.json')!.bytes = new TextEncoder().encode('[');
    })), 'payout-history-unreadable', '$');
    refused(() => convertFiles(filesWith((files, capture) => {
      at(capture.payoutHistoryPages[0].json, 'result', 'data', 'json', 'items', 0).amount = 1.5;
      files.find((file) => file.path === 'raw/payout-history-p01.json')!.bytes = bytes(capture.payoutHistoryPages[0].json);
    })), 'payout-history-unreadable', '$.result.data.json.items[0].amount');
    refused(() => convertFiles(filesWith((files, capture) => {
      at(capture.stats[2].json, 'result', 'data', 'json').totalCount = -1;
      files.find((file) => file.path === 'raw/inventory-stats.json')!.bytes = bytes(capture.stats[2].json);
    })), 'stats-unreadable', '$.result.data.json.totalCount');
    // A stats file that holds JSON null is there: it can't be read, and is never taken for a missing one.
    for (const name of ['sell-stats.json', 'buy-stats.json', 'inventory-stats.json']) {
      refused(() => convertFiles(filesWith((files) => {
        files.find((file) => file.path === `raw/${name}`)!.bytes = bytes(null);
      })), 'stats-unreadable', '$');
    }
  });

  it('refuses files outside its layout, a path given twice, and a folder without collectpure.json', () => {
    refused(() => convertFiles(filesWith((files) => { files.push({ path: 'raw/listings-offers.counts.json', bytes: bytes({}) }); })), 'capture-layout', 'files[10]');
    refused(() => convertFiles(filesWith((files) => { files.push({ ...files[1] }); })), 'capture-layout', 'files[10]');
    refused(() => convertFiles(filesWith((files) => { files.shift(); })), 'capture-layout', 'files');
  });

  it('refuses, before making them, more held records than a payload can hold', () => {
    refused(() => convertFiles(filesWith((files, capture) => {
      at(capture.consolidated, 'buyOrders').statedTotal = 20_001;
      files[0].bytes = bytes(capture.consolidated);
    })), 'held-unrepresentable', null);
  });
});

describe('CollectPure converter: snapshots and the CLI registry', () => {
  it('converts a nested snapshot on its own, in the snapshot\'s file form, under its account folder', () => {
    const base = convert(syntheticCollectPureSales());
    const snapshot = convert(syntheticCollectPureCapture({ ...syntheticCollectPureSalesSpec(), snapshot: true }), 'snap20261108');
    assertWritten(snapshot);
    assert.equal(snapshot.payload.account.folder, 'collectpure');
    assert.equal(snapshot.report.snapshot, true);
    assert.deepEqual(snapshot.payload.orders, base.payload.orders);
    assert.deepEqual(snapshot.payload.coverage, base.payload.coverage);
  });

  it('converts a base capture without the keys only a snapshot states, and refuses a snapshot without them, as before', () => {
    const base = syntheticCollectPureSales();
    for (const key of ['snapshotFolder', 'detailsReusedFromOct24Capture']) assert.equal(key in at(base.consolidated, 'provenance'), false, key);
    assertWritten(convert(base));
    // A base capture that states them anyway is still converted.
    assertWritten(convert(syntheticCollectPureCapture({ ...syntheticCollectPureSalesSpec(), snapshot: true })));
    assert.deepEqual(refusalOf(() => convert(syntheticCollectPureSales(), 'snap20261108')), { code: 'capture-unreadable', at: '$.provenance.snapshotFolder' });
  });

  it('names its account and snapshot folders and reads only its layout\'s files', () => {
    assert.equal(COLLECTPURE_METALS_CONVERTER.input, 'capture-folder');
    assert.equal(COLLECTPURE_METALS_CONVERTER.source, 'collectpure');
    assert.equal(COLLECTPURE_METALS_CONVERTER.convert, convertCollectPureCapture);
    const folder = COLLECTPURE_METALS_CONVERTER.folder;
    assert.deepEqual(['collectpure', 'collectpure-2', 'collectpure-999'].map((name) => folder.test(name)), [true, true, true]);
    assert.deepEqual(['collectpure-0', 'collectpure-1000', 'Collectpure', 'walmart', 'snap20261108'].map((name) => folder.test(name)), [false, false, false, false, false]);
    const snapshot = COLLECTPURE_METALS_CONVERTER.snapshot!;
    assert.deepEqual(['snap20261108', 'snap2026110', 'snapshot', 'collectpure'].map((name) => snapshot.test(name)), [true, false, false, false]);
    const reads = (dir: string, name: string) => COLLECTPURE_CAPTURE_LAYOUT.some((entry) => entry.dir === dir && entry.name.test(name));
    for (const [dir, name] of [['', 'collectpure.json'], ['raw', `sell-order-${id(11)}.json`], ['raw', 'payout-history-p01.json'], ['raw', 'sell-stats.json'],
      ['raw', 'buy-stats.json'], ['raw', 'inventory-stats.json']]) {
      assert.ok(reads(dir, name), name);
    }
    for (const [dir, name] of [['raw', 'sell-orders-offset0.json'], ['raw', 'payout-and-payment-methods.sanitized.json'], ['raw', 'vault.json'],
      ['raw', 'listings-offers.counts.json'], ['raw', 'buy-orders-offset0.json'], ['', 'manifest.private.json'], ['raw', 'collectpure.json']]) {
      assert.ok(!reads(dir, name), name);
    }
    assert.deepEqual(COLLECTPURE_CAPTURE_LAYOUT.map((entry) => entry.required), [true, false, false, false]);
  });
});
describe('CollectPure converter: the stated spot premium', () => {
  const PREMIUM = /^spot [+-]\d{1,3}\.\d{4}% \/ [+-]\$\d{1,3}(?:,\d{3})*\.\d{2} per (?:troy ounce|unit)$/;
  const premiumOfLine = (change: (line: SyntheticCollectPureSpec['sellOrders'][number]['lines'][number]) => void) => {
    const output = convert(fromSpec((spec) => change(sale11(spec).lines[0])));
    assertWritten(output);
    return {
      premium: saleOf(output.payload, 11).lines[0].sale!.premium, withheld: output.report.lines.withheld.premium, kept: output.report.lines.stored.premium,
    };
  };

  it('stores one closed form: the stated percent to four decimals and the stated dollars on the basis', () => {
    const { payload } = convert(syntheticCollectPureSales());
    const premiums = payload.orders.flatMap((order) => order.lines).map((line) => line.sale!.premium).filter((premium) => premium !== null);
    assert.deepEqual(premiums.map((premium) => premium!.text).sort(), [
      'spot +0.9877% / +$26.42 per troy ounce', 'spot +2.2500% / +$58.97 per troy ounce', 'spot +3.0123% / +$0.93 per unit',
      'spot -1.5000% / -$40.13 per troy ounce',
    ]);
    for (const premium of premiums) {
      assert.match(premium!.text, PREMIUM);
      assert.equal(premium!.text.endsWith(premium!.basis === 'troy_ounce' ? 'per troy ounce' : 'per unit'), true);
    }
    assert.deepEqual(premiumOfLine((line) => { line.spotPremium = 0; line.spotPremiumDollar = 0; }).premium,
      { text: 'spot +0.0000% / +$0.00 per troy ounce', basis: 'troy_ounce' });
    assert.deepEqual(premiumOfLine((line) => { line.spotPremium = 12.5; line.spotPremiumDollar = 123_456_789; }).premium,
      { text: 'spot +12.5000% / +$1,234,567.89 per troy ounce', basis: 'troy_ounce' });
    assert.deepEqual(premiumOfLine((line) => { line.spotPremium = 999.9999; line.spotPremiumDollar = 2_650_130; }).premium,
      { text: 'spot +999.9999% / +$26,501.30 per troy ounce', basis: 'troy_ounce' });
  });

  it('withholds a premium it can\'t state in that form, and counts it', () => {
    const cases: Array<[string, (line: SyntheticCollectPureSpec['sellOrders'][number]['lines'][number]) => void]> = [
      ['a percent stated as text', (line) => { line.spotPremium = '2.5'; }],
      ['a percent and dollars of opposite signs', (line) => { line.spotPremium = -1.25; line.spotPremiumDollar = 500; }],
      ['a percent with no dollars', (line) => { line.spotPremiumDollar = null; }],
      ['dollars with no percent', (line) => { line.spotPremium = null; }],
      ['no basis', (line) => { line.premium = null; }],
      ['a percent too large to be a premium', (line) => { line.spotPremium = 1_000; line.spotPremiumDollar = 2_650_130; }],
      ['a percent that rounds to 1,000', (line) => { line.spotPremium = 999.99999; line.spotPremiumDollar = 2_650_130; }],
      ['a negative percent that rounds to 1,000', (line) => { line.spotPremium = -999.99999; line.spotPremiumDollar = -2_650_130; }],
    ];
    for (const [name, change] of cases) assert.deepEqual(premiumOfLine(change), { premium: null, withheld: 1, kept: 3 }, name);
    assert.deepEqual(premiumOfLine((line) => { line.spotPremium = null; line.spotPremiumDollar = null; }), { premium: null, withheld: 0, kept: 3 });
  });
});
