import { cardPaymentPayeeMatchesIssuer, type CardPaymentPayee } from '@finance-tracker/shared';

import type { CardPaymentReconciliationRead } from '../../../routes/cardPaymentReconciliation.js';
import type { ProofHoldCode } from './receipt.js';

/**
 * G-PAYMENTS (design v1.1 §3.4). This ports the rules of the sealed sweep kit's `sweep-payments-diff.cjs` (741962d5,
 * Root's payments rule) from GET snapshots to two in-memory reads taken inside the proof's transaction. The only
 * changes allowed are the ones this import's own rows explain:
 * - the card accounts and the rules version are unchanged;
 * - no pre-existing pair (payment, debit, status) is changed or gone, and every added pair pays one of the import's rows;
 * - no pre-existing ambiguous group changed, and no new group appeared;
 * - elsewhere, returned debits, not-card-payments, Bilt housing, the owner's answers and stale decisions are identical;
 * - returned payments: none gone, and none added. Root's GO is strict here; the kit allowed added ones on window rows;
 * - the unmatched debits after are exactly those before minus the added pairs' debits. A remaining one keeps its payee,
 *   and its reason changes only from `card-not-covered` to `no-card-payment`, and only when its payee can reach the
 *   import's issuer: that issuer's own payee, or `several`, `unrecognized` or none;
 * - unmatched payments: none gone, new ones only from the import's rows, and no reason changes.
 *
 * Conflicts (the CLI report's independent re-checks) are counted separately, on the after state, and must be 0.
 */

export interface PaymentsProjection {
  rulesVersion: number;
  accounts: string[];
  pairs: Array<{ p: string; d: string; s: string }>;
  ambiguous: Array<{ payments: string[]; debits: string[] }>;
  unmatchedPayments: Array<{ p: string; reason: string }>;
  unmatchedDebits: Array<{ d: string; payee: string; reason: string }>;
  sets: Record<'elsewhere' | 'returnedDebits' | 'notCardPayments' | 'biltHousing' | 'answers' | 'stale', string[]>;
  returned: string[];
}

const sorted = (values: string[]) => [...values].sort();

/** The identities a diff compares, from the API's own read (`readCardPaymentReconciliation`). */
export function paymentsProjection(read: CardPaymentReconciliationRead, cardAccountIds: readonly string[]): PaymentsProjection {
  const { result } = read;
  const payeeOf = (debitId: string) => result.classes.get(debitId)?.payee ?? 'none';
  const staleReasons = new Map(result.staleDecisions.map((item) => [item.decisionId, item.reason]));
  // As the API view lists them: rejections, and answers that no longer fit their rows.
  const answers = read.decisions
    .filter((item) => item.decision === 'rejected' || staleReasons.has(item.id))
    .map((item) => `${item.id}|${item.decision}|${staleReasons.get(item.id) ?? '-'}`);
  return {
    rulesVersion: result.rulesVersion,
    accounts: sorted([...cardAccountIds]),
    pairs: result.pairs.map((pair) => ({ p: pair.paymentId, d: pair.debitId, s: pair.status })),
    ambiguous: result.ambiguous.map((group) => ({ payments: sorted(group.paymentIds), debits: sorted(group.debitIds) })),
    unmatchedPayments: result.unmatchedPayments.map((item) => ({ p: item.paymentId, reason: item.reason })),
    unmatchedDebits: result.unmatchedDebits.map((item) => ({ d: item.debitId, payee: payeeOf(item.debitId), reason: item.reason })),
    sets: {
      elsewhere: sorted(result.elsewhere.map((item) => `${item.paymentId}|${item.decisionId}`)),
      returnedDebits: sorted(result.returnedDebits.map((item) => item.debitId)),
      notCardPayments: sorted(result.notCardPayments.map((item) => `${item.debitId}|${item.decisionId}`)),
      biltHousing: sorted(result.biltHousing.map((item) => `${item.debitId}|${item.reason}`)),
      answers: sorted(answers),
      stale: sorted(result.staleDecisions.map((item) => `${item.decisionId}|${item.reason}`)),
    },
    returned: sorted(result.returned.map((item) => `${item.paymentId}|${item.reversalId}`)),
  };
}

export interface PaymentsDiff {
  code: ProofHoldCode | null;
  pairsBefore: number;
  pairsAfter: number;
  pairsAdded: number;
  pairsChangedOrGone: number;
  ambiguousBefore: number;
  ambiguousAfter: number;
  unmatchedPaymentsNew: number;
  unmatchedDebitsBefore: number;
  unmatchedDebitsAfter: number;
  reasonFlipsToNoCardPayment: number;
  otherChanges: number;
  returnedAdded: number;
}

/** True when a debit naming `payee` may pay a card of `issuer`: its own payee, or one that names no single issuer. */
function reaches(payee: string, issuer: string): boolean {
  if (payee === 'none' || payee === 'several' || payee === 'unrecognized') return true;
  return cardPaymentPayeeMatchesIssuer(payee as CardPaymentPayee, issuer);
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const groupKey = (group: { payments: string[]; debits: string[] }) => JSON.stringify([group.payments, group.debits]);

/** `importRows`: the card row ids this import added. `issuer`: the import's card account issuer slug. */
export function diffPayments(before: PaymentsProjection, after: PaymentsProjection, importRows: ReadonlySet<string>,
  issuer: string): PaymentsDiff {
  const key = (pair: { p: string; d: string; s: string }) => `${pair.p}|${pair.d}|${pair.s}`;
  const afterPairs = new Set(after.pairs.map(key));
  const beforePairs = new Set(before.pairs.map(key));
  const changed = before.pairs.filter((pair) => !afterPairs.has(key(pair))).length;
  const added = after.pairs.filter((pair) => !beforePairs.has(key(pair)));
  const addedOffImport = added.filter((pair) => !importRows.has(pair.p)).length;

  const beforeGroups = new Set(before.ambiguous.map(groupKey));
  const afterGroups = new Set(after.ambiguous.map(groupKey));
  const oldGroupsChanged = before.ambiguous.filter((group) => !afterGroups.has(groupKey(group))).length;
  const newGroups = after.ambiguous.filter((group) => !beforeGroups.has(groupKey(group))).length;

  const setsChanged = (Object.keys(before.sets) as Array<keyof PaymentsProjection['sets']>)
    .some((name) => !same(before.sets[name], after.sets[name]));
  const returnedGone = before.returned.filter((entry) => !after.returned.includes(entry)).length;
  const returnedAdded = after.returned.filter((entry) => !before.returned.includes(entry)).length;

  const addedDebits = new Set(added.map((pair) => pair.d));
  const debitsBefore = new Set(before.unmatchedDebits.map((item) => item.d));
  const debitsAfter = new Set(after.unmatchedDebits.map((item) => item.d));
  const expectedAfter = new Set([...debitsBefore].filter((debit) => !addedDebits.has(debit)));
  const debitsExact = debitsAfter.size === expectedAfter.size && [...debitsAfter].every((debit) => expectedAfter.has(debit))
    && [...addedDebits].every((debit) => debitsBefore.has(debit));

  const debitWas = new Map(before.unmatchedDebits.map((item) => [item.d, item]));
  let reasonFlips = 0, otherChanges = 0;
  for (const item of after.unmatchedDebits) {
    const was = debitWas.get(item.d);
    if (!was || (was.payee === item.payee && was.reason === item.reason)) continue;
    if (was.payee === item.payee && was.reason === 'card-not-covered' && item.reason === 'no-card-payment' && reaches(item.payee, issuer)) {
      reasonFlips += 1;
    } else otherChanges += 1;
  }

  const paymentsBefore = new Set(before.unmatchedPayments.map((item) => item.p));
  const paymentsAfter = new Set(after.unmatchedPayments.map((item) => item.p));
  const paymentsGone = [...paymentsBefore].filter((payment) => !paymentsAfter.has(payment)).length;
  const paymentsNew = [...paymentsAfter].filter((payment) => !paymentsBefore.has(payment));
  const paymentsNewOffImport = paymentsNew.filter((payment) => !importRows.has(payment)).length;
  const paymentWas = new Map(before.unmatchedPayments.map((item) => [item.p, item.reason]));
  const paymentReasonChanged = after.unmatchedPayments.filter((item) => paymentWas.has(item.p) && paymentWas.get(item.p) !== item.reason).length;

  const code: ProofHoldCode | null =
    before.rulesVersion !== after.rulesVersion || !same(before.accounts, after.accounts) ? 'proof-payments-accounts'
      : changed > 0 || addedOffImport > 0 ? 'proof-payments-pair'
        : oldGroupsChanged > 0 || newGroups > 0 ? 'proof-payments-ambiguous'
          : returnedGone > 0 || returnedAdded > 0 ? 'proof-payments-returned'
            : setsChanged ? 'proof-payments-sets'
              : !debitsExact || otherChanges > 0 || paymentsGone > 0 || paymentsNewOffImport > 0 || paymentReasonChanged > 0
                ? 'proof-payments-unmatched' : null;
  return {
    code,
    pairsBefore: before.pairs.length,
    pairsAfter: after.pairs.length,
    pairsAdded: added.length,
    pairsChangedOrGone: changed,
    ambiguousBefore: before.ambiguous.length,
    ambiguousAfter: after.ambiguous.length,
    unmatchedPaymentsNew: paymentsNew.length,
    unmatchedDebitsBefore: debitsBefore.size,
    unmatchedDebitsAfter: debitsAfter.size,
    reasonFlipsToNoCardPayment: reasonFlips,
    otherChanges: otherChanges + paymentReasonChanged,
    returnedAdded,
  };
}
