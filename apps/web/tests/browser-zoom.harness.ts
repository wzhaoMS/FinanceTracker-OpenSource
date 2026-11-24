import http from 'node:http';

import { expect, test } from '@playwright/test';

import { captureTiles, fitWindow, launchZoomable, ZOOM_WINDOW } from './browserZoom';
import { closeServer, listen } from './guardServers';
import { expectNoForeignTraffic, watchOrigin } from './originGuard';

/** A page 3000 CSS px tall at any width, under a fixed band 100 CSS px tall: its tiles step past the band to the end. */
const PAGE = '<!doctype html><html><head><title>Zoom probe</title></head><body style="margin:0">'
  + '<div style="position:fixed;top:0;left:0;right:0;height:100px;background:#fff">Zoom probe band</div>'
  + '<div style="height:3000px">Zoom probe</div></body></html>';

/**
 * A page 2000 CSS px tall whose band, 100 CSS px tall at 200 px, is sticky: in its place on the first screen, stuck at the
 * top on every later one. The second tile steps back by the band that grew, so nothing under it goes unshown.
 */
const STICKY_PAGE = '<!doctype html><html><head><title>Zoom probe, sticky</title></head><body style="margin:0">'
  + '<div style="height:200px">Zoom probe top</div>'
  + '<div style="position:sticky;top:0;height:100px;background:#fff">Zoom probe sticky band</div>'
  + '<div style="height:1700px">Zoom probe rest</div></body></html>';

const viewport = () => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth });

/**
 * The real browser zoom the Gold page's review captures use (tests/browserZoom.ts): headless Chromium, guarded, with
 * the test-only extension's chrome.tabs.setZoom. 200% of a 1280 px window is DPR 2 and a 640 CSS px viewport, read in
 * the page; it holds across the origin's pages; and its tiles are the whole page in device px: each 1280 x 1600, at the
 * offsets the page reached (800 CSS px a screen, less the band each covers), the last clamped to the page's end. A
 * sticky band that sticks after the first screen makes the next tile step back by it.
 */
test('chrome.tabs.setZoom zooms a headless, guarded Chromium page to 200%: DPR 2, 640 CSS px, held across loads, captured in whole tiles', async ({}, testInfo) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/sticky' ? STICKY_PAGE : PAGE);
  });
  const url = await listen(server);
  const zoomable = await launchZoomable(url);
  try {
    const guard = await watchOrigin(zoomable.context, url, { commandLine: zoomable.commandLine });
    const page = await zoomable.context.newPage();
    await guard.watch(page);
    await page.goto('/');
    await fitWindow(page);
    expect(await page.evaluate(viewport), 'the window at 100%').toEqual({ dpr: 1, innerWidth: ZOOM_WINDOW.width });
    expect(await zoomable.zoom(2)).toBe(2);
    await expect.poll(() => page.evaluate(viewport), { message: 'the window at 200%' }).toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
    await page.goto('about:blank');
    await page.goto('/');
    expect(await page.evaluate(viewport), 'the zoom kept for the origin after a reload').toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
    const { tiles, problems } = await captureTiles(page, (index) => testInfo.outputPath(`browser-zoom-probe-t${index}.png`));
    expect(problems, 'the tiles are the whole page').toEqual([]);
    expect(tiles.map((tile) => ({ requested: tile.requested, offset: tile.offset, coveredTop: tile.coveredTop, width: tile.width, height: tile.height })),
      'each tile in device px, at the offset reached, the last clamped to the end').toEqual([0, 700, 1400, 2100, 2200].map((offset, index) => ({
      requested: index === 4 ? 2800 : offset, offset, coveredTop: 100, width: ZOOM_WINDOW.width, height: ZOOM_WINDOW.height,
    })));
    expect(new Set(tiles.map((tile) => `${tile.scroller} ${tile.visible} ${tile.total} ${tile.innerWidth} ${tile.scrollWidth}`)))
      .toEqual(new Set([`window ${ZOOM_WINDOW.height / 2} 3000 ${ZOOM_WINDOW.width / 2} ${ZOOM_WINDOW.width / 2}`]));
    expect(await page.evaluate(() => window.scrollY), 'back at the top').toBe(0);
    // The sticky band: in its place at the top of the page (no band), then stuck. The second tile, asked at 800, would show
    // from 900 under the band, so it steps back to 700; the third, asked at 1400, clamps to the end at 1200.
    await page.goto('/sticky');
    expect(await page.evaluate(viewport), 'the zoom kept for the origin on another page').toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
    const sticky = await captureTiles(page, (index) => testInfo.outputPath(`browser-zoom-probe-sticky-t${index}.png`));
    expect(sticky.problems, 'the sticky page\'s tiles are the whole page').toEqual([]);
    expect(sticky.tiles.map((tile) => ({ requested: tile.requested, offset: tile.offset, coveredTop: tile.coveredTop, total: tile.total })),
      'each tile steps back by the band it shows under').toEqual([
      { requested: 0, offset: 0, coveredTop: 0, total: 2000 },
      { requested: 700, offset: 700, coveredTop: 100, total: 2000 },
      { requested: 1400, offset: 1200, coveredTop: 100, total: 2000 },
    ]);
    await expectNoForeignTraffic(guard);
  } finally {
    await zoomable.close();
    await closeServer(server)();
  }
});
