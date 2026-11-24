import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import { createCheckingLedgerReader } from '../services/checking/ledger.js';
import {
  CARD_KIND_CORRECTIONS_SCHEMA_DIGEST,
  CARD_KIND_CORRECTION_REFUSALS,
  CARD_KIND_CORRECTION_RULES,
  applyKindCorrections,
  cardKindCorrectionsSchemaState,
  installCardKindCorrectionsSchema,
  isLocalOwnerRef,
  kindCorrectionGo,
  kindCorrectionUnboundAuditRows,
  kindCorrectionsStatus,
  planKindCorrectionUndo,
  planKindCorrections,
  undoKindCorrections,
  type KindCorrectionCheckingRow,
} from '../services/cardKindCorrections.js';
import { CARD_GUARD_BUILD, registerCardGuardFunctions } from '../services/sqliteStateRepo.js';

export const CARD_KIND_CORRECTIONS_CLI_USAGE = `Card kind corrections operator CLI (existing finance.db only)
  plan --db DB
  install --db DB --backup NEW_FILE --root-go ARTIFACT
  apply --db DB --backup NEW_FILE --root-go ARTIFACT
  undo-plan --db DB --applied-go GO_ID
  undo --db DB --backup NEW_FILE --root-go ARTIFACT
plan opens the database read-only and prints which posted rows the card import tool stored as card payments, although
they are charges, the rules would set to the kind the tool reads now (a purchase, or a fee, interest or other where the
wording says so), per card with their dates, the tool versions that stored them, the candidates the rules leave alone
and why, the review items the correction would close, the Spending row count before and after, and the plan's
previewDigest; with the state of the card kind correction tables (present, absent, or conflict: exit 1), their schema
digest and the database reference a GO must name. undo-plan prints what an undo of an applied GO would set back.
install (Root GO command install) is the only way the tables are created; apply (command apply) corrects exactly the
rows of the plan whose previewDigest the GO names, and undo (command undo) sets back the corrections of the GO it
names. Each checks the GO, the arguments and the backup path before the database is opened for writing, takes a new
pre-write backup, and writes in one IMMEDIATE transaction that checks everything again. A replay (the same GO artifact
again, after it wrote, even with the backup path it wrote then) takes no backup and writes nothing; another artifact
with a recorded goId is refused.
All paths must be absolute. Output is codes, counts, dates, last fours and digests only.
`;

const BASE_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'schemaDigest'];
const AUTHORITY_KEYS = ['previewDigest', 'actingOwnerRef', 'operator', 'basis', 'reason'];
const GO_KEYS = {
  install: BASE_KEYS,
  apply: [...BASE_KEYS, ...AUTHORITY_KEYS],
  undo: [...BASE_KEYS, ...AUTHORITY_KEYS, 'appliedGoId'],
} as const;
const GO_PURPOSES = {
  install: ['copy-rehearsal', 'production-install'],
  apply: ['copy-rehearsal', 'production-apply'],
  undo: ['copy-rehearsal', 'production-undo'],
} as const;
type GoCommand = keyof typeof GO_KEYS;
const GO_MAX_BYTES = 64 * 1024;
const GO_ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OWNER_REF = /^usr_[a-p]{32}$/;
const OPERATOR = /^[a-z0-9][a-z0-9-]{2,39}$/;
/** A basis or reason: one line of plain words, no run of five digits (never an amount or a number). */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 .,:;'()/&-]{2,119}$/;
const ALL_DAYS = { from: '1900-01-01', to: '9999-12-31' } as const;

function refuse(): never { throw new HoldrRefusal('card kind corrections input refused'); }
function readJson(file: string): unknown {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!path.isAbsolute(file) || !stat?.isFile() || stat.size > GO_MAX_BYTES) return refuse();
  const bytes = fs.readFileSync(file);
  if (bytes.length > GO_MAX_BYTES) return refuse();
  try { return JSON.parse(bytes.toString('utf8')); } catch { return refuse(); }
}
function options(args: string[], expected: readonly string[], absolute: readonly string[] = expected): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!expected.includes(args[i]) || result.has(args[i]) || !value || (absolute.includes(args[i]) && !path.isAbsolute(value))) {
      return refuse();
    }
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
const plain = (value: unknown): value is string => typeof value === 'string' && PLAIN.test(value) && !/\d{5}/.test(value);

interface Go {
  purpose: string; goId: string; goDigest: string; previewDigest?: string; actingOwnerRef?: string; operator?: string; basis?: string;
  reason?: string; appliedGoId?: string;
}

/** The GO's fixed fields, checked before the database is opened, and the digest of the whole artifact as parsed. */
function authorize(input: unknown, command: GoCommand, database: string): Go {
  const go = exactly(input, GO_KEYS[command]);
  if (go.format !== 'holdr.card-kind-corrections-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !(GO_PURPOSES[command] as readonly string[]).includes(go.purpose) || go.command !== command
    || typeof go.goId !== 'string' || !GO_ID.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.schemaDigest !== CARD_KIND_CORRECTIONS_SCHEMA_DIGEST) return refuse();
  const goDigest = digest(go);
  if (command === 'install') return { purpose: go.purpose, goId: go.goId, goDigest };
  if (typeof go.previewDigest !== 'string' || !DIGEST.test(go.previewDigest) || typeof go.actingOwnerRef !== 'string'
    || !OWNER_REF.test(go.actingOwnerRef) || typeof go.operator !== 'string' || !OPERATOR.test(go.operator) || !plain(go.basis)
    || !plain(go.reason)) return refuse();
  if (command === 'undo' && (typeof go.appliedGoId !== 'string' || !GO_ID.test(go.appliedGoId) || go.appliedGoId === go.goId)) return refuse();
  return {
    purpose: go.purpose, goId: go.goId, goDigest, previewDigest: go.previewDigest, actingOwnerRef: go.actingOwnerRef,
    operator: go.operator, basis: go.basis as string, reason: go.reason as string,
    ...(command === 'undo' ? { appliedGoId: go.appliedGoId as string } : {}),
  };
}

async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    // The guard triggers on the card tables call this build's detectors: without them a card row write fails.
    registerCardGuardFunctions(handle.db);
    if (!readonly) handle.db.pragma('foreign_keys=ON');
    return await fn(handle.db);
  } finally { handle.close(); }
}

/** The checking ledger's posted rows (every date), or null when its tables are not installed. */
function checkingRows(db: Database.Database): KindCorrectionCheckingRow[] | null {
  const reader = createCheckingLedgerReader(db);
  if (!reader.installed()) return null;
  return reader.listRows(ALL_DAYS).map((row) => ({ date: row.date, amountMinor: row.amountMinor, description: row.description }));
}

const byCard = (rows: ReadonlyArray<{ card: string; transactionDate: string }>) => {
  const out: Record<string, string[]> = {};
  for (const row of rows) (out[row.card] ??= []).push(row.transactionDate);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)).map(([card, dates]) => [card, dates.sort()]));
};
const tally = (list: readonly string[]) =>
  Object.fromEntries([...list.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : 1)));

function backupPathOk(backup: string): boolean {
  return !fs.lstatSync(backup, { throwIfNoEntry: false }) && fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory() === true;
}

export async function runCardKindCorrectionsCli(args: string[], context: {
  env: NodeJS.ProcessEnv;
  io: Io;
  now?: () => Date;
}): Promise<number> {
  const { io } = context;
  const now = () => (context.now ?? (() => new Date()))().toISOString();
  const print = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(CARD_KIND_CORRECTIONS_CLI_USAGE); return 0; }

    if (command === 'plan') {
      const database = options(rest, ['--db']).get('--db')!;
      return await withDatabase(context.env, database, true, (db) => {
        const schema = cardKindCorrectionsSchemaState(db);
        const rows = checkingRows(db);
        const plan = planKindCorrections(db, rows ?? []);
        print({
          code: schema === 'conflict' ? 'card-kind-corrections-conflict' : 'card-kind-corrections-planned', schema,
          schemaDigest: CARD_KIND_CORRECTIONS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)),
          checkingInstalled: rows !== null, rules: CARD_KIND_CORRECTION_RULES,
          rows: plan.rows.length, byCard: byCard(plan.rows), fromKinds: tally(plan.rows.map((row) => row.fromKind)),
          toKinds: tally(plan.rows.map((row) => row.toKind)), parserVersions: plan.parserVersions,
          excluded: plan.excluded.length, excludedByReason: tally(plan.excluded.map((item) => item.reason)),
          excludedRows: plan.excluded.map((item) => ({ card: item.card, date: item.transactionDate, reason: item.reason })),
          reviewItems: plan.reviewItems.count, spendingRows: plan.spendingRows, corrections: kindCorrectionsStatus(db),
          unboundAuditRows: kindCorrectionUnboundAuditRows(db), previewDigest: plan.previewDigest,
        });
        return schema === 'conflict' ? 1 : 0;
      });
    }

    if (command === 'undo-plan') {
      const opts = options(rest, ['--db', '--applied-go'], ['--db']);
      const database = opts.get('--db')!, appliedGoId = opts.get('--applied-go')!;
      if (!GO_ID.test(appliedGoId)) return refuse();
      return await withDatabase(context.env, database, true, (db) => {
        const schema = cardKindCorrectionsSchemaState(db);
        const plan = planKindCorrectionUndo(db, appliedGoId);
        print({
          code: 'card-kind-corrections-undo-planned', schema, schemaDigest: CARD_KIND_CORRECTIONS_SCHEMA_DIGEST,
          databaseRef: digest(path.resolve(database)), appliedGoId, rows: plan.rows.length, byCard: byCard(plan.rows),
          fromKinds: tally(plan.rows.map((row) => row.fromKind)), toKinds: tally(plan.rows.map((row) => row.toKind)),
          skipped: plan.skipped.length, skippedByReason: tally(plan.skipped.map((item) => item.reason)), previewDigest: plan.previewDigest,
        });
        return schema === 'conflict' || plan.skipped.some((item) => item.reason === 'record-mismatch') ? 1 : 0;
      });
    }

    if (command !== 'install' && command !== 'apply' && command !== 'undo') return refuse();
    const opts = options(rest, ['--db', '--backup', '--root-go']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!;
    const go = authorize(readJson(opts.get('--root-go')!), command, database);
    const receipt = { purpose: go.purpose, goId: go.goId, schemaDigest: CARD_KIND_CORRECTIONS_SCHEMA_DIGEST,
      databaseRef: digest(path.resolve(database)) };

    if (command === 'install') {
      // Read-only first: installed tables need no backup and no write (so the exact command again, with its backup now
      // there, is a replay), and a conflict is refused before any backup. Only a write needs a new backup path.
      const schema = await withDatabase(context.env, database, true, cardKindCorrectionsSchemaState);
      if (schema === 'present') { print({ code: 'card-kind-corrections-already-installed', ...receipt, changes: 0 }); return 0; }
      if (schema === 'conflict') return refuse();
      if (!backupPathOk(backup)) return refuse();
      await withDatabase(context.env, database, false, (db) => backedUpWrite(db, backup, () => receipt, installCardKindCorrectionsSchema));
      print({ code: 'card-kind-corrections-installed', ...receipt });
      return 0;
    }

    const authority = {
      goId: go.goId, goDigest: go.goDigest, purpose: go.purpose, previewDigest: go.previewDigest!, actingOwnerRef: go.actingOwnerRef!,
      basis: go.basis!, reason: go.reason!, appliedBy: `operator ${go.operator} under ROOT GO ${go.goId}`,
    };
    // Read-only first: not installed, a replay, a reused goId, an unbound operator audit row, an unknown owner, a changed or
    // empty plan, or a record that does not match its ledger event all end here, before any backup.
    const checked = await withDatabase(context.env, database, true, (db) => {
      if (cardKindCorrectionsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.notInstalled);
      const recorded = kindCorrectionGo(db, go.goId);
      if (recorded !== null) {
        if (recorded.command !== command || recorded.goDigest !== go.goDigest) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.goUsed);
        return { replay: recorded.rows };
      }
      if (kindCorrectionUnboundAuditRows(db) > 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.unboundAudit);
      if (!isLocalOwnerRef(db, authority.actingOwnerRef)) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.owner);
      if (command === 'apply') {
        const rows = checkingRows(db);
        if (rows === null) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.checkingMissing);
        const plan = planKindCorrections(db, rows);
        if (plan.previewDigest !== authority.previewDigest) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.previewChanged);
        if (plan.rows.length === 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.nothingToApply);
      } else {
        const plan = planKindCorrectionUndo(db, go.appliedGoId!);
        if (plan.skipped.some((item) => item.reason === 'record-mismatch')) {
          throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.recordMismatch);
        }
        if (plan.previewDigest !== authority.previewDigest) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.previewChanged);
        if (plan.rows.length === 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.nothingToUndo);
      }
      return { replay: 0 };
    });
    if (checked.replay > 0) {
      // The exact command again: its backup is there now, and none is needed, as nothing is written.
      print({ code: command === 'apply' ? 'card-kind-corrections-already-applied' : 'card-kind-corrections-already-undone', ...receipt,
        rows: checked.replay, changes: 0 });
      return 0;
    }
    if (!backupPathOk(backup)) return refuse();
    const at = now();
    const result = await withDatabase(context.env, database, false, (db) => backedUpWrite(db, backup, () => {
      if (command === 'apply') {
        const rows = checkingRows(db);
        if (rows === null) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.checkingMissing);
        return applyKindCorrections(db, { ...authority, now: at, guardRevision: CARD_GUARD_BUILD.revision, checkingRows: rows });
      }
      return undoKindCorrections(db, { ...authority, appliedGoId: go.appliedGoId!, now: at, guardRevision: CARD_GUARD_BUILD.revision });
    }, () => {}));
    print({ code: command === 'apply' ? 'card-kind-corrections-applied' : 'card-kind-corrections-undone', ...receipt,
      ...(command === 'undo' ? { appliedGoId: go.appliedGoId } : {}), ...result });
    return 0;
  } catch (error) {
    io.stderr.write(`card-kind-corrections: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}${why(error)}\n`);
    return 1;
  }
}

const KNOWN_REFUSALS: ReadonlySet<string> = new Set(Object.values(CARD_KIND_CORRECTION_REFUSALS));
/** One of this command's own fixed refusals (they name no value), in parentheses; nothing for any other error. */
function why(error: unknown): string {
  try {
    return error instanceof HoldrRefusal && KNOWN_REFUSALS.has(error.message) ? ` (${error.message})` : '';
  } catch {
    return '';
  }
}
