import { useId, useState } from 'react';
import type { CardAccount, CardSyncIssuer } from '@finance-tracker/shared';
import { issuerLabel } from '../spendingFormat';
import { ActionCancelled, ActionProblem, useActionStatus, useOwnerActions } from './OwnerActions';
import type { Binding, Device, OwnerState, Pairing } from './ownerApi';
import { BindingEditor } from './BindingEditor';
import { PairingDialog, PendingApproval } from './PairingDialog';
import { SyncBanners } from './SyncBanners';
import {
  ALIAS_LABELS, MAIN_WORLD_ISSUERS, SOURCE_LABELS, bindingLabels, bindingTitle, bytesText, cardAccountText, deviceText, plural, scopeText,
} from './syncFormat';
import { exactTime, expiryLevel, firstRunSteps, isActiveDevice, quotaLevel, relativeTime } from './syncStatus';
import { REVOKE_TEXT, STEP_TEXT } from './syncText';
import type { OwnerSync } from './useOwnerSync';
import './sync.css';

interface Props {
  sync: OwnerSync;
  accounts: readonly CardAccount[];
  /** Opens Spending's file import; absent while Spending can't write. */
  onImport?: () => void;
}

/** 「插件与设备」: first-run steps, the server's switches, connected cards, browsers, retention and quota. */
export function DevicesArea({ sync, accounts, onImport }: Props) {
  const { state } = sync;
  const [editing, setEditing] = useState<{ binding: Binding | null } | null>(null);
  const [pairing, setPairing] = useState<{ replacesDeviceId: string | null } | null>(null);
  return (
    <div className="sync-area">
      <SyncBanners sync={sync} onImport={onImport} />
      {state ? (
        <>
          <FirstRunSteps state={state} now={sync.now()} />
          <ServerSwitches sync={sync} />
          <BindingsPanel sync={sync} accounts={accounts} onEdit={(binding) => setEditing({ binding })} />
          <BrowsersPanel sync={sync} onPair={(replacesDeviceId) => setPairing({ replacesDeviceId })} />
          <RetentionPanel state={state} accounts={accounts} />
        </>
      ) : null}
      {editing ? (
        <BindingEditor sync={sync} accounts={accounts} binding={editing.binding} onClose={() => setEditing(null)} />
      ) : null}
      {pairing ? <PairingDialog sync={sync} replacesDeviceId={pairing.replacesDeviceId} onClose={() => setPairing(null)} /> : null}
    </div>
  );
}

function FirstRunSteps({ state, now }: { state: OwnerState; now: number }) {
  const steps = firstRunSteps(state, now);
  const setUp = steps.filter((step) => step.done !== null).slice(0, 2).every((step) => step.done);
  const [expanded, setExpanded] = useState(!setUp);
  return (
    <section className="spending-panel" aria-label="First run">
      <header className="spending-panel-head">
        <h3>First run</h3>
        <button type="button" className="spending-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide the steps' : setUp ? 'Set up: show the steps' : 'Show the steps'}
        </button>
      </header>
      {expanded ? (
        <ol className="sync-steps">
          {steps.map((step) => (
            <li key={step.id} className={step.done === true ? 'done' : step.done === null ? 'elsewhere' : ''} data-step={step.id}>
              <span className="sync-step-mark" aria-hidden>{step.done === true ? '✓' : step.done === null ? '·' : '○'}</span>
              <div>
                <strong>{STEP_TEXT[step.id].title}</strong>
                <span className="visually-hidden">{step.done === true ? ' (done)' : step.done === null ? ' (in the extension)' : ' (not yet)'}</span>
                <p className="spending-muted">{STEP_TEXT[step.id].detail}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function ServerSwitches({ sync }: { sync: OwnerSync }) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const state = sync.state as OwnerState;
  const [enabling, setEnabling] = useState<CardSyncIssuer | null>(null);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [mainAcknowledged, setMainAcknowledged] = useState(false);
  const settings = state.settings;
  const client = sync.client!;

  const run = (work: () => Promise<unknown>, success?: string) => status.track(async () => {
    try {
      await actions.run(work);
      return true;
    } finally {
      await sync.refresh();
    }
  }, success);

  const startEnable = (issuer: CardSyncIssuer) => {
    setEnabling(issuer);
    setRiskAcknowledged(false);
    setMainAcknowledged(false);
  };

  return (
    <section className="spending-panel" aria-label="Sync switches">
      <header className="spending-panel-head"><h3>Sync switches</h3></header>
      <div className="sync-switch">
        <div>
          <strong>{settings.paused ? 'All syncing is paused' : 'Syncing is on'}</strong>
          <ul className="sync-lines">
            <li>Pausing stops every browser&apos;s uploads and every plan at once, and needs no password.</li>
            <li>Reviewing and discarding still work.</li>
          </ul>
        </div>
        {settings.paused ? (
          <button type="button" className="spending-button primary" disabled={status.busy} onClick={() => { void run(() => client.resume(settings.settingsVersion), 'Syncing resumed.'); }}>
            Resume syncing
          </button>
        ) : (
          <button type="button" className="spending-button danger" disabled={status.busy} onClick={() => { void run(() => client.pause(), 'All syncing paused.'); }}>
            Pause all syncing
          </button>
        )}
      </div>
      <ul className="sync-list" aria-label="Issuers">
        {settings.issuers.map((item) => (
          <li key={item.issuer} className="sync-row" data-issuer={item.issuer}>
            <div className="sync-row-text">
              <strong>{issuerLabel(item.issuer)}: {item.enabled ? 'on' : 'off'}</strong>
              <span className="spending-muted">
                {item.enabled && item.enabledAt ? `On since ${exactTime(item.enabledAt)}. ` : ''}
                {MAIN_WORLD_ISSUERS.has(item.issuer)
                  ? 'Watches the bank page\'s own responses (MAIN world).'
                  : item.issuer === 'wellsfargo' ? 'Reads only the page as shown.' : 'Reads the activity inside the page.'}
              </span>
              {enabling === item.issuer ? (
                <div className="sync-consent">
                  <label className="spending-toggle">
                    <input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.target.checked)} />
                    <span>
                      I understand the extension works inside my signed-in bank session. That is not a read-only permission: a bad extension
                      version could act in the session. Only the reviewed, read-only code runs, and I can turn this off at any time.
                    </span>
                  </label>
                  {MAIN_WORLD_ISSUERS.has(item.issuer) ? (
                    <label className="spending-toggle">
                      <input type="checkbox" checked={mainAcknowledged} onChange={(event) => setMainAcknowledged(event.target.checked)} />
                      <span>
                        I understand {issuerLabel(item.issuer)} is read by watching the bank page&apos;s own responses, which a hostile page could forge.
                        The statement stays the final check.
                      </span>
                    </label>
                  ) : null}
                  <div className="spending-detail-actions">
                    <button
                      type="button"
                      className="spending-button primary"
                      disabled={status.busy || !riskAcknowledged || (MAIN_WORLD_ISSUERS.has(item.issuer) && !mainAcknowledged)}
                      onClick={() => {
                        void run(() => client.enableIssuer(item.issuer, { expectedVersion: settings.settingsVersion, mainWorldAcknowledged: mainAcknowledged }), `${issuerLabel(item.issuer)} is on.`)
                          .then((ok) => { if (ok) setEnabling(null); });
                      }}
                    >
                      Turn {issuerLabel(item.issuer)} on
                    </button>
                    <button type="button" className="spending-button" onClick={() => setEnabling(null)}>Cancel</button>
                  </div>
                </div>
              ) : null}
            </div>
            {item.enabled ? (
              <button type="button" className="spending-button" disabled={status.busy} onClick={() => { void run(() => client.disableIssuer(item.issuer), `${issuerLabel(item.issuer)} is off.`); }}>
                Turn off
              </button>
            ) : enabling !== item.issuer ? (
              <button type="button" className="spending-button" disabled={status.busy} onClick={() => startEnable(item.issuer)}>Turn on…</button>
            ) : null}
          </li>
        ))}
      </ul>
      <ActionProblem problem={status.problem} />
      {status.done ? <p className="sync-done" role="status">{status.done}</p> : null}
    </section>
  );
}

function BindingsPanel({ sync, accounts, onEdit }: { sync: OwnerSync; accounts: readonly CardAccount[]; onEdit: (binding: Binding | null) => void }) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const headingId = useId();
  const state = sync.state as OwnerState;
  const client = sync.client!;
  const bindings = state.bindings.filter((binding) => binding.status !== 'retired');

  const retire = (binding: Binding) => status.track(async () => {
    const ok = await actions.confirm({
      title: `Disconnect ${binding.bindingLabel}?`,
      body: 'Browsers stop sending for this card at once, and its imports awaiting review need a source check before use. Transactions already in spending stay.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) throw new ActionCancelled();
    try {
      await actions.run(() => client.retireBinding(binding.bindingId, binding.bindingVersion));
    } finally {
      await sync.refresh();
    }
  });

  const setAuto = (binding: Binding, enabled: boolean) => status.track(async () => {
    if (enabled) {
      const browsers = binding.autoSync.devices.filter((entry) => !entry.enabled).map((entry) => deviceText(state, entry.deviceId)).join(', ');
      const ok = await actions.confirm({
        title: `Send ${binding.bindingLabel} automatically?`,
        body: `This is permission given in advance, not a check each time: when the extension in ${browsers} reads this card, Holdr adds what has no `
          + 'conflict without asking. Anything ambiguous still waits for you. It covers only the browsers that send for this card now: a browser '
          + 'allowed later, or any change to the card\'s connection, asks again. You can turn it off at any time.',
        confirmLabel: 'Turn automatic sending on',
      });
      if (!ok) throw new ActionCancelled();
    }
    try {
      // "On" names the revision it was offered against, so it can't undo an "off" from another window (R1); "off" always wins.
      await actions.run(() => client.setAutoSync(binding.bindingId, {
        expectedVersion: binding.bindingVersion, expectedAutoSyncRevision: binding.autoSync.revision, enabled,
      }));
    } finally {
      await sync.refresh();
    }
  });

  return (
    <section className="spending-panel" aria-labelledby={headingId}>
      <header className="spending-panel-head">
        <h3 id={headingId}>Connected cards</h3>
        <button type="button" className="spending-button" onClick={() => onEdit(null)}>Connect a card…</button>
      </header>
      <ul className="sync-lines">
        <li>Each connected card links one bank source to a Holdr card account, with the cards the bank shows on it.</li>
        <li>The extension sends only for cards you confirmed here.</li>
      </ul>
      {bindings.length === 0 ? <p className="sync-text">No connected cards yet.</p> : (
        <ul className="sync-list">
          {bindings.map((binding) => (
            <li key={binding.bindingId} className={`sync-binding${binding.status === 'needs-reconfirmation' ? ' tone-warn' : ''}`} data-binding={binding.issuer}>
              <div className="sync-binding-head">
                <h4 className="sync-card-name">{bindingTitle(binding)}</h4>
                <span className="spending-muted">{SOURCE_LABELS[binding.source]} · {cardAccountText(accounts, binding.cardAccountRef)}</span>
              </div>
              {binding.status === 'needs-reconfirmation' ? (
                <p className="sync-expiry warn">
                  {binding.statusReason === 'restored-from-backup'
                    ? 'Holdr was restored from a backup: check these cards against the bank page and confirm them again before anything syncs.'
                    : 'Something about this card changed: confirm its cards again before anything syncs.'}
                </p>
              ) : (
                <p className="spending-muted">Confirmed {binding.confirmedAt ? exactTime(binding.confirmedAt) : ''} · version {binding.bindingVersion}</p>
              )}
              <ul className="sync-scopes">
                {binding.scopes.filter((scope) => scope.status === 'active').map((scope) => (
                  <li key={scope.cardScopeId}>{scopeText(scope)}</li>
                ))}
              </ul>
              <AutoSyncControls
                binding={binding}
                state={state}
                busy={status.busy}
                onSet={(enabled) => { void setAuto(binding, enabled); }}
              />
              <div className="spending-detail-actions">
                <button type="button" className={`spending-button${binding.status === 'needs-reconfirmation' ? ' primary' : ''}`} onClick={() => onEdit(binding)}>
                  {binding.status === 'needs-reconfirmation' ? 'Confirm cards again…' : 'Edit cards…'}
                </button>
                <button type="button" className="spending-button" disabled={status.busy} onClick={() => { void retire(binding); }}>Disconnect…</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ActionProblem problem={status.problem} />
    </section>
  );
}

/**
 * Automatic sending: one switch per connected card over consent kept on each browser's grant (Q28). "On" covers the browsers
 * that send for this card now; one allowed later starts without it and is offered separately. While Holdr keeps the
 * issuer's gate closed (until its E4–E7 checks pass), "on" is shown but unavailable, with the reason; "off" always works.
 * The consent stays in view: who it covers and since when is never folded away.
 */
function AutoSyncControls({ binding, state, busy, onSet }: {
  binding: Binding;
  state: OwnerState;
  busy: boolean;
  onSet: (enabled: boolean) => void;
}) {
  const reasonId = `auto-sync-${binding.bindingId}`;
  const entries = binding.autoSync.devices
    .map((entry) => ({ ...entry, device: state.devices.find((device) => device.deviceId === entry.deviceId) ?? null }))
    .filter((entry): entry is typeof entry & { device: Device } => entry.device !== null);
  const on = entries.filter((entry) => entry.enabled);
  const without = entries.filter((entry) => !entry.enabled);
  const labels = (list: typeof entries) => list.map((entry) => entry.device.deviceLabel).join(', ');
  const reason = binding.autoSync.gate === 'closed'
    ? `Not available yet: Holdr opens automatic sending for ${issuerLabel(binding.issuer)} only after that bank's own checks pass. Until then every send is by hand.`
    : !binding.autoSync.eligible ? 'Offered after one complete manual round (send, review, confirm).'
      : binding.status !== 'confirmed' ? 'Confirm its cards again first.'
        : entries.length === 0 ? 'No browser sends for this card now: pair one, or allow one again.'
          : null;
  return (
    <div className="sync-auto" role="group" aria-label={`Automatic sending for ${bindingTitle(binding)}`}>
      <p className="spending-muted" id={reasonId} data-testid="auto-sync-state">
        Automatic sending: {on.length > 0 ? `on for ${labels(on)}` : 'off'}.{reason ? ` ${reason}` : ''}
      </p>
      {on.length > 0 ? (
        <ul className="sync-auto-devices">
          {on.map((entry) => (
            <li key={entry.deviceId}>{entry.device.deviceLabel}: on since {entry.consentedAt ? exactTime(entry.consentedAt) : 'now'}</li>
          ))}
        </ul>
      ) : null}
      {on.length > 0 && without.length > 0 ? (
        <p className="spending-muted">
          {without.length === 1
            ? `${labels(without)} sends for this card but was allowed after you turned this on, so it doesn't send automatically.`
            : `${labels(without)} send for this card but were allowed after you turned this on, so they don't send automatically.`}
        </p>
      ) : null}
      <div className="spending-detail-actions">
        {on.length > 0 ? (
          <button type="button" className="spending-button" disabled={busy} onClick={() => onSet(false)}>Turn automatic sending off</button>
        ) : null}
        {reason === null && without.length > 0 ? (
          <button type="button" className="spending-button" disabled={busy} onClick={() => onSet(true)}>
            {on.length > 0 ? `Also send automatically from ${labels(without)}…` : 'Turn automatic sending on…'}
          </button>
        ) : on.length === 0 ? (
          <button type="button" className="spending-button" disabled aria-describedby={reasonId}>Turn automatic sending on…</button>
        ) : null}
      </div>
    </div>
  );
}

/** A browser revoked once its 30 days had run out: E1b keeps its expiry time as `revokedAt` (X34). */
function revokedAfterExpiry(device: Device): boolean {
  return device.status === 'revoked' && device.revokedAt !== null && device.deviceExpiresAt !== null
    && Date.parse(device.revokedAt) >= Date.parse(device.deviceExpiresAt);
}

function BrowsersPanel({ sync, onPair }: { sync: OwnerSync; onPair: (replacesDeviceId: string | null) => void }) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const state = sync.state as OwnerState;
  const now = sync.now();
  const client = sync.client!;
  const redeemed = state.pairings.filter((pairing) => pairing.status === 'redeemed');
  const devices = state.devices.filter((device) => device.status !== 'pending');

  const revoke = (device: Device) => status.track(async () => {
    // E1b §5.3: a browser whose 30 days ran out is refused already, but revoking it still holds what it sent for a source check.
    const ranOut = !isActiveDevice(device, now);
    const ok = await actions.confirm({
      title: `Revoke ${device.deviceLabel}?`,
      body: (ranOut
        ? `${device.deviceLabel}'s 30 days already ran out, so Holdr refuses it already. Revoking it also cancels its plans, and what it sent `
          + 'that isn\'t in spending yet waits for a source check, as when a browser is revoked in time. '
        : 'Holdr refuses this browser at once and cancels its plans; what it already sent waits for a source check. ')
        + 'Revoking only stops Holdr from accepting it: if you distrust the extension itself, also disable or remove it in the browser and check your '
        + 'bank activity.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) throw new ActionCancelled();
    try {
      await actions.run(() => client.revokeDevice(device.deviceId));
    } finally {
      await sync.refresh();
    }
  }, `${device.deviceLabel} is revoked.`);

  return (
    <section className="spending-panel" aria-label="Browsers">
      <header className="spending-panel-head">
        <h3>Browsers</h3>
        <button type="button" className="spending-button primary" onClick={() => onPair(null)}>Pair a browser…</button>
      </header>
      {redeemed.map((pairing: Pairing) => <PendingApproval key={pairing.pairingId} sync={sync} pairing={pairing} />)}
      {devices.length === 0 ? <p className="sync-text">No browser is paired.</p> : (
        <ul className="sync-list">
          {devices.map((device) => {
            const active = isActiveDevice(device, now);
            // Every approved browser not revoked yet, its 30 days run out included (E1b §5.3); one never approved never sent anything.
            const revocable = device.status !== 'revoked' && device.approvedAt !== null;
            const level = active && device.deviceExpiresAt ? expiryLevel(device.deviceExpiresAt, now) : null;
            const reason = device.revokeReason ? ` (${REVOKE_TEXT[device.revokeReason]})` : '';
            return (
              <li key={device.deviceId} className={`sync-row${active ? '' : ' inactive'}`} data-device={device.deviceId}>
                <div className="sync-row-text">
                  <strong>{device.deviceLabel}: {active ? 'active' : device.status === 'revoked' ? 'revoked' : 'expired'}</strong>
                  <span className="spending-muted">
                    {active && device.deviceExpiresAt ? `Works until ${exactTime(device.deviceExpiresAt)} (${relativeTime(device.deviceExpiresAt, now)}). ` : ''}
                    {device.lastSeenAt ? `Last seen ${relativeTime(device.lastSeenAt, now)}. ` : ''}
                    {device.revokedAt ? (revokedAfterExpiry(device)
                      // X34: it keeps the time it stopped working; the revocation came later.
                      ? `Its 30 days ran out ${exactTime(device.deviceExpiresAt as string)}; revoked afterwards${reason}. `
                      : `Revoked ${exactTime(device.revokedAt)}${reason}. `) : ''}
                    {device.status === 'expired' && device.approvedAt === null
                      ? `Never approved: the time to approve it ran out${device.pendingExpiresAt ? ` ${exactTime(device.pendingExpiresAt)}` : ''}. `
                      : device.status === 'expired' && device.deviceExpiresAt ? `Its 30 days ran out ${exactTime(device.deviceExpiresAt)}. ` : ''}
                    Sends for {plural(device.bindingIds.length, 'connected card')}{device.bindingIds.length > 0 ? `: ${bindingLabels(state, device.bindingIds)}` : ''}.
                  </span>
                  {level === 'week' || level === 'day' ? (
                    <span className="sync-expiry warn">Its credential ends {relativeTime(device.deviceExpiresAt!, now)} and is never extended: pair it again before then.</span>
                  ) : null}
                  {active ? <RegrantControls sync={sync} device={device} /> : null}
                </div>
                {revocable ? (
                  <div className="spending-detail-actions">
                    {level === 'week' || level === 'day' ? (
                      <button type="button" className="spending-button" onClick={() => onPair(device.deviceId)}>Pair again…</button>
                    ) : null}
                    <button type="button" className="spending-button danger" disabled={status.busy} onClick={() => { void revoke(device); }}>Revoke…</button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ActionProblem problem={status.problem} />
      {status.done ? <p className="sync-done" role="status">{status.done}</p> : null}
    </section>
  );
}

/**
 * Q35: a connected card confirmed again keeps no browser unless the owner ticked it; the others list it as stale. Allowing one
 * again is a new grant (password asked again), at the card's current version and without automatic-sending consent.
 */
function RegrantControls({ sync, device }: { sync: OwnerSync; device: Device }) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const state = sync.state as OwnerState;
  const client = sync.client!;
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const stale = device.staleBindingIds.map((bindingId) => ({ bindingId, binding: state.bindings.find((item) => item.bindingId === bindingId) ?? null }));
  const allowable = stale.filter((entry) => entry.binding?.status === 'confirmed');
  const names = bindingLabels(state, device.staleBindingIds);

  const allow = () => status.track(async () => {
    const bindingIds = allowable.map((entry) => entry.bindingId).filter((bindingId) => chosen.has(bindingId));
    try {
      await actions.run(() => client.regrantDevice(device.deviceId, bindingIds));
      setOpen(false);
      setChosen(new Set());
    } finally {
      await sync.refresh();
    }
  }, `${device.deviceLabel} may send again for the cards you chose.`);

  if (stale.length === 0) return status.done ? <p className="sync-done" role="status">{status.done}</p> : null;
  return (
    <div className="sync-regrant" data-testid="regrant">
      <span className="sync-expiry warn">
        Not allowed any more for: {names}. Those cards were confirmed again without this browser, so it can&apos;t send for them.
      </span>
      {!open ? (
        allowable.length > 0 ? (
          <button type="button" className="spending-button" onClick={() => setOpen(true)}>Allow again…</button>
        ) : null
      ) : (
        <fieldset className="sync-regrant-form">
          <legend>Allow {device.deviceLabel} to send again for</legend>
          {allowable.map(({ bindingId, binding }) => (
            <label key={bindingId} className="spending-toggle">
              <input
                type="checkbox"
                checked={chosen.has(bindingId)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(bindingId);
                  else next.delete(bindingId);
                  setChosen(next);
                }}
              />
              <span>{binding ? `${bindingTitle(binding)}, version ${binding.bindingVersion}` : ''}</span>
            </label>
          ))}
          <p className="spending-muted">Only allow a browser you still trust and use. Automatic sending stays off for it until you turn it on again.</p>
          <div className="spending-detail-actions">
            <button type="button" className="spending-button primary" disabled={status.busy || chosen.size === 0} onClick={() => { void allow(); }}>Allow</button>
            <button type="button" className="spending-button" disabled={status.busy} onClick={() => { setOpen(false); setChosen(new Set()); }}>Cancel</button>
          </div>
        </fieldset>
      )}
      <ActionProblem problem={status.problem} />
      {status.done ? <p className="sync-done" role="status">{status.done}</p> : null}
    </div>
  );
}

function RetentionPanel({ state, accounts }: { state: OwnerState; accounts: readonly CardAccount[] }) {
  const { limits, quota } = state;
  const headingId = useId();
  const bar = (label: string, usage: { used: number; limit: number }, format: (value: number) => string = String) => {
    const level = quotaLevel(usage);
    return (
      <div className={`sync-quota ${level}`} key={label}>
        <span>{label}: {format(usage.used)} of {format(usage.limit)}{level === 'full' ? ' (full)' : level === 'high' ? ' (nearly full)' : ''}</span>
        <span className="sync-quota-bar" aria-hidden><span style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100)}%` }} /></span>
      </div>
    );
  };
  const groups: Array<{ title: string; usage: OwnerState['quota']['global'] }> = [
    { title: 'All of Holdr', usage: quota.global },
    ...quota.cardAccounts.map((entry) => ({ title: cardAccountText(accounts, entry.cardAccountRef), usage: entry })),
    ...quota.devices.map((entry) => ({ title: `Browser ${state.devices.find((device) => device.deviceId === entry.deviceId)?.deviceLabel ?? ''}`, usage: entry })),
  ];
  const anyHigh = groups.some((group) => [group.usage.sets, group.usage.rows, group.usage.bytes].some((usage) => quotaLevel(usage) !== 'ok'));
  return (
    <section className="spending-panel" aria-labelledby={headingId}>
      <header className="spending-panel-head"><h3 id={headingId}>What Holdr keeps, and for how long</h3></header>
      <ul className="sync-retention">
        <li>Imports awaiting review: {limits.retentionDays} days from receipt (never more than {limits.maxRetentionDays}); opening or re-planning doesn&apos;t extend it.</li>
        <li>The exact object a browser sent: {limits.receiptDays} days.</li>
        <li>A plan you can confirm: {limits.planMinutes} minutes; after that, prepare a new one.</li>
        <li>A pairing code: {limits.pairingMinutes} minutes, single use. An unapproved browser: {limits.pendingDeviceMinutes} minutes.</li>
        <li>A browser&apos;s credential: {limits.deviceDays} days, never extended.</li>
      </ul>
      <h4 className="sync-subhead">Review queue space</h4>
      {anyHigh ? (
        <p className="sync-expiry warn">
          When the queue is full, Holdr refuses a whole upload rather than keep part of it. Review or discard imports awaiting review, or import the offline file.
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.title} className="sync-quota-group">
          <strong>{group.title}</strong>
          {bar('Imports', group.usage.sets)}
          {bar('Rows', group.usage.rows)}
          {bar('Size', group.usage.bytes, bytesText)}
        </div>
      ))}
      <p className="spending-muted">Holders on cards are shown by their alias ({Object.values(ALIAS_LABELS).join(', ')}); names never leave the bank page.</p>
    </section>
  );
}
