/**
 * RFC 4180 CSV records with line numbers, tolerant of CRLF, LF or CR line
 * ends and strict about quoting, so a truncated or mangled file fails loudly
 * instead of shifting columns. Errors give line numbers, never cell values.
 */

export interface CsvRecord {
  /** 1-based line where the record starts. */
  line: number;
  fields: string[];
}

export interface CsvLimits {
  maxRecords: number;
  maxFields: number;
  maxFieldLength: number;
}

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = 'CsvError';
    this.line = line;
  }
}

export const DEFAULT_CSV_LIMITS: CsvLimits = { maxRecords: 10_002, maxFields: 64, maxFieldLength: 10_000 };

export function parseCsv(text: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const pushField = () => {
    if (field.length > limits.maxFieldLength) throw new CsvError(`a field is longer than ${limits.maxFieldLength} characters`, recordLine);
    fields.push(field);
    field = '';
    if (fields.length > limits.maxFields) throw new CsvError(`a record has more than ${limits.maxFields} fields`, recordLine);
  };
  const pushRecord = () => {
    pushField();
    records.push({ line: recordLine, fields });
    if (records.length > limits.maxRecords) throw new CsvError(`the file has more than ${limits.maxRecords} records`, recordLine);
    fields = [];
  };
  const newline = (): boolean => {
    if (text[i] === '\r') {
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (text[i] === '\n') {
      i += 1;
    } else {
      return false;
    }
    line += 1;
    return true;
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '"' && field === '') {
      const quoteLine = line;
      i += 1;
      for (;;) {
        if (i >= text.length) throw new CsvError('a quoted field is not closed (the file may be truncated)', quoteLine);
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (text[i] === '\r' || text[i] === '\n') {
          field += '\n';
          newline();
        } else {
          field += text[i];
          i += 1;
        }
        if (field.length > limits.maxFieldLength) {
          throw new CsvError(`a field is longer than ${limits.maxFieldLength} characters`, quoteLine);
        }
      }
      if (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
        throw new CsvError('unexpected text after a closing quote', line);
      }
      // An empty quoted field still counts as a field, so mark it with a sentinel-free push below.
      if (i >= text.length || text[i] === '\r' || text[i] === '\n') {
        pushRecord();
        if (i < text.length) newline();
        recordLine = line;
        continue;
      }
      pushField();
      i += 1;
      if (i >= text.length) pushRecord();
      continue;
    }
    if (char === ',') {
      pushField();
      i += 1;
      if (i >= text.length) pushRecord();
      continue;
    }
    if (char === '\r' || char === '\n') {
      pushRecord();
      newline();
      recordLine = line;
      continue;
    }
    field += char;
    i += 1;
    if (field.length > limits.maxFieldLength) throw new CsvError(`a field is longer than ${limits.maxFieldLength} characters`, recordLine);
    if (i >= text.length) pushRecord();
  }
  return records.filter((record) => record.fields.some((value) => value.trim() !== ''));
}
