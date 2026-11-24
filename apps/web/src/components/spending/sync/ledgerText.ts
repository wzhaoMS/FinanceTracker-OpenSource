/**
 * Plain-text descriptions for a charge's sources and history (proposal §3.8): what each alias is, and what each event did,
 * by whom and why. Built from fixed codes and the values Holdr sent; never markup.
 */
import { cardSpendingRole, effectiveCardKind } from '@finance-tracker/shared';
import { formatRowAmount, kindLabel, longDate } from '../spendingFormat';
import type { EventValues, LedgerEvent, LedgerRow, OwnerState, RemovedReason, SourceIdentity, TxnValues } from './ownerApi';
import { deviceText, scopeTextById } from './syncFormat';
import { exactTime } from './syncStatus';

/** Owner API amounts are US dollars (contract 1). */
const money = (amountMinor: number) => formatRowAmount(amountMinor, 'USD');

const STATUS_TEXT: Record<TxnValues['status'], string> = { pending: 'pending', posted: 'posted', removed: 'removed' };

export const REMOVED_TEXT: Record<RemovedReason, string> = {
  dismissed: 'dismissed by you',
  cancelled: 'cancelled',
  'mistaken-import': 'removed as imported by mistake',
  superseded: 'merged into another charge as a duplicate',
  'settled-into': 'merged into the charge it settled into',
  legacy: 'removed by an earlier version of Holdr, which didn\'t record why',
};

/** "Oct 2, 2026 · $64.99 · posted · Alex's card ··3391 (Alex)". */
export function valuesText(values: TxnValues, state: OwnerState | null): string {
  return [longDate(values.transactionDate), money(values.amountMinor), STATUS_TEXT[values.status], scopeTextById(state, values.cardScopeId)].join(' · ');
}

/**
 * The confirmation for separating a merged charge (E2a `unmergeCardTransaction`): it returns to the status it had before the
 * merge, which Holdr's answer doesn't name (a pending charge that settled into its posted one comes back pending), and the
 * sources the merge moved go back to it. What it then does to spending depends on the kind Spending reads it as
 * (`effectiveCardKind`, `cardSpendingRole`): a card payment, or a charge that takes one back, is a transfer and an `other`
 * row isn't counted, posted or not; any other posted charge counts, a pending one not yet, and so does a row stored as a
 * card payment that names a fee, read as the import classifier kinds it (a fee for a payment, the adjustment that gives
 * the card's own fee back, or a merchant's fee and its refund). The owner API's values carry no owner category, so both
 * rules read the row here even where the owner filed it under a category of their own.
 */
export function separateText(merged: Pick<LedgerRow, 'values'>): string {
  const role = cardSpendingRole(effectiveCardKind(merged.values));
  const effect = role === 'spending'
    ? 'If it was posted, it counts in spending again next to the charge it was merged into; if it was pending, not until it posts.'
    : role === 'transfer'
      ? 'As a card payment it counts as a payment to the card, never as spending.'
      : 'Its kind isn\'t counted in spending, posted or not.';
  return `${longDate(merged.values.transactionDate)} · ${money(merged.values.amountMinor)} becomes a charge of its own again, as it `
    + `was before the merge (posted or pending), and the sources the merge moved go back to it. ${effect} Either way, check that `
    + 'these aren\'t the same transaction twice.';
}

const NAMESPACE_TEXT: Record<SourceIdentity['namespaceKind'], string> = {
  stable: 'The bank\'s lasting id for this charge',
  capture: 'A capture of this charge without a lasting id',
  'legacy-file': 'An offline file\'s key for this charge',
};

const CREATED_BY_TEXT: Record<SourceIdentity['createdBy'], string> = {
  migration: 'from an offline file imported before extension sync',
  file: 'from an offline file import',
  extension: 'from the extension',
  session: 'added by you',
};

/** What an alias is, and where it came from. */
export function identityText(identity: SourceIdentity, state: OwnerState | null): { title: string; detail: string } {
  const card = identity.scopeKind === 'legacy' ? 'no card recorded' : scopeTextById(state, identity.sourceScopeId, identity.scopeKind);
  const parts = [
    `${CREATED_BY_TEXT[identity.createdBy]}, first seen ${STATUS_TEXT[identity.firstSeenStatus]}`,
    card,
    `added ${exactTime(identity.createdAt)}`,
  ];
  if (identity.lastSeenAt) parts.push(`last seen ${exactTime(identity.lastSeenAt)}`);
  return { title: NAMESPACE_TEXT[identity.namespaceKind], detail: `${parts.join(' · ')}.` };
}

function eventTitle(event: LedgerEvent): string {
  switch (event.eventType) {
    case 'created':
      return event.to?.status === 'pending' ? 'Added as a pending charge' : 'Added as a posted charge';
    case 'promoted':
      return 'Became posted';
    case 'corrected':
      // A bank's or a file's correction comes through a review (via `file` or `extension`); only an operator's maintenance
      // correction, run on the owner's standing order, records a `corrected` event via `session` (card kind corrections).
      return event.via === 'session' ? 'Corrected by maintenance' : 'Took the bank\'s corrected values';
    case 'identity-linked':
      return 'A source was linked to it';
    case 'attributed':
      return 'Put on a card';
    case 'identity-repointed':
      // An alias that left this charge is the other charge's event, shown here without a revision of this one (§3.8).
      return event.revision === null ? 'A source moved from here to another charge' : 'A source moved here from another charge';
    case 'identity-detached':
      return 'A source was detached';
    case 'superseded':
      return 'Merged into another charge as a duplicate';
    case 'settled-into':
      return 'Merged into the charge it settled into';
    case 'removed':
      return event.reason === 'dismissed' ? 'Dismissed' : event.reason === 'cancelled' ? 'Cancelled' : 'Removed as imported by mistake';
    case 'restored':
      return 'Restored as a charge of its own';
    case 'reversed':
      return 'An earlier change was undone';
    case 'user-edited':
      return event.edited.length === 2 ? 'You changed the category and notes' : event.edited[0] === 'notes' ? 'You changed the notes' : 'You changed the category';
    default:
      return 'Changed';
  }
}

/** Who did it, and in what. */
function byText(event: LedgerEvent, state: OwnerState | null): string {
  if (event.actor === 'device') return `automatically, from ${event.deviceId ? deviceText(state, event.deviceId) : 'a browser'}`;
  if (event.actor === 'file-import') return 'by an offline file import';
  // The ledger has no operator actor, so the event names the owner; it was not the owner's own edit.
  if (event.eventType === 'corrected' && event.via === 'session') return 'as a maintenance correction, not an edit of yours';
  if (event.reason === 'maintenance') return 'by you, as a repair';
  if (event.reason === 'adjustment') return 'by you, changing a review decision';
  if (event.eventType === 'user-edited') return 'by you, in Spending';
  if (event.via === 'extension') return 'by you, reviewing what the extension sent';
  if (event.via === 'file') return 'by you, reviewing an offline file import';
  return 'by you';
}

/** The values an event changed, before → after; for a new charge, what it was added with. */
function changeText(event: LedgerEvent, state: OwnerState | null): string | null {
  const from = event.from;
  const to = event.to;
  if (!to) return null;
  if (!from) {
    const parts: string[] = [];
    if (to.transactionDate) parts.push(longDate(to.transactionDate));
    if (to.amountMinor !== null) parts.push(money(to.amountMinor));
    if (to.status) parts.push(STATUS_TEXT[to.status]);
    if (to.cardScopeId) parts.push(scopeTextById(state, to.cardScopeId));
    return parts.join(' · ') || null;
  }
  const changes: string[] = [];
  const pair = <K extends keyof EventValues>(key: K, show: (value: NonNullable<EventValues[K]>) => string, label = '') => {
    const before = from[key];
    const after = to[key];
    if (before === after) return;
    changes.push(`${label}${before === null ? 'none' : show(before as NonNullable<EventValues[K]>)} → ${after === null ? 'none' : show(after as NonNullable<EventValues[K]>)}`);
  };
  pair('status', (value) => STATUS_TEXT[value]);
  pair('amountMinor', (value) => money(value));
  pair('transactionDate', (value) => longDate(value), 'date ');
  pair('postedDate', (value) => longDate(value), 'posted ');
  pair('kind', (value) => kindLabel(value), 'kind ');
  pair('cardScopeId', (value) => scopeTextById(state, value), 'card ');
  return changes.length > 0 ? changes.join(', ') : null;
}

/** One line of a charge's history: what happened, and a detail line with who, when and what changed. */
export function eventText(event: LedgerEvent, state: OwnerState | null): { title: string; detail: string } {
  const change = changeText(event, state);
  return {
    title: eventTitle(event),
    detail: [`${exactTime(event.at)}, ${byText(event, state)}`, change].filter(Boolean).join(' · '),
  };
}
