import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildManifest, sha256, verifyRelease } from './files.js';
import { canonicalManifest, MAX_FILE_BYTES, WebReleaseError } from './manifest.js';
import { RESOURCE_CASES } from './resourceCases.js';

// On Windows Node reports every directory as mode 0o666, whatever its NTFS ACL, and chmod cannot change that, so
// verifyRelease refuses every release directory there (E0I_RELEASE_PATH) and never reaches its later checks. The tests
// that verify a release are macOS and Linux only.
const ntfsAcls = process.platform === 'win32' && 'NTFS ACLs, not mode bits: verifyRelease refuses every Windows directory';
const symlinks = process.platform === 'win32' && 'symlinks: Windows creates them only with a privilege or Developer Mode';

const shared = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(t: TestContext) {
  const dir = path.join(shared, `.web-release-test-${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'public/assets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'public/assets/app-123.js'), 'console.log("ready");\n');
  fs.writeFileSync(path.join(dir, 'public/assets/app-123.css'), 'body{color:green}\n');
  fs.writeFileSync(path.join(dir, 'public/assets/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  fs.writeFileSync(path.join(dir, 'public/index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/app-123.js"></script><link rel="stylesheet" crossorigin href="/assets/app-123.css"></head><body></body></html>\n');
  const built = buildManifest(path.join(dir, 'public'), 'a'.repeat(40));
  fs.writeFileSync(path.join(dir, 'manifest.json'), built.bytes);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ...built };
}
const throwsCode = (run: () => unknown, code: string) => assert.throws(run, (error: unknown) =>
  error instanceof WebReleaseError && error.code === code);

test('builds a deterministic manifest and verifies exact bytes', { skip: ntfsAcls }, (t) => {
  const f = fixture(t);
  const second = buildManifest(path.join(f.dir, 'public'), 'a'.repeat(40));
  assert.equal(f.digest, second.digest);
  const release = verifyRelease(f.dir, f.digest);
  for (const file of release.manifest.files) {
    assert.equal(release.files.get(file.path)!.length, file.size);
    assert.equal(sha256(release.files.get(file.path)!), file.sha256);
  }
});

const mutations: Array<[string, string, (dir: string) => void]> = [
  ['missing manifest', 'E0I_MANIFEST_MISSING', (dir) => fs.unlinkSync(path.join(dir, 'manifest.json'))],
  ['bad JSON', 'E0I_MANIFEST_INVALID', (dir) => fs.writeFileSync(path.join(dir, 'manifest.json'), '{}\n')],
  ['oversize manifest', 'E0I_MANIFEST_INVALID', (dir) => fs.truncateSync(path.join(dir, 'manifest.json'), 1024 * 1024 + 1)],
  ['manifest symlink', 'E0I_RELEASE_SYMLINK', (dir) => {
    fs.renameSync(path.join(dir, 'manifest.json'), path.join(dir, 'public/assets/manifest.js'));
    fs.symlinkSync('public/assets/manifest.js', path.join(dir, 'manifest.json'));
  }],
  ['public symlink', 'E0I_RELEASE_SYMLINK', (dir) => {
    fs.rmSync(path.join(dir, 'public'), { recursive: true });
    fs.symlinkSync('missing', path.join(dir, 'public'));
  }],
  ['asset symlink', 'E0I_RELEASE_SYMLINK', (dir) => {
    fs.unlinkSync(path.join(dir, 'public/assets/app-123.js'));
    fs.symlinkSync('../index.html', path.join(dir, 'public/assets/app-123.js'));
  }],
  ['hard link', 'E0I_RELEASE_HARDLINK', (dir) => fs.linkSync(path.join(dir, 'public/assets/app-123.js'), path.join(dir, 'public/assets/copy.js'))],
  ['dotfile', 'E0I_RELEASE_DOTFILE', (dir) => fs.writeFileSync(path.join(dir, 'public/.env'), 'not-a-secret')],
  ['extra file', 'E0I_RELEASE_EXTRA', (dir) => fs.writeFileSync(path.join(dir, 'public/assets/extra.js'), '1')],
  ['source map', 'E0I_RELEASE_EXTRA', (dir) => fs.writeFileSync(path.join(dir, 'public/assets/app.js.map'), '{}')],
  ['database', 'E0I_RELEASE_EXTRA', (dir) => fs.writeFileSync(path.join(dir, 'public/finance.db'), 'canary')],
  ['root extra', 'E0I_RELEASE_EXTRA', (dir) => fs.writeFileSync(path.join(dir, 'state.json'), '{}')],
  ['empty directory', 'E0I_RELEASE_EXTRA', (dir) => fs.mkdirSync(path.join(dir, 'public/empty'))],
  ['missing asset', 'E0I_RELEASE_MISSING', (dir) => fs.unlinkSync(path.join(dir, 'public/index.html'))],
  ['wrong hash', 'E0I_RELEASE_HASH', (dir) => fs.writeFileSync(path.join(dir, 'public/assets/app-123.js'), 'console.log("other");\n')],
  ['oversize file', 'E0I_RELEASE_LIMITS', (dir) => fs.truncateSync(path.join(dir, 'public/assets/app-123.js'), MAX_FILE_BYTES + 1)],
  ['unsafe directory', 'E0I_RELEASE_PATH', (dir) => fs.chmodSync(dir, 0o777)],
];
for (const [name, code, mutate] of mutations) {
  test(`verification refuses ${name}`, { skip: ntfsAcls }, (t) => {
    const f = fixture(t);
    mutate(f.dir);
    throwsCode(() => verifyRelease(f.dir, f.digest), code);
  });
}

test('rejects missing, relative, symlinked and non-canonical release paths', { skip: symlinks }, (t) => {
  const f = fixture(t);
  throwsCode(() => verifyRelease(path.join(f.dir, 'missing'), f.digest), 'E0I_RELEASE_PATH');
  throwsCode(() => verifyRelease('relative', f.digest), 'E0I_RELEASE_CONFIG');
  throwsCode(() => verifyRelease(f.dir + '/.', f.digest), 'E0I_RELEASE_PATH');
  const link = path.join(f.dir, 'linked');
  fs.symlinkSync(f.dir, link);
  throwsCode(() => verifyRelease(link, f.digest), 'E0I_RELEASE_PATH');
});

test('rejects the wrong pinned digest', { skip: ntfsAcls }, (t) => {
  const f = fixture(t);
  throwsCode(() => verifyRelease(f.dir, 'd'.repeat(64)), 'E0I_MANIFEST_DIGEST');
});

test('reports a stable, value-free code for filesystem acquisition failures', { skip: ntfsAcls }, (t) => {
  const f = fixture(t);
  t.mock.method(fs, 'readdirSync', () => { throw new Error('IO_ACQUISITION_CANARY'); });
  throwsCode(() => verifyRelease(f.dir, f.digest), 'E0I_RELEASE_PATH');
});

for (const [name, value, code] of [
  ['text', Buffer.from('a\rb'), 'E0I_RELEASE_TEXT'],
  ['UTF-8', Buffer.from([0xc0, 0xae]), 'E0I_RELEASE_TEXT'],
  ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>'), 'E0I_RELEASE_HTML'],
] as const) {
  test(`re-checks ${name} rules even with a valid manifest hash`, { skip: ntfsAcls }, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.dir, 'public/index.html'), value);
    const files = f.manifest.files.map((file) => file.path === 'index.html'
      ? { ...file, size: value.length, sha256: sha256(value) } : file);
    const bytes = canonicalManifest({ ...f.manifest, files });
    fs.writeFileSync(path.join(f.dir, 'manifest.json'), bytes);
    throwsCode(() => verifyRelease(f.dir, sha256(bytes)), code);
  });
}

for (const [label, kind, content] of RESOURCE_CASES) {
  test(`both build and repinned startup refuse ${label}`, { skip: ntfsAcls }, (t) => {
    const f = fixture(t);
    const name = kind === 'html' ? 'index.html' : 'assets/app-123.css';
    const previous = fs.readFileSync(path.join(f.dir, 'public', name), 'utf8');
    const bytes = Buffer.from(kind === 'html' ? previous.replace('</body>', content + '</body>') : content);
    fs.writeFileSync(path.join(f.dir, 'public', name), bytes);
    const code = kind === 'html' ? 'E0I_RELEASE_HTML' : 'E0I_RELEASE_CSS';
    throwsCode(() => buildManifest(path.join(f.dir, 'public'), 'a'.repeat(40)), code);
    const manifest = canonicalManifest({
      ...f.manifest,
      files: f.manifest.files.map((file) => file.path === name ? { ...file, size: bytes.length, sha256: sha256(bytes) } : file),
    });
    fs.writeFileSync(path.join(f.dir, 'manifest.json'), manifest);
    throwsCode(() => verifyRelease(f.dir, sha256(manifest)), code);
  });
}
