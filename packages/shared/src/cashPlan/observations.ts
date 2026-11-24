import { sha256 } from '../cardDedupe.js';
import type { CardOwner } from '../types.js';
import { canonicalInstant, easternDate, isIsoDate, isUtcInstant } from './dates.js';

/**
 * Card schedule observations (A1 spec v9 §2–§3): issuer facts about a card's statement cycle, each with its provenance
 * and its financial effective time. Rows are append-only and never updated; a newer fact supersedes an older one only
 * when the engine reads them (mergeFacts). Absent is null: only an observed value is a value.
 */

export const CARD_SCHEDULE_SOURCE_KINDS = ['issuer-dashboard-dom', 'issuer-dashboard-json', 'statement-pdf', 'owner-entry'] as const;
export type CardScheduleSourceKind = (typeof CARD_SCHEDULE_SOURCE_KINDS)[number];
export const CARD_SCHEDULE_AS_OF_SOURCES = ['explicit', 'statement', 'implicit-capture'] as const;
export type CardScheduleAsOfSource = (typeof CARD_SCHEDULE_AS_OF_SOURCES)[number];
export type CardScheduleAsOfPrecision = 'instant' | 'date';
export const CARD_AUTOPAY_KINDS = ['on-statement', 'on-minimum', 'on-fixed', 'on-other', 'off', 'not-shown'] as const;
export type CardAutopayKind = (typeof CARD_AUTOPAY_KINDS)[number];
export const CARD_ISSUER_PHRASES = ['not-required', 'paid', 'past-due', 'none'] as const;
export type CardIssuerPhrase = (typeof CARD_ISSUER_PHRASES)[number];
export const CARD_SCHEDULE_HELD_REASONS = ['unbound', 'ambiguous-card', 'invalid', 'dom-json-disagree', 'cycle-unknown', 'minimum-basis'] as const;
export type CardScheduleHeldReason = (typeof CARD_SCHEDULE_HELD_REASONS)[number];
/** The only minimum Holdr stores: the issuer's total minimum due by D, including any past-due amount. */
export type CardMinimumBasis = 'total-due';
/** Minimum bases an input may name. Anything but `total-due` holds the row (`minimum-basis`); M is never computed. */
export const CARD_MINIMUM_INPUT_BASES = ['total-due', 'current-only', 'unknown'] as const;

/**
 * Exact read-only page paths a dashboard observation may cite as its `sourceRef`. Empty in A1: B1 fills it once B and
 * Root agree the extension's per-host allowlist. Until then every observation cites `sha256:<64 hex>`.
 */
export const CARD_SCHEDULE_PAGE_PATHS: readonly string[] = Object.freeze([]);

/** One stored row of `card_schedule_observations`, as the engine reads it. */
export interface CardScheduleObservation {
  id: string;
  /** Null only for a held row that names no single card. */
  cardAccountId: string | null;
  issuer: string;
  currency: string;
  sourceKind: CardScheduleSourceKind;
  sourceRef: string;
  /** Capture instant (UTC). Never a financial time. */
  observedAt: string;
  /** The financial effective time of the row's live fields: an instant …Z or a YYYY-MM-DD date. */
  financialAsOf: string;
  asOfSource: CardScheduleAsOfSource;
  asOfPrecision: CardScheduleAsOfPrecision;
  importRef: string;
  payloadDigest: string;
  extractorVersion: string;
  statementPeriodStartDate: string | null;
  statementClosingDate: string | null;
  paymentDueDate: string | null;
  statementBalanceMinor: number | null;
  minimumDueMinor: number | null;
  minimumBasis: CardMinimumBasis | null;
  remainingStatementMinor: number | null;
  currentBalanceMinor: number | null;
  pastDueMinor: number | null;
  lastPaymentDate: string | null;
  lastPaymentMinor: number | null;
  scheduledPaymentDate: string | null;
  scheduledPaymentMinor: number | null;
  autopay: CardAutopayKind | null;
  autopayFixedMinor: number | null;
  issuerPhrase: CardIssuerPhrase | null;
  status: 'accepted' | 'held';
  heldReason: CardScheduleHeldReason | null;
  importedAt: string;
}

/** The import file `holdr-cash import` reads. */
export const CARD_SCHEDULE_OBSERVATIONS_FORMAT = 'holdr.card-schedule-observations';
export const CARD_SCHEDULE_OBSERVATIONS_VERSION = 1;
export const CARD_SCHEDULE_OBSERVATIONS_MAX_BYTES = 1024 * 1024;
export const CARD_SCHEDULE_OBSERVATIONS_MAX_ROWS = 5000;

/**
 * One observation in an import file. Every key but `card`, `currency`, `sourceKind`, `sourceRef`, `observedAt` and
 * `extractorVersion` is optional, and a key is present only when the source showed that value: null is refused.
 * - `card` names the card by its issuer slug and the last four or five digits it shows. It may also name the card's
 *   `owner` and its `nickname` in Holdr: each only narrows the cards it can bind to (two cards that share an ending).
 * - `asOf` is the issuer-stated effective time. A statement PDF must carry `{ source: 'statement', at: <closing date>,
 *   precision: 'date' }`. A dashboard or owner row may carry `{ source: 'explicit', … }`; without one its live fields
 *   take `implicit-capture` at `observedAt`.
 * - `minimum` is the minimum due with its declared basis; only `total-due` is stored.
 */
export interface CardScheduleObservationInput {
  card: { issuer: string; last4?: string; last5?: string; owner?: CardOwner; nickname?: string };
  currency: string;
  sourceKind: CardScheduleSourceKind;
  sourceRef: string;
  observedAt: string;
  extractorVersion: string;
  asOf?: { source: 'explicit' | 'statement'; at: string; precision: CardScheduleAsOfPrecision };
  statementPeriodStartDate?: string;
  statementClosingDate?: string;
  paymentDueDate?: string;
  statementBalanceMinor?: number;
  minimum?: { minor: number; basis?: string };
  remainingStatementMinor?: number;
  currentBalanceMinor?: number;
  pastDueMinor?: number;
  lastPaymentDate?: string;
  lastPaymentMinor?: number;
  scheduledPaymentDate?: string;
  scheduledPaymentMinor?: number;
  autopay?: CardAutopayKind;
  autopayFixedMinor?: number;
  issuerPhrase?: CardIssuerPhrase;
}

/** A validated observation, before the import binds it to a card. */
export interface ValidCardScheduleObservation {
  /** `owner` and `nickname` only when the input named them, so a reference without them hashes as it always did. */
  card: { issuer: string; last4: string | null; last5: string | null; owner?: CardOwner; nickname?: string };
  currency: string;
  sourceKind: CardScheduleSourceKind;
  sourceRef: string;
  observedAt: string;
  financialAsOf: string;
  asOfSource: CardScheduleAsOfSource;
  asOfPrecision: CardScheduleAsOfPrecision;
  extractorVersion: string;
  statementPeriodStartDate: string | null;
  statementClosingDate: string | null;
  paymentDueDate: string | null;
  statementBalanceMinor: number | null;
  minimumDueMinor: number | null;
  minimumBasis: CardMinimumBasis | null;
  remainingStatementMinor: number | null;
  currentBalanceMinor: number | null;
  pastDueMinor: number | null;
  lastPaymentDate: string | null;
  lastPaymentMinor: number | null;
  scheduledPaymentDate: string | null;
  scheduledPaymentMinor: number | null;
  autopay: CardAutopayKind | null;
  autopayFixedMinor: number | null;
  issuerPhrase: CardIssuerPhrase | null;
  /** `cycle-unknown` (neither C nor D) or `minimum-basis` (a minimum without the total-due basis); else null. */
  heldReason: 'cycle-unknown' | 'minimum-basis' | null;
}

/** Why an observation was refused: a field name or rule, never a value. */
export type CardScheduleObservationRefusal = { ok: false; reason: string };

export const MAX_CASH_PLAN_MINOR = 999_999_999_999;

const INPUT_KEYS = new Set([
  'card', 'currency', 'sourceKind', 'sourceRef', 'observedAt', 'extractorVersion', 'asOf', 'statementPeriodStartDate',
  'statementClosingDate', 'paymentDueDate', 'statementBalanceMinor', 'minimum', 'remainingStatementMinor', 'currentBalanceMinor',
  'pastDueMinor', 'lastPaymentDate', 'lastPaymentMinor', 'scheduledPaymentDate', 'scheduledPaymentMinor', 'autopay',
  'autopayFixedMinor', 'issuerPhrase',
]);
const REQUIRED_KEYS = ['card', 'currency', 'sourceKind', 'sourceRef', 'observedAt', 'extractorVersion'];
const CARD_KEYS = new Set(['issuer', 'last4', 'last5', 'owner', 'nickname']);
const CARD_OWNERS: readonly CardOwner[] = ['alex', 'casey', 'joint'];
/** A nickname as Holdr keeps one: at most 80 characters. */
const MAX_NICKNAME = 80;
const AS_OF_KEYS = ['at', 'precision', 'source'];
const MINIMUM_KEYS = new Set(['minor', 'basis']);
const ISSUER = /^[a-z][a-z0-9-]{0,31}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SOURCE_REF = /^sha256:[0-9a-f]{64}$/;
const EXTRACTOR_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+@_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_CASH_PLAN_MINOR;

/**
 * Strict validation of one import-file observation (spec v9 §2–§3). Exact keys, per-field ranges, the mixed-row rule
 * (a statement PDF row is bound to its close; `statement` as-of exists only on PDF rows) and the M contract (only a
 * total-due minimum is stored; any other basis holds the row). Refusals name a field, never a value.
 */
export function validateCardScheduleObservation(input: unknown): { ok: true; value: ValidCardScheduleObservation } | CardScheduleObservationRefusal {
  const refuse = (reason: string): CardScheduleObservationRefusal => ({ ok: false, reason });
  if (!isRecord(input)) return refuse('observation');
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) return refuse('unknown-key');
    if (input[key] === null || input[key] === undefined) return refuse(key);
  }
  for (const key of REQUIRED_KEYS) if (!(key in input)) return refuse(key);

  const card = input.card;
  if (!isRecord(card) || Object.keys(card).some((key) => !CARD_KEYS.has(key))) return refuse('card');
  if (typeof card.issuer !== 'string' || !ISSUER.test(card.issuer)) return refuse('card.issuer');
  const last4 = card.last4 === undefined ? null : card.last4;
  const last5 = card.last5 === undefined ? null : card.last5;
  if (last4 !== null && (typeof last4 !== 'string' || !/^\d{4}$/.test(last4))) return refuse('card.last4');
  if (last5 !== null && (typeof last5 !== 'string' || !/^\d{5}$/.test(last5))) return refuse('card.last5');
  if (last4 === null && last5 === null) return refuse('card.last4');
  if (last4 !== null && last5 !== null && !last5.endsWith(last4)) return refuse('card.last5');
  if (card.owner !== undefined && (typeof card.owner !== 'string' || !(CARD_OWNERS as readonly string[]).includes(card.owner))) {
    return refuse('card.owner');
  }
  let nickname: string | undefined;
  if (card.nickname !== undefined) {
    // As Holdr keeps a nickname: printable, at most 80 characters, and no long number (a card's number never travels).
    if (typeof card.nickname !== 'string') return refuse('card.nickname');
    nickname = card.nickname.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (nickname.length === 0 || nickname.length > MAX_NICKNAME || /[\p{Cc}\p{Cf}]/u.test(nickname) || /\d{5}/.test(nickname)) {
      return refuse('card.nickname');
    }
  }
  const reference: ValidCardScheduleObservation['card'] = {
    issuer: card.issuer, last4, last5,
    ...(card.owner !== undefined ? { owner: card.owner as CardOwner } : {}),
    ...(nickname !== undefined ? { nickname } : {}),
  };

  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) return refuse('currency');
  const sourceKind = input.sourceKind;
  if (typeof sourceKind !== 'string' || !(CARD_SCHEDULE_SOURCE_KINDS as readonly string[]).includes(sourceKind)) return refuse('sourceKind');
  const kind = sourceKind as CardScheduleSourceKind;
  if (typeof input.sourceRef !== 'string' || !(SOURCE_REF.test(input.sourceRef)
    || (kind !== 'statement-pdf' && CARD_SCHEDULE_PAGE_PATHS.includes(input.sourceRef)))) return refuse('sourceRef');
  if (!isUtcInstant(input.observedAt)) return refuse('observedAt');
  const observedAt = canonicalInstant(input.observedAt);
  if (typeof input.extractorVersion !== 'string' || !EXTRACTOR_VERSION.test(input.extractorVersion)) return refuse('extractorVersion');

  const date = (key: string): string | null | false => {
    const value = input[key];
    if (value === undefined) return null;
    return isIsoDate(value) ? value : false;
  };
  const start = date('statementPeriodStartDate');
  const closing = date('statementClosingDate');
  const due = date('paymentDueDate');
  const lastPaymentDate = date('lastPaymentDate');
  const scheduledPaymentDate = date('scheduledPaymentDate');
  if (start === false) return refuse('statementPeriodStartDate');
  if (closing === false) return refuse('statementClosingDate');
  if (due === false) return refuse('paymentDueDate');
  if (lastPaymentDate === false) return refuse('lastPaymentDate');
  if (scheduledPaymentDate === false) return refuse('scheduledPaymentDate');
  if (closing !== null && due !== null && closing > due) return refuse('paymentDueDate');
  if (start !== null && (closing === null || start >= closing)) return refuse('statementPeriodStartDate');

  const amount = (key: string, rule: (value: number) => boolean): number | null | false => {
    const value = input[key];
    if (value === undefined) return null;
    return isMinor(value) && rule(value) ? value : false;
  };
  const any = () => true;
  const statementBalance = amount('statementBalanceMinor', any);
  const remaining = amount('remainingStatementMinor', any);
  const currentBalance = amount('currentBalanceMinor', any);
  const pastDue = amount('pastDueMinor', (value) => value >= 0);
  const lastPaymentMinor = amount('lastPaymentMinor', (value) => value > 0);
  const scheduledPaymentMinor = amount('scheduledPaymentMinor', (value) => value > 0);
  const autopayFixed = amount('autopayFixedMinor', (value) => value > 0);
  if (statementBalance === false) return refuse('statementBalanceMinor');
  if (remaining === false) return refuse('remainingStatementMinor');
  if (currentBalance === false) return refuse('currentBalanceMinor');
  if (pastDue === false) return refuse('pastDueMinor');
  if (lastPaymentMinor === false) return refuse('lastPaymentMinor');
  if (scheduledPaymentMinor === false) return refuse('scheduledPaymentMinor');
  if (autopayFixed === false) return refuse('autopayFixedMinor');

  let autopay: CardAutopayKind | null = null;
  if (input.autopay !== undefined) {
    if (typeof input.autopay !== 'string' || !(CARD_AUTOPAY_KINDS as readonly string[]).includes(input.autopay)) return refuse('autopay');
    autopay = input.autopay as CardAutopayKind;
  }
  if (autopayFixed !== null && autopay !== 'on-fixed') return refuse('autopayFixedMinor');
  let issuerPhrase: CardIssuerPhrase | null = null;
  if (input.issuerPhrase !== undefined) {
    if (typeof input.issuerPhrase !== 'string' || !(CARD_ISSUER_PHRASES as readonly string[]).includes(input.issuerPhrase)) return refuse('issuerPhrase');
    issuerPhrase = input.issuerPhrase as CardIssuerPhrase;
  }

  let minimumDueMinor: number | null = null;
  let minimumBasis: CardMinimumBasis | null = null;
  let heldForBasis = false;
  if (input.minimum !== undefined) {
    const minimum = input.minimum;
    if (!isRecord(minimum) || Object.keys(minimum).some((key) => !MINIMUM_KEYS.has(key))) return refuse('minimum');
    if (!isMinor(minimum.minor) || minimum.minor < 0) return refuse('minimum.minor');
    if (minimum.basis !== undefined && (typeof minimum.basis !== 'string'
      || !(CARD_MINIMUM_INPUT_BASES as readonly string[]).includes(minimum.basis))) return refuse('minimum.basis');
    if (minimum.basis === 'total-due') {
      minimumDueMinor = minimum.minor;
      minimumBasis = 'total-due';
    } else {
      heldForBasis = true;
    }
  }

  // The financial effective time of the live fields (the mixed-row rule): a statement PDF row is entirely effective at
  // its close; a dashboard or owner row uses its issuer-stated as-of, else implicit-capture at observedAt.
  let financialAsOf: string;
  let asOfSource: CardScheduleAsOfSource;
  let asOfPrecision: CardScheduleAsOfPrecision;
  const asOf = input.asOf;
  if (asOf !== undefined) {
    if (!isRecord(asOf) || Object.keys(asOf).sort().join('|') !== AS_OF_KEYS.join('|')) return refuse('asOf');
    if (asOf.precision !== 'instant' && asOf.precision !== 'date') return refuse('asOf.precision');
    if (asOf.source !== 'explicit' && asOf.source !== 'statement') return refuse('asOf.source');
    if (asOf.precision === 'date' ? !isIsoDate(asOf.at) : !isUtcInstant(asOf.at)) return refuse('asOf.at');
    financialAsOf = asOf.precision === 'date' ? asOf.at as string : canonicalInstant(asOf.at as string);
    asOfSource = asOf.source;
    asOfPrecision = asOf.precision;
  } else {
    financialAsOf = observedAt;
    asOfSource = 'implicit-capture';
    asOfPrecision = 'instant';
  }
  if (kind === 'statement-pdf') {
    if (closing === null) return refuse('statementClosingDate');
    if (asOf === undefined || asOfSource !== 'statement' || asOfPrecision !== 'date' || financialAsOf !== closing) return refuse('asOf');
  } else if (asOfSource === 'statement') {
    return refuse('asOf.source');
  }
  // An issuer's effective time is never after the capture that read it.
  const asOfDate = asOfPrecision === 'date' ? financialAsOf : easternDate(financialAsOf);
  if (asOfPrecision === 'date' ? asOfDate > easternDate(observedAt) : Date.parse(financialAsOf) > Date.parse(observedAt)) return refuse('asOf.at');
  // The issuer's last payment is a payment it had received by the as-of.
  if (lastPaymentDate !== null && lastPaymentDate > asOfDate) return refuse('lastPaymentDate');

  const heldReason = closing === null && due === null ? 'cycle-unknown' : heldForBasis ? 'minimum-basis' : null;
  return {
    ok: true,
    value: {
      card: reference,
      currency: input.currency,
      sourceKind: kind,
      sourceRef: input.sourceRef,
      observedAt,
      financialAsOf,
      asOfSource,
      asOfPrecision,
      extractorVersion: input.extractorVersion,
      statementPeriodStartDate: start,
      statementClosingDate: closing,
      paymentDueDate: due,
      statementBalanceMinor: statementBalance,
      minimumDueMinor,
      minimumBasis,
      remainingStatementMinor: remaining,
      currentBalanceMinor: currentBalance,
      pastDueMinor: pastDue,
      lastPaymentDate,
      lastPaymentMinor,
      scheduledPaymentDate,
      scheduledPaymentMinor,
      autopay,
      autopayFixedMinor: autopayFixed,
      issuerPhrase,
      heldReason,
    },
  };
}

/**
 * A nickname as the import compares a card reference's with a card account's: letter case and spacing aside (NFC). Only
 * an exact match of these keys narrows a binding; nothing is guessed.
 */
export function cardNicknameKey(nickname: string): string {
  return nickname.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** JSON with every object's keys sorted, so equal content always has equal text. */
export function canonicalCashPlanJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  ));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return hex(sha256(new TextEncoder().encode(text)));
}

/**
 * The fact's identity (`payload_digest`): the binding, currency, cycle and fact fields, the source and the financial
 * as-of, and the held reason. Never `observedAt`, the extractor version or the import: re-importing an identical fact
 * inserts nothing. `binding` is the card account id, or for a row that names no single card the card reference the
 * file gave (hashed here, never stored).
 */
export function cardSchedulePayloadDigest(
  o: ValidCardScheduleObservation,
  binding: { cardAccountId: string } | { unboundCard: ValidCardScheduleObservation['card'] },
  heldReason: CardScheduleHeldReason | null,
): string {
  return sha256Hex(canonicalCashPlanJson({
    binding,
    currency: o.currency,
    sourceKind: o.sourceKind,
    sourceRef: o.sourceRef,
    financialAsOf: o.financialAsOf,
    asOfSource: o.asOfSource,
    asOfPrecision: o.asOfPrecision,
    statementPeriodStartDate: o.statementPeriodStartDate,
    statementClosingDate: o.statementClosingDate,
    paymentDueDate: o.paymentDueDate,
    statementBalanceMinor: o.statementBalanceMinor,
    minimumDueMinor: o.minimumDueMinor,
    minimumBasis: o.minimumBasis,
    remainingStatementMinor: o.remainingStatementMinor,
    currentBalanceMinor: o.currentBalanceMinor,
    pastDueMinor: o.pastDueMinor,
    lastPaymentDate: o.lastPaymentDate,
    lastPaymentMinor: o.lastPaymentMinor,
    scheduledPaymentDate: o.scheduledPaymentDate,
    scheduledPaymentMinor: o.scheduledPaymentMinor,
    autopay: o.autopay,
    autopayFixedMinor: o.autopayFixedMinor,
    issuerPhrase: o.issuerPhrase,
    heldReason,
  }));
}
