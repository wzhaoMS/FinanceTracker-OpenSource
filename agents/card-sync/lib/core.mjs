// The receiver's routes, reached only through the encrypted channel. One sync at a time holds a lease; for each card the
// extension lists the statement dates, the receiver says which statements to fetch, the extension sends their exports
// one by one (kept as raw files in the private raw folder), and `finish` converts them into one redacted file in the
// outbox, deletes the raw files, and asks Holdr for a preview of that file (which writes nothing).
import fs from 'node:fs';

import { describeApiError, nothingLeftToImport } from './holdr-api.mjs';
import { ConversionError } from './convert.mjs';
import { listOutbox, outboxName, supersededFiles, writeOutbox } from './outbox.mjs';
import {
  localToday, matchCardAccount, PlanError, planStatements, productNickname, rangesContain, recordReads,
} from './plan.mjs';
import { rawName, RawCleanupError } from './raw-store.mjs';

export const PROTOCOL = 1;
const LEASE_ID = /^[A-Za-z0-9-]{8,64}$/;
const SOURCE_ID = /^amex-[a-p]{64}$/;
const LAST5 = /^\d{5}$/;
const MAX_CARDS = 20;
const MAX_EXPORT_CHARS = 20_000_000;
const STATUS_CACHE_MS = 10_000;

export class RouteError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const json = (status, value) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: Buffer.from(JSON.stringify(value)),
});

/**
 * `reads` is the receiver's record of when it read each card's statements (`{ [sourceId]: { [end]: { readOn, empty } } }`,
 * kept in its state file); it is updated in place after each card's file is saved, and `saveReads` persists it.
 */
export function createReceiverCore({
  config, salt, api, rawStore, convert, log = () => {}, now = () => new Date(), leaseMs = 90_000, reads = {}, saveReads = () => {},
}) {
  const extensionOrigin = `chrome-extension://${config.extensionId}`;
  let lease = null;
  let statusCache = null;
  let queue = Promise.resolve();

  const leaseActive = () => lease !== null && now().getTime() - lease.at < leaseMs;
  const ownerLabel = (owner) => (owner ? config.ownerLabels[owner] ?? null : null);
  const publicAccount = (account) => (account ? {
    nickname: typeof account.nickname === 'string' ? account.nickname.slice(0, 80) : null,
    owner: account.owner ?? null,
    ownerLabel: ownerLabel(account.owner),
    status: account.status === 'closed' ? 'closed' : 'active',
  } : null);
  const label = (card) => [ownerLabel(card.account?.owner), `··${card.last5}`, card.product].filter(Boolean).join(' ');

  /**
   * Records that this sync read the card's statements, once what it read is safe: saved in the outbox, already in Holdr,
   * or without any transaction. A failure to save only means the statements are read again next time.
   */
  function rememberReads(card, plan, staged) {
    const previous = Object.hasOwn(reads, card.sourceId) ? reads[card.sourceId] : {};
    reads[card.sourceId] = recordReads(previous, staged.map((entry) => ({ end: entry.end, empty: entry.file === null })),
      plan.today, plan.listedFrom);
    try {
      saveReads(reads);
    } catch {
      log({ kind: 'state-save-failed' });
    }
  }

  async function discardCard(card) {
    const staged = card?.plan?.staged ?? [];
    if (card?.plan) card.plan.staged = [];
    let failure = null;
    for (const entry of staged) {
      if (!entry.file) continue;
      try {
        await rawStore.remove(entry.file);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
  }

  async function endLease() {
    const ended = lease;
    lease = null;
    if (!ended) return;
    let failure = null;
    for (const card of ended.cards.values()) {
      try {
        await discardCard(card);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
  }

  async function expireLease() {
    if (lease && !leaseActive()) {
      log({ kind: 'lease-expired' });
      await endLease();
    }
  }

  function requireLease(body) {
    if (typeof body?.lease !== 'string' || !LEASE_ID.test(body.lease) || !leaseActive() || lease.id !== body.lease) {
      throw new RouteError(409, 'sync-lease-required', 'this sync is no longer active (the receiver restarted or the sync timed out): click Sync again');
    }
    lease.at = now().getTime();
    return lease;
  }

  function requireExtension(transportOrigin) {
    if (transportOrigin !== extensionOrigin) throw new RouteError(403, 'not-extension', 'only the paired extension may ask this');
  }

  function heldCard(body, held) {
    const sourceId = body?.card?.sourceId;
    const card = typeof sourceId === 'string' && SOURCE_ID.test(sourceId) ? held.cards.get(sourceId) : undefined;
    if (!card || body.card.last5 !== card.last5) throw new RouteError(409, 'card-unknown', 'list the cards again before syncing this one');
    return card;
  }

  async function holdrStatus() {
    if (statusCache && now().getTime() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
    const value = await api.status();
    statusCache = { at: now().getTime(), value };
    return value;
  }

  const routes = new Map([
    ['GET /sync/ping', async () => ({ ok: true, protocol: PROTOCOL, busy: leaseActive() })],

    ['GET /sync/config', async ({ transportOrigin }) => {
      requireExtension(transportOrigin);
      return { protocol: PROTOCOL, salt, webUrl: config.webUrl, history: config.history, owners: config.ownerLabels };
    }],

    ['GET /sync/status', async ({ transportOrigin }) => {
      requireExtension(transportOrigin);
      return {
        protocol: PROTOCOL,
        busy: leaseActive(),
        holdr: await holdrStatus(),
        outbox: { count: listOutbox(config.outboxDir).length, folder: config.outboxDir },
        paused: rawStore.blocked,
      };
    }],

    ['POST /sync/claim', async ({ body }) => {
      const id = body?.lease;
      if (typeof id !== 'string' || !LEASE_ID.test(id)) throw new RouteError(400, 'invalid-lease', 'a sync id is required');
      if (leaseActive() && lease.id !== id) return { ok: false, busy: true };
      if (rawStore.blocked) {
        try {
          await rawStore.sweep();
        } catch {
          throw new RawCleanupError();
        }
      }
      if (leaseActive()) lease.at = now().getTime();
      else lease = { id, at: now().getTime(), cards: new Map() };
      return { ok: true };
    }],

    ['POST /sync/release', async ({ body }) => {
      if (lease && lease.id === body?.lease) await endLease();
      return { ok: true };
    }],

    ['POST /sync/stop', async () => {
      await endLease();
      log({ kind: 'sync-stopped' });
      return { ok: true };
    }],

    ['POST /sync/amex/cards', async ({ body }) => {
      const held = requireLease(body);
      const listed = body?.cards;
      if (!Array.isArray(listed) || listed.length === 0 || listed.length > MAX_CARDS || listed.some((card) => !card
        || typeof card.sourceId !== 'string' || !SOURCE_ID.test(card.sourceId) || typeof card.last5 !== 'string' || !LAST5.test(card.last5)
        || (card.product != null && (typeof card.product !== 'string' || card.product.length > 200)))) {
        throw new RouteError(400, 'invalid-cards', 'valid cards are required');
      }
      let accounts = null;
      let coverage = [];
      let holdr;
      try {
        accounts = await api.listCardAccounts();
        coverage = await api.coverage();
        holdr = { status: 'ok' };
      } catch (error) {
        holdr = describeApiError(error);
        log({ kind: 'holdr-unavailable', code: holdr.status });
      }
      const endings = listed.map((card) => card.last5);
      const result = [];
      for (const listedCard of listed) {
        const previous = held.cards.get(listedCard.sourceId);
        if (previous) await discardCard(previous);
        const match = accounts ? matchCardAccount(accounts, listedCard.last5) : { status: 'unknown', account: null };
        const card = {
          sourceId: listedCard.sourceId,
          last5: listedCard.last5,
          product: productNickname(listedCard.product),
          sharedEnding: endings.filter((ending) => ending === listedCard.last5).length > 1,
          match: match.status,
          account: match.account,
          ranges: match.account ? coverage.find((entry) => entry.cardAccountId === match.account.id)?.ranges ?? [] : [],
          plan: null,
        };
        held.cards.set(card.sourceId, card);
        result.push({
          sourceId: card.sourceId, last5: card.last5, product: card.product, label: label(card),
          sharedEnding: card.sharedEnding, match: card.match, account: publicAccount(card.account),
        });
      }
      return { cards: result, holdr };
    }],

    ['POST /sync/amex/plan', async ({ body }) => {
      const held = requireLease(body);
      const card = heldCard(body, held);
      if (card.sharedEnding) throw new RouteError(409, 'shared-ending', 'two cards here share this ending; neither is synced');
      await discardCard(card);
      const waiting = listOutbox(config.outboxDir).filter((entry) => entry.last5 === card.last5);
      const today = localToday(now());
      let plan;
      try {
        plan = planStatements({
          periods: body.periods,
          today,
          history: config.history,
          known: [...card.ranges, ...waiting.map(({ start, end }) => ({ start, end }))],
          reads: Object.hasOwn(reads, card.sourceId) ? reads[card.sourceId] : {},
        });
      } catch (error) {
        if (error instanceof PlanError) throw new RouteError(400, 'invalid-periods', error.message);
        throw error;
      }
      card.plan = { ...plan, today, staged: [] };
      log({ kind: 'plan', card: card.last5, fetch: plan.fetch.length, covered: plan.alreadyCovered });
      return { fetch: plan.fetch.map(({ start, end, open }) => ({ start, end, open })), alreadyCovered: plan.alreadyCovered };
    }],

    ['POST /sync/amex/statement', async ({ body }) => {
      const held = requireLease(body);
      const card = heldCard(body, held);
      const plan = card.plan;
      if (!plan) throw new RouteError(409, 'plan-required', 'ask which statements to fetch first');
      const end = body?.period?.end;
      if (!plan.fetch.some((period) => period.end === end)) throw new RouteError(409, 'statement-not-planned', 'that statement was not asked for');
      if (plan.staged.some((entry) => entry.end === end)) throw new RouteError(409, 'statement-repeated', 'that statement was already received');
      const csv = body.csv;
      if (typeof csv !== 'string' || csv.length > MAX_EXPORT_CHARS) throw new RouteError(400, 'invalid-export', 'the statement export is missing or too large');
      if (csv.trim() === '') plan.staged.push({ end, file: null });
      else plan.staged.push({ end, file: rawStore.stage(rawName(card.sourceId, end), csv) });
      return { ok: true, received: plan.staged.length, expected: plan.fetch.length };
    }],

    ['POST /sync/amex/discard', async ({ body }) => {
      const held = requireLease(body);
      const card = heldCard(body, held);
      await discardCard(card);
      card.plan = null;
      return { ok: true };
    }],

    ['POST /sync/amex/finish', async ({ body }) => {
      const held = requireLease(body);
      const card = heldCard(body, held);
      const plan = card.plan;
      if (!plan) throw new RouteError(409, 'plan-required', 'ask which statements to fetch first');
      if (plan.staged.length !== plan.fetch.length) {
        await discardCard(card);
        card.plan = null;
        throw new RouteError(409, 'statements-missing', 'not every statement arrived, so nothing was saved: click Sync again');
      }
      const staged = [...plan.staged].sort((a, b) => (a.end < b.end ? -1 : 1));
      card.plan = null;
      let converted;
      let failure = null;
      try {
        converted = await convert({
          csvTexts: staged.filter((entry) => entry.file).map((entry) => rawStore.read(entry.file)),
          coverage: plan.coverage,
          owner: card.account?.owner ?? null,
        });
      } catch (error) {
        failure = error;
      } finally {
        for (const entry of staged) if (entry.file) await rawStore.remove(entry.file);
      }
      if (failure) {
        if (failure instanceof ConversionError) {
          log({ kind: 'conversion-failed', card: card.last5 });
          throw new RouteError(422, 'conversion-failed', `the export could not be converted: ${failure.message}`, { lines: failure.lines });
        }
        throw failure;
      }
      if (converted.empty) {
        rememberReads(card, plan, staged);
        log({ kind: 'no-activity', card: card.last5, statements: staged.length });
        return { ok: true, empty: true, file: null, rows: 0, label: label(card) };
      }
      const { payload } = converted;
      let preview = null;
      let previewProblem = null;
      if (card.match === 'matched') {
        try {
          preview = await api.preview(card.account.id, converted.json);
        } catch (error) {
          previewProblem = describeApiError(error);
        }
      }
      const result = {
        ok: true, empty: false, rows: payload.rows.length, coverage: payload.coverage, label: label(card), match: card.match,
        account: publicAccount(card.account), preview, previewProblem,
      };
      if (preview && nothingLeftToImport(preview) && rangesContain(card.ranges, payload.coverage)) {
        rememberReads(card, plan, staged);
        log({ kind: 'already-imported', card: card.last5, rows: payload.rows.length, from: payload.coverage.start, to: payload.coverage.end });
        return { ...result, alreadyImported: true, file: null, replaced: 0 };
      }
      const name = outboxName(card.last5, payload.coverage);
      writeOutbox(config.outboxDir, name, converted.json);
      const replaced = supersededFiles(listOutbox(config.outboxDir), card.last5, payload.coverage, name);
      for (const entry of replaced) fs.rmSync(entry.file, { force: true });
      rememberReads(card, plan, staged);
      log({
        kind: 'saved', card: card.last5, file: name, rows: payload.rows.length, from: payload.coverage.start, to: payload.coverage.end,
        replaced: replaced.length, ...(preview ? { newRows: preview.newCount, alreadyImported: preview.duplicateCount } : {}),
        ...(previewProblem ? { preview: previewProblem.status } : {}),
      });
      return { ...result, alreadyImported: false, file: name, replaced: replaced.length };
    }],
  ]);

  /** Answers one request that came through the channel: `{ status, headers, body }`. */
  async function dispatch({ method, path, body, contentType, transportOrigin = null }) {
    const url = new URL(path, 'http://receiver.invalid');
    const key = `${method} ${url.pathname}`;
    const route = routes.get(key);
    if (!route) return json(404, { error: 'not-found' });
    let parsed = null;
    if (body && body.length > 0) {
      if (!/^application\/json\b/i.test(contentType ?? '')) return json(415, { error: 'json-required' });
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        return json(400, { error: 'invalid-json' });
      }
    }
    const run = async () => {
      try {
        await expireLease();
        return json(200, await route({ body: parsed, query: url.searchParams, transportOrigin }));
      } catch (error) {
        if (error instanceof RouteError) return json(error.status, { error: error.code, message: error.message, ...error.extra });
        if (error instanceof RawCleanupError) {
          log({ kind: 'raw-cleanup-failed' });
          return json(503, { error: error.code, message: error.message });
        }
        log({ kind: 'route-error', route: key, type: error?.name ?? 'Error' });
        return json(500, { error: 'receiver-error', message: 'the receiver failed; see its log' });
      }
    };
    if (method === 'GET') return run();
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  // A sync abandoned mid-way (its tab closed) holds raw exports: they are deleted once its lease runs out, even if no
  // other request comes. In the queue, so that this never runs between two steps of a request.
  const expiryTimer = setInterval(() => {
    queue = queue.then(() => expireLease()).catch(() => log({ kind: 'raw-cleanup-failed' }));
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  expiryTimer.unref?.();

  return {
    dispatch,
    leaseActive,
    /** Ends any sync and deletes its raw files (the receiver is stopping). */
    async shutdown() {
      clearInterval(expiryTimer);
      await endLease();
    },
  };
}
