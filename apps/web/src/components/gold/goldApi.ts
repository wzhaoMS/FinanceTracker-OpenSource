import type {
  MetalsContentRevoke,
  MetalsContentWrite,
  MetalsFunding,
  MetalsOverview,
  MetalsProductScope,
  MetalsProducts,
  MetalsPurchases,
  MetalsRead,
  MetalsSales,
  MetalsTimeline,
} from '@finance-tracker/shared/metals-api';
import type { Metal } from '@finance-tracker/shared/metals-ledger';

import { ApiError, api } from '../../services/api';
import type { GoldCloses } from './goldCloses';

export type { GoldCloses } from './goldCloses';

/**
 * The Gold page's reads and owner writes on the metals ledger's routes (design v8 §8, G3's contract in
 * `@finance-tracker/shared/metals-api`). Holdings are as of a date; activity, the chart and the lists are over a period
 * on their named date bases. Without the metals tables every read answers `installed: false`.
 */

export type {
  MetalsAssignmentMethod,
  MetalsCardLinkState,
  MetalsClassForm,
  MetalsClassUnits,
  MetalsCompletenessCode,
  MetalsCompletenessReason,
  MetalsContent,
  MetalsContentPreview,
  MetalsContentRevoke,
  MetalsContentWrite,
  MetalsCoverageEntry,
  MetalsDeliveryState,
  MetalsDepositLinkState,
  MetalsForInformation,
  MetalsFunding,
  MetalsFundingPurchase,
  MetalsHoldingClass,
  MetalsHoldingSource,
  MetalsLinkedAccount,
  MetalsAnswerLine,
  MetalsNeedsAnswer,
  MetalsMeasure,
  MetalsNeedsYou,
  MetalsNotInstalled,
  MetalsOverview,
  MetalsPriceUsed,
  MetalsProduct,
  MetalsProductDecision,
  MetalsProductScope,
  MetalsProducts,
  MetalsProfitCoverage,
  MetalsProfitEstimate,
  MetalsPurchase,
  MetalsPurchaseCard,
  MetalsPurchases,
  MetalsRead,
  MetalsSale,
  MetalsSaleCycle,
  MetalsSaleEstimate,
  MetalsSalePayout,
  MetalsSales,
  MetalsTimeline,
  MetalsTimelineMonth,
  MetalsTroyOz,
  MetalsUnmatchedPart,
  MetalsUnmatchedReason,
} from '@finance-tracker/shared/metals-api';
export type { Metal, MetalsContentHold, MetalsSource } from '@finance-tracker/shared/metals-ledger';

/** The period's dates: activity, chart and lists; holdings never change with them. */
export interface GoldPeriod {
  from: string | null;
  to: string;
}

const query = (entries: Array<[string, string | null | undefined]>) => {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value !== null && value !== undefined && value !== '') params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : '';
};

export function fetchMetalsOverview(metal: Metal, period: GoldPeriod): Promise<MetalsRead<MetalsOverview>> {
  return api(`/metals/overview${query([['metal', metal], ['from', period.from], ['to', period.to]])}`);
}

export function fetchMetalsPurchases(metal: Metal, period: GoldPeriod): Promise<MetalsRead<MetalsPurchases>> {
  return api(`/metals/purchases${query([['metal', metal], ['from', period.from], ['to', period.to]])}`);
}

export function fetchMetalsSales(metal: Metal, period: GoldPeriod): Promise<MetalsRead<MetalsSales>> {
  return api(`/metals/sales${query([['metal', metal], ['from', period.from], ['to', period.to]])}`);
}

export function fetchMetalsTimeline(metal: Metal, period: GoldPeriod): Promise<MetalsRead<MetalsTimeline>> {
  return api(`/metals/timeline${query([['metal', metal], ['fromMonth', period.from?.slice(0, 7)], ['toMonth', period.to.slice(0, 7)]])}`);
}

export function fetchMetalsProducts(metal: Metal): Promise<MetalsRead<MetalsProducts>> {
  return api(`/metals/products${query([['metal', metal]])}`);
}

/** P1's funding view, read here for the receipt block: which card charges receipts show as all precious metal. */
export function fetchMetalsFunding(period: GoldPeriod): Promise<MetalsRead<MetalsFunding>> {
  return api(`/metals/funding${query([['from', period.from], ['to', period.to]])}`);
}

/** `GET /metals/closes` (G3's read-only route): the admissible stored daily closes of a metal; it never fetches. */
export function fetchMetalsCloses(metal: Metal, period: GoldPeriod): Promise<MetalsRead<GoldCloses>> {
  return api(`/metals/closes${query([['metal', metal], ['from', period.from], ['to', period.to]])}`);
}

/** A product ref (`<source>:` and letters, digits, `_` or `-`) or a line key (letters and hyphens): path-safe as it is. */
const PATH_SAFE = /^[A-Za-z0-9_:-]{1,120}$/;

function pathSegment(value: string): string {
  if (!PATH_SAFE.test(value)) throw new Error('This product\'s reference can\'t be sent to Holdr');
  return value;
}

/**
 * The route of a row's content decision: product-wide, or for one line. Sent unescaped: Holdr's ingress refuses an
 * escaped ':' (%3A) before sign-in, and every ref and key is path-safe as it is.
 */
export function contentPath(scope: MetalsProductScope): string {
  return scope.kind === 'product' ? `/metals/products/${pathSegment(scope.ref)}/content` : `/metals/lots/${pathSegment(scope.lotKey)}/content`;
}

/**
 * Confirms what one ordered unit contains, within the row's scope. With `preview: null` nothing is written: the answer
 * is what the confirmation would change, and its digest; with that digest it is written, unless anything changed since
 * (409 `preview-stale`).
 */
export function confirmMetalsContent(
  scope: MetalsProductScope,
  input: { metal: Metal; troyOzPerUnit: string; preview: string | null },
): Promise<MetalsContentWrite> {
  const body = scope.kind === 'product'
    ? { fingerprint: scope.fingerprint, metal: input.metal, troyOzPerUnit: input.troyOzPerUnit, preview: input.preview }
    : { evidenceDigest: scope.evidenceDigest, metal: input.metal, troyOzPerUnit: input.troyOzPerUnit, preview: input.preview };
  return api(contentPath(scope), { method: 'POST', body });
}

/** Undoes the row's decision: without `preview` only what it would change; with its digest its lines are held again. */
export function revokeMetalsContent(scope: MetalsProductScope, decisionId: string, preview: string | null): Promise<MetalsContentRevoke> {
  return api(`${contentPath(scope)}${query([['decision', decisionId], ['preview', preview]])}`, { method: 'DELETE' });
}

/** A 409's reason (`preview-stale`, `not-installed`, `schema-conflict`), or null for any other failure. */
export function conflictReason(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  try {
    const body = JSON.parse(error.body) as { reason?: unknown };
    return typeof body.reason === 'string' ? body.reason : null;
  } catch {
    return null;
  }
}

/** Whether a read failed only because the API predates the metals routes (a 404). */
export const isMissingRoute = (error: unknown) => error instanceof ApiError && error.status === 404;

/** Whether a write was refused because its product, line or decision is no longer there (a 404). */
export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
export const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;
