import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  CARD_CATEGORY_ITEM_REF,
  CARD_UNCATEGORIZED,
  MAX_CARD_CATEGORY_PARTS,
  amazonCardChargeKind,
  buildCardCategoryInference,
  buildCardSpendingAccounting,
  cardCategoryBasisMarkerFor,
  cardCategoryBasisWithoutSplits,
  cardCategoryInferable,
  cardCategoryInferenceMarker,
  cardCategoryPortion,
  cardCategoryRowSource,
  cardCategorySplitView,
  cardMerchantKey,
  cardMonthInsightPeriod,
  cardPaymentSourceWindow,
  cardSpendingExclusionOf,
  cardSpendingRole,
  computeCardInsights,
  countCardCategoryRowSources,
  countCardPaymentSources,
  effectiveCardMerchant,
  isCardCategoryBasis,
  isCardAssetCategory,
  isCardCategoryEvidenceClass,
  isCardCategoryHoldReason,
  isCardPaymentToCard,
  primaryCardCurrency,
  readCardSpendingRow,
  readCardSpendingRows,
  resolveCardCategorySplits,
  resolveCardSpendingExclusions,
  suggestCardAssetPurchases,
  suggestCardPaymentSources,
  summarizeCardSpending,
  toCardTransactionView,
  withCardSpendingExclusion,
  type CardAssetSuggestion,
  type CardCategoryBasis,
  type CardCategoryBasisMarker,
  type CardCategoryEvidenceClass,
  type CardCategoryHoldReason,
  type CardCategoryInference,
  type CardCategoryInferenceModel,
  type CardCategoryInvalidReason,
  type CardCategoryOutcome,
  type CardCategoryPart,
  type CardCategoryResolver,
  type CardCategoryResolverSnapshot,
  type CardCategorySplits,
  type CardOwner,
  type CardPaymentSourceCount,
  type CardPaymentSourceView,
  type CardOrderLinks,
  type CardSpendingExclusion,
  type CardSpendingRule,
  type CardTransaction,
  type CardTransactionKind,
  type CardTransactionStatus,
  type Account,
  type CardInsightPeriod,
  type CashEvent,
} from '@finance-tracker/shared';
import {
  CARD_DATA_MESSAGE,
  HttpError,
  cardGuardRefusal,
  isPlainObject,
  jsonBody,
  looksLikeCardData,
  queryParams,
  readBody,
  rejectCardData,
  repositoryError,
  scanIdParam,
  scanQuery,
  sessionActorRef,
} from './cardSpending.js';
import {
  MAX_CARD_TRANSACTION_PAGE,
  type CardTransactionPatch,
  type CardTransactionQuery,
  type CardTransactionSort,
  type SqliteStateRepo,
} from '../services/sqliteStateRepo.js';
import { HoldrRefusal } from '../services/dbErrors.js';

/**
 * Reading stored card spending, for the Spending tab. Served only through
 * `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`:
 *
 *   mountCardSpendingRoutes(app, { repo, requireAuth, routers: [createCardTransactionsRouter(repo)] })
 *
 * so these routes sit behind the same required auth middleware, body-parser
 * skip and value-free error handler as the import routes.
 *
 *   GET   /card-transactions                  → { transactions, total, limit, offset, nextOffset }
 *         ?cardAccountId= &owner=alex|casey|joint &status=pending,posted,removed (default pending,posted)
 *         &kind=purchase,refund,… &category= &merchant= &q= &from=YYYY-MM-DD &to=YYYY-MM-DD
 *         (`kind`: the kind Spending reads the row as, below)
 *         &sort=date-desc|date-asc|amount-desc|amount-asc &limit=1…200 (default 50) &offset=
 *   GET   /card-transactions/:id              → { transaction, cardAccount, importBatch, possiblyPostedAs, possiblyPaidFrom,
 *         ?categoryBasis=enriched|original      amazon? }: with a category source, the row's Amazon match (linked,
 *                                               held or none), how it was tied (evidence class), how enriched reports
 *                                               file it (split, or whole and why), its accepted parts, and for a linked
 *                                               row its order's items (title, quantity, ASIN, and `image` when a
 *                                               thumbnail is cached); a held row only its
 *                                               fixed reason and candidate count. `amazon` does not depend on the
 *                                               basis; an enriched `transaction` says where its category comes from
 *   PATCH /card-transactions/:id              → transaction; body { userCategory?, notes?, status?: 'pending'|'removed' },
 *         or { postedAs: id } alone: the owner's word that this pending row posted as that posted row
 *   GET   /spending/summary                   → totals, pending, by month (and owner) / category / merchant / card / owner,
 *         ?cardAccountId= &owner= &category=     and per currency how many posted card payments look paid from
 *         &merchant= &q= &from= &to=             brokerage cash (paymentsPossiblyPaidFrom)
 *   GET   /spending/coverage                  → { cards: [{ cardAccountId, ranges, transactions, imports }] }
 *   GET   /spending/insights                  → for a period against its baseline: pace, large one-off purchases,
 *         ?month=YYYY-MM &today=YYYY-MM-DD      category and merchant movers, recurring charges and their changes,
 *         &from= &to= &baselineFrom=            possible duplicates, large charges at new merchants, pending
 *         &baselineTo= &cardAccountId=          refunds, fees and interest; without from and to, the month
 *         &owner= &currency=                    against the month before
 *   GET   /spending/accounting                → what counts: per currency, the view's posted card activity split into
 *         (the summary's filters)               spending, not spending (asset purchases, other rows) and transfers,
 *                                               each with net, charges, credits and count, so the parts add up to the
 *                                               activity; pending apart; what the suggestions shown would take out
 *                                               (`possibleAssetPurchases`); the suggested rows in view; the asset
 *                                               purchases in view; and the owner rules (`installed: false` while their
 *                                               table is not installed)
 *
 * What counts as spending (cardSpendingExclusions.ts): a spending row the owner filed under "Precious metals", a
 * purchase an owner rule in force covers (routes/cardSpendingRules.ts), and the exact, unambiguous refund of either
 * are asset purchases: role `excluded` with an `exclusion` object in every row view, and out of every spending figure
 * of the summary (whose totals then carry `assetPurchasesMinor` and `assetPurchaseCount`) and of the insights, on
 * either category basis. Suggestions never change any of that. Every other answer is exactly as before.
 *
 * Every answer here, and the overview's and the forecast's beside it, reads a row's kind as Spending does (shared
 * `effectiveCardKind`): a charge that takes a payment to the card back ("RETURNED ONLINE ACH PAYMENT": the bank
 * returned the payment and the issuer debited it again) is a card payment, whatever kind it was stored with. It
 * counts with the payments, against the payment it reverses, never as spending, and the row's views carry that kind
 * and its role; a fee for it stays a fee, and a row the owner filed under a category of their own keeps its stored kind.
 * A row stored as a card payment that names a fee is read as the import classifier kinds it now, by the same rule: a fee
 * for a payment ("NSF PAYMENT FEE"), the adjustment that gives one back, or a biller's own fee, a purchase.
 * Nothing is written: the stored row, its amount and its kind stay as imported.
 *
 * The list, the summary and the insights also take `&categoryBasis=enriched|original` (default enriched) and
 * answer with a `categoryBasis` marker (cardCategoryParts.ts). With a category resolver configured (the Amazon
 * domain's, in the app), `enriched` files a split purchase or refund under its parts'
 * categories: the summary's `byCategory`, the insights' category movers and a large purchase's category; a
 * category filter then picks parts (`categoryPortionMinor` on listed rows), and split rows carry `split`.
 * Totals, months, merchants, cards, owners, row counts and order stay the ledger's. Without a resolver, or for
 * `original`, every answer is exactly the one without splits, and the marker says so. A marker counts what its
 * own answer reports: the summary's rows, the list's page, the rows whose categories the insights read, and
 * under a category filter only the parts in it; its split rows are counted by evidence class as well. With a source
 * that describes rows and orders (the Amazon domain's), an enriched answer's large one-off split (the insights', and
 * the overview's beside it) also reads its order links, the household's whatever the view: a credit one of whose
 * orders has a charge linked to a card row is set only against one of those charges; any other credit goes by the
 * merchant rule alone, as on the original basis.
 *
 * `enriched` also infers a category for a spending row, or a split's residual, with neither the owner's nor an
 * issuer's (cardCategoryInference.ts: the household's merchant history, then reviewed generic rules), learned per
 * request from every card row, and files a tax paid by card under Taxes over its issuer's category (a reviewed rule
 * that takes precedence over the issuer's): user > Amazon item parts > tax rule > issuer > inferred > Uncategorized.
 * Its rows carry `categorySource` and, when inferred (the tax rule's included), `category` and `categoryInference`; a
 * category filter matches inferred categories; the marker adds `rowsBySource` and `inference` (rules version, inferred
 * rows by basis), and says `enriched` once a row is split or inferred. `original` answers infer nothing and carry none
 * of these fields.
 *
 * Same rules as the import routes: card data in the query, the :id or the
 * body is a 422 with paths only, before any other answer; unknown parameters
 * and keys are refused, errors never echo input, and nothing logs a query or
 * body. Spending totals count posted rows only; pending rows are totalled on
 * their own and never added in. Card payments are transfers. A pending row
 * whose posted version came under another reference is only suggested
 * (`possiblyPostedAs`), never changed by itself: the owner dismisses it, or
 * names its posted row (`postedAs`), which dismisses it and keeps it, so its
 * dedupe key still answers for it on any later import. A payment to
 * the card is only matched, as a suggestion, with the brokerage withdrawals
 * and outgoing transfers it may have come from (`possiblyPaidFrom`): read at
 * query time from brokerage account names and cash events, shown without
 * ids or account numbers, and with a name or description only when it has
 * no digits or hidden characters. Nothing here writes brokerage accounts,
 * cash, cash history, holdings or returns, or reads anything else of them.
 */

const TRANSACTION_BODY_LIMIT_BYTES = 16 * 1024;
const PATCH_KEYS = new Set(['userCategory', 'notes', 'status', 'postedAs']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OWNERS = new Set<CardOwner>(['alex', 'casey', 'joint']);
const STATUSES = new Set<CardTransactionStatus>(['pending', 'posted', 'removed']);
const KINDS = new Set<CardTransactionKind>(['purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other']);
const SORTS = new Set<CardTransactionSort>(['date-desc', 'date-asc', 'amount-desc', 'amount-asc']);
const FILTER_PARAMS = ['cardAccountId', 'owner', 'category', 'merchant', 'q', 'from', 'to', 'categoryBasis'] as const;
const LIST_PARAMS = [...FILTER_PARAMS, 'status', 'kind', 'sort', 'limit', 'offset', 'amazon', 'currency'] as const;
const INSIGHT_PARAMS = ['cardAccountId', 'owner', 'month', 'today', 'currency', 'from', 'to', 'baselineFrom', 'baselineTo', 'categoryBasis'] as const;
/** Every query name these routes take: a card-data hit names them in its paths. */
const QUERY_NAMES = [...new Set<string>([...LIST_PARAMS, ...INSIGHT_PARAMS])];
const MAX_OFFSET = 1_000_000;
const TEXT_LIMITS = { category: 100, merchant: 500, q: 100 } as const;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function list<T extends string>(value: string, allowed: ReadonlySet<T>, name: string): T[] {
  const items = value.split(',').map((item) => item.trim());
  if (items.length === 0 || items.some((item) => !allowed.has(item as T))) {
    throw new HttpError(400, `${name} must be a comma-separated list of ${[...allowed].join(', ')}`);
  }
  return [...new Set(items as T[])];
}

export function text(value: string, name: keyof typeof TEXT_LIMITS): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > TEXT_LIMITS[name]) throw new HttpError(400, `${name} must be at most ${TEXT_LIMITS[name]} characters`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new HttpError(400, `${name} must not contain control characters`);
  return trimmed;
}

function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function filterQuery(repo: SqliteStateRepo, query: Map<string, string>): CardTransactionQuery {
  const filter: CardTransactionQuery = {};
  const cardAccountId = query.get('cardAccountId');
  if (cardAccountId !== undefined) {
    if (!ID.test(cardAccountId)) throw new HttpError(400, 'cardAccountId is invalid');
    if (!repo.getCardAccount(cardAccountId)) throw new HttpError(404, 'card account not found');
    filter.cardAccountId = cardAccountId;
  }
  const owner = query.get('owner');
  if (owner !== undefined) {
    if (!OWNERS.has(owner as CardOwner)) throw new HttpError(400, 'owner must be alex, casey or joint');
    filter.owner = owner as CardOwner;
  }
  const category = query.get('category');
  if (category !== undefined) filter.category = text(category, 'category');
  const merchant = query.get('merchant');
  if (merchant !== undefined) filter.merchant = text(merchant, 'merchant');
  const search = query.get('q');
  if (search !== undefined) filter.search = text(search, 'q');
  for (const bound of ['from', 'to'] as const) {
    const value = query.get(bound);
    if (value === undefined) continue;
    if (!isIsoDate(value)) throw new HttpError(400, `${bound} must be a valid YYYY-MM-DD date`);
    filter[bound] = value;
  }
  if (filter.from && filter.to && filter.from > filter.to) throw new HttpError(400, 'from must not be after to');
  return filter;
}

function transactionId(req: Request): string {
  const raw: unknown = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  if (looksLikeCardData(id)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.id'] });
  if (!ID.test(id)) throw new HttpError(404, 'card transaction not found');
  return id;
}

/** Which categories the answer files amounts under: `enriched` (split parts, where a resolver accepts any) unless asked. */
function categoryBasisOf(query: Map<string, string>): CardCategoryBasis {
  const value = query.get('categoryBasis');
  if (value === undefined) return 'enriched';
  if (!isCardCategoryBasis(value)) throw new HttpError(400, 'categoryBasis must be enriched or original');
  return value;
}

/**
 * A row as an enriched answer reads it: with the category inferred for it, where it has none of its own or a rule files
 * it over its issuer's (a tax payment).
 */
type ReadRow = CardTransaction & { inferredCategory?: string | null };

/** Rows as an enriched answer reads them, and what was inferred for which (by row id). */
function inferAll(rows: readonly CardTransaction[], model: CardCategoryInferenceModel): {
  rows: ReadRow[];
  inferred: ReadonlyMap<string, CardCategoryInference>;
} {
  const inferred = new Map<string, CardCategoryInference>();
  const read = rows.map((row): ReadRow => {
    const inference = model.infer(row);
    if (!inference) return row;
    inferred.set(row.id, inference);
    return { ...row, inferredCategory: inference.category };
  });
  return { rows: read, inferred };
}

/**
 * What a category source says of one card row, for its detail: the Amazon domain's `getCardDetail`
 * (services/amazon/resolver.ts), from the same snapshot as its splits. Read as untrusted input: every field is
 * checked again before it is shown.
 */
export interface CardCategorySourceDetail {
  version: string;
  match: 'linked' | 'held' | 'none';
  /** Linked rows: how the order was tied to the row. */
  evidenceClass?: CardCategoryEvidenceClass;
  /** Linked rows: every line of the linked order(s); `image` when the owner-only cache holds the item's thumbnail. */
  items?: ReadonlyArray<{ itemRef: string; title: string; quantity: number | null; asin: string | null; image?: boolean }>;
  /** Linked rows: the linked orders' opaque references. */
  orderRefs?: readonly string[];
  /** Held rows: the fixed reason and how many candidates, and nothing else. */
  hold?: { reason: CardCategoryHoldReason; candidateCount: number };
  coverage?: { complete: boolean; provenFrom?: string; provenTo?: string };
}

/** A category source whose snapshots also describe a single row, as the Amazon domain's do. */
export interface CardCategorySource extends CardCategoryResolver {
  snapshot(): SourceSnapshot;
}

type SourceSnapshot = CardCategoryResolverSnapshot & {
  getCardDetail?: (id: string) => CardCategorySourceDetail;
  /**
   * The card rows an order is matched to (the Amazon domain's `getOrderMatches`, from the same snapshot): linked to a
   * row, or held. Read as untrusted input: only `state` and a linked match's `cardTransactionId` are read.
   */
  getOrderMatches?: (orderRef: string) => ReadonlyArray<{ state: string; cardTransactionId?: string }>;
  /**
   * The Amazon domain's own rule for an Amazon card charge that items can explain: a live, posted, positive purchase
   * whose descriptor is an itemizable Amazon one (amazonCardChargeKind). No period or currency: the caller scopes.
   */
  isAmazonCharge?: (id: string) => boolean;
  /**
   * Whether the source itself links a row to its evidence, said explicitly (the composite source's,
   * services/categorySources.ts). Read as untrusted input: only `true` links. Without it, a source that describes
   * rows links a row exactly when the row's detail says `linked`.
   */
  isLinkedRow?: (id: string) => boolean;
};

/** A charge Spending files under its Amazon items: split, with an item part (more than the rest of the charge). */
const itemizedIn = (splits: CardCategorySplits | null, id: string) =>
  splits?.parts.get(id)?.some((part) => part.classification !== 'residual') ?? false;

/** Per currency: the Amazon card charges among some rows, how many are itemized, and every other Amazon row apart. */
interface AmazonCoverageEntry {
  currency: string;
  /** Amazon card charges by the domain's rule; the itemized ones are filed under their items' categories. */
  charges: number;
  itemized: number;
  /** Amazon rows that are not such charges, each counted once, never dropped: */
  notItemizable: number;
  pending: number;
  refunds: number;
  other: number;
}

/**
 * How many of `rows`' Amazon card charges (the domain's rule) Spending files under their items, per currency, with
 * every other row the shared Amazon descriptor names counted apart, in the domain's order: refunds, other kinds,
 * pending, other statuses, nonpositive, then a descriptor no order is behind (Prime, Kindle, digital, music, a
 * delivery tip, Amazon Pay paying another merchant), so the denominator never shrinks quietly. Null without the
 * domain's rule: nothing is guessed.
 */
function amazonCoverage(rows: readonly CardTransaction[], snapshot: SourceSnapshot | null, splits: CardCategorySplits | null) {
  const isAmazonCharge = snapshot?.isAmazonCharge;
  if (!isAmazonCharge) return null;
  const byCurrency = new Map<string, AmazonCoverageEntry>();
  for (const row of rows) {
    const kind = amazonCardChargeKind({ description: row.description });
    if (kind === null) continue;
    const entry = byCurrency.get(row.currency)
      ?? { currency: row.currency, charges: 0, itemized: 0, notItemizable: 0, pending: 0, refunds: 0, other: 0 };
    if (isAmazonCharge(row.id)) {
      entry.charges += 1;
      if (itemizedIn(splits, row.id)) entry.itemized += 1;
    } else if (row.kind === 'refund') entry.refunds += 1;
    else if (row.kind === 'purchase' && row.status === 'pending') entry.pending += 1;
    else if (row.kind === 'purchase' && row.status === 'posted' && row.amountMinor > 0 && kind === 'not-itemizable') entry.notItemizable += 1;
    else entry.other += 1;
    byCurrency.set(row.currency, entry);
  }
  return [...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

/**
 * Per currency and category, what Amazon item parts (not residuals) put there among `rows`, and how many rows: the
 * part of each category an overview can call Amazon items. Under a category filter, that category's parts only.
 */
function fromAmazonItems(
  rows: readonly CardTransaction[],
  splits: CardCategorySplits | null,
  category: string | undefined,
  exclusions: ReadonlyMap<string, CardSpendingExclusion> | null,
) {
  const totals = new Map<string, { currency: string; category: string; amountMinor: number; rows: number }>();
  for (const row of rows) {
    const parts = splits?.parts.get(row.id);
    if (!parts || !summedByCategory(row, exclusions)) continue;
    const counted = new Set<string>();
    for (const part of parts) {
      if (part.classification === 'residual' || (category !== undefined && part.category !== category)) continue;
      const key = JSON.stringify([row.currency, part.category]);
      const entry = totals.get(key) ?? { currency: row.currency, category: part.category, amountMinor: 0, rows: 0 };
      entry.amountMinor += part.amountMinor;
      if (!counted.has(part.category)) {
        entry.rows += 1;
        counted.add(part.category);
      }
      totals.set(key, entry);
    }
  }
  return [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)
    || b.amountMinor - a.amountMinor || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

/** How enriched reports file a row: its parts, or whole for a fixed reason (contract §4). */
type AmazonAggregate = 'split' | 'whole-row-user-category' | 'whole-row-declined' | 'whole-row-invalid' | 'whole-row-not-linked';

/** The `amazon` object of a row's detail. */
export interface AmazonCardDetailView {
  version: string;
  match: 'linked' | 'held' | 'none';
  evidenceClass?: CardCategoryEvidenceClass;
  aggregate: AmazonAggregate;
  /** Why a declined or refused row stays whole. */
  wholeRowReason?: CardCategoryHoldReason | CardCategoryInvalidReason;
  /** The parts Spending accepted: filed under them, or (kept whole by the owner's category) listed only. */
  parts?: CardCategoryPart[];
  /**
   * Linked rows only; a title Spending will not show is null. `image` only when a thumbnail is cached, served by
   * `GET /amazon/items/:itemRef/image`.
   */
  items?: Array<{ itemRef: string; title: string | null; quantity: number | null; asin: string | null; image?: true }>;
  /** Linked rows only: the linked orders' opaque references (as `GET /amazon/orders/:ref` takes them). */
  orderRefs?: string[];
  /** Held rows only: never their candidates' items, amounts or orders. */
  hold?: { reason: CardCategoryHoldReason; candidateCount: number };
  coverage: { complete: boolean; provenFrom?: string; provenTo?: string };
}

/** Full product titles (the Amazon domain keeps up to 2048 characters); the UI may clamp them, never cut them. */
const MAX_TITLE_LENGTH = 2048;
/** What the domain puts in place of a title it will not publish. */
const REDACTED_TITLE = '[redacted]';
const ASIN = /^[A-Z0-9]{10}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Code points that render as nothing (a grapheme joiner, variation selectors, fillers), in any position. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * An Amazon item title as Spending shows it, on one line; null when the domain redacted it, or when it is longer
 * than the domain keeps, hides characters (before or after compatibility folding), or could carry card data (the
 * card-data detectors, as on every card text). Model names and numbers, and accented letters, stay.
 */
export function shownItemTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const line = title.replace(/\s+/g, ' ').trim();
  if (!line || line === REDACTED_TITLE || line.length > MAX_TITLE_LENGTH) return null;
  const folded = line.normalize('NFKC');
  if (HIDING.test(line) || HIDING.test(folded) || IGNORABLE.test(line) || IGNORABLE.test(folded)) return null;
  return looksLikeCardData(title) || looksLikeCardData(line) || looksLikeCardData(folded) ? null : line;
}

const count = (value: unknown, min: number): number | null =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : null);

/**
 * A row's `amazon` detail: the source's facts, checked field by field (anything malformed is left out, a held row
 * never gets items), with how enriched reports file the row by Spending's own validation of the same snapshot.
 */
function amazonDetailView(
  facts: CardCategorySourceDetail | undefined,
  version: string,
  outcome: CardCategoryOutcome | undefined,
): AmazonCardDetailView {
  const raw = (facts ?? {}) as Partial<Record<keyof CardCategorySourceDetail, unknown>>;
  const match = raw.match === 'linked' || raw.match === 'held' ? raw.match : 'none';
  let aggregate: AmazonAggregate = 'whole-row-not-linked';
  let wholeRowReason: CardCategoryHoldReason | CardCategoryInvalidReason | undefined;
  let parts: CardCategoryPart[] | undefined;
  if (outcome?.kind === 'split') {
    aggregate = 'split';
    parts = [...outcome.parts];
  } else if (outcome?.kind === 'kept-whole-by-user-category') {
    aggregate = 'whole-row-user-category';
    parts = outcome.parts ? [...outcome.parts] : undefined;
  } else if (outcome?.kind === 'held') {
    aggregate = 'whole-row-declined';
    wholeRowReason = outcome.reason;
  } else if (outcome?.kind === 'invalid') {
    aggregate = 'whole-row-invalid';
    wholeRowReason = outcome.reason;
  }
  const items = match === 'linked' && Array.isArray(raw.items)
    ? (raw.items as unknown[]).slice(0, MAX_CARD_CATEGORY_PARTS).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const { itemRef, title, quantity, asin, image } = item as Record<string, unknown>;
      if (typeof itemRef !== 'string' || !CARD_CATEGORY_ITEM_REF.test(itemRef)) return [];
      return [{ itemRef, title: shownItemTitle(title), quantity: count(quantity, 1), asin: typeof asin === 'string' && ASIN.test(asin) ? asin : null,
        ...(image === true ? { image: true as const } : {}) }];
    })
    : undefined;
  const orderRefs = match === 'linked' && Array.isArray(raw.orderRefs)
    ? (raw.orderRefs as unknown[]).filter((ref): ref is string => typeof ref === 'string' && CARD_CATEGORY_ITEM_REF.test(ref))
      .slice(0, MAX_CARD_CATEGORY_PARTS)
    : undefined;
  const hold = raw.hold as { reason?: unknown; candidateCount?: unknown } | undefined;
  const coverage = (typeof raw.coverage === 'object' && raw.coverage !== null ? raw.coverage : {}) as Record<string, unknown>;
  const day = (value: unknown) => (typeof value === 'string' && ISO_DATE.test(value) ? value : undefined);
  const provenFrom = day(coverage.provenFrom);
  const provenTo = day(coverage.provenTo);
  return {
    version,
    match,
    ...(match === 'linked' && isCardCategoryEvidenceClass(raw.evidenceClass) ? { evidenceClass: raw.evidenceClass } : {}),
    aggregate,
    ...(wholeRowReason ? { wholeRowReason } : {}),
    // Never a held or unmatched row's: only a linked order's items are presented as facts of the row.
    ...(parts && match === 'linked' ? { parts } : {}),
    ...(items ? { items } : {}),
    ...(orderRefs ? { orderRefs } : {}),
    ...(match === 'held' && hold && isCardCategoryHoldReason(hold.reason) && count(hold.candidateCount, 0) !== null
      ? { hold: { reason: hold.reason, candidateCount: count(hold.candidateCount, 0)! } } : {}),
    coverage: { complete: coverage.complete === true, ...(provenFrom ? { provenFrom } : {}), ...(provenTo ? { provenTo } : {}) },
  };
}

/** A row's view in an enriched answer: the category it is filed under, where that comes from and, if inferred, why. */
function categorizedView<T extends object>(
  view: T,
  row: CardTransaction,
  split: boolean,
  inferred: ReadonlyMap<string, CardCategoryInference>,
) {
  const inference = inferred.get(row.id);
  return {
    ...view,
    ...(inference ? { category: inference.category, categoryInference: inference } : {}),
    categorySource: cardCategoryRowSource(row, { split, inferred: inference !== undefined }),
  };
}

/**
 * A listed row, with its amount per category when it is split. In an enriched answer (`inferred` given) its
 * category is the one the answer files it under, with where that comes from and, when inferred, why; an original
 * answer's rows are exactly the ones before category bases.
 */
function rowView(
  row: CardTransaction,
  parts: readonly CardCategoryPart[] | undefined,
  inferred: ReadonlyMap<string, CardCategoryInference> | null = null,
) {
  const view = toCardTransactionView(row);
  const shown = parts ? { ...view, split: cardCategorySplitView(parts) } : view;
  return inferred ? categorizedView(shown, row, parts !== undefined, inferred) : shown;
}

/** Rows, each with whether the answer files it through its parts. */
const withSplits = (rows: readonly CardTransaction[], splits: CardCategorySplits | null) =>
  rows.map((row) => ({ row, split: splits?.parts.has(row.id) ?? false }));

/**
 * A listed row's Amazon order, in an enriched answer from a source that describes rows: the same checked `amazon`
 * object as its detail, for a row the source links (its items and, when split, its parts), and nothing for any
 * other row. Only rows the source answered for are looked up.
 */
function listedAmazon(row: CardTransaction, snapshot: SourceSnapshot | null, splits: CardCategorySplits | null): AmazonCardDetailView | null {
  const outcome = splits?.outcomes.get(row.id);
  if (!snapshot?.getCardDetail || !outcome) return null;
  const view = amazonDetailView(snapshot.getCardDetail(row.id), snapshot.version, outcome);
  return view.match === 'linked' ? view : null;
}

/**
 * The order links a source gives the large one-off split (`orderLinks`), from the request's one snapshot, the household's
 * whatever rows the split is given: the orders each row is linked to (`getCardDetail`'s `orderRefs`, checked as a row's
 * detail checks them), and each order's charges linked to a card row (`getOrderMatches`' linked rows that are charges,
 * a positive amount, among every card row). A credit whose orders have a linked charge is then set only against one of
 * those charges; any other goes by the merchant rule. Undefined without a source that answers both: every refund goes
 * by the merchant rule alone, the answer before order links.
 */
function sourceOrderLinks(snapshot: SourceSnapshot | null, household: () => readonly CardTransaction[]): CardOrderLinks | undefined {
  if (!snapshot?.getCardDetail || !snapshot.getOrderMatches) return undefined;
  let charges: ReadonlySet<string> | null = null;
  const isCharge = (id: string) => (charges ??= new Set(household().filter((row) => row.amountMinor > 0).map((row) => row.id))).has(id);
  return {
    orderRefsOf: (rowId) => {
      const raw = (snapshot.getCardDetail?.(rowId) ?? {}) as Partial<Record<keyof CardCategorySourceDetail, unknown>>;
      return raw.match === 'linked' && Array.isArray(raw.orderRefs)
        ? (raw.orderRefs as unknown[]).filter((ref): ref is string => typeof ref === 'string' && CARD_CATEGORY_ITEM_REF.test(ref))
        : [];
    },
    chargeIdsOf: (orderRef) => {
      const matches: unknown = snapshot.getOrderMatches?.(orderRef);
      return Array.isArray(matches) ? matches.flatMap((match: unknown) => {
        const { state, cardTransactionId } = (typeof match === 'object' && match !== null ? match : {}) as Record<string, unknown>;
        return state === 'linked' && typeof cardTransactionId === 'string' && isCharge(cardTransactionId) ? [cardTransactionId] : [];
      }) : [];
    },
  };
}

/**
 * An enriched answer's marker: the splits' marker, with the rows the answer files under a category counted by where
 * each one's category comes from, and the inferred ones by basis; `enriched` once any of them is split or inferred.
 */
function enrichedMarker(
  marker: CardCategoryBasisMarker,
  rows: ReadonlyArray<{ row: CardTransaction; split: boolean }>,
  inferred: ReadonlyMap<string, CardCategoryInference>,
): CardCategoryBasisMarker {
  const inferences: CardCategoryInference[] = [];
  const sources = rows.map(({ row, split }) => {
    const source = cardCategoryRowSource(row, { split, inferred: inferred.has(row.id) });
    const inference = inferred.get(row.id);
    if (source === 'inferred' && inference) inferences.push(inference);
    return source;
  });
  const rowsBySource = countCardCategoryRowSources(sources);
  return {
    ...marker,
    effective: marker.splitRows > 0 || rowsBySource.inferred > 0 ? 'enriched' : 'original',
    rowsBySource,
    inference: cardCategoryInferenceMarker(inferences),
  };
}

/** Rows a list shows with a category: every row but a card payment. */
const listedWithCategory = (row: CardTransaction) => cardSpendingRole(row.kind) !== 'transfer';
/** Rows a summary files under a category (its `byCategory`): posted spending, asset purchases aside (none: null). */
const summedByCategory = (row: CardTransaction, exclusions: ReadonlyMap<string, CardSpendingExclusion> | null) =>
  row.status === 'posted' && cardSpendingRole(row.kind) === 'spending' && (exclusions === null || !cardSpendingExclusionOf(row, exclusions));

/**
 * A row's view with how it counts: an asset purchase (the owner's category, an owner rule, an exact refund) or not.
 * With no asset purchases possible (null), the view exactly as before.
 */
const counted = <T extends ReturnType<typeof toCardTransactionView>>(view: T, row: CardTransaction, exclusions: ReadonlyMap<string, CardSpendingExclusion> | null) =>
  (exclusions === null ? view : withCardSpendingExclusion(view, cardSpendingExclusionOf(row, exclusions)));

/** The category a row is filed under on an answer's basis: the owner's, an inferred one (enriched), the issuer's, or none. */
function shownCategory(row: CardTransaction, model: CardCategoryInferenceModel | null): string {
  return row.userCategory || model?.infer(row)?.category || row.issuerCategory || CARD_UNCATEGORIZED;
}

/** The category a row would be filed under as spending: its own without the owner's asset category. */
function spendingCategory(row: CardTransaction, model: CardCategoryInferenceModel | null): string {
  return shownCategory(isCardAssetCategory(row.userCategory) ? { ...row, userCategory: undefined } : row, model);
}

/** A row's merchant as lists show it. */
function merchantOf(row: CardTransaction) {
  const merchantName = effectiveCardMerchant(row);
  return { description: row.description, merchantName, merchantKey: cardMerchantKey(merchantName) };
}

/**
 * A suggested row, with what the owner needs to decide on it: the merchant, and the category it is filed under now
 * (what "not metals" keeps, as the owner's own).
 */
function suggestionView(item: CardAssetSuggestion, row: CardTransaction, model: CardCategoryInferenceModel | null) {
  return { ...item, ...merchantOf(row), category: shownCategory(row, model) };
}

/** An asset purchase in view: why, on whose word, and the category it would be filed under as spending. */
function excludedView(row: CardTransaction, exclusion: CardSpendingExclusion, model: CardCategoryInferenceModel | null) {
  return {
    id: row.id, kind: row.kind, status: row.status, transactionDate: row.transactionDate, amountMinor: row.amountMinor,
    currency: row.currency, cardAccountId: row.cardAccountId, ...merchantOf(row), category: shownCategory(row, model),
    spendingCategory: spendingCategory(row, model), exclusion,
  };
}

/** An owner rule, with what it takes out of spending now: its posted purchases and their exact refunds, every card. */
function ruleView(rule: CardSpendingRule, rows: readonly CardTransaction[], exclusions: ReadonlyMap<string, CardSpendingExclusion>) {
  const ruled = new Set<string>();
  const covers = { purchases: 0, refunds: 0, netMinor: 0 };
  for (const row of rows) {
    const exclusion = exclusions.get(row.id);
    if (row.status !== 'posted' || exclusion?.source !== 'owner-rule' || exclusion.ruleId !== rule.id) continue;
    ruled.add(row.id);
    covers.purchases += 1;
    covers.netMinor += row.amountMinor;
  }
  for (const row of rows) {
    const exclusion = exclusions.get(row.id);
    if (row.status !== 'posted' || exclusion?.source !== 'paired-refund' || !ruled.has(exclusion.purchaseId ?? '')) continue;
    covers.refunds += 1;
    covers.netMinor += row.amountMinor;
  }
  return { ...rule, covers };
}

/** The server's calendar date; the web passes its own `today` so pace follows the viewer's day. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Shown instead of a brokerage account name that cannot be shown. */
const UNNAMED_BROKERAGE_ACCOUNT = 'Brokerage account';

/**
 * Every brokerage account, and their cash events dated within `window`.
 * Reads only. These brokerage methods are not behind the value-free DB
 * boundary yet, so whatever they throw is a server fault: it goes on to the
 * mount's handler, the value-free 500, never a 400 and never SQLite text.
 */
function readBrokerageCash(repo: SqliteStateRepo, window: { from: string; to: string }): {
  accounts: Account[];
  events: CashEvent[];
} {
  // The cash event reader takes dates from 1900 to 9999; a payment at either end looks no further.
  const from = window.from < '1900-01-01' ? '1900-01-01' : window.from;
  const to = window.to > '9999-12-31' ? '9999-12-31' : window.to;
  const accounts = repo.listAccounts();
  const events = from > to ? [] : accounts.flatMap((account) => repo.listCashEvents(account.id, from, to));
  return { accounts, events };
}

/** Control, format (zero-width, bidi), private-use and lone surrogate code points, and combining marks not on a letter. */
const HIDING = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]|(?<![\p{L}\p{M}])\p{M}/u;
/** A digit, numeral or other number character, in any script. */
const NUMBER = /\p{N}/u;

/**
 * Brokerage text (an account name, a broker's description) as a card route
 * may show it, on one line; undefined when it has a digit or numeral in any
 * script, before or after compatibility folding (`²`, `①` and full-width
 * digits fold to digits), or a character that could hide one. Card numbers,
 * security codes, PINs, expiry dates, IBANs, references and phone numbers all
 * need digits, so no separator, label or delimiter can carry them past this;
 * the card-data detectors still run as well.
 */
function shownText(text: string | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line || HIDING.test(line) || NUMBER.test(line) || NUMBER.test(line.normalize('NFKC'))) return undefined;
  if (looksLikeCardData(text) || looksLikeCardData(line)) return undefined;
  return line;
}

/**
 * For a payment to the card, the brokerage withdrawals and outgoing
 * transfers it may have come from (`suggestCardPaymentSources`). Suggestions
 * only: nothing is linked, created or changed. Empty for any other row,
 * without reading brokerage data.
 */
function possiblyPaidFrom(repo: SqliteStateRepo, transaction: CardTransaction): CardPaymentSourceView[] {
  if (!isCardPaymentToCard(transaction)) return [];
  const window = cardPaymentSourceWindow(transaction.transactionDate);
  if (!window) return [];
  const { accounts, events } = readBrokerageCash(repo, window);
  const descriptions = new Map(events.map((event) => [event.id, event.description]));
  const names = new Map(accounts.map((account) => [account.id, account.name]));
  return suggestCardPaymentSources(transaction, events).map((suggestion) => {
    const description = shownText(descriptions.get(suggestion.cashEventId));
    return {
      accountName: shownText(names.get(suggestion.accountId)) ?? UNNAMED_BROKERAGE_ACCOUNT,
      date: suggestion.date,
      eventType: suggestion.eventType,
      amountMinor: suggestion.amountMinor,
      currency: suggestion.currency,
      dayOffset: suggestion.dayOffset,
      ...(description ? { description } : {}),
    };
  });
}

/**
 * Per currency with posted payments to the card among `rows`, how many look
 * paid from brokerage cash, each from a different outflow. Brokerage cash
 * events are read only when there are such payments, and only around them.
 */
function paymentsPossiblyPaidFrom(repo: SqliteStateRepo, rows: readonly CardTransaction[]): CardPaymentSourceCount[] {
  const payments = rows.filter((row) => row.status === 'posted' && isCardPaymentToCard(row));
  if (payments.length === 0) return [];
  const dates = payments.map((row) => row.transactionDate).sort();
  const window = cardPaymentSourceWindow(dates[0], dates[dates.length - 1]);
  return countCardPaymentSources(payments, window ? readBrokerageCash(repo, window).events : []);
}

/**
 * How Spending's answers read card rows, shared by its routers (this file's, and the overview's and forecast's beside
 * it) so they all count exactly what the summary counts: every row with the kind Spending reads it as (shared
 * `readCardSpendingRows`: a charge that takes a card payment back is a payment), the category source's one snapshot per
 * answer, its splits, the household's inferred categories, the owner's asset purchases (none, without reading the
 * household, when no row can be one), and `viewOf`, the rows a summary counts for its filters. Nothing is kept between
 * answers.
 */
export function createCardSpendingReads(
  repo: SqliteStateRepo,
  options: {
    /** The reviewed source of category splits (the composite source over the Amazon domain's, in the app); none keeps every answer on the cards' own categories. */
    categoryResolver?: CardCategorySource | null;
  } = {},
) {
  const resolver = options.categoryResolver ?? null;
  /** The request's one snapshot of the source: none for the original basis or without a resolver. */
  const snapshotFor = (basis: CardCategoryBasis): SourceSnapshot | null =>
    (basis === 'enriched' && resolver ? resolver.snapshot() : null);
  const splitsOf = (rows: readonly CardTransaction[], snapshot: SourceSnapshot) => resolveCardCategorySplits(rows, {
    requested: 'enriched',
    snapshot,
    knownCategories: new Set(repo.listCardCategories()),
    isAllowedCategoryName: (name) => repo.isAcceptableCardCategory(name),
    // A source that describes rows backs a split only for a row it links: by its explicit `isLinkedRow` when it has one,
    // else by its card detail's match.
    ...(snapshot.isLinkedRow ? { isLinkedRow: (id: string) => snapshot.isLinkedRow?.(id) === true }
      : snapshot.getCardDetail ? { isLinkedRow: (id: string) => snapshot.getCardDetail?.(id)?.match === 'linked' } : {}),
  });
  const unsplit = (basis: CardCategoryBasis) => cardCategoryBasisWithoutSplits(basis);
  /** The stored rows a query matches, each with the kind Spending reads it as: the only way these answers read rows. */
  const rowsMatching = (query: CardTransactionQuery): CardTransaction[] => readCardSpendingRows(repo.listCardTransactionsMatching(query));
  /** Every card row, pending and posted: what inference learns from and what exclusions read, whatever is in view. */
  const householdRows = (): CardTransaction[] => rowsMatching({ statuses: ['pending', 'posted'] });
  /** The household's rows for one answer, read the first time something needs them and only then. */
  const householdOnce = (): (() => CardTransaction[]) => {
    let rows: CardTransaction[] | null = null;
    return () => (rows ??= householdRows());
  };
  /**
   * The household's inferred categories (cardCategoryInference.ts), learned from every card row, whatever the
   * answer shows, so a filter never changes what a merchant's history says.
   */
  const inference = (rows: readonly CardTransaction[] = householdRows()): CardCategoryInferenceModel => buildCardCategoryInference(rows);
  /** Enriched answers only. */
  const inferenceFor = (basis: CardCategoryBasis, all: () => readonly CardTransaction[]): CardCategoryInferenceModel | null =>
    (basis === 'enriched' ? inference(all()) : null);
  /**
   * Asset purchases by row id (cardSpendingExclusions.ts), from every card row and the owner rules in force: the
   * owner's "Precious metals" category, a rule's purchases, and the exact refunds of either. Whatever is in view, so
   * a filter never changes what counts. No rules while their table is not installed.
   */
  const exclusionsOf = (rows: readonly CardTransaction[]) => resolveCardSpendingExclusions(rows, repo.listCardSpendingRules());
  /**
   * An answer's asset purchases, or null when no card row can be one (no row the owner filed under the asset category,
   * no owner rule in force: repo.cardSpendingAssetsPossible). Null skips the exclusion pass, and the rows read for it:
   * the answer is then, by construction, exactly the answer before asset purchases.
   */
  const exclusionsFor = (all: () => readonly CardTransaction[]): ReadonlyMap<string, CardSpendingExclusion> | null =>
    (repo.cardSpendingAssetsPossible() ? exclusionsOf(all()) : null);
  /**
   * An answer's order links for the large one-off split (`sourceOrderLinks`), from its one snapshot and every card row:
   * the household's, whatever the answer shows. None without a snapshot (the original basis) or a source that describes
   * rows and orders. What `viewOf` gives an enriched answer, for a router that reads its own rows (the forecast's).
   */
  const orderLinksFor = (snapshot: SourceSnapshot | null, all: () => readonly CardTransaction[]): CardOrderLinks | undefined =>
    sourceOrderLinks(snapshot, all);

  /**
   * The rows a summary counts for its filters, as the summary and the accounting both read them: on the original basis
   * the stored rows the filters match; on the enriched one, with inferred categories, and under a category filter a
   * split row only for its part in the category; on both, with the kind Spending reads each as. With every card row
   * (read when first asked for), what counts as an asset purchase (null when nothing can be one) and, on the enriched
   * basis, the source's order links (`orderLinks`, for the large one-off split, the household's; none without a source
   * that describes rows and orders).
   */
  const viewOf = (query: Map<string, string>) => {
    const basis = categoryBasisOf(query);
    const filter = filterQuery(repo, query);
    const all = householdOnce();
    const exclusions = exclusionsFor(all);
    const model = inferenceFor(basis, all);
    if (!model) {
      // The original basis: the answer before category bases.
      const rows = rowsMatching({ ...filter, statuses: ['pending', 'posted'] });
      return { basis, all, exclusions, model, shown: rows, enriched: null };
    }
    const snapshot = snapshotFor(basis);
    const { category, ...others } = filter;
    // Spelled, and checked first, as the query would: the parts are compared with the stored categories' spelling.
    const name = category === undefined ? undefined : repo.cardCategoryFilterName(category);
    const read = inferAll(rowsMatching({ ...others, statuses: ['pending', 'posted'] }), model);
    const splits = snapshot ? splitsOf(read.rows, snapshot) : null;
    let shown: ReadRow[] = read.rows;
    let parts: ReadonlyMap<string, readonly CardCategoryPart[]> = splits?.parts ?? new Map();
    if (name !== undefined) {
      // The filter picks parts: a split row counts for what it put in the category; a whole row by its category in
      // this answer, an inferred one where it has one.
      const whole = new Set(repo.listCardTransactionsMatching({ ...filter, statuses: ['pending', 'posted'] }).map((row) => row.id));
      const portions = new Map<string, CardCategoryPart[]>();
      shown = [];
      for (const row of read.rows) {
        const rowParts = splits?.parts.get(row.id);
        if (!rowParts) {
          const inference = read.inferred.get(row.id);
          if (inference ? inference.category === name : whole.has(row.id)) shown.push(row);
          continue;
        }
        const portionMinor = cardCategoryPortion(rowParts, name);
        if (portionMinor === 0) continue;
        shown.push({ ...row, amountMinor: portionMinor });
        portions.set(row.id, [{ category: name, amountMinor: portionMinor, categorySource: 'original-effective', classification: 'source' }]);
      }
      parts = portions;
    }
    return { basis, all, exclusions, model, shown, enriched: { snapshot, name, read, splits, parts, orderLinks: sourceOrderLinks(snapshot, all) } };
  };

  return {
    snapshotFor, splitsOf, unsplit, rowsMatching, householdRows, householdOnce, inference, inferenceFor, exclusionsOf, exclusionsFor,
    orderLinksFor, viewOf,
  };
}

export type CardSpendingReads = ReturnType<typeof createCardSpendingReads>;
/** For the routers beside this one: the summary's filter names, and the helpers its answers are built with. */
export { FILTER_PARAMS as CARD_SPENDING_FILTER_PARAMS, inferAll, fromAmazonItems, type ReadRow as CardSpendingReadRow };

/**
 * The Spending tab's routes, to pass to `mountCardSpendingRoutes` in
 * `routers`. It has no auth or error handler of its own: the guarded mount
 * runs requireAuth before it and handles every error after it. `log` gets
 * fixed lines only (default console.error), like the mount's.
 */
export function createCardTransactionsRouter(
  repo: SqliteStateRepo,
  options: {
    log?: (line: string) => void;
    /**
     * The reviewed source of category splits (the Amazon domain's resolver, in the app). Without one, every answer
     * stays on the cards' own categories and a row's detail has no `amazon`.
     */
    categoryResolver?: CardCategorySource | null;
  } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const resolver = options.categoryResolver ?? null;
  const patchBody = readBody(TRANSACTION_BODY_LIMIT_BYTES);
  const { snapshotFor, splitsOf, unsplit, rowsMatching, householdOnce, inference, inferenceFor, exclusionsFor, viewOf } =
    createCardSpendingReads(repo, { categoryResolver: resolver });

  // Card data in the query is a 422 before any other check, as on the import routes.
  // Errors then follow Phase 3's mapping: only a card guard's refusal
  // (isCardGuardRefusal) is card data, a 422 with paths only; the repository's own
  // refusals (HoldrRefusal: field names only) are a 400; anything else, every other
  // trigger or database failure included, goes on to the mount's handler, a 500
  // with a fixed body.
  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, QUERY_NAMES);
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : cardGuardRefusal(caught, '$', log)
          ?? (caught instanceof HoldrRefusal ? repositoryError(caught, 'invalid card spending request') : caught);
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };

  router.get('/card-transactions', handle((req, res) => {
    const query = queryParams(req, LIST_PARAMS);
    const basis = categoryBasisOf(query);
    const filter = filterQuery(repo, query);
    const status = query.get('status');
    if (status !== undefined) filter.statuses = list(status, STATUSES, 'status');
    // The kind a row is listed under is the one Spending reads it as, so the page is cut after that rule.
    const kind = query.get('kind');
    if (kind !== undefined) filter.spendingKinds = list(kind, KINDS, 'kind');
    const sort = query.get('sort') ?? 'date-desc';
    if (!SORTS.has(sort as CardTransactionSort)) throw new HttpError(400, 'sort must be date-desc, date-asc, amount-desc or amount-asc');
    const limitParam = query.get('limit');
    const offsetParam = query.get('offset');
    const limit = limitParam === undefined ? 50 : integer(limitParam, 'limit', 1, MAX_CARD_TRANSACTION_PAGE);
    const offset = offsetParam === undefined ? 0 : integer(offsetParam, 'offset', 0, MAX_OFFSET);
    const snapshot = snapshotFor(basis);
    const all = householdOnce();
    const model = inferenceFor(basis, all);
    const exclusions = exclusionsFor(all);
    // Only the Amazon card charges not itemized, by the domain's own rule: what the coverage line links to.
    const amazonFilter = query.get('amazon');
    if (amazonFilter !== undefined && amazonFilter !== 'unitemized') throw new HttpError(400, 'amazon must be unitemized');
    const isAmazonCharge = snapshot?.isAmazonCharge;
    if (amazonFilter !== undefined && !isAmazonCharge) {
      throw new HttpError(400, 'amazon=unitemized needs the enriched basis and Amazon orders');
    }
    // Only rows in one currency: the coverage line counts one currency, and its list is that currency's. Only with
    // the Amazon filter, so it is never taken and then ignored.
    const currency = query.get('currency');
    if (currency !== undefined && amazonFilter === undefined) throw new HttpError(400, 'currency goes with amazon=unitemized');
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a three-letter uppercase code');
    if (!model || (filter.category === undefined && amazonFilter === undefined)) {
      const page = repo.queryCardTransactions(filter, { sort: sort as CardTransactionSort, limit, offset });
      const transactions = readCardSpendingRows(page.transactions);
      const read = model ? inferAll(transactions, model) : null;
      const splits = snapshot && read ? splitsOf(read.rows, snapshot) : null;
      res.json({
        transactions: transactions.map((row) => {
          const view = counted(rowView(row, splits?.parts.get(row.id), read?.inferred ?? null), row, exclusions);
          const amazon = listedAmazon(row, snapshot, splits);
          return amazon ? { ...view, amazon } : view;
        }),
        total: page.total,
        limit,
        offset,
        nextOffset: offset + page.transactions.length < page.total ? offset + page.transactions.length : null,
        categoryBasis: read
          ? enrichedMarker(splits?.marker ?? unsplit(basis), withSplits(transactions.filter(listedWithCategory), splits), read.inferred)
          : unsplit(basis),
      });
      return;
    }
    // A category picks parts: a split row is listed for what it put there, a whole row by its category in this answer,
    // an inferred one where it has one. The category is compared as the filter spells it, checked first as the query
    // would check it. The Amazon filter keeps the domain's Amazon card charges that are not itemized.
    const { category, ...others } = filter;
    const name = category === undefined ? undefined : repo.cardCategoryFilterName(category);
    const rows = readCardSpendingRows(repo.listCardTransactionsSorted(others, sort as CardTransactionSort));
    const whole = name === undefined ? null : new Set(repo.listCardTransactionsMatching(filter).map((row) => row.id));
    const read = inferAll(rows, model);
    const splits = snapshot ? splitsOf(read.rows, snapshot) : null;
    const matched: Array<{ row: CardTransaction; portionMinor: number | null }> = [];
    for (const row of rows) {
      if (currency !== undefined && row.currency !== currency) continue;
      if (amazonFilter !== undefined && !(isAmazonCharge?.(row.id) && !itemizedIn(splits, row.id))) continue;
      if (name === undefined || whole === null) {
        matched.push({ row, portionMinor: null });
        continue;
      }
      const parts = splits?.parts.get(row.id);
      if (parts) {
        const portionMinor = cardCategoryPortion(parts, name);
        if (portionMinor !== 0) matched.push({ row, portionMinor });
        continue;
      }
      const inference = read.inferred.get(row.id);
      if (inference ? inference.category === name : whole.has(row.id)) matched.push({ row, portionMinor: row.amountMinor });
    }
    const page = matched.slice(offset, offset + limit);
    const pageRows = page.map(({ row }) => row);
    res.json({
      transactions: page.map(({ row, portionMinor }) => {
        const listed = listedAmazon(row, snapshot, splits);
        return {
          ...counted(rowView(row, splits?.parts.get(row.id), read.inferred), row, exclusions),
          ...(listed ? { amazon: listed } : {}),
          ...(portionMinor !== null ? { categoryPortionMinor: portionMinor } : {}),
        };
      }),
      total: matched.length,
      limit,
      offset,
      nextOffset: offset + page.length < matched.length ? offset + page.length : null,
      // The marker describes the page, as without a filter.
      categoryBasis: enrichedMarker(
        splits ? cardCategoryBasisMarkerFor(splits, pageRows.map((row) => row.id), name) : unsplit(basis),
        withSplits(pageRows.filter(listedWithCategory), splits),
        read.inferred,
      ),
    });
  }));

  router.get('/card-transactions/:id', handle((req, res) => {
    const id = transactionId(req);
    const basis = categoryBasisOf(queryParams(req, ['categoryBasis']));
    const stored = repo.getCardTransaction(id);
    if (!stored) throw new HttpError(404, 'card transaction not found');
    // As every answer reads it: a charge that takes a card payment back is a payment.
    const transaction = readCardSpendingRow(stored);
    const batch = transaction.importBatchId ? repo.getCardImportBatch(transaction.importBatchId) : null;
    // One snapshot for the row's facts and how enriched reports file it, whatever the basis shown: the `amazon`
    // object, which only a source that describes rows has, does not depend on it. Enriched reports read a row with
    // no category of its own under its inferred one, and a tax payment under the tax rule's over its issuer's, and a
    // split files its residual there, so the row is inferred for the enriched basis and for its `amazon` object; only
    // the enriched basis shows the transaction's own category fields.
    const snapshot = resolver ? resolver.snapshot() : null;
    const describes = snapshot?.getCardDetail !== undefined;
    const all = householdOnce();
    const exclusions = exclusionsFor(all);
    const read = cardCategoryInferable(transaction) && (basis === 'enriched' || describes)
      ? inferAll([transaction], inference(all()))
      : { rows: [transaction], inferred: new Map<string, CardCategoryInference>() };
    const splits = snapshot && (basis === 'enriched' || describes) ? splitsOf(read.rows, snapshot) : null;
    const amazon = snapshot?.getCardDetail && splits
      ? amazonDetailView(snapshot.getCardDetail(transaction.id), snapshot.version, splits.outcomes.get(transaction.id))
      : null;
    const view = counted(toCardTransactionView(transaction), transaction, exclusions);
    res.json({
      transaction: basis === 'enriched'
        ? categorizedView(view, transaction, splits?.parts.has(transaction.id) ?? false, read.inferred)
        : view,
      cardAccount: repo.getCardAccount(transaction.cardAccountId),
      importBatch: batch,
      // Suggestions for the owner to judge; empty unless the row is pending.
      possiblyPostedAs: readCardSpendingRows(repo.listPossiblePostedCardVersions(transaction.id))
        .map((row) => counted(toCardTransactionView(row), row, exclusions)),
      // Suggestions too; empty unless the row is a payment to the card.
      possiblyPaidFrom: possiblyPaidFrom(repo, transaction),
      ...(amazon ? { amazon } : {}),
    });
  }));

  router.patch('/card-transactions/:id', ...patchBody, handle((req, res) => {
    // Card data in the id or the body is a 422 before any 404 or 400.
    scanIdParam(req);
    const body = jsonBody(req);
    rejectCardData(body, PATCH_KEYS);
    const id = transactionId(req);
    queryParams(req, []);
    // The ledger records who changed the row (v15 events): only a signed-in
    // owner does; the service principal never reaches this route.
    const actorRef = sessionActorRef(req);
    if (actorRef === undefined) throw new HttpError(403, 'only a signed-in owner can change a card transaction');
    if (!isPlainObject(body)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(body).some((key) => !PATCH_KEYS.has(key))) {
      throw new HttpError(400, 'only userCategory, notes and status can change, or postedAs be set');
    }
    if (Object.keys(body).length === 0) throw new HttpError(400, 'no fields to update');
    if (body.postedAs !== undefined) {
      if (Object.keys(body).length > 1) throw new HttpError(400, 'postedAs cannot be combined with other changes');
      if (typeof body.postedAs !== 'string' || !ID.test(body.postedAs)) throw new HttpError(400, 'postedAs must be a card transaction id');
    }
    for (const key of ['userCategory', 'notes'] as const) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
        throw new HttpError(400, `${key} must be a string or null`);
      }
    }
    if (body.status !== undefined && body.status !== 'pending' && body.status !== 'removed') {
      throw new HttpError(400, 'status must be pending or removed');
    }
    let updated: CardTransaction | null;
    try {
      updated = repo.updateCardTransaction(id, body as CardTransactionPatch, { actorRef });
    } catch (error) {
      // As on the import routes: only a card guard's refusal is card data (422,
      // paths only), a HoldrRefusal is a 400 with its message, and any other
      // trigger or database failure (a HoldrDbError behind the repository's
      // boundary) goes on to the mount's 500.
      throw cardGuardRefusal(error, '$', log) ?? repositoryError(error, 'invalid card transaction change');
    }
    if (!updated) throw new HttpError(404, 'card transaction not found');
    // How the row counts now: the owner's category, a rule in force, or an exact refund of a purchase either took out; a
    // charge that takes a card payment back is a payment unless the owner filed it under a category of their own.
    const read = readCardSpendingRow(updated);
    res.json(counted(toCardTransactionView(read), read, exclusionsFor(householdOnce())));
  }));

  router.get('/spending/summary', handle((req, res) => {
    const query = queryParams(req, FILTER_PARAMS);
    const { basis, exclusions, shown, enriched } = viewOf(query);
    const owners = new Map(repo.listCardAccounts().map((account) => [account.id, account.owner]));
    if (!enriched) {
      // The original basis: the answer before category bases, with its marker.
      const summary = summarizeCardSpending(shown, exclusions === null ? { owners } : { owners, exclusions });
      res.json({ ...summary, categories: repo.listCardCategories(), paymentsPossiblyPaidFrom: paymentsPossiblyPaidFrom(repo, shown), categoryBasis: unsplit(basis) });
      return;
    }
    const { snapshot, name, read, splits, parts } = enriched;
    const summary = summarizeCardSpending(shown, exclusions === null ? { owners, categoryParts: parts } : { owners, categoryParts: parts, exclusions });
    const inUse = repo.listCardCategories();
    // Categories the answer files amounts under that no stored row has yet: a part's, or a rule's.
    const added = [...new Set([
      ...[...(splits?.parts.values() ?? [])].flat().map((part) => part.category),
      ...[...read.inferred.values()].map((inference) => inference.category),
    ])].filter((item) => !inUse.includes(item));
    // The rows the summary counts, and under a category only their parts in it: asset purchases count in no marker.
    const marker = !splits
      ? unsplit(basis)
      : exclusions === null
        ? (name === undefined ? splits.marker : cardCategoryBasisMarkerFor(splits, shown.map((row) => row.id), name))
        : cardCategoryBasisMarkerFor(splits, shown.filter((row) => !cardSpendingExclusionOf(row, exclusions)).map((row) => row.id), name);
    const coverage = amazonCoverage(read.rows, snapshot, splits);
    res.json({
      ...summary,
      categories: added.length === 0 ? inUse : [...inUse, ...added].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      paymentsPossiblyPaidFrom: paymentsPossiblyPaidFrom(repo, shown),
      categoryBasis: enrichedMarker(marker, withSplits(shown.filter((row) => summedByCategory(row, exclusions)), splits), read.inferred),
      // With a source: what Amazon items put in each category (under a category filter, in that one); and, when the
      // source has the Amazon domain's rule, how many of the view's Amazon card charges are itemized, whatever the
      // category filter.
      ...(splits ? { fromAmazonItems: fromAmazonItems(shown, splits, name, exclusions) } : {}),
      ...(coverage ? { amazonCoverage: coverage } : {}),
    });
  }));

  router.get('/spending/accounting', handle((req, res) => {
    const query = queryParams(req, FILTER_PARAMS);
    const view = viewOf(query);
    const { model, shown } = view;
    // Suggestions read every card row, so a filter never changes what is suggested; the view counts and shows its own.
    const all = view.all();
    const exclusions = view.exclusions ?? new Map<string, CardSpendingExclusion>();
    const inView = new Set(shown.map((row) => row.id));
    const suggestions = suggestCardAssetPurchases(all, exclusions).filter((item) => inView.has(item.id));
    const byId = new Map(all.map((row) => [row.id, row]));
    const rules = repo.listCardSpendingRules();
    res.json({
      accounting: buildCardSpendingAccounting(shown, { exclusions, suggestions }),
      suggestions: suggestions.map((item) => suggestionView(item, byId.get(item.id)!, model)),
      assetPurchases: shown
        .filter((row) => row.status === 'posted' && cardSpendingExclusionOf(row, exclusions))
        .sort((a, b) => (a.transactionDate > b.transactionDate ? -1 : a.transactionDate < b.transactionDate ? 1 : a.id < b.id ? -1 : 1))
        .map((row) => excludedView(row, cardSpendingExclusionOf(row, exclusions)!, model)),
      rules: { installed: repo.cardSpendingRulesInstalled(), items: rules.map((rule) => ruleView(rule, all, exclusions)) },
    });
  }));

  router.get('/spending/coverage', handle((req, res) => {
    queryParams(req, []);
    res.json({ cards: repo.listCardCoverage() });
  }));

  router.get('/spending/insights', handle((req, res) => {
    const query = queryParams(req, INSIGHT_PARAMS);
    const basis = categoryBasisOf(query);
    const filter = filterQuery(repo, new Map([...query].filter(([key]) => key === 'cardAccountId' || key === 'owner')));
    const today = query.get('today') ?? localDate(new Date());
    if (!isIsoDate(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
    const month = query.get('month') ?? today.slice(0, 7);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    const accounts = repo.listCardAccounts();
    const currency = query.get('currency') ?? primaryCardCurrency(accounts, { cardAccountId: filter.cardAccountId, owner: filter.owner });
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a three-letter uppercase code');
    const period = insightPeriod(query);
    const rows = rowsMatching({ ...filter, statuses: ['pending', 'posted'] });
    const all = householdOnce();
    // Asset purchases are not spending: no insight reads them.
    const exclusions = exclusionsFor(all);
    const model = inferenceFor(basis, all);
    if (!model) {
      res.json({ ...computeCardInsights(rows, { month, today, currency, period, ...(exclusions === null ? {} : { exclusions }) }), categoryBasis: unsplit(basis) });
      return;
    }
    const read = inferAll(rows, model);
    const snapshot = snapshotFor(basis);
    // One snapshot for the period and its baseline alike, asked about the rows whose categories they can read.
    const windows = period ?? cardMonthInsightPeriod(month, today);
    const inWindow = (date: string) => [windows, windows.baseline].some((range) => range !== null && date >= range.from && date <= range.to);
    const splits = snapshot
      ? splitsOf(read.rows.filter((row) => row.currency === currency && inWindow(row.transactionDate)), snapshot)
      : null;
    const categoryRead = new Map<string, boolean>();
    const insights = computeCardInsights(read.rows, {
      month, today, currency, period, categoryParts: splits?.parts, onCategoryRead: (id, throughParts) => categoryRead.set(id, throughParts),
      ...(exclusions === null ? {} : { exclusions }),
      // A credit with a decisive order link is set only against one of its orders' charges, whatever cards are in view.
      orderLinks: sourceOrderLinks(snapshot, all),
    });
    // The marker counts the rows whose categories the answer read; a split refund partly set against a large purchase
    // is read whole, under its own category, so it is not counted as split.
    const scope = [...categoryRead].filter(([id, throughParts]) => throughParts || splits?.outcomes.get(id)?.kind !== 'split').map(([id]) => id);
    const byId = new Map(read.rows.map((row) => [row.id, row]));
    const readRows = [...categoryRead].flatMap(([id, throughParts]) => {
      const row = byId.get(id);
      return row ? [{ row, split: throughParts }] : [];
    });
    res.json({ ...insights, categoryBasis: enrichedMarker(splits ? cardCategoryBasisMarkerFor(splits, scope) : unsplit(basis), readRows, read.inferred) });
  }));

  return router;
}

/** The insights' own period and baseline, when given: both ends of each, in order, the baseline before the period. */
function insightPeriod(query: Map<string, string>): CardInsightPeriod | undefined {
  const range = (fromName: string, toName: string) => {
    const from = query.get(fromName);
    const to = query.get(toName);
    if (from === undefined && to === undefined) return null;
    if (from === undefined || to === undefined) throw new HttpError(400, `${fromName} and ${toName} go together`);
    for (const [name, value] of [[fromName, from], [toName, to]] as const) {
      if (!isIsoDate(value)) throw new HttpError(400, `${name} must be a valid YYYY-MM-DD date`);
    }
    if (from > to) throw new HttpError(400, `${fromName} must not be after ${toName}`);
    return { from, to };
  };
  const period = range('from', 'to');
  const baseline = range('baselineFrom', 'baselineTo');
  if (!period) {
    if (baseline) throw new HttpError(400, 'baselineFrom and baselineTo need from and to');
    return undefined;
  }
  if (baseline && baseline.to >= period.from) throw new HttpError(400, 'baselineTo must be before from');
  return { ...period, baseline };
}
