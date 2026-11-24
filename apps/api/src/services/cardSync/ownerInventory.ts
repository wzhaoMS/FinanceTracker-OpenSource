import type { CardSyncContext } from './context.js';
import { cardSyncRefusal } from './refusals.js';
import { readCardSyncAuthorizationGeneration } from './settings.js';

export const AUTHORITY_PAGE_SIZE = 50;
export type AuthorityKind = 'devices' | 'bindings' | 'pairings' | 'binding-devices';
export interface AuthorityPosition { generation: string; afterRowId: number }
export interface AuthorityMark { total: number; next: AuthorityPosition | null }
export interface BindingAuthorityEntry {
  deviceId: string;
  status: 'active' | 'pending';
  enabled: boolean;
  consentedAt: string | null;
}
export interface AuthorityQuery {
  kind: AuthorityKind;
  bindingId?: string;
  afterRowId?: number;
  expectedGeneration?: string;
}

const DEVICE_LIVE = "((d.status = 'active' AND d.expires_at > :now) OR (d.status = 'pending' AND d.pending_expires_at > :now))";
const PAIRING_LIVE = `(p.status = 'open' AND p.expires_at > :now OR p.status = 'redeemed' AND EXISTS
  (SELECT 1 FROM card_sync_devices d WHERE d.pairing_id = p.id AND d.status = 'pending' AND d.pending_expires_at > :now))`;
const BINDING_LIVE = `((d.status = 'active' AND d.expires_at > :now AND g.id IS NOT NULL)
  OR (d.status = 'pending' AND d.pending_expires_at > :now AND EXISTS
    (SELECT 1 FROM card_sync_pairing_scopes p WHERE p.pairing_id = d.pairing_id AND p.binding_id = :bindingId)))`;

export function authorityRows(ctx: CardSyncContext, input: AuthorityQuery) {
  const generation = readCardSyncAuthorizationGeneration(ctx.db);
  if (input.expectedGeneration !== undefined && input.expectedGeneration !== generation) throw cardSyncRefusal('page-stale');
  const after = input.afterRowId ?? 0;
  if (!Number.isSafeInteger(after) || after < 0 || after > 2_147_483_647) throw cardSyncRefusal('invalid-request');
  const params: Record<string, string | number> = { now: ctx.now, after, take: AUTHORITY_PAGE_SIZE + 1 };
  let from: string;
  let live: string;
  let row: string;
  let select: string;
  switch (input.kind) {
    case 'devices':
      from = 'card_sync_devices d'; live = DEVICE_LIVE; row = 'd'; select = 'd.id';
      break;
    case 'bindings':
      from = 'card_source_bindings b'; live = "b.status <> 'retired' AND :now IS NOT NULL"; row = 'b'; select = 'b.id';
      break;
    case 'pairings':
      from = 'card_sync_pairings p'; live = PAIRING_LIVE; row = 'p'; select = 'p.id';
      break;
    case 'binding-devices':
      if (!/^bnd_[a-p]{32}$/.test(input.bindingId ?? '')
        || !ctx.db.prepare('SELECT 1 FROM card_source_bindings WHERE id = ?').get(input.bindingId)) throw cardSyncRefusal('not-found');
      params.bindingId = input.bindingId!;
      from = `card_sync_devices d LEFT JOIN card_sync_device_scopes g
        ON g.device_id = d.id AND g.binding_id = :bindingId AND g.status = 'active'`;
      live = BINDING_LIVE; row = 'd';
      select = 'd.id, d.status, coalesce(g.auto_sync, 0) AS enabled, g.consent_at AS consentedAt';
      break;
    default: throw cardSyncRefusal('invalid-request');
  }
  const countParams = { now: params.now, ...(input.kind === 'binding-devices' ? { bindingId: params.bindingId } : {}) };
  const counts = ctx.db.prepare(`SELECT count(*) AS total${input.kind === 'binding-devices'
    ? ", count(CASE WHEN d.status = 'active' THEN 1 END) AS active" : ''} FROM ${from} WHERE ${live}`)
    .get(countParams) as { total: number; active?: number };
  const rows = ctx.db.prepare(`SELECT ${row}.rowid AS rowId, ${select} FROM ${from}
    WHERE (${live}) AND ${row}.rowid > :after ORDER BY ${row}.rowid LIMIT :take`).all(params) as
    Array<{ rowId: number; id: string; status?: 'active' | 'pending'; enabled?: number; consentedAt?: string | null }>;
  const shown = rows.slice(0, AUTHORITY_PAGE_SIZE);
  const next = rows.length > shown.length ? { generation, afterRowId: shown.at(-1)!.rowId } : null;
  return { ...counts, rows: shown, next };
}

/** Only closed history is expendable. Live authority is enumerated separately with counts and keyset continuations. */
export function closedAuthorityRows(ctx: CardSyncContext, kind: Exclude<AuthorityKind, 'binding-devices'>, limit: number):
  Array<{ id: string; rowId: number }> {
  if (limit <= 0) return [];
  const days = kind === 'pairings' ? 1 : 30;
  const since = new Date(Date.parse(ctx.now) - days * 86_400_000).toISOString();
  const [from, live, stamp] = kind === 'devices'
    ? ['card_sync_devices d', DEVICE_LIVE, 'coalesce(d.closed_at, d.expires_at, d.pending_expires_at)']
    : kind === 'bindings'
      ? ['card_source_bindings b', "b.status <> 'retired' AND :now IS NOT NULL", 'b.retired_at']
      : ['card_sync_pairings p', PAIRING_LIVE, 'coalesce(p.closed_at, p.expires_at)'];
  return ctx.db.prepare(`SELECT id, rowid AS rowId FROM ${from} WHERE NOT (${live}) AND ${stamp} > :since
    ORDER BY ${stamp} DESC, rowid DESC LIMIT :limit`).all({ now: ctx.now, since, limit }) as Array<{ id: string; rowId: number }>;
}
