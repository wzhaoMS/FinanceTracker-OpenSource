/**
 * Builds one target into dist/<target>/ and refuses to leave an artifact
 * behind unless every check in build/checks.ts passes:
 *
 *   npx tsx build/build.ts --target production
 *   npx tsx build/build.ts --target test
 *   npx tsx build/build.ts --target acceptance   (the macOS suite against E2c only)
 *
 * Each bundle is built on its own from a fixed entry (ESM for the worker and
 * the extension pages, an IIFE for every content script), with exactly one
 * target module aliased as `#target`, no minification (the artifact is meant
 * to be reviewed), no source maps, no remote code. BUILD-INFO.json records
 * the SHA-256 of every file and the toolchain versions.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { TARGET as ACCEPTANCE } from '../src/config/acceptance.js';
import { createProductionTarget } from '../src/config/production.js';
import type { BuildTarget } from '../src/config/targetTypes.js';
import { TARGET as TEST } from '../src/config/test.js';
import { checkBundleInputs, checkBundleText, checkManifest, checkMixing, checkSources, type BundleRole, type Finding } from './checks.js';
import { EXTENSION_VERSION, KEYS, buildManifest } from './manifest.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Entry {
  readonly file: string;
  readonly entry: string;
  readonly role: BundleRole;
  readonly format: 'esm' | 'iife';
}

export function entriesFor(target: BuildTarget): Entry[] {
  const entries: Entry[] = [
    { file: 'worker.js', entry: 'src/entries/worker.ts', role: 'worker', format: 'esm' },
    { file: 'popup.js', entry: 'src/entries/popup.ts', role: 'page-ui', format: 'esm' },
    { file: 'options.js', entry: 'src/entries/options.ts', role: 'page-ui', format: 'esm' },
  ];
  const script = (file: string, role: BundleRole): Entry => ({ file, entry: `src/entries/${basename(file, '.js')}.ts`, role, format: 'iife' });
  for (const adapter of target.adapters) {
    entries.push(script(adapter.scripts.isolated, 'isolated'));
    if (adapter.scripts.main) entries.push(script(adapter.scripts.main, 'main'));
    if (adapter.scripts.shapeMain) entries.push(script(adapter.scripts.shapeMain, 'main'));
  }
  if (target.adapters.some((adapter) => adapter.scripts.shapeMain !== null)) entries.push(script('shape-isolated.js', 'isolated'));
  return entries;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

export async function build(target: BuildTarget, out = join(root, 'dist', target.name)): Promise<{ out: string; findings: Finding[] }> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const findings: Finding[] = [...checkSources(root)];
  const entries = entriesFor(target);
  for (const item of entries) {
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(root, item.entry)],
      outfile: join(out, item.file),
      bundle: true,
      format: item.format,
      platform: 'browser',
      target: ['chrome121'],
      alias: {
        '#target': join(root, 'src', 'config', `${target.name}.ts`),
        '@finance-tracker/shared': resolve(root, '../../packages/shared/src/cardSync/extension.ts'),
      },
      define: target.name === 'production'
        ? { __HOLDR_EXTENSION_ORIGIN__: JSON.stringify(target.holdrOrigin) }
        : undefined,
      metafile: true,
      minify: false,
      sourcemap: false,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'warning',
      treeShaking: true,
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => posix(resolve(root, input)));
    findings.push(...checkBundleInputs(item.file, item.role, inputs, target.name));
    findings.push(...checkBundleText(item.file, item.role, readFileSync(join(out, item.file), 'utf8')));
  }
  copyFileSync(join(root, 'src', 'popup', 'popup.html'), join(out, 'popup.html'));
  copyFileSync(join(root, 'src', 'options', 'options.html'), join(out, 'options.html'));
  copyFileSync(join(root, 'src', 'ui', 'ui.css'), join(out, 'ui.css'));
  const manifest = buildManifest(target);
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  findings.push(...checkManifest(manifest, target));

  const expected = new Set(['manifest.json', 'popup.html', 'options.html', 'ui.css', ...entries.map((item) => item.file)]);
  const hashes: Record<string, string> = {};
  for (const file of files(out).sort()) {
    const rel = posix(relative(out, file));
    if (!expected.has(rel)) findings.push({ rule: 'unexpected file in the artifact', where: rel });
    const bytes = readFileSync(file);
    hashes[rel] = createHash('sha256').update(bytes).digest('hex');
    findings.push(...checkMixing(rel, bytes.toString('utf8'), target.name));
  }
  const info = {
    target: target.name,
    version: EXTENSION_VERSION,
    extensionId: KEYS[target.name].id,
    holdrOrigin: target.holdrOrigin,
    adapters: target.adapters.map((adapter) => adapter.id),
    toolchain: { node: process.version, esbuild: esbuild.version, typescript: ts.version },
    files: hashes,
  };
  writeFileSync(join(out, 'BUILD-INFO.json'), `${JSON.stringify(info, null, 2)}\n`);
  findings.push(...checkMixing('BUILD-INFO.json', JSON.stringify(info), target.name));
  return { out, findings };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args[args.indexOf('--target') + 1];
  if (args.indexOf('--target') === -1 || !['production', 'test', 'acceptance'].includes(name)) {
    process.stderr.write('usage: tsx build/build.ts --target production|test|acceptance\n');
    process.exitCode = 2;
    return;
  }
  let target: BuildTarget;
  try {
    target = name === 'production'
      ? createProductionTarget(process.env.HOLDR_EXTENSION_ORIGIN?.trim())
      : name === 'test' ? TEST : ACCEPTANCE;
  } catch (error) {
    rmSync(join(root, 'dist', name), { recursive: true, force: true });
    process.stderr.write(`production build refused: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { out, findings } = await build(target);
  if (findings.length > 0) {
    rmSync(out, { recursive: true, force: true });
    for (const finding of findings) process.stderr.write(`build check failed: ${finding.rule} (${finding.where})\n`);
    process.stderr.write(`${findings.length} finding(s); no ${target.name} artifact was kept.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`built ${target.name} → ${posix(relative(root, out))} (extension id ${KEYS[target.name].id})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
