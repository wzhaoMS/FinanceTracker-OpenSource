import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  benefitCreditWindow,
  computeCardBenefitsReport,
  isBenefitDate,
  type BenefitMarkStatus,
  type BenefitProductChoice,
} from '@finance-tracker/shared';
import {
  CARD_DATA_MESSAGE,
  HttpError,
  cardGuardRefusal,
  isPlainObject,
  jsonBody,
  looksLikeCardData,
  queryParams,
  readBody,
  rejectCardData,
  repositoryError,
  scanQuery,
} from './cardSpending.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * The Benefits tab (Everyday): per card account, what its product gives back
 * per period and how much of it was used, for a year. Served only through
 * `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, so
 * these routes sit behind the same required sign-in, body-parser skip and
 * value-free error handler as every card spending route; the service token
 * may only read them (auth/serviceScope.ts).
 *
 *   GET    /spending/benefits?year=YYYY&today=YYYY-MM-DD   → the year's report (shared computeCardBenefitsReport):
 *          cards with their product, benefits, periods, figures and sources; household totals; reminders
 *   PUT    /spending/benefits/cards/:id                    body { productChoice: 'auto'|'manual'|'none', productId?,
 *          anniversaryMonth?: 1–12|null } → { settings }
 *   PUT    /spending/benefits/marks                        body { cardAccountId, benefitId, periodStart,
 *          status: 'used'|'partial'|'unused', usedMinor? } → { mark }
 *   DELETE /spending/benefits/marks?cardAccountId=&benefitId=&periodStart=   → 204, or 404 when there was none
 *
 * Same rules as the other card spending routes: card data anywhere in the
 * request is a 422 with paths only, before any other answer; unknown
 * parameters and keys are refused, and errors never echo input. Nothing here
 * writes a card account or transaction: the routes read posted credits and
 * write only the benefits tables.
 */

const BODY_LIMIT_BYTES = 4 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SETTINGS_KEYS = new Set(['productChoice', 'productId', 'anniversaryMonth']);
const MARK_KEYS = new Set(['cardAccountId', 'benefitId', 'periodStart', 'status', 'usedMinor']);
const REPORT_PARAMS = ['year', 'today'] as const;
const MARK_PARAMS = ['cardAccountId', 'benefitId', 'periodStart'] as const;
const QUERY_NAMES = [...REPORT_PARAMS, ...MARK_PARAMS];
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

/** The server's calendar date; the web passes its own `today` so periods follow the viewer's day. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function cardAccountId(req: Request): string {
  scanCardAccountId(req);
  const raw: unknown = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  if (!ID.test(id)) throw new HttpError(404, 'card account not found');
  return id;
}

/** Card data in the :id is a 422 before the body is read, as everywhere on card spending paths. */
function scanCardAccountId(req: Request): void {
  const raw: unknown = req.params.id;
  if (typeof raw === 'string' && looksLikeCardData(raw)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.id'] });
}

function objectBody(req: Request, keys: ReadonlySet<string>): Record<string, unknown> {
  const body = jsonBody(req);
  rejectCardData(body, keys);
  if (!isPlainObject(body)) throw new HttpError(400, 'body must be an object');
  if (Object.keys(body).some((key) => !keys.has(key))) throw new HttpError(400, 'body has an unexpected key');
  return body;
}

export function createCardBenefitsRouter(
  repo: SqliteStateRepo,
  options: { log?: (line: string) => void } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  // One catalog for the report and for the settings and marks the repository checks.
  const catalog = repo.benefitsCatalog();
  const body = readBody(BODY_LIMIT_BYTES);

  // As on the transaction routes: card data in the query first (422), then the repository's own
  // refusals as 400s; database failures go on to the mount's value-free handler.
  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, QUERY_NAMES);
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : cardGuardRefusal(caught, '$', log)
          ?? (caught instanceof HoldrRefusal ? repositoryError(caught, 'invalid benefits request') : caught);
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };

  router.get('/spending/benefits', handle((req, res) => {
    const query = queryParams(req, REPORT_PARAMS);
    const today = query.get('today') ?? localDate(new Date());
    if (!isBenefitDate(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
    const yearParam = query.get('year') ?? today.slice(0, 4);
    if (!/^\d{4}$/.test(yearParam) || Number(yearParam) < FIRST_YEAR || Number(yearParam) > LAST_YEAR) {
      throw new HttpError(400, `year must be from ${FIRST_YEAR} to ${LAST_YEAR}`);
    }
    const year = Number(yearParam);
    const settings = new Map(repo.listCardBenefitSettings().map((entry) => [entry.cardAccountId, entry]));
    const window = benefitCreditWindow(year, today);
    res.json(computeCardBenefitsReport({
      catalog,
      year,
      today,
      cards: repo.listCardAccounts().map((account) => ({ account, settings: settings.get(account.id) ?? null })),
      credits: repo.listCardBenefitCredits(window.from, window.to),
      marks: repo.listCardBenefitMarks(),
      trackers: repo.listCardBenefitTrackers(),
    }));
  }));

  router.put('/spending/benefits/cards/:id', ...body, handle((req, res) => {
    // Card data anywhere (query, id, body) is a 422 before any 404 or 400.
    scanCardAccountId(req);
    const input = objectBody(req, SETTINGS_KEYS);
    const id = cardAccountId(req);
    queryParams(req, []);
    if (!repo.getCardAccount(id)) throw new HttpError(404, 'card account not found');
    if (input.anniversaryMonth !== undefined && input.anniversaryMonth !== null && typeof input.anniversaryMonth !== 'number') {
      throw new HttpError(400, 'anniversaryMonth must be 1 to 12, or null');
    }
    if (input.productId !== undefined && input.productId !== null && typeof input.productId !== 'string') {
      throw new HttpError(400, 'productId must be a product id');
    }
    const settings = repo.setCardBenefitSettings(id, {
      productChoice: input.productChoice as BenefitProductChoice,
      productId: input.productId as string | null | undefined,
      anniversaryMonth: input.anniversaryMonth as number | null | undefined,
    });
    res.json({ settings });
  }));

  router.put('/spending/benefits/marks', ...body, handle((req, res) => {
    const input = objectBody(req, MARK_KEYS);
    queryParams(req, []);
    for (const key of ['cardAccountId', 'benefitId', 'periodStart', 'status'] as const) {
      if (typeof input[key] !== 'string') throw new HttpError(400, `${key} is required`);
    }
    if (input.usedMinor !== undefined && input.usedMinor !== null && typeof input.usedMinor !== 'number') {
      throw new HttpError(400, 'usedMinor must be a whole number');
    }
    if (!repo.getCardAccount(input.cardAccountId as string)) throw new HttpError(404, 'card account not found');
    const mark = repo.setCardBenefitMark({
      cardAccountId: input.cardAccountId as string,
      benefitId: input.benefitId as string,
      periodStart: input.periodStart as string,
      status: input.status as BenefitMarkStatus,
      usedMinor: input.usedMinor as number | null | undefined,
    });
    res.json({ mark });
  }));

  router.delete('/spending/benefits/marks', handle((req, res) => {
    const query = queryParams(req, MARK_PARAMS);
    const key = {
      cardAccountId: query.get('cardAccountId') ?? '',
      benefitId: query.get('benefitId') ?? '',
      periodStart: query.get('periodStart') ?? '',
    };
    for (const [name, value] of Object.entries(key)) if (!value) throw new HttpError(400, `${name} is required`);
    if (!ID.test(key.cardAccountId) || !repo.getCardAccount(key.cardAccountId)) throw new HttpError(404, 'card account not found');
    if (!repo.clearCardBenefitMark(key)) throw new HttpError(404, 'no mark for that period');
    res.status(204).end();
  }));

  return router;
}
