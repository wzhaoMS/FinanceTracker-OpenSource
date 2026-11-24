/**
 * The build-time gate (plan §3.2, §3.3, §4.2). It runs after every build and
 * fails the build on any finding:
 *
 * 1. Source AST rules: network, dynamic-code, HTML-sink, privileged-API and
 *    programmatic-interaction uses are allowed only in the named files
 *    (`fetch` only in the single bank read entry, the Holdr client and the
 *    MAIN observer's pass-through wrapper; XHR only in that observer; no
 *    eval, dynamic import, WebSocket, sendBeacon, innerHTML, programmatic
 *    click/submit, cookies, webRequest, executeScript or external messaging
 *    anywhere; page code never touches extension storage).
 * 2. Bundle inputs (esbuild metafile): each bundle contains only the modules
 *    its world may contain; no Node module, no third-party package, no CLI or
 *    fixture code; production never contains a fake adapter or the test
 *    target, and the test build never the production target.
 * 3. Bundle text: the same forbidden APIs once more on the final output.
 * 4. Manifest: exact permissions, exact host permissions, optional hosts only
 *    from the allowed set, no forbidden key, the exact CSP, MV3 module worker.
 * 5. No mixing: production output never names a test host, loopback or plain
 *    HTTP; test output never names the production Holdr host or an issuer.
 * It finds mistakes; it cannot prove a malicious build has no other way out.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { BuildTarget } from '../src/config/targetTypes.js';
import { productionOriginProblem } from '../src/config/production.js';
import { ACCEPTANCE_HOLDR_ORIGIN, KEYS, PRODUCTION_ISSUER_ORIGINS, TEST_HOST, extensionPagesCsp } from './manifest.js';

export interface Finding {
  readonly rule: string;
  readonly where: string;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Source AST rules
// ---------------------------------------------------------------------------

interface AstRule {
  readonly name: string;
  readonly matches: (node: ts.Node) => boolean;
  /** Repository-relative (to apps/extension) files where the use is allowed. */
  readonly allowed: readonly string[];
}

const identifierNamed = (name: string) => (node: ts.Node) => ts.isIdentifier(node) && node.text === name;
const propertyNamed = (name: string) => (node: ts.Node) => ts.isPropertyAccessExpression(node) && node.name.text === name;
const chainIs = (chain: string) => (node: ts.Node) => ts.isPropertyAccessExpression(node) && node.getText().replace(/\s+/g, '') === chain;
const callOfProperty = (name: string, maxArgs: number) => (node: ts.Node) =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name && node.arguments.length <= maxArgs;

export const AST_RULES: readonly AstRule[] = Object.freeze([
  { name: 'fetch', matches: identifierNamed('fetch'), allowed: ['src/isolated/bankRead.ts', 'src/worker/holdrClient.ts', 'src/main/observer.ts'] },
  { name: 'XMLHttpRequest', matches: identifierNamed('XMLHttpRequest'), allowed: ['src/main/observer.ts'] },
  { name: 'WebSocket', matches: identifierNamed('WebSocket'), allowed: [] },
  { name: 'EventSource', matches: identifierNamed('EventSource'), allowed: [] },
  { name: 'sendBeacon', matches: propertyNamed('sendBeacon'), allowed: [] },
  { name: 'importScripts', matches: identifierNamed('importScripts'), allowed: [] },
  { name: 'eval', matches: identifierNamed('eval'), allowed: [] },
  { name: 'Function constructor', matches: (node) => (ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function', allowed: [] },
  { name: 'dynamic import', matches: (node) => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword, allowed: [] },
  { name: 'innerHTML', matches: propertyNamed('innerHTML'), allowed: [] },
  { name: 'outerHTML', matches: propertyNamed('outerHTML'), allowed: [] },
  { name: 'insertAdjacentHTML', matches: propertyNamed('insertAdjacentHTML'), allowed: [] },
  { name: 'document.write', matches: chainIs('document.write'), allowed: [] },
  { name: 'DOMParser', matches: identifierNamed('DOMParser'), allowed: [] },
  { name: 'createContextualFragment', matches: propertyNamed('createContextualFragment'), allowed: [] },
  { name: 'srcdoc', matches: propertyNamed('srcdoc'), allowed: [] },
  { name: 'programmatic click', matches: callOfProperty('click', 0), allowed: [] },
  { name: 'form submit', matches: (node) => callOfProperty('submit', 0)(node) || callOfProperty('requestSubmit', 1)(node), allowed: [] },
  { name: 'executeScript', matches: propertyNamed('executeScript'), allowed: [] },
  { name: 'chrome.cookies', matches: chainIs('chrome.cookies'), allowed: [] },
  { name: 'chrome.debugger', matches: chainIs('chrome.debugger'), allowed: [] },
  { name: 'webRequest', matches: propertyNamed('webRequest'), allowed: [] },
  { name: 'declarativeNetRequest', matches: propertyNamed('declarativeNetRequest'), allowed: [] },
  { name: 'external messaging', matches: (node) => propertyNamed('onMessageExternal')(node) || propertyNamed('onConnectExternal')(node), allowed: [] },
  { name: 'content script registration', matches: (node) => propertyNamed('registerContentScripts')(node) || propertyNamed('unregisterContentScripts')(node), allowed: ['src/worker/registration.ts'] },
  { name: 'permission request', matches: chainIs('chrome.permissions.request'), allowed: ['src/options/options.ts'] },
  { name: 'tab messaging', matches: chainIs('chrome.tabs.sendMessage'), allowed: ['src/worker/collectorLink.ts'] },
]);

/** Page code (ISOLATED, MAIN, adapters, projection) never touches extension storage. */
const PAGE_CODE = /^src\/(isolated|main|projection|adapters)\//;

export function checkSources(root: string): Finding[] {
  const findings: Finding[] = [];
  const files = walk(join(root, 'src'), (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  for (const file of files) {
    const rel = posix(relative(root, file));
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      for (const rule of AST_RULES) {
        if (rule.matches(node) && !rule.allowed.includes(rel)) findings.push({ rule: rule.name, where: `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}` });
      }
      if (PAGE_CODE.test(rel) && chainIs('chrome.storage')(node)) findings.push({ rule: 'storage in page code', where: rel });
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
        if (specifier !== null && !specifier.startsWith('.') && specifier !== '@finance-tracker/shared' && specifier !== '#target') {
          findings.push({ rule: 'import of a package other than @finance-tracker/shared', where: rel });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 2. Bundle inputs
// ---------------------------------------------------------------------------

export type BundleRole = 'worker' | 'page-ui' | 'isolated' | 'main';

const ROLE_FORBIDDEN: Readonly<Record<BundleRole, readonly RegExp[]>> = Object.freeze({
  worker: [/apps\/extension\/src\/(isolated|main|popup|options|ui)\//, /apps\/extension\/src\/adapters\/fake\/[a-z]+\//],
  'page-ui': [/apps\/extension\/src\/(isolated|main|worker)\//, /apps\/extension\/src\/adapters\/fake\/[a-z]+\//],
  isolated: [/apps\/extension\/src\/(worker|main|popup|options|ui)\//],
  main: [/apps\/extension\/src\/(worker|isolated|popup|options|ui)\//],
});

const ALWAYS_FORBIDDEN: readonly RegExp[] = [
  /(^|\/)node_modules\//,
  /^node:/,
  // The offline import tool reads files; only its pure modules may be bundled: the span grammar (`leaks.ts`), which the
  // contract's cross-field check imports, and exact decimal amounts (`amount.ts`, no imports), which shared's spending
  // modules import.
  /packages\/shared\/src\/cardImportTool\/(?!(?:leaks|amount)\.ts$)/,
  /__fixtures__\//,
  /\.test\.ts$/,
  /apps\/(api|web|mobile)\//,
];

export function checkBundleInputs(bundle: string, role: BundleRole, inputs: readonly string[], target: BuildTarget['name']): Finding[] {
  const findings: Finding[] = [];
  for (const raw of inputs) {
    const input = posix(raw);
    const forbidden = [...ALWAYS_FORBIDDEN, ...ROLE_FORBIDDEN[role]];
    // Exactly one target's configuration in a bundle; production never a fake adapter or the fake targets' timings.
    if (target === 'production') forbidden.push(/apps\/extension\/src\/adapters\/fake\//, /apps\/extension\/src\/config\/(test|acceptance|fakeTimings)\.ts$/);
    else if (target === 'test') forbidden.push(/apps\/extension\/src\/config\/(production|acceptance)\.ts$/);
    else forbidden.push(/apps\/extension\/src\/config\/(production|test)\.ts$/);
    const allowedRoot = /(^|\/)apps\/extension\/src\//.test(input) || /(^|\/)packages\/shared\/src\//.test(input);
    if (!allowedRoot) findings.push({ rule: 'bundle input outside the extension and shared sources', where: `${bundle}: ${input}` });
    for (const pattern of forbidden) if (pattern.test(input)) findings.push({ rule: `bundle input not allowed in ${role}`, where: `${bundle}: ${input}` });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 3. Bundle text and 5. no mixing
// ---------------------------------------------------------------------------

const BUNDLE_FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['eval', /\beval\s*\(/],
  ['Function constructor', /\bnew\s+Function\s*\(/],
  ['dynamic import', /\bimport\s*\(/],
  ['importScripts', /\bimportScripts\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write\b/],
  ['DOMParser', /\bDOMParser\b/],
  ['executeScript', /\bexecuteScript\b/],
  ['cookies', /\bchrome\.cookies\b/],
  ['debugger', /\bchrome\.debugger\b/],
  ['webRequest', /\bwebRequest\b/],
  ['declarativeNetRequest', /\bdeclarativeNetRequest\b/],
  ['external messaging', /\bon(?:Message|Connect)External\b/],
];

export function checkBundleText(bundle: string, role: BundleRole, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, pattern] of BUNDLE_FORBIDDEN) if (pattern.test(text)) findings.push({ rule: `bundle text: ${rule}`, where: bundle });
  if (role !== 'main' && /\bXMLHttpRequest\b/.test(text)) findings.push({ rule: 'bundle text: XMLHttpRequest outside the MAIN observer', where: bundle });
  if (role === 'page-ui' && /\bfetch\b/.test(text)) findings.push({ rule: 'bundle text: fetch in an extension page', where: bundle });
  return findings;
}

const PRODUCTION_MUST_NOT_CONTAIN: readonly string[] = ['e3.test', 'holdr.test', '127.0.0.1', 'localhost', 'http://', 'fake-chase', 'fake-amex', 'fake-citi', 'fake-wf', 'FAKE_'];
const TEST_MUST_NOT_CONTAIN: readonly string[] = ['ts.net', 'chase.com', 'americanexpress.com', 'citi.com', 'wellsfargo.com'];
/** The acceptance build carries the production id: it must name neither the production Holdr nor any real site, nor the test Holdr. */
const ACCEPTANCE_MUST_NOT_CONTAIN: readonly string[] = [...TEST_MUST_NOT_CONTAIN, 'holdr.e3.test'];

export function checkMixing(file: string, text: string, target: BuildTarget['name']): Finding[] {
  const list = target === 'production' ? PRODUCTION_MUST_NOT_CONTAIN : target === 'acceptance' ? ACCEPTANCE_MUST_NOT_CONTAIN : TEST_MUST_NOT_CONTAIN;
  return list.filter((needle) => text.includes(needle)).map((needle) => ({ rule: `${target} output names "${needle}"`, where: file }));
}

// ---------------------------------------------------------------------------
// 4. Manifest
// ---------------------------------------------------------------------------

const FORBIDDEN_MANIFEST_KEYS = [
  'content_scripts', 'web_accessible_resources', 'externally_connectable', 'optional_permissions', 'update_url',
  'devtools_page', 'chrome_url_overrides', 'declarative_net_request', 'sandbox', 'oauth2', 'side_panel', 'nacl_modules',
  'file_browser_handlers', 'storage', 'host_permission', 'key_pair',
];
const FORBIDDEN_PERMISSIONS = [
  'cookies', 'debugger', 'webRequest', 'webRequestBlocking', 'webRequestAuthProvider', 'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback', 'tabs', 'nativeMessaging', 'activeTab',
  'history', 'downloads', 'management', 'proxy', 'webNavigation', '<all_urls>', 'alarms', 'unlimitedStorage',
];

export function checkManifest(manifest: Record<string, unknown>, target: BuildTarget): Finding[] {
  const findings: Finding[] = [];
  const bad = (rule: string) => findings.push({ rule, where: 'manifest.json' });
  if (manifest.manifest_version !== 3) bad('manifest_version must be 3');
  for (const key of FORBIDDEN_MANIFEST_KEYS) if (Object.prototype.hasOwnProperty.call(manifest, key)) bad(`forbidden manifest key ${key}`);
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || JSON.stringify([...permissions].sort()) !== JSON.stringify(['scripting', 'storage'])) bad('permissions must be exactly storage and scripting');
  const allPermissionText = JSON.stringify([manifest.permissions, manifest.host_permissions, manifest.optional_host_permissions]);
  for (const name of FORBIDDEN_PERMISSIONS) if (allPermissionText.includes(`"${name}"`)) bad(`forbidden permission ${name}`);
  if (/\*:\/\/\*|:\/\/\*\//.test(allPermissionText)) bad('wildcard host permission');
  const expectedHoldr = target.name === 'acceptance' ? ACCEPTANCE_HOLDR_ORIGIN : target.holdrOrigin;
  if (target.name === 'production' && productionOriginProblem(target.holdrOrigin)) bad('production Holdr origin is missing, invalid or a placeholder');
  if (target.name === 'test' && !TEST_HOST.test(target.holdrOrigin)) bad('test Holdr origin must be a *.e3.test host');
  if (target.name === 'acceptance' && target.holdrOrigin !== ACCEPTANCE_HOLDR_ORIGIN) bad('acceptance Holdr origin must be the synthetic https://holdr.test');
  // The production id (which Holdr's device API admits) goes only with the production Holdr or the synthetic one.
  if (manifest.key === KEYS.production.key && target.name !== 'production' && target.name !== 'acceptance') bad('the production id with another Holdr');
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify([`${expectedHoldr}/*`])) bad('host_permissions must be exactly the Holdr origin');
  const optional = manifest.optional_host_permissions;
  if (optional !== undefined) {
    if (!Array.isArray(optional)) bad('optional_host_permissions must be a list');
    else {
      for (const entry of optional) {
        const origin = typeof entry === 'string' && entry.endsWith('/*') ? entry.slice(0, -2) : null;
        const allowed = origin !== null && (target.name === 'production' ? PRODUCTION_ISSUER_ORIGINS.includes(origin) : TEST_HOST.test(origin));
        if (!allowed) bad('optional host permission outside the allowed issuer set');
      }
      const expected = target.adapters.map((adapter) => adapter.hostPermission);
      if (JSON.stringify(optional) !== JSON.stringify(expected)) bad('optional host permissions must be exactly the adapters’ sites');
    }
  } else if (target.adapters.length > 0) bad('optional host permissions missing');
  const csp = (manifest.content_security_policy as { extension_pages?: unknown } | undefined)?.extension_pages;
  if (csp !== extensionPagesCsp(expectedHoldr)) bad('extension_pages CSP must be exactly the plan’s policy');
  if (Object.keys((manifest.content_security_policy as object | undefined) ?? {}).some((key) => key !== 'extension_pages')) bad('only the extension_pages CSP may be set');
  const background = manifest.background as { service_worker?: unknown; type?: unknown } | undefined;
  if (!background || background.service_worker !== 'worker.js' || background.type !== 'module' || Object.keys(background).length !== 2) bad('background must be the module worker only');
  if (manifest.incognito !== 'not_allowed') bad('incognito must be not_allowed');
  if (manifest.key !== KEYS[target.name].key) bad('key must be the target’s pinned public key');
  return findings;
}
