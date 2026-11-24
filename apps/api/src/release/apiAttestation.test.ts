import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  computeReleaseAttestation,
  describeReleaseAttestation,
  liveRoot,
  processAttestationInput,
  type ReleaseAttestation,
} from './apiAttestation.js';
import { SYNTHETIC_STARTED as STARTED, syntheticAttestationInput, syntheticTree } from './attestation.testSupport.js';
import {
  ATTESTATION_FORMAT,
  CODE_IDENTITY_ALGORITHM,
  MAX_ATTESTATION_BYTES,
  computeCodeIdentity,
  parseApiAttestation,
  sha256File,
} from './codeIdentity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYS = ['format', 'version', 'pid', 'startedAt', 'runtime', 'entry', 'preloads', 'flags', 'nodeOptions', 'code'];
const input = syntheticAttestationInput;

function ready(state: ReleaseAttestation) {
  if (state.status !== 'ready') throw new Error(`unavailable: ${state.code}`);
  return state;
}

describe('the release attestation computed at startup', () => {
  it('is exactly what the gate parses: the code identity of the same tree and this process, nothing else', async () => {
    const tree = await syntheticTree();
    let calls = 0;
    const state = ready(computeReleaseAttestation(() => { calls += 1; return input(tree); }));
    expect(calls).toBe(1);
    expect(Object.keys(JSON.parse(state.body))).toEqual(KEYS);
    expect(JSON.parse(state.body)).toEqual({
      format: ATTESTATION_FORMAT, version: 1, pid: 4242, startedAt: STARTED,
      runtime: { execPath: tree.node, version: 'v22.23.2', sha256: sha256File(tree.node) },
      entry: path.join(tree.dir, 'apps', 'api', 'src', 'index.ts'),
      preloads: [tree.preflight, tree.loader], flags: [], nodeOptions: false,
      code: { algorithm: CODE_IDENTITY_ALGORITHM, digest: computeCodeIdentity(tree.dir).digest },
    });
    expect(state.body).toBe(JSON.stringify(state.attestation));
    expect(parseApiAttestation(JSON.parse(state.body))).toEqual(state.attestation);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.attestation)).toBe(true);
    expect(Object.isFrozen(state.attestation.runtime)).toBe(true);
    expect(state.ms).toBeGreaterThanOrEqual(0);
    expect(describeReleaseAttestation(state)).toBe(`[holdr-api] release attestation ready (${state.ms} ms)`);
  });

  it('records other Node flags verbatim and whether NODE_OPTIONS was set, never its value', async () => {
    const tree = await syntheticTree();
    const state = ready(computeReleaseAttestation(() => input(tree, {
      execArgv: ['--no-warnings', '--require', tree.preflight, '--import', pathToFileURL(tree.loader).href],
      env: { NODE_OPTIONS: '--max-old-space-size=4096 --secret-looking-value' },
    })));
    expect(state.attestation.flags).toEqual(['--no-warnings']);
    expect(state.attestation.preloads).toEqual([tree.preflight, tree.loader]);
    expect(state.attestation.nodeOptions).toBe(true);
    expect(state.body).not.toContain('max-old-space-size');
  });

  it('changes its digest at the next start when a source file changed, and only then', async () => {
    const tree = await syntheticTree();
    const first = ready(computeReleaseAttestation(() => input(tree)));
    expect(ready(computeReleaseAttestation(() => input(tree))).body).toBe(first.body);
    const digests = new Set([first.attestation.code.digest]);
    for (const [relative, text] of [
      ['apps/api/src/routes/health.ts', 'export const health = 2;\n'],
      ['apps/api/src/routes/new.ts', 'export const added = 1;\n'],
      ['packages/shared/src/index.ts', 'export const shared = 2;\n'],
      ['package-lock.json', '{"lockfileVersion":3,"packages":{"x":{}}}\n'],
      ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'another native addon\n'],
    ]) {
      tree.write(relative, text);
      const next = ready(computeReleaseAttestation(() => input(tree)));
      expect(next.attestation.code.digest, relative).toBe(computeCodeIdentity(tree.dir).digest);
      expect(digests.has(next.attestation.code.digest), relative).toBe(false);
      digests.add(next.attestation.code.digest);
    }
    // Outside the code-identity inputs: the same digest.
    const before = ready(computeReleaseAttestation(() => input(tree))).attestation.code.digest;
    tree.write('docs/notes.md', 'not code\n');
    tree.write('tools/example/x.mjs', 'export {};\n');
    expect(ready(computeReleaseAttestation(() => input(tree))).attestation.code.digest).toBe(before);
  });

  it('never throws: what it cannot attest is unavailable, with a value-free code and no path', async () => {
    const tree = await syntheticTree();
    const unavailable = (state: ReleaseAttestation, code: string) => {
      expect(state.status).toBe('unavailable');
      expect(state).toEqual({ status: 'unavailable', code, ms: state.ms });
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.values(state).join(' ')).not.toContain(tree.dir);
      expect(describeReleaseAttestation(state))
        .toBe(`[holdr-api] release attestation unavailable (${code}); GET /release/attestation answers 503`);
    };
    unavailable(computeReleaseAttestation(() => input(tree, { liveRoot: tree.dir + path.sep })), 'code-identity-root');
    fs.symlinkSync(tree.dir, path.join(tree.dir, 'alias'), 'junction');
    unavailable(computeReleaseAttestation(() => input(tree, { liveRoot: path.join(tree.dir, 'alias') })), 'code-identity-root');
    fs.unlinkSync(path.join(tree.dir, 'alias'));
    unavailable(computeReleaseAttestation(() => input(tree, { liveRoot: 'relative' })), 'code-identity-root');
    unavailable(computeReleaseAttestation(() => input(tree, { execPath: path.join(tree.dir, 'runtime', 'missing') })), 'attestation-failed');
    unavailable(computeReleaseAttestation(() => input(tree, { entry: undefined })), 'attestation-failed');
    unavailable(computeReleaseAttestation(() => input(tree, { entry: 'src/missing.ts' })), 'attestation-failed');
    unavailable(computeReleaseAttestation(() => input(tree, { version: 'v22' })), 'api-attestation-invalid');
    unavailable(computeReleaseAttestation(() => { throw new Error(`no input at ${tree.dir}`); }), 'attestation-failed');
    // The gate refuses a body over MAX_ATTESTATION_BYTES, so the API never serves one.
    const flags = Array.from({ length: 64 }, (_, index) => `--x${index}=${'v'.repeat(1100)}`);
    expect(flags.join('').length).toBeGreaterThan(MAX_ATTESTATION_BYTES);
    unavailable(computeReleaseAttestation(() => input(tree, { execArgv: [...input(tree).execArgv, ...flags] })), 'attestation-too-large');
    // A link in a tree, then a missing tree.
    fs.symlinkSync(path.join(tree.dir, 'packages', 'shared', 'src'), path.join(tree.dir, 'apps', 'api', 'src', 'linked'), 'junction');
    unavailable(computeReleaseAttestation(() => input(tree)), 'code-identity-link');
    fs.unlinkSync(path.join(tree.dir, 'apps', 'api', 'src', 'linked'));
    fs.rmSync(path.join(tree.dir, 'packages', 'shared', 'src'), { recursive: true });
    unavailable(computeReleaseAttestation(() => input(tree)), 'code-identity-missing');
  });

  it('keeps any other failure to a fixed code: an injected error, thrown once by the input, never escapes', () => {
    // Its code passes the value-free pattern, so only the CodeIdentityError check keeps it out of the state.
    class InjectedFailure extends Error {
      override name = 'InjectedFailure';
      readonly code = 'injected-failure';
    }
    const injected = new InjectedFailure('injected attestation failure');
    let calls = 0;
    let escaped: unknown;
    let state: ReleaseAttestation | undefined;
    try {
      state = computeReleaseAttestation(() => {
        calls += 1;
        throw injected;
      });
    } catch (error) {
      // Only the injected error is kept for the assertions below; anything else fails the test unchanged.
      if (error !== injected) throw error;
      escaped = error;
    }
    expect(calls).toBe(1);
    expect(escaped).toBeUndefined();
    expect(state).toEqual({ status: 'unavailable', code: 'attestation-failed', ms: state?.ms });
  });

  it('describes this process: its pid and start, its Node, its arguments and environment, over the repository root', () => {
    const own = processAttestationInput();
    expect(own).toEqual({
      pid: process.pid, startedAt: performance.timeOrigin, execPath: process.execPath, version: process.version,
      execArgv: process.execArgv, cwd: process.cwd(), entry: process.argv[1], env: process.env, liveRoot: liveRoot(),
    });
    expect(own.env).toBe(process.env);
  });

  it('pins the tree to T, the directory that holds apps/ and packages/, as it resolves', () => {
    const root = liveRoot();
    expect(root).toBe(fs.realpathSync.native(path.resolve(here, '..', '..', '..', '..')));
    expect(fs.realpathSync.native(root)).toBe(root);
    expect(fs.statSync(path.join(root, 'apps', 'api', 'src', 'release', 'apiAttestation.ts')).isFile()).toBe(true);
    expect(fs.statSync(path.join(root, 'packages', 'shared', 'src')).isDirectory()).toBe(true);
  });

  it('declares every export of codeIdentity.mjs in codeIdentity.d.mts', async () => {
    const runtime = Object.keys(await import('./codeIdentity.mjs')).sort();
    const declarations = fs.readFileSync(path.join(here, 'codeIdentity.d.mts'), 'utf8');
    const declared = [...declarations.matchAll(/^export declare (?:const|function|class) (\w+)/gm)].map((match) => match[1]).sort();
    expect(declared).toEqual(runtime);
  });
});
