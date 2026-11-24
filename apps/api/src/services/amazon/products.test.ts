import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectProducts, productKey, publicTitle, validateProductProjection } from './products.js';
import { makeAgentReview } from './categorization.js';
import { digest } from './policy.js';
import { assertPrivate, privateAcl, readPrivateJson, writePrivateJson } from './privateFiles.js';
import { syntheticCapture } from './fixtures.testSupport.js';
import { readCurrentUserSid, restrictToUser, SYSTEM_SID } from '../../e2e/windowsAcl.js';
import { runAmazonProducts } from '../../cli/amazonProductsMain.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function privateDir(parent = os.tmpdir()) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'amazon-products-synthetic-')));
  dirs.push(dir);
  if (process.platform === 'win32') restrictToUser(dir, readCurrentUserSid());
  else fs.chmodSync(dir, 0o700);
  return dir;
}
describe('private title-only projection', () => {
  it('extracts only title and ASIN, dedupes pairs, preserves repeated titles with distinct ASINs', () => {
    const c = syntheticCapture();
    c.staging.orders[0].items.push({ ...c.staging.orders[0].items[0], lineOrdinal: 1 });
    c.staging.orders[0].items.push({ ...c.staging.orders[0].items[0], itemId: null, lineOrdinal: 2 });
    const result = projectProducts([c, c]);
    expect(result.products).toHaveLength(2);
    expect(result.coverage).toEqual({ itemObservations: 6, projectedObservations: 6, heldTitleObservations: 0 });
    for (const p of result.products) expect(Object.keys(p).sort()).toEqual(['asin', 'title']);
    const text = JSON.stringify(result);
    for (const secret of ['amountMinor', 'orderId', 'date', 'quantity', 'last4', 'unitPrice']) expect(text).not.toContain(secret);
    expect(projectProducts([{ ...c, staging: { ...c.staging, orders: [] } }]).products).toEqual([]);
    expect(projectProducts([c.staging])).toEqual(projectProducts([c]));
  });
  it('writes exclusively, reads privately and prints only counts', () => {
    const dir = privateDir(), out = privateDir(), capture = syntheticCapture();
    writePrivateJson(path.join(dir, 'capture.json'), capture);
    let stdout = '', stderr = '';
    const output = path.join(out, 'products.json');
    const io = { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } };
    expect(runAmazonProducts(['extract', '--staging', dir, '--output', output], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'titles-extracted', version: 2, captures: 1, products: 1,
      coverage: { itemObservations: 1, projectedObservations: 1, heldTitleObservations: 0 } });
    expect(readPrivateJson(output)).toEqual(projectProducts([capture]));
    expect(() => writePrivateJson(output, {})).toThrow();
    expect(stderr).toBe('');
  });
  it('canonicalizes symlinked temporary parents without admitting aliased private paths', () => {
    const parent = privateDir(), target = privateDir(), alias = path.join(parent, 'temp-alias');
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertPrivate(alias)).toThrow();
    const dir = privateDir(alias), file = path.join(dir, 'synthetic.json');
    writePrivateJson(file, { synthetic: true });
    expect(path.dirname(dir)).toBe(target);
    expect(dir).toBe(fs.realpathSync(dir));
    expect(readPrivateJson(file)).toEqual({ synthetic: true });
    expect(() => readPrivateJson(path.join(alias, path.basename(dir), 'synthetic.json'))).toThrow();
  });
  it('refuses unsafe inherited read ACLs, null DACLs, foreign owners and uncheckable entries', () => {
    const owner = 'S-1-5-21-100-100-100-1001';
    const acl = { owner, aceTypes: ['AccessAllowed'], aces: [{ sid: owner, rights: 1, type: 'Allow' as const },
      { sid: SYSTEM_SID, rights: 1, type: 'Allow' as const }] };
    expect(privateAcl(acl, owner)).toBe(true);
    expect(privateAcl({ ...acl, aces: [...acl.aces, { sid: 'S-1-1-0', rights: 1, type: 'Allow' }] }, owner)).toBe(false);
    expect(privateAcl({ ...acl, aceTypes: null }, owner)).toBe(false);
    expect(privateAcl({ ...acl, owner: SYSTEM_SID }, owner)).toBe(false);
    expect(privateAcl({ ...acl, aceTypes: ['AccessAllowedCallback'] }, owner)).toBe(false);
  });
  it('does not leak private malformed input or path in CLI failures', () => {
    const dir = privateDir();
    fs.writeFileSync(path.join(dir, 'capture.json'), '{SYNTHETIC_PRIVATE_SENTINEL', { mode: 0o600 });
    let output = '';
    const stream = { write: (s: string) => { output += s; } };
    expect(runAmazonProducts(['extract', '--staging', dir, '--output', path.join(dir, 'output.json')],
      { stdout: stream, stderr: stream })).toBe(1);
    expect(output).toBe('amazon-products: operation-refused\n');
  });
  it('pins projection and closed inventory, confidence and fixed agent provenance', () => {
    const projection = projectProducts([syntheticCapture()]);
    const categories = { format: 'holdr.amazon-effective-categories', version: 1, categories: ['Household'] };
    const entry = { productKey: productKey(projection.products[0]), category: 'Household', confidence: 0.9,
      source: 'agent', rationale: 'categorized from product title' };
    expect(makeAgentReview(projection, categories, [entry]).entries).toHaveLength(1);
    for (const bad of [{ category: 'Invented' }, { confidence: -1 }, { confidence: NaN }, { source: 'user' },
      { rationale: 'free text' }, { productKey: '0'.repeat(64) }]) {
      expect(() => makeAgentReview(projection, categories, [{ ...entry, ...bad }])).toThrow();
    }
    expect(() => makeAgentReview(projection, categories, [entry, entry])).toThrow();
  });
  it('redacts card-bearing titles for owner read models without truncating safe full names', () => {
    const long = 'Synthetic product model '.repeat(40);
    expect(publicTitle(long)).toBe(long);
    expect(publicTitle('Synthetic 4111111111111111')).toBe('[redacted]');
    const capture = syntheticCapture(); capture.staging.orders[0].items[0].title = 'Synthetic 4111111111111111';
    expect(projectProducts([capture])).toMatchObject({ products: [],
      coverage: { itemObservations: 1, projectedObservations: 0, heldTitleObservations: 1 } });
    expect(() => assertPrivate(process.cwd())).toThrow();
  });
  it.each(['Synthetic model 1234567890123', 'Synthetic 4111-1111-1111-1111', 'Synthetic CVV 123',
    '', 'https://synthetic.invalid', 'x'.repeat(2049)])('holds a guarded string without identifiers or hashes %#', title => {
    const capture = syntheticCapture(), item = capture.staging.orders[0].items[0];
    const original = structuredClone(item);
    item.title = title; item.itemId = 'SYNTHHOLD1';
    capture.staging.orders[0].items.push({ ...original, lineOrdinal: 1 });
    const before = structuredClone(capture);
    expect(publicTitle(title)).toBe('[redacted]');
    const result = projectProducts([capture]);
    expect(result.products).toEqual([original].map(p => ({ asin: p.itemId, title: p.title })));
    expect(result.coverage).toEqual({ itemObservations: 2, projectedObservations: 1, heldTitleObservations: 1 });
    expect(validateProductProjection(result)).toBe(result);
    const text = JSON.stringify(result);
    for (const value of [title, 'SYNTHHOLD1', productKey({ asin: item.itemId, title }), digest(title)]) {
      if (value) expect(text).not.toContain(value);
    }
    expect(capture).toEqual(before);
  });
  it('closes observation coverage across captures, deduplicates only safe pairs and preserves their order/keys', () => {
    const clean = syntheticCapture(), mixed = syntheticCapture(), held = syntheticCapture();
    mixed.staging.orders[0].items.push({ ...mixed.staging.orders[0].items[0], title: 'Synthetic second widget',
      itemId: null, lineOrdinal: 1 });
    const expected = projectProducts([clean, mixed]);
    held.staging.orders[0].items[0].title = 'Synthetic PIN 1234';
    const result = projectProducts([held, clean, mixed, held, clean]);
    expect(result.products).toEqual(expected.products);
    expect(result.products.map(productKey)).toEqual(expected.products.map(productKey));
    expect(result.coverage).toEqual({ itemObservations: 6, projectedObservations: 4, heldTitleObservations: 2 });
    expect(validateProductProjection(result)).toBe(result);
    expect(projectProducts([held, held]).coverage)
      .toEqual({ itemObservations: 2, projectedObservations: 0, heldTitleObservations: 2 });
    const heldOnly = projectProducts([held, held]);
    expect(validateProductProjection(heldOnly)).toBe(heldOnly);
    expect(makeAgentReview(heldOnly, ['Household'], []).entries).toEqual([]);
    expect(() => makeAgentReview(heldOnly, ['Household'], [{
      productKey: '0'.repeat(64), category: 'Household', confidence: 0.9,
      source: 'agent', rationale: 'categorized from product title',
    }])).toThrow('amazon input refused');
    expect(projectProducts([])).toEqual({ format: 'holdr.amazon-product-titles', version: 2,
      products: [], coverage: { itemObservations: 0, projectedObservations: 0, heldTitleObservations: 0 } });
  });
  it.each([
    null, [], {}, { format: 'other', version: 3, orders: [] },
    { format: 'holdr.amazon-staging', version: 4, orders: [] },
    { format: 'holdr.amazon-staging', version: 3, orders: {} },
    ...[null, [], {}, { items: [null] }, { items: [[]] }, { items: [{ itemId: 'bad', title: 'Synthetic CVV 123' }] },
      { items: [{ itemId: null, title: null }] }, { items: [{ title: 'Synthetic' }] }]
      .map(order => ({ format: 'holdr.amazon-staging', version: 3, orders: [order] })),
  ])('refuses structural errors for the whole input without reflecting values %#', malformed => {
    expect(() => projectProducts([syntheticCapture(), malformed])).toThrow('amazon input refused');
  });
  it('keeps v1 readable and its review digest unchanged, validates v2 coverage and rejects mixed/unknown formats', () => {
    const p = projectProducts([syntheticCapture()]);
    const legacy = { format: p.format, version: 1, products: p.products };
    const assignments = [{ productKey: productKey(p.products[0]), category: 'Household', confidence: 0.9,
      source: 'agent', rationale: 'categorized from product title' }];
    const bytes = JSON.stringify(legacy);
    expect(makeAgentReview(legacy, ['Household'], assignments).productsDigest).toBe(digest(legacy));
    expect(JSON.stringify(legacy)).toBe(bytes);
    expect(makeAgentReview(p, ['Household'], []).entries).toEqual([]);
    for (const bad of [{ ...legacy, coverage: p.coverage }, { ...legacy, version: 2 }, { ...p, version: 3 },
      { ...p, products: [...p.products, ...p.products] },
      ...[{ itemObservations: 2 }, { projectedObservations: 0 }, { heldTitleObservations: 1 },
        { heldTitleObservations: -1 }, { itemObservations: NaN }, { projectedObservations: 0.5 },
        { itemObservations: Number.MAX_SAFE_INTEGER + 1 }, { unexpected: 1 }]
        .map(patch => ({ ...p, coverage: { ...p.coverage, ...patch } })),
      { ...p, products: [] }]) {
      expect(() => makeAgentReview(bad, ['Household'], assignments)).toThrow('amazon input refused');
    }
    const heldTitle = 'Synthetic CVV 123';
    for (const version of [1, 2]) {
      try {
        makeAgentReview({ ...legacy, version, ...(version === 2 ? { coverage: p.coverage } : {}),
          products: [{ asin: 'SYNTHHOLD1', title: heldTitle }] }, ['Household'], []);
        expect.fail('guarded forged projection accepted');
      } catch (error) {
        expect(String(error)).toContain('amazon input refused');
        expect(String(error)).not.toContain(heldTitle);
        expect(String(error)).not.toContain('SYNTHHOLD1');
      }
    }
  });
  it('writes only safe products and closed counts through both private CLI consumers', () => {
    const dir = privateDir(), out = privateDir(), c = syntheticCapture();
    c.staging.orders[0].items.push({ ...c.staging.orders[0].items[0], itemId: 'SYNTHHOLD1',
      title: 'Synthetic CVV 123', lineOrdinal: 1 });
    writePrivateJson(path.join(dir, 'capture.json'), c);
    const products = path.join(out, 'products.json'), categories = path.join(out, 'categories.json');
    const assignments = path.join(out, 'assignments.json'), review = path.join(out, 'review.json');
    let stdout = '', stderr = '';
    const io = { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } };
    expect(runAmazonProducts(['extract', '--staging', dir, '--output', products], io)).toBe(0);
    expect(JSON.parse(stdout).coverage).toEqual({ itemObservations: 2, projectedObservations: 1, heldTitleObservations: 1 });
    const p = validateProductProjection(readPrivateJson(products));
    writePrivateJson(categories, ['Household']);
    writePrivateJson(assignments, [{ productKey: productKey(p.products[0]), category: 'Household', confidence: 0.9,
      source: 'agent', rationale: 'categorized from product title' }]);
    stdout = '';
    expect(runAmazonProducts(['mapping', '--products', products, '--categories', categories,
      '--assignments', assignments, '--output', review], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'private-mapping-written-not-applied', classified: 1 });
    expect(stderr).toBe('');
    for (const text of [stdout, JSON.stringify(readPrivateJson(products)), JSON.stringify(readPrivateJson(review))]) {
      expect(text).not.toContain('Synthetic CVV 123');
      expect(text).not.toContain('SYNTHHOLD1');
    }
  });
});
