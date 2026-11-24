import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import {
  CARD_CATEGORY_RULES,
  CARD_CATEGORY_RULES_RETARGETED,
  CARD_CATEGORY_RULES_VERSION,
  buildCardCategoryInference,
  cardCategoryInferenceEligible,
  cardCategoryRulesBeforeRetarget,
  evaluateCardCategoryInference,
  readCardSpendingRows,
  type CardCategoryInferenceEvaluation,
  type CardCategoryInferenceRow,
} from '@finance-tracker/shared';

import { ControlError, EXIT, exitCodeOf } from '../control/errors.js';
import { errorTypeAndCode } from '../services/dbErrors.js';
import { assertNoExtraArgs, controlContext, takeFlag, type Io } from './controlCommon.js';

export const CATEGORY_INFERENCE_CHECK_USAGE = `Usage: npx tsx apps/api/src/cli/categoryInferenceCheckMain.ts

Read-only counts of the categories Spending infers for card rows with neither the owner's own category nor an
issuer's (packages/shared/src/cardCategoryInference.ts), from the stored card rows as Spending reads them:
how many rows merchant history and the reviewed rules fill, per issuer and per rule, how many rows with an issuer
category a rule files over it (a tax payment), and how often each agrees with the issuers' own categories when
every other categorized row is left out in turn, under these rules and under the previous version's categories for
the rules since retargeted. It reads the configured data dir (HOLDR_DATA_DIR or holdr.conf) with the database
opened read-only, and fetches and writes nothing. It prints counts, shares, issuer names and the reviewed rules'
generic ids only: no merchant, category, amount, card or person.
`;

/** An issuer printed by name only when it is a plain lower-case name; anything else counts as `other`. */
const PRINTABLE_ISSUER = /^[a-z][a-z0-9-]{0,31}$/;

export interface CategoryInferenceCounts {
  evaluation: CardCategoryInferenceEvaluation;
  /** The same rows under the previous version's categories for the rules since retargeted (same patterns). */
  beforeRetarget: CardCategoryInferenceEvaluation;
  /** Posted spending rows with neither category, per issuer: how inference fills them. */
  byIssuer: Array<{ issuer: string; rows: number; byHistory: number; byRule: number; remaining: number }>;
}

/** The counts over an open database's card rows, pending and posted, as Spending reads them. */
export function countCategoryInference(db: Database.Database): CategoryInferenceCounts {
  // With the kind Spending reads each row as: a charge that takes a card payment back is a payment, never filed.
  const rows = readCardSpendingRows(db.prepare(`
    SELECT t.status AS status, t.kind AS kind, t.amount_minor AS amountMinor, t.description AS description,
           t.merchant AS merchant, t.issuer_category AS issuerCategory, t.user_category AS userCategory, a.issuer AS issuer
      FROM card_transactions t JOIN card_accounts a ON a.id = t.card_account_id
     WHERE t.status IN ('pending', 'posted')`).all() as Array<CardCategoryInferenceRow & { amountMinor: number; issuer: string }>);
  const model = buildCardCategoryInference(rows);
  const issuers = new Map<string, { issuer: string; rows: number; byHistory: number; byRule: number; remaining: number }>();
  for (const row of rows) {
    if (row.status !== 'posted' || !cardCategoryInferenceEligible(row)) continue;
    const issuer = PRINTABLE_ISSUER.test(row.issuer) ? row.issuer : 'other';
    const entry = issuers.get(issuer) ?? { issuer, rows: 0, byHistory: 0, byRule: 0, remaining: 0 };
    entry.rows += 1;
    const inference = model.infer(row);
    if (!inference) entry.remaining += 1;
    else if (inference.basis === 'merchant-history') entry.byHistory += 1;
    else entry.byRule += 1;
    issuers.set(issuer, entry);
  }
  return {
    evaluation: evaluateCardCategoryInference(rows),
    beforeRetarget: evaluateCardCategoryInference(rows, { rules: cardCategoryRulesBeforeRetarget() }),
    byIssuer: [...issuers.values()].sort((a, b) => (a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0)),
  };
}

const share = (part: number, whole: number) => (whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`);

/** The counts as the command prints them. */
export function formatCategoryInferenceCounts(counts: CategoryInferenceCounts): string {
  const { uncategorized, refiled, holdOut, ruleCategories, rules } = counts.evaluation;
  const filled = uncategorized.byHistory + uncategorized.byRule;
  const agreement = (bucket: { rows: number; correct: number; topLevelCorrect: number }) =>
    `${bucket.rows}: same category ${bucket.correct} (${share(bucket.correct, bucket.rows)}), `
    + `same top level ${bucket.topLevelCorrect} (${share(bucket.topLevelCorrect, bucket.rows)})`;
  // Only a rule over the issuer's category files rows over it: the others' lines say nothing of it.
  const overIssuer = new Set(CARD_CATEGORY_RULES.filter((rule) => rule.overIssuer).map((rule) => rule.id));
  const retargeted = Object.keys(CARD_CATEGORY_RULES_RETARGETED.categories);
  const before = counts.beforeRetarget.rules.filter((entry) => retargeted.includes(entry.rule));
  return [
    'Inferred categories, from the stored card rows (read-only; counts only)',
    `  rules ${CARD_CATEGORY_RULES_VERSION}: ${CARD_CATEGORY_RULES.length} rules naming ${ruleCategories.total} categories, `
      + `${ruleCategories.inUse} of them stored issuer categories`,
    `  posted spending rows with neither category: ${uncategorized.rows}`,
    `    filled by merchant history: ${uncategorized.byHistory}`,
    `    filled by a rule: ${uncategorized.byRule}`,
    `    still uncategorized: ${uncategorized.remaining}`,
    `    filled in all: ${filled} (${share(filled, uncategorized.rows)})`,
    ...counts.byIssuer.map((entry) =>
      `    ${entry.issuer}: ${entry.rows} rows, history ${entry.byHistory}, rule ${entry.byRule}, none ${entry.remaining}`),
    `  posted spending rows with an issuer category a rule files over it: ${refiled}`,
    `  the other posted spending rows with an issuer category, each left out in turn: ${holdOut.rows}`,
    `    answered by merchant history ${agreement(holdOut.byHistory)}`,
    `    answered by a rule ${agreement(holdOut.byRule)}`,
    `    no answer: ${holdOut.remaining}`,
    '  each rule: rows it fills (and rows it files over the issuer\'s category, for a rule over it); left-out rows it answers; '
      + 'whether its category is a stored issuer category',
    ...rules.map((entry) =>
      `    ${entry.rule}: fills ${entry.filled}; ${overIssuer.has(entry.rule) ? `files over the issuer's ${entry.refiled}; ` : ''}`
      + `answers ${agreement(entry.holdOut)}; stored ${entry.categoryStored ? 'yes' : 'no'}`),
    `  the same left-out rows under rules ${CARD_CATEGORY_RULES_RETARGETED.version}'s categories for ${retargeted.join(', ')}`,
    `    answered by a rule ${agreement(counts.beforeRetarget.holdOut.byRule)}`,
    ...before.map((entry) => `    ${entry.rule}: answers ${agreement(entry.holdOut)}`),
  ].join('\n') + '\n';
}

export async function runCategoryInferenceCheck(
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; io: Io },
): Promise<number> {
  const { io } = options;
  try {
    const args = [...argv];
    if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
      io.stdout.write(CATEGORY_INFERENCE_CHECK_USAGE);
      return 0;
    }
    assertNoExtraArgs(args);
    const context = controlContext(options.env);
    const file = path.join(context.dataDir, 'finance.db');
    if (!fs.existsSync(file)) throw new ControlError('E0I_INFERENCE_NO_DATABASE', EXIT.refused, 'no finance.db in the configured data dir');
    let counts: CategoryInferenceCounts;
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 10000');
      db.pragma('query_only = ON');
      counts = countCategoryInference(db);
    } catch (error) {
      // Type and code only: an SQLite message can quote the database.
      throw new ControlError('E0I_INFERENCE_DATABASE', EXIT.refused, errorTypeAndCode(error));
    } finally {
      db?.close();
    }
    io.stdout.write(formatCategoryInferenceCounts(counts));
    return 0;
  } catch (error) {
    // Codes only: another command's detail can name a private path. These details never do.
    const code = error instanceof ControlError ? error.code : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && SAFE_DETAIL_CODES.has(code) && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`category-inference-check: ${code}${detail}\n`);
    return exitCodeOf(error);
  }
}

/** Codes whose detail is fixed text, a type and code, or what the operator typed. */
const SAFE_DETAIL_CODES = new Set(['E0I_USAGE', 'E0I_INFERENCE_NO_DATABASE', 'E0I_INFERENCE_DATABASE']);
