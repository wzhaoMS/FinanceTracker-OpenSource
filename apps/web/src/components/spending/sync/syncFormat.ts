import type { CardAccount, CardSyncIssuer, CardSyncSource } from '@finance-tracker/shared';
import { cardOptionLabel, issuerLabel } from '../spendingFormat';
import type { Binding, BindingScope, HolderAlias, OwnerState, SetSummary } from './ownerApi';

/** Display helpers for the sync controls. Every label is plain text. */

export const SOURCE_LABELS: Record<CardSyncSource, string> = {
  'chase-api': 'Chase activity, read in the page',
  'amex-api-recent': 'Amex recent activity, observed on the page',
  'amex-api-rest': 'Amex transactions, read in the page',
  'citi-api': 'Citi activity, observed on the page',
  'wf-dom': 'Wells Fargo activity, read from the shown page',
};

/** Issuers whose capture needs the extension to watch the bank page's own responses (MAIN world, contract §5 and §18). */
export const MAIN_WORLD_ISSUERS: ReadonlySet<CardSyncIssuer> = new Set(['amex', 'citi']);

export const ALIAS_LABELS: Record<HolderAlias | 'unknown', string> = {
  alex: 'Alex',
  casey: 'Casey',
  joint: 'Joint',
  'member-a': 'Member A',
  unknown: 'Holder unknown',
};

export function scopeText(scope: Pick<BindingScope, 'kind' | 'scopeLabel' | 'holderAlias' | 'last4'>): string {
  if (scope.kind === 'unknown') return 'Holder unknown';
  const ending = scope.last4 ? ` ··${scope.last4}` : '';
  return `${scope.scopeLabel}${ending} (${ALIAS_LABELS[scope.holderAlias]})`;
}

/** The card a scope id names, across the connected cards; a scope Holdr does not list is the card account's file-import scope. */
export function scopeTextById(state: OwnerState | null, cardScopeId: string | null, scopeKind?: 'known' | 'unknown' | 'legacy'): string {
  if (scopeKind === 'legacy') return 'File import: no card recorded';
  if (!cardScopeId) return 'No card recorded';
  for (const binding of state?.bindings ?? []) {
    const scope = binding.scopes.find((item) => item.cardScopeId === cardScopeId);
    if (scope) return scopeText(scope);
  }
  return scopeKind === 'unknown' ? 'Holder unknown' : 'A card not listed under Connected cards';
}

export function bindingTitle(binding: Pick<Binding, 'bindingLabel' | 'issuer'>): string {
  return `${binding.bindingLabel} (${issuerLabel(binding.issuer)})`;
}

export function cardAccountText(accounts: readonly CardAccount[], cardAccountRef: string): string {
  const account = accounts.find((item) => item.id === cardAccountRef);
  return account ? cardOptionLabel(account) : 'Card account not loaded';
}

export function deviceText(state: OwnerState | null, deviceId: string): string {
  return state?.devices.find((device) => device.deviceId === deviceId)?.deviceLabel ?? 'A device no longer listed';
}

export function bindingById(state: OwnerState | null, bindingId: string | null): Binding | null {
  if (bindingId === null) return null;
  return state?.bindings.find((binding) => binding.bindingId === bindingId) ?? null;
}

/** A connected card Holdr no longer lists (it was disconnected and has dropped out of the state). */
export const NO_LONGER_LISTED = 'A connected card no longer listed';

/** What a review set is called: its connected card for a browser's capture, its card account for a file import's conflicts (X18). */
export function setTitle(
  set: Pick<SetSummary, 'sourceKind' | 'bindingId' | 'cardAccountRef'>,
  state: OwnerState | null,
  accounts: readonly CardAccount[],
): string {
  if (set.sourceKind === 'file') return `File import · ${cardAccountText(accounts, set.cardAccountRef)}`;
  const binding = bindingById(state, set.bindingId);
  return binding ? bindingTitle(binding) : NO_LONGER_LISTED;
}

/** The names of connected cards, by id, as lists of them say it; one disconnected meanwhile is said so. */
export function bindingLabels(state: OwnerState | null, bindingIds: readonly string[]): string {
  return bindingIds.map((id) => state?.bindings.find((item) => item.bindingId === id)?.bindingLabel ?? 'a disconnected card').join(', ');
}

/** "1.2 MB", "820 KB", "512 B". */
export function bytesText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The confirmation code grouped by four, as the extension popup shows it, whether Holdr sends it grouped or plain. */
export function fingerprintText(fingerprint: string): string {
  return (fingerprint.replace(/-/g, '').match(/.{1,4}/g) ?? []).join('-');
}
