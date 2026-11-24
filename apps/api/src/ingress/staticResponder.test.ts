import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createWebIngress, etagMatches } from './staticResponder.js';
import { startIngressServers } from './server.js';
import { closeServers, rawRequest, releaseFixture, socketFixture, TEST_ADMISSION, TEST_ORIGIN } from './fixtures.js';
import { API_CSP, DOCUMENT_CSP } from './securityHeaders.js';

let release: ReturnType<typeof releaseFixture>;
let socket: ReturnType<typeof socketFixture>;
let servers: Server[];
let repo: SqliteStateRepo;
// Every test here runs after this beforeEach, which loads a verified release and listens on a Unix-domain socket: macOS
// and Linux only. On Windows the release directory is refused on mode bits (Node reports every directory as 0o666,
// whatever its NTFS ACL), and Node listens on a path there only as a named pipe (\\.\pipe\…).
const posixOnly = it.skipIf(process.platform === 'win32');
beforeEach(async () => {
  release = releaseFixture();
  socket = socketFixture();
  repo = new SqliteStateRepo({ file: ':memory:' });
  const { app } = createApp({
    repo, serviceToken: 'a'.repeat(64), allowedOrigins: [TEST_ORIGIN], snapshotsEnabled: false,
    ingress: { mode: 'dist', release: release.release, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
  });
  const mask = process.umask(0o077);
  try {
    servers = await startIngressServers(app, [{
      mode: 'dist', listener: 'ingress', socketPath: socket.socketPath, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION,
    }], { socketSafety: socket.safety });
  } finally { process.umask(mask); }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeServers(servers ?? []);
  repo.close();
  socket.cleanup();
  release.cleanup();
});

describe.skipIf(process.platform === 'win32')('manifest-only static responses', () => {
  it('serves every manifest file exactly, with the specified MIME/cache/security headers', async () => {
    for (const file of release.manifest.files) {
      const response = await rawRequest(socket.socketPath, 'GET', '/' + file.path);
      const memory = release.release.get('/' + file.path)!;
      expect(response.status).toBe(200);
      expect(response.body).toEqual(memory.bytes());
      expect(response.headers['content-length']).toBe(String(file.size));
      expect(response.headers['content-type']).toBe(memory.contentType);
      expect(response.headers.etag).toBe(memory.etag);
      expect(response.headers['accept-ranges']).toBe('none');
      expect(response.headers['last-modified']).toBeUndefined();
      expect(response.headers['cache-control']).toBe(file.path === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
      expect(response.headers['content-security-policy']).toBe(file.path === 'index.html' ? DOCUMENT_CSP : undefined);
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });
  it('has identical bodies/headers with credentials, no session lookup and no filesystem reads', async () => {
    const baseline = await rawRequest(socket.socketPath, 'GET', '/');
    const reads = vi.spyOn(fs, 'readFileSync');
    const original = await rawRequest(socket.socketPath, 'GET', '/', [
      ['Host', 'localhost'], ['X-Forwarded-Host', 'holdr.test'], ['X-Forwarded-Proto', 'https'],
      ['X-Forwarded-For', '100.64.0.1'], ['Cookie', '__Host-holdr_session=invalid'], ['Authorization', 'HoldrDevice synthetic'],
    ]);
    expect(original.body).toEqual(baseline.body);
    const { date: _a, ...a } = original.headers;
    const { date: _b, ...b } = baseline.headers;
    expect(a).toEqual(b);
    expect(reads).not.toHaveBeenCalled();
    expect(original.headers['set-cookie']).toBeUndefined();
  });
  it('serves the loaded bytes after disk changes; returned byte buffers cannot mutate memory', async () => {
    const entry = release.release.get('/index.html')!;
    const expected = entry.bytes();
    entry.bytes().fill(0);
    fs.unlinkSync(path.join(release.dir, 'public/index.html'));
    fs.symlinkSync('../manifest.json', path.join(release.dir, 'public/index.html'));
    expect((await rawRequest(socket.socketPath, 'GET', '/')).body).toEqual(expected);
  });
  it('works after the database becomes unavailable', async () => {
    repo.close();
    const read = vi.spyOn(repo, 'internalGetDb').mockImplementation(() => { throw Error('database unavailable'); });
    expect((await rawRequest(socket.socketPath, 'GET', '/')).status).toBe(200);
    expect((await rawRequest(socket.socketPath, 'GET', '/assets/app-123.js')).status).toBe(200);
    expect(read).not.toHaveBeenCalled();
  });
  it('HEAD has GET headers and zero body, including error body length/code', async () => {
    for (const target of ['/', '/assets/app-123.js', '/assets/missing.js', '/@fs/finance.db', '/%zz']) {
      const get = await rawRequest(socket.socketPath, 'GET', target);
      const head = await rawRequest(socket.socketPath, 'HEAD', target);
      expect(head.status).toBe(get.status);
      expect(head.headers['content-length']).toBe(get.headers['content-length']);
      expect(head.headers['content-type']).toBe(get.headers['content-type']);
      expect(head.headers['x-holdr-error']).toBe(get.headers['x-holdr-error']);
      expect(head.body.length).toBe(0);
    }
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses %s on files, without an HTML response', async (method) => {
    const response = await rawRequest(socket.socketPath, method, '/index.html');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
    expect(JSON.parse(response.body.toString())).toEqual({ error: 'method-not-allowed' });
    expect(response.headers['x-holdr-error']).toBe('method-not-allowed');
    expect(response.headers['content-security-policy']).toBe(API_CSP);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('implements weak If-None-Match for GET/HEAD and ignores dates and ranges', async () => {
    const etag = release.release.get('/index.html')!.etag;
    for (const field of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await rawRequest(socket.socketPath, method, '/', [
          ['Host', 'localhost'], ['X-Forwarded-Host', 'holdr.test'], ['X-Forwarded-Proto', 'https'],
          ['X-Forwarded-For', '100.64.0.1'], ['If-None-Match', field],
        ]);
        expect(response.status).toBe(304);
        expect(response.body.length).toBe(0);
        expect(response.headers.etag).toBe(etag);
        expect(response.headers['cache-control']).toBe('no-cache');
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    const response = await rawRequest(socket.socketPath, 'GET', '/', [
      ['Host', 'localhost'], ['X-Forwarded-Host', 'holdr.test'], ['X-Forwarded-Proto', 'https'],
      ['X-Forwarded-For', '100.64.0.1'], ['Range', 'bytes=0-1'], ['If-Modified-Since', 'Wed, 31 Dec 2099 00:00:00 GMT'],
    ]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(release.release.get('/index.html')!.bytes());
  });
});

posixOnly('parses ETag lists without accepting malformed fields or substrings', () => {
  for (const input of ['x"tag"', '"tag"x', '"tag",', 'W/ "tag"', '*, "tag"', 'garbage', '"other"']) {
    expect(etagMatches(input, '"tag"')).toBe(false);
  }
  expect(etagMatches('"has,comma", W/"tag"', '"tag"')).toBe(true);
  expect(etagMatches(undefined, '"tag"')).toBe(false);
  expect(typeof createWebIngress()).toBe('function');
});
