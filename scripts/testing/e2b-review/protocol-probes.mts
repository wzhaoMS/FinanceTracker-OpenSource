import assert from 'node:assert/strict';
import {
  fs, path, REPORT_DIR, MACHINE, SqliteStateRepo, newGeneration, readFence, writeFence, fenceState, world, readBack, privateDir,
} from './probe-common.mts';
import { launch, cleanupChildren, sleep, waitFor } from './child-processes.mts';
import {
  AUTHORIZATION_LOCK, RECOVERY_LOCK, lockPath, tryLock, releaseLock, withAuthorizationLock, readMarker, writeMarker, marker,
} from '../../../apps/api/src/control/lifecycle.ts';
import { createAuthorizationGateService } from '../../../apps/api/src/control/authorizationChange.ts';
import { enterRecovery } from '../../../apps/api/src/control/recovery.ts';
import { openWriterDb } from '../../../apps/api/src/control/writerDb.ts';

const results: any[] = [];
const worlds: Awaited<ReturnType<typeof world>>[] = [];
async function fresh(label: string) { const w = await world(label); worlds.push(w); return w; }
const opts = (w: any, extra: any) => ({
  file: w.file, controlDir: w.controlDir, dataDir: w.dataDir, actorRef: w.actorRef, deviceId: w.devices[0]?.deviceId, env: w.env, ...extra,
});
const held = (w: any, name = AUTHORIZATION_LOCK) => {
  const fd = tryLock(lockPath(w.controlDir, name), 'exclusive');
  if (fd !== null) releaseLock(fd);
  return fd === null;
};
const save = (result: any) => { results.push(result); console.log(JSON.stringify(result)); };
const checkpoint = (p: ReturnType<typeof launch>, phase: string) => p.message((m) => m.checkpoint === phase, phase);
const snapshot = (file: string, into: string) => {
  const repo = new SqliteStateRepo({ file });
  try { repo.internalGetDb().prepare('VACUUM INTO ?').run(into); } finally { repo.close(); }
  fs.chmodSync(into, 0o600);
};
const alignFence = (w: any) => {
  const b = readBack(w);
  writeFence(w.controlDir, fenceState({ gate: 'open', reason: null, generation: b.generation, next: null, op: null, machine: MACHINE }));
};

try {
  for (const phase of ['after-blocked', 'after-commit', 'before-open']) {
    const w = await fresh(`kill-${phase}`);
    const p = launch(opts(w, { mode: 'change', action: 'revoke', phase }));
    await checkpoint(p, phase);
    assert(held(w), 'checkpoint must hold the real host authorization lock');
    const during = readBack(w);
    assert.equal(during.fence.state?.reason, 'change');
    assert.equal(during.devices[0].status, phase === 'after-blocked' ? 'active' : 'revoked');
    await p.kill();
    assert(!held(w), 'SIGKILL must release the real lock');
    const startup = await launch(opts(w, { mode: 'reconcile' })).completed();
    assert.equal(startup.reopened, phase !== 'after-blocked');
    assert.equal(startup.gate, phase === 'after-blocked' ? 'blocked' : 'open');
    const beforeRecovery = readBack(w);
    if (startup.gate === 'open') assert(beforeRecovery.agrees);
    const reset = await launch(opts(w, { mode: 'reset' })).completed();
    assert.equal(reset.code, 0, JSON.stringify(reset));
    const after = readBack(w);
    assert(after.agrees);
    assert.equal(after.fence.gate, 'open');
    assert.equal(after.left.resolvingDevices + after.left.activeGrants + after.left.openPairings + after.left.preparedPlans + after.left.openRuns, 0);
    assert(after.left.paused);
    assert.equal(after.left.enabledIssuers, 0);
    save({ probe: `SIGKILL ${phase}`, startupReopened: startup.reopened, recoveryExit: reset.code, recoveryOpenAndAgrees: after.agrees, pass: true });
  }

  for (const action of ['no-op', 'refusal']) {
    const w = await fresh(`kill-${action}`);
    if (action === 'no-op') {
      const repo = new SqliteStateRepo({ file: w.file });
      repo.pauseCardSync({ actorRef: w.actorRef, expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
      repo.close();
      alignFence(w);
    }
    const before = readBack(w).generation;
    const p = launch(opts(w, { mode: 'change', action: action === 'no-op' ? 'pause' : 'resume',
      kind: action === 'no-op' ? 'narrowing' : 'widening', stale: true, phase: 'before-open' }));
    await checkpoint(p, 'before-open');
    assert.equal(readBack(w).generation, before);
    await p.kill();
    const startup = await launch(opts(w, { mode: 'reconcile' })).completed();
    assert.equal(startup.reopened, false);
    assert.equal(startup.gate, 'blocked');
    const reset = await launch(opts(w, { mode: 'reset' })).completed();
    assert.equal(reset.code, 0, JSON.stringify(reset));
    save({ probe: `SIGKILL before reopening a ${action}`, unchangedGeneration: true, startupBlocked: true, recoveryExit: 0, pass: true });
  }

  for (const phase of ['after-recovery-fence', 'after-recovery-commit', 'before-recovery-open']) {
    const w = await fresh(`kill-${phase}`);
    const p = launch(opts(w, { mode: 'reset', phase }));
    await checkpoint(p, phase);
    const interruptedFence = readFence(w.controlDir, MACHINE);
    assert.equal(interruptedFence.state?.reason, 'recovery');
    const N = interruptedFence.state?.next;
    assert(N);
    await p.kill();
    const before = readBack(w);
    assert.equal(before.left.resolvingDevices, phase === 'after-recovery-fence' ? 1 : 0);
    let startupOutcome: string;
    if (phase === 'after-recovery-fence') {
      assert.equal(readMarker(w.controlDir)?.state, 'normal');
      const startup = await launch(opts(w, { mode: 'reconcile' })).completed();
      assert.equal(startup.gate, 'blocked');
      assert.equal(startup.reopened, false);
      startupOutcome = 'owner startup allowed; device gate blocked';
    } else {
      assert.equal(readMarker(w.controlDir)?.state, 'maintenance');
      let opened = false;
      await assert.rejects(openWriterDb(w.env, () => { opened = true; return new SqliteStateRepo({ file: w.file }); }), /E0I_MAINTENANCE/);
      assert.equal(opened, false);
      startupOutcome = 'maintenance refuses database open';
    }
    const reset = await launch(opts(w, { mode: 'reset' })).completed();
    assert.equal(reset.code, 0, JSON.stringify(reset));
    const after = readBack(w);
    assert.equal(after.generation, N);
    assert(after.agrees);
    assert.equal(after.fence.gate, 'open');
    assert.equal(after.left.resolvingDevices + after.left.activeGrants + after.left.preparedPlans + after.left.openPairings, 0);
    if (phase !== 'after-recovery-fence') assert(reset.output.includes('nothing invalidated twice'));
    save({ probe: `SIGKILL ${phase}`, startupOutcome, sameRecoveryGenerationOnRerun: true, noDoubleInvalidation: phase !== 'after-recovery-fence',
      recoveryExit: 0, pass: true });
  }

  {
    const w = await fresh('two-writers');
    const startFile = path.join(w.root, 'go');
    const a = launch(opts(w, { mode: 'change', action: 'pause', startFile }));
    const b = launch(opts(w, { mode: 'change', action: 'revoke', startFile }));
    await Promise.all([a.message((m) => m.ready, 'first writer ready'), b.message((m) => m.ready, 'second writer ready')]);
    fs.writeFileSync(startFile, '');
    const [x, y] = await Promise.all([a.completed(), b.completed()]);
    assert(x.changed && y.changed && x.generation !== y.generation);
    const after = readBack(w);
    assert(after.paused && after.agrees && after.devices[0].status === 'revoked');
    save({ probe: 'two separate-process authorization changes', distinctCommits: true, finalFenceAgrees: true, pass: true });
  }

  {
    const w = await fresh('change-block');
    const startFile = path.join(w.root, 'go');
    const a = launch(opts(w, { mode: 'change', action: 'revoke', startFile }));
    const b = launch(opts(w, { mode: 'block', startFile }));
    await Promise.all([a.message((m) => m.ready, 'change ready'), b.message((m) => m.ready, 'block ready')]);
    fs.writeFileSync(startFile, '');
    await Promise.all([a.completed(), b.completed()]);
    const after = readBack(w);
    assert.equal(after.fence.state?.reason, 'incident');
    assert.equal(after.devices[0].status, 'revoked');
    assert.equal((await launch(opts(w, { mode: 'reconcile' })).completed()).reopened, false);
    save({ probe: 'change versus incident block', incidentWins: true, revoked: true, startupKeepsBlocked: true, pass: true });
  }

  {
    const w = await fresh('change-recovery');
    const releaseFile = path.join(w.root, 'continue');
    const a = launch(opts(w, { mode: 'change', action: 'revoke', phase: 'after-blocked', releaseFile }));
    await checkpoint(a, 'after-blocked');
    const b = launch(opts(w, { mode: 'reset' }));
    await waitFor(() => held(w, RECOVERY_LOCK), 'recovery owns recovery.lock');
    assert.equal(readFence(w.controlDir, MACHINE).state?.reason, 'change');
    fs.writeFileSync(releaseFile, '');
    const [change, reset] = await Promise.all([a.completed(), b.completed()]);
    assert(change.changed);
    assert.equal(reset.code, 0, JSON.stringify(reset));
    const after = readBack(w);
    assert(after.agrees && after.left.paused && after.left.resolvingDevices === 0);
    save({ probe: 'change versus reset-authorization', recoveryWaitedForChangeLock: true, finalFenceAgrees: true, recoveryExit: 0, pass: true });
  }

  {
    const w = await fresh('recovery-first');
    const startFile = path.join(w.root, 'go');
    const a = launch(opts(w, { mode: 'change', action: 'resume', kind: 'widening', startFile }));
    await a.message((m) => m.ready, 'API shared lease already acquired');
    const entry = await enterRecovery(w.controlDir, { env: w.env, machine: MACHINE, kind: 'recovery' });
    try {
      fs.writeFileSync(startFile, '');
      const change = await a.completed();
      assert.equal(change.error, 'authorization-blocked');
      assert.equal(readFence(w.controlDir, MACHINE).state?.reason, 'recovery');
    } finally { entry.recoveryLock.release(); }
    const reset = await launch(opts(w, { mode: 'reset' })).completed();
    assert.equal(reset.code, 0, JSON.stringify(reset));
    save({ probe: 'recovery fence before widening change', changeRefused: 'authorization-blocked', takeoverRecoveryExit: 0, pass: true });
  }

  {
    const w = await fresh('change-backup');
    const releaseFile = path.join(w.root, 'continue');
    const backupTree = privateDir(path.join(w.root, 'backup-tree'));
    const a = launch(opts(w, { mode: 'change', action: 'revoke', phase: 'after-blocked', releaseFile }));
    await checkpoint(a, 'after-blocked');
    const backup = await launch(opts(w, { mode: 'backup', backupTree })).completed();
    assert.equal(backup.code, 0);
    const backupRoot = path.join(backupTree, 'backups/db');
    const directory = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
    const saved = new SqliteStateRepo({ file: path.join(directory, 'finance.db') });
    const oldGeneration = saved.getCardSyncAuthorizationGeneration();
    const oldStatus = saved.getCardSyncDevice(w.devices[0].deviceId)?.status;
    saved.close();
    assert.equal(oldGeneration, w.generation);
    assert.equal(oldStatus, 'active');
    assert(!fs.existsSync(path.join(directory, 'sync-auth-state')));
    fs.writeFileSync(releaseFile, '');
    await a.completed();
    const after = readBack(w);
    assert(after.agrees && after.generation !== oldGeneration && after.devices[0].status === 'revoked');
    save({ probe: 'backup snapshot during blocked/change before commit', oldAuthoritySnapshotDistinguishable: true, fenceExcluded: true, pass: true });
  }

  {
    const w = await fresh('maintenance-cli');
    const before = readBack(w);
    writeMarker(w.controlDir, marker({ state: 'maintenance', reason: 'review-test' }, 'review'));
    const password = await launch(opts(w, { mode: 'passwd' })).completed();
    const remove = await launch(opts(w, { mode: 'passwd', remove: true })).completed();
    const backup = await launch(opts(w, { mode: 'backup', backupTree: privateDir(path.join(w.root, 'backups')) })).completed();
    assert.equal(password.code, 3, JSON.stringify(password));
    assert.equal(remove.code, 3, JSON.stringify(remove));
    assert.equal(backup.code, 3, JSON.stringify(backup));
    assert.equal(readBack(w).generation, before.generation);
    assert.equal(readBack(w).devices[0].status, 'active');
    save({ probe: 'new passwd/remove/backup participants during maintenance', passwordExit: 3, removeExit: 3, backupExit: 3,
      noAuthorizationChanged: true, pass: true });
  }

  {
    const w = await fresh('inconsistent-kill');
    const backup = path.join(w.root, 'prior-authorized.db');
    snapshot(w.file, backup);
    const repo = new SqliteStateRepo({ file: w.file });
    repo.pauseCardSync({ actorRef: w.actorRef, expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
    repo.close();
    assert(!readBack(w).agrees);
    const a = launch(opts(w, { mode: 'change', action: 'revoke', phase: 'before-incident' }));
    await checkpoint(a, 'before-incident');
    const afterCommit = readBack(w);
    assert.equal(afterCommit.devices[0].status, 'revoked');
    assert.equal(afterCommit.fence.state?.reason, 'incident');
    await a.kill();
    const startup = await launch(opts(w, { mode: 'reconcile' })).completed();
    assert.equal(startup.gate, 'blocked');
    assert.equal(readFence(w.controlDir, MACHINE).state?.reason, 'incident');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(w.file + suffix, { force: true });
    fs.copyFileSync(backup, w.file);
    fs.chmodSync(w.file, 0o600);
    const later = await launch(opts(w, { mode: 'reconcile' })).completed();
    const restored = readBack(w);
    assert.equal(later.gate, 'blocked');
    assert.equal(restored.devices[0].status, 'active');
    save({ probe: 'inconsistent fence: SIGKILL after narrowing commit before incident bookkeeping',
      persistentIncidentSurvives: true, laterMatchingBackupStillBlocked: true, pass: true });
  }

  {
    const w = await fresh('inconsistent-refusal');
    const saved = path.join(w.root, 'prior.db');
    snapshot(w.file, saved);
    const repo = new SqliteStateRepo({ file: w.file });
    repo.pauseCardSync({ actorRef: w.actorRef, expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
    const gate = createAuthorizationGateService({
      controlDir: w.controlDir, machine: MACHINE, databaseGeneration: () => repo.getCardSyncAuthorizationGeneration(), leaseLive: () => true, log() {},
    });
    assert.equal(gate.status(), 'blocked');
    await assert.rejects(gate.change('widening', (step) => repo.resumeCardSyncOwner({
      expectedVersion: repo.getCardSyncSettings().settingsVersion, actorRef: w.actorRef, ...step,
    })), /authorization-blocked/);
    assert.equal(readFence(w.controlDir, MACHINE).state?.reason, 'incident');
    repo.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(w.file + suffix, { force: true });
    fs.copyFileSync(saved, w.file);
    fs.chmodSync(w.file, 0o600);
    const later = await launch(opts(w, { mode: 'reconcile' })).completed();
    assert.equal(later.gate, 'blocked');
    save({ probe: 'inconsistent fence: widening refusal', incidentLatchedBeforeRefusal: true, laterMatchingBackupStillBlocked: true, pass: true });
  }
} catch (error) {
  save({ unexpectedFailure: String(error), stack: (error as Error).stack });
  process.exitCode = 1;
} finally {
  await cleanupChildren();
  for (const w of worlds) w.cleanup();
  fs.writeFileSync(path.join(REPORT_DIR, 'protocol-results.json'), JSON.stringify(results, null, 2) + '\n');
}
