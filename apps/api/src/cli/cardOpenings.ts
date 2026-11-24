import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import { CARD_OPENING_MONTHS_SCHEMA_DIGEST, cardOpeningMonthsInForce, cardOpeningMonthsSchemaState, installCardOpeningMonthsSchema,
  listCardOpeningMonths, type CardOpeningMonthsSchemaState } from '../services/cardOpeningMonths.js';

export const CARD_OPENINGS_CLI_USAGE = `Card opening months operator CLI (existing finance.db only)
  plan --db DB
  install --db DB --backup NEW_FILE --root-go ARTIFACT
plan opens the database read-only, writes nothing, and prints whether the card_opening_months table is present,
absent, or in conflict (another table, index, view or trigger of that name: exit 1), how many card accounts there
are and, once it is present, how many have an opening month in force, with the schema digest and the database
reference a GO must name.
install is the only way that table is created: the API never creates it, and works without it. It requires a Root
GO (format holdr.card-openings-go, version 1, command install) pinned to this database and this schema. The GO,
the arguments and the backup path are all checked before the database is opened for writing. A conflict is refused
before any backup. Otherwise install takes a new pre-write backup, then creates and verifies the table in one
IMMEDIATE transaction, and writes nothing else.
Single use: the GO is recorded nowhere. Once the table is installed, every further install reports
card-openings-already-installed, and takes no backup and writes nothing. That is the idempotency guarantee.
All paths must be absolute. Output is codes, counts and digests only.
`;
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest'];
const GO_PURPOSES = ['copy-rehearsal', 'production-install'];
const GO_MAX_BYTES = 64 * 1024;
function refuse(): never { throw new HoldrRefusal('card openings input refused'); }
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
  if (go.format !== 'holdr.card-openings-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !GO_PURPOSES.includes(go.purpose) || go.command !== 'install'
    || typeof go.goId !== 'string' || !/^[a-f0-9]{32}$/.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== CARD_OPENING_MONTHS_SCHEMA_DIGEST) return refuse();
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
const readSchemaState = (env: NodeJS.ProcessEnv, database: string): Promise<CardOpeningMonthsSchemaState> =>
  withDatabase(env, database, true, cardOpeningMonthsSchemaState);
/** Read-only: the schema, how many card accounts there are, and how many have a month in force once it is present. */
const readPlan = (env: NodeJS.ProcessEnv, database: string) => withDatabase(env, database, true, (db) => {
  const schema = cardOpeningMonthsSchemaState(db);
  const cards = db.prepare('SELECT count(*) FROM main.card_accounts').pluck().get() as number;
  return { schema, cards, ...(schema === 'present' ? { confirmed: cardOpeningMonthsInForce(listCardOpeningMonths(db)).size } : {}) };
});
export async function runCardOpeningsCli(args: string[], context: {
  env: NodeJS.ProcessEnv;
  io: Io;
  now?: () => Date;
}): Promise<number> {
  const { io } = context;
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(CARD_OPENINGS_CLI_USAGE); return 0; }
    if (command === 'plan') {
      const database = options(rest, ['--db']).get('--db')!;
      const { schema, ...counts } = await readPlan(context.env, database);
      io.stdout.write(JSON.stringify({ code: schema === 'conflict' ? 'card-openings-conflict' : 'card-openings-planned', schema,
        ...counts, schemaDigest: CARD_OPENING_MONTHS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) }) + '\n');
      return schema === 'conflict' ? 1 : 0;
    }
    if (command !== 'install') return refuse();
    const opts = options(rest, ['--db', '--backup', '--root-go']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!;
    const go = authorize(readJson(opts.get('--root-go')!), database);
    if (fs.lstatSync(backup, { throwIfNoEntry: false })
      || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) return refuse();
    const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: CARD_OPENING_MONTHS_SCHEMA_DIGEST,
      databaseRef: digest(path.resolve(database)) };
    // Read-only first: an installed table needs no backup and no write, and a conflict is refused before any backup.
    const schema = await readSchemaState(context.env, database);
    if (schema === 'present') {
      io.stdout.write(JSON.stringify({ code: 'card-openings-already-installed', ...receipt }) + '\n');
      return 0;
    }
    if (schema === 'conflict') return refuse();
    // The pre-write backup, then the table created and verified in one IMMEDIATE transaction.
    await withDatabase(context.env, database, false, db => backedUpWrite(db, backup, () => receipt, installCardOpeningMonthsSchema));
    io.stdout.write(JSON.stringify({ code: 'card-openings-installed', ...receipt }) + '\n');
    return 0;
  } catch (error) {
    io.stderr.write(`card-openings: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
