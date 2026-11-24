import {
  ITEM_TAXONOMY_MIN_AGENT_BP,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
  ITEM_TAXONOMY_V2_DIGEST,
  ITEM_TAXONOMY_V2_VIEW,
} from '@finance-tracker/shared';
import { RETAIL_CHANNELS, RETAIL_MERCHANTS, RETAIL_TITLE_MAX } from '@finance-tracker/shared/retail-import-payload';

import { RETAIL_CONFIDENCE_BP_MAX, RETAIL_TAXONOMY_SUBJECT_KINDS, RetailRefusal, type RetailTaxonomySubjectKind } from './common.js';
import { RETAIL_TAXONOMY_SOURCES, type RetailTaxonomySource } from './schema.js';
import {
  RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT,
  RETAIL_TAXONOMY_FILE_VERSION,
  RETAIL_TAXONOMY_MAPPING_FORMAT,
  RETAIL_TAXONOMY_TITLES_MAX,
  RETAIL_TAXONOMY_VERSION,
  RETAIL_TAXONOMY_WORKLIST_FORMAT,
} from './taxonomyFormats.js';
import type { RetailProductTaxonomy, RetailTaxonomyNode } from './taxonomyResolver.js';

/**
 * The retail taxonomy's private files (Costco 3/7 plan v5 §6): the worklist, a classifier's output and a reviewed
 * mapping. Each is checked for exact keys, types, sort order and uniqueness before anything else, as parsed JSON; the
 * CLI reads each within its size bound. Shape problems are `retail-taxonomy-file-invalid`; a source on the wrong subject
 * kind, or a confidence where its source takes none, `retail-taxonomy-source-invalid`; a node the v2 tree lacks,
 * `retail-taxonomy-node-unknown`. Pure: no database, no file system.
 */

/** A file's top level and every record in it: exactly these keys, in any order. */
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const given = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (given.length !== wanted.length || given.some((key, index) => key !== wanted[index])) return invalid();
  return value as Record<string, unknown>;
}
function invalid(): never {
  throw new RetailRefusal('retail-taxonomy-file-invalid');
}
const LETTERS = /^[a-p]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DECISION_ID = /^[0-9a-f]{32}$/;
const ITEM_NUMBER = /^[0-9]{1,12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** The largest list any file holds: a household's products, departments or entries. */
const MAX_ENTRIES = 200_000;

const array = (value: unknown, max = MAX_ENTRIES): unknown[] => (Array.isArray(value) && value.length <= max ? value : invalid());
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid());
const letters = (value: unknown): string => (typeof value === 'string' && LETTERS.test(value) ? value : invalid());
const merchant = (value: unknown): string => (typeof value === 'string' && (RETAIL_MERCHANTS as readonly string[]).includes(value) ? value : invalid());
/** A stored description line as PR 2 keeps it (`retail_line_facts.title`, `title2`), or null. */
const nullableText = (value: unknown): string | null => (value === null || (typeof value === 'string' && value.length > 0
  && value.length <= RETAIL_TITLE_MAX) ? value : invalid());
/** A v2 node id, or `retail-taxonomy-node-unknown` for any other string; a non-string is the file's shape. */
function node(value: unknown): RetailTaxonomyNode {
  if (typeof value !== 'string') return invalid();
  if (!ITEM_TAXONOMY_V2_VIEW.isNode(value)) throw new RetailRefusal('retail-taxonomy-node-unknown');
  return value;
}
/** A confidence in basis points: an integer from 0 to 10_000 (Q-T1). */
const basisPoints = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  && value <= RETAIL_CONFIDENCE_BP_MAX ? value : invalid());
/** Each item's sort key strictly after the one before: sorted and unique together. */
function ascending<T>(items: readonly T[], keyOf: (item: T) => string): void {
  for (let index = 1; index < items.length; index += 1) if (!(keyOf(items[index - 1]) < keyOf(items[index]))) invalid();
}

// ----- the worklist (§6.1) -------------------------------------------------------------------------------------------

export interface RetailTaxonomyTitlePair {
  title: string | null;
  title2: string | null;
}

export interface RetailTaxonomyWorklistProduct {
  subjectKey: string;
  merchant: string;
  itemNumber: string;
  /** The distinct stored description pairs, sorted, at most eight. */
  titles: RetailTaxonomyTitlePair[];
  /** The channels its stored lines came through, sorted. */
  channels: string[];
  /** Its lines in the counting unit (§5): item, fee and fuel lines of canonical versions. */
  lines: number;
  /** Those the title rule files under precious metals. */
  titleRuleLines: number;
  /** R, the product-level resolution only (D-T1-3). */
  current: RetailProductTaxonomy;
  /** Every department its counted lines fall under, and `null` for lines without one, sorted (null last). */
  byDepartment: Array<{ department: number | null; lines: number; reviewed: RetailTaxonomyNode | null }>;
}

export interface RetailTaxonomyWorklistDepartment {
  subjectKey: string;
  merchant: string;
  department: number;
  lines: number;
  /** The distinct products among its counted lines. */
  products: number;
  /** Its current reviewed node; null for none or a withdrawal. */
  current: RetailTaxonomyNode | null;
}

export interface RetailTaxonomyWorklist {
  format: typeof RETAIL_TAXONOMY_WORKLIST_FORMAT;
  version: typeof RETAIL_TAXONOMY_FILE_VERSION;
  taxonomyVersion: typeof RETAIL_TAXONOMY_VERSION;
  taxonomyDigest: string;
  thresholds: { minAgentBp: number; suggestedBelowBp: number };
  taxonomy: Array<{ id: string; label: string; parent: string | null }>;
  products: RetailTaxonomyWorklistProduct[];
  departments: RetailTaxonomyWorklistDepartment[];
  coverage: { withProduct: number; withoutProduct: number; titleRule: number };
}

/** The v2 tree as the worklist lists it: every node's id, label and parent, in display order. */
export const retailTaxonomyWorklistTree = (): RetailTaxonomyWorklist['taxonomy'] =>
  ITEM_TAXONOMY_V2_VIEW.nodes.map(({ id, label, parent }) => ({ id, label, parent }));

const WORKLIST_KEYS = ['format', 'version', 'taxonomyVersion', 'taxonomyDigest', 'thresholds', 'taxonomy', 'products', 'departments', 'coverage'];
const PRODUCT_KEYS = ['subjectKey', 'merchant', 'itemNumber', 'titles', 'channels', 'lines', 'titleRuleLines', 'current', 'byDepartment'];
const DEPARTMENT_KEYS = ['subjectKey', 'merchant', 'department', 'lines', 'products', 'current'];
const RESOLUTION_KEYS = ['node', 'source', 'confidenceBp', 'suggested', 'suggestion'];
const titleKey = (pair: RetailTaxonomyTitlePair) => JSON.stringify([pair.title, pair.title2]);
/** A department number as PR 2 stores it (`retail_line_facts.department`). */
const department = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 9_999
  ? value : invalid());
const nodeOrNull = (value: unknown): RetailTaxonomyNode | null => (value === null ? null : node(value));

/** R as the worklist states it, checked for its shape and for the shared resolver's invariants. */
function resolutionOf(value: unknown): RetailProductTaxonomy {
  const record = exactly(value, RESOLUTION_KEYS);
  const source = record.source === null || record.source === 'owner' || record.source === 'agent' ? record.source : invalid();
  const confidenceBp = record.confidenceBp === null ? null : basisPoints(record.confidenceBp);
  if (typeof record.suggested !== 'boolean') return invalid();
  const suggestion = record.suggestion === null ? null : (() => {
    const entry = exactly(record.suggestion, ['node', 'confidenceBp']);
    return { node: node(entry.node), confidenceBp: basisPoints(entry.confidenceBp) };
  })();
  const resolved = node(record.node);
  if ((source === 'agent') !== (confidenceBp !== null) || (source !== null && suggestion !== null) || (record.suggested && source !== 'agent')
    || (source === null && resolved !== ITEM_TAXONOMY_RESIDUAL)) {
    return invalid();
  }
  return { node: resolved, source, confidenceBp, suggested: record.suggested, suggestion };
}

/** A worklist file's value (§6.1), as `adopt` reads it: its build's tree and thresholds, and every list sorted and unique. */
export function retailTaxonomyWorklistOf(value: unknown): RetailTaxonomyWorklist {
  const file = exactly(value, WORKLIST_KEYS);
  if (file.format !== RETAIL_TAXONOMY_WORKLIST_FORMAT || file.version !== RETAIL_TAXONOMY_FILE_VERSION
    || file.taxonomyVersion !== RETAIL_TAXONOMY_VERSION || file.taxonomyDigest !== ITEM_TAXONOMY_V2_DIGEST) return invalid();
  const thresholds = exactly(file.thresholds, ['minAgentBp', 'suggestedBelowBp']);
  if (thresholds.minAgentBp !== ITEM_TAXONOMY_MIN_AGENT_BP || thresholds.suggestedBelowBp !== ITEM_TAXONOMY_SUGGESTED_BELOW_BP) return invalid();
  const tree = array(file.taxonomy).map((entry) => {
    const record = exactly(entry, ['id', 'label', 'parent']);
    return { id: record.id, label: record.label, parent: record.parent };
  });
  if (JSON.stringify(tree) !== JSON.stringify(retailTaxonomyWorklistTree())) return invalid();
  const products = array(file.products).map((entry): RetailTaxonomyWorklistProduct => {
    const record = exactly(entry, PRODUCT_KEYS);
    if (typeof record.itemNumber !== 'string' || !ITEM_NUMBER.test(record.itemNumber)) return invalid();
    const titles = array(record.titles, RETAIL_TAXONOMY_TITLES_MAX).map((pair) => {
      const titled = exactly(pair, ['title', 'title2']);
      return { title: nullableText(titled.title), title2: nullableText(titled.title2) };
    });
    ascending(titles, titleKey);
    const channels = array(record.channels, RETAIL_CHANNELS.length).map((channel) => (
      typeof channel === 'string' && (RETAIL_CHANNELS as readonly string[]).includes(channel) ? channel : invalid()));
    ascending(channels, (channel) => channel);
    const byDepartment = array(record.byDepartment).map((group) => {
      const grouped = exactly(group, ['department', 'lines', 'reviewed']);
      return { department: grouped.department === null ? null : department(grouped.department), lines: count(grouped.lines),
        reviewed: nodeOrNull(grouped.reviewed) };
    });
    // Departments ascending, `null` (lines without one) last.
    ascending(byDepartment, (group) => (group.department === null ? '~' : String(group.department).padStart(4, '0')));
    const lines = count(record.lines);
    const titleRuleLines = count(record.titleRuleLines);
    if (titleRuleLines > lines || byDepartment.reduce((sum, group) => sum + group.lines, 0) !== lines) return invalid();
    return { subjectKey: letters(record.subjectKey), merchant: merchant(record.merchant), itemNumber: record.itemNumber, titles, channels, lines,
      titleRuleLines, current: resolutionOf(record.current), byDepartment };
  });
  ascending(products, (product) => product.subjectKey);
  const departments = array(file.departments).map((entry): RetailTaxonomyWorklistDepartment => {
    const record = exactly(entry, DEPARTMENT_KEYS);
    return { subjectKey: letters(record.subjectKey), merchant: merchant(record.merchant), department: department(record.department),
      lines: count(record.lines), products: count(record.products), current: nodeOrNull(record.current) };
  });
  ascending(departments, (entry) => entry.subjectKey);
  const coverage = exactly(file.coverage, ['withProduct', 'withoutProduct', 'titleRule']);
  return {
    format: RETAIL_TAXONOMY_WORKLIST_FORMAT, version: RETAIL_TAXONOMY_FILE_VERSION, taxonomyVersion: RETAIL_TAXONOMY_VERSION,
    taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST, thresholds: { minAgentBp: ITEM_TAXONOMY_MIN_AGENT_BP, suggestedBelowBp: ITEM_TAXONOMY_SUGGESTED_BELOW_BP },
    taxonomy: retailTaxonomyWorklistTree(), products, departments,
    coverage: { withProduct: count(coverage.withProduct), withoutProduct: count(coverage.withoutProduct), titleRule: count(coverage.titleRule) },
  };
}

// ----- a classifier's output (§6.2) ---------------------------------------------------------------------------------

export interface RetailTaxonomyAssignments {
  format: typeof RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT;
  version: typeof RETAIL_TAXONOMY_FILE_VERSION;
  taxonomyVersion: typeof RETAIL_TAXONOMY_VERSION;
  generatedAt: string;
  inputs: { worklistSha256: string };
  products: Array<{ subjectKey: string; node: RetailTaxonomyNode; confidenceBp: number }>;
}

/**
 * A classifier's output (§6.2): v2 node ids only (no labels, unlike Amazon's adapter), integer basis points (Q-T1), one
 * entry per product, sorted by subject key. Shape first, every entry; then the nodes.
 */
export function retailTaxonomyAssignmentsOf(value: unknown): RetailTaxonomyAssignments {
  const file = exactly(value, ['format', 'version', 'taxonomyVersion', 'generatedAt', 'inputs', 'products']);
  if (file.format !== RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT || file.version !== RETAIL_TAXONOMY_FILE_VERSION
    || file.taxonomyVersion !== RETAIL_TAXONOMY_VERSION) return invalid();
  if (typeof file.generatedAt !== 'string' || !INSTANT.test(file.generatedAt) || Number.isNaN(Date.parse(file.generatedAt))) return invalid();
  const inputs = exactly(file.inputs, ['worklistSha256']);
  if (typeof inputs.worklistSha256 !== 'string' || !HEX64.test(inputs.worklistSha256)) return invalid();
  const shaped = array(file.products).map((entry) => {
    const record = exactly(entry, ['subjectKey', 'node', 'confidenceBp']);
    if (typeof record.node !== 'string') return invalid();
    return { subjectKey: letters(record.subjectKey), node: record.node, confidenceBp: basisPoints(record.confidenceBp) };
  });
  if (shaped.length === 0) return invalid();
  ascending(shaped, (entry) => entry.subjectKey);
  const products = shaped.map((entry) => ({ ...entry, node: node(entry.node) }));
  return { format: RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT, version: RETAIL_TAXONOMY_FILE_VERSION, taxonomyVersion: RETAIL_TAXONOMY_VERSION,
    generatedAt: file.generatedAt, inputs: { worklistSha256: inputs.worklistSha256 }, products };
}

// ----- a reviewed mapping (§6.3) ------------------------------------------------------------------------------------

export interface RetailTaxonomyEntry {
  subjectKind: RetailTaxonomySubjectKind;
  subjectKey: string;
  source: RetailTaxonomySource;
  /** Null: a withdrawal of this source's assignment. */
  node: RetailTaxonomyNode | null;
  /** An agent's basis points when it names a node; null otherwise. */
  confidenceBp: number | null;
}

export interface RetailTaxonomyMapping {
  format: typeof RETAIL_TAXONOMY_MAPPING_FORMAT;
  version: typeof RETAIL_TAXONOMY_FILE_VERSION;
  taxonomyVersion: typeof RETAIL_TAXONOMY_VERSION;
  reviewed: true;
  /** A fresh random nonce per decision (D-T1-1), inside the bytes the mapping's SHA-256 covers. */
  decisionId: string;
  entries: RetailTaxonomyEntry[];
}

export const RETAIL_TAXONOMY_ENTRY_KEYS = ['subjectKind', 'subjectKey', 'source', 'node', 'confidenceBp'] as const;
const entryOrder = (entry: Pick<RetailTaxonomyEntry, 'subjectKind' | 'subjectKey' | 'source'>) =>
  `${entry.subjectKind}\u0000${entry.subjectKey}\u0000${entry.source}`;

/** Which source may assign which kind of subject (§6.3): products by the owner or an agent, departments by review only. */
const SOURCE_OF_KIND: Readonly<Record<RetailTaxonomySubjectKind, readonly RetailTaxonomySource[]>> = {
  product: ['owner', 'agent'],
  department: ['department-review'],
};

/**
 * A mapping file's value (§6.3, §7.4 step 1): its shape, every entry's, and the sort and uniqueness of (kind, key,
 * source); then each source on its kind, with a confidence only an agent's assignment carries
 * (`retail-taxonomy-source-invalid`); then the nodes.
 */
export function retailTaxonomyMappingOf(value: unknown): RetailTaxonomyMapping {
  const file = exactly(value, ['format', 'version', 'taxonomyVersion', 'reviewed', 'decisionId', 'entries']);
  if (file.format !== RETAIL_TAXONOMY_MAPPING_FORMAT || file.version !== RETAIL_TAXONOMY_FILE_VERSION
    || file.taxonomyVersion !== RETAIL_TAXONOMY_VERSION || file.reviewed !== true) return invalid();
  if (typeof file.decisionId !== 'string' || !DECISION_ID.test(file.decisionId)) return invalid();
  const shaped = array(file.entries).map((entry) => {
    const record = exactly(entry, RETAIL_TAXONOMY_ENTRY_KEYS);
    const subjectKind = (RETAIL_TAXONOMY_SUBJECT_KINDS as readonly unknown[]).includes(record.subjectKind)
      ? record.subjectKind as RetailTaxonomySubjectKind : invalid();
    const source = (RETAIL_TAXONOMY_SOURCES as readonly unknown[]).includes(record.source) ? record.source as RetailTaxonomySource : invalid();
    if (record.node !== null && typeof record.node !== 'string') return invalid();
    return { subjectKind, subjectKey: letters(record.subjectKey), source, node: record.node as string | null,
      confidenceBp: record.confidenceBp === null ? null : basisPoints(record.confidenceBp) };
  });
  if (shaped.length === 0) return invalid();
  ascending(shaped, entryOrder);
  for (const entry of shaped) {
    const agentAssigns = entry.source === 'agent' && entry.node !== null;
    if (!SOURCE_OF_KIND[entry.subjectKind].includes(entry.source) || (entry.confidenceBp !== null) !== agentAssigns) {
      throw new RetailRefusal('retail-taxonomy-source-invalid');
    }
  }
  const entries = shaped.map((entry): RetailTaxonomyEntry => ({ ...entry, node: entry.node === null ? null : node(entry.node) }));
  return { format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: RETAIL_TAXONOMY_FILE_VERSION, taxonomyVersion: RETAIL_TAXONOMY_VERSION,
    reviewed: true, decisionId: file.decisionId, entries };
}

// ----- adopt, and the files' text ------------------------------------------------------------------------------------

/**
 * `taxonomy adopt` (§7.1): a classifier's output, bound to the worklist it names by SHA-256
 * (`retail-taxonomy-worklist-mismatch`), every product in that worklist (`retail-taxonomy-subject-unknown`), as a new
 * mapping of agent rows only, under a fresh `decisionId` the caller mints. Classifier output never becomes an owner or
 * department row.
 */
export function adoptRetailTaxonomyAssignments(assignments: RetailTaxonomyAssignments, worklist: RetailTaxonomyWorklist, worklistSha256: string,
  decisionId: string): RetailTaxonomyMapping {
  if (assignments.inputs.worklistSha256 !== worklistSha256) throw new RetailRefusal('retail-taxonomy-worklist-mismatch');
  const listed = new Set(worklist.products.map((product) => product.subjectKey));
  const unknown = assignments.products.filter((entry) => !listed.has(entry.subjectKey)).length;
  if (unknown > 0) throw new RetailRefusal('retail-taxonomy-subject-unknown', { subjects: unknown });
  return retailTaxonomyMappingOf({
    format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: RETAIL_TAXONOMY_FILE_VERSION, taxonomyVersion: RETAIL_TAXONOMY_VERSION, reviewed: true,
    decisionId,
    entries: assignments.products.map((entry) => ({
      subjectKind: 'product', subjectKey: entry.subjectKey, source: 'agent', node: entry.node, confidenceBp: entry.confidenceBp,
    })),
  });
}

/** A file's text: its keys in the order its type declares them, two-space indents, one final newline. */
const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const serializeRetailTaxonomyWorklist = (worklist: RetailTaxonomyWorklist): string => text({
  format: worklist.format, version: worklist.version, taxonomyVersion: worklist.taxonomyVersion, taxonomyDigest: worklist.taxonomyDigest,
  thresholds: { minAgentBp: worklist.thresholds.minAgentBp, suggestedBelowBp: worklist.thresholds.suggestedBelowBp },
  taxonomy: worklist.taxonomy.map(({ id, label, parent }) => ({ id, label, parent })),
  products: worklist.products.map((product) => ({
    subjectKey: product.subjectKey, merchant: product.merchant, itemNumber: product.itemNumber,
    titles: product.titles.map(({ title, title2 }) => ({ title, title2 })), channels: product.channels, lines: product.lines,
    titleRuleLines: product.titleRuleLines,
    current: { node: product.current.node, source: product.current.source, confidenceBp: product.current.confidenceBp,
      suggested: product.current.suggested,
      suggestion: product.current.suggestion === null ? null : { node: product.current.suggestion.node, confidenceBp: product.current.suggestion.confidenceBp } },
    byDepartment: product.byDepartment.map(({ department: group, lines, reviewed }) => ({ department: group, lines, reviewed })),
  })),
  departments: worklist.departments.map((entry) => ({
    subjectKey: entry.subjectKey, merchant: entry.merchant, department: entry.department, lines: entry.lines, products: entry.products,
    current: entry.current,
  })),
  coverage: { withProduct: worklist.coverage.withProduct, withoutProduct: worklist.coverage.withoutProduct, titleRule: worklist.coverage.titleRule },
});

export const serializeRetailTaxonomyMapping = (mapping: RetailTaxonomyMapping): string => text({
  format: mapping.format, version: mapping.version, taxonomyVersion: mapping.taxonomyVersion, reviewed: mapping.reviewed,
  decisionId: mapping.decisionId,
  entries: mapping.entries.map(({ subjectKind, subjectKey, source, node: assigned, confidenceBp }) => ({
    subjectKind, subjectKey, source, node: assigned, confidenceBp,
  })),
});
