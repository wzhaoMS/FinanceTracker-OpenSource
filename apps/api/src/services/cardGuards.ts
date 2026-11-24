import { CARD_TEXT_FORBIDDEN_RANGES, LONG_DIGIT_RUN } from '@finance-tracker/shared';

/**
 * This build's card guard policy as data: the card tables, the columns and id
 * formats its schema defines, the checks the guard triggers run on every
 * column, and the exact messages those triggers raise. The repository builds
 * the triggers from it (sqliteStateRepo.ts), and the value-free error
 * boundary (dbErrors.ts) recognises their messages by it, without either
 * module importing the other.
 */

/**
 * Every card table: v13's three, then the 28 that card-sync schema v15 adds
 * (E1b design §3.5), in the order its migration creates them. Each is
 * guarded like v13's: every column, on INSERT and UPDATE.
 */
export const CARD_TABLES = [
  'card_accounts', 'card_import_batches', 'card_transactions',
  'card_sync_sources', 'card_sync_namespaces', 'card_scopes', 'card_source_bindings', 'card_source_binding_scopes',
  'card_sync_policy', 'card_sync_issuer_policy', 'card_sync_pairings', 'card_sync_pairing_scopes', 'card_sync_devices',
  'card_sync_device_scopes', 'card_sync_runs', 'card_sync_observation_sets', 'card_sync_set_card_hints',
  'card_source_observations', 'card_observation_secondary_ids', 'card_sync_payload_receipts', 'card_transaction_versions',
  'card_source_identities', 'card_identity_contents', 'card_transaction_events', 'card_reconciliation_suggestions',
  'card_reconciliation_candidates', 'card_coverage_windows', 'card_sync_commit_plans', 'card_sync_plan_actions',
  'card_sync_audit_events', 'card_payment_links',
] as const;
export type CardTable = (typeof CARD_TABLES)[number];
export type GuardColumnType = 'TEXT' | 'INTEGER';
export type GuardColumn = { name: string; type: GuardColumnType };

/** Matches no id: a table without an `id` column names a failing row by its ordinal. */
const NO_ID = /(?!)/;

/**
 * This build's card schema: the columns CARD_SCHEMA_SQL (v13),
 * CARD_REPORTS_SCHEMA_SQL (v14) and the card-sync migration (v15) create,
 * with their types, and the format of the ids Holdr generates for each table
 * (newCardId, newCardSyncId, newCardSyncRowId; the policy's and the issuer
 * policies' fixed ids). Error messages name a column only if it is listed
 * here and a row only by an id of its table's format, so nothing an outside
 * tool or another build stored, not even a column name, can reach a message.
 * Tests keep it equal to the schema and to the id generators.
 */
export const CARD_SCHEMA: Readonly<Record<CardTable, {
  columns: ReadonlyMap<string, GuardColumnType>;
  generatedId: RegExp;
}>> = {
  card_accounts: {
    columns: new Map([
      ['id', 'TEXT'], ['issuer', 'TEXT'], ['owner', 'TEXT'], ['nickname', 'TEXT'], ['last4', 'TEXT'],
      ['currency', 'TEXT'], ['status', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'], ['last5', 'TEXT'],
      ['ledger_revision', 'INTEGER'],
    ]),
    generatedId: /^card-acct-[a-p]{32}$/,
  },
  card_import_batches: {
    columns: new Map([
      ['id', 'TEXT'], ['card_account_id', 'TEXT'], ['source', 'TEXT'], ['parser_version', 'TEXT'],
      ['row_count', 'INTEGER'], ['new_count', 'INTEGER'], ['duplicate_count', 'INTEGER'],
      ['rejected_count', 'INTEGER'], ['imported_at', 'TEXT'], ['coverage_start', 'TEXT'], ['coverage_end', 'TEXT'],
    ]),
    generatedId: /^card-import-[a-p]{32}$/,
  },
  card_transactions: {
    columns: new Map([
      ['id', 'TEXT'], ['card_account_id', 'TEXT'], ['source', 'TEXT'], ['external_id_hash', 'TEXT'],
      ['fingerprint', 'TEXT'], ['transaction_date', 'TEXT'], ['posted_date', 'TEXT'], ['status', 'TEXT'],
      ['amount_minor', 'INTEGER'], ['currency', 'TEXT'], ['original_amount_minor', 'INTEGER'],
      ['original_currency', 'TEXT'], ['kind', 'TEXT'], ['description', 'TEXT'], ['merchant', 'TEXT'],
      ['issuer_category', 'TEXT'], ['user_category', 'TEXT'], ['notes', 'TEXT'], ['import_batch_id', 'TEXT'],
      ['created_at', 'TEXT'], ['updated_at', 'TEXT'], ['dismissed_at', 'TEXT'],
      ['card_scope_id', 'TEXT'], ['revision', 'INTEGER'], ['first_sync_run_id', 'TEXT'], ['removed_reason', 'TEXT'],
      ['removed_from_status', 'TEXT'], ['removed_at', 'TEXT'], ['merged_into_id', 'TEXT'], ['reversal_snapshot_revision', 'INTEGER'],
    ]),
    generatedId: /^card-txn-[a-p]{32}$/,
  },
  card_sync_sources: {
    columns: new Map([
      ['source', 'TEXT'], ['issuer', 'TEXT'], ['mode', 'TEXT'], ['contract_version', 'INTEGER'],
    ]),
    generatedId: NO_ID,
  },
  card_sync_namespaces: {
    columns: new Map([
      ['namespace', 'TEXT'], ['kind', 'TEXT'], ['source', 'TEXT'], ['contract_version', 'INTEGER'],
    ]),
    generatedId: NO_ID,
  },
  card_scopes: {
    columns: new Map([
      ['id', 'TEXT'], ['card_account_id', 'TEXT'], ['kind', 'TEXT'], ['holder_alias', 'TEXT'], ['last4', 'TEXT'],
      ['label', 'TEXT'], ['status', 'TEXT'], ['version', 'INTEGER'], ['confirmed_by_ref', 'TEXT'], ['confirmed_at', 'TEXT'],
      ['retired_at', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
    ]),
    generatedId: /^scp_[a-p]{32}$/,
  },
  card_source_bindings: {
    columns: new Map([
      ['id', 'TEXT'], ['card_account_id', 'TEXT'], ['issuer', 'TEXT'], ['currency', 'TEXT'], ['source', 'TEXT'],
      ['source_account_digest', 'TEXT'], ['label', 'TEXT'], ['status', 'TEXT'], ['status_reason', 'TEXT'],
      ['version', 'INTEGER'], ['auto_sync_revision', 'INTEGER'], ['confirmed_by_ref', 'TEXT'], ['confirmed_at', 'TEXT'],
      ['retired_at', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
    ]),
    generatedId: /^bnd_[a-p]{32}$/,
  },
  card_source_binding_scopes: {
    columns: new Map([
      ['id', 'TEXT'], ['binding_id', 'TEXT'], ['card_scope_id', 'TEXT'], ['card_account_id', 'TEXT'],
      ['card_scope_kind', 'TEXT'], ['binding_version', 'INTEGER'], ['status', 'TEXT'], ['created_at', 'TEXT'],
      ['revoked_at', 'TEXT'],
    ]),
    generatedId: /^card-bscope-[a-p]{32}$/,
  },
  card_sync_policy: {
    columns: new Map([
      ['id', 'TEXT'], ['revision', 'INTEGER'], ['paused', 'INTEGER'], ['paused_at', 'TEXT'],
      ['authorization_generation', 'TEXT'], ['generation_changed_at', 'TEXT'], ['recovery_completed_at', 'TEXT'],
      ['review_retention_days', 'INTEGER'], ['receipt_retention_days', 'INTEGER'], ['max_runs_per_device_day', 'INTEGER'],
      ['quota_account_sets', 'INTEGER'], ['quota_account_rows', 'INTEGER'], ['quota_account_bytes', 'INTEGER'],
      ['quota_device_sets', 'INTEGER'], ['quota_device_rows', 'INTEGER'], ['quota_device_bytes', 'INTEGER'],
      ['quota_global_sets', 'INTEGER'], ['quota_global_rows', 'INTEGER'], ['quota_global_bytes', 'INTEGER'],
      ['updated_by_ref', 'TEXT'], ['updated_at', 'TEXT'],
    ]),
    generatedId: /^card-sync-policy$/,
  },
  card_sync_issuer_policy: {
    columns: new Map([
      ['id', 'TEXT'], ['enabled', 'INTEGER'], ['enabled_at', 'TEXT'], ['approved_contract_version', 'INTEGER'],
      ['risk_acknowledged_at', 'TEXT'], ['main_passive_accepted', 'INTEGER'], ['revision', 'INTEGER'],
      ['updated_by_ref', 'TEXT'], ['updated_at', 'TEXT'],
    ]),
    generatedId: /^(?:amex|chase|citi|wellsfargo)$/,
  },
  card_sync_pairings: {
    columns: new Map([
      ['id', 'TEXT'], ['code_digest', 'TEXT'], ['status', 'TEXT'], ['replaces_device_id', 'TEXT'],
      ['created_by_ref', 'TEXT'], ['created_at', 'TEXT'], ['expires_at', 'TEXT'], ['failed_attempts', 'INTEGER'],
      ['authorization_generation', 'TEXT'], ['redeemed_at', 'TEXT'], ['closed_at', 'TEXT'],
    ]),
    generatedId: /^pai_[a-p]{32}$/,
  },
  card_sync_pairing_scopes: {
    columns: new Map([
      ['id', 'TEXT'], ['pairing_id', 'TEXT'], ['binding_id', 'TEXT'], ['binding_version', 'INTEGER'], ['mode', 'TEXT'],
      ['contract_version', 'INTEGER'],
    ]),
    generatedId: /^card-pscope-[a-p]{32}$/,
  },
  card_sync_devices: {
    columns: new Map([
      ['id', 'TEXT'], ['pairing_id', 'TEXT'], ['token_digest', 'TEXT'], ['fingerprint', 'TEXT'], ['label', 'TEXT'],
      ['client_version', 'TEXT'], ['owner_ref', 'TEXT'], ['status', 'TEXT'], ['created_at', 'TEXT'],
      ['pending_expires_at', 'TEXT'], ['activated_at', 'TEXT'], ['activated_by_ref', 'TEXT'], ['expires_at', 'TEXT'],
      ['closed_at', 'TEXT'], ['close_reason', 'TEXT'], ['authorization_generation', 'TEXT'], ['last_used_at', 'TEXT'],
    ]),
    generatedId: /^dev_[a-p]{32}$/,
  },
  card_sync_device_scopes: {
    columns: new Map([
      ['id', 'TEXT'], ['device_id', 'TEXT'], ['binding_id', 'TEXT'], ['binding_version', 'INTEGER'], ['mode', 'TEXT'],
      ['contract_version', 'INTEGER'], ['status', 'TEXT'], ['granted_by_ref', 'TEXT'], ['granted_at', 'TEXT'],
      ['revoked_at', 'TEXT'], ['auto_sync', 'INTEGER'], ['consent_contract_version', 'INTEGER'],
      ['consent_guard_revision', 'INTEGER'], ['consent_issuer_revision', 'INTEGER'], ['consent_binding_version', 'INTEGER'],
      ['consent_by_ref', 'TEXT'], ['consent_at', 'TEXT'],
    ]),
    generatedId: /^card-dscope-[a-p]{32}$/,
  },
  card_sync_runs: {
    columns: new Map([
      ['id', 'TEXT'], ['device_id', 'TEXT'], ['client_run_id', 'TEXT'], ['binding_id', 'TEXT'], ['card_account_id', 'TEXT'],
      ['binding_version', 'INTEGER'], ['adapter_version', 'TEXT'], ['contract_version', 'INTEGER'], ['run_trigger', 'TEXT'],
      ['authorization_generation', 'TEXT'], ['created_at', 'TEXT'], ['upload_expires_at', 'TEXT'],
      ['acceptance_state', 'TEXT'], ['payload_digest', 'TEXT'], ['refusal_code', 'TEXT'], ['accepted_at', 'TEXT'],
      ['closed_at', 'TEXT'], ['aborted_at', 'TEXT'], ['abort_reason', 'TEXT'],
    ]),
    generatedId: /^run_[a-p]{32}$/,
  },
  card_sync_observation_sets: {
    columns: new Map([
      ['id', 'TEXT'], ['origin', 'TEXT'], ['card_account_id', 'TEXT'], ['issuer', 'TEXT'], ['currency', 'TEXT'],
      ['run_id', 'TEXT'], ['device_id', 'TEXT'], ['binding_id', 'TEXT'], ['binding_version', 'INTEGER'],
      ['capture_id', 'TEXT'], ['payload_digest', 'TEXT'], ['contract_version', 'INTEGER'], ['mode', 'TEXT'],
      ['observed_at', 'TEXT'], ['owner', 'TEXT'], ['import_batch_id', 'TEXT'], ['file_chunk', 'INTEGER'],
      ['source', 'TEXT'], ['parser_version', 'TEXT'], ['authorization_generation', 'TEXT'], ['guard_revision', 'INTEGER'],
      ['accepted_at', 'TEXT'], ['expires_at', 'TEXT'], ['state', 'TEXT'], ['version', 'INTEGER'],
      ['review_ledger_revision', 'INTEGER'], ['row_count', 'INTEGER'], ['byte_count', 'INTEGER'],
      ['producer_rejected_count', 'INTEGER'], ['statement_present', 'INTEGER'], ['statement_charges_minor', 'INTEGER'],
      ['statement_credits_minor', 'INTEGER'], ['statement_net_minor', 'INTEGER'],
      ['statement_previous_balance_minor', 'INTEGER'], ['statement_new_balance_minor', 'INTEGER'],
      ['open_count', 'INTEGER'], ['inserted_count', 'INTEGER'], ['updated_count', 'INTEGER'], ['matched_count', 'INTEGER'],
      ['attributed_count', 'INTEGER'], ['unchanged_count', 'INTEGER'], ['rejected_count', 'INTEGER'],
      ['expired_count', 'INTEGER'], ['receipt_state', 'TEXT'], ['closed_at', 'TEXT'], ['close_reason', 'TEXT'],
      ['discard_reason', 'TEXT'], ['closed_by_ref', 'TEXT'], ['content_purged_at', 'TEXT'],
    ]),
    generatedId: /^obs_[a-p]{32}$/,
  },
  card_sync_set_card_hints: {
    columns: new Map([
      ['observation_set_id', 'TEXT'], ['origin', 'TEXT'], ['ordinal', 'INTEGER'], ['last4', 'TEXT'],
    ]),
    generatedId: NO_ID,
  },
  card_source_observations: {
    columns: new Map([
      ['id', 'TEXT'], ['observation_set_id', 'TEXT'], ['origin', 'TEXT'], ['card_account_id', 'TEXT'],
      ['ordinal', 'INTEGER'], ['file_row_index', 'INTEGER'], ['source_scope_id', 'TEXT'], ['source_scope_kind', 'TEXT'],
      ['identity_namespace', 'TEXT'], ['namespace_kind', 'TEXT'], ['external_id_hash', 'TEXT'], ['fingerprint', 'TEXT'],
      ['identity_hash', 'TEXT'], ['transaction_date', 'TEXT'], ['posted_date', 'TEXT'], ['status', 'TEXT'],
      ['amount_minor', 'INTEGER'], ['currency', 'TEXT'], ['original_amount_minor', 'INTEGER'],
      ['original_currency', 'TEXT'], ['kind', 'TEXT'], ['description', 'TEXT'], ['merchant', 'TEXT'],
      ['issuer_category', 'TEXT'], ['content_digest', 'TEXT'], ['state', 'TEXT'], ['outcome', 'TEXT'],
      ['resolved_transaction_id', 'TEXT'], ['provenance', 'INTEGER'], ['resolved_plan_id', 'TEXT'], ['resolved_at', 'TEXT'],
    ]),
    generatedId: /^card-obsrow-[a-p]{32}$/,
  },
  card_observation_secondary_ids: {
    columns: new Map([
      ['id', 'TEXT'], ['observation_id', 'TEXT'], ['ordinal', 'INTEGER'], ['namespace', 'TEXT'], ['namespace_kind', 'TEXT'],
      ['id_hash', 'TEXT'],
    ]),
    generatedId: /^card-obsid-[a-p]{32}$/,
  },
  card_sync_payload_receipts: {
    columns: new Map([
      ['observation_set_id', 'TEXT'], ['payload_digest', 'TEXT'], ['canonical_json', 'TEXT'], ['byte_length', 'INTEGER'],
      ['accepted_at', 'TEXT'], ['expires_at', 'TEXT'],
    ]),
    generatedId: NO_ID,
  },
  card_transaction_versions: {
    columns: new Map([
      ['card_transaction_id', 'TEXT'], ['revision', 'INTEGER'], ['card_account_id', 'TEXT'], ['status', 'TEXT'],
      ['transaction_date', 'TEXT'], ['posted_date', 'TEXT'], ['amount_minor', 'INTEGER'],
      ['original_amount_minor', 'INTEGER'], ['original_currency', 'TEXT'], ['kind', 'TEXT'], ['description', 'TEXT'],
      ['merchant', 'TEXT'], ['issuer_category', 'TEXT'], ['card_scope_id', 'TEXT'], ['removed_reason', 'TEXT'],
      ['removed_from_status', 'TEXT'], ['removed_at', 'TEXT'], ['merged_into_id', 'TEXT'], ['dismissed_at', 'TEXT'],
      ['reversal_snapshot_revision', 'INTEGER'], ['replaced_at', 'TEXT'],
    ]),
    generatedId: NO_ID,
  },
  card_source_identities: {
    columns: new Map([
      ['id', 'TEXT'], ['card_account_id', 'TEXT'], ['source_scope_id', 'TEXT'], ['source_scope_kind', 'TEXT'],
      ['namespace', 'TEXT'], ['namespace_kind', 'TEXT'], ['id_hash', 'TEXT'], ['canonical_transaction_id', 'TEXT'],
      ['status', 'TEXT'], ['first_seen_status', 'TEXT'], ['created_origin', 'TEXT'], ['import_batch_id', 'TEXT'],
      ['first_observation_id', 'TEXT'], ['created_at', 'TEXT'], ['last_seen_at', 'TEXT'], ['last_seen_run_id', 'TEXT'],
    ]),
    generatedId: /^card-ident-[a-p]{32}$/,
  },
  card_identity_contents: {
    columns: new Map([
      ['identity_id', 'TEXT'], ['content_digest', 'TEXT'], ['resolution', 'TEXT'], ['recorded_at', 'TEXT'],
    ]),
    generatedId: NO_ID,
  },
  card_transaction_events: {
    columns: new Map([
      ['id', 'TEXT'], ['card_transaction_id', 'TEXT'], ['card_account_id', 'TEXT'], ['event_type', 'TEXT'],
      ['transaction_revision', 'INTEGER'], ['origin', 'TEXT'], ['actor_kind', 'TEXT'], ['actor_ref', 'TEXT'],
      ['import_batch_id', 'TEXT'], ['run_id', 'TEXT'], ['observation_set_id', 'TEXT'], ['observation_id', 'TEXT'],
      ['identity_id', 'TEXT'], ['plan_id', 'TEXT'], ['plan_digest', 'TEXT'], ['related_transaction_id', 'TEXT'],
      ['cause_event_id', 'TEXT'], ['reverses_event_id', 'TEXT'], ['reason', 'TEXT'], ['from_status', 'TEXT'],
      ['to_status', 'TEXT'], ['from_amount_minor', 'INTEGER'], ['to_amount_minor', 'INTEGER'],
      ['from_transaction_date', 'TEXT'], ['to_transaction_date', 'TEXT'], ['from_posted_date', 'TEXT'],
      ['to_posted_date', 'TEXT'], ['from_kind', 'TEXT'], ['to_kind', 'TEXT'], ['from_scope_id', 'TEXT'],
      ['to_scope_id', 'TEXT'], ['from_canonical_id', 'TEXT'], ['to_canonical_id', 'TEXT'], ['edit_fields', 'INTEGER'],
      ['edit_resolution', 'TEXT'], ['notify', 'INTEGER'], ['created_at', 'TEXT'],
    ]),
    generatedId: /^card-event-[a-p]{32}$/,
  },
  card_reconciliation_suggestions: {
    columns: new Map([
      ['id', 'TEXT'], ['observation_set_id', 'TEXT'], ['card_account_id', 'TEXT'], ['observation_id', 'TEXT'],
      ['category', 'TEXT'], ['reason', 'TEXT'], ['allowed_actions', 'INTEGER'], ['difference_field', 'TEXT'],
      ['expected_minor', 'INTEGER'], ['actual_minor', 'INTEGER'], ['status', 'TEXT'], ['draft_action', 'TEXT'],
      ['draft_transaction_id', 'TEXT'], ['draft_scope_id', 'TEXT'], ['drafted_by_ref', 'TEXT'], ['drafted_at', 'TEXT'],
      ['committed_action', 'TEXT'], ['committed_transaction_id', 'TEXT'], ['committed_scope_id', 'TEXT'],
      ['committed_revision', 'INTEGER'], ['committed_plan_id', 'TEXT'], ['committed_at', 'TEXT'],
      ['classified_ledger_revision', 'INTEGER'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
    ]),
    generatedId: /^rvw_[a-p]{32}$/,
  },
  card_reconciliation_candidates: {
    columns: new Map([
      ['review_item_id', 'TEXT'], ['card_account_id', 'TEXT'], ['rank', 'INTEGER'], ['transaction_id', 'TEXT'],
      ['rule', 'TEXT'], ['matched_on', 'INTEGER'], ['blocked_reason', 'TEXT'],
    ]),
    generatedId: NO_ID,
  },
  card_coverage_windows: {
    columns: new Map([
      ['id', 'TEXT'], ['card_account_id', 'TEXT'], ['card_scope_id', 'TEXT'], ['source_kind', 'TEXT'], ['source', 'TEXT'],
      ['import_batch_id', 'TEXT'], ['observation_set_id', 'TEXT'], ['entry_ordinal', 'INTEGER'], ['status', 'TEXT'],
      ['requested_start', 'TEXT'], ['requested_end', 'TEXT'], ['requested_basis', 'TEXT'], ['observed_start', 'TEXT'],
      ['observed_end', 'TEXT'], ['observed_basis', 'TEXT'], ['claimed_completeness', 'TEXT'],
      ['verified_completeness', 'TEXT'], ['termination', 'TEXT'], ['page_count', 'INTEGER'], ['evidence', 'TEXT'],
      ['ledger_state', 'TEXT'], ['observed_at', 'TEXT'], ['recorded_at', 'TEXT'], ['updated_at', 'TEXT'],
    ]),
    generatedId: /^card-cover-[a-p]{32}$/,
  },
  card_sync_commit_plans: {
    columns: new Map([
      ['id', 'TEXT'], ['plan_kind', 'TEXT'], ['card_account_id', 'TEXT'], ['observation_set_id', 'TEXT'],
      ['set_version', 'INTEGER'], ['principal_kind', 'TEXT'], ['device_id', 'TEXT'], ['actor_ref', 'TEXT'],
      ['binding_id', 'TEXT'], ['binding_version', 'INTEGER'], ['payload_digest', 'TEXT'], ['plan_digest', 'TEXT'],
      ['auto_eligible', 'INTEGER'], ['source_reviewed', 'INTEGER'], ['action_count', 'INTEGER'],
      ['count_insert', 'INTEGER'], ['count_update', 'INTEGER'], ['count_unchanged', 'INTEGER'],
      ['count_aliased', 'INTEGER'], ['count_matched', 'INTEGER'], ['count_attributed', 'INTEGER'],
      ['count_promoted', 'INTEGER'], ['count_corrected', 'INTEGER'], ['count_rejected', 'INTEGER'],
      ['count_unmatched', 'INTEGER'], ['count_superseded', 'INTEGER'], ['ledger_revision', 'INTEGER'],
      ['policy_revision', 'INTEGER'], ['issuer_policy_revision', 'INTEGER'], ['contract_version', 'INTEGER'],
      ['guard_revision', 'INTEGER'], ['authorization_generation', 'TEXT'], ['created_at', 'TEXT'], ['expires_at', 'TEXT'],
      ['status', 'TEXT'], ['closed_at', 'TEXT'], ['cancel_reason', 'TEXT'],
    ]),
    generatedId: /^prv_[a-p]{32}$/,
  },
  card_sync_plan_actions: {
    columns: new Map([
      ['plan_id', 'TEXT'], ['ordinal', 'INTEGER'], ['card_account_id', 'TEXT'], ['plan_kind', 'TEXT'], ['op', 'TEXT'],
      ['observation_ordinal', 'INTEGER'], ['review_item_id', 'TEXT'], ['content_digest', 'TEXT'],
      ['transaction_id', 'TEXT'], ['expected_revision', 'INTEGER'], ['new_ref', 'INTEGER'],
      ['related_transaction_id', 'TEXT'], ['related_revision', 'INTEGER'], ['scope_id', 'TEXT'], ['promote', 'INTEGER'],
      ['restore', 'INTEGER'], ['identity_count', 'INTEGER'], ['reverses_event_id', 'TEXT'],
    ]),
    generatedId: NO_ID,
  },
  card_sync_audit_events: {
    columns: new Map([
      ['id', 'TEXT'], ['event_type', 'TEXT'], ['actor_kind', 'TEXT'], ['actor_ref', 'TEXT'], ['card_account_id', 'TEXT'],
      ['binding_id', 'TEXT'], ['device_id', 'TEXT'], ['pairing_id', 'TEXT'], ['run_id', 'TEXT'],
      ['observation_set_id', 'TEXT'], ['plan_id', 'TEXT'], ['ledger_event_id', 'TEXT'], ['code', 'TEXT'],
      ['version_before', 'INTEGER'], ['version_after', 'INTEGER'], ['row_count', 'INTEGER'], ['byte_count', 'INTEGER'],
      ['item_count', 'INTEGER'], ['authorization_generation', 'TEXT'], ['created_at', 'TEXT'],
    ]),
    generatedId: /^card-audit-[a-p]{32}$/,
  },
  card_payment_links: {
    columns: new Map([
      ['id', 'TEXT'], ['card_transaction_id', 'TEXT'], ['cash_event_ref', 'TEXT'], ['decision', 'TEXT'],
      ['amount_minor', 'INTEGER'], ['currency', 'TEXT'], ['rules_version', 'INTEGER'], ['decided_at', 'TEXT'],
      ['decided_by_ref', 'TEXT'],
    ]),
    generatedId: /^card-link-[a-p]{32}$/,
  },
};

/** A card column as an error message may name it: as itself if this build's schema has it, else `<column>`. */
export const cardColumnLabel = (table: CardTable, column: string) =>
  (CARD_SCHEMA[table].columns.has(column) ? column : '<column>');

const LONG_DIGIT_GLOB = `*${'[0-9]'.repeat(LONG_DIGIT_RUN)}*`;
/**
 * A GLOB that matches text holding any of CARD_TEXT_FORBIDDEN_RANGES' characters: the one SQL form of the normalized-text
 * rule, for the card guards and for every other domain's free-text CHECK (the retail tables, Costco PR 2).
 */
export const FORBIDDEN_CHAR_GLOB = `*[${CARD_TEXT_FORBIDDEN_RANGES
  .map(([start, end]) => String.fromCodePoint(start) + (end > start ? `-${String.fromCodePoint(end)}` : ''))
  .join('')}]*`;
if (CARD_TEXT_FORBIDDEN_RANGES.some(([start, end]) => start <= 0x7e && end >= 0x20)) {
  throw new Error('the card guards assume no forbidden character is printable ASCII');
}

/** The SQL names a build registers its card detectors under. */
export interface CardGuardFunctions {
  cardDataFunction: string;
  cardSecretFunction: string;
}

/** One guard check: the SQL condition under which a column's value fails it, and the problem to report. */
export interface CardGuardCheck {
  /** Whether integer columns get this check too; text columns get every check. */
  integers: boolean;
  fails(value: string, column: GuardColumn, functions: CardGuardFunctions): string;
  problem(column: GuardColumn): string;
}

/**
 * The checks the guards apply to every column, in this order, so no textual
 * check ever sees a value of the wrong kind:
 * 1. storage type: text columns hold TEXT, integer columns INTEGER (a BLOB
 *    or an unconvertible value never matches GLOB, so it would pass unseen);
 * 2. no NUL in text: GLOB and length() stop at the first NUL, SQLite keeps
 *    the bytes after it;
 * 3. no non-ASCII digit, digit-like compatibility character or invisible
 *    character (CARD_TEXT_FORBIDDEN_RANGES): stored text is normalized, so a
 *    digit run in any script or split by invisible characters is rejected;
 * 4. no run of 13 or more ASCII digits, integer columns included;
 * 5. no card data (`containsCardData`): no card-length run of digits, masks
 *    and separators that shows more than four digits, and no masks followed
 *    by five or more digits;
 * 6. no labeled security code, PIN or expiry date (`containsCardSecret`).
 * Problems name the column, never the value.
 */
export const CARD_GUARD_CHECKS: readonly CardGuardCheck[] = [
  {
    integers: true,
    fails: (v, column) => `typeof(${v}) NOT IN ('${column.type === 'TEXT' ? 'text' : 'integer'}', 'null')`,
    problem: (column) => (column.type === 'TEXT' ? 'must be stored as text' : 'must be stored as an integer'),
  },
  { integers: false, fails: (v) => `instr(${v}, char(0)) > 0`, problem: () => 'must not contain NUL characters' },
  {
    // The first GLOB is a cheap pre-check: every forbidden character lies
    // outside printable ASCII (asserted where FORBIDDEN_CHAR_GLOB is built),
    // so the long character class runs only on the rare text that has one.
    integers: false,
    fails: (v) => `${v} GLOB '*[^ -~]*' AND ${v} GLOB '${FORBIDDEN_CHAR_GLOB}'`,
    problem: () => 'must not contain non-ASCII digits or invisible characters',
  },
  {
    integers: true,
    fails: (v) => `${v} GLOB '${LONG_DIGIT_GLOB}'`,
    problem: () => `must not contain ${LONG_DIGIT_RUN} or more consecutive digits`,
  },
  {
    integers: false,
    fails: (v, _column, functions) => `${functions.cardDataFunction}(${v})`,
    problem: () => 'must not contain a card number',
  },
  {
    integers: false,
    fails: (v, _column, functions) => `${functions.cardSecretFunction}(${v})`,
    problem: () => 'must not contain a card security code, PIN or expiry date',
  },
];

export const guardCovers = (check: CardGuardCheck, column: GuardColumn) => check.integers || column.type === 'TEXT';

/** The message a guard trigger raises when `column` fails `check`: constants and a column label only. */
export const cardGuardMessage = (table: CardTable, column: GuardColumn, check: CardGuardCheck) =>
  `${table}.${cardColumnLabel(table, column.name)} ${check.problem(column)}`;

/**
 * Every message this build's guard triggers can raise: each check of each
 * schema column, and of a column outside the schema (`<column>`) of either
 * type. Built only from constants, so each is value-free.
 */
export const CARD_GUARD_MESSAGES: ReadonlySet<string> = new Set(CARD_TABLES.flatMap((table) => [
  ...[...CARD_SCHEMA[table].columns].map(([name, type]) => ({ name, type })),
  { name: '', type: 'TEXT' as const },
  { name: '', type: 'INTEGER' as const },
].flatMap((column) => CARD_GUARD_CHECKS
  .filter((check) => guardCovers(check, column))
  .map((check) => cardGuardMessage(table, column, check)))));
