// Containment of a rollback kit's symlinks (design §11.3 step 11a; deviation B-D29 as revised after the B2 review, finding 6,
// and B2 round 2, finding 1). A kit must depend on nothing outside K = KR/FinanceTracker, so every symlink under KR must lie
// inside K and resolve inside K the way the kernel resolves it: component by component, following every symlink (also inside a
// target, also the last component), with `..` applied to the physical directory reached so far. Lexical normalisation
// (`path.resolve`, and Node's JavaScript `realpathSync`, which normalises first) is not used: `a/b/c/l/../../../../X` through
// `a/b/c/l -> ../../../flat` leaves K although its text collapses to `K/X`. Every directory the walk passes through must stay
// inside K, so the result does not depend on any directory outside the kit either. A dangling link is allowed only when the
// missing part consists of plain names below a directory inside K; absolute targets, loops and `..` below a missing component
// are refused.
//
// The links are found by walking KR itself, never by parsing a listing: a record is one JSON object per line,
// {"link":"./FinanceTracker/<path>","target":"<readlink>"}, sorted by path, so a name or a target containing " -> " or a quote
// stays one string. A name anywhere under KR, or a link target, with a control character (a newline above all) is refused
// outright, as is anything but a directory, a regular file or a symlink: nothing can be split or forged into another record.
// Verification walks KR again, requires exactly the recorded records, and checks each actual link.
//
//   node scripts/lib/kit-links.mjs record <KR>                (prepare: the records on stdout; exit 1 on a refused name)
//   node scripts/lib/kit-links.mjs verify <KR> <links file>   (verify: exit 0 only for the same, contained links)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINKS = 40;
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}/`);

/**
 * Where the symlink at `linkPath` (inside `root`, both physical) leads: `{ path }`, `{ path, dangling: true }`, or
 * `{ error }` (`absolute`, `outside`, `loop`, `unresolvable`, `not-a-directory` or an errno code).
 */
export function resolveLinkWithin(root, linkPath) {
  let current = path.dirname(linkPath);
  if (!inside(root, current)) return { error: 'outside' };
  const pending = [path.basename(linkPath)];
  let links = 0;
  while (pending.length) {
    const name = pending.shift();
    if (name === '' || name === '.') continue;
    if (name === '..') {
      current = path.dirname(current);
      if (!inside(root, current)) return { error: 'outside' };
      continue;
    }
    const next = `${current}/${name}`;
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (error.code !== 'ENOENT') return { error: error.code ?? 'error' };
      // The kernel cannot go below a missing component: the rest must be plain names, and stays below `current`.
      if (pending.some((part) => part === '..')) return { error: 'unresolvable' };
      return { path: [next, ...pending.filter((part) => part !== '' && part !== '.')].join('/'), dangling: true };
    }
    if (stat.isSymbolicLink()) {
      if (++links > MAX_LINKS) return { error: 'loop' };
      const target = fs.readlinkSync(next);
      if (target.startsWith('/')) return { error: 'absolute' };
      pending.unshift(...target.split('/'));
      continue;
    }
    if (pending.some((part) => part !== '' && part !== '.') && !stat.isDirectory()) return { error: 'not-a-directory' };
    current = next;
  }
  return { path: current };
}

const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * Every symlink under `kr` (physical), as records sorted by path, and what refuses the kit: a name or a target with a control
 * character, an entry that is neither a directory, a regular file nor a symlink. Directories are walked, never followed.
 */
export function enumerateKitLinks(kr) {
  const records = [];
  const problems = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      problems.push(`${JSON.stringify(rel || '.')}: cannot be listed (${error.code ?? 'error'})`);
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (CONTROL.test(entry.name)) { problems.push(`${JSON.stringify(`./${relative}`)}: a name with a control character`); continue; }
      const full = `${dir}/${entry.name}`;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (CONTROL.test(target)) { problems.push(`${JSON.stringify(`./${relative}`)}: a link target with a control character`); continue; }
        records.push({ link: `./${relative}`, target });
      } else if (stat.isDirectory()) {
        walk(full, relative);
      } else if (!stat.isFile()) {
        problems.push(`${JSON.stringify(`./${relative}`)}: neither a directory, a regular file nor a symlink`);
      }
    }
  };
  walk(kr, '');
  records.sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
  return { records, problems };
}

/** The records file's text: one canonical JSON object per line. */
export const recordsText = (records) => records.map(({ link, target }) => `${JSON.stringify({ link, target })}\n`).join('');

/** Checks each actual link of `kr` (records from `enumerateKitLinks`); returns the offending ones (empty when all are contained). */
export function checkKitLinks(kr, records) {
  const k = `${kr}/FinanceTracker`;
  const problems = [];
  let kStat;
  try { kStat = fs.lstatSync(k); } catch { kStat = null; }
  if (!kStat?.isDirectory() || kStat.isSymbolicLink()) return [`${k} is not a directory`];
  for (const { link, target } of records) {
    const shown = JSON.stringify({ link, target });
    if (!link.startsWith('./FinanceTracker/') || link.split('/').some((part) => part === '..' || part === '')) { problems.push(`${shown}: not inside K`); continue; }
    if (target.startsWith('/')) { problems.push(`${shown}: absolute target`); continue; }
    const result = resolveLinkWithin(k, `${kr}/${link.slice(2)}`);
    if (result.error) problems.push(`${shown}: ${result.error}`);
    else if (!inside(k, result.path)) problems.push(`${shown}: resolves outside K`);
  }
  return problems;
}

/**
 * `verify`: the recorded file must be exactly what a fresh walk of `kr` records (each line canonical JSON with only `link` and
 * `target`, the same links in the same order), and every actual link must be contained.
 */
export function verifyKitLinks(kr, recordedText) {
  const { records, problems } = enumerateKitLinks(kr);
  if (problems.length) return problems;
  if (recordedText !== recordsText(records)) return ['the kit\'s symlinks differ from the recorded ones'];
  return checkKitLinks(kr, records);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, kr, list] = process.argv.slice(2);
  const usage = () => {
    process.stderr.write('Usage: kit-links.mjs record <KR (physical)> | verify <KR (physical)> <links file>\n');
    process.exit(64);
  };
  if (!kr?.startsWith('/') || (command === 'record' ? list !== undefined : command !== 'verify' || !list)) usage();
  let problems;
  if (command === 'record') {
    const enumerated = enumerateKitLinks(kr);
    problems = enumerated.problems.length ? enumerated.problems : checkKitLinks(kr, enumerated.records);
    if (!problems.length) process.stdout.write(recordsText(enumerated.records));
  } else {
    problems = verifyKitLinks(kr, fs.readFileSync(list, 'utf8'));
  }
  for (const problem of problems) process.stderr.write(`rollback-kit: ${problem}\n`);
  process.exit(problems.length ? 1 : 0);
}
