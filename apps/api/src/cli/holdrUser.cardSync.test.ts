import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../auth/password.js';
import { AUTHORIZATION_LOCK, lockPath } from '../control/lifecycle.js';
import { fenceState, newGeneration, readFence, writeFence } from '../control/syncAuthState.js';
import { FAKE_MACHINE, controlEnvFixture, fakeSystem, lockHolder, outsideRepoDir } from '../control/testControl.js';
import { cardSyncActorRef, deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters } from '../services/cardSyncDigests.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import type { Runner } from '../control/runner.js';
import { runHoldrUserCli, type CliStdin } from './holdrUser.js';

/**
 * E1b §10 item 6: `holdr-user passwd` and `remove` revoke every browser of that user not yet revoked, expired ones included,
 * as `password-reset`, each a narrowing change under the host authorization lock (C17), before the password changes and
 * again afterwards. Synthetic users and devices only.
 */

const FAST = { ln: 10, r: 8, p: 1 };
const OLD = 'correct horse battery';
const NEW = 'a different long passphrase';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

interface Seeded {
  file: string;
  alex: { expired: string; active: string; pending: string; revoked: string; pendingPairing: string };
  other: string;
}

/** A database with two users; alex's browsers: one expired (paired 40 days ago), one active, one pending, one revoked. */
async function seed(dataDir: string): Promise<Seeded> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'finance.db');
  const clock = { t: Date.now() - 40 * 86_400_000 };
  const repo = new SqliteStateRepo({ file, now: () => new Date(clock.t) });
  try {
    const users = new LocalAuthRepo(repo);
    const alex = cardSyncActorRef(users.createUser('alex', await hashPassword(OLD, FAST)).id);
    const casey = cardSyncActorRef(users.createUser('casey', await hashPassword(OLD, FAST)).id);
    const step = () => ({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
    repo.enableCardSyncIssuer({ issuer: 'chase', expectedVersion: 1, contractVersion: 1, riskAcknowledged: true, mainWorldAcknowledged: false,
      actorRef: alex, ...step() });
    const account = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '3391', currency: 'USD' }).id;
    const binding = repo.createCardSourceBinding({ cardAccountId: account, source: 'chase-api', label: 'Card activity', actorRef: alex,
      scopes: [{ label: 'Alex card', holderAlias: 'alex', last4: '1111' }], ...step() }).value.bindingId;
    const browser = (actorRef: string, approve: boolean) => {
      const code = randomCardSyncLetters();
      const pairingId = repo.createCardSyncPairing({ actorRef, codeDigest: pairingCodeDigest(code), bindingIds: [binding], replacesDeviceId: null,
        ...step() }).value.pairingId;
      const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
      const deviceId = `dev_${randomCardSyncLetters()}`;
      repo.redeemCardSyncPairing({ codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token),
        fingerprint: deviceFingerprint(token), label: 'Laptop Chrome', clientVersion: '1.0.0', ...step() });
      if (approve) repo.approveCardSyncPairing({ pairingId, deviceId, fingerprint: deviceFingerprint(token), actorRef, ...step() });
      return { deviceId, pairingId };
    };
    const expired = browser(alex, true).deviceId;
    clock.t = Date.now();
    const active = browser(alex, true).deviceId;
    const pending = browser(alex, false);
    const revoked = browser(alex, true).deviceId;
    repo.revokeCardSyncDevice({ deviceId: revoked, reason: 'owner', actor: { kind: 'session', actorRef: alex }, ...step() });
    const other = browser(casey, true).deviceId;
    return { file, alex: { expired, active, pending: pending.deviceId, revoked, pendingPairing: pending.pairingId }, other };
  } finally {
    repo.close();
  }
}

function sink() {
  let text = '';
  return { stream: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }), text: () => text };
}

async function cli(argv: string[], options: { dataDir: string; env?: Record<string, string | undefined>; input?: string; run?: Runner }) {
  const stdin = new PassThrough();
  stdin.end(options.input ?? `${NEW}\n`);
  const stdout = sink();
  const stderr = sink();
  const code = await runHoldrUserCli(argv, {
    io: { stdin: stdin as CliStdin, stdout: stdout.stream, stderr: stderr.stream },
    env: options.env ?? {}, cwd: options.dataDir, defaultDataDir: options.dataDir, scryptParams: FAST, run: options.run,
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

function readBack(file: string) {
  const repo = new SqliteStateRepo({ file });
  try {
    const devices = new Map(repo.listCardSyncDevices().map((device) => [device.deviceId, device]));
    const pairings = new Map(repo.listCardSyncPairings().map((pairing) => [pairing.pairingId, pairing]));
    return { devices, pairings, generation: repo.getCardSyncAuthorizationGeneration(),
      users: new LocalAuthRepo(repo).listUsers(new Date()).map((user) => user.username), hash: new LocalAuthRepo(repo).findUser('alex')?.passwordHash };
  } finally {
    repo.close();
  }
}

describe('holdr-user passwd and remove revoke the user\'s card sync browsers (E1b §10 item 6)', () => {
  it('passwd revokes every one of the user\'s browsers not yet revoked, expired ones included, as password-reset; others are untouched', async () => {
    const outer = outsideRepoDir('reset');
    cleanups.push(outer.cleanup);
    const dataDir = path.join(outer.dir, 'data');
    const seeded = await seed(dataDir);
    const before = readBack(seeded.file).generation;
    const result = await cli(['passwd', 'alex', '--password-stdin'], { dataDir });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('Revoked 3 card sync browser(s) of alex (password reset).');
    expect(result.out + result.err).not.toContain(NEW);
    const after = readBack(seeded.file);
    for (const id of [seeded.alex.expired, seeded.alex.active, seeded.alex.pending]) {
      expect(after.devices.get(id)).toMatchObject({ status: 'revoked', revokeReason: 'password-reset' });
    }
    expect(after.devices.get(seeded.alex.revoked)).toMatchObject({ status: 'revoked', revokeReason: 'owner' });
    expect(after.devices.get(seeded.other)).toMatchObject({ status: 'active', revokeReason: null });
    // A pending browser's invitation closes with it (item 26); every revocation advanced the generation.
    expect(after.pairings.get(seeded.alex.pendingPairing)?.status).toBe('cancelled');
    expect(after.generation).not.toBe(before);
    expect(await verifyPassword(NEW, after.hash!)).toBe(true);
  });

  it('remove revokes the removed user\'s browsers too', async () => {
    const outer = outsideRepoDir('remove');
    cleanups.push(outer.cleanup);
    const dataDir = path.join(outer.dir, 'data');
    const seeded = await seed(dataDir);
    const result = await cli(['remove', 'alex', '--yes'], { dataDir });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('Revoked 3 card sync browser(s) of alex (password reset).');
    const after = readBack(seeded.file);
    expect(after.users).toEqual(['casey']);
    expect(after.devices.get(seeded.alex.active)).toMatchObject({ status: 'revoked', revokeReason: 'password-reset' });
    expect(after.devices.get(seeded.other)?.status).toBe('active');
  });
});

describe.skipIf(process.platform !== 'darwin')('with a control dir: the host authorization lock and the fence (C17)', () => {
  it('moves the fence with every revocation and leaves it open at the database\'s generation', async () => {
    const env = await controlEnvFixture({ machine: FAKE_MACHINE });
    cleanups.push(env.cleanup);
    const seeded = await seed(env.dataDir);
    writeFence(env.controlDir, fenceState({ gate: 'open', reason: null, generation: readBack(seeded.file).generation, next: null, op: null,
      machine: FAKE_MACHINE }));
    const result = await cli(['passwd', 'alex', '--password-stdin'], { dataDir: env.dataDir, env: env.env, run: fakeSystem });
    expect(result.code, result.err).toBe(0);
    const after = readBack(seeded.file);
    expect(after.devices.get(seeded.alex.active)?.revokeReason).toBe('password-reset');
    expect(readFence(env.controlDir, FAKE_MACHINE)).toMatchObject({ gate: 'open', state: { generation: after.generation } });
  });

  it('with the lock held elsewhere: exit 75, the password and every browser unchanged', async () => {
    const env = await controlEnvFixture({ machine: FAKE_MACHINE });
    cleanups.push(env.cleanup);
    const seeded = await seed(env.dataDir);
    const generation = readBack(seeded.file).generation;
    writeFence(env.controlDir, fenceState({ gate: 'open', reason: null, generation, next: null, op: null, machine: FAKE_MACHINE }));
    await lockHolder(lockPath(env.controlDir, AUTHORIZATION_LOCK), 'exclusive', cleanups);
    const result = await cli(['passwd', 'alex', '--password-stdin'], { dataDir: env.dataDir, env: env.env, run: fakeSystem });
    expect(result.code).toBe(75);
    expect(result.err).toContain('E0I_AUTHORIZATION_BUSY');
    const after = readBack(seeded.file);
    expect(after.generation).toBe(generation);
    expect(after.devices.get(seeded.alex.active)?.status).toBe('active');
    expect(await verifyPassword(OLD, after.hash!)).toBe(true);
  }, 30_000);

  it('takes the authorization lock even when the user has zero devices', async () => {
    const env = await controlEnvFixture({ machine: FAKE_MACHINE });
    cleanups.push(env.cleanup);
    const repo = new SqliteStateRepo({ file: path.join(env.dataDir, 'finance.db') });
    const users = new LocalAuthRepo(repo);
    users.createUser('alex', await hashPassword(OLD, FAST));
    writeFence(env.controlDir, fenceState({
      gate: 'open', reason: null, generation: repo.getCardSyncAuthorizationGeneration(), next: null, op: null, machine: FAKE_MACHINE,
    }));
    repo.close();
    await lockHolder(lockPath(env.controlDir, AUTHORIZATION_LOCK), 'exclusive', cleanups);
    const result = await cli(['passwd', 'alex', '--password-stdin'], { dataDir: env.dataDir, env: env.env, run: fakeSystem });
    expect(result.code).toBe(75);
    expect(await verifyPassword(OLD, readBack(path.join(env.dataDir, 'finance.db')).hash!)).toBe(true);
  }, 30_000);
});
