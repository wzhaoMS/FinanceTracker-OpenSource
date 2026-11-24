import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanCounts, RunDetail } from './ownerApi';
import { OwnerApiError } from './ownerClient';
import { cardGuidance, commitHeading, errorText, lastReceivedText, planCountsText, runRowsNote, STATUS_TEXT, STEP_TEXT } from './syncText';
import { exactTime } from './syncStatus';

type Run = Pick<RunDetail, 'acceptance' | 'ledger' | 'contentRetained' | 'rowCount' | 'results'>;
const run = (over: Partial<Run>): Run => ({ acceptance: 'needs-review', ledger: 'none', contentRetained: true, rowCount: 3, results: [], ...over });

test('a run\'s rows: listed when Holdr lists them; otherwise its record says why (E2a, handoff 10/18 02:30 item 4)', () => {
  // Each row listed, or nothing received: nothing to add.
  assert.equal(runRowsNote(run({ results: [{ rowIndex: 0, result: 'waiting', transactionId: null }] })), null);
  assert.equal(runRowsNote(run({ acceptance: 'none', rowCount: null, contentRetained: false })), null);
  // An expired review: E2a lists no row of its own even while it keeps their content.
  assert.equal(runRowsNote(run({ acceptance: 'expired-unreviewed' })),
    '3 rows expired before anyone reviewed them, so nothing from this run was added.');
  assert.equal(runRowsNote(run({ acceptance: 'expired-unreviewed', rowCount: 1, contentRetained: false })),
    '1 row expired before anyone reviewed it, so nothing from this run was added. Its values are gone too: only this record without values stays.');
  assert.equal(runRowsNote(run({ acceptance: 'expired-unreviewed', contentRetained: false })),
    '3 rows expired before anyone reviewed them, so nothing from this run was added. Their values are gone too: only this record without values stays.');
  // Values cleared after a commit, or with a discard. A commit applied a plan, which may have added nothing (only rejections).
  assert.equal(runRowsNote(run({ acceptance: 'committed', ledger: 'committed', contentRetained: false })),
    'This record no longer lists each row: their values were cleared. What its plan added or changed stays in your card transactions, '
    + 'with where it came from.');
  assert.equal(runRowsNote(run({ acceptance: 'rejected', contentRetained: false })),
    'The rows themselves are gone: they were discarded. Only this record without values stays.');
  // An open review whose rows aren't listed yet says nothing it can't know.
  assert.equal(runRowsNote(run({ acceptance: 'needs-review' })), null);
});

test('what E2a\'s refusals the first client didn\'t know mean (handoff 10/18 02:30 item 1)', () => {
  const said = (status: number, code: ConstructorParameters<typeof OwnerApiError>[2]) => errorText(new OwnerApiError('http', status, code));
  // Holdr never deletes a charge: a removed or merged one keeps its row, so "no such charge" means the page is behind Holdr.
  assert.deepEqual(said(404, 'transaction-not-found'),
    { message: 'Holdr has no such charge.', next: 'Nothing was changed. Reload Spending to see the charges Holdr has now.' });
  assert.doesNotMatch(said(404, 'transaction-not-found').next, /removed|merged/);
  // Not merged now, against merged but no longer separable exactly: two different things to tell the owner.
  assert.equal(said(409, 'merge-not-allowed').message, 'This charge isn\'t merged into another one now.');
  assert.equal(said(409, 'link-not-reversible').message, 'Holdr can\'t separate these charges exactly any more.');
  // The server's conditions (unmergeCardTransaction), and only those: a change to the charge it was merged into doesn't block it.
  assert.equal(said(409, 'link-not-reversible').next, 'The merged charge itself changed after the merge, a source the merge moved is '
    + 'no longer on the charge it was merged into, or a charge would be left without a source. Nothing was changed; the latest is shown now.');
  // A server failure may have saved it: never "nothing changed".
  assert.deepEqual(said(500, 'internal-error'),
    { message: 'Holdr couldn\'t finish the request.', next: 'It may or may not have been saved: check the latest state before trying again.' });
});
test('a confirmed plan says it was applied, and its counts what it did: a plan of only rejections adds nothing (Astra round 3)', () => {
  const none: PlanCounts = {
    insert: 0, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0,
  };
  // E2a commits a plan whose every row is rejected: the set closes as committed, and no transaction is added.
  assert.equal(commitHeading('set'), 'Plan applied.');
  assert.equal(planCountsText({ ...none, rejected: 2 }), 'Not added: 2');
  assert.equal(planCountsText({ ...none, insert: 2, rejected: 1 }), 'Added: 2 · Not added: 1');
  assert.equal(planCountsText(none), 'No changes.');
  assert.equal(commitHeading('adjustment'), 'Changes applied.');
  // A committed set's status is the plan applied, never "added to spending".
  assert.equal(STATUS_TEXT.committed.label, 'Plan applied');
  for (const text of [commitHeading('set'), commitHeading('adjustment'), STATUS_TEXT.committed.label]) assert.doesNotMatch(text, /spending|[Aa]dded/);
});

test('what a browser sends is applied only through a plan, confirmed here or, when nothing needs a decision, in the extension', () => {
  // E2c lets the browser prepare and commit a set that needs no review (every action device-committable): the owner's
  // confirmation in Holdr is not the only way in, so no text says it is. A card shows its next step and the lines under it.
  const awaiting = [STATUS_TEXT['awaiting-review'].next, ...STATUS_TEXT['awaiting-review'].more].join(' ');
  for (const text of [awaiting, STEP_TEXT.send.detail]) {
    assert.match(text, /Nothing from it is applied until a plan for it is confirmed/);
    assert.match(text, /in the extension/);
    assert.doesNotMatch(text, /until you confirm/);
  }
});

type Guided = Parameters<typeof cardGuidance>[0];
const guided = (over: Partial<Guided>): Guided => ({ primary: 'awaiting-review', pauseReasons: [], flags: [], stopped: null, ...over });

test('a connected card leads with one next step, then short lines: one fact or instruction each (readability H)', () => {
  // Every status has a step, and every line is one sentence or two at most.
  for (const primary of Object.keys(STATUS_TEXT) as Array<keyof typeof STATUS_TEXT>) {
    const { next, more } = cardGuidance(guided({ primary, pauseReasons: primary === 'paused' ? ['server-paused'] : [] }));
    assert.ok(next.length > 0, primary);
    for (const line of [next, ...more]) assert.ok((line.match(/[.!?](\s|$)/g) ?? []).length <= 2, `${primary}: ${line}`);
  }
  assert.deepEqual(cardGuidance(guided({})), {
    next: 'Review it before it expires.',
    more: ['Nothing from it is applied until a plan for it is confirmed: here, or in the extension when it needs no decision.'],
  });
  // Flags add why, then what to do, each on its own line, after the status's own lines.
  assert.deepEqual(cardGuidance(guided({ primary: 'plan-expired', flags: ['bank-sign-in', 'partial-coverage'] })), {
    next: 'Open the review and prepare a new plan from the current ledger.',
    more: [
      'The imported rows are still kept.',
      'The bank asked for sign-in during the last read.',
      'Sign in yourself; Holdr and the extension never sign in for you.',
      'The last read didn\'t prove it saw everything.',
      'Import the redacted offline file for the dates not covered.',
    ],
  });
  // A plan applied after an incomplete read: what that read asks for is the next step, never "nothing to do".
  assert.deepEqual(cardGuidance(guided({ primary: 'committed', flags: ['partial-coverage'] })), {
    next: 'Import the redacted offline file for the dates not covered.',
    more: ['The last read didn\'t prove it saw everything.'],
  });
  assert.match(cardGuidance(guided({ primary: 'committed' })).next, /^Nothing to do now\./);
  // Paused: the first reason's step leads; any other reason's step follows.
  assert.deepEqual(cardGuidance(guided({ primary: 'paused', pauseReasons: ['server-paused', 'issuer-off'] })), {
    next: 'Resume syncing in Extension & devices (your password is asked again).',
    more: ['Turn this issuer on in Extension & devices.'],
  });
  // Stopped by the extension: its own step, then why, and that nothing was sent.
  assert.deepEqual(cardGuidance(guided({ primary: 'stopped', stopped: 'certificate-error' })), {
    next: 'Check Tailscale and Holdr\'s HTTPS address.',
    more: ['A connection failed its certificate check.', 'Never switch to HTTP or ignore a certificate error.', 'Nothing was sent.'],
  });
  // Nothing received: the safety warning stays in view.
  assert.ok(cardGuidance(guided({ primary: 'send-unknown' })).more.includes('Never switch to HTTP or ignore a certificate error.'));
});

test('a card says when Holdr last received something for it, as its record says, and never "in a moment" (readability H)', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  // The exact time is in the browser's zone (the e2e spec checks it in UTC); here only how the line is made.
  const at = (iso: string) => exactTime(iso);
  assert.equal(lastReceivedText('2026-10-17T10:00:00.000Z', now), `Last received 2 hours ago · ${at('2026-10-17T10:00:00.000Z')}`);
  assert.equal(lastReceivedText('2026-09-22T12:00:00.000Z', now), `Last received 25 days ago · ${at('2026-09-22T12:00:00.000Z')}`);
  assert.equal(lastReceivedText('2026-10-17T12:00:20.000Z', now), `Last received just now · ${at('2026-10-17T12:00:20.000Z')}`);
  // Holdr works it out from the imports it still keeps, and retention clears old ones: none on record is unknown, not never.
  assert.equal(lastReceivedText(null, now), 'Last received: not on record');
  assert.doesNotMatch(lastReceivedText(null, now), /nothing|never|none|yet/i);
});