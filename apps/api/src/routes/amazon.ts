import type { RequestHandler } from 'express';
import { isAmazonSpendingDay, isAmazonSpendingWindow } from '@finance-tracker/shared';
import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { amazonSummary, getAmazonOrder, listAmazonOrders } from '../services/amazon/readModel.js';
import { amazonSpending } from '../services/amazon/spending.js';
import { amazonTaxonomySpending } from '../services/amazon/taxonomySpending.js';
import { amazonFresh, amazonFreshOrder } from '../services/amazon/fresh.js';
import { readAmazonItemImage } from '../services/amazon/images.js';
import { ref } from '../services/amazon/policy.js';
import { HttpError, queryParams, scanQuery } from './cardSpending.js';

/** The server's calendar date; the page sends its own `today`, so a window ends on the viewer's day. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Mounted only by the guarded financial mount. No financial ingestion, mutating HTTP surface or outbound request. */
export function createAmazonRouter(repo: Pick<SqliteStateRepo, 'internalGetDb'>) {
  const router = createVerifiedRouter();
  const ownerOnly: RequestHandler = (req, res, next) => {
    if (req.holdrAuth?.kind !== 'session') {
      res.status(403).json({ error: 'owner session required', code: 'principal-not-allowed' });
      return;
    }
    next();
  };
  router.use('/amazon', ownerOnly);
  router.get('/amazon/summary', (req, res, next) => {
    try {
      scanQuery(req, []); queryParams(req, []);
      res.json(amazonSummary(repo.internalGetDb()));
    } catch (error) { next(error); }
  });
  router.get('/amazon/orders', (req, res, next) => {
    try {
      scanQuery(req, ['offset', 'limit', 'beneficiary']);
      const q = queryParams(req, ['offset', 'limit', 'beneficiary']);
      const numeric = (key: string, fallback: number, max: number) => {
        const v = q.get(key);
        if (v === undefined) return fallback;
        if (!/^\d{1,7}$/.test(v) || Number(v) > max) throw new HttpError(400, 'invalid pagination');
        return Number(v);
      };
      const offset = numeric('offset', 0, 1000000), limit = numeric('limit', 50, 100);
      if (limit < 1) throw new HttpError(400, 'invalid pagination');
      const beneficiary = q.get('beneficiary');
      if (beneficiary && !['alex', 'casey', 'joint', 'unknown'].includes(beneficiary)) throw new HttpError(400, 'invalid beneficiary');
      res.json(listAmazonOrders(repo.internalGetDb(), offset, limit, beneficiary));
    } catch (error) { next(error); }
  });
  /**
   * What the orders' items cost over a window, by Amazon's order date: Amazon's own measure, never card spending.
   * `window` is 30D (default), 60D, YTD, 1Y or 2Y; `today` (YYYY-MM-DD, default the server's date) is its last day.
   */
  router.get('/amazon/spending', (req, res, next) => {
    try {
      scanQuery(req, ['window', 'today']);
      const q = queryParams(req, ['window', 'today']);
      const window = q.get('window') ?? '30D';
      if (!isAmazonSpendingWindow(window)) throw new HttpError(400, 'invalid window');
      const today = q.get('today') ?? localDate(new Date());
      if (!isAmazonSpendingDay(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
      res.json(amazonSpending(repo.internalGetDb(), window, today));
    } catch (error) { next(error); }
  });
  /**
   * The same window's items by what they are (the Amazon item taxonomy): each top level, subcategory and item, with
   * its purchases; unassigned items under Needs review. Same `window` and `today` as /amazon/spending.
   */
  router.get('/amazon/spending/taxonomy', (req, res, next) => {
    try {
      scanQuery(req, ['window', 'today']);
      const q = queryParams(req, ['window', 'today']);
      const window = q.get('window') ?? '30D';
      if (!isAmazonSpendingWindow(window)) throw new HttpError(400, 'invalid window');
      const today = q.get('today') ?? localDate(new Date());
      if (!isAmazonSpendingDay(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
      res.json(amazonTaxonomySpending(repo.internalGetDb(), window, today));
    } catch (error) { next(error); }
  });
  /**
   * Amazon Fresh over a window, by Amazon's order date: the Fresh orders whose Item List was imported, what their lines
   * cost by grocery subcategory and by product, with refunds taken off, and each order's summary. Amazon's own measure,
   * never card spending. `captured: false` until the gated Fresh import ever ran. Same `window` and `today` as
   * /amazon/spending.
   */
  router.get('/amazon/fresh', (req, res, next) => {
    try {
      scanQuery(req, ['window', 'today']);
      const q = queryParams(req, ['window', 'today']);
      const window = q.get('window') ?? '30D';
      if (!isAmazonSpendingWindow(window)) throw new HttpError(400, 'invalid window');
      const today = q.get('today') ?? localDate(new Date());
      if (!isAmazonSpendingDay(today)) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
      res.json(amazonFresh(repo.internalGetDb(), window, today));
    } catch (error) { next(error); }
  });
  /** One Fresh order's active Item List, every readable line as it showed it. 404 for anything but a Fresh order's ref. */
  router.get('/amazon/fresh/orders/:ref', (req, res, next) => {
    try {
      scanQuery(req, []); queryParams(req, []);
      const order = ref(req.params.ref) ? amazonFreshOrder(repo.internalGetDb(), req.params.ref) : null;
      if (!order) throw new HttpError(404, 'amazon fresh order not found');
      res.json({ order });
    } catch (error) { next(error); }
  });
  router.get('/amazon/orders/:ref', (req, res, next) => {
    try {
      scanQuery(req, []); queryParams(req, []);
      if (!ref(req.params.ref)) throw new HttpError(404, 'amazon order not found');
      const order = getAmazonOrder(repo.internalGetDb(), req.params.ref);
      if (!order) throw new HttpError(404, 'amazon order not found');
      res.json({ order });
    } catch (error) { next(error); }
  });
  // An item's cached product thumbnail, from this origin only: the operator's gated backfill stored it; nothing is
  // fetched here. 404 when no thumbnail is cached; the page then shows its placeholder.
  router.get('/amazon/items/:ref/image', (req, res, next) => {
    try {
      scanQuery(req, []); queryParams(req, []);
      const image = ref(req.params.ref) ? readAmazonItemImage(repo.internalGetDb(), req.params.ref) : null;
      if (!image) throw new HttpError(404, 'amazon item image not found');
      res.status(200).type(image.contentType).send(image.bytes);
    } catch (error) { next(error); }
  });
  return router;
}
