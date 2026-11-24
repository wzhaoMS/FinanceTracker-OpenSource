import type Database from 'better-sqlite3';
import {
  ITEM_TAXONOMY_MIN_AGENT_BP,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
  ITEM_TAXONOMY_V2_DIGEST,
} from '@finance-tracker/shared';
import { RETAIL_LINE_KINDS, type RetailLineKind } from '@finance-tracker/shared/retail-import-payload';

import { toValueFreeDbError } from '../dbErrors.js';
import {
  retailTaxonomyWorklistTree,
  type RetailTaxonomyTitlePair,
  type RetailTaxonomyWorklist,
  type RetailTaxonomyWorklistDepartment,
  type RetailTaxonomyWorklistProduct,
} from './taxonomyFiles.js';
import {
  RETAIL_TAXONOMY_FILE_VERSION,
  RETAIL_TAXONOMY_TITLES_MAX,
  RETAIL_TAXONOMY_VERSION,
  RETAIL_TAXONOMY_WORKLIST_FORMAT,
} from './taxonomyFormats.js';
import {
  readRetailTaxonomyRows,
  retailDepartmentKey,
  retailProductKey,
  retailTaxonomyIndex,
  retailTaxonomyResolver,
  type RetailTaxonomyResolver,
} from './taxonomyResolver.js';

/**
 * What the retail taxonomy reads from PR 2's receipts (Costco 3/7 plan v5 §5, §6.1): the lines it counts and the
 * subjects a mapping may name, and the worklist built from them. Read-only, inside the caller's read transaction, after
 * the caller's schema and reserved-value checks.
 *
 * - **The counting unit:** one line of kind item, fee or fuel in a receipt's canonical version, whatever the receipt's
 *   state, once per (receipt ref, line ref). A coupon is never counted: PR 4 gives it its parent line's category.
 * - **A known subject:** a product (merchant, item number) or a department (merchant, department number) of any line of
 *   those kinds in any stored version, canonical or not. A coupon line names no subject: its item number is the coupon's
 *   own. A subject seen only in a version that isn't canonical is known, with no counted lines.
 */

/** The counting unit's line kinds: every kind but a coupon. */
export const RETAIL_TAXONOMY_LINE_KINDS = RETAIL_LINE_KINDS.filter((kind): kind is Exclude<RetailLineKind, 'coupon'> => kind !== 'coupon');
const KIND_LIST = RETAIL_TAXONOMY_LINE_KINDS.map((kind) => `'${kind}'`).join(', ');

/** One line in the counting unit. */
export interface RetailTaxonomyCountedLine {
  receiptRef: string;
  lineRef: string;
  merchant: string;
  itemNumber: string | null;
  department: number | null;
  /** The title rule matched it: its stored metal evidence (`metal_rule`, #308's title rule). */
  titleRule: boolean;
}

/** A known product: its stored lines (every version), and its counted ones. */
export interface RetailTaxonomyProductSubject {
  key: string;
  merchant: string;
  itemNumber: string;
  titles: RetailTaxonomyTitlePair[];
  channels: string[];
  /** `version_ref/line_ref` of every stored line that makes it known, sorted. */
  storedRefs: string[];
  counted: RetailTaxonomyCountedLine[];
}

/** A known department: its stored lines (every version), and its counted ones. */
export interface RetailTaxonomyDepartmentSubject {
  key: string;
  merchant: string;
  department: number;
  storedRefs: string[];
  counted: RetailTaxonomyCountedLine[];
}

export interface RetailTaxonomySubjects {
  /** Every counted line, by receipt ref and line ref. */
  lines: RetailTaxonomyCountedLine[];
  /** Every known product and department, by subject key. */
  products: ReadonlyMap<string, RetailTaxonomyProductSubject>;
  departments: ReadonlyMap<string, RetailTaxonomyDepartmentSubject>;
}

interface StoredLine {
  merchant: string;
  channel: string;
  versionRef: string;
  lineRef: string;
  itemNumber: string | null;
  department: number | null;
  title: string | null;
  title2: string | null;
}

/** The counted lines and the known subjects, in one pass over PR 2's tables. */
export function readRetailTaxonomySubjects(db: Database.Database): RetailTaxonomySubjects {
  let lines: RetailTaxonomyCountedLine[];
  let stored: StoredLine[];
  try {
    lines = (db.prepare(`SELECT r.receipt_ref AS receiptRef, f.line_ref AS lineRef, r.merchant, f.item_number AS itemNumber, f.department,
        f.metal_rule IS NOT NULL AS titleRule
      FROM retail_receipts r JOIN retail_line_facts f ON f.version_ref = r.canonical_version
      WHERE f.kind IN (${KIND_LIST}) ORDER BY r.receipt_ref, f.line_ref`).all() as Array<Omit<RetailTaxonomyCountedLine, 'titleRule'> & { titleRule: number }>)
      .map((line) => ({ ...line, titleRule: line.titleRule === 1 }));
    stored = db.prepare(`SELECT r.merchant, r.channel, f.version_ref AS versionRef, f.line_ref AS lineRef, f.item_number AS itemNumber, f.department,
        f.title, f.title2
      FROM retail_line_facts f JOIN retail_receipt_versions v ON v.version_ref = f.version_ref JOIN retail_receipts r ON r.receipt_ref = v.receipt_ref
      WHERE f.kind IN (${KIND_LIST}) AND (f.item_number IS NOT NULL OR f.department IS NOT NULL)
      ORDER BY f.version_ref, f.line_ref`).all() as StoredLine[];
  } catch (error) {
    throw toValueFreeDbError('read retail taxonomy subjects', error);
  }
  const products = new Map<string, RetailTaxonomyProductSubject & { pairs: Map<string, RetailTaxonomyTitlePair>; seen: Set<string> }>();
  const departments = new Map<string, RetailTaxonomyDepartmentSubject>();
  for (const line of stored) {
    const ref = `${line.versionRef}/${line.lineRef}`;
    if (line.itemNumber !== null) {
      const key = retailProductKey(line.merchant, line.itemNumber);
      let product = products.get(key);
      if (product === undefined) {
        product = { key, merchant: line.merchant, itemNumber: line.itemNumber, titles: [], channels: [], storedRefs: [], counted: [],
          pairs: new Map(), seen: new Set() };
        products.set(key, product);
      }
      product.storedRefs.push(ref);
      product.seen.add(line.channel);
      if (line.title !== null || line.title2 !== null) product.pairs.set(JSON.stringify([line.title, line.title2]), { title: line.title, title2: line.title2 });
    }
    if (line.department !== null) {
      const key = retailDepartmentKey(line.merchant, line.department);
      let entry = departments.get(key);
      if (entry === undefined) {
        entry = { key, merchant: line.merchant, department: line.department, storedRefs: [], counted: [] };
        departments.set(key, entry);
      }
      entry.storedRefs.push(ref);
    }
  }
  for (const line of lines) {
    if (line.itemNumber !== null) products.get(retailProductKey(line.merchant, line.itemNumber))!.counted.push(line);
    if (line.department !== null) departments.get(retailDepartmentKey(line.merchant, line.department))!.counted.push(line);
  }
  for (const product of products.values()) {
    product.titles = [...product.pairs.keys()].sort().slice(0, RETAIL_TAXONOMY_TITLES_MAX).map((pair) => product.pairs.get(pair)!);
    product.channels = [...product.seen].sort();
    product.storedRefs.sort();
  }
  for (const entry of departments.values()) entry.storedRefs.sort();
  return {
    lines,
    products: new Map([...products].map(([key, { pairs: _pairs, seen: _seen, ...product }]): [string, RetailTaxonomyProductSubject] => [key, product])),
    departments,
  };
}

/** A product's counted lines by department (`null`: lines without one), each with its department's subject key. */
export function retailTaxonomyByDepartment(product: RetailTaxonomyProductSubject):
  Array<{ department: number | null; key: string | null; lines: number }> {
  const groups = new Map<number | null, number>();
  for (const line of product.counted) groups.set(line.department, (groups.get(line.department) ?? 0) + 1);
  return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([department, lines]) => ({ department, key: department === null ? null : retailDepartmentKey(product.merchant, department), lines }));
}

/** A worklist with nothing in it: the answer when the retail tables are absent. */
export function emptyRetailTaxonomyWorklist(): RetailTaxonomyWorklist {
  return {
    format: RETAIL_TAXONOMY_WORKLIST_FORMAT, version: RETAIL_TAXONOMY_FILE_VERSION, taxonomyVersion: RETAIL_TAXONOMY_VERSION,
    taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST, thresholds: { minAgentBp: ITEM_TAXONOMY_MIN_AGENT_BP, suggestedBelowBp: ITEM_TAXONOMY_SUGGESTED_BELOW_BP },
    taxonomy: retailTaxonomyWorklistTree(), products: [], departments: [], coverage: { withProduct: 0, withoutProduct: 0, titleRule: 0 },
  };
}

/** The worklist's products and departments from the subjects and the resolver of the stored rows (§6.1). */
export function retailTaxonomyWorklistOfSubjects(subjects: RetailTaxonomySubjects, resolver: RetailTaxonomyResolver): RetailTaxonomyWorklist {
  const products = [...subjects.products.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((product): RetailTaxonomyWorklistProduct => ({
    subjectKey: product.key, merchant: product.merchant, itemNumber: product.itemNumber, titles: product.titles, channels: product.channels,
    lines: product.counted.length, titleRuleLines: product.counted.filter((line) => line.titleRule).length,
    // R alone (D-T1-3): never a department's mapping or a line's resolution.
    current: resolver.product(product.merchant, product.itemNumber).resolution,
    byDepartment: retailTaxonomyByDepartment(product).map(({ department, lines }) => ({
      department, lines, reviewed: department === null ? null : resolver.department(product.merchant, department).reviewed,
    })),
  }));
  const departments = [...subjects.departments.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((entry): RetailTaxonomyWorklistDepartment => ({
      subjectKey: entry.key, merchant: entry.merchant, department: entry.department, lines: entry.counted.length,
      products: new Set(entry.counted.filter((line) => line.itemNumber !== null).map((line) => line.itemNumber)).size,
      current: resolver.department(entry.merchant, entry.department).reviewed,
    }));
  return {
    ...emptyRetailTaxonomyWorklist(), products, departments,
    coverage: {
      withProduct: subjects.lines.filter((line) => line.itemNumber !== null).length,
      withoutProduct: subjects.lines.filter((line) => line.itemNumber === null).length,
      titleRule: subjects.lines.filter((line) => line.titleRule).length,
    },
  };
}

/** `taxonomy worklist`'s file (§6.1), from the tables as they are. Read-only; the tables present and checked. */
export function retailTaxonomyWorklist(db: Database.Database): RetailTaxonomyWorklist {
  return retailTaxonomyWorklistOfSubjects(readRetailTaxonomySubjects(db), retailTaxonomyResolver(retailTaxonomyIndex(readRetailTaxonomyRows(db))));
}
