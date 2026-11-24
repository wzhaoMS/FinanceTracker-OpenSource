/**
 * E3 against E2c's device API (Casey Mac's M1–M7, handoff 10/18 07:40), end
 * to end with the fake Holdr answering as E2c does: the build version on
 * every request and a new pairing after an update (M1), capabilities only
 * from the Holdr this build is pinned to (M2), and E2c's own refusals, each
 * handled as what it means (M5). M3, M4 and M7 are covered in the unit tests
 * and delivery.spec.ts.
 */
import { EXTENSION_VERSION } from '../../build/manifest.js';
import { expect, test } from './support/harness.js';
import { chasePreview } from './support/steps.js';

const UPDATED = 'The extension was updated: Holdr needs this browser paired again. Pair again in Settings.';

test('M1: every request carries this build’s version; after an update the old credential goes before anything uses it, and the browser pairs again', async ({ ext, world }) => {
  await ext.pair();
  expect(world.holdr.requests.length).toBeGreaterThan(0);
  expect(world.holdr.requests.every((request) => request.clientVersion === EXTENSION_VERSION)).toBe(true);
  // An update: the stored pairing (and Holdr's record of it) is now from another build of this extension.
  world.holdr.setPairedVersion('0.0.9');
  await ext.inExtension(async () => {
    const { device } = await chrome.storage.session.get('device');
    await chrome.storage.session.set({ device: { ...(device as object), clientVersion: '0.0.9' } });
  }, null);
  const { restarted } = await ext.stopWorker();
  const before = world.holdr.arrivals.length;
  const popup = await ext.popup();
  await restarted;
  await expect(popup.getByTestId('device-status')).toHaveText(UPDATED);
  // Gone before anything used it: no request went out with it, so Holdr never had to refuse it.
  expect(await ext.storageDump()).not.toMatch(/hdv1_[a-p]{64}/);
  expect(world.holdr.arrivals.slice(before)).toEqual([]);
  expect(world.holdr.requests.filter((request) => request.status === 401)).toEqual([]);
  const options = await ext.options();
  await expect(options.getByTestId('pairing-outdated')).toBeVisible();
  await expect(options.getByTestId('pairing-code')).toBeVisible();
  await options.close();
  await ext.pair('E3 Test Chromium again');
  await popup.reload();
  await expect(popup.getByTestId('device-status')).toContainText('Paired as E3 Test Chromium again');
  expect(world.holdr.requests.every((request) => request.clientVersion === EXTENSION_VERSION)).toBe(true);
});

test('M2: capabilities that name another Holdr as their own are not taken: the browser stays unapproved and holds no binding until its own Holdr answers', async ({ ext, world }) => {
  world.holdr.capabilitiesOrigin = 'http://other.e3.test';
  const options = await ext.options();
  await options.getByTestId('pairing-code').fill(world.holdr.createPairing());
  await options.getByTestId('device-label').fill('E3 Test Chromium');
  await options.getByTestId('pair').click();
  await expect(options.getByTestId('fingerprint')).toBeVisible();
  world.holdr.approveAll();
  await options.getByTestId('check-approval').click();
  await expect(options.getByTestId('notice')).toHaveText('Holdr answered in an unexpected form, so the extension does not rely on that answer. If it was about a send or a commit, check with Holdr what it has.');
  await expect(options.getByTestId('pairing-status')).toContainText('Waiting for approval');
  expect(await ext.inExtension(async () => (await chrome.storage.session.get('capabilities')).capabilities ?? null, null)).toBeNull();
  world.holdr.capabilitiesOrigin = 'http://holdr.e3.test';
  await options.getByTestId('check-approval').click();
  await expect(options.getByTestId('pairing-status')).toContainText('Paired as E3 Test Chromium');
  expect(await ext.inExtension(async () => ((await chrome.storage.session.get('capabilities')).capabilities as { holdrOrigin: string }).holdrOrigin, null)).toBe('http://holdr.e3.test');
});

test('M5: D’s authorization-blocked after Holdr stored the upload is no refusal: the receipt shows it arrived, and nothing is sent twice', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  world.holdr.fault('observations', { code: 'authorization-blocked', status: 409, after: true });
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.requests.filter((request) => request.path === '/card-sync/observations').map((request) => request.status)).toEqual([409]);
  expect(world.holdr.arrivals.filter((line) => /\/receipt$/.test(line))).toHaveLength(1);
  expect(world.holdr.observations.size).toBe(1);
});

test('M5: a 500 from a commit Holdr made is no refusal: the receipt shows the ledger commit, which is not repeated', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
  world.holdr.fault('commit', { code: 'internal-error', status: 500, after: true });
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/commit')).toHaveLength(1);
  expect(world.holdr.committed.size).toBe(1);
});

test('M5: Holdr’s limit on open runs refuses the run before anything was sent: the frozen preview stays, and the same bytes go later', async ({ ext, world }) => {
  const { popup, text } = await chasePreview(ext, world);
  world.holdr.fault('create-run', { code: 'too-many-open-runs', status: 429 });
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('capture-error')).toHaveText('Holdr is limiting how much this browser sends or plans right now (open sends, sends per day, or its review and plan quotas). Try again later; an unsent preview is kept until it expires.');
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/observations')).toEqual([]);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  expect(world.holdr.observationBodies()[0].startsWith(`{"payload":${text},"runId":"run_`)).toBe(true);
});

test('M5: Holdr’s secure entry unverified (D, 503) and a refused connection (D, 403) are told apart from a refusal of the sync itself', async ({ ext, world }) => {
  await ext.pair();
  world.holdr.fault('capabilities', { code: 'ingress-unverified', status: 503 });
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'refresh-device' }), null)).toMatchObject({ ok: false, code: 'holdr-unavailable' });
  world.holdr.fault('capabilities', { code: 'device-transport-refused', status: 403 });
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'refresh-device' }), null)).toMatchObject({ ok: false, code: 'holdr-incompatible' });
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'refresh-device' }), null)).toMatchObject({ ok: true });
});
