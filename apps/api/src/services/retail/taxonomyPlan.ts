import type Database from 'better-sqlite3';
import {
  ITEM_TAXONOMY_ASSET_NODE,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_V2_DIGEST,
  ITEM_TAXONOMY_V2_VIEW,
  itemTaxonomyCategoriesMissing,
} from '@finance-tracker/shared';

import { digest } from '../amazon/policy.js';
import { effectiveCategories } from '../amazon/resolver.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { RetailRefusal, type RetailTaxonomySubjectKind } from './common.js';
import { RETAIL_SCHEMA_DIGEST, type RetailTaxonomySource } from './schema.js';
import type { RetailTaxonomyEntry, RetailTaxonomyMapping } from './taxonomyFiles.js';
import { RETAIL_TAXONOMY_PLAN_FORMAT, RETAIL_TAXONOMY_STORED_VERSION } from './taxonomyFormats.js';
import {
  readRetailTaxonomyRows,
  retailProductKey,
  retailProductWinner,
  retailTaxonomyIndex,
  retailTaxonomyResolver,
  type RetailTaxonomyRow,
} from './taxonomyResolver.js';
import { readRetailTaxonomySubjects, retailTaxonomyByDepartment, type RetailTaxonomySubjects } from './taxonomyWorklist.js';

/**
 * `taxonomy plan` and the import's plan (Costco 3/7 plan v5 §7.3): what a mapping would do, its counters, and the
 * digest a GO pins. One read transaction reads everything the import would read into a plain read model; the preimage
 * is a pure function of it (D-T2-2), so each of its dependencies is proved without a database.
 *
 * The preimage holds the digests (the frozen retail schema, the v2 tree, the mapping, whose SHA-256 covers its
 * `decisionId`), `auditSeq` (the highest audit sequence: every retail write appends one, so any write between the plan
 * and the import changes it), every entry with its action, the current rows each affected subject's resolution reads
 * (D-T1-2), the stored `precious-metals` rows its lines' veto reads (D-T3-2), and the lines that make it known.
 */

export const RETAIL_TAXONOMY_ACTIONS = ['insert', 'replace', 'withdraw', 'unchanged'] as const;
export type RetailTaxonomyAction = (typeof RETAIL_TAXONOMY_ACTIONS)[number];

/** A subject a mapping names, as the plan read it. */
export interface RetailTaxonomyPlanSubject {
  subjectKind: RetailTaxonomySubjectKind;
  subjectKey: string;
  /** The subjects of the other kind its counted lines read: a product's departments, a department's products. Sorted. */
  related: string[];
  /** `version_ref/line_ref` of every stored line that makes it known (§5), sorted. */
  storedRefs: string[];
  /** Its lines in the counting unit. */
  lines: number;
}

/** What the plan's read transaction returned: a plain value (D-T2-2). */
export interface RetailTaxonomyPlanReadModel {
  schemaDigest: string;
  taxonomyDigest: string;
  mappingSha256: string;
  auditSeq: number;
  /** The mapping's entries, in file order. */
  entries: RetailTaxonomyEntry[];
  /** Every stored assignment row, of any version. */
  rows: RetailTaxonomyRow[];
  /** Each subject the mapping names, once. */
  subjects: RetailTaxonomyPlanSubject[];
}

type RowKey = { subjectKind: RetailTaxonomySubjectKind; subjectKey: string; source: RetailTaxonomySource };
/** A current row a planned resolution reads, or its absence. A withdrawal is a row, with a null node. */
export type RetailTaxonomyDependency = RowKey & ({ taxonomyImportId: string; seq: number; node: string | null; confidenceBp: number | null }
  | { absent: true });
/** A stored row naming `precious-metals` that a subject's lines read for `metalHold` (D-T3-2). */
export type RetailTaxonomyMetalKey = RowKey & { taxonomyImportId: string; seq: number };
export interface RetailTaxonomyWitness {
  subjectKind: RetailTaxonomySubjectKind;
  subjectKey: string;
  linesSha256: string;
  lines: number;
}

export interface RetailTaxonomyPlanPreimage {
  format: typeof RETAIL_TAXONOMY_PLAN_FORMAT;
  version: 1;
  schemaDigest: string;
  taxonomyDigest: string;
  mappingSha256: string;
  auditSeq: number;
  entries: Array<RetailTaxonomyEntry & { action: RetailTaxonomyAction }>;
  dependencies: RetailTaxonomyDependency[];
  metalEvidence: RetailTaxonomyMetalKey[];
  witnesses: RetailTaxonomyWitness[];
}

/** An entry against its subject's current row for its source (§7.3). Every entry is written, whatever its action. */
export function retailTaxonomyAction(entry: RetailTaxonomyEntry, current: RetailTaxonomyRow | undefined): RetailTaxonomyAction {
  if (entry.node === null) return current === undefined || current.node === null ? 'unchanged' : 'withdraw';
  if (current === undefined) return 'insert';
  return current.node === entry.node && current.confidenceBp === entry.confidenceBp ? 'unchanged' : 'replace';
}

const order = (a: RowKey, b: RowKey): number => (a.subjectKind < b.subjectKind ? -1 : a.subjectKind > b.subjectKind ? 1
  : a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
const other = (kind: RetailTaxonomySubjectKind): RetailTaxonomySubjectKind => (kind === 'product' ? 'department' : 'product');

/** The rows a subject's planned resolution reads: its own, and those of the subjects its lines fall back to or under. */
function readsOf(subject: RetailTaxonomyPlanSubject): RowKey[] {
  if (subject.subjectKind === 'product') {
    return [
      { subjectKind: 'product', subjectKey: subject.subjectKey, source: 'owner' },
      { subjectKind: 'product', subjectKey: subject.subjectKey, source: 'agent' },
      ...subject.related.map((key): RowKey => ({ subjectKind: 'department', subjectKey: key, source: 'department-review' })),
    ];
  }
  return [
    { subjectKind: 'department', subjectKey: subject.subjectKey, source: 'department-review' },
    ...subject.related.flatMap((key): RowKey[] => [
      { subjectKind: 'product', subjectKey: key, source: 'owner' },
      { subjectKind: 'product', subjectKey: key, source: 'agent' },
    ]),
  ];
}

/** The plan's preimage (§7.3), pure: everything the planned resolution of each affected subject reads. */
export function retailTaxonomyPlanPreimage(model: RetailTaxonomyPlanReadModel): RetailTaxonomyPlanPreimage {
  const index = retailTaxonomyIndex(model.rows);
  const dependencies = new Map<string, RetailTaxonomyDependency>();
  for (const read of model.subjects.flatMap(readsOf)) {
    const row = index.current(read.subjectKind, read.subjectKey, read.source);
    dependencies.set(`${read.subjectKind}:${read.subjectKey}:${read.source}`, row === undefined ? { ...read, absent: true }
      : { ...read, taxonomyImportId: row.taxonomyImportId, seq: row.seq, node: row.node, confidenceBp: row.confidenceBp });
  }
  const vetoed = new Set(model.subjects.flatMap((subject) => [`${subject.subjectKind}:${subject.subjectKey}`,
    ...subject.related.map((key) => `${other(subject.subjectKind)}:${key}`)]));
  const metalEvidence = model.rows
    .filter((row) => row.node === ITEM_TAXONOMY_ASSET_NODE && vetoed.has(`${row.subjectKind}:${row.subjectKey}`))
    .map(({ subjectKind, subjectKey, source, taxonomyImportId, seq }): RetailTaxonomyMetalKey => ({ subjectKind, subjectKey, source, taxonomyImportId, seq }))
    .sort((a, b) => order(a, b) || a.seq - b.seq);
  return {
    format: RETAIL_TAXONOMY_PLAN_FORMAT,
    version: 1,
    schemaDigest: model.schemaDigest,
    taxonomyDigest: model.taxonomyDigest,
    mappingSha256: model.mappingSha256,
    auditSeq: model.auditSeq,
    entries: model.entries.map((entry) => ({ ...entry, action: retailTaxonomyAction(entry, index.current(entry.subjectKind, entry.subjectKey, entry.source)) })),
    dependencies: [...dependencies.values()].sort(order),
    metalEvidence,
    witnesses: model.subjects.map((subject): RetailTaxonomyWitness => ({
      subjectKind: subject.subjectKind, subjectKey: subject.subjectKey, linesSha256: digest(subject.storedRefs), lines: subject.lines,
    })).sort((a, b) => order({ ...a, source: 'owner' }, { ...b, source: 'owner' })),
  };
}

/** `planDigest` (lowercase hex): the SHA-256 of the preimage's canonical JSON (sorted keys, no white space). */
export const retailTaxonomyPlanDigest = (model: RetailTaxonomyPlanReadModel): string => digest(retailTaxonomyPlanPreimage(model));

/**
 * The plan's counters, output only (§7.3): each family a partition, every status from the resolver's own output (R per
 * product, F per line), never from a row's source or confidence (D-T2-1). `rows` are as they would be once imported.
 */
export interface RetailTaxonomyCounters {
  products: { total: number; assigned: number; suggested: number; needsReview: number; withSuggestion: number; assetFiled: number };
  productSources: { ownerRows: number; agentRows: number; noRow: number; explicitResidual: number };
  lines: { total: number; assigned: number; suggested: number; needsReview: number; withSuggestion: number; assetFiled: number; metalHold: number };
  lineSources: { titleRule: number; owner: number; agent: number; department: number; none: number; withoutProduct: number };
  rowsNotCurrent: number;
}

export function retailTaxonomyCounters(subjects: RetailTaxonomySubjects, rows: readonly RetailTaxonomyRow[]): RetailTaxonomyCounters {
  const index = retailTaxonomyIndex(rows);
  const resolver = retailTaxonomyResolver(index);
  const counters: RetailTaxonomyCounters = {
    products: { total: 0, assigned: 0, suggested: 0, needsReview: 0, withSuggestion: 0, assetFiled: 0 },
    productSources: { ownerRows: 0, agentRows: 0, noRow: 0, explicitResidual: 0 },
    lines: { total: 0, assigned: 0, suggested: 0, needsReview: 0, withSuggestion: 0, assetFiled: 0, metalHold: 0 },
    lineSources: { titleRule: 0, owner: 0, agent: 0, department: 0, none: 0, withoutProduct: 0 },
    rowsNotCurrent: index.otherVersionRows,
  };
  const status = (target: { assigned: number; suggested: number; needsReview: number; withSuggestion: number; assetFiled: number },
    resolved: { node: string; suggested: boolean; suggestion: unknown }) => {
    if (resolved.node === ITEM_TAXONOMY_RESIDUAL) target.needsReview += 1;
    else if (resolved.suggested) target.suggested += 1;
    else target.assigned += 1;
    if (resolved.suggestion !== null) target.withSuggestion += 1;
    if (resolved.node === ITEM_TAXONOMY_ASSET_NODE) target.assetFiled += 1;
  };
  for (const product of subjects.products.values()) {
    counters.products.total += 1;
    status(counters.products, resolver.product(product.merchant, product.itemNumber).resolution);
    const winner = retailProductWinner(index.current('product', product.key, 'owner'), index.current('product', product.key, 'agent'));
    if (winner === undefined) counters.productSources.noRow += 1;
    else {
      counters.productSources[winner.source === 'owner' ? 'ownerRows' : 'agentRows'] += 1;
      if (winner.node === ITEM_TAXONOMY_RESIDUAL) counters.productSources.explicitResidual += 1;
    }
  }
  for (const line of subjects.lines) {
    const resolved = resolver.line(line);
    counters.lines.total += 1;
    status(counters.lines, resolved);
    if (resolved.metalHold) counters.lines.metalHold += 1;
    const source = resolved.source;
    counters.lineSources[source === 'title-rule' ? 'titleRule' : source === 'department-review' ? 'department' : source ?? 'none'] += 1;
    if (line.itemNumber === null) counters.lineSources.withoutProduct += 1;
  }
  return counters;
}

/** The rows as the import would leave them: the stored ones, then the mapping's entries as the next import's rows. */
export function retailTaxonomyPlannedRows(rows: readonly RetailTaxonomyRow[], entries: readonly RetailTaxonomyEntry[]): RetailTaxonomyRow[] {
  const seq = rows.reduce((highest, row) => Math.max(highest, row.seq), 0) + 1;
  return [...rows, ...entries.map((entry): RetailTaxonomyRow => ({ ...entry, taxonomyImportId: 'planned', seq,
    taxonomyVersion: RETAIL_TAXONOMY_STORED_VERSION }))];
}

/** The node card categories the household's card data doesn't use, with the nodes that name them (§4.4); never the asset node. */
export function retailTaxonomyCategoriesMissing(db: Database.Database): { count: number; nodes: string[] } {
  const cards = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'card_transactions'`).get() !== undefined;
  const missing = itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V2_VIEW, new Set(cards ? effectiveCategories(db) : []),
    { except: [ITEM_TAXONOMY_ASSET_NODE] });
  return {
    count: missing.length,
    nodes: ITEM_TAXONOMY_V2_VIEW.nodes.filter((node) => node.id !== ITEM_TAXONOMY_ASSET_NODE && missing.includes(node.cardCategory)).map((node) => node.id),
  };
}

export interface RetailTaxonomyPlan {
  mappingSha256: string;
  decisionId: string;
  entries: number;
  actions: Record<RetailTaxonomyAction, number>;
  counters: RetailTaxonomyCounters;
  categoriesMissing: { count: number; nodes: string[] };
  /** Lowercase hex. */
  planDigest: string;
}

/**
 * The plan's read model, from one read of the tables: the caller's transaction, after its schema and reserved-value
 * checks. A mapping naming a subject no stored line makes known is refused whole (`retail-taxonomy-subject-unknown`).
 */
export function readRetailTaxonomyPlanModel(db: Database.Database, mapping: RetailTaxonomyMapping, mappingSha256: string,
  subjects: RetailTaxonomySubjects, rows: RetailTaxonomyRow[]): RetailTaxonomyPlanReadModel {
  const named = new Map<string, { subjectKind: RetailTaxonomySubjectKind; subjectKey: string }>();
  for (const { subjectKind, subjectKey } of mapping.entries) named.set(`${subjectKind}:${subjectKey}`, { subjectKind, subjectKey });
  const unknown = [...named.values()].filter(({ subjectKind, subjectKey }) => !(subjectKind === 'product' ? subjects.products : subjects.departments)
    .has(subjectKey)).length;
  if (unknown > 0) throw new RetailRefusal('retail-taxonomy-subject-unknown', { subjects: unknown });
  let auditSeq: number;
  try {
    auditSeq = db.prepare('SELECT coalesce(max(seq), 0) FROM retail_audit').pluck().get() as number;
  } catch (error) {
    throw toValueFreeDbError('read retail audit', error);
  }
  return {
    schemaDigest: RETAIL_SCHEMA_DIGEST,
    taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST,
    mappingSha256,
    auditSeq,
    entries: mapping.entries,
    rows,
    subjects: [...named.values()].map(({ subjectKind, subjectKey }): RetailTaxonomyPlanSubject => {
      if (subjectKind === 'product') {
        const product = subjects.products.get(subjectKey)!;
        return { subjectKind, subjectKey, storedRefs: product.storedRefs, lines: product.counted.length,
          related: retailTaxonomyByDepartment(product).flatMap(({ key }) => (key === null ? [] : [key])).sort() };
      }
      const department = subjects.departments.get(subjectKey)!;
      const products = department.counted.flatMap((line) => (line.itemNumber === null ? [] : [retailProductKey(line.merchant, line.itemNumber)]));
      return { subjectKind, subjectKey, storedRefs: department.storedRefs, lines: department.counted.length, related: [...new Set(products)].sort() };
    }),
  };
}

/**
 * What the mapping would do (§7.3), read in the caller's one read transaction after its schema and reserved-value
 * checks: its actions, the counters as if it were imported, the categories the card data lacks, and `planDigest`.
 */
export function planRetailTaxonomyImport(db: Database.Database, mapping: RetailTaxonomyMapping, mappingSha256: string): RetailTaxonomyPlan {
  const subjects = readRetailTaxonomySubjects(db);
  const rows = readRetailTaxonomyRows(db);
  const model = readRetailTaxonomyPlanModel(db, mapping, mappingSha256, subjects, rows);
  const preimage = retailTaxonomyPlanPreimage(model);
  const actions = Object.fromEntries(RETAIL_TAXONOMY_ACTIONS.map((action) => [action, 0])) as Record<RetailTaxonomyAction, number>;
  for (const entry of preimage.entries) actions[entry.action] += 1;
  return {
    mappingSha256,
    decisionId: mapping.decisionId,
    entries: mapping.entries.length,
    actions,
    counters: retailTaxonomyCounters(subjects, retailTaxonomyPlannedRows(rows, mapping.entries)),
    categoriesMissing: retailTaxonomyCategoriesMissing(db),
    planDigest: digest(preimage),
  };
}
