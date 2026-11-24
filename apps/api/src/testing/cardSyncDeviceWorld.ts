import net from 'node:net';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { createAuthorizationGateService } from '../control/authorizationChange.js';
import { acquireSharedLease, leaseStillOn, withAuthorizationLock, type Lease } from '../control/lifecycle.js';
import { fenceState, writeFence } from '../control/syncAuthState.js';
import { controlEnvFixture, TEST_MACHINE } from '../control/testControl.js';
import { shortDir } from '../control/testDirs.js';
import { admitDeviceRequest } from '../ingress/deviceAdmission.js';
import { resolveIngressConfig } from '../ingress/config.js';
import { closeServers, releaseFixture, SERVE_HEADERS, TEST_PORT } from '../ingress/fixtures.js';
import { startIngressServers } from '../ingress/server.js';
import { DEVICE_EXTENSION_ORIGINS } from '../routes/cardSync/deviceCors.js';
import { CardSyncScenario } from './cardSyncScenario.js';

export const DEVICE_TEST_ORIGIN = 'https://holdr.test';
export const DEVICE_TEST_PASSWORD = 'synthetic owner password';
const FAST = { ln: 10, r: 8, p: 1 };

export interface DeviceHttpReply {
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
  json: any;
}

/** A bound Unix request, retaining duplicate headers and malformed body bytes for refusal tests. */
export function deviceRawRequest(socketPath: string | number, method: string, target: string,
  headers: readonly (readonly [string, string])[], bytes: Buffer = Buffer.alloc(0)): Promise<DeviceHttpReply> {
  return new Promise((resolve, reject) => {
    const socket = typeof socketPath === 'number' ? net.connect(socketPath, '127.0.0.1') : net.connect({ path: socketPath });
    const chunks: Buffer[] = [];
    socket.setTimeout(20_000, () => socket.destroy(Error('synthetic device request timeout')));
    socket.once('error', reject);
    socket.once('connect', () => {
      const all = [...headers, ['Connection', 'close'] as const];
      if (!all.some(([name]) => name.toLowerCase() === 'content-length')) all.push(['Content-Length', String(bytes.length)]);
      const head = Buffer.from(`${method} ${target} HTTP/1.1\r\n${all.map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      socket.write(Buffer.concat([head, bytes]));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => {
      const response = Buffer.concat(chunks);
      const split = response.indexOf('\r\n\r\n');
      if (split < 0) { reject(Error('synthetic device response had no headers')); return; }
      const lines = response.subarray(0, split).toString().split('\r\n');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines.shift()!)?.[1]);
      const fields: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        fields[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const body = response.subarray(split + 4);
      let json: unknown = null;
      try { if (body.length && method !== 'HEAD') json = JSON.parse(body.toString()); } catch { /* assertion reports only the status */ }
      resolve({ status, headers: fields, bytes: body, json });
    });
  });
}

/** The real app/repository, B's real locks and D's real gate; only attestation/socket providers are test injected. */
export async function cardSyncDeviceWorld() {
  const control = await controlEnvFixture();
  const sockets = shortDir();
  const release = releaseFixture();
  let scenario: CardSyncScenario | undefined;
  let lease: Lease | undefined;
  let servers: Server[] = [];
  let closed = false;
  let refusal: 'ingress-unverified' | 'ingress-refused' | null = null;
  const logs: string[] = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeServers(servers);
    scenario?.close();
    lease?.release();
    release.cleanup();
    sockets.cleanup();
    control.cleanup();
  };
  try {
    lease = await acquireSharedLease(control.controlDir);
    const mask = process.umask(0o077);
    try { scenario = new CardSyncScenario(path.join(control.dataDir, 'finance.db')); } finally { process.umask(mask); }
    const w = scenario;
    const repo = w.repo;
    const env = {
      NODE_ENV: 'production', HOLDR_WEB_MODE: 'dist', PORT: String(TEST_PORT), HOLDR_PUBLIC_ORIGIN: DEVICE_TEST_ORIGIN,
      HOLDR_WEB_RELEASE_DIR: release.dir, HOLDR_WEB_RELEASE_DIGEST: release.digest,
      HOLDR_DATA_DIR: control.dataDir, HOLDR_CONTROL_DIR: control.controlDir, HOLDR_DEVICE_API: '1',
      HOLDR_SERVE_SOCKET: path.join(sockets.dir, 's'),
    };
    const config = resolveIngressConfig(env);
    if (config.mode !== 'dist') throw Error('device fixture mode');
    const syncFence = () => withAuthorizationLock(control.controlDir, () => writeFence(control.controlDir, fenceState({
      gate: 'open', reason: null, generation: w.generation(), next: null, op: null, machine: TEST_MACHINE,
    })));
    await syncFence();
    const attestation = { refusal: () => refusal };
    const authorization = {
      controlDir: control.controlDir, machine: TEST_MACHINE, databaseGeneration: () => w.generation(), log: (line: string) => logs.push(line),
    };
    const gate = createAuthorizationGateService({
      ...authorization, leaseLive: () => leaseStillOn(lease!, control.controlDir),
    });
    const holdr = createApp({
      repo, serviceToken: 'be'.repeat(32), allowedOrigins: [DEVICE_TEST_ORIGIN], snapshotsEnabled: false,
      ingress: { mode: 'dist', publicOrigin: DEVICE_TEST_ORIGIN, release: release.release, admission: attestation },
      cardSyncAuthorization: { gate, holdrOrigin: DEVICE_TEST_ORIGIN, deviceApi: 'enabled' },
      now: () => new Date(w.clock), scryptParams: FAST, log: (line) => logs.push(line),
    });
    holdr.users.createUser('synthetic-owner', await hashPassword(DEVICE_TEST_PASSWORD, FAST));
    const listenerMask = process.umask(0o077);
    try {
      servers = await startIngressServers(holdr.app, [
        { mode: 'dist', listener: 'local', port: TEST_PORT, publicOrigin: DEVICE_TEST_ORIGIN, admission: attestation },
        { mode: 'dist', listener: 'ingress', socketPath: config.socketPath, publicOrigin: DEVICE_TEST_ORIGIN, admission: attestation },
      ], { socketSafety: { async beforeListen() {}, async afterListen() {} } });
    } finally { process.umask(listenerMask); }
    const serve = servers.find((server) => server.address() === config.socketPath)!;
    const admission = admitDeviceRequest({
      config, env, serve, attestation, source: repo,
      lifecycle: () => ({ controlDir: control.controlDir, machine: TEST_MACHINE, leaseLive: () => leaseStillOn(lease!, control.controlDir) }),
    });
    holdr.deviceMount!.install(admission, authorization);
    const request = (method: string, target: string, body?: unknown, extra: Array<[string, string]> = []) =>
      deviceRawRequest(config.socketPath, method, target, [...SERVE_HEADERS, ...extra,
        ...(body === undefined ? [] : [['Content-Type', 'application/json'] as [string, string]])],
      body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const deviceHeaders = (token: string, version = '1.2.3'): Array<[string, string]> => [
      ['Authorization', `HoldrDevice ${token}`], ['X-Holdr-Client', 'extension-v1'], ['X-Holdr-Client-Version', version],
      ['Origin', DEVICE_EXTENSION_ORIGINS[0]],
    ];
    return {
      ...control, ...holdr, w, repo, config, logs, gate, admission, authorization, request, deviceHeaders, syncFence, close,
      raw: (method: string, target: string, headers: Array<[string, string]>, body: Buffer = Buffer.alloc(0)) =>
        deviceRawRequest(config.socketPath, method, target, [...SERVE_HEADERS, ...headers], body),
      setRefusal: (value: 'ingress-unverified' | 'ingress-refused' | null) => { refusal = value; },
      releaseLease: () => lease!.release(),
      async login() {
        const login = await request('POST', '/auth/login', { username: 'synthetic-owner', password: DEVICE_TEST_PASSWORD },
          [['Origin', DEVICE_TEST_ORIGIN], ['X-Holdr-Request', '1']]);
        if (login.status !== 200) throw Error('synthetic owner login failed');
        return login.headers['set-cookie'].split(';')[0];
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
