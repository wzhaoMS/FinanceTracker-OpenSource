import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ITEM_TAXONOMY_BP_SCALE as SCALE,
  ITEM_TAXONOMY_MIN_AGENT_BP as MIN,
  ITEM_TAXONOMY_RESIDUAL as RESIDUAL,
  ITEM_TAXONOMY_V2_DIGEST,
} from '@finance-tracker/shared';

import {
  RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT,
  RETAIL_TAXONOMY_MAPPING_FORMAT,
  RETAIL_TAXONOMY_WORKLIST_FORMAT,
  adoptRetailTaxonomyAssignments,
  emptyRetailTaxonomyWorklist,
  retailDepartmentKey,
  retailProductKey,
  retailTaxonomyAssignmentsOf,
  retailTaxonomyMappingOf,
  retailTaxonomyWorklistOf,
  serializeRetailTaxonomyMapping,
  serializeRetailTaxonomyWorklist,
  type RetailTaxonomyWorklist,
  type RetailTaxonomyWorklistProduct,
} from './index.js';
import { refusalOf } from '../../testing/retailDb.js';

// The retail taxonomy's private files (Costco 3/7 plan v5 §6, §10 "Files"): exact keys, types, sort and uniqueness, the
// source × kind matrix, withdrawals, nodes, the worklist binding, and `adopt`. Synthetic values only.

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const KEYS = ['100100', '100101', '100102'].map((itemNumber) => ({ itemNumber, key: retailProductKey('costco', itemNumber) }))
  .sort((a, b) => (a.key < b.key ? -1 : 1));
const [A, B, C] = KEYS.map(({ key }) => key);
const DEPARTMENT = retailDepartmentKey('costco', 12);
const DECISION = '5a'.repeat(16);
const codeOf = (fn: () => unknown) => refusalOf(fn).code;

const mapping = (entries: unknown[], patch: Record<string, unknown> = {}) => ({
  format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 2, reviewed: true, decisionId: DECISION, entries, ...patch,
});
const entry = (patch: Record<string, unknown> = {}) => ({ subjectKind: 'product', subjectKey: A, source: 'agent', node: 'household', confidenceBp: MIN,
  ...patch });

function worklistProduct(itemNumber: string, key: string): RetailTaxonomyWorklistProduct {
  return {
    subjectKey: key, merchant: 'costco', itemNumber, titles: [{ title: 'SAMPLE WIDGET', title2: null }], channels: ['warehouse'], lines: 1,
    titleRuleLines: 0, current: { node: RESIDUAL, source: null, confidenceBp: null, suggested: false, suggestion: null },
    byDepartment: [{ department: 12, lines: 1, reviewed: null }],
  };
}
const worklist = (): RetailTaxonomyWorklist => ({
  ...emptyRetailTaxonomyWorklist(),
  products: KEYS.slice(0, 2).map(({ itemNumber, key }) => worklistProduct(itemNumber, key)),
  departments: [{ subjectKey: DEPARTMENT, merchant: 'costco', department: 12, lines: 2, products: 2, current: null }],
  coverage: { withProduct: 2, withoutProduct: 0, titleRule: 0 },
});
const assignments = (products: unknown[], patch: Record<string, unknown> = {}) => ({
  format: RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT, version: 1, taxonomyVersion: 2, generatedAt: '2031-03-01T12:00:00Z',
  inputs: { worklistSha256: sha256(serializeRetailTaxonomyWorklist(worklist())) }, products, ...patch,
});

describe('retail taxonomy mapping (§6.3)', () => {
  it('reads a reviewed mapping: products by the owner or an agent, departments by review, withdrawals as null nodes', () => {
    const value = mapping([
      entry({ subjectKind: 'department', subjectKey: DEPARTMENT, source: 'department-review', node: 'home-kitchen', confidenceBp: null }),
      entry({ source: 'agent', node: 'household', confidenceBp: SCALE }),
      entry({ source: 'owner', node: RESIDUAL, confidenceBp: null }),
      entry({ subjectKey: B, source: 'agent', node: null, confidenceBp: null }),
      entry({ subjectKey: B, source: 'owner', node: null, confidenceBp: null }),
    ]);
    const read = retailTaxonomyMappingOf(value);
    expect(read.entries.map((one) => [one.subjectKind, one.source, one.node, one.confidenceBp])).toEqual([
      ['department', 'department-review', 'home-kitchen', null], ['product', 'agent', 'household', SCALE], ['product', 'owner', RESIDUAL, null],
      ['product', 'agent', null, null], ['product', 'owner', null, null],
    ]);
    expect(JSON.parse(serializeRetailTaxonomyMapping(read))).toEqual(value);
  });

  it('refuses every key set but its own, every type but its own, and a decisionId that is not 32 lowercase hex', () => {
    const refused: Array<[string, unknown]> = [
      ['an extra top-level key', { ...mapping([entry()]), note: 'x' }],
      ['a missing top-level key', (({ reviewed: _reviewed, ...rest }) => rest)(mapping([entry()]))],
      ['an extra entry key', mapping([{ ...entry(), title: 'x' }])],
      ['a missing entry key', mapping([(({ confidenceBp: _bp, ...rest }) => rest)(entry())])],
      ['another format', mapping([entry()], { format: 'holdr.amazon-taxonomy-mapping' })],
      ['another version', mapping([entry()], { version: 2 })],
      ['the v1 tree', mapping([entry()], { taxonomyVersion: 1 })],
      ['the version as text', mapping([entry()], { taxonomyVersion: '2' })],
      ['not reviewed', mapping([entry()], { reviewed: false })],
      ['no decisionId', mapping([entry()], { decisionId: null })],
      ['an uppercase decisionId', mapping([entry()], { decisionId: DECISION.toUpperCase() })],
      ['a short decisionId', mapping([entry()], { decisionId: DECISION.slice(2) })],
      ['no entry', mapping([])],
      ['an unknown kind', mapping([entry({ subjectKind: 'line' })])],
      ['an unknown source', mapping([entry({ source: 'classifier' })])],
      ['a key in hex', mapping([entry({ subjectKey: 'a'.repeat(63) + '0' })])],
      ['a node that is no string', mapping([entry({ node: { top: 'Household Supplies', sub: 'Cleaning' } })])],
      ['basis points as a fraction', mapping([entry({ confidenceBp: 0.6 })])],
      ['basis points above the scale', mapping([entry({ confidenceBp: SCALE + 1 })])],
      ['negative basis points', mapping([entry({ confidenceBp: -1 })])],
      ['basis points as text', mapping([entry({ confidenceBp: String(MIN) })])],
      ['entries out of order', mapping([entry({ subjectKey: B }), entry({ subjectKey: A })])],
      ['an entry twice', mapping([entry(), entry({ node: 'garden-patio' })])],
      ['sources out of order', mapping([entry({ source: 'owner', node: 'groceries', confidenceBp: null }), entry()])],
      ['not an object', [entry()]],
    ];
    for (const [what, value] of refused) expect(codeOf(() => retailTaxonomyMappingOf(value)), what).toBe('retail-taxonomy-file-invalid');
  });

  it('refuses a source on the wrong kind of subject, and a confidence where its source takes none (the source × kind matrix)', () => {
    const matrix: Array<[string, Record<string, unknown>, string]> = [
      ['an agent on a department', { subjectKind: 'department', subjectKey: DEPARTMENT, source: 'agent' }, 'retail-taxonomy-source-invalid'],
      ['the owner on a department', { subjectKind: 'department', subjectKey: DEPARTMENT, source: 'owner', confidenceBp: null }, 'retail-taxonomy-source-invalid'],
      ['a department review on a product', { source: 'department-review', confidenceBp: null }, 'retail-taxonomy-source-invalid'],
      ['the owner with a confidence', { source: 'owner', confidenceBp: SCALE }, 'retail-taxonomy-source-invalid'],
      ['a department review with a confidence', { subjectKind: 'department', subjectKey: DEPARTMENT, source: 'department-review' },
        'retail-taxonomy-source-invalid'],
      ['an agent node without a confidence', { confidenceBp: null }, 'retail-taxonomy-source-invalid'],
      ['an agent withdrawal with a confidence', { node: null }, 'retail-taxonomy-source-invalid'],
      ['an agent on a product', {}, 'none'],
      ['the owner on a product', { source: 'owner', confidenceBp: null }, 'none'],
      ['a department review on a department', { subjectKind: 'department', subjectKey: DEPARTMENT, source: 'department-review', confidenceBp: null }, 'none'],
      ['an agent withdrawal', { node: null, confidenceBp: null }, 'none'],
      ['an agent at zero', { confidenceBp: 0 }, 'none'],
      ['an agent at the scale', { confidenceBp: SCALE }, 'none'],
    ];
    for (const [what, patch, code] of matrix) expect(codeOf(() => retailTaxonomyMappingOf(mapping([entry(patch)]))), what).toBe(code);
  });

  it('refuses a node the v2 tree lacks, labels included, once the shape and sources are checked', () => {
    for (const node of ['Groceries', 'Household Supplies', 'groceries/meat', 'pantry', 'needs review', 'precious_metals']) {
      expect(codeOf(() => retailTaxonomyMappingOf(mapping([entry({ node })]))), node).toBe('retail-taxonomy-node-unknown');
    }
    // The shape refuses first: a bad entry anywhere is the file's shape, whatever node another names.
    expect(codeOf(() => retailTaxonomyMappingOf(mapping([entry({ node: 'Groceries' }), entry({ subjectKey: B, confidenceBp: 0.5 })]))))
      .toBe('retail-taxonomy-file-invalid');
    for (const node of ['groceries', 'automotive/fuel', 'memberships-fees', 'precious-metals', RESIDUAL]) {
      expect(retailTaxonomyMappingOf(mapping([entry({ node })])).entries[0].node, node).toBe(node);
    }
  });
});

describe('retail taxonomy classifier output (§6.2) and adopt', () => {
  it('reads v2 node ids in integer basis points, one per product, sorted, and refuses anything else', () => {
    const products = [{ subjectKey: A, node: 'household', confidenceBp: MIN }, { subjectKey: B, node: RESIDUAL, confidenceBp: SCALE }];
    expect(retailTaxonomyAssignmentsOf(assignments(products)).products).toEqual(products);
    const refused: Array<[string, unknown, string]> = [
      ['an extra key', { ...assignments(products), notes: [] }, 'retail-taxonomy-file-invalid'],
      ['another format', assignments(products, { format: 'holdr.amazon-taxonomy-assignments' }), 'retail-taxonomy-file-invalid'],
      ['the v1 tree', assignments(products, { taxonomyVersion: 'v1' }), 'retail-taxonomy-file-invalid'],
      ['no time', assignments(products, { generatedAt: 'yesterday' }), 'retail-taxonomy-file-invalid'],
      ['a worklist digest in letters', assignments(products, { inputs: { worklistSha256: 'a'.repeat(64) + 'q' } }), 'retail-taxonomy-file-invalid'],
      ['no product', assignments([]), 'retail-taxonomy-file-invalid'],
      ['a float confidence', assignments([{ ...products[0], confidenceBp: 0.75 }]), 'retail-taxonomy-file-invalid'],
      ['a confidence above the scale', assignments([{ ...products[0], confidenceBp: SCALE + 1 }]), 'retail-taxonomy-file-invalid'],
      ['an owner\'s source', assignments([{ ...products[0], source: 'owner' }]), 'retail-taxonomy-file-invalid'],
      ['Amazon\'s top and sub labels', assignments([{ subjectKey: A, node: { top: 'Groceries', sub: null }, confidenceBp: MIN }]),
        'retail-taxonomy-file-invalid'],
      ['a null node', assignments([{ ...products[0], node: null }]), 'retail-taxonomy-file-invalid'],
      ['out of order', assignments([products[1], products[0]]), 'retail-taxonomy-file-invalid'],
      ['a product twice', assignments([products[0], products[0]]), 'retail-taxonomy-file-invalid'],
      ['a label as its node', assignments([{ ...products[0], node: 'Household Supplies' }]), 'retail-taxonomy-node-unknown'],
      ['a misspelt node', assignments([{ ...products[0], node: 'groceries/meat-and-seafood' }]), 'retail-taxonomy-node-unknown'],
    ];
    for (const [what, value, code] of refused) expect(codeOf(() => retailTaxonomyAssignmentsOf(value)), what).toBe(code);
  });

  it('adopts a classifier\'s output as agent rows only, bound to its worklist\'s SHA-256, every product in that worklist', () => {
    const list = worklist();
    const text = serializeRetailTaxonomyWorklist(list);
    const read = retailTaxonomyAssignmentsOf(assignments([{ subjectKey: A, node: 'precious-metals', confidenceBp: MIN - 1 },
      { subjectKey: B, node: RESIDUAL, confidenceBp: SCALE }]));
    const adopted = adoptRetailTaxonomyAssignments(read, retailTaxonomyWorklistOf(JSON.parse(text)), sha256(text), DECISION);
    expect(adopted.entries.filter((one) => one.source !== 'agent' || one.subjectKind !== 'product')).toEqual([]);
    expect(adopted).toEqual({ format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 2, reviewed: true, decisionId: DECISION, entries: [
      { subjectKind: 'product', subjectKey: A, source: 'agent', node: 'precious-metals', confidenceBp: MIN - 1 },
      { subjectKind: 'product', subjectKey: B, source: 'agent', node: RESIDUAL, confidenceBp: SCALE },
    ] });
    expect(codeOf(() => adoptRetailTaxonomyAssignments(read, list, sha256(`${text} `), DECISION))).toBe('retail-taxonomy-worklist-mismatch');
    const stranger = retailTaxonomyAssignmentsOf(assignments([{ subjectKey: C, node: 'household', confidenceBp: SCALE }]));
    expect(refusalOf(() => adoptRetailTaxonomyAssignments(stranger, list, sha256(text), DECISION))).toMatchObject({
      code: 'retail-taxonomy-subject-unknown', details: { subjects: 1 } });
    expect(codeOf(() => adoptRetailTaxonomyAssignments(read, list, sha256(text), 'not-a-nonce'))).toBe('retail-taxonomy-file-invalid');
  });
});

describe('retail taxonomy worklist file (§6.1)', () => {
  it('reads back what it writes, and refuses another tree, thresholds, keys, types and order', () => {
    const list = worklist();
    const text = serializeRetailTaxonomyWorklist(list);
    expect(retailTaxonomyWorklistOf(JSON.parse(text))).toEqual(list);
    expect(JSON.parse(text)).toMatchObject({ format: RETAIL_TAXONOMY_WORKLIST_FORMAT, version: 1, taxonomyVersion: 2, taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST,
      thresholds: { minAgentBp: MIN, suggestedBelowBp: 8_000 } });
    const base = JSON.parse(text) as Record<string, any>;
    const variant = (change: (value: Record<string, any>) => void) => {
      const value = JSON.parse(text) as Record<string, any>;
      change(value);
      return value;
    };
    const refused: Array<[string, unknown]> = [
      ['another tree digest', variant((value) => { value.taxonomyDigest = 'f'.repeat(64); })],
      ['another threshold', variant((value) => { value.thresholds.minAgentBp = MIN + 1; })],
      ['a node relabelled', variant((value) => { value.taxonomy[0].label = 'Food'; })],
      ['a node left out', variant((value) => { value.taxonomy.pop(); })],
      ['an extra product key', variant((value) => { value.products[0].note = 'x'; })],
      ['products out of order', variant((value) => { value.products.reverse(); })],
      ['a product twice', variant((value) => { value.products[1] = value.products[0]; })],
      ['an item number as a number', variant((value) => { value.products[0].itemNumber = 100100; })],
      ['an unknown channel', variant((value) => { value.products[0].channels = ['kiosk']; })],
      ['nine title pairs', variant((value) => { value.products[0].titles = Array.from({ length: 9 }, (_, n) => ({ title: `T${n}`, title2: null })); })],
      ['lines not by department', variant((value) => { value.products[0].lines = 2; })],
      ['an agent R without a confidence', variant((value) => { value.products[0].current = { ...base.products[0].current, source: 'agent' }; })],
      ['a department out of range', variant((value) => { value.departments[0].department = 10_000; })],
      ['no coverage', variant((value) => { delete value.coverage; })],
    ];
    for (const [what, value] of refused) expect(codeOf(() => retailTaxonomyWorklistOf(value)), what).toBe('retail-taxonomy-file-invalid');
  });
});
