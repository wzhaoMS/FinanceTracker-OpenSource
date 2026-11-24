import type { CardOpeningMonthsResponse } from '@finance-tracker/shared';

import { api } from '../../../services/api';

/**
 * Typed calls for the owner's card opening months (`/spending/card-openings`). Paths are relative, on the page's own
 * origin, as every API call (services/api.ts); nothing here names a host.
 */

/** Every card with what Holdr knows of when its record starts, its prefilled month, and the month confirmed. */
export function fetchCardOpenings(): Promise<CardOpeningMonthsResponse> {
  return api<CardOpeningMonthsResponse>('/spending/card-openings');
}

/** Confirms each card's month, all or nothing; the answer is the screen again, with how many cards changed. */
export function confirmCardOpenings(
  cards: ReadonlyArray<{ cardAccountId: string; openingMonth: string }>,
): Promise<CardOpeningMonthsResponse & { changed: number }> {
  return api<CardOpeningMonthsResponse & { changed: number }>('/spending/card-openings', { method: 'PUT', body: { cards } });
}

/** Ends a card's confirmed month (kept in its history); the answer is the screen again. */
export function clearCardOpening(cardAccountId: string): Promise<CardOpeningMonthsResponse & { cleared: boolean }> {
  return api<CardOpeningMonthsResponse & { cleared: boolean }>(`/spending/card-openings/${encodeURIComponent(cardAccountId)}`, { method: 'DELETE' });
}
