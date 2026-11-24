import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETAIL_API_CARD_TENDER_KINDS,
  RETAIL_API_CARRIERS,
  RETAIL_API_CATEGORY_LINE_KINDS,
  RETAIL_API_CATEGORY_SOURCES,
  RETAIL_API_CHANNELS,
  RETAIL_API_CONFLICTS,
  RETAIL_API_COVERAGE_CHANNELS,
  RETAIL_API_DEFERRED,
  RETAIL_API_FORMATS,
  RETAIL_API_FULFILMENTS,
  RETAIL_API_KEYS,
  RETAIL_API_LINE_EVENT_KINDS,
  RETAIL_API_LINE_KINDS,
  RETAIL_API_METAL_FORMS,
  RETAIL_API_METAL_GUARD_EVIDENCE,
  RETAIL_API_METAL_PACKS,
  RETAIL_API_METALS,
  RETAIL_API_NETWORKS,
  RETAIL_API_ONLINE_STATUSES,
  RETAIL_API_PAGE,
  RETAIL_API_QUERY,
  RETAIL_API_REFUSALS,
  RETAIL_API_SEARCH,
  RETAIL_API_SIGNS,
  RETAIL_API_STATES,
  RETAIL_API_STORED_VALUE_KINDS,
  RETAIL_API_TENDER_KINDS,
  RETAIL_API_VERSIONS,
  RETAIL_API_WEIGHT_UNITS,
  type RetailApiAbsent,
  type RetailApiCapture,
  type RetailApiCaptureRange,
  type RetailApiChannelCounts,
  type RetailApiFuel,
  type RetailApiKeyList,
  type RetailApiLine,
  type RetailApiLineCategory,
  type RetailApiLineCategorySuggestion,
  type RetailApiLineEvent,
  type RetailApiLineEvents,
  type RetailApiLineMetal,
  type RetailApiLineMetalUncertain,
  type RetailApiMatchingLine,
  type RetailApiReceiptDetail,
  type RetailApiReceiptPresent,
  type RetailApiReceiptRow,
  type RetailApiReceiptsPresent,
  type RetailApiRefusalBody,
  type RetailApiRowTenders,
  type RetailApiShipment,
  type RetailApiSummaryMembership,
  type RetailApiSummaryPresent,
  type RetailApiTaxLegend,
  type RetailApiTender,
  type RetailApiTotals,
} from './retailApi.js';
import {
  RETAIL_CARD_TENDER_KINDS,
  RETAIL_CARRIERS,
  RETAIL_CHANNELS,
  RETAIL_FULFILMENTS,
  RETAIL_LINE_KINDS,
  RETAIL_METAL_FORMS,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_PACKS,
  RETAIL_METALS,
  RETAIL_NETWORKS,
  RETAIL_ONLINE_STATUSES,
  RETAIL_SIGNS,
  RETAIL_STORED_VALUE_KINDS,
  RETAIL_TENDER_KINDS,
  RETAIL_WEIGHT_UNITS,
} from './retailImportTool/payload.js';

// The Costco receipts read API's contract (the summary and list at v1, the detail at v2), pinned literally (PR 5 §11's
// discipline): a change to a format, a bound or a key list is a new version, made on purpose, never a drift.

describe('the retail read API contract', () => {
  it('pins its formats, versions, states, refusal reasons, query names and page bounds', () => {
    assert.deepEqual({ ...RETAIL_API_FORMATS }, {
      summary: 'holdr.retail-costco-summary', receipts: 'holdr.retail-costco-receipts', receipt: 'holdr.retail-costco-receipt',
    });
    assert.deepEqual({ ...RETAIL_API_VERSIONS }, { summary: 1, receipts: 1, receipt: 2 });
    assert.deepEqual(RETAIL_API_STATES, ['absent', 'present']);
    assert.deepEqual(RETAIL_API_CONFLICTS, ['schema-conflict', 'retail-reserved-value']);
    assert.deepEqual({ ...RETAIL_API_QUERY }, { summary: [], receipts: ['membership', 'channel', 'offset', 'limit', 'q', 'category'], receipt: [] });
    assert.deepEqual({ ...RETAIL_API_SEARCH }, { maxLength: 100 });
    assert.deepEqual({ ...RETAIL_API_PAGE }, { defaultLimit: 50, maxLimit: 100, maxOffset: 1_000_000 });
    assert.deepEqual(RETAIL_API_COVERAGE_CHANNELS, ['online', 'warehouse']);
    assert.deepEqual(RETAIL_API_DEFERRED.routes, ['GET /retail/costco/spending/taxonomy']);
    // Every refusal the API owns (PR 5 v3 §3.7): its status, reason and fixed messages; the 409s are RETAIL_API_CONFLICTS.
    assert.deepEqual(JSON.parse(JSON.stringify(RETAIL_API_REFUSALS)), {
      'query-invalid': { status: 400, messages: ['unexpected query parameter', 'membership must be given once', 'channel must be given once',
        'offset must be given once', 'limit must be given once', 'q must be given once', 'category must be given once', 'invalid membership',
        'channel must be a comma-separated list of warehouse, gas, online', 'invalid pagination', 'q must be at most 100 characters',
        'q must not contain control characters'] },
      'category-unknown': { status: 400, messages: ['unknown category'] },
      'receipt-not-found': { status: 404, messages: ['retail receipt not found'] },
      'membership-not-found': { status: 404, messages: ['retail membership not found'] },
      'schema-conflict': { status: 409, messages: ['the retail tables on this Holdr have another shape; nothing was read'] },
      'retail-reserved-value': { status: 409, messages: ['the retail tables on this Holdr hold a value reserved for a later rule; nothing was read'] },
    });
    assert.deepEqual(Object.entries(RETAIL_API_REFUSALS).filter(([, refusal]) => refusal.status === 409).map(([reason]) => reason),
      [...RETAIL_API_CONFLICTS]);
  });

  it('pins every body key list', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(RETAIL_API_KEYS)), {
      absent: ['format', 'version', 'state'],
      summary: ['format', 'version', 'state', 'memberships', 'receipts', 'quarantine', 'held'],
      summaryMembership: ['membershipRef', 'label', 'owner', 'receipts', 'capture'],
      channelCounts: ['active', 'quarantined'],
      capture: ['ranges', 'capturedThrough'],
      captureRange: ['channel', 'from', 'to'],
      receipts: ['format', 'version', 'state', 'total', 'offset', 'limit', 'receipts'],
      receiptRow: ['receiptRef', 'channel', 'sign', 'status', 'date', 'currency', 'totalMinor', 'itemLines', 'memberships', 'state',
        'quarantineReason', 'tenders', 'matchingLines'],
      rowTenders: ['kinds', 'cardSpendingMinor', 'otherMinor'],
      matchingLine: ['lineRef', 'kind', 'itemNumber', 'title', 'title2', 'quantity', 'amountMinor'],
      receipt: ['format', 'version', 'state', 'receipt'],
      receiptDetail: ['receiptRef', 'channel', 'state', 'quarantineReason', 'memberships', 'date', 'localTime', 'sign', 'status', 'currency',
        'totals', 'taxLegends', 'lines', 'tenders'],
      totals: ['subtotalMinor', 'taxMinor', 'instantSavingsMinor', 'discountMinor', 'shippingMinor', 'feesMinor', 'storedValueMinor', 'totalMinor'],
      taxLegend: ['legend', 'amountMinor'],
      line: ['lineRef', 'kind', 'itemNumber', 'title', 'title2', 'quantity', 'unitPriceMinor', 'amountMinor', 'shippingMinor', 'taxFlag',
        'storedValue', 'fulfilment', 'fuel', 'couponFor', 'feeOf', 'metal', 'metalUncertain', 'events', 'shipments', 'category'],
      lineCategory: ['node', 'cardCategory', 'source', 'confidenceBp', 'suggested', 'suggestion', 'metalHold'],
      lineCategorySuggestion: ['node', 'confidenceBp'],
      fuel: ['gallons', 'unitPrice'],
      metal: ['metal', 'form', 'statedWeight', 'pack', 'rule'],
      statedWeight: ['value', 'unit'],
      metalUncertain: ['guard', 'evidence', 'metal'],
      events: ['shipped', 'delivered', 'cancelled', 'returned'],
      event: ['quantity', 'date'],
      shipment: ['shipmentRef', 'shippedDate', 'deliveredDate', 'estimatedArrivalDate', 'carrier'],
      tender: ['kind', 'network', 'last4', 'amountMinor', 'cardSpending'],
      refusal: ['error', 'reason'],
    });
  });

  it('keeps every key list exactly its type\'s keys (checked by the compiler, both ways), each key once', () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    type Of<K extends RetailApiKeyList> = (typeof RETAIL_API_KEYS)[K][number];
    // Each pin compiles only while its list holds exactly its type's keys: no key missing, none extra.
    const exact: [
      Same<keyof RetailApiAbsent, Of<'absent'>>,
      Same<keyof RetailApiSummaryPresent, Of<'summary'>>,
      Same<keyof RetailApiSummaryMembership, Of<'summaryMembership'>>,
      Same<keyof RetailApiChannelCounts, Of<'channelCounts'>>,
      Same<keyof RetailApiCapture, Of<'capture'>>,
      Same<keyof RetailApiCaptureRange, Of<'captureRange'>>,
      Same<keyof RetailApiReceiptsPresent, Of<'receipts'>>,
      Same<keyof RetailApiReceiptRow, Of<'receiptRow'>>,
      Same<keyof RetailApiRowTenders, Of<'rowTenders'>>,
      Same<keyof RetailApiMatchingLine, Of<'matchingLine'>>,
      Same<keyof RetailApiReceiptPresent, Of<'receipt'>>,
      Same<keyof RetailApiReceiptDetail, Of<'receiptDetail'>>,
      Same<keyof RetailApiTotals, Of<'totals'>>,
      Same<keyof RetailApiTaxLegend, Of<'taxLegend'>>,
      Same<keyof RetailApiLine, Of<'line'>>,
      Same<keyof RetailApiLineCategory, Of<'lineCategory'>>,
      Same<keyof RetailApiLineCategorySuggestion, Of<'lineCategorySuggestion'>>,
      Same<keyof RetailApiFuel, Of<'fuel'>>,
      Same<keyof RetailApiLineMetal, Of<'metal'>>,
      Same<keyof NonNullable<RetailApiLineMetal['statedWeight']>, Of<'statedWeight'>>,
      Same<keyof RetailApiLineMetalUncertain, Of<'metalUncertain'>>,
      Same<keyof RetailApiLineEvents, Of<'events'>>,
      Same<keyof RetailApiLineEvent, Of<'event'>>,
      Same<keyof RetailApiShipment, Of<'shipment'>>,
      Same<keyof RetailApiTender, Of<'tender'>>,
      Same<keyof RetailApiRefusalBody, Of<'refusal'>>,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true,
      true, true];
    assert.ok(exact.every((pinned) => pinned));
    // Every list is pinned above (a new one must be added there), and none repeats a key.
    assert.deepEqual(Object.keys(RETAIL_API_KEYS), ['absent', 'summary', 'summaryMembership', 'channelCounts', 'capture', 'captureRange', 'receipts',
      'receiptRow', 'rowTenders', 'matchingLine', 'receipt', 'receiptDetail', 'totals', 'taxLegend', 'line', 'lineCategory', 'lineCategorySuggestion', 'fuel',
      'metal', 'statedWeight', 'metalUncertain',
      'events', 'event', 'shipment', 'tender', 'refusal']);
    for (const [name, keys] of Object.entries(RETAIL_API_KEYS)) assert.equal(new Set<string>(keys).size, keys.length, name);
  });

  it('carries none of the fields deferred to PR 5 in any key list of its route', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(RETAIL_API_DEFERRED)), {
      receipts: ['match', 'assetHold'],
      receipt: ['match', 'assetHold', 'quarantine', 'subjects', 'returns', 'tenders[].subjects', 'tenders[].link'],
      summary: ['matches', 'returns', 'rows', 'assetHolds', 'taxonomy'],
      routes: ['GET /retail/costco/spending/taxonomy'],
    });
    // Each route's deferred names against that route's own lists (the summary's own `quarantine` counts are v1's, D-384).
    const lists: Record<'receipts' | 'receipt' | 'summary', readonly RetailApiKeyList[]> = {
      receipts: ['receipts', 'receiptRow', 'rowTenders', 'matchingLine'],
      receipt: ['receipt', 'receiptDetail', 'totals', 'taxLegend', 'line', 'lineCategory', 'lineCategorySuggestion', 'fuel', 'metal', 'statedWeight',
        'metalUncertain', 'events', 'event', 'shipment', 'tender'],
      summary: ['summary', 'summaryMembership', 'channelCounts', 'capture', 'captureRange'],
    };
    for (const route of ['receipts', 'receipt', 'summary'] as const) {
      const v1 = new Set<string>(lists[route].flatMap((name) => [...RETAIL_API_KEYS[name]]));
      const deferred = RETAIL_API_DEFERRED[route].map((name) => name.split('.').at(-1)!.replace('[]', ''));
      assert.deepEqual(deferred.filter((name) => v1.has(name)), [], route);
    }
    // A-384-1: the detail serves `state` and `quarantineReason`, never v2's `quarantine` object.
    assert.deepEqual(RETAIL_API_KEYS.receiptDetail.filter((key) => /quarantine|state/i.test(key)), ['state', 'quarantineReason']);
  });

  it('shows the payload\'s closed vocabularies exactly', () => {
    assert.deepEqual(RETAIL_API_CHANNELS, RETAIL_CHANNELS);
    assert.deepEqual(RETAIL_API_SIGNS, RETAIL_SIGNS);
    assert.deepEqual(RETAIL_API_ONLINE_STATUSES, RETAIL_ONLINE_STATUSES);
    assert.deepEqual(RETAIL_API_LINE_KINDS, RETAIL_LINE_KINDS);
    assert.deepEqual(RETAIL_API_TENDER_KINDS, RETAIL_TENDER_KINDS);
    assert.deepEqual(RETAIL_API_CARD_TENDER_KINDS, RETAIL_CARD_TENDER_KINDS);
    assert.deepEqual(RETAIL_API_NETWORKS, RETAIL_NETWORKS);
    assert.deepEqual(RETAIL_API_FULFILMENTS, RETAIL_FULFILMENTS);
    assert.deepEqual(RETAIL_API_CARRIERS, RETAIL_CARRIERS);
    assert.deepEqual(RETAIL_API_STORED_VALUE_KINDS, RETAIL_STORED_VALUE_KINDS);
    assert.deepEqual(RETAIL_API_METALS, RETAIL_METALS);
    assert.deepEqual(RETAIL_API_METAL_FORMS, RETAIL_METAL_FORMS);
    assert.deepEqual(RETAIL_API_WEIGHT_UNITS, RETAIL_WEIGHT_UNITS);
    assert.deepEqual(RETAIL_API_METAL_PACKS, RETAIL_METAL_PACKS);
    assert.deepEqual(RETAIL_API_METAL_GUARD_EVIDENCE, RETAIL_METAL_GUARD_EVIDENCE);
    assert.deepEqual(RETAIL_API_LINE_EVENT_KINDS, ['shipped', 'delivered', 'cancelled', 'returned']);
    // A category on every line kind the retail taxonomy counts: the payload's kinds but the coupon.
    assert.deepEqual(RETAIL_API_CATEGORY_LINE_KINDS, RETAIL_LINE_KINDS.filter((kind) => kind !== 'coupon'));
    assert.deepEqual(RETAIL_API_CATEGORY_SOURCES, ['title-rule', 'owner', 'agent', 'department-review']);
  });
});
