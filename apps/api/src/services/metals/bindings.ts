import type { Database } from 'better-sqlite3';
import { METALS_NETWORKS, METALS_SOURCES, type MetalsNetwork, type MetalsSource } from '@finance-tracker/shared/metals-ledger';

import { digest } from '../amazon/policy.js';
import { checkingSchemaState } from '../checking/schema.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { HEX64, MetalsRefusal, checkWriteContext, lettersOfHex, newMetalsId, sha256Hex } from './common.js';
import { METALS_BINDING_PURPOSES, METALS_SCHEMA_DIGEST, requireMetalsSchema } from './schema.js';
import { canonicalFileText, canonicalJson } from './versions.js';

/**
 * Payment-identity bindings (design v8 §4.4.4, §4.4.5, §7): a card identity (source, network, last 4) reaches a Holdr card
 * account, and a payout destination (source, last 4) a checking account, only through a binding Root approved.
 *
 * - `proposeMetalsBindings` (read-only) lists every identity the imported data names, each with the Holdr accounts of its
 *   kind whose last 4 match (by id, any status), and the inventory digest: every card and checking account's id,
 *   issuer or institution, owner, last 4 and status. The proposal is an owner-only file.
 * - `approveMetalsBindings` activates exactly the pairs a Root GO names, pinned to the proposal's SHA-256 and the
 *   inventory digest; any account change since the proposal refuses it (`metals-inventory-changed`). Each binding keeps
 *   what its drift is judged against when read: the bound account's status and owner at approval, and the ids of every
 *   account of its kind with that last 4 (`peer_account_ids`).
 * - `revokeMetalsBindings` revokes exactly the bindings a Root GO names.
 * Drift itself is computed when read (G3), never here.
 */

export const METALS_BINDING_PROPOSAL_FORMAT = 'holdr.metals-binding-proposal' as const;
export type MetalsBindingKind = 'card' | 'checking';
export type MetalsBindingPurpose = (typeof METALS_BINDING_PURPOSES)[number];

export interface MetalsPaymentIdentity {
  kind: MetalsBindingKind;
  source: MetalsSource;
  /** A card's network; null for a payout destination. */
  network: MetalsNetwork | null;
  last4: string;
}

export interface MetalsBindingCandidate {
  accountId: string;
  status: string;
  /** A card account's issuer slug, or a checking account's institution slug. */
  issuer: string;
}

export interface MetalsBindingProposalIdentity extends MetalsPaymentIdentity {
  /** The account an active binding already gives this identity, if any. */
  activeAccountId: string | null;
  candidates: MetalsBindingCandidate[];
}

export interface MetalsBindingProposal {
  format: typeof METALS_BINDING_PROPOSAL_FORMAT;
  version: 1;
  databaseRef: string;
  schemaDigest: string;
  inventoryDigest: string;
  identities: MetalsBindingProposalIdentity[];
}

export interface MetalsBindingProposalSummary {
  identities: number;
  card: number;
  checking: number;
  withoutCandidates: number;
  oneCandidate: number;
  severalCandidates: number;
  bound: number;
  /** Card methods and payout destinations with no last 4, which no binding can reach. */
  unidentified: number;
}

export interface MetalsBindingPair extends MetalsPaymentIdentity {
  accountId: string;
}

/** What a Root GO approves: the pairs it names, pinned to the proposal's SHA-256 and inventory digest (lowercase hex). */
export interface MetalsBindingApproval {
  proposalSha256: string;
  inventoryDigest: string;
  pairs: MetalsBindingPair[];
}

export interface MetalsBindingContext {
  now: string;
  goId: string;
  purpose: MetalsBindingPurpose;
  planDigest: string | null;
}

interface InventoryAccount {
  kind: MetalsBindingKind;
  id: string;
  issuer: string;
  owner: string | null;
  last4: string | null;
  status: string;
}

interface Inventory {
  checking: 'present' | 'absent';
  accounts: InventoryAccount[];
}

const MAX_PAIRS = 100;
const LAST4 = /^[0-9]{4}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BINDING_ID = /^mtl-bind-[a-p]{32}$/;
const identityKey = (identity: MetalsPaymentIdentity) => `${identity.kind}|${identity.source}|${identity.network ?? ''}|${identity.last4}`;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every Holdr card account, and every checking account when the checking tables are installed. */
export function readMetalsInventory(db: Database): Inventory {
  const cardsInstalled = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'card_accounts'`).get() !== undefined;
  const cards = cardsInstalled
    ? (db.prepare('SELECT id, issuer, owner, last4, status FROM card_accounts ORDER BY id').all() as Array<Omit<InventoryAccount, 'kind'>>)
    : [];
  const checkingState = checkingSchemaState(db);
  if (checkingState === 'conflict') throw new MetalsRefusal('metals-checking-conflict');
  const checking = checkingState === 'present'
    ? (db.prepare('SELECT id, institution AS issuer, NULL AS owner, last4, status FROM checking_accounts ORDER BY id').all() as Array<Omit<InventoryAccount, 'kind'>>)
    : [];
  return {
    checking: checkingState,
    accounts: [...cards.map((account) => ({ kind: 'card' as const, ...account })), ...checking.map((account) => ({ kind: 'checking' as const, ...account }))],
  };
}

/** The inventory digest (lowercase hex): any change to an account's id, issuer, owner, last 4 or status changes it. */
export function metalsInventoryDigest(inventory: Inventory): string {
  return digest({
    format: 'holdr.metals-binding-inventory', version: 1, checking: inventory.checking,
    accounts: inventory.accounts.map(({ kind, id, issuer, owner, last4, status }) => ({ kind, id, issuer, owner, last4, status })),
  });
}

/** Every payment identity the imported data names: card tenders and competitors' card methods, and payout destinations. */
function readIdentities(db: Database): { identities: MetalsPaymentIdentity[]; unidentified: number } {
  const cards = db.prepare(`SELECT o.source AS source, t.network AS network, t.last4 AS last4 FROM metals_tenders t
      JOIN metals_orders o ON o.order_key = t.order_key WHERE t.kind IN ('card', 'card-refund') AND t.last4 IS NOT NULL
    UNION SELECT source, network, last4 FROM metals_competitors WHERE last4 IS NOT NULL`).all() as Array<{ source: MetalsSource; network: MetalsNetwork; last4: string }>;
  const payouts = db.prepare(`SELECT DISTINCT o.source AS source, p.destination_last4 AS last4 FROM metals_payouts p
      JOIN metals_orders o ON o.order_key = p.order_key WHERE p.destination_last4 IS NOT NULL`).all() as Array<{ source: MetalsSource; last4: string }>;
  const unidentified = (db.prepare(`SELECT
      (SELECT count(*) FROM metals_tenders WHERE kind IN ('card', 'card-refund') AND last4 IS NULL)
    + (SELECT count(*) FROM metals_competitors WHERE last4 IS NULL)
    + (SELECT count(*) FROM metals_payouts WHERE destination_last4 IS NULL)`).pluck().get() as number);
  const identities: MetalsPaymentIdentity[] = [
    ...cards.map((row) => ({ kind: 'card' as const, source: row.source, network: row.network, last4: row.last4 })),
    ...payouts.map((row) => ({ kind: 'checking' as const, source: row.source, network: null, last4: row.last4 })),
  ];
  identities.sort((a, b) => compareText(identityKey(a), identityKey(b)));
  return { identities, unidentified };
}

function activeBindings(db: Database): Map<string, { bindingId: string; accountId: string }> {
  const rows = db.prepare(`SELECT binding_id AS bindingId, kind, source, network, last4, account_id AS accountId FROM metals_bindings
    WHERE state = 'active'`).all() as Array<MetalsPaymentIdentity & { bindingId: string; accountId: string }>;
  return new Map(rows.map((row) => [identityKey(row), { bindingId: row.bindingId, accountId: row.accountId }]));
}

const candidatesOf = (inventory: Inventory, identity: MetalsPaymentIdentity): InventoryAccount[] =>
  inventory.accounts.filter((account) => account.kind === identity.kind && account.last4 === identity.last4);

/** The proposal (an owner-only file) and its value-free summary. Read-only; requires the installed tables. */
export function proposeMetalsBindings(db: Database, databaseRef: string): { proposal: MetalsBindingProposal; summary: MetalsBindingProposalSummary } {
  requireMetalsSchema(db);
  try {
    return db.transaction(() => {
      const inventory = readMetalsInventory(db);
      const { identities, unidentified } = readIdentities(db);
      const active = activeBindings(db);
      const listed = identities.map((identity): MetalsBindingProposalIdentity => ({
        ...identity,
        activeAccountId: active.get(identityKey(identity))?.accountId ?? null,
        candidates: candidatesOf(inventory, identity).map((account) => ({ accountId: account.id, status: account.status, issuer: account.issuer })),
      }));
      const proposal: MetalsBindingProposal = {
        format: METALS_BINDING_PROPOSAL_FORMAT, version: 1, databaseRef, schemaDigest: METALS_SCHEMA_DIGEST,
        inventoryDigest: metalsInventoryDigest(inventory), identities: listed,
      };
      const summary: MetalsBindingProposalSummary = {
        identities: listed.length,
        card: listed.filter((identity) => identity.kind === 'card').length,
        checking: listed.filter((identity) => identity.kind === 'checking').length,
        withoutCandidates: listed.filter((identity) => identity.candidates.length === 0).length,
        oneCandidate: listed.filter((identity) => identity.candidates.length === 1).length,
        severalCandidates: listed.filter((identity) => identity.candidates.length > 1).length,
        bound: listed.filter((identity) => identity.activeAccountId !== null).length,
        unidentified,
      };
      return { proposal, summary };
    })();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('propose metals bindings', error);
  }
}

/** The proposal file's canonical text; its SHA-256 is what an approval names. */
export const serializeMetalsBindingProposal = (proposal: MetalsBindingProposal): string => canonicalFileText(proposal);

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Rec =>
  isRecord(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function validIdentity(value: Rec): boolean {
  const kind = value.kind;
  if (kind !== 'card' && kind !== 'checking') return false;
  if (!(METALS_SOURCES as readonly unknown[]).includes(value.source) || typeof value.last4 !== 'string' || !LAST4.test(value.last4)) return false;
  return kind === 'card'
    ? (METALS_NETWORKS as readonly unknown[]).includes(value.network)
    : value.network === null && value.source === 'collectpure';
}

/** A proposal file's content, checked by shape and type; never trusted for anything the database can recompute. */
export function validMetalsBindingProposal(value: unknown): MetalsBindingProposal {
  const refuse = (): never => { throw new MetalsRefusal('metals-proposal-invalid'); };
  if (!exactKeys(value, ['format', 'version', 'databaseRef', 'schemaDigest', 'inventoryDigest', 'identities'])) return refuse();
  if (value.format !== METALS_BINDING_PROPOSAL_FORMAT || value.version !== 1) return refuse();
  for (const field of ['databaseRef', 'schemaDigest', 'inventoryDigest'] as const) {
    if (typeof value[field] !== 'string' || !HEX64.test(value[field] as string)) return refuse();
  }
  if (!Array.isArray(value.identities) || value.identities.length > 100_000) return refuse();
  for (const identity of value.identities) {
    if (!exactKeys(identity, ['kind', 'source', 'network', 'last4', 'activeAccountId', 'candidates']) || !validIdentity(identity)) return refuse();
    if (identity.activeAccountId !== null && (typeof identity.activeAccountId !== 'string' || !ACCOUNT_ID.test(identity.activeAccountId))) return refuse();
    if (!Array.isArray(identity.candidates) || identity.candidates.length > 1000) return refuse();
    for (const candidate of identity.candidates) {
      if (!exactKeys(candidate, ['accountId', 'status', 'issuer']) || typeof candidate.accountId !== 'string' || !ACCOUNT_ID.test(candidate.accountId)
        || (candidate.status !== 'active' && candidate.status !== 'closed') || typeof candidate.issuer !== 'string'
        || !/^[\x21-\x7E][\x20-\x7E]{0,31}$/.test(candidate.issuer)) return refuse();
    }
  }
  return value as unknown as MetalsBindingProposal;
}

/** A GO's `pairs`: 1 to 100 exact `{ kind, source, network, last4, accountId }` entries, no identity twice. */
export function metalsBindingPairs(value: unknown): MetalsBindingPair[] {
  const refuse = (): never => { throw new MetalsRefusal('metals-pairs-invalid'); };
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAIRS) return refuse();
  const pairs = value.map((pair): MetalsBindingPair => {
    if (!exactKeys(pair, ['kind', 'source', 'network', 'last4', 'accountId']) || !validIdentity(pair)
      || typeof pair.accountId !== 'string' || !ACCOUNT_ID.test(pair.accountId)) return refuse();
    return { kind: pair.kind, source: pair.source, network: pair.network, last4: pair.last4, accountId: pair.accountId } as MetalsBindingPair;
  });
  if (new Set(pairs.map(identityKey)).size !== pairs.length) return refuse();
  return pairs;
}

/** A GO's `bindingIds`: 1 to 100 distinct binding ids. */
export function metalsBindingIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAIRS
    || value.some((id) => typeof id !== 'string' || !BINDING_ID.test(id)) || new Set(value).size !== value.length) {
    throw new MetalsRefusal('metals-binding-ids-invalid');
  }
  return [...value] as string[];
}

export interface MetalsBindingApprovalPlan {
  proposalSha256: string;
  activated: number;
  alreadyActive: number;
  card: number;
  checking: number;
  closedAccounts: number;
  planDigest: string;
}

export interface MetalsBindingApprovalReceipt extends MetalsBindingApprovalPlan {
  code: 'metals-bindings-approved' | 'metals-bindings-already-active';
}

interface ApprovalRow {
  pair: MetalsBindingPair;
  status: string;
  owner: string | null;
  peers: string[];
}

function prepareApproval(db: Database, proposal: MetalsBindingProposal, approval: MetalsBindingApproval, databaseRef: string):
  { rows: ApprovalRow[]; plan: MetalsBindingApprovalPlan } {
  const checked = validMetalsBindingProposal(structuredClone(proposal));
  const pairs = metalsBindingPairs(approval.pairs);
  if (typeof approval.proposalSha256 !== 'string' || approval.proposalSha256 !== sha256Hex(serializeMetalsBindingProposal(checked))
    || approval.inventoryDigest !== checked.inventoryDigest || checked.databaseRef !== databaseRef || checked.schemaDigest !== METALS_SCHEMA_DIGEST) {
    throw new MetalsRefusal('metals-proposal-mismatch');
  }
  const inventory = readMetalsInventory(db);
  if (metalsInventoryDigest(inventory) !== checked.inventoryDigest) throw new MetalsRefusal('metals-inventory-changed');
  const proposed = new Map(checked.identities.map((identity) => [identityKey(identity), identity]));
  const active = activeBindings(db);
  const rows: ApprovalRow[] = [];
  let alreadyActive = 0;
  for (const pair of pairs) {
    const identity = proposed.get(identityKey(pair));
    if (!identity || !identity.candidates.some((candidate) => candidate.accountId === pair.accountId)) throw new MetalsRefusal('metals-pairs-invalid');
    const bound = active.get(identityKey(pair));
    if (bound && bound.accountId === pair.accountId) {
      alreadyActive += 1;
      continue;
    }
    if (bound) throw new MetalsRefusal('metals-binding-conflict');
    const peers = candidatesOf(inventory, pair);
    const account = peers.find((candidate) => candidate.id === pair.accountId);
    if (!account) throw new MetalsRefusal('metals-inventory-changed');
    rows.push({ pair, status: account.status, owner: account.owner, peers: peers.map((peer) => peer.id).sort(compareText) });
  }
  const plan: MetalsBindingApprovalPlan = {
    proposalSha256: approval.proposalSha256,
    activated: rows.length,
    alreadyActive,
    card: rows.filter((row) => row.pair.kind === 'card').length,
    checking: rows.filter((row) => row.pair.kind === 'checking').length,
    closedAccounts: rows.filter((row) => row.status === 'closed').length,
    planDigest: digest({ proposalSha256: approval.proposalSha256, inventoryDigest: checked.inventoryDigest,
      rows: rows.map((row) => [identityKey(row.pair), row.pair.accountId, row.status, row.owner, row.peers]), alreadyActive }),
  };
  return { rows, plan };
}

/** Read-only: what approving the pairs would do, or the refusal it would meet. */
export function planMetalsBindingApproval(db: Database, proposal: MetalsBindingProposal, approval: MetalsBindingApproval, databaseRef: string):
  MetalsBindingApprovalPlan {
  requireMetalsSchema(db);
  try {
    return db.transaction(() => prepareApproval(db, proposal, approval, databaseRef).plan)();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('plan metals bindings', error);
  }
}

/** Activates exactly the approved pairs (inside the operator's backed-up IMMEDIATE transaction, or one of its own). */
export function approveMetalsBindings(db: Database, proposal: MetalsBindingProposal, approval: MetalsBindingApproval,
  context: MetalsBindingContext & { databaseRef: string }): MetalsBindingApprovalReceipt {
  checkWriteContext(context, METALS_BINDING_PURPOSES);
  if (context.planDigest !== null && (typeof context.planDigest !== 'string' || !HEX64.test(context.planDigest))) {
    throw new MetalsRefusal('metals-plan-digest-invalid');
  }
  requireMetalsSchema(db);
  try {
    return db.transaction((): MetalsBindingApprovalReceipt => {
      const { rows, plan } = prepareApproval(db, proposal, approval, context.databaseRef);
      if (context.planDigest !== null && plan.planDigest !== context.planDigest) throw new MetalsRefusal('metals-plan-changed');
      if (rows.length === 0) return { code: 'metals-bindings-already-active', ...plan };
      const insert = db.prepare(`INSERT INTO metals_bindings (binding_id, kind, source, network, last4, account_id, account_status, account_owner,
        peer_account_ids, proposal_sha256, inventory_digest, approved_go_id, approved_purpose, approved_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
      for (const row of rows) {
        insert.run(newMetalsId('mtl-bind-'), row.pair.kind, row.pair.source, row.pair.network, row.pair.last4, row.pair.accountId, row.status,
          row.owner, canonicalJson(row.peers), lettersOfHex(approval.proposalSha256), lettersOfHex(approval.inventoryDigest),
          lettersOfHex(context.goId), context.purpose, context.now);
      }
      return { code: 'metals-bindings-approved', ...plan };
    }).immediate();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('approve metals bindings', error);
  }
}

export interface MetalsBindingRevocationPlan {
  revoked: number;
  alreadyRevoked: number;
  planDigest: string;
}

export interface MetalsBindingRevocationReceipt extends MetalsBindingRevocationPlan {
  code: 'metals-bindings-revoked' | 'metals-bindings-already-revoked';
}

function prepareRevocation(db: Database, bindingIds: readonly string[]): { active: string[]; plan: MetalsBindingRevocationPlan } {
  const ids = metalsBindingIds(bindingIds);
  const state = db.prepare('SELECT state FROM metals_bindings WHERE binding_id = ?').pluck();
  const states = ids.map((id) => state.get(id) as string | undefined);
  if (states.some((value) => value === undefined)) throw new MetalsRefusal('metals-binding-unknown');
  const active = ids.filter((_, index) => states[index] === 'active').sort(compareText);
  return { active, plan: { revoked: active.length, alreadyRevoked: ids.length - active.length, planDigest: digest({ revoke: active }) } };
}

/** Read-only: what revoking the bindings would do. */
export function planMetalsBindingRevocation(db: Database, bindingIds: readonly string[]): MetalsBindingRevocationPlan {
  requireMetalsSchema(db);
  try {
    return db.transaction(() => prepareRevocation(db, bindingIds).plan)();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('plan metals revocation', error);
  }
}

/** Revokes exactly the named active bindings; nothing is deleted. */
export function revokeMetalsBindings(db: Database, bindingIds: readonly string[], context: MetalsBindingContext): MetalsBindingRevocationReceipt {
  checkWriteContext(context, METALS_BINDING_PURPOSES);
  if (context.planDigest !== null && (typeof context.planDigest !== 'string' || !HEX64.test(context.planDigest))) {
    throw new MetalsRefusal('metals-plan-digest-invalid');
  }
  requireMetalsSchema(db);
  try {
    return db.transaction((): MetalsBindingRevocationReceipt => {
      const { active, plan } = prepareRevocation(db, bindingIds);
      if (context.planDigest !== null && plan.planDigest !== context.planDigest) throw new MetalsRefusal('metals-plan-changed');
      if (active.length === 0) return { code: 'metals-bindings-already-revoked', ...plan };
      const revoke = db.prepare(`UPDATE metals_bindings SET state = 'revoked', revoked_go_id = ?, revoked_at = ? WHERE binding_id = ? AND state = 'active'`);
      for (const id of active) {
        if (revoke.run(lettersOfHex(context.goId), context.now, id).changes !== 1) throw new MetalsRefusal('metals-plan-changed');
      }
      return { code: 'metals-bindings-revoked', ...plan };
    }).immediate();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('revoke metals bindings', error);
  }
}
