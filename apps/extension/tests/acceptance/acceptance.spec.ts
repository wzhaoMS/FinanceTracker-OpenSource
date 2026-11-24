/**
 * M6 acceptance (macOS only): the acceptance build of the extension (the
 * production extension id, Holdr pinned to https://holdr.test) in Chromium,
 * against Holdr's real device API (E2c) on its dist ingress behind a TLS
 * stand-in for Tailscale Serve, with fake Chase as the bank. Nothing on
 * Holdr's side is simulated: pairing, runs, uploads, plans, commits, receipts
 * and aborts are E2c's own, and the owner's steps are E2c's owner services.
 */
import type { Page } from '@playwright/test';
import { EXTENSION_VERSION } from '../../build/manifest.js';
import type { Binding } from '../../src/contracts/holdrApi.js';
import type { UiState } from '../../src/contracts/uiState.js';
import { account, mapScopes, prepare, reloadBank } from '../e2e/support/steps.js';
import { expect, HOLDR_TUNNEL, test, type AcceptanceExt } from './harness.js';

test.skip(process.platform !== 'darwin', 'E2c’s device world needs macOS (E0-I lifecycle locks)');

const CHASE = 'http://chase.e3.test';
const LABEL = 'E3 Acceptance Chromium';

interface RunView {
  runId: string;
  trigger: string;
  runState: string;
  abortReason: string | null;
  errorCode: string | null;
  payloadDigest: string | null;
  observationSetId: string | null;
  setState: string | null;
}

async function uiState(ext: AcceptanceExt): Promise<UiState> {
  return ((await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'get-state' }), null)) as { state: UiState }).state;
}

/** Reads the Sapphire account, maps both cards, prepares the exact preview; returns the previewed digest. */
async function capture(ext: AcceptanceExt, binding: Binding): Promise<{ popup: Page; text: string; digest: string }> {
  const popup = await ext.popup();
  const block = await account(popup, 'fake-chase', 'Card …3391');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('7 posted · 1 pending');
  await mapScopes(block, binding, [
    { select: '[data-testid$="-3391"]', scopeLabel: 'Primary card' },
    { select: '[data-testid$="-7720"]', scopeLabel: 'Authorized user' },
  ]);
  const text = await prepare(block, popup);
  const digest = /digest (pd1:\S+)/.exec((await popup.getByTestId('preview-digest').textContent()) ?? '')?.[1] ?? '';
  expect(digest).not.toBe('');
  return { popup, text, digest };
}

test('M6: the production-id build pairs with E2c over TLS, sends the previewed bytes, waits for owner review, commits, and aborts with its reason', async ({ ext, world }) => {
  test.setTimeout(300_000);
  const { target } = world;
  const runs = async () => (await target.call<{ runs: RunView[] }>('runs')).runs;

  // The owner creates a pairing code in Holdr; the user enters it here; the owner approves this browser (M1: redeem carries the version).
  const { code } = await target.call<{ code: string }>('createPairing');
  const options = await ext.options();
  await options.getByTestId('pairing-code').fill(code.replace(/(.{4})(?=.)/g, '$1-'));
  await options.getByTestId('device-label').fill(LABEL);
  await options.getByTestId('pair').click();
  await expect(options.getByTestId('fingerprint')).toBeVisible();
  expect(await target.call('approvePending')).toMatchObject({ approved: 1 });
  // M2: approval shows only once Holdr's capabilities name this build's pinned origin.
  await options.getByTestId('check-approval').click();
  await expect(options.getByTestId('pairing-status')).toContainText(`Paired as ${LABEL}`);
  await options.close();
  expect((await target.call<{ devices: unknown[] }>('devices')).devices).toEqual([
    { deviceId: expect.stringMatching(/^dev_[a-p]{32}$/), label: LABEL, clientVersion: EXTENSION_VERSION, status: 'active' },
  ]);
  const state = await uiState(ext);
  expect(state).toMatchObject({ target: 'acceptance', holdrOrigin: 'https://holdr.test' });
  const binding = state.bindings.find((item) => item.bindingId === target.bindingId);
  if (!binding) throw new Error(`Holdr's binding ${target.bindingId} is not offered: ${JSON.stringify(state.bindings)}`);

  await ext.enableIssuer('fake-chase', CHASE, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${CHASE}/dashboard`);

  // 1. First sync: Holdr stores exactly the previewed bytes, and (contract 1: every admission closed) answers the plan with owner review.
  const first = await capture(ext, binding);
  await first.popup.getByTestId('send').click();
  await expect(first.popup.getByTestId('accepted')).toBeVisible();
  const [run1] = await runs();
  expect(run1).toMatchObject({ trigger: 'manual', runState: 'accepted', payloadDigest: first.digest, errorCode: null, abortReason: null });
  await first.popup.getByTestId('plan').click();
  await expect(first.popup.getByTestId('owner-review')).toContainText('8 new');
  await expect(first.popup.getByTestId('commit')).toHaveCount(0);
  // The owner commits the set in Holdr; the receipt shows it here.
  expect(await target.call('ownerCommit', { runId: run1.runId })).toMatchObject({ status: 'committed' });
  await first.popup.getByTestId('check-receipt').click();
  await expect(first.popup.getByTestId('committed')).toBeVisible();
  await first.popup.getByTestId('close-capture').click();
  await first.popup.close();

  // 2. The same rows again: nothing needs a person, so Holdr gives this browser an executable plan, and the commit lands once.
  await reloadBank(ext, bank, 'fake-chase');
  const second = await capture(ext, binding);
  await second.popup.getByTestId('send').click();
  await expect(second.popup.getByTestId('accepted')).toBeVisible();
  await second.popup.getByTestId('plan').click();
  await expect(second.popup.getByTestId('plan-summary')).toContainText('0 new, 0 updated, 8 unchanged');
  await second.popup.getByTestId('commit').click();
  await expect(second.popup.getByTestId('committed')).toBeVisible();
  expect((await runs())[1]).toMatchObject({ runState: 'accepted', payloadDigest: second.digest, setState: 'committed' });
  await second.popup.getByTestId('close-capture').click();
  await second.popup.close();

  // 3. Closing an accepted capture tells Holdr why (Q4): the run keeps its observation and records the reason.
  await reloadBank(ext, bank, 'fake-chase');
  const third = await capture(ext, binding);
  await third.popup.getByTestId('send').click();
  await expect(third.popup.getByTestId('accepted')).toBeVisible();
  await third.popup.getByTestId('close-capture').click();
  await expect(third.popup.getByTestId('capture-stage')).toHaveText('Stage: discarded');
  await expect.poll(async () => (await runs())[2]).toMatchObject({ runState: 'accepted', abortReason: 'user-cancelled', payloadDigest: third.digest });
  expect(await runs()).toHaveLength(3);

  // Every call Holdr answered was a success (M1 headers, M5 bodies, no cookie), on the device routes only.
  const { requests } = await target.call<{ requests: Array<{ method: string; path: string; status: number }> }>('requests');
  expect(requests.filter((request) => request.status !== 200)).toEqual([]);
  const routes = new Set(requests.map((request) => `${request.method} ${request.path.replace(/\/run_[a-p]{32}\//, '/:runId/')}`));
  expect([...routes].sort()).toEqual([
    'GET /card-sync/capabilities',
    'GET /card-sync/runs/:runId/receipt',
    'POST /card-sync/imports/commit',
    'POST /card-sync/imports/preview',
    'POST /card-sync/observations',
    'POST /card-sync/pairings/redeem',
    'POST /card-sync/runs',
    'POST /card-sync/runs/:runId/abort',
  ]);
  // The browser reached Holdr only through the one tunnel, and nothing else.
  expect(world.gate.leaks()).toEqual([]);
  const tunnels = world.gate.ledger.filter((entry) => entry.kind === 'connect' && entry.decision === 'allow');
  expect(tunnels.length).toBeGreaterThan(0);
  expect(new Set(tunnels.map((entry) => entry.target))).toEqual(new Set([HOLDR_TUNNEL]));
});
