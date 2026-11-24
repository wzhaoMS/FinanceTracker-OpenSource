/**
 * The real app (createApp) in a process of its own, for
 * app.asyncFailures.test.ts: the test sends it requests over HTTP and, over
 * IPC, tells it which tables to break, then checks that it answered every
 * request and is still running. Nothing here leaves the machine: the
 * database is in memory, the server listens on 127.0.0.1, and fetch is
 * replaced before the app is built (the broker bridge answers from here; the
 * quote providers fail).
 *
 * Messages from the test:
 *   { breakReads: string[] }  every read of each table fails with SQLite's
 *                             "no such table: main.pan_<SENTINEL>"
 *   { close: true }           shut down and exit 0
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const SENTINEL = process.env.HOLDR_TEST_SENTINEL ?? '';
const ORIGIN = process.env.HOLDR_TEST_ORIGIN ?? '';
const PASSWORD = process.env.HOLDR_TEST_PASSWORD ?? '';
if (!/^\d{12,19}$/.test(SENTINEL) || !ORIGIN || !PASSWORD || !process.send) {
  throw new Error('run this from app.asyncFailures.test.ts');
}
const FAST = { ln: 10, r: 8, p: 1 };
const json = { 'Content-Type': 'application/json' };

process.env.BROKER_BRIDGE_URL = 'http://bridge.invalid';
globalThis.fetch = async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'http://bridge.invalid/extract-activity') {
    return new Response(JSON.stringify({
      broker: 'fidelity',
      loggedIn: true,
      rows: [{
        date: 'May-07-2026', accountLabel: 'Individual ***2468',
        description: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
        amount: '-$113.99', quantity: '0.65', pricePerUnit: '$175.3',
      }],
    }), { status: 200, headers: json });
  }
  if (url === 'http://bridge.invalid/extract' || url === 'http://bridge.invalid/extract-bookmarklet') {
    // Per-section rows: the import then matches each section to a stored account.
    return new Response(JSON.stringify({
      loggedIn: true,
      table: {
        headers: ['Symbol', 'Quantity', 'Price'],
        rows: [{ Symbol: 'VTI', Quantity: '1', Price: '$10', _section: 'Individual ***2468' }],
      },
    }), { status: 200, headers: json });
  }
  throw new TypeError('fetch failed (outbound requests are disabled in this test)');
};

const { createApp } = await import('../app.js');
const { hashPassword } = await import('../auth/password.js');
const { SqliteStateRepo } = await import('../services/sqliteStateRepo.js');

const repo = new SqliteStateRepo({ file: ':memory:' });
repo.createAccount({ id: 'fid', name: 'Synthetic brokerage', accountNumber: 'XXXX-2468', cashBalance: 0, currency: 'USD' });
repo.createTransaction({ id: 'tx-1', accountId: 'fid', symbol: 'NVDA', date: '2026-05-01', quantity: 2, pricePerUnit: 100, currency: 'USD' });
const built = createApp({
  repo,
  serviceToken: '5e'.repeat(32),
  allowedOrigins: [ORIGIN],
  snapshotsEnabled: false,
  scryptParams: FAST,
});
built.users.createUser('alex', await hashPassword(PASSWORD, FAST));

/** Every read of each table fails: it becomes a view over a table that no longer exists. */
function breakReads(tables: readonly string[]): void {
  if (tables.some((table) => !/^[a-z_]+$/.test(table))) throw new Error('not a table name');
  // The missing table exists while the tables are renamed: a rename parses every view, the broken ones too.
  repo.internalGetDb().exec([
    `CREATE TABLE pan_${SENTINEL} (x);`,
    ...tables.map((table) => `ALTER TABLE ${table} RENAME TO ${table}_kept;`),
    ...tables.map((table) => `CREATE VIEW ${table} AS SELECT * FROM pan_${SENTINEL};`),
    `DROP TABLE pan_${SENTINEL};`,
  ].join('\n'));
}

const server = http.createServer(built.app);
process.on('message', (message: { breakReads?: string[]; close?: boolean }) => {
  if (message.breakReads) {
    breakReads(message.breakReads);
    process.send!({ broken: message.breakReads });
  }
  if (message.close) {
    server.closeAllConnections();
    server.close(() => {
      repo.close();
      process.exit(0);
    });
  }
});
server.listen(0, '127.0.0.1', () => {
  process.send!({ ready: true, port: (server.address() as AddressInfo).port });
});
