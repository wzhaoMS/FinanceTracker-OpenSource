import type { Request, RequestHandler, Response, Router } from 'express';

import {
  METALS,
  METALS_BULLION_ANSWERS,
  METALS_PRODUCT_REF_MAX,
  compare,
  formatRational,
  parseRational,
  rational,
  type Metal,
  type MetalsBullionAnswer,
  type Rational,
} from '@finance-tracker/shared/metals-ledger';
import type { MetalsApiConflict } from '@finance-tracker/shared/metals-api';

import { asyncRoute } from '../asyncRoute.js';
import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import { MetalsCardCheckUnavailable, metalsCardCheckState, metalsCardCheckView, metalsRosterPreviewView } from '../services/metalsRead/cardCheck.js';
import { metalsScreenClosesV2 } from '../services/metalsRead/closeScreen.js';
import {
  MetalsContentNotFound,
  MetalsPreviewStale,
  metalsBullionPreview,
  metalsBullionScopeLines,
  metalsContentPreview,
  writeMetalsBullionChange,
  writeMetalsContentChange,
  type MetalsBullionChange,
  type MetalsContentChange,
} from '../services/metalsRead/decisions.js';
import type { MetalsLedgerGraph } from '../services/metalsRead/ledger.js';
import type { MetalsPriceRefresher, MetalsPriceStore } from '../services/metalsRead/prices.js';
import { MetalsCorrectionUnsupported, MetalsSchemaClosed, type MetalsLedgerSnapshot, type MetalsReadModel } from '../services/metalsRead/source.js';
import { MetalsViews, addMonths, lastDayOf, monthsBetween } from '../services/metalsRead/views.js';
import { marketDate } from '../services/symbolHistory.js';
import {
  HttpError,
  isPlainObject,
  jsonBody,
  looksLikeCardData,
  queryParams,
  readBody,
  rejectCardData,
  scanQuery,
  sessionActorRef,
  CARD_DATA_MESSAGE,
} from './cardSpending.js';

/**
 * The metals ledger (design v8 §8–§10, G3): the Gold page's reads and the owner's decisions. Served only
 * through `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the same required sign-in, body
 * parser skip and value-free error handler; the service token may only read.
 *
 *   GET    /metals/overview?metal=&from=&to=&asOf=     holdings as of asOf (today by default), activity over [from, to], and
 *                                                       the coverage proof as of asOf (`coverageProof`, the same for every
 *                                                       metal, from and to)
 *   GET    /metals/purchases?metal=&from=&to=          lots ordered in the period, with lifecycle, content, cost,
 *                                                       merchandise and links
 *   GET    /metals/sales?metal=&from=&to=              sale lines agreed in the period, with cycles and deposits
 *   GET    /metals/timeline?metal=&fromMonth=&toMonth= recorded holdings, cost and value at each month's end
 *   GET    /metals/closes?metal=&from=&to=             admissible closes in the period, oldest first; never fetches
 *   GET    /metals/products?metal=                     what each product (or line) contains, its proposal and decision
 *   GET    /metals/funding?from=&to=                   P1's funding view: buy funding, payouts, deposit evidence
 *   GET    /metals/answers?metal=                      every line the title guard flagged, its state and its answer
 *   GET    /metals/card-check?asOf=                    the card cross-check (a one-sided diagnostic): every card charge at a
 *                                                       gold merchant, by group and status, citing its own gap catalog
 *   GET    /metals/sources/roster/preview              the imported accounts and every binding an owner answer could exempt,
 *                                                       with their digests
 *   POST   /metals/products/:ref/content               { fingerprint, metal, troyOzPerUnit, preview }
 *   DELETE /metals/products/:ref/content?decision=&preview=
 *   POST   /metals/lots/:key/content                   { evidenceDigest, metal, troyOzPerUnit, preview }
 *   DELETE /metals/lots/:key/content?decision=&preview=
 *   POST   /metals/products/:ref/bullion               { fingerprint, answer, preview }
 *   DELETE /metals/products/:ref/bullion?decision=&preview=
 *   POST   /metals/lots/:key/bullion                   { evidenceDigest, answer, preview }
 *   DELETE /metals/lots/:key/bullion?decision=&preview=
 *
 * `:ref` and `:key` go as they are, never percent-encoded (`/metals/products/costco:300001/content`): their characters
 * are path-safe, and the ingress guard (ingress/requestTarget.ts) refuses an escaped `:` as `forbidden-escape`.
 *
 * Without the metals tables (installed only by the Root-GO'd operator command) every read answers
 * `{ installed: false }` and every write a 409 (`not-installed`). Every other state but `present` is never read: tables
 * of another shape, or the quarantine marker (corrections r6 §1: a correction under way), answer a fixed 409
 * (`schema-conflict`) on every read and write, asked on every request, again inside the graph's read snapshot and
 * again inside a write's IMMEDIATE transaction. A ledger holding a correction this build can't read (a voided import,
 * a retired account, a version a void voided, reinstated or renewed: corrections r6, v1) is never read either: every
 * read and write answers a fixed 409 (`correction-unsupported`). The graph asks inside its own read snapshot, so a
 * correction another connection commits after a route's other checks is still refused, and a write asks again inside
 * its IMMEDIATE transaction. Writes are the signed-in owner's only (origin and CSRF checks as every write), each
 * previewed:
 * without `preview` nothing is written and the answer is the preview; with its digest the change is written in one
 * IMMEDIATE transaction unless anything changed since (409 `preview-stale`). Card data anywhere in a request is a 422
 * with paths only (a content write's `troyOzPerUnit` that passes its strict grammar isn't scanned: an exact gram content
 * spans as many digits as a card number); unknown parameters and keys are refused; errors never echo input.
 *
 * Orders held for metals (a line the title guard flagged and not yet answered, or whose answer drifted; G3-int A0,
 * G3-dec) are in no read's figures, lists or products, and a content write naming one of their lines finds nothing
 * (404): see ledger.ts. The owner answers each flagged line with a bullion write, in the line's scope: its product ref
 * and content fingerprint when it has a ref (whatever its pack), else its own lot with the evidence digest it is shown
 * (its order's active version; a different one is 409 `preview-stale`). A new answer replaces the live answer of exactly
 * its scope. Once every flagged line of an order is answered, the order is read through its projection (ledger.ts): a
 * `not-bullion` line is no metal, and a `bullion` line is a line of its flag's metal, whose content writes accept
 * exactly that metal. A bullion preview binds today's date in New York, so a preview made before midnight there is stale
 * after it. Under any marker every bullion write and revocation is refused with the rest (v1).
 *
 * The card cross-check (design v3.2; services/metalsRead/cardCheck.ts): the card check, the overview's coverage proof
 * and the roster preview read one snapshot each and carry its token (`snapshot`), equal when they read the same data
 * version. The roster reads `not-installed` in this build, so every scope with a need stays incomplete with named gaps.
 * The card check is never a completeness certificate. When it can't be computed, the card check and the preview answer
 * a fixed 503 (`unavailable`), never zero rows; the overview's proof then reads `unavailable` in every scope and total,
 * and the rest of the overview answers as before (if even that proof fails, the overview answers the same 503).
 *
 * Prices: while this Holdr fetches prices (HOLDR_METALS_PRICES=1), reads value with the stored daily closes
 * (`holdr:metal:<metal>`), and a signed-in owner's read of the overview, purchases, sales or timeline also refreshes
 * them, as the metals price store allows. While it doesn't, stored closes value nothing: the Gold reads answer as if
 * none were stored (ROOT O110; see `views`). `/metals/closes` never fetches, for any principal, and lists the stored
 * closes either way: the ones the screen admits, and whether this Holdr fetches (`fetching`).
 *
 * The owner's assignment policy (`HOLDR_METALS_FUNGIBLE`, one holdr.conf line; `fungible`, contract
 * `MetalsAssignmentMethod`): each metal it names is assigned oldest first across forms, and a unit a sale took from
 * awaiting reads delivered as of the sale's agreed day; the overview, purchases, sales and timeline then carry
 * `assignment`. Unset, every read is metals-assignment-v1's byte for byte. Every preview applies the same policy, and so
 * does its recomputation inside a write.
 *
 * The owner's estimate switch (`HOLDR_METALS_ESTIMATE_UNMATCHED`, one holdr.conf line; `estimateUnmatched`, contract
 * `MetalsCostEstimateMethod`): each sold unit of a metal it names with no recorded purchase takes a cost estimated from
 * the nearest purchase of its class, a label in a sale's cost basis and profit or loss and the period's (`cost-estimated`,
 * split into recorded and estimated parts) and per class; the overview and sales then carry `costEstimate`. Unset, every
 * read is as before byte for byte. No preview reads a figure it changes (holdings, bought and sold stay as they are), so
 * previews and writes don't take it.
 */

const BODY_LIMIT_BYTES = 4 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const LETTERS_64 = /^[a-p]{64}$/;
const DECISION_ID = /^mtl-dec-[a-p]{32}$/;
/** A product ref as the contract bounds it: `<source>:` and a catalog id of up to METALS_PRODUCT_REF_MAX characters. */
const PRODUCT_REF = new RegExp(`^(?:costco|walmart|collectpure):[A-Za-z0-9_-]{1,${METALS_PRODUCT_REF_MAX}}$`);
const LINE_KEY = /^(?:costco-line|costco-wline|walmart-line|collectpure-sline)-[a-p]{64}$/;
const DECIMAL_OZ = /^\d{1,5}(?:\.\d{1,7})?$/;
const FRACTION_OZ = /^([1-9]\d{0,11})\/([1-9]\d{0,11})$/;
const MAX_TROY_OZ_PER_UNIT = rational(10_000n);
const MAX_TIMELINE_MONTHS = 240;
const EARLIEST_DAY = '1990-01-01';
const LATEST_DAY = '2100-12-31';

const PRODUCT_KEYS = new Set(['fingerprint', 'metal', 'troyOzPerUnit', 'preview']);
const LOT_KEYS = new Set(['evidenceDigest', 'metal', 'troyOzPerUnit', 'preview']);
const PRODUCT_BULLION_KEYS = new Set(['fingerprint', 'answer', 'preview']);
const LOT_BULLION_KEYS = new Set(['evidenceDigest', 'answer', 'preview']);

const CONFLICTS: Record<MetalsApiConflict, string> = {
  'not-installed': 'the metals ledger is not installed on this Holdr',
  'schema-conflict': 'the metals tables on this Holdr have another shape or are quarantined; nothing was read',
  'preview-stale': 'what this would change is no longer what its preview showed; preview it again',
  'correction-unsupported': 'the metals ledger on this Holdr holds a correction (a void or a retirement) this build can\'t read; nothing was read',
  // v0's tripwire only: never answered from v1, where a flagged line holds its order instead (dropped in a later cleanup).
  'flagged-unsupported': 'the metals ledger holds a flagged line this build can\'t read yet; nothing was read',
};

const conflict = (reason: MetalsApiConflict) => new HttpError(409, CONFLICTS[reason], { reason });

/** The card check (or a proof) couldn't be computed: a fixed, value-free answer, never zero rows or a complete check. */
const unavailable = () => new HttpError(503, 'the card check is unavailable on this Holdr now; nothing was read', { reason: 'unavailable' });

function validDate(value: string | undefined, name: string): string {
  const time = value === undefined ? NaN : Date.parse(`${value}T00:00:00Z`);
  if (value === undefined || !DATE.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value
    || value < EARLIEST_DAY || value > LATEST_DAY) {
    throw new HttpError(400, `${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function metalParam(value: string | undefined): Metal {
  if (value === undefined) return 'XAU';
  if (!(METALS as readonly string[]).includes(value)) throw new HttpError(400, 'metal must be XAU, XAG, XPT or XPD');
  return value as Metal;
}

function periodParams(query: Map<string, string>, today: string): { from: string | null; to: string } {
  const from = query.has('from') ? validDate(query.get('from'), 'from') : null;
  const to = query.has('to') ? validDate(query.get('to'), 'to') : today;
  if (from !== null && from > to) throw new HttpError(400, 'from must not be after to');
  return { from, to };
}

/** Fine troy ounces per ordered unit: a decimal with at most 7 decimals, or an exact "n/d"; positive, at most 10000; else null. */
function troyOzOf(value: unknown): Rational | null {
  let parsed: Rational | null = null;
  if (typeof value === 'string' && DECIMAL_OZ.test(value)) parsed = parseRational(value);
  else if (typeof value === 'string') {
    const match = FRACTION_OZ.exec(value);
    if (match) parsed = rational(BigInt(match[1]), BigInt(match[2]));
  }
  if (parsed === null || parsed.num <= 0n || compare(parsed, MAX_TROY_OZ_PER_UNIT) > 0 || !/^\d{1,12}\/\d{1,12}$/.test(formatRational(parsed))) return null;
  return parsed;
}

function troyOzParam(value: unknown): Rational {
  const parsed = troyOzOf(value);
  if (parsed === null) throw new HttpError(400, 'troyOzPerUnit must be positive fine troy ounces per unit, at most 10000: a decimal or an exact n/d');
  return parsed;
}

/**
 * A content write's card scan: every value but a `troyOzPerUnit` that already passes its grammar (`troyOzOf`), which
 * holds only digits and one `/` or `.`, never 13 digits in a row. An exact gram content such as 10 g, 6250000/19439673,
 * spans as many digits as a card number, so the scan would refuse it. Any other `troyOzPerUnit` stays in the scan.
 */
function rejectCardDataInContentBody(input: unknown, keys: ReadonlySet<string>): void {
  if (!isPlainObject(input) || troyOzOf(input.troyOzPerUnit) === null) {
    rejectCardData(input, keys);
    return;
  }
  const rest: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key !== 'troyOzPerUnit') Object.defineProperty(rest, key, { value: child, enumerable: true });
  }
  rejectCardData(rest, keys);
}

function previewParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !LETTERS_64.test(value)) throw new HttpError(400, 'preview must be null or a preview\'s digest');
  return value;
}

function answerParam(value: unknown): MetalsBullionAnswer {
  if (typeof value !== 'string' || !(METALS_BULLION_ANSWERS as readonly string[]).includes(value)) {
    throw new HttpError(400, 'answer must be bullion or not-bullion');
  }
  return value as MetalsBullionAnswer;
}

function pathParam(req: Request, name: string, pattern: RegExp, missing: string): string {
  const raw: unknown = req.params[name];
  const value = typeof raw === 'string' ? raw : '';
  if (looksLikeCardData(value)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: [`params.${name}`] });
  if (!pattern.test(value)) throw new HttpError(404, missing);
  return value;
}

export interface MetalsRouterOptions {
  model: MetalsReadModel;
  prices: { store: MetalsPriceStore; refresher: MetalsPriceRefresher };
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * The owner's assignment policy (`HOLDR_METALS_FUNGIBLE`): the metals assigned oldest first across forms, in every
   * read's views and every preview, recomputed inside its write too. Empty (the default): metals-assignment-v1.
   */
  fungible?: readonly Metal[];
  /**
   * The owner's estimate switch (`HOLDR_METALS_ESTIMATE_UNMATCHED`): the metals whose sold units with no recorded purchase
   * take an estimated cost, in every read's views. Empty (the default): nothing is estimated.
   */
  estimateUnmatched?: readonly Metal[];
}

export function createMetalsRouter(options: MetalsRouterOptions): Router {
  const router = createVerifiedRouter();
  const body = readBody(BODY_LIMIT_BYTES);
  const clock = options.now ?? (() => new Date());
  const today = () => marketDate(clock());
  const fungible = options.fungible ?? [];
  const estimateUnmatched = options.estimateUnmatched ?? [];

  /** A metal's stored closes screened as of `day` (metalsScreenClosesV2), whether or not this Holdr fetches them. */
  const storedScreen = (metal: Metal, day: string) => metalsScreenClosesV2(metal, options.prices.store.bars(metal), day);

  /**
   * One request's views. Stored closes value nothing while this Holdr doesn't fetch them (ROOT O110): the screen is then
   * empty, as in the writes' unpriced views (decisions.ts), so every price-derived field (a price's close and its date,
   * stale, thin history, level shift, each value and gain at spot, `price-missing`, a purchase's spot, a sale's split by
   * spot, the timeline's values) reads as if no close were stored, and the API agrees with the page ("Prices off").
   * `fetching` still says whether this Holdr fetches. While it does, the screen is the stored closes' (`storedScreen`).
   * `/metals/closes` reads the stored closes either way (`closes: 'stored'`): it lists market data with its `fetching`
   * label, never a value of holdings.
   */
  const views = (graph: MetalsLedgerGraph, day: string, closes: 'valuation' | 'stored' = 'valuation') => {
    const fetching = options.prices.refresher.fetching;
    const screened = fetching || closes === 'stored';
    return new MetalsViews({
      graph,
      today: day,
      screen: (metal) => (screened ? storedScreen(metal, day) : { admissible: [], levelShifts: [] }),
      fetching,
      fungible,
      estimateUnmatched,
    });
  };

  /**
   * The schema's state, asked on every request. `present` is the only state read; `absent` has its own answers (a read's
   * `{ installed: false }`, a write's 409 `not-installed`); every other state, the quarantine marker (corrections r6 §1)
   * or a shape this build doesn't expect, now or added later, is the fixed 409 (`schema-conflict`). The graph asks again
   * inside its own read snapshot, and a write inside its IMMEDIATE transaction.
   */
  const state = (): 'present' | 'absent' => {
    const read = options.model.schemaState();
    if (read === 'present' || read === 'absent') return read;
    throw conflict('schema-conflict');
  };

  /**
   * Whether to read: the schema is present. A ledger holding a correction this build can't read is never read either:
   * the graph refuses it in its own read snapshot (the tripwire), and `respond` answers the 409.
   */
  const present = (): boolean => state() === 'present';

  /** Answers a refusal; the graph's or a write's (a closed schema, the tripwire) are the fixed 409s, the card check's the 503. */
  const respond = (caught: unknown, res: Response, next: (error?: unknown) => void) => {
    const error = caught instanceof MetalsSchemaClosed ? conflict('schema-conflict')
      : caught instanceof MetalsCorrectionUnsupported ? conflict('correction-unsupported')
        : caught instanceof MetalsCardCheckUnavailable ? unavailable()
          : caught;
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message, ...error.extra });
      return;
    }
    next(error);
  };

  /**
   * A read: card data in the query first (422), then the query's own checks (400), then the schema. Registered through
   * asyncRoute, so anything its own catch passes on, or a throw outside it, reaches Express's error path.
   */
  const read = (names: readonly string[], answer: (query: Map<string, string>, req: Request, day: string) => Promise<unknown> | unknown): RequestHandler =>
    asyncRoute(async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        scanQuery(req, names);
        const query = queryParams(req, names);
        const day = today();
        const result = await answer(query, req, day);
        res.json(result);
      } catch (caught) {
        respond(caught, res, next);
      }
    });

  /** A signed-in owner's read refreshes the metal's closes back to the earliest day it values (prices on only). */
  const refresh = async (req: Request, graph: MetalsLedgerGraph, metal: Metal, earliest: string | null) => {
    if (req.holdrAuth?.kind !== 'session' || !options.prices.refresher.fetching) return;
    const dates = graph.lines.filter((entry) => entry.line.metal === metal).map((entry) => entry.order.order.date);
    const first = [...dates, ...(earliest ? [earliest] : [])].sort()[0] ?? null;
    if (first !== null) await options.prices.refresher.refresh(metal, first);
  };

  /** The card check of a snapshot: computed once per data version, its failures logged once, value-free. */
  const check = (snapshot: MetalsLedgerSnapshot) => metalsCardCheckState(snapshot, options.log ?? (() => {}));

  /** The as-of day a read names (today by default), never after today. */
  const asOfParam = (query: Map<string, string>, day: string): string => {
    const asOf = query.has('asOf') ? validDate(query.get('asOf'), 'asOf') : day;
    if (asOf > day) throw new HttpError(400, 'asOf must not be after today');
    return asOf;
  };

  router.get('/metals/overview', read(['metal', 'from', 'to', 'asOf'], async (query, req, day) => {
    const metal = metalParam(query.get('metal'));
    const period = periodParams(query, day);
    const asOf = asOfParam(query, day);
    if (!present()) return { installed: false };
    const snapshot = options.model.ledgerSnapshot();
    await refresh(req, snapshot.graph, metal, null);
    const view = views(snapshot.graph, day);
    // The proof first: when even its unavailable form fails, the whole overview is the fixed 503, never one without it.
    const coverageProof = check(snapshot).overviewProof(view, asOf, day);
    return { ...view.overview(metal, period, asOf), coverageProof };
  }));

  router.get('/metals/purchases', read(['metal', 'from', 'to'], async (query, req, day) => {
    const metal = metalParam(query.get('metal'));
    const period = periodParams(query, day);
    if (!present()) return { installed: false };
    const graph = options.model.graph();
    await refresh(req, graph, metal, null);
    return views(graph, day).purchases(metal, period);
  }));

  router.get('/metals/sales', read(['metal', 'from', 'to'], async (query, req, day) => {
    const metal = metalParam(query.get('metal'));
    const period = periodParams(query, day);
    if (!present()) return { installed: false };
    const graph = options.model.graph();
    await refresh(req, graph, metal, null);
    return views(graph, day).sales(metal, period);
  }));

  router.get('/metals/timeline', read(['metal', 'fromMonth', 'toMonth'], async (query, req, day) => {
    const metal = metalParam(query.get('metal'));
    for (const name of ['fromMonth', 'toMonth'] as const) {
      const value = query.get(name);
      if (value !== undefined && (!MONTH.test(value) || `${value}-01` < EARLIEST_DAY || lastDayOf(value) > LATEST_DAY)) {
        throw new HttpError(400, `${name} must be a YYYY-MM month`);
      }
    }
    if (!present()) return { installed: false };
    const graph = options.model.graph();
    const view = views(graph, day);
    const defaults = view.defaultMonths(metal);
    const toMonth = query.get('toMonth') ?? defaults.toMonth;
    // By default a timeline starts at the metal's first order or agreed month, but never more than MAX_TIMELINE_MONTHS
    // months before toMonth, nor after it: a default never refuses itself. A range asked for is checked as asked.
    const earliest = addMonths(toMonth, 1 - MAX_TIMELINE_MONTHS);
    const fromMonth = query.get('fromMonth')
      ?? (defaults.fromMonth < earliest ? earliest : defaults.fromMonth > toMonth ? toMonth : defaults.fromMonth);
    if (fromMonth > toMonth) throw new HttpError(400, 'fromMonth must not be after toMonth');
    if (monthsBetween(fromMonth, toMonth) > MAX_TIMELINE_MONTHS) throw new HttpError(400, `a timeline spans at most ${MAX_TIMELINE_MONTHS} months`);
    await refresh(req, graph, metal, `${fromMonth}-01`);
    return views(graph, day).timeline(metal, fromMonth, toMonth);
  }));

  // The stored closes only, for every principal, whether or not this Holdr values with them (ROOT O110): this read never
  // refreshes them (fetching stays with the reads above).
  router.get('/metals/closes', read(['metal', 'from', 'to'], (query, _req, day) => {
    const metal = metalParam(query.get('metal'));
    const period = periodParams(query, day);
    if (!present()) return { installed: false };
    return views(options.model.graph(), day, 'stored').dailyCloses(metal, period);
  }));

  router.get('/metals/products', read(['metal'], (query, _req, day) => {
    const metal = metalParam(query.get('metal'));
    if (!present()) return { installed: false };
    return views(options.model.graph(), day).products(metal);
  }));

  router.get('/metals/funding', read(['from', 'to'], (query, _req, day) => {
    const period = periodParams(query, day);
    if (!present()) return { installed: false };
    return views(options.model.graph(), day).funding(period);
  }));

  router.get('/metals/answers', read(['metal'], (query, _req, day) => {
    const metal = metalParam(query.get('metal'));
    if (!present()) return { installed: false };
    return views(options.model.graph(), day).answers(metal);
  }));

  // ---- the card cross-check (design v3.2 §8): diagnostics only, every one on one snapshot ----------------------

  router.get('/metals/card-check', read(['asOf'], (query, _req, day) => {
    const asOf = asOfParam(query, day);
    if (!present()) return { installed: false };
    const snapshot = options.model.ledgerSnapshot();
    const state = check(snapshot);
    const view = views(snapshot.graph, day);
    const proved = state.cardCheck(view, asOf, day);
    return state.serve('card check', () => metalsCardCheckView({ ...proved, asOf, views: view }));
  }));

  router.get('/metals/sources/roster/preview', read([], (_query, _req, day) => {
    if (!present()) return { installed: false };
    const snapshot = options.model.ledgerSnapshot();
    const state = check(snapshot);
    const capture = state.capture();
    if (!capture.ok || 'failed' in snapshot.check) throw new MetalsCardCheckUnavailable();
    const importedAccounts = snapshot.check.reads.importedAccounts;
    return state.serve('roster preview', () => metalsRosterPreviewView({ capture: capture.value, importedAccounts, token: state.token(day) }));
  }));

  // ---- the owner's content decisions ------------------------------------

  /** Only a signed-in owner decides; the service principal never reaches these writes. */
  const owner = (req: Request, what = 'confirm what a product contains'): string => {
    const actorRef = sessionActorRef(req);
    if (actorRef === undefined) throw new HttpError(403, `only a signed-in owner can ${what}`);
    return actorRef;
  };

  /** A write needs the installed tables (`state`); asked after validation and sign-in, before any preview. */
  const installed = (): void => {
    if (state() === 'absent') throw conflict('not-installed');
  };

  const write = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof MetalsPreviewStale ? conflict('preview-stale')
        : caught instanceof MetalsContentNotFound ? new HttpError(404, caught.refusal === 'decision-not-found' ? 'decision not found' : 'not found')
          : caught;
      respond(error, res, next);
    }
  };

  /** Previews a change, or writes it when the owner's digest is given. */
  const apply = (req: Request, res: Response, change: MetalsContentChange, metal: Metal, preview: string | null, actorRef: string) => {
    const day = today();
    if (preview === null) {
      const previewed = metalsContentPreview(views(options.model.graph(), day), change, metal);
      if (typeof previewed === 'string') throw new MetalsContentNotFound(previewed);
      res.json(change.action === 'confirm' ? { written: false, preview: previewed } : { revoked: false, preview: previewed });
      return;
    }
    const result = writeMetalsContentChange({
      db: options.model.db, repo: options.model.cardRepo, today: day, at: clock().toISOString(), actorRef, previewDigest: preview, fungible,
    }, change, metal);
    if ('decision' in result) res.status(201).json({ written: true, decision: result.decision });
    else res.json({ revoked: true, decision: result.revoked });
  };

  router.post('/metals/products/:ref/content', ...body, write((req, res) => {
    const input = jsonBody(req);
    rejectCardDataInContentBody(input, PRODUCT_KEYS);
    scanQuery(req, []);
    queryParams(req, []);
    const actorRef = owner(req);
    const ref = pathParam(req, 'ref', PRODUCT_REF, 'product not found');
    if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(input).some((key) => !PRODUCT_KEYS.has(key)) || !['fingerprint', 'metal', 'troyOzPerUnit'].every((key) => key in input)) {
      throw new HttpError(400, 'body must hold fingerprint, metal, troyOzPerUnit and preview');
    }
    if (typeof input.fingerprint !== 'string' || !LETTERS_64.test(input.fingerprint)) throw new HttpError(400, 'fingerprint must be a content fingerprint');
    const metal = metalParam(typeof input.metal === 'string' ? input.metal : '');
    const troyOz = troyOzParam(input.troyOzPerUnit);
    const preview = previewParam(input.preview);
    installed();
    const scope = { kind: 'product' as const, ref, fingerprint: input.fingerprint };
    const lines = views(options.model.graph(), today()).scopeLines(scope);
    if (lines.length === 0) throw new HttpError(404, 'product not found');
    if (lines.some((entry) => entry.line.metal !== metal)) throw new HttpError(400, 'metal is not the metal this product names');
    apply(req, res, { action: 'confirm', scope, metal, troyOzPerUnit: troyOz }, metal, preview, actorRef);
  }));

  router.delete('/metals/products/:ref/content', write((req, res) => {
    scanQuery(req, ['decision', 'preview']);
    const query = queryParams(req, ['decision', 'preview']);
    const actorRef = owner(req);
    const ref = pathParam(req, 'ref', PRODUCT_REF, 'product not found');
    const id = query.get('decision');
    if (id === undefined || !DECISION_ID.test(id)) throw new HttpError(400, 'decision must be a decision id');
    const preview = previewParam(query.get('preview'));
    installed();
    const decision = options.model.graph().decisions.find((entry) => entry.id === id && entry.scope === 'product' && entry.productRef === ref);
    if (!decision || decision.fingerprint === null) throw new HttpError(404, 'decision not found');
    const metal = decision.metal ?? metalOfScope(options.model.graph(), { ref, fingerprint: decision.fingerprint });
    apply(req, res, { action: 'revoke', scope: { kind: 'product', ref, fingerprint: decision.fingerprint }, decisionId: id }, metal, preview, actorRef);
  }));

  router.post('/metals/lots/:key/content', ...body, write((req, res) => {
    const input = jsonBody(req);
    rejectCardDataInContentBody(input, LOT_KEYS);
    scanQuery(req, []);
    queryParams(req, []);
    const actorRef = owner(req);
    const key = pathParam(req, 'key', LINE_KEY, 'line not found');
    if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(input).some((name) => !LOT_KEYS.has(name)) || !['evidenceDigest', 'metal', 'troyOzPerUnit'].every((name) => name in input)) {
      throw new HttpError(400, 'body must hold evidenceDigest, metal, troyOzPerUnit and preview');
    }
    if (typeof input.evidenceDigest !== 'string' || !LETTERS_64.test(input.evidenceDigest)) throw new HttpError(400, 'evidenceDigest must be an evidence digest');
    const metal = metalParam(typeof input.metal === 'string' ? input.metal : '');
    const troyOz = troyOzParam(input.troyOzPerUnit);
    const preview = previewParam(input.preview);
    installed();
    const entry = options.model.graph().lineByKey.get(key);
    if (!entry) throw new HttpError(404, 'line not found');
    if (entry.scope.kind !== 'lot') throw new HttpError(400, 'this line is confirmed with its product (one single-pack product ref)');
    if (entry.line.metal !== metal) throw new HttpError(400, 'metal is not the metal this line names');
    if (entry.order.digest !== input.evidenceDigest) throw conflict('preview-stale');
    apply(req, res, { action: 'confirm', scope: { kind: 'lot', lotKey: key }, metal, troyOzPerUnit: troyOz }, metal, preview, actorRef);
  }));

  router.delete('/metals/lots/:key/content', write((req, res) => {
    scanQuery(req, ['decision', 'preview']);
    const query = queryParams(req, ['decision', 'preview']);
    const actorRef = owner(req);
    const key = pathParam(req, 'key', LINE_KEY, 'line not found');
    const id = query.get('decision');
    if (id === undefined || !DECISION_ID.test(id)) throw new HttpError(400, 'decision must be a decision id');
    const preview = previewParam(query.get('preview'));
    installed();
    const graph = options.model.graph();
    const decision = graph.decisions.find((entry) => entry.id === id && entry.scope === 'lot' && entry.lotKey === key);
    const line = graph.lineByKey.get(key);
    if (!decision || !line) throw new HttpError(404, 'decision not found');
    const metal = decision.metal ?? line.line.metal;
    if (metal === null) throw new HttpError(404, 'decision not found');
    apply(req, res, { action: 'revoke', scope: { kind: 'lot', lotKey: key }, decisionId: id }, metal, preview, actorRef);
  }));

  // ---- the owner's bullion answers (G3-dec) -------------------------------

  const BULLION_WHAT = 'answer whether a line is bullion';

  /** Previews an answer or a revocation, or writes it when the owner's digest of its preview is given. */
  const applyBullion = (res: Response, change: MetalsBullionChange, shownDigest: string | null, actorRef: string) => {
    const day = today();
    if (shownDigest === null) {
      const previewed = metalsBullionPreview(options.model.graph(), day, change, fungible);
      if (typeof previewed === 'string') throw new MetalsContentNotFound(previewed);
      res.json(change.action === 'answer' ? { written: false, preview: previewed } : { revoked: false, preview: previewed });
      return;
    }
    const result = writeMetalsBullionChange({
      db: options.model.db, repo: options.model.cardRepo, today: day, at: clock().toISOString(), actorRef, previewDigest: shownDigest, fungible,
    }, change);
    if ('decision' in result) res.status(201).json({ written: true, decision: result.decision });
    else res.json({ revoked: true, decision: result.revoked });
  };

  router.post('/metals/products/:ref/bullion', ...body, write((req, res) => {
    const input = jsonBody(req);
    rejectCardData(input, PRODUCT_BULLION_KEYS);
    scanQuery(req, []);
    queryParams(req, []);
    const actorRef = owner(req, BULLION_WHAT);
    const ref = pathParam(req, 'ref', PRODUCT_REF, 'product not found');
    if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(input).some((key) => !PRODUCT_BULLION_KEYS.has(key)) || !['fingerprint', 'answer'].every((key) => key in input)) {
      throw new HttpError(400, 'body must hold fingerprint, answer and preview');
    }
    if (typeof input.fingerprint !== 'string' || !LETTERS_64.test(input.fingerprint)) throw new HttpError(400, 'fingerprint must be a content fingerprint');
    const answer = answerParam(input.answer);
    const preview = previewParam(input.preview);
    installed();
    const scope = { kind: 'product' as const, ref, fingerprint: input.fingerprint };
    if (metalsBullionScopeLines(options.model.graph(), scope).length === 0) throw new HttpError(404, 'product not found');
    applyBullion(res, { action: 'answer', scope, answer }, preview, actorRef);
  }));

  router.delete('/metals/products/:ref/bullion', write((req, res) => {
    scanQuery(req, ['decision', 'preview']);
    const query = queryParams(req, ['decision', 'preview']);
    const actorRef = owner(req, BULLION_WHAT);
    const ref = pathParam(req, 'ref', PRODUCT_REF, 'product not found');
    const id = query.get('decision');
    if (id === undefined || !DECISION_ID.test(id)) throw new HttpError(400, 'decision must be a decision id');
    const preview = previewParam(query.get('preview'));
    installed();
    const decision = options.model.graph().bullionDecisions.find((entry) => entry.id === id && entry.scope === 'product' && entry.productRef === ref);
    if (!decision || decision.fingerprint === null) throw new HttpError(404, 'decision not found');
    applyBullion(res, { action: 'revoke', scope: { kind: 'product', ref, fingerprint: decision.fingerprint }, decisionId: id }, preview, actorRef);
  }));

  router.post('/metals/lots/:key/bullion', ...body, write((req, res) => {
    const input = jsonBody(req);
    rejectCardData(input, LOT_BULLION_KEYS);
    scanQuery(req, []);
    queryParams(req, []);
    const actorRef = owner(req, BULLION_WHAT);
    const key = pathParam(req, 'key', LINE_KEY, 'line not found');
    if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(input).some((name) => !LOT_BULLION_KEYS.has(name)) || !['evidenceDigest', 'answer'].every((name) => name in input)) {
      throw new HttpError(400, 'body must hold evidenceDigest, answer and preview');
    }
    if (typeof input.evidenceDigest !== 'string' || !LETTERS_64.test(input.evidenceDigest)) throw new HttpError(400, 'evidenceDigest must be an evidence digest');
    const answer = answerParam(input.answer);
    const preview = previewParam(input.preview);
    installed();
    const flagged = options.model.graph().flaggedByKey.get(key);
    if (!flagged) throw new HttpError(404, 'line not found');
    if (flagged.scope.kind !== 'lot') throw new HttpError(400, 'this line is answered with its product (its product ref and content fingerprint)');
    // Checked here, outside the write's transaction: the evidence the answer is shown with must be the order's active
    // version. A capture after this check can't slip through: the preview's digest binds every reached line's order
    // digest, so the write is stale inside its own IMMEDIATE transaction.
    if (flagged.order.digest !== input.evidenceDigest) throw conflict('preview-stale');
    applyBullion(res, { action: 'answer', scope: { kind: 'lot', lotKey: key }, answer }, preview, actorRef);
  }));

  router.delete('/metals/lots/:key/bullion', write((req, res) => {
    scanQuery(req, ['decision', 'preview']);
    const query = queryParams(req, ['decision', 'preview']);
    const actorRef = owner(req, BULLION_WHAT);
    const key = pathParam(req, 'key', LINE_KEY, 'line not found');
    const id = query.get('decision');
    if (id === undefined || !DECISION_ID.test(id)) throw new HttpError(400, 'decision must be a decision id');
    const preview = previewParam(query.get('preview'));
    installed();
    const decision = options.model.graph().bullionDecisions.find((entry) => entry.id === id && entry.scope === 'lot' && entry.lotKey === key);
    if (!decision) throw new HttpError(404, 'decision not found');
    applyBullion(res, { action: 'revoke', scope: { kind: 'lot', lotKey: key }, decisionId: id }, preview, actorRef);
  }));

  return router;
}

/** The metal a product scope's lines name (they share a fingerprint, so one metal); XAU when none is left. */
function metalOfScope(graph: MetalsLedgerGraph, scope: { ref: string; fingerprint: string }): Metal {
  const line = graph.lines.find((entry) => entry.line.productRef === scope.ref && entry.line.contentFingerprint === scope.fingerprint);
  return line?.line.metal ?? 'XAU';
}
