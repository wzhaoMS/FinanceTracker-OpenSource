import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../../apps/api/src/auth/password.ts';
import { initControlDir } from '../../../apps/api/src/control/controlDir.ts';
import { repoPaths } from '../../../apps/api/src/control/paths.ts';
import { FAKE_MACHINE, fakeSystem, fakeTmutil, liveHome, outsideRepoDir } from '../../../apps/api/src/control/testControl.ts';
import { fenceState, newGeneration, readFence, writeFence } from '../../../apps/api/src/control/syncAuthState.ts';
import { SqliteStateRepo } from '../../../apps/api/src/services/sqliteStateRepo.ts';
import { LocalAuthRepo } from '../../../apps/api/src/services/localAuthRepo.ts';
import {
  cardSyncActorRef, deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters,
} from '../../../apps/api/src/services/cardSyncDigests.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TREE = path.resolve(HERE, '../../..');
export const REPORT_DIR = privateDir(path.join(TREE, 'apps/api/.test-tmp/e2b-review'));
export const PORT = Number(process.env.HOLDR_TEST_API_PORT ?? 4116);
export const WEB_PORT = Number(process.env.HOLDR_TEST_WEB_PORT ?? 5316);
if (![4115, 4116].includes(PORT) || ![5315, 5316].includes(WEB_PORT)) throw new Error('use the assigned E2b test ports');
process.umask(0o077);
export const LOADER = path.join(TREE, 'node_modules/tsx/dist/loader.mjs');
export const MACHINE = FAKE_MACHINE;
export const PASSWORD = 'synthetic review passphrase';
export const FAST = { ln: 10, r: 8, p: 1 };
export { fs, path, fakeSystem, newGeneration, readFence, writeFence, fenceState, SqliteStateRepo, LocalAuthRepo };

export function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function makeDevice(repo: SqliteStateRepo, actorRef: string, bindingId: string, approve = true, replacesDeviceId: string | null = null) {
  const step = () => ({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
  const code = randomCardSyncLetters();
  const pairing = repo.createCardSyncPairing({
    actorRef, codeDigest: pairingCodeDigest(code), bindingIds: [bindingId], replacesDeviceId, ...step(),
  }).value;
  const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
  const deviceId = `dev_${randomCardSyncLetters()}`;
  const fingerprint = deviceFingerprint(token);
  const redeemed = repo.redeemCardSyncPairing({
    codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token),
    fingerprint, label: 'Synthetic browser', clientVersion: '1.0.0', ...step(),
  });
  if (!redeemed.ok) throw new Error('synthetic redemption refused');
  if (approve) repo.approveCardSyncPairing({ pairingId: pairing.pairingId, deviceId, fingerprint, actorRef, ...step() });
  return { deviceId, pairingId: pairing.pairingId, token, fingerprint };
}

export async function world(label: string, count = 1) {
  const root = outsideRepoDir(`e2b-${label}`).dir;
  const dataDir = privateDir(path.join(root, 'd'));
  const controlDir = path.join(root, 'c');
  await initControlDir(controlDir, { machine: MACHINE, run: fakeTmutil, repo: repoPaths(TREE) });
  const env: NodeJS.ProcessEnv = {
    HOME: liveHome(root), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1',
    HOLDR_CONTROL_DIR: controlDir, HOLDR_DATA_DIR: dataDir,
  };
  const file = path.join(dataDir, 'finance.db');
  const repo = new SqliteStateRepo({ file });
  const user = new LocalAuthRepo(repo).createUser('reviewer', await hashPassword(PASSWORD, FAST));
  const actorRef = cardSyncActorRef(user.id);
  const step = () => ({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
  repo.enableCardSyncIssuer({
    issuer: 'chase', expectedVersion: 1, contractVersion: 1, riskAcknowledged: true, mainWorldAcknowledged: false, actorRef, ...step(),
  });
  const cardAccountId = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '3391', currency: 'USD' }).id;
  const binding = repo.createCardSourceBinding({
    cardAccountId, source: 'chase-api', label: 'Synthetic review card',
    scopes: [{ label: 'Synthetic card', holderAlias: 'alex', last4: '1111' }], actorRef, ...step(),
  }).value;
  const devices = Array.from({ length: count }, () => makeDevice(repo, actorRef, binding.bindingId));
  const generation = repo.getCardSyncAuthorizationGeneration();
  writeFence(controlDir, fenceState({ gate: 'open', reason: null, generation, next: null, op: null, machine: MACHINE }));
  repo.close();
  for (const name of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(name)) fs.chmodSync(name, 0o600);
  return {
    root, dataDir, controlDir, env, file, actorRef, userId: user.id, binding, devices, generation,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function readBack(w: { file: string; controlDir: string }, machine = MACHINE) {
  const repo = new SqliteStateRepo({ file: w.file });
  try {
    const generation = repo.getCardSyncAuthorizationGeneration();
    const fence = readFence(w.controlDir, machine);
    return {
      generation, fence, agrees: fence.state?.generation === generation,
      paused: repo.getCardSyncSettings().paused, left: repo.getCardSyncRemainingAuthority(),
      devices: repo.listCardSyncDevices().map(({ deviceId, status, revokeReason }) => ({ deviceId, status, revokeReason })),
    };
  } finally { repo.close(); }
}
