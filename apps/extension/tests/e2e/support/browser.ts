/**
 * Launching a built extension in Playwright's bundled Chromium for the e2e
 * and acceptance suites: a fresh disposable profile, the extension loaded
 * unpacked, every request through the egress gate, DNS disabled except
 * loopback, WebRTC forced through the proxy. Helpers act as the user would:
 * the extension's own pages, the browser's own site-access controls.
 */
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';

/** The run directory: one per `playwright test` invocation, shared by its workers. Kept short: Windows paths inside a Chrome profile must stay under MAX_PATH. */
export function runDirectory(repoRoot: string): string {
  const id = process.env.E3_E2E_RUN_ID;
  if (!id || !/^[0-9]{12}[a-z0-9]{2}$/.test(id)) throw new Error('E3_E2E_RUN_ID is not set by the config');
  const base = join(repoRoot, '.artifacts');
  mkdirSync(base, { recursive: true });
  // The whole .artifacts tree ignores itself, so nothing in it can be committed by accident.
  if (!existsSync(join(base, '.gitignore'))) writeFileSync(join(base, '.gitignore'), '*\n');
  const dir = join(base, 'card-sync-e2e', id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'p'), { recursive: true });
  return dir;
}

export interface ExtensionSession {
  readonly context: BrowserContext;
  readonly id: string;
  readonly consoleLines: string[];
  options(): Promise<Page>;
  popup(): Promise<Page>;
  /** Runs `fn` in a trusted extension page (same storage and permission view as the worker). */
  inExtension<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** Returns the live MV3 worker. Playwright's DevTools attachment keeps it from idling out; `stopWorker()` stops it. */
  liveWorker(): Promise<Worker>;
  /**
   * Stops the MV3 worker as the browser does (CDP `Target.closeTarget`, the method Chrome's own
   * termination-test guide uses) and resolves once Chrome reports it stopped. `restarted` resolves
   * when the next event has started a fresh instance. Do not evaluate in an earlier `Worker` handle
   * afterwards: its execution context is gone.
   */
  stopWorker(): Promise<{ restarted: Promise<void> }>;
  /** The user grants site access in the browser's own extensions page (chrome://extensions → Site access). */
  grantSite(origin: string): Promise<void>;
  /** The user removes site access in the browser's own extensions page. */
  revokeSite(origin: string): Promise<void>;
  enableIssuer(adapterId: string, origin: string, main: boolean): Promise<void>;
  storageDump(): Promise<string>;
  close(): Promise<void>;
}

export async function openExtension(options: {
  path: string;
  id: string;
  proxyPort: number;
  profileDir: string;
  extraArgs?: readonly string[];
}): Promise<ExtensionSession> {
  const { id } = options;
  rmSync(options.profileDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: 'chromium',
    headless: true,
    proxy: { server: `http://127.0.0.1:${options.proxyPort}` },
    args: [
      `--disable-extensions-except=${options.path}`,
      `--load-extension=${options.path}`,
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--force-webrtc-ip-handling-policy',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      ...(options.extraArgs ?? []),
    ],
  });
  const consoleLines: string[] = [];
  const isOurs = (item: Worker) => item.url().startsWith(`chrome-extension://${id}/`);
  if (!context.serviceWorkers().some(isOurs)) await context.waitForEvent('serviceworker', { predicate: isOurs });
  context.on('page', (page) => page.on('console', (message) => consoleLines.push(`${page.url().slice(0, 60)} ${message.type()}: ${message.text()}`)));
  const openExtensionPage = async (path: string) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/${path}`);
    return page;
  };
  let helperPage: Page | null = null;
  const inExtension = async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
    if (!helperPage || helperPage.isClosed()) helperPage = await openExtensionPage('options.html');
    return helperPage.evaluate(fn as (arg: unknown) => R | Promise<R>, arg as unknown);
  };
  const developerPrivate = async (call: 'addHostPermission' | 'removeHostPermission', origin: string) => {
    const page = await context.newPage();
    await page.goto(`chrome://extensions/?id=${id}`);
    await page.evaluate(
      async ([extensionId, method, host]) => {
        const api = (globalThis as unknown as { chrome: { developerPrivate: Record<string, (id: string, host: string) => Promise<void>> } }).chrome.developerPrivate;
        await api[method](extensionId, host);
      },
      [id, call, `${origin}/*`] as const,
    );
    await page.close();
  };
  const contains = (origin: string) => inExtension((pattern) => chrome.permissions.contains({ origins: [pattern] }), `${origin}/*`);
  const session: ExtensionSession = {
    context,
    id,
    consoleLines,
    options: () => openExtensionPage('options.html'),
    popup: () => openExtensionPage('popup.html'),
    inExtension,
    async liveWorker() {
      await inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'get-state' }), null);
      const live = context.serviceWorkers().filter(isOurs);
      return live[live.length - 1] ?? (await context.waitForEvent('serviceworker', { predicate: isOurs }));
    },
    async stopWorker() {
      const browser = context.browser();
      if (!browser) throw new Error('the persistent context has no browser handle');
      const ours = (url: string) => url.startsWith(`chrome-extension://${id}/`);
      const watcher = await context.newPage();
      const watch = await context.newCDPSession(watcher);
      let sawStopped = false;
      let onStopped!: () => void;
      let onRestarted!: () => void;
      const stopped = new Promise<void>((resolve) => (onStopped = resolve));
      const running = new Promise<void>((resolve) => (onRestarted = resolve));
      watch.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
        for (const version of versions) {
          if (!ours(version.scriptURL)) continue;
          if (version.runningStatus === 'stopped') {
            sawStopped = true;
            onStopped();
          } else if (version.runningStatus === 'running' && sawStopped) {
            onRestarted();
          }
        }
      });
      await watch.send('ServiceWorker.enable');
      const cdp = await browser.newBrowserCDPSession();
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const target = targetInfos.find((info) => info.type === 'service_worker' && ours(info.url));
        if (!target) throw new Error('the extension worker has no target');
        await cdp.send('Target.closeTarget', { targetId: target.targetId });
      } finally {
        await cdp.detach();
      }
      await stopped;
      const restarted = running.then(async () => {
        await watch.detach().catch(() => undefined);
        await watcher.close().catch(() => undefined);
      });
      return { restarted };
    },
    async grantSite(origin) {
      // Recorded as the user's own grant; it becomes active when the extension's options page requests it (no prompt then).
      await developerPrivate('addHostPermission', origin);
    },
    async revokeSite(origin) {
      await developerPrivate('removeHostPermission', origin);
      await expect.poll(() => contains(origin)).toBe(false);
    },
    async enableIssuer(adapterId, origin, main) {
      await session.grantSite(origin);
      const page = await openExtensionPage('options.html');
      await page.getByTestId(`risk-${adapterId}`).check();
      if (main) await page.getByTestId(`main-${adapterId}`).check();
      await page.getByTestId(`enable-${adapterId}`).click();
      await expect(page.getByTestId(`issuer-state-${adapterId}`)).toHaveText('Enabled');
      await page.close();
    },
    async storageDump() {
      return inExtension(async () => JSON.stringify({ session: await chrome.storage.session.get(null), local: await chrome.storage.local.get(null) }), null);
    },
    async close() {
      await context.close();
    },
  };
  return session;
}
