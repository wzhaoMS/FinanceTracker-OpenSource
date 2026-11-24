import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { syntheticCapture, syntheticBackfillCapture, rootApproval } from './fixtures.testSupport.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { hasAmazonSchema } from './schema.js';
import { validateCapture } from './capture.js';
import { applyAgentReview, makeAgentReview } from './categorization.js';
import { productKey, projectProducts, validImageId } from './products.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { digest } from './policy.js';
import { readLedger } from './matcher.js';

let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const count = (table: string) => db().prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
const base = () => (db().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'amazon_%'
  AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[])
  .map(name => [name, db().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-synthetic-'));
  backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const prime = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', nickname: 'Synthetic Prime Visa' });
  repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD', nickname: 'Synthetic Marriott Boundless' });
  repo.importCardTransactions({ cardAccountId: prime.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
      description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping' }] });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function approve() {
  const cards = readCardInventory(db());
  const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
}
describe('strict capture boundary', () => {
  it('validates closed item-keyword diagnostics before projection and preserves historical envelopes', async () => {
    const { itemKeywordsFixture, validItemKeywordCaptures, invalidItemKeywords,
      invalidItemKeywordRegionCaptures } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = itemKeywordsFixture(), original = JSON.stringify(capture.staging);
    expect((await validateCapture(capture)).structure).toEqual(capture.structure);
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(JSON.stringify(capture.staging)).toBe(original);
    for (const valid of validItemKeywordCaptures()) {
      expect((await validateCapture(valid)).structure).toEqual(valid.structure);
    }
    const old = structuredClone(capture);
    delete old.structure.itemDiagnostics.orders[0].keywords;
    await expect(validateCapture(old)).resolves.toBeDefined();
    for (const mutate of invalidItemKeywords()) {
      const invalid = itemKeywordsFixture();
      mutate(invalid.structure.itemDiagnostics.orders[0].keywords);
      await expect(validateCapture(invalid)).rejects.toThrow();
      await expect(importAmazonCapture(db(), invalid, backup())).rejects.toThrow();
    }
    for (const invalid of invalidItemKeywordRegionCaptures()) {
      await expect(validateCapture(invalid)).rejects.toThrow();
      await expect(importAmazonCapture(db(), invalid, backup())).rejects.toThrow();
    }
    expect(count('amazon_captures')).toBe(1);
  });
  it('validates private completed-proof retry metadata without importing it or manufacturing financial observations', async () => {
    const { proofRetryFixture } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = proofRetryFixture();
    const original = JSON.stringify(capture);
    expect(await validateCapture(capture)).toEqual({ structure: capture.structure, staging: capture.staging });
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(count('amazon_orders')).toBe(0);
    expect(JSON.stringify(capture)).toBe(original);
    for (const mutate of [
      (c: ReturnType<typeof proofRetryFixture>) => { c.continuation.after.proofRetry.raw = 'private'; },
      (c: ReturnType<typeof proofRetryFixture>) => { c.continuation.after.proofRetry.candidates[0].reasons = ['guessed']; },
      (c: ReturnType<typeof proofRetryFixture>) => { c.continuation.after.proofRetry.consumed = ['999-9999999-9999999']; },
      (c: ReturnType<typeof proofRetryFixture>) => { c.continuation.after.proofRetry.queue = ['/cpe/yourpayments/transactions']; },
    ]) {
      const invalid = proofRetryFixture(); mutate(invalid);
      await expect(validateCapture(invalid)).rejects.toThrow();
      await expect(importAmazonCapture(db(), invalid, backup())).rejects.toThrow();
    }
    expect(count('amazon_captures')).toBe(1);
  });
  it('validates optional readiness diagnostics through the actual import boundary without changing staging', async () => {
    const { readinessFixture } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = syntheticCapture();
    capture.structure = readinessFixture().structure;
    const original = JSON.stringify(capture.staging);
    await expect(validateCapture(capture)).resolves.toBeDefined();
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(JSON.stringify(capture.staging)).toBe(original);
    const old = readinessFixture();
    delete old.structure.navigationStop.readiness;
    await expect(validateCapture({ ...capture, structure: old.structure })).resolves.toBeDefined();
    for (const mutate of [
      (c: ReturnType<typeof readinessFixture>) => { c.structure.navigationStop.readiness.raw = 'private'; },
      (c: ReturnType<typeof readinessFixture>) => { c.structure.navigationStop.readiness.classes = ['order-token']; },
      (c: ReturnType<typeof readinessFixture>) => { c.structure.navigationStop.readiness.method.nonbuttonContent = true; },
      (c: ReturnType<typeof readinessFixture>) => { c.structure.navigationStop.readiness.termination = 'private'; },
      (c: ReturnType<typeof readinessFixture>) => { c.structure.navigationStop.readiness.buckets.div = 20001; },
      (c: ReturnType<typeof readinessFixture>) => { c.structure.navigationStop.sameOrderId = false; },
    ]) {
      const invalid = readinessFixture(); mutate(invalid);
      await expect(validateCapture({ ...capture, structure: invalid.structure })).rejects.toThrow();
    }
  });
  it('validates and backup-first imports the shared optional summary-label shape without changing financial evidence', async () => {
    const { summaryLabelDisclosureFixture, invalidSummaryLabelDisclosures } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = summaryLabelDisclosureFixture();
    const original = JSON.stringify(capture.staging);
    await expect(validateCapture(capture)).resolves.toBeDefined();
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(JSON.stringify(capture.staging)).toBe(original);
    const old = structuredClone(capture);
    delete old.structure.tenderDiagnostics.summaryLabelDisclosure;
    await expect(validateCapture(old)).resolves.toBeDefined();
    for (const mutate of invalidSummaryLabelDisclosures()) {
      const invalid = summaryLabelDisclosureFixture();
      mutate(invalid.structure.tenderDiagnostics.summaryLabelDisclosure);
      await expect(validateCapture(invalid)).rejects.toThrow();
    }
  });

  it('strictly validates separated readiness vocabulary and all shared negatives through the actual API boundary', async () => {
    const { separatedReadinessFixture, invalidSeparatedReadiness } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = syntheticCapture();
    capture.structure = separatedReadinessFixture().structure;
    const original = JSON.stringify(capture.staging);
    await expect(validateCapture(capture)).resolves.toBeDefined();
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(JSON.stringify(capture.staging)).toBe(original);
    for (const mutate of invalidSeparatedReadiness()) {
      const invalid = separatedReadinessFixture();
      mutate(invalid.structure.navigationStop.readiness);
      await expect(validateCapture({ ...capture, structure: invalid.structure })).rejects.toThrow();
    }
  });

  it('strictly validates scoped readiness ownership through the API without changing staging', async () => {
    const { scopedReadinessFixture, invalidScopedReadiness } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = syntheticCapture();
    capture.structure = scopedReadinessFixture().structure;
    const original = JSON.stringify(capture.staging);
    const validated = await validateCapture(capture);
    expect(validated.structure).toEqual(capture.structure);
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(JSON.stringify(capture.staging)).toBe(original);
    for (const mutate of invalidScopedReadiness()) {
      const invalid = scopedReadinessFixture();
      mutate(invalid.structure.navigationStop.readiness);
      await expect(validateCapture({ ...capture, structure: invalid.structure })).rejects.toThrow();
    }
  });

  it('validates shared full identity and FOPO envelopes unchanged before backup-first import', async () => {
    const { evidenceGapFixtures, invalidEvidenceGapCaptures, fopoObservationFixture,
      constructedFopoFixture, invalidFopoCollectionCaptures } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    for (const capture of evidenceGapFixtures()) {
      const original = JSON.stringify(capture);
      await expect(validateCapture(capture)).resolves.toBeDefined();
      await importAmazonCapture(db(), capture, backup());
      expect(JSON.stringify(capture)).toBe(original);
    }
    const before = count('amazon_captures');
    for (const mutate of invalidEvidenceGapCaptures()) {
      const capture = fopoObservationFixture(); mutate(capture);
      await expect(validateCapture(capture)).rejects.toThrow();
      await expect(importAmazonCapture(db(), capture, backup())).rejects.toThrow();
    }
    for (const mutate of invalidFopoCollectionCaptures()) {
      const capture = constructedFopoFixture(); mutate(capture);
      await expect(validateCapture(capture)).rejects.toThrow();
      await expect(importAmazonCapture(db(), capture, backup())).rejects.toThrow();
    }
    expect(count('amazon_captures')).toBe(before);
  });

  it('accepts the shared rendered-ledger producer fixture through actual validation/import and preserves old shapes', async () => {
    const { renderedLedgerFixture } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const capture = syntheticCapture();
    capture.structure = renderedLedgerFixture().structure;
    const original = JSON.stringify(capture.staging);
    await expect(validateCapture(capture)).resolves.toBeDefined();
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(JSON.stringify(capture.staging)).toBe(original);
    const old = structuredClone(capture);
    const structure = old.structure as { paginationDiagnostics: { pages: { rendered?: unknown }[] } };
    delete structure.paginationDiagnostics.pages[0].rendered;
    await expect(validateCapture(old)).resolves.toBeDefined();
    for (const mutate of [
      (c: ReturnType<typeof renderedLedgerFixture>) => { c.structure.requests = 1; },
      (c: ReturnType<typeof renderedLedgerFixture>) => { c.structure.paginationDiagnostics.pages[0].rendered.raw = 'private'; },
      (c: ReturnType<typeof renderedLedgerFixture>) => { c.structure.paginationDiagnostics.pages[0].rendered.status = 'unobserved'; },
      (c: ReturnType<typeof renderedLedgerFixture>) => { c.structure.paginationDiagnostics.pages[0].rendered.candidates[0].target.url = 'private'; },
    ]) {
      const invalid = renderedLedgerFixture(); mutate(invalid);
      await expect(validateCapture({ ...capture, structure: invalid.structure })).rejects.toThrow();
    }
    expect(count('amazon_captures')).toBe(1);
  });
  it.each([1, 2, 3] as const)('accepts synthetic producer staging v%s', async version => {
    expect((await validateCapture(syntheticCapture(version))).staging.version).toBe(version);
  });
  it('loads producer pagination validation on the actual backup-first import path without changing financial staging', async () => {
    const capture = syntheticCapture();
    const structure = {
      format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown',
      code: 'complete', requests: 1, stop: null,
      pages: [{ kind: 'ledger', elements: 0, truncated: false, attributes: [], classes: [], paths: [], queries: [],
        diagnostics: { failures: [], scopes: [], omittedScopes: 0, exhausted: false } }],
      paginationDiagnostics: { pages: [{ page: 0, kind: 'ledger', status: 'budget-held' }] },
    };
    capture.structure = structure;
    const original = JSON.stringify(capture);
    expect((await validateCapture(capture)).staging).toEqual(capture.staging);
    expect(JSON.stringify(capture)).toBe(original);
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    expect(count('amazon_orders')).toBe(1);
    Object.assign(structure.paginationDiagnostics.pages[0], { raw: 'Synthetic unapproved metadata' });
    await expect(validateCapture(capture)).rejects.toThrow();
    expect(count('amazon_captures')).toBe(1);
  });
  it('preserves optional recent/backfill mode and enforces its exact window and resume limits', async () => {
    const recent = syntheticCapture();
    recent.staging.mode = 'recent';
    expect((await validateCapture(recent)).staging.mode).toBe('recent');
    recent.staging.resume.orders = [2024, 2025, 2026].map(year => ({ year, startIndex: 0 }));
    await expect(validateCapture(recent)).rejects.toThrow();
    const backfill = syntheticBackfillCapture([2024, 2025, 2026]);
    expect((await validateCapture(backfill)).staging).toEqual(backfill.staging);
    expect(await validateCapture(backfill)).not.toHaveProperty('continuation');
    backfill.staging.resume.orders.push({ year: 2023, startIndex: 0 });
    await expect(validateCapture(backfill)).rejects.toThrow();
    backfill.staging.resume.orders.pop();
    backfill.staging.window.from = '2024-10-18';
    await expect(validateCapture(backfill)).rejects.toThrow();
    backfill.staging.window.from = '2024-10-19';
    delete backfill.staging.mode;
    await expect(validateCapture(backfill)).rejects.toThrow();
  });
  it('validates scoped name-only UFF redirect diagnostics on the actual producer/import boundary and keeps old reports readable', async () => {
    const capture = syntheticCapture();
    const navigationStop = {
      stopLocation: 'before-snapshot', requestedKind: 'details', destinationClass: 'disallowed',
      finalPathTemplate: '/uff/your-account/order-details', finalPathFamily: 'uff-details',
      finalQueryNames: ['orderID', 'unknown'], sameOrderId: true, trackingOnly: false, authPath: false, admittedPath: true,
      uffUnknownQueryNames: ['shipmentKey'],
    };
    capture.structure = { format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown',
      code: 'redirect-blocked', requests: 1, pages: [], stop: null, navigationStop };
    expect((await validateCapture(capture)).structure).toEqual(capture.structure);
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_captures')).toBe(1);
    const old = structuredClone(capture);
    Reflect.deleteProperty((old.structure as { navigationStop: object }).navigationStop, 'uffUnknownQueryNames');
    await expect(validateCapture(old)).resolves.toBeDefined();
    for (const change of [
      { uffUnknownQueryNames: ['bad-name'] }, { uffUnknownQueryNames: ['a', 'b', 'c', 'd', 'e'] },
      { uffUnknownQueryNames: [{ shipmentKey: 'privateValue' }] }, { uffUnknownQueryValues: ['privateValue'] },
      { finalPathFamily: 'cross-origin' }, { finalPathTemplate: '/your-orders/order-details' },
      { sameOrderId: false }, { finalQueryNames: ['orderID'] },
    ]) {
      const changed = structuredClone(capture);
      Object.assign((changed.structure as { navigationStop: object }).navigationStop, change);
      await expect(validateCapture(changed)).rejects.toThrow();
    }
    expect(count('amazon_captures')).toBe(1);
  });
  it('validates the complete private continuation envelope before discarding cursor metadata', async () => {
    const c = syntheticBackfillCapture();
    expect(await validateCapture(c)).toEqual({ structure: c.structure, staging: c.staging });
    c.continuation.after.revision = 2;
    await expect(validateCapture(c)).rejects.toThrow();
    c.continuation.after.revision = 1;
    c.continuation.after.window.from = '2024-10-18';
    await expect(validateCapture(c)).rejects.toThrow();
    c.continuation.after.window.from = '2024-10-19';
    c.structure.progress.ordersDone = 0;
    await expect(validateCapture(c)).rejects.toThrow();
    c.structure.progress.ordersDone = 1;
    Object.assign(c.continuation.after, { unexpected: 'Synthetic unapproved metadata' });
    await expect(validateCapture(c)).rejects.toThrow();
  });
  it.each([
    { currency: 'USD', amountMinor: -1 },
    { currency: 'USD', amountMinor: 100000001 },
    { currency: 'USD', amountMinor: 0.5 },
    { currency: 'EUR', amountMinor: 100 },
    { currency: 'USD', amountMinor: 100, kind: 'refund' },
    null,
  ])('rejects malformed or non-closed refund summary observation %#', async refundSummary => {
    const c = syntheticCapture();
    Object.assign(c.staging.orders[0], { refundSummary });
    await expect(validateCapture(c)).rejects.toThrow();
  });
  it('keeps no-details-link orders held/resumable through the shared producer boundary, with exact counts', async () => {
    const c = syntheticCapture(), order = c.staging.orders[0];
    order.items = []; order.paymentMethods = []; order.summary = []; order.tenderCoverage = 'unknown';
    order.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false };
    c.staging.coverage.details = { status: 'held', reason: 'no-details-link', pages: 0, records: 0, rejected: 0 };
    c.staging.resume.details = [order.orderId];
    const reasons = ['unknown-label', 'row-shape', 'extra-text', 'duplicate-kind', 'arithmetic',
      'method-incomplete', 'multi-tender', 'no-details-link'];
    const diagnostic = {
      orders: [{ ordinal: 0, reasons: ['method-incomplete', 'row-shape', 'no-details-link'] }],
      counts: Object.fromEntries(reasons.map(r => [r, ['method-incomplete', 'row-shape', 'no-details-link'].includes(r) ? 1 : 0])),
      unknownLabels: [], unreportedUnknownLabelOrders: 0,
    };
    c.structure = { format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown',
      code: 'complete', requests: 0, pages: [], stop: null, tenderDiagnostics: diagnostic };
    expect((await validateCapture(c)).staging.resume.details).toEqual([order.orderId]);
    c.staging.resume.details = [];
    await expect(validateCapture(c)).rejects.toThrow();
    c.staging.resume.details = [order.orderId];
    diagnostic.counts['no-details-link'] = 0;
    await expect(validateCapture(c)).rejects.toThrow();
    diagnostic.counts['no-details-link'] = 1;
    order.tenderProof.methodComplete = true;
    await expect(validateCapture(c)).rejects.toThrow();
  });
  it('rejects extra fields, addresses, wrong source/version/window and malformed private text', async () => {
    const captures = [syntheticCapture(), syntheticCapture(), syntheticCapture(), syntheticCapture(), syntheticCapture()];
    Object.assign(captures[0].staging.orders[0], { address: 'Synthetic disallowed address' });
    Object.assign(captures[1].staging, { source: 'other' });
    Object.assign(captures[2].staging, { version: 99 });
    captures[3].staging.orders[0].items[0].title = 'https://synthetic.invalid';
    captures[4].staging.window.through = '2026-02-30';
    for (const capture of captures) await expect(validateCapture(capture)).rejects.toThrow('amazon input refused');
  });
  it('rejects repeated line ordinals but keeps repeated ASIN lines distinct', async () => {
    const c = syntheticCapture();
    c.staging.orders[0].items.push({ ...c.staging.orders[0].items[0] });
    c.staging.coverage.details.records = 2;
    await expect(validateCapture(c)).rejects.toThrow();
    c.staging.orders[0].items[1].lineOrdinal = 1;
    expect((await validateCapture(c)).staging.orders[0].items).toHaveLength(2);
  });
  it('enforces displayed ledger refund source and run occurrence uniqueness', async () => {
    const c = syntheticCapture();
    const p = { date: '2026-09-03', money: { currency: 'USD', amountMinor: 300 }, kind: 'refund' as const,
      status: 'completed' as const, method: { kind: 'card' as const, network: 'visa' as const, last4: '9001' },
      orderIds: [c.staging.orders[0].orderId], identity: 'native-row' as const,
      provenance: { source: 'ledger' as const, status: 'Refunded' as const, page: 0, ordinal: 0 } };
    c.staging.payments.push(p);
    c.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    c.staging.coverage.refunds = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    await validateCapture(c);
    Object.assign(p.provenance, { source: 'order-summary' });
    await expect(validateCapture(c)).rejects.toThrow();
    p.provenance.source = 'ledger';
    c.staging.payments.push(structuredClone(p));
    c.staging.coverage.payments.records = 2; c.staging.coverage.refunds.records = 2;
    await expect(validateCapture(c)).rejects.toThrow();
  });
  it('admits full v3 titles without truncation while keeping legacy bounds and explicit ASIN', async () => {
    const c = syntheticCapture(), long = 'Synthetic full model name '.repeat(50);
    c.staging.orders[0].items[0].title = long;
    expect((await validateCapture(c)).staging.orders[0].items[0].title).toBe(long);
    c.staging.orders[0].items[0].title = 'x'.repeat(2049);
    await expect(validateCapture(c)).rejects.toThrow();
    const old = syntheticCapture(2); old.staging.orders[0].items[0].title = long;
    await expect(validateCapture(old)).rejects.toThrow();
  });
  it('independently refuses a claimed complete item block with unknown quantities or wrong subtotal', async () => {
    const c = syntheticCapture(), o = c.staging.orders[0];
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    await validateCapture(c);
    o.items[0].quantity = null;
    await expect(validateCapture(c)).rejects.toThrow();
    o.items[0].quantity = 2;
    await expect(validateCapture(c)).rejects.toThrow();
    o.items[0].quantity = 1;
    o.itemProof.unknownLine = true;
    await expect(validateCapture(c)).rejects.toThrow();
  });
  it('admits only a validated display-only v3 item imageId and stores the item verbatim', async () => {
    const { itemImageCases } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const { ids } = itemImageCases();
    for (const imageId of ids.valid) {
      const c = syntheticCapture(); c.staging.orders[0].items[0].imageId = imageId;
      expect((await validateCapture(c)).staging.orders[0].items[0].imageId).toBe(imageId);
    }
    for (const imageId of ids.refused) {
      const c = syntheticCapture(); Object.assign(c.staging.orders[0].items[0], { imageId });
      await expect(validateCapture(c)).rejects.toThrow('amazon input refused');
    }
    const extra = syntheticCapture();
    Object.assign(extra.staging.orders[0].items[0], { imageId: ids.valid[0], imageUrl: 'https://synthetic.invalid/widget.jpg' });
    await expect(validateCapture(extra)).rejects.toThrow('amazon input refused');
    for (const version of [1, 2] as const) {
      const legacy = syntheticCapture(version); legacy.staging.orders[0].items[0].imageId = ids.valid[0];
      await expect(validateCapture(legacy)).rejects.toThrow('amazon input refused');
    }
    const c = syntheticCapture(); c.staging.orders[0].items[0].imageId = ids.valid[1];
    await importAmazonCapture(db(), c, backup());
    expect(JSON.parse(db().prepare('SELECT data_json FROM amazon_items').pluck().get() as string))
      .toEqual(c.staging.orders[0].items[0]);
    expect(listAmazonOrders(db(), 0, 10).orders[0].items[0]).not.toHaveProperty('imageId');
  });
  it('keeps the API image-ID grammar identical to the producer kit grammar on the shared corpus', async () => {
    const { itemImageCases } = await import(new URL(
      '../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs', import.meta.url).href);
    const { AMAZON_STRUCTURE_RULES } = await import(new URL(
      '../../../../../tools/amazon-capture/amazon-capture.mjs', import.meta.url).href);
    const producer = new RegExp(AMAZON_STRUCTURE_RULES.itemImage.id), { ids, src } = itemImageCases();
    const corpus: unknown[] = [...ids.valid, ...ids.refused, ...src.valid.map(([, id]: string[]) => id), ...src.refused];
    for (const value of corpus) expect(validImageId(value)).toBe(typeof value === 'string' && producer.test(value));
    expect(ids.valid.every(validImageId)).toBe(true);
    expect(ids.refused.some(validImageId)).toBe(false);
  });
});
describe('additive backup-first importer and integrated reconciliation', () => {
  it.each([0, 300, 100000000])('stores refund summary %s separately without creating moneyflow or changing purchase allocation', async amountMinor => {
    await approve();
    const c = syntheticBackfillCapture(), refundSummary = { currency: 'USD', amountMinor };
    c.staging.orders[0].refundSummary = refundSummary;
    c.staging.orders[0].itemProof = { complete: true, unknownLine: false, conflict: false };
    const before = JSON.stringify(base());
    await importAmazonCapture(db(), c, backup());
    await backedUpWrite(db(), backup(), () => {
      const itemRef = db().prepare('SELECT ref FROM amazon_items').pluck().get();
      db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(itemRef, 'Shopping');
    });
    const orderRef = db().prepare('SELECT ref FROM amazon_orders').pluck().get() as string;
    expect(getAmazonOrder(db(), orderRef)).toMatchObject({ refundSummary, refunds: [] });
    expect(count('amazon_refunds')).toBe(0);
    expect(count('amazon_ledger_matches')).toBe(0);
    const tables = db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%'")
      .pluck().all() as string[];
    const stored = JSON.stringify(tables.map(table => db().prepare(`SELECT * FROM ${table}`).all()));
    expect(stored).not.toContain(c.continuation.after.id);
    expect(stored).not.toContain('"continuation"');
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE family IN ('payment','refund')").pluck().get()).toBe(0);
    expect(db().prepare('SELECT capture_mode FROM amazon_capture_runs').pluck().get()).toBe('backfill');
    const result = createAmazonCategoryResolver(db()).snapshot().resolve(readLedger(db())).values().next().value;
    expect(result?.kind).toBe('split');
    if (result?.kind !== 'split') throw Error('synthetic split expected');
    expect(result.contributions.reduce((n, part) => n + part.amountMinor, 0)).toBe(1100);
    expect(JSON.stringify(base())).toBe(before);
    expect(await importAmazonCapture(db(), c, backup())).toMatchObject({ newCaptures: 0, newObservations: 0, newMatches: 0 });
  });
  it('backs up before migration, imports held v1/v2, leaves every existing table byte-for-byte unchanged', async () => {
    const before = JSON.stringify(base()), file = backup();
    const result = await importAmazonCapture(db(), syntheticCapture(2), file);
    const saved = new Database(file, { readonly: true });
    expect(hasAmazonSchema(saved)).toBe(false);
    expect(saved.pragma('quick_check', { simple: true })).toBe('ok'); saved.close();
    expect(result).toMatchObject({ newCaptures: 1, newOrders: 1, newObservations: 2, newMatches: 0, held: 1 });
    expect(result.holds).toContainEqual({ reason: 'legacy-evidence-held', count: 1 });
    expect(JSON.stringify(base())).toBe(before);
    expect(db().prepare('SELECT beneficiary FROM amazon_orders').pluck().get()).toBeNull();
    expect(count('amazon_subjects')).toBe(1);
    expect(count('amazon_items')).toBe(0);
  });
  it('repeat import adds zero records/matches and no audit churn', async () => {
    const capture = syntheticCapture();
    await importAmazonCapture(db(), capture, backup());
    const audit = count('amazon_audit');
    const result = await importAmazonCapture(db(), structuredClone(capture), backup());
    expect(result).toMatchObject({ newCaptures: 0, newOrders: 0, newObservations: 0, newMatches: 0, invalidated: 0 });
    expect(count('amazon_captures')).toBe(1);
    expect(db().prepare('SELECT capture_mode FROM amazon_capture_runs').pluck().get()).toBe('recent');
    expect(count('amazon_audit')).toBe(audit);
  });
  it('invalid input or pre-write backup failure performs no schema or domain writes', async () => {
    const bad = syntheticCapture(); bad.staging.orders[0].date = 'invalid';
    const target = backup();
    await expect(importAmazonCapture(db(), bad, target)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
    const occupied = backup(); fs.writeFileSync(occupied, 'synthetic occupied');
    await expect(importAmazonCapture(db(), syntheticCapture(), occupied)).rejects.toThrow();
    expect(fs.readFileSync(occupied, 'utf8')).toBe('synthetic occupied');
    expect(hasAmazonSchema(db())).toBe(false);
  });
  it('never uses a SQLite live sidecar path as a backup destination', async () => {
    const before = JSON.stringify(base());
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await expect(importAmazonCapture(db(), syntheticCapture(), `${db().name}${suffix}`)).rejects.toThrow('amazon backup refused');
    }
    expect(hasAmazonSchema(db())).toBe(false);
    expect(JSON.stringify(base())).toBe(before);
  });
  it('rolls back schema and all writes atomically, retaining the pre-write backup', async () => {
    const before = JSON.stringify(base()), file = backup();
    await expect(backedUpWrite(db(), file, () => {
      db().prepare('INSERT INTO amazon_sources VALUES(?)').run('synthetic');
      throw Error('synthetic private failure');
    })).rejects.toThrow();
    expect(hasAmazonSchema(db())).toBe(false);
    expect(JSON.stringify(base())).toBe(before);
    const saved = new Database(file, { readonly: true });
    expect(saved.pragma('quick_check', { simple: true })).toBe('ok'); saved.close();
  });
  it('imports changed observations with audit, never deletes absent rows/items on partial refresh', async () => {
    const capture = syntheticCapture();
    await importAmazonCapture(db(), capture, backup());
    const oldItems = count('amazon_items'), audit = count('amazon_audit');
    capture.staging.orders[0].items[0].title = 'Synthetic revised widget';
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_orders')).toBe(1);
    expect(count('amazon_items')).toBe(oldItems + 1);
    expect(count('amazon_audit')).toBeGreaterThan(audit);
    capture.staging.orders = [];
    capture.staging.coverage.orders = { status: 'held', reason: 'budget', pages: 1, records: 0, rejected: 0 };
    capture.staging.coverage.details = { status: 'held', reason: 'budget', pages: 1, records: 0, rejected: 0 };
    await importAmazonCapture(db(), capture, backup());
    expect(count('amazon_orders')).toBe(1);
    expect(count('amazon_items')).toBe(oldItems + 1);
  });
  it('proposals do not authorize either card; separate Root approval enables v3 fallback but not item splits', async () => {
    const before = JSON.stringify(base());
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const cards = readCardInventory(db());
    const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
    await recordBindingProposal(db(), proposal, backup());
    expect(db().prepare("SELECT count(*) FROM amazon_matches WHERE state='linked'").pluck().get()).toBe(0);
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    expect(db().prepare("SELECT count(*) FROM amazon_matches WHERE state='linked'").pluck().get()).toBe(1);
    const row = repo.queryCardTransactions({}).transactions[0];
    const snapshot = createAmazonCategoryResolver(db()).snapshot();
    expect(snapshot.resolve([row]).get(row.id)).toMatchObject({ kind: 'whole-row', reason: 'item-identity-unproven' });
    expect(snapshot.getCardDetail(row.id)).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match', coverage: { complete: false } });
    expect(JSON.stringify(base())).toBe(before);
  });
  it('wires proof, closed agent reviews, override precedence, title/ASIN detail and snapshot invalidation end to end', async () => {
    await approve();
    const capture = syntheticCapture(), o = capture.staging.orders[0];
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    const before = JSON.stringify(base());
    await importAmazonCapture(db(), capture, backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    const projection = projectProducts([capture]);
    const review = makeAgentReview(projection, ['Shopping'], [{
      productKey: productKey(projection.products[0]), category: 'Shopping', confidence: 0.93,
      source: 'agent', rationale: 'categorized from product title',
    }]);
    const resolver = createAmazonCategoryResolver(db()), previous = resolver.snapshot();
    await backedUpWrite(db(), backup(), () => applyAgentReview(db(), review));
    const snapshot = resolver.snapshot();
    expect(snapshot.version).not.toBe(previous.version);
    const result = snapshot.resolve([row]).get(row.id)!;
    expect(result.kind).toBe('split');
    if (result.kind !== 'split') return;
    expect(result.contributions).toMatchObject([
      { amountMinor: 1000, category: 'Shopping', categorySource: 'agent-classification', classification: 'source' },
      { amountMinor: 100, category: 'Shopping', categorySource: 'agent-classification', classification: 'policy-allocated' },
    ]);
    const detail = snapshot.getCardDetail(row.id);
    expect(detail.items).toEqual([{ itemRef: result.contributions[0].itemRef, title: o.items[0].title, quantity: 1, asin: o.items[0].itemId }]);
    const orderRef = detail.orderRefs![0];
    expect(getAmazonOrder(db(), orderRef)!.items[0]).toMatchObject({ title: o.items[0].title, asin: o.items[0].itemId,
      category: 'Shopping', categorySource: 'agent-classification', confidence: 0.93 });
    const itemRef = result.contributions[0].itemRef!;
    await backedUpWrite(db(), backup(), () => db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(itemRef, 'Owner new category'));
    const overridden = resolver.snapshot().resolve([row]).get(row.id)!;
    expect(overridden.kind === 'split' && overridden.contributions.every(p => p.categorySource === 'item-override')).toBe(true);
    expect(snapshot.resolve([row]).get(row.id)).toEqual(result);
    expect(JSON.stringify(base())).toBe(before);
  });
  it('keeps repeated ASIN lines separate and withdraws allocation on any conflicting persisted snapshot', async () => {
    await approve();
    const capture = syntheticCapture(), o = capture.staging.orders[0];
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    o.items[0].unitPrice!.amountMinor = 500;
    o.items.push({ ...structuredClone(o.items[0]), lineOrdinal: 1 });
    capture.staging.coverage.details.records = 2;
    await importAmazonCapture(db(), capture, backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    const resolver = createAmazonCategoryResolver(db());
    expect(resolver.snapshot().getCardDetail(row.id).items).toHaveLength(2);
    expect(resolver.snapshot().resolve([row]).get(row.id)).toMatchObject({ kind: 'split' });
    o.items[0].unitPrice!.amountMinor = 400; o.items[1].unitPrice!.amountMinor = 600;
    await importAmazonCapture(db(), capture, backup());
    expect(resolver.snapshot().resolve([row]).get(row.id)).toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
    o.items[0].unitPrice!.amountMinor = 500; o.items[1].unitPrice!.amountMinor = 500;
    capture.staging.runId = '00000000-0000-4000-8000-000000000002';
    await importAmazonCapture(db(), capture, backup());
    expect(resolver.snapshot().resolve([row]).get(row.id)).toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
    expect(count('amazon_allocations')).toBe(0); // Policy derivation never masquerades as a payment-item join.
  });
  it('holds only the guarded item category without filtering allocation evidence or accepting a forged review', async () => {
    db().prepare("UPDATE card_transactions SET description='AMZN Mktp US',revision=revision+1").run();
    await approve();
    const capture = syntheticCapture(), o = capture.staging.orders[0];
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    o.items[0].unitPrice!.amountMinor = 500;
    const held = { ...structuredClone(o.items[0]), itemId: 'SYNTHHOLD1', title: 'Synthetic CVV 123', lineOrdinal: 1 };
    o.items.push(held);
    capture.staging.coverage.details.records = 2;
    const unchanged = structuredClone(capture);
    const projection = projectProducts([capture]);
    expect(projection.coverage).toEqual({ itemObservations: 2, projectedObservations: 1, heldTitleObservations: 1 });
    expect(capture).toEqual(unchanged);
    await importAmazonCapture(db(), capture, backup());
    const review = makeAgentReview(projection, ['Shopping'], [{
      productKey: productKey(projection.products[0]), category: 'Shopping', confidence: 0.9,
      source: 'agent', rationale: 'categorized from product title',
    }]);
    await backedUpWrite(db(), backup(), () => applyAgentReview(db(), review));
    const heldKey = productKey({ asin: held.itemId, title: held.title });
    const forged = { ...review, entries: [{ ...review.entries[0], productKey: heldKey }] };
    await expect(backedUpWrite(db(), backup(), () => applyAgentReview(db(), forged))).rejects.toThrow('amazon input refused');
    expect(count('amazon_agent_categories')).toBe(1);
    const heldRef = (db().prepare('SELECT ref FROM amazon_items WHERE json_extract(data_json,\'$.itemId\')=?')
      .pluck().get(held.itemId)) as string;
    // Simulate pre-existing reviews: none may classify a newly guarded observation.
    await backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)').run(heldKey, 'Shopping', 0.9, 'agent', 'categorized from product title');
      db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(heldRef, 'Owner category');
    });
    const row = repo.queryCardTransactions({}).transactions[0], snapshot = createAmazonCategoryResolver(db()).snapshot();
    const result = snapshot.resolve([row]).get(row.id);
    expect(result?.kind).toBe('split');
    if (result?.kind !== 'split') throw Error('synthetic split expected');
    expect(result.contributions.filter(p => p.classification !== 'residual')).toMatchObject([
      { amountMinor: 500, category: 'Shopping', categorySource: 'agent-classification', classification: 'source' },
      { amountMinor: 50, category: 'Shopping', categorySource: 'agent-classification', classification: 'policy-allocated' },
    ]);
    expect(result.contributions.find(p => p.classification === 'residual')).toEqual({
      amountMinor: 550, category: null, categorySource: null, classification: 'residual',
    });
    expect(result.contributions.reduce((n, p) => n + p.amountMinor, 0)).toBe(row.amountMinor);
    expect(result.contributions.some(p => p.itemRef === heldRef)).toBe(false);
    const detail = snapshot.getCardDetail(row.id);
    expect(detail.match).toBe('linked');
    expect(detail.items).toHaveLength(2);
    const orderRef = detail.orderRefs![0];
    expect(getAmazonOrder(db(), orderRef)!.items.find(i => i.ref === heldRef)).toMatchObject({
      title: '[redacted]', category: null, categorySource: null, confidence: null,
    });
    expect(listAmazonOrders(db(), 0, 100).orders[0].items.find(i => i.ref === heldRef))
      .toMatchObject({ title: '[redacted]', category: null, categorySource: null });
    expect(snapshot.matchCounts.itemizedRows).toBe(1);
    expect(capture).toEqual(unchanged);
  });
  it('rejects agent destinations outside Spending inventory without partial writes', async () => {
    const capture = syntheticCapture();
    await importAmazonCapture(db(), capture, backup());
    const p = projectProducts([capture]);
    const review = makeAgentReview(p, ['Shopping'], [{ productKey: productKey(p.products[0]), category: 'Shopping', confidence: 0.5,
      source: 'agent', rationale: 'categorized from product title' }]);
    const bad = { ...review, entries: [{ ...review.entries[0], category: 'Invented' }] };
    await expect(backedUpWrite(db(), backup(), () => applyAgentReview(db(), bad))).rejects.toThrow();
    expect(count('amazon_agent_categories')).toBe(0);
    expect(review.productsDigest).toBe(digest(p));
  });
  it('never erases an explicit historical block conflict when later proof flags improve', async () => {
    await approve();
    const capture = syntheticCapture(), o = capture.staging.orders[0];
    o.itemProof = { complete: false, unknownLine: false, conflict: true };
    await importAmazonCapture(db(), capture, backup());
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    await importAmazonCapture(db(), capture, backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    expect(createAmazonCategoryResolver(db()).snapshot().resolve([row]).get(row.id))
      .toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
  });
  it('projects bounded list items and live match summaries without exposing held candidate ids', async () => {
    await approve();
    const capture = syntheticCapture();
    await importAmazonCapture(db(), capture, backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    let list = listAmazonOrders(db(), 0, 100);
    expect(list.orders[0].items[0]).toEqual({ ref: expect.any(String), title: capture.staging.orders[0].items[0].title,
      asin: capture.staging.orders[0].items[0].itemId, quantity: 1, category: null, categorySource: null });
    expect(list.orders[0].matches).toEqual([{ state: 'linked', evidenceClass: 'unique-total-match',
      cardTransactionId: row.id, cardAccountId: row.cardAccountId }]);
    repo.importCardTransactions({ cardAccountId: row.cardAccountId, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-04', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
        description: 'SYNTHETIC SECOND CANDIDATE', issuerCategory: 'Shopping' }] });
    // No persisted reconcile: read views must recompute the live whole-ledger snapshot.
    expect(db().prepare("SELECT count(*) FROM amazon_matches WHERE state='linked'").pluck().get()).toBe(1);
    list = listAmazonOrders(db(), 0, 1);
    expect(list.orders[0].matches).toEqual([{ state: 'held', evidenceClass: 'unique-total-match', reason: 'ambiguous', candidateCount: 2 }]);
    expect(getAmazonOrder(db(), list.orders[0].ref)!.matches).toEqual(list.orders[0].matches);
    expect(JSON.stringify(list.orders[0].matches)).not.toContain(row.id);
    expect(createAmazonCategoryResolver(db()).snapshot().getCardDetail(row.id)).not.toHaveProperty('items');
    expect(() => listAmazonOrders(db(), 0, 101)).toThrow();
  });
  it('exposes only ledger-issued refund money and the instrument the row shows, never summary inference', async () => {
    const capture = syntheticCapture();
    const payment = { date: '2026-09-03', money: { currency: 'USD', amountMinor: 100 }, kind: 'refund' as const,
      status: 'completed' as const, method: { kind: 'card' as const, network: 'visa' as const, last4: '9001' },
      orderIds: [capture.staging.orders[0].orderId], identity: 'native-row' as const,
      provenance: { source: 'ledger' as const, status: 'Refunded' as const, page: 0, ordinal: 0 } };
    capture.staging.payments.push(payment);
    capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    capture.staging.coverage.refunds = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    await importAmazonCapture(db(), capture, backup());
    let list = listAmazonOrders(db(), 0, 1), order = getAmazonOrder(db(), list.orders[0].ref)!;
    // The one instrument a Refunded ledger row shows is the instrument it credits.
    expect(order.refunds).toEqual([{ ref: expect.any(String), status: 'issued', date: payment.date,
      amount: payment.money, destination: 'card' }]);
    expect(list.orders[0].refunds).toEqual(order.refunds);
    const refundRef = order.refunds[0].ref;
    await backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_refund_destinations VALUES(?,?,?,?)').run('synthetic-conflicting-destination', refundRef, 'balance', '{}');
      const { provenance: _provenance, ...legacy } = payment;
      db().prepare('INSERT INTO amazon_refunds VALUES(?,?,?,?)').run('synthetic-unproven-refund', null, 'unknown', JSON.stringify(legacy));
    });
    order = getAmazonOrder(db(), list.orders[0].ref)!;
    expect(order.refunds).toHaveLength(1);
    // Contradictory destinations never resolve to either one.
    expect(order.refunds[0].destination).toBe('unknown');
    list = listAmazonOrders(db(), 0, 1);
    expect(list.orders[0].refunds[0].destination).toBe('unknown');
    expect(JSON.stringify(list)).not.toContain(capture.staging.orders[0].orderId);
  });
  it('adding the second card approval does not revoke an identical existing binding', async () => {
    const cards = readCardInventory(db());
    const bindings = cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id }));
    const first = proposeBindings([bindings.find(b => b.last4 === '9001')!], cards);
    await recordBindingProposal(db(), first, backup());
    await recordRootApproval(db(), first, rootApproval(first), backup());
    await importAmazonCapture(db(), syntheticCapture(), backup());
    expect(db().prepare("SELECT count(*) FROM amazon_matches WHERE state='linked'").pluck().get()).toBe(1);
    await approve();
    expect(db().prepare("SELECT count(*) FROM amazon_matches WHERE state='linked'").pluck().get()).toBe(1);
  });
  it('later order ambiguity invalidates links, removes linked facts, and audits without card edits', async () => {
    await approve();
    const capture = syntheticCapture();
    await importAmazonCapture(db(), capture, backup());
    const before = JSON.stringify(base());
    const row = repo.queryCardTransactions({}).transactions[0];
    const oldSnapshot = createAmazonCategoryResolver(db()).snapshot();
    expect(oldSnapshot.getCardDetail(row.id).match).toBe('linked');
    capture.staging.orders.push({ ...structuredClone(capture.staging.orders[0]), orderId: '000-0000002-0000002' });
    capture.staging.coverage.orders.records = 2; capture.staging.coverage.details.records = 2;
    const result = await importAmazonCapture(db(), capture, backup());
    expect(result).toMatchObject({ newMatches: 0, invalidated: 1, held: 2 });
    const snapshot = createAmazonCategoryResolver(db()).snapshot();
    expect(snapshot.version).not.toBe(oldSnapshot.version);
    expect(oldSnapshot.getCardDetail(row.id).match).toBe('linked');
    const detail = snapshot.getCardDetail(row.id);
    expect(detail).toMatchObject({ match: 'held', hold: { reason: 'match-held', candidateCount: 2 } });
    for (const field of ['parts', 'orderRefs', 'evidenceClass', 'refunds']) expect(Object.hasOwn(detail, field)).toBe(false);
    expect(JSON.stringify(base())).toBe(before);
  });
  it('revalidates live ledger ambiguity in snapshots even before persisted reconciliation runs', async () => {
    await approve();
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    repo.importCardTransactions({ cardAccountId: row.cardAccountId, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-04', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
        description: 'SECOND SYNTHETIC RETAIL', issuerCategory: 'Shopping' }] });
    expect(createAmazonCategoryResolver(db()).snapshot().getCardDetail(row.id).match).toBe('held');
    expect(createAmazonCategoryResolver(db()).snapshot().resolve([]).size).toBe(0);
  });
  it('caches unchanged snapshots, invalidates across connections, and never caches rolled-back state', async () => {
    await approve();
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const resolver = createAmazonCategoryResolver(db()), first = resolver.snapshot();
    expect(resolver.snapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, 'version', 'caller-changed')).toBe(false);
    expect(Reflect.set(first, 'matchCounts', { linked: 999, held: 0 })).toBe(false);
    expect(Reflect.set(first, 'resolve', () => new Map())).toBe(false);
    expect(resolver.version).toBe(first.version);
    const other = new Database(path.join(dir, 'finance.db'));
    other.prepare("UPDATE amazon_category_mappings SET category='Synthetic'").run();
    other.prepare("INSERT INTO amazon_category_mappings VALUES('Synthetic source','Shopping',1)").run();
    other.close();
    const second = resolver.snapshot();
    expect(second).not.toBe(first);
    expect(second.version).not.toBe(first.version);
    expect(resolver.snapshot()).toBe(second);
    try {
      db().transaction(() => {
        db().prepare("UPDATE amazon_category_mappings SET category='Uncommitted'").run();
        expect(resolver.snapshot().version).not.toBe(second.version);
        throw Error('synthetic rollback');
      })();
    } catch { /* The synthetic rollback is the point of this check. */ }
    expect(resolver.snapshot().version).toBe(second.version);
  });
  it('never invents a destination for an unknown ledger instrument or a balance assumption', async () => {
    const capture = syntheticCapture();
    capture.staging.payments.push({ date: '2026-09-03', money: { currency: 'USD', amountMinor: 300 }, kind: 'refund', status: 'completed',
      method: { kind: 'unknown', network: 'unknown', last4: null }, orderIds: [], identity: 'native-row',
      provenance: { source: 'ledger', status: 'Refunded', page: 0, ordinal: 0 } });
    capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    capture.staging.coverage.refunds = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    const receipt = await importAmazonCapture(db(), capture, backup());
    expect(receipt.holds).toContainEqual({ reason: 'native-event-identity-unproven', count: 1 });
    expect(count('amazon_refunds')).toBe(1);
    expect(count('amazon_refund_destinations')).toBe(0);
    expect(count('amazon_refund_events')).toBe(1);
    expect(db().prepare('SELECT data_json FROM amazon_refund_events').pluck().get()).toContain('"destinations":[]');
    expect(count('amazon_subjects')).toBe(1); // Only the order-total relation, never a fake payment event.
  });
});
