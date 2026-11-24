import type Database from 'better-sqlite3';
import {
  ITEM_TAXONOMY_ASSET_NODE,
  ITEM_TAXONOMY_BP_POLICY,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_V2_VIEW,
  resolveItemTaxonomy,
  type ItemTaxonomyV2NodeId,
} from '@finance-tracker/shared';

import { digest } from '../amazon/policy.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { retailLetters, type RetailTaxonomySubjectKind } from './common.js';
import type { RetailTaxonomySource } from './schema.js';
import { RETAIL_TAXONOMY_STORED_VERSION, RETAIL_TAXONOMY_SUBJECT_FORMAT } from './taxonomyFormats.js';

/**
 * A retail line's item category (Costco 3/7 plan v5 §4): pure, read-only and dormant. Nothing at boot, no route and no
 * Spending answer reads it yet; PR 4 calls `resolveRetailLineTaxonomy` once per line.
 *
 * - **R, per product:** the shared resolver's answer for the product's winning current row (its owner row, else its
 *   agent row), in basis points. A withdrawal removes its source; a row of another version is never current.
 * - **F, per line:** the title rule's match first (`precious-metals`, whatever any row says); else the product, when
 *   the owner filed it (any node, the residual included) or an agent filed it under a node; else the department's
 *   reviewed mapping, when it names a node; else the residual, with R's suggestion.
 * - **`metalHold`** reads its own evidence, apart from the winner (D-T3-2): the title rule, and every stored row of the
 *   line's product or department that names `precious-metals`, of any source, confidence, version or currency. No row
 *   clears it.
 */

export type RetailTaxonomyNode = ItemTaxonomyV2NodeId;

/** A taxonomy subject's key (§5): PR 2's letter hex of a digest of its kind, merchant and item number or department. */
const subjectKey = (kind: RetailTaxonomySubjectKind, merchant: string, value: string | number): string =>
  retailLetters(digest({ format: RETAIL_TAXONOMY_SUBJECT_FORMAT, version: 1, kind, merchant, value }));
/** A product's subject key: (merchant, item number), whatever its channel, title or membership. */
export const retailProductKey = (merchant: string, itemNumber: string): string => subjectKey('product', merchant, itemNumber);
/** A department's subject key: (merchant, department number). */
export const retailDepartmentKey = (merchant: string, department: number): string => subjectKey('department', merchant, department);

/** One stored assignment row, with its import's sequence and stored version label. */
export interface RetailTaxonomyRow {
  subjectKind: RetailTaxonomySubjectKind;
  subjectKey: string;
  source: RetailTaxonomySource;
  /** Null: the source withdrew its assignment. */
  node: string | null;
  confidenceBp: number | null;
  taxonomyImportId: string;
  seq: number;
  taxonomyVersion: string;
}

/** Every stored assignment row, by import sequence. Read-only; the caller has found the tables present. */
export function readRetailTaxonomyRows(db: Database.Database): RetailTaxonomyRow[] {
  try {
    return db.prepare(`SELECT a.subject_kind AS subjectKind, a.subject_key AS subjectKey, a.source, a.node, a.confidence_bp AS confidenceBp,
        a.taxonomy_import_id AS taxonomyImportId, t.seq, t.taxonomy_version AS taxonomyVersion
      FROM retail_taxonomy_assignments a JOIN retail_taxonomy_imports t ON t.taxonomy_import_id = a.taxonomy_import_id
      ORDER BY t.seq, a.subject_kind, a.subject_key, a.source`).all() as RetailTaxonomyRow[];
  } catch (error) {
    throw toValueFreeDbError('read retail taxonomy', error);
  }
}

const rowKey = (kind: string, key: string, source: string) => `${kind}:${key}:${source}`;
const subjectId = (kind: string, key: string) => `${kind}:${key}`;

/** The rows a resolution reads, indexed once (per snapshot). */
export interface RetailTaxonomyIndex {
  /** A subject's current row for a source: the highest-sequence row of this build's version (PR 2 §4.4), or undefined. */
  current(kind: RetailTaxonomySubjectKind, key: string, source: RetailTaxonomySource): RetailTaxonomyRow | undefined;
  /** Whether any stored row of the subject names `precious-metals`: current or not, any source, confidence or version (§4.2). */
  metalEvidence(kind: RetailTaxonomySubjectKind, key: string): boolean;
  /** Stored rows of another version: never current (Q-T4), counted by `plan`. */
  readonly otherVersionRows: number;
}

export function retailTaxonomyIndex(rows: readonly RetailTaxonomyRow[]): RetailTaxonomyIndex {
  const current = new Map<string, RetailTaxonomyRow>();
  const metal = new Set<string>();
  let otherVersionRows = 0;
  for (const row of rows) {
    if (row.node === ITEM_TAXONOMY_ASSET_NODE) metal.add(subjectId(row.subjectKind, row.subjectKey));
    if (row.taxonomyVersion !== RETAIL_TAXONOMY_STORED_VERSION) {
      otherVersionRows += 1;
      continue;
    }
    const key = rowKey(row.subjectKind, row.subjectKey, row.source);
    const held = current.get(key);
    if (held === undefined || row.seq > held.seq) current.set(key, row);
  }
  return {
    current: (kind, key, source) => current.get(rowKey(kind, key, source)),
    metalEvidence: (kind, key) => metal.has(subjectId(kind, key)),
    otherVersionRows,
  };
}

/** A current row's node, when it names one of the v2 tree's nodes: never a withdrawal, never a node the tree lacks. */
const usableNode = (row: RetailTaxonomyRow | undefined): RetailTaxonomyNode | null =>
  (row !== undefined && ITEM_TAXONOMY_V2_VIEW.isNode(row.node) ? row.node : null);

/** A product's resolution, R (§4.1): the shared resolver's, in basis points. */
export interface RetailProductTaxonomy {
  node: RetailTaxonomyNode;
  source: 'owner' | 'agent' | null;
  confidenceBp: number | null;
  suggested: boolean;
  suggestion: { node: RetailTaxonomyNode; confidenceBp: number } | null;
}

/** The product's winning current row: its owner's, else its agent's; a withdrawal removes its source. */
export function retailProductWinner(owner: RetailTaxonomyRow | undefined, agent: RetailTaxonomyRow | undefined):
  { node: RetailTaxonomyNode; source: 'owner' | 'agent'; confidence: number | null } | undefined {
  const ownerNode = usableNode(owner);
  if (ownerNode !== null) return { node: ownerNode, source: 'owner', confidence: null };
  const agentNode = usableNode(agent);
  if (agentNode !== null) return { node: agentNode, source: 'agent', confidence: agent!.confidenceBp };
  return undefined;
}

/** R for a product's current owner and agent rows: exactly what the shared resolver returns, with the bp policy. */
export function resolveRetailProductTaxonomy(owner: RetailTaxonomyRow | undefined, agent: RetailTaxonomyRow | undefined): RetailProductTaxonomy {
  const resolved = resolveItemTaxonomy<RetailTaxonomyNode, number | null>(retailProductWinner(owner, agent), ITEM_TAXONOMY_BP_POLICY);
  return {
    node: resolved.node,
    source: resolved.source,
    confidenceBp: resolved.confidence,
    suggested: resolved.suggested,
    suggestion: resolved.suggestion === null ? null : { node: resolved.suggestion.node, confidenceBp: resolved.suggestion.confidence },
  };
}

/** Where a line's node came from: the title rule (a resolution source only, never stored), or a stored row's source. */
export const RETAIL_LINE_TAXONOMY_SOURCES = ['title-rule', 'owner', 'agent', 'department-review'] as const;
export type RetailLineTaxonomySource = (typeof RETAIL_LINE_TAXONOMY_SOURCES)[number];

/** What one line's resolution reads (§4.1): computed once per product and per department, F once per line. */
export interface RetailLineTaxonomyInput {
  /** The title rule matched the line: its stored metal evidence (#308's title rule). */
  titleRule: boolean;
  /** Its product's R and metal evidence; null for a line without a stored item number (§4.3). */
  product: { resolution: RetailProductTaxonomy; metalEvidence: boolean } | null;
  /** Its department's current reviewed node (null for none or a withdrawal) and metal evidence; null without a department. */
  department: { reviewed: RetailTaxonomyNode | null; metalEvidence: boolean } | null;
}

/** A line's resolution, F (§4.1). */
export interface RetailLineTaxonomy {
  node: RetailTaxonomyNode;
  source: RetailLineTaxonomySource | null;
  confidenceBp: number | null;
  suggested: boolean;
  suggestion: { node: RetailTaxonomyNode; confidenceBp: number } | null;
  /** The line has metal evidence (§4.2), whatever resolved its node. */
  metalHold: boolean;
}

/**
 * F, pure (§4.1). A step resolves a line only with a node other than the residual, except the owner's choice, which is
 * final whatever its node. `metalHold` is not chosen by the steps: it is the line's metal evidence (§4.2).
 */
export function resolveRetailLineTaxonomy(line: RetailLineTaxonomyInput): RetailLineTaxonomy {
  const metalHold = line.titleRule || line.product?.metalEvidence === true || line.department?.metalEvidence === true;
  if (line.titleRule) {
    return { node: ITEM_TAXONOMY_ASSET_NODE, source: 'title-rule', confidenceBp: null, suggested: false, suggestion: null, metalHold };
  }
  const product = line.product?.resolution ?? null;
  if (product !== null && (product.source === 'owner' || (product.source === 'agent' && product.node !== ITEM_TAXONOMY_RESIDUAL))) {
    return { node: product.node, source: product.source, confidenceBp: product.confidenceBp, suggested: product.suggested, suggestion: null, metalHold };
  }
  const reviewed = line.department?.reviewed ?? null;
  if (reviewed !== null && reviewed !== ITEM_TAXONOMY_RESIDUAL) {
    return { node: reviewed, source: 'department-review', confidenceBp: null, suggested: false, suggestion: null, metalHold };
  }
  return { node: ITEM_TAXONOMY_RESIDUAL, source: null, confidenceBp: null, suggested: false, suggestion: product?.suggestion ?? null, metalHold };
}

/** A line as the resolver reads it from PR 2's tables: its merchant, item number, department and title-rule match. */
export interface RetailTaxonomyLine {
  merchant: string;
  itemNumber: string | null;
  department: number | null;
  titleRule: boolean;
}

/** R and the metal evidence per product, the reviewed node and the metal evidence per department: each computed once. */
export interface RetailTaxonomyResolver {
  product(merchant: string, itemNumber: string): { key: string; resolution: RetailProductTaxonomy; metalEvidence: boolean };
  department(merchant: string, department: number): { key: string; reviewed: RetailTaxonomyNode | null; metalEvidence: boolean };
  /** F for one line, from its own title-rule match, product and department. */
  line(line: RetailTaxonomyLine): RetailLineTaxonomy;
}

/** The resolver over one snapshot's rows (§4.1): products and departments memoized, F computed per line. */
export function retailTaxonomyResolver(index: RetailTaxonomyIndex): RetailTaxonomyResolver {
  const products = new Map<string, ReturnType<RetailTaxonomyResolver['product']>>();
  const departments = new Map<string, ReturnType<RetailTaxonomyResolver['department']>>();
  const product: RetailTaxonomyResolver['product'] = (merchant, itemNumber) => {
    const key = retailProductKey(merchant, itemNumber);
    let entry = products.get(key);
    if (entry === undefined) {
      entry = { key, resolution: resolveRetailProductTaxonomy(index.current('product', key, 'owner'), index.current('product', key, 'agent')),
        metalEvidence: index.metalEvidence('product', key) };
      products.set(key, entry);
    }
    return entry;
  };
  const department: RetailTaxonomyResolver['department'] = (merchant, number) => {
    const key = retailDepartmentKey(merchant, number);
    let entry = departments.get(key);
    if (entry === undefined) {
      entry = { key, reviewed: usableNode(index.current('department', key, 'department-review')), metalEvidence: index.metalEvidence('department', key) };
      departments.set(key, entry);
    }
    return entry;
  };
  return {
    product,
    department,
    line: (line) => resolveRetailLineTaxonomy({
      titleRule: line.titleRule,
      product: line.itemNumber === null ? null : product(line.merchant, line.itemNumber),
      department: line.department === null ? null : department(line.merchant, line.department),
    }),
  };
}
