import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  cardOpeningEvidence,
  cardOpeningMonthStatus,
  type CardOpeningMonthsResponse,
} from '@finance-tracker/shared';
import {
  HttpError,
  cardGuardRefusal,
  isPlainObject,
  jsonBody,
  queryParams,
  readBody,
  rejectCardData,
  repositoryError,
  scanIdParam,
  scanQuery,
  sessionActorRef,
} from './cardSpending.js';
import { cardCoverageEvidence } from './cardSpendingOverview.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import {
  CARD_OPENING_MONTHS_NOT_INSTALLED as NOT_INSTALLED,
  MAX_CARD_OPENING_MONTHS,
  cardOpeningMonthsInForce,
  isCardOpeningMonthsNotInstalled,
} from '../services/cardOpeningMonths.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * The owner's card opening months (shared cardOpeningMonths.ts): "<month> is the month this card was opened (its first
 * statement), and Holdr has its record from its start", so coverage (/spending/coverage/months, /spending/compare and
 * /spending/trend) stops expecting a card before it. Served only through `mountCardSpendingRoutes` (cardSpending.ts), as
 * one of its `routers`, behind the same required sign-in, body-parser skip and value-free error handler as every card
 * spending route; the service token may only read.
 *
 *   GET    /spending/card-openings → { installed, cards: [{ cardAccountId, firstRowDate, firstCoverageDate,
 *          firstKnownDate, prefillMonth, openingMonth, confirmedAt, status, history }] }: every card account, what
 *          Holdr knows of when its record starts and the month to prefill (the month of its first known day), the
 *          month in force (with how coverage takes it: applied, contradicted by evidence from before it, or no data
 *          yet) and every confirmation, changes and clears included (never who made them)
 *   PUT    /spending/card-openings  body { cards: [{ cardAccountId, openingMonth }] } → { installed, changed, cards }:
 *          each card's month confirmed, all or nothing; the same month again changes nothing; a month after this
 *          month, or later than the month of the card's first known day (evidence already exists earlier), is refused
 *   DELETE /spending/card-openings/:id → { installed, cleared, cards }: the card's month ended (kept), or 404
 *
 * The months' table is installed only by the Root-GO-gated operator command (cli/cardOpenings.ts), never by the API:
 * until then the GET answers 200 with `installed: false` and no months, and a change is a 409. Card data anywhere in a
 * request is a 422 with paths only, before any other answer; sign-in and the body's shape come before that 409, and the
 * months' checks against the cards, their rows and their coverage after it. Unknown parameters and keys are refused,
 * errors never echo input, and nothing is logged but fixed lines. Nothing here writes a card account or transaction.
 */

/** Room for the largest batch the store takes: MAX_CARD_OPENING_MONTHS cards with 64-character ids. */
const BODY_LIMIT_BYTES = 32 * 1024;
const BODY_KEYS = ['cards'];
const ENTRY_KEYS = ['cardAccountId', 'openingMonth'];
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Every card's evidence of when its record starts, read exactly as coverage reads it. */
function cardEvidence(repo: SqliteStateRepo, cards: readonly { id: string }[]) {
  return cardOpeningEvidence({
    cards,
    coverage: cardCoverageEvidence(repo),
    rows: repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] }),
  });
}

/** What the owner's screen shows: every card account with its evidence, prefill, month in force and history. */
export function cardOpeningMonthsView(repo: SqliteStateRepo): CardOpeningMonthsResponse {
  const evidence = cardEvidence(repo, repo.listCardAccounts().map((account) => ({ id: account.id })));
  const records = repo.listCardOpeningMonths();
  const inForce = cardOpeningMonthsInForce(records);
  return {
    installed: repo.cardOpeningMonthsInstalled(),
    cards: evidence.map((card) => {
      const own = records.filter((record) => record.cardAccountId === card.cardAccountId);
      const openingMonth = inForce.get(card.cardAccountId) ?? null;
      return {
        ...card,
        openingMonth,
        confirmedAt: openingMonth === null ? null : own.find((record) => record.revokedAt === null)!.confirmedAt,
        status: openingMonth === null ? null : cardOpeningMonthStatus(openingMonth, card),
        history: own.map(({ openingMonth: month, confirmedAt, revokedAt }) => ({ openingMonth: month, confirmedAt, revokedAt })),
      };
    }),
  };
}

/** A change's cards and months, checked for shape only; the store checks them against the cards, their rows and coverage. */
function changeBody(input: unknown): Array<{ cardAccountId: string; openingMonth: string }> {
  if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
  if (Object.keys(input).some((key) => !BODY_KEYS.includes(key))) throw new HttpError(400, 'body has an unexpected key');
  const { cards } = input;
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > MAX_CARD_OPENING_MONTHS) {
    throw new HttpError(400, `cards must list 1 to ${MAX_CARD_OPENING_MONTHS} cards`);
  }
  const seen = new Set<string>();
  return cards.map((entry: unknown) => {
    if (!isPlainObject(entry) || Object.keys(entry).length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((key) => key in entry)) {
      throw new HttpError(400, 'each card must be { cardAccountId, openingMonth }');
    }
    const { cardAccountId, openingMonth } = entry;
    if (typeof cardAccountId !== 'string' || !CARD_ID.test(cardAccountId)) throw new HttpError(400, 'cardAccountId is invalid');
    if (seen.has(cardAccountId)) throw new HttpError(400, 'each card may be listed once');
    seen.add(cardAccountId);
    if (typeof openingMonth !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(openingMonth)) {
      throw new HttpError(400, 'openingMonth must be YYYY-MM');
    }
    return { cardAccountId, openingMonth };
  });
}

export function createCardOpeningsRouter(
  repo: SqliteStateRepo,
  options: { log?: (line: string) => void } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const body = readBody(BODY_LIMIT_BYTES);

  // As on the transaction routes: card data in the query first (422); then the store's own refusals as 400s, a months
  // table not installed as a 409; database failures go on to the mount's value-free handler.
  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, []);
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : isCardOpeningMonthsNotInstalled(caught)
          ? new HttpError(409, NOT_INSTALLED)
          : cardGuardRefusal(caught, '$', log)
            ?? (caught instanceof HoldrRefusal ? repositoryError(caught, 'invalid card opening month request') : caught);
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };

  /** Only a signed-in owner confirms or clears a month; the service principal never reaches these writes. */
  const owner = (req: Request): string => {
    const actorRef = sessionActorRef(req);
    if (actorRef === undefined) throw new HttpError(403, 'only a signed-in owner can change card opening months');
    return actorRef;
  };
  /** A change needs the table the operator installs; asked before any write, and again by the store under its lock. */
  const installed = (): void => {
    if (!repo.cardOpeningMonthsInstalled()) throw new HttpError(409, NOT_INSTALLED);
  };

  router.get('/spending/card-openings', handle((req, res) => {
    queryParams(req, []);
    res.json(cardOpeningMonthsView(repo));
  }));

  router.put('/spending/card-openings', ...body, handle((req, res) => {
    const input = jsonBody(req);
    rejectCardData(input, [...BODY_KEYS, ...ENTRY_KEYS]);
    queryParams(req, []);
    const actorRef = owner(req);
    const entries = changeBody(input);
    installed();
    // The first known day by the read path's one definition (what the GET and the coverage routes read), which the
    // store evaluates inside its write transaction, under the write lock.
    const firstKnownDays = (ids: readonly string[]) => new Map(cardEvidence(repo, ids.map((id) => ({ id })))
      .map((card) => [card.cardAccountId, card.firstKnownDate]));
    const { changed } = repo.confirmCardOpeningMonths(entries, { actorRef }, firstKnownDays);
    const view = cardOpeningMonthsView(repo);
    res.json({ installed: view.installed, changed, cards: view.cards });
  }));

  router.delete('/spending/card-openings/:id', handle((req, res) => {
    scanIdParam(req);
    queryParams(req, []);
    const actorRef = owner(req);
    const raw: unknown = req.params.id;
    const id = typeof raw === 'string' ? raw : '';
    if (!CARD_ID.test(id)) throw new HttpError(404, 'card account not found');
    installed();
    const cleared = repo.clearCardOpeningMonth(id, { actorRef });
    if (cleared === null) throw new HttpError(404, 'card account not found');
    const view = cardOpeningMonthsView(repo);
    res.json({ installed: view.installed, cleared, cards: view.cards });
  }));

  return router;
}
