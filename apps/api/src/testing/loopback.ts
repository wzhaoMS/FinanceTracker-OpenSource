import http from 'node:http';
import { onTestFinished } from 'vitest';

/**
 * Serve `app` for supertest on 127.0.0.1, at a port the kernel picks:
 *
 *   await request(await listenLoopback(app)).get('/health').expect(200);
 *
 * supertest's own `request(app)` listens on the wildcard address and then
 * connects to 127.0.0.1. macOS lets a wildcard bind take a port that another
 * process already holds on 127.0.0.1 itself, and the test's requests then
 * reach that process (a local app answering 401, say) instead of the app
 * under test. A server bound to 127.0.0.1 is never given such a port. The
 * bind completes asynchronously, so this resolves once the server listens;
 * supertest then uses that address instead of listening on its own. The
 * server closes when the current test finishes, so call this inside a test
 * or a beforeEach hook. src/testing/loopback.test.ts fails any API test
 * that hands supertest anything else.
 */
export async function listenLoopback(app: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(app);
  onTestFinished(() => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
