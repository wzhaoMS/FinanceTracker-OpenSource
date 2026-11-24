// Preloaded into the disposable e2e API (`node --import`) by
// scripts/e2e-disposable.mjs. The API may not open any outbound connection,
// to any host, loopback included, so no market-data provider, broker bridge
// or other local service can feed the run and no redirect can lead anywhere.
// Connections are refused where they are created:
//   - net.Socket.prototype.connect, which net.connect/createConnection, http
//     and https (request, get, new http.ClientRequest), tls.connect, http2
//     and undici (Node's fetch and WebSocket) all go through, before any DNS
//     lookup;
//   - the TCP and pipe handles below net.Socket and the UDP handle below
//     dgram, for code that bypasses those classes;
//   - dgram sockets, http2.connect, DNS queries (IP literals and localhost
//     still resolve, locally), fetch and WebSocket, refused up front.
// Inbound sockets are untouched: the API still listens on its port.
// apps/api/src/e2e/offlinePreload.test.ts probes every transport.
import dgram from 'node:dgram';
import dns from 'node:dns';
import http2 from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';

const reported = new Set();

/** The error for a refused attempt; each target is logged once. */
function refusal(target, ErrorClass = Error) {
  if (!reported.has(target)) {
    reported.add(target);
    console.warn(`[e2e-offline] blocked outbound request to ${target}`);
  }
  const error = new ErrorClass(`outbound requests are disabled for the disposable e2e stack (${target})`);
  error.code = 'E2E_OFFLINE';
  return error;
}

function hostOf(target) {
  try {
    if (typeof Request === 'function' && target instanceof Request) return new URL(target.url).host;
    if (typeof target === 'string' || target instanceof URL) return new URL(String(target)).host;
    if (target && typeof target === 'object') {
      return `${target.hostname ?? target.host ?? 'localhost'}${target.port ? `:${target.port}` : ''}`;
    }
  } catch {
    // Unparseable targets are refused all the same.
  }
  return 'an unknown host';
}

/** Where net.Socket#connect was asked to go: (options), (port, host) or (path). */
function connectTarget(args) {
  let [first, second] = args;
  if (Array.isArray(first)) [first, second] = first; // net's internal [options, callback]
  if (first && typeof first === 'object') {
    if (first.path) return String(first.path);
    return `${first.host ?? first.hostname ?? 'localhost'}:${first.port}`;
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return first;
  return `${typeof second === 'string' ? second : 'localhost'}:${first}`;
}

net.Socket.prototype.connect = function offlineConnect(...args) {
  const error = refusal(connectTarget(args));
  process.nextTick(() => this.destroy(error));
  return this;
};

// Below net and dgram: libuv handles report failures as negative errno values.
const EACCES = -os.constants.errno.EACCES;
function refuseHandle(bindingName, className, methods, describe) {
  let prototype;
  try {
    // Deprecated (DEP0111, documentation-only), but the only way to reach these.
    prototype = process.binding(bindingName)[className]?.prototype;
  } catch {
    return; // Gone from this Node: the public APIs above are still covered.
  }
  for (const method of methods) {
    if (typeof prototype?.[method] !== 'function') continue;
    prototype[method] = function offlineHandle(...args) {
      refusal(describe(method, args));
      return EACCES;
    };
  }
}
refuseHandle('tcp_wrap', 'TCP', ['connect', 'connect6'], (_, [, address, port]) => `${address}:${port}`);
refuseHandle('pipe_wrap', 'Pipe', ['connect'], (_, [, address]) => String(address));
refuseHandle('udp_wrap', 'UDP', ['connect', 'connect6', 'send', 'send6'], (method, args) => (method.startsWith('connect')
  ? `udp ${args[0]}:${args[1]}`
  : `udp ${args.length >= 5 ? `${args[4]}:${args[3]}` : 'connected peer'}`));

for (const method of ['bind', 'connect', 'send']) {
  dgram.Socket.prototype[method] = function offlineDgram() {
    throw refusal(`udp (dgram ${method})`);
  };
}

http2.connect = function offlineHttp2Connect(authority) {
  throw refusal(hostOf(authority));
};

// DNS: a lookup of an IP literal or localhost never leaves the machine; any
// other name, and every query to a name server, is refused.
const resolvesLocally = (hostname) => typeof hostname === 'string'
  && (net.isIP(hostname) !== 0 || /^localhost\.?$/i.test(hostname));
const realLookup = dns.lookup;
dns.lookup = function offlineLookup(hostname, ...rest) {
  if (resolvesLocally(hostname)) return realLookup.call(this, hostname, ...rest);
  const callback = rest.find((value) => typeof value === 'function');
  const error = refusal(`dns ${hostname}`);
  if (!callback) throw error;
  process.nextTick(callback, error);
  return {};
};
const realPromisedLookup = dns.promises.lookup;
dns.promises.lookup = async function offlineLookup(hostname, ...rest) {
  if (resolvesLocally(hostname)) return realPromisedLookup.call(this, hostname, ...rest);
  throw refusal(`dns ${hostname}`);
};
const QUERY_METHOD = /^(resolve\w*|reverse|lookupService)$/;
function refuseQueries(holder, promised) {
  for (const name of Object.getOwnPropertyNames(holder)) {
    if (!QUERY_METHOD.test(name) || typeof holder[name] !== 'function') continue;
    holder[name] = promised
      ? async function offlineQuery(target) { throw refusal(`dns ${target}`); }
      : function offlineQuery(target, ...rest) {
        const callback = rest.findLast((value) => typeof value === 'function');
        const error = refusal(`dns ${target}`);
        if (!callback) throw error;
        process.nextTick(callback, error);
        return undefined;
      };
  }
}
refuseQueries(dns, false);
refuseQueries(dns.Resolver.prototype, false);
refuseQueries(dns.promises, true);
refuseQueries(dns.promises.Resolver.prototype, true);

globalThis.fetch = async function offlineFetch(input) {
  throw refusal(hostOf(input), TypeError);
};

if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = class OfflineWebSocket {
    constructor(url) {
      throw refusal(hostOf(url));
    }
  };
}

// ESM named imports of builtins (`import { connect } from 'node:http2'`) see the patches too.
syncBuiltinESMExports();
