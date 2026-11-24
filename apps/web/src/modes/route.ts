import type { SpendingArea } from '../components/spending/sync/SpendingAreas';

/**
 * Holdr's two modes and their hash routes:
 *
 *   #/investing/<tab>    portfolio · gold · transactions · add · import · accounts
 *   #/everyday/<area>    transactions · benefits · amazon · costco · sync · devices (the Spending areas)
 *   #/everyday/amazon/fresh          the Amazon area's Amazon Fresh tab
 *   #/everyday/amazon/orders/<ref>   one Amazon order, by the API's opaque order ref
 *   #/everyday/costco                the Costco receipts page (read-only; a receipt opens in place, with no address of its own)
 *
 * A route is bookmarkable, survives a reload and works with back/forward.
 * Only the name of the mode last chosen with the switch is remembered
 * (localStorage), so a bare "/" opens it; a first visit opens Investing.
 */
export type Mode = 'investing' | 'everyday';

export const MODES: readonly Mode[] = ['investing', 'everyday'];

/** Gold is the precious-metals ledger's own page, after Portfolio (design v8 §11); it is outside Portfolio's totals. */
export const INVESTING_TABS = ['portfolio', 'gold', 'transactions', 'add', 'import', 'accounts'] as const;
export type InvestingTab = (typeof INVESTING_TABS)[number];

/** Everyday's sections are the Spending areas, in their order. */
export const EVERYDAY_AREAS = ['transactions', 'benefits', 'amazon', 'costco', 'sync', 'devices'] as const satisfies readonly SpendingArea[];
export type EverydayArea = (typeof EVERYDAY_AREAS)[number];

/** The Amazon read API's opaque, household-scoped order ref (never Amazon's own order number). */
export const AMAZON_ORDER_REF = /^amz-[a-f0-9]{48}$/;

export type InvestingRoute = { mode: 'investing'; tab: InvestingTab };
/** The Amazon area's tabs beyond its orders: Amazon Fresh. */
export type AmazonView = 'fresh';
/**
 * Only in the Amazon area: `amazonOrder`, the order shown on its own page; else `amazonView`, the tab shown (its orders
 * when absent).
 */
export type EverydayRoute = { mode: 'everyday'; area: EverydayArea; amazonOrder?: string; amazonView?: AmazonView };
export type ModeRoute = InvestingRoute | EverydayRoute;

export const DEFAULT_ROUTES: { investing: InvestingRoute; everyday: EverydayRoute } = {
  investing: { mode: 'investing', tab: 'portfolio' },
  everyday: { mode: 'everyday', area: 'transactions' },
};

export const MODE_LABELS: Record<Mode, string> = { investing: 'Investing', everyday: 'Everyday' };

const SECTION_LABELS: Record<InvestingTab, string> & Record<`everyday:${EverydayArea}`, string> = {
  portfolio: 'Portfolio',
  gold: 'Gold',
  transactions: 'Transactions',
  add: 'Add',
  import: 'Import',
  accounts: 'Accounts',
  'everyday:transactions': 'Card transactions',
  'everyday:benefits': 'Benefits',
  'everyday:amazon': 'Amazon',
  'everyday:costco': 'Costco receipts',
  'everyday:sync': 'Sync & coverage',
  'everyday:devices': 'Extension & devices',
};

/** A preference, so it is kept when the browser's copies of server data are cleared at sign-out. */
export const MODE_STORAGE_KEY = 'finance-tracker:pref:mode';

const isInvestingTab = (value: string): value is InvestingTab => (INVESTING_TABS as readonly string[]).includes(value);
const isEverydayArea = (value: string): value is EverydayArea => (EVERYDAY_AREAS as readonly string[]).includes(value);
export const isMode = (value: unknown): value is Mode => value === 'investing' || value === 'everyday';

export function formatRoute(route: ModeRoute): string {
  if (route.mode === 'investing') return `#/investing/${route.tab}`;
  if (route.area === 'amazon' && route.amazonOrder) return `#/everyday/amazon/orders/${route.amazonOrder}`;
  if (route.area === 'amazon' && route.amazonView === 'fresh') return '#/everyday/amazon/fresh';
  return `#/everyday/${route.area}`;
}

export function sameRoute(a: ModeRoute, b: ModeRoute): boolean {
  return formatRoute(a) === formatRoute(b);
}

/** The section's name, as its tab shows it. */
export function sectionLabel(route: ModeRoute): string {
  return route.mode === 'investing' ? SECTION_LABELS[route.tab] : SECTION_LABELS[`everyday:${route.area}`];
}

/** "Portfolio · Investing · Holdr": one title per route, so history entries can be told apart. */
export function routeTitle(route: ModeRoute): string {
  const amazon = route.mode === 'everyday' && route.area === 'amazon';
  const section = amazon && route.amazonOrder ? 'Amazon order'
    : amazon && route.amazonView === 'fresh' ? 'Amazon Fresh' : sectionLabel(route);
  return `${section} · ${MODE_LABELS[route.mode]} · Holdr`;
}

/**
 * The route a hash names, or null when it names no mode. A known mode with an
 * unknown section opens that mode's first section. The Spending tab moved to
 * Everyday, so its old place in Investing opens it there. Only the Amazon area
 * has pages below it: its Amazon Fresh tab (`/fresh`) and an order's own page
 * (`/orders/<ref>`); a ref that isn't one opens its list.
 */
export function parseRoute(hash: string): ModeRoute | null {
  const match = /^#\/(investing|everyday)(?:\/([^/?#]*)(?:\/(orders)\/([^/?#]*)|\/(fresh))?)?\/?$/i.exec(hash);
  if (!match) return null;
  const mode = match[1].toLowerCase() as Mode;
  const section = (match[2] ?? '').toLowerCase();
  if (match[3] !== undefined || match[5] !== undefined) {
    if (mode !== 'everyday' || section !== 'amazon') return null;
    if (match[5] !== undefined) return { mode, area: 'amazon', amazonView: 'fresh' };
    const ref = (match[4] ?? '').toLowerCase();
    return AMAZON_ORDER_REF.test(ref) ? { mode, area: 'amazon', amazonOrder: ref } : { mode, area: 'amazon' };
  }
  if (mode === 'investing') {
    if (section === 'spending') return DEFAULT_ROUTES.everyday;
    return isInvestingTab(section) ? { mode, tab: section } : DEFAULT_ROUTES.investing;
  }
  return isEverydayArea(section) ? { mode, area: section } : DEFAULT_ROUTES.everyday;
}

/**
 * The route to show for the address's hash: the one it names, else the first
 * section of the mode last chosen (Investing on a first visit). `canonical` says
 * whether the hash already spells that route exactly; when not, the address is
 * rewritten in place (no new history entry).
 */
export function resolveRoute(hash: string, storedMode: Mode | null): { route: ModeRoute; canonical: boolean } {
  const parsed = parseRoute(hash);
  const route = parsed ?? DEFAULT_ROUTES[storedMode ?? 'investing'];
  return { route, canonical: formatRoute(route) === hash };
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

export function readStoredMode(storage: ReadableStorage | null): Mode | null {
  try {
    const value = storage?.getItem(MODE_STORAGE_KEY) ?? null;
    return isMode(value) ? value : null;
  } catch {
    return null;
  }
}

/** Best effort: storage may be full or disabled, and the mode is only a convenience. */
export function storeMode(storage: WritableStorage | null, mode: Mode): void {
  try {
    storage?.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Ignored: the address still carries the mode.
  }
}
