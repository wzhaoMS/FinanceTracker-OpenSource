import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadOrCreateServiceToken, serviceTokenMatches, SERVICE_TOKEN_FILE_NAME } from './serviceToken.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

let dir: string;
let file: string;

/**
 * macOS and Linux only: tests that chmod the token file (Windows keeps the
 * ACL whatever chmod asks) or create a file symlink (Windows allows those
 * only with a privilege or Developer Mode). On Windows mode bits are neither
 * checked nor "repaired"; see the test that pretends to be Windows below.
 */
const posixOnly = it.skipIf(process.platform === 'win32');

beforeEach(async () => {
  dir = await makeScratchDir('token-');
  file = path.join(dir, 'data', SERVICE_TOKEN_FILE_NAME);
});

afterEach(async () => {
  await removeScratchDir(dir);
});

describe('service token file', () => {
  it('is generated on first start as 32 random bytes in a 0600 file', async () => {
    const first = loadOrCreateServiceToken(file);
    expect(first.created).toBe(true);
    expect(first.repairedMode).toBe(false);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    // Mode bits say nothing on Windows (Node reports 0o666 there).
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(first.token);
  });

  it('is reused on later starts', () => {
    const first = loadOrCreateServiceToken(file);
    const second = loadOrCreateServiceToken(file);
    expect(second).toEqual({ token: first.token, created: false, repairedMode: false });
  });

  posixOnly('keeps an existing token and tightens loose permissions to 0600', async () => {
    const token = 'ab'.repeat(32);
    loadOrCreateServiceToken(file);
    await writeFile(file, `${token}\n`);
    await chmod(file, 0o644);
    const loaded = loadOrCreateServiceToken(file);
    expect(loaded).toEqual({ token, created: false, repairedMode: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("neither checks nor \"repairs\" mode bits on Windows, where they do not reflect the file's ACL", async () => {
    const token = 'ab'.repeat(32);
    loadOrCreateServiceToken(file);
    await writeFile(file, `${token}\n`);
    await chmod(file, 0o644);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      expect(loadOrCreateServiceToken(file)).toEqual({ token, created: false, repairedMode: false });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it('refuses malformed content instead of accepting a weak token', async () => {
    loadOrCreateServiceToken(file);
    await writeFile(file, 'password\n');
    expect(() => loadOrCreateServiceToken(file)).toThrow(/malformed/);
  });

  posixOnly('refuses a symlink', async () => {
    const real = path.join(dir, 'elsewhere');
    await writeFile(real, `${'cd'.repeat(32)}\n`, { mode: 0o600 });
    await symlink(real, path.join(dir, 'link'));
    expect(() => loadOrCreateServiceToken(path.join(dir, 'link'))).toThrow(/regular file/);
  });

  it('leaves no temp files behind', async () => {
    loadOrCreateServiceToken(file);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(path.dirname(file))).toEqual([SERVICE_TOKEN_FILE_NAME]);
  });
});

describe('serviceTokenMatches', () => {
  it('accepts only the exact token', () => {
    const token = 'ef'.repeat(32);
    expect(serviceTokenMatches(token, token)).toBe(true);
    expect(serviceTokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(serviceTokenMatches(token, `${token}0`)).toBe(false);
    expect(serviceTokenMatches(token, token.toUpperCase())).toBe(false);
    expect(serviceTokenMatches(token, '')).toBe(false);
  });
});
