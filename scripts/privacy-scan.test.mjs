// The privacy gate scans exactly the files it is asked for (the staged index by default), matches private blocklist
// terms as words, and never prints what it matched. Each case builds a throwaway repository with a copy of the scanner.
// Every sensitive-looking value is assembled at run time, and the blocklist terms are synthetic stand-ins passed in
// PRIVACY_SCAN_BLOCKLIST, so this file passes the scan itself and names no real person.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const scanner = fileURLToPath(new URL('./privacy-scan.mjs', import.meta.url));
const join = (...parts) => parts.join('');

function repository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-privacy-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe', input, encoding: 'utf8' });
  git(['init', '-q']);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(scanner, path.join(dir, 'scripts', 'privacy-scan.mjs'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const scan = (args = [], blocklist = '') => {
    const result = spawnSync(process.execPath, ['scripts/privacy-scan.mjs', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PRIVACY_SCAN_BLOCKLIST: blocklist },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { dir, git, write, scan };
}

test('a synthetic, fully staged tree passes', (t) => {
  const { git, write, scan } = repository(t);
  write('src/ok.ts', "export const origin = 'https://holdr.example.ts.net';\nexport const lan = '192.0.2.10';\nexport const card = '4111 1111 1111 1111';\n");
  git(['add', '-A']);
  const result = scan();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /privacy scan of the staged index passed \(no private blocklist\): 2 files checked/);
});

test('generic findings report categories and paths, never the values', (t) => {
  const { git, write, scan } = repository(t);
  const address = join('10.', '9.8', '.7');
  const tailnet = join('node.tail', 'abc123', '.ts.net');
  const email = join('someone', '@', 'mail.example', 'corp.com');
  const card = join('4532', '0151', '1283', '0366');
  const home = join('/Us', 'ers/', 'jordan', 'q/notes');
  const fingerprint = join('SHA256', ':', 'A'.repeat(43));
  const sshKey = join('ssh-', 'ed25519 ', 'AAAA', 'C3NzaC1lZDI1NTE5AAAAIB'.repeat(2));
  write('src/net.ts', `export const host = '${address}';\nexport const name = '${tailnet}';\n`);
  write('docs/contact.md', `Write to ${email}.\nNotes live in ${home}.\n`);
  write('fixtures/card.txt', `${card}\n`);
  write('ops/fingerprint.txt', `${fingerprint}\n`);
  write('ops/key.txt', `${sshKey}\n`);
  write('apps/api/data/state.json', '{}\n');
  write('exports/receipt.png', 'not really a picture\n');
  write('.env', 'HOLDR_PORT=4000\n');
  git(['add', '-A']);
  const result = scan();
  assert.equal(result.status, 1, result.output);
  for (const line of [
    'unapproved-ip-address: src/net.ts:1', 'concrete-tailnet-hostname: src/net.ts:2', 'non-example-email: docs/contact.md:1',
    'machine-specific-user-path: docs/contact.md:2', 'possible-card-number: fixtures/card.txt:1',
    'ssh-key-or-fingerprint: ops/fingerprint.txt:1', 'ssh-key-or-fingerprint: ops/key.txt:1', 'runtime-or-generated-file: apps/api/data/state.json',
    'document-image-or-archive: exports/receipt.png', 'host-config-or-environment-file: .env',
  ]) assert.ok(result.output.includes(line), `${line}\n${result.output}`);
  for (const value of [address, tailnet, email, card, 'jordanq', fingerprint, sshKey]) assert.ok(!result.output.includes(value), value);
});

test('blocklist terms match as words and long terms as substrings, in contents and paths, never printed', (t) => {
  const { git, write, scan } = repository(t);
  // Synthetic stand-ins: a short term, a long term, and an address that is otherwise on the synthetic allowlist.
  const blocklist = ['vex', 'quorvant', '192.168.24.65'].join(',');
  write('src/clean.ts', "export const shape = 'convex';\nexport const lan = '192.168.24.650';\n");
  write('src/upper.ts', 'export const VEX_ROWS = 1;\n');
  write('src/camel.ts', 'export const vexRows = 1;\n');
  write('src/digits.ts', "export const id = 'vex42';\n");
  write('src/inner.ts', "export const label = 'myquorvantfile';\n");
  write('src/address.ts', "export const lan = '192.168.24.65';\n");
  write('notes/quorvant-trip.md', 'synthetic\n');
  git(['add', '-A']);
  assert.equal(scan().status, 0, 'without the blocklist nothing here is personal');
  const result = scan([], blocklist);
  assert.equal(result.status, 1, result.output);
  for (const file of ['src/upper.ts:1', 'src/camel.ts:1', 'src/digits.ts:1', 'src/inner.ts:1', 'src/address.ts:1']) {
    assert.ok(result.output.includes(`local-blocklist-term: ${file}`), `${file}\n${result.output}`);
  }
  assert.ok(result.output.includes('local-blocklist-term-in-path: notes/***'), result.output);
  assert.ok(!result.output.includes('src/clean.ts'), result.output);
  assert.match(result.output, /3 private blocklist term\(s\)/);
  assert.doesNotMatch(result.output, /vex|quorvant|192\.168\.24\.65/i);
});

test('the default scan reads the staged index and fails while the disk differs from it', (t) => {
  const { dir, git, write, scan } = repository(t);
  const address = join('192.', '168.', '77.', '12');
  write('src/net.ts', "export const host = '192.0.2.1';\n");
  git(['add', '-A']);
  write('src/net.ts', `export const host = '${address}';\n`);
  const modified = scan();
  assert.equal(modified.status, 1, modified.output);
  assert.match(modified.output, /unstaged-change: src\/net\.ts/);
  assert.doesNotMatch(modified.output, /unapproved-ip-address/, 'the staged blob is clean');
  assert.match(scan(['--worktree']).output, /unapproved-ip-address: src\/net\.ts:1/);

  git(['add', '-A']);
  write('src/net.ts', "export const host = '192.0.2.1';\n");
  write('src/new.ts', 'export {};\n');
  const staged = scan();
  assert.equal(staged.status, 1, staged.output);
  for (const line of ['unapproved-ip-address: src/net.ts:1', 'unstaged-change: src/net.ts', 'untracked-file: src/new.ts']) {
    assert.ok(staged.output.includes(line), `${line}\n${staged.output}`);
  }
  assert.equal(scan(['--worktree']).status, 0);

  // A tracked file deleted from the disk is a pending deletion: the working-tree scan skips it and does not count it.
  git(['add', '-A']);
  write('src/gone.ts', 'export {};\n');
  git(['add', '-A']);
  fs.rmSync(path.join(dir, 'src', 'gone.ts'));
  const deleted = scan(['--worktree']);
  assert.equal(deleted.status, 0, deleted.output);
  assert.match(deleted.output, /passed \(no private blocklist\): 3 files checked/);
});

// Synthetic images for the image allowlist. The scanner reads the container layout only, so CRCs are left zero and the
// pixel data is arbitrary.
function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function png(...extra) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), ...extra,
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))), pngChunk('IEND')]);
}
function riffChunk(type, data) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), size, data, Buffer.alloc(data.length % 2)]);
}
function webp(...chunks) {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
}
const vp8x = (flags) => riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
const lossless = () => riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0]));

test('metadata-free PNG and WebP images of at most 1 MB pass in the three image folders only', (t) => {
  const { dir, git, scan } = repository(t);
  const place = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), bytes);
  };
  const colorInfo = [pngChunk('sRGB', Buffer.from([0])), pngChunk('gAMA', Buffer.alloc(4)), pngChunk('pHYs', Buffer.alloc(9))];
  place('docs/assets/brand/mark-32.png', png(...colorInfo));
  place('docs/assets/screenshots/portfolio.png', png(pngChunk('PLTE', Buffer.alloc(3)), pngChunk('tRNS', Buffer.from([0]))));
  place('docs/assets/screenshots/gold-dark.webp', webp(lossless()));
  place('docs/assets/screenshots/benefits-light.webp', webp(vp8x(0x10), riffChunk('ALPH', Buffer.alloc(3)), riffChunk('VP8 ', Buffer.alloc(10))));
  place('apps/web/src/assets/brand/favicon-32.png', png());
  place('docs/assets/brand/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Synthetic mark</title></svg>\n');
  git(['add', '-A']);
  const clean = scan();
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /7 files checked/, 'six images and SVGs, and the scanner itself');

  // The same clean image anywhere else (the web app's old public folder included), and any other kind of image in an
  // image folder, is refused as before.
  place('docs/screens/mark-32.png', png());
  place('apps/web/src/logo.png', png());
  place('apps/web/public/icon-32.png', png());
  place('docs/assets/brand/mark.gif', Buffer.from('GIF89a', 'latin1'));
  place('docs/assets/screenshots/spending.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  git(['add', '-A']);
  const elsewhere = scan();
  assert.equal(elsewhere.status, 1, elsewhere.output);
  for (const file of ['docs/screens/mark-32.png', 'apps/web/src/logo.png', 'apps/web/public/icon-32.png', 'docs/assets/brand/mark.gif',
    'docs/assets/screenshots/spending.jpg']) {
    assert.ok(elsewhere.output.includes(`document-image-or-archive: ${file}`), `${file}\n${elsewhere.output}`);
  }
  assert.ok(!/brand\/mark-32\.png|screenshots\/portfolio\.png|\.webp|favicon-32/.test(elsewhere.output), elsewhere.output);
});

test('an image in an image folder with metadata, another format, extra bytes or over 1 MB is refused', (t) => {
  const { dir, git, scan } = repository(t);
  const place = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), bytes);
  };
  const metadata = {
    text: pngChunk('tEXt', Buffer.from('Comment\0synthetic', 'latin1')),
    itext: pngChunk('iTXt', Buffer.from('Author\0\0\0\0\0synthetic', 'latin1')),
    ztext: pngChunk('zTXt', Buffer.concat([Buffer.from('Software\0\0', 'latin1'), zlib.deflateSync(Buffer.from('synthetic'))])),
    exif: pngChunk('eXIf', Buffer.from('MM\0*', 'latin1')),
    icc: pngChunk('iCCP', Buffer.from('profile\0\0', 'latin1')),
    time: pngChunk('tIME', Buffer.alloc(7)),
    unknown: pngChunk('prVt', Buffer.from('synthetic', 'latin1')),
  };
  const refused = [];
  for (const [name, chunk] of Object.entries(metadata)) {
    place(`docs/assets/brand/${name}.png`, png(chunk));
    refused.push(`docs/assets/brand/${name}.png`);
  }
  const cases = {
    'docs/assets/screenshots/trailing.png': Buffer.concat([png(), Buffer.from('synthetic', 'latin1')]),
    'docs/assets/screenshots/no-header.png': Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IDAT', Buffer.alloc(2)), pngChunk('IEND')]),
    'docs/assets/screenshots/webp-named.png': webp(lossless()),
    'apps/web/src/assets/brand/exif.webp': webp(vp8x(0x08), lossless(), riffChunk('EXIF', Buffer.from('MM\0*', 'latin1'))),
    'apps/web/src/assets/brand/xmp.webp': webp(vp8x(0x04), lossless(), riffChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1'))),
    'apps/web/src/assets/brand/icc.webp': webp(vp8x(0x20), riffChunk('ICCP', Buffer.alloc(4)), lossless()),
    'apps/web/src/assets/brand/declared.webp': webp(vp8x(0x08), lossless()),
    'apps/web/src/assets/brand/unknown.webp': webp(lossless(), riffChunk('SYNT', Buffer.alloc(2))),
    'apps/web/src/assets/brand/short.webp': Buffer.concat([webp(lossless()), Buffer.alloc(2)]),
    'apps/web/src/assets/brand/png-named.webp': png(),
  };
  for (const [file, bytes] of Object.entries(cases)) {
    place(file, bytes);
    refused.push(file);
  }
  place('docs/assets/screenshots/huge.png', png(pngChunk('IDAT', Buffer.alloc(1024 * 1024))));
  git(['add', '-A']);
  const result = scan();
  assert.equal(result.status, 1, result.output);
  for (const file of refused) {
    assert.ok(result.output.includes(`image-metadata-or-unknown-format: ${file}`), `${file}\n${result.output}`);
  }
  assert.ok(result.output.includes('image-over-1-mb: docs/assets/screenshots/huge.png'), result.output);
  assert.doesNotMatch(result.output, /synthetic|xmpmeta/);
});

test('SVG files in the image folders are scanned as text', (t) => {
  const { git, write, scan } = repository(t);
  const email = join('designer', '@', 'mail.example', 'corp.com');
  write('docs/assets/brand/lockup.svg', `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${email} --></svg>\n`);
  git(['add', '-A']);
  const result = scan();
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes('non-example-email: docs/assets/brand/lockup.svg:1'), result.output);
  assert.ok(!result.output.includes(email), result.output);
});

test('structural problems fail: links, submodules, LFS pointers, large, NUL and UTF-16 files', (t) => {
  const { git, write, scan } = repository(t);
  write('README.md', 'synthetic\n');
  write('assets/big.txt', 'a'.repeat(5 * 1024 * 1024 + 1));
  write('assets/blob.bin.txt', Buffer.from([0x61, 0x00, 0x62]));
  write('docs/wide.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]));
  write('assets/model.txt', join('version https://git-lfs.github.com/spec/', 'v1\noid sha256:', 'a'.repeat(64), '\nsize 1\n'));
  git(['add', '-A']);
  const target = git(['hash-object', '-w', '--stdin'], 'README.md').trim();
  git(['update-index', '--add', '--cacheinfo', `120000,${target},link`]);
  git(['update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},vendor/sub`]);
  git(['commit', '-qm', 'synthetic', '--no-verify']);
  const result = scan(['--tree', 'HEAD']);
  assert.equal(result.status, 1, result.output);
  for (const line of ['symbolic-link: link', 'submodule: vendor/sub', 'git-lfs-pointer: assets/model.txt', 'file-over-5-mb: assets/big.txt',
    'binary-file-with-nul-bytes: assets/blob.bin.txt', 'utf-16-file: docs/wide.txt']) {
    assert.ok(result.output.includes(line), `${line}\n${result.output}`);
  }
});

test('--require-blocklist refuses to run without private terms, and --tree needs a value', (t) => {
  const { git, write, scan } = repository(t);
  write('README.md', 'synthetic\n');
  git(['add', '-A']);
  const missing = scan(['--require-blocklist']);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /--require-blocklist needs at least one term/);
  const present = scan(['--require-blocklist'], 'quorvant');
  assert.equal(present.status, 0, present.output);
  assert.match(present.output, /1 private blocklist term\(s\)/);
  assert.equal(scan(['--tree']).status, 2);
});

test('the blocklist file may be UTF-8 or UTF-16 with a byte-order mark; a term that cannot match stops the scan', (t) => {
  const { dir, git, write, scan } = repository(t);
  write('.gitignore', '.privacy-scan.local\n');
  write('notes/trip.md', 'Synthetic notes about quorvant.\n');
  git(['add', '-A']);
  const blocklist = (bytes) => fs.writeFileSync(path.join(dir, '.privacy-scan.local'), bytes);
  for (const [encoding, bytes] of [
    ['UTF-8', Buffer.from('# synthetic\nquorvant\n', 'utf8')],
    ['UTF-8 with a byte-order mark', Buffer.from('\uFEFF# synthetic\r\nquorvant\r\n', 'utf8')],
    ['UTF-16 LE, as Windows PowerShell 5.1 writes with >', Buffer.from('\uFEFF# synthetic\r\nquorvant\r\n', 'utf16le')],
    ['UTF-16 BE', Buffer.from('\uFEFF# synthetic\nquorvant\n', 'utf16le').swap16()],
  ]) {
    blocklist(bytes);
    const result = scan(['--require-blocklist']);
    assert.equal(result.status, 1, `${encoding}\n${result.output}`);
    assert.ok(result.output.includes('local-blocklist-term: notes/trip.md:1'), `${encoding}\n${result.output}`);
    assert.match(result.output, /\(1 private blocklist term\(s\)\)/, encoding);
  }

  // Each of these would have matched nothing, so the scan stops with or without --require-blocklist, naming only where.
  for (const [problem, bytes, where] of [
    ['UTF-16 without a byte-order mark', Buffer.from('quorvant\r\n', 'utf16le'), '.privacy-scan.local line 1'],
    ['Windows-1252', Buffer.from([0x71, 0x75, 0x6f, 0x72, 0xe9, 0x76, 0x61, 0x6e, 0x74, 0x0a]), '.privacy-scan.local line 1'],
    ['a control character', Buffer.from('# synthetic\nquor\u0007vant\n', 'utf8'), '.privacy-scan.local line 2'],
  ]) {
    blocklist(bytes);
    for (const args of [[], ['--require-blocklist']]) {
      const result = scan(args);
      assert.equal(result.status, 1, `${problem}\n${result.output}`);
      assert.ok(result.output.includes(`unusable blocklist term (${where}`), `${problem}\n${result.output}`);
      assert.match(result.output, /Set-Content -Encoding utf8/);
      assert.doesNotMatch(result.output, /quor|passed/i);
    }
  }
  fs.rmSync(path.join(dir, '.privacy-scan.local'));
  const invisible = scan([], `quorvant,velmor${'\u200B'}tisk`);
  assert.equal(invisible.status, 1, invisible.output);
  assert.ok(invisible.output.includes('unusable blocklist term (PRIVACY_SCAN_BLOCKLIST entry 2)'), invisible.output);
});

test('blocklist terms match ordinary spellings: accents, width, separators, line wraps, %20 and base64', (t) => {
  const { git, write, scan } = repository(t);
  const blocklist = ['quorvant', 'velmor tisk', '48213'].join(',');
  const flagged = {
    'src/accent.ts': "export const a = 'Qüorvant';\n",
    'src/fullwidth.ts': "export const a = 'ＱＵＯＲＶＡＮＴ';\n",
    'src/dotted.ts': "export const a = 'quor.vant';\n",
    'src/snake.ts': 'export const QUOR_VANT = 1;\n',
    'src/camel.ts': 'export const byVelmorTisk = 1;\n',
    'notes/spaced.md': 'The Quor vant file.\n',
    'notes/hyphen.md': 'velmor-tisk\n',
    'notes/double.md': 'velmor  tisk\n',
    'notes/wrapped.md': 'Written by Velmor\n  Tisk last year.\n',
    'notes/link.md': '[profile](https://example.com/?name=velmor%20tisk)\n',
    'notes/encoded.txt': `note: ${Buffer.from('owner: Velmor Tisk, synthetic').toString('base64')}\n`,
    'notes/encoded-url.txt': `id=${Buffer.from('~~Quorvant?~~').toString('base64url')}\n`,
    'notes/account.md': 'Account 48-213.\n',
  };
  assert.match(flagged['notes/encoded-url.txt'], /[-_]/, 'a base64url run');
  for (const [file, text] of Object.entries(flagged)) write(file, text);
  write('notes/clean.md', 'A quor vantage point, Velmor tiskets and an amount of 482.13.\n');
  write('notes/binary.txt', `sha512-${Buffer.alloc(48, 0xfe).toString('base64')}\n`);
  git(['add', '-A']);
  assert.equal(scan().status, 0, 'without the blocklist nothing here is personal');
  const result = scan([], blocklist);
  assert.equal(result.status, 1, result.output);
  for (const file of Object.keys(flagged)) {
    assert.ok(result.output.includes(`local-blocklist-term: ${file}:1`), `${file}\n${result.output}`);
  }
  assert.ok(!/clean\.md|binary\.txt/.test(result.output), result.output);
  assert.doesNotMatch(result.output, /quor|velmor|tisk|48213/i);
});

test("Holdr's token and pairing-key files and agent tokens are refused anywhere, never printed", (t) => {
  const { git, write, scan } = repository(t);
  const token = join('holdr_', 'agent_', 'c0ffee'.repeat(10), 'beef');
  const refused = ['notes/agent-token', 'backup-copy/service-token', 'tmp/service-token.1234.abcdef.tmp',
    'agents/card-sync/extension/local-key.json', 'agents/card-sync/extension/.local-key.json.42.tmp'];
  for (const file of refused) write(file, '{}\n');
  write('src/serviceToken.ts', 'export {};\n');
  write('docs/agent-tokens.md', 'Synthetic notes.\n');
  write('scripts/check.mjs', `const token = '${token}';\n`);
  git(['add', '-A']);
  const result = scan();
  assert.equal(result.status, 1, result.output);
  for (const file of refused) assert.ok(result.output.includes(`holdr-token-or-key-file: ${file}`), `${file}\n${result.output}`);
  assert.ok(result.output.includes('secret-material: scripts/check.mjs:1'), result.output);
  assert.ok(!/serviceToken\.ts|agent-tokens\.md/.test(result.output), result.output);
  assert.ok(!result.output.includes(token.slice(12)), result.output);
});

/** `body` with the Luhn check digit appended. */
function withCheckDigit(body) {
  for (let check = 0; check <= 9; check += 1) {
    const digits = `${body}${check}`;
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
      let value = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) value = value * 2 > 9 ? value * 2 - 9 : value * 2;
      sum += value;
    }
    if (sum % 10 === 0) return digits;
  }
  throw new Error('unreachable');
}

test('generic rules check paths too, home folders in any letter case, %40 e-mails, 13 to 19 digit cards and SVG data', (t) => {
  const { git, write, scan } = repository(t);
  const email = join('someone', '@', 'mail.example', 'corp.com');
  const encoded = join('someone', '%40', 'mail.example', 'corp.com');
  const visa13 = withCheckDigit('453201511283');
  const unionPay19 = withCheckDigit('620001511283036612');
  const visa16 = withCheckDigit('453201511283036');
  const grouped = (digits) => digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  write(`notes/${email}.md`, 'synthetic\n');
  write(join('fixtures/', 'Users/', 'jordanq', '/notes.txt'), 'synthetic\n');
  write('src/lower.ts', `export const home = '${join('c:', '\\users\\', 'jordanq')}';\n`);
  write('src/upper.ts', `export const home = '${join('/US', 'ERS/', 'jordanq')}/notes';\n`);
  write('docs/contact.md', `Write to ${encoded}.\n`);
  write('fixtures/visa13.txt', `${visa13}\n`);
  write('fixtures/unionpay19.txt', `${grouped(unionPay19)}\n`);
  write('fixtures/expiry.txt', `${grouped(visa16)} 12/28\n`);
  write('fixtures/not-cards.txt', [
    `posted ${withCheckDigit('2026031512000')}`, // a YYYYMMDDhhmmss timestamp that passes the Luhn check
    'S-1-5-21-1000000000-2000000000-3000000000-1001', // a Windows SID
    `price 0.${visa16}`,
    "ref '320262570000000009'", // an 18-digit American Express reference
    '4222222222222',
    '30569309025904',
  ].join('\n'));
  write('package-lock.json', `{\n  "name": "synthetic",\n  "author": "${email}"\n}\n`);
  write('docs/assets/brand/badge.svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/></svg>\n');
  git(['add', '-A']);
  const result = scan();
  assert.equal(result.status, 1, result.output);
  for (const line of [
    'non-example-email-in-path: notes/***', 'machine-specific-user-path-in-path: fixtures/***/***/notes.txt',
    'machine-specific-user-path: src/lower.ts:1', 'machine-specific-user-path: src/upper.ts:1', 'non-example-email: docs/contact.md:1',
    'possible-card-number: fixtures/visa13.txt:1', 'possible-card-number: fixtures/unionpay19.txt:1',
    'possible-card-number: fixtures/expiry.txt:1', 'non-example-email: package-lock.json:3',
    'svg-embedded-data-uri: docs/assets/brand/badge.svg:1',
  ]) assert.ok(result.output.includes(line), `${line}\n${result.output}`);
  assert.ok(!result.output.includes('not-cards'), result.output);
  for (const value of [email, encoded, 'jordanq', visa13, unionPay19, visa16]) assert.ok(!result.output.includes(value), value);
});