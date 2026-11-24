import { useEffect, useState } from 'react';
import { formatCardSyncPairingCode } from '@finance-tracker/shared';
import { issuerLabel } from '../spendingFormat';
import { ActionProblem, useActionStatus, useOwnerActions } from './OwnerActions';
import type { OwnerState, Pairing } from './ownerApi';
import { SyncDialog } from './SyncDialog';
import { bindingLabels, bindingTitle, fingerprintText } from './syncFormat';
import { exactTime, relativeTime } from './syncStatus';
import type { OwnerSync } from './useOwnerSync';

interface Props {
  sync: OwnerSync;
  /** Pairing again to replace a device whose credential is ending: approving the new one revokes it. */
  replacesDeviceId: string | null;
  onClose: () => void;
}

function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Plan §6.1 steps 1–4 on Holdr's side: choose what the browser may send for,
 * create a single-use code (shown once, only here, never stored or put in an
 * address), wait for the extension to use it, then approve only if the popup
 * shows the same confirmation code and the same HTTPS address.
 */
export function PairingDialog({ sync, replacesDeviceId, onClose }: Props) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const state = sync.state as OwnerState;
  const client = sync.client!;
  const confirmed = state.bindings.filter((binding) => binding.status === 'confirmed');
  const replacing = replacesDeviceId ? state.devices.find((device) => device.deviceId === replacesDeviceId) ?? null : null;
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(replacing?.bindingIds ?? []));
  // The code lives only in this dialog's memory, and only until the extension uses it or it expires.
  const [code, setCode] = useState<string | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const now = sync.now();
  const pairing = pairingId ? state.pairings.find((item) => item.pairingId === pairingId) ?? null : null;
  const waiting = pairing?.status === 'open';
  // E1b §5.3: Holdr pairs only for a bank turned on at least once, and no browser sends for a bank while it is off.
  const offIssuers = [...new Set(confirmed.filter((binding) => chosen.has(binding.bindingId)).map((binding) => binding.issuer))]
    .filter((issuer) => !state.settings.issuers.find((item) => item.issuer === issuer)?.enabled);

  useEffect(() => {
    sync.setFastPoll(waiting);
    return () => sync.setFastPoll(false);
  }, [sync, waiting]);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);
  useEffect(() => {
    if (pairing && pairing.status !== 'open') setCode(null);
  }, [pairing]);

  const create = () => status.track(async () => {
    const created = await actions.run(() => client.createPairing({ bindingIds: [...chosen], replacesDeviceId }));
    setCode(created.pairingCode);
    setPairingId(created.pairing.pairingId);
    await sync.refresh();
  });

  const close = () => {
    setCode(null);
    // An unused code is gone from the screen once this closes, so nobody should use it. A browser waiting for approval stays listed under Browsers.
    // Best effort: the refresh shows the pairing as it is, cancelled or not.
    if (pairing && pairing.status === 'open') {
      void client.cancelPairing(pairing.pairingId).finally(() => { void sync.refresh(); }).catch(() => {});
    }
    onClose();
  };

  const expired = pairing ? Date.parse(pairing.expiresAt) <= now || pairing.status === 'expired' : false;

  return (
    <SyncDialog title={replacing ? `Pair ${replacing.deviceLabel} again` : 'Pair a browser'} onClose={close} busy={status.busy} closeLabel="Close pairing">
      {!pairing ? (
        <>
          <p className="sync-text">
            Choose what this browser may send for. Nothing is chosen for you: a browser gets only the cards you tick.
          </p>
          {confirmed.length === 0 ? (
            <p className="sync-expiry warn">Confirm a connected card first, under Connected cards.</p>
          ) : (
            <fieldset className="spending-choice">
              <legend>Connected cards for this browser</legend>
              {confirmed.map((binding) => (
                <label key={binding.bindingId}>
                  <input
                    type="checkbox"
                    checked={chosen.has(binding.bindingId)}
                    onChange={(event) => setChosen((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(binding.bindingId);
                      else next.delete(binding.bindingId);
                      return next;
                    })}
                  />{' '}
                  {bindingTitle(binding)}
                </label>
              ))}
            </fieldset>
          )}
          {replacing ? <p className="spending-muted">Approving the new pairing revokes {replacing.deviceLabel}&apos;s old credential in the same step.</p> : null}
          {offIssuers.length > 0 ? (
            <p className="sync-expiry warn">
              {offIssuers.map((issuer) => issuerLabel(issuer)).join(', ')} {offIssuers.length === 1 ? 'is' : 'are'} off under Sync switches. Turn {offIssuers.length === 1 ? 'it' : 'them'} on
              there first: Holdr pairs a browser only for a bank turned on at least once, and no browser can send for a bank while it is off.
            </p>
          ) : null}
          <ActionProblem problem={status.problem} />
          <div className="spending-detail-actions">
            <button type="button" className="spending-button primary" disabled={status.busy || chosen.size === 0} onClick={() => { void create(); }}>
              Create a pairing code
            </button>
            <button type="button" className="spending-button" onClick={close}>Cancel</button>
          </div>
        </>
      ) : pairing.status === 'open' && code && !expired ? (
        <>
          <p className="sync-text">In the extension popup, set Holdr&apos;s address to exactly:</p>
          <p className="sync-address">{state.holdrOrigin}</p>
          <p className="sync-text">then type this code. It works once and expires in <span className="num" data-testid="pairing-countdown">{countdown(pairing.expiresAt, now)}</span>.</p>
          <dl className="sync-code-block">
            <dt>Pairing code</dt>
            <dd className="sync-code" data-testid="pairing-code">{formatCardSyncPairingCode(code)}</dd>
          </dl>
          <p className="spending-muted">
            Type it only into the extension popup. Don&apos;t paste it into chats, notes or a synced clipboard. Holdr keeps only a fingerprint of it, so
            this is the only time it is shown.
          </p>
          <p className="sync-text" role="status">Waiting for the extension…</p>
          <ActionProblem problem={status.problem} />
          <div className="spending-detail-actions">
            <button type="button" className="spending-button" onClick={() => { void sync.refresh(); }}>Check now</button>
            <button type="button" className="spending-button" onClick={close}>Cancel pairing</button>
          </div>
        </>
      ) : pairing.status === 'redeemed' ? (
        <PendingApproval sync={sync} pairing={pairing} />
      ) : pairing.status === 'approved' ? (
        <div className="sync-result" role="status">
          <strong>{pairing.deviceLabel} can now send for the chosen cards.</strong>
          <span>It still sends only what you confirm in its popup, and its credential ends after {state.limits.deviceDays} days.</span>
          <button type="button" className="spending-button primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <div className="sync-result" role="status">
          <strong>
            {expired || pairing.status === 'expired' ? 'This code expired before the extension used it.'
              : pairing.status === 'locked' ? 'This code was locked after too many wrong attempts.'
                : 'This pairing was closed.'}
          </strong>
          <span>Codes are never reused. Create a new one if you still want to pair.</span>
          <div className="spending-detail-actions">
            <button type="button" className="spending-button primary" onClick={() => { setPairingId(null); setCode(null); }}>Create a new code</button>
            <button type="button" className="spending-button" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </SyncDialog>
  );
}

/** A redeemed code: the owner compares the confirmation code with the popup, then approves or rejects. */
export function PendingApproval({ sync, pairing, onDone }: { sync: OwnerSync; pairing: Pairing; onDone?: () => void }) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const state = sync.state as OwnerState;
  const client = sync.client!;
  const [compared, setCompared] = useState(false);
  const now = sync.now();
  if (!pairing.deviceId || !pairing.fingerprint) return null;
  const deviceId = pairing.deviceId;
  const fingerprint = pairing.fingerprint;

  const approve = () => status.track(async () => {
    try {
      await actions.run(() => client.approvePairing(pairing.pairingId, { deviceId, fingerprint }));
    } finally {
      await sync.refresh();
    }
    onDone?.();
  });
  const reject = () => status.track(async () => {
    try {
      await client.rejectPairing(pairing.pairingId, deviceId);
    } finally {
      await sync.refresh();
    }
    onDone?.();
  });

  return (
    <div className="sync-approval" role="group" aria-label={`Approve ${pairing.deviceLabel ?? 'a browser'}`} data-pairing={pairing.pairingId}>
      <strong>{pairing.deviceLabel ?? 'A browser'} used the pairing code and waits for your approval.</strong>
      <p className="sync-text">Its popup must show this confirmation code, and the address {state.holdrOrigin}:</p>
      <dl className="sync-code-block">
        <dt>Confirmation code</dt>
        <dd className="sync-fingerprint" data-testid="confirmation-code">{fingerprintText(fingerprint)}</dd>
      </dl>
      <p className="spending-muted">
        {pairing.pendingExpiresAt ? `Approve by ${exactTime(pairing.pendingExpiresAt)} (${relativeTime(pairing.pendingExpiresAt, now)}). ` : ''}
        It will send only for: {bindingLabels(state, pairing.bindingIds)}.
      </p>
      <label className="spending-toggle">
        <input type="checkbox" checked={compared} onChange={(event) => setCompared(event.target.checked)} />
        <span>The popup shows exactly this confirmation code and this address</span>
      </label>
      <p className="spending-muted">If anything differs, reject it: someone else may have used the code.</p>
      <ActionProblem problem={status.problem} />
      <div className="spending-detail-actions">
        <button type="button" className="spending-button primary" disabled={status.busy || !compared} onClick={() => { void approve(); }}>Approve</button>
        <button type="button" className="spending-button danger" disabled={status.busy} onClick={() => { void reject(); }}>Reject</button>
      </div>
    </div>
  );
}
