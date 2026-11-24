/**
 * Records of the fake Holdr (tests and the explicit dev mock only): the state
 * E2 would keep in its tables, in memory, with synthetic, detector-safe data.
 * Times are epoch milliseconds here and ISO strings on the wire.
 */
import {
  encodeCardSyncUtf8,
  formatCardSyncId,
  sha256,
  toLetterHex,
  type CardAccount,
  type CardSyncIdKind,
  type CardSyncIssuer,
  type CardSyncPayloadV2,
  type CardSyncSource,
  type CardTransactionKind,
} from '@finance-tracker/shared';
import {
  MAX_SET_ITEMS,
  OWNER_ID_PREFIXES,
  type AbortReason,
  type DecisionAction,
  type DiscardReason,
  type EffectKind,
  type HolderAlias,
  type OwnerIdKind,
  type PlanCounts,
  type PlanKind,
  type ReviewCategory,
  type ReviewReason,
  type RevokeReason,
  type RunErrorCode,
  type SetSourceKind,
  type SetState,
  type TxnValues,
} from '../ownerApi';
import type { LedgerStore } from './ledger';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The fake's default "now": every scenario time is relative to it, so tests are deterministic. */
export const FAKE_NOW = Date.parse('2026-10-17T12:00:00.000Z');
/** The synthetic owner password the fake's recent-auth check accepts. */
export const FAKE_OWNER_PASSWORD = 'synthetic owner password';
export const FAKE_HOLDR_ORIGIN = 'https://holdr-fake.example.test';

export const LIMITS = Object.freeze({
  pairingMinutes: 5,
  pendingDeviceMinutes: 10,
  deviceDays: 30,
  planMinutes: 10,
  retentionDays: 30,
  maxRetentionDays: 90,
  receiptDays: 7,
});
export const RECENT_AUTH_MS = 5 * MINUTE;
export const QUOTA_LIMITS = Object.freeze({
  global: { sets: 500, rows: 50_000, bytes: 50 * 1024 * 1024 },
  cardAccount: { sets: 100, rows: 10_000, bytes: 10 * 1024 * 1024 },
  device: { sets: 200, rows: 20_000, bytes: 20 * 1024 * 1024 },
});

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
export function isoDay(ms: number): string {
  return iso(ms).slice(0, 10);
}
export function seedBytes(label: string): Uint8Array {
  return sha256(encodeCardSyncUtf8(label)).slice(0, 16);
}
export function syncIdFor(kind: CardSyncIdKind, label: string): string {
  return formatCardSyncId(kind, seedBytes(label));
}
export function ownerIdFor(kind: OwnerIdKind, label: string): string {
  return `${OWNER_ID_PREFIXES[kind]}_${toLetterHex(seedBytes(label))}`;
}
export function cardAccountRefFor(label: string): string {
  return `card-acct-${toLetterHex(seedBytes(label))}`;
}
export function cardTransactionIdFor(label: string): string {
  return `card-txn-${toLetterHex(seedBytes(label))}`;
}
/** A v1 file import's batch id (`card_import_batches.id`), in the owner API's form. */
export function importBatchIdFor(label: string): string {
  return `card-import-${toLetterHex(seedBytes(label))}`;
}

const HEX = '0123456789abcdef';
const CURSOR_LETTERS = 'abcdefghijklmnop';
const hexLetters = (value: number) => [...value.toString(16)].map((digit) => CURSOR_LETTERS[HEX.indexOf(digit)]).join('');
const fromHexLetters = (text: string) => parseInt([...text].map((letter) => HEX[CURSOR_LETTERS.indexOf(letter)]).join(''), 16);

/** Which list a cursor continues. Every cursor is bound to its kind and to the resource it was given for (E1b revision 7). */
export type CursorKind = 'open-sets' | 'closed-sets' | 'runs' | 'items' | 'effects' | 'events' | 'identities' | 'merged';
const CURSOR_KINDS: Record<CursorKind, string> = {
  'open-sets': 'so', 'closed-sets': 'sc', runs: 'ru', items: 'it', effects: 'ef', events: 'ev', identities: 'ki', merged: 'km',
};
/** Eight letters naming the resource a cursor belongs to: a set, a plan, a charge, or a list with its filter. */
function cursorTag(resource: string): string {
  return toLetterHex(seedBytes(`cursor/${resource}`)).slice(0, 8);
}
/**
 * An opaque, letters-only continuation (the client accepts nothing else): its kind, its resource, then its parts, numbers in
 * hex written with a–p. It carries positions and pins, never authority: who may read what comes from the session and the
 * route, so an edited cursor can at most be refused or give another page of the same resource.
 */
export function encodeCursor(kind: CursorKind, resource: string, parts: Array<number | string>): string {
  return `${CURSOR_KINDS[kind]}${cursorTag(resource)}${parts.map((part) => `x${typeof part === 'number' ? hexLetters(part) : part}`).join('')}`;
}
/** The parts of a cursor of this kind for this resource, or null: malformed, or of another kind or resource (E2: 422). */
export function decodeCursor(kind: CursorKind, resource: string, cursor: string, count: number): string[] | null {
  const prefix = `${CURSOR_KINDS[kind]}${cursorTag(resource)}x`;
  if (!cursor.startsWith(prefix)) return null;
  const parts = cursor.slice(prefix.length).split('x');
  return parts.length === count && parts.every((part) => /^[a-p]{1,32}$/.test(part)) ? parts : null;
}
/** A number part of a cursor, or null when it is out of range. */
export function cursorNumber(part: string): number | null {
  return part.length <= 12 ? fromHexLetters(part) : null;
}
/** A position in a list of this kind and resource. */
export function pageCursor(kind: CursorKind, resource: string, offset: number): string {
  return encodeCursor(kind, resource, [offset]);
}
/** The position a list cursor stands for, or null when it isn't one of this kind and resource. */
export function pageOffset(kind: CursorKind, resource: string, cursor: string): number | null {
  const parts = decodeCursor(kind, resource, cursor, 1);
  return parts ? cursorNumber(parts[0]) : null;
}
/**
 * A page of a set's items also pins what it was read against (R7; E1b revision 7, X38): the set's version (which retention
 * also moves, chunk by chunk), the card account's ledger revision, and whether the set is past its deadline. A later page
 * whose pins moved is refused, so a set is never put together from two states.
 */
export interface ItemsPin {
  offset: number;
  version: number;
  ledgerRevision: number;
  pastDeadline: boolean;
}
export function itemsCursor(setId: string, pin: ItemsPin): string {
  return encodeCursor('items', setId, [pin.offset, pin.version, pin.ledgerRevision, pin.pastDeadline ? 1 : 0]);
}
/** The wire range of a set's `version` and of a ledger revision (the client's VERSION, 1–, and REVISION, 0–). */
const MAX_WIRE_INT = 2_147_483_647;
/**
 * The pins an items cursor of this set carries, or null when it is no cursor Holdr gave (E2: 422): malformed, of another kind
 * or set, or any value out of its range (a position outside 1–2,000, a version or revision the wire can't carry). Ranges are
 * checked before any pin is compared, so a 409 means only that valid pins moved (E1b §5.0).
 */
export function itemsPinOf(setId: string, cursor: string): ItemsPin | null {
  const parts = decodeCursor('items', setId, cursor, 4);
  if (!parts || (parts[3] !== 'a' && parts[3] !== 'b')) return null;
  const [offset, version, ledgerRevision] = parts.slice(0, 3).map(cursorNumber);
  if (offset === null || offset < 1 || offset >= MAX_SET_ITEMS) return null;
  if (version === null || version < 1 || version > MAX_WIRE_INT) return null;
  if (ledgerRevision === null || ledgerRevision > MAX_WIRE_INT) return null;
  return { offset, version, ledgerRevision, pastDeadline: parts[3] === 'b' };
}
/** A non-secret device confirmation code in E3's form: four groups of four letters. */
export function fingerprintFor(label: string): string {
  return toLetterHex(seedBytes(`fingerprint/${label}`).slice(0, 8)).replace(/(.{4})(?=.)/g, '$1-');
}
export function pairingCodeFor(label: string): string {
  return toLetterHex(seedBytes(`pairing-code/${label}`));
}

export interface ScopeRec {
  cardScopeId: string;
  kind: 'known' | 'unknown';
  scopeLabel: string;
  holderAlias: HolderAlias | 'unknown';
  last4: string | null;
  status: 'active' | 'retired';
}

export interface BindingRec {
  bindingId: string;
  bindingVersion: number;
  issuer: CardSyncIssuer;
  source: CardSyncSource;
  bindingLabel: string;
  cardAccountRef: string;
  status: 'confirmed' | 'needs-reconfirmation' | 'retired';
  statusReason: null | 'restored-from-backup' | 'card-account-changed' | 'contract-changed';
  confirmedAt: number | null;
  scopes: ScopeRec[];
  /** Automatic-sending consent, stored on each browser's grant (Q28): device id → when it was given. */
  autoSyncConsent: Map<string, number>;
  /** +1 on every consent change (R1), so a stale "on" is refused. */
  autoSyncRevision: number;
  /** The issuer's own gate for automatic sending (E4–E7); closed until that issuer is admitted. */
  autoSyncGate: 'open' | 'closed';
  autoSyncEligible: boolean;
  createdAt: number;
}

export interface DeviceRec {
  deviceId: string;
  deviceLabel: string;
  clientVersion: string;
  status: 'pending' | 'active' | 'revoked' | 'expired';
  fingerprint: string;
  pairingId: string;
  createdAt: number;
  pendingExpiresAt: number | null;
  approvedAt: number | null;
  deviceExpiresAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  revokeReason: RevokeReason | null;
  bindingIds: string[];
  /** Bindings whose grant lapsed when they were confirmed again without this browser (Q35). */
  staleBindingIds: string[];
}

export interface PairingRec {
  pairingId: string;
  status: 'open' | 'redeemed' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'locked';
  createdAt: number;
  expiresAt: number;
  bindingIds: string[];
  /** Each binding's version when the invite was made: approving after one changed is `binding-stale`. */
  bindingVersions: number[];
  replacesDeviceId: string | null;
  deviceId: string | null;
  failedAttempts: number;
  /** The fake keeps the code to let tests redeem it; E2 keeps only a digest. */
  code: string;
  closedAt: number | null;
}

export interface RunRec {
  runId: string;
  deviceId: string;
  bindingId: string;
  /** The binding's card account, as E1b's runs keep it. */
  cardAccountRef: string;
  bindingVersion: number;
  clientRunId: string;
  adapterVersion: string;
  contractVersion: number;
  trigger: 'manual' | 'auto';
  createdAt: number;
  runExpiresAt: number;
  observationSetId: string | null;
  errorCode: RunErrorCode | null;
  /** Why the extension stopped the run before anything was accepted (Q4). */
  abortReason: AbortReason | null;
  /** When Holdr closed the run without anything received, e.g. because its browser was revoked (Q36). */
  expiredAt: number | null;
}

export interface CandidateRec {
  transactionId: string;
  cardScopeId: string | null;
  scopeKind: 'known' | 'unknown' | 'legacy';
  sourceKind: 'file' | 'extension';
  status: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  postedDate: string | null;
  amountMinor: number;
  kind: CardTransactionKind;
  description: string;
  merchant: string | null;
  userCategory: string | null;
  notes: string | null;
  matchedOn: Array<'date' | 'amount' | 'merchant' | 'description' | 'posted-id'>;
  blockedReason: null | 'different-known-cards';
  /**
   * Fake-internal, never on the wire: for a removed candidate, the status it was removed from. Only one removed from
   * pending (dismissed or cancelled) is restored and promoted by a link; one removed from posted stays removed (C4, X36).
   */
  removedFrom?: 'pending' | 'posted';
}

export interface DecisionRec {
  action: DecisionAction;
  transactionId: string | null;
  cardScopeId: string | null;
  at: number;
}

export interface ItemRec {
  itemId: string;
  category: ReviewCategory;
  reason: ReviewReason;
  rowIndex: number | null;
  candidates: CandidateRec[];
  difference: { field: 'charges' | 'credits' | 'net' | 'new-balance'; expectedMinor: number; actualMinor: number } | null;
  allowedActions: DecisionAction[];
  decision: DecisionRec | null;
  committed: DecisionRec | null;
  /** The canonical transaction a committed `insert-new` created, for a later supersede. */
  insertedTransactionId: string | null;
  /** What the commit that applied `committed` left, for E1b §4.9.2's reversibility rules; see `CommitMark`. */
  commitMark?: CommitMark;
}

/**
 * What a commit left for one item (E1b's `committed_*` columns, §4.9.2): the ledger's event sequence right after it (a later
 * move or detach of the item's source means the commit can't be taken back as it was), the row the decision is about (the
 * one it created, linked, corrected or kept) with that row's revision then, and whether the commit's own change wrote that
 * row. Absent for a committed set the scenario seeded, which the fake never committed.
 */
export interface CommitMark {
  seq: number;
  transactionId: string | null;
  revision: number | null;
  wrote: boolean;
}

export type EffectName = EffectKind;

/**
 * What happens to a row without a review item: a new row is inserted; a hit on a row Holdr already has, with the same values,
 * changes and attaches nothing (`unchanged`); or, when it brings an id the ledger doesn't know yet, it adds that id as another
 * source of the row `alias` names (E1b revision 7, X37), the row's values staying as they are.
 */
export type AutoRow = 'insert' | 'unchanged' | { alias: string };

export interface EffectRec {
  itemId: string | null;
  rowIndex: number | null;
  effect: EffectName;
  transactionId: string | null;
  before: TxnValues | null;
  after: TxnValues | null;
}

export interface PlanRec {
  previewId: string;
  observationSetId: string;
  setVersion: number;
  planKind: PlanKind;
  payloadDigest: string | null;
  planDigest: string;
  createdAt: number;
  expiresAt: number;
  counts: PlanCounts;
  effects: EffectRec[];
  state: 'valid' | 'expired' | 'superseded' | 'committed';
  committedAt: number | null;
}

export type RowResult = 'inserted' | 'updated' | 'unchanged' | 'matched' | 'attributed' | 'needs-review' | 'rejected' | 'waiting';

/** One observed row as Holdr keeps it, from a v2 payload or a v1 file import. */
export interface RowRec {
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  amountMinor: number;
  kind: CardTransactionKind;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  cardScopeId: string;
  /** `legacy-file` exactly for a v1 file set's rows (E2d): the import's own key, whether the issuer's reference or the fingerprint. */
  identity: 'stable' | 'capture' | 'legacy-file';
  originalAmountMinor: number | null;
  originalCurrency: string | null;
}

export interface SetRec {
  observationSetId: string;
  /** E1b's origin column; sourceKind on the wire. */
  origin: SetSourceKind;
  /** Null exactly for file sets. */
  runId: string | null;
  bindingId: string | null;
  deviceId: string | null;
  importBatchId: string | null;
  cardAccountRef: string;
  version: number;
  state: SetState;
  acceptedAt: number;
  expiresAt: number;
  /** The accepted v2 payload; null once its content is gone (discarded or expired), and always for a file set. */
  payload: CardSyncPayloadV2 | null;
  /** A file set's rows (the v1 import's conflicts); null for extension sets and once the content is gone. */
  fileRows: RowRec[] | null;
  payloadDigest: string | null;
  rowCount: number;
  byteCount: number;
  rejectedCount: number;
  receiptExpiresAt: number | null;
  items: ItemRec[];
  /** What happens to each row without a review item (see `AutoRow`). */
  autoRows: Map<number, AutoRow>;
  plans: PlanRec[];
  committedAt: number | null;
  closedAt: number | null;
  closeReason: null | 'committed' | 'discarded' | 'expired';
  discardReason: DiscardReason | null;
  results: Array<{ rowIndex: number; result: RowResult; transactionId: string | null }>;
}

export interface FakeStore {
  holdrOrigin: string;
  deviceApi: 'enabled' | 'disabled';
  gate: 'open' | 'blocked';
  recoveredAt: number | null;
  paused: boolean;
  pausedAt: number | null;
  settingsVersion: number;
  /**
   * `contractApproved`: the issuer was turned on once under the current contract. Turning it off keeps that (E1b §5.1), and
   * pairing needs it (E1b §5.3, `contract-unsupported`).
   */
  issuers: Record<CardSyncIssuer, { enabled: boolean; enabledAt: number | null; contractApproved: boolean }>;
  cardAccounts: CardAccount[];
  bindings: BindingRec[];
  devices: DeviceRec[];
  pairings: PairingRec[];
  runs: RunRec[];
  sets: SetRec[];
  /** Extra synthetic usage per card account, so a quota warning has something to show. */
  quotaPadding: Map<string, { sets: number; rows: number; bytes: number }>;
  /** The card ledger the owner's repairs act on (proposal §3.8): rows, aliases and events. */
  ledger: LedgerStore;
  recentAuthUntil: number;
  counter: number;
}

/** How many observed rows a set still holds, from either origin; 0 once its content is gone. */
export function rowCountOf(set: SetRec): number {
  return set.fileRows ? set.fileRows.length : set.payload?.rows.length ?? 0;
}

/** One observed row of a set, from either origin; null once its content is gone. */
export function rowAt(set: SetRec, rowIndex: number): RowRec | null {
  if (set.fileRows) return set.fileRows[rowIndex] ?? null;
  const row = set.payload?.rows[rowIndex];
  if (!row) return null;
  return {
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    status: row.status,
    amountMinor: row.amountMinor,
    kind: row.kind,
    description: row.description,
    merchant: row.merchant,
    issuerCategory: row.issuerCategory,
    cardScopeId: row.cardScopeId,
    identity: row.externalIdHash ? 'stable' : 'capture',
    originalAmountMinor: row.originalAmountMinor,
    originalCurrency: row.originalCurrency,
  };
}
