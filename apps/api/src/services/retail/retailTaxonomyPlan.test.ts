import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ITEM_TAXONOMY_ASSET_NODE as ASSET,
  ITEM_TAXONOMY_BP_SCALE as SCALE,
  ITEM_TAXONOMY_MIN_AGENT_BP as MIN,
  ITEM_TAXONOMY_RESIDUAL as RESIDUAL,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP as BELOW,
} from '@finance-tracker/shared';

import {
  RETAIL_TAXONOMY_STORED_VERSION,
  retailDepartmentKey,
  retailProductKey,
  retailTaxonomyAction,
  retailTaxonomyCounters,
  retailTaxonomyIndex,
  retailTaxonomyPlanDigest,
  retailTaxonomyPlanPreimage,
  retailTaxonomyPlannedRows,
  retailTaxonomyResolver,
  type RetailTaxonomyCountedLine,
  type RetailTaxonomyCounters,
  type RetailTaxonomyEntry,
  type RetailTaxonomyPlanReadModel,
  type RetailTaxonomyProductSubject,
  type RetailTaxonomyRow,
  type RetailTaxonomySubjects,
} from './index.js';

// The plan (Costco 3/7 plan v5 §7.3, §10): its preimage is a pure function of a plain read model (D-T2-2), so each of
// its dependencies is proved here with `auditSeq` held fixed; and its counters are the resolver's own (D-T2-1).

const P1 = 'a'.repeat(64);
const P2 = 'b'.repeat(64);
const P3 = 'c'.repeat(64);
const D1 = 'd'.repeat(64);
const D2 = 'e'.repeat(64);
const D3 = 'f'.repeat(64);
const T = (seq: number) => `rtl-tax-${'ghijklmn'[seq].repeat(32)}`;
const row = (subjectKind: 'product' | 'department', subjectKey: string, source: RetailTaxonomyRow['source'], node: string | null,
  confidenceBp: number | null, seq: number): RetailTaxonomyRow => ({ subjectKind, subjectKey, source, node, confidenceBp, taxonomyImportId: T(seq), seq,
  taxonomyVersion: RETAIL_TAXONOMY_STORED_VERSION });
const ref = (version: string, line: string) => `rrv-${version.repeat(32)}/rli-${line.repeat(32)}`;
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The read model's digests: synthetic, since the preimage is a pure function of whatever the model carries. */
const SCHEMA = '5c'.repeat(32);
const TREE = '7d'.repeat(32);

/**
 * A legal plan: a department entry (D2, whose counted lines include product P2's) and an agent entry (P1, whose counted
 * lines fall under department D1 and under none), over owner, agent and department rows, D1's withdrawn, and P2's
 * superseded precious metals. P3 and D3 are unrelated; D3's row names precious metals.
 */
function model(): RetailTaxonomyPlanReadModel {
  return {
    schemaDigest: SCHEMA,
    taxonomyDigest: TREE,
    mappingSha256: '3c'.repeat(32),
    auditSeq: 7,
    entries: [
      { subjectKind: 'department', subjectKey: D2, source: 'department-review', node: 'home-kitchen', confidenceBp: null },
      { subjectKind: 'product', subjectKey: P1, source: 'agent', node: 'household/cleaning', confidenceBp: 8_500 },
    ],
    rows: [
      row('product', P1, 'owner', 'groceries/produce', null, 1),
      row('department', D1, 'department-review', 'home-kitchen', null, 1),
      row('product', P2, 'agent', ASSET, 5_500, 1),
      row('product', P1, 'agent', 'household/cleaning', 7_000, 2),
      row('department', D1, 'department-review', null, null, 2),
      row('department', D2, 'department-review', 'toys-hobbies', null, 2),
      row('product', P2, 'agent', 'garden-patio', 9_000, 2),
      row('product', P3, 'owner', 'clothing', null, 3),
      row('department', D3, 'department-review', ASSET, null, 3),
    ],
    subjects: [
      { subjectKind: 'department', subjectKey: D2, related: [P2], storedRefs: [ref('g', 'h')], lines: 1 },
      { subjectKind: 'product', subjectKey: P1, related: [D1], storedRefs: [ref('g', 'i'), ref('j', 'k')], lines: 2 },
    ],
  };
}

/** The digest of `model()` with one input changed. */
const changed = (change: (value: RetailTaxonomyPlanReadModel) => void): string => {
  const value = model();
  change(value);
  return retailTaxonomyPlanDigest(value);
};

describe('retail taxonomy plan: the preimage, pure (§7.3, D-T2-2)', () => {
  it('builds the canonical preimage exactly: digests, auditSeq, actions, dependencies, metal evidence and witnesses', () => {
    expect(retailTaxonomyPlanPreimage(model())).toEqual({
      format: 'holdr.retail-taxonomy-plan',
      version: 1,
      schemaDigest: SCHEMA,
      taxonomyDigest: TREE,
      mappingSha256: '3c'.repeat(32),
      auditSeq: 7,
      entries: [
        { subjectKind: 'department', subjectKey: D2, source: 'department-review', node: 'home-kitchen', confidenceBp: null, action: 'replace' },
        { subjectKind: 'product', subjectKey: P1, source: 'agent', node: 'household/cleaning', confidenceBp: 8_500, action: 'replace' },
      ],
      dependencies: [
        { subjectKind: 'department', subjectKey: D1, source: 'department-review', taxonomyImportId: T(2), seq: 2, node: null, confidenceBp: null },
        { subjectKind: 'department', subjectKey: D2, source: 'department-review', taxonomyImportId: T(2), seq: 2, node: 'toys-hobbies', confidenceBp: null },
        { subjectKind: 'product', subjectKey: P1, source: 'agent', taxonomyImportId: T(2), seq: 2, node: 'household/cleaning', confidenceBp: 7_000 },
        { subjectKind: 'product', subjectKey: P1, source: 'owner', taxonomyImportId: T(1), seq: 1, node: 'groceries/produce', confidenceBp: null },
        { subjectKind: 'product', subjectKey: P2, source: 'agent', taxonomyImportId: T(2), seq: 2, node: 'garden-patio', confidenceBp: 9_000 },
        { subjectKind: 'product', subjectKey: P2, source: 'owner', absent: true },
      ],
      metalEvidence: [
        { subjectKind: 'product', subjectKey: P2, source: 'agent', taxonomyImportId: T(1), seq: 1 },
      ],
      witnesses: [
        { subjectKind: 'department', subjectKey: D2, linesSha256: sha256([ref('g', 'h')]), lines: 1 },
        { subjectKind: 'product', subjectKey: P1, linesSha256: sha256([ref('g', 'i'), ref('j', 'k')]), lines: 2 },
      ],
    });
  });

  it('digests the canonical preimage to its recorded value: the SHA-256 of its canonical JSON', () => {
    expect(retailTaxonomyPlanDigest(model())).toBe(CANONICAL_PLAN_DIGEST);
  });

  it('changes its digest for each dependency alone, auditSeq held fixed (D-T1-2, D-T3-2)', () => {
    const base = retailTaxonomyPlanDigest(model());
    expect(changed((value) => { value.rows.push(row('product', P1, 'owner', null, null, 4)); }), 'the agent entry\'s owner withdrawn').not.toBe(base);
    expect(changed((value) => { value.rows[3].confidenceBp = 7_100; }), 'its agent row\'s confidence').not.toBe(base);
    expect(changed((value) => { value.rows[4].node = 'home-kitchen/bedding-bath'; }), 'a department row of its byDepartment').not.toBe(base);
    expect(changed((value) => { value.rows.push(row('product', P2, 'owner', 'garden-patio', null, 4)); }), 'an owner of the department\'s product').not.toBe(base);
    expect(changed((value) => { value.subjects[1].storedRefs.push(ref('o', 'p')); }), 'a witness: a stored line').not.toBe(base);
    expect(changed((value) => { value.subjects[0].lines = 2; }), 'a witness: a counted line').not.toBe(base);
    expect(changed((value) => { value.rows.push(row('product', P1, 'agent', ASSET, 9_000, 1)); }), 'a superseded agent metals row').not.toBe(base);
    expect(changed((value) => { value.rows[1].node = ASSET; }), 'a withdrawn department metals row of its byDepartment').not.toBe(base);
    expect(changed((value) => { value.auditSeq = 8; }), 'auditSeq').not.toBe(base);
  });

  it('keeps its digest for a row of an unrelated product or department, a precious-metals row included', () => {
    const base = retailTaxonomyPlanDigest(model());
    expect(changed((value) => { value.rows.push(row('product', P3, 'agent', ASSET, 9_000, 4)); }), 'an unrelated product\'s precious metals').toBe(base);
    expect(changed((value) => { value.rows.push(row('department', D3, 'department-review', 'dining', null, 4)); }), 'an unrelated department').toBe(base);
    expect(changed((value) => { value.rows.push(row('product', P3, 'owner', null, null, 4)); }), 'an unrelated owner withdrawal').toBe(base);
  });

  it('names each entry\'s action against its current row: insert, replace, withdraw or unchanged', () => {
    const entry = (patch: Partial<RetailTaxonomyEntry> = {}): RetailTaxonomyEntry => ({ subjectKind: 'product', subjectKey: P1, source: 'agent',
      node: 'household', confidenceBp: MIN, ...patch });
    const current = row('product', P1, 'agent', 'household', MIN, 1);
    const withdrawn = row('product', P1, 'agent', null, null, 2);
    expect([
      retailTaxonomyAction(entry(), undefined), retailTaxonomyAction(entry(), current), retailTaxonomyAction(entry({ confidenceBp: MIN + 1 }), current),
      retailTaxonomyAction(entry({ node: 'garden-patio' }), current), retailTaxonomyAction(entry({ node: null, confidenceBp: null }), current),
      retailTaxonomyAction(entry({ node: null, confidenceBp: null }), undefined), retailTaxonomyAction(entry({ node: null, confidenceBp: null }), withdrawn),
      retailTaxonomyAction(entry(), withdrawn),
    ]).toEqual(['insert', 'unchanged', 'replace', 'replace', 'withdraw', 'unchanged', 'unchanged', 'replace']);
  });
});

/** A synthetic household: products by item number, each with lines in departments 12, 14 or none, and product-less lines. */
function household(): { subjects: RetailTaxonomySubjects; rows: RetailTaxonomyRow[] } {
  const configs: Array<(key: string) => RetailTaxonomyRow[]> = [
    () => [],
    (key) => [row('product', key, 'owner', 'groceries', null, 1)],
    (key) => [row('product', key, 'owner', RESIDUAL, null, 1), row('product', key, 'agent', 'household', SCALE, 1)],
    (key) => [row('product', key, 'owner', ASSET, null, 1)],
    ...[MIN - 1, MIN, BELOW - 1, BELOW, SCALE].flatMap((bp): Array<(key: string) => RetailTaxonomyRow[]> => [
      (key) => [row('product', key, 'agent', 'household', bp, 1)],
      (key) => [row('product', key, 'agent', RESIDUAL, bp, 1)],
      (key) => [row('product', key, 'agent', ASSET, bp, 1)],
      (key) => [row('product', key, 'agent', ASSET, bp, 1), row('product', key, 'owner', 'groceries', null, 2)],
      (key) => [row('product', key, 'owner', 'groceries', null, 1), row('product', key, 'owner', null, null, 2), row('product', key, 'agent', 'garden-patio', bp, 2)],
    ]),
    (key) => [row('product', key, 'agent', 'household', SCALE, 1), row('product', key, 'agent', null, null, 2)],
    (key) => [row('product', key, 'owner', 'clothing', null, 1), { ...row('product', key, 'owner', ASSET, null, 2), taxonomyVersion: 'taxonomy-v3' }],
  ];
  const rows: RetailTaxonomyRow[] = [
    row('department', retailDepartmentKey('costco', 12), 'department-review', 'home-kitchen', null, 1),
    row('department', retailDepartmentKey('costco', 14), 'department-review', RESIDUAL, null, 1),
    row('department', retailDepartmentKey('costco', 17), 'department-review', ASSET, null, 1),
    row('department', retailDepartmentKey('costco', 17), 'department-review', 'dining', null, 2),
  ];
  const products = new Map<string, RetailTaxonomyProductSubject>();
  const lines: RetailTaxonomyCountedLine[] = [];
  configs.forEach((config, index) => {
    const itemNumber = String(100100 + index);
    const key = retailProductKey('costco', itemNumber);
    rows.push(...config(key));
    const counted = [12, 14, 17, null].map((department, n): RetailTaxonomyCountedLine => ({ receiptRef: `rcp-${'abcd'[n].repeat(32)}`,
      lineRef: `rli-${'efghijklmnopabcd'[index % 16].repeat(31)}${'abcd'[n]}`, merchant: 'costco', itemNumber, department, titleRule: index % 5 === 0 && n === 0 }));
    products.set(key, { key, merchant: 'costco', itemNumber, titles: [], channels: ['warehouse'], storedRefs: [], counted });
    lines.push(...counted);
  });
  for (const department of [12, 14, 17, null]) {
    lines.push({ receiptRef: `rcp-${'p'.repeat(32)}`, lineRef: `rli-${'o'.repeat(31)}${'abcd'[department === null ? 3 : 0]}`, merchant: 'costco', itemNumber: null,
      department, titleRule: department === 14 });
  }
  return { subjects: { lines, products, departments: new Map() }, rows };
}

describe('retail taxonomy plan: counters from the resolver\'s own output (§7.3, D-T2-1)', () => {
  it('counts every status and source by R per product and F per line, each family a partition of its total', () => {
    const { subjects, rows } = household();
    const counters = retailTaxonomyCounters(subjects, rows);
    const index = retailTaxonomyIndex(rows);
    const resolver = retailTaxonomyResolver(index);
    const R = [...subjects.products.values()].map((product) => resolver.product(product.merchant, product.itemNumber).resolution);
    const F = subjects.lines.map((line) => resolver.line(line));
    const statuses = (resolved: Array<{ node: string; suggested: boolean; suggestion: unknown }>) => ({
      total: resolved.length,
      assigned: resolved.filter((one) => one.node !== RESIDUAL && !one.suggested).length,
      suggested: resolved.filter((one) => one.suggested).length,
      needsReview: resolved.filter((one) => one.node === RESIDUAL).length,
      withSuggestion: resolved.filter((one) => one.suggestion !== null).length,
      assetFiled: resolved.filter((one) => one.node === ASSET).length,
    });
    const winners = [...subjects.products.values()].map((product) => {
      const owner = index.current('product', product.key, 'owner');
      const agent = index.current('product', product.key, 'agent');
      return owner !== undefined && owner.node !== null ? owner : agent !== undefined && agent.node !== null ? agent : undefined;
    });
    const expected: RetailTaxonomyCounters = {
      products: statuses(R),
      productSources: {
        ownerRows: winners.filter((winner) => winner?.source === 'owner').length,
        agentRows: winners.filter((winner) => winner?.source === 'agent').length,
        noRow: winners.filter((winner) => winner === undefined).length,
        explicitResidual: winners.filter((winner) => winner?.node === RESIDUAL).length,
      },
      lines: { ...statuses(F), metalHold: F.filter((one) => one.metalHold).length },
      lineSources: {
        titleRule: F.filter((one) => one.source === 'title-rule').length,
        owner: F.filter((one) => one.source === 'owner').length,
        agent: F.filter((one) => one.source === 'agent').length,
        department: F.filter((one) => one.source === 'department-review').length,
        none: F.filter((one) => one.source === null).length,
        withoutProduct: subjects.lines.filter((line) => line.itemNumber === null).length,
      },
      rowsNotCurrent: 1,
    };
    expect(counters).toEqual(expected);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(counters.products.assigned + counters.products.suggested + counters.products.needsReview).toBe(counters.products.total);
    expect(counters.productSources.ownerRows + counters.productSources.agentRows + counters.productSources.noRow).toBe(counters.products.total);
    expect(counters.lines.assigned + counters.lines.suggested + counters.lines.needsReview).toBe(counters.lines.total);
    expect(sum([counters.lineSources.titleRule, counters.lineSources.owner, counters.lineSources.agent, counters.lineSources.department,
      counters.lineSources.none])).toBe(counters.lines.total);
    expect(counters.products.total).toBe(subjects.products.size);
    expect(counters.lines.total).toBe(subjects.lines.length);
  });

  it('never counts an explicit residual as suggested or with a suggestion, whoever filed it and at any confidence', () => {
    const { subjects } = household();
    const only = [...subjects.products.values()].slice(0, 1);
    const key = only[0].key;
    const one = { lines: only[0].counted, products: new Map([[key, only[0]]]), departments: new Map() };
    for (const [what, rows] of [
      ['an agent in the band', [row('product', key, 'agent', RESIDUAL, MIN, 1)]],
      ['an agent below the minimum', [row('product', key, 'agent', RESIDUAL, MIN - 1, 1)]],
      ['the owner', [row('product', key, 'owner', RESIDUAL, null, 1)]],
    ] as Array<[string, RetailTaxonomyRow[]]>) {
      const counters = retailTaxonomyCounters(one, rows);
      expect(counters.products, what).toEqual({ total: 1, assigned: 0, suggested: 0, needsReview: 1, withSuggestion: 0, assetFiled: 0 });
      expect(counters.productSources.explicitResidual, what).toBe(1);
    }
  });

  it('counts as if imported: the mapping\'s entries become the next import\'s current rows', () => {
    const stored = [row('product', P1, 'agent', 'household', SCALE, 3)];
    const planned = retailTaxonomyPlannedRows(stored, [{ subjectKind: 'product', subjectKey: P1, source: 'agent', node: null, confidenceBp: null }]);
    expect(planned.map((one) => [one.seq, one.node, one.taxonomyVersion])).toEqual([[3, 'household', RETAIL_TAXONOMY_STORED_VERSION],
      [4, null, RETAIL_TAXONOMY_STORED_VERSION]]);
    expect(retailTaxonomyIndex(planned).current('product', P1, 'agent')?.node).toBeNull();
  });
});

/**
 * The canonical preimage's digest (§10: "The digest equals its recorded value"), computed apart from this code: the
 * literal above as canonical JSON (keys sorted at every level, no white space), through Python's `json.dumps` (sorted
 * keys, compact separators) and `hashlib`'s SHA-256, and again through `jq -cS` and `sha256sum`.
 */
const CANONICAL_PLAN_DIGEST = '30dcc6b1459532e30428b3815809f6eab839bb4038afbfda4d5f3d26efaa4c74';
