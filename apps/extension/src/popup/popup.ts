/**
 * The popup: the trusted place where the user maps what a bank page showed to
 * Holdr's billing account and cards, reviews the exact bytes that would be
 * sent, and sends, discards, plans or commits. The preview is read straight
 * from trusted session storage, its digest is recomputed here, and Send
 * carries that digest: the worker sends only if it matches the frozen bytes.
 */
import type { CardSyncPayloadV2 } from '@finance-tracker/shared';
import { frozenTextDigest } from '../common/digest.js';
import type { Binding, BindingScope, PlanCounts } from '../contracts/holdrApi.js';
import type { AccountSummary, GroupSummary, ScopeEntry } from '../contracts/messages.js';
import type { CaptureView, CollectorView, UiReply, UiState } from '../contracts/uiState.js';
import { COLLECTOR_CODE_TEXT, COLLECTOR_STATE_TEXT, UI_ERROR_TEXT, command } from '../ui/client.js';
import { el, formatMinor, formatRemaining, option, shortId } from '../ui/dom.js';

const app = document.getElementById('app') as HTMLElement;
let state: UiState | null = null;
let notice: { text: string; kind: 'bad' | 'good' } | null = null;
let busy = false;

interface Choice {
  bindingId: string;
  scopes: Map<string, string>;
}
const choices = new Map<string, Choice>();

interface PreviewData {
  captureId: string;
  digest: string;
  text: string;
  localDigest: string;
  payload: CardSyncPayloadV2 | null;
}
let preview: PreviewData | null = null;

function groupKey(group: Pick<GroupSummary, 'holderRef' | 'cardLast4'>): string {
  return `${group.holderRef ?? '-'} ${group.cardLast4 ?? '-'}`;
}

async function act(body: Parameters<typeof command>[0], success?: string): Promise<UiReply> {
  busy = true;
  render();
  const reply = await command(body);
  busy = false;
  if (reply.state) state = reply.state;
  notice = reply.ok ? (success ? { text: success, kind: 'good' } : null) : { text: UI_ERROR_TEXT[reply.code] ?? 'Refused.', kind: 'bad' };
  await loadPreview();
  render();
  if (missed) {
    missed = false;
    void refresh();
  }
  return reply;
}

/** Commands of the kill switch in flight; it never waits for (or is disabled by) another command. */
let switching = 0;

/**
 * The kill switch goes out at once, whatever else is in flight: stopping is
 * most needed while an upload, plan or commit waits or retries. Its state
 * comes from a fresh read afterwards, so an older command's answer cannot
 * show a stale pause state.
 */
async function killSwitch(on: boolean): Promise<void> {
  switching += 1;
  render();
  const reply = await command({ command: 'set-paused', on });
  switching -= 1;
  notice = reply.ok ? { text: on ? 'Paused. Nothing is read or sent.' : 'Resumed. Reload issuer pages to start again.', kind: 'good' } : { text: UI_ERROR_TEXT[reply.code] ?? 'Refused.', kind: 'bad' };
  if (busy) missed = true;
  await refresh();
}

async function refresh(): Promise<void> {
  const reply = await command({ command: 'get-state' });
  if (reply.state) state = reply.state;
  await loadPreview();
  render();
}

/** Close commands in flight: Close also stops a commit's further attempts, so it never waits for the command it stops. */
let closing = 0;

async function closeCapture(captureId: string): Promise<void> {
  closing += 1;
  render();
  const reply = await command({ command: 'discard', captureId });
  closing -= 1;
  notice = reply.ok ? null : { text: UI_ERROR_TEXT[reply.code] ?? 'Refused.', kind: 'bad' };
  if (busy) missed = true;
  await refresh();
}

/** Reads the frozen bytes from trusted session storage and recomputes their digest here. */
async function loadPreview(): Promise<void> {
  const capture = state?.capture;
  if (!capture || capture.stage !== 'preview' || !capture.digest) {
    preview = null;
    return;
  }
  if (preview && preview.captureId === capture.captureId && preview.digest === capture.digest) return;
  const stored = (await chrome.storage.session.get('capture')).capture as { captureId?: string; text?: string | null; digest?: string | null } | undefined;
  if (!stored || stored.captureId !== capture.captureId || typeof stored.text !== 'string' || stored.digest !== capture.digest) {
    preview = null;
    return;
  }
  let payload: CardSyncPayloadV2 | null = null;
  try {
    payload = JSON.parse(stored.text) as CardSyncPayloadV2;
  } catch {
    payload = null;
  }
  // The popup recomputes the digest of the very text it shows; a text that is not canonical JSON gets none and cannot be sent.
  preview = { captureId: capture.captureId, digest: capture.digest, text: stored.text, localDigest: frozenTextDigest(stored.text) ?? '', payload };
}

function scopeLabel(bindings: readonly Binding[], scopeId: string): string {
  for (const binding of bindings) {
    const scope = binding.scopes.find((item) => item.cardScopeId === scopeId);
    if (scope) return scope.last4 ? `${scope.scopeLabel} (…${scope.last4})` : scope.scopeLabel;
  }
  return shortId(scopeId);
}

/** A plan's tallies in words; zero tallies other than new, updated and unchanged are left out. */
function countsText(counts: PlanCounts): string {
  const parts = [`${counts.insert} new`, `${counts.update} updated`, `${counts.unchanged} unchanged`];
  const more: Array<[number, string]> = [
    [counts.aliased, 'already there (ids added)'],
    [counts.matched, 'matched'],
    [counts.attributed, 'attributed'],
    [counts.promoted, 'posted now'],
    [counts.corrected, 'corrected'],
    [counts.rejected, 'rejected'],
    [counts.unmatched, 'unmatched'],
    [counts.superseded, 'superseded'],
  ];
  for (const [count, label] of more) if (count > 0) parts.push(`${count} ${label}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function header(current: UiState): HTMLElement {
  return el(
    'section',
    {},
    el('h1', { text: current.target === 'test' ? 'Holdr card sync (test build: fake issuers only)' : 'Holdr card sync' }),
    el('div', { className: 'muted', text: `Sends only to ${current.holdrOrigin} · version ${current.version}` }),
    el(
      'div',
      { className: 'row' },
      current.paused
        ? el('button', { className: 'primary', text: 'Resume', attrs: { 'data-testid': 'resume' }, disabled: switching > 0, onClick: () => void killSwitch(false) })
        : el('button', { className: 'danger', text: 'Pause everything', attrs: { 'data-testid': 'pause' }, disabled: switching > 0, onClick: () => void killSwitch(true) }),
      el('button', { text: 'Settings', onClick: () => void chrome.runtime.openOptionsPage() }),
      el('button', { text: 'Open Holdr', onClick: () => void act({ command: 'open-holdr' }) }),
    ),
    current.paused ? el('div', { className: 'banner', attrs: { 'data-testid': 'paused-banner' }, text: 'Paused: nothing is read or sent until you resume.' }) : null,
    current.unreachableCollectors > 0
      ? el('div', { className: 'banner', text: `${current.unreachableCollectors} page(s) could not be told to stop. Close those issuer tabs or disable the extension to be sure.` })
      : null,
    notice ? el('div', { className: notice.kind, attrs: { 'data-testid': 'notice', role: 'status' }, text: notice.text }) : null,
  );
}

function deviceSection(current: UiState): HTMLElement {
  const device = current.device;
  const text: Record<UiState['device']['status'], string> = {
    unpaired: 'Not paired with Holdr. Pair this browser in Settings.',
    pending: 'Waiting for approval in Holdr.',
    active: `Paired as ${device.deviceLabel ?? 'this browser'}${device.deviceExpiresAt ? ` until ${device.deviceExpiresAt}` : ''}.`,
    revoked: 'Holdr no longer accepts this browser. Pair again in Settings.',
    expired: 'The pairing expired. Pair again in Settings.',
    outdated: 'The extension was updated: Holdr needs this browser paired again. Pair again in Settings.',
  };
  return el(
    'section',
    { attrs: { 'data-testid': 'device' } },
    el('h2', { text: 'Device' }),
    el('div', { className: device.status === 'active' ? 'good' : 'warn', attrs: { 'data-testid': 'device-status' }, text: text[device.status] }),
    device.status === 'pending' && device.fingerprint
      ? el('div', { className: 'row' }, el('span', { text: 'Confirmation code:' }), el('span', { className: 'fingerprint', text: device.fingerprint }))
      : null,
    device.status === 'pending' || device.status === 'active'
      ? el('button', { text: 'Check status with Holdr', attrs: { 'data-testid': 'refresh-device' }, disabled: busy, onClick: () => void act({ command: 'refresh-device' }) })
      : null,
    current.syncEnabled === false ? el('div', { className: 'warn', text: 'Holdr has card sync switched off for this device.' }) : null,
  );
}

function bindingOptions(current: UiState, view: CollectorView): Binding[] {
  const adapter = current.issuers.find((issuer) => issuer.adapterId === view.adapterId);
  return current.bindings.filter((binding) => binding.issuer === adapter?.issuer);
}

function accountBlock(current: UiState, view: CollectorView, account: AccountSummary): HTMLElement {
  const key = `${view.docRef} ${account.ref}`;
  const choice = choices.get(key) ?? { bindingId: '', scopes: new Map<string, string>() };
  choices.set(key, choice);
  const bindings = bindingOptions(current, view);
  const binding = bindings.find((item) => item.bindingId === choice.bindingId) ?? null;
  const groups: Array<Pick<GroupSummary, 'holderRef' | 'cardLast4'> & { label: string }> = account.groups.length > 0
    ? account.groups.map((group, index) => ({
        holderRef: group.holderRef,
        cardLast4: group.cardLast4,
        label: `Group ${index + 1}: ${group.cardLast4 ? `card …${group.cardLast4}` : 'no card digits'}${group.holderRef ? ', named cardholder on the bank page' : ''} · ${group.posted} posted, ${group.pending} pending · ${group.firstDate} to ${group.lastDate}`,
      }))
    : [{ holderRef: null, cardLast4: null, label: 'No rows yet: choose the Holdr card this read covers' }];

  const scopeSelect = (group: (typeof groups)[number], index: number, scopes: readonly BindingScope[]): HTMLSelectElement => {
    const select = el(
      'select',
      { attrs: { 'aria-label': `Holdr card for ${group.label}`, 'data-testid': `scope-${account.ref}-${index}-${group.cardLast4 ?? 'none'}` }, onChange: (event) => {
        const value = (event.target as HTMLSelectElement).value;
        if (value) choice.scopes.set(groupKey(group), value);
        else choice.scopes.delete(groupKey(group));
        render();
      } },
      option('', '— choose a Holdr card —'),
      ...scopes.map((scope) => option(scope.cardScopeId, scope.last4 ? `${scope.scopeLabel} (…${scope.last4})` : scope.scopeLabel, choice.scopes.get(groupKey(group)) === scope.cardScopeId)),
    );
    return select;
  };

  const complete = binding !== null && groups.every((group) => choice.scopes.has(groupKey(group)));
  const adapter = current.issuers.find((issuer) => issuer.adapterId === view.adapterId);
  const canRead = adapter?.mode === 'isolated-read';
  return el(
    'div',
    { className: 'stack', attrs: { 'data-testid': `account-${account.ref}` } },
    el('h3', { text: `Card …${account.last4 ?? '????'}${account.productHint ? ` · ${account.productHint}` : ''}` }),
    el('div', {
      className: 'muted',
      text: `${account.posted} posted · ${account.pending} pending · ${account.rejected} not readable · ${account.pageCount} page(s) · ${account.completeness ?? 'not read'}${account.termination ? ` (${account.termination})` : ''}`,
    }),
    canRead
      ? el('button', {
          text: 'Read recent activity',
          attrs: { 'data-testid': `read-${account.ref}` },
          // One read per issuer at a time: the page is still finding cards or reading.
          disabled: busy || current.paused || view.state === 'discovering' || view.state === 'reading',
          onClick: () => void act({ command: 'read', docRef: view.docRef, accountRef: account.ref }, 'Reading from the bank page…'),
        })
      : null,
    el(
      'div',
      { className: 'row' },
      el('label', { text: 'Holdr billing account:' }),
      el(
        'select',
        { attrs: { 'aria-label': 'Holdr billing account', 'data-testid': `binding-${account.ref}` }, onChange: (event) => {
          choice.bindingId = (event.target as HTMLSelectElement).value;
          choice.scopes.clear();
          render();
        } },
        option('', '— choose —'),
        ...bindings.map((item) => option(item.bindingId, item.bindingLabel, item.bindingId === choice.bindingId)),
      ),
    ),
    binding ? el('div', { className: 'stack' }, ...groups.map((group, index) => el('div', { className: 'row' }, el('span', { text: group.label }), scopeSelect(group, index, binding.scopes)))) : null,
    el('button', {
      className: 'primary',
      text: 'Prepare exact preview',
      attrs: { 'data-testid': `prepare-${account.ref}` },
      disabled: busy || !complete || current.paused || current.device.status !== 'active',
      onClick: () => {
        if (!binding) return;
        const scopes: ScopeEntry[] = groups.map((group) => ({ holderRef: group.holderRef, cardLast4: group.cardLast4, cardScopeId: choice.scopes.get(groupKey(group))! }));
        void act({ command: 'prepare', docRef: view.docRef, accountRef: account.ref, bindingId: binding.bindingId, scopes });
      },
    }),
  );
}

function pagesSection(current: UiState): HTMLElement {
  return el(
    'section',
    { attrs: { 'data-testid': 'pages' } },
    el('h2', { text: 'Bank pages' }),
    current.collectors.length === 0
      ? el('div', {
          className: 'muted',
          text: 'No enabled issuer page is open. If an activity page was already open when you enabled its issuer, reload it: Holdr never backfills a page it missed.',
        })
      : null,
    ...current.collectors.map((view) =>
      el(
        'div',
        { className: 'stack', attrs: { 'data-testid': `page-${view.adapterId}` } },
        el('h3', { text: view.label }),
        el('div', {
          className: view.state === 'error' ? 'warn' : 'muted',
          attrs: { 'data-testid': `page-state-${view.adapterId}` },
          text: `Page: ${view.pageState} · collector: ${COLLECTOR_STATE_TEXT[view.state]}${view.code ? ` · ${COLLECTOR_CODE_TEXT[view.code]}` : ''}`,
        }),
        view.issues.length > 0 ? el('div', { className: 'muted code', text: view.issues.map((issue) => `${issue.code} at ${issue.path}`).join('; ') }) : null,
        ...view.accounts.map((account) => accountBlock(current, view, account)),
      ),
    ),
  );
}

function previewTable(current: UiState, payload: CardSyncPayloadV2): HTMLElement {
  return el(
    'table',
    { attrs: { 'data-testid': 'preview-rows' } },
    el('thead', {}, el('tr', {}, ...['Date', 'Posted', 'Status', 'Amount', 'Kind', 'Description', 'Merchant', 'Card', 'Identity'].map((title) => el('th', { text: title })))),
    el(
      'tbody',
      {},
      ...payload.rows.map((row) =>
        el(
          'tr',
          {},
          el('td', { text: row.transactionDate }),
          el('td', { text: row.postedDate ?? '—' }),
          el('td', { text: row.status }),
          el('td', { className: 'num', text: formatMinor(row.amountMinor) }),
          el('td', { text: row.kind }),
          el('td', { text: row.description }),
          el('td', { text: row.merchant ?? '—' }),
          el('td', { text: scopeLabel(current.bindings, row.cardScopeId) }),
          el('td', { text: row.externalIdHash ? 'issuer id (hashed)' : 'this capture only' }),
        ),
      ),
    ),
  );
}

function coverageList(current: UiState, payload: CardSyncPayloadV2): HTMLElement {
  return el(
    'ul',
    { attrs: { 'data-testid': 'preview-coverage' } },
    ...payload.coverage.map((entry) =>
      el('li', {
        text: `${scopeLabel(current.bindings, entry.cardScopeId)} · ${entry.status}: ${entry.completeness} (${entry.termination}, ${entry.pageCount} page(s))`
          + `${entry.requested ? ` · asked ${entry.requested.start} to ${entry.requested.end}` : ''}`
          + `${entry.observed ? ` · saw ${entry.observed.start} to ${entry.observed.end} (${entry.observed.dateBasis})` : ' · no rows'}`,
      }),
    ),
  );
}

function captureSection(current: UiState, capture: CaptureView): HTMLElement {
  // Usable while another command of this popup runs (a commit retrying, say): it is how that commit is stopped.
  const close = el('button', { text: 'Close', attrs: { 'data-testid': 'close-capture' }, disabled: closing > 0, onClick: () => void closeCapture(capture.captureId) });
  const head = el('h2', { text: `Capture · ${capture.label} · ${capture.bindingLabel}` });
  const error = capture.error ? el('div', { className: 'bad', attrs: { 'data-testid': 'capture-error' }, text: UI_ERROR_TEXT[capture.error] }) : null;
  const issues = capture.issues.length > 0 ? el('div', { className: 'muted code', text: capture.issues.map((issue) => `${issue.code} at ${issue.path}`).join('; ') }) : null;
  const body: Array<HTMLElement | null> = [head, el('div', { className: 'muted', attrs: { 'data-testid': 'capture-stage' }, text: `Stage: ${capture.stage}` }), error, issues];

  switch (capture.stage) {
    case 'building':
      body.push(el('div', { text: 'The bank page is building the preview…' }));
      break;
    case 'preview': {
      const data = preview;
      if (!data || !data.payload) {
        body.push(el('div', { className: 'bad', text: 'The frozen preview could not be read; nothing will be sent. Discard and capture again.' }));
        body.push(el('button', { text: 'Discard', onClick: () => void act({ command: 'discard', captureId: capture.captureId }) }));
        break;
      }
      const verified = data.localDigest === capture.digest && data.digest === capture.digest;
      const payload = data.payload;
      const remaining = el('span', { attrs: { 'data-testid': 'preview-remaining' }, text: capture.expiresAt ? formatRemaining(capture.expiresAt - Date.now()) : '' });
      body.push(
        el('div', { className: 'row' }, el('span', { text: `Destination: ${current.holdrOrigin} (fixed at build time)` })),
        el('div', { className: 'row' }, el('span', { text: `Binding ${payload.bindingId} v${payload.bindingVersion} · source ${payload.source} · mode ${payload.mode} · capture ${payload.captureId}` })),
        el('div', { className: 'row' }, el('span', { text: 'Preview expires in' }), remaining),
        el('div', { text: `${payload.rows.length} rows (${capture.posted} posted, ${capture.pending} pending) · ${payload.rejectedCount} rows left out as unreadable · posted net ${formatMinor(payload.totals.posted.netMinor)} · pending net ${formatMinor(payload.totals.pending.netMinor)}` }),
        el('div', { className: 'muted', text: 'Each row sends only: transaction date, posted date, status, amount, kind, description, merchant, issuer category, hashed issuer id or capture fingerprint, Holdr card, identity namespace, original foreign amount. No names, account numbers, tokens, URLs or raw bank data.' }),
        previewTable(current, payload),
        el('h3', { text: 'Coverage' }),
        coverageList(current, payload),
        el('h3', { text: 'Exact JSON that will be sent' }),
        el('div', { className: 'muted code', attrs: { 'data-testid': 'preview-digest' }, text: `${capture.byteLength ?? 0} bytes · digest ${capture.digest ?? ''}` }),
        el('pre', { attrs: { 'data-testid': 'preview-json' }, text: data.text }),
        el('div', {
          className: 'muted',
          text: `Sent as POST /card-sync/observations with body {"payload": <exactly the bytes above>, "runId": <assigned by Holdr when you press Send>}, header Idempotency-Key ${capture.clientRunId}, and this browser’s device credential (never shown).`,
        }),
        verified
          ? null
          : el('div', { className: 'bad', text: 'The stored bytes do not match their digest; sending is disabled.' }),
        el(
          'div',
          { className: 'row' },
          el('button', {
            className: 'primary',
            text: 'Send observation to Holdr (kept for review for 30 days; not yet in your ledger)',
            attrs: { 'data-testid': 'send' },
            disabled: busy || !verified || current.paused,
            onClick: () => void act({ command: 'send', captureId: capture.captureId, digest: data.localDigest }, 'Holdr stored the observation for review.'),
          }),
          el('button', { text: 'Discard', attrs: { 'data-testid': 'discard' }, disabled: busy, onClick: () => void act({ command: 'discard', captureId: capture.captureId }, 'Discarded. Nothing was sent.') }),
        ),
      );
      break;
    }
    case 'sending':
      body.push(el('div', { text: 'Sending to Holdr…' }));
      break;
    case 'outcome-unknown':
      body.push(
        el('div', { className: 'warn', text: 'Holdr may or may not have stored this. Ask Holdr before doing anything else.' }),
        el(
          'div',
          { className: 'row' },
          el('button', { className: 'primary', text: 'Check with Holdr', attrs: { 'data-testid': 'check-receipt' }, disabled: busy, onClick: () => void act({ command: 'check-receipt', captureId: capture.captureId }) }),
          // Once Holdr said nothing arrived yet, the user may stop waiting.
          capture.error === 'upload-pending' ? close : null,
        ),
      );
      break;
    case 'accepted':
      body.push(
        el('div', {
          className: 'good',
          attrs: { 'data-testid': 'accepted' },
          text: `Holdr stored this observation for review (${capture.acceptance ?? 'accepted'}) until ${capture.acceptExpiresAt ?? 'its review period ends'}. It is not in your ledger yet.`,
        }),
        capture.ownerReview
          ? el('div', {
              className: 'warn',
              attrs: { 'data-testid': 'owner-review' },
              text: `Holdr needs your decision in Holdr: ${capture.ownerReview.reviewCount} item(s) to review (${countsText(capture.ownerReview.counts)}). There is nothing to commit from here; check with Holdr afterwards.`,
            })
          : null,
        el('div', { className: 'muted code', text: `Observation set ${capture.observationSetId ?? ''} · run ${capture.runId ?? ''} · digest ${capture.digest ?? ''}` }),
        el(
          'div',
          { className: 'row' },
          capture.ownerReview
            ? null
            : el('button', { className: 'primary', text: 'Prepare ledger plan', attrs: { 'data-testid': 'plan' }, disabled: busy, onClick: () => void act({ command: 'plan', captureId: capture.captureId }) }),
          el('button', { text: 'Check with Holdr', attrs: { 'data-testid': 'check-receipt' }, disabled: busy, onClick: () => void act({ command: 'check-receipt', captureId: capture.captureId }) }),
          close,
        ),
      );
      break;
    case 'planned':
      body.push(
        el('div', { attrs: { 'data-testid': 'plan-summary' }, text: capture.plan ? `Plan: ${countsText(capture.plan.counts)} · valid until ${capture.plan.expiresAt}` : 'Plan ready.' }),
        capture.committing
          ? el('div', { className: 'warn', attrs: { 'data-testid': 'committing' }, text: 'Committing to the ledger… Close stops further attempts; check with Holdr afterwards whether it landed.' })
          : capture.commitUncertain
            ? el('div', {
                className: 'warn',
                attrs: { 'data-testid': 'commit-pending' },
                text: `A commit of this plan may still reach Holdr: its answer never came. Check with Holdr, or commit again (the same plan commits at most once). Once the plan has expired (${capture.plan?.expiresAt ?? 'soon'}), a check settles it; until then this capture cannot be closed.`,
              })
            : null,
        el(
          'div',
          { className: 'row' },
          el('button', {
            className: 'primary',
            text: 'Commit to ledger',
            attrs: { 'data-testid': 'commit' },
            disabled: busy || capture.committing || !capture.previewId || !capture.planDigest,
            onClick: () => void act({ command: 'commit', captureId: capture.captureId, previewId: capture.previewId!, planDigest: capture.planDigest! }, 'Committed.'),
          }),
          el('button', { text: 'Check with Holdr', attrs: { 'data-testid': 'check-receipt' }, disabled: busy || capture.committing, onClick: () => void act({ command: 'check-receipt', captureId: capture.captureId }) }),
          // While a commit runs, Close stops it; once one may still land without an answer, Close waits for Holdr's.
          capture.commitUncertain && !capture.committing ? null : close,
        ),
      );
      break;
    case 'committed':
      body.push(el('div', { className: 'good', attrs: { 'data-testid': 'committed' }, text: `Committed to the ledger at ${capture.committedAt ?? ''}.` }), close);
      break;
    default:
      body.push(el('div', { className: 'muted', text: capture.stage === 'discarded' ? 'Discarded; nothing more will be sent.' : capture.stage === 'expired' ? 'Expired before sending; nothing was sent.' : 'This capture stopped.' }), close);
  }
  return el('section', { attrs: { 'data-testid': 'capture' } }, ...body);
}

function shapeSection(current: UiState): HTMLElement | null {
  const shape = current.shape;
  if (!shape) return null;
  const text = shape.reports
    .map((report) => [`${report.method} ${report.pathTemplate} (${report.contract})`, `query: ${report.queryKeys.join(', ') || '—'}`, `request headers: ${report.requestMetaNames.join(', ') || '—'}`, 'request body:', ...report.requestShape.map((entry) => `  ${entry.path}: ${entry.type}`), 'response:', ...report.responseShape.map((entry) => `  ${entry.path}: ${entry.type}`), report.truncated ? '(truncated)' : ''].join('\n'))
    .join('\n\n');
  return el(
    'section',
    { attrs: { 'data-testid': 'shape' } },
    el('h2', { text: `Shape capture · ${shape.label}` }),
    el('div', { className: 'muted', text: `Field names and types only, never values. Nothing is sent to Holdr. Ends in ${formatRemaining(shape.expiresAt - Date.now())}. Reload the issuer page so its own requests are observed.` }),
    el('pre', { attrs: { 'data-testid': 'shape-report' }, text: text || 'No matching responses observed yet.' }),
    el('button', { text: 'Stop shape capture', attrs: { 'data-testid': 'shape-stop' }, disabled: busy, onClick: () => void act({ command: 'shape-stop' }) }),
  );
}

function lastRunsSection(current: UiState): HTMLElement | null {
  if (current.lastRuns.length === 0) return null;
  return el(
    'section',
    { attrs: { 'data-testid': 'last-runs' } },
    el('h2', { text: 'Recent sends' }),
    el('ul', {}, ...current.lastRuns.slice(0, 5).map((run) => el('li', { text: `${run.at} · ${run.bindingLabel} · ${run.rows} rows · ${run.status}` }))),
  );
}

function render(): void {
  if (!state) {
    app.replaceChildren(el('div', { className: 'muted', text: 'Loading…' }));
    return;
  }
  const current = state;
  app.replaceChildren(
    header(current),
    deviceSection(current),
    ...(current.capture ? [captureSection(current, current.capture)] : []),
    ...(shapeSection(current) ? [shapeSection(current)!] : []),
    pagesSection(current),
    ...(lastRunsSection(current) ? [lastRunsSection(current)!] : []),
  );
}

let pending: ReturnType<typeof setTimeout> | null = null;
/** A storage change that arrived while a command was in flight: refresh once it has finished. */
let missed = false;
chrome.storage.onChanged.addListener(() => {
  if (busy) {
    missed = true;
    return;
  }
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    void refresh();
  }, 150);
});

setInterval(() => {
  const remaining = document.querySelector('[data-testid="preview-remaining"]');
  if (remaining && state?.capture?.expiresAt) remaining.textContent = formatRemaining(state.capture.expiresAt - Date.now());
}, 1_000);

render();
void refresh();
