import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  cardSpendingCoverageByMonth,
  cardSpendingCoverageForRange,
  cardSpendingCoverageGaps,
  cardSpendingPatterns,
  forecastCardSpending,
  isCardCategoryBasis,
  primaryCardCurrency,
  type CardCategoryBasis,
  type CardOwner,
  type CardSpendingCoverageGaps,
  type CardSpendingCoverageMonthsInput,
  type CardSpendingForecastInput,
  type CardTransaction,
} from '@finance-tracker/shared';
import { HttpError, cardGuardRefusal, queryParams, repositoryError, scanQuery } from './cardSpending.js';
import { cardCoverageEvidence, cardsInView, type CardSpendingView } from './cardSpendingOverview.js';
import { createCardSpendingReads, inferAll, type CardCategorySource } from './cardTransactions.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * Spending's patterns and forecast (shared cardSpendingForecast.ts), for the cards in view, as of a day. Served only
 * through `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the same required sign-in,
 * body-parser skip and value-free error handler as every card spending route. Reads only; no table of its own.
 *
 *   GET /spending/forecast   → { currency, today, month, months, fit, oneOffThresholdMinor, horizon, total, categories,
 *       ?cardAccountId=         pace, coverage, basis }: per month, posted spending, its large one-offs and everyday
 *       &owner= &currency=      spending (a partial month: its spending only), marked complete or not; everyday
 *       &today=YYYY-MM-DD       spending's next three months, all of it and per category, each from its own complete
 *       &categoryBasis=         months (method, estimate, 80% and 95% ranges with their tested coverage, backtest);
 *                               this month's pace: everyday spending so far plus the typical rest of a month (an 80%
 *                               range with its tested coverage), and the month's total with the one-offs already
 *                               posted; and what keeps months from being complete (cardSpendingCoverageGaps: card ids
 *                               and dates only), with the view's first month
 *   GET /spending/patterns   → { currency, today, month, anomalies, checks, bills, basis }: unusual everyday spending
 *       (the same query)        in the last complete month against the complete months before (a month in progress
 *                               is never compared), and the recurring bills due in the next 60 days at their usual
 *                               amounts, each with its evidence (late only in a complete month)
 *
 * Rows are read as the summary reads them (createCardSpendingReads): category labels are the app's own, the
 * household's inferred categories and the category source's splits on the enriched basis (the default), the cards' own
 * categories on the original one, so a row's category here is the summary's and the overview's. Asset purchases
 * (precious metals, the owner's word, decided as the summary decides them) and large one-off purchases are in no
 * baseline. On the enriched basis the one-off split reads the category source's order links, the household's, as the
 * insights and the overview do: a credit one of whose orders has a charge linked to a card row pays back only one of
 * those charges; any other refund goes by the merchant rule. What is learned is learned from amounts in months whose
 * card record is complete for every card in view (cardSpendingCoverage.ts over the overview's coverage evidence:
 * imports' declared ranges, and card-sync windows Holdr verified); a month in progress never is.
 *
 * Card data in the query is a 422 with paths only, before any other answer; unknown parameters are refused, and errors
 * never echo input. Nothing is logged but fixed lines.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OWNERS = new Set<CardOwner>(['alex', 'casey', 'joint']);
const PARAMS = ['cardAccountId', 'owner', 'currency', 'today', 'categoryBasis'] as const;
/** Every query name these routes take: a card-data hit names them in its paths. */
const QUERY_NAMES = [...PARAMS];

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The server's calendar date; the web passes its own `today`, as the insights take it. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The patterns' and forecast's routes, to pass to `mountCardSpendingRoutes` in `routers`. `log` gets fixed lines only. */
export function createCardSpendingForecastRouter(
  repo: SqliteStateRepo,
  options: {
    log?: (line: string) => void;
    /** The reviewed source of category splits, as the transaction routes take it (the Amazon domain's resolver, in the app). */
    categoryResolver?: CardCategorySource | null;
  } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const reads = createCardSpendingReads(repo, { categoryResolver: options.categoryResolver ?? null });

  // As on the transaction routes: card data in the query first (422); the repository's refusals are 400s; anything
  // else goes on to the mount's value-free handler.
  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, QUERY_NAMES);
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : cardGuardRefusal(caught, '$', log)
          ?? (caught instanceof HoldrRefusal ? repositoryError(caught, 'invalid card spending request') : caught);
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };

  /** The request's rows (read as the summary reads them), what the engines are given, and what keeps months from being complete. */
  const readRequest = (req: Request): {
    basis: CardCategoryBasis;
    rows: CardTransaction[];
    input: CardSpendingForecastInput;
    coverage: { firstMonth: string | null; gaps: CardSpendingCoverageGaps };
  } => {
    const query = queryParams(req, PARAMS);
    const view: CardSpendingView = {};
    const cardAccountId = query.get('cardAccountId');
    if (cardAccountId !== undefined) {
      if (!ID.test(cardAccountId)) throw new HttpError(400, 'cardAccountId is invalid');
      if (!repo.getCardAccount(cardAccountId)) throw new HttpError(404, 'card account not found');
      view.cardAccountId = cardAccountId;
    }
    const owner = query.get('owner');
    if (owner !== undefined) {
      if (!OWNERS.has(owner as CardOwner)) throw new HttpError(400, 'owner must be alex, casey or joint');
      view.owner = owner as CardOwner;
    }
    const today = query.get('today') ?? localDate(new Date());
    if (!isIsoDate(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
    const basisParam = query.get('categoryBasis') ?? 'enriched';
    if (!isCardCategoryBasis(basisParam)) throw new HttpError(400, 'categoryBasis must be enriched or original');
    const basis: CardCategoryBasis = basisParam;
    const accounts = repo.listCardAccounts();
    const currency = query.get('currency') ?? primaryCardCurrency(accounts, view);
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a three-letter uppercase code');

    // Every card row, read once: what the coverage reads, what asset purchases are decided over (owner decisions, as the
    // summary decides them; null: no row can be one), and what the household's inferred categories are learned from.
    const all = reads.householdOnce();
    const exclusions = reads.exclusionsFor(all);
    // One coverage input for the months, what keeps them from being complete, and this month's days so far, as the
    // overview reads them (cardSpendingOverview.ts: the cards in view, and the repository's coverage evidence).
    const coverageInput: CardSpendingCoverageMonthsInput = {
      cards: cardsInView(repo, view),
      coverage: cardCoverageEvidence(repo),
      rows: all(),
      today,
    };
    const months = cardSpendingCoverageByMonth(coverageInput);
    // Category labels are the app's own, exactly as the summary and the overview give them: the household's inferred
    // categories and the category source's splits. One category truth: what is learned from complete months only is
    // amounts (the engines' series, fits, thresholds and pace), never a row's label.
    const stored = reads.rowsMatching({ ...view, statuses: ['pending', 'posted'] });
    const model = reads.inferenceFor(basis, all);
    const rows = model ? inferAll(stored, model).rows : stored;
    const snapshot = reads.snapshotFor(basis);
    const splits = snapshot ? reads.splitsOf(rows, snapshot) : null;
    // The same snapshot's order links, the household's, as the insights and the overview read them: which purchase a
    // credit pays back is one truth too.
    const orderLinks = reads.orderLinksFor(snapshot, all);
    // This month's days before today: whether every card in view has its record for them.
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthSoFarComplete = today === monthStart ? null
      : cardSpendingCoverageForRange(coverageInput, { from: monthStart, to: dayBefore(today) }).complete;
    return {
      basis,
      rows,
      input: {
        today,
        currency,
        completeMonths: new Set(months.filter((month) => month.complete).map((month) => month.month)),
        ...(exclusions ? { exclusions } : {}),
        ...(splits ? { categoryParts: splits.parts } : {}),
        monthSoFarComplete,
        ...(orderLinks ? { orderLinks } : {}),
      },
      coverage: { firstMonth: months[0]?.month ?? null, gaps: cardSpendingCoverageGaps(coverageInput) },
    };
  };

  router.get('/spending/forecast', handle((req, res) => {
    const { basis, rows, input, coverage } = readRequest(req);
    res.json({ ...forecastCardSpending(rows, input), coverage, basis });
  }));

  router.get('/spending/patterns', handle((req, res) => {
    const { basis, rows, input } = readRequest(req);
    res.json({ ...cardSpendingPatterns(rows, input), basis });
  }));

  return router;
}
