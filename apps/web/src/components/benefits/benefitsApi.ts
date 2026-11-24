import type {
  BenefitMarkStatus,
  BenefitProductChoice,
  CardBenefitMark,
  CardBenefitSettings,
  CardBenefitsReport,
} from '@finance-tracker/shared';

import { api } from '../../services/api';

/**
 * Typed calls for the Benefits area. Relative paths on the page's own origin,
 * like every API call (services/api.ts), so they go through the web server's
 * API proxy with the session cookie and the X-Holdr-Request header.
 */

export function fetchBenefitsReport(year: number, today: string): Promise<CardBenefitsReport> {
  return api<CardBenefitsReport>(`/spending/benefits?${new URLSearchParams({ year: String(year), today })}`);
}

export interface BenefitSettingsChange {
  productChoice: BenefitProductChoice;
  /** For a manual choice only. */
  productId?: string;
  /** 1–12, null to clear; left out, it stays. */
  anniversaryMonth?: number | null;
}

export function saveBenefitSettings(cardAccountId: string, change: BenefitSettingsChange): Promise<CardBenefitSettings> {
  return api<{ settings: CardBenefitSettings }>(`/spending/benefits/cards/${encodeURIComponent(cardAccountId)}`, {
    method: 'PUT',
    body: change,
  }).then((body) => body.settings);
}

export interface BenefitMarkChange {
  cardAccountId: string;
  benefitId: string;
  periodStart: string;
  status: BenefitMarkStatus;
  /** For a partial mark: cents, or a count for count benefits. */
  usedMinor?: number;
}

export function saveBenefitMark(change: BenefitMarkChange): Promise<CardBenefitMark> {
  return api<{ mark: CardBenefitMark }>('/spending/benefits/marks', { method: 'PUT', body: change }).then((body) => body.mark);
}

export function clearBenefitMark(key: { cardAccountId: string; benefitId: string; periodStart: string }): Promise<void> {
  return api<void>(`/spending/benefits/marks?${new URLSearchParams(key)}`, { method: 'DELETE' });
}
