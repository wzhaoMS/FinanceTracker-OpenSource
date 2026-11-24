import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeFixture, NATIVE_TEST_COMMIT } from './nativeFixtures.js';
import { NATIVE_DIR, verifyNativeHelper } from './nativeHelper.js';

describe.skipIf(process.platform !== 'darwin')('reviewed-source native artifact pin', () => {
  let fixture: ReturnType<typeof nativeFixture>;
  beforeAll(() => { fixture = nativeFixture(); }, 60_000);
  afterAll(() => fixture?.cleanup());
  it('pins the binary, both source files, report format and source commit', () => {
    const result = verifyNativeHelper(fixture.native);
    expect(result.manifest.sourceCommit).toBe(NATIVE_TEST_COMMIT);
    expect(result.manifest.reportFormat).toBe('holdr-pathcheck/5');
    expect(Object.keys(result.manifest.sources)).toEqual(['holdr-pathcheck.c', 'acl_decode.h']);
    expect(() => verifyNativeHelper({ ...fixture.native, sourceCommit: 'b'.repeat(40) })).toThrow('E0I_NATIVE_HELPER');
    expect(() => verifyNativeHelper({ ...fixture.native, manifestDigest: 'b'.repeat(64) })).toThrow('E0I_NATIVE_HELPER');
  });
  it.each(['binary', 'manifest', 'source', 'header', 'symlink', 'hardlink', 'permissions', 'extra-key'])('refuses a mismatched %s', (kind) => {
    const root = path.join(fixture.root, 'case-' + kind);
    fs.mkdirSync(root, { mode: 0o700 });
    for (const name of ['holdr-pathcheck', 'native-manifest.json']) fs.copyFileSync(path.join(fixture.buildDir, name), path.join(root, name));
    fs.chmodSync(path.join(root, 'holdr-pathcheck'), 0o700);
    for (const name of ['holdr-pathcheck.c', 'acl_decode.h']) fs.copyFileSync(path.join(NATIVE_DIR, name), path.join(root, name));
    const binary = path.join(root, 'holdr-pathcheck');
    const manifest = path.join(root, 'native-manifest.json');
    if (kind === 'binary') fs.appendFileSync(binary, 'x');
    if (kind === 'manifest') fs.appendFileSync(manifest, ' ');
    if (kind === 'source' || kind === 'header') fs.appendFileSync(path.join(root, kind === 'source' ? 'holdr-pathcheck.c' : 'acl_decode.h'), 'x');
    if (kind === 'symlink') { fs.unlinkSync(binary); fs.symlinkSync(fixture.binary, binary); }
    if (kind === 'hardlink') fs.linkSync(binary, binary + '.link');
    if (kind === 'permissions') fs.chmodSync(binary, 0o777);
    if (kind === 'extra-key') {
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      fs.writeFileSync(manifest, JSON.stringify({ ...json, extra: true }, null, 2) + '\n');
    }
    expect(() => verifyNativeHelper({ buildDir: root, sourceDir: root, sourceCommit: NATIVE_TEST_COMMIT })).toThrow('E0I_NATIVE_HELPER');
  });
});
