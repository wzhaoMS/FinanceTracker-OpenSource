import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import type { MetalsOverview } from '@finance-tracker/shared/metals-api';
import type { BrowserContext } from '@playwright/test';

import {
  answeredFor,
  closesFixture,
  complete,
  overviewFixture,
  oz,
  priceMissingAnswer,
  purchaseFixture,
  saleFixture,
  timelineFixture,
} from '../src/components/gold/goldFixtures';
import { AUTH_STATE_FILE } from './authState';
import { captureTiles, fitWindow, launchZoomable, ZOOM_WINDOW } from './browserZoom';
import { expect, requireHealthyApi, test, type Page, type Route } from './fixtures';
import { expectNoForeignTraffic, watchOrigin } from './originGuard';

/**
 * OPT-IN, and for Astra's visual review of dormant rendering only: the totals' complete states, which the page as shipped
 * can't reach until G3's PR-E serves its coverage proof (GoldPage's `proof` stays null). The Gold lead approved this
 * (2026-11-10) on these conditions, and Astra bound it:
 *
 * - It runs only with HOLDR_GOLD_PROOF_CAPTURE=1, as its own run in the Gold SOLO. Its rewrite is this file's own page
 *   route, so gold.e2e.ts and readability.e2e.ts never load the rewritten module. Their guard: complete figures there still
 *   give no profit or loss.
 * - It fails closed. GoldPage's served module must hold exactly one `const proof = null;`. Otherwise the module isn't
 *   served, no page loads, and the run fails.
 * - Every capture is named `totals-proven-*` and shows the label in view. The run's manifest records:
 *   - each injection, with its one-line diff and the module's sha256 before and after;
 *   - every module text, by its sha256;
 *   - each state's proof, as G3's card cross-check design v3 §6.7 would map onto the page's seam;
 *   - every read as served.
 *   Synthetic only: values on and off.
 * - A PASS here clears no served coverage, calculation or PR-E integration. PR-E deletes this file and re-captures these
 *   states from the served proof.
 */

const FLAG = process.env.HOLDR_GOLD_PROOF_CAPTURE === '1';
test.skip(!FLAG, 'opt-in: the proof-injected review captures run only with HOLDR_GOLD_PROOF_CAPTURE=1');

/** The label every capture shows (Astra's binding), verbatim. */
const LABEL = 'proof injected for the test; unreachable until PR-E';
const MODULE = '/src/components/gold/GoldPage.tsx';
const NULL_PROOF_TEXT = 'const proof = null;';
/** The null proof as Vite serves it (esbuild prints `const proof = null;`), matched with any spacing on its one line, and only once. */
const NULL_PROOF = /\bconst[ \t]+proof[ \t]*=[ \t]*null[ \t]*;/g;
/** A response's transport headers, never replayed onto the rewritten module. */
const TRANSPORT_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'etag'];

/**
 * The proofs injected, in the page's GoldCoverageProof seam, each as G3's v3 §6.7 would map onto it for one metal. In
 * both, the household `asOfScope` is complete. The metal's own sales scope is complete when it has sold (states 1 and
 * 2), or `no-sales` when it never has (state 3). The page passes one proof to every metal, so each state's metals share
 * their sales state.
 */
const PROOF_SOLD = { sales: { state: 'complete', gaps: [] }, asOf: { state: 'complete', gaps: [] } } as const;
const PROOF_UNSOLD = { sales: { state: 'no-sales', gaps: [] }, asOf: { state: 'complete', gaps: [] } } as const;
/** The states Astra's R5 names (the period with no sale; "Prices off" under the gain): each also cropped to its summary. */
const CROPPED = new Set(['totals-proven-sales-only', 'totals-proven-no-sales-combined']);
type InjectedProof = typeof PROOF_SOLD | typeof PROOF_UNSOLD;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface Injection {
  state: string;
  url: string;
  matches: number;
  line: number | null;
  before: string;
  after: string;
  originalSha256: string;
  patchedSha256: string | null;
  /** The one line changed, as a unified diff; null when nothing was served. */
  diff: string | null;
}

/**
 * Serves GoldPage's module with its null proof replaced by `proof`, only on this page and only with the flag. The module
 * must hold exactly one null proof. Otherwise nothing is served for it and no page loads. Every module text served or
 * read is kept in `modules`, by its sha256.
 */
async function injectProof(page: Page, state: string, proof: InjectedProof, injections: Injection[], modules: Map<string, string>): Promise<void> {
  if (!FLAG) throw new Error('the proof injection runs only with HOLDR_GOLD_PROOF_CAPTURE=1');
  const injected = `const proof = ${JSON.stringify(proof)};`;
  await page.route((url) => url.pathname === MODULE, async (route: Route) => {
    // Never a 304 with no body (a module cached from an earlier load): the whole module, every time.
    const asked = { ...route.request().headers() };
    delete asked['if-none-match'];
    delete asked['if-modified-since'];
    const response = await route.fetch({ headers: asked });
    const original = await response.text();
    const found = [...original.matchAll(NULL_PROOF)];
    const match = found.length === 1 ? found[0]! : null;
    const at = match === null ? null : match.index!;
    const matched = match === null ? NULL_PROOF_TEXT : match[0];
    const patched = at === null ? null : `${original.slice(0, at)}${injected}${original.slice(at + matched.length)}`;
    const line = at === null ? null : original.slice(0, at).split('\n').length;
    const originalSha256 = sha256(original);
    const patchedSha256 = patched === null ? null : sha256(patched);
    modules.set(originalSha256, original);
    if (patched !== null && patchedSha256 !== null) modules.set(patchedSha256, patched);
    injections.push({
      state,
      url: route.request().url(),
      matches: found.length,
      line,
      before: matched,
      after: injected,
      originalSha256,
      patchedSha256,
      diff: line === null ? null : [
        `--- ${MODULE} as Vite served it (sha256 ${originalSha256})`,
        `+++ ${MODULE} as injected for the test (sha256 ${patchedSha256})`,
        `@@ -${line} +${line} @@`,
        `-${matched}`,
        `+${injected}`,
        '',
      ].join('\n'),
    });
    if (patched === null) {
      await route.abort();
      return;
    }
    const headers = { ...response.headers() };
    for (const name of TRANSPORT_HEADERS) delete headers[name];
    // The rewritten module is never kept by the browser: the next load asks for it again.
    headers['cache-control'] = 'no-store';
    await route.fulfill({ status: response.status(), headers, body: patched });
  });
}

type Metal = 'XAU' | 'XAG';
const BOTH_SOLD = [{ metal: 'XAU' as const, lots: 3, sales: 1 }, { metal: 'XAG' as const, lots: 3, sales: 1 }];

/** A metal's all-time overview: the fixture's complete figures, values off (as Holdr ships) or shown at a fresh close. */
function overview(metal: Metal, values: 'off' | 'on'): MetalsOverview {
  const base = overviewFixture({ metal, metals: BOTH_SOLD });
  return values === 'off' ? { ...base, price: { ...base.price, fetching: false } } : base;
}

/** The same, with nothing ever sold: every unit bought still held. */
function unsold(metal: Metal): MetalsOverview {
  const base = overview(metal, 'off');
  const held = { troyOz: complete(oz('3/1', '3.000')), costMinor: complete(600_000), valueMinor: complete(795_120), gainMinor: complete(195_120) };
  const units = { ...base.holdings.units, delivered: 3, sold: 0, soldFromDelivered: 0, held: 3 };
  return {
    ...base,
    metals: [{ metal: 'XAU', lots: 3, sales: 0 }, { metal: 'XAG', lots: 3, sales: 0 }],
    holdings: {
      ...base.holdings,
      ...held,
      units,
      classes: base.holdings.classes.map((item) => ({ ...item, ...held, units: { ...item.units, sold: 0, soldFromDelivered: 0, held: 3 } })),
      bySource: base.holdings.bySource.map((item) => ({ ...item, units: 3, troyOz: held.troyOz, costMinor: held.costMinor, valueMinor: held.valueMinor })),
    },
    activity: {
      ...base.activity,
      sold: {
        lines: 0, units: 0, troyOz: complete(oz('0/1', '0.000')), grossMinor: complete(0), feesMinor: complete(0), netMinor: complete(0),
        unmatched: { units: 0, netMinor: 0, reasons: [] },
      },
      profit: { valueMinor: complete(0), coverage: { basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('0/1', '0.000'), unknownContentLines: 0 } },
      payouts: { count: 0, amountMinor: complete(0), mixedMetal: { count: 0, amountMinor: complete(0) } },
    },
  };
}

/** Values shown: the closes read ends at the overview's own close, the purchases read has nothing cancelled or returned. */
function valuesOn(path: string, metal: Metal): unknown {
  if (path === '/metals/overview') return overview(metal, 'on');
  if (path === '/metals/purchases') return { installed: true, metal, from: null, to: '2026-11-08', purchases: [purchaseFixture()] };
  if (path === '/metals/sales') return { installed: true, metal, from: null, to: '2026-11-08', sales: [saleFixture()] };
  if (path === '/metals/timeline') return { ...timelineFixture(), metal };
  if (path === '/metals/closes') {
    const read = closesFixture('2026-05-01', '2026-11-06');
    return { ...read, metal, closes: [...read.closes.slice(0, -1), { date: '2026-11-06', close: '2650.4' }] };
  }
  return priceMissingAnswer(path, true);
}

/** A read as a Holdr with no close stored answers it (priceMissingAnswer), for the metal asked. */
function priceMissing(path: string, metal: Metal): unknown {
  const read = priceMissingAnswer(path);
  return typeof read === 'object' && read !== null && 'metal' in read ? { ...read, metal } : read;
}

/** Nothing ever sold, in either metal: the overview says so, and the sales read is empty. */
function unsoldAnswer(path: string, metal: Metal): unknown {
  if (path === '/metals/overview') return unsold(metal);
  if (path === '/metals/sales') return { installed: true, metal, from: null, to: '2026-11-08', sales: [] };
  return priceMissing(path, metal);
}

interface ProvenState {
  name: string;
  title: string;
  /** The proof injected for this state: every metal in it has sold, or none has. */
  proof: InjectedProof;
  answer: (path: string, metal: Metal) => unknown;
  /** The totals' result as the proof makes it: the injection's own check. */
  kind: 'sales' | 'estimate';
  expectations: (page: Page) => Promise<void>;
}

const STATES: ProvenState[] = [
  {
    name: 'totals-proven-sales-only',
    title: 'values off (as Holdr ships): the profit or loss on recorded sales, its basis and method',
    proof: PROOF_SOLD,
    answer: (path, metal) => (path === '/metals/overview' ? overview(metal, 'off') : priceMissing(path, metal)),
    kind: 'sales',
    expectations: async (page) => {
      const result = page.getByTestId('gold-totals-result');
      await expect(result.locator('.gold-result-label')).toHaveText('Profit or loss on recorded sales, before rewards');
      await expect(result).toContainText('Sale proceeds minus the cost assigned to those sales.');
      await expect(result).toContainText('Holdings are not valued while prices are off; their gain or loss is not included.');
      await expect(result).toContainText('Before rewards');
      // Values off: the holdings' gain reads "Prices off" in neutral text, never coloured by the hidden value (Astra's R5).
      await expectNeutralPricesOff(page);
    },
  },
  {
    name: 'totals-proven-holdings',
    title: 'values shown at a dated close: the profit or loss including what is still held',
    proof: PROOF_SOLD,
    answer: valuesOn,
    kind: 'estimate',
    expectations: async (page) => {
      const result = page.getByTestId('gold-totals-result');
      await expect(result.locator('.gold-result-label')).toHaveText('Profit or loss, before rewards');
      await expect(result).toContainText('Includes estimated value of what you still hold.');
      await expect(result).toContainText('Sale proceeds + estimated value still held − purchase costs.');
      await expect(result).toContainText('Not a guaranteed sale price.');
      await expect(result).toContainText('Before rewards');
    },
  },
  {
    name: 'totals-proven-no-sales-combined',
    title: 'nothing sold in either metal, values off: no sales recorded, and the metals together say so',
    proof: PROOF_UNSOLD,
    answer: unsoldAnswer,
    kind: 'sales',
    expectations: async (page) => {
      await expect(page.getByTestId('gold-totals-result')).toContainText('No sales recorded. Holdings are not valued while prices are off.');
      await expect(page.getByTestId('gold-combined-result')).toContainText('No sales recorded. Holdings are not included in this result.');
      // The page around the totals agrees: no sale in the sales list, none on the price chart.
      const sales = page.getByTestId('gold-sales');
      await expect(sales).toContainText('No sales in this period.');
      await expect(sales.getByTestId('gold-sale')).toHaveCount(0);
      await expect(page.locator('.gold-plot-sell')).toHaveCount(0);
      // The period says it in words too, never "$0.00" or a coverage of none (Astra's R5): no figure, sub-line or method.
      await expect(page.getByTestId('gold-brought-in-none')).toHaveText('No sales recorded in this period');
      await expect(page.getByTestId('gold-brought-in')).not.toContainText('$');
      await expect(page.getByTestId('gold-sale-profit-none')).toHaveText('No sales recorded in this period.');
      await expect(page.getByTestId('gold-sale-profit')).not.toContainText(/\$|known for|What the sales brought in/i);
      for (const row of ['gold-brought-in', 'gold-sale-profit']) {
        await expect(page.getByTestId(row).locator('.gold-figure, .gold-row-sub')).toHaveCount(0);
      }
      await expectNeutralPricesOff(page);
    },
  },
];

/**
 * The holdings' gain while values don't show: "Prices off" in words carrying no gain or loss colour (Astra's R5): neither
 * it nor any element above it up to the page has a gain or loss class, and its colour is neither the gain nor the loss
 * colour, each read from a probe placed at the page's root.
 */
async function expectNeutralPricesOff(page: Page): Promise<void> {
  const gain = page.getByTestId('gold-holding').getByTestId('gold-gain');
  await expect(gain).toHaveText('Prices off');
  const read = await gain.evaluate((element) => {
    const root = element.closest('.gold') ?? document.body;
    const toned: string[] = [];
    for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
      if (node.classList.contains('gain') || node.classList.contains('loss')) toned.push(node.className);
    }
    const probe = (name: string) => {
      const span = document.createElement('span');
      span.className = name;
      span.textContent = 'probe';
      root.append(span);
      const colour = getComputedStyle(span).color;
      span.remove();
      return colour;
    };
    return { toned, shown: getComputedStyle(element).color, gain: probe('gain'), loss: probe('loss') };
  });
  expect(read.toned, 'no gain or loss class on the words or above them').toEqual([]);
  expect(read.gain).not.toBe(read.loss);
  expect(read.shown).not.toBe(read.gain);
  expect(read.shown).not.toBe(read.loss);
}

/**
 * Serves every metals read from `answer`, for the metal and period asked (answeredFor, as the routes answer), keeping each
 * answer as served, by its path and query, in `log`.
 */
const served = (page: Page, answer: ProvenState['answer'], log: Map<string, unknown>) => page.route(
  (url) => url.pathname.startsWith('/metals/'),
  (route: Route) => {
    const url = new URL(route.request().url());
    const metal = url.searchParams.get('metal') === 'XAG' ? 'XAG' : 'XAU';
    const body = answeredFor(url, answer(url.pathname, metal));
    log.set(`${url.pathname}${url.search}`, body);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  },
);

/** The label, in view in every capture: a band fixed at the top, with the page moved down under it so nothing is hidden. */
async function showLabel(page: Page): Promise<void> {
  await page.evaluate((label) => {
    const band = document.createElement('div');
    band.id = 'gold-proof-injected-label';
    band.textContent = label;
    band.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 12px;'
      + 'background:#ffd60a;color:#000;font:600 16px/1.4 system-ui,sans-serif;text-align:center;');
    document.body.append(band);
    document.body.style.paddingTop = `${band.getBoundingClientRect().height}px`;
  }, LABEL);
  await expect(page.locator('#gold-proof-injected-label')).toHaveText(LABEL);
}

async function hideLabel(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('gold-proof-injected-label')?.remove();
    document.body.style.paddingTop = '';
  });
}

/**
 * Each state on `page`: the module and the reads served afresh, the page loaded whole, the proof's effect checked, the
 * metals together opened, and captured with the label in view. Then the run's manifest: each injection with its diff,
 * every module text by its sha256, and each state's proof and every read as served.
 */
async function captureStates(page: Page, view: string, capture: (file: string) => Promise<string[]>): Promise<void> {
  const injections: Injection[] = [];
  const modules = new Map<string, string>();
  const states: Array<{ state: string; title: string; proof: InjectedProof; files: string[]; served: Record<string, unknown> }> = [];
  for (const state of STATES) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const log = new Map<string, unknown>();
    await injectProof(page, state.name, state.proof, injections, modules);
    await served(page, state.answer, log);
    await page.goto('about:blank');
    await page.goto('/#/investing/gold');
    const totals = page.getByTestId('gold-totals');
    await expect(totals.getByTestId('gold-totals-result')).toHaveAttribute('data-kind', state.kind);
    const own = injections.filter((injection) => injection.state === state.name);
    expect(own.length, `${state.name}: GoldPage was served with its proof`).toBeGreaterThan(0);
    expect(own.map((injection) => injection.matches), `${state.name}: every load of GoldPage held exactly one null proof`).toEqual(own.map(() => 1));
    expect(new Set(own.map((injection) => injection.patchedSha256)).size, `${state.name}: one rewrite`).toBe(1);
    await totals.getByTestId('gold-totals-combined').getByRole('button', { name: 'Gold and silver combined' }).click();
    await expect(totals.getByTestId('gold-combined-result')).toBeVisible();
    await state.expectations(page);
    await expect(page.getByTestId('gold-page')).toHaveAttribute('aria-busy', 'false');
    await showLabel(page);
    const files = await capture(`${state.name}-${view}`);
    await hideLabel(page);
    // Astra's R5: for the two states her P2s name, a crop of the period and what is held, the same state as the labelled
    // capture beside it.
    if (CROPPED.has(state.name)) {
      const crop = `${state.name}-${view}-summary.png`;
      await page.getByTestId('gold-summary').screenshot({ path: test.info().outputPath(crop), animations: 'disabled' });
      files.push(crop);
    }
    states.push({ state: state.name, title: state.title, proof: state.proof, files, served: Object.fromEntries(log) });
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  expect(new Set(injections.map((injection) => injection.originalSha256)).size, 'one GoldPage module, as Vite served it').toBe(1);
  const moduleFiles: Record<string, string> = {};
  for (const [sha, text] of modules) {
    const file = `totals-proven-${view}-GoldPage.${sha.slice(0, 16)}.js`;
    writeFileSync(test.info().outputPath(file), text);
    moduleFiles[sha] = file;
  }
  writeFileSync(test.info().outputPath(`totals-proven-${view}.manifest.json`), `${JSON.stringify({
    label: LABEL,
    flag: 'HOLDR_GOLD_PROOF_CAPTURE=1',
    note: 'Proof injected for the test; unreachable until PR-E. A visual review of dormant rendering only, never evidence that '
      + 'these states are reachable or correct with served data. Synthetic fixtures only.',
    module: MODULE,
    nullProof: NULL_PROOF_TEXT,
    moduleFiles,
    injections,
    states,
  }, null, 2)}\n`);
}

test.describe('the totals\' complete states, proof injected for the test (opt-in, unreachable until PR-E)', () => {
  test.beforeEach(async ({ request }) => {
    await requireHealthyApi(request);
  });

  for (const width of [375, 1920]) {
    test(`at ${width}px`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: 900 });
      await captureStates(page, String(width), async (stem) => {
        const file = `${stem}.png`;
        await page.screenshot({ path: test.info().outputPath(file), fullPage: true, animations: 'disabled' });
        return [file];
      });
    });
  }

  test('zoomed to 200% by the browser itself', async ({ baseURL }) => {
    test.setTimeout(300_000);
    if (!baseURL) throw new Error('baseURL is required');
    const zoomable = await launchZoomable(baseURL);
    try {
      const guard = await watchOrigin(zoomable.context, baseURL, { commandLine: zoomable.commandLine });
      const { cookies } = JSON.parse(readFileSync(AUTH_STATE_FILE, 'utf8')) as { cookies: Parameters<BrowserContext['addCookies']>[0] };
      await zoomable.context.addCookies(cookies);
      const page = await zoomable.context.newPage();
      await guard.watch(page);
      await page.goto('/#/investing/gold');
      await fitWindow(page);
      const viewport = () => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth });
      expect(await zoomable.zoom(2), 'the zoom the browser reports').toBe(2);
      await expect.poll(() => page.evaluate(viewport), { message: 'the window at 200%' }).toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
      await captureStates(page, 'browserzoom200', async (stem) => {
        expect(await page.evaluate(viewport), `the browser's 200% zoom, still in effect for ${stem}`).toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
        const { tiles, problems } = await captureTiles(page, (index) => test.info().outputPath(`${stem}-t${String(index).padStart(2, '0')}.png`));
        writeFileSync(test.info().outputPath(`${stem}.tiles.json`), `${JSON.stringify({ state: stem, label: LABEL, tiles, problems }, null, 2)}\n`);
        expect.soft(problems, `${stem}: its tiles are the whole page`).toEqual([]);
        return [...tiles.map((tile) => tile.file), `${stem}.tiles.json`];
      });
      await expectNoForeignTraffic(guard, 'the browser-zoomed window');
    } finally {
      await zoomable.close();
    }
  });
});
