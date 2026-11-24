import type { ReactNode } from 'react';
import { errorText, PAUSE_TEXT } from './syncText';
import { exactTime } from './syncStatus';
import type { OwnerSync } from './useOwnerSync';

function Banner({ tone, title, children }: { tone: 'info' | 'warn' | 'error' | 'mock'; title: string; children?: ReactNode }) {
  return (
    <div className={`sync-banner tone-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

/**
 * What applies to all of sync before anything else: Holdr without the owner
 * API, a failed load, the mock label, a restore, a closed gate, the
 * deployment switch and the server pause. Each says what still works and
 * what to do next. `onImport` opens Spending's file import (absent while
 * Spending can't write).
 */
export function SyncBanners({ sync, onResume, onImport }: { sync: OwnerSync; onResume?: () => void; onImport?: () => void }) {
  const { status, state, error, client } = sync;
  const banners: ReactNode[] = [];
  if (import.meta.env.DEV && client?.mode === 'mock') {
    banners.push(
      <Banner key="mock" tone="mock" title="Synthetic mock data (development only).">
        Nothing here is your Holdr: VITE_HOLDR_CARD_SYNC_MOCK is set in this development build.
      </Banner>,
    );
  }
  if (status === 'loading') {
    banners.push(<Banner key="loading" tone="info" title="Loading sync state…" />);
  } else if (status === 'unavailable') {
    banners.push(
      <Banner key="unavailable" tone="info" title="Not set up: this Holdr doesn't support extension sync yet.">
        Card spending from offline files keeps working
        {onImport ? <>: <button type="button" className="spending-link inline" onClick={onImport}>Import a statement</button></> : null}.
        {' '}Nothing is sent to or changed in Holdr from here. Extension sync needs a Holdr version that has it; then, in Extension &amp;
        devices, you turn the bank on, confirm which cards are on the card account, and pair and approve a browser.
      </Banner>,
    );
  } else if (status === 'error') {
    const text = errorText(error);
    banners.push(
      <Banner key="error" tone="error" title={`Couldn't load sync: ${text.message}`}>
        {text.next}{' '}
        <button type="button" className="spending-link inline" onClick={() => { void sync.refresh(); }}>Try again</button>
      </Banner>,
    );
  } else if (error) {
    const text = errorText(error);
    banners.push(
      <Banner key="stale" tone="warn" title={`Couldn't refresh: ${text.message}`}>
        What you see may be out of date. {text.next}{' '}
        <button type="button" className="spending-link inline" onClick={() => { void sync.refresh(); }}>Try again</button>
      </Banner>,
    );
  }
  if (state) {
    if (state.recoveredAt) {
      banners.push(
        <Banner key="recovered" tone="warn" title={`Holdr was restored from a backup on ${exactTime(state.recoveredAt)}.`}>
          Every browser was signed out, syncing was paused, and every issuer switch and automatic approval was cleared. Confirm each
          connected card again, turn its issuer on, resume syncing, then pair your browser again. Old credentials never work again.
        </Banner>,
      );
    }
    if (state.gate === 'blocked') banners.push(<Banner key="gate" tone="error" title="Device authorization is closed.">{PAUSE_TEXT['gate-blocked']}</Banner>);
    if (state.deviceApi === 'disabled') {
      banners.push(<Banner key="device-api" tone="info" title="Device uploads are off on this Holdr.">{PAUSE_TEXT['device-api-off']}</Banner>);
    }
    if (state.settings.paused) {
      banners.push(
        <Banner key="paused" tone="warn" title={`All syncing is paused${state.settings.pausedAt ? ` since ${exactTime(state.settings.pausedAt)}` : ''}.`}>
          No browser can upload, and no plan can be prepared or confirmed. Reviewing and discarding still work.
          {onResume ? <>{' '}<button type="button" className="spending-link inline" onClick={onResume}>Go to the switches</button></> : null}
        </Banner>,
      );
    }
    if (typeof window !== 'undefined' && window.location.origin !== state.holdrOrigin) {
      banners.push(
        <Banner key="origin" tone="info" title={`The extension pairs only with ${state.holdrOrigin}.`}>
          You&apos;re viewing Holdr at {window.location.origin}. Pairing still works from here, but the extension must be set to the address above, over HTTPS.
        </Banner>,
      );
    }
  }
  return banners.length > 0 ? <div className="sync-banners">{banners}</div> : null;
}
