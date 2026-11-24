import { createHash } from 'node:crypto';

/**
 * The proof's value-free receipt (design v1.2 §3.6, roadmap v1.4 §4.4 items 4-6, Mac/API half). It is stored in
 * `card_import_proof_receipts` in the commit's own transaction and returned to the Mac.
 *
 * Every field is a safe non-negative integer, a YYYY-MM-DD date, the commit's ISO time, an opaque id or digest, or a
 * member of a closed list. It never holds an amount, description, merchant, card number or free text.
 * `assertProofReceipt` checks exactly that, key by key, before the row is written. Any deviation holds as
 * `proof-receipt-invalid` and rolls the import back.
 */

export const PROOF_FORMAT = 'holdr.card-import-proof';
export const PROOF_VERSION = 'w4.1';

/** Every reason the proof holds an import (its 409 `code`), a closed list: never a value. */
export const PROOF_HOLD_CODES = Object.freeze([
  'proof-schema-required', 'proof-schema-conflict', 'proof-fence-expired', 'proof-permit-dead', 'proof-receipt-conflict',
  'proof-plan-not-clean', 'proof-revision', 'proof-statement-mismatch', 'proof-statement-unchecked',
  'proof-rows', 'proof-superset', 'proof-replay',
  'proof-coverage-first', 'proof-coverage-backward', 'proof-coverage-gap', 'proof-coverage-outside', 'proof-coverage-lost',
  'proof-coverage-windows', 'proof-coverage-other-account',
  'proof-completeness-unknown',
  'proof-payments-accounts', 'proof-payments-pair', 'proof-payments-ambiguous', 'proof-payments-unmatched',
  'proof-payments-returned', 'proof-payments-conflicts', 'proof-payments-sets', 'proof-payments-decisions-conflict',
  'proof-links-stored', 'proof-links-projected',
  'proof-tables', 'proof-admission', 'proof-receipt-invalid',
] as const);
export type ProofHoldCode = (typeof PROOF_HOLD_CODES)[number];

export type CompletenessBasis = 'statement-totals' | 'pagination-end' | 'provider-interval' | 'operator-attested';
export type CoverageMove = 'none' | 'forward' | 'gap-fill' | 'forward+gap-fill';
export type VerifierResult = 'pass' | 'fail' | 'unknown' | 'not-applicable';
export type ProofTiming = 'lt1s' | '1to2s' | '2to5s' | '5to30s' | 'gt30s';

export interface CoverageSpan {
  from: string;
  through: string;
  /** Days between `from` and `through` that no import covers. */
  gapDays: number;
}

export interface ProofReceipt {
  format: typeof PROOF_FORMAT;
  version: 1;
  proofVersion: typeof PROOF_VERSION;
  mode: 'automatic' | 'supervised';
  route: 'commit' | 'cutover';
  jobId: string;
  attempt: number;
  cardAccountId: string;
  payloadSha256: string;
  planDigest: string;
  outcome: 'committed' | 'nothing-new';
  counts: { rows: number; new: number; duplicate: number; promoted: number; contentTwinsSkipped: number; held: number; review: number };
  statement: 'match' | 'unchecked';
  statementPolicy: 'require-match' | 'allow-unchecked-no-figures';
  completeness: { basis: CompletenessBasis; interval: { from: string; to: string } };
  replay: { new: number; possibleDuplicate: number; reapply: 'nothing-new' };
  coverage: { payload: { from: string; to: string }; before: CoverageSpan; after: CoverageSpan; move: CoverageMove };
  rows: {
    appeared: number; elsewhere: number; gone: number; changed: number; promoted: number; promotedTextChanged: number;
    promotedCategoryChanged: number;
    /** Pre-existing rows whose effective category (inference included) this import changed: reported, never a hold. */
    categoryEffects: number;
    inSpan: number; untwinned: number;
  };
  payments: {
    pairsBefore: number; pairsAfter: number; pairsAdded: number; pairsChangedOrGone: number; ambiguousBefore: number;
    ambiguousAfter: number; unmatchedPaymentsNew: number; unmatchedDebitsBefore: number; unmatchedDebitsAfter: number;
    reasonFlipsToNoCardPayment: number; otherChanges: number; returnedAdded: number; conflicts: number;
  };
  links: {
    applicable: boolean; stored: number; lost: number; moved: number; added: number; projectedLost: number;
    projectedMoved: number; projectedAdded: number; driftBefore: number;
  };
  verifiers: Array<{ id: string; result: VerifierResult; reconciledThroughBefore: string | null; reconciledThroughAfter: string | null }>;
  tables: 'unchanged';
  /** The LIVE PERMIT generations an automatic commit was made under; null for a supervised one, which is outside it. */
  permit: { globalGeneration: number; issuerGeneration: number } | null;
  /** W16's seal, once W4b carries it in the manifest; null until then. */
  seal: null;
  timing: ProofTiming;
  /** When the proof transaction committed, by the API's clock (ISO UTC, milliseconds): STOPPING-PENDING's label uses it. */
  committedAt: string;
}

/** A receipt that is not exactly the schema below; `path` names the schema position, never a value. */
export class ProofReceiptInvalid extends Error {
  constructor(readonly path: string) {
    super(`proof receipt invalid at ${path}`);
    this.name = 'ProofReceiptInvalid';
  }
}

type Check = (value: unknown, path: string) => void;
const fail = (path: string): never => { throw new ProofReceiptInvalid(path); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: unknown) => typeof value === 'string' && DATE.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const count: Check = (value, path) => { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path); };
const zero: Check = (value, path) => { if (value !== 0) fail(path); };
const positive: Check = (value, path) => { if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path); };
const date: Check = (value, path) => { if (!validDate(value)) fail(path); };
const dateOrNull: Check = (value, path) => { if (value !== null && !validDate(value)) fail(path); };
const bool: Check = (value, path) => { if (typeof value !== 'boolean') fail(path); };
const literal = (...allowed: readonly unknown[]): Check => (value, path) => { if (!allowed.includes(value)) fail(path); };
const pattern = (re: RegExp): Check => (value, path) => { if (typeof value !== 'string' || !re.test(value)) fail(path); };
const shape = (fields: Record<string, Check>): Check => (value, path) => {
  if (!isRecord(value)) fail(path);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(), expected = Object.keys(fields).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(path);
  for (const [key, check] of Object.entries(fields)) check(record[key], `${path}.${key}`);
};
const list = (item: Check, max: number): Check => (value, path) => {
  if (!Array.isArray(value) || value.length > max) fail(path);
  (value as unknown[]).forEach((entry, index) => item(entry, `${path}[${index}]`));
};

const span = shape({ from: date, through: date, gapDays: count });
const interval = shape({ from: date, to: date });

const RECEIPT: Check = shape({
  format: literal(PROOF_FORMAT),
  version: literal(1),
  proofVersion: literal(PROOF_VERSION),
  mode: literal('automatic', 'supervised'),
  route: literal('commit', 'cutover'),
  jobId: pattern(/^[a-f0-9]{64}$/),
  attempt: positive,
  cardAccountId: pattern(/^card-acct-[a-p]{32}$/),
  payloadSha256: pattern(/^[a-f0-9]{64}$/),
  planDigest: pattern(/^ipv1:[a-p]{64}$/),
  outcome: literal('committed', 'nothing-new'),
  counts: shape({ rows: count, new: count, duplicate: count, promoted: count, contentTwinsSkipped: count, held: zero, review: zero }),
  statement: literal('match', 'unchecked'),
  statementPolicy: literal('require-match', 'allow-unchecked-no-figures'),
  completeness: shape({ basis: literal('statement-totals', 'pagination-end', 'provider-interval', 'operator-attested'), interval }),
  replay: shape({ new: zero, possibleDuplicate: zero, reapply: literal('nothing-new') }),
  coverage: shape({ payload: interval, before: span, after: span, move: literal('none', 'forward', 'gap-fill', 'forward+gap-fill') }),
  rows: shape({
    appeared: count, elsewhere: zero, gone: zero, changed: zero, promoted: count, promotedTextChanged: count,
    promotedCategoryChanged: count, categoryEffects: count, inSpan: count, untwinned: zero,
  }),
  payments: shape({
    pairsBefore: count, pairsAfter: count, pairsAdded: count, pairsChangedOrGone: zero, ambiguousBefore: count,
    ambiguousAfter: count, unmatchedPaymentsNew: count, unmatchedDebitsBefore: count, unmatchedDebitsAfter: count,
    reasonFlipsToNoCardPayment: count, otherChanges: zero, returnedAdded: zero, conflicts: zero,
  }),
  links: shape({
    applicable: bool, stored: count, lost: zero, moved: zero, added: zero, projectedLost: zero, projectedMoved: zero,
    projectedAdded: count, driftBefore: count,
  }),
  verifiers: list(shape({
    id: pattern(/^[a-z][a-z0-9-]{0,39}$/), result: literal('pass', 'unknown', 'not-applicable'),
    reconciledThroughBefore: dateOrNull, reconciledThroughAfter: dateOrNull,
  }), 16),
  tables: literal('unchanged'),
  permit: (value, path) => {
    if (value !== null) shape({ globalGeneration: positive, issuerGeneration: positive })(value, path);
  },
  seal: literal(null),
  timing: literal('lt1s', '1to2s', '2to5s', '5to30s', 'gt30s'),
  committedAt: (value, path) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(path);
  },
});

/**
 * Exactly the receipt schema, or ProofReceiptInvalid. A committed receipt also records a clean proof, so its
 * hold-relevant counts must be 0 here as well; a non-zero one means the gates and the receipt disagree.
 */
export function assertProofReceipt(value: unknown): asserts value is ProofReceipt {
  RECEIPT(value, '$');
  const receipt = value as ProofReceipt;
  if ((receipt.mode === 'automatic') !== (receipt.permit !== null)) fail('$.permit');
  if (receipt.counts.new + receipt.counts.duplicate + receipt.counts.promoted + receipt.counts.contentTwinsSkipped
    !== receipt.counts.rows) fail('$.counts');
  if (receipt.outcome === 'nothing-new' && (receipt.counts.new !== 0 || receipt.counts.promoted !== 0)) fail('$.outcome');
  if (receipt.rows.appeared !== receipt.counts.new || receipt.rows.promoted !== receipt.counts.promoted) fail('$.rows');
  if (receipt.payments.pairsAfter !== receipt.payments.pairsBefore + receipt.payments.pairsAdded) fail('$.payments');
  if (receipt.coverage.payload.from > receipt.coverage.payload.to) fail('$.coverage.payload');
  if (receipt.completeness.interval.from > receipt.completeness.interval.to) fail('$.completeness.interval');
}

/** The receipt as stored: its own key order, so the stored text and its digest are reproducible. */
export function serializeProofReceipt(receipt: ProofReceipt): string {
  return JSON.stringify(receipt);
}

export function proofReceiptSha256(receipt: ProofReceipt): string {
  return createHash('sha256').update(serializeProofReceipt(receipt)).digest('hex');
}

/** The elapsed proof time as a coarse bucket: never a number with many digits. */
export function timingBucket(elapsedMs: number): ProofTiming {
  if (elapsedMs < 1000) return 'lt1s';
  if (elapsedMs < 2000) return '1to2s';
  if (elapsedMs < 5000) return '2to5s';
  if (elapsedMs < 30000) return '5to30s';
  return 'gt30s';
}
