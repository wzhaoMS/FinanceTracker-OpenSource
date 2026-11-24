import path from 'node:path';
import type Database from 'better-sqlite3';

import { METALS_SOURCES, serializeMetalsImportPayload, type MetalsImportPayload, type MetalsSource } from '@finance-tracker/shared/metals-ledger';

import { digest } from '../services/amazon/policy.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import {
  HEX32,
  HEX64,
  METALS_FOLDER_REGISTRY_MAX_BYTES,
  METALS_IDENTITY_DIGEST,
  METALS_IDENTITY_KEY_BYTES,
  METALS_IMPORT_ID,
  METALS_INTERIM_V0_DIGEST,
  METALS_ORDER_KEY,
  METALS_SCHEMA_DIGEST,
  MetalsRefusal,
  approveMetalsBindings,
  canonicalMetalsPayload,
  checkMetalsIdentityPin,
  fencedMetalsWrite,
  importMetalsPayload,
  installMetalsSchema,
  isMetalsFolder,
  metalsAccountChoice,
  metalsBindingIds,
  metalsBindingPairs,
  metalsFreeTextProblems,
  metalsIdentityDigest,
  metalsIdentityInputUnusable,
  metalsRegisteredIdentity,
  metalsReinstallCounts,
  metalsSchemaObjects,
  metalsSchemaState,
  newMetalsIdentityKeyText,
  parseMetalsFolderRegistry,
  parseMetalsIdentityKey,
  planMetalsBindingApproval,
  planMetalsBindingRevocation,
  planMetalsImport,
  planMetalsReinstall,
  planMetalsSupersede,
  preflightMetalsReinstall,
  proposeMetalsBindings,
  reinstallMetalsSchema,
  requireMetalsSchema,
  revokeMetalsBindings,
  serializeMetalsBindingProposal,
  serializeMetalsFolderRegistry,
  sha256Hex,
  supersedeMetalsVersions,
  validMetalsBindingProposal,
  validMetalsPayload,
  type MetalsAccountChoice,
  type MetalsFolderRegistry,
  type MetalsImportPlan,
  type MetalsImportPurpose,
  type MetalsBindingPurpose,
  type MetalsReinstallPoint,
  type MetalsSupersedePurpose,
} from '../services/metals/index.js';
import type { Io } from './controlCommon.js';
import { formatMetalsReport, metalsReport } from './metalsReport.js';
import { METALS_VIEWS_REPORT_COMMAND, metalsViewsReport, renderMetalsViewsReport } from './metalsViewsReport.js';
import {
  exactKeys,
  mapOutputRefusals,
  newOutputPath,
  ownerOnlyOutputDirectory,
  parseJson,
  parseOptions,
  readInputFile,
  withSharedRead,
  withWriterDatabase as withDatabase,
  type OperatorRefusals,
  type OptionCheck,
} from './operatorIo.js';
import { InputRefusal, platformOutputAccess, readOwnerOnlyFile, writeOwnerOnlyNewFile, type OutputAccess } from './ownerOnlyOutput.js';
import { readSecretFromTerminal, TerminalSecretRefusal } from './terminalSecret.js';

export const METALS_CLI_USAGE = `Metals ledger operator CLI (existing finance.db only)
  plan --db DB [--payload FILE]
  install --db DB --go GO --backup NEW_FILE
  reinstall --db DB --go GO --backup NEW_FILE
  import --db DB --payload FILE --go GO --backup NEW_FILE [--identity-key FILE --identity-registry FILE]
  supersede --db DB --import IMPORT_ID [--order ORDER_KEY] --choose incoming|active --go GO --backup NEW_FILE
  bindings propose --db DB --out NEW_FILE
  bindings approve --db DB --proposal FILE --go GO --backup NEW_FILE
  bindings revoke --db DB --go GO --backup NEW_FILE
  report --db DB
  ${METALS_VIEWS_REPORT_COMMAND} --db DB --out NEW_FILE
  identity-key --out NEW_FILE
  identity-register --registry NEW_FILE [--from FILE] --source SOURCE --folder FOLDER
  identity-digest --registry FILE --identity-key FILE --source SOURCE --folder FOLDER
plan opens the database read-only, writes nothing, and prints whether the metals tables are present, absent or in
conflict (exit 1), with the schema digest and the database reference a GO must name. A ledger that is exactly the
interim v0 shape (Track B's, before contract follow-up 1E) is metals-reinstall-planned instead (exit 0), with v0's
digest, each v0 table's row count, which a reinstall GO pins, and v0's active bindings by kind (activeBindings), which
the swap drops and the runbook re-records through bindings approve. With --payload it validates the
payload (holdr.metals-import v1, byte for byte its canonical serialization, no run of 13 or more digits in any free
text) and prints its inputSha256 and, when the tables are present, what an import would do, as counts.
install is the only way the metals tables are created: the API never creates them. It requires a Root GO (format
holdr.metals-go, version 1, command install) pinned to this database and this schema. A conflict is refused before any
backup; tables already installed take no backup and write nothing (metals-already-installed). Otherwise a new pre-write
backup, then every table, index and trigger created and verified in one IMMEDIATE transaction.
reinstall swaps an interim v0 ledger for this version, dropping v0's data (it returns only by re-conversion and
re-import). It requires a Root GO (command reinstall) pinned to this database, this schema, v0's digest (fromDigest)
and every v0 table's row count as plan printed it (counts). Version 1 already present takes no backup and writes
nothing (metals-already-installed); anything but exactly v0 is metals-conflict, other counts metals-go-mismatch, and a
foreign-key violation outside the metals tables metals-foreign-keys-unclean, all before any backup. Otherwise, with
foreign-key enforcement off on its own connection, a new pre-write backup, then one IMMEDIATE transaction that checks
again, drops exactly v0's objects, creates version 1 and verifies it, the rest of the schema unchanged and the
database's foreign_key_check empty, or rolls back with v0 whole.
import requires the installed tables and a Root GO (command import) pinned to this database, this schema, the payload's
SHA-256 (inputSha256) and its source account ({"accountId": …} or, for a new one, {"label": …, "identityDigest": …}). The GO and the payload
are checked before the database is opened; a read-only preflight then plans every order against its active version
(new, observation, predecessor, progression, proposal, conflict; a capture that shows less than the active version is a
predecessor only when it is provably older, else a conflict, so import each account's payloads in capture order). The
same payload again is metals-already-imported (no backup, no write). Otherwise a new pre-write backup, then one
IMMEDIATE transaction that plans again and writes only if the plan is unchanged (else metals-plan-changed, nothing
written). Versions and observations are append-only.
supersede resolves the proposals and conflicts one import created (one order, or all), under a Root GO naming the
import, the order (or null) and the choice: incoming makes them active (each keeps the GO that chose it), active
declines them. Every version stays.
bindings propose (read-only) writes an owner-only proposal file: every payment identity the imported data names, with
the Holdr card or checking accounts whose last 4 match, and the inventory digest; it prints counts only. bindings
approve activates exactly the pairs a Root GO names, pinned to the proposal's SHA-256 and the inventory digest, and is
refused if any account changed since. bindings revoke revokes exactly the bindings a Root GO names.
report, ${METALS_VIEWS_REPORT_COMMAND} and bindings propose take the writer's shared lease when HOLDR_CONTROL_DIR is set; without it they
run only for a disposable stack (HOLDR_CONFIG=none) and otherwise refuse (no-shared-lease). report prints one line of
counts and dates. ${METALS_VIEWS_REPORT_COMMAND} (read-only) writes an owner-only, write-once file of the Gold page's views for each
metal, their full answers as the API serves them, and prints one value-free line: counts, the identity checks and the
file's SHA-256. That line is the only output that leaves the Mac: run ${METALS_VIEWS_REPORT_COMMAND} on the Mac only, and never copy
its file off the Mac or into chat, logs or reports. It reads only a present ledger with no correction state, so it is
refused under every quarantine reason (metals-quarantined); report, ROOT's read-report, is the one read that runs under
the marker.
All paths must be absolute; a backup or an output file must be new. A proposal file is owner-only: its real directory
and the new empty file are checked before a byte is written (ownerOnlyOutput.ts: by ACL on Windows, by owner, mode and
ACL through the pinned holdr-pathcheck on macOS, by owner and mode on Linux), else metals-output-not-owner-only or
metals-output-uncheckable. A backup or output path with a folder or file name that Windows reads as another file or a
device (ending in a dot or a space, holding a colon, or a device name like NUL or COM1) is refused first, on every
platform: metals-output-name-refused. Output is codes, ids, keys, digests, counts and dates only.
An import whose GO creates an account must pin the account's identity: the GO's identityDigest is the keyed digest
(HMAC-SHA256 under the owner's identity key) of the source, the folder and the Costco membership last 4, and
--identity-key and --identity-registry name the owner-only key and folder registry. Before the database is opened, the
digest of the registry's entry for the payload's source and folder, and that of the payload's stated identity, must both
equal the pin (else metals-identity-unregistered or metals-identity-mismatch). An import into an existing account takes
neither option and no pin (metals-go-invalid otherwise). identity-key writes a new owner-only key file. identity-register
writes a new owner-only registry: the --from registry's folders and one more; for Costco it asks twice, on the terminal and
never echoed, for the membership last 4. identity-digest prints the keyed digest a GO pins for a registered folder. The key
and the registry are read only when owner-only, every check bound to the very file read (else
metals-identity-input-unusable, with reason missing, malformed, not-owner-only, uncheckable or changed); their values are
never printed.
`;

const GO_MAX_BYTES = 64 * 1024;
const PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const PROPOSAL_MAX_BYTES = 16 * 1024 * 1024;

type GoCommand = 'install' | 'reinstall' | 'import' | 'supersede' | 'bindings-approve' | 'bindings-revoke';
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest'] as const;
const GO_EXTRA: Readonly<Record<GoCommand, readonly string[]>> = {
  install: [],
  reinstall: ['fromDigest', 'counts'],
  import: ['inputSha256', 'account'],
  supersede: ['importId', 'orderKey', 'choose'],
  'bindings-approve': ['proposalSha256', 'inventoryDigest', 'pairs'],
  'bindings-revoke': ['bindingIds'],
};
const GO_PURPOSES: Readonly<Record<GoCommand, readonly string[]>> = {
  install: ['copy-rehearsal', 'production-install'],
  reinstall: ['copy-rehearsal', 'production-reinstall'],
  import: ['copy-rehearsal', 'production-import'],
  supersede: ['copy-rehearsal', 'production-supersede'],
  'bindings-approve': ['copy-rehearsal', 'production-bindings'],
  'bindings-revoke': ['copy-rehearsal', 'production-bindings'],
};

/**
 * This CLI's refusals for the shared operator primitives (operatorIo.ts): every refused input is the one value-free input
 * refusal, and a refused output place keeps its code as `metals-…`.
 */
const REFUSALS: OperatorRefusals = {
  input: () => new HoldrRefusal('metals input refused'),
  output: (code) => new MetalsRefusal(`metals-${code}`),
};

function refuse(): never {
  throw REFUSALS.input();
}

const readBytes = (file: string, max: number): Buffer => readInputFile(file, max, REFUSALS);
const parse = (bytes: Buffer): unknown => parseJson(bytes, REFUSALS);
const exactly = (value: unknown, keys: readonly string[]): Record<string, unknown> => exactKeys(value, keys, REFUSALS);

type OptionKind = 'path' | 'import' | 'order' | 'choose' | 'source' | 'folder';
const OPTION_VALUES: Readonly<Record<OptionKind, OptionCheck>> = {
  path: (value) => path.isAbsolute(value),
  import: (value) => METALS_IMPORT_ID.test(value),
  order: (value) => METALS_ORDER_KEY.test(value),
  choose: (value) => value === 'incoming' || value === 'active',
  source: (value) => (METALS_SOURCES as readonly string[]).includes(value),
  // A capture folder's shape; each command then checks it against its source (the payload's own folder rule).
  folder: (value) => /^[a-z][a-z0-9]*(?:-[1-9][0-9]{0,2})?$/.test(value),
};
const optionChecks = (kinds: Record<string, OptionKind>) =>
  Object.fromEntries(Object.entries(kinds).map(([name, kind]): [string, OptionCheck] => [name, OPTION_VALUES[kind]]));

function options(args: readonly string[], required: Record<string, OptionKind>, optional: Record<string, OptionKind> = {}): Map<string, string> {
  return parseOptions(args, optionChecks(required), optionChecks(optional), REFUSALS);
}

interface Go extends Record<string, unknown> {
  purpose: string;
  goId: string;
}

/** The GO's fixed fields, compared strictly by type and value, before the database is opened; `pinned` must match too. */
function authorize(input: unknown, command: GoCommand, database: string, pinned: Record<string, unknown> = {}): Go {
  const go = exactly(input, [...GO_KEYS, ...GO_EXTRA[command]]);
  if (go.format !== 'holdr.metals-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !GO_PURPOSES[command].includes(go.purpose) || go.command !== command
    || typeof go.goId !== 'string' || !HEX32.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== METALS_SCHEMA_DIGEST) return refuse();
  for (const [key, value] of Object.entries(pinned)) if (go[key] !== value) return refuse();
  return go as Go;
}

/** A new output path (a backup or a proposal file): nothing there yet, in an existing directory. */
const newPath = (file: string): void => newOutputPath(file, REFUSALS);

/** The shared owner-only output refusals (ownerOnlyOutput.ts), as this CLI's value-free codes. */
const asMetalsRefusal = <T>(fn: () => T): T => mapOutputRefusals(fn, REFUSALS);

/**
 * The real directory a proposal file lands in, checked owner-only (review P299-1). Links and junctions are resolved, so
 * the directory checked is the one written to.
 */
const ownerOnlyOutputDir = (file: string, access: OutputAccess): string => ownerOnlyOutputDirectory(file, access, REFUSALS);

interface PayloadInput {
  payload: MetalsImportPayload;
  inputSha256: string;
  summary: Record<string, unknown>;
}

/** A payload file: byte for byte, the canonical serialization of a valid payload whose canonical orders validate. */
function readPayload(file: string): PayloadInput {
  const bytes = readBytes(file, PAYLOAD_MAX_BYTES);
  const inputSha256 = sha256Hex(bytes);
  const payload = validMetalsPayload(parse(bytes));
  if (!Buffer.from(serializeMetalsImportPayload(payload), 'utf8').equals(bytes)) throw new MetalsRefusal('metals-payload-not-canonical');
  const canonical = canonicalMetalsPayload(structuredClone(payload));
  const freeText = metalsFreeTextProblems(canonical);
  if (freeText.length > 0) throw new MetalsRefusal('metals-payload-free-text', { paths: freeText });
  return {
    payload,
    inputSha256,
    summary: {
      inputSha256, source: payload.source, orders: payload.orders.length, lines: payload.orders.reduce((sum, order) => sum + order.lines.length, 0),
      competitors: payload.competitors.length, held: payload.held.length, coverage: payload.coverage.length,
    },
  };
}

const importCounts = (plan: MetalsImportPlan) => ({
  orders: plan.orders, lines: plan.lines, competitors: plan.competitors, held: plan.held, coverage: plan.coverage, pending: plan.pending,
});

/**
 * Where a test may act on a reinstall run through this command (production passes none): `beforeFence` runs after the
 * read-only preflight, with the writer connection open and before the fence's BEGIN IMMEDIATE; `probe` is the swap's
 * own, at each of its points inside the fence.
 */
export interface MetalsReinstallSeams {
  readonly beforeFence?: () => void;
  readonly probe?: (point: MetalsReinstallPoint) => void;
}

/** The import options that name the owner-only identity inputs: required exactly when the GO creates an account. */
const IDENTITY_OPTIONS = ['--identity-key', '--identity-registry'] as const;

/**
 * The import GO's `account` (corrections design r6, section 2.8): an existing account by id, with no pin, or a new one by
 * its label and its identity pin. A new account without a pin, or an existing one with a pin, is metals-go-invalid.
 */
function goAccount(value: unknown): { account: MetalsAccountChoice; pin: string | null } {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    if (keys === 'accountId') return { account: metalsAccountChoice(record), pin: null };
    if (keys === 'identityDigest,label') {
      if (typeof record.identityDigest !== 'string' || !METALS_IDENTITY_DIGEST.test(record.identityDigest)) throw new MetalsRefusal('metals-go-invalid');
      return { account: metalsAccountChoice({ label: record.label }), pin: record.identityDigest };
    }
    if (keys === 'label' || keys === 'accountId,identityDigest') throw new MetalsRefusal('metals-go-invalid');
  }
  throw new MetalsRefusal('metals-account-invalid');
}

/** An owner-only identity input (the key or the registry), read under the read protocol; a refusal keeps its closed reason. */
function readIdentityInput(file: string, maxBytes: number, access: OutputAccess): Buffer {
  try {
    return readOwnerOnlyFile(file, maxBytes, access);
  } catch (error) {
    if (error instanceof InputRefusal) throw metalsIdentityInputUnusable(error.reason);
    throw error;
  }
}

const readIdentityKey = (file: string, access: OutputAccess): Buffer =>
  parseMetalsIdentityKey(readIdentityInput(file, METALS_IDENTITY_KEY_BYTES, access));
const readFolderRegistry = (file: string, access: OutputAccess): MetalsFolderRegistry =>
  parseMetalsFolderRegistry(readIdentityInput(file, METALS_FOLDER_REGISTRY_MAX_BYTES, access));

/** The terminal's no-echo reader as this CLI's refusals: no terminal, or an entry the operator cancelled. */
async function terminalSecret(prompt: string, io: Io, input: NodeJS.ReadStream): Promise<string> {
  try {
    return await readSecretFromTerminal(prompt, io.stderr, input);
  } catch (error) {
    if (error instanceof TerminalSecretRefusal) {
      throw new MetalsRefusal(error.reason === 'no-terminal' ? 'metals-identity-needs-terminal' : 'metals-identity-entry-cancelled');
    }
    throw error;
  }
}

export async function runMetalsCli(args: string[], context: {
  env: NodeJS.ProcessEnv; io: Io; now?: () => Date; outputAccess?: OutputAccess;
  /** The terminal an owner-only value is typed on, never echoed: process.stdin, or a test's stand-in. */
  terminal?: NodeJS.ReadStream;
  reinstallSeams?: MetalsReinstallSeams;
}): Promise<number> {
  const { io, env } = context;
  const access = context.outputAccess ?? platformOutputAccess;
  const readSecret = (prompt: string) => terminalSecret(prompt, io, context.terminal ?? process.stdin);
  const print = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  const now = () => (context.now ?? (() => new Date()))().toISOString();
  // A refusal met inside the fenced transaction leaves it as a value-free database error; its code is kept here.
  const refused: { error?: MetalsRefusal } = {};
  const capture = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof MetalsRefusal) refused.error = error;
      throw error;
    }
  };
  const requireInstalled = (db: Database.Database) => capture(() => requireMetalsSchema(db));
  try {
    const [command, ...rest] = args;
    if (command === '--help') {
      io.stdout.write(METALS_CLI_USAGE);
      return 0;
    }
    if (command === 'plan') {
      const opts = options(rest, { '--db': 'path' }, { '--payload': 'path' });
      const database = opts.get('--db')!;
      const input = opts.has('--payload') ? readPayload(opts.get('--payload')!) : null;
      const result = await withDatabase(env, database, true, (db) => {
        const schema = metalsSchemaState(db);
        // A conflict that is exactly the interim v0 ledger is the one a reinstall swaps (its GO pins these counts).
        const reinstall = schema === 'conflict' ? planMetalsReinstall(db) : null;
        const out: Record<string, unknown> = {
          code: schema !== 'conflict' ? 'metals-planned' : reinstall ? 'metals-reinstall-planned' : 'metals-conflict', schema,
          schemaDigest: METALS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)), objects: metalsSchemaObjects(db),
        };
        if (reinstall) {
          out.reinstall = { fromDigest: reinstall.from.digest, from: reinstall.from, to: reinstall.to, counts: reinstall.counts,
            activeBindings: reinstall.activeBindings };
        }
        if (input) {
          out.input = input.summary;
          if (schema === 'present') {
            try {
              const plan = planMetalsImport(db, { payload: input.payload, account: null });
              out.import = { alreadyImported: plan.alreadyImported, importId: plan.importId, ...importCounts(plan) };
            } catch (error) {
              if (!(error instanceof MetalsRefusal)) throw error;
              out.import = { code: error.code, ...error.details };
            }
          }
        }
        return out;
      });
      print(result);
      return result.code === 'metals-conflict' ? 1 : 0;
    }
    if (command === 'install') {
      const opts = options(rest, { '--db': 'path', '--go': 'path', '--backup': 'path' });
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const go = authorize(parse(readBytes(opts.get('--go')!, GO_MAX_BYTES)), 'install', database);
      newPath(backup);
      const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: METALS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) };
      // Read-only first: installed tables need no backup and no write, and a conflict is refused before any backup.
      const schema = await withDatabase(env, database, true, metalsSchemaState);
      if (schema === 'present') {
        print({ code: 'metals-already-installed', ...receipt });
        return 0;
      }
      if (schema === 'conflict') throw new MetalsRefusal('metals-conflict');
      await withDatabase(env, database, false, (db) => fencedMetalsWrite(db, backup, () => receipt, installMetalsSchema));
      print({ code: 'metals-installed', ...receipt });
      return 0;
    }
    if (command === 'reinstall') {
      const opts = options(rest, { '--db': 'path', '--go': 'path', '--backup': 'path' });
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const go = authorize(parse(readBytes(opts.get('--go')!, GO_MAX_BYTES)), 'reinstall', database, { fromDigest: METALS_INTERIM_V0_DIGEST });
      const counts = metalsReinstallCounts(go.counts) ?? refuse();
      newPath(backup);
      const receipt = {
        purpose: go.purpose, goId: go.goId, databaseRef: digest(path.resolve(database)), fromDigest: METALS_INTERIM_V0_DIGEST,
        schemaDigest: METALS_SCHEMA_DIGEST,
      };
      // Read-only preflight: version 1 already present takes no backup and writes nothing; every refusal comes before any backup.
      const preflight = await withDatabase(env, database, true, (db) => preflightMetalsReinstall(db, counts));
      if (preflight === 'installed') {
        print({ code: 'metals-already-installed', ...receipt });
        return 0;
      }
      // Foreign-key enforcement off on this connection only, before the fence's BEGIN (SQLite ignores the pragma inside a
      // transaction), under the writer's lease: DROP TABLE then deletes no row. The swap checks it is off, verifies the
      // whole database's foreign_key_check, and enforcement is restored before the connection closes.
      const seams = context.reinstallSeams;
      const swapped = await withDatabase(env, database, false, async (db) => {
        db.pragma('foreign_keys = OFF');
        try {
          seams?.beforeFence?.();
          return await fencedMetalsWrite(db, backup, () => capture(() => reinstallMetalsSchema(db, counts, seams?.probe)), () => {});
        } finally {
          db.pragma('foreign_keys = ON');
        }
      });
      print({ code: 'metals-reinstalled', ...receipt, from: swapped.from, to: swapped.to, dropped: swapped.dropped, rows: swapped.counts,
        activeBindings: swapped.activeBindings });
      return 0;
    }
    if (command === 'import') {
      const opts = options(rest, { '--db': 'path', '--payload': 'path', '--go': 'path', '--backup': 'path' },
        { '--identity-key': 'path', '--identity-registry': 'path' });
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const input = readPayload(opts.get('--payload')!);
      const go = authorize(parse(readBytes(opts.get('--go')!, GO_MAX_BYTES)), 'import', database, { inputSha256: input.inputSha256 });
      const { account, pin } = goAccount(go.account);
      // The identity inputs are required exactly when the GO creates an account, and refused otherwise (r6 section 2.8).
      if (IDENTITY_OPTIONS.filter((name) => opts.has(name)).length !== (pin === null ? 0 : IDENTITY_OPTIONS.length)) return refuse();
      if (pin !== null) {
        const key = readIdentityKey(opts.get('--identity-key')!, access);
        const registry = readFolderRegistry(opts.get('--identity-registry')!, access);
        checkMetalsIdentityPin(pin, key, registry,
          { source: input.payload.source, folder: input.payload.account.folder, identityLast4: input.payload.account.identityLast4 });
      }
      newPath(backup);
      const request = { payload: input.payload, account };
      // Read-only preflight: not installed, already imported, or refused all end here, before any backup.
      const plan = await withDatabase(env, database, true, (db) => planMetalsImport(db, request));
      if (plan.alreadyImported) {
        print({ code: 'metals-already-imported', goId: go.goId, inputSha256: input.inputSha256, importId: plan.importId, accountId: plan.accountId });
        return 0;
      }
      const receipt = await withDatabase(env, database, false, (db) => fencedMetalsWrite(db, backup, () => capture(() => importMetalsPayload(db, request,
        { now: now(), goId: go.goId, purpose: go.purpose as MetalsImportPurpose, inputSha256: input.inputSha256, planDigest: plan.planDigest })),
      requireInstalled));
      print({ code: receipt.code, purpose: go.purpose, goId: go.goId, inputSha256: receipt.inputSha256, importId: receipt.importId,
        accountId: receipt.accountId, accountCreated: receipt.accountCreated, ...importCounts(receipt) });
      return 0;
    }
    if (command === 'supersede') {
      const opts = options(rest, { '--db': 'path', '--import': 'import', '--choose': 'choose', '--go': 'path', '--backup': 'path' },
        { '--order': 'order' });
      const database = opts.get('--db')!;
      const backup = opts.get('--backup')!;
      const request = { importId: opts.get('--import')!, orderKey: opts.get('--order') ?? null, choose: opts.get('--choose') as 'incoming' | 'active' };
      const go = authorize(parse(readBytes(opts.get('--go')!, GO_MAX_BYTES)), 'supersede', database,
        { importId: request.importId, orderKey: request.orderKey, choose: request.choose });
      newPath(backup);
      const plan = await withDatabase(env, database, true, (db) => planMetalsSupersede(db, request));
      if (plan.alreadyResolved) {
        print({ code: 'metals-already-resolved', goId: go.goId, importId: plan.importId, orders: 0 });
        return 0;
      }
      const receipt = await withDatabase(env, database, false, (db) => fencedMetalsWrite(db, backup, () => capture(() => supersedeMetalsVersions(db,
        request, { now: now(), goId: go.goId, purpose: go.purpose as MetalsSupersedePurpose, planDigest: plan.planDigest })), requireInstalled));
      const { planDigest: _digest, alreadyResolved: _resolved, ...counts } = receipt;
      print({ ...counts, purpose: go.purpose, goId: go.goId });
      return 0;
    }
    if (command === 'bindings') {
      const [subcommand, ...more] = rest;
      if (subcommand === 'propose') {
        const opts = options(more, { '--db': 'path', '--out': 'path' });
        const database = opts.get('--db')!;
        const out = opts.get('--out')!;
        newPath(out);
        const outDir = ownerOnlyOutputDir(out, access);
        const result = await withSharedRead(env, database, (db) => proposeMetalsBindings(db, digest(path.resolve(database))));
        if (result === null) {
          io.stderr.write('holdr-metals: propose-refused no-shared-lease\n');
          return 1;
        }
        const text = serializeMetalsBindingProposal(result.value.proposal);
        // The real directory again, then the new empty file itself, before a byte of the proposal is written.
        ownerOnlyOutputDir(out, access);
        asMetalsRefusal(() => writeOwnerOnlyNewFile(path.join(outDir, path.basename(out)), text, access));
        print({ code: 'metals-bindings-proposed', proposalSha256: sha256Hex(text), inventoryDigest: result.value.proposal.inventoryDigest,
          ...result.value.summary });
        return 0;
      }
      if (subcommand === 'approve') {
        const opts = options(more, { '--db': 'path', '--proposal': 'path', '--go': 'path', '--backup': 'path' });
        const database = opts.get('--db')!;
        const backup = opts.get('--backup')!;
        const bytes = readBytes(opts.get('--proposal')!, PROPOSAL_MAX_BYTES);
        const proposalSha256 = sha256Hex(bytes);
        const go = authorize(parse(readBytes(opts.get('--go')!, GO_MAX_BYTES)), 'bindings-approve', database, { proposalSha256 });
        if (typeof go.inventoryDigest !== 'string' || !HEX64.test(go.inventoryDigest)) return refuse();
        const approval = { proposalSha256, inventoryDigest: go.inventoryDigest, pairs: metalsBindingPairs(go.pairs) };
        const proposal = validMetalsBindingProposal(parse(bytes));
        if (!Buffer.from(serializeMetalsBindingProposal(proposal), 'utf8').equals(bytes)) throw new MetalsRefusal('metals-proposal-not-canonical');
        newPath(backup);
        const databaseRef = digest(path.resolve(database));
        const plan = await withDatabase(env, database, true, (db) => planMetalsBindingApproval(db, proposal, approval, databaseRef));
        if (plan.activated === 0) {
          print({ code: 'metals-bindings-already-active', goId: go.goId, proposalSha256, alreadyActive: plan.alreadyActive });
          return 0;
        }
        const receipt = await withDatabase(env, database, false, (db) => fencedMetalsWrite(db, backup, () => capture(() => approveMetalsBindings(db,
          proposal, approval, { now: now(), goId: go.goId, purpose: go.purpose as MetalsBindingPurpose, planDigest: plan.planDigest, databaseRef })),
        requireInstalled));
        const { planDigest: _digest, ...counts } = receipt;
        print({ ...counts, purpose: go.purpose, goId: go.goId });
        return 0;
      }
      if (subcommand === 'revoke') {
        const opts = options(more, { '--db': 'path', '--go': 'path', '--backup': 'path' });
        const database = opts.get('--db')!;
        const backup = opts.get('--backup')!;
        const go = authorize(parse(readBytes(opts.get('--go')!, GO_MAX_BYTES)), 'bindings-revoke', database);
        const bindingIds = metalsBindingIds(go.bindingIds);
        newPath(backup);
        const plan = await withDatabase(env, database, true, (db) => planMetalsBindingRevocation(db, bindingIds));
        if (plan.revoked === 0) {
          print({ code: 'metals-bindings-already-revoked', goId: go.goId, alreadyRevoked: plan.alreadyRevoked });
          return 0;
        }
        const receipt = await withDatabase(env, database, false, (db) => fencedMetalsWrite(db, backup, () => capture(() => revokeMetalsBindings(db,
          bindingIds, { now: now(), goId: go.goId, purpose: go.purpose as MetalsBindingPurpose, planDigest: plan.planDigest })), requireInstalled));
        const { planDigest: _digest, ...counts } = receipt;
        print({ ...counts, purpose: go.purpose, goId: go.goId });
        return 0;
      }
      return refuse();
    }
    if (command === 'report') {
      const database = options(rest, { '--db': 'path' }).get('--db')!;
      const result = await withSharedRead(env, database, (db) =>
        (metalsSchemaState(db) === 'conflict' ? 'conflict' as const : formatMetalsReport(metalsReport(db))));
      if (result === null) {
        io.stderr.write('holdr-metals: report-refused no-shared-lease\n');
        return 1;
      }
      if (result.value === 'conflict') {
        print({ code: 'metals-conflict', schema: 'conflict' });
        return 1;
      }
      if (result.value === null) {
        io.stderr.write('holdr-metals: report-refused value-shaped-output\n');
        return 1;
      }
      io.stdout.write(result.value);
      return 0;
    }
    if (command === METALS_VIEWS_REPORT_COMMAND) {
      const opts = options(rest, { '--db': 'path', '--out': 'path' });
      const database = opts.get('--db')!;
      const out = opts.get('--out')!;
      newPath(out); // the report's file: nothing there yet, in an existing directory
      const outDir = ownerOnlyOutputDir(out, access); // the output's real directory, checked owner-only before the database is opened
      const result = await withSharedRead(env, database, (db) => metalsViewsReport(db,
        { now: (context.now ?? (() => new Date()))(), databaseRef: digest(path.resolve(database)) }));
      if (result === null) {
        io.stderr.write(`holdr-metals: ${METALS_VIEWS_REPORT_COMMAND}-refused no-shared-lease\n`);
        return 1;
      }
      const rendered = renderMetalsViewsReport(result.value);
      if (rendered.line === null) {
        io.stderr.write(`holdr-metals: ${METALS_VIEWS_REPORT_COMMAND}-refused value-shaped-output\n`);
        return 1;
      }
      ownerOnlyOutputDir(out, access); // the real directory again, then the new empty file itself, before a byte is written
      asMetalsRefusal(() => writeOwnerOnlyNewFile(path.join(outDir, path.basename(out)), rendered.file, access));
      io.stdout.write(rendered.line);
      return rendered.failed ? 1 : 0;
    }
    if (command === 'identity-key') {
      const out = options(rest, { '--out': 'path' }).get('--out')!;
      newPath(out);
      const outDir = ownerOnlyOutputDir(out, access);
      const text = newMetalsIdentityKeyText();
      // The real directory again, then the new empty file itself, before a byte of the key is written.
      ownerOnlyOutputDir(out, access);
      asMetalsRefusal(() => writeOwnerOnlyNewFile(path.join(outDir, path.basename(out)), text, access));
      print({ code: 'metals-identity-key-written' });
      return 0;
    }
    if (command === 'identity-digest') {
      const opts = options(rest, { '--registry': 'path', '--identity-key': 'path', '--source': 'source', '--folder': 'folder' });
      const source = opts.get('--source') as MetalsSource;
      const folder = opts.get('--folder')!;
      if (!isMetalsFolder(source, folder)) return refuse();
      const key = readIdentityKey(opts.get('--identity-key')!, access);
      const entry = metalsRegisteredIdentity(readFolderRegistry(opts.get('--registry')!, access), source, folder);
      if (entry === null) throw new MetalsRefusal('metals-identity-unregistered');
      print({ code: 'metals-identity-digest', source, folder, identityDigest: metalsIdentityDigest(key, entry) });
      return 0;
    }
    if (command === 'identity-register') {
      const opts = options(rest, { '--registry': 'path', '--source': 'source', '--folder': 'folder' }, { '--from': 'path' });
      const source = opts.get('--source') as MetalsSource;
      const folder = opts.get('--folder')!;
      if (!isMetalsFolder(source, folder)) return refuse();
      const out = opts.get('--registry')!;
      newPath(out);
      const outDir = ownerOnlyOutputDir(out, access);
      const previous: MetalsFolderRegistry = opts.has('--from') ? readFolderRegistry(opts.get('--from')!, access) : { folders: [] };
      if (metalsRegisteredIdentity(previous, source, folder) !== null) throw new MetalsRefusal('metals-identity-already-registered');
      let identityLast4: string | null = null;
      if (source === 'costco') {
        const first = await readSecret('Costco membership last 4 (not shown)');
        const again = await readSecret('The same again (not shown)');
        if (!/^[0-9]{4}$/.test(first) || first !== again) throw new MetalsRefusal('metals-identity-entry-invalid');
        identityLast4 = first;
      }
      const text = serializeMetalsFolderRegistry({ folders: [...previous.folders, { source, folder, identityLast4 }] });
      const registry = parseMetalsFolderRegistry(Buffer.from(text, 'utf8'));
      ownerOnlyOutputDir(out, access);
      asMetalsRefusal(() => writeOwnerOnlyNewFile(path.join(outDir, path.basename(out)), text, access));
      print({ code: 'metals-identity-registered', source, folder, folders: registry.folders.length });
      return 0;
    }
    return refuse();
  } catch (error) {
    const refusal = error instanceof MetalsRefusal ? error : refused.error;
    if (refusal) {
      print({ code: refusal.code, ...refusal.details });
      return 1;
    }
    io.stderr.write(`holdr-metals: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
