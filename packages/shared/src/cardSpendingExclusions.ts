/**
 * What counts as spending beyond a row's kind (cardSpending.ts): the owner's asset purchases (precious metals),
 * decided by the owner's category on the row or by an owner rule, with the exact refunds of those purchases; the
 * suggestions that ask the owner, which never change a total; and the accounting that splits a view's card activity
 * into spending, not spending (by reason) and transfers, so every part adds up to the card's activity.
 *
 * Precedence: the owner's category on the row > an owner rule > the exact refund of an excluded purchase > the
 * row's kind. A suggestion is never a decision.
 *
 * Card data cannot tell a gold bar from groceries (a warehouse club is one merchant category code either way), so
 * suggestions read only the descriptor's class and the amount, and only the owner decides. Every threshold is a
 * named constant here, in major units of the row's currency. Pure and deterministic.
 */
import { currencyExponent } from './cardImportTool/amount.js';
import { cardMerchantGroupRoot, cardMerchantKey } from './cardMerchants.js';
import {
  CARD_ASSET_CATEGORY,
  cardSpendingRole,
  effectiveCardMerchant,
  ownerCardSpendingExclusion,
  type CardSpendingExclusion,
} from './cardSpending.js';
import type { CardTransactionKind, CardTransactionStatus } from './types.js';

// ---------------------------------------------------------------------------
// Where precious metals are bought
// ---------------------------------------------------------------------------

/** Descriptor classes where precious metals are bought; a row of no class is never suggested. */
export const CARD_METALS_MERCHANT_CLASSES = [
  'bullion-dealer', 'costco-online', 'walmart-online', 'sams-club', 'costco-warehouse',
] as const;
export type CardMetalsMerchantClass = (typeof CARD_METALS_MERCHANT_CLASSES)[number];

export function isCardMetalsMerchantClass(value: unknown): value is CardMetalsMerchantClass {
  return typeof value === 'string' && (CARD_METALS_MERCHANT_CLASSES as readonly string[]).includes(value);
}

/** How strongly a suggestion is meant: what the descriptor class and the amount can say, never more. */
export type CardAssetSuggestionTier = 'likely' | 'possible' | 'weak';
const TIERS: readonly CardAssetSuggestionTier[] = ['likely', 'possible', 'weak'];

/**
 * Per class, the smallest purchase suggested (major units of the row's currency) and how strongly. Bullion dealers
 * sell nothing else; Costco, Sam's Club and Walmart sell bullion online only (Walmart's through marketplace sellers,
 * charged as Walmart.com), so a Costco warehouse descriptor is weak and needs a larger amount (an issuer may still
 * show an online order under it). Costco gas, travel, optical and pharmacy, Sam's Club fuel and Walmart stores are no
 * class at all.
 */
export const CARD_METALS_SUGGESTION_FLOORS: Readonly<Record<CardMetalsMerchantClass, { floor: number; tier: CardAssetSuggestionTier }>> = {
  'bullion-dealer': { floor: 0, tier: 'likely' },
  'costco-online': { floor: 1000, tier: 'possible' },
  'walmart-online': { floor: 1000, tier: 'possible' },
  'sams-club': { floor: 1000, tier: 'possible' },
  'costco-warehouse': { floor: 5000, tier: 'weak' },
};

/** A whole-dollar amount in steps of this many major units reads like gift cards: the suggestion drops one tier. */
export const CARD_METALS_GIFT_CARD_STEP = 25;
/** A refund goes with a purchase at most this many days after it. */
export const CARD_ASSET_REFUND_DAYS = 90;

/** Upper case, accents and apostrophes removed, every other mark a space: the text classes match. */
function classText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/['’‘`]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * Named bullion dealers, each its own seller (a refund at one never gives back a purchase at another), by the name
 * their descriptors carry. First match wins, so a dealer whose name holds a generic word comes before it.
 */
const BULLION_DEALERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['APMEX', /\bAPMEX\b/],
  ['JM BULLION', /\bJM ?BULLION\b/],
  ['SD BULLION', /\bSD ?BULLION\b/],
  ['HERO BULLION', /\bHERO ?BULLION\b/],
  ['BULLION EXCHANGES', /\bBULLION ?EXCHANGES?\b/],
  ['KITCO', /\bKITCO\b/],
  ['US MINT', /\bU ?S ?MINT\b|\bUNITED STATES MINT\b/],
  ['MONEY METALS', /\bMONEY ?METALS\b/],
  ['PROVIDENT METALS', /\bPROVIDENT ?METALS\b/],
  ['GAINESVILLE COINS', /\bGAINESVILLE ?COINS\b/],
  ['SILVER GOLD BULL', /\bSILVER ?GOLD ?BULL\b/],
  ['BGASC', /\bBGASC\b/],
  ['BOLD PRECIOUS METALS', /\bBOLD ?PRECIOUS\b/],
  ['GOLDSILVER', /\bGOLDSILVER\b/],
];
/** Generic words of a dealer the list does not name: its seller is its own merchant group. */
const BULLION_WORDS = /\bPRECIOUS METALS?\b|\bBULLION\b/;
const BULLION_DEALER = new RegExp([...BULLION_DEALERS.map(([, pattern]) => pattern.source), BULLION_WORDS.source].join('|'));
const COSTCO_ONLINE = /\bCOSTCO ?COM\b|\bCOSTCO ONLINE\b|\bWWW ?COSTCO\b/;
const SAMS_CLUB = /\bSAMS ?CLUB\b|\bSAMSCLUB\b/;
const WALMART_ONLINE = /\bWAL ?MART ?COM\b|\bWMT ?COM\b|\bWALMART ONLINE\b|\bWALMART MARKETPLACE\b/;
const COSTCO = /\bCOSTCO\b/;
/** Words of fuel: a gas station's descriptor. */
const GAS_WORDS = /\b(?:GAS|GASOLINE|FUEL)\b/;
/** Words of a service that sells no goods: travel, an optical shop, a pharmacy. */
const SERVICE_WORDS = /\b(?:TRAVEL|OPTICAL|PHARMACY|PHARM|RX)\b/;
/**
 * What is never bullion, at any position in the merchant name or the descriptor: a gas station or fuel, travel, an
 * optical shop, a pharmacy ("COSTCO GAS #0042", "COSTCO #0042 GAS", "COSTCO.COM PHARMACY"), or a Walmart store
 * ("WAL-MART #0042", "WALMART SUPERCENTER"). Such a row is no class at all, so nothing suggests it and no owner rule
 * covers it; only the owner's own category on the row can make it an asset purchase.
 */
const NEVER_WORDS = new RegExp(`${GAS_WORDS.source}|${SERVICE_WORDS.source}`);
const WALMART_STORE = /\bWAL ?MART (?:SUPER ?CENTER|NEIGHBORHOOD|STORE|\d)|\bWM SUPER ?CENTER\b|\bWALMART SUPER ?CENTER\b/;

/** First match wins, over the merchant name and the descriptor alike. */
const CLASS_ORDER: ReadonlyArray<readonly [RegExp, CardMetalsMerchantClass]> = [
  [BULLION_DEALER, 'bullion-dealer'],
  [COSTCO_ONLINE, 'costco-online'],
  [SAMS_CLUB, 'sams-club'],
  [WALMART_ONLINE, 'walmart-online'],
  [COSTCO, 'costco-warehouse'],
];

/** The texts classes read: the merchant name and the descriptor, folded. */
function classTexts(row: { merchant?: string | null; description: string }): string[] {
  return [row.merchant, row.description].filter((text): text is string => typeof text === 'string' && text.length > 0).map(classText);
}

/**
 * The class of a row's merchant name or descriptor, or null: a row any never-word or Walmart-store descriptor vetoes,
 * and anything else no class names.
 */
export function cardMetalsMerchantClass(row: { merchant?: string | null; description: string }): CardMetalsMerchantClass | null {
  const texts = classTexts(row);
  if (texts.some((text) => NEVER_WORDS.test(text) || WALMART_STORE.test(text))) return null;
  for (const [pattern, merchantClass] of CLASS_ORDER) {
    if (texts.some((text) => pattern.test(text))) return merchantClass;
  }
  return null;
}

/** The channels a Costco card descriptor shows (Costco receipts 4/7 §2.2): which kind of receipt can explain the row. */
export const COSTCO_DESCRIPTOR_CHANNELS = ['online', 'gas', 'warehouse', 'other'] as const;
export type CostcoDescriptorChannel = (typeof COSTCO_DESCRIPTOR_CHANNELS)[number];

/**
 * The Costco channel a row's descriptor shows, read from the descriptor alone, whatever merchant name an issuer gives
 * the row; null for a descriptor that isn't Costco's:
 * - `other`: travel, an optical shop or a pharmacy ("COSTCO TRAVEL", "COSTCO.COM PHARMACY"), which no receipt explains;
 * - `gas`: fuel ("COSTCO GAS #0042", "COSTCO #0042 GAS");
 * - `online`: Costco.com ("COSTCO.COM", "WWW COSTCO", "COSTCO ONLINE");
 * - `warehouse`: any other Costco descriptor ("COSTCO WHSE #0042").
 */
export function costcoDescriptorChannel(description: string): CostcoDescriptorChannel | null {
  const text = classText(description);
  const online = COSTCO_ONLINE.test(text);
  if (!online && !COSTCO.test(text)) return null;
  if (SERVICE_WORDS.test(text)) return 'other';
  if (GAS_WORDS.test(text)) return 'gas';
  return online ? 'online' : 'warehouse';
}

/** Where a row was sold, as its descriptor shows: online, in a store, or not shown (or shown both ways). */
export type CardSellerChannel = 'online' | 'store' | 'unknown';

/** An online marker in a folded descriptor: "SAMSCLUB.COM", "WWW.SAMPLE.COM", "SAMPLE COINS ONLINE". */
const ONLINE_MARKER = /\b(?:COM|WWW|ONLINE)\b/;
/** A store number in a descriptor: "#001", "STORE 0042", "WHSE #0042". */
const STORE_NUMBER = /#\s*\d|\b(?:STORE|STR|WHSE|WAREHOUSE)\s*#?\s*\d/;
/** US state and territory codes: a store descriptor's place ends with one ("SAMPLETOWN WA"). */
const PLACE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR', 'GU', 'VI',
]);

/** A city and a state code at the end of a folded descriptor, before an optional ZIP code or country: "SAMPLETOWN WA". */
function placeTail(words: readonly string[]): boolean {
  let end = words.length;
  while (end > 0 && /^(?:\d{5}|US|USA)$/.test(words[end - 1])) end -= 1;
  return end >= 3 && PLACE_CODES.has(words[end - 1]) && /^[A-Z]{3,}$/.test(words[end - 2]) && !ONLINE_MARKER.test(words[end - 2]);
}

/**
 * The channel a row's descriptor shows, read from the descriptor alone, whatever merchant name an issuer gives the row:
 * - online for an online marker (".COM", "WWW", "ONLINE"), unless the descriptor also has a store number (then
 *   unknown: it says both);
 * - store for a store number ("#001", "STORE 0042") or a city and state at its end ("SAMPLETOWN WA"); a city and state
 *   beside an online marker is the online shop's own address ("SAMPLE.COM SEATTLE WA") and leaves it online;
 * - unknown for anything else.
 */
export function cardSellerChannel(description: string): CardSellerChannel {
  const folded = classText(description);
  const online = ONLINE_MARKER.test(folded);
  const numbered = STORE_NUMBER.test(description.normalize('NFKD').toUpperCase());
  if (online) return numbered ? 'unknown' : 'online';
  return numbered || placeTail(folded.split(' ')) ? 'store' : 'unknown';
}

/** Who sold a row, for refunds: the canonical merchant, and the channel its descriptor shows. */
export interface CardRefundSeller {
  /**
   * `costco` (Costco online and warehouse alike), `walmart` (Walmart.com), `sams-club`, `dealer:<NAME>` for each named
   * bullion dealer, else `merchant:<merchant group root>` (the issuer's merchant name when it has one).
   */
  merchant: string;
  channel: CardSellerChannel;
}

/** The only merchant whose online and store channels are one seller for refunds. */
const COSTCO_SELLER = 'costco';

/**
 * Who sold a row, for refunds: a refund gives back only a purchase from the same canonical merchant. Each named
 * bullion dealer is its own merchant; Costco's online and warehouse descriptors are one; anything else is its exact
 * merchant group. The channel comes from the descriptor alone, so a merchant name an issuer shows for both an online
 * order and a store visit ("SAM'S CLUB") never hides which one a row is.
 */
export function cardRefundSeller(row: { merchant?: string | null; description: string }): CardRefundSeller {
  const channel = cardSellerChannel(row.description);
  const merchantClass = cardMetalsMerchantClass(row);
  if (merchantClass === 'costco-online' || merchantClass === 'costco-warehouse') return { merchant: COSTCO_SELLER, channel };
  if (merchantClass === 'walmart-online') return { merchant: 'walmart', channel };
  if (merchantClass === 'sams-club') return { merchant: 'sams-club', channel };
  if (merchantClass === 'bullion-dealer') {
    const texts = classTexts(row);
    const dealer = BULLION_DEALERS.find(([, pattern]) => texts.some((text) => pattern.test(text)));
    if (dealer) return { merchant: `dealer:${dealer[0]}`, channel };
  }
  const key = cardMerchantKey(effectiveCardMerchant(row));
  // Normalized again once a suffix is gone: "SAMPLE TV STORE RETURN" is the merchant "SAMPLE TV STORE" is.
  return { merchant: `merchant:${cardMerchantGroupRoot(cardMerchantKey(cardMerchantGroupRoot(key)))}`, channel };
}

/**
 * How surely a refund could give a purchase back, by who sold each:
 * - `exact`: the same canonical merchant and the same known channel (Costco online and warehouse alike, both known);
 * - `possible`: the same canonical merchant, but a channel unknown on either side or different (bought online,
 *   refunded in a store): never paired automatically, the owner's to decide;
 * - `none`: different merchants.
 */
type SellerRelation = 'exact' | 'possible' | 'none';
function sellerRelation(purchase: CardExclusionRow, refund: CardExclusionRow): SellerRelation {
  const bought = sellerOf(purchase);
  const returned = sellerOf(refund);
  if (bought.merchant !== returned.merchant) return 'none';
  if (bought.channel === 'unknown' || returned.channel === 'unknown') return 'possible';
  return bought.channel === returned.channel || bought.merchant === COSTCO_SELLER ? 'exact' : 'possible';
}

// Per row object: the class and the seller are read many times. A row whose texts changed is read again.
interface Memo<T> { merchant: unknown; description: string; value: T }
const classes = new WeakMap<object, Memo<CardMetalsMerchantClass | null>>();
const sellers = new WeakMap<object, Memo<CardRefundSeller>>();
function memo<T>(cache: WeakMap<object, Memo<T>>, row: { merchant?: string | null; description: string }, read: () => T): T {
  const hit = cache.get(row);
  if (hit && hit.merchant === row.merchant && hit.description === row.description) return hit.value;
  const value = read();
  cache.set(row, { merchant: row.merchant, description: row.description, value });
  return value;
}
function classOf(row: CardExclusionRow): CardMetalsMerchantClass | null {
  return memo(classes, row, () => cardMetalsMerchantClass(row));
}
function sellerOf(row: CardExclusionRow): CardRefundSeller {
  return memo(sellers, row, () => cardRefundSeller(row));
}

function scale(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyExponent(currency));
}

/** A class's suggestion floor in minor units of `currency`. */
export function cardMetalsSuggestionFloorMinor(merchantClass: CardMetalsMerchantClass, currency: string): number {
  return scale(CARD_METALS_SUGGESTION_FLOORS[merchantClass].floor, currency);
}

// ---------------------------------------------------------------------------
// Owner rules and exclusions
// ---------------------------------------------------------------------------

/**
 * The owner's rule: "<class> purchases of at least <amount> in <currency> are precious metals". It applies, when the
 * rows are read, to every matching purchase, past and future, without an owner category; revoking it puts them back.
 */
export interface CardSpendingRule {
  id: string;
  reason: 'asset-purchase';
  /** Always {@link CARD_ASSET_CATEGORY}. */
  category: string;
  merchantClass: CardMetalsMerchantClass;
  currency: string;
  minAmountMinor: number;
  createdAt: string;
  /** Null while it applies. */
  revokedAt: string | null;
}

/** The fields of a row exclusions, suggestions and the accounting read. */
export interface CardExclusionRow {
  id: string;
  cardAccountId: string;
  transactionDate: string;
  /** When it posted, if known: refunds are attributed to purchases in posting order. */
  postedDate?: string | null;
  status: CardTransactionStatus;
  kind: CardTransactionKind;
  amountMinor: number;
  currency: string;
  description: string;
  merchant?: string | null;
  userCategory?: string | null;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byDateThenId = (a: CardExclusionRow, b: CardExclusionRow) => byText(a.transactionDate, b.transactionDate) || byText(a.id, b.id);
/** Posting order: the posted date (the transaction date when there is none), then the transaction date, then the id. */
const byPosting = (a: CardExclusionRow, b: CardExclusionRow) =>
  byText(a.postedDate || a.transactionDate, b.postedDate || b.transactionDate) || byDateThenId(a, b);

/** Rules in force, oldest first: the first that matches a row is the one it is excluded by. */
function activeRules(rules: readonly CardSpendingRule[]): CardSpendingRule[] {
  return rules.filter((rule) => rule.revokedAt === null || rule.revokedAt === undefined)
    .sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id));
}

/** A purchase the rule covers, owner categories aside. */
function ruleCovers(rule: CardSpendingRule, row: CardExclusionRow): boolean {
  return row.kind === 'purchase' && row.amountMinor > 0 && row.currency === rule.currency
    && row.amountMinor >= rule.minAmountMinor && classOf(row) === rule.merchantClass;
}

function dayNumber(date: string): number {
  let day = days.get(date);
  if (day === undefined) {
    day = Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
    days.set(date, day);
  }
  return day;
}
/** Calendar dates to day numbers: dates repeat across rows and requests, and there are only so many of them. */
const days = new Map<string, number>();

/** A posted refund the owner has not filed, not yet out of spending: one that could give a purchase back. */
const openRefund = (row: CardExclusionRow, excluded: ReadonlyMap<string, unknown>) =>
  row.status === 'posted' && row.kind === 'refund' && row.amountMinor < 0 && !row.userCategory && !excluded.has(row.id);

/**
 * A posted purchase and a later refund on the same card from the same canonical merchant, within the window: the
 * refund could give the purchase back. Whether it could be paired automatically also needs the same known channel
 * (`sellerRelation`).
 */
function couldGiveBack(purchase: CardExclusionRow, refund: CardExclusionRow): boolean {
  const gap = dayNumber(refund.transactionDate) - dayNumber(purchase.transactionDate);
  return purchase.status === 'posted' && purchase.kind === 'purchase' && purchase.amountMinor > 0
    && purchase.cardAccountId === refund.cardAccountId && purchase.currency === refund.currency
    && gap >= 0 && gap <= CARD_ASSET_REFUND_DAYS && sellerRelation(purchase, refund) !== 'none';
}

/** What refunds did to purchases (`attributeRefunds`). */
interface RefundAttribution {
  /** Refund id → the purchase it gives back exactly: that purchase's whole remaining amount, the only one it can be. */
  pairs: Map<string, string>;
  /**
   * Refund id → the purchases a refund without an owner category and without a pair could belong to (none: it
   * belongs to no purchase); whether one of them had already been refunded in part or in a way nobody decided; and
   * whether the channels leave it unconfirmed (a channel unknown, or bought online and refunded in a store).
   */
  related: Map<string, { purchaseIds: string[]; afterEarlierRefund: boolean; channelUnconfirmed: boolean }>;
}

/**
 * Refunds attributed to purchases, in posting order. A purchase's remaining amount is what it cost less every refund
 * attributed to it so far. A refund could belong to a posted purchase on the same card from the same canonical
 * merchant, within {@link CARD_ASSET_REFUND_DAYS} before it, with something remaining and at least the refund's amount.
 * - A refund the owner filed as precious metals is attributed to the purchase it could belong to, when there is only
 *   one, from the same known channel (`sellerRelation` exact), and the refund fits within what remains of it; that
 *   remaining amount goes down by it.
 * - A refund without an owner category is paired, and gives the purchase back in full, only when it could belong to
 *   one purchase alone, from the same known channel, whose remaining amount is known and equals the refund to the
 *   cent. Remaining 0 pairs nothing.
 * - Any other refund is attributed to nothing, so each purchase it could belong to has an unknown remaining amount from
 *   then on, and no later refund pairs with it: a later credit of the original amount after a partial refund, or after
 *   a refund whose channel is not confirmed, is the owner's to decide.
 * A refund the owner filed under another category is the owner's spending and is attributed to nothing. Independent of
 * what is excluded, so confirming one purchase never changes another's refund.
 */
function attributeRefunds(rows: readonly CardExclusionRow[]): RefundAttribution {
  interface Open { row: CardExclusionRow; remaining: number; uncertain: boolean }
  const cardKey = (row: CardExclusionRow) => JSON.stringify([row.cardAccountId, row.currency]);
  const byCard = new Map<string, Open[]>();
  for (const row of rows) {
    if (row.status !== 'posted' || row.kind !== 'purchase' || row.amountMinor <= 0) continue;
    byCard.set(cardKey(row), [...(byCard.get(cardKey(row)) ?? []), { row, remaining: row.amountMinor, uncertain: false }]);
  }
  const pairs = new Map<string, string>();
  const related = new Map<string, { purchaseIds: string[]; afterEarlierRefund: boolean; channelUnconfirmed: boolean }>();
  const refunds = rows.filter((row) => row.status === 'posted' && row.kind === 'refund' && row.amountMinor < 0
    && (!row.userCategory || ownerCardSpendingExclusion(row) !== null)).sort(byPosting);
  for (const refund of refunds) {
    const amount = -refund.amountMinor;
    const could = (byCard.get(cardKey(refund)) ?? [])
      .filter((open) => open.remaining > 0 && open.row.amountMinor >= amount && couldGiveBack(open.row, refund));
    const owners = Boolean(refund.userCategory);
    if (could.length === 1 && could[0].remaining >= amount && sellerRelation(could[0].row, refund) === 'exact') {
      const [only] = could;
      if (owners) {
        only.remaining -= amount;
        continue;
      }
      if (!only.uncertain && only.remaining === amount) {
        only.remaining = 0;
        pairs.set(refund.id, only.row.id);
        continue;
      }
    }
    const afterEarlierRefund = could.some((open) => open.uncertain || open.remaining < open.row.amountMinor);
    const channelUnconfirmed = could.some((open) => sellerRelation(open.row, refund) === 'possible');
    for (const open of could) open.uncertain = true;
    if (!owners && could.length > 0) {
      related.set(refund.id, {
        purchaseIds: could.map((open) => open.row).sort(byDateThenId).map((row) => row.id), afterEarlierRefund, channelUnconfirmed,
      });
    }
  }
  return { pairs, related };
}

/**
 * Every row's exclusion, by id: the owner's asset category on a spending row; else, for a purchase without an owner
 * category, the first owner rule in force that covers it; then, for a refund without an owner category, the exact,
 * unambiguous refund of a posted excluded purchase. Rows the owner filed under any other category stay spending,
 * whatever a rule says. Removed rows have none; a pending purchase a rule covers is marked, but pending rows are never
 * spending anyway.
 */
export function resolveCardSpendingExclusions(
  rows: readonly CardExclusionRow[],
  rules: readonly CardSpendingRule[] = [],
): Map<string, CardSpendingExclusion> {
  const active = activeRules(rules);
  const exclusions = new Map<string, CardSpendingExclusion>();
  for (const row of rows) {
    if (row.status !== 'posted' && row.status !== 'pending') continue;
    if (cardSpendingRole(row.kind) !== 'spending') continue;
    if (row.userCategory) {
      const own = ownerCardSpendingExclusion(row);
      if (own) exclusions.set(row.id, own);
      continue;
    }
    const rule = active.find((candidate) => ruleCovers(candidate, row));
    if (rule) exclusions.set(row.id, { reason: 'asset-purchase', source: 'owner-rule', ruleId: rule.id });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [refundId, purchaseId] of attributeRefunds(rows).pairs) {
    const refund = byId.get(refundId)!;
    if (refund.userCategory || exclusions.has(refundId) || !exclusions.has(purchaseId)) continue;
    exclusions.set(refundId, { reason: 'asset-purchase', source: 'paired-refund', purchaseId });
  }
  return exclusions;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Why a row is suggested, as codes the UI words. */
export type CardAssetSuggestionSignal =
  | 'bullion-dealer'
  | 'online-warehouse-club'
  | 'online-big-box'
  | 'warehouse-descriptor'
  | 'at-or-over-floor'
  | 'gift-card-like'
  | 'refund-of-excluded'
  | 'refund-of-suggested'
  | 'partial-refund'
  | 'ambiguous-refund'
  | 'after-earlier-refund'
  | 'channel-unconfirmed';

/** A row the owner may want to call precious metals. Counted as spending until the owner decides. */
export interface CardAssetSuggestion {
  id: string;
  /** A purchase, or a refund that may give one back. */
  kind: 'purchase' | 'refund';
  merchantClass: CardMetalsMerchantClass | null;
  tier: CardAssetSuggestionTier;
  signals: CardAssetSuggestionSignal[];
  cardAccountId: string;
  transactionDate: string;
  currency: string;
  amountMinor: number;
  /** A purchase's exact refunds, which would go with it once it is confirmed (when every suggestion shown is). */
  followingRefundIds: string[];
  followingRefundsMinor: number;
  /** A refund's purchases (excluded or suggested) it may give back, oldest first. */
  purchaseIds: string[];
  /** What confirming it takes out of spending: its own amount and its following refunds'. */
  effectMinor: number;
}

const tierRank = (tier: CardAssetSuggestionTier) => TIERS.indexOf(tier);
const lower = (tier: CardAssetSuggestionTier): CardAssetSuggestionTier => TIERS[Math.min(TIERS.length - 1, tierRank(tier) + 1)];

const CLASS_SIGNAL: Readonly<Record<CardMetalsMerchantClass, CardAssetSuggestionSignal>> = {
  'bullion-dealer': 'bullion-dealer',
  'costco-online': 'online-warehouse-club',
  'sams-club': 'online-warehouse-club',
  'walmart-online': 'online-big-box',
  'costco-warehouse': 'warehouse-descriptor',
};

/** A posted purchase no one decided: no owner category, not out of spending. */
const openPurchase = (row: CardExclusionRow, excluded: ReadonlyMap<string, unknown>) =>
  row.status === 'posted' && row.kind === 'purchase' && row.amountMinor > 0 && !row.userCategory && !excluded.has(row.id);

/**
 * Suggestions over every card row, given the resolved exclusions: posted purchases with no owner category that are
 * not out of spending, of a class and at or over its floor (a gift-card-like amount drops one tier), each with its
 * exact, unambiguous refunds, which go with it once it is confirmed; then refunds without an owner category or a pair
 * that could belong to an excluded or suggested purchase (`attributeRefunds`: a partial refund, one of several
 * purchases, a refund after an earlier one, or one whose channel does not confirm the purchase's), for the owner to
 * decide (one smaller than its seller's floor is asked as weak). A paired refund is never suggested on its own.
 * Strongest tier first, then the largest effect.
 */
export function suggestCardAssetPurchases(
  rows: readonly CardExclusionRow[],
  exclusions: ReadonlyMap<string, CardSpendingExclusion>,
): CardAssetSuggestion[] {
  const { pairs, related } = attributeRefunds(rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const purchases: CardAssetSuggestion[] = [];
  for (const row of rows) {
    if (!openPurchase(row, exclusions)) continue;
    const merchantClass = cardMetalsMerchantClass(row);
    if (!merchantClass || row.amountMinor < cardMetalsSuggestionFloorMinor(merchantClass, row.currency)) continue;
    const signals: CardAssetSuggestionSignal[] = [CLASS_SIGNAL[merchantClass], 'at-or-over-floor'];
    let tier = CARD_METALS_SUGGESTION_FLOORS[merchantClass].tier;
    const step = scale(CARD_METALS_GIFT_CARD_STEP, row.currency);
    if (step > 0 && row.amountMinor % step === 0) {
      signals.push('gift-card-like');
      tier = lower(tier);
    }
    // Its exact refunds the owner has not filed: confirming the purchase takes them out of spending too.
    const following = [...pairs].filter(([refundId, purchaseId]) => purchaseId === row.id && openRefund(byId.get(refundId)!, exclusions))
      .map(([refundId]) => byId.get(refundId)!).sort(byDateThenId);
    const followingRefundsMinor = following.reduce((sum, refund) => sum + refund.amountMinor, 0);
    purchases.push({
      id: row.id, kind: 'purchase', merchantClass, tier, signals, cardAccountId: row.cardAccountId,
      transactionDate: row.transactionDate, currency: row.currency, amountMinor: row.amountMinor,
      followingRefundIds: following.map((refund) => refund.id), followingRefundsMinor, purchaseIds: [],
      effectMinor: row.amountMinor + followingRefundsMinor,
    });
  }

  // Refunds that could belong to an excluded or suggested purchase, but not exactly and alone: the owner decides.
  const following = new Set(purchases.flatMap((item) => item.followingRefundIds));
  const excludedIds = new Set(rows.filter((row) => row.status === 'posted' && row.kind === 'purchase'
    && exclusions.get(row.id)?.reason === 'asset-purchase').map((row) => row.id));
  const tierOf = new Map(purchases.map((item) => [item.id, item.tier]));
  const refunds: CardAssetSuggestion[] = [];
  for (const row of rows) {
    if (!openRefund(row, exclusions) || following.has(row.id) || pairs.has(row.id)) continue;
    const could = related.get(row.id);
    if (!could) continue;
    const ofExcluded = could.purchaseIds.filter((id) => excludedIds.has(id));
    const ofSuggested = could.purchaseIds.filter((id) => tierOf.has(id));
    if (ofExcluded.length === 0 && ofSuggested.length === 0) continue;
    const signals: CardAssetSuggestionSignal[] = [];
    if (ofExcluded.length > 0) signals.push('refund-of-excluded');
    if (ofSuggested.length > 0) signals.push('refund-of-suggested');
    // Why it is not paired: more than one purchase it could be, an earlier refund, a part of one, or the channels.
    const only = could.purchaseIds.length === 1 ? byId.get(could.purchaseIds[0]) : undefined;
    if (could.purchaseIds.length > 1) signals.push('ambiguous-refund');
    else if (could.afterEarlierRefund) signals.push('after-earlier-refund');
    else if (only && -row.amountMinor < only.amountMinor) signals.push('partial-refund');
    if (could.channelUnconfirmed) signals.push('channel-unconfirmed');
    const relatedRows = [...ofExcluded, ...ofSuggested].map((id) => byId.get(id)!).sort(byDateThenId);
    // A refund smaller than its seller's floor may well be an ordinary item's: still the owner's to decide, asked last.
    const floor = Math.min(...relatedRows.map((purchase) => {
      const merchantClass = classOf(purchase);
      return merchantClass ? cardMetalsSuggestionFloorMinor(merchantClass, row.currency) : 0;
    }));
    const tier: CardAssetSuggestionTier = -row.amountMinor < floor ? 'weak' : ofExcluded.length > 0 ? 'possible'
      : ofSuggested.map((id) => tierOf.get(id)!).sort((a, b) => tierRank(a) - tierRank(b))[0];
    refunds.push({
      id: row.id, kind: 'refund', merchantClass: cardMetalsMerchantClass(row), tier, signals,
      cardAccountId: row.cardAccountId, transactionDate: row.transactionDate, currency: row.currency,
      amountMinor: row.amountMinor, followingRefundIds: [], followingRefundsMinor: 0,
      purchaseIds: relatedRows.map((purchase) => purchase.id), effectMinor: row.amountMinor,
    });
  }
  return [...purchases, ...refunds].sort((a, b) => tierRank(a.tier) - tierRank(b.tier)
    || Math.abs(b.effectMinor) - Math.abs(a.effectMinor) || byText(a.transactionDate, b.transactionDate) || byText(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/** A sum of posted rows: net, its positive and negative parts, and how many. */
export interface CardAccountingAmounts {
  netMinor: number;
  chargesMinor: number;
  creditsMinor: number;
  count: number;
}

/**
 * A view's posted card activity in one currency, every row in exactly one part:
 * activity = spending + notSpending + transfers, and notSpending = assetPurchases + other, for each of net, charges,
 * credits and count. Pending rows are apart, in none of them.
 */
export interface CardSpendingAccounting {
  currency: string;
  activity: CardAccountingAmounts;
  /** As `/spending/summary` counts it. */
  spending: CardAccountingAmounts;
  notSpending: CardAccountingAmounts & {
    /** Precious metals the owner decided (by category or rule) and their exact refunds. */
    assetPurchases: CardAccountingAmounts;
    /** `other` rows: cash advances, balance transfers, zero amounts. */
    other: CardAccountingAmounts;
  };
  /** Card payments. */
  transfers: CardAccountingAmounts;
  pending: { count: number; netMinor: number };
  /**
   * What confirming every suggestion shown would take out of `spending`: the suggested rows in view and the exact
   * refunds that would go with them, among the rows given (the caller passes the suggestions of its view).
   */
  possibleAssetPurchases: CardAccountingAmounts;
}

const none = (): CardAccountingAmounts => ({ netMinor: 0, chargesMinor: 0, creditsMinor: 0, count: 0 });

function addTo(target: CardAccountingAmounts, amountMinor: number): void {
  target.netMinor += amountMinor;
  if (amountMinor > 0) target.chargesMinor += amountMinor;
  else target.creditsMinor += amountMinor;
  target.count += 1;
}

/**
 * The accounting of `rows` (the view's rows, of any status), per currency with posted or pending rows, sorted by
 * currency. A row's exclusion is the resolved one by id, else the one its own category decides; `suggestions` mark
 * what is possible (they never move a row).
 */
export function buildCardSpendingAccounting(
  rows: ReadonlyArray<Pick<CardExclusionRow, 'id' | 'status' | 'kind' | 'amountMinor' | 'currency' | 'userCategory'>>,
  options: { exclusions?: ReadonlyMap<string, CardSpendingExclusion>; suggestions?: readonly CardAssetSuggestion[] } = {},
): CardSpendingAccounting[] {
  const possible = new Set<string>();
  for (const item of options.suggestions ?? []) {
    possible.add(item.id);
    for (const id of item.followingRefundIds) possible.add(id);
  }
  const byCurrency = new Map<string, CardSpendingAccounting>();
  for (const row of rows) {
    if (row.status !== 'posted' && row.status !== 'pending') continue;
    let entry = byCurrency.get(row.currency);
    if (!entry) {
      entry = {
        currency: row.currency, activity: none(), spending: none(),
        notSpending: { ...none(), assetPurchases: none(), other: none() }, transfers: none(),
        pending: { count: 0, netMinor: 0 }, possibleAssetPurchases: none(),
      };
      byCurrency.set(row.currency, entry);
    }
    if (row.status === 'pending') {
      entry.pending.count += 1;
      entry.pending.netMinor += row.amountMinor;
      continue;
    }
    addTo(entry.activity, row.amountMinor);
    const role = cardSpendingRole(row.kind);
    if (role === 'transfer') {
      addTo(entry.transfers, row.amountMinor);
    } else if (role === 'excluded') {
      addTo(entry.notSpending, row.amountMinor);
      addTo(entry.notSpending.other, row.amountMinor);
    } else if (options.exclusions?.get(row.id) ?? ownerCardSpendingExclusion(row)) {
      addTo(entry.notSpending, row.amountMinor);
      addTo(entry.notSpending.assetPurchases, row.amountMinor);
    } else {
      addTo(entry.spending, row.amountMinor);
      if (possible.has(row.id)) addTo(entry.possibleAssetPurchases, row.amountMinor);
    }
  }
  return [...byCurrency.values()].sort((a, b) => byText(a.currency, b.currency));
}

// ---------------------------------------------------------------------------
// Rule previews
// ---------------------------------------------------------------------------

/** What a new owner rule would do to the posted rows, before the owner makes it. */
export interface CardSpendingRulePreview {
  /** Purchases it would take out of spending, and the exact refunds that would go with them. */
  purchases: number;
  refunds: number;
  amounts: CardAccountingAmounts;
  /** Their first and last transaction dates; null when there are none. */
  firstDate: string | null;
  lastDate: string | null;
  /** Covered purchases it leaves as they are: the owner filed each under another category. */
  ownerDecided: number;
  /** Covered purchases already out of spending (by the owner's category or another rule). */
  alreadyExcluded: number;
  /**
   * The ids of the rows it would take out (`purchases` and `refunds`), sorted: what a rule made from this preview is
   * bound to (the API's preview match), so the owner makes the rule they saw.
   */
  rowIds: string[];
}

/** The candidate rule's effect, given every card row and the rules already made. */
export function previewCardSpendingRule(
  rows: readonly CardExclusionRow[],
  rules: readonly CardSpendingRule[],
  candidate: Pick<CardSpendingRule, 'merchantClass' | 'currency' | 'minAmountMinor'>,
): CardSpendingRulePreview {
  const before = resolveCardSpendingExclusions(rows, rules);
  const rule: CardSpendingRule = {
    id: 'preview', reason: 'asset-purchase', category: CARD_ASSET_CATEGORY, ...candidate,
    createdAt: '9999-12-31T23:59:59.999Z', revokedAt: null,
  };
  const after = resolveCardSpendingExclusions(rows, [...rules, rule]);
  const amounts = none();
  let purchases = 0;
  let refunds = 0;
  const dates: string[] = [];
  let ownerDecided = 0;
  let alreadyExcluded = 0;
  const rowIds: string[] = [];
  for (const row of rows) {
    if (row.status !== 'posted') continue;
    if (ruleCovers(rule, row)) {
      if (before.has(row.id)) alreadyExcluded += 1;
      else if (row.userCategory) ownerDecided += 1;
    }
    if (before.has(row.id) || !after.has(row.id)) continue;
    addTo(amounts, row.amountMinor);
    if (row.kind === 'refund') refunds += 1;
    else purchases += 1;
    dates.push(row.transactionDate);
    rowIds.push(row.id);
  }
  dates.sort(byText);
  return {
    purchases, refunds, amounts, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null, ownerDecided, alreadyExcluded,
    rowIds: rowIds.sort(byText),
  };
}
