/**
 * Merchant names for grouping: card descriptors vary ("SQ *BLUE BOTTLE #12
 * SEATTLE WA", "Blue Bottle"), so spending by merchant, recurring charges
 * and merchant filters use a normalized key. Only recognized descriptor
 * suffixes join a shorter key's group. Pure and deterministic.
 */

/** Payment processors whose descriptor prefix ("SQ *BLUE BOTTLE") comes before the real merchant. */
const PROCESSORS = new Set([
  'SQ', 'SQU', 'TST', 'TOAST', 'SP', 'PP', 'PAYPAL', 'PY', 'IN', 'ZETTLE', 'IZ', 'SUMUP', 'FS', 'FSP', 'CKO', 'EB',
  'GOOGLE', 'GGL', 'APL', 'BT', 'PADDLE.NET', 'WPY', 'CLV', 'SPOT', 'PAR', 'PMNT', 'STRIPE', 'DRI', 'LS', 'POS',
]);
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'USA', 'US',
]);
const TRAILING_NOISE = new Set(['STORE', 'STORES', 'STR', 'LOC', 'LOCATION', 'NO', 'NUM', 'INC', 'LLC', 'LTD', 'CO', 'CORP']);
/** Group keys shorter than this never absorb longer names (keeps "THE" from swallowing everything). */
const MIN_GROUP_KEY = 4;
const WALLET_PREFIX = /^(?:APL\s*PAY|APPLE\s*PAY|GOOGLE\s*PAY|G\s*PAY|SAMSUNG\s*PAY)(?:\s+|\s*\*\s*)(?=\S)/;
const NON_MERCHANT_WORDS = new Set([
  ...PROCESSORS, ...US_STATES, ...TRAILING_NOISE,
  'APLPAY', 'APPLEPAY', 'GOOGLEPAY', 'GPAY', 'SAMSUNGPAY', 'PAY', 'PAYMENT', 'PURCHASE',
  'CARD', 'CREDIT', 'DEBIT', 'ONLINE', 'UNKNOWN', 'MERCHANT', 'THE', 'THANK', 'YOU',
]);
// Bare locations are not evidence of a merchant; keep exact matches, never prefix-fold them.
const BARE_CITIES = new Set([
  'ATLANTA', 'ALPHARETTA', 'DULUTH', 'SUWANEE', 'JOHNS CREEK', 'NORCROSS', 'CUMMING', 'MARIETTA',
  'SEATTLE', 'PORTLAND', 'NEW YORK', 'SAN FRANCISCO', 'LOS ANGELES', 'SAN JOSE', 'SAN DIEGO',
  'CHICAGO', 'BOSTON', 'AUSTIN', 'DALLAS', 'HOUSTON', 'MIAMI', 'DENVER', 'PHOENIX',
  'PHILADELPHIA', 'WASHINGTON', 'LAS VEGAS', 'ORLANDO', 'CHARLOTTE', 'SAN ANTONIO',
]);
// Confirmed merchant families, not processors or cities. Preserve their history
// across wallet, online and store-location descriptors even without a bare row.
const MERCHANT_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ['TARGET.COM', 'TARGET'], ['TARGET', 'TARGET'],
  ['WALMART.COM', 'WALMART'], ['WALMART', 'WALMART'], ['WAL-MART', 'WALMART'],
  ['BEST BUY', 'BEST BUY'], ['PARK CITY MOUNTAIN', 'PARK CITY MOUNTAIN'], ['CIRCLE NOODLE', 'CIRCLE NOODLE'],
  ['SAKS DIRECT', 'SAKS DIRECT'], ['US TREASURY', 'US TREASURY'], ['LAZ PARKING', 'LAZ PARKING'],
  ['MICRO CENTER', 'MICRO CENTER'], ['MICRO ELECTRONICS', 'MICRO CENTER'], ['MICRO ELECTRO', 'MICRO CENTER'],
  ['GREAT WALL SUPERMARKET', 'GREAT WALL SUPERMARKET'], ['GREAT WALL SUPER MARKET', 'GREAT WALL SUPERMARKET'],
  ['GREAT WALL SUPERMARK', 'GREAT WALL SUPERMARKET'], ['GREAT WALL SU', 'GREAT WALL SUPERMARKET'],
  ['HYATT', 'HYATT'],
  ['UBER EATS', 'UBER EATS'], ['UBER ONE', 'UBER ONE'], ['UBER TRIP', 'UBER'],
];

/** The most answers a remembered function keeps: when it has this many, it forgets them all and starts over. */
const REMEMBERED_ANSWERS = 20_000;
/** A longer text is answered afresh each time, never kept, so the memory stays small (descriptors are far shorter). */
const REMEMBERED_TEXT_MAX_LENGTH = 256;

/**
 * `answer`, keeping its answer for each exact text it is asked about. Every read of a household's card rows asks about
 * the same few thousand descriptors and keys, over and over. Only for a pure function of the text alone: an answer
 * kept is the answer it would give again.
 */
function remembered<T>(answer: (text: string) => T): (text: string) => T {
  const answers = new Map<string, T>();
  return (text) => {
    let known = answers.get(text);
    if (known === undefined) {
      known = answer(text);
      if (text.length <= REMEMBERED_TEXT_MAX_LENGTH) {
        if (answers.size >= REMEMBERED_ANSWERS) answers.clear();
        answers.set(text, known);
      }
    }
    return known;
  };
}

const merchantFamilyKey = remembered((key: string): string => {
  return MERCHANT_FAMILIES.find(([prefix]) => key === prefix || key.startsWith(`${prefix} `)
    // Some issuer fields join a truncated merchant directly to its city.
    || (key.startsWith(prefix) && BARE_CITIES.has(key.slice(prefix.length))))?.[1] ?? key;
});

/** Whether a key identifies more than a processor, wallet, location or descriptor filler. */
export function isCardMerchantKey(key: string): boolean {
  return rememberedIsMerchantKey(key);
}

const rememberedIsMerchantKey = remembered((key: string): boolean => {
  let text = key.replace(/#\s*[A-Z]?\d+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const city of BARE_CITIES) {
    if (text.endsWith(` ${city}`)) text = text.slice(0, -city.length).trim();
  }
  while (WALLET_PREFIX.test(text)) text = text.replace(WALLET_PREFIX, '');
  return !!text && !BARE_CITIES.has(text)
    && !/^(?:APL\s*PAY|APPLE\s*PAY|GOOGLE\s*PAY|G\s*PAY|SAMSUNG\s*PAY)$/.test(text)
    && text.split(/\s+/).some((word) => /\p{L}/u.test(word) && !NON_MERCHANT_WORDS.has(word.replace(/[.,;:]+$/, '')));
});

export function isCardMerchantGroupRoot(key: string): boolean {
  return key.length >= MIN_GROUP_KEY && isCardMerchantKey(key);
}

/**
 * A grouping key for a merchant name or card descriptor: upper case, the
 * processor prefix or the order reference after "*" dropped, phone numbers,
 * store and terminal numbers and a trailing state code removed. Idempotent:
 * a key maps to itself. "SQ *BLUE BOTTLE #12 SEATTLE WA" → "BLUE BOTTLE SEATTLE",
 * "AMZN Mktp US*AB12CD34E" → "AMZN MKTP", "Fourth Coffee" → "FOURTH COFFEE".
 */
export function cardMerchantKey(name: string): string {
  return rememberedMerchantKey(name);
}

const rememberedMerchantKey = remembered((name: string): string => {
  let key = name.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
  // Removing noise can expose another prefix (e.g. WWW.AplPay or a trailing state).
  for (;;) {
    const next = normalizeMerchantKey(key);
    if (next === key) return key;
    key = next;
  }
});

function normalizeMerchantKey(name: string): string {
  let text = name.replace(/^WWW\./, '');
  while (WALLET_PREFIX.test(text)) text = text.replace(WALLET_PREFIX, '');
  // "PROCESSOR *MERCHANT" keeps the merchant; "MERCHANT*ORDER REF" keeps the merchant.
  for (let star = text.indexOf('*'); star >= 0; star = text.indexOf('*')) {
    const head = text.slice(0, star).trim();
    const tail = text.slice(star + 1).trim();
    const uberService = head === 'UBER' ? /^(EATS|ONE)(?:\s|$)/.exec(tail)?.[1] : undefined;
    text = (uberService ? `UBER ${uberService}` : (PROCESSORS.has(head) || !head) && tail ? tail : head)
      .replace(WALLET_PREFIX, '');
  }
  text = text
    .replace(/^WWW\./, '')
    .replace(/\(?\b1?[-. ]?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, ' ')
    .replace(/#\s*[A-Z]?\d+/g, ' ')
    // Store and terminal numbers after the first word ("TARGET 00012345 SEATTLE").
    .replace(/(?<=\S\s+)\d{3,}(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = text.split(' ').filter(Boolean);
  // Trailing store numbers, terminal ids, state codes and filler words, until none is left.
  for (;;) {
    if (tokens.length <= 1) break;
    const last = tokens[tokens.length - 1].replace(/[.,;:]+$/, '');
    const digits = (last.match(/\d/g) ?? []).length;
    if (digits >= 2 || US_STATES.has(last) || TRAILING_NOISE.has(last) || /^[-–—&/.,]+$/.test(last)) {
      tokens.pop();
      continue;
    }
    break;
  }
  const key = tokens.join(' ').replace(/[\s.,;:\-–—/]+$/, '').trim();
  return key || name.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Maps each key to its group: the shortest eligible key in `keys` followed
 * by a recognized descriptor suffix, else itself. Arbitrary word prefixes
 * are not evidence that two charges belong to the same merchant.
 */
export function groupCardMerchantKeys(keys: Iterable<string>): Map<string, string> {
  const unique = [...new Set(keys)].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const groups = new Map<string, string>();
  const roots: string[] = [];
  // Where the first root of each merchant family is in `roots`: the first root matchesCardMerchantGroup accepts for a
  // key is looked up by the key's family rather than found by asking every root.
  const firstRoot = new Map<string, number>();
  for (const key of unique) {
    const family = merchantFamilyKey(key);
    // matchesCardMerchantGroup compares families of families, for the key and for a root alike.
    const compared = merchantFamilyKey(family);
    const index = firstAcceptingRoot(compared, firstRoot);
    groups.set(key, index === undefined ? family : roots[index]);
    if (index === undefined && isCardMerchantGroupRoot(family)) {
      // The first root of its family: an earlier one would have accepted this key.
      firstRoot.set(compared, roots.length);
      roots.push(family);
    }
  }
  return groups;
}

/**
 * Where the first root {@link matchesCardMerchantGroup} accepts for a key of merchant family `family` is, from where
 * the first root of each family is: the earliest root of the same family, or of `family` less one recognized
 * descriptor suffix when what is left can lead a group.
 */
function firstAcceptingRoot(family: string, firstRoot: ReadonlyMap<string, number>): number | undefined {
  let first = firstRoot.get(family);
  for (const suffix of GROUP_SUFFIXES) {
    if (!family.endsWith(` ${suffix}`)) continue;
    const head = family.slice(0, -(suffix.length + 1));
    const index = isCardMerchantGroupRoot(head) ? firstRoot.get(head) : undefined;
    if (index !== undefined && (first === undefined || index < first)) first = index;
  }
  return first;
}

/** Exact identity or a complete recognized descriptor suffix, never an arbitrary word-extension. */
export function matchesCardMerchantGroup(key: string, groupKey: string): boolean {
  key = merchantFamilyKey(key);
  groupKey = merchantFamilyKey(groupKey);
  if (key === groupKey) return true;
  if (!isCardMerchantGroupRoot(groupKey) || !key.startsWith(`${groupKey} `)) return false;
  const suffix = key.slice(groupKey.length + 1);
  return BARE_CITIES.has(suffix) || suffix === 'RETURN';
}

/** The descriptor suffixes a group root may be followed by, longest first. */
const GROUP_SUFFIXES = [...BARE_CITIES, 'RETURN'].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

/**
 * The group a key belongs to on its own: its merchant family, without one recognized descriptor suffix (a bare
 * city or RETURN) when what is left can lead a group, the rule {@link matchesCardMerchantGroup} applies. Unlike
 * {@link groupCardMerchantKeys} it needs no shorter key beside it, so a key's root never depends on which other
 * rows are in view. Idempotent.
 */
export function cardMerchantGroupRoot(key: string): string {
  return rememberedGroupRoot(key);
}

const rememberedGroupRoot = remembered((key: string): string => {
  const family = merchantFamilyKey(key);
  for (const suffix of GROUP_SUFFIXES) {
    if (!family.endsWith(` ${suffix}`)) continue;
    const head = merchantFamilyKey(family.slice(0, -(suffix.length + 1)));
    if (matchesCardMerchantGroup(family, head)) return head;
  }
  return family;
});

/** The name people recognize for a group: its most frequent original name, then the shortest. */
export function cardMerchantDisplayNames(rows: ReadonlyArray<{ key: string; name: string }>, groups: Map<string, string>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const group = groups.get(row.key) ?? row.key;
    const names = counts.get(group) ?? new Map<string, number>();
    names.set(row.name, (names.get(row.name) ?? 0) + 1);
    counts.set(group, names);
  }
  const result = new Map<string, string>();
  for (const [group, names] of counts) {
    const best = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))[0];
    result.set(group, best[0]);
  }
  return result;
}
