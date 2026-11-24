/**
 * Getting the exact bytes to Holdr exactly once (plan §4.4, §6.4, §9.2):
 * Holdr offline, a lost observation ACK, a lost commit ACK, a timeout, a
 * revoked device, a forged digest, the worker stopped by the browser and
 * restarted, a pending purchase that later posts, stops during an upload
 * (with the run abort reason Holdr gets, Q4), and a set the owner rejected
 * (X13).
 */
import { EXTENSION_VERSION } from '../../build/manifest.js';
import { expect, ORIGINS, test, type Ext } from './support/harness.js';
import { account, chasePreview, mapScopes, prepare, reloadBank } from './support/steps.js';

test('Holdr offline: nothing is stored, the outcome is checked with Holdr first, the same bytes are sent once Holdr is back', async ({ ext, world }) => {
  const { popup, text } = await chasePreview(ext, world);
  world.holdr.offline = true;
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  world.holdr.offline = false;
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.observations.size).toBe(1);
  const bodies = world.holdr.observationBodies();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].startsWith(`{"payload":${text},"runId":"run_`)).toBe(true);
});

test('lost observation ACK: the receipt shows Holdr stored it, so nothing is sent twice', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'drop-after-processing');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.observations.size).toBe(1);
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations')).toHaveLength(1);
  expect(world.holdr.requests.some((request) => /\/receipt$/.test(request.path))).toBe(true);
});

test('timeout while Holdr is slow: bounded retry with the same bytes and idempotency key yields one observation set', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'delay');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible({ timeout: 30_000 });
  await popup.waitForTimeout(5_500);
  expect(world.holdr.observations.size).toBe(1);
});

test('lost commit ACK: the receipt shows the ledger commit, which is not repeated', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.fault('commit', 'drop-after-processing');
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.committed.size).toBe(1);
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/commit')).toHaveLength(1);
});

test('a revoked device: Holdr answers 401, the credential is wiped and nothing is stored', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.revokeAll();
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('notice')).toContainText('no longer accepts');
  await expect(popup.getByTestId('device-status')).toContainText('no longer accepts');
  const dump = await ext.storageDump();
  expect(dump).not.toMatch(/hdv1_[a-p]{64}/);
  expect(world.holdr.observations.size).toBe(0);
});

test('a send whose digest does not match the frozen bytes is refused and nothing leaves', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  const captureId = await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { captureId: string }).captureId, null);
  const reply = await ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'send', captureId: id, digest: `pd1:${'a'.repeat(64)}` }), captureId);
  expect(reply).toMatchObject({ ok: false, code: 'digest-mismatch' });
  expect(world.holdr.requests.filter((request) => request.path !== '/card-sync/capabilities' && request.path !== '/card-sync/pairings/redeem')).toEqual([]);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
});

test('the browser stops the worker; the frozen preview survives in session storage and is sent after the restart', async ({ ext, world }) => {
  const { popup, text } = await chasePreview(ext, world);
  await popup.close();
  const { restarted } = await ext.stopWorker();
  const reopened = await ext.popup();
  await restarted;
  await expect(reopened.getByTestId('capture-stage')).toHaveText('Stage: preview');
  expect(await reopened.getByTestId('preview-json').textContent()).toBe(text);
  await reopened.getByTestId('send').click();
  await expect(reopened.getByTestId('accepted')).toBeVisible();
  const bodies = world.holdr.observationBodies();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].startsWith(`{"payload":${text},"runId":"run_`)).toBe(true);
});

test('the worker is stopped while the observations are in flight: after the restart the outcome is checked with Holdr, never resent blindly', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'delay');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  await popup.close();
  const { restarted } = await ext.stopWorker();
  // Holdr finishes processing the request that the stopped worker can no longer read the answer to.
  await expect.poll(() => world.holdr.observations.size, { timeout: 10_000 }).toBe(1);
  const reopened = await ext.popup();
  await restarted;
  await expect(reopened.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  await reopened.getByTestId('check-receipt').click();
  await expect(reopened.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
  expect(world.holdr.observations.size).toBe(1);
});

test('pending then posted: a later capture carries the same issuer id hash as a posted row', async ({ ext, world }) => {
  const { bank, popup, text } = await chasePreview(ext, world);
  const first = JSON.parse(text);
  const pending = first.rows.find((row: { description: string }) => row.description === 'SYNTHETIC CORNER MARKET');
  expect(pending.status).toBe('pending');
  expect(pending.postedDate).toBeNull();
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('close-capture').click();
  await popup.close();

  world.issuers.controls.chasePosted = true;
  await reloadBank(ext, bank, 'fake-chase');
  const again = await ext.popup();
  const block = await account(again, 'fake-chase', 'Card …3391');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('8 posted · 0 pending');
  await mapScopes(block, world.holdr.bindingFor('chase'), [
    { select: '[data-testid$="-3391"]', scopeLabel: 'Primary card' },
    { select: '[data-testid$="-7720"]', scopeLabel: 'Authorized user' },
  ]);
  const second = JSON.parse(await prepare(block, again));
  const posted = second.rows.find((row: { description: string }) => row.description === 'SYNTHETIC CORNER MARKET');
  expect(posted.status).toBe('posted');
  expect(posted.postedDate).not.toBeNull();
  expect(posted.externalIdHash).toBe(pending.externalIdHash);
  expect(second.captureId).not.toBe(first.captureId);
});

async function storedCapture(ext: Ext): Promise<{ stage: string; text: string | null } | undefined> {
  return ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture as { stage: string; text: string | null } | undefined, null);
}

test('the kill switch between retries: no further observation is sent, the bytes go, the outcome stays checkable', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'status-503');
  world.holdr.fault('receipt', 'delay');
  await popup.getByTestId('send').click();
  // First attempt refused with 503; the worker is asking for the receipt (held 5 s) before any retry.
  await expect.poll(() => world.holdr.arrivals.filter((line) => /^GET \/card-sync\/runs\/run_[a-p]{32}\/receipt$/.test(line)).length).toBe(1);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'set-paused', on: true }), null)).toMatchObject({ ok: true });
  await expect.poll(() => storedCapture(ext)).toMatchObject({ stage: 'outcome-unknown', text: null });
  await popup.waitForTimeout(6_000);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
  expect(world.holdr.observations.size).toBe(0);
  expect(await storedCapture(ext)).toMatchObject({ stage: 'outcome-unknown', text: null });
  // While paused nothing goes to Holdr, a run abort included.
  expect(world.holdr.arrivals.filter((line) => /\/abort$/.test(line))).toEqual([]);
});

test('nothing is planned or committed while paused; after resuming the accepted observation commits', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('pause').click();
  await expect(popup.getByTestId('paused-banner')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('notice')).toContainText('Card sync is paused');
  await popup.getByTestId('resume').click();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  await popup.getByTestId('pause').click();
  await expect(popup.getByTestId('paused-banner')).toBeVisible();
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('notice')).toContainText('Card sync is paused');
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toHaveLength(0);
  await popup.getByTestId('resume').click();
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.committed.size).toBe(1);
});

test('disabling the issuer during an upload aborts it, drops the bytes and tells Holdr the user cancelled; a receipt check settles what Holdr has', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'delay');
  // Holdr finishes the observation it had already received before it handles the run abort.
  world.holdr.fault('abort', 'delay');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'disable-issuer', adapterId: 'fake-chase' }), null)).toMatchObject({ ok: true });
  expect(await storedCapture(ext)).toMatchObject({ stage: 'outcome-unknown', text: null });
  // Holdr finishes the request it had already received; nothing is sent again.
  await expect.poll(() => world.holdr.observations.size, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => world.holdr.aborts, { timeout: 10_000 }).toEqual([{ runId: expect.stringMatching(/^run_[a-p]{32}$/), reason: 'user-cancelled' }]);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  // The abort only ended the run's automatic path: the accepted observation stays for review.
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
});

test('site access removed during an upload: Holdr hears why before the late observation, refuses that, and the receipt shows nothing arrived', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'delay');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  await ext.revokeSite(ORIGINS.chase);
  await expect.poll(() => world.holdr.aborts).toEqual([{ runId: expect.stringMatching(/^run_[a-p]{32}$/), reason: 'site-permission-revoked' }]);
  // The delayed observation reaches an aborted run.
  await expect.poll(() => world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status), { timeout: 10_000 }).toEqual([409]);
  expect(world.holdr.observations.size).toBe(0);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: expired');
});

test('a site change seen during an upload pauses the contract and tells Holdr why (unknown-page-structure)', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-amex', 'Card …0003');
  await expect(block).toContainText('5 posted · 1 pending');
  await mapScopes(block, world.holdr.bindingFor('amex'), [
    { select: '[data-testid$="-0003"]', scopeLabel: 'Basic card' },
    { select: '[data-testid$="-3382"]', scopeLabel: 'Supplementary card' },
  ]);
  await prepare(block, popup);
  // Every attempt is held, so the upload is still in flight when the page shows the change.
  world.holdr.fault('observations', 'delay', 'delay', 'delay');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  world.issuers.controls.amexUnknownType = true;
  await bank.click('#refresh');
  await expect.poll(() => world.holdr.aborts).toEqual([{ runId: expect.stringMatching(/^run_[a-p]{32}$/), reason: 'unknown-page-structure' }]);
  await expect.poll(() => ext.inExtension(async () => (await chrome.scripting.getRegisteredContentScripts()).length, null)).toBe(0);
  await expect.poll(() => world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status), { timeout: 10_000 }).toEqual([409]);
  expect(world.holdr.observations.size).toBe(0);
  const options = await ext.options();
  await expect(options.getByTestId('issuer-state-fake-amex')).toContainText('Paused: the site changed what it sends');
});

test('Holdr rejects the set before a plan (the owner discarded it): Plan learns it from the receipt; nothing is planned or sent again', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  world.holdr.rejectOpenSets();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: failed');
  await expect(popup.getByTestId('capture-error')).toHaveText('Holdr discarded this sync; capture again or use file import.');
  await expect(popup.getByTestId('plan')).toHaveCount(0);
  await expect(popup.getByTestId('last-runs')).toContainText('rejected');
  expect(await storedCapture(ext)).toMatchObject({ stage: 'failed', text: null });
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/preview').map((request) => request.status)).toEqual([409]);
  // Closing it sends nothing more: the set is closed on Holdr's side.
  await popup.getByTestId('close-capture').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: discarded');
  expect(world.holdr.aborts).toEqual([]);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
});

test('Holdr rejects the set after a plan was made: the commit is refused, the receipt shows the rejection, nothing is committed', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.rejectOpenSets();
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('capture-error')).toHaveText('Holdr discarded this sync; capture again or use file import.');
  await expect(popup.getByTestId('commit')).toHaveCount(0);
  expect(world.holdr.committed.size).toBe(0);
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/commit').map((request) => request.status)).toEqual([409]);
});

test('closing an accepted capture tells Holdr the user cancelled; the observation itself stays for review', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('close-capture').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: discarded');
  expect(world.holdr.aborts).toEqual([{ runId: expect.stringMatching(/^run_[a-p]{32}$/), reason: 'user-cancelled' }]);
  expect(world.holdr.requests.filter((request) => /\/abort$/.test(request.path)).map((request) => request.body)).toEqual(['{"reason":"user-cancelled"}']);
  expect(world.holdr.observations.size).toBe(1);
});

test('M7: a lost ACK, then the owner rejects the set before the retry: the replay is acknowledged as rejected, which is final at once (no further receipt); the bytes are never offered again', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'reject-after-processing');
  world.holdr.fault('receipt', 'status-503');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('capture-error')).toHaveText('Holdr discarded this sync; capture again or use file import.');
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: failed');
  await expect(popup.getByTestId('send')).toHaveCount(0);
  expect(await storedCapture(ext)).toMatchObject({ stage: 'failed', text: null });
  // The replay of the stored upload answers the set as it is now (E2c): 200, `rejected`.
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([0, 200]);
  expect(world.holdr.arrivals.filter((line) => /\/receipt$/.test(line))).toHaveLength(1);
  expect(world.holdr.observations.size).toBe(1);
  await expect(popup.getByTestId('last-runs')).toContainText('rejected');
});

test('M7: a lost ACK, then the owner commits the set before the retry, and Holdr cannot answer receipts: the replay is acknowledged as committed, which settles the capture', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'drop-after-processing');
  world.holdr.hook('observations', () => world.holdr.ownerCommitAll());
  world.holdr.fault('receipt', 'status-503', 'status-503', 'status-503');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: committed');
  expect(await storedCapture(ext)).toMatchObject({ stage: 'committed', text: null });
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([0, 200]);
  expect(world.holdr.arrivals.filter((line) => /\/receipt$/.test(line))).toHaveLength(1);
  expect(world.holdr.committed.size).toBe(1);
});

test('a stop during the last receipt check of a send still ends it as stopped and tells Holdr why', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'status-503', 'status-503', 'status-503');
  world.holdr.fault('receipt', null, null, 'delay');
  await popup.getByTestId('send').click();
  const receipts = () => world.holdr.arrivals.filter((line) => /^GET \/card-sync\/runs\/run_[a-p]{32}\/receipt$/.test(line)).length;
  await expect.poll(receipts).toBe(3);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'disable-issuer', adapterId: 'fake-chase' }), null)).toMatchObject({ ok: true });
  await expect.poll(() => world.holdr.aborts).toEqual([{ runId: expect.stringMatching(/^run_[a-p]{32}$/), reason: 'user-cancelled' }]);
  await expect.poll(() => ext.inExtension(async () => {
    const stored = (await chrome.storage.session.get('capture')).capture as { stage: string; text: string | null; error: string | null };
    return { stage: stored.stage, text: stored.text, error: stored.error };
  }, null)).toEqual({ stage: 'outcome-unknown', text: null, error: 'stopped' });
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(3);
});

test('a plan answer that arrives after the capture was closed does not bring it back', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  const captureId = await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { captureId: string }).captureId, null);
  world.holdr.fault('plan', 'slow');
  const planned = ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'plan', captureId: id }), captureId);
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/preview').length).toBe(1);
  expect(await ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'discard', captureId: id }), captureId)).toMatchObject({ ok: true });
  expect(await planned).toMatchObject({ ok: false, code: 'wrong-stage' });
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/preview').map((request) => request.status)).toEqual([200]);
  expect(await storedCapture(ext)).toMatchObject({ stage: 'discarded', text: null });
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: discarded');
});
const SYNC_OFF = 'Card sync is switched off in Holdr for this device or issuer.';

test('E1b row 15: Holdr switches the issuer off between run creation and upload: nothing is stored, the run stays open (E2c records no refusal on it), the frozen preview stays; once the issuer is back the same bytes go on that run', async ({ ext, world }) => {
  const { popup, text } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'slow');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  world.holdr.disabledIssuers.add('chase');
  await expect(popup.getByTestId('capture-error')).toHaveText(SYNC_OFF);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  expect(await storedCapture(ext)).toMatchObject({ stage: 'preview', text });
  expect(world.holdr.observations.size).toBe(0);
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([409]);
  const runId = world.holdr.onlyRunId();
  expect(world.holdr.runState(runId)).toBe('open');
  world.holdr.disabledIssuers.clear();
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.onlyRunId()).toBe(runId);
  expect(world.holdr.runState(runId)).toBe('accepted');
  const bodies = world.holdr.observationBodies();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toBe(`{"payload":${text},"runId":"${runId}"}`);
});

test('E1b row 15: Holdr paused when Send is pressed: the run is refused, the frozen preview stays, and once Holdr resumes the same bytes go', async ({ ext, world }) => {
  const { popup, text } = await chasePreview(ext, world);
  world.holdr.paused = true;
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('capture-error')).toHaveText(SYNC_OFF);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/runs').map((request) => request.status)).toEqual([409]);
  world.holdr.paused = false;
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  const bodies = world.holdr.observationBodies();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].startsWith(`{"payload":${text},"runId":"run_`)).toBe(true);
});

test('E1b row 15: Holdr paused after acceptance refuses plan and commit too; receipt checks still answer; after it resumes the capture plans and commits', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  world.holdr.paused = true;
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('notice')).toHaveText(SYNC_OFF);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: accepted');
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.requests.filter((request) => /\/receipt$/.test(request.path)).map((request) => request.status)).toEqual([200]);
  world.holdr.paused = false;
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.paused = true;
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('notice')).toHaveText(SYNC_OFF);
  // The refused commit sends the capture back to planning against the current ledger.
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: accepted');
  expect(world.holdr.committed.size).toBe(0);
  world.holdr.paused = false;
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.committed.size).toBe(1);
});

test('E1b Q36: the device is revoked between run creation and upload: 401, the credential is wiped, the bytes go; the run expires on Holdr’s side without an abort reason', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'slow');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  world.holdr.revokeAll();
  await expect(popup.getByTestId('notice')).toContainText('no longer accepts');
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: failed');
  expect(await storedCapture(ext)).toMatchObject({ stage: 'failed', text: null });
  expect(await ext.storageDump()).not.toMatch(/hdv1_[a-p]{64}/);
  expect(world.holdr.observations.size).toBe(0);
  expect(world.holdr.aborts).toEqual([]);
  expect(world.holdr.runState(world.holdr.onlyRunId())).toBe('expired');
});

test('closing a capture while its commit retries stops further attempts but keeps the plan; the same plan commits afterwards', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await ext.inExtension(async () => {
    const stored = (await chrome.storage.session.get('capture')).capture as { captureId: string; previewId: string; planDigest: string };
    return { captureId: stored.captureId, previewId: stored.previewId, planDigest: stored.planDigest };
  }, null);
  // The first commit attempt gets 503 and its receipt check is slow: the commit is still retrying when the capture is closed.
  world.holdr.fault('commit', 'status-503');
  world.holdr.fault('receipt', 'slow');
  const committing = ext.inExtension((request) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'commit', ...request }), ids);
  await expect.poll(() => world.holdr.arrivals.filter((line) => /\/receipt$/.test(line)).length).toBe(1);
  expect(await ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'discard', captureId: id }), ids.captureId)).toMatchObject({ ok: false, code: 'stopped' });
  expect(await committing).toMatchObject({ ok: false, code: 'stopped' });
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toHaveLength(1);
  expect(await ext.inExtension(async () => {
    const stored = (await chrome.storage.session.get('capture')).capture as { stage: string; committing: boolean; error: string | null };
    return { stage: stored.stage, committing: stored.committing, error: stored.error };
  }, null)).toEqual({ stage: 'planned', committing: false, error: 'stopped' });
  // The cancel ended with that commit: the same plan commits now, and nothing of the cancel lingers.
  expect(await ext.inExtension((request) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'commit', ...request }), ids)).toMatchObject({ ok: true });
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.committed.size).toBe(1);
});

test('E1b revision 2 / Q35: the binding is re-confirmed in Holdr without re-granting this browser between run creation and upload: refused as stale, the bytes go', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'slow');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations').length).toBe(1);
  world.holdr.reconfirmBinding('chase');
  await expect(popup.getByTestId('capture-error')).toHaveText('Holdr does not know that billing account (or it changed). Refresh the device status.');
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: failed');
  expect(await storedCapture(ext)).toMatchObject({ stage: 'failed', text: null });
  expect(world.holdr.observations.size).toBe(0);
  expect(world.holdr.runState(world.holdr.onlyRunId())).toBe('refused');
});

test('the popup’s kill switch stays usable while a command waits on Holdr, and stops it', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  world.holdr.fault('plan', 'delay');
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan')).toBeDisabled();
  await expect(popup.getByTestId('pause')).toBeEnabled();
  await popup.getByTestId('pause').click();
  await expect(popup.getByTestId('paused-banner')).toBeVisible();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: accepted');
  await popup.waitForTimeout(1_000);
  expect(await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { stage: string; plan: unknown }).plan, null)).toBeNull();
});

interface StoredCapture {
  captureId: string;
  stage: string;
  text: string | null;
  error: string | null;
  committing: boolean;
  uploadUncertain: boolean;
  runId: string | null;
  observationSetId: string | null;
  previewId: string | null;
  planDigest: string | null;
  digest: string | null;
}

async function fullCapture(ext: Ext): Promise<StoredCapture> {
  return ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture as StoredCapture, null);
}

const DISCARDED = 'Holdr discarded this sync; capture again or use file import.';

test('a commit refused because the set closed stays marked as committing until its receipt settles it: nothing can replace or replan it meanwhile', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.rejectOpenSets();
  world.holdr.fault('receipt', 'hold');
  await popup.getByTestId('commit').click();
  // The commit was refused as closed; the receipt that settles it is held.
  await expect.poll(() => world.holdr.heldCount).toBe(1);
  expect(await fullCapture(ext)).toMatchObject({ stage: 'planned', committing: true });
  const { captureId } = await fullCapture(ext);
  expect(await ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'plan', captureId: id }), captureId)).toMatchObject({ ok: false, code: 'busy' });
  world.holdr.release();
  await expect(popup.getByTestId('capture-error')).toHaveText(DISCARDED);
  expect(await fullCapture(ext)).toMatchObject({ stage: 'failed', committing: false, text: null });
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/preview').map((request) => request.status)).toEqual([200]);
  expect(world.holdr.committed.size).toBe(0);
});

test('an upload whose answer never came is remembered across sends: stored late, then refused as the issuer is switched off in Holdr, it is settled from the receipt', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  // The first upload is held past the client timeout, the retries get 503, and each receipt says nothing arrived yet.
  world.holdr.fault('observations', 'hold', 'status-503', 'status-503');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown', { timeout: 15_000 });
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  expect(await fullCapture(ext)).toMatchObject({ stage: 'preview', uploadUncertain: true });
  // Holdr now processes the held upload: stored, though the extension never heard so.
  world.holdr.release();
  await expect.poll(() => world.holdr.observations.size).toBe(1);
  // The owner switches the issuer off: the next upload is refused and its run closed.
  world.holdr.disabledIssuers.add('chase');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(await fullCapture(ext)).toMatchObject({ stage: 'accepted', text: null, error: null });
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([503, 503, 200, 409]);
  expect(world.holdr.observations.size).toBe(1);
});

test('a stop while a refused retry is settled from the receipt ends the send as stopped, drops the bytes and tells Holdr why', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  // The first upload is stored but its answer is lost; Holdr then pauses, so the retry is refused (sync-paused).
  world.holdr.fault('observations', 'drop-after-processing');
  world.holdr.hook('observations', () => {
    world.holdr.paused = true;
  });
  // The first receipt fails; the one that would settle the refusal is held.
  world.holdr.fault('receipt', 'status-503', 'hold');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.heldCount).toBe(1);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'disable-issuer', adapterId: 'fake-chase' }), null)).toMatchObject({ ok: true });
  await expect.poll(() => world.holdr.aborts).toEqual([{ runId: expect.stringMatching(/^run_[a-p]{32}$/), reason: 'user-cancelled' }]);
  await expect.poll(async () => {
    const stored = await fullCapture(ext);
    return { stage: stored.stage, text: stored.text, error: stored.error };
  }).toEqual({ stage: 'outcome-unknown', text: null, error: 'stopped' });
  world.holdr.release();
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([0, 409]);
  expect(world.holdr.observations.size).toBe(1);
});

async function asOtherDevice(world: { holdr: { port: number; activeDeviceToken(): string } }): Promise<(method: 'GET' | 'POST', path: string, body?: string) => Promise<number>> {
  const token = world.holdr.activeDeviceToken();
  return async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${world.holdr.port}${path}`, {
      method,
      headers: { authorization: `HoldrDevice ${token}`, 'x-holdr-client': 'extension-v1', 'x-holdr-client-version': EXTENSION_VERSION, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body,
    });
    return response.status;
  };
}

test('forget and pair again: the new pairing never acts on the old capture’s run, and Holdr shows no device another device’s run', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await fullCapture(ext);
  // Holdr: another approved device, granted the same binding, can neither see, plan, commit nor abort this run.
  const other = await asOtherDevice(world);
  expect(await other('POST', '/card-sync/imports/preview', JSON.stringify({ runId: ids.runId, observationSetId: ids.observationSetId }))).toBe(404);
  expect(await other('POST', '/card-sync/imports/commit', JSON.stringify({ runId: ids.runId, previewId: ids.previewId, payloadDigest: ids.digest, planDigest: ids.planDigest }))).toBe(404);
  expect(await other('GET', `/card-sync/runs/${ids.runId}/receipt`)).toBe(404);
  expect(await other('POST', `/card-sync/runs/${ids.runId}/abort`, '{"reason":"user-cancelled"}')).toBe(404);
  // The user forgets this browser's credential and pairs again.
  const options = await ext.options();
  await options.getByRole('button', { name: /Forget this browser/ }).click();
  await expect(options.getByTestId('pairing-code')).toBeVisible();
  await options.close();
  await ext.pair('E3 Test Chromium again');
  const before = world.holdr.arrivals.length;
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('capture-error')).toHaveText('This capture was made under an earlier pairing of this browser, so this pairing cannot act on it. Holdr keeps anything it accepted for review there, and shows whether a commit of it landed; capture again to sync from here.');
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: failed');
  await popup.getByTestId('close-capture').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: discarded');
  expect(world.holdr.arrivals.slice(before).filter((line) => line !== 'GET /card-sync/capabilities')).toEqual([]);
  expect(world.holdr.aborts).toEqual([]);
  expect(world.holdr.observations.size).toBe(1);
  expect(world.holdr.committed.size).toBe(0);
});

test('contract 1 (E1b X24): Holdr answers the plan with owner-review: nothing to plan or commit here; once the owner commits in Holdr, a receipt check shows it', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('owner-review')).toContainText('Holdr needs your decision in Holdr: 8 item(s) to review (8 new, 0 updated, 0 unchanged).');
  await expect(popup.getByTestId('plan')).toHaveCount(0);
  await expect(popup.getByTestId('commit')).toHaveCount(0);
  expect(await fullCapture(ext)).toMatchObject({ stage: 'accepted', previewId: null, planDigest: null });
  world.holdr.ownerCommitAll();
  // The set is closed now: planning again is refused, and the receipt that settles the refusal shows the owner's commit.
  const { captureId } = await fullCapture(ext);
  expect(await ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'plan', captureId: id }), captureId)).toMatchObject({ ok: true });
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/preview').map((request) => request.status)).toEqual([200, 409]);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toEqual([]);
});

test('Close stops a retrying commit at once, even while the worker’s queue waits on a slow device check', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await fullCapture(ext);
  // The first commit attempt gets 503 and its receipt check is slow: the commit is between attempts when Close comes.
  world.holdr.fault('commit', 'status-503');
  world.holdr.fault('receipt', 'slow');
  const committing = ext.inExtension((request) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'commit', ...request }), { captureId: ids.captureId, previewId: ids.previewId, planDigest: ids.planDigest });
  await expect.poll(() => world.holdr.arrivals.filter((line) => /\/receipt$/.test(line)).length).toBe(1);
  // A device status check holds the worker's queue (its answer is held past the client timeout); Close waits behind it.
  world.holdr.fault('capabilities', 'hold');
  const refreshing = ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'refresh-device' }), null);
  await expect.poll(() => world.holdr.heldCount).toBe(1);
  const closing = ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'discard', captureId: id }), ids.captureId);
  // The slow receipt and the retry delay pass while Close still waits: no second attempt.
  await popup.waitForTimeout(2_500);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toHaveLength(1);
  world.holdr.release();
  expect(await committing).toMatchObject({ ok: false, code: 'stopped' });
  expect(await closing).toMatchObject({ ok: false, code: 'stopped' });
  await refreshing;
  expect(await fullCapture(ext)).toMatchObject({ stage: 'planned', committing: false });
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toHaveLength(1);
  expect(world.holdr.committed.size).toBe(0);
});

const UPLOAD_PENDING = 'Holdr has nothing from this capture yet, but an upload that got no answer may still arrive. Check again later, or Close it: Holdr then stops waiting, and keeps anything that already arrived for review.';

test('the kill switch stops an upload still on its way: "nothing arrived yet" keeps the capture checkable; once Holdr stores it, a check finds it', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'hold');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.heldCount).toBe(1);
  await popup.getByTestId('pause').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  await popup.getByTestId('resume').click();
  await popup.getByTestId('check-receipt').click();
  // While paused no abort went out, so Holdr's run is open: "nothing yet" settles nothing, and the user may stop waiting.
  await expect(popup.getByTestId('capture-error')).toHaveText(UPLOAD_PENDING);
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  await expect(popup.getByTestId('close-capture')).toBeVisible();
  expect(world.holdr.aborts).toEqual([]);
  world.holdr.release();
  await expect.poll(() => world.holdr.observations.size).toBe(1);
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
});

test('the owner commits the set in Holdr while this browser holds a plan: its commit is refused as closed, and the receipt shows the commit', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.ownerCommitAll();
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/imports/commit').map((request) => request.status)).toEqual([409]);
});

test('the worker stops mid-upload with the kill switch stored but not carried out: at the next start the capture stays checkable, and the late upload is found', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'hold');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.heldCount).toBe(1);
  await popup.close();
  // The pause is stored, but the worker stops before carrying it out and before the send's own cleanup.
  await ext.inExtension(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), paused: true } });
  }, null);
  const { restarted } = await ext.stopWorker();
  const reopened = await ext.popup();
  await restarted;
  await expect(reopened.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown');
  expect(await fullCapture(ext)).toMatchObject({ stage: 'outcome-unknown', text: null, uploadUncertain: true });
  await reopened.getByTestId('resume').click();
  await reopened.getByTestId('check-receipt').click();
  await expect(reopened.getByTestId('capture-error')).toHaveText(UPLOAD_PENDING);
  world.holdr.release();
  await expect.poll(() => world.holdr.observations.size).toBe(1);
  await reopened.getByTestId('check-receipt').click();
  await expect(reopened.getByTestId('accepted')).toBeVisible();
});

test('a "nothing arrived" answer asked for before Holdr confirmed the run closed stays inconclusive, even if the confirmation lands first', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'hold');
  world.holdr.fault('abort', 'hold');
  world.holdr.fault('receipt', 'hold-reply');
  await popup.getByTestId('send').click();
  await expect.poll(() => world.holdr.heldOf('observations')).toBe(1);
  // Disabling stops the upload; the run abort that follows is held.
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'disable-issuer', adapterId: 'fake-chase' }), null)).toMatchObject({ ok: true });
  await expect.poll(() => world.holdr.heldOf('abort')).toBe(1);
  const { captureId } = await fullCapture(ext);
  // A receipt check now: Holdr answers "nothing arrived", but the answer is held.
  const checking = ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'check-receipt', captureId: id }), captureId);
  await expect.poll(() => world.holdr.heldOf('receipt')).toBe(1);
  // The upload is stored, then the abort (which keeps it) is acknowledged; only then does the old answer arrive.
  world.holdr.release('observations');
  await expect.poll(() => world.holdr.observations.size).toBe(1);
  world.holdr.release('abort');
  await expect.poll(async () => ((await fullCapture(ext)) as unknown as { runClosed: boolean }).runClosed).toBe(true);
  world.holdr.release('receipt');
  expect(await checking).toMatchObject({ ok: true });
  expect(await fullCapture(ext)).toMatchObject({ stage: 'outcome-unknown', error: 'upload-pending' });
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
});

test('a final answer reaches a preview that another receipt check restored: the rejected bytes are never offered or sent again', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  // The first upload is held past the client timeout and the retries get 503: the outcome is unknown, the bytes kept.
  world.holdr.fault('observations', 'hold', 'status-503', 'status-503');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: outcome-unknown', { timeout: 15_000 });
  const { captureId } = await fullCapture(ext);
  const check = () => ext.inExtension((id) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'check-receipt', captureId: id }), captureId);
  // Two checks at once: the first is answered now ("nothing arrived", answer held), the second is held unprocessed.
  world.holdr.fault('receipt', 'hold-reply', 'hold');
  const first = check();
  await expect.poll(() => world.holdr.heldOf('receipt')).toBe(1);
  const second = check();
  await expect.poll(() => world.holdr.heldOf('receipt')).toBe(2);
  world.holdr.releaseOne('receipt');
  expect(await first).toMatchObject({ ok: true });
  expect((await fullCapture(ext)).stage).toBe('preview');
  // The upload is stored late, and the owner discards it.
  world.holdr.release('observations');
  await expect.poll(() => world.holdr.observations.size).toBe(1);
  world.holdr.rejectOpenSets();
  world.holdr.releaseOne('receipt');
  expect(await second).toMatchObject({ ok: true });
  await expect(popup.getByTestId('capture-error')).toHaveText(DISCARDED);
  await expect(popup.getByTestId('send')).toHaveCount(0);
  expect(await fullCapture(ext)).toMatchObject({ stage: 'failed', text: null });
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(3);
});

test('the popup’s own Close stays usable while its commit retries, and stops it', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.fault('commit', 'status-503');
  world.holdr.fault('receipt', 'slow');
  await popup.getByTestId('commit').click();
  await expect.poll(() => world.holdr.arrivals.filter((line) => /\/receipt$/.test(line)).length).toBe(1);
  await expect(popup.getByTestId('close-capture')).toBeEnabled();
  await popup.getByTestId('close-capture').click();
  await expect(popup.getByTestId('notice')).toHaveText('Stopped before it finished; nothing more was sent. If Holdr may already have it, check with Holdr.');
  await popup.waitForTimeout(1_500);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toHaveLength(1);
  expect(await fullCapture(ext)).toMatchObject({ stage: 'planned', committing: false });
});

test('commit answers that never came keep the plan pinned: no new capture, re-plan or Close until Holdr settles it; the late commit is then found', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await fullCapture(ext);
  // Every commit attempt is held past the client timeout; the receipts in between show nothing committed yet.
  world.holdr.fault('commit', 'hold', 'hold', 'hold');
  const command = (body: Record<string, unknown>) => ext.inExtension((message) => chrome.runtime.sendMessage({ type: 'ui-command/v1', ...message }), body);
  expect(await command({ command: 'commit', captureId: ids.captureId, previewId: ids.previewId, planDigest: ids.planDigest })).toMatchObject({ ok: false, code: 'holdr-unreachable' });
  expect(await ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture, null)).toMatchObject({ stage: 'planned', committing: false, commitUncertain: true });
  // Nothing may hide whether one of them lands: no other capture, no new plan, no Close.
  const stored = (await ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture, null)) as { docRef: string; accountRef: string; bindingId: string; scopes: unknown[] };
  expect(await command({ command: 'prepare', docRef: stored.docRef, accountRef: stored.accountRef, bindingId: stored.bindingId, scopes: stored.scopes })).toMatchObject({ ok: false, code: 'busy' });
  expect(await command({ command: 'plan', captureId: ids.captureId })).toMatchObject({ ok: false, code: 'busy' });
  expect(await command({ command: 'discard', captureId: ids.captureId })).toMatchObject({ ok: false, code: 'commit-pending' });
  await expect(popup.getByTestId('commit-pending')).toBeVisible();
  await expect(popup.getByTestId('close-capture')).toHaveCount(0);
  // Holdr now processes the held attempts: the first commits the plan, the others replay it.
  world.holdr.release('commit');
  await expect.poll(() => world.holdr.committed.size).toBe(1);
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
});

test('an upload answered with a success the contract does not allow is an unknown outcome: the receipt shows Holdr stored it', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'garble');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.observations.size).toBe(1);
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([200]);
  expect(world.holdr.arrivals.filter((line) => /\/receipt$/.test(line))).toHaveLength(1);
});

test('an upload answered with a success that contradicts it (other bytes) is an unknown outcome: the receipt shows what Holdr stored', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', 'contradict');
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.observations.size).toBe(1);
  expect(world.holdr.arrivals.filter((line) => /\/receipt$/.test(line))).toHaveLength(1);
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toHaveLength(1);
});

test('a commit that may still land keeps its credential: forgetting or re-pairing is refused while it could settle it; once Holdr revokes it, a new pairing ends the old capture', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await fullCapture(ext);
  const command = (body: Record<string, unknown>) => ext.inExtension((message) => chrome.runtime.sendMessage({ type: 'ui-command/v1', ...message }), body);
  world.holdr.fault('commit', 'hold', 'hold', 'hold');
  expect(await command({ command: 'commit', captureId: ids.captureId, previewId: ids.previewId, planDigest: ids.planDigest })).toMatchObject({ ok: false, code: 'holdr-unreachable' });
  expect(await command({ command: 'forget-device' })).toMatchObject({ ok: false, code: 'commit-pending' });
  expect(await command({ command: 'pair', pairingCode: world.holdr.createPairing(), deviceLabel: 'Second' })).toMatchObject({ ok: false, code: 'commit-pending' });
  // Holdr revokes the credential: it settles nothing any more, so a new pairing may replace it.
  world.holdr.revokeAll();
  expect(await command({ command: 'check-receipt', captureId: ids.captureId })).toMatchObject({ ok: false, code: 'device-revoked' });
  await ext.pair('E3 Test Chromium again');
  expect(await command({ command: 'check-receipt', captureId: ids.captureId })).toMatchObject({ ok: false, code: 'device-replaced' });
  expect(await fullCapture(ext)).toMatchObject({ stage: 'failed', error: 'device-replaced', commitUncertain: false });
  // Nothing is pinned any more: the worker takes a new capture (the page itself may want a fresh read first).
  const stored = (await ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture, null)) as { docRef: string; accountRef: string; bindingId: string; scopes: unknown[] };
  const prepared = (await command({ command: 'prepare', docRef: stored.docRef, accountRef: stored.accountRef, bindingId: stored.bindingId, scopes: stored.scopes })) as { ok: boolean; code?: string };
  expect(prepared.code).not.toBe('busy');
  expect(await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { captureId: string }).captureId, null)).not.toBe(ids.captureId);
  world.holdr.release('commit');
});

test('E1b revision 4: a credential that lapses after its 30 days keeps its accepted set open for the owner’s review; the browser asks to pair again', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  const { runId } = await fullCapture(ext);
  world.holdr.expireAll();
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('device-status')).toContainText('no longer accepts');
  expect(await ext.storageDump()).not.toMatch(/hdv1_[a-p]{64}/);
  expect(world.holdr.setState(runId!)).toBe('accepted-uncommitted');
});

test('E1b revision 4: revoking the credential instead suspends its unprocessed set for the owner (a device would see needs-review)', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  const { runId } = await fullCapture(ext);
  world.holdr.revokeAll();
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('device-status')).toContainText('no longer accepts');
  expect(world.holdr.setState(runId!)).toBe('suspended');
});

test('a Forget queued before a commit takes its marker wins: the commit is refused before anything goes out, never sent with the forgotten credential', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await fullCapture(ext);
  const command = (body: Record<string, unknown>) => ext.inExtension((message) => chrome.runtime.sendMessage({ type: 'ui-command/v1', ...message }), body);
  // A device status check holds the worker's queue; Forget queues behind it, then the commit arrives.
  world.holdr.fault('capabilities', 'hold');
  const refreshing = command({ command: 'refresh-device' });
  await expect.poll(() => world.holdr.heldCount).toBe(1);
  const forgetting = command({ command: 'forget-device' });
  await popup.waitForTimeout(200);
  const committing = command({ command: 'commit', captureId: ids.captureId, previewId: ids.previewId, planDigest: ids.planDigest });
  expect(await forgetting).toMatchObject({ ok: true });
  expect(await committing).toMatchObject({ ok: false, code: 'not-paired' });
  await refreshing;
  world.holdr.release();
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toEqual([]);
  expect(await fullCapture(ext)).toMatchObject({ stage: 'planned', committing: false, commitUncertain: false });
});

test('a receipt asked for before the pinned plan expired settles nothing, even when its answer arrives after the expiry: the late commit is then found', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  world.holdr.planTtlMs = 8_000;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  const ids = await fullCapture(ext);
  const command = (body: Record<string, unknown>) => ext.inExtension((message) => chrome.runtime.sendMessage({ type: 'ui-command/v1', ...message }), body);
  // The first commit attempt is held (its answer never comes), the retries get 503: the plan stays pinned.
  world.holdr.fault('commit', 'hold', 'status-503', 'status-503');
  expect(await command({ command: 'commit', captureId: ids.captureId, previewId: ids.previewId, planDigest: ids.planDigest })).toMatchObject({ ok: false, code: 'holdr-unreachable' });
  const pinned = (await ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture, null)) as { commitUncertain: boolean; plan: { expiresAt: string } };
  expect(pinned.commitUncertain).toBe(true);
  const expiry = Date.parse(pinned.plan.expiresAt);
  // Shortly before the plan expires, a check: Holdr answers "not committed yet", but the answer is held.
  await popup.waitForTimeout(Math.max(0, expiry - 1_200 - Date.now()));
  world.holdr.fault('receipt', 'hold-reply');
  const checking = command({ command: 'check-receipt', captureId: ids.captureId });
  await expect.poll(() => world.holdr.heldOf('receipt'), { intervals: [50] }).toBe(1);
  // The held commit lands while the plan is still valid.
  world.holdr.release('commit');
  await expect.poll(() => world.holdr.committed.size, { intervals: [50] }).toBe(1);
  // The old answer arrives only once the plan has expired (plus this build's clock margin of 1 s).
  await popup.waitForTimeout(Math.max(0, expiry + 1_300 - Date.now()));
  world.holdr.release('receipt');
  expect(await checking).toMatchObject({ ok: true });
  expect(await ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture, null)).toMatchObject({ stage: 'planned', commitUncertain: true, error: 'commit-pending' });
  // A fresh check finds the commit.
  await popup.getByTestId('check-receipt').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
});