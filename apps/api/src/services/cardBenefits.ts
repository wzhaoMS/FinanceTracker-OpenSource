import type { Database as DB } from 'better-sqlite3';

import {
  BENEFITS_CATALOG,
  benefitPeriodAmount,
  benefitSpanContaining,
  benefitVersions,
  isBenefitDate,
  resolveBenefitProduct,
  validateIssuerBenefitTrackerSnapshots,
  type BenefitCatalog,
  type BenefitCreditRow,
  type BenefitDefinition,
  type BenefitMarkStatus,
  type BenefitPeriodSpan,
  type BenefitProductChoice,
  type CardAccount,
  type CardBenefitMark,
  type CardBenefitSettings,
  type IssuerBenefitTrackerRecord,
  type IssuerBenefitTrackerSnapshot,
  type IssuerTrackerIssue,
} from '@finance-tracker/shared';
import { HoldrRefusal } from './dbErrors.js';

/** At most twelve digits in all: fewer than any card number has, however they are grouped. */
const fewDigits = (column: string) => `length(${column}) - length(${[...'0123456789'].reduce((sql, digit) => `replace(${sql}, '${digit}', '')`, column)}) <= 12`;

/**
 * Card benefits storage: the owner's settings per card account (its product
 * and anniversary month), manual marks per benefit period, and the latest
 * figure an issuer reported per tracker and period. Additive tables, created
 * idempotently on every open (no user_version bump, so a build without them
 * still opens the database and leaves them alone). They name card accounts
 * only by id and hold no free text except an issuer tracker's display name,
 * which is checked for card data first; every column is shape-checked, and
 * nothing here writes a card_* table.
 */
export const CARD_BENEFITS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS benefit_settings (
  card_account_id   TEXT PRIMARY KEY REFERENCES card_accounts(id) ON DELETE RESTRICT,
  product_choice    TEXT NOT NULL CHECK (product_choice IN ('auto', 'manual', 'none')),
  product_id        TEXT CHECK (product_id IS NULL OR (
    typeof(product_id) = 'text' AND length(product_id) BETWEEN 3 AND 64
    AND product_id NOT GLOB '*[^a-z0-9-]*' AND product_id NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]*' AND ${fewDigits('product_id')})),
  anniversary_month INTEGER CHECK (anniversary_month IS NULL OR (
    anniversary_month = CAST(anniversary_month AS INTEGER) AND anniversary_month BETWEEN 1 AND 12)),
  updated_at        TEXT NOT NULL CHECK (typeof(updated_at) = 'text' AND length(updated_at) BETWEEN 20 AND 30),
  CHECK ((product_choice = 'manual') = (product_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS benefit_marks (
  card_account_id TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  benefit_id      TEXT NOT NULL CHECK (
    typeof(benefit_id) = 'text' AND length(benefit_id) BETWEEN 1 AND 64
    AND benefit_id NOT GLOB '*[^a-z0-9-]*' AND benefit_id NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]*' AND ${fewDigits('benefit_id')}),
  period_start    TEXT NOT NULL CHECK (
    typeof(period_start) = 'text' AND length(CAST(period_start AS BLOB)) = 10
    AND period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status          TEXT NOT NULL CHECK (status IN ('used', 'partial', 'unused')),
  used_minor      INTEGER CHECK (used_minor IS NULL OR (
    used_minor = CAST(used_minor AS INTEGER) AND used_minor BETWEEN 0 AND 99999999)),
  marked_at       TEXT NOT NULL CHECK (typeof(marked_at) = 'text' AND length(marked_at) BETWEEN 20 AND 30),
  PRIMARY KEY (card_account_id, benefit_id, period_start),
  CHECK ((status = 'partial') = (used_minor IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS benefit_issuer_trackers (
  card_account_id   TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  issuer            TEXT NOT NULL CHECK (issuer IN ('amex', 'chase', 'citi')),
  issuer_benefit_id TEXT NOT NULL CHECK (
    typeof(issuer_benefit_id) = 'text' AND length(issuer_benefit_id) BETWEEN 1 AND 64
    AND issuer_benefit_id NOT GLOB '*[^A-Za-z0-9._:-]*' AND issuer_benefit_id NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]*'
    AND ${fewDigits('issuer_benefit_id')}),
  name              TEXT NOT NULL CHECK (
    typeof(name) = 'text' AND length(name) BETWEEN 1 AND 80 AND name NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]*' AND ${fewDigits('name')}),
  period_start      TEXT NOT NULL CHECK (
    typeof(period_start) = 'text' AND length(CAST(period_start AS BLOB)) = 10
    AND period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end        TEXT NOT NULL CHECK (
    typeof(period_end) = 'text' AND length(CAST(period_end AS BLOB)) = 10
    AND period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND period_end >= period_start),
  unit              TEXT NOT NULL CHECK (unit IN ('money', 'count')),
  currency          TEXT CHECK ((unit = 'count' AND currency IS NULL) OR (unit = 'money'
    AND typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')),
  used_minor        INTEGER CHECK (used_minor IS NULL OR (
    used_minor = CAST(used_minor AS INTEGER) AND used_minor BETWEEN 0 AND 99999999)),
  total_minor       INTEGER CHECK (total_minor IS NULL OR (
    total_minor = CAST(total_minor AS INTEGER) AND total_minor BETWEEN 0 AND 99999999)),
  reset_date        TEXT CHECK (reset_date IS NULL OR (
    typeof(reset_date) = 'text' AND length(CAST(reset_date AS BLOB)) = 10
    AND reset_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  enrollment        TEXT NOT NULL CHECK (enrollment IN ('enrolled', 'not-enrolled', 'not-required', 'unknown')),
  observed_at       TEXT NOT NULL CHECK (typeof(observed_at) = 'text' AND length(observed_at) BETWEEN 20 AND 30),
  recorded_at       TEXT NOT NULL CHECK (typeof(recorded_at) = 'text' AND length(recorded_at) BETWEEN 20 AND 30),
  PRIMARY KEY (card_account_id, issuer_benefit_id, period_start, period_end)
);
`;

/** The benefits tables; created after the card tables they refer to. */
export const CARD_BENEFITS_TABLES = ['benefit_settings', 'benefit_marks', 'benefit_issuer_trackers'] as const;

export function ensureCardBenefitsSchema(db: DB): void {
  db.exec(CARD_BENEFITS_SCHEMA_SQL);
}

export interface CardBenefitSettingsInput {
  productChoice: BenefitProductChoice;
  /** Required for `manual`, refused otherwise. */
  productId?: string | null;
  /** 1–12; null clears it; left out, it stays. */
  anniversaryMonth?: number | null;
}

export interface CardBenefitMarkInput {
  cardAccountId: string;
  benefitId: string;
  periodStart: string;
  status: BenefitMarkStatus;
  /** Required for `partial`, refused otherwise: cents, or a count for count benefits. */
  usedMinor?: number | null;
}

export interface CardBenefitMarkKey {
  cardAccountId: string;
  benefitId: string;
  periodStart: string;
}

export interface CardBenefitTrackerResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Observations older than (or as old as) the stored one for the same tracker and period: ignored. */
  older: number;
}

/** At most this many issues are named in a refusal. */
const LISTED_ISSUES = 20;

/** A refusal for a list of snapshots, naming its issues by path and code only (never a value). */
export function trackerRefusal(issues: readonly IssuerTrackerIssue[]): HoldrRefusal {
  const listed = issues.slice(0, LISTED_ISSUES).map((issue) => `${issue.path} ${issue.code}`).join(', ');
  const more = issues.length > LISTED_ISSUES ? `, and ${issues.length - LISTED_ISSUES} more` : '';
  return new HoldrRefusal(`issuer benefit trackers are invalid: ${listed}${more}`);
}

const PRODUCT_CHOICES = new Set<BenefitProductChoice>(['auto', 'manual', 'none']);
const MARK_STATUSES = new Set<BenefitMarkStatus>(['used', 'partial', 'unused']);
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface SettingsRow {
  card_account_id: string;
  product_choice: BenefitProductChoice;
  product_id: string | null;
  anniversary_month: number | null;
  updated_at: string;
}

interface MarkRow {
  card_account_id: string;
  benefit_id: string;
  period_start: string;
  status: BenefitMarkStatus;
  used_minor: number | null;
  marked_at: string;
}

interface TrackerRow {
  card_account_id: string;
  issuer: IssuerBenefitTrackerRecord['issuer'];
  issuer_benefit_id: string;
  name: string;
  period_start: string;
  period_end: string;
  unit: 'money' | 'count';
  currency: string | null;
  used_minor: number | null;
  total_minor: number | null;
  reset_date: string | null;
  enrollment: IssuerBenefitTrackerRecord['enrollment'];
  observed_at: string;
  recorded_at: string;
}

const mapSettings = (row: SettingsRow): CardBenefitSettings => ({
  cardAccountId: row.card_account_id,
  productChoice: row.product_choice,
  productId: row.product_id,
  anniversaryMonth: row.anniversary_month,
  updatedAt: row.updated_at,
});

const mapMark = (row: MarkRow): CardBenefitMark => ({
  cardAccountId: row.card_account_id,
  benefitId: row.benefit_id,
  periodStart: row.period_start,
  status: row.status,
  usedMinor: row.used_minor,
  markedAt: row.marked_at,
});

const mapTracker = (row: TrackerRow): IssuerBenefitTrackerRecord => ({
  cardAccountId: row.card_account_id,
  issuer: row.issuer,
  issuerBenefitId: row.issuer_benefit_id,
  name: row.name,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  unit: row.unit,
  currency: row.currency,
  usedMinor: row.used_minor,
  totalMinor: row.total_minor,
  resetDate: row.reset_date,
  enrollment: row.enrollment,
  observedAt: row.observed_at,
  recordedAt: row.recorded_at,
});

/**
 * Reads and writes the benefits tables for the repository, which runs each
 * call behind its value-free boundary. Refusals name fields, never values.
 */
export class CardBenefitsStore {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date,
    private readonly cardAccount: (id: string) => CardAccount | null,
    private readonly catalog: BenefitCatalog = BENEFITS_CATALOG,
  ) {}

  listSettings(): CardBenefitSettings[] {
    return (this.db.prepare(`SELECT card_account_id, product_choice, product_id, anniversary_month, updated_at
      FROM benefit_settings ORDER BY card_account_id`).all() as SettingsRow[]).map(mapSettings);
  }

  getSettings(cardAccountId: string): CardBenefitSettings | null {
    const row = this.db.prepare(`SELECT card_account_id, product_choice, product_id, anniversary_month, updated_at
      FROM benefit_settings WHERE card_account_id = ?`).get(cardAccountId) as SettingsRow | undefined;
    return row ? mapSettings(row) : null;
  }

  setSettings(cardAccountId: string, input: CardBenefitSettingsInput): CardBenefitSettings {
    const account = this.requireAccount(cardAccountId);
    if (typeof input !== 'object' || input === null) throw new HoldrRefusal('benefit settings must be an object');
    if (!PRODUCT_CHOICES.has(input.productChoice)) throw new HoldrRefusal('productChoice must be auto, manual or none');
    let productId: string | null = null;
    if (input.productChoice === 'manual') {
      if (typeof input.productId !== 'string' || !ID.test(input.productId)) throw new HoldrRefusal('productId is required for a manual choice');
      const product = this.catalog.products.find((entry) => entry.id === input.productId);
      if (!product) throw new HoldrRefusal('productId is not in the benefits catalog');
      if (product.issuer !== account.issuer) throw new HoldrRefusal('productId belongs to another issuer');
      productId = product.id;
    } else if (input.productId !== undefined && input.productId !== null) {
      throw new HoldrRefusal('productId is only for a manual choice');
    }
    const current = this.getSettings(cardAccountId);
    let anniversaryMonth = current?.anniversaryMonth ?? null;
    if (input.anniversaryMonth !== undefined) {
      if (input.anniversaryMonth !== null
        && (!Number.isInteger(input.anniversaryMonth) || input.anniversaryMonth < 1 || input.anniversaryMonth > 12)) {
        throw new HoldrRefusal('anniversaryMonth must be 1 to 12, or null');
      }
      anniversaryMonth = input.anniversaryMonth;
    }
    this.db.prepare(`INSERT INTO benefit_settings (card_account_id, product_choice, product_id, anniversary_month, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (card_account_id) DO UPDATE SET product_choice = excluded.product_choice, product_id = excluded.product_id,
        anniversary_month = excluded.anniversary_month, updated_at = excluded.updated_at`)
      .run(cardAccountId, input.productChoice, productId, anniversaryMonth, this.now().toISOString());
    return this.getSettings(cardAccountId)!;
  }

  listMarks(): CardBenefitMark[] {
    return (this.db.prepare(`SELECT card_account_id, benefit_id, period_start, status, used_minor, marked_at
      FROM benefit_marks ORDER BY card_account_id, benefit_id, period_start`).all() as MarkRow[]).map(mapMark);
  }

  /**
   * The owner's word for one period: the benefit must belong to the card's
   * product (as the Benefits tab resolves it) and the date must start one of
   * its periods; a partial amount is at most the period's.
   */
  setMark(input: CardBenefitMarkInput): CardBenefitMark {
    if (typeof input !== 'object' || input === null) throw new HoldrRefusal('benefit mark must be an object');
    const { versions, span } = this.benefitOf(input);
    if (!MARK_STATUSES.has(input.status)) throw new HoldrRefusal('status must be used, partial or unused');
    let usedMinor: number | null = null;
    if (input.status === 'partial') {
      const cap = benefitPeriodAmount(versions, span);
      if (cap === null) throw new HoldrRefusal('the benefit did not apply in that period');
      if (!Number.isSafeInteger(input.usedMinor) || (input.usedMinor as number) < 0 || (input.usedMinor as number) > cap) {
        throw new HoldrRefusal('usedMinor must be a whole amount from zero to the period\'s amount');
      }
      usedMinor = input.usedMinor as number;
    } else if (input.usedMinor !== undefined && input.usedMinor !== null) {
      throw new HoldrRefusal('usedMinor is only for a partial mark');
    }
    this.db.prepare(`INSERT INTO benefit_marks (card_account_id, benefit_id, period_start, status, used_minor, marked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (card_account_id, benefit_id, period_start) DO UPDATE SET status = excluded.status,
        used_minor = excluded.used_minor, marked_at = excluded.marked_at`)
      .run(input.cardAccountId, input.benefitId, input.periodStart, input.status, usedMinor, this.now().toISOString());
    return mapMark(this.db.prepare(`SELECT card_account_id, benefit_id, period_start, status, used_minor, marked_at
      FROM benefit_marks WHERE card_account_id = ? AND benefit_id = ? AND period_start = ?`)
      .get(input.cardAccountId, input.benefitId, input.periodStart) as MarkRow);
  }

  /** True when a mark was removed. Any stored mark can be cleared, even one the catalog no longer places. */
  clearMark(key: CardBenefitMarkKey): boolean {
    if (typeof key !== 'object' || key === null) throw new HoldrRefusal('benefit mark must be an object');
    this.requireAccount(key.cardAccountId);
    if (typeof key.benefitId !== 'string' || !ID.test(key.benefitId) || key.benefitId.length > 64) throw new HoldrRefusal('benefitId is invalid');
    if (!isBenefitDate(key.periodStart)) throw new HoldrRefusal('periodStart must be a YYYY-MM-DD date');
    return this.db.prepare('DELETE FROM benefit_marks WHERE card_account_id = ? AND benefit_id = ? AND period_start = ?')
      .run(key.cardAccountId, key.benefitId, key.periodStart).changes > 0;
  }

  listTrackers(): IssuerBenefitTrackerRecord[] {
    return (this.db.prepare(`SELECT card_account_id, issuer, issuer_benefit_id, name, period_start, period_end, unit, currency,
        used_minor, total_minor, reset_date, enrollment, observed_at, recorded_at
      FROM benefit_issuer_trackers ORDER BY card_account_id, issuer_benefit_id, period_start, period_end`).all() as TrackerRow[])
      .map(mapTracker);
  }

  /**
   * Stores issuer-reported trackers for one card account (contract v1), all
   * or nothing. The caller resolved the card through its confirmed binding.
   * A newer observation of a tracker's period replaces the stored one; an
   * older or equally old one is ignored.
   */
  recordTrackers(input: { cardAccountId: string; snapshots: unknown }): CardBenefitTrackerResult {
    if (typeof input !== 'object' || input === null) throw new HoldrRefusal('issuer benefit trackers need a card account and snapshots');
    const account = this.requireAccount(input.cardAccountId);
    const checked = validateIssuerBenefitTrackerSnapshots(input.snapshots, this.now());
    if (!checked.ok) throw trackerRefusal(checked.issues);
    const otherIssuer = checked.snapshots.flatMap((snapshot, index) =>
      (snapshot.issuer === account.issuer ? [] : [{ path: `$[${index}].issuer`, code: 'format' as const }]));
    if (otherIssuer.length > 0) throw trackerRefusal(otherIssuer);
    const recordedAt = this.now().toISOString();
    const stored = this.db.prepare(`SELECT observed_at, name, unit, currency, used_minor, total_minor, reset_date, enrollment
      FROM benefit_issuer_trackers WHERE card_account_id = ? AND issuer_benefit_id = ? AND period_start = ? AND period_end = ?`);
    const upsert = this.db.prepare(`INSERT INTO benefit_issuer_trackers (card_account_id, issuer, issuer_benefit_id, name, period_start,
        period_end, unit, currency, used_minor, total_minor, reset_date, enrollment, observed_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (card_account_id, issuer_benefit_id, period_start, period_end) DO UPDATE SET name = excluded.name,
        unit = excluded.unit, currency = excluded.currency, used_minor = excluded.used_minor, total_minor = excluded.total_minor,
        reset_date = excluded.reset_date, enrollment = excluded.enrollment, observed_at = excluded.observed_at,
        recorded_at = excluded.recorded_at`);
    const result: CardBenefitTrackerResult = { inserted: 0, updated: 0, unchanged: 0, older: 0 };
    const same = (row: Record<string, unknown>, snapshot: IssuerBenefitTrackerSnapshot) => row.name === snapshot.name
      && row.unit === snapshot.unit && row.currency === snapshot.currency && row.used_minor === snapshot.usedMinor
      && row.total_minor === snapshot.totalMinor && row.reset_date === snapshot.resetDate && row.enrollment === snapshot.enrollment;
    this.db.transaction(() => {
      for (const snapshot of checked.snapshots) {
        const observedAt = new Date(snapshot.observedAt).toISOString();
        const row = stored.get(account.id, snapshot.issuerBenefitId, snapshot.periodStart, snapshot.periodEnd) as
          | (Record<string, unknown> & { observed_at: string })
          | undefined;
        if (row && row.observed_at >= observedAt) {
          result.older += 1;
          continue;
        }
        upsert.run(account.id, snapshot.issuer, snapshot.issuerBenefitId, snapshot.name, snapshot.periodStart, snapshot.periodEnd,
          snapshot.unit, snapshot.currency, snapshot.usedMinor, snapshot.totalMinor, snapshot.resetDate, snapshot.enrollment,
          observedAt, recordedAt);
        if (!row) result.inserted += 1;
        else if (same(row, snapshot)) result.unchanged += 1;
        else result.updated += 1;
      }
    })();
    return result;
  }

  /**
   * Posted card transactions dated from `from` to `to` that can be benefit
   * credits (adjustments, refunds and other money back, and the charges that
   * take a credit back): never payments or purchases.
   */
  listCredits(from: string, to: string): BenefitCreditRow[] {
    if (!isBenefitDate(from) || !isBenefitDate(to) || from > to) throw new HoldrRefusal('credit dates must be a YYYY-MM-DD range');
    return (this.db.prepare(`SELECT id, card_account_id, transaction_date, amount_minor, kind, description, merchant
        FROM card_transactions
       WHERE status = 'posted' AND kind IN ('adjustment', 'refund', 'other') AND amount_minor <> 0
         AND transaction_date BETWEEN ? AND ?
       ORDER BY transaction_date, id`).all(from, to) as Array<{
      id: string; card_account_id: string; transaction_date: string; amount_minor: number; kind: BenefitCreditRow['kind'];
      description: string; merchant: string | null;
    }>).map((row) => ({
      id: row.id,
      cardAccountId: row.card_account_id,
      date: row.transaction_date,
      amountMinor: row.amount_minor,
      kind: row.kind,
      description: row.description,
      merchant: row.merchant,
    }));
  }

  private requireAccount(id: unknown): CardAccount {
    const account = typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? this.cardAccount(id) : null;
    if (!account) throw new HoldrRefusal('card account does not exist');
    return account;
  }

  /** The versions of a benefit of the card's product, and the period the mark's date starts. */
  private benefitOf(input: CardBenefitMarkKey): { versions: BenefitDefinition[]; span: BenefitPeriodSpan } {
    const account = this.requireAccount(input.cardAccountId);
    if (typeof input.benefitId !== 'string' || !ID.test(input.benefitId) || input.benefitId.length > 64) {
      throw new HoldrRefusal('benefitId is invalid');
    }
    if (!isBenefitDate(input.periodStart)) throw new HoldrRefusal('periodStart must be a YYYY-MM-DD date');
    const settings = this.getSettings(account.id);
    const { product } = resolveBenefitProduct(this.catalog, account, settings);
    const versions = product ? benefitVersions(product).find((group) => group[0].id === input.benefitId) : undefined;
    if (!versions) throw new HoldrRefusal('benefitId is not a benefit of this card\'s product');
    // A credit allowed once every few years is marked by calendar year, as the Benefits tab shows it.
    const cadence = versions[0].cadence.every === 'years' ? { every: 'year', basis: 'calendar' } as const : versions[0].cadence;
    const span = benefitSpanContaining(cadence, input.periodStart, settings?.anniversaryMonth ?? null);
    if (!span) throw new HoldrRefusal('set the card\'s anniversary month first');
    if (span.start !== input.periodStart) throw new HoldrRefusal('periodStart must be the first day of one of the benefit\'s periods');
    return { versions, span };
  }
}
