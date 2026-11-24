/**
 * Spending reports over stored card transactions: which rows count as
 * spending, the category and merchant a row is reported under, the summary by
 * month, category, merchant, card and owner, and import coverage ranges.
 *
 * Accounting rules:
 * - purchases, fees and interest are spending; refunds and adjustments (fee or
 *   interest reversals) offset it, each in the month of its own transaction date;
 * - a card payment is a transfer from the owner's other accounts, never spending;
 * - so is a charge that takes a payment to the card back (a payment returned
 *   unpaid or reversed, and debited again), whatever kind it was stored with:
 *   rows are read with {@link effectiveCardKind}, which counts it with the card
 *   payments, against the payment it reverses. A fee for it stays a fee;
 * - a row stored as a card payment that names a fee is no payment: read with
 *   {@link effectiveCardKind}, it is what the import classifier makes of it
 *   now: a charge for a payment is a fee ("NSF PAYMENT FEE"), and a credit
 *   giving a fee back takes the kind its charge gets (an adjustment of the
 *   card's own fee, a refund of a merchant's), so the two net. The owner's own
 *   category on a row keeps the row's own kind, before either rule;
 * - `other` rows (cash advances, balance transfers, zero amounts) are listed
 *   but not counted;
 * - posted rows count. Pending rows are totalled separately in `pending` and
 *   never counted as spending: an amount that may still change or disappear
 *   is not official spending. Removed rows (dismissed pending rows) are ignored;
 * - amounts stay integer minor units of their own currency and are never added
 *   across currencies. A foreign purchase counts in the card's currency;
 * - an asset purchase (precious metals: bought to keep, not consumed) is not
 *   spending either, and never a transfer. Only the owner makes a row one: the
 *   category {@link CARD_ASSET_CATEGORY} on the row, or an owner rule, and a
 *   refund of such a purchase goes with it (cardSpendingExclusions.ts). Those
 *   rows are totalled apart, in `assetPurchasesMinor`, so every total still
 *   reconciles with the card's activity.
 *
 * Every function is pure and deterministic.
 */
import { currencyExponent } from './cardImportTool/amount.js';
import { classifyCardKind, isReturnedCardPaymentCharge, namesCardFee } from './cardKinds.js';
import { cardMerchantDisplayNames, cardMerchantKey, groupCardMerchantKeys, matchesCardMerchantGroup } from './cardMerchants.js';
import type { CardAccount, CardImportBatch, CardOwner, CardTransaction, CardTransactionKind } from './types.js';

/** Category of a row with neither a custom nor an issuer category. */
export const CARD_UNCATEGORIZED = 'Uncategorized';
/** Merchants listed by name per currency; the rest are summed into `otherMerchants`. */
export const CARD_SPENDING_TOP_MERCHANTS = 25;

/** Decimal places of a currency's minor unit (ISO 4217; 2 unless known otherwise). */
export function cardCurrencyExponent(currency: string): number {
  return currencyExponent(currency);
}

/** Integer minor units as a number of major units, e.g. 1234 USD → 12.34. */
export function cardMinorToMajor(amountMinor: number, currency: string): number {
  return amountMinor / 10 ** currencyExponent(currency);
}

const AMOUNT_QUERY = /^\$?(\d{1,10})(?:\.(\d{1,3}))?$/;

/**
 * A search text that is a plain amount (`12.34`, `$12`, `1,234.50`), as the
 * absolute minor units it means in `currency`; null when it is not one or
 * has more decimals than the currency.
 */
export function parseCardAmountQuery(text: string, currency: string): number | null {
  const match = AMOUNT_QUERY.exec(text.trim().replace(/^\$?\d{1,3}(?:,\d{3})+(?=\.|$)/, (whole) => whole.replace(/,/g, '')));
  if (!match) return null;
  const exponent = currencyExponent(currency);
  const fraction = match[2] ?? '';
  if (fraction.length > exponent && /[^0]/.test(fraction.slice(exponent))) return null;
  const minor = Number(`${match[1]}${fraction.slice(0, exponent).padEnd(exponent, '0')}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

export type CardSpendingRole = 'spending' | 'transfer' | 'excluded';

const ROLES: Readonly<Record<CardTransactionKind, CardSpendingRole>> = {
  purchase: 'spending',
  fee: 'spending',
  interest: 'spending',
  refund: 'spending',
  adjustment: 'spending',
  payment: 'transfer',
  other: 'excluded',
};

/** How a row's kind is reported: spending (signed), a transfer (card payment), or not counted. */
export function cardSpendingRole(kind: CardTransactionKind): CardSpendingRole {
  return Object.prototype.hasOwnProperty.call(ROLES, kind) ? ROLES[kind] : 'excluded';
}

/** What {@link effectiveCardKind} reads of a stored row. */
export interface CardKindReadRow {
  kind: CardTransactionKind;
  amountMinor: number;
  description: string;
  merchant?: string | null;
  /** Read only for a row stored as a card payment that names a fee, as the import classifier reads it. */
  issuerCategory?: string | null;
  userCategory?: string | null;
}

/**
 * The kind Spending reads a stored row as, wherever it counts spending: the row's own, except
 * - a charge that takes a payment to the card back (cardKinds.ts, `isReturnedCardPaymentCharge`: "RETURNED ONLINE ACH
 *   PAYMENT", or, stored as a purchase, with its payment word cut off where the issuer cut the text: "Returned Online
 *   ACH Payme") stored under a spending kind, which is a card payment. A producer that kinds rows itself may have
 *   stored one as a purchase, and the import classifier makes a fee of one its issuer files under fees; either way it
 *   is no spending but a payment's reversal. As a payment it is a transfer: it counts with the card payments
 *   (`paymentsMinor`), against the payment it reverses, and still adds to what the card owes;
 * - a row stored as a card payment whose own text names a fee (cardKinds.ts, `namesCardFee`: FEE or FEES, in its
 *   description or its merchant), which no card payment does: it is read as the import classifier kinds it now
 *   (`classifyCardKind`, from its amount, its texts and its issuer's category), so a row stored before import tools
 *   1.0.3 reads as one that tool converts. A charge for a returned payment is a fee ("NSF PAYMENT FEE", "RETURNED
 *   ONLINE PAYMENT FEE"), and a biller's own fee for being paid online a purchase ("SAMPLE UTILITY ONLINE PAYMENT
 *   FEE"), as when the classifier stores it. A credit gives a fee back and takes the kind its own charge gets
 *   (cardKinds.ts, `cardGiveBackKind`), which for a stored row is its stored charge's: an adjustment that offsets the
 *   card's own fee ("RETURNED PAYMENT FEE REVERSAL"; a "… SERVICE FEE" one too, whose charge every converter stored as a
 *   fee), and a refund of a merchant's fee ("SAMPLE UTILITY ONLINE PAYMENT FEE REFUND"). None is a payment: the
 *   classifier never makes a payment of a row that names a fee. CHARGE is no fee word here: a payment's own text can say
 *   "charge account".
 * Nothing is stored: the row, its amount and its stored kind stay as imported, and balances, statements and the payment
 * reconciliation read the stored kind. The owner's own category on the row keeps its own kind, as it comes before every
 * rule. No row stored under another kind than a payment is read otherwise by this rule.
 */
export function effectiveCardKind(row: CardKindReadRow): CardTransactionKind {
  if (row.userCategory) return row.kind;
  if (cardSpendingRole(row.kind) === 'spending') return isReturnedCardPaymentCharge(row) ? 'payment' : row.kind;
  if (row.kind === 'payment' && row.amountMinor !== 0 && namesCardFee(row)) {
    return classifyCardKind({
      amountMinor: row.amountMinor,
      description: row.description,
      issuerCategory: row.issuerCategory ?? null,
      evidence: row.merchant || null,
    });
  }
  return row.kind;
}

/** A stored row as Spending reads it: with its {@link effectiveCardKind}; the row itself when that is its stored kind. */
export function readCardSpendingRow<T extends CardKindReadRow>(row: T): T {
  const kind = effectiveCardKind(row);
  return kind === row.kind ? row : { ...row, kind };
}

/** Stored rows as Spending reads them ({@link readCardSpendingRow}), in their order. */
export function readCardSpendingRows<T extends CardKindReadRow>(rows: readonly T[]): T[] {
  return rows.map((row) => readCardSpendingRow(row));
}

/**
 * The owner's category that makes a spending row an asset purchase: bullion and coins are bought to keep (an asset,
 * like a brokerage buy), not consumed, so they are not spending; nor are they a transfer between the owner's accounts.
 */
export const CARD_ASSET_CATEGORY = 'Precious metals';

/** Why a spending row is left out of spending. */
export type CardSpendingExclusionReason = 'asset-purchase';
/**
 * Who decided: the owner's category on the row, an owner rule (cardSpendingExclusions.ts), or the exact refund of
 * a purchase one of those took out.
 */
export type CardSpendingExclusionSource = 'owner-category' | 'owner-rule' | 'paired-refund';

/** A spending row taken out of spending, and on whose word. */
export interface CardSpendingExclusion {
  reason: CardSpendingExclusionReason;
  source: CardSpendingExclusionSource;
  /** `owner-rule`: the rule. */
  ruleId?: string;
  /** `paired-refund`: the excluded purchase this refund gives back. */
  purchaseId?: string;
}

/** A category name's form: case, accents, punctuation and "&" or "and" aside. */
function categoryForm(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True for the owner's asset category however it is spelled ("precious metals", "Precious Metal", "PRECIOUS-METALS"). */
export function isCardAssetCategory(name: string | null | undefined): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  const form = categoryForm(name);
  return form === 'precious metals' || form === 'precious metal';
}

/**
 * The exclusion the row's own fields decide: a spending row (by kind) the owner filed under the asset category. Rules
 * and paired refunds need the other rows and the owner's rules: cardSpendingExclusions.ts resolves those.
 */
export function ownerCardSpendingExclusion(row: { kind: CardTransactionKind; userCategory?: string | null }): CardSpendingExclusion | null {
  return cardSpendingRole(row.kind) === 'spending' && isCardAssetCategory(row.userCategory)
    ? { reason: 'asset-purchase', source: 'owner-category' }
    : null;
}

/**
 * The custom category, else an inferred one (cardCategoryInference.ts: set only by Spending's enriched answers, on rows
 * with neither, or over the issuer's category by a rule that takes precedence over it: a tax payment), else the
 * issuer's, else {@link CARD_UNCATEGORIZED}.
 */
export function effectiveCardCategory(row: {
  userCategory?: string | null;
  issuerCategory?: string | null;
  inferredCategory?: string | null;
}): string {
  return row.userCategory || row.inferredCategory || row.issuerCategory || CARD_UNCATEGORIZED;
}

/** The merchant name when the issuer gives one, else the description. */
export function effectiveCardMerchant(row: { merchant?: string | null; description: string }): string {
  return row.merchant || row.description;
}

export type CardSpendingRow = Pick<
  CardTransaction,
  'cardAccountId' | 'transactionDate' | 'status' | 'amountMinor' | 'currency' | 'kind' | 'description'
> & {
  /** Needed only to look up the row's category parts. */
  id?: string;
  merchant?: string | null;
  issuerCategory?: string | null;
  userCategory?: string | null;
  /**
   * An inferred category (cardCategoryInference.ts); only enriched answers set it, only where the owner's is empty and
   * the issuer's is too, or where a rule takes precedence over the issuer's (a tax payment).
   */
  inferredCategory?: string | null;
};

/** Parts of a split row (see cardCategoryParts.ts): the categories its amount was for. */
export interface CardCategoryAmount {
  category: string;
  amountMinor: number;
}

/** Parts added up per category, in the order the categories first appear. */
export function cardCategoryPartTotals(parts: readonly CardCategoryAmount[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const part of parts) totals.set(part.category, (totals.get(part.category) ?? 0) + part.amountMinor);
  return totals;
}

export interface CardSpendingAmounts {
  /** Net spending: charges plus credits. */
  spendingMinor: number;
  /** Positive spending rows (purchases, fees, interest). */
  chargesMinor: number;
  /** Negative spending rows (refunds, adjustments); zero or negative. */
  creditsMinor: number;
  /** Spending rows. */
  count: number;
}

export interface CardSpendingTotals extends CardSpendingAmounts {
  currency: string;
  /** Card payments (normally negative): transfers, never spending. */
  paymentsMinor: number;
  paymentCount: number;
  /** `other` rows: listed, never counted. */
  otherMinor: number;
  otherCount: number;
  /**
   * Posted asset purchases (precious metals the owner decided, and their exact refunds), net: not spending, never a
   * transfer. Present only when there are some, so spending + payments + other + asset purchases is every posted row.
   */
  assetPurchasesMinor?: number;
  assetPurchaseCount?: number;
}

export interface CardPendingTotals {
  currency: string;
  count: number;
  netMinor: number;
  chargesMinor: number;
  creditsMinor: number;
}

export interface CardSpendingMonth extends CardSpendingAmounts {
  /** YYYY-MM of the transaction date. */
  month: string;
  currency: string;
}

export interface CardSpendingCategory extends CardSpendingAmounts {
  category: string;
  currency: string;
}

export interface CardSpendingMerchant extends CardSpendingAmounts {
  /** The group's most common name. */
  merchant: string;
  /** Group key (`cardMerchantKey`); filter rows with the `merchant` query parameter set to it. */
  merchantKey: string;
  currency: string;
}

export interface CardSpendingOtherMerchants extends CardSpendingAmounts {
  currency: string;
  /** Distinct merchants summed here. */
  merchants: number;
}

export interface CardSpendingCard extends CardSpendingAmounts {
  cardAccountId: string;
  currency: string;
}

export interface CardSpendingOwner extends CardSpendingAmounts {
  owner: CardOwner;
  currency: string;
}

export interface CardSpendingMonthOwner extends CardSpendingAmounts {
  month: string;
  owner: CardOwner;
  currency: string;
}

export interface CardSpendingSummary {
  /** One entry per currency with counted rows, sorted by currency. */
  totals: CardSpendingTotals[];
  /** Pending rows, whether or not they are counted. */
  pending: CardPendingTotals[];
  /** Every month from the first to the last month with spending, per currency, oldest first. */
  byMonth: CardSpendingMonth[];
  /** The same months split by card owner (months without spending are left out). */
  byMonthOwner: CardSpendingMonthOwner[];
  byCategory: CardSpendingCategory[];
  /** The top merchants per currency by spending. */
  byMerchant: CardSpendingMerchant[];
  otherMerchants: CardSpendingOtherMerchants[];
  byCard: CardSpendingCard[];
  byOwner: CardSpendingOwner[];
}

export interface CardSpendingSummaryOptions {
  /** Owner of each card account; rows of unknown accounts are left out of the owner views. */
  owners?: ReadonlyMap<string, CardOwner>;
  /** Defaults to {@link CARD_SPENDING_TOP_MERCHANTS}. */
  topMerchants?: number;
  /**
   * Accepted category parts per row id (cardCategoryParts.ts). They change `byCategory` only: a split row's amount
   * goes to its parts' categories, and it counts once in each. Every other figure stays the row's own.
   */
  categoryParts?: ReadonlyMap<string, readonly CardCategoryAmount[]>;
  /**
   * Asset purchases by row id (cardSpendingExclusions.ts: owner rules and paired refunds as well). A row with the
   * owner's asset category is one with or without this map.
   */
  exclusions?: ReadonlyMap<string, CardSpendingExclusion>;
}

/** The row's exclusion: the resolved one by id, else the one its own category decides. */
export function cardSpendingExclusionOf(
  row: { id?: string; kind: CardTransactionKind; userCategory?: string | null },
  exclusions?: ReadonlyMap<string, CardSpendingExclusion>,
): CardSpendingExclusion | null {
  return (row.id === undefined ? undefined : exclusions?.get(row.id)) ?? ownerCardSpendingExclusion(row);
}

function zero(): CardSpendingAmounts {
  return { spendingMinor: 0, chargesMinor: 0, creditsMinor: 0, count: 0 };
}

function add(target: CardSpendingAmounts, amountMinor: number): void {
  target.spendingMinor += amountMinor;
  if (amountMinor > 0) target.chargesMinor += amountMinor;
  else target.creditsMinor += amountMinor;
  target.count += 1;
}

/** Buckets keyed by currency and a label, in first-seen order. */
class Buckets<T extends CardSpendingAmounts & { currency: string }> {
  private readonly map = new Map<string, T>();
  constructor(private readonly create: (currency: string, label: string) => T) {}
  add(currency: string, label: string, amountMinor: number): void {
    const key = JSON.stringify([currency, label]);
    let bucket = this.map.get(key);
    if (!bucket) {
      bucket = this.create(currency, label);
      this.map.set(key, bucket);
    }
    add(bucket, amountMinor);
  }
  values(): T[] {
    return [...this.map.values()];
  }
}

function byCurrencyThenSpending<T extends CardSpendingAmounts & { currency: string }>(label: (item: T) => string) {
  return (a: T, b: T): number =>
    compareText(a.currency, b.currency)
    || b.spendingMinor - a.spendingMinor
    || b.count - a.count
    || compareText(label(a), label(b));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Gaps between months are filled with zero months only up to this span. */
const MAX_FILLED_MONTHS = 1200;

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthLabel(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * The spending summary of `rows` (any statuses). Posted rows count; pending
 * rows are only totalled in `pending`; removed rows are ignored.
 */
export function summarizeCardSpending(
  rows: readonly CardSpendingRow[],
  options: CardSpendingSummaryOptions = {},
): CardSpendingSummary {
  const topMerchants = options.topMerchants ?? CARD_SPENDING_TOP_MERCHANTS;
  const totals = new Map<string, CardSpendingTotals>();
  const pending = new Map<string, CardPendingTotals>();
  const months = new Buckets<CardSpendingMonth>((currency, month) => ({ month, currency, ...zero() }));
  const monthOwners = new Buckets<CardSpendingMonthOwner>((currency, label) => {
    const [month, owner] = JSON.parse(label) as [string, CardOwner];
    return { month, owner, currency, ...zero() };
  });
  const categories = new Buckets<CardSpendingCategory>((currency, category) => ({ category, currency, ...zero() }));
  const merchants = new Buckets<CardSpendingMerchant>((currency, key) => ({ merchant: key, merchantKey: key, currency, ...zero() }));
  const merchantRows: CardSpendingRow[] = [];
  const cards = new Buckets<CardSpendingCard>((currency, cardAccountId) => ({ cardAccountId, currency, ...zero() }));
  const owners = new Buckets<CardSpendingOwner>((currency, owner) => ({ owner: owner as CardOwner, currency, ...zero() }));

  for (const row of rows) {
    if (row.status === 'pending') {
      let entry = pending.get(row.currency);
      if (!entry) {
        entry = { currency: row.currency, count: 0, netMinor: 0, chargesMinor: 0, creditsMinor: 0 };
        pending.set(row.currency, entry);
      }
      entry.count += 1;
      entry.netMinor += row.amountMinor;
      if (row.amountMinor > 0) entry.chargesMinor += row.amountMinor;
      else entry.creditsMinor += row.amountMinor;
      continue;
    } else if (row.status !== 'posted') {
      continue;
    }
    let total = totals.get(row.currency);
    if (!total) {
      total = { currency: row.currency, ...zero(), paymentsMinor: 0, paymentCount: 0, otherMinor: 0, otherCount: 0 };
      totals.set(row.currency, total);
    }
    const role = cardSpendingRole(row.kind);
    if (role === 'transfer') {
      total.paymentsMinor += row.amountMinor;
      total.paymentCount += 1;
      continue;
    }
    if (role === 'excluded') {
      total.otherMinor += row.amountMinor;
      total.otherCount += 1;
      continue;
    }
    if (cardSpendingExclusionOf(row, options.exclusions)) {
      total.assetPurchasesMinor = (total.assetPurchasesMinor ?? 0) + row.amountMinor;
      total.assetPurchaseCount = (total.assetPurchaseCount ?? 0) + 1;
      continue;
    }
    const month = row.transactionDate.slice(0, 7);
    add(total, row.amountMinor);
    months.add(row.currency, month, row.amountMinor);
    const parts = row.id === undefined ? undefined : options.categoryParts?.get(row.id);
    if (parts) {
      for (const [category, amountMinor] of cardCategoryPartTotals(parts)) categories.add(row.currency, category, amountMinor);
    } else {
      categories.add(row.currency, effectiveCardCategory(row), row.amountMinor);
    }
    merchantRows.push(row);
    cards.add(row.currency, row.cardAccountId, row.amountMinor);
    const owner = options.owners?.get(row.cardAccountId);
    if (owner) {
      owners.add(row.currency, owner, row.amountMinor);
      monthOwners.add(row.currency, JSON.stringify([month, owner]), row.amountMinor);
    }
  }

  const byMonth: CardSpendingMonth[] = [];
  const monthsByCurrency = new Map<string, Map<string, CardSpendingMonth>>();
  for (const month of months.values()) {
    const list = monthsByCurrency.get(month.currency) ?? new Map<string, CardSpendingMonth>();
    list.set(month.month, month);
    monthsByCurrency.set(month.currency, list);
  }
  for (const currency of [...monthsByCurrency.keys()].sort(compareText)) {
    const list = monthsByCurrency.get(currency)!;
    const keys = [...list.keys()].sort(compareText);
    const first = monthIndex(keys[0]);
    const last = monthIndex(keys[keys.length - 1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first >= MAX_FILLED_MONTHS) {
      for (const key of keys) byMonth.push(list.get(key)!);
      continue;
    }
    for (let index = first; index <= last; index += 1) {
      const month = monthLabel(index);
      byMonth.push(list.get(month) ?? { month, currency, ...zero() });
    }
  }

  // Merchants are grouped across descriptor variants ("FOURTH COFFEE #114 SEATTLE WA", "Fourth Coffee").
  const keyed = merchantRows.map((row) => ({ row, name: effectiveCardMerchant(row), key: cardMerchantKey(effectiveCardMerchant(row)) }));
  const merchantGroups = groupCardMerchantKeys(keyed.map((item) => item.key));
  const merchantNames = cardMerchantDisplayNames(keyed, merchantGroups);
  for (const item of keyed) merchants.add(item.row.currency, merchantGroups.get(item.key)!, item.row.amountMinor);
  for (const merchant of merchants.values()) merchant.merchant = merchantNames.get(merchant.merchantKey) ?? merchant.merchantKey;

  const byMerchant: CardSpendingMerchant[] = [];
  const otherMerchants: CardSpendingOtherMerchants[] = [];
  const sortedMerchants = merchants.values().sort(byCurrencyThenSpending((item) => item.merchant));
  const shown = new Map<string, number>();
  for (const merchant of sortedMerchants) {
    const count = shown.get(merchant.currency) ?? 0;
    if (count < topMerchants) {
      byMerchant.push(merchant);
      shown.set(merchant.currency, count + 1);
      continue;
    }
    let rest = otherMerchants.find((item) => item.currency === merchant.currency);
    if (!rest) {
      rest = { currency: merchant.currency, merchants: 0, ...zero() };
      otherMerchants.push(rest);
    }
    rest.merchants += 1;
    rest.spendingMinor += merchant.spendingMinor;
    rest.chargesMinor += merchant.chargesMinor;
    rest.creditsMinor += merchant.creditsMinor;
    rest.count += merchant.count;
  }

  return {
    totals: [...totals.values()].sort((a, b) => compareText(a.currency, b.currency)),
    pending: [...pending.values()].sort((a, b) => compareText(a.currency, b.currency)),
    byMonth,
    byMonthOwner: monthOwners.values().sort((a, b) =>
      compareText(a.currency, b.currency) || compareText(a.month, b.month) || compareText(a.owner, b.owner)),
    byCategory: categories.values().sort(byCurrencyThenSpending((item) => item.category)),
    byMerchant,
    otherMerchants,
    byCard: cards.values().sort(byCurrencyThenSpending((item) => item.cardAccountId)),
    byOwner: owners.values().sort(byCurrencyThenSpending((item) => item.owner)),
  };
}

/** What the merchants behind `otherMerchants` are read from, of a row the transaction list returns. */
export interface CardSpendingListedMerchantRow {
  status: string;
  role: string;
  currency: string;
  /** `cardMerchantKey` of the row's merchant, as the list gives it. */
  merchantKey: string;
  /** The row's merchant as the list gives it (`effectiveCardMerchant`). */
  merchantName: string;
  amountMinor: number;
  /** Under a category filter, what the row put in the category: what the summary counts for it then. */
  categoryPortionMinor?: number;
}

/** One merchant behind `otherMerchants`, read from the list's rows: grouped and named as the summary's `byMerchant`. */
export interface CardSpendingListedMerchant<T> extends Pick<CardSpendingMerchant, 'merchant' | 'merchantKey' | 'spendingMinor' | 'count'> {
  rows: T[];
}

/**
 * The merchants behind the summary's `otherMerchants` in one currency, from the list's rows for the same view and dates:
 * the rows the summary counts by merchant, less those of the merchants it lists by name (`listed`, its `byMerchant`),
 * grouped and named as it groups and names them, largest first as it orders them.
 *
 * Read to its last page (`complete`), the rows are every row the summary groups (over every currency's rows), so the
 * grouping is its own and they add up to its `otherMerchants`: as many merchants, as many rows and the amount. A read cut
 * short holds only some of them, and the group a row joins depends on the keys beside it ("<merchant> SEATTLE" joins
 * "<merchant>" only beside a row of the merchant's own key, which may be past the cut). So the listed merchants' keys
 * are grouped with the rows read, and a row the summary could file under a listed merchant (`matchesCardMerchantGroup`)
 * is left out: a merchant named above is never shown among the rest, and the rest are only those shown.
 */
export function cardSpendingOtherMerchants<T extends CardSpendingListedMerchantRow>(
  rows: readonly T[],
  listed: ReadonlyArray<Pick<CardSpendingMerchant, 'merchantKey' | 'currency'>>,
  currency: string,
  read: { complete: boolean },
): { merchants: CardSpendingListedMerchant<T>[]; spendingMinor: number; count: number } {
  const counted = rows.filter((row) => row.status === 'posted' && row.role === 'spending');
  const keys = counted.map((row) => row.merchantKey);
  const groups = groupCardMerchantKeys(read.complete ? keys : [...keys, ...listed.map((item) => item.merchantKey)]);
  const names = cardMerchantDisplayNames(counted.map((row) => ({ key: row.merchantKey, name: row.merchantName })), groups);
  const named = listed.filter((item) => item.currency === currency).map((item) => item.merchantKey);
  const shown = new Set(named);
  const isListed = (key: string, group: string) => (read.complete
    ? shown.has(group)
    : named.some((root) => matchesCardMerchantGroup(key, root)));
  const merchants = new Map<string, CardSpendingListedMerchant<T>>();
  for (const row of counted) {
    if (row.currency !== currency) continue;
    const merchantKey = groups.get(row.merchantKey) ?? row.merchantKey;
    if (isListed(row.merchantKey, merchantKey)) continue;
    const merchant = merchants.get(merchantKey)
      ?? { merchantKey, merchant: names.get(merchantKey) ?? merchantKey, spendingMinor: 0, count: 0, rows: [] };
    merchant.spendingMinor += row.categoryPortionMinor ?? row.amountMinor;
    merchant.count += 1;
    merchant.rows.push(row);
    merchants.set(merchantKey, merchant);
  }
  const sorted = [...merchants.values()].sort((a, b) => b.spendingMinor - a.spendingMinor || b.count - a.count
    || compareText(a.merchant, b.merchant) || compareText(a.merchantKey, b.merchantKey));
  return {
    merchants: sorted,
    spendingMinor: sorted.reduce((total, item) => total + item.spendingMinor, 0),
    count: sorted.reduce((total, item) => total + item.count, 0),
  };
}

export interface CardCoverageRange {
  /** Inclusive YYYY-MM-DD bounds. */
  start: string;
  end: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Sorted, disjoint ranges covering the same days as `ranges`: overlapping
 * and adjacent ranges are joined, so any day between two results is a gap.
 * Malformed ranges are ignored.
 */
export function mergeCardCoverage(ranges: readonly CardCoverageRange[]): CardCoverageRange[] {
  const valid = ranges
    .filter((range) => ISO_DATE.test(range.start) && ISO_DATE.test(range.end) && range.start <= range.end)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((a, b) => compareText(a.start, b.start) || compareText(a.end, b.end));
  const merged: CardCoverageRange[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (last && range.start <= dayAfter(last.end)) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** True when every day of `range` is inside `covered` (any order, may overlap). */
export function cardCoverageContains(covered: readonly CardCoverageRange[], range: CardCoverageRange): boolean {
  return mergeCardCoverage(covered).some((item) => item.start <= range.start && item.end >= range.end);
}

/** What has been imported for one card account. */
export interface CardAccountCoverage {
  cardAccountId: string;
  /** Merged coverage of every import that recorded one; the days between ranges are gaps. */
  ranges: CardCoverageRange[];
  /** Stored rows that are not removed, with their first and last transaction dates. */
  transactions: { count: number; first: string; last: string } | null;
  /** Imports of this card account, newest first. */
  imports: CardImportBatch[];
}

/**
 * A stored row as the API lists it: dedupe keys left out (they identify rows
 * for imports only), the kind Spending reads it as ({@link effectiveCardKind}),
 * the category and merchant it is reported under, and how it counts.
 */
export interface CardTransactionView extends Omit<CardTransaction, 'externalIdHash' | 'fingerprint'> {
  /** {@link effectiveCardCategory}. */
  category: string;
  /** {@link effectiveCardMerchant}. */
  merchantName: string;
  /** `cardMerchantKey` of the merchant name: the `merchant` filter value that finds its merchant. */
  merchantKey: string;
  role: CardSpendingRole;
  /** An asset purchase (role `excluded`): why it is not spending, and on whose word. Absent on every other row. */
  exclusion?: CardSpendingExclusion;
}

export function toCardTransactionView(stored: CardTransaction): CardTransactionView {
  const row = readCardSpendingRow(stored);
  const { externalIdHash: _externalIdHash, fingerprint: _fingerprint, ...rest } = row;
  const exclusion = ownerCardSpendingExclusion(row);
  return {
    ...rest,
    category: effectiveCardCategory(row),
    merchantName: effectiveCardMerchant(row),
    merchantKey: cardMerchantKey(effectiveCardMerchant(row)),
    role: exclusion ? 'excluded' : cardSpendingRole(row.kind),
    ...(exclusion ? { exclusion } : {}),
  };
}

/**
 * A view with the row's resolved exclusion (cardSpendingExclusions.ts: an owner rule or a paired refund as well as
 * the owner's category), or none: role and `exclusion` follow it; nothing else changes.
 */
export function withCardSpendingExclusion<T extends CardTransactionView>(view: T, exclusion: CardSpendingExclusion | null | undefined): T {
  if (exclusion) return { ...view, role: 'excluded', exclusion: { ...exclusion } };
  if (view.exclusion === undefined) return view;
  const { exclusion: _exclusion, ...rest } = view;
  return { ...rest, role: cardSpendingRole(view.kind) } as T;
}

/** Which card accounts a view covers: one card, one person's cards, or all of them. */
export interface CardAccountView {
  cardAccountId?: string;
  owner?: CardOwner;
}

/**
 * The currency a view's figures are shown in: the one most of the card
 * accounts in view use (ties go to the first code alphabetically), or USD when
 * none are in view. Amounts are never added across currencies, so the other
 * currencies are shown beside it. The Spending tab's figures and its insights
 * both use this, so a person whose cards use another currency than most see
 * their own.
 */
export function primaryCardCurrency(
  accounts: ReadonlyArray<Pick<CardAccount, 'id' | 'owner' | 'currency'>>,
  view: CardAccountView = {},
): string {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    if (view.cardAccountId && account.id !== view.cardAccountId) continue;
    if (view.owner && account.owner !== view.owner) continue;
    counts.set(account.currency, (counts.get(account.currency) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]?.[0] ?? 'USD';
}
