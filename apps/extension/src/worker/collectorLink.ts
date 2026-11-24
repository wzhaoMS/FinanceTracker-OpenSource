/**
 * Worker → collector: configuration and stop, addressed to one exact
 * document (`tabs.sendMessage` with its documentId), so a message can never
 * reach a later page in the same tab. Replies are parsed strictly.
 */
import { parseStrict } from '../common/strict.js';
import { COLLECTOR_REPLY, type CollectorConfig, type CollectorReply, type StopReason } from '../contracts/messages.js';
import { target } from './context.js';
import { readSession, writeSession, type CollectorDoc, type UnconfirmedStop } from './storage.js';

/** At most this many unanswered stops are remembered (the oldest go first). */
const MAX_UNCONFIRMED = 50;

/**
 * A read of these issuers ended or was stopped (its lease is gone): its last
 * request went out before now, so the issuer's next read, in any tab and
 * whatever reader it creates, sends nothing for one request interval from
 * here. Runs inside `serialized`.
 */
export async function noteReadsEnded(adapterIds: readonly string[]): Promise<void> {
  if (adapterIds.length === 0) return;
  const until = Date.now() + target.timings.requestIntervalMs;
  const cooldowns = await readSession('readCooldowns');
  for (const id of adapterIds) cooldowns[id] = Math.max(cooldowns[id] ?? 0, until);
  await writeSession('readCooldowns', cooldowns);
}

export async function sendToCollector(
  doc: Pick<CollectorDoc, 'tabId' | 'documentId'>,
  message: CollectorConfig | { type: 'collector-stop/v1'; reason: StopReason },
): Promise<CollectorReply | null> {
  try {
    const reply = await chrome.tabs.sendMessage(doc.tabId, message, { documentId: doc.documentId });
    const parsed = parseStrict(reply, COLLECTOR_REPLY);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

export async function findDoc(docRef: string): Promise<CollectorDoc | undefined> {
  return (await readSession('collectors')).find((doc) => doc.docRef === docRef);
}

/**
 * Tells matching collectors to stop at once, without waiting for the
 * serialized stop that also forgets them (`stopCollectors`): a read already
 * running in a page ends now, whatever else holds the worker's lock (plan
 * §2.4). A collector answers every stop, a repeated one included.
 */
export async function signalStopNow(match: (doc: CollectorDoc) => boolean, reason: StopReason): Promise<void> {
  const docs = await readSession('collectors');
  await Promise.all(docs.filter(match).map((doc) => sendToCollector(doc, { type: 'collector-stop/v1', reason })));
}

function sameDocument(a: Pick<UnconfirmedStop, 'tabId' | 'documentId'>, b: Pick<UnconfirmedStop, 'tabId' | 'documentId'>): boolean {
  return a.tabId === b.tabId && a.documentId === b.documentId;
}

/**
 * Tells every matching collector to stop and forgets it. A page that does
 * not answer may still run: it becomes an unconfirmed stop, which the UI
 * shows (close those tabs or disable the extension) until a later stop
 * reaches it, the page itself shows up again (collectors.ts stops it then)
 * or its tab closes. Every stop retries the earlier unconfirmed ones, so a
 * repeated or later cleanup never clears the warning without an answer.
 * Runs inside `serialized`.
 */
export async function stopCollectors(match: (doc: CollectorDoc) => boolean, reason: StopReason): Promise<void> {
  const docs = await readSession('collectors');
  const targets = docs.filter(match);
  const unanswered: UnconfirmedStop[] = [];
  await Promise.all(
    targets.map(async (doc) => {
      const reply = await sendToCollector(doc, { type: 'collector-stop/v1', reason });
      if (!reply || !reply.ok) unanswered.push({ tabId: doc.tabId, documentId: doc.documentId, adapterId: doc.adapterId, reason });
    }),
  );
  // Stored before the documents are forgotten: a worker that ends in between still knows every page to stop.
  await recordUnconfirmedStops(unanswered);
  const remaining = (await readSession('collectors')).filter((doc) => !targets.some((item) => item.docRef === doc.docRef));
  await writeSession('collectors', remaining);
  const leases = await readSession('readLeases');
  const ended: string[] = [];
  for (const [adapterId, lease] of Object.entries(leases)) {
    if (!targets.some((doc) => doc.docRef === lease.docRef)) continue;
    delete leases[adapterId];
    ended.push(adapterId);
  }
  await writeSession('readLeases', leases);
  await noteReadsEnded(ended);
  await retryUnconfirmedStops(unanswered);
}

/** Adds pages a stop did not reach (one entry per document). Runs inside `serialized`. */
export async function recordUnconfirmedStops(entries: readonly UnconfirmedStop[]): Promise<void> {
  if (entries.length === 0) return;
  const next = [...(await readSession('unconfirmedStops'))];
  for (const entry of entries) if (!next.some((item) => sameDocument(item, entry))) next.push(entry);
  await writeSession('unconfirmedStops', next.slice(-MAX_UNCONFIRMED));
}

/** Sends every unconfirmed stop (but those in `skip`, just tried) again; the answered ones are dropped. Runs inside `serialized`. */
export async function retryUnconfirmedStops(skip: readonly UnconfirmedStop[] = []): Promise<void> {
  const entries = (await readSession('unconfirmedStops')).filter((entry) => !skip.some((item) => sameDocument(item, entry)));
  if (entries.length === 0) return;
  const answered: UnconfirmedStop[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const reply = await sendToCollector(entry, { type: 'collector-stop/v1', reason: entry.reason });
      if (reply?.ok) answered.push(entry);
    }),
  );
  if (answered.length > 0) await dropUnconfirmedStops((entry) => answered.some((item) => sameDocument(item, entry)));
}

/** The unconfirmed stop of this exact document, if any. */
export async function unconfirmedStopOf(tabId: number, documentId: string): Promise<UnconfirmedStop | undefined> {
  return (await readSession('unconfirmedStops')).find((entry) => sameDocument(entry, { tabId, documentId }));
}

/** Forgets unconfirmed stops that `gone` matches: answered at last, or their tab closed. Runs inside `serialized`. */
export async function dropUnconfirmedStops(gone: (entry: UnconfirmedStop) => boolean): Promise<void> {
  const previous = await readSession('unconfirmedStops');
  const next = previous.filter((entry) => !gone(entry));
  if (next.length !== previous.length) await writeSession('unconfirmedStops', next);
}