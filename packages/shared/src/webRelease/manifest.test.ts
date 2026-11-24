import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalManifest, MAX_FILE_BYTES, parseManifest, RELEASE_FORMAT, releaseText, validateReleaseContents,
  validateReleaseHtml, WebReleaseError, type ReleaseManifest,
} from './manifest.js';

const manifest: ReleaseManifest = {
  format: RELEASE_FORMAT,
  sourceCommit: 'a'.repeat(40),
  files: [
    { path: 'assets/app-123.js', size: 1, sha256: 'b'.repeat(64) },
    { path: 'index.html', size: 2, sha256: 'c'.repeat(64) },
  ],
};
const html = '<!doctype html><html><head><script type="module" crossorigin src="/assets/app-123.js"></script></head><body></body></html>';
const paths = new Set(manifest.files.map((file) => file.path));
const throwsCode = (run: () => unknown, code: string) => assert.throws(run, (error: unknown) =>
  error instanceof WebReleaseError && error.code === code);

test('canonical manifest is exact, stable and frozen', () => {
  const bytes = canonicalManifest(manifest);
  const result = parseManifest(bytes);
  assert.deepEqual(result, manifest);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.files));
  assert.ok(Object.isFrozen(result.files[0]));
  assert.equal(canonicalManifest(result), bytes);
});

for (const [name, value] of Object.entries({
  whitespace: canonicalManifest(manifest) + ' ',
  crlf: canonicalManifest(manifest).replace(/\n/g, '\r\n'),
  keyOrder: JSON.stringify({ sourceCommit: manifest.sourceCommit, format: RELEASE_FORMAT, files: manifest.files }, null, 2) + '\n',
  extraKey: JSON.stringify({ ...manifest, extra: true }, null, 2) + '\n',
  duplicateKey: canonicalManifest(manifest).replace('"format":', '"format": "holdr-web-release/1", "format":'),
  invalidJson: '{',
  wrongFormat: canonicalManifest({ ...manifest, format: 'other' as typeof RELEASE_FORMAT }),
  badCommit: canonicalManifest({ ...manifest, sourceCommit: 'A'.repeat(40) }),
  reverseFiles: canonicalManifest({ ...manifest, files: [...manifest.files].reverse() }),
  duplicatePath: canonicalManifest({ ...manifest, files: [...manifest.files, manifest.files[1]] }),
  missingIndex: canonicalManifest({ ...manifest, files: [manifest.files[0]] }),
  traversal: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'assets/../app.js' }, manifest.files[1]] }),
  apiPath: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'card-sync/app.js' }, manifest.files[1]] }),
  dotFile: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'assets/.hidden.js' }, manifest.files[1]] }),
  sourceMap: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'assets/app.js.map' }, manifest.files[1]] }),
  badHash: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], sha256: '0' }, manifest.files[1]] }),
  fractionalSize: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], size: 0.5 }, manifest.files[1]] }),
  negativeSize: canonicalManifest({ ...manifest, files: [{ ...manifest.files[0], size: -1 }, manifest.files[1]] }),
})) {
  test(`rejects manifest ${name}`, () => throwsCode(() => parseManifest(value), 'E0I_MANIFEST_INVALID'));
}

test('caps file size and file count', () => {
  throwsCode(() => parseManifest(canonicalManifest({
    ...manifest, files: [{ ...manifest.files[0], size: MAX_FILE_BYTES + 1 }, manifest.files[1]],
  })), 'E0I_RELEASE_LIMITS');
  throwsCode(() => parseManifest(canonicalManifest({ ...manifest, files: Array(501).fill(manifest.files[0]) })), 'E0I_RELEASE_LIMITS');
});

test('accepts the external module entry point', () => validateReleaseHtml(html, paths));

for (const [name, value] of Object.entries({
  inlineScript: html.replace('></script>', '>alert(1)</script>'),
  scriptWithoutCrossorigin: html.replace(' crossorigin', ''),
  scriptWithoutSrc: html.replace(' src="/assets/app-123.js"', ''),
  scriptWrongType: html.replace('type="module"', 'type="text/javascript"'),
  extraScriptAttribute: html.replace('type="module"', 'type="module" async'),
  remoteScript: html.replace('/assets/app-123.js', 'https://example.test/app.js'),
  remoteLink: html.replace('</head>', '<link rel="stylesheet" href="//example.test/a.css"></head>'),
  encodedRemoteLink: html.replace('</head>', '<link rel="stylesheet" href="&#104;ttps://example.test/a.css"></head>'),
  relativeLink: html.replace('/assets/app-123.js', 'assets/app-123.js'),
  missingAsset: html.replace('/assets/app-123.js', '/assets/missing.js'),
  queryOnAsset: html.replace('/assets/app-123.js', '/assets/app-123.js?raw'),
  dataUrl: html.replace('/assets/app-123.js', 'data:text/javascript,1'),
  inlineStyle: html.replace('<body>', '<body style="color:red">'),
  mixedCaseStyle: html.replace('<body>', '<body sTyLe="color:red">'),
  styleElement: html.replace('<body>', '<body><style>body{color:red}</style>'),
  eventHandler: html.replace('<body>', '<body onload="alert(1)">'),
  base: html.replace('</head>', '<base href="/"></head>'),
  srcset: html.replace('<body>', '<body><img srcset="//example.test/x.png 1x">'),
  refresh: html.replace('</head>', '<meta http-equiv="refresh" content="0;url=https://example.test"></head>'),
  brokenHtml: html.replace('<body>', '<body x="1" x="2">'),
  hiddenScript: html.replace('</head>', '<template><script>1</script></template></head>'),
})) {
  test(`rejects HTML ${name}`, () => throwsCode(() => validateReleaseHtml(value, paths), 'E0I_RELEASE_HTML'));
}

const iconPaths = new Set([...paths, 'assets/app-123.css', 'assets/favicon-123.svg', 'assets/favicon-32-123.png',
  'assets/apple-touch-icon-180-123.png', 'assets/favicon-123.ico']);
const withHead = (links: string) => html.replace('</head>', `${links}</head>`);
const withIcons = withHead('<meta name="theme-color" content="#0B1220">'
  + '<link rel="icon" href="/assets/favicon-123.svg" type="image/svg+xml">'
  + '<link rel="icon" href="/assets/favicon-32-123.png" sizes="32x32" type="image/png">'
  + '<link rel="apple-touch-icon" href="/assets/apple-touch-icon-180-123.png">'
  + '<link rel="stylesheet" crossorigin href="/assets/app-123.css">');

test('accepts release icons: rel icon or apple-touch-icon to a release .svg or .png, with its own type and one size', () => {
  validateReleaseHtml(withIcons, iconPaths);
  validateReleaseHtml(withHead('<link rel="icon" href="/assets/favicon-123.svg" sizes="any">'
    + '<link rel="apple-touch-icon" href="/assets/apple-touch-icon-180-123.png" sizes="180x180" type="image/png">'), iconPaths);
});

test('a release with icons passes the content rules', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  validateReleaseContents(new Map([
    ['index.html', Buffer.from(withIcons)],
    ['assets/app-123.js', Buffer.from('console.log("ready")')],
    ['assets/app-123.css', Buffer.from('body{color:green}')],
    ['assets/favicon-123.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')],
    ['assets/favicon-32-123.png', png],
    ['assets/apple-touch-icon-180-123.png', png],
  ]));
});

const link = (attributes: string) => withHead(`<link ${attributes}>`);
for (const [name, value] of Object.entries({
  remoteIcon: link('rel="icon" href="https://example.test/favicon.svg" type="image/svg+xml"'),
  protocolRelativeIcon: link('rel="icon" href="//example.test/favicon.svg"'),
  dataIcon: link('rel="icon" href="data:image/svg+xml,%3Csvg%2F%3E" type="image/svg+xml"'),
  relativeIcon: link('rel="icon" href="assets/favicon-123.svg"'),
  dotRelativeIcon: link('rel="apple-touch-icon" href="./assets/apple-touch-icon-180-123.png"'),
  missingIcon: link('rel="icon" href="/assets/missing-123.svg"'),
  queryOnIcon: link('rel="icon" href="/assets/favicon-123.svg?v=1"'),
  iconWithoutHref: link('rel="icon" type="image/svg+xml"'),
  scriptAsIcon: link('rel="icon" href="/assets/app-123.js"'),
  stylesheetAsTouchIcon: link('rel="apple-touch-icon" href="/assets/app-123.css"'),
  icoIcon: link('rel="icon" href="/assets/favicon-123.ico"'),
  typeOfOtherImage: link('rel="icon" href="/assets/favicon-32-123.png" type="image/svg+xml"'),
  unknownType: link('rel="icon" href="/assets/favicon-123.svg" type="image/x-icon"'),
  emptyType: link('rel="icon" href="/assets/favicon-123.svg" type=""'),
  sizesWithoutHeight: link('rel="icon" href="/assets/favicon-32-123.png" sizes="32"'),
  zeroSizes: link('rel="icon" href="/assets/favicon-32-123.png" sizes="0x0"'),
  twoSizes: link('rel="icon" href="/assets/favicon-32-123.png" sizes="16x16 32x32"'),
  emptySizes: link('rel="icon" href="/assets/favicon-32-123.png" sizes=""'),
  crossoriginIcon: link('rel="icon" crossorigin href="/assets/favicon-123.svg"'),
  mediaIcon: link('rel="icon" href="/assets/favicon-123.svg" media="(prefers-color-scheme: dark)"'),
  typeOnStylesheet: link('rel="stylesheet" crossorigin href="/assets/app-123.css" type="text/css"'),
  sizesOnStylesheet: link('rel="stylesheet" href="/assets/app-123.css" sizes="32x32"'),
  typeOnModulepreload: link('rel="modulepreload" crossorigin href="/assets/app-123.js" type="module"'),
  shortcutIcon: link('rel="shortcut icon" href="/assets/favicon-123.svg"'),
  upperCaseIcon: link('rel="ICON" href="/assets/favicon-123.svg"'),
  maskIcon: link('rel="mask-icon" href="/assets/favicon-123.svg"'),
  preloadImage: link('rel="preload" href="/assets/favicon-32-123.png"'),
  manifest: link('rel="manifest" href="/assets/favicon-123.svg"'),
  noRel: link('href="/assets/favicon-123.svg"'),
})) {
  test(`rejects link ${name}`, () => throwsCode(() => validateReleaseHtml(value, iconPaths), 'E0I_RELEASE_HTML'));
}

for (const [name, bytes] of Object.entries({
  cr: Buffer.from('a\rb'), nul: Buffer.from('a\0b'), invalidUtf8: Buffer.from([0xc0, 0xae]),
  sourceMap: Buffer.from('//# sourceMappingURL=app.js.map'),
})) {
  test(`rejects text ${name}`, () => throwsCode(() => releaseText(bytes), 'E0I_RELEASE_TEXT'));
}

test('binary assets are not subjected to text rules; local CSS resources and filters work', () => {
  validateReleaseContents(new Map([
    ['index.html', Buffer.from(html)],
    ['assets/app-123.js', Buffer.from('console.log("ready")')],
    ['assets/app-123.css', Buffer.from('@font-face{src:url("/assets/font-123.woff2")}svg{filter:url(#glass-dispersion)}')],
    ['assets/font-123.woff2', Buffer.from([0, 13, 0xff])],
  ]));
});

for (const css of ['@import "https://example.test/x.css";', 'a{background:url(data:x)}', 'a{background:url(//example.test/x)}', 'a{background:url(/assets/missing.png)}']) {
  test(`rejects CSS resource ${css}`, () => throwsCode(() => validateReleaseContents(new Map([
    ['index.html', Buffer.from(html)], ['assets/app-123.js', Buffer.from('1')], ['assets/x.css', Buffer.from(css)],
  ])), 'E0I_RELEASE_CSS'));
}

test('rejects dynamic JavaScript evaluation', () => {
  for (const js of ['eval("1")', 'new Function("1")']) {
    throwsCode(() => validateReleaseContents(new Map([
      ['index.html', Buffer.from(html)], ['assets/app-123.js', Buffer.from(js)],
    ])), 'E0I_RELEASE_SCRIPT');
  }
});
