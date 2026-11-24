import type Database from 'better-sqlite3';

import { toValueFreeDbError } from '../dbErrors.js';
import { RetailRefusal, checkRetailWriteContext, newRetailId, retailLetters, type RetailWriteContext } from './common.js';
import { appendRetailAudit, requireRetailSchema } from './schema.js';
import { retailTaxonomyMappingOf, type RetailTaxonomyMapping } from './taxonomyFiles.js';
import { RETAIL_TAXONOMY_STORED_VERSION } from './taxonomyFormats.js';
import { planRetailTaxonomyImport, type RetailTaxonomyPlan } from './taxonomyPlan.js';

/**
 * `taxonomy import` (Costco 3/7 plan v5 §7.4): one reviewed mapping into PR 2's `retail_taxonomy_imports` and
 * `retail_taxonomy_assignments`, with one audit row, and nothing else. Exact replay comes before any freshness check: the
 * same mapping file again (its SHA-256, which covers its `decisionId`) is `retail-already-imported`, never
 * `retail-plan-changed`; a fresh decision has its own `decisionId`, so it is never a replay (D-T1-1).
 *
 * Two reserved-value check points, one call site each (§8): the read-only preflight's, before any backup, and the
 * writer's, under the caller's write fence after its backup.
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** The import of a mapping SHA-256 already recorded, if any. */
function recorded(db: Database.Database, mappingSha256: string): { taxonomyImportId: string; seq: number } | null {
  return (db.prepare('SELECT taxonomy_import_id AS taxonomyImportId, seq FROM retail_taxonomy_imports WHERE mapping_sha256 = ?')
    .get(retailLetters(mappingSha256)) as { taxonomyImportId: string; seq: number } | undefined) ?? null;
}

export interface RetailTaxonomyPreflight {
  /** The import that already recorded this very mapping, if one did (§7.4 step 3). */
  alreadyImported: { taxonomyImportId: string; seq: number } | null;
  /** The plan as the tables are now (§7.4 step 4); null for a replay. */
  plan: RetailTaxonomyPlan | null;
}

/**
 * The import's read-only preflight (§7.4 steps 3 and 4), in one read transaction: the exact schema and the
 * reserved-value STOP, then the replay check, then the plan. The caller compares the plan's digest with its GO's.
 */
export function preflightRetailTaxonomyImport(db: Database.Database, mapping: RetailTaxonomyMapping, mappingSha256: string): RetailTaxonomyPreflight {
  const checked = retailTaxonomyMappingOf(mapping);
  if (typeof mappingSha256 !== 'string' || !HEX64.test(mappingSha256)) throw new RetailRefusal('retail-digest-invalid');
  try {
    return db.transaction((): RetailTaxonomyPreflight => {
      requireRetailSchema(db);
      const replay = recorded(db, mappingSha256);
      if (replay !== null) return { alreadyImported: replay, plan: null };
      return { alreadyImported: null, plan: planRetailTaxonomyImport(db, checked, mappingSha256) };
    })();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('plan retail taxonomy import', error);
  }
}

export interface RetailTaxonomyImportContext extends RetailWriteContext {
  /** The mapping file's SHA-256 (lowercase hex), as the GO pins it. */
  mappingSha256: string;
  /** The GO's `planDigest` (lowercase hex). */
  planDigest: string;
}

export interface RetailTaxonomyImportReceipt {
  code: 'retail-taxonomy-imported' | 'retail-already-imported';
  taxonomyImportId: string;
  seq: number;
  /** The plan the write found and checked; null for a replay met under the fence. */
  plan: RetailTaxonomyPlan | null;
}

/**
 * The write (§7.4 step 6), inside the caller's fence and after its backup: the exact schema and the reserved-value STOP
 * again, the replay check again, every subject still known and the plan recomputed (`retail-plan-changed` unless it is
 * the GO's), then one `retail_taxonomy_imports` row at the next sequence, its assignment rows (append-only; every entry,
 * whatever its action) and one `taxonomy-import` audit row. All or nothing.
 */
export function importRetailTaxonomy(db: Database.Database, mapping: RetailTaxonomyMapping, context: RetailTaxonomyImportContext):
  RetailTaxonomyImportReceipt {
  const authority = checkRetailWriteContext(context, 'taxonomy-import');
  const checked = retailTaxonomyMappingOf(mapping);
  if (typeof context.mappingSha256 !== 'string' || !HEX64.test(context.mappingSha256) || typeof context.planDigest !== 'string'
    || !HEX64.test(context.planDigest)) throw new RetailRefusal('retail-digest-invalid');
  try {
    return db.transaction((): RetailTaxonomyImportReceipt => {
      requireRetailSchema(db);
      const replay = recorded(db, context.mappingSha256);
      if (replay !== null) return { code: 'retail-already-imported', ...replay, plan: null };
      const plan = planRetailTaxonomyImport(db, checked, context.mappingSha256);
      if (plan.planDigest !== context.planDigest) throw new RetailRefusal('retail-plan-changed');
      const taxonomyImportId = newRetailId('rtl-tax-');
      const seq = db.prepare('SELECT coalesce(max(seq), 0) + 1 FROM retail_taxonomy_imports').pluck().get() as number;
      db.prepare(`INSERT INTO retail_taxonomy_imports (taxonomy_import_id, seq, mapping_sha256, taxonomy_version, go_id, purpose, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(taxonomyImportId, seq, retailLetters(context.mappingSha256), RETAIL_TAXONOMY_STORED_VERSION, authority.goId, authority.purpose, authority.at);
      const assign = db.prepare(`INSERT INTO retail_taxonomy_assignments (taxonomy_import_id, subject_kind, subject_key, source, node, confidence_bp)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const entry of checked.entries) assign.run(taxonomyImportId, entry.subjectKind, entry.subjectKey, entry.source, entry.node, entry.confidenceBp);
      appendRetailAudit(db, { kind: 'taxonomy-import', inputSha256: retailLetters(context.mappingSha256), planDigest: retailLetters(plan.planDigest),
        authority });
      return { code: 'retail-taxonomy-imported', taxonomyImportId, seq, plan };
    }).immediate();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('import retail taxonomy', error);
  }
}
