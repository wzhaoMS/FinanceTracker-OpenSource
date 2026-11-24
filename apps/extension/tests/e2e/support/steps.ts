/** Small steps shared by the scenarios: open a bank page, read, map in the popup, prepare a preview. */
import type { Locator, Page } from '@playwright/test';
import type { Binding } from '../../../src/contracts/holdrApi.js';
import type { Ext, World } from './harness.js';
import { expect, ORIGINS } from './harness.js';

export async function account(popup: Page, adapterId: string, cardText: string): Promise<Locator> {
  const block = popup.getByTestId(`page-${adapterId}`).locator('[data-testid^="account-cnd_"]', { hasText: cardText });
  await expect(block).toBeVisible();
  return block;
}

/** Chooses the binding and one scope per group (by card last four, or by holder group order for name-only groups). */
export async function mapScopes(block: Locator, binding: Binding, choices: Array<{ select: string; scopeLabel: string }>): Promise<void> {
  await block.locator('[data-testid^="binding-"]').selectOption(binding.bindingId);
  for (const choice of choices) {
    const scope = binding.scopes.find((item) => item.scopeLabel === choice.scopeLabel);
    if (!scope) throw new Error(`no scope ${choice.scopeLabel}`);
    await block.locator(choice.select).selectOption(scope.cardScopeId);
  }
}

export async function prepare(block: Locator, popup: Page): Promise<string> {
  await block.locator('[data-testid^="prepare-"]').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  return (await popup.getByTestId('preview-json').textContent()) ?? '';
}

/** Pairs, enables fake Chase, opens its dashboard and reads the Sapphire account. */
export async function chaseReady(ext: Ext): Promise<{ bank: Page; popup: Page; block: Locator }> {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-chase', 'Card …3391');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('7 posted · 1 pending');
  return { bank, popup, block };
}

export async function chasePreview(ext: Ext, world: World): Promise<{ bank: Page; popup: Page; text: string }> {
  const { bank, popup, block } = await chaseReady(ext);
  await mapScopes(block, world.holdr.bindingFor('chase'), [
    { select: '[data-testid$="-3391"]', scopeLabel: 'Primary card' },
    { select: '[data-testid$="-7720"]', scopeLabel: 'Authorized user' },
  ]);
  const text = await prepare(block, popup);
  return { bank, popup, text };
}

/** Reloads a bank page and waits until the worker has discovered the new document, so no block of the old page is acted on. */
export async function reloadBank(ext: Pick<Ext, 'inExtension'>, bank: Page, adapterId: string): Promise<void> {
  const docs = () =>
    ext.inExtension(async (id) => {
      const stored = (await chrome.storage.session.get('collectors')).collectors as Array<{ adapterId: string; docRef: string; discovered: boolean; state: string }> | undefined;
      return (stored ?? []).filter((doc) => doc.adapterId === id);
    }, adapterId);
  const before = new Set((await docs()).map((doc) => doc.docRef));
  await bank.reload();
  await expect.poll(async () => (await docs()).some((doc) => !before.has(doc.docRef) && doc.discovered && doc.state === 'ready')).toBe(true);
}
