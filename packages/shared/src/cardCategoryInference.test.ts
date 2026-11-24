import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_CATEGORY_RULES,
  CARD_CATEGORY_RULES_RETARGETED,
  CARD_CATEGORY_RULES_VERSION,
  CARD_TAX_CATEGORY,
  amazonCardChargeKind,
  buildCardCategoryInference,
  cardCategoryInferable,
  cardCategoryInferenceEligible,
  cardCategoryInferenceMarker,
  cardCategoryRowSource,
  cardCategoryRule,
  cardCategoryRuleOverIssuer,
  cardCategoryRulesBeforeRetarget,
  countCardCategoryRowSources,
  evaluateCardCategoryInference,
  type CardCategoryInference,
  type CardCategoryInferenceRow,
} from './cardCategoryInference.js';
import { classifyCardKind } from './cardKinds.js';
import { effectiveCardCategory, summarizeCardSpending } from './cardSpending.js';
import type { CardTransactionKind } from './types.js';

// Synthetic rows only: made-up merchants for the household's history, and widely known chain names only where a
// generic rule is meant to recognize them.
describe('canonical Amazon descriptor cohort', () => {
  it('shares the reviewed Amazon/AWS patterns but never guesses from merchant alone or substrings', () => {
    for (const description of ['AMAZON SYNTHETIC', 'amzn mktp synthetic', 'AMAZON.COM']) {
      assert.equal(amazonCardChargeKind({ description }), 'itemizable');
    }
    for (const description of ['SYNTHETIC SHOP', 'AMAZONIAN', 'AMZNFOO', 'AMAZON WEB SERVICES', 'AMAZON AWS']) {
      assert.equal(amazonCardChargeKind({ description, merchant: 'AMAZON' }), null);
    }
  });
  it('separates only the closed digital/subscription descriptors, not arbitrary Prime purchases', () => {
    for (const description of ['AMAZON PRIME MEMBERSHIP', 'AMZN PRIME*VIDEO', 'AMAZON KINDLE',
      'AMZN DIGITAL', 'AMAZON MUSIC']) assert.equal(amazonCardChargeKind({ description }), 'not-itemizable');
    assert.equal(amazonCardChargeKind({ description: 'AMAZON PRIME SYNTHETIC RETAIL' }), 'itemizable');
    assert.equal(amazonCardChargeKind({ description: 'AMAZON MUSICAL SYNTHETIC' }), 'itemizable');
  });
  // Synthetic references (AB12CD34E) and a fictional merchant (FABRIKAM SAMPLE) in the forms issuers print.
  it('separates a delivery tip by its leading AMAZON TIPS tokens, whatever follows', () => {
    for (const description of ['AMAZON TIPS*AB12CD34E', 'Amazon Tips*AB12CD34E', 'AMZN TIPS*AB12CD34E',
      '  AMAZON  TIPS *AB12CD34E', 'AMAZON TIPS AB12CD34E', 'AMAZON TIPS*AB12CD34E AMZN.COM/BILL WA']) {
      assert.equal(amazonCardChargeKind({ description }), 'not-itemizable', description);
    }
  });
  it('separates a Prime fee by its reference straight after AMAZON PRIME', () => {
    for (const description of ['AMAZON PRIME*AB12CD34E', 'Amazon Prime*AB12CD34E Amzn.com/bill WA', 'AMZN PRIME*AB12CD34E',
      'AMAZON PRIME *AB12CD34E']) assert.equal(amazonCardChargeKind({ description }), 'not-itemizable', description);
  });
  it('separates Amazon Pay paying another merchant (AMZ*) among descriptors the shared rule calls Amazon, adding none', () => {
    for (const description of ['AMZ*AB12CD34E FABRIKAM SAMPLE AMZN.COM/BILL WA', 'amz *AB12CD34E fabrikam sample pay.amazon.com']) {
      assert.equal(amazonCardChargeKind({ description }), 'not-itemizable', description);
    }
    // No AMAZON or AMZN word: not an Amazon descriptor at all, as before, and AWS stays out whatever leads it.
    assert.equal(amazonCardChargeKind({ description: 'AMZ*AB12CD34E FABRIKAM SAMPLE', merchant: 'AMAZON' }), null);
    assert.equal(amazonCardChargeKind({ description: 'AMZ*AB12CD34E AWS AMZN.COM/BILL WA' }), null);
  });
  it('keeps every order-backed form itemizable: truncated lines, and the new rules\' tokens anywhere but leading', () => {
    for (const description of [
      'AMAZON GROCE*AB12CD34E', 'AMAZON MARK*AB12CD34E AMZN.COM/BILL WA', 'AMAZON MKTP US*AB12CD34E', 'AMAZON MKTPL*AB12CD34E',
      'AMZN Mktp US*AB12CD34E', 'AMZN MKTP US*AB12CD34E AMZN.COM/BILL WA', 'Amazon.com*AB12CD34E',
      'AMAZON.COM*AB12CD34E AMZN.COM/BILL WA', 'AMAZON.COM', 'AMZN', 'AMAZON RETA*AB12CD34E', 'AMZN*AB12CD34E',
      'AMAZON TIPSY SAMPLE', 'AMZN MKTP US*TIPS12345', 'AMZN MKTP US*AB12CD34E AMAZON TIPS',
      'AMAZON PRIME SAMPLE*AB12CD34E', 'AMAZON PRIMESAMPLE*AB12CD34E', 'AMAZON.COM*AB12CD34E AMAZON PRIME*',
      'AMAZON MARK*AB12CD34E AMZ*FABRIKAM SAMPLE',
    ]) assert.equal(amazonCardChargeKind({ description }), 'itemizable', description);
  });
  it('leaves the reviewed amazon category rule alone: the separated forms are still filed as Amazon purchases', () => {
    const model = buildCardCategoryInference([]);
    for (const description of ['AMAZON TIPS*AB12CD34E', 'AMAZON PRIME*AB12CD34E', 'AMZ*AB12CD34E FABRIKAM SAMPLE AMZN.COM/BILL WA']) {
      assert.deepEqual(model.infer({ status: 'posted', kind: 'purchase', description }),
        { category: 'Merchandise & Supplies-Internet Purchase', basis: 'rule', rule: 'amazon' }, description);
    }
  });
});
const GROCERIES = 'Merchandise & Supplies-Groceries';
const DINING = 'Restaurant-Restaurant';
const BOOKS = 'Merchandise & Supplies-Book Stores';

type Row = CardCategoryInferenceRow;
const row = (description: string, extra: Partial<Row> = {}): Row => ({ status: 'posted', kind: 'purchase', description, ...extra });
const issued = (description: string, issuerCategory: string, extra: Partial<Row> = {}): Row => row(description, { issuerCategory, ...extra });

describe('which rows inference fills', () => {
  it('only spending rows with neither the owner\'s own nor an issuer category', () => {
    assert.equal(cardCategoryInferenceEligible({ kind: 'purchase' }), true);
    for (const kind of ['refund', 'fee', 'interest', 'adjustment'] as const) assert.equal(cardCategoryInferenceEligible({ kind }), true, kind);
    for (const kind of ['payment', 'other'] as const) assert.equal(cardCategoryInferenceEligible({ kind }), false, kind);
    assert.equal(cardCategoryInferenceEligible({ kind: 'purchase', userCategory: 'Mine' }), false);
    assert.equal(cardCategoryInferenceEligible({ kind: 'purchase', issuerCategory: GROCERIES }), false);
    const model = buildCardCategoryInference([issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES)]);
    assert.equal(model.infer(row('NORTHWIND GROCERY', { userCategory: 'Mine' })), null);
    assert.equal(model.infer(row('NORTHWIND GROCERY', { issuerCategory: DINING })), null);
    assert.equal(model.infer(row('NORTHWIND GROCERY', { kind: 'payment' })), null);
  });
});

describe('merchant history', () => {
  it('lends the category a merchant\'s issuer-categorized rows agree on, with how many there are', () => {
    const model = buildCardCategoryInference([
      issued('NORTHWIND GROCERY 0042 SEATTLE WA', GROCERIES),
      issued('NORTHWIND GROCERY', GROCERIES, { merchant: 'Northwind Grocery' }),
    ]);
    // A descriptor with a store number, a recognized city and a state joins the merchant's group.
    assert.deepEqual(model.infer(row('NORTHWIND GROCERY #12 SEATTLE WA')), {
      category: GROCERIES, basis: 'merchant-history', observations: 2, agreeing: 2,
    });
    // A pending charge and a refund at the merchant are filed the same way.
    assert.equal(model.infer(row('NORTHWIND GROCERY', { status: 'pending' }))?.category, GROCERIES);
    assert.equal(model.infer(row('NORTHWIND GROCERY', { kind: 'refund' }))?.category, GROCERIES);
    // Another merchant that only shares a word does not.
    assert.equal(model.infer(row('NORTHWIND OUTFITTERS')), null);
  });

  it('needs two observations and four in five of them agreeing', () => {
    const history = (categories: string[]) => buildCardCategoryInference(categories.map((category) => issued('PROSEWARE MARKET', category)));
    assert.equal(history([GROCERIES]).infer(row('PROSEWARE MARKET')), null);
    assert.deepEqual(history([GROCERIES, GROCERIES, GROCERIES, GROCERIES, DINING]).infer(row('PROSEWARE MARKET')), {
      category: GROCERIES, basis: 'merchant-history', observations: 5, agreeing: 4,
    });
    assert.equal(history([GROCERIES, GROCERIES, GROCERIES, DINING]).infer(row('PROSEWARE MARKET')), null);
    assert.equal(history([GROCERIES, DINING]).infer(row('PROSEWARE MARKET')), null);
  });

  it('learns only from posted spending rows with an issuer category, never from the owner\'s own', () => {
    const model = buildCardCategoryInference([
      issued('FABRIKAM BOOKS', BOOKS, { status: 'pending' }),
      issued('FABRIKAM BOOKS', BOOKS, { status: 'removed' }),
      issued('FABRIKAM BOOKS', BOOKS, { kind: 'payment' }),
      row('FABRIKAM BOOKS', { userCategory: 'Reading' }),
      row('FABRIKAM BOOKS', { userCategory: 'Reading' }),
    ]);
    assert.equal(model.infer(row('FABRIKAM BOOKS')), null);
  });

  it('matches the issuer\'s merchant name or the descriptor, the merchant name first', () => {
    const model = buildCardCategoryInference([
      issued('LITWARE 0042', BOOKS, { merchant: 'Fabrikam Books' }),
      issued('LITWARE 0043', BOOKS, { merchant: 'Fabrikam Books' }),
      issued('LITWARE CAFE', DINING),
      issued('LITWARE CAFE', DINING),
    ]);
    // A descriptor-only row (as card statement files have) matches the merchant names' group.
    assert.equal(model.infer(row('FABRIKAM BOOKS SEATTLE WA'))?.category, BOOKS);
    assert.equal(model.infer(row('LITWARE CAFE #9'))?.category, DINING);
    assert.equal(model.infer(row('LITWARE CAFE', { merchant: 'Fabrikam Books' }))?.category, BOOKS);
  });

  it('is the same model whatever order the rows come in', () => {
    const rows = [
      issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', DINING),
      issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES), row('NORTHWIND GROCERY'),
    ];
    const ask = row('NORTHWIND GROCERY');
    assert.deepEqual(buildCardCategoryInference(rows).infer(ask), buildCardCategoryInference([...rows].reverse()).infer(ask));
  });

  it('keeps what it learned inside: the model has the rule version and infer, nothing else', () => {
    const model = buildCardCategoryInference([issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES)]);
    assert.deepEqual(Object.keys(model).sort(), ['infer', 'rules']);
    assert.equal(model.rules, CARD_CATEGORY_RULES_VERSION);
    assert.equal(JSON.stringify(model), JSON.stringify({ rules: CARD_CATEGORY_RULES_VERSION }));
  });
});

describe('reviewed rules', () => {
  const none = buildCardCategoryInference([]);
  const ruleOf = (description: string, extra: Partial<Row> = {}) => {
    const inference = none.infer(row(description, extra));
    return inference?.basis === 'rule' ? inference.rule : inference;
  };

  it('are generic, uniquely named and in the issuers\' category names', () => {
    const ids = CARD_CATEGORY_RULES.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const rule of CARD_CATEGORY_RULES) {
      assert.match(rule.id, /^[a-z]+(?:-[a-z]+)*$/);
      assert.ok(rule.label.length > 0);
      // A rule over the issuer's category names a plain category of Holdr's own: no issuer's taxonomy has one for it.
      assert.match(rule.category, rule.overIssuer ? /^[A-Z][\p{L} ]+$/u : /^[A-Z][\p{L} &]+-[A-Z][\p{L} &]+$/u, rule.id);
      assert.ok(rule.kinds || rule.pattern, rule.id);
      if (rule.overIssuer) assert.ok(rule.pattern, `${rule.id} recognizes its charges by their text`);
      assert.equal(rule.pattern?.flags.includes('g') ?? false, false, `${rule.id} must not keep state between tests`);
      assert.equal(rule.not?.flags.includes('g') ?? false, false, `${rule.id}'s exclusion must not keep state between tests`);
      assert.equal(cardCategoryRule(rule.id), rule);
    }
    assert.match(CARD_CATEGORY_RULES_VERSION, /^\d{4}\.\d{1,2}\.\d+$/);
  });

  it('recognize card fees and interest by kind, before any merchant, and a credit naming one as the charge it gives back', () => {
    const model = buildCardCategoryInference([issued('PROSEWARE BANK', GROCERIES), issued('PROSEWARE BANK', GROCERIES)]);
    const FEES = 'Fees & Adjustments-Fees & Adjustments';
    assert.deepEqual(model.infer(row('PROSEWARE BANK', { kind: 'fee' })), { category: FEES, basis: 'rule', rule: 'card-fee' });
    assert.equal(ruleOf('PURCHASE INTEREST CHARGE', { kind: 'interest' }), 'interest-charge');
    // A credit whose own words, less the ones that give it back, are a card's fee or interest to the import classifier is
    // filed as that fee or that interest, before the merchant's history too: by the words of either text.
    assert.deepEqual(model.infer(row('PROSEWARE BANK', { kind: 'adjustment', merchant: 'Late fee reversal' })),
      { category: FEES, basis: 'rule', rule: 'card-fee' });
    for (const [description, rule] of [
      ['NSF PAYMENT FEE REFUND', 'card-fee'], ['Returned payment fee reversal', 'card-fee'], ['ANNUAL FEES CREDIT', 'card-fee'],
      ['REVERSAL OF LATE FEE', 'card-fee'], ['PAYMENT REVERSAL FEE REFUND', 'card-fee'], ['REVERSED PAYMENT FEE REFUND', 'card-fee'],
      ['INTEREST CHARGE REVERSAL', 'interest-charge'], ['FINANCE CHARGE ADJ', 'interest-charge'],
    ] as const) {
      assert.equal(ruleOf(description, { kind: 'adjustment' }), rule, description);
    }
    // A refund too: the classifier makes a fee's credit that repeats the fee's words, with no word giving it back, a refund,
    // and the credit of an annual membership (a fee with no FEE word) one as well.
    assert.equal(ruleOf('LATE PAYMENT FEE', { kind: 'refund' }), 'card-fee');
    assert.equal(ruleOf('ANNUAL MEMBERSHIP FEE', { kind: 'refund' }), 'card-fee');
    assert.equal(ruleOf('ANNUAL MEMBERSHIP REVERSAL', { kind: 'refund' }), 'card-fee');
    // A credit for a merchant's fee is filed as that merchant's charge, not under the card's fees: a parking operator's
    // fee with parking, and a fee its words don't make a card's nowhere, as the charge would be.
    assert.equal(ruleOf('SAMPLE PARKING FEE REFUND', { kind: 'adjustment' }), 'parking');
    assert.equal(ruleOf('SAMPLE PARKING FEE', { kind: 'refund' }), 'parking');
    assert.equal(ruleOf('SAMPLE BANK*FEE WAIVED', { kind: 'adjustment' }), null);
    // A credit that names no fee or interest, such as a card benefit's statement credit, goes by its own words: merchant
    // history, then the merchant rules. So does one whose word only contains FEE.
    assert.equal(model.infer(row('PROSEWARE BANK', { kind: 'adjustment' }))?.category, GROCERIES);
    for (const description of ['SAMPLE DIGITAL ENTERTAINMENT CREDIT', 'SAMPLE FEED STORE CREDIT']) {
      assert.equal(ruleOf(description, { kind: 'adjustment' }), null, description);
    }
    assert.equal(ruleOf('NORTHWIND COFFEE CREDIT', { kind: 'adjustment' }), 'cafe-word');
  });

  it('recognize widely known merchants and plain words, first match winning', () => {
    const cases: Array<[string, string]> = [
      ['SHELL OIL 57442118700', 'fuel-brand'],
      ['COSTCO GAS #0042', 'fuel-brand'],
      ['COSTCO WHSE #0042 SEATTLE WA', 'warehouse-club'],
      ["SAM'S CLUB #8215", 'warehouse-club'],
      ['WHOLEFDS MKT 10234', 'grocery-store'],
      ["TRADER JOE'S #123", 'grocery-store'],
      ['NORTHWIND SUPERMARKET', 'grocery-store'],
      ['AMZN Mktp US*AB12CD34E', 'amazon'],
      ['Amazon.com*AB12CD34E', 'amazon'],
      ['CVS/PHARMACY #01234', 'pharmacy'],
      ['THE HOME DEPOT #6543', 'home-improvement'],
      ["LOWE'S #1234", 'home-improvement'],
      ['BEST BUY 00012345', 'electronics-store'],
      ['DD *DOORDASH SAMPLE', 'food-delivery'],
      ['UBER *EATS HELP.UBER.COM', 'food-delivery'],
      ['STARBUCKS STORE 12345', 'coffee-chain'],
      ["MCDONALD'S F12345", 'restaurant-chain'],
      ['UBER *TRIP HELP.UBER.COM', 'rideshare-or-taxi'],
      ['LYFT *RIDE SUN 4PM', 'rideshare-or-taxi'],
      ['SAMPLE CITY PARKING 0042', 'parking'],
      ['E-ZPASS REPLENISH', 'toll'],
      ['DELTA AIR LINES 0062345678', 'airline'],
      ['SOUTHWES 5262345678', 'airline'],
      ['HOTELS.COM 123456', 'travel-site'],
      ['EXPEDIA 7234567', 'travel-site'],
      ['SAMPLE BEACH RESORT', 'hotel'],
      ['HERTZ RENT-A-CAR', 'car-rental'],
      ['PROSEWARE BISTRO', 'restaurant-word'],
      ['FOURTH COFFEE #114 SEATTLE WA', 'cafe-word'],
      ['SAMPLE CAFÉ', 'cafe-word'],
      // A restaurant word wins over a café word.
      ['SAMPLE SUSHI CAFE', 'restaurant-word'],
    ];
    for (const [description, rule] of cases) assert.equal(ruleOf(description), rule, description);
    // The merchant name counts as much as the descriptor.
    assert.equal(ruleOf('CHECKCARD 0042', { merchant: 'Sample Bakery' }), 'restaurant-word');
    // Coffee chains and cafés go to the issuer taxonomy's café subcategory, other chains and words to restaurants.
    assert.equal(none.infer(row('STARBUCKS STORE 12345'))?.category, 'Restaurant-Bar & Café');
    assert.equal(none.infer(row('SAMPLE CAFE'))?.category, 'Restaurant-Bar & Café');
    assert.equal(none.infer(row("MCDONALD'S F12345"))?.category, DINING);
  });

  it('leave alone what only looks like a known merchant', () => {
    for (const description of [
      'UBER *ONE HELP.UBER.COM', 'AMAZON WEB SERVICES', 'AWS EMEA AMAZON', 'ALAMO DRAFTHOUSE CINEMA', 'SAMPLE MOTOR SPEEDWAY',
      "SHELLY'S NAIL STUDIO", 'SHELLFISH MARKET CO', 'T-MOBILE POSTPAID', 'MARCO POLO TOURS', 'FLOWERS BY SAMPLE',
      'PHOTO SAMPLE STUDIO', 'NORTHWIND OUTFITTERS', 'SAMPLE PLUMBING LLC',
    ]) {
      assert.equal(ruleOf(description), null, description);
    }
  });

  it('use the household\'s own spelling of a category that differs only in form, and the rule\'s otherwise', () => {
    const spelled = buildCardCategoryInference([issued('SAMPLE LIMO', 'Transportation-Taxis and Coach')]);
    assert.equal(spelled.infer(row('LYFT *RIDE'))?.category, 'Transportation-Taxis and Coach');
    assert.equal(none.infer(row('LYFT *RIDE'))?.category, 'Transportation-Taxis & Coach');
  });

  it('come after merchant history: the household\'s own history of a merchant wins', () => {
    const model = buildCardCategoryInference([issued('SAMPLE PIZZA KITCHEN', BOOKS), issued('SAMPLE PIZZA KITCHEN', BOOKS)]);
    assert.equal(model.infer(row('SAMPLE PIZZA KITCHEN'))?.category, BOOKS);
    // Without enough agreement, the rule fills in.
    const unsure = buildCardCategoryInference([issued('SAMPLE PIZZA KITCHEN', BOOKS), issued('SAMPLE PIZZA KITCHEN', GROCERIES)]);
    assert.deepEqual(unsure.infer(row('SAMPLE PIZZA KITCHEN')), { category: DINING, basis: 'rule', rule: 'restaurant-word' });
  });
});

// The IRS's own words for a card payment and for its processor's fee, as issuers print them; the issuers' categories
// for them, and every other name, are synthetic.
describe('a tax paid by card', () => {
  const UTILITIES = 'Business Services-Utilities';
  const MISCELLANEOUS = 'Other-Miscellaneous';
  const TAXES: CardCategoryInference = { category: CARD_TAX_CATEGORY, basis: 'rule', rule: 'tax-payment' };
  const none = buildCardCategoryInference([]);
  const ruleOf = (inference: CardCategoryInference | null) => (inference?.basis === 'rule' ? inference.rule : null);

  it('is filed under Taxes over the issuer\'s category, whichever issuer filed it where', () => {
    for (const description of [
      'UNITED STATES TREASURY TAX PAYMENT', 'United States Treasury', 'US TREASURY TAX PYMT', 'U.S. TREASURY', 'U S TREASURY 0042',
      'SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE', 'SAMPLE COUNTY TAX PMT 0042', 'SAMPLE STATE TAX-PAYMENTS',
    ]) {
      for (const issuerCategory of [UTILITIES, MISCELLANEOUS, null]) {
        assert.deepEqual(none.infer(row(description, { issuerCategory })), TAXES, `${description} (${issuerCategory})`);
      }
    }
    // The issuer's merchant name counts as much as the descriptor.
    assert.deepEqual(none.infer(row('SAMPLE 0042', { merchant: 'US Treasury', issuerCategory: UTILITIES })), TAXES);
    // Pending, and a refund of one: filed with them.
    assert.deepEqual(none.infer(row('US TREASURY TAX PAYMENT', { status: 'pending', issuerCategory: MISCELLANEOUS })), TAXES);
    assert.deepEqual(none.infer(row('US TREASURY TAX PAYMENT', { kind: 'refund', issuerCategory: UTILITIES })), TAXES);
    // In the household's own spelling of the category, where one differs only in form.
    const spelled = buildCardCategoryInference([issued('SAMPLE CITY', 'TAXES')]);
    assert.equal(spelled.infer(row('US TREASURY TAX PAYMENT', { issuerCategory: UTILITIES }))?.category, 'TAXES');
  });

  it('leaves the owner\'s own category, a card\'s own fees and interest, transfers and look-alikes alone', () => {
    assert.equal(none.infer(row('US TREASURY TAX PAYMENT', { issuerCategory: UTILITIES, userCategory: 'Mine' })), null);
    // Whatever kind a tax payment was given, it is filed.
    for (const kind of ['fee', 'interest', 'adjustment'] as const) {
      assert.deepEqual(none.infer(row('US TREASURY TAX PAYMENT', { kind, issuerCategory: UTILITIES })), TAXES, kind);
      assert.deepEqual(none.infer(row('US TREASURY TAX PAYMENT', { kind })), TAXES, kind);
    }
    // A card's own fee or interest, and a credit naming one (the classifier's fee and interest wording): under the fee or
    // interest rule, as the charge it gives back, without a category of its own, and under the issuer's with one.
    for (const [description, kind, rule] of [
      ['CASH ADVANCE FEE US TREASURY', 'fee', 'card-fee'],
      ['SAMPLE PROCESSOR*TAX PAYMENT SERVICE FEE', 'fee', 'card-fee'],
      ['CASH ADVANCE INTEREST US TREASURY', 'interest', 'interest-charge'],
      ['CASH ADVANCE FEE REVERSAL US TREASURY', 'adjustment', 'card-fee'],
      ['CASH ADVANCE INTEREST REVERSAL US TREASURY', 'adjustment', 'interest-charge'],
      ['SAMPLE PROCESSOR*TAX PAYMENT SERVICE FEE', 'refund', 'card-fee'],
    ] as const) {
      assert.equal(ruleOf(none.infer(row(description, { kind }))), rule, description);
      assert.equal(none.infer(row(description, { kind, issuerCategory: UTILITIES })), null, description);
    }
    // Transfers, and rows not counted, are never filed.
    for (const kind of ['payment', 'other'] as const) {
      assert.equal(none.infer(row('US TREASURY TAX PAYMENT', { kind })), null, kind);
      assert.equal(none.infer(row('US TREASURY TAX PAYMENT', { kind, issuerCategory: UTILITIES })), null, kind);
    }
    for (const description of [
      'SAMPLE TREASURY WINES', 'TREASURY ISLAND SAMPLE', 'SAMPLE BUS TREASURY', 'SAMPLE TAX PREP SERVICES', 'INTUIT *TURBOTAX PMT',
      'SAMPLE VAT TAX REFUND', 'SAMPLE TAXI PAYMENT', 'SAMPLE SYNTAX PAYMENT',
    ]) {
      assert.equal(none.infer(row(description, { issuerCategory: UTILITIES })), null, description);
      assert.notEqual(ruleOf(none.infer(row(description))), 'tax-payment', description);
    }
  });

  it('files a charge and the credit giving it back together, whatever kinds the import classifier gives them', () => {
    // Each row kinded by the import classifier (cardKinds.ts), as a converter stores it, then read as Spending reads it.
    const FEES_AND_ADJUSTMENTS = 'Fees & Adjustments-Fees & Adjustments';
    const withoutRule = CARD_CATEGORY_RULES.filter((rule) => !rule.overIssuer);
    const read = (charge: string, credit: string, issuerCategory: string | null) => {
      const rows = ([[charge, 1_250], [credit, -1_250]] as const).map(([description, amountMinor], index) => ({
        id: `row-${index}`, cardAccountId: 'card-1', transactionDate: '2026-04-09', status: 'posted' as const, currency: 'USD',
        amountMinor, description, merchant: null, issuerCategory, kind: classifyCardKind({ amountMinor, description, issuerCategory }),
      }));
      const model = buildCardCategoryInference(rows);
      const before = buildCardCategoryInference(rows, { rules: withoutRule });
      const shown = rows.map((item) => ({ ...item, inferredCategory: model.infer(item)?.category ?? null }));
      return {
        kinds: rows.map((item) => item.kind),
        categories: shown.map((item) => effectiveCardCategory(item)),
        withoutRule: rows.map((item) => effectiveCardCategory({ ...item, inferredCategory: before.infer(item)?.category ?? null })),
        byCategory: summarizeCardSpending(shown).byCategory.map((item) => [item.category, item.spendingMinor, item.count]),
      };
    };
    // A tax payment or its processor's fee, and the credit giving it back, offset each other in Taxes: a fee's refund is
    // an adjustment, and an issuer that files them under its fees makes the charge a fee.
    const filed: Array<[string, string, string | null, CardTransactionKind[]]> = [
      ['SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE', 'SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE REFUND', UTILITIES, ['purchase', 'adjustment']],
      ['SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE', 'SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE REFUND', null, ['purchase', 'adjustment']],
      ['US TREASURY TAX PAYMENT', 'US TREASURY TAX PAYMENT', MISCELLANEOUS, ['purchase', 'refund']],
      ['US TREASURY TAX PAYMENT', 'US TREASURY TAX PAYMENT', null, ['purchase', 'refund']],
      ['US TREASURY TAX PAYMENT', 'US TREASURY TAX PAYMENT', FEES_AND_ADJUSTMENTS, ['fee', 'adjustment']],
    ];
    for (const [charge, credit, issuerCategory, kinds] of filed) {
      const answer = read(charge, credit, issuerCategory);
      assert.deepEqual(answer.kinds, kinds, `${credit} (${issuerCategory})`);
      assert.deepEqual(answer.categories, [CARD_TAX_CATEGORY, CARD_TAX_CATEGORY], `${credit} (${issuerCategory})`);
      assert.deepEqual(answer.byCategory, [[CARD_TAX_CATEGORY, 0, 2]], `${credit} (${issuerCategory})`);
    }
    // A card's own fee or interest, and the credit giving it back, stay exactly where they are without the rule: together,
    // under their issuer's category, or without one under the card's fees.
    const kept: Array<[string, string, CardTransactionKind[]]> = [
      ['CASH ADVANCE FEE US TREASURY', 'CASH ADVANCE FEE REVERSAL US TREASURY', ['fee', 'adjustment']],
      ['CASH ADVANCE INTEREST US TREASURY', 'CASH ADVANCE INTEREST REVERSAL US TREASURY', ['interest', 'adjustment']],
      ['SAMPLE PROCESSOR*TAX PAYMENT SERVICE FEE', 'SAMPLE PROCESSOR*TAX PAYMENT SERVICE FEE REFUND', ['fee', 'adjustment']],
    ];
    for (const [charge, credit, kinds] of kept) {
      for (const issuerCategory of [UTILITIES, null]) {
        const answer = read(charge, credit, issuerCategory);
        assert.deepEqual(answer.kinds, kinds, `${charge} (${issuerCategory})`);
        assert.deepEqual(answer.categories, answer.withoutRule, `${charge} (${issuerCategory})`);
        assert.ok(!answer.categories.includes(CARD_TAX_CATEGORY), `${charge} (${issuerCategory})`);
      }
      assert.deepEqual(read(charge, credit, UTILITIES).byCategory, [[UTILITIES, 0, 2]], charge);
      assert.deepEqual(read(charge, credit, null).byCategory, [[FEES_AND_ADJUSTMENTS, 0, 2]], charge);
    }
    // What the classifier makes a transfer is never spending, so never filed.
    for (const [description, amountMinor] of [['US TREASURY TAX PAYMENT REVERSAL', -1_250], ['US TREASURY TAX PAYMENT RETURNED', 1_250]] as const) {
      const kind = classifyCardKind({ amountMinor, description });
      assert.equal(kind, 'payment', description);
      assert.equal(none.infer(row(description, { kind, issuerCategory: UTILITIES })), null, description);
      assert.equal(none.infer(row(description, { kind })), null, description);
    }
  });

  it('comes before merchant history, and teaches it nothing', () => {
    // A merchant whose other charges agree on the issuer's utilities category: a tax payment there is still a tax.
    const history = buildCardCategoryInference([issued('NORTHWIND CIVIC', UTILITIES), issued('NORTHWIND CIVIC', UTILITIES)]);
    assert.deepEqual(history.infer(row('NORTHWIND CIVIC', { merchant: 'US Treasury' })), TAXES);
    // Tax payments filed under utilities lend that category to nothing: not to a charge of their merchant group that
    // the rule does not recognize, as a statement file has it with no merchant name.
    const taxes = [
      issued('FABRIKAM CIVIC 0042', UTILITIES, { merchant: 'US Treasury' }),
      issued('FABRIKAM CIVIC 0043', UTILITIES, { merchant: 'US Treasury' }),
    ];
    assert.equal(buildCardCategoryInference(taxes).infer(row('FABRIKAM CIVIC 0044')), null);
    // Without the rule, history would have lent it the issuer's category.
    const withoutRule = CARD_CATEGORY_RULES.filter((rule) => !rule.overIssuer);
    assert.equal(buildCardCategoryInference(taxes, { rules: withoutRule }).infer(row('FABRIKAM CIVIC 0044'))?.category, UTILITIES);
  });

  it('says which rows it files, and which rows an answer may infer', () => {
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'purchase', description: 'US TREASURY TAX PAYMENT' })?.id, 'tax-payment');
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'refund', description: 'SAMPLE 0042', merchant: 'United States Treasury' })?.id, 'tax-payment');
    // Whatever its kind: the classifier makes a fee's refund an adjustment, and a charge its issuer files under fees a fee.
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'adjustment', description: 'SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE REFUND' })?.id,
      'tax-payment');
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'fee', description: 'US TREASURY TAX PAYMENT' })?.id, 'tax-payment');
    // Never a card's own fee or interest, a transfer, or another merchant.
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'fee', description: 'CASH ADVANCE FEE US TREASURY' }), undefined);
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'payment', description: 'US TREASURY TAX PAYMENT' }), undefined);
    assert.equal(cardCategoryRuleOverIssuer({ kind: 'purchase', description: 'NORTHWIND GROCERY' }), undefined);
    assert.equal(cardCategoryInferable({ kind: 'purchase', description: 'NORTHWIND GROCERY' }), true);
    assert.equal(cardCategoryInferable({ kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: GROCERIES }), false);
    assert.equal(cardCategoryInferable({ kind: 'purchase', description: 'US TREASURY TAX PAYMENT', issuerCategory: UTILITIES }), true);
    assert.equal(cardCategoryInferable({ kind: 'purchase', description: 'US TREASURY TAX PAYMENT', issuerCategory: UTILITIES, userCategory: 'Mine' }), false);
    assert.equal(cardCategoryInferable({ kind: 'payment', description: 'US TREASURY TAX PAYMENT' }), false);
    // Rows with neither category are still the only ones inference fills.
    assert.equal(cardCategoryInferenceEligible({ kind: 'purchase', issuerCategory: UTILITIES }), false);
  });

  it('is counted apart: the rows it files over their issuer\'s category are in neither merchant history nor the hold-out', () => {
    const rows: Row[] = [
      issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES),
      issued('US TREASURY TAX PAYMENT', UTILITIES), issued('UNITED STATES TREASURY', MISCELLANEOUS),
      // The owner's own category wins in an answer; its issuer's category is the rule's to file over all the same.
      issued('US TREASURY TAX PAYMENT', UTILITIES, { userCategory: 'Mine' }),
      // Not counted: pending.
      issued('US TREASURY TAX PAYMENT', UTILITIES, { status: 'pending' }),
      // A tax payment with no category of its own is filled by the rule.
      row('US TREASURY TAX PAYMENT'),
    ];
    const evaluation = evaluateCardCategoryInference(rows);
    assert.equal(evaluation.refiled, 3);
    assert.deepEqual(evaluation.uncategorized, { rows: 1, byHistory: 0, byRule: 1, remaining: 0 });
    // Only the grocery rows are left out in turn: each, with one other row of history left, goes to the grocery rule.
    assert.deepEqual(evaluation.holdOut, {
      rows: 2,
      byHistory: { rows: 0, correct: 0, topLevelCorrect: 0 },
      byRule: { rows: 2, correct: 2, topLevelCorrect: 2 },
      remaining: 0,
    });
    assert.deepEqual(evaluation.rules.find((entry) => entry.rule === 'tax-payment'),
      { rule: 'tax-payment', filled: 1, refiled: 3, holdOut: { rows: 0, correct: 0, topLevelCorrect: 0 }, categoryStored: false });
    assert.ok(evaluation.rules.every((entry) => entry.rule === 'tax-payment' || entry.refiled === 0));
  });
});

describe('evaluation (counts only)', () => {
  it('counts what inference fills and, leaving each categorized row out in turn, how often it agrees', () => {
    const rows: Row[] = [
      // History of three merchants: one agreed (3 rows), one split (2 rows), one with a single row.
      issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES), issued('NORTHWIND GROCERY', GROCERIES),
      issued('LITWARE STORE', GROCERIES), issued('LITWARE STORE', BOOKS),
      issued('FABRIKAM BOOKS', BOOKS),
      // A categorized coffee chain charge the rules recognize, though under another subcategory.
      issued('STARBUCKS STORE 12345', 'Restaurant-Bar & Café'),
      // Rows to fill: by history, by rule, and neither.
      row('NORTHWIND GROCERY #12'), row('PROSEWARE BISTRO'), row('SAMPLE PLUMBING LLC'),
      // Not counted: pending, owner's own, payments.
      row('NORTHWIND GROCERY', { status: 'pending' }), row('SAMPLE PLUMBING LLC', { userCategory: 'Home' }), row('AUTOPAY', { kind: 'payment' }),
    ];
    const evaluation = evaluateCardCategoryInference(rows);
    assert.deepEqual(evaluation.uncategorized, { rows: 3, byHistory: 1, byRule: 1, remaining: 1 });
    // Held out: each Northwind row is predicted from the other two (3 correct); a Litware row is left with one
    // other (no answer); the single Fabrikam row has no other; Starbucks goes to the coffee chain rule, which
    // names the issuer's own subcategory.
    assert.deepEqual(evaluation.holdOut, {
      rows: 7,
      byHistory: { rows: 3, correct: 3, topLevelCorrect: 3 },
      byRule: { rows: 1, correct: 1, topLevelCorrect: 1 },
      remaining: 3,
    });
    assert.equal(evaluation.ruleCategories.total, new Set(CARD_CATEGORY_RULES.map((rule) => rule.category)).size);
    assert.equal(evaluation.ruleCategories.inUse, 2, 'the groceries and café categories are both stored and rule categories');
    // Every rule, in order, with what it filled and answered.
    assert.deepEqual(evaluation.rules.map((entry) => entry.rule), CARD_CATEGORY_RULES.map((rule) => rule.id));
    const used = evaluation.rules.filter((entry) => entry.filled > 0 || entry.holdOut.rows > 0 || entry.categoryStored);
    assert.deepEqual(used, [
      { rule: 'grocery-store', filled: 0, refiled: 0, holdOut: { rows: 0, correct: 0, topLevelCorrect: 0 }, categoryStored: true },
      { rule: 'coffee-chain', filled: 0, refiled: 0, holdOut: { rows: 1, correct: 1, topLevelCorrect: 1 }, categoryStored: true },
      { rule: 'restaurant-word', filled: 1, refiled: 0, holdOut: { rows: 0, correct: 0, topLevelCorrect: 0 }, categoryStored: false },
      { rule: 'cafe-word', filled: 0, refiled: 0, holdOut: { rows: 0, correct: 0, topLevelCorrect: 0 }, categoryStored: true },
    ]);
    // No tax payment among them: nothing filed over an issuer's category.
    assert.equal(evaluation.refiled, 0);
    // Under the previous version's categories, the same rule answers the same row, at the right top level only.
    const before = evaluateCardCategoryInference(rows, { rules: cardCategoryRulesBeforeRetarget() });
    assert.deepEqual(before.holdOut.byRule, { rows: 1, correct: 0, topLevelCorrect: 1 });
    // Counts only: numbers, flags and the reviewed rules' own generic ids.
    const ids = new Set(CARD_CATEGORY_RULES.map((rule) => rule.id));
    const leaves = (value: unknown): unknown[] => (typeof value === 'object' && value !== null ? Object.values(value).flatMap(leaves) : [value]);
    assert.ok(leaves(evaluation).every((value) => typeof value === 'number' || typeof value === 'boolean' || ids.has(value as string)));
  });

  it('learns a credit naming a fee where it decides one, as the charge it gives back, and holds each row out there', () => {
    // A merchant no rule knows, with two charges and a credit its issuer filed, and a credit with no category.
    const GARAGES = 'Sample garages';
    const rows: Row[] = [
      issued('SAMPLE GARAGE FEE', GARAGES), issued('SAMPLE GARAGE FEE', GARAGES),
      issued('SAMPLE GARAGE FEE REFUND', GARAGES, { kind: 'adjustment' }), row('SAMPLE GARAGE FEE REFUND', { kind: 'adjustment' }),
    ];
    assert.deepEqual(buildCardCategoryInference(rows).infer(rows[3]),
      { category: GARAGES, basis: 'merchant-history', observations: 3, agreeing: 3 });
    // Each categorized row, the credit too, is left out of the tally it taught, and the two others answer it.
    assert.deepEqual(evaluateCardCategoryInference(rows).holdOut, {
      rows: 3,
      byHistory: { rows: 3, correct: 3, topLevelCorrect: 3 },
      byRule: { rows: 0, correct: 0, topLevelCorrect: 0 },
      remaining: 0,
    });
  });
});

describe('a retarget', () => {
  it('only names other categories: the previous version\'s table has the same patterns, in the same order', () => {
    const before = cardCategoryRulesBeforeRetarget();
    assert.deepEqual(before.map((rule) => rule.id), CARD_CATEGORY_RULES.map((rule) => rule.id));
    before.forEach((rule, index) => {
      const current = CARD_CATEGORY_RULES[index];
      assert.equal(rule.pattern, current.pattern, rule.id);
      assert.equal(rule.not, current.not, rule.id);
      assert.deepEqual(rule.kinds, current.kinds, rule.id);
      const previous = CARD_CATEGORY_RULES_RETARGETED.categories[rule.id];
      assert.equal(rule.category, previous ?? current.category, rule.id);
      if (previous !== undefined) assert.notEqual(previous, current.category, `${rule.id} is retargeted`);
    });
    assert.notEqual(CARD_CATEGORY_RULES_RETARGETED.version, CARD_CATEGORY_RULES_VERSION);
    // 2026.10.1 filed coffee chains and cafés with restaurants.
    const model = buildCardCategoryInference([], { rules: before });
    assert.equal(model.infer(row('STARBUCKS STORE 12345'))?.category, DINING);
    assert.equal(model.infer(row('SAMPLE CAFE'))?.category, DINING);
  });
});

describe('what an enriched answer says of its categories', () => {
  it('where a row\'s category comes from: the owner\'s, Amazon item parts, inferred, the issuer\'s, or none', () => {
    assert.equal(cardCategoryRowSource({ userCategory: 'Mine', issuerCategory: GROCERIES }, { split: true, inferred: false }), 'user');
    assert.equal(cardCategoryRowSource({ issuerCategory: GROCERIES }, { split: true, inferred: false }), 'amazon');
    assert.equal(cardCategoryRowSource({ issuerCategory: GROCERIES }, { split: false, inferred: false }), 'issuer');
    // A split row whose residual takes an inferred category still counts as Amazon's.
    assert.equal(cardCategoryRowSource({}, { split: true, inferred: true }), 'amazon');
    assert.equal(cardCategoryRowSource({}, { split: false, inferred: true }), 'inferred');
    assert.equal(cardCategoryRowSource({}, { split: false, inferred: false }), 'uncategorized');
    // A rule's category over the issuer's (a tax payment) is inferred; the owner's own still wins.
    assert.equal(cardCategoryRowSource({ issuerCategory: GROCERIES }, { split: false, inferred: true }), 'inferred');
    assert.equal(cardCategoryRowSource({ userCategory: 'Mine', issuerCategory: GROCERIES }, { split: false, inferred: true }), 'user');
    assert.deepEqual(countCardCategoryRowSources(['user', 'inferred', 'inferred']), { user: 1, issuer: 0, amazon: 0, inferred: 2, uncategorized: 0 });
  });

  it('counts inferred rows by basis, merchant history and rule both always listed', () => {
    assert.deepEqual(cardCategoryInferenceMarker([]), {
      rules: CARD_CATEGORY_RULES_VERSION, rowsByBasis: [{ basis: 'merchant-history', count: 0 }, { basis: 'rule', count: 0 }],
    });
    assert.deepEqual(cardCategoryInferenceMarker([{ basis: 'rule' }, { basis: 'merchant-history' }, { basis: 'rule' }]).rowsByBasis,
      [{ basis: 'merchant-history', count: 1 }, { basis: 'rule', count: 2 }]);
  });
});
