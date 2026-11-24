import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticCostcoCapture, syntheticMembershipSpec, syntheticOrderNumber, SYNTHETIC_CARD, type SyntheticCaptureSpec } from './__fixtures__/costcoCapture.js';
import { convertCostcoCapture } from './costco.js';
import { RETAIL_METAL_PACKS } from './metalPackRule.js';
import { RETAIL_METAL_GUARD_EVIDENCE } from './metalTitleRule.js';
import {
  RETAIL_CONVERT_POLICY_VERSION,
  RETAIL_IMPORT_VERSION,
  retailDigest,
  retailLineKey,
  retailNaturalKey,
  serializeRetailImportPayload,
  validateRetailImportPayload,
  type RetailImportPayload,
} from './payload.js';

function converted(spec: SyntheticCaptureSpec): RetailImportPayload {
  const capture = syntheticCostcoCapture(spec);
  const { json, report } = convertCostcoCapture({
    folder: 'costco-2',
    consolidated: capture.consolidated,
    consolidatedDigest: retailDigest(new TextEncoder().encode('synthetic')),
    rawReceipts: capture.rawReceipts.map((file) => file.json),
    rawDetails: capture.rawDetails.map((file) => file.json),
    files: 8,
  });
  assert.equal(report.receipts.held, 0, 'the synthetic capture holds nothing');
  return JSON.parse(json) as RetailImportPayload;
}

const payload = () => converted(syntheticMembershipSpec());

/** The base membership and three wallet Shop Card orders: card and Shop Card (11), the Shop Card alone (12), cancelled (13). */
function shopCardPayload(): RetailImportPayload {
  const spec = syntheticMembershipSpec();
  const line = (cancelled: boolean) => ({
    line: 1, number: '2000101', title: 'Sample Blender', qty: 1, price: 30000,
    ...(cancelled ? { merch: 0, cancelled: [{ qty: 1, date: '2025-09-02' }] } : { shipped: [{ qty: 1, date: '2025-09-02' }] }),
  });
  const wallet = (charged: number) => ({ type: 'Wallet Shop Card', last4: '', charged, shopCard: true });
  const visa = (charged: number) => ({ type: 'Visa', last4: SYNTHETIC_CARD, charged });
  spec.orders!.push(
    { seed: 11, placed: '2025-09-01T10:00:00', status: 'Shipped', lines: [line(false)], tax: 2000, walletShopCardApplied: 12000, payments: [visa(20000), wallet(12000)] },
    { seed: 12, placed: '2025-09-01T11:00:00', status: 'Shipped', lines: [line(false)], tax: 2000, walletShopCardApplied: 32000, payments: [wallet(32000)] },
    { seed: 13, placed: '2025-09-01T12:00:00', status: 'Cancelled', lines: [line(true)], tax: 0, total: 0, payments: [visa(20000), wallet(12000), wallet(-12000)] },
  );
  return converted(spec);
}

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function refused(change: (copy: Mutable) => void, base: () => RetailImportPayload = payload): string {
  const copy = base() as unknown as Mutable;
  change(copy);
  const result = validateRetailImportPayload(copy);
  assert.equal(result.ok, false, 'the changed payload is refused');
  return result.ok ? '' : result.issues[0].path;
}

const receiptIndex = (copy: Mutable, channel: string, sign = 'sale') =>
  (copy.receipts as Mutable[]).findIndex((receipt) => receipt.channel === channel && receipt.sign === sign);

describe('holdr.retail-import v3 payloads', () => {
  it('validate as converted, and serialize to the same bytes every time', () => {
    const converted = payload();
    assert.equal(validateRetailImportPayload(converted).ok, true);
    const text = serializeRetailImportPayload(converted);
    assert.equal(serializeRetailImportPayload(JSON.parse(text)), text);
    assert.ok(text.endsWith('}\n'));
    assert.match(text, /^\{\n {2}"converterVersion": /, 'keys are sorted');
  });

  it('refuse a format, policy or converter version they do not know', () => {
    assert.equal(RETAIL_IMPORT_VERSION, 3);
    assert.equal(refused((copy) => { copy.version = 1; }), '$.version', 'format 1, before the Shop Card facts');
    assert.equal(refused((copy) => { copy.version = 2; }), '$.version', 'format 2, before the metal guard flag');
    assert.equal(RETAIL_CONVERT_POLICY_VERSION, 5);
    assert.equal(refused((copy) => { copy.policyVersion = 1; }), '$.policyVersion', 'the provisional dry run\'s rules');
    assert.equal(refused((copy) => { copy.policyVersion = 2; }), '$.policyVersion', 'title rule v1, the dry run\'s payloads only');
    assert.equal(refused((copy) => { copy.policyVersion = 3; }), '$.policyVersion', 'Shop Card orders held');
    assert.equal(refused((copy) => { copy.policyVersion = 4; }), '$.policyVersion', 'title rule v2: no assay card, no metal guard');
    assert.equal(refused((copy) => { copy.policyVersion = 6; }), '$.policyVersion');
    assert.equal(refused((copy) => { copy.converterVersion = 'some-other-tool 1.0.0'; }), '$.converterVersion');
  });

  it('re-check an online order\'s Shop Card amount and payments, whoever converted it (Shop Card design v1)', () => {
    const order = (copy: Mutable, seed: number) => copy.receipts.find((receipt: Mutable) => receipt.naturalKey === retailNaturalKey('costco', 'order', syntheticOrderNumber(seed)));
    const shopCardTender = (amountMinor: number, ordinal: number) => ({ ordinal, kind: 'shop-card', network: 'unknown', last4: null, amountMinor });
    assert.equal(validateRetailImportPayload(shopCardPayload()).ok, true);
    const cases: Array<[string, (copy: Mutable) => void]> = [
      ['the identity holds the Shop Card amount', (copy) => { order(copy, 11).totals.storedValueMinor += 1; }],
      ['a negative Shop Card amount, even when the rest adds up', (copy) => {
        Object.assign(order(copy, 11).totals, { storedValueMinor: -12000, totalMinor: 44000 });
        order(copy, 11).tenders = [{ ...order(copy, 11).tenders[0], amountMinor: 44000 }];
      }],
      ['no Shop Card amount on an online order', (copy) => { order(copy, 1).totals.storedValueMinor = null; }],
      ['a Shop Card amount on a warehouse receipt', (copy) => { copy.receipts[receiptIndex(copy, 'warehouse')].totals.storedValueMinor = 0; }],
      ['a Shop Card amount without its payments', (copy) => { order(copy, 11).tenders = [order(copy, 11).tenders[0]]; }],
      ['Shop Card payments without the amount', (copy) => { order(copy, 1).tenders.push(shopCardTender(100, order(copy, 1).tenders.length)); }],
      ['a negative Shop Card payment, even when the rest adds up', (copy) => { order(copy, 12).tenders = [shopCardTender((330 * 100), 0), shopCardTender(-(10 * 100), 1)]; }],
      ['a card on an order the Shop Card paid alone', (copy) => { order(copy, 12).tenders.push({ ordinal: 1, kind: 'card', network: 'visa', last4: SYNTHETIC_CARD, amountMinor: 100 }); }],
      ['Shop Card payments on an order that charged nothing', (copy) => { order(copy, 13).tenders = [shopCardTender(12000, 0)]; }],
    ];
    for (const [name, change] of cases) assert.match(refused(change, shopCardPayload), /totals$/, name);
    assert.match(refused((copy) => { order(copy, 12).tenders.push(shopCardTender(0, 1)); }, shopCardPayload), /\.amountMinor$/, 'a Shop Card payment of nothing');
  });

  it('take a line\'s Shop Card flag only as a known kind, and only on an item line that is no metal', () => {
    const line = (copy: Mutable, seed: number, index = 0) => copy.receipts
      .find((receipt: Mutable) => receipt.naturalKey === retailNaturalKey('costco', 'order', syntheticOrderNumber(seed))).lines[index];
    const flagged = payload() as unknown as Mutable;
    line(flagged, 1).storedValue = 'costco-shop-card';
    assert.equal(validateRetailImportPayload(flagged).ok, true, 'an item line');
    assert.match(refused((copy) => { line(copy, 1).storedValue = 'gift-card'; }), /\.storedValue$/, 'an unknown kind');
    assert.match(refused((copy) => { line(copy, 1, 1).storedValue = 'costco-shop-card'; }), /\.storedValue$/, 'a fee line');
    assert.match(refused((copy) => { line(copy, 2).storedValue = 'costco-shop-card'; }), /\.storedValue$/, 'a metal line');
    assert.match(refused((copy) => { delete line(copy, 1).storedValue; }), /\.storedValue$/, 'the flag is always stated');
  });

  it('refuse a Shop Card flag on a fuel receipt\'s line: the list names only online and warehouse products', () => {
    const spec = syntheticMembershipSpec();
    spec.receipts![1].items.push({ number: '100005', title: 'SAMPLE WIPER FLUID', amount: 999 });
    spec.receipts![1].tenders[0].amount += 999;
    const withGasItem = () => converted(spec);
    const gasItem = (copy: Mutable) => copy.receipts.find((receipt: Mutable) => receipt.channel === 'gas').lines.find((line: Mutable) => line.kind === 'item');
    assert.ok(gasItem(withGasItem() as unknown as Mutable), 'the fuel receipt has an item line');
    assert.match(refused((copy) => { gasItem(copy).storedValue = 'costco-shop-card'; }, withGasItem), /\.storedValue$/);
    const warehouse = payload() as unknown as Mutable;
    warehouse.receipts[receiptIndex(warehouse, 'warehouse')].lines[0].storedValue = 'costco-shop-card';
    assert.equal(validateRetailImportPayload(warehouse).ok, true, 'a warehouse item line may carry it');
  });

  it('refuse an online line of either negative sign, even when the two signs cancel (R5)', () => {
    const line = (copy: Mutable) => copy.receipts.find((receipt: Mutable) => receipt.channel === 'online' && receipt.totals.totalMinor > 0).lines[0];
    assert.match(refused((copy) => {
      line(copy).quantity = -line(copy).quantity;
      line(copy).unitPriceMinor = -line(copy).unitPriceMinor;
    }), /\.quantity$/);
    assert.match(refused((copy) => { line(copy).quantity = null; }), /\.quantity$/);
    assert.match(refused((copy) => { line(copy).unitPriceMinor = null; }), /\.unitPriceMinor$/);
  });

  it('keep a fuel line\'s price per gallon as text, and only there', () => {
    const fuel = (copy: Mutable) => copy.receipts.flatMap((receipt: Mutable) => receipt.lines).find((line: Mutable) => line.kind === 'fuel');
    const item = (copy: Mutable) => copy.receipts.flatMap((receipt: Mutable) => receipt.lines).find((line: Mutable) => line.kind === 'item');
    assert.equal(fuel(payload() as unknown as Mutable).fuelUnitPrice, '3.499');
    assert.match(refused((copy) => { fuel(copy).unitPriceMinor = 350; }), /\.unitPriceMinor$/);
    assert.match(refused((copy) => { fuel(copy).fuelUnitPrice = '3.4999999'; }), /\.fuelUnitPrice$/);
    assert.match(refused((copy) => { fuel(copy).fuelUnitPrice = 3.499; }), /\.fuelUnitPrice$/);
    assert.match(refused((copy) => { item(copy).fuelUnitPrice = '3.499'; }), /\.fuelUnitPrice$/);
  });

  it('accept cash given back as change only on a sale no card paid', () => {
    const withTenders = (tenders: Mutable[]) => {
      const copy = payload() as unknown as Mutable;
      const receipt = copy.receipts.find((entry: Mutable) => entry.tenders.some((tender: Mutable) => tender.kind === 'reward-certificate'));
      receipt.tenders = tenders.map((tender, ordinal) => ({ ordinal, network: 'unknown', last4: null, ...tender }));
      return validateRetailImportPayload(copy).ok;
    };
    assert.equal(withTenders([{ kind: 'reward-certificate', amountMinor: (10 * 100) }, { kind: 'cash', amountMinor: -102 }]), true);
    assert.equal(withTenders([{ kind: 'cash', amountMinor: (10 * 100) }, { kind: 'cash', amountMinor: -102 }]), true);
    assert.equal(withTenders([{ kind: 'card', network: 'visa', last4: '0'.repeat(4), amountMinor: (10 * 100) }, { kind: 'cash', amountMinor: -102 }]), false);
    assert.equal(withTenders([{ kind: 'reward-certificate', amountMinor: -100 }, { kind: 'cash', amountMinor: 998 }]), false);
  });

  it('refuse unknown or missing keys at every level', () => {
    assert.equal(refused((copy) => { copy.extra = 1; }), '$');
    assert.equal(refused((copy) => { delete copy.held; }), '$.held');
    assert.match(refused((copy) => { copy.receipts[0].lines[0].note = 'x'; }), /^\$\.receipts\[0\]\.lines\[0\]$/);
  });

  it('refuse values of another type, even when they would coerce', () => {
    refused((copy) => { copy.version = '1'; });
    refused((copy) => { copy.receipts[0].totals.totalMinor = String(copy.receipts[0].totals.totalMinor); });
    refused((copy) => { copy.receipts[0].lines[0].amountMinor = copy.receipts[0].lines[0].amountMinor + 0.5; });
  });

  it('re-check every receipt\'s money, whoever converted it', () => {
    assert.match(refused((copy) => { copy.receipts[receiptIndex(copy, 'warehouse')].lines[0].amountMinor += 1; }), /totals$/);
    assert.match(refused((copy) => { copy.receipts[receiptIndex(copy, 'warehouse')].tenders[0].amountMinor += 1; }), /totals$/);
    assert.match(refused((copy) => { copy.receipts[receiptIndex(copy, 'warehouse')].totals.taxMinor += 1; }), /totals$/);
    assert.match(refused((copy) => {
      const online = copy.receipts.find((receipt: Mutable) => receipt.channel === 'online' && receipt.totals.totalMinor > 0 && receipt.tenders.length === 1);
      online.tenders.push({ ...online.tenders[0], ordinal: 1 });
    }), /totals$/);
    assert.match(refused((copy) => {
      const refund = copy.receipts[receiptIndex(copy, 'warehouse', 'refund')];
      refund.sign = 'sale';
    }), /totals$/);
    assert.match(refused((copy) => {
      const online = copy.receipts.find((receipt: Mutable) => receipt.channel === 'online' && receipt.totals.totalMinor > 0);
      online.lines[0].quantity += 1;
    }), /totals$/, 'a live order\'s line is its quantity × unit price');
  });

  it('refuse card data, card endings where none belongs, and native numbers', () => {
    refused((copy) => { copy.receipts[0].lines[0].title = 'CARD 4111111111111111'; });
    refused((copy) => {
      const certificate = copy.receipts.flatMap((receipt: Mutable) => receipt.tenders).find((tender: Mutable) => tender.kind === 'reward-certificate');
      certificate.last4 = '1234';
    });
    refused((copy) => { copy.receipts[0].naturalKey = 'costco-receipt-1234'; });
    refused((copy) => { copy.receipts[0].lines[0].itemNumber = '1234567890123'; });
  });

  it('refuse a coupon or fee that points nowhere, and a held record that was also imported', () => {
    refused((copy) => {
      const coupon = copy.receipts.flatMap((receipt: Mutable) => receipt.lines).find((line: Mutable) => line.kind === 'coupon');
      coupon.couponTarget = 99;
    });
    refused((copy) => {
      const fee = copy.receipts.flatMap((receipt: Mutable) => receipt.lines).find((line: Mutable) => line.kind === 'fee');
      fee.feeParent = fee.ordinal;
    });
    refused((copy) => {
      copy.held.push({ channel: copy.receipts[0].channel, naturalKey: copy.receipts[0].naturalKey, reason: 'raw-missing', check: 'raw-missing', date: null });
    });
  });

  it('accept a held record only with a check of its own reason, keyless only when its key was unreadable', () => {
    const key = retailNaturalKey('costco', 'receipt', 'held sample');
    const withHeld = (entry: Mutable) => {
      const copy = payload() as unknown as Mutable;
      copy.held.push({ date: null, ...entry });
      return validateRetailImportPayload(copy).ok;
    };
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: key, reason: 'identity-failed', check: 'lines-subtotal' }), true);
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: null, reason: 'unreadable', check: 'record-key' }), true);
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: key, reason: 'tender-unknown', check: 'lines-subtotal' }), false);
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: key, reason: 'identity-failed', check: 'a-new-check' }), false);
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: key, reason: 'unreadable', check: 'record-key' }), false);
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: null, reason: 'unreadable', check: 'record-shape' }), false);
    assert.equal(withHeld({ channel: 'warehouse', naturalKey: key, reason: 'identity-failed' }), false);
  });

  it('take a held record\'s date only as a real date, never where the two files could not agree, and nothing else (format 2)', () => {
    const entry = {
      channel: 'online', naturalKey: retailNaturalKey('costco', 'order', syntheticOrderNumber(99)), reason: 'payment-mismatch', check: 'card-payment', date: '2025-06-10',
    };
    const withHeld = (held: Mutable) => () => ({ ...payload(), held: [structuredClone(held)] }) as unknown as RetailImportPayload;
    assert.equal(validateRetailImportPayload(withHeld(entry)()).ok, true, 'a date both files agreed on');
    assert.equal(validateRetailImportPayload(withHeld({ ...entry, date: null })()).ok, true, 'no date');
    for (const value of ['2025-6-10', '2025-02-30', '2025-06-10T08:00:00', 20250610]) {
      assert.equal(refused((copy) => { copy.held[0].date = value; }, withHeld(entry)), '$.held[0].date', String(value));
    }
    assert.equal(refused((copy) => { delete copy.held[0].date; }, withHeld(entry)), '$.held[0].date', 'the date is always stated');
    const withoutDate: Array<[string, string, string | null]> = [
      ['raw-missing', 'raw-missing', entry.naturalKey], ['capture-disagreement', 'raw-unlisted', entry.naturalKey],
      ['capture-disagreement', 'record-date', entry.naturalKey], ['unreadable', 'record-key', null],
    ];
    for (const [reason, check, naturalKey] of withoutDate) {
      assert.equal(refused(() => {}, withHeld({ ...entry, reason, check, naturalKey })), '$.held[0].date', check);
      assert.equal(validateRetailImportPayload(withHeld({ ...entry, reason, check, naturalKey, date: null })()).ok, true, check);
    }
    for (const [field, value] of [['amountMinor', (10 * 100)], ['totalMinor', (10 * 100)], ['last4', '0'.repeat(4)], ['tenders', []], ['lines', []], ['title', 'x']] as const) {
      assert.equal(refused((copy) => { copy.held[0][field] = value; }, withHeld(entry)), '$.held[0]', `a held record never keeps ${field}`);
    }
  });

  it('refuse metal evidence outside the rule\'s closed values', () => {
    const goldLine = (copy: Mutable) => copy.receipts.flatMap((receipt: Mutable) => receipt.lines).find((line: Mutable) => line.metal !== null);
    refused((copy) => { goldLine(copy).metal.rule = 'costco-flag'; });
    assert.match(refused((copy) => { goldLine(copy).metal.rule = 'title-rule-v1'; }), /\.metal\.rule$/, 'version 1 evidence (policy 2)');
    assert.match(refused((copy) => { goldLine(copy).metal.rule = 'title-rule-v2'; }), /\.metal\.rule$/, 'version 2 evidence (policies 3 and 4)');
    refused((copy) => { goldLine(copy).metal.statedWeight.unit = 'troy'; });
    refused((copy) => { goldLine(copy).metal.statedWeight.value = '0'; });
    refused((copy) => { goldLine(copy).metal.form = 'nugget'; });
    for (const value of ['1 1/3', '01 1/2', '1  1/2', '1 1/2 ', '\u00bd', '1 / 2', '-1', `${(10 * 100)} 1/2`, `${(20 * 100 + 24)} 1/2`]) {
      refused((copy) => { goldLine(copy).metal.statedWeight.value = value; });
    }
    for (const value of ['1 1/2', '2 3/4', '1/10', '1 1/10', '999 1/2']) {
      const copy = payload() as unknown as Mutable;
      goldLine(copy).metal.statedWeight.value = value;
      assert.equal(validateRetailImportPayload(copy).ok, true, value);
    }
    for (const pack of RETAIL_METAL_PACKS) {
      const copy = payload() as unknown as Mutable;
      goldLine(copy).metal.pack = pack;
      assert.equal(validateRetailImportPayload(copy).ok, true, pack);
    }
    for (const pack of ['pair', 'Single', null, 1]) {
      assert.match(refused((copy) => { goldLine(copy).metal.pack = pack; }), /\.metal\.pack$/, String(pack));
    }
    assert.match(refused((copy) => { delete goldLine(copy).metal.pack; }), /\.metal\.pack$/, 'every metal line states its pack (policy 4)');
  });

  it('take metal evidence only on an item line: the rule never reads a fee, fuel or coupon line (policy 5)', () => {
    const lines = (copy: Mutable) => copy.receipts.flatMap((receipt: Mutable) => receipt.lines);
    const metalOf = (copy: Mutable) => structuredClone(lines(copy).find((line: Mutable) => line.metal !== null).metal);
    for (const kind of ['fee', 'fuel', 'coupon']) {
      assert.match(refused((copy) => { lines(copy).find((line: Mutable) => line.kind === kind).metal = metalOf(copy); }), /\.metal$/, kind);
    }
  });

  it('take metal guard v1\'s flag only by value, on a line with a title that is no metal and buys no Shop Card (format 3)', () => {
    const FLAG = { guard: 'metal-guard-v1', evidence: ['adjacency'], metal: 'XAU' };
    const lines = (copy: Mutable) => copy.receipts.flatMap((receipt: Mutable) => receipt.lines);
    const plainItem = (copy: Mutable) => lines(copy).find((line: Mutable) => line.kind === 'item' && line.metal === null && line.storedValue === null);
    const ofKind = (kind: string) => (copy: Mutable) => lines(copy).find((line: Mutable) => line.kind === kind);
    const accepted = (pick: (copy: Mutable) => Mutable, flag: unknown, name: string) => {
      const copy = payload() as unknown as Mutable;
      pick(copy).metalUncertain = flag;
      assert.equal(validateRetailImportPayload(copy).ok, true, name);
    };
    accepted(plainItem, FLAG, 'an item line');
    accepted(ofKind('fee'), FLAG, 'a fee line');
    accepted(ofKind('fuel'), FLAG, 'a fuel line');
    accepted(plainItem, { ...FLAG, metal: null }, 'a title naming several metals');
    accepted(plainItem, { ...FLAG, evidence: [...RETAIL_METAL_GUARD_EVIDENCE] }, 'every evidence, in the closed order');
    const flag = (change: (value: Mutable) => void) => (copy: Mutable) => {
      const value: Mutable = { ...FLAG, evidence: [...FLAG.evidence] };
      change(value);
      plainItem(copy).metalUncertain = value;
    };
    assert.match(refused(flag((value) => { value.guard = 'metal-guard-v2'; })), /\.metalUncertain\.guard$/, 'another guard');
    assert.match(refused(flag((value) => { value.evidence = []; })), /\.metalUncertain\.evidence$/, 'no evidence');
    assert.match(refused(flag((value) => { value.evidence = ['karat']; })), /\.metalUncertain\.evidence\[0\]$/, 'an unknown code');
    assert.match(refused(flag((value) => { value.evidence = ['adjacency', 'bullion-word']; })), /\.metalUncertain\.evidence\[1\]$/, 'out of order');
    assert.match(refused(flag((value) => { value.evidence = ['purity', 'purity']; })), /\.metalUncertain\.evidence\[1\]$/, 'twice');
    assert.match(refused(flag((value) => { value.metal = 'XRH'; })), /\.metalUncertain\.metal$/, 'a metal outside the list');
    assert.match(refused(flag((value) => { delete value.metal; })), /\.metalUncertain\.metal$/, 'the metal is always stated');
    assert.match(refused(flag((value) => { value.clause = 'near-miss/adjacency'; })), /\.metalUncertain$/, 'nothing else');
    const goldLine = (copy: Mutable) => lines(copy).find((line: Mutable) => line.metal !== null);
    assert.match(refused((copy) => { goldLine(copy).metalUncertain = FLAG; }), /\.metalUncertain$/, 'a metal line');
    assert.match(refused((copy) => { ofKind('coupon')(copy).metalUncertain = FLAG; }), /\.metalUncertain$/, 'a coupon line');
    assert.match(refused((copy) => { Object.assign(plainItem(copy), { storedValue: 'costco-shop-card', metalUncertain: FLAG }); }),
      /\.metalUncertain$/, 'a Shop Card purchase line');
    assert.match(refused((copy) => { delete plainItem(copy).metalUncertain; }), /\.metalUncertain$/, 'the flag is always stated');
  });

  it('give one-way keys in letter hex, the same for the same native number', () => {
    const key = retailNaturalKey('costco', 'receipt', 'sample');
    assert.match(key, /^costco-receipt-[a-p]{64}$/);
    assert.equal(retailNaturalKey('costco', 'receipt', 'sample'), key);
    assert.notEqual(retailNaturalKey('costco', 'order', 'sample'), key);
    assert.match(retailLineKey('costco', 'order', 'line'), /^costco-line-[a-p]{64}$/);
  });
});
