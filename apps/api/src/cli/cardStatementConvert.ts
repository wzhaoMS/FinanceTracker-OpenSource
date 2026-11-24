import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  convertDiscoverStatements,
  DISCOVER_STATEMENT_PARSER,
  DiscoverConvertError,
  type DiscoverStatementFile,
} from '@finance-tracker/shared/card-import-tool';

import { pdfTextPages } from './checkingPdfText.js';
import type { Io } from './controlCommon.js';

export const CARD_STATEMENT_CONVERT_USAGE = `Usage: holdr-card-statement-convert --card LAST4 --dry-run [--accept-gaps] FILE...
       holdr-card-statement-convert --card LAST4 --out-dir NEW_DIR [--accept-gaps] [--skip-held] FILE...

Turns one Discover card's monthly statement PDFs (a Discover it card's statements: Discover offers these accounts no
transaction export) into one redacted holdr.card-import payload per statement, for the Spending tab's Import or the
API's /card-imports/preview and /card-imports/commit. Offline: no network, no database.

  --card LAST4       the card's last four digits; a statement for another card is held
  --dry-run          read and check every statement, print the report, write nothing
  --out-dir NEW_DIR  where the payloads go: a new directory (never reused), owner-only, one
                     discover-LAST4-<close date>.json per accepted statement
  --accept-gaps      accept every gap the report lists as missing history: the statement after a gap is written
                     instead of held (a gap's days stay uncovered; nothing proves them empty)
  --skip-held        write the accepted statements even when some are held (default: write nothing then)

Every statement must read whole and reconcile to the cent: its rows to its Account Summary, and Previous Balance to
New Balance; no line with a date or an amount may go unread, and no row may be printed twice. Statements must not
overlap, and adjacent ones must chain. A statement that does not hold is held, and the report says why. Prints a JSON
report of counts, dates, layouts, kinds, gaps and each payload's SHA-256: never an amount, balance, description or
card number.
`;

export const CARD_STATEMENT_CONVERT_EXIT = { ok: 0, refused: 1, usage: 64 } as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const VALUE_OPTIONS = ['--card', '--out-dir'] as const;
const FLAGS = ['--dry-run', '--accept-gaps', '--skip-held', '--help', '--version'] as const;

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

const canonical = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

/** One statement file as the converter takes it: its digest and its PDF's positioned text, or why it has none. */
async function readStatement(file: string, name: string): Promise<DiscoverStatementFile> {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { name, digest: `unread:${name}`, pages: [], unreadable: 'is not a readable file' };
  if (stat.size > MAX_FILE_BYTES) return { name, digest: `unread:${name}`, pages: [], unreadable: `is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` };
  const bytes = fs.readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return { name, digest, pages: [], unreadable: 'is not a PDF' };
  try {
    return { name, digest, pages: await pdfTextPages(bytes) };
  } catch (error) {
    // pdfTextPages's messages name no content of the file.
    return { name, digest, pages: [], unreadable: (error as Error).message };
  }
}

/** Writes the payloads into a new owner-only directory, each file new: nothing is ever replaced. */
function writePayloads(outDir: string, card: string, payloads: ReadonlyArray<{ period: { end: string }; json: string }>): string[] {
  fs.mkdirSync(outDir, { mode: 0o700 });
  const names: string[] = [];
  for (const payload of payloads) {
    const name = `discover-${card}-${payload.period.end}.json`;
    const fd = fs.openSync(path.join(outDir, name), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, payload.json);
    } finally {
      fs.closeSync(fd);
    }
    names.push(name);
  }
  return names;
}

/** `holdr-card-statement-convert`: the owner's offline converter of Discover statement PDFs. Returns the exit status. */
export async function runCardStatementConvertCli(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`holdr-card-statement-convert: ${(error as Error).message}\n${CARD_STATEMENT_CONVERT_USAGE}`);
    return CARD_STATEMENT_CONVERT_EXIT.usage;
  }
  if (args.flags.has('--help')) {
    io.stdout.write(CARD_STATEMENT_CONVERT_USAGE);
    return CARD_STATEMENT_CONVERT_EXIT.ok;
  }
  if (args.flags.has('--version')) {
    io.stdout.write(`${DISCOVER_STATEMENT_PARSER}\n`);
    return CARD_STATEMENT_CONVERT_EXIT.ok;
  }
  try {
    // Checked before any file is read, and never echoed: it could be a whole card number.
    const card = args.values.get('--card');
    if (card === undefined || !/^[0-9]{4}$/.test(card)) throw new UsageError('--card must be the card\'s last four digits');
    const outDir = args.values.get('--out-dir');
    const dryRun = args.flags.has('--dry-run');
    if ((outDir === undefined) === !dryRun) throw new UsageError('give --dry-run or --out-dir NEW_DIR (one of them)');
    if (args.files.length === 0) throw new UsageError('name at least one statement PDF');
    if (outDir !== undefined) {
      if (fs.lstatSync(outDir, { throwIfNoEntry: false })) throw new UsageError('--out-dir already exists; name a new directory');
      if (args.files.some((file) => canonical(file) === canonical(outDir))) throw new UsageError('--out-dir must not be one of the files');
    }
    const files: DiscoverStatementFile[] = [];
    for (const [index, file] of args.files.entries()) files.push(await readStatement(file, `file ${index + 1}`));
    const { report, payloads } = convertDiscoverStatements(files, { card, acceptGaps: args.flags.has('--accept-gaps') });
    const held = report.statements.held;
    const write = outDir !== undefined && (held === 0 || args.flags.has('--skip-held'));
    const written = write ? writePayloads(outDir!, card, payloads) : null;
    const output = {
      code: dryRun ? 'card-statements-dry-run' : written ? 'card-statements-converted' : 'card-statements-held',
      ...report,
      payloads: payloads.map((entry, index) => ({
        name: entry.name, period: entry.period, rows: entry.payload.rows.length,
        ...(written ? { file: written[index] } : {}),
        sha256: createHash('sha256').update(entry.json).digest('hex'),
      })),
    };
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (held > 0 && !args.flags.has('--skip-held')) {
      const gaps = report.statements.heldByReason['unproven-gap'] ?? 0;
      io.stderr.write(`holdr-card-statement-convert: ${held} of ${report.statements.read} statements were held`
        + `${outDir !== undefined ? ', so nothing was written' : ''} (see the report; --skip-held writes the others`
        + `${gaps > 0 ? `, --accept-gaps accepts the ${gaps} gap${gaps === 1 ? '' : 's'} before them as missing history` : ''})\n`);
      return CARD_STATEMENT_CONVERT_EXIT.refused;
    }
    return CARD_STATEMENT_CONVERT_EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`holdr-card-statement-convert: ${error.message}\n`);
      return CARD_STATEMENT_CONVERT_EXIT.usage;
    }
    if (error instanceof DiscoverConvertError) {
      io.stderr.write(`holdr-card-statement-convert: ${error.message}\n`);
      return CARD_STATEMENT_CONVERT_EXIT.refused;
    }
    const code = (error as { code?: unknown }).code;
    // Anything else may quote a file: only its type (or a file system error's code) leaves.
    io.stderr.write(`holdr-card-statement-convert: failed (${typeof code === 'string' && /^E[A-Z]{2,12}$/.test(code) ? code : error instanceof Error ? error.name : 'error'})\n`);
    return CARD_STATEMENT_CONVERT_EXIT.refused;
  }
}
