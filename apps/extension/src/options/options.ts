/**
 * Settings: pairing, the "trust this private browser" opt-in, the global
 * pause, and per-issuer enable/disable. Enabling an issuer asks the browser
 * for that one site's permission from this click (a user gesture), after the
 * user has confirmed the risk notes, and separately the in-page (MAIN)
 * observer where the issuer needs one. Disabling removes the permission.
 */
import { formatCardSyncPairingCode, parseCardSyncPairingCode } from '@finance-tracker/shared';
import { DEVICE_LABEL_PATTERN } from '../contracts/grammar.js';
import type { IssuerView, UiState } from '../contracts/uiState.js';
import { UI_ERROR_TEXT, command } from '../ui/client.js';
import { el } from '../ui/dom.js';

const app = document.getElementById('app') as HTMLElement;
let state: UiState | null = null;
let notice: { text: string; kind: 'bad' | 'good' } | null = null;
let busy = false;
const consent = new Map<string, { risk: boolean; main: boolean; shapeMain: boolean }>();
let codeInput = '';
let labelInput = '';

async function act(body: Parameters<typeof command>[0], success?: string): Promise<void> {
  busy = true;
  render();
  const reply = await command(body);
  busy = false;
  if (reply.state) state = reply.state;
  notice = reply.ok ? (success ? { text: success, kind: 'good' } : null) : { text: UI_ERROR_TEXT[reply.code] ?? 'Refused.', kind: 'bad' };
  render();
  if (missed) {
    missed = false;
    void refresh();
  }
}

/**
 * Stops in flight, each counted on its own: the kill switch, and each
 * issuer's disable. A stop never waits for, or is disabled by, another
 * command, and one issuer's pending disable never holds back the kill switch
 * or another issuer's stop.
 */
let switching = 0;
const disabling = new Map<string, number>();
let missed = false;

function count(adapterId: string | null, delta: number): void {
  if (adapterId === null) {
    switching += delta;
    return;
  }
  const next = (disabling.get(adapterId) ?? 0) + delta;
  if (next > 0) disabling.set(adapterId, next);
  else disabling.delete(adapterId);
}

/** A stop goes out at once, whatever else is in flight; its state comes from a fresh read afterwards. */
async function stopAct(adapterId: string | null, body: Parameters<typeof command>[0], success: string): Promise<void> {
  count(adapterId, 1);
  render();
  const reply = await command(body);
  count(adapterId, -1);
  notice = reply.ok ? { text: success, kind: 'good' } : { text: UI_ERROR_TEXT[reply.code] ?? 'Refused.', kind: 'bad' };
  // An answer to a command that was in flight is older than this stop: refresh again once it is in.
  if (busy) missed = true;
  await refresh();
}

async function refresh(): Promise<void> {
  const reply = await command({ command: 'get-state' });
  if (reply.state) state = reply.state;
  render();
}

function pairingSection(current: UiState): HTMLElement {
  const device = current.device;
  const canPair = device.status === 'unpaired' || device.status === 'revoked' || device.status === 'expired' || device.status === 'outdated';
  const code = parseCardSyncPairingCode(codeInput);
  const labelOk = DEVICE_LABEL_PATTERN.test(labelInput);
  return el(
    'section',
    { attrs: { 'data-testid': 'pairing' } },
    el('h2', { text: 'Pair this browser with Holdr' }),
    el('div', { className: 'muted', text: `Holdr address (fixed in this build): ${current.holdrOrigin}` }),
    device.status === 'outdated'
      ? el('div', { className: 'warn', attrs: { 'data-testid': 'pairing-outdated' }, text: 'The extension was updated, and Holdr accepts a credential only from the version it was paired with: pair this browser again.' })
      : null,
    canPair
      ? el(
          'div',
          { className: 'stack' },
          el('div', { text: 'In Holdr, open Spending → extension devices, create a pairing code, then type it here. Codes are single-use and expire after 5 minutes.' }),
          el(
            'div',
            { className: 'row' },
            el('label', { text: 'Pairing code', attrs: { for: 'pairing-code' } }),
            el('input', {
              attrs: { id: 'pairing-code', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '80', value: codeInput, 'data-testid': 'pairing-code', placeholder: 'abcd-efgh-…' },
              onInput: (event) => {
                codeInput = (event.target as HTMLInputElement).value;
              },
            }),
          ),
          el(
            'div',
            { className: 'row' },
            el('label', { text: 'Name for this browser', attrs: { for: 'device-label' } }),
            el('input', {
              attrs: { id: 'device-label', type: 'text', autocomplete: 'off', maxlength: '32', value: labelInput, 'data-testid': 'device-label', placeholder: 'e.g. Laptop Chrome' },
              onInput: (event) => {
                labelInput = (event.target as HTMLInputElement).value;
              },
            }),
          ),
          el('button', {
            className: 'primary',
            text: 'Pair',
            attrs: { 'data-testid': 'pair' },
            disabled: busy,
            onClick: () => {
              const normalized = parseCardSyncPairingCode(codeInput);
              if (!normalized || !DEVICE_LABEL_PATTERN.test(labelInput)) {
                notice = { text: 'Enter the 32-letter pairing code and a short name that starts with a letter (letters, digits, space, . _ -).', kind: 'bad' };
                render();
                return;
              }
              codeInput = '';
              void act({ command: 'pair', pairingCode: normalized, deviceLabel: labelInput }, 'Paired. Compare the confirmation code with Holdr, then approve this browser there.');
            },
          }),
          code === null && codeInput !== '' ? el('div', { className: 'muted', text: 'A pairing code is 32 letters a–p, usually shown as eight groups of four.' }) : null,
          !labelOk && labelInput !== '' ? el('div', { className: 'muted', text: 'Start with a letter; use up to 32 letters, digits, spaces, dots, dashes or underscores.' }) : null,
        )
      : el(
          'div',
          { className: 'stack' },
          el('div', { attrs: { 'data-testid': 'pairing-status' }, text: device.status === 'pending' ? 'Waiting for approval in Holdr. Compare this confirmation code with the one Holdr shows:' : `Paired as ${device.deviceLabel ?? ''}.` }),
          device.fingerprint ? el('div', { className: 'fingerprint', attrs: { 'data-testid': 'fingerprint' }, text: device.fingerprint }) : null,
          el(
            'div',
            { className: 'row' },
            el('button', { text: 'Check approval', attrs: { 'data-testid': 'check-approval' }, disabled: busy, onClick: () => void act({ command: 'refresh-device' }, 'Holdr approved this browser.') }),
            el('button', { className: 'danger', text: 'Forget this browser’s credential', disabled: busy, onClick: () => void act({ command: 'forget-device' }, 'The credential was removed from this browser.') }),
          ),
        ),
    el(
      'label',
      { className: 'row' },
      el('input', {
        attrs: { type: 'checkbox', 'data-testid': 'trust-browser' },
        checked: current.trustBrowser,
        disabled: busy || !current.storage.local,
        onChange: (event) => void act({ command: 'set-trust-browser', on: (event.target as HTMLInputElement).checked }),
      }),
      el('span', {
        text: current.storage.local
          ? 'Trust this private browser: keep the credential after the browser restarts (on disk, readable only by this extension). Only on a private OS account.'
          : 'Keeping the credential across restarts is unavailable: local storage could not be restricted to this extension.',
      }),
    ),
    el('div', { className: 'muted', text: `The credential is kept ${device.persisted ? 'on disk (trusted browser)' : 'in memory and is forgotten when the browser closes'}.` }),
  );
}

function issuerSection(current: UiState, issuer: IssuerView): HTMLElement {
  const choice = consent.get(issuer.adapterId) ?? { risk: false, main: false, shapeMain: false };
  consent.set(issuer.adapterId, choice);
  const needsMain = issuer.mode === 'main-passive';
  const modeText = issuer.mode === 'isolated-read' ? 'reads the site’s own activity API from the extension (isolated world)' : issuer.mode === 'main-passive' ? 'observes the page’s own responses in the page (MAIN world, passive)' : 'reads only the rows the page has rendered';
  const enable = async () => {
    // The permission prompt must come from this click.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [issuer.hostPermission] });
    } catch {
      granted = false;
    }
    if (!granted) {
      notice = { text: UI_ERROR_TEXT['permission-missing'], kind: 'bad' };
      render();
      return;
    }
    await act({ command: 'enable-issuer', adapterId: issuer.adapterId, riskAccepted: true, mainPassiveAccepted: needsMain ? choice.main : false }, `Enabled. Reload any open ${issuer.label} pages.`);
  };
  return el(
    'section',
    { attrs: { 'data-testid': `issuer-${issuer.adapterId}` } },
    el('h3', { text: issuer.label }),
    el('div', { className: 'muted', text: `How: ${modeText}. Site: ${issuer.hostPermission}` }),
    el('div', {
      attrs: { 'data-testid': `issuer-state-${issuer.adapterId}` },
      className: issuer.active ? 'good' : issuer.shapeChanged ? 'warn' : 'muted',
      text: issuer.active
        ? 'Enabled'
        : issuer.shapeChanged
          ? 'Paused: the site changed what it sends, and this release cannot read it safely. Use file import until a Holdr extension update supports it.'
          : issuer.enabled
            ? 'Enabled, but not running (permission or consent missing, or paused)'
            : 'Off',
    }),
    issuer.rateLimitedUntil ? el('div', { className: 'warn', text: `Paused after the site limited requests, until ${new Date(issuer.rateLimitedUntil).toLocaleTimeString()}.` }) : null,
    el('ul', {}, ...issuer.riskNotes.map((note) => el('li', { text: note }))),
    issuer.enabled
      ? el(
          'div',
          { className: 'row' },
          el('button', { className: 'danger', text: 'Disable and remove site access', attrs: { 'data-testid': `disable-${issuer.adapterId}` }, disabled: disabling.has(issuer.adapterId), onClick: () => void stopAct(issuer.adapterId, { command: 'disable-issuer', adapterId: issuer.adapterId }, 'Disabled. Open pages were told to stop.') }),
        )
      : el(
          'div',
          { className: 'stack' },
          el(
            'label',
            { className: 'row' },
            el('input', { attrs: { type: 'checkbox', 'data-testid': `risk-${issuer.adapterId}` }, checked: choice.risk, onChange: (event) => { choice.risk = (event.target as HTMLInputElement).checked; render(); } }),
            el('span', { text: 'I understand the risks above.' }),
          ),
          needsMain
            ? el(
                'label',
                { className: 'row' },
                el('input', { attrs: { type: 'checkbox', 'data-testid': `main-${issuer.adapterId}` }, checked: choice.main, onChange: (event) => { choice.main = (event.target as HTMLInputElement).checked; render(); } }),
                el('span', { text: 'I agree to the passive in-page (MAIN world) observer for this site.' }),
              )
            : null,
          el('button', {
            className: 'primary',
            text: 'Enable (asks the browser for this site only)',
            attrs: { 'data-testid': `enable-${issuer.adapterId}` },
            disabled: busy || issuer.shapeChanged || !choice.risk || (needsMain && !choice.main),
            onClick: () => void enable(),
          }),
        ),
    (issuer.enabled || issuer.shapeChanged) && issuer.shapeAvailable
      ? el(
          'div',
          { className: 'stack' },
          el('div', { className: 'muted', text: 'Shape capture (10 minutes): records only field names and value types of this site’s own responses, for building an adapter. Nothing is sent to Holdr. It uses a passive in-page (MAIN world) observer.' }),
          el(
            'label',
            { className: 'row' },
            el('input', { attrs: { type: 'checkbox', 'data-testid': `shape-consent-${issuer.adapterId}` }, checked: choice.shapeMain, onChange: (event) => { choice.shapeMain = (event.target as HTMLInputElement).checked; render(); } }),
            el('span', { text: 'I agree to the in-page observer for shape capture.' }),
          ),
          el('button', {
            text: 'Start shape capture',
            attrs: { 'data-testid': `shape-start-${issuer.adapterId}` },
            disabled: busy || !choice.shapeMain || current.paused,
            onClick: () => void act({ command: 'shape-start', adapterId: issuer.adapterId, mainPassiveAccepted: true }, 'Shape capture started. Reload the issuer page.'),
          }),
        )
      : null,
  );
}

function render(): void {
  if (!state) {
    app.replaceChildren(el('div', { className: 'muted', text: 'Loading…' }));
    return;
  }
  const current = state;
  app.replaceChildren(
    el(
      'section',
      {},
      el('h1', { text: current.target === 'test' ? 'Holdr card sync settings (test build: fake issuers only)' : 'Holdr card sync settings' }),
      el('div', { className: 'muted', text: `Version ${current.version}. Storage restricted to this extension: session ${current.storage.session ? 'yes' : 'NO'}, local ${current.storage.local ? 'yes' : 'NO'}.` }),
      notice ? el('div', { className: notice.kind, attrs: { 'data-testid': 'notice', role: 'status' }, text: notice.text }) : null,
      el(
        'div',
        { className: 'row' },
        current.paused
          ? el('button', { className: 'primary', text: 'Resume', disabled: switching > 0, onClick: () => void stopAct(null, { command: 'set-paused', on: false }, 'Resumed. Reload issuer pages to start again.') })
          : el('button', { className: 'danger', text: 'Pause everything', attrs: { 'data-testid': 'pause' }, disabled: switching > 0, onClick: () => void stopAct(null, { command: 'set-paused', on: true }, 'Paused. Nothing is read or sent.') }),
      ),
    ),
    pairingSection(current),
    el(
      'section',
      { attrs: { 'data-testid': 'issuers' } },
      el('h2', { text: 'Issuers' }),
      current.issuers.length === 0 ? el('div', { className: 'muted', text: 'No issuer adapter is included in this build yet.' }) : null,
      ...current.issuers.map((issuer) => issuerSection(current, issuer)),
    ),
  );
  if (codeInput !== '' && parseCardSyncPairingCode(codeInput)) {
    const input = document.getElementById('pairing-code') as HTMLInputElement | null;
    if (input) input.title = formatCardSyncPairingCode(parseCardSyncPairingCode(codeInput)!) ?? '';
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;
chrome.storage.onChanged.addListener(() => {
  if (busy) {
    missed = true;
    return;
  }
  if (pending !== null || document.activeElement instanceof HTMLInputElement) return;
  pending = setTimeout(() => {
    pending = null;
    void refresh();
  }, 150);
});

render();
void refresh();
