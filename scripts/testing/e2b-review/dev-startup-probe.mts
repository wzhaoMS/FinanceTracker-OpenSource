import assert from 'node:assert/strict';
import http from 'node:http';
import { fs, path, REPORT_DIR, PORT, WEB_PORT, TREE, PASSWORD, world, readBack, writeFence, fenceState } from './probe-common.mts';
import { launch, cleanupChildren, waitFor } from './child-processes.mts';
import { AUTHORIZATION_LOCK, lockPath, probeExclusive, tryLock, releaseLock } from '../../../apps/api/src/control/lifecycle.ts';
import { computeMachineId } from '../../../apps/api/src/control/machineId.ts';
import { existingAncestor } from '../../../apps/api/src/control/files.ts';
import { systemRunner } from '../../../apps/api/src/control/exec.ts';

const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const records: any[] = [];
function json(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, method, path: route, agent: false,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const w = await world('actual-dev-index');
let authFd: number | null = null;
try {
  const machine = await computeMachineId(systemRunner, existingAncestor(w.dataDir));
  writeFence(w.controlDir, fenceState({
    gate: 'open', reason: null, generation: w.generation, next: null, op: null, machine,
  }));
  const env = { ...w.env, HOLDR_WEB_MODE: 'vite', PORT: String(PORT), WEB_ORIGIN: ORIGIN, SNAPSHOTS_ENABLED: '0' };
  const p = launch({ env }, path.join(TREE, 'apps/api/src/index.ts'));
  await waitFor(() => p.stdout().includes(`listening on http://127.0.0.1:${PORT}`) || p.child.exitCode !== null, 'actual index.ts startup', 45000);
  assert(p.stdout().includes(`listening on http://127.0.0.1:${PORT}`), p.stdout() + p.stderr());
  assert.equal((await json('GET', '/health')).status, 200);
  assert.equal(probeExclusive(w.controlDir), 'held', 'dev startup really participates in the configured lifecycle');
  const login = await json('POST', '/auth/login', { username: 'reviewer', password: PASSWORD }, { Origin: ORIGIN, 'X-Holdr-Request': '1' });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie']!.find((line) => line.startsWith('holdr_session='))!.split(';')[0];
  authFd = tryLock(lockPath(w.controlDir, AUTHORIZATION_LOCK), 'exclusive');
  assert(authFd !== null);
  const before = readBack(w, machine);
  const res = await json('POST', `/card-sync/owner/devices/${w.devices[0].deviceId}/revoke`, {}, {
    Cookie: cookie, Origin: ORIGIN, 'X-Holdr-Request': '1',
  });
  const after = readBack(w, machine);
  assert.equal(res.status, 503);
  assert.equal(after.devices[0].status, 'active');
  assert.equal(after.generation, before.generation);
  assert.equal(after.fence.gate, 'open');
  assert.equal(after.fence.state?.generation, before.generation);
  assert.equal(after.agrees, true);
  const finding = {
    probe: 'actual index.ts, vite mode with HOLDR_CONTROL_DIR configured',
    lifecycleLeaseHeld: true, reviewerHeldAuthorizationLockThroughoutRequest: true, httpStatus: res.status,
    databaseChanged: false, fenceStillAgrees: true, pass: true,
  };
  records.push(finding);
  console.log(JSON.stringify(finding));
  releaseLock(authFd);
  authFd = null;
  const retry = await json('POST', `/card-sync/owner/devices/${w.devices[0].deviceId}/revoke`, {}, {
    Cookie: cookie, Origin: ORIGIN, 'X-Holdr-Request': '1',
  });
  assert.equal(retry.status, 200);
  const committed = readBack(w, machine);
  assert.equal(committed.devices[0].status, 'revoked');
  assert(committed.agrees);
  assert.notEqual(committed.generation, before.generation);
  p.child.kill('SIGTERM');
  const exit = await p.done;
  assert.equal(exit.code, 0, p.stdout() + p.stderr());
  fs.writeFileSync(path.join(REPORT_DIR, 'dev-index.log'), p.stdout() + p.stderr());
} catch (error) {
  const result = { unexpectedFailure: String(error), stack: (error as Error).stack };
  records.push(result);
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  releaseLock(authFd);
  await cleanupChildren();
  w.cleanup();
  fs.writeFileSync(path.join(REPORT_DIR, 'dev-startup-results.json'), JSON.stringify(records, null, 2) + '\n');
}
