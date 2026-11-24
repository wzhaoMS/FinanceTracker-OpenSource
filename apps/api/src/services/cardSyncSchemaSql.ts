/**
 * Card-sync schema v15 (E1b) and its named statements, lifted verbatim from
 * the approved design, e1b-schema-design.md revision 8
 * (sha256 0863ffadf12504f722f80a19c43a74f8362c373d358f45f96d191d9a540caccd),
 * by scripts/card-sync-extract-sql.mjs. Generated: do not edit by hand.
 * Regenerate from the design and re-pin cardSyncSchemaSql.test.ts.
 * One deliberate exception: this public release renames the design's two
 * household holder/owner aliases to the placeholders 'alex' and 'casey' in
 * ck_scope_holder_alias and ck_set_owner, so `--check` against revision 8
 * reports exactly those two lines.
 *
 * CARD_SYNC_BLOCKS: per design section, every `-- @block` fence joined with a
 * newline (the migration runs them in the order of the design's §3.1).
 * CARD_SYNC_QUERIES: the 22 `-- @query` statements (cardSyncStatements.ts).
 */
export const CARD_SYNC_DESIGN_SOURCE = { revision: 8, sha256: '0863ffadf12504f722f80a19c43a74f8362c373d358f45f96d191d9a540caccd' } as const;

export const CARD_SYNC_BLOCKS = {
  '2.1': `-- @block 2.1
CREATE TABLE card_sync_sources (
  source                      TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_src_source CHECK (typeof(source) = 'text' AND length(CAST(source AS BLOB)) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z-]*'),
  issuer                      TEXT NOT NULL CONSTRAINT ck_src_issuer CHECK (issuer IN ('amex', 'chase', 'citi', 'wellsfargo')),
  mode                        TEXT NOT NULL CONSTRAINT ck_src_mode CHECK (mode IN ('isolated-read', 'main-passive', 'dom-passive')),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_src_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)
);
CREATE UNIQUE INDEX idx_card_sync_sources_fk_issuer ON card_sync_sources(source, issuer);
CREATE UNIQUE INDEX idx_card_sync_sources_fk_mode ON card_sync_sources(source, issuer, mode);

-- @block 2.1
CREATE TABLE card_sync_namespaces (
  namespace                   TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_ns_namespace CHECK (typeof(namespace) = 'text' AND length(CAST(namespace AS BLOB)) BETWEEN 6 AND 48 AND namespace NOT GLOB '*[^a-z0-9:-]*' AND (namespace GLOB '[a-z]*:v[1-9]' OR namespace GLOB '[a-z]*:v[1-9][0-9]')),
  kind                        TEXT NOT NULL CONSTRAINT ck_ns_kind CHECK (kind IN ('legacy-file', 'stable', 'capture')),
  source                      TEXT REFERENCES card_sync_sources(source) ON DELETE RESTRICT,
  contract_version            INTEGER CONSTRAINT ck_ns_contract_version CHECK (contract_version IS NULL OR (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)),
  CONSTRAINT ck_ns_source_shape CHECK (((kind = 'legacy-file') = (source IS NULL) AND (source IS NULL) = (contract_version IS NULL)) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_namespaces_fk_kind ON card_sync_namespaces(namespace, kind);
CREATE UNIQUE INDEX idx_card_sync_namespaces_one_capture ON card_sync_namespaces(source) WHERE kind = 'capture';
CREATE INDEX idx_card_sync_namespaces_source ON card_sync_namespaces(source);

INSERT INTO card_sync_sources (source, issuer, mode, contract_version) VALUES
  ('chase-api', 'chase', 'isolated-read', 1),
  ('amex-api-recent', 'amex', 'main-passive', 1),
  ('amex-api-rest', 'amex', 'isolated-read', 1),
  ('citi-api', 'citi', 'main-passive', 1),
  ('wf-dom', 'wellsfargo', 'dom-passive', 1);

INSERT INTO card_sync_namespaces (namespace, kind, source, contract_version) VALUES
  ('legacy-file:v1', 'legacy-file', NULL, NULL),
  ('chase-api:sor:v1', 'stable', 'chase-api', 1),
  ('chase-api:derived:v1', 'stable', 'chase-api', 1),
  ('chase-api:capture:v1', 'capture', 'chase-api', 1),
  ('amex-api-recent:capture:v1', 'capture', 'amex-api-recent', 1),
  ('amex-api-rest:identifier:v1', 'stable', 'amex-api-rest', 1),
  ('amex-api-rest:reference:v1', 'stable', 'amex-api-rest', 1),
  ('amex-api-rest:capture:v1', 'capture', 'amex-api-rest', 1),
  ('citi-api:transaction:v1', 'stable', 'citi-api', 1),
  ('citi-api:citi-transaction:v1', 'stable', 'citi-api', 1),
  ('citi-api:capture:v1', 'capture', 'citi-api', 1),
  ('wf-dom:capture:v1', 'capture', 'wf-dom', 1);
`,
  '2.2': `-- @block 2.2
ALTER TABLE card_accounts ADD COLUMN ledger_revision INTEGER NOT NULL DEFAULT 0
  CONSTRAINT ck_acct_ledger_revision CHECK (ledger_revision = CAST(ledger_revision AS INTEGER) AND ledger_revision BETWEEN 0 AND 2147483647);
CREATE UNIQUE INDEX idx_card_accounts_fk_issuer_currency ON card_accounts(id, issuer, currency);
CREATE UNIQUE INDEX idx_card_accounts_fk_currency ON card_accounts(id, currency);
CREATE UNIQUE INDEX idx_card_import_batches_fk_account ON card_import_batches(id, card_account_id);
`,
  '2.3': `-- @block 2.3
CREATE TABLE card_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_scope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'scp_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  kind                        TEXT NOT NULL CONSTRAINT ck_scope_kind CHECK (kind IN ('known', 'unknown', 'legacy')),
  holder_alias                TEXT NOT NULL CONSTRAINT ck_scope_holder_alias CHECK (holder_alias IN ('alex', 'casey', 'joint', 'member-a', 'unknown')),
  last4                       TEXT CONSTRAINT ck_scope_last4 CHECK (last4 IS NULL OR (typeof(last4) = 'text' AND length(CAST(last4 AS BLOB)) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]')),
  label                       TEXT NOT NULL CONSTRAINT ck_scope_label CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 64),
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_scope_status CHECK (status IN ('active', 'retired')),
  version                     INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_scope_version CHECK (version = CAST(version AS INTEGER) AND version BETWEEN 1 AND 2147483647),
  confirmed_by_ref            TEXT CONSTRAINT ck_scope_confirmed_by_ref CHECK (confirmed_by_ref IS NULL OR (typeof(confirmed_by_ref) = 'text' AND length(CAST(confirmed_by_ref AS BLOB)) = 36 AND substr(confirmed_by_ref, 1, 4) = 'usr_' AND substr(confirmed_by_ref, 5) NOT GLOB '*[^a-p]*')),
  confirmed_at                TEXT CONSTRAINT ck_scope_confirmed_at CHECK (confirmed_at IS NULL OR (typeof(confirmed_at) = 'text' AND length(CAST(confirmed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS confirmed_at)),
  retired_at                  TEXT CONSTRAINT ck_scope_retired_at CHECK (retired_at IS NULL OR (typeof(retired_at) = 'text' AND length(CAST(retired_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) IS retired_at)),
  created_at                  TEXT NOT NULL CONSTRAINT ck_scope_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_scope_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CONSTRAINT ck_scope_alias_kind CHECK (((kind = 'known') = (holder_alias <> 'unknown')) IS TRUE),
  CONSTRAINT ck_scope_unresolved_shape CHECK ((kind = 'known' OR (last4 IS NULL AND status = 'active')) IS TRUE),
  CONSTRAINT ck_scope_confirmation CHECK (((confirmed_by_ref IS NULL) = (confirmed_at IS NULL) AND (kind = 'legacy') = (confirmed_by_ref IS NULL)) IS TRUE),
  CONSTRAINT ck_scope_retired CHECK (((status = 'retired') = (retired_at IS NOT NULL)) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_scopes_fk_account ON card_scopes(id, card_account_id);
CREATE UNIQUE INDEX idx_card_scopes_fk_kind ON card_scopes(id, card_account_id, kind);
CREATE UNIQUE INDEX idx_card_scopes_one_legacy ON card_scopes(card_account_id) WHERE kind = 'legacy';
CREATE UNIQUE INDEX idx_card_scopes_one_unknown ON card_scopes(card_account_id) WHERE kind = 'unknown';
CREATE INDEX idx_card_scopes_account ON card_scopes(card_account_id, kind, status);
`,
  '2.4': `-- @block 2.4
CREATE TABLE card_source_bindings (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_bind_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'bnd_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL,
  issuer                      TEXT NOT NULL,
  currency                    TEXT NOT NULL,
  source                      TEXT NOT NULL,
  source_account_digest       TEXT CONSTRAINT ck_bind_source_account_digest CHECK (source_account_digest IS NULL OR (typeof(source_account_digest) = 'text' AND length(CAST(source_account_digest AS BLOB)) = 69 AND substr(source_account_digest, 1, 5) = 'sad1:' AND substr(source_account_digest, 6) NOT GLOB '*[^a-p]*')),
  label                       TEXT NOT NULL CONSTRAINT ck_bind_label CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 64),
  status                      TEXT NOT NULL DEFAULT 'confirmed' CONSTRAINT ck_bind_status CHECK (status IN ('confirmed', 'needs-reconfirmation', 'retired')),
  status_reason               TEXT CONSTRAINT ck_bind_status_reason CHECK (status_reason IS NULL OR (status_reason IN ('restored-from-backup', 'card-account-changed', 'contract-changed'))),
  version                     INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_bind_version CHECK (version = CAST(version AS INTEGER) AND version BETWEEN 1 AND 2147483647),
  auto_sync_revision          INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_bind_auto_sync_revision CHECK (auto_sync_revision = CAST(auto_sync_revision AS INTEGER) AND auto_sync_revision BETWEEN 1 AND 2147483647),
  confirmed_by_ref            TEXT NOT NULL CONSTRAINT ck_bind_confirmed_by_ref CHECK (typeof(confirmed_by_ref) = 'text' AND length(CAST(confirmed_by_ref AS BLOB)) = 36 AND substr(confirmed_by_ref, 1, 4) = 'usr_' AND substr(confirmed_by_ref, 5) NOT GLOB '*[^a-p]*'),
  confirmed_at                TEXT NOT NULL CONSTRAINT ck_bind_confirmed_at CHECK (typeof(confirmed_at) = 'text' AND length(CAST(confirmed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS confirmed_at),
  retired_at                  TEXT CONSTRAINT ck_bind_retired_at CHECK (retired_at IS NULL OR (typeof(retired_at) = 'text' AND length(CAST(retired_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) IS retired_at)),
  created_at                  TEXT NOT NULL CONSTRAINT ck_bind_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_bind_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (card_account_id, issuer, currency) REFERENCES card_accounts(id, issuer, currency) ON DELETE RESTRICT,
  FOREIGN KEY (source, issuer) REFERENCES card_sync_sources(source, issuer) ON DELETE RESTRICT,
  CONSTRAINT ck_bind_status_shape CHECK (((status = 'needs-reconfirmation') = (status_reason IS NOT NULL) AND (status = 'retired') = (retired_at IS NOT NULL)) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_source_bindings_fk_account ON card_source_bindings(id, card_account_id);
CREATE UNIQUE INDEX idx_card_source_bindings_fk_source ON card_source_bindings(id, card_account_id, source);
CREATE UNIQUE INDEX idx_card_source_bindings_live ON card_source_bindings(card_account_id, source) WHERE status <> 'retired';
CREATE UNIQUE INDEX idx_card_source_bindings_digest ON card_source_bindings(source, source_account_digest)
  WHERE source_account_digest IS NOT NULL AND status <> 'retired';
CREATE INDEX idx_card_source_bindings_account ON card_source_bindings(card_account_id, status);

-- @block 2.4
CREATE TABLE card_source_binding_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_bscope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-bscope-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  binding_id                  TEXT NOT NULL,
  card_scope_id               TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  card_scope_kind             TEXT NOT NULL CONSTRAINT ck_bscope_card_scope_kind CHECK (card_scope_kind IN ('known', 'unknown')),
  binding_version             INTEGER NOT NULL CONSTRAINT ck_bscope_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_bscope_status CHECK (status IN ('active', 'revoked')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_bscope_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  revoked_at                  TEXT CONSTRAINT ck_bscope_revoked_at CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  CONSTRAINT ck_bscope_revoked CHECK (((status = 'revoked') = (revoked_at IS NOT NULL)) IS TRUE),
  FOREIGN KEY (binding_id, card_account_id) REFERENCES card_source_bindings(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (card_scope_id, card_account_id, card_scope_kind) REFERENCES card_scopes(id, card_account_id, kind) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_card_source_binding_scopes_active ON card_source_binding_scopes(binding_id, card_scope_id) WHERE status = 'active';
CREATE INDEX idx_card_source_binding_scopes_binding ON card_source_binding_scopes(binding_id, status);
CREATE INDEX idx_card_source_binding_scopes_scope ON card_source_binding_scopes(card_scope_id);
`,
  '2.5': `-- @block 2.5
CREATE TABLE card_sync_policy (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_pol_id CHECK (id = 'card-sync-policy'),
  revision                    INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_pol_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  paused                      INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pol_paused CHECK (paused IN (0, 1)),
  paused_at                   TEXT CONSTRAINT ck_pol_paused_at CHECK (paused_at IS NULL OR (typeof(paused_at) = 'text' AND length(CAST(paused_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', paused_at) IS paused_at)),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_pol_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  generation_changed_at       TEXT NOT NULL CONSTRAINT ck_pol_generation_changed_at CHECK (typeof(generation_changed_at) = 'text' AND length(CAST(generation_changed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', generation_changed_at) IS generation_changed_at),
  recovery_completed_at       TEXT CONSTRAINT ck_pol_recovery_completed_at CHECK (recovery_completed_at IS NULL OR (typeof(recovery_completed_at) = 'text' AND length(CAST(recovery_completed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recovery_completed_at) IS recovery_completed_at)),
  review_retention_days       INTEGER NOT NULL DEFAULT 30 CONSTRAINT ck_pol_review_retention_days CHECK (review_retention_days = CAST(review_retention_days AS INTEGER) AND review_retention_days BETWEEN 1 AND 90),
  receipt_retention_days      INTEGER NOT NULL DEFAULT 7 CONSTRAINT ck_pol_receipt_retention_days CHECK (receipt_retention_days = CAST(receipt_retention_days AS INTEGER) AND receipt_retention_days BETWEEN 1 AND 7),
  max_runs_per_device_day     INTEGER NOT NULL DEFAULT 50 CONSTRAINT ck_pol_max_runs_per_device_day CHECK (max_runs_per_device_day = CAST(max_runs_per_device_day AS INTEGER) AND max_runs_per_device_day BETWEEN 1 AND 500),
  quota_account_sets          INTEGER NOT NULL DEFAULT 100 CONSTRAINT ck_pol_quota_account_sets CHECK (quota_account_sets = CAST(quota_account_sets AS INTEGER) AND quota_account_sets BETWEEN 1 AND 1000),
  quota_account_rows          INTEGER NOT NULL DEFAULT 10000 CONSTRAINT ck_pol_quota_account_rows CHECK (quota_account_rows = CAST(quota_account_rows AS INTEGER) AND quota_account_rows BETWEEN 1 AND 100000),
  quota_account_bytes         INTEGER NOT NULL DEFAULT 10485760 CONSTRAINT ck_pol_quota_account_bytes CHECK (quota_account_bytes = CAST(quota_account_bytes AS INTEGER) AND quota_account_bytes BETWEEN 1 AND 104857600),
  quota_device_sets           INTEGER NOT NULL DEFAULT 200 CONSTRAINT ck_pol_quota_device_sets CHECK (quota_device_sets = CAST(quota_device_sets AS INTEGER) AND quota_device_sets BETWEEN 1 AND 2000),
  quota_device_rows           INTEGER NOT NULL DEFAULT 20000 CONSTRAINT ck_pol_quota_device_rows CHECK (quota_device_rows = CAST(quota_device_rows AS INTEGER) AND quota_device_rows BETWEEN 1 AND 200000),
  quota_device_bytes          INTEGER NOT NULL DEFAULT 20971520 CONSTRAINT ck_pol_quota_device_bytes CHECK (quota_device_bytes = CAST(quota_device_bytes AS INTEGER) AND quota_device_bytes BETWEEN 1 AND 209715200),
  quota_global_sets           INTEGER NOT NULL DEFAULT 500 CONSTRAINT ck_pol_quota_global_sets CHECK (quota_global_sets = CAST(quota_global_sets AS INTEGER) AND quota_global_sets BETWEEN 1 AND 5000),
  quota_global_rows           INTEGER NOT NULL DEFAULT 50000 CONSTRAINT ck_pol_quota_global_rows CHECK (quota_global_rows = CAST(quota_global_rows AS INTEGER) AND quota_global_rows BETWEEN 1 AND 500000),
  quota_global_bytes          INTEGER NOT NULL DEFAULT 52428800 CONSTRAINT ck_pol_quota_global_bytes CHECK (quota_global_bytes = CAST(quota_global_bytes AS INTEGER) AND quota_global_bytes BETWEEN 1 AND 524288000),
  updated_by_ref              TEXT CONSTRAINT ck_pol_updated_by_ref CHECK (updated_by_ref IS NULL OR (typeof(updated_by_ref) = 'text' AND length(CAST(updated_by_ref AS BLOB)) = 36 AND substr(updated_by_ref, 1, 4) = 'usr_' AND substr(updated_by_ref, 5) NOT GLOB '*[^a-p]*')),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_pol_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CONSTRAINT ck_pol_paused_shape CHECK (((paused = 1) = (paused_at IS NOT NULL)) IS TRUE)
);

-- @block 2.5
CREATE TABLE card_sync_issuer_policy (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_ipol_id CHECK (id IN ('amex', 'chase', 'citi', 'wellsfargo')),
  enabled                     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_ipol_enabled CHECK (enabled IN (0, 1)),
  enabled_at                  TEXT CONSTRAINT ck_ipol_enabled_at CHECK (enabled_at IS NULL OR (typeof(enabled_at) = 'text' AND length(CAST(enabled_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', enabled_at) IS enabled_at)),
  approved_contract_version   INTEGER CONSTRAINT ck_ipol_approved_contract_version CHECK (approved_contract_version IS NULL OR (approved_contract_version = CAST(approved_contract_version AS INTEGER) AND approved_contract_version BETWEEN 1 AND 999)),
  risk_acknowledged_at        TEXT CONSTRAINT ck_ipol_risk_acknowledged_at CHECK (risk_acknowledged_at IS NULL OR (typeof(risk_acknowledged_at) = 'text' AND length(CAST(risk_acknowledged_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', risk_acknowledged_at) IS risk_acknowledged_at)),
  main_passive_accepted       INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_ipol_main_passive_accepted CHECK (main_passive_accepted IN (0, 1)),
  revision                    INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_ipol_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  updated_by_ref              TEXT CONSTRAINT ck_ipol_updated_by_ref CHECK (updated_by_ref IS NULL OR (typeof(updated_by_ref) = 'text' AND length(CAST(updated_by_ref AS BLOB)) = 36 AND substr(updated_by_ref, 1, 4) = 'usr_' AND substr(updated_by_ref, 5) NOT GLOB '*[^a-p]*')),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_ipol_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CONSTRAINT ck_ipol_enabled_shape CHECK (((enabled = 1) = (enabled_at IS NOT NULL) AND (enabled = 0 OR (approved_contract_version IS NOT NULL AND risk_acknowledged_at IS NOT NULL))) IS TRUE),
  CONSTRAINT ck_ipol_main_passive CHECK (((main_passive_accepted = 0 OR id IN ('amex', 'citi')) AND (enabled = 0 OR id NOT IN ('amex', 'citi') OR main_passive_accepted = 1)) IS TRUE)
);
`,
  '2.6': `-- @block 2.6
CREATE TABLE card_sync_pairings (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_pair_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'pai_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  code_digest                 TEXT CONSTRAINT ck_pair_code_digest CHECK (code_digest IS NULL OR (typeof(code_digest) = 'text' AND length(CAST(code_digest AS BLOB)) = 69 AND substr(code_digest, 1, 5) = 'hph1:' AND substr(code_digest, 6) NOT GLOB '*[^a-p]*')),
  status                      TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_pair_status CHECK (status IN ('open', 'redeemed', 'approved', 'rejected', 'cancelled', 'expired', 'locked')),
  replaces_device_id          TEXT REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  created_by_ref              TEXT NOT NULL CONSTRAINT ck_pair_created_by_ref CHECK (typeof(created_by_ref) = 'text' AND length(CAST(created_by_ref AS BLOB)) = 36 AND substr(created_by_ref, 1, 4) = 'usr_' AND substr(created_by_ref, 5) NOT GLOB '*[^a-p]*'),
  created_at                  TEXT NOT NULL CONSTRAINT ck_pair_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_pair_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  failed_attempts             INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pair_failed_attempts CHECK (failed_attempts = CAST(failed_attempts AS INTEGER) AND failed_attempts BETWEEN 0 AND 5),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_pair_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  redeemed_at                 TEXT CONSTRAINT ck_pair_redeemed_at CHECK (redeemed_at IS NULL OR (typeof(redeemed_at) = 'text' AND length(CAST(redeemed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', redeemed_at) IS redeemed_at)),
  closed_at                   TEXT CONSTRAINT ck_pair_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  CONSTRAINT ck_pair_window CHECK ((expires_at > created_at AND (julianday(expires_at) - julianday(created_at)) * 86400.0 <= 300.001) IS TRUE),
  CONSTRAINT ck_pair_code_shape CHECK (((status = 'open') = (code_digest IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_pair_closed_shape CHECK (((status IN ('open', 'redeemed')) = (closed_at IS NULL)) IS TRUE),
  CONSTRAINT ck_pair_locked_shape CHECK (((status = 'locked') = (failed_attempts = 5)) IS TRUE),
  CONSTRAINT ck_pair_redeemed_shape CHECK (((status IN ('redeemed', 'approved', 'rejected') AND redeemed_at IS NOT NULL) OR (status IN ('open', 'locked') AND redeemed_at IS NULL) OR status IN ('cancelled', 'expired')) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_pairings_code ON card_sync_pairings(code_digest) WHERE code_digest IS NOT NULL;
CREATE UNIQUE INDEX idx_card_sync_pairings_one_open ON card_sync_pairings(created_by_ref) WHERE status = 'open';
CREATE INDEX idx_card_sync_pairings_status ON card_sync_pairings(status, expires_at);
CREATE INDEX idx_card_sync_pairings_replaces ON card_sync_pairings(replaces_device_id);

-- @block 2.6
CREATE TABLE card_sync_pairing_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_pscope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-pscope-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  pairing_id                  TEXT NOT NULL REFERENCES card_sync_pairings(id) ON DELETE CASCADE,
  binding_id                  TEXT NOT NULL REFERENCES card_source_bindings(id) ON DELETE RESTRICT,
  binding_version             INTEGER NOT NULL CONSTRAINT ck_pscope_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  mode                        TEXT NOT NULL CONSTRAINT ck_pscope_mode CHECK (mode IN ('isolated-read', 'main-passive', 'dom-passive')),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_pscope_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)
);
CREATE UNIQUE INDEX idx_card_sync_pairing_scopes_binding ON card_sync_pairing_scopes(pairing_id, binding_id);
CREATE INDEX idx_card_sync_pairing_scopes_binding_id ON card_sync_pairing_scopes(binding_id);

-- @block 2.6
CREATE TABLE card_sync_devices (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_dev_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'dev_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  pairing_id                  TEXT NOT NULL REFERENCES card_sync_pairings(id) ON DELETE RESTRICT,
  token_digest                TEXT CONSTRAINT ck_dev_token_digest CHECK (token_digest IS NULL OR (typeof(token_digest) = 'text' AND length(CAST(token_digest AS BLOB)) = 69 AND substr(token_digest, 1, 5) = 'hdh1:' AND substr(token_digest, 6) NOT GLOB '*[^a-p]*')),
  fingerprint                 TEXT NOT NULL CONSTRAINT ck_dev_fingerprint CHECK (typeof(fingerprint) = 'text' AND length(CAST(fingerprint AS BLOB)) = 16 AND fingerprint NOT GLOB '*[^a-p]*'),
  label                       TEXT NOT NULL CONSTRAINT ck_dev_label CHECK (typeof(label) = 'text' AND length(CAST(label AS BLOB)) BETWEEN 1 AND 40 AND label GLOB '[A-Za-z]*' AND label NOT GLOB '*[^A-Za-z0-9 ._-]*'),
  client_version              TEXT NOT NULL CONSTRAINT ck_dev_client_version CHECK (typeof(client_version) = 'text' AND length(CAST(client_version AS BLOB)) BETWEEN 5 AND 11 AND client_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND client_version NOT GLOB '*[^0-9.]*'),
  owner_ref                   TEXT NOT NULL CONSTRAINT ck_dev_owner_ref CHECK (typeof(owner_ref) = 'text' AND length(CAST(owner_ref AS BLOB)) = 36 AND substr(owner_ref, 1, 4) = 'usr_' AND substr(owner_ref, 5) NOT GLOB '*[^a-p]*'),
  status                      TEXT NOT NULL DEFAULT 'pending' CONSTRAINT ck_dev_status CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_dev_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  pending_expires_at          TEXT NOT NULL CONSTRAINT ck_dev_pending_expires_at CHECK (typeof(pending_expires_at) = 'text' AND length(CAST(pending_expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', pending_expires_at) IS pending_expires_at),
  activated_at                TEXT CONSTRAINT ck_dev_activated_at CHECK (activated_at IS NULL OR (typeof(activated_at) = 'text' AND length(CAST(activated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) IS activated_at)),
  activated_by_ref            TEXT CONSTRAINT ck_dev_activated_by_ref CHECK (activated_by_ref IS NULL OR (typeof(activated_by_ref) = 'text' AND length(CAST(activated_by_ref AS BLOB)) = 36 AND substr(activated_by_ref, 1, 4) = 'usr_' AND substr(activated_by_ref, 5) NOT GLOB '*[^a-p]*')),
  expires_at                  TEXT CONSTRAINT ck_dev_expires_at CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at)),
  closed_at                   TEXT CONSTRAINT ck_dev_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  close_reason                TEXT CONSTRAINT ck_dev_close_reason CHECK (close_reason IS NULL OR (close_reason IN ('owner', 'rejected', 'rotated', 'recovery', 'pending-expired', 'expired', 'password-reset'))),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_dev_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  last_used_at                TEXT CONSTRAINT ck_dev_last_used_at CHECK (last_used_at IS NULL OR (typeof(last_used_at) = 'text' AND length(CAST(last_used_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at)),
  CONSTRAINT ck_dev_pending_window CHECK ((pending_expires_at > created_at AND (julianday(pending_expires_at) - julianday(created_at)) * 86400.0 <= 600.001) IS TRUE),
  CONSTRAINT ck_dev_token_shape CHECK (((status IN ('pending', 'active')) = (token_digest IS NOT NULL) AND (status IN ('pending', 'active')) = (closed_at IS NULL) AND (closed_at IS NULL) = (close_reason IS NULL)) IS TRUE),
  CONSTRAINT ck_dev_activation_shape CHECK (((activated_at IS NULL) = (activated_by_ref IS NULL) AND (activated_at IS NULL) = (expires_at IS NULL) AND (status <> 'active' OR activated_at IS NOT NULL) AND (status <> 'pending' OR activated_at IS NULL)) IS TRUE),
  CONSTRAINT ck_dev_lifetime CHECK ((expires_at IS NULL OR (expires_at > activated_at AND julianday(expires_at) - julianday(activated_at) <= 30.0)) IS TRUE),
  CONSTRAINT ck_dev_close_reason_shape CHECK ((status IN ('pending', 'active') OR (status = 'expired' AND close_reason IN ('pending-expired', 'expired')) OR (status = 'revoked' AND close_reason IN ('owner', 'rejected', 'rotated', 'recovery', 'password-reset'))) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_devices_pairing ON card_sync_devices(pairing_id);
CREATE UNIQUE INDEX idx_card_sync_devices_token ON card_sync_devices(token_digest) WHERE token_digest IS NOT NULL;
CREATE INDEX idx_card_sync_devices_status ON card_sync_devices(status, expires_at);

-- @block 2.6
CREATE TABLE card_sync_device_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_dscope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-dscope-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  device_id                   TEXT NOT NULL REFERENCES card_sync_devices(id) ON DELETE CASCADE,
  binding_id                  TEXT NOT NULL REFERENCES card_source_bindings(id) ON DELETE RESTRICT,
  binding_version             INTEGER NOT NULL CONSTRAINT ck_dscope_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  mode                        TEXT NOT NULL CONSTRAINT ck_dscope_mode CHECK (mode IN ('isolated-read', 'main-passive', 'dom-passive')),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_dscope_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999),
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_dscope_status CHECK (status IN ('active', 'revoked')),
  granted_by_ref              TEXT NOT NULL CONSTRAINT ck_dscope_granted_by_ref CHECK (typeof(granted_by_ref) = 'text' AND length(CAST(granted_by_ref AS BLOB)) = 36 AND substr(granted_by_ref, 1, 4) = 'usr_' AND substr(granted_by_ref, 5) NOT GLOB '*[^a-p]*'),
  granted_at                  TEXT NOT NULL CONSTRAINT ck_dscope_granted_at CHECK (typeof(granted_at) = 'text' AND length(CAST(granted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', granted_at) IS granted_at),
  revoked_at                  TEXT CONSTRAINT ck_dscope_revoked_at CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  auto_sync                   INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_dscope_auto_sync CHECK (auto_sync IN (0, 1)),
  consent_contract_version    INTEGER CONSTRAINT ck_dscope_consent_contract_version CHECK (consent_contract_version IS NULL OR (consent_contract_version = CAST(consent_contract_version AS INTEGER) AND consent_contract_version BETWEEN 1 AND 999)),
  consent_guard_revision      INTEGER CONSTRAINT ck_dscope_consent_guard_revision CHECK (consent_guard_revision IS NULL OR (consent_guard_revision = CAST(consent_guard_revision AS INTEGER) AND consent_guard_revision BETWEEN 1 AND 999)),
  consent_issuer_revision     INTEGER CONSTRAINT ck_dscope_consent_issuer_revision CHECK (consent_issuer_revision IS NULL OR (consent_issuer_revision = CAST(consent_issuer_revision AS INTEGER) AND consent_issuer_revision BETWEEN 1 AND 2147483647)),
  consent_binding_version     INTEGER CONSTRAINT ck_dscope_consent_binding_version CHECK (consent_binding_version IS NULL OR (consent_binding_version = CAST(consent_binding_version AS INTEGER) AND consent_binding_version BETWEEN 1 AND 2147483647)),
  consent_by_ref              TEXT CONSTRAINT ck_dscope_consent_by_ref CHECK (consent_by_ref IS NULL OR (typeof(consent_by_ref) = 'text' AND length(CAST(consent_by_ref AS BLOB)) = 36 AND substr(consent_by_ref, 1, 4) = 'usr_' AND substr(consent_by_ref, 5) NOT GLOB '*[^a-p]*')),
  consent_at                  TEXT CONSTRAINT ck_dscope_consent_at CHECK (consent_at IS NULL OR (typeof(consent_at) = 'text' AND length(CAST(consent_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', consent_at) IS consent_at)),
  CONSTRAINT ck_dscope_revoked CHECK (((status = 'revoked') = (revoked_at IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_dscope_consent_shape CHECK (((auto_sync = 1) = (consent_at IS NOT NULL) AND (consent_at IS NULL) = (consent_by_ref IS NULL) AND (consent_at IS NULL) = (consent_contract_version IS NULL) AND (consent_at IS NULL) = (consent_guard_revision IS NULL) AND (consent_at IS NULL) = (consent_issuer_revision IS NULL) AND (consent_at IS NULL) = (consent_binding_version IS NULL) AND (auto_sync = 0 OR (status = 'active' AND consent_binding_version = binding_version))) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_device_scopes_active ON card_sync_device_scopes(device_id, binding_id) WHERE status = 'active';
CREATE INDEX idx_card_sync_device_scopes_device ON card_sync_device_scopes(device_id, status);
CREATE INDEX idx_card_sync_device_scopes_binding ON card_sync_device_scopes(binding_id, status);
`,
  '2.7': `-- @block 2.7
CREATE TABLE card_sync_runs (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_run_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'run_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  device_id                   TEXT NOT NULL REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  client_run_id               TEXT NOT NULL CONSTRAINT ck_run_client_run_id CHECK (typeof(client_run_id) = 'text' AND length(CAST(client_run_id AS BLOB)) = 36 AND substr(client_run_id, 1, 4) = 'crn_' AND substr(client_run_id, 5) NOT GLOB '*[^a-p]*'),
  binding_id                  TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  binding_version             INTEGER NOT NULL CONSTRAINT ck_run_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  adapter_version             TEXT NOT NULL CONSTRAINT ck_run_adapter_version CHECK (typeof(adapter_version) = 'text' AND length(CAST(adapter_version AS BLOB)) BETWEEN 1 AND 64 AND adapter_version GLOB '[A-Za-z0-9]*' AND adapter_version NOT GLOB '*[^A-Za-z0-9._@+-]*'),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_run_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999),
  run_trigger                 TEXT NOT NULL CONSTRAINT ck_run_run_trigger CHECK (run_trigger IN ('manual', 'auto')),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_run_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  created_at                  TEXT NOT NULL CONSTRAINT ck_run_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  upload_expires_at           TEXT NOT NULL CONSTRAINT ck_run_upload_expires_at CHECK (typeof(upload_expires_at) = 'text' AND length(CAST(upload_expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', upload_expires_at) IS upload_expires_at),
  acceptance_state            TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_run_acceptance_state CHECK (acceptance_state IN ('open', 'accepted', 'refused', 'expired', 'aborted')),
  payload_digest              TEXT CONSTRAINT ck_run_payload_digest CHECK (payload_digest IS NULL OR (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*')),
  refusal_code                TEXT CONSTRAINT ck_run_refusal_code CHECK (refusal_code IS NULL OR (refusal_code IN ('payload-invalid', 'payload-digest-mismatch', 'too-large', 'card-data', 'review-quota-exceeded', 'binding-stale', 'sync-disabled', 'source-not-authorized', 'scope-not-in-binding', 'contract-unsupported', 'capture-already-accepted'))),
  accepted_at                 TEXT CONSTRAINT ck_run_accepted_at CHECK (accepted_at IS NULL OR (typeof(accepted_at) = 'text' AND length(CAST(accepted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at)),
  closed_at                   TEXT CONSTRAINT ck_run_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  aborted_at                  TEXT CONSTRAINT ck_run_aborted_at CHECK (aborted_at IS NULL OR (typeof(aborted_at) = 'text' AND length(CAST(aborted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', aborted_at) IS aborted_at)),
  abort_reason                TEXT CONSTRAINT ck_run_abort_reason CHECK (abort_reason IS NULL OR (abort_reason IN ('site-permission-revoked', 'not-signed-in', 'unknown-page-structure', 'certificate-error', 'user-cancelled'))),
  FOREIGN KEY (binding_id, card_account_id) REFERENCES card_source_bindings(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_run_window CHECK ((upload_expires_at > created_at AND (julianday(upload_expires_at) - julianday(created_at)) * 86400.0 <= 600.001) IS TRUE),
  CONSTRAINT ck_run_accepted_shape CHECK (((acceptance_state = 'accepted') = (payload_digest IS NOT NULL) AND (acceptance_state = 'accepted') = (accepted_at IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_run_refused_shape CHECK (((acceptance_state = 'refused') = (refusal_code IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_run_closed_shape CHECK (((acceptance_state = 'open') = (closed_at IS NULL)) IS TRUE),
  CONSTRAINT ck_run_abort_shape CHECK (((aborted_at IS NULL) = (abort_reason IS NULL) AND (acceptance_state <> 'aborted' OR aborted_at IS NOT NULL) AND (aborted_at IS NULL OR acceptance_state IN ('aborted', 'accepted'))) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_runs_client ON card_sync_runs(device_id, client_run_id);
CREATE UNIQUE INDEX idx_card_sync_runs_fk_account ON card_sync_runs(id, card_account_id);
CREATE INDEX idx_card_sync_runs_device_created ON card_sync_runs(device_id, created_at);
CREATE INDEX idx_card_sync_runs_binding ON card_sync_runs(binding_id, created_at);
CREATE INDEX idx_card_sync_runs_open ON card_sync_runs(upload_expires_at) WHERE acceptance_state = 'open';
`,
  '2.8': `-- @block 2.8
CREATE TABLE card_sync_observation_sets (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_set_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'obs_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  origin                      TEXT NOT NULL CONSTRAINT ck_set_origin CHECK (origin IN ('extension', 'file')),
  card_account_id             TEXT NOT NULL,
  issuer                      TEXT NOT NULL CONSTRAINT ck_set_issuer CHECK (issuer IN ('amex', 'chase', 'citi', 'wellsfargo')),
  currency                    TEXT NOT NULL CONSTRAINT ck_set_currency CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  run_id                      TEXT,
  device_id                   TEXT REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  binding_id                  TEXT,
  binding_version             INTEGER CONSTRAINT ck_set_binding_version CHECK (binding_version IS NULL OR (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647)),
  capture_id                  TEXT CONSTRAINT ck_set_capture_id CHECK (capture_id IS NULL OR (typeof(capture_id) = 'text' AND length(CAST(capture_id AS BLOB)) = 36 AND substr(capture_id, 1, 4) = 'cpt_' AND substr(capture_id, 5) NOT GLOB '*[^a-p]*')),
  payload_digest              TEXT CONSTRAINT ck_set_payload_digest CHECK (payload_digest IS NULL OR (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*')),
  contract_version            INTEGER CONSTRAINT ck_set_contract_version CHECK (contract_version IS NULL OR (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)),
  mode                        TEXT CONSTRAINT ck_set_mode CHECK (mode IS NULL OR (mode IN ('isolated-read', 'main-passive', 'dom-passive'))),
  observed_at                 TEXT CONSTRAINT ck_set_observed_at CHECK (observed_at IS NULL OR (typeof(observed_at) = 'text' AND length(CAST(observed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at)),
  owner                       TEXT CONSTRAINT ck_set_owner CHECK (owner IS NULL OR (owner IN ('alex', 'casey', 'joint'))),
  import_batch_id             TEXT,
  file_chunk                  INTEGER CONSTRAINT ck_set_file_chunk CHECK (file_chunk IS NULL OR (file_chunk = CAST(file_chunk AS INTEGER) AND file_chunk BETWEEN 0 AND 4)),
  source                      TEXT NOT NULL CONSTRAINT ck_set_source CHECK (typeof(source) = 'text' AND length(CAST(source AS BLOB)) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9-]*'),
  parser_version              TEXT NOT NULL CONSTRAINT ck_set_parser_version CHECK (typeof(parser_version) = 'text' AND length(CAST(parser_version AS BLOB)) BETWEEN 1 AND 64 AND parser_version GLOB '[A-Za-z0-9]*' AND parser_version NOT GLOB '*[^A-Za-z0-9._@+-]*'),
  authorization_generation    TEXT CONSTRAINT ck_set_authorization_generation CHECK (authorization_generation IS NULL OR (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*')),
  guard_revision              INTEGER NOT NULL CONSTRAINT ck_set_guard_revision CHECK (guard_revision = CAST(guard_revision AS INTEGER) AND guard_revision BETWEEN 1 AND 999),
  accepted_at                 TEXT NOT NULL CONSTRAINT ck_set_accepted_at CHECK (typeof(accepted_at) = 'text' AND length(CAST(accepted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_set_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  state                       TEXT NOT NULL CONSTRAINT ck_set_state CHECK (state IN ('accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed')),
  version                     INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_set_version CHECK (version = CAST(version AS INTEGER) AND version BETWEEN 1 AND 2147483647),
  review_ledger_revision      INTEGER NOT NULL CONSTRAINT ck_set_review_ledger_revision CHECK (review_ledger_revision = CAST(review_ledger_revision AS INTEGER) AND review_ledger_revision BETWEEN 0 AND 2147483647),
  row_count                   INTEGER NOT NULL CONSTRAINT ck_set_row_count CHECK (row_count = CAST(row_count AS INTEGER) AND row_count BETWEEN 0 AND 2000),
  byte_count                  INTEGER NOT NULL CONSTRAINT ck_set_byte_count CHECK (byte_count = CAST(byte_count AS INTEGER) AND byte_count BETWEEN 0 AND 2097152),
  producer_rejected_count     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_producer_rejected_count CHECK (producer_rejected_count = CAST(producer_rejected_count AS INTEGER) AND producer_rejected_count BETWEEN 0 AND 2000),
  statement_present           INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_statement_present CHECK (statement_present IN (0, 1)),
  statement_charges_minor     INTEGER CONSTRAINT ck_set_statement_charges_minor CHECK (statement_charges_minor IS NULL OR (statement_charges_minor = CAST(statement_charges_minor AS INTEGER) AND statement_charges_minor BETWEEN -999999999999 AND 999999999999)),
  statement_credits_minor     INTEGER CONSTRAINT ck_set_statement_credits_minor CHECK (statement_credits_minor IS NULL OR (statement_credits_minor = CAST(statement_credits_minor AS INTEGER) AND statement_credits_minor BETWEEN -999999999999 AND 999999999999)),
  statement_net_minor         INTEGER CONSTRAINT ck_set_statement_net_minor CHECK (statement_net_minor IS NULL OR (statement_net_minor = CAST(statement_net_minor AS INTEGER) AND statement_net_minor BETWEEN -999999999999 AND 999999999999)),
  statement_previous_balance_minor INTEGER CONSTRAINT ck_set_statement_previous_balance_minor CHECK (statement_previous_balance_minor IS NULL OR (statement_previous_balance_minor = CAST(statement_previous_balance_minor AS INTEGER) AND statement_previous_balance_minor BETWEEN -999999999999 AND 999999999999)),
  statement_new_balance_minor INTEGER CONSTRAINT ck_set_statement_new_balance_minor CHECK (statement_new_balance_minor IS NULL OR (statement_new_balance_minor = CAST(statement_new_balance_minor AS INTEGER) AND statement_new_balance_minor BETWEEN -999999999999 AND 999999999999)),
  open_count                  INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_open_count CHECK (open_count = CAST(open_count AS INTEGER) AND open_count BETWEEN 0 AND 2000),
  inserted_count              INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_inserted_count CHECK (inserted_count = CAST(inserted_count AS INTEGER) AND inserted_count BETWEEN 0 AND 2000),
  updated_count               INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_updated_count CHECK (updated_count = CAST(updated_count AS INTEGER) AND updated_count BETWEEN 0 AND 2000),
  matched_count               INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_matched_count CHECK (matched_count = CAST(matched_count AS INTEGER) AND matched_count BETWEEN 0 AND 2000),
  attributed_count            INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_attributed_count CHECK (attributed_count = CAST(attributed_count AS INTEGER) AND attributed_count BETWEEN 0 AND 2000),
  unchanged_count             INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_unchanged_count CHECK (unchanged_count = CAST(unchanged_count AS INTEGER) AND unchanged_count BETWEEN 0 AND 2000),
  rejected_count              INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_rejected_count CHECK (rejected_count = CAST(rejected_count AS INTEGER) AND rejected_count BETWEEN 0 AND 2000),
  expired_count               INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_expired_count CHECK (expired_count = CAST(expired_count AS INTEGER) AND expired_count BETWEEN 0 AND 2000),
  receipt_state               TEXT NOT NULL CONSTRAINT ck_set_receipt_state CHECK (receipt_state IN ('none', 'kept', 'expired', 'deleted')),
  closed_at                   TEXT CONSTRAINT ck_set_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  close_reason                TEXT CONSTRAINT ck_set_close_reason CHECK (close_reason IS NULL OR (close_reason IN ('committed', 'discarded', 'expired'))),
  discard_reason              TEXT CONSTRAINT ck_set_discard_reason CHECK (discard_reason IS NULL OR (discard_reason IN ('not-mine', 'wrong-binding', 'duplicate-of-file', 'bad-data', 'other'))),
  closed_by_ref               TEXT CONSTRAINT ck_set_closed_by_ref CHECK (closed_by_ref IS NULL OR (typeof(closed_by_ref) = 'text' AND length(CAST(closed_by_ref AS BLOB)) = 36 AND substr(closed_by_ref, 1, 4) = 'usr_' AND substr(closed_by_ref, 5) NOT GLOB '*[^a-p]*')),
  content_purged_at           TEXT CONSTRAINT ck_set_content_purged_at CHECK (content_purged_at IS NULL OR (typeof(content_purged_at) = 'text' AND length(CAST(content_purged_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', content_purged_at) IS content_purged_at)),
  FOREIGN KEY (card_account_id, issuer, currency) REFERENCES card_accounts(id, issuer, currency) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, card_account_id) REFERENCES card_sync_runs(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (binding_id, card_account_id, source) REFERENCES card_source_bindings(id, card_account_id, source) ON DELETE RESTRICT,
  FOREIGN KEY (source, issuer, mode) REFERENCES card_sync_sources(source, issuer, mode) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, card_account_id) REFERENCES card_import_batches(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_set_extension_shape CHECK ((origin = 'file' OR (run_id IS NOT NULL AND device_id IS NOT NULL AND binding_id IS NOT NULL AND binding_version IS NOT NULL AND capture_id IS NOT NULL AND payload_digest IS NOT NULL AND contract_version IS NOT NULL AND mode IS NOT NULL AND observed_at IS NOT NULL AND authorization_generation IS NOT NULL AND import_batch_id IS NULL AND file_chunk IS NULL AND byte_count >= 2 AND row_count + producer_rejected_count <= 2000 AND receipt_state <> 'none')) IS TRUE),
  CONSTRAINT ck_set_file_shape CHECK ((origin = 'extension' OR (import_batch_id IS NOT NULL AND file_chunk IS NOT NULL AND run_id IS NULL AND device_id IS NULL AND binding_id IS NULL AND binding_version IS NULL AND capture_id IS NULL AND payload_digest IS NULL AND contract_version IS NULL AND mode IS NULL AND observed_at IS NULL AND authorization_generation IS NULL AND owner IS NULL AND statement_present = 0 AND byte_count = 0 AND producer_rejected_count = 0 AND receipt_state = 'none' AND row_count >= 1 AND state IN ('needs-review', 'committed', 'rejected', 'expired-unreviewed'))) IS TRUE),
  CONSTRAINT ck_set_statement_shape CHECK ((statement_present = 1 OR (statement_charges_minor IS NULL AND statement_credits_minor IS NULL AND statement_net_minor IS NULL AND statement_previous_balance_minor IS NULL AND statement_new_balance_minor IS NULL)) IS TRUE),
  CONSTRAINT ck_set_window CHECK ((expires_at > accepted_at AND julianday(expires_at) - julianday(accepted_at) <= 90.0) IS TRUE),
  CONSTRAINT ck_set_counts CHECK ((open_count + inserted_count + updated_count + matched_count + attributed_count + unchanged_count + rejected_count + expired_count = row_count) IS TRUE),
  CONSTRAINT ck_set_closed_shape CHECK (((state IN ('committed', 'rejected', 'expired-unreviewed')) = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (close_reason IS NULL) AND (closed_at IS NULL OR open_count = 0)) IS TRUE),
  CONSTRAINT ck_set_close_reason_shape CHECK (((state <> 'committed' OR close_reason = 'committed') AND (state <> 'rejected' OR (close_reason = 'discarded' AND closed_by_ref IS NOT NULL)) AND (state <> 'expired-unreviewed' OR close_reason = 'expired') AND (close_reason IS 'discarded') = (discard_reason IS NOT NULL) AND (closed_by_ref IS NULL OR state IN ('committed', 'rejected'))) IS TRUE),
  CONSTRAINT ck_set_open_rows CHECK ((state IN ('committed', 'rejected', 'expired-unreviewed') OR expired_count = 0) IS TRUE),
  CONSTRAINT ck_set_purged CHECK ((content_purged_at IS NULL OR closed_at IS NOT NULL) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_observation_sets_fk_origin ON card_sync_observation_sets(id, origin);
CREATE UNIQUE INDEX idx_card_sync_observation_sets_fk_account ON card_sync_observation_sets(id, card_account_id);
CREATE UNIQUE INDEX idx_card_sync_observation_sets_run ON card_sync_observation_sets(run_id);
CREATE UNIQUE INDEX idx_card_sync_observation_sets_capture ON card_sync_observation_sets(capture_id);
CREATE UNIQUE INDEX idx_card_sync_observation_sets_batch_chunk ON card_sync_observation_sets(import_batch_id, file_chunk);
CREATE INDEX idx_card_sync_observation_sets_state ON card_sync_observation_sets(state, expires_at);
CREATE INDEX idx_card_sync_observation_sets_account ON card_sync_observation_sets(card_account_id, state);
CREATE INDEX idx_card_sync_observation_sets_device ON card_sync_observation_sets(device_id, state);
CREATE INDEX idx_card_sync_observation_sets_binding ON card_sync_observation_sets(binding_id, state);

-- @block 2.8
CREATE TABLE card_sync_set_card_hints (
  observation_set_id          TEXT NOT NULL,
  origin                      TEXT NOT NULL CONSTRAINT ck_hint_origin CHECK (origin = 'extension'),
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_hint_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 0 AND 19),
  last4                       TEXT NOT NULL CONSTRAINT ck_hint_last4 CHECK (typeof(last4) = 'text' AND length(CAST(last4 AS BLOB)) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]'),
  CONSTRAINT pk_card_sync_set_card_hints PRIMARY KEY (observation_set_id, ordinal),
  FOREIGN KEY (observation_set_id, origin) REFERENCES card_sync_observation_sets(id, origin) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_card_sync_set_card_hints_last4 ON card_sync_set_card_hints(observation_set_id, last4);

-- @block 2.8
CREATE TABLE card_source_observations (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_obs_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-obsrow-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  observation_set_id          TEXT NOT NULL,
  origin                      TEXT NOT NULL CONSTRAINT ck_obs_origin CHECK (origin IN ('extension', 'file')),
  card_account_id             TEXT NOT NULL,
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_obs_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 0 AND 1999),
  file_row_index              INTEGER CONSTRAINT ck_obs_file_row_index CHECK (file_row_index IS NULL OR (file_row_index = CAST(file_row_index AS INTEGER) AND file_row_index BETWEEN 0 AND 9999)),
  source_scope_id             TEXT NOT NULL,
  source_scope_kind           TEXT NOT NULL CONSTRAINT ck_obs_source_scope_kind CHECK (source_scope_kind IN ('known', 'unknown', 'legacy')),
  identity_namespace          TEXT NOT NULL,
  namespace_kind              TEXT NOT NULL CONSTRAINT ck_obs_namespace_kind CHECK (namespace_kind IN ('legacy-file', 'stable', 'capture')),
  external_id_hash            TEXT CONSTRAINT ck_obs_external_id_hash CHECK (external_id_hash IS NULL OR (typeof(external_id_hash) = 'text' AND length(CAST(external_id_hash AS BLOB)) = 69 AND substr(external_id_hash, 1, 5) = 'xid1:' AND substr(external_id_hash, 6) NOT GLOB '*[^a-p]*')),
  fingerprint                 TEXT CONSTRAINT ck_obs_fingerprint CHECK (fingerprint IS NULL OR (typeof(fingerprint) = 'text' AND length(CAST(fingerprint AS BLOB)) = 69 AND substr(fingerprint, 1, 5) = 'cfp1:' AND substr(fingerprint, 6) NOT GLOB '*[^a-p]*')),
  identity_hash               TEXT NOT NULL CONSTRAINT ck_obs_identity_hash CHECK (typeof(identity_hash) = 'text' AND length(CAST(identity_hash AS BLOB)) = 69 AND substr(identity_hash, 1, 5) IN ('xid1:', 'cfp1:', 'ccf1:') AND substr(identity_hash, 6) NOT GLOB '*[^a-p]*'),
  transaction_date            TEXT NOT NULL CONSTRAINT ck_obs_transaction_date CHECK (typeof(transaction_date) = 'text' AND length(CAST(transaction_date AS BLOB)) = 10 AND date(transaction_date) IS transaction_date),
  posted_date                 TEXT CONSTRAINT ck_obs_posted_date CHECK (posted_date IS NULL OR (typeof(posted_date) = 'text' AND length(CAST(posted_date AS BLOB)) = 10 AND date(posted_date) IS posted_date)),
  status                      TEXT NOT NULL CONSTRAINT ck_obs_status CHECK (status IN ('pending', 'posted')),
  amount_minor                INTEGER NOT NULL CONSTRAINT ck_obs_amount_minor CHECK (amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND 999999999999),
  currency                    TEXT NOT NULL CONSTRAINT ck_obs_currency CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  original_amount_minor       INTEGER CONSTRAINT ck_obs_original_amount_minor CHECK (original_amount_minor IS NULL OR (original_amount_minor = CAST(original_amount_minor AS INTEGER) AND original_amount_minor BETWEEN -999999999999 AND 999999999999)),
  original_currency           TEXT CONSTRAINT ck_obs_original_currency CHECK (original_currency IS NULL OR (typeof(original_currency) = 'text' AND length(CAST(original_currency AS BLOB)) = 3 AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  kind                        TEXT NOT NULL CONSTRAINT ck_obs_kind CHECK (kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other')),
  description                 TEXT NOT NULL CONSTRAINT ck_obs_description CHECK (typeof(description) = 'text' AND length(description) BETWEEN 1 AND 500),
  merchant                    TEXT CONSTRAINT ck_obs_merchant CHECK (merchant IS NULL OR (typeof(merchant) = 'text' AND length(merchant) BETWEEN 1 AND 200)),
  issuer_category             TEXT CONSTRAINT ck_obs_issuer_category CHECK (issuer_category IS NULL OR (typeof(issuer_category) = 'text' AND length(issuer_category) BETWEEN 1 AND 100)),
  content_digest              TEXT NOT NULL CONSTRAINT ck_obs_content_digest CHECK (typeof(content_digest) = 'text' AND length(CAST(content_digest AS BLOB)) = 69 AND substr(content_digest, 1, 5) = 'rcd1:' AND substr(content_digest, 6) NOT GLOB '*[^a-p]*'),
  state                       TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_obs_state CHECK (state IN ('open', 'resolved', 'rejected', 'expired')),
  outcome                     TEXT CONSTRAINT ck_obs_outcome CHECK (outcome IS NULL OR (outcome IN ('inserted', 'updated', 'matched', 'attributed', 'unchanged'))),
  resolved_transaction_id     TEXT,
  provenance                  INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_obs_provenance CHECK (provenance IN (0, 1)),
  resolved_plan_id            TEXT CONSTRAINT ck_obs_resolved_plan_id CHECK (resolved_plan_id IS NULL OR (typeof(resolved_plan_id) = 'text' AND length(CAST(resolved_plan_id AS BLOB)) = 36 AND substr(resolved_plan_id, 1, 4) = 'prv_' AND substr(resolved_plan_id, 5) NOT GLOB '*[^a-p]*')),
  resolved_at                 TEXT CONSTRAINT ck_obs_resolved_at CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'text' AND length(CAST(resolved_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at)),
  FOREIGN KEY (observation_set_id, origin) REFERENCES card_sync_observation_sets(id, origin) ON DELETE RESTRICT,
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_scope_id, card_account_id, source_scope_kind) REFERENCES card_scopes(id, card_account_id, kind) ON DELETE RESTRICT,
  FOREIGN KEY (identity_namespace, namespace_kind) REFERENCES card_sync_namespaces(namespace, kind) ON DELETE RESTRICT,
  FOREIGN KEY (card_account_id, currency) REFERENCES card_accounts(id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_obs_identity_one CHECK (((external_id_hash IS NULL) <> (fingerprint IS NULL)) IS TRUE),
  CONSTRAINT ck_obs_identity_form CHECK (((namespace_kind = 'stable' AND external_id_hash IS NOT NULL AND identity_hash = external_id_hash) OR (namespace_kind = 'capture' AND fingerprint IS NOT NULL AND substr(identity_hash, 1, 5) = 'ccf1:') OR (namespace_kind = 'legacy-file' AND identity_hash = coalesce(external_id_hash, fingerprint))) IS TRUE),
  CONSTRAINT ck_obs_legacy_pairing CHECK (((namespace_kind = 'legacy-file') = (source_scope_kind = 'legacy') AND (origin = 'file') = (namespace_kind = 'legacy-file') AND (origin = 'file') = (file_row_index IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_obs_original CHECK (((original_amount_minor IS NULL) = (original_currency IS NULL)) IS TRUE),
  CONSTRAINT ck_obs_pending_no_posted_date CHECK ((origin = 'file' OR status = 'posted' OR posted_date IS NULL) IS TRUE),
  CONSTRAINT ck_obs_state_shape CHECK (((state = 'resolved') = (outcome IS NOT NULL) AND (state = 'resolved') = (resolved_transaction_id IS NOT NULL) AND (state = 'open') = (resolved_at IS NULL) AND (resolved_plan_id IS NULL OR state IN ('resolved', 'rejected'))) IS TRUE),
  CONSTRAINT ck_obs_provenance_shape CHECK ((provenance = 0 OR state IN ('resolved', 'rejected')) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_source_observations_ordinal ON card_source_observations(observation_set_id, ordinal);
CREATE INDEX idx_card_source_observations_set_state ON card_source_observations(observation_set_id, state);
CREATE INDEX idx_card_source_observations_identity
  ON card_source_observations(card_account_id, source_scope_id, identity_namespace, identity_hash);
CREATE INDEX idx_card_source_observations_txn ON card_source_observations(resolved_transaction_id);
CREATE UNIQUE INDEX idx_card_source_observations_file_open
  ON card_source_observations(card_account_id, source_scope_id, identity_namespace, identity_hash, content_digest)
  WHERE origin = 'file' AND state = 'open';

-- @block 2.8
CREATE TABLE card_observation_secondary_ids (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_sid_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-obsid-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  observation_id              TEXT NOT NULL REFERENCES card_source_observations(id) ON DELETE CASCADE,
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_sid_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 1 AND 3),
  namespace                   TEXT NOT NULL,
  namespace_kind              TEXT NOT NULL CONSTRAINT ck_sid_namespace_kind CHECK (namespace_kind = 'stable'),
  id_hash                     TEXT NOT NULL CONSTRAINT ck_sid_id_hash CHECK (typeof(id_hash) = 'text' AND length(CAST(id_hash AS BLOB)) = 69 AND substr(id_hash, 1, 5) = 'xid1:' AND substr(id_hash, 6) NOT GLOB '*[^a-p]*'),
  FOREIGN KEY (namespace, namespace_kind) REFERENCES card_sync_namespaces(namespace, kind) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_card_observation_secondary_ids_ordinal ON card_observation_secondary_ids(observation_id, ordinal);
CREATE UNIQUE INDEX idx_card_observation_secondary_ids_namespace ON card_observation_secondary_ids(observation_id, namespace);
`,
  '2.9': `-- @block 2.9
CREATE TABLE card_sync_payload_receipts (
  observation_set_id          TEXT NOT NULL PRIMARY KEY REFERENCES card_sync_observation_sets(id) ON DELETE RESTRICT,
  payload_digest              TEXT NOT NULL CONSTRAINT ck_rcpt_payload_digest CHECK (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*'),
  canonical_json              TEXT NOT NULL CONSTRAINT ck_rcpt_canonical_json CHECK (typeof(canonical_json) = 'text' AND length(CAST(canonical_json AS BLOB)) BETWEEN 2 AND 2097152 AND substr(canonical_json, 1, 1) = '{'),
  byte_length                 INTEGER NOT NULL CONSTRAINT ck_rcpt_byte_length CHECK (byte_length = CAST(byte_length AS INTEGER) AND byte_length BETWEEN 2 AND 2097152),
  accepted_at                 TEXT NOT NULL CONSTRAINT ck_rcpt_accepted_at CHECK (typeof(accepted_at) = 'text' AND length(CAST(accepted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_rcpt_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CONSTRAINT ck_rcpt_length CHECK ((byte_length = length(CAST(canonical_json AS BLOB))) IS TRUE),
  CONSTRAINT ck_rcpt_window CHECK ((expires_at > accepted_at AND julianday(expires_at) - julianday(accepted_at) <= 7.0) IS TRUE)
);
CREATE INDEX idx_card_sync_payload_receipts_expiry ON card_sync_payload_receipts(expires_at);
`,
  '2.10': `-- @block 2.10
CREATE TABLE card_transactions (
  id                     TEXT PRIMARY KEY,
  card_account_id        TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  source                 TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  external_id_hash       TEXT CHECK (external_id_hash IS NULL OR (
    typeof(external_id_hash) = 'text' AND length(CAST(external_id_hash AS BLOB)) = 69
    AND external_id_hash GLOB 'xid[1-9]:*' AND substr(external_id_hash, 6) NOT GLOB '*[^a-p]*')),
  fingerprint            TEXT CHECK (fingerprint IS NULL OR (
    typeof(fingerprint) = 'text' AND length(CAST(fingerprint AS BLOB)) = 69
    AND fingerprint GLOB 'cfp[1-9]:*' AND substr(fingerprint, 6) NOT GLOB '*[^a-p]*')),
  transaction_date       TEXT NOT NULL CHECK (
    typeof(transaction_date) = 'text' AND length(CAST(transaction_date AS BLOB)) = 10
    AND transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  posted_date            TEXT CHECK (posted_date IS NULL OR (
    typeof(posted_date) = 'text' AND length(CAST(posted_date AS BLOB)) = 10
    AND posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'removed')),
  amount_minor           INTEGER NOT NULL CHECK (
    amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND 999999999999),
  currency               TEXT NOT NULL CHECK (
    typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  original_amount_minor  INTEGER CHECK (original_amount_minor IS NULL OR (
    original_amount_minor = CAST(original_amount_minor AS INTEGER)
    AND original_amount_minor BETWEEN -999999999999 AND 999999999999)),
  original_currency      TEXT CHECK (original_currency IS NULL OR (
    typeof(original_currency) = 'text' AND length(CAST(original_currency AS BLOB)) = 3
    AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  kind                   TEXT NOT NULL CHECK (kind IN (
    'purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'
  )),
  description            TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  merchant               TEXT CHECK (merchant IS NULL OR length(merchant) BETWEEN 1 AND 200),
  issuer_category        TEXT CHECK (issuer_category IS NULL OR length(issuer_category) BETWEEN 1 AND 100),
  user_category          TEXT CHECK (user_category IS NULL OR length(user_category) BETWEEN 1 AND 100),
  notes                  TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  import_batch_id        TEXT REFERENCES card_import_batches(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dismissed_at           TEXT CHECK (dismissed_at IS NULL OR (
    typeof(dismissed_at) = 'text' AND length(dismissed_at) BETWEEN 20 AND 30 AND status = 'removed')),
  card_scope_id               TEXT NOT NULL,
  revision                    INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_txn_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  first_sync_run_id           TEXT REFERENCES card_sync_runs(id) ON DELETE RESTRICT,
  removed_reason              TEXT CONSTRAINT ck_txn_removed_reason CHECK (removed_reason IS NULL OR (removed_reason IN ('dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'legacy'))),
  removed_from_status         TEXT CONSTRAINT ck_txn_removed_from_status CHECK (removed_from_status IS NULL OR (removed_from_status IN ('pending', 'posted'))),
  removed_at                  TEXT CONSTRAINT ck_txn_removed_at CHECK (removed_at IS NULL OR (typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', removed_at) IS removed_at)),
  merged_into_id              TEXT,
  reversal_snapshot_revision  INTEGER CONSTRAINT ck_txn_reversal_snapshot_revision CHECK (reversal_snapshot_revision IS NULL OR (reversal_snapshot_revision = CAST(reversal_snapshot_revision AS INTEGER) AND reversal_snapshot_revision BETWEEN 1 AND 2147483647)),
  CHECK ((external_id_hash IS NULL) <> (fingerprint IS NULL)),
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL)),
  CONSTRAINT ck_txn_provenance_one CHECK ((import_batch_id IS NULL OR first_sync_run_id IS NULL) IS TRUE),
  CONSTRAINT ck_txn_removed_shape CHECK (((status = 'removed') = (removed_reason IS NOT NULL) AND (status = 'removed') = (removed_at IS NOT NULL) AND (status = 'removed' OR (removed_from_status IS NULL AND merged_into_id IS NULL))) IS TRUE),
  CONSTRAINT ck_txn_legacy_reason CHECK (((removed_reason IS 'legacy') = (status = 'removed' AND removed_from_status IS NULL)) IS TRUE),
  CONSTRAINT ck_txn_merge_shape CHECK ((coalesce(removed_reason IN ('superseded', 'settled-into'), 0) = (merged_into_id IS NOT NULL) AND merged_into_id IS NOT id) IS TRUE),
  CONSTRAINT ck_txn_reason_from CHECK ((removed_reason IS NULL OR removed_reason IN ('mistaken-import', 'superseded', 'legacy') OR removed_from_status = 'pending') IS TRUE),
  CONSTRAINT ck_txn_dismissed CHECK (((dismissed_at IS NOT NULL) = (removed_reason IS 'dismissed')) IS TRUE),
  CONSTRAINT ck_txn_reversal_marker CHECK ((reversal_snapshot_revision IS NULL OR (status IN ('pending', 'posted') AND reversal_snapshot_revision < revision)) IS TRUE),
  FOREIGN KEY (card_account_id, currency) REFERENCES card_accounts(id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (card_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (merged_into_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_card_transactions_fk_account ON card_transactions(id, card_account_id);
CREATE INDEX idx_card_transactions_account_date ON card_transactions(card_account_id, transaction_date);
CREATE INDEX idx_card_transactions_batch ON card_transactions(import_batch_id);
CREATE INDEX idx_card_transactions_scope ON card_transactions(card_scope_id);
CREATE INDEX idx_card_transactions_run ON card_transactions(first_sync_run_id);
CREATE INDEX idx_card_transactions_merged ON card_transactions(merged_into_id, removed_at, id);
CREATE INDEX idx_card_transactions_amount ON card_transactions(card_account_id, currency, amount_minor, transaction_date);
`,
  '2.11': `-- @block 2.11
CREATE TABLE card_transaction_versions (
  card_transaction_id         TEXT NOT NULL,
  revision                    INTEGER NOT NULL CONSTRAINT ck_ver_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  card_account_id             TEXT NOT NULL,
  status                      TEXT NOT NULL CONSTRAINT ck_ver_status CHECK (status IN ('pending', 'posted', 'removed')),
  transaction_date            TEXT NOT NULL CONSTRAINT ck_ver_transaction_date CHECK (typeof(transaction_date) = 'text' AND length(CAST(transaction_date AS BLOB)) = 10 AND transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  posted_date                 TEXT CONSTRAINT ck_ver_posted_date CHECK (posted_date IS NULL OR (typeof(posted_date) = 'text' AND length(CAST(posted_date AS BLOB)) = 10 AND posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  amount_minor                INTEGER NOT NULL CONSTRAINT ck_ver_amount_minor CHECK (amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND 999999999999),
  original_amount_minor       INTEGER CONSTRAINT ck_ver_original_amount_minor CHECK (original_amount_minor IS NULL OR (original_amount_minor = CAST(original_amount_minor AS INTEGER) AND original_amount_minor BETWEEN -999999999999 AND 999999999999)),
  original_currency           TEXT CONSTRAINT ck_ver_original_currency CHECK (original_currency IS NULL OR (typeof(original_currency) = 'text' AND length(CAST(original_currency AS BLOB)) = 3 AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  kind                        TEXT NOT NULL CONSTRAINT ck_ver_kind CHECK (kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other')),
  description                 TEXT NOT NULL CONSTRAINT ck_ver_description CHECK (typeof(description) = 'text' AND length(description) BETWEEN 1 AND 500),
  merchant                    TEXT CONSTRAINT ck_ver_merchant CHECK (merchant IS NULL OR (typeof(merchant) = 'text' AND length(merchant) BETWEEN 1 AND 200)),
  issuer_category             TEXT CONSTRAINT ck_ver_issuer_category CHECK (issuer_category IS NULL OR (typeof(issuer_category) = 'text' AND length(issuer_category) BETWEEN 1 AND 100)),
  card_scope_id               TEXT NOT NULL CONSTRAINT ck_ver_card_scope_id CHECK (typeof(card_scope_id) = 'text' AND length(CAST(card_scope_id AS BLOB)) = 36 AND substr(card_scope_id, 1, 4) = 'scp_' AND substr(card_scope_id, 5) NOT GLOB '*[^a-p]*'),
  removed_reason              TEXT CONSTRAINT ck_ver_removed_reason CHECK (removed_reason IS NULL OR (removed_reason IN ('dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'legacy'))),
  removed_from_status         TEXT CONSTRAINT ck_ver_removed_from_status CHECK (removed_from_status IS NULL OR (removed_from_status IN ('pending', 'posted'))),
  removed_at                  TEXT CONSTRAINT ck_ver_removed_at CHECK (removed_at IS NULL OR (typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', removed_at) IS removed_at)),
  merged_into_id              TEXT CONSTRAINT ck_ver_merged_into_id CHECK (merged_into_id IS NULL OR (typeof(merged_into_id) = 'text' AND length(CAST(merged_into_id AS BLOB)) = 41 AND substr(merged_into_id, 1, 9) = 'card-txn-' AND substr(merged_into_id, 10) NOT GLOB '*[^a-p]*')),
  dismissed_at                TEXT CONSTRAINT ck_ver_dismissed_at CHECK (dismissed_at IS NULL OR (typeof(dismissed_at) = 'text' AND length(dismissed_at) BETWEEN 20 AND 30)),
  reversal_snapshot_revision  INTEGER CONSTRAINT ck_ver_reversal_snapshot_revision CHECK (reversal_snapshot_revision IS NULL OR (reversal_snapshot_revision = CAST(reversal_snapshot_revision AS INTEGER) AND reversal_snapshot_revision BETWEEN 1 AND 2147483647)),
  replaced_at                 TEXT NOT NULL CONSTRAINT ck_ver_replaced_at CHECK (typeof(replaced_at) = 'text' AND length(CAST(replaced_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', replaced_at) IS replaced_at),
  CONSTRAINT pk_card_transaction_versions PRIMARY KEY (card_transaction_id, revision),
  FOREIGN KEY (card_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_ver_removed_shape CHECK (((status = 'removed') = (removed_reason IS NOT NULL) AND (status = 'removed') = (removed_at IS NOT NULL)) IS TRUE)
);
`,
  '2.12': `-- @block 2.12
CREATE TABLE card_source_identities (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_ident_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-ident-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL,
  source_scope_id             TEXT NOT NULL,
  source_scope_kind           TEXT NOT NULL CONSTRAINT ck_ident_source_scope_kind CHECK (source_scope_kind IN ('known', 'unknown', 'legacy')),
  namespace                   TEXT NOT NULL,
  namespace_kind              TEXT NOT NULL CONSTRAINT ck_ident_namespace_kind CHECK (namespace_kind IN ('legacy-file', 'stable', 'capture')),
  id_hash                     TEXT NOT NULL CONSTRAINT ck_ident_id_hash CHECK (typeof(id_hash) = 'text' AND length(CAST(id_hash AS BLOB)) = 69 AND substr(id_hash, 1, 5) IN ('xid1:', 'cfp1:', 'ccf1:') AND substr(id_hash, 6) NOT GLOB '*[^a-p]*'),
  canonical_transaction_id    TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_ident_status CHECK (status IN ('active', 'detached')),
  first_seen_status           TEXT NOT NULL CONSTRAINT ck_ident_first_seen_status CHECK (first_seen_status IN ('pending', 'posted')),
  created_origin              TEXT NOT NULL CONSTRAINT ck_ident_created_origin CHECK (created_origin IN ('migration', 'file', 'extension', 'session')),
  import_batch_id             TEXT,
  first_observation_id        TEXT REFERENCES card_source_observations(id) ON DELETE RESTRICT,
  created_at                  TEXT NOT NULL CONSTRAINT ck_ident_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  last_seen_at                TEXT CONSTRAINT ck_ident_last_seen_at CHECK (last_seen_at IS NULL OR (typeof(last_seen_at) = 'text' AND length(CAST(last_seen_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at)),
  last_seen_run_id            TEXT REFERENCES card_sync_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_scope_id, card_account_id, source_scope_kind) REFERENCES card_scopes(id, card_account_id, kind) ON DELETE RESTRICT,
  FOREIGN KEY (namespace, namespace_kind) REFERENCES card_sync_namespaces(namespace, kind) ON DELETE RESTRICT,
  FOREIGN KEY (canonical_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, card_account_id) REFERENCES card_import_batches(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_ident_kind_pairing CHECK (((namespace_kind = 'legacy-file') = (source_scope_kind = 'legacy') AND ((namespace_kind = 'stable' AND substr(id_hash, 1, 5) = 'xid1:') OR (namespace_kind = 'capture' AND substr(id_hash, 1, 5) = 'ccf1:') OR (namespace_kind = 'legacy-file' AND substr(id_hash, 1, 5) IN ('xid1:', 'cfp1:')))) IS TRUE),
  CONSTRAINT ck_ident_origin_shape CHECK (((created_origin <> 'extension' OR first_observation_id IS NOT NULL) AND (created_origin <> 'session' OR first_observation_id IS NOT NULL) AND (created_origin <> 'file' OR import_batch_id IS NOT NULL) AND (created_origin IN ('migration', 'file') OR namespace_kind <> 'legacy-file')) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_source_identities_tuple
  ON card_source_identities(card_account_id, source_scope_id, namespace, id_hash);
CREATE INDEX idx_card_source_identities_canonical ON card_source_identities(canonical_transaction_id, status);
CREATE INDEX idx_card_source_identities_page ON card_source_identities(canonical_transaction_id, created_at, id);
CREATE INDEX idx_card_source_identities_first_observation ON card_source_identities(first_observation_id);
CREATE INDEX idx_card_source_identities_last_seen_run ON card_source_identities(last_seen_run_id);

-- @block 2.12
CREATE TABLE card_identity_contents (
  identity_id                 TEXT NOT NULL REFERENCES card_source_identities(id) ON DELETE RESTRICT,
  content_digest              TEXT NOT NULL CONSTRAINT ck_icont_content_digest CHECK (typeof(content_digest) = 'text' AND length(CAST(content_digest AS BLOB)) = 69 AND substr(content_digest, 1, 5) = 'rcd1:' AND substr(content_digest, 6) NOT GLOB '*[^a-p]*'),
  resolution                  TEXT NOT NULL CONSTRAINT ck_icont_resolution CHECK (resolution IN ('migration-baseline', 'inserted', 'promoted', 'corrected', 'linked', 'matched-current', 'kept-current')),
  recorded_at                 TEXT NOT NULL CONSTRAINT ck_icont_recorded_at CHECK (typeof(recorded_at) = 'text' AND length(CAST(recorded_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at),
  CONSTRAINT pk_card_identity_contents PRIMARY KEY (identity_id, content_digest)
);
`,
  '2.13': `-- @block 2.13
CREATE TABLE card_transaction_events (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_evt_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-event-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  card_transaction_id         TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  event_type                  TEXT NOT NULL CONSTRAINT ck_evt_event_type CHECK (event_type IN ('created', 'promoted', 'corrected', 'identity-linked', 'attributed', 'identity-repointed', 'identity-detached', 'superseded', 'settled-into', 'removed', 'restored', 'reversed', 'user-edited')),
  transaction_revision        INTEGER NOT NULL CONSTRAINT ck_evt_transaction_revision CHECK (transaction_revision = CAST(transaction_revision AS INTEGER) AND transaction_revision BETWEEN 1 AND 2147483647),
  origin                      TEXT NOT NULL CONSTRAINT ck_evt_origin CHECK (origin IN ('file', 'extension', 'session')),
  actor_kind                  TEXT NOT NULL CONSTRAINT ck_evt_actor_kind CHECK (actor_kind IN ('session', 'device', 'system')),
  actor_ref                   TEXT CONSTRAINT ck_evt_actor_ref CHECK (actor_ref IS NULL OR (typeof(actor_ref) = 'text' AND length(CAST(actor_ref AS BLOB)) = 36 AND substr(actor_ref, 1, 4) IN ('usr_', 'dev_') AND substr(actor_ref, 5) NOT GLOB '*[^a-p]*')),
  import_batch_id             TEXT REFERENCES card_import_batches(id) ON DELETE RESTRICT,
  run_id                      TEXT REFERENCES card_sync_runs(id) ON DELETE RESTRICT,
  observation_set_id          TEXT REFERENCES card_sync_observation_sets(id) ON DELETE RESTRICT,
  observation_id              TEXT REFERENCES card_source_observations(id) ON DELETE RESTRICT,
  identity_id                 TEXT REFERENCES card_source_identities(id) ON DELETE RESTRICT,
  plan_id                     TEXT CONSTRAINT ck_evt_plan_id CHECK (plan_id IS NULL OR (typeof(plan_id) = 'text' AND length(CAST(plan_id AS BLOB)) = 36 AND substr(plan_id, 1, 4) = 'prv_' AND substr(plan_id, 5) NOT GLOB '*[^a-p]*')),
  plan_digest                 TEXT CONSTRAINT ck_evt_plan_digest CHECK (plan_digest IS NULL OR (typeof(plan_digest) = 'text' AND length(CAST(plan_digest AS BLOB)) = 68 AND substr(plan_digest, 1, 4) = 'pl1:' AND substr(plan_digest, 5) NOT GLOB '*[^a-p]*')),
  related_transaction_id      TEXT,
  cause_event_id              TEXT REFERENCES card_transaction_events(id) ON DELETE RESTRICT,
  reverses_event_id           TEXT REFERENCES card_transaction_events(id) ON DELETE RESTRICT,
  reason                      TEXT NOT NULL CONSTRAINT ck_evt_reason CHECK (reason IN ('insert', 'dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'pending-posted', 'posted-correction', 'same-transaction', 'alias', 'attribution', 'user-edit', 'restore', 'adjustment', 'maintenance')),
  from_status                 TEXT CONSTRAINT ck_evt_from_status CHECK (from_status IS NULL OR (from_status IN ('pending', 'posted', 'removed'))),
  to_status                   TEXT CONSTRAINT ck_evt_to_status CHECK (to_status IS NULL OR (to_status IN ('pending', 'posted', 'removed'))),
  from_amount_minor           INTEGER CONSTRAINT ck_evt_from_amount_minor CHECK (from_amount_minor IS NULL OR (from_amount_minor = CAST(from_amount_minor AS INTEGER) AND from_amount_minor BETWEEN -999999999999 AND 999999999999)),
  to_amount_minor             INTEGER CONSTRAINT ck_evt_to_amount_minor CHECK (to_amount_minor IS NULL OR (to_amount_minor = CAST(to_amount_minor AS INTEGER) AND to_amount_minor BETWEEN -999999999999 AND 999999999999)),
  from_transaction_date       TEXT CONSTRAINT ck_evt_from_transaction_date CHECK (from_transaction_date IS NULL OR (typeof(from_transaction_date) = 'text' AND length(CAST(from_transaction_date AS BLOB)) = 10 AND from_transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  to_transaction_date         TEXT CONSTRAINT ck_evt_to_transaction_date CHECK (to_transaction_date IS NULL OR (typeof(to_transaction_date) = 'text' AND length(CAST(to_transaction_date AS BLOB)) = 10 AND to_transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  from_posted_date            TEXT CONSTRAINT ck_evt_from_posted_date CHECK (from_posted_date IS NULL OR (typeof(from_posted_date) = 'text' AND length(CAST(from_posted_date AS BLOB)) = 10 AND from_posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  to_posted_date              TEXT CONSTRAINT ck_evt_to_posted_date CHECK (to_posted_date IS NULL OR (typeof(to_posted_date) = 'text' AND length(CAST(to_posted_date AS BLOB)) = 10 AND to_posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  from_kind                   TEXT CONSTRAINT ck_evt_from_kind CHECK (from_kind IS NULL OR (from_kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'))),
  to_kind                     TEXT CONSTRAINT ck_evt_to_kind CHECK (to_kind IS NULL OR (to_kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'))),
  from_scope_id               TEXT CONSTRAINT ck_evt_from_scope_id CHECK (from_scope_id IS NULL OR (typeof(from_scope_id) = 'text' AND length(CAST(from_scope_id AS BLOB)) = 36 AND substr(from_scope_id, 1, 4) = 'scp_' AND substr(from_scope_id, 5) NOT GLOB '*[^a-p]*')),
  to_scope_id                 TEXT CONSTRAINT ck_evt_to_scope_id CHECK (to_scope_id IS NULL OR (typeof(to_scope_id) = 'text' AND length(CAST(to_scope_id AS BLOB)) = 36 AND substr(to_scope_id, 1, 4) = 'scp_' AND substr(to_scope_id, 5) NOT GLOB '*[^a-p]*')),
  from_canonical_id           TEXT CONSTRAINT ck_evt_from_canonical_id CHECK (from_canonical_id IS NULL OR (typeof(from_canonical_id) = 'text' AND length(CAST(from_canonical_id AS BLOB)) = 41 AND substr(from_canonical_id, 1, 9) = 'card-txn-' AND substr(from_canonical_id, 10) NOT GLOB '*[^a-p]*')),
  to_canonical_id             TEXT CONSTRAINT ck_evt_to_canonical_id CHECK (to_canonical_id IS NULL OR (typeof(to_canonical_id) = 'text' AND length(CAST(to_canonical_id AS BLOB)) = 41 AND substr(to_canonical_id, 1, 9) = 'card-txn-' AND substr(to_canonical_id, 10) NOT GLOB '*[^a-p]*')),
  edit_fields                 INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_evt_edit_fields CHECK (edit_fields = CAST(edit_fields AS INTEGER) AND edit_fields BETWEEN 0 AND 3),
  edit_resolution             TEXT CONSTRAINT ck_evt_edit_resolution CHECK (edit_resolution IS NULL OR (edit_resolution IN ('survivor', 'loser-category', 'loser-notes', 'loser-both'))),
  notify                      INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_evt_notify CHECK (notify IN (0, 1)),
  created_at                  TEXT NOT NULL CONSTRAINT ck_evt_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  FOREIGN KEY (card_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_evt_actor CHECK (((actor_kind = 'system') = (actor_ref IS NULL) AND (actor_kind <> 'session' OR substr(actor_ref, 1, 4) = 'usr_') AND (actor_kind <> 'device' OR (substr(actor_ref, 1, 4) = 'dev_' AND origin = 'extension' AND event_type IN ('created', 'promoted', 'identity-linked'))) AND (actor_kind <> 'system' OR origin = 'file')) IS TRUE),
  CONSTRAINT ck_evt_origin_shape CHECK (((origin <> 'file' OR import_batch_id IS NOT NULL OR observation_set_id IS NOT NULL) AND (origin <> 'extension' OR (run_id IS NOT NULL AND observation_set_id IS NOT NULL AND observation_id IS NOT NULL)) AND (origin <> 'session' OR (import_batch_id IS NULL AND run_id IS NULL))) IS TRUE),
  CONSTRAINT ck_evt_created CHECK ((event_type <> 'created' OR (from_status IS NULL AND to_status IN ('pending', 'posted') AND to_amount_minor IS NOT NULL AND to_transaction_date IS NOT NULL AND to_kind IS NOT NULL AND to_scope_id IS NOT NULL AND transaction_revision = 1 AND reason = 'insert')) IS TRUE),
  CONSTRAINT ck_evt_promoted CHECK ((event_type <> 'promoted' OR (from_status IN ('pending', 'removed') AND to_status = 'posted' AND from_amount_minor IS NOT NULL AND to_amount_minor IS NOT NULL AND from_transaction_date IS NOT NULL AND to_transaction_date IS NOT NULL AND from_kind IS NOT NULL AND to_kind IS NOT NULL AND reason IN ('pending-posted', 'same-transaction'))) IS TRUE),
  CONSTRAINT ck_evt_corrected CHECK ((event_type <> 'corrected' OR (from_status IN ('pending', 'posted', 'removed') AND to_status IN ('pending', 'posted') AND from_amount_minor IS NOT NULL AND to_amount_minor IS NOT NULL AND from_transaction_date IS NOT NULL AND to_transaction_date IS NOT NULL AND from_kind IS NOT NULL AND to_kind IS NOT NULL AND reason = 'posted-correction')) IS TRUE),
  CONSTRAINT ck_evt_identity CHECK ((event_type NOT IN ('identity-linked', 'identity-repointed', 'identity-detached') OR identity_id IS NOT NULL) IS TRUE),
  CONSTRAINT ck_evt_linked CHECK ((event_type <> 'identity-linked' OR reason IN ('alias', 'same-transaction', 'pending-posted')) IS TRUE),
  CONSTRAINT ck_evt_repointed CHECK ((event_type <> 'identity-repointed' OR (from_canonical_id IS NOT NULL AND to_canonical_id IS NOT NULL AND to_canonical_id = card_transaction_id AND from_canonical_id <> to_canonical_id AND reason IN ('superseded', 'settled-into', 'adjustment', 'maintenance') AND (cause_event_id IS NOT NULL OR reason IN ('adjustment', 'maintenance')))) IS TRUE),
  CONSTRAINT ck_evt_detached CHECK ((event_type <> 'identity-detached' OR (reason IN ('adjustment', 'maintenance') AND from_canonical_id = card_transaction_id)) IS TRUE),
  CONSTRAINT ck_evt_attributed CHECK ((event_type <> 'attributed' OR (from_scope_id IS NOT NULL AND to_scope_id IS NOT NULL AND from_scope_id <> to_scope_id AND reason IN ('attribution', 'adjustment'))) IS TRUE),
  CONSTRAINT ck_evt_merged CHECK ((event_type NOT IN ('superseded', 'settled-into') OR (related_transaction_id IS NOT NULL AND from_status IN ('pending', 'posted') AND to_status = 'removed' AND reason = event_type)) IS TRUE),
  CONSTRAINT ck_evt_removed CHECK ((event_type <> 'removed' OR (reason IN ('dismissed', 'cancelled', 'mistaken-import') AND from_status IN ('pending', 'posted') AND to_status = 'removed')) IS TRUE),
  CONSTRAINT ck_evt_restored CHECK ((event_type <> 'restored' OR (from_status = 'removed' AND to_status IN ('pending', 'posted') AND reason IN ('restore', 'adjustment', 'maintenance'))) IS TRUE),
  CONSTRAINT ck_evt_reversed CHECK (((event_type = 'reversed') = (reverses_event_id IS NOT NULL) AND (event_type <> 'reversed' OR (reason IN ('adjustment', 'maintenance') AND from_status IS NOT NULL AND to_status IS NOT NULL))) IS TRUE),
  CONSTRAINT ck_evt_user_edit CHECK (((event_type = 'user-edited') = (edit_fields > 0) AND (event_type <> 'user-edited' OR reason = 'user-edit') AND (edit_resolution IS NULL OR event_type IN ('superseded', 'settled-into', 'user-edited'))) IS TRUE),
  CONSTRAINT ck_evt_notify_shape CHECK ((notify = 0 OR event_type IN ('promoted', 'corrected', 'reversed')) IS TRUE),
  CONSTRAINT ck_evt_plan CHECK (((plan_id IS NULL) = (plan_digest IS NULL)) IS TRUE)
);
CREATE INDEX idx_card_transaction_events_txn ON card_transaction_events(card_transaction_id, transaction_revision);
CREATE INDEX idx_card_transaction_events_account ON card_transaction_events(card_account_id, created_at);
CREATE INDEX idx_card_transaction_events_run ON card_transaction_events(run_id);
CREATE INDEX idx_card_transaction_events_set ON card_transaction_events(observation_set_id);
CREATE INDEX idx_card_transaction_events_observation ON card_transaction_events(observation_id);
CREATE INDEX idx_card_transaction_events_identity ON card_transaction_events(identity_id);
CREATE INDEX idx_card_transaction_events_cause ON card_transaction_events(cause_event_id);
CREATE INDEX idx_card_transaction_events_reverses ON card_transaction_events(reverses_event_id);
CREATE INDEX idx_card_transaction_events_history ON card_transaction_events(card_transaction_id, created_at, id);
CREATE INDEX idx_card_transaction_events_moved_away ON card_transaction_events(from_canonical_id, created_at, id)
  WHERE event_type = 'identity-repointed';
`,
  '2.14': `-- @block 2.14
CREATE TABLE card_reconciliation_suggestions (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_rvw_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'rvw_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  observation_set_id          TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  observation_id              TEXT REFERENCES card_source_observations(id) ON DELETE CASCADE,
  category                    TEXT NOT NULL CONSTRAINT ck_rvw_category CHECK (category IN ('cross-source-similar', 'no-stable-id', 'scope-unknown', 'pending-link', 'posted-correction', 'reconciliation-difference')),
  reason                      TEXT NOT NULL CONSTRAINT ck_rvw_reason CHECK (reason IN ('cross-source-similar', 'identity-conflict', 'detached-identity', 'no-stable-id', 'unknown-scope', 'pending-posted', 'pending-may-have-posted', 'removed-hit', 'posted-correction', 'pending-changed', 'statement-mismatch')),
  allowed_actions             INTEGER NOT NULL CONSTRAINT ck_rvw_allowed_actions CHECK (allowed_actions = CAST(allowed_actions AS INTEGER) AND allowed_actions BETWEEN 1 AND 255),
  difference_field            TEXT CONSTRAINT ck_rvw_difference_field CHECK (difference_field IS NULL OR (difference_field IN ('charges', 'credits', 'net', 'new-balance'))),
  expected_minor              INTEGER CONSTRAINT ck_rvw_expected_minor CHECK (expected_minor IS NULL OR (expected_minor = CAST(expected_minor AS INTEGER) AND expected_minor BETWEEN -999999999999 AND 999999999999)),
  actual_minor                INTEGER CONSTRAINT ck_rvw_actual_minor CHECK (actual_minor IS NULL OR (actual_minor = CAST(actual_minor AS INTEGER) AND actual_minor BETWEEN -999999999999 AND 999999999999)),
  status                      TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_rvw_status CHECK (status IN ('open', 'decided', 'committed', 'superseded', 'expired', 'discarded')),
  draft_action                TEXT CONSTRAINT ck_rvw_draft_action CHECK (draft_action IS NULL OR (draft_action IN ('same-transaction', 'attribute-and-link', 'attribute', 'insert-new', 'accept-correction', 'keep-current', 'accept-difference', 'reject-row'))),
  draft_transaction_id        TEXT,
  draft_scope_id              TEXT,
  drafted_by_ref              TEXT CONSTRAINT ck_rvw_drafted_by_ref CHECK (drafted_by_ref IS NULL OR (typeof(drafted_by_ref) = 'text' AND length(CAST(drafted_by_ref AS BLOB)) = 36 AND substr(drafted_by_ref, 1, 4) = 'usr_' AND substr(drafted_by_ref, 5) NOT GLOB '*[^a-p]*')),
  drafted_at                  TEXT CONSTRAINT ck_rvw_drafted_at CHECK (drafted_at IS NULL OR (typeof(drafted_at) = 'text' AND length(CAST(drafted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', drafted_at) IS drafted_at)),
  committed_action            TEXT CONSTRAINT ck_rvw_committed_action CHECK (committed_action IS NULL OR (committed_action IN ('same-transaction', 'attribute-and-link', 'attribute', 'insert-new', 'accept-correction', 'keep-current', 'accept-difference', 'reject-row'))),
  committed_transaction_id    TEXT,
  committed_scope_id          TEXT,
  committed_revision          INTEGER CONSTRAINT ck_rvw_committed_revision CHECK (committed_revision IS NULL OR (committed_revision = CAST(committed_revision AS INTEGER) AND committed_revision BETWEEN 1 AND 2147483647)),
  committed_plan_id           TEXT CONSTRAINT ck_rvw_committed_plan_id CHECK (committed_plan_id IS NULL OR (typeof(committed_plan_id) = 'text' AND length(CAST(committed_plan_id AS BLOB)) = 36 AND substr(committed_plan_id, 1, 4) = 'prv_' AND substr(committed_plan_id, 5) NOT GLOB '*[^a-p]*')),
  committed_at                TEXT CONSTRAINT ck_rvw_committed_at CHECK (committed_at IS NULL OR (typeof(committed_at) = 'text' AND length(CAST(committed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', committed_at) IS committed_at)),
  classified_ledger_revision  INTEGER NOT NULL CONSTRAINT ck_rvw_classified_ledger_revision CHECK (classified_ledger_revision = CAST(classified_ledger_revision AS INTEGER) AND classified_ledger_revision BETWEEN 0 AND 2147483647),
  created_at                  TEXT NOT NULL CONSTRAINT ck_rvw_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_rvw_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (id, draft_transaction_id) REFERENCES card_reconciliation_candidates(review_item_id, transaction_id) ON DELETE RESTRICT,
  FOREIGN KEY (committed_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (draft_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (committed_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_rvw_level CHECK (((observation_id IS NULL) = (category = 'reconciliation-difference') AND (observation_id IS NULL) = (difference_field IS NOT NULL) AND (difference_field IS NULL) = (expected_minor IS NULL) AND (difference_field IS NULL) = (actual_minor IS NULL) AND (difference_field IS NULL OR expected_minor <> actual_minor)) IS TRUE),
  CONSTRAINT ck_rvw_reason_category CHECK (((reason = 'cross-source-similar' AND category = 'cross-source-similar') OR (reason = 'identity-conflict' AND category = 'cross-source-similar') OR (reason = 'detached-identity' AND category = 'cross-source-similar') OR (reason = 'no-stable-id' AND category = 'no-stable-id') OR (reason = 'unknown-scope' AND category = 'scope-unknown') OR (reason = 'pending-posted' AND category = 'pending-link') OR (reason = 'pending-may-have-posted' AND category = 'pending-link') OR (reason = 'removed-hit' AND category = 'pending-link') OR (reason = 'posted-correction' AND category = 'posted-correction') OR (reason = 'pending-changed' AND category = 'posted-correction') OR (reason = 'removed-hit' AND category = 'posted-correction') OR (reason = 'statement-mismatch' AND category = 'reconciliation-difference')) IS TRUE),
  CONSTRAINT ck_rvw_actions_in_category CHECK (((allowed_actions & ~(CASE category WHEN 'cross-source-similar' THEN 139 WHEN 'no-stable-id' THEN 137 WHEN 'scope-unknown' THEN 141 WHEN 'pending-link' THEN 137 WHEN 'posted-correction' THEN 48 WHEN 'reconciliation-difference' THEN 64 END)) = 0) IS TRUE),
  CONSTRAINT ck_rvw_draft_shape CHECK (((draft_action IS NULL) = (drafted_at IS NULL) AND (drafted_at IS NULL) = (drafted_by_ref IS NULL) AND (draft_action IS NULL OR (allowed_actions & (CASE draft_action WHEN 'same-transaction' THEN 1 WHEN 'attribute-and-link' THEN 2 WHEN 'attribute' THEN 4 WHEN 'insert-new' THEN 8 WHEN 'accept-correction' THEN 16 WHEN 'keep-current' THEN 32 WHEN 'accept-difference' THEN 64 WHEN 'reject-row' THEN 128 END)) <> 0) AND coalesce(draft_action IN ('same-transaction', 'attribute-and-link'), 0) = (draft_transaction_id IS NOT NULL) AND coalesce(draft_action = 'attribute', 0) <= (draft_scope_id IS NOT NULL) AND (draft_scope_id IS NULL OR draft_action IN ('attribute', 'attribute-and-link'))) IS TRUE),
  CONSTRAINT ck_rvw_committed_shape CHECK (((committed_action IS NULL) = (committed_at IS NULL) AND (committed_action IS NULL) = (committed_plan_id IS NULL) AND (committed_action IS NULL OR (allowed_actions & (CASE committed_action WHEN 'same-transaction' THEN 1 WHEN 'attribute-and-link' THEN 2 WHEN 'attribute' THEN 4 WHEN 'insert-new' THEN 8 WHEN 'accept-correction' THEN 16 WHEN 'keep-current' THEN 32 WHEN 'accept-difference' THEN 64 WHEN 'reject-row' THEN 128 END)) <> 0) AND (committed_action IS NULL OR committed_action IN ('reject-row', 'accept-difference')) = (committed_transaction_id IS NULL) AND (committed_transaction_id IS NULL) = (committed_revision IS NULL) AND (committed_scope_id IS NULL OR committed_action IN ('attribute', 'attribute-and-link')) AND coalesce(committed_action = 'attribute', 0) <= (committed_scope_id IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_rvw_status_shape CHECK (((status <> 'open' OR (draft_action IS NULL AND committed_action IS NULL)) AND (status = 'decided') = (draft_action IS NOT NULL) AND (status <> 'committed' OR committed_action IS NOT NULL) AND (committed_action IS NULL OR status IN ('committed', 'decided'))) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_reconciliation_suggestions_fk_account ON card_reconciliation_suggestions(id, card_account_id);
CREATE UNIQUE INDEX idx_card_reconciliation_suggestions_observation ON card_reconciliation_suggestions(observation_id);
CREATE UNIQUE INDEX idx_card_reconciliation_suggestions_set_level
  ON card_reconciliation_suggestions(observation_set_id) WHERE observation_id IS NULL;
CREATE INDEX idx_card_reconciliation_suggestions_set ON card_reconciliation_suggestions(observation_set_id, status);
CREATE INDEX idx_card_reconciliation_suggestions_committed ON card_reconciliation_suggestions(committed_transaction_id);

-- @block 2.14
CREATE TABLE card_reconciliation_candidates (
  review_item_id              TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  rank                        INTEGER NOT NULL CONSTRAINT ck_cand_rank CHECK (rank = CAST(rank AS INTEGER) AND rank BETWEEN 1 AND 5),
  transaction_id              TEXT NOT NULL,
  rule                        TEXT NOT NULL CONSTRAINT ck_cand_rule CHECK (rule IN ('identity:v1', 'near-content:v1', 'exact-content:v1')),
  matched_on                  INTEGER NOT NULL CONSTRAINT ck_cand_matched_on CHECK (matched_on = CAST(matched_on AS INTEGER) AND matched_on BETWEEN 0 AND 31),
  blocked_reason              TEXT CONSTRAINT ck_cand_blocked_reason CHECK (blocked_reason IS NULL OR (blocked_reason IN ('different-known-cards'))),
  CONSTRAINT pk_card_reconciliation_candidates PRIMARY KEY (review_item_id, rank),
  FOREIGN KEY (review_item_id, card_account_id) REFERENCES card_reconciliation_suggestions(id, card_account_id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_cand_blocked CHECK ((blocked_reason IS NULL OR rule = 'near-content:v1') IS TRUE)
);
CREATE UNIQUE INDEX idx_card_reconciliation_candidates_target ON card_reconciliation_candidates(review_item_id, transaction_id);
CREATE INDEX idx_card_reconciliation_candidates_transaction ON card_reconciliation_candidates(transaction_id);
`,
  '2.15': `-- @block 2.15
CREATE TABLE card_coverage_windows (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_cov_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-cover-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL,
  card_scope_id               TEXT NOT NULL,
  source_kind                 TEXT NOT NULL CONSTRAINT ck_cov_source_kind CHECK (source_kind IN ('file', 'extension')),
  source                      TEXT NOT NULL CONSTRAINT ck_cov_source CHECK (typeof(source) = 'text' AND length(CAST(source AS BLOB)) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9-]*'),
  import_batch_id             TEXT,
  observation_set_id          TEXT,
  entry_ordinal               INTEGER CONSTRAINT ck_cov_entry_ordinal CHECK (entry_ordinal IS NULL OR (entry_ordinal = CAST(entry_ordinal AS INTEGER) AND entry_ordinal BETWEEN 0 AND 39)),
  status                      TEXT NOT NULL CONSTRAINT ck_cov_status CHECK (status IN ('pending', 'posted', 'any')),
  requested_start             TEXT CONSTRAINT ck_cov_requested_start CHECK (requested_start IS NULL OR (typeof(requested_start) = 'text' AND length(CAST(requested_start AS BLOB)) = 10 AND date(requested_start) IS requested_start)),
  requested_end               TEXT CONSTRAINT ck_cov_requested_end CHECK (requested_end IS NULL OR (typeof(requested_end) = 'text' AND length(CAST(requested_end AS BLOB)) = 10 AND date(requested_end) IS requested_end)),
  requested_basis             TEXT CONSTRAINT ck_cov_requested_basis CHECK (requested_basis IS NULL OR (requested_basis IN ('transaction', 'posted', 'observation', 'posted-or-transaction'))),
  observed_start              TEXT CONSTRAINT ck_cov_observed_start CHECK (observed_start IS NULL OR (typeof(observed_start) = 'text' AND length(CAST(observed_start AS BLOB)) = 10 AND date(observed_start) IS observed_start)),
  observed_end                TEXT CONSTRAINT ck_cov_observed_end CHECK (observed_end IS NULL OR (typeof(observed_end) = 'text' AND length(CAST(observed_end AS BLOB)) = 10 AND date(observed_end) IS observed_end)),
  observed_basis              TEXT CONSTRAINT ck_cov_observed_basis CHECK (observed_basis IS NULL OR (observed_basis IN ('transaction', 'posted', 'observation', 'posted-or-transaction'))),
  claimed_completeness        TEXT NOT NULL CONSTRAINT ck_cov_claimed_completeness CHECK (claimed_completeness IN ('unknown', 'partial', 'complete')),
  verified_completeness       TEXT NOT NULL CONSTRAINT ck_cov_verified_completeness CHECK (verified_completeness IN ('unknown', 'partial', 'complete')),
  termination                 TEXT CONSTRAINT ck_cov_termination CHECK (termination IS NULL OR (termination IN ('end-marker', 'snapshot', 'more-available', 'user-navigation', 'cap', 'repeated-cursor', 'empty-page', 'rate-limited', 'auth-required', 'error', 'not-read'))),
  page_count                  INTEGER CONSTRAINT ck_cov_page_count CHECK (page_count IS NULL OR (page_count = CAST(page_count AS INTEGER) AND page_count BETWEEN 0 AND 100)),
  evidence                    TEXT NOT NULL CONSTRAINT ck_cov_evidence CHECK (evidence IN ('file-declared', 'extension-claimed', 'statement-reconciled')),
  ledger_state                TEXT NOT NULL CONSTRAINT ck_cov_ledger_state CHECK (ledger_state IN ('observed-uncommitted', 'committed', 'expired-unreviewed', 'rejected')),
  observed_at                 TEXT CONSTRAINT ck_cov_observed_at CHECK (observed_at IS NULL OR (typeof(observed_at) = 'text' AND length(CAST(observed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at)),
  recorded_at                 TEXT NOT NULL CONSTRAINT ck_cov_recorded_at CHECK (typeof(recorded_at) = 'text' AND length(CAST(recorded_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_cov_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (card_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, card_account_id) REFERENCES card_import_batches(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_cov_origin CHECK (((source_kind = 'file') = (import_batch_id IS NOT NULL) AND (source_kind = 'extension') = (observation_set_id IS NOT NULL) AND (source_kind = 'extension') = (entry_ordinal IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_cov_file_shape CHECK ((source_kind = 'extension' OR (status = 'any' AND coalesce(requested_basis, 'posted-or-transaction') = 'posted-or-transaction' AND coalesce(observed_basis, 'posted-or-transaction') = 'posted-or-transaction' AND termination IS NULL AND page_count IS NULL AND evidence = 'file-declared' AND observed_at IS NULL AND ledger_state = 'committed' AND claimed_completeness = 'unknown' AND verified_completeness = 'unknown')) IS TRUE),
  CONSTRAINT ck_cov_extension_shape CHECK ((source_kind = 'file' OR (status IN ('pending', 'posted') AND requested_basis IS NOT 'posted-or-transaction' AND observed_basis IS NOT 'posted-or-transaction' AND termination IS NOT NULL AND page_count IS NOT NULL AND evidence IN ('extension-claimed', 'statement-reconciled') AND observed_at IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_cov_requested_shape CHECK (((requested_start IS NULL) = (requested_end IS NULL) AND (requested_start IS NULL) = (requested_basis IS NULL) AND (requested_end IS NULL OR requested_end >= requested_start)) IS TRUE),
  CONSTRAINT ck_cov_observed_shape CHECK (((observed_start IS NULL) = (observed_end IS NULL) AND (observed_start IS NULL) = (observed_basis IS NULL) AND (observed_end IS NULL OR observed_end >= observed_start)) IS TRUE),
  CONSTRAINT ck_cov_completeness CHECK (((CASE verified_completeness WHEN 'unknown' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END) <= (CASE claimed_completeness WHEN 'unknown' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END) AND (claimed_completeness <> 'complete' OR (termination = 'end-marker' AND requested_start IS NOT NULL))) IS TRUE),
  CONSTRAINT ck_cov_observation_basis CHECK ((((requested_basis IS NOT 'observation' AND observed_basis IS NOT 'observation') OR status = 'pending') AND (observed_basis IS NOT 'observation' OR observed_start = observed_end)) IS TRUE),
  CONSTRAINT ck_cov_not_read CHECK ((termination IS NOT 'not-read' OR (page_count = 0 AND observed_start IS NULL)) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_coverage_windows_set_entry ON card_coverage_windows(observation_set_id, entry_ordinal);
CREATE UNIQUE INDEX idx_card_coverage_windows_set_scope ON card_coverage_windows(observation_set_id, card_scope_id, status)
  WHERE observation_set_id IS NOT NULL;
CREATE UNIQUE INDEX idx_card_coverage_windows_batch ON card_coverage_windows(import_batch_id);
CREATE INDEX idx_card_coverage_windows_scope ON card_coverage_windows(card_account_id, card_scope_id, status);
`,
  '2.16': `-- @block 2.16
CREATE TABLE card_sync_commit_plans (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_plan_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'prv_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  plan_kind                   TEXT NOT NULL CONSTRAINT ck_plan_plan_kind CHECK (plan_kind IN ('set', 'adjustment')),
  card_account_id             TEXT NOT NULL,
  observation_set_id          TEXT NOT NULL,
  set_version                 INTEGER NOT NULL CONSTRAINT ck_plan_set_version CHECK (set_version = CAST(set_version AS INTEGER) AND set_version BETWEEN 1 AND 2147483647),
  principal_kind              TEXT NOT NULL CONSTRAINT ck_plan_principal_kind CHECK (principal_kind IN ('device', 'session')),
  device_id                   TEXT REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  actor_ref                   TEXT CONSTRAINT ck_plan_actor_ref CHECK (actor_ref IS NULL OR (typeof(actor_ref) = 'text' AND length(CAST(actor_ref AS BLOB)) = 36 AND substr(actor_ref, 1, 4) = 'usr_' AND substr(actor_ref, 5) NOT GLOB '*[^a-p]*')),
  binding_id                  TEXT,
  binding_version             INTEGER CONSTRAINT ck_plan_binding_version CHECK (binding_version IS NULL OR (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647)),
  payload_digest              TEXT CONSTRAINT ck_plan_payload_digest CHECK (payload_digest IS NULL OR (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*')),
  plan_digest                 TEXT NOT NULL CONSTRAINT ck_plan_plan_digest CHECK (typeof(plan_digest) = 'text' AND length(CAST(plan_digest AS BLOB)) = 68 AND substr(plan_digest, 1, 4) = 'pl1:' AND substr(plan_digest, 5) NOT GLOB '*[^a-p]*'),
  auto_eligible               INTEGER NOT NULL CONSTRAINT ck_plan_auto_eligible CHECK (auto_eligible IN (0, 1)),
  source_reviewed             INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_plan_source_reviewed CHECK (source_reviewed IN (0, 1)),
  action_count                INTEGER NOT NULL CONSTRAINT ck_plan_action_count CHECK (action_count = CAST(action_count AS INTEGER) AND action_count BETWEEN 0 AND 9999),
  count_insert                INTEGER NOT NULL CONSTRAINT ck_plan_count_insert CHECK (count_insert = CAST(count_insert AS INTEGER) AND count_insert BETWEEN 0 AND 9999),
  count_update                INTEGER NOT NULL CONSTRAINT ck_plan_count_update CHECK (count_update = CAST(count_update AS INTEGER) AND count_update BETWEEN 0 AND 9999),
  count_unchanged             INTEGER NOT NULL CONSTRAINT ck_plan_count_unchanged CHECK (count_unchanged = CAST(count_unchanged AS INTEGER) AND count_unchanged BETWEEN 0 AND 9999),
  count_aliased               INTEGER NOT NULL CONSTRAINT ck_plan_count_aliased CHECK (count_aliased = CAST(count_aliased AS INTEGER) AND count_aliased BETWEEN 0 AND 9999),
  count_matched               INTEGER NOT NULL CONSTRAINT ck_plan_count_matched CHECK (count_matched = CAST(count_matched AS INTEGER) AND count_matched BETWEEN 0 AND 9999),
  count_attributed            INTEGER NOT NULL CONSTRAINT ck_plan_count_attributed CHECK (count_attributed = CAST(count_attributed AS INTEGER) AND count_attributed BETWEEN 0 AND 9999),
  count_promoted              INTEGER NOT NULL CONSTRAINT ck_plan_count_promoted CHECK (count_promoted = CAST(count_promoted AS INTEGER) AND count_promoted BETWEEN 0 AND 9999),
  count_corrected             INTEGER NOT NULL CONSTRAINT ck_plan_count_corrected CHECK (count_corrected = CAST(count_corrected AS INTEGER) AND count_corrected BETWEEN 0 AND 9999),
  count_rejected              INTEGER NOT NULL CONSTRAINT ck_plan_count_rejected CHECK (count_rejected = CAST(count_rejected AS INTEGER) AND count_rejected BETWEEN 0 AND 9999),
  count_unmatched             INTEGER NOT NULL CONSTRAINT ck_plan_count_unmatched CHECK (count_unmatched = CAST(count_unmatched AS INTEGER) AND count_unmatched BETWEEN 0 AND 9999),
  count_superseded            INTEGER NOT NULL CONSTRAINT ck_plan_count_superseded CHECK (count_superseded = CAST(count_superseded AS INTEGER) AND count_superseded BETWEEN 0 AND 9999),
  ledger_revision             INTEGER NOT NULL CONSTRAINT ck_plan_ledger_revision CHECK (ledger_revision = CAST(ledger_revision AS INTEGER) AND ledger_revision BETWEEN 0 AND 2147483647),
  policy_revision             INTEGER CONSTRAINT ck_plan_policy_revision CHECK (policy_revision IS NULL OR (policy_revision = CAST(policy_revision AS INTEGER) AND policy_revision BETWEEN 1 AND 2147483647)),
  issuer_policy_revision      INTEGER CONSTRAINT ck_plan_issuer_policy_revision CHECK (issuer_policy_revision IS NULL OR (issuer_policy_revision = CAST(issuer_policy_revision AS INTEGER) AND issuer_policy_revision BETWEEN 1 AND 2147483647)),
  contract_version            INTEGER CONSTRAINT ck_plan_contract_version CHECK (contract_version IS NULL OR (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)),
  guard_revision              INTEGER NOT NULL CONSTRAINT ck_plan_guard_revision CHECK (guard_revision = CAST(guard_revision AS INTEGER) AND guard_revision BETWEEN 1 AND 999),
  authorization_generation    TEXT CONSTRAINT ck_plan_authorization_generation CHECK (authorization_generation IS NULL OR (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_plan_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_plan_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  status                      TEXT NOT NULL DEFAULT 'prepared' CONSTRAINT ck_plan_status CHECK (status IN ('prepared', 'consumed', 'expired', 'cancelled')),
  closed_at                   TEXT CONSTRAINT ck_plan_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  cancel_reason               TEXT CONSTRAINT ck_plan_cancel_reason CHECK (cancel_reason IS NULL OR (cancel_reason IN ('superseded', 'decisions-changed', 'aborted', 'generation-changed', 'paused', 'set-closed', 'device-revoked', 'binding-changed', 'recovery'))),
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (binding_id, card_account_id) REFERENCES card_source_bindings(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_plan_principal CHECK (((principal_kind = 'device') = (device_id IS NOT NULL) AND (principal_kind = 'session') = (actor_ref IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_plan_device_shape CHECK ((principal_kind = 'session' OR (plan_kind = 'set' AND auto_eligible = 1 AND source_reviewed = 0 AND payload_digest IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_plan_session_shape CHECK ((principal_kind = 'device' OR auto_eligible = 0) IS TRUE),
  CONSTRAINT ck_plan_extension_shape CHECK (((binding_id IS NULL) = (binding_version IS NULL) AND (binding_id IS NULL) = (payload_digest IS NULL) AND (payload_digest IS NULL) = (contract_version IS NULL) AND (payload_digest IS NULL) = (issuer_policy_revision IS NULL) AND (payload_digest IS NULL) = (policy_revision IS NULL) AND (payload_digest IS NULL) = (authorization_generation IS NULL)) IS TRUE),
  CONSTRAINT ck_plan_window CHECK ((expires_at > created_at AND (julianday(expires_at) - julianday(created_at)) * 86400.0 <= 600.001) IS TRUE),
  CONSTRAINT ck_plan_status_shape CHECK (((status = 'prepared') = (closed_at IS NULL) AND (status = 'cancelled') = (cancel_reason IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_plan_counts CHECK ((count_insert + count_unchanged + count_aliased + count_matched + count_corrected + count_rejected <= action_count) IS TRUE)
);
CREATE UNIQUE INDEX idx_card_sync_commit_plans_fk_kind ON card_sync_commit_plans(id, card_account_id, plan_kind);
CREATE UNIQUE INDEX idx_card_sync_commit_plans_one_prepared ON card_sync_commit_plans(observation_set_id) WHERE status = 'prepared';
CREATE INDEX idx_card_sync_commit_plans_set ON card_sync_commit_plans(observation_set_id, status);
CREATE INDEX idx_card_sync_commit_plans_device ON card_sync_commit_plans(device_id, status);
CREATE INDEX idx_card_sync_commit_plans_status ON card_sync_commit_plans(status, expires_at);

-- @block 2.16
CREATE TABLE card_sync_plan_actions (
  plan_id                     TEXT NOT NULL,
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_act_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 0 AND 9999),
  card_account_id             TEXT NOT NULL,
  plan_kind                   TEXT NOT NULL CONSTRAINT ck_act_plan_kind CHECK (plan_kind IN ('set', 'adjustment')),
  op                          TEXT NOT NULL CONSTRAINT ck_act_op CHECK (op IN ('insert', 'unchanged', 'alias', 'promote', 'correct', 'match', 'reject', 'accept-difference', 'unmatch', 'restore-attribution', 'revert', 'supersede', 'remove')),
  observation_ordinal         INTEGER CONSTRAINT ck_act_observation_ordinal CHECK (observation_ordinal IS NULL OR (observation_ordinal = CAST(observation_ordinal AS INTEGER) AND observation_ordinal BETWEEN 0 AND 1999)),
  review_item_id              TEXT CONSTRAINT ck_act_review_item_id CHECK (review_item_id IS NULL OR (typeof(review_item_id) = 'text' AND length(CAST(review_item_id AS BLOB)) = 36 AND substr(review_item_id, 1, 4) = 'rvw_' AND substr(review_item_id, 5) NOT GLOB '*[^a-p]*')),
  content_digest              TEXT CONSTRAINT ck_act_content_digest CHECK (content_digest IS NULL OR (typeof(content_digest) = 'text' AND length(CAST(content_digest AS BLOB)) = 69 AND substr(content_digest, 1, 5) = 'rcd1:' AND substr(content_digest, 6) NOT GLOB '*[^a-p]*')),
  transaction_id              TEXT,
  expected_revision           INTEGER CONSTRAINT ck_act_expected_revision CHECK (expected_revision IS NULL OR (expected_revision = CAST(expected_revision AS INTEGER) AND expected_revision BETWEEN 1 AND 2147483647)),
  new_ref                     INTEGER CONSTRAINT ck_act_new_ref CHECK (new_ref IS NULL OR (new_ref = CAST(new_ref AS INTEGER) AND new_ref BETWEEN 0 AND 9999)),
  related_transaction_id      TEXT,
  related_revision            INTEGER CONSTRAINT ck_act_related_revision CHECK (related_revision IS NULL OR (related_revision = CAST(related_revision AS INTEGER) AND related_revision BETWEEN 1 AND 2147483647)),
  scope_id                    TEXT,
  promote                     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_act_promote CHECK (promote IN (0, 1)),
  restore                     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_act_restore CHECK (restore IN (0, 1)),
  identity_count              INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_act_identity_count CHECK (identity_count = CAST(identity_count AS INTEGER) AND identity_count BETWEEN 0 AND 4),
  reverses_event_id           TEXT REFERENCES card_transaction_events(id) ON DELETE RESTRICT,
  CONSTRAINT pk_card_sync_plan_actions PRIMARY KEY (plan_id, ordinal),
  FOREIGN KEY (plan_id, card_account_id, plan_kind) REFERENCES card_sync_commit_plans(id, card_account_id, plan_kind) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_act_kind CHECK (((op IN ('unmatch', 'restore-attribution', 'revert', 'supersede', 'remove')) <= (plan_kind = 'adjustment')) IS TRUE),
  CONSTRAINT ck_act_flags CHECK (((promote = 0 OR op IN ('promote', 'match')) AND (op <> 'promote' OR promote = 1) AND (restore = 0 OR op IN ('promote', 'correct', 'match')) AND (related_revision IS NULL) = (related_transaction_id IS NULL)) IS TRUE),
  CONSTRAINT ck_act_op_insert CHECK ((op <> 'insert' OR (observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND scope_id IS NOT NULL AND transaction_id IS NULL AND expected_revision IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count >= 1)) IS TRUE),
  CONSTRAINT ck_act_op_unchanged CHECK ((op <> 'unchanged' OR (identity_count = 0 AND observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND scope_id IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND ((transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND new_ref IS NULL) OR (transaction_id IS NULL AND expected_revision IS NULL AND new_ref IS NOT NULL AND new_ref < ordinal)))) IS TRUE),
  CONSTRAINT ck_act_op_alias CHECK ((op <> 'alias' OR (identity_count >= 1 AND observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND scope_id IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND ((transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND new_ref IS NULL) OR (transaction_id IS NULL AND expected_revision IS NULL AND new_ref IS NOT NULL AND new_ref < ordinal)))) IS TRUE),
  CONSTRAINT ck_act_op_promote CHECK ((op <> 'promote' OR (observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL)) IS TRUE),
  CONSTRAINT ck_act_op_correct CHECK ((op <> 'correct' OR (observation_ordinal IS NOT NULL AND review_item_id IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_match CHECK ((op <> 'match' OR (observation_ordinal IS NOT NULL AND review_item_id IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count >= 1)) IS TRUE),
  CONSTRAINT ck_act_op_reject CHECK ((op <> 'reject' OR (observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NULL AND expected_revision IS NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_accept_difference CHECK ((op <> 'accept-difference' OR (review_item_id IS NOT NULL AND observation_ordinal IS NULL AND content_digest IS NULL AND transaction_id IS NULL AND expected_revision IS NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_unmatch CHECK ((op <> 'unmatch' OR (observation_ordinal IS NOT NULL AND review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count >= 1 AND (new_ref IS NULL OR new_ref <> ordinal))) IS TRUE),
  CONSTRAINT ck_act_op_restore_attribution CHECK ((op <> 'restore-attribution' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NOT NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_revert CHECK ((op <> 'revert' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND reverses_event_id IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_supersede CHECK ((op <> 'supersede' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND related_transaction_id IS NOT NULL AND related_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND reverses_event_id IS NULL AND transaction_id <> related_transaction_id)) IS TRUE),
  CONSTRAINT ck_act_op_remove CHECK ((op <> 'remove' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE)
);
`,
  '2.17': `-- @block 2.17
CREATE TABLE card_sync_audit_events (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_aud_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-audit-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  event_type                  TEXT NOT NULL CONSTRAINT ck_aud_event_type CHECK (event_type IN ('migration-completed', 'sync-paused', 'sync-resumed', 'policy-changed', 'issuer-enabled', 'issuer-disabled', 'generation-advanced', 'recovery-completed', 'scope-created', 'scope-changed', 'scope-retired', 'binding-created', 'binding-confirmed', 'binding-retired', 'auto-sync-changed', 'pairing-created', 'pairing-redeemed', 'pairing-failed', 'pairing-locked', 'pairing-cancelled', 'pairing-approved', 'pairing-rejected', 'pairing-expired', 'device-revoked', 'device-expired', 'device-regranted', 'run-created', 'run-refused', 'run-aborted', 'run-expired', 'set-accepted', 'set-blocked', 'set-discarded', 'set-expired', 'review-refreshed', 'review-decided', 'plan-prepared', 'plan-committed', 'plan-cancelled', 'receipt-deleted', 'receipt-expired', 'retention-completed', 'ledger-maintenance')),
  actor_kind                  TEXT NOT NULL CONSTRAINT ck_aud_actor_kind CHECK (actor_kind IN ('session', 'device', 'system', 'migration', 'recovery')),
  actor_ref                   TEXT CONSTRAINT ck_aud_actor_ref CHECK (actor_ref IS NULL OR (typeof(actor_ref) = 'text' AND length(CAST(actor_ref AS BLOB)) = 36 AND substr(actor_ref, 1, 4) IN ('usr_', 'dev_') AND substr(actor_ref, 5) NOT GLOB '*[^a-p]*')),
  card_account_id             TEXT CONSTRAINT ck_aud_card_account_id CHECK (card_account_id IS NULL OR (typeof(card_account_id) = 'text' AND length(CAST(card_account_id AS BLOB)) = 42 AND substr(card_account_id, 1, 10) = 'card-acct-' AND substr(card_account_id, 11) NOT GLOB '*[^a-p]*')),
  binding_id                  TEXT CONSTRAINT ck_aud_binding_id CHECK (binding_id IS NULL OR (typeof(binding_id) = 'text' AND length(CAST(binding_id AS BLOB)) = 36 AND substr(binding_id, 1, 4) = 'bnd_' AND substr(binding_id, 5) NOT GLOB '*[^a-p]*')),
  device_id                   TEXT CONSTRAINT ck_aud_device_id CHECK (device_id IS NULL OR (typeof(device_id) = 'text' AND length(CAST(device_id AS BLOB)) = 36 AND substr(device_id, 1, 4) = 'dev_' AND substr(device_id, 5) NOT GLOB '*[^a-p]*')),
  pairing_id                  TEXT CONSTRAINT ck_aud_pairing_id CHECK (pairing_id IS NULL OR (typeof(pairing_id) = 'text' AND length(CAST(pairing_id AS BLOB)) = 36 AND substr(pairing_id, 1, 4) = 'pai_' AND substr(pairing_id, 5) NOT GLOB '*[^a-p]*')),
  run_id                      TEXT CONSTRAINT ck_aud_run_id CHECK (run_id IS NULL OR (typeof(run_id) = 'text' AND length(CAST(run_id AS BLOB)) = 36 AND substr(run_id, 1, 4) = 'run_' AND substr(run_id, 5) NOT GLOB '*[^a-p]*')),
  observation_set_id          TEXT CONSTRAINT ck_aud_observation_set_id CHECK (observation_set_id IS NULL OR (typeof(observation_set_id) = 'text' AND length(CAST(observation_set_id AS BLOB)) = 36 AND substr(observation_set_id, 1, 4) = 'obs_' AND substr(observation_set_id, 5) NOT GLOB '*[^a-p]*')),
  plan_id                     TEXT CONSTRAINT ck_aud_plan_id CHECK (plan_id IS NULL OR (typeof(plan_id) = 'text' AND length(CAST(plan_id AS BLOB)) = 36 AND substr(plan_id, 1, 4) = 'prv_' AND substr(plan_id, 5) NOT GLOB '*[^a-p]*')),
  ledger_event_id             TEXT CONSTRAINT ck_aud_ledger_event_id CHECK (ledger_event_id IS NULL OR (typeof(ledger_event_id) = 'text' AND length(CAST(ledger_event_id AS BLOB)) = 43 AND substr(ledger_event_id, 1, 11) = 'card-event-' AND substr(ledger_event_id, 12) NOT GLOB '*[^a-p]*')),
  code                        TEXT CONSTRAINT ck_aud_code CHECK (code IS NULL OR (typeof(code) = 'text' AND length(CAST(code AS BLOB)) BETWEEN 3 AND 40 AND code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z-]*')),
  version_before              INTEGER CONSTRAINT ck_aud_version_before CHECK (version_before IS NULL OR (version_before = CAST(version_before AS INTEGER) AND version_before BETWEEN 0 AND 2147483647)),
  version_after               INTEGER CONSTRAINT ck_aud_version_after CHECK (version_after IS NULL OR (version_after = CAST(version_after AS INTEGER) AND version_after BETWEEN 0 AND 2147483647)),
  row_count                   INTEGER CONSTRAINT ck_aud_row_count CHECK (row_count IS NULL OR (row_count = CAST(row_count AS INTEGER) AND row_count BETWEEN 0 AND 1000000)),
  byte_count                  INTEGER CONSTRAINT ck_aud_byte_count CHECK (byte_count IS NULL OR (byte_count = CAST(byte_count AS INTEGER) AND byte_count BETWEEN 0 AND 1073741824)),
  item_count                  INTEGER CONSTRAINT ck_aud_item_count CHECK (item_count IS NULL OR (item_count = CAST(item_count AS INTEGER) AND item_count BETWEEN 0 AND 1000000)),
  authorization_generation    TEXT CONSTRAINT ck_aud_authorization_generation CHECK (authorization_generation IS NULL OR (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_aud_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CONSTRAINT ck_aud_actor CHECK (((actor_kind IN ('session', 'device')) = (actor_ref IS NOT NULL) AND (actor_kind <> 'session' OR substr(actor_ref, 1, 4) = 'usr_') AND (actor_kind <> 'device' OR substr(actor_ref, 1, 4) = 'dev_')) IS TRUE),
  CONSTRAINT ck_aud_versions CHECK ((version_before IS NULL OR version_after IS NULL OR version_after >= version_before) IS TRUE),
  CONSTRAINT ck_aud_ledger_event CHECK (((event_type = 'ledger-maintenance') = (ledger_event_id IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_aud_cutoff_shape CHECK ((code IS NOT 'audit-cutoff' OR (event_type = 'retention-completed' AND actor_kind = 'system')) IS TRUE)
);
CREATE INDEX idx_card_sync_audit_events_created ON card_sync_audit_events(created_at);
CREATE INDEX idx_card_sync_audit_events_device ON card_sync_audit_events(device_id, created_at);
CREATE INDEX idx_card_sync_audit_events_set ON card_sync_audit_events(observation_set_id);
CREATE INDEX idx_card_sync_audit_events_type ON card_sync_audit_events(event_type, code, created_at);
`,
  '2.18': `-- @block 2.18
CREATE TABLE card_payment_links (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_link_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 42 AND substr(id, 1, 10) = 'card-link-' AND substr(id, 11) NOT GLOB '*[^a-p]*'),
  card_transaction_id         TEXT NOT NULL REFERENCES card_transactions(id) ON DELETE RESTRICT,
  cash_event_ref              TEXT NOT NULL CONSTRAINT ck_link_cash_event_ref CHECK (typeof(cash_event_ref) = 'text' AND length(CAST(cash_event_ref AS BLOB)) = 69 AND substr(cash_event_ref, 1, 5) = 'cer1:' AND substr(cash_event_ref, 6) NOT GLOB '*[^a-p]*'),
  decision                    TEXT NOT NULL CONSTRAINT ck_link_decision CHECK (decision IN ('confirmed', 'rejected')),
  amount_minor                INTEGER NOT NULL CONSTRAINT ck_link_amount_minor CHECK (amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND -1),
  currency                    TEXT NOT NULL CONSTRAINT ck_link_currency CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  rules_version               INTEGER NOT NULL CONSTRAINT ck_link_rules_version CHECK (rules_version = CAST(rules_version AS INTEGER) AND rules_version BETWEEN 1 AND 999),
  decided_at                  TEXT NOT NULL CONSTRAINT ck_link_decided_at CHECK (typeof(decided_at) = 'text' AND length(CAST(decided_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS decided_at),
  decided_by_ref              TEXT CONSTRAINT ck_link_decided_by_ref CHECK (decided_by_ref IS NULL OR (typeof(decided_by_ref) = 'text' AND length(CAST(decided_by_ref AS BLOB)) = 36 AND substr(decided_by_ref, 1, 4) = 'usr_' AND substr(decided_by_ref, 5) NOT GLOB '*[^a-p]*'))
);
CREATE UNIQUE INDEX idx_card_payment_links_pair ON card_payment_links(card_transaction_id, cash_event_ref);
CREATE UNIQUE INDEX idx_card_payment_links_confirmed_payment ON card_payment_links(card_transaction_id) WHERE decision = 'confirmed';
CREATE UNIQUE INDEX idx_card_payment_links_confirmed_source ON card_payment_links(cash_event_ref) WHERE decision = 'confirmed';
`,
  '2.19': `-- @block 2.19
CREATE TRIGGER trg_card_sync_sources_inv_no_update BEFORE UPDATE ON card_sync_sources
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are immutable'); END;

CREATE TRIGGER trg_card_sync_sources_inv_no_delete BEFORE DELETE ON card_sync_sources
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are never deleted'); END;

CREATE TRIGGER trg_card_sync_sources_inv_no_replace BEFORE INSERT ON card_sync_sources
WHEN EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.source = NEW.source)
  OR EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.source = NEW.source AND x.issuer = NEW.issuer)
  OR EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.source = NEW.source AND x.issuer = NEW.issuer AND x.mode = NEW.mode)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_sources rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_namespaces_inv_no_update BEFORE UPDATE ON card_sync_namespaces
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are immutable'); END;

CREATE TRIGGER trg_card_sync_namespaces_inv_no_delete BEFORE DELETE ON card_sync_namespaces
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are never deleted'); END;

CREATE TRIGGER trg_card_sync_namespaces_inv_no_replace BEFORE INSERT ON card_sync_namespaces
WHEN EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.namespace = NEW.namespace)
  OR EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.namespace = NEW.namespace AND x.kind = NEW.kind)
  OR ((NEW.kind = 'capture') AND EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.source = NEW.source AND x.kind = 'capture'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_namespaces rows are never replaced'); END;

CREATE TRIGGER trg_card_accounts_inv_ledger_revision BEFORE UPDATE OF ledger_revision ON card_accounts
WHEN NEW.ledger_revision < OLD.ledger_revision
BEGIN SELECT RAISE(ABORT, 'card invariant: a ledger revision never decreases'); END;

CREATE TRIGGER trg_card_scopes_inv_update BEFORE UPDATE ON card_scopes
BEGIN
  SELECT CASE
    WHEN OLD.status = 'retired'
      THEN RAISE(ABORT, 'card invariant: a retired card scope never changes')
    WHEN NEW.version IS NOT OLD.version + 1
      THEN RAISE(ABORT, 'card invariant: a card scope version grows by one per update')
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.kind IS NOT OLD.kind OR NEW.last4 IS NOT OLD.last4 OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a card scope keeps its account, kind and card')
  END;
END;

CREATE TRIGGER trg_card_scopes_inv_no_delete BEFORE DELETE ON card_scopes
BEGIN SELECT RAISE(ABORT, 'card invariant: card_scopes rows are never deleted'); END;

CREATE TRIGGER trg_card_scopes_inv_no_replace BEFORE INSERT ON card_scopes
WHEN EXISTS (SELECT 1 FROM card_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_scopes x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_scopes x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_scopes x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id AND x.kind = NEW.kind)
  OR ((NEW.kind = 'legacy') AND EXISTS (SELECT 1 FROM card_scopes x WHERE x.card_account_id = NEW.card_account_id AND x.kind = 'legacy'))
  OR ((NEW.kind = 'unknown') AND EXISTS (SELECT 1 FROM card_scopes x WHERE x.card_account_id = NEW.card_account_id AND x.kind = 'unknown'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_scopes rows are never replaced'); END;

CREATE TRIGGER trg_card_source_bindings_inv_update BEFORE UPDATE ON card_source_bindings
BEGIN
  SELECT CASE
    WHEN OLD.status = 'retired'
      THEN RAISE(ABORT, 'card invariant: a retired binding never changes')
    WHEN NEW.version IS NOT OLD.version AND NEW.version IS NOT OLD.version + 1
      THEN RAISE(ABORT, 'card invariant: a binding version grows by one per update')
    WHEN NEW.version IS OLD.version AND (NEW.label IS NOT OLD.label OR NEW.status IS NOT OLD.status OR NEW.status_reason IS NOT OLD.status_reason OR NEW.confirmed_by_ref IS NOT OLD.confirmed_by_ref OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.retired_at IS NOT OLD.retired_at)
      THEN RAISE(ABORT, 'card invariant: a binding change bumps its version')
    WHEN NEW.auto_sync_revision IS NOT OLD.auto_sync_revision AND NEW.auto_sync_revision IS NOT OLD.auto_sync_revision + 1
      THEN RAISE(ABORT, 'card invariant: an auto-sync revision grows by one per change')
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.issuer IS NOT OLD.issuer OR NEW.currency IS NOT OLD.currency OR NEW.source IS NOT OLD.source OR NEW.source_account_digest IS NOT OLD.source_account_digest OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a binding keeps its account and source')
  END;
END;

CREATE TRIGGER trg_card_source_bindings_inv_no_delete BEFORE DELETE ON card_source_bindings
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_bindings rows are never deleted'); END;

CREATE TRIGGER trg_card_source_bindings_inv_no_replace BEFORE INSERT ON card_source_bindings
WHEN EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id AND x.source = NEW.source)
  OR ((NEW.status <> 'retired') AND EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.card_account_id = NEW.card_account_id AND x.source = NEW.source AND x.status <> 'retired'))
  OR ((NEW.source_account_digest IS NOT NULL AND NEW.status <> 'retired') AND EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.source = NEW.source AND x.source_account_digest = NEW.source_account_digest AND x.source_account_digest IS NOT NULL AND x.status <> 'retired'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_bindings rows are never replaced'); END;

CREATE TRIGGER trg_card_source_binding_scopes_inv_update BEFORE UPDATE ON card_source_binding_scopes
BEGIN
  SELECT CASE
    WHEN OLD.status = 'revoked'
      THEN RAISE(ABORT, 'card invariant: a revoked binding scope never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.card_scope_kind IS NOT OLD.card_scope_kind OR NEW.binding_version IS NOT OLD.binding_version OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a binding scope keeps its binding and card scope')
  END;
END;

CREATE TRIGGER trg_card_source_binding_scopes_inv_no_delete BEFORE DELETE ON card_source_binding_scopes
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_binding_scopes rows are never deleted'); END;

CREATE TRIGGER trg_card_source_binding_scopes_inv_no_replace BEFORE INSERT ON card_source_binding_scopes
WHEN EXISTS (SELECT 1 FROM card_source_binding_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_binding_scopes x WHERE x.id = NEW.id)
  OR ((NEW.status = 'active') AND EXISTS (SELECT 1 FROM card_source_binding_scopes x WHERE x.binding_id = NEW.binding_id AND x.card_scope_id = NEW.card_scope_id AND x.status = 'active'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_binding_scopes rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_policy_inv_update BEFORE UPDATE ON card_sync_policy
BEGIN
  SELECT CASE
    WHEN NEW.revision < OLD.revision OR NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'card invariant: the card sync policy revision never decreases')
  END;
END;

CREATE TRIGGER trg_card_sync_policy_inv_no_delete BEFORE DELETE ON card_sync_policy
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_policy rows are never deleted'); END;

CREATE TRIGGER trg_card_sync_policy_inv_no_replace BEFORE INSERT ON card_sync_policy
WHEN EXISTS (SELECT 1 FROM card_sync_policy x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_policy x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_policy rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_issuer_policy_inv_update BEFORE UPDATE ON card_sync_issuer_policy
BEGIN
  SELECT CASE
    WHEN NEW.revision IS NOT OLD.revision + 1 OR NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'card invariant: an issuer policy revision grows by one per update')
  END;
END;

CREATE TRIGGER trg_card_sync_issuer_policy_inv_no_delete BEFORE DELETE ON card_sync_issuer_policy
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_issuer_policy rows are never deleted'); END;

CREATE TRIGGER trg_card_sync_issuer_policy_inv_no_replace BEFORE INSERT ON card_sync_issuer_policy
WHEN EXISTS (SELECT 1 FROM card_sync_issuer_policy x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_issuer_policy x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_issuer_policy rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_pairings_inv_update BEFORE UPDATE ON card_sync_pairings
BEGIN
  SELECT CASE
    WHEN OLD.status NOT IN ('open', 'redeemed')
      THEN RAISE(ABORT, 'card invariant: a closed pairing never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.created_by_ref IS NOT OLD.created_by_ref OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.replaces_device_id IS NOT OLD.replaces_device_id
      THEN RAISE(ABORT, 'card invariant: a pairing keeps its owner, lifetime and replacement target')
    WHEN NEW.code_digest IS NOT NULL AND NEW.code_digest IS NOT OLD.code_digest
      THEN RAISE(ABORT, 'card invariant: a pairing code is single-use and never replaced')
    WHEN NEW.failed_attempts < OLD.failed_attempts OR (OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS NOT OLD.redeemed_at)
      THEN RAISE(ABORT, 'card invariant: pairing history never goes back')
    WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'open' AND NEW.status IN ('redeemed', 'cancelled', 'expired', 'locked')) OR (OLD.status = 'redeemed' AND NEW.status IN ('approved', 'rejected', 'cancelled', 'expired')))
      THEN RAISE(ABORT, 'card invariant: pairing status change not allowed')
    WHEN NEW.redeemed_at IS NOT OLD.redeemed_at AND NOT (OLD.status = 'open' AND NEW.status = 'redeemed')
      THEN RAISE(ABORT, 'card invariant: a pairing records a redemption only when it is redeemed')
  END;
END;

CREATE TRIGGER trg_card_sync_pairings_inv_no_replace BEFORE INSERT ON card_sync_pairings
WHEN EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.id = NEW.id)
  OR ((NEW.code_digest IS NOT NULL) AND EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.code_digest = NEW.code_digest AND x.code_digest IS NOT NULL))
  OR ((NEW.status = 'open') AND EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.created_by_ref = NEW.created_by_ref AND x.status = 'open'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_pairings rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_pairing_scopes_inv_no_update BEFORE UPDATE ON card_sync_pairing_scopes
BEGIN SELECT RAISE(ABORT, 'card invariant: pairing scopes are frozen at pairing'); END;

CREATE TRIGGER trg_card_sync_pairing_scopes_inv_delete BEFORE DELETE ON card_sync_pairing_scopes
WHEN EXISTS (SELECT 1 FROM card_sync_pairings p WHERE p.id = OLD.pairing_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: pairing scopes are deleted only with their pairing'); END;

CREATE TRIGGER trg_card_sync_pairing_scopes_inv_open BEFORE INSERT ON card_sync_pairing_scopes
WHEN (SELECT p.status FROM card_sync_pairings p WHERE p.id = NEW.pairing_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'card invariant: a pairing chooses its bindings while it is open'); END;

CREATE TRIGGER trg_card_sync_pairing_scopes_inv_no_replace BEFORE INSERT ON card_sync_pairing_scopes
WHEN EXISTS (SELECT 1 FROM card_sync_pairing_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_pairing_scopes x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_pairing_scopes x WHERE x.pairing_id = NEW.pairing_id AND x.binding_id = NEW.binding_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_pairing_scopes rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_devices_inv_update BEFORE UPDATE ON card_sync_devices
BEGIN
  SELECT CASE
    WHEN OLD.status = 'revoked' OR (OLD.status = 'expired' AND NOT coalesce(NEW.status = 'revoked' AND NEW.close_reason IN ('owner', 'password-reset', 'recovery', 'rotated') AND NEW.closed_at IS OLD.closed_at AND NEW.last_used_at IS OLD.last_used_at, 0))
      THEN RAISE(ABORT, 'card invariant: a closed device never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.pairing_id IS NOT OLD.pairing_id OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.label IS NOT OLD.label OR NEW.client_version IS NOT OLD.client_version OR NEW.owner_ref IS NOT OLD.owner_ref OR NEW.created_at IS NOT OLD.created_at OR NEW.pending_expires_at IS NOT OLD.pending_expires_at OR NEW.authorization_generation IS NOT OLD.authorization_generation OR (NOT (OLD.status = 'pending' AND NEW.status = 'active') AND (NEW.expires_at IS NOT OLD.expires_at OR NEW.activated_at IS NOT OLD.activated_at OR NEW.activated_by_ref IS NOT OLD.activated_by_ref))
      THEN RAISE(ABORT, 'card invariant: a device keeps its identity and lifetime')
    WHEN NEW.token_digest IS NOT NULL AND NEW.token_digest IS NOT OLD.token_digest
      THEN RAISE(ABORT, 'card invariant: a device token digest is never replaced')
    WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'revoked', 'expired')) OR (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired')) OR (OLD.status = 'expired' AND NEW.status = 'revoked'))
      THEN RAISE(ABORT, 'card invariant: device status change not allowed')
    WHEN NEW.close_reason IS 'rotated' AND OLD.close_reason IS NOT 'rotated' AND NOT EXISTS (SELECT 1 FROM card_sync_pairings p WHERE p.replaces_device_id = NEW.id AND p.status = 'approved')
      THEN RAISE(ABORT, 'card invariant: a device is rotated only by the approval that replaces it')
  END;
END;

CREATE TRIGGER trg_card_sync_devices_inv_no_replace BEFORE INSERT ON card_sync_devices
WHEN EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.pairing_id = NEW.pairing_id)
  OR ((NEW.token_digest IS NOT NULL) AND EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.token_digest = NEW.token_digest AND x.token_digest IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_devices rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_device_scopes_inv_update BEFORE UPDATE ON card_sync_device_scopes
BEGIN
  SELECT CASE
    WHEN OLD.status = 'revoked'
      THEN RAISE(ABORT, 'card invariant: a revoked device scope never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.device_id IS NOT OLD.device_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.mode IS NOT OLD.mode OR NEW.contract_version IS NOT OLD.contract_version OR NEW.granted_by_ref IS NOT OLD.granted_by_ref OR NEW.granted_at IS NOT OLD.granted_at
      THEN RAISE(ABORT, 'card invariant: a device scope keeps its device, binding and grant')
  END;
END;

CREATE TRIGGER trg_card_sync_device_scopes_inv_no_replace BEFORE INSERT ON card_sync_device_scopes
WHEN EXISTS (SELECT 1 FROM card_sync_device_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_device_scopes x WHERE x.id = NEW.id)
  OR ((NEW.status = 'active') AND EXISTS (SELECT 1 FROM card_sync_device_scopes x WHERE x.device_id = NEW.device_id AND x.binding_id = NEW.binding_id AND x.status = 'active'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_device_scopes rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_runs_inv_update BEFORE UPDATE ON card_sync_runs
BEGIN
  SELECT CASE
    WHEN OLD.acceptance_state IN ('refused', 'expired', 'aborted')
      THEN RAISE(ABORT, 'card invariant: a closed run never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.device_id IS NOT OLD.device_id OR NEW.client_run_id IS NOT OLD.client_run_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.adapter_version IS NOT OLD.adapter_version OR NEW.contract_version IS NOT OLD.contract_version OR NEW.run_trigger IS NOT OLD.run_trigger OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.created_at IS NOT OLD.created_at OR NEW.upload_expires_at IS NOT OLD.upload_expires_at
      THEN RAISE(ABORT, 'card invariant: a run keeps its device, binding and window')
    WHEN OLD.acceptance_state = 'accepted' AND (NEW.acceptance_state IS NOT OLD.acceptance_state OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.closed_at IS NOT OLD.closed_at OR NEW.refusal_code IS NOT OLD.refusal_code OR (OLD.aborted_at IS NOT NULL AND (NEW.aborted_at IS NOT OLD.aborted_at OR NEW.abort_reason IS NOT OLD.abort_reason)))
      THEN RAISE(ABORT, 'card invariant: an accepted run keeps its acceptance')
  END;
END;

CREATE TRIGGER trg_card_sync_runs_inv_no_replace BEFORE INSERT ON card_sync_runs
WHEN EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.device_id = NEW.device_id AND x.client_run_id = NEW.client_run_id)
  OR EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_runs rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_observation_sets_inv_frozen BEFORE UPDATE ON card_sync_observation_sets
WHEN NEW.id IS NOT OLD.id OR NEW.origin IS NOT OLD.origin OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.issuer IS NOT OLD.issuer OR NEW.currency IS NOT OLD.currency OR NEW.run_id IS NOT OLD.run_id OR NEW.device_id IS NOT OLD.device_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.capture_id IS NOT OLD.capture_id OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.contract_version IS NOT OLD.contract_version OR NEW.mode IS NOT OLD.mode OR NEW.observed_at IS NOT OLD.observed_at OR NEW.owner IS NOT OLD.owner OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.file_chunk IS NOT OLD.file_chunk OR NEW.source IS NOT OLD.source OR NEW.parser_version IS NOT OLD.parser_version OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.guard_revision IS NOT OLD.guard_revision OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.row_count IS NOT OLD.row_count OR NEW.byte_count IS NOT OLD.byte_count OR NEW.producer_rejected_count IS NOT OLD.producer_rejected_count OR NEW.statement_present IS NOT OLD.statement_present OR NEW.statement_charges_minor IS NOT OLD.statement_charges_minor OR NEW.statement_credits_minor IS NOT OLD.statement_credits_minor OR NEW.statement_net_minor IS NOT OLD.statement_net_minor OR NEW.statement_previous_balance_minor IS NOT OLD.statement_previous_balance_minor OR NEW.statement_new_balance_minor IS NOT OLD.statement_new_balance_minor
BEGIN SELECT RAISE(ABORT, 'card invariant: an observation set header is immutable'); END;

CREATE TRIGGER trg_card_sync_observation_sets_inv_state BEFORE UPDATE ON card_sync_observation_sets
BEGIN
  SELECT CASE
    WHEN NEW.review_ledger_revision < OLD.review_ledger_revision
      THEN RAISE(ABORT, 'card invariant: a review mark never goes back')
    WHEN NEW.version IS OLD.version AND (NEW.state IS NOT OLD.state OR NEW.open_count IS NOT OLD.open_count OR NEW.inserted_count IS NOT OLD.inserted_count OR NEW.updated_count IS NOT OLD.updated_count OR NEW.matched_count IS NOT OLD.matched_count OR NEW.attributed_count IS NOT OLD.attributed_count OR NEW.unchanged_count IS NOT OLD.unchanged_count OR NEW.rejected_count IS NOT OLD.rejected_count OR NEW.expired_count IS NOT OLD.expired_count OR NEW.receipt_state IS NOT OLD.receipt_state OR NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason OR NEW.discard_reason IS NOT OLD.discard_reason OR NEW.closed_by_ref IS NOT OLD.closed_by_ref OR NEW.content_purged_at IS NOT OLD.content_purged_at)
      THEN RAISE(ABORT, 'card invariant: an observation set version grows by one per change')
    WHEN NEW.version IS NOT OLD.version AND NEW.version IS NOT OLD.version + 1
      THEN RAISE(ABORT, 'card invariant: an observation set version grows by one per change')
    WHEN OLD.state IN ('committed', 'rejected', 'expired-unreviewed') AND (NEW.state IS NOT OLD.state OR NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason OR NEW.discard_reason IS NOT OLD.discard_reason OR NEW.closed_by_ref IS NOT OLD.closed_by_ref)
      THEN RAISE(ABORT, 'card invariant: a closed observation set never reopens')
    WHEN OLD.state IN ('rejected', 'expired-unreviewed') AND (NEW.open_count IS NOT OLD.open_count OR NEW.inserted_count IS NOT OLD.inserted_count OR NEW.updated_count IS NOT OLD.updated_count OR NEW.matched_count IS NOT OLD.matched_count OR NEW.attributed_count IS NOT OLD.attributed_count OR NEW.unchanged_count IS NOT OLD.unchanged_count OR NEW.rejected_count IS NOT OLD.rejected_count OR NEW.expired_count IS NOT OLD.expired_count)
      THEN RAISE(ABORT, 'card invariant: a discarded or expired observation set keeps its outcomes')
    WHEN OLD.content_purged_at IS NOT NULL AND NEW.content_purged_at IS NOT OLD.content_purged_at
      THEN RAISE(ABORT, 'card invariant: purged content stays purged')
    WHEN NEW.receipt_state IS NOT OLD.receipt_state AND NOT (OLD.receipt_state = 'kept' AND NEW.receipt_state IN ('expired', 'deleted'))
      THEN RAISE(ABORT, 'card invariant: a receipt only goes from kept to expired or deleted')
    WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL AND EXISTS (SELECT 1 FROM card_source_observations o WHERE o.observation_set_id = NEW.id AND o.state = 'open')
      THEN RAISE(ABORT, 'card invariant: an observation set closes only after its rows are settled')
    WHEN NEW.state IS NOT OLD.state AND NOT ((OLD.state = 'accepted-uncommitted' AND NEW.state IN ('needs-review', 'blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed')) OR (OLD.state = 'needs-review' AND NEW.state IN ('blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed')) OR (OLD.state = 'blocked-review' AND NEW.state IN ('recovery-review', 'committed', 'rejected', 'expired-unreviewed')) OR (OLD.state = 'recovery-review' AND NEW.state IN ('committed', 'rejected', 'expired-unreviewed')))
      THEN RAISE(ABORT, 'card invariant: observation set state change not allowed')
  END;
END;

CREATE TRIGGER trg_card_sync_observation_sets_inv_delete BEFORE DELETE ON card_sync_observation_sets
WHEN OLD.state NOT IN ('committed', 'rejected', 'expired-unreviewed')
BEGIN SELECT RAISE(ABORT, 'card invariant: only closed observation sets are deleted'); END;

CREATE TRIGGER trg_card_sync_observation_sets_inv_no_replace BEFORE INSERT ON card_sync_observation_sets
WHEN EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.id = NEW.id AND x.origin = NEW.origin)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.capture_id = NEW.capture_id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.import_batch_id = NEW.import_batch_id AND x.file_chunk = NEW.file_chunk)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_observation_sets rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_set_card_hints_inv_no_update BEFORE UPDATE ON card_sync_set_card_hints
BEGIN SELECT RAISE(ABORT, 'card invariant: card hints are frozen at acceptance'); END;

CREATE TRIGGER trg_card_sync_set_card_hints_inv_delete BEFORE DELETE ON card_sync_set_card_hints
WHEN EXISTS (SELECT 1 FROM card_sync_observation_sets s WHERE s.id = OLD.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card hints are deleted only with their set'); END;

CREATE TRIGGER trg_card_sync_set_card_hints_inv_order BEFORE INSERT ON card_sync_set_card_hints
WHEN NEW.ordinal IS NOT (SELECT count(*) FROM card_sync_set_card_hints h WHERE h.observation_set_id = NEW.observation_set_id) OR NEW.last4 <= (SELECT max(h.last4) FROM card_sync_set_card_hints h WHERE h.observation_set_id = NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card hints are sorted, unique and dense'); END;

CREATE TRIGGER trg_card_sync_set_card_hints_inv_no_replace BEFORE INSERT ON card_sync_set_card_hints
WHEN EXISTS (SELECT 1 FROM card_sync_set_card_hints x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_set_card_hints x WHERE x.observation_set_id = NEW.observation_set_id AND x.ordinal = NEW.ordinal)
  OR EXISTS (SELECT 1 FROM card_sync_set_card_hints x WHERE x.observation_set_id = NEW.observation_set_id AND x.last4 = NEW.last4)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_set_card_hints rows are never replaced'); END;

CREATE TRIGGER trg_card_source_observations_inv_update BEFORE UPDATE ON card_source_observations
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.origin IS NOT OLD.origin OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.file_row_index IS NOT OLD.file_row_index OR NEW.source_scope_id IS NOT OLD.source_scope_id OR NEW.source_scope_kind IS NOT OLD.source_scope_kind OR NEW.identity_namespace IS NOT OLD.identity_namespace OR NEW.namespace_kind IS NOT OLD.namespace_kind OR NEW.external_id_hash IS NOT OLD.external_id_hash OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.identity_hash IS NOT OLD.identity_hash OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.status IS NOT OLD.status OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.content_digest IS NOT OLD.content_digest
      THEN RAISE(ABORT, 'card invariant: an observation is immutable')
    WHEN OLD.provenance = 1 AND NEW.provenance = 0
      THEN RAISE(ABORT, 'card invariant: ledger provenance is never dropped')
    WHEN OLD.state = 'expired'
      THEN RAISE(ABORT, 'card invariant: an expired observation never changes')
    WHEN NEW.state IS NOT OLD.state AND NOT ((OLD.state = 'open' AND NEW.state IN ('resolved', 'rejected', 'expired')) OR (OLD.state = 'resolved' AND NEW.state = 'rejected') OR (OLD.state = 'rejected' AND NEW.state = 'resolved'))
      THEN RAISE(ABORT, 'card invariant: observation state change not allowed')
  END;
END;

CREATE TRIGGER trg_card_source_observations_inv_provenance BEFORE DELETE ON card_source_observations
WHEN OLD.provenance = 1
BEGIN SELECT RAISE(ABORT, 'card invariant: ledger provenance is never deleted'); END;

CREATE TRIGGER trg_card_source_observations_inv_no_replace BEFORE INSERT ON card_source_observations
WHEN EXISTS (SELECT 1 FROM card_source_observations x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_observations x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_source_observations x WHERE x.observation_set_id = NEW.observation_set_id AND x.ordinal = NEW.ordinal)
  OR ((NEW.origin = 'file' AND NEW.state = 'open') AND EXISTS (SELECT 1 FROM card_source_observations x WHERE x.card_account_id = NEW.card_account_id AND x.source_scope_id = NEW.source_scope_id AND x.identity_namespace = NEW.identity_namespace AND x.identity_hash = NEW.identity_hash AND x.content_digest = NEW.content_digest AND x.origin = 'file' AND x.state = 'open'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_observations rows are never replaced'); END;

CREATE TRIGGER trg_card_observation_secondary_ids_inv_no_update BEFORE UPDATE ON card_observation_secondary_ids
BEGIN SELECT RAISE(ABORT, 'card invariant: card_observation_secondary_ids rows are append-only'); END;

CREATE TRIGGER trg_card_observation_secondary_ids_inv_delete BEFORE DELETE ON card_observation_secondary_ids
WHEN EXISTS (SELECT 1 FROM card_source_observations o WHERE o.id = OLD.observation_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: secondary ids are deleted only with their observation'); END;

CREATE TRIGGER trg_card_observation_secondary_ids_inv_no_replace BEFORE INSERT ON card_observation_secondary_ids
WHEN EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.observation_id = NEW.observation_id AND x.ordinal = NEW.ordinal)
  OR EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.observation_id = NEW.observation_id AND x.namespace = NEW.namespace)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_observation_secondary_ids rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_payload_receipts_inv_no_update BEFORE UPDATE ON card_sync_payload_receipts
BEGIN SELECT RAISE(ABORT, 'card invariant: a receipt holds the exact accepted bytes'); END;

CREATE TRIGGER trg_card_sync_payload_receipts_inv_delete BEFORE DELETE ON card_sync_payload_receipts
WHEN (SELECT s.receipt_state FROM card_sync_observation_sets s WHERE s.id = OLD.observation_set_id) IS 'kept'
BEGIN SELECT RAISE(ABORT, 'card invariant: a receipt is deleted only after its set gave it up'); END;

CREATE TRIGGER trg_card_sync_payload_receipts_inv_kept BEFORE INSERT ON card_sync_payload_receipts
WHEN (SELECT s.receipt_state FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id) IS NOT 'kept'
BEGIN SELECT RAISE(ABORT, 'card invariant: a receipt is written only for a set that keeps one'); END;

CREATE TRIGGER trg_card_sync_payload_receipts_inv_no_replace BEFORE INSERT ON card_sync_payload_receipts
WHEN EXISTS (SELECT 1 FROM card_sync_payload_receipts x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_payload_receipts x WHERE x.observation_set_id = NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_payload_receipts rows are never replaced'); END;

CREATE TRIGGER trg_card_transactions_inv_insert BEFORE INSERT ON card_transactions
WHEN NEW.status NOT IN ('pending', 'posted') OR NEW.revision IS NOT 1 OR NEW.reversal_snapshot_revision IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: a card transaction starts pending or posted at revision 1'); END;

CREATE TRIGGER trg_card_transactions_inv_update BEFORE UPDATE ON card_transactions
BEGIN
  SELECT CASE
    WHEN NEW.revision IS NOT OLD.revision + 1
      THEN RAISE(ABORT, 'card invariant: a card transaction revision grows by one per update')
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.currency IS NOT OLD.currency OR NEW.source IS NOT OLD.source OR NEW.external_id_hash IS NOT OLD.external_id_hash OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.first_sync_run_id IS NOT OLD.first_sync_run_id OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a card transaction keeps its provenance')
    WHEN OLD.status = 'removed' AND NEW.status = 'removed' AND (NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at)
      THEN RAISE(ABORT, 'card invariant: removal history is frozen while removed')
    WHEN NEW.removed_reason IS 'legacy' AND OLD.removed_reason IS NOT 'legacy' AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: the legacy removal reason is never assigned')
    WHEN OLD.status IN ('pending', 'posted') AND NEW.status = 'removed' AND NEW.removed_from_status IS NOT OLD.status AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: a removal records the status it removed')
    WHEN OLD.status = 'removed' AND NEW.status = 'pending' AND OLD.removed_from_status IS NOT 'pending' AND OLD.removed_reason IS NOT 'legacy'
      THEN RAISE(ABORT, 'card invariant: a removed card transaction returns only to its prior status')
    WHEN OLD.status = 'posted' AND NEW.status = 'pending' AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: a posted card transaction never returns to pending')
    WHEN NEW.reversal_snapshot_revision IS NOT NULL AND NEW.reversal_snapshot_revision IS NOT OLD.reversal_snapshot_revision AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at)) AND (NEW.reversal_snapshot_revision IS NOT OLD.revision OR NOT (NEW.status IS NOT OLD.status OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: a reversal marker names the change that set it')
    WHEN NEW.reversal_snapshot_revision IS NOT NULL AND NEW.reversal_snapshot_revision IS OLD.reversal_snapshot_revision AND (NEW.status IS NOT OLD.status OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at)
      THEN RAISE(ABORT, 'card invariant: a value change replaces or clears the reversal marker')
    WHEN NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS NOT OLD.merged_into_id AND (SELECT t.status FROM card_transactions t WHERE t.id = NEW.merged_into_id) IS NOT 'posted' AND (SELECT t.status FROM card_transactions t WHERE t.id = NEW.merged_into_id) IS NOT 'pending'
      THEN RAISE(ABORT, 'card invariant: a card transaction merges only into a live one')
    WHEN NEW.removed_reason IN ('superseded', 'settled-into') AND NEW.removed_reason IS NOT OLD.removed_reason AND EXISTS (SELECT 1 FROM card_source_identities i WHERE i.canonical_transaction_id = NEW.id AND i.status = 'active')
      THEN RAISE(ABORT, 'card invariant: re-point identities before merging a card transaction')
  END;
END;

CREATE TRIGGER trg_card_transactions_inv_snapshot BEFORE UPDATE ON card_transactions
WHEN NEW.status IS NOT OLD.status OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at
BEGIN
  INSERT INTO card_transaction_versions (card_transaction_id, revision, card_account_id, status, transaction_date, posted_date, amount_minor, original_amount_minor, original_currency, kind, description, merchant, issuer_category, card_scope_id, removed_reason, removed_from_status, removed_at, merged_into_id, dismissed_at, reversal_snapshot_revision, replaced_at)
  SELECT OLD.id, OLD.revision, OLD.card_account_id, OLD.status, OLD.transaction_date, OLD.posted_date, OLD.amount_minor, OLD.original_amount_minor, OLD.original_currency, OLD.kind, OLD.description, OLD.merchant, OLD.issuer_category, OLD.card_scope_id, OLD.removed_reason, OLD.removed_from_status, OLD.removed_at, OLD.merged_into_id, OLD.dismissed_at, OLD.reversal_snapshot_revision, NEW.updated_at
  WHERE NOT EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.revision);
END;

CREATE TRIGGER trg_card_transactions_inv_no_delete BEFORE DELETE ON card_transactions
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transactions rows are never deleted'); END;

CREATE TRIGGER trg_card_transactions_inv_no_replace BEFORE INSERT ON card_transactions
WHEN EXISTS (SELECT 1 FROM card_transactions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_transactions x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_transactions x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transactions rows are never replaced'); END;

CREATE TRIGGER trg_card_transaction_versions_inv_authentic BEFORE INSERT ON card_transaction_versions
WHEN NOT EXISTS (SELECT 1 FROM card_transactions t WHERE t.id = NEW.card_transaction_id AND t.revision = NEW.revision AND t.card_account_id = NEW.card_account_id AND t.status IS NEW.status AND t.transaction_date IS NEW.transaction_date AND t.posted_date IS NEW.posted_date AND t.amount_minor IS NEW.amount_minor AND t.original_amount_minor IS NEW.original_amount_minor AND t.original_currency IS NEW.original_currency AND t.kind IS NEW.kind AND t.description IS NEW.description AND t.merchant IS NEW.merchant AND t.issuer_category IS NEW.issuer_category AND t.card_scope_id IS NEW.card_scope_id AND t.removed_reason IS NEW.removed_reason AND t.removed_from_status IS NEW.removed_from_status AND t.removed_at IS NEW.removed_at AND t.merged_into_id IS NEW.merged_into_id AND t.dismissed_at IS NEW.dismissed_at AND t.reversal_snapshot_revision IS NEW.reversal_snapshot_revision)
BEGIN SELECT RAISE(ABORT, 'card invariant: a snapshot records a card transaction as it is'); END;

CREATE TRIGGER trg_card_transaction_versions_inv_no_update BEFORE UPDATE ON card_transaction_versions
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_versions rows are append-only'); END;

CREATE TRIGGER trg_card_transaction_versions_inv_no_delete BEFORE DELETE ON card_transaction_versions
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_versions rows are never deleted'); END;

CREATE TRIGGER trg_card_transaction_versions_inv_no_replace BEFORE INSERT ON card_transaction_versions
WHEN EXISTS (SELECT 1 FROM card_transaction_versions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_transaction_versions x WHERE x.card_transaction_id = NEW.card_transaction_id AND x.revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_versions rows are never replaced'); END;

CREATE TRIGGER trg_card_source_identities_inv_frozen BEFORE UPDATE ON card_source_identities
WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.source_scope_id IS NOT OLD.source_scope_id OR NEW.source_scope_kind IS NOT OLD.source_scope_kind OR NEW.namespace IS NOT OLD.namespace OR NEW.namespace_kind IS NOT OLD.namespace_kind OR NEW.id_hash IS NOT OLD.id_hash OR NEW.first_seen_status IS NOT OLD.first_seen_status OR NEW.created_origin IS NOT OLD.created_origin OR NEW.created_at IS NOT OLD.created_at OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.first_observation_id IS NOT OLD.first_observation_id
BEGIN SELECT RAISE(ABORT, 'card invariant: a source identity tuple is immutable'); END;

CREATE TRIGGER trg_card_source_identities_inv_target_insert BEFORE INSERT ON card_source_identities
WHEN NEW.status = 'active' AND (SELECT t.removed_reason FROM card_transactions t WHERE t.id = NEW.canonical_transaction_id) IN ('superseded', 'settled-into')
BEGIN SELECT RAISE(ABORT, 'card invariant: an identity never points at a merged card transaction'); END;

CREATE TRIGGER trg_card_source_identities_inv_target_update BEFORE UPDATE OF canonical_transaction_id, status ON card_source_identities
WHEN NEW.status = 'active' AND (SELECT t.removed_reason FROM card_transactions t WHERE t.id = NEW.canonical_transaction_id) IN ('superseded', 'settled-into')
BEGIN SELECT RAISE(ABORT, 'card invariant: an identity never points at a merged card transaction'); END;

CREATE TRIGGER trg_card_source_identities_inv_no_delete BEFORE DELETE ON card_source_identities
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_identities rows are never deleted'); END;

CREATE TRIGGER trg_card_source_identities_inv_no_replace BEFORE INSERT ON card_source_identities
WHEN EXISTS (SELECT 1 FROM card_source_identities x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_identities x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_source_identities x WHERE x.card_account_id = NEW.card_account_id AND x.source_scope_id = NEW.source_scope_id AND x.namespace = NEW.namespace AND x.id_hash = NEW.id_hash)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_identities rows are never replaced'); END;

CREATE TRIGGER trg_card_identity_contents_inv_no_update BEFORE UPDATE ON card_identity_contents
BEGIN SELECT RAISE(ABORT, 'card invariant: card_identity_contents rows are append-only'); END;

CREATE TRIGGER trg_card_identity_contents_inv_no_delete BEFORE DELETE ON card_identity_contents
BEGIN SELECT RAISE(ABORT, 'card invariant: card_identity_contents rows are never deleted'); END;

CREATE TRIGGER trg_card_identity_contents_inv_no_replace BEFORE INSERT ON card_identity_contents
WHEN EXISTS (SELECT 1 FROM card_identity_contents x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_identity_contents x WHERE x.identity_id = NEW.identity_id AND x.content_digest = NEW.content_digest)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_identity_contents rows are never replaced'); END;

CREATE TRIGGER trg_card_transaction_events_inv_no_update BEFORE UPDATE ON card_transaction_events
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_events rows are append-only'); END;

CREATE TRIGGER trg_card_transaction_events_inv_no_delete BEFORE DELETE ON card_transaction_events
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_events rows are never deleted'); END;

CREATE TRIGGER trg_card_transaction_events_inv_no_replace BEFORE INSERT ON card_transaction_events
WHEN EXISTS (SELECT 1 FROM card_transaction_events x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_transaction_events x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_events rows are never replaced'); END;

CREATE TRIGGER trg_card_reconciliation_suggestions_inv_update BEFORE UPDATE ON card_reconciliation_suggestions
BEGIN
  SELECT CASE
    WHEN OLD.status IN ('expired', 'discarded')
      THEN RAISE(ABORT, 'card invariant: a closed review item never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.observation_id IS NOT OLD.observation_id OR NEW.difference_field IS NOT OLD.difference_field OR NEW.expected_minor IS NOT OLD.expected_minor OR NEW.actual_minor IS NOT OLD.actual_minor OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a review item keeps its set and row')
    WHEN OLD.committed_action IS NOT NULL AND (NEW.category IS NOT OLD.category OR NEW.reason IS NOT OLD.reason OR NEW.allowed_actions IS NOT OLD.allowed_actions)
      THEN RAISE(ABORT, 'card invariant: a committed review item keeps its classification')
    WHEN NEW.classified_ledger_revision < OLD.classified_ledger_revision
      THEN RAISE(ABORT, 'card invariant: a review classification never goes back')
    WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'open' AND NEW.status IN ('decided', 'superseded', 'expired', 'discarded')) OR (OLD.status = 'decided' AND NEW.status IN ('open', 'committed', 'superseded', 'expired', 'discarded')) OR (OLD.status = 'committed' AND NEW.status = 'decided') OR (OLD.status = 'superseded' AND NEW.status IN ('open', 'expired', 'discarded')))
      THEN RAISE(ABORT, 'card invariant: review item status change not allowed')
    WHEN NEW.draft_transaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM card_reconciliation_candidates c WHERE c.review_item_id = NEW.id AND c.transaction_id = NEW.draft_transaction_id AND c.blocked_reason IS NOT NULL)
      THEN RAISE(ABORT, 'card invariant: a blocked candidate is never a decision target')
  END;
END;

CREATE TRIGGER trg_card_reconciliation_suggestions_inv_no_replace BEFORE INSERT ON card_reconciliation_suggestions
WHEN EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.observation_id = NEW.observation_id)
  OR ((NEW.observation_id IS NULL) AND EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.observation_set_id = NEW.observation_set_id AND x.observation_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_reconciliation_suggestions rows are never replaced'); END;

CREATE TRIGGER trg_card_reconciliation_suggestions_inv_delete BEFORE DELETE ON card_reconciliation_suggestions
WHEN (OLD.observation_id IS NOT NULL AND EXISTS (SELECT 1 FROM card_source_observations o WHERE o.id = OLD.observation_id))
  OR (OLD.observation_id IS NULL AND (SELECT s.content_purged_at FROM card_sync_observation_sets s WHERE s.id = OLD.observation_set_id) IS NULL)
BEGIN SELECT RAISE(ABORT, 'card invariant: a review item is deleted only with its row or its purged set'); END;

CREATE TRIGGER trg_card_reconciliation_candidates_inv_no_update BEFORE UPDATE ON card_reconciliation_candidates
BEGIN SELECT RAISE(ABORT, 'card invariant: candidates are replaced as a list, never edited'); END;

CREATE TRIGGER trg_card_reconciliation_candidates_inv_no_replace BEFORE INSERT ON card_reconciliation_candidates
WHEN EXISTS (SELECT 1 FROM card_reconciliation_candidates x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_reconciliation_candidates x WHERE x.review_item_id = NEW.review_item_id AND x.rank = NEW.rank)
  OR EXISTS (SELECT 1 FROM card_reconciliation_candidates x WHERE x.review_item_id = NEW.review_item_id AND x.transaction_id = NEW.transaction_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_reconciliation_candidates rows are never replaced'); END;

CREATE TRIGGER trg_card_coverage_windows_inv_update BEFORE UPDATE ON card_coverage_windows
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.source_kind IS NOT OLD.source_kind OR NEW.source IS NOT OLD.source OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.entry_ordinal IS NOT OLD.entry_ordinal OR NEW.status IS NOT OLD.status OR NEW.requested_start IS NOT OLD.requested_start OR NEW.requested_end IS NOT OLD.requested_end OR NEW.requested_basis IS NOT OLD.requested_basis OR NEW.observed_start IS NOT OLD.observed_start OR NEW.observed_end IS NOT OLD.observed_end OR NEW.observed_basis IS NOT OLD.observed_basis OR NEW.claimed_completeness IS NOT OLD.claimed_completeness OR NEW.verified_completeness IS NOT OLD.verified_completeness OR NEW.termination IS NOT OLD.termination OR NEW.page_count IS NOT OLD.page_count OR NEW.evidence IS NOT OLD.evidence OR NEW.observed_at IS NOT OLD.observed_at OR NEW.recorded_at IS NOT OLD.recorded_at
      THEN RAISE(ABORT, 'card invariant: a coverage window records what was observed, once')
    WHEN NEW.ledger_state IS NOT OLD.ledger_state AND NOT (OLD.ledger_state = 'observed-uncommitted' AND NEW.ledger_state IN ('committed', 'expired-unreviewed', 'rejected'))
      THEN RAISE(ABORT, 'card invariant: coverage ledger state change not allowed')
  END;
END;

CREATE TRIGGER trg_card_coverage_windows_inv_delete BEFORE DELETE ON card_coverage_windows
WHEN OLD.ledger_state IN ('committed', 'observed-uncommitted')
BEGIN SELECT RAISE(ABORT, 'card invariant: committed coverage is never deleted'); END;

CREATE TRIGGER trg_card_coverage_windows_inv_no_replace BEFORE INSERT ON card_coverage_windows
WHEN EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.observation_set_id = NEW.observation_set_id AND x.entry_ordinal = NEW.entry_ordinal)
  OR ((NEW.observation_set_id IS NOT NULL) AND EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.observation_set_id = NEW.observation_set_id AND x.card_scope_id = NEW.card_scope_id AND x.status = NEW.status AND x.observation_set_id IS NOT NULL))
  OR EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.import_batch_id = NEW.import_batch_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_coverage_windows rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_commit_plans_inv_update BEFORE UPDATE ON card_sync_commit_plans
BEGIN
  SELECT CASE
    WHEN OLD.status <> 'prepared'
      THEN RAISE(ABORT, 'card invariant: a plan is used at most once')
    WHEN NEW.id IS NOT OLD.id OR NEW.plan_kind IS NOT OLD.plan_kind OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.set_version IS NOT OLD.set_version OR NEW.principal_kind IS NOT OLD.principal_kind OR NEW.device_id IS NOT OLD.device_id OR NEW.actor_ref IS NOT OLD.actor_ref OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.plan_digest IS NOT OLD.plan_digest OR NEW.auto_eligible IS NOT OLD.auto_eligible OR NEW.source_reviewed IS NOT OLD.source_reviewed OR NEW.action_count IS NOT OLD.action_count OR NEW.count_insert IS NOT OLD.count_insert OR NEW.count_update IS NOT OLD.count_update OR NEW.count_unchanged IS NOT OLD.count_unchanged OR NEW.count_aliased IS NOT OLD.count_aliased OR NEW.count_matched IS NOT OLD.count_matched OR NEW.count_attributed IS NOT OLD.count_attributed OR NEW.count_promoted IS NOT OLD.count_promoted OR NEW.count_corrected IS NOT OLD.count_corrected OR NEW.count_rejected IS NOT OLD.count_rejected OR NEW.count_unmatched IS NOT OLD.count_unmatched OR NEW.count_superseded IS NOT OLD.count_superseded OR NEW.ledger_revision IS NOT OLD.ledger_revision OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.issuer_policy_revision IS NOT OLD.issuer_policy_revision OR NEW.contract_version IS NOT OLD.contract_version OR NEW.guard_revision IS NOT OLD.guard_revision OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      THEN RAISE(ABORT, 'card invariant: a prepared plan is immutable')
  END;
END;

CREATE TRIGGER trg_card_sync_commit_plans_inv_expiry BEFORE INSERT ON card_sync_commit_plans
WHEN NEW.expires_at > (SELECT s.expires_at FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: a plan never outlives its observation set'); END;

CREATE TRIGGER trg_card_sync_commit_plans_inv_device BEFORE INSERT ON card_sync_commit_plans
WHEN NEW.principal_kind = 'device'
BEGIN
  SELECT CASE
    WHEN (SELECT s.device_id FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id) IS NOT NEW.device_id
      THEN RAISE(ABORT, 'card invariant: a device plans only its own observation set')
    WHEN (SELECT s.state FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id) IS NOT 'accepted-uncommitted' OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions r WHERE r.observation_set_id = NEW.observation_set_id AND r.status IN ('open', 'decided'))
      THEN RAISE(ABORT, 'card invariant: a device plans only a set that needs no person')
  END;
END;

CREATE TRIGGER trg_card_sync_commit_plans_inv_delete BEFORE DELETE ON card_sync_commit_plans
WHEN OLD.status = 'prepared'
BEGIN SELECT RAISE(ABORT, 'card invariant: a prepared plan is closed before it is deleted'); END;

CREATE TRIGGER trg_card_sync_commit_plans_inv_no_replace BEFORE INSERT ON card_sync_commit_plans
WHEN EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id AND x.plan_kind = NEW.plan_kind)
  OR ((NEW.status = 'prepared') AND EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.observation_set_id = NEW.observation_set_id AND x.status = 'prepared'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_commit_plans rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_plan_actions_inv_no_update BEFORE UPDATE ON card_sync_plan_actions
BEGIN SELECT RAISE(ABORT, 'card invariant: plan actions are frozen with their plan'); END;

CREATE TRIGGER trg_card_sync_plan_actions_inv_delete BEFORE DELETE ON card_sync_plan_actions
WHEN EXISTS (SELECT 1 FROM card_sync_commit_plans p WHERE p.id = OLD.plan_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: plan actions are deleted only with their plan'); END;

CREATE TRIGGER trg_card_sync_plan_actions_inv_prepared BEFORE INSERT ON card_sync_plan_actions
BEGIN
  SELECT CASE
    WHEN (SELECT p.status FROM card_sync_commit_plans p WHERE p.id = NEW.plan_id) IS NOT 'prepared'
      THEN RAISE(ABORT, 'card invariant: actions are written only into a prepared plan')
    WHEN NEW.ordinal >= (SELECT p.action_count FROM card_sync_commit_plans p WHERE p.id = NEW.plan_id)
      THEN RAISE(ABORT, 'card invariant: a plan holds only the actions it declares')
  END;
END;

CREATE TRIGGER trg_card_sync_plan_actions_inv_no_replace BEFORE INSERT ON card_sync_plan_actions
WHEN EXISTS (SELECT 1 FROM card_sync_plan_actions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_plan_actions x WHERE x.plan_id = NEW.plan_id AND x.ordinal = NEW.ordinal)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_plan_actions rows are never replaced'); END;

CREATE TRIGGER trg_card_sync_audit_events_inv_no_update BEFORE UPDATE ON card_sync_audit_events
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_audit_events rows are append-only'); END;

CREATE TRIGGER trg_card_sync_audit_events_inv_delete BEFORE DELETE ON card_sync_audit_events
WHEN NOT EXISTS (SELECT 1 FROM card_sync_audit_events r WHERE r.event_type = 'retention-completed' AND r.code = 'audit-cutoff' AND r.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', OLD.created_at, '+365 days'))
BEGIN SELECT RAISE(ABORT, 'card invariant: audit rows are deleted only by retention, 365 days after them'); END;

CREATE TRIGGER trg_card_sync_audit_events_inv_no_replace BEFORE INSERT ON card_sync_audit_events
WHEN EXISTS (SELECT 1 FROM card_sync_audit_events x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_audit_events x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_audit_events rows are never replaced'); END;

CREATE TRIGGER trg_card_payment_links_inv_payment BEFORE INSERT ON card_payment_links
WHEN NOT EXISTS (SELECT 1 FROM card_transactions t WHERE t.id = NEW.card_transaction_id AND t.kind = 'payment' AND t.status = 'posted' AND t.amount_minor = NEW.amount_minor AND t.currency = NEW.currency)
BEGIN SELECT RAISE(ABORT, 'card invariant: a payment link needs a card payment of that amount and currency'); END;

CREATE TRIGGER trg_card_payment_links_inv_no_update BEFORE UPDATE ON card_payment_links
BEGIN SELECT RAISE(ABORT, 'card invariant: payment link decisions are replaced, never edited'); END;

CREATE TRIGGER trg_card_payment_links_inv_no_replace BEFORE INSERT ON card_payment_links
WHEN EXISTS (SELECT 1 FROM card_payment_links x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_payment_links x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_payment_links x WHERE x.card_transaction_id = NEW.card_transaction_id AND x.cash_event_ref = NEW.cash_event_ref)
  OR ((NEW.decision = 'confirmed') AND EXISTS (SELECT 1 FROM card_payment_links x WHERE x.card_transaction_id = NEW.card_transaction_id AND x.decision = 'confirmed'))
  OR ((NEW.decision = 'confirmed') AND EXISTS (SELECT 1 FROM card_payment_links x WHERE x.cash_event_ref = NEW.cash_event_ref AND x.decision = 'confirmed'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_payment_links rows are never replaced'); END;

CREATE TRIGGER trg_card_accounts_inv_rowid BEFORE UPDATE ON card_accounts
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.created_at IS NULL OR NEW.updated_at IS NULL OR NEW.ledger_revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_accounts rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_import_batches_inv_rowid BEFORE UPDATE ON card_import_batches
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.imported_at IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_import_batches rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_scopes_inv_rowid BEFORE UPDATE ON card_scopes
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.version IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_scopes rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_source_bindings_inv_rowid BEFORE UPDATE ON card_source_bindings
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.version IS NULL OR NEW.auto_sync_revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_bindings rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_source_binding_scopes_inv_rowid BEFORE UPDATE ON card_source_binding_scopes
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_binding_scopes rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_policy_inv_rowid BEFORE UPDATE ON card_sync_policy
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.revision IS NULL OR NEW.paused IS NULL OR NEW.review_retention_days IS NULL OR NEW.receipt_retention_days IS NULL OR NEW.max_runs_per_device_day IS NULL OR NEW.quota_account_sets IS NULL OR NEW.quota_account_rows IS NULL OR NEW.quota_account_bytes IS NULL OR NEW.quota_device_sets IS NULL OR NEW.quota_device_rows IS NULL OR NEW.quota_device_bytes IS NULL OR NEW.quota_global_sets IS NULL OR NEW.quota_global_rows IS NULL OR NEW.quota_global_bytes IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_policy rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_issuer_policy_inv_rowid BEFORE UPDATE ON card_sync_issuer_policy
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.enabled IS NULL OR NEW.main_passive_accepted IS NULL OR NEW.revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_issuer_policy rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_pairings_inv_rowid BEFORE UPDATE ON card_sync_pairings
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.failed_attempts IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_pairings rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_devices_inv_rowid BEFORE UPDATE ON card_sync_devices
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_devices rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_device_scopes_inv_rowid BEFORE UPDATE ON card_sync_device_scopes
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.auto_sync IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_device_scopes rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_runs_inv_rowid BEFORE UPDATE ON card_sync_runs
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.acceptance_state IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_runs rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_observation_sets_inv_rowid BEFORE UPDATE ON card_sync_observation_sets
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.version IS NULL OR NEW.producer_rejected_count IS NULL OR NEW.statement_present IS NULL OR NEW.open_count IS NULL OR NEW.inserted_count IS NULL OR NEW.updated_count IS NULL OR NEW.matched_count IS NULL OR NEW.attributed_count IS NULL OR NEW.unchanged_count IS NULL OR NEW.rejected_count IS NULL OR NEW.expired_count IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_observation_sets rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_source_observations_inv_rowid BEFORE UPDATE ON card_source_observations
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.state IS NULL OR NEW.provenance IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_observations rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_transactions_inv_rowid BEFORE UPDATE ON card_transactions
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.created_at IS NULL OR NEW.updated_at IS NULL OR NEW.revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transactions rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_source_identities_inv_rowid BEFORE UPDATE ON card_source_identities
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_identities rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_reconciliation_suggestions_inv_rowid BEFORE UPDATE ON card_reconciliation_suggestions
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_reconciliation_suggestions rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_coverage_windows_inv_rowid BEFORE UPDATE ON card_coverage_windows
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'card invariant: card_coverage_windows rows keep their rowid and never fall back to a default'); END;

CREATE TRIGGER trg_card_sync_commit_plans_inv_rowid BEFORE UPDATE ON card_sync_commit_plans
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.source_reviewed IS NULL OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_commit_plans rows keep their rowid and never fall back to a default'); END;
`,
  '3.4a': `-- @block 3.4a
ALTER TABLE card_transactions RENAME TO card_transactions_v14;
DROP INDEX idx_card_transactions_external_id;
DROP INDEX idx_card_transactions_fingerprint;
DROP INDEX idx_card_transactions_account_date;
DROP INDEX idx_card_transactions_batch;
`,
  '3.4b': `-- @block 3.4b
INSERT INTO card_transactions (
  rowid, id, card_account_id, source, external_id_hash, fingerprint, transaction_date, posted_date, status, amount_minor,
  currency, original_amount_minor, original_currency, kind, description, merchant, issuer_category, user_category, notes,
  import_batch_id, created_at, updated_at, dismissed_at,
  card_scope_id, revision, first_sync_run_id, removed_reason, removed_from_status, removed_at, merged_into_id, reversal_snapshot_revision)
SELECT
  t.rowid, t.id, t.card_account_id, t.source, t.external_id_hash, t.fingerprint, t.transaction_date, t.posted_date, t.status,
  t.amount_minor, t.currency, t.original_amount_minor, t.original_currency, t.kind, t.description, t.merchant,
  t.issuer_category, t.user_category, t.notes, t.import_batch_id, t.created_at, t.updated_at, t.dismissed_at,
  (SELECT s.id FROM card_scopes s WHERE s.card_account_id = t.card_account_id AND s.kind = 'legacy'),
  1,
  NULL,
  CASE WHEN t.status <> 'removed' THEN NULL WHEN t.dismissed_at IS NOT NULL THEN 'dismissed' ELSE 'legacy' END,
  CASE WHEN t.status = 'removed' AND t.dismissed_at IS NOT NULL THEN 'pending' END,
  CASE WHEN t.status = 'removed' THEN coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', t.dismissed_at),
                                               strftime('%Y-%m-%dT%H:%M:%fZ', t.updated_at), :migrated_at) END,
  NULL,
  NULL
FROM card_transactions_v14 t
ORDER BY t.rowid;
`,
  '3.4c': `-- @block 3.4c
DROP TABLE card_transactions_v14;
`,
} as const;

export type CardSyncBlock = keyof typeof CARD_SYNC_BLOCKS;

export const CARD_SYNC_QUERIES = {
  'adjustment-reversible': `SELECT CASE WHEN :value_change = 1
         THEN t.reversal_snapshot_revision IS :committed_revision - 1
         ELSE NOT EXISTS (SELECT 1 FROM card_transaction_versions v
                          WHERE v.card_transaction_id = t.id AND v.revision >= :committed_revision)
       END AS reversible
FROM card_transactions t
WHERE t.id = :transaction_id
`,
  'auto-sync-step': `UPDATE card_source_bindings
   SET auto_sync_revision = auto_sync_revision + 1, updated_at = :now
 WHERE id = :binding_id AND status <> 'retired'
   AND (:enabled = 0 OR (version = :expected_version AND auto_sync_revision = :expected_auto_sync_revision))
`,
  'revoke-grants-of-device': `UPDATE card_sync_device_scopes
   SET status = 'revoked', revoked_at = :now, auto_sync = 0, consent_contract_version = NULL, consent_guard_revision = NULL,
       consent_issuer_revision = NULL, consent_binding_version = NULL, consent_by_ref = NULL, consent_at = NULL
 WHERE device_id = :device_id AND status = 'active'
`,
  'revoke-grants-of-binding': `UPDATE card_sync_device_scopes
   SET status = 'revoked', revoked_at = :now, auto_sync = 0, consent_contract_version = NULL, consent_guard_revision = NULL,
       consent_issuer_revision = NULL, consent_binding_version = NULL, consent_by_ref = NULL, consent_at = NULL
 WHERE binding_id = :binding_id AND status = 'active'
`,
  'revoke-grant': `UPDATE card_sync_device_scopes
   SET status = 'revoked', revoked_at = :now, auto_sync = 0, consent_contract_version = NULL, consent_guard_revision = NULL,
       consent_issuer_revision = NULL, consent_binding_version = NULL, consent_by_ref = NULL, consent_at = NULL
 WHERE id = :grant_id AND status = 'active'
`,
  'revoke-all-grants': `UPDATE card_sync_device_scopes
   SET status = 'revoked', revoked_at = :now, auto_sync = 0, consent_contract_version = NULL, consent_guard_revision = NULL,
       consent_issuer_revision = NULL, consent_binding_version = NULL, consent_by_ref = NULL, consent_at = NULL
 WHERE status = 'active'
`,
  'withdraw-consent-of-binding': `UPDATE card_sync_device_scopes
   SET auto_sync = 0, consent_contract_version = NULL, consent_guard_revision = NULL, consent_issuer_revision = NULL,
       consent_binding_version = NULL, consent_by_ref = NULL, consent_at = NULL
 WHERE binding_id = :binding_id AND status = 'active' AND auto_sync = 1
`,
  'quarantine-sets-of-device': `UPDATE card_sync_observation_sets
   SET state = 'blocked-review', version = version + 1
 WHERE device_id = :device_id AND state IN ('accepted-uncommitted', 'needs-review')
`,
  'cancel-plans-of-device': `UPDATE card_sync_commit_plans
   SET status = 'cancelled', closed_at = :now, cancel_reason = 'device-revoked'
 WHERE status = 'prepared'
   AND (device_id = :device_id
        OR observation_set_id IN (SELECT id FROM card_sync_observation_sets WHERE device_id = :device_id AND closed_at IS NULL))
`,
  'close-pairing-of-device': `UPDATE card_sync_pairings
   SET status = 'cancelled', closed_at = :now
 WHERE status = 'redeemed'
   AND id = (SELECT d.pairing_id FROM card_sync_devices d WHERE d.id = :device_id)
`,
  'set-level-item': `SELECT r.id AS item_id, -1 AS item_key
  FROM card_reconciliation_suggestions r
 WHERE r.observation_set_id = :set_id AND r.observation_id IS NULL AND r.status <> 'superseded'
`,
  'set-items-page': `SELECT r.id AS item_id, o.ordinal AS item_key
  FROM card_source_observations o
  JOIN card_reconciliation_suggestions r ON r.observation_id = o.id
 WHERE o.observation_set_id = :set_id AND o.ordinal > :after_key AND r.status <> 'superseded'
 ORDER BY o.ordinal
 LIMIT :limit
`,
  'values-at-revision': `SELECT x.from_current, x.at_revision, x.status, x.transaction_date, x.posted_date, x.amount_minor, x.original_amount_minor,
       x.original_currency, x.kind, x.description, x.merchant, x.issuer_category, x.card_scope_id, x.removed_reason,
       x.removed_from_status
  FROM (SELECT 0 AS from_current, v.revision AS at_revision, v.status, v.transaction_date, v.posted_date, v.amount_minor,
               v.original_amount_minor, v.original_currency, v.kind, v.description, v.merchant, v.issuer_category, v.card_scope_id,
               v.removed_reason, v.removed_from_status
          FROM card_transaction_versions v
         WHERE v.card_transaction_id = :transaction_id AND v.revision >= :revision
         ORDER BY v.revision
         LIMIT 1) x
UNION ALL
SELECT 1, t.revision, t.status, t.transaction_date, t.posted_date, t.amount_minor, t.original_amount_minor, t.original_currency,
       t.kind, t.description, t.merchant, t.issuer_category, t.card_scope_id, t.removed_reason, t.removed_from_status
  FROM card_transactions t
 WHERE t.id = :transaction_id
   AND NOT EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = t.id AND v.revision >= :revision)
`,
  'plan-effects-page': `SELECT a.ordinal, a.op, a.review_item_id, a.observation_ordinal, a.content_digest, a.transaction_id, a.expected_revision,
       a.new_ref, a.related_transaction_id, a.related_revision, a.scope_id, a.promote, a.restore, a.identity_count,
       a.reverses_event_id
  FROM card_sync_plan_actions a
 WHERE a.plan_id = :plan_id AND a.ordinal > :after_ordinal AND a.op <> 'unchanged'
 ORDER BY a.ordinal
 LIMIT :limit
`,
  'transaction-history-page': `SELECT e.id, e.created_at, e.card_transaction_id
  FROM card_transaction_events e
 WHERE e.card_transaction_id = :transaction_id AND (e.created_at, e.id) < (:before_created_at, :before_id)
UNION ALL
SELECT e.id, e.created_at, e.card_transaction_id
  FROM card_transaction_events e
 WHERE e.event_type = 'identity-repointed' AND e.from_canonical_id = :transaction_id
   AND (e.created_at, e.id) < (:before_created_at, :before_id)
 ORDER BY 2 DESC, 1 DESC
 LIMIT :limit
`,
  'revertible-event': `SELECT e.id AS event_id
  FROM card_transactions t
  JOIN card_transaction_events e ON e.card_transaction_id = t.id AND e.transaction_revision = t.reversal_snapshot_revision + 1
 WHERE t.id = :transaction_id AND e.event_type IN ('corrected', 'promoted', 'restored', 'attributed')
 ORDER BY CASE e.event_type WHEN 'corrected' THEN 1 WHEN 'promoted' THEN 2 WHEN 'restored' THEN 3 ELSE 4 END
 LIMIT 1
`,
  'transaction-aliases-page': `SELECT i.id AS identity_id, i.created_at
  FROM card_source_identities i
 WHERE i.canonical_transaction_id = :transaction_id AND (i.created_at, i.id) > (:after_created_at, :after_id)
 ORDER BY i.created_at, i.id
 LIMIT :limit
`,
  'transaction-merged-page': `SELECT t.id AS transaction_id, t.removed_at
  FROM card_transactions t
 WHERE t.merged_into_id = :transaction_id AND (t.removed_at, t.id) > (:after_removed_at, :after_id)
 ORDER BY t.removed_at, t.id
 LIMIT :limit
`,
  'touch-set': `UPDATE card_sync_observation_sets SET version = version + 1 WHERE id = :set_id
`,
  'audit-cutoff-refresh': `INSERT INTO card_sync_audit_events (id, event_type, actor_kind, actor_ref, code, created_at)
SELECT :id, 'retention-completed', 'system', NULL, 'audit-cutoff', :now
 WHERE EXISTS (SELECT 1 FROM card_sync_audit_events a
                WHERE a.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', :now, '-365 days'))
   AND COALESCE((SELECT max(c.created_at) FROM card_sync_audit_events c
                  WHERE c.event_type = 'retention-completed' AND c.code = 'audit-cutoff')
                <= strftime('%Y-%m-%dT%H:%M:%fZ', :now, '-1 day'), 1)
`,
  'audit-delete-chunk': `DELETE FROM card_sync_audit_events
 WHERE rowid IN (SELECT a.rowid FROM card_sync_audit_events a
                  WHERE a.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ',
                          min((SELECT max(c.created_at) FROM card_sync_audit_events c
                                WHERE c.event_type = 'retention-completed' AND c.code = 'audit-cutoff'), :now), '-365 days')
                  ORDER BY a.created_at
                  LIMIT 100)
`,
  'audit-cutoff-ahead': `SELECT EXISTS (SELECT 1 FROM card_sync_audit_events
                WHERE event_type = 'retention-completed' AND code = 'audit-cutoff'
                  AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', :now, '+5 minutes')) AS ahead
`,
} as const;

export type CardSyncQueryName = keyof typeof CARD_SYNC_QUERIES;
