import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { configuredControlDir } from '../control/controlDir.js';
import { EXIT } from '../control/errors.js';
import { acquireSharedLease, assertNoLeaseEnv, leaseStillOn } from '../control/lifecycle.js';
import { openWriterDb } from '../control/writerDb.js';
import { assertOwnerOnlyDirectory, isWindowsAliasName, OutputRefusal, type OutputAccess, type OutputRefusalCode } from './ownerOnlyOutput.js';

/**
 * The operator CLIs' domain-neutral safety primitives (holdr-metals; holdr-retail from Costco PR 2): an input file read
 * within bounds, its JSON, an exact key set, `--name value` options, a new output path, an owner-only output directory,
 * and three database handles (the writer's, a read-only `query_only` one, and a read under the writer's shared lease).
 * Moved from cli/metals.ts (Costco plan v5 §12, Q-D1), unchanged but for two tightenings metals can't reach: `exactKeys`
 * compares key by key, and `newOutputPath` also requires an absolute path. Since ROOT's 11/09 rule, `newOutputPath`
 * refuses a name Windows reads as another file or a device too (`output-name-refused`). Every refusal is the caller's
 * own, made by its refusal mapper, so each domain keeps its codes (`metals-…`, `retail-…`). Each domain's GO checker,
 * commands and purposes stay local, a thin typed adapter over `exactKeys`. Not a CLI framework: no commands, no
 * dispatch, no output.
 */

/** How a caller refuses, as its own value-free errors. */
export interface OperatorRefusals {
  /** A path, a file, JSON text, a key set or an option that fails its check. */
  input(): Error;
  /** An output place the owner-only check or the name rule refuses (ownerOnlyOutput.ts), by its closed code. */
  output(code: OutputRefusalCode): Error;
}

/** An input file's bytes: an absolute path to a regular file (never a link), at most `max` bytes, checked and as read. */
export function readInputFile(file: string, max: number, refusals: OperatorRefusals): Buffer {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!path.isAbsolute(file) || !stat?.isFile() || stat.size > max) throw refusals.input();
  const bytes = fs.readFileSync(file);
  if (bytes.length > max) throw refusals.input();
  return bytes;
}

/** JSON text, decoded as UTF-8. */
export function parseJson(bytes: Buffer, refusals: OperatorRefusals): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw refusals.input();
  }
}

/**
 * A plain object with exactly `keys`, in any order: none missing, none more. Compared key by key, so no key can stand for
 * two. Each value's type and value are the caller's to check.
 */
export function exactKeys(value: unknown, keys: readonly string[], refusals: OperatorRefusals): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusals.input();
  const record = value as Record<string, unknown>;
  const given = Object.keys(record).sort();
  const wanted = [...keys].sort();
  if (given.length !== wanted.length || given.some((key, index) => key !== wanted[index])) throw refusals.input();
  return record;
}

/** One option's value check, the caller's: an absolute path, an id of its shape, one of its words. */
export type OptionCheck = (value: string) => boolean;

/**
 * `--name value` pairs: every name declared (required or optional) and given once, every value passing its check, and
 * every required name present. Nothing else: no name without a value, no positional argument.
 */
export function parseOptions(args: readonly string[], required: Readonly<Record<string, OptionCheck>>,
  optional: Readonly<Record<string, OptionCheck>>, refusals: OperatorRefusals): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    const check = Object.hasOwn(required, name) ? required[name] : Object.hasOwn(optional, name) ? optional[name] : undefined;
    if (check === undefined || result.has(name) || typeof value !== 'string' || !check(value)) throw refusals.input();
    result.set(name, value);
  }
  if (Object.keys(required).some((name) => !result.has(name))) throw refusals.input();
  return result;
}

/**
 * A new output file's path (a backup, a proposal file): absolute, nothing there yet (not even a link), in an existing
 * directory. First, a path with a name Windows reads as another file or a device (ownerOnlyOutput.ts's
 * `isWindowsAliasName`: a backup there would land where SQLite resolves it, not where it was checked) is the caller's
 * `output-name-refused`.
 */
export function newOutputPath(file: string, refusals: OperatorRefusals): void {
  if (isWindowsAliasName(file)) throw refusals.output('output-name-refused');
  if (!path.isAbsolute(file) || fs.lstatSync(file, { throwIfNoEntry: false })
    || !fs.statSync(path.dirname(file), { throwIfNoEntry: false })?.isDirectory()) throw refusals.input();
}

/** `fn`, with the shared owner-only output refusals (ownerOnlyOutput.ts) as the caller's; anything else passes unchanged. */
export function mapOutputRefusals<T>(fn: () => T, refusals: OperatorRefusals): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof OutputRefusal) throw refusals.output(error.code);
    throw error;
  }
}

/**
 * The real directory an output file lands in, checked owner-only (review P299-1). Links and junctions are resolved, so the
 * directory checked is the one written to; one that can't be resolved is `output-uncheckable`.
 */
export function ownerOnlyOutputDirectory(file: string, access: OutputAccess, refusals: OperatorRefusals): string {
  let real: string;
  try {
    real = fs.realpathSync.native(path.dirname(file));
  } catch {
    throw refusals.output('output-uncheckable');
  }
  mapOutputRefusals(() => assertOwnerOnlyDirectory(real, access), refusals);
  return real;
}

/**
 * `fn` on the database through the writer's handle (control/writerDb.ts: the shared lease first when a control dir is
 * configured): read-only with `query_only` on, or writable with foreign keys on. Closed, and any lease released, once `fn`
 * settles.
 */
export async function withWriterDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    if (readonly) handle.db.pragma('query_only = ON');
    else handle.db.pragma('foreign_keys = ON');
    return await fn(handle.db);
  } finally {
    handle.close();
  }
}

/** A read-only handle's SQLite busy timeout: 10 s, as #299 set it. */
const READ_BUSY_TIMEOUT_MS = 10_000;

/** `fn` on an existing database, read-only with `query_only` on and a 10 s busy timeout; closed once `fn` returns. */
export function withReadOnlyDatabase<T>(database: string, fn: (db: Database.Database) => T): T {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    db.pragma(`busy_timeout = ${READ_BUSY_TIMEOUT_MS}`);
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * A read under the writer's shared lease: a configured control dir's `lifecycle.lock` (busy and maintenance refuse, as
 * for every writer), verified as still held before the database is opened read-only with `query_only`. With no control
 * dir there is no lease protocol: only a disposable stack (HOLDR_CONFIG=none) may read then; anything else gets null.
 */
export async function withSharedRead<T>(env: NodeJS.ProcessEnv, database: string, fn: (db: Database.Database) => T):
  Promise<{ value: T } | null> {
  assertNoLeaseEnv(env);
  const controlDir = configuredControlDir(env);
  if (controlDir === null) return env.HOLDR_CONFIG === 'none' ? { value: withReadOnlyDatabase(database, fn) } : null;
  const lease = await acquireSharedLease(controlDir, { timeoutMs: 10_000, busyExit: EXIT.busy, maintenanceExit: EXIT.maintenance });
  try {
    return leaseStillOn(lease, controlDir) ? { value: withReadOnlyDatabase(database, fn) } : null;
  } finally {
    lease.release();
  }
}
