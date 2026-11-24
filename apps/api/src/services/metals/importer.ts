import type { Database } from 'better-sqlite3';

import { cardImportTextProblem } from '@finance-tracker/shared';
import {
  metalsAdmission,
  serializeMetalsImportPayload,
  validateMetalsImportPayload,
  type MetalsCompetitor,
  type MetalsImportPayload,
  type MetalsOrder,
  type MetalsSource,
} from '@finance-tracker/shared/metals-ledger';

import { digest } from '../amazon/policy.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { HEX64, MetalsRefusal, checkWriteContext, lettersOfHex, newMetalsId, sha256Hex } from './common.js';
import { deleteMetalsProjection, metalsProjectionClashes, writeMetalsProjection } from './projection.js';
import { METALS_IMPORT_OUTCOMES, METALS_IMPORT_PURPOSES, METALS_RULE_COLUMNS, requireMetalsSchema } from './schema.js';
import { canonicalAdmission, canonicalJson, canonicalMetalsOrder, classifyMetalsVersion, letterDigest, metalsOrderDigest } from './versions.js';

/**
 * `holdr-metals import` (design v8 §7): one `holdr.metals-import` v1 payload into the metals tables, under a Root GO that
 * names the payload's SHA-256 and its source account. The payload is validated again here, whoever made it, and every
 * order is put in its canonical form (versions.ts), which must validate too. No free text in it may hold a run of 13 or
 * more digits (`metals-payload-free-text`, before any write). The schema stores every payload the validator accepts
 * whole: a line the title guard flagged keeps its flag, and a product ref its whole id (contract follow-up 1). Each order
 * is weighed against its active version alone
 * (§4.2): `new`, `observation`, `predecessor`, `progression`, `proposal` or `conflict`:
 * - `new`: version 1, active, and its projection;
 * - `observation`: the active version's facts, or those of a version still waiting for `supersede`: the observation only;
 * - `predecessor`: facts the active version has only moved on from, in a capture provably older than one that observed
 *   the active version (its `capturedAt` strictly earlier): the observation only. A backward-only relation from a capture
 *   that is newer, equally old or of unknown time (a retail payload has none) is a factual `conflict` instead;
 * - `progression`: a new active version, the old one superseded (`progressed`), the projection rewritten;
 * - `proposal`, `conflict`: a stored `proposed` or `conflict` version; the active one and its projection stay until a
 *   Root-GO'd `supersede`, and a `conflict` quarantines the order meanwhile. A version Root declined has no standing:
 *   the same facts seen again are weighed like any other, so they raise a proposal or conflict again unless they are a
 *   predecessor.
 * Every distinct fact-version of a competitor is stored once (one row per card method), and every competitor the payload
 * lists is observed (`metals_competitor_observations`, design delta D-G2-2: the import, its order key and the digest of
 * the fact-version it showed), an unchanged re-read included. The payload's held records and coverage are kept with the
 * import. A payload already imported (the same SHA-256) writes nothing. The write computes the plan, competitor
 * observations included, again inside its IMMEDIATE transaction and writes only if its digest is the preflight's.
 * Versions, observations and competitor observations are append-only.
 */

export type MetalsImportOutcome = (typeof METALS_IMPORT_OUTCOMES)[number];
export type MetalsImportPurpose = (typeof METALS_IMPORT_PURPOSES)[number];
/** The source account a Root GO names: an existing one, or a new one with the label the owner declares. */
export type MetalsAccountChoice = { accountId: string } | { label: string };

export interface MetalsImportRequest {
  /** The parsed payload; validated again here. */
  payload: unknown;
  /** Null only for a plan (`holdr-metals plan --payload`), which then resolves no account. */
  account: MetalsAccountChoice | null;
}

export interface MetalsImportContext {
  /** A 24-character ISO instant. */
  now: string;
  /** The Root GO's id: 32 lowercase hex. */
  goId: string;
  purpose: MetalsImportPurpose;
  /** The GO's `inputSha256` (lowercase hex): the import refuses (`metals-input-mismatch`) any other payload. */
  inputSha256: string;
  /**
   * The preflight plan's digest: the write refuses (`metals-plan-changed`) when the plan computed inside its transaction
   * differs. Null plans and writes in one step (tests and seeds).
   */
  planDigest: string | null;
}

export interface MetalsImportPlan {
  /** Lowercase hex SHA-256 of the payload's canonical bytes (what the GO names). */
  inputSha256: string;
  source: MetalsSource;
  alreadyImported: boolean;
  /** The import that already holds this payload, or (in a receipt) the new one. */
  importId: string | null;
  accountId: string | null;
  accountCreated: boolean;
  orders: Record<MetalsImportOutcome, number>;
  lines: number;
  /** Competitors whose facts are a new fact-version, and ones already stored; each listed one is observed either way. */
  competitors: { new: number; known: number };
  held: number;
  coverage: number;
  /** The orders the import leaves waiting for `supersede` (at most 200 listed; `orders` has the counts). */
  pending: Array<{ orderKey: string; outcome: 'proposal' | 'conflict' }>;
  /** Lowercase hex digest of everything the write would do. */
  planDigest: string;
}

export interface MetalsImportReceipt extends MetalsImportPlan {
  code: 'metals-imported' | 'metals-already-imported';
}

const ACCOUNT_ID = /^mtl-acct-[a-p]{32}$/;
const LABEL = /^[A-Za-z][A-Za-z0-9 ._-]{0,59}$/;
const COMPETITOR_TAG = 'holdr.metals-competitor-facts';
const PENDING_LISTED = 200;

/** A GO's `account`, exactly `{ accountId }` or `{ label }`; a label is short plain text with no run of 4 digits. */
export function metalsAccountChoice(value: unknown): MetalsAccountChoice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MetalsRefusal('metals-account-invalid');
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (keys.length === 1 && keys[0] === 'accountId' && typeof record.accountId === 'string' && ACCOUNT_ID.test(record.accountId)) {
    return { accountId: record.accountId };
  }
  const label = record.label;
  if (keys.length === 1 && keys[0] === 'label' && typeof label === 'string' && LABEL.test(label) && label === label.trim()
    && !/[0-9]{4}/.test(label) && !label.includes('  ') && cardImportTextProblem(label, 60) === null) {
    return { label };
  }
  throw new MetalsRefusal('metals-account-invalid');
}

/** The payload validated by the shared validator, or a refusal naming paths and fixed messages only. */
export function validMetalsPayload(value: unknown): MetalsImportPayload {
  const validation = validateMetalsImportPayload(value);
  if (!validation.ok) {
    throw new MetalsRefusal('metals-payload-invalid', { issues: validation.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
  }
  return validation.payload;
}

/**
 * The validated payload in canonical form: every order canonical (versions.ts) and every competitor's methods sorted.
 * The canonical payload must validate as well (it always does: canonicalization only reorders and renumbers).
 */
export function canonicalMetalsPayload(payload: MetalsImportPayload): MetalsImportPayload {
  const orders = payload.orders.map((order) => canonicalMetalsOrder(payload.source, order));
  const competitors = payload.competitors.map((competitor) => ({ ...competitor, admission: canonicalAdmission(competitor.admission) }));
  const canonical: MetalsImportPayload = { ...payload, orders, competitors };
  if (!validateMetalsImportPayload(structuredClone(canonical)).ok) throw new MetalsRefusal('metals-canonical-invalid');
  return canonical;
}

interface StoredAccount {
  accountId: string;
  source: string;
  folder: string;
  identityLast4: string | null;
}

interface OrderEntry {
  order: MetalsOrder;
  digest: string;
  outcome: MetalsImportOutcome;
  /** The version observed or created; null for a predecessor, which is never stored. */
  version: number | null;
  /** The active version a progression supersedes. */
  replaces: number | null;
}

interface CompetitorEntry {
  competitor: MetalsCompetitor;
  factsDigest: string;
  /** The new fact-version, or null when these facts are stored already. */
  seq: number | null;
}

interface Prepared {
  payload: MetalsImportPayload;
  account: { existing: StoredAccount | null; label: string | null };
  entries: OrderEntry[];
  competitors: CompetitorEntry[];
  plan: MetalsImportPlan;
}

const zeroOutcomes = (): Record<MetalsImportOutcome, number> =>
  Object.fromEntries(METALS_IMPORT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<MetalsImportOutcome, number>;

function resolveAccount(db: Database, payload: MetalsImportPayload, choice: MetalsAccountChoice): Prepared['account'] {
  if ('accountId' in choice) {
    const stored = db.prepare(`SELECT account_id AS accountId, source, folder, identity_last4 AS identityLast4 FROM metals_accounts
      WHERE account_id = ?`).get(choice.accountId) as StoredAccount | undefined;
    if (!stored) throw new MetalsRefusal('metals-account-unknown');
    const stated = payload.account.identityLast4;
    if (stored.source !== payload.source || stored.folder !== payload.account.folder
      || (stored.identityLast4 !== null && stated !== null && stored.identityLast4 !== stated)) {
      throw new MetalsRefusal('metals-account-mismatch');
    }
    return { existing: stored, label: null };
  }
  const clash = db.prepare(`SELECT 1 FROM metals_accounts WHERE source = ? AND (folder = ? OR (identity_last4 IS NOT NULL AND identity_last4 = ?))`)
    .get(payload.source, payload.account.folder, payload.account.identityLast4);
  if (clash) throw new MetalsRefusal('metals-account-exists');
  return { existing: null, label: choice.label };
}

interface VersionRow {
  version: number;
  digest: string;
  state: string;
  canonicalJson: string;
}

/**
 * The newest capture time among the live imports that observed any version in the lineage of the order's given version
 * (the version and every version it copies, corrections r6 §2.4), or null when none is known (a retail payload carries
 * none). An incoming capture strictly earlier than it is provably older than that version.
 */
function newestCaptureOf(db: Database, orderKey: string, version: number): string | null {
  return db.prepare(`WITH RECURSIVE lineage(version) AS (
      SELECT ? UNION SELECT v.reinstates_version FROM metals_order_versions v JOIN lineage l ON v.version = l.version
      WHERE v.order_key = ? AND v.reinstates_version IS NOT NULL)
    SELECT max(i.captured_at) FROM metals_observations o JOIN metals_imports i ON i.import_id = o.import_id
    WHERE o.order_key = ? AND o.version IN (SELECT version FROM lineage) AND i.voided_by_go IS NULL`)
    .pluck().get(version, orderKey, orderKey) as string | null;
}

const LONG_DIGIT_RUN = /[0-9]{13}/;
const FREE_TEXT_LISTED = 20;

/**
 * The plan-time mirror of the database's digit guard on free text (ROOT's ratified narrowing): no string nested in an
 * order (what `canonical_json` and the projections store), except a computed fine-content rational (`troyOz`), and no
 * string of a held record may hold a run of 13 or more digits. Returns the paths that do (at most 20), so the import
 * refuses them before any write. The shared validator refuses most of them already, and the database refuses them again
 * (the `metals_order_versions_free_text` trigger and the column CHECKs).
 */
export function metalsFreeTextProblems(payload: Pick<MetalsImportPayload, 'orders' | 'held'>): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, at: string, key: string | null): void => {
    if (paths.length >= FREE_TEXT_LISTED) return;
    if (typeof value === 'string') {
      if (key !== 'troyOz' && LONG_DIGIT_RUN.test(value)) paths.push(at);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${at}[${index}]`, null));
    } else if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) walk(item, `${at}.${name}`, name);
    }
  };
  payload.orders.forEach((order, index) => walk(order, `$.orders[${index}]`, null));
  payload.held.forEach((held, index) => walk(held, `$.held[${index}]`, null));
  return paths;
}

/** Lowercase hex SHA-256 of the payload's canonical bytes, after validation: what a Root GO for its import names. */
export function metalsPayloadSha256(payload: unknown): string {
  return sha256Hex(serializeMetalsImportPayload(validMetalsPayload(payload)));
}

/** The payload's capture time as the imports table keeps it (24 characters, UTC), or null for a retail payload. */
const captureTime = (payload: MetalsImportPayload): string | null =>
  'capturedAt' in payload.input ? new Date(payload.input.capturedAt).toISOString() : null;

function orderEntry(db: Database, order: MetalsOrder, capturedAt: string | null): OrderEntry {
  const orderDigest = metalsOrderDigest(order);
  const rows = db.prepare(`SELECT version, digest, state, canonical_json AS canonicalJson FROM metals_order_versions WHERE order_key = ?
    ORDER BY version`).all(order.key) as VersionRow[];
  if (rows.length === 0) return { order, digest: orderDigest, outcome: 'new', version: 1, replaces: null };
  const actives = rows.filter((row) => row.state === 'active');
  if (actives.length !== 1) throw new MetalsRefusal('metals-version-state-invalid');
  const [active] = actives;
  if (active.digest === orderDigest) return { order, digest: orderDigest, outcome: 'observation', version: active.version, replaces: null };
  // The same facts as a version still waiting for `supersede`: one more observation of it, never a second copy.
  const waiting = rows.find((row) => (row.state === 'proposed' || row.state === 'conflict') && row.digest === orderDigest);
  if (waiting) return { order, digest: orderDigest, outcome: 'observation', version: waiting.version, replaces: null };
  // Any other version, a superseded or declined one included, is weighed against the active one alone.
  const newest = newestCaptureOf(db, order.key, active.version);
  const olderCapture = capturedAt !== null && newest !== null && capturedAt < newest;
  const relation = classifyMetalsVersion(order, JSON.parse(active.canonicalJson) as MetalsOrder, olderCapture);
  const next = rows[rows.length - 1].version + 1;
  if (relation === 'observation') return { order, digest: orderDigest, outcome: 'observation', version: active.version, replaces: null };
  if (relation === 'predecessor') return { order, digest: orderDigest, outcome: 'predecessor', version: null, replaces: null };
  return { order, digest: orderDigest, outcome: relation, version: next, replaces: relation === 'progression' ? active.version : null };
}

function competitorEntry(db: Database, source: MetalsSource, competitor: MetalsCompetitor): CompetitorEntry {
  const admitted = metalsAdmission(source, competitor.channel, competitor.admission);
  if (!admitted || admitted.basis !== competitor.basis || admitted.capMinor !== competitor.capMinor) {
    throw new MetalsRefusal('metals-competitor-invalid');
  }
  const factsDigest = letterDigest(COMPETITOR_TAG, {
    channel: competitor.channel, date: competitor.date, interval: competitor.interval, admission: competitor.admission,
    basis: competitor.basis, capMinor: competitor.capMinor,
  });
  const rows = db.prepare('SELECT DISTINCT seq, facts_digest AS factsDigest FROM metals_competitors WHERE order_key = ?')
    .all(competitor.orderKey) as Array<{ seq: number; factsDigest: string }>;
  if (rows.some((row) => row.factsDigest === factsDigest)) return { competitor, factsDigest, seq: null };
  return { competitor, factsDigest, seq: rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1 };
}

function prepare(db: Database, request: MetalsImportRequest): Prepared {
  const choice = request.account === null ? null : metalsAccountChoice(request.account);
  const validated = validMetalsPayload(request.payload);
  const inputSha256 = sha256Hex(serializeMetalsImportPayload(validated));
  const payload = canonicalMetalsPayload(validated);
  const freeText = metalsFreeTextProblems(payload);
  if (freeText.length > 0) throw new MetalsRefusal('metals-payload-free-text', { paths: freeText });
  const base = {
    inputSha256, source: payload.source, accountCreated: false, orders: zeroOutcomes(), lines: 0, competitors: { new: 0, known: 0 },
    held: 0, coverage: 0, pending: [],
  };
  const stored = db.prepare('SELECT import_id AS importId, account_id AS accountId FROM metals_imports WHERE payload_sha256 = ? AND voided_by_go IS NULL')
    .get(lettersOfHex(inputSha256)) as { importId: string; accountId: string } | undefined;
  if (stored) {
    const plan: MetalsImportPlan = { ...base, alreadyImported: true, importId: stored.importId, accountId: stored.accountId,
      planDigest: digest({ inputSha256, alreadyImported: stored.importId }) };
    return { payload, account: { existing: null, label: null }, entries: [], competitors: [], plan };
  }
  const account = choice === null ? { existing: null, label: null } : resolveAccount(db, payload, choice);
  const capturedAt = captureTime(payload);
  const entries = payload.orders.map((order) => orderEntry(db, order, capturedAt));
  const clashes = entries.filter((entry) => (entry.outcome === 'new' || entry.outcome === 'progression') && metalsProjectionClashes(db, entry.order));
  if (clashes.length > 0) throw new MetalsRefusal('metals-key-conflict', { orders: clashes.slice(0, 20).map((entry) => entry.order.key) });
  const competitors = payload.competitors.map((competitor) => competitorEntry(db, payload.source, competitor));
  const orders = zeroOutcomes();
  for (const entry of entries) orders[entry.outcome] += 1;
  const plan: MetalsImportPlan = {
    ...base,
    alreadyImported: false,
    importId: null,
    accountId: account.existing?.accountId ?? null,
    accountCreated: choice !== null && account.existing === null,
    orders,
    lines: payload.orders.reduce((sum, order) => sum + order.lines.length, 0),
    competitors: { new: competitors.filter((entry) => entry.seq !== null).length, known: competitors.filter((entry) => entry.seq === null).length },
    held: payload.held.length,
    coverage: payload.coverage.length,
    pending: entries.flatMap((entry) => (entry.outcome === 'proposal' || entry.outcome === 'conflict'
      ? [{ orderKey: entry.order.key, outcome: entry.outcome }] : [])).slice(0, PENDING_LISTED),
    planDigest: digest({
      inputSha256,
      account: choice === null ? null : account.existing ? { accountId: account.existing.accountId } : { label: account.label },
      orders: entries.map((entry) => [entry.order.key, entry.digest, entry.outcome, entry.version, entry.replaces]),
      competitors: competitors.map((entry) => [entry.competitor.orderKey, entry.factsDigest, entry.seq]),
      observedCompetitors: competitors.map((entry) => [entry.competitor.orderKey, entry.factsDigest]),
      held: payload.held.length,
      coverage: payload.coverage.length,
    }),
  };
  return { payload, account, entries, competitors, plan };
}

const isCard = (kind: string) => kind === 'card' || kind === 'card-refund';

function write(db: Database, prepared: Prepared, context: MetalsImportContext): MetalsImportReceipt {
  const { payload, plan } = prepared;
  const source = payload.source;
  const now = context.now;
  const importId = newMetalsId('mtl-imp-');
  const accountId = prepared.account.existing?.accountId ?? newMetalsId('mtl-acct-');
  // Every row of a protected table gets an explicit rowid, one more than the table's highest, read inside this fence.
  const nextRowid = (table: string) => `(SELECT coalesce(max(rowid), 0) + 1 FROM ${table})`;
  if (prepared.account.existing === null) {
    if (prepared.account.label === null) throw new MetalsRefusal('metals-account-invalid');
    db.prepare(`INSERT INTO metals_accounts (rowid, account_id, source, label, folder, identity_last4, created_by_import, created_at)
      VALUES (${nextRowid('metals_accounts')}, ?, ?, ?, ?, ?, ?, ?)`)
      .run(accountId, source, prepared.account.label, payload.account.folder, payload.account.identityLast4, importId, now);
  }
  const input = payload.input;
  const capture = 'schema' in input ? input : null;
  const retail = 'retailPayloadSha256' in input ? input : null;
  // The import's causal place, taken inside this IMMEDIATE write: one more than the highest so far (G3-C1).
  const importSeq = db.prepare('SELECT coalesce(max(import_seq), 0) + 1 FROM metals_imports').pluck().get() as number;
  const ruleColumns = METALS_RULE_COLUMNS.map(([, column]) => column);
  db.prepare(`INSERT INTO metals_imports (rowid, import_id, import_seq, payload_sha256, format, version, source, account_id, converter_version,
      policy_version, ${ruleColumns.join(', ')}, input_kind, capture_schema, capture_digest, captured_at, capture_files,
      retail_payload_sha256, retail_format, retail_policy, go_id, purpose, imported_at, order_count, line_count, competitor_count, held_count,
      coverage_count, new_count, observation_count, predecessor_count, progression_count, proposal_count, conflict_count, renewed_count)
    VALUES (${nextRowid('metals_imports')}, ${new Array(32 + ruleColumns.length).fill('?').join(', ')})`)
    .run(importId, importSeq, lettersOfHex(plan.inputSha256), payload.format, payload.version, source, accountId, payload.converterVersion,
      payload.policyVersion, ...METALS_RULE_COLUMNS.map(([key]) => payload.rules[key]),
      capture ? 'capture' : 'retail-payload', capture?.schema ?? null, capture?.captureDigest ?? null,
      captureTime(payload), capture?.files ?? null, retail?.retailPayloadSha256 ?? null,
      retail?.retailFormat ?? null, retail?.retailPolicyVersion ?? null, lettersOfHex(context.goId), context.purpose, now,
      payload.orders.length, plan.lines, payload.competitors.length, payload.held.length, payload.coverage.length, plan.orders.new,
      plan.orders.observation, plan.orders.predecessor, plan.orders.progression, plan.orders.proposal, plan.orders.conflict, plan.orders.renewed);

  const insertVersion = db.prepare(`INSERT INTO metals_order_versions (rowid, order_key, version, source, side, digest, canonical_json, state,
    reason, created_by_import, created_at) VALUES (${nextRowid('metals_order_versions')}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const supersede = db.prepare(`UPDATE metals_order_versions SET state = 'superseded', resolution = 'progressed', resolved_at = ?
    WHERE order_key = ? AND version = ? AND state = 'active'`);
  const observe = db.prepare(`INSERT INTO metals_observations (rowid, import_id, account_id, order_key, version_digest, outcome, version,
    replaces_version) VALUES (${nextRowid('metals_observations')}, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of prepared.entries) {
    const { order } = entry;
    const store = (state: string, reason: string) =>
      insertVersion.run(order.key, entry.version, source, order.side, entry.digest, canonicalJson(order), state, reason, importId, now);
    if (entry.outcome === 'new') {
      store('active', 'new');
      writeMetalsProjection(db, order, 1, accountId, source);
    } else if (entry.outcome === 'progression') {
      if (supersede.run(now, order.key, entry.replaces).changes !== 1) throw new MetalsRefusal('metals-plan-changed');
      store('active', 'progression');
      deleteMetalsProjection(db, order.key);
      writeMetalsProjection(db, order, entry.version!, accountId, source);
    } else if (entry.outcome === 'proposal') {
      store('proposed', 'proposal');
    } else if (entry.outcome === 'conflict') {
      store('conflict', 'conflict');
    }
    observe.run(importId, accountId, order.key, entry.digest, entry.outcome, entry.version, entry.outcome === 'progression' ? entry.replaces : null);
  }

  const insertCompetitor = db.prepare(`INSERT INTO metals_competitors (order_key, method, seq, import_id, account_id, source, channel,
    order_date, interval_from, interval_to, kind, network, last4, amount_minor, facts_digest, admission_json, basis, cap_minor)
    VALUES (${new Array(18).fill('?').join(', ')})`);
  for (const entry of prepared.competitors) {
    if (entry.seq === null) continue;
    const { competitor } = entry;
    competitor.admission.methods.forEach((method, index) => {
      if (!isCard(method.kind)) return;
      insertCompetitor.run(competitor.orderKey, index, entry.seq, importId, accountId, source, competitor.channel, competitor.date,
        competitor.interval.from, competitor.interval.to, method.kind, method.network, method.last4, method.amountMinor, entry.factsDigest,
        canonicalJson(competitor.admission), competitor.basis, competitor.capMinor);
    });
  }
  // Every competitor the payload lists, an unchanged re-read included, after its fact-version is stored (D-G2-2).
  const observeCompetitor = db.prepare(`INSERT INTO metals_competitor_observations (rowid, import_id, order_key, fact_digest)
    VALUES (${nextRowid('metals_competitor_observations')}, ?, ?, ?)`);
  for (const entry of prepared.competitors) observeCompetitor.run(importId, entry.competitor.orderKey, entry.factsDigest);
  const insertHold = db.prepare(`INSERT INTO metals_holds (import_id, seq, account_id, source, record_key, channel, record_date, reason,
    check_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  payload.held.forEach((held, seq) => insertHold.run(importId, seq, accountId, source, held.key, held.channel, held.date, held.reason, held.check));
  const insertCoverage = db.prepare(`INSERT INTO metals_coverage (import_id, seq, account_id, source, kind, date_from, date_to, stated, seen,
    complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  payload.coverage.forEach((range, seq) => insertCoverage.run(importId, seq, accountId, source, range.kind, range.from, range.to, range.stated,
    range.seen, range.complete ? 1 : 0));
  return { code: 'metals-imported', ...plan, importId, accountId, accountCreated: prepared.account.existing === null };
}

/** Read-only: what importing the payload would do, or the refusal it would meet. Requires the installed tables. */
export function planMetalsImport(db: Database, request: MetalsImportRequest): MetalsImportPlan {
  requireMetalsSchema(db);
  try {
    return db.transaction(() => prepare(db, request).plan)();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('plan metals import', error);
  }
}

/**
 * Imports the payload (the operator's backed-up IMMEDIATE transaction calls this; alone, it runs in one of its own). The
 * payload must be the one the GO names (`inputSha256`, the SHA-256 of its canonical bytes). The plan is computed again
 * inside the transaction; with a `planDigest` it must be the preflight's, or nothing is written.
 */
export function importMetalsPayload(db: Database, request: MetalsImportRequest, context: MetalsImportContext): MetalsImportReceipt {
  checkWriteContext(context, METALS_IMPORT_PURPOSES);
  if (typeof context.inputSha256 !== 'string' || !HEX64.test(context.inputSha256)) throw new MetalsRefusal('metals-input-sha-invalid');
  if (context.planDigest !== null && (typeof context.planDigest !== 'string' || !HEX64.test(context.planDigest))) {
    throw new MetalsRefusal('metals-plan-digest-invalid');
  }
  if (request.account === null) throw new MetalsRefusal('metals-account-invalid');
  requireMetalsSchema(db);
  try {
    return db.transaction((): MetalsImportReceipt => {
      const prepared = prepare(db, request);
      if (prepared.plan.inputSha256 !== context.inputSha256) throw new MetalsRefusal('metals-input-mismatch');
      if (context.planDigest !== null && prepared.plan.planDigest !== context.planDigest) throw new MetalsRefusal('metals-plan-changed');
      if (prepared.plan.alreadyImported) return { code: 'metals-already-imported', ...prepared.plan };
      return write(db, prepared, context);
    }).immediate();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('import metals payload', error);
  }
}
