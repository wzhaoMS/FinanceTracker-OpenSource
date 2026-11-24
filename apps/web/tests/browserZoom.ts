import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';

import { guardedBrowserArgs } from './originGuard';

/** The test-only extension (tests/browser-zoom, never shipped): its service worker lets a test call chrome.tabs.setZoom. */
const EXTENSION = fileURLToPath(new URL('./browser-zoom', import.meta.url));

/** The viewport at 100%: 1280 CSS px wide, so a 200% browser zoom leaves a 640 CSS px viewport. */
export const ZOOM_WINDOW = { width: 1280, height: 1600 } as const;

interface ChromeTabs {
  query(info: { active: boolean }): Promise<Array<{ id: number }>>;
  setZoom(tabId: number, factor: number): Promise<void>;
  getZoom(tabId: number): Promise<number>;
}

export interface Zoomable {
  context: BrowserContext;
  /** The browser's command line, read through its first tab before that closed: the origin guard checks its switches. */
  commandLine: string[];
  /** Sets the active tab's browser zoom, kept per origin (so it holds across the app's pages); returns the zoom in effect. */
  zoom(factor: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Headless Chromium for a real browser zoom: guarded like every e2e browser (guardedBrowserArgs), in a throwaway profile
 * with the test-only extension loaded, at the window's own size with no viewport emulation, so chrome.tabs.setZoom is
 * the browser's page zoom itself, not a device-pixel-ratio emulation. Extensions need a persistent context, which opens
 * with a tab: the command line is read through it, then it closes, so the origin guard is installed on a context with
 * no page (watchOrigin's `commandLine` option). It never opens a visible window.
 */
export async function launchZoomable(appUrl: string): Promise<Zoomable> {
  const profile = mkdtempSync(path.join(tmpdir(), 'holdr-e2e-zoom-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: null,
    // The e2e project's device (Desktop Chrome) fills in every option left out, and its deviceScaleFactor is refused with
    // a null viewport: named here, unset, so no device default reaches this window.
    deviceScaleFactor: undefined,
    baseURL: appUrl,
    // Larger than needed: fitWindow then shrinks it to an exact viewport (a headless screen is sized from this window).
    args: [...guardedBrowserArgs(appUrl), `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`,
      `--window-size=${ZOOM_WINDOW.width + 120},${ZOOM_WINDOW.height + 120}`],
  });
  const close = async () => {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const first = context.pages()[0] ?? await context.waitForEvent('page');
    const session = await context.newCDPSession(first);
    const { arguments: commandLine } = await session.send('Browser.getBrowserCommandLine');
    await session.detach();
    for (const page of context.pages()) await page.close();
    const zoom = (factor: number) => worker.evaluate(async (wanted) => {
      const { tabs } = (globalThis as unknown as { chrome: { tabs: ChromeTabs } }).chrome;
      const [tab] = await tabs.query({ active: true });
      await tabs.setZoom(tab.id, wanted);
      return tabs.getZoom(tab.id);
    }, factor);
    return { context, commandLine, zoom, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Sizes `page`'s window so that, at 100%, its viewport is exactly ZOOM_WINDOW: a headless window's frame takes a few px
 * of its size (18 of 1280 on Windows), so the window is grown by what the page reports missing.
 */
export async function fitWindow(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    const inner = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: (bounds.width ?? 0) + ZOOM_WINDOW.width - inner.width, height: (bounds.height ?? 0) + ZOOM_WINDOW.height - inner.height },
    });
  } finally {
    await session.detach();
  }
  await expect.poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })), { message: 'the viewport at 100%' })
    .toEqual({ width: ZOOM_WINDOW.width, height: ZOOM_WINDOW.height });
}

/** One screen of a zoomed page: what the viewport shows, in device pixels, at the scroll offset the page actually reached. */
export interface ZoomTile {
  file: string;
  /**
   * What scrolled: the window; an open modal dialog's own scroller (the page behind it doesn't move); or nothing, a modal
   * dialog that fits on one screen.
   */
  scroller: 'window' | 'dialog' | 'dialog-fits';
  /** The offset asked for and the one reached, in CSS px: the last tile stops at the end, so it may overlap the one before. */
  requested: number;
  offset: number;
  /** The scroller's visible height and its whole content's height, in CSS px. */
  visible: number;
  total: number;
  /**
   * A band at the top of the scroller that a fixed or sticky element covers, in CSS px: this tile shows the document
   * from `offset + coveredTop`, so the next tile starts that much earlier.
   */
  coveredTop: number;
  /** The page's width and its widest content, in CSS px: content past the right-hand edge makes the second larger. */
  innerWidth: number;
  scrollWidth: number;
  /** A tiled dialog's own width and its widest content, in CSS px (null for the window): the same check inside it. */
  ownWidth: number | null;
  ownScrollWidth: number | null;
  /** The PNG's size, in device px. */
  width: number;
  height: number;
}

interface TileAt {
  offset: number;
  visible: number;
  total: number;
  coveredTop: number;
  innerWidth: number;
  scrollWidth: number;
  ownWidth: number | null;
  ownScrollWidth: number | null;
}

/** The attribute that marks an open modal dialog's scroller while its tiles are taken. */
const TILED = 'data-zoom-tiles';

/**
 * Scrolls what is tiled (the marked dialog scroller, else the window) to `y`, waits for the scroll to be painted, and
 * measures what its screen shows. The covered band is any fixed or sticky element across the scroller's top edge.
 */
const measureAt = (page: Page, y: number) => page.evaluate(async ({ to, tiled }): Promise<TileAt> => {
  // The app sets no scroll-behavior, so these scrolls are instant.
  const own = document.querySelector<HTMLElement>(`[${tiled}]`);
  if (own) own.scrollTop = to;
  else window.scrollTo(0, to);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const root = document.documentElement;
  const top = own ? own.getBoundingClientRect().top + own.clientTop : 0;
  const visible = own ? own.clientHeight : window.innerHeight;
  let coveredTop = 0;
  for (const node of (own ?? document.body).querySelectorAll('*')) {
    const { position } = getComputedStyle(node);
    if (position !== 'fixed' && position !== 'sticky') continue;
    const box = node.getBoundingClientRect();
    if (box.height > 0 && box.top <= top + 0.5 && box.bottom > top && box.height < visible / 2) coveredTop = Math.max(coveredTop, box.bottom - top);
  }
  return {
    offset: own ? own.scrollTop : window.scrollY,
    visible,
    total: own ? own.scrollHeight : root.scrollHeight,
    coveredTop,
    innerWidth: window.innerWidth,
    scrollWidth: root.scrollWidth,
    ownWidth: own ? own.clientWidth : null,
    ownScrollWidth: own ? own.scrollWidth : null,
  };
}, { to: y, tiled: TILED });

/**
 * The zoomed page as its screen shows it, top to bottom, as viewport tiles in device pixels written to `file(n)`.
 *
 * A capture past the viewport lays the page out again at another width, so its right-hand side was cut (Astra's review of
 * b558ebcc). Each tile here is what the viewport itself shows. It is taken at the offset the page actually reached, and
 * each tile starts where the one before ended, less any band a fixed or sticky element covers; it steps back once if
 * that band grew since. The last one stops at the end, so the page's last content is in it. When a modal dialog is open,
 * its own scroller is tiled instead, because the page behind it doesn't move; a dialog that fits is one screen.
 *
 * `problems` is empty only when the tiles are complete evidence: they start at the top, reach the end, leave no gap, and
 * nothing reaches past the right-hand edge of the page or of a tiled dialog.
 */
export async function captureTiles(page: Page, file: (index: number) => string): Promise<{ tiles: ZoomTile[]; problems: string[] }> {
  const scroller = await page.evaluate((tiled): ZoomTile['scroller'] => {
    const scrolls = (node: Element) => /(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1;
    const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')]
      .find((node) => node.getBoundingClientRect().height > 0);
    if (!dialog) return 'window';
    // Marked either way: its own scroller, or the dialog itself when it fits, so its own width is checked too.
    const own = [dialog, ...dialog.querySelectorAll('*')].find(scrolls);
    (own ?? dialog).setAttribute(tiled, '');
    return own ? 'dialog' : 'dialog-fits';
  }, TILED);
  const session = await page.context().newCDPSession(page);
  const tiles: ZoomTile[] = [];
  try {
    let requested = 0;
    for (;;) {
      const before = tiles.length > 0 ? tiles[tiles.length - 1] : null;
      let at = await measureAt(page, requested);
      // A band that grew since the tile before (a sticky header stuck now) would hide what lies under it: step back by it.
      if (before && at.offset + at.coveredTop > before.offset + before.visible + 0.5) {
        requested = Math.max(0, before.offset + before.visible - at.coveredTop);
        at = await measureAt(page, requested);
      }
      // Scrolled no further (a page held still): the screens already captured show all it can.
      if (before && at.offset <= before.offset) break;
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(data, 'base64');
      const name = file(tiles.length + 1);
      writeFileSync(name, png);
      tiles.push({ file: path.basename(name), scroller, requested, ...at, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
      // A dialog that fits is one screen: the page behind it is not what it shows.
      if (scroller === 'dialog-fits' || at.offset + at.visible >= at.total - 1) break;
      requested = at.offset + at.visible - at.coveredTop;
    }
  } finally {
    await session.detach();
    await page.evaluate((tiled) => {
      const own = document.querySelector<HTMLElement>(`[${tiled}]`);
      if (own) {
        own.scrollTop = 0;
        own.removeAttribute(tiled);
      }
      window.scrollTo(0, 0);
    }, TILED);
  }
  return { tiles, problems: tileProblems(tiles) };
}

/**
 * Why `tiles` aren't the whole page, if they aren't: from the top, to the end, with no gap (each tile shows the document
 * from its offset plus its own covered band), and nothing past the right-hand edge of the page or of a tiled dialog.
 */
export function tileProblems(tiles: readonly ZoomTile[]): string[] {
  const problems: string[] = [];
  if (tiles.length === 0) return ['no tile was captured'];
  const first = tiles[0]!;
  const last = tiles[tiles.length - 1]!;
  if (first.offset !== 0) problems.push(`the first tile starts at ${first.offset} CSS px, not the top`);
  if (last.scroller !== 'dialog-fits' && last.offset + last.visible < last.total - 1) {
    problems.push(`the last tile ends at ${last.offset + last.visible} of ${last.total} CSS px`);
  }
  let previous: ZoomTile | null = null;
  for (const tile of tiles) {
    if (previous) {
      const shown = previous.offset + previous.visible;
      const from = tile.offset + tile.coveredTop;
      if (from > shown + 0.5) problems.push(`${tile.file} shows from ${from} CSS px, past the ${shown} the one before showed`);
    }
    if (tile.scrollWidth > tile.innerWidth) problems.push(`${tile.file}: content ${tile.scrollWidth} CSS px wide in a ${tile.innerWidth} CSS px page`);
    if (tile.ownWidth !== null && tile.ownScrollWidth !== null && tile.ownScrollWidth > tile.ownWidth) {
      problems.push(`${tile.file}: content ${tile.ownScrollWidth} CSS px wide in a ${tile.ownWidth} CSS px dialog`);
    }
    previous = tile;
  }
  return problems;
}
