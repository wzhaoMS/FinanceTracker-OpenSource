import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.resolve(here, '..', '..', '..', '..', 'scripts', 'e2e-offline-fetch.mjs');
const PROBE = path.join(here, 'offlineProbe.mjs');

/** Client transports whose loopback fixture shows whether they got through. */
const TCP_TRANSPORTS = [
  'fetch', 'http.request', 'http.get', 'new http.ClientRequest', 'https.request', 'net.createConnection',
  'tls.connect', 'http2.connect', 'raw TCP handle', 'WebSocket',
];
const NETWORK_TRANSPORTS = [
  ...TCP_TRANSPORTS, 'net.connect (unix socket)', 'dgram send', 'dns.Resolver', 'dns.promises.Resolver',
];
const UNDICI_RESOLVABLE = (() => {
  try {
    createRequire(import.meta.url).resolve('undici');
    return true;
  } catch {
    return false;
  }
})();

interface Outcome { outcome: string; detail: string }
interface Seen { tcp: number; unix: number; udp: number; dns: number }

describe('e2e offline preload (scripts/e2e-offline-fetch.mjs)', () => {
  let dir: string;
  const seen: Seen = { tcp: 0, unix: 0, udp: 0, dns: 0 };
  // Answer, then close: on Windows, Node's fetch and WebSocket (undici) can
  // wait forever on a connection that is dropped unanswered.
  const tcp = net.createServer((socket) => {
    seen.tcp += 1;
    socket.on('error', () => {});
    socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  });
  const unix = net.createServer((socket) => { seen.unix += 1; socket.destroy(); });
  const udp = dgram.createSocket('udp4').on('message', () => { seen.udp += 1; });
  const nameServer = dgram.createSocket('udp4').on('message', () => { seen.dns += 1; });

  beforeAll(async () => {
    dir = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-e2e-offline-')));
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    // A relative socket path stays under the platform's length limit; the
    // probe resolves it from the same directory. listen() binds synchronously.
    // Windows has named pipes instead of socket files; the probe connects to either.
    const previous = process.cwd();
    process.chdir(dir);
    try {
      if (process.platform === 'win32') unix.listen(`\\\\.\\pipe\\ft-e2e-offline-${process.pid}`);
      else unix.listen('probe.sock');
    } finally {
      process.chdir(previous);
    }
    await new Promise<void>((resolve) => unix.once('listening', resolve));
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => nameServer.bind(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    tcp.close();
    unix.close();
    udp.close();
    nameServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function probe(withPreload: boolean, only: string[]) {
    const before = { ...seen };
    const config = {
      tcpPort: (tcp.address() as net.AddressInfo).port,
      udpPort: udp.address().port,
      dnsPort: nameServer.address().port,
      pipe: unix.address() as string,
      only,
    };
    // A file URL, as the runner passes it: --import reads C:\... as a URL with the scheme c:.
    const args = [...(withPreload ? ['--import', pathToFileURL(PRELOAD).href] : []), PROBE, JSON.stringify(config)];
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { cwd: dir, timeout: 30_000 });
    // Let late connections and datagrams reach the fixtures before counting.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      results: JSON.parse(stdout) as Record<string, Outcome>,
      seen: {
        tcp: seen.tcp - before.tcp,
        unix: seen.unix - before.unix,
        udp: seen.udp - before.udp,
        dns: seen.dns - before.dns,
      },
      log: stderr,
    };
  }

  it('control: without the preload every transport reaches its loopback fixture', async () => {
    const { results, seen: reached } = await probe(false, NETWORK_TRANSPORTS);
    for (const name of NETWORK_TRANSPORTS) {
      expect(results[name]?.outcome, `${name}: ${results[name]?.detail}`).toBe('reached');
    }
    expect(reached.tcp).toBeGreaterThanOrEqual(TCP_TRANSPORTS.length);
    expect(reached.unix).toBeGreaterThanOrEqual(1);
    expect(reached.udp).toBeGreaterThanOrEqual(1);
    expect(reached.dns).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('refuses every outbound transport: no fixture sees a connection, datagram or query', async () => {
    const { results, seen: reached, log } = await probe(true, [
      ...NETWORK_TRANSPORTS, 'dns.lookup', 'undici', 'inbound listen', 'dns.lookup localhost',
    ]);
    for (const name of [...NETWORK_TRANSPORTS, 'dns.lookup']) {
      expect(results[name]?.outcome, `${name}: ${results[name]?.detail}`).toBe('refused');
    }
    expect(results.undici?.outcome).toBe(UNDICI_RESOLVABLE ? 'refused' : 'unavailable');
    expect(reached).toEqual({ tcp: 0, unix: 0, udp: 0, dns: 0 });
    expect(log).toContain('[e2e-offline] blocked outbound request to 127.0.0.1:');
    // The API still listens and resolves loopback names.
    expect(results['inbound listen']?.outcome).toBe('allowed');
    expect(results['dns.lookup localhost']?.outcome).toBe('allowed');
  }, 60_000);
});
