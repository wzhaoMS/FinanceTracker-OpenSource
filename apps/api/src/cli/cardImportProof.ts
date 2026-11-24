import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import {
  installProofSchema, PROOF_RECEIPTS_TABLE, PROOF_SCHEMA_DIGEST, proofSchemaState, type ProofSchemaState,
} from '../services/cardImport/proof/schema.js';
import {
  livePermit, PERMIT_GLOBAL, PERMIT_LIVE_MODES, PERMIT_STOP_REASONS, permitTime, readPermitRows, stopPermit, stoppingLabel,
  type PermitMode, type PermitStopReason,
} from '../services/cardImport/proof/permit.js';
import { assertProofReceipt } from '../services/cardImport/proof/receipt.js';

export const CARD_IMPORT_PROOF_CLI_USAGE = `Card import pre-commit proof operator CLI (W4; existing finance.db only)
  plan --db DB
  install --db DB --backup NEW_FILE --root-go ARTIFACT
  permit status --db DB
  permit stop --db DB --scope all|ISSUER --reason consent-off|holdr-off|operator-stop|latch --declared-at ISO_UTC
  permit live --db DB --scope all|ISSUER --mode daily-interim|auto --root-go ARTIFACT
  receipts --db DB --since ISO_UTC
plan opens the database read-only and prints whether the proof's tables are present, absent or in conflict (exit 1),
with the schema digest and the database reference a GO must name.
install is the only way those tables are created; the API never creates them, and without them every proof request
holds. It requires a Root GO (format holdr.card-import-proof-go, version 1, command install) pinned to this database and
this schema, checked before the database is opened for writing. A conflict is refused before any backup. Otherwise it
takes a new pre-write backup, then creates and verifies the tables in one IMMEDIATE transaction. Once installed, a
further install reports card-import-proof-already-installed and writes nothing. The LIVE PERMIT starts dead.
permit status is read-only: every permit row's scope, state, mode, generation and reason.
permit stop makes the scope's permit dead. It needs no GO and is always allowed: W2's STOP procedure runs it in every
STOP path, with the time the STOP was declared. It is never refused for that time: one more than 120 s ahead of this
clock is recorded as when the generation it ends went live (declaredAtClamped), so every receipt of that generation is
labelled. It waits up to 120 s for Holdr's lifecycle lease (then exit 75; exit 3 in maintenance: run it again), then for
any proof transaction in flight, and prints the row as read
back after its commit (permit-stop-applied); that generation is what W16 records. It is step (a) of STOPPING-PENDING
only: the STOP is complete when W16 has this generation and every job in flight has a proven outcome.
permit live makes the scope's permit live in the GO's mode: only under a Root GO (command permit-live) naming this
database, the scope and the mode. A GO is used once.
receipts is read-only: one line per proof receipt committed at or after --since, with its label (committed, or
committed-during-stopping: an automatic job that committed after a later STOP on its scope was declared).
--scope all is the global row (*). All paths must be absolute. Output is codes, counts, dates and digests only.
`;

const GO_MAX_BYTES = 64 * 1024;
/** How long a STOP waits for Holdr's lifecycle lease (a launcher restart, a restore) before exit 75; others wait 10 s. */
const STOP_LEASE_WAIT_MS = 120_000;
const GO_PURPOSES = ['copy-rehearsal', 'production-install', 'production-permit'];
const INSTALL_GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest'];
const LIVE_GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'scope', 'mode'];
const PATH_FLAGS = new Set(['--db', '--backup', '--root-go']);

function refuse(): never { throw new HoldrRefusal('card import proof input refused'); }

function options(args: string[], expected: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!expected.includes(flag) || result.has(flag) || !value || (PATH_FLAGS.has(flag) && !path.isAbsolute(value))) return refuse();
    result.set(flag, value);
  }
  if (result.size !== expected.length) return refuse();
  return result;
}

function readGo(file: string): Record<string, unknown> {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > GO_MAX_BYTES) return refuse();
  const bytes = fs.readFileSync(file);
  if (bytes.length > GO_MAX_BYTES) return refuse();
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return refuse(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
}

/** The GO's fixed fields, checked before the database is opened. */
function authorize(go: Record<string, unknown>, keys: readonly string[], command: string, database: string): { purpose: string; goId: string } {
  if (Object.keys(go).sort().join('|') !== [...keys].sort().join('|')) return refuse();
  if (go.format !== 'holdr.card-import-proof-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !GO_PURPOSES.includes(go.purpose) || go.command !== command
    || typeof go.goId !== 'string' || !/^[a-f0-9]{32}$/.test(go.goId) || go.databaseRef !== digest(path.resolve(database))) return refuse();
  return { purpose: go.purpose, goId: go.goId };
}

const scopeOf = (value: string): string => (value === 'all' || value === PERMIT_GLOBAL ? PERMIT_GLOBAL : value);

async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>, options: { leaseTimeoutMs?: number } = {}): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }), { timeoutMs: options.leaseTimeoutMs });
  try {
    if (readonly) handle.db.pragma('query_only = ON');
    else handle.db.pragma('foreign_keys=ON');
    // A permit write waits for a proof transaction in flight: its deadline is at most 60 s out.
    handle.db.pragma('busy_timeout = 90000');
    return await fn(handle.db);
  } finally { handle.close(); }
}

function requirePresent(db: Database.Database): void {
  const state: ProofSchemaState = proofSchemaState(db);
  if (state !== 'present') throw new HoldrRefusal(`the card import proof tables are ${state}`);
}

function listReceipts(db: Database.Database, since: string, io: Io): number {
  requirePresent(db);
  const lines: Array<Record<string, unknown>> = [];
  for (const row of db.prepare(`SELECT receipt_json AS json FROM ${PROOF_RECEIPTS_TABLE}`).iterate() as Iterable<{ json: string }>) {
    const receipt: unknown = JSON.parse(row.json);
    assertProofReceipt(receipt);
    if (receipt.committedAt < since) continue;
    lines.push({ job: receipt.jobId.slice(0, 8), mode: receipt.mode, route: receipt.route, outcome: receipt.outcome,
      committedAt: receipt.committedAt, permit: receipt.permit, label: stoppingLabel(db, receipt) });
  }
  lines.sort((a, b) => String(a.committedAt).localeCompare(String(b.committedAt)));
  for (const line of lines) io.stdout.write(JSON.stringify(line) + '\n');
  io.stdout.write(JSON.stringify({ code: 'card-import-proof-receipts', since, count: lines.length,
    committedDuringStopping: lines.filter((line) => line.label === 'committed-during-stopping').length }) + '\n');
  return 0;
}

export async function runCardImportProofCli(args: string[], context: {
  env: NodeJS.ProcessEnv;
  io: Io;
  now?: () => Date;
}): Promise<number> {
  const { io, env } = context;
  const now = context.now ?? (() => new Date());
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(CARD_IMPORT_PROOF_CLI_USAGE); return 0; }
    if (command === 'plan') {
      const database = options(rest, ['--db']).get('--db')!;
      const schema = await withDatabase(env, database, true, proofSchemaState);
      io.stdout.write(JSON.stringify({
        code: schema === 'conflict' ? 'card-import-proof-conflict' : 'card-import-proof-planned', schema,
        schemaDigest: PROOF_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)),
      }) + '\n');
      return schema === 'conflict' ? 1 : 0;
    }
    if (command === 'install') {
      const opts = options(rest, ['--db', '--backup', '--root-go']);
      const database = opts.get('--db')!, backup = opts.get('--backup')!;
      const go = readGo(opts.get('--root-go')!);
      const { purpose, goId } = authorize(go, INSTALL_GO_KEYS, 'install', database);
      if (go.schemaDigest !== PROOF_SCHEMA_DIGEST) return refuse();
      if (fs.lstatSync(backup, { throwIfNoEntry: false })
        || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) return refuse();
      const receipt = { purpose, goId, schemaDigest: PROOF_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) };
      // Read-only first: installed tables need no backup and no write, and a conflict is refused before any backup.
      const schema = await withDatabase(env, database, true, proofSchemaState);
      if (schema === 'present') {
        io.stdout.write(JSON.stringify({ code: 'card-import-proof-already-installed', ...receipt }) + '\n');
        return 0;
      }
      if (schema === 'conflict') return refuse();
      await withDatabase(env, database, false, (db) => backedUpWrite(db, backup, () => receipt, installProofSchema));
      io.stdout.write(JSON.stringify({ code: 'card-import-proof-installed', ...receipt }) + '\n');
      return 0;
    }
    if (command === 'receipts') {
      const opts = options(rest, ['--db', '--since']);
      const since = permitTime(opts.get('--since')!);
      return await withDatabase(env, opts.get('--db')!, true, (db) => listReceipts(db, since, io));
    }
    if (command !== 'permit') return refuse();
    const [action, ...permitArgs] = rest;
    if (action === 'status') {
      const database = options(permitArgs, ['--db']).get('--db')!;
      const rows = await withDatabase(env, database, true, (db) => { requirePresent(db); return readPermitRows(db); });
      io.stdout.write(JSON.stringify({ code: 'card-import-proof-permit-status',
        rows: rows.map((row) => ({ scope: row.issuer, state: row.state, mode: row.mode, generation: row.generation, reason: row.reason,
          changedAt: row.changedAt })) }) + '\n');
      return 0;
    }
    if (action === 'stop') {
      const opts = options(permitArgs, ['--db', '--scope', '--reason', '--declared-at']);
      const reason = opts.get('--reason') as PermitStopReason;
      if (!PERMIT_STOP_REASONS.includes(reason)) return refuse();
      const row = await withDatabase(env, opts.get('--db')!, false, (db) => {
        requirePresent(db);
        return stopPermit(db, scopeOf(opts.get('--scope')!), reason, opts.get('--declared-at')!, now());
      }, { leaseTimeoutMs: STOP_LEASE_WAIT_MS });
      // "Applied" is step (a) of STOPPING-PENDING only: the STOP is complete when W16 has this generation and every
      // in-flight job's outcome is proven, never on this line or a receipt's label alone.
      io.stdout.write(JSON.stringify({ code: 'permit-stop-applied', scope: row.issuer, state: row.state, generation: row.generation,
        reason: row.reason, declaredAt: row.declaredAt, declaredAtClamped: row.declaredAtClamped }) + '\n');
      return 0;
    }
    if (action === 'live') {
      const opts = options(permitArgs, ['--db', '--scope', '--mode', '--root-go']);
      const database = opts.get('--db')!, scope = scopeOf(opts.get('--scope')!), mode = opts.get('--mode') as PermitMode;
      if (!PERMIT_LIVE_MODES.includes(mode)) return refuse();
      const go = readGo(opts.get('--root-go')!);
      const { goId } = authorize(go, LIVE_GO_KEYS, 'permit-live', database);
      if (go.scope !== scope || go.mode !== mode) return refuse();
      const row = await withDatabase(env, database, false, (db) => {
        requirePresent(db);
        return livePermit(db, scope, mode, goId, now());
      });
      io.stdout.write(JSON.stringify({ code: 'permit-live', scope: row.issuer, state: row.state, mode: row.mode,
        generation: row.generation, goId }) + '\n');
      return 0;
    }
    return refuse();
  } catch (error) {
    io.stderr.write(`card-import-proof: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
