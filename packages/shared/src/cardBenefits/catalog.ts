import type { BenefitCadence, BenefitCatalog, BenefitCategory, BenefitDefinition, BenefitTracking, BenefitValue } from './types.js';

/**
 * Holdr's benefits catalog: the card products Holdr's household holds, and
 * the recurring value each gives back per period. Holdr's own, written from
 * the issuers' public benefit pages (each product's `sourceUrl`), as of
 * October 2026; `verify: true` marks a figure or rule not confirmed there,
 * which the Benefits tab shows as unverified. Spend-gated bonuses (a credit
 * after $X of purchases) and per-stay property credits are left out.
 *
 * Amounts are cents. A benefit that changed keeps its id, one version per
 * span of validity (versions of an id share their cadence); one whose
 * cadence changed gets a new id. Statement-credit patterns are matched,
 * case-insensitively, against the description and merchant of posted
 * credits; they name the benefit and say credit, so a merchant's refund is
 * not mistaken for one.
 *
 * The Benefits tab's By benefit view treats benefits of different products
 * with the same name as one benefit. `compareAs` gives a benefit another name
 * to be compared under where its own would mix programs: each hotel
 * program's free night, the Brilliant's own dining credit. It lists them by
 * category (CATEGORY_BY_ID).
 *
 * Bump `version` whenever a product, amount, period, pattern, comparison name or category changes.
 */

const usd = (dollars: number, byStartMonth?: Record<number, number>): BenefitValue => ({
  unit: 'usd',
  amountMinor: Math.round(dollars * 100),
  ...(byStartMonth
    ? { byStartMonth: Object.fromEntries(Object.entries(byStartMonth).map(([month, value]) => [month, Math.round(value * 100)])) }
    : {}),
});
const count = (noun: string, value = 1): BenefitValue => ({ unit: 'count', count: value, noun });

const MONTHLY: BenefitCadence = { every: 'month', basis: 'calendar' };
const QUARTERLY: BenefitCadence = { every: 'quarter', basis: 'calendar' };
const HALF_YEARLY: BenefitCadence = { every: 'half', basis: 'calendar' };
const CALENDAR_YEAR: BenefitCadence = { every: 'year', basis: 'calendar' };
const CARDMEMBER_YEAR: BenefitCadence = { every: 'year', basis: 'cardmember' };
const EVERY_FOUR_YEARS: BenefitCadence = { every: 'years', months: 48 };

const credit = (...patterns: string[]): BenefitTracking => ({ method: 'statement-credit', patterns });
/** A credit whose line names it without saying credit: its name alone counts on adjustment rows only. */
const creditOrAdjustment = (keyword: string): BenefitTracking => ({
  method: 'statement-credit', patterns: [named(keyword)], adjustmentPatterns: [`\\b(?:${keyword})\\b`],
});
const PARTNER_BALANCE: BenefitTracking = { method: 'manual', reason: 'partner-balance' };
const CERTIFICATE: BenefitTracking = { method: 'manual', reason: 'certificate' };
const DISCOUNT: BenefitTracking = { method: 'manual', reason: 'discount' };
const ACTIVATION: BenefitTracking = { method: 'manual', reason: 'activation' };
/** Chase posts its credits without wording Holdr can tell apart from refunds (production counts, Oct 2026). */
const NOT_ITEMIZED: BenefitTracking = { method: 'manual', reason: 'not-itemized' };

/** "<keyword> … credit" or "credit … <keyword>". */
const named = (keyword: string) => `\\b(?:${keyword})\\b.*\\b(?:credit|reimb\\w*)\\b|\\b(?:credit|reimb\\w*)\\b.*\\b(?:${keyword})\\b`;

const TRUSTED_TRAVELER = credit(named('global\\s*entry|tsa\\s*pre\\W?\\s*check|tsa\\s*pre|precheck|pre\\s*check|nexus'));
const AMEX_TRAVEL_HOTEL = credit(named('hotel|fhr|fine\\s+hotels|hotel\\s+collection'), '\\b(?:amex|american\\s+express)\\s+travel\\b.*\\bcredit\\b');
const AIRLINE_FEE: BenefitTracking = {
  method: 'statement-credit', patterns: [named('airline')], adjustmentPatterns: ['\\bairline\\s+(?:fee|incidental)\\b'],
};
const CLEAR = credit(named('clear'));

const globalEntry = (overrides: Partial<BenefitDefinition> = {}): BenefitDefinition => ({
  id: 'global-entry-tsa',
  name: 'Global Entry or TSA PreCheck fee',
  kind: 'credit',
  value: usd(120),
  cadence: EVERY_FOUR_YEARS,
  enrollment: false,
  tracking: TRUSTED_TRAVELER,
  note: 'The application fee, charged to the card; once every four years.',
  ...overrides,
});

/** CLEAR+ tracks CLEAR's own price: $199 until mid-2025, $209 to mid-2026, then $219. */
const clearVersions = (latest: 'to-219' | 'stays-209'): BenefitDefinition[] => {
  const base = { id: 'clear', name: 'CLEAR+ credit', kind: 'credit' as const, cadence: CALENDAR_YEAR, enrollment: false, tracking: CLEAR };
  return latest === 'to-219'
    ? [
      { ...base, value: usd(199), validUntil: '2025-06-30' },
      { ...base, value: usd(209), validFrom: '2025-07-01', validUntil: '2026-06-30' },
      { ...base, value: usd(219), validFrom: '2026-07-01', verify: true },
    ]
    : [
      { ...base, value: usd(199), validUntil: '2025-06-30' },
      { ...base, value: usd(209), validFrom: '2025-07-01' },
    ];
};

/** A free night certificate, compared with its own hotel program's only: another program's night is another benefit. */
const freeNight = (note: string, compareAs: string): BenefitDefinition => ({
  id: 'free-night', name: 'Free night award', kind: 'certificate', value: count('free night'), cadence: CARDMEMBER_YEAR,
  enrollment: false, tracking: CERTIFICATE, note, compareAs,
});

/**
 * Where the By benefit view lists each benefit, by its id: the sections card
 * communities sort credits into (airlines and other travel, hotels, dining,
 * shopping and lifestyle, business). An id names the same kind of benefit on
 * every product (a `hotel` credit is a hotel credit whoever issues it), so one
 * list covers the catalog; the catalog test holds every benefit to one.
 */
const CATEGORY_BY_ID: Readonly<Record<string, BenefitCategory>> = {
  'airline-fee': 'travel', airline: 'travel', flight: 'travel', 'aa-vacations': 'travel', 'inflight-admirals': 'travel',
  clear: 'travel', 'global-entry-tsa': 'travel', rideshare: 'travel', lyft: 'travel', 'avis-budget': 'travel', blacklane: 'travel',
  'companion-certificate': 'travel', 'checked-bags': 'travel', 'flight-discount': 'travel',
  hotel: 'hotel', 'hotel-annual': 'hotel', resort: 'hotel', hilton: 'hotel', 'delta-stays': 'hotel', 'free-night': 'hotel',
  'omni-night': 'hotel',
  'uber-cash': 'dining', 'uber-one': 'dining', dining: 'dining', resy: 'dining', dunkin: 'dining', doordash: 'dining', grubhub: 'dining',
  'digital-entertainment': 'shopping', lululemon: 'shopping', saks: 'shopping', 'walmart-plus': 'shopping', equinox: 'shopping',
  oura: 'shopping', splurge: 'shopping', 'reward-certificate': 'shopping', 'quarterly-categories': 'shopping',
  dell: 'business', 'dell-half': 'business', adobe: 'business', chatgpt: 'business', indeed: 'business', wireless: 'business',
  squarespace: 'business', 'flexible-business': 'business',
};

/** The catalog with each benefit's category (CATEGORY_BY_ID). */
function categorized(catalog: BenefitCatalog): BenefitCatalog {
  return {
    ...catalog,
    products: catalog.products.map((product) => ({
      ...product,
      benefits: product.benefits.map((benefit) => ({ ...benefit, category: CATEGORY_BY_ID[benefit.id] })),
    })),
  };
}

export const BENEFITS_CATALOG: BenefitCatalog = categorized({
  version: '2026.10.2',
  products: [
    // ------------------------------------------------------------------ American Express (specific names first)
    {
      id: 'amex-business-platinum',
      issuer: 'amex',
      name: 'The Business Platinum Card from American Express',
      shortName: 'Business Platinum',
      nicknamePatterns: ['\\bbusiness\\s+platinum\\b', '\\bplatinum\\s+business\\b'],
      annualFeeMinor: 89_500,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/business/business-credit-cards/american-express-business-platinum-credit-card-amex/',
      benefits: [
        {
          id: 'hotel', name: 'Hotel credit (FHR / The Hotel Collection)', kind: 'credit', value: usd(300), cadence: HALF_YEARLY,
          enrollment: false, tracking: AMEX_TRAVEL_HOTEL, validFrom: '2025-09-18',
          note: 'Prepaid Fine Hotels + Resorts or The Hotel Collection bookings through Amex Travel.',
        },
        {
          id: 'dell', name: 'Dell Technologies credit', kind: 'credit', value: usd(150), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('dell')), validFrom: '2025-07-01', verify: true,
          note: 'U.S. purchases directly from Dell Technologies. The extra $1,000 after $5,000 of Dell purchases is not counted here.',
        },
        {
          id: 'dell-half', name: 'Dell Technologies credit (until mid-2025)', kind: 'credit', value: usd(200), cadence: HALF_YEARLY,
          enrollment: true, tracking: credit(named('dell')), validUntil: '2025-06-30', verify: true,
        },
        {
          id: 'adobe', name: 'Adobe credit', kind: 'credit', value: usd(250), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('adobe')), validFrom: '2025-09-18', note: 'After $600 or more of Adobe purchases in the year.',
        },
        {
          id: 'chatgpt', name: 'ChatGPT Business credit', kind: 'credit', value: usd(300), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('chatgpt|openai')), validFrom: '2025-09-18',
        },
        {
          id: 'indeed', name: 'Indeed credit', kind: 'credit', value: usd(90), cadence: QUARTERLY, enrollment: true,
          tracking: credit(named('indeed')), validFrom: '2025-09-18',
        },
        {
          id: 'wireless', name: 'Wireless credit', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: true,
          tracking: credit(named('wireless')), verify: true, note: 'U.S. wireless telephone service bought directly from a provider.',
        },
        {
          id: 'hilton', name: 'Hilton credit', kind: 'credit', value: usd(50), cadence: QUARTERLY, enrollment: true,
          tracking: credit(named('hilton')), note: 'Purchases directly with Hilton properties.',
        },
        ...clearVersions('stays-209'),
        {
          id: 'airline-fee', name: 'Airline fee credit', kind: 'credit', value: usd(200), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: AIRLINE_FEE, note: 'Incidental fees with the one airline selected for the year; can take up to 8 weeks to post.',
        },
        globalEntry(),
      ],
    },
    {
      id: 'amex-platinum',
      issuer: 'amex',
      name: 'The Platinum Card from American Express',
      shortName: 'Platinum',
      nicknamePatterns: ['\\bplatinum\\b'],
      annualFeeMinor: 89_500,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/card/platinum/',
      benefits: [
        {
          id: 'hotel', name: 'Hotel credit (FHR / The Hotel Collection)', kind: 'credit', value: usd(300), cadence: HALF_YEARLY,
          enrollment: false, tracking: AMEX_TRAVEL_HOTEL, validFrom: '2025-09-18',
          note: 'Prepaid Fine Hotels + Resorts or The Hotel Collection bookings through Amex Travel.',
        },
        {
          id: 'hotel-annual', name: 'Hotel credit (until Sept 2025)', kind: 'credit', value: usd(200), cadence: CALENDAR_YEAR,
          enrollment: false, tracking: AMEX_TRAVEL_HOTEL, validUntil: '2025-09-17',
        },
        {
          id: 'uber-cash', name: 'Uber Cash', kind: 'credit', value: usd(15, { 12: 35 }), cadence: MONTHLY, enrollment: false,
          tracking: PARTNER_BALANCE, note: '$15 a month, $35 in December, in the Uber app with this card saved; never a statement credit.',
        },
        {
          id: 'uber-one', name: 'Uber One credit', kind: 'credit', value: usd(120), cadence: CALENDAR_YEAR, enrollment: false,
          tracking: credit(named('uber\\s*one')), validFrom: '2025-09-18', note: 'An Uber One membership billed to the card.',
        },
        {
          id: 'digital-entertainment', name: 'Digital entertainment credit', kind: 'credit', value: usd(20), cadence: MONTHLY,
          enrollment: true, tracking: creditOrAdjustment('digital\\s*entertainment'), validUntil: '2025-09-17',
        },
        {
          id: 'digital-entertainment', name: 'Digital entertainment credit', kind: 'credit', value: usd(25), cadence: MONTHLY,
          enrollment: true, tracking: creditOrAdjustment('digital\\s*entertainment'), validFrom: '2025-09-18',
        },
        {
          id: 'resy', name: 'Resy credit', kind: 'credit', value: usd(100), cadence: QUARTERLY, enrollment: true,
          tracking: credit(named('resy')), validFrom: '2025-09-18', note: 'U.S. Resy restaurants.',
        },
        {
          id: 'lululemon', name: 'lululemon credit', kind: 'credit', value: usd(75), cadence: QUARTERLY, enrollment: true,
          tracking: credit(named('lululemon')), validFrom: '2025-09-18', verify: true,
        },
        {
          id: 'saks', name: 'Saks Fifth Avenue credit', kind: 'credit', value: usd(50), cadence: HALF_YEARLY, enrollment: true,
          tracking: credit(named('saks')),
        },
        {
          id: 'walmart-plus', name: 'Walmart+ credit', kind: 'credit', value: usd(12.95), cadence: MONTHLY, enrollment: false,
          tracking: creditOrAdjustment('walmart'), note: 'One monthly Walmart+ membership (plus tax).',
        },
        {
          id: 'equinox', name: 'Equinox credit', kind: 'credit', value: usd(300), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('equinox')), verify: true,
        },
        {
          id: 'oura', name: 'Oura Ring credit', kind: 'credit', value: usd(200), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('oura')), verify: true,
        },
        ...clearVersions('to-219'),
        {
          id: 'airline-fee', name: 'Airline fee credit', kind: 'credit', value: usd(200), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: AIRLINE_FEE, note: 'Incidental fees with the one airline selected for the year; can take up to 8 weeks to post.',
        },
        globalEntry(),
      ],
    },
    {
      id: 'amex-delta-reserve-business',
      issuer: 'amex',
      name: 'Delta SkyMiles Reserve Business American Express Card',
      shortName: 'Delta Reserve Business',
      nicknamePatterns: ['^(?=.*\\bdelta\\b)(?=.*\\breserve\\b)(?=.*\\bbusiness\\b)'],
      annualFeeMinor: 65_000,
      sourceUrl: 'https://www.americanexpress.com/en-us/business/credit-cards/delta-skymiles-reserve/',
      benefits: [
        {
          id: 'delta-stays', name: 'Delta Stays credit', kind: 'credit', value: usd(250), cadence: CALENDAR_YEAR, enrollment: false,
          tracking: creditOrAdjustment('delta\\s*stays'), note: 'Prepaid hotels and vacation rentals booked through Delta Stays.',
        },
        {
          id: 'resy', name: 'Resy credit', kind: 'credit', value: usd(20), cadence: MONTHLY, enrollment: true,
          tracking: credit(named('resy')), note: 'U.S. Resy restaurants.',
        },
        {
          id: 'rideshare', name: 'Rideshare credit', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: true,
          tracking: credit(named('rideshare')), note: 'U.S. rideshare purchases.',
        },
        {
          id: 'companion-certificate', name: 'Companion Certificate', kind: 'certificate', value: count('certificate'),
          cadence: CARDMEMBER_YEAR, enrollment: false, tracking: CERTIFICATE,
          note: 'In the SkyMiles account after each renewal; taxes and fees still apply.',
        },
        globalEntry(),
      ],
    },
    {
      id: 'amex-delta-gold-business',
      issuer: 'amex',
      name: 'Delta SkyMiles Gold Business American Express Card',
      shortName: 'Delta Gold Business',
      nicknamePatterns: ['^(?=.*\\bdelta\\b)(?=.*\\bgold\\b)(?=.*\\bbusiness\\b)'],
      annualFeeMinor: 15_000,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/business/business-credit-cards/delta-skymiles-gold/',
      benefits: [
        {
          id: 'delta-stays', name: 'Delta Stays credit', kind: 'credit', value: usd(150), cadence: CALENDAR_YEAR, enrollment: false,
          tracking: creditOrAdjustment('delta\\s*stays'), note: 'Prepaid hotels and vacation rentals booked through Delta Stays.',
        },
        {
          id: 'rideshare', name: 'Rideshare credit', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: true,
          tracking: credit(named('rideshare')), note: 'U.S. rideshare purchases; starts after the card\'s first renewal.',
        },
      ],
    },
    {
      id: 'amex-business-gold',
      issuer: 'amex',
      name: 'American Express Business Gold Card',
      shortName: 'Business Gold',
      nicknamePatterns: ['\\bbusiness\\s+gold\\b', '\\bgold\\s+business\\b'],
      annualFeeMinor: 37_500,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/business/business-credit-cards/american-express-business-gold-card-amex/',
      benefits: [
        {
          id: 'flexible-business', name: 'Flexible business credit', kind: 'credit', value: usd(20), cadence: MONTHLY, enrollment: true,
          tracking: credit(named('flexible\\s*business|fedex|grubhub|office\\s*supply')),
          note: 'FedEx, Grubhub and U.S. office supply stores; shared by all cards on the account.',
        },
        {
          id: 'walmart-plus', name: 'Walmart+ credit', kind: 'credit', value: usd(12.95), cadence: MONTHLY, enrollment: false,
          tracking: creditOrAdjustment('walmart'), note: 'One monthly Walmart+ membership (plus tax).',
        },
        {
          id: 'squarespace', name: 'Squarespace credit', kind: 'credit', value: usd(150), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('squarespace')), validFrom: '2025-10-01', verify: true,
        },
        {
          id: 'chatgpt', name: 'ChatGPT Business credit', kind: 'credit', value: usd(300), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('chatgpt|openai')), validFrom: '2026-05-01', verify: true,
        },
      ],
    },
    {
      id: 'amex-gold',
      issuer: 'amex',
      name: 'American Express Gold Card',
      shortName: 'Gold',
      nicknamePatterns: ['\\bgold\\b'],
      annualFeeMinor: 32_500,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/card/gold-card/',
      benefits: [
        {
          id: 'uber-cash', name: 'Uber Cash', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: false,
          tracking: PARTNER_BALANCE, note: 'In the Uber app with this card saved; never a statement credit.',
        },
        {
          id: 'dining', name: 'Dining credit', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: true,
          tracking: credit('dining\\s*credit', named('grubhub|cheesecake|five\\s*guys|buffalo\\s*wild|wonder|goldbelly|wine\\.com')),
          note: 'Grubhub, Buffalo Wild Wings, Five Guys, The Cheesecake Factory and Wonder.',
        },
        {
          id: 'resy', name: 'Resy credit', kind: 'credit', value: usd(50), cadence: HALF_YEARLY, enrollment: true,
          tracking: credit(named('resy')), note: 'U.S. Resy restaurants.',
        },
        {
          id: 'dunkin', name: 'Dunkin\' credit', kind: 'credit', value: usd(7), cadence: MONTHLY, enrollment: true,
          tracking: credit(named('dunkin\\W?')),
        },
      ],
    },
    {
      id: 'amex-hilton-aspire',
      issuer: 'amex',
      name: 'Hilton Honors American Express Aspire Card',
      shortName: 'Hilton Aspire',
      nicknamePatterns: ['\\baspire\\b'],
      annualFeeMinor: 55_000,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/card/hilton-honors-aspire/',
      benefits: [
        {
          id: 'resort', name: 'Hilton resort credit', kind: 'credit', value: usd(200), cadence: HALF_YEARLY, enrollment: false,
          tracking: credit(named('resort')), note: 'Purchases at participating Hilton Resorts.',
        },
        {
          id: 'flight', name: 'Flight credit', kind: 'credit', value: usd(50), cadence: QUARTERLY, enrollment: false,
          tracking: credit(named('flight|airline')), note: 'Flights bought directly from an airline or through Amex Travel.',
        },
        ...clearVersions('to-219'),
        freeNight('In the Hilton Honors account after each renewal.', 'Hilton free night'),
      ],
    },
    {
      id: 'amex-hilton-business',
      issuer: 'amex',
      name: 'The Hilton Honors American Express Business Card',
      shortName: 'Hilton Business',
      nicknamePatterns: ['^(?=.*\\bhilton\\b)(?=.*\\bbusiness\\b)'],
      annualFeeMinor: 19_500,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/business/business-credit-cards/hilton-honors/',
      benefits: [
        {
          id: 'hilton', name: 'Hilton credit', kind: 'credit', value: usd(60), cadence: QUARTERLY, enrollment: false,
          tracking: credit(named('hilton')), note: 'Purchases directly with Hilton properties.',
        },
      ],
    },
    {
      id: 'amex-marriott-brilliant',
      issuer: 'amex',
      name: 'Marriott Bonvoy Brilliant American Express Card',
      shortName: 'Marriott Brilliant',
      nicknamePatterns: ['\\bbrilliant\\b'],
      annualFeeMinor: 65_000,
      sourceUrl: 'https://www.americanexpress.com/us/credit-cards/card/marriott-bonvoy-brilliant/',
      benefits: [
        {
          id: 'dining', name: 'Dining credit', kind: 'credit', value: usd(25), cadence: MONTHLY, enrollment: false,
          tracking: credit(named('dining|restaurant')), note: 'Restaurants worldwide.', compareAs: 'Brilliant dining credit',
        },
        freeNight('In the Marriott Bonvoy account after each renewal (up to 85,000 points).', 'Marriott free night'),
        globalEntry(),
      ],
    },
    // ------------------------------------------------------------------ Chase
    {
      id: 'chase-sapphire-preferred',
      issuer: 'chase',
      name: 'Chase Sapphire Preferred Card',
      shortName: 'Sapphire Preferred',
      nicknamePatterns: ['\\bsapphire\\s+preferred\\b'],
      annualFeeMinor: 9_500,
      sourceUrl: 'https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred',
      benefits: [
        {
          id: 'hotel', name: 'Chase Travel hotel credit', kind: 'credit', value: usd(50), cadence: CARDMEMBER_YEAR, enrollment: false,
          tracking: NOT_ITEMIZED, validUntil: '2026-06-14', note: 'Hotel stays booked through Chase Travel.',
        },
        {
          id: 'hotel', name: 'Chase Travel hotel credit', kind: 'credit', value: usd(100), cadence: CARDMEMBER_YEAR, enrollment: false,
          tracking: NOT_ITEMIZED, validFrom: '2026-06-15', note: 'Hotel stays booked through Chase Travel.',
        },
        {
          id: 'doordash', name: 'DoorDash promo', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: true,
          tracking: DISCOUNT, validUntil: '2029-12-31', verify: true,
          note: 'With the complimentary DashPass activated; taken off a DoorDash order.',
        },
        globalEntry({ validFrom: '2026-06-15', tracking: NOT_ITEMIZED }),
      ],
    },
    {
      id: 'chase-freedom-unlimited',
      issuer: 'chase',
      name: 'Chase Freedom Unlimited',
      shortName: 'Freedom Unlimited',
      nicknamePatterns: ['\\bfreedom\\s+unlimited\\b'],
      annualFeeMinor: null,
      sourceUrl: 'https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited',
      benefits: [
        {
          id: 'doordash', name: 'DoorDash promo', kind: 'credit', value: usd(10), cadence: QUARTERLY, enrollment: true,
          tracking: DISCOUNT, validUntil: '2027-12-31', note: 'With DashPass activated; taken off a DoorDash order.',
        },
      ],
    },
    {
      id: 'chase-freedom',
      issuer: 'chase',
      name: 'Chase Freedom',
      shortName: 'Freedom',
      nicknamePatterns: ['\\bfreedom\\b(?!\\s+(?:unlimited|flex|rise))'],
      annualFeeMinor: null,
      sourceUrl: 'https://creditcards.chase.com/cash-back-credit-cards/freedom',
      benefits: [
        {
          id: 'quarterly-categories', name: '5% quarterly categories', kind: 'activation', value: count('activation'),
          cadence: QUARTERLY, enrollment: true, tracking: ACTIVATION,
          note: 'Activate each quarter: 5% back on up to $1,500 in that quarter\'s categories.',
        },
        {
          id: 'doordash', name: 'DoorDash promo', kind: 'credit', value: usd(10), cadence: QUARTERLY, enrollment: true,
          tracking: DISCOUNT, validUntil: '2027-12-31', verify: true, note: 'With DashPass activated; taken off a DoorDash order.',
        },
      ],
    },
    {
      id: 'chase-prime-visa',
      issuer: 'chase',
      name: 'Prime Visa',
      shortName: 'Prime Visa',
      nicknamePatterns: ['\\bprime\\b'],
      annualFeeMinor: null,
      sourceUrl: 'https://creditcards.chase.com/cash-back-credit-cards/amazon-prime-rewards',
      benefits: [],
    },
    {
      id: 'chase-world-of-hyatt',
      issuer: 'chase',
      name: 'World of Hyatt Credit Card',
      shortName: 'World of Hyatt',
      nicknamePatterns: ['\\bhyatt\\b'],
      annualFeeMinor: 9_500,
      sourceUrl: 'https://creditcards.chase.com/travel-credit-cards/world-of-hyatt-credit-card',
      benefits: [freeNight('A Category 1–4 night after each account anniversary.', 'Hyatt free night')],
    },
    {
      id: 'chase-marriott-boundless',
      issuer: 'chase',
      name: 'Marriott Bonvoy Boundless Credit Card',
      shortName: 'Marriott Boundless',
      nicknamePatterns: ['\\bboundless\\b'],
      annualFeeMinor: 9_500,
      sourceUrl: 'https://creditcards.chase.com/travel-credit-cards/marriott-bonvoy/boundless',
      benefits: [
        freeNight('After each account anniversary (up to 35,000 points).', 'Marriott free night'),
        {
          id: 'airline', name: 'Airline credit', kind: 'credit', value: usd(50), cadence: HALF_YEARLY, enrollment: false,
          tracking: NOT_ITEMIZED, validFrom: '2026-07-01', validUntil: '2027-06-30', verify: true,
          note: 'A limited-time offer: $250 of airline purchases from Jun 4 to Dec 31, 2026, then from Jan 1 to Jun 30, 2027.',
        },
      ],
    },
    {
      id: 'chase-ihg-select',
      issuer: 'chase',
      name: 'IHG One Rewards Select Credit Card',
      shortName: 'IHG Select',
      nicknamePatterns: ['^(?=.*\\bihg\\b)(?=.*\\bselect\\b)'],
      annualFeeMinor: 4_900,
      feeVerify: true,
      sourceUrl: 'https://media.chase.com/news/ihg-premier-select-card-portfolio-updates',
      benefits: [freeNight(
        'After each account anniversary (up to 40,000 points). The fee rises to $99 at renewals from late 2026.', 'IHG free night',
      )],
    },
    {
      id: 'chase-united-gateway',
      issuer: 'chase',
      name: 'United Gateway Card',
      shortName: 'United Gateway',
      nicknamePatterns: ['\\bgateway\\b'],
      annualFeeMinor: null,
      sourceUrl: 'https://www.chase.com/personal/credit-cards/united/mileageplus-gateway',
      benefits: [
        {
          id: 'checked-bags', name: 'Free checked bag certificates', kind: 'certificate', value: count('certificate', 2),
          cadence: CALENDAR_YEAR, enrollment: false, tracking: CERTIFICATE, verify: true,
        },
      ],
    },
    // ------------------------------------------------------------------ Citi
    {
      id: 'citi-aadvantage-executive',
      issuer: 'citi',
      name: 'Citi / AAdvantage Executive World Legend Mastercard',
      shortName: 'AAdvantage Executive',
      nicknamePatterns: ['\\bexecutive\\b'],
      annualFeeMinor: 69_500,
      feeVerify: true,
      sourceUrl: 'https://creditcards.aa.com/credit-cards/citi-executive-card-american-airlines-direct/',
      benefits: [
        {
          id: 'aa-vacations', name: 'American Airlines Vacations credit', kind: 'credit', value: usd(250), cadence: HALF_YEARLY,
          enrollment: false, tracking: credit(named('aa\\s*vacations|american\\s*airlines\\s*vacations')), validFrom: '2026-08-23',
        },
        {
          id: 'inflight-admirals', name: 'Inflight and Admirals Club credit', kind: 'credit', value: usd(100), cadence: CALENDAR_YEAR,
          enrollment: false, tracking: credit(named('inflight|admirals')), validFrom: '2026-08-23',
        },
        {
          id: 'lyft', name: 'Lyft credit', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: false,
          tracking: credit(named('lyft')), validUntil: '2026-08-22', note: 'After three eligible Lyft rides in the month.',
        },
        {
          id: 'lyft', name: 'Lyft credit', kind: 'credit', value: usd(15), cadence: MONTHLY, enrollment: false,
          tracking: credit(named('lyft')), validFrom: '2026-08-23', note: 'After three eligible Lyft rides in the month.',
        },
        {
          id: 'grubhub', name: 'Grubhub credit (until Aug 2026)', kind: 'credit', value: usd(10), cadence: MONTHLY, enrollment: false,
          tracking: credit(named('grubhub')), validUntil: '2026-08-22', verify: true,
        },
        {
          id: 'avis-budget', name: 'Avis or Budget rental credit', kind: 'credit', value: usd(120), cadence: CALENDAR_YEAR,
          enrollment: false, tracking: credit(named('avis|budget')), note: 'Prepaid Avis or Budget car rentals.',
        },
        {
          id: 'omni-night', name: 'Omni Hotels free night', kind: 'certificate', value: count('free night'), cadence: CALENDAR_YEAR,
          enrollment: true, tracking: CERTIFICATE, validFrom: '2026-08-23',
        },
        globalEntry(),
      ],
    },
    {
      id: 'citi-aadvantage-platinum-select',
      issuer: 'citi',
      name: 'Citi / AAdvantage Platinum Select World Elite Mastercard',
      shortName: 'AAdvantage Platinum Select',
      nicknamePatterns: ['\\bplatinum\\s+select\\b'],
      annualFeeMinor: 9_900,
      sourceUrl: 'https://www.citi.com/credit-cards/credit-card-miles/aadvantage-platinum-select-benefits',
      benefits: [
        {
          id: 'flight-discount', name: '$125 American Airlines flight discount', kind: 'certificate', value: count('discount'),
          cadence: CARDMEMBER_YEAR, enrollment: false, tracking: CERTIFICATE,
          note: 'After $20,000 of purchases in a cardmember year and renewal; good for 12 months on aa.com.',
        },
      ],
    },
    {
      id: 'citi-aadvantage-mileup',
      issuer: 'citi',
      name: 'American Airlines AAdvantage MileUp Card',
      shortName: 'AAdvantage MileUp',
      nicknamePatterns: ['\\bmile\\s*up\\b'],
      annualFeeMinor: null,
      sourceUrl: 'https://creditcards.aa.com/credit-cards/citi-mileup-card-american-airlines-direct/',
      benefits: [],
    },
    {
      id: 'citi-costco-anywhere',
      issuer: 'citi',
      name: 'Costco Anywhere Visa Card by Citi',
      shortName: 'Costco Anywhere',
      nicknamePatterns: ['\\bcostco\\b'],
      annualFeeMinor: null,
      sourceUrl: 'https://www.citi.com/credit-cards/credit-card-rewards/earn-cash-back-with-costco-credit-card',
      benefits: [
        {
          id: 'reward-certificate', name: 'Annual reward certificate', kind: 'certificate', value: count('certificate'),
          cadence: CALENDAR_YEAR, enrollment: false, tracking: CERTIFICATE,
          note: 'Comes with the February statement; redeem at a U.S. Costco warehouse by Dec 31.',
        },
      ],
    },
    {
      id: 'citi-strata-elite',
      issuer: 'citi',
      name: 'Citi Strata Elite Card',
      shortName: 'Strata Elite',
      nicknamePatterns: ['\\bstrata\\s+elite\\b'],
      annualFeeMinor: 59_500,
      sourceUrl: 'https://www.citi.com/credit-cards/citi-strata-elite-credit-card',
      benefits: [
        {
          id: 'hotel', name: 'Hotel credit', kind: 'credit', value: usd(300), cadence: CALENDAR_YEAR, enrollment: false,
          tracking: credit(named('hotel')), note: 'Two or more nights booked through Citi Travel.',
        },
        {
          id: 'splurge', name: 'Splurge credit', kind: 'credit', value: usd(200), cadence: CALENDAR_YEAR, enrollment: true,
          tracking: credit(named('splurge')), note: 'Up to two chosen brands.',
        },
        {
          id: 'blacklane', name: 'Blacklane credit', kind: 'credit', value: usd(100), cadence: HALF_YEARLY, enrollment: false,
          tracking: credit(named('blacklane')),
        },
        globalEntry(),
      ],
    },
    {
      id: 'citi-strata-premier',
      issuer: 'citi',
      name: 'Citi Strata Premier Card',
      shortName: 'Strata Premier',
      nicknamePatterns: ['\\bstrata\\s+premier\\b', '\\bpremier\\b'],
      annualFeeMinor: 9_500,
      sourceUrl: 'https://www.citi.com/credit-cards/credit-card-rewards/citi-strata-premier-benefits',
      benefits: [
        {
          id: 'hotel', name: 'Hotel credit', kind: 'credit', value: usd(100), cadence: CALENDAR_YEAR, enrollment: false,
          tracking: credit(named('hotel')), note: 'Once a year, on a stay of $500 or more booked through Citi Travel.',
        },
      ],
    },
    {
      id: 'citi-strata',
      issuer: 'citi',
      name: 'Citi Strata Card',
      shortName: 'Strata',
      nicknamePatterns: ['\\bstrata\\b'],
      annualFeeMinor: null,
      sourceUrl: 'https://www.citi.com/credit-cards/citi-strata-credit-card',
      benefits: [],
    },
  ],
});
