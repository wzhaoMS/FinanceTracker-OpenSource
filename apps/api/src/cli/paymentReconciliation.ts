import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import { configuredControlDir } from '../control/controlDir.js';
import { EXIT } from '../control/errors.js';
import { acquireSharedLease, assertNoLeaseEnv, leaseStillOn } from '../control/lifecycle.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import { CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST, cardPaymentDecisionsSchemaState, installCardPaymentDecisionsSchema,
  type CardPaymentDecisionsSchemaState } from '../services/cardPaymentDecisions.js';
import { formatPaymentReconciliationReport, paymentReconciliationReport } from './paymentReconciliationReport.js';

export const PAYMENT_RECONCILIATION_CLI_USAGE = `Card payment reconciliation operator CLI (existing finance.db only)
  plan --db DB
  report --db DB
  install --db DB --backup NEW_FILE --root-go ARTIFACT
plan opens the database read-only, writes nothing, and prints whether the card_payment_decisions table (with its
indexes) is present, absent, or in conflict (another shape, or any other object of those names or on that table:
exit 1), with the schema digest and the database reference a GO must name.
report opens the database read-only (query_only) under the writer's shared lease, writes nothing, and reconciles the
rows the API reads under this build's rules: the dry run. Without a configured control dir (HOLDR_CONTROL_DIR) there is
no lease to take, and it refuses (report-refused no-shared-lease, exit 1); busy and maintenance refuse as for every
writer. It prints one JSON line of counts, dates, issuers, banks, account last fours and rule words only: what became of
each group the rules alone hold for the owner (interchangeable rows, payer references), the pairs version 3 matched that
this one does not, the pulls netted with their unpaid return, independent re-checks of every pair the rules matched
(conflicts, each 0), the payments with no checking debit (why, coverage, the card's status and last activity) and the
debits with no card payment by issuer. The line must pass a strict schema (digits only in counts, dates and account last
fours) or it is refused (exit 1), as is a decisions table in another shape.
install is the only way that table is created: the API never creates it, and matches card payments with checking
debits without it (owner decisions then answer 409). It requires a Root GO (format holdr.payment-reconciliation-go,
version 1, command install) pinned to this database and this schema. The GO, the arguments and the backup path are
all checked before the database is opened for writing. A conflict is refused before any backup. Otherwise install
takes a new pre-write backup, then creates and verifies the table and its indexes in one IMMEDIATE transaction, and
writes nothing else.
Single use: the GO is recorded nowhere. Once the table is installed, every further install reports
payment-reconciliation-already-installed, and takes no backup and writes nothing. That is the idempotency guarantee.
All paths must be absolute. Output is codes and digests only.
`;
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest'];
const GO_PURPOSES = ['copy-rehearsal', 'production-install'];
const GO_MAX_BYTES = 64 * 1024;
function refuse(): never { throw new HoldrRefusal('payment reconciliation input refused'); }
function readJson(file: string): unknown {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!path.isAbsolute(file) || !stat?.isFile() || stat.size > GO_MAX_BYTES) return refuse();
  const bytes = fs.readFileSync(file);
  if (bytes.length > GO_MAX_BYTES) return refuse();
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
/** The GO's fixed fields, checked before the database is opened. */
function authorize(input: unknown, database: string): { purpose: string; goId: string } {
  const go = exactly(input, GO_KEYS);
  if (go.format !== 'holdr.payment-reconciliation-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !GO_PURPOSES.includes(go.purpose) || go.command !== 'install'
    || typeof go.goId !== 'string' || !/^[a-f0-9]{32}$/.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST) return refuse();
  return { purpose: go.purpose, goId: go.goId };
}
async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    if (!readonly) handle.db.pragma('foreign_keys=ON');
    return await fn(handle.db);
  } finally { handle.close(); }
}
const readSchemaState = (env: NodeJS.ProcessEnv, database: string): Promise<CardPaymentDecisionsSchemaState> =>
  withDatabase(env, database, true, cardPaymentDecisionsSchemaState);

/**
 * The dry run, under the writer's shared lease or not at all: a control dir must be configured (HOLDR_CONTROL_DIR), its
 * shared `lifecycle.lock` taken with the marker `normal` (busy and maintenance refuse, as for every writer), and the lease
 * verified as still held on that lock before the database is opened read-only with `query_only`. Without a control dir
 * there is no lease to take, so it refuses: `report-refused no-shared-lease`, exit 1.
 */
async function runReport(env: NodeJS.ProcessEnv, database: string, io: Io): Promise<number> {
  assertNoLeaseEnv(env);
  const controlDir = configuredControlDir(env);
  const noLease = () => {
    io.stderr.write('payment-reconciliation: report-refused no-shared-lease\n');
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
      if (cardPaymentDecisionsSchemaState(db) === 'conflict') {
        io.stdout.write(JSON.stringify({ code: 'payment-reconciliation-conflict', schema: 'conflict' }) + '\n');
        return 1;
      }
      const line = formatPaymentReconciliationReport(paymentReconciliationReport(db));
      if (line === null) {
        io.stderr.write('payment-reconciliation: report-refused value-shaped-output\n');
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
export async function runPaymentReconciliationCli(args: string[], context: {
  env: NodeJS.ProcessEnv;
  io: Io;
  now?: () => Date;
}): Promise<number> {
  const { io } = context;
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(PAYMENT_RECONCILIATION_CLI_USAGE); return 0; }
    if (command === 'plan') {
      const database = options(rest, ['--db']).get('--db')!;
      const schema = await readSchemaState(context.env, database);
      io.stdout.write(JSON.stringify({
        code: schema === 'conflict' ? 'payment-reconciliation-conflict' : 'payment-reconciliation-planned', schema,
        schemaDigest: CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)),
      }) + '\n');
      return schema === 'conflict' ? 1 : 0;
    }
    if (command === 'report') {
      const database = options(rest, ['--db']).get('--db')!;
      return await runReport(context.env, database, io);
    }
    if (command !== 'install') return refuse();
    const opts = options(rest, ['--db', '--backup', '--root-go']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!;
    const go = authorize(readJson(opts.get('--root-go')!), database);
    if (fs.lstatSync(backup, { throwIfNoEntry: false })
      || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) return refuse();
    const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST,
      databaseRef: digest(path.resolve(database)) };
    // Read-only first: an installed table needs no backup and no write, and a conflict is refused before any backup.
    const schema = await readSchemaState(context.env, database);
    if (schema === 'present') {
      io.stdout.write(JSON.stringify({ code: 'payment-reconciliation-already-installed', ...receipt }) + '\n');
      return 0;
    }
    if (schema === 'conflict') return refuse();
    // The pre-write backup, then the table created and verified in one IMMEDIATE transaction.
    await withDatabase(context.env, database, false, db => backedUpWrite(db, backup, () => receipt, installCardPaymentDecisionsSchema));
    io.stdout.write(JSON.stringify({ code: 'payment-reconciliation-installed', ...receipt }) + '\n');
    return 0;
  } catch (error) {
    io.stderr.write(`payment-reconciliation: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
