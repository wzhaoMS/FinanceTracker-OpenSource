import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BENEFITS_CATALOG } from './catalog.js';
import { BENEFIT_CATEGORIES, benefitCatalogProblems, benefitProductById, matchBenefitProduct } from './products.js';
import { matchBenefitCredit } from './report.js';
import type { BenefitCatalog, BenefitCategory, BenefitCreditRow, BenefitDefinition } from './types.js';

const row = (description: string, patch: Partial<BenefitCreditRow> = {}): BenefitCreditRow => ({
  id: 'card-txn-sample', cardAccountId: 'card-acct-sample', date: '2026-10-05', amountMinor: -1000, kind: 'adjustment',
  description, merchant: null, ...patch,
});

describe('the benefits catalog', () => {
  it('is sound', () => {
    assert.deepEqual(benefitCatalogProblems(BENEFITS_CATALOG), []);
  });

  it('maps issuer product names, as card nicknames carry them, to products', () => {
    const cases: Array<[string, string, string | null]> = [
      ['amex', 'Business Platinum', 'amex-business-platinum'],
      ['amex', 'The Business Platinum Card®', 'amex-business-platinum'],
      ['amex', 'Platinum', 'amex-platinum'],
      ['amex', 'Business Gold', 'amex-business-gold'],
      ['amex', 'Delta Gold Business', 'amex-delta-gold-business'],
      ['amex', 'Delta SkyMiles® Reserve Business', 'amex-delta-reserve-business'],
      ['amex', 'American Express Gold', 'amex-gold'],
      ['amex', 'Hilton Honors Aspire', 'amex-hilton-aspire'],
      ['amex', 'Hilton Honors Business', 'amex-hilton-business'],
      ['amex', 'Marriott Bonvoy Brilliant', 'amex-marriott-brilliant'],
      ['chase', 'Hyatt Visa', 'chase-world-of-hyatt'],
      ['chase', 'Marriott Boundless', 'chase-marriott-boundless'],
      ['chase', 'Freedom', 'chase-freedom'],
      ['chase', 'Freedom Unlimited', 'chase-freedom-unlimited'],
      ['chase', 'IHG Select', 'chase-ihg-select'],
      ['chase', 'Prime Visa', 'chase-prime-visa'],
      ['chase', 'Sapphire Preferred', 'chase-sapphire-preferred'],
      ['chase', 'United Gateway', 'chase-united-gateway'],
      ['citi', 'AAdvantage Executive World Legend', 'citi-aadvantage-executive'],
      ['citi', 'AAdvantage MileUp', 'citi-aadvantage-mileup'],
      ['citi', 'AAdvantage Platinum Select', 'citi-aadvantage-platinum-select'],
      ['citi', 'Costco Anywhere Visa', 'citi-costco-anywhere'],
      ['citi', 'Strata', 'citi-strata'],
      ['citi', 'Strata Premier', 'citi-strata-premier'],
      ['citi', 'Strata Elite', 'citi-strata-elite'],
      // The issuer decides: a Citi "Platinum" is not an Amex Platinum.
      ['citi', 'Platinum', null],
      ['amex', 'Sapphire Preferred', null],
      ['chase', 'Everyday Card', null],
      ['amex', '', null],
    ];
    for (const [issuer, nickname, expected] of cases) {
      assert.equal(matchBenefitProduct(BENEFITS_CATALOG, issuer, nickname)?.id ?? null, expected, `${issuer} ${nickname}`);
    }
  });

  it('reads synthetic statement credits as the benefits they name', () => {
    const product = (id: string) => benefitProductById(BENEFITS_CATALOG, id)!;
    const cases: Array<[string, string, string | null]> = [
      ['amex-platinum', 'SAMPLE DIGITAL ENTERTAINMENT CREDIT', 'digital-entertainment'],
      ['amex-platinum', 'SAMPLE AIRLINE FEE REIMBURSEMENT', 'airline-fee'],
      ['amex-platinum', 'SAMPLE SAKS CREDIT', 'saks'],
      ['amex-platinum', 'SAMPLE GLOBAL ENTRY FEE CREDIT', 'global-entry-tsa'],
      ['amex-platinum', 'SAMPLE STORE REFUND', null],
      ['amex-business-platinum', 'SAMPLE DELL CREDIT', 'dell'],
      ['amex-business-platinum', 'SAMPLE WIRELESS CREDIT', 'wireless'],
      ['amex-gold', 'SAMPLE DUNKIN\' CREDIT', 'dunkin'],
      ['amex-hilton-aspire', 'SAMPLE RESORT CREDIT', 'resort'],
      ['citi-aadvantage-executive', 'SAMPLE LYFT CREDIT', 'lyft'],
    ];
    for (const [id, description, expected] of cases) {
      assert.equal(matchBenefitCredit(product(id), row(description)), expected, `${id} ${description}`);
    }
    // A merchant refund without credit wording is not a benefit.
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE SAKS', { kind: 'refund' })), null);
    assert.equal(matchBenefitCredit(product('amex-delta-reserve-business'), row('SAMPLE DELTA STAYS RETURN', { kind: 'refund' })), null);
    assert.equal(matchBenefitCredit(product('amex-delta-reserve-business'), row('SAMPLE DELTA STAYS CREDIT', { kind: 'refund' })), 'delta-stays');
    assert.equal(matchBenefitCredit(product('amex-delta-reserve-business'), row('SAMPLE DELTA STAYS')), 'delta-stays');
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE AIRLINE FEE', { kind: 'refund' })), null);
    // Walmart+ credits name Walmart without saying credit: enough on an adjustment row only.
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE WALMART+ MEMBERSHIP')), 'walmart-plus');
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE WALMART+ MEMBERSHIP', { kind: 'refund' })), null);
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE WALMART+ CREDIT', { kind: 'refund' })), 'walmart-plus');
    // Credits that changed: the version in force on the row's date.
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE HOTEL CREDIT', { date: '2025-03-01' })), 'hotel-annual');
    assert.equal(matchBenefitCredit(product('amex-platinum'), row('SAMPLE HOTEL CREDIT', { date: '2025-10-01' })), 'hotel');
    assert.equal(matchBenefitCredit(product('citi-aadvantage-executive'), row('SAMPLE GRUBHUB CREDIT', { date: '2026-09-01' })), null);
  });

  it('tracks Chase credits by hand: their statement lines carry no wording Holdr can match', () => {
    for (const product of BENEFITS_CATALOG.products.filter((entry) => entry.issuer === 'chase')) {
      for (const benefit of product.benefits) assert.equal(benefit.tracking.method, 'manual', `${product.id}/${benefit.id}`);
    }
  });

  it('finds what is wrong with a catalog', () => {
    const broken: BenefitCatalog = {
      version: '2026-10',
      products: [{
        id: 'amex-broken', issuer: 'amex', name: 'Broken', shortName: 'Broken', nicknamePatterns: ['('], annualFeeMinor: 1.5,
        sourceUrl: 'http://example.com/', benefits: [
          {
            id: 'a', name: 'A', kind: 'credit', value: { unit: 'usd', amountMinor: 0 }, cadence: { every: 'month', basis: 'calendar' },
            enrollment: false, tracking: { method: 'statement-credit', patterns: [] }, validUntil: '2026-06-30',
          },
          {
            id: 'a', name: 'A', kind: 'credit', value: { unit: 'usd', amountMinor: 100 }, cadence: { every: 'quarter', basis: 'calendar' },
            enrollment: false, tracking: { method: 'manual', reason: 'partner-balance' }, validFrom: '2026-06-01',
          },
        ],
      }],
    };
    const problems = benefitCatalogProblems(broken);
    for (const expected of [
      'version must look like YYYY.MM.N',
      'amex-broken: sourceUrl must be the issuer\'s https page',
      'amex-broken: annual fee must be whole cents',
      'amex-broken: nickname pattern does not compile',
      'amex-broken/a: amount must be a positive whole number of cents',
      'amex-broken/a: statement credits need patterns',
      'amex-broken/a: versions must share cadence and unit',
      'amex-broken/a: versions must not overlap',
    ]) {
      assert.ok(problems.includes(expected), `${expected}\n${problems.join('\n')}`);
    }
  });

  it('holds a comparison name to one every version of a benefit shares, without surrounding spaces', () => {
    const version = (patch: Partial<BenefitDefinition>): BenefitDefinition => ({
      id: 'night', name: 'Free night', kind: 'certificate', value: { unit: 'count', count: 1, noun: 'free night' },
      cadence: { every: 'year', basis: 'cardmember' }, enrollment: false, tracking: { method: 'manual', reason: 'certificate' }, ...patch,
    });
    const catalog = (benefits: BenefitDefinition[]): BenefitCatalog => ({
      version: '2026.10.2',
      products: [{
        id: 'amex-sample', issuer: 'amex', name: 'Sample', shortName: 'Sample', nicknamePatterns: ['\\bsample\\b'], annualFeeMinor: null,
        sourceUrl: 'https://www.example.com/sample', benefits,
      }],
    });
    assert.deepEqual(benefitCatalogProblems(catalog([
      version({ compareAs: 'Sample free night', validUntil: '2025-12-31' }), version({ compareAs: 'Sample free night', validFrom: '2026-01-01' }),
    ])), []);
    assert.deepEqual(benefitCatalogProblems(catalog([
      version({ compareAs: 'Sample free night', validUntil: '2025-12-31' }), version({ validFrom: '2026-01-01' }),
    ])), ['amex-sample/night: versions must share compareAs']);
    assert.deepEqual(benefitCatalogProblems(catalog([version({ compareAs: ' ' })])), [
      'amex-sample/night: compareAs must be a name without surrounding spaces',
    ]);
  });

  it('lists every benefit in a category, which its versions share', () => {
    for (const product of BENEFITS_CATALOG.products) {
      for (const benefit of product.benefits) {
        assert.ok(benefit.category && BENEFIT_CATEGORIES.includes(benefit.category), `${product.id}/${benefit.id}`);
      }
    }
    const product = (benefits: BenefitDefinition[]): BenefitCatalog => ({
      version: '2026.10.2',
      products: [{
        id: 'amex-sample', issuer: 'amex', name: 'Sample', shortName: 'Sample', nicknamePatterns: ['\\bsample\\b'], annualFeeMinor: null,
        sourceUrl: 'https://www.example.com/sample', benefits,
      }],
    });
    const version = (patch: Partial<BenefitDefinition>): BenefitDefinition => ({
      id: 'perk', name: 'Perk credit', kind: 'credit', value: { unit: 'usd', amountMinor: 1_000 }, cadence: { every: 'year', basis: 'calendar' },
      enrollment: false, tracking: { method: 'manual', reason: 'discount' }, ...patch,
    });
    assert.deepEqual(benefitCatalogProblems(product([
      version({ category: 'dining', validUntil: '2025-12-31' }), version({ category: 'shopping', validFrom: '2026-01-01' }),
    ])), ['amex-sample/perk: versions must share category']);
    assert.deepEqual(benefitCatalogProblems(product([version({ category: 'groceries' as BenefitCategory })])), [
      'amex-sample/perk: category must be one of travel, hotel, dining, shopping, business',
    ]);
  });

  it('compares each hotel program\'s free night apart from the others\'', () => {
    const names = BENEFITS_CATALOG.products.flatMap((product) => product.benefits
      .filter((benefit) => benefit.id === 'free-night')
      .map((benefit) => [product.id, benefit.compareAs]));
    assert.deepEqual(names, [
      ['amex-hilton-aspire', 'Hilton free night'],
      ['amex-marriott-brilliant', 'Marriott free night'],
      ['chase-world-of-hyatt', 'Hyatt free night'],
      ['chase-marriott-boundless', 'Marriott free night'],
      ['chase-ihg-select', 'IHG free night'],
    ]);
  });
});
