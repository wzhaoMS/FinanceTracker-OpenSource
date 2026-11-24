import express, {
  Router, type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response,
} from 'express';
import { STATUS_CODES } from 'node:http';
import { createHash } from 'node:crypto';
import { sendRefusal } from '../ingress/securityHeaders.js';
import { createVerifiedRouter, isVerifiedExpressLayer, isVerifiedRouter, type ExpressLayer } from '../ingress/expressIdentity.js';

import {
  CARD_SPENDING_API_PATH_PREFIXES,
  containsCardData,
  containsCardSecret,
  containsLongDigitRun,
  findCardImportSensitivePaths,
  summarizeCardImportRows,
  validateCardImportPayload,
  serializeCardImportPayload,
  isCardExternalIdHash,
  type CardAccount,
  type CardImportPayload,
  type CardImportPayloadRow,
  type CardImportReconciliation,
  type CardSpendingApiPathPrefix,
  type CardTransaction,
} from '@finance-tracker/shared';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { commitGuardedCardImport, hasCutoverReceiptSchema, readCutoverCommitReceipt,
  CutoverCommitRefusal } from '../services/guardedCardCommit.js';
import { HoldrDbError, isCardGuardRefusal } from '../services/dbErrors.js';
import { indexesOf, STALE_PENDING_SETTLE_DAYS, type ImportPlan } from '../services/cardImport/plan.js';
import type {
  CardAccountInput, CardAccountPatch, CardImportCommitResult, CardImportDecisionKind, CardImportDecisions, CardImportPreview, SqliteStateRepo,
} from '../services/sqliteStateRepo.js';

/**
 * Credit-card spending: card accounts and imports of redacted exports.
 *
 *   GET    /card-accounts                    → { cardAccounts }
 *   POST   /card-accounts                    → 201 CardAccount
 *   PATCH  /card-accounts/:id                → CardAccount (nickname, status, last5)
 *   POST   /card-imports/preview?cardAccountId=…
 *          body: a `holdr.card-import` payload → counts, date range, totals, reconciliation, the rows held
 *          for review (heldCount, heldRows), the review items the commit would store (reviewCount,
 *          reviewRows) and a previewDigest; writes nothing
 *   POST   /card-imports/commit?cardAccountId=…[&possibleDuplicates=skip|import][&pendingMatches=post|skip|split|import][&dismissedMatches=post|keep][&stalePending=dismiss|keep][&acceptMismatch=true][&previewDigest=ipv1:…]
 *          → 201 with the import batch, or 200 when nothing is new and its
 *          coverage is already recorded (idempotent). pendingMatches is
 *          required when posted rows without a reference match stored
 *          pending rows by fingerprint only, and dismissedMatches when posted
 *          rows carry the reference of pending rows the owner dismissed (409
 *          without them). stalePending=dismiss dismisses, with the import,
 *          the stored pending rows an import without pending rows leaves out
 *          (`stalePendingRows`, unconfirmed: not proof of cancellation);
 *          nothing is dismissed without it.
 *          The repository decides inside its transaction (design §4.10.4): the
 *          questions above are asked again when its rows differ from this
 *          request's preview, and an echoed previewDigest that no longer
 *          matches is a 409 (preview again). A new row near a row the browser
 *          extension synced is held for review (heldCount; counted in the
 *          batch's rejectedCount), not imported until its owner decides in the
 *          card sync review; reviewCount is the review items the import stored.
 *   Both commit routes (this one and /card-imports/cutover-commit) also take the W4 pre-commit proof
 *   (services/cardImport/proof): proofJob, proofAttempt, proofDeadline, proofMode=automatic|supervised|resolve and
 *   proofStatementPolicy. The loopback service principal must send them (400 `proof-required` otherwise). The import
 *   is then decided inside one transaction with every gate: a 409 with a value-free `code` and nothing written, or the
 *   usual answer with the proof's receipt (`proof`). proofMode=resolve fences the job's attempt and answers whether it
 *   committed.
 *
 * Only `mountCardSpendingRoutes` (end of this file) mounts these routes, and
 * only behind an authentication middleware; read its wiring contract.
 *
 * Raw issuer files never come here: the bodies are the offline tool's
 * redacted JSON (or anything else that produces the same payload). Every
 * request is scanned for card data before anything else, and any hit is a
 * 422 that lists paths, never values. These routes parse their own bodies with
 * strict limits, never log bodies, and never echo input in errors. Card data
 * lives only in the card tables, apart from brokerage cash, cash history,
 * holdings and returns.
 */

export const CARD_IMPORT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const CARD_ACCOUNT_BODY_LIMIT_BYTES = 16 * 1024;
/**
 * Every path prefix card spending serves, including Phase 4's transaction list
 * and spending reports. The authentication guard and the app-wide JSON
 * parser skip both derive from this list, and mounting refuses a route
 * outside it. It comes from the shared CARD_SPENDING_API_PATH_PREFIXES, which
 * HOLDR_API_PATH_PREFIXES (what the web proxy forwards) includes.
 */
export const CARD_SPENDING_PREFIXES: readonly `/${CardSpendingApiPathPrefix}`[] = Object.freeze(
  CARD_SPENDING_API_PATH_PREFIXES.map((prefix) => `/${prefix}` as const),
);
const CARD_SPENDING_PATH = new RegExp(`^(?:${CARD_SPENDING_PREFIXES.map((prefix) => prefix.replace(/[-/]/g, '\\$&')).join('|')})(?:/|$)`, 'i');
const MAX_LISTED_ROWS = 100;
const ACCOUNT_CREATE_KEYS = new Set(['issuer', 'owner', 'nickname', 'last4', 'last5', 'currency', 'status']);
const ACCOUNT_PATCH_KEYS = new Set(['nickname', 'status', 'last5']);

/** True for card spending paths (any case, with or without a trailing slash, as Express matches routes). */
export function isCardSpendingPath(path: string): boolean {
  return CARD_SPENDING_PATH.test(path);
}

/**
 * Wraps the app-wide body parser so it leaves card spending paths alone:
 * `app.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })))`.
 */
export function exceptCardSpendingPaths(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => (isCardSpendingPath(req.path) ? next() : middleware(req, res, next));
}

interface CardSpendingRouterOptions {
  /** Operational log; receives counts and error types only. Defaults to console.error. */
  log?: (line: string) => void;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A repository message is shown only if it cannot be quoting card data. */
export function safeMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (!message || message.length > 300 || looksLikeCardData(message)) return fallback;
  return message;
}

export function readBody(limit: number): RequestHandler[] {
  const raw = express.raw({ type: () => true, limit, inflate: false });
  const contentType: RequestHandler = (req, _res, next) => {
    if (!req.is('application/json')) return next(new HttpError(415, 'Content-Type must be application/json'));
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(req.headers['content-type'] ?? '')?.[1]?.toLowerCase();
    if (charset && charset !== 'utf-8' && charset !== 'utf8') return next(new HttpError(415, 'the body must be UTF-8 JSON'));
    next();
  };
  return [contentType, raw];
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The parsed JSON body. Parse errors never include the body text. */
export function jsonBody(req: Request): unknown {
  if (!Buffer.isBuffer(req.body)) {
    // An app-wide parser read this body first: its limit applies and its errors quote the body.
    // Refuse instead of trusting it (see the wiring contract on mountCardSpendingRoutes).
    if ((req as { _body?: boolean })._body === true) {
      throw new HttpError(500, 'card spending routes are mounted behind an app-wide body parser that does not skip their paths');
    }
    throw new HttpError(400, 'the request body is missing');
  }
  if (req.body.length === 0) throw new HttpError(400, 'the request body is empty');
  let text: string;
  try {
    text = UTF8.decode(req.body);
  } catch {
    throw new HttpError(400, 'the request body is not valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON');
  }
}

export const CARD_DATA_MESSAGE = 'card data detected; remove it (re-run the offline redaction tool) and try again';
// Logs name a row only by an id in the repository's generated format, as Phase 2's refusals do.
const GENERATED_BATCH_ID = /^card-import-[a-p]{32}$/;

/**
 * A database failure: SQLite's own error, or the HoldrDbError (operation and
 * result code only) the repository's value-free boundary makes of any other.
 */
function isDatabaseError(error: unknown): error is Error {
  return error instanceof HoldrDbError || (error instanceof Error && error.name === 'SqliteError');
}

/**
 * Repository refusals (HoldrRefusal: field names and counts only) become 400s.
 * Database failures go on to the value-free handler, a 500 with a fixed body:
 * a server fault is never answered as a bad request, and no database text
 * reaches the client.
 */
export function repositoryError(error: unknown, fallback: string): HttpError | unknown {
  if (isDatabaseError(error)) return error;
  return new HttpError(400, safeMessage(error, fallback));
}

export function rejectCardData(value: unknown, knownKeys?: Iterable<string>): void {
  const paths = findCardImportSensitivePaths(value, knownKeys);
  if (paths.length > 0) throw new HttpError(422, CARD_DATA_MESSAGE, { paths });
}

/**
 * The database's card guards refused a write: card data got past every check
 * above (the API's and the repository's use the same detectors, so this
 * means they disagree). Answered like any card data, never with the trigger
 * message, and the repository's transaction has already rolled back. Only a
 * refusal the boundary recognizes as one of this build's card guards counts
 * (isCardGuardRefusal): SQLITE_CONSTRAINT_TRIGGER alone is any trigger, so
 * every other failure stays a database error (500, fixed body).
 */
export function cardGuardRefusal(error: unknown, path: string, log: (line: string) => void): HttpError | null {
  if (!isCardGuardRefusal(error)) return null;
  log('[card-spending] the card guards refused a write that passed every API check; nothing was written');
  return new HttpError(422, CARD_DATA_MESSAGE, { paths: [path] });
}

/**
 * The signed-in owner behind a request, as the card ledger names actors
 * (cardSyncActorRef, never the user id itself); undefined for the loopback
 * service principal and for a request no session authenticated.
 */
export function sessionActorRef(req: Request): string | undefined {
  const auth = req.holdrAuth;
  return auth?.kind === 'session' ? cardSyncActorRef(auth.userId) : undefined;
}

export function looksLikeCardData(text: string): boolean {
  return containsCardData(text) || containsLongDigitRun(text) || containsCardSecret(text);
}

/**
 * The W4 proof's query parameters (`services/cardImport/proof/request.ts`, PROOF_QUERY_NAMES; a test keeps the two equal).
 * They are named here, and the proof is loaded only by `loadProof` inside its handlers, so this file's static imports
 * stay exactly what the Mac CLI loads with it.
 */
const PROOF_QUERY_NAMES = ['proofJob', 'proofAttempt', 'proofDeadline', 'proofMode', 'proofStatementPolicy'];

const QUERY_NAMES = ['cardAccountId', 'possibleDuplicates', 'pendingMatches', 'dismissedMatches', 'stalePending', 'acceptMismatch',
  'previewDigest', ...PROOF_QUERY_NAMES];

type ProofModule = typeof import('../services/cardImport/proof/index.js');
/** The proof, loaded on the first request that asks for it: the API's code only, never the Mac CLI's. */
const loadProof = (): Promise<ProofModule> => import('../services/cardImport/proof/index.js');

/**
 * 422 for card data in any query name or value (paths only); runs before every
 * other check. Only names in `knownNames` are echoed in the paths.
 */
export function scanQuery(req: Request, knownNames: readonly string[] = QUERY_NAMES): void {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(req.query)) {
    const values = Array.isArray(value) ? value : [value];
    const flagged = looksLikeCardData(key)
      || values.some((entry) => typeof entry === 'string' && (looksLikeCardData(entry) || looksLikeCardData(`${key}: ${entry}`)));
    if (flagged) paths.push(knownNames.includes(key) ? `query.${key}` : 'query.<key>');
  }
  if (paths.length > 0) throw new HttpError(422, CARD_DATA_MESSAGE, { paths });
}

/** Query values after `scanQuery`; unknown names are refused without echoing them. */
export function queryParams(req: Request, allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(req.query)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'unexpected query parameter');
    if (typeof value !== 'string') throw new HttpError(400, `${key} must be given once`);
    values.set(key, value);
  }
  return values;
}

/** 422 for card data in the :id path parameter (paths only), before anything else looks at it. */
export function scanIdParam(req: Request): void {
  const raw: unknown = req.params.id;
  if (typeof raw === 'string' && looksLikeCardData(raw)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.id'] });
}

/** The :id parameter: 422 for card data, 404 for anything that cannot be an id. No repository access. */
function idParam(req: Request): string {
  scanIdParam(req);
  const raw: unknown = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(404, 'card account not found');
  return id;
}

export function booleanParam(value: string | undefined, name: string): boolean {
  if (value === undefined || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw new HttpError(400, `${name} must be true or false`);
}

function cardAccountParam(repo: SqliteStateRepo, value: string | undefined): CardAccount {
  if (value === undefined) throw new HttpError(400, 'cardAccountId is required');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpError(400, 'cardAccountId is invalid');
  const account = repo.getCardAccount(value);
  if (!account) throw new HttpError(404, 'card account not found');
  return account;
}

/** Posted twins listed per pending match. */
const MAX_LISTED_TWINS = 3;

interface PreparedImport {
  account: CardAccount;
  payload: CardImportPayload;
  /** The repository's classification: Phase 4's plan, the rows held or reviewed (E2d) and the preview digest. */
  preview: CardImportPreview;
  plan: ImportPlan;
  reconciliation: CardImportReconciliation;
  warnings: Array<{ code: string; message: string }>;
}

/**
 * Reads, scans and validates an import request without touching the
 * repository: 422 for card data anywhere (paths only) comes first, then 400s.
 */
function readImportRequest(req: Request, allowedQuery: readonly string[]): { query: Map<string, string>; payload: CardImportPayload } {
  scanQuery(req);
  const body = jsonBody(req);
  if (isPlainObject(body) && Array.isArray(body.rows) && body.rows.length > 20_000) {
    throw new HttpError(413, 'too many rows; split the export');
  }
  rejectCardData(body);
  const query = queryParams(req, allowedQuery);
  const checked = validateCardImportPayload(body);
  if (!checked.ok) throw new HttpError(400, 'invalid card import', { issues: checked.issues });
  return { query, payload: checked.payload };
}

/** The import must be for this account's issuer and currency (409 otherwise), before anything is classified. */
function assertImportFits(account: CardAccount, payload: CardImportPayload): void {
  if (payload.issuer !== account.issuer) throw new HttpError(409, 'the import is for another issuer than this card account');
  if (payload.currency !== account.currency) throw new HttpError(409, 'the import currency does not match this card account');
}

function prepareImport(repo: SqliteStateRepo, account: CardAccount, payload: CardImportPayload, classified?: CardImportPreview): PreparedImport {
  assertImportFits(account, payload);

  const preview = classified ?? repo.previewCardImport({ cardAccountId: account.id, payload });
  const { plan, reconciliation } = preview;
  const warnings: PreparedImport['warnings'] = [];
  if (account.status === 'closed') warnings.push({ code: 'account-closed', message: 'this card account is closed' });
  if (account.last4 && payload.cards.length > 0 && !payload.cards.includes(account.last4)) {
    warnings.push({ code: 'last4-mismatch', message: 'none of the cards in the import has this account\'s last 4 digits' });
  }
  if (payload.owner && payload.owner !== account.owner) {
    warnings.push({ code: 'owner-mismatch', message: 'the import\'s card member mapping names another owner' });
  }
  if (reconciliation.status === 'mismatch') {
    warnings.push({ code: 'statement-mismatch', message: 'the statement figures in the import do not match its rows' });
  }
  const possible = plan.rows.filter((entry) => entry === 'possible-duplicate').length;
  if (possible > 0) {
    warnings.push({ code: 'possible-duplicates', message: `${possible} new rows match stored rows by date, amount and description` });
  }
  if (plan.conflicts.length > 0) {
    warnings.push({ code: 'reference-conflicts', message: `${plan.conflicts.length} rows reuse a stored reference with another date or amount; they are skipped` });
  }
  if (payload.totals.pending.count > 0) {
    warnings.push({
      code: 'pending-rows',
      message: 'pending rows stay pending, and out of spending, until they post: by themselves when a posted row comes '
        + 'with the same issuer reference, or on your word (pendingMatches=post) when a posted row matches one only by '
        + 'date, amount and description. One that never posts as it is (a cancelled hold, or one that posted under '
        + 'another reference) stays pending until you dismiss it or name its posted row',
    });
  }
  // One promotion per pending row, none held for review (a synced posted row may be that purchase).
  const promoting = preview.promotedRows.length;
  if (promoting > 0) {
    warnings.push({ code: 'pending-posted', message: `${promoting} rows are the posted versions of stored pending rows; those rows become posted` });
  }
  const matching = plan.matches.length;
  if (matching > 0) {
    warnings.push({
      code: 'pending-matches',
      message: `${matching} posted rows have no issuer reference and the same date, amount and description as stored pending rows `
        + '(or ones you dismissed), which does not prove they are those charges. pendingMatches=post turns each pending row '
        + 'into its posted row; pendingMatches=skip leaves the pending row as it is and skips the posted row, which is right '
        + 'when that purchase is already stored as posted; pendingMatches=split posts the ones with no such posted row stored '
        + '(pendingMatchDetails[].postedTwinCount 0) and skips the others; pendingMatches=import adds the posted row as another '
        + 'purchase and leaves the pending row as it is (refused while a posted row like it is stored and no other row of the file is it)',
    });
  }
  const dismissedMatching = plan.rows.filter((entry) => entry === 'dismissed-match').length;
  if (dismissedMatching > 0) {
    warnings.push({
      code: 'dismissed-matches',
      message: `${dismissedMatching} posted rows carry the issuer reference of pending charges you dismissed; commit with `
        + 'dismissedMatches=post if they did post after all, or dismissedMatches=keep to keep them dismissed',
    });
  }
  if (plan.stale.length > 0) {
    warnings.push({
      code: 'stale-pending',
      message: `${plan.stale.length} stored pending rows dated in this import's period, at least ${STALE_PENDING_SETTLE_DAYS} days `
        + 'before it ends, are not in it. That does not prove they were cancelled: a file without pending rows need not be a '
        + 'closed statement (some downloads hold posted rows only, even for the open cycle), and even a complete, closed '
        + 'statement leaves out a charge that posted under another reference, or a hold that settles after it closes. They '
        + 'stay pending and uncounted (stalePending=keep, the default). Commit with stalePending=dismiss only when this file '
        + 'is the complete, closed statement and none of them will post as it is; otherwise dismiss single rows on their own',
    });
  }
  if (preview.heldRows.length > 0) {
    warnings.push({
      code: 'held-for-review',
      message: `${preview.heldRows.length} rows look like card transactions the browser extension synced (same amount, close dates), `
        + 'or would post a pending charge that such a transaction may already be. They are held for review, not imported: decide '
        + 'in the card sync review whether each is that transaction, a new one, or not yours',
    });
  }
  if (preview.reviewRows.length > 0) {
    warnings.push({
      code: 'sync-review',
      message: `${preview.reviewRows.length} rows carry a stored reference with details the stored transaction doesn't have, or a `
        + 'reference you detached from its transaction. The stored transaction is kept as it is; each opens an item in the card '
        + 'sync review',
    });
  }
  return { account, payload, preview, plan, reconciliation, warnings };
}

function dateRange(rows: readonly CardImportPayloadRow[]): { start: string; end: string } | null {
  if (rows.length === 0) return null;
  const dates = rows.map((row) => row.transactionDate).sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

/** A stored row as the import preview shows it to its owner: what tells it apart, no keys. */
function storedRowBrief(row: CardTransaction) {
  return {
    id: row.id,
    transactionDate: row.transactionDate,
    postedDate: row.postedDate ?? null,
    status: row.status,
    dismissed: row.dismissedAt != null,
    amountMinor: row.amountMinor,
    currency: row.currency,
    description: row.description,
    merchant: row.merchant ?? null,
  };
}

function summaryBody(prepared: PreparedImport) {
  const { account, payload, preview, plan, reconciliation, warnings } = prepared;
  // Rows held for review, or under review already, are not imported (E2d): the held ones are neither new nor duplicates.
  const notImported = new Set([...preview.heldRows, ...preview.heldOpenRows]);
  const fresh = payload.rows.filter((_row, index) => (plan.rows[index] === 'new' || plan.rows[index] === 'possible-duplicate')
    && !notImported.has(index));
  const possible = indexesOf(plan, 'possible-duplicate');
  const matches = indexesOf(plan, 'pending-match');
  const dismissedMatches = indexesOf(plan, 'dismissed-match');
  return {
    cardAccountId: account.id,
    source: payload.source,
    issuer: payload.issuer,
    parserVersion: payload.parserVersion,
    coverage: payload.coverage,
    dateRange: dateRange(payload.rows),
    rowCount: payload.rows.length,
    newCount: fresh.length,
    duplicateCount: payload.rows.length - fresh.length - preview.heldRows.length,
    heldCount: preview.heldRows.length,
    heldRows: preview.heldRows.slice(0, MAX_LISTED_ROWS),
    // Review items the import stores: its held rows, and duplicates of synced transactions with new details.
    reviewCount: preview.heldRows.length + preview.reviewRows.length,
    reviewRows: preview.reviewRows.slice(0, MAX_LISTED_ROWS),
    previewDigest: preview.previewDigest,
    pendingPostedCount: preview.promotedRows.length,
    pendingMatchCount: matches.length,
    pendingMatchRows: matches.slice(0, MAX_LISTED_ROWS),
    // What the owner weighs for each match: the stored pending row, posted rows like it that
    // the file does not account for, and how many like it the file's other rows are.
    pendingMatchDetails: plan.matches.slice(0, MAX_LISTED_ROWS).map((match) => ({
      row: match.index,
      pending: storedRowBrief(match.stored),
      postedTwinCount: match.twins.length,
      postedTwins: match.twins.slice(0, MAX_LISTED_TWINS).map(storedRowBrief),
      postedTwinsInFileCount: match.twinsInFile,
    })),
    pendingMatchesWithPostedTwinCount: plan.matches.filter((match) => match.twins.length > 0).length,
    dismissedMatchCount: dismissedMatches.length,
    dismissedMatchRows: dismissedMatches.slice(0, MAX_LISTED_ROWS),
    stalePendingCount: plan.stale.length,
    stalePendingRows: plan.stale.slice(0, MAX_LISTED_ROWS).map(storedRowBrief),
    possibleDuplicateCount: possible.length,
    possibleDuplicateRows: possible.slice(0, MAX_LISTED_ROWS),
    conflictCount: plan.conflicts.length,
    conflictRows: plan.conflicts.slice(0, MAX_LISTED_ROWS),
    rejectedCount: payload.rejectedCount,
    totals: payload.totals,
    newTotals: summarizeCardImportRows(fresh),
    reconciliation,
    warnings,
  };
}

/** An echoed `previewDigest` (services/cardImport/review.ts): `ipv1:` and 64 letters. */
const PREVIEW_DIGEST = /^ipv1:[a-p]{64}$/;

/** The 409 for a decision the import still needs (Phase 4's bodies, with the rows the commit's transaction found). */
function decisionRequired(kind: CardImportDecisionKind, summary: ReturnType<typeof summaryBody>): HttpError {
  switch (kind) {
    case 'preview-stale':
      return new HttpError(409, 'the card ledger changed since this preview; preview the import again', { previewDigest: summary.previewDigest });
    case 'statement-mismatch':
      return new HttpError(409, 'the statement figures do not match the rows; fix the export or commit with acceptMismatch=true', {
        reconciliation: summary.reconciliation,
      });
    case 'possible-duplicates':
      return new HttpError(409, 'some new rows look like rows already stored; commit with possibleDuplicates=skip or possibleDuplicates=import', {
        possibleDuplicateCount: summary.possibleDuplicateCount,
        possibleDuplicateRows: summary.possibleDuplicateRows,
      });
    case 'pending-matches':
      return new HttpError(409, 'some posted rows match stored pending (or dismissed) rows by date, amount and description only; commit with pendingMatches=post, pendingMatches=skip, pendingMatches=split or pendingMatches=import', {
        pendingMatchCount: summary.pendingMatchCount,
        pendingMatchRows: summary.pendingMatchRows,
      });
    case 'pending-match-twins':
      // A posted row like it is stored and no other row of the file is it: the incoming row is most likely that
      // purchase again (its occurrence number shifted), so adding it as another purchase would count it twice.
      return new HttpError(409, 'some posted rows that match pending rows look like posted purchases already stored; commit with pendingMatches=skip, pendingMatches=split or pendingMatches=post', {
        pendingMatchCount: summary.pendingMatchCount,
        pendingMatchRows: summary.pendingMatchRows,
      });
    case 'dismissed-matches':
      return new HttpError(409, 'some posted rows carry the issuer reference of pending charges you dismissed; commit with dismissedMatches=post or dismissedMatches=keep', {
        dismissedMatchCount: summary.dismissedMatchCount,
        dismissedMatchRows: summary.dismissedMatchRows,
      });
    case 'stale-pending':
      return new HttpError(409, 'the stale pending rows changed since this preview; preview the import again', {
        stalePendingCount: summary.stalePendingCount,
        stalePendingRows: summary.stalePendingRows,
      });
  }
}

/** The owner's answers on a commit, validated as Phase 4 does, before the account is looked up. */
interface OwnerDecisions {
  possibleDuplicates?: 'skip' | 'import';
  pendingMatches?: 'post' | 'skip' | 'split' | 'import';
  dismissedMatches?: 'post' | 'keep';
  stalePending?: 'dismiss' | 'keep';
  acceptMismatch: boolean;
  previewDigest?: string;
}

function readOwnerDecisions(query: Map<string, string>, payload: CardImportPayload): OwnerDecisions {
  const decision = query.get('possibleDuplicates');
  if (decision !== undefined && decision !== 'skip' && decision !== 'import') {
    throw new HttpError(400, 'possibleDuplicates must be skip or import');
  }
  const pendingDecision = query.get('pendingMatches');
  if (pendingDecision !== undefined && pendingDecision !== 'post' && pendingDecision !== 'skip'
    && pendingDecision !== 'split' && pendingDecision !== 'import') {
    throw new HttpError(400, 'pendingMatches must be post, skip, split or import');
  }
  const dismissedDecision = query.get('dismissedMatches');
  if (dismissedDecision !== undefined && dismissedDecision !== 'post' && dismissedDecision !== 'keep') {
    throw new HttpError(400, 'dismissedMatches must be post or keep');
  }
  const staleDecision = query.get('stalePending');
  if (staleDecision !== undefined && staleDecision !== 'dismiss' && staleDecision !== 'keep') {
    throw new HttpError(400, 'stalePending must be dismiss or keep');
  }
  if (staleDecision === 'dismiss' && payload.totals.pending.count > 0) {
    throw new HttpError(400, 'stalePending=dismiss needs an import without pending rows, such as a closed statement');
  }
  const acceptMismatch = booleanParam(query.get('acceptMismatch'), 'acceptMismatch');
  const previewDigest = query.get('previewDigest');
  if (previewDigest !== undefined && !PREVIEW_DIGEST.test(previewDigest)) throw new HttpError(400, 'previewDigest is invalid');
  return {
    possibleDuplicates: decision as OwnerDecisions['possibleDuplicates'], pendingMatches: pendingDecision as OwnerDecisions['pendingMatches'],
    dismissedMatches: dismissedDecision as OwnerDecisions['dismissedMatches'], stalePending: staleDecision as OwnerDecisions['stalePending'],
    acceptMismatch, previewDigest,
  };
}

const ownerDecided = (owner: OwnerDecisions): boolean => owner.possibleDuplicates !== undefined || owner.pendingMatches !== undefined
  || owner.dismissedMatches !== undefined || owner.stalePending !== undefined || owner.acceptMismatch;

/** The complete lists a commit's decisions answer, from one classification (never a response's 100-row lists). */
const shownLists = (plan: ImportPlan) => ({
  possibleDuplicateRows: indexesOf(plan, 'possible-duplicate'), pendingMatchRows: indexesOf(plan, 'pending-match'),
  dismissedMatchRows: indexesOf(plan, 'dismissed-match'), stalePendingIds: plan.stale.map((row) => row.id),
});

/** Carries a commit's `decision-required` out of the proof's transaction, which it rolls back. */
class ProofDecisionRequired extends Error {
  constructor(readonly result: Extract<CardImportCommitResult, { status: 'decision-required' }>) {
    super('decision-required');
  }
}

/** E1 (ROOT D6): the loopback service principal commits only with the proof. */
const proofRequired = () => new HttpError(400, 'this principal commits card imports only with the proof parameters', { code: 'proof-required' });
const proofRequestInvalid = (parameter: string) => new HttpError(400, `${parameter} is missing or invalid`, { code: 'proof-request-invalid' });

function createCardSpendingRouter(repo: SqliteStateRepo, options: CardSpendingRouterOptions = {}): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const importBody = readBody(CARD_IMPORT_BODY_LIMIT_BYTES);
  const accountBody = readBody(CARD_ACCOUNT_BODY_LIMIT_BYTES);

  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };
  /**
   * `handle` for a handler that awaits the lazy proof module. Every throw and rejection ends as `handle`'s do: an
   * HttpError is answered, anything else goes to the value-free error handler, and never becomes an unhandled rejection.
   */
  const handleAsync = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const failed = (error: unknown) => {
      if (error instanceof HttpError && !res.headersSent) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    };
    try {
      fn(req, res).catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  const parseProof = (proof: ProofModule, query: Map<string, string>) => {
    try {
      return proof.parseProofRequest(query, Date.now());
    } catch (error) {
      if (error instanceof proof.ProofRequestError) throw proofRequestInvalid(error.parameter);
      throw error;
    }
  };

  /**
   * The answer to anything thrown out of the proof's transaction, which has rolled back whatever it was (better-sqlite3
   * rolls back whenever the transaction's function throws, COMMIT included): nothing was written. Logged value-free.
   */
  const proofFailure = (proof: ProofModule, error: unknown, jobId: string, account: CardAccount, payload: CardImportPayload,
    fallback: string): HttpError => {
    const job = jobId.slice(0, 8);
    if (error instanceof proof.ProofHold) {
      log(`[card-import-proof] held ${error.code} job ${job}`);
      return new HttpError(409, 'the proof held this import; nothing was written', { code: error.code });
    }
    if (error instanceof ProofDecisionRequired) {
      const refused = decisionRequired(error.result.kind, summaryBody(prepareImport(repo, account, payload, error.result.preview)));
      // A changed ledger is asked about as today, so the runner previews again; any other question holds.
      if (error.result.kind === 'preview-stale' || error.result.kind === 'stale-pending') return refused;
      log(`[card-import-proof] held proof-plan-not-clean job ${job}`);
      return new HttpError(409, refused.message, { ...refused.extra, code: 'proof-plan-not-clean' });
    }
    if (error instanceof HttpError) return error;
    const kind = proof.classifyProofError(error);
    if (kind === 'card-guard') return cardGuardRefusal(error, '$.rows', log)!;
    if (kind === 'cutover') return new HttpError(409, safeMessage(error, fallback));
    if (kind === 'refusal') return new HttpError(400, safeMessage(error, fallback));
    log(`[card-import-proof] rolled back job ${job}: ${proof.proofErrorType(error)}`);
    return new HttpError(500, 'the proof transaction rolled back; nothing was written', { code: 'proof-error' });
  };

  router.get('/card-accounts', handle((req, res) => {
    scanQuery(req);
    queryParams(req, []);
    res.json({ cardAccounts: repo.listCardAccounts() });
  }));

  router.post('/card-accounts', ...accountBody, handle((req, res) => {
    scanQuery(req);
    const body = jsonBody(req);
    rejectCardData(body, ACCOUNT_CREATE_KEYS);
    queryParams(req, []);
    if (!isPlainObject(body)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(body).some((key) => !ACCOUNT_CREATE_KEYS.has(key))) throw new HttpError(400, 'body has an unexpected key');
    let created: CardAccount;
    try {
      created = repo.createCardAccount(body as unknown as CardAccountInput);
    } catch (error) {
      throw cardGuardRefusal(error, '$', log) ?? repositoryError(error, 'invalid card account');
    }
    res.status(201).json(created);
  }));

  router.patch('/card-accounts/:id', ...accountBody, handle((req, res) => {
    // Card data anywhere (query, id, body) is a 422 before any 404 or 400.
    scanQuery(req);
    scanIdParam(req);
    const body = jsonBody(req);
    rejectCardData(body, ACCOUNT_PATCH_KEYS);
    const id = idParam(req);
    queryParams(req, []);
    if (!isPlainObject(body)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(body).some((key) => !ACCOUNT_PATCH_KEYS.has(key))) throw new HttpError(400, 'only nickname, status and last5 can change');
    if (Object.keys(body).length === 0) throw new HttpError(400, 'no fields to update');
    let updated: CardAccount | null;
    try {
      updated = repo.updateCardAccount(id, body as CardAccountPatch);
    } catch (error) {
      throw cardGuardRefusal(error, '$', log) ?? repositoryError(error, 'invalid card account change');
    }
    if (!updated) throw new HttpError(404, 'card account not found');
    res.json(updated);
  }));

  router.post('/card-imports/preview', ...importBody, handle((req, res) => {
    const { query, payload } = readImportRequest(req, ['cardAccountId']);
    const account = cardAccountParam(repo, query.get('cardAccountId'));
    res.json(summaryBody(prepareImport(repo, account, payload)));
  }));

  const cutoverDigest = (value: string | undefined): string => {
    if (!/^h1:[a-p]{64}$/.test(value ?? '')) throw new HttpError(400, 'Invalid cutover digest');
    return [...value!.slice(3)].map(c => (c.charCodeAt(0)-97).toString(16)).join('');
  };
  router.get('/card-imports/cutover-capability', handle((req,res) => {
    scanQuery(req,[]); queryParams(req,[]);
    const ready=hasCutoverReceiptSchema(repo.internalGetDb());
    res.setHeader('Cache-Control','no-store');res.json({version:1,status:ready?'ready':'held',
      code:ready?'cutover-ready':'cutover-schema-required',ready,atomicAccountEpoch:ready,durableJobReceipt:ready});
  }));
  router.get('/card-imports/cutover-receipt', handle((req,res) => {
    const keys=['cardAccountId','jobId','payloadSha256'];
    scanQuery(req,keys);const query=queryParams(req,keys);
    if(!hasCutoverReceiptSchema(repo.internalGetDb()))throw new HttpError(409,'Cutover receipt schema requires explicit installation');
    const account=cardAccountParam(repo,query.get('cardAccountId'));
    const expectedPayload=cutoverDigest(query.get('payloadSha256'));
    const receipt=readCutoverCommitReceipt(repo.internalGetDb(),account.id,cutoverDigest(query.get('jobId')));
    if(receipt&&receipt.payloadSha256!==expectedPayload)throw new HttpError(409,'Cutover receipt conflicts');
    res.setHeader('Cache-Control','no-store');res.json({receipt});
  }));
  const CUTOVER_QUERY_NAMES = ['cardAccountId','jobId','epoch','start','proposalDigest','issuer','owner','currency','last4','previewDigest'];
  router.post('/card-imports/cutover-commit',...importBody,handleAsync(async (req,res)=>{
    const {query,payload}=readImportRequest(req,[...CUTOVER_QUERY_NAMES,...PROOF_QUERY_NAMES]);
    const proofAsked=PROOF_QUERY_NAMES.some((name)=>query.has(name));
    if(!proofAsked&&req.holdrAuth?.kind==='service')throw proofRequired();
    const accountId=query.get('cardAccountId')??'',start=query.get('start')??'',previewDigest=query.get('previewDigest');
    if(!PREVIEW_DIGEST.test(previewDigest??''))throw new HttpError(400,'previewDigest is invalid');
    const guard={accountId,jobId:cutoverDigest(query.get('jobId')),epoch:cutoverDigest(query.get('epoch')),
      proposalDigest:cutoverDigest(query.get('proposalDigest')),start,issuer:query.get('issuer')??'',
      owner:query.get('owner')??'',currency:query.get('currency')??'',last4:query.get('last4')??'',
      payloadSha256:createHash('sha256').update(serializeCardImportPayload(payload)).digest('hex')};
    // The guarded commit's own step; `seen` gets its classification and the repository's result.
    const cutoverCommit=(repeat:boolean,seen?:(preview:CardImportPreview,committed:CardImportCommitResult)=>void)=>{
      if(payload.issuer!==guard.issuer||payload.currency!==guard.currency||payload.rejectedCount!==0
        ||payload.coverage.start<start||payload.rows.some(r=>r.status!=='posted'||!isCardExternalIdHash(r.externalIdHash)
          ||r.transactionDate<start||(r.postedDate!==null&&r.postedDate<start)
          ||('originalCurrency' in r&&r.originalCurrency!=null&&r.originalCurrency!==payload.currency)))throw new CutoverCommitRefusal();
      const account=cardAccountParam(repo,accountId),preview=repo.previewCardImport({cardAccountId:accountId,payload});
      const summary=summaryBody(prepareImport(repo,account,payload,preview));
      if([summary.conflictCount,summary.possibleDuplicateCount,summary.pendingMatchCount,summary.dismissedMatchCount,
        summary.stalePendingCount,summary.pendingPostedCount,summary.heldCount,summary.reviewCount].some(n=>n!==0)
        ||(!repeat&&preview.previewDigest!==previewDigest))throw new CutoverCommitRefusal();
      const committed=repo.commitCardImport({cardAccountId:accountId,payload,previewDigest:preview.previewDigest,
        actorRef:sessionActorRef(req),decisions:{},shown:{possibleDuplicateRows:[],pendingMatchRows:[],dismissedMatchRows:[],stalePendingIds:[]}});
      if(committed.status==='decision-required'||(committed.status==='imported'&&(committed.heldCount!==0||committed.reviewCount!==0)))
        throw new CutoverCommitRefusal();
      seen?.(preview,committed);
      return {cardAccountId:accountId,imported:committed.status==='imported',rowCount:payload.rows.length,
        newCount:committed.status==='imported'?committed.batch.newCount:0,
        duplicateCount:committed.status==='imported'?committed.batch.duplicateCount:payload.rows.length};
    };
    if(!proofAsked){
      try{
        res.json(commitGuardedCardImport(repo.internalGetDb(),guard,(repeat)=>cutoverCommit(repeat)));
      }catch(error){
        if(error instanceof CutoverCommitRefusal)throw new HttpError(409,error.message);
        throw cardGuardRefusal(error,'$.rows',log)??repositoryError(error,'Cutover commit refused');
      }
      return;
    }
    // The proof (design v1.2 §3.3): the guarded commit runs as a savepoint of the proof's transaction. Only the runner's
    // mode, for this job's own guard; resolve goes through /card-imports/commit.
    const proof=await loadProof();
    const request=parseProof(proof,query);
    if(request.mode!=='automatic')throw proofRequestInvalid('proofMode');
    if(request.jobId!==guard.jobId)throw proofRequestInvalid('proofJob');
    const account=cardAccountParam(repo,accountId),db=repo.internalGetDb();
    let seen:{preview:CardImportPreview;committed:CardImportCommitResult}|undefined;
    let guarded:ReturnType<typeof commitGuardedCardImport>|undefined;
    let outcome:ReturnType<ProofModule['commitWithProof']>;
    try{
      outcome=proof.commitWithProof({db,repo,account,payload,payloadSha256:guard.payloadSha256,route:'cutover',now:Date.now},request,{
        commit(){
          seen=undefined;
          guarded=commitGuardedCardImport(db,guard,(repeat)=>cutoverCommit(repeat,(preview,committed)=>{seen={preview,committed};}));
          const done=seen!.committed;
          return {outcome:done.status==='imported'?'committed':'nothing-new',planDigest:seen!.preview.previewDigest,
            newCount:done.status==='imported'?done.batch.newCount:0,
            promotedCount:done.status==='decision-required'?0:done.counts.pendingPostedCount,
            skippedRows:[],heldCount:0,reviewCount:0,cutoverRepeated:guarded.repeated};
        },
        reapplyAddsNothing:()=>commitGuardedCardImport(db,guard,(repeat)=>cutoverCommit(repeat)).repeated,
      });
    }catch(error){
      throw proofFailure(proof,error,request.jobId,account,payload,'Cutover commit refused');
    }
    const job=request.jobId.slice(0,8);
    if(outcome.repeated){
      log(`[card-import-proof] repeated job ${job}`);
      res.json({receipt:readCutoverCommitReceipt(db,account.id,guard.jobId),repeated:true,proof:outcome.receipt,
        proofLabel:proof.stoppingLabel(db,outcome.receipt)});
      return;
    }
    log(`[card-import-proof] committed job ${job} ${request.mode} ${outcome.receipt.outcome}`);
    res.json({...guarded!,proof:outcome.receipt});
  }));
  /**
   * Phase 4's answer to a commit, with `extra` (the proof's receipt) added: 201 with the batch, 200 when nothing is new,
   * and for `decision-required` the 409 its kind asks.
   */
  const sendCommitResult = (res: Response, account: CardAccount, payload: CardImportPayload, result: CardImportCommitResult,
    extra: Record<string, unknown> = {}): void => {
    // Every answer from the transaction's own classification; an import's, from what it did once the owner's decisions
    // applied (rows held, under review already, asked about; E2d review r1, finding 9).
    const summary = summaryBody(prepareImport(repo, account, payload,
      result.status === 'decision-required' ? result.preview : { ...result.preview, ...result.applied }));
    if (result.status === 'decision-required') throw decisionRequired(result.kind, summary);
    const body = { ...summary, ...result.counts, ...extra };
    // Nothing new: an import is still recorded when it posts pending rows, dismisses stale ones, holds or reviews
    // rows, or its coverage adds dates (a quiet month, or a sync whose rows are all known). Repeating an import
    // records nothing.
    if (result.status === 'nothing-new') {
      res.status(200).json({ imported: false, batch: null, ...body, newCount: 0 });
      return;
    }
    const { batch, heldCount, reviewCount } = result;
    const batchName = GENERATED_BATCH_ID.test(batch.id) ? batch.id : '(non-standard id)';
    const staleNote = result.counts.stalePendingDismissedCount > 0 ? `, ${result.counts.stalePendingDismissedCount} stale pending dismissed` : '';
    log(`[card-imports] committed batch ${batchName}: ${batch.newCount} new, ${batch.duplicateCount} duplicate, `
      + `${batch.rejectedCount - heldCount} rejected, ${heldCount} held for review, ${reviewCount} review items, `
      + `${result.counts.pendingPostedCount} pending posted${staleNote}`);
    res.status(201).json({ imported: true, batch, ...body, newCount: batch.newCount, duplicateCount: batch.duplicateCount, heldCount,
      reviewCount });
  };

  /**
   * The W4 proof on /card-imports/commit (design v1.2 §3): the commit, decided inside one transaction with every gate,
   * or resolve, which fences the job's attempt and answers whether it committed.
   */
  const commitUnderProof = async (req: Request, res: Response, query: Map<string, string>, payload: CardImportPayload,
    owner: OwnerDecisions, account: CardAccount): Promise<void> => {
    const proof = await loadProof();
    const request = parseProof(proof, query);
    const db = repo.internalGetDb();
    const payloadSha256 = createHash('sha256').update(serializeCardImportPayload(payload)).digest('hex');
    const job = request.jobId.slice(0, 8);
    if (request.mode === 'resolve') {
      if (ownerDecided(owner) || owner.previewDigest !== undefined) throw proofRequestInvalid('proofMode');
      let resolved: ReturnType<ProofModule['resolveProof']>;
      try {
        resolved = proof.resolveProof({ db, account, payloadSha256 }, request);
      } catch (error) {
        throw proofFailure(proof, error, request.jobId, account, payload, 'invalid card import');
      }
      log(`[card-import-proof] resolved job ${job} attempt ${request.attempt}: ${resolved.outcome}`);
      res.status(200).json({ proof: resolved.outcome === 'committed'
        ? { outcome: 'committed', receipt: resolved.receipt, label: proof.stoppingLabel(db, resolved.receipt) }
        : { outcome: 'not-committed' } });
      return;
    }
    // The runner's mode takes no owner decision at all; the operator kit's takes only its content-twin skip, which leaves
    // out exactly the rows the plan pairs one to one with stored posted rows (D13 rule).
    const skip = request.mode === 'supervised' && owner.possibleDuplicates === 'skip';
    if (ownerDecided({ ...owner, possibleDuplicates: skip ? undefined : owner.possibleDuplicates })) {
      throw new HttpError(400, 'this proof mode takes no such owner decision', { code: 'proof-decisions-refused' });
    }
    assertImportFits(account, payload);
    const decisions: CardImportDecisions = skip ? { possibleDuplicates: 'skip' } : {};
    const commitOnce = (previewDigest: string | undefined): CardImportCommitResult => repo.commitCardImport({
      cardAccountId: account.id, payload, previewDigest, actorRef: sessionActorRef(req), decisions,
      shown: shownLists(prepareImport(repo, account, payload).plan),
    });
    let committed: CardImportCommitResult | undefined;
    let outcome: ReturnType<ProofModule['commitWithProof']>;
    try {
      outcome = proof.commitWithProof({ db, repo, account, payload, payloadSha256, route: 'commit', now: Date.now }, request, {
        commit() {
          const result = commitOnce(owner.previewDigest);
          if (result.status === 'decision-required') throw new ProofDecisionRequired(result);
          committed = result;
          return {
            outcome: result.status === 'imported' ? 'committed' : 'nothing-new', planDigest: result.preview.previewDigest,
            newCount: result.status === 'imported' ? result.batch.newCount : 0, promotedCount: result.counts.pendingPostedCount,
            skippedRows: skip ? indexesOf(result.preview.plan, 'possible-duplicate') : [],
            heldCount: result.applied.heldRows.length + result.applied.heldOpenRows.length, reviewCount: result.applied.reviewRows.length,
          };
        },
        // Again, on the state the import left: it must add nothing. Never with the client's previewDigest, which that
        // state no longer matches.
        reapplyAddsNothing: () => commitOnce(undefined).status === 'nothing-new',
      });
    } catch (error) {
      throw proofFailure(proof, error, request.jobId, account, payload, 'invalid card import');
    }
    if (outcome.repeated) {
      log(`[card-import-proof] repeated job ${job}`);
      res.status(200).json({ imported: false, repeated: true, batch: null, ...summaryBody(prepareImport(repo, account, payload)),
        skippedPossibleDuplicates: outcome.receipt.counts.contentTwinsSkipped, pendingPostedCount: 0, pendingMatchesInsertedCount: 0,
        stalePendingDismissedCount: 0, newCount: 0, proof: outcome.receipt, proofLabel: proof.stoppingLabel(db, outcome.receipt) });
      return;
    }
    log(`[card-import-proof] committed job ${job} ${request.mode} ${outcome.receipt.outcome}`);
    sendCommitResult(res, account, payload, committed!, { proof: outcome.receipt });
  };

  router.post('/card-imports/commit', ...importBody, handleAsync(async (req, res) => {
    const { query, payload: checked } = readImportRequest(req, QUERY_NAMES);
    const proofAsked = PROOF_QUERY_NAMES.some((name) => query.has(name));
    if (!proofAsked && req.holdrAuth?.kind === 'service') throw proofRequired();
    const owner = readOwnerDecisions(query, checked);
    const account = cardAccountParam(repo, query.get('cardAccountId'));
    if (proofAsked) {
      await commitUnderProof(req, res, query, checked, owner, account);
      return;
    }
    // This request's own preview gives the complete lists the owner's decisions answer (never a response's 100-row
    // lists); the repository classifies again inside its transaction and asks again when its rows differ (§4.10.4).
    const shownPlan = prepareImport(repo, account, checked).plan;
    let result: CardImportCommitResult;
    try {
      result = repo.commitCardImport({
        cardAccountId: account.id, payload: checked, previewDigest: owner.previewDigest, actorRef: sessionActorRef(req),
        decisions: {
          possibleDuplicates: owner.possibleDuplicates, pendingMatches: owner.pendingMatches,
          dismissedMatches: owner.dismissedMatches, stalePending: owner.stalePending, acceptMismatch: owner.acceptMismatch,
        },
        shown: shownLists(shownPlan),
      });
    } catch (error) {
      throw cardGuardRefusal(error, '$.rows', log) ?? repositoryError(error, 'invalid card import');
    }
    sendCommitResult(res, account, checked, result);
  }));

  return router;
}

/**
 * Value-free error handling for every card spending path. Installed after all
 * card spending routers, so errors from any of them end here, including
 * Express's own (undecodable path parameters) and body parsers' (whose
 * messages and properties quote the request), and never reach the app's
 * error handler or Express's default one, which log them. Responses carry
 * fixed messages; the log gets only the error type of unexpected failures.
 */
function cardSpendingErrors(log: (line: string) => void): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const send = (status: number, message: string, extra: Record<string, unknown> = {}) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).json({ error: message, ...extra });
    };
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) return send(error.status, error.message, error.extra);
    const type = (error as { type?: unknown }).type;
    if (type === 'entity.parse.failed') return send(400, 'the request body is not valid JSON');
    if (type === 'entity.too.large') return send(413, 'the request body is too large; split the export');
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
      return send(415, 'the request body must be uncompressed UTF-8 JSON');
    }
    if (typeof type === 'string') return send(400, 'the request body could not be read');
    if (error instanceof URIError) return send(400, 'the request path is not valid URL encoding');
    const status = Number((error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) return send(status, STATUS_CODES[status] ?? 'request rejected');
    // Only the error's type: messages can quote input, and paths can carry ids.
    const name = error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'Error';
    const code = (error as { code?: unknown }).code;
    log(`[card-spending] ${req.method} request failed: ${name}${typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? ` ${code}` : ''}`);
    send(500, 'card spending request failed');
  };
}

export interface CardSpendingRouteDeps {
  repo: SqliteStateRepo;
  /**
   * The app's authentication middleware (login's `requireAuth`). Required: it
   * runs before any card spending handler reads a body or the repository.
   */
  requireAuth: RequestHandler;
  /** Operational log; receives counts and error types only. Defaults to console.error. */
  log?: (line: string) => void;
  /**
   * More card spending routers (Phase 4: /card-transactions, /spending/...)
   * to mount behind the same guard. Every route must lie under
   * CARD_SPENDING_PREFIXES.
   */
  routers?: readonly Router[];
}

function routePaths(router: Router): string[] {
  const stack = (router as unknown as { stack: Array<{ route?: { path: unknown } }> }).stack;
  return stack.flatMap((layer) => {
    if (!layer.route) return [];
    const path = layer.route.path;
    return Array.isArray(path) ? path.map(String) : [String(path)];
  });
}

/**
 * Mounts the card spending routes (/card-accounts, /card-imports/preview,
 * /card-imports/commit, plus any `routers` for later phases) behind
 * `requireAuth`, and refuses to mount without it.
 *
 * Wiring contract (createApp in app.ts follows it, behind login's identify,
 * csrfGuard and requireAuth):
 * - Mount after the app's session and CSRF/Origin middleware (login:
 *   `identify` and `csrfGuard`), with the same `requireAuth` the other data
 *   routes use. It runs again here for every card spending path before
 *   anything else, so a misordered mount still cannot serve card data
 *   anonymously. Never add these paths to an unauthenticated allowlist.
 * - The app-wide JSON parser must skip card spending paths:
 *   `app.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })))`. These
 *   routes read their own bodies (10 MB imports, 16 KB accounts, UTF-8 JSON
 *   only) so a parse error never quotes the body, and they refuse a request
 *   whose body another parser already read.
 * - Mount once. Every route of every router must lie under
 *   CARD_SPENDING_PREFIXES, which drives both the guard and the parser skip;
 *   a route outside them makes this function throw.
 * - Card spending paths never leave the guarded router: every error from any
 *   of its routers (the built-in ones and `routers`), including Express's
 *   path-decoding errors and body-parser errors, ends in one value-free error
 *   handler installed after all of them, and an unmatched card spending path
 *   gets a JSON 404 there. Requests for other paths leave it untouched, so
 *   the app's error handler never sees a card spending request.
 * - Handlers in `routers` should still answer their own validation errors
 *   (or throw HttpError-like errors with a 4xx `status`), and must not log
 *   request data themselves.
 */
const devicePassthroughs = new WeakMap<object, ExpressLayer>();

/** The factory's first, unmodified layer leaves non-card-spending requests before any child or auth handler executes. */
export function isCardSpendingDevicePassthrough(value: unknown): boolean {
  if (typeof value !== 'function' || !isVerifiedRouter(value)) return false;
  const original = devicePassthroughs.get(value);
  const first = (value as unknown as { stack: ExpressLayer[] }).stack[0];
  return original !== undefined && first !== undefined && isVerifiedExpressLayer(first) && first.handle === original.handle && first.regexp === original.regexp
    && first.match === original.match && first.handle_request === original.handle_request && first.handle_error === original.handle_error;
}

export function mountCardSpendingRoutes(app: Router, deps: CardSpendingRouteDeps): void {
  if (!deps || typeof deps.requireAuth !== 'function') {
    throw new Error('card spending routes need an authentication middleware (requireAuth); refusing to mount them without one');
  }
  if (!deps.repo) throw new Error('card spending routes need a repository');
  const routers = [createCardSpendingRouter(deps.repo, { log: deps.log }), ...(deps.routers ?? [])];
  for (const router of routers) {
    for (const path of routePaths(router)) {
      if (!isCardSpendingPath(path)) throw new Error('a card spending route lies outside CARD_SPENDING_PREFIXES; refusing to mount it');
    }
  }
  const log = deps.log ?? ((line: string) => console.error(line));
  const guarded = createVerifiedRouter();
  // Only card spending paths enter; every other request leaves this router at once.
  guarded.use((req, _res, next) => (isCardSpendingPath(req.path) ? next() : next('router')));
  const first = (guarded as unknown as { stack: ExpressLayer[] }).stack[0];
  devicePassthroughs.set(guarded, {
    ...first, match: first.match, handle_request: first.handle_request, handle_error: first.handle_error,
  });
  guarded.use(deps.requireAuth);
  for (const router of routers) guarded.use(router);
  guarded.use((req, res) => sendRefusal(req, res, 404, 'not-found'));
  // Last, after every child router: see the contract above.
  guarded.use(cardSpendingErrors(log));
  app.use(guarded);
}
