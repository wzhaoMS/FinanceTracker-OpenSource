import { HoldrRefusal } from '../dbErrors.js';

/**
 * The refusal codes of the card-sync repository methods (E1b design §5.0,
 * §5.11): every refusal is an untouched HoldrRefusal whose message is
 * `card-sync:<code>`, constants only, so no stored or submitted value can
 * reach it. E2 maps each code to its HTTP status and owner or device answer
 * (§5.11); the repository never does.
 */
export const CARD_SYNC_REFUSAL_CODES = [
  // §5.0: principals, authorization generation, versions, paging
  'principal-not-allowed', 'generation-mismatch', 'version-conflict', 'invalid-request', 'page-stale', 'not-found',
  // §5.1–§5.2: settings, issuers, scopes and bindings
  'sync-paused', 'issuer-disabled', 'main-world-required', 'policy-invalid', 'contract-unsupported', 'gate-closed',
  'auto-sync-not-eligible', 'binding-needs-reconfirmation', 'binding-retired', 'binding-exists', 'binding-stale',
  'card-account-mismatch', 'scope-immutable', 'scope-invalid',
  // §5.3: pairings and devices
  'pairing-invalid', 'pairing-locked', 'pairing-not-redeemed', 'pairing-closed', 'pairing-expired', 'fingerprint-mismatch',
  'device-not-active', 'credential-format-invalid',
  // §5.4: runs, acceptance and receipts
  'run-not-found', 'run-closed', 'run-expired', 'idempotency-conflict', 'payload-invalid', 'payload-digest-mismatch',
  'scope-not-in-binding', 'capture-already-accepted', 'review-quota-exceeded', 'too-many-open-runs', 'run-rate-limited',
  'receipt-expired', 'observation-integrity',
  // §5.5: the review queue
  'review-stale', 'set-closed', 'observation-expired', 'action-not-allowed', 'decision-conflict', 'adjustment-not-reversible',
  'decisions-incomplete', 'nothing-to-adjust', 'source-review-required',
  // §5.6: plans and commit
  'plan-not-found', 'plan-expired', 'plan-cancelled', 'preview-stale', 'plan-mismatch', 'plan-needs-review',
  'plan-quota-exceeded',
  // §5.7: ledger reads and direct session operations
  'transaction-not-found', 'transaction-revision-stale', 'removal-not-allowed', 'restore-not-allowed', 'merge-not-allowed',
  'cross-card-link-refused', 'link-not-reversible', 'identity-last-active', 'repoint-not-allowed', 'change-not-reversible',
  'identity-not-active', 'identity-not-found',
  // §5.10: payment links
  'payment-link-invalid', 'payment-link-conflict', 'payment-link-source-missing',
] as const;

export type CardSyncRefusalCode = (typeof CARD_SYNC_REFUSAL_CODES)[number];

const PREFIX = 'card-sync:';

/** Every message a card-sync refusal can carry. */
export const CARD_SYNC_REFUSALS: ReadonlySet<string> = new Set(CARD_SYNC_REFUSAL_CODES.map((code) => `${PREFIX}${code}`));

/** A card-sync refusal: thrown as it is, it passes the value-free boundary untouched. */
export function cardSyncRefusal(code: CardSyncRefusalCode): HoldrRefusal {
  return new HoldrRefusal(`${PREFIX}${code}`);
}

/**
 * The code of a card-sync refusal; undefined for anything else (another
 * refusal, a card guard refusal, a database error, a hostile object).
 */
export function cardSyncRefusalCode(error: unknown): CardSyncRefusalCode | undefined {
  try {
    if (!(error instanceof HoldrRefusal) || Object.getPrototypeOf(error) !== HoldrRefusal.prototype) return undefined;
    const { message } = error;
    return CARD_SYNC_REFUSALS.has(message) ? message.slice(PREFIX.length) as CardSyncRefusalCode : undefined;
  } catch {
    return undefined;
  }
}
