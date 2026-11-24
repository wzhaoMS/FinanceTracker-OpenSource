import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_PAYMENT_PAYEES,
  CARD_PAYMENT_PAYEE_LABELS,
  CARD_PAYMENT_RECONCILIATION_RULES,
  cardPaymentCandidateCheck,
  cardPaymentConfirmRefusal,
  cardPaymentDayOffset,
  cardPaymentPayeeMatchesIssuer,
  cardPaymentPayeeMayPay,
  cardPaymentRowKind,
  checkingPayerReference,
  isBiltHousingPayment,
  classifyCheckingDebit,
  isReconcilableCardPayment,
  isReconcilableCheckingDebit,
  maskedCardNumbers,
  normalizeCheckingDescriptor,
  paymentChannelCue,
  reconcileCardPayments,
  type CardPaymentDecision,
  type CardPaymentReconciliation,
  type CardPaymentReconciliationInput,
  type ReconciliationCardRow,
  type ReconciliationCheckingRow,
} from './cardPaymentReconciliation.js';

// Synthetic rows only: made-up ids, amounts and dates, and descriptors in the shapes banks print, every digit a 9 and
// the holder a made-up name.
const AMEX = 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER';
const AMEX_LONG = 'AMERICAN EXPRESS ACH PMT 999999 A9999 SAMPLE HOLDER';
const CITI = 'CITI AUTOPAY PAYMENT 999999 ***9999 SAMPLE HOLDER';
const CHASE = 'CHASE CREDIT CRD EPAY 999999 ***9999 SAMPLE HOLDER';
const GENERIC = 'CREDIT CARD PAYMENT 999999';
/** Issuer-free words, and one more: a name, a bank, an issuer the rules do not know. It pays no card by itself. */
const GENERIC_NAMED = 'CREDIT CARD PAYMENT 999999 SAMPLE HOLDER';
const CITIZENS = 'BILL PAY CITIZENS CREDIT CARD 999999';
const BILT_CARD = 'BILT CARD PAYMENT 999999 SAMPLE HOLDER';
const BILT_RENT = 'BILT RENT ACH DEBIT 999999 SAMPLE HOLDER';
const WF_CARD = 'ONLINE TRANSFER REF #IBE9999999 TO WELLS FARGO AUTOGRAPH VISA CARD XXXXXX9999 ON 99/99/99';
const SAVINGS = 'ONLINE TRANSFER REF #IBE9999999 TO SAMPLE SAVINGS XXXXXX9999 ON 99/99/99';

const CARDS = [
  { id: 'card-amex', issuer: 'amex' },
  { id: 'card-amex-2', issuer: 'amex' },
  { id: 'card-citi', issuer: 'citi' },
  { id: 'card-chase', issuer: 'chase' },
  { id: 'card-bilt', issuer: 'bilt' },
  { id: 'card-wf', issuer: 'wellsfargo' },
];
const WF = 'chk-acct-wf';
const FIFTH = 'chk-acct-53';
const WIDE = [{ start: '2022-10-01', end: '2026-10-15' }];

function payment(id: string, cardAccountId: string, transactionDate: string, amountMinor: number, overrides: Partial<ReconciliationCardRow> = {}): ReconciliationCardRow {
  return { id, cardAccountId, transactionDate, status: 'posted', amountMinor, currency: 'USD', kind: 'payment', ...overrides };
}

function debit(id: string, date: string, amountMinor: number, description: string, overrides: Partial<ReconciliationCheckingRow> = {}): ReconciliationCheckingRow {
  return { id, checkingAccountId: WF, date, status: 'posted', amountMinor, currency: 'USD', description, ...overrides };
}

function decision(id: string, kind: CardPaymentDecision['decision'], cardTransactionId: string | null, checkingTransactionId: string | null, amountMinor: number, createdAt = '2026-10-16T12:00:00.000Z'): CardPaymentDecision {
  return { id, decision: kind, cardTransactionId, checkingTransactionId, amountMinor, currency: 'USD', createdAt };
}

function input(cardRows: ReconciliationCardRow[], checkingRows: ReconciliationCheckingRow[], extra: Partial<CardPaymentReconciliationInput> = {}): CardPaymentReconciliationInput {
  return {
    cardAccounts: CARDS,
    cardRows,
    checkingAccounts: [{ id: WF }, { id: FIFTH }],
    checkingRows,
    cardCoverage: CARDS.map((card) => ({ accountId: card.id, ranges: WIDE })),
    checkingCoverage: [{ accountId: WF, ranges: WIDE }, { accountId: FIFTH, ranges: WIDE }],
    ...extra,
  };
}

const pairsOf = (result: CardPaymentReconciliation) => result.pairs.map((pair) => [pair.paymentId, pair.debitId, pair.status]);
/** Everything but the class map, which tests read on their own. */
function plain(result: CardPaymentReconciliation) {
  const { classes, ...rest } = result;
  return { ...rest, classes: [...classes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}

/** Every payment in exactly one part, every counted debit in one; matched and confirmed equal on both sides. */
function assertTotalsAddUp(result: CardPaymentReconciliation) {
  for (const entry of result.totals) {
    const p = entry.payments;
    const d = entry.debits;
    for (const field of ['count', 'amountMinor'] as const) {
      assert.equal(p.all[field], p.matched[field] + p.confirmed[field] + p.ambiguous[field] + p.unmatched[field] + p.elsewhere[field] + p.returned[field], `${entry.currency} payments ${field}`);
      assert.equal(d.all[field], d.matched[field] + d.confirmed[field] + d.ambiguous[field] + d.unmatched[field], `${entry.currency} debits ${field}`);
      assert.equal(p.matched[field], d.matched[field], `${entry.currency} matched ${field}`);
      assert.equal(p.confirmed[field], d.confirmed[field], `${entry.currency} confirmed ${field}`);
    }
  }
  const seenPayments = [
    ...result.pairs.map((pair) => pair.paymentId),
    ...result.ambiguous.flatMap((group) => group.paymentIds),
    ...result.unmatchedPayments.map((item) => item.paymentId),
    ...result.elsewhere.map((item) => item.paymentId),
    ...result.returned.map((item) => item.paymentId),
  ];
  assert.equal(new Set(seenPayments).size, seenPayments.length, 'a payment is in one place only');
  const seenDebits = [
    ...result.pairs.map((pair) => pair.debitId),
    ...result.ambiguous.flatMap((group) => group.debitIds),
    ...result.unmatchedDebits.map((item) => item.debitId),
    ...result.notCardPayments.map((item) => item.debitId),
    ...result.biltHousing,
    ...result.returnedDebits.map((item) => item.debitId),
  ];
  assert.equal(new Set(seenDebits).size, seenDebits.length, 'a debit belongs to one payment at most');
  assert.equal(result.totals.reduce((sum, entry) => sum + (entry.debits.returned?.count ?? 0), 0), result.returnedDebits.length, 'returned debits');
}

describe('classifyCheckingDebit', () => {
  it('reads the issuers the banks name in card payments', () => {
    const cases: Array<[string, string | null]> = [
      [AMEX, 'amex'],
      [AMEX_LONG, 'amex'],
      ['CITI CARD ONLINE PAYMENT 999999 ***9999 SAMPLE HOLDER', 'citi'],
      [CITI, 'citi'],
      ['CHASE CREDIT CRD AUTOPAY 999999 ***9999 SAMPLE HOLDER', 'chase'],
      [CHASE, 'chase'],
      ['DISCOVER E-PAYMENT 999999 9999 SAMPLE HOLDER', 'discover'],
      ['CAPITAL ONE MOBILE PMT 999999 9XXXXXXXXXXXXXX SAMPLE HOLDER', 'capitalone'],
      ['BARCLAYCARD US CREDITCARD 999999 9999999999 SAMPLE HOLDER', 'barclays'],
      ['APPLECARD GSBANK PAYMENT 9999999 999999 SAMPLE HOLDER', 'apple'],
      [WF_CARD, 'wellsfargo'],
      ['WF CREDIT CARD AUTO PAY 999999 SAMPLE HOLDER', 'wellsfargo'],
      ['ONLINE TRANSFER REF #IBE9999999 TO WELLS FARGO MICRO CENTER CREDIT CARD XXXXXX9999 ON 99/99/99', 'wellsfargo'],
      ['SYNCHRONY BANK PAYMENT 999999 SAMPLE HOLDER', 'synchrony'],
      ['BK OF AMER VISA ONLINE PMT 999999 SAMPLE HOLDER', 'bankofamerica'],
      ['FIFTH THIRD CREDIT CARD PAYMENT 999999', 'fifththird'],
      [GENERIC, null],
      ['CC PAYMENT 999999 ***9999', null],
      ['ONLINE TRANSFER TO VISA CARD XXXXXX9999', null],
      // Naming a payee the rules do not know (a bank, a name, a word with a digit, a lookalike): never issuer-free.
      [GENERIC_NAMED, 'unrecognized'],
      [CITIZENS, 'unrecognized'],
      ['BILL PAY M1 CREDIT CARD 999999', 'unrecognized'],
      ['BILL PAY N26 CREDIT CARD 999999', 'unrecognized'],
      ['BILL PAY CAPITAL1 CREDIT CARD 999999', 'unrecognized'],
      ['BILL PAY AMERICAN EXPEDITING CREDIT CARD 999999', 'unrecognized'],
      ['ONLINE TRANSFER REF #IBE9999999 TO SAMPLE VISA CARD XXXXXX9999 ON 99/99/99', 'unrecognized'],
      ['ONLINE TRANSFER REF #IBE9999999 TO VISA CARD XXXXXX9999 ON 99/99/99', 'unrecognized'],
      // A card's product alone names one card, not its issuer.
      ['ONLINE TRANSFER REF #IBE9999999 TO MICRO CENTER CREDIT CARD XXXXXX9999 ON 99/99/99', 'unrecognized'],
      // Fifth Third's web payments, cut at 32 characters, where the issuer's name is whole.
      ['WEB INITIATED PAYMENT AT AMEX EP', 'amex'],
      ['WEB INITIATED PAYMENT AT CITI CA', 'citi'],
      // As the checking converter stores them: the ACH date folded into the masked reference, or gone.
      ['CITI AUTOPAY PAYMENT ***9999 SAMPLE HOLDER', 'citi'],
      ['CHASE CREDIT CRD AUTOPAY ***9999 SAMPLE HOLDER', 'chase'],
      ['CAPITAL ONE MOBILE PMT *** SAMPLE HOLDER', 'capitalone'],
      ['BARCLAYCARD US CREDITCARD ***9999 SAMPLE HOLDER', 'barclays'],
      ['APPLECARD GSBANK PAYMENT ***9999 SAMPLE HOLDER', 'apple'],
      ['WF CREDIT CARD AUTO PAY ***9999 SAMPLE HOLDER', 'wellsfargo'],
      ['ONLINE TRANSFER REF #IBE9AAAAAA TO WELLS FARGO AUTOGRAPH VISA CARD XXXXXX9999 ON 99/99/99', 'wellsfargo'],
      // Bill pay to a payee the owner named "… Credit Card": the issuer named, the generic words paying.
      ['BILL PAY CAPITAL ONE CREDIT CARD ON-LINE 999999', 'capitalone'],
      ['BILL PAY DISCOVER CREDIT CARD 999999', 'discover'],
      ['BILL PAY AMEX CREDIT CARD 999999', 'amex'],
      ['BILL PAY SYNCHRONY CREDIT CARD 999999', 'synchrony'],
      ['AMEX CREDIT CARD 999999', 'amex'],
    ];
    for (const [text, payee] of cases) {
      assert.deepEqual([classifyCheckingDebit(text).class, classifyCheckingDebit(text).payee], ['card-payment', payee], text);
    }
  });

  it('reads any debit to Bilt as a payment to the Bilt card, and only an explicit rent or mortgage as housing', () => {
    for (const text of [BILT_CARD, 'BILT 999999 SAMPLE HOLDER', 'BILTREWARDS PMT 999999',
      'ONLINE TRANSFER REF #IBE9999999 TO BILT WORLD ELITE MASTERCARD XXXXXX9999 ON 99/99/99']) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'card-payment', payee: 'bilt', rule: 'bilt' }, text);
    }
    for (const text of [BILT_RENT, 'BILTPROTECT 999999 SAMPLE HOLDER', 'BILT MORTGAGE PAYMENT 999999', 'BILT*HOUSING 999999', 'BILT HOME LOAN 999999']) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'bilt-housing', payee: 'bilt', rule: 'bilt-housing' }, text);
    }
  });

  it('never reads transfers, loans, people or debit card purchases as card payments', () => {
    for (const text of [
      SAVINGS,
      'ZELLE TO SAMPLE CHASE ON 99/99 REF # SAMPLE9999 PAYMENT',
      'PURCHASE AUTHORIZED ON 99/99 SAMPLE CHASE CAFE S999999999 CARD 9999',
      'RECURRING PAYMENT AUTHORIZED ON 99/99 SAMPLE STREAMING CARD 9999',
      'WELLS FARGO HOME MTG AUTO PAY 999999',
      'CHASE MORTGAGE PAYMENT 999999 SAMPLE HOLDER',
      'CITIBANK AUTO LOAN PAYMENT 999999',
      'AMERICAN EXPRESS NATIONAL BANK TRANSFER 999999',
      'CHASE BANK TRANSFER TO SAMPLE SAVINGS 999999',
      'JPMORGAN CHASE EXT TRNSFR 999999 SAMPLE HOLDER',
      // Cut off or partial names: no issuer is named exactly.
      'WEB PYMT AMERICAN EXP 999999 SAMPLE HOLDER',
      'WEB INITIATED PAYMENT AT CAPITAL',
      'WEB PAYMENT CAPITAL',
      'BILL PAYMENT CAPITAL',
      'WEB INITIATED PAYMENT AT CHASE C',
      'WEB PAYMENT CAPITAL CITY SAMPLE 999999',
      'WEB INITIATED PAYMENT AT SAMPLE',
      'WEB INITIATED PAYMENT AT BANK OF',
      'SAMPLE CAPITAL GROUP PAYMENT 999999',
      'SAMPLE UTILITY BILL PAY 999999',
      'CHECK # 999',
      '',
    ]) {
      assert.equal(classifyCheckingDebit(text).class, 'other', text);
    }
  });

  it('reads whole tokens in any script, folding only ASCII case and splitting only on ASCII whitespace and punctuation', () => {
    assert.equal(normalizeCheckingDescriptor('amex e-payment, ach pmt ***1234'), 'AMEX E PAYMENT ACH PMT 1234');
    assert.equal(normalizeCheckingDescriptor('Citié 银行 card'), 'CITIé 银行 CARD');
    assert.equal(normalizeCheckingDescriptor('ａｍｅｘ e-payment'), 'ａｍｅｘ E PAYMENT');
    // A symbol, an emoji or a control character is part of its token, never a separator.
    assert.equal(normalizeCheckingDescriptor('capital 💰 one'), 'CAPITAL 💰 ONE');
    assert.equal(normalizeCheckingDescriptor('wells©fargo housingé'), 'WELLS©FARGO HOUSINGé');
    assert.equal(normalizeCheckingDescriptor('citi\u0007card'), 'CITI\u0007CARD');
    assert.equal(classifyCheckingDebit('amex e-payment').payee, 'amex');
    assert.equal(normalizeCheckingDescriptor(null as never), '');
    assert.equal(classifyCheckingDebit(42 as never).class, 'other');
  });

  it('never identifies anything in a descriptor with a symbol, an emoji or any other code point beyond printable ASCII', () => {
    // 5b01e72f's symbol cases (Root 03:56Z): each pays a card, and names no issuer.
    for (const text of [
      'CAPITAL 💰 ONE CARD PAYMENT', 'CAPITAL € ONE CARD PAYMENT', 'WELLS © FARGO CARD PAYMENT', 'US \uFFFD BANK CARD PAYMENT',
      'CAPITAL💰ONE CARD PAYMENT', 'CITI© CARD PAYMENT', '©AMEX EPAYMENT ACH PMT', 'CAPITAL ONE MOBILE PMT 😀',
      'AMEX EPAYMENT ACH PMT €9999', 'CHASE CREDIT CRD EPAY ™', 'CAPITAL ONE\u0007 MOBILE PMT', 'AMEX EPAYMENT\u0000ACH PMT',
    ]) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'card-payment', payee: 'unrecognized', rule: 'not-ascii' }, JSON.stringify(text));
    }
    assert.deepEqual(classifyCheckingDebit('BILT RENT ACH DEBIT ©'), { class: 'other', payee: null, rule: 'not-ascii' });
  });

  it('reads a name of several words only where ASCII whitespace alone separates them, and a single word wherever whole', () => {
    // Root 03:56Z: across punctuation a name is no alias, and the descriptor is only offered (`split-name`).
    for (const text of [
      'CAPITAL+ONE MOBILE PMT', 'CAPITAL-ONE MOBILE PMT', 'CAPITAL,ONE MOBILE PMT', 'CAPITAL, ONE MOBILE PMT', 'CAPITAL / ONE MOBILE PMT',
      'CAPITAL.ONE CARD PAYMENT', 'WELLS/FARGO CARD PAYMENT', 'US.BANK CARD PAYMENT', 'AMERICAN_EXPRESS CARD PAYMENT',
      'BK-OF-AMER VISA ONLINE PMT', 'FIFTH-THIRD CREDIT CARD PAYMENT', 'US.BANK VISA',
      // An exact name beside a split one names no issuer either.
      'CHASE CAPITAL-ONE CARD PAYMENT',
    ]) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'card-payment', payee: 'unrecognized', rule: 'split-name' }, text);
    }
    assert.deepEqual(classifyCheckingDebit('SAMPLE CAPITAL-ONE TRANSFER'), { class: 'other', payee: null, rule: 'split-name' });
    // ASCII whitespace alone, however much, keeps a name whole; a single word is whole between any punctuation.
    for (const [text, payee] of [
      ['CAPITAL  ONE MOBILE PMT', 'capitalone'], ['CAPITAL\tONE MOBILE PMT', 'capitalone'], ['CAPITAL ONE-MOBILE PMT', 'capitalone'],
      ['CITI-CARD ONLINE PAYMENT', 'citi'], ['AMEX/EPAYMENT ACH PMT', 'amex'], ['*DISCOVER* E-PAYMENT', 'discover'],
      ['WELLS FARGO/CARD PAYMENT', 'wellsfargo'], ['CHASE_CREDIT_CRD_EPAY', 'chase'],
    ] as const) {
      assert.equal(classifyCheckingDebit(text).payee, payee, text);
    }
    assert.equal(classifyCheckingDebit('BILT*HOUSING 999999').class, 'bilt-housing');
    assert.equal(classifyCheckingDebit('BILT HOME-LOAN 999999').class, 'bilt-housing');
  });

  it('never identifies anything in a descriptor with a non-ASCII letter, mark or digit, or a hidden character', () => {
    // 5b01e72f's six cases, as the checking converter's sanitizer keeps them: each pays a card, and names no issuer.
    for (const text of [
      'CITIÉ CARD PAYMENT', 'ÉAMEX CARD PAYMENT', 'CAPITAL 银行 ONE CARD PAYMENT', 'AMERICAN 银行 EXPRESS CARD PAYMENT',
      'WELLS 银行 FARGO CARD PAYMENT', 'US 银行 BANK CARD PAYMENT', 'ａｍｅｘ e-payment', 'CITI CARD PAYMENT ١٢٣٤٥',
      'CI\u200bTI CARD PAYMENT', 'CITI\u0301 CARD PAYMENT',
    ]) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'card-payment', payee: 'unrecognized', rule: 'not-ascii' }, text);
    }
    assert.deepEqual(classifyCheckingDebit('BILT RENT 公寓'), { class: 'other', payee: null, rule: 'not-ascii' });
    assert.deepEqual(classifyCheckingDebit('BILTÉ RENT ACH DEBIT'), { class: 'other', payee: null, rule: 'not-ascii' });
    // Never a housing pull either: a Bilt housing payment row is neither matched with such a debit nor offered it.
    const housingRow = payment('p-housing', 'card-bilt', '2026-06-01', -300_000, { issuerCategory: 'Housing payment' });
    for (const text of ['BILT RENT 公寓 999999', 'BILTÉ RENT ACH DEBIT 999999', 'BILT MORTGAGE PAYMENT 银行']) {
      const result = reconcileCardPayments(input([housingRow], [debit('d', '2026-06-01', -300_000, text)]));
      assert.deepEqual([pairsOf(result), result.ambiguous, result.unmatchedPayments[0].possibleDebits, result.biltHousing], [[], [], [], []], text);
    }
    assert.equal(classifyCheckingDebit('ZELLE TO 张三 PAYMENT').rule, 'people');
    // ASCII controls: a word between an alias's words, or a digit in its token, never names the issuer either.
    for (const text of ['CAPITAL BANK ONE CARD PAYMENT', 'AMERICAN SAMPLE EXPRESS CARD PAYMENT', 'WELLS SAMPLE FARGO CARD PAYMENT',
      'US SAMPLE BANK CARD PAYMENT', 'CITI1 CARD PAYMENT', '1AMEX CARD PAYMENT']) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'card-payment', payee: 'unrecognized', rule: 'generic-named' }, text);
    }
    // And the exact aliases still name their issuers.
    for (const [text, payee] of [['CITI CARD PAYMENT', 'citi'], ['AMEX CARD PAYMENT', 'amex'], ['CAPITAL ONE CARD PAYMENT', 'capitalone'],
      ['AMERICAN EXPRESS CARD PAYMENT', 'amex'], ['WELLS FARGO CARD PAYMENT', 'wellsfargo'], ['US BANK CARD PAYMENT', 'usbank']] as const) {
      assert.equal(classifyCheckingDebit(text).payee, payee, text);
    }
  });

  it('labels every payee', () => {
    assert.deepEqual(Object.keys(CARD_PAYMENT_PAYEE_LABELS).sort(), [...CARD_PAYMENT_PAYEES].sort());
  });
});

describe('cardPaymentPayeeMatchesIssuer', () => {
  it('pairs a named issuer only with its own cards, and a debit naming none or an unrecognized one with none', () => {
    assert.equal(cardPaymentPayeeMatchesIssuer('amex', 'amex'), true);
    assert.equal(cardPaymentPayeeMatchesIssuer('amex', 'citi'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('citi', 'citi-costco'), true);
    assert.equal(cardPaymentPayeeMatchesIssuer('citi', 'citizens'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('wellsfargo', 'wells-fargo'), true);
    assert.equal(cardPaymentPayeeMatchesIssuer('chase', 'chasebank'), false);
    // No issuer stands in for another: Bilt, Wells Fargo and Cardless each name only their own cards.
    assert.equal(cardPaymentPayeeMatchesIssuer('wellsfargo', 'bilt'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('bilt', 'wellsfargo'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('bilt', 'cardless'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('cardless', 'bilt'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('bilt', 'bilt'), true);
    assert.equal(cardPaymentPayeeMatchesIssuer('chase', 'wellsfargo'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer(null, 'samplebank'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer(null, 'amex'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('several', 'amex'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('unrecognized', 'citi'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('unrecognized', 'citizens'), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('amex', ''), false);
    assert.equal(cardPaymentPayeeMatchesIssuer('amex', undefined as never), false);
  });

  it('reads Bilt as the Wells Fargo card that carried it on a debit from before Cardless issued the Bilt card, and only then (RECON-34)', () => {
    const before = '2026-02-06';
    const carrier = { id: 'card-carrier', issuer: 'wellsfargo' };
    const other = { id: 'card-other', issuer: 'wells-fargo' };
    assert.equal(cardPaymentPayeeMayPay('bilt', before, carrier, carrier.id), true);
    assert.equal(cardPaymentPayeeMayPay('bilt', '2024-09-23', carrier, carrier.id), true);
    assert.equal(cardPaymentPayeeMayPay('bilt', before, { id: 'card-bilt', issuer: 'bilt' }, carrier.id), true);
    // Never another Wells Fargo card, nor any with no carrier found; from the day Cardless issues it, Bilt names only its
    // own cards; no other issuer stands in for another, ever.
    assert.equal(cardPaymentPayeeMayPay('bilt', before, other, carrier.id), false);
    assert.equal(cardPaymentPayeeMayPay('bilt', before, carrier, null), false);
    assert.equal(cardPaymentPayeeMayPay('bilt', CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom, carrier, carrier.id), false);
    assert.equal(cardPaymentPayeeMayPay('bilt', '2026-06-01', carrier, carrier.id), false);
    assert.equal(cardPaymentPayeeMayPay('bilt', '2026-06-01', { id: 'card-bilt', issuer: 'bilt' }, carrier.id), true);
    assert.equal(cardPaymentPayeeMayPay('wellsfargo', before, { id: 'card-bilt', issuer: 'bilt' }, 'card-bilt'), false);
    assert.equal(cardPaymentPayeeMayPay('wellsfargo', before, carrier, null), true);
    for (const payee of ['cardless', 'amex', null, 'unrecognized', 'several'] as const) {
      assert.equal(cardPaymentPayeeMayPay(payee, before, carrier, carrier.id), false, String(payee));
    }
    // A date that is no date reads as no day before it.
    for (const date of ['', '2026-2-6', 'not-a-date', 20_260_206 as never]) {
      assert.equal(cardPaymentPayeeMayPay('bilt', date, carrier, carrier.id), false, String(date));
    }
  });

  it('never matches a Citi debit with a Citizens card, or a bill pay naming one issuer with another\'s card', () => {
    const result = reconcileCardPayments(input(
      [payment('p-citizens', 'card-citizens', '2026-06-01', -10_000), payment('p-chase', 'card-chase', '2026-06-01', -20_000)],
      [debit('d-citi', '2026-06-01', -10_000, CITI), debit('d-amex', '2026-06-01', -20_000, 'BILL PAY AMEX CREDIT CARD 999999')],
      { cardAccounts: [...CARDS, { id: 'card-citizens', issuer: 'citizens' }] },
    ));
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.unmatchedDebits.map((item) => [item.debitId, item.payee]), [['d-amex', 'amex'], ['d-citi', 'citi']]);
  });

  it('never matches a Citizens bill pay with a Citi payment by itself, only offers it (the reversed case)', () => {
    const result = reconcileCardPayments(input(
      [payment('p-citi', 'card-citi', '2026-06-01', -10_000)],
      [debit('d-citizens', '2026-06-02', -10_000, CITIZENS)],
    ));
    assert.deepEqual([result.pairs, result.ambiguous], [[], []]);
    assert.deepEqual(result.unmatchedPayments, [{
      paymentId: 'p-citi', reason: 'no-checking-debit', possibleDebits: [{ paymentId: 'p-citi', debitId: 'd-citizens', dayOffset: 1 }],
    }]);
    assert.deepEqual(result.unmatchedDebits, [{
      debitId: 'd-citizens', payee: 'unrecognized', reason: 'no-card-payment',
      possiblePayments: [{ paymentId: 'p-citi', debitId: 'd-citizens', dayOffset: 1 }],
    }]);
    // The owner may still say it paid the Citi card.
    assert.equal(cardPaymentConfirmRefusal(payment('p-citi', 'card-citi', '2026-06-01', -10_000), debit('d-citizens', '2026-06-02', -10_000, CITIZENS), 'citi'), null);
    // A Citizens card in Holdr is not matched by itself either: Holdr does not know the name.
    const own = reconcileCardPayments(input(
      [payment('p-citizens', 'card-citizens', '2026-06-01', -10_000)],
      [debit('d-citizens', '2026-06-02', -10_000, CITIZENS)],
      { cardAccounts: [...CARDS, { id: 'card-citizens', issuer: 'citizens' }] },
    ));
    assert.deepEqual(own.pairs, []);
    assert.equal(own.unmatchedPayments[0].possibleDebits.length, 1);
  });

  it('never matches by itself a debit that does not name the issuer exactly, on any card, and offers it', () => {
    const unproven = [
      'BILL PAY M1 CREDIT CARD 999999', 'BILL PAY N26 CREDIT CARD 999999', 'BILL PAY CAPITAL1 CREDIT CARD 999999',
      'BILL PAYMENT CAPITAL', 'WEB INITIATED PAYMENT AT CAPITAL', 'BILL PAY AMERICAN EXPEDITING CREDIT CARD 999999', CITIZENS,
      GENERIC, GENERIC_NAMED, 'WEB PYMT AMERICAN EXP 999999 SAMPLE HOLDER', 'WEB INITIATED PAYMENT AT CHASE C',
      // Non-ASCII letters (5b01e72f's six) and ASCII words or digits inside an alias.
      'CITIÉ CARD PAYMENT', 'ÉAMEX CARD PAYMENT', 'CAPITAL 银行 ONE CARD PAYMENT', 'AMERICAN 银行 EXPRESS CARD PAYMENT',
      'WELLS 银行 FARGO CARD PAYMENT', 'US 银行 BANK CARD PAYMENT', 'CAPITAL BANK ONE CARD PAYMENT', 'CITI1 CARD PAYMENT',
    ];
    const cards = [...CARDS, { id: 'card-capitalone', issuer: 'capitalone' }, { id: 'card-citizens', issuer: 'citizens' }, { id: 'card-usbank', issuer: 'usbank' }];
    for (const text of unproven) {
      for (const card of cards) {
        const result = reconcileCardPayments(input(
          [payment('p', card.id, '2026-06-01', -10_000)], [debit('d', '2026-06-02', -10_000, text)], { cardAccounts: cards },
        ));
        assert.deepEqual([pairsOf(result), result.ambiguous], [[], []], `${text} on ${card.issuer}`);
        assert.deepEqual(result.unmatchedPayments[0].possibleDebits.map((item) => item.debitId), ['d'], `${text} offered on ${card.issuer}`);
        assert.equal(cardPaymentConfirmRefusal(payment('p', card.id, '2026-06-01', -10_000), debit('d', '2026-06-02', -10_000, text), card.issuer), null);
      }
    }
  });

  it('matches by itself an isolated pair whose debit names the issuer by an exact alias, for every supported issuer', () => {
    const controls: Array<[string, string]> = [
      ['amex', AMEX], ['amex', AMEX_LONG], ['citi', CITI], ['citi', 'CITICARDS PAYMENT 999999'], ['chase', CHASE],
      ['discover', 'DISCOVER E-PAYMENT 999999 9999 SAMPLE HOLDER'], ['capitalone', 'CAPITAL ONE MOBILE PMT *** SAMPLE HOLDER'],
      ['barclays', 'BARCLAYCARD US CREDITCARD ***9999 SAMPLE HOLDER'], ['apple', 'APPLECARD GSBANK PAYMENT ***9999 SAMPLE HOLDER'],
      ['synchrony', 'SYNCHRONY BANK PAYMENT 999999 SAMPLE HOLDER'], ['bankofamerica', 'BANK OF AMERICA CREDIT CARD BILL PAYMENT 999999'],
      ['usbank', 'US BANK CREDIT CARD PAYMENT 999999'], ['fifththird', 'FIFTH THIRD CREDIT CARD PAYMENT 999999'],
      ['cardless', 'CARDLESS CARD PAYMENT 999999'], ['wellsfargo', 'WF CREDIT CARD AUTO PAY ***9999 SAMPLE HOLDER'],
      ['wellsfargo', WF_CARD], ['bilt', BILT_CARD], ['amex', 'WEB INITIATED PAYMENT AT AMEX EP'], ['citi', 'WEB INITIATED PAYMENT AT CITI CA'],
    ];
    for (const [issuer, text] of controls) {
      const card = { id: `card-${issuer}`, issuer };
      const result = reconcileCardPayments(input(
        [payment('p', card.id, '2026-06-01', -10_000)], [debit('d', '2026-06-02', -10_000, text)], { cardAccounts: [card] },
      ));
      assert.deepEqual(pairsOf(result), [['p', 'd', 'matched']], `${issuer}: ${text}`);
    }
  });
});

describe('reconcileCardPayments: exact one-to-one matching', () => {
  it('matches a payment with the one debit of its exact amount, currency and dates', () => {
    const result = reconcileCardPayments(input(
      [payment('p-amex', 'card-amex', '2026-09-25', -50_000)],
      [debit('d-amex', '2026-09-26', -50_000, AMEX), debit('d-near', '2026-09-26', -50_001, AMEX),
        debit('d-eur', '2026-09-26', -50_000, AMEX, { currency: 'EUR' }), debit('d-in', '2026-09-26', 50_000, AMEX)],
    ));
    assert.deepEqual(result.pairs, [{ paymentId: 'p-amex', debitId: 'd-amex', dayOffset: 1, status: 'matched' }]);
    assert.deepEqual(result.unmatchedPayments, []);
    // The near amount and the other currency read as Amex payments with no card row of theirs; money in is never a debit.
    assert.deepEqual(result.unmatchedDebits.map((item) => item.debitId), ['d-eur', 'd-near']);
    assert.equal(result.classes.has('d-in'), false);
    assertTotalsAddUp(result);
  });

  it('takes debits from five days before to five days after the payment, and no further', () => {
    const { daysBefore, daysAfter } = CARD_PAYMENT_RECONCILIATION_RULES;
    assert.deepEqual([daysBefore, daysAfter], [5, 5]);
    const at = (date: string) => reconcileCardPayments(input([payment('p', 'card-amex', '2026-03-01', -12_345)], [debit('d', date, -12_345, AMEX)]));
    assert.equal(at('2026-02-24').pairs.length, 1);
    assert.equal(at('2026-03-06').pairs.length, 1);
    assert.equal(at('2026-02-23').pairs.length, 0);
    assert.equal(at('2026-03-07').pairs.length, 0);
    assert.equal(at('2026-02-24').pairs[0].dayOffset, -5);
  });

  it('never pairs a payment with a debit naming another issuer, but lists it for the owner', () => {
    const result = reconcileCardPayments(input([payment('p-amex', 'card-amex', '2026-09-25', -50_000)], [debit('d-citi', '2026-09-25', -50_000, CITI)]));
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.unmatchedPayments, [{
      paymentId: 'p-amex', reason: 'no-checking-debit', possibleDebits: [{ paymentId: 'p-amex', debitId: 'd-citi', dayOffset: 0 }],
    }]);
    assert.deepEqual(result.unmatchedDebits, [{
      debitId: 'd-citi', payee: 'citi', reason: 'no-card-payment', possiblePayments: [{ paymentId: 'p-amex', debitId: 'd-citi', dayOffset: 0 }],
    }]);
    assertTotalsAddUp(result);
  });

  it('lets the issuers named apart two cards paid the same amount the same day', () => {
    const result = reconcileCardPayments(input(
      [payment('p-amex', 'card-amex', '2026-09-25', -50_000), payment('p-citi', 'card-citi', '2026-09-25', -50_000)],
      [debit('d-citi', '2026-09-26', -50_000, CITI), debit('d-amex', '2026-09-27', -50_000, AMEX_LONG)],
    ));
    assert.deepEqual(pairsOf(result), [['p-amex', 'd-amex', 'matched'], ['p-citi', 'd-citi', 'matched']]);
    assert.deepEqual(result.ambiguous, []);
  });

  it('matches across every checking account, a debit to one payment at most', () => {
    const result = reconcileCardPayments(input(
      [payment('p-chase', 'card-chase', '2026-08-02', -7_777), payment('p-amex', 'card-amex', '2026-08-03', -8_888)],
      [debit('d-53', '2026-08-03', -7_777, CHASE, { checkingAccountId: FIFTH }), debit('d-wf', '2026-08-04', -8_888, AMEX)],
    ));
    assert.deepEqual(pairsOf(result), [['p-chase', 'd-53', 'matched'], ['p-amex', 'd-wf', 'matched']]);
  });

  it('reads only posted payments to a card and posted money out; pending payments wait apart', () => {
    const result = reconcileCardPayments(input(
      [
        payment('p-pending', 'card-amex', '2026-09-25', -50_000, { status: 'pending' }),
        payment('p-removed', 'card-amex', '2026-09-25', -50_000, { status: 'removed' }),
        payment('p-refund', 'card-amex', '2026-09-25', -50_000, { kind: 'refund' }),
        payment('p-returned', 'card-amex', '2026-09-25', 50_000),
        payment('p-bad-date', 'card-amex', '2026-02-30', -50_000),
      ],
      [debit('d-pending', '2026-09-25', -50_000, AMEX, { status: 'pending' }), debit('d-amex', '2026-09-25', -50_000, AMEX)],
    ));
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.pendingPayments, ['p-pending']);
    assert.deepEqual(result.unmatchedDebits.map((item) => item.debitId), ['d-amex']);
    assert.deepEqual(result.totals[0].payments.pending, { count: 1, amountMinor: -50_000 });
    assert.deepEqual(result.totals[0].payments.all, { count: 0, amountMinor: 0 });
  });
});

describe('reconcileCardPayments: ambiguity goes to the owner', () => {
  it('never picks between two cards of one issuer paid the same amount on close dates', () => {
    const result = reconcileCardPayments(input(
      [payment('p-amex', 'card-amex', '2026-09-25', -50_000), payment('p-amex-2', 'card-amex-2', '2026-09-26', -50_000)],
      [debit('d-1', '2026-09-26', -50_000, AMEX), debit('d-2', '2026-09-27', -50_000, AMEX)],
    ));
    assert.deepEqual(result.pairs, []);
    assert.equal(result.ambiguous.length, 1);
    assert.deepEqual(result.ambiguous[0].paymentIds, ['p-amex', 'p-amex-2']);
    assert.deepEqual(result.ambiguous[0].debitIds, ['d-1', 'd-2']);
    assert.deepEqual(result.ambiguous[0].candidates.map((item) => [item.paymentId, item.debitId, item.dayOffset]), [
      ['p-amex', 'd-1', 1], ['p-amex', 'd-2', 2], ['p-amex-2', 'd-1', 0], ['p-amex-2', 'd-2', 1],
    ]);
    assert.equal(result.ambiguous[0].id, 'p-amex');
    assertTotalsAddUp(result);
    assert.deepEqual(result.totals[0].payments.ambiguous, { count: 2, amountMinor: -100_000 });
  });

  it('offers a debit that names no issuer to every payment of its amount, and never matches it', () => {
    const result = reconcileCardPayments(input(
      [payment('p-amex', 'card-amex', '2026-09-25', -50_000), payment('p-citi', 'card-citi', '2026-09-26', -50_000)],
      [debit('d-1', '2026-09-26', -50_000, GENERIC), debit('d-2', '2026-09-27', -50_000, GENERIC)],
    ));
    assert.deepEqual([result.pairs, result.ambiguous], [[], []]);
    assert.deepEqual(result.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => [option.debitId, option.dayOffset])]), [
      ['p-amex', [['d-1', 1], ['d-2', 2]]],
      ['p-citi', [['d-1', 0], ['d-2', 1]]],
    ]);
    assert.deepEqual(result.unmatchedDebits.map((item) => [item.debitId, item.payee, item.reason, item.possiblePayments.map((option) => option.paymentId)]), [
      ['d-1', null, 'no-card-payment', ['p-citi', 'p-amex']],
      ['d-2', null, 'no-card-payment', ['p-citi', 'p-amex']],
    ]);
    assertTotalsAddUp(result);
  });

  it('sends one payment with two debits, and two payments with one debit, to the owner', () => {
    const oneTwo = reconcileCardPayments(input(
      [payment('p', 'card-amex', '2026-09-25', -50_000)],
      [debit('d-wf', '2026-09-25', -50_000, AMEX), debit('d-53', '2026-09-26', -50_000, AMEX, { checkingAccountId: FIFTH })],
    ));
    assert.deepEqual([oneTwo.pairs, oneTwo.ambiguous.map((group) => [group.paymentIds, group.debitIds])], [[], [[['p'], ['d-wf', 'd-53']]]]);
    const twoOne = reconcileCardPayments(input(
      [payment('p-1', 'card-amex', '2026-09-20', -50_000), payment('p-2', 'card-amex-2', '2026-09-24', -50_000)],
      [debit('d', '2026-09-22', -50_000, AMEX)],
    ));
    assert.deepEqual([twoOne.pairs, twoOne.ambiguous.map((group) => [group.paymentIds, group.debitIds])], [[], [[['p-1', 'p-2'], ['d']]]]);
    assertTotalsAddUp(oneTwo);
    assertTotalsAddUp(twoOne);
  });

  it('keeps a chain of same-amount payments together rather than inferring the only full pairing', () => {
    // p-1 can only be d-1, so d-2 would be p-2's, but the rules do not reason that far: the owner confirms.
    const result = reconcileCardPayments(input(
      [payment('p-1', 'card-amex', '2026-09-01', -20_000), payment('p-2', 'card-amex', '2026-09-08', -20_000)],
      [debit('d-1', '2026-09-04', -20_000, AMEX), debit('d-2', '2026-09-09', -20_000, AMEX)],
    ));
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-1', 'p-2'], ['d-1', 'd-2']]]);
  });

  it('a confirmed pair settles its group; the rest is matched again by the same rules; a rejected one leaves the group the owner\'s', () => {
    const rows = {
      payments: [payment('p', 'card-amex', '2026-09-25', -50_000)],
      debits: [debit('d-wf', '2026-09-25', -50_000, AMEX), debit('d-53', '2026-09-26', -50_000, AMEX, { checkingAccountId: FIFTH })],
    };
    const confirmed = reconcileCardPayments(input(rows.payments, rows.debits, { decisions: [decision('cpd-1', 'confirmed', 'p', 'd-53', -50_000)] }));
    assert.deepEqual(confirmed.pairs, [{ paymentId: 'p', debitId: 'd-53', dayOffset: 1, status: 'confirmed', decisionId: 'cpd-1' }]);
    assert.deepEqual(confirmed.unmatchedDebits.map((item) => [item.debitId, item.reason]), [['d-wf', 'no-card-payment']]);
    assertTotalsAddUp(confirmed);
    // Rejecting one leaves the other the payment's only candidate, but the group is the owner's (Root 02:32Z): no rule
    // pairs any of its rows by itself while the rejection stands, so the owner confirms the other one, or not.
    const rejected = reconcileCardPayments(input(rows.payments, rows.debits, { decisions: [decision('cpd-2', 'rejected', 'p', 'd-wf', -50_000)] }));
    assert.deepEqual(rejected.pairs, []);
    assert.deepEqual(rejected.ambiguous, [{ id: 'p', paymentIds: ['p'], debitIds: ['d-53'], candidates: [{ paymentId: 'p', debitId: 'd-53', dayOffset: 1 }] }]);
    assert.deepEqual(rejected.unmatchedDebits.map((item) => [item.debitId, item.possiblePayments]), [['d-wf', []]]);
    assert.deepEqual(rejected.heldGroups.map((check) => [check.outcome, check.held]), [['held', 'answered']]);
    assert.deepEqual(rejected.withheld, [{ paymentId: 'p', debitId: 'd-53', reason: 'answered' }]);
    assertTotalsAddUp(rejected);
  });

  it('keeps a component with a rejected pair the owner\'s while the owner answers its other rows (Root 03:30Z)', () => {
    const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, '0')}:00.000Z`;
    // Two payments and two debits, every pair fitting. The owner rejects P1-D1, then confirms P1-D2: the rejected debit
    // never goes to P2 by itself; P2 and D1 wait for the owner's word.
    const payments = [payment('p-1', 'card-amex', '2026-09-25', -50_000), payment('p-2', 'card-amex', '2026-09-26', -50_000)];
    const debits = [debit('d-1', '2026-09-26', -50_000, AMEX), debit('d-2', '2026-09-27', -50_000, AMEX, { checkingAccountId: FIFTH })];
    const reject = decision('cpd-1', 'rejected', 'p-1', 'd-1', -50_000, at(0));
    const confirm = decision('cpd-2', 'confirmed', 'p-1', 'd-2', -50_000, at(5));
    const confirmed = reconcileCardPayments(input(payments, debits, { decisions: [reject, confirm] }));
    assert.deepEqual(pairsOf(confirmed), [['p-1', 'd-2', 'confirmed']]);
    assert.deepEqual(confirmed.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-2'], ['d-1']]]);
    assert.deepEqual(confirmed.heldGroups.map((check) => [check.outcome, check.held]), [['held', 'answered']]);
    assert.deepEqual(confirmed.withheld, [{ paymentId: 'p-2', debitId: 'd-1', reason: 'answered' }]);
    assertTotalsAddUp(confirmed);
    // Two payments and one debit. The owner rejects P1-D1, then says P1 was paid from another account: D1 never goes
    // to P2 by itself.
    const elsewhere = reconcileCardPayments(input(payments, [debits[0]], { decisions: [reject, decision('cpd-3', 'elsewhere', 'p-1', null, -50_000, at(5))] }));
    assert.deepEqual([elsewhere.pairs, elsewhere.elsewhere.map((item) => item.paymentId)], [[], ['p-1']]);
    assert.deepEqual(elsewhere.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-2'], ['d-1']]]);
    assert.deepEqual(elsewhere.withheld, [{ paymentId: 'p-2', debitId: 'd-1', reason: 'answered' }]);
    assertTotalsAddUp(elsewhere);
    // The hold ends once the owner answers each row, or takes the rejection back.
    const all = reconcileCardPayments(input(payments, debits, { decisions: [reject, confirm, decision('cpd-4', 'confirmed', 'p-2', 'd-1', -50_000, at(9))] }));
    assert.deepEqual([pairsOf(all), all.ambiguous, all.withheld], [[['p-1', 'd-2', 'confirmed'], ['p-2', 'd-1', 'confirmed']], [], []]);
    const withdrawn = reconcileCardPayments(input(payments, debits, { decisions: [confirm] }));
    assert.deepEqual(pairsOf(withdrawn), [['p-1', 'd-2', 'confirmed'], ['p-2', 'd-1', 'matched']]);
    // A payment of such a component left with no candidate is never settled as returned by the card either: the card's
    // reversal is only offered.
    const back = payment('r', 'card-amex', '2026-09-28', 50_000, { description: 'PAYMENT RETURNED' });
    assert.deepEqual(reconcileCardPayments(input([payments[0], back], [])).returned, [{ paymentId: 'p-1', reversalId: 'r', dayOffset: 3 }]);
    const reversed = reconcileCardPayments(input([payments[0], back], [debits[0]], { decisions: [reject] }));
    assert.deepEqual([reversed.pairs, reversed.returned], [[], []]);
    assert.deepEqual(reversed.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits, item.possibleReversals]), [
      ['p-1', [], [{ reversalId: 'r', dayOffset: 3 }]],
    ]);
    assertTotalsAddUp(reversed);
  });
});

describe('reconcileCardPayments: gaps on both sides', () => {
  it('says why a payment has no debit', () => {
    const rows = [payment('p-old', 'card-amex', '2021-05-03', -10_000), payment('p-new', 'card-amex', '2026-05-03', -20_000)];
    const result = reconcileCardPayments(input(rows, []));
    assert.deepEqual(result.unmatchedPayments.map((item) => [item.paymentId, item.reason]), [
      ['p-old', 'checking-not-covered'], ['p-new', 'no-checking-debit'],
    ]);
    const without = reconcileCardPayments(input(rows, [], { checkingAccounts: [], checkingCoverage: [] }));
    assert.deepEqual(without.unmatchedPayments.map((item) => item.reason), ['no-checking-account', 'no-checking-account']);
    assert.deepEqual(without.totals[0].payments.unmatched, { count: 2, amountMinor: -30_000 });
  });

  it('says why a card-payment debit has no payment, and leaves other debits out', () => {
    const result = reconcileCardPayments(input([], [
      debit('d-discover', '2026-05-03', -1_000, 'DISCOVER E-PAYMENT 999999 9999 SAMPLE HOLDER'),
      debit('d-amex-old', '2021-05-03', -2_000, AMEX),
      debit('d-amex', '2026-05-03', -3_000, AMEX),
      debit('d-generic', '2026-05-04', -4_000, GENERIC),
      debit('d-savings', '2026-05-05', -5_000, SAVINGS),
      debit('d-named', '2026-05-06', -6_000, GENERIC_NAMED),
    ], { cardCoverage: [{ accountId: 'card-amex', ranges: [{ start: '2025-01-01', end: '2026-09-30' }] }] }));
    assert.deepEqual(result.unmatchedDebits.map((item) => [item.debitId, item.payee, item.reason]), [
      ['d-amex-old', 'amex', 'card-not-covered'],
      ['d-amex', 'amex', 'no-card-payment'],
      ['d-discover', 'discover', 'no-card-account'],
      ['d-generic', null, 'no-card-payment'],
      // An unrecognized payee may be any card's: a covered card and no payment.
      ['d-named', 'unrecognized', 'no-card-payment'],
    ]);
    assert.equal(result.classes.get('d-savings')?.class, 'other');
    assert.deepEqual(result.totals[0].debits.unmatched, { count: 5, amountMinor: -16_000 });
    assertTotalsAddUp(result);
    const noCards = reconcileCardPayments(input([], [debit('d-named', '2026-05-06', -6_000, GENERIC_NAMED)], { cardAccounts: [] }));
    assert.equal(noCards.unmatchedDebits[0].reason, 'no-card-account');
  });

  it('offers debits that do not read as card payments to a payment with no candidate, never matching them', () => {
    const result = reconcileCardPayments(input(
      [payment('p', 'card-citi', '2026-07-10', -64_210)],
      [debit('d-far', '2026-07-01', -64_210, SAVINGS), debit('d-1', '2026-07-12', -64_210, SAVINGS), debit('d-2', '2026-07-09', -64_210, 'SAMPLE ABBREVIATED WEB PMT')],
    ));
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.unmatchedPayments[0].possibleDebits.map((item) => [item.debitId, item.dayOffset]), [['d-2', -1], ['d-1', 2]]);
    assert.deepEqual(result.unmatchedDebits, []);
  });
});

describe('reconcileCardPayments: Bilt', () => {
  const housing = { description: 'HOUSING PAYMENT SAMPLE SERVICER', issuerCategory: 'Housing payment' };

  it('matches a Pay-card payment with its Bilt debit, never with a same-amount housing pull beside it', () => {
    const result = reconcileCardPayments(input(
      [payment('p-bilt', 'card-bilt', '2026-10-01', -300_000)],
      [debit('d-housing', '2026-10-01', -300_000, BILT_RENT), debit('d-bilt', '2026-10-02', -300_000, BILT_CARD)],
    ));
    assert.deepEqual(result.pairs, [{ paymentId: 'p-bilt', debitId: 'd-bilt', dayOffset: 1, status: 'matched' }]);
    assert.deepEqual(result.biltHousing, [{ debitId: 'd-housing', payee: 'bilt', reason: 'no-card-payment', possiblePayments: [] }]);
    assert.deepEqual(result.unmatchedDebits, []);
    assert.deepEqual(result.totals[0].debits.biltHousing, { count: 1, amountMinor: -300_000 });
    assert.deepEqual(result.totals[0].debits.all, { count: 1, amountMinor: -300_000 });
    assertTotalsAddUp(result);
  });

  it('matches each housing payment row with its same-day housing pull, and each Pay-card payment with its own debit', () => {
    // The regression: a housing pull and a Pay-card payment of one amount, the same week, on the one Bilt card.
    const result = reconcileCardPayments(input(
      [
        payment('p-housing', 'card-bilt', '2026-05-01', -300_000, housing),
        payment('p-paycard', 'card-bilt', '2026-05-03', -300_000, { description: 'PAYMENT RECEIVED' }),
        payment('p-housing-2', 'card-bilt', '2026-05-15', -125_000, housing),
      ],
      [
        debit('d-housing', '2026-05-01', -300_000, BILT_RENT),
        debit('d-paycard', '2026-05-04', -300_000, BILT_CARD, { checkingAccountId: FIFTH }),
        debit('d-housing-2', '2026-05-15', -125_000, 'BILT MORTGAGE PAYMENT 999999 SAMPLE HOLDER'),
      ],
    ));
    assert.deepEqual(pairsOf(result), [
      ['p-housing', 'd-housing', 'matched'], ['p-paycard', 'd-paycard', 'matched'], ['p-housing-2', 'd-housing-2', 'matched'],
    ]);
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits, result.biltHousing], [[], [], [], []]);
    assert.deepEqual(result.totals[0].debits.matched, { count: 3, amountMinor: -725_000 });
    assertTotalsAddUp(result);
  });

  it('never ties, offers or confirms a pair across the Bilt lanes, either way', () => {
    const result = reconcileCardPayments(input(
      [payment('p-housing', 'card-bilt', '2026-06-01', -300_000, housing), payment('p-amex', 'card-amex', '2026-06-01', -300_000)],
      [debit('d-bilt', '2026-06-01', -300_000, BILT_CARD), debit('d-housing', '2026-06-02', -300_000, BILT_RENT)],
    ));
    // The housing pull pays the housing row; the Pay-card debit has no Pay-card payment, and is never the Amex payment's.
    assert.deepEqual(pairsOf(result), [['p-housing', 'd-housing', 'matched']]);
    assert.deepEqual(result.unmatchedPayments, [{ paymentId: 'p-amex', reason: 'no-checking-debit', possibleDebits: [{ paymentId: 'p-amex', debitId: 'd-bilt', dayOffset: 0 }] }]);
    assert.deepEqual(result.unmatchedDebits.map((item) => [item.debitId, item.payee, item.possiblePayments]), [['d-bilt', 'bilt', [{ paymentId: 'p-amex', debitId: 'd-bilt', dayOffset: 0 }]]]);
    // A housing row beside only an ordinary Bilt debit, and a Pay-card payment beside only a housing pull, of one
    // amount and day: each a gap with its reason, nothing offered across.
    const paycard = payment('p-paycard', 'card-bilt', '2026-07-01', -300_000, { description: 'PAYMENT RECEIVED' });
    const housingRow = payment('p-housing', 'card-bilt', '2026-06-01', -300_000, housing);
    const ordinary = debit('d-bilt', '2026-06-01', -300_000, BILT_CARD);
    const pull = debit('d-housing', '2026-07-01', -300_000, BILT_RENT);
    const crossed = reconcileCardPayments(input([housingRow, paycard], [ordinary, pull]));
    assert.deepEqual([crossed.pairs, crossed.ambiguous], [[], []]);
    assert.deepEqual(crossed.unmatchedPayments, [
      { paymentId: 'p-housing', reason: 'no-checking-debit', possibleDebits: [] },
      { paymentId: 'p-paycard', reason: 'no-checking-debit', possibleDebits: [] },
    ]);
    assert.deepEqual(crossed.unmatchedDebits, [{ debitId: 'd-bilt', payee: 'bilt', reason: 'no-card-payment', possiblePayments: [] }]);
    assert.deepEqual(crossed.biltHousing, [{ debitId: 'd-housing', payee: 'bilt', reason: 'no-card-payment', possiblePayments: [] }]);
    assertTotalsAddUp(crossed);
    // The owner may not confirm either crossing (nor reject one: it never was a candidate).
    assert.equal(cardPaymentConfirmRefusal(paycard, pull, 'bilt'), 'housing');
    assert.equal(cardPaymentConfirmRefusal(housingRow, ordinary, 'bilt'), 'housing');
    assert.equal(cardPaymentConfirmRefusal(housingRow, debit('d-other-card', '2026-06-01', -300_000, CITI), 'bilt'), 'housing');
    // Nor a housing row with a debit that reads as no card payment, or names no issuer.
    assert.equal(cardPaymentConfirmRefusal(housingRow, debit('d-savings', '2026-06-01', -300_000, SAVINGS), 'bilt'), 'housing');
    assert.equal(cardPaymentConfirmRefusal(housingRow, debit('d-utility', '2026-06-01', -300_000, 'SAMPLE UTILITY BILL PAY'), 'bilt'), 'housing');
    assert.equal(cardPaymentConfirmRefusal(housingRow, debit('d-generic', '2026-06-01', -300_000, GENERIC), 'bilt'), 'housing');
    // Within its own lane the owner may.
    assert.equal(cardPaymentConfirmRefusal(housingRow, debit('d-pull', '2026-06-01', -300_000, BILT_RENT), 'bilt'), null);
    assert.equal(cardPaymentConfirmRefusal(paycard, debit('d-card', '2026-07-01', -300_000, BILT_CARD), 'bilt'), null);
    const offered = reconcileCardPayments(input([housingRow], [debit('d-utility', '2026-06-01', -300_000, 'SAMPLE UTILITY BILL PAY')]));
    assert.deepEqual(offered.unmatchedPayments, [{ paymentId: 'p-housing', reason: 'no-checking-debit', possibleDebits: [] }]);
    // Answers that cross, stored before this rule or written around it, do nothing: the rules pair each lane.
    const sameDay = [payment('p-housing', 'card-bilt', '2026-08-01', -300_000, housing), payment('p-paycard', 'card-bilt', '2026-08-01', -300_000)];
    const sameDayDebits = [debit('d-housing', '2026-08-01', -300_000, BILT_RENT), debit('d-bilt', '2026-08-01', -300_000, BILT_CARD)];
    const forced = reconcileCardPayments(input(sameDay, sameDayDebits, {
      decisions: [decision('cpd-1', 'confirmed', 'p-paycard', 'd-housing', -300_000), decision('cpd-2', 'confirmed', 'p-housing', 'd-bilt', -300_000)],
    }));
    assert.deepEqual(forced.staleDecisions, [{ decisionId: 'cpd-1', reason: 'housing' }, { decisionId: 'cpd-2', reason: 'housing' }]);
    assert.deepEqual(pairsOf(forced), [['p-housing', 'd-housing', 'matched'], ['p-paycard', 'd-bilt', 'matched']]);
    assertTotalsAddUp(forced);
  });

  it('never offers or confirms a housing pull for another card', () => {
    const rows = [payment('p-amex', 'card-amex', '2026-10-01', -300_000)];
    const debits = [debit('d-housing', '2026-10-01', -300_000, BILT_RENT)];
    const result = reconcileCardPayments(input(rows, debits));
    assert.deepEqual(result.unmatchedPayments, [{ paymentId: 'p-amex', reason: 'no-checking-debit', possibleDebits: [] }]);
    assert.deepEqual(result.biltHousing.map((item) => [item.debitId, item.possiblePayments]), [['d-housing', []]]);
    assert.equal(cardPaymentConfirmRefusal(rows[0], debits[0], 'amex'), 'housing');
    // On the Bilt card too, only its housing payment row.
    assert.equal(cardPaymentConfirmRefusal({ ...rows[0], cardAccountId: 'card-bilt' }, debits[0], 'bilt'), 'housing');
    assert.equal(cardPaymentConfirmRefusal({ ...rows[0], cardAccountId: 'card-bilt', issuerCategory: 'Housing payment' }, debits[0], 'bilt'), null);
    const forced = reconcileCardPayments(input(rows, debits, { decisions: [decision('cpd-h', 'confirmed', 'p-amex', 'd-housing', -300_000)] }));
    assert.deepEqual([forced.pairs, forced.staleDecisions], [[], [{ decisionId: 'cpd-h', reason: 'housing' }]]);
    // Without a Bilt card in Holdr, a housing pull says so.
    const noBilt = reconcileCardPayments(input([], debits, { cardAccounts: CARDS.filter((card) => card.issuer !== 'bilt') }));
    assert.equal(noBilt.biltHousing[0].reason, 'no-card-account');
  });

  it('reads a housing payment row only on the Bilt card, by its words', () => {
    assert.equal(isBiltHousingPayment({ kind: 'payment', issuerCategory: 'Housing payment' }, 'bilt'), true);
    assert.equal(isBiltHousingPayment({ kind: 'payment', description: 'MORTGAGE PAYMENT' }, 'bilt'), true);
    assert.equal(isBiltHousingPayment({ kind: 'payment', description: 'MORTGAGE PAYMENT' }, 'cardless'), false);
    assert.equal(isBiltHousingPayment({ kind: 'payment', description: 'MORTGAGE PAYMENT' }, 'wellsfargo'), false);
    assert.equal(isBiltHousingPayment({ kind: 'payment', description: 'PAYMENT RECEIVED' }, 'bilt'), false);
    assert.equal(isBiltHousingPayment({ kind: 'other', issuerCategory: 'Housing payment' }, 'bilt'), false);
    assert.equal(isBiltHousingPayment({ kind: 'payment', issuerCategory: 'Housing payment' }, 'amex'), false);
    // Whole tokens only, in each of the three fields (Root 03:56Z): HOUSINGÉ or HOUSING💰 is no HOUSING.
    for (const field of ['description', 'merchant', 'issuerCategory'] as const) {
      for (const [text, housing] of [
        ['PAY CARD HOUSINGÉ', false], ['HOUSING💰', false], ['ÉRENT', false], ['RENTAL©', false], ['PAY CARD HOUSING', true],
        ['HOUSING-PAYMENT', true], ['RENT/MORTGAGE', true], ['HOME-LOAN', true], ['HOUSING 💰', true],
      ] as const) {
        assert.equal(isBiltHousingPayment({ kind: 'payment', [field]: text }, 'bilt'), housing, `${field}: ${text}`);
      }
    }
  });

  it('matches a Wells Fargo transfer to the Bilt card it issued', () => {
    const result = reconcileCardPayments(input(
      [payment('p-bilt', 'card-bilt', '2025-06-01', -123_456)],
      [debit('d', '2025-06-01', -123_456, 'ONLINE TRANSFER REF #IBE9999999 TO BILT WORLD ELITE MASTERCARD XXXXXX9999 ON 99/99/99')],
    ));
    assert.deepEqual(pairsOf(result), [['p-bilt', 'd', 'matched']]);
  });

  it('never lets Bilt, Wells Fargo or Cardless stand in for one another, only offers', () => {
    const crossed: Array<[string, string]> = [
      ['card-wf', BILT_CARD], ['card-bilt', 'WF CREDIT CARD AUTO PAY ***9999 SAMPLE HOLDER'], ['card-bilt', WF_CARD],
      ['card-bilt', 'CARDLESS CARD PAYMENT 999999'], ['card-wf', 'ONLINE TRANSFER REF #IBE9999999 TO BILT WORLD ELITE MASTERCARD XXXXXX9999 ON 99/99/99'],
    ];
    for (const [card, text] of crossed) {
      const result = reconcileCardPayments(input([payment('p', card, '2026-06-01', -10_000)], [debit('d', '2026-06-02', -10_000, text)]));
      assert.deepEqual([pairsOf(result), result.ambiguous], [[], []], `${text} on ${card}`);
      assert.deepEqual(result.unmatchedPayments[0].possibleDebits.map((item) => item.debitId), ['d'], `${text} offered on ${card}`);
    }
  });
});

describe('reconcileCardPayments: plain ASCII on both sides, and products that name no issuer', () => {
  const FIELDS = ['description', 'merchant', 'issuerCategory'] as const;

  it('never matches a payment whose description, merchant or category is not plain ASCII; the owner may confirm it', () => {
    for (const field of FIELDS) {
      for (const text of ['Synthetic ©', 'PAYMENT 💳', 'Payments €', 'PAYMENT \uFFFD', 'PAYMENTÉ', 'PAY\u0007MENT']) {
        const row = payment('p', 'card-amex', '2026-06-01', -10_000, { [field]: text });
        const result = reconcileCardPayments(input([row], [debit('d', '2026-06-02', -10_000, AMEX)]));
        assert.deepEqual(result.pairs, [], `${field}: ${JSON.stringify(text)}`);
        assert.deepEqual(result.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p'], ['d']]], `${field}: ${JSON.stringify(text)}`);
        assertTotalsAddUp(result);
        assert.equal(cardPaymentConfirmRefusal(row, debit('d', '2026-06-02', -10_000, AMEX), 'amex'), null);
        const confirmed = reconcileCardPayments(input([row], [debit('d', '2026-06-02', -10_000, AMEX)], {
          decisions: [decision('cpd', 'confirmed', 'p', 'd', -10_000)],
        }));
        assert.deepEqual(pairsOf(confirmed), [['p', 'd', 'confirmed']]);
      }
    }
    // Controls: plain ASCII text, or none, in every field.
    for (const extra of [{ description: 'PAYMENT RECEIVED - THANK YOU', merchant: 'Synthetic (c)', issuerCategory: 'Payments' }, { merchant: null as never }, {}]) {
      const result = reconcileCardPayments(input([payment('p', 'card-amex', '2026-06-01', -10_000, extra)], [debit('d', '2026-06-02', -10_000, AMEX)]));
      assert.deepEqual(pairsOf(result), [['p', 'd', 'matched']], JSON.stringify(extra));
    }
  });

  it('keeps such a payment a candidate, so a same-issuer payment beside it is never matched alone', () => {
    // 1f309a7f: two Amex cards paid one amount the same day, one with a symbol in its merchant; one Amex debit.
    const result = reconcileCardPayments(input(
      [
        payment('p-plain', 'card-amex', '2026-06-01', -10_000),
        payment('p-symbol', 'card-amex-2', '2026-06-01', -10_000, { merchant: 'Synthetic ©' }),
      ],
      [debit('d', '2026-06-01', -10_000, AMEX)],
    ));
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.ambiguous.map((group) => [group.paymentIds, group.debitIds, group.candidates.length]), [[['p-plain', 'p-symbol'], ['d'], 2]]);
    assertTotalsAddUp(result);
  });

  it('keeps the Bilt lanes by whole tokens in every field: HOUSINGÉ is an ordinary payment, never matched by itself', () => {
    // 1f309a7f's four cases, and their controls, per field.
    for (const field of FIELDS) {
      const fields = { description: 'PAY CARD', merchant: null as never, issuerCategory: 'Payments', [field]: field === 'description' ? 'PAY CARD HOUSINGÉ' : 'HOUSINGÉ' };
      const row = payment('p', 'card-bilt', '2026-06-01', -10_000, fields);
      const pull = debit('d-pull', '2026-06-01', -10_000, BILT_RENT);
      const card = debit('d-card', '2026-06-01', -10_000, BILT_CARD);
      // Beside a housing pull: neither matched nor offered, each a gap; confirming it is refused.
      const crossed = reconcileCardPayments(input([row], [pull]));
      assert.deepEqual([crossed.pairs, crossed.ambiguous], [[], []], field);
      assert.deepEqual(crossed.unmatchedPayments, [{ paymentId: 'p', reason: 'no-checking-debit', possibleDebits: [] }], field);
      assert.deepEqual(crossed.biltHousing.map((item) => [item.debitId, item.possiblePayments]), [['d-pull', []]], field);
      assert.equal(cardPaymentConfirmRefusal(row, pull, 'bilt'), 'housing', field);
      const forced = reconcileCardPayments(input([row], [pull], { decisions: [decision('cpd', 'confirmed', 'p', 'd-pull', -10_000)] }));
      assert.deepEqual([forced.pairs, forced.staleDecisions], [[], [{ decisionId: 'cpd', reason: 'housing' }]], field);
      // Beside an ordinary Bilt debit: its own lane, for the owner only (not plain ASCII); confirming it is allowed.
      const own = reconcileCardPayments(input([row], [card]));
      assert.deepEqual(own.pairs, [], field);
      assert.deepEqual(own.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p'], ['d-card']]], field);
      assert.equal(cardPaymentConfirmRefusal(row, card, 'bilt'), null, field);
    }
    // Controls: plain housing words match the pull and refuse the ordinary debit; a plain ordinary row the reverse.
    const housingRow = payment('p', 'card-bilt', '2026-06-01', -10_000, { description: 'PAY CARD HOUSING', issuerCategory: 'Payments' });
    const ordinaryRow = payment('p', 'card-bilt', '2026-06-01', -10_000, { description: 'PAY CARD', issuerCategory: 'Payments' });
    const pull = debit('d-pull', '2026-06-01', -10_000, BILT_RENT);
    const card = debit('d-card', '2026-06-01', -10_000, BILT_CARD);
    assert.deepEqual(pairsOf(reconcileCardPayments(input([housingRow], [pull]))), [['p', 'd-pull', 'matched']]);
    assert.deepEqual(pairsOf(reconcileCardPayments(input([ordinaryRow], [card]))), [['p', 'd-card', 'matched']]);
    assert.equal(cardPaymentConfirmRefusal(housingRow, card, 'bilt'), 'housing');
    assert.equal(cardPaymentConfirmRefusal(ordinaryRow, pull, 'bilt'), 'housing');
    // A whole HOUSING beside a symbol keeps the housing lane, for the owner only.
    const symbolRow = payment('p', 'card-bilt', '2026-06-01', -10_000, { description: 'PAY CARD HOUSING 💰' });
    const symbol = reconcileCardPayments(input([symbolRow], [pull]));
    assert.deepEqual([symbol.pairs, symbol.ambiguous.map((group) => [group.paymentIds, group.debitIds])], [[], [[['p'], ['d-pull']]]]);
    assert.equal(cardPaymentConfirmRefusal(symbolRow, card, 'bilt'), 'housing');
  });

  it('pays a debit naming a card\'s product alone only to the one Wells Fargo card the rows show carries it (RECON-34 A)', () => {
    // Root 03:59Z: a product names one card, not its issuer. Root (RECON-34 A): it pays the one Wells Fargo card the
    // transfers naming that product fit, found as the Bilt card's carrier is; two such cards, and it pays neither.
    for (const [text, product] of [
      ['ONLINE TRANSFER TO MICRO CENTER', 'MICRO CENTER'], ['ONLINE TRANSFER REF #IBE9999999 TO AUTOGRAPH ON 99/99/99', 'AUTOGRAPH'],
      ['ONLINE TRANSFER TO ACTIVE CASH XXXXXX9999', 'ACTIVE CASH'], ['ONLINE TRANSFER REF #IBE9999999 TO REFLECT XXXXXX9999 ON 99/99/99', 'REFLECT'],
    ]) {
      assert.deepEqual(classifyCheckingDebit(text), { class: 'card-payment', payee: 'unrecognized', rule: 'product-name' }, text);
      const pWf = payment('p-wf', 'card-wf', '2026-06-01', -10_000);
      const d = debit('d', '2026-06-01', -10_000, text);
      const alone = input([pWf], [d]);
      const result = reconcileCardPayments(alone);
      assert.deepEqual([pairsOf(result), result.productCarriers], [[['p-wf', 'd', 'matched']], [{ product, cardAccountId: 'card-wf' }]], text);
      // The rules' own test of a pair, for the operator's report, reads the carrier the result found (PR280-R4).
      assert.equal(cardPaymentCandidateCheck(alone, result)(pWf, d), true, text);
      assertTotalsAddUp(result);
      // Two Wells Fargo cards paid its amount close by: the rows name two cards, so it pays neither, only offered.
      const twoInput = input([pWf, payment('p-wf-2', 'card-wf-2', '2026-06-02', -10_000)], [d],
        { cardAccounts: [...CARDS, { id: 'card-wf-2', issuer: 'wellsfargo' }] });
      const two = reconcileCardPayments(twoInput);
      assert.deepEqual([two.pairs, two.ambiguous, two.productCarriers], [[], [], []], text);
      assert.equal(cardPaymentCandidateCheck(twoInput, two)(pWf, d), false, text);
      assert.deepEqual(two.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]),
        [['p-wf', ['d']], ['p-wf-2', ['d']]], text);
      assert.deepEqual(two.unmatchedDebits.map((item) => [item.debitId, item.payee]), [['d', 'unrecognized']], text);
    }
    // Words naming two products, or a product only across punctuation: no product, so never paid, only offered.
    for (const text of ['ONLINE TRANSFER TO AUTOGRAPH REFLECT', 'ONLINE TRANSFER TO MICRO+CENTER']) {
      const result = reconcileCardPayments(input([payment('p-wf', 'card-wf', '2026-06-01', -10_000)], [debit('d', '2026-06-01', -10_000, text)]));
      assert.deepEqual([result.pairs, result.ambiguous, result.productCarriers], [[], [], []], text);
      assert.deepEqual(result.unmatchedPayments[0].possibleDebits.map((item) => item.debitId), ['d'], text);
    }
    // With the issuer's own name, a product is its payment word: matched when its one card has the one payment …
    for (const text of ['ONLINE TRANSFER TO WELLS FARGO MICRO CENTER', 'WF ONLINE TRANSFER TO AUTOGRAPH', 'ONLINE TRANSFER TO WF ACTIVE CASH',
      'ONLINE TRANSFER TO WELLS FARGO REFLECT']) {
      assert.equal(classifyCheckingDebit(text).payee, 'wellsfargo', text);
      const result = reconcileCardPayments(input([payment('p-wf', 'card-wf', '2026-06-01', -10_000)], [debit('d', '2026-06-01', -10_000, text)]));
      assert.deepEqual(pairsOf(result), [['p-wf', 'd', 'matched']], text);
    }
    // … and the owner's when two of the issuer's cards were paid that amount in the window.
    const twoCards = reconcileCardPayments(input(
      [payment('p-wf', 'card-wf', '2026-06-01', -10_000), payment('p-wf-2', 'card-wf-2', '2026-06-02', -10_000)],
      [debit('d', '2026-06-01', -10_000, 'ONLINE TRANSFER TO WELLS FARGO MICRO CENTER')],
      { cardAccounts: [...CARDS, { id: 'card-wf-2', issuer: 'wellsfargo' }] },
    ));
    assert.deepEqual(twoCards.pairs, []);
    assert.deepEqual(twoCards.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-wf', 'p-wf-2'], ['d']]]);
  });
});

describe('reconcileCardPayments: a masked card number identifies the card', () => {
  // Two Wells Fargo cards (an Autograph-like card and a Micro Center-like card), the Cardless Bilt card, and checking
  // accounts with their own numbers, every ending made up.
  const WF_CARDS = [
    { id: 'card-autograph', issuer: 'wellsfargo', last4: '0002' },
    { id: 'card-microcenter', issuer: 'wellsfargo', last4: '0003' },
    { id: 'card-bilt', issuer: 'bilt', last4: '0001' },
  ];
  const CHECKING = [{ id: WF, last4: '0004' }, { id: FIFTH, last4: '0005' }];
  const TO_AUTOGRAPH = (last4: string) => `ONLINE TRANSFER REF #IBE9999999 TO WELLS FARGO AUTOGRAPH VISA CARD XXXXXX${last4} ON 99/99/99`;
  const TO_MICROCENTER = (last4: string) => `ONLINE TRANSFER REF #IBE9999999 TO MICRO CENTER CREDIT CARD XXXXXX${last4} ON 99/99/99`;
  const TO_BILT = (last4: string) => `ONLINE TRANSFER REF #IBE9999999 TO BILT WORLD ELITE MASTERCARD XXXXXX${last4} ON 99/99/99`;
  const wfInput = (cardRows: ReconciliationCardRow[], checkingRows: ReconciliationCheckingRow[], extra: Partial<CardPaymentReconciliationInput> = {}) => {
    const cardAccounts = extra.cardAccounts ?? WF_CARDS;
    return input(cardRows, checkingRows, {
      cardAccounts,
      checkingAccounts: CHECKING,
      cardCoverage: cardAccounts.map((card) => ({ accountId: card.id, ranges: card.issuer === 'bilt' ? [{ start: CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom, end: '2026-10-15' }] : WIDE })),
      ...extra,
    });
  };
  const groupsOf = (result: CardPaymentReconciliation) => result.ambiguous.map((group) => [group.paymentIds, group.debitIds]);

  it('reads the last four of each masked card number, as whole tokens of X\'s and four digits', () => {
    assert.deepEqual(maskedCardNumbers(TO_AUTOGRAPH('1234')), ['1234']);
    assert.deepEqual(maskedCardNumbers('WF CREDIT CARD AUTO PAY xxxxxx1234 XX5678 XXXXXX1234'), ['1234', '5678']);
    for (const text of ['X1234 CARD', 'XXXXXX12345', 'XXXXXX123', '***1234', 'XXXXXX-1234', 'ABXXXX1234', 'REF #IBE9999999', '', 42 as never]) {
      assert.deepEqual(maskedCardNumbers(text), [], String(text));
    }
    assert.equal(CARD_PAYMENT_RECONCILIATION_RULES.version, 6);
  });

  it('tells two Wells Fargo cards apart by the masked number each transfer prints', () => {
    const rows = [payment('p-auto', 'card-autograph', '2026-07-01', -10_000), payment('p-mc', 'card-microcenter', '2026-07-02', -10_000)];
    const debits = [debit('d-auto', '2026-07-01', -10_000, TO_AUTOGRAPH('0002')), debit('d-mc', '2026-07-02', -10_000, TO_MICROCENTER('0003'))];
    const result = reconcileCardPayments(wfInput(rows, debits));
    assert.deepEqual(pairsOf(result), [['p-auto', 'd-auto', 'matched'], ['p-mc', 'd-mc', 'matched']]);
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits], [[], [], []]);
    assertTotalsAddUp(result);
    // Control: the same rows without the cards' last fours, as before: the Wells Fargo transfer could pay either card
    // (the owner's), and the product alone pays neither, both cards having been paid its amount close by.
    const unknown = reconcileCardPayments(wfInput(rows, debits, { cardAccounts: WF_CARDS.map((card) => ({ id: card.id, issuer: card.issuer })) }));
    assert.deepEqual([unknown.pairs, groupsOf(unknown)], [[], [[['p-auto', 'p-mc'], ['d-auto']]]]);
    assert.deepEqual(unknown.unmatchedDebits.map((item) => [item.debitId, item.payee]), [['d-mc', 'unrecognized']]);
    assertTotalsAddUp(unknown);
  });

  it('pins a Wells Fargo debit to its card when the other card was paid the same amount close by', () => {
    const rows = [payment('p-auto', 'card-autograph', '2026-08-01', -20_000), payment('p-mc', 'card-microcenter', '2026-08-03', -20_000)];
    const pinned = reconcileCardPayments(wfInput(rows, [debit('d', '2026-08-02', -20_000, 'WF CREDIT CARD PAYMENT XXXXXX0002 SAMPLE HOLDER')]));
    assert.deepEqual(pairsOf(pinned), [['p-auto', 'd', 'matched']]);
    assert.deepEqual(pinned.unmatchedPayments.map((item) => [item.paymentId, item.reason, item.possibleDebits]), [['p-mc', 'no-checking-debit', []]]);
    assertTotalsAddUp(pinned);
    // Without the number, the owner's word, as before.
    const unpinned = reconcileCardPayments(wfInput(rows, [debit('d', '2026-08-02', -20_000, 'WF CREDIT CARD PAYMENT SAMPLE HOLDER')]));
    assert.deepEqual([unpinned.pairs, groupsOf(unpinned)], [[], [[['p-auto', 'p-mc'], ['d']]]]);
  });

  it('pairs a card\'s product alone with the card its number names, else the one card the rows show carries it (RECON-34 A)', () => {
    const row = payment('p-mc', 'card-microcenter', '2026-09-01', -3_333);
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput([row], [debit('d', '2026-09-01', -3_333, TO_MICROCENTER('0003'))]))), [['p-mc', 'd', 'matched']]);
    // A number of no Wells Fargo card (another account's, the Bilt card's, the paying account's own), or none at all: the
    // transfer names the product alone, and the rows show the Micro Center-like card carries it, so it pays that card.
    for (const text of [TO_MICROCENTER('0909'), TO_MICROCENTER('0001'), TO_MICROCENTER('0004'), 'ONLINE TRANSFER TO MICRO CENTER']) {
      const result = reconcileCardPayments(wfInput([row], [debit('d', '2026-09-01', -3_333, text)]));
      assert.deepEqual([pairsOf(result), result.productCarriers], [[['p-mc', 'd', 'matched']], [{ product: 'MICRO CENTER', cardAccountId: 'card-microcenter' }]], text);
      assertTotalsAddUp(result);
    }
  });

  it('finds the card carrying a product only where the rows name one card, and pays none otherwise (RECON-34 A)', () => {
    // The Micro Center-like card's payments, each paid by a transfer naming the product alone: that card carries it.
    const TO_PRODUCT = (product: string) => `ONLINE TRANSFER REF #IBE9999999 TO ${product} ON 99/99/99`;
    const CARRIER = [{ product: 'MICRO CENTER', cardAccountId: 'card-microcenter' }];
    const rows = [payment('p-1', 'card-microcenter', '2025-08-01', -11_100), payment('p-2', 'card-microcenter', '2025-09-17', -22_200)];
    const debits = [debit('d-1', '2025-08-03', -11_100, TO_PRODUCT('MICRO CENTER')), debit('d-2', '2025-09-17', -22_200, TO_PRODUCT('MICRO CENTER'))];
    const one = reconcileCardPayments(wfInput(rows, debits));
    assert.deepEqual([pairsOf(one), one.productCarriers, one.withheld], [[['p-1', 'd-1', 'matched'], ['p-2', 'd-2', 'matched']], CARRIER, []]);
    assertTotalsAddUp(one);
    // One transfer fits the Autograph-like card's payment instead: the rows name two cards, so none, each only offered.
    const decoy = [rows[0], payment('p-auto', 'card-autograph', '2025-09-18', -22_200)];
    const two = reconcileCardPayments(wfInput(decoy, debits));
    assert.deepEqual([two.pairs, two.ambiguous, two.productCarriers], [[], [], []]);
    assert.deepEqual(two.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-1', ['d-1']], ['p-auto', ['d-2']]]);
    assertTotalsAddUp(two);
    // The owner's "not this one" to that pair takes it out of the rows' word: one card again, and it pays it.
    const rejected = reconcileCardPayments(wfInput(decoy, debits, { decisions: [decision('cpd', 'rejected', 'p-auto', 'd-2', -22_200)] }));
    assert.deepEqual([pairsOf(rejected), rejected.productCarriers], [[['p-1', 'd-1', 'matched']], CARRIER]);
    assert.deepEqual(rejected.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits]), [['p-auto', []]]);
    // The owner's confirmation of such a transfer with the other card names that card too, even past the rules' days.
    const confirmed = reconcileCardPayments(wfInput([rows[0], payment('p-auto', 'card-autograph', '2025-09-28', -22_200)], debits, {
      decisions: [decision('cpd', 'confirmed', 'p-auto', 'd-2', -22_200)],
    }));
    assert.deepEqual([pairsOf(confirmed), confirmed.productCarriers], [[['p-auto', 'd-2', 'confirmed']], []]);
    assert.deepEqual(confirmed.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-1', ['d-1']]]);
    // So does one whose masked number names the other card, which it pays as before.
    const masked = reconcileCardPayments(wfInput([rows[0], payment('p-auto', 'card-autograph', '2025-09-17', -22_200)],
      [debits[0], debit('d-2', '2025-09-17', -22_200, TO_MICROCENTER('0002'))]));
    assert.deepEqual([pairsOf(masked), masked.productCarriers], [[['p-auto', 'd-2', 'matched']], []]);
    // Each product apart: transfers naming another product fit the other card, and leave this one's carrier as it is.
    const both = reconcileCardPayments(wfInput([...rows, payment('p-auto', 'card-autograph', '2025-10-05', -44_400)],
      [...debits, debit('d-auto', '2025-10-06', -44_400, TO_PRODUCT('AUTOGRAPH'))]));
    assert.deepEqual([pairsOf(both), both.productCarriers], [
      [['p-1', 'd-1', 'matched'], ['p-2', 'd-2', 'matched'], ['p-auto', 'd-auto', 'matched']],
      [{ product: 'AUTOGRAPH', cardAccountId: 'card-autograph' }, ...CARRIER],
    ]);
    // A transfer naming the product only across punctuation, or two products, is not read for it: it fits the other
    // card, and the carrier stands; it pays nothing itself.
    for (const text of [TO_PRODUCT('MICRO+CENTER'), TO_PRODUCT('MICRO CENTER REFLECT')]) {
      const odd = reconcileCardPayments(wfInput([...rows, payment('p-auto', 'card-autograph', '2025-10-05', -44_400)], [...debits, debit('d-odd', '2025-10-05', -44_400, text)]));
      assert.deepEqual([pairsOf(odd), odd.productCarriers], [[['p-1', 'd-1', 'matched'], ['p-2', 'd-2', 'matched']], CARRIER], text);
      assert.deepEqual(odd.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-auto', ['d-odd']]], text);
    }
    // A transfer its bank returned unpaid, netted with its return, fits no card.
    const netted = reconcileCardPayments(wfInput(decoy, [debits[0], debits[1], debit('c-2', '2025-09-19', 22_200, 'UNPAID ITEM RETURN 999999')]));
    assert.deepEqual([pairsOf(netted), netted.productCarriers, netted.returnedDebits.map((item) => item.debitId)], [[['p-1', 'd-1', 'matched']], CARRIER, ['d-2']]);
  });

  it('pays a transfer naming one product only through that product\'s own carrier, never another product\'s (RECON-34 A)', () => {
    // The Autograph-like card carries AUTOGRAPH (its one transfer fits it alone). A transfer naming MICRO CENTER fits both
    // Wells Fargo cards' payments of its amount: no carrier for it, so it pays neither, not even the card carrying the other
    // product; both payments are offered it.
    const rows = [payment('p-y', 'card-autograph', '2025-10-05', -44_400), payment('p-a2', 'card-autograph', '2025-11-10', -55_500),
      payment('p-m2', 'card-microcenter', '2025-11-11', -55_500)];
    const debits = [debit('d-y', '2025-10-06', -44_400, 'ONLINE TRANSFER TO AUTOGRAPH'), debit('d-x', '2025-11-10', -55_500, 'ONLINE TRANSFER TO MICRO CENTER')];
    const result = reconcileCardPayments(wfInput(rows, debits));
    assert.deepEqual([pairsOf(result), result.productCarriers], [[['p-y', 'd-y', 'matched']], [{ product: 'AUTOGRAPH', cardAccountId: 'card-autograph' }]]);
    assert.deepEqual(result.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]),
      [['p-a2', ['d-x']], ['p-m2', ['d-x']]]);
    assertTotalsAddUp(result);
  });

  it('counts a pair version 3 matched that a product\'s carrier now holds as read anew, never as the owner\'s answer (RECON-34 A)', () => {
    // A Wells Fargo autopay paid the payment one to one in version 3; a transfer naming the product of the card the rows
    // show carries it, that day, may pay it too: the group waits for the owner, withheld as `reread`.
    const rows = [payment('p-1', 'card-microcenter', '2025-08-01', -11_100), payment('p', 'card-microcenter', '2025-09-17', -22_200)];
    const debits = [debit('d-1', '2025-08-01', -11_100, 'ONLINE TRANSFER TO MICRO CENTER'), debit('d-wf', '2025-09-18', -22_200, 'WF CREDIT CARD AUTO PAY 999999 SAMPLE HOLDER'),
      debit('d-mc', '2025-09-17', -22_200, 'ONLINE TRANSFER TO MICRO CENTER')];
    const result = reconcileCardPayments(wfInput(rows, debits));
    assert.deepEqual([pairsOf(result), groupsOf(result)], [[['p-1', 'd-1', 'matched']], [[['p'], ['d-mc', 'd-wf']]]]);
    assert.deepEqual(result.withheld, [{ paymentId: 'p', debitId: 'd-wf', reason: 'reread' }]);
    assertTotalsAddUp(result);
  });

  it('reads a product of several words only where ASCII whitespace alone separates them, as an issuer\'s name (PR193-R1)', () => {
    // 1f309a7f's ten cases: both Wells Fargo cards paid the amount that day, the transfer naming one card by its number
    // but its product across punctuation. Never matched: offered with both, as before F1.
    const rows = [payment('p-auto', 'card-autograph', '2026-09-01', -2_300), payment('p-mc', 'card-microcenter', '2026-09-01', -2_300)];
    for (const product of ['MICRO CENTER', 'ACTIVE CASH']) {
      for (const separator of ['+', '-', '/', '.', '_']) {
        const text = `ONLINE TRANSFER TO ${product.replace(' ', separator)} CARD XXXXXX0003`;
        assert.equal(classifyCheckingDebit(text).rule, 'product-name', text);
        const result = reconcileCardPayments(wfInput(rows, [debit('d', '2026-09-01', -2_300, text)]));
        assert.deepEqual([result.pairs, result.ambiguous], [[], []], text);
        assert.deepEqual(result.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]),
          [['p-auto', ['d']], ['p-mc', ['d']]], text);
        assertTotalsAddUp(result);
      }
    }
    // ASCII whitespace alone between the words, however much: the number names the card.
    for (const product of ['MICRO CENTER', 'MICRO\tCENTER', 'MICRO  CENTER', 'ACTIVE CASH', 'ACTIVE\tCASH']) {
      const text = `ONLINE TRANSFER TO ${product} CARD XXXXXX0003`;
      const result = reconcileCardPayments(wfInput(rows, [debit('d', '2026-09-01', -2_300, text)]));
      assert.deepEqual(pairsOf(result), [['p-mc', 'd', 'matched']], JSON.stringify(text));
      assert.deepEqual(result.unmatchedPayments.map((item) => item.paymentId), ['p-auto'], JSON.stringify(text));
    }
  });

  it('reads no card in a checking account\'s own number, which banks print on their debits', () => {
    // A Wells Fargo card on record with the checking account's ending (as the bank's account list may show it): the
    // paying account's number on a payment never names it, and the payment pairs with its issuer's card as before.
    const cards = [{ id: 'card-autograph', issuer: 'wellsfargo', last4: '0002' }, { id: 'card-microcenter', issuer: 'wellsfargo', last4: '0004' }];
    const rows = [payment('p-auto', 'card-autograph', '2026-09-10', -30_000)];
    const debits = [debit('d', '2026-09-10', -30_000, 'WF CREDIT CARD AUTO PAY XXXXXX0004 SAMPLE HOLDER')];
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput(rows, debits, { cardAccounts: cards }))), [['p-auto', 'd', 'matched']]);
    // Read as a card's number, it would have named the other card and paid nothing.
    const misread = reconcileCardPayments(wfInput(rows, debits, { cardAccounts: cards, checkingAccounts: [{ id: WF }, { id: FIFTH }] }));
    assert.deepEqual(misread.pairs, []);
  });

  it('leaves a debit as it was when its number names no card, several, or a card of the issuer has no last four in Holdr', () => {
    const rows = [payment('p-auto', 'card-autograph', '2026-09-20', -40_000)];
    // A number of no card in Holdr (another account's): the issuer's rule, as before.
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput(rows, [debit('d', '2026-09-20', -40_000, 'WF CREDIT CARD AUTO PAY XXXXXX0909')]))), [['p-auto', 'd', 'matched']]);
    // Two cards of the issuer with that ending, or one with no last four: no card is identified, and both payments of
    // the amount go to the owner, as before.
    const two = [payment('p-auto', 'card-autograph', '2026-09-20', -40_000), payment('p-mc', 'card-microcenter', '2026-09-21', -40_000)];
    for (const cards of [
      [{ id: 'card-autograph', issuer: 'wellsfargo', last4: '0002' }, { id: 'card-microcenter', issuer: 'wellsfargo', last4: '0002' }],
      [{ id: 'card-autograph', issuer: 'wellsfargo', last4: '0002' }, { id: 'card-microcenter', issuer: 'wellsfargo' }],
    ]) {
      const result = reconcileCardPayments(wfInput(two, [debit('d', '2026-09-20', -40_000, TO_AUTOGRAPH('0002'))], { cardAccounts: cards }));
      assert.deepEqual([result.pairs, groupsOf(result)], [[], [[['p-auto', 'p-mc'], ['d']]]], JSON.stringify(cards));
    }
    // An Amex's last five is read for its last four.
    const amex = [{ id: 'card-amex', issuer: 'amex', last5: '90003' }, { id: 'card-amex-2', issuer: 'amex', last4: '0006' }];
    const amexRows = [payment('p-1', 'card-amex', '2026-09-20', -50_000), payment('p-2', 'card-amex-2', '2026-09-21', -50_000)];
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput(amexRows, [debit('d', '2026-09-20', -50_000, 'AMEX EPAYMENT ACH PMT XXXXX0003')], { cardAccounts: amex }))), [['p-1', 'd', 'matched']]);
    // Nothing is read in a descriptor that is not plain ASCII, its number included.
    const unproven = reconcileCardPayments(wfInput(rows, [debit('d', '2026-09-20', -40_000, 'ONLINE TRANSFER TO WELLS © FARGO AUTOGRAPH VISA CARD XXXXXX0002')]));
    assert.deepEqual([unproven.pairs, unproven.unmatchedPayments[0].possibleDebits.map((item) => item.debitId)], [[], ['d']]);
  });

  it('pairs the Wells Fargo-issued Bilt card\'s transfers with the Wells Fargo card, never with the Cardless card\'s payments (RECON-34)', () => {
    const from = CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom;
    assert.equal(from, '2026-02-07');
    // The last payment of the Wells Fargo-issued Bilt card (its history on the Autograph-like card) and the Cardless
    // card's first, of one amount, four days apart; the old card's transfer printing the number the Cardless card kept.
    // Root (RECON-34): the Bilt cue before 2026-02-07 maps to the Wells Fargo card. Each pays its own card.
    const rows = [payment('p-old', 'card-autograph', '2026-02-04', -40_000), payment('p-new', 'card-bilt', '2026-02-08', -40_000)];
    const oldDebit = debit('d-old', '2026-02-04', -40_000, TO_BILT('0001'));
    const newDebit = debit('d-new', '2026-02-09', -40_000, BILT_CARD);
    const result = reconcileCardPayments(wfInput(rows, [oldDebit, newDebit]));
    assert.deepEqual(pairsOf(result), [['p-old', 'd-old', 'matched'], ['p-new', 'd-new', 'matched']]);
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits], [[], [], []]);
    assert.equal(result.biltCarrier, 'card-autograph');
    assertTotalsAddUp(result);
    // The Cardless card's payment paid from elsewhere: the old card's transfer pays the old card, never the Cardless
    // card's payment, which is left with nothing offered.
    const alone = reconcileCardPayments(wfInput(rows, [oldDebit]));
    assert.deepEqual(pairsOf(alone), [['p-old', 'd-old', 'matched']]);
    assert.deepEqual(alone.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-new', []]]);
    assertTotalsAddUp(alone);
    // No Wells Fargo card's payment fits it: no carrier, so it pays nothing, offered with the Cardless card's payment only
    // (the owner's word may still say anything), as before.
    const noOld = reconcileCardPayments(wfInput([rows[1]], [oldDebit]));
    assert.deepEqual([noOld.pairs, noOld.biltCarrier], [[], null]);
    assert.deepEqual(noOld.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-new', ['d-old']]]);
    assert.deepEqual(noOld.unmatchedDebits.map((item) => [item.debitId, item.payee, item.reason]), [['d-old', 'bilt', 'card-not-covered']]);
    assert.equal(cardPaymentConfirmRefusal(rows[1], oldDebit, 'bilt'), null);
    // Both Wells Fargo cards paid its amount close by: two cards fit, so no carrier, and neither is paid by it (fail closed).
    const twoCards = [rows[0], payment('p-mc', 'card-microcenter', '2026-02-05', -40_000)];
    const both = reconcileCardPayments(wfInput(twoCards, [oldDebit]));
    assert.deepEqual([both.pairs, both.ambiguous, both.biltCarrier], [[], [], null]);
    assert.deepEqual(both.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]),
      [['p-old', ['d-old']], ['p-mc', ['d-old']]]);
    assertTotalsAddUp(both);
    // Its masked number is read among the Wells Fargo cards: naming one, that card carried it and is paid by it.
    const named = reconcileCardPayments(wfInput(twoCards, [debit('d-old', '2026-02-04', -40_000, TO_BILT('0003'))]));
    assert.deepEqual([pairsOf(named), named.biltCarrier], [[['p-mc', 'd-old', 'matched']], 'card-microcenter']);
    // From that day on Bilt names only its own cards: a transfer naming Bilt on the day pays no Wells Fargo card, only offered.
    const after = reconcileCardPayments(wfInput([payment('p-wf', 'card-autograph', from, -40_000)], [debit('d', from, -40_000, TO_BILT('0001'))]));
    assert.deepEqual([after.pairs, after.ambiguous], [[], []]);
    assert.deepEqual(after.unmatchedPayments[0].possibleDebits.map((option) => option.debitId), ['d']);
    // A debit from that day on pays the Cardless card as before, a housing pull on the day included; one the day before
    // never pays its housing row, nor any Wells Fargo card's payment (the housing lane is Bilt's alone).
    const housingRow = payment('p-housing', 'card-bilt', from, -300_000, { issuerCategory: 'Housing payment' });
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput([housingRow], [debit('d-pull', from, -300_000, BILT_RENT)]))), [['p-housing', 'd-pull', 'matched']]);
    assert.deepEqual(reconcileCardPayments(wfInput([housingRow], [debit('d-pull', '2026-02-06', -300_000, BILT_RENT)])).pairs, []);
    assert.deepEqual(reconcileCardPayments(wfInput([payment('p-wf', 'card-autograph', '2026-02-06', -300_000)], [debit('d-pull', '2026-02-06', -300_000, BILT_RENT)])).pairs, []);
    // A Bilt card with history from before that day (an owner who kept the Wells Fargo-issued card under issuer bilt)
    // still pairs its own payments from then, its number naming it even beside a Wells Fargo card's payment of the amount.
    const keptInput = (cardRows: ReconciliationCardRow[]) => wfInput(cardRows, [debit('d', '2025-06-02', -12_345, TO_BILT('0001'))], {
      cardCoverage: [{ accountId: 'card-bilt', ranges: WIDE }],
    });
    assert.deepEqual(pairsOf(reconcileCardPayments(keptInput([payment('p', 'card-bilt', '2025-06-02', -12_345)]))), [['p', 'd', 'matched']]);
    const kept = reconcileCardPayments(keptInput([payment('p', 'card-bilt', '2025-06-02', -12_345), payment('p-wf', 'card-autograph', '2025-06-03', -12_345)]));
    assert.deepEqual(pairsOf(kept), [['p', 'd', 'matched']]);
    assert.deepEqual(kept.unmatchedPayments.map((item) => item.paymentId), ['p-wf']);
  });

  it('holds a Bilt-era pair in a group the owner answered, and never counts it as one rules version 3 matched (RECON-34)', () => {
    // A Wells Fargo payment, the Bilt-era transfer of its amount that day, and a Wells Fargo autopay the next day the owner
    // said did not pay it: the group is the owner's, and version 3 never read the transfer as the card's.
    const rows = [payment('p', 'card-autograph', '2025-12-12', -30_000)];
    const debits = [debit('d-bilt', '2025-12-12', -30_000, TO_BILT('0001')), debit('d-wf', '2025-12-13', -30_000, 'WF CREDIT CARD AUTO PAY 999999 SAMPLE HOLDER')];
    const result = reconcileCardPayments(wfInput(rows, debits, { decisions: [decision('cpd', 'rejected', 'p', 'd-wf', -30_000)] }));
    assert.deepEqual([result.pairs, groupsOf(result)], [[], [[['p'], ['d-bilt']]]]);
    assert.deepEqual(result.withheld, []);
    assertTotalsAddUp(result);
    // Unanswered and alone, the transfer pays the card one to one.
    const open = reconcileCardPayments(wfInput(rows, debits.slice(0, 1)));
    assert.deepEqual([pairsOf(open), open.withheld], [[['p', 'd-bilt', 'matched']], []]);
    // Unanswered, with the autopay too: version 3 paired the autopay alone, but the transfer now may pay the card as well,
    // so the group waits for the owner, withheld as read anew (`reread`), never counted as the owner's answer.
    const both = reconcileCardPayments(wfInput(rows, debits));
    assert.deepEqual([both.pairs, groupsOf(both), both.withheld], [[], [[['p'], ['d-bilt', 'd-wf']]], [{ paymentId: 'p', debitId: 'd-wf', reason: 'reread' }]]);
    assertTotalsAddUp(both);
  });

  it('finds the Wells Fargo card that carried the Bilt card in the rows, and pays none when they name two (RECON-34)', () => {
    // The Autograph-like card's Bilt-era payments, each paid the same day by a transfer naming Bilt and the number the
    // Cardless card kept: that card carried the Bilt card, and each transfer pays it, one to one.
    const rows = [payment('p-1', 'card-autograph', '2025-05-05', -11_100), payment('p-2', 'card-autograph', '2025-06-27', -22_200)];
    const debits = [debit('d-1', '2025-05-05', -11_100, TO_BILT('0001')), debit('d-2', '2025-06-27', -22_200, TO_BILT('0001'))];
    const one = reconcileCardPayments(wfInput(rows, debits));
    assert.deepEqual([pairsOf(one), one.biltCarrier], [[['p-1', 'd-1', 'matched'], ['p-2', 'd-2', 'matched']], 'card-autograph']);
    assertTotalsAddUp(one);
    // A transfer of then that fits no payment is left over as a payment to the carrier, whose history covers its day.
    const leftOver = reconcileCardPayments(wfInput(rows, [...debits, debit('d-3', '2025-09-20', -33_300, TO_BILT('0001'))]));
    assert.deepEqual([pairsOf(leftOver).length, leftOver.biltCarrier], [2, 'card-autograph']);
    assert.deepEqual(leftOver.unmatchedDebits.map((item) => [item.debitId, item.payee, item.reason]), [['d-3', 'bilt', 'no-card-payment']]);
    // A debit naming Bilt from the day Cardless issued the Bilt card says nothing of which Wells Fargo card carried it then:
    // one of the other card's amount, close to its payment, leaves the carrier as it was.
    const later = reconcileCardPayments(wfInput([rows[0], payment('p-mc', 'card-microcenter', '2026-06-02', -22_200)],
      [debits[0], debit('d-later', '2026-06-01', -22_200, BILT_CARD)]));
    assert.deepEqual([pairsOf(later), later.biltCarrier], [[['p-1', 'd-1', 'matched']], 'card-autograph']);
    // One transfer fits the other Wells Fargo card instead (a payment of its amount there, the carrier's not imported):
    // the rows name two cards, so no carrier, and no transfer naming Bilt pays either card; each is only offered.
    const decoy = [rows[0], payment('p-mc', 'card-microcenter', '2025-06-28', -22_200)];
    const two = reconcileCardPayments(wfInput(decoy, debits));
    assert.deepEqual([two.pairs, two.ambiguous, two.biltCarrier], [[], [], null]);
    assert.deepEqual(two.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]),
      [['p-1', ['d-1']], ['p-mc', ['d-2']]]);
    assertTotalsAddUp(two);
    // The owner's "not this one" to that pair takes the other card out of the rows' word: one carrier again, and its
    // transfer pays it; the rejected pair is never offered again.
    const rejectedDecoy = reconcileCardPayments(wfInput(decoy, debits, { decisions: [decision('cpd', 'rejected', 'p-mc', 'd-2', -22_200)] }));
    assert.deepEqual([pairsOf(rejectedDecoy), rejectedDecoy.biltCarrier], [[['p-1', 'd-1', 'matched']], 'card-autograph']);
    assert.deepEqual(rejectedDecoy.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits]), [['p-mc', []]]);
    // The owner's confirmation of a transfer with the other Wells Fargo card names that card too, even past the rules'
    // days: two cards again, so none, and the other transfer is only offered.
    const confirmedOther = reconcileCardPayments(wfInput([rows[0], payment('p-mc', 'card-microcenter', '2025-07-07', -22_200)], debits, {
      decisions: [decision('cpd', 'confirmed', 'p-mc', 'd-2', -22_200)],
    }));
    assert.deepEqual([pairsOf(confirmedOther), confirmedOther.biltCarrier], [[['p-mc', 'd-2', 'confirmed']], null]);
    assert.deepEqual(confirmedOther.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-1', ['d-1']]]);
  });

  it('lets no masked number, owner answer or baseline get round the one carrier (PR280-R1, R2, R3)', () => {
    // R1: two transfers of then, each printing a different Wells Fargo card's number, each with a payment of its amount on
    // the card it names: the rows name two cards, so no carrier, and neither transfer pays the card its number names.
    const rows = [payment('p-auto', 'card-autograph', '2025-05-05', -11_100), payment('p-mc', 'card-microcenter', '2025-06-27', -22_200)];
    const masked = [debit('d-auto', '2025-05-05', -11_100, TO_BILT('0002')), debit('d-mc', '2025-06-27', -22_200, TO_BILT('0003'))];
    const two = reconcileCardPayments(wfInput(rows, masked));
    assert.deepEqual([two.pairs, two.ambiguous, two.biltCarrier], [[], [], null]);
    assert.deepEqual(two.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]),
      [['p-auto', ['d-auto']], ['p-mc', ['d-mc']]]);
    assertTotalsAddUp(two);
    // Either alone names one carrier, and pays it.
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput(rows, masked.slice(0, 1)))), [['p-auto', 'd-auto', 'matched']]);
    assert.deepEqual(pairsOf(reconcileCardPayments(wfInput(rows, masked.slice(1)))), [['p-mc', 'd-mc', 'matched']]);
    // R2: the owner confirmed that a transfer printing the Autograph's number paid the Micro Center card; another transfer
    // of then fits only the Autograph's payment. The owner's word counts whatever the number says: two cards, no carrier,
    // and the other transfer is only offered.
    const answered = reconcileCardPayments(wfInput(rows, [debit('d-masked', '2025-06-27', -22_200, TO_BILT('0002')), debit('d-plain', '2025-05-05', -11_100, TO_BILT('0001'))], {
      decisions: [decision('cpd', 'confirmed', 'p-mc', 'd-masked', -22_200)],
    }));
    assert.deepEqual([pairsOf(answered), answered.biltCarrier], [[['p-mc', 'd-masked', 'confirmed']], null]);
    assert.deepEqual(answered.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits.map((option) => option.debitId)]), [['p-auto', ['d-plain']]]);
    assertTotalsAddUp(answered);
    // R3: a payment, a transfer of then printing its card's number, and a Wells Fargo autopay the owner said did not pay it.
    // The group is the owner's; rules version 3 read no Wells Fargo card in that number, so it counts no pair withheld.
    const baseline = reconcileCardPayments(wfInput([payment('p', 'card-autograph', '2025-12-12', -30_000)], [
      debit('d-bilt', '2025-12-12', -30_000, TO_BILT('0002')), debit('d-wf', '2025-12-13', -30_000, 'WF CREDIT CARD AUTO PAY 999999 SAMPLE HOLDER'),
    ], { decisions: [decision('cpd', 'rejected', 'p', 'd-wf', -30_000)] }));
    assert.deepEqual([baseline.pairs, groupsOf(baseline), baseline.withheld, baseline.biltCarrier], [[], [[['p'], ['d-bilt']]], [], 'card-autograph']);
    assertTotalsAddUp(baseline);
  });

  it('tests a pair for the operator\'s report as the rules do: the day Cardless issued the Bilt card and masked numbers (PR280-R4)', () => {
    // 1f309a7f's boundary case: a Wells Fargo payment the day of a Bilt debit from before Cardless issued the Bilt card,
    // and a Cardless Bilt payment four days on that the owner said the debit did not pay. The debit pays the carrier; the
    // Bilt payment is never its candidate, so the rejection holds nothing.
    const pOld = payment('p-old', 'card-autograph', '2026-02-04', -11_100);
    const pNew = payment('p-new', 'card-bilt', '2026-02-08', -11_100);
    const dOld = debit('d-old', '2026-02-04', -11_100, BILT_CARD);
    const boundary = wfInput([pOld, pNew], [dOld], { decisions: [decision('cpd', 'rejected', 'p-new', 'd-old', -11_100)] });
    const atBoundary = reconcileCardPayments(boundary);
    assert.deepEqual([pairsOf(atBoundary), atBoundary.biltCarrier, atBoundary.heldGroups], [[['p-old', 'd-old', 'matched']], 'card-autograph', []]);
    assertTotalsAddUp(atBoundary);
    const boundaryCheck = cardPaymentCandidateCheck(boundary, atBoundary);
    assert.deepEqual([boundaryCheck(pOld, dOld), boundaryCheck(pNew, dOld)], [true, false]);
    // The check reads the carrier the result found: with none, the debit is no candidate for the Wells Fargo payment.
    assert.equal(cardPaymentCandidateCheck(boundary, { ...atBoundary, biltCarrier: null })(pOld, dOld), false);
    // The masked variant: a Bilt debit makes the Autograph-like card the carrier; a later one prints the number of the Bilt
    // card with history from then, and pays it; the owner said it did not pay the carrier's payment of its amount the next
    // day, which its number never let it pay.
    const pCarrier = payment('p-carrier', 'card-autograph', '2025-05-01', -22_200);
    const pKept = payment('p-kept', 'card-bilt', '2025-06-01', -11_100);
    const pNear = payment('p-near', 'card-autograph', '2025-06-02', -11_100);
    const dCarrier = debit('d-carrier', '2025-05-01', -22_200, BILT_CARD);
    const dMasked = debit('d-masked', '2025-06-01', -11_100, TO_BILT('0001'));
    const masked = wfInput([pCarrier, pKept, pNear], [dCarrier, dMasked], {
      cardCoverage: WF_CARDS.map((card) => ({ accountId: card.id, ranges: WIDE })),
      decisions: [decision('cpd', 'rejected', 'p-near', 'd-masked', -11_100)],
    });
    const kept = reconcileCardPayments(masked);
    assert.deepEqual([pairsOf(kept), kept.biltCarrier, kept.heldGroups],
      [[['p-carrier', 'd-carrier', 'matched'], ['p-kept', 'd-masked', 'matched']], 'card-autograph', []]);
    assertTotalsAddUp(kept);
    const maskedCheck = cardPaymentCandidateCheck(masked, kept);
    assert.deepEqual([maskedCheck(pCarrier, dCarrier), maskedCheck(pKept, dMasked), maskedCheck(pNear, dMasked)], [true, true, false]);
    // Rows that do not fit at all are no candidates: another amount the same day, past the rules' days, a payment not yet
    // posted.
    assert.deepEqual([maskedCheck({ ...pCarrier, amountMinor: -22_201 }, dCarrier), maskedCheck({ ...pCarrier, transactionDate: '2025-05-07' }, dCarrier),
      maskedCheck({ ...pCarrier, status: 'pending' }, dCarrier)], [false, false, false]);
  });
});

describe('reconcileCardPayments: a payment the card itself reversed', () => {
  // Root 15:03Z: returned only where the reversal is on the same card, of an equal amount, dated on or after the payment
  // and within 30 days; the payment has no checking candidate of its own; and the pairing is unique both ways.
  const reversal = (id: string, cardAccountId: string, transactionDate: string, amountMinor: number, overrides: Partial<ReconciliationCardRow> = {}) =>
    payment(id, cardAccountId, transactionDate, amountMinor, { description: 'PAYMENT RETURNED', ...overrides });

  it('settles a payment the card reversed, and matches the payment made again with its own debit', () => {
    // A Chase payment refused by the bank and reversed three days later, then paid again, with its debit four days on.
    const rows = [
      payment('p-first', 'card-chase', '2026-03-10', -50_000), reversal('r', 'card-chase', '2026-03-13', 50_000),
      payment('p-again', 'card-chase', '2026-03-13', -50_000),
    ];
    const result = reconcileCardPayments(input(rows, [debit('d', '2026-03-17', -50_000, CHASE)]));
    assert.deepEqual(pairsOf(result), [['p-again', 'd', 'matched']]);
    assert.deepEqual(result.returned, [{ paymentId: 'p-first', reversalId: 'r', dayOffset: 3 }]);
    assert.deepEqual([result.unmatchedPayments, result.ambiguous], [[], []]);
    assert.deepEqual(result.totals[0].payments.returned, { count: 1, amountMinor: -50_000 });
    assertTotalsAddUp(result);
    // The same in any order of the rows.
    assert.deepEqual(plain(reconcileCardPayments(input([...rows].reverse(), [debit('d', '2026-03-17', -50_000, CHASE)]))), plain(result));
  });

  it('settles nothing where the payment has a candidate of its own: the owner decides the group', () => {
    const rows = [
      payment('p-first', 'card-chase', '2026-03-10', -50_000), reversal('r', 'card-chase', '2026-03-13', 50_000),
      payment('p-again', 'card-chase', '2026-03-13', -50_000),
    ];
    // The second payment's debit is within five days of both payments.
    const result = reconcileCardPayments(input(rows, [debit('d', '2026-03-14', -50_000, CHASE)]));
    assert.deepEqual(result.returned, []);
    assert.deepEqual(result.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-first', 'p-again'], ['d']]]);
    assertTotalsAddUp(result);
  });

  // Root 15:42Z: a payment matched to a debit that stands does not compete for the reversal; one whose debit came back
  // (a credit of its amount to its account within 15 days after it) does, and then the reversal is only offered.
  const returnedThenPaid = [
    payment('p-first', 'card-chase', '2026-03-10', -50_000), reversal('r', 'card-chase', '2026-03-13', 50_000),
    payment('p-again', 'card-chase', '2026-03-13', -50_000),
  ];
  const credit = (date: string, amountMinor = 50_000, overrides: Partial<ReconciliationCheckingRow> = {}) =>
    debit('c', date, amountMinor, 'SAMPLE ITEM RETURNED 999999', overrides);

  it('lets a payment matched to a debit that stands compete for no reversal, and one whose debit came back compete', () => {
    const paid = debit('d', '2026-03-17', -50_000, CHASE);
    for (const [label, extra] of [
      ['no credit', []],
      ['a credit 16 days after', [credit('2026-04-02')]],
      ['a credit before the debit', [credit('2026-03-16')]],
      ['a credit to another account', [credit('2026-03-20', 50_000, { checkingAccountId: FIFTH })]],
      ['a credit of another amount', [credit('2026-03-20', 49_999)]],
      ['a credit in another currency', [credit('2026-03-20', 50_000, { currency: 'EUR' })]],
      ['a pending credit', [credit('2026-03-20', 50_000, { status: 'pending' })]],
    ] as const) {
      const result = reconcileCardPayments(input(returnedThenPaid, [paid, ...extra]));
      assert.deepEqual([pairsOf(result), result.returned.map((item) => item.paymentId)], [[['p-again', 'd', 'matched']], ['p-first']], label);
    }
    // Came back unpaid, from the debit's day to 15 days after (Root 02:32Z): the pull nets with its return and pays
    // nothing, so the payment made again has no debit; the reversal fits both payments and is only offered.
    for (const date of ['2026-03-17', '2026-03-20', '2026-04-01']) {
      const result = reconcileCardPayments(input(returnedThenPaid, [paid, credit(date)]));
      assert.deepEqual(pairsOf(result), [], date);
      assert.deepEqual(result.returned, [], date);
      assert.deepEqual(result.returnedDebits, [{ debitId: 'd', creditId: 'c', dayOffset: cardPaymentDayOffset({ transactionDate: '2026-03-17' }, { date }) }], date);
      assert.deepEqual(result.unmatchedPayments.map((item) => [item.paymentId, item.possibleReversals]), [
        ['p-first', [{ reversalId: 'r', dayOffset: 3 }]], ['p-again', [{ reversalId: 'r', dayOffset: 0 }]],
      ], date);
      assert.deepEqual(result.withheld, [{ paymentId: 'p-again', debitId: 'd', reason: 'returned' }], date);
      assertTotalsAddUp(result);
    }
    // A credit of its amount that does not read as an item returned (a transfer back) leaves the debit standing: the
    // payment made again stays matched, and competes for the reversal, which is then only offered.
    const transfer = reconcileCardPayments(input(returnedThenPaid, [paid, credit('2026-03-20', 50_000, { description: 'ONLINE TRANSFER FROM SAMPLE SAVINGS' })]));
    assert.deepEqual([pairsOf(transfer), transfer.returned, transfer.returnedDebits], [[['p-again', 'd', 'matched']], [], []]);
    assert.deepEqual(transfer.unmatchedPayments.map((item) => [item.paymentId, item.possibleReversals]), [['p-first', [{ reversalId: 'r', dayOffset: 3 }]]]);
    // A payment whose only pull came back unpaid has no debit: the card's reversal, fitting it alone, settles it returned.
    const alone = reconcileCardPayments(input([payment('p', 'card-chase', '2026-03-13', -50_000), reversal('r', 'card-chase', '2026-03-14', 50_000)],
      [debit('d', '2026-03-13', -50_000, CHASE), credit('2026-03-16')]));
    assert.deepEqual([pairsOf(alone), alone.returned, alone.unmatchedPayments], [[], [{ paymentId: 'p', reversalId: 'r', dayOffset: 1 }], []]);
    assert.deepEqual(alone.returnedDebits, [{ debitId: 'd', creditId: 'c', dayOffset: 3 }]);
    assertTotalsAddUp(alone);
  });

  it('never matches a lone pull its bank returned unpaid, even where the return cannot say which of two pulls it was', () => {
    // The return fits the Chase pull and a Citi one: neither nets, both came back unpaid, and the one-to-one pair of the
    // Chase payment and its pull is the owner's (Root 02:32Z).
    const result = reconcileCardPayments(input([payment('p', 'card-chase', '2026-03-10', -50_000)],
      [debit('d-1', '2026-03-11', -50_000, CHASE), debit('d-2', '2026-03-12', -50_000, CITI), credit('2026-03-14')]));
    assert.deepEqual([result.pairs, result.returnedDebits], [[], []]);
    assert.deepEqual(result.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p'], ['d-1']]]);
    assert.deepEqual(result.heldGroups.map((check) => [check.outcome, check.held]), [['held', 'returned']]);
    assert.deepEqual(result.withheld, [{ paymentId: 'p', debitId: 'd-1', reason: 'returned' }]);
    assertTotalsAddUp(result);
  });

  it('lets a payment the owner confirmed, or one held for the owner, compete where its debit came back', () => {
    // Confirmed by the owner with a debit that stands, then with one that came back.
    const confirmed = { decisions: [decision('cpd', 'confirmed', 'p-again', 'd', -50_000)] };
    const paid = debit('d', '2026-03-17', -50_000, GENERIC);
    assert.deepEqual(reconcileCardPayments(input(returnedThenPaid, [paid], confirmed)).returned.map((item) => item.paymentId), ['p-first']);
    const answered = reconcileCardPayments(input(returnedThenPaid, [paid, credit('2026-03-19')], confirmed));
    assert.deepEqual([pairsOf(answered), answered.returned], [[['p-again', 'd', 'confirmed']], []]);
    assert.deepEqual(answered.unmatchedPayments.map((item) => item.possibleReversals), [[{ reversalId: 'r', dayOffset: 3 }]]);
    // Two debits fit the payment made again: the owner's to say which; one of them came back.
    const two = [debit('d-1', '2026-03-16', -50_000, CHASE), debit('d-2', '2026-03-17', -50_000, CHASE)];
    const held = reconcileCardPayments(input(returnedThenPaid, two));
    assert.deepEqual([held.ambiguous.map((group) => group.paymentIds), held.returned.map((item) => item.paymentId)], [[['p-again']], ['p-first']]);
    const heldBack = reconcileCardPayments(input(returnedThenPaid, [...two, credit('2026-03-18')]));
    assert.deepEqual([heldBack.ambiguous.map((group) => group.paymentIds), heldBack.returned], [[['p-again']], []]);
    assert.deepEqual(heldBack.unmatchedPayments.map((item) => [item.paymentId, item.possibleReversals]), [['p-first', [{ reversalId: 'r', dayOffset: 3 }]]]);
    assertTotalsAddUp(answered);
    assertTotalsAddUp(heldBack);
  });

  it('offers a reversal to the owner where it could be the return of more than one payment, or a payment has more than one', () => {
    // Two payments of one amount before one reversal.
    const two = reconcileCardPayments(input([
      payment('p-1', 'card-citi', '2026-03-05', -7_000), payment('p-2', 'card-citi', '2026-03-10', -7_000), reversal('r', 'card-citi', '2026-03-12', 7_000),
    ], []));
    assert.deepEqual(two.returned, []);
    assert.deepEqual(two.unmatchedPayments.map((item) => [item.paymentId, item.possibleReversals]), [
      ['p-1', [{ reversalId: 'r', dayOffset: 7 }]], ['p-2', [{ reversalId: 'r', dayOffset: 2 }]],
    ]);
    // One payment and two reversals of its amount.
    const reversed = reconcileCardPayments(input([
      payment('p', 'card-citi', '2026-03-05', -7_000), reversal('r-1', 'card-citi', '2026-03-12', 7_000), reversal('r-2', 'card-citi', '2026-03-20', 7_000),
    ], []));
    assert.deepEqual(reversed.returned, []);
    assert.deepEqual(reversed.unmatchedPayments.map((item) => item.possibleReversals), [[{ reversalId: 'r-1', dayOffset: 7 }, { reversalId: 'r-2', dayOffset: 15 }]]);
    assertTotalsAddUp(two);
    assertTotalsAddUp(reversed);
  });

  it('takes as a return only a posted reversal on the same card, of its amount and currency, on or up to 30 days after it', () => {
    const base = payment('p', 'card-amex', '2026-05-01', -9_999);
    for (const [label, other] of [
      ['a day before', reversal('r', 'card-amex', '2026-04-30', 9_999)],
      ['31 days after', reversal('r', 'card-amex', '2026-06-01', 9_999)],
      ['another card', reversal('r', 'card-amex-2', '2026-05-03', 9_999)],
      ['another amount', reversal('r', 'card-amex', '2026-05-03', 9_998)],
      ['another currency', reversal('r', 'card-amex', '2026-05-03', 9_999, { currency: 'EUR' })],
      ['pending', reversal('r', 'card-amex', '2026-05-03', 9_999, { status: 'pending' })],
      ['not a payment', reversal('r', 'card-amex', '2026-05-03', 9_999, { kind: 'refund' })],
    ] as const) {
      const result = reconcileCardPayments(input([base, other], []));
      assert.deepEqual([result.returned, result.unmatchedPayments.map((item) => [item.paymentId, item.possibleReversals])], [[], [['p', undefined]]], label);
    }
    for (const [label, date] of [['the same day', '2026-05-01'], ['30 days after', '2026-05-31']] as const) {
      const result = reconcileCardPayments(input([base, reversal('r', 'card-amex', date, 9_999)], []));
      assert.deepEqual(result.returned.map((item) => item.paymentId), ['p'], label);
    }
  });

  it('leaves the owner\'s answer as it is, and settles a payment offered a debit only by the reversal', () => {
    const rows = [payment('p', 'card-amex', '2026-05-01', -9_999), reversal('r', 'card-amex', '2026-05-04', 9_999)];
    const answered = reconcileCardPayments(input(rows, [], { decisions: [decision('cpd', 'elsewhere', 'p', null, -9_999)] }));
    assert.deepEqual([answered.returned, answered.elsewhere.map((item) => item.paymentId)], [[], ['p']]);
    // A debit of its amount that does not read as its card's payment is offered, not a candidate: the reversal settles it.
    const offered = reconcileCardPayments(input(rows, [debit('d', '2026-05-02', -9_999, SAVINGS)]));
    assert.deepEqual(offered.returned.map((item) => item.paymentId), ['p']);
    assertTotalsAddUp(offered);
  });

  it('settles a payment only on a reversal that reads as the card returning it, both rows in plain ASCII', () => {
    const base = payment('p', 'card-citi', '2026-04-01', -12_345);
    for (const overrides of [
      { description: 'RETURNED PAYMENT' }, { description: 'PAYMENT REVERSAL' }, { description: 'Payment - Returned' },
      { description: 'RETURN PYMT 999999' }, { description: 'AUTOPYMT REVERSED' }, { description: 'NSF PAYMENT' },
      { description: 'PAYMENT DISHONOURED' }, { description: 'PAYMENT MISPOSTED' }, { description: 'SAMPLE BANK', merchant: 'Payment returned' },
    ]) {
      const result = reconcileCardPayments(input([base, reversal('r', 'card-citi', '2026-04-12', 12_345, overrides)], []));
      assert.deepEqual(result.returned.map((item) => item.paymentId), ['p'], JSON.stringify(overrides));
    }
    // A payment-worded charge read as a payment, a fee for a returned payment, a return word inside another word, text
    // beyond ASCII on either row, or no text: offered to the owner, never settled by the rules.
    for (const [label, rows] of [
      ['a payment-worded charge', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: 'AUTOPAY PAYMENT SAMPLE UTILITY 999999' })]],
      ['a fee', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: 'RETURNED PAYMENT FEE' })]],
      ['a fee, the other way', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: 'PAYMENT RETURNED', merchant: 'SAMPLE FEES' })]],
      ['a word inside another', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: 'PAYMENT UNRETURNED' })]],
      // UNPAID, or a payment that failed, holds interchangeable rows (Root 04:24Z's kind guard), but never settles a
      // payment as returned by the card: that reads the card's own taken-back words alone.
      ['an unpaid item', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: 'UNPAID ITEM' })]],
      ['a failed payment', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: 'PAYMENT FAILED' })]],
      ['the reversal beyond ASCII', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { issuerCategory: 'SAMPLE\u00C9' })]],
      ['the payment beyond ASCII', [{ ...base, description: 'PAYMENT THANK YOU\u200B' }, reversal('r', 'card-citi', '2026-04-12', 12_345)]],
      ['no text', [base, reversal('r', 'card-citi', '2026-04-12', 12_345, { description: undefined })]],
    ] as const) {
      const result = reconcileCardPayments(input([...rows], []));
      assert.deepEqual([result.returned, result.unmatchedPayments.map((item) => [item.paymentId, item.possibleReversals])],
        [[], [['p', [{ reversalId: 'r', dayOffset: 11 }]]]], label);
      assertTotalsAddUp(result);
    }
  });
});

describe('reconcileCardPayments: a retry of a pull the bank returned unpaid (Root, RECON-34 B)', () => {
  // A retry's shape: the payment, a pull from the second checking account a day later, its unpaid return, and the
  // bank's retry six days after the payment, past the rules' five.
  const RETRY_CITI = 'CITI AUTOPAY PAYMENT RETRY PYMT 999999 ***9999 SAMPLE HOLDER';
  const pay = payment('p', 'card-citi', '2025-11-27', -50_000);
  const pull = debit('d-pull', '2025-11-28', -50_000, CITI, { checkingAccountId: FIFTH });
  const back = debit('c-back', '2025-12-01', 50_000, 'UNPAID ITEM RETURN 999999', { checkingAccountId: FIFTH });
  const retry = debit('d-retry', '2025-12-03', -50_000, RETRY_CITI, { checkingAccountId: FIFTH });
  const STAND_IN = { debitId: 'd-retry', pullId: 'd-pull', paymentId: 'p' };

  it('lets the retry stand in for its returned pull, paying the payment the pull was dated to pay, one to one', () => {
    const result = reconcileCardPayments(input([pay], [pull, back, retry]));
    assert.deepEqual([pairsOf(result), result.retries], [[['p', 'd-retry', 'matched']], [STAND_IN]]);
    assert.deepEqual([result.pairs[0].dayOffset, result.pairs[0].evidence], [6, undefined]);
    assert.deepEqual(result.returnedDebits, [{ debitId: 'd-pull', creditId: 'c-back', dayOffset: 3 }]);
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits], [[], [], []]);
    // Rules version 3 paired the pull, which came back unpaid: withheld as returned, as before; the retry's pair is no
    // version-3 pair at all.
    assert.deepEqual(result.withheld, [{ paymentId: 'p', debitId: 'd-pull', reason: 'returned' }]);
    assertTotalsAddUp(result);
    // Without the word RETRY it keeps its own days, past the rules' five: the payment has no debit, as before.
    const plain = reconcileCardPayments(input([pay], [pull, back, { ...retry, description: CITI }]));
    assert.deepEqual([plain.pairs, plain.retries, plain.unmatchedPayments.map((item) => item.paymentId)], [[], [], ['p']]);
  });

  it('keeps a retry to its own days unless every condition holds (fail closed)', () => {
    const held = (label: string, cardRows: ReconciliationCardRow[], checkingRows: ReconciliationCheckingRow[]) => {
      const result = reconcileCardPayments(input(cardRows, checkingRows));
      assert.deepEqual(result.retries, [], label);
      assert.ok(!result.pairs.some((pair) => pair.paymentId === 'p' && pair.debitId === 'd-retry'), label);
      assertTotalsAddUp(result);
      return result;
    };
    // The same checking account, amount and one issuer as the pull.
    held('account', [pay], [pull, back, { ...retry, checkingAccountId: WF }]);
    held('amount', [pay], [{ ...pull, amountMinor: -49_999 }, { ...back, amountMinor: 49_999 }, retry]);
    held('issuer', [pay], [{ ...pull, description: AMEX }, back, retry]);
    // Another issuer's pull that was itself a candidate for the payment: a Bilt pull from before Cardless issued the
    // Bilt card pays the Wells Fargo card that carried it (the carrier, from another Bilt transfer and its payment),
    // and a Wells Fargo autopay's retry may pay that card too. It retries no Bilt pull.
    const carrierPayment = payment('p-wf-0', 'card-wf', '2025-11-10', -20_000);
    const carrierDebit = debit('d-bilt-0', '2025-11-10', -20_000, BILT_CARD);
    const viaCarrier = held('issuer, the pull a candidate', [payment('p', 'card-wf', '2025-11-27', -50_000), carrierPayment],
      [{ ...pull, description: BILT_CARD }, back, { ...retry, description: 'WF CREDIT CARD AUTO PAY RETRY 999999 ***9999 SAMPLE HOLDER' }, carrierDebit]);
    assert.deepEqual([viaCarrier.biltCarrier, pairsOf(viaCarrier)], ['card-wf', [['p-wf-0', 'd-bilt-0', 'matched']]]);
    // A returned pull of another amount beside it is none the retry may stand in for, nor keeps it from its own pull.
    const otherAmount = [debit('d-pull-2', '2025-11-29', -49_999, CITI, { checkingAccountId: FIFTH }),
      debit('c-back-2', '2025-12-02', 49_999, 'UNPAID ITEM RETURN 999999', { checkingAccountId: FIFTH })];
    assert.deepEqual(reconcileCardPayments(input([pay], [pull, back, retry, ...otherAmount])).retries, [STAND_IN]);
    // Up to `retryDays` after the pull: the pull five days before the payment, the retry sixteen days after the pull.
    const early = [{ ...pull, date: '2025-11-22' }, { ...back, date: '2025-11-22' }];
    held('retryDays', [pay], [...early, { ...retry, date: '2025-12-08' }]);
    assert.deepEqual(reconcileCardPayments(input([pay], [...early, { ...retry, date: '2025-12-07' }])).retries, [STAND_IN]);
    // No more than `confirmDays` from the payment: the payment five days before the pull, the retry sixteen after it.
    const before = { ...pay, transactionDate: '2025-11-23' };
    held('confirmDays', [before], [pull, back, { ...retry, date: '2025-12-09' }]);
    assert.deepEqual(reconcileCardPayments(input([before], [pull, back, { ...retry, date: '2025-12-08' }])).retries, [STAND_IN]);
    // A retry that came back unpaid itself (a return of its own, after the pull's) retries nothing.
    held('retry returned', [pay], [pull, back, retry, debit('c-retry', '2025-12-15', 50_000, 'UNPAID ITEM RETURN 999999', { checkingAccountId: FIFTH })]);
    // A second retry of the pull (paying a payment of its own days): neither retries it.
    const twice = held('two retries', [pay, payment('p-2', 'card-citi', '2025-12-14', -50_000)],
      [pull, back, retry, debit('d-retry-2', '2025-12-13', -50_000, RETRY_CITI, { checkingAccountId: FIFTH })]);
    assert.deepEqual(pairsOf(twice), [['p-2', 'd-retry-2', 'matched']]);
    // Two retries, each of its own returned pull, could each pay the payment: neither does.
    const viaWf = [debit('d-pull-wf', '2025-11-28', -50_000, CITI), debit('c-back-wf', '2025-12-01', 50_000, 'UNPAID ITEM RETURN 999999'),
      debit('d-retry-wf', '2025-12-03', -50_000, RETRY_CITI)];
    const two = held('two stand-ins', [pay], [pull, back, retry, ...viaWf]);
    assert.deepEqual([two.pairs, two.ambiguous], [[], []]);
    // The retry may pay a payment of its own days (the card booked the retried payment anew): it keeps them.
    const anew = held('own days', [pay, payment('p-new', 'card-citi', '2025-12-05', -50_000)], [pull, back, retry]);
    assert.deepEqual([pairsOf(anew), anew.unmatchedPayments.map((item) => item.paymentId)], [[['p-new', 'd-retry', 'matched']], ['p']]);
    // Another debit of the payment's own days may have paid it: that one does.
    const other = held('another debit', [pay], [pull, back, retry, debit('d-other', '2025-11-27', -50_000, CITI)]);
    assert.deepEqual(pairsOf(other), [['p', 'd-other', 'matched']]);
    // The card took the payment back: it is returned by the card, as before.
    const reversed = held('reversed', [pay, payment('r', 'card-citi', '2025-12-02', 50_000, { description: 'PAYMENT RETURNED' })], [pull, back, retry]);
    assert.deepEqual(reversed.returned, [{ paymentId: 'p', reversalId: 'r', dayOffset: 5 }]);
    // Two payments of the pull's days: neither.
    const twoPayments = held('two payments', [pay, payment('p-3', 'card-citi', '2025-11-25', -50_000)], [pull, back, retry]);
    assert.deepEqual([twoPayments.pairs, twoPayments.ambiguous], [[], []]);
  });

  it('reads only a pull returned unpaid as one the retry may stand in for', () => {
    // Another pull of the amount, not returned, that paid its own payment is none the retry may stand in for: the retry,
    // thirteen days after the returned pull and fourteen after its payment, stands in for that one.
    const kept = reconcileCardPayments(input([pay, payment('p-0', 'card-citi', '2025-12-05', -50_000)], [
      pull, { ...back, date: '2025-11-28' }, debit('d-0', '2025-12-05', -50_000, CITI, { checkingAccountId: FIFTH }), { ...retry, date: '2025-12-11' },
    ]));
    assert.deepEqual([pairsOf(kept), kept.retries], [[['p', 'd-retry', 'matched'], ['p-0', 'd-0', 'matched']], [STAND_IN]]);
    assertTotalsAddUp(kept);
  });

  it('lends a retry its pull\'s days for no payment the pull could not have paid: a Bilt pull from before Cardless issued the Bilt card, a Cardless card\'s payment (PR298-R1)', () => {
    // A Bilt pull the day before Cardless issued the Bilt card, returned unpaid the day it did, and its retry a week
    // later; one payment on the Cardless card two days after the pull, six before the retry (past the rules' five).
    // The pull paid the Wells Fargo-issued card, never a payment on the Cardless card: the retry stands in for none.
    const from = CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom;
    assert.equal(from, '2026-02-07');
    const cardless = payment('p', 'card-bilt', '2026-02-08', -10_000);
    const biltPull = debit('d-pull', '2026-02-06', -10_000, BILT_CARD);
    const biltBack = debit('c-back', '2026-02-07', 10_000, 'UNPAID ITEM RETURN 999999');
    const biltRetry = debit('d-retry', '2026-02-14', -10_000, 'BILT CARD PAYMENT RETRY 999999 SAMPLE HOLDER');
    const result = reconcileCardPayments(input([cardless], [biltPull, biltBack, biltRetry]));
    assert.deepEqual([result.pairs, result.retries, result.unmatchedPayments.map((item) => item.paymentId)], [[], [], ['p']]);
    assert.deepEqual(result.returnedDebits, [{ debitId: 'd-pull', creditId: 'c-back', dayOffset: 1 }]);
    assertTotalsAddUp(result);
    // Control: a pull on the day Cardless issued the Bilt card paid the Cardless card, and the retry stands in for it.
    const onTheDay = reconcileCardPayments(input([cardless], [{ ...biltPull, date: from }, { ...biltBack, date: '2026-02-08' }, biltRetry]));
    assert.deepEqual([pairsOf(onTheDay), onTheDay.retries], [[['p', 'd-retry', 'matched']], [STAND_IN]]);
    assertTotalsAddUp(onTheDay);
  });

  it('lends a retry its pull\'s days for no payment the pull could not have paid: a pull naming one card by its masked number, another card\'s payment (PR298-R1)', () => {
    // Two cards of one issuer, each with the last four Holdr knows. The returned pull prints the first card's masked
    // number and its retry the second's; the one payment of the pull's days is on the second card. One issuer is not
    // one card: the pull paid the first card, never the second card's payment, so the retry stands in for it for none.
    const twoCards = [{ id: 'card-citi-1', issuer: 'citi', last4: '0001' }, { id: 'card-citi-2', issuer: 'citi', last4: '0002' }];
    const twoCardInput = (cardRows: ReconciliationCardRow[], checkingRows: ReconciliationCheckingRow[]) =>
      input(cardRows, checkingRows, { cardAccounts: twoCards, cardCoverage: twoCards.map((card) => ({ accountId: card.id, ranges: WIDE })) });
    const naming = (last4: string, words = 'CITI AUTOPAY PAYMENT') => `${words} 999999 XXXXXX${last4} SAMPLE HOLDER`;
    const retried = (last4: string) => ({ ...retry, description: naming(last4, 'CITI AUTOPAY PAYMENT RETRY PYMT') });
    const second = payment('p', 'card-citi-2', '2025-11-27', -50_000);
    const result = reconcileCardPayments(twoCardInput([second], [{ ...pull, description: naming('0001') }, back, retried('0002')]));
    assert.deepEqual([result.pairs, result.retries, result.unmatchedPayments.map((item) => item.paymentId)], [[], [], ['p']]);
    assertTotalsAddUp(result);
    // Control: the pull printing the second card's number too: the retry stands in for it.
    const sameCard = reconcileCardPayments(twoCardInput([second], [{ ...pull, description: naming('0002') }, back, retried('0002')]));
    assert.deepEqual([pairsOf(sameCard), sameCard.retries], [[['p', 'd-retry', 'matched']], [STAND_IN]]);
    assertTotalsAddUp(sameCard);
  });

  it('leaves a stand-in pair the owner rejected to the owner, lets the owner confirm it, and withholds only the returned pull', () => {
    const rejectedInput = input([pay], [pull, back, retry], { decisions: [decision('cpd', 'rejected', 'p', 'd-retry', -50_000)] });
    const rejected = reconcileCardPayments(rejectedInput);
    assert.deepEqual([rejected.pairs, rejected.ambiguous, rejected.retries], [[], [], [STAND_IN]]);
    assert.deepEqual(rejected.withheld, [{ paymentId: 'p', debitId: 'd-pull', reason: 'returned' }]);
    assert.deepEqual(rejected.unmatchedPayments.map((item) => [item.paymentId, item.possibleDebits]), [['p', []]]);
    // The rejected pair was a candidate by the rules' own test (so the operator's report holds its rows the owner's).
    assert.equal(cardPaymentCandidateCheck(rejectedInput, rejected)(pay, retry), true);
    assert.equal(cardPaymentCandidateCheck(rejectedInput, { ...rejected, retries: [] })(pay, retry), false);
    assertTotalsAddUp(rejected);
    const confirmed = reconcileCardPayments(input([pay], [pull, back, retry], { decisions: [decision('cpd', 'confirmed', 'p', 'd-retry', -50_000)] }));
    assert.deepEqual([pairsOf(confirmed), confirmed.withheld], [[['p', 'd-retry', 'confirmed']], []]);
    assertTotalsAddUp(confirmed);
  });
});

describe('reconcileCardPayments: a debit naming more than one issuer', () => {
  const SEVERAL = 'BILL PAY CITI CREDIT CARD AMEX PAYMENT 999999';

  it('reads every issuer it names, and never one by the order of the rules', () => {
    assert.deepEqual(classifyCheckingDebit(SEVERAL), { class: 'card-payment', payee: 'several', payees: ['amex', 'citi'], rule: 'several-issuers' });
    assert.deepEqual(classifyCheckingDebit('BILT CARD PAYMENT WELLS FARGO 999999'), { class: 'card-payment', payee: 'several', payees: ['bilt', 'wellsfargo'], rule: 'several-issuers' });
    assert.deepEqual(classifyCheckingDebit('BILT RENT CITI 999999'), { class: 'other', payee: null, rule: 'bilt-housing-several-issuers' });
    assert.deepEqual(classifyCheckingDebit('CHASE BANK TRANSFER TO CITIBANK SAVINGS 999999'), { class: 'other', payee: null, rule: 'several-issuers-not-a-payment' });
  });

  it('sends it to the owner with every named issuer\'s candidate, never matching it, even alone', () => {
    const both = reconcileCardPayments(input(
      [payment('p-amex', 'card-amex', '2026-06-01', -10_000), payment('p-citi', 'card-citi', '2026-06-01', -10_000)],
      [debit('d', '2026-06-01', -10_000, SEVERAL)],
    ));
    assert.deepEqual(both.pairs, []);
    assert.deepEqual(both.ambiguous.map((group) => [group.paymentIds, group.debitIds, group.candidates.length]), [[['p-amex', 'p-citi'], ['d'], 2]]);
    assertTotalsAddUp(both);
    // With only the Amex payment there, it is still the owner's: one payment, one debit, never matched.
    const alone = reconcileCardPayments(input([payment('p-amex', 'card-amex', '2026-06-01', -10_000)], [debit('d', '2026-06-01', -10_000, SEVERAL)]));
    assert.deepEqual(alone.pairs, []);
    assert.deepEqual(alone.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-amex'], ['d']]]);
    // A payment on another issuer's card is only offered it.
    const other = reconcileCardPayments(input([payment('p-chase', 'card-chase', '2026-06-01', -10_000)], [debit('d', '2026-06-01', -10_000, SEVERAL)]));
    assert.deepEqual([other.pairs, other.ambiguous], [[], []]);
    assert.deepEqual(other.unmatchedPayments[0].possibleDebits.map((item) => item.debitId), ['d']);
    assert.deepEqual(other.unmatchedDebits.map((item) => [item.debitId, item.payee, item.reason]), [['d', 'several', 'no-card-payment']]);
    // The owner confirms which card it paid.
    const confirmed = reconcileCardPayments(input(
      [payment('p-amex', 'card-amex', '2026-06-01', -10_000), payment('p-citi', 'card-citi', '2026-06-01', -10_000)],
      [debit('d', '2026-06-01', -10_000, SEVERAL)], { decisions: [decision('cpd', 'confirmed', 'p-citi', 'd', -10_000)] },
    ));
    assert.deepEqual(pairsOf(confirmed), [['p-citi', 'd', 'confirmed']]);
    assert.deepEqual(confirmed.unmatchedPayments.map((item) => item.paymentId), ['p-amex']);
  });
});

describe('reconcileCardPayments: owner decisions', () => {
  const rows = () => ({
    payments: [payment('p-1', 'card-amex', '2026-06-01', -10_000), payment('p-2', 'card-citi', '2026-06-01', -20_000)],
    debits: [debit('d-1', '2026-06-02', -10_000, AMEX), debit('d-2', '2026-06-02', -20_000, CITI), debit('d-3', '2026-06-05', -30_000, GENERIC)],
  });

  it('takes a payment paid from elsewhere, and a debit that is no card payment, out of both lists', () => {
    const { payments, debits } = rows();
    const result = reconcileCardPayments(input(payments, debits, {
      decisions: [decision('cpd-a', 'elsewhere', 'p-1', null, -10_000), decision('cpd-b', 'not-card-payment', null, 'd-3', -30_000)],
    }));
    assert.deepEqual(pairsOf(result), [['p-2', 'd-2', 'matched']]);
    assert.deepEqual(result.elsewhere, [{ paymentId: 'p-1', decisionId: 'cpd-a' }]);
    assert.deepEqual(result.notCardPayments, [{ debitId: 'd-3', decisionId: 'cpd-b' }]);
    assert.deepEqual(result.unmatchedDebits.map((item) => item.debitId), ['d-1']);
    assert.deepEqual(result.totals[0].payments.elsewhere, { count: 1, amountMinor: -10_000 });
    assert.deepEqual(result.totals[0].debits.notCardPayment, { count: 1, amountMinor: -30_000 });
    assertTotalsAddUp(result);
  });

  it('confirms a pair the rules would not (another issuer, another day), within the confirm window', () => {
    const result = reconcileCardPayments(input(
      [payment('p', 'card-amex', '2026-06-01', -10_000)],
      [debit('d', '2026-06-12', -10_000, SAVINGS)],
      { decisions: [decision('cpd', 'confirmed', 'p', 'd', -10_000)] },
    ));
    assert.deepEqual(result.pairs, [{ paymentId: 'p', debitId: 'd', dayOffset: 11, status: 'confirmed', decisionId: 'cpd' }]);
    assert.deepEqual(result.totals[0].debits.confirmed, { count: 1, amountMinor: -10_000 });
    assertTotalsAddUp(result);
  });

  it('reports decisions whose rows no longer fit, and lets them change nothing', () => {
    const { payments, debits } = rows();
    const result = reconcileCardPayments(input(payments, debits, {
      decisions: [
        decision('cpd-1', 'confirmed', 'p-gone', 'd-1', -10_000),
        decision('cpd-2', 'confirmed', 'p-1', 'd-1', -10_001),
        decision('cpd-3', 'confirmed', 'p-2', 'd-2', -20_000, '2026-10-01T00:00:00.000Z'),
        decision('cpd-4', 'elsewhere', 'p-2', null, -20_000, '2026-10-02T00:00:00.000Z'),
        decision('cpd-5', 'not-card-payment', null, 'd-gone', -30_000),
        decision('cpd-6', 'rejected', 'p-gone', 'd-gone', -30_000),
      ],
    }));
    assert.deepEqual(result.staleDecisions, [
      { decisionId: 'cpd-1', reason: 'row-missing' },
      { decisionId: 'cpd-2', reason: 'row-changed' },
      { decisionId: 'cpd-4', reason: 'conflict' },
      { decisionId: 'cpd-5', reason: 'row-missing' },
    ]);
    assert.deepEqual(pairsOf(result), [['p-1', 'd-1', 'matched'], ['p-2', 'd-2', 'confirmed']]);
    assertTotalsAddUp(result);
  });

  it('refuses to confirm what cannot be a pair', () => {
    const p = payment('p', 'card-amex', '2026-06-01', -10_000);
    const refusal = (row: ReconciliationCardRow, bank: ReconciliationCheckingRow) => cardPaymentConfirmRefusal(row, bank, 'amex');
    assert.equal(refusal(p, debit('d', '2026-06-16', -10_000, AMEX)), null);
    assert.equal(refusal(p, debit('d', '2026-06-17', -10_000, AMEX)), 'too-far-apart');
    assert.equal(refusal(p, debit('d', '2026-06-02', -10_001, AMEX)), 'amount-differs');
    assert.equal(refusal(p, debit('d', '2026-06-02', -10_000, AMEX, { currency: 'EUR' })), 'amount-differs');
    assert.equal(refusal(p, debit('d', '2026-06-02', 10_000, AMEX)), 'not-a-debit');
    assert.equal(refusal({ ...p, status: 'pending' }, debit('d', '2026-06-02', -10_000, AMEX)), 'not-a-payment');
    assert.equal(refusal({ ...p, kind: 'refund' }, debit('d', '2026-06-02', -10_000, AMEX)), 'not-a-payment');
    // Another issuer's debit, or one that reads as no card payment at all: the owner may still say it paid this.
    assert.equal(refusal(p, debit('d', '2026-06-02', -10_000, CITI)), null);
    assert.equal(refusal(p, debit('d', '2026-06-02', -10_000, SAVINGS)), null);
    assert.equal(isReconcilableCardPayment(p), true);
    assert.equal(isReconcilableCheckingDebit(debit('d', '2026-06-02', -10_000, SAVINGS)), true);
    assert.equal(isReconcilableCheckingDebit(debit('d', '2026-06-02', -10_000, SAVINGS, { status: 'removed' })), false);
  });

  it('pairs up to 15 days apart on the owner\'s word only: six days out is never matched or offered, sixteen never stands', () => {
    const p = payment('p', 'card-citi', '2026-06-01', -10_000);
    const at = (date: string) => debit('d', date, -10_000, CITI);
    const alone = reconcileCardPayments(input([p], [at('2026-06-07')]));
    assert.deepEqual([alone.pairs, alone.ambiguous, alone.unmatchedPayments[0].possibleDebits], [[], [], []]);
    for (const [date, dayOffset] of [['2026-06-07', 6], ['2026-06-16', 15], ['2026-05-17', -15]] as const) {
      const result = reconcileCardPayments(input([p], [at(date)], { decisions: [decision('cpd', 'confirmed', 'p', 'd', -10_000)] }));
      assert.deepEqual(result.pairs, [{ paymentId: 'p', debitId: 'd', dayOffset, status: 'confirmed', decisionId: 'cpd' }], date);
      assert.equal(cardPaymentDayOffset(p, at(date)), dayOffset);
      assert.equal(cardPaymentConfirmRefusal(p, at(date), 'citi'), null);
    }
    for (const date of ['2026-06-17', '2026-05-16']) {
      const result = reconcileCardPayments(input([p], [at(date)], { decisions: [decision('cpd', 'confirmed', 'p', 'd', -10_000)] }));
      assert.deepEqual([result.pairs, result.staleDecisions], [[], [{ decisionId: 'cpd', reason: 'row-changed' }]], date);
      assert.equal(cardPaymentConfirmRefusal(p, at(date), 'citi'), 'too-far-apart');
    }
    assert.equal(cardPaymentDayOffset(p, { date: 'soon' }), null);
  });
});

describe('reconcileCardPayments: stability', () => {
  /** Four years of monthly payments on five cards, each with its debit (some from Fifth Third), plus noise. */
  function history() {
    const payments: ReconciliationCardRow[] = [];
    const debits: ReconciliationCheckingRow[] = [];
    const shapes: Record<string, string> = { 'card-amex': AMEX, 'card-citi': CITI, 'card-chase': CHASE, 'card-bilt': BILT_CARD, 'card-wf': WF_CARD };
    let n = 0;
    for (let month = 0; month < 48; month += 1) {
      const year = 2022 + Math.floor((month + 9) / 12);
      const mm = String(((month + 9) % 12) + 1).padStart(2, '0');
      for (const [index, card] of Object.keys(shapes).entries()) {
        n += 1;
        const amountMinor = -(10_000 + ((n * 7_919) % 400_000));
        const day = String(3 + index * 5).padStart(2, '0');
        payments.push(payment(`p-${n}`, card, `${year}-${mm}-${day}`, amountMinor));
        const debitDay = String(3 + index * 5 + (n % 3)).padStart(2, '0');
        debits.push(debit(`d-${n}`, `${year}-${mm}-${debitDay}`, amountMinor, shapes[card], { checkingAccountId: n % 4 === 0 ? FIFTH : WF }));
      }
      debits.push(debit(`noise-${month}`, `${year}-${mm}-20`, -150_000, BILT_RENT));
      debits.push(debit(`other-${month}`, `${year}-${mm}-21`, -9_900, SAVINGS));
    }
    return { payments, debits };
  }

  it('matches four years of history one to one, quickly', () => {
    const { payments, debits } = history();
    const started = Date.now();
    const result = reconcileCardPayments(input(payments, debits));
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.pairs.length, 240);
    assert.ok(result.pairs.every((pair) => pair.status === 'matched' && pair.paymentId.slice(2) === pair.debitId.slice(2)));
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits], [[], [], []]);
    assert.equal(result.biltHousing.length, 48);
    assertTotalsAddUp(result);
  });

  it('answers the same for the same rows in any order, and for rows imported twice', () => {
    const { payments, debits } = history();
    payments.push(payment('p-a', 'card-amex', '2026-09-25', -50_000), payment('p-c', 'card-citi', '2026-09-26', -50_000));
    debits.push(debit('d-a', '2026-09-26', -50_000, GENERIC), debit('d-b', '2026-09-27', -50_000, GENERIC));
    const decisions = [decision('cpd-x', 'rejected', 'p-a', 'd-b', -50_000)];
    const first = plain(reconcileCardPayments(input(payments, debits, { decisions })));
    const reversed = plain(reconcileCardPayments(input([...payments].reverse(), [...debits].reverse(), { decisions })));
    const twice = plain(reconcileCardPayments(input([...payments, ...payments], [...debits, ...debits], { decisions: [...decisions, ...decisions] })));
    assert.deepEqual(reversed, first);
    assert.deepEqual(twice, first);
  });

  it('never changes the rows it reads', () => {
    const { payments, debits } = history();
    const before = JSON.stringify([payments, debits]);
    const frozen = (rows: object[]) => rows.map((row) => Object.freeze({ ...row }));
    reconcileCardPayments(input(frozen(payments) as ReconciliationCardRow[], frozen(debits) as ReconciliationCheckingRow[]));
    assert.equal(JSON.stringify([payments, debits]), before);
  });
});

/** Per card, checking account, day and month: what is settled and what is not, matched and confirmed alike. */
function figures(result: CardPaymentReconciliation, cardRows: readonly ReconciliationCardRow[], checkingRows: readonly ReconciliationCheckingRow[]) {
  const cards = new Map(cardRows.map((row) => [row.id, row]));
  const banks = new Map(checkingRows.map((row) => [row.id, row]));
  const tally = new Map<string, number>();
  const add = (keys: string[], amountMinor: number) => {
    for (const key of keys) {
      tally.set(`${key} count`, (tally.get(`${key} count`) ?? 0) + 1);
      tally.set(`${key} amount`, (tally.get(`${key} amount`) ?? 0) + amountMinor);
    }
  };
  for (const pair of result.pairs) {
    const card = cards.get(pair.paymentId)!;
    const bank = banks.get(pair.debitId)!;
    add([`settled card ${card.cardAccountId}`, `settled account ${bank.checkingAccountId}`, `settled card ${card.cardAccountId} from ${bank.checkingAccountId}`,
      `settled payment day ${card.transactionDate}`, `settled debit day ${bank.date}`,
      `settled payment month ${card.transactionDate.slice(0, 7)}`, `settled debit month ${bank.date.slice(0, 7)}`], bank.amountMinor);
  }
  for (const item of result.unmatchedPayments) {
    const card = cards.get(item.paymentId)!;
    add([`unpaid card ${card.cardAccountId}`, `unpaid day ${card.transactionDate}`, `unpaid month ${card.transactionDate.slice(0, 7)}`], card.amountMinor);
  }
  for (const item of result.unmatchedDebits) {
    const bank = banks.get(item.debitId)!;
    add([`unused account ${bank.checkingAccountId}`, `unused day ${bank.date}`, `unused month ${bank.date.slice(0, 7)}`], bank.amountMinor);
  }
  const totals = result.totals.map((entry) => ({
    currency: entry.currency,
    settled: [entry.payments.matched.count + entry.payments.confirmed.count, entry.payments.matched.amountMinor + entry.payments.confirmed.amountMinor],
    ambiguous: entry.payments.ambiguous.count,
    unmatched: [entry.payments.unmatched.count, entry.payments.unmatched.amountMinor],
    debitsSettled: [entry.debits.matched.count + entry.debits.confirmed.count, entry.debits.matched.amountMinor + entry.debits.confirmed.amountMinor],
    debitsUnmatched: [entry.debits.unmatched.count, entry.debits.unmatched.amountMinor],
  }));
  return { tally: [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), totals };
}

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const checksOf = (result: CardPaymentReconciliation) => result.heldGroups.map(({ groupId, paymentIds, debitIds, ...rest }) => rest);
const evidenceOf = (result: CardPaymentReconciliation) => result.pairs.filter((pair) => pair.evidence)
  .map((pair) => [pair.paymentId, pair.debitId, pair.evidence]);
const NONE = { byInterchange: 0, byReference: 0, byRemainder: 0, orphanPayments: 0, orphanDebits: 0 };

describe('reconcileCardPayments: interchangeable rows (Root 02:05Z, 04:24Z)', () => {
  // An Amex card's shape: two payments on one card, day, amount and description; a Fifth Third debit and a Wells Fargo
  // retry three and four days later, each a candidate for both.
  const THANKS = 'ONLINE PAYMENT - THANK YOU';
  const same = (id: string, overrides: Partial<ReconciliationCardRow> = {}) =>
    payment(id, 'card-amex', '2026-08-21', -100_000, { description: THANKS, postedDate: '2026-08-21', ...overrides });
  const fifth = debit('d-53', '2026-08-24', -100_000, 'WEB INITIATED PAYMENT AT AMEX EPAYMENT', { checkingAccountId: FIFTH });
  const retry = debit('d-retry', '2026-08-25', -100_000, 'AMEX EPAYMENT RETRY PYMT 999999 W9999 SAMPLE HOLDER');
  /** A Wells Fargo credit of the pulls' amount that reads as an item returned unpaid. */
  const returned = (date: string, id = 'c-return') => debit(id, date, 100_000, 'UNPAID ITEM RETURN 999999');
  const pairOf = (result: CardPaymentReconciliation) => result.pairs.map((pair) => [pair.paymentId, pair.debitId, pair.status, pair.evidence]);

  it('pairs interchangeable payments with their debits in canonical order: date, then id', () => {
    const result = reconcileCardPayments(input([same('p-2'), same('p-1')], [retry, fifth]));
    assert.deepEqual(pairOf(result), [
      ['p-1', 'd-53', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      ['p-2', 'd-retry', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
    ]);
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits], [[], [], []]);
    assert.deepEqual(result.heldGroups, [{
      groupId: 'p-1', paymentIds: ['p-1', 'p-2'], debitIds: ['d-53', 'd-retry'], outcome: 'interchangeable', ...NONE, byInterchange: 2,
    }]);
    assertTotalsAddUp(result);
    // Their descriptions may differ (Root 04:24Z): in case and spacing as here, or in their words (below).
    const spaced = reconcileCardPayments(input([same('p-1'), same('p-2', { description: ' online  payment - thank you ' })], [fifth, retry]));
    assert.equal(spaced.heldGroups[0].outcome, 'interchangeable');
  });

  it('reads a payment row\'s kind and a description\'s channel cue from their own words (Root 04:24Z)', () => {
    const kind = (description: string | undefined, overrides: Partial<ReconciliationCardRow> = {}, issuer = 'amex') =>
      cardPaymentRowKind(same('p', { description, ...overrides }), issuer);
    for (const text of ['ONLINE PAYMENT - THANK YOU', 'AUTOPAY PAYMENT - THANK YOU', 'PAYMENT RECEIVED', 'BILT CARD PAYMENT']) assert.equal(kind(text), 'payment', text);
    for (const text of ['PAYMENT REVERSAL', 'RETURNED PAYMENT', 'NSF PAYMENT', 'MISPOSTED PAYMENT']) assert.equal(kind(text), 'reversal', text);
    // Never paid, or failed (PR231-R4): no payment that stood, though the card's taken-back words do not say so.
    for (const text of ['UNPAID PAYMENT', 'UNPAID ITEM', 'PAYMENT FAILED', 'DECLINED PAYMENT', 'REJECTED PAYMENT', 'BOUNCED PAYMENT',
      'VOIDED PAYMENT', 'PAYMENT CANCELLED', 'PAYMENT CANCELED', 'STOP PAYMENT']) {
      assert.equal(kind(text), 'reversal', text);
    }
    assert.equal(kind('AUTOPAY PAYMENT - THANK YOU', { merchant: 'UNPAID ITEM' }), 'reversal');
    assert.equal(kind('PAYMENT - THANK YOU', { merchant: 'PAYMENT RETURNED' }), 'reversal');
    for (const text of ['CASHBACK REDEMPTION', 'STATEMENT CREDIT', 'REFUND', 'PAYMENT ADJUSTMENT', 'ANNUAL FEE CREDIT', 'DISPUTE PROVISIONAL CREDIT']) {
      assert.equal(kind(text), 'credit', text);
    }
    for (const text of [undefined, '', '   ', 'ONLINE PAYMENT ✓']) assert.equal(kind(text), 'unread', String(text));
    assert.equal(kind('ONLINE PAYMENT', { merchant: 'SAMPLE ✓' }), 'unread');
    assert.equal(kind('BILT RENT PAYMENT', {}, 'bilt'), 'housing');
    const cues: Array<[unknown, 'auto' | 'online' | null]> = [
      ['AUTOPAY PAYMENT - THANK YOU', 'auto'], ['AUTOMATIC PAYMENT - THANK YOU', 'auto'], ['WF CREDIT CARD AUTO PAY 999999 ***9999 SAMPLE HOLDER', 'auto'],
      ['CHASE CREDIT CRD AUTOPAY 999999 ***9999 SAMPLE HOLDER', 'auto'], ['ONLINE PAYMENT - THANK YOU', 'online'], ['MOBILE PAYMENT - THANK YOU', 'online'],
      ['INTERNET PAYMENT - THANK YOU', 'online'], ['WEB INITIATED PAYMENT AT AMEX EPAYMENT', 'online'],
      // A retry, a bare payment, or both channels named: no cue. Nor text beyond plain ASCII, nor none.
      ['AMEX EPAYMENT RETRY PYMT 999999 W9999 SAMPLE HOLDER', null], ['PAYMENT - THANK YOU', null], ['ONLINE AUTOPAY PAYMENT', null],
      ['AUTOPAY ✓', null], [undefined, null], [42, null],
    ];
    for (const [text, cue] of cues) assert.equal(paymentChannelCue(text), cue, String(text));
  });

  it('settles payments whose descriptions differ, a clear description cue choosing the pair (Root 04:24Z)', () => {
    // An Amex card's shape: a payment by autopay and one made online the same day, a Fifth Third web payment and a Wells
    // Fargo retry. ONLINE (WEB) names one payment and one debit: those two pair, though canonical order pairs the other
    // way; the retry, naming no channel, pays the payment left, in canonical order.
    const amex = reconcileCardPayments(input([same('p-1', { description: 'AUTOPAY PAYMENT - THANK YOU' }), same('p-2', { description: 'ONLINE PAYMENT - THANK YOU' })],
      [fifth, retry]));
    assert.deepEqual(pairOf(amex), [
      ['p-1', 'd-retry', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      ['p-2', 'd-53', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'cue' }],
    ]);
    assert.deepEqual(checksOf(amex), [{ outcome: 'interchangeable', ...NONE, byInterchange: 2 }]);
    assertTotalsAddUp(amex);
    // Two payments on a Wells Fargo card: an automatic payment and another the same day, one Wells Fargo AUTO PAY
    // debit three days later, and a Bilt-era transfer the same day, which pays the Wells Fargo card that carried the
    // Bilt card (RECON-34). AUTO names one payment and the autopay: they pair, though canonical order picks the other
    // payment, which the transfer pays in canonical order.
    const rows = [
      payment('p-1', 'card-wf', '2025-12-12', -30_000, { description: 'ONLINE ACH PAYMENT - THANK YOU' }),
      payment('p-2', 'card-wf', '2025-12-12', -30_000, { description: 'AUTOMATIC PAYMENT - THANK YOU' }),
    ];
    const wf = reconcileCardPayments(input(rows, [
      debit('d-auto', '2025-12-15', -30_000, 'WF CREDIT CARD AUTO PAY 999999 ***9999 SAMPLE HOLDER'), debit('d-bilt', '2025-12-12', -30_000, BILT_CARD),
    ]));
    assert.deepEqual(pairOf(wf), [
      ['p-1', 'd-bilt', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      ['p-2', 'd-auto', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'cue' }],
    ]);
    assert.deepEqual(wf.unmatchedPayments, []);
    assert.deepEqual(checksOf(wf), [{ outcome: 'interchangeable', ...NONE, byInterchange: 2 }]);
    assertTotalsAddUp(wf);
    // No clear cue (both payments name the channel, no debit names theirs, or none names one): canonical order.
    for (const [label, descriptions] of [
      ['both automatic', ['AUTOPAY PAYMENT - THANK YOU', 'AUTOMATIC PAYMENT - THANK YOU']],
      ['neither names one', ['PAYMENT RECEIVED - THANK YOU', 'PAYMENT - THANK YOU']],
      ['one names both', ['ONLINE AUTOPAY PAYMENT', 'PAYMENT - THANK YOU']],
    ] as const) {
      const order = reconcileCardPayments(input([same('p-1', { description: descriptions[0] }), same('p-2', { description: descriptions[1] })], [fifth, retry]));
      assert.deepEqual(order.pairs.map((pair) => [pair.paymentId, pair.debitId, pair.evidence]), [
        ['p-1', 'd-53', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
        ['p-2', 'd-retry', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      ], label);
      assertTotalsAddUp(order);
    }
    // A cue named by two debits, or by two payments, pairs nothing by itself: canonical order.
    const web = debit('d-web', '2026-08-26', -100_000, 'WEB INITIATED PAYMENT AT AMEX EPAYMENT', { checkingAccountId: FIFTH });
    const pairedBy = (result: CardPaymentReconciliation) => result.pairs.map((pair) => [pair.paymentId, pair.debitId, (pair.evidence as { pairedBy?: string }).pairedBy]);
    const twoDebits = reconcileCardPayments(input([same('p-1', { description: 'AUTOPAY PAYMENT - THANK YOU' }), same('p-2', { description: 'ONLINE PAYMENT - THANK YOU' })],
      [fifth, web]));
    assert.deepEqual(pairedBy(twoDebits), [['p-1', 'd-53', 'order'], ['p-2', 'd-web', 'order']]);
    const twoPayments = reconcileCardPayments(input([same('p-1'), same('p-2')], [retry, web]));
    assert.deepEqual(pairedBy(twoPayments), [['p-1', 'd-retry', 'order'], ['p-2', 'd-web', 'order']]);
  });

  it('settles housing payment rows of one Bilt card and day too: one kind of payment, in their own lane (Root 04:24Z)', () => {
    const rent = (id: string, description: string) => payment(id, 'card-bilt', '2026-06-01', -300_000, { description });
    const result = reconcileCardPayments(input([rent('p-1', 'BILT RENT PAYMENT'), rent('p-2', 'BILT MORTGAGE PAYMENT')],
      [debit('d-housing', '2026-06-01', -300_000, BILT_RENT)]));
    assert.deepEqual(pairOf(result), [['p-1', 'd-housing', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }]]);
    assert.deepEqual(result.unmatchedPayments.map((item) => item.paymentId), ['p-2']);
    assertTotalsAddUp(result);
  });

  it('leaves a payment left over unmatched, with what is only offered offered (two payments on a Wells Fargo card one day, after Cardless)', () => {
    // Two payments on one Wells Fargo card that day, one Wells Fargo autopay, and a transfer to Bilt of the amount the
    // same day, after Cardless issued the Bilt card: Bilt's, so never a candidate for the Wells Fargo card, only offered.
    const rows = ['p-1', 'p-2'].map((id) => payment(id, 'card-wf', '2026-06-12', -30_000, { description: 'ONLINE PAYMENT', postedDate: '2026-06-12' }));
    const auto = debit('d-auto', '2026-06-12', -30_000, 'WF CREDIT CARD AUTO PAY 999999 ***9999 SAMPLE HOLDER');
    const bilt = debit('d-bilt', '2026-06-12', -30_000, BILT_CARD);
    const result = reconcileCardPayments(input(rows, [auto, bilt]));
    assert.deepEqual(pairOf(result), [['p-1', 'd-auto', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }]]);
    assert.deepEqual(result.unmatchedPayments, [{
      paymentId: 'p-2', reason: 'no-checking-debit', possibleDebits: [{ paymentId: 'p-2', debitId: 'd-bilt', dayOffset: 0 }],
    }]);
    assert.deepEqual(result.unmatchedDebits.map((item) => [item.debitId, item.possiblePayments]), [['d-bilt', [{ paymentId: 'p-2', debitId: 'd-bilt', dayOffset: 0 }]]]);
    assert.deepEqual(checksOf(result), [{ outcome: 'interchangeable', ...NONE, byInterchange: 1, orphanPayments: 1 }]);
    assertTotalsAddUp(result);
    // Before the rule both payments were held with the autopay, and the transfer had no free payment to be offered.
    const confirmedLeftover = reconcileCardPayments(input(rows, [auto, bilt], { decisions: [decision('cpd', 'confirmed', 'p-2', 'd-bilt', -30_000)] }));
    assert.deepEqual(pairOf(confirmedLeftover), [['p-1', 'd-auto', 'matched', undefined], ['p-2', 'd-bilt', 'confirmed', undefined]]);
    // The same rows before Cardless: the transfer pays the Wells Fargo card that carried the Bilt card (RECON-34),
    // so the two debits settle the two payments, in canonical order (both name ONLINE: no clear cue).
    const before = (row: ReconciliationCheckingRow) => ({ ...row, date: '2025-12-12' });
    const bilted = reconcileCardPayments(input(rows.map((row) => ({ ...row, transactionDate: '2025-12-12', postedDate: '2025-12-12' })),
      [before(auto), before(bilt)]));
    assert.deepEqual(pairOf(bilted), [
      ['p-1', 'd-auto', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      ['p-2', 'd-bilt', 'matched', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
    ]);
    assert.deepEqual([bilted.unmatchedPayments, bilted.unmatchedDebits], [[], []]);
    assertTotalsAddUp(bilted);
  });

  it('gives identical per-card, per-account, per-day and per-month figures for every pairing the owner could confirm', () => {
    // Whatever the payments' descriptions say (Root 04:24Z: they may differ), as the figures never read them.
    for (const descriptions of [[THANKS, THANKS, THANKS], ['ONLINE PAYMENT - THANK YOU', 'AUTOPAY PAYMENT - THANK YOU', 'PAYMENT RECEIVED - THANK YOU']]) {
      const three = ['p-1', 'p-2', 'p-3'].map((id, index) => same(id, { description: descriptions[index] }));
      const debits3 = [fifth, debit('d-wf', '2026-08-22', -100_000, AMEX), retry];
      for (const debits of [debits3, debits3.slice(0, 2), debits3.slice(1)]) {
        const auto = reconcileCardPayments(input(three, debits));
        assert.equal(auto.heldGroups[0].outcome, 'interchangeable');
        assert.equal(auto.pairs.length, debits.length);
        assertTotalsAddUp(auto);
        const expected = figures(auto, three, debits);
        // Every way to give each debit its own payment, as the owner's confirmations.
        let pairings = 0;
        for (const order of permutations(three)) {
          const decisions = debits.map((item, index) => decision(`cpd-${index}`, 'confirmed', order[index].id, item.id, -100_000));
          const confirmed = reconcileCardPayments(input(three, debits, { decisions }));
          assert.equal(confirmed.pairs.filter((pair) => pair.status === 'confirmed').length, debits.length);
          assertTotalsAddUp(confirmed);
          assert.deepEqual(figures(confirmed, three, debits), expected, JSON.stringify(decisions.map((item) => [item.cardTransactionId, item.checkingTransactionId])));
          pairings += 1;
        }
        assert.equal(pairings, 6);
      }
    }
  });

  it('holds the group where any condition fails (fail closed)', () => {
    const cases: Array<[string, ReconciliationCardRow[], ReconciliationCheckingRow[], Partial<CardPaymentReconciliationInput>, Record<string, unknown>]> = [
      ['another card', [same('p-1'), same('p-2', { cardAccountId: 'card-amex-2' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'cards' }],
      ['another transaction date', [same('p-1'), same('p-2', { transactionDate: '2026-08-22' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'dates' }],
      ['another posted date', [same('p-1'), same('p-2', { postedDate: '2026-08-22' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'dates' }],
      ['a posted date on one only', [same('p-1'), same('p-2', { postedDate: undefined })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'dates' }],
      // A row that does not read as an ordinary card payment (Root 04:24Z): a reversal or a return, a credit or a fee,
      // or no description to read.
      ['a reversal-kind row', [same('p-1'), same('p-2', { description: 'PAYMENT REVERSAL' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['a returned payment', [same('p-1'), same('p-2', { description: 'RETURNED PAYMENT' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['a reversal by its merchant', [same('p-1'), same('p-2', { merchant: 'PAYMENT RETURNED' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      // Never paid, or failed (PR231-R4): an explicit UNPAID in the description or merchant, or a failed payment.
      ['an unpaid payment', [same('p-1', { description: 'ONLINE PAYMENT THANK YOU' }), same('p-2', { description: 'UNPAID PAYMENT' })], [fifth, retry], {},
        { held: 'unproven', notInterchangeable: 'kinds' }],
      ['an unpaid item', [same('p-1', { description: 'ONLINE PAYMENT THANK YOU' }), same('p-2', { description: 'UNPAID ITEM' })], [fifth, retry], {},
        { held: 'unproven', notInterchangeable: 'kinds' }],
      ['unpaid by its merchant', [same('p-1'), same('p-2', { description: 'AUTOPAY PAYMENT - THANK YOU', merchant: 'UNPAID ITEM' })], [fifth, retry], {},
        { held: 'unproven', notInterchangeable: 'kinds' }],
      ['a failed payment', [same('p-1'), same('p-2', { description: 'PAYMENT FAILED' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['a credit', [same('p-1'), same('p-2', { description: 'STATEMENT CREDIT' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['a fee', [same('p-1'), same('p-2', { description: 'ANNUAL FEE CREDIT' })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['both reversals', [same('p-1', { description: 'PAYMENT REVERSAL' }), same('p-2', { description: 'PAYMENT REVERSAL' })], [fifth, retry], {},
        { held: 'unproven', notInterchangeable: 'kinds' }],
      ['no description', [same('p-1', { description: undefined }), same('p-2', { description: undefined })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['one without a description', [same('p-1'), same('p-2', { description: undefined })], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'kinds' }],
      ['more debits than payments', [same('p-1'), same('p-2')], [fifth, retry, debit('d-3', '2026-08-23', -100_000, AMEX)], {}, { held: 'unproven', notInterchangeable: 'more-debits' }],
      ['one payment', [same('p-1')], [fifth, retry], {}, { held: 'unproven', notInterchangeable: 'one-payment' }],
      // An owner rejection inside the group: the group is the owner's (Root 02:32Z).
      ['a pair the owner rejected', [same('p-1'), same('p-2')], [fifth, retry], { decisions: [decision('cpd', 'rejected', 'p-1', 'd-retry', -100_000)] },
        { held: 'answered' }],
      // Pulls that came back unpaid, a returned item fitting both, so neither nets: the group is the owner's.
      ['a pull that came back unpaid', [same('p-1'), same('p-2')], [fifth, retry, debit('d-retry-2', '2026-08-26', -100_000, AMEX), returned('2026-08-27')], {},
        { held: 'returned' }],
      // A pull that came back by a credit of its amount in other words (a transfer back): no return the rules can tell
      // from one, so the group is the owner's too.
      ['a pull that came back', [same('p-1'), same('p-2')], [fifth, retry, debit('c-back', '2026-08-27', 100_000, 'ONLINE TRANSFER FROM SAMPLE SAVINGS')], {},
        { held: 'came-back' }],
      ['a debit naming several issuers', [same('p-1'), same('p-2')], [fifth, debit('d-s', '2026-08-25', -100_000, 'AMEX CITI CARD PAYMENT')], {}, { held: 'several' }],
      ['a payment not in plain ASCII', [same('p-1'), same('p-2', { merchant: 'AMEX ✓' })], [fifth, retry], {}, { held: 'not-plain' }],
    ];
    for (const [name, rows, debits, extra, expected] of cases) {
      const result = reconcileCardPayments(input(rows, debits, extra));
      assert.deepEqual(evidenceOf(result), [], name);
      assert.deepEqual(checksOf(result), [{ outcome: 'held', ...NONE, ...expected }], name);
      assert.ok(result.ambiguous.length === 1 && result.ambiguous[0].paymentIds.length === rows.length, name);
      assertTotalsAddUp(result);
    }
  });

  it('never pairs the returned original pull: it nets with its unpaid return, by evidence (Root 02:05Z item 6, 02:32Z)', () => {
    // The original Wells Fargo pull and its unpaid return, both posted, each the other's only such: they net to zero,
    // listed apart, and the rest of the group is read without them.
    const original = debit('d-orig', '2026-08-24', -100_000, 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER');
    const back = returned('2026-08-24', 'c-orig');
    const both = reconcileCardPayments(input([same('p-1'), same('p-2')], [fifth, original, back, retry]));
    assert.deepEqual(evidenceOf(both), [['p-1', 'd-53', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }], ['p-2', 'd-retry', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }]]);
    assert.deepEqual(both.returnedDebits, [{ debitId: 'd-orig', creditId: 'c-orig', dayOffset: 0 }]);
    assert.deepEqual([both.unmatchedDebits, both.unmatchedPayments], [[], []]);
    assert.deepEqual(both.totals[0].debits.returned, { count: 1, amountMinor: -100_000 });
    assertTotalsAddUp(both);
    // The pull and its return with only the retry beside it: the retry pays one payment, the other is left with none.
    const alone = reconcileCardPayments(input([same('p-1'), same('p-2')], [original, back, retry]));
    assert.deepEqual(evidenceOf(alone), [['p-1', 'd-retry', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }]]);
    assert.deepEqual(alone.unmatchedPayments, [{ paymentId: 'p-2', reason: 'no-checking-debit', possibleDebits: [] }]);
    assertTotalsAddUp(alone);
    // A credit of its amount that does not say the item was returned (money sent back, a refund) is no return: it nets
    // nothing. But the rules cannot tell it from one, so the group is the owner's.
    const transferBack = reconcileCardPayments(input([same('p-1'), same('p-2')], [original, { ...back, description: 'ONLINE TRANSFER FROM SAMPLE SAVINGS' }, retry]));
    assert.deepEqual([transferBack.returnedDebits, evidenceOf(transferBack)], [[], []]);
    assert.deepEqual(checksOf(transferBack), [{ outcome: 'held', ...NONE, held: 'came-back' }]);
    assertTotalsAddUp(transferBack);
    // A return worded with a fee, or a return in other words than plain ASCII, is no return either.
    for (const description of ['RETURNED ITEM FEE REFUND', 'UNPAID ITEM RETURN ✓']) {
      assert.deepEqual(reconcileCardPayments(input([same('p-1'), same('p-2')], [original, { ...back, description }, retry])).returnedDebits, [], description);
    }
  });

  it('gives the group back to the owner for good when a pair it matched is undone', () => {
    // Undo is the owner's rejection of the pair: the group is then held, and is never matched again while it stands.
    const undone = reconcileCardPayments(input([same('p-1'), same('p-2')], [fifth, retry], { decisions: [decision('cpd-undo', 'rejected', 'p-1', 'd-53', -100_000)] }));
    assert.deepEqual(evidenceOf(undone), []);
    assert.deepEqual(undone.ambiguous.map((group) => [group.paymentIds, group.debitIds, group.candidates.map((item) => [item.paymentId, item.debitId])]),
      [[['p-1', 'p-2'], ['d-53', 'd-retry'], [['p-1', 'd-retry'], ['p-2', 'd-53'], ['p-2', 'd-retry']]]]);
    assertTotalsAddUp(undone);
    // Two payments and one debit (PR231-R1): the Undo never hands the debit to the other payment.
    const one = [same('p-1'), same('p-2')];
    const before = reconcileCardPayments(input(one, [retry]));
    assert.deepEqual(evidenceOf(before), [['p-1', 'd-retry', { basis: 'interchangeable', payments: 2, pairedBy: 'order' }]]);
    const after = reconcileCardPayments(input(one, [retry], { decisions: [decision('cpd-undo', 'rejected', 'p-1', 'd-retry', -100_000)] }));
    assert.deepEqual(after.pairs, []);
    assert.deepEqual(after.ambiguous.map((group) => [group.paymentIds, group.debitIds, group.candidates.map((item) => [item.paymentId, item.debitId])]),
      [[['p-2'], ['d-retry'], [['p-2', 'd-retry']]]]);
    assert.deepEqual(after.unmatchedPayments, [{ paymentId: 'p-1', reason: 'no-checking-debit', possibleDebits: [] }]);
    assert.deepEqual(after.heldGroups.map((check) => [check.outcome, check.held]), [['held', 'answered']]);
    assert.deepEqual(after.withheld, [{ paymentId: 'p-2', debitId: 'd-retry', reason: 'answered' }]);
    assertTotalsAddUp(after);
    // A rejection of a pair that was never a candidate (out of the window) holds nothing.
    const far = reconcileCardPayments(input(one, [fifth, retry, debit('d-far', '2026-09-30', -100_000, AMEX)], {
      decisions: [decision('cpd-far', 'rejected', 'p-1', 'd-far', -100_000)],
    }));
    assert.equal(far.heldGroups[0].outcome, 'interchangeable');
  });

  it('answers the same in any order', () => {
    const rows = [same('p-1'), same('p-2'), same('p-3')];
    const debits = [fifth, retry];
    const first = plain(reconcileCardPayments(input(rows, debits)));
    assert.deepEqual(plain(reconcileCardPayments(input([...rows].reverse(), [...debits].reverse()))), first);
    assert.deepEqual(plain(reconcileCardPayments(input([...rows, ...rows], [...debits, ...debits]))), first);
  });
});

describe('reconcileCardPayments: payer references', () => {
  // Three Chase cards, each paid by its own autopay: the payer reference is all that tells their debits apart.
  const CHASE_CARDS = [...CARDS, { id: 'card-chase-2', issuer: 'chase' }, { id: 'card-chase-3', issuer: 'chase' }];
  const autopay = (last4: string, holder = 'SAMPLE HOLDER') => `CHASE CREDIT CRD AUTOPAY 999999 ***${last4} ${holder}`;
  const REF_A = autopay('0001');
  const REF_B = autopay('0002', 'OTHER HOLDER');
  const REF_C = autopay('0003');
  let serial = 0;
  /** `count` months of one-to-one pairs on `card`, each debit carrying `description`: what proves a reference. */
  function proven(card: string, description: string, count: number) {
    const payments: ReconciliationCardRow[] = [];
    const debits: ReconciliationCheckingRow[] = [];
    for (let month = 1; month <= count; month += 1) {
      serial += 1;
      const date = `2025-${String(month).padStart(2, '0')}-${String(2 + (serial % 20)).padStart(2, '0')}`;
      // An amount of its own, so each pair is a group of its own.
      const amountMinor = -(100_000 + serial * 1_013);
      payments.push(payment(`hp-${serial}`, card, date, amountMinor));
      debits.push(debit(`hd-${serial}`, date, amountMinor, description));
    }
    return { payments, debits };
  }
  type Rows = { payments: ReconciliationCardRow[]; debits: ReconciliationCheckingRow[] };
  const merge = (...parts: Rows[]): Rows => ({ payments: parts.flatMap((part) => part.payments), debits: parts.flatMap((part) => part.debits) });
  const run = (rows: Rows, extra: Partial<CardPaymentReconciliationInput> = {}) => reconcileCardPayments(input(rows.payments, rows.debits, {
    cardAccounts: CHASE_CARDS, cardCoverage: CHASE_CARDS.map((card) => ({ accountId: card.id, ranges: WIDE })), ...extra,
  }));
  // The screenshot's shape: two Chase cards paid one amount three days apart, two autopay debits that fit both.
  const held = [payment('p-a', 'card-chase', '2026-09-10', -77_700), payment('p-b', 'card-chase-2', '2026-09-13', -77_700)];
  const heldRows = (a = REF_A, b = REF_B): Rows => ({ payments: held, debits: [debit('d-a', '2026-09-11', -77_700, a), debit('d-b', '2026-09-14', -77_700, b)] });

  it('reads a payer reference: the words and the reference numbers, never a date or a short number', () => {
    const cases: Array<[unknown, string | null]> = [
      ['CHASE CREDIT CRD AUTOPAY 999999 ***9999 SAMPLE HOLDER', 'CHASE CREDIT CRD AUTOPAY #9999 SAMPLE HOLDER'],
      // A bank's mask, a long number and Holdr's redaction of one all read as its last four, whatever the case.
      ['chase credit crd autopay 999999 xxxxxx9999 sample holder', 'CHASE CREDIT CRD AUTOPAY #9999 SAMPLE HOLDER'],
      ['CHASE CREDIT CRD AUTOPAY 999999 9999999999 SAMPLE HOLDER', 'CHASE CREDIT CRD AUTOPAY #9999 SAMPLE HOLDER'],
      ['CHASE CREDIT CRD AUTOPAY***9999 SAMPLE HOLDER', 'CHASE CREDIT CRD AUTOPAY #9999 SAMPLE HOLDER'],
      // Dates in any shape are left out, as is every bare number shorter than seven digits.
      ['CHASE CREDIT CRD AUTOPAY 20260915 ***9999 SAMPLE HOLDER', 'CHASE CREDIT CRD AUTOPAY #9999 SAMPLE HOLDER'],
      ['CHASE CREDIT CRD AUTOPAY 09152026 ***9999 SAMPLE HOLDER', 'CHASE CREDIT CRD AUTOPAY #9999 SAMPLE HOLDER'],
      ['CHASE CREDIT CRD AUTOPAY ON 09/15 ***9999 SAMPLE HOLDER', 'CHASE CREDIT CRD AUTOPAY ON #9999 SAMPLE HOLDER'],
      ['CARD PMT 99999999', 'CARD PMT #9999'],
      // An identifier of letters and four digits or more is kept as written.
      [AMEX, 'AMEX EPAYMENT ACH PMT W9999 SAMPLE HOLDER'],
      // No reference number: no reference.
      ['WEB INITIATED PAYMENT AT AMEX EPAYMENT', null],
      [GENERIC, null],
      ['CARD PAYMENT 9999 REF 99 W99', null],
      ['', null],
      // Anything but plain ASCII is never read.
      ['CHASE CREDIT CRD AUTOPAY ***9999 SAMPLE HOLDER ©', null],
      ['CHASE CREDIT CRD AUTOPAY ***9999 SAMPLE\u200BHOLDER', null],
      [42, null],
      [null, null],
    ];
    for (const [text, expected] of cases) assert.equal(checkingPayerReference(text), expected, JSON.stringify(text));
  });

  it('settles a group held for the owner where each debit\'s reference is proven for one card', () => {
    const result = run(merge(proven('card-chase', REF_A, 3), proven('card-chase-2', REF_B, 2), heldRows()));
    assert.deepEqual(evidenceOf(result), [
      ['p-a', 'd-a', { basis: 'reference', proofs: 3 }],
      ['p-b', 'd-b', { basis: 'reference', proofs: 2 }],
    ]);
    assert.deepEqual([result.ambiguous, result.unmatchedPayments, result.unmatchedDebits], [[], [], []]);
    assert.deepEqual(result.heldGroups, [{
      groupId: 'p-a', paymentIds: ['p-a', 'p-b'], debitIds: ['d-a', 'd-b'], outcome: 'reference', notInterchangeable: 'cards', ...NONE, byReference: 2,
    }]);
    assert.equal(result.totals[0].payments.matched.count, 7);
    assertTotalsAddUp(result);
  });

  it('needs the reference proven at least twice for one card, and never for another', () => {
    const once = run(merge(proven('card-chase', REF_A, 1), proven('card-chase-2', REF_B, 1), heldRows()));
    assert.deepEqual([evidenceOf(once), once.ambiguous.map((group) => group.paymentIds)], [[], [['p-a', 'p-b']]]);
    assert.deepEqual(checksOf(once), [{ outcome: 'held', held: 'unproven', notInterchangeable: 'cards', ...NONE }]);
    assertTotalsAddUp(once);
    // Proven three times for one card and once for another: a conflict, so it identifies neither.
    const conflict = run(merge(proven('card-chase', REF_A, 3), proven('card-chase-3', REF_A, 1), proven('card-chase-2', REF_B, 1), heldRows()));
    assert.deepEqual([evidenceOf(conflict), conflict.ambiguous.map((group) => group.debitIds)], [[], [['d-a', 'd-b']]]);
    assertTotalsAddUp(conflict);
  });

  it('matches what is left once a reference settled the rest, unless that debit\'s reference was proven for another card', () => {
    // Only A's reference is proven: A by it, then B with the debit left, each the other's one candidate.
    const left = run(merge(proven('card-chase', REF_A, 2), heldRows()));
    assert.deepEqual(evidenceOf(left), [['p-a', 'd-a', { basis: 'reference', proofs: 2 }], ['p-b', 'd-b', { basis: 'remainder' }]]);
    assert.deepEqual(checksOf(left), [{ outcome: 'reference', notInterchangeable: 'cards', ...NONE, byReference: 1, byRemainder: 1 }]);
    assertTotalsAddUp(left);
    // The debit left carries a reference proven for a third card, twice or even once: never matched with B.
    for (const times of [2, 1]) {
      const other = run(merge(proven('card-chase', REF_A, 2), proven('card-chase-3', REF_C, times), heldRows(REF_A, REF_C)));
      assert.deepEqual(evidenceOf(other), [['p-a', 'd-a', { basis: 'reference', proofs: 2 }]], String(times));
      assert.deepEqual(other.ambiguous.map((group) => [group.id, group.paymentIds, group.debitIds, group.candidates]),
        [['p-b', ['p-b'], ['d-b'], [{ paymentId: 'p-b', debitId: 'd-b', dayOffset: 1 }]]], String(times));
      assert.deepEqual(checksOf(other), [{ outcome: 'partly', notInterchangeable: 'cards', ...NONE, byReference: 1 }], String(times));
      assertTotalsAddUp(other);
    }
  });

  it('settles nothing where the reference does not pick one pair both ways', () => {
    // Two payments on one card, one debit proven for it: which one it paid is not said.
    const sameCard = [payment('p-1', 'card-chase', '2026-09-10', -77_700), payment('p-2', 'card-chase', '2026-09-12', -77_700)];
    const twoPayments = run(merge(proven('card-chase', REF_A, 2), { payments: sameCard, debits: [debit('d-a', '2026-09-11', -77_700, REF_A)] }));
    assert.deepEqual([evidenceOf(twoPayments), twoPayments.ambiguous.map((group) => [group.paymentIds, group.debitIds])], [[], [[['p-1', 'p-2'], ['d-a']]]]);
    assert.deepEqual(checksOf(twoPayments), [{ outcome: 'held', held: 'not-unique', notInterchangeable: 'dates', ...NONE }]);
    // One payment, two debits carrying the same proven reference: which one paid it is not said either.
    const twoDebits = run(merge(proven('card-chase', REF_A, 2), { payments: [held[0]], debits: [debit('d-1', '2026-09-11', -77_700, REF_A), debit('d-2', '2026-09-12', -77_700, REF_A)] }));
    assert.deepEqual([evidenceOf(twoDebits), twoDebits.ambiguous.map((group) => [group.paymentIds, group.debitIds])], [[], [[['p-a'], ['d-1', 'd-2']]]]);
    assert.deepEqual(checksOf(twoDebits), [{ outcome: 'held', held: 'not-unique', notInterchangeable: 'one-payment', ...NONE }]);
    assertTotalsAddUp(twoDebits);
  });

  it('lists a row a reference left with no candidate as unmatched, and never offers the debit it took', () => {
    // One debit proven for A fits payments on A and on B: A's, and B is left with no checking debit.
    const rows = merge(proven('card-chase', REF_A, 2), { payments: held, debits: [debit('d-a', '2026-09-11', -77_700, REF_A)] });
    const result = run(rows);
    assert.deepEqual(evidenceOf(result), [['p-a', 'd-a', { basis: 'reference', proofs: 2 }]]);
    assert.deepEqual(result.unmatchedPayments, [{ paymentId: 'p-b', reason: 'no-checking-debit', possibleDebits: [] }]);
    assert.deepEqual(checksOf(result), [{ outcome: 'reference', notInterchangeable: 'cards', ...NONE, byReference: 1, orphanPayments: 1 }]);
    assertTotalsAddUp(result);
    // One payment on A, its proven debit and another of its amount: the other is a debit with no card payment.
    const debitLeft = run(merge(proven('card-chase', REF_A, 2), { payments: [held[0]], debits: [debit('d-a', '2026-09-11', -77_700, REF_A), debit('d-x', '2026-09-12', -77_700, REF_C)] }));
    assert.deepEqual(evidenceOf(debitLeft), [['p-a', 'd-a', { basis: 'reference', proofs: 2 }]]);
    assert.deepEqual(debitLeft.unmatchedDebits.map((item) => [item.debitId, item.payee, item.reason, item.possiblePayments]), [['d-x', 'chase', 'no-card-payment', []]]);
    assert.deepEqual(checksOf(debitLeft), [{ outcome: 'reference', notInterchangeable: 'one-payment', ...NONE, byReference: 1, orphanDebits: 1 }]);
    assertTotalsAddUp(debitLeft);
    // A payment left that way whose card adds its amount back is only offered the reversal, never settled as returned.
    const reversal = payment('r-b', 'card-chase-2', '2026-09-20', 77_700, { description: 'PAYMENT RETURNED' });
    const withReversal = run({ payments: [...rows.payments, reversal], debits: rows.debits });
    assert.deepEqual(withReversal.returned, []);
    assert.deepEqual(withReversal.unmatchedPayments, [{
      paymentId: 'p-b', reason: 'no-checking-debit', possibleDebits: [], possibleReversals: [{ reversalId: 'r-b', dayOffset: 7 }],
    }]);
    assertTotalsAddUp(withReversal);
  });

  it('reads no reference in a group the owner answered, so rejecting a pair it matched gives the group back', () => {
    const rows = merge(proven('card-chase', REF_A, 2), proven('card-chase-2', REF_B, 2), heldRows());
    // The owner's Undo of the pair the reference matched: a rejection of that pair.
    const undone = run(rows, { decisions: [decision('cpd-undo', 'rejected', 'p-a', 'd-a', -77_700)] });
    assert.deepEqual(evidenceOf(undone), []);
    assert.deepEqual(undone.ambiguous.map((group) => [group.paymentIds, group.debitIds, group.candidates.map((item) => [item.paymentId, item.debitId])]),
      [[['p-a', 'p-b'], ['d-a', 'd-b'], [['p-a', 'd-b'], ['p-b', 'd-b'], ['p-b', 'd-a']]]]);
    assert.deepEqual(checksOf(undone), [{ outcome: 'held', held: 'answered', ...NONE }]);
    assertTotalsAddUp(undone);
    // Undoing that rejection: the reference settles the group again.
    assert.equal(evidenceOf(run(rows)).length, 2);
    // Two cards and one debit (PR231-R1): the Undo never hands the debit to the other card.
    const oneDebit = merge(proven('card-chase', REF_A, 2), { payments: held, debits: [debit('d-a', '2026-09-11', -77_700, REF_A)] });
    assert.deepEqual(evidenceOf(run(oneDebit)), [['p-a', 'd-a', { basis: 'reference', proofs: 2 }]]);
    const moved = run(oneDebit, { decisions: [decision('cpd-undo', 'rejected', 'p-a', 'd-a', -77_700)] });
    assert.deepEqual(moved.pairs.filter((pair) => pair.debitId === 'd-a'), []);
    assert.deepEqual(moved.ambiguous.map((group) => [group.paymentIds, group.debitIds]), [[['p-b'], ['d-a']]]);
    assert.deepEqual(moved.unmatchedPayments.map((item) => item.paymentId), ['p-a']);
    assert.deepEqual(moved.withheld, [{ paymentId: 'p-b', debitId: 'd-a', reason: 'answered' }]);
    assertTotalsAddUp(moved);
  });

  it('never matches a pull its bank returned unpaid, by reference or as what was left, and learns nothing from one', () => {
    const back = (date: string) => debit(`c-${date}`, date, 77_700, 'UNPAID ITEM RETURN 999999');
    // Both references proven twice; the bank returned A's pull and B's stood, a return fitting both pulls, so none nets.
    const proved = merge(proven('card-chase', REF_A, 2), proven('card-chase-2', REF_B, 2), heldRows());
    const both = run(merge(proved, { payments: [], debits: [back('2026-09-15')] }));
    assert.deepEqual(evidenceOf(both), []);
    assert.deepEqual(checksOf(both), [{ outcome: 'held', held: 'returned', ...NONE }]);
    assertTotalsAddUp(both);
    // Only B's reference proven, and A's pull returned and netted with its own return: A's pull is no candidate, so B
    // is matched by reference and A, left with none, is unmatched; the pull never pairs as what was left.
    const onlyB = run(merge(proven('card-chase-2', REF_B, 2), heldRows(), { payments: [], debits: [back('2026-09-12')] }));
    assert.deepEqual(evidenceOf(onlyB), [['p-b', 'd-b', { basis: 'reference', proofs: 2 }]]);
    assert.deepEqual(onlyB.returnedDebits, [{ debitId: 'd-a', creditId: 'c-2026-09-12', dayOffset: 1 }]);
    assert.deepEqual(onlyB.unmatchedPayments.map((item) => item.paymentId), ['p-a']);
    assertTotalsAddUp(onlyB);
    // A pull the bank returned proves no reference, even where the owner confirmed it: one proof stays one.
    const confirmedPull = { payments: [payment('op', 'card-chase', '2025-11-03', -55_500)], debits: [debit('od', '2025-11-03', -55_500, REF_A), debit('oc', '2025-11-05', 55_500, 'RETURNED ITEM')] };
    const learned = run(merge(proven('card-chase', REF_A, 1), confirmedPull, heldRows()), { decisions: [decision('cpd-ok', 'confirmed', 'op', 'od', -55_500)] });
    assert.deepEqual(evidenceOf(learned), []);
    assert.deepEqual(learned.heldGroups.map((check) => check.held), ['unproven']);
  });

  it('reads no reference where a pull came back by a credit of its amount in any words, and learns nothing from one', () => {
    const transferBack = (id: string, date: string, amountMinor: number) => debit(id, date, amountMinor, 'ONLINE TRANSFER FROM SAMPLE SAVINGS');
    // Both references proven twice, and B's pull came back by a transfer of its amount: no return, but the rules cannot
    // tell it from one, so the group is the owner's.
    const proved = merge(proven('card-chase', REF_A, 2), proven('card-chase-2', REF_B, 2), heldRows());
    const back = run(merge(proved, { payments: [], debits: [transferBack('c-b', '2026-09-17', 77_700)] }));
    assert.deepEqual([evidenceOf(back), back.returnedDebits], [[], []]);
    assert.deepEqual(checksOf(back), [{ outcome: 'held', held: 'came-back', ...NONE }]);
    assertTotalsAddUp(back);
    // A pull that came back so is still matched one to one (only a pull returned unpaid is refused there), but proves no
    // reference, matched alone or confirmed by the owner: A's one other proof stays one.
    const cameBackPull = { payments: [payment('op', 'card-chase', '2025-11-03', -55_500)], debits: [debit('od', '2025-11-03', -55_500, REF_A), transferBack('oc', '2025-11-05', 55_500)] };
    for (const extra of [{}, { decisions: [decision('cpd-ok', 'confirmed', 'op', 'od', -55_500)] }]) {
      const learned = run(merge(proven('card-chase', REF_A, 1), cameBackPull, heldRows()), extra);
      assert.ok(pairsOf(learned).some(([paymentId, debitId]) => paymentId === 'op' && debitId === 'od'), JSON.stringify(extra));
      assert.deepEqual([evidenceOf(learned), learned.returnedDebits, learned.withheld], [[], [], []], JSON.stringify(extra));
      assert.deepEqual(learned.heldGroups.map((check) => check.held), ['unproven'], JSON.stringify(extra));
      assertTotalsAddUp(learned);
    }
  });

  it('reads no reference in a group the rules never pair alone: a debit naming several issuers, or a payment not in plain ASCII', () => {
    const history = merge(proven('card-chase', REF_A, 2), proven('card-chase-2', REF_B, 2));
    const several = run(merge(history, heldRows(), { payments: [], debits: [debit('d-s', '2026-09-12', -77_700, 'CHASE CITI CARD PAYMENT 999999 ***0009')] }));
    assert.deepEqual([evidenceOf(several), checksOf(several)], [[], [{ outcome: 'held', held: 'several', ...NONE }]]);
    assertTotalsAddUp(several);
    const notPlain = run(merge(history, { payments: [held[0], { ...held[1], description: 'PAYMENT THANK YOU ✓' }], debits: heldRows().debits }));
    assert.deepEqual([evidenceOf(notPlain), checksOf(notPlain)], [[], [{ outcome: 'held', held: 'not-plain', ...NONE }]]);
    assertTotalsAddUp(notPlain);
  });

  it('learns only from pairs proven without any reference: the rules\' own matches and the owner\'s confirmations', () => {
    // B's reference is proven once by the rules and once by the owner's confirmation: twice.
    const owner = {
      payments: [payment('op', 'card-chase-2', '2025-11-03', -55_500), payment('op-other', 'card-chase-3', '2025-11-04', -55_500)],
      debits: [debit('od', '2025-11-03', -55_500, REF_B)],
    };
    const confirmed = run(merge(proven('card-chase-2', REF_B, 1), owner, heldRows()), { decisions: [decision('cpd-ok', 'confirmed', 'op', 'od', -55_500)] });
    assert.deepEqual(evidenceOf(confirmed), [['p-a', 'd-a', { basis: 'remainder' }], ['p-b', 'd-b', { basis: 'reference', proofs: 2 }]]);
    assertTotalsAddUp(confirmed);
    // A pair a reference matched, or what was left of its group, proves nothing: in a later group, B's reference has
    // only its one proof of its own (the remainder would have been a second), so that group stays the owner's.
    const later = {
      payments: [payment('q-b', 'card-chase-2', '2026-10-01', -66_600), payment('q-c', 'card-chase-3', '2026-10-02', -66_600)],
      debits: [debit('e-b', '2026-10-01', -66_600, REF_B), debit('e-x', '2026-10-02', -66_600, autopay('0009', 'THIRD HOLDER'))],
    };
    const chained = run(merge(proven('card-chase', REF_A, 2), proven('card-chase-2', REF_B, 1), heldRows(), later));
    assert.deepEqual(evidenceOf(chained), [['p-a', 'd-a', { basis: 'reference', proofs: 2 }], ['p-b', 'd-b', { basis: 'remainder' }]]);
    assert.deepEqual(chained.heldGroups.map((check) => [check.groupId, check.outcome, check.held]), [['p-a', 'reference', undefined], ['q-b', 'held', 'unproven']]);
    assertTotalsAddUp(chained);
  });

  it('answers the same in any order, and never changes the rows it reads', () => {
    const rows = merge(proven('card-chase', REF_A, 2), proven('card-chase-2', REF_B, 3), heldRows());
    const first = plain(run(rows));
    assert.deepEqual(plain(run({ payments: [...rows.payments].reverse(), debits: [...rows.debits].reverse() })), first);
    assert.deepEqual(plain(run(merge(rows, rows))), first);
    const before = JSON.stringify(rows);
    run({ payments: rows.payments.map((row) => Object.freeze({ ...row })), debits: rows.debits.map((row) => Object.freeze({ ...row })) });
    assert.equal(JSON.stringify(rows), before);
  });
});
