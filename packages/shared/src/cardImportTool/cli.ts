/**
 * Command-line front end of the offline card-import tool. Platform access is
 * injected (`CliIo`), so this module, like everything it imports, has no
 * file system, network or process access of its own; `main.ts` wires it to
 * Node's file system. Output never contains raw export text, file names,
 * card numbers or card member names.
 */
import { CARD_IMPORT_FORMAT, CARD_IMPORT_VERSION, isCardImportDate, sanitizeCardText, type CardImportRowStatus, type CardImportSummary } from '../cardImport.js';
import { CARD_DEDUPE_VERSION } from '../cardDedupe.js';
import type { CardOwner, CardTransactionKind } from '../types.js';
import { formatMinor } from './amount.js';
import type { DateOrder } from './amexCsv.js';
import {
  CARD_IMPORT_TOOL_VERSION,
  ConvertError,
  convertCardExport,
  EXPORT_FORMATS,
  LOAN_PAYMENT_CHOICES,
  type ConvertOptions,
  type ConvertReport,
  type ExportFormat,
  type ExpectedTotals,
  type HousingReport,
  type LoanPaymentsChoice,
  type MemberMapping,
} from './convert.js';
import type { ExportEncoding } from './decode.js';
import type { OfxSign } from './ofx.js';

export interface CliIo {
  /** Reads a regular file of at most `maxBytes`; throws a value-free Error otherwise. */
  readFile(path: string, maxBytes: number): Uint8Array;
  /** Writes with owner-only permissions; refuses to replace an existing file unless `overwrite`. */
  writeFile(path: string, text: string, overwrite: boolean): void;
  samePath(a: string, b: string): boolean;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, mismatch: 3 } as const;

const NAME = 'holdr-card-import';
const OWNERS: readonly CardOwner[] = ['alex', 'casey', 'joint'];
const VALUE_OPTIONS = new Set([
  'out', 'issuer', 'currency', 'encoding', 'date-format', 'member', 'card', 'from', 'to', 'ofx-sign',
  'status', 'closed-through', 'loan-payments',
  'expect-charges', 'expect-credits', 'expect-net', 'expect-previous-balance', 'expect-new-balance',
]);
const FLAG_OPTIONS = new Set(['allow-mismatch', 'skip-invalid', 'ignore-ids', 'force', 'quiet', 'help', 'version']);
const REPEATABLE = new Set(['member', 'card']);

export const USAGE = `Usage: ${NAME} <format> <export-file> [--out FILE] [options]

Turns an issuer export into Holdr's redacted card-import JSON, offline.

Formats:
  amex-csv   American Express CSV (with or without "additional transaction details")
  ofx        OFX 1.x/2.x, QFX or QBO credit card statement (any issuer)
  bilt-csv   Bilt Card CSV from bilt.com (Download as CSV; issued by Cardless since 2026-02-07)
  wf-csv     Wells Fargo "Download Account Activity" CSV of a credit card (up to 25 months; QFX reaches 18)

Output:
  --out FILE                 write the JSON to FILE (owner-only permissions); default: standard output
  --force                    replace FILE if it exists
  --quiet                    no summary

Export:
  --issuer SLUG              issuer slug, e.g. chase, citi, wellsfargo (required for ofx)
  --currency CODE            account currency (amex-csv, bilt-csv and wf-csv default USD; ofx must match CURDEF)
  --encoding auto|utf-8|windows-1252   default auto (UTF-8, else Windows-1252)
  --date-format mdy|dmy|ymd  CSV date order (amex-csv and wf-csv default mdy, as in US exports; bilt-csv reads
                             ISO dates, and slash dates as mdy)
  --ofx-sign standard|inverted   OFX or wf-csv amount sign (standard: charges are negative)
  --card LAST4               keep only this card's rows (amex-csv Account #) or statement (ofx); repeatable
  --member "NAME=OWNER"      map a Card Member to alex, casey or joint; names are never written; repeatable
  --from YYYY-MM-DD --to YYYY-MM-DD   dates the export was requested for (default: the file's own range)
  --ignore-ids               match rows by content instead of the issuer's Reference/FITID
  --skip-invalid             drop unreadable rows (counted as rejected) instead of stopping

Housing payments (bilt-csv; required when the export marks any, nothing in it decides this):
  --loan-payments spending       rent or a loan paid through the card counts as spending (purchases)
  --loan-payments not-spending   listed, never counted (kind other, like a balance transfer)

Statement period (required: nothing in an export proves that its statement has closed):
  --status posted            every row posted: the export is a statement that has closed
  --status pending           every row pending: activity of a period that has not closed, whose charges can
                             still change or be cancelled; not spending until the closed statement's import
                             posts them
  --status export            bilt-csv: every row posted, as its Posted Date shows (a row without one refuses the file)
  --closed-through YYYY-MM-DD   ofx and bilt-csv: the newest statement closing date; rows posted after it are
                             pending, the rest posted. Refused when not before the day the file was made.
                             Without one of these nothing is written. With --status posted, an OFX file whose
                             dates reach the day it was made gets a warning; an Amex CSV states no such dates,
                             and a Bilt CSV whose Status marks a row pending refuses it.

Statement check (amounts as printed on the statement):
  --expect-charges AMOUNT    new charges including fees and interest
  --expect-credits AMOUNT    payments and credits
  --expect-net AMOUNT        new balance minus previous balance
  --expect-previous-balance AMOUNT --expect-new-balance AMOUNT
                             (ofx: the new balance defaults to the ledger balance when it is as of --to/DTEND
                             and no row is pending)
  --allow-mismatch           write the JSON even if a statement figure does not match

Exit status: 0 written, 1 error, 2 usage error, 3 statement mismatch (nothing written).
`;

class UsageError extends Error {}

interface ParsedArgs {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '--') {
      parsed.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (FLAG_OPTIONS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
      parsed.flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option --${/^[a-z-]{1,30}$/.test(name) ? name : '?'}`);
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      value = argv[i + 1];
      i += 1;
    }
    const list = parsed.values.get(name) ?? [];
    if (list.length > 0 && !REPEATABLE.has(name)) throw new UsageError(`--${name} may be given once`);
    list.push(value);
    parsed.values.set(name, list);
  }
  return parsed;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], option: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${option} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function toOptions(args: ParsedArgs, format: ExportFormat): ConvertOptions {
  const single = (name: string) => args.values.get(name)?.[0];
  const members: MemberMapping[] = (args.values.get('member') ?? []).map((entry) => {
    const eq = entry.lastIndexOf('=');
    const owner = entry.slice(eq + 1).trim().toLowerCase();
    if (eq <= 0 || !(OWNERS as readonly string[]).includes(owner)) throw new UsageError('--member must look like "NAME=alex", "NAME=casey" or "NAME=joint"');
    return { name: entry.slice(0, eq), owner: owner as CardOwner };
  });
  const from = single('from');
  const to = single('to');
  if ((from === undefined) !== (to === undefined)) throw new UsageError('--from and --to must be given together');
  if (from !== undefined && to !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to)) {
    throw new UsageError('--from and --to must be YYYY-MM-DD dates, --from first');
  }
  const expected: ExpectedTotals = {
    charges: single('expect-charges'),
    credits: single('expect-credits'),
    net: single('expect-net'),
    previousBalance: single('expect-previous-balance'),
    newBalance: single('expect-new-balance'),
  };
  const currency = single('currency');
  if (currency !== undefined && !/^[A-Za-z]{3}$/.test(currency)) throw new UsageError('--currency must be a three-letter code');
  const statusChoices: Array<CardImportRowStatus | 'export'> = format === 'bilt-csv' ? ['posted', 'pending', 'export'] : ['posted', 'pending'];
  const status = oneOf<CardImportRowStatus | 'export'>(single('status'), statusChoices, 'status') ?? null;
  const closedThrough = single('closed-through') ?? null;
  if (closedThrough !== null && !isCardImportDate(closedThrough)) throw new UsageError('--closed-through must be a YYYY-MM-DD date');
  if (status !== null && closedThrough !== null) throw new UsageError('--status and --closed-through cannot be used together');
  const loanPayments = oneOf<LoanPaymentsChoice>(single('loan-payments'), LOAN_PAYMENT_CHOICES, 'loan-payments') ?? null;
  if (loanPayments !== null && format !== 'bilt-csv') throw new UsageError('--loan-payments applies to bilt-csv only');
  return {
    format,
    issuer: single('issuer')?.trim().toLowerCase(),
    currency: currency?.toUpperCase(),
    encoding: oneOf<ExportEncoding>(single('encoding'), ['auto', 'utf-8', 'windows-1252'], 'encoding'),
    dateOrder: oneOf<DateOrder>(single('date-format'), ['mdy', 'dmy', 'ymd'], 'date-format'),
    ofxSign: oneOf<OfxSign>(single('ofx-sign'), ['standard', 'inverted'], 'ofx-sign') ?? null,
    members,
    cards: (args.values.get('card') ?? []).map((card) => card.trim()),
    coverage: from && to ? { start: from, end: to } : null,
    expected,
    skipInvalid: args.flags.has('skip-invalid'),
    ignoreIds: args.flags.has('ignore-ids'),
    status,
    closedThrough,
    loanPayments,
  };
}

function money(minor: number, report: ConvertReport): string {
  return formatMinor(minor, report.exponent);
}

function describeSummary(label: string, summary: CardImportSummary, report: ConvertReport): string[] {
  const kinds = (Object.keys(summary.byKind) as CardTransactionKind[])
    .filter((kind) => summary.byKind[kind].count > 0)
    .map((kind) => `${kind} ${summary.byKind[kind].count}: ${money(summary.byKind[kind].amountMinor, report)}`);
  return [
    `${label}: ${summary.count} rows, charges ${money(summary.chargesMinor, report)}, credits ${money(summary.creditsMinor, report)}, net ${money(summary.netMinor, report)}`,
    ...(kinds.length > 0 ? [`  ${kinds.join(' | ')}`] : []),
  ];
}

function describeStatus(report: ConvertReport): string {
  const { status } = report;
  if (status.posted + status.pending === 0) return 'Status: no rows';
  if (status.basis === 'export') {
    return `Status: as the export marks each row (--status export): ${status.posted} settled rows posted, `
      + `${status.pending} pending rows pending`;
  }
  if (status.basis === 'closed-through') {
    return `Status: --closed-through ${status.closedThrough}: ${status.posted} rows posted on or before it are posted, `
      + `${status.pending} rows posted after it are pending`;
  }
  if (status.status === 'pending') {
    return 'Status: every row pending (--status pending): not counted as spending until the closed statement\'s import posts them';
  }
  const word = 'Status: every row posted (--status posted), on your word that its statement has closed';
  if (status.period === 'unknown') return `${word}; this export does not say when it was made, so nothing in it can confirm that`;
  if (status.period === 'closed') {
    return `${word}; its dates run to ${status.reaches}, before the day it was made (${status.madeAt}), which does not prove it either`;
  }
  return `${word} (see the warning)`;
}

function describeHousing(housing: HousingReport, report: ConvertReport): string {
  if (housing.count === 0) return 'Housing payments: none marked in this export';
  const how = housing.choice === 'spending'
    ? 'counted as spending (--loan-payments spending: purchases, a negative one its refund)'
    : 'not spending (--loan-payments not-spending: kind other, listed, never counted)';
  return `Housing payments: ${housing.count} rows (${housing.posted} posted, ${housing.pending} pending), charges `
    + `${money(housing.chargesMinor, report)}, credits ${money(housing.creditsMinor, report)}: ${how}`;
}

function summarize(result: ReturnType<typeof convertCardExport>): string {
  const { payload, report } = result;
  const lines = [
    `${NAME} ${CARD_IMPORT_TOOL_VERSION}: ${report.format}, issuer ${payload.issuer}, ${report.currency}, read as ${report.encoding}`,
    `Rows: ${report.rowsRead} read, ${payload.rows.length} kept, ${payload.rejectedCount} rejected${report.excludedByCard > 0 ? `, ${report.excludedByCard} other cards excluded` : ''}`,
  ];
  for (const problem of report.rejected.slice(0, 20)) lines.push(`  rejected line ${problem.line}: ${problem.reason}`);
  if (report.droppedColumns.length > 0) lines.push(`Dropped columns: ${report.droppedColumns.join(', ')}`);
  if (report.memberColumn === 'dropped') lines.push('Card Member: dropped (no --member mapping; names are never written)');
  if (report.memberColumn === 'mapped') {
    const owners = Object.entries(report.owners).map(([owner, count]) => `${owner} ${count}`).join(', ');
    lines.push(`Card Member: mapped (${owners}); owner hint ${payload.owner ?? 'none'}`);
  }
  const cards = Object.entries(report.cards).sort(([a], [b]) => (a < b ? -1 : 1)).map(([last4, count]) => `${last4} (${count})`);
  if (cards.length > 0) lines.push(`Cards (last 4): ${cards.join(', ')}`);
  lines.push(`Covers: ${payload.coverage.start} to ${payload.coverage.end}`);
  lines.push(describeStatus(report));
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  if (report.housing) lines.push(describeHousing(report.housing, report));
  lines.push(...describeSummary('Posted', payload.totals.posted, report));
  for (const month of report.byMonth) lines.push(`  ${month.month}: ${month.count} rows, net ${money(month.netMinor, report)}`);
  if (payload.totals.pending.count > 0) {
    lines.push(...describeSummary('Pending (not spending)', payload.totals.pending, report));
    for (const month of report.pendingByMonth) lines.push(`  ${month.month}: ${month.count} rows, net ${money(month.netMinor, report)}`);
  }
  if (report.redactedRows > 0) lines.push(`Redacted: card numbers or long digit runs removed from ${report.redactedRows} rows`);
  if (report.ledger) lines.push(`OFX ledger balance: ${money(report.ledger.amountMinor, report)} owed as of ${report.ledger.asOf}`);
  const { reconciliation } = report;
  if (reconciliation.status === 'unchecked') {
    lines.push('Statement check: not done (pass --expect-* figures from the statement to check the totals)');
  } else {
    lines.push(`Statement check: ${reconciliation.status === 'match' ? 'MATCH' : 'MISMATCH'}`);
    for (const check of reconciliation.checks) {
      lines.push(`  ${check.check}: expected ${money(check.expectedMinor, report)}, computed ${money(check.actualMinor, report)}`
        + `${check.ok ? '' : ` (off by ${money(check.differenceMinor, report)})`}`);
    }
  }
  for (const note of report.notes) lines.push(`Note: ${note}`);
  return `${lines.join('\n')}\n`;
}

function errorText(error: unknown): string {
  if (error instanceof Error && /^(?:ConvertError|ExportFormatError|ExportDecodeError|CsvError|CardImportError)$/.test(error.name)) {
    const problems = (error as { problems?: Array<{ line: number; reason: string }> }).problems ?? [];
    const detail = problems.map((problem) => `\n  ${problem.line > 0 ? `line ${problem.line}: ` : ''}${problem.reason}`).join('');
    return `${error.message}${detail}`;
  }
  // Anything else is a bug; its message could quote input, so only the type is shown.
  return `unexpected ${error instanceof Error ? error.name : 'error'}`;
}

/** Runs the tool; returns the process exit status. */
export function runCardImportCli(argv: readonly string[], io: CliIo): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`${NAME}: ${(error as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (args.flags.has('help')) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (args.flags.has('version')) {
    io.stdout(`${NAME} ${CARD_IMPORT_TOOL_VERSION} (${CARD_IMPORT_FORMAT} v${CARD_IMPORT_VERSION}, dedupe v${CARD_DEDUPE_VERSION})\n`);
    return EXIT.ok;
  }
  let options: ConvertOptions;
  let inputPath: string;
  try {
    const [format, input, ...rest] = args.positional;
    if (!format || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw new UsageError(`the first argument must be ${EXPORT_FORMATS.slice(0, -1).join(', ')} or ${EXPORT_FORMATS[EXPORT_FORMATS.length - 1]}`);
    }
    if (!input) throw new UsageError('give the export file to read');
    if (rest.length > 0) throw new UsageError('expected one export file');
    inputPath = input;
    options = toOptions(args, format as ExportFormat);
  } catch (error) {
    io.stderr(`${NAME}: ${(error as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const out = args.values.get('out')?.[0];
  const quiet = args.flags.has('quiet');
  try {
    if (out !== undefined && io.samePath(out, inputPath)) throw new ConvertError('--out must not be the export file');
    let bytes: Uint8Array;
    try {
      bytes = io.readFile(inputPath, 20 * 1024 * 1024);
    } catch (error) {
      throw new ConvertError(`cannot read the export file: ${(error as Error).message}`);
    }
    const result = convertCardExport(bytes, options);
    if (!quiet) {
      io.stderr(summarize(result));
    } else {
      // --quiet drops the summary, never a warning.
      for (const warning of result.report.warnings) io.stderr(`${NAME}: warning: ${warning}\n`);
    }
    if (result.report.reconciliation.status === 'mismatch' && !args.flags.has('allow-mismatch')) {
      io.stderr(`${NAME}: the statement figures do not match the export, so nothing was written. `
        + 'Check that the export covers the whole statement, or re-run with --allow-mismatch.\n');
      return EXIT.mismatch;
    }
    if (out === undefined) {
      io.stdout(result.json);
    } else {
      try {
        io.writeFile(out, result.json, args.flags.has('force'));
      } catch (error) {
        throw new ConvertError(`cannot write --out: ${(error as Error).message}`);
      }
      if (!quiet) io.stderr(`Wrote ${sanitizeCardText(out, 1000) ?? 'the output file'}\n`);
    }
    return EXIT.ok;
  } catch (error) {
    io.stderr(`${NAME}: error: ${errorText(error)}\n`);
    return EXIT.failed;
  }
}
