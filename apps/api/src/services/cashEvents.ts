import { createHash } from 'node:crypto';
import type { CashEventType } from '@finance-tracker/shared';

import { parseSignedMoney, roundTo4, type ParsedActivity } from './activityParser.js';

export interface CashEventCandidate {
  date: string;
  eventType: CashEventType;
  amount: number;
  accountLast4: string;
  description: string;
}

export type CashEventParseResult =
  | { kind: 'not-cash-event' }
  | { kind: 'invalid-cash-event'; reason: string }
  | { kind: 'cash-event'; event: CashEventCandidate };

export function cashEventFromActivity(activity: ParsedActivity): CashEventParseResult {
  const eventType = cashEventType(activity);
  if (!eventType) return { kind: 'not-cash-event' };
  if (!activity.date) {
    return { kind: 'invalid-cash-event', reason: 'cash event date is invalid' };
  }
  if (!activity.accountLast4) {
    return { kind: 'invalid-cash-event', reason: 'cash event account last-four is missing' };
  }
  const amount = parseSignedMoney(activity.rawAmount);
  if (amount == null || !Number.isFinite(amount) || amount === 0) {
    return { kind: 'invalid-cash-event', reason: 'cash event amount must be a non-zero signed value' };
  }
  return {
    kind: 'cash-event',
    event: {
      date: activity.date,
      eventType,
      amount,
      accountLast4: activity.accountLast4,
      description: activity.rawDescription.trim(),
    },
  };
}

export function computeCashEventFingerprint(
  broker: string,
  event: CashEventCandidate,
  occurrence: number,
): string {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new Error('cash event occurrence must be a non-negative integer');
  }
  const fields = [
    broker.trim().toLowerCase(),
    event.date,
    event.accountLast4,
    event.eventType,
    roundTo4(event.amount).toFixed(4),
    normalizeDescription(event.description),
    occurrence.toString(),
  ];
  return createHash('sha256').update(fields.join('|')).digest('hex');
}

export function cashEventOccurrenceKey(broker: string, event: CashEventCandidate): string {
  return [
    broker.trim().toLowerCase(),
    event.date,
    event.accountLast4,
    event.eventType,
    roundTo4(event.amount).toFixed(4),
    normalizeDescription(event.description),
  ].join('|');
}

function cashEventType(activity: ParsedActivity): CashEventType | null {
  switch (activity.action) {
    case 'DIVIDEND':
      return 'dividend';
    case 'TRANSFER':
      return 'transfer';
    case 'CONTRIB':
    case 'ACH': {
      const amount = parseSignedMoney(activity.rawAmount);
      if (amount == null || amount === 0) return 'deposit';
      return amount > 0 ? 'deposit' : 'withdrawal';
    }
    default:
      return null;
  }
}

function normalizeDescription(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}