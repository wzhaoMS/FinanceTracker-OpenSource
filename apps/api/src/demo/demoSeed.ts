import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { hashPassword, passwordProblem } from '../auth/password.js';
import { isInsideApiDataDir, writeSyntheticDataset } from '../e2e/syntheticSeed.js';
import { installCardOpeningMonthsSchema } from '../services/cardOpeningMonths.js';
import { installCardPaymentDecisionsSchema } from '../services/cardPaymentDecisions.js';
import { installCardSpendingRulesSchema } from '../services/cardSpendingRules.js';
import { importCardScheduleObservations, installCashPlanSchema } from '../services/cashPlan.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import {
  approveMetalsBindings,
  importMetalsPayload,
  installMetalsSchema,
  metalsPayloadSha256,
  proposeMetalsBindings,
  serializeMetalsBindingProposal,
  sha256Hex,
} from '../services/metals/index.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import {
  DEMO_ACCOUNT_IDS,
  DEMO_CARD_PARSER,
  DEMO_CARD_SOURCE,
  DEMO_CARDS,
  DEMO_CHECKING,
  DEMO_METALS_ACCOUNT,
  DEMO_METALS_SALES_ACCOUNT,
  DEMO_USER,
  buildDemoHousehold,
} from './demoData.js';
import { DEMO_MARKER, hasExactDemoMarker } from './demoMarker.js';

/**
 * Write the demo household (demoData.ts) into a new data directory, then create the demo sign-in user. Only a missing or
 * empty directory outside any `apps/api/data` is accepted, so a real database is never written to. The optional tables
 * an owner installs with the operator commands (checking, card statements and balances, payment answers, spending rules,
 * card opening months, the metals ledger) are installed too, so every page has something to show and every owner action
 * can be tried. Before the launcher deletes a demo folder to make it again, assertDemoDataDir checks, read-only, that the
 * folder holds nothing but the demo's.
 */

export interface DemoSeedSummary {
  dataDir: string;
  today: string;
  accounts: number;
  trades: number;
  cashEvents: number;
  cards: number;
  cardRows: number;
  benefitMarks: number;
  statements: number;
  checkingRows: number;
  metalOrders: number;
  metalSales: number;
  metalCloses: number;
}

const DATABASE = 'finance.db';
/** The file beside a demo data folder that marks the folder above it as the demo's (scripts/start-local.mjs writes it). */
export { DEMO_MARKER };
/** A demo database holds this investment account, which no real household's does. */
const DEMO_ACCOUNT_ID = 'demo-alex-brokerage';

/** Refuse anything but a missing or empty directory outside apps/api/data; returns its absolute path. */
export function prepareDemoDataDir(dataDir: string): string {
  const resolved = path.resolve(dataDir);
  if (isInsideApiDataDir(resolved)) throw new Error(`refusing ${resolved}: apps/api/data is the API's default data directory`);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`refusing ${resolved}: not a plain directory`);
  if (stat && fs.readdirSync(resolved).length > 0) throw new Error(`refusing ${resolved}: the demo seeds only a new, empty directory`);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

/** A synthetic Root GO id for the demo's operator-style writes: 32 hex digits from a label. */
const goId = (label: string) => createHash('sha256').update(`holdr-demo:${label}`).digest('hex').slice(0, 32);

/** Seed `dataDir` for `now` and create the demo user with `password`. */
export async function seedDemoDataDir(dataDir: string, options: { password: string; now?: Date }): Promise<DemoSeedSummary> {
  const problem = passwordProblem(options.password, DEMO_USER);
  if (problem) throw new Error(problem);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const resolved = prepareDemoDataDir(dataDir);
  const household = buildDemoHousehold(now);
  const passwordHash = await hashPassword(options.password);
  const repo = new SqliteStateRepo({ file: path.join(resolved, DATABASE), now: () => now });
  try {
    writeSyntheticDataset(repo, household.portfolio);
    for (const event of household.cashEvents) repo.insertCashEvent(event);

    const cardIds = new Map<string, string>();
    for (const card of DEMO_CARDS) {
      const account = repo.createCardAccount({ issuer: card.issuer, owner: card.owner, nickname: card.nickname, last4: card.last4, currency: 'USD' });
      cardIds.set(card.key, account.id);
      repo.importCardTransactions({
        cardAccountId: account.id,
        source: DEMO_CARD_SOURCE,
        parserVersion: DEMO_CARD_PARSER,
        coverage: household.spending.coverage,
        rows: household.spending.rows.filter((row) => row.card === card.key).map(({ card: _card, ...row }) => row),
      });
      repo.setCardBenefitSettings(account.id, {
        productChoice: card.productChoice,
        ...(card.anniversaryMonth !== null ? { anniversaryMonth: card.anniversaryMonth } : {}),
      });
    }
    for (const mark of household.spending.marks) {
      repo.setCardBenefitMark({
        cardAccountId: cardIds.get(mark.card)!, benefitId: mark.benefitId, periodStart: mark.periodStart, status: mark.status,
        ...(mark.status === 'partial' ? { usedMinor: mark.usedMinor } : {}),
      });
    }

    const db = repo.internalGetDb();
    installCardSpendingRulesSchema(db);
    installCardOpeningMonthsSchema(db);
    installCardPaymentDecisionsSchema(db);
    installCashPlanSchema(db);
    importCardScheduleObservations(db, household.observations, { importRef: 'holdr-demo', now: nowIso });
    installCheckingSchema(db);
    importCheckingPayload(db, household.checking, { now: nowIso, goId: goId(`checking:${household.today}`), purpose: 'copy-rehearsal' });

    installMetalsSchema(db);
    for (const [payload, label] of [[household.metals, DEMO_METALS_ACCOUNT], [household.metalsSales, DEMO_METALS_SALES_ACCOUNT]] as const) {
      importMetalsPayload(db, { payload, account: { label } }, {
        now: nowIso,
        goId: goId(`metals:${label}:${household.today}`),
        purpose: 'copy-rehearsal',
        inputSha256: metalsPayloadSha256(payload),
        planDigest: null,
      });
    }
    // The dealer's payouts reach the joint checking account through an approved binding, as an owner's would.
    const databaseRef = sha256Hex(`holdr-demo-database:${household.today}`);
    const { proposal } = proposeMetalsBindings(db, databaseRef);
    const checking = proposal.identities.find((identity) => identity.kind === 'checking' && identity.last4 === DEMO_CHECKING.last4);
    if (checking && checking.candidates.length === 1) {
      approveMetalsBindings(db, proposal, {
        proposalSha256: sha256Hex(serializeMetalsBindingProposal(proposal)),
        inventoryDigest: proposal.inventoryDigest,
        pairs: [{ kind: 'checking', source: checking.source, network: null, last4: checking.last4, accountId: checking.candidates[0].accountId }],
      }, { now: nowIso, goId: goId(`bindings:${household.today}`), purpose: 'copy-rehearsal', planDigest: null, databaseRef });
    }

    new LocalAuthRepo(repo).createUser(DEMO_USER, passwordHash, now);
  } finally {
    repo.close();
  }
  return {
    dataDir: resolved,
    today: household.today,
    accounts: household.portfolio.accounts.length,
    trades: household.portfolio.transactions.length,
    cashEvents: household.cashEvents.length,
    cards: DEMO_CARDS.length,
    cardRows: household.spending.rows.length,
    benefitMarks: household.spending.marks.length,
    statements: household.observations.length,
    checkingRows: household.checking.segments.reduce((total, segment) => total + segment.rows.length, 0),
    metalOrders: household.metals.orders.length,
    metalSales: household.metalsSales.orders.length,
    metalCloses: household.portfolio.metalCloses.length,
  };
}

/** Whether `dataDir`'s parent folder carries the demo's exact marker (scripts/start-local.mjs writes it before seeding). */
export function hasDemoMarker(dataDir: string): boolean {
  return hasExactDemoMarker(path.dirname(path.resolve(dataDir)));
}

/**
 * Read-only: throw unless the database `file` holds nothing but the demo's: no sign-in user but `demo`, and no investment
 * account, card, card statement import, checking account or bullion account the demo does not make. A card is the demo's
 * when it is one of DEMO_CARDS or the demo's seed imported its transactions (DEMO_CARD_SOURCE), so a folder an earlier demo
 * made still counts. A missing table counts as empty (a seed that stopped early); the database is opened read-only, so
 * nothing is migrated or changed. What is not the demo's is counted, never printed.
 */
export function assertOnlyDemoData(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
    const rows = <T>(table: string, sql: string): T[] => (tables.has(table) ? db.prepare(sql).all() as T[] : []);
    const demoCards = new Set(DEMO_CARDS.map((card) => `${card.issuer}:${card.last4}`));
    const imports = rows<{ card: string; source: string }>('card_import_batches', 'SELECT card_account_id AS card, source FROM card_import_batches');
    const seededCards = new Set(imports.filter((row) => row.source === DEMO_CARD_SOURCE).map((row) => row.card));
    const bullion = new Set<string>([DEMO_METALS_ACCOUNT, DEMO_METALS_SALES_ACCOUNT]);
    const counts: Array<[string, number]> = [
      ['sign-in user', rows<{ username: string }>('local_users', 'SELECT username FROM local_users').filter((row) => row.username !== DEMO_USER).length],
      ['household user', rows('users', 'SELECT id FROM users').length],
      ['investment account', rows<{ id: string }>('accounts', 'SELECT id FROM accounts').filter((row) => !DEMO_ACCOUNT_IDS.includes(row.id)).length],
      ['card', rows<{ id: string; issuer: string; last4: string | null }>('card_accounts', 'SELECT id, issuer, last4 FROM card_accounts')
        .filter((row) => !demoCards.has(`${row.issuer}:${row.last4}`) && !seededCards.has(row.id)).length],
      ['card statement import', imports.filter((row) => row.source !== DEMO_CARD_SOURCE).length],
      ['checking account', rows<{ institution: string; last4: string }>('checking_accounts', 'SELECT institution, last4 FROM checking_accounts')
        .filter((row) => row.institution !== DEMO_CHECKING.institution || row.last4 !== DEMO_CHECKING.last4).length],
      ['bullion account', rows<{ label: string }>('metals_accounts', 'SELECT label FROM metals_accounts').filter((row) => !bullion.has(row.label)).length],
    ];
    const found = counts.filter(([, n]) => n > 0).map(([what, n]) => `${n} ${what}${n === 1 ? '' : 's'}`);
    if (found.length > 0) throw new Error(`refusing ${file}: it holds ${found.join(', ')} the demo did not make`);
  } finally {
    db.close();
  }
}

/**
 * Read-only: throw unless `dataDir` is a demo folder's data folder that holds nothing but the demo's: the demo's exact
 * marker beside it, and no database or one with the demo household only (assertOnlyDemoData). The launcher asks this
 * before it deletes a demo folder to make the demo again.
 */
export function assertDemoDataDir(dataDir: string): void {
  const resolved = path.resolve(dataDir);
  if (isInsideApiDataDir(resolved)) throw new Error(`refusing ${resolved}: apps/api/data is the API's default data directory`);
  if (!hasDemoMarker(resolved)) throw new Error(`refusing ${resolved}: not a demo folder (no ${DEMO_MARKER} file beside it)`);
  const file = path.join(resolved, DATABASE);
  if (fs.lstatSync(file, { throwIfNoEntry: false })) assertOnlyDemoData(file);
}

/**
 * Give the demo user of an existing demo database a new password (and end its sessions). Refused for anything but a
 * demo folder: its parent must carry the demo marker, and the database must hold the demo household and no other user.
 */
export async function resetDemoPassword(dataDir: string, password: string): Promise<void> {
  const problem = passwordProblem(password, DEMO_USER);
  if (problem) throw new Error(problem);
  const resolved = path.resolve(dataDir);
  const file = path.join(resolved, DATABASE);
  if (isInsideApiDataDir(file)) throw new Error(`refusing ${file}: apps/api/data is the API's default data directory`);
  if (!hasDemoMarker(resolved)) throw new Error(`refusing ${resolved}: not a demo folder (no ${DEMO_MARKER} file beside it)`);
  if (!fs.existsSync(file)) throw new Error(`no demo database at ${file}`);
  const repo = new SqliteStateRepo({ file });
  try {
    const users = new LocalAuthRepo(repo);
    const others = users.listUsers().filter((user) => user.username !== DEMO_USER);
    if (!repo.getAccount(DEMO_ACCOUNT_ID) || others.length > 0) throw new Error(`refusing ${file}: it does not hold the demo household`);
    const hash = await hashPassword(password);
    if (!users.setPasswordHash(DEMO_USER, hash, { revokeSessions: true })) users.createUser(DEMO_USER, hash);
  } finally {
    repo.close();
  }
}
