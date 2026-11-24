import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import { type Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import { digest, exact, POLICY_DIGEST, LEDGER_POLICY_DIGEST, ref, refuse, TIP_SPLIT_POLICY_DIGEST } from '../services/amazon/policy.js';
import { AMAZON_SCHEMA_DIGEST, hasAmazonSchema } from '../services/amazon/schema.js';
import { validateCapture } from '../services/amazon/capture.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { audit, backedUpWrite, importAmazonCapture, projectRefunds, recordBindingProposal, recordRootApproval,
  revokeContradictedProofs } from '../services/amazon/importer.js';
import { reconcileAmazon } from '../services/amazon/matcher.js';
import { validCategory } from '../services/amazon/resolver.js';
import { agentReviewShape, applyAgentReview } from '../services/amazon/categorization.js';
// STEP 9 integration (A10-A14, #174)
import {
  adoptionReview, applyCategoryAdoption, validateCategoryAdoption, type AdoptionCounts, type AdoptionReview,
} from '../services/amazon/ownerDecisions.js';
import { assertPrivate, writePrivateJson } from '../services/amazon/privateFiles.js';
import { CUTOVER_SCHEMA_DIGEST, installCutoverReceiptSchema } from '../services/guardedCardCommit.js';
import type { ValidatedCapture } from '../services/amazon/capture.js';
import { BATCH_CAPTURE_MAX, PREVIEW_CAPTURE_MAX, batchGoState, canonicalPath, capturedResult, hasDuplicateKeys,
  importClassifiedCapture, isRereadCapture, makeClone, previewOnClone, previewRefusal, readCaptureList, revisionOrderBreak,
  runBatchCaptures, settleBaseline, type BatchCapture, type BatchGo, type CaptureOut } from '../services/amazon/batch.js';
import { ensureAmazonSchema } from '../services/amazon/schema.js';
import { SAVED_ORDERS_BYTES, SavedOrdersRefusal, gatePassed, importSavedOrders, parseSavedOrders,
  type ParsedSavedOrders, type SavedGate, type SavedOutcome } from '../services/amazon/savedOrders.js';

export const AMAZON_CLI_USAGE = `Amazon local operator CLI (no network; existing finance.db only)
  inspect --input CAPTURE
  migrate --db DB --backup NEW_FILE --root-go ARTIFACT
  migrate-cutover --db DB --backup NEW_FILE --root-go ARTIFACT
  import --db DB --input CAPTURE --backup NEW_FILE --root-go ARTIFACT
  preview-batch --db DB --clone NEW_CLONE --input CAPTURE_LIST
  import-batch --db DB --input CAPTURE_LIST --clone NEW_CLONE --backup NEW_FILE --root-go BATCH_ARTIFACT
  preview-saved --db DB --clone NEW_CLONE --input SAVED_ORDERS [--output NEW_GATED_SAVED_ORDERS]
  import-saved --db DB --input SAVED_ORDERS --backup NEW_FILE --root-go ARTIFACT
  reconcile --db DB --backup NEW_FILE --root-go ARTIFACT
  propose-bindings --db DB --input BINDINGS --output PRIVATE_PROPOSAL --backup NEW_FILE --root-go ARTIFACT
  approve-bindings --db DB --input PROPOSAL --approval ROOT_APPROVAL --backup NEW_FILE --root-go ARTIFACT
  adoption-review --db DB --output NEW_PRIVATE_REVIEW
  review --db DB --input REVIEW --backup NEW_FILE --root-go ARTIFACT
No command approves its own proposal. Root artifacts are separate, owner-controlled files.
Every write to DB requires a pinned Root GO and a new pre-write backup, including schema creation.
inspect and adoption-review never write a database; adoption-review writes only a new private adoption.
review applies an adoption only if every entry is still current when it writes; otherwise it writes nothing
and prints adoption-stale: write a new adoption and GO it again.
migrate-cutover requires CUTOVER_SCHEMA_DIGEST and installs only the cutover receipt schema.
preview-batch never writes DB: it copies DB into NEW_CLONE (a new file in a private directory) and imports the
listed re-read captures there, keeping only those whose import adds image IDs and changes nothing else.
import-batch imports a Root batch GO's ordered re-read captures. Every run first re-runs the full preview on NEW_CLONE,
a fresh copy of DB; then, after one backup, each capture runs in its own transaction, is kept only when its import
adds image IDs and changes nothing else, and the first refusal stops the run. Any committed capture spends the GO. A
refusal is logged with the GO, and leaves it unused only when nothing was committed, its rollback was verified and its
log was written; only then may the same GO, unchanged, run again. A GO in any other state is refused before any write.
Both refuse, before any write, a list whose re-reads of one cursor are not in increasing revision (commit) order.
preview-saved never writes DB: it copies DB into NEW_CLONE (a new file in a private directory) and imports the saved
orders (holdr.amazon-saved-orders v1, read offline from saved order pages) there. Each order is judged on its own
evidence (Root's gate): its saved card, total and date must link to exactly one card charge, as the order's own display,
with no conflict in its history; and no card row linked before may be lost or moved. An invalid order (by its place and
a closed reason) and a held order are listed, never written, and change nothing; the others go on. With --output it
writes only the passing orders, as a new private file: the input a GO may name.
import-saved imports a GO'd saved-orders file after a backup, judging every order the same way inside the write: it
exits 0 when every order was imported, 2 when only the passing orders were (the rest listed by place), and 1 with
nothing written when none passed.
COPY rehearsal and production authorization are separate operator gates; neither is run automatically.
`;
const COMMANDS = ['inspect', 'migrate', 'migrate-cutover', 'import', 'reconcile', 'propose-bindings', 'approve-bindings',
  'adoption-review', 'review', 'preview-batch', 'import-batch', 'preview-saved', 'import-saved'];
function readJsonText(file: string): { text: string; value: unknown } {
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) return refuse();
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { text, value: JSON.parse(text) };
  } catch { return refuse(); }
}
function readJson(file: string): unknown {
  return readJsonText(file).value;
}
const DUPLICATE_KEYS = 'amazon json input repeats a key';
/**
 * A batch command's JSON input (a GO, a capture list or a capture): as readJson, and refused when any object in it
 * repeats a key. JavaScript reads the last and SQLite the first, so Root refuses such JSON wherever it appears.
 */
function readBatchJson(file: string): unknown {
  const { text, value } = readJsonText(file);
  if (hasDuplicateKeys(text)) throw new HoldrRefusal(DUPLICATE_KEYS);
  return value;
}
/** Why a listed capture could not be read: it repeats a key, or anything else. */
const unreadable = (error: unknown) =>
  error instanceof HoldrRefusal && error.message === DUPLICATE_KEYS ? 'duplicate-keys' : 'input-unreadable';
function options(args: string[]): Map<string, string> {
  const allowed = ['--db', '--input', '--backup', '--root-go', '--output', '--approval', '--clone'];
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || result.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) return refuse();
    result.set(args[i], args[i + 1]);
  }
  return result;
}
function required(opts: Map<string, string>, name: string): string {
  const value = opts.get(name);
  if (!value || !path.isAbsolute(value)) return refuse();
  return value;
}
/**
 * The GO's fixed fields, checked before the database is opened or a backup taken. Every field is compared strictly, by
 * type and value: a value that only reads as the right one once coerced (`["copy-rehearsal"]`, `"2"`) refuses.
 */
function authorize(input: unknown, command: string, database: string, payload: unknown): void {
  const a = exact(input, ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'databaseRef', 'inputDigest',
    'policyDigest', 'schemaDigest', 'ledgerPolicyDigest']);
  if (a.format !== 'holdr.amazon-write-go' || a.version !== 2 || a.authority !== 'Root' || a.decision !== 'GO'
    || typeof a.purpose !== 'string' || !['copy-rehearsal', 'production-import'].includes(a.purpose) || a.command !== command
    || a.databaseRef !== digest(path.resolve(database)) || a.inputDigest !== digest(payload) || a.policyDigest !== POLICY_DIGEST
    || a.schemaDigest !== (command === 'migrate-cutover' ? CUTOVER_SCHEMA_DIGEST : AMAZON_SCHEMA_DIGEST)
    || a.ledgerPolicyDigest !== LEDGER_POLICY_DIGEST) return refuse();
}
const BATCH_GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'inputDigests',
  'policyDigest', 'schemaDigest', 'ledgerPolicyDigest'];
/**
 * A batch GO's fixed fields, checked like the write GO's (strictly, by type and value) before the database is opened or
 * a backup taken. It pins one single-use run (`goId`) of an ordered list of at most BATCH_CAPTURE_MAX distinct capture
 * digests, under the same Amazon policy, schema and ledger policy digests as every other Amazon write.
 */
function authorizeBatch(input: unknown, database: string): { purpose: string; goId: string; inputDigests: string[] } {
  const a = exact(input, BATCH_GO_KEYS);
  const digests = a.inputDigests;
  if (a.format !== 'holdr.amazon-batch-go' || a.version !== 1 || a.authority !== 'Root' || a.decision !== 'GO'
    || typeof a.purpose !== 'string' || !['copy-rehearsal', 'production-import'].includes(a.purpose) || a.command !== 'import-batch'
    || typeof a.goId !== 'string' || !/^[a-f0-9]{32}$/.test(a.goId) || a.databaseRef !== digest(path.resolve(database))
    || !Array.isArray(digests) || digests.length < 1 || digests.length > BATCH_CAPTURE_MAX
    || digests.some(d => typeof d !== 'string' || !/^[a-f0-9]{64}$/.test(d)) || new Set(digests).size !== digests.length
    || a.policyDigest !== POLICY_DIGEST || a.schemaDigest !== AMAZON_SCHEMA_DIGEST
    || a.ledgerPolicyDigest !== LEDGER_POLICY_DIGEST) return refuse();
  return { purpose: a.purpose, goId: a.goId, inputDigests: digests as string[] };
}
/**
 * A review's own fields, compared strictly by type and value (`["alex"]` is not `"alex"`): a malformed review refuses before
 * the database is opened or a backup taken. What it names, including an agent classification's category inventory and
 * products, is checked against the database in the write. STEP 9 integration B7b (Root): an `adoption` here is only #174's
 * agent-category adoption, checked by its exact shape (entries `{ productKey, previousProductKey, category, confidence }`).
 * A taxonomy adoption (`node`, `source`, `confidence`: #171's `amazon-taxonomy import`) or a mixed one refuses whole.
 */
function reviewFields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse();
  const kind = (input as Record<string, unknown>).kind;
  if (kind === 'agent-classification') {
    agentReviewShape(input);
    return input as Record<string, unknown>;
  }
  // STEP 9 integration (A10-A14, #174)
  if (kind === 'adoption') return validateCategoryAdoption(input) as unknown as Record<string, unknown>;
  if (kind === 'mapping') {
    const r = exact(input, ['kind', 'sourceCategory', 'category', 'reviewed']);
    if (r.reviewed !== true || typeof r.sourceCategory !== 'string' || !validCategory(r.sourceCategory)
      || typeof r.category !== 'string' || !validCategory(r.category)) return refuse();
    return r;
  }
  if (kind === 'item-override') {
    const r = exact(input, ['kind', 'itemRef', 'category']);
    if (!ref(r.itemRef) || typeof r.category !== 'string' || !validCategory(r.category)) return refuse();
    return r;
  }
  if (kind !== 'beneficiary') return refuse();
  const r = exact(input, ['kind', 'orderRef', 'beneficiary']);
  if (!ref(r.orderRef) || (r.beneficiary !== null
    && (typeof r.beneficiary !== 'string' || !['alex', 'casey', 'joint'].includes(r.beneficiary)))) return refuse();
  return r;
}
// STEP 9 integration (A10-A14, #174)
function applyReview(db: Database.Database, input: unknown, stale: (counts: AdoptionCounts) => void): void {
  const r = reviewFields(input), kind = r.kind;
  if (kind === 'agent-classification') {
    applyAgentReview(db, input);
  } else if (kind === 'adoption') {
    // Only an adoption gets the application-time precondition; every other kind applies exactly as before (#174).
    applyCategoryAdoption(db, input, stale);
  } else if (kind === 'mapping') {
    if (!db.prepare(`SELECT 1 FROM card_transactions WHERE COALESCE(user_category,issuer_category,'Uncategorized')=?`)
        .get(r.category)) return refuse();
    db.prepare(`INSERT INTO amazon_category_mappings VALUES(?,?,1)
      ON CONFLICT(source_category) DO UPDATE SET category=excluded.category`).run(r.sourceCategory, r.category);
  } else if (kind === 'item-override') {
    if (!db.prepare('SELECT 1 FROM amazon_items WHERE ref=?').get(r.itemRef)) return refuse();
    db.prepare(`INSERT INTO amazon_item_overrides VALUES(?,?)
      ON CONFLICT(item_ref) DO UPDATE SET category=excluded.category`).run(r.itemRef, r.category);
  } else if (kind === 'beneficiary') {
    if (!db.prepare('SELECT 1 FROM amazon_orders WHERE ref=?').get(r.orderRef)) return refuse();
    db.prepare('UPDATE amazon_orders SET beneficiary=? WHERE ref=?').run(r.beneficiary, r.orderRef);
  } else return refuse();
  audit(db, 'owner-review', null, undefined, input, new Date().toISOString());
}
/**
 * `adoption-review` (Root, #168): the read-only consumer of the category-key adoption list. No GO and no backup: it opens
 * the existing database read-only (never creating or writing one) and writes only a new private adoption (adoptionReview),
 * which only the GO'd `review` applies. Prints counts and the adoption's digest, never a value.
 */
async function writeAdoptionReview(env: NodeJS.ProcessEnv, database: string, output: string): Promise<unknown> {
  // The output is a new file under a private parent outside the repository, never the database or a reserved sidecar,
  // whatever the database holds.
  const canonical = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const source = canonical(database);
  if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(canonical(output))) return refuse();
  assertPrivate(path.dirname(output));
  if (fs.lstatSync(output, { throwIfNoEntry: false })) return refuse();
  const handle = await openWriterDb(env, () => new Database(database, { readonly: true, fileMustExist: true }));
  let adoption: AdoptionReview;
  try {
    handle.db.pragma('query_only = ON');
    adoption = adoptionReview(handle.db);
  } finally { handle.close(); }
  const { review, ambiguous, outsideInventory } = adoption;
  if (!review.entries.length) return { code: 'adoption-review-nothing-to-adopt', adoptions: 0, ambiguous, outsideInventory };
  writePrivateJson(output, review);
  return { code: 'adoption-review-written-not-applied', adoptions: review.entries.length, ambiguous, outsideInventory,
    reviewDigest: digest(review) };
}
/** A capture that never reached a classification is refused for what failed: a Holdr refusal, or anything else. */
const failure = (error: unknown) => error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed';
/** A capture's classification, when its import was classified and refused for its class. */
const refusedClass = (out: CaptureOut) =>
  out.result && out.result.classification.class !== 'image-ids-only' ? out.result : null;
/** Closed values and how many times each occurs, in sorted order. */
const tally = (values: unknown[]) => Object.fromEntries([...new Set(values.map(String))].sort()
  .map(value => [value, values.filter(v => String(v) === value).length]));
/** A capture list refused before any write, for one place in it: only that place and a closed reason are printed. */
function listRefused(io: Io, index: number, reason: string): number {
  io.stdout.write(JSON.stringify({ code: 'batch-input-refused', index, reason }) + '\n');
  return 1;
}
/** A new file beside the database: never the database or one of its reserved sidecars, and its directory exists. */
function newFileFor(database: string, target: string): boolean {
  const source = canonicalPath(database);
  return ![source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(canonicalPath(target))
    && !fs.lstatSync(target, { throwIfNoEntry: false })
    && !!fs.statSync(path.dirname(target), { throwIfNoEntry: false })?.isDirectory();
}
/**
 * Root's GO-reuse rule, before the clone and again before the backup: a GO that is not `unused` (batchGoState) is
 * refused with its closed state, and nothing is written. A database with no Amazon schema is refused.
 */
function goRefused(io: Io, db: Database.Database, go: BatchGo): number | null {
  if (!hasAmazonSchema(db)) return refuse();
  const state = batchGoState(db, go);
  if (state === 'unused') return null;
  io.stdout.write(JSON.stringify({ code: 'batch-go-refused', goId: go.goId, go: state }) + '\n');
  return 1;
}
/**
 * `preview-batch` (Root's clone gate): no GO, and the database is never written.
 * - Every listed capture is read first: a list out of commit order (revisionOrderBreak) refuses whole, before anything
 *   is written.
 * - The database is then opened read-only, only for an online copy into a new clone file in a private directory. A
 *   clone is a full copy of the finance database, so the operator deletes it after use.
 * - The preview settles the clone as any import would (settleBaseline), then imports each listed capture there in its
 *   own transaction, in list order. It keeps only image-IDs-only captures, so every class is the one a GO'd batch of
 *   those captures meets.
 * Prints value-free classes, kinds, counts and digests. The `imageIdsOnly` digests, in order, are what a batch GO may
 * list.
 */
async function previewBatch(env: NodeJS.ProcessEnv, io: Io, opts: Map<string, string>): Promise<number> {
  const database = required(opts, '--db'), clone = required(opts, '--clone');
  const files = readCaptureList(readBatchJson(required(opts, '--input')), PREVIEW_CAPTURE_MAX);
  // A new file in a private directory, never the database or one of its reserved sidecars, whatever they hold.
  if (!newFileFor(database, clone)) return refuse();
  assertPrivate(path.dirname(clone));
  const inputs = files.map(file => {
    try { return { input: readBatchJson(file) }; } catch (error) { return { unread: unreadable(error) }; }
  });
  const outOfOrder = revisionOrderBreak(inputs.map(read => 'input' in read ? read.input : undefined));
  if (outOfOrder !== null) return listRefused(io, outOfOrder, 'revision-order');
  const handle = await openWriterDb(env, () => new Database(database, { readonly: true, fileMustExist: true }));
  try {
    handle.db.pragma('query_only = ON');
    await makeClone(handle.db, clone);
  } finally { handle.close(); }
  const db = new Database(clone, { fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON');
    const baseline = settleBaseline(db, new Date().toISOString());
    const captures: Array<Record<string, unknown>> = [];
    for (const [index, read] of inputs.entries()) {
      if (!('input' in read)) { captures.push({ index, class: 'refused', reason: read.unread }); continue; }
      const { input } = read, inputDigest = digest(input);
      let capture: ValidatedCapture;
      try { capture = await validateCapture(input); } catch {
        captures.push({ index, inputDigest, class: 'refused', reason: 'input-invalid' });
        continue;
      }
      if (!isRereadCapture(input)) { captures.push({ index, inputDigest, class: 'refused', reason: 'not-a-reread' }); continue; }
      const out: CaptureOut = {};
      try {
        importClassifiedCapture(db, capture, inputDigest, new Date().toISOString(), out);
        captures.push({ index, inputDigest, ...capturedResult(out.result!) });
      } catch (error) {
        const classified = refusedClass(out);
        captures.push(classified ? { index, inputDigest, ...capturedResult(classified) }
          : { index, inputDigest, class: 'refused', reason: failure(error) });
      }
    }
    io.stdout.write(JSON.stringify({ code: 'batch-previewed', databaseRef: digest(path.resolve(database)),
      policyDigest: POLICY_DIGEST, schemaDigest: AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST,
      baseline: { settled: baseline.length === 0, changed: baseline }, planned: files.length,
      classes: tally(captures.map(c => c.class)), kinds: tally(captures.flatMap(c => (c.changed as unknown[] | undefined) ?? [])),
      imageIdsOnly: captures.filter(c => c.class === 'image-ids-only').map(c => c.inputDigest), captures }) + '\n');
    return 0;
  } finally { db.close(); }
}
/**
 * `import-batch` (Root's batch import): a batch GO's ordered re-read captures, at most BATCH_CAPTURE_MAX.
 * - Before the database is opened, each listed capture must have the GO's digest at its place, validate, and have a
 *   re-read's shape, and the list must be in commit order (revisionOrderBreak). The GO, the list and every capture must
 *   repeat no JSON key (readBatchJson). A refusal there names only its place and a closed reason, and writes nothing.
 * - Root's GO-reuse rule: the GO must be `unused` (batchGoState), checked before the clone and again before the backup;
 *   otherwise the run prints the GO's closed state and writes nothing.
 * - Every run, first or retry, re-runs the full preview against the database as it is now: on NEW_CLONE, a fresh copy
 *   in a private directory, the baseline must be settled and every capture image-IDs-only (previewOnClone).
 * - Then the run's one backup, and the run's attempt record. A preview refusal is then logged with the GO, and nothing
 *   else is written. Otherwise each capture runs in its own transaction, classified again on the database, and is kept
 *   only when image-IDs-only (runBatchCaptures). The first capture's transaction records the GO, so any committed
 *   capture consumes it. A refused first capture leaves the GO unused only when its rollback is verified. Every
 *   refusal is logged with the GO; a GO whose refusal could not be logged is left `unlogged`, never reused.
 * Prints one value-free receipt per capture, the GO's id and closed state, and the receiver's release list of the
 * captures it imported (`release`: `{ format: 'holdr.amazon-imported-captures', version: 1, captureDigests }`, digests
 * only, in import order).
 */
async function importBatch(env: NodeJS.ProcessEnv, io: Io, opts: Map<string, string>): Promise<number> {
  const database = required(opts, '--db'), backup = required(opts, '--backup'), clone = required(opts, '--clone');
  const artifact = readBatchJson(required(opts, '--root-go')), authorized = authorizeBatch(artifact, database);
  const go: BatchGo = { goId: authorized.goId, goDigest: digest(artifact) };
  const files = readCaptureList(readBatchJson(required(opts, '--input')), BATCH_CAPTURE_MAX);
  if (files.length !== authorized.inputDigests.length || !newFileFor(database, backup) || !newFileFor(database, clone)
    || canonicalPath(backup) === canonicalPath(clone)) return refuse();
  assertPrivate(path.dirname(clone));
  const captures: Array<BatchCapture & { input: unknown }> = [];
  for (const [index, file] of files.entries()) {
    let input: unknown;
    try { input = readBatchJson(file); } catch (error) { return listRefused(io, index, unreadable(error)); }
    if (digest(input) !== authorized.inputDigests[index]) return listRefused(io, index, 'digest-mismatch');
    let capture: ValidatedCapture;
    try { capture = await validateCapture(input); } catch { return listRefused(io, index, 'input-invalid'); }
    if (!isRereadCapture(input)) return listRefused(io, index, 'not-a-reread');
    captures.push({ input, inputDigest: authorized.inputDigests[index], capture });
  }
  const outOfOrder = revisionOrderBreak(captures.map(c => c.input));
  if (outOfOrder !== null) return listRefused(io, outOfOrder, 'revision-order');
  const now = () => new Date().toISOString();
  // Open the existing database directly: SqliteStateRepo's automatic migrations must not precede our backup.
  const writer = () => openWriterDb(env, () => new Database(database, { fileMustExist: true }));
  let handle = await writer();
  try {
    handle.db.pragma('foreign_keys=ON');
    const refused = goRefused(io, handle.db, go);
    if (refused !== null) return refused;
    await makeClone(handle.db, clone);
  } finally { handle.close(); }
  const cloneDb = new Database(clone, { fileMustExist: true });
  let preview: ReturnType<typeof previewOnClone>;
  try {
    cloneDb.pragma('foreign_keys=ON');
    preview = previewOnClone(cloneDb, captures, now);
  } finally { cloneDb.close(); }
  handle = await writer();
  try {
    const db = handle.db;
    db.pragma('foreign_keys=ON');
    const refused = goRefused(io, db, go);
    if (refused !== null) return refused;
    // The run's one pre-write backup, before its first write, whichever that is. The Amazon schema is not installed here:
    // each capture's classified write compares the schema from before its own install.
    await backedUpWrite(db, backup, () => undefined, () => undefined);
    const run = runBatchCaptures(db, go, captures, now, previewRefusal(preview));
    io.stdout.write(JSON.stringify({ code: run.refusal ? 'batch-stopped' : 'batch-imported', purpose: authorized.purpose,
      goId: go.goId, planned: captures.length, imported: run.imported, go: batchGoState(db, go),
      preview: { settled: preview.baseline.length === 0, changed: preview.baseline }, refusal: run.refusal,
      captures: run.entries,
      // The receiver's release list (its `amazon-capture-envelopes.mjs --release`): the captures imported, in import order.
      release: { format: 'holdr.amazon-imported-captures', version: 1,
        captureDigests: run.entries.filter(entry => entry.code === 'imported').map(entry => entry.inputDigest) } }) + '\n');
    return run.refusal ? 1 : 0;
  } finally { handle.close(); }
}
/**
 * A saved-orders file (SAVED_ORDERS_BYTES at most), owner-only in an owner-only directory (assertPrivate: never
 * repaired), as readBatchJson: refused when any object in it repeats a key.
 */
function readSavedJson(file: string): unknown {
  if (!path.isAbsolute(file)) return refuse();
  assertPrivate(path.dirname(file));
  assertPrivate(file);
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > SAVED_ORDERS_BYTES) return refuse();
  let text: string, value: unknown;
  try {
    text = fs.readFileSync(file, 'utf8');
    value = JSON.parse(text);
  } catch { return refuse(); }
  if (hasDuplicateKeys(text)) throw new HoldrRefusal(DUPLICATE_KEYS);
  return value;
}
/** The checked saved-orders file (valid orders and the invalid ones' places), or null after a whole-file refusal. */
async function savedFile(io: Io, input: unknown): Promise<ParsedSavedOrders | null> {
  try { return await parseSavedOrders(input, new Date().toISOString().slice(0, 10)); } catch (error) {
    if (!(error instanceof SavedOrdersRefusal)) throw error;
    io.stdout.write(JSON.stringify({ code: 'saved-input-refused', index: error.index, reason: error.reason }) + '\n');
    return null;
  }
}
const gateReport = (gate: SavedGate) => ({ passed: gate.passed, failed: gate.failed, linkedRowsLost: gate.linkedRowsLost,
  linkedRowsMoved: gate.linkedRowsMoved, reasons: tally(gate.orders.filter(o => !o.passed).map(o => `${o.state}:${o.reason}`)),
  // How each passing order's charge linked (its total, a tipped order's order part, or its own ledger charges), every
  // tipped order's tip part, and the ledger branch's code wherever it was attempted.
  charges: tally(gate.orders.filter(o => o.passed).map(o => o.charge)),
  tipParts: tally(gate.orders.flatMap(o => o.tipPart ? [`${o.tipPart.state}:${o.tipPart.reason}`] : [])),
  ledgerCodes: tally(gate.orders.flatMap(o => o.ledger ? [o.ledger.code] : [])),
  orders: gate.orders });
/**
 * A saved-orders import's value-free report: the input's order count, the invalid orders and the held ones by place and
 * closed reason, the trial gate of every valid order, and the passing orders' own write (digests, counts, holds, gate).
 */
function savedReport(parsed: ParsedSavedOrders, inputDigest: string, outcome: SavedOutcome | null) {
  const written = outcome?.written ?? null;
  return { inputDigest, orders: parsed.file.orders.length + parsed.rejected.length, valid: parsed.file.orders.length,
    invalid: parsed.rejected, held: outcome?.held ?? [], trial: outcome ? gateReport(outcome.trial) : null,
    written: written ? { captureDigest: written.captureDigest, orders: written.file.orders.length, freshLists: written.freshLists,
      receipt: { newCaptures: written.receipt.newCaptures, newOrders: written.receipt.newOrders,
        newObservations: written.receipt.newObservations, newMatches: written.receipt.newMatches,
        invalidated: written.receipt.invalidated, held: written.receipt.held, holds: written.receipt.holds },
      gate: gateReport(written.gate) } : null };
}
/**
 * `preview-saved` (Root's clone gate for saved-page orders): no GO, and the database is never written.
 * - The file is checked order by order (parseSavedOrders); only a file outside the closed envelope is refused whole.
 * - The database is opened read-only, only for an online copy into a new clone file in a private directory. A clone is
 *   a full copy of the finance database, so the operator deletes it after use.
 * - On the clone, the valid orders are imported exactly as import-saved imports them (importSavedOrders): judged on a
 *   rolled-back trial, then only the passing ones written and judged again. With --output (a new file in a private
 *   directory), only the passing orders are written out: that file's digest is what an import-saved GO names.
 */
async function previewSaved(env: NodeJS.ProcessEnv, io: Io, opts: Map<string, string>): Promise<number> {
  const database = required(opts, '--db'), clone = required(opts, '--clone');
  const output = opts.has('--output') ? required(opts, '--output') : null;
  const input = readSavedJson(required(opts, '--input'));
  const inputDigest = digest(input);
  const parsed = await savedFile(io, input);
  if (!parsed) return 1;
  if (!newFileFor(database, clone) || (output && (!newFileFor(database, output) || canonicalPath(output) === canonicalPath(clone)))) {
    return refuse();
  }
  assertPrivate(path.dirname(clone));
  if (output) assertPrivate(path.dirname(output));
  const head = { databaseRef: digest(path.resolve(database)), policyDigest: POLICY_DIGEST, schemaDigest: AMAZON_SCHEMA_DIGEST,
    ledgerPolicyDigest: LEDGER_POLICY_DIGEST, tipSplitPolicyDigest: TIP_SPLIT_POLICY_DIGEST };
  if (!parsed.file.orders.length) {
    io.stdout.write(JSON.stringify({ code: 'saved-previewed', ...head, ...savedReport(parsed, inputDigest, null), gated: null }) + '\n');
    return 0;
  }
  const handle = await openWriterDb(env, () => new Database(database, { readonly: true, fileMustExist: true }));
  try {
    handle.db.pragma('query_only = ON');
    await makeClone(handle.db, clone);
  } finally { handle.close(); }
  const db = new Database(clone, { fileMustExist: true });
  let outcome: SavedOutcome;
  try {
    db.pragma('foreign_keys=ON');
    const now = new Date().toISOString();
    outcome = db.transaction(() => {
      ensureAmazonSchema(db);
      return importSavedOrders(db, parsed, inputDigest, now);
    }).immediate();
  } finally { db.close(); }
  const gated = outcome.written && gatePassed(outcome.written.gate) ? outcome.written.file : null;
  if (output && gated) writePrivateJson(output, gated, SAVED_ORDERS_BYTES);
  io.stdout.write(JSON.stringify({ code: outcome.written && !gated ? 'saved-gate-refused' : 'saved-previewed', ...head,
    ...savedReport(parsed, inputDigest, outcome),
    gated: gated ? { orders: gated.orders.length, inputDigest: digest(gated), written: !!output } : null }) + '\n');
  return outcome.written && !gated ? 1 : 0;
}
/**
 * `import-saved` (Root's saved-page import): a GO'd saved-orders file, written after one new backup, each order judged
 * on its own evidence inside the write (importSavedOrders). Only the passing orders are written; an invalid or held order
 * changes nothing. Exit 0: every order imported; 2: only the passing ones (the rest listed by place); 1: nothing written
 * (no order passed, or the passing orders' own write failed its gate, which rolls everything back).
 */
async function importSaved(env: NodeJS.ProcessEnv, io: Io, opts: Map<string, string>): Promise<number> {
  const database = required(opts, '--db'), backup = required(opts, '--backup');
  const input = readSavedJson(required(opts, '--input'));
  authorize(readJson(required(opts, '--root-go')), 'import-saved', database, input);
  const inputDigest = digest(input);
  const parsed = await savedFile(io, input);
  if (!parsed) return 1;
  if (!parsed.file.orders.length) {
    io.stdout.write(JSON.stringify({ code: 'saved-gate-refused', ...savedReport(parsed, inputDigest, null) }) + '\n');
    return 1;
  }
  const handle = await openWriterDb(env, () => new Database(database, { fileMustExist: true }));
  try {
    const db = handle.db;
    db.pragma('foreign_keys=ON');
    const refused: { outcome?: SavedOutcome } = {};
    let outcome: SavedOutcome;
    try {
      outcome = await backedUpWrite(db, backup, () => {
        const result = importSavedOrders(db, parsed, inputDigest, new Date().toISOString());
        if (!result.written || !gatePassed(result.written.gate)) {
          refused.outcome = result;
          throw new SavedOrdersRefusal(null, 'gate');
        }
        return result;
      });
    } catch (error) {
      if (!refused.outcome) throw error;
      io.stdout.write(JSON.stringify({ code: 'saved-gate-refused', ...savedReport(parsed, inputDigest, refused.outcome) }) + '\n');
      return 1;
    }
    const complete = !outcome.held.length && !parsed.rejected.length;
    io.stdout.write(JSON.stringify({ code: complete ? 'saved-imported' : 'saved-imported-partial',
      ...savedReport(parsed, inputDigest, outcome) }) + '\n');
    return complete ? 0 : 2;
  } finally { handle.close(); }
}
export async function runAmazonCli(args: string[], context: { env: NodeJS.ProcessEnv; io: Io }): Promise<number> {
  const { io } = context;
  // A stale adoption is refused with no writes (its transaction rolls back); only its counts are kept, to print.
  const refused: { stale?: AdoptionCounts } = {};
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(AMAZON_CLI_USAGE); return 0; }
    if (!command || !COMMANDS.includes(command)) return refuse();
    const opts = options(rest);
    const expectedOptions = command === 'inspect' ? ['--input'] : command === 'adoption-review' ? ['--db', '--output']
      : command === 'preview-batch' ? ['--db', '--clone', '--input']
      : command === 'preview-saved' ? ['--db', '--clone', '--input', '--output']
      : ['--db', '--backup', '--root-go',
        ...(['import', 'import-batch', 'import-saved', 'propose-bindings', 'approve-bindings', 'review'].includes(command) ? ['--input'] : []),
        ...(command === 'import-batch' ? ['--clone'] : []),
        ...(command === 'propose-bindings' ? ['--output'] : []), ...(command === 'approve-bindings' ? ['--approval'] : [])];
    if ([...opts.keys()].some(key => !expectedOptions.includes(key))) return refuse();
    if (command === 'preview-batch') return await previewBatch(context.env, io, opts);
    if (command === 'import-batch') return await importBatch(context.env, io, opts);
    if (command === 'preview-saved') return await previewSaved(context.env, io, opts);
    if (command === 'import-saved') return await importSaved(context.env, io, opts);
    const input = ['inspect', 'import', 'propose-bindings', 'approve-bindings', 'review'].includes(command)
      ? readJson(required(opts, '--input')) : null;
    // Refuse an invalid capture or review before even opening a writer or attempting a backup.
    const capture = command === 'inspect' || command === 'import' ? await validateCapture(input) : null;
    if (command === 'review') reviewFields(input);
    if (command === 'inspect') {
      if (opts.size !== 1) return refuse();
      io.stdout.write(JSON.stringify({ code: 'validated-not-imported', version: capture!.staging.version,
        orders: capture!.staging.orders.length, paymentObservations: capture!.staging.payments.length,
        refundEvidence: (capture!.staging.refundEvidence ?? []).length, coverage: capture!.staging.coverage,
        ...(capture!.fresh ? { freshLists: capture!.fresh.lists.length } : {}) }) + '\n');
      return 0;
    }
    if (command === 'adoption-review') {
      if (opts.size !== 2) return refuse();
      const result = await writeAdoptionReview(context.env, required(opts, '--db'), required(opts, '--output'));
      io.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }
    const database = required(opts, '--db'), backup = required(opts, '--backup');
    const approval = command === 'approve-bindings' ? readJson(required(opts, '--approval')) : null;
    const payload = command === 'approve-bindings' ? { proposal: input, approval } : input;
    authorize(readJson(required(opts, '--root-go')), command, database, payload);
    // Open the existing database directly: SqliteStateRepo's automatic migrations must not precede our backup.
    const handle = await openWriterDb(context.env, () => new Database(database, { fileMustExist: true }));
    try {
      const db = handle.db;
      db.pragma('foreign_keys=ON');
      let result: unknown;
      if (command === 'migrate-cutover') result = await backedUpWrite(db, backup,
        () => ({ code: 'cutover-schema-ready', schemaDigest: CUTOVER_SCHEMA_DIGEST }), installCutoverReceiptSchema);
      else if (command === 'import') result = await importAmazonCapture(db, input, backup);
      else if (command === 'propose-bindings') {
        const output = required(opts, '--output');
        // Reserve the owner-only output before database writes; no accidental overwrite of an approval artifact.
        const fd = fs.openSync(output, 'wx', 0o600);
        try {
          const proposal = proposeBindings(input, readCardInventory(db));
          await recordBindingProposal(db, proposal, backup);
          fs.writeFileSync(fd, JSON.stringify(proposal) + '\n');
          result = { code: 'binding-proposed-not-approved', proposals: proposal.bindings.length };
        } finally { fs.closeSync(fd); }
      } else if (command === 'approve-bindings') {
        await recordRootApproval(db, input, approval, backup);
        result = { code: 'root-approval-recorded' };
      } else result = await backedUpWrite(db, backup, () => {
        if (command === 'migrate') return { code: 'schema-ready', schemaDigest: AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST };
        // STEP 9 integration (A10-A14, #174)
        if (command === 'review') applyReview(db, input, counts => { refused.stale = counts; });
        // charge-free proof (#158): a reconcile first rechecks displayed no-charge proofs against live charge evidence.
        const proofs = revokeContradictedProofs(db, new Date().toISOString());
        projectRefunds(db, new Date().toISOString());
        const reconciliation = reconcileAmazon(db, new Date().toISOString());
        // STEP 9 integration (Root): a contradicted proof without its recorded predecessor stays displayed, surfaced.
        const holds = [...(proofs.revoked.length ? [{ reason: 'charge-free-contradicted', count: proofs.revoked.length }] : []),
          ...(proofs.missing.length ? [{ reason: 'revocation-predecessor-missing', count: proofs.missing.length }] : [])];
        return { code: 'reconciled', ...reconciliation, ...(holds.length ? { holds } : {}) };
      });
      io.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    } finally { handle.close(); }
  } catch (error) {
    if (refused.stale) {
      io.stdout.write(JSON.stringify({ code: 'adoption-stale', ...refused.stale }) + '\n');
      return 1;
    }
    io.stderr.write(`amazon: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
