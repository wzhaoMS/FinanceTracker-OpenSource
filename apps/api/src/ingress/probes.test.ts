import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { closeServers, rawRequest, releaseFixture, socketFixture, TEST_ADMISSION, TEST_ORIGIN, TEST_PORT } from './fixtures.js';
import { ingressProbes } from './probeCases.js';
import { startIngressServers } from './server.js';

const cases = ingressProbes('/assets/app-123.js', '/assets/app-123.css');
let release: ReturnType<typeof releaseFixture>;
let socket: ReturnType<typeof socketFixture>;
let repo: SqliteStateRepo;
let servers: Server[];
beforeAll(async () => {
  release = releaseFixture();
  socket = socketFixture();
  repo = new SqliteStateRepo({ file: ':memory:' });
  const { app, users } = createApp({
    repo, serviceToken: '12'.repeat(32), allowedOrigins: [TEST_ORIGIN], snapshotsEnabled: false,
    ingress: { mode: 'dist', release: release.release, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
  });
  users.createUser('probe-user', await hashPassword('synthetic-probe-password', { ln: 10, r: 8, p: 1 }));
  const mask = process.umask(0o077);
  try {
    servers = await startIngressServers(app, [
      { mode: 'dist', listener: 'ingress', socketPath: socket.socketPath, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
      { mode: 'dist', listener: 'local', port: TEST_PORT, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
    ], { socketSafety: socket.safety });
  } finally { process.umask(mask); }
});
afterAll(async () => {
  await closeServers(servers ?? []);
  repo.close();
  socket.cleanup();
  release.cleanup();
});
// The beforeAll above loads a verified release and listens on a Unix-domain socket: macOS and Linux only. On Windows the
// release directory is refused on mode bits (Node reports every directory as 0o666, whatever its NTFS ACL); with every
// test skipped there, vitest skips the beforeAll too.
describe.skipIf(process.platform === 'win32')('the 87 ported ingress probes on the real Express app', () => {
  it('retains all 87 probes', () => expect(cases).toHaveLength(87));
  it.each(cases)('$method $target -> $status ($listener)', async (probe) => {
    const response = await rawRequest(probe.listener === 'serve' ? socket.socketPath : TEST_PORT,
      probe.method, probe.target, probe.headers);
    expect(response.status).toBe(probe.status);
    if (probe.code) expect(response.headers['x-holdr-error']).toBe(probe.code);
    if (probe.method === 'HEAD') expect(response.body.length).toBe(0);
    if (response.headers['content-type']?.startsWith('text/html')) {
      expect(response.status).toBe(200);
      expect(['GET', 'HEAD']).toContain(probe.method);
      expect(['/', '/index.html']).toContain(probe.target.split('?')[0]);
      expect(probe.listener).toBe('serve');
    } else if (response.status >= 400) expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
