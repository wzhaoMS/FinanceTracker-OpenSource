import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '@finance-tracker/shared/web-release/files';
import { loadWebRelease } from './webRelease.js';
import type { Server } from 'node:http';
import type { SocketSafety } from './server.js';
import type { IngressAdmission } from './types.js';

export const TEST_ORIGIN = 'https://holdr.test';
export const TEST_PORT = Number(process.env.HOLDR_TEST_API_PORT ?? 4115);
export const TEST_WEB_PORT = Number(process.env.HOLDR_TEST_WEB_PORT ?? 5315);
export const TEST_ADMISSION: IngressAdmission = { refusal: () => null };
export const SERVE_HEADERS: readonly (readonly [string, string])[] = [
  ['Host', 'localhost'], ['X-Forwarded-Host', 'holdr.test'], ['X-Forwarded-Proto', 'https'],
  ['X-Forwarded-For', '100.101.102.103'],
];
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function releaseFixture() {
  const dir = path.join(repo, 'apps/api/.test-tmp', `release-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'public/assets'), { recursive: true, mode: 0o700 });
  const contents = {
    'index.html': '<!doctype html><html><head><script type="module" crossorigin src="/assets/app-123.js"></script><link rel="stylesheet" crossorigin href="/assets/app-123.css"></head><body><div id="root"></div></body></html>\n',
    'assets/app-123.js': 'console.log("synthetic release");\n',
    'assets/app-123.css': 'body{color:green}\n',
    'assets/font-123.woff2': Buffer.from([0, 13, 0xff]),
    'assets/icon-123.png': Buffer.from([0, 13, 0xff]),
    'assets/icon-123.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'assets/icon-123.ico': Buffer.from([0, 13, 0xff]),
  };
  for (const [name, body] of Object.entries(contents)) fs.writeFileSync(path.join(dir, 'public', name), body);
  const built = buildManifest(path.join(dir, 'public'), 'a'.repeat(40));
  fs.writeFileSync(path.join(dir, 'manifest.json'), built.bytes);
  return { dir, ...built, release: loadWebRelease({ dir, digest: built.digest }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function socketFixture() {
  const dir = path.join(repo, `.i-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const socketPath = path.join(dir, 's');
  // Only for disposable test sockets; this is not the native ACL/attestation provider.
  // The mode check is POSIX-only: on Windows Node reports every directory as 0o666, whatever its NTFS ACL.
  const safety: SocketSafety = {
    async beforeListen(value) {
      if (value !== socketPath || fs.realpathSync(dir) !== dir
        || (process.platform !== 'win32' && (fs.lstatSync(dir).mode & 0o777) !== 0o700)) throw Error('unsafe fixture');
    },
    async afterListen(value) {
      if (value !== socketPath || !fs.lstatSync(socketPath).isSocket()) throw Error('invalid fixture socket');
    },
  };
  return { dir, socketPath, safety, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export async function closeServers(servers: readonly Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
}

export async function rawRequest(target: number | string, method: string, url: string,
  headers: readonly (readonly [string, string])[] = SERVE_HEADERS, body = '') {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const socket = typeof target === 'number' ? net.connect(target, '127.0.0.1') : net.connect(target);
    const chunks: Buffer[] = [];
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      const response = Buffer.concat(chunks);
      const split = response.indexOf('\r\n\r\n');
      const lines = response.subarray(0, split).toString('latin1').split('\r\n');
      const status = Number(lines.shift()?.split(' ')[1]);
      const responseHeaders = Object.fromEntries(lines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      if (!status || split < 0) return reject(new Error('incomplete HTTP response'));
      resolve({ status, headers: responseHeaders, body: response.subarray(split + 4) });
    });
    socket.write(`${method} ${url} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join('')}Connection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
}
