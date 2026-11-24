import { useMemo, useState } from 'react';
import { CARD_SYNC_SOURCE_SPECS, CARD_SYNC_SOURCES, cardSyncTextIssue, type CardAccount, type CardSyncIssuer, type CardSyncSource } from '@finance-tracker/shared';
import { cardOptionLabel } from '../spendingFormat';
import { ActionProblem, useActionStatus, useOwnerActions } from './OwnerActions';
import { HOLDER_ALIASES, type Binding, type HolderAlias, type ScopeDraft } from './ownerApi';
import { SyncDialog } from './SyncDialog';
import { ALIAS_LABELS, SOURCE_LABELS } from './syncFormat';
import { isActiveDevice } from './syncStatus';
import type { OwnerSync } from './useOwnerSync';

interface Props {
  sync: OwnerSync;
  accounts: readonly CardAccount[];
  /** null: a card to connect. */
  binding: Binding | null;
  onClose: () => void;
}

interface CardRow {
  key: string;
  cardScopeId: string | null;
  scopeLabel: string;
  holderAlias: HolderAlias | '';
  last4: string;
}

const SYNC_ISSUERS: ReadonlySet<string> = new Set(Object.values(CARD_SYNC_SOURCE_SPECS).map((spec) => spec.issuer));

/** Text as the contract stores it: trimmed, single spaces. */
function tidy(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Connect a card (a binding, in Holdr's API), or confirm a connected card's cards again (after a restore, or when a
 * card changed). The owner lists the cards the bank shows on the account:
 * who holds each and its last four. Holdr adds "Holder unknown" for rows the
 * extension can't place; a different card ending is a new card.
 */
export function BindingEditor({ sync, accounts, binding, onClose }: Props) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const client = sync.client!;
  const eligible = useMemo(() => accounts.filter((account) => account.status === 'active' && SYNC_ISSUERS.has(account.issuer) && account.currency === 'USD'), [accounts]);
  const [cardAccountRef, setCardAccountRef] = useState(binding?.cardAccountRef ?? '');
  const account = accounts.find((item) => item.id === cardAccountRef) ?? null;
  const sources = account ? CARD_SYNC_SOURCES.filter((source) => CARD_SYNC_SOURCE_SPECS[source].issuer === account.issuer) : [];
  const [source, setSource] = useState<CardSyncSource | ''>(binding?.source ?? '');
  const [label, setLabel] = useState(binding?.bindingLabel ?? '');
  const [rows, setRows] = useState<CardRow[]>(() => (binding
    ? binding.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active').map((scope) => ({
      key: scope.cardScopeId,
      cardScopeId: scope.cardScopeId,
      scopeLabel: scope.scopeLabel,
      holderAlias: scope.holderAlias === 'unknown' ? '' : scope.holderAlias,
      last4: scope.last4 ?? '',
    }))
    : [{ key: 'new-0', cardScopeId: null, scopeLabel: '', holderAlias: '', last4: '' }]));
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  // Q35: confirming again re-grants no browser unless it is ticked here; none is ticked by default.
  const now = sync.now();
  const holders = binding && sync.state
    ? sync.state.devices.filter((device) => isActiveDevice(device, now)
      && (device.bindingIds.includes(binding.bindingId) || device.staleBindingIds.includes(binding.bindingId)))
    : [];
  const [regrant, setRegrant] = useState<Set<string>>(new Set());

  const removed = binding ? binding.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active' && !rows.some((row) => row.cardScopeId === scope.cardScopeId)) : [];
  const update = (key: string, change: Partial<CardRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const validate = (): { label: string; scopes: ScopeDraft[] } | null => {
    const bindingLabel = tidy(label);
    if (!bindingLabel || cardSyncTextIssue(bindingLabel, 64) !== null) {
      setProblem('Give it a short plain name, without card or account numbers (up to 64 characters).');
      return null;
    }
    if (rows.length === 0) {
      setProblem('List at least one card the bank shows on this account.');
      return null;
    }
    const scopes: ScopeDraft[] = [];
    for (const [index, row] of rows.entries()) {
      const scopeLabel = tidy(row.scopeLabel);
      if (!scopeLabel || cardSyncTextIssue(scopeLabel, 64) !== null) {
        setProblem(`Card ${index + 1}: give it a short plain name, without card numbers.`);
        return null;
      }
      if (!row.holderAlias) {
        setProblem(`Card ${index + 1}: choose who holds it.`);
        return null;
      }
      if (row.last4 && !/^[0-9]{4}$/.test(row.last4)) {
        setProblem(`Card ${index + 1}: the last four are exactly four digits, or leave it empty if the bank doesn't show them.`);
        return null;
      }
      scopes.push({ cardScopeId: row.cardScopeId, scopeLabel, holderAlias: row.holderAlias, last4: row.last4 || null });
    }
    setProblem(null);
    return { label: bindingLabel, scopes };
  };

  const submit = () => status.track(async () => {
    const valid = validate();
    if (!valid) return;
    if (binding) {
      const regrantDeviceIds = holders.map((device) => device.deviceId).filter((deviceId) => regrant.has(deviceId));
      await actions.run(() => client.confirmBinding(binding.bindingId, {
        expectedVersion: binding.bindingVersion, bindingLabel: valid.label, scopes: valid.scopes, regrantDeviceIds,
      }));
    } else {
      if (!account || !source) {
        setProblem('Choose the card account and the bank source.');
        return;
      }
      await actions.run(() => client.createBinding({
        issuer: account.issuer as CardSyncIssuer,
        source,
        cardAccountRef: account.id,
        bindingLabel: valid.label,
        scopes: valid.scopes.map(({ scopeLabel, holderAlias, last4 }) => ({ scopeLabel, holderAlias, last4 })),
      }));
    }
    await sync.refresh();
    onClose();
  });

  const title = binding ? (binding.status === 'needs-reconfirmation' ? `Confirm the cards of ${binding.bindingLabel} again` : `Cards of ${binding.bindingLabel}`) : 'Connect a card';
  return (
    <SyncDialog title={title} onClose={onClose} busy={status.busy} wide closeLabel="Close card setup">
      {binding?.statusReason === 'restored-from-backup' ? (
        <div className="sync-banner tone-warn" role="status">
          <strong>Holdr was restored from a backup.</strong>
          <span>Check each card against what the bank shows now, then confirm. Nothing syncs for this card until you do.</span>
        </div>
      ) : null}
      <form className="spending-detail-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {!binding ? (
          <>
            <label>
              Holdr card account
              <select value={cardAccountRef} onChange={(event) => { setCardAccountRef(event.target.value); setSource(''); }}>
                <option value="">Choose the card account…</option>
                {eligible.map((item) => <option key={item.id} value={item.id}>{cardOptionLabel(item)}</option>)}
              </select>
            </label>
            {eligible.length === 0 ? (
              <p className="spending-muted">No card account can sync yet: add one with an import first (Amex, Chase, Citi or Wells Fargo, in US dollars).</p>
            ) : null}
            <label>
              Bank source
              <select value={source} disabled={!account} onChange={(event) => setSource(event.target.value as CardSyncSource | '')}>
                <option value="">Choose…</option>
                {sources.map((item) => <option key={item} value={item}>{SOURCE_LABELS[item]}</option>)}
              </select>
            </label>
          </>
        ) : null}
        <label>
          Display name
          <input value={label} maxLength={64} placeholder="e.g. Chase Sapphire" onChange={(event) => setLabel(event.target.value)} />
        </label>
        <fieldset className="spending-choice sync-cards">
          <legend>Cards the bank shows on this account</legend>
          <p className="spending-muted">
            Only the holder&apos;s alias and the last four; never the card number. Rows the extension can&apos;t place go to &quot;Holder unknown&quot;,
            which Holdr adds itself, and are never put on the main card by themselves.
          </p>
          {rows.map((row, index) => (
            <div key={row.key} className="sync-card-row" data-card-row={index}>
              <label>
                Card name
                <input value={row.scopeLabel} maxLength={64} placeholder="e.g. Alex's card" onChange={(event) => update(row.key, { scopeLabel: event.target.value })} />
              </label>
              <label>
                Holder
                <select value={row.holderAlias} onChange={(event) => update(row.key, { holderAlias: event.target.value as HolderAlias | '' })}>
                  <option value="">Choose…</option>
                  {HOLDER_ALIASES.map((alias) => <option key={alias} value={alias}>{ALIAS_LABELS[alias]}</option>)}
                </select>
              </label>
              <label>
                Last four
                <input
                  value={row.last4}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="optional"
                  readOnly={row.cardScopeId !== null}
                  aria-describedby={row.cardScopeId !== null ? `${row.key}-fixed` : undefined}
                  onChange={(event) => update(row.key, { last4: event.target.value.replace(/\D/g, '').slice(0, 4) })}
                />
              </label>
              {row.cardScopeId !== null ? <span id={`${row.key}-fixed`} className="spending-muted">A card&apos;s ending never changes; a new card is added below.</span> : null}
              <button type="button" className="spending-button" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>
                Remove card {index + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="spending-button"
            onClick={() => setRows((current) => [...current, { key: `new-${current.length}-${Date.now()}`, cardScopeId: null, scopeLabel: '', holderAlias: '', last4: '' }])}
          >
            Add a card
          </button>
          {removed.length > 0 ? (
            <p className="sync-expiry warn">
              {removed.map((scope) => scope.scopeLabel).join(', ')} will be removed: nothing new arrives for it, and what it already brought stays.
            </p>
          ) : null}
        </fieldset>
        {holders.length > 0 ? (
          <fieldset className="spending-choice sync-regrant-form">
            <legend>Browsers that keep sending for this card</legend>
            <p className="spending-muted">
              Confirming saves a new version of these cards. A browser keeps sending for the card only if you tick it here; the others stop
              until you allow them again under Browsers. Automatic sending is turned off either way.
            </p>
            {holders.map((device) => (
              <label key={device.deviceId} className="spending-toggle">
                <input
                  type="checkbox"
                  checked={regrant.has(device.deviceId)}
                  onChange={(event) => {
                    const next = new Set(regrant);
                    if (event.target.checked) next.add(device.deviceId);
                    else next.delete(device.deviceId);
                    setRegrant(next);
                  }}
                />
                <span>{device.deviceLabel}{device.staleBindingIds.includes(binding!.bindingId) ? ' (not allowed since an earlier confirmation)' : ''}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="spending-toggle">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>I checked these cards against what the bank shows for this account.</span>
        </label>
        {problem ? <div className="spending-error" role="alert">{problem}</div> : null}
        <ActionProblem problem={status.problem} />
        <div className="spending-detail-actions">
          <button type="submit" className="spending-button primary" disabled={status.busy || !checked}>
            {binding ? 'Confirm these cards' : 'Connect this card'}
          </button>
          <button type="button" className="spending-button" disabled={status.busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </SyncDialog>
  );
}
