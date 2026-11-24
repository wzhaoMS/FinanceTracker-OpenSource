import path from 'node:path';
import { createServer } from 'vite';

const root = path.resolve('apps/web');
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 5308, strictPort: true },
  logLevel: 'silent',
});
const sockets = new Map();
const observedServers = new WeakSet();
let savedUpgradeListeners;
let ignoredUpgrades = 0;
let wsConnections = 0;
const wsErrors = [];
const wsErrorListeners = [];
function observeConnections() {
  const http = server.httpServer;
  if (!http || observedServers.has(http)) return;
  observedServers.add(http);
  http.on('connection', (socket) => {
    sockets.set(socket, socket.remotePort);
    socket.once('close', () => sockets.delete(socket));
  });
  server.ws.on('connection', (socket) => {
    wsConnections++;
    const existing = socket.listenerCount('error');
    wsErrorListeners.push(existing);
    // Observe only after Vite installed its own handler; never mask a missing-handler crash.
    if (existing > 0) socket.on('error', (error) => wsErrors.push(error.code ?? error.message));
  });
}
function restoreUpgrades() {
  if (!savedUpgradeListeners) return;
  server.httpServer.removeAllListeners('upgrade');
  for (const listener of savedUpgradeListeners) server.httpServer.on('upgrade', listener);
  savedUpgradeListeners = undefined;
}
async function stop() {
  // Test teardown only: assertions must observe resource release before this runs.
  for (const socket of sockets.keys()) socket.destroy();
  await server.close();
  process.exit(0);
}
observeConnections();
await server.listen();
process.send?.({ type: 'ready' });

process.on('message', async (message) => {
  try {
    if (message === 'restart') {
      restoreUpgrades();
      await server.restart();
      observeConnections();
      process.send?.({ type: 'restarted' });
    } else if (message === 'connections') {
      const count = await new Promise((resolve, reject) => {
        server.httpServer.getConnections((error, value) => error ? reject(error) : resolve(value));
      });
      process.send?.({
        type: 'connections', count, tracked: sockets.size, peers: [...sockets.values()], ignoredUpgrades,
        wsConnections, wsErrors, wsErrorListeners,
        headersTimeout: server.httpServer.headersTimeout,
        requestTimeout: server.httpServer.requestTimeout,
        connectionsCheckingInterval: server.httpServer.connectionsCheckingInterval,
      });
    } else if (message === 'unclaim-upgrades') {
      savedUpgradeListeners = server.httpServer.rawListeners('upgrade');
      server.httpServer.removeAllListeners('upgrade');
      server.httpServer.on('upgrade', () => { ignoredUpgrades++; });
      process.send?.({ type: 'unclaim-upgrades' });
    } else if (message === 'restore-upgrades') {
      restoreUpgrades();
      process.send?.({ type: 'restore-upgrades' });
    } else if (message === 'stop') {
      await stop();
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});

process.on('SIGTERM', stop);
