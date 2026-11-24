/**
 * When a page's clock says it is (US/Eastern, EDT): a weekday's pre-market, regular session and after hours, and a
 * weekend. The page takes the market session from its own clock, and judges a quote's freshness by it:
 *
 *   - a holding's day change says "pre-market" or "after hours" under it in those sessions;
 *   - a price chart's day change reads "Pre-market" or "After hours" where the regular session's reads "Today";
 *   - a quote from before the latest session (or, once markets close, before their close) reads stale.
 *
 * A test that asserts any of these pins the page's clock to one of these times (page.clock.setFixedTime) and takes
 * every time it serves the page from it, never from the test runner's clock, so it reads the same whenever it runs.
 */
export const AT = {
  'pre-market': '2026-10-23T08:00:00-04:00',
  regular: '2026-10-23T12:00:00-04:00',
  'after-hours': '2026-10-23T17:00:00-04:00',
  closed: '2026-10-24T12:00:00-04:00',
} as const;
