import { expect, requireHealthyApi, test, type OriginGuard, type Page } from './fixtures';

/**
 * The owner's rule: nothing reaches a third party unless the owner acts. The
 * web app loads everything from its own origin (the API too, through Vite's
 * proxy), so a page load tells no other host who uses Holdr or when.
 *
 * Every test runs under the origin guard (originGuard.ts, installed by
 * fixtures.ts), which refuses requests to another origin, switches off the
 * channels Playwright cannot watch (workers, worklets, WebRTC, WebTransport)
 * and fails the test on any of them or on a WebSocket to another origin.
 * These tests walk a session over every screen, signed out and signed in,
 * and also check what a request log cannot show: references that open
 * connections without a request (preconnect, dns-prefetch) or load only once
 * used (an @font-face or @import elsewhere), and that the self-hosted fonts
 * are the ones the text renders in, not a fallback. Plain links the owner
 * clicks may point elsewhere; following one is the owner's action.
 */

/** URLs the page refers to that would load from another origin, outside `<a href>` links. */
function foreignReferences(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found = new Set<string>();
    const check = (where: string, raw: string | null | undefined, base: string = document.baseURI) => {
      if (!raw) return;
      let url: URL;
      try {
        url = new URL(raw, base);
      } catch {
        return;
      }
      if (url.protocol === 'ws:' || url.protocol === 'wss:') url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin) {
        found.add(`${where} ${url.href}`);
      }
    };
    const cssUrls = (text: string) => Array.from(text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g), (match) => match[2]);

    for (const element of Array.from(document.querySelectorAll('*'))) {
      const tag = element.localName;
      if (tag === 'a') continue;
      for (const name of ['src', 'href', 'xlink:href', 'poster', 'data', 'action', 'formaction', 'background']) {
        check(`<${tag} ${name}>`, element.getAttribute(name));
      }
      for (const name of ['srcset', 'imagesrcset']) {
        for (const candidate of (element.getAttribute(name) ?? '').split(',')) check(`<${tag} ${name}>`, candidate.trim().split(/\s+/)[0]);
      }
      if (tag === 'meta' && element.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
        check('<meta refresh>', /url\s*=\s*['"]?([^'";\s]+)/i.exec(element.getAttribute('content') ?? '')?.[1]);
      }
      for (const raw of cssUrls(element.getAttribute('style') ?? '')) check(`<${tag} style>`, raw);
    }

    const visit = (sheet: CSSStyleSheet) => {
      const base = sheet.href ?? document.baseURI;
      check('stylesheet', sheet.href);
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        return; // another origin's sheet, already reported by its href
      }
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSImportRule) {
            check('@import', rule.href, base);
            if (rule.styleSheet) visit(rule.styleSheet);
            continue;
          }
          for (const raw of cssUrls(rule.cssText)) check(rule instanceof CSSFontFaceRule ? '@font-face' : 'css url()', raw, base);
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      walk(rules);
    };
    for (const sheet of [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]) visit(sheet);
    return [...found];
  });
}

/** The fonts that render the text directly inside the first element matching `selector`, as Chromium reports them. */
async function renderedFonts(page: Page, selector: string): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    // DirectWrite and CoreText name these same self-hosted faces differently.
    const aliases = new Map([['Geist', 'Geist-Regular'], ['Geist-Mono-Medium', 'GeistMono-Medium']]);
    return fonts.map((font) => {
      const name = font.postScriptName ?? font.familyName;
      return font.isCustomFont ? `web font ${aliases.get(name) ?? name}` : `system font ${font.familyName}`;
    });
  } finally {
    await cdp.detach();
  }
}

/** The text directly inside `selector` renders in the web font `postScriptName` (it swaps in once loaded). */
async function expectRenderedIn(page: Page, selector: string, postScriptName: string, weight: '400' | '500' | '600'): Promise<void> {
  await expect(page.locator(selector).first()).toBeVisible();
  await expect(page.locator(selector).first()).toHaveCSS('font-weight', weight);
  await expect.poll(() => renderedFonts(page, selector), { message: `${selector} renders in ${postScriptName}` })
    .toEqual([`web font ${postScriptName}`]);
}

/** After each step: nothing went to, or is set up to load from, another origin. */
async function expectOwnOriginOnly(page: Page, guard: OriginGuard, step: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  expect(guard.foreign, `${step}: requests to another origin`).toEqual([]);
  expect(await foreignReferences(page), `${step}: references to another origin`).toEqual([]);
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the sign-in screen loads only from the app\'s own origin, in the self-hosted fonts', async ({ page, originGuard }) => {
    await page.goto('/');
    await expect(page.locator('form.login-form')).toBeVisible();
    await expectRenderedIn(page, '#login-title', 'Geist-SemiBold', '600');
    await expectRenderedIn(page, '.login-lede', 'Geist-Regular', '400');
    await expectOwnOriginOnly(page, originGuard, 'the sign-in screen');
    const fonts = originGuard.requests.filter((request) => request.resourceType === 'font').map((request) => request.url);
    expect(fonts.some((url) => /\/geist-latin-[^/]*\.woff2$/.test(url)), fonts.join('\n')).toBe(true);
  });

  test('font checks reject system fallback, another web font and the wrong weight', async ({ page, originGuard }) => {
    await page.goto('/');
    await expectRenderedIn(page, '#login-title', 'Geist-SemiBold', '600');
    for (const override of [
      { family: 'Arial', weight: '600' },
      { family: '"Geist Mono"', weight: '600' },
      { family: 'Geist', weight: '400' },
    ]) {
      await page.locator('#login-title').evaluate((element, value) => {
        element.style.setProperty('font-family', value.family, 'important');
        element.style.setProperty('font-weight', value.weight, 'important');
      }, override);
      try {
        await expect(expectRenderedIn(page, '#login-title', 'Geist-SemiBold', '600'))
          .rejects.toThrow(/renders in Geist-SemiBold|toHaveCSS/);
      } finally {
        await page.locator('#login-title').evaluate((element) => {
          element.style.removeProperty('font-family');
          element.style.removeProperty('font-weight');
        });
      }
    }
    await expectRenderedIn(page, '#login-title', 'Geist-SemiBold', '600');
    await expectOwnOriginOnly(page, originGuard, 'font rejection controls');
  });
});

test('a signed-in session over both modes and every section loads only from the app\'s own origin, in the self-hosted fonts', async ({ page, request, originGuard }) => {
  await requireHealthyApi(request);
  await page.goto('/');
  await expect(page.locator('.account.combined .account-name')).toHaveText('Invested holdings');
  await expectRenderedIn(page, '.account.combined .account-name', 'Geist-SemiBold', '600');
  await expectRenderedIn(page, '.account.combined .holdings th.num', 'GeistMono-Medium', '500');
  await expectOwnOriginOnly(page, originGuard, 'Investing, Portfolio');

  const sections = page.getByRole('tablist', { name: 'Sections' });
  const openSection = async (name: string) => {
    await sections.getByRole('tab', { name, exact: true }).click();
    await expect(sections.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  };
  // Gold, set up or not: its reads are the app's own; the server alone ever fetches a metal's closes.
  await openSection('Gold');
  await expect(page.getByTestId('gold-page')).toBeVisible();
  await expect(page.getByTestId('gold-page')).toHaveAttribute('aria-busy', 'false');
  await expectOwnOriginOnly(page, originGuard, 'Investing, Gold');

  await openSection('Transactions');
  await expect(page.locator('.tx-summary')).toContainText(/Showing \d+ of \d+ transactions/);
  await expectOwnOriginOnly(page, originGuard, 'Investing, Transactions');

  await openSection('Add');
  await expect(page.getByRole('button', { name: 'Add transaction' })).toBeVisible();
  await expectOwnOriginOnly(page, originGuard, 'Investing, Add');

  await openSection('Import');
  await expect(page.getByRole('button', { name: 'Preview import' })).toBeVisible();
  await expectOwnOriginOnly(page, originGuard, 'Investing, Import');

  await openSection('Accounts');
  await expect(page.locator('.accounts-card').first()).toBeVisible();
  await expectOwnOriginOnly(page, originGuard, 'Investing, Accounts');

  // Investing's Spending entry opens Everyday, whose sections are the Spending areas.
  const modes = page.getByRole('radiogroup', { name: 'Mode' });
  await sections.getByRole('tab', { name: 'Spending', exact: true }).click();
  await expect(modes.getByRole('radio', { name: 'Everyday' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('region', { name: 'Spending', exact: true })).toBeVisible();
  const areas = page.getByRole('tablist', { name: 'Spending areas' });
  for (const area of ['Card transactions', 'Benefits', 'Amazon', 'Costco receipts', 'Sync & coverage', 'Extension & devices']) {
    const areaTab = areas.getByRole('tab', { name: new RegExp(`^${area}`) });
    await areaTab.click();
    await expect(areaTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.spending-area-panel')).toBeVisible();
    await expectOwnOriginOnly(page, originGuard, `Everyday, ${area}`);
  }

  await modes.getByRole('radio', { name: 'Investing' }).click();
  await openSection('Portfolio');
  await expect(page.locator('.account.combined .account-name')).toHaveText('Invested holdings');
  await expectOwnOriginOnly(page, originGuard, 'back in Investing');

  const fonts = originGuard.requests.filter((request) => request.resourceType === 'font').map((request) => request.url);
  expect(fonts.some((url) => /\/geist-latin-[^/]*\.woff2$/.test(url)), fonts.join('\n')).toBe(true);
  expect(fonts.some((url) => /\/geist-mono-latin-[^/]*\.woff2$/.test(url)), fonts.join('\n')).toBe(true);
  expect(originGuard.requests.filter((request) => request.resourceType === 'fetch').length).toBeGreaterThan(5);
});
