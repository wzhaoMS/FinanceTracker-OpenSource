import type Database from 'better-sqlite3';
import {
  METAL_FORMS,
  METAL_MASS_UNITS,
  METAL_PACKS,
  METALS,
  METALS_BULLION_ANSWERS,
  METALS_BUY_EVENT_KINDS,
  METALS_CHANNELS,
  METALS_COIN_DESIGNS,
  METALS_COMPETITOR_BASES,
  METALS_CONTENT_HOLDS,
  METALS_COVERAGE_KINDS,
  METALS_DATE_BASES,
  METALS_EVIDENCE_CLASSES,
  METALS_FINE_BASES,
  METALS_GUARD_EVIDENCE,
  METALS_HOLD_REASONS,
  METALS_INSPECTIONS,
  METALS_MASS_BASES,
  METALS_MAX_MINOR,
  METALS_NETWORKS,
  METALS_PAYOUT_STATUSES,
  METALS_PREMIUM_BASES,
  METALS_PRODUCT_REF_MAX,
  METALS_RETAIL_FORMATS,
  METALS_RETAIL_POLICIES,
  METALS_RULES,
  METALS_SELL_STATUSES,
  METALS_SIDES,
  METALS_SOURCES,
  METALS_TENDER_KINDS,
  METALS_TITLE_GUARD,
} from '@finance-tracker/shared/metals-ledger';

import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';
import {
  normalizeSchemaSql,
  schemaObjects,
  schemaSqlDigest,
  schemaState,
  type DeclaredSchema,
  type SchemaObjectCounts,
  type SchemaState,
} from '../schemaShape.js';
import { MetalsRefusal } from './common.js';

/**
 * The metals ledger's tables (design v8 §6). Operator-installed and outside `user_version`: nothing creates them at boot
 * and no migration touches them; only the backed-up, Root-GO'd `holdr-metals install` (cli/metals.ts) does, in one
 * IMMEDIATE transaction, and every later PR reads and writes these same tables with no second schema change. Anything
 * else named `metals_…`, or anything else on one of these tables, is a conflict: never repaired, never read.
 *
 * - `metals_accounts`, `metals_imports`, `metals_order_versions`, `metals_observations`: every payload's receipt, every
 *   version of every order (its canonical aggregate) and every payload's view of it. Each import's `import_seq` is its
 *   causal place: one more than the highest, taken inside the import's IMMEDIATE write, so imports are ordered by when
 *   they committed, never by a random id or a clock (G3 reads chronology from it). Append-only: a version's facts never
 *   change and only its state moves (active → superseded; proposed or conflict → active or superseded). A version Root
 *   chose keeps the GO that chose it (`chosen_by_go`, `chosen_at`), whatever happens to it later; `resolved_by_go` is
 *   the GO that replaced or declined it, and a progression carries none.
 * - `metals_orders`, `metals_lots`, `metals_lot_events`, `metals_tenders`, `metals_card_evidence`, `metals_dispositions`,
 *   `metals_payouts`: the active versions only, normalized for reading, rewritten for one order in the transaction that
 *   changes its active version. A sale line keeps its own events (`events_json`).
 * - `metals_competitors`: every distinct fact-version of every other order's card funding, one row per card method.
 * - `metals_competitor_observations` (design delta D-G2-2): every competitor each import listed, an unchanged re-read
 *   included, with the digest of the fact-version it showed; nothing for a competitor an import doesn't list.
 *   Append-only, and every row names a stored fact-version.
 * - `metals_holds`, `metals_coverage`: each payload's held records and stated coverage.
 * - `metals_bindings`: Root-approved payment identities, with the facts their drift is judged against when read.
 * - `metals_owner_decisions`: the owner's decisions (the spending rule, product content, bullion; later storage, deposit
 *   links). A decision changes only by its one revoke, and is never deleted.
 * - Corrections (corrections design r6 §4), stored by this one install though their commands come later: an import's
 *   one void (`voided_*`, with the retirement and collateral authorizations), an account's one retirement, a version
 *   voided, `renewed` or `reinstated` (a copy naming the version it copies), the import a Root choice followed
 *   (`chosen_seq`), and the version a progression replaced. Every table a no-update, one-way or no-delete trigger
 *   protects (METALS_PROTECTED) gets generated insert guards: no INSERT OR REPLACE can delete one of its rows, and no
 *   row is born past a one-way change. Writers give each such row an explicit rowid, one more than the table's highest.
 *
 * Every text column is guarded, as the checking tables are: typed shapes for keys, ids, digests (letter hex, never a
 * digit), dates and last 4s, and for free text and JSON a length bound and no run of 13 or more digits. Typed exact
 * values are exempt from the digit guard (ROOT's ratified narrowing): a computed fine-content rational (mass × purity
 * can be long), and the canonical aggregate as a whole, which embeds it; every free-text string nested in the aggregate
 * keeps the guard through a trigger (METALS_NESTED_TEXT_GUARD). Amounts are integers within the payload's bounds,
 * vocabularies are CHECKed, and no CHECK refuses a payload the validator accepts without the import refusing it first,
 * before any write.
 */

const MAX = METALS_MAX_MINOR;
const LONG_DIGITS = `'*${'[0-9]'.repeat(13)}*'`;
const among = (column: string, values: readonly string[]) => `${column} IN (${values.map((value) => `'${value}'`).join(', ')})`;
const orNull = (column: string, rule: string) => `(${column} IS NULL OR (${rule}))`;
const letters = (column: string, length = 64) => `typeof(${column}) = 'text' AND length(${column}) = ${length} AND ${column} NOT GLOB '*[^a-p]*'`;
const id = (column: string, prefix: string) => `typeof(${column}) = 'text' AND length(${column}) = ${prefix.length + 32} `
  + `AND substr(${column}, 1, ${prefix.length}) = '${prefix}' AND substr(${column}, ${prefix.length + 1}) NOT GLOB '*[^a-p]*'`;
const day = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 10 AND date(${column}) IS ${column}`;
const instant = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column}`;
const key = (column: string, prefixes: readonly string[]) => `typeof(${column}) = 'text' AND substr(${column}, -64) NOT GLOB '*[^a-p]*' AND (`
  + prefixes.map((prefix) => `(length(${column}) = ${prefix.length + 65} AND substr(${column}, 1, ${prefix.length + 1}) = '${prefix}-')`).join(' OR ') + ')';
const minor = (column: string, min = -MAX, max = MAX) => `typeof(${column}) = 'integer' AND ${column} BETWEEN ${min} AND ${max}`;
const count = (column: string, max = 1_000_000) => `typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max}`;
const bool = (column: string) => `typeof(${column}) = 'integer' AND ${column} IN (0, 1)`;
const last4 = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 4 AND ${column} NOT GLOB '*[^0-9]*'`;
const slug = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${max} `
  + `AND substr(${column}, 1, 1) GLOB '[a-z]' AND ${column} NOT GLOB '*[^a-z0-9-]*' AND ${column} NOT GLOB ${LONG_DIGITS}`;
const text = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${max} AND ${column} = trim(${column}) `
  + `AND ${column} NOT GLOB '[=+@-]*' AND ${column} NOT GLOB ${LONG_DIGITS}`;
const json = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 2 AND ${max} AND json_valid(${column}) `
  + `AND ${column} NOT GLOB ${LONG_DIGITS}`;
/**
 * The canonical aggregate: valid JSON within a length bound. Its typed values include computed fine-content rationals,
 * which can be long, so the digit guard applies to the free-text strings nested in it (a trigger), not the whole text.
 */
const aggregateJson = (column: string, max: number) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 2 AND ${max} AND json_valid(${column})`;
/** A positive exact rational "n/d" written or confirmed as text; the digit guard keeps each side to at most 12 digits. */
const rational = (column: string) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 3 AND 25 AND ${column} GLOB '[1-9]*/[1-9]*' `
  + `AND ${column} NOT GLOB '*[^0-9/]*' AND ${column} NOT GLOB '*/*/*' AND ${column} NOT GLOB ${LONG_DIGITS}`;
/** A positive exact rational "n/d" the content rule computed (mass × purity can be long; the validator admits it). */
const computedRational = (column: string) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 3 AND 200 `
  + `AND ${column} GLOB '[1-9]*/[1-9]*' AND ${column} NOT GLOB '*[^0-9/]*' AND ${column} NOT GLOB '*/*/*'`;
const actor = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 36 AND substr(${column}, 1, 4) = 'usr_' `
  + `AND substr(${column}, 5) NOT GLOB '*[^a-p]*'`;
/**
 * One import column per key of the rules a payload pins (METALS_RULES), generated so that a new key (1E's `titleGuard`,
 * as `title_guard_rule`) is stored with no change here and no rule a payload pins is dropped: `coinSpecs` is
 * `coin_specs_rule`.
 */
export const METALS_RULE_COLUMNS: ReadonlyArray<readonly [keyof typeof METALS_RULES, string]> = Object.freeze(
  (Object.keys(METALS_RULES) as Array<keyof typeof METALS_RULES>).map((key) => [key, `${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_rule`] as const));
/**
 * A product ref exactly as the validator admits it (payload.ts): `<source>:` and an id of 1 to METALS_PRODUCT_REF_MAX
 * characters from [A-Za-z0-9_-], generated from the contract, so the column holds the source's prefix plus the whole
 * id; and, as every free text here, no run of 13 or more digits.
 */
const productRef = (column: string) => `typeof(${column}) = 'text' AND ${column} NOT GLOB ${LONG_DIGITS} AND (`
  + METALS_SOURCES.map((source) => `(substr(${column}, 1, ${source.length + 1}) = '${source}:' AND length(${column}) BETWEEN ${source.length + 2} `
    + `AND ${source.length + 1 + METALS_PRODUCT_REF_MAX} AND substr(${column}, ${source.length + 2}) NOT GLOB '*[^A-Za-z0-9_-]*')`).join(' OR ') + ')';
/**
 * Every evidence list a flag can carry (payload.ts `checkMetalUncertain`): a non-empty subset of METALS_GUARD_EVIDENCE in
 * its closed order, once each, as the canonical JSON the projection stores. Generated, so the CHECK is exactly the
 * validator's rule; a CHECK can't read the JSON itself (no subquery).
 */
export const METALS_GUARD_EVIDENCE_LISTS: readonly string[] = Object.freeze(Array.from({ length: (1 << METALS_GUARD_EVIDENCE.length) - 1 },
  (_, index) => JSON.stringify(METALS_GUARD_EVIDENCE.filter((__, bit) => ((index + 1) >> bit) & 1))));
const sourceOf = (column: string) => `substr(${column}, 1, length(source) + 1) = source || '-'`;

const ORDER_KEYS = ['costco-order', 'costco-receipt', 'walmart-order', 'collectpure-sell'] as const;
const BUY_ORDER_KEYS = ['costco-order', 'costco-receipt', 'walmart-order'] as const;
const LOT_KEYS = ['costco-line', 'costco-wline', 'walmart-line'] as const;
const SALE_LINE_KEYS = ['collectpure-sline'] as const;
const PAYOUT_KEYS = ['collectpure-payout'] as const;
export const METALS_VERSION_STATES = ['active', 'superseded', 'proposed', 'conflict'] as const;
export const METALS_VERSION_REASONS = ['new', 'progression', 'proposal', 'conflict', 'renewed', 'reinstated'] as const;
export const METALS_VERSION_RESOLUTIONS = ['progressed', 'replaced', 'declined', 'voided'] as const;
export const METALS_IMPORT_OUTCOMES = ['new', 'observation', 'predecessor', 'progression', 'proposal', 'conflict', 'renewed'] as const;
export const METALS_IMPORT_PURPOSES = ['copy-rehearsal', 'production-import'] as const;
export const METALS_BINDING_PURPOSES = ['copy-rehearsal', 'production-bindings'] as const;
/** Why an import was voided (corrections r6 §2.6, ROOT). */
export const METALS_VOID_REASONS = ['wrong-account', 'wrong-payload', 'duplicate-capture'] as const;
/** The correction markers' reasons (corrections r6 §1, ROOT): a void records the one it ran under. */
export const METALS_CORRECTION_REASONS = ['import-wrong-account', 'import-wrong-payload', 'capture-contradiction', 'owner-reported-error'] as const;
export const METALS_DECISION_KINDS = ['spending-rule', 'product-content', 'storage', 'deposit-link', 'bullion'] as const;

/**
 * The content columns a lot and a disposition share (§4.4.1). A line the title guard flagged (contract follow-up 1)
 * keeps its flag whole: the guard, its evidence list and the metal its title names (null when several); its `metal` is
 * null, since a flag only marks a line whose title reads as no metal.
 */
const CONTENT_COLUMNS = `title TEXT NULL CHECK ${orNull('title', text('title', 240))},
  product_ref TEXT NULL CHECK ${orNull('product_ref', productRef('product_ref'))},
  metal TEXT NULL CHECK ${orNull('metal', among('metal', METALS))},
  metal_uncertain_guard TEXT NULL CHECK ${orNull('metal_uncertain_guard', `metal_uncertain_guard = '${METALS_TITLE_GUARD}'`)},
  metal_uncertain_evidence TEXT NULL CHECK ${orNull('metal_uncertain_evidence', among('metal_uncertain_evidence', METALS_GUARD_EVIDENCE_LISTS))},
  metal_uncertain_metal TEXT NULL CHECK ${orNull('metal_uncertain_metal', among('metal_uncertain_metal', METALS))},
  form TEXT NULL CHECK ${orNull('form', among('form', METAL_FORMS))},
  stated_mass_value TEXT NULL CHECK ${orNull('stated_mass_value', `typeof(stated_mass_value) = 'text' AND length(stated_mass_value) BETWEEN 1 AND 16 `
    + `AND substr(stated_mass_value, 1, 1) GLOB '[0-9]' AND stated_mass_value NOT GLOB '*[^0-9./ ]*'`)},
  stated_mass_unit TEXT NULL CHECK ${orNull('stated_mass_unit', among('stated_mass_unit', METAL_MASS_UNITS))},
  pack TEXT NOT NULL CHECK (${among('pack', METAL_PACKS)}),
  purity_text TEXT NULL CHECK ${orNull('purity_text', `typeof(purity_text) = 'text' AND length(purity_text) BETWEEN 2 AND 8 AND purity_text NOT GLOB '*[^0-9.%K]*'`)},
  purity_value TEXT NULL CHECK ${orNull('purity_value', rational('purity_value'))},
  mass_basis TEXT NULL CHECK ${orNull('mass_basis', among('mass_basis', METALS_MASS_BASES))},
  design TEXT NULL CHECK ${orNull('design', among('design', METALS_COIN_DESIGNS))},
  content_fingerprint TEXT NOT NULL CHECK (${letters('content_fingerprint')}),
  fine_troy_oz TEXT NULL CHECK ${orNull('fine_troy_oz', computedRational('fine_troy_oz'))},
  fine_basis TEXT NULL CHECK ${orNull('fine_basis', among('fine_basis', METALS_FINE_BASES))},
  content_hold TEXT NULL CHECK ${orNull('content_hold', among('content_hold', METALS_CONTENT_HOLDS))},
  content_missing TEXT NULL CHECK ${orNull('content_missing', json('content_missing', 1000))},
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 100000),
  unit_price_minor INTEGER NULL CHECK ${orNull('unit_price_minor', minor('unit_price_minor', 0))},`;
const CONTENT_CHECKS = `CHECK ((stated_mass_value IS NULL) = (stated_mass_unit IS NULL)),
  CHECK ((purity_text IS NULL) = (purity_value IS NULL)),
  CHECK ((fine_troy_oz IS NULL) = (fine_basis IS NULL)),
  CHECK ((content_hold IS NULL) = (content_missing IS NULL)),
  CHECK ((fine_troy_oz IS NULL) <> (content_hold IS NULL)),
  CHECK ((metal_uncertain_guard IS NULL) = (metal_uncertain_evidence IS NULL)),
  CHECK (metal_uncertain_guard IS NOT NULL OR metal_uncertain_metal IS NULL),
  CHECK (metal_uncertain_guard IS NULL OR metal IS NULL)`;

const TABLES: ReadonlyArray<readonly [string, string]> = [
  ['metals_accounts', `CREATE TABLE metals_accounts (
  account_id TEXT NOT NULL PRIMARY KEY CHECK (${id('account_id', 'mtl-acct-')}),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)}),
  label TEXT NOT NULL CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 60 AND label = trim(label) AND substr(label, 1, 1) GLOB '[A-Za-z]'
    AND label NOT GLOB '*[^A-Za-z0-9 ._-]*' AND label NOT GLOB '*[0-9][0-9][0-9][0-9]*' AND label NOT GLOB '*  *'),
  folder TEXT NOT NULL CHECK (typeof(folder) = 'text' AND (folder = source OR (length(folder) BETWEEN length(source) + 2 AND length(source) + 4
    AND ${sourceOf('folder')} AND substr(folder, length(source) + 2, 1) GLOB '[1-9]' AND substr(folder, length(source) + 2) NOT GLOB '*[^0-9]*'))),
  identity_last4 TEXT NULL CHECK ${orNull('identity_last4', `${last4('identity_last4')} AND source = 'costco'`)},
  created_by_import TEXT NOT NULL REFERENCES metals_imports(import_id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL CHECK (${instant('created_at')}),
  retired_by_import TEXT NULL CHECK ${orNull('retired_by_import', id('retired_by_import', 'mtl-imp-'))} REFERENCES metals_imports(import_id)
)`],
  ['metals_imports', `CREATE TABLE metals_imports (
  import_id TEXT NOT NULL PRIMARY KEY CHECK (${id('import_id', 'mtl-imp-')}),
  import_seq INTEGER NOT NULL UNIQUE CHECK (typeof(import_seq) = 'integer' AND import_seq BETWEEN 1 AND 1000000000),
  payload_sha256 TEXT NOT NULL CHECK (${letters('payload_sha256')}),
  format TEXT NOT NULL CHECK (format = 'holdr.metals-import'),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version = 1),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)}),
  account_id TEXT NOT NULL REFERENCES metals_accounts(account_id),
  converter_version TEXT NOT NULL CHECK (typeof(converter_version) = 'text' AND length(converter_version) BETWEEN 26 AND 32
    AND substr(converter_version, 1, 21) = 'holdr-metals-convert ' AND substr(converter_version, 22) GLOB '[0-9]*.[0-9]*.[0-9]*'
    AND substr(converter_version, 22) NOT GLOB '*[^0-9.]*'),
  policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version BETWEEN 1 AND 999),
  ${METALS_RULE_COLUMNS.map(([, column]) => `${column} TEXT NOT NULL CHECK (${slug(column, 48)}),`).join('\n  ')}
  input_kind TEXT NOT NULL CHECK (input_kind IN ('capture', 'retail-payload')),
  capture_schema TEXT NULL CHECK ${orNull('capture_schema', `typeof(capture_schema) = 'text' AND length(capture_schema) BETWEEN 1 AND 64 `
    + `AND capture_schema NOT GLOB '*[^a-z0-9@/.-]*' AND capture_schema NOT GLOB ${LONG_DIGITS}`)},
  capture_digest TEXT NULL CHECK ${orNull('capture_digest', letters('capture_digest'))},
  captured_at TEXT NULL CHECK ${orNull('captured_at', instant('captured_at'))},
  capture_files INTEGER NULL CHECK ${orNull('capture_files', count('capture_files', 100_000))},
  retail_payload_sha256 TEXT NULL CHECK ${orNull('retail_payload_sha256', letters('retail_payload_sha256'))},
  retail_format INTEGER NULL CHECK (retail_format IS NULL OR (typeof(retail_format) = 'integer' AND retail_format IN (${METALS_RETAIL_FORMATS.join(', ')}))),
  retail_policy INTEGER NULL CHECK (retail_policy IS NULL OR (typeof(retail_policy) = 'integer' AND retail_policy IN (${METALS_RETAIL_POLICIES.join(', ')}))),
  go_id TEXT NOT NULL CHECK (${letters('go_id', 32)}),
  purpose TEXT NOT NULL CHECK (${among('purpose', METALS_IMPORT_PURPOSES)}),
  imported_at TEXT NOT NULL CHECK (${instant('imported_at')}),
  order_count INTEGER NOT NULL CHECK (${count('order_count')}),
  line_count INTEGER NOT NULL CHECK (${count('line_count', 10_000_000)}),
  competitor_count INTEGER NOT NULL CHECK (${count('competitor_count')}),
  held_count INTEGER NOT NULL CHECK (${count('held_count')}),
  coverage_count INTEGER NOT NULL CHECK (${count('coverage_count')}),
  new_count INTEGER NOT NULL CHECK (${count('new_count')}),
  observation_count INTEGER NOT NULL CHECK (${count('observation_count')}),
  predecessor_count INTEGER NOT NULL CHECK (${count('predecessor_count')}),
  progression_count INTEGER NOT NULL CHECK (${count('progression_count')}),
  proposal_count INTEGER NOT NULL CHECK (${count('proposal_count')}),
  conflict_count INTEGER NOT NULL CHECK (${count('conflict_count')}),
  renewed_count INTEGER NOT NULL CHECK (${count('renewed_count')}),
  corrects_import TEXT NULL CHECK ${orNull('corrects_import', id('corrects_import', 'mtl-imp-'))} REFERENCES metals_imports(import_id),
  voided_by_go TEXT NULL CHECK ${orNull('voided_by_go', letters('voided_by_go', 32))},
  voided_at TEXT NULL CHECK ${orNull('voided_at', instant('voided_at'))},
  void_reason TEXT NULL CHECK ${orNull('void_reason', among('void_reason', METALS_VOID_REASONS))},
  voided_under_marker TEXT NULL CHECK ${orNull('voided_under_marker', letters('voided_under_marker'))},
  voided_under_reason TEXT NULL CHECK ${orNull('voided_under_reason', among('voided_under_reason', METALS_CORRECTION_REASONS))},
  retire_account_id TEXT NULL CHECK ${orNull('retire_account_id', id('retire_account_id', 'mtl-acct-'))} REFERENCES metals_accounts(account_id),
  voided_for_import TEXT NULL CHECK ${orNull('voided_for_import', id('voided_for_import', 'mtl-imp-'))} REFERENCES metals_imports(import_id),
  CHECK (new_count + observation_count + predecessor_count + progression_count + proposal_count + conflict_count + renewed_count = order_count),
  CHECK ((voided_by_go IS NULL) = (voided_at IS NULL) AND (voided_by_go IS NULL) = (void_reason IS NULL)
    AND (voided_by_go IS NULL) = (voided_under_marker IS NULL) AND (voided_by_go IS NULL) = (voided_under_reason IS NULL)),
  CHECK (voided_at IS NULL OR voided_at >= imported_at),
  CHECK (retire_account_id IS NULL OR (void_reason = 'wrong-account' AND voided_under_reason = 'import-wrong-account' AND retire_account_id = account_id)),
  CHECK (voided_for_import IS NULL OR (voided_by_go IS NOT NULL AND retire_account_id IS NULL AND voided_for_import <> import_id)),
  CHECK (corrects_import IS NULL OR corrects_import <> import_id),
  CHECK ((input_kind = 'capture') = (capture_schema IS NOT NULL AND capture_digest IS NOT NULL AND captured_at IS NOT NULL AND capture_files IS NOT NULL)),
  CHECK (input_kind = 'capture' OR (capture_schema IS NULL AND capture_digest IS NULL AND captured_at IS NULL AND capture_files IS NULL)),
  CHECK ((input_kind = 'retail-payload') = (retail_payload_sha256 IS NOT NULL AND retail_format IS NOT NULL AND retail_policy IS NOT NULL)),
  CHECK (input_kind = 'retail-payload' OR (retail_payload_sha256 IS NULL AND retail_format IS NULL AND retail_policy IS NULL)),
  CHECK ((input_kind = 'retail-payload') = (source = 'costco'))
)`],
  ['metals_order_versions', `CREATE TABLE metals_order_versions (
  order_key TEXT NOT NULL CHECK (${key('order_key', ORDER_KEYS)}),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 1000000),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)} AND ${sourceOf('order_key')}),
  side TEXT NOT NULL CHECK (${among('side', METALS_SIDES)}),
  digest TEXT NOT NULL CHECK (${letters('digest')}),
  canonical_json TEXT NOT NULL CHECK (${aggregateJson('canonical_json', 100_000_000)}),
  state TEXT NOT NULL CHECK (${among('state', METALS_VERSION_STATES)}),
  reason TEXT NOT NULL CHECK (${among('reason', METALS_VERSION_REASONS)}),
  created_by_import TEXT NOT NULL REFERENCES metals_imports(import_id),
  created_at TEXT NOT NULL CHECK (${instant('created_at')}),
  resolution TEXT NULL CHECK ${orNull('resolution', among('resolution', METALS_VERSION_RESOLUTIONS))},
  resolved_by_go TEXT NULL CHECK ${orNull('resolved_by_go', letters('resolved_by_go', 32))},
  resolved_at TEXT NULL CHECK ${orNull('resolved_at', instant('resolved_at'))},
  chosen_by_go TEXT NULL CHECK ${orNull('chosen_by_go', letters('chosen_by_go', 32))},
  chosen_at TEXT NULL CHECK ${orNull('chosen_at', instant('chosen_at'))},
  chosen_seq INTEGER NULL CHECK (chosen_seq IS NULL OR (typeof(chosen_seq) = 'integer' AND chosen_seq BETWEEN 1 AND 1000000000)),
  reinstates_version INTEGER NULL CHECK (reinstates_version IS NULL
    OR (typeof(reinstates_version) = 'integer' AND reinstates_version BETWEEN 1 AND 1000000)),
  reinstated_by_go TEXT NULL CHECK ${orNull('reinstated_by_go', letters('reinstated_by_go', 32))},
  PRIMARY KEY (order_key, version),
  FOREIGN KEY (order_key, reinstates_version) REFERENCES metals_order_versions(order_key, version),
  CHECK ((side = 'sell') = (source = 'collectpure')),
  CHECK (reason <> 'new' OR version = 1),
  CHECK (reason <> 'renewed' OR version > 1),
  CHECK ((reason = 'reinstated') = (reinstates_version IS NOT NULL)),
  CHECK ((reason = 'reinstated') = (reinstated_by_go IS NOT NULL)),
  CHECK (reinstates_version IS NULL OR reinstates_version < version),
  CHECK (state NOT IN ('proposed', 'conflict') OR (resolution IS NULL AND resolved_by_go IS NULL AND resolved_at IS NULL AND chosen_by_go IS NULL)),
  CHECK (state <> 'active' OR (resolution IS NULL AND resolved_by_go IS NULL AND resolved_at IS NULL)),
  CHECK (state <> 'superseded' OR resolution IS NOT NULL),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
  CHECK ((resolved_by_go IS NOT NULL) = (coalesce(resolution, '') IN ('replaced', 'declined', 'voided'))),
  CHECK ((chosen_by_go IS NULL) = (chosen_at IS NULL)),
  CHECK ((chosen_by_go IS NULL) = (chosen_seq IS NULL)),
  CHECK (chosen_by_go IS NULL OR reason IN ('proposal', 'conflict')),
  CHECK (coalesce(resolution, '') <> 'declined' OR (reason IN ('proposal', 'conflict') AND chosen_by_go IS NULL)),
  CHECK (reason NOT IN ('proposal', 'conflict') OR state IN ('proposed', 'conflict') OR chosen_by_go IS NOT NULL
    OR coalesce(resolution, '') IN ('declined', 'voided')),
  CHECK (chosen_at IS NULL OR chosen_at >= created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
)`],
  ['metals_observations', `CREATE TABLE metals_observations (
  import_id TEXT NOT NULL REFERENCES metals_imports(import_id),
  account_id TEXT NOT NULL REFERENCES metals_accounts(account_id),
  order_key TEXT NOT NULL CHECK (${key('order_key', ORDER_KEYS)}),
  version_digest TEXT NOT NULL CHECK (${letters('version_digest')}),
  outcome TEXT NOT NULL CHECK (${among('outcome', METALS_IMPORT_OUTCOMES)}),
  version INTEGER NULL CHECK (version IS NULL OR (typeof(version) = 'integer' AND version BETWEEN 1 AND 1000000)),
  replaces_version INTEGER NULL CHECK (replaces_version IS NULL
    OR (typeof(replaces_version) = 'integer' AND replaces_version BETWEEN 1 AND 1000000)),
  PRIMARY KEY (import_id, account_id, order_key),
  FOREIGN KEY (order_key, version) REFERENCES metals_order_versions(order_key, version),
  FOREIGN KEY (order_key, replaces_version) REFERENCES metals_order_versions(order_key, version),
  CHECK ((outcome = 'predecessor') = (version IS NULL)),
  CHECK ((outcome = 'progression') = (replaces_version IS NOT NULL)),
  CHECK (replaces_version IS NULL OR replaces_version < version)
)`],
  ['metals_orders', `CREATE TABLE metals_orders (
  order_key TEXT NOT NULL PRIMARY KEY CHECK (${key('order_key', ORDER_KEYS)}),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 1000000),
  account_id TEXT NOT NULL REFERENCES metals_accounts(account_id),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)} AND ${sourceOf('order_key')}),
  side TEXT NOT NULL CHECK (${among('side', METALS_SIDES)}),
  channel TEXT NOT NULL CHECK (${among('channel', METALS_CHANNELS)}),
  order_date TEXT NOT NULL CHECK (${day('order_date')}),
  trade_moment TEXT NULL CHECK ${orNull('trade_moment', instant('trade_moment'))},
  completed_date TEXT NULL CHECK ${orNull('completed_date', day('completed_date'))},
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  status TEXT NULL CHECK ${orNull('status', among('status', METALS_SELL_STATUSES))},
  fulfilment TEXT NULL CHECK (fulfilment IS NULL OR fulfilment IN ('in-store', 'shipments')),
  shipments INTEGER NULL CHECK (shipments IS NULL OR (typeof(shipments) = 'integer' AND shipments BETWEEN 0 AND 1000)),
  refunded INTEGER NULL CHECK ${orNull('refunded', bool('refunded'))},
  cancelled INTEGER NULL CHECK ${orNull('cancelled', bool('cancelled'))},
  partly_cancelled INTEGER NULL CHECK ${orNull('partly_cancelled', bool('partly_cancelled'))},
  gross_total_minor INTEGER NULL CHECK ${orNull('gross_total_minor', minor('gross_total_minor', 0))},
  full_price_minor INTEGER NOT NULL CHECK (${minor('full_price_minor')}),
  unattributed_minor INTEGER NOT NULL CHECK (${minor('unattributed_minor')}),
  skeleton_json TEXT NOT NULL CHECK (${json('skeleton_json', 1_000_000)}),
  components_json TEXT NOT NULL CHECK (${json('components_json', 10_000)}),
  refunds_json TEXT NOT NULL CHECK (${json('refunds_json', 10_000)}),
  FOREIGN KEY (order_key, version) REFERENCES metals_order_versions(order_key, version),
  CHECK ((side = 'sell') = (source = 'collectpure')),
  CHECK (side = 'buy' OR (status IS NOT NULL AND trade_moment IS NOT NULL AND channel = 'online' AND fulfilment IS NULL AND shipments IS NULL
    AND refunded IS NULL AND cancelled IS NULL AND partly_cancelled IS NULL AND gross_total_minor IS NULL)),
  CHECK (side = 'sell' OR (status IS NULL AND trade_moment IS NULL AND fulfilment IS NOT NULL AND refunded IS NOT NULL AND cancelled IS NOT NULL
    AND partly_cancelled IS NOT NULL)),
  CHECK (fulfilment IS NULL OR ((fulfilment = 'in-store') = (channel = 'warehouse'))),
  CHECK (fulfilment IS NOT 'in-store' OR shipments IS NULL)
)`],
  ['metals_lots', `CREATE TABLE metals_lots (
  lot_key TEXT NOT NULL PRIMARY KEY CHECK (${key('lot_key', LOT_KEYS)}),
  order_key TEXT NOT NULL REFERENCES metals_orders(order_key),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 499),
  ${CONTENT_COLUMNS}
  amount_minor INTEGER NOT NULL CHECK (${minor('amount_minor', 0)}),
  direct_minor INTEGER NOT NULL CHECK (${minor('direct_minor')}),
  allocated_json TEXT NOT NULL CHECK (${json('allocated_json', 100_000)}),
  cost_minor INTEGER NOT NULL CHECK (${minor('cost_minor')}),
  cost_complete INTEGER NOT NULL CHECK (${bool('cost_complete')}),
  seller TEXT NULL CHECK ${orNull('seller', text('seller', 60))},
  ${CONTENT_CHECKS},
  UNIQUE (order_key, ordinal)
)`],
  ['metals_lot_events', `CREATE TABLE metals_lot_events (
  lot_key TEXT NOT NULL REFERENCES metals_lots(lot_key),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 0 AND 49),
  kind TEXT NOT NULL CHECK (${among('kind', METALS_BUY_EVENT_KINDS)}),
  event_date TEXT NULL CHECK ${orNull('event_date', day('event_date'))},
  date_basis TEXT NULL CHECK ${orNull('date_basis', among('date_basis', METALS_DATE_BASES))},
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 100000),
  occurrence INTEGER NOT NULL CHECK (typeof(occurrence) = 'integer' AND occurrence BETWEEN 1 AND 50),
  PRIMARY KEY (lot_key, seq),
  CHECK ((event_date IS NULL) = (date_basis IS NULL))
)`],
  ['metals_tenders', `CREATE TABLE metals_tenders (
  order_key TEXT NOT NULL REFERENCES metals_orders(order_key),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 0 AND 9),
  kind TEXT NOT NULL CHECK (${among('kind', METALS_TENDER_KINDS)}),
  network TEXT NOT NULL CHECK (${among('network', METALS_NETWORKS)}),
  last4 TEXT NULL CHECK ${orNull('last4', last4('last4'))},
  amount_minor INTEGER NULL CHECK ${orNull('amount_minor', minor('amount_minor'))},
  PRIMARY KEY (order_key, seq),
  CHECK (kind IN ('card', 'card-refund') OR (last4 IS NULL AND network = 'unknown'))
)`],
  ['metals_card_evidence', `CREATE TABLE metals_card_evidence (
  order_key TEXT NOT NULL REFERENCES metals_orders(order_key),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 0 AND 9),
  evidence_class TEXT NOT NULL CHECK (${among('evidence_class', METALS_EVIDENCE_CLASSES)}),
  tender_seq INTEGER NOT NULL CHECK (typeof(tender_seq) = 'integer' AND tender_seq BETWEEN 0 AND 9),
  amount_minor INTEGER NOT NULL CHECK (${minor('amount_minor', 1)}),
  PRIMARY KEY (order_key, seq),
  FOREIGN KEY (order_key, tender_seq) REFERENCES metals_tenders(order_key, seq)
)`],
  ['metals_dispositions', `CREATE TABLE metals_dispositions (
  line_key TEXT NOT NULL PRIMARY KEY CHECK (${key('line_key', SALE_LINE_KEYS)}),
  order_key TEXT NOT NULL REFERENCES metals_orders(order_key),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 499),
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'other')),
  ${CONTENT_COLUMNS}
  gross_minor INTEGER NOT NULL CHECK (${minor('gross_minor', 0)}),
  direct_minor INTEGER NOT NULL CHECK (${minor('direct_minor')}),
  allocated_json TEXT NOT NULL CHECK (${json('allocated_json', 100_000)}),
  platform_fee_minor INTEGER NOT NULL CHECK (${minor('platform_fee_minor', -MAX, 0)}),
  insured_shipping_minor INTEGER NOT NULL CHECK (${minor('insured_shipping_minor', -MAX, 0)}),
  net_minor INTEGER NOT NULL CHECK (${minor('net_minor')}),
  net_complete INTEGER NOT NULL CHECK (${bool('net_complete')}),
  program TEXT NULL CHECK ${orNull('program', text('program', 60))},
  premium_text TEXT NULL CHECK ${orNull('premium_text', text('premium_text', 60))},
  premium_basis TEXT NULL CHECK ${orNull('premium_basis', among('premium_basis', METALS_PREMIUM_BASES))},
  inspection TEXT NULL CHECK ${orNull('inspection', among('inspection', METALS_INSPECTIONS))},
  events_json TEXT NOT NULL CHECK (${json('events_json', 100_000)}),
  ${CONTENT_CHECKS},
  CHECK ((premium_text IS NULL) = (premium_basis IS NULL)),
  UNIQUE (order_key, ordinal)
)`],
  ['metals_payouts', `CREATE TABLE metals_payouts (
  payout_key TEXT NOT NULL PRIMARY KEY CHECK (${key('payout_key', PAYOUT_KEYS)}),
  order_key TEXT NOT NULL REFERENCES metals_orders(order_key),
  method TEXT NOT NULL CHECK (method = 'ach'),
  destination_last4 TEXT NULL CHECK ${orNull('destination_last4', last4('destination_last4'))},
  amount_minor INTEGER NOT NULL CHECK (${minor('amount_minor', 1)}),
  initiated_date TEXT NULL CHECK ${orNull('initiated_date', day('initiated_date'))},
  payout_date TEXT NULL CHECK ${orNull('payout_date', day('payout_date'))},
  status TEXT NOT NULL CHECK (${among('status', METALS_PAYOUT_STATUSES)})
)`],
  ['metals_competitors', `CREATE TABLE metals_competitors (
  order_key TEXT NOT NULL CHECK (${key('order_key', BUY_ORDER_KEYS)}),
  method INTEGER NOT NULL CHECK (typeof(method) = 'integer' AND method BETWEEN 0 AND 9),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 1000000),
  import_id TEXT NOT NULL REFERENCES metals_imports(import_id),
  account_id TEXT NOT NULL REFERENCES metals_accounts(account_id),
  source TEXT NOT NULL CHECK (source IN ('costco', 'walmart') AND ${sourceOf('order_key')}),
  channel TEXT NOT NULL CHECK (${among('channel', METALS_CHANNELS)}),
  order_date TEXT NOT NULL CHECK (${day('order_date')}),
  interval_from TEXT NOT NULL CHECK (${day('interval_from')} AND interval_from = order_date),
  interval_to TEXT NOT NULL CHECK (${day('interval_to')} AND interval_to >= interval_from),
  kind TEXT NOT NULL CHECK (kind IN ('card', 'card-refund')),
  network TEXT NOT NULL CHECK (${among('network', METALS_NETWORKS)}),
  last4 TEXT NULL CHECK ${orNull('last4', last4('last4'))},
  amount_minor INTEGER NULL CHECK ${orNull('amount_minor', minor('amount_minor'))},
  facts_digest TEXT NOT NULL CHECK (${letters('facts_digest')}),
  admission_json TEXT NOT NULL CHECK (${json('admission_json', 100_000)}),
  basis TEXT NOT NULL CHECK (${among('basis', METALS_COMPETITOR_BASES)}),
  cap_minor INTEGER NULL CHECK ${orNull('cap_minor', minor('cap_minor', 0))},
  PRIMARY KEY (order_key, method, seq),
  UNIQUE (order_key, facts_digest, method),
  CHECK (basis = 'aggregate' OR cap_minor IS NULL)
)`],
  ['metals_competitor_observations', `CREATE TABLE metals_competitor_observations (
  import_id TEXT NOT NULL REFERENCES metals_imports(import_id),
  order_key TEXT NOT NULL CHECK (${key('order_key', BUY_ORDER_KEYS)}),
  fact_digest TEXT NOT NULL CHECK (${letters('fact_digest')}),
  PRIMARY KEY (import_id, order_key)
)`],
  ['metals_holds', `CREATE TABLE metals_holds (
  import_id TEXT NOT NULL REFERENCES metals_imports(import_id),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 0 AND 1000000),
  account_id TEXT NOT NULL REFERENCES metals_accounts(account_id),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)}),
  record_key TEXT NULL CHECK ${orNull('record_key', `${key('record_key', ORDER_KEYS)} AND ${sourceOf('record_key')}`)},
  channel TEXT NOT NULL CHECK (${among('channel', METALS_CHANNELS)}),
  record_date TEXT NULL CHECK ${orNull('record_date', day('record_date'))},
  reason TEXT NOT NULL CHECK (${among('reason', METALS_HOLD_REASONS)}),
  check_code TEXT NOT NULL CHECK (${slug('check_code', 48)}),
  PRIMARY KEY (import_id, seq)
)`],
  ['metals_coverage', `CREATE TABLE metals_coverage (
  import_id TEXT NOT NULL REFERENCES metals_imports(import_id),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 0 AND 1000),
  account_id TEXT NOT NULL REFERENCES metals_accounts(account_id),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)}),
  kind TEXT NOT NULL CHECK (${among('kind', METALS_COVERAGE_KINDS)}),
  date_from TEXT NOT NULL CHECK (${day('date_from')}),
  date_to TEXT NOT NULL CHECK (${day('date_to')} AND date_to >= date_from),
  stated INTEGER NULL CHECK ${orNull('stated', count('stated'))},
  seen INTEGER NOT NULL CHECK (${count('seen')}),
  complete INTEGER NOT NULL CHECK (${bool('complete')}),
  PRIMARY KEY (import_id, seq),
  CHECK (complete = (stated IS NOT NULL AND stated = seen))
)`],
  ['metals_bindings', `CREATE TABLE metals_bindings (
  binding_id TEXT NOT NULL PRIMARY KEY CHECK (${id('binding_id', 'mtl-bind-')}),
  kind TEXT NOT NULL CHECK (kind IN ('card', 'checking')),
  source TEXT NOT NULL CHECK (${among('source', METALS_SOURCES)}),
  network TEXT NULL CHECK ${orNull('network', among('network', METALS_NETWORKS))},
  last4 TEXT NOT NULL CHECK (${last4('last4')}),
  account_id TEXT NOT NULL CHECK (typeof(account_id) = 'text' AND length(account_id) BETWEEN 1 AND 64
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*' AND account_id NOT GLOB ${LONG_DIGITS}),
  account_status TEXT NOT NULL CHECK (account_status IN ('active', 'closed')),
  account_owner TEXT NULL CHECK (account_owner IS NULL OR account_owner IN ('alex', 'casey', 'joint')),
  peer_account_ids TEXT NOT NULL CHECK (${json('peer_account_ids', 10_000)} AND json_type(peer_account_ids) = 'array'
    AND json_array_length(peer_account_ids) >= 1),
  proposal_sha256 TEXT NOT NULL CHECK (${letters('proposal_sha256')}),
  inventory_digest TEXT NOT NULL CHECK (${letters('inventory_digest')}),
  approved_go_id TEXT NOT NULL CHECK (${letters('approved_go_id', 32)}),
  approved_purpose TEXT NOT NULL CHECK (${among('approved_purpose', METALS_BINDING_PURPOSES)}),
  approved_at TEXT NOT NULL CHECK (${instant('approved_at')}),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  revoked_go_id TEXT NULL CHECK ${orNull('revoked_go_id', letters('revoked_go_id', 32))},
  revoked_at TEXT NULL CHECK ${orNull('revoked_at', instant('revoked_at'))},
  CHECK ((kind = 'card') = (network IS NOT NULL)),
  CHECK ((kind = 'card') = (account_owner IS NOT NULL)),
  CHECK (kind = 'card' OR (${id('account_id', 'chk-acct-')} AND source = 'collectpure')),
  CHECK ((state = 'revoked') = (revoked_go_id IS NOT NULL)),
  CHECK ((revoked_go_id IS NULL) = (revoked_at IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= approved_at)
)`],
  ['metals_owner_decisions', `CREATE TABLE metals_owner_decisions (
  decision_id TEXT NOT NULL PRIMARY KEY CHECK (${id('decision_id', 'mtl-dec-')}),
  kind TEXT NOT NULL CHECK (${among('kind', METALS_DECISION_KINDS)}),
  scope TEXT NOT NULL CHECK (scope IN ('rule', 'product', 'lot', 'payout')),
  rule_id TEXT NULL CHECK ${orNull('rule_id', `typeof(rule_id) = 'text' AND length(rule_id) BETWEEN 1 AND 64 AND substr(rule_id, 1, 1) GLOB '[a-z]' `
    + `AND rule_id NOT GLOB '*[^a-z0-9@.-]*' AND rule_id NOT GLOB ${LONG_DIGITS}`)},
  product_ref TEXT NULL CHECK ${orNull('product_ref', productRef('product_ref'))},
  fingerprint TEXT NULL CHECK ${orNull('fingerprint', letters('fingerprint'))},
  lot_key TEXT NULL CHECK ${orNull('lot_key', key('lot_key', [...LOT_KEYS, ...SALE_LINE_KEYS]))},
  evidence_digest TEXT NULL CHECK ${orNull('evidence_digest', letters('evidence_digest'))},
  payout_key TEXT NULL CHECK ${orNull('payout_key', key('payout_key', PAYOUT_KEYS))},
  checking_row_id TEXT NULL CHECK ${orNull('checking_row_id', id('checking_row_id', 'chk-txn-'))},
  metal TEXT NULL CHECK ${orNull('metal', among('metal', METALS))},
  troy_oz_per_unit TEXT NULL CHECK ${orNull('troy_oz_per_unit', rational('troy_oz_per_unit'))},
  value_json TEXT NULL CHECK ${orNull('value_json', json('value_json', 100_000))},
  answer TEXT NULL CHECK ${orNull('answer', among('answer', METALS_BULLION_ANSWERS))},
  preview_digest TEXT NOT NULL CHECK (${letters('preview_digest')}),
  decided_at TEXT NOT NULL CHECK (${instant('decided_at')}),
  decided_by TEXT NOT NULL CHECK (${actor('decided_by')}),
  revoked_at TEXT NULL CHECK ${orNull('revoked_at', instant('revoked_at'))},
  revoked_by TEXT NULL CHECK ${orNull('revoked_by', actor('revoked_by'))},
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= decided_at),
  CHECK ((scope = 'product') = (product_ref IS NOT NULL AND fingerprint IS NOT NULL)),
  CHECK (scope = 'product' OR (product_ref IS NULL AND fingerprint IS NULL)),
  CHECK ((scope = 'lot') = (lot_key IS NOT NULL)),
  CHECK (scope = 'lot' OR (lot_key IS NULL AND evidence_digest IS NULL)),
  CHECK ((scope = 'rule') = (rule_id IS NOT NULL)),
  CHECK ((scope = 'payout') = (payout_key IS NOT NULL AND checking_row_id IS NOT NULL)),
  CHECK (scope = 'payout' OR (payout_key IS NULL AND checking_row_id IS NULL)),
  CHECK ((kind = 'product-content') = (troy_oz_per_unit IS NOT NULL)),
  CHECK (kind = 'product-content' OR metal IS NULL),
  CHECK ((kind = 'product-content' AND scope IN ('product', 'lot')) OR (kind = 'storage' AND scope = 'lot')
    OR (kind = 'spending-rule' AND scope = 'rule') OR (kind = 'deposit-link' AND scope = 'payout')
    OR (kind = 'bullion' AND scope IN ('product', 'lot'))),
  CHECK (kind NOT IN ('product-content', 'bullion') OR scope <> 'lot' OR evidence_digest IS NOT NULL),
  CHECK (kind <> 'storage' OR (evidence_digest IS NULL AND value_json IS NOT NULL)),
  CHECK ((kind = 'bullion') = (answer IS NOT NULL)),
  CHECK (kind <> 'bullion' OR value_json IS NULL)
)`],
];

/**
 * A declared table's columns, in order, read from its CREATE TABLE text: each column definition's line starts with its
 * name and type, at the table's indent (the completeness test holds this list to the installed table).
 */
export function metalsColumnsOf(table: string): string[] {
  const sql = TABLES.find(([name]) => name === table)?.[1];
  if (sql === undefined) throw new Error(`no declared metals table ${table}`);
  return [...sql.matchAll(/^ {2}([a-z][a-z0-9_]*) (?:TEXT|INTEGER)\b/gm)].map((match) => match[1]);
}

/** A unique key of a protected table: its columns, and for a partial unique index, its name and its predicate over a row. */
export interface MetalsUniqueKey {
  readonly columns: readonly string[];
  readonly index?: { readonly name: string; readonly where: (column: (name: string) => string) => string };
}

/**
 * A table whose rows a no-update, one-way or no-delete trigger protects (corrections r6 §2.7, §4). Its BEFORE INSERT
 * guards refuse a row that conflicts with any unique key, the rowid included, so INSERT OR REPLACE can never delete a
 * protected row, whatever `recursive_triggers` and `foreign_keys` are; and a row born past a one-way transition. An
 * AFTER INSERT guard keeps its rowid positive. Its partial unique indexes are generated from the same declaration.
 */
export interface MetalsProtectedTable {
  readonly table: string;
  readonly keys: readonly MetalsUniqueKey[];
  /** The one-way columns: NULL when a row is inserted. */
  readonly unset: readonly string[];
  /** A further birth state, over NEW, refused at insert. */
  readonly bornPast?: string;
}

const bare = (name: string) => name;
const fromNew = (name: string) => `NEW.${name}`;
const liveDecision = (scope: string) => (column: (name: string) => string) => `${column('scope')} = '${scope}' AND ${column('revoked_at')} IS NULL`;
const VOID_FIELDS = ['voided_by_go', 'voided_at', 'void_reason', 'voided_under_marker', 'voided_under_reason'] as const;
const VOID_AUTHORIZATIONS = ['retire_account_id', 'voided_for_import'] as const;
const VERSION_MOVES = ['state', 'resolution', 'resolved_by_go', 'resolved_at', 'chosen_by_go', 'chosen_at', 'chosen_seq'] as const;

export const METALS_PROTECTED: readonly MetalsProtectedTable[] = Object.freeze([
  {
    table: 'metals_accounts', unset: ['retired_by_import'],
    keys: [{ columns: ['account_id'] },
      { columns: ['source', 'folder'], index: { name: 'metals_accounts_live_folder', where: (column) => `${column('retired_by_import')} IS NULL` } }],
  },
  {
    table: 'metals_imports', unset: [...VOID_FIELDS, ...VOID_AUTHORIZATIONS],
    keys: [{ columns: ['import_id'] }, { columns: ['import_seq'] },
      { columns: ['payload_sha256'], index: { name: 'metals_imports_live_payload', where: (column) => `${column('voided_by_go')} IS NULL` } }],
  },
  {
    table: 'metals_order_versions', unset: VERSION_MOVES.filter((column) => column !== 'state'), bornPast: "NEW.state = 'superseded'",
    keys: [{ columns: ['order_key', 'version'] },
      { columns: ['order_key'], index: { name: 'metals_order_versions_one_active', where: (column) => `${column('state')} = 'active'` } }],
  },
  { table: 'metals_observations', unset: [], keys: [{ columns: ['import_id', 'account_id', 'order_key'] }] },
  { table: 'metals_competitor_observations', unset: [], keys: [{ columns: ['import_id', 'order_key'] }] },
  {
    table: 'metals_owner_decisions', unset: ['revoked_at', 'revoked_by'],
    keys: [{ columns: ['decision_id'] },
      { columns: ['kind', 'product_ref', 'fingerprint'], index: { name: 'metals_owner_decisions_live_product', where: liveDecision('product') } },
      { columns: ['kind', 'lot_key'], index: { name: 'metals_owner_decisions_live_lot', where: liveDecision('lot') } },
      { columns: ['kind', 'rule_id'], index: { name: 'metals_owner_decisions_live_rule', where: liveDecision('rule') } },
      { columns: ['kind', 'payout_key'], index: { name: 'metals_owner_decisions_live_payout', where: liveDecision('payout') } },
      { columns: ['kind', 'checking_row_id'], index: { name: 'metals_owner_decisions_live_deposit', where: liveDecision('payout') } }],
  },
]);

const PARTIAL_INDEXES: ReadonlyArray<readonly [string, string]> = METALS_PROTECTED.flatMap(({ table, keys }) => keys.flatMap(({ columns, index }) =>
  (index ? [[index.name, `CREATE UNIQUE INDEX ${index.name} ON ${table} (${columns.join(', ')}) WHERE ${index.where(bare)}`] as const] : [])));

/** A stored row that the new row would conflict with on this key: the key's columns equal (NULL never is), under its predicate. */
const keyConflict = (table: string, { columns, index }: MetalsUniqueKey) => {
  const stored = `EXISTS (SELECT 1 FROM ${table} WHERE ${columns.map((column) => `${column} = NEW.${column}`).join(' AND ')}`
    + `${index ? ` AND ${index.where(bare)}` : ''})`;
  return index ? `(${index.where(fromNew)} AND ${stored})` : stored;
};

/**
 * The generated guards of every protected table (corrections r6 §2.7). The rowid rule: a writer gives each row an explicit
 * rowid (one more than the table's highest, read inside its fence), so a conflicting NEW.rowid is refused before the
 * insert; a row inserted without one gets a fresh rowid, which can't conflict; and after the insert, where NEW.rowid is
 * the stored rowid, anything below 1 is refused.
 */
const GUARDS: ReadonlyArray<readonly [string, string]> = METALS_PROTECTED.flatMap(({ table, keys, unset, bornPast }) => {
  const what = table.replace(/_/g, ' ');
  const born = [...unset.map((column) => `NEW.${column} IS NOT NULL`), ...(bornPast ? [bornPast] : [])];
  return [
    [`${table}_insert_keys`, `CREATE TRIGGER ${table}_insert_keys BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE rowid = NEW.rowid)
  OR ${keys.map((key) => keyConflict(table, key)).join('\n  OR ')}
BEGIN SELECT RAISE(ABORT, 'a new ${what} row would replace a stored one'); END`] as const,
    [`${table}_rowid_domain`, `CREATE TRIGGER ${table}_rowid_domain AFTER INSERT ON ${table} WHEN NEW.rowid < 1
BEGIN SELECT RAISE(ABORT, 'a ${what} rowid is positive'); END`] as const,
    ...(born.length === 0 ? [] : [[`${table}_insert_unset`, `CREATE TRIGGER ${table}_insert_unset BEFORE INSERT ON ${table}
WHEN ${born.join(' OR ')}
BEGIN SELECT RAISE(ABORT, 'a new ${what} row starts before its one-way changes'); END`] as const]),
  ];
});

/**
 * The birth-state guards (corrections r6 §2.5, §2.7): each judges a row by transitions that happen after its insertion,
 * so a future upgrade's preservation copy creates them only after copying the history unchanged (upgrade design §3.4).
 */
export const METALS_BIRTH_STATE_TRIGGERS: readonly string[] = Object.freeze([
  ...GUARDS.map(([name]) => name).filter((name) => name.endsWith('_insert_unset')),
  'metals_imports_payload_admission',
]);

/** Every column but `moving`, and the rowid, unchanged under the null-safe IS: generated from the table's column list. */
const unchangedExcept = (table: string, moving: readonly string[]) => ['rowid', ...metalsColumnsOf(table).filter((column) => !moving.includes(column))]
  .map((column) => `NEW.${column} IS OLD.${column}`).join('\n    AND ');

const INDEXES: ReadonlyArray<readonly [string, string]> = [
  ...PARTIAL_INDEXES,
  ['metals_order_versions_by_import', 'CREATE INDEX metals_order_versions_by_import ON metals_order_versions (created_by_import)'],
  ['metals_lot_events_occurrence',
    `CREATE UNIQUE INDEX metals_lot_events_occurrence ON metals_lot_events (lot_key, kind, coalesce(event_date, ''), quantity, occurrence)`],
  ['metals_bindings_one_active',
    `CREATE UNIQUE INDEX metals_bindings_one_active ON metals_bindings (kind, source, coalesce(network, ''), last4) WHERE state = 'active'`],
  ['metals_observations_by_version', 'CREATE INDEX metals_observations_by_version ON metals_observations (order_key, version)'],
  ['metals_competitor_observations_by_order', 'CREATE INDEX metals_competitor_observations_by_order ON metals_competitor_observations (order_key)'],
];

/**
 * The free-text guard for text nested in a canonical aggregate: no string in it holds a run of 13 or more digits,
 * except a computed fine-content rational (`troyOz`). The column itself carries no digit guard, because those
 * rationals can be long; this trigger keeps every free-text field inside it (titles, product refs, seller names, a
 * sale's program and premium text) guarded as a free-text column is.
 */
export const METALS_NESTED_TEXT_GUARD = `json_tree(NEW.canonical_json) WHERE type = 'text' AND atom GLOB ${LONG_DIGITS} AND key IS NOT 'troyOz'`;

const refuseChange = (what: string) => `BEGIN SELECT RAISE(ABORT, '${what} are append-only'); END`;
const TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  // The flag (corrections r6 §2.6): the one update an import admits is its void, every void field from unset to set
  // at once, the retirement and collateral authorizations only in that same update, and nothing else changed.
  ['metals_imports_void', `CREATE TRIGGER metals_imports_void BEFORE UPDATE ON metals_imports
WHEN NOT (${[...VOID_FIELDS, ...VOID_AUTHORIZATIONS].map((column) => `OLD.${column} IS NULL`).join(' AND ')}
  AND ${VOID_FIELDS.map((column) => `NEW.${column} IS NOT NULL`).join(' AND ')}
  AND ${unchangedExcept('metals_imports', [...VOID_FIELDS, ...VOID_AUTHORIZATIONS])})
BEGIN SELECT RAISE(ABORT, 'a metals import changes only by its one void'); END`],
  ['metals_imports_no_delete', `CREATE TRIGGER metals_imports_no_delete BEFORE DELETE ON metals_imports ${refuseChange('metals imports')}`],
  // The admission rule (corrections r6 §2.5): bytes an earlier import carried return only as the correction of a
  // collateral void of the same, non-retired account; otherwise they are barred for good.
  ['metals_imports_payload_admission', `CREATE TRIGGER metals_imports_payload_admission BEFORE INSERT ON metals_imports
WHEN EXISTS (SELECT 1 FROM metals_imports WHERE payload_sha256 = NEW.payload_sha256)
  AND NOT (NOT EXISTS (SELECT 1 FROM metals_imports WHERE payload_sha256 = NEW.payload_sha256
      AND NOT (voided_by_go IS NOT NULL AND voided_for_import IS NOT NULL AND account_id = NEW.account_id))
    AND NOT EXISTS (SELECT 1 FROM metals_accounts WHERE account_id = NEW.account_id AND retired_by_import IS NOT NULL)
    AND EXISTS (SELECT 1 FROM metals_imports WHERE payload_sha256 = NEW.payload_sha256 AND import_id = NEW.corrects_import))
BEGIN SELECT RAISE(ABORT, 'metals-payload-barred'); END`],
  // The retirement (corrections r6 §2.7): the one update an account admits, to an import whose void named it.
  ['metals_accounts_retire', `CREATE TRIGGER metals_accounts_retire BEFORE UPDATE ON metals_accounts
WHEN NOT (OLD.retired_by_import IS NULL AND NEW.retired_by_import IS NOT NULL
  AND EXISTS (SELECT 1 FROM metals_imports WHERE import_id = NEW.retired_by_import AND retire_account_id = OLD.account_id)
  AND ${unchangedExcept('metals_accounts', ['retired_by_import'])})
BEGIN SELECT RAISE(ABORT, 'a metals account changes only by its one retirement'); END`],
  ['metals_accounts_no_delete', `CREATE TRIGGER metals_accounts_no_delete BEFORE DELETE ON metals_accounts ${refuseChange('metals accounts')}`],
  ['metals_order_versions_free_text', `CREATE TRIGGER metals_order_versions_free_text BEFORE INSERT ON metals_order_versions
WHEN EXISTS (SELECT 1 FROM ${METALS_NESTED_TEXT_GUARD})
BEGIN SELECT RAISE(ABORT, 'metals order version text holds a long digit run'); END`],
  ['metals_order_versions_facts_fixed', `CREATE TRIGGER metals_order_versions_facts_fixed
BEFORE UPDATE OF ${metalsColumnsOf('metals_order_versions').filter((column) => !(VERSION_MOVES as readonly string[]).includes(column)).join(', ')}
ON metals_order_versions
${refuseChange('metals order versions')}`],
  ['metals_order_versions_choice_fixed', `CREATE TRIGGER metals_order_versions_choice_fixed
BEFORE UPDATE OF chosen_by_go, chosen_at, chosen_seq ON metals_order_versions WHEN OLD.chosen_by_go IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a metals order version keeps the GO that chose it'); END`],
  ['metals_order_versions_states', `CREATE TRIGGER metals_order_versions_states
BEFORE UPDATE OF ${VERSION_MOVES.join(', ')} ON metals_order_versions
WHEN OLD.state = 'superseded' OR (OLD.state = 'active' AND NEW.state <> 'superseded')
  OR (OLD.state IN ('proposed', 'conflict') AND NEW.state NOT IN ('active', 'superseded'))
BEGIN SELECT RAISE(ABORT, 'metals order version state change refused'); END`],
  ['metals_order_versions_no_delete', `CREATE TRIGGER metals_order_versions_no_delete BEFORE DELETE ON metals_order_versions
${refuseChange('metals order versions')}`],
  ['metals_observations_no_update', `CREATE TRIGGER metals_observations_no_update BEFORE UPDATE ON metals_observations
${refuseChange('metals observations')}`],
  ['metals_observations_no_delete', `CREATE TRIGGER metals_observations_no_delete BEFORE DELETE ON metals_observations
${refuseChange('metals observations')}`],
  ['metals_competitor_observations_known', `CREATE TRIGGER metals_competitor_observations_known BEFORE INSERT ON metals_competitor_observations
WHEN NOT EXISTS (SELECT 1 FROM metals_competitors WHERE order_key = NEW.order_key AND facts_digest = NEW.fact_digest)
BEGIN SELECT RAISE(ABORT, 'a metals competitor observation must name a stored fact-version'); END`],
  ['metals_competitor_observations_no_update', `CREATE TRIGGER metals_competitor_observations_no_update BEFORE UPDATE ON metals_competitor_observations
${refuseChange('metals competitor observations')}`],
  ['metals_competitor_observations_no_delete', `CREATE TRIGGER metals_competitor_observations_no_delete BEFORE DELETE ON metals_competitor_observations
${refuseChange('metals competitor observations')}`],
  // The revoke (the owner-decision void, ROOT): the one update a decision admits, and no delete.
  ['metals_owner_decisions_revoke', `CREATE TRIGGER metals_owner_decisions_revoke BEFORE UPDATE ON metals_owner_decisions
WHEN NOT (OLD.revoked_at IS NULL AND OLD.revoked_by IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL
  AND ${unchangedExcept('metals_owner_decisions', ['revoked_at', 'revoked_by'])})
BEGIN SELECT RAISE(ABORT, 'a metals owner decision changes only by its one revoke'); END`],
  ['metals_owner_decisions_no_delete', `CREATE TRIGGER metals_owner_decisions_no_delete BEFORE DELETE ON metals_owner_decisions
${refuseChange('metals owner decisions')}`],
  ...GUARDS,
];

/** The declared schema, statement by statement: the tables, then their indexes, then their triggers. */
export const METALS_SCHEMA_SQL: readonly string[] = Object.freeze([...TABLES, ...INDEXES, ...TRIGGERS].map(([, sql]) => sql));
/** The tables, in creation order. */
export const METALS_TABLES: readonly string[] = Object.freeze(TABLES.map(([name]) => name));

/**
 * A statement's comparable text (review P299-2): whitespace between tokens folded, quoted text kept exactly. The shared
 * normalization (services/schemaShape.ts), under the name metals had before it moved there (Costco PR 2a).
 */
export const normalizeMetalsSql: (sql: string) => string = normalizeSchemaSql;

/** The digest of a statement list, each statement in its comparable text. */
export const metalsSqlDigest: (statements: readonly string[]) => string = schemaSqlDigest;
export const METALS_SCHEMA_DIGEST = metalsSqlDigest(METALS_SCHEMA_SQL);

/** The declared schema the shared comparison reads: every object is named `metals_…` or is on a `metals_` table. */
const METALS_SCHEMA: DeclaredSchema = Object.freeze({ prefix: 'metals_', statements: METALS_SCHEMA_SQL });

export type MetalsSchemaState = SchemaState;

/** How the database's `metals_` objects compare to the declared schema, as counts. */
export type MetalsSchemaObjects = SchemaObjectCounts;

/** Every object named `metals_…` or on a `metals_` table, in any letter case, compared with the declared schema. */
export function metalsSchemaObjects(db: Database.Database): MetalsSchemaObjects {
  return schemaObjects(db, METALS_SCHEMA, 'read metals schema');
}

/**
 * Read-only: `present` only for exactly this build's tables, indexes and triggers; `absent` when nothing is named
 * `metals_…` and nothing is on such a table; `conflict` for anything else (another shape, a missing or extra object, a
 * view or trigger of such a name, a name in other letter case).
 */
export function metalsSchemaState(db: Database.Database): MetalsSchemaState {
  return schemaState(metalsSchemaObjects(db));
}

export const METALS_REFUSALS = Object.freeze({
  conflict: 'metals tables already exist in another shape; nothing was installed',
  unverified: 'metals tables did not install as expected; nothing was installed',
});
/** The tables in another shape: the API's fixed 409; nothing is read until the operator resolves it. */
export const METALS_CONFLICT = 'the metals ledger on this Holdr is not in the shape this build expects; nothing is read until the operator resolves it';

/**
 * Refuses a write before the operator installed the tables (`metals-not-installed`), or while something else holds
 * their names or they are in another shape (`metals-conflict`): before any backup, since every writer plans first.
 */
export function requireMetalsSchema(db: Database.Database): void {
  const state = metalsSchemaState(db);
  if (state === 'conflict') throw new MetalsRefusal('metals-conflict');
  if (state !== 'present') throw new MetalsRefusal('metals-not-installed');
}

/**
 * Only the operator command (and tests or seeds through it) calls this, inside its backed-up IMMEDIATE transaction
 * (called alone, it runs in one of its own): nothing when the tables are there, a refusal for a conflict, else every
 * table, index and trigger, verified before commit.
 */
export function installMetalsSchema(db: Database.Database): void {
  try {
    db.transaction(() => {
      const state = metalsSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal(METALS_REFUSALS.conflict);
      for (const sql of METALS_SCHEMA_SQL) db.exec(sql);
      if (metalsSchemaState(db) !== 'present') throw new HoldrRefusal(METALS_REFUSALS.unverified);
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('install metals schema', error);
  }
}
