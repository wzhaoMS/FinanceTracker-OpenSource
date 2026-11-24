/**
 * A one-time request from another page for what Card transactions opens with: a charge's details, over the month the
 * charge is in (the Gold page's "Open in Card transactions"). Card transactions reads it when it opens and lets it go
 * once shown; nothing is kept in the address or across a reload.
 */
export interface SpendingIntent {
  /** The card transaction to show in the drawer. */
  transactionId: string;
  /** Its month (YYYY-MM), so the list behind the drawer has it. */
  month: string;
}

let pending: SpendingIntent | null = null;

export function requestSpendingIntent(intent: SpendingIntent): void {
  pending = intent;
}

/** The request waiting, if any; read it while Card transactions opens (it may be read more than once until let go). */
export function peekSpendingIntent(): SpendingIntent | null {
  return pending;
}

/** Lets the request go once it is shown (only this one: a newer request stays). */
export function releaseSpendingIntent(intent: SpendingIntent): void {
  if (pending === intent) pending = null;
}
