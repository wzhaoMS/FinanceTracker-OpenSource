import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { LIFECYCLE_LOCK, lockPath, probeExclusive, readMarker } from '../control/lifecycle.js';
import { blockFence } from '../control/recovery.js';
import { fenceState, newGeneration, readFence, writeFence } from '../control/syncAuthState.js';
import { FAKE_MACHINE, captureIo, controlEnvFixture, exited, fakeSystem, lockHolder } from '../control/testControl.js';
import {
  cardSyncActorRef, deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters,
} from '../services/cardSyncDigests.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runHoldrRecovery } from './holdrRecovery.js';

/**
 * `holdr-recovery reset-authorization` (E0-I §9.6; E1b §5.8, §10 items 2 and 6): PR B's recovery entry, the invalidation in
 * this listener-less process, the check that no authority is left, and the compare-and-swap completion. Synthetic data.
 */

const OWNER = cardSyncActorRef('local-user-owner');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function recovery(env: NodeJS.ProcessEnv, argv: string[]) {
  const capture = captureIo();
  const code = await runHoldrRecovery(argv, { env, io: capture.io, run: fakeSystem });
  return { code, out: capture.out(), err: capture.err() };
}

/** A control dir for the fake machine and a v15 database with live authority: an issuer on, a binding, browsers, an invitation. */
async function world(options: { gate?: 'open' | 'init' } = {}) {
  const fixture = await controlEnvFixture({ machine: FAKE_MACHINE, run: fakeSystem });
  cleanups.push(fixture.cleanup);
  const file = path.join(fixture.dataDir, 'finance.db');
  const repo = new SqliteStateRepo({ file });
  try {
    const step = () => ({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
    repo.enableCardSyncIssuer({ issuer: 'chase', expectedVersion: 1, contractVersion: 1, riskAcknowledged: true, mainWorldAcknowledged: false,
      actorRef: OWNER, ...step() });
    const account = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '3391', currency: 'USD' }).id;
    const binding = repo.createCardSourceBinding({ cardAccountId: account, source: 'chase-api', label: 'Card activity', actorRef: OWNER,
      scopes: [{ label: 'Alex card', holderAlias: 'alex', last4: '1111' }], ...step() }).value.bindingId;
    const browser = (approve: boolean) => {
      const code = randomCardSyncLetters();
      const pairingId = repo.createCardSyncPairing({ actorRef: OWNER, codeDigest: pairingCodeDigest(code), bindingIds: [binding],
        replacesDeviceId: null, ...step() }).value.pairingId;
      const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
      const deviceId = `dev_${randomCardSyncLetters()}`;
      repo.redeemCardSyncPairing({ codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token),
        fingerprint: deviceFingerprint(token), label: 'Laptop Chrome', clientVersion: '1.0.0', ...step() });
      if (approve) repo.approveCardSyncPairing({ pairingId, deviceId, fingerprint: deviceFingerprint(token), actorRef: OWNER, ...step() });
      return deviceId;
    };
    browser(true);
    browser(false);
    repo.createCardSyncPairing({ actorRef: OWNER, codeDigest: pairingCodeDigest(randomCardSyncLetters()), bindingIds: [binding],
      replacesDeviceId: null, ...step() });
    if (options.gate !== 'init') {
      writeFence(fixture.controlDir, fenceState({ gate: 'open', reason: null, generation: repo.getCardSyncAuthorizationGeneration(), next: null,
        op: null, machine: FAKE_MACHINE }));
    }
  } finally {
    repo.close();
  }
  // As the API leaves them (K18): the database and its journals private to their owner.
  for (const name of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(name)) fs.chmodSync(name, 0o600);
  const read = <T>(fn: (repo: SqliteStateRepo) => T): T => {
    const opened = new SqliteStateRepo({ file });
    try {
      return fn(opened);
    } finally {
      opened.close();
    }
  };
  return { ...fixture, file, read };
}

describe.skipIf(process.platform !== 'darwin')('holdr-recovery reset-authorization', { timeout: 60_000 }, () => {
  it('rejects a staging managed root before recovery changes any fence, marker or database (B r4)', async () => {
    const t = await world();
    const stage = path.join(t.env.HOME!, 'staging');
    fs.mkdirSync(path.join(stage, 'FinanceTracker'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stage, 'holdr.conf'), '# synthetic staging fixture\n', { mode: 0o600 });
    const fence = fs.readFileSync(path.join(t.controlDir, 'sync-auth-state'));
    const marker = fs.readFileSync(path.join(t.controlDir, 'lifecycle-state'));
    const before = t.read((repo) => repo.getCardSyncRemainingAuthority());
    const result = await recovery({ ...t.env, HOLDR_ROOT: stage }, ['reset-authorization', '--timeout', '1']);
    expect(result.code).toBe(64);
    expect(result.err).toContain('E0I_NOT_LIVE');
    expect(fs.readFileSync(path.join(t.controlDir, 'sync-auth-state'))).toEqual(fence);
    expect(fs.readFileSync(path.join(t.controlDir, 'lifecycle-state'))).toEqual(marker);
    expect(t.read((repo) => repo.getCardSyncRemainingAuthority())).toEqual(before);
  });

  it.each(['open', 'init'] as const)('from a %s gate: everything invalidated in one transaction, verified, the gate open at the new generation', async (gate) => {
    const t = await world({ gate });
    expect(t.read((repo) => repo.getCardSyncRemainingAuthority())).toMatchObject({ resolvingDevices: 2, paused: false, enabledIssuers: 1 });
    const result = await recovery(t.env, ['reset-authorization', '--timeout', '5']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('device gate: blocked (recovery); lifecycle: maintenance (recovery)\n');
    expect(result.out).toContain('revoked 2 browser(s)');
    expect(result.out).toContain('reset-authorization complete: device gate open at a fresh generation; lifecycle normal\n');
    const left = t.read((repo) => repo.getCardSyncRemainingAuthority());
    expect(left).toMatchObject({ resolvingDevices: 0, activeGrants: 0, preparedPlans: 0, openRuns: 0, openPairings: 0, paused: true,
      enabledIssuers: 0 });
    expect(readFence(t.controlDir, FAKE_MACHINE)).toMatchObject({ gate: 'open', state: { generation: left.generation } });
    expect(t.read((repo) => repo.listCardSyncDevices().map((device) => [device.status, device.revokeReason])))
      .toEqual([['revoked', 'recovery'], ['revoked', 'recovery']]);
    expect(t.read((repo) => repo.listCardSourceBindings().map((binding) => [binding.status, binding.statusReason])))
      .toEqual([['needs-reconfirmation', 'restored-from-backup']]);
    expect(readMarker(t.controlDir)).toMatchObject({ state: 'normal' });
    expect(probeExclusive(t.controlDir)).toBe('free');
  });

  it('an operator block during the recovery wins: the database part completes, the gate stays blocked, exit 5', async () => {
    const t = await world();
    // A lease holder the drain waits for, so the operator's block lands between the entry and the completion.
    const holder = await lockHolder(lockPath(t.controlDir, LIFECYCLE_LOCK), 'shared', cleanups, 1_500);
    const running = recovery(t.env, ['reset-authorization', '--timeout', '10']);
    const reason = () => (readFence(t.controlDir, FAKE_MACHINE) as { reason?: string }).reason;
    for (let i = 0; i < 100 && reason() !== 'blocked:recovery'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await blockFence(t.controlDir, FAKE_MACHINE)).toBe('blocked');
    await exited(holder);
    const result = await running;
    expect(result.code, result.err).toBe(5);
    expect(result.out).toContain('an operator block arrived meanwhile: the device gate stays blocked');
    expect(readFence(t.controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:incident' });
    expect(t.read((repo) => repo.getCardSyncRemainingAuthority())).toMatchObject({ resolvingDevices: 0, paused: true });
    expect(readMarker(t.controlDir)).toMatchObject({ state: 'normal' });
  });

  it('a rerun finishes an interrupted recovery with its own generation, without invalidating twice', async () => {
    const t = await world();
    const N = newGeneration();
    const G = t.read((repo) => repo.getCardSyncAuthorizationGeneration());
    // Interrupted after the database part: the fence still says recovery to N, and the database holds N.
    writeFence(t.controlDir, fenceState({ gate: 'blocked', reason: 'recovery', generation: G, next: N, op: '0123456789abcdef', machine: FAKE_MACHINE }));
    t.read((repo) => repo.invalidateAllCardSyncAuthorization({ nextGeneration: N }));
    const result = await recovery(t.env, ['reset-authorization', '--timeout', '5']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('nothing invalidated twice');
    expect(readFence(t.controlDir, FAKE_MACHINE)).toMatchObject({ gate: 'open', state: { generation: N } });
  });

  it('refuses an incomplete control dir, a missing database, and a lease environment, before anything changes', async () => {
    const t = await world();
    const fence = fs.readFileSync(path.join(t.controlDir, 'sync-auth-state'), 'utf8');
    const inLease = await recovery({ ...t.env, HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }, ['reset-authorization']);
    expect([inLease.code, inLease.err.includes('E0I_RECOVERY_IN_LEASE')]).toEqual([1, true]);
    fs.renameSync(t.file, `${t.file}.away`);
    const missing = await recovery(t.env, ['reset-authorization']);
    expect([missing.code, missing.err.includes('E0I_DB_MISSING')]).toEqual([1, true]);
    fs.renameSync(`${t.file}.away`, t.file);
    fs.rmSync(path.join(t.controlDir, 'recovery.lock'));
    const partial = await recovery(t.env, ['reset-authorization']);
    expect([partial.code, partial.err.includes('run holdr-recovery reinit first')]).toEqual([1, true]);
    expect(fs.readFileSync(path.join(t.controlDir, 'sync-auth-state'), 'utf8')).toBe(fence);
    expect(readMarker(t.controlDir)).toMatchObject({ state: 'normal' });
  });
});

describe('only the recovery CLI invalidates authorization (E1b §10 item 6)', () => {
  it('calls invalidateAllCardSyncAuthorization from cli/resetAuthorization.ts alone, outside the repository and tests', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$|\.integration\.ts$/.test(entry.name)
          && /\binvalidateAllCardSyncAuthorization\(/.test(fs.readFileSync(file, 'utf8'))) {
          callers.push(path.relative(src, file).split(path.sep).join('/'));
        }
      }
    };
    walk(src);
    expect(callers.sort()).toEqual(['cli/resetAuthorization.ts', 'services/cardSync/recovery.ts', 'services/sqliteStateRepo.ts']);
  });
});
