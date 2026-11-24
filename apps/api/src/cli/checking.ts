import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { summarizeCheckingImport } from '@finance-tracker/shared';

import { openWriterDb } from '../control/writerDb.js';
import { digest } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import {
  CheckingImportRefusal,
  importCheckingPayload,
  planCheckingImport,
  validCheckingPayload,
  type CheckingImportPurpose,
} from '../services/checking/importer.js';
import { CHECKING_SCHEMA_DIGEST, checkingSchemaState, installCheckingSchema, requireCheckingSchema, type CheckingSchemaState } from '../services/checking/schema.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import type { Io } from './controlCommon.js';

export const CHECKING_CLI_USAGE = `Checking accounts operator CLI (existing finance.db only)
  plan --db DB [--input PAYLOAD]
  install --db DB --backup NEW_FILE --root-go ARTIFACT
  import --db DB --input PAYLOAD --backup NEW_FILE --root-go ARTIFACT
plan opens the database read-only and writes nothing. It prints whether the checking tables are present, absent or in
conflict (exit 1), the schema digest and the database reference a GO must name. With --input it validates the
payload (holdr.checking-import v1, from holdr-checking-convert), prints its digest (the GO's inputDigest) and, when the
tables are present, what the import would do (counts and dates) or the refusal it would meet.
install is the only way the checking tables are created: the API never creates them, and works without them. It
requires a Root GO (format holdr.checking-go, version 1, command install) pinned to this database and this schema.
A conflict is refused before any backup; tables already installed take no backup and write nothing. Otherwise it
takes a new pre-write backup, then creates and verifies the tables in one IMMEDIATE transaction.
import requires the installed tables and a Root GO (command import) pinned to this database, this schema and the
payload's digest. The GO, the payload and the whole import are checked read-only first: a payload already imported,
or one the import would refuse, takes no backup and writes nothing. Otherwise it takes a new pre-write backup, then
imports in one IMMEDIATE transaction that checks everything again. Nothing is ever updated or deleted.
A GO names one payload's digest, so it authorizes that payload only; its goId is recorded with the import.
All paths must be absolute. Output is codes, counts, dates and digests only.
`;

const GO_MAX_BYTES = 64 * 1024;
const PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const GO_PURPOSES: Record<'install' | 'import', readonly string[]> = {
  install: ['copy-rehearsal', 'production-install'],
  import: ['copy-rehearsal', 'production-import'],
};

function refuse(): never {
  throw new HoldrRefusal('checking input refused');
}

function readJson(file: string, maxBytes: number): unknown {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!path.isAbsolute(file) || !stat?.isFile() || stat.size > maxBytes) return refuse();
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxBytes) return refuse();
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse();
  }
}

function options(args: string[], required: readonly string[], optional: readonly string[] = []): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (![...required, ...optional].includes(args[i]) || result.has(args[i]) || !value || !path.isAbsolute(value)) return refuse();
    result.set(args[i], value);
  }
  if (required.some((name) => !result.has(name))) return refuse();
  return result;
}

function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== [...keys].sort().join('|')) return refuse();
  return record;
}

/** The GO's fixed fields, compared strictly by type and value, before the database is opened. */
function authorize(input: unknown, command: 'install' | 'import', database: string, payload: unknown): { purpose: string; goId: string } {
  const keys = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest',
    ...(command === 'import' ? ['inputDigest'] : [])];
  const go = exactly(input, keys);
  if (go.format !== 'holdr.checking-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !GO_PURPOSES[command].includes(go.purpose) || go.command !== command
    || typeof go.goId !== 'string' || !/^[a-f0-9]{32}$/.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== CHECKING_SCHEMA_DIGEST
    || (command === 'import' && go.inputDigest !== digest(payload))) return refuse();
  return { purpose: go.purpose, goId: go.goId };
}

async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean, fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    if (readonly) handle.db.pragma('query_only = ON');
    else handle.db.pragma('foreign_keys=ON');
    return await fn(handle.db);
  } finally {
    handle.close();
  }
}

function newBackupPath(backup: string): void {
  if (fs.lstatSync(backup, { throwIfNoEntry: false }) || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) refuse();
}

function refusalOutput(error: CheckingImportRefusal): Record<string, unknown> {
  return { code: error.code, ...error.details };
}

export async function runCheckingCli(args: string[], context: { env: NodeJS.ProcessEnv; io: Io; now?: () => Date }): Promise<number> {
  const { io } = context;
  const print = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  // A refusal met inside the backed-up transaction leaves it as a value-free database error; its code is kept here.
  const refused: { error?: CheckingImportRefusal } = {};
  try {
    const [command, ...rest] = args;
    if (command === '--help') {
      io.stdout.write(CHECKING_CLI_USAGE);
      return 0;
    }
    if (command === 'plan') {
      const opts = options(rest, ['--db'], ['--input']);
      const database = opts.get('--db')!;
      const payload = opts.has('--input') ? validCheckingPayload(readJson(opts.get('--input')!, PAYLOAD_MAX_BYTES)) : null;
      const result = await withDatabase(context.env, database, true, (db) => {
        const schema: CheckingSchemaState = checkingSchemaState(db);
        const out: Record<string, unknown> = {
          code: schema === 'conflict' ? 'checking-schema-conflict' : 'checking-planned', schema,
          schemaDigest: CHECKING_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)),
        };
        if (payload) {
          const summary = summarizeCheckingImport(payload);
          out.input = { inputDigest: digest(payload), institution: payload.account.institution, last4: payload.account.last4, ...summary };
          if (schema === 'present') {
            try {
              out.import = planCheckingImport(db, payload);
            } catch (error) {
              if (!(error instanceof CheckingImportRefusal)) throw error;
              out.import = refusalOutput(error);
            }
          }
        }
        return out;
      });
      print(result);
      return result.code === 'checking-schema-conflict' ? 1 : 0;
    }
    if (command === 'install') {
      const opts = options(rest, ['--db', '--backup', '--root-go']);
      const database = opts.get('--db')!, backup = opts.get('--backup')!;
      const go = authorize(readJson(opts.get('--root-go')!, GO_MAX_BYTES), 'install', database, null);
      newBackupPath(backup);
      const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: CHECKING_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) };
      const schema = await withDatabase(context.env, database, true, checkingSchemaState);
      if (schema === 'present') {
        print({ code: 'checking-already-installed', ...receipt });
        return 0;
      }
      if (schema === 'conflict') return refuse();
      await withDatabase(context.env, database, false, (db) => backedUpWrite(db, backup, () => receipt, installCheckingSchema));
      print({ code: 'checking-installed', ...receipt });
      return 0;
    }
    if (command !== 'import') return refuse();
    const opts = options(rest, ['--db', '--input', '--backup', '--root-go']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!;
    const input = readJson(opts.get('--input')!, PAYLOAD_MAX_BYTES);
    const payload = validCheckingPayload(input);
    const go = authorize(readJson(opts.get('--root-go')!, GO_MAX_BYTES), 'import', database, payload);
    newBackupPath(backup);
    // Read-only first: not installed, already imported, or refused all end here, before any backup.
    const plan = await withDatabase(context.env, database, true, (db) => {
      requireCheckingSchema(db);
      return planCheckingImport(db, payload);
    });
    if (plan.alreadyImported) {
      print({ code: 'checking-already-imported', goId: go.goId, ...plan });
      return 0;
    }
    const now = (context.now ?? (() => new Date()))().toISOString();
    const receipt = await withDatabase(context.env, database, false, (db) => backedUpWrite(db, backup, () => {
      try {
        return importCheckingPayload(db, payload, { now, goId: go.goId, purpose: go.purpose as CheckingImportPurpose });
      } catch (error) {
        if (error instanceof CheckingImportRefusal) refused.error = error;
        throw error;
      }
    }, requireCheckingSchema));
    print({ ...receipt, purpose: go.purpose, goId: go.goId });
    return 0;
  } catch (error) {
    const refusal = error instanceof CheckingImportRefusal ? error : refused.error;
    if (refusal) {
      print(refusalOutput(refusal));
      return 1;
    }
    io.stderr.write(`holdr-checking: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
