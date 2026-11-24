import type { Database } from 'better-sqlite3';

import { HoldrRefusal } from '../../dbErrors.js';
import type { ProofReceipt } from './receipt.js';
import { PROOF_PERMIT_JOURNAL_TABLE, PROOF_PERMIT_TABLE } from './schema.js';

/**
 * ROOT's LIVE PERMIT, as the Mac sees it (accepted 2026-11-08). An automatic commit needs both rows live:
 * - `*`: the mirror of holdrOn, operator stop and the latches;
 * - its issuer's row: that issuer's consent, with mode `daily-interim` or `auto`.
 * The proof checks them inside its transaction (F1 and F2). A missing row is dead, so a fresh install permits nothing.
 *
 * Only the operator command writes the permit; there is no automatic vehicle (ROOT).
 * - `stop` (`*` or one issuer) is always allowed and needs no GO. W2's STOP procedure makes the Mac's `permit stop`
 *   mandatory in every STOP path, with the time the STOP was declared.
 * - `live` needs ROOT's GO naming the scope and the mode. A GO is used once.
 * Every write bumps the row's generation and appends to the journal. A receipt records the generations it committed
 * under. The supervised sweep kit (batch GO, `proofMode=supervised`) is outside the permit.
 *
 * STOPPING-PENDING (ROOT): an automatic receipt is labelled `committed-during-stopping` when a later stop on its scope (a
 * generation above the receipt's) was declared no later than `STOPPING_SKEW_MS` after the receipt's commit. The margin
 * covers ROG and Mac clock skew, so it errs toward the label.
 */

export type PermitMode = 'supervised' | 'daily-interim' | 'auto';
export type PermitStopReason = 'consent-off' | 'holdr-off' | 'operator-stop' | 'latch';
export type PermitLabel = 'committed' | 'committed-during-stopping';

export const PERMIT_GLOBAL = '*';
export const PERMIT_STOP_REASONS: readonly PermitStopReason[] = Object.freeze(['consent-off', 'holdr-off', 'operator-stop', 'latch']);
export const PERMIT_LIVE_MODES: readonly PermitMode[] = Object.freeze(['daily-interim', 'auto']);
export const STOPPING_SKEW_MS = 120_000;
const ISSUER = /^[a-z]{2,24}$/;
const GO_ID = /^[a-f0-9]{32}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface PermitRow {
  issuer: string;
  state: 'live' | 'dead';
  mode: PermitMode;
  generation: number;
  reason: 'go' | PermitStopReason;
  changedAt: string;
}

export interface PermitVerdict {
  live: boolean;
  /** The rows' generations, or 0 for a missing row. */
  globalGeneration: number;
  issuerGeneration: number;
}

const ROW_COLUMNS = 'issuer, state, mode, generation, reason, changed_at AS changedAt';

function readRow(db: Database, issuer: string): PermitRow | null {
  return (db.prepare(`SELECT ${ROW_COLUMNS} FROM ${PROOF_PERMIT_TABLE} WHERE issuer = ?`).get(issuer) as PermitRow | undefined) ?? null;
}

/** On the caller's connection, inside its transaction: is an automatic commit for `issuer` permitted now? */
export function checkLivePermit(db: Database, issuer: string): PermitVerdict {
  const global = readRow(db, PERMIT_GLOBAL);
  const own = ISSUER.test(issuer) ? readRow(db, issuer) : null;
  const live = global?.state === 'live' && own?.state === 'live' && PERMIT_LIVE_MODES.includes(own.mode);
  return { live, globalGeneration: global?.generation ?? 0, issuerGeneration: own?.generation ?? 0 };
}

/** Every permit row, `*` first: the status read W2's STOP procedure and W16's status take the generation from. */
export function readPermitRows(db: Database): PermitRow[] {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM ${PROOF_PERMIT_TABLE} ORDER BY issuer`).all() as PermitRow[];
}

function scopeOf(scope: string): string {
  if (scope !== PERMIT_GLOBAL && !ISSUER.test(scope)) throw new HoldrRefusal('the permit scope must be * or an issuer slug');
  return scope;
}

/** An ISO time, in milliseconds, normalized to `YYYY-MM-DDTHH:MM:SS.sssZ`. */
export function permitTime(value: string): string {
  const ms = ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new HoldrRefusal('the time must be an ISO UTC time');
  return new Date(ms).toISOString();
}

function write(db: Database, row: Omit<PermitRow, 'changedAt'>, extra: { goId: string | null; declaredAt: string | null },
  now: string): void {
  db.prepare(`INSERT INTO ${PROOF_PERMIT_TABLE} (issuer, state, mode, generation, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(issuer) DO UPDATE SET state = excluded.state, mode = excluded.mode, generation = excluded.generation,
      reason = excluded.reason, changed_at = excluded.changed_at`)
    .run(row.issuer, row.state, row.mode, row.generation, row.reason, now);
  db.prepare(`INSERT INTO ${PROOF_PERMIT_JOURNAL_TABLE} (issuer, generation, state, mode, reason, go_id, declared_at, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.issuer, row.generation, row.state, row.mode, row.reason, extra.goId, extra.declaredAt, now);
}

/** A STOP as applied: the row read back, and the declared time recorded for it. */
export interface PermitStop extends PermitRow {
  declaredAt: string;
  /** The STOP was declared further ahead of this clock than the skew allows (969): see `stopPermit`. */
  declaredAtClamped: boolean;
}

/**
 * STOP: the row becomes dead, whatever it was, in one IMMEDIATE transaction that waits for any proof transaction to
 * finish. `declaredAt` is when the STOP was declared (the ROG's STOP, or now for a Mac-side one). A STOP is never refused
 * for its time: one declared more than the skew ahead of this clock (a ROG clock that is off) is recorded as declared
 * when the generation it ends went live, so every receipt of that generation reads committed-during-stopping, the
 * conservative label; on a row that is not live, now. Answers the row as read back after the commit.
 */
export function stopPermit(db: Database, scope: string, reason: PermitStopReason, declaredAt: string, now: Date): PermitStop {
  const issuer = scopeOf(scope);
  if (!PERMIT_STOP_REASONS.includes(reason)) throw new HoldrRefusal('the stop reason is not one of the permit\'s');
  const declared = permitTime(declaredAt);
  const clamped = Date.parse(declared) > now.getTime() + STOPPING_SKEW_MS;
  let recorded = declared;
  db.transaction(() => {
    const old = readRow(db, issuer);
    if (clamped) recorded = old?.state === 'live' ? old.changedAt : now.toISOString();
    write(db, { issuer, state: 'dead', mode: old?.mode ?? 'supervised', generation: (old?.generation ?? 0) + 1, reason },
      { goId: null, declaredAt: recorded }, now.toISOString());
  }).immediate();
  return { ...readRow(db, issuer)!, declaredAt: recorded, declaredAtClamped: clamped };
}

/** LIVE: only under ROOT's GO naming this scope and mode, checked by the operator command first. A GO id is used once. */
export function livePermit(db: Database, scope: string, mode: PermitMode, goId: string, now: Date): PermitRow {
  const issuer = scopeOf(scope);
  if (!PERMIT_LIVE_MODES.includes(mode)) throw new HoldrRefusal('a live permit\'s mode is daily-interim or auto');
  if (!GO_ID.test(goId)) throw new HoldrRefusal('the GO id is invalid');
  db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM ${PROOF_PERMIT_JOURNAL_TABLE} WHERE go_id = ?`).get(goId)) {
      throw new HoldrRefusal('this GO was used already');
    }
    const old = readRow(db, issuer);
    write(db, { issuer, state: 'live', mode, generation: (old?.generation ?? 0) + 1, reason: 'go' }, { goId, declaredAt: null },
      now.toISOString());
  }).immediate();
  return readRow(db, issuer)!;
}

/**
 * STOPPING-PENDING: how a committed receipt reads now. A supervised receipt is outside the permit, so it is plain
 * `committed`; an automatic one is `committed-during-stopping` once a later stop on its scope says so.
 */
export function stoppingLabel(db: Database, receipt: ProofReceipt): PermitLabel {
  if (receipt.permit === null) return 'committed';
  const issuer = db.prepare('SELECT issuer FROM card_accounts WHERE id = ?').pluck().get(receipt.cardAccountId);
  const latest = new Date(Date.parse(receipt.committedAt) + STOPPING_SKEW_MS).toISOString();
  const stopped = db.prepare(`SELECT 1 FROM ${PROOF_PERMIT_JOURNAL_TABLE} WHERE state = 'dead' AND declared_at <= ?
      AND ((issuer = ? AND generation > ?) OR (issuer = ? AND generation > ?)) LIMIT 1`)
    .get(latest, PERMIT_GLOBAL, receipt.permit.globalGeneration, typeof issuer === 'string' ? issuer : '', receipt.permit.issuerGeneration);
  return stopped ? 'committed-during-stopping' : 'committed';
}
