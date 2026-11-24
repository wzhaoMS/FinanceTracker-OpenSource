/**
 * Every sentence the sync controls show, in one place: status names with the
 * safe next step (plan §8: failure texts must give one), review categories
 * and decisions, plan effects, and what each fixed error code means for the
 * owner. Plain text only; the UI renders it as text nodes.
 */
import type { CardSyncTermination } from '@finance-tracker/shared';
import { isOwnerApiError } from './ownerClient';
import type {
  AbortReason, DecisionAction, DiscardReason, EffectKind, PlanCounts, PlanKind, ReviewCategory, ReviewReason, RevokeReason, RunDetail, RunErrorCode,
} from './ownerApi';
import { plural } from './syncFormat';
import { exactTime, pastTime, type BindingStatus, type FirstRunStepId, type PauseReason, type PrimaryStatus, type StatusFlag } from './syncStatus';

/** A plan's counts as the owner reads them (E1b plan counts), in this order. */
export const COUNT_LABELS: ReadonlyArray<readonly [keyof PlanCounts, string]> = [
  ['insert', 'Added'],
  ['matched', 'Counted once with an existing transaction'],
  ['attributed', 'Put on a card'],
  ['promoted', 'Pending → posted'],
  ['corrected', 'Corrected'],
  ['rejected', 'Not added'],
  ['unmatched', 'Unlinked'],
  ['superseded', 'Extra copies retired (kept, not deleted)'],
  ['aliased', 'New source for a charge already in spending'],
  ['update', 'Updated'],
  ['unchanged', 'Unchanged'],
];

/** What a plan did, from its counts: "Added: 2 · Not added: 1", or "No changes.". */
export function planCountsText(counts: PlanCounts): string {
  return COUNT_LABELS.filter(([key]) => counts[key] > 0).map(([key, label]) => `${label}: ${counts[key]}`).join(' · ') || 'No changes.';
}

/**
 * The heading once a plan is confirmed. A committed set had a plan applied, which may have added, changed or only rejected
 * rows (a plan of only rejections commits too and adds nothing), so it never says "added": the counts say what it did.
 */
export function commitHeading(kind: PlanKind): string {
  return kind === 'adjustment' ? 'Changes applied.' : 'Plan applied.';
}

export interface StatusText {
  label: string;
  /** The one next step a card shows second, right under when it last received something. Never empty. */
  next: string;
  /** Short lines under it, one fact or instruction each. */
  more: readonly string[];
}

export const STATUS_TEXT: Record<PrimaryStatus, StatusText> = {
  'not-set-up': { label: 'Not set up', next: 'In Extension & devices, confirm this card, then pair a browser and approve it.', more: [] },
  // A paused card leads with its first pause reason's step (PAUSE_NEXT); this is the step for all syncing paused.
  paused: { label: 'Paused', next: 'Resume syncing in Extension & devices (your password is asked again).', more: [] },
  'no-device': { label: 'No working device', next: 'Pair the browser again in Extension & devices.', more: ['Revoked or expired credentials never come back.'] },
  'regrant-needed': {
    label: 'No working device: allow a browser again',
    next: 'Allow a browser again in Extension & devices ("Allow again…" under Browsers), or pair a new one.',
    more: ['This card was confirmed again without the browsers that sent for it, so none may send now.'],
  },
  'waiting-activity': {
    label: 'Waiting for the activity page',
    next: 'Sign in to the bank yourself and open its activity page; the extension starts from there.',
    more: [],
  },
  'captured-not-sent': { label: 'Captured, not sent', next: 'Check the exact preview in the extension popup, then send it or close it to discard it.', more: [] },
  'send-unknown': {
    label: 'Send result unknown',
    next: 'Open the extension popup to see what happened.',
    more: [
      'Holdr received nothing for the last run.',
      'If site access was removed, grant it again there.',
      'If the bank signed you out, sign in yourself.',
      'If it says the page changed, turn this issuer off and import the offline file.',
      'If it can\'t reach Holdr, check Tailscale and HTTPS.',
      'Never switch to HTTP or ignore a certificate error.',
    ],
  },
  stopped: { label: 'Stopped by the extension', next: 'Open the extension popup to see why.', more: ['Nothing was sent.'] },
  refused: {
    label: 'Refused by Holdr',
    next: 'Open it under Recent runs to see why and what to do.',
    more: ['Holdr received the last upload but kept nothing from it.', 'Don\'t resend it unchanged.'],
  },
  'awaiting-review': {
    label: 'Received, awaiting review (not in spending)',
    next: 'Review it before it expires.',
    more: ['Nothing from it is applied until a plan for it is confirmed: here, or in the extension when it needs no decision.'],
  },
  'plan-expired': {
    label: 'Plan expired (prepare a new one)',
    next: 'Open the review and prepare a new plan from the current ledger.',
    more: ['The imported rows are still kept.'],
  },
  'review-expired': { label: 'Review expired (capture again)', next: 'Capture this period again, or import the redacted offline file for it.', more: ['Nothing was added.'] },
  // A committed set had a plan applied: it may have added, changed or only rejected rows (an all-rejected plan adds nothing).
  committed: { label: 'Plan applied', next: 'Nothing to do now. The next import comes from the bank\'s activity page.', more: [] },
};

export const FLAG_TEXT: Record<StatusFlag, { label: string; why: string; next: string }> = {
  'partial-coverage': {
    label: 'Partial coverage',
    why: 'The last read didn\'t prove it saw everything.',
    next: 'Import the redacted offline file for the dates not covered.',
  },
  'bank-sign-in': {
    label: 'Bank sign-in needed',
    why: 'The bank asked for sign-in during the last read.',
    next: 'Sign in yourself; Holdr and the extension never sign in for you.',
  },
  'rate-limited': {
    label: 'Rate-limited',
    why: 'The bank limited requests and the extension stopped.',
    next: 'Try again later; don\'t retry over and over.',
  },
};

/** Why nothing syncs for a card, as banners and refusals say it: what is wrong, then what to do. */
export const PAUSE_TEXT: Record<PauseReason, string> = {
  'server-paused': 'All syncing is paused in Extension & devices. Resume it there (your password is asked again).',
  'issuer-off': 'This issuer is off. Turn it on in Extension & devices.',
  'gate-blocked': 'Holdr has closed device authorization. The owner must run Holdr\'s recovery tool on the Holdr server; no device can upload until then.',
  'device-api-off': 'Device uploads are off on this Holdr until the HTTPS entry and these controls are accepted.',
  'needs-reconfirmation': 'This card must be confirmed again before anything syncs.',
  retired: 'This card was disconnected. Connect it again to sync it.',
};

/** The step each pause reason asks for, as a paused card's next step. */
export const PAUSE_NEXT: Record<PauseReason, string> = {
  'server-paused': STATUS_TEXT.paused.next,
  'issuer-off': 'Turn this issuer on in Extension & devices.',
  'gate-blocked': 'Run Holdr\'s recovery tool on the Holdr server; no device can upload until then.',
  'device-api-off': 'Nothing to do here: device uploads are off on this Holdr until the HTTPS entry and these controls are accepted.',
  'needs-reconfirmation': 'Confirm its cards again in Extension & devices.',
  retired: 'Connect this card again in Extension & devices to sync it.',
};

/**
 * What a connected card says under when it last received something: one next step, then short lines, one fact or
 * instruction each. A card whose plan was applied but whose last read was incomplete leads with what that read asks for.
 */
export function cardGuidance(status: Pick<BindingStatus, 'primary' | 'pauseReasons' | 'flags' | 'stopped'>): { next: string; more: string[] } {
  const flagLines = (flags: readonly StatusFlag[]) => flags.flatMap((flag) => [FLAG_TEXT[flag].why, FLAG_TEXT[flag].next]);
  if (status.stopped) return { next: ABORT_TEXT[status.stopped].next, more: [...ABORT_TEXT[status.stopped].more, ...flagLines(status.flags)] };
  if (status.primary === 'paused' && status.pauseReasons.length > 0) {
    const [first, ...rest] = status.pauseReasons;
    return { next: PAUSE_NEXT[first], more: [...rest.map((reason) => PAUSE_NEXT[reason]), ...flagLines(status.flags)] };
  }
  if (status.primary === 'committed' && status.flags.length > 0) {
    const [first, ...rest] = status.flags;
    return { next: FLAG_TEXT[first].next, more: [FLAG_TEXT[first].why, ...flagLines(rest)] };
  }
  const text = STATUS_TEXT[status.primary];
  return { next: text.next, more: [...text.more, ...flagLines(status.flags)] };
}

/** What a "last" time says when Holdr keeps no record of one: unknown, which is not the same as never. */
export const NOT_ON_RECORD = 'Not on record';

/**
 * The line a connected card leads with: when Holdr last received something for it, as its records say. Holdr works this
 * out from the imports it still keeps, and retention clears old ones, so with none on record it says just that: it
 * never claims nothing ever arrived.
 */
export function lastReceivedText(lastAcceptedAt: string | null, now: number): string {
  return lastAcceptedAt ? `Last received ${pastTime(lastAcceptedAt, now)} · ${exactTime(lastAcceptedAt)}` : `Last received: ${NOT_ON_RECORD.toLowerCase()}`;
}

export const STEP_TEXT: Record<FirstRunStepId, { title: string; detail: string }> = {
  binding: {
    title: 'Choose the card account and confirm its cards',
    detail: 'Pick the Holdr card account, then list the cards the bank shows on it (holder and last four). Rows the extension can\'t place go to "Holder unknown".',
  },
  pair: {
    title: 'Pair the browser and compare the confirmation code',
    detail: 'Turn the bank on under Sync switches first (it shows the risk notice). Then create a pairing code here, type it into the extension popup, '
      + 'and approve only if the popup shows the same confirmation code and the same HTTPS address.',
  },
  extension: {
    title: 'In the extension: allow the bank site',
    detail: 'The popup asks for site access issuer by issuer and explains the session risk. Holdr can\'t see this step.',
  },
  activity: {
    title: 'Sign in to the bank yourself and open the activity page',
    detail: 'Then, in the extension, choose this connected card for the account it shows. If a card is missing, add it under Connected cards first.',
  },
  send: {
    title: 'Check the exact preview in the extension, then send',
    detail: 'Holdr keeps what you send for 30 days. Nothing from it is applied until a plan for it is confirmed: in the extension '
      + '(Commit to ledger) when it needs no decision, otherwise here after you review it.',
  },
  review: {
    title: 'Review in Holdr and confirm the plan',
    detail: 'Decide each item, prepare a plan from the current ledger, check the changes, then confirm. Plans last 10 minutes.',
  },
  auto: {
    title: 'Optional: automatic sending',
    detail: 'Offered per connected card only after one complete manual round, and only after Holdr opens it for that bank (it stays closed until '
      + 'that bank\'s own checks pass). It is permission given in advance for the browsers that send for that card now; a browser allowed later, '
      + 'or any change to the card\'s connection, asks again.',
  },
};

export const CATEGORY_TEXT: Record<ReviewCategory, { label: string; detail: string }> = {
  'cross-source-similar': { label: 'Looks like one Holdr already has', detail: 'Similar date, amount and description from another source. Similar is not proof: two equal purchases stay two.' },
  'no-stable-id': { label: 'No stable id', detail: 'The bank gave no lasting id for this row, so Holdr never adds it on its own.' },
  'scope-unknown': { label: 'Card not known', detail: 'The source didn\'t say which card this was. It is never moved onto the main card by itself.' },
  'pending-link': {
    label: 'Maybe the same charge, pending and posted',
    detail: 'One side is pending and the other posted (or was removed). Holdr can\'t prove they are the same purchase.',
  },
  'posted-correction': { label: 'The bank changed a posted row', detail: 'The same posted transaction now shows other values. Refunds and reversals are separate rows, not corrections.' },
  'reconciliation-difference': { label: 'Statement figures don\'t add up', detail: 'The statement on the page doesn\'t match the rows Holdr can account for.' },
};

/** Holdr's precise reason for asking (E1b §2.14, Q27), shown under the item's category. */
export const REASON_TEXT: Record<ReviewReason, string> = {
  'cross-source-similar': 'A transaction from another source looks the same.',
  'identity-conflict': 'The bank\'s id for this row already belongs to another transaction in Holdr, so it can\'t simply be added.',
  'detached-identity': 'This row\'s id was unlinked from a transaction earlier, so Holdr won\'t reuse it on its own.',
  'no-stable-id': 'The bank gave no lasting id for this row.',
  'unknown-scope': 'The source didn\'t say which card this was.',
  'pending-posted': 'A pending charge now shows as posted.',
  'pending-may-have-posted': 'A pending charge may have posted as this row.',
  'removed-hit': 'This row matches a transaction the bank had removed, so it can\'t simply be added.',
  'posted-correction': 'The bank changed the values of a posted row.',
  'pending-changed': 'A pending charge changed before it posted.',
  'statement-mismatch': 'The statement\'s totals don\'t match the rows.',
};

/** What a decision means, worded for the item's category. */
export function actionText(action: DecisionAction, category: ReviewCategory): string {
  switch (action) {
    case 'same-transaction':
      return 'Same transaction: count it once';
    case 'attribute-and-link':
      return 'Same transaction: put it on this card and link them (the file\'s identity stays as an alias)';
    case 'attribute':
      return 'Put it on this card';
    case 'insert-new':
      if (category === 'cross-source-similar') return 'Keep both (they may be counted twice)';
      if (category === 'scope-unknown') return 'Add it without a card';
      if (category === 'pending-link') return 'It\'s a separate transaction';
      return 'It\'s a new transaction: add it';
    case 'accept-correction':
      return 'Accept the bank\'s change (your category and notes stay)';
    case 'keep-current':
      return 'Keep Holdr\'s current values';
    case 'accept-difference':
      return 'Accept the difference and continue';
    case 'reject-row':
      return 'Don\'t add this row';
    default:
      return action;
  }
}

/**
 * A decision on one target, worded by what it does there (E1b §4.6): a posted row linked to a pending or removed one
 * makes it posted (restoring a removed one first), a pending row linked to a posted one changes nothing, and accepting a
 * correction of a removed row restores it.
 */
export function decisionText(
  action: DecisionAction,
  category: ReviewCategory,
  observed: 'pending' | 'posted' | null,
  target: 'pending' | 'posted' | 'removed' | null,
): string {
  if (action === 'same-transaction' && observed === 'posted' && target === 'removed') return 'It\'s the posted version of this removed charge: restore it as posted';
  if (action === 'same-transaction' && observed === 'posted' && target === 'pending') return 'It\'s the posted version of this pending charge';
  if (action === 'same-transaction' && observed === 'pending' && target === 'posted') return 'It\'s this charge, already posted in Holdr (nothing changes)';
  if (action === 'accept-correction' && target === 'removed') return 'Accept the bank\'s values and restore it (your category and notes stay)';
  return actionText(action, category);
}

export const EFFECT_TEXT: Record<EffectKind, string> = {
  insert: 'Add',
  update: 'Update',
  match: 'Count once with',
  alias: 'Already in spending: add this as another source of it (the charge stays as it is)',
  attribute: 'Put on card and link',
  promote: 'Pending → posted',
  correct: 'Correct',
  reject: 'Not added',
  unmatch: 'Unlink',
  'restore-attribution': 'Restore the card attribution',
  supersede: 'Retire the extra copy (kept, not deleted)',
  revert: 'Back to the values it had before',
  remove: 'Take out the row added before (kept as removed, not deleted)',
  'accept-difference': 'Accept the statement difference (nothing in spending changes)',
};

/** An effect's name, with the restore a removed row gets (E1b §4.6) or loses again (§4.9.2) said plainly. */
export function effectText(effect: { effect: EffectKind; before: { status: string } | null; after: { status: string } | null }): string {
  if (effect.effect === 'promote' && effect.before?.status === 'removed') return 'Restore, now posted';
  if (effect.effect === 'correct' && effect.before?.status === 'removed') return 'Restore with the bank\'s values';
  if (effect.effect === 'revert' && effect.after?.status === 'removed') return 'Back to removed, with the values it had';
  return EFFECT_TEXT[effect.effect];
}

export const DISCARD_TEXT: Record<DiscardReason, string> = {
  'not-mine': 'Not my transactions',
  'wrong-binding': 'Sent to the wrong card',
  'duplicate-of-file': 'Already imported from a file',
  'bad-data': 'The data looks wrong',
  other: 'Other reason',
};

/** Why Holdr refused a whole upload: E1b's `refusal_code`. Nothing from such an upload is kept. */
export const RUN_ERROR_TEXT: Record<RunErrorCode, string> = {
  'payload-invalid': 'Holdr refused the upload: it failed the format checks. Nothing from it was kept. Update the extension if it keeps happening.',
  'payload-digest-mismatch': 'Holdr refused the upload: what arrived didn\'t match what the extension said it sent. Nothing from it was kept. Send it again from the popup.',
  'too-large': 'Holdr refused the upload as too large. Nothing from it was kept.',
  'card-data': 'Holdr refused the upload because part of it looked like card data. Nothing from it was kept. Don\'t send it again; import the redacted offline file instead.',
  'review-quota-exceeded': 'Holdr refused the whole upload because the review queue was full. Nothing from it is waiting. Review or discard waiting items, or import the offline file.',
  'binding-stale': 'The extension used an outdated copy of this card\'s connection. It reloads it from Holdr; send again after that.',
  'sync-disabled': 'Syncing was paused or this issuer was off, so nothing was kept.',
  'source-not-authorized': 'This browser may no longer send for this card, so nothing was kept. Allow it again in Extension & devices, or pair it again.',
  'scope-not-in-binding': 'The upload named a card this connection doesn\'t list, so nothing was kept. Add the card under Connected cards, then send again.',
  'contract-unsupported': 'The extension uses a data format this Holdr doesn\'t accept, so nothing was kept. Update the extension or Holdr.',
  'capture-already-accepted': 'Holdr already has this capture from an earlier upload, so it didn\'t keep a second copy. Review the earlier one.',
};

/** How a browser stopped working, as the browsers list says it. */
export const REVOKE_TEXT: Record<RevokeReason, string> = {
  owner: 'by you',
  rejected: 'not approved',
  rotated: 'replaced by a new pairing',
  recovery: 'restore from backup',
  'password-reset': 'the Holdr password was reset',
};

/** Why the extension stopped a run (Q4): its name, the plan §8 safe next step, then short lines. Holdr received nothing from such a run. */
export const ABORT_TEXT: Record<AbortReason, { label: string; next: string; more: readonly string[] }> = {
  'site-permission-revoked': {
    label: 'Stopped: site access was removed',
    next: 'Grant access again in the extension popup, then open the activity page.',
    more: ['The browser no longer lets the extension read this bank\'s site.', 'Nothing was sent.'],
  },
  'not-signed-in': {
    label: 'Stopped: not signed in to the bank',
    next: 'Sign in to the bank yourself, then open the activity page.',
    more: ['Holdr and the extension never sign in for you.', 'Nothing was sent.'],
  },
  'unknown-page-structure': {
    label: 'Stopped: the bank page changed',
    next: 'Turn this issuer off and import the redacted offline file until the extension is updated.',
    more: ['The page didn\'t look as expected, so the extension stopped instead of guessing.', 'Nothing was sent.'],
  },
  'certificate-error': {
    label: 'Stopped: certificate error',
    next: 'Check Tailscale and Holdr\'s HTTPS address.',
    more: ['A connection failed its certificate check.', 'Never switch to HTTP or ignore a certificate error.', 'Nothing was sent.'],
  },
  'user-cancelled': {
    label: 'Stopped: you cancelled it',
    next: 'Start again from the bank\'s activity page when you want to.',
    more: ['Nothing was sent.'],
  },
};

export const TERMINATION_TEXT: Record<CardSyncTermination, string> = {
  'end-marker': 'Read to the end',
  snapshot: 'One snapshot, no end signal',
  'more-available': 'More was available but not read',
  'user-navigation': 'Stopped when the page changed',
  cap: 'Stopped at a size or time limit',
  'repeated-cursor': 'Stopped on a repeated page',
  'empty-page': 'Stopped on an empty page',
  'rate-limited': 'The bank limited requests',
  'auth-required': 'The bank asked for sign-in',
  error: 'Stopped on an error',
  'not-read': 'Not read',
};

export interface ErrorText {
  message: string;
  next: string;
}

/**
 * What a run's record says about its rows when Holdr lists no result for each (null when it does, or when nothing was
 * received). Holdr lists them only while it keeps their content, and never for a review that expired (E2a: an expired
 * set's rows have no result of their own, though their content may stay until retention clears it).
 */
export function runRowsNote(run: Pick<RunDetail, 'acceptance' | 'ledger' | 'contentRetained' | 'rowCount' | 'results'>): string | null {
  if (run.results.length > 0 || run.acceptance === 'none') return null;
  const rows = run.rowCount === null ? 'Its rows' : plural(run.rowCount, 'row');
  if (run.acceptance === 'expired-unreviewed') {
    return `${rows} expired before anyone reviewed ${run.rowCount === 1 ? 'it' : 'them'}, so nothing from this run was added.`
      + (run.contentRetained ? '' : ` ${run.rowCount === 1 ? 'Its' : 'Their'} values are gone too: only this record without values stays.`);
  }
  if (run.contentRetained) return null;
  if (run.ledger === 'committed') {
    return 'This record no longer lists each row: their values were cleared. What its plan added or changed stays in your card '
      + 'transactions, with where it came from.';
  }
  if (run.acceptance === 'rejected') return 'The rows themselves are gone: they were discarded. Only this record without values stays.';
  return 'The rows themselves are gone. Only this record without values stays.';
}

/** What a failed call means and what to do next. Built from fixed codes only; never from a value. */
export function errorText(error: unknown): ErrorText {
  if (!isOwnerApiError(error)) return { message: 'Something went wrong.', next: 'Check the latest state before trying again.' };
  switch (error.kind) {
    case 'unavailable':
      return { message: 'This Holdr doesn\'t support extension sync yet.', next: 'Card spending from files keeps working. Nothing was sent or changed.' };
    case 'network':
      return {
        message: 'Couldn\'t reach Holdr.',
        next: 'Check your connection. If you were changing something, it may or may not have been saved: check the latest state before trying again.',
      };
    case 'invalid-answer':
      return { message: 'Holdr\'s answer didn\'t pass this page\'s checks, so nothing from it is shown.', next: 'Reload. If it keeps happening, pause syncing.' };
    case 'invalid-input':
      return { message: 'That request isn\'t valid.', next: 'Reload and try again.' };
    default:
      break;
  }
  if (error.status === 401) return { message: 'Your Holdr sign-in has ended.', next: 'Sign in again.' };
  switch (error.code) {
    case 'version-conflict':
      return { message: 'This changed in another window or browser.', next: 'The latest state is shown now. Check it and try again.' };
    case 'sync-paused':
      return { message: 'Syncing is paused, or this issuer is off.', next: 'Resume it in Extension & devices first. You can still review and discard.' };
    case 'authorization-blocked':
      return { message: 'Holdr has closed device authorization.', next: PAUSE_TEXT['gate-blocked'] };
    case 'device-api-disabled':
      return { message: 'Device uploads are off on this Holdr.', next: PAUSE_TEXT['device-api-off'] };
    case 'recent-auth-required':
      return { message: 'Holdr needs your password again for this.', next: 'Confirm your password and try again.' };
    case 'csrf-required':
    case 'credential-not-allowed':
      return { message: 'Holdr refused the request as unsafe.', next: 'Reload the page and try again.' };
    case 'binding-exists':
      return { message: 'This card account is already connected for that source.', next: 'Use that connected card.' };
    case 'binding-needs-reconfirmation':
      return { message: 'This card\'s cards need confirming again first.', next: 'Confirm them in Extension & devices.' };
    case 'binding-retired':
      return { message: 'This card was disconnected.', next: 'Connect it again under Connected cards.' };
    case 'card-account-mismatch':
      return { message: 'That card account is for another issuer or currency, or it\'s closed.', next: 'Choose a matching card account.' };
    case 'auto-sync-not-eligible':
      return { message: 'Automatic sending needs one complete manual round first, from a working browser.', next: 'Send, review and confirm once by hand.' };
    case 'gate-closed':
      return {
        message: 'Holdr hasn\'t opened automatic sending for this bank yet.',
        next: 'It stays closed until that bank\'s own checks pass. Keep sending by hand meanwhile; nothing was changed.',
      };
    case 'pairing-not-redeemed':
      return { message: 'The extension hasn\'t used this code yet.', next: 'Type the code into the extension popup, then check again.' };
    case 'pairing-closed':
      return { message: 'This pairing is already closed.', next: 'Create a new pairing code if you still need one.' };
    case 'fingerprint-mismatch':
      return { message: 'The confirmation code doesn\'t match.', next: 'Don\'t approve. Reject this browser and pair again.' };
    case 'pairing-expired':
      return { message: 'The time to approve this browser has passed.', next: 'Pair again.' };
    case 'binding-stale':
      return {
        message: 'A connected card in this pairing changed after the browser used the code.',
        next: 'Don\'t approve it: cancel this pairing and pair again, so the browser gets the cards as they are now.',
      };
    case 'contract-unsupported':
      return {
        message: 'Holdr hasn\'t accepted this bank\'s data format.',
        next: 'If the bank is off under Sync switches, turn it on there first. If it is on, update the extension or Holdr. Nothing was changed.',
      };
    case 'unauthorized':
      return { message: 'That password didn\'t work.', next: 'Try again.' };
    case 'set-closed':
      return { message: 'This review is closed.', next: 'Reload to see its final state.' };
    case 'action-not-allowed':
      return { message: 'Holdr doesn\'t allow that decision for this item.', next: 'Choose one of the decisions shown.' };
    case 'transaction-revision-stale':
      return { message: 'This charge or its sources changed since you opened it.', next: 'The latest is shown now. Check it and try again.' };
    case 'merge-not-allowed':
      return { message: 'This charge isn\'t merged into another one now.', next: 'Nothing was changed. The latest is shown now.' };
    case 'link-not-reversible':
      // E2a's unmergeCardTransaction: the merge must still be the merged row's latest change, each source the merge moved must
      // still be active on the charge it was merged into, and both charges must keep a source. Changes to that charge don't count.
      return {
        message: 'Holdr can\'t separate these charges exactly any more.',
        next: 'The merged charge itself changed after the merge, a source the merge moved is no longer on the charge it was merged '
          + 'into, or a charge would be left without a source. Nothing was changed; the latest is shown now.',
      };
    case 'transaction-not-found':
      // Holdr never deletes a charge (a removed or merged one keeps its row), so this is a list older than Holdr's data.
      return { message: 'Holdr has no such charge.', next: 'Nothing was changed. Reload Spending to see the charges Holdr has now.' };
    case 'cross-card-link-refused':
      return { message: 'That charge is on a different card.', next: 'A source moves only to a charge on the same card, or to one with no card recorded.' };
    case 'decisions-incomplete':
      return { message: 'Some items have no decision yet.', next: 'Decide every item, then prepare the plan.' };
    case 'source-review-required':
      return { message: 'Confirm you checked where this import came from.', next: 'Tick the review box, then prepare the plan.' };
    case 'preview-stale':
      return { message: 'Something changed since this plan was made.', next: 'Prepare a new plan from the current ledger.' };
    case 'plan-mismatch':
      return { message: 'This plan doesn\'t match Holdr\'s copy.', next: 'Prepare a new plan from the current ledger.' };
    case 'plan-expired':
      return { message: 'This plan expired (plans last 10 minutes).', next: 'Prepare a new plan from the current ledger; the imported rows are still kept.' };
    case 'observation-expired':
      return {
        message: 'Holdr no longer keeps this import: its 30 days are over.',
        next: 'Nothing more can be decided here. Rows already in spending stay; change them with Spending\'s own tools. '
          + 'To add this period, capture it again or import the redacted offline file.',
      };
    case 'receipt-expired':
      return { message: 'The exact sent object was cleared after 7 days.', next: 'The review record stays until its own expiry, and rows already added stay in spending.' };
    case 'not-found':
      return { message: 'Holdr doesn\'t have that any more.', next: 'Reload to see the current state.' };
    case 'rate-limited':
      return {
        message: 'Too many requests.',
        next: error.extra.retryAfterSeconds ? `Try again in ${error.extra.retryAfterSeconds} seconds.` : 'Try again shortly.',
      };
    case 'unavailable':
      return { message: 'Holdr is busy.', next: 'Try again shortly; if you were changing something, check the latest state first.' };
    case 'internal-error':
      return {
        message: 'Holdr couldn\'t finish the request.',
        next: 'It may or may not have been saved: check the latest state before trying again.',
      };
    case 'invalid-request':
      return {
        message: 'Holdr refused the request.',
        next: error.extra.issues?.length ? `Problems: ${error.extra.issues.map((issue) => `${issue.code} at ${issue.path}`).join('; ')}.` : 'Check the form and try again.',
      };
    default:
      if (error.code === null || (error.status ?? 0) >= 500) {
        return {
          message: `Holdr couldn't finish the request${error.status ? ` (${error.status})` : ''}.`,
          next: 'It may or may not have been saved: check the latest state before trying again.',
        };
      }
      return { message: `Holdr refused the request (${error.code}).`, next: 'Nothing was changed. Try again.' };
  }
}
