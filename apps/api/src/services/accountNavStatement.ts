import { PDFParse } from 'pdf-parse';

export interface ParsedAccountNavStatement {
  broker: 'schwab';
  statementPeriodStart: string;
  statementPeriodEnd: string;
  observedAt: string;
  nav: number;
  currency: 'USD';
  accountLast4: string;
  sourcePage: number;
}

const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4],
  ['may', 5], ['jun', 6], ['jul', 7], ['aug', 8],
  ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

export async function extractFirstPageTextFromPdf(data: Uint8Array): Promise<string> {
  let text: string;
  try {
    const parser = new PDFParse({ data });
    try {
      text = (await parser.getText({ partial: [1] })).text;
    } finally {
      await parser.destroy();
    }
  } catch {
    // pdf.js's messages can quote the document (a filter or font name, say), so none of them leaves.
    throw new Error('PDF could not be read');
  }
  if (!text.trim()) {
    throw new Error('PDF first page contains no extractable text');
  }
  return text;
}

/** Its refusals name what is wrong, never the statement's own text: the import routes answer with them. */
export function parseSchwabNavStatementText(text: string): ParsedAccountNavStatement {
  const normalized = text
    .replace(/\u00a0/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\r\n?/g, '\n');
  const flat = normalized.replace(/\s+/g, ' ').trim();

  if (!/\b(?:Charles\s+)?Schwab\b/i.test(flat)) {
    throw new Error('statement is not recognizably a Schwab document');
  }

  const period = flat.match(
    /Statement\s+Period\s+([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2})\s*,\s*(\d{4})/i,
  );
  if (!period) {
    throw new Error('Schwab statement period was not found');
  }
  const month = MONTHS.get(period[1].slice(0, 3).toLowerCase());
  if (!month) {
    throw new Error('unsupported Schwab statement month');
  }
  const year = Number(period[4]);
  const statementPeriodStart = formatDate(year, month, Number(period[2]), 'statement period start');
  const statementPeriodEnd = formatDate(year, month, Number(period[3]), 'statement period end');
  if (statementPeriodStart > statementPeriodEnd) {
    throw new Error('Schwab statement period start is after its end');
  }

  const accountLine = normalized.match(/Account\s+Number\s*\n\s*([^\n]+)/i)?.[1]
    ?? flat.match(/Account\s+Number\s+([*Xx\d -]*\d{4})\b/i)?.[1];
  const accountDigits = accountLine?.replace(/\D/g, '') ?? '';
  if (accountDigits.length < 4) {
    throw new Error('Schwab account number last four was not found');
  }

  const summaryStart = flat.search(/\bAccount\s+Summary\b/i);
  if (summaryStart < 0) {
    throw new Error('Schwab Account Summary was not found');
  }
  const summary = flat.slice(summaryStart, summaryStart + 600);
  const ending = summary.match(
    /Ending\s+Account\s+Value\s+as\s+of\s+(\d{1,2})\/(\d{1,2})\s+Beginning\s+Account\s+Value\s+as\s+of\s+\d{1,2}\/\d{1,2}\s+(\(?\s*-?\s*\$[\d,]+(?:\.\d{2})?\s*\)?)/i,
  );
  if (!ending) {
    throw new Error('Schwab period-ending Account Summary value was not found');
  }
  const observedAt = formatDate(year, Number(ending[1]), Number(ending[2]), 'account summary date');
  if (observedAt !== statementPeriodEnd) {
    throw new Error('Schwab Account Summary date does not match statement period end');
  }

  return {
    broker: 'schwab',
    statementPeriodStart,
    statementPeriodEnd,
    observedAt,
    nav: parseUsd(ending[3]),
    currency: 'USD',
    accountLast4: accountDigits.slice(-4),
    sourcePage: 1,
  };
}

function formatDate(year: number, month: number, day: number, label: string): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`invalid ${label}`);
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function parseUsd(raw: string): number {
  const compact = raw.replace(/\s+/g, '');
  const negative = compact.startsWith('(') || compact.startsWith('-');
  const value = Number(compact.replace(/[\-$,()]/g, ''));
  if (!Number.isFinite(value)) {
    throw new Error('invalid Schwab account value');
  }
  return negative ? -value : value;
}