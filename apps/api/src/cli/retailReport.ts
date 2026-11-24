import type Database from 'better-sqlite3';
import { RETAIL_CHANNELS } from '@finance-tracker/shared/retail-import-payload';

import {
  RETAIL_COVERAGE_CHANNELS,
  RETAIL_FOLDER,
  RETAIL_HELD_CLASSES,
  RETAIL_OWNERS,
  RETAIL_QUARANTINE_REASONS,
  RETAIL_WRITTEN_OUTCOMES,
  retailCountColumn,
  retailIdPattern,
  retailPossibleOverlaps,
  retailSchemaForRead,
} from '../services/retail/index.js';

/**
 * `holdr-retail report` (plan v5 §8.1, §8.3): the retail tables as one value-free line. Memberships (ref, folder, owner),
 * possible overlaps (a count), imports (id, sequence, capture and import days, counts by outcome and held class),
 * receipts by channel and state, quarantine causes by reason, and the coverage dates by channel. Never an amount, a last
 * four, a title, a label, a natural key or a capture path. Absent tables answer `schema: absent` with no rows; a conflict
 * and a stored reserved value refuse (retailSchemaForRead).
 */

type Counts<K extends string> = Record<K, number>;

export interface RetailReport {
  code: 'retail-reported';
  schema: 'present' | 'absent';
  memberships: Array<{ membershipRef: string; folder: string; owner: string }>;
  possibleOverlap: number;
  imports: Array<{
    importId: string;
    importSeq: number;
    membershipRef: string;
    capturedOn: string;
    importedOn: string;
    receipts: number;
    outcomes: Counts<(typeof RETAIL_WRITTEN_OUTCOMES)[number]>;
    held: Counts<(typeof RETAIL_HELD_CLASSES)[number]>;
  }>;
  receipts: Record<(typeof RETAIL_CHANNELS)[number], { active: number; quarantined: number }>;
  causes: Counts<(typeof RETAIL_QUARANTINE_REASONS)[number]>;
  coverage: Record<(typeof RETAIL_COVERAGE_CHANNELS)[number], { from: string; to: string } | null>;
}

const zeros = <K extends string>(keys: readonly K[]): Counts<K> => Object.fromEntries(keys.map((key) => [key, 0])) as Counts<K>;

function empty(): RetailReport {
  return {
    code: 'retail-reported', schema: 'absent', memberships: [], possibleOverlap: 0, imports: [],
    receipts: Object.fromEntries(RETAIL_CHANNELS.map((channel) => [channel, { active: 0, quarantined: 0 }])) as RetailReport['receipts'],
    causes: zeros(RETAIL_QUARANTINE_REASONS),
    coverage: Object.fromEntries(RETAIL_COVERAGE_CHANNELS.map((channel) => [channel, null])) as RetailReport['coverage'],
  };
}

/** The report of a database whose tables are present or absent; a conflict or a stored reserved value refuses. */
export function retailReport(db: Database.Database): RetailReport {
  const report = empty();
  if (retailSchemaForRead(db) === 'absent') return report;
  report.schema = 'present';
  report.memberships = db.prepare(`SELECT membership_ref AS membershipRef, folder, owner FROM retail_memberships ORDER BY folder`)
    .all() as RetailReport['memberships'];
  report.possibleOverlap = retailPossibleOverlaps(db);
  const outcomeColumns = RETAIL_WRITTEN_OUTCOMES.map((outcome) => `${retailCountColumn(outcome)} AS "${outcome}"`).join(', ');
  const heldColumns = RETAIL_HELD_CLASSES.map((held) => `held_${retailCountColumn(held)} AS "${held}"`).join(', ');
  const rows = db.prepare(`SELECT import_id AS importId, import_seq AS importSeq, membership_ref AS membershipRef, substr(captured_at, 1, 10) AS capturedOn,
      substr(imported_at, 1, 10) AS importedOn, receipt_count AS receipts, ${outcomeColumns}, ${heldColumns} FROM retail_imports ORDER BY import_seq`)
    .all() as Array<Record<string, string | number>>;
  report.imports = rows.map((row) => ({
    importId: row.importId as string, importSeq: row.importSeq as number, membershipRef: row.membershipRef as string,
    capturedOn: row.capturedOn as string, importedOn: row.importedOn as string, receipts: row.receipts as number,
    outcomes: Object.fromEntries(RETAIL_WRITTEN_OUTCOMES.map((outcome) => [outcome, row[outcome] as number])) as RetailReport['imports'][number]['outcomes'],
    held: Object.fromEntries(RETAIL_HELD_CLASSES.map((held) => [held, row[held] as number])) as RetailReport['imports'][number]['held'],
  }));
  for (const row of db.prepare('SELECT channel, state, count(*) AS n FROM retail_receipts GROUP BY channel, state').all() as
    Array<{ channel: (typeof RETAIL_CHANNELS)[number]; state: 'active' | 'quarantined'; n: number }>) {
    report.receipts[row.channel][row.state] = row.n;
  }
  for (const row of db.prepare(`SELECT reason, count(*) AS n FROM retail_receipt_events WHERE kind IN ('quarantined', 'cause') GROUP BY reason`)
    .all() as Array<{ reason: (typeof RETAIL_QUARANTINE_REASONS)[number]; n: number }>) {
    report.causes[row.reason] = row.n;
  }
  for (const row of db.prepare('SELECT channel, min(from_date) AS "from", max(to_date) AS "to" FROM retail_import_coverage GROUP BY channel')
    .all() as Array<{ channel: (typeof RETAIL_COVERAGE_CHANNELS)[number]; from: string; to: string }>) {
    report.coverage[row.channel] = { from: row.from, to: row.to };
  }
  return report;
}

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MEMBERSHIP_REF = retailIdPattern('rtl-mbr-');
const IMPORT_ID = retailIdPattern('rtl-imp-');
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999;
const exactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const counts = (value: unknown, keys: readonly string[]) => exactly(value, keys) && keys.every((key) => isCount(value[key]));
const range = (value: unknown) => value === null || (exactly(value, ['from', 'to']) && DATE.test(String(value.from)) && DATE.test(String(value.to)));

/**
 * The report as one JSON line, or null when anything in it falls outside its strict shape: refs and ids of their shapes,
 * folders and owners of theirs, closed keys, counts and dates. Digits appear only in counts, dates and folder numbers.
 */
export function formatRetailReport(report: RetailReport): string | null {
  const value = report as unknown as Record<string, unknown>;
  if (!exactly(value, ['code', 'schema', 'memberships', 'possibleOverlap', 'imports', 'receipts', 'causes', 'coverage'])) return null;
  if (report.code !== 'retail-reported' || (report.schema !== 'present' && report.schema !== 'absent') || !isCount(report.possibleOverlap)) return null;
  if (!Array.isArray(report.memberships) || !report.memberships.every((membership) => exactly(membership, ['membershipRef', 'folder', 'owner'])
    && MEMBERSHIP_REF.test(membership.membershipRef) && RETAIL_FOLDER.test(membership.folder)
    && (RETAIL_OWNERS as readonly string[]).includes(membership.owner))) return null;
  if (!Array.isArray(report.imports) || !report.imports.every((entry) => exactly(entry,
    ['importId', 'importSeq', 'membershipRef', 'capturedOn', 'importedOn', 'receipts', 'outcomes', 'held'])
    && IMPORT_ID.test(entry.importId) && isCount(entry.importSeq) && MEMBERSHIP_REF.test(entry.membershipRef) && DATE.test(entry.capturedOn)
    && DATE.test(entry.importedOn) && isCount(entry.receipts) && counts(entry.outcomes, RETAIL_WRITTEN_OUTCOMES)
    && counts(entry.held, RETAIL_HELD_CLASSES))) return null;
  if (!exactly(report.receipts, RETAIL_CHANNELS) || !RETAIL_CHANNELS.every((channel) => counts(report.receipts[channel], ['active', 'quarantined']))) {
    return null;
  }
  if (!counts(report.causes, RETAIL_QUARANTINE_REASONS)) return null;
  if (!exactly(report.coverage, RETAIL_COVERAGE_CHANNELS) || !RETAIL_COVERAGE_CHANNELS.every((channel) => range(report.coverage[channel]))) return null;
  return `${JSON.stringify(report)}\n`;
}
