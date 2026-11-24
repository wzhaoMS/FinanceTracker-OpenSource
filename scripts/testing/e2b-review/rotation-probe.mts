import assert from 'node:assert/strict';
import {
  fs, path, REPORT_DIR, MACHINE, SqliteStateRepo, world, makeDevice, writeFence, fenceState, readFence,
} from './probe-common.mts';
import { createAuthorizationGateService } from '../../../apps/api/src/control/authorizationChange.ts';
import { withAuthorizationLock, acquireSharedLease, leaseStillOn } from '../../../apps/api/src/control/lifecycle.ts';
import { deviceTokenDigest } from '../../../apps/api/src/services/cardSyncDigests.ts';

const records: any[] = [];
const labels = (sql: string, args: any[]) => {
  if (/UPDATE card_sync_pairings SET status = 'approved'/.test(sql)) return 'pairing-approved';
  if (/UPDATE card_sync_devices SET status = 'active'/.test(sql)) return 'new-device-active';
  if (/INSERT INTO card_sync_device_scopes /.test(sql)) return 'new-grant';
  if (/UPDATE card_sync_devices SET status = 'revoked'/.test(sql) && args[0] === 'rotated') return 'old-device-rotated';
  if (/UPDATE card_sync_device_scopes SET status = 'revoked'/.test(sql) && /WHERE device_id =/.test(sql)) return 'revoke-grants-of-device';
  if (/UPDATE card_sync_observation_sets SET state = 'blocked-review'/.test(sql) && /device_id =/.test(sql)) return 'quarantine-sets-of-device';
  if (/UPDATE card_sync_commit_plans SET status = 'cancelled'/.test(sql) && /device-revoked/.test(sql)) return 'cancel-plans-of-device';
  if (/UPDATE card_sync_pairings SET status = 'cancelled'/.test(sql) && /SELECT d\.pairing_id/.test(sql)) return 'close-pairing-of-device';
  return null;
};

for (const injectFailure of [false, true]) {
  const w = await world(injectFailure ? 'rotation-rollback' : 'rotation-order');
  const lease = await acquireSharedLease(w.controlDir);
  let repo: SqliteStateRepo | undefined;
  try {
    const seed = new SqliteStateRepo({ file: w.file });
    const next = makeDevice(seed, w.actorRef, w.binding.bindingId, false, w.devices[0].deviceId);
    await withAuthorizationLock(w.controlDir, () => writeFence(w.controlDir, fenceState({
      gate: 'open', reason: null, generation: seed.getCardSyncAuthorizationGeneration(), next: null, op: null, machine: MACHINE,
    })));
    seed.close();
    repo = new SqliteStateRepo({ file: w.file });
    const db = repo.internalGetDb();
    const tables = ['card_sync_policy', 'card_sync_pairings', 'card_sync_devices', 'card_sync_device_scopes',
      'card_source_bindings', 'card_sync_audit_events'];
    const snapshot = () => JSON.stringify(Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    const before = snapshot();
    const generation = repo.getCardSyncAuthorizationGeneration();
    const trace: string[] = [];
    const transactionChecks: boolean[] = [];
    const prepare = db.prepare;
    (db as any).prepare = function (sql: string) {
      const statement = prepare.call(this, sql);
      const run = statement.run;
      (statement as any).run = function (...args: any[]) {
        const label = labels(sql.replace(/\s+/g, ' ').trim(), args);
        if (label) {
          trace.push(label);
          transactionChecks.push(db.inTransaction);
          if (injectFailure && label === 'old-device-rotated') throw new Error('synthetic fault after new grants');
        }
        return run.apply(this, args);
      };
      return statement;
    };
    (repo as any).revokeCardSyncDevice = () => { throw new Error('rotation must not call revokeCardSyncDevice'); };
    const gate = createAuthorizationGateService({
      controlDir: w.controlDir, machine: MACHINE, leaseLive: () => leaseStillOn(lease, w.controlDir),
      databaseGeneration: () => repo!.getCardSyncAuthorizationGeneration(), log() {},
    });
    const approve = () => gate.change('widening', (step) => repo!.approveCardSyncOwnerPairing({
      pairingId: next.pairingId, deviceId: next.deviceId, fingerprint: next.fingerprint, actorRef: w.actorRef, ...step,
    }));
    if (injectFailure) {
      await assert.rejects(approve());
      assert.deepEqual(trace, ['pairing-approved', 'new-device-active', 'new-grant', 'old-device-rotated']);
      assert.equal(snapshot(), before);
      assert.equal(repo.getCardSyncAuthorizationGeneration(), generation);
      assert.equal(readFence(w.controlDir, MACHINE).gate, 'open');
      assert.equal(readFence(w.controlDir, MACHINE).state?.generation, generation);
      records.push({ probe: 'rotation fault after new grants', entireTransactionRolledBack: true, originalGenerationReopened: true, pass: true });
    } else {
      const result = await approve();
      assert(result.changed);
      assert.deepEqual(trace, ['pairing-approved', 'new-device-active', 'new-grant', 'old-device-rotated', 'revoke-grants-of-device',
        'quarantine-sets-of-device', 'cancel-plans-of-device', 'close-pairing-of-device']);
      assert(transactionChecks.every(Boolean));
      assert.equal(repo.getCardSyncDevice(w.devices[0].deviceId)?.revokeReason, 'rotated');
      assert.equal(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(w.devices[0].token)), null);
      assert.equal(result.value.device.status, 'active');
      records.push({ probe: 'E2b owner rotation execution trace', order: trace, allInsideOneTransaction: true,
        standaloneRevokeNotCalled: true, oldCredentialGone: true, pass: true });
    }
    console.log(JSON.stringify(records.at(-1)));
  } catch (error) {
    const failure = { unexpectedFailure: String(error), stack: (error as Error).stack };
    records.push(failure);
    console.log(JSON.stringify(failure));
    process.exitCode = 1;
  } finally {
    repo?.close();
    lease.release();
    w.cleanup();
  }
}
fs.writeFileSync(path.join(REPORT_DIR, 'rotation-results.json'), JSON.stringify(records, null, 2) + '\n');
