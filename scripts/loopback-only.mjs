// The P-NET guard for test processes (ROOT's standing rule P-NET): nothing a test starts may listen beyond loopback.
// The first time a node.exe on Windows listens on every interface, Windows Defender Firewall raises a prompt that takes
// the foreground; on any machine, such a listener is open to the network.
//
// Importing this module makes the process refuse such a listener before anything is bound:
//
//   - net.Server#listen, which http, https, http2 and tls servers inherit, must name the address 127.0.0.1 or ::1, as
//     those very strings (ROOT's ruling on P-NET: explicit literals only). No host (every interface), 0.0.0.0, ::, any
//     other address and any name, localhost included, are refused: names resolve through the OS, and a hosts file can
//     move them. A pipe or Unix socket path is allowed. A handle or a file descriptor is refused, since what it is
//     bound to is not checked before Node listens on it. Node looks the host up (dns.lookup, which a test can replace)
//     and binds the answer, so the answer is checked too, after the lookup and before the bind (net.Server#_listen2).
//   - dgram.Socket#bind must name 127.0.0.1 or ::1 too, and so must the bind with which send() and connect() put an
//     unbound socket on every interface. Node binds what the socket's lookup answers for that address (dns.lookup, or
//     dgram.createSocket's lookup option), so for that bind the answer must be 127.0.0.1 or ::1 as well. The
//     multicast membership calls (addMembership, dropMembership and their source-specific forms) are refused on a
//     socket that is not bound to 127.0.0.1 or ::1: libuv binds an unbound socket to every interface for them, without
//     Socket#bind. Bind such a socket to 127.0.0.1 first.
//
// An options object is read once and Node is handed that copy, so the address checked is the address bound. Each
// refusal names the address to use instead. Tools that listen on localhost by default are run pinned (Playwright's UI
// mode: apps/web's test:e2e:ui passes --ui-host=127.0.0.1).
//
// A refusal throws from listen() or bind() (and so from send() or connect()), or from the membership call, an Error
// whose code is ERR_P_NET_NON_LOOPBACK, so the test that asked fails and nothing listens. That includes supertest's
// request(app), which listens on every interface (app.listen(0)): hand supertest a server already listening on
// 127.0.0.1 instead (apps/api/src/testing/loopback.ts). A lookup's
// answer is refused the way Node reports a failed lookup: that Error is the server's or the socket's 'error' event,
// and nothing is bound. Processes a test starts are not covered: start them on a loopback host (vite --host 127.0.0.1,
// HOLDR_HOST=127.0.0.1).
//
// Loaded by apps/api's vitest configs (setupFiles), by the unit-test scripts of packages/shared, apps/web and
// apps/extension (--import), by every Playwright config (its runner and each worker load the config), by
// the e2e runner and the e2b review's HTTP probes, and by the other test files that start listeners and run on their own.
// scripts/loopback-only.test.mjs checks each of those.
// Loading it more than once is harmless. Plain Node, no dependency.
import dgram from 'node:dgram';
import net from 'node:net';

export const P_NET_CODE = 'ERR_P_NET_NON_LOOPBACK';
const GUARDED = Symbol.for('holdr.p-net.loopback-only');
// The dgram calls for which libuv binds an unbound socket to every interface itself, without Socket#bind.
const MEMBERSHIP = ['addMembership', 'dropMembership', 'addSourceSpecificMembership', 'dropSourceSpecificMembership'];
// The options lib/net.js reads from listen(options), and lib/dgram.js from bind(options).
const LISTEN_OPTIONS = ['port', 'host', 'path', 'backlog', 'exclusive', 'readableAll', 'writableAll', 'ipv6Only', 'reusePort',
  'signal', 'fd'];
const BIND_OPTIONS = ['port', 'address', 'exclusive', 'fd'];

/** Whether `host` is the literal 127.0.0.1 or ::1, the only addresses a test may listen on (ROOT's P-NET ruling). */
export function isLoopbackAddress(host) {
  return host === '127.0.0.1' || host === '::1';
}

// lib/net.js reads a string that is not a port number as a pipe or Unix socket path.
const isPipeName = (value) => typeof value === 'string' && !(Number(value) >= 0);
// What lib/net.js would listen on as a handle (options._handle || options.handle), or a handle itself.
const isHandle = (options) => Boolean(options._handle || options.handle) || typeof options.getsockname === 'function';
const HANDLE = 'a handle, which is not checked before Node listens on it';

/** Where `host` would put a listener, unless it is 127.0.0.1 or ::1. */
function beyondLoopback(host) {
  if (isLoopbackAddress(host)) return undefined;
  if (host === undefined || host === null || host === '') return 'every interface (no host given)';
  return net.isIP(String(host)) ? String(host) : `${JSON.stringify(host)}, a name`;
}

/** `options` with each of `names` read once. Node is handed this copy, so a getter cannot pass the check, then bind. */
function snapshot(options, names) {
  const copy = {};
  for (const name of names) if (name in options) copy[name] = options[name];
  return copy;
}

/** listen's arguments with an options object read once: a snapshot, which never holds a handle. */
export function stableListenArgs(args) {
  const [first, ...rest] = args;
  return first !== null && typeof first === 'object' ? [snapshot(first, LISTEN_OPTIONS), ...rest] : args;
}

/** bind's arguments with an options object read once. */
export function stableBindArgs(args) {
  const [first, ...rest] = args;
  return first !== null && typeof first === 'object' ? [snapshot(first, BIND_OPTIONS), ...rest] : args;
}

/**
 * Where net.Server#listen(...args) would listen beyond loopback, or undefined if it would not (or if Node refuses the
 * arguments itself). The arguments are read as lib/net.js reads them (normalizeArgs, then listen).
 */
export function listenRefusal(args) {
  const [first, second] = args;
  if (first === null || typeof first !== 'object') {
    // listen(), listen(callback), listen(port[, host][, backlog][, callback]) or listen(path[, backlog][, callback]).
    return isPipeName(first) ? undefined : beyondLoopback(typeof second === 'string' ? second : undefined);
  }
  if (isHandle(first)) return HANDLE;
  if (typeof first.fd === 'number' && first.fd >= 0) {
    return `file descriptor ${first.fd}, which is not checked before Node listens on it`;
  }
  const { port } = first;
  if (typeof port === 'number' || typeof port === 'string' || (port == null && 'port' in first)) {
    return beyondLoopback(first.host);
  }
  return undefined; // A path, or options that Node refuses itself.
}

/** Where dgram.Socket#bind(...args) would bind beyond loopback, or undefined if it would not (as lib/dgram.js reads them). */
export function bindRefusal(args) {
  const [first, second] = args;
  if (first !== null && typeof first === 'object') {
    if (Number.isInteger(first.fd) && first.fd > 0) {
      return `file descriptor ${first.fd}, which is not checked before Node binds it`;
    }
    return beyondLoopback(first.address || undefined);
  }
  return beyondLoopback(typeof second === 'function' ? undefined : second);
}

/** Where a multicast membership call would leave `socket`, unless it is bound to loopback already. */
export function membershipRefusal(socket) {
  let bound;
  try {
    bound = socket.address();
  } catch (error) {
    // A closed socket: Node's own method refuses it (ERR_SOCKET_DGRAM_NOT_RUNNING) before libuv binds anything.
    return error?.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' ? undefined : 'that is not bound yet';
  }
  return isLoopbackAddress(bound?.address) ? undefined : `bound to ${bound?.address ?? 'an unknown address'}`;
}

/** A dgram socket's state, which Node keeps under a symbol: its libuv handle and bind state, or undefined. */
function udpState(socket) {
  for (const symbol of Object.getOwnPropertySymbols(socket)) {
    const value = socket[symbol];
    if (value !== null && typeof value === 'object' && 'handle' in value && 'bindState' in value) return value;
  }
  return undefined;
}

function refusal(message) {
  const error = new Error(`P-NET: ${message} (scripts/loopback-only.mjs).`);
  error.code = P_NET_CODE;
  return error;
}

/** Replace prototype[name] by wrap(original), marked, unless it is marked already. */
function guard(prototype, name, wrap) {
  const original = prototype[name];
  if (typeof original !== 'function' || original[GUARDED] === true) return;
  const guarded = wrap(original);
  guarded[GUARDED] = true;
  prototype[name] = guarded;
}

/** Make listen, bind and the membership calls refuse anything beyond loopback in this process. Once is enough. */
export function installLoopbackOnly() {
  guard(net.Server.prototype, 'listen', (nodeListen) => function listen(...args) {
    // Checked as Node will get it: a handle is refused as given, any other options object is read once (a snapshot).
    const handle = args[0] !== null && typeof args[0] === 'object' && isHandle(args[0]);
    const stable = handle ? args : stableListenArgs(args);
    const where = handle ? HANDLE : listenRefusal(stable);
    if (where !== undefined) {
      throw refusal(`refused to listen on ${where}; listen on 127.0.0.1 or ::1 instead. supertest gets a server already `
        + 'listening on 127.0.0.1 (listenLoopback), never an app');
    }
    return Reflect.apply(nodeListen, this, stable);
  });
  // After the lookup (dns.lookup, which a test can replace) and before Node binds: lib/net.js hands the address it will
  // bind to _listen2 (setupListenHandle), so that address is checked too. A pipe has port -1.
  guard(net.Server.prototype, '_listen2', (nodeListen2) => function _listen2(address, port, ...rest) {
    if (port !== -1 && !isLoopbackAddress(address)) {
      process.nextTick(() => this.emit('error', refusal(`refused to listen on ${address || 'every interface'}, the address `
        + 'the lookup gave; listen on 127.0.0.1 or ::1 instead, with a lookup that answers them as they are')));
      return;
    }
    return Reflect.apply(nodeListen2, this, [address, port, ...rest]);
  });
  guard(dgram.Socket.prototype, 'bind', (nodeBind) => function bind(...args) {
    const stable = stableBindArgs(args);
    const where = bindRefusal(stable);
    if (where !== undefined) {
      throw refusal(`refused to bind a UDP socket to ${where}; bind it to 127.0.0.1 or ::1 instead (send() and connect() `
        + 'bind an unbound socket to every interface, so bind it first)');
    }
    // The socket's lookup (dns.lookup, or dgram.createSocket's lookup option) turns even 127.0.0.1 into the address Node
    // binds, so for this bind its answer must be 127.0.0.1 or ::1 too; otherwise Node gets an error and binds nothing.
    const state = udpState(this);
    if (state === undefined || (state.handle && typeof state.handle.lookup !== 'function')) {
      throw refusal('refused to bind a UDP socket whose lookup cannot be checked on this Node (no dgram state or lookup '
        + 'found); bind it to 127.0.0.1 or ::1 on a Node whose dgram keeps them');
    }
    const { handle } = state;
    if (!handle) return Reflect.apply(nodeBind, this, stable); // Closed: Node refuses it itself.
    const lookup = handle.lookup;
    // lib/dgram.js binds the answer whenever the lookup's error is falsy (`if (err) { …emit('error'); return; }`), so it
    // is checked exactly then: a status such as 0, false or '' with another address is refused too. A truthy error is
    // Node's to report, as it is.
    handle.lookup = (address, callback) => Reflect.apply(lookup, handle, [address, (error, ip, ...rest) => {
      if (!error && !isLoopbackAddress(ip)) {
        callback(refusal(`refused to bind a UDP socket to ${typeof ip === 'string' ? ip : `a ${typeof ip}`}, which its `
          + `lookup gave for ${JSON.stringify(address)}; bind it to 127.0.0.1 or ::1 instead, with a lookup that answers `
          + 'them as they are'), ip, ...rest);
        return;
      }
      callback(error, ip, ...rest);
    }]);
    try {
      return Reflect.apply(nodeBind, this, stable);
    } finally {
      handle.lookup = lookup;
    }
  });
  for (const name of MEMBERSHIP) {
    guard(dgram.Socket.prototype, name, (nodeMethod) => ({
      [name](...args) {
        const where = membershipRefusal(this);
        if (where !== undefined) {
          throw refusal(`refused ${name}() on a UDP socket ${where}; bind it to 127.0.0.1 or ::1 first (libuv binds an `
            + 'unbound socket to every interface for it)');
        }
        return Reflect.apply(nodeMethod, this, args);
      },
    })[name]);
  }
}

/** Whether this process refuses listeners beyond loopback. */
export function loopbackOnlyInstalled() {
  const socket = dgram.Socket.prototype;
  return net.Server.prototype.listen[GUARDED] === true && net.Server.prototype._listen2?.[GUARDED] === true
    && socket.bind[GUARDED] === true
    && MEMBERSHIP.every((name) => typeof socket[name] !== 'function' || socket[name][GUARDED] === true);
}

installLoopbackOnly();
