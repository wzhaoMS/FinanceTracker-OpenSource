import { describe, expect, it } from 'vitest';
import {
  AMAZON_TAXONOMY_NODES,
  AMAZON_TAXONOMY_POLICY,
  isSuggestedAmazonTaxonomy,
  resolveItemTaxonomy,
  type AmazonTaxonomySource,
} from '@finance-tracker/shared';
import { AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST } from './lineTaxonomy.js';
import { AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_SCHEMA_DIGEST, resolveTaxonomy, type TaxonomyAssignment } from './taxonomy.js';

/**
 * Recorded from main (a799778f) by running its own modules, before the item tree was shared. Root's O96: a change to
 * any of them is a STOP, never a pin to adjust.
 */
const RECORDED_ON_MAIN = {
  AMAZON_TAXONOMY_DIGEST: '0af74edcbf699ce166f79b68875f12adb884720d197ed30c1369ebc50c8c180a',
  AMAZON_TAXONOMY_SCHEMA_DIGEST: 'ceb187311abdc8e67f87d16eb1e88a1dcc1401fbbf94ff74aa9a48ae64475f9f',
  AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST: '4b21207e8c80c5070c1962a79f8197273dc27c04914f0dbc40e9dc722b0f3783',
};

// The oracle: a frozen copy of Amazon's resolver and suggested predicate as main (a799778f) defined them, with their
// constants written out. It lives in this test only; nothing imports it.
const FROZEN_NEEDS_REVIEW = 'needs-review';
const FROZEN_MIN_AGENT_CONFIDENCE = 0.6;
const FROZEN_SUGGESTED_BELOW = 0.8;
function frozenIsSuggested(source: AmazonTaxonomySource | null, confidence: number | null, node?: string): boolean {
  return source === 'agent' && node !== FROZEN_NEEDS_REVIEW && confidence !== null
    && confidence >= FROZEN_MIN_AGENT_CONFIDENCE && confidence < FROZEN_SUGGESTED_BELOW;
}
function frozenResolve(assignment: TaxonomyAssignment | undefined) {
  if (!assignment) return { node: FROZEN_NEEDS_REVIEW, source: null, confidence: null, suggested: false, suggestion: null };
  if (assignment.source === 'owner' || assignment.confidence >= FROZEN_MIN_AGENT_CONFIDENCE) {
    return { node: assignment.node, source: assignment.source, confidence: assignment.confidence,
      suggested: frozenIsSuggested(assignment.source, assignment.confidence, assignment.node), suggestion: null };
  }
  return { node: FROZEN_NEEDS_REVIEW, source: null, confidence: null, suggested: false,
    suggestion: assignment.node === FROZEN_NEEDS_REVIEW ? null : { node: assignment.node, confidence: assignment.confidence } };
}

/** The double `by` steps away from a positive one. */
const step = (x: number, by: bigint) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + by);
  return view.getFloat64(0);
};
/** The boundary confidences 0.5999…, 0.6, 0.7999…, 0.8 and 1, with their neighbours and a few between. */
const CONFIDENCES = [0, 0.3, step(0.6, -1n), 0.6, step(0.6, 1n), 0.7, step(0.8, -1n), 0.8, step(0.8, 1n), 0.9, step(1, -1n), 1];
const SOURCES: AmazonTaxonomySource[] = ['owner', 'agent'];
// Entirely synthetic: every v1 node, by each source, at each confidence, and no assignment at all.
const ASSIGNMENTS: Array<TaxonomyAssignment | undefined> = [undefined, ...AMAZON_TAXONOMY_NODES.flatMap((node) =>
  SOURCES.flatMap((source) => CONFIDENCES.map((confidence) => ({ node: node.id, source, confidence }))))];

describe('Amazon taxonomy after the shared item tree', () => {
  it('keeps the three digests main recorded', () => {
    expect({ AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_SCHEMA_DIGEST, AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST }).toStrictEqual(RECORDED_ON_MAIN);
  });

  it('resolves every assignment exactly as main\'s resolver did, keys and their order included', () => {
    expect(step(0.6, -1n)).toBe(0.5999999999999999);
    expect(step(0.8, -1n)).toBe(0.7999999999999999);
    expect(ASSIGNMENTS).toHaveLength(1 + AMAZON_TAXONOMY_NODES.length * SOURCES.length * CONFIDENCES.length);
    for (const assignment of ASSIGNMENTS) {
      const expected = frozenResolve(assignment);
      for (const actual of [resolveTaxonomy(assignment), resolveItemTaxonomy(assignment, AMAZON_TAXONOMY_POLICY)]) {
        expect(actual, JSON.stringify(assignment)).toStrictEqual(expected);
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      }
    }
  });

  it('marks suggested exactly as main did', () => {
    for (const source of [null, ...SOURCES]) {
      for (const confidence of [null, ...CONFIDENCES]) {
        for (const node of [undefined, ...AMAZON_TAXONOMY_NODES.map((n) => n.id)]) {
          expect(isSuggestedAmazonTaxonomy(source, confidence, node), `${source} ${confidence} ${node}`)
            .toBe(frozenIsSuggested(source, confidence, node));
        }
      }
    }
  });
});
