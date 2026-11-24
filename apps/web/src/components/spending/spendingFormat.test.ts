import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardCategoryBasisMarker, CardCategoryEvidenceClass, CardCategoryHoldReason, CardCategoryPart } from '@finance-tracker/shared';

import {
  SPENDING_PERIODS,
  addMonths,
  amazonCoverageText,
  amazonEvidenceText,
  amazonLineCategorySource,
  amazonMarkerText,
  amazonOrderLines,
  amazonOrderStatusText,
  amazonPartLabel,
  amazonWholeRowReasonText,
  cardDisplayNames,
  cardNameLabel,
  cardNameParts,
  cardOptionLabel,
  categoryBasisText,
  categoryEvidenceText,
  categoryInferenceText,
  chartScaleTop,
  formatMinorCompact,
  fullCardName,
  forgetCardAccounts,
  importResultText,
  importReviewCounts,
  importReviewText,
  issuerOnceCardName,
  merchantDisplayName,
  ownCategoryFromInput,
  rankedCategoryLabels,
  rememberCardAccounts,
  shortCardName,
  spendingPeriodRange,
  splitCategoryLabel,
} from './spendingFormat';

test('periods: a month, the last 60 or 90 days against the days before, the year to date against last year', () => {
  assert.deepEqual(spendingPeriodRange('month', '2024-03', '2024-03-20'), {
    from: '2024-03-01', to: '2024-03-31', label: 'March 2024', name: 'March 2024', phrase: 'March 2024', spent: 'in Mar', previous: null,
  });
  assert.deepEqual(spendingPeriodRange('last60', '2024-03', '2024-03-20'), {
    from: '2024-01-21', to: '2024-03-20', label: 'Jan 21 – Mar 20, 2024', name: 'Last 60 days', phrase: 'the last 60 days',
    spent: 'in the last 60 days', previous: { from: '2023-11-22', to: '2024-01-20', phrase: 'the 60 days before' },
  });
  // The month shown before does not matter for a span that ends today.
  const last90 = spendingPeriodRange('last90', '2023-06', '2024-03-20');
  assert.deepEqual([last90.from, last90.to, last90.label, last90.previous], [
    '2023-12-22', '2024-03-20', 'Dec 22, 2023 – Mar 20, 2024', { from: '2023-09-23', to: '2023-12-21', phrase: 'the 90 days before' },
  ]);
  assert.deepEqual(spendingPeriodRange('ytd', '2024-03', '2024-03-20'), {
    from: '2024-01-01', to: '2024-03-20', label: 'Jan 1 – Mar 20, 2024', name: '2024 to date', phrase: '2024 to date',
    spent: 'in 2024 to date', previous: { from: '2023-01-01', to: '2023-03-20', phrase: '2023 to the same date' },
  });
  assert.equal(spendingPeriodRange('ytd', '2024-02', '2024-02-29').previous?.to, '2023-02-28');
  assert.equal(spendingPeriodRange('ytd', '2025-01', '2025-01-01').label, 'Jan 1, 2025');
});

test('periods: the last 6 or 12 months end today, 6 against the same months a year earlier, 12 against the 12 before', () => {
  assert.deepEqual(SPENDING_PERIODS.map((item) => item.label), ['Month', '60 days', '90 days', '6 months', '12 months', 'YTD']);
  assert.deepEqual(spendingPeriodRange('last6m', '2026-10', '2026-10-18'), {
    from: '2026-04-19', to: '2026-10-18', label: 'Apr 19 – Oct 18, 2026', name: 'Last 6 months', phrase: 'the last 6 months',
    spent: 'in the last 6 months', previous: { from: '2025-04-19', to: '2025-10-18', phrase: 'the same 6 months last year' },
  });
  assert.deepEqual(spendingPeriodRange('last12m', '2026-10', '2026-10-18'), {
    from: '2025-10-19', to: '2026-10-18', label: 'Oct 19, 2025 – Oct 18, 2026', name: 'Last 12 months', phrase: 'the last 12 months',
    spent: 'in the last 12 months', previous: { from: '2024-10-19', to: '2025-10-18', phrase: 'the 12 months before' },
  });
  // The month shown before does not matter for a span that ends today.
  assert.equal(spendingPeriodRange('last6m', '2023-06', '2026-10-18').from, '2026-04-19');
  // Today's date past a shorter month's end: the span is six whole months.
  const august = spendingPeriodRange('last6m', '2026-08', '2026-08-31');
  assert.deepEqual([august.from, august.label, august.previous], [
    '2026-03-01', 'Mar 1 – Aug 31, 2026', { from: '2025-03-01', to: '2025-08-31', phrase: 'the same 6 months last year' },
  ]);
  // February 29: twelve months back is February 28, and last year's dates end there too.
  const leap = spendingPeriodRange('last12m', '2024-02', '2024-02-29');
  assert.deepEqual([leap.from, leap.label, leap.previous?.from, leap.previous?.to], ['2023-03-01', 'Mar 1, 2023 – Feb 29, 2024', '2022-03-01', '2023-02-28']);
  const leapHalf = spendingPeriodRange('last6m', '2024-02', '2024-02-29');
  assert.deepEqual([leapHalf.from, leapHalf.previous?.from, leapHalf.previous?.to], ['2023-08-30', '2022-08-30', '2023-02-28']);
  // Across a year's end, the dates carry both years.
  assert.equal(spendingPeriodRange('last6m', '2026-01', '2026-01-15').label, 'Jul 16, 2025 – Jan 15, 2026');
});

test('addMonths keeps the day of the month, or ends on a shorter month\'s last day', () => {
  assert.equal(addMonths('2026-10-18', -6), '2026-04-18');
  assert.equal(addMonths('2026-08-31', -6), '2026-02-28');
  assert.equal(addMonths('2024-08-31', -6), '2024-02-29');
  assert.equal(addMonths('2024-02-29', -12), '2023-02-28');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2025-12-15', 1), '2026-01-15');
});

test('the chart scale tops out at the next round amount, at least one whole unit', () => {
  const cases: Array<[number, string, number]> = [
    [0, 'USD', 0], [-500, 'USD', 0],
    [65000, 'USD', 80000], [24000, 'USD', 25000], [100000, 'USD', 100000], [107600, 'USD', 120000],
    [41200 * 2, 'USD', 100000], [999999, 'USD', 1000000], [1, 'USD', 100], [40, 'USD', 100],
    [650, 'JPY', 800], [2, 'JPY', 2],
  ];
  for (const [max, currency, top] of cases) assert.equal(chartScaleTop(max, currency), top, `${max} ${currency}`);
});

test('scale amounts are short', () => {
  const cases: Array<[number, string]> = [
    [0, '$0'], [40000, '$400'], [80000, '$800'], [62500, '$625'], [120000, '$1.2K'], [125000, '$1.25K'], [1200000, '$12K'], [50, '$0.5'],
  ];
  for (const [minor, text] of cases) assert.equal(formatMinorCompact(minor, 'USD'), text);
  assert.equal(formatMinorCompact(400000, 'EUR'), '€4K');
});

test('merchants read as names, not bank descriptors, and codes keep their capitals', () => {
  const cases: Array<[string, string, string]> = [
    ['SAMPLE STREAMING', 'SAMPLE STREAMING', 'Sample Streaming'],
    ['HOTEL SAMPLE LISBOA', 'HOTEL SAMPLE LISBOA', 'Hotel Sample Lisboa'],
    ['SQ *BLUE BOTTLE #12 SEATTLE WA', 'BLUE BOTTLE SEATTLE', 'Blue Bottle Seattle'],
    ['SQ *Blue Bottle #12', 'BLUE BOTTLE', 'Blue Bottle'],
    ['THE HOME DEPOT #123', 'THE HOME DEPOT', 'The Home Depot'],
    ['BANK OF THE WEST', 'BANK OF THE WEST', 'Bank of the West'],
    ['CVS/PHARMACY #1234', 'CVS/PHARMACY', 'CVS/Pharmacy'],
    ['7-ELEVEN 12345', '7-ELEVEN', '7-Eleven'],
    ['IN-N-OUT BURGER', 'IN-N-OUT BURGER', 'In-N-Out Burger'],
    ['AMAZON.COM', 'AMAZON.COM', 'Amazon.com'],
    ["JOE'S PIZZA", "JOE'S PIZZA", "Joe's Pizza"],
    ['AT&T', 'AT&T', 'AT&T'],
    ['AMC THEATRES', 'AMC THEATRES', 'AMC Theatres'],
    ['SHELL OIL 57444', 'SHELL OIL', 'Shell Oil'],
    ['FOREIGN TRANSACTION FEE', 'FOREIGN TRANSACTION FEE', 'Foreign Transaction Fee'],
    ['PLANET FITNESS GYM', 'PLANET FITNESS GYM', 'Planet Fitness Gym'],
    ['NYC TAXI', 'NYC TAXI', 'NYC Taxi'],
    ['LYFT', 'LYFT', 'Lyft'],
    ['AMZN MKTP US*2K3L45', 'AMZN MKTP', 'AMZN MKTP'],
    ['CAFÉ ROMA', 'CAFÉ ROMA', 'Café Roma'],
    ['喜茶', '喜茶', '喜茶'],
    // Mixed case is the issuer's own writing: kept, up to where the merchant ends.
    ['AMZN Mktp US*2K3L45', 'AMZN MKTP', 'AMZN Mktp'],
    ['Blue Bottle Coffee', 'BLUE BOTTLE COFFEE', 'Blue Bottle Coffee'],
    ['Fourth Coffee Seattle', 'FOURTH COFFEE', 'Fourth Coffee'],
    ['Fourth Coffeehouse', 'FOURTH COFFEE', 'Fourth Coffee'],
    ['  Uber   Eats ', 'UBER EATS', 'Uber Eats'],
    ['Sample Shop', '', 'Sample Shop'],
    // A company form ends the name, before the city a descriptor goes on to; never the first word.
    ['SAMPLE DEVICES INC ROUND ROCK TX', 'SAMPLE DEVICES INC ROUND ROCK', 'Sample Devices'],
    ['Sample Devices Inc. Round Rock TX', 'SAMPLE DEVICES INC. ROUND ROCK', 'Sample Devices'],
    ['FABRIKAM LLC SEATTLE WA', 'FABRIKAM LLC SEATTLE', 'Fabrikam'],
    ['INC SAMPLE', 'INC SAMPLE', 'INC Sample'],
    // A web address spelled out in words reads as one.
    ['WWW SAMPLESTORE COM ISSAQUAH WA', 'WWW SAMPLESTORE COM ISSAQUAH', 'Samplestore.com Issaquah'],
    ['WWW SAMPLESTORE COM', 'WWW SAMPLESTORE COM', 'Samplestore.com'],
    ['WWW COM', 'WWW COM', 'WWW COM'],
    // A billing address glued to a subscription's name is left out.
    ['GOOGLE *Sample Tube Membg.co/helppay#', 'SAMPLE TUBE MEMBG.CO/HELPPAY#', 'Sample Tube Memb'],
    ['GOOGLE *Sample Drive g.co/helppay#', 'SAMPLE DRIVE G.CO/HELPPAY#', 'Sample Drive'],
    ['G.CO/HELPPAY#', 'G.CO/HELPPAY#', 'G.co/HELPPAY#'],
  ];
  for (const [name, key, shown] of cases) assert.equal(merchantDisplayName(name, key), shown, name);
});

test('ranked categories show their top level, and what tells them apart where two share it', () => {
  const labels = (names: string[]) => names.map((name) => rankedCategoryLabels(names).get(name));
  assert.deepEqual(labels(['Groceries', 'Restaurant', 'Travel']), ['Groceries', 'Restaurant', 'Travel']);
  assert.deepEqual(
    labels(['Merchandise & Supplies-Groceries', 'Merchandise & Supplies-Clothing', 'Travel-Airline', 'Fees & Adjustments-Fees & Adjustments']),
    ['Groceries', 'Clothing', 'Travel', 'Fees & Adjustments'],
  );
  assert.deepEqual(labels(['Restaurant-Bar & Café', 'Restaurant-Dining']), ['Bar & Café', 'Dining']);
  // A part that still repeats ("Groceries" twice) shows in full.
  assert.deepEqual(
    labels(['Merchandise & Supplies-Groceries', 'Groceries', 'Merchandise & Supplies-Clothing']),
    ['Merchandise & Supplies-Groceries', 'Groceries', 'Clothing'],
  );
  assert.deepEqual(labels(['Merchandise & Supplies-Other', 'Travel & Transport-Other', 'Travel & Transport-Rail']), ['Merchandise', 'Other', 'Rail']);
});

test('an import\'s result says what it did: added, already stored, posted, dismissed, held and left for review', () => {
  const base = { imported: true, newCount: 0, duplicateCount: 0, pendingPostedCount: 0 };
  assert.equal(importResultText({ ...base, imported: false }), 'Nothing new: this import is already stored.');
  assert.equal(importReviewText({ ...base, imported: false }), null);
  assert.equal(importResultText({ ...base, newCount: 1 }), 'Imported 1 new row.');
  // Posted pending rows are among the duplicates; they are said once.
  assert.equal(
    importResultText({ ...base, newCount: 3, duplicateCount: 4, pendingPostedCount: 1, stalePendingDismissedCount: 2 }),
    'Imported 3 new rows; 3 already stored; 1 pending charge posted; 2 pending charges dismissed.',
  );
  // E2d (Q8): an import whose only new rows are held never reads "Imported 0 new rows".
  const held = { ...base, duplicateCount: 1, heldCount: 2, reviewCount: 2 };
  assert.equal(importResultText(held), 'No new rows; 1 already stored; 2 rows held for review.');
  assert.equal(importReviewText(held),
    'The held rows are not in spending: in the review, say whether each is a charge the browser extension already synced, a new one, or not yours.');
  // E2d (Q13, E-Q7): a covered file whose only news is a reference's new details answers 201 with a review item.
  const differing = { ...base, duplicateCount: 5, reviewCount: 1 };
  assert.equal(importResultText(differing), 'No new rows; 5 already stored; 1 stored row differs from the file.');
  assert.equal(importReviewText(differing), 'The stored row stays as it is unless you apply the file\'s version in the review.');
  const both = { ...base, newCount: 2, duplicateCount: 3, heldCount: 1, reviewCount: 3 };
  assert.deepEqual(importReviewCounts(both), { held: 1, differing: 2 });
  assert.equal(importResultText(both), 'Imported 2 new rows; 3 already stored; 1 row held for review; 2 stored rows differ from the file.');
  assert.equal(importReviewText(both), 'The held row is not in spending: in the review, say whether it is a charge the browser extension already '
    + 'synced, a new one, or not yours. The stored rows stay as they are unless you apply the file\'s version in the review.');
  // An API without E2d's counts reads as before.
  assert.equal(importReviewText({ ...base, newCount: 1 }), null);
});

test('the categories say what the answer shown is based on, and the switch says where it goes', () => {
  const sources = { user: 2, issuer: 40, amazon: 3, inferred: 12, uncategorized: 5 };
  const inference = (history: number, rule: number) => ({
    rules: '2026.10.1', rowsByBasis: [{ basis: 'merchant-history' as const, count: history }, { basis: 'rule' as const, count: rule }],
  });
  const noSplits = {
    splitRows: 0, splitRowsByEvidence: [{ evidenceClass: 'payment-event' as const, count: 0 }, { evidenceClass: 'unique-total-match' as const, count: 0 }],
  };
  const marker = (patch: Partial<CardCategoryBasisMarker>): CardCategoryBasisMarker => ({
    requested: 'enriched', effective: 'enriched', availability: 'available', version: 'rev-20261019-abcdef',
    splitRows: 3, splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 2 }, { evidenceClass: 'unique-total-match', count: 1 }],
    keptWholeByUserCategory: 1, heldOrDeclined: [{ reason: 'match-held', count: 2 }],
    invalid: [{ reason: 'sum-mismatch', count: 1 }], policyAllocatedMinor: [], residualMinor: [],
    rowsBySource: sources, inference: inference(3, 9), ...patch,
  });
  const both = categoryBasisText(marker({}), 'enriched');
  // The answer's revision is kept apart, never said.
  assert.equal(both.revision, 'rev-20261019');
  assert.deepEqual([both.text, both.toggle, both.next, both.pending], [
    'Categories: 3 charges split by Amazon items · 12 charges inferred (3 from merchant history, 9 by rule)',
    'Original categories', 'original', null,
  ]);
  assert.match(both.title,
    /^Where these charges' categories come from: your own 2, the issuer's 40, Amazon items 3, inferred 12 \(3 from merchant history, 9 by rule\), none 5\./);
  assert.match(both.title, /or a reviewed rule's \(rules 2026\.10\.1\)\. A tax paid by card counts under Taxes by rule, whatever its issuer's category\./);
  assert.match(both.title, /Charges matched to Amazon orders count under their items' categories \(1 kept whole by your own category, 3 kept whole for now\)\./);
  assert.match(both.title, /Totals, months, merchants, cards and people are the same either way\.$/);
  // Inferred only, with no Amazon source: never claimed as split, and the rule share said even at 0.
  const inferred = categoryBasisText(marker({ availability: 'unavailable', version: 'none', ...noSplits, keptWholeByUserCategory: 0,
    heldOrDeclined: [], invalid: [], rowsBySource: { ...sources, amazon: 0, inferred: 1 }, inference: inference(0, 1) }), 'enriched');
  assert.deepEqual([inferred.text, inferred.toggle], ['Categories: 1 charge inferred (0 from merchant history, 1 by rule)', 'Original categories']);
  assert.match(inferred.title, /inferred 1 \(0 from merchant history, 1 by rule\), none 5\. A charge with no category of its own takes the one its merchant's other charges agree on, or a reviewed rule's \(rules 2026\.10\.1\)\. A tax paid by card counts under Taxes by rule, whatever its issuer's category\. No Amazon item categories are available\./);
  assert.equal(categoryBasisText(marker({ ...noSplits, rowsBySource: { ...sources, amazon: 0 }, inference: inference(12, 0) }), 'enriched').text,
    'Categories: 12 charges inferred (12 from merchant history, 0 by rule)');
  // Available, with nothing split or inferred in this answer: never claimed as either.
  const none = categoryBasisText(marker({ effective: 'original', ...noSplits, keptWholeByUserCategory: 0, invalid: [],
    rowsBySource: { ...sources, amazon: 0, inferred: 0 }, inference: inference(0, 0) }), 'enriched');
  assert.deepEqual([none.text, none.toggle], ['Categories: card categories', 'Original categories']);
  assert.match(none.title, /inferred 0, none 5\./);
  assert.match(none.title, /No charge here is split by Amazon items \(2 kept whole for now\)\./);
  // Neither available nor inferred.
  const unavailable = categoryBasisText(marker({ effective: 'original', availability: 'unavailable', version: 'none', ...noSplits,
    rowsBySource: { ...sources, amazon: 0, inferred: 0 }, inference: inference(0, 0) }), 'enriched');
  assert.deepEqual([unavailable.text, unavailable.toggle, unavailable.next], ['Categories: card categories', 'Original categories', 'original']);
  const original = categoryBasisText(marker({ requested: 'original', effective: 'original', availability: 'not-requested', version: 'original',
    rowsBySource: undefined, inference: undefined }), 'original');
  assert.deepEqual([original.text, original.toggle, original.next, original.pending], ['Categories: original card categories', 'Enriched categories', 'enriched', null]);
  assert.match(original.title, /^Here every card charge counts under your own category or its issuer's\./);
  // Just switched: the figures shown keep the words of their own basis until the answer for the new one arrives.
  const switching = categoryBasisText(marker({}), 'original');
  assert.deepEqual([switching.text, switching.toggle, switching.next, switching.pending], [
    'Categories: 3 charges split by Amazon items · 12 charges inferred (3 from merchant history, 9 by rule)',
    'Enriched categories', 'enriched', 'Switching to original categories…',
  ]);
  const back = categoryBasisText(marker({ requested: 'original', effective: 'original', availability: 'not-requested', version: 'original' }), 'enriched');
  assert.deepEqual([back.text, back.toggle, back.pending], ['Categories: original card categories', 'Original categories', 'Switching to enriched categories…']);
  // Nothing shown yet, or an API from before the marker: no claim either way.
  assert.deepEqual([categoryBasisText(undefined, 'enriched').text, categoryBasisText(undefined, 'enriched').pending], ['Categories: card categories', null]);
});

test('with Amazon orders available, the split charges are counted by evidence: only the kinds that split one', () => {
  const marker = (patch: Partial<CardCategoryBasisMarker>): CardCategoryBasisMarker => ({
    requested: 'enriched', effective: 'original', availability: 'available', version: 'amazon-v1-abc',
    splitRows: 0, splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 0 }, { evidenceClass: 'unique-total-match', count: 0 }],
    keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [], policyAllocatedMinor: [], residualMinor: [], ...patch,
  });
  // Nothing split: nothing to count (the note says no charge is split, in its own words).
  assert.equal(categoryEvidenceText(marker({})), null);
  assert.equal(categoryEvidenceText(marker({ splitRowsByEvidence: [] })), null);
  assert.equal(categoryEvidenceText(marker({
    effective: 'enriched', splitRows: 5, splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 2 }, { evidenceClass: 'unique-total-match', count: 3 }],
  })), 'Amazon splits: 2 by payment · 3 by order total (lower evidence)');
  // The class Amazon's payment ledger brings, as the marker lists it once the shared enum has it.
  const ledger = 'payment-ledger-complete' as CardCategoryEvidenceClass;
  assert.equal(categoryEvidenceText(marker({
    effective: 'enriched', splitRows: 9,
    splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 1 }, { evidenceClass: 'unique-total-match', count: 0 }, { evidenceClass: ledger, count: 8 }],
  })), 'Amazon splits: 1 by payment · 8 by payment ledger (allocated by price share)');
  // Not asked of an available source: nothing to count.
  assert.equal(categoryEvidenceText(marker({ requested: 'original', availability: 'not-requested' })), null);
  assert.equal(categoryEvidenceText(marker({ availability: 'unavailable' })), null);
  assert.equal(categoryEvidenceText(undefined), null);
});

test('a charge\'s Amazon order says how it was tied, why it counts whole, and what each part is', () => {
  assert.equal(amazonEvidenceText('payment-event'), 'tied by its Amazon payment');
  assert.equal(amazonEvidenceText('unique-total-match'), 'tied by its order total only (lower evidence)');
  assert.equal(amazonEvidenceText('payment-ledger-complete' as CardCategoryEvidenceClass),
    'tied by Amazon’s payment ledger (allocated by price share)');
  assert.equal(amazonWholeRowReasonText('item-identity-unproven'), 'which items this charge paid for is not proven yet');
  assert.equal(amazonWholeRowReasonText('match-held'), 'more than one order or charge could match, so none is linked yet');
  assert.equal(amazonWholeRowReasonText('refund-unattributed' as CardCategoryHoldReason), 'a refund on the order is not attributed to its items yet');
  // A receipt's precious metals (Costco receipts 4/7): never said to be out of spending already.
  assert.equal(amazonWholeRowReasonText('asset-purchase'), 'its receipt shows precious metals; review it in What counts');
  assert.equal(amazonWholeRowReasonText('asset-uncertain'), 'an item on its receipt may be precious metal, which is not confirmed yet');
  assert.equal(amazonWholeRowReasonText('sum-mismatch'), 'the item amounts do not add up to the charge');
  assert.equal(amazonWholeRowReasonText('not-linked'), 'the order is not linked to this charge');
  assert.equal(amazonWholeRowReasonText('bad-item-ref'), 'its items could not be checked');
  assert.equal(amazonWholeRowReasonText(undefined), 'its items could not be checked');
  assert.equal(amazonPartLabel({ classification: 'source', categorySource: 'agent-classification' }), 'classified from its title');
  assert.equal(amazonPartLabel({ classification: 'source', categorySource: 'item-override' }), 'your category');
  assert.equal(amazonPartLabel({ classification: 'policy-allocated', categorySource: 'reviewed-mapping' }),
    'tax, shipping and discounts, shared by price · reviewed category');
  assert.equal(amazonPartLabel({ classification: 'residual', categorySource: 'original-effective' }), 'Rest of the charge, under the card’s own category');
  // An Amazon Fresh Item List line's part (the Fresh split policy): its item category's, or the visible Groceries default.
  assert.equal(amazonPartLabel({ classification: 'policy-allocated', categorySource: 'item-taxonomy' }),
    'tax, shipping and discounts, shared by price · from its item category');
  assert.equal(amazonPartLabel({ classification: 'source', categorySource: 'fresh-default' }), 'Amazon Fresh default until it is classified');
});

test('a linked order\'s lines: each item once with what it puts where, then the rest of the charge', () => {
  const part = (category: string, amountMinor: number, classification: CardCategoryPart['classification'], itemRef?: string,
    categorySource: CardCategoryPart['categorySource'] = 'agent-classification'): CardCategoryPart =>
    ({ category, amountMinor, categorySource, classification, ...(itemRef ? { itemRef } : {}) });
  const lines = amazonOrderLines({
    parts: [
      part('Electronics', 6000, 'source', 'item-a'), part('Electronics', 500, 'policy-allocated', 'item-a'),
      part('Home', 1000, 'source', 'item-b', 'item-override'), part('Groceries', 1500, 'residual', undefined, 'original-effective'),
      // An item only a part names comes after the order's own items.
      part('Toys', 700, 'source', 'item-z'),
    ],
    items: [
      { itemRef: 'item-a', title: 'Sample monitor stand, model SW-3420', quantity: 1, asin: 'B0SAMPLE11' },
      { itemRef: 'item-b', title: 'Sample wall hook', quantity: 3, asin: null },
      { itemRef: 'item-c', title: null, quantity: 1, asin: 'B0SAMPLE12' },
      // The same item twice: listed once.
      { itemRef: 'item-a', title: 'Sample monitor stand, model SW-3420', quantity: 1, asin: 'B0SAMPLE11' },
    ],
  });
  assert.deepEqual(lines.map((line) => [line.kind, line.title, line.quantity, line.amountMinor, line.category, line.allocatedMinor, line.allocatedOnly]), [
    ['item', 'Sample monitor stand, model SW-3420', 1, 6500, 'Electronics', 500, false],
    ['item', 'Sample wall hook', 3, 1000, 'Home', 0, false],
    ['item', null, 1, null, null, 0, false],
    ['item', null, null, 700, 'Toys', 0, false],
    ['rest', null, null, 1500, 'Groceries', 0, false],
  ]);
  assert.deepEqual(new Set(lines.map((line) => line.key)).size, lines.length);
  assert.equal(amazonLineCategorySource(lines[1].categoryPart!), 'your category');
  assert.equal(amazonMarkerText(lines), 'Amazon · 4 items');
  // Tied by Amazon's payment ledger: every part allocated by price share, none the item's own amount.
  const ledger = amazonOrderLines({
    parts: [part('Books', 3000, 'policy-allocated', 'item-d'), part('Home', 1500, 'policy-allocated', 'item-e')],
    items: [{ itemRef: 'item-d', title: 'Sample notebook', quantity: 2, asin: null }, { itemRef: 'item-e', title: 'Sample lamp', quantity: 1, asin: null }],
  });
  assert.deepEqual(ledger.map((line) => [line.amountMinor, line.category, line.allocatedMinor, line.allocatedOnly]),
    [[3000, 'Books', 3000, true], [1500, 'Home', 1500, true]]);
  assert.equal(amazonLineCategorySource(ledger[0].categoryPart!), 'classified from its title');
  assert.equal(amazonMarkerText(amazonOrderLines({ items: [{ itemRef: 'item-f', title: 'Sample mug', quantity: 1, asin: null }] })), 'Amazon · 1 item');
  assert.equal(amazonMarkerText(amazonOrderLines({})), 'Amazon order');
});

test('a split charge shows its largest category and how many more; a linked order says how the charge counts', () => {
  assert.equal(splitCategoryLabel([{ category: 'Electronics' }, { category: 'Groceries' }, { category: 'Home' }]), 'Electronics +2');
  assert.equal(splitCategoryLabel([{ category: 'Groceries' }]), 'Groceries');
  // A long issuer category shows its top level, as the category cell does.
  assert.equal(splitCategoryLabel([{ category: 'Merchandise & Supplies-Internet Purchase' }, { category: 'Home' }]), 'Merchandise +1');
  assert.equal(splitCategoryLabel([]), '');
  assert.equal(amazonOrderStatusText({ aggregate: 'split' }, null), 'Counted under its items’ categories.');
  assert.equal(amazonOrderStatusText({ aggregate: 'whole-row-user-category' }, 'Gifts'), 'Counted whole under your category, Gifts.');
  assert.equal(amazonOrderStatusText({ aggregate: 'whole-row-declined', wholeRowReason: 'item-identity-unproven' }, null),
    'Counted whole, under its own category: which items this charge paid for is not proven yet.');
});

test('Amazon coverage says how many charges are itemized and every other Amazon row apart, never a quiet shrink', () => {
  const entry = (currency: string, patch: Partial<Record<'charges' | 'itemized' | 'notItemizable' | 'pending' | 'refunds' | 'other', number>>) =>
    ({ currency, charges: 0, itemized: 0, notItemizable: 0, pending: 0, refunds: 0, other: 0, ...patch });
  assert.deepEqual(amazonCoverageText([entry('EUR', { charges: 1 }), entry('USD', { charges: 3, itemized: 1, notItemizable: 1, pending: 1, refunds: 1 })], 'USD'), {
    headline: 'Amazon charges itemized: 1 of 3 (33%)',
    notCounted: 'Not counted: 1 digital, subscription, tip or Amazon Pay · 1 pending · 1 refund · 1 in other currencies',
    unitemized: 2,
  });
  // Rounded down: 100% only when every charge is itemized; the three usual kinds are said even at 0.
  assert.deepEqual(amazonCoverageText([entry('USD', { charges: 200, itemized: 199, other: 2 })], 'USD'), {
    headline: 'Amazon charges itemized: 199 of 200 (99%)',
    notCounted: 'Not counted: 0 digital, subscription, tip or Amazon Pay · 0 pending · 0 refunds · 2 other',
    unitemized: 1,
  });
  assert.equal(amazonCoverageText([entry('USD', { charges: 4, itemized: 4 })], 'USD')?.headline, 'Amazon charges itemized: 4 of 4 (100%)');
  // Only other Amazon rows in view: 0 of 0, still said, with what is not counted.
  assert.deepEqual(amazonCoverageText([entry('USD', { notItemizable: 2 })], 'USD'), {
    headline: 'Amazon charges itemized: 0 of 0', notCounted: 'Not counted: 2 digital, subscription, tip or Amazon Pay · 0 pending · 0 refunds', unitemized: 0,
  });
  // No Amazon row in view, or an answer without coverage: nothing.
  assert.equal(amazonCoverageText([], 'USD'), null);
  assert.equal(amazonCoverageText([entry('USD', {})], 'USD'), null);
  assert.equal(amazonCoverageText(undefined, 'USD'), null);
});

test('an inferred category says why, and a rule\'s says it is a rule', () => {
  assert.equal(categoryInferenceText({ category: 'Restaurant-Restaurant', basis: 'merchant-history', observations: 3, agreeing: 3 }),
    'Inferred from merchant history (3)');
  assert.equal(categoryInferenceText({ category: 'Transportation-Fuel', basis: 'rule', rule: 'fuel-brand' }), 'Inferred by rule: Fuel brand');
  // A rule this build does not know is named by its id.
  assert.equal(categoryInferenceText({ category: 'Other-Miscellaneous', basis: 'rule', rule: 'some-later-rule' }), 'Inferred by rule: some-later-rule');
});

test('typing what a charge counts under anyway sets no category of the owner\'s, an inferred one included', () => {
  const inferred = { category: 'Transportation-Fuel' };
  assert.equal(ownCategoryFromInput(inferred, ' Transportation-Fuel '), null);
  assert.equal(ownCategoryFromInput(inferred, ''), null);
  assert.equal(ownCategoryFromInput(inferred, 'Uncategorized'), null);
  assert.equal(ownCategoryFromInput(inferred, ' Car '), 'Car');
  const issued = { issuerCategory: 'Travel', category: 'Travel' };
  assert.equal(ownCategoryFromInput(issued, 'Travel'), null);
  assert.equal(ownCategoryFromInput(issued, 'Vacation'), 'Vacation');
  // The owner's own stays theirs; the issuer's category, or nothing, clears it.
  const own = { userCategory: 'Vacation', issuerCategory: 'Travel', category: 'Vacation' };
  assert.equal(ownCategoryFromInput(own, 'Vacation'), 'Vacation');
  assert.equal(ownCategoryFromInput(own, 'Travel'), null);
  assert.equal(ownCategoryFromInput(own, '  '), null);
  assert.equal(ownCategoryFromInput({ userCategory: 'Snacks', category: 'Snacks' }, 'Snacks'), 'Snacks');
});

test('a tax payment filed under Taxes over its issuer\'s category: typed, the issuer\'s category is the owner\'s', () => {
  // Synthetic issuer category; the IRS's words for a card payment.
  const tax = { kind: 'purchase' as const, description: 'US TREASURY TAX PAYMENT', issuerCategory: 'Business Services-Utilities' };
  // Enriched answers say where each row's category comes from.
  const filed = { ...tax, category: 'Taxes', categorySource: 'inferred' as const };
  assert.equal(ownCategoryFromInput(filed, 'Business Services-Utilities'), 'Business Services-Utilities');
  assert.equal(ownCategoryFromInput(filed, 'Taxes'), null);
  assert.equal(ownCategoryFromInput(filed, ''), null);
  // Filed under the owner's own: the issuer's category typed stays theirs, and nothing clears it.
  const own = { ...tax, userCategory: 'Mine', category: 'Mine', categorySource: 'user' as const };
  assert.equal(ownCategoryFromInput(own, 'Business Services-Utilities'), 'Business Services-Utilities');
  assert.equal(ownCategoryFromInput(own, ' '), null);
  // On the original basis it counts under the issuer's category anyway: typed there, it sets nothing and clears the
  // owner's own, as for any charge.
  assert.equal(ownCategoryFromInput({ ...tax, category: 'Business Services-Utilities' }, 'Business Services-Utilities'), null);
  assert.equal(ownCategoryFromInput({ ...tax, userCategory: 'Mine', category: 'Mine' }, 'Business Services-Utilities'), null);
  // The merchant name counts as much as the descriptor, and so does a processor fee's refund (an adjustment); a card's own
  // fee (its fee wording) is never filed over its issuer's category.
  assert.equal(ownCategoryFromInput({ ...filed, description: 'SAMPLE 0042', merchant: 'US Treasury' }, 'Business Services-Utilities'),
    'Business Services-Utilities');
  assert.equal(ownCategoryFromInput({ ...filed, kind: 'adjustment' as const, description: 'SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE REFUND' },
    'Business Services-Utilities'), 'Business Services-Utilities');
  assert.equal(ownCategoryFromInput({ ...tax, kind: 'fee' as const, description: 'CASH ADVANCE FEE US TREASURY', category: 'Business Services-Utilities',
    categorySource: 'issuer' as const }, 'Business Services-Utilities'), null);
  // Without an issuer's category, Uncategorized still sets nothing.
  assert.equal(ownCategoryFromInput({ kind: 'purchase', description: 'US TREASURY TAX PAYMENT', category: 'Taxes', categorySource: 'inferred' },
    'Uncategorized'), null);
  // Once the issuer's category is the owner's, leaving it as it is keeps it, on either basis: a row just saved (the
  // PATCH answer has no categorySource) and the original basis included. Only empty clears it.
  const pinned = { ...tax, userCategory: 'Business Services-Utilities', category: 'Business Services-Utilities' };
  assert.equal(ownCategoryFromInput(pinned, 'Business Services-Utilities'), 'Business Services-Utilities');
  assert.equal(ownCategoryFromInput({ ...pinned, categorySource: 'user' as const }, ' Business Services-Utilities '), 'Business Services-Utilities');
  assert.equal(ownCategoryFromInput(pinned, ''), null);
});
test('a linked order\'s item lines carry their ref and whether a thumbnail is cached; the rest of the charge has neither', () => {
  const lines = amazonOrderLines({
    parts: [{ category: 'Home', amountMinor: 900, categorySource: 'agent-classification', classification: 'source', itemRef: 'item-a' },
      { category: 'Groceries', amountMinor: 100, categorySource: 'original-effective', classification: 'residual' }],
    items: [
      { itemRef: 'item-a', title: 'Sample lamp', quantity: 1, asin: 'B0SAMPLE21', image: true },
      { itemRef: 'item-b', title: 'Sample mug', quantity: 1, asin: 'B0SAMPLE22' },
      { itemRef: 'item-c', title: 'Sample rug', quantity: 1, asin: null, image: false },
    ],
  });
  assert.deepEqual(lines.map((line) => [line.kind, line.itemRef, line.image]), [
    ['item', 'item-a', true], ['item', 'item-b', false], ['item', 'item-c', false], ['rest', null, false],
  ]);
});

test('a card\'s name says its issuer once, and leaves out a card network and its tier at the end', () => {
  // Made-up nicknames only.
  const account = (issuer: string, nickname?: string) => ({ issuer, nickname });
  // Already named after the issuer: not prefixed again, before a space or a slash.
  assert.equal(shortCardName(account('sample-bank', 'Sample Bank Palladium')), 'Sample Bank Palladium');
  assert.equal(shortCardName(account('citi', 'Citi/Sample Miles Executive World Legend Mastercard')), 'Citi Sample Miles Executive');
  assert.equal(shortCardName(account('citi', 'CITI Sample Rewards')), 'Citi Sample Rewards');
  assert.equal(shortCardName(account('amex', 'American Express Sample Gold')), 'Amex Sample Gold');
  // Not named after it: the issuer first, as before; a word that only begins like the issuer's name is not its name.
  assert.equal(shortCardName(account('chase', 'Sample Preferred Visa Signature')), 'Chase Sample Preferred');
  assert.equal(shortCardName(account('citi', 'Citizen Sample')), 'Citi Citizen Sample');
  assert.equal(shortCardName(account('amex', 'Sample Business Gold Card')), 'Amex Sample Business Gold Card');
  // Nothing else to say: the issuer alone; a name that is only a network stays as it is.
  assert.equal(shortCardName(account('chase', 'Chase')), 'Chase');
  assert.equal(shortCardName(account('chase')), 'Chase');
  assert.equal(shortCardName(account('chase', ' Visa')), 'Chase Visa');
  // The issuer once, the network and tier kept; and the previous name, as it was always shown.
  assert.equal(issuerOnceCardName(account('citi', 'Citi/Sample Miles World Mastercard')), 'Citi Sample Miles World Mastercard');
  assert.equal(issuerOnceCardName(account('chase', 'Sample Preferred Visa Signature')), 'Chase Sample Preferred Visa Signature');
  assert.equal(fullCardName(account('citi', 'Citi/Sample Miles World Mastercard')), 'Citi Citi/Sample Miles World Mastercard');
});

test('no two cards read alike that did not before: the issuer once, the network and tier left out only where unique', () => {
  type Card = Parameters<typeof cardDisplayNames>[0][number];
  const card = (id: string, issuer: string, nickname: string, last4?: string): Card => ({ id, issuer, nickname, last4, last5: undefined } as Card);
  const names = (cards: Card[]) => [...cardDisplayNames(cards).values()];
  // Two tiers of one card and no ending: the issuer once, each keeps its network and tier.
  assert.deepEqual(names([
    card('a', 'citi', 'Citi Review Miles World Elite Mastercard'), card('b', 'citi', 'Citi Review Miles World Mastercard'),
  ]), ['Citi Review Miles World Elite Mastercard', 'Citi Review Miles World Mastercard']);
  // The same last four, which is legal: the same. Different endings tell them apart: both said shorter.
  assert.deepEqual(names([
    card('a', 'chase', 'Chase Review Summit Visa Signature', '7010'), card('b', 'chase', 'Chase Review Summit Visa Infinite', '7010'),
  ]), ['Chase Review Summit Visa Signature', 'Chase Review Summit Visa Infinite']);
  assert.deepEqual(names([
    card('a', 'chase', 'Chase Review Summit Visa Signature', '7011'), card('b', 'chase', 'Chase Review Summit Visa Infinite', '7012'),
  ]), ['Chase Review Summit', 'Chase Review Summit']);
  // Said once, the issuer would make two names alike: those two keep their previous names, with the same ending or none.
  assert.deepEqual(names([card('a', 'citi', 'Citi/Sample'), card('b', 'citi', 'Sample')]), ['Citi Citi/Sample', 'Citi Sample']);
  assert.deepEqual(names([card('a', 'citi', 'Citi/Sample', '4321'), card('b', 'citi', 'Sample', '4321')]), ['Citi Citi/Sample', 'Citi Sample']);
  // A previous name never reads like another card's name either: that card keeps its previous name as well.
  assert.deepEqual(names([
    card('a', 'citi', 'Citi/Sample Miles'), card('b', 'citi', 'Sample Miles'), card('c', 'citi', 'Citi Citi/Sample Miles'),
  ]), ['Citi Citi/Sample Miles', 'Citi Sample Miles', 'Citi Citi Citi/Sample Miles']);
  // Only the shorter name gives way to a name that keeps its tier: that card's issuer stays said once.
  assert.deepEqual(names([
    card('a', 'citi', 'Citi Sample World Mastercard'), card('b', 'citi', 'Sample World Elite Mastercard'), card('c', 'citi', 'Sample World Mastercard Visa'),
  ]), ['Citi Sample World Mastercard', 'Citi Sample World Elite Mastercard', 'Citi Sample World Mastercard Visa']);
  // The same nickname reads alike either way: the issuer once, the tier kept, as said shorter they would still be alike.
  assert.deepEqual(names([card('a', 'citi', 'Citi/Sample World Mastercard'), card('b', 'citi', 'Citi/Sample World Mastercard')]),
    ['Citi Sample World Mastercard', 'Citi Sample World Mastercard']);
  // Other issuers' cards and one card alone: said shorter.
  assert.deepEqual(names([
    card('a', 'citi', 'Citi/Sample Miles Executive World Elite Mastercard', '4321'), card('b', 'chase', 'Sample Miles Executive Visa', '4321'),
  ]), ['Citi Sample Miles Executive', 'Chase Sample Miles Executive']);
});

test('cards are compared by their labels as shown, ending included, as they could be mistaken for each other', () => {
  type Card = Parameters<typeof cardDisplayNames>[0][number];
  const card = (id: string, nickname: string, last4?: string): Card => ({ id, issuer: 'citi', nickname, last4, last5: undefined } as Card);
  const labels = (cards: Card[]) => {
    const names = cardDisplayNames(cards);
    return cards.map((item) => [names.get(item.id), item.last4 ? `··${item.last4}` : null].filter(Boolean).join(' '));
  };
  // A nickname that ends like a label's ending: said shorter, the other card would read the same.
  assert.deepEqual(labels([card('a', 'Review Literal Visa', '7061'), card('b', 'Review Literal ··7061')]),
    ['Citi Review Literal Visa ··7061', 'Citi Review Literal ··7061']);
  assert.deepEqual(labels([card('a', 'Citi/Review Literal', '7061'), card('b', 'Review Literal ··7061')]),
    ['Citi Citi/Review Literal ··7061', 'Citi Review Literal ··7061']);
  // Letter case, spaces, punctuation, accents, a look-alike letter, an invisible character: alike all the same.
  for (const other of ['REVIEW  LITERAL', 'Review-Literal.', 'Révïew Literal', 'Review Lit\u0435ral', 'Review L\u03b9teral', 'Review\u200b Literal', 'Review Literal··']) {
    assert.deepEqual(labels([card('a', 'Review Literal Visa'), card('b', other)]), ['Citi Review Literal Visa', `Citi ${other}`], other);
  }
  // Told apart by a letter or a digit: said shorter. A letter of another script is compared as it is, unless it is one
  // of the curated look-alikes (CJK names too: their issuer once, their network and tier left out).
  assert.deepEqual(labels([card('a', 'Review Literal Visa', '7061'), card('b', 'Review Literal ··7062')]),
    ['Citi Review Literal ··7061', 'Citi Review Literal ··7062']);
  assert.deepEqual(labels([card('a', 'Review Literal Visa'), card('b', 'Review Lateral')]), ['Citi Review Literal', 'Citi Review Lateral']);
  assert.deepEqual(labels([card('a', 'Review Literal Visa'), card('b', 'Review Lit\u0436ral')]), ['Citi Review Literal', 'Citi Review Lit\u0436ral']);
  assert.deepEqual(labels([card('a', 'Citi/交通'), card('b', '餐饮')]), ['Citi 交通', 'Citi 餐饮']);
  assert.deepEqual(labels([card('a', '交通 Visa'), card('b', '餐饮 Visa')]), ['Citi 交通', 'Citi 餐饮']);
  assert.deepEqual(labels([card('a', 'Citi/交通', '7016'), card('b', '交通', '7016')]), ['Citi Citi/交通 ··7016', 'Citi 交通 ··7016']);
});

test('labels name each card as all the household\'s cards known allow: closed ones, and one created since a list was read', () => {
  type Card = Parameters<typeof cardNameLabel>[0] & object;
  const card = (id: string, nickname: string, last4?: string, status = 'active') =>
    ({ id, issuer: 'citi', nickname, last4, owner: 'joint', status } as unknown as Card);
  forgetCardAccounts();
  const existing = card('existing', 'Citi Review Addition Visa');
  rememberCardAccounts([existing, card('other', 'Sample Rewards', '1111')]);
  assert.equal(cardOptionLabel(existing), 'Citi Review Addition · Joint');
  // One created (an import's preview does): both are named again at once, and a list read before it forgets it not.
  const created = card('created', 'Review Addition');
  rememberCardAccounts([created]);
  assert.deepEqual([cardOptionLabel(existing), cardOptionLabel(created)], ['Citi Review Addition Visa · Joint', 'Citi Review Addition · Joint']);
  rememberCardAccounts([existing]);
  assert.equal(cardOptionLabel(existing), 'Citi Review Addition Visa · Joint');
  // An answer that is not a card account is left out, never an error.
  rememberCardAccounts(undefined);
  rememberCardAccounts([{} as Card, { id: 'no-issuer' } as unknown as Card]);
  assert.equal(cardOptionLabel(existing), 'Citi Review Addition Visa · Joint');
  forgetCardAccounts();
});

test('labels name each card as the household\'s cards known allow, closed ones too; any other card by its previous name', () => {
  type Card = Parameters<typeof cardNameLabel>[0] & object;
  const card = (id: string, nickname: string, last4?: string, status = 'active') =>
    ({ id, issuer: 'citi', nickname, last4, owner: 'alex', status } as unknown as Card);
  forgetCardAccounts();
  const solo = card('solo', 'Citi/Sample Miles World Elite Mastercard', '4321');
  rememberCardAccounts([solo, card('other', 'Sample Rewards', '1111')]);
  assert.equal(cardNameLabel(solo), 'Citi Sample Miles ··4321');
  assert.deepEqual(cardNameParts(solo), { name: 'Citi Sample Miles', ending: '4321' });
  assert.equal(cardOptionLabel(solo), 'Citi Sample Miles ··4321 · Alex');
  // A card not known, or changed since: nothing says it stays unique, so its previous name.
  assert.equal(cardNameLabel(card('new', 'Citi/Sample Miles', '9999')), 'Citi Citi/Sample Miles ··9999');
  assert.equal(cardNameLabel({ ...solo, nickname: 'Citi/Sample Miles Visa' }), 'Citi Citi/Sample Miles Visa ··4321');
  // Two tiers with the same ending: the issuer once, each keeps its tier, everywhere a label is made.
  const twin = card('twin', 'Citi/Sample Miles World Mastercard', '4321');
  rememberCardAccounts([solo, twin]);
  assert.equal(cardNameLabel(solo), 'Citi Sample Miles World Elite Mastercard ··4321');
  assert.deepEqual(cardNameParts(twin), { name: 'Citi Sample Miles World Mastercard', ending: '4321' });
  assert.equal(cardOptionLabel(twin), 'Citi Sample Miles World Mastercard ··4321 · Alex');
  // A closed card counts too, though a list may leave it out.
  const closed = card('closed', 'Citi/Sample Miles World Mastercard', undefined, 'closed');
  const open = card('open', 'Citi/Sample Miles World Elite Mastercard');
  rememberCardAccounts([open, closed]);
  assert.equal(cardOptionLabel(open), 'Citi Sample Miles World Elite Mastercard · Alex');
  assert.equal(cardOptionLabel(closed), 'Citi Sample Miles World Mastercard · Alex (closed)');
  forgetCardAccounts();
});
