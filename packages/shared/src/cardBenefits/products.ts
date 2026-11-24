import { isBenefitDate } from './dates.js';
import type { BenefitCatalog, BenefitCategory, BenefitDefinition, BenefitProduct, CardBenefitSettings } from './types.js';

/** Every category, in the order the Benefits area lists them. */
export const BENEFIT_CATEGORIES: readonly BenefitCategory[] = ['travel', 'hotel', 'dining', 'shopping', 'business'];

const PRODUCT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BENEFIT_ID = PRODUCT_ID;
/** Larger than any card benefit, so a slipped digit stands out. */
const MAX_AMOUNT_MINOR = 1_000_000;

/** A nickname as product names are compared: compatibility forms, no ® or ™, single spaces. */
export function normalizeBenefitText(text: string): string {
  return text.normalize('NFKC').replace(/[®™℠]/g, ' ').replace(/\s+/g, ' ').trim();
}

const compiled = new Map<string, RegExp>();

/** Catalog patterns compile once, case-insensitively. */
export function benefitPattern(source: string): RegExp {
  let pattern = compiled.get(source);
  if (!pattern) {
    pattern = new RegExp(source, 'i');
    compiled.set(source, pattern);
  }
  return pattern;
}

export function benefitProductById(catalog: BenefitCatalog, id: string): BenefitProduct | undefined {
  return catalog.products.find((product) => product.id === id);
}

/**
 * The product a card account's nickname names, among its issuer's products in
 * catalog order (more specific first), or null. Issuers name cards by product
 * ("Business Platinum", "Freedom Unlimited"), so the nickname is enough when
 * the owner kept that name; otherwise the owner chooses.
 */
export function matchBenefitProduct(catalog: BenefitCatalog, issuer: string, nickname: string | null | undefined): BenefitProduct | null {
  if (!nickname) return null;
  const text = normalizeBenefitText(nickname);
  if (!text) return null;
  return catalog.products.find((product) => product.issuer === issuer
    && product.nicknamePatterns.some((source) => benefitPattern(source).test(text))) ?? null;
}

export type BenefitProductSource = 'auto' | 'manual' | 'none' | 'missing';

/** The owner's choice when there is one (a product, or none), else the nickname's product. */
export function resolveBenefitProduct(
  catalog: BenefitCatalog,
  account: { issuer: string; nickname?: string | null },
  settings: Pick<CardBenefitSettings, 'productChoice' | 'productId'> | null,
): { product: BenefitProduct | null; source: BenefitProductSource } {
  if (settings?.productChoice === 'none') return { product: null, source: 'none' };
  if (settings?.productChoice === 'manual') {
    const product = settings.productId ? benefitProductById(catalog, settings.productId) : undefined;
    // A product chosen for another issuer's card is no choice at all.
    return product && product.issuer === account.issuer ? { product, source: 'manual' } : { product: null, source: 'missing' };
  }
  const product = matchBenefitProduct(catalog, account.issuer, account.nickname);
  return product ? { product, source: 'auto' } : { product: null, source: 'none' };
}

/** Whether a version of a benefit applies on `date`. */
export function benefitAppliesOn(benefit: Pick<BenefitDefinition, 'validFrom' | 'validUntil'>, date: string): boolean {
  return (benefit.validFrom === undefined || date >= benefit.validFrom) && (benefit.validUntil === undefined || date <= benefit.validUntil);
}

/** Whether a version of a benefit applies on any day from `start` to `end`. */
export function benefitAppliesDuring(benefit: Pick<BenefitDefinition, 'validFrom' | 'validUntil'>, start: string, end: string): boolean {
  return (benefit.validFrom === undefined || end >= benefit.validFrom) && (benefit.validUntil === undefined || start <= benefit.validUntil);
}

/** A product's benefits grouped by id, versions in date order, in the order each id first appears. */
export function benefitVersions(product: BenefitProduct): BenefitDefinition[][] {
  const groups = new Map<string, BenefitDefinition[]>();
  for (const benefit of product.benefits) {
    const group = groups.get(benefit.id);
    if (group) group.push(benefit);
    else groups.set(benefit.id, [benefit]);
  }
  return [...groups.values()].map((versions) => [...versions].sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? '')));
}

function checkValue(benefit: BenefitDefinition, where: string, problems: string[]): void {
  const amount = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_AMOUNT_MINOR;
  if (benefit.value.unit === 'usd') {
    if (!amount(benefit.value.amountMinor)) problems.push(`${where}: amount must be a positive whole number of cents`);
    for (const [month, value] of Object.entries(benefit.value.byStartMonth ?? {})) {
      if (!/^(?:[1-9]|1[0-2])$/.test(month) || !amount(value)) problems.push(`${where}: byStartMonth must map months 1–12 to cents`);
    }
  } else if (!Number.isSafeInteger(benefit.value.count) || benefit.value.count < 1 || benefit.value.count > 100 || !benefit.value.noun) {
    problems.push(`${where}: count must be 1–100 with a noun`);
  }
}

/**
 * Everything wrong with a catalog, as messages; empty when it is sound. Tests
 * hold the shipped catalog to it: unique ids, compiling patterns, whole-cent
 * amounts, and versions of one benefit that share cadence and unit and never
 * overlap.
 */
export function benefitCatalogProblems(catalog: BenefitCatalog): string[] {
  const problems: string[] = [];
  if (!/^\d{4}\.\d{2}\.\d+$/.test(catalog.version)) problems.push('version must look like YYYY.MM.N');
  const productIds = new Set<string>();
  for (const product of catalog.products) {
    const where = product.id;
    if (!PRODUCT_ID.test(product.id) || productIds.has(product.id)) problems.push(`${where}: product id must be unique kebab-case`);
    productIds.add(product.id);
    if (!product.id.startsWith(`${product.issuer}-`)) problems.push(`${where}: product id must start with its issuer`);
    if (!product.name || !product.shortName) problems.push(`${where}: names are required`);
    if (!/^https:\/\/[a-z0-9.-]+\.(?:com|net)\//.test(product.sourceUrl)) problems.push(`${where}: sourceUrl must be the issuer's https page`);
    if (product.annualFeeMinor !== null && (!Number.isSafeInteger(product.annualFeeMinor) || product.annualFeeMinor < 0)) {
      problems.push(`${where}: annual fee must be whole cents`);
    }
    if (product.nicknamePatterns.length === 0) problems.push(`${where}: needs a nickname pattern`);
    for (const source of product.nicknamePatterns) {
      try { benefitPattern(source); } catch { problems.push(`${where}: nickname pattern does not compile`); }
    }
    for (const versions of benefitVersions(product)) {
      const [first] = versions;
      for (const [index, benefit] of versions.entries()) {
        const at = `${where}/${benefit.id}`;
        if (!BENEFIT_ID.test(benefit.id)) problems.push(`${at}: benefit id must be kebab-case`);
        if (!benefit.name) problems.push(`${at}: name is required`);
        checkValue(benefit, at, problems);
        if (benefit.cadence.every === 'years' && (!Number.isSafeInteger(benefit.cadence.months) || benefit.cadence.months < 24)) {
          problems.push(`${at}: a multi-year cadence needs 24 or more months`);
        }
        if (benefit.cadence.every === 'years' && benefit.value.unit !== 'usd') problems.push(`${at}: multi-year benefits are credits`);
        if (JSON.stringify(benefit.cadence) !== JSON.stringify(first.cadence) || benefit.value.unit !== first.value.unit) {
          problems.push(`${at}: versions must share cadence and unit`);
        }
        if (benefit.compareAs !== undefined && (benefit.compareAs.trim() === '' || benefit.compareAs !== benefit.compareAs.trim())) {
          problems.push(`${at}: compareAs must be a name without surrounding spaces`);
        }
        if (benefit.compareAs !== first.compareAs) problems.push(`${at}: versions must share compareAs`);
        if (benefit.category !== undefined && !BENEFIT_CATEGORIES.includes(benefit.category)) {
          problems.push(`${at}: category must be one of ${BENEFIT_CATEGORIES.join(', ')}`);
        }
        if (benefit.category !== first.category) problems.push(`${at}: versions must share category`);
        for (const date of [benefit.validFrom, benefit.validUntil]) {
          if (date !== undefined && !isBenefitDate(date)) problems.push(`${at}: validity dates must be YYYY-MM-DD`);
        }
        if (benefit.validFrom && benefit.validUntil && benefit.validFrom > benefit.validUntil) problems.push(`${at}: validity is reversed`);
        const next = versions[index + 1];
        if (next && (benefit.validUntil === undefined || next.validFrom === undefined || next.validFrom <= benefit.validUntil)) {
          problems.push(`${at}: versions must not overlap`);
        }
        if (benefit.tracking.method === 'statement-credit') {
          if (benefit.tracking.patterns.length === 0) problems.push(`${at}: statement credits need patterns`);
          if (benefit.value.unit !== 'usd') problems.push(`${at}: only dollar credits can be read off statements`);
          // A refund row counts only with credit wording; a bare name is for adjustment rows (adjustmentPatterns).
          if (benefit.tracking.patterns.some((source) => !/credit|reimb/i.test(source))) {
            problems.push(`${at}: statement-credit patterns must require credit wording`);
          }
          for (const source of [...benefit.tracking.patterns, ...(benefit.tracking.adjustmentPatterns ?? [])]) {
            try { benefitPattern(source); } catch { problems.push(`${at}: pattern does not compile`); }
          }
        }
        for (const id of benefit.issuerTrackerIds ?? []) {
          if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) problems.push(`${at}: issuer tracker ids must be issuer-native ids`);
        }
      }
    }
  }
  return problems;
}
