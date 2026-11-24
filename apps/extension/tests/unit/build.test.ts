/**
 * Build gates and fixed configuration (plan §3.2–§3.4, §9.2): the two
 * manifests and the checks that refuse anything else, the production/test
 * separation, bundle inputs and text, the AST rules over the sources, the
 * plan's budgets in production, and fake adapters that match the contract's
 * registry.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CARD_SYNC_READ_CONTRACTS, CARD_SYNC_SOURCE_SPECS } from '@finance-tracker/shared';
import { checkBundleInputs, checkBundleText, checkManifest, checkMixing, checkSources } from '../../build/checks.js';
import { ACCEPTANCE_HOLDR_ORIGIN, buildManifest, extensionPagesCsp, KEYS } from '../../build/manifest.js';
import { FAKE_ADAPTERS } from '../../src/adapters/fake/descriptors.js';
import { TARGET as ACCEPTANCE } from '../../src/config/acceptance.js';
import { createProductionTarget } from '../../src/config/production.js';
import { TARGET as TEST_TARGET } from '../../src/config/test.js';
import { PLAN_TIMINGS } from '../../src/config/timings.js';
import { build } from '../../build/build.js';

const EXTENSION_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRODUCTION_HOLDR_ORIGIN = 'https://extension-build.test.ts.net';
const PRODUCTION = createProductionTarget(PRODUCTION_HOLDR_ORIGIN);

test('the three manifests pass their checks; production names only the tailnet Holdr origin and no issuer yet', () => {
  for (const target of [PRODUCTION, TEST_TARGET, ACCEPTANCE]) assert.deepEqual(checkManifest(buildManifest(target), target), [], target.name);
  const production = buildManifest(PRODUCTION);
  assert.deepEqual([...(production.permissions as string[])].sort(), ['scripting', 'storage']);
  assert.deepEqual(production.host_permissions, [`${PRODUCTION_HOLDR_ORIGIN}/*`]);
  assert.equal(production.optional_host_permissions, undefined);
  assert.deepEqual(production.content_security_policy, { extension_pages: extensionPagesCsp(PRODUCTION_HOLDR_ORIGIN) });
  assert.equal(
    extensionPagesCsp(PRODUCTION_HOLDR_ORIGIN),
    `default-src 'none'; script-src 'self'; object-src 'none'; style-src 'self'; img-src 'self'; connect-src ${PRODUCTION_HOLDR_ORIGIN}; base-uri 'none'; form-action 'none'`,
  );
  assert.equal(production.incognito, 'not_allowed');
  assert.equal(production.key, KEYS.production.key);
  assert.deepEqual(buildManifest(TEST_TARGET).optional_host_permissions, FAKE_ADAPTERS.map((adapter) => adapter.hostPermission));
});

test('the manifest check refuses forbidden permissions and keys, extra hosts, another CSP and the other target', () => {
  const base = buildManifest(TEST_TARGET);
  const refused = (change: Record<string, unknown>) => checkManifest({ ...base, ...change }, TEST_TARGET).length > 0;
  for (const permission of ['cookies', 'tabs', 'webRequest', 'debugger', 'activeTab', 'alarms']) assert.ok(refused({ permissions: ['storage', 'scripting', permission] }), permission);
  assert.ok(refused({ host_permissions: ['<all_urls>'] }));
  assert.ok(refused({ host_permissions: [...(base.host_permissions as string[]), 'https://example.com/*'] }));
  assert.ok(refused({ optional_host_permissions: ['https://secure.chase.com/*'] }));
  for (const key of ['content_scripts', 'web_accessible_resources', 'externally_connectable', 'declarative_net_request', 'update_url']) assert.ok(refused({ [key]: [] }), key);
  assert.ok(refused({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'self'" } }));
  assert.ok(refused({ key: KEYS.production.key }));
  assert.ok(refused({ incognito: 'split' }));
  assert.ok(refused({ background: { service_worker: 'worker.js' } }));
  assert.ok(checkManifest(base, PRODUCTION).length > 0);
  assert.ok(checkManifest(buildManifest(PRODUCTION), TEST_TARGET).length > 0);
  assert.throws(() => createProductionTarget(undefined), /required/);
  assert.throws(() => createProductionTarget('https://node.example.ts.net'), /placeholder/);
  for (const origin of ['https://test.ts.net', 'https://www.node.test.ts.net', 'https://node.test.ts.net:8443', 'http://node.test.ts.net', 'https://holdr.example.com']) {
    assert.throws(() => createProductionTarget(origin), /HOLDR_EXTENSION_ORIGIN/, origin);
  }
});

test('outputs never mix: no fake host in production, no production or real issuer host in the test build', () => {
  assert.notDeepEqual(checkMixing('worker.js', 'fetch("http://holdr.e3.test/")', 'production'), []);
  assert.notDeepEqual(checkMixing('worker.js', '"fake-chase"', 'production'), []);
  assert.notDeepEqual(checkMixing('worker.js', '"http://localhost:4000"', 'production'), []);
  assert.notDeepEqual(checkMixing('worker.js', '"https://holdr.test"', 'production'), []);
  assert.notDeepEqual(checkMixing('worker.js', `"${PRODUCTION_HOLDR_ORIGIN}"`, 'test'), []);
  assert.notDeepEqual(checkMixing('worker.js', '"https://secure.chase.com"', 'test'), []);
  assert.deepEqual(checkMixing('worker.js', `"${PRODUCTION_HOLDR_ORIGIN}"`, 'production'), []);
  // The acceptance build carries the production id: it names neither the production Holdr, a real site, nor the test Holdr.
  for (const text of [`"${PRODUCTION_HOLDR_ORIGIN}"`, '"https://secure.chase.com"', '"http://holdr.e3.test"']) assert.notDeepEqual(checkMixing('worker.js', text, 'acceptance'), [], text);
  assert.deepEqual(checkMixing('worker.js', '"https://holdr.test" "http://chase.e3.test"', 'acceptance'), []);
});

test('synthetic target bundles exclude unrelated application catalogs without relaxing any build gate', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'holdr-synthetic-build-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const target of [TEST_TARGET, ACCEPTANCE]) {
    const result = await build(target, join(directory, target.name));
    assert.deepEqual(result.findings, [], `${target.name} must pass all artifact checks`);
  }
});

test('M6: the acceptance build has the production id only with the synthetic Holdr and fake issuers, nothing else', () => {
  assert.equal(ACCEPTANCE.name, 'acceptance');
  assert.equal(ACCEPTANCE.holdrOrigin, ACCEPTANCE_HOLDR_ORIGIN);
  assert.equal(KEYS.acceptance.id, KEYS.production.id);
  const manifest = buildManifest(ACCEPTANCE);
  assert.deepEqual(checkManifest(manifest, ACCEPTANCE), []);
  assert.equal(manifest.key, KEYS.production.key);
  assert.deepEqual(manifest.host_permissions, ['https://holdr.test/*']);
  assert.deepEqual(manifest.optional_host_permissions, FAKE_ADAPTERS.map((adapter) => adapter.hostPermission));
  assert.equal(ACCEPTANCE.timings.holdrTimeoutMs, PLAN_TIMINGS.holdrTimeoutMs);
  // Another Holdr origin, the production Holdr's permission, a real issuer, or the production id on the test build: refused.
  assert.notDeepEqual(checkManifest(manifest, { ...ACCEPTANCE, holdrOrigin: 'https://holdr.example' }), []);
  assert.notDeepEqual(checkManifest({ ...manifest, host_permissions: [`${PRODUCTION_HOLDR_ORIGIN}/*`] }, ACCEPTANCE), []);
  assert.notDeepEqual(checkManifest({ ...manifest, optional_host_permissions: ['https://secure.chase.com/*'] }, ACCEPTANCE), []);
  assert.notDeepEqual(checkManifest({ ...buildManifest(TEST_TARGET), key: KEYS.production.key }, TEST_TARGET), []);
  // Bundles hold exactly one target's configuration.
  const worker = (input: string, target: 'production' | 'test' | 'acceptance') => checkBundleInputs('worker.js', 'worker', [input], target);
  assert.notDeepEqual(worker('apps/extension/src/config/acceptance.ts', 'production'), []);
  assert.notDeepEqual(worker('apps/extension/src/config/fakeTimings.ts', 'production'), []);
  assert.notDeepEqual(worker('apps/extension/src/config/acceptance.ts', 'test'), []);
  assert.notDeepEqual(worker('apps/extension/src/config/test.ts', 'acceptance'), []);
  assert.notDeepEqual(worker('apps/extension/src/config/production.ts', 'acceptance'), []);
  assert.deepEqual(worker('apps/extension/src/config/fakeTimings.ts', 'acceptance'), []);
});

test('bundles take only extension and shared sources, the offline tool only through its pure span grammar', () => {
  const worker = (input: string, target: 'production' | 'test' = 'production') => checkBundleInputs('worker.js', 'worker', [input], target);
  assert.deepEqual(worker('packages/shared/src/cardSync/crossField.ts'), []);
  assert.deepEqual(worker('packages/shared/src/cardImportTool/leaks.ts'), []);
  assert.deepEqual(worker('packages/shared/src/cardImportTool/amount.ts'), []);
  for (const input of ['packages/shared/src/cardImportTool/convert.ts', 'packages/shared/src/cardImportTool/cli.ts', 'packages/shared/src/cardImportTool/amount.test.ts', 'node:fs', 'apps/api/src/index.ts', 'node_modules/x/index.js', 'packages/shared/src/cardSync/__fixtures__/drafts.ts']) assert.notDeepEqual(worker(input), [], input);
  assert.notDeepEqual(worker('apps/extension/src/adapters/fake/chase/isolated.ts'), []);
  assert.notDeepEqual(worker('apps/extension/src/config/test.ts'), []);
  assert.notDeepEqual(worker('apps/extension/src/config/production.ts', 'test'), []);
  assert.notDeepEqual(checkBundleInputs('popup.js', 'page-ui', ['apps/extension/src/worker/capture.ts'], 'test'), []);
  assert.notDeepEqual(checkBundleInputs('main-x.js', 'main', ['apps/extension/src/isolated/bankRead.ts'], 'test'), []);
});

test('bundle text: no eval, dynamic code or HTML sinks anywhere, no fetch in extension pages, XHR only in MAIN', () => {
  for (const text of ['eval("1")', 'new Function("x")', 'import("./x.js")', 'el.innerHTML = x', 'document.write(x)', 'new WebSocket(u)', 'chrome.cookies.get()']) {
    assert.notDeepEqual(checkBundleText('worker.js', 'worker', text), [], text);
  }
  assert.notDeepEqual(checkBundleText('popup.js', 'page-ui', 'fetch(url)'), []);
  assert.notDeepEqual(checkBundleText('worker.js', 'worker', 'new XMLHttpRequest()'), []);
  assert.deepEqual(checkBundleText('main.js', 'main', 'XMLHttpRequest.prototype.open'), []);
});

test('the extension sources pass the AST rules', () => {
  assert.deepEqual(checkSources(EXTENSION_ROOT), []);
});

test('production uses the plan’s budgets unchanged; the test target only shortens waits', () => {
  assert.deepEqual(PRODUCTION.timings, PLAN_TIMINGS);
  assert.deepEqual(
    { ...PLAN_TIMINGS, holdrRetryDelaysMs: [...PLAN_TIMINGS.holdrRetryDelaysMs] },
    {
      requestIntervalMs: 5_000,
      requestTimeoutMs: 15_000,
      runLimitMs: 180_000,
      maxPagesPerAccount: 10,
      maxRequestsPerRun: 20,
      defaultWindowDays: 30,
      maxResponseBytes: 2 * 1024 * 1024,
      rateLimitPauseMs: 30 * 60 * 1_000,
      previewTtlMs: 10 * 60 * 1_000,
      sessionBudgetBytes: 8 * 1024 * 1024,
      holdrTimeoutMs: 15_000,
      holdrRetryDelaysMs: [2_000, 8_000],
      shapeModeMs: 10 * 60 * 1_000,
      planSettleMarginMs: 2 * 60 * 1_000,
    },
  );
  const shortened = new Set(['requestIntervalMs', 'requestTimeoutMs', 'runLimitMs', 'holdrTimeoutMs', 'holdrRetryDelaysMs', 'planSettleMarginMs']);
  for (const [key, value] of Object.entries(TEST_TARGET.timings)) {
    const planned = PLAN_TIMINGS[key as keyof typeof PLAN_TIMINGS];
    if (JSON.stringify(value) === JSON.stringify(planned)) continue;
    assert.ok(shortened.has(key), `${key} differs in the test target`);
  }
  assert.equal(PRODUCTION.holdrOrigin, PRODUCTION_HOLDR_ORIGIN);
  assert.deepEqual(PRODUCTION.adapters, []);
});

test('each fake adapter has the one mode its source is registered for, and contracts of its own issuer and source', () => {
  for (const adapter of FAKE_ADAPTERS) {
    const source = CARD_SYNC_SOURCE_SPECS[adapter.source];
    assert.equal(source.issuer, adapter.issuer, adapter.id);
    assert.equal(source.mode, adapter.mode, adapter.id);
    const discovery = CARD_SYNC_READ_CONTRACTS[adapter.discoveryContract];
    const transactions = CARD_SYNC_READ_CONTRACTS[adapter.transactionsContract];
    assert.equal(discovery.issuer, adapter.issuer, adapter.id);
    assert.equal(transactions.issuer, adapter.issuer, adapter.id);
    assert.equal(transactions.produces, 'transactions', adapter.id);
    assert.equal(transactions.source, adapter.source, adapter.id);
    assert.equal(adapter.hostPermission, `${adapter.pageOrigin}/*`, adapter.id);
    assert.match(adapter.pageOrigin, /^http:\/\/[a-z0-9.-]+\.e3\.test$/);
    assert.equal(adapter.testOnly, true);
  }
});
