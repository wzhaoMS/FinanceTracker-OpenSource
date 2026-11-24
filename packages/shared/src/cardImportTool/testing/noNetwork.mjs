// A tripwire, not a sandbox. Preloaded by isolation.test.ts: the common Node entry points for opening a connection,
// resolving a name or starting a process (the list below) throw, so the card-import tool must run start to finish
// without trying them. Other ways stay open: worker threads, a net.Server built directly, dns.Resolver and the
// resolvers not listed, inspector, native addons, and file I/O on UNC paths.
// It is also a production preload, and a tripwire there too:
// holdr-retail-convert-owner-only (apps/api/src/cli/retailConvertOwnerOnly.ts) runs the retail converter under it.
// That command's tests pin this file's blob, so any change here needs a reviewed re-pin.
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const deny = (name) => () => {
  throw new Error(`blocked: ${name}`);
};
const targets = [
  [net, 'net', ['connect', 'createConnection', 'createServer']],
  [tls, 'tls', ['connect', 'createServer']],
  [dns, 'dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny']],
  [dns.promises, 'dns.promises', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [http, 'http', ['request', 'get', 'createServer']],
  [https, 'https', ['request', 'get', 'createServer']],
  [http2, 'http2', ['connect', 'createServer', 'createSecureServer']],
  [dgram, 'dgram', ['createSocket']],
  [childProcess, 'child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
];
for (const [module, label, names] of targets) for (const name of names) module[name] = deny(`${label}.${name}`);
net.Socket.prototype.connect = deny('net.Socket.connect');
globalThis.fetch = deny('fetch');
globalThis.WebSocket = deny('WebSocket');
syncBuiltinESMExports();
