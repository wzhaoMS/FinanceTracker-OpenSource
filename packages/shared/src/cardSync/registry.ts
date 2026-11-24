/**
 * Registries of card-sync contract version 1: every enum the wire accepts.
 *
 * The contract version pins the exact field set of `holdr.card-import` v2 and
 * of `projected-bank-batch/v1`, and every registry here. Adding a field, an
 * enum value, a source, an identity namespace, a read contract, a currency or
 * a source/mode pairing is a new contract version with its own review; the
 * validators accept only the versions listed in
 * `CARD_SYNC_SUPPORTED_CONTRACT_VERSIONS`. Adapter-internal changes that do
 * not change what is sent (request headers, page parsing) change only the
 * producer's `parserVersion`.
 */

export const CARD_SYNC_CONTRACT_VERSION = 1;
export const CARD_SYNC_SUPPORTED_CONTRACT_VERSIONS: readonly number[] = Object.freeze([CARD_SYNC_CONTRACT_VERSION]);

export function isSupportedCardSyncContractVersion(value: unknown): value is number {
  return typeof value === 'number' && CARD_SYNC_SUPPORTED_CONTRACT_VERSIONS.includes(value);
}

/** Issuer slugs, as v1 and Holdr's card accounts spell them. */
export const CARD_SYNC_ISSUERS = ['amex', 'chase', 'citi', 'wellsfargo'] as const;
export type CardSyncIssuer = (typeof CARD_SYNC_ISSUERS)[number];

/** How the rows were read: an extension read in the isolated world, passive observation of the page's own responses in MAIN, or the rendered DOM. */
export const CARD_SYNC_MODES = ['isolated-read', 'main-passive', 'dom-passive'] as const;
export type CardSyncMode = (typeof CARD_SYNC_MODES)[number];

/** Billing currencies accepted in this release. USD only: another currency is a deliberate contract change. */
export const CARD_SYNC_CURRENCIES = ['USD'] as const;
export type CardSyncCurrency = (typeof CARD_SYNC_CURRENCIES)[number];

export const CARD_SYNC_DATE_BASES = ['transaction', 'posted', 'observation'] as const;
export type CardSyncDateBasis = (typeof CARD_SYNC_DATE_BASES)[number];

export const CARD_SYNC_COMPLETENESS = ['unknown', 'partial', 'complete'] as const;
export type CardSyncCompleteness = (typeof CARD_SYNC_COMPLETENESS)[number];

/**
 * Why reading a scope (or account) stopped.
 * - `end-marker`: the read contract's proven end-of-data signal was seen; the only reason compatible with `complete`.
 * - `snapshot`: one passive observation (a page response or the rendered list) with no proven end signal.
 * - `more-available`: the source showed more data (next cursor, Load More, unrendered rows) that was not read.
 * - `user-navigation`: the user navigated, switched account, closed the page or stopped before the end.
 * - `cap`: a run budget (pages, rows, bytes or time) was reached.
 * - `repeated-cursor`: a cursor or page repeated.
 * - `empty-page`: an empty page arrived without an end signal.
 * - `rate-limited`: the issuer throttled (429).
 * - `auth-required`: 401/403, a login page or a challenge.
 * - `error`: any other failure, such as a malformed response or an unknown enum.
 * - `not-read`: the scope is known but was not read in this capture.
 */
export const CARD_SYNC_TERMINATIONS = [
  'end-marker', 'snapshot', 'more-available', 'user-navigation', 'cap', 'repeated-cursor', 'empty-page',
  'rate-limited', 'auth-required', 'error', 'not-read',
] as const;
export type CardSyncTermination = (typeof CARD_SYNC_TERMINATIONS)[number];

/** The most each termination lets a coverage entry claim; `end-marker` allows `complete` only with a requested window. */
const COMPLETENESS_CEILINGS: Readonly<Record<CardSyncTermination, CardSyncCompleteness>> = Object.freeze({
  'end-marker': 'complete',
  snapshot: 'unknown',
  'more-available': 'partial',
  'user-navigation': 'partial',
  cap: 'partial',
  'repeated-cursor': 'partial',
  'empty-page': 'partial',
  'rate-limited': 'partial',
  'auth-required': 'partial',
  error: 'partial',
  'not-read': 'unknown',
});

/**
 * The highest completeness a coverage entry may claim for how its read
 * stopped, ordered unknown < partial < complete:
 * - `end-marker` with a requested window: `complete`; without one (a passive
 *   read with no page window): `unknown`;
 * - `snapshot` and `not-read`: `unknown`;
 * - every stop before the end (`more-available`, `user-navigation`, `cap`,
 *   `repeated-cursor`, `empty-page`, `rate-limited`, `auth-required`, `error`): `partial`.
 * Validators refuse a higher claim; producers may claim less.
 */
export function cardSyncCompletenessCeiling(termination: CardSyncTermination, requested: object | null): CardSyncCompleteness {
  if (termination === 'end-marker' && requested === null) return 'unknown';
  return COMPLETENESS_CEILINGS[termination];
}

/** True when `completeness` is at most the ceiling for `termination` and `requested`. */
export function cardSyncCompletenessAllowed(completeness: CardSyncCompleteness, termination: CardSyncTermination, requested: object | null): boolean {
  return CARD_SYNC_COMPLETENESS.indexOf(completeness) <= CARD_SYNC_COMPLETENESS.indexOf(cardSyncCompletenessCeiling(termination, requested));
}

/**
 * Identity namespaces. `…:capture:v1` marks a row without a stable issuer id,
 * keyed by its v1 fingerprint, which identifies it only within its capture.
 * The others name one issuer id field each; their hashes are
 * `cardExternalIdHash` of that field's value. The same id never appears
 * under two namespaces.
 */
export const CARD_SYNC_IDENTITY_NAMESPACES = [
  'chase-api:sor:v1',
  'chase-api:derived:v1',
  'chase-api:capture:v1',
  'amex-api-recent:capture:v1',
  'amex-api-rest:identifier:v1',
  'amex-api-rest:reference:v1',
  'amex-api-rest:capture:v1',
  'citi-api:transaction:v1',
  'citi-api:citi-transaction:v1',
  'citi-api:capture:v1',
  'wf-dom:capture:v1',
] as const;
export type CardSyncIdentityNamespace = (typeof CARD_SYNC_IDENTITY_NAMESPACES)[number];

/** Registered extension sources (never an open slug). */
export const CARD_SYNC_SOURCES = ['chase-api', 'amex-api-recent', 'amex-api-rest', 'citi-api', 'wf-dom'] as const;
export type CardSyncSource = (typeof CARD_SYNC_SOURCES)[number];

export interface CardSyncSourceSpec {
  issuer: CardSyncIssuer;
  /** The one mode this source is approved for in this contract version. */
  mode: CardSyncMode;
  /** Namespaces of stable issuer ids, usable as a row's primary id or as secondary ids. */
  stableNamespaces: readonly CardSyncIdentityNamespace[];
  /** Namespace of rows keyed by fingerprint. */
  captureNamespace: CardSyncIdentityNamespace;
}

export const CARD_SYNC_SOURCE_SPECS: Readonly<Record<CardSyncSource, CardSyncSourceSpec>> = Object.freeze({
  'chase-api': Object.freeze({
    issuer: 'chase',
    mode: 'isolated-read',
    stableNamespaces: Object.freeze(['chase-api:sor:v1', 'chase-api:derived:v1'] as const),
    captureNamespace: 'chase-api:capture:v1',
  }),
  'amex-api-recent': Object.freeze({
    issuer: 'amex',
    mode: 'main-passive',
    // RECENT has no proven stable id yet: rows are capture observations only.
    stableNamespaces: Object.freeze([] as const),
    captureNamespace: 'amex-api-recent:capture:v1',
  }),
  'amex-api-rest': Object.freeze({
    issuer: 'amex',
    mode: 'isolated-read',
    stableNamespaces: Object.freeze(['amex-api-rest:identifier:v1', 'amex-api-rest:reference:v1'] as const),
    captureNamespace: 'amex-api-rest:capture:v1',
  }),
  'citi-api': Object.freeze({
    issuer: 'citi',
    mode: 'main-passive',
    stableNamespaces: Object.freeze(['citi-api:transaction:v1', 'citi-api:citi-transaction:v1'] as const),
    captureNamespace: 'citi-api:capture:v1',
  }),
  'wf-dom': Object.freeze({
    issuer: 'wellsfargo',
    mode: 'dom-passive',
    // Rendered rows carry no issuer id.
    stableNamespaces: Object.freeze([] as const),
    captureNamespace: 'wf-dom:capture:v1',
  }),
});

/** Read contracts a projected batch may come from (plan §5). `accounts` contracts carry account candidates only. */
export const CARD_SYNC_READ_CONTRACT_IDS = [
  'chase.bootstrap',
  'chase.activity',
  'amex.overview-state',
  'amex.recent.observe',
  'amex.rest.transactions',
  'citi.accounts.tiles.observe',
  'citi.accounts.balances.observe',
  'citi.transactions.observe',
  'wf.rendered-accounts',
  'wf.rendered-activity',
] as const;
export type CardSyncReadContractId = (typeof CARD_SYNC_READ_CONTRACT_IDS)[number];

export interface CardSyncReadContractSpec {
  issuer: CardSyncIssuer;
  mode: CardSyncMode;
  produces: 'accounts' | 'transactions';
  /** The source whose namespaces a transactions contract's rows use; null for account discovery. */
  source: CardSyncSource | null;
}

export const CARD_SYNC_READ_CONTRACTS: Readonly<Record<CardSyncReadContractId, CardSyncReadContractSpec>> = Object.freeze({
  'chase.bootstrap': Object.freeze({ issuer: 'chase', mode: 'isolated-read', produces: 'accounts', source: null }),
  'chase.activity': Object.freeze({ issuer: 'chase', mode: 'isolated-read', produces: 'transactions', source: 'chase-api' }),
  'amex.overview-state': Object.freeze({ issuer: 'amex', mode: 'main-passive', produces: 'accounts', source: null }),
  'amex.recent.observe': Object.freeze({ issuer: 'amex', mode: 'main-passive', produces: 'transactions', source: 'amex-api-recent' }),
  'amex.rest.transactions': Object.freeze({ issuer: 'amex', mode: 'isolated-read', produces: 'transactions', source: 'amex-api-rest' }),
  'citi.accounts.tiles.observe': Object.freeze({ issuer: 'citi', mode: 'main-passive', produces: 'accounts', source: null }),
  'citi.accounts.balances.observe': Object.freeze({ issuer: 'citi', mode: 'main-passive', produces: 'accounts', source: null }),
  'citi.transactions.observe': Object.freeze({ issuer: 'citi', mode: 'main-passive', produces: 'transactions', source: 'citi-api' }),
  'wf.rendered-accounts': Object.freeze({ issuer: 'wellsfargo', mode: 'dom-passive', produces: 'accounts', source: null }),
  'wf.rendered-activity': Object.freeze({ issuer: 'wellsfargo', mode: 'dom-passive', produces: 'transactions', source: 'wf-dom' }),
} satisfies Record<CardSyncReadContractId, CardSyncReadContractSpec>);

/**
 * Currencies an original (foreign) amount may be given in, with their ISO
 * 4217 minor-unit exponents. A row in any other currency sends no original
 * amount: an unconfirmed currency or precision is null, never a guess.
 */
export const CARD_SYNC_ORIGINAL_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2, ARS: 2, AUD: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CRC: 2, CZK: 2, DKK: 2,
  DOP: 2, EGP: 2, EUR: 2, GBP: 2, GTQ: 2, HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, ISK: 0, JMD: 2, JOD: 3,
  JPY: 0, KES: 2, KRW: 0, KWD: 3, MAD: 2, MXN: 2, MYR: 2, NOK: 2, NZD: 2, OMR: 3, PEN: 2, PHP: 2, PKR: 2,
  PLN: 2, QAR: 2, RON: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2, TWD: 2, UAH: 2, USD: 2, UYU: 2,
  VND: 0, ZAR: 2,
});

/** ISO 4217 exponent of a registered currency (billing or original), or null. */
export function cardSyncCurrencyExponent(currency: string): number | null {
  return typeof currency === 'string' && Object.prototype.hasOwnProperty.call(CARD_SYNC_ORIGINAL_CURRENCY_EXPONENTS, currency)
    ? CARD_SYNC_ORIGINAL_CURRENCY_EXPONENTS[currency]
    : null;
}

/** True when `value` is one of `list`, without consulting prototypes. */
export function isCardSyncEnum<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
