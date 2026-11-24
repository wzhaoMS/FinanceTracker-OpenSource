import type {
  CardCategoryBasis,
  CardOwner,
  CardSpendingCoverageGaps,
  CardSpendingForecast,
  CardSpendingPatterns,
} from '@finance-tracker/shared';

import { api } from '../../../services/api';

/**
 * Typed calls for Spending's patterns and forecast. Paths are relative and stay on the page's own origin, like every
 * API call (services/api.ts), so they go through the web server's API proxy with the session cookie.
 */

export type SpendingForecastResponse = CardSpendingForecast & {
  basis: CardCategoryBasis;
  /** What keeps the view's months from being complete, by card id and date (cardSpendingCoverageGaps), from its first month. */
  coverage: { firstMonth: string | null; gaps: CardSpendingCoverageGaps };
};
export type SpendingPatternsResponse = CardSpendingPatterns & { basis: CardCategoryBasis };

export interface ForecastQuery {
  /** The viewer's calendar date: this month is in progress, the forecast is for the three months after it. */
  today: string;
  owner?: CardOwner;
  cardAccountId?: string;
  categoryBasis?: CardCategoryBasis;
}

function query(params: ForecastQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function fetchSpendingForecast(params: ForecastQuery): Promise<SpendingForecastResponse> {
  return api<SpendingForecastResponse>(`/spending/forecast${query(params)}`);
}

export function fetchSpendingPatterns(params: ForecastQuery): Promise<SpendingPatternsResponse> {
  return api<SpendingPatternsResponse>(`/spending/patterns${query(params)}`);
}
