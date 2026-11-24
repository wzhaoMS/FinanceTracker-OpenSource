import { describe, expect, it } from 'vitest';

import { diffPayments, type PaymentsProjection } from './payments.js';

// G-PAYMENTS (design v1.1 §3.4) on synthetic projections: each rule of the sealed kit's payments diff, one change at a
// time, against the changes the import's own rows explain. Every id is made up.
const IMPORT_ROWS: ReadonlySet<string> = new Set(['card-new-1', 'card-new-2']);

function before(): PaymentsProjection {
  return {
    rulesVersion: 3,
    accounts: ['card-acct-a', 'card-acct-b'],
    pairs: [{ p: 'card-pay-1', d: 'chk-debit-1', s: 'matched' }],
    ambiguous: [{ payments: ['card-pay-2', 'card-pay-3'], debits: ['chk-debit-2'] }],
    unmatchedPayments: [{ p: 'card-pay-4', reason: 'checking-not-covered' }],
    unmatchedDebits: [
      { d: 'chk-debit-5', payee: 'amex', reason: 'card-not-covered' },
      { d: 'chk-debit-6', payee: 'chase', reason: 'card-not-covered' },
      { d: 'chk-debit-7', payee: 'none', reason: 'card-not-covered' },
    ],
    sets: {
      elsewhere: ['card-pay-8|decision-1'], returnedDebits: ['chk-debit-9'], notCardPayments: ['chk-debit-10|decision-2'],
      biltHousing: ['chk-debit-11|housing'], answers: ['decision-3|rejected|-'], stale: ['decision-4|row-changed'],
    },
    returned: ['card-pay-12|card-rev-1'],
  };
}

/** `before()` against a copy `change` edits, for an import on an `issuer` card. */
function diff(change: (after: PaymentsProjection) => void, issuer = 'amex') {
  const after = structuredClone(before());
  change(after);
  return diffPayments(before(), after, IMPORT_ROWS, issuer);
}

/** A debit naming `payee`, from card-not-covered before to no-card-payment after. */
function flip(payee: string, issuer: string) {
  const was = before();
  was.unmatchedDebits.push({ d: 'chk-debit-13', payee, reason: 'card-not-covered' });
  const now = structuredClone(was);
  now.unmatchedDebits.find((item) => item.d === 'chk-debit-13')!.reason = 'no-card-payment';
  return diffPayments(was, now, IMPORT_ROWS, issuer);
}

const UNCHANGED = { code: null, pairsBefore: 1, pairsAfter: 1, pairsAdded: 0, pairsChangedOrGone: 0, ambiguousBefore: 1,
  ambiguousAfter: 1, unmatchedPaymentsNew: 0, unmatchedDebitsBefore: 3, unmatchedDebitsAfter: 3, reasonFlipsToNoCardPayment: 0,
  otherChanges: 0, returnedAdded: 0 };

describe('G-PAYMENTS: the payments diff', () => {
  it('passes an unchanged state', () => {
    expect(diff(() => {})).toEqual(UNCHANGED);
  });

  it('passes what the import\'s own rows explain: a pair paying one, a new unmatched one, a debit its coverage now reaches', () => {
    expect(diff((after) => {
      after.pairs.push({ p: 'card-new-1', d: 'chk-debit-5', s: 'matched' });
      after.unmatchedDebits = after.unmatchedDebits.filter((item) => item.d !== 'chk-debit-5');
      after.unmatchedPayments.push({ p: 'card-new-2', reason: 'no-checking-debit' });
      after.unmatchedDebits.find((item) => item.d === 'chk-debit-7')!.reason = 'no-card-payment';
    })).toEqual({ ...UNCHANGED, pairsAfter: 2, pairsAdded: 1, unmatchedPaymentsNew: 1, unmatchedDebitsAfter: 2,
      reasonFlipsToNoCardPayment: 1 });
  });

  it.each([['amex', 'amex'], ['none', 'amex'], ['several', 'amex'], ['unrecognized', 'amex'], ['chase', 'chase']])(
    'lets a debit naming %s become no-card-payment on a %s import', (payee, issuer) => {
      expect(flip(payee, issuer)).toMatchObject({ code: null, reasonFlipsToNoCardPayment: 1, otherChanges: 0 });
    });

  it('holds that change for a debit naming another issuer', () => {
    expect(flip('chase', 'amex')).toMatchObject({ code: 'proof-payments-unmatched', reasonFlipsToNoCardPayment: 0, otherChanges: 1 });
  });

  it('holds a changed rules version or card account list', () => {
    expect(diff((after) => { after.rulesVersion = 4; }).code).toBe('proof-payments-accounts');
    expect(diff((after) => { after.accounts.push('card-acct-c'); }).code).toBe('proof-payments-accounts');
    expect(diff((after) => { after.accounts.pop(); }).code).toBe('proof-payments-accounts');
  });

  it('holds a pre-existing pair gone or changed, and an added pair that pays none of the import\'s rows', () => {
    expect(diff((after) => { after.pairs = []; })).toMatchObject({ code: 'proof-payments-pair', pairsChangedOrGone: 1 });
    expect(diff((after) => { after.pairs[0].s = 'confirmed'; })).toMatchObject({ code: 'proof-payments-pair', pairsChangedOrGone: 1 });
    expect(diff((after) => { after.pairs[0].d = 'chk-debit-5'; })).toMatchObject({ code: 'proof-payments-pair', pairsChangedOrGone: 1 });
    expect(diff((after) => {
      after.pairs.push({ p: 'card-pay-4', d: 'chk-debit-5', s: 'matched' });
      after.unmatchedPayments = [];
      after.unmatchedDebits = after.unmatchedDebits.filter((item) => item.d !== 'chk-debit-5');
    })).toMatchObject({ code: 'proof-payments-pair', pairsChangedOrGone: 0, pairsAdded: 1 });
  });

  it('holds any change to an ambiguous group, and any new group, even of the import\'s own rows', () => {
    expect(diff((after) => { after.ambiguous[0].payments = ['card-pay-2']; }).code).toBe('proof-payments-ambiguous');
    expect(diff((after) => { after.ambiguous = []; })).toMatchObject({ code: 'proof-payments-ambiguous', ambiguousAfter: 0 });
    expect(diff((after) => { after.ambiguous.push({ payments: ['card-new-1', 'card-new-2'], debits: ['chk-debit-5'] }); }))
      .toMatchObject({ code: 'proof-payments-ambiguous', ambiguousAfter: 2 });
  });

  it('holds a returned payment gone or added, even on the import\'s own rows', () => {
    expect(diff((after) => { after.returned = []; })).toMatchObject({ code: 'proof-payments-returned', returnedAdded: 0 });
    expect(diff((after) => { after.returned.push('card-new-1|card-new-2'); }))
      .toMatchObject({ code: 'proof-payments-returned', returnedAdded: 1 });
  });

  it.each(['elsewhere', 'returnedDebits', 'notCardPayments', 'biltHousing', 'answers', 'stale'] as const)(
    'holds any change to %s', (name) => {
      expect(diff((after) => { after.sets[name] = [...after.sets[name], 'zz-synthetic'].sort(); }).code).toBe('proof-payments-sets');
      expect(diff((after) => { after.sets[name] = []; }).code).toBe('proof-payments-sets');
    });

  it('holds unmatched debits that are not exactly those before, less the debits the import paid', () => {
    expect(diff((after) => { after.unmatchedDebits.pop(); }))
      .toMatchObject({ code: 'proof-payments-unmatched', unmatchedDebitsAfter: 2 });
    expect(diff((after) => { after.unmatchedDebits.push({ d: 'chk-debit-13', payee: 'amex', reason: 'no-card-payment' }); }).code)
      .toBe('proof-payments-unmatched');
    // A pair paying a debit that was not unmatched before, or one still listed as unmatched.
    expect(diff((after) => { after.pairs.push({ p: 'card-new-1', d: 'chk-debit-14', s: 'matched' }); }).code)
      .toBe('proof-payments-unmatched');
    expect(diff((after) => { after.pairs.push({ p: 'card-new-1', d: 'chk-debit-5', s: 'matched' }); }).code)
      .toBe('proof-payments-unmatched');
    // A changed payee, and any other change of reason.
    expect(diff((after) => { after.unmatchedDebits[0].payee = 'citi'; }))
      .toMatchObject({ code: 'proof-payments-unmatched', otherChanges: 1 });
    expect(diff((after) => { after.unmatchedDebits[0].reason = 'no-card-account'; }))
      .toMatchObject({ code: 'proof-payments-unmatched', otherChanges: 1 });
    const was = before();
    was.unmatchedDebits[0].reason = 'no-card-payment';
    const now = structuredClone(was);
    now.unmatchedDebits[0].reason = 'card-not-covered';
    expect(diffPayments(was, now, IMPORT_ROWS, 'amex'))
      .toMatchObject({ code: 'proof-payments-unmatched', reasonFlipsToNoCardPayment: 0, otherChanges: 1 });
  });

  it('holds unmatched payments gone, new without being the import\'s, or with a changed reason', () => {
    expect(diff((after) => { after.unmatchedPayments = []; }).code).toBe('proof-payments-unmatched');
    expect(diff((after) => { after.unmatchedPayments.push({ p: 'card-pay-15', reason: 'no-checking-debit' }); }))
      .toMatchObject({ code: 'proof-payments-unmatched', unmatchedPaymentsNew: 1 });
    expect(diff((after) => { after.unmatchedPayments[0].reason = 'no-checking-debit'; }))
      .toMatchObject({ code: 'proof-payments-unmatched', otherChanges: 1 });
  });

  it('names the first rule broken, in the kit\'s order', () => {
    expect(diff((after) => { after.rulesVersion = 4; after.pairs = []; }).code).toBe('proof-payments-accounts');
    expect(diff((after) => { after.pairs = []; after.ambiguous = []; }).code).toBe('proof-payments-pair');
    expect(diff((after) => { after.ambiguous = []; after.returned = []; }).code).toBe('proof-payments-ambiguous');
    expect(diff((after) => { after.returned = []; after.sets.stale = []; }).code).toBe('proof-payments-returned');
    expect(diff((after) => { after.sets.stale = []; after.unmatchedPayments = []; }).code).toBe('proof-payments-sets');
  });
});
