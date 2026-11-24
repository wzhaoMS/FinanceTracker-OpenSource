/**
 * First path segments of card spending: card accounts and imports (Phase 3),
 * and the Spending tab's reads (Phase 4); also the other household money the
 * same guarded mount serves: read-only, Amazon, checking accounts (bank rows
 * that are never spending) and the card payment schedule (`cash`); the
 * precious-metals ledger (the Gold page's reads and the owner's content
 * confirmations); and the read-only Costco receipts page (`retail`, the
 * owner's session only). The API serves them only behind
 * sign-in, through `mountCardSpendingRoutes` (apps/api/src/routes/
 * cardSpending.ts), whose CARD_SPENDING_PREFIXES derive from this list.
 */
export const CARD_SPENDING_API_PATH_PREFIXES = [
  'card-accounts',
  'card-imports',
  'card-transactions',
  'spending',
  'amazon',
  'checking',
  'cash',
  'metals',
  'retail',
] as const;

/**
 * First path segment of card sync (E1b/E2): the owner API under
 * `/card-sync/owner` (E2a), and later the extension's device routes (E2c).
 * Owner routes require sign-in; device routes require E0-I D's dist admission.
 */
export const CARD_SYNC_API_PATH_PREFIX = 'card-sync';

/**
 * First path segment of every Holdr API route a browser can reach. The web dev server proxies
 * these roots except that card-sync is narrowed to card-sync/owner (apps/web/apiProxy.ts). The API's
 * route-enumeration test fails when a route is registered under a prefix
 * missing from this list, or when a listed prefix has no route. The API's own direct-only prefixes
 * (apps/api/src/ingress/classify.ts: the release attestation, for local scripts) are deliberately
 * not here, so no proxy forwards them.
 */
export const HOLDR_API_PATH_PREFIXES = [
  'accounts',
  'auth',
  ...CARD_SPENDING_API_PATH_PREFIXES,
  CARD_SYNC_API_PATH_PREFIX,
  'cash-events',
  'export',
  'health',
  'import',
  'manual-prices',
  'portfolio',
  'quotes',
  'symbols',
  'transactions',
] as const;

export type HoldrApiPathPrefix = (typeof HOLDR_API_PATH_PREFIXES)[number];
export type CardSpendingApiPathPrefix = (typeof CARD_SPENDING_API_PATH_PREFIXES)[number];
