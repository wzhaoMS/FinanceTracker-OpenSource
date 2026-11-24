/**
 * Talking to the worker from the trusted pages, and the fixed plain-text
 * descriptions of every code the UI can show.
 */
import type { CollectorCode, CollectorState, UiCommand, UiErrorCode } from '../contracts/messages.js';
import type { UiReply } from '../contracts/uiState.js';

type CommandBody = UiCommand extends infer C ? (C extends { type: 'ui-command/v1' } ? Omit<C, 'type'> : never) : never;

export async function command(body: CommandBody): Promise<UiReply> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: 'ui-command/v1', ...body })) as UiReply | undefined;
    if (!reply || typeof reply !== 'object') return { ok: false, code: 'invalid-command', state: null };
    return reply;
  } catch {
    return { ok: false, code: 'invalid-command', state: null };
  }
}

export const UI_ERROR_TEXT: Readonly<Record<UiErrorCode, string>> = Object.freeze({
  'invalid-command': 'The extension refused that request.',
  'not-trusted-sender': 'Only the extension’s own pages may do that.',
  'storage-untrusted': 'Browser storage could not be restricted to this extension, so nothing sensitive is stored. Update the browser.',
  paused: 'Card sync is paused.',
  'not-paired': 'This browser is not paired with Holdr yet.',
  'device-pending': 'Holdr has not approved this browser yet. Compare the code and approve it in Holdr.',
  'device-revoked': 'Holdr no longer accepts this browser’s credential (revoked or expired). Pair again.',
  'pairing-failed': 'Pairing failed.',
  'pairing-invalid': 'That pairing code is wrong, used or expired. Create a new one in Holdr.',
  'pairing-locked': 'Too many attempts. Create a new pairing code in Holdr.',
  'holdr-unreachable': 'Holdr could not be reached over HTTPS. Check Tailscale and Holdr; never switch to HTTP or ignore certificate errors.',
  'holdr-refused': 'Holdr refused the request.',
  'holdr-protocol': 'Holdr answered in an unexpected form, so the extension does not rely on that answer. If it was about a send or a commit, check with Holdr what it has.',
  'sync-disabled': 'Card sync is switched off in Holdr for this device or issuer.',
  'unknown-adapter': 'Unknown issuer.',
  'issuer-not-enabled': 'This issuer is not enabled (or its site permission was removed).',
  'permission-missing': 'The browser did not grant access to this issuer’s site.',
  'main-consent-required': 'This issuer needs your consent to the in-page passive observer.',
  'unknown-document': 'That page is gone. Reload the issuer’s activity page.',
  'unknown-account': 'That card is not on the page any more. Reload the activity page.',
  'unknown-binding': 'Holdr does not know that billing account (or it changed). Refresh the device status.',
  'binding-mismatch': 'That Holdr billing account belongs to another issuer or source.',
  'unknown-scope': 'That card is not part of the chosen Holdr billing account.',
  'scope-conflict': 'A card’s last four digits do not match the Holdr card you chose for it.',
  'unmapped-rows': 'Choose a Holdr card for every group of rows (exactly one each).',
  busy: 'Something else is in progress for this issuer. Finish or discard it first.',
  'no-capture': 'There is no capture to act on.',
  'capture-expired': 'The preview expired before it was sent; nothing was sent. Capture again.',
  'digest-mismatch': 'What would be sent does not match what was shown. Nothing was sent.',
  'wrong-stage': 'That step is not available now.',
  'collector-unreachable': 'The issuer page did not answer. Reload it.',
  'collector-refused': 'The issuer page could not build a valid preview.',
  'too-large': 'This capture is larger than Holdr accepts. Use file import for long histories.',
  'session-budget': 'The extension’s memory budget is full. Discard the current capture first.',
  'shape-unavailable': 'Shape capture is not available for this issuer.',
  'shape-changed': 'This issuer is paused: its site changed what it sends, and this extension release cannot read it safely. Use file import until a Holdr extension update supports the new form.',
  'rate-limited': 'The site asked to slow down. Holdr will not read this issuer again until the pause shown in settings is over.',
  stopped: 'Stopped before it finished; nothing more was sent. If Holdr may already have it, check with Holdr.',
  'holdr-incompatible': 'This Holdr does not accept the format this extension sends (payload v2, contract 1). Nothing was sent; update Holdr or the extension.',
  'holdr-rejected': 'Holdr discarded this sync; capture again or use file import.',
  'review-expired': 'Holdr’s review period for this sync ended before it was added to your spending; nothing was added. Capture again or use file import.',
  'device-replaced': 'This capture was made under an earlier pairing of this browser, so this pairing cannot act on it. Holdr keeps anything it accepted for review there, and shows whether a commit of it landed; capture again to sync from here.',
  'upload-pending': 'Holdr has nothing from this capture yet, but an upload that got no answer may still arrive. Check again later, or Close it: Holdr then stops waiting, and keeps anything that already arrived for review.',
  'commit-pending': 'A commit of this plan may still reach Holdr: its answer never came. Check with Holdr, or commit again (the same plan commits at most once). Once the plan has expired, a check settles it.',
  'device-outdated': 'The extension was updated, and Holdr accepts a browser’s credential only from the version it was paired with. The old credential was removed: pair this browser again in Settings.',
  'holdr-limited': 'Holdr is limiting how much this browser sends or plans right now (open sends, sends per day, or its review and plan quotas). Try again later; an unsent preview is kept until it expires.',
  'holdr-unavailable': 'Holdr is not taking browser requests right now (maintenance, or its secure entry is not verified). Try again later. If it was about a send or a commit, check with Holdr what it has.',
  'plan-needs-review': 'Holdr needs your decision on this sync first: review it in Holdr. Nothing was committed from here.',
  'already-sent': 'Holdr already has this capture from an earlier send, so it was not taken again. Check the sync in Holdr.',
});

export const COLLECTOR_STATE_TEXT: Readonly<Record<CollectorState, string>> = Object.freeze({
  waiting: 'waiting for the activity page',
  discovering: 'finding cards',
  reading: 'reading activity',
  observing: 'watching the page’s own responses',
  ready: 'ready',
  building: 'building a preview',
  stopped: 'stopped',
  error: 'stopped with a problem',
});

export const COLLECTOR_CODE_TEXT: Readonly<Record<CollectorCode, string>> = Object.freeze({
  'auth-required': 'the site asked you to sign in (sign in yourself)',
  'rate-limited': 'the site is limiting requests; try later',
  'read-failed': 'the read failed',
  'read-cap': 'read budget reached (partial)',
  'repeated-cursor': 'the site repeated a page (partial)',
  'empty-page': 'an empty page without an end marker (partial)',
  'unexpected-response': 'the site answered in an unexpected way; nothing from it was kept',
  'shape-changed': 'the site changed what it sends: this issuer is paused; use file import',
  'too-large': 'a response was too large',
  'answers-lost': 'answers came in while signing in faster than they could be kept; reload the page',
  timeout: 'the site did not answer in time',
  'identity-conflict': 'conflicting transaction ids; reload the page',
  'stale-stream': 'stale page data was dropped',
  'payload-refused': 'the payload did not pass validation',
  'unmapped-rows': 'some rows have no Holdr card',
  'no-rows': 'nothing read yet',
  'unknown-account': 'unknown card',
  'bridge-refused': 'refused an invalid in-page message',
  'projection-refused': 'refused rows that failed validation',
  navigation: 'you navigated; earlier rows were dropped',
  stopped: 'stopped',
  busy: 'busy',
  'bad-config': 'refused an invalid request',
});
