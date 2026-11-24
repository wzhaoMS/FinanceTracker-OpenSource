import {
  CARD_PAYMENT_SOURCE_RULES,
  CARD_TAX_CATEGORY,
  CARD_UNCATEGORIZED,
  cardCategoryRule,
  cardCategoryRuleOverIssuer,
  cardMinorToMajor,
  formatCurrency,
  type CardAccount,
  type CardCategoryBasis,
  type CardCategoryBasisMarker,
  type CardCategoryEvidenceClass,
  type CardCategoryHoldReason,
  type CardCategoryInference,
  type CardCategoryInferenceBasis,
  type CardCategoryInvalidReason,
  type CardCategoryPart,
  type CardCategoryRowSource,
  type CardOwner,
  type CardTransactionKind,
  type CardTransactionView,
  type CashEventType,
} from '@finance-tracker/shared';

import { categoryShortLabel } from '../../modes/category';
import type { AmazonCardDetail, AmazonCoverage, AmazonOrderItem } from './spendingApi';

/**
 * What a panel says its categories are based on, and its one-click switch. Enriched categories file a card charge
 * matched to Amazon orders under its items' categories, give a charge with no category of its own one inferred
 * from its merchant's other charges or a reviewed rule, and file a tax paid by card under Taxes over its issuer's
 * category; original categories are the owner's own and the issuers' only. Only categories differ: totals, months,
 * merchants, cards and people are the same either way.
 *
 * The words describe the answer shown (its own `marker`): how many of its charges are split (by evidence class) or
 * inferred (by merchant history or by rule, both always said), and in the title where each one's category comes
 * from, never `effective` alone, so figures are never labelled with a basis they do not use. The switch follows the
 * basis chosen (`preference`), and while the answer shown is for the other basis, `pending` says so.
 */
export function categoryBasisText(
  marker: CardCategoryBasisMarker | undefined,
  preference: CardCategoryBasis,
): { text: string; title: string; toggle: string; next: CardCategoryBasis; pending: string | null; revision: string | null } {
  const same = 'Totals, months, merchants, cards and people are the same either way.';
  const own = `every card charge counts under your own category or its issuer's. ${same}`;
  const toggle = preference === 'original'
    ? { toggle: 'Enriched categories', next: 'enriched' as const }
    : { toggle: 'Original categories', next: 'original' as const };
  const pending = marker && marker.requested !== preference
    ? (preference === 'original' ? 'Switching to original categories…' : 'Switching to enriched categories…')
    : null;
  const words = (text: string, title: string, revision: string | null = null) => ({ text, title, ...toggle, pending, revision });
  if (!marker) return words('Categories: card categories', `Here ${own}`);
  if (marker.requested === 'original') return words('Categories: original card categories', `Here ${own}`);
  const charges = (count: number) => `${count} ${count === 1 ? 'charge' : 'charges'}`;
  const sources = marker.rowsBySource;
  const inferred = sources?.inferred ?? 0;
  const byBasis = (basis: CardCategoryInferenceBasis) => marker.inference?.rowsByBasis.find((item) => item.basis === basis)?.count ?? 0;
  const how = `(${byBasis('merchant-history')} from merchant history, ${byBasis('rule')} by rule)`;
  const split = marker.splitRowsByEvidence?.reduce((sum, item) => sum + item.count, 0) ?? marker.splitRows;
  const available = marker.availability === 'available';
  // The answer's revision: kept for whoever needs it (a data attribute), never said.
  const revision = available ? marker.version.slice(0, 12) : null;
  const shown = [
    split > 0 ? `${charges(split)} split by Amazon items` : null,
    inferred > 0 ? `${charges(inferred)} inferred ${how}` : null,
  ].filter((part): part is string => part !== null);
  const kept = marker.heldOrDeclined.reduce((sum, item) => sum + item.count, 0)
    + marker.invalid.reduce((sum, item) => sum + item.count, 0);
  const amazonCounts = [
    marker.keptWholeByUserCategory > 0 ? `${marker.keptWholeByUserCategory} kept whole by your own category` : null,
    kept > 0 ? `${kept} kept whole for now` : null,
  ].filter((part): part is string => part !== null).join(', ');
  const amazon = !available
    ? 'No Amazon item categories are available.'
    : `${split > 0 ? 'Charges matched to Amazon orders count under their items\' categories' : 'No charge here is split by Amazon items'}`
      + `${amazonCounts ? ` (${amazonCounts})` : ''}.`;
  const bySource = sources
    ? `Where these charges' categories come from: your own ${sources.user}, the issuer's ${sources.issuer}, Amazon items `
      + `${sources.amazon}, inferred ${sources.inferred}${sources.inferred > 0 ? ` ${how}` : ''}, none ${sources.uncategorized}. `
      + 'A charge with no category of its own takes the one its merchant\'s other charges agree on, or a reviewed rule\'s'
      + `${marker.inference ? ` (rules ${marker.inference.rules})` : ''}. `
      + `A tax paid by card counts under ${CARD_TAX_CATEGORY} by rule, whatever its issuer's category.`
    : null;
  return words(
    `Categories: ${shown.length > 0 ? shown.join(' · ') : 'card categories'}`,
    [bySource, amazon, same].filter((part): part is string => part !== null).join(' '),
    revision,
  );
}

/** Why an inferred category: "Inferred from merchant history (3)", or the rule's name. */
export function categoryInferenceText(inference: CardCategoryInference): string {
  return inference.basis === 'merchant-history'
    ? `Inferred from merchant history (${inference.observations})`
    : `Inferred by rule: ${cardCategoryRule(inference.rule)?.label ?? inference.rule}`;
}

/**
 * The owner's own category from what they typed, or none (null) for empty or for what the row counts under
 * anyway: its issuer's category, Uncategorized, or, for a row without one of the owner's, the category it is shown
 * under (an inferred one included). Saving an inferred category unchanged never makes it the owner's, and the owner's
 * own, left as it is, stays theirs. In an enriched answer (its rows say where their categories come from), a charge a
 * reviewed rule files over its issuer's category (a tax payment) does not count under the issuer's anyway: typed
 * there, the issuer's category becomes the owner's. On the original basis it does count under it, so there it clears
 * the owner's own, as for any charge.
 */
export function ownCategoryFromInput(
  row: Pick<CardTransactionView, 'userCategory' | 'issuerCategory' | 'category'>
    & Partial<Pick<CardTransactionView, 'kind' | 'description' | 'merchant'>> & { categorySource?: CardCategoryRowSource },
  input: string,
): string | null {
  const next = input.trim();
  // Opening an editor and leaving it never clears the owner's choice (the issuer's category, picked for a tax payment).
  if (row.userCategory && next === row.userCategory) return next;
  const overIssuer = row.categorySource !== undefined && Boolean(row.issuerCategory) && row.kind !== undefined
    && row.description !== undefined
    && cardCategoryRuleOverIssuer({ kind: row.kind, description: row.description, merchant: row.merchant }) !== undefined;
  if (next === '' || (next === (row.issuerCategory ?? CARD_UNCATEGORIZED) && !overIssuer)) return null;
  return !row.userCategory && next === row.category ? null : next;
}

/**
 * How a card charge was tied to its Amazon order, strongest evidence first: a payment event the order lists;
 * Amazon's payment ledger, whose charge is shared among the order's items by price (no amount of an item's own); or,
 * lower evidence, the order's total matching exactly one charge. Every class the shared enum has needs its words
 * here (typecheck fails without them); a class here the enum does not have yet is never sent.
 */
const EVIDENCE_WORDS = {
  'payment-event': { tied: 'tied by its Amazon payment', counted: 'by payment' },
  'payment-ledger-complete': {
    tied: 'tied by Amazon’s payment ledger (allocated by price share)',
    counted: 'by payment ledger (allocated by price share)',
  },
  'unique-total-match': { tied: 'tied by its order total only (lower evidence)', counted: 'by order total (lower evidence)' },
} as const;
const EVIDENCE: Readonly<Record<CardCategoryEvidenceClass, { tied: string; counted: string }>> = EVIDENCE_WORDS;

/**
 * How many charges in the answer shown are split by Amazon items, by how each was tied to its order, whenever the
 * split basis was asked of an available source: every class is said, even at 0, the lower-evidence one included.
 */
export function categoryEvidenceText(marker: CardCategoryBasisMarker | undefined): string | null {
  if (!marker || marker.requested !== 'enriched' || marker.availability !== 'available') return null;
  const count = (evidenceClass: string) =>
    marker.splitRowsByEvidence?.find((item) => item.evidenceClass === evidenceClass)?.count ?? 0;
  // Only the kinds of evidence that split a charge: nothing split is said in the note's own words.
  const counted = Object.entries(EVIDENCE_WORDS).filter(([evidenceClass]) => count(evidenceClass) > 0)
    .map(([evidenceClass, words]) => `${count(evidenceClass)} ${words.counted}`);
  return counted.length > 0 ? `Amazon splits: ${counted.join(' · ')}` : null;
}

/** How a card charge was tied to its Amazon order. */
export function amazonEvidenceText(evidenceClass: CardCategoryEvidenceClass): string {
  return EVIDENCE[evidenceClass].tied;
}

/**
 * Why a charge with an Amazon order counts whole, in a sentence's words: every reason a source may give (typecheck
 * fails without one's words; one here the enum does not have yet is never sent), and those of Spending's own
 * refusals that say more than that its items could not be checked.
 */
const WHOLE_ROW_WORDS = {
  'match-held': 'more than one order or charge could match, so none is linked yet',
  'mixed-tender-unproven': 'the order was paid partly another way, and what this card paid for each item is not proven',
  'item-identity-unproven': 'which items this charge paid for is not proven yet',
  'negative-component': 'a discount or return would make an item’s share negative',
  'currency-mismatch': 'the order is in another currency',
  'inconsistent-evidence': 'the order’s details disagree with each other',
  'refund-unattributed': 'a refund on the order is not attributed to its items yet',
  'asset-purchase': 'its receipt shows precious metals; review it in What counts',
  'asset-uncertain': 'an item on its receipt may be precious metal, which is not confirmed yet',
  'not-linked': 'the order is not linked to this charge',
  'sum-mismatch': 'the item amounts do not add up to the charge',
  'unknown-mapped-category': 'an item category is not one of your categories',
  'bad-category': 'an item category cannot be used',
} as const;
const WHOLE_ROW_REASONS: Readonly<Record<CardCategoryHoldReason, string> & Partial<Record<CardCategoryInvalidReason, string>>> = WHOLE_ROW_WORDS;

/** Why a charge with an Amazon order is still counted whole, in a sentence's words. */
export function amazonWholeRowReasonText(reason: CardCategoryHoldReason | CardCategoryInvalidReason | undefined): string {
  return (reason && WHOLE_ROW_REASONS[reason]) ?? 'its items could not be checked';
}

/** What an accepted part is: an item's price, its share of tax, shipping and discounts, or the rest of the charge. */
export function amazonPartLabel(part: Pick<CardCategoryPart, 'classification' | 'categorySource'>): string {
  if (part.classification === 'residual') return 'Rest of the charge, under the card’s own category';
  const source = part.categorySource === 'item-override' ? 'your category'
    : part.categorySource === 'agent-classification' ? 'classified from its title'
      : part.categorySource === 'item-taxonomy' ? 'from its item category'
        : part.categorySource === 'fresh-default' ? 'Amazon Fresh default until it is classified' : 'reviewed category';
  return part.classification === 'policy-allocated' ? `tax, shipping and discounts, shared by price · ${source}` : source;
}

/**
 * One line of a charge's Amazon order as Spending lists it: an item of the order (each one, whether or not it has a
 * part in this charge), or the rest of the charge, which counts under the card's own category.
 */
export interface AmazonOrderLine {
  key: string;
  kind: 'item' | 'rest';
  /** An item's opaque ref (its thumbnail's address); null for the rest of the charge. */
  itemRef: string | null;
  /** An item's full title; null when the API does not show it, and for the rest of the charge. */
  title: string | null;
  quantity: number | null;
  asin: string | null;
  /** Whether the item's product thumbnail is cached: only then is it requested. */
  image: boolean;
  /** What the line puts in the charge's categories, its parts added up; null for an item with no part in them. */
  amountMinor: number | null;
  /** The category the line counts under: its price's (else its first part's); null without parts. */
  category: string | null;
  /** The part that names that category, which says who chose it. */
  categoryPart: CardCategoryPart | null;
  /** Of the amount, what a policy allocated: the item's share of tax, shipping and discounts. */
  allocatedMinor: number;
  /** Every part allocated by price share and none the item's own amount (an order tied by Amazon's payment ledger). */
  allocatedOnly: boolean;
}

const partsTotal = (parts: readonly CardCategoryPart[]) => parts.reduce((total, part) => total + part.amountMinor, 0);

/** A linked order's lines: each item once, in the order's own order (items only its parts name last), then the rest. */
export function amazonOrderLines(amazon: Pick<AmazonCardDetail, 'parts' | 'items'>): AmazonOrderLine[] {
  const parts = amazon.parts ?? [];
  const items = new Map<string, AmazonOrderItem>();
  for (const item of amazon.items ?? []) if (!items.has(item.itemRef)) items.set(item.itemRef, item);
  const refs = [...items.keys()];
  for (const part of parts) if (part.itemRef && !refs.includes(part.itemRef)) refs.push(part.itemRef);
  const lines = refs.map((itemRef): AmazonOrderLine => {
    const item = items.get(itemRef);
    const own = parts.filter((part) => part.itemRef === itemRef && part.classification !== 'residual');
    const category = own.find((part) => part.classification === 'source')?.category ?? own[0]?.category ?? null;
    const allocated = own.filter((part) => part.classification === 'policy-allocated');
    return {
      key: `item-${itemRef}`, kind: 'item', itemRef, title: item?.title ?? null, quantity: item?.quantity ?? null,
      asin: item?.asin ?? null, image: item?.image === true,
      amountMinor: own.length > 0 ? partsTotal(own) : null,
      category,
      categoryPart: own.find((part) => part.category === category) ?? null,
      allocatedMinor: partsTotal(allocated),
      allocatedOnly: own.length > 0 && allocated.length === own.length,
    };
  });
  parts.forEach((part, index) => {
    if (part.classification !== 'residual') return;
    lines.push({
      key: `rest-${index}`, kind: 'rest', itemRef: null, title: null, quantity: null, asin: null, image: false,
      amountMinor: part.amountMinor, category: part.category, categoryPart: part, allocatedMinor: 0, allocatedOnly: false,
    });
  });
  return lines;
}

/** Who chose an item line's category, in a part's words: yours, classified from its title, or reviewed. */
export function amazonLineCategorySource(part: Pick<CardCategoryPart, 'categorySource'>): string {
  return amazonPartLabel({ classification: 'source', categorySource: part.categorySource });
}

/** How Spending files a charge with a linked Amazon order: under its items' categories, or whole, and why. */
export function amazonOrderStatusText(
  amazon: Pick<AmazonCardDetail, 'aggregate' | 'wholeRowReason'>,
  userCategory: string | null | undefined,
): string {
  if (amazon.aggregate === 'split') return 'Counted under its items’ categories.';
  if (amazon.aggregate === 'whole-row-user-category') return `Counted whole under your category${userCategory ? `, ${userCategory}` : ''}.`;
  return `Counted whole, under its own category: ${amazonWholeRowReasonText(amazon.wholeRowReason)}.`;
}

/** A listed charge's Amazon marker: "Amazon · 3 items", or "Amazon order" when the order lists none. */
export function amazonMarkerText(lines: readonly AmazonOrderLine[]): string {
  const items = lines.filter((line) => line.kind === 'item').length;
  return items === 0 ? 'Amazon order' : `Amazon · ${items} ${items === 1 ? 'item' : 'items'}`;
}

/** A split charge's categories in one list cell: the largest, and how many more ("Electronics +2"). */
export function splitCategoryLabel(split: ReadonlyArray<{ category: string }>): string {
  const [largest] = split;
  return largest ? `${categoryShortLabel(largest.category)}${split.length > 1 ? ` +${split.length - 1}` : ''}` : '';
}

/**
 * The overview's Amazon coverage in the currency shown: how many Amazon card charges (the domain's rule) are
 * itemized, and every other Amazon row in view counted apart, so the count never shrinks quietly: purchases no order
 * is behind (digital or subscription, a delivery tip, Amazon Pay paying another merchant), pending ones, refunds, any
 * other, and those in other currencies. The share is rounded down, so it says 100% only when every charge is
 * itemized. Null without an answer, or with no Amazon row in view.
 */
export function amazonCoverageText(coverage: readonly AmazonCoverage[] | undefined, currency: string):
  { headline: string; notCounted: string; unitemized: number } | null {
  if (!coverage) return null;
  const rest = (entry: AmazonCoverage) => entry.notItemizable + entry.pending + entry.refunds + entry.other;
  const shown = coverage.find((entry) => entry.currency === currency)
    ?? { currency, charges: 0, itemized: 0, notItemizable: 0, pending: 0, refunds: 0, other: 0 };
  const elsewhere = coverage.filter((entry) => entry.currency !== currency).reduce((sum, entry) => sum + entry.charges + rest(entry), 0);
  if (shown.charges + rest(shown) + elsewhere === 0) return null;
  const share = shown.charges > 0 ? ` (${Math.floor((shown.itemized / shown.charges) * 100)}%)` : '';
  const notCounted = [
    `${shown.notItemizable} digital, subscription, tip or Amazon Pay`,
    `${shown.pending} pending`,
    `${shown.refunds} ${shown.refunds === 1 ? 'refund' : 'refunds'}`,
    shown.other > 0 ? `${shown.other} other` : null,
    elsewhere > 0 ? `${elsewhere} in other currencies` : null,
  ].filter((part): part is string => part !== null).join(' · ');
  return {
    headline: `Amazon charges itemized: ${shown.itemized} of ${shown.charges}${share}`,
    notCounted: `Not counted: ${notCounted}`,
    unitemized: shown.charges - shown.itemized,
  };
}

/** Display helpers for the Spending tab. Dates are calendar dates (YYYY-MM-DD), never instants. */

export function formatMinor(amountMinor: number, currency: string): string {
  return formatCurrency(cardMinorToMajor(amountMinor, currency), currency);
}

/** A chart scale's amount, short: "$0", "$600", "$1.25K", "$12K". */
export function formatMinorCompact(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(cardMinorToMajor(amountMinor, currency));
}

const SCALE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * The top of a chart's dollar scale, in minor units: the smallest round
 * amount (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten) that
 * `maxMinor` reaches, and at least one whole unit; 0 when there is nothing
 * to show. Its half is the scale's middle line.
 */
export function chartScaleTop(maxMinor: number, currency: string): number {
  if (!(maxMinor > 0)) return 0;
  const minorPerUnit = Math.round(1 / cardMinorToMajor(1, currency));
  const units = maxMinor / minorPerUnit;
  const power = 10 ** Math.floor(Math.log10(units));
  const step = SCALE_STEPS.find((candidate) => candidate * power >= units * (1 - 1e-12)) ?? 10;
  return Math.max(minorPerUnit, Math.round(step * power * minorPerUnit));
}

/** Words kept in lower case inside a merchant's name ("Bank of the West"). */
const NAME_SMALL_WORDS = new Set(['A', 'AN', 'AND', 'AT', 'BY', 'DE', 'DEL', 'DES', 'DI', 'DU', 'FOR', 'IN', 'LA', 'LE', 'OF', 'ON', 'OR', 'THE', 'TO']);
/** Three-letter words that are words, not abbreviations; other three-letter names (AMC, IBM) keep their capitals. */
const NAME_SHORT_WORDS = new Set([
  'AIR', 'ART', 'BAR', 'BAY', 'BIG', 'BOX', 'BUS', 'BUY', 'CAB', 'CAR', 'DAY', 'DOG', 'DUE', 'EAT', 'FEE', 'FIT', 'FOX',
  'FUN', 'GAS', 'GYM', 'HOT', 'HUB', 'ICE', 'INN', 'KEY', 'LAB', 'NEW', 'OIL', 'OLD', 'ONE', 'OUT', 'PAY', 'PET', 'PIE',
  'POT', 'PUB', 'RED', 'SEA', 'SPA', 'SUB', 'SUN', 'TAP', 'TAX', 'TEA', 'TEN', 'TOP', 'TOY', 'TWO', 'VET', 'WAY', 'WOK',
  'ZOO',
]);
/** Descriptor abbreviations that have a vowel but are not words. */
const NAME_ABBREVIATIONS = new Set(['AMEX', 'AMZN', 'CNTR', 'INTL', 'MKTP', 'MKTPL', 'MKTPLACE', 'PMTS', 'SVCS', 'USPS', 'WHSE', 'WRLS']);
const NAME_WEB_SUFFIX = /^(\p{Lu}+)\.(COM|NET|ORG|IO|CO|APP|TV)$/u;
/** A company-form word after the name, where a descriptor goes on to the city ("DELL INC ROUND ROCK" → "Dell"). */
const NAME_COMPANY_FORMS = new Set(['INC', 'INCORPORATED', 'LLC', 'LLP', 'LTD', 'CORP', 'CORPORATION', 'PLC', 'GMBH']);

/** The name part of a grouping key: up to a company-form word that is not its first word. */
function nameKey(key: string): string {
  const words = key.split(' ');
  const form = words.findIndex((word, index) => index > 0 && NAME_COMPANY_FORMS.has(word.replace(/[.,]/g, '')));
  return form > 0 ? words.slice(0, form).join(' ') : key;
}

/** A web address an issuer spelled out in words: "WWW SAMPLESTORE COM SEATTLE" → "SAMPLESTORE.COM SEATTLE". */
function webAddressKey(key: string): string {
  const words = key.split(' ');
  const domain = words.findIndex((word, index) => index >= 2 && /^(?:COM|NET|ORG)$/.test(word));
  if (words[0] !== 'WWW' || domain < 2) return key;
  return [`${words.slice(1, domain).join('')}.${words[domain]}`, ...words.slice(domain + 1)].join(' ');
}

/** A billing address glued to the end of a subscription's name: "SAMPLE TUBE MEMBG.CO/HELPPAY#" → "SAMPLE TUBE MEMB". */
function billingAddressKey(key: string): string {
  return key.replace(/\s*G\.CO\/HELPPAY#?$/, '').trim() || key;
}

const capitalized = (word: string) => word.charAt(0) + word.slice(1).toLocaleLowerCase('en-US');

function friendlyNameWord(word: string, first: boolean): string {
  if (NAME_SMALL_WORDS.has(word)) return first ? capitalized(word) : word.toLocaleLowerCase('en-US');
  const web = NAME_WEB_SUFFIX.exec(word);
  if (web) return `${friendlyNameWord(web[1], first)}.${web[2].toLocaleLowerCase('en-US')}`;
  // Letters only (one apostrophe allowed, "JOE'S"), with a vowel: a word, not a code or an abbreviation.
  if (!/^\p{Lu}+(?:['’]\p{Lu}+)?$/u.test(word)) return word;
  const letters = word.replace(/['’]/g, '');
  const plain = letters.normalize('NFD').replace(/\p{M}/gu, '');
  if (NAME_SHORT_WORDS.has(plain)) return capitalized(word);
  const vowel = /[AEIOU]/.test(plain) || (plain.length >= 4 && plain.includes('Y'));
  if (!vowel || letters.length <= 3 || NAME_ABBREVIATIONS.has(plain)) return word;
  return capitalized(word);
}

/**
 * A merchant's name as people read it, for ranked lists and filter chips.
 * A name the issuer wrote in mixed case keeps its own letters, up to where
 * the merchant ends ("AMZN Mktp US*2K3L45" → "AMZN Mktp", "Blue Bottle
 * Coffee" as it is). Otherwise (an all-capitals descriptor, or one with a
 * processor prefix: "SQ *BLUE BOTTLE #12 SEATTLE WA") it is the grouping
 * key, cleaned of processor prefixes, store numbers and state codes, in
 * title case ("Blue Bottle Seattle"); codes and abbreviations keep their
 * capitals ("AMZN MKTP", "CVS/Pharmacy", "7-Eleven"). Either way it ends
 * before a company form such as INC or LLC ("DELL INC ROUND ROCK TX" →
 * "Dell"), and a web address spelled out in words reads as one ("WWW
 * SAMPLE COM" → "Sample.com"). Show the original in a title: the rules are a
 * reading aid, not a merchant database, and filters keep the full grouping key.
 */
export function merchantDisplayName(name: string, key: string): string {
  const clean = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const groupKey = webAddressKey(nameKey(billingAddressKey(key.normalize('NFKC').toLocaleUpperCase('en-US').replace(/\s+/g, ' ').trim())));
  if (!groupKey) return clean;
  if (/\p{Ll}/u.test(clean)) {
    const upper = clean.toLocaleUpperCase('en-US');
    if (upper.length === clean.length && upper.startsWith(groupKey) && !/^[\p{L}\p{N}]/u.test(upper.slice(groupKey.length))) {
      return clean.slice(0, groupKey.length).trim();
    }
  }
  return groupKey
    .split(' ')
    .map((word, index) => word
      .split(/([/-])/)
      .map((part, at) => (part === '/' || part === '-' || part === '' ? part : friendlyNameWord(part, index === 0 && at === 0)))
      .join(''))
    .join(' ');
}

/**
 * Short, distinct names for a ranked list of categories: each one's top
 * level, as its chips in the list show it ("Merchandise & Supplies-Groceries"
 * → "Merchandise"); where two categories share a top level, the part after
 * it ("Groceries", "Clothing"); where that still repeats, or is missing, the
 * full name. Case-insensitive.
 */
export function rankedCategoryLabels(names: readonly string[]): Map<string, string> {
  const repeats = (labels: Map<string, string>) => {
    const counts = new Map<string, number>();
    for (const label of labels.values()) counts.set(label.toLocaleLowerCase('en-US'), (counts.get(label.toLocaleLowerCase('en-US')) ?? 0) + 1);
    return (label: string) => (counts.get(label.toLocaleLowerCase('en-US')) ?? 0) > 1;
  };
  const labels = new Map(names.map((name) => [name, categoryShortLabel(name)]));
  const shared = repeats(labels);
  for (const name of names) {
    if (!shared(labels.get(name)!)) continue;
    const dash = name.indexOf('-');
    labels.set(name, (dash > 1 ? name.slice(dash + 1).trim() : '') || name.trim());
  }
  const stillShared = repeats(labels);
  for (const name of names) if (stillShared(labels.get(name)!)) labels.set(name, name.trim());
  return labels;
}

/** A row amount as people read a card statement: charges plain, money back with a minus sign. */
export function formatRowAmount(amountMinor: number, currency: string): string {
  return amountMinor < 0 ? `−${formatMinor(-amountMinor, currency)}` : formatMinor(amountMinor, currency);
}

export function currentMonth(today = new Date()): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function monthBounds(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** What the Spending tab shows: a calendar month, the last 60 or 90 days, the last 6 or 12 months, or the year to date. */
export type SpendingPeriod = 'month' | 'last60' | 'last90' | 'last6m' | 'last12m' | 'ytd';

export const SPENDING_PERIODS: ReadonlyArray<{ id: SpendingPeriod; label: string; title: string }> = [
  { id: 'month', label: 'Month', title: 'One calendar month' },
  { id: 'last60', label: '60 days', title: 'The last 60 days, today included' },
  { id: 'last90', label: '90 days', title: 'The last 90 days, today included' },
  { id: 'last6m', label: '6 months', title: 'The last 6 months, today included' },
  { id: 'last12m', label: '12 months', title: 'The last 12 months, today included' },
  { id: 'ytd', label: 'YTD', title: 'Year to date: January 1 to today' },
];

export interface SpendingPeriodRange {
  from: string;
  to: string;
  /** Where the month name stands: "March 2024", "Dec 22, 2023 – Mar 20, 2024". */
  label: string;
  /** Its name on its own: "March 2024", "Last 90 days", "2024 to date". */
  name: string;
  /** The period in a sentence: "March 2024", "the last 90 days", "2024 to date". */
  phrase: string;
  /** After "Spent ": "in Mar", "in the last 90 days", "in 2024 to date". */
  spent: string;
  /** The period it is compared with; a month is compared with the month before, from the 12-month trend. */
  previous: { from: string; to: string; phrase: string } | null;
}

/** The same day `months` months away, or that month's last day when it is shorter (Aug 31 − 6 months → Feb 28 or 29). */
export function addMonths(date: string, months: number): string {
  const month = shiftMonth(date.slice(0, 7), months);
  const day = Math.min(Number(date.slice(8, 10)), Number(monthBounds(month).to.slice(8, 10)));
  return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * A period's dates, all calendar dates (today included). The last 60 or 90
 * days compare with the same number of days just before; the last 6 months
 * with the same 6 months a year earlier; the last 12 months with the 12
 * months before; the year to date with the same dates last year (February 29
 * → February 28).
 */
export function spendingPeriodRange(period: SpendingPeriod, month: string, today: string): SpendingPeriodRange {
  if (period === 'ytd') {
    const year = today.slice(0, 4);
    const lastYear = String(Number(year) - 1);
    const sameDay = today.slice(5) === '02-29' ? `${lastYear}-02-28` : `${lastYear}${today.slice(4)}`;
    return {
      from: `${year}-01-01`,
      to: today,
      label: dateRangeLabel(`${year}-01-01`, today),
      name: `${year} to date`,
      phrase: `${year} to date`,
      spent: `in ${year} to date`,
      previous: { from: `${lastYear}-01-01`, to: sameDay, phrase: `${lastYear} to the same date` },
    };
  }
  if (period === 'last60' || period === 'last90') {
    const days = period === 'last60' ? 60 : 90;
    const from = addDays(today, -(days - 1));
    return {
      from,
      to: today,
      label: dateRangeLabel(from, today),
      name: `Last ${days} days`,
      phrase: `the last ${days} days`,
      spent: `in the last ${days} days`,
      previous: { from: addDays(from, -days), to: addDays(from, -1), phrase: `the ${days} days before` },
    };
  }
  if (period === 'last6m' || period === 'last12m') {
    const months = period === 'last6m' ? 6 : 12;
    // "Apr 19 – Oct 18, 2026": from the day after the same date `months` months back, to today.
    const from = addDays(addMonths(today, -months), 1);
    return {
      from,
      to: today,
      label: dateRangeLabel(from, today),
      name: `Last ${months} months`,
      phrase: `the last ${months} months`,
      spent: `in the last ${months} months`,
      // The same dates a year earlier: for 12 months, the 12 months just before.
      previous: {
        from: addMonths(from, -12),
        to: addMonths(today, -12),
        phrase: months === 12 ? 'the 12 months before' : `the same ${months} months last year`,
      },
    };
  }
  const { from, to } = monthBounds(month);
  const name = monthLabel(month);
  return { from, to, label: name, name, phrase: name, spent: `in ${shortMonthLabel(month)}`, previous: null };
}

function utcDate(date: string): Date {
  return new Date(`${date.length === 7 ? `${date}-01` : date}T12:00:00Z`);
}

export function monthLabel(month: string): string {
  return utcDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function shortMonthLabel(month: string): string {
  return utcDate(month).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

export function dayHeading(date: string): string {
  return utcDate(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function shortDate(date: string): string {
  return utcDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function longDate(date: string): string {
  return utcDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "Sep 20 – Oct 15, 2026", with the year on both ends when they differ. */
export function dateRangeLabel(start: string, end: string): string {
  if (start === end) return longDate(start);
  if (start.slice(0, 4) === end.slice(0, 4)) return `${shortDate(start)} – ${longDate(end)}`;
  return `${longDate(start)} – ${longDate(end)}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const next = utcDate(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function todayIso(today = new Date()): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

/**
 * A pending charge older than this many days may not post as it is (a
 * cancelled hold, or one that posted under another reference), though a long
 * hold, such as a hotel's, can still settle: the list and its details say so.
 * Ten days is also as far as its possible posted versions are looked for.
 */
export const STALE_PENDING_DAYS = 10;

/** Whole days since a pending charge's transaction date, as of today (never negative). */
export function pendingDays(transactionDate: string, today = todayIso()): number {
  return Math.max(0, daysBetween(transactionDate, today));
}

export const OWNER_LABELS: Record<CardOwner, string> = { alex: 'Alex', casey: 'Casey', joint: 'Joint' };
export const OWNERS: CardOwner[] = ['alex', 'casey', 'joint'];

const ISSUERS: Record<string, string> = {
  amex: 'Amex',
  chase: 'Chase',
  citi: 'Citi',
  wellsfargo: 'Wells Fargo',
  'wells-fargo': 'Wells Fargo',
  capitalone: 'Capital One',
  discover: 'Discover',
  bofa: 'Bank of America',
};

export function issuerLabel(issuer: string): string {
  return ISSUERS[issuer] ?? issuer.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/** Other names an issuer goes by at the start of a nickname ("American Express Gold" on an Amex card). */
const ISSUER_ALIASES: Record<string, readonly string[]> = {
  amex: ['American Express'],
  citi: ['Citibank'],
  bofa: ['BofA'],
};

/** A card network and its tier at the end of a name: they say nothing the issuer and the name don't. */
const NETWORK_SUFFIX = /\s+(?:World(?:\s+(?:Elite|Legend))?\s+)?(?:Mastercard|Visa(?:\s+(?:Signature|Infinite))?)(?:\s+Card)?$/i;

/** A nickname without the issuer's name at its start, where it begins with it ("Citi/Sample Miles" on a Citi card). */
function nicknameAfterIssuer(account: Pick<CardAccount, 'issuer' | 'nickname'>): string {
  const name = account.nickname?.trim() ?? '';
  for (const prefix of [issuerLabel(account.issuer), ...(ISSUER_ALIASES[account.issuer] ?? [])]) {
    const head = name.slice(0, prefix.length);
    if (head.toLowerCase() === prefix.toLowerCase() && (name.length === prefix.length || /[\s/:·,-]/.test(name[prefix.length]))) {
      return name.slice(prefix.length).replace(/^[\s/:·,-]+/, '');
    }
  }
  return name;
}

/**
 * A card's name with its issuer said once: a nickname that already begins with the issuer's name ("Sample Palladium"
 * on a Sample card, "Citi/Sample Miles" on a Citi card) is not prefixed with it again. Its network and tier are kept.
 */
export function issuerOnceCardName(account: Pick<CardAccount, 'issuer' | 'nickname'>): string {
  return [issuerLabel(account.issuer), nicknameAfterIssuer(account)].filter(Boolean).join(' ');
}

/** issuerOnceCardName without a card network and its tier at the end ("… World Elite Mastercard", "… Visa Signature"). */
export function shortCardName(account: Pick<CardAccount, 'issuer' | 'nickname'>): string {
  const name = nicknameAfterIssuer(account);
  return [issuerLabel(account.issuer), name.replace(NETWORK_SUFFIX, '').trim() || name].filter(Boolean).join(' ');
}

/** A card's previous name, as it was always shown: the issuer, then the nickname as it is. */
export function fullCardName(account: Pick<CardAccount, 'issuer' | 'nickname'>): string {
  return [issuerLabel(account.issuer), account.nickname?.trim()].filter(Boolean).join(' ');
}

type NamedCard = Pick<CardAccount, 'id' | 'issuer' | 'nickname' | 'last4' | 'last5'>;

/** A card's label as rows, details and pickers render it (cardNameLabel): its name, then its ending. */
function labelText(name: string, account: NamedCard): string {
  const ending = cardEnding(account);
  return ending ? `${name} ··${ending}` : name;
}

/** A label as a page shows it: spaces run together, invisible characters gone. */
const asShown = (text: string) => text.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/[\s\p{Z}]+/gu, ' ').trim();

/**
 * Letters of other alphabets that look like Latin ones, each as the Latin letter it looks like (Cyrillic, Greek), and
 * Latin letters without their dot. Curated: every other letter is compared as it is.
 */
const LOOKALIKE_LETTERS: Readonly<Record<string, string>> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C',
  'Т': 'T', 'Х': 'X', 'У': 'Y', 'Ү': 'Y', 'Ԛ': 'Q', 'Ԝ': 'W', 'Ӏ': 'I',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q',
  'ԝ': 'w', 'һ': 'h', 'ӏ': 'l', 'ү': 'y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
  'Υ': 'Y', 'Χ': 'X',
  'ο': 'o', 'ν': 'v', 'ι': 'i', 'α': 'a', 'ρ': 'p', 'υ': 'u', 'κ': 'k',
  'ı': 'i', 'ȷ': 'j',
};
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKE_LETTERS).join('')}]`, 'gu');

/**
 * What a label could be mistaken for: letter case, accents on Latin letters, spaces, punctuation, symbols and
 * invisible characters aside, and a curated set of letters and digits that look alike taken as one (LOOKALIKE_LETTERS;
 * 0 and o; 1, i and l; rn and m; vv and w; cl and d). Every other letter, of any script (CJK too), and the marks of
 * other scripts, are compared as they are.
 */
function lookalike(text: string): string {
  return text.normalize('NFKD').replace(LOOKALIKE_PATTERN, (letter) => LOOKALIKE_LETTERS[letter])
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')
    .replace(/[i1]/g, 'l').replace(/0/g, 'o').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
}

/**
 * Each card's name as shown, by id, so that no two of the household's cards (closed ones too) can be mistaken for each
 * other that could be told apart before, compared as they are shown, ending included (lookalike):
 * - the issuer said once (issuerOnceCardName), except on cards that would then read like another card whose previous
 *   label (fullCardName) differed from theirs: those keep their previous names;
 * - then without a card network and its tier at the end (shortCardName) only where that too stays unique: the cards
 *   that would then read alike keep their network and tier.
 * So two cards whose labels differed before read alike now only if both show their previous labels, as before.
 * Display only: the nicknames are kept as they are.
 */
export function cardDisplayNames(accounts: readonly NamedCard[]): Map<string, string> {
  const before = accounts.map((account) => asShown(labelText(fullCardName(account), account)));
  const previous = new Set<string>();
  const shorter = new Set<string>();
  const name = (account: NamedCard) => previous.has(account.id) ? fullCardName(account)
    : shorter.has(account.id) ? shortCardName(account) : issuerOnceCardName(account);
  // Until none changes: of any two cards whose labels could be mistaken for each other, both give way where they can.
  const settle = (giveWay: (id: string) => boolean, exempt: (i: number, j: number) => boolean) => {
    for (let changed = true; changed;) {
      changed = false;
      const read = accounts.map((account) => lookalike(labelText(name(account), account)));
      for (let i = 0; i < accounts.length; i += 1) {
        for (let j = i + 1; j < accounts.length; j += 1) {
          if (read[i] !== read[j] || exempt(i, j)) continue;
          if (giveWay(accounts[i].id)) changed = true;
          if (giveWay(accounts[j].id)) changed = true;
        }
      }
    }
  };
  // Two cards whose previous labels were the same read alike either way: their issuer is said once.
  settle((id) => !previous.has(id) && Boolean(previous.add(id)), (i, j) => before[i] === before[j]);
  for (const account of accounts) if (!previous.has(account.id)) shorter.add(account.id);
  settle((id) => shorter.delete(id), () => false);
  return new Map(accounts.map((account) => [account.id, name(account)]));
}

/** Every card of the household's this page has learnt of (lists read, cards created), by id, the latest kept. */
let knownCards = new Map<string, NamedCard>();
/** Each known card's name as shown, and what that was made of. */
let shownNames = new Map<string, { name: string; source: string }>();
const nameSource = (account: Pick<CardAccount, 'issuer' | 'nickname' | 'last4' | 'last5'>) =>
  `${account.issuer}|${account.nickname ?? ''}|${cardEnding(account) ?? ''}`;

/**
 * Called with every list of the household's cards that is read (closed ones too) and every card created or changed,
 * as soon as it is: every name is made again among all the cards known (cardDisplayNames). Cards are never deleted, so
 * a list read before a card was created forgets none.
 */
export function rememberCardAccounts(accounts: readonly NamedCard[] | undefined): void {
  // Anything not a card account is left out: naming cards never fails a read, a creation or a change.
  for (const account of accounts ?? []) {
    if (typeof account?.id === 'string' && typeof account.issuer === 'string') knownCards.set(account.id, account);
  }
  const all = [...knownCards.values()];
  const names = cardDisplayNames(all);
  shownNames = new Map(all.map((account) => [account.id, { name: names.get(account.id)!, source: nameSource(account) }]));
}

/** For tests: no card known. */
export function forgetCardAccounts(): void {
  knownCards = new Map();
  shownNames = new Map();
}

/**
 * An account's name as shown: as all the household's cards known allow (cardDisplayNames). A card not known, or
 * changed since, keeps its previous name; every card named here is known first (spendingApi). Display only: the
 * nickname is kept as it is.
 */
export function cardDisplayName(account: Pick<CardAccount, 'id' | 'issuer' | 'nickname' | 'last4' | 'last5'>): string {
  const shown = shownNames.get(account.id);
  return shown && shown.source === nameSource(account) ? shown.name : fullCardName(account);
}

/** The digits the issuer shows at the end of the account: five for American Express when known, else four. */
export function cardEnding(account: Pick<CardAccount, 'last4' | 'last5'> | undefined): string | undefined {
  return account?.last5 ?? account?.last4;
}

/** "Amex ··90003": issuer and the trailing digits the issuer shows, never more. */
export function cardShortLabel(account: Pick<CardAccount, 'issuer' | 'last4' | 'last5'> | undefined): string {
  if (!account) return 'Unknown card';
  const ending = cardEnding(account);
  return ending ? `${issuerLabel(account.issuer)} ··${ending}` : issuerLabel(account.issuer);
}

/** "Amex Gold ··90003": with the account's name, so two cards of one issuer stay apart; the issuer said once. */
export function cardNameLabel(account: CardAccount | undefined): string {
  if (!account) return 'Unknown card';
  const ending = cardEnding(account);
  return [cardDisplayName(account), ending ? `··${ending}` : null].filter(Boolean).join(' ');
}

/** cardNameLabel's parts: "Amex Gold" and "90003", so a narrow cell can shorten the name and keep the ending. */
export function cardNameParts(account: CardAccount | undefined): { name: string; ending?: string } {
  if (!account) return { name: 'Unknown card' };
  return { name: cardDisplayName(account), ending: cardEnding(account) };
}

export function cardOptionLabel(account: CardAccount): string {
  return `${cardNameLabel(account)} · ${OWNER_LABELS[account.owner]}${account.status === 'closed' ? ' (closed)' : ''}`;
}

const KIND_LABELS: Record<CardTransactionKind, string> = {
  purchase: 'Purchase',
  refund: 'Refund or credit',
  payment: 'Card payment',
  fee: 'Fee',
  interest: 'Interest',
  adjustment: 'Adjustment',
  other: 'Other',
};

export function kindLabel(kind: CardTransactionKind): string {
  return KIND_LABELS[kind] ?? kind;
}

const OUTFLOW_LABELS: Partial<Record<CashEventType, string>> = { withdrawal: 'Withdrawal', transfer: 'Transfer out' };

/** A brokerage outflow a card payment may have come from: withdrawals and transfers out. */
export function cashOutflowLabel(type: CashEventType): string {
  return OUTFLOW_LABELS[type] ?? type;
}

/** An outflow's date against the payment's: "the same day", "1 day before the payment", "3 days after the payment". */
export function dayOffsetLabel(days: number): string {
  if (days === 0) return 'the same day';
  const count = Math.abs(days);
  return `${count} ${count === 1 ? 'day' : 'days'} ${days < 0 ? 'before' : 'after'} the payment`;
}

/** How far from a payment its suggested brokerage outflows can be: "within 5 days". */
export function paymentSourceWindowLabel(): string {
  const { daysBefore, daysAfter } = CARD_PAYMENT_SOURCE_RULES;
  return daysBefore === daysAfter
    ? `within ${daysBefore} days`
    : `from ${daysBefore} days before to ${daysAfter} days after it`;
}

/** Where a row came from: the offline tool's file formats, or another producer's own slug. */
export function sourceLabel(source: string): string {
  if (source === 'amex-csv') return 'File import (Amex CSV)';
  if (source === 'ofx') return 'File import (OFX / QFX / QBO)';
  if (source === 'wf-csv') return 'File import (Wells Fargo CSV)';
  return source;
}

/** Signed change of `current` over `previous`, or null when there is nothing to compare. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** What an import's commit answered, as far as its result line needs it (E2d: every count is what it did). */
export interface ImportOutcome {
  /** False for the 200 that stored nothing: nothing new, nothing held or to review. */
  imported: boolean;
  newCount: number;
  /** Rows already stored, the pending rows this import posted among them. */
  duplicateCount: number;
  pendingPostedCount: number;
  stalePendingDismissedCount?: number;
  heldCount?: number;
  /** Review items stored: one per held row, and one per stored row that differs from the file's. */
  reviewCount?: number;
}

/** The held rows and the stored rows that differ, apart (`reviewCount` counts both). */
export function importReviewCounts(result: Pick<ImportOutcome, 'heldCount' | 'reviewCount'>): { held: number; differing: number } {
  const held = result.heldCount ?? 0;
  return { held, differing: Math.max(0, (result.reviewCount ?? 0) - held) };
}

/** What an import did, in one line: what was added, posted, dismissed, held or left for review. */
export function importResultText(result: ImportOutcome): string {
  if (!result.imported) return 'Nothing new: this import is already stored.';
  const charges = (count: number) => `${count} pending ${count === 1 ? 'charge' : 'charges'}`;
  const { held, differing } = importReviewCounts(result);
  const stored = result.duplicateCount - result.pendingPostedCount;
  const parts = [
    result.newCount > 0 ? `Imported ${result.newCount} new ${result.newCount === 1 ? 'row' : 'rows'}` : 'No new rows',
    ...(stored > 0 ? [`${stored} already stored`] : []),
    ...(result.pendingPostedCount > 0 ? [`${charges(result.pendingPostedCount)} posted`] : []),
    ...((result.stalePendingDismissedCount ?? 0) > 0 ? [`${charges(result.stalePendingDismissedCount ?? 0)} dismissed`] : []),
    ...(held > 0 ? [`${held} ${held === 1 ? 'row' : 'rows'} held for review`] : []),
    ...(differing > 0 ? [`${differing} stored ${differing === 1 ? 'row differs' : 'rows differ'} from the file`] : []),
  ];
  return `${parts.join('; ')}.`;
}

/** What the owner still has to decide after an import, or null when nothing waits. */
export function importReviewText(result: ImportOutcome): string | null {
  if (!result.imported) return null;
  const { held, differing } = importReviewCounts(result);
  const sentences = [
    ...(held > 0 ? [`${held === 1 ? 'The held row is' : 'The held rows are'} not in spending: in the review, say whether `
      + `${held === 1 ? 'it is' : 'each is'} a charge the browser extension already synced, a new one, or not yours.`] : []),
    ...(differing > 0 ? [`${differing === 1 ? 'The stored row stays' : 'The stored rows stay'} as ${differing === 1 ? 'it is' : 'they are'} `
      + 'unless you apply the file\'s version in the review.'] : []),
  ];
  return sentences.length > 0 ? sentences.join(' ') : null;
}
