/**
 * The generic ISOLATED collector, one per approved issuer document
 * (top frame only). It:
 * - reports the page state to the worker and runs only what the worker
 *   configures: a discovery or a bounded read through `bankRead`
 *   (isolated-read), or watches the rendered page (dom-passive), or receives
 *   the MAIN observer's batches over the bridge (main-passive);
 * - validates every projected batch again here (layer 2 of 3), merges them in
 *   the stream store and reports only row-free summaries;
 * - builds the v2 payload after the user confirmed binding and scopes in the
 *   popup, and hands it to the worker, which validates it again (layer 3);
 * - stops for good on `collector-stop/v1`: aborts reads, drops rows, tells
 *   the MAIN observer to stop and says so in the panel.
 * It never reads extension storage, never talks to Holdr and never sees the
 * device credential.
 */
import { CARD_SYNC_READ_CONTRACTS, type CardSyncIssue, type ProjectedBankBatchV1 } from '@finance-tracker/shared';
import { newLocalId } from '../common/ids.js';
import { watchRouteChanges } from '../common/navigation.js';
import { BATCH_MESSAGE_LIMITS, parseStrictUnion } from '../common/strict.js';
import {
  BRIDGE_CHANNEL,
  BRIDGE_FROM_MAIN,
  WORKER_TO_COLLECTOR,
  statusRetryAfter,
  type AccountSummary,
  type BridgeFromIsolated,
  type CollectorCode,
  type CollectorConfig,
  type CollectorMessage,
  type CollectorReply,
  type CollectorState,
  type PageState,
} from '../contracts/messages.js';
import { buildPayload } from '../projection/buildPayload.js';
import { createStream } from '../projection/stream.js';
import { StreamStore } from '../projection/streamStore.js';
import { abortableSleep, createBankReader, isolatedFetch } from './bankRead.js';
import { createPanel, type Panel } from './panel.js';
import type { IsolatedAdapter } from './types.js';

const STATUS_TEXT: Readonly<Record<CollectorState, string>> = Object.freeze({
  waiting: 'Waiting for the activity page.',
  discovering: 'Finding cards on this page…',
  reading: 'Reading recent activity…',
  observing: 'Watching this page’s own activity responses.',
  ready: 'Ready: review it in the Holdr extension.',
  building: 'Preparing a preview in the extension…',
  stopped: 'Stopped. To be sure nothing else runs, close this tab or disable the extension.',
  error: 'Stopped this read.',
});

const CODE_TEXT: Partial<Record<CollectorCode, string>> = Object.freeze({
  'auth-required': 'The site asked you to sign in. Sign in yourself; Holdr never does.',
  'rate-limited': 'The site is limiting requests. Try again later from this page.',
  timeout: 'The site did not answer in time.',
  'read-cap': 'Read budget reached; coverage is partial.',
  'identity-conflict': 'The same transaction id came back with different details. Nothing will be sent from this page; reload it.',
  'unexpected-response': 'The site answered in an unexpected way. Nothing from that answer was kept.',
  'shape-changed': 'The site changed what it sends. This issuer is paused; use file import until a Holdr extension update supports it.',
  'too-large': 'A response was too large to read.',
  'answers-lost': 'More of the site’s answers came in while you were signing in than could be kept. Nothing will be sent from this page; reload it.',
  navigation: 'You moved to another page or account; earlier rows were dropped.',
});

function isOwnExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

/** At most this many MAIN batches wait for a new sign-in's activity view. */
const MAX_HELD_BATCHES = 8;

export function runCollector(adapter: IsolatedAdapter): void {
  const identity = adapter.identity;
  if (window.top !== window || location.origin !== identity.pageOrigin) return;

  const store = new StreamStore(identity.mode);
  const docStream = createStream();
  const nonce = newLocalId('nonce');
  const discoveryIsTransactions = CARD_SYNC_READ_CONTRACTS[identity.discoveryContract].produces === 'transactions';
  let seq = 0;
  let pageState: PageState = 'other';
  let state: CollectorState = 'waiting';
  let code: CollectorCode | null = null;
  let issues: CardSyncIssue[] = [];
  let run: AbortController | null = null;
  let watch: AbortController | null = null;
  let stopped = false;
  /** The site changed what it sends: latched for this document, nothing more is collected or built. */
  let drifted = false;
  let retryAfterMs: number | null = null;
  /** Capture id → the account and the store watermark its payload was built from (released after the freeze). */
  const built = new Map<string, { accountRef: string; through: number }>();
  let panel: Panel | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHref = `${location.pathname}${location.search}`;
  /** Route changes counted from the Navigation API (the MAIN observer counts the same); a MAIN batch counts only under the same number. */
  let routeChanges = 0;
  /** Sign-out resets told to the MAIN observer (it counts them too): a MAIN batch counts only under routeChanges + signOuts. */
  let signOuts = 0;
  /**
   * Signed out under this document: a read was refused as signed out
   * ('latched'), or the page showed its sign-in view ('sign-in-shown'). The
   * page then counts as signed out until it shows its activity view after its
   * sign-in view (a new sign-in), or navigates.
   */
  let signedOut: 'latched' | 'sign-in-shown' | null = null;
  /** MAIN batches of the current count that arrived while the page counted as signed out; taken once a new sign-in shows its activity. */
  const heldBatches: ProjectedBankBatchV1[] = [];
  /**
   * More MAIN answers arrived while the page counted as signed out than are
   * held (`MAX_HELD_BATCHES`). The observer has marked each answered page as
   * sent, so the one not held is gone for good, and what this page state
   * collects would have a hole that nothing shows. So nothing more is taken
   * or built under it, and the panel and the popup say to reload; a
   * navigation or a new sign-out (each starts a new stream in the observer
   * too) or a reload starts afresh.
   */
  let answersLost = false;
  /** Counts navigation resets; a read applies its outcome only within the generation it began in. */
  let navGeneration = 0;

  const send = (message: CollectorMessage): Promise<unknown> => chrome.runtime.sendMessage(message).catch(() => null);

  const summaries = (): AccountSummary[] => store.summaries();

  const renderPanel = (): void => {
    if (pageState !== 'activity' && state !== 'stopped' && pageState !== 'auth-required' && !drifted) {
      panel?.remove();
      panel = null;
      return;
    }
    panel ??= createPanel(document);
    const accounts = summaries();
    const codeText = code ? CODE_TEXT[code] : undefined;
    const status = pageState === 'auth-required' && state === 'waiting' ? CODE_TEXT['auth-required'] ?? STATUS_TEXT.waiting : STATUS_TEXT[state];
    panel.update({
      title: `Holdr · ${identity.label}`,
      status: codeText ? `${status} ${codeText}` : status,
      lines: accounts.map((account) => {
        const rejected = account.rejected > 0 ? `, ${account.rejected} not readable` : '';
        return `Card …${account.last4 ?? '????'}: ${account.posted} posted, ${account.pending} pending${rejected}`;
      }),
      partial: accounts.some((account) => account.completeness !== null && account.completeness !== 'complete'),
    });
  };

  const statusMessage = (): CollectorMessage => ({
    type: 'collector-status/v1',
    adapterId: identity.id,
    seq: seq++,
    streamHandle: docStream.streamHandle,
    pageState,
    state,
    code,
    accounts: summaries(),
    issues: issues.slice(0, 20),
    retryAfterMs: code === 'rate-limited' ? retryAfterMs : null,
  });

  /**
   * Ordinary progress is coalesced (50 ms). A code the worker must act on (a
   * changed form pauses the contract, a rate limit pauses the issuer, an
   * identity conflict blocks captures) goes out at once, as it is now, so a
   * later state change cannot overwrite it.
   */
  const sendStatus = (immediate = false): void => {
    renderPanel();
    if (immediate) {
      if (statusTimer !== null) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      void send(statusMessage());
      return;
    }
    if (statusTimer !== null) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      void send(statusMessage());
    }, 50);
  };

  const URGENT: ReadonlySet<CollectorCode> = new Set(['shape-changed', 'rate-limited', 'identity-conflict']);

  const setState = (next: CollectorState, nextCode: CollectorCode | null = null, nextIssues: CardSyncIssue[] = [], nextRetryAfterMs: number | null = null): void => {
    // After a changed form only the final stop may follow.
    if (drifted && next !== 'stopped') return;
    state = next;
    code = nextCode;
    issues = nextIssues;
    // A site may ask for any wait; the status carries at most a day (the worker never pauses an issuer longer).
    retryAfterMs = statusRetryAfter(nextRetryAfterMs);
    if (nextCode === 'shape-changed') {
      drifted = true;
      run?.abort();
      watch?.abort();
      watch = null;
      store.reset();
      built.clear();
    }
    sendStatus(nextCode !== null && URGENT.has(nextCode));
  };

  const sendReady = (): void => {
    void send({ type: 'collector-ready/v1', adapterId: identity.id, seq: seq++, role: 'collector', streamHandle: docStream.streamHandle, pageState });
    sendStatus();
  };

  const postBridge = (message: BridgeFromIsolated): void => {
    window.postMessage(message, location.origin);
  };

  const accept = (batch: ProjectedBankBatchV1): void => {
    if (drifted || answersLost) return;
    if (batch.issuer !== identity.issuer || (batch.contract !== identity.discoveryContract && batch.contract !== identity.transactionsContract)) {
      setState('error', 'bridge-refused');
      return;
    }
    const before = store.streamHandle;
    const result = store.accept(batch, batch.contract === identity.transactionsContract || discoveryIsTransactions);
    if (!result.ok) {
      if (result.code === 'stale-stream') return;
      setState('error', result.code, result.issues);
      return;
    }
    if (result.reset || (before !== null && before !== store.streamHandle)) {
      docStream.restart();
      built.clear();
    }
    if (state !== 'reading' && state !== 'discovering' && state !== 'building') setState(identity.mode === 'main-passive' ? 'observing' : 'ready');
    else sendStatus();
  };

  // --- Bridge from the MAIN observer -------------------------------------------------
  // The worker learns what runs here before anything else this page sends: the MAIN bridge below may deliver data
  // (and a status) before DOMContentLoaded, and the worker stops pages it does not track. The page state follows once
  // the DOM is there (evaluatePage sends ready again).
  void send({ type: 'collector-ready/v1', adapterId: identity.id, seq: seq++, role: 'collector', streamHandle: docStream.streamHandle, pageState });
  if (identity.usesMainObserver) {
    window.addEventListener('message', (event: MessageEvent) => {
      if (stopped || event.source !== window || event.origin !== location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null || (data as { channel?: unknown }).channel !== BRIDGE_CHANNEL) return;
      const kind = (data as { kind?: unknown }).kind;
      if (kind === 'hello' || kind === 'stop' || kind === 'reset') return;
      const parsed = parseStrictUnion(data, 'kind', BRIDGE_FROM_MAIN, { limits: BATCH_MESSAGE_LIMITS });
      if (!parsed.ok) {
        if (state !== 'error') setState(state, 'bridge-refused', parsed.issues);
        return;
      }
      const message = parsed.value;
      if (message.kind === 'main-ready') {
        if (message.adapterId === identity.id) postBridge({ channel: BRIDGE_CHANNEL, kind: 'hello', nonce });
        return;
      }
      if (message.nonce !== nonce) return;
      if (message.kind === 'batch') {
        // Made under another count (a route change or a sign-out since its request began): it answers a request of a
        // page state that is gone. After answers were lost, nothing more of this page state is taken.
        if (message.gen !== routeChanges + signOuts || answersLost) return;
        if (signedOut !== null) {
          // A new sign-in may show its activity before the poll looks: look now. Still signed out, the batch waits until
          // the activity shows. Its request began under the current count, which began when the sign-in view was seen
          // (a MAIN page signs out only that way: reads, the other way, run only on pages without a MAIN observer), so
          // it belongs to the new sign-in.
          if (computePageState() !== 'activity' || signedOut !== null) {
            if (heldBatches.length < MAX_HELD_BATCHES) heldBatches.push(message.batch);
            else loseAnswers();
            return;
          }
          evaluatePage();
        }
        accept(message.batch);
      } else if (message.kind === 'observer-status') {
        if (message.state === 'refused') {
          if (message.code === 'shape-changed') setState('error', 'shape-changed');
          else setState(state, message.code === 'response-too-large' ? 'too-large' : 'projection-refused');
        }
      } else if (message.kind === 'shape') {
        if (message.report.adapterId === identity.id) void send({ type: 'collector-shape/v1', adapterId: identity.id, seq: seq++, report: message.report });
      }
    });
    postBridge({ channel: BRIDGE_CHANNEL, kind: 'hello', nonce });
  }

  // --- Worker configuration ------------------------------------------------------------
  /**
   * A read belongs to the page it began on: a stop, a navigation or a
   * changed form aborts its controller, and then nothing it returns (a
   * partial result included) and no state it would report is applied.
   */
  const runRead = async (config: CollectorConfig, kind: 'discover' | 'read'): Promise<void> => {
    const budget = config.budget;
    // Reads belong to isolated-read pages (one mode per source), never to a page with a MAIN observer: a read refused as
    // signed out ('latched') so never meets MAIN batches held for a new sign-in.
    if (!budget || identity.mode !== 'isolated-read' || identity.usesMainObserver || !adapter.readContracts || (kind === 'discover' ? !adapter.discover : !adapter.readAccount)) {
      setState('error', 'bad-config');
      return;
    }
    const controller = new AbortController();
    const generation = navGeneration;
    const current = (): boolean => !stopped && !controller.signal.aborted && generation === navGeneration;
    run = controller;
    const io = {
      reader: createBankReader({ contracts: adapter.readContracts, budget, signal: controller.signal, fetchImpl: isolatedFetch, now: () => Date.now(), sleep: abortableSleep }),
      stream: docStream,
      budget,
      signal: controller.signal,
    };
    setState(kind === 'discover' ? 'discovering' : 'reading');
    try {
      if (kind === 'discover') {
        const outcome = await adapter.discover!(io);
        if (!current()) return;
        if (!outcome.ok && outcome.code === 'auth-required') resetForSignOut();
        else if (!outcome.ok) setState('error', outcome.code, [], outcome.retryAfterMs ?? null);
        else {
          accept(outcome.batch);
          setState('ready');
        }
      } else {
        if (!config.accountRef || !store.hasAccount(config.accountRef)) {
          setState('error', 'unknown-account');
          return;
        }
        const range = config.window ?? null;
        if (!range) {
          setState('error', 'bad-config');
          return;
        }
        const outcome = await adapter.readAccount!(io, config.accountRef, range);
        if (!current()) return;
        // Refused as signed out, also after earlier pages (a partial result): what was read under that sign-in goes with it.
        if (outcome.code === 'auth-required') resetForSignOut();
        else if (!outcome.ok) setState('error', outcome.code, [], outcome.retryAfterMs ?? null);
        else {
          accept(outcome.batch);
          setState('ready', outcome.code, [], outcome.retryAfterMs ?? null);
        }
      }
    } catch {
      if (current()) setState('error', 'read-failed');
    } finally {
      if (run === controller) run = null;
    }
  };

  const build = (config: CollectorConfig): CollectorReply => {
    if (!config.captureId || !config.accountRef || !config.bindingId || config.bindingVersion === null) return { ok: false, code: 'bad-config' };
    // A read in progress owns this page's state (and its issuer's read lease) until it ends.
    if (run) return { ok: false, code: 'busy' };
    // Answers of this page state were lost: what it holds has a hole (see `answersLost`).
    if (answersLost) return { ok: false, code: 'answers-lost' };
    // Only a page that shows its activity now (signed in, not navigated away) builds from what it holds.
    if (pageState !== 'activity' || signedOut !== null) return { ok: false, code: pageState === 'auth-required' || signedOut !== null ? 'auth-required' : 'navigation' };
    const result = buildPayload({
      store,
      accountRef: config.accountRef,
      captureId: config.captureId,
      bindingId: config.bindingId,
      bindingVersion: config.bindingVersion,
      scopes: config.scopes,
      confirmedScopes: config.confirmedScopes,
      cards: config.cards,
      issuer: identity.issuer,
      source: identity.source,
      mode: identity.mode,
      parserVersion: identity.parserVersion,
    });
    if (!result.ok) {
      setState('error', result.code, result.issues);
      return { ok: false, code: result.code };
    }
    // Only what this payload was built from is released once it is frozen; later batches stay for the next capture.
    built.set(config.captureId, { accountRef: config.accountRef, through: store.arrivalCount });
    if (built.size > 8) built.delete(built.keys().next().value as string);
    setState('building');
    void send({
      type: 'collector-batch/v1',
      adapterId: identity.id,
      seq: seq++,
      streamHandle: docStream.streamHandle,
      captureId: config.captureId,
      payload: result.payload,
    }).then(() => {
      // Only the build's own state is moved on: a navigation or a stop meanwhile keeps what it set.
      if (!stopped && state === 'building') setState(identity.mode === 'main-passive' ? 'observing' : 'ready');
    });
    return { ok: true, code: null };
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    run?.abort();
    watch?.abort();
    store.reset();
    built.clear();
    if (identity.usesMainObserver) postBridge({ channel: BRIDGE_CHANNEL, kind: 'stop', nonce });
    setState('stopped', 'stopped');
  };

  // Leaving the page (a navigation, or the back/forward cache) stops this collector for good: the worker forgets a
  // document that a newer one replaced, so a restored page must never resume collecting (a reload starts afresh).
  window.addEventListener('pagehide', stop);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isOwnExtensionSender(sender)) return;
    const parsed = parseStrictUnion(message, 'type', WORKER_TO_COLLECTOR);
    if (!parsed.ok) {
      sendResponse({ ok: false, code: 'bad-config' } satisfies CollectorReply);
      return;
    }
    const command = parsed.value;
    if (command.type === 'collector-stop/v1') {
      stop();
      sendResponse({ ok: true, code: null } satisfies CollectorReply);
      return;
    }
    if (stopped) {
      sendResponse({ ok: false, code: 'stopped' } satisfies CollectorReply);
      return;
    }
    if (drifted && command.action !== 'release') {
      sendResponse({ ok: false, code: 'shape-changed' } satisfies CollectorReply);
      return;
    }
    let reply: CollectorReply = { ok: true, code: null };
    switch (command.action) {
      case 'discover':
      case 'read':
        if (run) reply = { ok: false, code: 'busy' };
        else if (pageState !== 'activity') reply = { ok: false, code: 'navigation' };
        else void runRead(command, command.action);
        break;
      case 'build':
        reply = build(command);
        break;
      case 'release': {
        const mark = command.captureId ? built.get(command.captureId) : undefined;
        if (mark && command.captureId && mark.accountRef === command.accountRef) {
          store.release(mark.accountRef, mark.through);
          built.delete(command.captureId);
        }
        setState(state === 'building' ? (identity.mode === 'main-passive' ? 'observing' : 'ready') : state, state === 'building' ? null : code, issues);
        break;
      }
      default:
        reply = { ok: false, code: 'bad-config' };
    }
    sendResponse(reply);
  });

  // --- Page state, rendered DOM and navigation -------------------------------------------
  const startWatch = (): void => {
    if (!adapter.watch || watch || stopped || pageState !== 'activity') return;
    watch = new AbortController();
    adapter.watch({
      stream: docStream,
      signal: watch.signal,
      emit(result) {
        if (stopped) return;
        if (result.ok) accept(result.batch);
        else setState('error', 'projection-refused', result.issues);
      },
    });
  };

  /** The page's state as the adapter reads it, held at `auth-required` while signed out (see `signedOut`). */
  const computePageState = (): PageState => {
    const allowedPath = identity.pagePaths.some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));
    const shown: PageState = allowedPath ? adapter.pageState(document, location) : 'other';
    if (signedOut === null) return shown;
    if (shown === 'auth-required') signedOut = 'sign-in-shown';
    else if (shown === 'activity' && signedOut === 'sign-in-shown') signedOut = null;
    return signedOut !== null && shown === 'activity' ? 'auth-required' : shown;
  };

  const evaluatePage = (): void => {
    if (stopped) return;
    pageState = computePageState();
    sendReady();
    startWatch();
    // Signed in again: the MAIN batches its loading brought while the page still counted as signed out are taken now.
    if (signedOut === null && !answersLost && heldBatches.length > 0) for (const held of heldBatches.splice(0)) accept(held);
  };

  /** See `answersLost`: everything of this page state goes, held batches included, and the page says why. */
  const loseAnswers = (): void => {
    answersLost = true;
    heldBatches.length = 0;
    store.reset();
    built.clear();
    setState('error', 'answers-lost');
  };

  /**
   * Everything read under the page's earlier state goes: rows, account
   * handles, built captures and so the mappings made for them; a read
   * running then is aborted and its outcome never applied (plan §3.4).
   */
  const resetContext = (): void => {
    navGeneration += 1;
    heldBatches.length = 0;
    answersLost = false;
    run?.abort();
    run = null;
    watch?.abort();
    watch = null;
    store.reset();
    built.clear();
    docStream.restart();
  };

  /**
   * A navigation (an SPA route, an account switch, also one that brings no
   * new response because the page shows cached rows) drops everything of the
   * page left behind, in every mode.
   */
  const resetForNavigation = (): void => {
    lastHref = `${location.pathname}${location.search}`;
    signedOut = null;
    resetContext();
    if (!drifted) {
      state = 'waiting';
      code = 'navigation';
    }
    evaluatePage();
  };

  /**
   * Signed out (a read refused as signed out, or the page turned into its
   * sign-in view at the same address): like a navigation, everything read
   * under that sign-in goes, and the MAIN observer is told (`reset`, counted
   * on both sides) so answers to requests begun before it are dropped.
   * Nothing is read, built or taken from MAIN until the page shows its
   * sign-in view and then its activity again, or navigates.
   */
  const resetForSignOut = (): void => {
    signedOut ??= 'latched';
    resetContext();
    if (identity.usesMainObserver) {
      signOuts += 1;
      postBridge({ channel: BRIDGE_CHANNEL, kind: 'reset', nonce });
    }
    if (!drifted) {
      state = 'waiting';
      code = 'auth-required';
    }
    evaluatePage();
  };

  // Route changes are counted from the Navigation API, in the same dispatch and with the same code as the MAIN observer
  // (`watchRouteChanges`): a MAIN batch is taken only under the count its request was made under, so an answer to a
  // request begun before any route change (however many, there and back included) never reaches this page state, and
  // one begun after is never lost to a late reset.
  watchRouteChanges(window, EventTarget.prototype.addEventListener, () => {
    if (stopped) return;
    routeChanges += 1;
    resetForNavigation();
  });
  /** A route change the event did not report (none should): reset, without touching the MAIN count. */
  const onRouteFallback = (): void => {
    if (stopped || `${location.pathname}${location.search}` === lastHref) return;
    resetForNavigation();
  };
  window.addEventListener('popstate', onRouteFallback);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', evaluatePage, { once: true });
  else evaluatePage();
  const timer = setInterval(() => {
    if (stopped) {
      clearInterval(timer);
      return;
    }
    onRouteFallback();
    if (stopped) return;
    const next = computePageState();
    if (pageState === 'activity' && next === 'auth-required') {
      // Signed out in place: the activity view turned into the sign-in view at the same address.
      signedOut = 'sign-in-shown';
      resetForSignOut();
    } else if (pageState !== 'activity' && (state === 'waiting' || answersLost) && next !== pageState) {
      // After answers were lost the page is still followed, so a sign-out in place after it starts afresh.
      evaluatePage();
    }
  }, 500);
}
