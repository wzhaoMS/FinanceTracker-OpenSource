import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { retailMetalPack } from '../../retailImportTool/metalPackRule.js';
import { retailMetalTitleEvidence, retailMetalTitleGuard } from '../../retailImportTool/metalTitleRule.js';
import { syntheticCollectPureCapture } from '../captures/__fixtures__/collectpureCapture.js';
import { METALS_TITLE_MAX, metalsNaturalKey, validateMetalsImportPayload, type MetalsImportPayload, type MetalsLine } from '../payload.js';
import { convertCollectPureCapture } from './collectpure.js';
import { METALS_CONVERTER, MetalsConvertError } from './common.js';
import { convertCostcoRetailPayload } from './costco.js';
import { convertWalmartCapture } from './walmart.js';
import { syntheticCollectPureFolder, syntheticCollectPureSalesSpec } from './__fixtures__/collectpureConvert.js';
import { metalOf, onlineOrder, retailBytes, retailPayload, warehouseReceipt } from './__fixtures__/costcoRetailPayloads.js';
import {
  syntheticWalmartCaptureFolder, syntheticWalmartFolder, syntheticWalmartGroup, syntheticWalmartMetalsSpec, syntheticWalmartOrderId,
} from './__fixtures__/walmart.js';

/**
 * Contract follow-up 1E: the validator refuses a line stored unflagged whose STORED title the pinned title guard reads as
 * metal-uncertain (payload.ts). Every converter withholds such a title (reason `metal-guard`), so the check never fires
 * on a converter's own output. One synthetic case per source and channel: the raw name reads as gold, its stored text
 * doesn't, and the payload is valid with the line's title withheld and its raw reading kept.
 */

/** A bar of gold, then filler the rules read nothing in, to exactly the stored title's length. */
const HEAD = `Sample Refinery Gold Bar${' Gift Edition'.repeat(16)} Display`;
/** The raw name: its weight falls just past the cut, so its stored text is HEAD. */
const CUT = `${HEAD} 1 oz`;
/** A warehouse line's two printed lines, joined longer than a stored title: the stored title falls back to the first. */
const PART_1 = `SAMPLE GOLD BAR${' GIFT EDITION'.repeat(10)}`;
const PART_2 = `1 OZ${' GIFT EDITION'.repeat(8)}`;

/** 1E's check as a converter's own last check reports it: converter-invalid at an unflagged line's metalUncertain. */
const TITLE_GUARD_REFUSAL = /^converter-invalid at \$\.orders\[\d+\]\.lines\[\d+\]\.metalUncertain$/;
/** 1E's check as the validator words it (payload.ts). */
const TITLE_GUARD_ISSUE = 'is null, but the pinned title guard reads the stored title as metal-uncertain';

/** A converter's output: its payload, and its report as the converter wrote it. */
interface Output {
  payload: MetalsImportPayload;
  report: unknown;
}

/** The lines of a source's payload whose product ref is this one (each test asserts there is exactly one). */
const linesOf = (payload: MetalsImportPayload, productRef: string): MetalsLine[] =>
  payload.orders.flatMap((order) => order.lines).filter((line) => line.productRef === productRef);

/**
 * The conversion, or its converter-invalid refusal as data, its code and path kept: the refusal a converter that didn't
 * withhold such a title meets in its own last check. Every other error is re-thrown unchanged (ROOT's kill standard,
 * addendum 3(e)), so it fails its test as itself, never as an assertion.
 */
function converted(run: () => Output): { output: Output; refused: null } | { output: null; refused: string } {
  try {
    return { output: run(), refused: null };
  } catch (error) {
    if (error instanceof MetalsConvertError && error.code === 'converter-invalid') return { output: null, refused: `${error.code} at ${error.at}` };
    throw error;
  }
}

function walmart(): Output {
  const spec = syntheticWalmartMetalsSpec();
  const orders = spec.orders.map((order) => (order.seed === 11 ? { ...order, groups: [syntheticWalmartGroup(1, CUT, 1, 250_000)] } : order));
  return convertWalmartCapture(syntheticWalmartCaptureFolder(syntheticWalmartFolder({ orders })));
}

function collectpure(): Output {
  const spec = syntheticCollectPureSalesSpec();
  spec.sellOrders[0].lines[0] = { ...spec.sellOrders[0].lines[0], name: CUT, sku: 'CP-GUARD-CUT' };
  return convertCollectPureCapture(syntheticCollectPureFolder(syntheticCollectPureCapture(spec)));
}

function costco(receipt: ReturnType<typeof onlineOrder>): Output {
  return convertCostcoRetailPayload({ bytes: retailBytes(retailPayload({ format: 3, receipts: [receipt] })), converterVersion: METALS_CONVERTER });
}

/** An online line as the retail tool stores it: its title cut to HEAD, its metal read on the raw name. */
const costcoOnline = () => costco(onlineOrder({
  id: 'gc', date: '2030-03-01',
  lines: [{
    id: '1', title: HEAD, itemNumber: '300001', quantity: 1, unitPrice: 250_000, metal: metalOf(CUT),
    shipments: [{ shipped: '2030-03-03', delivered: '2030-03-05' }], events: { shipped: [[1, '2030-03-03']], delivered: [[1, '2030-03-05']] },
  }],
}));

/** A warehouse line whose two printed lines join longer than a stored title: the converter keeps the first alone. */
const costcoWarehouse = () => costco(warehouseReceipt({
  id: 'wc', date: '2030-03-02',
  lines: [{ title: PART_1, title2: PART_2, itemNumber: '300002', quantity: 1, unitPrice: 250_000, amount: 250_000, metal: metalOf(`${PART_1} ${PART_2}`) }],
  tenders: [{ kind: 'card', amount: 250_000 }],
}));

/**
 * A source's conversion as data, for its test to assert on: the converter's refusal (only converter-invalid is caught;
 * anything else is re-thrown), the validator's issues with its payload, CollectPure's issues for sales it held as
 * payload-contract, and the lines of the case.
 */
function observe(convert: () => Output, find: (payload: MetalsImportPayload) => MetalsLine[]) {
  const result = converted(convert);
  if (result.output === null) return { refused: result.refused, issues: [] as unknown[], contractIssues: [] as Array<{ path: string; message: string }>, lines: [] as MetalsLine[] };
  const checked = validateMetalsImportPayload(JSON.parse(JSON.stringify(result.output.payload)));
  const report = result.output.report as { contractIssues?: Array<{ path: string; message: string }> };
  return { refused: null, issues: checked.ok ? [] : checked.issues as unknown[], contractIssues: report.contractIssues ?? [], lines: find(result.output.payload) };
}

/** The order's lines as converted (none when the order isn't converted). */
const walmartLines = (payload: MetalsImportPayload): MetalsLine[] =>
  payload.orders.find((entry) => entry.key === metalsNaturalKey('walmart', 'order', [syntheticWalmartOrderId(11)]))?.lines ?? [];
const GOLD_BAR_OUNCE = ['XAU', 'bar', { value: '1', unit: 'oz' }];

describe('every converter withholds a stored title the validator\'s title guard check refuses (contract follow-up 1E, synthetic)', () => {
  it('reads each raw name as a gold bar of one ounce, and each stored text as metal-uncertain', () => {
    assert.equal(HEAD.length, METALS_TITLE_MAX);
    assert.ok(`${PART_1} ${PART_2}`.length > METALS_TITLE_MAX);
    for (const [raw, stored] of [[CUT, HEAD], [`${PART_1} ${PART_2}`, PART_1]]) {
      const reading = retailMetalTitleEvidence(raw);
      assert.deepEqual([reading?.metal, reading?.form, reading?.statedWeight], ['XAU', 'bar', { value: '1', unit: 'oz' }]);
      assert.equal(retailMetalPack(raw), 'single');
      assert.equal(retailMetalTitleEvidence(stored), null);
      assert.equal(retailMetalTitleGuard(stored, { assessed: true }).uncertain, true);
    }
  });

  it('walmart: converts it, valid, with the title withheld and the raw reading kept', () => {
    const seen = observe(walmart, walmartLines);
    // First, the one outcome a converter that didn't withhold the title meets: 1E's check refusing its run.
    assert.doesNotMatch(seen.refused ?? '', TITLE_GUARD_REFUSAL);
    assert.equal(seen.refused, null);
    assert.deepEqual(seen.issues, []);
    assert.equal(seen.lines.length, 1);
    assert.deepEqual([seen.lines[0].title, seen.lines[0].metalUncertain], [null, null]);
    assert.deepEqual([seen.lines[0].metal, seen.lines[0].form, seen.lines[0].statedMass], GOLD_BAR_OUNCE);
  });

  it('collectpure: converts it, valid, with the title withheld and the raw reading kept', () => {
    const seen = observe(collectpure, (payload) => linesOf(payload, 'collectpure:CP-GUARD-CUT'));
    // First, the one outcome a converter that didn't withhold the title meets: the sale held for 1E's check.
    assert.deepEqual(seen.contractIssues.filter((issue) => issue.message === TITLE_GUARD_ISSUE), []);
    assert.deepEqual(seen.contractIssues, []);
    assert.equal(seen.refused, null);
    assert.deepEqual(seen.issues, []);
    assert.equal(seen.lines.length, 1);
    assert.deepEqual([seen.lines[0].title, seen.lines[0].metalUncertain], [null, null]);
    assert.deepEqual([seen.lines[0].metal, seen.lines[0].form, seen.lines[0].statedMass], GOLD_BAR_OUNCE);
  });

  it('costco online: converts it, valid, with the title withheld and the raw reading kept', () => {
    const seen = observe(costcoOnline, (payload) => linesOf(payload, 'costco:300001'));
    assert.doesNotMatch(seen.refused ?? '', TITLE_GUARD_REFUSAL);
    assert.equal(seen.refused, null);
    assert.deepEqual(seen.issues, []);
    assert.equal(seen.lines.length, 1);
    assert.deepEqual([seen.lines[0].title, seen.lines[0].metalUncertain], [null, null]);
    assert.deepEqual([seen.lines[0].metal, seen.lines[0].form, seen.lines[0].statedMass], GOLD_BAR_OUNCE);
  });

  it('costco warehouse: converts it, valid, with the title withheld and the raw reading kept', () => {
    const seen = observe(costcoWarehouse, (payload) => linesOf(payload, 'costco:300002'));
    assert.doesNotMatch(seen.refused ?? '', TITLE_GUARD_REFUSAL);
    assert.equal(seen.refused, null);
    assert.deepEqual(seen.issues, []);
    assert.equal(seen.lines.length, 1);
    assert.deepEqual([seen.lines[0].title, seen.lines[0].metalUncertain], [null, null]);
    assert.deepEqual([seen.lines[0].metal, seen.lines[0].form, seen.lines[0].statedMass], GOLD_BAR_OUNCE);
  });
});