import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkKitLinks, enumerateKitLinks, recordsText, resolveLinkWithin, verifyKitLinks } from './kit-links.mjs';

// The rollback kit's link containment (design §11.3 step 11a; B2 review finding 6, B2 round-2 finding 1), on real directories
// and links.
const cli = fileURLToPath(new URL('./kit-links.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' };

async function kit() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'kit-links-')));
  const kr = path.join(home, 'holdr-rollback', 'stamp');
  const k = path.join(kr, 'FinanceTracker');
  for (const dir of ['node_modules/.bin', 'node_modules/tsx/dist', 'node_modules/@finance-tracker', 'packages/shared', 'a/b/c', 'flat']) {
    await mkdir(path.join(k, dir), { recursive: true });
  }
  await writeFile(path.join(k, 'node_modules/tsx/dist/cli.mjs'), '');
  await writeFile(path.join(k, 'file'), '');
  await writeFile(path.join(home, 'OUTSIDE'), 'external canary\n');
  const link = async (name, target) => { await symlink(target, path.join(k, name)); return { link: `./FinanceTracker/${name}`, target }; };
  return { home, kr, k, link, cleanup: () => rm(home, { recursive: true, force: true }) };
}
const shown = (record) => JSON.stringify(record);

test('npm\'s own relative links, workspace links and dangling links with plain names resolve inside K', posix, async () => {
  const t = await kit();
  try {
    const records = [
      await t.link('node_modules/.bin/tsx', '../tsx/dist/cli.mjs'),
      await t.link('node_modules/@finance-tracker/shared', '../../packages/shared'),
      await t.link('chain', 'node_modules/.bin/tsx'),
      await t.link('dangling', 'not-yet/there.txt'),
    ];
    assert.deepEqual(checkKitLinks(t.kr, records), []);
    assert.deepEqual(resolveLinkWithin(t.k, path.join(t.k, 'chain')), { path: path.join(t.k, 'node_modules/tsx/dist/cli.mjs') });
    assert.deepEqual(resolveLinkWithin(t.k, path.join(t.k, 'dangling')), { path: path.join(t.k, 'not-yet/there.txt'), dangling: true });
    // The walk finds exactly these, sorted by path, as canonical JSON lines.
    const { records: found, problems } = enumerateKitLinks(t.kr);
    assert.deepEqual(problems, []);
    assert.deepEqual(found, [...records].sort((a, b) => (a.link < b.link ? -1 : 1)));
    assert.deepEqual(verifyKitLinks(t.kr, recordsText(found)), []);
  } finally { await t.cleanup(); }
});

test('the chained escape that lexical checks miss, and every other way out of K, is refused', posix, async () => {
  const t = await kit();
  try {
    // The review's reproduction: the text collapses to K/OUTSIDE, the kernel reaches HOME/OUTSIDE.
    const chain = [await t.link('a/b/c/l', '../../../flat'), await t.link('escape', 'a/b/c/l/../../../../OUTSIDE')];
    assert.equal(path.resolve(t.kr, './FinanceTracker', 'a/b/c/l/../../../../OUTSIDE').startsWith(`${t.k}/`), true, 'lexically inside');
    assert.deepEqual(checkKitLinks(t.kr, chain), [`${shown(chain[1])}: outside`]);
    for (const [name, target, reason] of [
      ['up', '../../OUTSIDE', 'outside'], ['abs', '/etc/hosts', 'absolute target'], ['self', 'self', 'loop'],
      ['missing-up', 'missing/../../OUTSIDE', 'unresolvable'], ['through-file', 'file/x', 'not-a-directory'],
      ['round-trip', '../FinanceTracker/file', 'outside'],
    ]) {
      const record = await t.link(name, target);
      assert.deepEqual(checkKitLinks(t.kr, [record]), [`${shown(record)}: ${reason}`], name);
    }
    await symlink('FinanceTracker/file', path.join(t.kr, 'outer'));
    const outer = { link: './outer', target: 'FinanceTracker/file' };
    assert.deepEqual(checkKitLinks(t.kr, [outer]), [`${shown(outer)}: not inside K`]);
  } finally { await t.cleanup(); }
});

test('B2 round-2 finding 1: delimiter, quote and newline names and targets can no longer forge or split a record', posix, async () => {
  // The eight external dependencies the review's matrix found accepted, and its two contained positive controls.
  const escapes = [
    ['delimiter name, absolute target', 'escape -> alias', (t) => path.join(t.home, 'OUTSIDE'), 'absolute target'],
    ['delimiter name, parent components', 'escape -> alias', () => '../../../OUTSIDE', 'outside'],
    ['quoted delimiter name', 'escape " -> " alias', (t) => path.join(t.home, 'OUTSIDE'), 'absolute target'],
    ['backslash before the delimiter', 'escape \\ -> alias', (t) => path.join(t.home, 'OUTSIDE'), 'absolute target'],
    ['newline target forging a second record', 'escape -> alias', () => '../../../OUTSIDE\n./FinanceTracker/shadow -> safe', 'control'],
    ['newline in the link path', 'piece\n./FinanceTracker/escape', () => '../../../../../OUTSIDE', 'control'],
    ['trailing newline in the target, delimiter name', 'escape -> alias', () => '../../../OUTSIDE\n', 'control'],
  ];
  for (const [what, name, target, reason] of escapes) {
    const t = await kit();
    try {
      // 'piece\n./FinanceTracker/escape' is a link escape in the directories 'piece\n.' and FinanceTracker below K.
      await mkdir(path.dirname(path.join(t.k, name)), { recursive: true });
      await symlink(target(t), path.join(t.k, name));
      const { records, problems } = enumerateKitLinks(t.kr);
      if (reason === 'control') {
        assert.equal(problems.length, 1, `${what}: ${problems}`);
        assert.match(problems[0], /a (name|link target) with a control character$/, what);
      } else {
        assert.deepEqual(problems, [], what);
        assert.deepEqual(checkKitLinks(t.kr, records), [`${shown({ link: `./FinanceTracker/${name}`, target: target(t) })}: ${reason}`], what);
        // The record is the actual link: its name and target round-trip exactly.
        assert.deepEqual(records, [{ link: `./FinanceTracker/${name}`, target: target(t) }], what);
      }
      const recorded = spawnSync(process.execPath, [cli, 'record', t.kr], { encoding: 'utf8' });
      assert.equal(recorded.status, 1, what);
      assert.equal(recorded.stdout, '', `${what}: nothing is recorded`);
    } finally { await t.cleanup(); }
  }
  // The eighth: a delimiter-named chain crossing the kit boundary through a link outside it.
  {
    const t = await kit();
    try {
      await symlink('OUTSIDE', path.join(t.home, 'outside-link'));
      await symlink('../../../outside-link', path.join(t.k, 'jump -> alias'));
      await symlink('jump -> alias', path.join(t.k, 'follow -> alias'));
      const { records } = enumerateKitLinks(t.kr);
      assert.deepEqual(checkKitLinks(t.kr, records), [
        `${shown({ link: './FinanceTracker/follow -> alias', target: 'jump -> alias' })}: outside`,
        `${shown({ link: './FinanceTracker/jump -> alias', target: '../../../outside-link' })}: outside`,
      ]);
    } finally { await t.cleanup(); }
  }
  // Positive controls: a delimiter or quotes inside a contained target are just characters.
  {
    const t = await kit();
    try {
      await writeFile(path.join(t.k, 'inside -> target'), 'pinned inside kit\n');
      await writeFile(path.join(t.k, '"inside -> target"'), 'literal quote bytes\n');
      const records = [await t.link('normal', 'inside -> target'), await t.link('quoted', '"inside -> target"')];
      const { records: found, problems } = enumerateKitLinks(t.kr);
      assert.deepEqual(problems, []);
      assert.deepEqual(found, records);
      assert.deepEqual(checkKitLinks(t.kr, found), []);
      const recorded = spawnSync(process.execPath, [cli, 'record', t.kr], { encoding: 'utf8' });
      assert.equal(recorded.status, 0, recorded.stderr);
      assert.equal(recorded.stdout, recordsText(records));
    } finally { await t.cleanup(); }
  }
});

test('verify: exactly the recorded links (canonical JSON, same order), each contained; anything else refuses', posix, async () => {
  const t = await kit();
  try {
    const records = [await t.link('node_modules/.bin/tsx', '../tsx/dist/cli.mjs'), await t.link('chain', 'node_modules/.bin/tsx')];
    const file = path.join(t.home, 'links');
    const recorded = spawnSync(process.execPath, [cli, 'record', t.kr], { encoding: 'utf8' });
    assert.equal(recorded.status, 0, recorded.stderr);
    await writeFile(file, recorded.stdout);
    assert.equal(spawnSync(process.execPath, [cli, 'verify', t.kr, file]).status, 0);
    const text = recordsText([...records].sort((a, b) => (a.link < b.link ? -1 : 1)));
    assert.equal(recorded.stdout, text);
    for (const [what, forged] of [
      ['a missing record', text.split('\n')[0] + '\n'],
      ['an extra record', `${text}${JSON.stringify({ link: './FinanceTracker/ghost', target: 'file' })}\n`],
      ['another order', text.split('\n').filter(Boolean).reverse().join('\n') + '\n'],
      ['non-canonical JSON', text.replace('{"link"', '{ "link"')],
      ['the old " -> " lines', records.map(({ link, target }) => `${link} -> ${target}`).join('\n') + '\n'],
    ]) {
      assert.deepEqual(verifyKitLinks(t.kr, forged), ['the kit\'s symlinks differ from the recorded ones'], what);
    }
    // A link added after prepare, even a contained one, differs from the record.
    await symlink('file', path.join(t.k, 'later'));
    const refused = spawnSync(process.execPath, [cli, 'verify', t.kr, file], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /rollback-kit: the kit's symlinks differ from the recorded ones/);
    assert.equal(spawnSync(process.execPath, [cli, 'verify', 'relative', file]).status, 64);
    assert.equal(spawnSync(process.execPath, [cli, 'record', t.kr, file]).status, 64);
    assert.equal(spawnSync(process.execPath, [cli, t.kr, file]).status, 64, 'the old two-argument form is gone');
  } finally { await t.cleanup(); }
});
