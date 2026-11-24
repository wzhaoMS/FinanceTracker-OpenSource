import { expect, requireHealthyApi, test, type APIRequestContext, type Locator, type Page } from './fixtures';
import { buildCardImportPayload, serializeCardImportPayload, type CardBenefitsReport, type CardImportDraftRow } from '@finance-tracker/shared';

/**
 * The Benefits area of Everyday on synthetic card data: card accounts of this
 * file's own (made-up nicknames, last digits and amounts), statement credits
 * imported through the API, and a page clock fixed on October 27, 2026, so a
 * monthly credit has five days left. Other cards on the stack are ignored:
 * every check is scoped to this file's cards. The area opens By benefit, most
 * used first; the checks of its sections switch to By category, and the
 * card-by-card checks switch to By card first.
 */

const SUFFIX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'perks';
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };
const TODAY = new Date('2026-10-27T12:00:00');

function payload(rows: CardImportDraftRow[], coverage: { start: string; end: string }): string {
  return serializeCardImportPayload(buildCardImportPayload({
    source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'amex', currency: 'USD', coverage, rows,
  }).payload);
}

const credit = (transactionDate: string, amountMinor: number, description: string, kind: 'adjustment' | 'refund' = 'adjustment'): CardImportDraftRow =>
  ({ transactionDate, amountMinor: -amountMinor, kind, description, issuerCategory: 'Fees & Adjustments' });

// The Platinum card: a digital entertainment credit each month from June (the old $20 in 2025, $25 since),
// a Saks credit in the first half, and a store refund that is no credit at all.
const PLATINUM = payload([
  credit('2025-08-06', 2000, 'SAMPLE DIGITAL ENTERTAINMENT CREDIT'),
  ...['06', '07', '08', '09'].map((month) => credit(`2026-${month}-06`, 2500, 'SAMPLE DIGITAL ENTERTAINMENT CREDIT')),
  credit('2026-03-14', 5000, 'SAMPLE SAKS CREDIT'),
  credit('2026-09-20', 3000, 'SAMPLE OUTFITTERS RETURN', 'refund'),
  { transactionDate: '2026-09-02', amountMinor: 12000, kind: 'purchase', description: 'SAMPLE OUTFITTERS', issuerCategory: 'Shopping' },
], { start: '2025-08-01', end: '2026-10-20' });

// The Delta Gold Business card: its Delta Stays credit pays the whole annual fee.
const DELTA = payload([credit('2026-04-18', 15000, 'SAMPLE DELTA STAYS CREDIT')], { start: '2026-01-01', end: '2026-10-20' });

// The Business Platinum card: the Platinum card's hotel credit, used in the first half.
const BUSINESS = payload([credit('2026-03-10', 30000, 'SAMPLE AMEX TRAVEL HOTEL CREDIT')], { start: '2026-01-01', end: '2026-10-20' });

let platinumId = '';
let plainId = '';
let deltaId = '';
let businessId = '';
let spareId = '';

async function createAccount(request: APIRequestContext, draft: Record<string, string>): Promise<string> {
  const created = await request.post('/card-accounts', { headers: MUTATION_HEADERS, data: JSON.stringify({ currency: 'USD', ...draft }) });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json() as { id: string }).id;
}

async function openBenefits(page: Page, view: 'By benefit' | 'By card' = 'By benefit'): Promise<void> {
  await page.clock.setFixedTime(TODAY);
  await page.goto('/#/everyday/benefits');
  await expect(page.getByRole('tablist', { name: 'Spending areas' }).getByRole('tab', { name: 'Benefits' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.benefits-summary')).toBeVisible();
  const views = page.getByRole('group', { name: 'Group by' });
  if (view === 'By card') await views.getByRole('button', { name: 'By card' }).click();
  await expect(views.getByRole('button', { name: view })).toHaveAttribute('aria-pressed', 'true');
}

const cardPanel = (page: Page, id: string) => page.locator(`article.benefits-card[data-card="${id}"]`);
const benefitRow = (card: Locator, id: string) => card.locator(`li.benefits-row[data-benefit="${id}"]`);
const cell = (row: Locator, label: string) => row.locator('.benefits-grid').getByRole('button', { name: new RegExp(`^${label}\\b`) });
/** By benefit: a benefit's group, one card's row in it, and that card among those without it. */
const benefitGroup = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const memberRow = (group: Locator, id: string) => group.locator(`li.benefits-member[data-card="${id}"]`);
const missingCard = (group: Locator, id: string) => group.locator(`.benefits-missing-card[data-cards~="${id}"]`);
/** Most used: the order switch, a tier of it, and the benefits listed in a part of the page, in order. */
const orderSwitch = (page: Page) => page.getByRole('group', { name: 'Order', exact: true });
const usageTier = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const groupNames = (scope: Locator) => scope.locator('.benefits-group-name h4').allTextContents();

/** WCAG contrast of two computed `rgb()` colours. */
function contrast(a: string, b: string): number {
  const luminance = (rgb: string) => {
    const [r, g, blue] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
      const c = Number(value) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * What the Benefits area paints in each state, as computed colours, beside the
 * system's and the palette's own: the household's meter, a card whose credits
 * paid its fee, a used-up period, a period's track, one with no figure yet,
 * today's period, the chosen one and another, and the people's dots.
 */
function paintedStates(page: Page) {
  return page.evaluate(({ platinum, delta }) => {
    const area = document.querySelector('.benefits');
    if (!area) throw new Error('no Benefits area');
    const style = (selector: string) => {
      const node = area.querySelector(selector);
      if (!node) throw new Error(`nothing matches ${selector}`);
      return getComputedStyle(node);
    };
    const probe = document.createElement('span');
    area.append(probe);
    const resolve = (value: string) => { probe.style.color = value; return getComputedStyle(probe).color; };
    const colours = {
      highlight: resolve('Highlight'), canvas: resolve('Canvas'), canvasText: resolve('CanvasText'),
      gain: resolve('var(--gain)'), accent: resolve('var(--accent-graphic)'),
    };
    probe.remove();
    const card = `article.benefits-card[data-card="${platinum}"]`;
    const grid = `${card} li.benefits-row[data-benefit="digital-entertainment"] .benefits-grid`;
    const track = style(`${grid} .benefits-cell[data-fill="full"] .benefits-cell-meter`);
    const chosen = style(`${grid} .benefits-cell[aria-pressed="true"]`);
    return {
      ...colours,
      fills: [...new Set([...area.querySelectorAll('.benefits-meter > span, .benefits-cell-meter > span')]
        .map((node) => getComputedStyle(node).backgroundColor))],
      household: style('.benefits-summary .benefits-meter > span').backgroundColor,
      over: style(`article.benefits-card[data-card="${delta}"] .benefits-meter[data-tone="over"] > span`).backgroundColor,
      full: style(`${grid} .benefits-cell[data-fill="full"][aria-pressed="false"] .benefits-cell-meter > span`).backgroundColor,
      track: { style: track.borderTopStyle, color: track.borderTopColor },
      unknown: style(`${card} li.benefits-row[data-benefit="uber-cash"] .benefits-cell[data-fill="unknown"] .benefits-cell-meter`).borderTopStyle,
      current: style(`${grid} .benefits-cell[data-state="current"]`).borderTopColor,
      chosen: { color: chosen.borderTopColor, width: chosen.borderTopWidth, shadow: chosen.boxShadow },
      other: style(`${grid} .benefits-cell[data-state="past"][aria-pressed="false"]`).borderTopColor,
      dots: [...area.querySelectorAll('.benefits-owner-dot')].map((node) => getComputedStyle(node).backgroundColor),
    };
  }, { platinum: platinumId, delta: deltaId });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await requireHealthyApi(request);
  const report = await request.get('/spending/benefits?year=2026&today=2026-10-27');
  expect(report.status(), await report.text()).toBe(200);
  platinumId = await createAccount(request, { issuer: 'amex', owner: 'alex', nickname: `Platinum ${SUFFIX}`, last5: '90001' });
  const committed = await request.post(`/card-imports/commit?cardAccountId=${platinumId}`, { headers: MUTATION_HEADERS, data: PLATINUM });
  expect(committed.status(), await committed.text()).toBe(201);
  plainId = await createAccount(request, { issuer: 'amex', owner: 'casey', nickname: `Perks ${SUFFIX}`, last4: '0002' });
  deltaId = await createAccount(request, { issuer: 'amex', owner: 'joint', nickname: `Delta Gold Business ${SUFFIX}`, last4: '0003' });
  const delta = await request.post(`/card-imports/commit?cardAccountId=${deltaId}`, { headers: MUTATION_HEADERS, data: DELTA });
  expect(delta.status(), await delta.text()).toBe(201);
  businessId = await createAccount(request, { issuer: 'amex', owner: 'casey', nickname: `Business Platinum ${SUFFIX}`, last5: '90004' });
  const business = await request.post(`/card-imports/commit?cardAccountId=${businessId}`, { headers: MUTATION_HEADERS, data: BUSINESS });
  expect(business.status(), await business.text()).toBe(201);
  spareId = await createAccount(request, { issuer: 'amex', owner: 'joint', nickname: `Spare ${SUFFIX}`, last4: '0005' });
});

/** Dollars as the area writes them: "$15", "$12.95", "$1,200". */
const usd = (minor: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
}).format(minor / 100);

/** The API's answer for the page's year and day: what the year's figures must say, for every card on the stack. */
async function benefitsAnswer(request: APIRequestContext): Promise<CardBenefitsReport> {
  const answer = await request.get('/spending/benefits?year=2026&today=2026-10-27');
  expect(answer.status(), await answer.text()).toBe(200);
  return answer.json() as Promise<CardBenefitsReport>;
}

/** Periods so far of the dollar totals (open cards) whose use is unknown: the report's own count, and their credits. */
function unknownIn(cards: CardBenefitsReport['cards']): { periods: number; creditsMinor: number } {
  const benefits = cards.filter((card) => card.status === 'active').flatMap((card) => card.benefits).filter((benefit) => benefit.inTotals);
  return {
    periods: benefits.reduce((sum, benefit) => sum + benefit.year.unknownPeriods, 0),
    creditsMinor: benefits.flatMap((benefit) => benefit.periods)
      .filter((period) => period.active && period.state !== 'future' && period.usedMinor === null)
      .reduce((sum, period) => sum + period.availableMinor, 0),
  };
}

/**
 * Visible text in the Benefits area set below `floor` px, each as "text (size) in tag.class", and the form fields
 * below it: none may be (D1: 14px for help, labels, status and actionable text; 16px is asserted for reading text).
 */
function textBelow(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((min) => {
    const area = document.querySelector('.benefits');
    if (!area) throw new Error('no Benefits area');
    const small: string[] = [];
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent || parent.closest('option')) continue;
      if (parent.getClientRects().length === 0 || getComputedStyle(parent).visibility !== 'visible') continue;
      const size = parseFloat(getComputedStyle(parent).fontSize);
      if (size < min) small.push(`"${text.slice(0, 40)}" (${size}px) in ${parent.tagName.toLowerCase()}.${[...parent.classList].join('.')}`);
    }
    // What a field shows is no text node of the page: its own size.
    for (const field of area.querySelectorAll('select, input')) {
      const size = parseFloat(getComputedStyle(field).fontSize);
      if (field.getClientRects().length > 0 && size < min) small.push(`${field.tagName.toLowerCase()} (${size}px)`);
    }
    return small;
  }, floor);
}

/** The computed sizes of the reading text shown: each selector's distinct sizes. */
function readingSizes(page: Page, selectors: readonly string[]): Promise<Record<string, string[]>> {
  return page.evaluate((list) => Object.fromEntries(list.map((selector) => [selector,
    [...new Set([...document.querySelectorAll(`.benefits ${selector}`)].map((node) => getComputedStyle(node).fontSize))]])), selectors);
}

/**
 * Visible text in the Benefits area set tighter than D1 allows, each as "text (line-height ratio) in tag.class": running
 * text that can wrap at 1.5 or more; headings, controls (buttons, fields), chips and the year's one-line figure at 1.25
 * or more. "normal" counts as too tight.
 */
function leadingBelow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const area = document.querySelector('.benefits');
    if (!area) throw new Error('no Benefits area');
    const tight: string[] = [];
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent || parent.closest('option')) continue;
      if (parent.getClientRects().length === 0 || getComputedStyle(parent).visibility !== 'visible') continue;
      const style = getComputedStyle(parent);
      const ratio = style.lineHeight === 'normal' ? 0 : parseFloat(style.lineHeight) / parseFloat(style.fontSize);
      const floor = parent.closest('h1, h2, h3, h4, h5, h6, button, select, .benefits-tag, .benefits-missing-card, .benefits-figure-value')
        ? 1.25 : 1.5;
      if (ratio < floor - 0.001) {
        tight.push(`"${text.slice(0, 40)}" (${style.lineHeight === 'normal' ? 'normal' : ratio.toFixed(2)}, under ${floor}) in ${parent.tagName.toLowerCase()}.${[...parent.classList].join('.')}`);
      }
    }
    return tight;
  });
}

/** Every visible text at D1's size floor (14px) and line-height floors, as `state` shows it. */
async function expectReadingFloors(page: Page, state: string): Promise<void> {
  expect(await textBelow(page, 14), `${state}: size`).toEqual([]);
  expect(await leadingBelow(page), `${state}: line-height`).toEqual([]);
  expect(await paragraphsOverMeasure(page), `${state}: measure`).toEqual([]);
}

/** Visible paragraphs in the Benefits area wider than 65ch of their own font (D1's measure), as the shared sweep measures. */
function paragraphsOverMeasure(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.benefits p')].flatMap((p) => {
    const box = p.getBoundingClientRect();
    if (!(p.textContent ?? '').trim() || box.width === 0) return [];
    const probe = document.createElement('span');
    probe.style.cssText = 'position: absolute; visibility: hidden; width: 65ch; height: 0; margin: 0; padding: 0; border: 0;';
    p.appendChild(probe);
    const measure = probe.getBoundingClientRect().width;
    probe.remove();
    const s = getComputedStyle(p);
    const content = box.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
    return content > measure + 1 ? [`"${(p.textContent ?? '').trim().slice(0, 40)}" ${Math.round(content)}px, 65ch is ${Math.round(measure)}px`] : [];
  }));
}

// Journey 7 (readability round, G): what to use before it resets comes first, a line each for the benefit, what is left
// (or that its use is unknown), by when and the card; the year's figures follow, worded "Credits used", with the
// periods whose use is unknown said apart and never as $0, then the fees and the difference, quieter. Each at a phone's
// width and a wide screen's, on the file's cards as they are first set up.
for (const [screen, use] of [
  ['phone, 375px', { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }],
  ['wide screen, 1920px', { viewport: { width: 1920, height: 1080 } }],
] as const) {
  test.describe(`Benefits area: what to use first, then the year (${screen})`, () => {
    test.use(use);
    const phone = use.viewport.width < 720;

    test('each reminder says the benefit, what is left or that its use is unknown, by when, and the card, before any annual figure', async ({ page, request }) => {
      await openBenefits(page);
      const reminders = page.getByRole('region', { name: 'Use before it resets' });
      const summary = page.getByRole('region', { name: 'Household · 2026 so far' });
      await expect(reminders).toBeVisible();
      // Read first, in the page and on the screen: the reminders end before the year's figures begin.
      const order = await page.evaluate(() => {
        const first = document.querySelector('.benefits-reminders')!;
        const then = document.querySelector('.benefits-summary')!;
        return {
          following: Boolean(first.compareDocumentPosition(then) & Node.DOCUMENT_POSITION_FOLLOWING),
          gap: then.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
        };
      });
      expect(order.following).toBe(true);
      expect(order.gap).toBeGreaterThanOrEqual(0);

      const reminder = (name: string) => reminders.locator('li').filter({ hasText: 'Platinum ··90001' }).filter({ hasText: name });
      const entertainment = reminder('Digital entertainment credit');
      await expect(entertainment.locator('.benefits-reminder-name')).toHaveText('Digital entertainment credit');
      await expect(entertainment.locator('.benefits-reminder-left')).toHaveText('$25 left');
      await expect(entertainment.locator('.benefits-reminder-deadline')).toHaveText('Use by Oct 31 · 5 days left');
      await expect(entertainment.locator('.benefits-reminder-card')).toHaveText('Platinum ··90001 · Alex');
      // Read aloud, the four parts stay apart.
      await expect(entertainment.getByRole('link'))
        .toHaveAccessibleName('Digital entertainment credit, $25 left, Use by Oct 31 · 5 days left, Platinum ··90001 · Alex');
      // Marked by hand and not marked yet: its use is unknown, said so, never "$0 left" or the whole credit left.
      const uber = reminder('Uber Cash');
      await expect(uber.locator('.benefits-reminder-left')).toHaveText('Use unknown · not marked yet');
      await expect(uber.locator('.benefits-reminder-left')).toHaveAttribute('data-unknown', 'true');
      await expect(uber.locator('.benefits-reminder-deadline')).toHaveText('Use by Oct 31 · 5 days left');
      await expect(uber).not.toContainText('$');
      await expect(uber.getByRole('link'))
        .toHaveAccessibleName('Uber Cash, Use unknown · not marked yet, Use by Oct 31 · 5 days left, Platinum ··90001 · Alex');

      // A line each on a phone; aligned fields, one row per reminder, on a wide screen.
      const rows = await reminders.locator('a.benefits-reminder').evaluateAll((links) => links.map((link) => [...link.children]
        .map((part) => { const box = part.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left }; })));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const parts of rows) {
        expect(parts).toHaveLength(4);
        for (let index = 1; index < parts.length; index += 1) {
          if (phone) expect(parts[index].top, `line ${index + 1}`).toBeGreaterThanOrEqual(parts[index - 1].bottom - 1);
          else {
            expect(parts[index].left, `field ${index + 1}`).toBeGreaterThan(parts[index - 1].left);
            expect(parts[index].top, `field ${index + 1}`).toBeLessThan(parts[0].bottom);
          }
        }
      }
      if (!phone) for (let column = 0; column < 4; column += 1) {
        expect(new Set(rows.map((parts) => Math.round(parts[column].left))).size, `field ${column + 1} lines up`).toBe(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      // The year's figures, as the API answers them for every card on the stack.
      const answer = await benefitsAnswer(request);
      const { household } = answer;
      const used = summary.locator('[data-figure="used"]');
      await expect(used.locator('.benefits-figure-label')).toHaveText('Credits used');
      await expect(used.locator('.benefits-figure-value')).toHaveText(usd(household.capturedMinor));
      await expect(used.locator('.benefits-figure-note'))
        .toHaveText(`of ${usd(household.availableMinor)} available in 2026 · ${Math.round((household.capturedMinor / household.availableMinor) * 100)}%`);
      const unknown = unknownIn(answer.cards);
      // Uber Cash, not marked yet, from January: its months so far are unknown, not unused.
      expect(unknown.periods).toBeGreaterThanOrEqual(10);
      await expect(summary.locator('[data-figure="unknown"]'))
        .toHaveText(`Use unknown: ${unknown.periods} periods (${usd(unknown.creditsMinor)} in credits), not counted in credits used.`);
      await expect(summary.locator('.benefits-meter')).toHaveAttribute('data-unknown', 'true');
      // Cards whose credits the figures cannot count yet (Perks and Spare have no product so far): said, never as none.
      const open = answer.cards.filter((card) => card.status === 'active');
      const noProduct = open.filter((card) => card.product === null && card.productChoice !== 'none').length;
      const unplaced = open.filter((card) => card.product !== null
        && card.benefits.some((benefit) => benefit.inTotals && benefit.needsAnniversary)).length;
      expect(noProduct).toBeGreaterThanOrEqual(2);
      const leftOut = [
        noProduct > 0 ? `${noProduct} ${noProduct === 1 ? 'card that needs' : 'cards that need'} a product` : '',
        unplaced > 0 ? `${unplaced} ${unplaced === 1 ? 'card that needs' : 'cards that need'} an anniversary month` : '',
      ].filter(Boolean);
      await expect(summary.locator('[data-figure="not-counted"]')).toHaveText(`Not counted yet: credits on ${leftOut.join(', and on ')}.`);
      await expect(summary.locator('[data-figure="fees"]'))
        .toHaveText(`Annual fees ${usd(household.annualFeesMinor)} · credits used cover ${Math.round((household.capturedMinor / household.annualFeesMinor) * 100)}% of them`);
      const difference = household.capturedMinor - household.annualFeesMinor;
      await expect(summary.locator('[data-figure="net"]'))
        .toHaveText(`Credits used minus annual fees: ${difference < 0 ? '−' : ''}${usd(Math.abs(difference))} (dollar credits only)`);
      // A difference, not a gain or a loss: it takes the fees' quiet colour, and nothing says "Captured".
      const colours = await summary.locator('.benefits-summary-fees p').evaluateAll((lines) => lines.map((line) => getComputedStyle(line).color));
      expect(new Set(colours).size).toBe(1);
      await expect(summary).not.toContainText(/captured/i);
      // Each person, from the same answer: Alex's Platinum holds the unknown months.
      const alex = household.byOwner.alex;
      const alexUnknown = unknownIn(answer.cards.filter((card) => card.owner === 'alex'));
      await expect(summary.locator('.benefits-owner-totals li[data-owner="alex"]')).toHaveText(
        `Alex${usd(alex.capturedMinor)} of ${usd(alex.availableMinor)} used · use unknown for ${alexUnknown.periods} periods · fees ${usd(alex.annualFeesMinor)}`,
      );
    });

    test('keeps every text at the reading floors: 16px reading text, 14px for the rest, running text at line-height 1.5 within 65ch, folded, opened, failed and empty', async ({ page }) => {
      await openBenefits(page);
      await expect(page.getByText('Ordering by use…')).toHaveCount(0);
      await expectReadingFloors(page, 'by benefit');
      expect(await readingSizes(page, ['.benefits-reminder-name', '.benefits-reminder-left', '.benefits-reminder-deadline',
        '.benefits-row-name', '.benefits-summary-unknown', '.benefits-summary-fees p'])).toEqual({
        '.benefits-reminder-name': ['16px'], '.benefits-reminder-left': ['16px'], '.benefits-reminder-deadline': ['16px'],
        '.benefits-row-name': ['16px'], '.benefits-summary-unknown': ['16px'], '.benefits-summary-fees p': ['16px'],
      });
      // Section heads, the panels' and the tiers' (D1, the shared scale): 18px on a phone, 20px from 1280px.
      expect(await readingSizes(page, ['h3'])).toEqual({ h3: [phone ? '18px' : '20px'] });

      // Opened: a folded benefit, a period's details, and the cards without a benefit.
      const walmart = benefitGroup(page, 'Walmart+ credit');
      await walmart.getByRole('button', { name: /^On 1 of \d+ cards$/ }).click();
      await memberRow(walmart, platinumId).getByRole('button', { name: 'Details for Walmart+ credit on Platinum ··90001, Oct' }).click();
      await expect(walmart.getByRole('region', { name: 'Walmart+ credit on Platinum ··90001, Oct' })).toBeVisible();
      const entertainment = benefitGroup(page, 'Digital entertainment credit');
      const without = entertainment.getByRole('button', { name: /^Without it in 2026/ });
      if (await without.getAttribute('aria-expanded') !== 'true') await without.click();
      await expect(missingCard(entertainment, businessId)).toBeVisible();
      await expectReadingFloors(page, 'opened by benefit');

      // By card: a card's settings and a period whose matched credit opens its transaction.
      await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'By card' }).click();
      const platinum = cardPanel(page, platinumId);
      await platinum.getByRole('button', { name: 'Card settings' }).click();
      await cell(benefitRow(platinum, 'digital-entertainment'), 'Sep').click();
      await expect(platinum.getByRole('region', { name: 'Digital entertainment credit, Sep' })
        .getByRole('button', { name: /SAMPLE DIGITAL ENTERTAINMENT CREDIT/ })).toBeVisible();
      await expectReadingFloors(page, 'opened by card');
      await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'By benefit' }).click();

      // Loading, then failed: another year's answer held, then refused.
      const held: Array<() => Promise<void>> = [];
      await page.route(/\/spending\/benefits\?year=2025/, (route) => {
        held.push(() => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'card spending request failed' }) }));
      });
      await page.getByRole('button', { name: 'Previous year' }).click();
      await expect(page.getByText('Loading 2025…')).toBeVisible();
      await expectReadingFloors(page, 'loading');
      await expect.poll(() => held.length).toBeGreaterThan(0);
      for (const refuse of held.splice(0)) await refuse();
      await expect(page.locator('.benefits .spending-error')).toHaveText('card spending request failed');
      await expectReadingFloors(page, 'failed');

      // Empty: no card yet (a synthetic answer with none).
      await page.unroute(/\/spending\/benefits\?year=2025/);
      const none = { capturedMinor: 0, availableMinor: 0, annualFeesMinor: 0 };
      await page.route(/\/spending\/benefits\?year=2026/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          catalogVersion: 'e2e', year: 2026, today: '2026-10-27', cards: [], resetsSoon: [], products: [],
          household: { ...none, byOwner: { alex: none, casey: none, joint: none } },
        }),
      }));
      await page.reload();
      await expect(page.locator('.benefits .spending-empty')).toContainText('No cards yet');
      await expect(page.locator('.benefits-summary [data-figure="used"] .benefits-figure-note')).toHaveText('No dollar credits counted in 2026');
      await expect(page.locator('.benefits-summary [data-figure="not-counted"]')).toHaveCount(0);
      await expect(page.locator('.benefits-summary [data-figure="fees"]')).toHaveText('No annual fees');
      await expectReadingFloors(page, 'empty');
    });
  });
}

test.describe('Benefits area, by benefit', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('groups the cards by benefit: each card that has it, with its own periods and figures, and those that do not', async ({ page }) => {
    await openBenefits(page);
    // By category: sections as card communities sort credits; the most available first within each: in Hotels, the
    // hotel credit both Platinum cards have. (Most used, the default, is checked below.)
    await orderSwitch(page).getByRole('button', { name: 'By category' }).click();
    expect(await page.locator('.benefits-section > .benefits-section-head h3').allTextContents())
      .toEqual(['Travel', 'Hotels', 'Dining', 'Shopping and lifestyle', 'Business']);
    const hotels = page.getByRole('region', { name: 'Hotels', exact: true });
    await expect(hotels.locator('.benefits-group-name h4').first()).toHaveText('Hotel credit (FHR / The Hotel Collection)');
    // The section's dollar credits: the hotel credits, the Hilton credit and the Delta Stays credit.
    await expect(hotels.locator('[data-section-year]')).toHaveText('$450 of $1,550 in 2026');
    const travel = page.getByRole('region', { name: 'Travel', exact: true });
    await expect(travel.locator('.benefits-group-name h4').first()).toHaveText('CLEAR+ credit');
    const hotel = benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)');
    await expect(hotel.locator('.benefits-group-head .benefits-tag')).toHaveText(['$300 · Twice a year']);
    await expect(hotel.locator('.benefits-group-note')).toHaveText('Prepaid Fine Hotels + Resorts or The Hotel Collection bookings through Amex Travel.');
    await expect(hotel.locator('[data-group-year]')).toHaveText('$300 of $1,200 in 2026');
    await expect(hotel.locator('[data-group-note]')).toHaveCount(0);
    await expect(hotel.locator('[data-group-cards]')).toHaveText('On 2 of 3 cards');

    // Each card in the group, Alex's before Casey's, with its own year, periods and what is left now.
    expect(await hotel.locator('li.benefits-member').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-card'))))
      .toEqual([platinumId, businessId]);
    const platinum = memberRow(hotel, platinumId);
    const business = memberRow(hotel, businessId);
    await expect(platinum.locator('.benefits-row-name')).toHaveText('Platinum ··90001');
    await expect(platinum.locator('.benefits-member-owner')).toHaveText('Alex');
    await expect(business.locator('.benefits-row-name')).toHaveText('Business Platinum ··90004');
    await expect(business.locator('.benefits-member-owner')).toHaveText('Casey');
    await expect(business.locator('[data-year-figure]')).toHaveText('$300 of $600 in 2026');
    await expect(platinum.locator('[data-year-figure]')).toHaveText('$0 of $600 in 2026');
    await expect(cell(business, 'Jan–Jun')).toHaveAttribute('data-fill', 'full');
    await expect(cell(business, 'Jan–Jun')).toHaveAccessibleName('Jan–Jun: $300 of $300 · From statement credits');
    await expect(cell(platinum, 'Jan–Jun')).toHaveAttribute('data-fill', 'none');
    await expect(business.locator('.benefits-current-line [data-resets-soon]')).toHaveText('Jul–Dec · $300 left · 66 days left');
    await expect(business.locator('.benefits-current-line .benefits-source')).toHaveText('From statement credits');
    // Neither card's row repeats what the group says for both.
    await expect(platinum.locator('.benefits-tag')).toHaveCount(0);

    // The compared card without it is marked; a card with no product yet is set up first, and not compared.
    await expect(hotel.locator('.benefits-missing-label')).toHaveText('Without it in 2026');
    await expect(missingCard(hotel, deltaId)).toHaveText('Delta Gold Business ··0003');
    await expect(hotel.locator('.benefits-missing-person[data-owner="joint"]')).toHaveText('Joint');
    await expect(missingCard(hotel, plainId)).toHaveCount(0);
    await expect(missingCard(hotel, spareId)).toHaveCount(0);
    const setup = page.getByRole('region', { name: 'Cards to set up' });
    // Two cards to set up: few enough to stay open, each row saying what it needs (why is said once, above them).
    await expect(setup.getByRole('button', { name: '2 need a product' })).toHaveAttribute('aria-expanded', 'true');
    await expect(setup.locator('.benefits-setup-why')).toHaveCount(1);
    await expect(setup.locator(`li[data-card="${plainId}"] .benefits-setup-reason`)).toHaveText('Choose its product');
    await expect(setup.locator(`li[data-card="${spareId}"]`)).toBeVisible();

    // How often is the same on every card, so the group says it once; each card says its own amount, and one is still
    // unverified.
    const clear = benefitGroup(page, 'CLEAR+ credit');
    await expect(clear.locator('.benefits-group-head .benefits-tag')).toHaveText(['Each calendar year']);
    await expect(memberRow(clear, platinumId).locator('.benefits-tag')).toHaveText(['$219', 'Unverified']);
    await expect(memberRow(clear, businessId).locator('.benefits-tag')).toHaveText(['$209']);

    // Marked by hand and not marked yet: its months are unknown, not unused, and the group says so.
    const uber = benefitGroup(page, 'Uber Cash');
    await expect(uber.locator('[data-group-year]')).toHaveText('$0 of $200 in 2026');
    await expect(uber.locator('[data-group-note]')).toHaveText('10 periods with use unknown');
    await expect(uber.locator(':scope > .benefits-meter')).toHaveAttribute('data-unknown', 'true');
    await expect(hotel.locator(':scope > .benefits-meter')).not.toHaveAttribute('data-unknown', 'true');

    // A benefit one card has: the others are listed by person.
    const stays = benefitGroup(page, 'Delta Stays credit');
    await expect(memberRow(stays, deltaId).locator('[data-year-figure]')).toHaveText('$150 of $150 in 2026');
    await expect(stays.locator('[data-group-cards]')).toHaveText('On 1 of 3 cards');
    await expect(stays.locator('.benefits-missing-person')).toHaveText(['Alex', 'Casey']);
    await expect(missingCard(stays, platinumId)).toHaveText('Platinum ··90001');
    await expect(missingCard(stays, businessId)).toHaveText('Business Platinum ··90004');

    // Once every few years, in its section after the dollar credits: where it can be used now rather than a yearly figure.
    const entry = travel.getByRole('region', { name: 'Global Entry or TSA PreCheck fee' });
    await expect(travel.locator('.benefits-group-name h4').last()).toHaveText('Global Entry or TSA PreCheck fee');
    await expect(entry.locator('[data-group-year]')).toHaveCount(0);
    await expect(entry.locator('[data-group-available]')).toHaveText('Available now on 2 of 2');
    await expect(memberRow(entry, businessId).locator('.benefits-window')).toHaveText('Available · once every 4 years');
    await expect(missingCard(entry, deltaId)).toBeVisible();
  });

  test('sets a card up from the By benefit view, which then compares it', async ({ page }) => {
    await openBenefits(page);
    const setup = page.getByRole('region', { name: 'Cards to set up' });
    const spare = setup.locator(`li[data-card="${spareId}"]`);
    await spare.getByLabel('Product').selectOption({ label: 'The Hilton Honors American Express Business Card' });
    await spare.getByRole('button', { name: 'Save' }).click();
    await expect(setup.locator(`li[data-card="${spareId}"]`)).toHaveCount(0);
    // One Hilton credit, two cards with their own terms. Neither has used it: folded to its line until opened.
    const hilton = benefitGroup(page, 'Hilton credit');
    const hiltonCards = hilton.getByRole('button', { name: 'On 2 of 4 cards' });
    await expect(hiltonCards).toHaveAttribute('aria-expanded', 'false');
    await hiltonCards.click();
    // Both quarterly: said once, for the group; each card its own amount, and the one that needs enrolling says so.
    await expect(hilton.locator('.benefits-group-head .benefits-tag')).toHaveText(['Quarterly']);
    await expect(memberRow(hilton, businessId).locator('.benefits-tag')).toHaveText(['$50', 'Enrollment required']);
    await expect(memberRow(hilton, spareId).locator('.benefits-row-name')).toHaveText('Hilton Business ··0005');
    await expect(memberRow(hilton, spareId).locator('.benefits-tag')).toHaveText(['$60']);
    await expect(memberRow(hilton, spareId).locator('.benefits-cell')).toHaveCount(4);
    await expect(hilton.locator('[data-group-cards]')).toHaveText('On 2 of 4 cards');
    await expect(missingCard(benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)'), spareId)).toHaveText('Hilton Business ··0005');
  });

  test('marks a card\'s period from its group, and the group\'s year adds it up', async ({ page }) => {
    await openBenefits(page);
    const listed = await groupNames(page.locator('.benefits'));
    const hotel = benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)');
    const platinum = memberRow(hotel, platinumId);
    await platinum.getByRole('button', { name: 'Details for Hotel credit (FHR / The Hotel Collection) on Platinum ··90001, Jul–Dec' }).click();
    const detail = platinum.getByRole('region', { name: 'Hotel credit (FHR / The Hotel Collection) on Platinum ··90001, Jul–Dec' });
    await expect(detail).toContainText('No matching statement credit in this period.');
    await detail.getByRole('button', { name: 'Mark used' }).click();
    await expect(cell(platinum, 'Jul–Dec')).toHaveAccessibleName('Jul–Dec (now): $300 of $300 · Marked by you');
    await expect(platinum.locator('[data-year-figure]')).toHaveText('$300 of $600 in 2026');
    await expect(hotel.locator('[data-group-year]')).toHaveText('$600 of $1,200 in 2026');
    // Used twice now, it is listed where it was: nothing moves while periods are marked.
    expect(await groupNames(page.locator('.benefits'))).toEqual(listed);
    await expect(detail).toBeVisible();
    // The other card's row is its own.
    await expect(cell(memberRow(hotel, businessId), 'Jul–Dec')).toHaveAccessibleName('Jul–Dec (now): $0 of $300 · From statement credits');
    await detail.getByRole('button', { name: 'Clear my mark' }).click();
    await expect(hotel.locator('[data-group-year]')).toHaveText('$300 of $1,200 in 2026');
    await expect(cell(platinum, 'Jul–Dec')).toHaveAccessibleName('Jul–Dec (now): $0 of $300 · From statement credits');
  });

  test('a reminder goes to its card\'s row in the benefit\'s group', async ({ page }) => {
    await openBenefits(page);
    const reminders = page.getByRole('region', { name: 'Use before it resets' });
    await reminders.locator('li').filter({ hasText: 'Platinum ··90001' }).filter({ hasText: 'Digital entertainment credit' })
      .getByRole('link').click();
    const row = memberRow(benefitGroup(page, 'Digital entertainment credit'), platinumId);
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute('id', `benefit-${platinumId}-digital-entertainment`);
    // The focus goes with it, as following a link within the page does.
    await expect(row).toBeFocused();
  });

  test('keeps the view chosen; By card still lists each card with its benefits', async ({ page }) => {
    await openBenefits(page);
    const views = page.getByRole('group', { name: 'Group by' });
    await views.getByRole('button', { name: 'By card' }).click();
    await expect(cardPanel(page, platinumId)).toBeVisible();
    await expect(page.locator('.benefits-group')).toHaveCount(0);
    await page.reload();
    await expect(views.getByRole('button', { name: 'By card' })).toHaveAttribute('aria-pressed', 'true');
    await expect(cardPanel(page, businessId)).toBeVisible();
    await views.getByRole('button', { name: 'By benefit' }).click();
    await expect(page.locator('article.benefits-card')).toHaveCount(0);
    await expect(benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)')).toBeVisible();
  });

  test('keeps every fill, empty slot and person drawn in forced colours', async ({ page }) => {
    await openBenefits(page);
    await expect(benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)')).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ forcedColors: 'active', colorScheme });
      const painted = await page.evaluate(() => {
        const area = document.querySelector('.benefits');
        if (!area) throw new Error('no Benefits area');
        const probe = document.createElement('span');
        area.append(probe);
        const resolve = (value: string) => { probe.style.color = value; return getComputedStyle(probe).color; };
        const colours = { highlight: resolve('Highlight'), canvas: resolve('Canvas') };
        probe.remove();
        const slot = area.querySelector('.benefits-missing-card');
        if (!slot) throw new Error('no card without a benefit');
        const unknown = area.querySelector('.benefits-group .benefits-meter[data-unknown="true"]');
        if (!unknown) throw new Error('no group with periods not known yet');
        return {
          ...colours,
          fills: [...new Set([...area.querySelectorAll('.benefits-group .benefits-meter > span, .benefits-group .benefits-cell-meter > span')]
            .map((node) => getComputedStyle(node).backgroundColor))],
          slot: { style: getComputedStyle(slot).borderTopStyle, color: getComputedStyle(slot).borderTopColor },
          unknown: getComputedStyle(unknown).borderTopStyle,
          dots: [...area.querySelectorAll('.benefits-group .benefits-owner-dot')].map((node) => getComputedStyle(node).backgroundColor),
        };
      });
      expect(painted.fills, colorScheme).toEqual([painted.highlight]);
      expect(painted.slot.style, colorScheme).toBe('dashed');
      expect(painted.unknown, colorScheme).toBe('dashed');
      expect(contrast(painted.slot.color, painted.canvas), colorScheme).toBeGreaterThanOrEqual(3);
      expect(painted.dots.length, colorScheme).toBeGreaterThan(0);
      for (const dot of painted.dots) expect(contrast(dot, painted.canvas), `${colorScheme} dot ${dot}`).toBeGreaterThanOrEqual(3);
    }
  });

  test('never cuts a period\'s name short, from a phone to a wide screen, in either view', async ({ page }) => {
    await openBenefits(page);
    await expect(memberRow(benefitGroup(page, 'Digital entertainment credit'), platinumId).locator('.benefits-cell')).toHaveCount(12);
    const views = page.getByRole('group', { name: 'Group by' });
    for (const view of ['By benefit', 'By card'] as const) {
      await views.getByRole('button', { name: view }).click();
      await expect(views.getByRole('button', { name: view })).toHaveAttribute('aria-pressed', 'true');
      // Each side of every layout change: the phone grid of six, the card beside its periods, today's period beside them.
      for (const width of [320, 390, 480, 600, 720, 721, 768, 769, 800, 900, 999, 1000, 1024, 1050, 1100, 1184, 1200, 1280, 1440, 1679, 1680, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => ({
          months: document.querySelectorAll('.benefits .benefits-grid[data-count="12"] .benefits-cell').length,
          clipped: [...document.querySelectorAll('.benefits .benefits-cell-label')]
            .filter((label) => label.scrollWidth > label.clientWidth)
            .map((label) => `${label.textContent} (${label.clientWidth} of ${label.scrollWidth}px)`),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        expect(layout.months, `${view} at ${width}px`).toBeGreaterThan(0);
        expect(layout.clipped, `${view} at ${width}px`).toEqual([]);
        expect(layout.overflow, `${view} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  });

  test('an annual credit\'s one period opens from today\'s line, to be marked; a past year\'s from a compact control', async ({ page }) => {
    await openBenefits(page);
    await orderSwitch(page).getByRole('button', { name: 'By category' }).click();
    const platinum = memberRow(benefitGroup(page, 'CLEAR+ credit'), platinumId);
    // Today's only period has no box of its own: today's line says it and opens it.
    await expect(platinum.locator('.benefits-grid')).toHaveCount(0);
    await expect(platinum.locator('.benefits-current-line strong')).toHaveText('2026');
    await platinum.getByRole('button', { name: 'Details for CLEAR+ credit on Platinum ··90001, 2026' }).click();
    const detail = platinum.getByRole('region', { name: 'CLEAR+ credit on Platinum ··90001, 2026' });
    await detail.getByRole('button', { name: 'Mark used' }).click();
    await expect(platinum.locator('[data-year-figure]')).toHaveText('$219 of $219 in 2026');
    await detail.getByRole('button', { name: 'Clear my mark' }).click();
    await expect(platinum.locator('[data-year-figure]')).toHaveText('$0 of $219 in 2026');
    // A past year's one period: a compact control beside the card, which opens it.
    await page.getByRole('button', { name: 'Previous year' }).click();
    await expect(page.locator('.benefits-toolbar .spending-month-label')).toHaveText('2025');
    const past = memberRow(benefitGroup(page, 'CLEAR+ credit'), platinumId);
    const period = past.locator('.benefits-grid .benefits-cell');
    await expect(period).toHaveCount(1);
    expect((await period.boundingBox())!.height).toBeLessThanOrEqual(48);
    await period.click();
    await expect(period).toHaveAttribute('aria-pressed', 'true');
    await expect(past.locator('.benefits-detail')).toBeVisible();
  });
});

test.describe('Benefits area: most used first', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('lists the benefits most used first, by tier, and folds those with no recorded use to a line', async ({ page }) => {
    await openBenefits(page);
    await expect(orderSwitch(page).getByRole('button', { name: 'Most used' })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.benefits-tier > .benefits-section-head h3').allTextContents())
      .toEqual(['Recorded use', 'Use unknown', 'Occasional', 'No recorded use']);
    // Recorded use: the monthly credit used in four months first, then those used once (the latest first, else as By
    // category lists them); in a group, the card that used it first.
    expect(await groupNames(usageTier(page, 'Recorded use')))
      .toEqual(['Digital entertainment credit', 'Hotel credit (FHR / The Hotel Collection)', 'Delta Stays credit', 'Saks Fifth Avenue credit']);
    const hotel = benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)');
    expect(await hotel.locator('li.benefits-member').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-card'))))
      .toEqual([businessId, platinumId]);
    // Marked by hand and not marked yet: its use is unknown, never called unused.
    expect(await groupNames(usageTier(page, 'Use unknown'))).toEqual(['Uber Cash']);
    await expect(usageTier(page, 'Occasional').getByRole('region', { name: 'Global Entry or TSA PreCheck fee' })).toBeVisible();

    // No recorded use: a line each, with what is left now and the days to use it; its cards behind the toggle.
    const walmart = usageTier(page, 'No recorded use').getByRole('region', { name: 'Walmart+ credit', exact: true });
    await expect(walmart.locator('[data-group-left]')).toHaveText('$12.95 left now');
    await expect(walmart.locator('[data-group-days]')).toHaveText('5 days left');
    const cards = walmart.getByRole('button', { name: 'On 1 of 4 cards' });
    await expect(cards).toHaveAttribute('aria-expanded', 'false');
    await expect(walmart.locator('li.benefits-member')).toHaveCount(0);
    const [name, toggle] = [await walmart.locator('h4').boundingBox(), await cards.boundingBox()];
    expect(toggle!.y).toBeLessThan(name!.y + name!.height);
    await cards.click();
    await expect(cards).toHaveAttribute('aria-expanded', 'true');
    await expect(memberRow(walmart, platinumId).locator('.benefits-cell')).toHaveCount(12);
    await cards.press('Enter');
    await expect(cards).toHaveAttribute('aria-expanded', 'false');
    await expect(walmart.locator('li.benefits-member')).toHaveCount(0);

    // Nothing pushed sideways at any width; two lines to a row from 1680px; the toggle under the name on a phone.
    const unused = usageTier(page, 'No recorded use').locator('.benefits-group');
    for (const width of [390, 1279, 1679, 1680, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px`)
        .toBeLessThanOrEqual(0);
      const [first, second] = [await unused.nth(0).boundingBox(), await unused.nth(1).boundingBox()];
      expect(Math.abs(first!.y - second!.y) < 1, `${width}px: two to a row`).toBe(width >= 1680);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const [phoneName, phoneToggle] = [await walmart.locator('h4').boundingBox(), await cards.boundingBox()];
    expect(phoneToggle!.y).toBeGreaterThanOrEqual(phoneName!.y + phoneName!.height - 1);
  });

  test('a reminder opens a folded benefit and goes to its card\'s row', async ({ page }) => {
    await openBenefits(page);
    const walmart = benefitGroup(page, 'Walmart+ credit');
    const cards = walmart.getByRole('button', { name: 'On 1 of 4 cards' });
    await expect(cards).toHaveAttribute('aria-expanded', 'false');
    const link = page.getByRole('region', { name: 'Use before it resets' }).locator('li').filter({ hasText: 'Platinum ··90001' })
      .filter({ hasText: 'Walmart+ credit' }).getByRole('link');
    await link.click();
    await expect(cards).toHaveAttribute('aria-expanded', 'true');
    const row = memberRow(walmart, platinumId);
    await expect(row).toBeInViewport();
    await expect(row).toBeFocused();
    // From the keyboard, the row shows where the focus went.
    await cards.click();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(row).toBeFocused();
    expect(await row.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
    // By card goes straight to its row; back By benefit, that reminder is not followed again.
    const views = page.getByRole('group', { name: 'Group by' });
    await views.getByRole('button', { name: 'By card' }).click();
    await link.click();
    await expect(benefitRow(cardPanel(page, platinumId), 'walmart-plus')).toBeFocused();
    await views.getByRole('button', { name: 'By benefit' }).click();
    await expect(cards).toHaveAttribute('aria-expanded', 'false');
  });

  test('a reminder followed while last year is read goes to its row once drawn, in either view; not once the focus moved on', async ({ page }) => {
    // Last year's answer is held, then let through: read, or failed (review of #209). Held again before each reload.
    let outcome: 'read' | 'fail' | null = null;
    const held: Array<(how: 'read' | 'fail') => Promise<void>> = [];
    await page.route(/\/spending\/benefits\?year=2025/, async (route) => {
      const answer = (how: 'read' | 'fail') => (how === 'read' ? route.continue()
        : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'card spending request failed' }) }));
      if (outcome) await answer(outcome);
      else held.push(answer);
    });
    const release = async (how: 'read' | 'fail') => {
      outcome = how;
      for (const answer of held.splice(0)) await answer(how);
    };
    const reload = async () => {
      outcome = null;
      await page.reload();
    };
    const link = page.getByRole('region', { name: 'Use before it resets' }).locator('li').filter({ hasText: 'Platinum ··90001' })
      .filter({ hasText: 'Walmart+ credit' }).getByRole('link');
    const follow = async () => {
      await expect(page.getByText('Ordering by use…')).toBeVisible();
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(link).toBeFocused();
    };
    // By card, last year read, then failed: the row is gone to once it is drawn.
    const byCard = benefitRow(cardPanel(page, platinumId), 'walmart-plus');
    for (const how of ['read', 'fail'] as const) {
      if (how === 'read') await openBenefits(page, 'By card');
      else await reload();
      await follow();
      await expect(byCard).toHaveCount(0);
      await release(how);
      await expect(byCard).toBeFocused();
      await expect(byCard).toBeInViewport();
    }
    // The focus moved on before the row was drawn: it stays where the owner took it.
    await reload();
    await follow();
    const next = page.getByRole('button', { name: 'Next year' });
    await next.focus();
    await release('read');
    await expect(byCard).toBeVisible();
    await expect(next).toBeFocused();
    // By benefit: the folded group opens, and its row is gone to once drawn; back By card, it is not followed again.
    const views = page.getByRole('group', { name: 'Group by' });
    await views.getByRole('button', { name: 'By benefit' }).click();
    for (const how of ['read', 'fail'] as const) {
      await reload();
      await follow();
      await release(how);
      const walmart = benefitGroup(page, 'Walmart+ credit');
      await expect(walmart.getByRole('button', { name: 'On 1 of 4 cards' })).toHaveAttribute('aria-expanded', 'true');
      await expect(memberRow(walmart, platinumId)).toBeFocused();
    }
    await views.getByRole('button', { name: 'By card' }).click();
    await expect(byCard).toBeVisible();
    await expect(views.getByRole('button', { name: 'By card' })).toBeFocused();
  });

  test('marking a period changes its figures, not where its benefit is listed, until the page is opened again', async ({ page }) => {
    await openBenefits(page);
    const listed = await groupNames(page.locator('.benefits'));
    const platinum = memberRow(benefitGroup(page, 'Uber Cash'), platinumId);
    await platinum.getByRole('button', { name: 'Details for Uber Cash on Platinum ··90001, Oct' }).click();
    const detail = platinum.getByRole('region', { name: 'Uber Cash on Platinum ··90001, Oct' });
    // From the keyboard: once saved, the focus is back on what marked it.
    const markUsed = detail.getByRole('button', { name: 'Mark used' });
    await markUsed.focus();
    await page.keyboard.press('Enter');
    await expect(cell(platinum, 'Oct')).toHaveAccessibleName('Oct (now): $15 of $15 · Marked by you');
    await expect(markUsed).toBeFocused();
    // Used now, but still under Usage unknown, its period open where it was.
    await expect(usageTier(page, 'Use unknown').getByRole('region', { name: 'Uber Cash', exact: true })).toBeVisible();
    await expect(detail).toBeVisible();
    expect(await groupNames(page.locator('.benefits'))).toEqual(listed);

    // Opened again, the order follows the use there is now.
    await page.reload();
    await expect(usageTier(page, 'Recorded use').getByRole('region', { name: 'Uber Cash', exact: true })).toBeVisible();
    // October unmarked again (as the checks by card expect): listed where it is until the page is opened again. The
    // mark's button goes with it, so the period's first action takes the focus.
    const again = memberRow(benefitGroup(page, 'Uber Cash'), platinumId);
    await again.getByRole('button', { name: 'Details for Uber Cash on Platinum ··90001, Oct' }).click();
    const againDetail = again.getByRole('region', { name: 'Uber Cash on Platinum ··90001, Oct' });
    await againDetail.getByRole('button', { name: 'Clear my mark' }).focus();
    await page.keyboard.press('Enter');
    await expect(cell(again, 'Oct')).toHaveAccessibleName('Oct (now): — of $15 · Not marked');
    await expect(againDetail.getByRole('button', { name: 'Mark used' })).toBeFocused();
    await expect(usageTier(page, 'Recorded use').getByRole('region', { name: 'Uber Cash', exact: true })).toBeVisible();
  });

  test('keeps the order chosen, in both views; a year still to come has no order to choose', async ({ page }) => {
    await openBenefits(page);
    await orderSwitch(page).getByRole('button', { name: 'By category' }).click();
    await expect(page.locator('.benefits-tier')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Hotels', exact: true })).toBeVisible();
    await page.reload();
    await expect(orderSwitch(page).getByRole('button', { name: 'By category' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Hotels', exact: true })).toBeVisible();
    // By card orders each card's benefits the same way, so the same switch is beside it.
    const views = page.getByRole('group', { name: 'Group by' });
    await views.getByRole('button', { name: 'By card' }).click();
    await expect(orderSwitch(page).getByRole('button', { name: 'By category' })).toHaveAttribute('aria-pressed', 'true');
    await views.getByRole('button', { name: 'By benefit' }).click();
    await orderSwitch(page).getByRole('button', { name: 'Most used' }).click();
    await expect(usageTier(page, 'Recorded use')).toBeVisible();
    await page.getByRole('button', { name: 'Next year' }).click();
    await expect(page.locator('.benefits-toolbar .spending-month-label')).toHaveText('2027');
    await expect(orderSwitch(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Hotels', exact: true })).toBeVisible();
    await expect(page.locator('.benefits-tier')).toHaveCount(0);
  });

  test('By card lists each card\'s benefits most used first, By category in the report\'s order, and a mark moves no row', async ({ page, request }) => {
    await openBenefits(page, 'By card');
    await expect(orderSwitch(page).getByRole('button', { name: 'Most used' })).toHaveAttribute('aria-pressed', 'true');
    const platinum = cardPanel(page, platinumId);
    const ids = () => platinum.locator('li.benefits-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-benefit')));
    await expect(benefitRow(platinum, 'digital-entertainment')).toBeVisible();
    // Used in four months, then once; marked by hand and not marked yet, before those never used.
    const listed = await ids();
    expect(listed.slice(0, 2)).toEqual(['digital-entertainment', 'saks']);
    expect(listed.indexOf('uber-cash')).toBeLessThan(listed.indexOf('walmart-plus'));
    // A mark moves no row: Uber Cash's October marked used from the keyboard stays where it is, open, the focus kept.
    const uber = benefitRow(platinum, 'uber-cash');
    await cell(uber, 'Oct').click();
    const markUsed = uber.getByRole('button', { name: 'Mark used' });
    await markUsed.focus();
    await page.keyboard.press('Enter');
    await expect(cell(uber, 'Oct')).toHaveAccessibleName('Oct (now): $15 of $15 · Marked by you');
    await expect(markUsed).toBeFocused();
    expect(await ids()).toEqual(listed);
    await uber.getByRole('button', { name: 'Clear my mark' }).click();
    await expect(cell(uber, 'Oct')).toHaveAccessibleName('Oct (now): — of $15 · Not marked');
    // By category: each card's benefits in the report's own order.
    const answer = await request.get('/spending/benefits?year=2026&today=2026-10-27');
    const own = ((await answer.json()) as { cards: Array<{ cardAccountId: string; benefits: Array<{ id: string }> }> }).cards
      .find((entry) => entry.cardAccountId === platinumId)!.benefits.map((entry) => entry.id);
    expect(own).not.toEqual(listed);
    await orderSwitch(page).getByRole('button', { name: 'By category' }).click();
    await expect.poll(ids).toEqual(own);
  });

  test('orders by this year alone when last year cannot be read, and a mark never reads it again under the period', async ({ page }) => {
    // Last year cannot be read at first, then can: read again after a mark and answered, it would move what is being marked.
    let failing = true;
    let rereads = 0;
    await page.route(/\/spending\/benefits\?year=2025/, (route) => {
      if (failing) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'card spending request failed' }) });
      }
      rereads += 1;
      return route.continue();
    });
    await openBenefits(page);
    const note = page.locator('[data-history-failed]');
    await expect(note)
      .toHaveText('Ordered by 2026 alone: last year\'s benefits could not be read, so use before January is not counted.');
    await expect(page.locator('.benefits .spending-error')).toHaveCount(0);
    expect((await groupNames(usageTier(page, 'Recorded use')))[0]).toBe('Digital entertainment credit');
    failing = false;

    const listed = await groupNames(page.locator('.benefits'));
    const platinum = memberRow(benefitGroup(page, 'Uber Cash'), platinumId);
    await platinum.getByRole('button', { name: 'Details for Uber Cash on Platinum ··90001, Oct' }).click();
    const detail = platinum.getByRole('region', { name: 'Uber Cash on Platinum ··90001, Oct' });
    const markUsed = detail.getByRole('button', { name: 'Mark used' });
    await markUsed.focus();
    const reread = page.waitForRequest(/\/spending\/benefits\?year=2025/, { timeout: 1500 }).then(() => true, () => false);
    await page.keyboard.press('Enter');
    await expect(cell(platinum, 'Oct')).toHaveAccessibleName('Oct (now): $15 of $15 · Marked by you');
    // Last year is not read again; the benefit stays where it was, its period open, the focus in it, the note said.
    expect(await reread).toBe(false);
    expect(rereads).toBe(0);
    await expect(markUsed).toBeFocused();
    await expect(usageTier(page, 'Use unknown').getByRole('region', { name: 'Uber Cash', exact: true })).toBeVisible();
    await expect(detail).toBeVisible();
    expect(await groupNames(page.locator('.benefits'))).toEqual(listed);
    await expect(note).toBeVisible();

    // Opened again: last year is read, and the order follows the use there is now.
    await page.reload();
    await expect(usageTier(page, 'Recorded use').getByRole('region', { name: 'Uber Cash', exact: true })).toBeVisible();
    await expect(note).toHaveCount(0);
    expect(rereads).toBeGreaterThan(0);
    // October unmarked again, for the checks that follow.
    const again = memberRow(benefitGroup(page, 'Uber Cash'), platinumId);
    await again.getByRole('button', { name: 'Details for Uber Cash on Platinum ··90001, Oct' }).click();
    await again.getByRole('region', { name: 'Uber Cash on Platinum ··90001, Oct' }).getByRole('button', { name: 'Clear my mark' }).click();
    await expect(cell(again, 'Oct')).toHaveAccessibleName('Oct (now): — of $15 · Not marked');
  });
});

test.describe('Benefits area, by card', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows each benefit of a card by period, from its statement credits, with the year\'s figures', async ({ page }) => {
    await openBenefits(page, 'By card');
    const platinum = cardPanel(page, platinumId);
    await expect(platinum.getByRole('heading', { name: 'Platinum ··90001' })).toBeVisible();
    await expect(platinum).toContainText('The Platinum Card from American Express · Product from the card\'s name');
    const entertainment = benefitRow(platinum, 'digital-entertainment');
    await expect(entertainment.locator('.benefits-row-name')).toHaveText('Digital entertainment credit');
    await expect(entertainment.locator('.benefits-tag')).toContainText(['Monthly', 'Enrollment required']);
    await expect(entertainment.locator('.benefits-cell')).toHaveCount(12);
    await expect(cell(entertainment, 'Sep')).toHaveAttribute('data-fill', 'full');
    await expect(cell(entertainment, 'Sep')).toHaveAccessibleName('Sep: $25 of $25 · From statement credits');
    await expect(cell(entertainment, 'May')).toHaveAttribute('data-fill', 'none');
    await expect(cell(entertainment, 'Oct')).toHaveAccessibleName('Oct (now): $0 of $25 · From statement credits');
    await expect(entertainment.locator('[data-year-figure]')).toHaveText('$100 of $300 in 2026');
    await expect(entertainment.locator('.benefits-current-line [data-resets-soon]')).toHaveText('Oct · $25 left · 5 days left');
    await expect(entertainment.locator('.benefits-current-line .benefits-source')).toHaveText('From statement credits');

    // The store refund is no credit: the Saks credit counts once, in the first half.
    const saks = benefitRow(platinum, 'saks');
    await expect(saks.locator('.benefits-cell')).toHaveCount(2);
    await expect(cell(saks, 'Jan–Jun')).toHaveAttribute('data-fill', 'full');
    await expect(cell(saks, 'Jul–Dec')).toHaveAttribute('data-fill', 'none');

    // A matched credit opens its transaction.
    await cell(entertainment, 'Sep').click();
    const detail = entertainment.getByRole('region', { name: 'Digital entertainment credit, Sep' });
    await expect(detail).toContainText('Sep 1 – Sep 30, 2026');
    await detail.getByRole('button', { name: /SAMPLE DIGITAL ENTERTAINMENT CREDIT/ }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('SAMPLE DIGITAL ENTERTAINMENT CREDIT');
    await drawer.getByRole('button', { name: 'Close details' }).click();
    await expect(drawer).toHaveCount(0);

    // Reminders: what resets within days, with something left.
    const reminders = page.getByRole('region', { name: 'Use before it resets' });
    await expect(reminders.locator('li').filter({ hasText: `Platinum ··90001` }).filter({ hasText: 'Digital entertainment credit' }))
      .toContainText('$25 left');
  });

  test('marks a benefit by hand, which replaces what Holdr derived, and clears the mark again', async ({ page }) => {
    await openBenefits(page, 'By card');
    const platinum = cardPanel(page, platinumId);
    const uber = benefitRow(platinum, 'uber-cash');
    await expect(uber.locator('.benefits-tag', { hasText: 'Mark by hand' }))
      .toHaveAttribute('title', 'Lands in the partner\'s app, not on the statement: mark it by hand');
    await expect(cell(uber, 'Oct')).toHaveAccessibleName('Oct (now): — of $15 · Not marked');
    await expect(cell(uber, 'Dec')).toHaveAccessibleName('Dec (ahead): — of $35 · Not marked');
    await cell(uber, 'Oct').click();
    await expect(uber.getByRole('region', { name: 'Uber Cash, Oct' })).toContainText('$15 a month, $35 in December');
    await uber.getByRole('button', { name: 'Mark used' }).click();
    await expect(cell(uber, 'Oct')).toHaveAccessibleName('Oct (now): $15 of $15 · Marked by you');
    await expect(uber.locator('.benefits-current .benefits-source')).toHaveText('Marked by you');

    // A partial amount on a derived credit wins over the matched credits, until cleared. The focus stays with the
    // control that saved, and goes to the period's first action when the mark (and its button) goes.
    const entertainment = benefitRow(platinum, 'digital-entertainment');
    await cell(entertainment, 'Sep').click();
    const detail = entertainment.getByRole('region', { name: 'Digital entertainment credit, Sep' });
    await detail.getByLabel('Amount used, in dollars').fill('10');
    await detail.getByRole('button', { name: 'Save amount' }).click();
    await expect(cell(entertainment, 'Sep')).toHaveAccessibleName('Sep: $10 of $25 · Marked by you');
    await expect(detail.getByRole('button', { name: 'Save amount' })).toBeFocused();
    await expect(detail).toContainText('Your mark replaces the matched credits ($25) here.');
    await detail.getByRole('button', { name: 'Clear my mark' }).click();
    await expect(cell(entertainment, 'Sep')).toHaveAccessibleName('Sep: $25 of $25 · From statement credits');
    await expect(detail.getByRole('button', { name: 'Mark used' })).toBeFocused();

    // Uber Cash's October is still open: clear its mark.
    await uber.getByRole('button', { name: 'Clear my mark' }).click();
    await expect(cell(uber, 'Oct')).toHaveAccessibleName('Oct (now): — of $15 · Not marked');
  });

  test('lets the owner choose a card\'s product and its anniversary month', async ({ page }) => {
    await openBenefits(page, 'By card');
    const plain = cardPanel(page, plainId);
    await expect(plain).toContainText('Choose this card\'s product to track its benefits.');
    await plain.getByLabel('Product').selectOption({ label: 'Hilton Honors American Express Aspire Card' });
    await plain.getByRole('button', { name: 'Save' }).click();
    await expect(plain.getByRole('heading', { name: 'Hilton Aspire ··0002' })).toBeVisible();
    await expect(plain).toContainText('Product chosen by you');
    const night = benefitRow(plain, 'free-night');
    await expect(night).toContainText('Set the card\'s anniversary month to place this benefit.');
    await plain.getByLabel('Anniversary month').selectOption({ label: 'March' });
    await plain.getByRole('button', { name: 'Save' }).click();
    // Its one period this year is today's: today's line says it and opens it, with no box of its own.
    await expect(night.locator('.benefits-current-line strong')).toHaveText('Mar 2026 – Feb 2027');
    await expect(night.locator('.benefits-grid')).toHaveCount(0);
    await night.getByRole('button', { name: 'Details for Free night award, Mar 2026 – Feb 2027' }).click();
    await expect(night.getByRole('region', { name: 'Free night award, Mar 2026 – Feb 2027' })).toBeVisible();
    await expect(benefitRow(plain, 'resort').locator('.benefits-cell')).toHaveCount(2);

    // A cardmember year that began last year is today's period: it is marked from its own line. This year's one period,
    // still to come, keeps a compact control of its own that opens it.
    await plain.getByRole('button', { name: 'Card settings' }).click();
    await plain.getByLabel('Anniversary month').selectOption({ label: 'November' });
    // The settings' Save (the open period has a Save amount of its own).
    await plain.getByRole('button', { name: 'Save', exact: true }).click();
    const ahead = cell(night, 'Nov 2026 – Oct 2027');
    await expect(ahead).toHaveAttribute('data-state', 'future');
    expect((await ahead.boundingBox())!.height).toBeLessThanOrEqual(48);
    await ahead.click();
    await expect(night.getByRole('region', { name: 'Free night award, Nov 2026 – Oct 2027' })).toBeVisible();
    await expect(night.locator('.benefits-current-line [data-resets-soon]')).toHaveText('Nov 2025 – Oct 2026 · Not marked yet · 5 days left');
    await night.getByRole('button', { name: 'Details for Free night award, Nov 2025 – Oct 2026' }).click();
    await night.getByRole('region', { name: 'Free night award, Nov 2025 – Oct 2026' }).getByRole('button', { name: 'Mark used' }).click();
    await expect(night.locator('.benefits-current-line [data-resets-soon]')).toHaveText('Nov 2025 – Oct 2026 · Used · renews after Oct 31');
  });

  test('goes back a year, with the versions of each benefit that applied then', async ({ page }) => {
    await openBenefits(page, 'By card');
    await page.getByRole('button', { name: 'Previous year' }).click();
    await expect(page.locator('.benefits-toolbar .spending-month-label')).toHaveText('2025');
    const entertainment = benefitRow(cardPanel(page, platinumId), 'digital-entertainment');
    await expect(cell(entertainment, 'Aug')).toHaveAccessibleName('Aug: $20 of $20 · From statement credits');
    await expect(cell(entertainment, 'Dec')).toHaveAccessibleName('Dec: $0 of $25 · From statement credits');
    // The hotel credit was once a year until September 2025: its one period, a compact control that opens it.
    const annual = benefitRow(cardPanel(page, platinumId), 'hotel-annual');
    await expect(annual.locator('.benefits-cell')).toHaveCount(1);
    await annual.locator('.benefits-cell').click();
    await expect(annual.locator('.benefits-detail')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Use before it resets' })).toHaveCount(0);
  });

  test('shows nothing of another year while a year loads, or after it failed', async ({ page }) => {
    await openBenefits(page, 'By card');
    await expect(cardPanel(page, platinumId)).toBeVisible();
    await page.route(/\/spending\/benefits\?year=2025/, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'card spending request failed' }),
    }));
    await page.getByRole('button', { name: 'Previous year' }).click();
    await expect(page.locator('.benefits .spending-error')).toHaveText('card spending request failed');
    await expect(page.locator('.benefits-toolbar .spending-month-label')).toHaveText('2025');
    // 2026's cards and figures are gone, so nothing can be marked against the wrong year.
    await expect(page.locator('article.benefits-card')).toHaveCount(0);
    await expect(page.locator('.benefits-summary')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next year' }).click();
    await expect(cardPanel(page, platinumId)).toBeVisible();
    await expect(page.locator('.benefits .spending-error')).toHaveCount(0);
  });

  test('keeps every fill, today\'s period and the chosen one drawn in forced colours, light or dark', async ({ page }) => {
    await openBenefits(page, 'By card');
    const platinum = cardPanel(page, platinumId);
    const entertainment = benefitRow(platinum, 'digital-entertainment');
    await expect(cardPanel(page, deltaId).locator(':scope > .benefits-meter')).toHaveAttribute('data-tone', 'over');
    await expect(cell(entertainment, 'Sep')).toHaveAttribute('data-fill', 'full');
    await cell(entertainment, 'Sep').click();
    await expect(cell(entertainment, 'Sep')).toHaveAttribute('aria-pressed', 'true');
    await expect(cell(entertainment, 'Oct')).toHaveAttribute('data-state', 'current');
    await expect(cell(benefitRow(platinum, 'uber-cash'), 'Oct')).toHaveAttribute('data-fill', 'unknown');

    // The palette's own colours: a fee paid and a used-up period in the gain colour, the rest in the accent.
    const normal = await paintedStates(page);
    expect([normal.over, normal.full, normal.household]).toEqual([normal.gain, normal.gain, normal.accent]);
    expect(normal.chosen.shadow).not.toBe('none');

    // Forced colours drop backgrounds and shadows: whatever its state, a fill is the system's Highlight on an
    // edged track, and the period edges stand in for the hatching and the rings.
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ forcedColors: 'active', colorScheme });
      const forced = await paintedStates(page);
      expect(forced.fills, colorScheme).toEqual([forced.highlight]);
      expect([forced.over, forced.full, forced.household], colorScheme).toEqual([forced.highlight, forced.highlight, forced.highlight]);
      expect(contrast(forced.highlight, forced.canvas), colorScheme).toBeGreaterThanOrEqual(3);
      expect(forced.track, colorScheme).toEqual({ style: 'solid', color: forced.canvasText });
      expect(forced.unknown, colorScheme).toBe('dashed');
      expect(forced.current, colorScheme).toBe(forced.highlight);
      expect(forced.chosen, colorScheme).toEqual({ color: forced.highlight, width: '2px', shadow: 'none' });
      expect(forced.other, colorScheme).not.toBe(forced.highlight);
      expect(forced.dots.length, colorScheme).toBeGreaterThan(0);
      for (const dot of forced.dots) expect(contrast(dot, forced.canvas), `${colorScheme} dot ${dot}`).toBeGreaterThanOrEqual(3);
    }
  });
});

test.describe('Benefits area (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('fits a phone screen, the year grid included', async ({ page }) => {
    await openBenefits(page, 'By card');
    const entertainment = benefitRow(cardPanel(page, platinumId), 'digital-entertainment');
    await entertainment.scrollIntoViewIfNeeded();
    await expect(entertainment.locator('.benefits-cell')).toHaveCount(12);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await cell(entertainment, 'Oct').click();
    await expect(entertainment.getByRole('button', { name: 'Mark used' })).toBeVisible();
  });

  test('fits a phone screen by benefit too: each card of a group, its year grid and who lacks it', async ({ page }) => {
    await openBenefits(page);
    await expect(page.getByRole('group', { name: 'Group by' }).getByRole('button')).toHaveCount(2);
    const group = benefitGroup(page, 'Digital entertainment credit');
    const entertainment = memberRow(group, platinumId);
    await entertainment.scrollIntoViewIfNeeded();
    await expect(entertainment.locator('.benefits-cell')).toHaveCount(12);
    // Four compared cards lack it by now: more than a few, so they are folded behind their count until asked for.
    const without = group.getByRole('button', { name: /^Without it in 2026/ });
    await expect(without).toHaveAttribute('aria-expanded', 'false');
    await without.click();
    await expect(missingCard(group, businessId)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await cell(entertainment, 'Oct').click();
    await expect(entertainment.getByRole('button', { name: 'Mark used' })).toBeVisible();
  });
});

test.describe('Benefits area: long lists fold behind their counts', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('cards to set up and cards without a benefit fold once there are more than three, and open on request', async ({ page, request }) => {
    // By now every card of this file has its product (five compared). Four more without one make a list to fold.
    const spares: string[] = [];
    for (const [owner, ending] of [['alex', '0006'], ['casey', '0007'], ['joint', '0008'], ['alex', '0009']] as const) {
      spares.push(await createAccount(request, { issuer: 'amex', owner, nickname: `Spare ${ending} ${SUFFIX}`, last4: ending }));
    }
    await openBenefits(page);

    // Folded behind one line that says what the cards need; nothing of the list is drawn until it is opened.
    const setup = page.getByRole('region', { name: 'Cards to set up' });
    const toggle = setup.getByRole('button', { name: '4 need a product' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(setup.locator('li.benefits-setup-card')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(setup.locator('li.benefits-setup-card')).toHaveCount(4);
    for (const id of spares) await expect(setup.locator(`li[data-card="${id}"] .benefits-setup-reason`)).toHaveText('Choose its product');
    await expect(setup.locator('.benefits-setup-why')).toHaveCount(1);
    await expect(setup.locator('.benefits-hint')).toHaveCount(0);
    // A row per card, its choices beside it on a wide screen and under it on a phone, with nothing pushed sideways.
    const row = setup.locator(`li[data-card="${spares[0]}"]`);
    const [name, fields] = [await row.locator('.benefits-card-name').boundingBox(), await row.locator('.benefits-settings-fields').boundingBox()];
    expect(fields!.x).toBeGreaterThan(name!.x + name!.width - 1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const [phoneName, phoneFields] = [await row.locator('.benefits-card-name').boundingBox(), await row.locator('.benefits-settings-fields').boundingBox()];
    expect(phoneFields!.y).toBeGreaterThanOrEqual(phoneName!.y + phoneName!.height - 1);
    await page.setViewportSize({ width: 1280, height: 900 });
    // The keyboard folds it again.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(setup.locator('li.benefits-setup-card')).toHaveCount(0);

    // Four compared cards lack the Delta Stays credit: folded behind their count. Three lack the hotel credit: open.
    const stays = benefitGroup(page, 'Delta Stays credit');
    const staysToggle = stays.getByRole('button', { name: /^Without it in 2026/ });
    await expect(staysToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(staysToggle).toContainText('4 of 5 compared cards');
    await expect(stays.locator('.benefits-missing-card')).toHaveCount(0);
    await staysToggle.press('Space');
    await expect(staysToggle).toHaveAttribute('aria-expanded', 'true');
    for (const id of [platinumId, businessId, spareId, plainId]) await expect(missingCard(stays, id)).toBeVisible();
    const hotel = benefitGroup(page, 'Hotel credit (FHR / The Hotel Collection)');
    const hotelToggle = hotel.getByRole('button', { name: /^Without it in 2026/ });
    await expect(hotelToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(hotelToggle).toContainText('3 of 5 compared cards');
    await expect(missingCard(hotel, deltaId)).toBeVisible();
    await hotelToggle.click();
    await expect(hotel.locator('.benefits-missing-card')).toHaveCount(0);
  });
});