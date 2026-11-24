/**
 * Synthetic scenarios for the fake Holdr: fictional merchants, made-up
 * amounts, card endings that are only labels, and v2 payloads built and
 * validated by the shared contract code, so the fake never shows the UI
 * anything a real Holdr could not have accepted.
 */
import {
  buildCardSyncPayloadV2,
  canonicalJsonByteLength,
  cardExternalIdHash,
  cardSyncObservedRange,
  cardSyncPayloadDigest,
  CARD_SYNC_SOURCE_SPECS,
  type CardAccount,
  type CardImportStatement,
  type CardSyncCompleteness,
  type CardSyncCoverageEntry,
  type CardSyncIssuer,
  type CardSyncPayloadV2,
  type CardSyncRowDraftV2,
  type CardSyncSource,
  type CardSyncTermination,
  type CardTransactionKind,
  type JsonValue,
} from '@finance-tracker/shared';
import type { DecisionAction, HolderAlias, ReviewReason } from '../ownerApi';
import {
  DAY,
  FAKE_HOLDR_ORIGIN,
  HOUR,
  LIMITS,
  MINUTE,
  cardAccountRefFor,
  cardTransactionIdFor,
  fingerprintFor,
  importBatchIdFor,
  isoDay,
  ownerIdFor,
  syncIdFor,
  type AutoRow,
  type BindingRec,
  type CandidateRec,
  type DeviceRec,
  type FakeStore,
  type ItemRec,
  type RowRec,
  type RunRec,
  type ScopeRec,
  type SetRec,
} from './model';
import { emptyLedger } from './ledger';
import { LEDGER_STORY_IDS, seedLedgerFromCandidates, seedLedgerStories } from './ledgerSeed';

export type FakeScenario = 'demo' | 'fresh' | 'restored';

const at = (start: number) => (offsetMs: number) => start + offsetMs;

export function fakeCardAccounts(start: number): CardAccount[] {
  const created = new Date(start - 400 * DAY).toISOString();
  const account = (label: string, issuer: string, owner: CardAccount['owner'], nickname: string, last4: string, last5?: string): CardAccount => ({
    id: cardAccountRefFor(`acct/${label}`),
    issuer,
    owner,
    nickname,
    last4,
    ...(last5 ? { last5 } : {}),
    currency: 'USD',
    status: 'active',
    createdAt: created,
    updatedAt: created,
  });
  return [
    account('chase-sapphire', 'chase', 'joint', 'Sapphire (synthetic)', '3391'),
    account('amex-gold', 'amex', 'alex', 'Gold (synthetic)', '0003', '90003'),
    account('citi-double', 'citi', 'casey', 'Double Cash (synthetic)', '2002'),
    account('wf-active', 'wellsfargo', 'joint', 'Active Cash (synthetic)', '4417'),
    account('chase-freedom', 'chase', 'alex', 'Freedom (synthetic)', '5500'),
  ];
}

function scope(bindingKey: string, label: string, alias: HolderAlias | 'unknown', last4: string | null): ScopeRec {
  return {
    cardScopeId: syncIdFor('cardScope', `scope/${bindingKey}/${label}`),
    kind: alias === 'unknown' ? 'unknown' : 'known',
    scopeLabel: label,
    holderAlias: alias,
    last4,
    status: 'active',
  };
}

export function unknownScope(bindingKey: string): ScopeRec {
  return scope(bindingKey, 'Holder unknown', 'unknown', null);
}

function binding(
  key: string,
  issuer: CardSyncIssuer,
  source: CardSyncSource,
  label: string,
  cardAccountRef: string,
  scopes: ScopeRec[],
  confirmedAt: number,
): BindingRec {
  return {
    bindingId: syncIdFor('binding', `binding/${key}`),
    bindingVersion: 1,
    issuer,
    source,
    bindingLabel: label,
    cardAccountRef,
    status: 'confirmed',
    statusReason: null,
    confirmedAt,
    scopes,
    autoSyncConsent: new Map(),
    autoSyncRevision: 0,
    autoSyncGate: 'closed',
    autoSyncEligible: false,
    createdAt: confirmedAt,
  };
}

function device(
  key: string,
  label: string,
  status: DeviceRec['status'],
  approvedAt: number,
  bindingIds: string[],
  extra: Partial<DeviceRec> = {},
): DeviceRec {
  const deviceId = syncIdFor('device', `device/${key}`);
  return {
    deviceId,
    deviceLabel: label,
    clientVersion: '0.1.0',
    status,
    fingerprint: fingerprintFor(deviceId),
    pairingId: ownerIdFor('pairing', `pairing/${key}`),
    createdAt: approvedAt - 2 * MINUTE,
    pendingExpiresAt: null,
    approvedAt,
    deviceExpiresAt: approvedAt + LIMITS.deviceDays * DAY,
    lastSeenAt: null,
    revokedAt: null,
    revokeReason: null,
    bindingIds,
    staleBindingIds: [],
    ...extra,
  };
}

export interface RowSpec {
  key: string;
  scope: ScopeRec;
  daysAgo: number;
  postedDaysAgo?: number | null;
  amount: number;
  kind?: CardTransactionKind;
  description: string;
  merchant?: string | null;
  category?: string | null;
  stableId?: boolean;
}

export interface PayloadSpec {
  binding: BindingRec;
  rows: RowSpec[];
  observedAt: number;
  termination: CardSyncTermination;
  completeness: CardSyncCompleteness;
  requested: { fromDaysAgo: number; toDaysAgo: number } | null;
  statement?: CardImportStatement | null;
  rejectedCount?: number;
  captureKey: string;
}

/** A valid v2 payload for `spec`, built and checked by the shared contract code. Throws on synthetic data it refuses. */
export function buildFakePayload(spec: PayloadSpec, now: number): CardSyncPayloadV2 {
  const sourceSpec = CARD_SYNC_SOURCE_SPECS[spec.binding.source];
  const day = (daysAgo: number) => isoDay(now - daysAgo * DAY);
  const rows: CardSyncRowDraftV2[] = spec.rows.map((row) => {
    const pending = row.postedDaysAgo === null;
    const stable = row.stableId === true && sourceSpec.stableNamespaces.length > 0;
    return {
      transactionDate: day(row.daysAgo),
      postedDate: pending ? null : day(row.postedDaysAgo ?? row.daysAgo),
      status: pending ? 'pending' : 'posted',
      amountMinor: row.amount,
      kind: row.kind ?? (row.amount < 0 ? 'refund' : 'purchase'),
      description: row.description,
      merchant: row.merchant ?? null,
      issuerCategory: row.category ?? null,
      externalIdHash: stable ? cardExternalIdHash(`SYN-${spec.captureKey}-${row.key}`) : null,
      cardScopeId: row.scope.cardScopeId,
      identityNamespace: stable ? sourceSpec.stableNamespaces[0] : sourceSpec.captureNamespace,
      secondaryIds: [],
      originalAmountMinor: null,
      originalCurrency: null,
    };
  });
  const groups = new Map<string, CardSyncRowDraftV2[]>();
  for (const row of rows) {
    const key = `${row.cardScopeId} ${row.status}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const coverage: CardSyncCoverageEntry[] = [...groups.entries()].map(([key, members]) => {
    const [cardScopeId, status] = key.split(' ') as [string, 'pending' | 'posted'];
    return {
      cardScopeId,
      status,
      requested: spec.requested
        ? { start: day(spec.requested.fromDaysAgo), end: day(spec.requested.toDaysAgo), dateBasis: 'transaction' }
        : null,
      observed: cardSyncObservedRange(members, 'transaction') ?? null,
      completeness: spec.completeness,
      pageCount: 1,
      termination: spec.termination,
    };
  });
  const cards = [...new Set(spec.rows.map((row) => row.scope.last4).filter((last4): last4 is string => last4 !== null))].sort();
  const built = buildCardSyncPayloadV2({
    contractVersion: 1,
    source: spec.binding.source,
    parserVersion: `holdr-ext-${spec.binding.issuer}@0.1.0`,
    issuer: spec.binding.issuer,
    currency: 'USD',
    owner: null,
    cards,
    bindingId: spec.binding.bindingId,
    bindingVersion: spec.binding.bindingVersion,
    captureId: syncIdFor('capture', `capture/${spec.captureKey}`),
    observedAt: new Date(spec.observedAt).toISOString(),
    mode: sourceSpec.mode,
    coverage,
    rejectedCount: spec.rejectedCount ?? 0,
    statement: spec.statement ?? null,
    rows,
  });
  if (!built.ok) {
    throw new Error(`synthetic payload ${spec.captureKey} refused: ${built.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`);
  }
  return built.payload;
}

function candidate(key: string, row: RowSpec, now: number, extra: Partial<CandidateRec>): CandidateRec {
  return {
    transactionId: cardTransactionIdFor(`txn/${key}`),
    cardScopeId: row.scope.cardScopeId,
    scopeKind: row.scope.kind,
    sourceKind: 'extension',
    status: row.postedDaysAgo === null ? 'pending' : 'posted',
    transactionDate: isoDay(now - row.daysAgo * DAY),
    postedDate: row.postedDaysAgo === null ? null : isoDay(now - (row.postedDaysAgo ?? row.daysAgo) * DAY),
    amountMinor: row.amount,
    kind: row.kind ?? (row.amount < 0 ? 'refund' : 'purchase'),
    description: row.description,
    merchant: row.merchant ?? null,
    userCategory: null,
    notes: null,
    matchedOn: ['date', 'amount', 'description'],
    blockedReason: null,
    ...extra,
  };
}

/** The classifier reason an item of each category gets unless a scenario names another (E1b §2.14). */
const DEFAULT_REASONS: Record<ItemRec['category'], ReviewReason> = {
  'cross-source-similar': 'cross-source-similar',
  'no-stable-id': 'no-stable-id',
  'scope-unknown': 'unknown-scope',
  'pending-link': 'pending-may-have-posted',
  'posted-correction': 'posted-correction',
  'reconciliation-difference': 'statement-mismatch',
};

function item(
  key: string,
  category: ItemRec['category'],
  rowIndex: number | null,
  allowed: DecisionAction[],
  candidates: CandidateRec[] = [],
  reason: ReviewReason = DEFAULT_REASONS[category],
): ItemRec {
  return {
    itemId: ownerIdFor('reviewItem', `item/${key}`),
    category,
    reason,
    rowIndex,
    candidates,
    difference: null,
    allowedActions: allowed,
    decision: null,
    committed: null,
    insertedTransactionId: null,
  };
}

function setFrom(
  key: string,
  run: RunRec,
  payload: CardSyncPayloadV2,
  acceptedAt: number,
  items: ItemRec[],
  auto: Array<[number, AutoRow]>,
): SetRec {
  const id = syncIdFor('observationSet', `set/${key}`);
  run.observationSetId = id;
  return {
    observationSetId: id,
    origin: 'extension',
    runId: run.runId,
    bindingId: run.bindingId,
    deviceId: run.deviceId,
    importBatchId: null,
    cardAccountRef: run.cardAccountRef,
    version: 1,
    state: items.length > 0 ? 'needs-review' : 'accepted-uncommitted',
    acceptedAt,
    expiresAt: acceptedAt + LIMITS.retentionDays * DAY,
    payload,
    fileRows: null,
    payloadDigest: cardSyncPayloadDigest(payload),
    rowCount: payload.rows.length,
    byteCount: canonicalJsonByteLength(payload as unknown as JsonValue),
    rejectedCount: payload.rejectedCount,
    receiptExpiresAt: acceptedAt + LIMITS.receiptDays * DAY,
    items,
    autoRows: new Map(auto),
    plans: [],
    committedAt: null,
    closedAt: null,
    closeReason: null,
    discardReason: null,
    results: [],
  };
}

/** A closed set whose unledgered content is gone: only its value-free summary stays (plan §7.7). */
export function closeWithoutContent(set: SetRec, state: 'expired-unreviewed' | 'rejected', closedAt: number, reason: 'expired' | 'discarded'): void {
  set.state = state;
  set.closedAt = closedAt;
  set.closeReason = reason;
  set.payload = null;
  set.fileRows = null;
  set.items = [];
  set.autoRows = new Map();
  set.receiptExpiresAt = null;
  for (const plan of set.plans) if (plan.state === 'valid') plan.state = 'superseded';
}

function run(key: string, device: DeviceRec, binding: BindingRec, createdAt: number, extra: Partial<RunRec> = {}): RunRec {
  return {
    runId: syncIdFor('run', `run/${key}`),
    deviceId: device.deviceId,
    bindingId: binding.bindingId,
    bindingVersion: binding.bindingVersion,
    clientRunId: syncIdFor('clientRun', `client-run/${key}`),
    adapterVersion: `holdr-ext-${binding.issuer}@0.1.0`,
    contractVersion: 1,
    trigger: 'manual',
    createdAt,
    runExpiresAt: createdAt + 10 * MINUTE,
    observationSetId: null,
    errorCode: null,
    abortReason: null,
    expiredAt: null,
    cardAccountRef: binding.cardAccountRef,
    ...extra,
  };
}

function emptyStore(now: number): FakeStore {
  return {
    holdrOrigin: FAKE_HOLDR_ORIGIN,
    deviceApi: 'enabled',
    gate: 'open',
    recoveredAt: null,
    paused: false,
    pausedAt: null,
    settingsVersion: 1,
    issuers: {
      amex: { enabled: false, enabledAt: null, contractApproved: false },
      chase: { enabled: false, enabledAt: null, contractApproved: false },
      citi: { enabled: false, enabledAt: null, contractApproved: false },
      wellsfargo: { enabled: false, enabledAt: null, contractApproved: false },
    },
    cardAccounts: fakeCardAccounts(now),
    bindings: [],
    devices: [],
    pairings: [],
    runs: [],
    sets: [],
    quotaPadding: new Map(),
    ledger: emptyLedger(),
    recentAuthUntil: 0,
    counter: 0,
  };
}

/** A fresh Holdr: synthetic card accounts, nothing paired, every issuer off (plan §0: all default off). */
export function freshStore(now: number): FakeStore {
  return emptyStore(now);
}

/**
 * Four bindings, one per issuer, each in a different state of the §8 status
 * list, with a review queue holding every review category, an expired plan,
 * expiry warnings, closed sets (committed, discarded, expired) and runs
 * (with and without an exact sent object, and one Holdr refused).
 */
export function demoStore(now: number): FakeStore {
  const t = at(now);
  const store = emptyStore(now);
  const accounts = store.cardAccounts;
  for (const issuer of ['amex', 'chase', 'citi', 'wellsfargo'] as const) store.issuers[issuer] = { enabled: true, enabledAt: t(-35 * DAY), contractApproved: true };
  store.settingsVersion = 5;

  const chaseScopes = [scope('chase', "Alex's card", 'alex', '3391'), scope('chase', "Casey's card", 'casey', '7720'), unknownScope('chase')];
  const amexScopes = [scope('amex', 'Basic card', 'alex', '0003'), scope('amex', 'Supplementary card', 'casey', '3382'), unknownScope('amex')];
  const citiScopes = [scope('citi', 'Primary cardholder', 'casey', '2002'), scope('citi', 'Authorized user', 'alex', null), unknownScope('citi')];
  const wfScopes = [scope('wellsfargo', 'Card', 'joint', '4417'), unknownScope('wellsfargo')];
  const chase = binding('chase', 'chase', 'chase-api', 'Chase Sapphire', accounts[0].id, chaseScopes, t(-60 * DAY));
  const amex = binding('amex', 'amex', 'amex-api-recent', 'Amex Gold', accounts[1].id, amexScopes, t(-60 * DAY));
  const citi = binding('citi', 'citi', 'citi-api', 'Citi Double Cash', accounts[2].id, citiScopes, t(-60 * DAY));
  const wf = binding('wellsfargo', 'wellsfargo', 'wf-dom', 'Wells Fargo Active Cash', accounts[3].id, wfScopes, t(-60 * DAY));
  chase.autoSyncEligible = true;
  store.bindings = [chase, amex, citi, wf];

  const d1 = device('laptop-chrome', 'Laptop Chrome', 'active', t(-28 * DAY), [chase.bindingId, amex.bindingId, wf.bindingId], { lastSeenAt: t(-2 * HOUR) });
  const d2 = device('mac-chrome', 'Mac Chrome', 'active', t(-20 * DAY), [citi.bindingId], { lastSeenAt: t(-1 * DAY) });
  const d3 = device('laptop-edge', 'Laptop Edge', 'revoked', t(-45 * DAY), [amex.bindingId], { revokedAt: t(-32 * DAY), revokeReason: 'owner', lastSeenAt: t(-33 * DAY) });
  const d4 = device('mac-edge', 'Mac Edge', 'expired', t(-50 * DAY), [citi.bindingId], { lastSeenAt: t(-21 * DAY) });
  store.devices = [d1, d2, d3, d4];

  // Chase: a fresh capture, all stable ids, nothing to review → "Received, awaiting review".
  const r1 = run('chase-fresh', d1, chase, t(-2 * HOUR));
  const chaseRows: RowSpec[] = [
    { key: 'a', scope: chaseScopes[0], daysAgo: 3, postedDaysAgo: 2, amount: 4210, description: 'PROSEWARE BISTRO', merchant: 'Proseware Bistro', category: 'Restaurant-Dining', stableId: true },
    { key: 'b', scope: chaseScopes[0], daysAgo: 4, postedDaysAgo: 3, amount: 8723, description: 'NORTHWIND GROCERY 0042', merchant: 'Northwind Grocery', category: 'Merchandise-Groceries', stableId: true },
    { key: 'c', scope: chaseScopes[1], daysAgo: 2, postedDaysAgo: 1, amount: 2400, description: 'TAILSPIN CINEMA', merchant: 'Tailspin Cinema', category: 'Entertainment', stableId: true },
    { key: 'd', scope: chaseScopes[1], daysAgo: 2, postedDaysAgo: 1, amount: -1500, kind: 'refund', description: 'LITWARE BOOKS ONLINE RETURN', merchant: 'Litware Books', category: 'Merchandise-Books', stableId: true },
    { key: 'e', scope: chaseScopes[0], daysAgo: 1, postedDaysAgo: null, amount: 550, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', category: 'Restaurant-Coffee', stableId: true },
    // A charge an earlier capture brought, sent again with the bank's lasting id: an alias of it (E1b X37), nothing changes.
    { key: 'f', scope: chaseScopes[0], daysAgo: 5, postedDaysAgo: 4, amount: 12900, description: 'ALPINE SKI HOUSE', merchant: 'Alpine Ski House', category: 'Merchandise-Sporting Goods', stableId: true },
  ];
  const s1 = setFrom('chase-fresh', r1, buildFakePayload({
    binding: chase, rows: chaseRows, observedAt: t(-2 * HOUR - MINUTE), termination: 'end-marker', completeness: 'complete',
    requested: { fromDaysAgo: 30, toDaysAgo: 0 }, captureKey: 'chase-fresh',
  }, now), t(-2 * HOUR), [], [[0, 'insert'], [1, 'unchanged'], [2, 'insert'], [3, 'insert'], [4, 'insert'], [5, { alias: LEDGER_STORY_IDS.alpine }]]);

  // Chase, ten days ago: committed, with one "same transaction" decision the owner can still change.
  const r0 = run('chase-old', d1, chase, t(-10 * DAY));
  const oldRows: RowSpec[] = [
    { key: 'a', scope: chaseScopes[0], daysAgo: 12, postedDaysAgo: 11, amount: 6500, description: 'FABRIKAM FUEL 77', merchant: 'Fabrikam Fuel', category: 'Transportation-Fuel', stableId: true },
    { key: 'b', scope: chaseScopes[1], daysAgo: 11, postedDaysAgo: 10, amount: 12000, description: 'ADVENTURE WORKS OUTDOOR', merchant: 'Adventure Works', category: 'Merchandise-Sporting Goods', stableId: true },
  ];
  const oldItem = item('chase-old/0', 'cross-source-similar', 0, ['same-transaction', 'insert-new', 'reject-row'], [
    candidate('chase-old/fuel', oldRows[0], now, { sourceKind: 'extension', matchedOn: ['date', 'amount', 'merchant'] }),
  ]);
  oldItem.committed = { action: 'same-transaction', transactionId: oldItem.candidates[0].transactionId, cardScopeId: null, at: t(-10 * DAY + HOUR) };
  const s0 = setFrom('chase-old', r0, buildFakePayload({
    binding: chase, rows: oldRows, observedAt: t(-10 * DAY - MINUTE), termination: 'end-marker', completeness: 'complete',
    requested: { fromDaysAgo: 40, toDaysAgo: 10 }, captureKey: 'chase-old',
  }, now), t(-10 * DAY), [oldItem], [[1, 'insert']]);
  s0.state = 'committed';
  s0.committedAt = t(-10 * DAY + HOUR);
  s0.closedAt = s0.committedAt;
  s0.closeReason = 'committed';
  s0.results = [
    { rowIndex: 0, result: 'matched', transactionId: oldItem.candidates[0].transactionId },
    { rowIndex: 1, result: 'inserted', transactionId: cardTransactionIdFor('txn/chase-old/outdoor') },
  ];

  // Amex RECENT: no stable ids, so every row waits for the owner; expires in 5 days, and its plan expired.
  const r2 = run('amex', d1, amex, t(-25 * DAY));
  const amexRows: RowSpec[] = [
    { key: 'a', scope: amexScopes[0], daysAgo: 27, postedDaysAgo: 26, amount: 4210, description: 'PROSEWARE BISTRO', category: 'Restaurant-Dining' },
    { key: 'b', scope: amexScopes[1], daysAgo: 27, postedDaysAgo: 26, amount: 41200, description: 'CONTOSO AIRLINES', category: 'Travel-Airline' },
    { key: 'c', scope: amexScopes[0], daysAgo: 26, postedDaysAgo: 25, amount: 550, description: 'FOURTH COFFEE', category: 'Restaurant-Coffee' },
    { key: 'd', scope: amexScopes[0], daysAgo: 26, postedDaysAgo: 25, amount: 8723, description: 'NORTHWIND GROCERY 0042', category: 'Merchandise-Groceries' },
    { key: 'e', scope: amexScopes[2], daysAgo: 26, postedDaysAgo: 25, amount: 2400, description: 'TAILSPIN CINEMA', category: 'Entertainment' },
    { key: 'f', scope: amexScopes[0], daysAgo: 25, postedDaysAgo: 25, amount: 6000, description: 'FABRIKAM FUEL 77', category: 'Transportation-Fuel' },
  ];
  const legacyScopeId = syncIdFor('cardScope', 'scope/amex/legacy-file');
  const amexItems = [
    item('amex/legacy', 'cross-source-similar', 0, ['attribute-and-link', 'insert-new', 'reject-row'], [
      candidate('amex/legacy', amexRows[0], now, {
        sourceKind: 'file', scopeKind: 'legacy', cardScopeId: legacyScopeId,
        userCategory: 'Date night', notes: 'Anniversary dinner (synthetic)', matchedOn: ['date', 'amount', 'description'],
      }),
    ]),
    item('amex/other-card', 'cross-source-similar', 1, ['insert-new', 'reject-row'], [
      candidate('amex/other-card', { ...amexRows[1], scope: amexScopes[0] }, now, { blockedReason: 'different-known-cards', matchedOn: ['date', 'amount', 'description'] }),
    ]),
    item('amex/no-id', 'no-stable-id', 2, ['insert-new', 'reject-row']),
    item('amex/no-id-match', 'no-stable-id', 3, ['same-transaction', 'insert-new', 'reject-row'], [
      candidate('amex/no-id-match', amexRows[3], now, { matchedOn: ['date', 'amount', 'description'] }),
    ]),
    item('amex/unknown-scope', 'scope-unknown', 4, ['attribute', 'insert-new', 'reject-row']),
    item('amex/pending', 'pending-link', 5, ['same-transaction', 'insert-new', 'reject-row'], [
      candidate('amex/pending', { ...amexRows[5], postedDaysAgo: null, amount: 10000, description: 'FABRIKAM FUEL 77 PRE-AUTH' }, now, {
        matchedOn: ['date', 'merchant'],
      }),
    ]),
  ];
  const s2 = setFrom('amex', r2, buildFakePayload({
    binding: amex, rows: amexRows, observedAt: t(-25 * DAY - MINUTE), termination: 'auth-required', completeness: 'partial',
    requested: null, captureKey: 'amex',
  }, now), t(-25 * DAY), amexItems, []);
  s2.plans.push({
    previewId: syncIdFor('preview', 'preview/amex-old'),
    observationSetId: s2.observationSetId,
    setVersion: 1,
    planKind: 'set',
    payloadDigest: s2.payloadDigest,
    planDigest: 'pl1:' + 'a'.repeat(64),
    createdAt: t(-2 * DAY),
    expiresAt: t(-2 * DAY + 10 * MINUTE),
    counts: { insert: 0, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 },
    effects: [],
    state: 'expired',
    committedAt: null,
  });

  // Citi: stable ids, a posted correction and a statement difference; accepted 29 days 20 hours ago, so it expires within a day.
  const r3 = run('citi', d4, citi, t(-29 * DAY - 20 * HOUR));
  const citiRows: RowSpec[] = [
    { key: 'a', scope: citiScopes[0], daysAgo: 31, postedDaysAgo: 30, amount: 11840, description: 'WIDE WORLD UTILITIES', merchant: 'Wide World Utilities', category: 'Utilities', stableId: true },
    { key: 'b', scope: citiScopes[0], daysAgo: 31, postedDaysAgo: 31, amount: 3900, description: 'PROSEWARE BISTRO', merchant: 'Proseware Bistro', category: 'Restaurant-Dining', stableId: true },
    { key: 'c', scope: citiScopes[1], daysAgo: 30, postedDaysAgo: 30, amount: 1200, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', category: 'Restaurant-Coffee', stableId: true },
    { key: 'd', scope: citiScopes[0], daysAgo: 30, postedDaysAgo: null, amount: 2500, description: 'TAILSPIN CINEMA', merchant: 'Tailspin Cinema', category: 'Entertainment', stableId: true },
  ];
  const correction = item('citi/correction', 'posted-correction', 0, ['accept-correction', 'keep-current'], [
    candidate('citi/correction', { ...citiRows[0], amount: 11240 }, now, { matchedOn: ['posted-id'], userCategory: 'Bills' }),
  ]);
  const difference = item('citi/statement', 'reconciliation-difference', null, ['accept-difference']);
  difference.difference = { field: 'new-balance', expectedMinor: 245_000, actualMinor: 244_000 };
  const s3 = setFrom('citi', r3, buildFakePayload({
    binding: citi, rows: citiRows, observedAt: t(-29 * DAY - 20 * HOUR - MINUTE), termination: 'rate-limited', completeness: 'partial',
    requested: { fromDaysAgo: 60, toDaysAgo: 29 }, rejectedCount: 1, captureKey: 'citi',
    statement: { chargesMinor: 19_440, creditsMinor: 0, netMinor: 19_440, previousBalanceMinor: 224_560, newBalanceMinor: 245_000 },
  }, now), t(-29 * DAY - 20 * HOUR), [correction, difference], [[1, 'insert'], [2, 'insert'], [3, 'insert']]);

  // Wells Fargo: the extension opened a run three hours ago and Holdr never received anything.
  const r4 = run('wellsfargo', d1, wf, t(-3 * HOUR));

  // Closed history: an Amex set nobody reviewed in time, and a Citi set the owner discarded. Their content is gone.
  const r5 = run('amex-expired', d3, amex, t(-40 * DAY));
  const s5 = setFrom('amex-expired', r5, buildFakePayload({
    binding: amex,
    rows: [
      { key: 'a', scope: amexScopes[0], daysAgo: 42, postedDaysAgo: 41, amount: 1899, description: 'SAMPLE STREAMING', category: 'Entertainment' },
      { key: 'b', scope: amexScopes[1], daysAgo: 41, postedDaysAgo: 40, amount: 6420, description: 'NORTHWIND GROCERY 0042', category: 'Merchandise-Groceries' },
    ],
    observedAt: t(-40 * DAY - MINUTE), termination: 'snapshot', completeness: 'unknown', requested: null, captureKey: 'amex-expired',
  }, now), t(-40 * DAY), [], []);
  closeWithoutContent(s5, 'expired-unreviewed', t(-10 * DAY), 'expired');
  const r6 = run('citi-discarded', d4, citi, t(-35 * DAY));
  const s6 = setFrom('citi-discarded', r6, buildFakePayload({
    binding: citi,
    rows: [
      { key: 'a', scope: citiScopes[0], daysAgo: 37, postedDaysAgo: 36, amount: 3900, description: 'PROSEWARE BISTRO', merchant: 'Proseware Bistro', stableId: true },
      { key: 'b', scope: citiScopes[1], daysAgo: 36, postedDaysAgo: 36, amount: 1200, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', stableId: true },
    ],
    observedAt: t(-35 * DAY - MINUTE), termination: 'end-marker', completeness: 'complete', requested: { fromDaysAgo: 65, toDaysAgo: 35 },
    captureKey: 'citi-discarded',
  }, now), t(-35 * DAY), [], []);
  closeWithoutContent(s6, 'rejected', t(-33 * DAY), 'discarded');
  s6.discardReason = 'duplicate-of-file';

  // A run Holdr refused whole because the review queue was full: nothing from it is waiting anywhere.
  const r7 = run('chase-refused', d1, chase, t(-1 * DAY), { errorCode: 'review-quota-exceeded' });
  // A Wells Fargo run the extension stopped because the bank had signed out (Q4's abort reason); nothing was sent.
  const r8 = run('wellsfargo-signed-out', d1, wf, t(-1 * DAY - 2 * HOUR), { abortReason: 'not-signed-in' });

  store.runs = [r1, r4, r7, r8, r0, r6, r2, r3, r5];
  store.sets = [s1, s0, s6, s2, s3, s5];
  store.quotaPadding.set(accounts[1].id, { sets: 80, rows: 7_900, bytes: 1024 * 1024 });
  // The ledger behind the review candidates, and a few histories for the owner's repairs (proposal §3.8).
  seedLedgerFromCandidates(store);
  seedLedgerStories(store, now);
  return store;
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A letters-only tag for synthetic descriptions ("A", "B", … "AA"): no digits for the card detectors to weigh. */
function tag(index: number): string {
  let value = index;
  let text = '';
  do {
    text = ALPHA[value % 26] + text;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return text;
}

function chaseWithBrowser(store: FakeStore): { chase: BindingRec; device: DeviceRec; known: ScopeRec } {
  const chase = store.bindings.find((item) => item.issuer === 'chase' && item.status === 'confirmed');
  const device = chase && store.devices.find((item) => item.status === 'active' && item.bindingIds.includes(chase.bindingId));
  const known = chase?.scopes.find((item) => item.kind === 'known' && item.status === 'active');
  if (!chase || !device || !known) throw new Error('no confirmed Chase binding with a working browser');
  return { chase, device, known };
}

/**
 * Test history: `count` older Chase captures, each added to spending with one "same transaction" decision whose item
 * has a second possible match, so the owner can move it to the other transaction, past the first page of the lists.
 */
export function addCommittedHistory(store: FakeStore, now: number, count: number): SetRec[] {
  const { chase, device, known } = chaseWithBrowser(store);
  const added: SetRec[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = `history/${index}`;
    const acceptedAt = now - 11 * DAY - (index + 1) * HOUR;
    const daysAgo = Math.ceil((now - acceptedAt) / DAY) + 1;
    const row: RowSpec = {
      key: 'a', scope: known, daysAgo, postedDaysAgo: daysAgo - 1, amount: 1_250 + index,
      description: `SAMPLE MARKET ${tag(index)}`, merchant: 'Sample Market', category: 'Merchandise-Groceries', stableId: true,
    };
    const first = candidate(`${key}/first`, row, now, { matchedOn: ['date', 'amount', 'merchant'] });
    const second = candidate(`${key}/second`, { ...row, daysAgo: daysAgo + 1, postedDaysAgo: daysAgo }, now, { matchedOn: ['amount', 'merchant'] });
    const entry = item(`${key}/0`, 'cross-source-similar', 0, ['same-transaction', 'insert-new', 'reject-row'], [first, second]);
    entry.committed = { action: 'same-transaction', transactionId: first.transactionId, cardScopeId: null, at: acceptedAt + HOUR };
    const historyRun = run(key, device, chase, acceptedAt);
    const set = setFrom(key, historyRun, buildFakePayload({
      binding: chase, rows: [row], observedAt: acceptedAt - MINUTE, termination: 'end-marker', completeness: 'complete',
      requested: { fromDaysAgo: daysAgo + 20, toDaysAgo: daysAgo - 1 }, captureKey: key,
    }, now), acceptedAt, [entry], []);
    set.state = 'committed';
    set.committedAt = acceptedAt + HOUR;
    set.closedAt = set.committedAt;
    set.closeReason = 'committed';
    set.results = [{ rowIndex: 0, result: 'matched', transactionId: first.transactionId }];
    store.runs.push(historyRun);
    store.sets.push(set);
    added.push(set);
  }
  return added;
}

/** Test data: one open Chase capture of `rows` rows without the bank's own ids, every one waiting for a decision. */
export function addLargeOpenSet(store: FakeStore, now: number, rows: number): SetRec {
  const { chase, device, known } = chaseWithBrowser(store);
  const key = `large/${store.sets.length}`;
  const acceptedAt = now - 30 * MINUTE;
  const specs: RowSpec[] = Array.from({ length: rows }, (_row, index) => ({
    key: tag(index), scope: known, daysAgo: 2 + (index % 20), postedDaysAgo: 1 + (index % 20), amount: 300 + index,
    description: `SAMPLE KIOSK ${tag(index)}`, stableId: false,
  }));
  const largeRun = run(key, device, chase, acceptedAt);
  const items = specs.map((_spec, index) => item(`${key}/${index}`, 'no-stable-id', index, ['insert-new', 'reject-row']));
  const set = setFrom(key, largeRun, buildFakePayload({
    binding: chase, rows: specs, observedAt: acceptedAt - MINUTE, termination: 'end-marker', completeness: 'complete',
    requested: { fromDaysAgo: 30, toDaysAgo: 0 }, captureKey: key,
  }, now), acceptedAt, items, []);
  store.runs.push(largeRun);
  store.sets.push(set);
  return set;
}

/**
 * Test data for the largest adjustment: one open Chase capture of `rows` posted rows with the bank's own ids, each like a
 * pending charge an offline file import left without a card. Linking puts it on the card and promotes it at once
 * (E1b §4.6), so changing that after commit reverses both in one step per item.
 */
export function addLegacyPendingSet(store: FakeStore, now: number, rows: number): SetRec {
  const { chase, device, known } = chaseWithBrowser(store);
  const key = `legacy-pending/${store.sets.length}`;
  const acceptedAt = now - 30 * MINUTE;
  const legacy = syncIdFor('cardScope', 'scope/chase/legacy-file');
  const specs: RowSpec[] = Array.from({ length: rows }, (_row, index) => ({
    key: tag(index), scope: known, daysAgo: 2 + (index % 20), postedDaysAgo: 1 + (index % 20), amount: 300 + index,
    description: `SAMPLE STAND ${tag(index)}`, stableId: true,
  }));
  const legacyRun = run(key, device, chase, acceptedAt);
  const items = specs.map((spec, index) => item(`${key}/${index}`, 'cross-source-similar', index, ['attribute-and-link', 'insert-new', 'reject-row'], [
    candidate(`${key}/${index}`, { ...spec, postedDaysAgo: null }, now, { sourceKind: 'file', scopeKind: 'legacy', cardScopeId: legacy, matchedOn: ['date', 'amount'] }),
  ]));
  const set = setFrom(key, legacyRun, buildFakePayload({
    binding: chase, rows: specs, observedAt: acceptedAt - MINUTE, termination: 'end-marker', completeness: 'complete',
    requested: { fromDaysAgo: 30, toDaysAgo: 0 }, captureKey: key,
  }, now), acceptedAt, items, []);
  store.runs.push(legacyRun);
  store.sets.push(set);
  return set;
}

/**
 * Test data (X18/Q30): one chunk of a v1 file import's conflicts on the Amex
 * account. It waits in the owner's queue like a capture, but no browser sent
 * it: it has no run, binding or device, and its rows carry the account's
 * file-import scope. One posted row hits a pending row the bank had removed;
 * another's identity already belongs to a transaction (neither offers
 * "keep both": the tuple already exists, E1b §2.14).
 */
export function addFileReviewSet(store: FakeStore, now: number): SetRec {
  const amex = store.bindings.find((item) => item.issuer === 'amex');
  const known = amex?.scopes.find((item) => item.kind === 'known' && item.status === 'active');
  if (!amex || !known) throw new Error('no Amex binding with a known card');
  const key = `file/${store.sets.length}`;
  const acceptedAt = now - 3 * HOUR;
  const legacy = syncIdFor('cardScope', 'scope/amex/legacy-file');
  const day = (daysAgo: number) => isoDay(now - daysAgo * DAY);
  const fileRow = (daysAgo: number, amountMinor: number, description: string): RowRec => ({
    transactionDate: day(daysAgo),
    postedDate: day(daysAgo - 1),
    status: 'posted',
    amountMinor,
    kind: 'purchase',
    description,
    merchant: null,
    issuerCategory: null,
    cardScopeId: legacy,
    identity: 'legacy-file',
    originalAmountMinor: null,
    originalCurrency: null,
  });
  const fileRows = [fileRow(9, 6420, 'WINGTIP TOYS'), fileRow(7, 3150, 'BLUE YONDER AIRLINES BAG FEE')];
  const removedPending: RowSpec = { key: 'a', scope: known, daysAgo: 9, postedDaysAgo: null, amount: 6420, description: 'WINGTIP TOYS PENDING' };
  const holder: RowSpec = { key: 'b', scope: known, daysAgo: 7, postedDaysAgo: 6, amount: 3150, description: 'BLUE YONDER AIRLINES' };
  const items = [
    item(`${key}/removed`, 'pending-link', 0, ['same-transaction', 'reject-row'], [
      candidate(`${key}/removed`, removedPending, now, { status: 'removed', matchedOn: ['date', 'amount', 'merchant'] }),
    ], 'removed-hit'),
    item(`${key}/identity`, 'cross-source-similar', 1, ['same-transaction', 'reject-row'], [
      candidate(`${key}/identity`, holder, now, { matchedOn: ['amount', 'description', 'posted-id'] }),
      candidate(`${key}/identity-file`, { ...holder, description: 'BLUE YONDER AIRLINES BAG FEE' }, now, {
        sourceKind: 'file', scopeKind: 'legacy', cardScopeId: legacy, matchedOn: ['date', 'amount'],
      }),
    ], 'identity-conflict'),
  ];
  const set: SetRec = {
    observationSetId: syncIdFor('observationSet', `set/${key}`),
    origin: 'file',
    runId: null,
    bindingId: null,
    deviceId: null,
    importBatchId: importBatchIdFor(`import/${key}`),
    cardAccountRef: amex.cardAccountRef,
    version: 1,
    state: 'needs-review',
    acceptedAt,
    expiresAt: acceptedAt + LIMITS.retentionDays * DAY,
    payload: null,
    fileRows,
    payloadDigest: null,
    rowCount: fileRows.length,
    byteCount: 0,
    rejectedCount: 0,
    receiptExpiresAt: null,
    items,
    autoRows: new Map(),
    plans: [],
    committedAt: null,
    closedAt: null,
    closeReason: null,
    discardReason: null,
    results: [],
  };
  store.sets.push(set);
  return set;
}