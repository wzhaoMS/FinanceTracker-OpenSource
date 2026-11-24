// Outbound-connection probe for offlinePreload.test.ts. It tries every client
// transport Node offers against loopback fixtures and prints one JSON object
// mapping each transport to { outcome, detail }:
//
//   refused      the e2e offline preload stopped it (its error, or EACCES from
//                a raw handle) before anything was sent
//   reached      it connected or failed in some other way after trying
//   allowed      a local operation the API needs (listening, resolving
//                localhost) worked
//   unavailable  this Node or repo lacks it (e.g. the undici package)
//   timeout      nothing happened within the time limit
//
//   node [--import scripts/e2e-offline-fetch.mjs] offlineProbe.mjs '<json>'
//   json: { "tcpPort": n, "udpPort": n, "dnsPort": n, "pipe": "relative/path" or "\\.\pipe\name" (Windows), "only": [names]? }
//
// P-NET: whatever it binds is on 127.0.0.1. Its UDP socket is bound there before it sends (send() binds an unbound
// socket to every interface), and its resolvers send from there.
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import '../../../../scripts/loopback-only.mjs';

const config = JSON.parse(process.argv[2] ?? '{}');
const HOST = '127.0.0.1';
const LIMIT_MS = 3_000;
const EACCES = -os.constants.errno.EACCES;

const isRefusal = (error) => error?.code === 'E2E_OFFLINE'
  || /outbound requests are disabled/.test(`${error?.message ?? ''} ${error?.cause?.message ?? ''}`);
const settleWith = (error, fallback = 'error') => (isRefusal(error)
  ? { outcome: 'refused', detail: error.message }
  : { outcome: 'reached', detail: error ? `${error.code ?? error.name}: ${error.message}` : fallback });

/** Resolve with the first event of `emitter` among `events`, as an outcome. */
function firstEvent(emitter, events) {
  return new Promise((resolve) => {
    for (const event of events) {
      emitter.once(event, (value) => resolve(event === 'error' ? settleWith(value) : { outcome: 'reached', detail: event }));
    }
  });
}

const tcpUrl = (scheme) => `${scheme}://${HOST}:${config.tcpPort}/probe`;

const transports = {
  async fetch() {
    try {
      const response = await fetch(tcpUrl('http'));
      return { outcome: 'reached', detail: `status ${response.status}` };
    } catch (error) {
      return settleWith(error);
    }
  },
  'http.request'() {
    const request = http.request({ host: HOST, port: config.tcpPort, path: '/probe' });
    request.end();
    return firstEvent(request, ['response', 'error']);
  },
  'http.get'() {
    return firstEvent(http.get({ host: HOST, port: config.tcpPort, path: '/probe' }), ['response', 'error']);
  },
  'new http.ClientRequest'() {
    const request = new http.ClientRequest({ host: HOST, port: config.tcpPort, path: '/probe' });
    request.end();
    return firstEvent(request, ['response', 'error']);
  },
  'https.request'() {
    const request = https.request({ host: HOST, port: config.tcpPort, path: '/probe', rejectUnauthorized: false });
    request.end();
    return firstEvent(request, ['response', 'error']);
  },
  'net.createConnection'() {
    return firstEvent(net.createConnection({ host: HOST, port: config.tcpPort }), ['connect', 'error']);
  },
  'net.connect (unix socket)'() {
    return firstEvent(net.connect({ path: config.pipe }), ['connect', 'error']);
  },
  'tls.connect'() {
    return firstEvent(tls.connect({ host: HOST, port: config.tcpPort, rejectUnauthorized: false }), ['secureConnect', 'error']);
  },
  'http2.connect'() {
    try {
      const session = http2.connect(`http://${HOST}:${config.tcpPort}`);
      return firstEvent(session, ['connect', 'error', 'close']);
    } catch (error) {
      return settleWith(error);
    }
  },
  'dgram send'() {
    const socket = dgram.createSocket('udp4');
    return new Promise((resolve) => {
      const send = () => {
        try {
          socket.send(Buffer.from('probe'), config.udpPort, HOST, (error) => resolve(settleWith(error, 'sent')));
        } catch (error) {
          resolve(settleWith(error));
        }
      };
      socket.once('error', (error) => resolve(settleWith(error)));
      try {
        socket.bind(0, HOST, send);
      } catch (error) {
        // The preload refuses the bind too; send() must still be refused, on the socket that bind left unbound.
        if (isRefusal(error)) send();
        else resolve(settleWith(error));
      }
    }).finally(() => {
      try { socket.close(); } catch { /* never bound */ }
    });
  },
  'dns.Resolver'() {
    const resolver = new dns.Resolver({ timeout: 300, tries: 1 });
    resolver.setLocalAddress(HOST);
    resolver.setServers([`${HOST}:${config.dnsPort}`]);
    return new Promise((resolve) => {
      try {
        resolver.resolve4('probe.e2e.invalid', (error) => resolve(settleWith(error, 'answered')));
      } catch (error) {
        resolve(settleWith(error));
      }
    });
  },
  async 'dns.promises.Resolver'() {
    const resolver = new dns.promises.Resolver({ timeout: 300, tries: 1 });
    resolver.setLocalAddress(HOST);
    resolver.setServers([`${HOST}:${config.dnsPort}`]);
    try {
      await resolver.resolve4('probe.e2e.invalid');
      return { outcome: 'reached', detail: 'answered' };
    } catch (error) {
      return settleWith(error);
    }
  },
  // Asks the system resolver, so only probed where the preload is expected to stop it.
  'dns.lookup'() {
    return new Promise((resolve) => {
      try {
        dns.lookup('probe.e2e.invalid', (error) => resolve(settleWith(error, 'resolved')));
      } catch (error) {
        resolve(settleWith(error));
      }
    });
  },
  'raw TCP handle'() {
    let binding;
    try {
      binding = process.binding('tcp_wrap');
    } catch {
      return { outcome: 'unavailable', detail: 'process.binding is not available' };
    }
    const { TCP, TCPConnectWrap, constants } = binding;
    const handle = new TCP(constants.SOCKET);
    const request = new TCPConnectWrap();
    return new Promise((resolve) => {
      request.oncomplete = (status) => {
        handle.close();
        resolve({ outcome: 'reached', detail: `connect completed with status ${status}` });
      };
      const status = handle.connect(request, HOST, config.tcpPort);
      if (status !== 0) {
        handle.close();
        resolve(status === EACCES
          ? { outcome: 'refused', detail: `TCP handle connect returned EACCES (${status})` }
          : { outcome: 'reached', detail: `TCP handle connect returned ${status}` });
      }
    });
  },
  WebSocket() {
    if (typeof globalThis.WebSocket !== 'function') return { outcome: 'unavailable', detail: 'no global WebSocket' };
    try {
      const socket = new WebSocket(tcpUrl('ws'));
      return new Promise((resolve) => {
        socket.addEventListener('open', () => resolve({ outcome: 'reached', detail: 'open' }));
        socket.addEventListener('error', (event) => resolve(settleWith(event.error, 'error event')));
      });
    } catch (error) {
      return settleWith(error);
    }
  },
  async undici() {
    let undici;
    try {
      undici = await import('undici');
    } catch {
      return { outcome: 'unavailable', detail: 'the undici package is not resolvable here' };
    }
    try {
      const response = await undici.request(tcpUrl('http'));
      return { outcome: 'reached', detail: `status ${response.statusCode}` };
    } catch (error) {
      return settleWith(error);
    }
  },
  // What the API itself needs must keep working.
  'inbound listen'() {
    const server = net.createServer();
    return new Promise((resolve) => {
      server.once('error', (error) => resolve(settleWith(error)));
      server.listen(0, HOST, () => server.close(() => resolve({ outcome: 'allowed', detail: 'listened on a loopback port' })));
    });
  },
  'dns.lookup localhost'() {
    return new Promise((resolve) => {
      try {
        dns.lookup('localhost', (error, address) => resolve(error
          ? settleWith(error)
          : { outcome: 'allowed', detail: `resolved to ${address}` }));
      } catch (error) {
        resolve(settleWith(error));
      }
    });
  },
};

/**
 * `attempt`, or a timeout after LIMIT_MS. The timer keeps the probe alive
 * until one of them, so a transport that never settles is reported as a
 * timeout instead of the probe exiting early with an unsettled await and
 * nothing printed; it is cleared as soon as the attempt settles.
 */
function withinLimit(attempt) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout', detail: `nothing within ${LIMIT_MS}ms` }), LIMIT_MS);
  });
  return Promise.race([Promise.resolve().then(attempt), limit]).finally(() => clearTimeout(timer));
}

const results = {};
for (const [name, attempt] of Object.entries(transports)) {
  if (config.only && !config.only.includes(name)) continue;
  try {
    results[name] = await withinLimit(attempt);
  } catch (error) {
    results[name] = settleWith(error);
  }
}
// Exit once the results are written: a pipe may still be taking them.
process.stdout.write(`${JSON.stringify(results)}\n`, () => process.exit(0));
