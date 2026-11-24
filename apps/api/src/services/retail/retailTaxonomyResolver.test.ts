import { describe, expect, it } from 'vitest';
import {
  ITEM_TAXONOMY_ASSET_NODE as ASSET,
  ITEM_TAXONOMY_BP_SCALE as SCALE,
  ITEM_TAXONOMY_MIN_AGENT_BP as MIN,
  ITEM_TAXONOMY_RESIDUAL as RESIDUAL,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP as BELOW,
} from '@finance-tracker/shared';

import {
  RETAIL_LINE_TAXONOMY_SOURCES,
  RETAIL_TAXONOMY_STORED_VERSION,
  resolveRetailLineTaxonomy,
  resolveRetailProductTaxonomy,
  retailDepartmentKey,
  retailProductKey,
  retailTaxonomyIndex,
  retailTaxonomyResolver,
  type RetailLineTaxonomy,
  type RetailTaxonomyLine,
  type RetailTaxonomyRow,
} from './index.js';

// The retail line resolver (Costco 3/7 plan v5 §4, §10): R per product, F per line, `metalHold` from its own evidence.
// Pure: synthetic rows and lines only, no database. Item numbers are the payload fixtures' own (100100 and up).

const MERCHANT = 'costco';
const ITEM = '100100';
const OTHER_ITEM = '100101';
const P = retailProductKey(MERCHANT, ITEM);
const P2 = retailProductKey(MERCHANT, OTHER_ITEM);
const D = retailDepartmentKey(MERCHANT, 12);
const D2 = retailDepartmentKey(MERCHANT, 14);
const ORDINARY = 'household/cleaning';

const importId = (seq: number) => `rtl-tax-${'abcdefghijklmnop'[seq % 16].repeat(32)}`;
/** One stored row, of this build's version unless another is given. */
function row(subjectKind: 'product' | 'department', subjectKey: string, source: RetailTaxonomyRow['source'], node: string | null,
  confidenceBp: number | null, seq: number, taxonomyVersion: string = RETAIL_TAXONOMY_STORED_VERSION): RetailTaxonomyRow {
  return { subjectKind, subjectKey, source, node, confidenceBp, taxonomyImportId: importId(seq), seq, taxonomyVersion };
}
const owner = (node: string | null, seq = 1, key = P) => row('product', key, 'owner', node, null, seq);
const agent = (node: string | null, bp: number, seq = 1, key = P) => row('product', key, 'agent', node, node === null ? null : bp, seq);
const reviewed = (node: string | null, seq = 1, key = D) => row('department', key, 'department-review', node, null, seq);

/** F for one line of the product in department 12, from these rows, as PR 4 will call it. */
const line = (rows: RetailTaxonomyRow[], patch: Partial<RetailTaxonomyLine> = {}): RetailLineTaxonomy =>
  retailTaxonomyResolver(retailTaxonomyIndex(rows)).line({ merchant: MERCHANT, itemNumber: ITEM, department: 12, titleRule: false, ...patch });
/** An expected F. */
const F = (node: string, source: RetailLineTaxonomy['source'] = null, patch: Partial<RetailLineTaxonomy> = {}): RetailLineTaxonomy =>
  ({ node, source, confidenceBp: null, suggested: false, suggestion: null, metalHold: false, ...patch } as RetailLineTaxonomy);
const held = (node: string, source: RetailLineTaxonomy['source'] = null, patch: Partial<RetailLineTaxonomy> = {}) =>
  F(node, source, { metalHold: true, ...patch });

describe('retail line taxonomy: precedence (§4.1)', () => {
  it('resolves a line by the title rule, then the owner, then an agent from the minimum, then its department, then the residual', () => {
    const cases: Array<[string, RetailTaxonomyRow[], Partial<RetailTaxonomyLine>, RetailLineTaxonomy]> = [
      ['no row', [], {}, F(RESIDUAL)],
      ['the title rule alone', [], { titleRule: true }, held(ASSET, 'title-rule')],
      ['the title rule over the owner', [owner('groceries')], { titleRule: true }, held(ASSET, 'title-rule')],
      ['the title rule over an agent and a department', [agent(ORDINARY, SCALE), reviewed('home-kitchen')], { titleRule: true },
        held(ASSET, 'title-rule')],
      ['the owner', [owner('groceries/produce')], {}, F('groceries/produce', 'owner')],
      ['the owner over an agent and a department', [owner('groceries/produce'), agent(ORDINARY, SCALE), reviewed('home-kitchen')], {},
        F('groceries/produce', 'owner')],
      ['an agent at the suggested bound', [agent(ORDINARY, BELOW)], {}, F(ORDINARY, 'agent', { confidenceBp: BELOW })],
      ['an agent inside the band', [agent(ORDINARY, MIN)], {}, F(ORDINARY, 'agent', { confidenceBp: MIN, suggested: true })],
      ['an agent below the minimum', [agent(ORDINARY, MIN - 1)], {}, F(RESIDUAL, null, { suggestion: { node: ORDINARY, confidenceBp: MIN - 1 } })],
      ['an agent below the minimum, then the department', [agent(ORDINARY, MIN - 1), reviewed('home-kitchen')], {},
        F('home-kitchen', 'department-review')],
      ['an agent over the department', [agent(ORDINARY, BELOW), reviewed('home-kitchen')], {}, F(ORDINARY, 'agent', { confidenceBp: BELOW })],
      ['the department alone', [reviewed('home-kitchen')], {}, F('home-kitchen', 'department-review')],
      ['a department row naming the residual is none', [reviewed(RESIDUAL)], {}, F(RESIDUAL)],
      ['a withdrawn department row is none', [reviewed('home-kitchen', 1), reviewed(null, 2)], {}, F(RESIDUAL)],
      ['an owner withdrawal exposes the agent', [owner('groceries', 1), agent(ORDINARY, BELOW, 1), owner(null, 2)], {},
        F(ORDINARY, 'agent', { confidenceBp: BELOW })],
      ['an agent withdrawal removes the agent', [agent(ORDINARY, BELOW, 1), agent(null, 0, 2)], {}, F(RESIDUAL)],
      ['the latest row of a source is current', [agent('garden-patio', BELOW, 1), agent(ORDINARY, BELOW, 2)], {},
        F(ORDINARY, 'agent', { confidenceBp: BELOW })],
      ['another version\'s owner row is not current', [row('product', P, 'owner', 'groceries', null, 2, 'taxonomy-v1')], {}, F(RESIDUAL)],
      ['another version\'s later agent row is not current', [agent(ORDINARY, BELOW, 1), row('product', P, 'agent', 'garden-patio', SCALE, 2, 'taxonomy-v3')],
        {}, F(ORDINARY, 'agent', { confidenceBp: BELOW })],
      ['a line without a department takes its product', [agent(ORDINARY, BELOW)], { department: null }, F(ORDINARY, 'agent', { confidenceBp: BELOW })],
      ['a line without a department, nothing filed', [reviewed('home-kitchen')], { department: null }, F(RESIDUAL)],
      ['another product\'s rows are not this line\'s', [owner('groceries', 1, P2), agent(ORDINARY, SCALE, 1, P2)], {}, F(RESIDUAL)],
      ['another department\'s row is not this line\'s', [reviewed('home-kitchen', 1, D2)], {}, F(RESIDUAL)],
    ];
    for (const [what, rows, patch, expected] of cases) expect(line(rows, patch), what).toEqual(expected);
  });

  it('files an agent\'s ordinary node at each boundary: suggested from the minimum, counted from the suggested bound', () => {
    expect(line([agent(ORDINARY, MIN - 1)])).toEqual(F(RESIDUAL, null, { suggestion: { node: ORDINARY, confidenceBp: MIN - 1 } }));
    expect(line([agent(ORDINARY, MIN)])).toEqual(F(ORDINARY, 'agent', { confidenceBp: MIN, suggested: true }));
    expect(line([agent(ORDINARY, BELOW - 1)])).toEqual(F(ORDINARY, 'agent', { confidenceBp: BELOW - 1, suggested: true }));
    expect(line([agent(ORDINARY, BELOW)])).toEqual(F(ORDINARY, 'agent', { confidenceBp: BELOW }));
    expect(line([agent(ORDINARY, SCALE)])).toEqual(F(ORDINARY, 'agent', { confidenceBp: SCALE }));
  });

  it('files an agent\'s precious metals at each boundary as any node, suggested in the band, and holds at every one (D-T1-4, Q-T5)', () => {
    expect(line([agent(ASSET, MIN - 1)])).toEqual(held(RESIDUAL, null, { suggestion: { node: ASSET, confidenceBp: MIN - 1 } }));
    expect(line([agent(ASSET, MIN)])).toEqual(held(ASSET, 'agent', { confidenceBp: MIN, suggested: true }));
    expect(line([agent(ASSET, BELOW - 1)])).toEqual(held(ASSET, 'agent', { confidenceBp: BELOW - 1, suggested: true }));
    expect(line([agent(ASSET, BELOW)])).toEqual(held(ASSET, 'agent', { confidenceBp: BELOW }));
    expect(line([agent(ASSET, SCALE)])).toEqual(held(ASSET, 'agent', { confidenceBp: SCALE }));
  });

  it('marks only an agent\'s node in the band suggested: never a title-rule, owner or department-review resolution, nor the residual', () => {
    const resolutions = [
      line([], { titleRule: true }), line([agent(ORDINARY, MIN)], { titleRule: true }), line([owner('groceries')]), line([owner(RESIDUAL)]),
      line([owner(ASSET)]), line([reviewed('home-kitchen')]), line([reviewed(ASSET)]), line([]), line([agent(RESIDUAL, MIN)]),
      line([agent(ORDINARY, MIN - 1)]), line([agent(ORDINARY, MIN)], { itemNumber: null }),
    ];
    expect(resolutions.filter((resolved) => resolved.suggested)).toEqual([]);
    expect(resolutions.map((resolved) => resolved.source)).toEqual(['title-rule', 'title-rule', 'owner', 'owner', 'owner', 'department-review',
      'department-review', null, null, null, null]);
  });

  it('resolves a line without a product by the title rule first, then its department, then the residual (§4.3, D-T1-4)', () => {
    const rows = [reviewed('home-kitchen'), agent(ORDINARY, SCALE)];
    expect(line(rows, { itemNumber: null, titleRule: true })).toEqual(held(ASSET, 'title-rule'));
    expect(line(rows, { itemNumber: null })).toEqual(F('home-kitchen', 'department-review'));
    expect(line(rows, { itemNumber: null, department: null })).toEqual(F(RESIDUAL));
  });

  it('takes R once per product and each line\'s own department and title: two lines of one product can differ', () => {
    const resolver = retailTaxonomyResolver(retailTaxonomyIndex([agent(ORDINARY, MIN - 1), reviewed('home-kitchen', 1, D), reviewed('dining', 1, D2)]));
    const lines = [
      resolver.line({ merchant: MERCHANT, itemNumber: ITEM, department: 12, titleRule: false }),
      resolver.line({ merchant: MERCHANT, itemNumber: ITEM, department: 14, titleRule: false }),
      resolver.line({ merchant: MERCHANT, itemNumber: ITEM, department: null, titleRule: false }),
      resolver.line({ merchant: MERCHANT, itemNumber: ITEM, department: 12, titleRule: true }),
    ];
    expect(lines.map((resolved) => [resolved.node, resolved.source, resolved.metalHold])).toEqual([
      ['home-kitchen', 'department-review', false], ['dining', 'department-review', false], [RESIDUAL, null, false], [ASSET, 'title-rule', true],
    ]);
    expect(resolver.product(MERCHANT, ITEM).resolution).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false,
      suggestion: { node: ORDINARY, confidenceBp: MIN - 1 } });
  });

  it('names its sources from one list: the stored sources and the title rule', () => {
    expect([...RETAIL_LINE_TAXONOMY_SOURCES]).toEqual(['title-rule', 'owner', 'agent', 'department-review']);
  });
});

describe('retail line taxonomy: R, the product-level resolution (§4.1)', () => {
  it('is exactly the shared resolver\'s answer for the winning current row, in basis points', () => {
    const R = (rows: RetailTaxonomyRow[]) => {
      const index = retailTaxonomyIndex(rows);
      return resolveRetailProductTaxonomy(index.current('product', P, 'owner'), index.current('product', P, 'agent'));
    };
    expect(R([])).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false, suggestion: null });
    expect(R([owner(RESIDUAL)])).toEqual({ node: RESIDUAL, source: 'owner', confidenceBp: null, suggested: false, suggestion: null });
    expect(R([owner('groceries'), agent(ORDINARY, MIN)])).toEqual({ node: 'groceries', source: 'owner', confidenceBp: null, suggested: false,
      suggestion: null });
    expect(R([agent(ORDINARY, MIN)])).toEqual({ node: ORDINARY, source: 'agent', confidenceBp: MIN, suggested: true, suggestion: null });
    expect(R([agent(RESIDUAL, MIN)])).toEqual({ node: RESIDUAL, source: 'agent', confidenceBp: MIN, suggested: false, suggestion: null });
    expect(R([agent(ORDINARY, MIN - 1)])).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false,
      suggestion: { node: ORDINARY, confidenceBp: MIN - 1 } });
    expect(R([agent(RESIDUAL, MIN - 1)])).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false, suggestion: null });
    // A withdrawal is no node: the owner's exposes the agent's, and an agent's leaves nothing.
    expect(R([owner('groceries', 1), owner(null, 2), agent(ORDINARY, BELOW)])).toEqual({ node: ORDINARY, source: 'agent', confidenceBp: BELOW,
      suggested: false, suggestion: null });
    expect(R([agent(ORDINARY, BELOW, 1), agent(null, 0, 2)])).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false,
      suggestion: null });
    // A current row naming no node of the v2 tree is never guessed: it files nothing.
    expect(R([owner('not-a-node')])).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false, suggestion: null });
  });

  it('counts the rows of another version as not current, and only those', () => {
    const index = retailTaxonomyIndex([owner('groceries', 1), row('product', P, 'agent', ORDINARY, BELOW, 2, 'taxonomy-v1'),
      row('department', D, 'department-review', 'dining', null, 3, 'taxonomy-v3')]);
    expect(index.otherVersionRows).toBe(2);
    expect(index.current('product', P, 'agent')).toBeUndefined();
    expect(index.current('department', D, 'department-review')).toBeUndefined();
    expect(index.current('product', P, 'owner')?.node).toBe('groceries');
  });
});

describe('retail line taxonomy: metalHold, the veto apart from the winner (§4.2, D-T3-2)', () => {
  it('keeps the hold of an agent\'s precious metals, at or below the minimum, once the owner files the product elsewhere', () => {
    for (const bp of [MIN, BELOW - 1, BELOW, MIN - 1]) {
      const rows = [agent(ASSET, bp, 1)];
      expect(line(rows).metalHold, `agent at ${bp}`).toBe(true);
      rows.push(owner('groceries', 2));
      expect(line(rows), `agent at ${bp}, then the owner`).toEqual(held('groceries', 'owner'));
    }
  });

  it('keeps the hold of a department\'s precious metals once an agent files the product at the minimum', () => {
    const rows = [reviewed(ASSET, 1)];
    expect(line(rows)).toEqual(held(ASSET, 'department-review'));
    rows.push(agent(ORDINARY, MIN, 2));
    expect(line(rows)).toEqual(held(ORDINARY, 'agent', { confidenceBp: MIN, suggested: true }));
  });

  it('keeps the hold when the same source moves off precious metals: an agent re-run, the owner\'s correction, a remapped department', () => {
    const rerun = [agent(ASSET, BELOW, 1)];
    rerun.push(agent('household', BELOW, 2));
    expect(line(rerun), 'an agent re-run').toEqual(held('household', 'agent', { confidenceBp: BELOW }));
    const corrected = [owner(ASSET, 1)];
    expect(line(corrected), 'the owner\'s precious metals').toEqual(held(ASSET, 'owner'));
    corrected.push(owner('groceries', 2));
    expect(line(corrected), 'the owner\'s correction').toEqual(held('groceries', 'owner'));
    const remapped = [reviewed(ASSET, 1)];
    remapped.push(reviewed('home-kitchen', 2));
    expect(line(remapped), 'a remapped department').toEqual(held('home-kitchen', 'department-review'));
  });

  it('keeps the hold when the row that named precious metals is withdrawn', () => {
    expect(line([agent(ASSET, BELOW, 1), agent(null, 0, 2)]), 'an agent withdrawal').toEqual(held(RESIDUAL));
    expect(line([owner(ASSET, 1), owner(null, 2)]), 'an owner withdrawal').toEqual(held(RESIDUAL));
    expect(line([reviewed(ASSET, 1), reviewed(null, 2)]), 'a department withdrawal').toEqual(held(RESIDUAL));
  });

  it('holds on a row of another version naming precious metals, which is never current', () => {
    expect(line([row('product', P, 'owner', ASSET, null, 1, 'taxonomy-v1')])).toEqual(held(RESIDUAL));
    expect(line([row('department', D, 'department-review', ASSET, null, 1, 'taxonomy-v3'), reviewed('home-kitchen', 2)]))
      .toEqual(held('home-kitchen', 'department-review'));
  });

  it('holds a line without a product whose department once named precious metals', () => {
    expect(line([reviewed(ASSET, 1), reviewed('home-kitchen', 2)], { itemNumber: null })).toEqual(held('home-kitchen', 'department-review'));
  });

  it('holds no line without evidence of its own: another product\'s or another department\'s precious metals hold nothing here', () => {
    expect(line([owner('groceries'), reviewed('home-kitchen')])).toEqual(F('groceries', 'owner'));
    expect(line([owner(ASSET, 1, P2), agent(ASSET, SCALE, 1, P2), reviewed(ASSET, 1, D2)])).toEqual(F(RESIDUAL));
    expect(line([reviewed(ASSET, 1, D2)], { itemNumber: null })).toEqual(F(RESIDUAL));
  });

  it('reads the title rule, the product\'s and the department\'s evidence, each alone, whatever wins', () => {
    const product = { resolution: { node: 'groceries' as const, source: 'owner' as const, confidenceBp: null, suggested: false, suggestion: null },
      metalEvidence: false };
    const department = { reviewed: 'home-kitchen' as const, metalEvidence: false };
    expect(resolveRetailLineTaxonomy({ titleRule: false, product, department }).metalHold).toBe(false);
    expect(resolveRetailLineTaxonomy({ titleRule: false, product: { ...product, metalEvidence: true }, department }).metalHold).toBe(true);
    expect(resolveRetailLineTaxonomy({ titleRule: false, product, department: { ...department, metalEvidence: true } }).metalHold).toBe(true);
    expect(resolveRetailLineTaxonomy({ titleRule: false, product: null, department: { ...department, metalEvidence: true } }).metalHold).toBe(true);
    expect(resolveRetailLineTaxonomy({ titleRule: true, product: null, department: null })).toEqual(held(ASSET, 'title-rule'));
  });
});

describe('retail line taxonomy: explicit residuals (D-T2-1)', () => {
  it('never lets an agent\'s explicit residual resolve a line, at any confidence: the department, then the residual, with no suggestion', () => {
    for (const bp of [MIN - 1, MIN, BELOW - 1, BELOW, SCALE]) {
      const R = resolveRetailProductTaxonomy(undefined, agent(RESIDUAL, bp));
      expect([R.node, R.suggested, R.suggestion], `R at ${bp}`).toEqual([RESIDUAL, false, null]);
      expect(line([agent(RESIDUAL, bp), reviewed('home-kitchen')]), `with a department, at ${bp}`).toEqual(F('home-kitchen', 'department-review'));
      expect(line([agent(RESIDUAL, bp)]), `alone, at ${bp}`).toEqual(F(RESIDUAL));
    }
  });

  it('keeps the owner\'s explicit residual final: Needs review, by the owner, over a department and an agent at the scale', () => {
    expect(line([owner(RESIDUAL), agent(ORDINARY, SCALE), reviewed('home-kitchen')])).toEqual(F(RESIDUAL, 'owner'));
  });

  it('keeps a sub-minimum suggestion to the residual, and reads a department row naming the residual as none', () => {
    expect(line([agent(ORDINARY, MIN - 1), reviewed(RESIDUAL)])).toEqual(F(RESIDUAL, null, { suggestion: { node: ORDINARY, confidenceBp: MIN - 1 } }));
  });

  it('exposes the agent once the owner withdraws an explicit residual, in each band, and leaves nothing once an agent withdraws one', () => {
    expect(line([owner(RESIDUAL, 1), agent(ORDINARY, MIN - 1, 1), owner(null, 2)])).toEqual(F(RESIDUAL, null,
      { suggestion: { node: ORDINARY, confidenceBp: MIN - 1 } }));
    expect(line([owner(RESIDUAL, 1), agent(ORDINARY, MIN, 1), owner(null, 2)])).toEqual(F(ORDINARY, 'agent', { confidenceBp: MIN, suggested: true }));
    expect(line([owner(RESIDUAL, 1), agent(ORDINARY, BELOW, 1), owner(null, 2)])).toEqual(F(ORDINARY, 'agent', { confidenceBp: BELOW }));
    expect(line([agent(RESIDUAL, BELOW, 1), agent(null, 0, 2)])).toEqual(F(RESIDUAL));
    expect(resolveRetailProductTaxonomy(undefined, agent(null, 0, 2))).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false,
      suggestion: null });
  });
});
