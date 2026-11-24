/**
 * The fake Holdr's ledger as the owner's repairs see it (proposal §3.8, X29; E1b §2.10–2.13, §4.9.3, §5.7.1): each card
 * transaction with its revision, the snapshot taken before each update and its reversal marker; its source identities
 * (aliases); and its append-only events. Synthetic data only. It models what the owner can see and change, not E1b's writer:
 * category and notes are left to Spending's own routes, and contents and observations aren't kept here.
 */
import { toLetterHex } from '@finance-tracker/shared';
import type {
  EventValues,
  IdentityCreatedBy,
  IdentityNamespaceKind,
  LedgerEvent,
  LedgerEventReason,
  LedgerEventType,
  LedgerRow,
  RemovedReason,
  SourceIdentity,
  TransactionSources,
  TxnValues,
} from '../ownerApi';
import { LEDGER_EVENTS_PAGE, MAX_IDENTITIES, MAX_MERGED_ROWS } from '../ownerApi';
import { cursorNumber, decodeCursor, encodeCursor, iso, seedBytes } from './model';

export interface LedgerState {
  values: TxnValues;
  removedReason: RemovedReason | null;
  /** The status a removal left; a restore goes back to it (E1b `removed_from_status`). */
  removedFromStatus: 'pending' | 'posted' | null;
  /** When it was removed or merged (E1b `removed_at`): the key merged rows are paged by. */
  removedAt: number | null;
  mergedIntoId: string | null;
  /** E1b `reversal_snapshot_revision`: the revision whose snapshot the row's latest reversible change reverts to. */
  marker: number | null;
}

export interface LedgerRowRec extends LedgerState {
  transactionId: string;
  cardAccountRef: string;
  revision: number;
  /** E1b `card_transaction_versions`: the row as it was at each revision, taken before the update that ended it. */
  snapshots: Map<number, LedgerState>;
  createdAt: number;
  updatedAt: number;
}

export interface IdentityRec {
  identityId: string;
  cardAccountRef: string;
  /** The row it points at; a detached alias keeps the row it was detached from. */
  canonicalId: string;
  status: 'active' | 'detached';
  createdBy: IdentityCreatedBy;
  namespaceKind: IdentityNamespaceKind;
  sourceScopeId: string;
  scopeKind: 'known' | 'unknown' | 'legacy';
  firstSeenStatus: 'pending' | 'posted';
  createdAt: number;
  lastSeenAt: number | null;
}

export interface EventRec {
  eventId: string;
  /** Monotonic: the order events were written in, and the key of the history's pages. */
  seq: number;
  transactionId: string;
  eventType: LedgerEventType;
  reason: LedgerEventReason;
  via: 'file' | 'extension' | 'session';
  actor: 'owner' | 'device' | 'file-import';
  deviceId: string | null;
  revision: number;
  at: number;
  identityId: string | null;
  relatedTransactionId: string | null;
  reversesEventId: string | null;
  /** E1b `cause_event_id`: the merge (or restore) an alias's re-pointing belongs to. Not on the wire. */
  causeEventId: string | null;
  edited: Array<'category' | 'notes'>;
  from: EventValues | null;
  to: EventValues | null;
}

export interface LedgerStore {
  rows: Map<string, LedgerRowRec>;
  identities: Map<string, IdentityRec>;
  events: EventRec[];
  seq: number;
  /** E1b `ledger_revision` per card account: + 1 on every change of its ledger (a commit or a repair). */
  revisions: Map<string, number>;
}

/** Who wrote an event, from where, and why. */
export interface EventSource {
  via: EventRec['via'];
  actor: EventRec['actor'];
  deviceId: string | null;
  reason: LedgerEventReason;
}

/**
 * The changes `revert` can undo: owner-decided value changes that left the row live (E1b §4.6, §5.7.1). One update can
 * write several of them (a compound match: promoted, restored and attributed); the one offered is the first in this order.
 */
const REVERSIBLE_ORDER: readonly LedgerEventType[] = ['corrected', 'promoted', 'restored', 'attributed'];

export function emptyLedger(): LedgerStore {
  return { rows: new Map(), identities: new Map(), events: [], seq: 0, revisions: new Map() };
}

/** The card account's ledger revision (1 before any change). */
export function ledgerRevisionOf(ledger: LedgerStore, cardAccountRef: string): number {
  return ledger.revisions.get(cardAccountRef) ?? 1;
}

export function bumpLedgerRevision(ledger: LedgerStore, cardAccountRef: string): void {
  ledger.revisions.set(cardAccountRef, ledgerRevisionOf(ledger, cardAccountRef) + 1);
}

export function identityIdFor(label: string): string {
  return `card-ident-${toLetterHex(seedBytes(`identity/${label}`))}`;
}
function eventIdFor(label: string): string {
  return `card-event-${toLetterHex(seedBytes(`event/${label}`))}`;
}

function stateOf(row: LedgerRowRec): LedgerState {
  return {
    values: { ...row.values },
    removedReason: row.removedReason,
    removedFromStatus: row.removedFromStatus,
    removedAt: row.removedAt,
    mergedIntoId: row.mergedIntoId,
    marker: row.marker,
  };
}

export function eventValues(values: TxnValues): EventValues {
  return {
    status: values.status,
    amountMinor: values.amountMinor,
    transactionDate: values.transactionDate,
    postedDate: values.postedDate,
    kind: values.kind,
    cardScopeId: values.cardScopeId,
  };
}

interface EventInput {
  eventType: LedgerEventType;
  source: EventSource;
  identityId?: string | null;
  relatedTransactionId?: string | null;
  reversesEventId?: string | null;
  causeEventId?: string | null;
  edited?: Array<'category' | 'notes'>;
}

function addEvent(ledger: LedgerStore, row: LedgerRowRec, at: number, input: EventInput, values: { from: EventValues | null; to: EventValues | null }): EventRec {
  ledger.seq += 1;
  const event: EventRec = {
    eventId: eventIdFor(`${row.transactionId}/${ledger.seq}`),
    seq: ledger.seq,
    transactionId: row.transactionId,
    eventType: input.eventType,
    reason: input.source.reason,
    via: input.source.via,
    actor: input.source.actor,
    deviceId: input.source.actor === 'device' ? input.source.deviceId : null,
    revision: row.revision,
    at,
    identityId: input.identityId ?? null,
    relatedTransactionId: input.relatedTransactionId ?? null,
    reversesEventId: input.reversesEventId ?? null,
    causeEventId: input.causeEventId ?? null,
    edited: input.edited ?? [],
    from: values.from,
    to: values.to,
  };
  ledger.events.push(event);
  return event;
}

/**
 * One update of a row (E1b's trigger takes the snapshot of the row as it was first): the revision grows by one, and the
 * event records the values before and after.
 */
function writeRow(ledger: LedgerStore, row: LedgerRowRec, next: LedgerState, at: number, input: EventInput): EventRec {
  row.snapshots.set(row.revision, stateOf(row));
  const from = eventValues(row.values);
  row.values = { ...next.values };
  row.removedReason = next.removedReason;
  row.removedFromStatus = next.removedFromStatus;
  row.removedAt = next.removedAt;
  row.mergedIntoId = next.mergedIntoId;
  row.marker = next.marker;
  row.revision += 1;
  row.updatedAt = at;
  return addEvent(ledger, row, at, input, { from, to: eventValues(row.values) });
}

export interface IdentitySpec {
  identityId: string;
  createdBy: IdentityCreatedBy;
  namespaceKind: IdentityNamespaceKind;
  sourceScopeId: string;
  scopeKind: IdentityRec['scopeKind'];
  firstSeenStatus: 'pending' | 'posted';
  lastSeenAt?: number | null;
}

/** A new row at revision 1, with its `created` event and, when given, the identity that brought it. */
export function createRow(
  ledger: LedgerStore,
  input: { transactionId: string; cardAccountRef: string; values: TxnValues; at: number; source: EventSource; identity: IdentitySpec | null },
): LedgerRowRec {
  const row: LedgerRowRec = {
    transactionId: input.transactionId,
    cardAccountRef: input.cardAccountRef,
    revision: 1,
    values: { ...input.values },
    removedReason: null,
    removedFromStatus: null,
    removedAt: null,
    mergedIntoId: null,
    marker: null,
    snapshots: new Map(),
    createdAt: input.at,
    updatedAt: input.at,
  };
  ledger.rows.set(row.transactionId, row);
  const identity = input.identity ? addIdentity(ledger, input.identity, row, input.at) : null;
  addEvent(ledger, row, input.at, { eventType: 'created', source: input.source, identityId: identity?.identityId ?? null }, {
    from: null,
    to: eventValues(row.values),
  });
  return row;
}

export function addIdentity(ledger: LedgerStore, spec: IdentitySpec, row: LedgerRowRec, at: number): IdentityRec {
  const identity: IdentityRec = {
    identityId: spec.identityId,
    cardAccountRef: row.cardAccountRef,
    canonicalId: row.transactionId,
    status: 'active',
    createdBy: spec.createdBy,
    namespaceKind: spec.namespaceKind,
    sourceScopeId: spec.sourceScopeId,
    scopeKind: spec.scopeKind,
    firstSeenStatus: spec.firstSeenStatus,
    createdAt: at,
    lastSeenAt: spec.lastSeenAt ?? at,
  };
  ledger.identities.set(identity.identityId, identity);
  return identity;
}

/** An alias attached to a row by a decision (`identity-linked`); the row's own values don't change. */
export function linkIdentity(ledger: LedgerStore, identity: IdentityRec, row: LedgerRowRec, at: number, source: EventSource): EventRec {
  identity.canonicalId = row.transactionId;
  identity.status = 'active';
  identity.lastSeenAt = at;
  return addEvent(ledger, row, at, { eventType: 'identity-linked', source, identityId: identity.identityId }, { from: null, to: null });
}

/** An alias detached from its row (`identity-detached`): the tuple stays reserved, so its next observation is reviewed. */
export function detachIdentityOf(ledger: LedgerStore, identity: IdentityRec, at: number, source: EventSource): EventRec {
  const row = ledger.rows.get(identity.canonicalId) as LedgerRowRec;
  identity.status = 'detached';
  return addEvent(ledger, row, at, { eventType: 'identity-detached', source, identityId: identity.identityId }, { from: null, to: null });
}

/** An alias moved to another row (`identity-repointed`, on the row it moved to). */
export function repointIdentityTo(
  ledger: LedgerStore, identity: IdentityRec, to: LedgerRowRec, at: number, source: EventSource, causeEventId: string | null = null,
): EventRec {
  const from = identity.canonicalId;
  identity.canonicalId = to.transactionId;
  identity.status = 'active';
  return addEvent(ledger, to, at, { eventType: 'identity-repointed', source, identityId: identity.identityId, relatedTransactionId: from, causeEventId }, {
    from: null,
    to: null,
  });
}

/** One more event an update writes, with the reason its own type takes (E1b `ck_evt_*`: `restore` for a restore, and so on). */
export interface AlsoEvent {
  eventType: LedgerEventType;
  reason: LedgerEventReason;
}

/**
 * A value change of a row. `reversible` (an owner decision that leaves the row live, E1b §4.6) sets the marker to the
 * revision it replaces, so that change is the one `revert` undoes; any other change clears it. `alsoEvents` are the other
 * events the same update writes (E1b's compound match: `promoted`, `restored` and `attributed` at one revision), each with
 * its own reason.
 */
export function changeValues(
  ledger: LedgerStore,
  row: LedgerRowRec,
  values: TxnValues,
  at: number,
  input: EventInput & { reversible: boolean; alsoEvents?: AlsoEvent[] },
): EventRec {
  const live = values.status !== 'removed';
  const before = eventValues(row.values);
  const main = writeRow(ledger, row, {
    values,
    removedReason: live ? null : row.removedReason,
    removedFromStatus: live ? null : row.removedFromStatus,
    removedAt: live ? null : row.removedAt,
    mergedIntoId: live ? null : row.mergedIntoId,
    marker: input.reversible && live ? row.revision : null,
  }, at, input);
  for (const also of input.alsoEvents ?? []) {
    addEvent(ledger, row, at, { ...input, eventType: also.eventType, source: { ...input.source, reason: also.reason } }, {
      from: before,
      to: eventValues(row.values),
    });
  }
  return main;
}

/** A row removed (dismissed, cancelled or mistakenly imported): it leaves the figures, and its earlier status is kept. */
export function removeRow(ledger: LedgerStore, row: LedgerRowRec, reason: 'dismissed' | 'cancelled' | 'mistaken-import', at: number, source: EventSource): EventRec {
  const status = row.values.status === 'removed' ? row.removedFromStatus : row.values.status;
  return writeRow(ledger, row, {
    values: { ...row.values, status: 'removed' },
    removedReason: reason,
    removedFromStatus: status,
    removedAt: at,
    mergedIntoId: null,
    marker: null,
  }, at, { eventType: 'removed', source });
}

/** The owner's category or notes changed (Phase 4's edit): a new revision, the values and the reversal marker as they were. */
export function recordUserEdit(ledger: LedgerStore, row: LedgerRowRec, edited: Array<'category' | 'notes'>, at: number): EventRec {
  return writeRow(ledger, row, stateOf(row), at, {
    eventType: 'user-edited',
    source: { via: 'session', actor: 'owner', deviceId: null, reason: 'user-edit' },
    edited,
  });
}

/** `loser` merged into `survivor` (E1b `mergeCardTransactions`, or an adjustment's supersede): its active aliases move with it. */
export function mergeRow(
  ledger: LedgerStore, loser: LedgerRowRec, survivor: LedgerRowRec, reason: 'superseded' | 'settled-into', at: number, source: Omit<EventSource, 'reason'>,
): EventRec {
  const merge = writeRow(ledger, loser, {
    values: { ...loser.values, status: 'removed' },
    removedReason: reason,
    removedFromStatus: loser.values.status === 'removed' ? loser.removedFromStatus : loser.values.status,
    removedAt: at,
    mergedIntoId: survivor.transactionId,
    marker: null,
  }, at, { eventType: reason, source: { ...source, reason }, relatedTransactionId: survivor.transactionId });
  for (const identity of activeIdentitiesOf(ledger, loser.transactionId)) {
    repointIdentityTo(ledger, identity, survivor, at, { ...source, reason }, merge.eventId);
  }
  return merge;
}

export function activeIdentitiesOf(ledger: LedgerStore, transactionId: string): IdentityRec[] {
  return [...ledger.identities.values()].filter((identity) => identity.canonicalId === transactionId && identity.status === 'active');
}

/** The merge event that removed a merged row: its latest, if it is still the merge (E1b §4.9.3 step 1). */
export function latestMergeEvent(ledger: LedgerStore, loser: LedgerRowRec): EventRec | null {
  const own = ledger.events.filter((event) => event.transactionId === loser.transactionId);
  const latest = own[own.length - 1] ?? null;
  return latest && (latest.eventType === 'superseded' || latest.eventType === 'settled-into') ? latest : null;
}

/** The aliases a merge moved to its survivor (events caused by it). */
export function aliasesMovedBy(ledger: LedgerStore, merge: EventRec): IdentityRec[] {
  return ledger.events
    .filter((event) => event.causeEventId === merge.eventId && event.eventType === 'identity-repointed' && event.identityId !== null)
    .map((event) => ledger.identities.get(event.identityId as string) as IdentityRec);
}

/**
 * Undoing a merge in E1b §4.9.3's order: the loser restored first (back to its status before the merge, merge fields
 * cleared), then the aliases the merge moved re-pointed back to it, then the `reversed` event naming the merge.
 */
export function unmergeRow(ledger: LedgerStore, loser: LedgerRowRec, merge: EventRec, at: number, source: EventSource): EventRec {
  const survivorId = loser.mergedIntoId as string;
  const restored = writeRow(ledger, loser, {
    values: { ...loser.values, status: loser.removedFromStatus ?? 'posted' },
    removedReason: null,
    removedFromStatus: null,
    removedAt: null,
    mergedIntoId: null,
    marker: null,
  }, at, { eventType: 'restored', source, relatedTransactionId: survivorId });
  for (const identity of aliasesMovedBy(ledger, merge)) {
    if (identity.canonicalId === survivorId && identity.status === 'active') repointIdentityTo(ledger, identity, loser, at, source, restored.eventId);
  }
  return addEvent(ledger, loser, at, { eventType: 'reversed', source, reversesEventId: merge.eventId, relatedTransactionId: survivorId }, {
    from: { ...eventValues(loser.values), status: 'removed' },
    to: eventValues(loser.values),
  });
}

/**
 * The change `revert` would undo now (E1b §5.7.1 `revertible-event`): of the reversible events the update after the
 * marker's snapshot wrote, the first in the order corrected, promoted, restored, attributed; or null.
 */
export function revertibleEvent(ledger: LedgerStore, row: LedgerRowRec): EventRec | null {
  if (row.marker === null || !row.snapshots.has(row.marker)) return null;
  const marker = row.marker;
  const written = ledger.events.filter((event) => event.transactionId === row.transactionId && event.revision === marker + 1);
  for (const eventType of REVERSIBLE_ORDER) {
    const event = written.find((item) => item.eventType === eventType);
    if (event) return event;
  }
  return null;
}

/**
 * Reverting the row's latest reversible change: it takes the snapshot the marker names exactly (posted back to pending, or a
 * restored row removed again), and the marker becomes that snapshot's own, so the previous change is the latest again.
 */
export function revertRow(ledger: LedgerStore, row: LedgerRowRec, change: EventRec, at: number, source: EventSource): EventRec {
  const snapshot = row.snapshots.get(row.marker as number) as LedgerState;
  return writeRow(ledger, row, { ...snapshot, values: { ...snapshot.values } }, at, { eventType: 'reversed', source, reversesEventId: change.eventId });
}

// ---- views --------------------------------------------------------------------------

export function ledgerRowView(row: LedgerRowRec): LedgerRow {
  return {
    transactionId: row.transactionId,
    cardAccountRef: row.cardAccountRef,
    revision: row.revision,
    removedReason: row.removedReason,
    mergedIntoId: row.mergedIntoId,
    values: { ...row.values },
  };
}

function identityView(identity: IdentityRec): SourceIdentity {
  return {
    identityId: identity.identityId,
    status: identity.status,
    createdBy: identity.createdBy,
    namespaceKind: identity.namespaceKind,
    sourceScopeId: identity.sourceScopeId,
    scopeKind: identity.scopeKind,
    firstSeenStatus: identity.firstSeenStatus,
    createdAt: iso(identity.createdAt),
    lastSeenAt: identity.lastSeenAt === null ? null : iso(identity.lastSeenAt),
  };
}

/**
 * An event as one row's history shows it. Its own events carry its revision after them; an alias that left it (E1b's second
 * history arm, `from_canonical_id`) is the other row's event, so it shows with that row as `relatedTransactionId` and no
 * revision of this one (the move changed none).
 */
function eventView(event: EventRec, shownId: string): LedgerEvent {
  const own = event.transactionId === shownId;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    reason: event.reason,
    via: event.via,
    actor: event.actor,
    deviceId: event.deviceId,
    revision: own ? event.revision : null,
    at: iso(event.at),
    identityId: event.identityId,
    relatedTransactionId: own ? event.relatedTransactionId : event.transactionId,
    reversesEventId: event.reversesEventId,
    edited: [...event.edited],
    from: event.from ? { ...event.from } : null,
    to: event.to ? { ...event.to } : null,
  };
}

/** A keyset position: a time and the 32 letters of an id. Aliases are paged by (created, id), merged rows by (removed, id). */
export interface Keyset {
  time: number;
  key: string;
}
export type KeysetKind = 'identities' | 'merged';

/** A position in one charge's list of aliases or merged rows, bound to that charge (E1b revision 7). */
export function keysetCursor(kind: KeysetKind, transactionId: string, time: number, id: string): string {
  return encodeCursor(kind, transactionId, [time, id.slice(-32)]);
}

export function keysetOf(kind: KeysetKind, transactionId: string, cursor: string): Keyset | null {
  const parts = decodeCursor(kind, transactionId, cursor, 2);
  const time = parts ? cursorNumber(parts[0]) : null;
  return parts && time !== null && parts[1].length === 32 ? { time, key: parts[1] } : null;
}

/** A position in one charge's history, bound to that charge: before the event written `seq`th. */
export function eventsCursor(transactionId: string, seq: number): string {
  return encodeCursor('events', transactionId, [seq]);
}

export function eventsSeqOf(transactionId: string, cursor: string): number | null {
  const parts = decodeCursor('events', transactionId, cursor, 1);
  const seq = parts ? cursorNumber(parts[0]) : null;
  return seq !== null && seq >= 1 ? seq : null;
}

/** Which list a page continues; the others come as their first page, as they are now. */
export type SourcesPage =
  | { list: 'events'; beforeSeq: number }
  | { list: 'identities'; after: Keyset }
  | { list: 'merged'; after: Keyset }
  | null;

/** One keyset page of `items` sorted by (time, id): those after `after`, at most `size`, and the cursor of the next. */
function keysetPage<T>(
  items: T[], keyOf: (item: T) => Keyset, kind: KeysetKind, transactionId: string, size: number, after: Keyset | null,
): { page: T[]; next: string | null } {
  const sorted = [...items].sort((a, b) => keyOf(a).time - keyOf(b).time || keyOf(a).key.localeCompare(keyOf(b).key));
  const rest = after === null ? sorted : sorted.filter((item) => {
    const key = keyOf(item);
    return key.time > after.time || (key.time === after.time && key.key > after.key);
  });
  const page = rest.slice(0, size);
  const last = page[page.length - 1];
  return { page, next: rest.length > page.length && last ? keysetCursor(kind, transactionId, keyOf(last).time, keyOf(last).key) : null };
}

/**
 * One charge's sources, each list one page: its aliases by (created, id), the rows merged into it by (removed, id), and its
 * history newest first: its own events, plus the re-points of aliases that left it (E1b §5.7.1, second arm). The page asked
 * for continues its list after its cursor. Like E1b's (revision 7, X39), these are live keyset pages: everything present
 * when a walk began appears in it exactly once, and something written meanwhile may appear on a later page or only on a
 * fresh read. (This fake keys the history by write order, so its walks never show what was written meanwhile.)
 */
export function transactionSourcesView(ledger: LedgerStore, row: LedgerRowRec, page: SourcesPage): TransactionSources {
  const about = (event: EventRec) => event.transactionId === row.transactionId
    || (event.eventType === 'identity-repointed' && event.relatedTransactionId === row.transactionId);
  const beforeSeq = page?.list === 'events' ? page.beforeSeq : null;
  const history = ledger.events
    .filter((event) => about(event) && (beforeSeq === null || event.seq < beforeSeq))
    .sort((a, b) => b.seq - a.seq);
  const events = history.slice(0, LEDGER_EVENTS_PAGE);
  const identities = keysetPage(
    [...ledger.identities.values()].filter((identity) => identity.canonicalId === row.transactionId),
    (identity) => ({ time: identity.createdAt, key: identity.identityId.slice(-32) }),
    'identities', row.transactionId, MAX_IDENTITIES, page?.list === 'identities' ? page.after : null,
  );
  const merged = keysetPage(
    [...ledger.rows.values()].filter((other) => other.mergedIntoId === row.transactionId),
    (other) => ({ time: other.removedAt ?? other.updatedAt, key: other.transactionId.slice(-32) }),
    'merged', row.transactionId, MAX_MERGED_ROWS, page?.list === 'merged' ? page.after : null,
  );
  return {
    transaction: ledgerRowView(row),
    identities: identities.page.map(identityView),
    nextIdentitiesCursor: identities.next,
    mergedRows: merged.page.map(ledgerRowView),
    nextMergedRowsCursor: merged.next,
    revertibleEventId: revertibleEvent(ledger, row)?.eventId ?? null,
    events: events.map((event) => eventView(event, row.transactionId)),
    nextEventsCursor: history.length > events.length ? eventsCursor(row.transactionId, events[events.length - 1].seq) : null,
  };
}
