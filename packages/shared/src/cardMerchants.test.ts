import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardMerchantDisplayNames,
  cardMerchantGroupRoot,
  cardMerchantKey,
  groupCardMerchantKeys,
  isCardMerchantGroupRoot,
  isCardMerchantKey,
  matchesCardMerchantGroup,
} from './cardMerchants.js';

// Descriptors below are synthetic, shaped like the ones issuers print.
describe('cardMerchantKey', () => {
  it('drops processor prefixes, order references, phone, store and terminal numbers and state codes', () => {
    const cases: Array<[string, string]> = [
      ['SQ *BLUE BOTTLE #12 SEATTLE WA', 'BLUE BOTTLE SEATTLE'],
      ['Fourth Coffee', 'FOURTH COFFEE'],
      ['FOURTH COFFEE #114 SEATTLE WA', 'FOURTH COFFEE SEATTLE'],
      ['AMZN Mktp US*AB12CD34E', 'AMZN MKTP'],
      ['UBER *TRIP HELP.UBER.COM', 'UBER'],
      ['AplPay UBER *EATS HELP.UBER.COM', 'UBER EATS'],
      ['UBER *ONE HELP.UBER.COM', 'UBER ONE'],
      ['TST* PROSEWARE BISTRO 0042', 'PROSEWARE BISTRO'],
      ['PAYPAL *SAMPLESHOP', 'SAMPLESHOP'],
      ['SQ *FOO*BAR 123', 'FOO'],
      ['APPLE.COM/BILL 866-712-7753 CA', 'APPLE.COM/BILL'],
      ['NORTHWIND GROCERY 0042', 'NORTHWIND GROCERY'],
      ['WWW.NETFLIX.COM', 'NETFLIX.COM'],
      ['7-ELEVEN 12345', '7-ELEVEN'],
      ['TARGET 00012345 SEATTLE WA', 'TARGET SEATTLE'],
      ['99 RANCH MARKET #123', '99 RANCH MARKET'],
      ['  sample   cafe   inc. ', 'SAMPLE CAFE'],
      ['ＷＩＤＥ　ＷＯＲＬＤ', 'WIDE WORLD'],
      ['#123', '#123'],
      ['AplPay TARGET DULUTH GA', 'TARGET DULUTH'],
      ['AplPay MICRO CENTER DULUTH GA', 'MICRO CENTER DULUTH'],
      ['AplPay IN *SAMPLE PLUMBING', 'SAMPLE PLUMBING'],
      ['AplPay SQ *SAMPLE CAFE', 'SAMPLE CAFE'],
      ['AplPay IN *X', 'X'],
      ['AplPay 8005550100 GA', 'GA'],
      ['APL PAY TARGET 00012345 DULUTH GA', 'TARGET DULUTH'],
      ['APPLE PAY SQ *SAMPLE CAFE', 'SAMPLE CAFE'],
      ['GOOGLE PAY SAMPLE CAFE', 'SAMPLE CAFE'],
      ['GOOGLEPAY SQ *SAMPLE CAFE', 'SAMPLE CAFE'],
      ['G PAY SAMPLE CAFE', 'SAMPLE CAFE'],
      ['GPAY SAMPLE CAFE', 'SAMPLE CAFE'],
      ['SAMSUNG PAY SAMPLE CAFE', 'SAMPLE CAFE'],
      ['SAMSUNGPAY SAMPLE CAFE', 'SAMPLE CAFE'],
      ['APLPAY', 'APLPAY'],
      ['APLPAYMENTS SHOP', 'APLPAYMENTS SHOP'],
      ['WWW.AplPay SQ *SAMPLE CAFE', 'SAMPLE CAFE'],
    ];
    for (const [raw, key] of cases) {
      assert.equal(cardMerchantKey(raw), key, raw);
      assert.equal(cardMerchantKey(key), key, `${raw} is idempotent`);
    }
  });
});

describe('merchant groups', () => {
  it('never uses wallets, processors, states, filler or bare locations to absorb merchants', () => {
    for (const root of ['APLPAY', 'APPLE PAY', 'GOOGLE PAY', 'SAMSUNG PAY', 'PAYPAL', 'PADDLE.NET', 'GOOGLE', 'STRIPE', 'GA', 'STORE', 'ONLINE', 'THANK YOU', 'DULUTH', 'NEW YORK', 'STORE DULUTH', 'APPLE PAY IN', 'APPLE PAY #A123', 'SAN MATEO', 'BALTIMORE', 'MINNEAPOLIS']) {
      const child = `${root} SAMPLE CAFE`;
      const groups = groupCardMerchantKeys([root, child]);
      assert.equal(groups.get(child), child, root);
      assert.equal(matchesCardMerchantGroup(child, root), false, root);
      assert.equal(matchesCardMerchantGroup(root, root), true, root);
    }
  });

  it('requires a complete recognized suffix, not just a shared word prefix', () => {
    for (const key of ['FOURTH COFFEE SAMPLE SHOP SEATTLE', 'FOURTH COFFEE RETURN SHOP', 'UBER SAMPLE SHOP']) {
      const root = key.startsWith('UBER ') ? 'UBER' : 'FOURTH COFFEE';
      assert.equal(matchesCardMerchantGroup(key, root), false);
      assert.equal(groupCardMerchantKeys([root, key]).get(key), key);
    }
    assert.equal(matchesCardMerchantGroup('FOURTH COFFEE RETURN', 'FOURTH COFFEE'), true);
  });

  it('unites wallet and non-wallet twins without joining Target and Micro Center', () => {
    const raw = [
      'AplPay TARGET DULUTH GA', 'TARGET 00012345 DULUTH GA',
      'AplPay MICRO CENTER DULUTH GA', 'MICRO CENTER #095 DULUTH GA',
      'AplPay IN *SAMPLE PLUMBING', 'AplPay 8005550100 GA', 'AplPay SQ *SAMPLE CAFE', 'APLPAY',
    ];
    const keys = raw.map(cardMerchantKey);
    const groups = groupCardMerchantKeys(keys);
    assert.equal(groups.get(keys[0]), groups.get(keys[1]));
    assert.equal(groups.get(keys[2]), groups.get(keys[3]));
    assert.notEqual(groups.get(keys[0]), groups.get(keys[2]));
    assert.equal(new Set(groups.values()).size, 6);
    for (const key of keys) {
      for (const group of new Set(groups.values())) {
        assert.equal(matchesCardMerchantGroup(key, group), groups.get(key) === group);
      }
    }
  });

  it('joins names that extend a key word by word, never through short keys', () => {
    const groups = groupCardMerchantKeys([
      'FOURTH COFFEE SEATTLE', 'FOURTH COFFEE', 'FOURTH COFFEE PORTLAND', 'FOURTH COFFEEHOUSE', 'THE', 'THE HOME DEPOT', 'UBER', 'UBER EATS',
    ]);
    assert.equal(groups.get('FOURTH COFFEE SEATTLE'), 'FOURTH COFFEE');
    assert.equal(groups.get('FOURTH COFFEE PORTLAND'), 'FOURTH COFFEE');
    assert.equal(groups.get('FOURTH COFFEEHOUSE'), 'FOURTH COFFEEHOUSE');
    assert.equal(groups.get('THE HOME DEPOT'), 'THE HOME DEPOT');
    assert.equal(groups.get('UBER EATS'), 'UBER EATS');
    assert.equal(groups.get('UBER'), 'UBER');
    for (const [key, group] of groups) assert.equal(matchesCardMerchantGroup(key, group), true, key);
    assert.equal(matchesCardMerchantGroup('FOURTH COFFEEHOUSE', 'FOURTH COFFEE'), false);
    assert.equal(matchesCardMerchantGroup('THE HOME DEPOT', 'THE'), false);
  });

  it('preserves confirmed brand families without a bare descriptor and separates Uber businesses', () => {
    const groups = groupCardMerchantKeys([
      'TARGET DULUTH', 'TARGET SAN MATEO', 'WALMART.COM ONLINE', 'WALMART ATLANTA',
      'BEST BUY SEATTLE', 'BEST BUY BALTIMORE', 'UBER', 'UBER EATS', 'UBER EATS SEATTLE', 'UBER ONE',
    ]);
    assert.equal(groups.get('TARGET DULUTH'), 'TARGET');
    assert.equal(groups.get('TARGET SAN MATEO'), 'TARGET');
    assert.equal(groups.get('WALMART.COM ONLINE'), 'WALMART');
    assert.equal(groups.get('WALMART ATLANTA'), 'WALMART');
    assert.equal(groups.get('BEST BUY BALTIMORE'), 'BEST BUY');
    assert.equal(groups.get('UBER EATS SEATTLE'), 'UBER EATS');
    assert.equal(matchesCardMerchantGroup('UBER EATS', 'UBER'), false);
    assert.equal(matchesCardMerchantGroup('UBER ONE', 'UBER'), false);
    for (const [key, group] of groups) assert.equal(matchesCardMerchantGroup(key, group), true);
  });

  it('names a group by its most frequent original name, then the shortest', () => {
    const groups = groupCardMerchantKeys(['FOURTH COFFEE', 'FOURTH COFFEE SEATTLE']);
    const names = cardMerchantDisplayNames([
      { key: 'FOURTH COFFEE SEATTLE', name: 'FOURTH COFFEE #114 SEATTLE WA' },
      { key: 'FOURTH COFFEE SEATTLE', name: 'FOURTH COFFEE #114 SEATTLE WA' },
      { key: 'FOURTH COFFEE', name: 'Fourth Coffee' },
      { key: 'FOURTH COFFEE', name: 'Fourth Coffee' },
      { key: 'FOURTH COFFEE', name: 'Fourth Coffee' },
    ], groups);
    assert.deepEqual([...names], [['FOURTH COFFEE', 'Fourth Coffee']]);
  });

  it('gives each key a root of its own, the group it would join beside that root', () => {
    const cases: Array<[string, string]> = [
      ['FOURTH COFFEE SEATTLE', 'FOURTH COFFEE'],
      ['FOURTH COFFEE NEW YORK', 'FOURTH COFFEE'],
      ['FOURTH COFFEE RETURN', 'FOURTH COFFEE'],
      ['FOURTH COFFEE', 'FOURTH COFFEE'],
      // Only a complete recognized suffix, never a shared word prefix, a short key or a bare city.
      ['FOURTH COFFEE SAMPLE SHOP', 'FOURTH COFFEE SAMPLE SHOP'],
      ['ABC SEATTLE', 'ABC SEATTLE'],
      ['THE SEATTLE', 'THE SEATTLE'],
      ['SEATTLE', 'SEATTLE'],
      // Families come first: a store's city and an online name join the brand.
      ['TARGET SEATTLE', 'TARGET'],
      ['TARGET.COM', 'TARGET'],
      ['UBER EATS', 'UBER EATS'],
    ];
    for (const [key, root] of cases) {
      assert.equal(cardMerchantGroupRoot(key), root, key);
      assert.equal(cardMerchantGroupRoot(root), root, `${root} is its own root`);
      assert.equal(matchesCardMerchantGroup(key, root), true, key);
      // Beside its root, the grouping of a set agrees.
      assert.equal(groupCardMerchantKeys([root, key]).get(key), root, key);
    }
    // Without the shorter key in a set, the set's grouping keeps the longer one; the root does not need it.
    assert.equal(groupCardMerchantKeys(['FOURTH COFFEE SEATTLE']).get('FOURTH COFFEE SEATTLE'), 'FOURTH COFFEE SEATTLE');
  });
});

/**
 * The grouping as it was before its roots were indexed: every root, in the order found, asked whether it accepts the
 * key. The oracle the indexed grouping must agree with, entry for entry and in the same order. Its merchant family is
 * private to the module; a key on its own, with no root to join, is grouped under it, in both.
 */
function groupByAskingEveryRoot(keys: Iterable<string>): Map<string, string> {
  const merchantFamilyKey = (key: string) => groupCardMerchantKeys([key]).get(key)!;
  const unique = [...new Set(keys)].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const groups = new Map<string, string>();
  const roots: string[] = [];
  for (const key of unique) {
    const family = merchantFamilyKey(key);
    const root = roots.find((candidate) => matchesCardMerchantGroup(family, candidate));
    groups.set(key, root ?? family);
    if (!root && isCardMerchantGroupRoot(family)) roots.push(family);
  }
  return groups;
}

function assertGroupedAsBefore(keys: readonly string[], label: string): void {
  const before = [...groupByAskingEveryRoot(keys)];
  const now = [...groupCardMerchantKeys(keys)];
  assert.equal(now.length, before.length, label);
  const at = now.findIndex(([key, group], index) => key !== before[index][0] || group !== before[index][1]);
  assert.equal(at, -1, `${label}: ${JSON.stringify(now[at])} where asking every root gave ${JSON.stringify(before[at])}`);
}

/** A seeded generator (mulberry32), so a failing trial runs again the same. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Synthetic merchant names, and the shapes of key the grouping rules turn on.
const NAMES = ['FOURTH COFFEE', 'NORTHWIND GROCER', 'CONTOSO', 'FABRIKAM OUTLET', 'PROSEWARE BISTRO', 'SAMPLE TOOLS', 'WIDE WORLD',
  'TAILSPIN TOYS', 'COHO WINERY', 'ALPINE SKI HOUSE', 'THE SAMPLE SHOP', 'LITWARE'];
/** Shorter than a group root may be. */
const SHORT = ['ABC', 'XY', 'Q', 'THE', '7-11', 'A1'];
/** The confirmed merchant families' prefixes and names. */
const FAMILIES = ['TARGET', 'TARGET.COM', 'WALMART', 'WALMART.COM', 'WAL-MART', 'BEST BUY', 'MICRO CENTER', 'MICRO ELECTRONICS',
  'MICRO ELECTRO', 'GREAT WALL SUPERMARKET', 'GREAT WALL SUPER MARKET', 'GREAT WALL SUPERMARK', 'GREAT WALL SU', 'HYATT', 'UBER',
  'UBER EATS', 'UBER ONE', 'UBER TRIP', 'PARK CITY MOUNTAIN', 'SAKS DIRECT', 'LAZ PARKING', 'US TREASURY', 'CIRCLE NOODLE'];
/** Recognized descriptor suffixes, multi-word cities among them. */
const SUFFIXES = ['SEATTLE', 'DULUTH', 'ATLANTA', 'NEW YORK', 'JOHNS CREEK', 'SAN FRANCISCO', 'LOS ANGELES', 'SAN JOSE', 'LAS VEGAS',
  'SAN ANTONIO', 'RETURN'];
/** Words that look like suffixes and are not. */
const NOT_SUFFIXES = ['SAN MATEO', 'BALTIMORE', 'YORK', 'CREEK', 'JOSE', 'RETURNS', 'ONLINE', 'STORE', 'GA'];
/** Never a merchant on their own. */
const FILLER = ['APLPAY', 'APPLE PAY', 'PAYPAL', 'STORE', 'ONLINE', 'PAYMENT', 'THANK YOU', 'SQ'];

function syntheticKey(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const suffixed = (head: string): string => {
    const roll = random();
    if (roll < 0.3) return head;
    if (roll < 0.65) return `${head} ${pick(SUFFIXES)}`;
    if (roll < 0.8) return `${head} ${pick(SUFFIXES)} ${pick(SUFFIXES)}`;
    return `${head} ${pick(NOT_SUFFIXES)}`;
  };
  switch (Math.floor(random() * 9)) {
    case 0:
    case 1: return suffixed(pick(NAMES));
    case 2: return suffixed(pick(FAMILIES));
    // A truncated name joined directly to its city, as some issuers print it.
    case 3: return `${pick(FAMILIES)}${pick(SUFFIXES)}`;
    case 4: return suffixed(pick(SHORT));
    case 5: return suffixed(random() < 0.5 ? pick(FILLER) : `${pick(FILLER)} ${pick(NAMES)}`);
    case 6: return pick([...SUFFIXES, ...NOT_SUFFIXES]);
    // A word-extension, never a recognized suffix.
    case 7: return suffixed(`${pick(NAMES)}${pick(['HOUSE', 'S', 'X'])}`);
    // A descriptor as an issuer prints it, as a key.
    default: return cardMerchantKey(`${pick(['', 'SQ *', 'TST* ', 'AplPay '])}${pick(NAMES)} #${10 + Math.floor(random() * 900)} ${pick(SUFFIXES)} GA`);
  }
}

describe('indexed merchant grouping', () => {
  it('groups suffix, family, short-key and filler edge cases exactly as asking every root did', () => {
    const edges = [
      '', ' ', 'THE', 'THE SEATTLE', 'THE SAMPLE SHOP', 'THE SAMPLE SHOP SEATTLE', 'ABC', 'ABC SEATTLE', 'ABC RETURN', 'ABCD',
      'ABCD SEATTLE', 'ABCD NEW YORK', 'ABCD JOHNS CREEK', 'ABCD JOHNS CREEK RETURN', 'ABCD RETURN', 'ABCD RETURN SEATTLE',
      'ABCD SAN MATEO', 'ABCD YORK', 'ABCD CREEK', 'ABCDE', 'ABCDNEW YORK', 'SEATTLE', 'NEW YORK', 'JOHNS CREEK', 'X NEW YORK', 'RETURN',
      'X RETURN', 'SEATTLE RETURN', 'STORE', 'STORE SEATTLE', 'APLPAY', 'APLPAY SEATTLE', 'APLPAY FOURTH COFFEE', 'FOURTH COFFEE',
      'FOURTH COFFEE SEATTLE', 'FOURTH COFFEEHOUSE', 'FOURTH COFFEE SAMPLE SHOP SEATTLE', 'TARGET', 'TARGET.COM', 'TARGET SEATTLE',
      'TARGET.COM SEATTLE', 'TARGETSEATTLE', 'WAL-MART', 'WALMART.COM', 'WALMART ATLANTA', 'MICRO ELECTRONICS', 'MICRO ELECTRODULUTH',
      'MICRO CENTER DULUTH', 'GREAT WALL SU', 'GREAT WALL SUDULUTH', 'GREAT WALL SUPERMARKETDULUTH', 'GREAT WALL SUPER MARKET RETURN',
      'HYATT', 'HYATTSEATTLE', 'HYATT SAMPLE SEATTLE', 'UBER', 'UBER TRIP', 'UBER TRIP SEATTLE', 'UBER SEATTLE', 'UBER EATS',
      'UBER EATS SEATTLE', 'UBER ONE', 'UBER ONE RETURN',
    ];
    assertGroupedAsBefore(edges, 'all edge cases');
    for (const a of edges) for (const b of edges) assertGroupedAsBefore([a, b], `${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  });

  it('groups random sets of synthetic keys exactly as asking every root did', () => {
    for (let trial = 1; trial <= 300; trial += 1) {
      const random = randomFrom(trial);
      const keys = Array.from({ length: 1 + Math.floor(random() * 80) }, () => syntheticKey(random));
      assertGroupedAsBefore(keys, `trial ${trial}`);
    }
    const random = randomFrom(20261024);
    assertGroupedAsBefore(Array.from({ length: 3_000 }, () => syntheticKey(random)), 'a household-sized set');
  });

  it('finds the same first root whatever order the keys come in', () => {
    // Spellings of one family, roots with suffixed and twice-suffixed keys, and roots of one length in name order.
    const keys = ['WALMART ATLANTA', 'WAL-MART', 'WALMART.COM', 'WALMART', 'WAL-MART RETURN', 'TARGET SEATTLE', 'TARGET.COM', 'TARGET',
      'FOURTH COFFEE SEATTLE RETURN', 'FOURTH COFFEE RETURN', 'FOURTH COFFEE SEATTLE', 'FOURTH COFFEE', 'ABCE SEATTLE', 'ABCD SEATTLE',
      'ABCE', 'ABCD', 'ABCD NEW YORK', 'ABCDNEW YORK', 'GREAT WALL SU', 'GREAT WALL SUDULUTH', 'GREAT WALL SUPERMARKET RETURN'];
    const expected = [...groupByAskingEveryRoot(keys)];
    const random = randomFrom(7);
    for (let n = 0; n < 50; n += 1) {
      const order = shuffled(keys, random);
      assert.deepEqual([...groupCardMerchantKeys(order)], expected, order.join(' | '));
    }
    const groups = groupCardMerchantKeys(keys);
    assert.deepEqual(['WAL-MART', 'WALMART.COM', 'WALMART ATLANTA', 'WAL-MART RETURN'].map((key) => groups.get(key)), Array(4).fill('WALMART'));
    assert.deepEqual(['ABCD SEATTLE', 'ABCE SEATTLE', 'ABCD NEW YORK'].map((key) => groups.get(key)), ['ABCD', 'ABCE', 'ABCD']);
    assert.equal(groups.get('FOURTH COFFEE SEATTLE'), 'FOURTH COFFEE');
    // A suffix after a suffix: its head joined a group, so it leads none, and the longer key stays its own.
    assert.equal(groups.get('FOURTH COFFEE SEATTLE RETURN'), 'FOURTH COFFEE SEATTLE RETURN');
    assert.equal(groups.get('GREAT WALL SUDULUTH'), 'GREAT WALL SUPERMARKET');
    assert.equal(groups.get('ABCDNEW YORK'), 'ABCDNEW YORK');
  });
});

describe('remembered merchant answers', () => {
  it('are kept for the exact text asked about', () => {
    // Case and width matter to these functions, so they matter to what is remembered.
    assert.equal(isCardMerchantKey('SEATTLE'), false);
    assert.equal(isCardMerchantKey('seattle'), true);
    assert.equal(isCardMerchantKey('ＳＥＡＴＴＬＥ'), true);
    assert.equal(cardMerchantKey('ＳＥＡＴＴＬＥ'), 'SEATTLE');
    assert.equal(isCardMerchantGroupRoot('ABC'), false);
    assert.equal(isCardMerchantGroupRoot('ABCD'), true);
    assert.equal(cardMerchantGroupRoot('FOURTH COFFEE SEATTLE'), 'FOURTH COFFEE');
    assert.equal(cardMerchantGroupRoot('fourth coffee seattle'), 'fourth coffee seattle');
  });

  it('are the same once the memory has filled up and started over', () => {
    const texts = ['SQ *FOURTH COFFEE #12 SEATTLE WA', 'FOURTH COFFEE SEATTLE', 'FOURTH COFFEE', 'TARGET.COM', 'GREAT WALL SUDULUTH',
      'THE', 'NEW YORK', 'APLPAY', 'X RETURN', 'ABCD JOHNS CREEK'];
    const answers = () => ({
      each: texts.map((text) => [cardMerchantKey(text), isCardMerchantKey(text), isCardMerchantGroupRoot(text), cardMerchantGroupRoot(text)]),
      groups: [...groupCardMerchantKeys(texts)],
    });
    const first = answers();
    // More texts than any remembered function keeps (20,000), each asked of all of them.
    for (let n = 0; n < 25_000; n += 1) {
      const text = `SAMPLE MERCHANT ${n.toString(36).toUpperCase()} SEATTLE`;
      cardMerchantKey(text);
      isCardMerchantKey(text);
      cardMerchantGroupRoot(text);
    }
    assert.deepEqual(answers(), first);
  });

  it('are given for texts longer than any kept, every time', () => {
    const name = `SAMPLE ${'VERY '.repeat(60)}LONG CAFE`;
    const raw = `SQ *${name} #12 SEATTLE WA`;
    assert.ok(raw.length > 256);
    for (let n = 0; n < 2; n += 1) {
      assert.equal(cardMerchantKey(raw), `${name} SEATTLE`);
      assert.equal(cardMerchantKey(`${name} SEATTLE`), `${name} SEATTLE`);
      assert.equal(isCardMerchantKey(`${name} SEATTLE`), true);
      assert.equal(cardMerchantGroupRoot(`${name} SEATTLE`), name);
    }
  });
});
