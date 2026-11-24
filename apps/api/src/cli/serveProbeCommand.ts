import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { parseManifest, WebReleaseError } from '@finance-tracker/shared/web-release';

import { ControlError, EXIT, fail } from '../control/errors.js';
import { isCanonicalAbsolute } from '../control/paths.js';
import type { Io } from './controlCommon.js';

export const SERVE_PROBE_USAGE = 'Usage: npm run holdr-ingress -- serve-probe --origin <https://name> --token-file <file> --release-dir <dir>\n';

interface Answer { readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: Buffer; readonly reused: boolean }

/** Test seam (never a CLI flag): where to connect and which CA to trust; the TLS name and Host stay the origin's. */
export interface ProbeTransport { readonly host?: string; readonly port?: number; readonly ca?: string | Buffer }

/**
 * `holdr-ingress serve-probe` (design §8.2 step 11): end to end through the real HTTPS name, from this Mac (Serve accepts
 * its own connections). Six fixed probes on one keep-alive TLS connection to `P`, certificate verified, no redirects:
 * `GET /` equals the release's `index.html`; `GET /health` is exactly the production schema (`ok`, `schemaVersion`); the
 * service token on `/auth/me` is 401 (it is never evaluated on the socket); `Host: 127.0.0.1:4000` is 421; a cookie-less
 * `POST /auth/logout` with `Origin: P` and `X-Holdr-Request: 1` is 204; `HEAD /@vite/client` is 404 `not-found`. Prints
 * statuses only, never a body, header value or the token. Exit 0 only when every probe matches.
 */
export async function runServeProbe(argv: readonly string[], io: Io, transport: ProbeTransport = {}): Promise<number> {
  try {
    const options = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index];
      const value = argv[index + 1];
      if (!['--origin', '--token-file', '--release-dir'].includes(name) || value === undefined || options.has(name)) {
        throw new ControlError('E0I_USAGE', EXIT.usage, SERVE_PROBE_USAGE.trim());
      }
      options.set(name, value);
    }
    const origin = options.get('--origin');
    const tokenFile = options.get('--token-file');
    const releaseDir = options.get('--release-dir');
    if (!origin || !tokenFile || !releaseDir) throw new ControlError('E0I_USAGE', EXIT.usage, SERVE_PROBE_USAGE.trim());
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.port) fail('E0I_PUBLIC_ORIGIN', 'the origin must be https://<name>');
    if (!isCanonicalAbsolute(tokenFile) || !isCanonicalAbsolute(releaseDir)) fail('E0I_USAGE', 'absolute paths only', EXIT.usage);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(token)) fail('E0I_SERVE_PROBE', 'the service token file does not hold a token');
    const manifest = parseManifest(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    const index = manifest.files.find((file) => file.path === 'index.html');
    if (!index) fail('E0I_SERVE_PROBE', 'the release has no index.html');

    const host = url.hostname;
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    const request = (method: string, target: string, headers: Record<string, string> = {}, body?: string) => new Promise<Answer>((resolve, reject) => {
      const req = https.request({
        agent, method, path: target, host: transport.host ?? host, port: transport.port ?? 443, servername: host,
        ca: transport.ca, rejectUnauthorized: true, timeout: 10_000,
        headers: { Host: host, Accept: '*/*', ...headers, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) req.destroy(new Error('answer too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), reused: req.reusedSocket }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
    const results: Array<{ probe: string; ok: boolean; status: number }> = [];
    const check = async (probe: string, run: () => Promise<Answer>, expect: (answer: Answer) => boolean) => {
      try {
        const answer = await run();
        results.push({ probe, ok: expect(answer), status: answer.status });
      } catch {
        results.push({ probe, ok: false, status: 0 });
      }
    };
    try {
      await check('GET / = release index.html', () => request('GET', '/'),
        (a) => a.status === 200 && createHash('sha256').update(a.body).digest('hex') === index!.sha256);
      await check('GET /health = production schema', () => request('GET', '/health'), (a) => {
        if (a.status !== 200) return false;
        try {
          const value = JSON.parse(a.body.toString('utf8')) as Record<string, unknown>;
          return Object.keys(value).sort().join() === 'ok,schemaVersion' && value.ok === true && Number.isSafeInteger(value.schemaVersion);
        } catch { return false; }
      });
      await check('GET /auth/me with the service token = 401', () => request('GET', '/auth/me', { Authorization: `Bearer ${token}` }), (a) => a.status === 401);
      await check('GET / with Host 127.0.0.1:4000 = 421', () => request('GET', '/', { Host: '127.0.0.1:4000' }), (a) => a.status === 421);
      await check('POST /auth/logout without a session = 204', () => request('POST', '/auth/logout', {
        'Content-Type': 'application/json', Origin: origin, 'X-Holdr-Request': '1',
      }, '{}'), (a) => a.status === 204);
      await check('HEAD /@vite/client = 404 not-found', () => request('HEAD', '/@vite/client'),
        (a) => a.status === 404 && a.headers['x-holdr-error'] === 'not-found');
    } finally {
      agent.destroy();
    }
    for (const result of results) io.stdout.write(`serve-probe: ${result.ok ? 'ok  ' : 'FAIL'} ${result.probe} (status ${result.status || 'none'})\n`);
    if (results.some((result) => !result.ok)) fail('E0I_SERVE_PROBE', `${results.filter((result) => !result.ok).length} probe(s) failed`);
    return 0;
  } catch (error) {
    const code = error instanceof WebReleaseError ? error.code : (error as NodeJS.ErrnoException).code ? 'E0I_SERVE_PROBE' : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`serve-probe refused: ${code}${detail}\n`);
    return error instanceof ControlError ? error.exitCode : 1;
  }
}
