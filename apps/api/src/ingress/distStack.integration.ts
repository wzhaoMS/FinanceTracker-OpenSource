import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, inject, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { closeServers, rawRequest, socketFixture, TEST_ADMISSION, TEST_ORIGIN, TEST_PORT, TEST_WEB_PORT } from './fixtures.js';
import { ingressProbes } from './probeCases.js';
import { startIngressServers } from './server.js';
import { loadWebRelease, type WebRelease } from './webRelease.js';
import { DOCUMENT_CSP } from './securityHeaders.js';

const PRIVATE_CANARY = 'INGRESS_SYNTHETIC_PRIVATE_CANARY_39f1';
let release: WebRelease;
let socket: ReturnType<typeof socketFixture>;
let repo: SqliteStateRepo;
let servers: Server[];
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('synthetic ingress stack is offline'); }));
  release = loadWebRelease({ dir: inject('ingressReleaseDir'), digest: inject('ingressReleaseDigest') });
  socket = socketFixture();
  repo = new SqliteStateRepo({ file: ':memory:' });
  repo.createAccount({ id: 'canary', name: PRIVATE_CANARY, cashBalance: 0, currency: 'USD' });
  const { app, users } = createApp({
    repo, serviceToken: '34'.repeat(32), allowedOrigins: [TEST_ORIGIN], snapshotsEnabled: false,
    ingress: { mode: 'dist', release, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
  });
  users.createUser('integration-user', await hashPassword('synthetic-build-password', { ln: 10, r: 8, p: 1 }));
  const mask = process.umask(0o077);
  try {
    servers = await startIngressServers(app, [
      { mode: 'dist', listener: 'ingress', socketPath: socket.socketPath, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
      { mode: 'dist', listener: 'local', port: TEST_PORT, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
    ], { socketSafety: socket.safety });
  } finally { process.umask(mask); }
});
afterAll(async () => {
  await closeServers(servers ?? []);
  repo?.close();
  socket?.cleanup();
  vi.unstubAllGlobals();
});

it('serves the real Vite build through Express, byte-for-byte, without data or inline CSP exceptions', async () => {
  expect(release.manifest.files.some((file) => file.path.endsWith('.woff2'))).toBe(true);
  for (const file of release.manifest.files) {
    const response = await rawRequest(socket.socketPath, 'GET', '/' + file.path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(release.get('/' + file.path)!.bytes());
    expect(response.body.includes(Buffer.from(PRIVATE_CANARY))).toBe(false);
    expect(response.body.includes(Buffer.from('https://first.invalid'))).toBe(false);
    expect(response.body.includes(Buffer.from('https://second.invalid'))).toBe(false);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(file.path).not.toMatch(/\.map$|\.tsx?$|(^|\/)\./);
  }
  const root = await rawRequest(socket.socketPath, 'GET', '/');
  expect(root.body).toEqual(release.get('/index.html')!.bytes());
  expect(root.headers['content-security-policy']).toBe(DOCUMENT_CSP);
  const html = root.body.toString();
  expect(html).not.toMatch(/\sstyle\s*=|<style\b|https?:\/\/fonts\./i);
  expect(html).toContain('class="glass-filter-defs"');
});

it('passes all 87 probes on the real build with zero HTML fallbacks', async () => {
  const js = release.manifest.files.find((file) => file.path.endsWith('.js'))!.path;
  const css = release.manifest.files.find((file) => file.path.endsWith('.css'))!.path;
  const probes = ingressProbes('/' + js, '/' + css);
  expect(probes).toHaveLength(87);
  let htmlFallbacks = 0;
  for (const probe of probes) {
    const response = await rawRequest(probe.listener === 'serve' ? socket.socketPath : TEST_PORT,
      probe.method, probe.target, probe.headers);
    expect(response.status, `${probe.method} ${probe.target}`).toBe(probe.status);
    if (probe.code) expect(response.headers['x-holdr-error']).toBe(probe.code);
    if (probe.method === 'HEAD') expect(response.body.length).toBe(0);
    if (response.headers['content-type']?.startsWith('text/html')
      && (!['/', '/index.html'].includes(probe.target.split('?')[0]) || !['GET', 'HEAD'].includes(probe.method))) htmlFallbacks++;
  }
  expect(htmlFallbacks).toBe(0);
});

it('refuses additional DB/WAL/SHM, backup, source and transform paths by GET and HEAD', async () => {
  for (const target of ['/@fs', '/@vite', '/@id', '/.env.local', '/finance.db', '/finance.db-shm',
    '/apps/api/data/finance.db-wal', '/backups/db/backup.zip', '/state.json.bak', '/src/styles.css?inline',
    '/__vite_ping', '/assets/../index.html', '/assets/%2e%2e/index.html', '/@fs/%252e%252e/finance.db']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await rawRequest(socket.socketPath, method, target);
      expect([400, 404]).toContain(response.status);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['x-holdr-error']).toBeTruthy();
      expect(response.body.includes(Buffer.from(PRIVATE_CANARY))).toBe(false);
      if (method === 'HEAD') expect(response.body.length).toBe(0);
    }
  }
});

it('renders the real build signed out and in under the exact CSP, with no violations or third-party requests', async () => {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${TEST_WEB_PORT}`;
  const localApp = createApp({
    repo, serviceToken: '56'.repeat(32), allowedOrigins: [origin], snapshotsEnabled: false,
    scryptParams: { ln: 10, r: 8, p: 1 }, log: () => undefined,
    ingress: { mode: 'local', ingressPort: TEST_WEB_PORT, release, admission: TEST_ADMISSION },
  }).app;
  let localServers: Server[] = [];
  try {
    localServers = await startIngressServers(localApp, [{ mode: 'local', listener: 'ingress', port: TEST_WEB_PORT, admission: TEST_ADMISSION }]);
    const context = await browser.newContext();
    const outbound: string[] = [];
    await context.route('**/*', (route) => {
      const target = new URL(route.request().url()).origin;
      if (target !== origin) {
        outbound.push(target);
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      const state = window as Window & { ingressCspViolations?: string[] };
      state.ingressCspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        state.ingressCspViolations!.push(event.violatedDirective);
      });
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('form.login-form').waitFor({ state: 'visible' });
    expect(await page.evaluate(() => (window as Window & { ingressCspViolations?: string[] }).ingressCspViolations)).toEqual([]);
    await page.getByLabel('Username').fill('integration-user');
    await page.getByLabel('Password').fill('synthetic-build-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.user-chip').waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      await document.fonts.load('400 16px "Geist"');
      await document.fonts.load('600 16px "Geist Mono"');
      await document.fonts.ready;
    });
    expect(await page.evaluate(() => (window as Window & { ingressCspViolations?: string[] }).ingressCspViolations)).toEqual([]);
    expect(outbound).toEqual([]);
    expect(await page.evaluate(() => document.fonts.check('400 16px "Geist"') && document.fonts.check('600 16px "Geist Mono"'))).toBe(true);
  } finally {
    await browser.close();
    await closeServers(localServers);
  }
});
