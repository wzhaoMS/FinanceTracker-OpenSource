import type Database from 'better-sqlite3';
import type { Request, RequestHandler, Router } from 'express';
import { ITEM_TAXONOMY_V2_VIEW } from '@finance-tracker/shared';
import {
  RETAIL_API_CHANNELS,
  RETAIL_API_FORMATS,
  RETAIL_API_PAGE,
  RETAIL_API_QUERY,
  RETAIL_API_REFUSALS,
  RETAIL_API_VERSIONS,
  type RetailApiAbsent,
  type RetailApiChannel,
  type RetailApiRefusalReason,
} from '@finance-tracker/shared/retail-api';

import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import { RetailRefusal, retailIdPattern, type RetailRefusalCode } from '../services/retail/common.js';
import { retailSchemaForRead } from '../services/retail/schema.js';
import {
  readRetailReceipt,
  readRetailReceipts,
  readRetailSummary,
  retailMembershipExists,
  retailReceiptView,
  retailReceiptsPage,
  retailSummaryView,
  type RetailReceiptsQuery,
} from '../services/retailRead/receipts.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { CARD_DATA_MESSAGE, HttpError, looksLikeCardData, queryParams, scanQuery } from './cardSpending.js';
import { list, text } from './cardTransactions.js';

/**
 * The Costco receipts page's read API (`@finance-tracker/shared/retail-api`: the summary and the list v1, the detail v2):
 * PR 2's retail tables, read on request (services/retailRead/receipts.ts), each line's category by the retail taxonomy's
 * resolver over its stored rows, in the same read. Served only through `mountCardSpendingRoutes` (cardSpending.ts), as
 * one of its `routers`, behind the same required sign-in and value-free error handler, and here for the owner's session
 * only (Amazon's guard and 403 body): never the service token.
 *
 *   GET /retail/costco/summary                                                    counts only
 *   GET /retail/costco/receipts?membership=&channel=&offset=&limit=&q=&category=  receipts, date descending then ref, one page;
 *                                                                                 `q` searches their item lines (each row's
 *                                                                                 `matchingLines`), `category` keeps those with
 *                                                                                 a line of that item category
 *   GET /retail/costco/receipts/:ref                                              one receipt, its lines (an item, fee or fuel
 *                                                                                 line with its category) and tenders
 *
 * The order is the same on every route (PR 5 v3 §3.7): the owner guard (403); card data in the query or in `:ref` (422,
 * paths only); an unknown or repeated query name, or a bad membership, channel or page (400 `query-invalid`), then a
 * `category` that is no node of the shared item tree, v2 (400 `category-unknown`); a `:ref` that is no `rcp-` ref (404
 * `receipt-not-found`); all before the database is touched. Then one read transaction on the API's handle: the schema's
 * state first (tables of another shape or a stored reserved value: a fixed 409 with its closed `reason`, never an empty
 * success; no tables: 200 `{ format, version, state: 'absent' }`, at the format's own version, `RETAIL_API_VERSIONS`),
 * then an unknown receipt or membership (404 `receipt-not-found`, `membership-not-found`), then the answer. Every refusal
 * it owns is a `RETAIL_API_REFUSALS` entry, `{ error, reason }` with a fixed message. Nothing is read at construction,
 * nothing is ever written, and no answer sums across receipts. Errors never echo input.
 */

const RECEIPT_REF = retailIdPattern('rcp-');
const MEMBERSHIP_REF = retailIdPattern('rtl-mbr-');
const PAGE_NUMBER = /^\d{1,7}$/;
const CHANNELS: ReadonlySet<RetailApiChannel> = new Set(RETAIL_API_CHANNELS);

/** A refusal this API owns: its status and `{ error, reason }`, the message one of its fixed ones (the first by default). */
function refusal(reason: RetailApiRefusalReason, message: string = RETAIL_API_REFUSALS[reason].messages[0]): HttpError {
  const owned = RETAIL_API_REFUSALS[reason];
  if (!(owned.messages as readonly string[]).includes(message)) throw new TypeError('a retail refusal names a message it does not own');
  return new HttpError(owned.status, message, { reason });
}

/** A 400 a shared helper raised (`queryParams`, Spending's `list`), with its own fixed message, as `query-invalid`. */
function queryInvalid<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) throw refusal('query-invalid', error.message);
    throw error;
  }
}

/** The refusals PR 2's read check (`retailSchemaForRead`) can give, as the API's closed 409 reasons. */
const CONFLICT_OF: Partial<Record<RetailRefusalCode, RetailApiRefusalReason>> = {
  'retail-conflict': 'schema-conflict',
  'retail-reserved-value': 'retail-reserved-value',
};

/**
 * The list's filters and page (`RETAIL_API_QUERY.receipts`, `RETAIL_API_PAGE`): anything else is a 400 `query-invalid`,
 * then a category other than a node of the shared item tree, v2, a 400 `category-unknown`.
 */
function receiptsQuery(query: Map<string, string>): RetailReceiptsQuery {
  const membership = query.get('membership') ?? null;
  if (membership !== null && !MEMBERSHIP_REF.test(membership)) throw refusal('query-invalid', 'invalid membership');
  const channel = query.get('channel');
  const channels = channel === undefined ? null : queryInvalid(() => list(channel, CHANNELS, 'channel'));
  // Spending's own `q` check: trimmed, empty is no search, bounded, no control character.
  const q = query.get('q');
  const search = q === undefined ? null : queryInvalid(() => text(q, 'q')) ?? null;
  const page = (name: 'offset' | 'limit', fallback: number, min: number, max: number): number => {
    const value = query.get(name);
    if (value === undefined) return fallback;
    if (!PAGE_NUMBER.test(value) || Number(value) < min || Number(value) > max) throw refusal('query-invalid', 'invalid pagination');
    return Number(value);
  };
  const offset = page('offset', 0, 0, RETAIL_API_PAGE.maxOffset);
  const limit = page('limit', RETAIL_API_PAGE.defaultLimit, 1, RETAIL_API_PAGE.maxLimit);
  // One node id exactly as the tree spells it: never trimmed, cased or matched by prefix.
  const category = query.get('category');
  if (category !== undefined && !ITEM_TAXONOMY_V2_VIEW.isNode(category)) throw refusal('category-unknown', 'unknown category');
  return { membership, channels, search, category: category ?? null, offset, limit };
}

/** Card data in the query (any name; only the route's own names are named) or in `:ref`: 422 with paths only, first. */
function scanRequest(req: Request, names: readonly string[]): void {
  scanQuery(req, names);
  const ref: unknown = req.params.ref;
  if (typeof ref === 'string' && looksLikeCardData(ref)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.ref'] });
}

/** The query's names and values once each, after the card-data scan: an unknown or repeated name is a 400 `query-invalid`. */
const checkedQuery = (req: Request, names: readonly string[]): Map<string, string> => queryInvalid(() => queryParams(req, names));

/** Not found after the state gate: the answer is a 404 of this reason, never an empty success. */
class NotFound {
  constructor(readonly reason: Extract<RetailApiRefusalReason, 'receipt-not-found' | 'membership-not-found'>) {}
}

type RetailApiRoute = keyof typeof RETAIL_API_FORMATS;

/** Each route's answer without the retail tables: its format, at that format's own version (`RETAIL_API_VERSIONS`). */
const ABSENT = {
  summary: { format: RETAIL_API_FORMATS.summary, version: RETAIL_API_VERSIONS.summary, state: 'absent' },
  receipts: { format: RETAIL_API_FORMATS.receipts, version: RETAIL_API_VERSIONS.receipts, state: 'absent' },
  receipt: { format: RETAIL_API_FORMATS.receipt, version: RETAIL_API_VERSIONS.receipt, state: 'absent' },
} as const satisfies { readonly [R in RetailApiRoute]: RetailApiAbsent<(typeof RETAIL_API_FORMATS)[R]> };

/** Mounted only by the guarded financial mount. Reads only, on request: nothing here writes or loads a writer. */
export function createRetailRouter(repo: Pick<SqliteStateRepo, 'internalGetDb'>): Router {
  const router = createVerifiedRouter();
  const ownerOnly: RequestHandler = (req, res, next) => {
    if (req.holdrAuth?.kind !== 'session') {
      res.status(403).json({ error: 'owner session required', code: 'principal-not-allowed' });
      return;
    }
    next();
  };

  /**
   * One read transaction on the API's handle: the schema's state, then `read`. Tables of another shape or a stored
   * reserved value refuse with the fixed 409 of their reason; absent tables answer `absent` with no other read; a lookup
   * that finds nothing is its 404.
   */
  function inOneRead<R extends RetailApiRoute, T>(route: R, read: (db: Database.Database) => T | NotFound): T | (typeof ABSENT)[R] {
    const db = repo.internalGetDb();
    let present: { answer: T | NotFound } | null;
    try {
      present = db.transaction(() => (retailSchemaForRead(db) === 'absent' ? null : { answer: read(db) }))();
    } catch (error) {
      const reason = error instanceof RetailRefusal ? CONFLICT_OF[error.code] : undefined;
      if (reason !== undefined) throw refusal(reason);
      throw error;
    }
    if (present === null) return ABSENT[route];
    if (present.answer instanceof NotFound) throw refusal(present.answer.reason);
    return present.answer;
  }

  router.use('/retail', ownerOnly);
  router.get('/retail/costco/summary', (req, res, next) => {
    try {
      scanRequest(req, RETAIL_API_QUERY.summary);
      checkedQuery(req, RETAIL_API_QUERY.summary);
      res.json(inOneRead('summary', (db) => retailSummaryView(readRetailSummary(db))));
    } catch (error) { next(error); }
  });
  router.get('/retail/costco/receipts', (req, res, next) => {
    try {
      scanRequest(req, RETAIL_API_QUERY.receipts);
      const query = receiptsQuery(checkedQuery(req, RETAIL_API_QUERY.receipts));
      res.json(inOneRead('receipts', (db) => {
        // A membership is looked up after the state gate, before any filter or page.
        if (query.membership !== null && !retailMembershipExists(db, query.membership)) return new NotFound('membership-not-found');
        // A search reads the lines, and a category filter the lines with the taxonomy's rows, only when given.
        return retailReceiptsPage(readRetailReceipts(db, { lines: query.search !== null, categories: query.category !== null }), query);
      }));
    } catch (error) { next(error); }
  });
  router.get('/retail/costco/receipts/:ref', (req, res, next) => {
    try {
      scanRequest(req, RETAIL_API_QUERY.receipt);
      checkedQuery(req, RETAIL_API_QUERY.receipt);
      const ref = req.params.ref;
      if (typeof ref !== 'string' || !RECEIPT_REF.test(ref)) throw refusal('receipt-not-found');
      res.json(inOneRead('receipt', (db) => {
        const rows = readRetailReceipt(db, ref);
        return rows === null ? new NotFound('receipt-not-found') : retailReceiptView(rows);
      }));
    } catch (error) { next(error); }
  });
  return router;
}
