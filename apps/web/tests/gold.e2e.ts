import { COSTCO_PRODUCT_TITLE, GOLD_CARD_LAST4, GOLD_CARD_NICKNAME, TEN_GRAM_SALE_TITLE } from '../src/components/gold/goldLedgerSeed';
import { answeredFor, closesFixture, complete, overviewFixture, oz, priceMissingAnswer, soldOutAnswer } from '../src/components/gold/goldFixtures';
import { expect, requireHealthyApi, test, type Locator, type Page, type Route } from './fixtures';
import { PRICES_ON_SALE, pricesOn } from './goldPricesOn';
import {
  confirmCostcoProduct, longDate, metalsStack, productByTitle, undoCostcoProduct, undoProduct, type MetalsStack,
} from './metalsStack';

/**
 * Investing › Gold (design v8 §11, as Astra accepted the redesign), on the synthetic precious-metals ledger that
 * tests/metalsStack.ts loads through the operator's real install and import on this run's disposable database. Synthetic
 * orders, titles, amounts and last 4s only. It covers: the tab and the metal switch; the totals over all recorded history
 * (bought, sold, and the profit or loss, unavailable with why while no coverage proof is served; the metals together;
 * Review coverage), never moving with the period; the period (1M…All, rolling back from today) and its money (paid,
 * brought in, profit or loss on those sales; over All only what the totals don't already say) apart from what is held
 * as of today; one completeness line, partial and unknown said in words, never a zero; values at spot as a Holdr that
 * doesn't fetch closes shows them ("Prices off", as Holdr ships: its stored closes value nothing, ROOT O110) and as one
 * that does (`pricesOn`, served in the browser, its closes read included); the rewards estimate
 * ("rate needed", never a guess); the price chart's states (the stack's stored closes with prices off, a Holdr without
 * the closes read, a failed read with Retry, a read with its own dates and nothing pinned to an edge); confirming
 * contents from the compact card, grouped, previewed, a stale preview, a refused write and the undo; linked and unlinked
 * card charges, a charge opened in place and in Card transactions; orders held for a bullion answer, said for
 * information; and the states a stack can't reach, served in the browser.
 *
 * The specs run in order and leave the ledger as loaded: a confirmation made here is undone before the file ends.
 */

test.describe.configure({ mode: 'serial' });

let stack: MetalsStack;

test.beforeAll(async ({ request }) => {
  stack = await metalsStack(request);
});

test.beforeEach(async ({ request }) => {
  await requireHealthyApi(request);
});

/** The Gold page at rest: its reads in, nothing updating. */
async function openGold(page: Page, metal: 'Gold' | 'Silver' = 'Gold'): Promise<Locator> {
  await page.goto('/#/investing/gold');
  const gold = page.getByTestId('gold-page');
  await expect(gold.getByTestId('gold-summary')).toBeVisible();
  if (metal !== 'Gold') {
    await gold.getByRole('group', { name: 'Metal' }).getByRole('button', { name: metal, exact: true }).click();
    await expect(gold.getByRole('heading', { level: 2, name: metal, exact: true })).toBeVisible();
  }
  await expect(gold).toHaveAttribute('aria-busy', 'false');
  return gold;
}

async function choosePeriod(gold: Locator, label: '1M' | '3M' | '6M' | 'YTD' | 'All'): Promise<void> {
  const button = gold.getByRole('group', { name: 'Period' }).getByRole('button', { name: label, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(gold).toHaveAttribute('aria-busy', 'false');
}

/** Details, open: what to check, the lists, holdings and coverage. */
async function openDetails(gold: Locator): Promise<Locator> {
  const details = gold.getByTestId('gold-details');
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
  await expect(details).toHaveJSProperty('open', true);
  return details;
}

/** The compact confirm card, opened onto its grouped products. */
async function reviewProducts(gold: Locator): Promise<Locator> {
  const section = gold.getByTestId('gold-confirm');
  const button = section.getByTestId('gold-review-products');
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  return section;
}

/**
 * A list row by its own name ("Sep 10, 2026 · …", its date first), never by text in another row's opened details (a
 * card charge or a delivery on that day, say).
 */
const row = (gold: Locator, testId: string, date: string) => gold.getByTestId(testId)
  .filter({ has: gold.page().locator('.gold-row-name', { hasText: new RegExp(`^${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) });

/** To check's way to the products that need the owner's answer (v0's words, said where the page takes the answer). */
const TO_CONFIRM = /^\d+ products? needs? your answer: what (?:it|each) contains$/;

async function expand(item: Locator): Promise<Locator> {
  const toggle = item.locator('.gold-row-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return item.locator('.gold-row-details');
}

test.afterAll(async ({ request }) => {
  await undoProduct(request, COSTCO_PRODUCT_TITLE);
  await undoProduct(request, TEN_GRAM_SALE_TITLE);
});

test('Gold is a tab after Portfolio; its page names the metal, and the switch offers gold and silver', async ({ page }) => {
  const gold = await openGold(page);
  await expect(page).toHaveTitle('Gold · Investing · Holdr');
  await expect(page.getByRole('tablist', { name: 'Sections' }).getByRole('tab'))
    .toHaveText(['Portfolio', 'Gold', 'Transactions', 'Spending', 'Add', 'Import', 'Accounts']);
  await expect(page.getByRole('tab', { name: 'Gold', exact: true })).toHaveAttribute('aria-selected', 'true');
  const metals = gold.getByRole('group', { name: 'Metal' });
  await expect(metals.getByRole('button')).toHaveText(['Gold', 'Silver']);
  await expect(metals.getByRole('button', { name: 'Gold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(gold.getByRole('heading', { level: 2 })).toHaveText('Gold');
  await expect(gold.getByRole('group', { name: 'Period' }).getByRole('button')).toHaveText(['1M', '3M', '6M', 'YTD', 'All']);
});

test('the totals answer what was bought and sold over all recorded history; unproven, the profit or loss is unavailable and says why', async ({ page }) => {
  const gold = await openGold(page);
  const totals = gold.getByTestId('gold-totals');
  // First under the metal, above the period, and never moving with it.
  const order = await gold.evaluate((element) => [...element.querySelectorAll('[data-testid="gold-totals"], [data-testid="gold-totals-chips-note"], [data-testid="gold-summary"]')]
    .map((node) => node.getAttribute('data-testid')));
  expect(order).toEqual(['gold-totals', 'gold-totals-chips-note', 'gold-summary']);
  await expect(gold.getByTestId('gold-totals-chips-note')).toHaveText('Choose a period below. The totals above stay all time.');
  await expect(totals.getByRole('heading', { level: 3 })).toHaveText('Your gold · all recorded history');
  await expect(totals.getByTestId('gold-totals-as-of')).toHaveText(`As of ${longDate(stack.today)}`);
  const bought = totals.getByTestId('gold-totals-bought');
  await expect(bought.locator('dt')).toHaveText('Bought (kept or on the way)');
  await expect(bought).toContainText('$');
  await expect(bought).toContainText(/[\d.]+ troy oz(?: confirmed so far)? · \d+ recorded purchases?/);
  // Beside each figure, its limitation in short (Astra's review of b558ebcc): its state, and the history unverified. The
  // seed's figures are partial: pinned, never read back from the row itself (ROOT O137, item 2).
  await expect(bought).toHaveAttribute('data-state', 'partial');
  await expect(bought.getByTestId('gold-totals-bought-short')).toHaveText('Partial · history unverified');
  const sold = totals.getByTestId('gold-totals-sold');
  await expect(sold.locator('dt')).toHaveText('Sold');
  await expect(sold).toContainText(/troy oz(?: confirmed so far)? · \d+ recorded sales? · proceeds after fees/);
  // The seed's sale whose metal is unresolved: outside every metal's Sold, counted beside it.
  await expect(sold).toHaveAttribute('data-state', 'partial');
  await expect(sold.getByTestId('gold-totals-sold-short')).toHaveText('Partial · 1 sale not included · history unverified');
  // No reason is repeated under the figures: each is said once, folded.
  await expect(totals).not.toContainText('Recorded so far; full purchase history has not been verified.');
  // No coverage proof is served yet, and a sale has no recorded purchase: no figure, never a partial one, and why.
  const result = totals.getByTestId('gold-totals-result');
  await expect(result).toHaveAttribute('data-kind', 'unavailable');
  await expect(result).toContainText('Profit or loss unavailable: recorded purchases do not cover the recorded sales.');
  await expect(result.getByRole('button', { name: 'Review coverage' })).toBeVisible();
  // Nothing presumed about other dealers or the owner's answers while no proof is served.
  await expect(result).not.toContainText(/elsewhere|Other places/);
  await expect(result).not.toContainText('$');
  await expect(result).not.toContainText(/Costco|Walmart|CollectPure/);
  // Why: every reason once, each with the figures it affects.
  const why = totals.getByTestId('gold-totals-why');
  await why.getByRole('button', { name: 'Why these totals are incomplete' }).click();
  const reason = (text: string) => why.locator('.gold-why > li').filter({ hasText: text });
  await expect(reason('Recorded so far; full purchase history has not been verified.')).toHaveCount(1);
  await expect(reason('Recorded so far; full purchase history has not been verified.')).toContainText('Affects: Bought (kept or on the way)');
  await expect(reason('Recorded so far; full sale history has not been verified.')).toContainText('Affects: Sold');
  await expect(reason('Not included: 1 recorded sale whose metal is unresolved.')).toContainText('Affects: Sold');
  await expect(reason('Purchase coverage could not be verified.')).toHaveCount(1);
  await expect(reason('Purchase coverage could not be verified.')).toContainText('Affects: Profit or loss');
  // The refusal's own reason, in view as its title, is in the fold too.
  await expect(reason('Profit or loss unavailable: recorded purchases do not cover the recorded sales.')).toContainText('Affects: Profit or loss');
  await expect(why).not.toContainText(/Costco|Walmart|CollectPure/);
  await why.getByRole('button', { name: 'Why these totals are incomplete' }).click();
  // The period never moves them.
  const before = await totals.textContent();
  await choosePeriod(gold, '1M');
  await expect(totals).toHaveText(before ?? '');
  await choosePeriod(gold, 'All');
  await expect(totals).toHaveText(before ?? '');
  // Over All the period doesn't repeat what was paid and brought in; its sale profit, for the covered sales only, stays,
  // said as theirs, with how many right under its label.
  await expect(gold.getByTestId('gold-paid')).toHaveCount(0);
  await expect(gold.getByTestId('gold-brought-in')).toHaveCount(0);
  const saleProfit = gold.getByTestId('gold-sale-profit');
  await expect(saleProfit).toHaveAttribute('data-scope', 'covered');
  await expect(saleProfit.locator('.gold-result-label')).toHaveText('Profit or loss on covered sales, before rewards');
  await expect(saleProfit.getByTestId('gold-sale-profit-scope')).toHaveText(/^Known for \d+ of \d+ sale lines/);
  expect(await saleProfit.evaluate((node) => [...node.children].slice(0, 3).map((child) => child.className.split(' ')[0])))
    .toEqual(['gold-result-label', 'gold-result-scope', 'gold-figure']);
  // What the figures include, folded.
  await totals.getByRole('button', { name: 'What this includes' }).click();
  await expect(totals).toContainText('Only purchases kept or on the way count; cancelled and returned ones are listed under Details, not here.');
  await expect(totals).toContainText('Sale proceeds aren’t bank deposits');
  await expect(totals).toContainText('Profit or loss excludes card rewards and Costco Executive rewards.');
  // The metals together, folded, money only: unavailable while a metal's is, or a sale's metal is unresolved.
  const combined = totals.getByTestId('gold-totals-combined');
  await combined.getByRole('button', { name: 'Gold and silver combined' }).click();
  await expect(combined.getByTestId('gold-combined-bought')).toContainText('money only; ounces of different metals aren’t added');
  await expect(combined.getByTestId('gold-combined-sold-short')).toContainText('1 sale not included');
  const together = combined.getByTestId('gold-combined-result');
  await expect(together).toContainText('Combined profit or loss unavailable');
  await expect(together.getByTestId('gold-combined-result-lead')).toHaveText('1 purchase or sale has an unresolved metal, so it belongs to no one metal’s totals.');
  await expect(together).not.toContainText('$');
  // That sale is said once for the metals together, never as each metal's own; each metal's refusal is said.
  const combinedWhy = combined.getByTestId('gold-combined-why');
  await combinedWhy.getByRole('button', { name: 'Why these totals are incomplete' }).click();
  await expect(combinedWhy.locator('.gold-why > li').filter({ hasText: 'Not included: 1 recorded sale whose metal is unresolved.' })).toHaveCount(1);
  await expect(combinedWhy).not.toContainText(/(?:Gold|Silver): Not included/);
  await expect(combinedWhy).toContainText('Gold’s profit or loss is unavailable.');
  await expect(combinedWhy).toContainText('Silver’s profit or loss is unavailable.');
  // Review coverage: where the figures come from, in Details, opened, its toggle focused.
  await result.getByRole('button', { name: 'Review coverage' }).click();
  await expect(gold.getByTestId('gold-details')).toHaveJSProperty('open', true);
  const sources = gold.getByTestId('gold-sources').getByRole('button', { name: 'Where these figures come from' });
  await expect(sources).toHaveAttribute('aria-expanded', 'true');
  await expect(sources).toBeFocused();
});

test('the period\'s money stands apart from what is held as of today; one completeness line says why, and Review opens what to confirm', async ({ page }) => {
  const gold = await openGold(page);
  // Over 6M: what was paid and what sales brought in, in the period.
  await expect(gold.getByTestId('gold-paid')).toContainText(/purchases? kept or on the way, by order date · [\d.]+ troy oz/);
  await expect(gold.getByTestId('gold-brought-in')).toContainText(/sales? by day agreed, after .+ fees/);
  await choosePeriod(gold, 'All');
  await expect(gold.getByTestId('gold-period').getByRole('heading', { level: 3 })).toHaveText(`All time · to ${longDate(stack.today)}`);
  // Over All, the totals above say what was paid and brought in: the period doesn't repeat them.
  await expect(gold.getByTestId('gold-paid')).toHaveCount(0);
  await expect(gold.getByTestId('gold-brought-in')).toHaveCount(0);
  // The sale profit: known for some sales while a sale line's content is unknown, so for the covered sales, its cost
  // earliest units first.
  await expect(gold.getByTestId('gold-sale-profit')).toContainText('earliest units first');
  await expect(gold.getByTestId('gold-sale-profit').locator('.gold-result-label')).toHaveText('Profit or loss on covered sales, before rewards');
  await expect(gold.getByTestId('gold-sale-profit-scope')).toHaveText(/^Known for \d+ of \d+ sale lines · 1 has unknown content$/);
  // What is held: as of today, never added to the period's figures.
  const holding = gold.getByTestId('gold-holding');
  await expect(holding.getByRole('heading', { level: 3 })).toHaveText(`What you hold · as of ${longDate(stack.today)}`);
  await expect(holding.getByTestId('gold-held-oz')).toContainText('troy oz (partial) · delivered purchases not assigned to a sale');
  // What awaits carries the holdings' reasons (partial); no awaiting ounce is unassigned, but with reasons that zero is
  // unknown (G3), so it is said unknown, never 0.
  await expect(holding.getByTestId('gold-awaiting'))
    .toHaveText('Awaiting delivery: 1.000 troy oz (partial), of which — (unknown) not assigned to a sale');
  // This Holdr doesn't fetch closes: no value or gain at spot shows, whatever closes are stored, and no price guard note.
  await expect(holding.getByTestId('gold-price-note')).toHaveText(
    'Prices off: this Holdr doesn\'t fetch CNBC daily closes, so no value or gain at spot shows. Ounces and costs still show.');
  await expect(holding.getByTestId('gold-value')).toHaveText('Prices off');
  await expect(holding.getByTestId('gold-gain')).toHaveText('Prices off');
  await expect(holding.getByTestId('gold-cost')).toContainText('$');
  await expect(holding.getByTestId('gold-level-shift')).toHaveCount(0);
  // One line over every figure, what waits for the owner said where the page takes the answer.
  const warning = gold.getByTestId('gold-summary-warning');
  await expect(warning).toContainText(/^Totals are partial: /);
  await expect(warning).toContainText(/products? needs? your answer: what (?:it|each) contains/);
  await expect(warning).toContainText('1 unit sold has no recorded purchase');
  await expect(warning).toContainText('not every day is covered by a source\'s capture');
  // Review opens the compact card onto its products, its heading focused.
  await warning.getByRole('button', { name: 'Review', exact: true }).click();
  const section = gold.getByTestId('gold-confirm');
  await expect(section.getByRole('heading', { name: 'Confirm product contents' })).toBeFocused();
  await expect(section.getByTestId('gold-review-products')).toHaveAttribute('aria-expanded', 'true');
});

test('the compact card says what waits and opens only on Review; the figures come right after it', async ({ page }) => {
  const gold = await openGold(page);
  const section = gold.getByTestId('gold-confirm');
  await expect(section.getByTestId('gold-confirm-summary'))
    .toHaveText(/^\d+ products? waits?, affecting \d+ records?: confirm contents to calculate more of your totals\.$/);
  await expect(section.getByTestId('gold-confirm-row')).toHaveCount(0);
  // The summary follows the card directly.
  const order = await gold.evaluate((element) => [...element.querySelectorAll('[data-testid="gold-confirm"], [data-testid="gold-summary"]')]
    .map((node) => node.getAttribute('data-testid')));
  expect(order).toEqual(['gold-confirm', 'gold-summary']);
  await reviewProducts(gold);
  await expect(section.getByTestId('gold-confirm-row').first()).toBeVisible();
});

test('on a Holdr that fetches closes, values are at the stored close, labelled as spot, with the price guard\'s note', async ({ page }) => {
  // Served in the browser: the stack doesn't fetch closes, so its stored closes value nothing (ROOT O110).
  await pricesOn(page);
  const gold = await openGold(page);
  const holding = gold.getByTestId('gold-holding');
  await expect(holding.getByTestId('gold-price-note'))
    .toHaveText(/^Estimated value at spot · gold, CNBC daily close of [A-Z][a-z]{2} \d{1,2}, \d{4} · not a price you could sell at today$/);
  await expect(holding.getByTestId('gold-value')).toContainText('$');
  await expect(holding.getByTestId('gold-value')).not.toHaveText(/—|Prices off/);
  // Gold moved more than 20%: the guard held its first closes back, then admitted the level.
  await expect(holding.getByTestId('gold-level-shift'))
    .toHaveText(/^Price moved more than 20% on [A-Z][a-z]{2} \d{1,2}, \d{4}; admitted after \d+ days, on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
  // The closes read agrees with the holding's close: the price line ends at it, and its closes are being updated.
  const price = gold.getByTestId('gold-price-chart');
  await expect(price.locator('polyline.gold-plot-spot').first()).toBeVisible();
  await expect(price.getByTestId('gold-closes-off')).toHaveCount(0);
  // The sale's assigned purchase: from spot and from premiums, at the dealer's implied spot.
  await choosePeriod(gold, 'All');
  await openDetails(gold);
  const sale = await expand(row(gold, 'gold-sale', longDate(PRICES_ON_SALE.agreedDate)));
  await expect(sale.getByTestId('gold-cycle')).toContainText('dealer\'s implied spot (sale)');
  await expect(sale.getByTestId('gold-cycle')).not.toContainText('Prices off');
  // Silver is valued at a close more than 5 weekdays old, and there is no level shift.
  const silver = await openGold(page, 'Silver');
  await expect(silver.getByTestId('gold-price-note'))
    .toHaveText(/^Estimated value at spot · silver, CNBC daily close of .+ · not a price you could sell at today · that close is more than 5 weekdays old$/);
  await expect(silver.getByTestId('gold-level-shift')).toHaveCount(0);
});

test('every completeness state is said in words: complete, partial with its reasons, unknown with why', async ({ page }) => {
  const gold = await openGold(page);
  await choosePeriod(gold, 'All');
  await openDetails(gold);
  const toCheck = gold.getByTestId('gold-to-check');
  await expect(toCheck.getByRole('heading', { level: 4, name: 'Needs you' })).toBeVisible();
  // For information: more than three notes fold away under their count.
  await toCheck.getByRole('button', { name: /^\d+ notes$/ }).click();
  await expect(toCheck).toContainText('1 unit sold has no recorded purchase');
  await expect(toCheck).toContainText('records that disagree, waiting for review, not counted');
  await expect(toCheck).toContainText(/records? a source couldn't read (?:is|are) held and not counted/);
  await expect(toCheck).toContainText(/card charges? not linked \(.*card not approved yet/);
  await expect(toCheck).toContainText('1 sale states a premium that can\'t be read or doesn\'t match the price');
  // Complete: a purchase whose every fact is known says its cost plainly, with no state word.
  const whole = await expand(row(gold, 'gold-purchase', longDate(stack.dates.walmartLinked)));
  await expect(whole.locator('.gold-figure')).toHaveAttribute('data-state', 'complete');
  await expect(whole.locator('.gold-figure')).toHaveText('$2,000.00');
  // Sales and purchases of unknown metal: beside the figures, never inside them.
  await expect(gold.getByTestId('gold-metal-unknown'))
    .toHaveText('Sales with unknown metal: 1 (net $286.00). Their metal is unresolved, so they are not included in any metal\'s figures.');
  // A purchase whose cost misses an unassigned order cost, delivered on a day the capture doesn't show.
  const mixed = await expand(row(gold, 'gold-purchase', longDate(stack.dates.costcoMixed)));
  await expect(mixed).toContainText('Partial');
  await expect(mixed).toContainText('part of its order\'s cost not assigned to it');
  await expect(mixed).toContainText('A date this purchase counts is unknown');
  // Where the figures come from: per source account, its dates, a capture that read fewer than it states, held records.
  const sources = gold.getByTestId('gold-sources');
  await sources.getByRole('button', { name: 'Where these figures come from' }).click();
  const collectpure = sources.getByTestId('gold-coverage').filter({ hasText: 'Sell orders' });
  await expect(collectpure.locator('.gold-row-name')).toHaveText('CollectPure');
  await expect(collectpure).toContainText(`Sell orders: ${longDate(stack.dates.coverageFrom)} – ${longDate(stack.dates.collectpureCovered)} · complete`);
  await expect(collectpure).toContainText(/Payouts: .+ · partial: 5 of 6 read/);
  await expect(collectpure).toContainText('1 record held');
  // Silver: deliveries short of what was sold, and a profit or loss with nothing known: "—" with why, never $0.00.
  const silver = await openGold(page, 'Silver');
  await choosePeriod(silver, 'All');
  await expect(silver.getByTestId('gold-sale-profit')).toContainText('—');
  await expect(silver.getByTestId('gold-sale-profit')).toContainText('Not known for any sale line in this period');
  await expect(silver.getByTestId('gold-sale-profit')).not.toContainText('$0.00');
  await expect(silver.getByTestId('gold-value')).toHaveText('Prices off');
  // The silver bar sale's two units: neither has a recorded purchase today, said in the one completeness line.
  await expect(silver.getByTestId('gold-summary-warning')).toContainText('2 units sold have no recorded purchase');
  // One of them had a purchase, returned after the sale, and records are held: never said as every purchase sold.
  await expect(silver.getByTestId('gold-holding').getByTestId('gold-held-why')).toHaveCount(0);
});

test('holdings are as of today and never move with the period; the period rolls back from today and names what it applies to', async ({ page }) => {
  const gold = await openGold(page);
  const periods = gold.getByRole('group', { name: 'Period' });
  await expect(periods.getByRole('button', { name: '6M', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(gold.getByTestId('gold-period-scope')).toContainText('Over last 6 months (');
  await expect(gold.getByTestId('gold-period-scope')).toContainText('What you hold is as of today.');
  const held = await gold.getByTestId('gold-held-oz').textContent();
  const first = longDate(stack.dates.costcoFirst);
  await openDetails(gold);
  // The purchase of over a year ago is outside 6 months; with All it is in the lists (and always in the totals above).
  await expect(row(gold, 'gold-purchase', first)).toHaveCount(0);
  const totals = await gold.getByTestId('gold-totals').textContent();
  await choosePeriod(gold, 'All');
  await expect(gold.getByTestId('gold-period-scope')).toContainText('Over all recorded history');
  await expect(row(gold, 'gold-purchase', first)).toHaveCount(1);
  await expect(gold.getByTestId('gold-totals')).toHaveText(totals ?? '');
  await expect(gold.getByTestId('gold-held-oz')).toHaveText(held ?? '');
  await expect(gold.getByTestId('gold-holding').getByRole('heading', { level: 3 })).toContainText(`as of ${longDate(stack.today)}`);
});

test('rewards are an estimate apart from the gain or loss: no rate is stored, so each card and membership says what it needs', async ({ page }) => {
  const gold = await openGold(page);
  await choosePeriod(gold, 'All');
  const rewards = gold.getByTestId('gold-rewards');
  await expect(rewards.getByTestId('gold-rewards-figure')).toHaveText('—Unknown');
  await expect(rewards).toContainText('an estimate on this period\'s purchases, kept apart from the gain or loss');
  await expect(rewards).toContainText('needs each card\'s cashback rate');
  await rewards.getByRole('button', { name: 'How rewards are estimated' }).click();
  const cards = rewards.getByTestId('gold-rewards-cards');
  await expect(cards).toContainText(`${GOLD_CARD_NICKNAME} ··${GOLD_CARD_LAST4}`);
  await expect(cards).toContainText('rate needed');
  await expect(cards).toContainText('Costco membership 1');
  await expect(rewards).toContainText('never one rate for a whole network, and never a guess');
  await expect(rewards).toContainText('Not counted for gold until you confirm gold earns it.');
});

test('on this stack (prices off) the price chart draws the stored closes and says they aren\'t being updated', async ({ page }) => {
  // #340's closes read on the stack: the seed's stored admissible closes, with `fetching` false (the stack, as Holdr ships).
  const gold = await openGold(page);
  const chart = gold.getByTestId('gold-price-chart');
  await expect(chart).toHaveAttribute('aria-busy', 'false');
  await expect(chart.getByTestId('gold-closes-off')).toContainText('Prices off: this Holdr doesn\'t fetch CNBC daily closes');
  await expect(chart.locator('polyline.gold-plot-spot').first()).toBeVisible();
  await expect(chart.getByTestId('gold-closes-unavailable')).toHaveCount(0);
  await expect(chart.getByTestId('gold-closes-error')).toHaveCount(0);
});

test('a Holdr without the closes read says daily prices aren\'t available there, never "no usable close"', async ({ page }) => {
  await page.route((url) => url.pathname === '/metals/closes', (route: Route) => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }),
  }));
  const gold = await openGold(page);
  const chart = gold.getByTestId('gold-price-chart');
  await expect(chart).toHaveAttribute('aria-busy', 'false');
  await expect(chart.getByTestId('gold-closes-unavailable')).toHaveText('Daily prices aren\'t available on this Holdr.');
  await expect(chart.getByTestId('gold-closes-error')).toHaveCount(0);
  await expect(chart.locator('polyline.gold-plot-spot')).toHaveCount(0);
});

test('a closes read that fails says so with Retry, apart from a read with none stored', async ({ page }) => {
  let calls = 0;
  await page.route((url) => url.pathname === '/metals/closes', (route: Route) => {
    calls += 1;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic failure' }) });
  });
  const gold = await openGold(page);
  const chart = gold.getByTestId('gold-price-chart');
  await expect(chart.getByTestId('gold-closes-error')).toContainText('Daily prices unavailable: they couldn\'t be read just now.');
  await expect(chart.getByTestId('gold-closes-unavailable')).toHaveCount(0);
  await expect(chart.getByTestId('gold-plot-gap')).toHaveCount(0);
  const before = calls;
  await chart.getByTestId('gold-closes-error').getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => calls).toBeGreaterThan(before);
});

test('closes read: the line over the chart\'s own dates, its endpoints said, a longer gap shaded, nothing pinned to an edge', async ({ page }) => {
  const today = stack.today;
  // Closes from well before any of the ledger's trades, with one gap longer than the line joins.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 1500 * 86_400_000).toISOString().slice(0, 10);
  const gapFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
  const served = closesFixture(from, today, gapFrom);
  await page.route((url) => url.pathname === '/metals/closes', (route: Route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(served),
  }));
  const gold = await openGold(page);
  for (const label of ['6M', 'All'] as const) {
    await choosePeriod(gold, label);
    const chart = gold.getByTestId('gold-price-chart');
    await expect(chart.locator('polyline.gold-plot-spot').first()).toBeVisible();
    await expect(chart.locator('circle.gold-plot-endpoint')).toHaveCount(2);
    await expect(chart.locator('circle.gold-plot-endpoint > title').first()).toHaveText(/^First close shown: [A-Z][a-z]{2} \d{1,2}, \d{4}, \$[\d,]+\.\d\d per troy oz$/);
    await expect(chart.locator('circle.gold-plot-endpoint > title').last()).toHaveText(/^Latest close: /);
    // More than 4 days without a close: the line breaks there, shaded as no usable close.
    await expect(chart.getByTestId('gold-plot-gap').first()).toBeVisible();
    const placement = await chart.evaluate((element) => {
      const runs = [...element.querySelectorAll('polyline.gold-plot-spot')]
        .map((line) => (line.getAttribute('points') ?? '').trim().split(/\s+/).map((pair) => Number(pair.split(',')[0])));
      const xs = runs.flat();
      const left = Math.min(...xs);
      return {
        increasing: runs.every((run) => run.every((x, index) => index === 0 || x > run[index - 1])),
        atLeftmost: xs.filter((x) => Math.abs(x - left) < 0.05).length,
      };
    });
    expect(placement).toEqual({ increasing: true, atLeftmost: 1 });
  }
  // All starts with the earliest close shown (before every trade here), said under the chart.
  await expect(gold.getByTestId('gold-price-chart')).toContainText(`${longDate(served.closes[0].date)} – ${longDate(today)}`);
});

test('confirming what a product contains, from the compact card: per ordered unit, previewed, a stale preview refused, undone, and the pack apart', async ({ page, request }) => {
  const gold = await openGold(page);
  await openDetails(gold);
  await gold.getByTestId('gold-to-check').getByRole('button', { name: TO_CONFIRM }).click();
  const section = gold.getByTestId('gold-confirm');
  await expect(section.getByRole('heading', { name: 'Confirm product contents' })).toBeFocused();
  await expect(section.getByTestId('gold-review-products')).toHaveAttribute('aria-expanded', 'true');
  const product = section.getByTestId('gold-confirm-row').filter({ hasText: COSTCO_PRODUCT_TITLE }).filter({ has: page.getByTestId('gold-proposal') });
  await expect(product).toContainText('Title says1 oz · gold · bar');
  await expect(product).toContainText('PackOne piece per unit');
  await expect(product).toContainText(/Applies to \d+ purchases \(\d+ units\) of this product, and to later ones with the same details\./);
  await expect(product.getByTestId('gold-proposal')).toHaveText(/^[\d.]+ troy oz of fine gold per unit\?$/);
  // The pack is confirmed on its own, for the whole pack.
  const pack = section.getByTestId('gold-confirm-row').filter({ hasText: '5-Pack' });
  await expect(pack).toContainText('A pack is confirmed on its own: this applies to this purchase only (1 unit).');
  await expect(pack.getByLabel(/^Troy oz of fine gold per unit \(the whole pack\)$/)).toBeVisible();

  // Preview: what confirming would change, with focus on its Confirm.
  await product.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = product.getByTestId('gold-preview');
  await expect(preview).toContainText(/^Confirming would: \d+ purchases \(\d+ units\) counted with this content · recorded holdings .* → .* troy oz/);
  await expect(preview.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
  // Meanwhile the same product is confirmed elsewhere: this preview is stale, and nothing is saved twice. Said once for the
  // section, with focus, and the lists are read again: the product now waits under "Confirmed by you".
  const decision = await confirmCostcoProduct(request);
  expect(decision).toBeTruthy();
  await preview.getByRole('button', { name: 'Confirm', exact: true }).click();
  const status = section.getByTestId('gold-confirm-status');
  await expect(status).toHaveText('Something changed since this preview, so nothing was saved. Preview again to see what it does now.');
  await expect(status).toBeFocused();
  await expect(section.getByRole('button', { name: /^Confirmed by you \(\d+\)$/ })).toBeVisible();

  // Undo, previewed: the purchases are held again.
  const again = await openGold(page);
  const againSection = await reviewProducts(again);
  await againSection.getByRole('button', { name: /^Confirmed by you \(\d+\)$/ }).click();
  const done = again.getByTestId('gold-confirm-row').filter({ hasText: COSTCO_PRODUCT_TITLE }).filter({ has: page.getByTestId('gold-decision') });
  await expect(done.getByTestId('gold-decision')).toContainText(/^You confirmed [\d.]+ troy oz of fine gold per unit on [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  const heldConfirmed = await again.getByTestId('gold-held-oz').textContent();
  await done.getByRole('button', { name: 'Undo…', exact: true }).click();
  await expect(done.getByTestId('gold-preview')).toContainText(/^Undoing would: \d+ purchases \(\d+ units\) held again until confirmed/);
  await expect(done.getByRole('button', { name: 'Undo confirmation', exact: true })).toBeFocused();
  // Keep it: the preview goes, and focus is back on Undo….
  await done.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(done.getByRole('button', { name: 'Undo…', exact: true })).toBeFocused();
  await done.getByRole('button', { name: 'Undo…', exact: true }).click();
  await done.getByRole('button', { name: 'Undo confirmation', exact: true }).click();
  await expect(again.getByTestId('gold-confirm-status')).toHaveText(`Undone: ${COSTCO_PRODUCT_TITLE} is held again until you confirm what it contains.`);
  await expect(again.getByTestId('gold-held-oz')).not.toHaveText(heldConfirmed ?? '');

  // Confirmed from the page: counted in ounces, and the bar sale now assigned to the oldest purchase.
  const fresh = await openGold(page);
  await reviewProducts(fresh);
  const row2 = fresh.getByTestId('gold-confirm-row').filter({ hasText: COSTCO_PRODUCT_TITLE }).filter({ has: page.getByTestId('gold-proposal') });
  await row2.getByRole('button', { name: 'Preview', exact: true }).click();
  await row2.getByTestId('gold-preview').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(fresh.getByTestId('gold-confirm-status')).toHaveText(new RegExp(`^Confirmed: ${COSTCO_PRODUCT_TITLE} holds [\\d.]+ troy oz of fine gold per unit\\.$`));
  await expect(fresh.getByTestId('gold-confirm-status')).toBeFocused();
  await choosePeriod(fresh, 'All');
  await openDetails(fresh);
  const bar = await expand(row(fresh, 'gold-sale', longDate(stack.dates.barSale)));
  await expect(bar.getByTestId('gold-cycle')).toContainText(`Bought${longDate(stack.dates.costcoFirst)} at Costco membership 1`);
  const purchase = await expand(row(fresh, 'gold-purchase', longDate(stack.dates.costcoSecond)));
  await expect(purchase).toContainText('(you confirmed)');
  await undoCostcoProduct(request);
});

test('a write the ledger refuses (a correction under way, 409) saves nothing and says the product still needs its answer', async ({ page, request }) => {
  // Only the write is refused; its preview runs as it does. Nothing is saved, and the rows are read again.
  await page.route((url) => /^\/metals\/products\/[^/]+\/content$/.test(url.pathname), async (route: Route) => {
    const body = route.request().postDataJSON() as { preview?: string | null } | null;
    if (route.request().method() === 'POST' && body?.preview) {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused', reason: 'correction-unsupported' }) });
    }
    return route.continue();
  });
  const gold = await openGold(page);
  const section = await reviewProducts(gold);
  const product = section.getByTestId('gold-confirm-row').filter({ hasText: COSTCO_PRODUCT_TITLE }).filter({ has: page.getByTestId('gold-proposal') });
  await product.getByRole('button', { name: 'Preview', exact: true }).click();
  await product.getByTestId('gold-preview').getByRole('button', { name: 'Confirm', exact: true }).click();
  const status = section.getByTestId('gold-confirm-status');
  // goldText's REFUSED_WRITE_TEXT, as the owner reads it (the spec imports no app module that reaches its API client).
  await expect(status).toHaveText('Nothing was saved: this product needs your answer: what it contains.');
  await expect(status).toBeFocused();
  expect((await productByTitle(request, COSTCO_PRODUCT_TITLE)).decision).toBeFalsy();
});

test('"Confirm all as proposed": single products only, each previewed, then confirmed one after another', async ({ page, request }) => {
  const gold = await openGold(page);
  const section = await reviewProducts(gold);
  const all = section.locator('.gold-confirm-all');
  await all.getByRole('button', { name: 'Confirm all as proposed (2)', exact: true }).click();
  // The Costco bar and the 10 g bar's sale; never the 5-pack, which is confirmed for its purchase alone.
  const list = all.getByTestId('gold-confirm-all-list');
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list).toContainText(COSTCO_PRODUCT_TITLE);
  await expect(list).toContainText(TEN_GRAM_SALE_TITLE);
  await expect(list).not.toContainText('5-Pack');
  await all.getByRole('button', { name: 'Preview all 2', exact: true }).click();
  // Each says what it covers, a sale as a sale; focus is on what comes next.
  await expect(all.getByTestId('gold-confirm-all-preview')).toHaveText([
    'Would count 1 sale (1 unit) with this content.', /^Would count \d+ purchases \(\d+ units\) with this content\.$/,
  ]);
  const confirmAll = all.getByRole('button', { name: 'Confirm all 2', exact: true });
  await expect(confirmAll).toBeFocused();
  // The first changes recorded holdings; the second is asked again and still saved.
  await confirmAll.click();
  const status = section.getByTestId('gold-confirm-status');
  await expect(status).toHaveText('Confirmed 2 products as proposed.');
  await expect(status).toBeFocused();
  for (const title of [COSTCO_PRODUCT_TITLE, TEN_GRAM_SALE_TITLE]) expect((await productByTitle(request, title)).decision).toBeTruthy();
  await undoProduct(request, COSTCO_PRODUCT_TITLE);
  await undoProduct(request, TEN_GRAM_SALE_TITLE);
});

test('a linked card charge opens in place, in one drawer, and gives focus back; an unlinked one says why', async ({ page }) => {
  const gold = await openGold(page);
  await choosePeriod(gold, 'All');
  await openDetails(gold);
  const linked = await expand(row(gold, 'gold-purchase', longDate(stack.dates.walmartLinked)));
  const charge = linked.getByTestId('gold-card-charge');
  await expect(charge).toHaveAttribute('data-state', 'linked');
  await expect(charge).toContainText(`Paid by ${GOLD_CARD_NICKNAME} ending ${GOLD_CARD_LAST4} · card charge of ${longDate(stack.dates.walmartLinkedRow)}`);
  await expect(charge).toContainText('Evidence: Walmart\'s order total on one card (walmart-order-total@1)');
  const open = charge.getByRole('button', { name: 'Open charge', exact: true });
  await open.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toHaveCount(1);
  await expect(drawer).toContainText('$2,000.00');
  await expect(page).toHaveURL(/#\/investing\/gold$/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();

  // Not linked, each with why: Costco's card isn't approved; the awaiting coin's charge has no row.
  const costco = await expand(row(gold, 'gold-purchase', longDate(stack.dates.costcoSecond)));
  await expect(costco.getByTestId('gold-card-charge')).toContainText('Card charge not linked: card not approved yet');
  const coin = await expand(row(gold, 'gold-purchase', longDate(stack.dates.walmartAwaiting)));
  await expect(coin.getByTestId('gold-card-charge')).toContainText('Card charge not linked: no card charge of that amount and date found');
  // The order a later capture contradicts: its match is only possible, and it proves nothing until reviewed.
  const quarantined = await expand(row(gold, 'gold-purchase', longDate(stack.dates.walmartQuarantined)));
  await expect(quarantined.getByTestId('gold-card-charge')).toContainText('Possible card charge:');
  await expect(quarantined).toContainText('A later capture contradicts this order');
  // The receipt block names each metal: one charge proven, gold.
  await expect(gold.getByTestId('gold-receipts')).toContainText('Receipts show gold (1)');
});

test('"Open in Card transactions" opens that charge in Everyday', async ({ page }) => {
  const gold = await openGold(page);
  await choosePeriod(gold, 'All');
  await openDetails(gold);
  const linked = await expand(row(gold, 'gold-purchase', longDate(stack.dates.walmartLinked)));
  await linked.getByRole('button', { name: 'Open in Card transactions', exact: true }).click();
  await expect(page).toHaveURL(/#\/everyday\/transactions$/);
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('$2,000.00');
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(page).toHaveURL(/#\/investing\/gold$/);
});

test('sales: net and deposit state, then labelled details; assigned purchases oldest first, said as not a physical match', async ({ page }) => {
  const gold = await openGold(page);
  await choosePeriod(gold, 'All');
  await openDetails(gold);
  const bar = row(gold, 'gold-sale', longDate(stack.dates.barSale));
  await expect(bar).toContainText('net · Deposit not linked');
  const details = await expand(bar);
  await expect(details.getByTestId('gold-payout')).toContainText('Deposit not linked: checking account not approved yet');
  await expect(details.getByTestId('gold-cycle')).toContainText(`Bought${longDate(stack.dates.walmartLinked)} at Walmart account`);
  await expect(details.getByTestId('gold-cycle')).toContainText('days from order to sale');
  // Its profit or loss is before rewards, like every realized result (ROOT).
  await expect(details.getByTestId('gold-cycle')).toContainText('Profit/loss before rewards');
  // What part of its profit came from the spot price needs closes: this Holdr doesn't fetch them, so it says so.
  await expect(details.getByTestId('gold-cycle')).toContainText('From spot-price changePrices off');
  await expect(details.getByTestId('gold-cycle')).toContainText('From premiums and feesPrices off');
  await expect(details.getByTestId('gold-premium')).not.toContainText('doesn\'t match the price');
  await expect(details.getByTestId('gold-assignment-note')).toHaveText('Purchases assigned oldest first — not a confirmed physical match.');
  const unmatched = await expand(row(gold, 'gold-sale', longDate(stack.dates.unmatchedSale)));
  await expect(unmatched.getByTestId('gold-unmatched'))
    .toContainText('1 unit has no recorded purchase (likely bought before a source\'s records begin, or from a source not captured): ');
  await expect(unmatched.getByTestId('gold-premium'))
    .toContainText('This premium can\'t be read or doesn\'t match the price, so the sale\'s spot is the agreed day\'s close, a proxy.');
  const unknown = await expand(row(gold, 'gold-sale', longDate(stack.dates.unknownSale)));
  await expect(unknown).toContainText('Content unknown: the title doesn\'t say whether its weight is fine or gross');
  await expect(unknown.getByRole('button', { name: 'Needs your answer: what it contains' })).toBeVisible();
  // Cancelled, returned and refunded: folded, listed apart.
  const setAside = gold.getByTestId('gold-cancelled');
  await setAside.getByRole('button', { name: /^Cancelled, returned and refunded \(\d+\)$/ }).click();
  await expect(setAside.getByTestId('gold-set-aside').filter({ hasText: 'Cancelled' }).first()).toBeVisible();
  await expect(setAside).toContainText('refunded on');
});

test.describe('states a stack can\'t reach, served in the browser', () => {
  // Each read answered for the metal and period asked, as the routes answer it (answeredFor).
  const serve = (page: Page, answer: (path: string) => unknown, status = 200) => page.route(
    (url) => url.pathname.startsWith('/metals/'),
    (route: Route) => {
      const url = new URL(route.request().url());
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(answeredFor(url, answer(url.pathname))) });
    },
  );

  test('not set up: the page says so and names the operator step', async ({ page }) => {
    await serve(page, () => ({ installed: false }));
    await page.goto('/#/investing/gold');
    const empty = page.getByTestId('gold-page').getByRole('status');
    await expect(empty).toContainText('Gold isn\'t set up yet');
    await expect(empty).toContainText('holdr-metals install');
    await expect(empty).toContainText('holdr-metals import');
  });

  test('a read that fails says so and reads again', async ({ page }) => {
    await serve(page, () => ({ error: 'Synthetic failure' }), 500);
    await page.goto('/#/investing/gold');
    const failed = page.getByTestId('gold-page').getByRole('alert');
    await expect(failed).toContainText('The Gold page couldn\'t be read: Synthetic failure');
    await expect(failed.getByRole('button', { name: 'Read again' })).toBeVisible();
  });

  test('prices off: every value and gain at spot reads "Prices off", never a number; the charts say so; ounces and costs show', async ({ page }) => {
    await serve(page, (path) => priceMissingAnswer(path));
    const gold = await openGold(page);
    await expect(gold.getByTestId('gold-price-note')).toHaveText(
      'Prices off: this Holdr doesn\'t fetch CNBC daily closes, so no value or gain at spot shows. Ounces and costs still show.');
    await expect(gold.getByTestId('gold-value')).toHaveText('Prices off');
    await expect(gold.getByTestId('gold-gain')).toHaveText('Prices off');
    await expect(gold.getByTestId('gold-held-oz')).toHaveText('2.000 troy oz · delivered purchases not assigned to a sale');
    // The price chart: the read succeeded with none stored, prices off, said so; never "unavailable".
    const price = gold.getByTestId('gold-price-chart');
    await expect(price.getByTestId('gold-closes-off')).toContainText('Prices off: this Holdr doesn\'t fetch CNBC daily closes');
    await expect(price.getByTestId('gold-closes-unavailable')).toHaveCount(0);
    await expect(price.getByTestId('gold-plot-gap').first()).toBeVisible();
    // What you held: cost alone, the value line said off, never a zero.
    const held = gold.getByTestId('gold-held-chart');
    await expect(held.locator('polyline.gold-plot-value, circle.gold-plot-value')).toHaveCount(0);
    await expect(held.getByRole('listitem').filter({ hasText: 'Value at spot' })).toHaveText('Value at spot: Prices off');
    // Each class and source row in Details: its value and gain say why, never $0.00; its cost as known.
    await openDetails(gold);
    const holdingClass = gold.getByTestId('gold-class').first();
    await expect(holdingClass).toContainText('Estimated value at spotPrices off');
    await expect(holdingClass).toContainText('Gain/loss at spotPrices off');
    await expect(holdingClass).not.toContainText('$0.00');
    await expect(holdingClass).toContainText('Cost$4,000.00');
    await expect(gold.getByTestId('gold-source').first()).toContainText('cost $4,000.00 · value at spot: Prices off');
  });

  test('no price yet: a Holdr that fetches closes but has none says so, never a number', async ({ page }) => {
    await serve(page, (path) => priceMissingAnswer(path, true));
    const gold = await openGold(page);
    await expect(gold.getByTestId('gold-price-note')).toHaveText(
      'No price yet: no usable CNBC daily close for gold is stored yet, so no value or gain at spot shows. Ounces and costs still show.');
    await expect(gold.getByTestId('gold-value')).toHaveText('No price yet');
    await expect(gold.getByTestId('gold-gain')).toHaveText('No price yet');
    await expect(gold.getByTestId('gold-held-chart').getByRole('listitem').filter({ hasText: 'Value at spot' })).toHaveText('Value at spot: No price yet');
    await expect(gold.getByTestId('gold-price-chart').getByTestId('gold-closes-off')).toHaveCount(0);
    await openDetails(gold);
    await expect(gold.getByTestId('gold-source').first()).toContainText('cost $4,000.00 · value at spot: No price yet');
  });

  test('a holding of none, valued $0.00, while units of unresolved metal are kept: said beside its ounces and value (G1d)', async ({ page }) => {
    // Values show at a fresh close; the metal holds nothing recorded, and 3 units bought (no-metal bullion, O116) have an
    // unresolved metal, also noted in To check.
    const base = overviewFixture();
    await serve(page, (path) => (path === '/metals/overview'
      ? {
        ...base,
        holdings: {
          ...base.holdings,
          troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), valueMinor: complete(0), gainMinor: complete(0),
          units: { ...base.holdings.units, delivered: 0, sold: 0, soldFromDelivered: 0, held: 0 }, classes: [], bySource: [],
        },
        metalUnknown: { lots: 3, units: 3, costMinor: 750_000, sales: 0, saleNetMinor: 0 },
        toCheck: { records: 3, needsYou: [], forInformation: [{ code: 'metal-unknown', records: 3 }] },
      }
      : priceMissingAnswer(path, true)));
    const gold = await openGold(page);
    const unresolved = 'Not counted: 3 units bought whose metal is unresolved.';
    await expect(gold.getByTestId('gold-value')).toHaveText('$0.00');
    await expect(gold.getByTestId('gold-holding').getByTestId('gold-held-unresolved')).toHaveText(unresolved);
    await expect(gold.getByTestId('gold-held-chart').getByTestId('gold-held-chart-unresolved'))
      .toHaveText('Not counted in this chart: 3 units bought whose metal is unresolved.');
    await openDetails(gold);
    await expect(gold.getByTestId('gold-holdings').getByTestId('gold-holdings-unresolved')).toHaveText(unresolved);
    await expect(gold.getByTestId('gold-to-check'))
      .toContainText('3 records have an unresolved metal, so they are not included in any metal\'s figures');
    await expect(gold.getByTestId('gold-to-check')).not.toContainText('more than one metal');
  });

  test('everything recorded sold, and units sold with no purchase recorded at all: what you hold says why it is unknown, never 0 (ROOT)', async ({ page }, testInfo) => {
    // One consistent state over All (soldOutAnswer): one bar bought, then a sale of three that took it, whose other 2 units
    // never had a recorded purchase; prices off.
    await serve(page, (path) => soldOutAnswer(path));
    for (const width of [375, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const gold = await openGold(page);
      await choosePeriod(gold, 'All');
      const holding = gold.getByTestId('gold-holding');
      await expect(holding.getByTestId('gold-held-why')).toHaveText('Unknown because all your recorded purchases kept or on the way are '
        + 'sold, but 2 units you sold have no recorded purchase yet. Finding those purchases would confirm whether you hold 0 troy oz.');
      // Never a zero carrying a reason; the completeness line says the same units.
      await expect(holding.getByTestId('gold-held-oz')).toHaveText('troy oz unknown · delivered purchases not assigned to a sale');
      await expect(holding).not.toContainText('0.000 troy oz');
      await expect(gold.getByTestId('gold-summary-warning')).toContainText('2 units sold have no recorded purchase');
      // A crop of what is held, for the review (outside the readability captures' gold-<view>-<state> names).
      await holding.screenshot({ path: testInfo.outputPath(`held-unknown-${width}-holding.png`), animations: 'disabled' });
    }
  });

  test('orders held for a bullion answer are said for information, counted in To check, never as "needs your answer"', async ({ page }) => {
    await serve(page, (path) => (path === '/metals/overview'
      ? {
        ...overviewFixture(),
        toCheck: { records: 2, needsYou: [{ code: 'bullion-answer', orders: 2, flaggedLines: 2 }], forInformation: [] },
        needsAnswer: { orders: 2, flaggedLines: 2, bySource: [{ source: 'walmart', orders: 2, flaggedLines: 2 }], byMerchantClass: [], items: [] },
      }
      : priceMissingAnswer(path, true)));
    const gold = await openGold(page);
    await expect(gold.getByTestId('gold-summary-warning')).toContainText('2 orders wait for a bullion answer: held, not counted until then');
    // No product waits here, so there is no card to confirm on: Review opens Details onto what to check, focused.
    await gold.getByTestId('gold-summary-warning').getByRole('button', { name: 'Review', exact: true }).click();
    await expect(gold.getByTestId('gold-details')).toHaveJSProperty('open', true);
    await expect(gold.getByTestId('gold-to-check')).toBeFocused();
    await openDetails(gold);
    const toCheck = gold.getByTestId('gold-to-check');
    await expect(toCheck.getByRole('heading', { level: 3 })).toHaveText('To check (2 records)');
    await expect(toCheck).toContainText('2 orders wait for a bullion answer: held, not counted until then');
    await expect(toCheck).not.toContainText('needs your answer');
    await expect(toCheck.getByRole('heading', { level: 4, name: 'Needs you' })).toHaveCount(0);
  });

  test('with every figure complete, the profit or loss is still unavailable: the page as shipped has no coverage proof (until PR-E)', async ({ page }) => {
    // The guard beside the opt-in capture run (gold-proven.e2e.ts, the only place a proof is injected, for review
    // captures): here, as shipped, the page reads none, so even complete figures give no profit or loss, and say why.
    const full = overviewFixture();
    await serve(page, (path) => (path === '/metals/overview' ? { ...full, price: { ...full.price, fetching: false } } : priceMissingAnswer(path)));
    const gold = await openGold(page);
    const totals = gold.getByTestId('gold-totals');
    await expect(totals.getByTestId('gold-totals-bought-short')).toHaveText('Recorded so far · history unverified');
    await expect(totals.getByTestId('gold-totals-sold-short')).toHaveText('Recorded so far · history unverified');
    const result = totals.getByTestId('gold-totals-result');
    await expect(result).toHaveAttribute('data-kind', 'unavailable');
    await expect(result.locator('.gold-totals-words')).toHaveText('Profit or loss unavailable');
    await expect(result.getByTestId('gold-totals-result-lead')).toHaveText('Purchase coverage could not be verified.');
    await expect(result).not.toContainText('$');
    await expect(totals).not.toContainText('Profit or loss on recorded sales');
  });

  test('installed, nothing imported yet: said so with the import step, never a complete-looking zero', async ({ page }) => {
    await serve(page, (path) => (path === '/metals/overview' ? overviewFixture({ coverage: [] }) : priceMissingAnswer(path)));
    await page.goto('/#/investing/gold');
    const empty = page.getByTestId('gold-page').getByRole('status');
    await expect(empty).toContainText('Nothing imported yet');
    await expect(empty).toContainText('holdr-metals import');
    await expect(page.getByTestId('gold-summary')).toHaveCount(0);
    await expect(page.getByTestId('gold-price-chart')).toHaveCount(0);
  });

  test('a funding read that fails says so where the receipts would be', async ({ page }) => {
    await page.route((url) => url.pathname.startsWith('/metals/'), (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      return path === '/metals/funding'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic failure' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answeredFor(url, priceMissingAnswer(path))) });
    });
    const gold = await openGold(page);
    await openDetails(gold);
    await expect(gold.getByTestId('gold-receipts-error')).toHaveText('Receipts couldn\'t be read: Synthetic failure');
    await expect(gold.getByTestId('gold-purchase')).toHaveCount(1);
  });

  test('a timeline or a purchases read that fails is said so in its chart, never as still reading or as no trades', async ({ page }) => {
    await page.route((url) => url.pathname.startsWith('/metals/'), (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      return path === '/metals/timeline' || path === '/metals/purchases'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic failure' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answeredFor(url, priceMissingAnswer(path))) });
    });
    const gold = await openGold(page);
    const held = gold.getByTestId('gold-held-chart');
    await expect(held.getByTestId('gold-held-error')).toHaveText('What you held couldn\'t be read: Synthetic failure');
    await expect(held).not.toContainText('Reading the months');
    const price = gold.getByTestId('gold-price-chart');
    await expect(price.getByTestId('gold-trades-error')).toHaveText('Your trades couldn\'t be read: Synthetic failure');
    await expect(price.getByTestId('gold-price-facts')).toHaveCount(0);
  });
});
