import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  cardSpendingCoverageByMonth,
  cardSpendingCoverageForRange,
  cardSpendingCoverageGaps,
  cardSpendingTrend,
  classifyCardSpending,
  compareCardSpending,
  primaryCardCurrency,
  type CardCoverageCard,
  type CardCoverageEvidence,
  type CardOwner,
  type CardSpendingClassifyOptions,
  type CardSpendingMonthCoverage,
  type CardSpendingRangeCoverage,
  type CardTransaction,
} from '@finance-tracker/shared';
import { HttpError, cardGuardRefusal, queryParams, repositoryError, scanQuery } from './cardSpending.js';
import { CARD_SPENDING_FILTER_PARAMS, createCardSpendingReads, type CardCategorySource, type CardSpendingReads } from './cardTransactions.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import { cardOpeningMonthsInForce } from '../services/cardOpeningMonths.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * Spending's overview: a period's true spend against a baseline, its parts, its months, and how much of the card
 * record is known, month by month. Served only through `mountCardSpendingRoutes` (cardSpending.ts), as one of its
 * `routers`, behind the same required sign-in, body-parser skip and value-free error handler as every card spending
 * route. Reads only; every figure is the summary's, read the same way (createCardSpendingReads), so asset purchases,
 * transfers and `other` rows are never spending here either.
 *
 *   GET /spending/compare           → { basis, comparison: { currency, thresholdMinor, current, baseline, deltaMinor,
 *       the summary's filters, with   oneOffDeltaMinor, drivers, remainder } } (cardSpendingCompare.ts): each window's
 *       from and to (the period)      spending as the summary counts it, split into recurring charges, large one-offs
 *       &baselineFrom= &baselineTo=   and everyday spending, its one-offs and recurring merchants, and its categories
 *       &today= &currency=            with their merchant lines (a split row's line apart, `itemized`); the change split
 *                                     into one-offs, driver categories (each with its merchants) and everything else,
 *                                     to the cent; and each window's card coverage (cardSpendingCoverageForRange).
 *                                     Large one-offs are judged as of the period's last day, recurring charges as of
 *                                     today, over every row of the cards in view, as the insights judge them; on the
 *                                     enriched basis a credit one of whose Amazon orders has a charge linked to a
 *                                     card row (on any card) is set only against one of those charges.
 *   GET /spending/trend             → { basis, currency, thresholdMinor, months: [{ month, spendingMinor, recurringMinor,
 *       the summary's filters but     oneOffMinor, everydayMinor, count, coverage }], gaps }: per month from fromMonth
 *       from and to, &fromMonth=      through toMonth (default the 12 months to today's), its spending split the same
 *       &toMonth= &today= &currency=  way, with one large one-off threshold as of the last month's end (or today); and
 *                                     what keeps those months from being complete (cardSpendingCoverageGaps: the open
 *                                     cards behind and the cards first seen later, by id and date only).
 *   GET /spending/coverage/months   → { months: [{ month, complete, cardsWithData, cardsExpected, cardsCovered,
 *       ?cardAccountId= &owner=        inProgress, uncoveredCardIds }] }: per month of the cards in view, whether every
 *       &fromMonth= &toMonth=          card that plausibly existed then is known to have all its rows stored
 *       &today=YYYY-MM-DD              (cardSpendingCoverage.ts); by default from the first month with a row through
 *                                      today's month. Known coverage is what imports declared, and card-sync windows
 *                                      Holdr verified complete; a month not over before `today` is never complete. A
 *                                      card is not expected before the opening month its owner confirmed
 *                                      (/spending/card-openings, cardSpendingOpenings.ts), here and in every window;
 *                                      a window a card opened in after its first day lists it in `openedCardIds`.
 *
 * Card data in the query is a 422 with paths only, before any other answer; unknown parameters are refused, and errors
 * never echo input.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OWNERS = new Set<CardOwner>(['alex', 'casey', 'joint']);
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const COVERAGE_PARAMS = ['cardAccountId', 'owner', 'fromMonth', 'toMonth', 'today'] as const;
const COMPARE_PARAMS = [...CARD_SPENDING_FILTER_PARAMS, 'baselineFrom', 'baselineTo', 'today', 'currency'] as const;
const TREND_FILTERS = CARD_SPENDING_FILTER_PARAMS.filter((name) => name !== 'from' && name !== 'to');
const TREND_PARAMS = [...TREND_FILTERS, 'fromMonth', 'toMonth', 'today', 'currency'] as const;
/** Every query name these routes take: a card-data hit names them in its paths. */
const QUERY_NAMES = [...new Set<string>([...COVERAGE_PARAMS, ...COMPARE_PARAMS, ...TREND_PARAMS])];
/** A comparison reads at most this many days, from its baseline's first to its period's last. */
const MAX_COMPARE_DAYS = 3 * 366 + 31;
/** A trend lists at most this many months. */
const MAX_TREND_MONTHS = 36;

/** Which card accounts a view covers: one card, one person's cards, or all of them. */
export interface CardSpendingView {
  cardAccountId?: string;
  owner?: CardOwner;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The server's calendar date; the web passes its own `today`, as the insights take it. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * What is known to be stored, per card account: the date ranges its imports declared (the Spending tab's imported
 * dates), and card-sync windows Holdr verified complete, over the days a transaction-date read asked for. A sync
 * window's own claim is not taken (card sync contract 1 verifies none, so none count yet), nor the days its rows
 * happen to span: neither says that nothing is missing.
 */
export function cardCoverageEvidence(repo: SqliteStateRepo): CardCoverageEvidence[] {
  const declared = repo.listCardCoverage().map((card) => ({ cardAccountId: card.cardAccountId, ranges: card.ranges }));
  const verified = repo.listCardCoverageWindows({ ledgerStates: ['committed'] }).flatMap((window) =>
    window.verifiedCompleteness === 'complete' && window.requested !== null && window.requested.basis === 'transaction'
      ? [{ cardAccountId: window.cardAccountId, ranges: [{ start: window.requested.start, end: window.requested.end }] }]
      : []);
  return [...declared, ...verified];
}

/** The card accounts in a view, with whether each is closed and its owner-confirmed opening month: what coverage reads. */
export function cardsInView(repo: SqliteStateRepo, view: CardSpendingView): CardCoverageCard[] {
  // None until the operator installs the opening months' table: then every card is read as before.
  const openings = cardOpeningMonthsInForce(repo.listCardOpeningMonths());
  return repo.listCardAccounts()
    .filter((account) => (view.cardAccountId === undefined || account.id === view.cardAccountId)
      && (view.owner === undefined || account.owner === view.owner))
    .map((account) => {
      const openingMonth = openings.get(account.id);
      return openingMonth === undefined ? { id: account.id, status: account.status } : { id: account.id, status: account.status, openingMonth };
    });
}

/**
 * Per month, what is known of the card record in a view (cardSpendingCoverageByMonth over the repository's cards,
 * coverage and rows). `rows` may be given when the caller has every card row already; rows of other cards are ignored.
 */
export function readCardSpendingCoverage(
  repo: SqliteStateRepo,
  view: CardSpendingView,
  options: { today: string; from?: string; to?: string; rows?: readonly CardTransaction[] },
): CardSpendingMonthCoverage[] {
  return cardSpendingCoverageByMonth({
    cards: cardsInView(repo, view),
    coverage: cardCoverageEvidence(repo),
    rows: options.rows ?? repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] }),
    today: options.today,
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
  });
}

/** A view's cards from the query, checked as the summary checks them. */
function viewQuery(repo: SqliteStateRepo, query: Map<string, string>): CardSpendingView {
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
  return view;
}

function todayOf(query: Map<string, string>): string {
  const today = query.get('today') ?? localDate(new Date());
  if (!isIsoDate(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
  return today;
}

function requiredDate(query: Map<string, string>, name: string): string {
  const value = query.get(name);
  if (value === undefined) throw new HttpError(400, `${name} is required`);
  if (!isIsoDate(value)) throw new HttpError(400, `${name} must be a valid YYYY-MM-DD date`);
  return value;
}

function monthOf(query: Map<string, string>, name: string): string | undefined {
  const value = query.get(name);
  if (value !== undefined && !MONTH.test(value)) throw new HttpError(400, `${name} must be YYYY-MM`);
  return value;
}

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthAt = (index: number) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;

function monthEnd(month: string): string {
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

/** The currency asked for, else the one most cards in view use, as the insights choose it. */
function currencyOf(repo: SqliteStateRepo, query: Map<string, string>, view: CardSpendingView): string {
  const currency = query.get('currency') ?? primaryCardCurrency(repo.listCardAccounts(), view);
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a three-letter uppercase code');
  return currency;
}

/**
 * How the overview classifies a summary view's rows: its exclusions and category parts (with every part of a split
 * row, for refunds set against one-offs and for item parts), every row of the cards in view, where large one-offs
 * and recurring charges are found whatever the category, merchant or text filters, and (enriched, with a source that
 * describes rows and orders) its order links, the household's: a credit with a decisive link goes only with one of its
 * orders' charges.
 */
function classifyOptions(
  read: ReturnType<CardSpendingReads['viewOf']>,
  cards: ReadonlySet<string>,
  options: { currency: string; through: string; today: string },
): CardSpendingClassifyOptions {
  const splits = read.enriched?.splits ?? null;
  const orderLinks = read.enriched?.orderLinks;
  return {
    ...options,
    // None when no card row can be an asset purchase (the summary's fast path).
    ...(read.exclusions ? { exclusions: read.exclusions } : {}),
    ...(read.enriched ? { categoryParts: read.enriched.parts } : {}),
    ...(splits ? { fullParts: splits.parts, splitIds: new Set(splits.parts.keys()) } : {}),
    ...(orderLinks ? { orderLinks } : {}),
    detectionRows: read.all().filter((row) => cards.has(row.cardAccountId)),
  };
}

/** The overview's routes, to pass to `mountCardSpendingRoutes` in `routers`. `log` gets fixed lines only. */
export function createCardSpendingOverviewRouter(
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

  /** The summary's view of the rows in [from, to] with the query's other filters. */
  const viewBetween = (query: Map<string, string>, from: string, to: string) => reads.viewOf(new Map([
    ...[...query].filter(([key]) => TREND_FILTERS.includes(key as (typeof TREND_FILTERS)[number])),
    ['from', from],
    ['to', to],
  ]));
  const cardIdsOf = (view: CardSpendingView) => new Set(cardsInView(repo, view).map((card) => card.id));

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

  router.get('/spending/coverage/months', handle((req, res) => {
    const query = queryParams(req, COVERAGE_PARAMS);
    const view = viewQuery(repo, query);
    const today = todayOf(query);
    const months: Record<'from' | 'to', string | undefined> = { from: query.get('fromMonth'), to: query.get('toMonth') };
    for (const [name, value] of [['fromMonth', months.from], ['toMonth', months.to]] as const) {
      if (value !== undefined && !MONTH.test(value)) throw new HttpError(400, `${name} must be YYYY-MM`);
    }
    if (months.from !== undefined && months.to !== undefined && months.from > months.to) {
      throw new HttpError(400, 'fromMonth must not be after toMonth');
    }
    res.json({ months: readCardSpendingCoverage(repo, view, { today, from: months.from, to: months.to }) });
  }));

  router.get('/spending/compare', handle((req, res) => {
    const query = queryParams(req, COMPARE_PARAMS);
    const current = { from: requiredDate(query, 'from'), to: requiredDate(query, 'to') };
    if (current.from > current.to) throw new HttpError(400, 'from must not be after to');
    const baseline = { from: requiredDate(query, 'baselineFrom'), to: requiredDate(query, 'baselineTo') };
    if (baseline.from > baseline.to) throw new HttpError(400, 'baselineFrom must not be after baselineTo');
    if (baseline.to >= current.from) throw new HttpError(400, 'baselineTo must be before from');
    if (dayNumber(current.to) - dayNumber(baseline.from) >= MAX_COMPARE_DAYS) throw new HttpError(400, 'a comparison spans at most three years');
    const today = todayOf(query);
    const view = viewQuery(repo, query);
    const currency = currencyOf(repo, query, view);
    const cards = cardIdsOf(view);
    // One read for both windows and the days between them, as the summary reads each.
    const read = viewBetween(query, baseline.from, current.to);
    const comparison = compareCardSpending(read.shown, {
      ...classifyOptions(read, cards, { currency, through: current.to, today }),
      current,
      baseline,
    });
    const coverageInput = { cards: cardsInView(repo, view), coverage: cardCoverageEvidence(repo), rows: read.all(), today };
    const coverageOf = (range: { from: string; to: string }): CardSpendingRangeCoverage => cardSpendingCoverageForRange(coverageInput, range);
    res.json({
      basis: read.basis,
      comparison: {
        ...comparison,
        current: { ...comparison.current, coverage: coverageOf(current) },
        baseline: { ...comparison.baseline, coverage: coverageOf(baseline) },
      },
    });
  }));

  router.get('/spending/trend', handle((req, res) => {
    const query = queryParams(req, TREND_PARAMS);
    const today = todayOf(query);
    const toMonth = monthOf(query, 'toMonth') ?? today.slice(0, 7);
    const fromMonth = monthOf(query, 'fromMonth') ?? monthAt(monthIndex(toMonth) - 11);
    if (fromMonth > toMonth) throw new HttpError(400, 'fromMonth must not be after toMonth');
    if (monthIndex(toMonth) - monthIndex(fromMonth) >= MAX_TREND_MONTHS) throw new HttpError(400, `a trend lists at most ${MAX_TREND_MONTHS} months`);
    const view = viewQuery(repo, query);
    const currency = currencyOf(repo, query, view);
    const read = viewBetween(query, `${fromMonth}-01`, monthEnd(toMonth));
    // One threshold for every month shown: as of the last month's end, or today while it is still going.
    const through = monthEnd(toMonth) < today ? monthEnd(toMonth) : today;
    const classification = classifyCardSpending(read.shown, classifyOptions(read, cardIdsOf(view), { currency, through, today }));
    const months = Array.from({ length: monthIndex(toMonth) - monthIndex(fromMonth) + 1 }, (_, index) => monthAt(monthIndex(fromMonth) + index));
    const coverageInput = { cards: cardsInView(repo, view), coverage: cardCoverageEvidence(repo), rows: read.all(), today, from: fromMonth, to: toMonth };
    const coverage = new Map(cardSpendingCoverageByMonth(coverageInput).map(({ month, ...known }) => [month, known]));
    res.json({
      basis: read.basis,
      currency,
      thresholdMinor: classification.thresholdMinor,
      months: cardSpendingTrend(classification, months).map((item) => ({ ...item, coverage: coverage.get(item.month)! })),
      gaps: cardSpendingCoverageGaps(coverageInput),
    });
  }));

  return router;
}
