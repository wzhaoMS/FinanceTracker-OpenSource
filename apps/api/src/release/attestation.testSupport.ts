import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { onTestFinished } from 'vitest';

import type { ApiAttestationInput } from './codeIdentity.mjs';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

export const SYNTHETIC_STARTED = '2026-11-08T12:00:00.000Z';

/**
 * A synthetic T, as it resolves: the code-identity trees and single files, tsx's two preloads and a stand-in Node
 * executable. Removed when the current test finishes, so call it inside a test.
 */
export async function syntheticTree() {
  const dir = fs.realpathSync.native(await makeScratchDir('release-attestation-'));
  onTestFinished(() => removeScratchDir(dir));
  const write = (relative: string, text: string) => {
    const file = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  for (const [relative, text] of Object.entries({
    'package.json': '{"name":"finance-tracker","private":true}\n',
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
    'tsconfig.json': '{"compilerOptions":{}}\n',
    'apps/api/package.json': '{"name":"@finance-tracker/api","type":"module"}\n',
    'apps/api/tsconfig.json': '{"extends":"../../tsconfig.json"}\n',
    'apps/api/src/index.ts': 'export const api = 1;\n',
    'apps/api/src/routes/health.ts': 'export const health = 1;\n',
    'packages/shared/package.json': '{"name":"@finance-tracker/shared"}\n',
    'packages/shared/tsconfig.json': '{"compilerOptions":{}}\n',
    'packages/shared/src/index.ts': 'export const shared = 1;\n',
    'node_modules/.package-lock.json': '{"lockfileVersion":3,"hidden":true}\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'synthetic native addon\n',
  })) write(relative, text);
  return {
    dir,
    write,
    preflight: write('node_modules/tsx/dist/preflight.cjs', 'module.exports = {};\n'),
    loader: write('node_modules/tsx/dist/loader.mjs', 'export {};\n'),
    node: write('runtime/node', 'synthetic node v22.23.2\n'),
  };
}
export type SyntheticTree = Awaited<ReturnType<typeof syntheticTree>>;

/** The API's process over `tree` as production starts it: tsx's CLI child, from apps/api, with no NODE_OPTIONS. */
export function syntheticAttestationInput(tree: SyntheticTree, changes: Partial<ApiAttestationInput> = {}): ApiAttestationInput {
  return {
    pid: 4242, startedAt: Date.parse(SYNTHETIC_STARTED), execPath: tree.node, version: 'v22.23.2',
    execArgv: ['--require', tree.preflight, '--import', pathToFileURL(tree.loader).href],
    cwd: path.join(tree.dir, 'apps', 'api'), entry: 'src/index.ts', env: {}, liveRoot: tree.dir, ...changes,
  };
}
