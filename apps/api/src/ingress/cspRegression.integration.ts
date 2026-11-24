import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { canonicalManifest } from '@finance-tracker/shared/web-release';
import { buildManifest, sha256, verifyRelease } from '@finance-tracker/shared/web-release/files';
import { releaseFixture, TEST_WEB_PORT } from './fixtures.js';
import { DOCUMENT_CSP } from './securityHeaders.js';

const cases = [
  ['poster', '<video poster="https://not-contacted.invalid/a.png"></video>', '', 'E0I_RELEASE_HTML', 'img-src'],
  ['imagesrcset', '<link rel="preload" as="image" href="/assets/icon-123.svg" imagesrcset="https://not-contacted.invalid/a.png 1x">', '', 'E0I_RELEASE_HTML', 'img-src'],
  ['escaped import', '', String.raw`@\69mport "https://not-contacted.invalid/a.css";`, 'E0I_RELEASE_CSS', 'style-src-elem'],
  ['escaped URL', '', String.raw`body{background:u\72l(https://not-contacted.invalid/a.png)}`, 'E0I_RELEASE_CSS', 'img-src'],
] as const;

it.each(cases)('rejects %s at build/startup while unchanged browser CSP still blocks it', async (_name, html, css, code, directive) => {
  const fixture = releaseFixture();
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    const indexPath = path.join(fixture.dir, 'public/index.html');
    fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('</body>', html + '</body>'));
    fs.writeFileSync(path.join(fixture.dir, 'public/assets/app-123.css'), css);
    expect(() => buildManifest(path.join(fixture.dir, 'public'), 'a'.repeat(40))).toThrow(code);
    const contents = new Map(fixture.manifest.files.map((file) => [file.path, fs.readFileSync(path.join(fixture.dir, 'public', file.path))]));
    const manifest = canonicalManifest({
      ...fixture.manifest, files: fixture.manifest.files.map((file) => ({
        ...file, size: contents.get(file.path)!.length, sha256: sha256(contents.get(file.path)!),
      })),
    });
    fs.writeFileSync(path.join(fixture.dir, 'manifest.json'), manifest);
    expect(() => verifyRelease(fixture.dir, sha256(manifest))).toThrow(code);

    // Deliberately load the rejected fixture only inside the intercepted browser control.
    const origin = `http://127.0.0.1:${TEST_WEB_PORT}`;
    const context = await browser.newContext();
    const external: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const body = contents.get(name);
      if (!body) return route.fulfill({ status: 404, body: '' });
      const contentType = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css'
        : name.endsWith('.js') ? 'text/javascript' : 'image/svg+xml';
      return route.fulfill({ body, contentType, headers: {
        'X-Content-Type-Options': 'nosniff',
        ...(name === 'index.html' ? { 'Content-Security-Policy': DOCUMENT_CSP } : {}),
      } });
    });
    await context.addInitScript(() => {
      const state = window as Window & { cspBlocked?: string[] };
      state.cspBlocked = [];
      document.addEventListener('securitypolicyviolation', (event) => state.cspBlocked!.push(event.violatedDirective));
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => (window as Window & { cspBlocked?: string[] }).cspBlocked!.length > 0);
    expect(await page.evaluate(() => (window as Window & { cspBlocked?: string[] }).cspBlocked)).toContain(directive);
    expect(external).toEqual([]);
  } finally {
    await browser.close();
    fixture.cleanup();
  }
});
