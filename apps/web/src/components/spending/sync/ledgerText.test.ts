import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerEvent, TxnValues } from './ownerApi';
import { eventText, separateText } from './ledgerText';

const merged = (kind: TxnValues['kind']): { values: TxnValues } => ({ values: {
  status: 'removed', transactionDate: '2026-10-05', postedDate: '2026-10-06', amountMinor: 5_210, kind,
  description: 'FABRIKAM FUEL 0042', merchant: 'Fabrikam Fuel', cardScopeId: null,
} });
const START = 'Oct 5, 2026 · $52.10 becomes a charge of its own again, as it was before the merge (posted or pending), and the sources '
  + 'the merge moved go back to it. ';
const END = ' Either way, check that these aren\'t the same transaction twice.';

test('separating a merged charge: it comes back as it was before the merge, and what that does to spending depends on its kind', () => {
  // E2a's unmerge restores the status the row had before the merge, which Holdr's answer doesn't name: a pending charge
  // that settled into its posted one comes back pending, and a pending charge isn't spending until it posts.
  assert.equal(separateText(merged('purchase')), `${START}If it was posted, it counts in spending again next to the charge it was `
    + `merged into; if it was pending, not until it posts.${END}`);
  for (const kind of ['fee', 'interest', 'refund', 'adjustment'] as const) {
    assert.match(separateText(merged(kind)), /If it was posted, it counts in spending again/, kind);
  }
  // A card payment is a transfer and an `other` row isn't counted (cardSpendingRole), posted or not.
  assert.equal(separateText(merged('payment')), `${START}As a card payment it counts as a payment to the card, never as spending.${END}`);
  assert.equal(separateText(merged('other')), `${START}Its kind isn't counted in spending, posted or not.${END}`);
  for (const kind of ['purchase', 'payment', 'other'] as const) assert.doesNotMatch(separateText(merged(kind)), /[Bb]oth (then )?count/);
  // A charge that takes a card payment back counts as Spending reads it (effectiveCardKind): a payment, however stored.
  const returned = (kind: TxnValues['kind'], description: string) => ({ values: { ...merged(kind).values, description, merchant: null } });
  for (const kind of ['purchase', 'fee'] as const) {
    assert.equal(separateText(returned(kind, 'RETURNED ONLINE ACH PAYMENT')),
      `${START}As a card payment it counts as a payment to the card, never as spending.${END}`, kind);
  }
  // A fee for a returned payment is spending.
  assert.match(separateText(returned('fee', 'RETURNED PAYMENT FEE')), /If it was posted, it counts in spending again/);
  // A row stored as a card payment that names a fee is read as the import classifier kinds it: a fee, the adjustment that
  // gives the card's own fee back, or the refund of a merchant's fee. Spending, however stored.
  for (const [description, amountMinor] of [['NSF PAYMENT FEE', 2_700], ['RETURNED PAYMENT FEE REVERSAL', -2_700],
    ['SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', -500]] as const) {
    assert.match(separateText({ values: { ...returned('payment', description).values, amountMinor } }),
      /If it was posted, it counts in spending again/, description);
  }
  assert.equal(separateText(returned('payment', 'ONLINE ACH PAYMENT - THANK YOU')),
    `${START}As a card payment it counts as a payment to the card, never as spending.${END}`);
});

const values = (kind: TxnValues['kind']) => ({ status: 'posted' as const, amountMinor: 4_210, transactionDate: '2026-09-12',
  postedDate: '2026-09-12', kind, cardScopeId: null });
const corrected = (via: LedgerEvent['via'], over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  eventId: `card-event-${'a'.repeat(32)}`, eventType: 'corrected', reason: 'posted-correction', via, actor: via === 'file' ? 'file-import' : 'owner',
  deviceId: null, revision: 3, at: '2026-10-23T15:50:00.000Z', identityId: null, relatedTransactionId: null, reversesEventId: null,
  edited: [], from: values('payment'), to: values('purchase'), ...over,
});

test('an operator kind correction reads as maintenance, never as the owner\'s own edit, and shows the kind it changed', () => {
  // The ledger has no operator actor, so a card kind correction names the owner; only it records `corrected` via `session`.
  const text = eventText(corrected('session'), null);
  assert.equal(text.title, 'Corrected by maintenance');
  assert.match(text.detail, /, as a maintenance correction, not an edit of yours · kind Card payment → Purchase$/);
  assert.doesNotMatch(text.detail, /by you/);
  // A bank's or a file's correction keeps its own wording, and now shows a kind it changed too.
  const file = eventText(corrected('file'), null);
  assert.equal(file.title, 'Took the bank\'s corrected values');
  assert.match(file.detail, /, by an offline file import · kind Card payment → Purchase$/);
  const reviewed = eventText(corrected('extension', { actor: 'owner' }), null);
  assert.match(reviewed.detail, /, by you, reviewing what the extension sent · kind Card payment → Purchase$/);
  // The owner's own repair (an undo from a charge's history) still reads as the owner's.
  const repair = eventText(corrected('session', { eventType: 'reversed', reason: 'maintenance', reversesEventId: `card-event-${'b'.repeat(32)}`,
    from: values('purchase'), to: values('payment') }), null);
  assert.equal(repair.title, 'An earlier change was undone');
  assert.match(repair.detail, /, by you, as a repair · kind Purchase → Card payment$/);
  // An event that changed no kind shows none.
  assert.doesNotMatch(eventText(corrected('file', { to: { ...values('payment'), amountMinor: 4_250 } }), null).detail, /kind/);
});
