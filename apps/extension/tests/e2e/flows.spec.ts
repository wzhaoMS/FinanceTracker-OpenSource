/**
 * Happy paths through every mode, end to end: a real unpacked extension in
 * Chromium → fake issuer → popup mapping → exact preview → synthetic Holdr.
 */
import type { Page } from '@playwright/test';
import { PAGE_CANARIES, CANARY_PAN } from './fake/issuers.js';
import { expect, ORIGINS, test } from './support/harness.js';

async function previewText(popup: Page): Promise<string> {
  return (await popup.getByTestId('preview-json').textContent()) ?? '';
}

test('the egress gate blocks every non-loopback destination from the test browser', async ({ ext, world }) => {
  const page = await ext.context.newPage();
  const response = await page.goto('http://example.com/');
  expect(response?.status()).toBe(403);
  expect(await page.textContent('body')).toContain('denied by the E3 egress gate');
  await expect(page.goto('https://example.com/')).rejects.toThrow(/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_/);
  const worker = await ext.liveWorker();
  const fromWorker = await worker.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return 'fetched';
    } catch {
      return 'blocked';
    }
  });
  expect(fromWorker).toBe('blocked');
  expect(world.gate.leaks()).toEqual([]);
});

test('fake Chase (isolated read): discover, read on request, map, exact preview, send, plan, commit', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);

  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  const accounts = popup.getByTestId('page-fake-chase');
  await expect(accounts).toContainText('Card …3391');
  await expect(accounts).toContainText('Card …7720');
  await expect(accounts).not.toContainText('…0042');

  const sapphire = popup.locator('[data-testid^="account-cnd_"]', { hasText: 'Card …3391' });
  await sapphire.locator('[data-testid^="read-"]').click();
  await expect(sapphire).toContainText('7 posted · 1 pending · 1 not readable · 2 page(s) · partial (end-marker)');

  const binding = world.holdr.bindingFor('chase');
  await sapphire.locator('[data-testid^="binding-"]').selectOption(binding.bindingId);
  const primary = binding.scopes.find((scope) => scope.last4 === '3391')!;
  const authorized = binding.scopes.find((scope) => scope.last4 === '7720')!;
  await sapphire.locator('[data-testid$="-3391"]').selectOption(primary.cardScopeId);
  await sapphire.locator('[data-testid$="-7720"]').selectOption(authorized.cardScopeId);
  await sapphire.locator('[data-testid^="prepare-"]').click();

  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  const shown = await previewText(popup);
  const stored = await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { text: string }).text, null);
  expect(shown).toBe(stored);
  const payload = JSON.parse(shown);
  expect(payload.rows).toHaveLength(8);
  expect(payload.rejectedCount).toBe(1);
  expect(shown).toContain('***1111');
  expect(shown).not.toContain(CANARY_PAN);
  // Two identical purchases with different issuer ids stay two rows.
  expect(payload.rows.filter((row: { description: string }) => row.description === 'SYNTHETIC SNACK BAR')).toHaveLength(2);
  // Refund negative, purchase positive, payment negative.
  expect(payload.rows.find((row: { kind: string }) => row.kind === 'refund').amountMinor).toBe(-4500);
  expect(payload.rows.find((row: { kind: string }) => row.kind === 'payment').amountMinor).toBe(-150000);
  // One refused row: read to the end marker, but never claimed complete.
  expect(payload.coverage.every((entry: { completeness: string; termination: string }) => entry.completeness === 'partial' && entry.termination === 'end-marker')).toBe(true);

  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  const bodies = world.holdr.observationBodies();
  expect(bodies).toHaveLength(1);
  // The payload bytes sent are byte for byte the bytes previewed.
  expect(bodies[0].startsWith(`{"payload":${shown},"runId":"run_`)).toBe(true);
  // After the durable ACK the local copy is gone.
  const after = await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { text: string | null }).text, null);
  expect(after).toBeNull();

  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toContainText('8 new');
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();

  // Canaries never left the page; the gate saw nothing else.
  const everything = [await ext.storageDump(), ...world.holdr.requests.map((request) => request.body), ext.consoleLines.join('\n')].join('\n');
  for (const canary of PAGE_CANARIES) expect(everything).not.toContain(canary);
  expect(world.gate.leaks()).toEqual([]);
});
