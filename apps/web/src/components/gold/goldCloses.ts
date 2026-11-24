/**
 * `GET /metals/closes` (G3's read-only route, #340): the admissible stored daily closes of a metal, ascending, `close` in
 * dollars per troy ounce; it never fetches. `fetching` says whether this Holdr fetches closes at all (prices on). The
 * shared contract's `MetalsCloses`, named here apart from goldApi.ts so the synthetic fixtures and the e2e specs can use it
 * without the app's API client.
 */
export type { MetalsCloses as GoldCloses } from '@finance-tracker/shared/metals-api';
