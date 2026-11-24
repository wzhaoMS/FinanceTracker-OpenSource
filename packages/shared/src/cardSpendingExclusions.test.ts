import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_ASSET_CATEGORY,
  cardSpendingRole,
  isCardAssetCategory,
  ownerCardSpendingExclusion,
  summarizeCardSpending,
  toCardTransactionView,
  withCardSpendingExclusion,
  type CardSpendingExclusion,
} from './cardSpending.js';
import {
  CARD_METALS_MERCHANT_CLASSES,
  CARD_METALS_SUGGESTION_FLOORS,
  buildCardSpendingAccounting,
  cardMetalsMerchantClass,
  cardRefundSeller,
  cardSellerChannel,
  previewCardSpendingRule,
  resolveCardSpendingExclusions,
  suggestCardAssetPurchases,
  type CardExclusionRow,
  type CardSpendingRule,
} from './cardSpendingExclusions.js';
import { computeCardInsights } from './cardInsights.js';
import type { CardTransaction, CardTransactionKind } from './types.js';

// Synthetic rows only: made-up descriptors in the shapes issuers use, made-up amounts and card ids.
let sequence = 0;
function row(overrides: Partial<CardExclusionRow & { issuerCategory: string | null }> = {}): CardExclusionRow & { issuerCategory?: string | null } {
  sequence += 1;
  return {
    id: `row-${String(sequence).padStart(4, '0')}`,
    cardAccountId: 'card-acct-a',
    transactionDate: '2026-09-10',
    status: 'posted',
    kind: 'purchase',
    amountMinor: 1000,
    currency: 'USD',
    description: 'SAMPLE STORE',
    merchant: null,
    userCategory: null,
    ...overrides,
  };
}

function rule(overrides: Partial<CardSpendingRule> = {}): CardSpendingRule {
  return {
    id: `csr_${'a'.repeat(32)}`,
    reason: 'asset-purchase',
    category: CARD_ASSET_CATEGORY,
    merchantClass: 'costco-online',
    currency: 'USD',
    minAmountMinor: 100000,
    createdAt: '2026-10-01T00:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

const ONLINE = 'COSTCO.COM *ONLINE SAMPLE WA';
const WAREHOUSE = 'COSTCO WHSE #0042 SAMPLETOWN WA';

describe('the owner\'s asset category', () => {
  it('is "Precious metals" however it is spelled, and nothing else', () => {
    for (const name of ['Precious metals', 'precious metals', 'PRECIOUS METALS', 'Precious Metal', ' precious-metals ', 'Précious metals']) {
      assert.equal(isCardAssetCategory(name), true, name);
    }
    for (const name of [null, undefined, '', 'Metals', 'Gold', 'Precious metals and gems', 'Wholesale Stores', 'precious']) {
      assert.equal(isCardAssetCategory(name), false, String(name));
    }
  });

  it('makes only a spending row an asset purchase; a card payment or an other row keeps its role', () => {
    const owner: CardSpendingExclusion = { reason: 'asset-purchase', source: 'owner-category' };
    for (const kind of ['purchase', 'refund', 'fee', 'interest', 'adjustment'] as CardTransactionKind[]) {
      assert.deepEqual(ownerCardSpendingExclusion({ kind, userCategory: 'Precious metals' }), owner, kind);
    }
    assert.equal(ownerCardSpendingExclusion({ kind: 'payment', userCategory: 'Precious metals' }), null);
    assert.equal(ownerCardSpendingExclusion({ kind: 'other', userCategory: 'Precious metals' }), null);
    assert.equal(ownerCardSpendingExclusion({ kind: 'purchase', userCategory: 'Groceries' }), null);
  });
});

describe('descriptor classes', () => {
  it('reads merchant names and descriptors alike, punctuation and case aside', () => {
    const cases: Array<[string, string | null, string | null]> = [
      ['APMEX', null, 'bullion-dealer'],
      ['SAMPLE PAY*JM BULLION', null, 'bullion-dealer'],
      ['U.S. MINT SAMPLE', null, 'bullion-dealer'],
      ['SAMPLE PRECIOUS METALS LLC', null, 'bullion-dealer'],
      [ONLINE, null, 'costco-online'],
      ['WWW.COSTCO.COM', null, 'costco-online'],
      ['SAMPLE', 'Costco.com', 'costco-online'],
      ['Walmart.com 800-555-0100 AR', null, 'walmart-online'],
      ['WAL-MART.COM SAMPLE', null, 'walmart-online'],
      ['WALMART MARKETPLACE', null, 'walmart-online'],
      ['SAMSCLUB.COM', null, 'sams-club'],
      ["SAM'S CLUB #0042", null, 'sams-club'],
      [WAREHOUSE, null, 'costco-warehouse'],
      ['COSTCO WHOLESALE', null, 'costco-warehouse'],
      // Never a class: what cannot be bullion.
      ['COSTCO GAS #0042', null, null],
      ['COSTCO TRAVEL', null, null],
      ['COSTCO OPTICAL #0042', null, null],
      ['COSTCO PHARMACY #0042', null, null],
      ['SAMS CLUB FUEL #0042', null, null],
      ['WAL-MART #0042', null, null],
      ['WALMART SUPERCENTER #0042', null, null],
      ['WM SUPERCENTER #0042', null, null],
      ['GOLDEN SAMPLE DINER', null, null],
      ['SAMPLE MINT MOBILE', null, null],
    ];
    for (const [description, merchant, expected] of cases) {
      assert.equal(cardMetalsMerchantClass({ description, merchant }), expected, `${description} / ${merchant}`);
    }
    // The online descriptor wins over a warehouse merchant name; a never class wins over Costco.
    assert.equal(cardMetalsMerchantClass({ description: ONLINE, merchant: 'Costco Wholesale' }), 'costco-online');
    assert.equal(cardMetalsMerchantClass({ description: 'COSTCO GAS #0042', merchant: 'Costco' }), null);
  });

  it('documents a floor and a tier for every class', () => {
    assert.deepEqual(Object.keys(CARD_METALS_SUGGESTION_FLOORS).sort(), [...CARD_METALS_MERCHANT_CLASSES].sort());
    assert.deepEqual(CARD_METALS_SUGGESTION_FLOORS, {
      'bullion-dealer': { floor: 0, tier: 'likely' },
      'costco-online': { floor: 1000, tier: 'possible' },
      'walmart-online': { floor: 1000, tier: 'possible' },
      'sams-club': { floor: 1000, tier: 'possible' },
      'costco-warehouse': { floor: 5000, tier: 'weak' },
    });
  });

  it('lets a never-word or a Walmart store veto at any position: no class, no suggestion, no rule', () => {
    const sellers = ['COSTCO', 'COSTCO WHSE', 'COSTCO.COM', 'WWW.COSTCO.COM', 'SAMS CLUB', 'SAMSCLUB.COM', 'WALMART.COM', 'APMEX', 'SAMPLE BULLION'];
    const words = ['GAS', 'Fuel', 'gasoline', 'TRAVEL', 'Optical', 'PHARMACY', 'pharm', 'RX'];
    const shapes = [
      (seller: string, word: string) => ({ description: `${seller} ${word} #0042 SAMPLETOWN WA` }),
      (seller: string, word: string) => ({ description: `${seller} #001 ${word}` }),
      (seller: string, word: string) => ({ description: `${word}*${seller} 800-555-0100` }),
      (seller: string, word: string) => ({ description: `${seller}/${word.toLowerCase()}-sample` }),
      (seller: string, word: string) => ({ description: `${seller} #0042`, merchant: `${seller} ${word}` }),
    ];
    const rules = CARD_METALS_MERCHANT_CLASSES.map((merchantClass, index) => rule({ id: `csr_${'abcde'[index].repeat(32)}`, merchantClass, minAmountMinor: 1 }));
    for (const seller of sellers) {
      for (const word of words) {
        for (const shape of shapes) {
          const fields = shape(seller, word);
          const label = JSON.stringify(fields);
          assert.equal(cardMetalsMerchantClass(fields), null, label);
          const charge = row({ ...fields, amountMinor: 500_001 });
          const exclusions = resolveCardSpendingExclusions([charge], rules);
          assert.equal(exclusions.size, 0, label);
          assert.deepEqual(suggestCardAssetPurchases([charge], exclusions), [], label);
          // The owner's own category still decides it.
          assert.equal(resolveCardSpendingExclusions([{ ...charge, userCategory: 'Precious metals' }], rules).get(charge.id)?.source, 'owner-category', label);
        }
      }
    }
    for (const description of ['WAL-MART #0042 SAMPLETOWN', 'WALMART SUPERCENTER', 'WM SUPERCENTER #12', 'WAL MART 1234', 'WALMART STORE 0042',
      'WALMART.COM WAL-MART #0042', 'SAMPLE WALMART NEIGHBORHOOD MARKET']) {
      assert.equal(cardMetalsMerchantClass({ description }), null, description);
    }
    // Words that only contain a never-word are not one.
    assert.equal(cardMetalsMerchantClass({ description: 'COSTCO WHSE #0042 GASTONIA NC' }), 'costco-warehouse');
    assert.equal(cardMetalsMerchantClass({ description: 'BGASC' }), 'bullion-dealer');
    assert.equal(cardMetalsMerchantClass({ description: 'WALMART.COM 800-555-0100 AR' }), 'walmart-online');
  });

  it('names a seller exactly: each dealer apart, Costco online and warehouse together, Walmart.com apart from its stores', () => {
    const seller = (description: string, merchant?: string) => cardRefundSeller({ description, merchant });
    const merchant = (description: string, name?: string) => seller(description, name).merchant;
    assert.equal(merchant('APMEX'), merchant('APMEX.COM RETURN'));
    assert.notEqual(merchant('APMEX'), merchant('JM BULLION'));
    for (const [a, b] of [['JM BULLION', 'SD BULLION'], ['KITCO', 'MONEY METALS'], ['U.S. MINT', 'APMEX'], ['SAMPLE BULLION', 'OTHER BULLION']]) {
      assert.notEqual(merchant(a), merchant(b), `${a} / ${b}`);
    }
    assert.equal(merchant('U.S. MINT SAMPLE'), merchant('UNITED STATES MINT'));
    assert.equal(merchant(ONLINE), merchant(WAREHOUSE));
    assert.equal(merchant(ONLINE), merchant('COSTCO WHOLESALE RETURN'));
    assert.notEqual(merchant('WALMART.COM 800-555-0100 AR'), merchant('WAL-MART #0042'));
    assert.equal(merchant('WALMART.COM 800-555-0100 AR'), merchant('WALMART MARKETPLACE'));
    assert.equal(merchant('SAMPLE TV STORE'), merchant('SAMPLE TV STORE RETURN'));
    // One merchant, two channels: the descriptor says which, whatever merchant name the issuer gives both.
    assert.deepEqual(seller('SAMSCLUB.COM', "SAM'S CLUB"), { merchant: 'sams-club', channel: 'online' });
    assert.deepEqual(seller("SAM'S CLUB #001", "SAM'S CLUB"), { merchant: 'sams-club', channel: 'store' });
    assert.deepEqual(seller('TARGET.COM', 'TARGET'), { ...seller('TARGET STORE #001', 'TARGET'), channel: 'online' });
    assert.equal(seller('TARGET STORE #001', 'TARGET').channel, 'store');
    assert.deepEqual(seller(ONLINE), { merchant: 'costco', channel: 'online' });
    assert.deepEqual(seller(WAREHOUSE), { merchant: 'costco', channel: 'store' });
  });

  it('reads the channel from the descriptor alone: online, store, or unknown when it shows neither or both', () => {
    const cases: Array<[string, string]> = [
      ['SAMSCLUB.COM', 'online'], ['WWW.SAMPLE.COM', 'online'], ['SYNTHETIC COINS ONLINE', 'online'], ['APMEX.COM RETURN', 'online'],
      ['WALMART.COM 800-555-0100 AR', 'online'], [ONLINE, 'online'], ['SAMPLE.COM SAMPLETOWN WA', 'online'],
      ["SAM'S CLUB #001", 'store'], ['TARGET STORE #001', 'store'], [WAREHOUSE, 'store'], ['SAMPLE TV STORE 42', 'store'],
      ['SAMPLE GROCER SAMPLETOWN WA', 'store'], ['SAMPLE GROCER SAMPLETOWN WA 98101 US', 'store'], ['SAMPLE CAFE #12', 'store'],
      ['APMEX', 'unknown'], ['SYNTHETIC COINS', 'unknown'], ['COSTCO WHOLESALE', 'unknown'], ['SAMPLE TV STORE', 'unknown'],
      ['SAMPLE.COM #0042', 'unknown'], ['WWW SAMPLE STORE 0042', 'unknown'], ['AMZN MKTP US*2K4AB1', 'unknown'], ['SAMPLE WA', 'unknown'],
      ['SAMPLE 800-555-0100 WA', 'unknown'],
    ];
    for (const [description, channel] of cases) assert.equal(cardSellerChannel(description), channel, description);
  });
});

describe('resolveCardSpendingExclusions', () => {
  it('lets the owner\'s category on the row decide, before any rule', () => {
    const mine = row({ description: ONLINE, amountMinor: 420_000, userCategory: 'precious metals' });
    const notMetals = row({ description: ONLINE, amountMinor: 420_000, userCategory: 'Electronics' });
    const ruled = row({ description: ONLINE, amountMinor: 420_000 });
    const exclusions = resolveCardSpendingExclusions([mine, notMetals, ruled], [rule()]);
    assert.deepEqual([...exclusions], [
      [mine.id, { reason: 'asset-purchase', source: 'owner-category' }],
      [ruled.id, { reason: 'asset-purchase', source: 'owner-rule', ruleId: rule().id }],
    ]);
  });

  it('applies a rule in force to covered purchases of any status, past or future, and nothing else', () => {
    const covered = [
      row({ description: ONLINE, amountMinor: 100_000, transactionDate: '2024-01-05' }),
      row({ description: ONLINE, amountMinor: 999_999, transactionDate: '2027-01-05' }),
      row({ description: ONLINE, amountMinor: 250_000, status: 'pending' }),
    ];
    const untouched = [
      row({ description: ONLINE, amountMinor: 99_999 }),
      row({ description: ONLINE, amountMinor: 250_000, currency: 'CAD' }),
      row({ description: WAREHOUSE, amountMinor: 900_000 }),
      row({ description: ONLINE, amountMinor: 250_000, status: 'removed' }),
      row({ description: ONLINE, amountMinor: -250_000, kind: 'refund', transactionDate: '2026-01-01' }),
      row({ description: ONLINE, amountMinor: 250_000, kind: 'fee' }),
      row({ description: ONLINE, amountMinor: -250_000, kind: 'payment' }),
    ];
    const exclusions = resolveCardSpendingExclusions([...covered, ...untouched], [rule()]);
    assert.deepEqual([...exclusions.keys()].sort(), covered.map((item) => item.id).sort());
    assert.equal(resolveCardSpendingExclusions(covered, [rule({ revokedAt: '2026-10-02T00:00:00.000Z' })]).size, 0);
    // The oldest rule in force that covers a row is the one it names.
    const later = rule({ id: `csr_${'b'.repeat(32)}`, createdAt: '2026-10-05T00:00:00.000Z', minAmountMinor: 1 });
    assert.equal(resolveCardSpendingExclusions([covered[0]], [later, rule()]).get(covered[0].id)?.ruleId, rule().id);
  });

  it('takes out a refund only when it gives back one excluded purchase exactly, to the cent and alone', () => {
    const metals = row({ description: ONLINE, amountMinor: 412_399, transactionDate: '2026-03-02', userCategory: 'Precious metals' });
    const exact = row({ description: 'COSTCO.COM RETURN', kind: 'refund', amountMinor: -412_399, transactionDate: '2026-03-20' });
    const exclusions = resolveCardSpendingExclusions([metals, exact]);
    assert.deepEqual(exclusions.get(exact.id), { reason: 'asset-purchase', source: 'paired-refund', purchaseId: metals.id });

    // A partial refund, another card, past the window, before the purchase, another amount: spending stays spending.
    for (const refund of [
      { amountMinor: -200_000 },
      { cardAccountId: 'card-acct-b' },
      { transactionDate: '2026-06-05' },
      { transactionDate: '2026-03-01' },
      { amountMinor: -412_398 },
      { description: 'SAMPLE HARDWARE' },
      { userCategory: 'Returns' },
    ]) {
      const other = { ...exact, ...refund, id: 'row-refund' };
      assert.equal(resolveCardSpendingExclusions([metals, other]).has('row-refund'), false, JSON.stringify(refund));
    }
  });

  it('pairs nothing when two purchases could be the one given back, excluded or not', () => {
    const first = row({ description: ONLINE, amountMinor: 300_000, transactionDate: '2026-02-01', userCategory: 'Precious metals' });
    const second = row({ description: ONLINE, amountMinor: 300_000, transactionDate: '2026-02-10', userCategory: 'Precious metals' });
    const ordinary = row({ description: ONLINE, amountMinor: 300_000, transactionDate: '2026-02-10' });
    const refund = row({ description: ONLINE, kind: 'refund', amountMinor: -300_000, transactionDate: '2026-02-20' });
    assert.equal(resolveCardSpendingExclusions([first, second, refund]).has(refund.id), false);
    assert.equal(resolveCardSpendingExclusions([first, ordinary, refund]).has(refund.id), false);
    // A larger purchase at the same merchant could be the one partly refunded: no pair, and the owner is asked.
    const larger = row({ description: ONLINE, amountMinor: 250_000 + 300_000, transactionDate: '2026-02-03' });
    const withLarger = resolveCardSpendingExclusions([first, larger, refund]);
    assert.equal(withLarger.has(refund.id), false);
    const asked = suggestCardAssetPurchases([first, larger, refund], withLarger).find((item) => item.id === refund.id);
    assert.deepEqual(asked?.signals, ['refund-of-excluded', 'refund-of-suggested', 'ambiguous-refund']);
    // A larger purchase on another card, or more than 90 days before, competes with nothing.
    assert.equal(resolveCardSpendingExclusions([first, { ...larger, cardAccountId: 'card-acct-b' }, refund]).has(refund.id), true);
    assert.equal(resolveCardSpendingExclusions([first, { ...larger, transactionDate: '2025-10-01' }, refund]).has(refund.id), true);
    // One purchase is given back once: a second refund of the same amount is no pair either.
    const again = { ...refund, id: 'row-again', transactionDate: '2026-02-25' };
    const resolved = resolveCardSpendingExclusions([first, refund, again]);
    assert.equal(resolved.get(refund.id)?.purchaseId, first.id);
    assert.equal(resolved.has('row-again'), false);
  });

  it('never touches card payments, other rows or removed rows', () => {
    const rows = [
      row({ kind: 'payment', amountMinor: -500_000, userCategory: 'Precious metals' }),
      row({ kind: 'other', amountMinor: 500_000, userCategory: 'Precious metals' }),
      row({ status: 'removed', userCategory: 'Precious metals' }),
    ];
    assert.equal(resolveCardSpendingExclusions(rows, [rule()]).size, 0);
  });

  it('treats Costco\'s online and warehouse descriptors as one seller for a refund', () => {
    const metals = row({ description: ONLINE, amountMinor: 412_399, transactionDate: '2026-03-02', userCategory: 'Precious metals' });
    const back = row({ description: WAREHOUSE, kind: 'refund', amountMinor: -412_399, transactionDate: '2026-03-12' });
    assert.deepEqual(resolveCardSpendingExclusions([metals, back]).get(back.id), { reason: 'asset-purchase', source: 'paired-refund', purchaseId: metals.id });
    // Another seller is another merchant: a Walmart.com refund of the same amount gives nothing back.
    const walmart = { ...back, id: 'row-walmart', description: 'WALMART.COM 800-555-0100 AR' };
    assert.equal(resolveCardSpendingExclusions([metals, walmart]).has('row-walmart'), false);
  });

  it('lets the owner\'s word on a refund decide which purchase is given back', () => {
    const metals = row({ description: ONLINE, amountMinor: 300_000, transactionDate: '2026-02-01', userCategory: 'Precious metals' });
    const ordinary = row({ description: ONLINE, kind: 'refund', amountMinor: -300_000, transactionDate: '2026-02-05', userCategory: 'Groceries' });
    const later = row({ description: ONLINE, kind: 'refund', amountMinor: -300_000, transactionDate: '2026-02-08' });
    // The owner kept the first refund as spending: it gives nothing back, so the later one is the metals refund.
    const kept = resolveCardSpendingExclusions([metals, ordinary, later]);
    assert.equal(kept.has(ordinary.id), false);
    assert.deepEqual(kept.get(later.id), { reason: 'asset-purchase', source: 'paired-refund', purchaseId: metals.id });
    // The owner called the first refund the metals refund: the purchase is given back once, and the later one stays spending.
    const mine = { ...ordinary, userCategory: 'Precious metals' };
    const decided = resolveCardSpendingExclusions([metals, mine, later]);
    assert.deepEqual(decided.get(mine.id), { reason: 'asset-purchase', source: 'owner-category' });
    assert.equal(decided.has(later.id), false);
    assert.equal(suggestCardAssetPurchases([metals, mine, later], decided).some((item) => item.id === later.id), false);
  });

  it('pairs a refund only with a purchase from the same seller: dealers apart, Walmart.com apart from its stores', () => {
    const apmex = row({ description: 'APMEX.COM', amountMinor: 210_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const jm = row({ description: 'JMBULLION.COM', kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-20' });
    const cross = resolveCardSpendingExclusions([apmex, jm]);
    assert.equal(cross.has(jm.id), false);
    assert.deepEqual(suggestCardAssetPurchases([apmex, jm], cross), []);
    const apmexBack = { ...jm, id: 'row-apmex-back', description: 'APMEX.COM RETURN' };
    assert.equal(resolveCardSpendingExclusions([apmex, apmexBack]).get('row-apmex-back')?.purchaseId, apmex.id);
    const mint = row({ description: 'U.S. MINT ONLINE', amountMinor: 61_000, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const mintBack = row({ description: 'UNITED STATES MINT ONLINE', kind: 'refund', amountMinor: -61_000, transactionDate: '2026-09-05' });
    assert.equal(resolveCardSpendingExclusions([mint, mintBack]).get(mintBack.id)?.purchaseId, mint.id);
    // Walmart.com: a store's refund gives it nothing back, and a store purchase of the same amount competes with nothing.
    const online = row({ description: 'WALMART.COM 800-555-0100 AR', amountMinor: 250_099, transactionDate: '2026-05-10', userCategory: 'Precious metals' });
    const store = row({ description: 'WAL-MART #0042', amountMinor: 250_099, transactionDate: '2026-05-11' });
    const storeBack = row({ description: 'WAL-MART #0042', kind: 'refund', amountMinor: -250_099, transactionDate: '2026-05-20' });
    const onlineBack = row({ description: 'WALMART.COM RETURN', kind: 'refund', amountMinor: -250_099, transactionDate: '2026-05-21' });
    const walmart = resolveCardSpendingExclusions([online, store, storeBack, onlineBack]);
    assert.equal(walmart.has(storeBack.id), false);
    assert.equal(walmart.get(onlineBack.id)?.purchaseId, online.id);
  });

  it('pairs only within one known channel: a merchant name never hides an online order\'s store refund, and unknown is asked', () => {
    // The reviewer's three: the issuer gives the online order and the store's refund the same merchant name.
    const cases: Array<[merchant: string, online: string, store: string]> = [
      ["SAM'S CLUB", 'SAMSCLUB.COM', "SAM'S CLUB #001"],
      ['TARGET', 'TARGET.COM', 'TARGET STORE #001'],
      ['SYNTHETIC COINS', 'SYNTHETIC COINS ONLINE', 'SYNTHETIC COINS'],
    ];
    for (const [merchant, online, store] of cases) {
      const purchase = row({ merchant, description: online, amountMinor: 310_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
      const credit = row({ merchant, description: store, kind: 'refund', amountMinor: -310_123, transactionDate: '2026-09-20' });
      const rows = [purchase, credit];
      const exclusions = resolveCardSpendingExclusions(rows);
      assert.equal(exclusions.has(credit.id), false, merchant);
      // Still spending, and the owner's to decide: the same merchant, a channel that does not confirm the purchase's.
      assert.deepEqual(suggestCardAssetPurchases(rows, exclusions).map((item) => [item.id, item.signals]),
        [[credit.id, ['refund-of-excluded', 'channel-unconfirmed']]], merchant);
      const [usd] = buildCardSpendingAccounting(rows, { exclusions });
      assert.deepEqual([usd.notSpending.assetPurchases.netMinor, usd.spending.netMinor], [310_123, -310_123], merchant);
      // The same channel on both sides pairs: an online order and its online refund.
      const onlineBack = { ...credit, id: `${credit.id}-online`, description: `${online} RETURN` };
      assert.equal(resolveCardSpendingExclusions([purchase, onlineBack]).get(onlineBack.id)?.purchaseId, purchase.id, merchant);
    }
    // A store purchase and its store refund pair too; an unknown channel on either side never does.
    const visit = row({ merchant: 'TARGET', description: 'TARGET STORE #001', amountMinor: 120_001, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const visitBack = row({ merchant: 'TARGET', description: 'TARGET STORE #001', kind: 'refund', amountMinor: -120_001, transactionDate: '2026-09-04' });
    assert.equal(resolveCardSpendingExclusions([visit, visitBack]).get(visitBack.id)?.purchaseId, visit.id);
    const plain = row({ description: 'APMEX', amountMinor: 210_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const plainBack = row({ description: 'APMEX RETURN', kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-20' });
    const unknown = resolveCardSpendingExclusions([plain, plainBack]);
    assert.equal(unknown.has(plainBack.id), false);
    assert.deepEqual(suggestCardAssetPurchases([plain, plainBack], unknown).find((item) => item.id === plainBack.id)?.signals,
      ['refund-of-excluded', 'channel-unconfirmed']);
    // Costco alone pairs across its channels, both known: an online order refunded at a warehouse.
    const order = row({ description: ONLINE, amountMinor: 210_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const atWarehouse = row({ description: WAREHOUSE, kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-20' });
    assert.equal(resolveCardSpendingExclusions([order, atWarehouse]).get(atWarehouse.id)?.purchaseId, order.id);
    const wholesale = { ...atWarehouse, id: 'row-costco-unknown', description: 'COSTCO WHOLESALE RETURN' };
    assert.equal(resolveCardSpendingExclusions([order, wholesale]).has(wholesale.id), false);
    // A refund whose channel is not confirmed leaves the purchase's remaining amount unknown: no later refund pairs.
    const later = row({ description: ONLINE, kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-25' });
    const held = resolveCardSpendingExclusions([order, { ...wholesale, amountMinor: -10_000 }, later]);
    assert.equal(held.has(later.id), false);
    assert.deepEqual(suggestCardAssetPurchases([order, { ...wholesale, amountMinor: -10_000 }, later], held)
      .find((item) => item.id === later.id)?.signals, ['refund-of-excluded', 'after-earlier-refund']);
  });

  it('pairs a refund only with what remains of a purchase, refunds taken in posting order', () => {
    const purchase = row({ description: ONLINE, amountMinor: 210_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    // The owner's partial metals refund leaves the rest: a later credit of the original amount is no pair, and is asked.
    const partial = row({ description: ONLINE, kind: 'refund', amountMinor: -50_000, transactionDate: '2026-09-10', userCategory: 'Precious metals' });
    const full = row({ description: ONLINE, kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-20' });
    const afterPartial = resolveCardSpendingExclusions([purchase, partial, full]);
    assert.equal(afterPartial.has(full.id), false);
    assert.deepEqual(suggestCardAssetPurchases([purchase, partial, full], afterPartial).find((item) => item.id === full.id)?.signals,
      ['refund-of-excluded', 'after-earlier-refund']);
    // A credit of exactly what remains is the rest's refund; then nothing remains, nothing more pairs or is asked.
    const rest = row({ description: ONLINE, kind: 'refund', amountMinor: -160_123, transactionDate: '2026-09-20' });
    const again = row({ description: ONLINE, kind: 'refund', amountMinor: -160_123, transactionDate: '2026-09-25' });
    const settled = resolveCardSpendingExclusions([purchase, partial, rest, again]);
    assert.deepEqual(settled.get(rest.id), { reason: 'asset-purchase', source: 'paired-refund', purchaseId: purchase.id });
    assert.equal(settled.has(again.id), false);
    assert.equal(suggestCardAssetPurchases([purchase, partial, rest, again], settled).some((item) => item.id === again.id), false);

    // A partial refund nobody decided leaves the rest unknown: a later credit of the original amount is no pair.
    const undecided = { ...partial, userCategory: null };
    const unknown = resolveCardSpendingExclusions([purchase, undecided, full]);
    assert.equal(unknown.has(undecided.id), false);
    assert.equal(unknown.has(full.id), false);
    assert.deepEqual(suggestCardAssetPurchases([purchase, undecided, full], unknown).map((item) => [item.id, item.tier, item.signals]), [
      [full.id, 'possible', ['refund-of-excluded', 'after-earlier-refund']],
      [undecided.id, 'weak', ['refund-of-excluded', 'partial-refund']],
    ]);

    // Posting order decides: the partial refund posted first, so the original amount, though dated earlier, is no pair...
    const postedFirst = { ...undecided, postedDate: '2026-09-11' };
    const fullPostedLater = { ...full, transactionDate: '2026-09-08', postedDate: '2026-09-20' };
    assert.equal(resolveCardSpendingExclusions([purchase, fullPostedLater, postedFirst]).has(fullPostedLater.id), false);
    // ...and posted first, the original amount pairs, and the partial refund after it relates to nothing left.
    const fullPostedFirst = { ...full, transactionDate: '2026-09-08', postedDate: '2026-09-09' };
    const ordered = resolveCardSpendingExclusions([purchase, fullPostedFirst, postedFirst]);
    assert.equal(ordered.get(fullPostedFirst.id)?.purchaseId, purchase.id);
    assert.equal(ordered.has(postedFirst.id), false);
  });
});

describe('suggestCardAssetPurchases', () => {
  it('suggests by class and floor, and never a class that cannot be bullion', () => {
    const rows = [
      row({ description: 'APMEX', amountMinor: 5_123 }),
      row({ description: ONLINE, amountMinor: 100_001 }),
      row({ description: ONLINE, amountMinor: 99_999 }),
      row({ description: 'WALMART.COM', amountMinor: 250_099 }),
      row({ description: 'SAMSCLUB.COM', amountMinor: 180_042 }),
      row({ description: WAREHOUSE, amountMinor: 500_001 }),
      row({ description: WAREHOUSE, amountMinor: 499_999 }),
      row({ description: 'COSTCO TRAVEL', amountMinor: 900_099 }),
      row({ description: 'COSTCO GAS #0042', amountMinor: 900_099 }),
      row({ description: 'WAL-MART #0042', amountMinor: 900_099 }),
    ];
    const suggestions = suggestCardAssetPurchases(rows, new Map());
    assert.deepEqual(suggestions.map((item) => [item.amountMinor, item.merchantClass, item.tier]), [
      [5_123, 'bullion-dealer', 'likely'],
      [250_099, 'walmart-online', 'possible'],
      [180_042, 'sams-club', 'possible'],
      [100_001, 'costco-online', 'possible'],
      [500_001, 'costco-warehouse', 'weak'],
    ]);
    assert.deepEqual(suggestions[1].signals, ['online-big-box', 'at-or-over-floor']);
    assert.deepEqual(suggestions[4].signals, ['warehouse-descriptor', 'at-or-over-floor']);
  });

  it('drops a gift-card-like amount one tier', () => {
    const [dealer, online, warehouse] = suggestCardAssetPurchases([
      row({ description: 'KITCO', amountMinor: 50_000 }),
      row({ description: ONLINE, amountMinor: 150_000 }),
      row({ description: WAREHOUSE, amountMinor: 600_000 }),
    ], new Map()).sort((a, b) => a.amountMinor - b.amountMinor);
    assert.deepEqual([dealer.tier, online.tier, warehouse.tier], ['possible', 'weak', 'weak']);
    assert.ok(online.signals.includes('gift-card-like'));
  });

  it('leaves alone what the owner or a rule decided, and what is not posted', () => {
    const rows = [
      row({ description: ONLINE, amountMinor: 300_001, userCategory: 'Electronics' }),
      row({ description: ONLINE, amountMinor: 300_001, userCategory: 'Precious metals' }),
      row({ description: ONLINE, amountMinor: 300_001, status: 'pending' }),
      row({ description: ONLINE, amountMinor: 300_001 }),
    ];
    const exclusions = resolveCardSpendingExclusions(rows, [rule({ minAmountMinor: 300_001 })]);
    assert.deepEqual(suggestCardAssetPurchases(rows, exclusions), []);
  });

  it('carries a suggested purchase\'s exact refunds, and asks about partial and ambiguous ones apart', () => {
    const purchase = row({ description: ONLINE, amountMinor: 412_399, transactionDate: '2026-03-02' });
    const exact = row({ description: ONLINE, kind: 'refund', amountMinor: -412_399, transactionDate: '2026-03-12' });
    const bought = row({ description: ONLINE, amountMinor: 810_000 + 1, transactionDate: '2026-04-02' });
    const partial = row({ description: ONLINE, kind: 'refund', amountMinor: -405_000, transactionDate: '2026-04-09' });
    const confirmed = row({ description: ONLINE, amountMinor: 222_222, transactionDate: '2026-05-01', userCategory: 'Precious metals' });
    const twin = row({ description: ONLINE, amountMinor: 222_222, transactionDate: '2026-05-02' });
    const ambiguous = row({ description: ONLINE, kind: 'refund', amountMinor: -222_222, transactionDate: '2026-05-09' });
    const tv = row({ description: 'SAMPLE TV STORE', amountMinor: 120_000, transactionDate: '2026-05-01' });
    const tvRefund = row({ description: 'SAMPLE TV STORE', kind: 'refund', amountMinor: -120_000, transactionDate: '2026-05-03' });
    const rows = [purchase, exact, bought, partial, confirmed, twin, ambiguous, tv, tvRefund];
    const exclusions = resolveCardSpendingExclusions(rows);
    assert.equal(exclusions.has(ambiguous.id), false);
    const suggestions = suggestCardAssetPurchases(rows, exclusions);
    const byId = new Map(suggestions.map((item) => [item.id, item]));
    assert.deepEqual(byId.get(purchase.id)?.followingRefundIds, [exact.id]);
    assert.equal(byId.get(purchase.id)?.effectMinor, 0);
    assert.equal(byId.has(exact.id), false);
    assert.deepEqual(byId.get(partial.id)?.signals, ['refund-of-suggested', 'partial-refund']);
    assert.deepEqual(byId.get(partial.id)?.purchaseIds, [bought.id]);
    assert.deepEqual(byId.get(ambiguous.id)?.signals, ['refund-of-excluded', 'refund-of-suggested', 'ambiguous-refund']);
    assert.equal(byId.get(ambiguous.id)?.tier, 'possible');
    assert.equal(byId.has(tvRefund.id), false);
    assert.equal(byId.has(tv.id), false);
  });

  it('asks about a refund smaller than its seller\'s floor last, as weak', () => {
    const purchase = row({ description: ONLINE, amountMinor: 412_399, transactionDate: '2026-03-02' });
    const blender = row({ description: ONLINE, kind: 'refund', amountMinor: -4_599, transactionDate: '2026-03-12' });
    const dealer = row({ description: 'APMEX', amountMinor: 61_000, transactionDate: '2026-03-02' });
    const coin = row({ description: 'APMEX', kind: 'refund', amountMinor: -3_050, transactionDate: '2026-03-09' });
    const suggestions = suggestCardAssetPurchases([purchase, blender, dealer, coin], new Map());
    const byId = new Map(suggestions.map((item) => [item.id, item]));
    assert.equal(byId.get(blender.id)?.tier, 'weak');
    // A bullion dealer has no floor: any refund of its purchase is asked as strongly as the purchase.
    assert.equal(byId.get(coin.id)?.tier, 'likely');
    // A bare dealer name shows no channel: never paired, asked, and said why.
    assert.deepEqual(byId.get(coin.id)?.signals, ['refund-of-suggested', 'partial-refund', 'channel-unconfirmed']);
    assert.equal(suggestions[suggestions.length - 1].id, blender.id);
  });
});

/** A seeded generator, so a failing ledger can be reproduced from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DESCRIPTORS = [ONLINE, WAREHOUSE, 'WALMART.COM', 'WAL-MART #0042', 'APMEX', 'JM BULLION', 'SAMSCLUB.COM', 'SAMPLE GROCER',
  'SAMPLE CAFE #12', 'COSTCO GAS #0042', 'COSTCO #001 GAS', 'COSTCO.COM PHARMACY', 'SAMPLE AIRLINE', 'APMEX.COM', "SAM'S CLUB #001",
  'SAMPLEMART.COM', 'SAMPLE MART #12', 'SAMPLE MART', 'COSTCO WHOLESALE'];
/** Merchant names an issuer may give rows whatever their descriptors say. */
const MERCHANTS = ["SAM'S CLUB", 'SAMPLE MART', 'TARGET'];
const KINDS: CardTransactionKind[] = ['purchase', 'purchase', 'purchase', 'purchase', 'refund', 'fee', 'interest', 'adjustment', 'payment', 'other'];

type GeneratedRow = CardExclusionRow & { issuerCategory: string | null };
const withIssuer = (item: CardExclusionRow & { issuerCategory?: string | null }): GeneratedRow => ({ ...item, issuerCategory: item.issuerCategory ?? null });

/**
 * A synthetic ledger: every kind and status, two currencies, owner categories, a rule now and then, and refund
 * sequences: exact refunds, partial ones, owner-confirmed metals refunds, a credit of the original amount after a
 * partial one, repeated refunds, refunds from another seller, and posted dates out of transaction order.
 */
function ledger(seed: number): { rows: GeneratedRow[]; rules: CardSpendingRule[] } {
  const next = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const rows: GeneratedRow[] = [];
  const later = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  for (let index = 0; index < 160; index += 1) {
    const kind = pick(KINDS);
    const magnitude = next() < 0.3 ? 100_000 + Math.floor(next() * 900_000) : 100 + Math.floor(next() * 30_000);
    const sign = kind === 'refund' || kind === 'payment' ? -1 : kind === 'adjustment' && next() < 0.7 ? -1 : 1;
    const month = String(1 + Math.floor(next() * 12)).padStart(2, '0');
    const day = String(1 + Math.floor(next() * 28)).padStart(2, '0');
    const transactionDate = `2026-${month}-${day}`;
    const purchase: GeneratedRow = {
      id: `gen-${seed}-${index}`,
      cardAccountId: pick(['card-acct-a', 'card-acct-b', 'card-acct-c']),
      transactionDate,
      ...(next() < 0.5 ? { postedDate: later(transactionDate, Math.floor(next() * 4)) } : {}),
      status: pick(['posted', 'posted', 'posted', 'posted', 'pending', 'removed'] as const),
      kind,
      amountMinor: sign * magnitude,
      currency: next() < 0.9 ? 'USD' : 'EUR',
      description: pick(DESCRIPTORS),
      merchant: next() < 0.25 ? pick(MERCHANTS) : null,
      userCategory: next() < 0.15 ? pick(['Precious metals', 'precious metal', 'Groceries', 'Electronics']) : null,
      issuerCategory: next() < 0.6 ? pick(['Merchandise & Supplies-Wholesale Stores', 'Restaurant-Restaurant', 'Travel-Airline']) : null,
    };
    rows.push(purchase);
    if (kind !== 'purchase' || next() >= 0.35) continue;
    // A refund sequence after the purchase: some of these pair, most must not.
    const refunds = 1 + Math.floor(next() * 3);
    let date = transactionDate;
    for (let step = 0; step < refunds; step += 1) {
      date = later(date, 1 + Math.floor(next() * 20));
      const shape = next();
      const amountMinor = shape < 0.4 ? -magnitude : shape < 0.8 ? -Math.max(1, Math.floor(magnitude * (0.2 + next() * 0.5))) : -(magnitude + 1);
      rows.push({
        ...purchase,
        id: `gen-${seed}-${index}-refund-${step}`,
        kind: 'refund',
        amountMinor,
        transactionDate: date,
        postedDate: next() < 0.3 ? later(date, -1 - Math.floor(next() * 3)) : later(date, Math.floor(next() * 5)),
        status: 'posted',
        description: next() < 0.15 ? pick(DESCRIPTORS) : purchase.description,
        userCategory: next() < 0.25 ? pick(['Precious metals', 'Groceries']) : null,
      });
    }
  }
  const rules = next() < 0.6 ? [rule({ minAmountMinor: 50_000 + Math.floor(next() * 400_000), merchantClass: pick(CARD_METALS_MERCHANT_CLASSES) })] : [];
  return { rows, rules };
}

/** Every identity the accounting promises, for one ledger and its rules. */
function assertReconciles(rows: readonly GeneratedRow[], rules: readonly CardSpendingRule[], label: string): void {
  const exclusions = resolveCardSpendingExclusions(rows, rules);
  const suggestions = suggestCardAssetPurchases(rows, exclusions);
  const accounting = buildCardSpendingAccounting(rows, { exclusions, suggestions });
  const summary = summarizeCardSpending(rows, { exclusions });
  // A suggestion is never a decision: no suggested row, and no refund that would follow one, is out of spending.
  for (const item of suggestions) {
    for (const id of [item.id, ...item.followingRefundIds]) assert.equal(exclusions.has(id), false, `${label} suggestion ${id}`);
  }
  for (const entry of accounting) {
    const where = `${label} ${entry.currency}`;
    for (const field of ['netMinor', 'chargesMinor', 'creditsMinor', 'count'] as const) {
      assert.equal(entry.activity[field], entry.spending[field] + entry.notSpending[field] + entry.transfers[field], `${where} ${field}`);
      assert.equal(entry.notSpending[field], entry.notSpending.assetPurchases[field] + entry.notSpending.other[field], `${where} ${field}`);
    }
    const posted = rows.filter((item) => item.status === 'posted' && item.currency === entry.currency);
    assert.equal(entry.activity.netMinor, posted.reduce((sum, item) => sum + item.amountMinor, 0), where);
    assert.equal(entry.activity.count, posted.length, where);
    const assets = posted.filter((item) => cardSpendingRole(item.kind) === 'spending' && (exclusions.has(item.id) || ownerCardSpendingExclusion(item)));
    assert.equal(entry.notSpending.assetPurchases.netMinor, assets.reduce((sum, item) => sum + item.amountMinor, 0), where);
    const pending = rows.filter((item) => item.status === 'pending' && item.currency === entry.currency);
    assert.deepEqual(entry.pending, { count: pending.length, netMinor: pending.reduce((sum, item) => sum + item.amountMinor, 0) }, where);

    const total = summary.totals.find((item) => item.currency === entry.currency);
    if (!total) {
      assert.equal(entry.activity.count, 0, where);
      continue;
    }
    assert.deepEqual(
      [total.spendingMinor, total.chargesMinor, total.creditsMinor, total.count],
      [entry.spending.netMinor, entry.spending.chargesMinor, entry.spending.creditsMinor, entry.spending.count], where,
    );
    assert.equal(total.paymentsMinor, entry.transfers.netMinor, where);
    assert.equal(total.otherMinor, entry.notSpending.other.netMinor, where);
    assert.equal(total.assetPurchasesMinor ?? 0, entry.notSpending.assetPurchases.netMinor, where);
    assert.equal(total.assetPurchaseCount ?? 0, entry.notSpending.assetPurchases.count, where);
    assert.equal('assetPurchaseCount' in total, entry.notSpending.assetPurchases.count > 0, where);
    const sum = (items: ReadonlyArray<{ currency: string; spendingMinor: number }>) =>
      items.filter((item) => item.currency === entry.currency).reduce((acc, item) => acc + item.spendingMinor, 0);
    assert.equal(sum(summary.byCategory), entry.spending.netMinor, `${where} categories`);
    assert.equal(sum(summary.byMonth), entry.spending.netMinor, `${where} months`);
    assert.equal(sum(summary.byMerchant) + sum(summary.otherMerchants), entry.spending.netMinor, `${where} merchants`);
    assert.equal(sum(summary.byCard), entry.spending.netMinor, `${where} cards`);

    // What is possible is a part of spending, and exactly the suggestions' rows and their following refunds.
    const possible = new Set(suggestions.flatMap((item) => [item.id, ...item.followingRefundIds]));
    const possibleRows = posted.filter((item) => possible.has(item.id));
    assert.equal(entry.possibleAssetPurchases.netMinor, possibleRows.reduce((acc, item) => acc + item.amountMinor, 0), where);
    assert.equal(possibleRows.every((item) => !exclusions.has(item.id) && !ownerCardSpendingExclusion(item)), true, where);
  }
}

describe('the accounting adds up', () => {
  it('splits every posted row into exactly one part, and matches the summary, on generated ledgers', () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const { rows, rules } = ledger(seed);
      assertReconciles(rows, rules, `seed ${seed}`);
    }
  });

  it('reconciles across refund sequences: owner-confirmed partials, undecided partials, repeats, posting order, other sellers', () => {
    const base = { description: ONLINE };
    const purchase = row({ ...base, amountMinor: 210_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const ownerPartial = row({ ...base, kind: 'refund', amountMinor: -50_000, transactionDate: '2026-09-10', userCategory: 'Precious metals' });
    const undecidedPartial = row({ ...base, kind: 'refund', amountMinor: -50_000, transactionDate: '2026-09-10' });
    const full = row({ ...base, kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-20' });
    const rest = row({ ...base, kind: 'refund', amountMinor: -160_123, transactionDate: '2026-09-20' });
    const repeat = row({ ...base, kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-25' });
    const dealer = row({ description: 'APMEX', amountMinor: 210_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const otherDealer = row({ description: 'JM BULLION', kind: 'refund', amountMinor: -210_123, transactionDate: '2026-09-20' });
    const clubOrder = row({ merchant: "SAM'S CLUB", description: 'SAMSCLUB.COM', amountMinor: 310_123, transactionDate: '2026-09-01', userCategory: 'Precious metals' });
    const clubStoreCredit = row({ merchant: "SAM'S CLUB", description: "SAM'S CLUB #001", kind: 'refund', amountMinor: -310_123, transactionDate: '2026-09-20' });
    const clubOnlineCredit = { ...clubStoreCredit, id: 'row-club-online-credit', description: 'SAMSCLUB.COM RETURN', transactionDate: '2026-09-22' };
    const sequences: Array<[string, GeneratedRow[], number]> = [
      // [name, rows, expected net asset purchases]
      ['owner-confirmed partial, then the original amount', [purchase, ownerPartial, full].map(withIssuer), 160_123],
      ['owner-confirmed partial, then exactly the rest, then a repeat', [purchase, ownerPartial, rest, repeat].map(withIssuer), 0],
      ['undecided partial, then the original amount', [purchase, undecidedPartial, full].map(withIssuer), 210_123],
      ['the original amount, then a repeat', [purchase, full, repeat].map(withIssuer), 0],
      ['posted out of order', [purchase, { ...full, transactionDate: '2026-09-08', postedDate: '2026-09-20' },
        { ...undecidedPartial, postedDate: '2026-09-11' }].map(withIssuer), 210_123],
      ['another dealer\'s refund', [dealer, otherDealer].map(withIssuer), 210_123],
      ['an online order and a store credit under one merchant name', [clubOrder, clubStoreCredit].map(withIssuer), 310_123],
      ['an online order, a store credit, then its online refund', [clubOrder, clubStoreCredit, clubOnlineCredit].map(withIssuer), 310_123],
      ['an online order and its online refund', [clubOrder, clubOnlineCredit].map(withIssuer), 0],
    ];
    for (const [name, rows, assetsMinor] of sequences) {
      assertReconciles(rows, [], name);
      const [usd] = buildCardSpendingAccounting(rows, { exclusions: resolveCardSpendingExclusions(rows) });
      assert.equal(usd.notSpending.assetPurchases.netMinor, assetsMinor, name);
    }
  });

  it('changes no summary and no insight where no row is an asset purchase', () => {
    for (let seed = 100; seed <= 120; seed += 1) {
      const rows = ledger(seed).rows.map((item) => ({ ...item, userCategory: isCardAssetCategory(item.userCategory) ? 'Groceries' : item.userCategory }));
      const plain = summarizeCardSpending(rows);
      assert.deepEqual(summarizeCardSpending(rows, { exclusions: resolveCardSpendingExclusions(rows) }), plain, `seed ${seed}`);
      assert.equal(JSON.stringify(plain).includes('assetPurchase'), false, `seed ${seed}`);
      const options = { month: '2026-10', today: '2026-10-16', currency: 'USD' };
      assert.deepEqual(computeCardInsights(rows, { ...options, exclusions: new Map() }), computeCardInsights(rows, options), `seed ${seed}`);
    }
  });

  it('leaves asset purchases out of every insight, as if they were not there', () => {
    for (let seed = 200; seed <= 215; seed += 1) {
      const { rows, rules } = ledger(seed);
      const exclusions = resolveCardSpendingExclusions(rows, rules);
      const options = { month: '2026-10', today: '2026-10-16', currency: 'USD' };
      assert.deepEqual(
        computeCardInsights(rows, { ...options, exclusions }),
        computeCardInsights(rows.filter((item) => !exclusions.has(item.id)), options),
        `seed ${seed}`,
      );
    }
  });
});

describe('rule previews', () => {
  it('counts what the rule would take out, what the owner decided and what is already out', () => {
    const rows = [
      row({ description: ONLINE, amountMinor: 300_001, transactionDate: '2025-04-02' }),
      row({ description: ONLINE, kind: 'refund', amountMinor: -300_001, transactionDate: '2025-04-09' }),
      row({ description: ONLINE, amountMinor: 450_001, transactionDate: '2026-02-02' }),
      row({ description: ONLINE, amountMinor: 450_001, userCategory: 'Electronics' }),
      row({ description: ONLINE, amountMinor: 450_001, userCategory: 'Precious metals' }),
      row({ description: ONLINE, amountMinor: 50_001 }),
      row({ description: ONLINE, amountMinor: 450_001, status: 'pending' }),
    ];
    assert.deepEqual(previewCardSpendingRule(rows, [], { merchantClass: 'costco-online', currency: 'USD', minAmountMinor: 100_000 }), {
      purchases: 2,
      refunds: 1,
      amounts: { netMinor: 450_001, chargesMinor: 750_002, creditsMinor: -300_001, count: 3 },
      firstDate: '2025-04-02',
      lastDate: '2026-02-02',
      ownerDecided: 1,
      alreadyExcluded: 1,
      rowIds: [rows[0].id, rows[1].id, rows[2].id].sort(),
    });
  });
});

describe('row views', () => {
  const stored: CardTransaction = {
    id: 'card-txn-sample', cardAccountId: 'card-acct-a', source: 'sample', fingerprint: 'cfp1:sample', transactionDate: '2026-09-10',
    status: 'posted', amountMinor: 412_399, currency: 'USD', kind: 'purchase', description: ONLINE, createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  };

  it('says why an asset purchase is not spending, and leaves every other row exactly as before', () => {
    const plain = toCardTransactionView(stored);
    assert.equal(plain.role, 'spending');
    assert.equal('exclusion' in plain, false);
    const mine = toCardTransactionView({ ...stored, userCategory: 'Precious metals' });
    assert.equal(mine.role, 'excluded');
    assert.deepEqual(mine.exclusion, { reason: 'asset-purchase', source: 'owner-category' });
    const ruled = withCardSpendingExclusion(plain, { reason: 'asset-purchase', source: 'owner-rule', ruleId: rule().id });
    assert.deepEqual([ruled.role, ruled.exclusion?.source, ruled.exclusion?.ruleId], ['excluded', 'owner-rule', rule().id]);
    assert.deepEqual(withCardSpendingExclusion(ruled, null), plain);
    assert.equal(withCardSpendingExclusion(plain, null), plain);
  });
});
