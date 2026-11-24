import { createHash } from 'node:crypto';
import { HoldrRefusal } from '../dbErrors.js';

export const SOURCE = 'shared-household-amazon';
export const POLICY = Object.freeze({
  version: 'amazon-domain-v2',
  eventSettlementDays: 14,
  totalSettlementDays: 14,
  refundProvenance: 'ledger-Refunded',
  uniqueness: 'global-degree-one-preferred-and-fallback',
  allocation: 'explicit-payment-item-or-positive-complete-single-card-order-v1',
  rounding: 'largest-remainder-stable-ref-v1',
});
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item
  ))).digest('hex');
}
export const POLICY_DIGEST = digest(POLICY);
export const LEDGER_POLICY = Object.freeze({
  version: 'amazon-ledger-card-anchor-v1', daysBefore: 3, daysAfter: 7,
  identity: 'unique-card-row-corroboration-no-economic-event-id',
  corroboration: 'all-financial-order-fields-agree-max-one-occurrence-per-run',
  fallback: 'same-row-order-precedence-no-distinct-row-double-attribution',
  methodAgreement: 'every-charge-in-complete-order-methods',
  allocation: 'complete-order-price-share-with-proven-noncard-remainder',
  rounding: 'largest-remainder-stable-item-ref-v1',
});
export const LEDGER_POLICY_DIGEST = digest(LEDGER_POLICY);
/**
 * Amazon Fresh driver tips billed separately (tipSplit.ts, Root 2026-10-24), versioned on its own and recorded on every
 * split result and every non-tip result whose candidates its class rule narrowed, and on their reconcile and subject
 * audits. Tonight's scope (Root 06:36Z): only order parts link; tip parts are stored deferred and never considered. Its
 * class rule (Root 05:52/05:55Z) keeps tips-class rows out of every non-tip subject's candidates, so POLICY and
 * POLICY_DIGEST (every GO's and card binding's pin) are unchanged tonight; the next re-binding round moves that rule into
 * POLICY under one new Root approval, and tip linking comes in its own reviewed follow-up.
 */
export const TIP_SPLIT_POLICY = Object.freeze({
  version: 'amazon-fresh-tip-split-v2',
  scope: 'single-card-proven-order-with-positive-tip-below-total|total-evidenced|no-other-subject-of-the-order-has-a-candidate|no-payments-ledger-subject-names-the-order-but-its-tip-charge',
  ledgerTipCharge: 'a-completed-ledger-Charged-subject-naming-only-the-tipped-order-of-exactly-its-proven-tip-amount-and-currency-never-supersedes-its-order-part|every-other-ledger-subject-naming-the-order-does',
  agreement: 'parts-name-their-total|same-order-date-card-currency|order-part-plus-tip-part-equals-total',
  classes: 'tips-class-rows-are-never-a-candidate-of-any-non-tip-subject',
  order: 'total-minus-tip|bound-card|posted-purchase|total-settlement-window|amazon-descriptor-not-tips|degree-one',
  tip: 'stored-deferred|amount-date-card-kept|never-a-candidate|never-contests|never-linked',
  descriptors: 'amazon=/amzn|amazon|prime\\s*now/i tips=amazon-and-/\\btips?\\b/i',
  coupling: 'independent-the-tip-never-holds-the-order',
  allocation: 'none-the-order-part-files-its-row-whole',
  recorded: 'split-results|non-tip-results-the-class-rule-narrowed|their-reconcile-audits',
});
export const TIP_SPLIT_POLICY_DIGEST = digest(TIP_SPLIT_POLICY);
export const ORDER_HISTORY_POLICY = Object.freeze({
  version: 'amazon-order-history-v4',
  header: 'validated-explicit-unobserved-empty-header-only',
  conflicts: 'explicit-item-or-tender-proof-conflict-or-a-fact-proven-in-both-with-different-values',
  unread: 'a-tender-conflict-its-capture-attributes-only-to-unknown-label-summary-hold-or-method-incomplete-is-no-conflict',
  compared: 'total-if-non-null|tenderCoverage-if-not-unknown'
    + '|items-if-complete-no-unknown-line-or-conflict-multiset-of-lines-by-stated-attributes-except-lineOrdinal-and-display-only-imageId'
    + '|methods-if-methodComplete-multiset-of-instruments-by-kind-network-last4'
    + '|summary-if-summaryComplete-multiset-of-components-by-kind-and-amount',
  absent: 'null-or-unknown-is-unread-never-a-value-collections-pair-one-to-one-in-any-order',
  allocation: 'retained-independently-complete-observation-no-anchor-promotion',
  rounding: 'largest-remainder-ties-by-order-exact-title-and-occurrence-by-ordinal-never-capture-refs-or-image-ids',
});
export const ORDER_HISTORY_POLICY_DIGEST = digest(ORDER_HISTORY_POLICY);
export function refuse(): never { throw new HoldrRefusal('amazon input refused'); }
export function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== [...keys].sort().join('|')) return refuse();
  return record;
}
export const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export const minor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
export const currency = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
export const ref = (v: unknown): v is string => typeof v === 'string' && /^amz-[a-f0-9]{48}$/.test(v);
export const opaque = (kind: string, key: unknown): string => `amz-${digest([SOURCE, kind, key]).slice(0, 48)}`;
export const addDays = (date: string, n: number): string => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
