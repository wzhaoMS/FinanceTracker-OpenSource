import fs from 'node:fs';
import path from 'node:path';

import { isCheckingDate } from '@finance-tracker/shared';
import {
  CHECKING_EXPORT_ADAPTERS,
  CHECKING_IMPORT_TOOL_PARSER,
  CheckingConvertError,
  CheckingExportFormatError,
  checkingCurrencyExponent,
  checkingExportAdapter,
  convertCheckingExports,
  decodeExport,
  detectCheckingExportAdapters,
  knownAccountDigits,
  maskKnownAccountDigits,
  parseAmount,
  type CheckingConvertInput,
  type CheckingConvertOptions,
  type CheckingExportAdapter,
  type CheckingExportInput,
  type ParsedCheckingExport,
} from '@finance-tracker/shared/checking-import-tool';

import { digest } from '../services/amazon/policy.js';
import { pdfTextPages } from './checkingPdfText.js';
import type { Io } from './controlCommon.js';

export const CHECKING_CONVERT_USAGE = `Usage: holdr-checking-convert --institution SLUG --label TEXT --out NEW_FILE [options] FILE...
       holdr-checking-convert --institution SLUG --label TEXT --dry-run [options] FILE...
       holdr-checking-convert --explain [--format SLUG] FILE...
       holdr-checking-convert --formats

Turns one checking account's bank exports (activity downloads and statement PDFs, any mix, overlaps allowed) into one
redacted holdr.checking-import payload for the Root-GO'd \`holdr-checking import\`. Offline: no network, no database.

  --institution SLUG            the bank: wellsfargo, fifththird, ...
  --label TEXT                  the account's display name, with no digits (e.g. "Wells Fargo Everyday Checking")
  --out NEW_FILE                where the payload goes: a new file (never overwritten), owner-only
  --account LAST4               the account number's last four digits; required when no file states them
  --format SLUG                 read every FILE as this format (default: recognized per file; see --formats)
  --through YYYY-MM-DD          the last day whose activity was complete when you downloaded (yesterday, if you
                                downloaded today); required for files that do not say when they were made (CSV)
  --from YYYY-MM-DD             the first day a single CSV speaks for (default: its first row's day)
  --expect-opening-balance AMT  single file only: the balance at the end of the day before its first day
  --expect-closing-balance AMT  single file only: the balance at the end of its last day
  --no-ledger-balance           leave an OFX ledger balance (LEDGERBAL) out of the checks
  --dry-run                     convert and check everything, print the report, write no payload
  --explain                     read the files and print what was found (counts and positions); write nothing

Prints a JSON report of counts, dates, checks passed and the payload digest: never an amount, balance, description
or account number. Refuses, writing nothing, when a row cannot be read, a stated balance does not add up, two files
disagree about a day, or stored text could still show card or account digits.
`;

export const CHECKING_CONVERT_EXIT = { ok: 0, refused: 1, usage: 64 } as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const VALUE_OPTIONS = ['--institution', '--label', '--out', '--account', '--format', '--through', '--from',
  '--expect-opening-balance', '--expect-closing-balance'] as const;
const FLAGS = ['--no-ledger-balance', '--explain', '--dry-run', '--formats', '--help', '--version'] as const;

class UsageError extends Error {}

interface Args {
  values: Map<string, string>;
  flags: Set<string>;
  files: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((VALUE_OPTIONS as readonly string[]).includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      if (values.has(arg)) throw new UsageError(`${arg} is given twice`);
      values.set(arg, value);
      i += 1;
    } else if ((FLAGS as readonly string[]).includes(arg)) flags.add(arg);
    else if (arg.startsWith('--')) throw new UsageError('unknown option');
    else files.push(arg);
  }
  return { values, flags, files };
}

/** A balance the owner copied from the bank, in the files' currency's minor units (cents, or whole yen). */
function balanceOption(raw: string | undefined, name: string, exponent: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseAmount(raw, exponent, { thousands: true, symbols: true });
  if (!parsed.ok) throw new UsageError(`${name} ${parsed.reason}`);
  return parsed.minor;
}

const canonical = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

/** What --explain may print of what an adapter read: only values of the expected shape, never other text of a file. */
const SHOWN_ACCOUNT_TYPES: readonly string[] = ['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CD'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shownDate = (value: string | null) => (value === null ? null : DATE.test(value) ? value : 'unreadable');
const shownCoverage = (value: { start: string; end: string } | null) =>
  (value === null ? null : DATE.test(value.start) && DATE.test(value.end) ? { start: value.start, end: value.end } : 'unreadable');

/**
 * Output fields that are structural (Root 02:31Z): left as they are only while they pass their exact pattern, and
 * guarded as text otherwise. A Map, so no other field name (`constructor`, say) can ever look one up.
 */
const STRUCTURAL = new Map<string, (value: string) => boolean>([
  ['start', isCheckingDate],
  ['end', isCheckingDate],
  ['madeAt', isCheckingDate],
  ['payloadDigest', (value) => /^[0-9a-f]{64}$/.test(value)],
  ['parser', (value) => value === CHECKING_IMPORT_TOOL_PARSER],
]);

/**
 * What is printed, with no five consecutive digits of a known account number left in the digit-only projection of any
 * text field, each field on its own and however the digits are split. Structural fields are left as they are: whole
 * numbers (counts, line numbers, positions), and the dates, payload digest and parser version that pass their exact
 * pattern (STRUCTURAL).
 */
function guarded(value: unknown, accounts: readonly string[], key?: string): unknown {
  if (accounts.length === 0) return value;
  if (typeof value === 'string') return key !== undefined && STRUCTURAL.get(key)?.(value) ? value : maskKnownAccountDigits(value, accounts);
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    const masked = maskKnownAccountDigits(String(value), accounts);
    return masked === String(value) ? value : masked;
  }
  if (Array.isArray(value)) return value.map((item) => guarded(item, accounts));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, guarded(item, accounts, name)]));
  }
  return value;
}

/** A message for stderr, each of its lines (one diagnostic each) guarded on its own: lines are never joined first. */
const guardedLines = (message: string, accounts: readonly string[]) =>
  message.split('\n').map((line) => maskKnownAccountDigits(line, accounts)).join('\n');

/**
 * Root 04:08Z: when some file's account numbers are unknown (an adapter refused it before reading them all, or no
 * adapter read it), no diagnostic of the run may carry a digit taken from any file. Text is printed with every number
 * as `#`, keeping only the converter's own labels (`file 2`, `3 files were refused`); structural fields stay (whole
 * numbers, and dates, digest and parser version that pass their exact pattern).
 */
const FIXED_LABEL = /^(\s*(?:[0-9]+ files were refused:|file [0-9]+:?))/;
const fixedLine = (line: string) => {
  const label = FIXED_LABEL.exec(line)?.[1] ?? '';
  return label + line.slice(label.length).replace(/\p{N}+/gu, '#');
};
const fixedLines = (message: string) => message.split('\n').map(fixedLine).join('\n');
function fixedLabels(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'name' && /^file [0-9]+$/.test(value)) return value;
    return key !== undefined && STRUCTURAL.get(key)?.(value) ? value : value.replace(/\p{N}+/gu, '#');
  }
  if (Array.isArray(value)) return value.map((item) => fixedLabels(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fixedLabels(item, name)]));
  }
  return value;
}

/** The digits of every account number the files name: those parsed, and those an adapter read before it refused. */
const accountsOf = (parsed: readonly ParsedCheckingExport[], refusedNumbers: readonly string[]) =>
  knownAccountDigits([...parsed, { accountNumberRaw: null, otherAccountNumbersRaw: [...refusedNumbers] }]);

async function readInput(file: string, name: string): Promise<CheckingExportInput> {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new CheckingConvertError(`${name}: is not a readable file`);
  if (stat.size > MAX_FILE_BYTES) throw new CheckingConvertError(`${name}: is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    try {
      return { kind: 'pdf', pages: await pdfTextPages(bytes) };
    } catch (error) {
      throw new CheckingConvertError(`${name}: ${(error as Error).message}`);
    }
  }
  try {
    return { kind: 'text', text: decodeExport(bytes).text };
  } catch {
    throw new CheckingConvertError(`${name}: is neither a PDF nor readable text`);
  }
}

function adapterFor(input: CheckingExportInput, name: string, format: string | undefined): CheckingExportAdapter {
  if (format !== undefined) {
    const adapter = checkingExportAdapter(format);
    if (!adapter) throw new UsageError('--format names no known format; see --formats');
    if (adapter.input !== input.kind) throw new CheckingConvertError(`${name}: is ${input.kind === 'pdf' ? 'a PDF' : 'text'}, not a ${format} file`);
    return adapter;
  }
  const found = detectCheckingExportAdapters(input);
  if (found.length === 1) return found[0];
  throw new CheckingConvertError(found.length === 0
    ? `${name}: is not a format this tool recognizes; pass --format (see --formats)`
    : `${name}: could be ${found.map((adapter) => adapter.source).join(' or ')}; pass --format`);
}

function formatsText(): string {
  return `${CHECKING_EXPORT_ADAPTERS.map((adapter) => `  ${adapter.source.padEnd(14)} ${adapter.institution ?? 'any bank'}: ${adapter.description}`).join('\n')}\n`;
}

/** `holdr-checking-convert`: the owner's offline converter. Returns the exit status. */
export async function runCheckingConvertCli(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`holdr-checking-convert: ${(error as Error).message}\n${CHECKING_CONVERT_USAGE}`);
    return CHECKING_CONVERT_EXIT.usage;
  }
  if (args.flags.has('--help')) {
    io.stdout.write(CHECKING_CONVERT_USAGE);
    return CHECKING_CONVERT_EXIT.ok;
  }
  if (args.flags.has('--version')) {
    io.stdout.write(`${CHECKING_IMPORT_TOOL_PARSER}\n`);
    return CHECKING_CONVERT_EXIT.ok;
  }
  if (args.flags.has('--formats')) {
    io.stdout.write(formatsText());
    return CHECKING_CONVERT_EXIT.ok;
  }
  // Every account number the files name, as they are read: no output, a refusal included, shows five of its digits.
  let accounts: string[] = [];
  // Set when some file's account numbers are unknown (Root 04:08Z): every diagnostic is then printed with fixed labels.
  let identityUnknown = false;
  try {
    if (args.files.length === 0) throw new UsageError('name at least one FILE');
    // Checked before any file is read, and never echoed: it could be a whole account or card number.
    const account = args.values.get('--account');
    if (account !== undefined && !/^[0-9]{4}$/.test(account)) throw new UsageError('--account must be the last four digits of the account number');
    const names = args.files.map((_, index) => `file ${index + 1}`);
    const format = args.values.get('--format');
    if (args.flags.has('--explain')) {
      const files: Array<Record<string, unknown>> = [];
      const parsedFiles: ParsedCheckingExport[] = [];
      const refusedNumbers: string[] = [];
      for (const [index, file] of args.files.entries()) {
        try {
          const input = await readInput(file, names[index]);
          const adapter = adapterFor(input, names[index], format);
          const entry: Record<string, unknown> = { name: names[index], format: adapter.source };
          if (adapter.describe) entry.layout = adapter.describe(input);
          try {
            const parsed = adapter.parse(input, { accountLast4: account });
            parsedFiles.push(parsed);
            Object.assign(entry, {
              rows: parsed.rows.length, pendingRows: parsed.rows.filter((row) => row.pending).length,
              problems: parsed.problems.slice(0, 20), coverage: shownCoverage(parsed.coverage), madeAt: shownDate(parsed.madeAt),
              statesStatementBalances: parsed.statement !== null, statesLedgerBalance: parsed.ledgerBalance !== null,
              runningBalances: parsed.rows.filter((row) => row.runningBalanceMinor !== null).length,
              accountLast4: parsed.accountLast4 === null ? null : /^[0-9]{4}$/.test(parsed.accountLast4) ? parsed.accountLast4 : 'unreadable',
              accountType: parsed.accountType === null ? null : SHOWN_ACCOUNT_TYPES.includes(parsed.accountType) ? parsed.accountType : 'other',
              notes: parsed.notes,
            });
          } catch (error) {
            if (!(error instanceof CheckingExportFormatError)) throw error;
            refusedNumbers.push(...error.accountNumbersRaw);
            if (!error.identityKnown) identityUnknown = true;
            entry.refused = error.message;
          }
          files.push(entry);
        } catch (error) {
          if (!(error instanceof CheckingConvertError)) throw error;
          // No adapter read this file, so the account numbers it may name are unknown.
          identityUnknown = true;
          files.push({ name: names[index], refused: error.message });
        }
        accounts = accountsOf(parsedFiles, refusedNumbers);
      }
      // Printed once every file is read, so a number one file names is kept out of what is shown for every file, and
      // with fixed labels only when some file's numbers are unknown.
      const explained = { code: 'checking-explained', files };
      io.stdout.write(`${JSON.stringify(guarded(identityUnknown ? fixedLabels(explained) : explained, accounts), null, 2)}\n`);
      return CHECKING_CONVERT_EXIT.ok;
    }

    const institution = args.values.get('--institution');
    const label = args.values.get('--label');
    const out = args.values.get('--out');
    const dryRun = args.flags.has('--dry-run');
    if (!institution || !label || (!out && !dryRun)) throw new UsageError('--institution, --label and --out (or --dry-run) are required');
    if (out && dryRun) throw new UsageError('--dry-run writes nothing; leave out --out');
    if (out && args.files.some((file) => canonical(file) === canonical(out))) throw new UsageError('--out must not be one of the files');
    if (out && fs.lstatSync(out, { throwIfNoEntry: false })) throw new UsageError('--out already exists; name a new file');
    if (/\p{N}/u.test(label.normalize('NFKC'))) throw new UsageError('--label must not contain digits');
    const expectOpening = args.values.get('--expect-opening-balance');
    const expectClosing = args.values.get('--expect-closing-balance');
    // Read as amounts before any file is: the exact minor units follow once the files say their currency.
    balanceOption(expectOpening, '--expect-opening-balance', 3);
    balanceOption(expectClosing, '--expect-closing-balance', 3);
    const inputs: CheckingConvertInput[] = [];
    const refusedNumbers: string[] = [];
    const refused: string[] = [];
    for (const [index, file] of args.files.entries()) {
      try {
        const input = await readInput(file, names[index]);
        const adapter = adapterFor(input, names[index], format);
        inputs.push({ name: names[index], parsed: adapter.parse(input, { accountLast4: account }) });
      } catch (error) {
        if (error instanceof CheckingExportFormatError) {
          refusedNumbers.push(...error.accountNumbersRaw);
          if (!error.identityKnown) identityUnknown = true;
          refused.push(`${names[index]}: ${error.message}`);
        } else if (error instanceof CheckingConvertError) {
          // No adapter read this file, so the account numbers it may name are unknown.
          identityUnknown = true;
          refused.push(error.message);
        } else throw error;
      }
      accounts = accountsOf(inputs.map((entry) => entry.parsed), refusedNumbers);
    }
    // Every file is read before a refusal is printed, so a number one file names is kept out of another's message.
    if (refused.length === 1) throw new CheckingConvertError(refused[0]);
    if (refused.length > 1) throw new CheckingConvertError(`${refused.length} files were refused`, refused);
    // The balances the owner copied are in the files' currency: cents for dollars, whole yen for yen.
    const exponent = checkingCurrencyExponent(inputs[0].parsed.currency);
    if ((expectOpening !== undefined || expectClosing !== undefined) && exponent === null) {
      throw new UsageError('--expect-opening-balance and --expect-closing-balance need a currency whose minor unit this tool knows; the files are in another');
    }
    const options: CheckingConvertOptions = {
      institution,
      label,
      accountLast4: account,
      through: args.values.get('--through'),
      from: args.values.get('--from'),
      expectOpeningBalanceMinor: balanceOption(expectOpening, '--expect-opening-balance', exponent ?? 2),
      expectClosingBalanceMinor: balanceOption(expectClosing, '--expect-closing-balance', exponent ?? 2),
      useLedgerBalance: !args.flags.has('--no-ledger-balance'),
    };
    const { payload, report } = convertCheckingExports(inputs, options);
    if (out) {
      const fd = fs.openSync(out, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
      } finally {
        fs.closeSync(fd);
      }
    }
    io.stdout.write(`${JSON.stringify(guarded({ code: out ? 'checking-converted' : 'checking-dry-run', parser: CHECKING_IMPORT_TOOL_PARSER, ...report,
      payloadDigest: digest(payload) }, accounts), null, 2)}\n`);
    return CHECKING_CONVERT_EXIT.ok;
  } catch (error) {
    // Each line of a message on its own: with fixed labels only when some file's account numbers are unknown.
    const shown = (message: string) => guardedLines(identityUnknown ? fixedLines(message) : message, accounts);
    if (error instanceof UsageError) {
      io.stderr.write(`holdr-checking-convert: ${shown(error.message)}\n`);
      return CHECKING_CONVERT_EXIT.usage;
    }
    if (error instanceof CheckingConvertError) {
      io.stderr.write(`holdr-checking-convert: ${shown(error.message)}\n`);
      return CHECKING_CONVERT_EXIT.refused;
    }
    // Anything else may quote a file: only its type leaves.
    io.stderr.write(`holdr-checking-convert: failed (${error instanceof Error ? error.name : 'error'})\n`);
    return CHECKING_CONVERT_EXIT.refused;
  }
}
