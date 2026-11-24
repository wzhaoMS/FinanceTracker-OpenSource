// Converts captured American Express statement exports into Holdr's redacted `holdr.card-import` v1 JSON with Holdr's own
// offline card-import tool, read from packages/shared/src through tsx. Raw text goes in; only the redacted payload comes
// out: card numbers are cut to their last digits, references are hashed, card member names and addresses are dropped.
import path from 'node:path';

import { OWNER_KEYS, REPO_ROOT } from './config.mjs';

const SHARED_ENTRY = new URL('./shared-import.mts', import.meta.url).href;
let loading = null;

/** The shared tool's functions. tsImport works the same under `node --import tsx` and under plain `node`. */
export function loadSharedTool() {
  if (!loading) {
    loading = (async () => {
      const { tsImport } = await import('tsx/esm/api');
      return tsImport(SHARED_ENTRY, { parentURL: import.meta.url, tsconfig: path.join(REPO_ROOT, 'packages', 'shared', 'tsconfig.json') });
    })();
    // A failed load is tried again next time instead of being remembered.
    loading.catch(() => { loading = null; });
  }
  return loading;
}

export class ConversionError extends Error {
  constructor(message, lines = []) {
    super(message);
    this.name = 'ConversionError';
    this.code = 'conversion-failed';
    this.lines = lines;
  }
}

const headerKey = (fields) => fields.map((field) => field.normalize('NFKC').replace(/^\ufeff/, '').replace(/\s+/g, ' ').trim().toLowerCase()).join('\u0000');
const quote = (field) => `"${field.replace(/"/g, '""')}"`;

/**
 * One CSV from several statement exports of the same card: the first header, then every data row of each. Exports must
 * have the same columns. A single export is returned unchanged; empty exports (quiet statements) add nothing.
 */
export function mergeStatementCsvs(texts, parseCsv) {
  const parts = texts.filter((text) => typeof text === 'string' && text.trim() !== '');
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  let key = null;
  const lines = [];
  for (const text of parts) {
    let records;
    try {
      records = parseCsv(text);
    } catch (error) {
      throw new ConversionError(`a statement export is not valid CSV (${error?.name === 'CsvError' ? error.message : 'unreadable'})`);
    }
    if (records.length === 0) continue;
    const header = records[0].fields.map((field, index) => (index === 0 ? field.replace(/^\ufeff/, '') : field));
    if (key === null) {
      key = headerKey(header);
      lines.push(header.map(quote).join(','));
    } else if (headerKey(header) !== key) {
      throw new ConversionError('the statement exports have different columns; sync again');
    }
    for (const record of records.slice(1)) lines.push(record.fields.map(quote).join(','));
  }
  return key === null ? null : `${lines.join('\r\n')}\r\n`;
}

/** The tool's errors are value-free by design (line numbers and column names, never cell values); anything else is generic. */
function conversionError(error) {
  if (error instanceof ConversionError) return error;
  if (['ConvertError', 'CsvError', 'CardImportError', 'ExportFormatError', 'ExportDecodeError'].includes(error?.name)) {
    const lines = Array.isArray(error.problems)
      ? error.problems.slice(0, 5).map((problem) => `line ${problem.line}: ${String(problem.reason).slice(0, 200)}`)
      : [];
    return new ConversionError(String(error.message).slice(0, 300), lines);
  }
  return new ConversionError('the export could not be converted');
}

/**
 * Converts one card's statement exports (oldest first) into one payload. Every row is `posted`: the receiver asks
 * American Express for posted transactions only, for closed statements and for the current period alike. `coverage` is the
 * dates the exports were requested for; `owner` (alex, casey or joint) is a hint for the import dialog.
 */
export async function convertAmexStatements({ csvTexts, coverage = null, owner = null }) {
  const tool = await loadSharedTool();
  const merged = mergeStatementCsvs(csvTexts, tool.parseCsv);
  if (merged === null) return { empty: true };
  let result;
  try {
    result = tool.convertCardExport(new TextEncoder().encode(merged), {
      format: 'amex-csv', status: 'posted', ...(coverage ? { coverage } : {}),
    });
  } catch (error) {
    throw conversionError(error);
  }
  let payload = result.payload;
  if (owner !== null) {
    if (!OWNER_KEYS.includes(owner)) throw new ConversionError('invalid owner');
    const checked = tool.validateCardImportPayload({ ...payload, owner });
    if (!checked.ok) throw new ConversionError('the converted file did not pass validation');
    payload = checked.payload;
  }
  const json = tool.serializeCardImportPayload(payload);
  const report = result.report;
  return {
    empty: false,
    payload,
    json,
    report: {
      rowsRead: report.rowsRead,
      rows: payload.rows.length,
      redactedRows: report.redactedRows,
      droppedColumns: report.droppedColumns.length,
      memberColumn: report.memberColumn,
      coverageWidened: report.coverageWidened,
      warnings: report.warnings.length,
    },
  };
}
