/**
 * How Everyday shows a spending category.
 *
 * Tone: a fixed colour family per category, so a category looks the same in
 * every view (bars, transaction chips). Issuers name categories freely
 * ("Merchandise & Supplies-Groceries", "Food & Drink", "Supermarkets"), so
 * names are matched by keyword, the top level (before the first "-") first,
 * as the short label shows it; any other name gets one of a few spare tones
 * from a stable hash of its name. Only the tone's name reaches the page (as
 * `data-category-tone`); each mode's stylesheet maps it to a colour.
 *
 * Short label: the issuer's top level ("Merchandise & Supplies-Groceries" →
 * "Merchandise"), so a chip is never cut; the full name stays in its
 * accessible name, its tooltip and the transaction's details.
 */
export type CategoryTone =
  | 'groceries' | 'dining' | 'travel' | 'shopping' | 'gas' | 'entertainment'
  | 'bills' | 'health' | 'home' | 'fees' | 'none'
  | 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5';

const RULES: Array<[RegExp, CategoryTone]> = [
  [/uncategori[sz]ed|^other$|^none$/, 'none'],
  [/grocer|supermarket|wholesale club/, 'groceries'],
  [/restaurant|dining|food|drink|coffee|caf[eé]|bakery|\bbars?\b/, 'dining'],
  [/travel|airline|\bair\b|hotel|lodging|flight|transit|rail|taxi|rideshare|vacation/, 'travel'],
  [/\bgas\b|fuel|automotive|\bauto\b|parking|toll/, 'gas'],
  [/entertain|movie|cinema|stream|music|game|subscription/, 'entertainment'],
  [/bill|utilit|phone|internet|cable|insurance|rent|mortgage/, 'bills'],
  [/health|medical|pharma|doctor|dental|fitness|wellness|\bgym\b/, 'health'],
  [/home|garden|furniture|hardware|improvement/, 'home'],
  [/\bfees?\b|interest|adjustment|finance charge/, 'fees'],
  [/shop|merchandise|retail|store|clothing|apparel|books?|electronics|gift/, 'shopping'],
];

const SPARE: CategoryTone[] = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];

/** The issuer's top level: the part before the first "-" ("E-Commerce" stays whole). */
function topLevel(name: string): string {
  const dash = name.indexOf('-');
  return dash > 1 ? name.slice(0, dash).trim() : name;
}

const ruleTone = (text: string): CategoryTone | null => RULES.find(([pattern]) => pattern.test(text))?.[1] ?? null;

export function categoryTone(name: string): CategoryTone {
  const key = name.normalize('NFKC').trim().toLowerCase();
  if (key === '') return 'none';
  const tone = ruleTone(topLevel(key)) ?? ruleTone(key);
  if (tone) return tone;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return SPARE[hash % SPARE.length];
}

/** Longer than this, a top level such as "Merchandise & Supplies" keeps its first part. */
const SHORT_LABEL_MAX = 18;

export function categoryShortLabel(name: string): string {
  const trimmed = name.trim();
  let label = topLevel(trimmed);
  if (label.length > SHORT_LABEL_MAX) {
    const amp = label.indexOf(' & ');
    if (amp > 1) label = label.slice(0, amp).trim();
  }
  return label || trimmed;
}
