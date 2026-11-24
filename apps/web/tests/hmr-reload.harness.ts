import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { expect, test as base, type Page } from '@playwright/test';
import { createServer, type InlineConfig, type Plugin, type ViteDevServer } from 'vite';

import { STATEFUL_MODULES } from '../hmrReload';
import { expectNoForeignTraffic, watchOrigin, type OriginGuard } from './originGuard';

// The web app is served by Vite's dev server, with hot module replacement, wherever Holdr runs.
// Modules holding auth, portfolio, ledger or cache state must never be hot-swapped: a change to one
// of them, or to anything they import, has to reload the page. These tests load the real app in
// Chromium and report file changes to Vite's watcher, as an edit would (no file is modified).

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const sharedEntry = path.resolve(webRoot, '../../packages/shared/src/index.ts');

/** A port the OS just handed out (Vite reads port 0 as its default 5173). */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Stands in for the API: nobody is signed in, so the app shows its sign-in form. */
async function startApi(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sign in required' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

interface Payload { type: string; updates?: Array<{ path: string; acceptedPath: string }> }
interface App { vite: ViteDevServer; url: string }

/** The running test's origin guard (guardEachTest). */
let activeGuard: OriginGuard | undefined;

/**
 * Each test's page is under the origin guard (originGuard.ts): the real app may contact only the
 * dev server it is served from. Playwright creates the page after the beforeEach hooks, so the
 * guard is installed before the context has a page, and it watches the page before its first
 * navigation.
 */
const test = base.extend({
  page: async ({ page }, use) => {
    if (!activeGuard) throw new Error('guardEachTest must install the origin guard before a test opens a page');
    await activeGuard.watch(page);
    await use(page);
  },
});

function guardEachTest(appUrl: () => string): void {
  test.beforeEach(async ({ context }) => {
    activeGuard = await watchOrigin(context, appUrl());
  });
  test.afterEach(async () => {
    const guard = activeGuard;
    activeGuard = undefined;
    if (guard) await expectNoForeignTraffic(guard);
  });
}

async function startVite(config: InlineConfig): Promise<App> {
  const port = await freePort();
  const vite = await createServer({
    root: webRoot,
    logLevel: 'silent',
    clearScreen: false,
    ...config,
    server: { ...config.server, host: '127.0.0.1', port, strictPort: true },
  });
  await vite.listen();
  return { vite, url: `http://127.0.0.1:${port}/` };
}

/** The HMR messages the page receives over Vite's WebSocket (updates and reloads). */
const received = new WeakMap<Page, Payload[]>();

function recordHmr(page: Page): void {
  const frames: Payload[] = [];
  received.set(page, frames);
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    try {
      const message = JSON.parse(payload) as Payload;
      if (message.type === 'update' || message.type === 'full-reload') frames.push(message);
    } catch {
      // Not an HMR message.
    }
  }));
}

/** Loads the app and waits until every module it starts with is in Vite's module graph. */
async function open(page: Page, url: string): Promise<void> {
  if (!received.has(page)) recordHmr(page);
  await page.goto(url);
  await expect(page.locator('form.login-form, .app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/**
 * Reports a change of `file` (relative to apps/web) to Vite's watcher, as an edit would, or runs
 * another trigger. Returns whether the page reloaded and the HMR messages it received.
 */
async function change(
  page: Page,
  app: App,
  file: string,
  trigger: () => unknown = () => app.vite.watcher.emit('change', path.resolve(webRoot, file)),
): Promise<{ page: 'reloaded' | 'hot-updated'; sent: Payload[] }> {
  const frames = received.get(page)!;
  const framesBefore = frames.length;
  await page.evaluate(() => { (window as unknown as { holdrProbe?: string }).holdrProbe = 'still here'; });
  const settled = (event: Promise<unknown>) => event.then(() => true, () => false);
  const navigated = settled(page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 15_000,
  }));
  const hotUpdated = settled(page.waitForEvent('console', {
    predicate: (message) => message.text().includes('hot updated'),
    timeout: 15_000,
  }));
  await trigger();
  expect(await Promise.race([navigated, hotUpdated]), `${file}: Vite reacted`).toBe(true);
  // A module that refuses a hot update reloads the page right after Vite fetched it, so wait for
  // any reload to start and finish, then look: a reloaded page has lost the probe.
  await page.waitForTimeout(1_000);
  await page.waitForLoadState('load');
  const probe = await page.evaluate(() => (window as unknown as { holdrProbe?: string }).holdrProbe ?? null);
  const sent = frames.slice(framesBefore);
  await open(page, page.url());
  return { page: probe === null ? 'reloaded' : 'hot-updated', sent };
}

const types = (sent: Payload[]) => sent.map((payload) => payload.type);

test.describe('the dev server never hot-swaps auth, portfolio or ledger state', () => {
  test.describe.configure({ mode: 'serial' });
  let api: Awaited<ReturnType<typeof startApi>>;
  let app: Awaited<ReturnType<typeof startVite>>;

  test.beforeAll(async () => {
    api = await startApi();
    process.env.HOLDR_API_TARGET = api.url;
    app = await startVite({ configFile: path.join(webRoot, 'vite.config.ts') });
  });

  test.afterAll(async () => {
    await app?.vite.close();
    await api?.close();
    delete process.env.HOLDR_API_TARGET;
  });

  guardEachTest(() => app.url);

  for (const file of [...STATEFUL_MODULES, 'src/services/quotes.ts', path.relative(webRoot, sharedEntry)]) {
    test(`a change to ${file} reloads the page`, async ({ page }) => {
      await open(page, app.url);
      const outcome = await change(page, app, file);
      expect(outcome.page).toBe('reloaded');
      // The server sends a full reload: the browser never fetches a new copy of the module.
      expect(types(outcome.sent)).toEqual(['full-reload']);
    });
  }

  test('a change to a component that only uses the stores is still hot-updated', async ({ page }) => {
    await open(page, app.url);
    const outcome = await change(page, app, 'src/components/LoginScreen.tsx');
    expect(outcome.page).toBe('hot-updated');
    expect(types(outcome.sent)).toEqual(['update']);
  });

  // Vite's explicit reloads skip plugin hooks (they call updateModules directly).
  for (const [entryPoint, file] of [
    ['server.reloadModule', 'src/stores/auth.ts'],
    ['server.reloadModule', 'src/services/quotes.ts'],
    ['environments.client.reloadModule', 'src/services/api.ts'],
  ] as const) {
    test(`${entryPoint} of ${file} reloads the page`, async ({ page }) => {
      await open(page, app.url);
      const outcome = await change(page, app, file, async () => {
        if (entryPoint === 'server.reloadModule') {
          await app.vite.reloadModule((await app.vite.moduleGraph.getModuleByUrl(`/${file}`))!);
        } else {
          const client = app.vite.environments.client;
          await client.reloadModule((await client.moduleGraph.getModuleByUrl(`/${file}`))!);
        }
      });
      expect(outcome.page).toBe('reloaded');
      expect(types(outcome.sent)).toEqual(['full-reload']);
    });
  }

  test('server.reloadModule of a component that only uses the stores is still hot-updated', async ({ page }) => {
    await open(page, app.url);
    const file = 'src/components/LoginScreen.tsx';
    const outcome = await change(page, app, file, async () => {
      await app.vite.reloadModule((await app.vite.moduleGraph.getModuleByUrl(`/${file}`))!);
    });
    expect(outcome.page).toBe('hot-updated');
    expect(types(outcome.sent)).toEqual(['update']);
  });

  test('an explicit reload that Vite answers with nothing still reloads the page when it reaches a stateful module', async ({ page }) => {
    await open(page, app.url);
    const client = app.vite.environments.client;
    // A module Vite has not analysed yet stops its propagation, so Vite sends no message at all.
    const unanalysed = await client.moduleGraph.ensureEntryFromUrl('/src/stores/auth.test.ts', false);
    const auth = (await client.moduleGraph.getModuleByUrl('/src/stores/auth.ts'))!;
    unanalysed.importers.add(auth);
    try {
      const outcome = await change(page, app, 'src/stores/auth.test.ts', () => client.reloadModule(unanalysed));
      expect(outcome.page).toBe('reloaded');
      expect(types(outcome.sent)).toEqual(['full-reload']);
    } finally {
      unanalysed.importers.delete(auth);
    }
  });

  test('an update message for a stateful module from any other path goes out as a full reload', async ({ page }) => {
    // What 'vite:invalidate' or any future entry point would send; the gate sits on the client channel.
    await open(page, app.url);
    const file = 'src/stores/portfolio.ts';
    const outcome = await change(page, app, file, () => {
      app.vite.environments.client.hot.send({
        type: 'update',
        updates: [{ type: 'js-update', path: `/${file}`, acceptedPath: `/${file}`, timestamp: Date.now(), explicitImportRequired: false, isWithinCircularImport: false }],
      });
    });
    expect(outcome.page).toBe('reloaded');
    expect(types(outcome.sent)).toEqual(['full-reload']);
  });
});

test.describe('without the dev-server plugin, each stateful module still reloads the page itself', () => {
  test.describe.configure({ mode: 'serial' });
  let app: Awaited<ReturnType<typeof startVite>>;

  test.beforeAll(async () => {
    // No config file: React only, no reload plugin, no API proxy.
    app = await startVite({
      configFile: false,
      plugins: [react()],
      resolve: { alias: { '@finance-tracker/shared': sharedEntry } },
    });
  });

  test.afterAll(async () => {
    await app?.vite.close();
  });

  guardEachTest(() => app.url);

  for (const [file, acceptedBy] of [
    ['src/stores/portfolio.ts', '/src/stores/portfolio.ts'],
    ['src/stores/auth.ts', '/src/stores/auth.ts'],
    ['src/services/quotes.ts', '/src/stores/portfolio.ts'],
  ]) {
    test(`a change to ${file} reloads the page`, async ({ page }) => {
      await open(page, app.url);
      const outcome = await change(page, app, file);
      // Vite offers a hot update, which the stateful module accepts only to retire itself and reload.
      expect(types(outcome.sent)).toEqual(['update']);
      expect(outcome.sent[0].updates?.map((update) => update.acceptedPath)).toEqual([acceptedBy]);
      expect(outcome.page).toBe('reloaded');
    });
  }
});

// ---- Every reload path brings the changed code --------------------------------------------------

/**
 * Serves chosen modules with a revision marker appended: an edit that exists only in memory, so
 * nothing but Vite's own invalidation can make a reloaded page see it.
 */
function revisionLoader() {
  const revisions = new Map<string, number>();
  const plugin: Plugin = {
    name: 'test-revision-loader',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0];
      const url = `/${path.relative(webRoot, file).split(path.sep).join('/')}`;
      const revision = revisions.get(url);
      if (revision === undefined) return null;
      return `${readFileSync(file, 'utf8')}\n(globalThis as unknown as { holdrRevisions?: Record<string, number> }).holdrRevisions = {\n  ...(globalThis as unknown as { holdrRevisions?: Record<string, number> }).holdrRevisions,\n  ${JSON.stringify(url)}: ${revision},\n};\n`;
    },
  };
  return { plugin, set: (url: string, revision: number) => revisions.set(url, revision) };
}

const AUTH = '/src/stores/auth.ts';
const PORTFOLIO = '/src/stores/portfolio.ts';

/** The revision of auth.ts the page is running. */
const runningRevision = (page: Page) => page.evaluate(
  (url) => (window as unknown as { holdrRevisions?: Record<string, number> }).holdrRevisions?.[url] ?? null,
  AUTH,
);

test.describe('every reload path brings the changed code to the next page load', () => {
  test.describe.configure({ mode: 'serial' });
  const loader = revisionLoader();
  let revision = 1;
  let api: Awaited<ReturnType<typeof startApi>>;
  let app: App;

  test.beforeAll(async () => {
    api = await startApi();
    process.env.HOLDR_API_TARGET = api.url;
    loader.set(AUTH, revision);
    app = await startVite({ configFile: path.join(webRoot, 'vite.config.ts'), plugins: [loader.plugin] });
  });

  test.afterAll(async () => {
    await app?.vite.close();
    await api?.close();
    delete process.env.HOLDR_API_TARGET;
  });

  guardEachTest(() => app.url);

  const clientModule = async (url: string) => (await app.vite.environments.client.moduleGraph.getModuleByUrl(url))!;
  const triggers: Record<string, (page: Page) => Promise<unknown>> = {
    'a watcher change': async () => app.vite.watcher.emit('change', path.join(webRoot, AUTH)),
    'server.reloadModule': async () => app.vite.reloadModule((await app.vite.moduleGraph.getModuleByUrl(AUTH))!),
    'environments.client.reloadModule': async () => app.vite.environments.client.reloadModule(await clientModule(AUTH)),
    // A page invalidating portfolio.ts after an update reached it: Vite re-evaluates the modules
    // importing it, auth.ts among them.
    'vite:invalidate': (page) => page.evaluate(async (url) => {
      const viteClient = '/@vite/client';
      const { createHotContext } = await import(/* @vite-ignore */ viteClient) as {
        createHotContext: (ownerPath: string) => { invalidate: (message?: string) => void };
      };
      createHotContext(url).invalidate('cannot take this update');
    }, PORTFOLIO).catch(() => undefined),
  };

  for (const [entryPoint, trigger] of Object.entries(triggers)) {
    test(`${entryPoint}: the page reloads and runs the new auth.ts`, async ({ page }) => {
      await open(page, app.url);
      if (entryPoint === 'vite:invalidate') {
        // Vite acts on an invalidation only after an update of that module (this one reloads too).
        await change(page, app, PORTFOLIO.slice(1), async () => app.vite.environments.client.reloadModule(await clientModule(PORTFOLIO)));
      }
      expect(await runningRevision(page)).toBe(revision);

      revision += 1;
      loader.set(AUTH, revision);
      const outcome = await change(page, app, AUTH.slice(1), () => trigger(page));
      expect(outcome.page).toBe('reloaded');
      expect(types(outcome.sent)).toEqual(['full-reload']);
      expect(await runningRevision(page), 'the reloaded page runs the changed code').toBe(revision);
    });
  }
});
