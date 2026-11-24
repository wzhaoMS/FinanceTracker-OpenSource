/**
 * Where the fake ledger's rows come from: every review candidate of the scenario is a transaction already in the ledger;
 * a few synthetic histories on the Chase account give the owner's repairs (proposal §3.8) something to repair; and a
 * committed plan writes its effects (E1b §4.6, §4.9.2) the way E1b's writer would, as far as the owner can see them.
 * Synthetic data only.
 */
import { sameDecision, type LedgerEventType, type TxnValues } from '../ownerApi';
import {
  activeIdentitiesOf,
  addIdentity,
  changeValues,
  createRow,
  detachIdentityOf,
  identityIdFor,
  linkIdentity,
  mergeRow,
  recordUserEdit,
  removeRow,
  repointIdentityTo,
  revertRow,
  revertibleEvent,
  type AlsoEvent,
  type EventSource,
  type IdentityRec,
  type IdentitySpec,
  type LedgerRowRec,
  type LedgerStore,
} from './ledger';
import { DAY, HOUR, cardTransactionIdFor, isoDay, rowAt, syncIdFor, type CommitMark, type EffectRec, type FakeStore, type ItemRec, type SetRec } from './model';
import { txnFromCandidate, txnFromRow } from './views';

const FILE_IMPORT: Omit<EventSource, 'reason'> = { via: 'file', actor: 'file-import', deviceId: null };
const OWNER_REVIEW: Omit<EventSource, 'reason'> = { via: 'extension', actor: 'owner', deviceId: null };

/** The scope a v1 file import's rows carry when the file names no card (E1b's legacy scope of the account). */
export function legacyScopeIdFor(store: FakeStore, cardAccountRef: string): string {
  const issuer = store.cardAccounts.find((account) => account.id === cardAccountRef)?.issuer ?? 'unknown';
  return syncIdFor('cardScope', `scope/${issuer}/legacy-file`);
}

/** Whether a card scope is one of a binding's known cards, its "holder unknown" scope, or (anything else) a legacy scope. */
export function scopeKindOf(store: FakeStore, cardScopeId: string | null): IdentityRec['scopeKind'] {
  if (cardScopeId === null) return 'legacy';
  for (const binding of store.bindings) {
    const scope = binding.scopes.find((item) => item.cardScopeId === cardScopeId);
    if (scope) return scope.kind;
  }
  return 'legacy';
}

/**
 * Every review candidate is a transaction already in the ledger: one from a v1 file came with the file's key (a legacy
 * alias, kept from the migration); one the extension brought, with the bank's lasting id. A removed candidate was a pending
 * charge the owner dismissed. Rows already in the ledger are left as they are, so this can run again after a test adds sets.
 */
export function seedLedgerFromCandidates(store: FakeStore): void {
  const ledger = store.ledger;
  for (const set of store.sets) {
    for (const entry of set.items) {
      for (const candidate of entry.candidates) {
        if (ledger.rows.has(candidate.transactionId)) continue;
        const createdAt = Date.parse(`${candidate.transactionDate}T15:00:00.000Z`);
        const file = candidate.sourceKind === 'file';
        const removedFrom = candidate.removedFrom ?? 'pending';
        const firstStatus = candidate.status === 'removed' ? removedFrom : candidate.status;
        const values: TxnValues = { ...txnFromCandidate(candidate), status: firstStatus };
        const scopeId = candidate.cardScopeId ?? legacyScopeIdFor(store, set.cardAccountRef);
        const row = createRow(ledger, {
          transactionId: candidate.transactionId,
          cardAccountRef: set.cardAccountRef,
          values: { ...values, cardScopeId: scopeId },
          at: createdAt,
          source: { ...(file ? FILE_IMPORT : OWNER_REVIEW), reason: 'insert' },
          identity: {
            identityId: identityIdFor(`candidate/${candidate.transactionId}`),
            createdBy: file ? 'migration' : 'extension',
            namespaceKind: file ? 'legacy-file' : 'stable',
            sourceScopeId: scopeId,
            scopeKind: file ? 'legacy' : scopeKindOf(store, scopeId),
            firstSeenStatus: firstStatus,
          },
        });
        if (candidate.status === 'removed') {
          // A pending charge the owner dismissed; one removed from posted was imported by mistake (C4).
          const reason = removedFrom === 'posted' ? 'mistaken-import' : 'dismissed';
          removeRow(ledger, row, reason, createdAt + DAY, { via: 'session', actor: 'owner', deviceId: null, reason });
        }
      }
    }
    // A known row an observation hits with a new id (E1b X37): an earlier capture brought it, with the same values.
    for (const [rowIndex, auto] of set.autoRows) {
      if (typeof auto !== 'object' || ledger.rows.has(auto.alias)) continue;
      const values = txnFromRow(set, rowIndex);
      if (!values) continue;
      const scopeId = values.cardScopeId ?? legacyScopeIdFor(store, set.cardAccountRef);
      createRow(ledger, {
        transactionId: auto.alias,
        cardAccountRef: set.cardAccountRef,
        values: { ...values, cardScopeId: scopeId },
        at: Date.parse(`${values.transactionDate}T15:00:00.000Z`),
        source: { ...OWNER_REVIEW, reason: 'insert' },
        identity: {
          identityId: identityIdFor(`known/${auto.alias}`),
          createdBy: 'extension',
          namespaceKind: 'capture',
          sourceScopeId: scopeId,
          scopeKind: scopeKindOf(store, scopeId),
          firstSeenStatus: values.status === 'pending' ? 'pending' : 'posted',
        },
      });
    }
  }
}

/**
 * A charge an earlier Holdr (schema v13/v14) stored as removed without recording why or from which status, as the v15
 * upgrade leaves it (E2a, handoff 10/18 02:30 item 2): `removed` with the reason `legacy` and no earlier status, the alias
 * of its offline file, and no history of its own (the upgrade writes the v14 state as the baseline, not as events).
 * Nothing in v15 assigns the reason. Its id.
 */
export function seedLegacyRemovedCharge(store: FakeStore, now: number): string {
  const chase = store.bindings.find((binding) => binding.issuer === 'chase');
  if (!chase) throw new Error('the legacy charge needs the Chase binding');
  const legacy = legacyScopeIdFor(store, chase.cardAccountRef);
  const at = now - 75 * DAY;
  const row: LedgerRowRec = {
    transactionId: cardTransactionIdFor('ledger/legacy-removed'),
    cardAccountRef: chase.cardAccountRef,
    revision: 1,
    values: {
      status: 'removed', transactionDate: isoDay(at), postedDate: null, amountMinor: 999, kind: 'purchase',
      description: 'NORTHWIND PREAUTH', merchant: null, cardScopeId: legacy,
    },
    removedReason: 'legacy',
    removedFromStatus: null,
    removedAt: at,
    mergedIntoId: null,
    marker: null,
    snapshots: new Map(),
    createdAt: at,
    updatedAt: at,
  };
  store.ledger.rows.set(row.transactionId, row);
  addIdentity(store.ledger, {
    identityId: identityIdFor('migrated/legacy-removed'), createdBy: 'migration', namespaceKind: 'legacy-file', sourceScopeId: legacy,
    scopeKind: 'legacy', firstSeenStatus: 'pending',
  }, row, at);
  return row.transactionId;
}

/** The ids of the synthetic repair stories, for tests. */
export const LEDGER_STORY_IDS = Object.freeze({
  /** A posted charge with three aliases: the extension's, the offline file's, and a capture linked to it by mistake. */
  tailspin: cardTransactionIdFor('ledger/tailspin-1'),
  /** The charge that capture really was: a week later, same amount, from the offline file only (one alias). */
  tailspinLater: cardTransactionIdFor('ledger/tailspin-2'),
  /** The same amount on the other card (Casey's): a capture of Alex's card may never move here. */
  tailspinOtherCard: cardTransactionIdFor('ledger/tailspin-3'),
  /** A pending charge a review promoted to posted with a higher amount (a tip): the promotion can be undone. */
  coho: cardTransactionIdFor('ledger/coho'),
  /** A charge from the offline file that a duplicate was merged into by a later adjustment. */
  fabrikam: cardTransactionIdFor('ledger/fabrikam'),
  /** The duplicate a review once kept as a second charge, merged into `fabrikam`. */
  fabrikamDuplicate: cardTransactionIdFor('ledger/fabrikam-duplicate'),
  /** A charge an earlier capture brought; the fresh Chase capture hits it again with the bank's lasting id: an alias (X37). */
  alpine: cardTransactionIdFor('ledger/alpine'),
});

/**
 * A few histories on the Chase account that the owner's repairs act on (proposal §3.8): an alias linked to the wrong charge,
 * a promotion to undo, and a duplicate merged into a charge. All within the current month of `now`.
 */
export function seedLedgerStories(store: FakeStore, now: number): void {
  const chase = store.bindings.find((binding) => binding.issuer === 'chase');
  if (!chase) return;
  const ledger = store.ledger;
  const account = chase.cardAccountRef;
  const [alex, casey] = chase.scopes;
  const legacy = legacyScopeIdFor(store, account);
  const at = (daysAgo: number) => now - daysAgo * DAY + 3 * HOUR;
  const values = (daysAgo: number, postedDaysAgo: number | null, amountMinor: number, description: string, merchant: string, scopeId: string): TxnValues => ({
    status: postedDaysAgo === null ? 'pending' : 'posted',
    transactionDate: isoDay(now - daysAgo * DAY),
    postedDate: postedDaysAgo === null ? null : isoDay(now - postedDaysAgo * DAY),
    amountMinor,
    kind: 'purchase',
    description,
    merchant,
    cardScopeId: scopeId,
  });
  const alias = (key: string, spec: Omit<IdentitySpec, 'identityId'>): IdentitySpec => ({ identityId: identityIdFor(`story/${key}`), ...spec });

  // An alias linked to the wrong charge: the capture of the later Tailspin purchase ended up on this one.
  const tailspin = createRow(ledger, {
    transactionId: LEDGER_STORY_IDS.tailspin,
    cardAccountRef: account,
    values: values(15, 14, 6_499, 'TAILSPIN TOYS', 'Tailspin Toys', alex.cardScopeId),
    at: at(14),
    source: { ...OWNER_REVIEW, reason: 'insert' },
    identity: alias('tailspin/stable', { createdBy: 'extension', namespaceKind: 'stable', sourceScopeId: alex.cardScopeId, scopeKind: 'known', firstSeenStatus: 'posted' }),
  });
  const fileAlias = addIdentity(ledger, alias('tailspin/file', {
    createdBy: 'migration', namespaceKind: 'legacy-file', sourceScopeId: legacy, scopeKind: 'legacy', firstSeenStatus: 'posted',
  }), tailspin, at(13));
  linkIdentity(ledger, fileAlias, tailspin, at(13), { ...OWNER_REVIEW, reason: 'same-transaction' });
  const wrong = addIdentity(ledger, alias('tailspin/capture', {
    createdBy: 'extension', namespaceKind: 'capture', sourceScopeId: alex.cardScopeId, scopeKind: 'known', firstSeenStatus: 'posted',
  }), tailspin, at(3));
  linkIdentity(ledger, wrong, tailspin, at(3), { ...OWNER_REVIEW, reason: 'same-transaction' });
  createRow(ledger, {
    transactionId: LEDGER_STORY_IDS.tailspinLater,
    cardAccountRef: account,
    values: values(8, 7, 6_499, 'TAILSPIN TOYS', 'Tailspin Toys', legacy),
    at: at(6),
    source: { ...FILE_IMPORT, reason: 'insert' },
    identity: alias('tailspin-later/file', { createdBy: 'file', namespaceKind: 'legacy-file', sourceScopeId: legacy, scopeKind: 'legacy', firstSeenStatus: 'posted' }),
  });
  createRow(ledger, {
    transactionId: LEDGER_STORY_IDS.tailspinOtherCard,
    cardAccountRef: account,
    values: values(9, 8, 6_499, 'TAILSPIN TOYS', 'Tailspin Toys', casey.cardScopeId),
    at: at(7),
    source: { ...OWNER_REVIEW, reason: 'insert' },
    identity: alias('tailspin-other/stable', { createdBy: 'extension', namespaceKind: 'stable', sourceScopeId: casey.cardScopeId, scopeKind: 'known', firstSeenStatus: 'posted' }),
  });

  // A promotion to undo: the pending charge was linked to its posted version, which added a tip.
  const coho = createRow(ledger, {
    transactionId: LEDGER_STORY_IDS.coho,
    cardAccountRef: account,
    values: values(6, null, 3_840, 'COHO VINEYARD PENDING', 'Coho Vineyard', alex.cardScopeId),
    at: at(6),
    source: { ...OWNER_REVIEW, reason: 'insert' },
    identity: alias('coho/capture', { createdBy: 'extension', namespaceKind: 'capture', sourceScopeId: alex.cardScopeId, scopeKind: 'known', firstSeenStatus: 'pending' }),
  });
  const posted = addIdentity(ledger, alias('coho/stable', {
    createdBy: 'extension', namespaceKind: 'stable', sourceScopeId: alex.cardScopeId, scopeKind: 'known', firstSeenStatus: 'posted',
  }), coho, at(4));
  linkIdentity(ledger, posted, coho, at(4), { ...OWNER_REVIEW, reason: 'same-transaction' });
  changeValues(ledger, coho, values(6, 4, 4_608, 'COHO VINEYARD', 'Coho Vineyard', alex.cardScopeId), at(4), {
    eventType: 'promoted', source: { ...OWNER_REVIEW, reason: 'same-transaction' }, identityId: posted.identityId, reversible: true,
  });

  // A duplicate merged into the charge from the offline file by a later adjustment.
  const fabrikam = createRow(ledger, {
    transactionId: LEDGER_STORY_IDS.fabrikam,
    cardAccountRef: account,
    values: values(12, 11, 5_210, 'FABRIKAM FUEL 0042', 'Fabrikam Fuel', legacy),
    at: at(10),
    source: { ...FILE_IMPORT, reason: 'insert' },
    identity: alias('fabrikam/file', { createdBy: 'file', namespaceKind: 'legacy-file', sourceScopeId: legacy, scopeKind: 'legacy', firstSeenStatus: 'posted' }),
  });
  const duplicate = createRow(ledger, {
    transactionId: LEDGER_STORY_IDS.fabrikamDuplicate,
    cardAccountRef: account,
    values: values(12, 11, 5_210, 'FABRIKAM FUEL 0042', 'Fabrikam Fuel', alex.cardScopeId),
    at: at(9),
    source: { ...OWNER_REVIEW, reason: 'insert' },
    identity: alias('fabrikam-duplicate/stable', { createdBy: 'extension', namespaceKind: 'stable', sourceScopeId: alex.cardScopeId, scopeKind: 'known', firstSeenStatus: 'posted' }),
  });
  mergeRow(ledger, duplicate, fabrikam, 'superseded', at(2), OWNER_REVIEW);
  recordUserEdit(ledger, fabrikam, ['category'], at(1));
}

/** The alias an observed row of a set stands for (one per row in the fake). */
function observedIdentityId(set: SetRec, rowIndex: number): string {
  return identityIdFor(`observation/${set.observationSetId}/${rowIndex}`);
}

function observedSpec(store: FakeStore, set: SetRec, rowIndex: number): IdentitySpec | null {
  const row = rowAt(set, rowIndex);
  if (!row) return null;
  const file = set.origin === 'file';
  return {
    identityId: observedIdentityId(set, rowIndex),
    createdBy: file ? 'file' : 'extension',
    namespaceKind: file ? 'legacy-file' : row.identity,
    sourceScopeId: row.cardScopeId,
    scopeKind: file ? 'legacy' : scopeKindOf(store, row.cardScopeId),
    firstSeenStatus: row.status,
  };
}

/**
 * What a committed plan wrote, as E1b's writer records it for the owner (§4.6, §4.9.2): new rows with their alias, links,
 * promotions, attributions and corrections (each one the owner decided, so each can be undone), and for an adjustment the
 * reversal of what the earlier decision did: the duplicate merged or removed, the link detached, the earlier values back.
 */
export function applyLedgerCommit(store: FakeStore, set: SetRec, effects: EffectRec[], at: number): void {
  const ledger = store.ledger;
  const review: Omit<EventSource, 'reason'> = set.origin === 'file' ? { via: 'file', actor: 'owner', deviceId: null } : OWNER_REVIEW;
  const rowOf = (id: string | null): LedgerRowRec | null => (id === null ? null : ledger.rows.get(id) ?? null);
  const aliasOf = (rowIndex: number | null): IdentityRec | null => (rowIndex === null ? null : ledger.identities.get(observedIdentityId(set, rowIndex)) ?? null);
  /** The observation's alias on `row`: created on first use, otherwise moved there. */
  const attach = (rowIndex: number | null, row: LedgerRowRec, reason: EventSource['reason']) => {
    if (rowIndex === null) return null;
    const existing = aliasOf(rowIndex);
    if (existing) {
      if (existing.canonicalId !== row.transactionId || existing.status !== 'active') linkIdentity(ledger, existing, row, at, { ...review, reason });
      return existing;
    }
    const spec = observedSpec(store, set, rowIndex);
    if (!spec) return null;
    const created = addIdentity(ledger, spec, row, at);
    linkIdentity(ledger, created, row, at, { ...review, reason });
    return created;
  };
  for (const effect of effects) {
    const entry = effect.itemId === null ? null : set.items.find((item) => item.itemId === effect.itemId) ?? null;
    switch (effect.effect) {
      case 'insert': {
        const id = entry?.insertedTransactionId ?? cardTransactionIdFor(`inserted/${set.observationSetId}/${effect.rowIndex}`);
        if (ledger.rows.has(id) || !effect.after || effect.rowIndex === null) break;
        const existing = aliasOf(effect.rowIndex);
        const row = createRow(ledger, {
          transactionId: id,
          cardAccountRef: set.cardAccountRef,
          values: effect.after,
          at,
          source: { ...review, reason: 'insert' },
          identity: existing ? null : observedSpec(store, set, effect.rowIndex),
        });
        // An adjustment that adds the row an earlier link took: the detached alias moves to it.
        if (existing) repointIdentityTo(ledger, existing, row, at, { ...review, reason: 'adjustment' });
        break;
      }
      case 'match': {
        const target = rowOf(effect.transactionId);
        if (target) attach(effect.rowIndex, target, 'same-transaction');
        break;
      }
      case 'alias': {
        // E1b X37: the row stays as it is; the observation's id becomes another of its sources (`identity-linked`, `alias`).
        const target = rowOf(effect.transactionId);
        if (target) attach(effect.rowIndex, target, 'alias');
        break;
      }
      case 'promote':
      case 'attribute':
      case 'correct': {
        const target = rowOf(effect.transactionId);
        if (!target || !effect.after) break;
        const reason = effect.effect === 'correct' ? 'posted-correction' : effect.effect === 'attribute' ? 'attribution'
          : entry?.reason === 'pending-posted' ? 'pending-posted' : 'same-transaction';
        const alias = attach(effect.rowIndex, target, effect.effect === 'correct' ? 'alias' : 'same-transaction');
        // One update, and every reversible event it writes at that revision (E1b's compound match): a removed row restored,
        // a card put on; `revert` then offers the first of corrected, promoted, restored, attributed.
        const main = effect.effect === 'promote' ? 'promoted' as const : effect.effect === 'attribute' ? 'attributed' as const : 'corrected' as const;
        // Each event keeps a reason its own type allows (E1b `ck_evt_*`): a restore is `restore`, a card put on `attribution`.
        const alsoEvents: AlsoEvent[] = [];
        if (main !== 'attributed' && target.values.status === 'removed' && effect.after.status !== 'removed') alsoEvents.push({ eventType: 'restored', reason: 'restore' });
        if (main !== 'attributed' && effect.after.cardScopeId !== target.values.cardScopeId) alsoEvents.push({ eventType: 'attributed', reason: 'attribution' });
        changeValues(ledger, target, effect.after, at, {
          eventType: main,
          source: { ...review, reason },
          identityId: alias?.identityId ?? null,
          reversible: true,
          alsoEvents,
        });
        break;
      }
      case 'supersede': {
        const duplicate = rowOf(effect.transactionId);
        const target = rowOf(entry?.committed?.transactionId ?? null);
        if (duplicate && target && duplicate.values.status !== 'removed') mergeRow(ledger, duplicate, target, 'superseded', at, review);
        break;
      }
      case 'remove': {
        const row = rowOf(effect.transactionId);
        if (row && row.values.status !== 'removed') removeRow(ledger, row, 'mistaken-import', at, { ...review, reason: 'mistaken-import' });
        break;
      }
      case 'restore-attribution': {
        const row = rowOf(effect.transactionId);
        if (row && effect.after) changeValues(ledger, row, effect.after, at, { eventType: 'attributed', source: { ...review, reason: 'adjustment' }, reversible: false });
        break;
      }
      case 'revert': {
        const row = rowOf(effect.transactionId);
        const change = row ? revertibleEvent(ledger, row) : null;
        // Prepare and commit refuse an adjustment whose change is no longer the row's latest reversible one (see below).
        if (row && change) revertRow(ledger, row, change, at, { ...review, reason: 'adjustment' });
        break;
      }
      case 'unmatch': {
        const alias = aliasOf(effect.rowIndex);
        if (alias && alias.status === 'active' && alias.canonicalId === effect.transactionId && activeIdentitiesOf(ledger, alias.canonicalId).length > 1) {
          detachIdentityOf(ledger, alias, at, { ...review, reason: 'adjustment' });
        }
        break;
      }
      default:
        // reject, accept-difference: nothing in the ledger changes.
        break;
    }
  }
}

/**
 * The row a committed decision is about: the row it created, linked or corrected, or (keep-current) the one it kept as it is;
 * null for a rejected row or an acknowledged difference.
 */
function committedRowOf(entry: ItemRec): string | null {
  switch (entry.committed?.action) {
    case 'insert-new':
    case 'attribute':
      return entry.insertedTransactionId;
    case 'same-transaction':
    case 'attribute-and-link':
      return entry.committed.transactionId;
    case 'accept-correction':
    case 'keep-current':
      return entry.candidates[0]?.transactionId ?? null;
    default:
      return null;
  }
}

/** What a commit just applied for an item, read once its effects are in the ledger (E1b's `committed_*` columns). */
export function commitMarkOf(ledger: LedgerStore, entry: ItemRec, effects: EffectRec[]): CommitMark {
  const transactionId = committedRowOf(entry);
  const row = transactionId === null ? null : ledger.rows.get(transactionId) ?? null;
  // Its own value change: a promotion, a correction or a card put on (a compound match is one of these), never a row it created.
  const wrote = row !== null && effects.some((effect) => effect.itemId === entry.itemId && effect.transactionId === row.transactionId
    && (effect.effect === 'promote' || effect.effect === 'attribute' || effect.effect === 'correct'));
  return { seq: ledger.seq, transactionId: row?.transactionId ?? null, revision: row?.revision ?? null, wrote };
}

/** What moves a source off the row it counts under (E1b §4.9.2 names exactly these two). */
const SOURCE_MOVES: ReadonlySet<LedgerEventType> = new Set(['identity-repointed', 'identity-detached']);
/** The events that change a row's tracked values, each with a snapshot in E1b (category and notes edits take none). */
const VALUE_CHANGES: ReadonlySet<LedgerEventType> = new Set(['promoted', 'corrected', 'attributed', 'restored', 'removed', 'superseded', 'settled-into', 'reversed']);

/**
 * Whether a committed decision can still be taken back exactly (E1b §4.9.2, `adjustment-not-reversible` otherwise, the owner
 * API's 409 `action-not-allowed`), checked when a changed decision is recorded and again at prepare and commit:
 * - the item's source neither moved nor was detached after the commit, even if it is back where it was;
 * - a commit that wrote the row: its change is still the row's latest reversible one (E1b's `reversal_snapshot_revision` is
 *   `committed_revision − 1`; a category or notes edit carries it, any later value change replaced or cleared it);
 * - any other commit (a link that didn't write, keep-current, an insert): the row's values haven't changed since.
 * An item the fake never committed itself (a committed set the scenario seeded) has no mark, and passes here.
 */
export function itemAdjustable(store: FakeStore, set: SetRec, entry: ItemRec): boolean {
  const mark = entry.commitMark;
  if (!mark) return true;
  const ledger = store.ledger;
  const later = ledger.events.filter((event) => event.seq > mark.seq);
  if (entry.rowIndex !== null) {
    const source = observedIdentityId(set, entry.rowIndex);
    if (later.some((event) => event.identityId === source && SOURCE_MOVES.has(event.eventType))) return false;
  }
  const row = mark.transactionId === null ? null : ledger.rows.get(mark.transactionId) ?? null;
  if (!row || mark.revision === null) return true;
  if (mark.wrote) return row.marker === mark.revision - 1;
  return !later.some((event) => event.transactionId === row.transactionId && VALUE_CHANGES.has(event.eventType));
}

/**
 * The same rules over a whole adjustment at prepare and commit: every item whose draft differs from what is in spending. An
 * item the scenario seeded (no mark) is checked only through its `revert`, which needs a change to take back.
 */
export function adjustmentReversible(store: FakeStore, set: SetRec, effects: EffectRec[]): boolean {
  const changed = set.items.filter((entry) => entry.decision !== null && entry.committed !== null && !sameDecision(entry.decision, entry.committed));
  if (!changed.every((entry) => itemAdjustable(store, set, entry))) return false;
  return effects.every((effect) => {
    if (effect.effect !== 'revert' || set.items.find((item) => item.itemId === effect.itemId)?.commitMark) return true;
    const row = effect.transactionId === null ? null : store.ledger.rows.get(effect.transactionId) ?? null;
    return row !== null && revertibleEvent(store.ledger, row) !== null;
  });
}

/** The ledger's rows, live and removed, for a store; a convenience for tests and the e2e harness. */
export function ledgerRows(ledger: LedgerStore): LedgerRowRec[] {
  return [...ledger.rows.values()];
}
