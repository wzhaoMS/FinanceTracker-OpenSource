import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  isCardMetalsMerchantClass,
  previewCardSpendingRule,
  readCardSpendingRows,
  type CardSpendingRule,
  type CardSpendingRulePreview,
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
  sessionActorRef,
} from './cardSpending.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import { CARD_SPENDING_RULES_NOT_INSTALLED as NOT_INSTALLED, isCardSpendingRulesNotInstalled } from '../services/cardSpendingRules.js';
import { cardSyncHash } from '../services/cardSyncDigests.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * The owner's spending rules: "<class> purchases of at least <amount> in <currency> are precious metals", an asset
 * purchase and not spending (shared cardSpendingExclusions.ts). A rule applies when rows are read, to every covered
 * purchase, past and future, without the owner's own category on the row; revoking it puts them back. Served only
 * through `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the same required sign-in,
 * body-parser skip and value-free error handler as every card spending route; the service token may only read.
 *
 *   GET    /spending/rules/preview?merchantClass=&currency=&minAmountMinor=   → { preview }: what the rule would take
 *          out of spending now (purchases, their exact refunds, amounts, dates), what it would leave (rows the owner
 *          filed under another category, rows already out), and its `match`: { count, netMinor, digest }, the rows it
 *          would take out, bound to the rule's fields
 *   POST   /spending/rules        body { merchantClass, currency, minAmountMinor, preview: <the preview's match> }
 *                                 → 201 { rule }; 409 with `reason: 'preview-stale'` when the rule would now take out
 *                                 anything but what that preview showed (preview again)
 *   DELETE /spending/rules/:id                                                  → { rule } (revoked), or 404
 *
 * The rules' table is installed only by the Root-GO-gated operator command (cli/spendingRules.ts), never by the API:
 * until then a preview still answers 200 (it only reads, and writes nothing), and a change is a 409. Validation and
 * sign-in come before that 409, and it before the preview check. `/spending/accounting` lists the rules. Card data
 * anywhere in a request is a 422 with paths only, before any other answer; unknown parameters and keys are refused,
 * and errors never echo input. Nothing here writes a card account or transaction.
 */

const BODY_LIMIT_BYTES = 4 * 1024;
const RULE_KEYS = new Set(['merchantClass', 'currency', 'minAmountMinor', 'preview']);
const MATCH_KEYS = ['count', 'netMinor', 'digest'];
const PREVIEW_PARAMS = ['merchantClass', 'currency', 'minAmountMinor'] as const;
const RULE_ID = /^csr_[a-p]{32}$/;
const MAX_MINOR = 999_999_999_999;
/** `srp1:` and 64 letters (cardSyncHash): never a digit run the card-data scan could read as a card number. */
const MATCH_DIGEST = /^srp1:[a-p]{64}$/;
const PREVIEW_STALE = 'this rule would now take out other charges than its preview showed; preview it again';

/** What a preview showed a rule would take out: how many rows, their net, and which, bound to the rule's fields. */
export interface CardSpendingRuleMatch {
  count: number;
  netMinor: number;
  digest: string;
}

type RuleFields = Pick<CardSpendingRule, 'merchantClass' | 'currency' | 'minAmountMinor'>;

/** A preview's match: equal matches mean the same rule would take out exactly the same rows. */
export function cardSpendingRuleMatch(rule: RuleFields, preview: CardSpendingRulePreview): CardSpendingRuleMatch {
  return {
    count: preview.amounts.count,
    netMinor: preview.amounts.netMinor,
    digest: `srp1:${cardSyncHash(['holdr.card-spending-rule-preview', 1, rule.merchantClass, rule.currency, rule.minAmountMinor,
      preview.amounts.count, preview.amounts.netMinor, preview.rowIds])}`,
  };
}

/** The preview the API answers: the shared preview's figures and its match, without the rows' ids. */
function previewView(rule: RuleFields, preview: CardSpendingRulePreview) {
  const { rowIds: _rowIds, ...figures } = preview;
  return { ...figures, match: cardSpendingRuleMatch(rule, preview) };
}

/** A candidate rule's fields, checked as the store checks them. */
function candidate(input: { merchantClass: unknown; currency: unknown; minAmountMinor: unknown }): RuleFields {
  if (!isCardMetalsMerchantClass(input.merchantClass)) throw new HttpError(400, 'merchantClass is not a precious-metals merchant class');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new HttpError(400, 'currency must be a three-letter uppercase code');
  }
  const amount = input.minAmountMinor;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_MINOR) {
    throw new HttpError(400, 'minAmountMinor must be a whole number of minor units, at least 1');
  }
  return { merchantClass: input.merchantClass, currency: input.currency, minAmountMinor: amount };
}

/** The preview match a new rule carries, checked for shape only; whether it is current is checked against the rows. */
function previewMatch(value: unknown): CardSpendingRuleMatch {
  const valid = isPlainObject(value)
    && Object.keys(value).length === MATCH_KEYS.length && MATCH_KEYS.every((key) => key in value)
    && typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0
    && typeof value.netMinor === 'number' && Number.isSafeInteger(value.netMinor)
    && typeof value.digest === 'string' && MATCH_DIGEST.test(value.digest);
  if (!valid) throw new HttpError(400, 'preview must be the match of this rule\'s preview');
  return value as unknown as CardSpendingRuleMatch;
}

/**
 * Every card row, pending and posted, as Spending reads it (a charge that takes a card payment back is a payment, so
 * no rule covers it): what the accounting resolves rules over, so a preview matches what a rule then takes out.
 */
function spendingRows(repo: SqliteStateRepo) {
  return readCardSpendingRows(repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] }));
}

export function createCardSpendingRulesRouter(
  repo: SqliteStateRepo,
  options: { log?: (line: string) => void } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const body = readBody(BODY_LIMIT_BYTES);

  // As on the transaction routes: card data in the query first (422); then the store's own refusals as 400s, a rule
  // table not installed as a 409; database failures go on to the mount's value-free handler.
  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, PREVIEW_PARAMS);
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : isCardSpendingRulesNotInstalled(caught)
          ? new HttpError(409, NOT_INSTALLED)
          : cardGuardRefusal(caught, '$', log)
            ?? (caught instanceof HoldrRefusal ? repositoryError(caught, 'invalid spending rule request') : caught);
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };

  /** Only a signed-in owner makes or revokes a rule; the service principal never reaches these writes. */
  const owner = (req: Request): string => {
    const actorRef = sessionActorRef(req);
    if (actorRef === undefined) throw new HttpError(403, 'only a signed-in owner can change spending rules');
    return actorRef;
  };
  /** A change needs the table the operator installs; asked before any write, and again by the store under its lock. */
  const installed = (): void => {
    if (!repo.cardSpendingRulesInstalled()) throw new HttpError(409, NOT_INSTALLED);
  };

  router.get('/spending/rules/preview', handle((req, res) => {
    const query = queryParams(req, PREVIEW_PARAMS);
    const amount = query.get('minAmountMinor');
    if (amount !== undefined && !/^\d{1,12}$/.test(amount)) throw new HttpError(400, 'minAmountMinor must be a whole number of minor units, at least 1');
    const rule = candidate({ merchantClass: query.get('merchantClass'), currency: query.get('currency'), minAmountMinor: amount === undefined ? undefined : Number(amount) });
    const rows = spendingRows(repo);
    res.json({ preview: previewView(rule, previewCardSpendingRule(rows, repo.listCardSpendingRules(), rule)) });
  }));

  router.post('/spending/rules', ...body, handle((req, res) => {
    const input = jsonBody(req);
    rejectCardData(input, RULE_KEYS);
    queryParams(req, []);
    const actorRef = owner(req);
    if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(input).some((key) => !RULE_KEYS.has(key))) throw new HttpError(400, 'body has an unexpected key');
    const fields = candidate({ merchantClass: input.merchantClass, currency: input.currency, minAmountMinor: input.minAmountMinor });
    const seen = previewMatch(input.preview);
    installed();
    // The owner makes the rule they saw: what it would take out now, on these fields, must be exactly that preview's.
    // Synchronous from here to the write, so no other request changes the rows in between.
    const now = cardSpendingRuleMatch(fields, previewCardSpendingRule(spendingRows(repo), repo.listCardSpendingRules(), fields));
    if (now.count !== seen.count || now.netMinor !== seen.netMinor || now.digest !== seen.digest) {
      throw new HttpError(409, PREVIEW_STALE, { reason: 'preview-stale' });
    }
    const rule = repo.createCardSpendingRule(fields, { actorRef });
    res.status(201).json({ rule });
  }));

  router.delete('/spending/rules/:id', handle((req, res) => {
    const raw: unknown = req.params.id;
    const id = typeof raw === 'string' ? raw : '';
    if (looksLikeCardData(id)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.id'] });
    queryParams(req, []);
    const actorRef = owner(req);
    if (!RULE_ID.test(id)) throw new HttpError(404, 'spending rule not found');
    installed();
    const rule = repo.revokeCardSpendingRule(id, { actorRef });
    if (!rule) throw new HttpError(404, 'spending rule not found');
    res.json({ rule });
  }));

  return router;
}
