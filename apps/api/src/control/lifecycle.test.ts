import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LIFECYCLE_LOCK, MARKER_FILE, acquireExclusiveLease, acquireSharedLease, assertNoLeaseEnv, lockPath, marker, probeExclusive,
  readMarker, releaseLock, serializeMarker, tryLock, tryRecoveryLock, validMarker, withAuthorizationLock, writeMarker,
} from './lifecycle.js';
import { controlFixture } from './testControl.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const lifecycleModule = path.join(here, 'lifecycle.ts');
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => { const f = await controlFixture(); cleanups.push(f.cleanup); return f; };

/** A separate process holding `file` with O_SHLOCK/O_EXLOCK until killed. */
async function holder(file: string, mode: 'shared' | 'exclusive'): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const fd = fs.openSync(${JSON.stringify(file)}, fs.constants.O_RDONLY | ${mode === 'exclusive' ? '0x20' : '0x10'});
    process.stdout.write('held\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', () => reject(new Error('holder exited')));
  });
  return child;
}
const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once('exit', () => resolve());
});

describe('marker format (holdr-lifecycle/2)', () => {
  it('accepts normal and maintenance, rejects everything else', () => {
    expect(validMarker(JSON.parse(serializeMarker(marker({ state: 'normal' }, 'holdr-recovery init'))))).toBe(true);
    expect(validMarker(JSON.parse(serializeMarker(marker({ state: 'maintenance', reason: 'deploy', lease: 'ab'.repeat(8) }, 'holdr-lifecycle exclusive'))))).toBe(true);
    const good = JSON.parse(serializeMarker(marker({ state: 'normal' }, 'x')));
    for (const bad of [
      { ...good, state: 'paused' }, { ...good, reason: 'deploy' }, { ...good, lease: 'ab'.repeat(8) },
      { ...good, state: 'maintenance', reason: null }, { ...good, state: 'maintenance', reason: 'Deploy!' },
      { ...good, state: 'maintenance', reason: 'deploy', lease: 'XYZ' }, { ...good, format: 'holdr-lifecycle/1' },
      { ...good, owner: '' }, { ...good, since: 'yesterday' }, { ...good, extra: 1 },
    ]) expect(validMarker(bad)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('lifecycle locks and leases (real O_SHLOCK/O_EXLOCK, §9.3)', () => {
  it('shared locks coexist; an exclusive lock excludes both kinds; closing the descriptor releases', async () => {
    const { controlDir } = await fixture();
    const file = lockPath(controlDir, LIFECYCLE_LOCK);
    const a = tryLock(file, 'shared');
    const b = tryLock(file, 'shared');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(tryLock(file, 'exclusive')).toBeNull();
    releaseLock(a); releaseLock(b);
    const x = tryLock(file, 'exclusive');
    expect(x).not.toBeNull();
    expect(tryLock(file, 'shared')).toBeNull();
    expect(tryLock(file, 'exclusive')).toBeNull();
    releaseLock(x);
    expect(probeExclusive(controlDir)).toBe('free');
  });

  it('another process holding the lock excludes us until it is SIGKILLed (the kernel releases it)', async () => {
    const { controlDir } = await fixture();
    const file = lockPath(controlDir, LIFECYCLE_LOCK);
    const child = await holder(file, 'shared');
    expect(probeExclusive(controlDir)).toBe('held');
    const shared = tryLock(file, 'shared');
    expect(shared).not.toBeNull();
    releaseLock(shared);
    child.kill('SIGKILL');
    await exited(child);
    expect(probeExclusive(controlDir)).toBe('free');
  });

  it('interoperates with flock(2) from perl (the lockf/flock family the bash side uses)', async () => {
    const { controlDir } = await fixture();
    const file = lockPath(controlDir, LIFECYCLE_LOCK);
    const perl = spawn('/usr/bin/perl', ['-MFcntl=:flock', '-e',
      'open(my $f, "<", $ARGV[0]) or die; flock($f, LOCK_EX) or die; print "held\\n"; $| = 1; sleep 30;', file],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    cleanups.push(() => { perl.kill('SIGKILL'); });
    await new Promise<void>((resolve) => perl.stdout!.once('data', () => resolve()));
    expect(tryLock(file, 'shared')).toBeNull();
    perl.kill('SIGKILL');
    await exited(perl);
    const fd = tryLock(file, 'shared');
    expect(fd).not.toBeNull();
    releaseLock(fd);
  });

  it('K29: shared lease then marker normal; maintenance exit 3, busy exit 75, invalid marker refused', async () => {
    const { controlDir } = await fixture();
    const lease = await acquireSharedLease(controlDir, { timeoutMs: 200 });
    expect(probeExclusive(controlDir)).toBe('held');
    lease.release();
    lease.release();
    expect(probeExclusive(controlDir)).toBe('free');

    writeMarker(controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'holdr-lifecycle enter'));
    await expect(acquireSharedLease(controlDir, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'E0I_MAINTENANCE', exitCode: 3 });
    expect(probeExclusive(controlDir)).toBe('free');

    writeMarker(controlDir, marker({ state: 'normal' }, 'holdr-lifecycle leave'));
    const exclusive = await acquireExclusiveLease(controlDir, 200);
    const started = Date.now();
    await expect(acquireSharedLease(controlDir, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'E0I_LIFECYCLE_BUSY', exitCode: 75 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    exclusive!.release();

    fs.writeFileSync(path.join(controlDir, MARKER_FILE), '{"format":"holdr-lifecycle/2"}\n');
    expect(readMarker(controlDir)).toBeNull();
    await expect(acquireSharedLease(controlDir, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'E0I_LIFECYCLE_STATE' });
    fs.unlinkSync(path.join(controlDir, MARKER_FILE));
    await expect(acquireSharedLease(controlDir, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'E0I_LIFECYCLE_STATE' });
  });

  it('refuses unsafe or missing lock files instead of creating them', async () => {
    const { controlDir } = await fixture();
    const file = lockPath(controlDir, LIFECYCLE_LOCK);
    fs.chmodSync(file, 0o644);
    expect(() => tryLock(file, 'shared')).toThrow('E0I_LIFECYCLE_STATE');
    fs.chmodSync(file, 0o600);
    fs.unlinkSync(file);
    fs.symlinkSync(lockPath(controlDir, 'recovery.lock'), file);
    expect(() => tryLock(file, 'shared')).toThrow('E0I_LIFECYCLE_STATE');
    fs.unlinkSync(file);
    expect(() => tryLock(file, 'shared')).toThrow('E0I_LIFECYCLE_STATE');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('probe --exclusive never waits and changes no file', async () => {
    const { controlDir } = await fixture();
    const before = fs.readdirSync(controlDir).map((name) => [name, fs.statSync(path.join(controlDir, name)).mtimeMs]);
    const lease = await acquireSharedLease(controlDir, { timeoutMs: 200 });
    const started = Date.now();
    expect(probeExclusive(controlDir)).toBe('held');
    expect(Date.now() - started).toBeLessThan(100);
    lease.release();
    expect(fs.readdirSync(controlDir).map((name) => [name, fs.statSync(path.join(controlDir, name)).mtimeMs])).toEqual(before);
  });

  it('recovery entry never waits (E0I_RECOVERY_BUSY, exit 75); authorization.lock serialises fence writers', async () => {
    const { controlDir } = await fixture();
    const recovery = tryRecoveryLock(controlDir);
    expect(() => tryRecoveryLock(controlDir)).toThrow('E0I_RECOVERY_BUSY');
    recovery.release();
    tryRecoveryLock(controlDir).release();

    const order: string[] = [];
    const first = withAuthorizationLock(controlDir, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 150)); order.push('a2'); });
    await new Promise((r) => setTimeout(r, 20));
    const second = withAuthorizationLock(controlDir, () => { order.push('b'); });
    await Promise.all([first, second]);
    expect(order).toEqual(['a1', 'a2', 'b']);
    const held = await holder(lockPath(controlDir, 'authorization.lock'), 'exclusive');
    await expect(withAuthorizationLock(controlDir, () => 1, 150)).rejects.toMatchObject({ code: 'E0I_AUTHORIZATION_BUSY', exitCode: 75 });
    held.kill('SIGKILL');
  });

  it('lease variables are refused outside the lease-accepting roles', () => {
    expect(() => assertNoLeaseEnv({ HOLDR_LIFECYCLE_LEASE_FD: '3' })).toThrow('E0I_LEASE_ENV');
    expect(() => assertNoLeaseEnv({ HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }, 'E0I_RECOVERY_IN_LEASE')).toThrow('E0I_RECOVERY_IN_LEASE');
    expect(() => assertNoLeaseEnv({})).not.toThrow();
  });

  describe('proof of an inherited lease (offline validation and the other lease-accepting roles)', () => {
    const prove = (controlDir: string, env: Record<string, string>, fd?: number) => spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', `
        import { proveInheritedLease } from ${JSON.stringify(lifecycleModule)};
        try { const r = proveInheritedLease(process.env, ${JSON.stringify(controlDir)}); console.log('ok ' + r.fd); }
        catch (e) { console.log(e.code + ' ' + e.exitCode + ' ' + e.detail); }
      `], { encoding: 'utf8', env: { PATH: process.env.PATH!, ...env }, stdio: ['ignore', 'pipe', 'inherit', fd ?? 'ignore'], timeout: 15_000 });
    const nonce = 'cd'.repeat(8);

    it('accepts descriptor + exclusive lease + marker nonce, and nothing less', async () => {
      const { controlDir } = await fixture();
      const exclusive = await acquireExclusiveLease(controlDir, 200);
      cleanups.push(() => exclusive!.release());
      writeMarker(controlDir, marker({ state: 'maintenance', reason: 'deploy', lease: nonce }, 'holdr-lifecycle exclusive'));
      const env = { HOLDR_LIFECYCLE_LEASE_FD: '3', HOLDR_LIFECYCLE_LEASE: nonce };
      expect(prove(controlDir, env, exclusive!.fd).stdout.trim()).toBe('ok 3');
      expect(prove(controlDir, {}, exclusive!.fd).stdout).toMatch(/^E0I_LEASE_REQUIRED 3 no lease/);
      expect(prove(controlDir, env).stdout).toMatch(/^E0I_LEASE_REQUIRED 3 descriptor 3/);
      const other = fs.openSync(lockPath(controlDir, 'recovery.lock'), 'r');
      expect(prove(controlDir, env, other).stdout).toMatch(/^E0I_LEASE_REQUIRED 3 descriptor 3 is not lifecycle.lock/);
      fs.closeSync(other);
      expect(prove(controlDir, { ...env, HOLDR_LIFECYCLE_LEASE: '0'.repeat(16) }, exclusive!.fd).stdout).toMatch(/marker does not name this lease/);
      writeMarker(controlDir, marker({ state: 'normal' }, 'x'));
      expect(prove(controlDir, env, exclusive!.fd).stdout).toMatch(/marker does not name this lease/);
    }, 60_000);

    it('a descriptor on lifecycle.lock without an exclusive lease is not a lease', async () => {
      const { controlDir } = await fixture();
      writeMarker(controlDir, marker({ state: 'maintenance', reason: 'deploy', lease: nonce }, 'x'));
      const plain = fs.openSync(lockPath(controlDir, LIFECYCLE_LOCK), 'r');
      expect(prove(controlDir, { HOLDR_LIFECYCLE_LEASE_FD: '3', HOLDR_LIFECYCLE_LEASE: nonce }, plain).stdout).toMatch(/no exclusive lease is held/);
      fs.closeSync(plain);
    }, 30_000);
  });
});
