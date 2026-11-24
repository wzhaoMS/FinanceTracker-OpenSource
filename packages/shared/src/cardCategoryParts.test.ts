import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_CATEGORY_INVALID_REASONS,
  cardCategoryBasisMarkerFor,
  cardCategoryBasisWithoutSplits,
  cardCategoryPortion,
  cardCategorySplitView,
  largestCardCategory,
  resolveCardCategorySplits,
  type CardCategoryContribution,
  type CardCategoryEvidenceClass,
  type CardCategoryPart,
  type CardCategoryResolution,
  type CardCategoryResolverInput,
  type CardCategoryResolverSnapshot,
  type CardCategorySplitOptions,
  type CardCategorySplitRow,
} from './cardCategoryParts.js';
import { computeCardInsights, type CardInsightRow } from './cardInsights.js';
import { summarizeCardSpending, type CardSpendingRow } from './cardSpending.js';
import type { CardOwner } from './types.js';

// Synthetic rows and parts only: made-up ids, merchants, categories and amounts.

function splitRow(id: string, overrides: Partial<CardCategorySplitRow> = {}): CardCategorySplitRow {
  return { id, status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 10000, issuerCategory: 'Merchandise', userCategory: null, ...overrides };
}

const part = (amountMinor: number, category: string | null, extra: Partial<CardCategoryContribution> = {}): CardCategoryContribution => ({
  amountMinor,
  category,
  categorySource: category === null ? null : 'reviewed-mapping',
  classification: category === null ? 'residual' : 'source',
  ...extra,
});

const split = (id: string, contributions: CardCategoryContribution[], currency = 'USD', evidenceClass: CardCategoryEvidenceClass = 'payment-event'): CardCategoryResolution =>
  ({ kind: 'split', cardTransactionId: id, currency, evidenceClass, contributions });

/** A resolver snapshot that answers from a fixed map and records what it was asked. */
function snapshot(answers: Array<[string, unknown]>, version = 'rev-7'): CardCategoryResolverSnapshot & { asked: CardCategoryResolverInput[][] } {
  const asked: CardCategoryResolverInput[][] = [];
  return {
    version,
    asked,
    resolve(rows) {
      asked.push(rows.map((row) => ({ ...row })));
      return new Map(answers) as ReadonlyMap<string, CardCategoryResolution>;
    },
  };
}

const KNOWN = new Set(['Merchandise', 'Electronics', 'Home', 'Groceries']);

describe('payment-ledger allocation contract', () => {
  it('accepts the new evidence class and counts it independently while retaining partial refunds whole', () => {
    const rows = [splitRow('charge'), splitRow('refund', { kind: 'refund', amountMinor: -10000 })];
    const answers: Array<[string, CardCategoryResolution]> = [
      ['charge', split('charge', [part(10000, 'Home', { classification: 'policy-allocated', itemRef: 'synthetic-line' })],
        'USD', 'payment-ledger-complete')],
      ['refund', { kind: 'whole-row', cardTransactionId: 'refund', reason: 'refund-unattributed' }],
    ];
    const result = resolveCardCategorySplits(rows, options(snapshot(answers)));
    assert.equal(result.outcomes.get('charge')?.kind, 'split');
    assert.equal(result.outcomes.get('refund')?.kind, 'held');
    assert.ok(result.marker.splitRowsByEvidence.some(c => c.evidenceClass === 'payment-ledger-complete' && c.count === 1));
    assert.deepEqual(result.marker.heldOrDeclined, [{ reason: 'refund-unattributed', count: 1 }]);
  });
});

function options(snap: CardCategoryResolverSnapshot | null, overrides: Partial<CardCategorySplitOptions> = {}): CardCategorySplitOptions {
  return {
    requested: 'enriched',
    snapshot: snap,
    knownCategories: KNOWN,
    isAllowedCategoryName: (name) => !/\d{6}/.test(name),
    ...overrides,
  };
}

describe('resolveCardCategorySplits', () => {
  it('never asks the resolver for the original basis, and says so', () => {
    const snap = snapshot([['a', split('a', [part(10000, 'Home')])]]);
    const result = resolveCardCategorySplits([splitRow('a')], options(snap, { requested: 'original' }));
    assert.equal(result.parts.size, 0);
    assert.equal(snap.asked.length, 0);
    assert.deepEqual(result.marker, cardCategoryBasisWithoutSplits('original'));
    assert.deepEqual([result.marker.requested, result.marker.effective, result.marker.availability, result.marker.version],
      ['original', 'original', 'not-requested', 'original']);
  });

  it('is unavailable without a resolver: nothing split, never claimed as applied', () => {
    const result = resolveCardCategorySplits([splitRow('a')], options(null));
    assert.equal(result.parts.size, 0);
    assert.deepEqual(result.marker, {
      requested: 'enriched', effective: 'original', availability: 'unavailable', version: 'none',
      splitRows: 0, splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 0 }, { evidenceClass: 'unique-total-match', count: 0 },
        { evidenceClass: 'payment-ledger-complete', count: 0 }],
      keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [], policyAllocatedMinor: [], residualMinor: [],
    });
  });

  it('tells an empty answer apart from no resolver, and never claims a split it did not make', () => {
    const result = resolveCardCategorySplits([splitRow('a')], options(snapshot([])));
    assert.deepEqual([result.marker.requested, result.marker.effective, result.marker.availability, result.marker.version, result.marker.splitRows],
      ['enriched', 'original', 'available', 'rev-7', 0]);
    // Only holds and refusals: still the original amounts.
    const held = resolveCardCategorySplits([splitRow('a'), splitRow('b')], options(snapshot([
      ['a', { kind: 'whole-row', cardTransactionId: 'a', reason: 'match-held' }],
      ['b', split('b', [part(9999, 'Home')])],
    ])));
    assert.deepEqual([held.marker.effective, held.marker.availability, held.marker.splitRows], ['original', 'available', 0]);
    const applied = resolveCardCategorySplits([splitRow('a')], options(snapshot([['a', split('a', [part(10000, 'Home')])]])));
    assert.deepEqual([applied.marker.effective, applied.marker.splitRows], ['enriched', 1]);
  });

  it('asks only about posted purchases and refunds with an amount, by id, currency and amount', () => {
    const snap = snapshot([]);
    resolveCardCategorySplits([
      splitRow('purchase'),
      splitRow('refund', { kind: 'refund', amountMinor: -500 }),
      splitRow('custom', { userCategory: 'Gifts' }),
      splitRow('pending', { status: 'pending' }),
      splitRow('removed', { status: 'removed' }),
      splitRow('fee', { kind: 'fee' }),
      splitRow('interest', { kind: 'interest' }),
      splitRow('adjustment', { kind: 'adjustment', amountMinor: -500 }),
      splitRow('payment', { kind: 'payment', amountMinor: -500 }),
      splitRow('other', { kind: 'other' }),
      splitRow('zero', { amountMinor: 0 }),
    ], options(snap));
    assert.deepEqual(snap.asked, [[
      { id: 'purchase', currency: 'USD', amountMinor: 10000 },
      { id: 'refund', currency: 'USD', amountMinor: -500 },
      { id: 'custom', currency: 'USD', amountMinor: 10000 },
    ]]);
  });

  it('files the residual under the row\'s own category and totals policy and residual amounts per currency', () => {
    const result = resolveCardCategorySplits([
      splitRow('a'),
      splitRow('b', { kind: 'refund', amountMinor: -3000, issuerCategory: null, currency: 'EUR' }),
    ], options(snapshot([
      ['a', split('a', [
        part(6000, 'Electronics', { itemRef: 'item-1' }),
        part(1500, 'Electronics', { itemRef: 'item-1', classification: 'policy-allocated' }),
        part(2000, 'Gadgets', { categorySource: 'item-override', itemRef: 'item-2' }),
        part(500, null),
      ])],
      ['b', split('b', [part(-2000, 'Home', { itemRef: 'item-3' }), part(-1000, null)], 'EUR')],
    ])));
    assert.deepEqual(result.parts.get('a'), [
      { category: 'Electronics', amountMinor: 6000, categorySource: 'reviewed-mapping', classification: 'source', itemRef: 'item-1' },
      { category: 'Electronics', amountMinor: 1500, categorySource: 'reviewed-mapping', classification: 'policy-allocated', itemRef: 'item-1' },
      { category: 'Gadgets', amountMinor: 2000, categorySource: 'item-override', classification: 'source', itemRef: 'item-2' },
      { category: 'Merchandise', amountMinor: 500, categorySource: 'original-effective', classification: 'residual' },
    ]);
    assert.deepEqual(result.parts.get('b')?.map((item) => [item.category, item.amountMinor]), [['Home', -2000], ['Uncategorized', -1000]]);
    assert.equal(result.marker.splitRows, 2);
    assert.deepEqual(result.marker.policyAllocatedMinor, [{ currency: 'USD', amountMinor: 1500 }]);
    assert.deepEqual(result.marker.residualMinor, [{ currency: 'EUR', amountMinor: -1000 }, { currency: 'USD', amountMinor: 500 }]);
  });

  it('keeps a row with the owner\'s own category whole, and counts the source\'s own holds by reason', () => {
    const result = resolveCardCategorySplits([splitRow('custom', { userCategory: 'Gifts' }), splitRow('held'), splitRow('mixed'), splitRow('other-held')],
      options(snapshot([
        ['custom', split('custom', [part(10000, 'Home')])],
        ['held', { kind: 'whole-row', cardTransactionId: 'held', reason: 'match-held' }],
        ['mixed', { kind: 'whole-row', cardTransactionId: 'mixed', reason: 'mixed-tender-unproven' }],
        ['other-held', { kind: 'whole-row', cardTransactionId: 'other-held', reason: 'match-held' }],
      ])));
    assert.equal(result.parts.size, 0);
    assert.equal(result.marker.keptWholeByUserCategory, 1);
    assert.deepEqual(result.marker.heldOrDeclined, [{ reason: 'match-held', count: 2 }, { reason: 'mixed-tender-unproven', count: 1 }]);
    assert.deepEqual(result.marker.invalid, []);
  });

  it('refuses every malformed split under its fixed reason and keeps the row whole', () => {
    const cases: Array<[string, unknown, string, Partial<CardCategorySplitRow>?]> = [
      ['malformed', 'not a resolution', 'malformed'],
      ['malformed', { kind: 'other', cardTransactionId: 'x' }, 'malformed'],
      ['malformed', split('x', []), 'malformed'],
      ['malformed', { kind: 'split', cardTransactionId: 'x', currency: 'USD', evidenceClass: 'payment-event' }, 'malformed'],
      ['malformed', split('x', ['part' as never]), 'malformed'],
      ['no evidence class', { kind: 'split', cardTransactionId: 'x', currency: 'USD', contributions: [part(10000, 'Home')] }, 'bad-evidence-class'],
      ['unknown evidence class', split('x', [part(10000, 'Home')], 'USD', 'title-guess' as never), 'bad-evidence-class'],
      ['key-mismatch', split('y', [part(10000, 'Home')]), 'key-mismatch'],
      ['key-mismatch', { kind: 'whole-row', cardTransactionId: 'y', reason: 'match-held' }, 'key-mismatch'],
      ['bad-hold-reason', { kind: 'whole-row', cardTransactionId: 'x', reason: 'because' }, 'bad-hold-reason'],
      ['currency-mismatch', split('x', [part(10000, 'Home')], 'EUR'), 'currency-mismatch'],
      ['too-many-parts', split('x', Array.from({ length: 201 }, () => part(1, 'Home'))), 'too-many-parts'],
      ['incoherent: residual with a category', split('x', [part(10000, 'Home', { classification: 'residual' })]), 'incoherent-part'],
      ['incoherent: category without a source', split('x', [part(10000, 'Home', { categorySource: null })]), 'incoherent-part'],
      ['incoherent: residual with a source', split('x', [part(10000, null, { categorySource: 'item-override' })]), 'incoherent-part'],
      ['incoherent: unknown class', split('x', [part(10000, 'Home', { classification: 'guess' as never })]), 'incoherent-part'],
      ['incoherent: unknown source', split('x', [part(10000, 'Home', { categorySource: 'title' as never })]), 'incoherent-part'],
      ['duplicate item', split('x', [part(5000, 'Home', { itemRef: 'item-1' }), part(5000, 'Home', { itemRef: 'item-1' })]), 'duplicate-part'],
      ['two residuals', split('x', [part(5000, null), part(5000, null)]), 'duplicate-part'],
      ['residual item ref', split('x', [part(10000, null, { itemRef: 'item-1' })]), 'bad-item-ref'],
      ['item ref shape', split('x', [part(10000, 'Home', { itemRef: 'order 111-222' })]), 'bad-item-ref'],
      ['item ref length', split('x', [part(10000, 'Home', { itemRef: 'a'.repeat(65) })]), 'bad-item-ref'],
      ['zero part', split('x', [part(10000, 'Home'), part(0, 'Electronics')]), 'bad-amount'],
      ['fraction', split('x', [part(9999.5, 'Home'), part(0.5, 'Electronics')]), 'bad-amount'],
      ['unsafe', split('x', [part(2 ** 53, 'Home')]), 'bad-amount'],
      ['string amount', split('x', [part('10000' as never, 'Home')]), 'bad-amount'],
      ['negative part of a charge', split('x', [part(12000, 'Home'), part(-2000, 'Electronics')]), 'sign-mismatch'],
      ['positive part of a refund', split('x', [part(-12000, 'Home'), part(2000, 'Electronics')]), 'sign-mismatch', { kind: 'refund', amountMinor: -10000 }],
      ['short', split('x', [part(9999, 'Home')]), 'sum-mismatch'],
      ['long', split('x', [part(10000, 'Home'), part(1, null)]), 'sum-mismatch'],
      ['overflow', split('x', [part(Number.MAX_SAFE_INTEGER, 'Home'), part(Number.MAX_SAFE_INTEGER, 'Electronics')]), 'sum-mismatch'],
      ['empty category', split('x', [part(10000, '', { categorySource: 'item-override' })]), 'bad-category'],
      ['padded category', split('x', [part(10000, ' Home', { categorySource: 'item-override' })]), 'bad-category'],
      ['long category', split('x', [part(10000, 'H'.repeat(101), { categorySource: 'item-override' })]), 'bad-category'],
      ['card data in a category', split('x', [part(10000, 'Gift 3959596348', { categorySource: 'item-override' })]), 'bad-category'],
      ['mapping invents a name', split('x', [part(10000, 'Brand New')]), 'unknown-mapped-category'],
      ['agent invents a name', split('x', [part(10000, 'Brand New', { categorySource: 'agent-classification' })]), 'unknown-mapped-category'],
    ];
    for (const [name, resolution, reason, rowOverrides] of cases) {
      const result = resolveCardCategorySplits([splitRow('x', rowOverrides)], options(snapshot([['x', resolution]])));
      assert.equal(result.parts.size, 0, name);
      assert.equal(result.marker.splitRows, 0, name);
      assert.deepEqual(result.marker.invalid, [{ reason, count: 1 }], name);
      assert.ok((CARD_CATEGORY_INVALID_REASONS as readonly string[]).includes(reason), name);
    }
  });

  it('lets an item override name a new category, but never an agent classification or a reviewed mapping', () => {
    const accepted = resolveCardCategorySplits([splitRow('x')],
      options(snapshot([['x', split('x', [part(10000, 'Brand New', { categorySource: 'item-override' })])]])));
    assert.deepEqual(accepted.parts.get('x')?.map((item) => item.category), ['Brand New']);
    // An agent classifies items into the household's categories in use.
    const agent = resolveCardCategorySplits([splitRow('y')], options(snapshot([['y', split('y', [
      part(7000, 'Electronics', { categorySource: 'agent-classification', itemRef: 'item-1' }),
      part(3000, 'Home', { itemRef: 'item-2' }),
    ])]])));
    assert.deepEqual(agent.parts.get('y')?.map((item) => [item.category, item.categorySource]),
      [['Electronics', 'agent-classification'], ['Home', 'reviewed-mapping']]);
  });

  it('accepts an Amazon Fresh line\'s part sources, each naming one of the household\'s categories, like an agent\'s', () => {
    const fresh = resolveCardCategorySplits([splitRow('f')], options(snapshot([['f', split('f', [
      part(7000, 'Home', { categorySource: 'item-taxonomy', classification: 'policy-allocated', itemRef: 'line-1' }),
      part(3000, 'Electronics', { categorySource: 'fresh-default', classification: 'policy-allocated', itemRef: 'line-2' }),
    ])]])));
    assert.deepEqual(fresh.parts.get('f')?.map((item) => [item.category, item.categorySource, item.classification]),
      [['Home', 'item-taxonomy', 'policy-allocated'], ['Electronics', 'fresh-default', 'policy-allocated']]);
    const invented = resolveCardCategorySplits([splitRow('g')],
      options(snapshot([['g', split('g', [part(10000, 'Brand New', { categorySource: 'item-taxonomy' })])]])));
    assert.equal(invented.parts.size, 0);
    assert.deepEqual(invented.marker.invalid, [{ reason: 'unknown-mapped-category', count: 1 }]);
  });

  it('refuses a split the source itself does not link, and lists no parts for it', () => {
    const answers = snapshot([
      ['linked', split('linked', [part(10000, 'Home')])],
      ['held', split('held', [part(10000, 'Home')])],
      ['custom', split('custom', [part(10000, 'Home')])],
      ['held-whole', { kind: 'whole-row', cardTransactionId: 'held-whole', reason: 'match-held' }],
    ]);
    const asked: string[] = [];
    const result = resolveCardCategorySplits([
      splitRow('linked'), splitRow('held'), splitRow('custom', { userCategory: 'Gifts' }), splitRow('held-whole'),
    ], options(answers, { isLinkedRow: (id) => { asked.push(id); return id === 'linked'; } }));
    assert.deepEqual([...result.parts.keys()], ['linked']);
    assert.deepEqual(result.outcomes.get('held'), { kind: 'invalid', reason: 'not-linked' });
    // The owner's category still keeps it whole, and nothing of an unlinked row's parts is kept for its detail.
    assert.deepEqual(result.outcomes.get('custom'), { kind: 'kept-whole-by-user-category' });
    assert.deepEqual(result.outcomes.get('held-whole'), { kind: 'held', reason: 'match-held' });
    assert.deepEqual(result.marker.invalid, [{ reason: 'not-linked', count: 1 }]);
    // Asked only about splits.
    assert.deepEqual(asked.sort(), ['custom', 'held', 'linked']);
  });

  it('counts split rows by how their order was tied to them, both classes always', () => {
    const result = resolveCardCategorySplits([splitRow('event'), splitRow('total'), splitRow('also-total'), splitRow('held')], options(snapshot([
      ['event', split('event', [part(10000, 'Home')])],
      ['total', split('total', [part(10000, 'Electronics')], 'USD', 'unique-total-match')],
      ['also-total', split('also-total', [part(10000, 'Home')], 'USD', 'unique-total-match')],
      ['held', { kind: 'whole-row', cardTransactionId: 'held', reason: 'item-identity-unproven' }],
    ])));
    assert.deepEqual(result.outcomes.get('total'), {
      kind: 'split', currency: 'USD', evidenceClass: 'unique-total-match',
      parts: [{ category: 'Electronics', amountMinor: 10000, categorySource: 'reviewed-mapping', classification: 'source' }],
    });
    assert.deepEqual([result.marker.splitRows, result.marker.splitRowsByEvidence], [3, [
      { evidenceClass: 'payment-event', count: 1 }, { evidenceClass: 'unique-total-match', count: 2 }, { evidenceClass: 'payment-ledger-complete', count: 0 },
    ]]);
    // Under a category, only rows with a part in it; with none, both classes at zero.
    assert.deepEqual(cardCategoryBasisMarkerFor(result, ['event', 'total', 'also-total'], 'Home').splitRowsByEvidence, [
      { evidenceClass: 'payment-event', count: 1 }, { evidenceClass: 'unique-total-match', count: 1 }, { evidenceClass: 'payment-ledger-complete', count: 0 },
    ]);
    assert.deepEqual(cardCategoryBasisMarkerFor(result, ['held']).splitRowsByEvidence, [
      { evidenceClass: 'payment-event', count: 0 }, { evidenceClass: 'unique-total-match', count: 0 }, { evidenceClass: 'payment-ledger-complete', count: 0 },
    ]);
  });

  it('ignores answers about rows it did not ask for, counted apart from rows that cannot split', () => {
    const result = resolveCardCategorySplits([splitRow('a'), splitRow('pending', { status: 'pending' })], options(snapshot([
      ['stranger', split('stranger', [part(10000, 'Home')])],
      ['pending', split('pending', [part(10000, 'Home')])],
    ])));
    assert.equal(result.parts.size, 0);
    assert.deepEqual(result.marker.invalid, [{ reason: 'not-eligible', count: 1 }, { reason: 'not-in-scope', count: 1 }]);
  });

  it('counts in a marker only what its answer reports: the rows it shows, and under a category their parts in it', () => {
    const result = resolveCardCategorySplits([
      splitRow('a'),
      splitRow('b', { currency: 'EUR', amountMinor: 4000 }),
      splitRow('held'),
      splitRow('custom', { userCategory: 'Gifts' }),
      splitRow('bad'),
      splitRow('pending', { status: 'pending' }),
    ], options(snapshot([
      ['a', split('a', [
        part(6000, 'Electronics', { itemRef: 'item-1' }),
        part(1000, 'Home', { itemRef: 'item-2', classification: 'policy-allocated' }),
        part(3000, null),
      ])],
      ['b', split('b', [part(4000, 'Home', { itemRef: 'item-3' })], 'EUR')],
      ['held', { kind: 'whole-row', cardTransactionId: 'held', reason: 'match-held' }],
      ['custom', split('custom', [part(10000, 'Home')])],
      ['bad', split('bad', [part(1, 'Home')])],
      ['pending', split('pending', [part(10000, 'Home')])],
      ['stranger', split('stranger', [part(10000, 'Home')])],
    ])));
    assert.deepEqual(result.outcomes.get('a')?.kind, 'split');
    assert.deepEqual(result.outcomes.get('held'), { kind: 'held', reason: 'match-held' });
    // Kept whole by the owner's category: its valid parts stay for its detail, never for reports.
    assert.deepEqual(result.outcomes.get('custom'), {
      kind: 'kept-whole-by-user-category',
      parts: [{ category: 'Home', amountMinor: 10000, categorySource: 'reviewed-mapping', classification: 'source' }],
    });
    assert.equal(result.parts.has('custom'), false);
    assert.deepEqual(result.outcomes.get('bad'), { kind: 'invalid', reason: 'sum-mismatch' });
    assert.deepEqual(result.outcomes.get('pending'), { kind: 'invalid', reason: 'not-eligible' });
    // Every row given.
    assert.deepEqual([result.marker.splitRows, result.marker.keptWholeByUserCategory, result.marker.effective], [2, 1, 'enriched']);
    assert.deepEqual(result.marker.invalid, [
      { reason: 'not-eligible', count: 1 }, { reason: 'not-in-scope', count: 1 }, { reason: 'sum-mismatch', count: 1 },
    ]);
    // Only the EUR row: its split, nothing of the USD rows; an answer about a row the request does not have is the
    // request's, one about the pending row is that row's.
    const eur = cardCategoryBasisMarkerFor(result, ['b']);
    assert.deepEqual(eur, {
      requested: 'enriched', effective: 'enriched', availability: 'available', version: 'rev-7',
      splitRows: 1, splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 1 }, { evidenceClass: 'unique-total-match', count: 0 },
        { evidenceClass: 'payment-ledger-complete', count: 0 }],
      keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [{ reason: 'not-in-scope', count: 1 }],
      policyAllocatedMinor: [], residualMinor: [],
    });
    assert.deepEqual(cardCategoryBasisMarkerFor(result, ['pending']).invalid,
      [{ reason: 'not-eligible', count: 1 }, { reason: 'not-in-scope', count: 1 }]);
    // Under a category: the parts in it only.
    const home = cardCategoryBasisMarkerFor(result, ['a', 'b'], 'Home');
    assert.deepEqual([home.splitRows, home.policyAllocatedMinor, home.residualMinor],
      [2, [{ currency: 'USD', amountMinor: 1000 }], []]);
    const residual = cardCategoryBasisMarkerFor(result, ['a'], 'Merchandise');
    assert.deepEqual([residual.splitRows, residual.residualMinor], [1, [{ currency: 'USD', amountMinor: 3000 }]]);
    // A split row with no part in the category is not in that answer; whole rows count by their outcome.
    const none = cardCategoryBasisMarkerFor(result, ['a', 'held', 'bad'], 'Groceries');
    assert.deepEqual([none.effective, none.splitRows, none.heldOrDeclined, none.invalid], [
      'original', 0, [{ reason: 'match-held', count: 1 }], [{ reason: 'not-in-scope', count: 1 }, { reason: 'sum-mismatch', count: 1 }],
    ]);
    // Without a resolver, any scope gets the same marker.
    const unavailable = resolveCardCategorySplits([splitRow('a')], options(null));
    assert.deepEqual(cardCategoryBasisMarkerFor(unavailable, ['a'], 'Home'), cardCategoryBasisWithoutSplits('enriched'));
  });

  it('surfaces a failing resolver instead of reading it as no splits', () => {
    const throwing: CardCategoryResolverSnapshot = { version: 'rev-1', resolve() { throw new Error('source unavailable'); } };
    assert.throws(() => resolveCardCategorySplits([splitRow('a')], options(throwing)), /source unavailable/);
    const notMap: CardCategoryResolverSnapshot = { version: 'rev-1', resolve: () => ({}) as never };
    assert.throws(() => resolveCardCategorySplits([splitRow('a')], options(notMap)), /did not answer with a map/);
    const noVersion = { version: '', resolve: () => new Map() } as CardCategoryResolverSnapshot;
    assert.throws(() => resolveCardCategorySplits([splitRow('a')], options(noVersion)), /no version/);
  });
});

describe('split views', () => {
  const parts: CardCategoryPart[] = [
    { category: 'Home', amountMinor: 3000, categorySource: 'reviewed-mapping', classification: 'source' },
    { category: 'Electronics', amountMinor: 2500, categorySource: 'reviewed-mapping', classification: 'source' },
    { category: 'Electronics', amountMinor: 1000, categorySource: 'reviewed-mapping', classification: 'policy-allocated' },
    { category: 'Garden', amountMinor: 3500, categorySource: 'item-override', classification: 'source' },
  ];

  it('adds parts up per category, largest first with ties by name', () => {
    assert.deepEqual(cardCategorySplitView(parts), [
      { category: 'Electronics', amountMinor: 3500 },
      { category: 'Garden', amountMinor: 3500 },
      { category: 'Home', amountMinor: 3000 },
    ]);
    // The largest category once added up, not the largest single part (Garden's one part is the largest).
    assert.equal(largestCardCategory(parts), 'Electronics');
    assert.equal(cardCategoryPortion(parts, 'Electronics'), 3500);
    assert.equal(cardCategoryPortion(parts, 'Travel'), 0);
  });
});

const owners = new Map<string, CardOwner>([['card-a', 'alex'], ['card-b', 'casey']]);

function spendingRow(id: string, overrides: Partial<CardSpendingRow> = {}): CardSpendingRow {
  return {
    id, cardAccountId: 'card-a', transactionDate: '2026-09-10', status: 'posted', amountMinor: 10000, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE STORE', merchant: null, issuerCategory: 'Merchandise', userCategory: null, ...overrides,
  };
}

describe('summarizeCardSpending with category parts', () => {
  const rows = [
    spendingRow('a', { amountMinor: 10000 }),
    spendingRow('b', { amountMinor: -4000, kind: 'refund', cardAccountId: 'card-b', transactionDate: '2026-10-02' }),
    spendingRow('c', { amountMinor: 2500, issuerCategory: 'Groceries', description: 'SAMPLE GROCER' }),
    spendingRow('d', { amountMinor: 900, status: 'pending' }),
    spendingRow('e', { amountMinor: -20000, kind: 'payment' }),
    spendingRow('f', { amountMinor: 300, kind: 'fee', issuerCategory: 'Fees' }),
  ];
  const parts = new Map<string, CardCategoryPart[]>([
    ['a', [
      { category: 'Electronics', amountMinor: 6000, categorySource: 'reviewed-mapping', classification: 'source' },
      { category: 'Home', amountMinor: 3000, categorySource: 'reviewed-mapping', classification: 'source' },
      { category: 'Merchandise', amountMinor: 1000, categorySource: 'original-effective', classification: 'residual' },
    ]],
    ['b', [
      { category: 'Home', amountMinor: -3000, categorySource: 'reviewed-mapping', classification: 'source' },
      { category: 'Merchandise', amountMinor: -1000, categorySource: 'original-effective', classification: 'residual' },
    ]],
    // Parts of a row that is not in view change nothing.
    ['zz', [{ category: 'Travel', amountMinor: 1, categorySource: 'reviewed-mapping', classification: 'source' }]],
  ]);
  const plain = summarizeCardSpending(rows, { owners });
  const split = summarizeCardSpending(rows, { owners, categoryParts: parts });

  it('changes only the categories, and they still add up to the totals', () => {
    const { byCategory: plainCategories, ...plainRest } = plain;
    const { byCategory: splitCategories, ...splitRest } = split;
    assert.deepEqual(splitRest, plainRest);
    assert.notDeepEqual(splitCategories, plainCategories);
    for (const field of ['spendingMinor', 'chargesMinor', 'creditsMinor'] as const) {
      assert.equal(splitCategories.reduce((sum, item) => sum + item[field], 0), split.totals[0][field], field);
    }
  });

  it('files each part under its category, counting a split row once in each', () => {
    assert.deepEqual(split.byCategory.map((item) => [item.category, item.spendingMinor, item.chargesMinor, item.creditsMinor, item.count]), [
      ['Electronics', 6000, 6000, 0, 1],
      ['Groceries', 2500, 2500, 0, 1],
      ['Fees', 300, 300, 0, 1],
      ['Home', 0, 3000, -3000, 2],
      ['Merchandise', 0, 1000, -1000, 2],
    ]);
  });
});

describe('computeCardInsights with category parts', () => {
  let next = 0;
  function tx(transactionDate: string, amountMinor: number, description: string, extra: Partial<CardInsightRow> = {}): CardInsightRow {
    next += 1;
    return {
      id: `card-txn-${next}`, cardAccountId: 'card-a', transactionDate, status: 'posted', amountMinor, currency: 'USD',
      kind: amountMinor < 0 ? 'refund' : 'purchase', description, merchant: null, issuerCategory: null, userCategory: null, ...extra,
    };
  }
  const options = { month: '2026-10', today: '2026-10-16', currency: 'USD' };
  const asParts = (entries: Array<[string, number]>): CardCategoryPart[] => entries.map(([category, amountMinor]) =>
    ({ category, amountMinor, categorySource: 'reviewed-mapping' as const, classification: 'source' as const }));

  it('moves categories by their parts, with the merchants behind them', () => {
    const cat = (date: string, amount: number, category: string) => tx(date, amount, `SAMPLE ${category.toUpperCase()}`, { issuerCategory: category });
    const rows = [
      ...['2026-06', '2026-07', '2026-08'].flatMap((month) => [
        cat(`${month}-10`, 10000, 'Dining'), cat(`${month}-11`, 10000, 'Groceries'), cat(`${month}-12`, 20000, 'Shopping'),
      ]),
      cat('2026-09-10', 30000, 'Dining'),
      cat('2026-09-11', 10500, 'Groceries'),
      cat('2026-09-15', 8000, 'Travel'),
    ];
    const plain = computeCardInsights(rows, { ...options, month: '2026-09' });
    assert.deepEqual(plain.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Dining', 20000], ['Shopping', -20000], ['Travel', 8000]]);
    // September's dining charge was really 10,000 of dining and 20,000 of shopping.
    const dining = rows.find((row) => row.transactionDate === '2026-09-10')!;
    const split = computeCardInsights(rows, {
      ...options, month: '2026-09', categoryParts: new Map([[dining.id, asParts([['Dining', 10000], ['Shopping', 20000]])]]),
    });
    assert.deepEqual(split.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Travel', 8000]]);
    // Everything that is not about categories stays as it was.
    const { movers: plainMovers, ...plainRest } = plain;
    const { movers: splitMovers, ...splitRest } = split;
    assert.deepEqual(splitRest, plainRest);
    assert.notDeepEqual(splitMovers, plainMovers);
  });

  it('names a large purchase by the category its parts add up to most, with its split, and keeps its whole amount', () => {
    const cafe = ['2026-08-05', '2026-09-05'].map((date) => tx(date, 5000, 'SAMPLE CAFE'));
    const tv = tx('2026-10-06', 200000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' });
    const rows = [...cafe, tx('2026-10-05', 10000, 'SAMPLE CAFE'), tv];
    const parts = asParts([['Home', 90000], ['Electronics', 60000], ['Electronics', 50000]]);
    const read = new Map<string, boolean>();
    const { largePurchases } = computeCardInsights(rows, {
      ...options, categoryParts: new Map([[tv.id, parts]]), onCategoryRead: (id, throughParts) => read.set(id, throughParts),
    });
    assert.deepEqual(largePurchases?.items.map((item) => [item.id, item.amountMinor, item.category, item.split]), [
      [tv.id, 200000, 'Electronics', [{ category: 'Electronics', amountMinor: 110000 }, { category: 'Home', amountMinor: 90000 }]],
    ]);
    // Read through its parts; the café in the period and its baseline, whole.
    assert.deepEqual(read, new Map<string, boolean>([[tv.id, true], [cafe[1].id, false], [rows[2].id, false]]));
    const tie = computeCardInsights(rows, { ...options, categoryParts: new Map([[tv.id, asParts([['Home', 100000], ['Garden', 100000]])]]) });
    assert.equal(tie.largePurchases?.items[0].category, 'Garden');
    const whole = computeCardInsights(rows, options);
    assert.deepEqual([whole.largePurchases?.items[0].category, 'split' in (whole.largePurchases?.items[0] ?? {})], ['Electronics', false]);
  });

  it('keeps a refund partly set against large purchases whole in the movers', () => {
    const cafe = ['2026-08-05', '2026-09-05'].map((date) => tx(date, 5000, 'SAMPLE CAFE'));
    const pair = [tx('2026-10-06', 100000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' }), tx('2026-10-07', 100000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' })];
    const refund = tx('2026-10-12', -230000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' });
    const rows = [...cafe, tx('2026-10-05', 10000, 'SAMPLE CAFE'), ...pair, refund];
    const read = new Map<string, boolean>();
    const insights = computeCardInsights(rows, {
      ...options,
      categoryParts: new Map([[refund.id, asParts([['Home', -200000], ['Garden', -30000]])]]),
      onCategoryRead: (id, throughParts) => read.set(id, throughParts),
    });
    // Its 30,000 left after the two purchases is a different amount than its parts: it stays an Electronics refund.
    assert.deepEqual(insights.movers.map((mover) => [mover.category, mover.deltaMinor]), [['Electronics', -30000], ['Uncategorized', 5000]]);
    // What the answer read: the period's and the baseline's everyday rows, the refund under its own category (the
    // purchases, refunded in full, are no large purchases, and August is in neither range).
    assert.deepEqual(read, new Map<string, boolean>([[cafe[1].id, false], [rows[2].id, false], [refund.id, false]]));
  });

  it('reads no mover categories without a baseline to compare with', () => {
    const tv = tx('2026-10-06', 200000, 'SAMPLE TV STORE', { issuerCategory: 'Electronics' });
    const rows = [tx('2026-08-05', 5000, 'SAMPLE CAFE'), tx('2026-10-05', 10000, 'SAMPLE CAFE'), tv];
    const read = new Map<string, boolean>();
    computeCardInsights(rows, {
      ...options,
      period: { from: '2026-10-01', to: '2026-10-16', baseline: null },
      categoryParts: new Map([[tv.id, asParts([['Home', 200000]])]]),
      onCategoryRead: (id, throughParts) => read.set(id, throughParts),
    });
    assert.deepEqual([...read], [[tv.id, true]]);
  });

  it('hides a new category made only of first charges at new merchants, by their parts too', () => {
    const history = ['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05', '2026-07-05'].map((date) => tx(date, 5000, 'SAMPLE MART', { issuerCategory: 'Groceries' }));
    const tailor = tx('2026-10-10', 30000, 'SAMPLE TAILOR', { issuerCategory: 'Services' });
    const rows = [tx('2026-01-02', 3000, 'SAMPLE BAKERY'), ...history, tx('2026-09-05', 20000, 'SAMPLE MART', { issuerCategory: 'Groceries' }), tailor];
    const plain = computeCardInsights(rows, options);
    assert.deepEqual(plain.newMerchants.map((item) => item.merchant), ['SAMPLE TAILOR']);
    assert.equal(plain.movers.some((mover) => mover.category === 'Services'), false);
    const split = computeCardInsights(rows, { ...options, categoryParts: new Map([[tailor.id, asParts([['Hobbies', 20000], ['Services', 10000]])]]) });
    assert.equal(split.movers.some((mover) => mover.category === 'Hobbies' || mover.category === 'Services'), false);
  });
});
