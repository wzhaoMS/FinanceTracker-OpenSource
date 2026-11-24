import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalManifest } from '@finance-tracker/shared/web-release';
import { sha256 } from '@finance-tracker/shared/web-release/files';
import { prepareIngress } from './startupChecks.js';
import { resolveIngressConfig } from './config.js';
import { releaseFixture, socketFixture, TEST_PORT } from './fixtures.js';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
// Release-mode startup is macOS and Linux only. On Windows the release directory is refused on mode bits (Node reports
// every directory as 0o666, whatever its NTFS ACL), dist mode listens on a Unix-domain socket, and the
// E0I_RELEASE_SYMLINK case makes a symlink, which Windows allows only with a privilege or Developer Mode.
const posixOnly = it.skipIf(process.platform === 'win32');

function fixture() {
  const release = releaseFixture();
  const socket = socketFixture();
  cleanups.push(release.cleanup, socket.cleanup);
  const data = path.join(socket.dir, 'never-opened-data');
  const env: NodeJS.ProcessEnv = {
    HOLDR_WEB_MODE: 'dist', NODE_ENV: 'production', PORT: String(TEST_PORT), HOLDR_PUBLIC_ORIGIN: 'https://holdr.test',
    HOLDR_SERVE_SOCKET: socket.socketPath, HOLDR_WEB_RELEASE_DIR: release.dir, HOLDR_WEB_RELEASE_DIGEST: release.digest,
    HOLDR_DATA_DIR: data, HOLDR_CONTROL_DIR: path.join(socket.dir, 'never-opened-control'), SNAPSHOTS_ENABLED: '0',
  };
  return { release, socket, env, data };
}

async function boot(env: NodeJS.ProcessEnv) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('HOLDR_') && !['NODE_ENV', 'WEB_ORIGIN', 'PORT', 'SNAPSHOTS_ENABLED'].includes(key)));
  // A private HOME: the API reads holdr.conf from its default path under HOME when present (PR B, design §8.1).
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(api, 'src/index.ts')], {
    cwd: api, env: { ...clean, HOME: path.join(api, '.test-tmp'), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, stderr, stdout };
  } finally { clearTimeout(timer); }
}

async function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(TEST_PORT, '127.0.0.1');
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
  });
}

describe('release/startup checks before database open or listen', () => {
  it('does not load a release in default dev mode', async () => {
    expect(await prepareIngress(resolveIngressConfig({ PORT: String(TEST_PORT) }))).toEqual({
      web: { mode: 'dev' }, listeners: [{ mode: 'dev', listener: 'local', host: '127.0.0.1', port: TEST_PORT }],
    });
  });
  posixOnly('requires B integration even with a valid verified release', async () => {
    const f = fixture();
    await expect(prepareIngress(resolveIngressConfig(f.env))).rejects.toThrow('E0I_RUNTIME_UNAVAILABLE');
    expect(fs.existsSync(f.data)).toBe(false);
    expect(fs.existsSync(f.socket.socketPath)).toBe(false);
  });

  const failures: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['E0I_NODE_ENV', (f) => { f.env.NODE_ENV = 'development'; }],
    ['E0I_PUBLIC_ORIGIN', (f) => { f.env.HOLDR_PUBLIC_ORIGIN = 'http://holdr.test'; }],
    ['E0I_LAN_REMOVED', (f) => { f.env.HOLDR_LAN_HTTP = '1'; }],
    ['E0I_BIND', (f) => { f.env.HOLDR_HOST = '0.0.0.0'; }],
    ['E0I_RELEASE_CONFIG', (f) => { delete f.env.HOLDR_WEB_RELEASE_DIGEST; }],
    ['E0I_RELEASE_PATH', (f) => { f.env.HOLDR_WEB_RELEASE_DIR = path.join(f.socket.dir, 'missing-release'); }],
    ['E0I_MANIFEST_MISSING', (f) => { fs.unlinkSync(path.join(f.release.dir, 'manifest.json')); }],
    ['E0I_MANIFEST_INVALID', (f) => { fs.appendFileSync(path.join(f.release.dir, 'manifest.json'), ' '); }],
    ['E0I_MANIFEST_DIGEST', (f) => { f.env.HOLDR_WEB_RELEASE_DIGEST = '0'.repeat(64); }],
    ['E0I_RELEASE_SYMLINK', (f) => {
      fs.unlinkSync(path.join(f.release.dir, 'public/assets/app-123.js'));
      fs.symlinkSync('../index.html', path.join(f.release.dir, 'public/assets/app-123.js'));
    }],
    ['E0I_RELEASE_EXTRA', (f) => { fs.writeFileSync(path.join(f.release.dir, 'public/finance.db'), 'canary'); }],
    ['E0I_RELEASE_HASH', (f) => { fs.writeFileSync(path.join(f.release.dir, 'public/assets/app-123.js'), 'different'); }],
    ['E0I_RELEASE_HTML', (f) => {
      const body = Buffer.from('<!doctype html><html><head><script>bad()</script></head><body></body></html>');
      fs.writeFileSync(path.join(f.release.dir, 'public/index.html'), body);
      const bytes = canonicalManifest({ ...f.release.manifest, files: f.release.manifest.files.map((file) =>
        file.path === 'index.html' ? { ...file, size: body.length, sha256: sha256(body) } : file) });
      fs.writeFileSync(path.join(f.release.dir, 'manifest.json'), bytes);
      f.env.HOLDR_WEB_RELEASE_DIGEST = sha256(bytes);
    }],
    ['E0I_SOCKET_PATH', (f) => { f.env.HOLDR_SERVE_SOCKET = 'relative'; }],
    // PR B supplies the runtime integration: with a valid release, this fixture's first failing gate is K20
    // (no control dir; `holdr-recovery init` creates it), still before any DB open, listener or socket.
    ['E0I_CONTROL_DIR', () => undefined],
    ['E0I_CONTROL_DIR', (f) => {
      f.env.HOLDR_WEB_MODE = 'local';
      f.env.HOLDR_INGRESS_PORT = '5315';
      delete f.env.HOLDR_SERVE_SOCKET;
      delete f.env.HOLDR_PUBLIC_ORIGIN;
    }],
  ];
  posixOnly.each(failures)('the real entry point exits 1 with %s, without DB/listener side effects', async (code, change) => {
    const f = fixture();
    change(f);
    expect(await portOpen()).toBe(false);
    const result = await boot(f.env);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(code);
    expect(await portOpen()).toBe(false);
    expect(fs.existsSync(f.data)).toBe(false);
    expect(fs.existsSync(f.socket.socketPath)).toBe(false);
    expect(result.stdout).not.toContain('[migrate]');
  }, 15_000);
});
