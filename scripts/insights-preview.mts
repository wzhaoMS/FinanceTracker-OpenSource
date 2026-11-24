/**
 * Preview the Spending tab's insights on a COPY of a Holdr database, read-only: for each period (Month, 60 and 90
 * days, 6 and 12 months, year to date), how many findings of each kind there are, how many cards, and the kinds of the
 * cards a person would see first. The same engine and cards the tab uses (`computeCardInsights`,
 * `buildInsightCards`), with the API's own rows (pending and posted) and currency choice.
 *
 * Safe by default: it prints counts and kinds only, never a merchant, an amount, a card's title or a transaction's
 * date, so what it prints may go into a chat, a log or a report. Only with --values does it also produce the cards
 * themselves (titles, details and their rows: real merchants and amounts), and then only into --out: a file outside
 * this repository, in a directory that only the current user can change (for example one under your home), that the
 * current user alone can read. Never the terminal: nothing printed names a resolved path or repeats an error's own
 * text. Never share that file; delete it when done. The database is opened read-only and never written. Keep its copy,
 * too, in a folder only you can open, and delete the folder when done:
 *
 *   mkdir -m 700 ~/holdr-preview
 *   sqlite3 <data dir>/finance.db ".backup '$HOME/holdr-preview/finance.db'"
 *   npx tsx scripts/insights-preview.mts ~/holdr-preview/finance.db [--today YYYY-MM-DD]
 *     [--owner alex|casey|joint] [--top 6] [--values --out ~/holdr-preview/values.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  computeCardInsights,
  primaryCardCurrency,
  type CardInsightRow,
  type CardOwner,
  type CardSpendingInsights,
} from '../packages/shared/src/index.ts';
import { assertPrivateDirectory, assertTrustedAncestors, exactIdentityOrNull, identityOf } from '../apps/api/src/e2e/pathSafety.ts';
import { readCurrentUserSid, readWindowsAcls, restrictToUser as restrictDirectoryToUser, runCommand, system32 } from '../apps/api/src/e2e/windowsAcl.ts';
import { buildInsightCards, insightQuery, VISIBLE_INSIGHTS } from '../apps/web/src/components/spending/insightCards.ts';
import { SPENDING_PERIODS, spendingPeriodRange, todayIso } from '../apps/web/src/components/spending/spendingFormat.ts';
import { OwnerOnlyRefusal, writeOwnerOnlyFile } from './lib/owner-only-file.mjs';

const USAGE = 'usage: npx tsx scripts/insights-preview.mts <copy of finance.db> [--today YYYY-MM-DD] [--owner alex|casey|joint]'
  + ' [--top N] [--values --out <file outside the repository>]';
const OWNERS: readonly string[] = ['alex', 'casey', 'joint'];
const VALUE_OPTIONS: readonly string[] = ['--today', '--owner', '--top', '--out'];

function fail(message: string): never {
  console.error(`insights-preview: ${message}\n${USAGE}`);
  process.exit(2);
}

/**
 * What went wrong, safe to print: a refusal's fixed message, or an error code. Never an error's own text, which can
 * name a path, and a path can hold a merchant or an amount.
 */
function reason(error: unknown): string {
  if (error instanceof OwnerOnlyRefusal) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(?:E[A-Z0-9]+|SQLITE_[A-Z_]+)$/.test(code) ? code : 'unexpected error';
}

function stop(what: string, error: unknown): never {
  console.error(`insights-preview: ${what} (${reason(error)})`);
  process.exit(1);
}

// Whatever else goes wrong is reported the same way: never with its own text.
process.on('uncaughtException', (error) => stop('failed', error));

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** True when `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Options: strict, so a mistyped one never runs with a default it did not mean.
let file: string | undefined;
let values = false;
let countsOnly = false;
const given = new Map<string, string>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--values') values = true;
  else if (arg === '--counts-only') countsOnly = true;
  else if (VALUE_OPTIONS.includes(arg)) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
    if (given.has(arg)) fail(`${arg} is given twice`);
    given.set(arg, value);
    index += 1;
  } else if (arg.startsWith('-')) fail(/^--[a-z][a-z-]{0,30}$/.test(arg) ? `unknown option ${arg}` : 'unknown option');
  else if (file === undefined) file = arg;
  else fail('give one database file');
}
if (file === undefined) fail('give the database file');
if (values && countsOnly) fail('--values and --counts-only exclude each other');
if (values && !given.has('--out')) fail('--values needs --out <file>: values are written only to a file the current user alone can read, never printed');
if (!values && given.has('--out')) fail('--out is only for --values; without it only counts and kinds are printed');
const today = given.get('--today') ?? todayIso();
if (!isDate(today)) fail('--today must be a date, YYYY-MM-DD');
const owner = given.get('--owner') as CardOwner | undefined;
if (owner !== undefined && !OWNERS.includes(owner)) fail('--owner must be alex, casey or joint');
const topText = given.get('--top') ?? String(VISIBLE_INSIGHTS);
if (!/^\d{1,2}$/.test(topText)) fail('--top must be a whole number from 0 to 99');
const top = Number(topText);

// The database goes by one name, checked and opened alike: its canonical path, or nothing at all. better-sqlite3 trims
// the name it is given, so a name it would read differently is refused rather than checked under another one.
let database: string;
let databaseIdentity: string;
try {
  database = fs.realpathSync.native(path.resolve(file));
  const stats = fs.statSync(database, { bigint: true });
  if (!stats.isFile()) throw new Error('not a file');
  databaseIdentity = identityOf(stats);
} catch {
  fail('the database must be a file that exists');
}
if (database.trim() !== database) fail('the database name must not end in whitespace');

// Values go to a file outside this repository (so they can never be committed), in a directory no one else can change,
// and never over the database itself.
let out: string | undefined;
if (values) {
  const repository = fs.realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
  const requested = path.resolve(given.get('--out')!);
  let directory: string;
  try {
    directory = fs.realpathSync.native(path.dirname(requested));
  } catch {
    fail('--out must be in a directory that exists');
  }
  out = path.join(directory, path.basename(requested));
  if (within(repository, out)) fail('--out must be outside this repository, so values can never be committed');
  let existing: string | null;
  try {
    existing = exactIdentityOrNull(out);
  } catch {
    fail('--out could not be checked');
  }
  if (existing !== null) {
    if (!fs.lstatSync(out).isFile()) fail('--out must name a file');
    // By identity, not by name: a short name, another case or a hard link can name the database too.
    if (existing === databaseIdentity) fail('--out must not be the database');
  }
  try {
    assertTrustedAncestors(directory);
    assertPrivateDirectory(directory);
  } catch {
    fail('--out must be in a directory that only you can change, inside directories only you or the system can change (for example under your home)');
  }
}

let accounts: Array<{ id: string; owner: CardOwner; currency: string }>;
let rows: CardInsightRow[];
try {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  accounts = db.prepare('SELECT id, owner, currency FROM card_accounts').all() as Array<{ id: string; owner: CardOwner; currency: string }>;
  const owners = new Map(accounts.map((account) => [account.id, account.owner]));
  rows = (db.prepare(
    `SELECT id, card_account_id, transaction_date, status, amount_minor, currency, original_currency, kind, description, merchant,
            issuer_category, user_category
       FROM card_transactions WHERE status IN ('pending', 'posted') ORDER BY transaction_date, rowid`,
  ).all() as Array<Record<string, string | number | null>>)
    .map((row): CardInsightRow => ({
      id: String(row.id),
      cardAccountId: String(row.card_account_id),
      transactionDate: String(row.transaction_date),
      status: row.status as CardInsightRow['status'],
      amountMinor: Number(row.amount_minor),
      currency: String(row.currency),
      originalCurrency: row.original_currency === null ? null : String(row.original_currency),
      kind: row.kind as CardInsightRow['kind'],
      description: String(row.description),
      merchant: row.merchant === null ? null : String(row.merchant),
      issuerCategory: row.issuer_category === null ? null : String(row.issuer_category),
      userCategory: row.user_category === null ? null : String(row.user_category),
    }))
    .filter((row) => !owner || owners.get(row.cardAccountId) === owner);
  db.close();
} catch (error) {
  stop('could not read the database', error);
}

const currency = primaryCardCurrency(accounts, { owner });
const findings = (insights: CardSpendingInsights): Record<string, number> => ({
  largePurchases: insights.largePurchases?.count ?? 0,
  categoryChanges: insights.movers.length,
  merchantChanges: insights.merchantMovers.length,
  recurringStarted: insights.recurringChanges.started.length,
  recurringPriceUps: insights.recurringChanges.priceUps.length,
  recurringStopped: insights.recurringChanges.stopped.length,
  duplicates: insights.duplicates.length,
  newMerchants: insights.newMerchants.length,
  pendingRefunds: insights.pendingRefunds?.count ?? 0,
  pace: insights.pace ? 1 : 0,
});

// Printed: counts and kinds only. Kept for the file: the first `top` cards of each period, as the tab words them.
const periods: unknown[] = [];
console.log(`${rows.length} pending and posted rows on ${owner ?? 'all'} cards; ${currency}; today ${today}`);
for (const { id, label } of SPENDING_PERIODS) {
  const range = spendingPeriodRange(id, today.slice(0, 7), today);
  const { request, context } = insightQuery(id, range, today.slice(0, 7), today);
  const insights = computeCardInsights(rows, {
    month: request.month,
    today,
    currency,
    ...(request.from && request.to ? {
      period: {
        from: request.from,
        to: request.to,
        baseline: request.baselineFrom && request.baselineTo ? { from: request.baselineFrom, to: request.baselineTo } : null,
      },
    } : {}),
  });
  const cards = buildInsightCards(insights, context);
  const byKind: Record<string, number> = {};
  for (const card of cards) byKind[card.kind] = (byKind[card.kind] ?? 0) + 1;
  const first = cards.slice(0, top);
  console.log(`\n== ${label}: ${context.heading} (${insights.period.from} to ${insights.period.to})`);
  console.log(`   findings: ${Object.entries(findings(insights)).map(([kind, count]) => `${kind} ${count}`).join(', ')}`);
  console.log(`   cards: ${cards.length} (${Object.entries(byKind).map(([kind, count]) => `${kind} ${count}`).join(', ') || 'none'})`);
  console.log(`   first ${first.length}: ${first.map((card) => card.kind).join(', ') || 'none'}`);
  if (values) {
    periods.push({
      period: label,
      heading: context.heading,
      from: insights.period.from,
      to: insights.period.to,
      findings: findings(insights),
      cards: cards.length,
      cardsByKind: byKind,
      topCards: first.map((card) => ({
        kind: card.kind,
        title: card.title,
        detail: card.detail,
        items: card.items.map((item) => ({ label: item.label, amount: item.amount, note: item.note })),
      })),
    });
  }
}

if (out !== undefined) {
  const report = { generatedAt: new Date().toISOString(), today, owner: owner ?? 'all', currency, rows: rows.length, periods };
  try {
    writeOwnerOnlyFile(out, `${JSON.stringify(report, null, 2)}\n`, {
      windows: {
        currentUserSid: () => readCurrentUserSid(),
        restrictDirectory: (dir: string, sid: string) => restrictDirectoryToUser(dir, sid),
        restrictToUser: (target: string, sid: string) => runCommand(system32('icacls.exe'), [target, '/inheritance:r', '/grant:r', `*${sid}:F`]),
        readAcl: (target: string) => readWindowsAcls([target])[0],
      },
    });
  } catch (error) {
    stop('could not write --out; nothing was written', error);
  }
  console.log(`\nThe first ${top} cards of each period, with real merchants and amounts, are in the file given with --out,`
    + ' readable by you alone. Never share that file, and delete it when done.');
}
