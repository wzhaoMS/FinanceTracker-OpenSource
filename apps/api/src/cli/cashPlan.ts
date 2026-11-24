import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CARD_SCHEDULE_OBSERVATIONS_FORMAT,
  CARD_SCHEDULE_OBSERVATIONS_MAX_BYTES,
  CARD_SCHEDULE_OBSERVATIONS_MAX_ROWS,
  CARD_SCHEDULE_OBSERVATIONS_VERSION,
  validateCardScheduleObservation,
  type ValidCardScheduleObservation,
} from '@finance-tracker/shared';
import { openWriterDb } from '../control/writerDb.js';
import { configuredControlDir } from '../control/controlDir.js';
import { EXIT } from '../control/errors.js';
import { acquireSharedLease, assertNoLeaseEnv, leaseStillOn } from '../control/lifecycle.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import {
  CASH_PLAN_REFUSALS,
  CASH_PLAN_SCHEMA_DIGEST,
  cashPlanSchemaState,
  importCardScheduleObservations,
  installCashPlanSchema,
  type CashPlanSchemaState,
} from '../services/cashPlan.js';
import { cashPlanReport, formatCashPlanReport } from './cashPlanReport.js';

export const CASH_PLAN_CLI_USAGE = `Card payment schedule operator CLI (existing finance.db only)
  plan --db DB
  install --db DB --backup NEW_FILE --root-go ARTIFACT
  import --db DB --backup NEW_FILE --root-go ARTIFACT --observations FILE
  report --db DB
plan opens the database read-only, writes nothing, and prints whether the card_schedule_observations table (with its
index) is present, absent, or in conflict (another shape, or any other object of those names or on that table: exit 1),
with the schema digest and the database reference a GO must name.
install is the only way that table is created: the API never creates it, and answers installed:false without it. It
requires a Root GO (format holdr.cash-plan-go, version 1, command install) pinned to this database and this schema. The
GO, the arguments and the backup path are all checked before the database is opened for writing. A conflict is refused
before any backup. Otherwise install takes a new pre-write backup, then creates and verifies the table and its index in
one IMMEDIATE transaction, and writes nothing else. Once installed, every further install reports
cash-plan-already-installed, and takes no backup and writes nothing.
import appends card schedule observations from FILE (format holdr.card-schedule-observations, version 1, at most 1 MiB
and 5000 observations), validated strictly: one invalid observation refuses the whole file, naming its index and field,
never a value. It requires a Root GO (command import) pinned to this database, this schema and FILE's SHA-256
(inputSha256). Each observation binds to exactly one card of its issuer, last four or five digits and currency (and,
where its card reference names them, its owner and nickname, the nickname compared ignoring case and spacing), or is
held (unbound, ambiguous-card, invalid); nothing is guessed. An observation already stored (same card and payload digest)
is a duplicate and inserts nothing. A read-only preflight first: a file whose every observation is already stored reports
cash-plan-already-imported, with no backup and no write. Otherwise a new pre-write backup, then one IMMEDIATE transaction.
report opens the database read-only (query_only) under the writer's shared lease, writes nothing, and prints one line:
active cards, cards with a statement cycle, red and amber counts by rule, held observations and the newest financial
as-of date. Without a configured control dir (HOLDR_CONTROL_DIR) there is no lease to take, and it refuses
(report-refused no-shared-lease, exit 1). The line must pass a strict schema (digits only in counts and dates).
Single use: a GO is recorded nowhere; idempotency is the guarantee. All paths must be absolute. Output is codes,
digests and counts only.
`;
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest'];
const GO_PURPOSES = ['copy-rehearsal', 'production-install'];
const GO_MAX_BYTES = 64 * 1024;
const FILE_KEYS = ['format', 'observations', 'version'];
function refuse(): never { throw new HoldrRefusal('cash plan input refused'); }
/** An observation the validator refused: its index and field are value-free; the observation itself is never echoed. */
class ObservationRefusal extends HoldrRefusal {
  constructor(readonly index: number, readonly reason: string) { super('cash plan observation refused'); }
}
function readBytes(file: string, max: number): Buffer {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!path.isAbsolute(file) || !stat?.isFile() || stat.size > max) return refuse();
  const bytes = fs.readFileSync(file);
  if (bytes.length > max) return refuse();
  return bytes;
}
function parse(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return refuse(); }
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
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== [...keys].sort().join('|')) return refuse();
  return record;
}
/** The GO's fixed fields, checked before the database is opened. An import GO also pins the file's SHA-256. */
function authorize(input: unknown, command: 'install' | 'import', database: string, inputSha256: string | null): { purpose: string; goId: string } {
  const go = exactly(input, command === 'import' ? [...GO_KEYS, 'inputSha256'] : GO_KEYS);
  if (go.format !== 'holdr.cash-plan-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !GO_PURPOSES.includes(go.purpose) || go.command !== command
    || typeof go.goId !== 'string' || !/^[a-f0-9]{32}$/.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== CASH_PLAN_SCHEMA_DIGEST
    || (command === 'import' && go.inputSha256 !== inputSha256)) return refuse();
  return { purpose: go.purpose, goId: go.goId };
}
/** The import file, validated strictly: the whole file is refused at its first invalid observation. */
function validFile(input: unknown): ValidCardScheduleObservation[] {
  const file = exactly(input, FILE_KEYS);
  if (file.format !== CARD_SCHEDULE_OBSERVATIONS_FORMAT || file.version !== CARD_SCHEDULE_OBSERVATIONS_VERSION
    || !Array.isArray(file.observations) || file.observations.length === 0
    || file.observations.length > CARD_SCHEDULE_OBSERVATIONS_MAX_ROWS) return refuse();
  return file.observations.map((observation, index) => {
    const result = validateCardScheduleObservation(observation);
    if (!result.ok) throw new ObservationRefusal(index, result.reason);
    return result.value;
  });
}
async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    if (!readonly) handle.db.pragma('foreign_keys=ON');
    return await fn(handle.db);
  } finally { handle.close(); }
}
const readSchemaState = (env: NodeJS.ProcessEnv, database: string): Promise<CashPlanSchemaState> =>
  withDatabase(env, database, true, cashPlanSchemaState);
const backupTarget = (backup: string) => {
  if (fs.lstatSync(backup, { throwIfNoEntry: false })
    || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) refuse();
};

/**
 * The report, under the writer's shared lease or not at all: a control dir must be configured (HOLDR_CONTROL_DIR), its
 * shared `lifecycle.lock` taken with the marker `normal` (busy and maintenance refuse, as for every writer), and the lease
 * verified as still held before the database is opened read-only with `query_only`. Without a control dir it refuses:
 * `report-refused no-shared-lease`, exit 1.
 */
async function runReport(env: NodeJS.ProcessEnv, database: string, io: Io, now: Date): Promise<number> {
  assertNoLeaseEnv(env);
  const controlDir = configuredControlDir(env);
  const noLease = () => {
    io.stderr.write('cash-plan: report-refused no-shared-lease\n');
    return 1;
  };
  if (controlDir === null) return noLease();
  const lease = await acquireSharedLease(controlDir, { timeoutMs: 10_000, busyExit: EXIT.busy, maintenanceExit: EXIT.maintenance });
  try {
    if (!leaseStillOn(lease, controlDir)) return noLease();
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      db.pragma('busy_timeout = 10000');
      if (cashPlanSchemaState(db) === 'conflict') {
        io.stdout.write(JSON.stringify({ code: 'cash-plan-conflict', schema: 'conflict' }) + '\n');
        return 1;
      }
      const line = formatCashPlanReport(cashPlanReport(db, now));
      if (line === null) {
        io.stderr.write('cash-plan: report-refused value-shaped-output\n');
        return 1;
      }
      io.stdout.write(line);
      return 0;
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

export async function runCashPlanCli(args: string[], context: {
  env: NodeJS.ProcessEnv;
  io: Io;
  now?: () => Date;
}): Promise<number> {
  const { io } = context;
  const now = context.now ?? (() => new Date());
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(CASH_PLAN_CLI_USAGE); return 0; }
    if (command === 'plan') {
      const database = options(rest, ['--db']).get('--db')!;
      const schema = await readSchemaState(context.env, database);
      io.stdout.write(JSON.stringify({ code: schema === 'conflict' ? 'cash-plan-conflict' : 'cash-plan-planned', schema,
        schemaDigest: CASH_PLAN_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) }) + '\n');
      return schema === 'conflict' ? 1 : 0;
    }
    if (command === 'report') {
      const database = options(rest, ['--db']).get('--db')!;
      return await runReport(context.env, database, io, now());
    }
    if (command === 'install') {
      const opts = options(rest, ['--db', '--backup', '--root-go']);
      const database = opts.get('--db')!, backup = opts.get('--backup')!;
      const go = authorize(parse(readBytes(opts.get('--root-go')!, GO_MAX_BYTES)), 'install', database, null);
      backupTarget(backup);
      const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: CASH_PLAN_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) };
      // Read-only first: an installed table needs no backup and no write, and a conflict is refused before any backup.
      const schema = await readSchemaState(context.env, database);
      if (schema === 'present') {
        io.stdout.write(JSON.stringify({ code: 'cash-plan-already-installed', ...receipt }) + '\n');
        return 0;
      }
      if (schema === 'conflict') return refuse();
      await withDatabase(context.env, database, false, (db) => backedUpWrite(db, backup, () => receipt, installCashPlanSchema));
      io.stdout.write(JSON.stringify({ code: 'cash-plan-installed', ...receipt }) + '\n');
      return 0;
    }
    if (command !== 'import') return refuse();
    const opts = options(rest, ['--db', '--backup', '--root-go', '--observations']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!;
    const bytes = readBytes(opts.get('--observations')!, CARD_SCHEDULE_OBSERVATIONS_MAX_BYTES);
    const inputSha256 = createHash('sha256').update(bytes).digest('hex');
    const go = authorize(parse(readBytes(opts.get('--root-go')!, GO_MAX_BYTES)), 'import', database, inputSha256);
    const observations = validFile(parse(bytes));
    backupTarget(backup);
    const importRef = `sha256:${inputSha256}`;
    const at = now().toISOString();
    // Read-only preflight: the table must be installed; a file already imported in full needs no backup and no write.
    const preview = await withDatabase(context.env, database, true, (db) => {
      if (cashPlanSchemaState(db) !== 'present') throw new HoldrRefusal(CASH_PLAN_REFUSALS.notInstalled);
      return importCardScheduleObservations(db, observations, { importRef, now: at, dryRun: true });
    });
    if (preview.inserted === 0) {
      io.stdout.write(JSON.stringify({ code: 'cash-plan-already-imported', goId: go.goId, inputSha256, ...preview }) + '\n');
      return 0;
    }
    const summary = await withDatabase(context.env, database, false, (db) => backedUpWrite(db, backup,
      () => importCardScheduleObservations(db, observations, { importRef, now: at }), installCashPlanSchemaIfPresent));
    io.stdout.write(JSON.stringify({ code: 'cash-plan-imported', goId: go.goId, inputSha256, ...summary }) + '\n');
    return 0;
  } catch (error) {
    if (error instanceof ObservationRefusal) {
      io.stderr.write(`cash-plan: input-refused observation ${error.index} ${error.reason}\n`);
      return 1;
    }
    io.stderr.write(`cash-plan: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}

/** The import never creates the table: inside its transaction it only re-checks the schema is this build's. */
function installCashPlanSchemaIfPresent(db: Database.Database): void {
  if (cashPlanSchemaState(db) !== 'present') throw new HoldrRefusal(CASH_PLAN_REFUSALS.notInstalled);
}
