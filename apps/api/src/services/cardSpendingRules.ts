import type { Database } from 'better-sqlite3';
import {
  CARD_ASSET_CATEGORY,
  CARD_METALS_MERCHANT_CLASSES,
  isCardMetalsMerchantClass,
  type CardMetalsMerchantClass,
  type CardSpendingRule,
} from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import { randomCardSyncLetters } from './cardSyncDigests.js';
import { HoldrRefusal, toValueFreeDbError } from './dbErrors.js';

/**
 * The owner's spending rules ("<class> charges of at least <amount> in <currency> are precious metals"), in the one
 * table `card_spending_rules`. Nothing creates it at boot: only the backed-up, Root-GO-gated operator command
 * (cli/spendingRules.ts) installs it. Every read works without it (no rules); until it is there, writes refuse with
 * a plain HoldrRefusal that isCardSpendingRulesNotInstalled recognizes. A table of another shape, or any other object
 * of that name, is a conflict: never repaired, never read. Refusals say what was wrong, never what was submitted or
 * stored.
 */
export const CARD_SPENDING_RULES_SCHEMA_SQL = `CREATE TABLE card_spending_rules (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'csr_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  reason TEXT NOT NULL CHECK (reason = 'asset-purchase'),
  category TEXT NOT NULL CHECK (category = 'Precious metals'),
  merchant_class TEXT NOT NULL CHECK (merchant_class IN ('bullion-dealer', 'costco-online', 'walmart-online', 'sams-club', 'costco-warehouse')),
  currency TEXT NOT NULL CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  min_amount_minor INTEGER NOT NULL CHECK (typeof(min_amount_minor) = 'integer' AND min_amount_minor BETWEEN 1 AND 999999999999),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  created_by TEXT NOT NULL CHECK (typeof(created_by) = 'text' AND length(CAST(created_by AS BLOB)) = 36 AND substr(created_by, 1, 4) = 'usr_' AND substr(created_by, 5) NOT GLOB '*[^a-p]*'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  revoked_by TEXT CHECK (revoked_by IS NULL OR (typeof(revoked_by) = 'text' AND length(CAST(revoked_by AS BLOB)) = 36 AND substr(revoked_by, 1, 4) = 'usr_' AND substr(revoked_by, 5) NOT GLOB '*[^a-p]*')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
)`;
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const EXPECTED_SQL = normalizeSql(CARD_SPENDING_RULES_SCHEMA_SQL);
export const CARD_SPENDING_RULES_SCHEMA_DIGEST = digest(EXPECTED_SQL);

const MAX_AMOUNT_MINOR = 999_999_999_999;
const RULE_ID = /^csr_[a-p]{32}$/;
const ACTOR_REF = /^usr_[a-p]{32}$/;
const CURRENCY = /^[A-Z]{3}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A write before the operator installed the table, or while another object holds its name: the API's 409. */
export const CARD_SPENDING_RULES_NOT_INSTALLED = 'owner spending rules are not installed on this Holdr';
const REFUSED = Object.freeze({
  conflict: 'card_spending_rules already exists in another shape; nothing was installed',
  unverified: 'card_spending_rules did not install as expected; nothing was installed',
  input: 'an owner rule must be an object',
  merchantClass: `merchantClass must be one of ${CARD_METALS_MERCHANT_CLASSES.join(', ')}`,
  currency: 'currency must be three capital letters',
  minAmountMinor: `minAmountMinor must be a whole number of minor units from 1 to ${MAX_AMOUNT_MINOR}`,
  id: 'id must be an owner rule id',
  actor: 'an owner rule change needs the acting owner',
  now: 'an owner rule change needs its time as an ISO instant',
  duplicate: 'an owner rule like this one is already in force',
});

/**
 * Whether `error` is the refusal of a write without the table. It is a plain HoldrRefusal, sealed by its own
 * constructor, so it passes every value-free boundary unchanged (the repository's withValueFreeDbErrors included).
 */
export function isCardSpendingRulesNotInstalled(error: unknown): boolean {
  try {
    return error instanceof HoldrRefusal && error.message === CARD_SPENDING_RULES_NOT_INSTALLED;
  } catch {
    return false;
  }
}

type Operation =
  | 'read owner spending rules schema'
  | 'install owner spending rules'
  | 'list owner spending rules'
  | 'create owner spending rule'
  | 'revoke owner spending rule';
/** Holdr's own untouched refusals leave unchanged; anything else as a HoldrDbError naming only the operation and code. */
function valueFree(operation: Operation, error: unknown): Error {
  return toValueFreeDbError(operation, error);
}

export type CardSpendingRulesSchemaState = 'present' | 'absent' | 'conflict';

/**
 * Read-only: `present` only for exactly this build's table, `absent` when nothing has its name, `conflict` for
 * anything else with that name (another shape, an index, a view, a trigger, the name in other letter case).
 */
export function cardSpendingRulesSchemaState(db: Database): CardSpendingRulesSchemaState {
  try {
    const objects = db.prepare("SELECT type, sql FROM main.sqlite_master WHERE name = 'card_spending_rules' COLLATE NOCASE")
      .all() as Array<{ type: unknown; sql: unknown }>;
    if (objects.length === 0) return 'absent';
    const [object] = objects;
    return objects.length === 1 && object.type === 'table' && typeof object.sql === 'string'
      && normalizeSql(object.sql) === EXPECTED_SQL ? 'present' : 'conflict';
  } catch (error) {
    throw valueFree('read owner spending rules schema', error);
  }
}

export function hasCardSpendingRulesSchema(db: Database): boolean {
  return cardSpendingRulesSchemaState(db) === 'present';
}

/**
 * Only the operator command calls this, inside its backed-up IMMEDIATE transaction (called alone, it runs in one of
 * its own): nothing when the table is there, a refusal for a conflict, else the table, verified before it commits.
 */
export function installCardSpendingRulesSchema(db: Database): void {
  try {
    db.transaction(() => {
      const state = cardSpendingRulesSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal(REFUSED.conflict);
      db.exec(CARD_SPENDING_RULES_SCHEMA_SQL);
      if (cardSpendingRulesSchemaState(db) !== 'present') throw new HoldrRefusal(REFUSED.unverified);
    }).immediate();
  } catch (error) {
    throw valueFree('install owner spending rules', error);
  }
}

interface RuleRow {
  id: unknown;
  reason: unknown;
  category: unknown;
  merchant_class: unknown;
  currency: unknown;
  min_amount_minor: unknown;
  created_at: unknown;
  revoked_at: unknown;
}
const RULE_COLUMNS = 'id, reason, category, merchant_class, currency, min_amount_minor, created_at, revoked_at';

const isCurrency = (value: unknown): value is string => typeof value === 'string' && CURRENCY.test(value);
const isMinAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 1 && value <= MAX_AMOUNT_MINOR;
const isInstant = (value: unknown): value is string => typeof value === 'string' && INSTANT.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** A stored row as the shared rule (no actor refs), or null for one the table's checks should have refused. */
function ruleOf(row: RuleRow): CardSpendingRule | null {
  const { id, reason, category, merchant_class: merchantClass, currency, min_amount_minor: minAmountMinor,
    created_at: createdAt, revoked_at: revokedAt } = row;
  if (typeof id !== 'string' || !RULE_ID.test(id) || reason !== 'asset-purchase' || category !== CARD_ASSET_CATEGORY
    || !isCardMetalsMerchantClass(merchantClass) || !isCurrency(currency) || !isMinAmount(minAmountMinor)
    || !isInstant(createdAt) || (revokedAt !== null && !isInstant(revokedAt))) return null;
  return { id, reason, category, merchantClass, currency, minAmountMinor, createdAt, revokedAt };
}

function requireInstalled(db: Database): void {
  if (cardSpendingRulesSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_SPENDING_RULES_NOT_INSTALLED);
}

export interface CardSpendingRuleInput {
  merchantClass: unknown;
  currency: unknown;
  minAmountMinor: unknown;
}
/** Who changes a rule (`usr_` + 32 letters a–p, cardSyncActorRef) and when (a 24-character ISO instant). */
export interface CardSpendingRuleContext {
  actorRef: string;
  now: string;
}

function ruleInput(input: unknown): { merchantClass: CardMetalsMerchantClass; currency: string; minAmountMinor: number } {
  if (typeof input !== 'object' || input === null) throw new HoldrRefusal(REFUSED.input);
  const { merchantClass, currency, minAmountMinor } = input as Record<string, unknown>;
  if (!isCardMetalsMerchantClass(merchantClass)) throw new HoldrRefusal(REFUSED.merchantClass);
  if (!isCurrency(currency)) throw new HoldrRefusal(REFUSED.currency);
  if (!isMinAmount(minAmountMinor)) throw new HoldrRefusal(REFUSED.minAmountMinor);
  return { merchantClass, currency, minAmountMinor };
}

function changeContext(ctx: unknown): CardSpendingRuleContext {
  const { actorRef, now } = (typeof ctx === 'object' && ctx !== null ? ctx : {}) as Record<string, unknown>;
  if (typeof actorRef !== 'string' || !ACTOR_REF.test(actorRef)) throw new HoldrRefusal(REFUSED.actor);
  if (!isInstant(now)) throw new HoldrRefusal(REFUSED.now);
  return { actorRef, now };
}

/** Every rule, revoked ones included, by created_at then id. No rules unless the table is exactly this build's. */
export function listCardSpendingRules(db: Database): CardSpendingRule[] {
  try {
    return db.transaction((): CardSpendingRule[] => {
      if (cardSpendingRulesSchemaState(db) !== 'present') return [];
      const rows = db.prepare(`SELECT ${RULE_COLUMNS} FROM main.card_spending_rules ORDER BY created_at, id`)
        .safeIntegers(false).all() as RuleRow[];
      return rows.flatMap((row) => ruleOf(row) ?? []);
    })();
  } catch (error) {
    throw valueFree('list owner spending rules', error);
  }
}

/** A new rule in force from `now`; one exactly like a rule still in force is refused. */
export function createCardSpendingRule(db: Database, input: CardSpendingRuleInput, ctx: CardSpendingRuleContext): CardSpendingRule {
  try {
    // Without the table, refused before the write lock is even asked for; checked again under it.
    requireInstalled(db);
    return db.transaction((): CardSpendingRule => {
      requireInstalled(db);
      const { merchantClass, currency, minAmountMinor } = ruleInput(input);
      const { actorRef, now } = changeContext(ctx);
      const inForce = db.prepare(`SELECT 1 FROM main.card_spending_rules
        WHERE revoked_at IS NULL AND merchant_class = ? AND currency = ? AND min_amount_minor = ?`)
        .get(merchantClass, currency, minAmountMinor);
      if (inForce !== undefined) throw new HoldrRefusal(REFUSED.duplicate);
      const rule: CardSpendingRule = {
        id: `csr_${randomCardSyncLetters()}`, reason: 'asset-purchase', category: CARD_ASSET_CATEGORY,
        merchantClass, currency, minAmountMinor, createdAt: now, revokedAt: null,
      };
      db.prepare(`INSERT INTO main.card_spending_rules
        (id, reason, category, merchant_class, currency, min_amount_minor, created_at, created_by, revoked_at, revoked_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(rule.id, rule.reason, rule.category, merchantClass, currency, minAmountMinor, now, actorRef);
      return rule;
    }).immediate();
  } catch (error) {
    throw valueFree('create owner spending rule', error);
  }
}

/** Ends a rule at `now` (kept, with who ended it). An already revoked rule comes back unchanged; an unknown id, null. */
export function revokeCardSpendingRule(db: Database, id: unknown, ctx: CardSpendingRuleContext): CardSpendingRule | null {
  try {
    requireInstalled(db);
    return db.transaction((): CardSpendingRule | null => {
      requireInstalled(db);
      if (typeof id !== 'string' || !RULE_ID.test(id)) throw new HoldrRefusal(REFUSED.id);
      const { actorRef, now } = changeContext(ctx);
      const row = db.prepare(`SELECT ${RULE_COLUMNS} FROM main.card_spending_rules WHERE id = ?`)
        .safeIntegers(false).get(id) as RuleRow | undefined;
      const rule = row === undefined ? null : ruleOf(row);
      if (rule === null || rule.revokedAt !== null) return rule;
      db.prepare('UPDATE main.card_spending_rules SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now, actorRef, id);
      return { ...rule, revokedAt: now };
    }).immediate();
  } catch (error) {
    throw valueFree('revoke owner spending rule', error);
  }
}
