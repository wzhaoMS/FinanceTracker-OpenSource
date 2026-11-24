import { PassThrough, Writable } from 'node:stream';
import {
  fs, path, MACHINE, SqliteStateRepo, fakeSystem, readFence, TREE, newGeneration,
} from './probe-common.mts';
import { createAuthorizationGateService } from '../../../apps/api/src/control/authorizationChange.ts';
import { openWriterDb } from '../../../apps/api/src/control/writerDb.ts';
import { runHoldrRecovery } from '../../../apps/api/src/cli/holdrRecovery.ts';
import { runHoldrUserCli } from '../../../apps/api/src/cli/holdrUser.ts';
import { runHoldrBackup } from '../../../apps/api/src/cli/holdrBackup.ts';
import { acquireSharedLease, leaseStillOn, withAuthorizationLock } from '../../../apps/api/src/control/lifecycle.ts';
import { blockFence } from '../../../apps/api/src/control/recovery.ts';

const options = JSON.parse(process.argv[2]);
const emit = (data: object) => fs.writeSync(1, JSON.stringify(data) + '\n');
function checkpoint(name: string) {
  emit({ checkpoint: name, pid: process.pid });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  if (options.releaseFile) {
    while (!fs.existsSync(options.releaseFile)) Atomics.wait(signal, 0, 0, 20);
  } else {
    for (;;) Atomics.wait(signal, 0, 0, 60000);
  }
}
const waitStart = async () => {
  if (!options.startFile) return;
  emit({ ready: true });
  while (!fs.existsSync(options.startFile)) await new Promise((resolve) => setTimeout(resolve, 10));
};
const io = { stdout: { write(text: string) { emit({ out: text }); return true; } }, stderr: { write(text: string) { emit({ err: text }); return true; } } };

if (options.mode === 'hold-auth') {
  await withAuthorizationLock(options.controlDir, () => checkpoint('lock-held'));
} else if (options.mode === 'reset') {
  if (options.phase) {
    const rename = fs.renameSync;
    fs.renameSync = function (from: fs.PathLike, to: fs.PathLike) {
      const target = String(to);
      if (options.phase === 'after-recovery-fence' && target === path.join(options.controlDir, 'lifecycle-state')) {
        const state = JSON.parse(fs.readFileSync(from, 'utf8'));
        if (state.state === 'maintenance' && readFence(options.controlDir, MACHINE).state?.reason === 'recovery') {
          checkpoint('after-recovery-fence');
        }
      }
      if (options.phase === 'before-recovery-open' && target === path.join(options.controlDir, 'sync-auth-state')) {
        if (JSON.parse(fs.readFileSync(from, 'utf8')).gate === 'open') checkpoint('before-recovery-open');
      }
      return rename(from, to);
    };
    if (options.phase === 'after-recovery-commit') {
      const invalidate = SqliteStateRepo.prototype.invalidateAllCardSyncAuthorization;
      SqliteStateRepo.prototype.invalidateAllCardSyncAuthorization = function (input) {
        const report = invalidate.call(this, input);
        checkpoint('after-recovery-commit');
        return report;
      };
    }
  }
  const code = await runHoldrRecovery(['reset-authorization', '--timeout', '10'], { env: options.env, io, run: fakeSystem });
  emit({ done: true, code });
} else if (options.mode === 'backup') {
  await waitStart();
  const code = await runHoldrBackup([], { env: options.env, io, repoRoot: options.backupTree });
  emit({ done: true, code });
} else if (options.mode === 'passwd') {
  const stdin = new PassThrough();
  stdin.end('new synthetic review passphrase\n');
  const output = (field: string) => new Writable({ write(chunk, _encoding, callback) { emit({ [field]: String(chunk) }); callback(); } });
  const code = await runHoldrUserCli([options.remove ? 'remove' : 'passwd', 'reviewer', options.remove ? '--yes' : '--password-stdin'], {
    io: { stdin, stdout: output('out'), stderr: output('err') }, env: options.env,
    cwd: options.dataDir, defaultDataDir: options.dataDir, scryptParams: { ln: 10, r: 8, p: 1 }, run: fakeSystem,
  });
  emit({ done: true, code });
} else if (options.mode === 'block') {
  await waitStart();
  await blockFence(options.controlDir, MACHINE);
  emit({ done: true });
} else {
  const witness = await acquireSharedLease(options.controlDir);
  const opened = await openWriterDb(options.env, () => new SqliteStateRepo({ file: options.file }));
  const repo = opened.db;
  try {
    const ctx = {
      controlDir: options.controlDir, machine: MACHINE, databaseGeneration: () => repo.getCardSyncAuthorizationGeneration(),
      log: (line: string) => emit({ log: line }),
    };
    const gate = createAuthorizationGateService({
      ...ctx, leaseLive: () => leaseStillOn(witness, options.controlDir), lockTimeoutMs: 10000,
    });
    if (options.mode === 'reconcile') {
      const reopened = await gate.reconcile();
      emit({ done: true, reopened, gate: gate.status(), generation: repo.getCardSyncAuthorizationGeneration() });
    } else {
      const rename = fs.renameSync;
      fs.renameSync = function (from: fs.PathLike, to: fs.PathLike) {
        if (String(to) === path.join(options.controlDir, 'sync-auth-state')) {
          const state = JSON.parse(fs.readFileSync(from, 'utf8'));
          if (state.gate === 'open' && options.phase === 'before-open') checkpoint('before-open');
          if (state.reason === 'incident' && options.phase === 'before-incident'
            && readFence(options.controlDir, MACHINE).state?.reason === 'incident') checkpoint('before-incident');
        }
        return rename(from, to);
      };
      await waitStart();
      const result = await gate.change(options.kind ?? 'narrowing', (step) => {
        if (options.phase === 'after-blocked') checkpoint('after-blocked');
        const result = options.action === 'revoke'
          ? repo.revokeCardSyncDevice({ deviceId: options.deviceId, reason: 'owner', actor: { kind: 'session', actorRef: options.actorRef }, ...step })
          : options.action === 'resume'
            ? repo.resumeCardSyncOwner({ expectedVersion: options.stale ? 1 : repo.getCardSyncSettings().settingsVersion, actorRef: options.actorRef, ...step })
            : repo.pauseCardSyncOwner({ actorRef: options.actorRef, ...step });
        if (options.phase === 'after-commit') checkpoint('after-commit');
        return result;
      });
      emit({ done: true, changed: result.changed, generation: result.authorizationGeneration, gate: gate.status() });
    }
  } catch (error) {
    emit({ done: true, error: (error as any).code ?? (error as Error).message });
  } finally { opened.close(); witness.release(); }
}
