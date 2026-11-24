import type {
  MetalsCloses, MetalsFunding, MetalsOverview, MetalsProducts, MetalsPurchases, MetalsSale, MetalsSales, MetalsTimeline,
} from '@finance-tracker/shared/metals-api';
import type { Metal } from '@finance-tracker/shared/metals-ledger';

import {
  answeredFor, closesFixture, fundingPurchaseFixture, overviewFixture, purchaseFixture, saleFixture, timelineFixture,
} from '../src/components/gold/goldFixtures';
import { shiftDate } from '../src/components/gold/goldLedgerSeed';
import type { Page, Route } from './fixtures';

/**
 * A Holdr that fetches closes, served in the browser from the typed fixtures (src/components/gold/goldFixtures.ts). This
 * run's disposable stack, like Holdr as it ships, doesn't fetch closes, and since ROOT O110 the closes it stores then
 * value nothing, so it can't reach these states itself. Gold is valued at a close the price guard admitted after a level
 * shift, with a sale at the dealer's implied spot (`PRICES_ON_SALE`); silver at a stale close. The closes read agrees
 * with the overview's own close (`pricesOnCloses`).
 */

/** The served gold sale: its stated premium per troy ounce, which its unit price reconciles, gives the dealer's implied spot. */
export const PRICES_ON_SALE: MetalsSale = saleFixture({
  premium: { text: 'spot +0.4016% / +$10.00 per troy ounce', basis: 'troy_ounce' },
  saleSpot: { basis: 'dealer-implied' },
});

/**
 * A `/metals/` read of `metal` as a Holdr that fetches closes answers it, `price.fetching` on, the closes read included
 * (`pricesOnCloses`); another path is not installed.
 */
export function pricesOnAnswer(pathname: string, metal: Metal): unknown {
  const { asOf: to, price } = overviewFixture();
  const gold = metal === 'XAU';
  if (pathname === '/metals/overview') {
    return gold ? overviewFixture({ price: { ...price, levelShift: { movedOn: '2026-10-21', admittedOn: '2026-10-26', days: 5 } } })
      : overviewFixture({ metal, price: { ...price, closeDate: '2026-10-23', close: '30.5', stale: true } });
  }
  if (pathname === '/metals/purchases') return { installed: true, metal, from: null, to, purchases: gold ? [purchaseFixture()] : [] } satisfies MetalsPurchases;
  if (pathname === '/metals/sales') return { installed: true, metal, from: null, to, sales: gold ? [PRICES_ON_SALE] : [] } satisfies MetalsSales;
  if (pathname === '/metals/timeline') return { ...timelineFixture(), metal } satisfies MetalsTimeline;
  if (pathname === '/metals/products') return { installed: true, metal, products: [] } satisfies MetalsProducts;
  if (pathname === '/metals/closes') return pricesOnCloses(metal);
  if (pathname === '/metals/funding') {
    return { installed: true, from: null, to, purchases: [fundingPurchaseFixture()], sales: [], deposits: [] } satisfies MetalsFunding;
  }
  return { installed: false };
}

/**
 * The closes read of a Holdr that fetches closes (`GET /metals/closes`), agreeing with the served overview's own close, so
 * the chart and the holding name one price: each weekday over the 1,500 days to that close's day, ending at that close;
 * a fifth lower before a level shift the price guard noted, and none on the days it refused the new level (a refused bar
 * is never listed); and one stretch of 8 days with no close stored, 60 days back (longer than the line joins). Synthetic.
 */
export function pricesOnCloses(metal: Metal): MetalsCloses {
  const { price } = pricesOnAnswer('/metals/overview', metal) as MetalsOverview;
  const closeDate = price.closeDate!;
  const latest = Number(price.close);
  const shift = price.levelShift;
  const refused = (date: string) => shift !== null && date >= shift.movedOn && (shift.admittedOn === null || date < shift.admittedOn);
  const days = closesFixture(shiftDate(closeDate, -1500), closeDate, shiftDate(closeDate, -60)).closes
    .map(({ date }) => date).filter((date) => date < closeDate && !refused(date));
  return {
    installed: true,
    metal,
    fetching: true,
    closes: [
      ...days.map((date, index) => {
        const level = shift !== null && date < shift.movedOn ? latest / 1.25 : latest;
        return { date, close: (level * (1 - 0.002 * ((days.length - index) % 25))).toFixed(1) };
      }),
      { date: closeDate, close: price.close! },
    ],
  };
}

/**
 * Serves every `/metals/` read (GET) of `page` as `pricesOnAnswer` gives it, for the metal and period asked
 * (`answeredFor`), until its routes are removed; a write goes on.
 */
export async function pricesOn(page: Page): Promise<void> {
  await page.route((url) => url.pathname.startsWith('/metals/'), async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const metal = (url.searchParams.get('metal') ?? 'XAU') as Metal;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answeredFor(url, pricesOnAnswer(url.pathname, metal))) });
  });
}
