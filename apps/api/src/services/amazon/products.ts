import { containsCardData, containsCardSecret, containsLongDigitRun } from '@finance-tracker/shared';
import { digest, exact, refuse } from './policy.js';

export const MAX_AMAZON_TITLE = 2048;
export interface ProductTitle { asin: string | null; title: string }
export interface ProductProjection {
  format: 'holdr.amazon-product-titles';
  version: 2;
  coverage: { itemObservations: number; projectedObservations: number; heldTitleObservations: number };
  products: ProductTitle[];
}
interface LegacyProductProjection {
  format: 'holdr.amazon-product-titles';
  version: 1;
  products: ProductTitle[];
}
export function validTitle(value: unknown, max = MAX_AMAZON_TITLE): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029<>]|(?:https?:|@)/i.test(value);
}
/** Display-only Amazon CDN image ID (never a URL or financial evidence); the producer kit's grammar. */
export function validImageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9+-]{9}[A-Za-z0-9]$/.test(value);
}
function productShape(input: unknown): ProductTitle {
  const p = exact(input, ['asin', 'title']);
  if (typeof p.title !== 'string' || (p.asin !== null && (typeof p.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(p.asin)))) return refuse();
  return { asin: p.asin as string | null, title: p.title };
}
export function productTitle(input: unknown): ProductTitle {
  const p = productShape(input);
  if (!validTitle(p.title)) return refuse();
  return p;
}
export function productKey(product: ProductTitle): string {
  return digest([product.asin ?? digest(product.title), product.title]);
}
export function projectProducts(inputs: readonly unknown[]): ProductProjection {
  const products = new Map<string, ProductTitle>();
  let itemObservations = 0, projectedObservations = 0, heldTitleObservations = 0;
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse();
    const capture = input as Record<string, unknown>;
    const staging = (capture.format === 'holdr.amazon-staging' ? capture : capture.staging) as Record<string, unknown> | undefined;
    if (!staging || staging.format !== 'holdr.amazon-staging' || typeof staging.version !== 'number' || ![1, 2, 3].includes(staging.version)
      || !Array.isArray(staging.orders)) return refuse();
    for (const order of staging.orders) {
      if (!order || typeof order !== 'object' || Array.isArray(order) || !Array.isArray(order.items)) return refuse();
      for (const item of order.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return refuse();
        const p = productShape({ asin: item.itemId, title: item.title });
        itemObservations++;
        if (publicTitle(p.title) !== p.title) {
          heldTitleObservations++;
          continue;
        }
        projectedObservations++;
        products.set(productKey(p), p);
      }
    }
  }
  return { format: 'holdr.amazon-product-titles', version: 2,
    coverage: { itemObservations, projectedObservations, heldTitleObservations },
    products: [...products].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p) };
}
export function validateProductProjection(input: unknown): ProductProjection | LegacyProductProjection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse();
  const version = (input as Record<string, unknown>).version;
  if (version !== 1 && version !== 2) return refuse();
  const p = exact(input, ['format', 'version', 'products', ...(version === 2 ? ['coverage'] : [])]);
  if (p.format !== 'holdr.amazon-product-titles' || !Array.isArray(p.products)) return refuse();
  const keys = new Set<string>();
  for (const value of p.products) {
    const product = productTitle(value);
    if (publicTitle(product.title) !== product.title) return refuse();
    const key = productKey(product);
    if (keys.has(key)) return refuse();
    keys.add(key);
  }
  if (version === 2) {
    const c = exact(p.coverage, ['itemObservations', 'projectedObservations', 'heldTitleObservations']);
    const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (!count(c.itemObservations) || !count(c.projectedObservations) || !count(c.heldTitleObservations)
      || BigInt(c.itemObservations) !== BigInt(c.projectedObservations) + BigInt(c.heldTitleObservations)
      || p.products.length > c.projectedObservations || (p.products.length === 0) !== (c.projectedObservations === 0)) return refuse();
  }
  return input as ProductProjection | LegacyProductProjection;
}
export function publicTitle(title: string): string {
  return validTitle(title) && !containsCardData(title) && !containsCardSecret(title) && !containsLongDigitRun(title)
    ? title : '[redacted]';
}
