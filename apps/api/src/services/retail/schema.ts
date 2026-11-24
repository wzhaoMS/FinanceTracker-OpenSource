import type Database from 'better-sqlite3';
import { ITEM_TAXONOMY_SOURCES, type CardOwner } from '@finance-tracker/shared';
import {
  RETAIL_CARRIERS,
  RETAIL_CHANNELS,
  RETAIL_FULFILMENTS,
  RETAIL_HOLD_CHECK_NAMES,
  RETAIL_HOLD_CHECKS,
  RETAIL_HOLD_REASONS,
  RETAIL_LINE_KINDS,
  RETAIL_MAX_LINES,
  RETAIL_MAX_MINOR,
  RETAIL_MAX_RECEIPTS,
  RETAIL_MAX_TENDERS,
  RETAIL_METAL_FORMS,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_PACKS,
  RETAIL_METALS,
  RETAIL_NETWORKS,
  RETAIL_ONLINE_STATUSES,
  RETAIL_SIGNS,
  RETAIL_STORED_VALUE_KINDS,
  RETAIL_TENDER_KINDS,
  RETAIL_TITLE_MAX,
  RETAIL_WEIGHT_UNITS,
} from '@finance-tracker/shared/retail-import-payload';

import { digest } from '../amazon/policy.js';
import { FORBIDDEN_CHAR_GLOB } from '../cardGuards.js';
import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';
import { schemaObjects, schemaSqlDigest, schemaState, type DeclaredSchema, type SchemaObjectCounts, type SchemaState } from '../schemaShape.js';
import {
  RETAIL_CONFIDENCE_BP_MAX,
  RETAIL_PREVIEW_PURPOSE,
  RETAIL_PURPOSES,
  RETAIL_TAXONOMY_SUBJECT_KINDS,
  RetailRefusal,
  checkRetailWriteContext,
  retailLetters,
  type RetailStoredAuthority,
  type RetailWriteContext,
} from './common.js';

/**
 * The retail domain's tables (Costco receipts 2/7, plan v5 §4; design v5 §4).
 *
 * Operator-installed and outside `user_version`, as the metals ledger's: nothing creates them at boot and no migration
 * touches them. Only the backed-up, Root-GO'd `holdr-retail install` does, in one IMMEDIATE transaction, and the
 * preview creates them in its own new clone only (plan §2 rule 1, §8.2). Every later retail PR reads and writes these
 * same tables with no second schema change, so this declaration is complete for PRs 2–7, the reserved values included
 * (plan §5.7). Anything else named `retail_…`, or on one of these tables, is a conflict: never repaired, never read.
 *
 * Five kinds of row (plan §4.1): identity rows (receipts, line, shipment and tender refs, memberships), immutable version
 * facts, append-only evidence, the receipt's selection (changed only to its newest event's values), and configuration
 * (taxonomy revisions; bindings from PR 4). No JSON column: every fact is a typed column or a child row.
 *
 * Every text column is guarded: typed shapes for keys, refs, digests (letter hex, never a digit), dates and last fours,
 * and free text by the clauses of the card-import tool's text check that SQL can say (`text`, below). A CHECK never
 * refuses a payload the preflight accepts: the validator and the storage check (`retailStorageProblems`, versions.ts,
 * the same clauses) refuse it first, before any backup.
 *
 * Integrity is enforced here, not trusted to the writer (3ddfcd26's implementation gates): a receipt starts unselected
 * and its selection changes only to its newest event's values; an event follows the receipt's current selection (its
 * `prior_version` is the actual prior selection) and cites only its own receipt's evidence, of the versions it names; a
 * progression's witness is a sighting of its prior version and its cause a sighting of the version it selects; a
 * version's line, shipment and tender facts name refs of its own receipt.
 */

const MAX = RETAIL_MAX_MINOR;
const LONG_DIGITS = `'*${'[0-9]'.repeat(13)}*'`;
const among = (column: string, values: readonly string[]) => `${column} IN (${values.map((value) => `'${value}'`).join(', ')})`;
const orNull = (column: string, rule: string) => `(${column} IS NULL OR (${rule}))`;
const letters = (column: string, length = 64) => `typeof(${column}) = 'text' AND length(${column}) = ${length} AND ${column} NOT GLOB '*[^a-p]*'`;
const ref = (column: string, prefix: string) => `typeof(${column}) = 'text' AND length(${column}) = ${prefix.length + 32} `
  + `AND substr(${column}, 1, ${prefix.length}) = '${prefix}' AND substr(${column}, ${prefix.length + 1}) NOT GLOB '*[^a-p]*'`;
const day = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 10 AND date(${column}) IS ${column}`;
const instant = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column}`;
/** A natural key: `costco-receipt-…`, `costco-order-…` or `costco-line-…`, then 64 letters of letter hex. */
const naturalKey = (column: string, prefix: string) => `typeof(${column}) = 'text' AND length(${column}) = ${prefix.length + 64} `
  + `AND substr(${column}, 1, ${prefix.length}) = '${prefix}' AND substr(${column}, ${prefix.length + 1}) NOT GLOB '*[^a-p]*'`;
const minor = (column: string, min = -MAX, max = MAX) => `typeof(${column}) = 'integer' AND ${column} BETWEEN ${min} AND ${max}`;
const count = (column: string, max = 1_000_000) => `typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max}`;
const ordinal = (column: string, max: number) => `typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max}`;
const last4 = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 4 AND ${column} NOT GLOB '*[^0-9]*'`;
const slug = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${max} `
  + `AND substr(${column}, 1, 1) GLOB '[a-z]' AND ${column} NOT GLOB '*[^a-z0-9-]*' AND ${column} NOT GLOB ${LONG_DIGITS}`;
const decimal = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${max} `
  + `AND substr(${column}, 1, 1) GLOB '[0-9]' AND ${column} NOT GLOB '*[^0-9.]*' AND ${column} NOT GLOB '*.*.*'`;

/**
 * The characters the card-import tool's text check refuses as control or spacing (`CONTROL`, `SPACING` in cardImport.ts),
 * NUL aside: C0 controls, DEL, C1 controls and the no-break space, and every whitespace character but the plain space.
 * (U+FEFF is among the card guard's forbidden characters.) One list for the CHECK and its mirror (versions.ts).
 */
export const RETAIL_TEXT_SPACING_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0x01, 0x1f], [0x7f, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
].map((range) => Object.freeze(range) as readonly [number, number]));
const SPACING_GLOB = `'*[' || ${RETAIL_TEXT_SPACING_RANGES
  .map(([start, end]) => (start === end ? `char(${start})` : `char(${start}) || '-' || char(${end})`)).join(' || ')} || ']*'`;
/**
 * Free text (titles, legends), clause by clause as the card-import tool's text check (`cardImportTextProblem`) stores
 * it, where SQL can say it: 1 to `max` characters; no NUL (length() and GLOB stop at one); no control or spacing
 * character; single spaces and none at either end; none of the card guard's forbidden characters (NFKC, invisible
 * characters and non-ASCII digits, cardGuards.ts); no formula start (= + - @); no run of 13 or more digits. What SQL can't
 * say (NFKC as such, card data, card secrets) the validator refuses first. `retailTextProblem` (versions.ts) is the same
 * clauses in the preflight, and a test runs both on the same values.
 */
const text = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${max} `
  + `AND instr(${column}, char(0)) = 0 AND ${column} NOT GLOB ${SPACING_GLOB} AND ${column} NOT GLOB '*  *' AND ${column} = trim(${column}) `
  + `AND ${column} NOT GLOB '${FORBIDDEN_CHAR_GLOB}' AND ${column} NOT GLOB '[=+@-]*' AND ${column} NOT GLOB ${LONG_DIGITS}`;

// ---------------------------------------------------------------------------------------------------------------------
// The domain's own closed vocabularies (plan §9). Values marked reserved are installed now and written by no PR before
// the progression rule's own design, review and GO (plan §5.7): every writer's type excludes them (the Written… types
// below), and every reader stops on a stored one (`assertNoReservedValues`).
// ---------------------------------------------------------------------------------------------------------------------

/** The importer's outcomes for one payload receipt (plan §5.3), and `progression` (reserved). */
export const RETAIL_OUTCOMES = [
  'new', 'quarantined', 'conflict', 'changed', 'policy-reread', 'provenance-refresh', 'older-policy', 'unchanged', 'shared', 'progression',
] as const;
export type RetailOutcome = (typeof RETAIL_OUTCOMES)[number];
/** The receipt events (plan §4.2), and `progression` (reserved). */
export const RETAIL_EVENT_KINDS = ['created', 'quarantined', 'cause', 'provenance-refresh', 'review', 'progression'] as const;
export type RetailEventKind = (typeof RETAIL_EVENT_KINDS)[number];
/** The review decisions (plan §6), and `correct` (reserved: the reversal path for a progression, plan §5.7). */
export const RETAIL_REVIEW_DECISIONS = ['canonical', 'keep-quarantined', 'correct'] as const;
export type RetailReviewDecision = (typeof RETAIL_REVIEW_DECISIONS)[number];
/** The reserved values, by where they live: written by nothing in PRs 2–7, read as an integrity STOP (plan §5.7). */
export const RETAIL_RESERVED = Object.freeze({
  outcome: 'progression',
  eventKind: 'progression',
  decision: 'correct',
  countColumn: 'progression_count',
  eventColumns: Object.freeze(['witness_observation_ref', 'progression_rule'] as const),
} as const);
/** What the importer can write: §5.3's nine outcomes, never the reserved one. */
export type RetailImportOutcome = Exclude<RetailOutcome, typeof RETAIL_RESERVED.outcome>;
/** What the event writer can write: never the reserved kind. */
export type RetailWrittenEventKind = Exclude<RetailEventKind, typeof RETAIL_RESERVED.eventKind>;
/** What the review writer can write: `canonical` and `keep-quarantined`, never the reserved `correct`. */
export type RetailWrittenDecision = Exclude<RetailReviewDecision, typeof RETAIL_RESERVED.decision>;
export const RETAIL_WRITTEN_OUTCOMES = RETAIL_OUTCOMES.filter((outcome): outcome is RetailImportOutcome => outcome !== RETAIL_RESERVED.outcome);
export const RETAIL_WRITTEN_DECISIONS = RETAIL_REVIEW_DECISIONS.filter((decision): decision is RetailWrittenDecision => decision !== RETAIL_RESERVED.decision);

export const RETAIL_QUARANTINE_REASONS = ['duplicate-across-memberships', 'receipt-changed', 'policy-reread-changed', 'receipt-held-later'] as const;
export type RetailQuarantineReason = (typeof RETAIL_QUARANTINE_REASONS)[number];
/** A held record's class (plan §9): no key, naming no stored receipt yet, or naming one (which it quarantines). */
export const RETAIL_HELD_CLASSES = ['no-key', 'pending', 'quarantining'] as const;
export type RetailHeldClass = (typeof RETAIL_HELD_CLASSES)[number];
/** A membership's declared owner: exactly Holdr's card owners (`CardOwner`; a pin test holds the two equal). */
export const RETAIL_OWNERS = ['alex', 'casey', 'joint'] as const satisfies readonly CardOwner[];
export type RetailOwner = (typeof RETAIL_OWNERS)[number];
/** Identity facts and one attribute (`tier`) a payload states about its membership (plan §5.4). */
export const RETAIL_MEMBERSHIP_FACT_FIELDS = ['member-since-year', 'membership-last4', 'tier'] as const;
export type RetailMembershipFactField = (typeof RETAIL_MEMBERSHIP_FACT_FIELDS)[number];
export const RETAIL_MEMBERSHIP_IDENTITY_FIELDS = ['member-since-year', 'membership-last4'] as const satisfies readonly RetailMembershipFactField[];
export const RETAIL_AUDIT_KINDS = ['install', 'import', 'review', 'taxonomy-import', 'bindings-approve', 'bindings-revoke'] as const;
export type RetailAuditKind = (typeof RETAIL_AUDIT_KINDS)[number];
/** Who assigned a taxonomy subject: the shared tree's sources (owner, agent), and a reviewed department mapping. */
export const RETAIL_TAXONOMY_SOURCES = [...ITEM_TAXONOMY_SOURCES, 'department-review'] as const;
export type RetailTaxonomySource = (typeof RETAIL_TAXONOMY_SOURCES)[number];
export const RETAIL_BINDING_STATES = ['active', 'revoked'] as const;
/** The coverage channels a payload states (`coverage.online`, `coverage.warehouse`). */
export const RETAIL_COVERAGE_CHANNELS = ['online', 'warehouse'] as const;
export const RETAIL_LINE_EVENT_KINDS = ['shipped', 'delivered', 'cancelled', 'returned'] as const;
/** A progression rule's version label (reserved column, plan §5.7): its shape only, so a later version needs no schema change. */
const PROGRESSION_RULE = (column: string) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 21 AND 24 `
  + `AND substr(${column}, 1, 19) = 'retail-progression-' AND substr(${column}, 20, 1) = 'v' AND substr(${column}, 21) GLOB '[1-9]*' `
  + `AND substr(${column}, 21) NOT GLOB '*[^0-9]*'`;

/** One count column per outcome (the reserved one included, always 0 in PRs 2–7) and per held class. */
export const retailCountColumn = (value: string) => `${value.replace(/-/g, '_')}_count`;
const OUTCOME_COUNTS = RETAIL_OUTCOMES.map((outcome) => retailCountColumn(outcome));
const HELD_COUNTS = RETAIL_HELD_CLASSES.map((held) => `held_${retailCountColumn(held)}`);
const IMPORT_PURPOSES = [...RETAIL_PURPOSES.import, RETAIL_PREVIEW_PURPOSE];
const AUDIT_PURPOSES = [...new Set([...Object.values(RETAIL_PURPOSES).flat(), 'production-bindings', RETAIL_PREVIEW_PURPOSE])];
/** A held record's check names the reason it is held under, as the converter's closed table says (RETAIL_HOLD_CHECKS). */
const HOLD_REASON_OF_CHECK = `CASE hold_check ${RETAIL_HOLD_CHECK_NAMES.map((check) => `WHEN '${check}' THEN '${RETAIL_HOLD_CHECKS[check]}'`).join(' ')} END`;

const TABLES: ReadonlyArray<readonly [string, string]> = [
  // ----- memberships and imports ------------------------------------------------------------------------------------
  ['retail_memberships', `CREATE TABLE retail_memberships (
  membership_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('membership_ref', 'rtl-mbr-')}),
  merchant TEXT NOT NULL CHECK (merchant = 'costco'),
  folder TEXT NOT NULL CHECK (typeof(folder) = 'text' AND (folder = merchant OR (length(folder) BETWEEN length(merchant) + 2 AND length(merchant) + 4
    AND substr(folder, 1, length(merchant) + 1) = merchant || '-' AND substr(folder, length(merchant) + 2, 1) GLOB '[1-9]'
    AND substr(folder, length(merchant) + 2) NOT GLOB '*[^0-9]*'))),
  owner TEXT NOT NULL CHECK (${among('owner', RETAIL_OWNERS)}),
  label TEXT NOT NULL CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 60 AND instr(label, char(0)) = 0 AND label = trim(label)
    AND substr(label, 1, 1) GLOB '[A-Za-z]' AND label NOT GLOB '*[^A-Za-z0-9 ()._-]*' AND label NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]*'
    AND label NOT GLOB '*  *'),
  declaration_sha256 TEXT NOT NULL CHECK (${letters('declaration_sha256')}),
  registered_import TEXT NOT NULL REFERENCES retail_imports(import_id) DEFERRABLE INITIALLY DEFERRED,
  registered_at TEXT NOT NULL CHECK (${instant('registered_at')}),
  UNIQUE (merchant, folder)
)`],
  // retail_imports: Only the preview's clone holds an import no GO authorized (plan §8.2).
  ['retail_imports', `CREATE TABLE retail_imports (
  import_id TEXT NOT NULL PRIMARY KEY CHECK (${ref('import_id', 'rtl-imp-')}),
  import_seq INTEGER NOT NULL UNIQUE CHECK (typeof(import_seq) = 'integer' AND import_seq BETWEEN 1 AND 1000000000),
  payload_sha256 TEXT NOT NULL UNIQUE CHECK (${letters('payload_sha256')}),
  membership_ref TEXT NOT NULL REFERENCES retail_memberships(membership_ref) DEFERRABLE INITIALLY DEFERRED,
  format TEXT NOT NULL CHECK (format = 'holdr.retail-import'),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 3 AND 999),
  converter_version TEXT NOT NULL CHECK (typeof(converter_version) = 'text' AND length(converter_version) BETWEEN 26 AND 32
    AND substr(converter_version, 1, 21) = 'holdr-retail-convert ' AND substr(converter_version, 22) GLOB '[0-9]*.[0-9]*.[0-9]*'
    AND substr(converter_version, 22) NOT GLOB '*[^0-9.]*'),
  policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version BETWEEN 5 AND 999),
  capture_schema TEXT NOT NULL CHECK (typeof(capture_schema) = 'text' AND length(capture_schema) BETWEEN 1 AND 64
    AND capture_schema NOT GLOB '*[^a-z0-9@/.-]*' AND capture_schema NOT GLOB ${LONG_DIGITS}),
  capture_digest TEXT NOT NULL CHECK (${letters('capture_digest')}),
  captured_at TEXT NOT NULL CHECK (${instant('captured_at')}),
  capture_files INTEGER NOT NULL CHECK (${count('capture_files', 100_000)}),
  plan_digest TEXT NOT NULL CHECK (${letters('plan_digest')}),
  go_id TEXT NULL CHECK ${orNull('go_id', letters('go_id', 32))},
  purpose TEXT NOT NULL CHECK (${among('purpose', IMPORT_PURPOSES)}),
  imported_at TEXT NOT NULL CHECK (${instant('imported_at')}),
  receipt_count INTEGER NOT NULL CHECK (${count('receipt_count', RETAIL_MAX_RECEIPTS)}),
  ${OUTCOME_COUNTS.map((column) => `${column} INTEGER NOT NULL CHECK (${count(column, RETAIL_MAX_RECEIPTS)})`).join(',\n  ')},
  ${HELD_COUNTS.map((column) => `${column} INTEGER NOT NULL CHECK (${count(column, RETAIL_MAX_RECEIPTS)})`).join(',\n  ')},
  CHECK (${OUTCOME_COUNTS.join(' + ')} = receipt_count),
  CHECK ((go_id IS NULL) = (purpose = '${RETAIL_PREVIEW_PURPOSE}')),
  UNIQUE (import_id, membership_ref)
)`],
  // retail_membership_facts: A fact belongs to the membership its import is for.
  ['retail_membership_facts', `CREATE TABLE retail_membership_facts (
  membership_ref TEXT NOT NULL REFERENCES retail_memberships(membership_ref) DEFERRABLE INITIALLY DEFERRED,
  import_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (${among('field', RETAIL_MEMBERSHIP_FACT_FIELDS)}),
  value TEXT NOT NULL CHECK (typeof(value) = 'text' AND CASE field
    WHEN 'member-since-year' THEN length(value) = 4 AND substr(value, 1, 2) IN ('19', '20') AND value NOT GLOB '*[^0-9]*'
    WHEN 'membership-last4' THEN ${last4('value')}
    ELSE length(value) BETWEEN 1 AND 40 AND instr(value, char(0)) = 0 AND substr(value, 1, 1) GLOB '[A-Za-z]' AND value NOT GLOB '*[^A-Za-z +]*' END),
  PRIMARY KEY (import_id, field),
  FOREIGN KEY (import_id, membership_ref) REFERENCES retail_imports(import_id, membership_ref)
)`],
  ['retail_import_coverage', `CREATE TABLE retail_import_coverage (
  import_id TEXT NOT NULL REFERENCES retail_imports(import_id),
  channel TEXT NOT NULL CHECK (${among('channel', RETAIL_COVERAGE_CHANNELS)}),
  position INTEGER NOT NULL CHECK (${ordinal('position', 999)}),
  from_date TEXT NOT NULL CHECK (${day('from_date')}),
  to_date TEXT NOT NULL CHECK (${day('to_date')} AND to_date >= from_date),
  stated INTEGER NULL CHECK ${orNull('stated', count('stated'))},
  seen INTEGER NOT NULL CHECK (${count('seen')}),
  PRIMARY KEY (import_id, channel, position)
)`],
  // ----- receipts: identity and selection (no fact columns: plan §4.2, D-R2-5) ---------------------------------------
  ['retail_receipts', `CREATE TABLE retail_receipts (
  receipt_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('receipt_ref', 'rcp-')}),
  merchant TEXT NOT NULL CHECK (merchant = 'costco'),
  channel TEXT NOT NULL CHECK (${among('channel', RETAIL_CHANNELS)}),
  natural_key TEXT NOT NULL CHECK ((channel = 'online' AND ${naturalKey('natural_key', 'costco-order-')})
    OR (channel <> 'online' AND ${naturalKey('natural_key', 'costco-receipt-')})),
  first_import TEXT NOT NULL REFERENCES retail_imports(import_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'quarantined')),
  first_reason TEXT NULL CHECK ${orNull('first_reason', among('first_reason', RETAIL_QUARANTINE_REASONS))},
  canonical_version TEXT NULL REFERENCES retail_receipt_versions(version_ref) DEFERRABLE INITIALLY DEFERRED,
  selection_seq INTEGER NOT NULL CHECK (typeof(selection_seq) = 'integer' AND selection_seq BETWEEN 0 AND 1000000),
  CHECK ((state = 'active') = (first_reason IS NULL)),
  CHECK ((selection_seq = 0) = (canonical_version IS NULL)),
  UNIQUE (merchant, natural_key)
)`],
  // ----- version facts: stored once, immutable (Q-S1) --------------------------------------------------------------
  ['retail_receipt_versions', `CREATE TABLE retail_receipt_versions (
  version_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('version_ref', 'rrv-')}),
  receipt_ref TEXT NOT NULL REFERENCES retail_receipts(receipt_ref),
  source_digest TEXT NOT NULL CHECK (${letters('source_digest')}),
  meaning_digest TEXT NOT NULL CHECK (${letters('meaning_digest')}),
  provenance_digest TEXT NOT NULL CHECK (${letters('provenance_digest')}),
  policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version BETWEEN 5 AND 999),
  title_rule TEXT NOT NULL CHECK (${slug('title_rule', 48)}),
  metal_guard TEXT NOT NULL CHECK (${slug('metal_guard', 48)}),
  pack_rule TEXT NOT NULL CHECK (${slug('pack_rule', 48)}),
  first_import TEXT NOT NULL REFERENCES retail_imports(import_id),
  date TEXT NOT NULL CHECK (${day('date')}),
  local_time TEXT NULL CHECK ${orNull('local_time', `typeof(local_time) = 'text' AND length(local_time) IN (5, 8) AND local_time GLOB '[0-2][0-9]:[0-5][0-9]*'`)},
  sign TEXT NOT NULL CHECK (${among('sign', RETAIL_SIGNS)}),
  status TEXT NULL CHECK ${orNull('status', among('status', RETAIL_ONLINE_STATUSES))},
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  subtotal_minor INTEGER NULL CHECK ${orNull('subtotal_minor', minor('subtotal_minor'))},
  tax_minor INTEGER NULL CHECK ${orNull('tax_minor', minor('tax_minor'))},
  instant_savings_minor INTEGER NULL CHECK ${orNull('instant_savings_minor', minor('instant_savings_minor'))},
  discount_minor INTEGER NULL CHECK ${orNull('discount_minor', minor('discount_minor'))},
  shipping_minor INTEGER NULL CHECK ${orNull('shipping_minor', minor('shipping_minor'))},
  fees_minor INTEGER NULL CHECK ${orNull('fees_minor', minor('fees_minor'))},
  stored_value_minor INTEGER NULL CHECK ${orNull('stored_value_minor', minor('stored_value_minor'))},
  total_minor INTEGER NOT NULL CHECK (${minor('total_minor')}),
  UNIQUE (receipt_ref, source_digest, meaning_digest, provenance_digest),
  UNIQUE (version_ref, receipt_ref)
)`],
  ['retail_tax_legends', `CREATE TABLE retail_tax_legends (
  version_ref TEXT NOT NULL REFERENCES retail_receipt_versions(version_ref),
  position INTEGER NOT NULL CHECK (${ordinal('position', 19)}),
  legend TEXT NOT NULL CHECK (${text('legend', 40)}),
  amount_minor INTEGER NOT NULL CHECK (${minor('amount_minor')}),
  PRIMARY KEY (version_ref, position)
)`],
  // ----- stable logical identities (Q-L1, D-R3-4) -------------------------------------------------------------------
  ['retail_line_refs', `CREATE TABLE retail_line_refs (
  line_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('line_ref', 'rli-')}),
  receipt_ref TEXT NOT NULL REFERENCES retail_receipts(receipt_ref),
  line_key TEXT NULL CHECK ${orNull('line_key', naturalKey('line_key', 'costco-line-'))},
  ordinal INTEGER NULL CHECK ${orNull('ordinal', ordinal('ordinal', RETAIL_MAX_LINES - 1))},
  CHECK ((line_key IS NULL) <> (ordinal IS NULL)),
  UNIQUE (receipt_ref, line_key),
  UNIQUE (receipt_ref, ordinal),
  UNIQUE (line_ref, receipt_ref)
)`],
  // retail_line_facts: A line has metal evidence (rule, pack) or none; a weight's value and unit come together; a flag is never beside metal.
  ['retail_line_facts', `CREATE TABLE retail_line_facts (
  version_ref TEXT NOT NULL REFERENCES retail_receipt_versions(version_ref),
  line_ref TEXT NOT NULL REFERENCES retail_line_refs(line_ref),
  ordinal INTEGER NOT NULL CHECK (${ordinal('ordinal', RETAIL_MAX_LINES - 1)}),
  kind TEXT NOT NULL CHECK (${among('kind', RETAIL_LINE_KINDS)}),
  item_number TEXT NULL CHECK ${orNull('item_number', `typeof(item_number) = 'text' AND length(item_number) BETWEEN 1 AND 12 AND item_number NOT GLOB '*[^0-9]*'`)},
  title TEXT NULL CHECK ${orNull('title', text('title', RETAIL_TITLE_MAX))},
  title2 TEXT NULL CHECK ${orNull('title2', text('title2', RETAIL_TITLE_MAX))},
  department INTEGER NULL CHECK ${orNull('department', `typeof(department) = 'integer' AND department BETWEEN 0 AND 9999`)},
  quantity INTEGER NULL CHECK ${orNull('quantity', `typeof(quantity) = 'integer' AND quantity BETWEEN -100000 AND 100000`)},
  unit_price_minor INTEGER NULL CHECK ${orNull('unit_price_minor', minor('unit_price_minor'))},
  amount_minor INTEGER NOT NULL CHECK (${minor('amount_minor')}),
  shipping_minor INTEGER NULL CHECK ${orNull('shipping_minor', minor('shipping_minor'))},
  tax_flag TEXT NULL CHECK ${orNull('tax_flag', `typeof(tax_flag) = 'text' AND length(tax_flag) = 1 AND tax_flag GLOB '[A-Z0-9]'`)},
  coupon_target INTEGER NULL CHECK ${orNull('coupon_target', ordinal('coupon_target', RETAIL_MAX_LINES - 1))},
  fee_parent INTEGER NULL CHECK ${orNull('fee_parent', ordinal('fee_parent', RETAIL_MAX_LINES - 1))},
  fulfilment TEXT NULL CHECK ${orNull('fulfilment', among('fulfilment', RETAIL_FULFILMENTS))},
  stored_value TEXT NULL CHECK ${orNull('stored_value', among('stored_value', RETAIL_STORED_VALUE_KINDS))},
  fuel_gallons TEXT NULL CHECK ${orNull('fuel_gallons', decimal('fuel_gallons', 9))},
  fuel_unit_price TEXT NULL CHECK ${orNull('fuel_unit_price', decimal('fuel_unit_price', 8))},
  metal_rule TEXT NULL CHECK ${orNull('metal_rule', slug('metal_rule', 48))},
  metal TEXT NULL CHECK ${orNull('metal', among('metal', RETAIL_METALS))},
  form TEXT NULL CHECK ${orNull('form', among('form', RETAIL_METAL_FORMS))},
  stated_weight_value TEXT NULL CHECK ${orNull('stated_weight_value', `typeof(stated_weight_value) = 'text' AND length(stated_weight_value) BETWEEN 1 AND 16
    AND substr(stated_weight_value, 1, 1) GLOB '[0-9]' AND stated_weight_value NOT GLOB '*[^0-9./ ]*'`)},
  stated_weight_unit TEXT NULL CHECK ${orNull('stated_weight_unit', among('stated_weight_unit', RETAIL_WEIGHT_UNITS))},
  pack TEXT NULL CHECK ${orNull('pack', among('pack', RETAIL_METAL_PACKS))},
  uncertain_guard TEXT NULL CHECK ${orNull('uncertain_guard', slug('uncertain_guard', 48))},
  uncertain_metal TEXT NULL CHECK ${orNull('uncertain_metal', among('uncertain_metal', RETAIL_METALS))},
  CHECK ((metal_rule IS NULL) = (pack IS NULL)),
  CHECK (metal_rule IS NOT NULL OR (metal IS NULL AND form IS NULL AND stated_weight_value IS NULL)),
  CHECK ((stated_weight_value IS NULL) = (stated_weight_unit IS NULL)),
  CHECK (uncertain_guard IS NULL OR metal_rule IS NULL),
  CHECK (uncertain_guard IS NOT NULL OR uncertain_metal IS NULL),
  PRIMARY KEY (version_ref, line_ref),
  UNIQUE (version_ref, ordinal)
)`],
  ['retail_line_uncertain_evidence', `CREATE TABLE retail_line_uncertain_evidence (
  version_ref TEXT NOT NULL,
  line_ref TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (${ordinal('position', RETAIL_METAL_GUARD_EVIDENCE.length - 1)}),
  evidence TEXT NOT NULL CHECK (${among('evidence', RETAIL_METAL_GUARD_EVIDENCE)}),
  PRIMARY KEY (version_ref, line_ref, position),
  UNIQUE (version_ref, line_ref, evidence),
  FOREIGN KEY (version_ref, line_ref) REFERENCES retail_line_facts(version_ref, line_ref)
)`],
  ['retail_line_events', `CREATE TABLE retail_line_events (
  version_ref TEXT NOT NULL,
  line_ref TEXT NOT NULL,
  event TEXT NOT NULL CHECK (${among('event', RETAIL_LINE_EVENT_KINDS)}),
  position INTEGER NOT NULL CHECK (${ordinal('position', 999)}),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 100000),
  date TEXT NOT NULL CHECK (${day('date')}),
  PRIMARY KEY (version_ref, line_ref, event, position),
  FOREIGN KEY (version_ref, line_ref) REFERENCES retail_line_facts(version_ref, line_ref)
)`],
  ['retail_shipment_refs', `CREATE TABLE retail_shipment_refs (
  shipment_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('shipment_ref', 'shp-')}),
  line_ref TEXT NOT NULL REFERENCES retail_line_refs(line_ref),
  observation_digest TEXT NOT NULL CHECK (${letters('observation_digest')}),
  occurrence INTEGER NOT NULL CHECK (typeof(occurrence) = 'integer' AND occurrence BETWEEN 1 AND 20),
  UNIQUE (line_ref, observation_digest, occurrence)
)`],
  ['retail_shipment_facts', `CREATE TABLE retail_shipment_facts (
  version_ref TEXT NOT NULL,
  shipment_ref TEXT NOT NULL REFERENCES retail_shipment_refs(shipment_ref),
  line_ref TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (${ordinal('position', 19)}),
  shipped_date TEXT NULL CHECK ${orNull('shipped_date', day('shipped_date'))},
  delivered_date TEXT NULL CHECK ${orNull('delivered_date', day('delivered_date'))},
  estimated_arrival_date TEXT NULL CHECK ${orNull('estimated_arrival_date', day('estimated_arrival_date'))},
  carrier TEXT NULL CHECK ${orNull('carrier', among('carrier', RETAIL_CARRIERS))},
  PRIMARY KEY (version_ref, shipment_ref),
  UNIQUE (version_ref, line_ref, position),
  FOREIGN KEY (version_ref, line_ref) REFERENCES retail_line_facts(version_ref, line_ref)
)`],
  ['retail_tender_refs', `CREATE TABLE retail_tender_refs (
  tender_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('tender_ref', 'rtn-')}),
  receipt_ref TEXT NOT NULL REFERENCES retail_receipts(receipt_ref),
  observation_digest TEXT NOT NULL CHECK (${letters('observation_digest')}),
  occurrence INTEGER NOT NULL CHECK (typeof(occurrence) = 'integer' AND occurrence BETWEEN 1 AND ${RETAIL_MAX_TENDERS}),
  UNIQUE (receipt_ref, observation_digest, occurrence)
)`],
  ['retail_tender_facts', `CREATE TABLE retail_tender_facts (
  version_ref TEXT NOT NULL REFERENCES retail_receipt_versions(version_ref),
  tender_ref TEXT NOT NULL REFERENCES retail_tender_refs(tender_ref),
  ordinal INTEGER NOT NULL CHECK (${ordinal('ordinal', RETAIL_MAX_TENDERS - 1)}),
  kind TEXT NOT NULL CHECK (${among('kind', RETAIL_TENDER_KINDS)}),
  network TEXT NOT NULL CHECK (${among('network', RETAIL_NETWORKS)}),
  last4 TEXT NULL CHECK ${orNull('last4', last4('last4'))},
  amount_minor INTEGER NOT NULL CHECK (${minor('amount_minor')}),
  CHECK ((last4 IS NOT NULL) = (kind IN ('card', 'card-refund'))),
  PRIMARY KEY (version_ref, tender_ref),
  UNIQUE (version_ref, ordinal)
)`],
  // ----- evidence ---------------------------------------------------------------------------------------------------
  // retail_receipt_observations: A sighting is by the membership its import is for.
  ['retail_receipt_observations', `CREATE TABLE retail_receipt_observations (
  observation_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('observation_ref', 'rob-')}),
  receipt_ref TEXT NOT NULL REFERENCES retail_receipts(receipt_ref),
  version_ref TEXT NOT NULL,
  membership_ref TEXT NOT NULL REFERENCES retail_memberships(membership_ref),
  import_id TEXT NOT NULL,
  UNIQUE (import_id, receipt_ref),
  FOREIGN KEY (version_ref, receipt_ref) REFERENCES retail_receipt_versions(version_ref, receipt_ref),
  FOREIGN KEY (import_id, membership_ref) REFERENCES retail_imports(import_id, membership_ref)
)`],
  ['retail_held', `CREATE TABLE retail_held (
  held_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('held_ref', 'rhd-')}),
  import_id TEXT NOT NULL REFERENCES retail_imports(import_id),
  channel TEXT NOT NULL CHECK (${among('channel', RETAIL_CHANNELS)}),
  natural_key TEXT NULL CHECK ${orNull('natural_key', `(channel = 'online' AND ${naturalKey('natural_key', 'costco-order-')})
    OR (channel <> 'online' AND ${naturalKey('natural_key', 'costco-receipt-')})`)},
  reason TEXT NOT NULL CHECK (${among('reason', RETAIL_HOLD_REASONS)}),
  hold_check TEXT NOT NULL CHECK (${among('hold_check', RETAIL_HOLD_CHECK_NAMES)}),
  date TEXT NULL CHECK ${orNull('date', day('date'))},
  CHECK (${HOLD_REASON_OF_CHECK} = reason),
  CHECK ((natural_key IS NULL) = (hold_check = 'record-key'))
)`],
  ['retail_receipt_reviews', `CREATE TABLE retail_receipt_reviews (
  review_ref TEXT NOT NULL PRIMARY KEY CHECK (${ref('review_ref', 'rtl-rev-')}),
  review_sha256 TEXT NOT NULL CHECK (${letters('review_sha256')}),
  receipt_ref TEXT NOT NULL REFERENCES retail_receipts(receipt_ref),
  evidence_digest TEXT NOT NULL CHECK (${letters('evidence_digest')}),
  through_import_seq INTEGER NOT NULL CHECK (typeof(through_import_seq) = 'integer' AND through_import_seq BETWEEN 1 AND 1000000000),
  decision TEXT NOT NULL CHECK (${among('decision', RETAIL_REVIEW_DECISIONS)}),
  before_version TEXT NOT NULL,
  chosen_version TEXT NULL,
  go_id TEXT NOT NULL CHECK (${letters('go_id', 32)}),
  purpose TEXT NOT NULL CHECK (${among('purpose', RETAIL_PURPOSES['review-receipt'])}),
  reviewed_at TEXT NOT NULL CHECK (${instant('reviewed_at')}),
  CHECK ((decision = 'keep-quarantined') = (chosen_version IS NULL)),
  UNIQUE (review_sha256, receipt_ref),
  FOREIGN KEY (before_version, receipt_ref) REFERENCES retail_receipt_versions(version_ref, receipt_ref),
  FOREIGN KEY (chosen_version, receipt_ref) REFERENCES retail_receipt_versions(version_ref, receipt_ref)
)`],
  // retail_receipt_events: Reserved for a progression (plan §5.7): set on that kind only, null on every other.
  ['retail_receipt_events', `CREATE TABLE retail_receipt_events (
  receipt_ref TEXT NOT NULL REFERENCES retail_receipts(receipt_ref),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 1000000),
  kind TEXT NOT NULL CHECK (${among('kind', RETAIL_EVENT_KINDS)}),
  prior_version TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'quarantined')),
  first_reason TEXT NULL CHECK ${orNull('first_reason', among('first_reason', RETAIL_QUARANTINE_REASONS))},
  canonical_version TEXT NOT NULL,
  reason TEXT NULL CHECK ${orNull('reason', among('reason', RETAIL_QUARANTINE_REASONS))},
  observation_ref TEXT NULL REFERENCES retail_receipt_observations(observation_ref),
  held_ref TEXT NULL REFERENCES retail_held(held_ref),
  review_ref TEXT NULL REFERENCES retail_receipt_reviews(review_ref),
  import_id TEXT NULL REFERENCES retail_imports(import_id),
  go_id TEXT NULL CHECK ${orNull('go_id', letters('go_id', 32))},
  witness_observation_ref TEXT NULL REFERENCES retail_receipt_observations(observation_ref),
  progression_rule TEXT NULL CHECK ${orNull('progression_rule', PROGRESSION_RULE('progression_rule'))},
  at TEXT NOT NULL CHECK (${instant('at')}),
  CHECK ((state = 'active') = (first_reason IS NULL)),
  CHECK ((kind = 'created') = (prior_version IS NULL)),
  CHECK ((reason IS NOT NULL) = (kind IN ('quarantined', 'cause'))),
  CHECK (kind <> 'quarantined' OR first_reason IS reason),
  CHECK (kind NOT IN ('quarantined', 'cause') OR state = 'quarantined'),
  CHECK ((observation_ref IS NOT NULL) + (held_ref IS NOT NULL) + (review_ref IS NOT NULL) = 1),
  CHECK ((review_ref IS NOT NULL) = (kind = 'review')),
  CHECK (held_ref IS NULL OR kind IN ('quarantined', 'cause')),
  CHECK ((import_id IS NULL) = (go_id IS NOT NULL)),
  CHECK ((review_ref IS NOT NULL) = (go_id IS NOT NULL)),
  CHECK ((kind = 'progression') = (witness_observation_ref IS NOT NULL)),
  CHECK ((kind = 'progression') = (progression_rule IS NOT NULL)),
  PRIMARY KEY (receipt_ref, seq),
  FOREIGN KEY (prior_version, receipt_ref) REFERENCES retail_receipt_versions(version_ref, receipt_ref),
  FOREIGN KEY (canonical_version, receipt_ref) REFERENCES retail_receipt_versions(version_ref, receipt_ref)
)`],
  ['retail_audit', `CREATE TABLE retail_audit (
  seq INTEGER NOT NULL PRIMARY KEY CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 1000000000),
  kind TEXT NOT NULL CHECK (${among('kind', RETAIL_AUDIT_KINDS)}),
  input_sha256 TEXT NULL CHECK ${orNull('input_sha256', letters('input_sha256'))},
  plan_digest TEXT NOT NULL CHECK (${letters('plan_digest')}),
  go_id TEXT NULL CHECK ${orNull('go_id', letters('go_id', 32))},
  purpose TEXT NOT NULL CHECK (${among('purpose', AUDIT_PURPOSES)}),
  activation_digest TEXT NULL CHECK ${orNull('activation_digest', letters('activation_digest'))},
  effect_digest TEXT NULL CHECK ${orNull('effect_digest', letters('effect_digest'))},
  at TEXT NOT NULL CHECK (${instant('at')}),
  CHECK (kind <> 'install' OR input_sha256 IS NULL),
  CHECK (kind NOT IN ('import', 'review', 'taxonomy-import', 'bindings-approve') OR input_sha256 IS NOT NULL),
  CHECK ((go_id IS NULL) = (purpose = '${RETAIL_PREVIEW_PURPOSE}')),
  CHECK (purpose <> '${RETAIL_PREVIEW_PURPOSE}' OR kind IN ('install', 'import'))
)`],
  // ----- configuration: taxonomy (written from PR 3) and bindings (written from PR 4) ------------------------------
  ['retail_taxonomy_imports', `CREATE TABLE retail_taxonomy_imports (
  taxonomy_import_id TEXT NOT NULL PRIMARY KEY CHECK (${ref('taxonomy_import_id', 'rtl-tax-')}),
  seq INTEGER NOT NULL UNIQUE CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 1000000000),
  mapping_sha256 TEXT NOT NULL UNIQUE CHECK (${letters('mapping_sha256')}),
  taxonomy_version TEXT NOT NULL CHECK (${slug('taxonomy_version', 48)}),
  go_id TEXT NOT NULL CHECK (${letters('go_id', 32)}),
  purpose TEXT NOT NULL CHECK (${among('purpose', RETAIL_PURPOSES['taxonomy-import'])}),
  imported_at TEXT NOT NULL CHECK (${instant('imported_at')})
)`],
  ['retail_taxonomy_assignments', `CREATE TABLE retail_taxonomy_assignments (
  taxonomy_import_id TEXT NOT NULL REFERENCES retail_taxonomy_imports(taxonomy_import_id),
  subject_kind TEXT NOT NULL CHECK (${among('subject_kind', RETAIL_TAXONOMY_SUBJECT_KINDS)}),
  subject_key TEXT NOT NULL CHECK (${letters('subject_key')}),
  source TEXT NOT NULL CHECK (${among('source', RETAIL_TAXONOMY_SOURCES)}),
  node TEXT NULL CHECK ${orNull('node', `typeof(node) = 'text' AND length(node) BETWEEN 1 AND 80 AND substr(node, 1, 1) GLOB '[a-z]'
    AND node NOT GLOB '*[^a-z0-9/-]*' AND node NOT GLOB '*//*' AND node NOT GLOB '*/'`)},
  confidence_bp INTEGER NULL CHECK ${orNull('confidence_bp', `typeof(confidence_bp) = 'integer' AND confidence_bp BETWEEN 0 AND ${RETAIL_CONFIDENCE_BP_MAX}`)},
  CHECK ((confidence_bp IS NOT NULL) = (source = 'agent' AND node IS NOT NULL)),
  CHECK ((subject_kind = 'department') = (source = 'department-review')),
  PRIMARY KEY (taxonomy_import_id, subject_kind, subject_key, source)
)`],
  ['retail_bindings', `CREATE TABLE retail_bindings (
  binding_id TEXT NOT NULL PRIMARY KEY CHECK (${ref('binding_id', 'rtl-bind-')}),
  merchant TEXT NOT NULL CHECK (merchant = 'costco'),
  network TEXT NOT NULL CHECK (${among('network', RETAIL_NETWORKS)}),
  last4 TEXT NOT NULL CHECK (${last4('last4')}),
  card_account_id TEXT NOT NULL CHECK (typeof(card_account_id) = 'text' AND length(card_account_id) BETWEEN 1 AND 64
    AND card_account_id NOT GLOB '*[^A-Za-z0-9_-]*' AND card_account_id NOT GLOB ${LONG_DIGITS}),
  card_facts_digest TEXT NOT NULL CHECK (${letters('card_facts_digest')}),
  proposal_sha256 TEXT NOT NULL CHECK (${letters('proposal_sha256')}),
  inventory_digest TEXT NOT NULL CHECK (${letters('inventory_digest')}),
  policy_digest TEXT NOT NULL CHECK (${letters('policy_digest')}),
  approved_go TEXT NOT NULL CHECK (${letters('approved_go', 32)}),
  approved_at TEXT NOT NULL CHECK (${instant('approved_at')}),
  state TEXT NOT NULL CHECK (${among('state', RETAIL_BINDING_STATES)}),
  revoked_go TEXT NULL CHECK ${orNull('revoked_go', letters('revoked_go', 32))},
  revoked_at TEXT NULL CHECK ${orNull('revoked_at', instant('revoked_at'))},
  CHECK ((state = 'revoked') = (revoked_go IS NOT NULL)),
  CHECK ((revoked_go IS NULL) = (revoked_at IS NULL))
)`],
];

const INDEXES: ReadonlyArray<readonly [string, string]> = [
  ['retail_bindings_one_active', `CREATE UNIQUE INDEX retail_bindings_one_active ON retail_bindings (merchant, network, last4) WHERE state = 'active'`],
  ['retail_membership_facts_by_membership', 'CREATE INDEX retail_membership_facts_by_membership ON retail_membership_facts (membership_ref)'],
  ['retail_receipt_observations_by_receipt', 'CREATE INDEX retail_receipt_observations_by_receipt ON retail_receipt_observations (receipt_ref)'],
  ['retail_receipt_observations_by_version', 'CREATE INDEX retail_receipt_observations_by_version ON retail_receipt_observations (version_ref)'],
  ['retail_held_by_key', 'CREATE INDEX retail_held_by_key ON retail_held (natural_key) WHERE natural_key IS NOT NULL'],
  ['retail_receipt_versions_by_receipt', 'CREATE INDEX retail_receipt_versions_by_receipt ON retail_receipt_versions (receipt_ref)'],
  ['retail_receipt_reviews_by_receipt', 'CREATE INDEX retail_receipt_reviews_by_receipt ON retail_receipt_reviews (receipt_ref)'],
];

const refuseChange = (what: string) => `BEGIN SELECT RAISE(ABORT, '${what} are append-only'); END`;
/** Every table but the receipts' selection and a binding's revocation is append-only: no update, no delete. */
const APPEND_ONLY = [
  'retail_memberships', 'retail_imports', 'retail_membership_facts', 'retail_import_coverage', 'retail_receipt_versions',
  'retail_tax_legends', 'retail_line_refs', 'retail_line_facts', 'retail_line_uncertain_evidence', 'retail_line_events',
  'retail_shipment_refs', 'retail_shipment_facts', 'retail_tender_refs', 'retail_tender_facts', 'retail_receipt_observations',
  'retail_held', 'retail_receipt_reviews', 'retail_receipt_events', 'retail_audit', 'retail_taxonomy_imports',
  'retail_taxonomy_assignments',
] as const;

const TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  ...APPEND_ONLY.flatMap((table): Array<readonly [string, string]> => [
    [`${table}_no_update`, `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} ${refuseChange(table.replace(/_/g, ' '))}`],
    [`${table}_no_delete`, `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} ${refuseChange(table.replace(/_/g, ' '))}`],
  ]),
  // A receipt starts unselected (selection_seq 0, no canonical version, active); its created event selects it.
  ['retail_receipts_start_unselected', `CREATE TRIGGER retail_receipts_start_unselected BEFORE INSERT ON retail_receipts
WHEN NEW.selection_seq <> 0 OR NEW.canonical_version IS NOT NULL OR NEW.state <> 'active' OR NEW.first_reason IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a retail receipt starts unselected'); END`],
  // A receipt's identity never changes, and it is never deleted.
  ['retail_receipts_identity_fixed', `CREATE TRIGGER retail_receipts_identity_fixed
BEFORE UPDATE OF receipt_ref, merchant, channel, natural_key, first_import ON retail_receipts
BEGIN SELECT RAISE(ABORT, 'a retail receipt keeps its identity'); END`],
  ['retail_receipts_no_delete', `CREATE TRIGGER retail_receipts_no_delete BEFORE DELETE ON retail_receipts
BEGIN SELECT RAISE(ABORT, 'retail receipts are never deleted'); END`],
  // Its selection changes only to the values of its newest event, whose seq is the new selection_seq (plan §4.2).
  ['retail_receipts_selection_by_event', `CREATE TRIGGER retail_receipts_selection_by_event
BEFORE UPDATE OF state, first_reason, canonical_version, selection_seq ON retail_receipts
WHEN NEW.selection_seq <> OLD.selection_seq + 1
  OR NOT EXISTS (SELECT 1 FROM retail_receipt_events AS e WHERE e.receipt_ref = NEW.receipt_ref AND e.seq = NEW.selection_seq
    AND e.seq = (SELECT max(seq) FROM retail_receipt_events WHERE receipt_ref = NEW.receipt_ref)
    AND e.state = NEW.state AND e.first_reason IS NEW.first_reason AND e.canonical_version = NEW.canonical_version)
BEGIN SELECT RAISE(ABORT, 'a retail receipt selection changes only by its next event'); END`],
  // An event follows the receipt's current selection: the next seq, and a prior version that is the selection now (null
  // only for the receipt's first event), so it can never lag behind or skip one (3ddfcd26's gate on prior_version).
  ['retail_receipt_events_chain', `CREATE TRIGGER retail_receipt_events_chain BEFORE INSERT ON retail_receipt_events
WHEN NEW.seq <> 1 + coalesce((SELECT max(seq) FROM retail_receipt_events WHERE receipt_ref = NEW.receipt_ref), 0)
  OR NOT EXISTS (SELECT 1 FROM retail_receipts AS r WHERE r.receipt_ref = NEW.receipt_ref AND r.selection_seq = NEW.seq - 1
    AND r.canonical_version IS NEW.prior_version)
BEGIN SELECT RAISE(ABORT, 'a retail receipt event follows the receipt''s current selection'); END`],
  // An event cites only its own receipt's evidence: a sighting from its own import, a hold imported no later than it, or a
  // review of its own. The sighting behind a created, a provenance-refresh or a progression event is of the version it
  // selects; a progression's witness is a sighting of its prior version (3ddfcd26's implementation gate, 11/09). A review
  // event carries its review's versions, GO and outcome.
  ['retail_receipt_events_cite_own', `CREATE TRIGGER retail_receipt_events_cite_own BEFORE INSERT ON retail_receipt_events
WHEN (NEW.observation_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retail_receipt_observations AS o
    WHERE o.observation_ref = NEW.observation_ref AND o.receipt_ref = NEW.receipt_ref AND o.import_id IS NEW.import_id
      AND (NEW.kind NOT IN ('created', 'provenance-refresh', 'progression') OR o.version_ref = NEW.canonical_version)))
  OR (NEW.held_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retail_held AS h JOIN retail_receipts AS c ON c.receipt_ref = NEW.receipt_ref
      JOIN retail_imports AS hi ON hi.import_id = h.import_id JOIN retail_imports AS ei ON ei.import_id = NEW.import_id
    WHERE h.held_ref = NEW.held_ref AND h.natural_key = c.natural_key AND hi.import_seq <= ei.import_seq))
  OR (NEW.review_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retail_receipt_reviews AS v
    WHERE v.review_ref = NEW.review_ref AND v.receipt_ref = NEW.receipt_ref AND v.go_id = NEW.go_id AND v.before_version = NEW.prior_version
      AND coalesce(v.chosen_version, v.before_version) = NEW.canonical_version AND (v.decision = 'keep-quarantined') = (NEW.state = 'quarantined')))
  OR (NEW.kind = 'progression' AND NOT EXISTS (SELECT 1 FROM retail_receipt_observations AS w
    WHERE w.observation_ref = NEW.witness_observation_ref AND w.receipt_ref = NEW.receipt_ref AND w.version_ref = NEW.prior_version))
BEGIN SELECT RAISE(ABORT, 'a retail receipt event cites only its own receipt''s evidence'); END`],
  // A version's line, shipment and tender facts name refs of that version's own receipt (and a shipment's, of its own
  // line); a warehouse or gas line's fact keeps the ordinal that is its identity (plan §4.3).
  ['retail_line_facts_own_receipt', `CREATE TRIGGER retail_line_facts_own_receipt BEFORE INSERT ON retail_line_facts
WHEN NOT EXISTS (SELECT 1 FROM retail_line_refs AS l JOIN retail_receipt_versions AS v ON v.receipt_ref = l.receipt_ref
    WHERE l.line_ref = NEW.line_ref AND v.version_ref = NEW.version_ref AND (l.ordinal IS NULL OR l.ordinal = NEW.ordinal))
BEGIN SELECT RAISE(ABORT, 'a retail line fact names a line of its own receipt'); END`],
  ['retail_shipment_facts_own_line', `CREATE TRIGGER retail_shipment_facts_own_line BEFORE INSERT ON retail_shipment_facts
WHEN (SELECT line_ref FROM retail_shipment_refs WHERE shipment_ref = NEW.shipment_ref) IS NOT NEW.line_ref
BEGIN SELECT RAISE(ABORT, 'a retail shipment fact names a shipment of its own line'); END`],
  ['retail_tender_facts_own_receipt', `CREATE TRIGGER retail_tender_facts_own_receipt BEFORE INSERT ON retail_tender_facts
WHEN (SELECT receipt_ref FROM retail_tender_refs WHERE tender_ref = NEW.tender_ref)
  IS NOT (SELECT receipt_ref FROM retail_receipt_versions WHERE version_ref = NEW.version_ref)
BEGIN SELECT RAISE(ABORT, 'a retail tender fact names a tender of its own receipt'); END`],
  // A binding changes only once, from active to revoked, with its revocation; it is never deleted.
  ['retail_bindings_facts_fixed', `CREATE TRIGGER retail_bindings_facts_fixed
BEFORE UPDATE OF binding_id, merchant, network, last4, card_account_id, card_facts_digest, proposal_sha256, inventory_digest,
  policy_digest, approved_go, approved_at ON retail_bindings
BEGIN SELECT RAISE(ABORT, 'a retail binding keeps its approval'); END`],
  ['retail_bindings_revoke_once', `CREATE TRIGGER retail_bindings_revoke_once
BEFORE UPDATE OF state, revoked_go, revoked_at ON retail_bindings WHEN OLD.state <> 'active' OR NEW.state <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'a retail binding is revoked once'); END`],
  ['retail_bindings_no_delete', `CREATE TRIGGER retail_bindings_no_delete BEFORE DELETE ON retail_bindings
BEGIN SELECT RAISE(ABORT, 'retail bindings are never deleted'); END`],
];

/** The declared schema, statement by statement: the tables, then their indexes, then their triggers. */
export const RETAIL_SCHEMA_SQL: readonly string[] = Object.freeze([...TABLES, ...INDEXES, ...TRIGGERS].map(([, sql]) => sql));
export const RETAIL_TABLES: readonly string[] = Object.freeze(TABLES.map(([name]) => name));
export const RETAIL_TRIGGERS: readonly string[] = Object.freeze(TRIGGERS.map(([name]) => name));
/** The schema's digest (lowercase hex), over the shared quote-preserving normalization: what a GO names. */
export const RETAIL_SCHEMA_DIGEST = schemaSqlDigest(RETAIL_SCHEMA_SQL);
const RETAIL_SCHEMA: DeclaredSchema = Object.freeze({ prefix: 'retail_', statements: RETAIL_SCHEMA_SQL });

/** How the database's `retail_` objects compare to the declared schema, as counts (plan §2 rule 2). */
export const retailSchemaObjects = (db: Database.Database): SchemaObjectCounts => schemaObjects(db, RETAIL_SCHEMA, 'read retail schema');
/** `present` only for exactly this build's objects, `absent` for none, `conflict` for anything else. Read-only. */
export const retailSchemaState = (db: Database.Database): SchemaState => schemaState(retailSchemaObjects(db));

/** The stored rows holding a reserved value (plan §5.7), by table, as counts. Requires the installed tables. */
export interface RetailReservedCounts {
  events: number;
  reviews: number;
  imports: number;
}

/**
 * Counts every stored row that carries a value reserved for the progression rule's own PR (plan §5.7): an event of the
 * reserved kind or with a reserved column set, a review with the reserved decision, an import with a nonzero
 * `progression_count`. Value-free: counts only.
 */
export function reservedValueCounts(db: Database.Database): RetailReservedCounts {
  try {
    const one = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;
    return {
      events: one(`SELECT count(*) FROM retail_receipt_events
        WHERE kind = ? OR witness_observation_ref IS NOT NULL OR progression_rule IS NOT NULL`, RETAIL_RESERVED.eventKind),
      reviews: one('SELECT count(*) FROM retail_receipt_reviews WHERE decision = ?', RETAIL_RESERVED.decision),
      imports: one(`SELECT count(*) FROM retail_imports WHERE ${RETAIL_RESERVED.countColumn} <> 0`),
    };
  } catch (error) {
    throw toValueFreeDbError('read retail reserved values', error);
  }
}

/** The integrity STOP (plan §5.7): any stored reserved value refuses `retail-reserved-value`, with the tables' counts only. */
export function assertNoReservedValues(db: Database.Database): void {
  const counts = reservedValueCounts(db);
  if (counts.events + counts.reviews + counts.imports > 0) throw new RetailRefusal('retail-reserved-value', { ...counts });
}

/**
 * Every command's first read (plan §2 rule 2, §5.7): the tables absent (`retail-not-installed`) or in another shape
 * (`retail-conflict`) refuse before anything else is read, and so does a stored reserved value (`retail-reserved-value`),
 * right after the schema is found present: no answer, an idempotent one included, comes from a database holding one.
 */
export function requireRetailSchema(db: Database.Database): void {
  const state = retailSchemaState(db);
  if (state === 'conflict') throw new RetailRefusal('retail-conflict');
  if (state !== 'present') throw new RetailRefusal('retail-not-installed');
  assertNoReservedValues(db);
}

/** The schema's state for a reader that answers `absent` itself: a conflict and a stored reserved value refuse. */
export function retailSchemaForRead(db: Database.Database): 'present' | 'absent' {
  const state = retailSchemaState(db);
  if (state === 'conflict') throw new RetailRefusal('retail-conflict');
  if (state === 'present') assertNoReservedValues(db);
  return state;
}

export const RETAIL_REFUSALS = Object.freeze({
  unverified: 'retail tables did not install as expected; nothing was installed',
});

/** What an install's audit row names as its plan: this build's schema. */
export const RETAIL_INSTALL_PLAN_DIGEST = digest({ format: 'holdr.retail-install-plan', version: 1, schemaDigest: RETAIL_SCHEMA_DIGEST });

export interface RetailInstallReceipt {
  installed: boolean;
  objects: SchemaObjectCounts;
}

/**
 * The one install (plan §2 rule 1): `holdr-retail install` calls it inside its backed-up IMMEDIATE transaction, the
 * preview on its own clone (alone, it runs in one of its own). Tables in another shape refuse (`retail-conflict`); tables
 * already there write nothing (after the reserved-value STOP); else every table, index and trigger, verified, and one
 * audit row, before commit.
 */
export function installRetailSchema(db: Database.Database, context: RetailWriteContext): RetailInstallReceipt {
  const authority = checkRetailWriteContext(context, 'install');
  try {
    return db.transaction((): RetailInstallReceipt => {
      const state = retailSchemaState(db);
      if (state === 'conflict') throw new RetailRefusal('retail-conflict');
      if (state === 'present') {
        assertNoReservedValues(db);
        return { installed: false, objects: retailSchemaObjects(db) };
      }
      for (const sql of RETAIL_SCHEMA_SQL) db.exec(sql);
      if (retailSchemaState(db) !== 'present') throw new HoldrRefusal(RETAIL_REFUSALS.unverified);
      appendRetailAudit(db, { kind: 'install', inputSha256: null, planDigest: retailLetters(RETAIL_INSTALL_PLAN_DIGEST), authority });
      return { installed: true, objects: retailSchemaObjects(db) };
    }).immediate();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('install retail schema', error);
  }
}

/** One audit row (plan §4.2): its kind, its input and plan digests (letter hex) and the write's authority. */
export interface RetailAuditEntry {
  kind: Extract<RetailAuditKind, 'install' | 'import' | 'review' | 'taxonomy-import'>;
  inputSha256: string | null;
  planDigest: string;
  authority: RetailStoredAuthority;
}

/** Appends one audit row at the next sequence, inside the caller's transaction. */
export function appendRetailAudit(db: Database.Database, entry: RetailAuditEntry): number {
  const seq = (db.prepare('SELECT coalesce(max(seq), 0) + 1 FROM retail_audit').pluck().get() as number);
  db.prepare(`INSERT INTO retail_audit (seq, kind, input_sha256, plan_digest, go_id, purpose, activation_digest, effect_digest, at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
    .run(seq, entry.kind, entry.inputSha256, entry.planDigest, entry.authority.goId, entry.authority.purpose, entry.authority.at);
  return seq;
}
