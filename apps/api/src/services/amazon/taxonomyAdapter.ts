import {
  AMAZON_ITEM_TAXONOMY,
  AMAZON_ITEM_TAXONOMY_VERSION,
  type AmazonTaxonomyNodeId,
} from '@finance-tracker/shared';
import { exact, refuse } from './policy.js';
import { AMAZON_TAXONOMY_MAPPING_FORMAT, classifiableProductKey, validateTaxonomyMapping, type TaxonomyMapping } from './taxonomy.js';

/**
 * The classifier's private output, as Root's reclassification writes it, adopted as an import mapping: each product's
 * `taxonomy: { top, sub | null }` (by node id or by its exact v1 label) becomes one agent entry with its
 * `taxonomyConfidence`. Its card-category fields are ignored here: the taxonomy never changes card Spending. The
 * whole file refuses on any unknown node, malformed confidence, repeated product or unexpected field.
 */
export const AMAZON_TAXONOMY_ASSIGNMENTS_FORMAT = 'holdr.amazon-taxonomy-assignments';
const OPTIONAL = ['cardCategory', 'cardCategoryConfidence', 'previous', 'disagreement', 'title'];
/** Labels compare without commas or repeated spaces ("Cables Chargers & Batteries" is "Cables, Chargers & Batteries"). */
const loose = (label: string) => label.replace(/,/g, '').replace(/\s+/g, ' ').trim();

function node(input: unknown): AmazonTaxonomyNodeId {
  const t = exact(input, ['top', 'sub']);
  if (typeof t.top !== 'string' || (t.sub !== null && typeof t.sub !== 'string')) return refuse();
  const top = AMAZON_ITEM_TAXONOMY.find(entry => entry.id === t.top || entry.label === t.top || loose(entry.label) === loose(t.top as string));
  if (!top) return refuse();
  if (t.sub === null) return top.id;
  const children: ReadonlyArray<{ id: string; label: string }> = top.children;
  const sub = children.find(child => child.id === t.sub || child.label === t.sub || loose(child.label) === loose(t.sub as string));
  return sub ? sub.id as AmazonTaxonomyNodeId : refuse();
}
export function adoptTaxonomyAssignments(input: unknown): TaxonomyMapping {
  const a = exact(input, ['format', 'taxonomyVersion', 'generatedAt', 'inputs', 'products']);
  if (a.format !== AMAZON_TAXONOMY_ASSIGNMENTS_FORMAT || a.taxonomyVersion !== `v${AMAZON_ITEM_TAXONOMY_VERSION}`
    || typeof a.generatedAt !== 'string' || !a.inputs || typeof a.inputs !== 'object' || Array.isArray(a.inputs)
    || !Array.isArray(a.products)) return refuse();
  const entries = a.products.map((value) => {
    const present = value && typeof value === 'object' && !Array.isArray(value) ? OPTIONAL.filter(k => Object.hasOwn(value, k)) : [];
    const p = exact(value, ['productKey', 'asin', 'taxonomy', 'taxonomyConfidence', ...present]);
    if (p.asin !== null && (typeof p.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(p.asin))) return refuse();
    // A title, when the record carries one, must be the product its key names.
    if (present.includes('title') && classifiableProductKey({ itemId: p.asin, title: p.title }) !== p.productKey) return refuse();
    return { productKey: p.productKey as string, node: node(p.taxonomy), confidence: p.taxonomyConfidence as number, source: 'agent' as const };
  });
  // The mapping's own checks: key and confidence shape, and one entry per product.
  return validateTaxonomyMapping({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: AMAZON_ITEM_TAXONOMY_VERSION,
    reviewed: true, entries });
}
