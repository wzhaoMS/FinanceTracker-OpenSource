import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runAttestOnce, type AttestOnceDeps } from './attestCommand.js';
import { SUPPORTED_TAILSCALE, type AttestationResult } from '../ingress/attestation.js';
import { canonicalServeJson } from '../ingress/serveConfig.js';
import { fakeTailscale } from '../ingress/cliFixtures.js';
import { socketFixture } from '../ingress/fixtures.js';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = (kind: AttestationResult['kind'], codes: string[] = []): AttestationResult => ({
  kind, codes, exposureChecked: kind !== 'error',
});
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe('standalone attest command policy', () => {
  it.each([
    [result('ok'), 0, 'ingress-verified'],
    [result('pending', ['serve-not-installed']), 3, 'ingress-unverified'],
    [result('refused', ['tcp-forward']), 4, 'ingress-refused'],
    [result('error', ['serve-command-failed']), 3, 'ingress-unverified'],
    [undefined, 3, 'ingress-unverified'],
    [{ kind: 'unknown', config: 'PRIVATE_CONFIG_CANARY' }, 3, 'ingress-unverified'],
    [{ kind: 'ok', codes: ['PRIVATE_CONFIG_CANARY'], exposureChecked: true }, 3, 'ingress-unverified'],
    [{ get kind() { throw Error('PRIVATE_CONFIG_CANARY'); } }, 3, 'ingress-unverified'],
  ] as const)('maps result %# only through the validated state', async (observation, exitCode, code) => {
    const outcome = await runAttestOnce({ now: () => 0n, observe: async () => observation }, {});
    expect(outcome.exitCode).toBe(exitCode);
    expect(outcome.codes).toContain(code);
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_CONFIG_CANARY');
  });
  it('passes the supplied effective environment unchanged rather than reading configuration globals', async () => {
    const env = { HOLDR_PUBLIC_ORIGIN: 'https://effective.test' };
    const deps: AttestOnceDeps = {
      now: () => 0n,
      observe: async (received) => { expect(received).toBe(env); return result('ok'); },
    };
    expect((await runAttestOnce(deps, env)).exitCode).toBe(0);
  });
  it.each(['failure', 'timeout'])('%s exits 3 without printing the exception or configuration', async (kind) => {
    const outcome = await runAttestOnce({
      now: () => 0n,
      observe: async () => { throw Object.assign(Error('PRIVATE_CONFIG_CANARY'), { code: kind === 'timeout' ? 'ETIMEDOUT' : 'EIO' }); },
    }, {});
    expect(outcome).toEqual({ exitCode: 3, codes: ['ingress-unverified'] });
  });
  it.each(['ok', 'pending', 'refused'] as const)('overlong %s obeys the same continuous-clock policy', async (kind) => {
    let now = 0n;
    const outcome = await runAttestOnce({
      now: () => now,
      observe: async () => {
        now = 16_001_000_000n;
        return result(kind, kind === 'refused' ? ['path-handler'] : kind === 'pending' ? ['serve-not-installed'] : []);
      },
    }, {});
    expect(outcome.exitCode).toBe(kind === 'refused' ? 4 : 3);
  });
  it('a clock failure or expiry before the final decision never returns verified', async () => {
    expect((await runAttestOnce({ now: () => { throw Error('clock'); }, observe: async () => result('ok') }, {})).exitCode).toBe(3);
    let call = 0;
    expect((await runAttestOnce({
      now: () => ++call < 3 ? 0n : 46_000_000_000n, observe: async () => result('ok'),
    }, {})).exitCode).toBe(3);
  });
});

function fixture() {
  const root = socketFixture();
  cleanups.push(root.cleanup);
  const observer = path.join(root.dir, 'observer.cjs');
  const violations = path.join(root.dir, 'side-effects');
  fs.writeFileSync(observer, `
const fs = require('node:fs');
function forbidden(code) {
  fs.appendFileSync(${JSON.stringify(violations)}, code + '\\n', { mode: 0o600 });
  throw Error(code);
}
const net = require('node:net');
net.Server.prototype.listen = function() { forbidden('ATTEST_LISTENER_FORBIDDEN'); };
const Module = require('node:module');
const original = Module._load;
Module._load = function(name, ...args) {
  const loaded = original.call(this, name, ...args);
  if (name !== 'better-sqlite3') return loaded;
  return new Proxy(loaded, {
    construct() { forbidden('ATTEST_DATABASE_FORBIDDEN'); },
    apply() { forbidden('ATTEST_DATABASE_FORBIDDEN'); }
  });
};
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HOLDR_')));
  const invoke = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const run = spawnSync(process.execPath, [
      '--import', 'tsx', '--require', observer, path.join(api, 'src/cli/ingressMain.ts'), ...args,
    ], { cwd: api, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20_000 });
    expect(fs.existsSync(violations), 'a caught exception must not hide a DB/listen attempt').toBe(false);
    return run;
  };
  return { ...root, observer, violations, invoke };
}

describe('real executable binding', () => {
  it('the observer detects a real listener or SQLite constructor attempt', () => {
    const f = fixture();
    for (const [code, marker] of [
      ["require('node:net').createServer().listen(0, '127.0.0.1')", 'ATTEST_LISTENER_FORBIDDEN'],
      ["new (require('better-sqlite3'))(':memory:')", 'ATTEST_DATABASE_FORBIDDEN'],
    ]) {
      const run = spawnSync(process.execPath, ['--require', f.observer, '-e', code], { cwd: api, encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(marker);
    }
    expect(fs.readFileSync(f.violations, 'utf8')).toBe('ATTEST_LISTENER_FORBIDDEN\nATTEST_DATABASE_FORBIDDEN\n');
  });
  it('attest --once with unknown configuration is unverified, with no DB, listener or state-file write', () => {
    const f = fixture();
    const run = f.invoke(['attest', '--once']);
    expect(run.status, run.stderr).toBe(3);
    expect(run.stdout).toContain('ingress-unverified');
    expect(run.stderr).toBe('');
    expect(fs.readdirSync(f.dir)).toEqual(['observer.cjs']);
  });
  it.each([['attest'], ['attest', '--once', '--provider', 'fake'], ['attest', '--once', '--verified'], ['attest', '--once', 'extra']]
    .map((args) => ({ args })))('usage $args keeps a usage error', ({ args }) => {
    const f = fixture();
    const run = f.invoke(args);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('E0I_ATTEST_USAGE\n');
  });
  it('retains the global lease-environment refusal before dispatch', () => {
    const f = fixture();
    const run = f.invoke(['attest', '--once'], { HOLDR_LIFECYCLE_LEASE_FD: '3' });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('E0I_LEASE_ENV\n');
  });
  it('the fixed real dependencies cannot verify with an empty production version-pin set', () => {
    expect(SUPPORTED_TAILSCALE).toEqual([]);
    const f = fixture();
    const cli = fakeTailscale(f.dir);
    const pin = { majorMinorPatch: '1.98.3', long: 'synthetic-cannot-be-authorized-by-env' };
    cli.set({
      version: JSON.stringify({ ...pin, daemonLong: pin.long }),
      status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'holdr.test.' }, CertDomains: ['holdr.test'] }),
      serve: canonicalServeJson('dist', { host: 'holdr.test', socketPath: f.socketPath }),
    });
    const run = f.invoke(['attest', '--once'], {
      HOLDR_PUBLIC_ORIGIN: 'https://holdr.test', HOLDR_SERVE_SOCKET: f.socketPath,
      HOLDR_TAILSCALE_CLI: cli.cli, HOLDR_NATIVE_COMMIT: 'a'.repeat(40), HOLDR_NATIVE_MANIFEST: 'b'.repeat(64),
      HOLDR_FORCE_VERIFIED: '1', HOLDR_ATTEST_PROVIDER: 'fake', HOLDR_SUPPORTED_TAILSCALE: JSON.stringify([pin]),
    });
    expect([3, 4], run.stderr).toContain(run.status);
    expect(run.stdout).not.toContain('ingress-verified');
    expect(run.stderr).toBe('');
    if (process.platform === 'darwin') expect(run.stdout).toContain('tailscale-version-unsupported');
    expect(run.stdout).not.toContain(pin.long);
    expect(fs.existsSync(path.join(f.dir, 'ingress-state.json'))).toBe(false);
  });
});
