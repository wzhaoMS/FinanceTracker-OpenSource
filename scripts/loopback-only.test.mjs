import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSystemErrorMap, inspect } from 'node:util';

import {
  P_NET_CODE, bindRefusal, installLoopbackOnly, isLoopbackAddress, listenRefusal, loopbackOnlyInstalled,
  membershipRefusal, stableBindArgs, stableListenArgs,
} from './loopback-only.mjs';

// scripts/loopback-only.mjs, the P-NET guard: what it accepts (the literals 127.0.0.1 and ::1, by ROOT's ruling), the
// listens, binds and multicast memberships it refuses before anything is bound, and every test setup that loads it.
const repo = fileURLToPath(new URL('..', import.meta.url));
const guard = fileURLToPath(new URL('./loopback-only.mjs', import.meta.url));
const noop = () => {};
const bound = (address) => ({ getsockname(out) { out.address = address; return 0; } });
const HANDLE = 'a handle, which is not checked before Node listens on it';
const MEMBERSHIP = ['addMembership', 'dropMembership', 'addSourceSpecificMembership', 'dropSourceSpecificMembership'];
// TEST-NET-1 (RFC 5737): no interface may have it, so a bind to it fails (EADDRNOTAVAIL) rather than listens anywhere.
const UNASSIGNED = '192.0.2.1';
const notLocal = (address) => assert.ok(
  !Object.values(networkInterfaces()).flat().some((entry) => entry?.address === address), `${address} is local here`);
// A dgram socket's state, which Node keeps under a symbol: its libuv handle, bind state and so on.
const udpStateOf = (socket) => Object.getOwnPropertySymbols(socket).map((symbol) => socket[symbol])
  .find((value) => value !== null && typeof value === 'object' && 'handle' in value && 'bindState' in value);
const EINVAL = [...getSystemErrorMap()].find(([, [name]]) => name === 'EINVAL')[0];

test('only the literals 127.0.0.1 and ::1 are accepted: no other spelling, address or name, localhost included', () => {
  for (const host of ['127.0.0.1', '::1']) assert.equal(isLoopbackAddress(host), true, host);
  for (const host of [undefined, null, '', 0, '0.0.0.0', '::', 'localhost', 'LOCALHOST', 'localhost.', 'holdr.test',
    '127.0.0.2', '127.1.2.3', '0:0:0:0:0:0:0:1', '0::1', '::ffff:127.0.0.1', '127.0.0.1.', ' 127.0.0.1', '::1 ', '[::1]',
    '::1%lo0', '10.0.0.1', '192.168.1.20', '::ffff:192.168.1.20', 'fe80::1']) {
    assert.equal(isLoopbackAddress(host), false, String(host));
  }
});

test('listen: 127.0.0.1, ::1 or a path goes ahead; no host, a wildcard, another address, a name or a handle is refused', () => {
  for (const args of [
    [0, '127.0.0.1'], [0, '127.0.0.1', noop], [0, '127.0.0.1', 511, noop], ['0', '::1'], [undefined, '127.0.0.1'],
    [noop, '127.0.0.1'], [{ port: 0, host: '127.0.0.1' }], [{ port: 0, host: '::1' }, noop], [{ port: undefined, host: '::1' }],
    ['\\\\.\\pipe\\holdr-p-net'], ['/tmp/holdr-p-net.sock', noop], [{ path: 'holdr-p-net.sock' }],
    [{ host: '0.0.0.0' }], // Neither a port nor a path: Node refuses it itself.
  ]) {
    assert.equal(listenRefusal(args), undefined, inspect(args));
  }
  for (const [args, where] of [
    [[], 'every interface (no host given)'],
    [[noop], 'every interface (no host given)'],
    [[0], 'every interface (no host given)'],
    [[0, noop], 'every interface (no host given)'],
    [[4000, 511], 'every interface (no host given)'],
    [['4000'], 'every interface (no host given)'],
    [[' 0'], 'every interface (no host given)'],
    [[null], 'every interface (no host given)'],
    [[0, undefined, noop], 'every interface (no host given)'],
    [[0, ''], 'every interface (no host given)'],
    [[{ port: 0 }], 'every interface (no host given)'],
    [[{ port: 0, host: '' }], 'every interface (no host given)'],
    [[{ port: undefined }, noop], 'every interface (no host given)'],
    [[0, '0.0.0.0'], '0.0.0.0'],
    [[0, '::'], '::'],
    [[{ port: null, host: '::' }], '::'],
    [[0, '192.168.1.20'], '192.168.1.20'],
    [[0, '127.0.0.2'], '127.0.0.2'],
    [[{ port: 0, host: '0:0:0:0:0:0:0:1' }], '0:0:0:0:0:0:0:1'],
    [[{ port: 0, host: '0.0.0.0', path: 'holdr-p-net.sock' }], '0.0.0.0'],
    [[0, 'localhost'], '"localhost", a name'],
    [[{ port: '0', host: 'LOCALHOST' }], '"LOCALHOST", a name'],
    [[0, 'holdr.test'], '"holdr.test", a name'],
    [[{ fd: 3 }], 'file descriptor 3, which is not checked before Node listens on it'],
    [[{ handle: bound('0.0.0.0') }], HANDLE],
    [[{ _handle: bound('127.0.0.1') }], HANDLE],
    [[bound('::1')], HANDLE],
    [[{ _handle: { getsockname: () => -22 } }], HANDLE],
  ]) {
    assert.equal(listenRefusal(args), where, inspect(args));
  }
});

test('bind: 127.0.0.1 or ::1 goes ahead; send() and connect() bind an unbound socket to every interface', () => {
  for (const args of [[0, '127.0.0.1'], [0, '::1', noop], [{ port: 0, address: '127.0.0.1' }], [{ address: '::1' }, noop]]) {
    assert.equal(bindRefusal(args), undefined, inspect(args));
  }
  for (const [args, where] of [
    [[], 'every interface (no host given)'],
    [[noop], 'every interface (no host given)'],
    [[0], 'every interface (no host given)'],
    [[0, noop], 'every interface (no host given)'],
    [[{ port: 0 }], 'every interface (no host given)'],
    [[{ port: 0, exclusive: true }, null], 'every interface (no host given)'], // what send() and connect() call
    [[0, '0.0.0.0'], '0.0.0.0'],
    [[{ port: 0, address: '::' }], '::'],
    [[0, 'localhost'], '"localhost", a name'],
    [[{ fd: 3 }], 'file descriptor 3, which is not checked before Node binds it'],
  ]) {
    assert.equal(bindRefusal(args), where, inspect(args));
  }
});

test('an options object is read once, and Node gets that copy: a getter cannot pass the check and then bind elsewhere', async () => {
  // Pure first: the copy holds the first answer, and only the options Node reads.
  let reads = 0;
  const flipping = { port: 0, extra: 'dropped', get host() { reads += 1; return reads === 1 ? '127.0.0.1' : undefined; } };
  const [copy, callback] = stableListenArgs([flipping, noop]);
  assert.deepEqual([copy, callback, reads], [{ port: 0, host: '127.0.0.1' }, noop, 1]);
  assert.deepEqual(stableBindArgs([{ port: 0, address: '::1', reuse: true }, noop]), [{ port: 0, address: '::1' }, noop]);
  assert.deepEqual(stableListenArgs([0, '127.0.0.1']), [0, '127.0.0.1']);
  // Then the guarded calls. A getter whose later answers are an unresolvable name: were the options read again, Node would
  // fail to resolve it rather than bind anywhere, so this never risks a wider listener.
  const later = () => {
    let count = 0;
    return { count: () => count, get() { count += 1; return count === 1 ? '127.0.0.1' : 'holdr-p-net.invalid'; } };
  };
  const host = later();
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Object.defineProperty({ port: 0 }, 'host', { get: host.get, enumerable: true }), resolve);
  });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(host.count(), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const address = later();
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(Object.defineProperty({ port: 0 }, 'address', { get: address.get, enumerable: true }), resolve);
    });
    assert.equal(socket.address().address, '127.0.0.1');
    assert.equal(address.count(), 1);
  } finally {
    socket.close();
  }
});

test('importing it guards net.Server#listen, which every server type inherits, dgram.Socket#bind and the memberships; once', () => {
  assert.equal(loopbackOnlyInstalled(), true);
  const { listen, _listen2: listen2 } = net.Server.prototype;
  const udp = [dgram.Socket.prototype.bind, ...MEMBERSHIP.map((name) => dgram.Socket.prototype[name])];
  installLoopbackOnly();
  assert.equal(net.Server.prototype.listen, listen);
  assert.equal(net.Server.prototype._listen2, listen2);
  assert.deepEqual([dgram.Socket.prototype.bind, ...MEMBERSHIP.map((name) => dgram.Socket.prototype[name])], udp);
  for (const method of [listen2, ...udp]) assert.equal(method[Symbol.for('holdr.p-net.loopback-only')], true, method.name);
  for (const server of [http.createServer(), https.createServer(), tls.createServer(), http2.createServer(), http2.createSecureServer()]) {
    assert.equal(server.listen, listen, server.constructor.name);
  }
});

test('a refused listen throws before anything binds, on every server type', () => {
  const servers = [net.createServer(), http.createServer(), https.createServer(), tls.createServer(), http2.createServer(),
    http2.createSecureServer()];
  for (const server of servers) {
    for (const args of [[], [0], [0, noop], [{ port: 0 }], [0, '0.0.0.0'], [0, '::'], [0, 'localhost'], [0, 'holdr-p-net.invalid'],
      [{ port: 0, host: '' }], [{ handle: bound('127.0.0.1') }]]) {
      // Decided refused first, so that a broken guard fails here rather than listening.
      assert.notEqual(listenRefusal(args), undefined, inspect(args));
      assert.throws(() => server.listen(...args), (error) => {
        assert.equal(error.code, P_NET_CODE);
        assert.match(error.message, /^P-NET: refused to listen on .+; listen on 127\.0\.0\.1 or ::1 instead\. .+ \(scripts\/loopback-only\.mjs\)\.$/);
        return true;
      });
      assert.equal(server.listening, false);
      assert.equal(server.address(), null);
    }
  }
});

test('a listen on 127.0.0.1, ::1 or a pipe path goes ahead', async (t) => {
  const listening = (server, ...args) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => { server.off('error', reject); resolve(server.address()); });
  });
  const close = (server) => new Promise((resolve) => server.close(() => resolve()));
  const v4 = http.createServer();
  assert.equal((await listening(v4, 0, '127.0.0.1')).address, '127.0.0.1');
  await close(v4);
  const options = net.createServer();
  assert.equal((await listening(options, { port: 0, host: '127.0.0.1' })).address, '127.0.0.1');
  await close(options);
  const v6 = net.createServer();
  try {
    assert.equal((await listening(v6, 0, '::1')).address, '::1');
    await close(v6);
  } catch (error) {
    if (error.code !== 'EADDRNOTAVAIL' && error.code !== 'EAFNOSUPPORT') throw error;
    t.diagnostic(`no IPv6 loopback here (${error.code})`);
  }
  const directory = process.platform === 'win32' ? undefined : await mkdtemp(path.join(tmpdir(), 'holdr-p-net-'));
  try {
    const pipe = net.createServer();
    const where = directory ? path.join(directory, 's.sock') : `\\\\.\\pipe\\holdr-p-net-${process.pid}-${Date.now()}`;
    assert.equal(await listening(pipe, where), where);
    await close(pipe);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('UDP: a bind, or the one send() or connect() makes, must name a loopback address', async () => {
  const socket = dgram.createSocket('udp4');
  const connecting = dgram.createSocket('udp4');
  try {
    for (const args of [[], [0], [0, noop], [{ port: 0 }], [0, '0.0.0.0'], [{ port: 0, address: '0.0.0.0' }]]) {
      assert.notEqual(bindRefusal(args), undefined, inspect(args));
      assert.throws(() => socket.bind(...args), { code: P_NET_CODE }, inspect(args));
    }
    assert.throws(() => socket.send('probe', 9, '127.0.0.1'),
      { code: P_NET_CODE, message: /^P-NET: refused to bind a UDP socket to every interface \(no host given\); / });
    assert.throws(() => connecting.connect(9, '127.0.0.1'), { code: P_NET_CODE });
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    assert.equal(socket.address().address, '127.0.0.1');
  } finally {
    socket.close();
    connecting.close();
  }
});

test("UDP: Node binds what the socket's lookup answers, even for 127.0.0.1, so that answer must be 127.0.0.1 or ::1", async () => {
  // The lookup (createSocket's lookup option) answers 192.0.2.1, at once or later, and the socket's native bind is stood
  // in for: a broken guard would record a call here, never bind anything. lib/dgram.js binds the answer whenever the
  // lookup's status is falsy, so each falsy status is tried; a truthy one is Node's own error and passes through as is.
  notLocal(UNASSIGNED);
  const lookupFailed = new Error('lookup failed');
  const timings = [['at once', (callback) => callback()], ['later', (callback) => process.nextTick(callback)]];
  for (const status of [null, undefined, 0, false, '', lookupFailed]) {
    for (const [timing, answer] of timings) {
      const label = `status ${status === lookupFailed ? 'an Error' : inspect(status)}, answered ${timing}`;
      const asked = [];
      const socket = dgram.createSocket({
        type: 'udp4',
        lookup(address, family, callback) {
          asked.push([address, family]);
          answer(() => callback(status, UNASSIGNED, 4));
        },
      });
      const { handle } = udpStateOf(socket);
      const binds = [];
      handle.bind = (...args) => { binds.push(args); return EINVAL; };
      const { lookup } = handle;
      try {
        const failed = new Promise((resolve, reject) => {
          socket.once('error', resolve);
          socket.once('listening', () => reject(new Error(`bound (${label})`)));
        });
        socket.bind(0, '127.0.0.1');
        assert.equal(handle.lookup, lookup, label); // checked for that bind only
        const error = await failed;
        if (status === lookupFailed) {
          assert.equal(error, lookupFailed, label);
        } else {
          assert.equal(error.code, P_NET_CODE, label);
          assert.equal(error.message, `P-NET: refused to bind a UDP socket to ${UNASSIGNED}, which its lookup gave for `
            + '"127.0.0.1"; bind it to 127.0.0.1 or ::1 instead, with a lookup that answers them as they are '
            + '(scripts/loopback-only.mjs).', label);
        }
        assert.deepEqual(asked, [['127.0.0.1', 4]], label);
        assert.deepEqual(binds, [], label);
      } finally {
        socket.close();
      }
    }
  }
  // A lookup that answers the literal as it is, with a success status Node accepts: the bind goes ahead, on 127.0.0.1.
  for (const status of [null, 0]) {
    const plain = dgram.createSocket({ type: 'udp4', lookup: (address, family, callback) => callback(status, address, family) });
    try {
      await new Promise((resolve, reject) => { plain.once('error', reject); plain.bind(0, '127.0.0.1', resolve); });
      assert.equal(plain.address().address, '127.0.0.1', `status ${inspect(status)}`);
    } finally {
      plain.close();
    }
  }
});

test('TCP: Node listens on what dns.lookup answers for the host, so that answer is checked before the bind (_listen2)', async () => {
  // dns.lookup, which lib/net.js calls for the host, answers 192.0.2.1: a broken guard would fail to bind it, never
  // listen beyond loopback. lib/net.js listens on the answer whenever the status is falsy, so each falsy status is tried.
  notLocal(UNASSIGNED);
  const { lookup } = dns;
  try {
    for (const status of [null, undefined, 0, false, '']) {
      const label = `status ${inspect(status)}`;
      const asked = [];
      dns.lookup = (hostname, ...rest) => {
        asked.push(hostname);
        // Node 22 asks lookup(host, { all: true }, callback); Node 20 asks lookup(host, callback).
        const callback = rest.findLast((value) => typeof value === 'function');
        const all = rest.some((value) => value !== null && typeof value === 'object' && value.all === true);
        process.nextTick(...(all ? [callback, status, [{ address: UNASSIGNED, family: 4 }]] : [callback, status, UNASSIGNED, 4]));
      };
      const server = net.createServer();
      const error = await new Promise((resolve, reject) => {
        server.once('error', resolve);
        server.listen(0, '127.0.0.1', () => reject(new Error(`listening (${label})`)));
      });
      assert.equal(error.code, P_NET_CODE, label);
      assert.equal(error.message, `P-NET: refused to listen on ${UNASSIGNED}, the address the lookup gave; listen on `
        + '127.0.0.1 or ::1 instead, with a lookup that answers them as they are (scripts/loopback-only.mjs).', label);
      assert.deepEqual(asked, ['127.0.0.1'], label);
      assert.equal(server.listening, false, label);
    }
  } finally {
    dns.lookup = lookup;
  }
});

test('a multicast membership needs a socket bound to loopback already: libuv binds an unbound one to every interface', () => {
  // Stand-ins only, never a real socket: an unbound real one is what libuv would bind beyond loopback.
  const unbound = { address() { throw Object.assign(new Error('getsockname EBADF'), { code: 'EBADF' }); } };
  const closed = { address() { throw Object.assign(new Error('Not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }); } };
  const wildcard = { address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 5353 }) };
  const loopback = { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 5353 }) };
  assert.equal(membershipRefusal(unbound), 'that is not bound yet');
  assert.equal(membershipRefusal(wildcard), 'bound to 0.0.0.0');
  assert.equal(membershipRefusal(loopback), undefined);
  assert.equal(membershipRefusal(closed), undefined); // Node's own method refuses a closed socket before any bind.
  const real = dgram.createSocket('udp4'); // never bound, never joined: only its methods are compared
  try {
    for (const name of MEMBERSHIP) assert.equal(real[name], dgram.Socket.prototype[name], name);
  } finally {
    real.close();
  }
  for (const name of MEMBERSHIP) {
    const method = dgram.Socket.prototype[name];
    const args = name.includes('Source') ? ['127.0.0.1', '232.1.2.3'] : ['239.1.2.3'];
    assert.throws(() => method.apply(unbound, args), {
      code: P_NET_CODE,
      message: `P-NET: refused ${name}() on a UDP socket that is not bound yet; bind it to 127.0.0.1 or ::1 first (libuv `
        + 'binds an unbound socket to every interface for it) (scripts/loopback-only.mjs).',
    });
    assert.throws(() => method.apply(wildcard, args), { code: P_NET_CODE, message: /^P-NET: refused \w+\(\) on a UDP socket bound to 0\.0\.0\.0; / });
    // Bound to loopback, the call goes on to Node's own method, which then refuses the stand-in (it has no handle).
    for (const passed of [loopback, closed]) {
      assert.throws(() => method.apply(passed, args), (error) => error.code !== P_NET_CODE, name);
    }
  }
});

test('passed as --import to a unit-test script, it reaches every test file process (run-tsx-tests, tsx, node --test)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'holdr-p-net-import-'));
  try {
    await mkdir(path.join(dir, 'node_modules'));
    await mkdir(path.join(dir, 'src'));
    await symlink(path.dirname(createRequire(import.meta.url).resolve('tsx/package.json')), path.join(dir, 'node_modules', 'tsx'), 'junction');
    for (const name of ['a', 'b']) {
      await writeFile(path.join(dir, 'src', `${name}.test.ts`), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import net from 'node:net';",
        `test('${name}: guarded', () => {`,
        "  assert.equal((net.Server.prototype.listen as unknown as Record<symbol, unknown>)[Symbol.for('holdr.p-net.loopback-only')], true);",
        "  assert.throws(() => net.createServer().listen(0), { code: 'ERR_P_NET_NON_LOOPBACK' });",
        '});',
        '',
      ].join('\n'));
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [path.join(repo, 'scripts', 'run-tsx-tests.mjs'), 'src', '.test.ts',
      `--import=${pathToFileURL(guard).href}`, '--test-reporter=tap'], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^# pass 2$/m);
    assert.match(run.stdout, /^# fail 0$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every test setup that starts listeners loads it', async () => {
  const read = (file) => readFile(path.join(repo, file), 'utf8');
  const scripts = async (file) => JSON.parse(await read(file)).scripts;
  for (const config of ['apps/api/vitest.config.ts', 'apps/api/vitest.ingress.config.ts', 'apps/api/vitest.stack.config.ts']) {
    assert.ok((await read(config)).includes("setupFiles: ['../../scripts/loopback-only.mjs']"), config);
  }
  const unitTests = { 'packages/shared/package.json': 'test', 'apps/web/package.json': 'test:unit', 'apps/extension/package.json': 'test' };
  for (const [file, name] of Object.entries(unitTests)) {
    assert.match((await scripts(file))[name], /^node \.\.\/\.\.\/scripts\/run-tsx-tests\.mjs \S+ \.test\.ts --import=\.\.\/\.\.\/scripts\/loopback-only\.mjs$/, file);
  }
  // Playwright's UI server listens on localhost unless told a host, and the guard refuses names (ROOT's ruling).
  assert.equal((await scripts('apps/web/package.json'))['test:e2e:ui'], 'playwright test --ui --ui-host=127.0.0.1');
  for (const [file, specifier] of [
    ['apps/web/playwright.config.ts', '../../scripts/loopback-only.mjs'],
    ['apps/web/playwright.harness.config.ts', '../../scripts/loopback-only.mjs'],
    ['apps/extension/tests/e2e/playwright.config.ts', '../../../../scripts/loopback-only.mjs'],
    ['apps/extension/tests/acceptance/playwright.config.ts', '../../../../scripts/loopback-only.mjs'],
    ['apps/web/apiProxy.test.ts', '../../scripts/loopback-only.mjs'],
    ['apps/web/viteFileAccess.test.ts', '../../scripts/loopback-only.mjs'],
    ['scripts/e0i-device-probe.test.mjs', './loopback-only.mjs'],
    ['scripts/e2e-disposable.test.mjs', './loopback-only.mjs'],
    ['scripts/start-finance-mac.test.mjs', './loopback-only.mjs'],
    ['scripts/start-finance-mac.dist.test.mjs', './loopback-only.mjs'],
    ['scripts/e2e-disposable.mjs', './loopback-only.mjs'],
    ['scripts/testing/e2b-review/http-probes.mts', '../../loopback-only.mjs'],
    // The child offlinePreload.test.ts starts, with and without the offline preload.
    ['apps/api/src/e2e/offlineProbe.mjs', '../../../../scripts/loopback-only.mjs'],
  ]) {
    assert.match(await read(file), new RegExp(`^import '${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';$`, 'm'), file);
    assert.equal(path.resolve(path.dirname(path.join(repo, file)), specifier), guard, file);
  }
});
