import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { ITEM_TAXONOMY_V2_DIGEST } from '@finance-tracker/shared';
import { serializeRetailImportPayload, type RetailImportPayload } from '@finance-tracker/shared/retail-import-payload';

import { configuredControlDir } from '../control/controlDir.js';
import { digest } from '../services/amazon/policy.js';
import { HoldrRefusal, errorTypeAndCode, toValueFreeDbError } from '../services/dbErrors.js';
import {
  RETAIL_DECLARATION_KEYS,
  RETAIL_POLICY_DIGEST,
  RETAIL_PURPOSES,
  RETAIL_REVIEW_DECISION_KEYS,
  RETAIL_REVIEW_KEYS,
  RETAIL_SCHEMA_DIGEST,
  RETAIL_TAXONOMY_FILE_MAX_BYTES,
  RetailRefusal,
  adoptRetailTaxonomyAssignments,
  assertNoReservedValues,
  emptyRetailTaxonomyWorklist,
  importRetailPayload,
  importRetailTaxonomy,
  installRetailSchema,
  planRetailImport,
  planRetailReview,
  planRetailTaxonomyImport,
  preflightRetailTaxonomyImport,
  proposeRetailBindings,
  requireRetailSchema,
  retailDeclarationOf,
  retailMembershipChoice,
  retailQuarantine,
  retailReviewOf,
  retailSchemaForRead,
  retailSchemaObjects,
  retailSchemaState,
  retailStorageProblems,
  retailTaxonomyAssignmentsOf,
  retailTaxonomyMappingOf,
  retailTaxonomyWorklist,
  retailTaxonomyWorklistOf,
  reviewRetailReceipts,
  serializeRetailBindingProposal,
  serializeRetailTaxonomyMapping,
  serializeRetailTaxonomyWorklist,
  validRetailPayload,
  type RetailAuthority,
  type RetailDeclarationInput,
  type RetailImportPlan,
  type RetailImportRequest,
  type RetailRefusalCode,
  type RetailReviewFile,
  type RetailTaxonomyMapping,
  type RetailTaxonomyPlan,
  type RetailWriteCommand,
} from '../services/retail/index.js';
import type { Io } from './controlCommon.js';
import {
  exactKeys,
  mapOutputRefusals,
  newOutputPath,
  ownerOnlyOutputDirectory,
  parseJson,
  parseOptions,
  readInputFile,
  withSharedRead,
  withWriterDatabase,
  type OperatorRefusals,
  type OptionCheck,
} from './operatorIo.js';
import { assertOwnerOnlyFile, isWindowsAliasName, platformOutputAccess, writeOwnerOnlyNewFile, type OutputAccess } from './ownerOnlyOutput.js';
import { formatRetailReport, retailReport } from './retailReport.js';

export const RETAIL_CLI_USAGE = `Retail operator CLI (Costco receipts; dormant: nothing at boot, no route and no Spending answer reads these tables)
  plan --db DB [--payload FILE] [--declaration FILE]
  declare-membership --declaration FILE
  preview --db DB --clone NEW_FILE --payload FILE [--declaration FILE]
  install --db DB --go GO --backup NEW_FILE
  import --db DB --payload FILE [--declaration FILE] --go GO --backup NEW_FILE
  quarantine --db DB
  review-receipt --db DB --review FILE --go GO --backup NEW_FILE
  bindings propose --db DB --out NEW_FILE
  report --db DB
  taxonomy worklist --db DB --out NEW_FILE
  taxonomy adopt --input FILE --worklist FILE --out NEW_FILE
  taxonomy plan --db DB --mapping FILE
  taxonomy import --db DB --mapping FILE --go GO --backup NEW_FILE
plan, quarantine, report and bindings propose read under the writer's shared lease (HOLDR_CONTROL_DIR), or on a
disposable stack (HOLDR_CONFIG=none), else retail-no-shared-lease, each in one read transaction; they write nothing but
a proposal's new owner-only file. plan prints whether the retail tables are present, absent or in conflict (exit 1),
with the schema and policy digests and the database reference a GO names; with --payload, the payload's inputSha256
and what an import would do.
declare-membership checks a membership declaration (holdr.retail-membership-declaration v1) and prints its SHA-256.
preview copies the database with SQLite's backup API into a new owner-only clone in an owner-only directory and
installs and imports there only, under no GO; it never writes the database it reads, and a failure removes only what it
created.
install, import and review-receipt need a Root GO (holdr.retail-go v1) pinned to this database, schema and policy, and
to the payload and membership (import) or the review file and its receipts (review-receipt). Every input and the GO are
checked before the database is opened, the backup's directory owner-only; the same install, payload or review again
writes nothing; otherwise one IMMEDIATE transaction, taken first, holds the write lock through a new pre-write backup
(its new file checked owner-only before a byte is copied) and a write that plans again and writes only if nothing
changed (retail-plan-changed), until it commits or rolls back. Nothing restores a backup by itself: to roll back, stop
the API and restore that step's backup.
Any stored value reserved for a later rule stops every command (retail-reserved-value): change nothing, report to Root.
All paths are absolute; a backup, clone or proposal file must be new. No folder or file name on its path, as given or
with its folder's links resolved, may end in a dot or a space, hold a colon (the drive's aside) or name a Windows
device, nor may the path start \\\\?\\, \\\\.\\ or \\??\\ (the one shared rule); and its name may not end in -wal, -shm
or -journal (retail-output-name-refused). Output is codes, refs, digests, counts and dates.
taxonomy (the item taxonomy, Costco 3/7; dormant: nothing reads its rows yet) files each product (merchant, item
number) and, by review, each department under a node of the shared tree's v2 view. worklist reads like plan and writes
a new owner-only worklist (holdr.retail-taxonomy-worklist v1): every product and department the stored lines name, with
their counted lines and current resolution; it prints counts and the file's SHA-256. adopt opens no database: it turns
a classifier's output (holdr.retail-taxonomy-assignments v1, bound to the worklist's SHA-256) into a new owner-only
mapping (holdr.retail-taxonomy-mapping v1) of agent rows only, under a fresh decisionId. plan reads like plan and prints
what a mapping would do: its actions, the counters as if imported, the node categories the card data lacks, and the
planDigest a GO pins. import needs a Root GO for taxonomy-import pinned to the mapping's SHA-256, its decisionId, the
taxonomy digest and the planDigest. The same mapping again writes nothing (retail-already-imported); otherwise it
plans again, takes the fence and a backup as the writers above do, plans again under the fence, and writes one
taxonomy import, its rows and one audit row, or refuses retail-plan-changed.
`;

const GO_MAX_BYTES = 64 * 1024;
const PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DECLARATION_MAX_BYTES = 64 * 1024;
const REVIEW_MAX_BYTES = 16 * 1024 * 1024;
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest', 'policyDigest'] as const;
const GO_EXTRA: Readonly<Record<RetailWriteCommand, readonly string[]>> = {
  install: [],
  import: ['inputSha256', 'membership'],
  'review-receipt': ['reviewSha256', 'receiptRefs'],
  'taxonomy-import': ['mappingSha256', 'decisionId', 'taxonomyDigest', 'planDigest'],
};
const GO_ID = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256Hex = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
/** A path, and the names SQLite keeps beside it. */
const withSidecars = (file: string): string[] => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];
/** A path as the file system compares it: case blind on Windows and macOS, as their default volumes are. */
const comparable = (file: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file);
/** A name ending as one SQLite keeps beside a database does, case blind. */
const SQLITE_SIDECAR_NAME = /-(?:wal|shm|journal)$/i;

/**
 * An output's path, refused before anything is created (`retail-output-name-refused`), on every platform:
 * - a path Windows reads as another file or a device, by any folder or file name on it (`isWindowsAliasName`, ROOT's
 *   one shared rule; D-PR2-C7). This program creates a name as given, while SQLite resolves it the Win32 way: a backup
 *   or clone so named, or so placed, could land in the source, an existing file or a device;
 * - a name SQLite keeps beside a database (ROOT's C4 ruling): while one run's SQLite has let such a name go, a file
 *   another run put there would become that run's journal.
 * Called with an output's path as its directory's links resolve, so a link with a safe-looking name can't lead to a
 * folder Windows reads as another; the path as given is held to the shared rule first (operatorIo's newOutputPath, or
 * preview's own check).
 */
function checkOutputName(file: string): void {
  if (isWindowsAliasName(file) || SQLITE_SIDECAR_NAME.test(path.basename(file))) throw new RetailRefusal('retail-output-name-refused');
}

/**
 * Every name SQLite may use for the database `file` and its sidecars, with each directory's links resolved: beside the
 * path as given (where SQLite keeps them on Windows) and beside the file it resolves to (where it keeps them elsewhere),
 * as compared (D-PR2-C5). A database that can't be resolved is refused.
 */
function sqliteFamily(file: string): string[] {
  try {
    const given = path.join(fs.realpathSync.native(path.dirname(path.resolve(file))), path.basename(file));
    return [...withSidecars(given), ...withSidecars(fs.realpathSync.native(file))].map(comparable);
  } catch {
    throw new HoldrRefusal('retail input refused');
  }
}

/** The refusals of the shared operator primitives for one input: its own code, or the generic value-free input refusal. */
const refusalsFor = (code: RetailRefusalCode | null): OperatorRefusals => ({
  input: () => (code === null ? new HoldrRefusal('retail input refused') : new RetailRefusal(code)),
  output: (outputCode) => new RetailRefusal(`retail-${outputCode}`),
});
const GO_REFUSALS = refusalsFor('retail-go-invalid');
const PAYLOAD_REFUSALS = refusalsFor('retail-payload-invalid');
const DECLARATION_REFUSALS = refusalsFor('retail-declaration-invalid');
const REVIEW_REFUSALS = refusalsFor('retail-review-invalid');
const TAXONOMY_REFUSALS = refusalsFor('retail-taxonomy-file-invalid');
const OUTPUT_REFUSALS = refusalsFor(null);

interface Go extends Record<string, unknown> {
  purpose: string;
  goId: string;
}

/**
 * The GO (plan §8.4), before the database is opened: at most 64 KiB, exactly its keys and its command's, each compared by
 * type and value (`"1"` is not `1`). A pinned input that differs is `retail-input-mismatch`.
 */
function authorize(file: string, command: RetailWriteCommand, database: string, pinned: Record<string, unknown>): Go {
  const go = exactKeys(parseJson(readInputFile(file, GO_MAX_BYTES, GO_REFUSALS), GO_REFUSALS), [...GO_KEYS, ...GO_EXTRA[command]], GO_REFUSALS);
  if (go.format !== 'holdr.retail-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO' || go.command !== command
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== RETAIL_SCHEMA_DIGEST || go.policyDigest !== RETAIL_POLICY_DIGEST) {
    throw new RetailRefusal('retail-go-invalid');
  }
  if (typeof go.goId !== 'string' || !GO_ID.test(go.goId)) throw new RetailRefusal('retail-go-id-invalid');
  if (typeof go.purpose !== 'string' || !(RETAIL_PURPOSES[command] as readonly string[]).includes(go.purpose)) {
    throw new RetailRefusal('retail-purpose-invalid');
  }
  for (const [key, value] of Object.entries(pinned)) {
    if (JSON.stringify(go[key]) !== JSON.stringify(value)) throw new RetailRefusal('retail-input-mismatch');
  }
  return go as Go;
}

/**
 * A payload file (§5.1): at most 64 MiB (`retail-payload-too-large`), JSON, byte for byte its canonical serialization
 * (`retail-payload-not-canonical`), valid (`retail-payload-invalid`) and storable (`retail-payload-unstorable`).
 */
function readPayload(file: string): { payload: RetailImportPayload; inputSha256: string } {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isFile() && stat.size > PAYLOAD_MAX_BYTES) throw new RetailRefusal('retail-payload-too-large');
  const bytes = readInputFile(file, PAYLOAD_MAX_BYTES, PAYLOAD_REFUSALS);
  const parsed = parseJson(bytes, PAYLOAD_REFUSALS);
  if (!Buffer.from(serializeRetailImportPayload(parsed as RetailImportPayload), 'utf8').equals(bytes)) {
    throw new RetailRefusal('retail-payload-not-canonical');
  }
  const payload = validRetailPayload(parsed);
  const problems = retailStorageProblems(payload);
  if (problems.length > 0) throw new RetailRefusal('retail-payload-unstorable', { paths: problems });
  return { payload, inputSha256: sha256Hex(bytes) };
}

/** A membership declaration file (§5.4): exactly its keys, its values of their shapes; its SHA-256 is what a GO names. */
function readDeclaration(file: string): RetailDeclarationInput {
  const bytes = readInputFile(file, DECLARATION_MAX_BYTES, DECLARATION_REFUSALS);
  const record = exactKeys(parseJson(bytes, DECLARATION_REFUSALS), RETAIL_DECLARATION_KEYS, DECLARATION_REFUSALS);
  return { declaration: retailDeclarationOf(record), sha256: sha256Hex(bytes) };
}

/** A review file (§6 step 1): its shape, read and validated before anything is looked up; its SHA-256 the GO names. */
function readReview(file: string): { review: RetailReviewFile; reviewSha256: string } {
  const bytes = readInputFile(file, REVIEW_MAX_BYTES, REVIEW_REFUSALS);
  const record = exactKeys(parseJson(bytes, REVIEW_REFUSALS), RETAIL_REVIEW_KEYS, REVIEW_REFUSALS);
  if (!Array.isArray(record.decisions)) throw new RetailRefusal('retail-review-invalid');
  const decisions = record.decisions.map((decision: unknown) => exactKeys(decision, RETAIL_REVIEW_DECISION_KEYS, REVIEW_REFUSALS));
  return { review: retailReviewOf({ format: record.format, version: record.version, decisions }), reviewSha256: sha256Hex(bytes) };
}

/** A taxonomy file's bytes and parsed JSON (Costco 3/7 plan v5 §6): at most 16 MiB, else `retail-taxonomy-file-invalid`. */
function readTaxonomyFile(file: string): { value: unknown; sha256: string } {
  const bytes = readInputFile(file, RETAIL_TAXONOMY_FILE_MAX_BYTES, TAXONOMY_REFUSALS);
  return { value: parseJson(bytes, TAXONOMY_REFUSALS), sha256: sha256Hex(bytes) };
}

/** A mapping file (§6.3, §7.4 step 1): its shape, kinds, sources and nodes, before anything else; its SHA-256 the GO names. */
function readMapping(file: string): { mapping: RetailTaxonomyMapping; mappingSha256: string } {
  const { value, sha256 } = readTaxonomyFile(file);
  return { mapping: retailTaxonomyMappingOf(value), mappingSha256: sha256 };
}

/** What `taxonomy plan` and a refused import show of a plan: counts and permitted digests only. */
const taxonomyPlanOutput = (plan: RetailTaxonomyPlan) => ({
  entries: plan.entries, actions: plan.actions, products: plan.counters.products, productSources: plan.counters.productSources,
  lines: plan.counters.lines, lineSources: plan.counters.lineSources, rowsNotCurrent: plan.counters.rowsNotCurrent,
  categoriesMissing: plan.categoriesMissing, mappingSha256: plan.mappingSha256, decisionId: plan.decisionId, taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST,
  schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST, planDigest: plan.planDigest,
});

/** A new output file's path: nothing there (`retail-output-exists`), in an existing directory (operatorIo.ts). */
function newPath(file: string): void {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new RetailRefusal('retail-output-exists');
  newOutputPath(file, OUTPUT_REFUSALS);
}

const importCounts = (plan: RetailImportPlan) => ({
  receipts: plan.receipts, outcomes: plan.outcomes, held: plan.held, possibleOverlap: plan.possibleOverlap, cardLast4sUnbound: plan.cardLast4sUnbound,
});

/**
 * Where a test may look at a command while it runs (production passes no probe): a read's snapshot, a write's fence, a
 * preview's clone, and a taxonomy import once its read-only checks have passed, before its fence (`preflighted`).
 */
export type RetailProbePoint = 'read-checked' | 'fenced' | 'backed-up' | 'written' | 'clone-checked' | 'clone-created' | 'clone-copied'
  | 'clone-imported' | 'preflighted';

/** `create`, refusing a name already in use (`retail-output-exists`) without opening or removing what is there. */
function exclusively<T>(create: () => T): T {
  try {
    return create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RetailRefusal('retail-output-exists');
    throw error;
  }
}

/** A file's identity: its device, inode (on NTFS its file ID) and birth time, so a file put in its place is told apart. */
const identityOf = (stat: fs.BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

/** Removes `name` only while it is still the file of `identity`: never a file put in its place. */
function removeIfStill(name: string, identity: string): void {
  const now = fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
  if (now?.isFile() && identityOf(now) === identity) fs.rmSync(name, { force: true });
}

/**
 * Reserves `name` (D-PR2-C4): creates it exclusively and empty (a name in use is `retail-output-exists`, and what is there
 * is never opened or removed), takes its identity from the creating descriptor, and checks it owner-only before it is
 * closed (D-PR2-C2). A file that fails its check is removed, only while it is still the file created. Returns its identity.
 */
function reserveNewFile(name: string, access: OutputAccess): string {
  // The shared name rule at the creating call itself, as at writeOwnerOnlyNewFile's (D-PR2-C7).
  if (isWindowsAliasName(name)) throw new RetailRefusal('retail-output-name-refused');
  const fd = exclusively(() => fs.openSync(name, 'wx', 0o600));
  let identity: string | null = null;
  let reserved = false;
  try {
    identity = identityOf(fs.fstatSync(fd, { bigint: true }));
    mapOutputRefusals(() => assertOwnerOnlyFile(name, fd, access), OUTPUT_REFUSALS);
    reserved = true;
    return identity;
  } finally {
    fs.closeSync(fd);
    if (!reserved && identity !== null) removeIfStill(name, identity);
  }
}

/**
 * The fenced write (plan §2 rule 3, with ROOT's delta of 11/09, D-PR2-C3: #299's G2 fence). `BEGIN IMMEDIATE` on the
 * writer's handle comes first, so no other connection, the API's included, commits a write until this one commits or
 * rolls back. Inside it: the backup's real directory again, then its new empty file, each checked owner-only (D-PR2-C2)
 * before a byte of the database is copied; the backup, through a second, read-only connection, so it is exactly the
 * state the write starts from; then `prepare` and `write` in the same transaction, and COMMIT. A failure anywhere inside
 * rolls back and needs no restore. A refusal keeps its code; any other failure is value-free. The backup, once taken, is
 * kept, and nothing restores it.
 */
async function fencedRetailWrite<T>(db: Database.Database, backup: string, write: () => T, prepare: (db: Database.Database) => void,
  access: OutputAccess, probe?: (point: RetailProbePoint) => void): Promise<T> {
  if (db.inTransaction || !path.isAbsolute(backup)) throw new HoldrRefusal('retail input refused');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      probe?.('fenced');
      // The backup's real place again: by its resolved name never one of the database's own SQLite files (D-PR2-C5),
      // nor a path Windows or SQLite reads as another (D-PR2-C7), checked before anything is created.
      const backupFile = path.join(ownerOnlyOutputDirectory(backup, access, OUTPUT_REFUSALS), path.basename(backup));
      if (sqliteFamily(db.name).includes(comparable(backupFile))) throw new HoldrRefusal('retail input refused');
      checkOutputName(backupFile);
      mapOutputRefusals(() => writeOwnerOnlyNewFile(backupFile, '', access), OUTPUT_REFUSALS);
      const reader = new Database(db.name, { readonly: true, fileMustExist: true });
      try {
        await reader.backup(backupFile);
      } finally {
        reader.close();
      }
      fs.chmodSync(backupFile, 0o600);
      probe?.('backed-up');
      prepare(db);
      const result = write();
      probe?.('written');
      db.exec('COMMIT');
      return result;
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
    }
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('retail fenced write', error);
  }
}

export async function runRetailCli(args: string[], context: { env: NodeJS.ProcessEnv; io: Io; now?: () => Date; outputAccess?: OutputAccess;
  probe?: (point: RetailProbePoint) => void; }): Promise<number> {
  const { io, env } = context;
  const access = context.outputAccess ?? platformOutputAccess;
  const print = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  const now = () => (context.now ?? (() => new Date()))().toISOString();
  /**
   * A backup's place, before the database is opened: a new path, held as given to the shared name rule (operatorIo's
   * newOutputPath), in a real directory only its owner can open (D-PR2-C2) whose resolved path the rule holds too; by its
   * resolved name none of the database's own SQLite files (D-PR2-C5); and, resolved, a path no other program reads as
   * another, nor a name SQLite keeps beside a database (D-PR2-C7, ROOT's C4 ruling).
   */
  const backupPlace = (file: string, database: string): void => {
    newPath(file);
    const dir = ownerOnlyOutputDirectory(file, access, OUTPUT_REFUSALS);
    if (sqliteFamily(database).includes(comparable(path.join(dir, path.basename(file))))) throw new HoldrRefusal('retail input refused');
    checkOutputName(path.join(dir, path.basename(file)));
  };
  /**
   * A read-only command's one read transaction (plan §8.3, D-PR2-C1), on the query_only handle: its schema check and the
   * reserved-value STOP are the snapshot's first reads, and its whole answer reads that same state, whatever another
   * connection commits meanwhile.
   */
  const readSnapshot = <S, T>(db: Database.Database, check: () => S, answer: (checked: S) => T): T => db.transaction(() => {
    const checked = check();
    context.probe?.('read-checked');
    return answer(checked);
  })();
  // A path option that isn't absolute is `retail-path-not-absolute`; any other option problem is the generic refusal.
  let relativePath = false;
  const absolute: OptionCheck = (value) => {
    if (path.isAbsolute(value)) return true;
    relativePath = true;
    return false;
  };
  const optionRefusals: OperatorRefusals = {
    input: () => (relativePath ? new RetailRefusal('retail-path-not-absolute') : new HoldrRefusal('retail input refused')),
    output: OUTPUT_REFUSALS.output,
  };
  const options = (rest: readonly string[], required: readonly string[], optional: readonly string[] = []) => parseOptions(rest,
    Object.fromEntries(required.map((name) => [name, absolute])), Object.fromEntries(optional.map((name) => [name, absolute])), optionRefusals);
  const noLease = () => {
    print({ code: 'retail-no-shared-lease' });
    return 1;
  };
  const goAuthority = (go: Go): RetailAuthority => ({ kind: 'go', goId: go.goId, purpose: go.purpose });
  try {
    const [command, ...rest] = args;
    if (command === '--help') {
      io.stdout.write(RETAIL_CLI_USAGE);
      return 0;
    }
    if (command === 'plan') {
      const opts = options(rest, ['--db'], ['--payload', '--declaration']);
      const database = opts.get('--db')!;
      const input = opts.has('--payload') ? readPayload(opts.get('--payload')!) : null;
      const declaration = opts.has('--declaration') ? readDeclaration(opts.get('--declaration')!) : null;
      const result = await withSharedRead(env, database, (db) => readSnapshot(db, () => {
        const schema = retailSchemaState(db);
        if (schema === 'present') assertNoReservedValues(db);
        return schema;
      }, (schema) => {
        const out: Record<string, unknown> = {
          code: schema === 'conflict' ? 'retail-conflict' : 'retail-planned', schema, schemaDigest: RETAIL_SCHEMA_DIGEST,
          policyDigest: RETAIL_POLICY_DIGEST, databaseRef: digest(path.resolve(database)), objects: retailSchemaObjects(db),
        };
        if (input !== null) {
          out.input = { inputSha256: input.inputSha256 };
          if (schema !== 'present') out.import = { code: schema === 'absent' ? 'retail-not-installed' : 'retail-conflict' };
          else {
            try {
              const plan = planRetailImport(db, { payload: input.payload, declaration, membership: null });
              out.import = { alreadyImported: plan.alreadyImported, importId: plan.importId, membership: plan.membership, ...importCounts(plan),
                planDigest: plan.planDigest };
            } catch (error) {
              if (!(error instanceof RetailRefusal) || error.code === 'retail-reserved-value') throw error;
              out.import = { code: error.code, ...error.details };
            }
          }
        }
        return out;
      }));
      if (result === null) return noLease();
      print(result.value);
      return result.value.code === 'retail-conflict' ? 1 : 0;
    }
    if (command === 'declare-membership') {
      const opts = options(rest, ['--declaration']);
      const { declaration, sha256 } = readDeclaration(opts.get('--declaration')!);
      print({ code: 'retail-declaration-valid', declarationSha256: sha256, folder: declaration.folder, owner: declaration.owner });
      return 0;
    }
    if (command === 'preview') {
      const opts = options(rest, ['--db', '--clone', '--payload'], ['--declaration']);
      return await preview(opts.get('--db')!, opts.get('--clone')!, readPayload(opts.get('--payload')!),
        opts.has('--declaration') ? readDeclaration(opts.get('--declaration')!) : null);
    }
    if (command === 'install') {
      const opts = options(rest, ['--db', '--go', '--backup']);
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const go = authorize(opts.get('--go')!, 'install', database, {});
      backupPlace(backup, database);
      const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: RETAIL_SCHEMA_DIGEST };
      // Read-only first: tables already there take no backup and write nothing, after the reserved-value STOP.
      const state = await withWriterDatabase(env, database, true, (db) => retailSchemaForRead(db));
      if (state === 'present') {
        print({ code: 'retail-already-installed', ...receipt });
        return 0;
      }
      const at = now();
      const installed = await withWriterDatabase(env, database, false, (db) => fencedRetailWrite(db, backup,
        () => installRetailSchema(db, { now: at, authority: goAuthority(go) }),
        (opened) => {
          if (retailSchemaState(opened) !== 'absent') throw new RetailRefusal('retail-plan-changed');
        }, access, context.probe));
      print({ code: 'retail-installed', ...receipt, objects: installed.objects });
      return 0;
    }
    if (command === 'import') {
      const opts = options(rest, ['--db', '--payload', '--go', '--backup'], ['--declaration']);
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const input = readPayload(opts.get('--payload')!);
      const declaration = opts.has('--declaration') ? readDeclaration(opts.get('--declaration')!) : null;
      const go = authorize(opts.get('--go')!, 'import', database, { inputSha256: input.inputSha256 });
      const request: RetailImportRequest = { payload: input.payload, declaration, membership: retailMembershipChoice(go.membership) };
      backupPlace(backup, database);
      // Read-only preflight: refusals and the same payload again end here, before any backup.
      const plan = await withWriterDatabase(env, database, true, (db) => planRetailImport(db, request));
      if (plan.alreadyImported) {
        print({ code: 'retail-already-imported', goId: go.goId, inputSha256: input.inputSha256, importId: plan.importId });
        return 0;
      }
      // The write's instant is taken once the preflight has passed; the write plans again inside its fence.
      const at = now();
      const receipt = await withWriterDatabase(env, database, false, (db) => fencedRetailWrite(db, backup, () => importRetailPayload(db,
        request, { now: at, authority: goAuthority(go), inputSha256: input.inputSha256, planDigest: plan.planDigest }),
      requireRetailSchema, access, context.probe));
      print({ code: receipt.code, purpose: go.purpose, goId: go.goId, inputSha256: receipt.inputSha256, importId: receipt.importId,
        importSeq: receipt.importSeq, membership: receipt.membership, ...importCounts(receipt), planDigest: receipt.planDigest });
      return 0;
    }
    if (command === 'quarantine') {
      const database = options(rest, ['--db']).get('--db')!;
      const result = await withSharedRead(env, database, (db) => readSnapshot(db, () => retailSchemaForRead(db), () => retailQuarantine(db)));
      if (result === null) return noLease();
      print(result.value);
      return 0;
    }
    if (command === 'review-receipt') {
      const opts = options(rest, ['--db', '--review', '--go', '--backup']);
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const { review, reviewSha256 } = readReview(opts.get('--review')!);
      const go = authorize(opts.get('--go')!, 'review-receipt', database,
        { reviewSha256, receiptRefs: review.decisions.map((decision) => decision.receiptRef) });
      backupPlace(backup, database);
      const plan = await withWriterDatabase(env, database, true, (db) => planRetailReview(db, review, reviewSha256));
      if (plan.alreadyReviewed) {
        print({ code: 'retail-already-reviewed', goId: go.goId, reviewSha256, decisions: plan.decisions });
        return 0;
      }
      const at = now();
      const receipt = await withWriterDatabase(env, database, false, (db) => fencedRetailWrite(db, backup, () => reviewRetailReceipts(db,
        review, { now: at, authority: goAuthority(go), reviewSha256, planDigest: plan.planDigest }), requireRetailSchema, access, context.probe));
      print({ code: receipt.code, purpose: go.purpose, goId: go.goId, reviewSha256, decisions: receipt.decisions, planDigest: receipt.planDigest });
      return 0;
    }
    if (command === 'bindings' && rest[0] === 'propose') {
      const opts = options(rest.slice(1), ['--db', '--out']);
      const database = opts.get('--db')!;
      const out = opts.get('--out')!;
      newPath(out);
      const outDir = ownerOnlyOutputDirectory(out, access, OUTPUT_REFUSALS);
      checkOutputName(path.join(outDir, path.basename(out)));
      const result = await withSharedRead(env, database, (db) => proposeRetailBindings(db, digest(path.resolve(database))));
      if (result === null) return noLease();
      const text = serializeRetailBindingProposal(result.value.proposal);
      // The real directory again, then the new empty file itself, before a byte of the proposal is written.
      ownerOnlyOutputDirectory(out, access, OUTPUT_REFUSALS);
      mapOutputRefusals(() => writeOwnerOnlyNewFile(path.join(outDir, path.basename(out)), text, access), OUTPUT_REFUSALS);
      print({ code: 'retail-bindings-proposed', proposalSha256: sha256Hex(text), ...result.value.summary });
      return 0;
    }
    if (command === 'report') {
      const database = options(rest, ['--db']).get('--db')!;
      const result = await withSharedRead(env, database, (db) => readSnapshot(db, () => retailSchemaForRead(db),
        () => formatRetailReport(retailReport(db))));
      if (result === null) return noLease();
      if (result.value === null) throw new Error('report outside its shape');
      io.stdout.write(result.value);
      return 0;
    }
    if (command === 'taxonomy') return await taxonomy(rest[0], rest.slice(1));
    throw new HoldrRefusal('retail input refused');
  } catch (error) {
    if (error instanceof RetailRefusal) {
      print({ code: error.code, ...error.details });
      return 1;
    }
    io.stderr.write(`holdr-retail: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }

  /**
   * `preview` (plan §8.2, Q-P1): the clone-only exception. The inputs and the destination are checked before a byte is
   * copied, and the new clone itself, empty, owner-only before the source is copied into it; the source is read under
   * the writer's shared lease (or on a disposable stack) through a read-only, query_only handle that stays open, with its
   * lease, until SQLite's backup API has copied it into the new clone; install and import then run on the clone's own
   * handle under the preview's authority, which no GO is. Before any SQLite use, the clone and the names SQLite keeps
   * beside it are created exclusively (D-PR2-C4). Before any of that, its path is refused, as given and with its
   * directory's links resolved, if Windows or SQLite reads it as another file or a device (the one shared rule,
   * D-PR2-C7), or if its name is one SQLite keeps beside a database (ROOT's C4 ruling): no other run's SQLite can then
   * claim one of those names as its own while this run's SQLite has let it go, and the clone itself stays this run's,
   * never unlinked, until the run ends. A failure removes only the files the preview created, each only while it is
   * still the file created: never one that was there before or was put in its place, and never the source.
   */
  async function preview(database: string, clone: string, input: { payload: RetailImportPayload; inputSha256: string },
    declaration: RetailDeclarationInput | null): Promise<number> {
    if (withSidecars(clone).some((name) => fs.lstatSync(name, { throwIfNoEntry: false }))) throw new RetailRefusal('retail-output-exists');
    // The path as given, before anything resolves it (newOutputPath's check, which preview doesn't call).
    if (isWindowsAliasName(clone)) throw new RetailRefusal('retail-output-name-refused');
    const dir = ownerOnlyOutputDirectory(clone, access, OUTPUT_REFUSALS);
    const target = path.join(dir, path.basename(clone));
    const family = sqliteFamily(database);
    if (withSidecars(target).some((name) => family.includes(comparable(name)))) throw new RetailRefusal('retail-clone-is-source');
    checkOutputName(target);
    if (configuredControlDir(env) === null && env.HOLDR_CONFIG !== 'none') return noLease();
    context.probe?.('clone-checked');
    // D-PR2-C4 (ROOT): before any SQLite use, the clone and each name SQLite keeps beside it are created here, exclusively:
    // a name in use refuses (retail-output-exists) and is never opened or removed. Each created file's identity is
    // recorded, and a failure removes only those files, each only while it is still the very file created.
    const created = new Map<string, string>();
    let cloneDb: Database.Database | null = null;
    try {
      // The clone itself and each name SQLite keeps beside it, reserved owner-only before any SQLite use (D-PR2-C2, C4).
      for (const name of withSidecars(target)) created.set(name, reserveNewFile(name, access));
      context.probe?.('clone-created');
      const sourceSchema = await withWriterDatabase(env, database, true, async (db) => {
        const state = retailSchemaForRead(db);
        await db.backup(target);
        return state;
      });
      fs.chmodSync(target, 0o600);
      context.probe?.('clone-copied');
      cloneDb = new Database(target, { fileMustExist: true });
      cloneDb.pragma('foreign_keys = ON');
      const authority: RetailAuthority = { kind: 'preview' };
      const installed = installRetailSchema(cloneDb, { now: now(), authority });
      const receipt = importRetailPayload(cloneDb, { payload: input.payload, declaration, membership: null },
        { now: now(), authority, inputSha256: input.inputSha256, planDigest: null });
      context.probe?.('clone-imported');
      cloneDb.close();
      cloneDb = null;
      print({
        code: 'retail-previewed', source: { schema: sourceSchema }, install: { installed: installed.installed },
        import: { code: receipt.code, importSeq: receipt.importSeq, ...importCounts(receipt), planDigest: receipt.planDigest },
        activation: 'none',
      });
      return 0;
    } catch (error) {
      cloneDb?.close();
      for (const [name, identity] of created) removeIfStill(name, identity);
      throw error;
    }
  }

  /**
   * A new owner-only output file, as `bindings propose` writes one: the path new and refused by the shared name rule
   * before anything is read, its real directory owner-only; then, once the text exists, that directory again and the new
   * empty file checked owner-only before a byte is written. Returns the writer.
   */
  function ownerOnlyOutput(out: string): (text: string) => void {
    newPath(out);
    const outDir = ownerOnlyOutputDirectory(out, access, OUTPUT_REFUSALS);
    checkOutputName(path.join(outDir, path.basename(out)));
    return (text) => {
      if (Buffer.byteLength(text, 'utf8') > RETAIL_TAXONOMY_FILE_MAX_BYTES) throw new RetailRefusal('retail-taxonomy-file-invalid');
      ownerOnlyOutputDirectory(out, access, OUTPUT_REFUSALS);
      mapOutputRefusals(() => writeOwnerOnlyNewFile(path.join(outDir, path.basename(out)), text, access), OUTPUT_REFUSALS);
    };
  }

  /**
   * `holdr-retail taxonomy …` (Costco 3/7 plan v5 §7). `worklist` and `plan` read as `plan` does (§7.2): under the shared
   * lease or on a disposable stack, the exact schema and the reserved-value STOP once, first, in their one read
   * transaction. `adopt` opens no database. `import` follows §7.4: the mapping, then the GO, then a read-only preflight
   * (the schema and reserved-value STOP, the exact replay, the plan against the GO's `planDigest`), all before any backup;
   * then PR 2's own fenced write, whose writer checks again under the fence after the backup.
   */
  async function taxonomy(subcommand: string | undefined, rest: string[]): Promise<number> {
    if (subcommand === 'worklist') {
      const opts = options(rest, ['--db', '--out']);
      const writeFile = ownerOnlyOutput(opts.get('--out')!);
      const result = await withSharedRead(env, opts.get('--db')!, (db) => readSnapshot(db, () => retailSchemaForRead(db),
        (schema) => ({ schema, worklist: schema === 'absent' ? emptyRetailTaxonomyWorklist() : retailTaxonomyWorklist(db) })));
      if (result === null) return noLease();
      const { schema, worklist } = result.value;
      const text = serializeRetailTaxonomyWorklist(worklist);
      writeFile(text);
      print({ code: 'retail-taxonomy-worklist-written', schema, products: worklist.products.length, departments: worklist.departments.length,
        coverage: worklist.coverage, worklistSha256: sha256Hex(text) });
      return 0;
    }
    if (subcommand === 'adopt') {
      const opts = options(rest, ['--input', '--worklist', '--out']);
      const writeFile = ownerOnlyOutput(opts.get('--out')!);
      const assignments = retailTaxonomyAssignmentsOf(readTaxonomyFile(opts.get('--input')!).value);
      const listed = readTaxonomyFile(opts.get('--worklist')!);
      const mapping = adoptRetailTaxonomyAssignments(assignments, retailTaxonomyWorklistOf(listed.value), listed.sha256,
        randomBytes(16).toString('hex'));
      const text = serializeRetailTaxonomyMapping(mapping);
      writeFile(text);
      print({ code: 'retail-taxonomy-mapping-written', entries: mapping.entries.length, decisionId: mapping.decisionId, mappingSha256: sha256Hex(text) });
      return 0;
    }
    if (subcommand === 'plan') {
      const opts = options(rest, ['--db', '--mapping']);
      const database = opts.get('--db')!;
      const { mapping, mappingSha256 } = readMapping(opts.get('--mapping')!);
      const result = await withSharedRead(env, database, (db) => readSnapshot(db, () => retailSchemaForRead(db),
        (schema) => (schema === 'absent' ? null : planRetailTaxonomyImport(db, mapping, mappingSha256))));
      if (result === null) return noLease();
      const plan = result.value;
      print(plan === null
        ? { code: 'retail-taxonomy-planned', schema: 'absent', mappingSha256, decisionId: mapping.decisionId, taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST,
          schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST, databaseRef: digest(path.resolve(database)) }
        : { code: 'retail-taxonomy-planned', schema: 'present', ...taxonomyPlanOutput(plan), databaseRef: digest(path.resolve(database)) });
      return 0;
    }
    if (subcommand === 'import') {
      const opts = options(rest, ['--db', '--mapping', '--go', '--backup']);
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      // §7.4 step 1, the mapping; step 2, the GO: its build pins (the taxonomy digest, a planDigest's shape), then its inputs.
      const { mapping, mappingSha256 } = readMapping(opts.get('--mapping')!);
      const go = authorize(opts.get('--go')!, 'taxonomy-import', database, { mappingSha256, decisionId: mapping.decisionId });
      if (go.taxonomyDigest !== ITEM_TAXONOMY_V2_DIGEST || typeof go.planDigest !== 'string' || !HEX64.test(go.planDigest)) {
        throw new RetailRefusal('retail-go-invalid');
      }
      backupPlace(backup, database);
      // Steps 3 and 4, read-only: the STOP, then the exact replay before any freshness check, then the plan.
      const preflight = await withWriterDatabase(env, database, true, (db) => preflightRetailTaxonomyImport(db, mapping, mappingSha256));
      if (preflight.alreadyImported !== null) {
        print({ code: 'retail-already-imported', goId: go.goId, mappingSha256, ...preflight.alreadyImported });
        return 0;
      }
      if (preflight.plan!.planDigest !== go.planDigest) throw new RetailRefusal('retail-plan-changed');
      context.probe?.('preflighted');
      const at = now();
      // The writer checks the schema, the reserved values, the replay and the plan itself, under the fence: one call site
      // each (§8), so PR 2's fence is passed no second check.
      const receipt = await withWriterDatabase(env, database, false, (db) => fencedRetailWrite(db, backup, () => importRetailTaxonomy(db, mapping,
        { now: at, authority: goAuthority(go), mappingSha256, planDigest: go.planDigest as string }), () => undefined, access, context.probe));
      print({ code: receipt.code, purpose: go.purpose, goId: go.goId, mappingSha256, taxonomyImportId: receipt.taxonomyImportId, seq: receipt.seq,
        ...(receipt.plan === null ? {} : { entries: receipt.plan.entries, actions: receipt.plan.actions, planDigest: receipt.plan.planDigest }) });
      return 0;
    }
    throw new HoldrRefusal('retail input refused');
  }
}
