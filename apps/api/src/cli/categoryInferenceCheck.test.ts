import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { CARD_CATEGORY_RULES, CARD_CATEGORY_RULES_RETARGETED, CARD_CATEGORY_RULES_VERSION } from '@finance-tracker/shared';

import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { countCategoryInference, formatCategoryInferenceCounts, runCategoryInferenceCheck } from './categoryInferenceCheck.js';

let root: string;
let dataDir: string;
let file: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'category-inference-check-')));
  dataDir = path.join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  file = path.join(dataDir, 'finance.db');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Synthetic merchants and endings only.
function row(day: number, description: string, patch: Partial<CardImportRow> = {}): CardImportRow {
  const date = `2026-09-${String(day).padStart(2, '0')}`;
  return {
    transactionDate: date, postedDate: date, status: 'posted', amountMinor: 1000 + day, currency: 'USD',
    kind: 'purchase', description, merchant: null, issuerCategory: null, ...patch,
  };
}

/** An issuer-categorized card with merchant history, and a statement-file card with none of its own. */
function seed() {
  const repo = new SqliteStateRepo({ file });
  try {
    const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Sample Gold', last4: '0001', currency: 'USD' });
    const chase = repo.createCardAccount({ issuer: 'chase', owner: 'casey', nickname: 'Sample Visa', last4: '0002', currency: 'USD' });
    const groceries = { issuerCategory: 'Merchandise & Supplies-Groceries' };
    const books = { issuerCategory: 'Merchandise & Supplies-Book Stores' };
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', rows: [
        row(1, 'NORTHWIND GROCERY', groceries), row(2, 'NORTHWIND GROCERY', groceries), row(3, 'NORTHWIND GROCERY', groceries),
        row(4, 'LITWARE STORE', groceries), row(5, 'LITWARE STORE', books),
        row(6, 'FABRIKAM BOOKS', books),
        row(7, 'STARBUCKS STORE 123', { issuerCategory: 'Restaurant-Bar & Café' }),
        // A tax paid by card, which the issuer filed under a category of its own: the tax rule files it over that.
        row(13, 'US TREASURY TAX PAYMENT', { issuerCategory: 'Business Services-Utilities' }),
      ],
    });
    repo.importCardTransactions({
      cardAccountId: chase.id, source: 'test-sync', parserVersion: 'test@1', rows: [
        row(8, 'NORTHWIND GROCERY #12'), row(9, 'PROSEWARE BISTRO'), row(10, 'SAMPLE PLUMBING LLC'),
        row(11, 'NORTHWIND GROCERY', { status: 'pending', postedDate: null }),
        row(12, 'AUTOPAY PAYMENT THANK YOU', { kind: 'payment', amountMinor: -5000 }),
        // That payment returned, stored as a purchase: Spending reads it as a card payment, so it is no row to fill.
        row(14, 'RETURNED AUTOPAY PAYMENT', { amountMinor: 5000 }),
      ],
    });
  } finally {
    repo.close();
  }
}

/**
 * Per rule: the plain-word rule fills the bistro; the coffee chain answers the left-out coffee row, exactly now; the tax
 * rule files the tax payment over its issuer's category, and only it says so.
 */
const RULE_LINES = CARD_CATEGORY_RULES.map((rule) => {
  const answers = rule.id === 'coffee-chain' ? '1: same category 1 (100.0%), same top level 1 (100.0%)' : '0: same category 0 (n/a), same top level 0 (n/a)';
  const stored = ['grocery-store', 'coffee-chain', 'cafe-word'].includes(rule.id) ? 'yes' : 'no';
  const over = rule.overIssuer ? `files over the issuer's ${rule.id === 'tax-payment' ? 1 : 0}; ` : '';
  return `    ${rule.id}: fills ${rule.id === 'restaurant-word' ? 1 : 0}; ${over}answers ${answers}; stored ${stored}`;
});

const EXPECTED = [
  'Inferred categories, from the stored card rows (read-only; counts only)',
  `  rules ${CARD_CATEGORY_RULES_VERSION}: ${CARD_CATEGORY_RULES.length} rules naming `
    + `${new Set(CARD_CATEGORY_RULES.map((rule) => rule.category)).size} categories, 2 of them stored issuer categories`,
  '  posted spending rows with neither category: 3',
  '    filled by merchant history: 1',
  '    filled by a rule: 1',
  '    still uncategorized: 1',
  '    filled in all: 2 (66.7%)',
  '    chase: 3 rows, history 1, rule 1, none 1',
  // The tax payment is not left out in turn: its issuer's category is not one Spending files it under.
  '  posted spending rows with an issuer category a rule files over it: 1',
  '  the other posted spending rows with an issuer category, each left out in turn: 7',
  '    answered by merchant history 3: same category 3 (100.0%), same top level 3 (100.0%)',
  '    answered by a rule 1: same category 1 (100.0%), same top level 1 (100.0%)',
  '    no answer: 3',
  '  each rule: rows it fills (and rows it files over the issuer\'s category, for a rule over it); left-out rows it answers; '
    + 'whether its category is a stored issuer category',
  ...RULE_LINES,
  // The previous version filed the coffee chain with restaurants: the right top level, not the issuer's subcategory.
  `  the same left-out rows under rules ${CARD_CATEGORY_RULES_RETARGETED.version}'s categories for coffee-chain, cafe-word`,
  '    answered by a rule 1: same category 0 (0.0%), same top level 1 (100.0%)',
  '    coffee-chain: answers 1: same category 0 (0.0%), same top level 1 (100.0%)',
  '    cafe-word: answers 0: same category 0 (n/a), same top level 0 (n/a)',
  '',
].join('\n');

const NAMED = /NORTHWIND|LITWARE|FABRIKAM|STARBUCKS|PROSEWARE|PLUMBING|TREASURY|Sample|Merchandise|Restaurant|Groceries|Caf|Utilities|Taxes|0001|0002|alex|casey|\$/i;
/** The output with the reviewed rules' generic ids taken out: what is left names nothing of the household. */
const RULE_IDS = new RegExp(`\\b(?:${CARD_CATEGORY_RULES.map((rule) => rule.id).join('|')})\\b`, 'g');
const withoutRuleIds = (text: string) => text.replace(RULE_IDS, 'rule');
const fileHash = async () => createHash('sha256').update(await readFile(file)).digest('hex');

describe('category inference check: the counts', () => {
  it('counts what inference fills and how often it agrees, read-only, naming no merchant, category, card or person', async () => {
    seed();
    const before = await fileHash();
    const db = new Database(file, { readonly: true, fileMustExist: true });
    let text: string;
    try {
      text = formatCategoryInferenceCounts(countCategoryInference(db));
    } finally {
      db.close();
    }
    expect(text).toBe(EXPECTED);
    expect(withoutRuleIds(text)).not.toMatch(NAMED);
    expect(await fileHash()).toBe(before);
  });

  it('prints an issuer only by a plain name', async () => {
    seed();
    const repo = new SqliteStateRepo({ file });
    try {
      repo.internalGetDb().prepare("UPDATE card_accounts SET issuer = 'Sample Bank #9' WHERE issuer = 'chase'").run();
    } finally {
      repo.close();
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(countCategoryInference(db).byIssuer.map((entry) => entry.issuer)).toEqual(['other']);
    } finally {
      db.close();
    }
  });
});

// HOLDR_DATA_DIR is a POSIX path, as for the other operator commands.
describe.skipIf(process.platform === 'win32')('category inference check: the command', () => {
  const run = async (args: string[] = []) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCategoryInferenceCheck(args, {
      env: { HOLDR_DATA_DIR: dataDir, HOME: root },
      io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  it('prints the counts from the configured data dir and changes nothing', async () => {
    seed();
    const before = await fileHash();
    expect(await run()).toEqual({ code: 0, stdout: EXPECTED, stderr: '' });
    expect(await fileHash()).toBe(before);
  });

  it('refuses without a database or with arguments, by code only', async () => {
    const missing = await run();
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toBe('category-inference-check: E0I_INFERENCE_NO_DATABASE (no finance.db in the configured data dir)\n');
    const extra = await run(['--now']);
    expect(extra.code).not.toBe(0);
    expect(extra.stderr).toMatch(/^category-inference-check: E0I_USAGE/);
  });
});
