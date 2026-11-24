import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { cardImportTextProblem } from '@finance-tracker/shared';
import {
  RETAIL_CARD_TENDER_KINDS,
  serializeRetailImportPayload,
  validateRetailImportPayload,
  type RetailHeldRecord,
  type RetailImportPayload,
  type RetailImportReceipt,
} from '@finance-tracker/shared/retail-import-payload';

import { digest } from '../amazon/policy.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { RetailRefusal, checkRetailWriteContext, newRetailId, retailIdPattern, retailLetters, type RetailWriteContext } from './common.js';
import { insertRetailReceipt, retailReceiptByKey, retailReceiptByRef, retailStoredVersion, retailVersionByDigests, storeRetailVersion,
  type RetailStoredReceipt } from './identity.js';
import { appendRetailEvent, retailEvidence, retailEvidenceDigest, retailHoldEvent, retailUnresolvedHolds } from './receipts.js';
import {
  RETAIL_HELD_CLASSES,
  RETAIL_MEMBERSHIP_IDENTITY_FIELDS,
  RETAIL_OUTCOMES,
  RETAIL_OWNERS,
  RETAIL_SCHEMA_DIGEST,
  RETAIL_WRITTEN_OUTCOMES,
  appendRetailAudit,
  requireRetailSchema,
  retailCountColumn,
  type RetailHeldClass,
  type RetailImportOutcome,
  type RetailMembershipFactField,
  type RetailOutcome,
  type RetailOwner,
} from './schema.js';
import {
  RETAIL_BUILD_LABELS,
  RETAIL_POLICY_DIGEST,
  classifyRetailSighting,
  retailCapturedAt,
  retailStorageProblems,
  retailVersionOf,
  type RetailSightingDecision,
  type RetailVersionComparable,
} from './versions.js';

/**
 * `holdr-retail import` (plan v5 §5): one `holdr.retail-import` payload (format 3, policy 5) of one membership.
 *
 * Preflight, before any backup (§5.1): the validator (`retail-payload-invalid`), the storage check
 * (`retail-payload-unstorable`), the schema present and no stored reserved value (`retail-reserved-value`), the same payload
 * again (`retail-already-imported`), the membership and its identity evidence (§5.4), and each receipt's outcome against
 * its canonical version (§5.3), each hold's class (§5.5). The plan's digest covers the schema and policy digests, the
 * payload's SHA-256, the membership decision and every receipt's and hold's outcome, target refs and evidence digest; the
 * write plans again inside its IMMEDIATE transaction and writes only if the digest is the preflight's
 * (`retail-plan-changed`). Natural keys enter the digest, never the output.
 *
 * The write (§5.6): the import and its coverage; the membership's registration (if new) and its stated facts; held
 * records; new identities, versions and facts; observations; receipt events, each with the selection it sets; one audit
 * row. No outcome, event or count the importer writes is reserved (§5.7): their types exclude them.
 */

export const RETAIL_DECLARATION_FORMAT = 'holdr.retail-membership-declaration' as const;
/** A declaration's keys, exactly (the CLI checks the key set with the shared `exactKeys`). */
export const RETAIL_DECLARATION_KEYS = ['format', 'version', 'merchant', 'folder', 'owner', 'label'] as const;

/** A membership's declaration (§5.4): its folder, owner and label, which no captured fact changes. */
export interface RetailDeclaration {
  format: typeof RETAIL_DECLARATION_FORMAT;
  version: 1;
  merchant: 'costco';
  folder: string;
  owner: RetailOwner;
  label: string;
}

/** A declaration and its file's SHA-256 (lowercase hex), which an import's GO names. */
export interface RetailDeclarationInput {
  declaration: RetailDeclaration;
  sha256: string;
}

/** The membership a GO names: a registered one by its ref, or a new one by its declaration's SHA-256. */
export type RetailMembershipChoice = { membershipRef: string } | { declarationSha256: string };
/** What the import does with its membership: reads it under a registered one, or registers its declaration. */
export type RetailMembershipDecision = { kind: 'registered'; membershipRef: string } | { kind: 'register'; declarationSha256: string };

/** A membership folder, as the payload validator reads `membership.folder` (a pin test holds the two equal). */
export const RETAIL_FOLDER = /^costco(?:-[1-9][0-9]{0,2})?$/;
const LABEL = /^[A-Za-z][A-Za-z0-9 ()._-]{0,59}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MEMBERSHIP_REF = retailIdPattern('rtl-mbr-');

/**
 * A declaration's values (§5.4), the key set already checked: the format and version, merchant `costco`, a folder of the
 * payload's shape, an owner Holdr knows and a short plain label (the database's CHECK, and the card-import text check).
 * Anything else is `retail-declaration-invalid`.
 */
export function retailDeclarationOf(value: Record<string, unknown>): RetailDeclaration {
  const label = value.label;
  if (value.format !== RETAIL_DECLARATION_FORMAT || value.version !== 1 || value.merchant !== 'costco'
    || typeof value.folder !== 'string' || !RETAIL_FOLDER.test(value.folder)
    || typeof value.owner !== 'string' || !(RETAIL_OWNERS as readonly string[]).includes(value.owner)
    || typeof label !== 'string' || !LABEL.test(label) || label !== label.trim() || label.includes('  ') || /[0-9]{5}/.test(label)
    || cardImportTextProblem(label, 60) !== null) {
    throw new RetailRefusal('retail-declaration-invalid');
  }
  return { format: RETAIL_DECLARATION_FORMAT, version: 1, merchant: 'costco', folder: value.folder, owner: value.owner as RetailOwner, label };
}

/** A GO's `membership`, exactly `{ membershipRef }` or `{ declarationSha256 }`; anything else is `retail-go-invalid`. */
export function retailMembershipChoice(value: unknown): RetailMembershipChoice {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const record = value as Record<string, unknown>;
    if (keys.length === 1 && keys[0] === 'membershipRef' && typeof record.membershipRef === 'string' && MEMBERSHIP_REF.test(record.membershipRef)) {
      return { membershipRef: record.membershipRef };
    }
    if (keys.length === 1 && keys[0] === 'declarationSha256' && typeof record.declarationSha256 === 'string' && HEX64.test(record.declarationSha256)) {
      return { declarationSha256: record.declarationSha256 };
    }
  }
  throw new RetailRefusal('retail-go-invalid');
}

export interface RetailImportRequest {
  /** The parsed payload; validated again here, whoever made it. */
  payload: unknown;
  /** The membership's declaration, for a folder not yet registered; else null. */
  declaration: RetailDeclarationInput | null;
  /** What the GO names; null for a plan or the preview, which no GO authorizes. */
  membership: RetailMembershipChoice | null;
}

export interface RetailImportContext extends RetailWriteContext {
  /** The GO's `inputSha256` (lowercase hex): any other payload is `retail-input-mismatch`. */
  inputSha256: string;
  /** The preflight plan's digest: a different plan inside the write is `retail-plan-changed`. Null plans and writes at once. */
  planDigest: string | null;
}

export interface RetailImportPlan {
  /** Lowercase hex SHA-256 of the payload's canonical bytes (what the GO names). */
  inputSha256: string;
  alreadyImported: boolean;
  /** The import that already holds this payload, or (in a receipt) the new one. */
  importId: string | null;
  /** Null when the payload is already imported. */
  membership: RetailMembershipDecision | null;
  receipts: number;
  outcomes: Record<RetailImportOutcome, number>;
  held: Record<RetailHeldClass, number>;
  /** Pairs of memberships whose shared identity facts are all equal (§5.4, D-R3-3): counted, never merged or refused. */
  possibleOverlap: number;
  /** Distinct card identities (network, last four) the payload's card tenders name with no active binding. */
  cardLast4sUnbound: number;
  /** Lowercase hex. */
  planDigest: string;
}

export interface RetailImportResult extends RetailImportPlan {
  code: 'retail-imported' | 'retail-already-imported';
  importSeq: number | null;
}

interface Entry {
  receipt: RetailImportReceipt;
  stored: RetailStoredReceipt | null;
  version: RetailVersionComparable;
  existingVersion: string | null;
  decision: RetailSightingDecision;
  evidenceDigest: string | null;
  pendingHolds: string[];
}

interface HeldEntry {
  held: RetailHeldRecord;
  heldClass: RetailHeldClass;
  target: RetailStoredReceipt | null;
  evidenceDigest: string | null;
}

interface Prepared {
  payload: RetailImportPayload;
  capturedAt: string;
  membership: RetailMembershipDecision | null;
  declaration: RetailDeclarationInput | null;
  facts: Array<[RetailMembershipFactField, string]>;
  entries: Entry[];
  held: HeldEntry[];
  /** Every outcome's count, the reserved one included: the storage shape (always 0 for `progression`, §5.7). */
  counts: Record<RetailOutcome, number>;
  plan: RetailImportPlan;
}

/** The payload validated by the shared validator, or a refusal naming paths and fixed messages only. */
export function validRetailPayload(value: unknown): RetailImportPayload {
  const validation = validateRetailImportPayload(value);
  if (!validation.ok) {
    throw new RetailRefusal('retail-payload-invalid', { issues: validation.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
  }
  return validation.payload;
}

/** Lowercase hex SHA-256 of a validated payload's canonical bytes: what a GO for its import names. */
export const retailPayloadSha256 = (payload: RetailImportPayload): string =>
  createHash('sha256').update(serializeRetailImportPayload(payload), 'utf8').digest('hex');

/** The payload, validated and storable, before anything is read: else `retail-payload-invalid` or `retail-payload-unstorable`. */
function checkedPayload(value: unknown): { payload: RetailImportPayload; inputSha256: string; capturedAt: string } {
  const payload = validRetailPayload(value);
  const problems = retailStorageProblems(payload);
  const capturedAt = retailCapturedAt(payload.source.capturedAt);
  if (problems.length > 0 || capturedAt === null) throw new RetailRefusal('retail-payload-unstorable', { paths: problems });
  return { payload, inputSha256: retailPayloadSha256(payload), capturedAt };
}

const statedFacts = (payload: RetailImportPayload): Array<[RetailMembershipFactField, string]> => {
  const facts: Array<[RetailMembershipFactField, string | null]> = [
    ['member-since-year', payload.membership.memberSinceYear],
    ['membership-last4', payload.membership.membershipLast4],
    ['tier', payload.membership.tier],
  ];
  return facts.filter((fact): fact is [RetailMembershipFactField, string] => fact[1] !== null);
};

/**
 * The membership (§5.4). A registered folder: the GO names its ref (another folder's or no membership's ref is
 * `retail-membership-unknown`), and a declaration, in the request or the GO, is `retail-membership-declared-twice`. A
 * folder not yet registered needs its declaration (`retail-membership-undeclared`), of the payload's merchant and folder
 * (`retail-declaration-mismatch`), whose SHA-256 the GO names (`retail-input-mismatch`). A plan or the preview, with no
 * GO, gets the same decision without the GO's pins.
 */
function resolveMembership(db: Database.Database, payload: RetailImportPayload, declaration: RetailDeclarationInput | null,
  choice: RetailMembershipChoice | null): RetailMembershipDecision {
  const registered = db.prepare('SELECT membership_ref FROM retail_memberships WHERE merchant = ? AND folder = ?').pluck()
    .get(payload.merchant, payload.membership.folder) as string | undefined;
  if (registered !== undefined) {
    if (declaration !== null || (choice !== null && 'declarationSha256' in choice)) throw new RetailRefusal('retail-membership-declared-twice');
    if (choice !== null && choice.membershipRef !== registered) throw new RetailRefusal('retail-membership-unknown');
    return { kind: 'registered', membershipRef: registered };
  }
  if (choice !== null && 'membershipRef' in choice) throw new RetailRefusal('retail-membership-unknown');
  if (declaration === null) throw new RetailRefusal('retail-membership-undeclared');
  if (declaration.declaration.merchant !== payload.merchant || declaration.declaration.folder !== payload.membership.folder) {
    throw new RetailRefusal('retail-declaration-mismatch');
  }
  if (choice !== null && choice.declarationSha256 !== declaration.sha256) throw new RetailRefusal('retail-input-mismatch');
  return { kind: 'register', declarationSha256: declaration.sha256 };
}

/**
 * Identity evidence (§5.4, Q-M2): each identity fact the payload states must equal every value of that field the
 * membership's earlier imports stated (`retail-membership-conflict`, naming the field only). An absent fact stays unknown;
 * the tier is an attribute, recorded and never compared.
 */
function checkIdentityFacts(db: Database.Database, membership: RetailMembershipDecision, facts: Array<[RetailMembershipFactField, string]>): void {
  if (membership.kind !== 'registered') return;
  const accepted = db.prepare('SELECT DISTINCT value FROM retail_membership_facts WHERE membership_ref = ? AND field = ?').pluck();
  for (const [field, value] of facts) {
    if (!(RETAIL_MEMBERSHIP_IDENTITY_FIELDS as readonly string[]).includes(field)) continue;
    if ((accepted.all(membership.membershipRef, field) as string[]).some((known) => known !== value)) {
      throw new RetailRefusal('retail-membership-conflict', { field });
    }
  }
}

/**
 * Pairs of memberships, by folder, whose identity facts known to both are all equal, with at least one known to both
 * (§5.4, D-R3-3): a value-free count, which nothing refuses, merges or links. `incoming` is a membership the plan would
 * register.
 */
export function retailPossibleOverlaps(db: Database.Database, incoming: { folder: string; facts: Array<[string, string]> } | null = null): number {
  const rows = db.prepare(`SELECT m.folder AS folder, f.field AS field, f.value AS value FROM retail_memberships m
      LEFT JOIN retail_membership_facts f ON f.membership_ref = m.membership_ref AND f.field IN ('member-since-year', 'membership-last4')`)
    .all() as Array<{ folder: string; field: string | null; value: string | null }>;
  const memberships = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const facts = memberships.get(row.folder) ?? new Map<string, string>();
    if (row.field !== null && row.value !== null) facts.set(row.field, row.value);
    memberships.set(row.folder, facts);
  }
  if (incoming !== null && !memberships.has(incoming.folder)) {
    memberships.set(incoming.folder, new Map(incoming.facts.filter(([field]) => (RETAIL_MEMBERSHIP_IDENTITY_FIELDS as readonly string[]).includes(field))));
  }
  const all = [...memberships.values()];
  let pairs = 0;
  for (let a = 0; a < all.length; a += 1) {
    for (let b = a + 1; b < all.length; b += 1) {
      const shared = [...all[a].keys()].filter((field) => all[b].has(field));
      if (shared.length > 0 && shared.every((field) => all[a].get(field) === all[b].get(field))) pairs += 1;
    }
  }
  return pairs;
}

/** Distinct (network, last four) of the payload's card and card-refund tenders with no active binding (§8.1). */
function unboundCardIdentities(db: Database.Database, payload: RetailImportPayload): number {
  const identities = new Set<string>();
  for (const receipt of payload.receipts) {
    for (const tender of receipt.tenders) {
      if (RETAIL_CARD_TENDER_KINDS.includes(tender.kind) && tender.last4 !== null) identities.add(JSON.stringify([tender.network, tender.last4]));
    }
  }
  const bound = db.prepare(`SELECT 1 FROM retail_bindings WHERE merchant = 'costco' AND network = ? AND last4 = ? AND state = 'active'`);
  return [...identities].filter((identity) => {
    const [network, last4] = JSON.parse(identity) as [string, string];
    return bound.get(network, last4) === undefined;
  }).length;
}

const zeroOutcomes = (): Record<RetailOutcome, number> =>
  Object.fromEntries(RETAIL_OUTCOMES.map((outcome) => [outcome, 0])) as Record<RetailOutcome, number>;
const zeroHeld = (): Record<RetailHeldClass, number> =>
  Object.fromEntries(RETAIL_HELD_CLASSES.map((held) => [held, 0])) as Record<RetailHeldClass, number>;
/** The written outcomes only (§5.3's nine): what a plan and a receipt print. */
const writtenOutcomes = (counts: Record<RetailOutcome, number>): Record<RetailImportOutcome, number> =>
  Object.fromEntries(RETAIL_WRITTEN_OUTCOMES.map((outcome) => [outcome, counts[outcome]])) as Record<RetailImportOutcome, number>;

function entryOf(db: Database.Database, receipt: RetailImportReceipt, membership: RetailMembershipDecision): Entry {
  const stored = retailReceiptByKey(db, receipt.naturalKey);
  const version = retailVersionOf(receipt, RETAIL_BUILD_LABELS);
  if (stored === null) {
    return {
      receipt, stored, version, existingVersion: null, decision: classifyRetailSighting({ receipt: null, incoming: version, seenByMembership: false }),
      evidenceDigest: null, pendingHolds: retailUnresolvedHolds(db, receipt.naturalKey, null),
    };
  }
  // A receipt's channel is part of its identity, for life (plan §4.2, §4.3): a sighting of its key under another channel
  // is refused, never read as the same receipt (D-PR2-C6). The digests and money don't carry the channel.
  if (stored.channel !== receipt.channel) throw new RetailRefusal('retail-receipt-conflict', { field: 'channel', receiptRef: stored.receiptRef });
  const seenByMembership = membership.kind === 'registered' && db.prepare(
    'SELECT 1 FROM retail_receipt_observations WHERE receipt_ref = ? AND membership_ref = ?').get(stored.receiptRef, membership.membershipRef) !== undefined;
  const decision = classifyRetailSighting({
    receipt: { state: stored.state, canonical: retailStoredVersion(db, stored.canonicalVersion) }, incoming: version, seenByMembership,
  });
  return {
    receipt, stored, version, existingVersion: retailVersionByDigests(db, stored.receiptRef, version), decision,
    evidenceDigest: retailEvidenceDigest(retailEvidence(db, stored.receiptRef)), pendingHolds: [],
  };
}

function heldEntryOf(db: Database.Database, held: RetailHeldRecord): HeldEntry {
  if (held.naturalKey === null) return { held, heldClass: 'no-key', target: null, evidenceDigest: null };
  const target = retailReceiptByKey(db, held.naturalKey);
  if (target === null) return { held, heldClass: 'pending', target: null, evidenceDigest: null };
  return { held, heldClass: 'quarantining', target, evidenceDigest: retailEvidenceDigest(retailEvidence(db, target.receiptRef)) };
}

function prepare(db: Database.Database, checked: ReturnType<typeof checkedPayload>, request: RetailImportRequest): Prepared {
  requireRetailSchema(db);
  const { payload, inputSha256, capturedAt } = checked;
  const counts = zeroOutcomes();
  const stored = db.prepare('SELECT import_id FROM retail_imports WHERE payload_sha256 = ?').pluck().get(retailLetters(inputSha256)) as string | undefined;
  if (stored !== undefined) {
    return {
      payload, capturedAt, membership: null, declaration: null, facts: [], entries: [], held: [], counts,
      plan: {
        inputSha256, alreadyImported: true, importId: stored, membership: null, receipts: payload.receipts.length, outcomes: writtenOutcomes(counts),
        held: zeroHeld(), possibleOverlap: 0, cardLast4sUnbound: 0, planDigest: digest({ format: 'holdr.retail-import-plan', version: 1, inputSha256,
          alreadyImported: stored }),
      },
    };
  }
  const declaration = request.declaration === null ? null
    : { declaration: retailDeclarationOf(request.declaration.declaration as unknown as Record<string, unknown>), sha256: request.declaration.sha256 };
  if (declaration !== null && !HEX64.test(declaration.sha256)) throw new RetailRefusal('retail-declaration-invalid');
  const membership = resolveMembership(db, payload, declaration, request.membership);
  const facts = statedFacts(payload);
  checkIdentityFacts(db, membership, facts);
  const entries = payload.receipts.map((receipt) => entryOf(db, receipt, membership));
  const held = payload.held.map((record) => heldEntryOf(db, record));
  for (const entry of entries) counts[entry.decision.outcome] += 1;
  const heldCounts = zeroHeld();
  for (const entry of held) heldCounts[entry.heldClass] += 1;
  const plan: RetailImportPlan = {
    inputSha256, alreadyImported: false, importId: null, membership, receipts: payload.receipts.length, outcomes: writtenOutcomes(counts),
    held: heldCounts,
    possibleOverlap: retailPossibleOverlaps(db, membership.kind === 'register' ? { folder: payload.membership.folder, facts } : null),
    cardLast4sUnbound: unboundCardIdentities(db, payload),
    planDigest: digest({
      format: 'holdr.retail-import-plan', version: 1, schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST, inputSha256,
      membership, facts,
      receipts: entries.map((entry) => [entry.receipt.naturalKey, entry.decision.outcome, entry.decision.reason, entry.decision.moves,
        entry.stored?.receiptRef ?? null, entry.stored?.canonicalVersion ?? null, entry.existingVersion, entry.version.sourceDigest,
        entry.version.meaningDigest, entry.version.provenanceDigest, entry.evidenceDigest, entry.pendingHolds]),
      held: held.map((entry) => [entry.held.naturalKey, entry.heldClass, entry.target?.receiptRef ?? null, entry.evidenceDigest]),
    }),
  };
  return { payload, capturedAt, membership, declaration, facts, entries, held, counts, plan };
}

const OUTCOME_COLUMNS = RETAIL_OUTCOMES.map((outcome) => retailCountColumn(outcome));
const HELD_COLUMNS = RETAIL_HELD_CLASSES.map((held) => `held_${retailCountColumn(held)}`);

function write(db: Database.Database, prepared: Prepared, authority: ReturnType<typeof checkRetailWriteContext>): RetailImportResult {
  const { payload, plan, membership } = prepared;
  if (membership === null) throw new RetailRefusal('retail-plan-changed');
  const at = authority.at;
  const importId = newRetailId('rtl-imp-');
  const importSeq = db.prepare('SELECT coalesce(max(import_seq), 0) + 1 FROM retail_imports').pluck().get() as number;
  const membershipRef = membership.kind === 'registered' ? membership.membershipRef : newRetailId('rtl-mbr-');
  const columns = ['import_id', 'import_seq', 'payload_sha256', 'membership_ref', 'format', 'version', 'converter_version', 'policy_version',
    'capture_schema', 'capture_digest', 'captured_at', 'capture_files', 'plan_digest', 'go_id', 'purpose', 'imported_at', 'receipt_count',
    ...OUTCOME_COLUMNS, ...HELD_COLUMNS];
  db.prepare(`INSERT INTO retail_imports (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(importId, importSeq, retailLetters(plan.inputSha256), membershipRef, payload.format, payload.version, payload.converterVersion,
      payload.policyVersion, payload.source.schema, payload.source.captureDigest, prepared.capturedAt, payload.source.files,
      retailLetters(plan.planDigest), authority.goId, authority.purpose, at, payload.receipts.length,
      ...RETAIL_OUTCOMES.map((outcome) => prepared.counts[outcome]), ...RETAIL_HELD_CLASSES.map((held) => plan.held[held]));
  const coverage = db.prepare(`INSERT INTO retail_import_coverage (import_id, channel, position, from_date, to_date, stated, seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const channel of ['online', 'warehouse'] as const) {
    payload.coverage[channel].forEach((range, position) => coverage.run(importId, channel, position, range.from, range.to, range.stated, range.seen));
  }
  if (membership.kind === 'register') {
    const declared = prepared.declaration!.declaration;
    db.prepare(`INSERT INTO retail_memberships (membership_ref, merchant, folder, owner, label, declaration_sha256, registered_import, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(membershipRef, declared.merchant, declared.folder, declared.owner, declared.label,
      retailLetters(membership.declarationSha256), importId, at);
  }
  const fact = db.prepare('INSERT INTO retail_membership_facts (membership_ref, import_id, field, value) VALUES (?, ?, ?, ?)');
  for (const [field, value] of prepared.facts) fact.run(membershipRef, importId, field, value);
  const insertHeld = db.prepare('INSERT INTO retail_held (held_ref, import_id, channel, natural_key, reason, hold_check, date) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const heldRefs = payload.held.map((held) => {
    const heldRef = newRetailId('rhd-');
    insertHeld.run(heldRef, importId, held.channel, held.naturalKey, held.reason, held.check, held.date);
    return heldRef;
  });

  const observe = db.prepare(`INSERT INTO retail_receipt_observations (observation_ref, receipt_ref, version_ref, membership_ref, import_id)
    VALUES (?, ?, ?, ?, ?)`);
  for (const entry of prepared.entries) {
    const receiptRef = entry.stored?.receiptRef ?? insertRetailReceipt(db, entry.receipt, importId);
    const versionRef = entry.existingVersion ?? storeRetailVersion(db, receiptRef, entry.receipt, entry.version, RETAIL_BUILD_LABELS, importId);
    const observationRef = newRetailId('rob-');
    observe.run(observationRef, receiptRef, versionRef, membershipRef, importId);
    const cause = { observationRef };
    if (entry.stored === null) {
      const held = entry.pendingHolds.length > 0;
      appendRetailEvent(db, receiptRef, {
        kind: 'created', state: held ? 'quarantined' : 'active', firstReason: held ? 'receipt-held-later' : null, canonicalVersion: versionRef,
        reason: null, cause, importId, goId: null, at,
      });
      for (const heldRef of entry.pendingHolds) {
        appendRetailEvent(db, receiptRef, retailHoldEvent(retailReceiptByRef(db, receiptRef)!, 'receipt-held-later', { heldRef }, importId, at));
      }
    } else if (entry.decision.moves) {
      appendRetailEvent(db, receiptRef, {
        kind: 'provenance-refresh', state: 'active', firstReason: null, canonicalVersion: versionRef, reason: null, cause, importId, goId: null, at,
      });
    } else if (entry.decision.reason !== null) {
      appendRetailEvent(db, receiptRef, retailHoldEvent(retailReceiptByRef(db, receiptRef)!, entry.decision.reason, cause, importId, at));
    }
  }
  prepared.held.forEach((entry, index) => {
    if (entry.heldClass !== 'quarantining' || entry.target === null) return;
    const current = retailReceiptByRef(db, entry.target.receiptRef)!;
    appendRetailEvent(db, current.receiptRef, retailHoldEvent(current, 'receipt-held-later', { heldRef: heldRefs[index] }, importId, at));
  });
  appendRetailAudit(db, { kind: 'import', inputSha256: retailLetters(plan.inputSha256), planDigest: retailLetters(plan.planDigest), authority });
  return { code: 'retail-imported', ...plan, importId, importSeq, membership: { kind: 'registered', membershipRef } };
}

/** Read-only: what importing the payload would do, or the refusal it would meet. */
export function planRetailImport(db: Database.Database, request: RetailImportRequest): RetailImportPlan {
  const checked = checkedPayload(request.payload);
  try {
    return db.transaction(() => prepare(db, checked, request).plan)();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('plan retail import', error);
  }
}

/**
 * Imports the payload (the operator's backed-up IMMEDIATE transaction calls this; alone, it runs in one of its own). The
 * payload must be the one the GO names; the plan is computed again inside the transaction and, with a `planDigest`, must
 * be the preflight's, or nothing is written.
 */
export function importRetailPayload(db: Database.Database, request: RetailImportRequest, context: RetailImportContext): RetailImportResult {
  const authority = checkRetailWriteContext(context, 'import');
  if (typeof context.inputSha256 !== 'string' || !HEX64.test(context.inputSha256)) throw new RetailRefusal('retail-digest-invalid');
  if (context.planDigest !== null && (typeof context.planDigest !== 'string' || !HEX64.test(context.planDigest))) {
    throw new RetailRefusal('retail-digest-invalid');
  }
  if (context.authority.kind === 'go' && request.membership === null) throw new RetailRefusal('retail-go-invalid');
  const checked = checkedPayload(request.payload);
  try {
    return db.transaction((): RetailImportResult => {
      const prepared = prepare(db, checked, request);
      if (prepared.plan.inputSha256 !== context.inputSha256) throw new RetailRefusal('retail-input-mismatch');
      if (context.planDigest !== null && prepared.plan.planDigest !== context.planDigest) throw new RetailRefusal('retail-plan-changed');
      if (prepared.plan.alreadyImported) return { code: 'retail-already-imported', ...prepared.plan, importSeq: null };
      return write(db, prepared, authority);
    }).immediate();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('import retail payload', error);
  }
}
