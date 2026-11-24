import type { CardOwner, CardScheduleSourceKind } from '@finance-tracker/shared';

import { api } from '../../../services/api';

/**
 * Owed now (`GET /cash/owed`): each card's current balance as its issuer last showed it. Paths are relative, on the
 * page's own origin, as every API call (services/api.ts). Amounts are minor units: positive owed, negative a credit.
 */

/** One card's figures, each as the newest read that shows it; null where no read showed it. */
export interface OwedRead {
  /** Null when the newest reads of the balance disagree (`conflict`) or none showed one. */
  currentBalanceMinor: number | null;
  conflict: boolean;
  /** The balance's financial as-of (an instant or a date), and its household date. */
  asOf: string;
  asOfDate: string;
  sourceKind: CardScheduleSourceKind;
  statementBalanceMinor: number | null;
  statementClosingDate: string | null;
  remainingStatementMinor: number | null;
  paymentDueDate: string | null;
  minimumDueMinor: number | null;
}

export interface OwedCard {
  cardAccountId: string;
  issuer: string;
  owner: CardOwner;
  nickname: string | null;
  last4: string | null;
  last5: string | null;
  currency: string;
  status: 'active' | 'closed';
  /** Null: nothing read for this card yet. */
  read: OwedRead | null;
}

export interface OwedResponse {
  /** False until the operator installs the observations table: every card is listed, none read. */
  installed: boolean;
  asOf: string;
  /** The household (Eastern) date of the answer. */
  today: string;
  /** Every active card, and each closed card whose newest balance is not zero. */
  cards: OwedCard[];
  /** Reads stored but shown on no card (no single card matched, or held for another reason). */
  held: number;
}

export function fetchOwedNow(): Promise<OwedResponse> {
  return api<OwedResponse>('/cash/owed');
}
