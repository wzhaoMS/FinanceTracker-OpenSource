import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest, exact, refuse } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import { readPrivateJson, writePrivateJson } from '../services/amazon/privateFiles.js';
import { AMAZON_TAXONOMY_NEEDS_REVIEW, amazonTaxonomyNode } from '@finance-tracker/shared';
import {
  AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_SCHEMA_DIGEST, TAXONOMY_ADOPTION_STALE, applyTaxonomyMapping, installAmazonTaxonomySchema,
  planTaxonomyImport, resolveTaxonomy, taxonomyAdoptionStale, taxonomyWorklist, validateTaxonomyMapping,
} from '../services/amazon/taxonomy.js';
import { adoptTaxonomyAssignments } from '../services/amazon/taxonomyAdapter.js';
import { taxonomyAdoptionMapping } from '../services/amazon/taxonomyKeyAdoptions.js';
// STEP 9 integration B7a (#168 + #174 x #171): #168's learned-key list joins the taxonomy-native detection.
import { categoryKeyAdoptions } from '../services/amazon/ownerDecisions.js';
// Keyless holds (Root, after STEP 9): their counts, and the owner's GO'd line decisions.
import {
  AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST, installAmazonLineTaxonomySchema, taxonomyKeylessCounts,
} from '../services/amazon/lineTaxonomy.js';
import {
  TAXONOMY_LINE_DECISION_STALE, applyTaxonomyLineDecisions, isTaxonomyLineDecisionMapping, planTaxonomyLineDecisions,
  taxonomyKeylessHolds, taxonomyLineDecisionStale, validateTaxonomyLineDecisions,
} from '../services/amazon/taxonomyLineDecisions.js';

export const AMAZON_TAXONOMY_CLI_USAGE = `Amazon item taxonomy operator CLI (existing finance.db only; no network)
  worklist --db DB --output NEW_PRIVATE_WORKLIST
  adopt --input PRIVATE_ASSIGNMENTS --output NEW_PRIVATE_MAPPING
  adopt-keys --db DB --output NEW_PRIVATE_MAPPING
  plan --db DB --input PRIVATE_MAPPING
  import --db DB --input PRIVATE_MAPPING --backup NEW_FILE --root-go ARTIFACT
Every command prints counts and digests only, never titles, ASINs or keys; private files live outside the repository.
worklist opens the database read-only and writes every classifiable product (key, ASIN, title, current assignment,
and the assignment it would adopt from a previous key) and the taxonomy to a new private file, for the classifier.
It also lists each keyless hold there (keylessHolds): a displayed line a retained re-read holds with no learned key,
because its matched line is not unique (ambiguous-match) or has a title the card-data guard holds (card-data-guard),
by its stable line identity, never with a guarded title. worklist and plan print their counts by family and reason.
adopt turns the classifier's private assignments file (holdr.amazon-taxonomy-assignments) into an import mapping,
opening no database. adopt-keys opens the database read-only and writes an adoption mapping (kind "adoption"): each
product key a re-read gave a line (a learned ASIN), its previous key, and the previous key's assignment, adopted
unchanged; with none to adopt it writes nothing. An adoption mapping plans and imports only while every new key still
has no assignment and every previous key's is still the adopted one, checked again inside the import's write;
otherwise it is refused whole (adoption-stale, counts only) and must be regenerated.
A line decision mapping (kind "line-decision") is the owner's node for each keyless hold, by line identity, pinned to
the hold as the worklist lists it, its product included. It plans and imports only while every line is still held
exactly so, as the same product, and has no decision yet, and only once, checked again inside the import's write;
otherwise it is refused whole (line-decision-stale, counts only).
Its GO pins the line decision table's schema. A decided line shows the owner's node and no longer holds its order.
plan checks a mapping against the database read-only: an unknown node or product refuses the whole file. import
requires a Root GO pinned to this database, the mapping's digest, the taxonomy and the assignment table's schema;
after a new pre-write backup it installs the table if needed and stores the mapping in one transaction. Re-importing
the same mapping changes nothing. The owner's assignment always wins over an agent's. Nothing here changes card
Spending.
`;
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'databaseRef', 'mappingDigest',
  'taxonomyDigest', 'schemaDigest'];
const GO_PURPOSES: readonly string[] = ['copy-rehearsal', 'production-import'];
/** A string that is exactly one of `values`: nothing is coerced, so an array or object holding one never passes. */
const oneOf = (values: readonly string[], value: unknown): value is string => typeof value === 'string' && values.includes(value);
function readJson(file: string): unknown {
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 64 * 1024) return refuse();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return refuse(); }
}
function options(args: string[], expected: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!expected.includes(args[i]) || result.has(args[i]) || !value || !path.isAbsolute(value)) return refuse();
    result.set(args[i], value);
  }
  if (result.size !== expected.length) return refuse();
  return result;
}
/**
 * The GO's fixed fields, checked before the database is opened or a backup taken. Every field is compared strictly, by
 * type and value: a value that only reads as the right one once coerced (`["copy-rehearsal"]`, `"1"`) refuses.
 * `schemaDigest` pins the one table the import may install: the assignment table's, or the line decision table's.
 */
function authorize(input: unknown, database: string, mapping: unknown, schemaDigest: string): void {
  const go = exact(input, GO_KEYS);
  if (go.format !== 'holdr.amazon-taxonomy-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || !oneOf(GO_PURPOSES, go.purpose) || go.command !== 'import'
    || typeof go.databaseRef !== 'string' || go.databaseRef !== digest(path.resolve(database))
    || typeof go.mappingDigest !== 'string' || go.mappingDigest !== digest(mapping)
    || go.taxonomyDigest !== AMAZON_TAXONOMY_DIGEST || go.schemaDigest !== schemaDigest) return refuse();
}
async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    if (!readonly) handle.db.pragma('foreign_keys=ON');
    return await fn(handle.db);
  } finally { handle.close(); }
}
export async function runAmazonTaxonomyCli(args: string[], context: { env: NodeJS.ProcessEnv; io: Io; now?: () => Date }): Promise<number> {
  const { io } = context;
  const now = () => (context.now ?? (() => new Date()))().toISOString();
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(AMAZON_TAXONOMY_CLI_USAGE); return 0; }
    if (command === 'worklist') {
      const opts = options(rest, ['--db', '--output']);
      const database = opts.get('--db')!, output = opts.get('--output')!;
      // STEP 9 integration (B7a)
      // Keyless holds (Root, after STEP 9): listed in the same private file, read in the same transaction.
      const worklist = await withDatabase(context.env, database, true, db => db.transaction(() => ({
        ...taxonomyWorklist(db, { keyChanges: categoryKeyAdoptions(db) }), keylessHolds: taxonomyKeylessHolds(db) }))());
      writePrivateJson(output, worklist);
      const assigned = worklist.products.filter(p => p.resolved !== 'needs-review').length;
      io.stdout.write(JSON.stringify({ code: 'taxonomy-worklist-written', products: worklist.products.length,
        assigned, needsReview: worklist.products.length - assigned, adoptions: worklist.products.filter(p => p.adoptFrom !== null).length,
        keylessHolds: taxonomyKeylessCounts(worklist.keylessHolds), coverage: worklist.coverage, taxonomyDigest: AMAZON_TAXONOMY_DIGEST }) + '\n');
      return 0;
    }
    if (command === 'adopt-keys') {
      const opts = options(rest, ['--db', '--output']);
      const database = opts.get('--db')!, output = opts.get('--output')!;
      if (fs.lstatSync(output, { throwIfNoEntry: false })) return refuse();
      // STEP 9 integration (B7a)
      const mapping = await withDatabase(context.env, database, true, db => taxonomyAdoptionMapping(db, categoryKeyAdoptions(db)));
      if (mapping === null) {
        io.stdout.write(JSON.stringify({ code: 'taxonomy-key-adoptions-none', entries: 0 }) + '\n');
        return 0;
      }
      writePrivateJson(output, mapping);
      io.stdout.write(JSON.stringify({ code: 'taxonomy-key-adoptions-written-not-imported', entries: mapping.entries.length,
        agent: mapping.entries.filter(e => e.source === 'agent').length, owner: mapping.entries.filter(e => e.source === 'owner').length,
        mappingDigest: digest(mapping) }) + '\n');
      return 0;
    }
    if (command === 'adopt') {
      const opts = options(rest, ['--input', '--output']);
      const mapping = adoptTaxonomyAssignments(readPrivateJson(opts.get('--input')!));
      writePrivateJson(opts.get('--output')!, mapping);
      // Each entry classified exactly as reads will resolve it (resolveTaxonomy): Needs review, whoever put it there, is
      // neither assigned nor suggested.
      const resolved = mapping.entries.map(e => resolveTaxonomy({ node: e.node, source: e.source, confidence: e.confidence }));
      const assigned = resolved.filter(r => r.node !== AMAZON_TAXONOMY_NEEDS_REVIEW);
      io.stdout.write(JSON.stringify({ code: 'taxonomy-mapping-written-not-imported', entries: mapping.entries.length,
        assigned: assigned.length, suggested: assigned.filter(r => r.suggested).length,
        needsReview: mapping.entries.length - assigned.length,
        topLevel: assigned.filter(r => amazonTaxonomyNode(r.node)!.parent === null).length,
        mappingDigest: digest(mapping) }) + '\n');
      return 0;
    }
    if (command === 'plan') {
      const opts = options(rest, ['--db', '--input']);
      const database = opts.get('--db')!, mapping = readPrivateJson(opts.get('--input')!);
      // Keyless holds (Root, after STEP 9): an owner's line decision mapping plans by its own, read-only check.
      if (isTaxonomyLineDecisionMapping(mapping)) {
        validateTaxonomyLineDecisions(mapping);
        const plan = await withDatabase(context.env, database, true, db => planTaxonomyLineDecisions(db, mapping));
        io.stdout.write(JSON.stringify({ code: 'taxonomy-planned', ...plan, taxonomyDigest: AMAZON_TAXONOMY_DIGEST,
          schemaDigest: AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) }) + '\n');
        return 0;
      }
      validateTaxonomyMapping(mapping);
      const plan = await withDatabase(context.env, database, true, db => db.transaction(() => ({ ...planTaxonomyImport(db, mapping),
        keylessHolds: taxonomyKeylessCounts(taxonomyKeylessHolds(db)) }))());
      io.stdout.write(JSON.stringify({ code: 'taxonomy-planned', ...plan, taxonomyDigest: AMAZON_TAXONOMY_DIGEST,
        schemaDigest: AMAZON_TAXONOMY_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) }) + '\n');
      return 0;
    }
    if (command !== 'import') return refuse();
    const opts = options(rest, ['--db', '--input', '--backup', '--root-go']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!, mapping = readPrivateJson(opts.get('--input')!);
    const lines = isTaxonomyLineDecisionMapping(mapping);
    if (lines) validateTaxonomyLineDecisions(mapping);
    else validateTaxonomyMapping(mapping);
    authorize(readJson(opts.get('--root-go')!), database, mapping, lines ? AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST : AMAZON_TAXONOMY_SCHEMA_DIGEST);
    if (fs.lstatSync(backup, { throwIfNoEntry: false })
      || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) return refuse();
    if (lines) {
      // A stale line decision mapping refuses before the backup, read-only; the write checks it again.
      await withDatabase(context.env, database, true, db => planTaxonomyLineDecisions(db, mapping));
      const counts = await withDatabase(context.env, database, false, db => backedUpWrite(db, backup,
        () => applyTaxonomyLineDecisions(db, mapping, now()), installAmazonLineTaxonomySchema));
      io.stdout.write(JSON.stringify({ code: 'taxonomy-lines-decided', ...counts, mappingDigest: digest(mapping),
        taxonomyDigest: AMAZON_TAXONOMY_DIGEST }) + '\n');
      return 0;
    }
    // A mapping naming a product no imported item is refuses before the backup, read-only.
    await withDatabase(context.env, database, true, db => planTaxonomyImport(db, mapping));
    const counts = await withDatabase(context.env, database, false, db => backedUpWrite(db, backup,
      () => applyTaxonomyMapping(db, mapping, now()), installAmazonTaxonomySchema));
    io.stdout.write(JSON.stringify({ code: 'taxonomy-imported', ...counts, mappingDigest: digest(mapping),
      taxonomyDigest: AMAZON_TAXONOMY_DIGEST }) + '\n');
    return 0;
  } catch (error) {
    // A stale adoption mapping is refused whole, before any write: its reason and counts only.
    const stale = taxonomyAdoptionStale(error);
    if (stale) {
      io.stderr.write(`amazon-taxonomy: ${TAXONOMY_ADOPTION_STALE} ${JSON.stringify(stale)}\n`);
      return 1;
    }
    // So is a stale line decision mapping (keyless holds, Root, after STEP 9).
    const lineStale = taxonomyLineDecisionStale(error);
    if (lineStale) {
      io.stderr.write(`amazon-taxonomy: ${TAXONOMY_LINE_DECISION_STALE} ${JSON.stringify(lineStale)}\n`);
      return 1;
    }
    io.stderr.write(`amazon-taxonomy: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
