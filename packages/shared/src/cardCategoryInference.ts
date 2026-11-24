/**
 * Inferred categories: a category for a card row that has neither the owner's own category nor an issuer's,
 * worked out when a Spending answer is read and never stored. The card ledger never changes, and no amount,
 * merchant, card or person moves; only the category a row is filed under does.
 *
 * Two sources, in order:
 * 1. Merchant history. The household's own rows that carry an issuer category are grouped by merchant (the
 *    {@link cardMerchantGroupRoot} of the issuer's merchant name and of the descriptor). A group whose rows
 *    agree on one category, in at least {@link CARD_CATEGORY_INFERENCE_MIN_OBSERVATIONS} rows and at least
 *    four in five of them, lends it to rows of the same merchant that have none. The map exists only inside the
 *    model a request builds: it is never stored, logged, returned whole or committed.
 * 2. A small reviewed table of generic rules ({@link CARD_CATEGORY_RULES}): card fees and interest by their
 *    kind, then widely known chains and plain words ("SUPERMARKET", "PARKING"), for merchants the household's
 *    history does not cover. Never a list drawn from the household's own rows. Rule categories are written in
 *    the issuers' category names; where the household's stored issuer categories spell one differently (case,
 *    accents, punctuation, "&" or "and"), the stored spelling is used, so filters compare like for like.
 *
 * A credit whose words name a fee or interest (a refund or an adjustment) takes the category the charge it gives back
 * would get: it goes through the kind rules, merchant history and the merchant rules with its own words, less the words
 * that give it back, and the kind the import classifier gives a charge with those words (cardKinds.ts,
 * `cardGivenBackCharge`), and one with a category teaches merchant history as that charge. So a fee its words make one
 * and its give-back net in one category: a card's fee or interest and its give-back under the card's fees, a merchant's
 * fee and its refund ("SAMPLE PARKING FEE REFUND") with that merchant. A charge only its issuer's type makes a fee,
 * with words the classifier reads as a purchase, is not known from its credit's words: its credit goes by them.
 *
 * One kind of charge takes a reviewed rule's category over the issuer's as well: a tax paid by card. No issuer's
 * taxonomy has a tax category, so each files a federal tax payment ("United States Treasury Tax Payment" on the
 * statement) under one of its own, such as utilities or miscellaneous. A rule marked
 * {@link CardCategoryRule.overIssuer} files it, and the credits that give it back, under {@link CARD_TAX_CATEGORY}
 * instead, before the kind rules and merchant history, and the rows it files over their issuer's category teach
 * merchant history nothing.
 *
 * Precedence, with cardCategoryParts.ts: the owner's own category (whole row) > Amazon item parts > a rule over the
 * issuer's category (a tax payment) > the issuer's category > inferred > Uncategorized. Apart from such a rule,
 * inference only fills spending rows, and split residuals, with no issuer category. Pure and deterministic.
 */

import { cardMerchantGroupRoot, cardMerchantKey, isCardMerchantKey } from './cardMerchants.js';
import {
  CARD_CATEGORY_AIRLINE as AIRLINE,
  CARD_CATEGORY_BAR_CAFE as CAFE,
  CARD_CATEGORY_ELECTRONICS_STORES as ELECTRONICS,
  CARD_CATEGORY_FEES_ADJUSTMENTS as FEES,
  CARD_CATEGORY_FUEL as FUEL,
  CARD_CATEGORY_GROCERIES as GROCERIES,
  CARD_CATEGORY_HARDWARE_SUPPLIES as HARDWARE,
  CARD_CATEGORY_INTERNET_PURCHASE as INTERNET,
  CARD_CATEGORY_LODGING as LODGING,
  CARD_CATEGORY_PARKING_CHARGES as PARKING,
  CARD_CATEGORY_PHARMACIES as PHARMACIES,
  CARD_CATEGORY_RESTAURANT as RESTAURANT,
  CARD_CATEGORY_TAXIS_COACH as TAXIS,
  CARD_CATEGORY_TOLLS_FEES as TOLLS,
  CARD_CATEGORY_TRAVEL_AGENCIES as TRAVEL_AGENCIES,
  CARD_CATEGORY_VEHICLE_RENTAL as VEHICLE_RENTAL,
  CARD_CATEGORY_WHOLESALE_STORES as WHOLESALE,
  CARD_TAX_CATEGORY,
} from './cardCategoryNames.js';
import { CARD_FEE_OR_INTEREST_WORDING, cardGivenBackCharge } from './cardKinds.js';
import { cardSpendingRole } from './cardSpending.js';
import type { CardTransactionKind, CardTransactionStatus } from './types.js';

/** A merchant's history needs at least this many rows with an issuer category to lend one. */
export const CARD_CATEGORY_INFERENCE_MIN_OBSERVATIONS = 2;
/** ...and at least this share of them must agree (compared exactly, as four in five). */
export const CARD_CATEGORY_INFERENCE_MIN_AGREEMENT = 0.8;
const AGREEMENT_PARTS = 4;
const AGREEMENT_OF = 5;

/** Changes whenever a rule, its category or its order changes, or how a row goes through the rules. */
export const CARD_CATEGORY_RULES_VERSION = '2026.11.2';

/**
 * The rules the last retarget moved, with the category the version before it gave them, for the production check's
 * before-and-after (apps/api/src/cli/categoryInferenceCheck.ts). A retarget only splits a rule's pattern, in order,
 * and names a category: no pattern is reworded or reordered, so the table with these categories put back differs
 * from this one in those categories only. 2026.10.2 files coffee chains and café words under the issuer taxonomy's
 * café subcategory, which 2026.10.1 filed with restaurants. 2026.11.1 retargets nothing: it adds the tax-payment
 * rule, the first over the issuer's category. Nor does 2026.11.2: it changes no rule, and files a credit whose words
 * name a fee or interest as the charge it gives back.
 */
export const CARD_CATEGORY_RULES_RETARGETED: { version: string; categories: Readonly<Record<string, string>> } = {
  version: '2026.10.1',
  categories: { 'coffee-chain': RESTAURANT, 'cafe-word': RESTAURANT },
};

/** Where the category a Spending answer files a row under comes from. */
export type CardCategoryRowSource = 'user' | 'issuer' | 'amazon' | 'inferred' | 'uncategorized';
export const CARD_CATEGORY_ROW_SOURCES: readonly CardCategoryRowSource[] = ['user', 'issuer', 'amazon', 'inferred', 'uncategorized'];

/** Why a row was given an inferred category. */
export type CardCategoryInference =
  | {
    category: string;
    basis: 'merchant-history';
    /** The merchant's rows with an issuer category. */
    observations: number;
    /** How many of them have this category. */
    agreeing: number;
  }
  | {
    category: string;
    basis: 'rule';
    /** The rule's id in {@link CARD_CATEGORY_RULES}. */
    rule: string;
  };

/** One reviewed rule: a kind of charge, or a merchant pattern, and the category it files the row under. */
export interface CardCategoryRule {
  /** Stable, kebab-case: answers name the rule that applied. */
  id: string;
  /** What the rule recognizes, as people read it. */
  label: string;
  /** In the issuers' category names (the stored spelling wins where it differs only in form). */
  category: string;
  /** A kind rule applies to every row of these kinds, before merchant history; with a pattern, it narrows it. */
  kinds?: readonly CardTransactionKind[];
  /** Matched against the merchant name and the descriptor, upper case, accents, apostrophes and `*` removed. */
  pattern?: RegExp;
  /** A row whose merchant name or descriptor matches this is left to the next rule. */
  not?: RegExp;
  /**
   * Files a row over its issuer's category too, and before the kind rules and merchant history: for a kind of charge
   * no issuer's taxonomy names, which each issuer files under one of its own (a tax paid by card). Needs a pattern; the
   * owner's own category still wins. The rows it files over their issuer's category teach merchant history nothing.
   */
  overIssuer?: true;
}

/**
 * Holdr's own category for a tax paid by card: no issuer's taxonomy has one. Declared in cardCategoryNames.ts, the one
 * source of every category name the rules use, and exported here too: the same binding, not a copy.
 */
export { CARD_TAX_CATEGORY };

const AMAZON_PATTERN = /\b(?:AMAZON|AMZN)\b/;
const AMAZON_EXCLUSION = /\b(?:AWS|AMAZON WEB SERVICES)\b/;
/** Closed digital and subscription words, anywhere in an Amazon descriptor. */
const AMAZON_NOT_ITEMIZABLE_WORDS = /\b(?:PRIME[\s*.-]*(?:MEMBERSHIP|VIDEO)|KINDLE|DIGITAL|MUSIC)\b/;
/**
 * Leading forms no Amazon order can be behind, anchored at the descriptor's start and matched by whole tokens: a
 * delivery tip ("AMAZON TIPS*<ref>"), a Prime fee ("AMAZON PRIME*<ref>", the reference straight after PRIME: "AMAZON
 * PRIME <word>" stays itemizable), and Amazon Pay paying another merchant ("AMZ*<ref> <merchant>"; "AMZN*" is not it).
 */
const AMAZON_NOT_ITEMIZABLE_PREFIX = /^(?:(?:AMAZON|AMZN)\s+(?:TIPS\b|PRIME\s*\*)|AMZ\s*\*)/;

/**
 * Descriptor cohort only. Callers independently scope live posted rows, period, kind and currency. The cohort is
 * exactly what the shared `amazon` rule calls Amazon (AMAZON or AMZN as a word, never AWS); this only sorts those
 * rows and never adds one, so a bare "AMZ*" descriptor stays out. An Amazon Pay row the rule does call Amazon stays
 * in as not-itemizable, counted apart like Prime or Kindle, rather than dropped as non-Amazon: the `amazon` rule
 * still files it as Amazon, and every Amazon descriptor in the period is accounted for.
 */
export function amazonCardChargeKind(row: { description: string; merchant?: string | null }): 'itemizable' | 'not-itemizable' | null {
  const description = row.description.toUpperCase();
  if (!AMAZON_PATTERN.test(description) || AMAZON_EXCLUSION.test(description)) return null;
  return AMAZON_NOT_ITEMIZABLE_WORDS.test(description) || AMAZON_NOT_ITEMIZABLE_PREFIX.test(description.trimStart())
    ? 'not-itemizable' : 'itemizable';
}

/**
 * The reviewed rules, first match wins. Generic only: card fee kinds, widely known chains and plain words, never
 * a name drawn from the household's rows. Order matters where names overlap: fuel before warehouse clubs
 * ("COSTCO GAS"), groceries before Amazon ("WHOLE FOODS"), food delivery before rideshare ("UBER EATS"), travel
 * sites before hotels ("HOTELS.COM"), and plain restaurant words, then café words, last ("SUSHI CAFE" is a
 * restaurant). The rules over the issuer's category come first, then the kind rules, then merchant history, then the
 * other rules. Bump {@link CARD_CATEGORY_RULES_VERSION} with any change.
 */
export const CARD_CATEGORY_RULES: readonly CardCategoryRule[] = [
  {
    // A tax paid by card through the IRS's card processors: the payment shows as "United States Treasury Tax Payment"
    // and the processor's fee as "Tax Payment Convenience Fee" (irs.gov, "Pay taxes by card or digital wallet"). Any
    // spending row, whatever its kind: a charge and the credit giving it back have different kinds (the import
    // classifier, cardKinds.ts, makes the refund of a "... FEE" an adjustment, and a charge its issuer files under its
    // fees a fee), but share their words. A card's own fee or interest, and a credit giving one back, stay where they
    // are: the classifier's fee and interest wording.
    id: 'tax-payment', label: 'Tax payment', category: CARD_TAX_CATEGORY, overIssuer: true,
    pattern: /\b(?:(?:U\.? ?S\.?|UNITED STATES) ?TREASURY|TAX[ -](?:PAYMENT|PYMT|PMT)S?)\b/,
    not: CARD_FEE_OR_INTEREST_WORDING,
  },
  { id: 'card-fee', label: 'Card fee', category: FEES, kinds: ['fee'] },
  { id: 'interest-charge', label: 'Interest charge', category: FEES, kinds: ['interest'] },
  {
    id: 'fuel-brand', label: 'Fuel brand', category: FUEL,
    pattern: /\b(?:SHELL(?: OIL| SERVICE)?|CHEVRON|EXXON(?:MOBIL)?|MOBIL|BP|ARCO|TEXACO|SUNOCO|VALERO|CITGO|PHILLIPS 66|CONOCO|QUIKTRIP|RACETRAC|CIRCLE K|(?<!MOTOR )SPEEDWAY|MURPHY ?USA|MURPHY EXPRESS|COSTCO GAS|SAMS ?CLUB FUEL|SAMS FUEL|BJS GAS)\b/,
  },
  { id: 'warehouse-club', label: 'Warehouse club', category: WHOLESALE, pattern: /\b(?:COSTCO|SAMS ?CLUB|BJS WHOLESALE)\b/ },
  {
    id: 'grocery-store', label: 'Grocery store', category: GROCERIES,
    pattern: /\b(?:WHOLE ?FOODS|WHOLEFDS|TRADER JOE(?: ?S)?|SAFEWAY|KROGER|PUBLIX|ALDI|WEGMANS|SPROUTS|H-E-B|HARRIS TEETER|FOOD LION|GIANT EAGLE|STOP ?& ?SHOP|HY-?VEE|MEIJER|RALPHS|VONS|ALBERTSONS|FRED ?MEYER|WINCO|SHOPRITE|WINN-?DIXIE|INGLES|H ?MART|99 RANCH|LIDL|FOOD ?4 ?LESS|SMART ?& ?FINAL|STATER BROS|SUPERMARKET|SUPER MARKET|GROCERY|GROCERIES|FARMERS MARKET)\b/,
  },
  { id: 'amazon', label: 'Amazon', category: INTERNET, pattern: AMAZON_PATTERN, not: AMAZON_EXCLUSION },
  { id: 'pharmacy', label: 'Pharmacy', category: PHARMACIES, pattern: /\b(?:CVS|WALGREENS|RITE ?AID|DUANE READE)\b/ },
  {
    id: 'home-improvement', label: 'Home improvement store', category: HARDWARE,
    pattern: /\b(?:HOME ?DEPOT|LOWES|ACE HARDWARE|MENARDS|TRUE VALUE|HARBOR FREIGHT)\b/,
  },
  { id: 'electronics-store', label: 'Electronics store', category: ELECTRONICS, pattern: /\b(?:BEST ?BUY|MICRO ?CENTER|B ?& ?H PHOTO)\b/ },
  {
    id: 'food-delivery', label: 'Food delivery', category: RESTAURANT,
    pattern: /\b(?:DOOR ?DASH|GRUBHUB|UBER ?EATS|POSTMATES|CAVIAR|SEAMLESS)\b/,
  },
  { id: 'coffee-chain', label: 'Coffee chain', category: CAFE, pattern: /\b(?:STARBUCKS|DUNKIN|PEETS|TIM HORTONS|DUTCH BROS)\b/ },
  {
    id: 'restaurant-chain', label: 'Fast-food or restaurant chain', category: RESTAURANT,
    pattern: /\b(?:MCDONALDS|CHICK-?FIL-?A|CHIPOTLE|TACO BELL|WENDYS|BURGER KING|SUBWAY|PANERA|PANDA EXPRESS|FIVE GUYS|IN-?N-?OUT|SHAKE SHACK|DOMINOS|PIZZA HUT|PAPA JOHNS|POPEYES|KFC|ARBYS|JIMMY JOHNS|JERSEY MIKES|WINGSTOP|SWEETGREEN|QDOBA|DAIRY QUEEN|CULVERS|WHATABURGER|ZAXBYS|RAISING CANES|OLIVE GARDEN|APPLEBEES|IHOP|DENNYS|CRACKER BARREL|CHEESECAKE FACTORY|BUFFALO WILD WINGS|TEXAS ROADHOUSE)\b/,
  },
  {
    id: 'rideshare-or-taxi', label: 'Rideshare or taxi', category: TAXIS,
    pattern: /\b(?:UBER(?! ?(?:EATS|ONE)\b)(?!\.COM)|LYFT|TAXI|YELLOW CAB)\b/,
    not: /\bUBER ?ONE\b/,
  },
  { id: 'parking', label: 'Parking', category: PARKING, pattern: /\b(?:PARKING|PARKMOBILE|SPOTHERO|PARKWHIZ|PAYBYPHONE)\b/ },
  { id: 'toll', label: 'Toll', category: TOLLS, pattern: /\b(?:E-?Z ?PASS|FASTRAK|SUNPASS|PEACH ?PASS|TXTAG|TOLLWAY|TOLL ROAD|TOLLS?)\b/ },
  {
    id: 'airline', label: 'Airline', category: AIRLINE,
    pattern: /\b(?:DELTA AIR|DELTA\.COM|UNITED AIRLINES|UNITED\.COM|AMERICAN AIR|AA\.COM|SOUTHWEST AIR|SOUTHWES|JETBLUE|ALASKA AIR|SPIRIT AIRL|FRONTIER AIRL|HAWAIIAN AIR|SUN COUNTRY|ALLEGIANT|AIR CANADA|BRITISH AIRWAYS|LUFTHANSA|AIR FRANCE|KLM|EMIRATES|QATAR AIRWAYS|SINGAPORE AIR|CATHAY PACIFIC|EVA AIR|KOREAN AIR|JAPAN AIRLINES|ALL NIPPON|AIRLINES?|AIRWAYS)\b/,
  },
  {
    id: 'travel-site', label: 'Travel booking site', category: TRAVEL_AGENCIES,
    pattern: /\b(?:EXPEDIA|BOOKING\.COM|PRICELINE|HOTELS\.COM|ORBITZ|TRAVELOCITY|HOPPER|TRIP\.COM|CTRIP|AGODA|KAYAK)\b/,
  },
  {
    id: 'hotel', label: 'Hotel', category: LODGING,
    pattern: /\b(?:MARRIOTT|HILTON|HYATT|HOLIDAY INN|IHG|SHERATON|WESTIN|RITZ-?CARLTON|COURTYARD|HAMPTON INN|EMBASSY SUITES|DOUBLETREE|FAIRFIELD INN|RESIDENCE INN|SPRINGHILL SUITES|FOUR SEASONS|BEST WESTERN|LA QUINTA|WYNDHAM|RADISSON|OMNI HOTEL|KIMPTON|HOTELS?|MOTEL|RESORT|AIRBNB|VRBO)\b/,
  },
  {
    id: 'car-rental', label: 'Car rental', category: VEHICLE_RENTAL,
    pattern: /\b(?:HERTZ|AVIS|ENTERPRISE RENT|NATIONAL CAR|BUDGET RENT|ALAMO|SIXT|THRIFTY|DOLLAR RENT|TURO|ZIPCAR)\b/,
    not: /\bDRAFTHOUSE\b/,
  },
  {
    id: 'restaurant-word', label: 'Restaurant word', category: RESTAURANT,
    pattern: /\b(?:RESTAURANTS?|BAKERY|PIZZERIA|PIZZA|SUSHI|TAQUERIA|BISTRO|DINER|STEAKHOUSE|BBQ|BARBECUE|NOODLES?|RAMEN|PHO|DIM SUM|BRASSERIE|TRATTORIA|EATERY|GRILL)\b/,
  },
  { id: 'cafe-word', label: 'Café word', category: CAFE, pattern: /\b(?:CAFE|COFFEE|BOBA)\b/ },
];

/** The fields of a row inference reads. */
export interface CardCategoryInferenceRow {
  status: CardTransactionStatus;
  kind: CardTransactionKind;
  description: string;
  merchant?: string | null;
  issuerCategory?: string | null;
  userCategory?: string | null;
}

/** One request's inference: what it learned stays inside. */
export interface CardCategoryInferenceModel {
  /** {@link CARD_CATEGORY_RULES_VERSION} of the rules it applies. */
  readonly rules: string;
  /**
   * The inferred category of a spending row without the owner's own category: one with no issuer category, or one a
   * rule files over its issuer's category (a tax payment). Null for every other row.
   */
  infer(row: CardCategoryInferenceRow): CardCategoryInference | null;
}

/**
 * A spending row with neither the owner's own category nor an issuer's: the rows inference fills. A rule over the
 * issuer's category also files rows that have one ({@link cardCategoryInferable}).
 */
export function cardCategoryInferenceEligible(row: Pick<CardCategoryInferenceRow, 'kind' | 'userCategory' | 'issuerCategory'>): boolean {
  return cardSpendingRole(row.kind) === 'spending' && !row.userCategory && !row.issuerCategory;
}

/**
 * The reviewed rule that files this spending row over its issuer's category (a tax payment), or undefined. Its texts
 * decide, whatever its kind and categories: the owner's own category still wins over the rule.
 */
export function cardCategoryRuleOverIssuer(row: Pick<CardCategoryInferenceRow, 'kind' | 'description' | 'merchant'>): CardCategoryRule | undefined {
  return overIssuerRule(row, CARD_CATEGORY_RULES, textsOf(row, ruleText));
}

/**
 * A row an enriched answer may file under an inferred category: a spending row without the owner's own category, with
 * no issuer category, or with one a rule takes precedence over (a tax payment).
 */
export function cardCategoryInferable(
  row: Pick<CardCategoryInferenceRow, 'kind' | 'description' | 'merchant' | 'userCategory' | 'issuerCategory'>,
): boolean {
  return cardCategoryInferenceEligible(row) || (!row.userCategory && cardCategoryRuleOverIssuer(row) !== undefined);
}

/**
 * A posted spending row with an issuer category: what merchant history learns from (learn() leaves out the ones a rule
 * files over their issuer's category) and what the hold-out leaves out in turn.
 */
function learnable(row: CardCategoryInferenceRow): row is CardCategoryInferenceRow & { issuerCategory: string } {
  return row.status === 'posted' && cardSpendingRole(row.kind) === 'spending' && !!row.issuerCategory;
}

/** The merchant groups a row belongs to: of the issuer's merchant name, then of the descriptor. */
function merchantRoots(row: Pick<CardCategoryInferenceRow, 'merchant' | 'description'>): string[] {
  const roots: string[] = [];
  for (const text of [row.merchant, row.description]) {
    if (!text) continue;
    const key = cardMerchantKey(text);
    if (!isCardMerchantKey(key)) continue;
    const root = cardMerchantGroupRoot(key);
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/** Upper case, accents, apostrophes and `*` removed: the text rules match. */
function ruleText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/['’‘`]/g, '').replace(/[*_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** {@link ruleText}, keeping what it answered for one model: a household's rows repeat the same few thousand texts. */
function rememberedRuleText(): (text: string) => string {
  const known = new Map<string, string>();
  return (text) => {
    let found = known.get(text);
    if (found === undefined) {
      found = ruleText(text);
      known.set(text, found);
    }
    return found;
  };
}

/** What the rules match of a row: its merchant name and its descriptor, as {@link ruleText} gives them. */
function textsOf(row: Pick<CardCategoryInferenceRow, 'merchant' | 'description'>, text: (value: string) => string): string[] {
  return [row.merchant, row.description].filter((value): value is string => !!value).map(text);
}

/** The first rule over the issuer's category that files a spending row (a tax payment), whatever its categories. */
function overIssuerRule(
  row: Pick<CardCategoryInferenceRow, 'kind'>,
  rules: readonly CardCategoryRule[],
  texts: readonly string[],
): CardCategoryRule | undefined {
  if (cardSpendingRole(row.kind) !== 'spending') return undefined;
  return rules.find((rule) => rule.overIssuer === true && rule.pattern !== undefined && matches(rule, row.kind, texts));
}

/** A category name's form, so spellings that differ only in case, accents, punctuation or "&" meet. */
function spellingKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function topLevel(category: string): string {
  const dash = category.indexOf('-');
  return dash > 1 ? category.slice(0, dash).trim() : category;
}

type Tally = Map<string, number>;

interface HistoryAnswer {
  category: string;
  observations: number;
  agreeing: number;
}

/** A merchant's lent category, if its rows agree enough; `without` leaves one category's row out (hold-out). */
function decide(tally: Tally | undefined, without?: string): HistoryAnswer | null {
  if (!tally) return null;
  let observations = 0;
  let best: [string, number] | null = null;
  for (const [category, stored] of tally) {
    const count = category === without ? stored - 1 : stored;
    if (count <= 0) continue;
    observations += count;
    if (!best || count > best[1] || (count === best[1] && category < best[0])) best = [category, count];
  }
  if (!best || observations < CARD_CATEGORY_INFERENCE_MIN_OBSERVATIONS) return null;
  if (best[1] * AGREEMENT_OF < observations * AGREEMENT_PARTS) return null;
  return { category: best[0], observations, agreeing: best[1] };
}

interface Learned {
  tallies: Map<string, Tally>;
  /** Stored issuer category spellings by form; the most used spelling of each form. */
  spellings: Map<string, string>;
}

function learn(rows: readonly CardCategoryInferenceRow[], rules: readonly CardCategoryRule[], text: (value: string) => string): Learned {
  const tallies = new Map<string, Tally>();
  const forms = new Map<string, Map<string, number>>();
  const overIssuer = rules.some((rule) => rule.overIssuer === true);
  for (const row of rows) {
    if (row.issuerCategory) {
      const form = spellingKey(row.issuerCategory);
      const counts = forms.get(form) ?? new Map<string, number>();
      counts.set(row.issuerCategory, (counts.get(row.issuerCategory) ?? 0) + 1);
      forms.set(form, counts);
    }
    if (!learnable(row)) continue;
    // A row a rule files over its issuer's category (a tax payment): that category is not one Spending files it under.
    if (overIssuer && overIssuerRule(row, rules, textsOf(row, text))) continue;
    // Under the merchant it is decided by: a credit naming a fee or interest as the charge it gives back, so the hold-out
    // leaves each row out where it is looked up.
    for (const root of merchantRoots(asGivenBackCharge(row))) {
      const tally = tallies.get(root) ?? new Map<string, number>();
      tally.set(row.issuerCategory, (tally.get(row.issuerCategory) ?? 0) + 1);
      tallies.set(root, tally);
    }
  }
  const spellings = new Map<string, string>();
  for (const [form, counts] of forms) {
    const [spelling] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
    spellings.set(form, spelling);
  }
  return { tallies, spellings };
}

function matches(rule: CardCategoryRule, kind: CardTransactionKind, texts: readonly string[]): boolean {
  if (rule.kinds && !rule.kinds.includes(kind)) return false;
  if (!rule.pattern) return true;
  const pattern = rule.pattern;
  if (!texts.some((text) => pattern.test(text))) return false;
  const not = rule.not;
  return !not || !texts.some((text) => not.test(text));
}

type Decision =
  | { source: 'rule'; rule: CardCategoryRule }
  | { source: 'history'; answer: HistoryAnswer }
  | null;

/**
 * The procedure every row goes through: a rule over the issuer's category first (a tax payment, whatever kind it was
 * given), then a kind rule (a card fee is a fee wherever it was charged), then the merchant's history, then the
 * merchant rules. A credit whose words name a fee or interest goes through the kind rules, the history and the merchant
 * rules as the charge it gives back (cardKinds.ts, `cardGivenBackCharge`: its own words without the ones that give it
 * back, kinded as the import classifier kinds such a charge), so the two are filed together: a card's fee or interest
 * and its give-back under the card's fees, a merchant's fee and its refund where that merchant is.
 * `without` leaves the row's own category out of its merchants' history, for the hold-out evaluation.
 */
function decideRow(
  row: CardCategoryInferenceRow,
  learned: Learned,
  rules: readonly CardCategoryRule[],
  text: (value: string) => string,
  without?: string,
): Decision {
  const texts = textsOf(row, text);
  const overIssuer = overIssuerRule(row, rules, texts);
  if (overIssuer) return { source: 'rule', rule: overIssuer };
  const decided = asGivenBackCharge(row);
  const decidedTexts = decided === row ? texts : textsOf(decided, text);
  const kindRule = rules.find((rule) => !rule.pattern && matches(rule, decided.kind, decidedTexts));
  if (kindRule) return { source: 'rule', rule: kindRule };
  for (const root of merchantRoots(decided)) {
    const answer = decide(learned.tallies.get(root), without);
    if (answer) return { source: 'history', answer };
  }
  const rule = rules.find((candidate) => candidate.pattern && matches(candidate, decided.kind, decidedTexts));
  return rule ? { source: 'rule', rule } : null;
}

/**
 * A credit (a refund or an adjustment) whose words name a fee or interest, as the charge it gives back (cardKinds.ts,
 * `cardGivenBackCharge`); any other row as itself. The import classifier makes a fee's credit an adjustment when its
 * words give the fee back ("LATE FEE REVERSAL") and a refund when they repeat the fee's ("LATE PAYMENT FEE", negative):
 * either is filed with its fee.
 */
function asGivenBackCharge(row: CardCategoryInferenceRow): CardCategoryInferenceRow {
  if (row.kind !== 'adjustment' && row.kind !== 'refund') return row;
  const charge = cardGivenBackCharge(row);
  return charge ? { ...row, ...charge } : row;
}

/** A rule's category in the household's stored spelling, where one differs only in form. */
function ruleCategory(rule: CardCategoryRule, learned: Learned): string {
  return learned.spellings.get(spellingKey(rule.category)) ?? rule.category;
}

/**
 * The inference of one request, from the household's rows (every card and person, whatever the answer shows,
 * so a filter never changes what a merchant's history says). Rows that carry an issuer category teach it;
 * rows without one are what it fills, as is a row a rule files over its issuer's category (a tax payment).
 */
export function buildCardCategoryInference(
  rows: readonly CardCategoryInferenceRow[],
  options: { rules?: readonly CardCategoryRule[] } = {},
): CardCategoryInferenceModel {
  const rules = options.rules ?? CARD_CATEGORY_RULES;
  const text = rememberedRuleText();
  const learned = learn(rows, rules, text);
  return {
    rules: CARD_CATEGORY_RULES_VERSION,
    infer(row) {
      if (cardSpendingRole(row.kind) !== 'spending' || row.userCategory) return null;
      if (row.issuerCategory) {
        // The issuer's category stands, unless a rule files the row over it.
        const rule = overIssuerRule(row, rules, textsOf(row, text));
        return rule ? { category: ruleCategory(rule, learned), basis: 'rule', rule: rule.id } : null;
      }
      const decision = decideRow(row, learned, rules, text);
      if (!decision) return null;
      if (decision.source === 'history') {
        const { category, observations, agreeing } = decision.answer;
        return { category, basis: 'merchant-history', observations, agreeing };
      }
      return { category: ruleCategory(decision.rule, learned), basis: 'rule', rule: decision.rule.id };
    },
  };
}

/** The reviewed rule with this id, for its label. */
export function cardCategoryRule(id: string): CardCategoryRule | undefined {
  return CARD_CATEGORY_RULES.find((rule) => rule.id === id);
}

/** Rows by where their categories come from, each row once. */
export type CardCategoryRowSourceCounts = Record<CardCategoryRowSource, number>;

/** How a row's category was inferred. */
export type CardCategoryInferenceBasis = CardCategoryInference['basis'];
export const CARD_CATEGORY_INFERENCE_BASES: readonly CardCategoryInferenceBasis[] = ['merchant-history', 'rule'];

/**
 * What an enriched answer's marker says of inference: the rules' version, and the rows it counts as inferred by
 * basis, both always listed (a count of 0 included), so the share that rests on a rule is never left implicit.
 */
export interface CardCategoryInferenceMarker {
  rules: string;
  rowsByBasis: Array<{ basis: CardCategoryInferenceBasis; count: number }>;
}

export function cardCategoryInferenceMarker(inferences: Iterable<Pick<CardCategoryInference, 'basis'>>): CardCategoryInferenceMarker {
  const counts = new Map<CardCategoryInferenceBasis, number>();
  for (const inference of inferences) counts.set(inference.basis, (counts.get(inference.basis) ?? 0) + 1);
  return {
    rules: CARD_CATEGORY_RULES_VERSION,
    rowsByBasis: CARD_CATEGORY_INFERENCE_BASES.map((basis) => ({ basis, count: counts.get(basis) ?? 0 })),
  };
}

/**
 * Where a row's category comes from in an enriched answer: the owner's own category (whole row), Amazon item
 * parts, an inferred one (a rule's over the issuer's category included), the issuer's category, or none.
 */
export function cardCategoryRowSource(
  row: { userCategory?: string | null; issuerCategory?: string | null },
  how: { split: boolean; inferred: boolean },
): CardCategoryRowSource {
  if (row.userCategory) return 'user';
  if (how.split) return 'amazon';
  if (how.inferred) return 'inferred';
  return row.issuerCategory ? 'issuer' : 'uncategorized';
}

export function countCardCategoryRowSources(sources: Iterable<CardCategoryRowSource>): CardCategoryRowSourceCounts {
  const counts: CardCategoryRowSourceCounts = { user: 0, issuer: 0, amazon: 0, inferred: 0, uncategorized: 0 };
  for (const source of sources) counts[source] += 1;
  return counts;
}

/** One rule's counts, named by its generic id only. */
export interface CardCategoryRuleEvaluation {
  rule: string;
  /** Posted spending rows with neither category that it fills. */
  filled: number;
  /** A rule over the issuer's category: the posted spending rows with an issuer category it files over it (else 0). */
  refiled: number;
  /** Left-out rows it answered, and how many of them it gave their own category, exactly and by top level. */
  holdOut: { rows: number; correct: number; topLevelCorrect: number };
  /** Whether its category is a stored issuer category (in its stored spelling). */
  categoryStored: boolean;
}

/** Counts only: what inference would do for a household's rows, and how often it agrees with the issuers. */
export interface CardCategoryInferenceEvaluation {
  /** Posted spending rows with neither category, and how inference fills them. */
  uncategorized: { rows: number; byHistory: number; byRule: number; remaining: number };
  /**
   * Posted spending rows with an issuer category that a rule files over it (a tax payment): left out of merchant
   * history and of the hold-out, which measures agreement with the issuers' categories.
   */
  refiled: number;
  /**
   * Leave-one-out over the other posted spending rows with an issuer category: each in turn loses its category and its
   * own place in its merchants' history, goes through the same procedure, and is compared with the category it had,
   * exactly and by top level (the part before the first "-").
   */
  holdOut: {
    rows: number;
    byHistory: { rows: number; correct: number; topLevelCorrect: number };
    byRule: { rows: number; correct: number; topLevelCorrect: number };
    remaining: number;
  };
  /** Distinct rule categories, and how many of them are stored issuer categories (in their stored spelling). */
  ruleCategories: { total: number; inUse: number };
  /** Every rule, in the table's order, with the rows it fills or files over the issuer's, and its share of the hold-out. */
  rules: CardCategoryRuleEvaluation[];
}

/** {@link CardCategoryInferenceEvaluation} of `rows`. Counts only: no row, merchant or category is named. */
export function evaluateCardCategoryInference(
  rows: readonly CardCategoryInferenceRow[],
  options: { rules?: readonly CardCategoryRule[] } = {},
): CardCategoryInferenceEvaluation {
  const rules = options.rules ?? CARD_CATEGORY_RULES;
  const text = rememberedRuleText();
  const learned = learn(rows, rules, text);
  const model = buildCardCategoryInference(rows, { rules });
  const perRule = new Map(rules.map((rule) => [rule.id, {
    rule: rule.id,
    filled: 0,
    refiled: 0,
    holdOut: { rows: 0, correct: 0, topLevelCorrect: 0 },
    categoryStored: learned.spellings.has(spellingKey(rule.category)),
  }]));
  const uncategorized = { rows: 0, byHistory: 0, byRule: 0, remaining: 0 };
  for (const row of rows) {
    if (row.status !== 'posted' || !cardCategoryInferenceEligible(row)) continue;
    uncategorized.rows += 1;
    const inference = model.infer(row);
    if (!inference) uncategorized.remaining += 1;
    else if (inference.basis === 'merchant-history') uncategorized.byHistory += 1;
    else {
      uncategorized.byRule += 1;
      const entry = perRule.get(inference.rule);
      if (entry) entry.filled += 1;
    }
  }
  let refiled = 0;
  const holdOut = {
    rows: 0,
    byHistory: { rows: 0, correct: 0, topLevelCorrect: 0 },
    byRule: { rows: 0, correct: 0, topLevelCorrect: 0 },
    remaining: 0,
  };
  for (const row of rows) {
    if (!learnable(row)) continue;
    const overIssuer = overIssuerRule(row, rules, textsOf(row, text));
    if (overIssuer) {
      refiled += 1;
      const entry = perRule.get(overIssuer.id);
      if (entry) entry.refiled += 1;
      continue;
    }
    holdOut.rows += 1;
    const actual = row.issuerCategory;
    const decision = decideRow({ ...row, issuerCategory: null, userCategory: null }, learned, rules, text, actual);
    if (!decision) {
      holdOut.remaining += 1;
      continue;
    }
    const category = decision.source === 'history' ? decision.answer.category : ruleCategory(decision.rule, learned);
    const buckets = [decision.source === 'history' ? holdOut.byHistory : holdOut.byRule];
    const ruleEntry = decision.source === 'rule' ? perRule.get(decision.rule.id) : undefined;
    if (ruleEntry) buckets.push(ruleEntry.holdOut);
    for (const bucket of buckets) {
      bucket.rows += 1;
      if (category === actual) bucket.correct += 1;
      if (topLevel(category) === topLevel(actual)) bucket.topLevelCorrect += 1;
    }
  }
  const targets = [...new Set(rules.map((rule) => rule.category))];
  return {
    uncategorized,
    refiled,
    holdOut,
    ruleCategories: { total: targets.length, inUse: targets.filter((target) => learned.spellings.has(spellingKey(target))).length },
    rules: [...perRule.values()],
  };
}

/**
 * The rule table with {@link CARD_CATEGORY_RULES_RETARGETED}'s categories put back: the same patterns in the same
 * order, so it decides every row as this table would without that retarget.
 */
export function cardCategoryRulesBeforeRetarget(): CardCategoryRule[] {
  return CARD_CATEGORY_RULES.map((rule) => {
    const category = CARD_CATEGORY_RULES_RETARGETED.categories[rule.id];
    return category === undefined ? rule : { ...rule, category };
  });
}
