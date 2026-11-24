import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import {
  BENEFITS_CATALOG,
  buildCardImportPayload,
  computeCardBenefitsReport,
  computeCardInsights,
  serializeCardImportPayload,
  summarizeCardSpending,
  type BenefitCreditRow,
  type CardAccount,
  type CardImportDraftRow,
  type CardOwner,
  type CardPaymentReconciliationTotals,
  type CheckingDebitClass,
} from '@finance-tracker/shared';
import { FAKE_NOW, FakeOwnerServer, fakeCardAccounts } from '../src/components/spending/sync/fakeOwnerServer';
import { answeredFor, complete, overviewFixture, oz, priceMissingAnswer, soldOutAnswer } from '../src/components/gold/goldFixtures';
import { COSTCO_PRODUCT_TITLE } from '../src/components/gold/goldLedgerSeed';
import { expect, requireHealthyApi, test, type APIRequestContext, type Page, type Route } from './fixtures';
import { AUTH_STATE_FILE } from './authState';
import { captureTiles, fitWindow, launchZoomable, ZOOM_WINDOW } from './browserZoom';
import { pricesOn } from './goldPricesOn';
import { confirmCostcoProduct, longDate, metalsStack, undoCostcoProduct } from './metalsStack';
import { expectNoForeignTraffic, watchOrigin } from './originGuard';

/**
 * The reading type scale in both modes (readability plan v2, D1), app-wide, with no exceptions: every route and every
 * state at a phone (375px), a wide screen (1920px) and 200% zoom, on the stack's synthetic household, one synthetic card
 * this file imports and synthetic answers it serves the page. Every visible text is measured as the browser draws it,
 * through the tokens in styles.css (--text-read, --text-help, --text-badge, --text-section, --leading, --measure):
 *
 *   - 14px or more for every text: help, field labels and fields, status and warnings, chips, meta lines;
 *   - 13px only for the short secondary badges (a theme, a kind, a source, a count), and on wide screens the dense
 *     tables' column heads, listed below; a status or a warning is never one, however it is drawn;
 *   - 16px for reading text: prose, row names and Everyday's lists, listed below;
 *   - section heads (h2, h3) 18px, 20px from 1280px;
 *   - line-height 1.5 (--leading) for running text that wraps (in a table cell or a control too) and for every
 *     paragraph, and 1.25 to 1.5 for headings and for controls whose text is on one line, as a multiple of the
 *     text's own size ('normal' measured in its own font);
 *   - paragraphs no wider than 65ch.
 *
 * Phone tables are solved by layout, never by shrinking type: no floor is lower on a phone.
 *
 * The states: each route as it opens; then everything it folds away opened, round by round (folds, disclosures,
 * expandable rows and `details`, two of each kind); each view a group of pressed buttons offers; each menu and popover.
 * Served here, the states a fresh stack lacks: the portfolio overnight (its panel open, its prices in holdings), the
 * server unreachable, no accounts, a holding's price unavailable (the household's chart and its account's), a
 * transaction's details (pending, posted, a possible bullion purchase, a card payment), the card import before and
 * after its preview, Manage cards and a card's confirmation, card payments and checking with payments to review,
 * Benefits with cards and credits, Amazon orders and an order's page, Amazon Fresh, Sync and devices with cards and
 * browsers, no cards, a read that fails, and a refused sign-in.
 *
 * No exceptions (Root's ruling for T2): the sweep has no list of texts it may skip, and the guard tests at the end fail
 * if one is ever added back. The code is held to the floors too, statically: every font-size in apps/web/src's CSS and
 * every inline fontSize in its TSX, whether or not a state above draws it.
 */

const INVESTING = ['#/investing/portfolio', '#/investing/gold', '#/investing/transactions', '#/investing/add', '#/investing/import', '#/investing/accounts'];
const EVERYDAY = ['#/everyday/benefits', '#/everyday/amazon', '#/everyday/amazon/fresh', '#/everyday/sync', '#/everyday/devices'];
const PHONE = 375;
const WIDE = 1920;

/**
 * Short secondary badges, 13px or more: a theme, a kind, a source or a count beside the text it qualifies, never an
 * action. Status and warnings are not badges here, however they are styled: they read at 14px like any status text.
 */
const BADGES = [
  '.holding-badge.theme', '.holding-badge.alt', '.holding-badge.risk', '.holding-badge.neutral', '.tx-pill',
  '.trade-tooltip-badge', '.trade-marker-badge', '.cash-event-type', '.broker-badge',
  '.spending-area-badge',
];
/** Dense tables' column heads, 13px or more on wide screens only: a phone shows them at 14px. */
const DENSE_HEADS = ['.holdings th', '.performance-table thead th', '.cash-ledger-column-heads'];
/**
 * Reading text: prose, row names and lists, 16px or more. T1's shared classes, and every lane's own reading text, as its
 * spec names it (controls and whole tables left out).
 */
const READING = [
  // T1: shared row names and prose.
  '.row .symbol', '.tx-row-title .symbol', '.accounts-card-name', '.empty-state-title', '.empty-state-body', '.login-lede',
  '.spending-row-merchant', '.spending-recurring-name', '.spending-insight-item-name', '.spending-empty p',
  // I1: holdings and their accounts, Performance's periods and years, the overnight panel's prose and table.
  '.holding-symbol', '.breakdown .holdings td.sym', '.contributor-name', '.breakdown .holdings tr.contributor-row > td.contributor-name-cell',
  '.breakdown .holding-details dd', '.breakdown .ai-thesis-unavailable',
  '.breakdown .indicative-explainer', '.breakdown .indicative-table tbody th', '.breakdown .indicative-table tbody td',
  '.breakdown .performance-table tbody th',
  // I2: Add, Import and a transaction's row and drawer.
  'form.add.add-transaction .add-group legend', '.tx-rows .tx-row-amount > .tx-amount-value', '.tx-rows .tx-drawer-facts .tx-drawer-value:not(.mono)',
  '.import-choice-option > label', '.import-panel p.import-done', '.import-panel .import-source > legend', '.import-panel .import-section > legend',
  '.import-panel .import-activity-table .import-activity-description',
  // A: the overview (spending-overview.e2e.ts's 16px kinds).
  '.overview-compared-text', '.overview-not-comparable-reason', '.overview-figure', '.overview-out h4', '.overview-out-row', '.overview-unknown',
  '.overview-part', '.overview-list > li', '.overview-changes > li', '.overview-row', '.overview-items', '.overview-jump',
  // B: card payments (its spec's rows and reading lines).
  '.spending-panel.spending-payments .spending-payments-open', '.spending-panel.spending-payments .spending-payments-debit',
  '.spending-panel.spending-payments .payments-headline', '.spending-panel.spending-payments .payments-breakdown',
  '.spending-panel.spending-payments .payments-review-count', '.spending-panel.spending-payments .payments-block > h4',
  // C: what counts (spending-what-counts.e2e.ts's READING): its rows, heads, lede and compact line, a merchant and an
  // amount, an error, the queue's head, the rules and the rules' fold.
  '.spending-panel.spending-what-counts :is(.what-counts-row, .what-counts-group-head, .what-counts-lede, .what-counts-compact, '
    + '.spending-row-merchant, .spending-what-counts-amount, .spending-error, .spending-what-counts-queue h4, .spending-what-counts-rule p, '
    + '.spending-what-counts-rules li > span, .what-counts-rules-fold > .fold-toggle)',
  // D: card openings and Manage cards.
  '.openings-name', '.openings-month', '.card-manager-lead', '.card-manager-name', '.card-manager-confirm-name', '.card-manager-confirm-text',
  // E: the forecast (spending-forecast.e2e.ts's READ): its sentences (not its help or status), the lead and its parts, the
  // table's rows, the bills, the caveats, how it was estimated, an error.
  '.forecast-lead h4', '.forecast-card h4', '.forecast-figure-label', '.forecast-sentences:not(.forecast-help):not(.forecast-status) > li',
  '.forecast-parts dt', '.forecast-parts dd', '.forecast-caveats', '.forecast-caveat-cards', '.forecast-gaps li', '.forecast-table tbody th',
  '.forecast-table tbody td > .num:first-child', '.forecast-table td.forecast-none', '.forecast-bill-merchant', '.forecast-bill-amount',
  '.forecast-how-body h4', '.forecast-how-text', '.spending-panel.forecast .spending-error',
  // F: Amazon (amazon.e2e.ts's reading text): an item's title, an order's date, amounts, a ranked row's name and amount,
  // part heads, an empty list, an order's facts, status, sections, payment, lines and refunds; amazon.css's 16px figures.
  '.amazon-item-title', '.amazon-order-date', '.amazon-spend-amount', '.amazon .spending-rank-name', '.amazon .spending-rank-amount',
  '.amazon-spending-part h4', '.amazon-empty p', '.amazon .spending-empty p', '.amazon-page-facts dd', '.amazon-section .amazon-order-status',
  '.amazon-section h4', '.amazon-payment-group li', '.amazon-lines dt', '.amazon-lines dd', '.amazon-refunds li > span:first-child',
  '.amazon-unattributed-refunds', '.amazon-fresh-net-detail', '.amazon-fresh-totals-value', '.amazon-fresh-line-price',
  // G: Benefits (benefits.e2e.ts's reading sizes): a reminder's name, what is left and its deadline, a row's name, the
  // summary's unknown and fees; a foldable group's and a setup card's heads.
  '.benefits-reminder-name', '.benefits-reminder-left', '.benefits-reminder-deadline', '.benefits-row-name', '.benefits-summary-unknown',
  '.benefits-summary-fees p', '.benefits-group[data-foldable] .benefits-group-name h4', '.benefits-setup-card .benefits-card-name h5',
  // H: sync and devices.
  '.spending :is(.sync-area, .sync-dialog) :is(.sync-text, .sync-lead, .sync-card-name, .sync-row-text > strong, .sync-steps strong, '
    + '.sync-switch strong, .sync-scopes, .sync-option, .sync-item legend, .sync-result > strong, .sync-approval > strong, .sync-banner > strong, '
    + '.sync-group h4, .sync-subhead, .sync-plan h4, .sync-quota-group > strong)',
  '.spending .sync-waiting > strong',
  // G4: the Gold page (design v8 §11, as Astra accepted the redesign): a row's and a detail's name, labelled details, the
  // summary's figures and the totals' words standing for one, a proposal, what waits.
  '.gold .gold-row-name', '.gold .gold-details dd', '.gold .gold-money', '.gold .gold-totals-words', '.gold .gold-proposal',
  '.gold .gold-tocheck-group li',
];
/** Reading text on phones only (600px and narrower, I1's breakpoint): a holding's market value, beside its symbol. */
const PHONE_READING = ['.breakdown .account.combined table.holdings tr.holding-row > td.col-value'];
/**
 * Notes inside reading text, at the help size (14px, never less): the help, status and secondary lines each lane's spec
 * holds at 14px inside its reading text (a price's note under its symbol, a period's tag, a row's date and description
 * under its merchant). Text a note holds is a note; reading text a note holds is reading.
 */
const NOTES = [
  // I1: a price's note, a column head's sub, an account's quantity, the overnight table's sub, Performance's sub and tag.
  '.holding-price-note', '.holdings-head-sub', '.contributor-quantity', '.indicative-sub', '.performance-sub', '.performance-tag',
  // A (spending-overview.e2e.ts's 14px kinds): muted text, a note, help, the scope, an error, reasons, the filter's line.
  '.spending-muted', '.overview-out-note', '.overview-help', '.overview-scope', '.overview-error', '.overview-note-reasons', '.overview-filter',
  // B: a status badge, payments' help, notes and part labels, a suggestion's text.
  '.spending-badge', '.payments-help', '.payments-note', '.payments-part-label', '.spending-detail-suggestion-text',
  // C (spending-what-counts.e2e.ts's HELP): a row's description, date and original amount, a note, help.
  '.spending-panel.spending-what-counts .spending-row-description', '.spending-panel.spending-what-counts .spending-row-date',
  '.spending-panel.spending-what-counts .spending-row-original', '.spending-panel.spending-what-counts .what-counts-note',
  '.spending-panel.spending-what-counts .what-counts-help',
  // G4: a figure's state word ("Partial", "Unknown") and a help line inside a labelled detail.
  '.gold .gold-state', '.gold .gold-help-inline',
];
/** Section heads: 18px, 20px from 1280px. */
const SECTION_HEADS = 'h2, h3';
/** Headings: a line-height of 1.25 to 1.5, wrapping or not. */
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
/**
 * Controls: a line-height of 1.25 to 1.5 while their text is on one line; text that wraps in one is running text, at
 * 1.5. Text in a control is no reading text, unless the reading text sits inside it (a row's merchant in its button).
 * Any other text, in a table cell or anywhere, is running text: 1.5 (--leading) once it wraps.
 */
const CONTROLS = 'button, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="option"], input, select, textarea, summary';

/** What the sweep holds every text to, and nothing else: there is no list of texts it may skip. */
interface Rules {
  badges: string;
  denseHeads: string;
  reading: string;
  notes: string;
  sections: string;
  headings: string;
  controls: string;
  wide: boolean;
}

const rulesFor = (width: number): Rules => ({
  badges: BADGES.join(', '),
  denseHeads: DENSE_HEADS.join(', '),
  reading: [...READING, ...(width <= 600 ? PHONE_READING : [])].join(', '),
  notes: NOTES.join(', '),
  sections: SECTION_HEADS,
  headings: HEADINGS,
  controls: CONTROLS,
  wide: width >= 1280,
});

/**
 * One text off its floor: where it is (tag.class > tag.class > tag.class), the rule (its size, its line-height or a
 * paragraph's measure), what it measures and what it needs, and the start of the text. A page that scrolls sideways
 * is one too: its overflow in px, and the innermost elements past the window's edge.
 */
interface Finding {
  where: string;
  rule: 'size' | 'leading' | 'measure' | 'sideways';
  value: number;
  need: string;
  text: string;
}

/**
 * Every visible text on the page off its floor: text nodes, form fields, the text of ::before and ::after and SVG text
 * (at its drawn size); the line-height of running text that wraps, of headings and controls and of paragraphs; and the
 * measure of paragraphs. Text a screen reader alone gets (a 1px clipped box) and text clipped out of sight are not
 * drawn, and not measured.
 */
const sweep = (page: Page, width: number) => page.evaluate((rules: Rules): Finding[] => {
  const findings = new Map<string, Finding>();
  const round = (value: number) => Math.round(value * 100) / 100;
  const label = (node: Element) => node.tagName.toLowerCase() + [...node.classList].map((name) => `.${name}`).join('');
  const where = (el: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.body && parts.length < 3; node = node.parentElement) parts.unshift(label(node));
    return parts.join(' > ');
  };
  const add = (finding: Finding) => {
    const key = `${finding.where}|${finding.rule}|${finding.value}`;
    if (!findings.has(key)) findings.set(key, finding);
  };
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element) => {
    let computed = styles.get(el);
    if (!computed) {
      computed = getComputedStyle(el);
      styles.set(el, computed);
    }
    return computed;
  };
  const boxes = new Map<Element, { srOnly: boolean; clip: DOMRect | null }>();
  const boxOf = (node: Element) => {
    let box = boxes.get(node);
    if (!box) {
      const s = style(node);
      const rect = node.getBoundingClientRect();
      const clips = [s.overflowX, s.overflowY].some((value) => value === 'hidden' || value === 'clip');
      box = {
        srOnly: s.clip === 'rect(0px, 0px, 0px, 0px)' || (rect.width <= 1 && rect.height <= 1 && s.overflow !== 'visible'),
        clip: clips ? rect : null,
      };
      boxes.set(node, box);
    }
    return box;
  };
  const hidden = (el: Element, box: DOMRect): boolean => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    if (box.width <= 0 || box.height <= 0) return true;
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      const { srOnly, clip } = boxOf(node);
      if (srOnly) return true;
      if (clip && (box.right <= clip.left || box.left >= clip.right || box.bottom <= clip.top || box.top >= clip.bottom)) return true;
    }
    return false;
  };

  // Size: the floor of the kind of text it is. Reading text in a control (a row's merchant in its button) is reading
  // text; a control in a reading block (a button in an empty state's text) is a control; a note inside reading text
  // (a price's note under its symbol) is a note, at the help size.
  const floorOf = (el: Element): number => {
    if (el.closest(rules.badges)) return 13;
    if (rules.wide && el.closest(rules.denseHeads)) return 13;
    if (el.closest(rules.sections)) return rules.wide ? 20 : 18;
    const reading = el.closest(rules.reading);
    const control = el.closest(rules.controls);
    const note = el.closest(rules.notes);
    const inNote = note !== null && reading !== null && note !== reading && reading.contains(note);
    if (reading && !inNote && (!control || control.contains(reading))) return 16;
    return 14;
  };
  const sizeOf = (el: Element): number => {
    const px = parseFloat(style(el).fontSize);
    if (el instanceof SVGGraphicsElement) {
      const matrix = el.getScreenCTM();
      return matrix ? px * Math.abs(matrix.d) : px;
    }
    return px;
  };
  const checkSize = (el: Element, text: string, size: number, floor = floorOf(el)) => {
    if (size + 0.01 < floor) add({ where: where(el), rule: 'size', value: round(size), need: `${floor}px`, text: text.slice(0, 40) });
  };

  // Line-height, as a multiple of the text's own size: 'normal' measured in the text's own font.
  const normals = new Map<string, number>();
  const leadingOf = (el: Element): number => {
    const s = style(el);
    const size = parseFloat(s.fontSize);
    if (s.lineHeight !== 'normal') return parseFloat(s.lineHeight) / size;
    const key = `${s.fontStyle}|${s.fontWeight}|${s.fontSize}|${s.fontFamily}`;
    let ratio = normals.get(key);
    if (ratio === undefined) {
      const probe = document.createElement('span');
      probe.textContent = 'Hxg';
      probe.style.cssText = 'position: absolute; visibility: hidden; display: inline-block; margin: 0; padding: 0; border: 0;';
      probe.style.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      probe.style.lineHeight = 'normal';
      document.body.append(probe);
      ratio = probe.getBoundingClientRect().height / size;
      probe.remove();
      normals.set(key, ratio);
    }
    return ratio;
  };
  /** The box a text's lines are laid out in: its nearest element that is not inline. */
  const blockOf = (el: Element): Element => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const display = style(node).display;
      if (display !== 'inline' && display !== 'contents') return node;
    }
    return el;
  };
  /** How many lines some text boxes fill: boxes that overlap by half of the shorter are on one line. */
  const lineCount = (rects: readonly DOMRect[]): number => {
    const bands: Array<{ top: number; bottom: number }> = [];
    for (const rect of [...rects].sort((a, b) => a.top - b.top)) {
      const band = bands.find((item) => Math.min(item.bottom, rect.bottom) - Math.max(item.top, rect.top)
        >= Math.min(item.bottom - item.top, rect.height) / 2);
      if (band) {
        band.top = Math.min(band.top, rect.top);
        band.bottom = Math.max(band.bottom, rect.bottom);
      } else {
        bands.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    return bands.length;
  };
  const lines = new Map<Element, DOMRect[]>();
  const runs: Array<{ el: Element; block: Element; text: string }> = [];

  // Text nodes.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || !el || el.closest('script, style, noscript, template, select, title, desc')) continue;
    range.selectNodeContents(node);
    if (hidden(el, range.getBoundingClientRect())) continue;
    checkSize(el, text, sizeOf(el));
    if (el instanceof SVGElement || !/[\p{L}\p{N}]/u.test(text)) continue;
    const block = blockOf(el);
    const rects = lines.get(block) ?? [];
    rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
    lines.set(block, rects);
    runs.push({ el, block, text });
  }
  const wraps = new Map<Element, number>();
  for (const { el, block, text } of runs) {
    let count = wraps.get(block);
    if (count === undefined) {
      count = lineCount(lines.get(block) ?? []);
      wraps.set(block, count);
    }
    const ratio = leadingOf(el);
    if (el.closest(rules.headings) || (count <= 1 && el.closest(rules.controls))) {
      // Headings, and controls whose text is on one line: 1.25 to 1.5.
      if (ratio < 1.24 || ratio > 1.51) add({ where: where(el), rule: 'leading', value: round(ratio), need: '1.25–1.5', text: text.slice(0, 40) });
    } else if (count > 1 && ratio < 1.49) {
      // Running text that wraps, a table cell's or a control's too: 1.5.
      add({ where: where(el), rule: 'leading', value: round(ratio), need: '1.5', text: text.slice(0, 40) });
    }
  }

  // Form fields: their value or placeholder is text too.
  for (const el of document.body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
    if (el instanceof HTMLInputElement && ['hidden', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(el.type)) continue;
    if (hidden(el, el.getBoundingClientRect())) continue;
    const text = el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text ?? '') : (el.value || el.placeholder);
    checkSize(el, text || el.tagName.toLowerCase(), sizeOf(el));
  }
  // Generated text: ::before and ::after with letters or digits (an icon glyph is not text).
  for (const el of document.body.querySelectorAll('*')) {
    for (const pseudo of ['::before', '::after']) {
      const s = getComputedStyle(el, pseudo);
      const content = s.content;
      if (!content || content === 'none' || content === 'normal' || content.startsWith('url(') || !/[A-Za-z0-9]/.test(content)) continue;
      if (s.display === 'none' || s.visibility === 'hidden' || hidden(el, el.getBoundingClientRect())) continue;
      // A cell's label drawn from its data-label (a table read as labelled lines on a phone) is a field label: 14px.
      const label = el.getAttribute('data-label');
      const isLabel = label !== null && content.startsWith(JSON.stringify(label));
      checkSize(el, `${pseudo} ${content}`, parseFloat(s.fontSize), isLabel ? 14 : floorOf(el));
    }
  }

  // Paragraphs: line-height 1.5 and a 65ch measure, as CSS resolves 65ch in the paragraph's own font.
  const measureOf = (p: Element): number => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position: absolute; visibility: hidden; width: 65ch; height: 0; margin: 0; padding: 0; border: 0;';
    p.append(probe);
    const measure = probe.getBoundingClientRect().width;
    probe.remove();
    return measure;
  };
  for (const p of document.body.querySelectorAll('p')) {
    const box = p.getBoundingClientRect();
    const text = (p.textContent ?? '').trim();
    if (!text || hidden(p, box)) continue;
    const s = style(p);
    const ratio = leadingOf(p);
    const content = box.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
    const measure = measureOf(p);
    if (ratio < 1.49) add({ where: where(p), rule: 'leading', value: round(ratio), need: '1.5', text: text.slice(0, 40) });
    if (content > measure + 1) add({ where: where(p), rule: 'measure', value: Math.round(content), need: `${Math.round(measure)}px (65ch)`, text: text.slice(0, 40) });
  }
  return [...findings.values()];
}, rulesFor(width));

/** Requests in flight on a page, so a state is measured once what it asked for has arrived. */
const inflight = new WeakMap<Page, Set<unknown>>();
function track(page: Page): void {
  if (inflight.has(page)) return;
  const pending = new Set<unknown>();
  page.on('request', (request) => pending.add(request));
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  inflight.set(page, pending);
}
/**
 * A state is read at rest: what it asked for has arrived, nothing finite is still moving (a figure rolling to its new
 * value, a fold opening) and the page hasn't changed for 250ms, so a figure is measured as it reads once settled, never
 * mid-roll. Something that never rests (a ticking clock) is read after 1.5s.
 */
async function settle(page: Page): Promise<void> {
  const pending = inflight.get(page);
  const until = Date.now() + 4_000;
  await page.waitForTimeout(120);
  while (pending && pending.size > 0 && Date.now() < until) await page.waitForTimeout(80);
  await page.evaluate(() => new Promise<void>((resolve) => {
    const deadline = performance.now() + 1_500;
    let changed = performance.now();
    const observer = new MutationObserver(() => { changed = performance.now(); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const moving = () => document.getAnimations().some((animation) =>
      animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Infinity)));
    const check = () => {
      const now = performance.now();
      if (now > deadline || (!moving() && now - changed >= 250)) {
        observer.disconnect();
        resolve();
      } else setTimeout(check, 50);
    };
    check();
  }));
}

async function open(page: Page, hash: string): Promise<void> {
  track(page);
  // A fresh load each time: moving between hashes stays in the page, and would keep what it read before.
  await page.goto('about:blank');
  await page.goto(`/${hash}`);
  await expect(page.locator('.app')).toBeVisible();
  // The page's own reads first: a row that arrives late is text too.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

/**
 * Opens what the page (or the dialog on top, when one is open) folds away: folds, disclosures, expandable rows and
 * `details`, two of each kind (a kind: the toggle's tag and classes under its parent's), one after another as a reader
 * would. Returns how many it opened: none once nothing folded is left.
 */
const openFolds = (page: Page) => page.evaluate(async () => {
  const label = (node: Element) => node.tagName.toLowerCase() + [...node.classList].map((name) => `.${name}`).join('');
  const kind = (node: Element) => `${node.parentElement ? label(node.parentElement) : ''} > ${label(node)}`;
  const memory = window as unknown as { readabilityOpened?: Record<string, number> };
  const opened = (memory.readabilityOpened ??= {});
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].filter((node) => node.checkVisibility());
  const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document.body;
  const hash = location.hash;
  let count = 0;
  for (let step = 0; step < 30 && location.hash === hash; step += 1) {
    const next = [...scope.querySelectorAll<HTMLElement>(
      'button[aria-expanded="false"]:not([aria-haspopup]), [role="button"][aria-expanded="false"]:not([aria-haspopup]), details:not([open]) > summary',
    )].find((node) => !node.hasAttribute('data-readability-opened') && !(node as HTMLButtonElement).disabled
      && node.checkVisibility() && (opened[kind(node)] ?? 0) < 2);
    if (!next) break;
    next.setAttribute('data-readability-opened', '');
    opened[kind(next)] = (opened[kind(next)] ?? 0) + 1;
    next.click();
    count += 1;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  return count;
});

/**
 * The next view a group of pressed buttons offers (Benefits' "Group by" and "Order", a period, a chart's split): each
 * button not pressed in turn, at most three a group and ten a page. Returns what it chose, or null.
 */
const nextView = (page: Page) => page.evaluate(() => {
  const memory = window as unknown as { readabilityViews?: string[] };
  const done = (memory.readabilityViews ??= []);
  if (done.length >= 10) return null;
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].filter((node) => node.checkVisibility());
  const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document.body;
  for (const group of scope.querySelectorAll('[role="group"]')) {
    if (!group.checkVisibility()) continue;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].filter((node) => node.closest('[role="group"]') === group);
    if (buttons.length < 2) continue;
    const name = group.getAttribute('aria-label') ?? '';
    if (done.filter((entry) => entry.startsWith(`${name}: `)).length >= 3) continue;
    const next = buttons.find((node) => node.getAttribute('aria-pressed') === 'false' && !node.disabled && node.checkVisibility()
      && !done.includes(`${name}: ${node.textContent?.trim()}`));
    if (!next) continue;
    const view = `${name}: ${next.textContent?.trim()}`;
    done.push(view);
    next.click();
    return view;
  }
  return null;
});

/** Opens the next menu or popover of a kind not opened yet (in the dialog on top, when one is open); returns its kind. */
const openMenu = (page: Page) => page.evaluate(() => {
  const label = (node: Element) => node.tagName.toLowerCase() + [...node.classList].map((name) => `.${name}`).join('');
  const kind = (node: Element) => `${node.parentElement ? label(node.parentElement) : ''} > ${label(node)}`;
  const memory = window as unknown as { readabilityMenus?: string[] };
  const done = (memory.readabilityMenus ??= []);
  if (done.length >= 6) return null;
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].filter((node) => node.checkVisibility());
  const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document.body;
  const next = [...scope.querySelectorAll<HTMLElement>('[aria-haspopup]:not([aria-haspopup="false"])')]
    .find((node) => !(node as HTMLButtonElement).disabled && node.checkVisibility() && node.getAttribute('aria-expanded') !== 'true'
      && !done.includes(kind(node)));
  if (!next) return null;
  done.push(kind(next));
  next.setAttribute('data-readability-menu', '');
  next.click();
  return kind(next);
});
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const opener = document.querySelector<HTMLElement>('[data-readability-menu]');
    if (opener?.getAttribute('aria-expanded') === 'true') opener.click();
    opener?.removeAttribute('data-readability-menu');
  });
}

type Found = Map<string, Finding & { state: string }>;

/** The innermost elements past the window's right edge: what makes a page scroll sideways. */
const pastTheEdge = (page: Page) => page.evaluate(() => {
  const label = (node: Element) => node.tagName.toLowerCase() + [...node.classList].map((name) => `.${name}`).join('');
  const over = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5);
  return over.filter((el) => !over.some((other) => other !== el && el.contains(other))).slice(0, 3).map(label).join(', ');
});

/**
 * Every state of what is open now: as it is, its folds opened round by round, each view, and each menu or popover.
 * In each, every text at its floor, and the page not scrolling sideways (Alex's brief: no horizontal page scroll).
 */
async function sweepStates(page: Page, width: number, found: Found): Promise<void> {
  const record = async (state: string) => {
    const findings = await sweep(page, width);
    const over = await sideways(page);
    if (over > 0) findings.push({ where: 'the page', rule: 'sideways', value: over, need: '0px', text: await pastTheEdge(page) });
    for (const finding of findings) {
      const key = `${finding.where}|${finding.rule}|${finding.value}`;
      if (!found.has(key)) found.set(key, { ...finding, state });
    }
  };
  await settle(page);
  await record('as it opens');
  for (let round = 1; round <= 5; round += 1) {
    if ((await openFolds(page)) === 0) break;
    await settle(page);
    await record(`folds open (${round})`);
  }
  for (let view = await nextView(page); view; view = await nextView(page)) {
    await settle(page);
    await record(`view ${view}`);
  }
  for (let menu = await openMenu(page); menu; menu = await openMenu(page)) {
    await settle(page);
    await record(`menu ${menu}`);
    await closeMenu(page);
  }
}

/**
 * Opens a state with `opener`, sweeps every state of it, and holds every text it found to its floor. `capture` saves the
 * state as `opener` left it, before the sweep opens its folds, views and menus.
 */
async function expectStates(page: Page, width: number, title: string, opener: () => Promise<void>,
  capture?: () => Promise<void>): Promise<void> {
  await opener();
  if (capture) {
    await settle(page);
    await capture();
  }
  const found: Found = new Map();
  await sweepStates(page, width, found);
  expect.soft([...found.values()], `${title} at ${width}px`).toEqual([]);
}

const headers = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };

/**
 * One synthetic card of this file's own (fictional merchants, made-up amounts), so Everyday's lists have rows to read,
 * and their warnings: a purchase pending for 16 days ("may have been cancelled") and one at a bullion seller
 * ("Possibly precious metals?"). Its merchants are named for this file alone: other specs pick rows by merchant text,
 * which matches a substring, and on a stack they share no name here may contain one of theirs.
 */
async function seedCard(request: APIRequestContext): Promise<string> {
  const nickname = `Readability ${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6)}`;
  const created = await request.post('/card-accounts', {
    headers, data: { issuer: 'amex', owner: 'joint', nickname, last5: '90007', currency: 'USD' },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json() as { id: string };
  const rows: CardImportDraftRow[] = [
    { transactionDate: '2024-02-03', amountMinor: 8400, kind: 'purchase', description: 'READABILITY PANTRY', issuerCategory: 'Groceries' },
    { transactionDate: '2024-02-09', amountMinor: 1549, kind: 'purchase', description: 'READABILITY TELEVIEW', issuerCategory: 'Entertainment' },
    { transactionDate: '2024-02-21', amountMinor: 6200, kind: 'purchase', description: 'READABILITY CANTEEN', issuerCategory: 'Restaurant' },
    { transactionDate: '2024-03-04', amountMinor: 9100, kind: 'purchase', description: 'READABILITY PANTRY', issuerCategory: 'Groceries' },
    { transactionDate: '2024-03-04', status: 'pending', amountMinor: 1800, kind: 'purchase', description: 'READABILITY PARKADE', issuerCategory: 'Travel' },
    { transactionDate: '2024-03-07', amountMinor: 52000, kind: 'purchase', description: 'READABILITY BULLION', issuerCategory: 'Shopping' },
    { transactionDate: '2024-03-09', amountMinor: 1549, kind: 'purchase', description: 'READABILITY TELEVIEW', issuerCategory: 'Entertainment' },
    { transactionDate: '2024-03-11', amountMinor: 4500, kind: 'purchase', description: 'READABILITY STATIONER', issuerCategory: 'Shopping' },
    { transactionDate: '2024-03-13', amountMinor: -1500, kind: 'refund', description: 'READABILITY STATIONER REFUND', issuerCategory: 'Shopping' },
    { transactionDate: '2024-03-15', amountMinor: 350, kind: 'fee', description: 'READABILITY FOREIGN FEE', issuerCategory: 'Fees' },
    { transactionDate: '2024-03-16', amountMinor: -20000, kind: 'payment', description: 'READABILITY AUTOPAY' },
    { transactionDate: '2024-03-18', status: 'pending', amountMinor: 2700, kind: 'purchase', description: 'READABILITY GARAGE', issuerCategory: 'Fuel' },
  ];
  const data = serializeCardImportPayload(buildCardImportPayload({
    source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'amex', currency: 'USD',
    coverage: { start: '2024-02-01', end: '2024-03-20' }, rows,
  }).payload);
  expect((await request.post(`/card-imports/commit?cardAccountId=${id}`, { headers, data })).status()).toBe(201);
  return id;
}

/** A statement for that card, only ever previewed: the pending fuel charge posted, a charge it already has, and a new one. */
const STATEMENT = serializeCardImportPayload(buildCardImportPayload({
  source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'amex', currency: 'USD',
  coverage: { start: '2024-03-01', end: '2024-03-20' },
  rows: [
    { transactionDate: '2024-03-18', postedDate: '2024-03-19', amountMinor: 2700, kind: 'purchase', description: 'READABILITY GARAGE', issuerCategory: 'Fuel' },
    { transactionDate: '2024-03-09', amountMinor: 1549, kind: 'purchase', description: 'READABILITY TELEVIEW', issuerCategory: 'Entertainment' },
    { transactionDate: '2024-03-19', amountMinor: 2300, kind: 'purchase', description: 'READABILITY KIOSK', issuerCategory: 'Shopping' },
  ],
}).payload);

/** Everyday's card transactions on the seeded month, this file's card alone, with both of its warnings in view. */
async function openCard(page: Page, id: string): Promise<void> {
  await page.clock.setFixedTime(new Date('2024-03-20T12:00:00'));
  await open(page, '#/everyday/transactions');
  await page.getByRole('combobox', { name: 'Card', exact: true }).selectOption(id);
  await expect(page.locator('.spending-transactions .spending-row').first()).toBeVisible();
  const warnings = page.locator('.spending-transactions .spending-badge.warn');
  // The list is this card's alone once each warning shows once: the page may hold every card's rows a moment longer,
  // and other cards may have warnings of their own.
  await expect(warnings.filter({ hasText: 'Pending 16 days · may have been cancelled' })).toHaveCount(1);
  await expect(warnings.filter({ hasText: 'Possibly precious metals?' })).toHaveCount(1);
  await expect(warnings.filter({ hasText: 'Pending 16 days · may have been cancelled' })).toBeVisible();
  await expect(warnings.filter({ hasText: 'Possibly precious metals?' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

/**
 * The card is imported once for the file: a worker that restarts after a failure finds it (by its nickname and
 * number) rather than importing a second card with the same merchants.
 */
let seeded: Promise<string> | undefined;
const card = (request: APIRequestContext) => (seeded ??= (async () => {
  const listed = await request.get('/card-accounts');
  if (listed.ok()) {
    const { cardAccounts } = await listed.json() as { cardAccounts: Array<{ id: string; nickname?: string | null; last5?: string | null }> };
    const existing = cardAccounts.find((item) => item.nickname?.startsWith('Readability ') && item.last5 === '90007');
    if (existing) return existing.id;
  }
  return seedCard(request);
})());

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Quotes with one symbol's price withheld (the route mock of audit.e2e.ts): a holding whose price is unavailable. */
async function serveQuotesWithout(page: Page, missing: string): Promise<void> {
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now();
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map((name) => name.trim().toUpperCase()).filter(Boolean);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: symbols.filter((name) => name !== missing)
          .map((name) => ({ symbol: name, price: 25, currency: 'USD', asOf, source: 'unknown', freshness: 'eod', session: 'closed' })),
        fallbackSymbols: [],
        missingSymbols: [],
      }),
    });
  });
}

/** Quotes with one synthetic overnight indicative price (the route mock of labels.e2e.ts). */
async function serveOvernight(page: Page): Promise<void> {
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now();
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map((name) => name.trim().toUpperCase()).filter(Boolean);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ quotes: symbols.map((name) => ({
        symbol: name, price: 25, currency: 'USD', asOf, source: 'unknown', freshness: 'eod', session: 'closed',
        ...(name === 'NBIS' ? { indicative: { price: 50, source: 'hyperliquid-perp', asOf, baselineClose: 25, premiumPct: 1, confidence: 'ok' } } : {}),
      })) }),
    });
  });
}

/** The portfolio overnight, as it opens: its panel folded, and not in holdings. */
async function openOvernight(page: Page): Promise<void> {
  await serveOvernight(page);
  await open(page, '#/investing/portfolio');
  const panel = page.getByRole('region', { name: 'Overnight prices' });
  await expect(panel.locator('.indicative-header > button[aria-expanded="false"]')).toContainText('1 of');
  await expect(panel.getByRole('switch', { name: 'Use overnight prices' })).toHaveAttribute('aria-checked', 'false');
}

/**
 * What Chromium itself exposes to assistive tech under an element (its accessibility tree, not a role worked out from
 * the markup): how many nodes of each role, the element included.
 */
async function exposedRoles(page: Page, selector: string, roles: readonly string[]): Promise<Record<string, number>> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Accessibility.enable');
    const { root } = await client.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const counts: Record<string, number> = {};
    for (const role of roles) {
      const { nodes } = await client.send('Accessibility.queryAXTree', { nodeId, role });
      counts[role] = nodes.filter((node) => !node.ignored).length;
    }
    return counts;
  } finally {
    await client.detach();
  }
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Investing with no accounts: its reads answer, empty. */
async function serveNoAccounts(page: Page): Promise<void> {
  const empty = (pathname: string, body: unknown) => page.route((url) => url.pathname === pathname,
    (route) => (route.request().method() === 'GET' ? json(route, body) : route.fallback()));
  await empty('/accounts', { accounts: [] });
  await empty('/transactions', { transactions: [] });
  await empty('/cash-events', { cashEvents: [] });
}

/** The server unreachable: Investing's reads fail, and the page keeps what it read before. */
async function serveOffline(page: Page): Promise<void> {
  for (const pathname of ['/accounts', '/transactions']) {
    await page.route((url) => url.pathname === pathname, (route) => route.fulfill({ status: 503, body: 'offline' }));
  }
  await page.route('**/quotes?**', (route) => route.fulfill({ status: 503, body: 'offline' }));
}

/** Everyday's card routes with no cards at all (no owner sync API). */
async function serveNoCards(page: Page): Promise<void> {
  await page.route((url) => /^\/(?:card-accounts|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.fallback();
    if (url.pathname === '/card-accounts') return json(route, { cardAccounts: [] });
    if (url.pathname === '/spending/coverage') return json(route, { cards: [] });
    if (url.pathname === '/spending/summary') return json(route, { ...summarizeCardSpending([], { owners: new Map() }), categories: [] });
    if (url.pathname === '/spending/insights') return json(route, computeCardInsights([], { month: '2024-03', today: '2024-03-20', currency: 'USD' }));
    if (url.pathname === '/card-transactions') return json(route, { transactions: [], total: 0, limit: 100, offset: 0, nextOffset: null });
    return route.fallback();
  });
}

/**
 * Card payments against a checking account, served (the stack has none): this file's card payment matched to its
 * withdrawal, two payments the rules hold for the owner with the two withdrawals that could pay them, a payment with no
 * withdrawal and a withdrawal with no payment. Synthetic ids, dates and amounts; nothing is answered.
 */
async function servePayments(page: Page, cardId: string): Promise<void> {
  const checkingId = 'chk-acct-readability';
  const payment = (letter: string, date: string, amountMinor: number) => ({
    id: `card-txn-readability-${letter}`, cardAccountId: cardId, date, amountMinor, currency: 'USD', description: 'READABILITY AUTOPAY',
  });
  const debit = (letter: string, date: string, amountMinor: number, payee: string, payeeLabel: string) => ({
    id: `chk-txn-readability-${letter}`, checkingAccountId: checkingId, accountLabel: 'Readability Checking', date, amountMinor,
    currency: 'USD', class: 'card-payment' as CheckingDebitClass, payee, payeeLabel, descriptor: `${payee.toUpperCase()} EPAYMENT READABILITY ***0000`,
  });
  const matched = payment('a', '2024-03-16', -20000);
  const [first, second] = [payment('b', '2024-03-05', -15000), payment('c', '2024-03-06', -15000)];
  const [one, other] = [debit('b', '2024-03-06', -15000, 'amex', 'American Express'), debit('c', '2024-03-07', -15000, 'amex', 'American Express')];
  const left = payment('d', '2024-03-12', -9999);
  const stray = debit('d', '2024-03-08', -4000, 'discover', 'Discover');
  const amount = (count: number, amountMinor: number) => ({ count, amountMinor });
  const none = amount(0, 0);
  const totals: CardPaymentReconciliationTotals = {
    currency: 'USD',
    payments: { all: amount(4, -59999), matched: amount(1, -20000), confirmed: none, ambiguous: amount(2, -30000), unmatched: amount(1, -9999),
      elsewhere: none, returned: none, pending: none },
    debits: { all: amount(4, -54000), matched: amount(1, -20000), confirmed: none, ambiguous: amount(2, -30000), unmatched: amount(1, -4000),
      notCardPayment: none, biltHousing: none },
  };
  const answer = {
    rulesVersion: 1,
    rules: { daysBefore: 5, daysAfter: 5, confirmDays: 15 },
    checking: {
      installed: true,
      accounts: [{ id: checkingId, label: 'Readability Checking', institution: 'readability', last4: '0000', currency: 'USD', status: 'active',
        coverage: [{ start: '2024-01-01', end: '2024-03-20' }] }],
    },
    decisions: { installed: true, stale: [] },
    totals: [totals],
    pairs: [{ status: 'matched', dayOffset: 1, payment: matched, debit: debit('a', '2024-03-17', -20000, 'amex', 'American Express') }],
    ambiguous: [{
      id: first.id, payments: [first, second], debits: [one, other],
      candidates: [
        { paymentId: first.id, debitId: one.id, dayOffset: 1 }, { paymentId: first.id, debitId: other.id, dayOffset: 2 },
        { paymentId: second.id, debitId: one.id, dayOffset: 0 }, { paymentId: second.id, debitId: other.id, dayOffset: 1 },
      ],
    }],
    unmatchedPayments: [{ payment: left, reason: 'no-checking-debit', possibleDebits: [], brokerageSuggestions: 1 }],
    unmatchedDebits: [{ debit: stray, reason: 'no-card-account', possiblePayments: [] }],
    elsewhere: [],
    returned: [],
    notCardPayments: [],
    biltHousing: [],
  };
  await page.route((url) => url.pathname === '/spending/payment-reconciliation', (route) => (
    route.request().method() === 'GET' ? json(route, answer) : route.fallback()));
}

// ---- Benefits with cards and credits: the report as the API computes it, from synthetic cards and credits ----

const BENEFITS_TODAY = '2026-10-27';
const at = '2026-01-01T00:00:00.000Z';
const benefitCard = (letter: string, owner: CardOwner, nickname: string, last4: string): CardAccount => ({
  id: `card-acct-${letter.repeat(32)}`, issuer: 'amex', owner, nickname, last4, currency: 'USD', status: 'active', createdAt: at, updatedAt: at,
});
const BENEFIT_CARDS = [
  benefitCard('c', 'alex', 'Platinum', '9155'),
  benefitCard('d', 'joint', 'Delta Gold Business', '6823'),
  benefitCard('e', 'casey', 'Spare', '8075'),
];
const benefitCredit = (n: number, account: CardAccount, date: string, amountMinor: number, description: string): BenefitCreditRow => ({
  id: `card-txn-${String.fromCharCode(97 + n).repeat(32)}`, cardAccountId: account.id, date, amountMinor: -amountMinor, kind: 'adjustment',
  description, merchant: null,
});
const BENEFIT_CREDITS = [
  ...['06', '07', '08', '09'].map((month, n) => benefitCredit(n, BENEFIT_CARDS[0], `2026-${month}-06`, 2500, 'SAMPLE DIGITAL ENTERTAINMENT CREDIT')),
  benefitCredit(4, BENEFIT_CARDS[0], '2026-03-14', 5000, 'SAMPLE SAKS CREDIT'),
  benefitCredit(5, BENEFIT_CARDS[1], '2026-04-18', 15000, 'SAMPLE DELTA STAYS CREDIT'),
];

async function serveBenefits(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/spending/benefits', (route) => json(route, computeCardBenefitsReport({
    catalog: BENEFITS_CATALOG,
    year: Number(new URL(route.request().url()).searchParams.get('year') ?? '2026'),
    today: BENEFITS_TODAY,
    cards: BENEFIT_CARDS.map((account) => ({ account, settings: null })),
    credits: BENEFIT_CREDITS,
    marks: [],
    trackers: [],
  })));
}

// ---- Amazon orders, an order's page and Amazon Fresh: the read API's answers, synthetic (after amazon*.e2e.ts) ----

type Json = Record<string, unknown>;
const amazonRef = (n: number) => `amz-${n.toString(16).padStart(48, '0')}`;
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const LINKED_TX = `card-txn-${'1'.repeat(32)}`;
const AMAZON_SUMMARY = {
  measure: 'amazon-order-observations-not-card-spending', orders: 2, paymentObservations: 3, refundObservations: 2,
  issuedRefundObservations: 2, linked: 1, held: 1, unknownBeneficiary: 1, itemAttribution: 'unproven',
  version: 'amazon-v1-000000000000000000000ead',
  coverage: [{ captureRef: 'synthetic-capture', coverage: {
    orders: { status: 'partial', reason: 'synthetic-window', pages: 1, records: 2, rejected: 0 },
    payments: { status: 'held', reason: 'synthetic-held', pages: 0, records: 0, rejected: 0 },
    details: { status: 'partial', reason: 'synthetic-window', pages: 2, records: 2, rejected: 0 },
    refunds: { status: 'partial', reason: 'synthetic-window', pages: 1, records: 2, rejected: 0 },
  } }],
};
const KETTLE = 'Sample Kettle Model K-100, 1.7 L, Stainless Steel, Auto Shut-Off';
const FILTERS = 'Sample Water Filter Pack Model F-2 (2-Pack)';
const LAMP = 'Sample Desk Lamp Model L-3 with Dimmer';
const AMAZON_ORDERS: Record<string, Json> = {
  [amazonRef(1)]: {
    ref: amazonRef(1), date: '2026-10-12', total: usd(4210), beneficiary: 'unknown', tenderCoverage: 'single-card-proven',
    paymentCoverage: 'held', itemObservations: 2,
    matches: [{ state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: LINKED_TX, cardAccountId: `card-acct-${'a'.repeat(32)}` }],
    refunds: [],
    items: [
      { ref: 'amz-line-1a', title: KETTLE, asin: 'B0000000A1', quantity: 1, unitPrice: usd(2999), attribution: 'observation-only',
        category: 'Home', categorySource: 'agent-classification', confidence: 0.92 },
      { ref: 'amz-line-1b', title: FILTERS, asin: 'B0000000A2', quantity: 2, unitPrice: usd(450), attribution: 'observation-only',
        category: 'Kitchen', categorySource: 'item-override', confidence: null },
    ],
    summary: [
      { kind: 'items-subtotal', money: usd(3899) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(311) },
      { kind: 'grand-total', money: usd(4210) },
    ],
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '0001' }],
  },
  [amazonRef(3)]: {
    ref: amazonRef(3), date: '2026-09-28', total: usd(2000), beneficiary: 'alex', tenderCoverage: 'multi-tender',
    paymentCoverage: 'held', itemObservations: 1,
    matches: [{ state: 'held', evidenceClass: 'unique-total-match', reason: 'evidence-held', candidateCount: 0 }],
    refunds: [
      { ref: 'amz-refund-3a', status: 'issued', date: '2026-10-02', amount: usd(-1500), destination: 'card' },
      { ref: 'amz-refund-3b', status: 'issued', date: '2026-10-03', amount: usd(-500), destination: 'balance' },
    ],
    items: [{ ref: 'amz-line-3a', title: LAMP, asin: 'B0000000A3', quantity: 2, unitPrice: usd(1250), attribution: 'observation-only',
      category: 'Home', categorySource: 'agent-classification', confidence: 0.81 }],
    summary: [
      { kind: 'items-subtotal', money: usd(2500) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(0) },
      { kind: 'gift-card', money: usd(500) }, { kind: 'grand-total', money: usd(2000) },
    ],
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '0001' }, { kind: 'balance', network: 'unknown', last4: null }],
  },
};
/** A list row: the order's answer without its summary and methods, with trimmed items, as GET /amazon/orders gives it. */
const amazonRow = (detail: Json): Json => {
  const { summary: _summary, paymentMethods: _methods, items, ...rest } = detail;
  return { ...rest, items: (items as Json[]).map(({ ref, title, asin, quantity, category, categorySource }) =>
    ({ ref, title, asin, quantity, category, categorySource })) };
};
/** What was bought over a window, as GET /amazon/spending lists it: the two orders' items, every one priced. */
const amazonSpending = (key: string): Json => {
  const products = [
    { ref: 'amz-line-1a', title: KETTLE, asin: 'B0000000A1', category: 'Home', amountMinor: 2999, quantity: 1, order: 1, date: '2026-10-12' },
    { ref: 'amz-line-3a', title: LAMP, asin: 'B0000000A3', category: 'Home', amountMinor: 2500, quantity: 2, order: 3, date: '2026-09-28' },
    { ref: 'amz-line-1b', title: FILTERS, asin: 'B0000000A2', category: 'Kitchen', amountMinor: 900, quantity: 2, order: 1, date: '2026-10-12' },
  ].map((item) => ({
    ref: item.ref, currency: 'USD', title: item.title, asin: item.asin, category: item.category, categorySource: 'agent-classification',
    quantity: item.quantity, lines: 1, orders: 1, amountMinor: item.amountMinor, lastOrderDate: item.date, lastOrderRef: amazonRef(item.order),
  }));
  return {
    measure: 'amazon-order-item-prices-not-card-spending', window: { key, from: '2026-09-20', to: '2026-10-19' }, version: AMAZON_SUMMARY.version,
    orders: { count: 2, withTotal: 2, itemsComplete: 2, noLines: 0, refunded: 1, linked: 1, held: 1, unmatched: 0 },
    cardCharges: { linked: 1, itemized: 1 },
    lines: { count: 3, priced: 3, noPrice: 0, noQuantity: 0, categorized: 3 },
    totals: [{ currency: 'USD', orderTotalMinor: 6210, itemsCompleteOrderTotalMinor: 6210, itemMinor: 6399, categorizedMinor: 6399 }],
    categories: [
      { currency: 'USD', category: 'Home', amountMinor: 5499, lines: 2, products: 2, orders: 2 },
      { currency: 'USD', category: 'Kitchen', amountMinor: 900, lines: 1, products: 1, orders: 1 },
    ],
    products,
  };
};
const freshRef = (n: number) => amazonRef(200 + n);
const FRESH_ORDERS = [{ ref: freshRef(1), date: '2026-10-12' }, { ref: freshRef(2), date: '2026-09-20' }];
const freshFiled = (category: string, group: string, patch: Json = {}) => ({
  category, group, node: category, source: 'owner', confidence: 1, suggested: false, suggestion: null, ...patch,
});
const freshProduct = (n: number, title: string, where: Json, order: { ref: string; date: string }, amountMinor: number, patch: Json = {}) => {
  const purchase = { ref: amazonRef(100 + n), orderRef: order.ref, orderDate: order.date, status: 'listed', quantity: 1, weight: null,
    unitPrice: { money: usd(amountMinor), per: 'each' }, amountMinor, refundMinor: 0, ...patch };
  return {
    ref: purchase.ref, currency: 'USD', title, asin: null, ...where, amountMinor, refundMinor: purchase.refundMinor,
    netMinor: amountMinor - purchase.refundMinor, lines: 1, orders: 1, quantity: 1, weight: null, lastUnitPrice: purchase.unitPrice,
    lastOrderDate: order.date, lastOrderRef: order.ref, purchases: [purchase],
  };
};
const FRESH = {
  measure: 'amazon-fresh-item-prices-not-card-spending', window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' }, captured: true,
  taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'present' },
  orders: { count: 2, withTotal: 2, complete: 1, reconciled: 1, refunded: 1, unreadable: 0, noLines: 0 },
  lines: { count: 4, priced: 3, noPrice: 0, missing: 1, substituted: 1, estimated: 0, categorized: 3, suggested: 0, needsReview: 1,
    refunded: 0, unreadable: 0 },
  totals: [{ currency: 'USD', orderTotalMinor: 3200, lineMinor: 2647, groceryMinor: 1348, categorizedMinor: 2298, suggestedMinor: 0,
    needsReviewMinor: 349, refundMinor: 500, lineRefundMinor: 0, unattributedRefundMinor: 500, netLineMinor: 2147 }],
  categories: [
    { currency: 'USD', category: 'groceries/dairy-eggs', group: 'groceries', amountMinor: 898, refundMinor: 0, netMinor: 898, lines: 1, refundedLines: 0, products: 1, orders: 1 },
    { currency: 'USD', category: 'groceries/produce', group: 'groceries', amountMinor: 450, refundMinor: 0, netMinor: 450, lines: 1, refundedLines: 0, products: 1, orders: 1 },
    { currency: 'USD', category: 'household', group: 'other', amountMinor: 950, refundMinor: 0, netMinor: 950, lines: 1, refundedLines: 0, products: 1, orders: 1 },
    { currency: 'USD', category: 'needs-review', group: 'needs-review', amountMinor: 349, refundMinor: 0, netMinor: 349, lines: 1, refundedLines: 0, products: 1, orders: 1 },
  ],
  products: [
    freshProduct(1, 'Sample Large Brown Eggs, 12 Count', freshFiled('groceries/dairy-eggs', 'groceries'), FRESH_ORDERS[0], 898),
    freshProduct(2, 'Sample Organic Apples', freshFiled('groceries/produce', 'groceries'), FRESH_ORDERS[1], 450, { status: 'substituted' }),
    freshProduct(3, 'Sample Paper Towels, 6 Rolls', freshFiled('household', 'other'), FRESH_ORDERS[0], 950),
    freshProduct(4, 'Sample Mystery Snack Mix', freshFiled('needs-review', 'needs-review', { source: null, confidence: null,
      suggestion: { node: 'groceries/snacks-sweets', confidence: 0.5 } }), FRESH_ORDERS[1], 349),
  ],
  orderList: [
    { ...FRESH_ORDERS[0], total: usd(2050), lines: 2, priced: 2, missing: 0, substituted: 0, unreadable: 0, unreadRows: 0, lineTotal: usd(1848),
      complete: true, reconciled: true, refund: null },
    { ...FRESH_ORDERS[1], total: usd(1150), lines: 3, priced: 2, missing: 1, substituted: 1, unreadable: 0, unreadRows: 1, lineTotal: usd(799),
      complete: false, reconciled: false, refund: { currency: 'USD', refundMinor: 500, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 500 } },
  ],
};
const freshLine = (n: number, title: string, status: string, amountMinor: number | null, where: Json, patch: Json = {}) => ({
  ref: amazonRef(300 + n), lineOrdinal: n, title, asin: null, status, quantity: 1, weight: null,
  unitPrice: amountMinor === null ? null : { money: usd(amountMinor), per: 'each' }, linePrice: amountMinor === null ? null : usd(amountMinor),
  replaces: null, ...where, refundMinor: 0, ...patch,
});
const FRESH_LIST = { order: { ref: FRESH_ORDERS[1].ref, date: FRESH_ORDERS[1].date, total: usd(1150),
  refund: { currency: 'USD', refundMinor: 500, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 500 },
  list: { statedCount: 4, rows: 4, unreadRows: 1, lines: 3, unreadable: 0, complete: false, reconciled: false },
  lines: [
    freshLine(0, 'Sample Organic Apples', 'substituted', 450, freshFiled('groceries/produce', 'groceries'), { replaces: 'Sample Gala Apples' }),
    freshLine(1, 'Sample Mystery Snack Mix', 'listed', 349, freshFiled('needs-review', 'needs-review', { source: null, confidence: null,
      suggestion: { node: 'groceries/snacks-sweets', confidence: 0.5 } })),
    freshLine(2, 'Sample Blueberries, 6 oz', 'missing', 399, freshFiled('needs-review', 'needs-review', { source: null, confidence: null })),
  ] } };

async function serveAmazon(page: Page): Promise<void> {
  await page.route((url) => url.pathname.startsWith('/amazon/'), (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return json(route, { error: 'read only' }, 405);
    if (url.pathname === '/amazon/summary') return json(route, AMAZON_SUMMARY);
    if (url.pathname === '/amazon/orders') {
      const rows = Object.values(AMAZON_ORDERS).map(amazonRow);
      return json(route, { total: rows.length, orders: rows });
    }
    if (url.pathname === '/amazon/spending') return json(route, amazonSpending(url.searchParams.get('window') ?? '30D'));
    if (url.pathname === '/amazon/fresh' && (url.searchParams.get('window') ?? '1Y') === '1Y') return json(route, FRESH);
    if (url.pathname === `/amazon/fresh/orders/${FRESH_ORDERS[1].ref}`) return json(route, FRESH_LIST);
    const detail = /^\/amazon\/orders\/([^/]+)$/.exec(url.pathname);
    const order = detail ? AMAZON_ORDERS[decodeURIComponent(detail[1])] : undefined;
    return order ? json(route, { order }) : json(route, { error: 'not-found' }, 404);
  });
}

// ---- Sync and devices with cards and browsers: the owner API's synthetic fake (as modes.e2e.ts and spending-sync.e2e.ts) ----

async function serveOwner(page: Page): Promise<void> {
  const fake = new FakeOwnerServer({ scenario: 'demo', recentAuth: 'granted' });
  const accounts = fakeCardAccounts(FAKE_NOW);
  const owners = new Map<string, CardOwner>(accounts.map((account) => [account.id, account.owner]));
  await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/card-accounts') return json(route, { cardAccounts: accounts });
    if (url.pathname === '/spending/coverage') return json(route, { cards: [] });
    if (url.pathname === '/spending/summary') return json(route, { ...summarizeCardSpending([], { owners }), categories: [] });
    if (url.pathname === '/spending/insights') return json(route, computeCardInsights([], { month: '2026-10', today: '2026-10-17', currency: 'USD' }));
    if (url.pathname === '/card-transactions') return json(route, { transactions: [], total: 0, limit: 100, offset: 0, nextOffset: null });
    return json(route, { error: 'not found' }, 404);
  });
  await page.route((url) => url.pathname.startsWith('/card-sync/') && !url.pathname.startsWith('/card-sync/owner/'),
    (route) => json(route, { error: 'not found' }, 404));
  await page.route((url) => url.pathname.startsWith('/card-sync/owner/') || url.pathname === '/auth/reverify', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const sent = Object.fromEntries(Object.entries(await request.allHeaders()).map(([key, value]) => [key.toLowerCase(), value]));
    const response = await fake.handle({ method: request.method(), url: `${url.pathname}${url.search}`, headers: sent, body: request.postData() });
    await json(route, response.body, response.status);
  });
  await page.clock.setFixedTime(new Date(FAKE_NOW));
}

/**
 * Every route of both modes at this width, as each opens: Investing's, the portfolio again overnight, then Everyday's with
 * this file's card on its transactions.
 */
async function everyRoute(page: Page, request: APIRequestContext, width: number, each: (where: string) => Promise<void>): Promise<void> {
  for (const hash of INVESTING) {
    await open(page, hash);
    await each(`${hash} at ${width}px`);
  }
  await openOvernight(page);
  await each(`#/investing/portfolio overnight at ${width}px`);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await openCard(page, await card(request));
  await each(`#/everyday/transactions at ${width}px`);
  for (const hash of EVERYDAY) {
    await open(page, hash);
    await each(`${hash} at ${width}px`);
  }
}

// ---- The Gold page (G4): the synthetic metals ledger, loaded through the operator's install and import (metalsStack.ts) ----

/** The Gold page on a metal, at rest: over its default period (6M), or over All. */
async function openGold(page: Page, metal: 'Gold' | 'Silver' = 'Gold', period: '6M' | 'All' = '6M'): Promise<void> {
  await open(page, '#/investing/gold');
  await expect(page.getByTestId('gold-summary')).toBeVisible();
  if (metal === 'Silver') {
    await page.getByRole('group', { name: 'Metal' }).getByRole('button', { name: 'Silver', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Silver', exact: true })).toBeVisible();
  }
  if (period === 'All') {
    const all = page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'All', exact: true });
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByTestId('gold-page')).toHaveAttribute('aria-busy', 'false');
}

/** Details, opened: what to check, each purchase with its card charge, sales, holdings and coverage. */
async function openGoldDetails(page: Page): Promise<void> {
  const details = page.getByTestId('gold-details');
  await details.locator(':scope > summary').click();
  await expect(details).toHaveJSProperty('open', true);
}

/** The compact confirm card, opened on "Review products" onto its grouped products. */
async function reviewGoldProducts(page: Page): Promise<void> {
  const review = page.getByTestId('gold-confirm').getByTestId('gold-review-products');
  await review.click();
  await expect(review).toHaveAttribute('aria-expanded', 'true');
}

/**
 * A list row by its own name ("Sep 10, 2026 · …", its date first), never by text in another row's opened details (a card
 * charge or a delivery on that day, say): G1d's review of v0.
 */
const goldRow = (page: Page, testId: string, date: string) => page.getByTestId(testId)
  .filter({ has: page.locator('.gold-row-name', { hasText: new RegExp(`^${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) });

/**
 * Astra's exact-head review works from this run's own captures: each Gold state, once its floors are checked, saved
 * whole as `gold-<view>-<state>.png` beside the run's results (synthetic data only). The view is the CSS viewport width
 * at DPR 1 (`375`, `1920`); `640dpr2`, a 640 CSS px viewport at DPR 2, is the layout width and density 200% zoom gives a
 * 1280 px window, reflow evidence only; and `browserzoom200` is the real thing: a 1280 px window that the browser itself
 * zooms to 200% (chrome.tabs.setZoom, tests/browserZoom.ts), checked in the page at every capture (DPR 2, 640 CSS px).
 * There, the state is what the screen shows, top to bottom: viewport tiles `gold-browserzoom200-<state>-tNN.png`, each
 * at the offset the page reached, listed with those offsets in `gold-browserzoom200-<state>.tiles.json`, and held to
 * being complete (from the top to the end, no gap, nothing past the right-hand edge).
 */
async function captureGold(page: Page, width: number, state: string, browserZoomed: boolean): Promise<void> {
  const { dpr, innerWidth } = await page.evaluate(() => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth }));
  if (browserZoomed) {
    expect({ dpr, innerWidth }, `the browser's 200% zoom, still in effect for ${state}`).toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
  }
  const view = browserZoomed ? 'browserzoom200' : dpr === 1 ? String(width) : `${width}dpr${dpr}`;
  if (browserZoomed) {
    const { tiles, problems } = await captureTiles(page, (index) => test.info().outputPath(`gold-${view}-${state}-t${String(index).padStart(2, '0')}.png`));
    writeFileSync(test.info().outputPath(`gold-${view}-${state}.tiles.json`), `${JSON.stringify({ state, view, tiles, problems }, null, 2)}\n`);
    expect.soft(problems, `${state}: its tiles at the browser's 200% zoom are the whole page`).toEqual([]);
    return;
  }
  await page.screenshot({ path: test.info().outputPath(`gold-${view}-${state}.png`), fullPage: true, animations: 'disabled' });
}

/**
 * Every state of the Gold page that Astra's review names (her accepted round 4, as built), each held to its floor at
 * `width`: as it opens (6M: the totals over all recorded history, the compact confirm card, the period's money apart
 * from what is held, values at spot off as Holdr ships, the rewards' "rate needed", the stack's stored closes with prices
 * off); the totals with their folds open (why they are incomplete, what they include, the metals together), their profit
 * or loss unavailable; over All, partial and unknown in one completeness line, the sale profit for the covered sales;
 * the confirm card opened from its Review onto the grouped products; Details with what to check and its notes; a sale
 * with no recorded purchase; a sale with its assigned purchase (its profit or loss before rewards); how rewards are
 * estimated;
 * silver on the stack (deliveries short, unknown profit, prices off); where closes are fetched, served in the browser:
 * silver at a stale close, and gold with its closes read (the line, its endpoints, a gap, each trade; what was held on
 * cost and value); a closes read that fails, with Retry; a confirmation's preview, "Confirm all as proposed" previewed, a
 * linked charge opened in place, a stale preview refused, a confirmed product and its undo's preview; and, served in the
 * browser, the states a stack can't reach: not set up, a read that fails, no close stored (prices off), installed with
 * nothing imported yet, a metal holding none ($0.00 at spot) while units bought of unresolved metal are kept (G1d), and
 * everything recorded sold with units sold that no recorded purchase covers: the holding's ounces unknown, said why (ROOT).
 * Each is captured for the review as its opener leaves it, before the sweep opens its folds; `browserZoomed` says the
 * page is in the browser-zoomed window (captureGold).
 */
async function goldStates(page: Page, request: APIRequestContext, width: number, browserZoomed = false): Promise<void> {
  const stack = await metalsStack(request);
  const capture = (state: string) => () => captureGold(page, width, state, browserZoomed);
  await expectStates(page, width, '#/investing/gold as it opens: 6M, the compact confirm card, the summary, prices off',
    () => openGold(page), capture('opens-6m'));
  await expectStates(page, width, '#/investing/gold totals: unavailable with why, what they include, the metals together', async () => {
    await openGold(page);
    const totals = page.getByTestId('gold-totals');
    await totals.getByTestId('gold-totals-why').getByRole('button', { name: 'Why these totals are incomplete' }).click();
    await totals.getByRole('button', { name: 'What this includes' }).click();
    await totals.getByTestId('gold-totals-combined').getByRole('button', { name: 'Gold and silver combined' }).click();
    await expect(totals.getByTestId('gold-combined-result')).toBeVisible();
  }, capture('totals'));
  await expectStates(page, width, '#/investing/gold over All: partial and unknown, in one completeness line', async () => {
    await openGold(page, 'Gold', 'All');
    await expect(page.getByTestId('gold-summary-warning')).toBeVisible();
  }, capture('all-partial-unknown'));
  await expectStates(page, width, 'the confirm card opened from the completeness line\'s Review: its grouped products', async () => {
    await openGold(page, 'Gold', 'All');
    await page.getByTestId('gold-summary-warning').getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByTestId('gold-confirm').getByRole('heading', { name: 'Confirm product contents' })).toBeFocused();
  }, capture('review-products'));
  await expectStates(page, width, '#/investing/gold Details: what to check and its notes', async () => {
    await openGold(page, 'Gold', 'All');
    await openGoldDetails(page);
    await page.getByTestId('gold-to-check').getByRole('button', { name: /^\d+ notes$/ }).click();
  }, capture('details-notes'));
  await expectStates(page, width, '#/investing/gold: a sale with no recorded purchase, opened', async () => {
    await openGold(page, 'Gold', 'All');
    await openGoldDetails(page);
    const sale = goldRow(page, 'gold-sale', longDate(stack.dates.unmatchedSale));
    await sale.locator('.gold-row-toggle').click();
    await expect(sale.getByTestId('gold-unmatched')).toBeVisible();
  }, capture('unmatched-sale'));
  // A sale's assigned purchase, opened: its profit or loss before rewards (ROOT).
  await expectStates(page, width, '#/investing/gold: a sale with its assigned purchase, opened', async () => {
    await openGold(page, 'Gold', 'All');
    await openGoldDetails(page);
    const sale = goldRow(page, 'gold-sale', longDate(stack.dates.barSale));
    await sale.locator('.gold-row-toggle').click();
    await expect(sale.getByTestId('gold-cycle')).toContainText('Profit/loss before rewards');
  }, capture('sale-cycle'));
  await expectStates(page, width, '#/investing/gold: how rewards are estimated, each card and membership "rate needed"', async () => {
    await openGold(page, 'Gold', 'All');
    const rewards = page.getByTestId('gold-rewards');
    await rewards.getByRole('button', { name: 'How rewards are estimated' }).click();
    await expect(rewards.getByTestId('gold-rewards-cards')).toBeVisible();
  }, capture('rewards'));
  // Silver on this stack's own reads (prices off: its stored closes value nothing, ROOT O110): deliveries short of what
  // was sold, a profit or loss with nothing known.
  await expectStates(page, width, '#/investing/gold on silver: deliveries short, unknown profit, prices off',
    () => openGold(page, 'Silver'), capture('silver'));
  // Where closes are fetched, served in the browser (goldPricesOn.ts), its closes read agreeing with the overview's own
  // close: silver at a stale close; then gold over All (the served purchase, sale and months are older than 6M), values at
  // spot, the price line with each trade, and what was held on cost and value.
  await pricesOn(page);
  await expectStates(page, width, '#/investing/gold on silver where closes are fetched, served: a stale close',
    () => openGold(page, 'Silver'), capture('silver-stale-close'));
  await expectStates(page, width, '#/investing/gold where closes are fetched, served: values at spot, the price line with each trade, what was held on cost and value', async () => {
    await openGold(page, 'Gold', 'All');
    await expect(page.getByTestId('gold-value')).not.toHaveText(/Prices off|No price yet/);
    await expect(page.getByTestId('gold-price-chart').locator('polyline.gold-plot-spot').first()).toBeVisible();
    await expect(page.getByTestId('gold-held-chart').locator('circle.gold-plot-value').first()).toBeVisible();
  }, capture('prices-on'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // Daily prices that can't be read just now: said so, with Retry, never as "no close stored".
  await page.route((url) => url.pathname === '/metals/closes', (route) => json(route, { error: 'Synthetic failure' }, 500));
  await expectStates(page, width, '#/investing/gold when its daily prices can\'t be read: said so, with Retry', async () => {
    await openGold(page);
    await expect(page.getByTestId('gold-closes-error')).toBeVisible();
  }, capture('closes-error'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const product = () => page.getByTestId('gold-confirm-row').filter({ hasText: COSTCO_PRODUCT_TITLE })
    .filter({ has: page.getByTestId('gold-proposal') });
  await expectStates(page, width, 'a confirmation\'s preview', async () => {
    await openGold(page);
    await reviewGoldProducts(page);
    await product().getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(product().getByTestId('gold-preview')).toBeVisible();
  }, capture('confirm-preview'));
  await expectStates(page, width, '"Confirm all as proposed", previewed (nothing saved)', async () => {
    await openGold(page);
    await reviewGoldProducts(page);
    const all = page.getByTestId('gold-confirm').locator('.gold-confirm-all');
    await all.getByRole('button', { name: /^Confirm all as proposed \(\d+\)$/ }).click();
    await all.getByRole('button', { name: /^Preview all \d+$/ }).click();
    await expect(all.getByTestId('gold-confirm-all-preview').first()).toBeVisible();
  }, capture('confirm-all-preview'));
  await expectStates(page, width, 'a linked card charge opened in place', async () => {
    await openGold(page, 'Gold', 'All');
    await openGoldDetails(page);
    const purchase = goldRow(page, 'gold-purchase', longDate(stack.dates.walmartLinked));
    await purchase.locator('.gold-row-toggle').click();
    await purchase.getByRole('button', { name: 'Open charge', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }, capture('linked-charge'));
  try {
    // Confirmed elsewhere while its preview was open: nothing is saved twice, and the page says so.
    await expectStates(page, width, 'a stale preview: the product confirmed meanwhile, nothing saved twice', async () => {
      await openGold(page);
      await reviewGoldProducts(page);
      await product().getByRole('button', { name: 'Preview', exact: true }).click();
      const preview = product().getByTestId('gold-preview');
      await expect(preview).toBeVisible();
      await confirmCostcoProduct(request);
      await preview.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByTestId('gold-confirm-status')).toHaveText(/^Something changed since this preview, so nothing was saved\./);
      // The page reads its lists again after the refused write: captured once they are in, never marked as updating.
      await expect(page.getByTestId('gold-page')).toHaveAttribute('aria-busy', 'false');
    }, capture('confirm-stale'));
    await expectStates(page, width, 'a confirmed product and its undo\'s preview', async () => {
      await openGold(page);
      await reviewGoldProducts(page);
      await page.getByTestId('gold-confirm').getByRole('button', { name: /^Confirmed by you \(\d+\)$/ }).click();
      const done = page.getByTestId('gold-confirm-row').filter({ has: page.getByTestId('gold-decision') }).first();
      await done.getByRole('button', { name: 'Undo…', exact: true }).click();
      await expect(done.getByTestId('gold-preview')).toBeVisible();
    }, capture('confirmed-undo-preview'));
  } finally {
    await undoCostcoProduct(request);
  }
  await page.route((url) => url.pathname.startsWith('/metals/'), (route) => json(route, { installed: false }));
  await expectStates(page, width, '#/investing/gold not set up', () => open(page, '#/investing/gold'), capture('not-set-up'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route((url) => url.pathname.startsWith('/metals/'), (route) => json(route, { error: 'Synthetic failure' }, 500));
  await expectStates(page, width, '#/investing/gold when a read fails', () => open(page, '#/investing/gold'), capture('read-fails'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // No close stored, as Holdr ships (prices off): every value at spot says so, one consistent state; the price chart says
  // prices are off, and what was held shows its cost alone. Each read answered for the metal and period asked (answeredFor).
  await page.route((url) => url.pathname.startsWith('/metals/'), (route) => {
    const url = new URL(route.request().url());
    return json(route, answeredFor(url, priceMissingAnswer(url.pathname)));
  });
  await expectStates(page, width, '#/investing/gold with no close stored, prices off', async () => {
    await openGold(page);
    await expect(page.getByTestId('gold-closes-off')).toBeVisible();
  }, capture('prices-off'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // Installed, nothing imported yet.
  await page.route((url) => url.pathname.startsWith('/metals/'), (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    return json(route, answeredFor(url, path === '/metals/overview' ? overviewFixture({ coverage: [] }) : priceMissingAnswer(path)));
  });
  await expectStates(page, width, '#/investing/gold installed with nothing imported yet', () => open(page, '#/investing/gold'), capture('nothing-imported'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // Values shown at a fresh close, the metal holding none ($0.00), while 3 units bought have an unresolved metal (G1d):
  // said beside the holding's ounces and value, and under what was held.
  const none = overviewFixture();
  await page.route((url) => url.pathname.startsWith('/metals/'), (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    return json(route, answeredFor(url, path === '/metals/overview'
      ? {
        ...none,
        holdings: {
          ...none.holdings,
          troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), valueMinor: complete(0), gainMinor: complete(0),
          units: { ...none.holdings.units, delivered: 0, sold: 0, soldFromDelivered: 0, held: 0 }, classes: [], bySource: [],
        },
        metalUnknown: { lots: 3, units: 3, costMinor: 750_000, sales: 0, saleNetMinor: 0 },
        toCheck: { records: 3, needsYou: [], forInformation: [{ code: 'metal-unknown', records: 3 }] },
      }
      : priceMissingAnswer(path, true)));
  });
  await expectStates(page, width, '#/investing/gold holding none while units of unresolved metal are kept', async () => {
    await openGold(page);
    await expect(page.getByTestId('gold-held-unresolved')).toBeVisible();
  }, capture('unresolved-metal'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // Every recorded purchase sold, and 2 units sold that never had a recorded purchase, over All, prices off (ROOT): the
  // ounces unknown, never a zero, and the holding says why in words; every read agrees (soldOutAnswer).
  await page.route((url) => url.pathname.startsWith('/metals/'), (route) => {
    const url = new URL(route.request().url());
    return json(route, answeredFor(url, soldOutAnswer(url.pathname)));
  });
  await expectStates(page, width, '#/investing/gold with everything recorded sold and units sold with no recorded purchase', async () => {
    await openGold(page, 'Gold', 'All');
    await expect(page.getByTestId('gold-held-why')).toBeVisible();
  }, capture('held-unknown'));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
}

test.describe('signed in', () => {
  test.beforeEach(async ({ request }) => {
    await requireHealthyApi(request);
  });

  for (const width of [PHONE, WIDE]) {
    test(`Investing at ${width}px: every route and state, at its floor`, async ({ page }) => {
      test.setTimeout(600_000);
      await page.setViewportSize({ width, height: 900 });
      for (const hash of INVESTING) await expectStates(page, width, hash, () => open(page, hash));
      // Overnight: the panel open and its prices in holdings (the household banner shows); then off again.
      await expectStates(page, width, '#/investing/portfolio overnight, its panel open and in holdings', async () => {
        await openOvernight(page);
        const panel = page.getByRole('region', { name: 'Overnight prices' });
        const header = panel.locator('.indicative-header > button[aria-expanded]');
        await header.click();
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        const use = panel.getByRole('switch', { name: 'Use overnight prices' });
        await use.click();
        await expect(use).toHaveAttribute('aria-checked', 'true');
        await settle(page);
        // On a phone its prices read as labelled blocks, a table on wider screens; assistive tech gets the same table
        // at every width: the table, its five column heads, and a row head and four cells for each symbol.
        const symbols = await panel.locator('.indicative-table > tbody > tr').count();
        expect(symbols).toBeGreaterThan(0);
        expect(await exposedRoles(page, '.indicative-table', ['table', 'columnheader', 'rowheader', 'cell']), `${width}px`)
          .toEqual({ table: 1, columnheader: 5, rowheader: symbols, cell: symbols * 4 });
        await expect(panel.getByRole('columnheader')).toHaveCount(5);
        await expect(panel.getByRole('cell')).toHaveCount(symbols * 4);
      });
      const use = page.getByRole('switch', { name: 'Use overnight prices' });
      if ((await use.count()) > 0 && await use.getAttribute('aria-checked') === 'true') await use.click();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // The server unreachable (the page keeps what it read before, and says so).
      await serveOffline(page);
      for (const hash of ['#/investing/portfolio', '#/investing/transactions']) {
        await expectStates(page, width, `${hash} with the server unreachable`, async () => {
          await open(page, hash);
          await expect(page.locator('.cache-banner')).toBeVisible();
        });
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // No accounts.
      await serveNoAccounts(page);
      for (const hash of INVESTING) await expectStates(page, width, `${hash} with no accounts`, () => open(page, hash));
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // A holding's price unavailable (GOOGL's withheld, with the page's saved quotes cleared): the household's value
      // and the value of the account holding it say why instead of a figure, in the portfolio chart and in that
      // account's own value chart.
      await serveQuotesWithout(page, 'GOOGL');
      await expectStates(page, width, '#/investing/portfolio with a price unavailable, its account\'s chart open', async () => {
        await open(page, '#/investing/portfolio');
        await page.evaluate(() => localStorage.removeItem('finance-tracker:quotes:v1'));
        await page.reload();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await expect(page.locator('.breakdown > .portfolio-chart')).toContainText('Price unavailable for 1 holding');
        const account = page.locator('.breakdown > .account:not(.combined)').filter({ has: page.locator('td.sym', { hasText: /^GOOGL/ }) }).first();
        await account.locator('.account-header button.chart-toggle').click();
        await expect(account.locator('.portfolio-chart')).toContainText('Price unavailable for 1 holding');
      });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    test(`Everyday's card transactions at ${width}px: every state, a transaction's details, the import and Manage cards`, async ({ page, request }) => {
      test.setTimeout(600_000);
      await page.setViewportSize({ width, height: 900 });
      const id = await card(request);
      await expectStates(page, width, '#/everyday/transactions', () => openCard(page, id));
      // A transaction's details: the 16-day pending charge, a purchase, a possible bullion purchase and the card payment.
      for (const merchant of ['READABILITY PARKADE', 'READABILITY STATIONER', 'READABILITY BULLION', 'READABILITY AUTOPAY']) {
        await expectStates(page, width, `a transaction's details (${merchant})`, async () => {
          await openCard(page, id);
          await page.locator('.spending-transactions').getByRole('button', { name: new RegExp(`^${merchant}, `) }).click();
          await expect(page.getByRole('dialog', { name: merchant, exact: true })).toBeVisible();
          await settle(page);
        });
      }
      // The card import: as it opens, then a statement's preview (never imported).
      const openImport = async () => {
        await openCard(page, id);
        await page.getByRole('button', { name: 'Import', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Import card spending' })).toBeVisible();
      };
      await expectStates(page, width, 'the card import, as it opens', openImport);
      await expectStates(page, width, 'the card import, its preview', async () => {
        await openImport();
        const dialog = page.getByRole('dialog', { name: 'Import card spending' });
        await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(STATEMENT) });
        await dialog.getByRole('combobox', { name: 'Card account' }).selectOption(id);
        await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
        await settle(page);
      });
      // Manage cards, then a card's confirmation (never confirmed).
      const openManager = async () => {
        await openCard(page, id);
        await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Manage cards' })).toBeVisible();
        await settle(page);
      };
      await expectStates(page, width, 'Manage cards', openManager);
      await expectStates(page, width, 'Manage cards, a card\'s confirmation', async () => {
        await openManager();
        await page.getByRole('dialog', { name: 'Manage cards' }).getByRole('button', { name: /^Mark closed: / }).first().click();
        await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      });
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      // Card payments and checking, served: Review holds a group for the owner, and a payment and a withdrawal are left.
      await servePayments(page, id);
      await expectStates(page, width, 'card payments and checking, with payments to review', async () => {
        await openCard(page, id);
        await expect(page.getByTestId('payments-headline')).toContainText('to review');
      });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    test(`Everyday's other areas at ${width}px: as the stack has them, and with cards, orders and browsers served`, async ({ page }) => {
      test.setTimeout(600_000);
      await page.setViewportSize({ width, height: 900 });
      // As the stack has them: no Amazon orders, no card with a product, no owner sync API.
      for (const hash of EVERYDAY) await expectStates(page, width, hash, () => open(page, hash));
      // Benefits with cards and credits.
      await serveBenefits(page);
      await page.clock.setFixedTime(new Date(`${BENEFITS_TODAY}T12:00:00`));
      await expectStates(page, width, '#/everyday/benefits with cards and credits', async () => {
        await open(page, '#/everyday/benefits');
        await expect(page.locator('.benefits-summary')).toBeVisible();
      });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // Amazon orders, an order's page and Amazon Fresh.
      await serveAmazon(page);
      await page.clock.setFixedTime(new Date('2026-10-19T12:00:00'));
      await expectStates(page, width, '#/everyday/amazon with orders', async () => {
        await open(page, '#/everyday/amazon');
        await expect(page.locator('li.amazon-order').first()).toBeVisible();
      });
      await expectStates(page, width, 'an Amazon order\'s page', async () => {
        await open(page, `#/everyday/amazon/orders/${amazonRef(1)}`);
        await expect(page.locator('h3#amazon-page-title')).toBeVisible();
      });
      await expectStates(page, width, '#/everyday/amazon/fresh with orders', async () => {
        await open(page, '#/everyday/amazon/fresh');
        await expect(page.locator('.amazon-fresh')).toBeVisible();
      });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // Sync and devices with cards and browsers.
      await serveOwner(page);
      for (const hash of ['#/everyday/sync', '#/everyday/devices']) {
        await expectStates(page, width, `${hash} with cards and browsers`, async () => {
          await open(page, hash);
          await settle(page);
        });
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // No cards at all; then a read that fails.
      await serveNoCards(page);
      await expectStates(page, width, '#/everyday/transactions with no cards', () => open(page, '#/everyday/transactions'));
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.route((url) => url.pathname === '/spending/summary', (route) => json(route, { error: 'Synthetic failure' }, 500));
      await expectStates(page, width, '#/everyday/transactions when a read fails', () => open(page, '#/everyday/transactions'));
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
  }

  for (const width of [PHONE, WIDE]) {
    test(`the Gold page at ${width}px: partial and unknown, a confirmation and its undo, a charge opened in place, at its floor`, async ({ page, request }) => {
      test.setTimeout(600_000);
      await page.setViewportSize({ width, height: 900 });
      await goldStates(page, request, width);
    });
  }

  test('larger type never cuts an account\'s masked number: the card\'s line wraps instead (visual review of #234)', async ({ page }) => {
    for (const width of [PHONE, 390, WIDE]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, '#/investing/accounts');
      await expect(page.locator('.accounts-card-meta').nth(1)).toBeVisible();
      const metas = await page.locator('.accounts-card-meta').evaluateAll((nodes) => nodes.map((meta) => {
        const number = [...meta.querySelectorAll('span')].find((span) => /\d/.test(span.textContent ?? ''));
        const box = number?.getBoundingClientRect();
        const own = meta.getBoundingClientRect();
        const value = meta.closest('.accounts-card-header')!.querySelector('.accounts-card-cash')!.getBoundingClientRect();
        return {
          number: number?.textContent ?? '',
          // Nothing overflows the line, so nothing of it is cut off.
          cut: meta.scrollWidth > meta.clientWidth + 0.5,
          // The number sits whole inside the line, clear of the value beside it.
          inside: !box || (box.left >= own.left - 0.5 && box.right <= own.right + 0.5),
          clear: !box || box.right <= value.left || box.left >= value.right || box.bottom <= value.top || box.top >= value.bottom,
        };
      }));
      expect(metas.filter((meta) => meta.number).length, `${width}px`).toBeGreaterThan(1);
      for (const meta of metas) expect(meta, `${width}px`).toEqual({ number: meta.number, cut: false, inside: true, clear: true });
    }
  });

  test.describe('at 200% zoom', () => {
    // A 1280px window at 200%: a 640px page drawn at twice the pixels.
    test.use({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });

    test('every route keeps its floors, and no page scrolls sideways', async ({ page, request }) => {
      test.setTimeout(240_000);
      await everyRoute(page, request, 640, async (where) => {
        expect.soft(await sweep(page, 640), where).toEqual([]);
        expect.soft(await sideways(page), `${where}: sideways`).toBeLessThanOrEqual(0);
      });
    });

    test('the Gold page keeps its floors in every state Astra reviews, and never scrolls sideways', async ({ page, request }) => {
      test.setTimeout(600_000);
      await goldStates(page, request, 640);
    });
  });

  test.describe('at a real 200% browser zoom', () => {
    // A 1280 px headless window that the browser itself zooms to 200% (chrome.tabs.setZoom through the test-only extension,
    // tests/browserZoom.ts), not a device-pixel-ratio emulation: checked in the page before the states and at every capture.
    test('the Gold page keeps its floors in every state Astra reviews, zoomed to 200% by the browser itself', async ({ request, baseURL }) => {
      test.setTimeout(600_000);
      if (!baseURL) throw new Error('baseURL is required');
      const zoomable = await launchZoomable(baseURL);
      try {
        const guard = await watchOrigin(zoomable.context, baseURL, { commandLine: zoomable.commandLine });
        const { cookies } = JSON.parse(readFileSync(AUTH_STATE_FILE, 'utf8')) as { cookies: Parameters<BrowserContext['addCookies']>[0] };
        await zoomable.context.addCookies(cookies);
        const page = await zoomable.context.newPage();
        await guard.watch(page);
        // The app's origin first: the browser keeps a zoom per origin, so it holds across every page and reload below.
        await open(page, '#/investing/gold');
        await fitWindow(page);
        const viewport = () => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth });
        expect(await page.evaluate(viewport), 'the window at 100%').toEqual({ dpr: 1, innerWidth: ZOOM_WINDOW.width });
        expect(await zoomable.zoom(2), 'the zoom the browser reports').toBe(2);
        await expect.poll(() => page.evaluate(viewport), { message: 'the window at 200%' }).toEqual({ dpr: 2, innerWidth: ZOOM_WINDOW.width / 2 });
        await goldStates(page, request, ZOOM_WINDOW.width / 2, true);
        await expectNoForeignTraffic(guard, 'the browser-zoomed window');
      } finally {
        await zoomable.close();
      }
    });
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const width of [PHONE, WIDE]) {
    test(`the sign-in screen at ${width}px, and a refused sign-in: every text at its floor`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.locator('.login-form')).toBeVisible();
      expect(await sweep(page, width), 'as it opens').toEqual([]);
      // A refused sign-in, answered here: nothing reaches the server's sign-in.
      await page.route((url) => url.pathname === '/auth/login', (route) => json(route, { error: 'Invalid username or password' }, 401));
      await page.getByLabel('Username').fill('synthetic');
      await page.getByLabel('Password').fill('not-the-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('.login-form .form-error')).toBeVisible();
      expect(await sweep(page, width), 'refused').toEqual([]);
    });
  }
});

/**
 * No exceptions, now or later (Root's ruling for T2). Until wave 1 merged, T1's sweep skipped the rules below the floors
 * in the CSS other sessions owned (a list of them, by owner). Every one of them is listed here, as T1 had it, and each
 * must be reported once more when its text is below its floor, as must an inline size, a warning drawn as a badge, a
 * badge below 13px, reading text below 16px, a section head below 18px, running text that wraps at line-height 1.2, a
 * heading at 1 and a paragraph wider than 65ch.
 */
const FORMER_EXCEPTIONS = [
  // A: the overview.
  '.overview-block h4', '.overview-chart-note', '.overview-chip', '.overview-toggle', '.overview-crumbs', '.overview-error',
  '.overview-gaps', '.overview-legend', '.overview-list > li', '.overview-changes > li', '.overview-row', '.overview-month',
  '.overview-note-fold > .fold-toggle', '.overview-note-reasons', '.overview-part', '.overview-so-far', '.overview-unsplit',
  '.overview-warning',
  // D: card openings.
  '.openings-assert', '.openings-detail', '.openings-flag', '.openings-flag-note', '.openings-intro', '.openings-month',
  '.openings-note', '.openings-notice', '.openings-prefill', '.openings-problem', '.openings-row', '.overview-opened',
  '.overview-opened-note',
  // E: the forecast.
  '.forecast-bill-date', '.forecast-bill-evidence', '.forecast-bills', '.forecast-card h4', '.forecast-cell-range',
  '.forecast-explain', '.forecast-figure small', '.forecast-gaps', '.forecast-note', '.forecast-parts', '.forecast-sentences',
  '.forecast-table', '.forecast-table thead th',
  // F: Amazon.
  '.amazon-category-name', '.amazon-category-source', '.amazon-coverage', '.amazon-figure dt', '.amazon-figure-note',
  '.amazon-item-meta', '.amazon-legend', '.amazon-lines', '.amazon-match', '.amazon-match .spending-link.inline',
  '.amazon-match-times', '.amazon-measure', '.amazon-order-facts', '.amazon-page-facts', '.amazon-payment-group h5',
  '.amazon-payment-group ul', '.amazon-purchases', '.amazon-purchases .amazon-fact', '.amazon-refunds',
  '.amazon-spending-coverage', '.amazon-spending-measure', '.amazon-taxonomy-badge', '.amazon-taxonomy-path',
  '.amazon-unattributed-refunds', '.amazon-unattributed-refunds .spending-rank-note', '.amazon-version',
  // G: Benefits.
  '.benefits-cell', '.benefits-current-open', '.benefits-figure-label', '.benefits-figure-note', '.benefits-group-note',
  '.benefits-member-note', '.benefits-hint', '.benefits-issuer-trackers h6', '.benefits-issuer-trackers ul', '.benefits-matches',
  '.benefits-member-alias', '.benefits-member-owner', '.benefits-missing', '.benefits-missing-fold', '.benefits-row-year',
  '.benefits-settings-toggle', '.benefits-setup-card .benefits-card-name p', '.benefits-setup-reason', '.benefits-setup-why',
  '.benefits-source', '.benefits-tag', '.benefits-footnote', '.benefits-rank-note', '.benefits-untracked',
  // I1: the portfolio's hero line and the overnight panel's two labels; I2: the import panel's JSON field.
  '.hero-meta', '.indicative-header > button[aria-expanded] > span.muted', '.indicative-header > button[role="switch"] > span:first-child',
  '.import-panel textarea',
] as const;

/**
 * Builds, in the app's own page, a text matching each selector (at `size`, 12px unless said; drawn: no rule of the
 * app's may hide it), each named canary-<group>-<index>.
 */
const plantCanaries = (page: Page, selectors: readonly string[], group: string, size = '12px') => page.evaluate(({ list, group, size }) => {
  let root = document.querySelector<HTMLElement>('[data-canaries]');
  const first = !root;
  if (!root) {
    root = document.createElement('div');
    root.setAttribute('data-canaries', '');
    root.style.cssText = 'display: block; width: 360px; margin: 16px 0;';
  }
  const shown = (element: HTMLElement) => {
    for (const [property, value] of [['display', 'block'], ['visibility', 'visible'], ['opacity', '1'], ['position', 'static'],
      ['overflow', 'visible'], ['clip', 'auto'], ['width', 'auto'], ['height', 'auto'], ['max-height', 'none'], ['transform', 'none']]) {
      element.style.setProperty(property, value, 'important');
    }
  };
  list.forEach((selector, index) => {
    let parent: HTMLElement = root!;
    const parts = selector.split(/\s*>\s*|\s+/).filter(Boolean);
    parts.forEach((part, at) => {
      const match = /^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(?::first-child)?$/i.exec(part);
      if (!match) throw new Error(`cannot build ${part} of ${selector}`);
      const element = document.createElement(match[1] ?? (at === parts.length - 1 ? 'span' : 'div'));
      for (const name of (match[2] ?? '').split('.').filter(Boolean)) element.classList.add(name);
      for (const attribute of (match[3] ?? '').match(/\[[^\]]+\]/g) ?? []) {
        const [, key, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(attribute) ?? [];
        if (key) element.setAttribute(key, value ?? 'false');
      }
      shown(element);
      parent.append(element);
      parent = element;
    });
    parent.classList.add(`canary-${group}-${index}`);
    parent.style.setProperty('font-size', size, 'important');
    if (parent instanceof HTMLTextAreaElement) parent.value = 'Canary text';
    else parent.textContent = 'Canary text';
  });
  if (!first) return;
  root.insertAdjacentHTML('beforeend', [
    '<div><span class="canary-inline" style="font-size: 12px">An inline size</span></div>',
    '<div><span class="spending-badge warn canary-warning" style="font-size: 13px">Pending 16 days · may have been cancelled</span></div>',
    '<div><span class="holding-badge theme canary-badge" style="font-size: 12px">A theme</span></div>',
    '<div><span class="spending-row-merchant canary-reading" style="font-size: 15px">A merchant</span></div>',
    '<h3 class="canary-section" style="font-size: 17px; line-height: 1.4">A section head</h3>',
    '<div class="canary-wraps" style="width: 120px; font-size: 14px; line-height: 1.2">Running text that wraps onto several lines here</div>',
    '<h4 class="canary-heading" style="font-size: 16px; line-height: 1">A heading</h4>',
    '<p class="canary-measure" style="max-width: none; width: 90ch; font-size: 14px; line-height: 1.5">A paragraph wider than its measure</p>',
    // Wrapping text in a table cell, in a control and in an account's name under a holding: running text, at 1.5.
    '<table><tbody><tr><td class="canary-cell-wraps" style="width: 120px; font-size: 14px; line-height: 1.3">Running text in a table cell that wraps</td></tr></tbody></table>',
    '<button type="button" class="canary-control-wraps" style="width: 120px; font-size: 14px; line-height: 1.3">A control whose words wrap onto lines</button>',
    '<div class="breakdown"><table class="holdings"><tbody><tr class="contributor-row"><td class="contributor-name-cell" style="width: 140px">'
      + '<span class="contributor-name canary-contributor-wraps" style="width: 120px; font-size: 16px; line-height: 1.3; white-space: normal">A long synthetic account name that wraps</span>'
      + '</td></tr></tbody></table></div>',
    // A cell's label from its data-label is a field label: reported below 14px, never at it, in a 16px reading cell.
    '<style>.canary-label-small::before, .canary-label-ok::before { content: attr(data-label); display: block; }'
      + ' .canary-label-small::before { font-size: 12px !important; } .canary-label-ok::before { font-size: 14px !important; }</style>'
      + '<div class="breakdown"><table class="indicative-table"><tbody><tr>'
      + '<td class="canary-label-small" data-label="A label" style="font-size: 16px">$1.00</td>'
      + '<td class="canary-label-ok" data-label="A label" style="font-size: 16px">$1.00</td></tr></tbody></table></div>',
    // At their floors, never reported: a control on one line at 1.25, a heading that wraps at 1.3, a note under a price.
    '<button type="button" class="canary-control-one-line" style="font-size: 14px; line-height: 1.25">Save</button>',
    '<h4 class="canary-heading-wraps" style="width: 120px; font-size: 16px; line-height: 1.3">A heading that wraps onto lines</h4>',
    '<div class="breakdown"><table class="indicative-table"><tbody><tr><td style="font-size: 16px">$50.00'
      + '<span class="indicative-sub canary-note" style="font-size: 14px">Oct 24, 4:23 AM</span></td></tr></tbody></table></div>',
  ].join(''));
  document.querySelector('.app')?.append(root);
}, { list: selectors, group, size });

/**
 * The lanes' reading text the review of #250 found unenforced, and reading text this sweep holds as its lane's spec names
 * it (a ranked row's name, a reminder's name, a holding's value on a phone): each must be reported at 15px.
 */
const READING_CANARIES = [
  '.holding-symbol', '.contributor-name', '.breakdown .performance-table tbody th', '.breakdown .indicative-explainer',
  '.spending-panel.spending-payments .spending-payments-open', '.amazon .spending-rank-name', '.benefits-reminder-name',
  '.breakdown .account.combined table.holdings tr.holding-row > td.col-value',
] as const;

// ---- The code at its floors, statically (the lead's guard for T2) ----

interface SourceFile { path: string; text: string }

/** Every CSS, TS and TSX file under apps/web/src (tests apart). */
function sourceFiles(): SourceFile[] {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        files.push({ path: relative(root, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(root);
  return files;
}

interface Declaration { path: string; line: number; selector: string; property: string; value: string }

/** A style sheet's declarations, each with its rule's selector and its line (comments, strings and url()s respected). */
function declarationsOf(file: SourceFile): Declaration[] {
  const { text } = file;
  const found: Declaration[] = [];
  const preludes: string[] = [];
  let buffer = '';
  let line = 1;
  let start = 1;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const comment = text.slice(i, end < 0 ? text.length : end + 2);
      line += comment.split('\n').length - 1;
      i += comment.length - 1;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      buffer += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && (ch === '{' || ch === '}' || ch === ';')) {
      const chunk = buffer.trim();
      const rule = preludes[preludes.length - 1];
      if (ch === '{') preludes.push(chunk.replace(/\s+/g, ' '));
      else if (rule && !rule.startsWith('@') && chunk.includes(':')) {
        const colon = chunk.indexOf(':');
        found.push({ path: file.path, line: start, selector: rule, property: chunk.slice(0, colon).trim().toLowerCase(), value: chunk.slice(colon + 1).trim() });
      }
      if (ch === '}') preludes.pop();
      buffer = '';
      continue;
    }
    if (ch === '\n') line += 1;
    else if (!buffer.trim() && ch.trim()) start = line;
    buffer += ch;
  }
  return found;
}

/** A size a font-size can come to: px, a factor of the parent's size, one that never shrinks, or one that can't be told. */
type Size = { px: number } | { factor: number } | { grows: true } | { unknown: string };

/** Splits a function's arguments at its top-level commas. */
const argumentsOf = (inside: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of inside) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(part.trim());
      part = '';
    } else part += ch;
  }
  return [...parts, part.trim()];
};

/**
 * Every value a CSS value can take once its custom properties are put in: each var() by every value its property is
 * ever given, anywhere (a property set in one scope may be unset in another), and by its fallback, each occurrence on
 * its own. Fails closed: null for a property that is never set and has no fallback, one that refers to itself, or more
 * than 256 combinations.
 */
function expansions(value: string, custom: ReadonlyMap<string, readonly string[]>, seen: ReadonlySet<string> = new Set()): string[] | null {
  const match = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/.exec(value);
  if (!match) return [value];
  const [whole, name, fallback] = match;
  if (seen.has(name)) return null;
  const options: string[] = [];
  for (const given of [...(custom.get(name) ?? []), ...(fallback === undefined ? [] : [fallback])]) {
    const inner = expansions(given, custom, new Set([...seen, name]));
    if (!inner) return null;
    options.push(...inner);
  }
  if (options.length === 0) return null;
  const out = new Set<string>();
  for (const option of new Set(options)) {
    const rest = expansions(value.replace(whole, option), custom, seen);
    if (!rest) return null;
    for (const item of rest) out.add(item);
    if (out.size > 256) return null;
  }
  return [...out];
}

/** A value with no custom property left in it, worked out: calc() exactly, max() at least, min() and clamp() at most. */
function concreteSize(value: string): Size {
  const v = value.replace(/\s*!important\s*$/i, '').trim();
  let match: RegExpExecArray | null;
  if ((match = /^(-?\d*\.?\d+)px$/i.exec(v))) return { px: Number(match[1]) };
  if ((match = /^(-?\d*\.?\d+)rem$/i.exec(v))) return { px: Number(match[1]) * 16 };
  if ((match = /^(-?\d*\.?\d+)em$/i.exec(v))) return { factor: Number(match[1]) };
  if ((match = /^(-?\d*\.?\d+)%$/.exec(v))) return { factor: Number(match[1]) / 100 };
  if (/^0$/.test(v)) return { px: 0 };
  // The keywords as CSS sizes them (medium is 16px).
  const keyword = ({ 'xx-small': 9, 'x-small': 10, small: 13 } as Record<string, number>)[v.toLowerCase()];
  if (keyword !== undefined) return { px: keyword };
  if (/^smaller$/i.test(v)) return { factor: 0.83 };
  if (/^(inherit|initial|unset|revert|revert-layer|medium|large|x-large|xx-large|xxx-large|larger)$/i.test(v)) return { grows: true };
  if ((match = /^(calc|max|min|clamp)\((.*)\)$/i.exec(v))) {
    const [, name, inside] = match;
    const fn = name.toLowerCase();
    if (fn === 'calc') {
      const expression = inside.replace(/(\d*\.?\d+)px/gi, '$1').replace(/(\d*\.?\d+)rem/gi, (_, n: string) => String(Number(n) * 16));
      if (!/^[\d.+\-*/()\s]+$/.test(expression)) return { unknown: v };
      // eslint-disable-next-line no-new-func -- digits and arithmetic only, checked just above
      const px = Number(Function(`return (${expression});`)());
      return Number.isFinite(px) ? { px } : { unknown: v };
    }
    const sizes = argumentsOf(inside).map(concreteSize);
    const px = sizes.flatMap((size) => ('px' in size ? [size.px] : []));
    if (fn === 'max') return px.length ? { px: Math.max(...px) } : { unknown: v };
    if (px.length !== sizes.length) return { unknown: v };
    return { px: fn === 'min' ? Math.min(...px) : px[0] };
  }
  return { unknown: v };
}

/**
 * Why a font-size can come below the floor, or null when it never does: 14px, or 13px through D1's badge and head
 * tokens. Every value it can take counts; one that can't be told is a finding.
 */
function belowFloor(value: string, custom: ReadonlyMap<string, readonly string[]>): string | null {
  const options = expansions(value, custom);
  if (!options) return `its size cannot be told: ${value}`;
  let least: number | null = null;
  for (const option of options) {
    const size = concreteSize(option);
    if ('grows' in size) continue;
    if ('factor' in size) {
      if (size.factor < 1) return `shrinks its parent's size to ${size.factor}`;
      continue;
    }
    if ('unknown' in size) return `its size cannot be told: ${size.unknown}`;
    least = least === null ? size.px : Math.min(least, size.px);
  }
  if (least === null || least >= 14) return null;
  if (least >= 13 && /var\(\s*--text-(badge|table-head)\b/.test(value)) return null;
  return `${Math.round(least * 100) / 100}px`;
}

/** The size in a font shorthand (`font: 600 14px/1.5 …`), or null for one that sets none (`font: inherit`). */
function shorthandSize(value: string): string | null {
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value.trim())) return null;
  const match = /(?:^|\s)((?:var|calc|max|min|clamp)\((?:[^()]|\([^()]*\))*\)|\d*\.?\d+(?:px|rem|em|%)|(?:xx?-)?small|medium|(?:xx?x?-)?large|smaller|larger)(?:\s*\/\s*\S+)?\s+\S/i.exec(value);
  return match ? match[1] : value;
}

/** TS and TSX without comments (blanked, so lines and columns stay). */
const codeOf = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (comment, before: string) => before + ' '.repeat(comment.length - before.length));

/** Custom properties a TS or TSX file sets inline (`'--x': '12px'`, `setProperty('--x', …)`): they count too. */
function inlineProperties(file: SourceFile): Array<[string, string]> {
  const code = codeOf(file.text);
  const found: Array<[string, string]> = [];
  for (const match of code.matchAll(/['"`](--[\w-]+)['"`]\s*[:,]\s*(['"`])([^'"`]*)\2/g)) found.push([match[1], match[3]]);
  return found;
}

/**
 * Inline sizes in TS and TSX: a style's fontSize (a quoted key too), a fontSize prop, an assigned or bracketed
 * fontSize, setProperty('font-size'), a hyphenated font-size attribute, and font-size in CSS text. A value that isn't a
 * literal can't be told, and is a finding.
 */
function inlineFindings(file: SourceFile, custom: ReadonlyMap<string, readonly string[]>): string[] {
  const code = codeOf(file.text);
  const lines = file.text.split('\n');
  const where = (index: number) => {
    const line = code.slice(0, index).split('\n').length;
    return `${file.path}:${line} ${(lines[line - 1] ?? '').trim()}`;
  };
  const found: string[] = [];
  /** A captured value: a number, a string holding CSS, or (in CSS text) CSS itself; any other expression can't be told. */
  const judge = (raw: string, css: boolean): string | null => {
    const value = raw.trim();
    if (css) return belowFloor(value, custom);
    const quoted = /^(['"`])(.*)\1$/s.exec(value);
    if (quoted && quoted[1] === '`' && quoted[2].includes('${')) return `its size cannot be told: ${value}`;
    const text = quoted ? quoted[2].trim() : value;
    if (/^\d*\.?\d+$/.test(text)) return Number(text) >= 14 ? null : `${text}px`;
    return quoted ? belowFloor(text, custom) : `its size cannot be told: ${value}`;
  };
  const patterns: Array<[RegExp, boolean]> = [
    [/(?:\b|['"`])fontSize['"`]?\s*[:=]\s*\{?\s*([^,}\n;)]+)/g, false],
    [/\[\s*['"`](?:fontSize|font-size)['"`]\s*\]\s*=\s*([^;\n]+)/g, false],
    [/setProperty\(\s*['"`]font-size['"`]\s*,\s*([^)\n]+)\)/g, false],
    [/\bfont-size\s*=\s*\{?\s*([^\s>}]+)/g, false],
    [/font-size\s*:\s*([^;'"`}\n]+)/g, true],
  ];
  for (const [pattern, css] of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (/^\s*(number|string)\b/.test(match[1])) continue; // a type, not a size
      const why = judge(match[1], css);
      if (why) found.push(`${where(match.index ?? 0)} (${why})`);
    }
  }
  return found;
}

/** Every size in the code below the floor: CSS font-size and font shorthands, and inline sizes in TS and TSX. */
function codeFindings(files: readonly SourceFile[]): string[] {
  const declarations = files.filter((file) => file.path.endsWith('.css')).flatMap(declarationsOf);
  const scripts = files.filter((item) => /\.tsx?$/.test(item.path));
  const custom = new Map<string, string[]>();
  const add = (property: string, value: string) => custom.set(property, [...(custom.get(property) ?? []), value]);
  for (const { property, value } of declarations) if (property.startsWith('--')) add(property, value);
  for (const file of scripts) for (const [property, value] of inlineProperties(file)) add(property, value);
  const found: string[] = [];
  for (const { path, line, selector, property, value } of declarations) {
    const size = property === 'font-size' ? value : property === 'font' ? shorthandSize(value) : null;
    const why = size === null ? null : belowFloor(size, custom);
    if (why) found.push(`${path}:${line} ${selector} { ${property}: ${value} } (${why})`);
  }
  for (const file of scripts) found.push(...inlineFindings(file, custom));
  return found;
}

/** Sizes the code check must report (by the canary's name), and sizes at the floor it must not. */
const CODE_CANARIES_CSS = `
.canary-root { --canary-small: 11px; --canary-mixed: 16px; --canary-delta: 10px; --canary-delta-ok: 10px; }
@media (min-width: 1280px) { .canary-root { --canary-mixed: 12px; --canary-delta: 30px; --canary-delta-ok: 20px; } }
.canary-elsewhere { --canary-scoped: 16px; --canary-scoped-ok: 18px; }
.canary-px { font-size: 12px; }
.canary-literal-13 { font-size: 13px; }
.canary-em { font-size: 0.8em; }
.canary-keyword { font-size: smaller; }
.canary-shorthand { font: 600 12px/1.2 var(--font-sans); }
.canary-calc { font-size: calc(var(--text-help) - 2px); }
.canary-property { font-size: var(--canary-small); }
.canary-least { font-size: var(--canary-mixed); }
.canary-min { font-size: min(var(--text-help), 12px); }
.canary-glyph::before { content: '▸'; font-size: 10px; }
.canary-unknown { font-size: var(--canary-never-set); }
.canary-fallback { font-size: var(--canary-scoped, 12px); }
.canary-subtracted { font-size: calc(36px - var(--canary-delta)); }
.canary-ok-help { font-size: var(--text-help); }
.canary-ok-badge { font-size: var(--text-badge); }
.canary-ok-max { font-size: max(0.85em, var(--text-help)); }
.canary-ok-inherit { font-size: inherit; font: inherit; }
.canary-ok-calc { font-size: calc(var(--text-section, 18px) + 2px); }
.canary-ok-em { font-size: 1.1em; }
.canary-ok-fallback { font-size: var(--canary-scoped-ok, 16px); }
.canary-ok-subtracted { font-size: calc(36px - var(--canary-delta-ok)); }
`;
const CODE_CANARIES_TSX = [
  'const a = <div data-canary="tsx-style" style={{ fontSize: 13, marginTop: 2 }} />;',
  'const b = <text data-canary="tsx-prop" fontSize={11} />;',
  'const c = <span data-canary="tsx-relative" style={{ fontSize: \'0.75em\' }} />;',
  'node.style.fontSize = \'12px\'; // tsx-assigned',
  'const d = <div data-canary="tsx-dynamic" style={{ fontSize: small ? 12 : 16 }} />;',
  'const e = \'<b style="font-size: 9px">\'; // tsx-css-text',
  'const g = <div data-canary="tsx-quoted-key" style={{"fontSize":12}} />;',
  'const row = <span style={{ "fontSize": 12 }}>Synthetic name</span>; // tsx-quoted-key-spaced',
  'node.style["fontSize"]="12px"; // tsx-bracketed',
  'node.style["fontSize"] = "12px"; // tsx-bracketed-spaced',
  'const h = <text data-canary="tsx-hyphenated" font-size="12px" />;',
  'node.style.setProperty(\'font-size\', \'12px\'); // tsx-set-property',
  'const i = <div data-canary="tsx-template" style={{ fontSize: `${size}px` }} />;',
  'const j = <div data-canary="tsx-inline-property" style={{ \'--canary-inline\': \'11px\' }} />;',
  'const k = \'<b style="font-size: var(--canary-inline)">\'; // tsx-inline-property-used',
  'const f = <div data-canary="tsx-ok" style={{ fontSize: 16 }} />;',
  'const l = <div data-canary="tsx-ok-quoted-key" style={{"fontSize":16}} />;',
  'node.style["fontSize"]="16px"; // tsx-ok-bracketed',
  'const m = <text data-canary="tsx-ok-hyphenated" font-size="16px" />;',
  'node.style.setProperty(\'font-size\', \'16px\'); // tsx-ok-set-property',
  'const n = \'<b style="font-size: 16px">\'; // tsx-ok-css-text',
  '// tsx-comment: fontSize: 10 in a comment is no size',
].join('\n');
const CODE_BELOW = ['.canary-px', '.canary-literal-13', '.canary-em', '.canary-keyword', '.canary-shorthand', '.canary-calc',
  '.canary-property', '.canary-least', '.canary-min', '.canary-glyph', '.canary-unknown', '.canary-fallback', '.canary-subtracted',
  'tsx-style', 'tsx-prop', 'tsx-relative', 'tsx-assigned', 'tsx-dynamic', 'tsx-css-text', 'tsx-quoted-key', 'tsx-quoted-key-spaced',
  'tsx-bracketed', 'tsx-bracketed-spaced', 'tsx-hyphenated', 'tsx-set-property', 'tsx-template', 'tsx-inline-property-used'];
const CODE_AT = ['.canary-ok-help', '.canary-ok-badge', '.canary-ok-max', '.canary-ok-inherit', '.canary-ok-calc', '.canary-ok-em',
  '.canary-ok-fallback', '.canary-ok-subtracted', 'tsx-ok', 'tsx-ok-quoted-key', 'tsx-ok-bracketed', 'tsx-ok-hyphenated',
  'tsx-ok-set-property', 'tsx-ok-css-text', 'tsx-comment'];

test.describe('no exceptions', () => {
  test('the sweep can skip no text: its rules are the floors and nothing else, and a badge is never a status', () => {
    expect(Object.keys(rulesFor(PHONE)).sort()).toEqual(['badges', 'controls', 'denseHeads', 'headings', 'notes', 'reading', 'sections', 'wide']);
    const status = new Set(['warn', 'warning', 'status', 'error', 'alert', 'pending', 'label', 'note', 'help', 'hint', 'message', 'flag']);
    for (const selector of BADGES) {
      expect(selector.split(/[^a-z0-9]+/).filter((word) => status.has(word)), `${selector} names no status`).toEqual([]);
    }
    // A note is held to the help size, and only inside reading text. Each is named by its classes, as its lane's spec names
    // it: no element, attribute or universal selector can make every text in a reading block a note, nor is one reading too.
    for (const selector of NOTES) {
      expect(selector, `${selector} is classes only`).toMatch(/^\.[\w-]+(?:\.[\w-]+)*(?: \.[\w-]+(?:\.[\w-]+)*)*$/);
      expect(READING, `${selector} is no reading text`).not.toContain(selector);
    }
    // T1's list of exceptions is gone, and nothing by that name comes back.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source.match(new RegExp(`\\b${['NOT', 'YET'].join('_')}\\b`, 'g')) ?? [], 'a list of exceptions').toEqual([]);
  });

  test('every text an exception ever covered, and every kind of text, is reported once it is below its floor', async ({ page, request }) => {
    await requireHealthyApi(request);
    await page.setViewportSize({ width: PHONE, height: 900 });
    await open(page, '#/investing/portfolio');
    await plantCanaries(page, FORMER_EXCEPTIONS, 'former');
    await plantCanaries(page, READING_CANARIES, 'reading', '15px');
    const found = await sweep(page, PHONE);
    const reported = (name: string, rule: Finding['rule']) => found.some((finding) => finding.rule === rule
      && (finding.where.split(' > ').pop() ?? '').split('.').includes(name));
    for (const [index, selector] of FORMER_EXCEPTIONS.entries()) expect.soft(reported(`canary-former-${index}`, 'size'), selector).toBe(true);
    for (const [index, selector] of READING_CANARIES.entries()) expect.soft(reported(`canary-reading-${index}`, 'size'), `${selector} at 15px`).toBe(true);
    for (const name of ['canary-inline', 'canary-warning', 'canary-badge', 'canary-reading', 'canary-section', 'canary-label-small']) {
      expect.soft(reported(name, 'size'), name).toBe(true);
    }
    for (const name of ['canary-wraps', 'canary-heading', 'canary-cell-wraps', 'canary-control-wraps', 'canary-contributor-wraps']) {
      expect.soft(reported(name, 'leading'), name).toBe(true);
    }
    expect.soft(reported('canary-measure', 'measure'), 'canary-measure').toBe(true);
    // At their floors, never reported.
    for (const name of ['canary-control-one-line', 'canary-heading-wraps']) expect.soft(reported(name, 'leading'), name).toBe(false);
    for (const name of ['canary-note', 'canary-label-ok']) expect.soft(reported(name, 'size'), name).toBe(false);
  });

  test('the code has no size below the floor: every font-size in apps/web/src\'s CSS and every inline fontSize in its TSX', () => {
    const files = sourceFiles();
    expect(files.filter((file) => file.path.endsWith('.css')).length).toBeGreaterThan(5);
    expect(files.filter((file) => file.path.endsWith('.tsx')).length).toBeGreaterThan(50);
    expect(codeFindings(files)).toEqual([]);
  });

  test('the code check reports every way a size can go below the floor, and no size at it', () => {
    const tokens = sourceFiles().filter((file) => file.path.endsWith('.css'));
    const found = codeFindings([...tokens, { path: 'canary.css', text: CODE_CANARIES_CSS }, { path: 'canary.tsx', text: CODE_CANARIES_TSX }])
      .filter((line) => line.startsWith('canary.'));
    const reported = (name: string) => found.some((line) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(line));
    for (const name of CODE_BELOW) expect.soft(reported(name), name).toBe(true);
    for (const name of CODE_AT) expect.soft(reported(name), name).toBe(false);
  });
});
