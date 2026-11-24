import type {
  CardAccount,
  CardAccountCoverage,
  CardAssetSuggestion,
  CardCategoryBasis,
  CardCategoryBasisMarker,
  CardCategoryEvidenceClass,
  CardCategoryHoldReason,
  CardCategoryInference,
  CardCategoryInvalidReason,
  CardCategoryPart,
  CardCategoryRowSource,
  CardCoverageRange,
  CardImportBatch,
  CardMetalsMerchantClass,
  CardOwner,
  CardPaymentDecisionKind,
  CardPaymentPairEvidence,
  CardPaymentReconciliationTotals,
  CardPaymentSourceCount,
  CardPaymentSourceView,
  CardSpendingAccounting,
  CardSpendingExclusion,
  CardSpendingInsights,
  CardSpendingRule,
  CardSpendingRulePreview,
  CardSpendingSummary,
  CardTransactionKind,
  CardTransactionView,
  CheckingDebitClass,
  StaleCardPaymentDecision,
  UnmatchedDebitReason,
  UnmatchedPaymentReason,
} from '@finance-tracker/shared';

import { ApiError, api, apiRaw } from '../../services/api';
import { rememberCardAccounts } from './spendingFormat';

/**
 * Typed calls for the Spending tab. Every path is relative and stays on the
 * page's own origin, like every API call (services/api.ts), so requests go
 * through the web server's API proxy with the session cookie and the
 * X-Holdr-Request header, the import upload (apiRaw) included; nothing here
 * names a host.
 */

export interface SpendingFilters {
  /** YYYY-MM-DD bounds on the transaction date. */
  from: string;
  to: string;
  owner?: CardOwner;
  cardAccountId?: string;
  category?: string;
  /** A merchant group key (`merchantKey` from the summary or a row). */
  merchant?: string;
  q?: string;
  /** Which categories amounts are filed under; the API's default is `enriched`. */
  categoryBasis?: CardCategoryBasis;
  /** The list only: the Amazon card charges not itemized (needs the enriched basis and Amazon orders). */
  amazon?: 'unitemized';
  /** With `amazon`: the currency the coverage line counts, so the list holds exactly its charges. */
  amazonCurrency?: string;
}

export interface SpendingSummaryResponse extends CardSpendingSummary {
  /** Custom and issuer categories in use, for the category picker. */
  categories: string[];
  /**
   * Per currency with posted card payments: how many look paid from brokerage
   * cash, each from a different withdrawal or transfer out. Suggestions only;
   * absent from APIs that predate them.
   */
  paymentsPossiblyPaidFrom?: CardPaymentSourceCount[];
  /** What the categories are based on; absent from APIs that predate it. */
  categoryBasis?: CardCategoryBasisMarker;
  /**
   * Enriched answers from a source of Amazon orders: per currency and category, what Amazon items put there (their
   * parts, never the rest of a charge) and in how many charges; under a category filter, that category's only.
   * A part of each category's amount, never added to it. Absent otherwise, and from APIs that predate it.
   */
  fromAmazonItems?: AmazonItemsInCategory[];
  /**
   * Enriched answers whose source has the Amazon domain's rule: per currency, the Amazon card charges in view (by the
   * domain's rule) and how many Spending files under their items, with every other Amazon row counted apart. Absent
   * otherwise, and from APIs that predate it: no coverage is ever guessed.
   */
  amazonCoverage?: AmazonCoverage[];
}

/** Amazon rows in view, in one currency: the card charges items can explain, how many are itemized, and the rest. */
export interface AmazonCoverage {
  currency: string;
  charges: number;
  itemized: number;
  /**
   * Prime, Kindle, digital, music, a delivery tip or Amazon Pay paying another merchant: posted purchases no order is
   * behind.
   */
  notItemizable: number;
  pending: number;
  refunds: number;
  /** Any other Amazon row (another kind, a nonpositive purchase). */
  other: number;
}

/** What Amazon items put in a category, in one currency, and in how many charges. */
export interface AmazonItemsInCategory {
  currency: string;
  category: string;
  amountMinor: number;
  rows: number;
}

/**
 * A row as an enriched answer files it: `category` is the one it counts under, `categorySource` says where that
 * comes from, and an inferred one says why. Original answers (and APIs that predate them) have neither field.
 */
export interface CardTransactionCategorized extends CardTransactionView {
  categorySource?: CardCategoryRowSource;
  categoryInference?: CardCategoryInference;
}

/**
 * A listed row: a split one carries its amount per category, and under a category filter, its part in it. In an
 * enriched answer, a row linked to an Amazon order carries the order as its details have it (`amazon`).
 */
export interface CardTransactionListRow extends CardTransactionCategorized {
  split?: Array<{ category: string; amountMinor: number }>;
  categoryPortionMinor?: number;
  amazon?: AmazonCardDetail;
}

export interface CardTransactionPageResponse {
  transactions: CardTransactionListRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  categoryBasis?: CardCategoryBasisMarker;
}

export type SpendingInsightsResponse = CardSpendingInsights & { categoryBasis?: CardCategoryBasisMarker };

/** A suggested row (`/spending/accounting`), with its merchant and the category it is filed under now. */
export interface AssetSuggestionView extends CardAssetSuggestion {
  description: string;
  merchantName: string;
  merchantKey: string;
  /** What "not metals" keeps, as the owner's own category; Uncategorized means the owner picks one. */
  category: string;
}

/** An asset purchase in view: why, on whose word, and the category it would be filed under as spending. */
export interface AssetPurchaseView {
  id: string;
  kind: CardTransactionKind;
  status: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  amountMinor: number;
  currency: string;
  cardAccountId: string;
  description: string;
  merchantName: string;
  merchantKey: string;
  category: string;
  spendingCategory: string;
  exclusion: CardSpendingExclusion;
}

/** An owner rule, with what it takes out of spending now (every card, every date). */
export interface SpendingRuleView extends CardSpendingRule {
  covers: { purchases: number; refunds: number; netMinor: number };
}

/** What counts as spending in a view: the accounting per currency, the suggestions and asset purchases in it, the rules. */
export interface SpendingAccountingResponse {
  accounting: CardSpendingAccounting[];
  suggestions: AssetSuggestionView[];
  assetPurchases: AssetPurchaseView[];
  rules: { installed: boolean; items: SpendingRuleView[] };
}

export interface SpendingRuleInput {
  merchantClass: CardMetalsMerchantClass;
  currency: string;
  minAmountMinor: number;
}

/** What a rule's preview matched (how many rows, their net, which): the owner makes the rule they saw. */
export interface SpendingRuleMatch {
  count: number;
  netMinor: number;
  digest: string;
}

/** A rule's preview as the API answers it: its figures, and its match. */
export type SpendingRulePreview = Omit<CardSpendingRulePreview, 'rowIds'> & { match: SpendingRuleMatch };

export interface CardTransactionDetailResponse {
  transaction: CardTransactionCategorized;
  cardAccount: CardAccount | null;
  importBatch: CardImportBatch | null;
  /** For a pending row: posted rows that may be its posted version. Suggestions only. */
  possiblyPostedAs: CardTransactionView[];
  /**
   * For a payment to the card: brokerage withdrawals and transfers out of the
   * same amount and currency, a few days around it. Suggestions only; nothing
   * is linked and brokerage cash does not change.
   */
  possiblyPaidFrom?: CardPaymentSourceView[];
  /** The row's Amazon order, when the app reads Amazon orders: absent from APIs that predate it. */
  amazon?: AmazonCardDetail;
}

/** A payment to a card as the reconciliation shows it. */
export interface ReconciledPayment {
  id: string;
  cardAccountId: string;
  /** The card row's transaction date. */
  date: string;
  amountMinor: number;
  currency: string;
  /** The card row's description, every number cut to its last four; absent when it cannot be shown. */
  description?: string;
}

/** A checking debit as the reconciliation shows it: its payee read from the descriptor, every number in it cut to its last four. */
export interface ReconciledDebit {
  id: string;
  checkingAccountId: string;
  /** The checking account's display name. */
  accountLabel: string;
  date: string;
  amountMinor: number;
  currency: string;
  class: CheckingDebitClass;
  payee: string | null;
  payeeLabel: string | null;
  descriptor?: string;
}

export interface ReconciledDebitOption extends ReconciledDebit {
  /** Days from the payment to the debit; negative when the debit came first. */
  dayOffset: number;
}

/** A card row that added a payment's amount back (the card taking it back), with the days from the payment to it. */
export interface ReconciledReversal extends ReconciledPayment {
  dayOffset: number;
}

/** Where one payment to a card stands against the checking debits. */
export type PaymentMatchView =
  /** `evidence`: why the rules matched it inside a group they hold for the owner (absent from APIs that predate it). */
  | { status: 'matched' | 'confirmed'; debit: ReconciledDebitOption; decisionId?: string; evidence?: CardPaymentPairEvidence }
  | { status: 'ambiguous'; candidates: ReconciledDebitOption[]; otherPayments: number }
  | {
    status: 'unmatched';
    reason: UnmatchedPaymentReason;
    possibleDebits: ReconciledDebitOption[];
    /** The card's own rows adding this amount back that the rules settle nothing on (a hint; absent when none). */
    possibleReversals?: ReconciledReversal[];
  }
  /** The card took it back: never paid, so no checking debit is owed. */
  | { status: 'returned'; reversal: ReconciledReversal }
  | { status: 'elsewhere'; decisionId: string }
  | { status: 'pending' };

/** GET /spending/payment-reconciliation/payments/:id: where one card row stands against the checking debits. */
export interface PaymentMatchResponse {
  checking: { installed: boolean };
  decisions: { installed: boolean };
  /** Null for a row that is not a payment to the card, and while no checking account is imported. */
  paymentMatch: PaymentMatchView | null;
}

export interface CheckingAccountView {
  id: string;
  label: string;
  institution: string;
  last4: string | null;
  currency: string;
  status: string;
  coverage: CardCoverageRange[];
}

/** GET /spending/payment-reconciliation: every card payment against every checking debit, both sides, the whole history. */
export interface PaymentReconciliationResponse {
  rulesVersion: number;
  /** `returnDays` is absent from APIs that predate returned payments. */
  rules: { daysBefore: number; daysAfter: number; confirmDays: number; returnDays?: number };
  checking: { installed: boolean; accounts: CheckingAccountView[] };
  decisions: {
    installed: boolean;
    stale: StaleCardPaymentDecision[];
    /** Rejections, and answers that no longer fit their rows: what is left of their rows, for undoing them. */
    answers?: Array<{
      id: string;
      decision: CardPaymentDecisionKind;
      createdAt: string;
      stale?: StaleCardPaymentDecision['reason'];
      payment?: ReconciledPayment;
      debit?: ReconciledDebit;
    }>;
  };
  totals: CardPaymentReconciliationTotals[];
  /**
   * A pair the rules matched inside a group they hold for the owner says why (`evidence`: interchangeable rows, a payer
   * reference, or what was left); absent from APIs that predate it.
   */
  pairs: Array<{ status: 'matched' | 'confirmed'; dayOffset: number; decisionId?: string; evidence?: CardPaymentPairEvidence; payment: ReconciledPayment; debit: ReconciledDebit }>;
  ambiguous: Array<{
    id: string;
    payments: ReconciledPayment[];
    debits: ReconciledDebit[];
    candidates: Array<{ paymentId: string; debitId: string; dayOffset: number }>;
  }>;
  unmatchedPayments: Array<{
    payment: ReconciledPayment;
    reason: UnmatchedPaymentReason;
    possibleDebits: Array<{ debit: ReconciledDebit; dayOffset: number }>;
    /** Brokerage withdrawals or transfers out it may have come from (a hint; absent from APIs that predate it). */
    brokerageSuggestions?: number;
    /** The card's own rows adding this amount back that the rules settle nothing on (a hint; absent when none). */
    possibleReversals?: Array<{ reversal: ReconciledPayment; dayOffset: number }>;
  }>;
  unmatchedDebits: Array<{ debit: ReconciledDebit; reason: UnmatchedDebitReason; possiblePayments: Array<{ payment: ReconciledPayment; dayOffset: number }> }>;
  elsewhere: Array<{ payment: ReconciledPayment; decisionId: string }>;
  /** Payments the card itself took back, each with its reversal: no checking debit is owed (absent from APIs that predate it). */
  returned?: Array<{ payment: ReconciledPayment; reversal: ReconciledPayment; dayOffset: number }>;
  notCardPayments: Array<{ debit: ReconciledDebit; decisionId: string }>;
  /** Bilt housing pulls with no Bilt housing payment row: listed apart from card-payment debits. */
  biltHousing: Array<{ debit: ReconciledDebit; reason: UnmatchedDebitReason; possiblePayments: Array<{ payment: ReconciledPayment; dayOffset: number }> }>;
}

/** The owner's word on a payment and a debit, as POST /spending/payment-reconciliation/decisions takes it. */
export type PaymentDecisionInput =
  | { decision: 'confirmed' | 'rejected'; cardTransactionId: string; checkingTransactionId: string }
  | { decision: 'elsewhere'; cardTransactionId: string }
  | { decision: 'not-card-payment'; checkingTransactionId: string };

export interface PaymentDecisionView {
  id: string;
  decision: CardPaymentDecisionKind;
  cardTransactionId: string | null;
  checkingTransactionId: string | null;
  amountMinor: number;
  currency: string;
  createdAt: string;
  rulesVersion: number;
  /** For a confirmed or rejected pair: whole days from the payment to the debit. */
  dayOffset: number | null;
  revokedAt: string | null;
}

/** One line of a linked Amazon order; a title the API will not show is null. */
export interface AmazonOrderItem {
  itemRef: string;
  title: string | null;
  quantity: number | null;
  asin: string | null;
  /** True only when Holdr's owner-only cache holds the item's product thumbnail. */
  image?: boolean;
}

/**
 * A row's Amazon order: whether one is linked (and how it was tied), held or none; how Spending's reports file
 * the row (its parts, or whole and why); the order's items for a linked row; for a held one only why and how many
 * candidates.
 */
export interface AmazonCardDetail {
  version: string;
  match: 'linked' | 'held' | 'none';
  evidenceClass?: CardCategoryEvidenceClass;
  aggregate: 'split' | 'whole-row-user-category' | 'whole-row-declined' | 'whole-row-invalid' | 'whole-row-not-linked';
  wholeRowReason?: CardCategoryHoldReason | CardCategoryInvalidReason;
  parts?: CardCategoryPart[];
  items?: AmazonOrderItem[];
  orderRefs?: string[];
  hold?: { reason: CardCategoryHoldReason; candidateCount: number };
  coverage: { complete: boolean; provenFrom?: string; provenTo?: string };
}

export interface CardTransactionChange {
  userCategory?: string | null;
  notes?: string | null;
  status?: 'pending' | 'removed';
  /** On its own: this pending row posted as that posted row (it is dismissed and kept). */
  postedAs?: string;
}

/** Per kind: how many rows and their signed sum, as the import's totals give them. */
export interface CardImportKindTotal {
  count: number;
  amountMinor: number;
}

export interface CardImportTotalsSummary {
  count: number;
  chargesMinor: number;
  creditsMinor: number;
  netMinor: number;
  byKind?: Partial<Record<CardTransactionKind, CardImportKindTotal>>;
}

/** A stored row as the import preview shows it: what tells it apart, no keys. */
export interface CardImportStoredRow {
  id: string;
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted' | 'removed';
  dismissed: boolean;
  amountMinor: number;
  currency: string;
  description: string;
  merchant: string | null;
}

/** One posted row of the file whose fingerprint names a stored pending (or dismissed) row. */
export interface CardImportPendingMatch {
  /** The file's row. */
  row: number;
  pending: CardImportStoredRow;
  /** Stored posted rows with the same date, amount and description that no row of the file is: maybe this purchase again. */
  postedTwinCount: number;
  postedTwins: CardImportStoredRow[];
  /** Stored posted rows like it that another row of the file is (by its key): no sign that this row repeats one. */
  postedTwinsInFileCount?: number;
}

export interface CardImportPreviewResponse {
  cardAccountId: string;
  issuer: string;
  coverage: { start: string; end: string };
  dateRange: { start: string; end: string } | null;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  pendingPostedCount: number;
  /** Posted rows without a reference whose fingerprint names a stored pending (or dismissed) row: the owner decides (pendingMatches). */
  pendingMatchCount: number;
  pendingMatchDetails?: CardImportPendingMatch[];
  /** Matches with a stored posted twin: adding them as other purchases is refused. */
  pendingMatchesWithPostedTwinCount?: number;
  /** Posted rows whose issuer reference names a pending row the owner dismissed: the owner decides (dismissedMatches). */
  dismissedMatchCount: number;
  /**
   * Stored pending rows an import without pending rows leaves out (dated in it, a week or more before
   * it ends): unconfirmed, not proven cancelled; dismissed only on the owner's word (stalePending=dismiss).
   */
  stalePendingCount?: number;
  stalePendingRows?: CardImportStoredRow[];
  possibleDuplicateCount: number;
  conflictCount: number;
  rejectedCount: number;
  /**
   * Rows held for review (E2d): they look like card transactions the browser extension synced, or would post a
   * pending charge that such a transaction may already be. Not imported, neither new nor duplicates, until their
   * owner decides in the card sync review. In a commit's answer, what it held.
   */
  heldCount?: number;
  heldRows?: number[];
  /**
   * The card sync review items the import stores: one per held row, and one per row whose stored reference shows
   * details the stored row doesn't have (that row is kept as it is, and the file's row counts as already stored).
   */
  reviewCount?: number;
  /** The rows of that second kind (the held ones are `heldRows`). */
  reviewRows?: number[];
  /** Binds a commit to this preview: echoed back, any change to the card's ledger since is a 409 (preview again). */
  previewDigest?: string;
  totals: { posted: CardImportTotalsSummary; pending: CardImportTotalsSummary };
  newTotals: { posted: CardImportTotalsSummary; pending: CardImportTotalsSummary };
  reconciliation: { status: 'unchecked' | 'match' | 'mismatch' };
  warnings: Array<{ code: string; message: string }>;
}

/** A commit's answer: its counts are what it did (E2d), held rows and review items included. */
export interface CardImportCommitResponse extends CardImportPreviewResponse {
  imported: boolean;
  batch: CardImportBatch | null;
  pendingMatchesInsertedCount?: number;
  stalePendingDismissedCount?: number;
}

export interface CardAccountDraft {
  issuer: string;
  owner: CardOwner;
  currency: string;
  last4?: string;
  /** The five digits American Express shows; implies last4. */
  last5?: string;
  nickname?: string;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function filterParams(filters: SpendingFilters) {
  return {
    from: filters.from,
    to: filters.to,
    owner: filters.owner,
    cardAccountId: filters.cardAccountId,
    category: filters.category,
    merchant: filters.merchant,
    q: filters.q?.trim() || undefined,
    categoryBasis: filters.categoryBasis,
  };
}

export function fetchCardAccounts(): Promise<CardAccount[]> {
  // Labels stay unique among all the cards known, closed ones too (cardDisplayNames).
  return api<{ cardAccounts: CardAccount[] }>('/card-accounts').then((body) => {
    rememberCardAccounts(body.cardAccounts);
    return body.cardAccounts;
  });
}

export function updateCardAccountStatus(id: string, status: CardAccount['status']): Promise<CardAccount> {
  return api<CardAccount>(`/card-accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }).then((account) => {
    rememberCardAccounts([account]);
    return account;
  });
}

/** Posted spending only; pending charges are in `pending`, never in the totals. */
export function fetchSpendingSummary(filters: SpendingFilters): Promise<SpendingSummaryResponse> {
  return api<SpendingSummaryResponse>(`/spending/summary${query(filterParams(filters))}`);
}

/** What counts for the same filters as the summary: the parts of the card activity, suggestions, asset purchases, rules. */
export function fetchSpendingAccounting(filters: SpendingFilters): Promise<SpendingAccountingResponse> {
  return api<SpendingAccountingResponse>(`/spending/accounting${query(filterParams(filters))}`);
}

/** What an owner rule would take out of spending now, before the owner makes it, with the match a rule made from it carries. */
export function previewSpendingRule(input: SpendingRuleInput): Promise<SpendingRulePreview> {
  return api<{ preview: SpendingRulePreview }>(`/spending/rules/preview${query({ ...input })}`).then((body) => body.preview);
}

/**
 * Makes the rule the owner previewed: `preview` is that preview's match, and the API refuses the rule (409,
 * `isRulePreviewStale`) when it would now take out anything but what that preview showed.
 */
export function createSpendingRule(input: SpendingRuleInput, preview: SpendingRuleMatch): Promise<CardSpendingRule> {
  return api<{ rule: CardSpendingRule }>('/spending/rules', { method: 'POST', body: { ...input, preview } }).then((body) => body.rule);
}

/** A rule refused because what it would take out changed since its preview: nothing was made; preview it again. */
export function isRulePreviewStale(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  try {
    const body: unknown = JSON.parse(error.body);
    return typeof body === 'object' && body !== null && (body as { reason?: unknown }).reason === 'preview-stale';
  } catch {
    return false;
  }
}

export function revokeSpendingRule(id: string): Promise<CardSpendingRule> {
  return api<{ rule: CardSpendingRule }>(`/spending/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((body) => body.rule);
}

export function fetchCardTransactions(
  filters: SpendingFilters,
  options: { status: 'pending' | 'posted'; limit: number; offset?: number },
): Promise<CardTransactionPageResponse> {
  return api<CardTransactionPageResponse>(`/card-transactions${query({
    ...filterParams(filters),
    amazon: filters.amazon,
    currency: filters.amazon ? filters.amazonCurrency : undefined,
    status: options.status,
    limit: options.limit,
    offset: options.offset,
  })}`);
}

export function fetchCardTransaction(id: string, categoryBasis?: CardCategoryBasis): Promise<CardTransactionDetailResponse> {
  return api<CardTransactionDetailResponse>(`/card-transactions/${encodeURIComponent(id)}${query({ categoryBasis })}`);
}

export function updateCardTransaction(id: string, change: CardTransactionChange): Promise<CardTransactionView> {
  return api<CardTransactionView>(`/card-transactions/${encodeURIComponent(id)}`, { method: 'PATCH', body: change });
}

export function fetchSpendingCoverage(): Promise<CardAccountCoverage[]> {
  return api<{ cards: CardAccountCoverage[] }>('/spending/coverage').then((body) => body.cards);
}

/** Every card payment against the checking debits that paid it, both sides, the whole history. */
export function fetchPaymentReconciliation(): Promise<PaymentReconciliationResponse> {
  return api<PaymentReconciliationResponse>('/spending/payment-reconciliation');
}

/** Where one card row stands against the checking debits (a payment's details read it on their own). */
export function fetchPaymentMatch(id: string): Promise<PaymentMatchResponse> {
  return api<PaymentMatchResponse>(`/spending/payment-reconciliation/payments/${encodeURIComponent(id)}`);
}

/** The owner's word on a payment and a debit; a 409 when either already has a decision in force, or before the operator install. */
export function decideCardPayment(input: PaymentDecisionInput): Promise<PaymentDecisionView> {
  return api<{ decision: PaymentDecisionView }>('/spending/payment-reconciliation/decisions', { method: 'POST', body: input })
    .then((body) => body.decision);
}

/** Undoes a decision (it is kept, undone): the rows are matched by the rules again. */
export function undoCardPaymentDecision(id: string): Promise<PaymentDecisionView> {
  return api<{ decision: PaymentDecisionView }>(`/spending/payment-reconciliation/decisions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then((body) => body.decision);
}

export function fetchSpendingInsights(options: {
  month: string;
  today: string;
  /** The period and its baseline; without them, the month against the month before. */
  from?: string;
  to?: string;
  baselineFrom?: string;
  baselineTo?: string;
  owner?: CardOwner;
  cardAccountId?: string;
  categoryBasis?: CardCategoryBasis;
}): Promise<SpendingInsightsResponse> {
  return api<SpendingInsightsResponse>(`/spending/insights${query(options)}`);
}

export function createCardAccount(draft: CardAccountDraft): Promise<CardAccount> {
  // Known as soon as it is created (an import's preview creates one): every card's name is made again with it.
  return api<CardAccount>('/card-accounts', { method: 'POST', body: draft }).then((account) => {
    rememberCardAccounts([account]);
    return account;
  });
}

/** The redacted JSON goes up as the file's own text; the API re-checks all of it. */
export function previewCardImport(cardAccountId: string, json: string): Promise<CardImportPreviewResponse> {
  return apiRaw<CardImportPreviewResponse>(
    `/card-imports/preview${query({ cardAccountId })}`,
    json,
    { 'Content-Type': 'application/json' },
  );
}

export function commitCardImport(
  cardAccountId: string,
  json: string,
  options: {
    possibleDuplicates?: 'skip' | 'import';
    pendingMatches?: 'post' | 'skip' | 'split' | 'import';
    dismissedMatches?: 'post' | 'keep';
    stalePending?: 'dismiss' | 'keep';
    acceptMismatch?: boolean;
    /** The preview's `previewDigest`: the commit then refuses (409) if anything changed since that preview. */
    previewDigest?: string;
  },
): Promise<CardImportCommitResponse> {
  return apiRaw<CardImportCommitResponse>(
    `/card-imports/commit${query({
      cardAccountId,
      possibleDuplicates: options.possibleDuplicates,
      pendingMatches: options.pendingMatches,
      dismissedMatches: options.dismissedMatches,
      stalePending: options.stalePending,
      acceptMismatch: options.acceptMismatch ? 'true' : undefined,
      previewDigest: options.previewDigest,
    })}`,
    json,
    { 'Content-Type': 'application/json' },
  );
}

/** The keys of the commit's 409 bodies that ask for a new preview (one per kind; `cardSpending.ts` decisionRequired). */
const OUTDATED_PREVIEW_KEYS = ['previewDigest', 'stalePendingCount', 'possibleDuplicateCount', 'pendingMatchCount', 'dismissedMatchCount',
  'reconciliation'] as const;

/**
 * A commit refused because the import is no longer the one its preview showed: the card's ledger changed
 * (`preview-stale`), the stale pending rows changed, or the repository's own classification asks a question the
 * preview didn't. The repository decides inside its transaction (design §4.10.4), so nothing was written, and a new
 * preview asks again.
 */
export function isImportPreviewOutdated(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  try {
    const body: unknown = JSON.parse(error.body);
    return typeof body === 'object' && body !== null && OUTDATED_PREVIEW_KEYS.some((key) => key in body);
  } catch {
    return false;
  }
}

/** What the owner types here, as a card data refusal names it: notes, categories, nicknames, filters. */
const TYPED_PATH = /^(?:\$\.(?:notes|userCategory|nickname)|query\.(?:q|category|merchant))$/;
/** Typed text is refused rather than shortened, so the import tool's advice does not apply to it. */
export const TYPED_CARD_DATA_MESSAGE = 'Holdr doesn\'t keep card details: remove card, account and other long numbers '
  + '(the last four digits are fine), and any security code, PIN or expiry date.';

/** The API's `{ error }` text from a failed call, without the status prefix. */
export function apiErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const body = text.replace(/^\d{3}[^:]*:\s*/, '');
  try {
    const parsed = JSON.parse(body) as { error?: unknown; paths?: unknown };
    const paths = Array.isArray(parsed.paths) ? parsed.paths : [];
    if (paths.length > 0 && paths.every((path) => typeof path === 'string' && TYPED_PATH.test(path))) {
      return TYPED_CARD_DATA_MESSAGE;
    }
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body || text;
}
