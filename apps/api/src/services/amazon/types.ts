export type EvidenceClass = 'payment-event' | 'unique-total-match' | 'payment-ledger-complete';
export type HoldReason = 'match-held' | 'mixed-tender-unproven' | 'item-identity-unproven'
  | 'negative-component' | 'currency-mismatch' | 'inconsistent-evidence' | 'refund-unattributed';
export interface CardIdentity {
  id: string;
  issuer: string;
  owner: string;
  last4: string | null;
  currency: string;
  status: string;
}
export interface LedgerRow {
  id: string;
  cardAccountId: string;
  transactionDate: string;
  status: string;
  kind: string;
  currency: string;
  amountMinor: number;
  userCategory: string | null;
  effectiveCategory?: string;
  description?: string;
}
export interface Method {
  kind: 'card' | 'balance' | 'points' | 'unknown';
  network: 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';
  last4: string | null;
}
export interface Money { currency: string; amountMinor: number }
export interface ItemObservation {
  lineOrdinal?: number;
  itemId: string | null;
  title: string;
  quantity: number | null;
  unitPrice: Money | null;
  /** v3 only, optional: display-only Amazon CDN image ID; never financial evidence or part of the order fingerprint. */
  imageId?: string;
}
export interface OrderObservation {
  orderId: string;
  date: string;
  total: Money | null;
  items: ItemObservation[];
  paymentCoverage?: { status: 'held'; reason: 'selector-failed' };
  paymentMethods?: Method[];
  summary?: Array<{ kind: 'items-subtotal' | 'shipping' | 'tax' | 'tip' | 'gift-card' | 'promotion' | 'rewards' | 'grand-total'; money: Money }>;
  tenderCoverage?: 'single-card-proven' | 'multi-tender' | 'unknown';
  tenderProof?: {
    methodComplete: boolean;
    summaryComplete: boolean;
    unknownMethod: boolean;
    unknownSummary: boolean;
    conflict: boolean;
  };
  /** Positive exhaustive bounded native block parse; subtotal reconciliation is checked independently. */
  itemProof?: { complete: boolean; unknownLine: boolean; conflict: boolean };
  refundSummary?: Money;
  /** v3 only, optional: Amazon's closed positive statement that the order was cancelled and never charged, read with
   * visible coverage of every shipment status. Only on an otherwise empty-details order with `total: null`. */
  chargeFree?: { status: 'cancelled-not-charged'; shipments: number };
}
export interface PaymentObservation {
  date: string;
  money: Money;
  kind: 'charge' | 'refund' | 'unknown';
  status: 'completed' | 'pending' | 'unknown';
  method: Method;
  orderIds: string[];
  identity: 'native-row' | 'ambiguous-repeat';
  provenance?: { source: 'ledger'; status: 'Charged' | 'Refunded' | 'Pending'; page: number; ordinal: number };
}
/** Closed status phrases the producer recognizes on order-details and Returns pages (mirrors AMAZON_STRUCTURE_RULES.refunds.phrases). */
export type RefundEvidencePhrase = 'return-created' | 'return-started' | 'return-requested' | 'return-in-transit'
  | 'return-received' | 'return-complete' | 'return-cancelled' | 'refund-issued' | 'refund-complete' | 'refund-processed'
  | 'refunded' | 'refund-for-return' | 'refund-pending';
export type ReturnStatus = 'started' | 'in-transit' | 'received' | 'completed' | 'cancelled';
export type RefundStatus = 'completed' | 'pending';
export interface RefundEvidenceItem {
  /** Order-details records only: the same capture's `order.items[].lineOrdinal`. */
  lineOrdinal: number | null;
  itemId: string | null;
  /** Returns-page records only, for linking without an ASIN. */
  title: string | null;
  /** Returned/refunded quantity only when the page states it. */
  units: number | null;
}
/**
 * One displayed return or refund status, v3 only. A return is never a refund. `money` (always positive), `date` and
 * `destinations` exist only on completed refunds, which need an explicit issued/refunded statement; a pending refund is
 * expected, never money. null/empty means the page did not state them, never zero. Never payment evidence: only Amazon
 * spending reads them, as issued refund events counted once (refundEventNetting.ts).
 */
export type RefundEvidence = {
  date: string | null;
  orderIds: [string];
  items: RefundEvidenceItem[];
  provenance: { source: 'order-details' | 'returns-page'; page: number; ordinal: number; phrase: RefundEvidencePhrase };
} & ({
  kind: 'refund';
  status: RefundStatus;
  money: Money | null;
  destinations: Array<{ method: Method; money: Money | null }>;
} | {
  kind: 'return';
  status: ReturnStatus;
  money: null;
  destinations: [];
});
export interface Staging {
  format: 'holdr.amazon-staging';
  version: 1 | 2 | 3;
  runId?: string;
  mode?: 'recent' | 'backfill';
  source: 'shared-household-amazon';
  window: { from: string; through: string; timeZone: string };
  coverage: Record<'orders' | 'payments' | 'details' | 'refunds', {
    status: 'held' | 'partial'; reason: string; pages: number; records: number; rejected: number;
  }>;
  resume: {
    orders: Array<{ year: number; startIndex: number }>;
    payments: { pageNumber: number } | null;
    details: string[];
    restartPayments: boolean;
  };
  orders: OrderObservation[];
  payments: PaymentObservation[];
  /** v3 only, optional: displayed return/refund statuses from order-details and Returns pages. */
  refundEvidence?: RefundEvidence[];
}
export interface Binding {
  network: Exclude<Method['network'], 'unknown'>;
  last4: string;
  cardAccountId: string;
}
export interface BindingProposal {
  format: 'holdr.amazon-binding-proposal';
  version: 1;
  policyDigest: string;
  inventoryDigest: string;
  bindings: Binding[];
}
export interface RootApproval {
  format: 'holdr.amazon-root-approval';
  version: 1;
  authority: 'Root';
  decision: 'approved';
  proposalDigest: string;
  policyDigest: string;
  inventoryDigest: string;
}
export interface Allocation {
  itemRef: string;
  amountMinor: number;
  currency: string;
  attribution: 'explicit-payment-item' | 'order-total-policy' | 'payment-ledger-policy';
  sourceCategory: string | null;
  classification?: 'source' | 'policy-allocated';
}
/** Not populated from staging v1/v2: those versions have no native occurrence or line identity. */
export interface MatchSubject {
  ref: string;
  source: 'shared-household-amazon';
  evidenceClass: EvidenceClass;
  nativeOccurrenceId: string | null;
  provenance: 'ledger-Charged' | 'ledger-Refunded' | 'order-total' | 'order-total-split' | 'unproven';
  status: 'completed' | 'pending' | 'unknown';
  date: string;
  money: Money;
  method: Method;
  orderRefs: string[];
  tenderProof: 'single-card-complete' | 'mixed' | 'unknown';
  allocations: Allocation[];
  allocationComplete: boolean;
  allocationHoldReason?: HoldReason;
  ledgerObservation?: { captureDigest: string; runId: string | null; page: number; ordinal: number; evidenceDigest?: string };
  evidenceHoldReason?: 'multiple-orders' | 'evidence-held';
  /**
   * Only on a tipped order's split subject (tipSplit.ts): which part of its total it is, and that total subject. A tip part
   * is stored deferred (Root 06:36Z): the matcher never considers it.
   */
  split?: { part: 'order' | 'tip'; totalRef: string };
}
export interface Candidate {
  subjectRef: string;
  cardTransactionId: string;
  evidenceClass: EvidenceClass;
}
export interface MatchResult {
  subjectRef: string;
  state: 'linked' | 'held';
  reason: 'unique' | 'binding-held' | 'evidence-held' | 'no-candidate' | 'ambiguous'
    | 'multiple-orders' | 'superseded' | 'corroborated' | 'deferred';
  candidateCount: number;
  cardTransactionId: string | null;
  evidenceClass: EvidenceClass;
  corroboratedBy?: string;
  policyDigest?: string;
  /** Only on a non-tip result whose candidates TIP_SPLIT_POLICY's class rule narrowed (a tips-class row it would have had). */
  tipRowsExcludedBy?: string;
}
export interface Contribution {
  amountMinor: number;
  category: string | null;
  /** `item-taxonomy` and `fresh-default`: an Amazon Fresh Item List line's card category (freshSplit.ts). */
  categorySource: 'item-override' | 'agent-classification' | 'reviewed-mapping' | 'item-taxonomy' | 'fresh-default' | null;
  classification: 'source' | 'policy-allocated' | 'residual';
  itemRef?: string;
}
export type Resolution =
  | { kind: 'split'; cardTransactionId: string; currency: string; evidenceClass: EvidenceClass; contributions: Contribution[] }
  | { kind: 'whole-row'; cardTransactionId: string; reason: HoldReason };
export interface CategoryResolver {
  readonly version: string;
  snapshot(): {
    readonly version: string;
    resolve(rows: ReadonlyArray<{ id: string; currency: string; amountMinor: number }>): ReadonlyMap<string, Resolution>;
  };
}
