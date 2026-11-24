import { describe, expect, it } from 'vitest';
import { largestRemainder, resolveSubject, validCategory } from './resolver.js';
import { opaque } from './policy.js';
import { syntheticRow, syntheticSubject } from './fixtures.testSupport.js';

describe('conserving contribution contract', () => {
  const one = opaque('item', 'one'), two = opaque('item', 'two');
  const allocation = (itemRef: string, amountMinor: number, sourceCategory = 'synthetic-source') => ({
    itemRef, amountMinor, currency: 'USD', attribution: 'explicit-payment-item' as const, sourceCategory,
  });
  const subject = () => syntheticSubject({ allocationComplete: true, allocations: [allocation(one, 600), allocation(two, 300)] });
  const resolve = (s = subject(), row = syntheticRow()) => resolveSubject(row, s,
    new Set(['Household']), new Map([['synthetic-source', 'Household']]), new Map([[one, 'Explicit new category']]));
  it('uses item override before reviewed mapping, plus explicit original-category residual', () => {
    const result = resolve();
    expect(result.kind).toBe('split');
    if (result.kind !== 'split') return;
    expect(result.contributions.map(p => [p.amountMinor, p.category, p.categorySource]))
      .toEqual([[600, 'Explicit new category', 'item-override'], [300, 'Household', 'reviewed-mapping'], [200, null, null]]);
    expect(result.contributions.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(1100);
  });
  it('conserves negative card refunds without positive credit parts', () => {
    const result = resolve({ ...subject(), money: { currency: 'USD', amountMinor: -1100 },
      allocations: [allocation(one, -600)] }, syntheticRow({ amountMinor: -1100, kind: 'refund' }));
    expect(result.kind === 'split' && result.contributions.every(p => p.amountMinor < 0)).toBe(true);
    expect(result.kind === 'split' && result.contributions.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(-1100);
  });
  it('never invents item attribution for partial item coverage, mixed tenders, or split charges', () => {
    expect(resolve({ ...subject(), allocationComplete: false })).toMatchObject({ kind: 'whole-row', reason: 'item-identity-unproven' });
    expect(resolve({ ...subject(), allocationComplete: false, tenderProof: 'mixed' }))
      .toMatchObject({ kind: 'whole-row', reason: 'mixed-tender-unproven' });
  });
  it('holds unsupported negative components, currencies, over-allocation and unsafe values', () => {
    expect(resolve({ ...subject(), allocations: [allocation(one, -1)] })).toMatchObject({ reason: 'negative-component' });
    expect(resolve({ ...subject(), allocations: [allocation(one, 1200)] })).toMatchObject({ reason: 'inconsistent-evidence' });
    expect(resolve({ ...subject(), allocations: [{ ...allocation(one, 500), currency: 'EUR' }] })).toMatchObject({ reason: 'currency-mismatch' });
    expect(resolve({ ...subject(), allocations: [allocation(one, Number.MAX_SAFE_INTEGER + 1)] })).toMatchObject({ reason: 'inconsistent-evidence' });
  });
  it('drops zero parts and never introduces unreviewed automatic categories', () => {
    const result = resolve({ ...subject(), allocations: [allocation(one, 0), allocation(two, 500, 'unreviewed')] });
    expect(result.kind === 'split' && result.contributions).toEqual([{ amountMinor: 1100, category: null,
      categorySource: null, classification: 'residual' }]);
  });
  it('largest-remainder ties are stable, exact and safe even with large products', () => {
    const weights = [{ ref: one, weight: Number.MAX_SAFE_INTEGER }, { ref: two, weight: Number.MAX_SAFE_INTEGER }];
    const result = largestRemainder(3, weights);
    expect([...result.values()].reduce((a, b) => a + b, 0)).toBe(3);
    expect(result.get([one, two].sort()[0])).toBe(2);
    expect(largestRemainder(3, weights.reverse())).toEqual(result);
  });
  it('guards user-created category text', () => {
    expect(validCategory('Explicit category')).toBe(true);
    for (const category of ['', ' Leading', '<tag>', 'Synthetic\nline', 'x'.repeat(101)]) expect(validCategory(category)).toBe(false);
  });
  it('gives item override precedence over closed-category agent classification, then reviewed mapping', () => {
    const s = subject(), categories = new Set(['Household', 'Electronics']);
    const result = resolveSubject(syntheticRow(), s, categories, new Map([['synthetic-source', 'Household']]),
      new Map([[one, 'Explicit new category']]), new Map([[one, 'Electronics'], [two, 'Electronics']]));
    expect(result.kind === 'split' && result.contributions.map(p => p.categorySource))
      .toEqual(['item-override', 'agent-classification', null]);
    expect(resolveSubject(syntheticRow(), s, categories, new Map(), new Map(), new Map([[one, 'Invented']])))
      .toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
  });
  it('keeps a privacy-held allocation uncategorized despite stale reviews, mappings or overrides', () => {
    const result = resolveSubject(syntheticRow(), subject(), new Set(['Household']),
      new Map([['synthetic-source', 'Household']]), new Map([[one, 'Owner category']]),
      new Map([[one, 'Household'], [two, 'Household']]), new Set([one]));
    expect(result.kind === 'split' && result.contributions).toEqual([
      { itemRef: two, amountMinor: 300, category: 'Household', categorySource: 'agent-classification', classification: 'source' },
      { amountMinor: 800, category: null, categorySource: null, classification: 'residual' },
    ]);
  });
});
