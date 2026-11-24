import { SERVE_HEADERS, TEST_PORT } from './fixtures.js';

export interface IngressProbe {
  method: string;
  target: string;
  status: number;
  code?: string;
  listener: 'serve' | 'direct';
  headers: readonly (readonly [string, string])[];
}

/** The 87 revision-1 probes, with revision-4 socket profiles and the real API's CSRF oracle. */
export function ingressProbes(js: string, css: string): IngressProbe[] {
  const probe = (method: string, target: string, status: number, code?: string,
    headers = SERVE_HEADERS, listener: 'serve' | 'direct' = 'serve'): IngressProbe => ({ method, target, status, code, headers, listener });
  const get = (target: string, status: number, code?: string) => probe('GET', target, status, code);
  const local = [['Host', `127.0.0.1:${TEST_PORT}`]] as const;
  const replace = (key: string, value?: string) => [
    ...SERVE_HEADERS.filter(([name]) => name.toLowerCase() !== key.toLowerCase()),
    ...(value === undefined ? [] : [[key, value] as const]),
  ];
  const encodedName = js.replace(/\/([^/]+)$/, (_match, name: string) => `/%${name.charCodeAt(0).toString(16)}${name.slice(1)}`);
  return [
    get('/', 200), probe('HEAD', '/', 200), get('/index.html', 200), get('/?x=1', 200), get(js, 200), get(css, 200),
    get(js.toUpperCase(), 404, 'not-found'), get(`${js}/`, 404, 'not-found'),
    get(js.replace('/assets/', '/assets//'), 400, 'empty-path-segment'),
    get(js.replace('/assets/', '/%61ssets/'), 400, 'non-canonical-escape'),
    get(encodedName, 400, 'non-canonical-escape'), get(`${js}.map`, 404, 'not-found'),
    probe('POST', '/', 405, 'method-not-allowed'), probe('OPTIONS', '/', 405, 'method-not-allowed'), probe('DELETE', js, 405, 'method-not-allowed'),
    ...['/assets/', '/assets', '/foo', '/foo/bar', '/favicon.ico', '/robots.txt',
      '/@fs/Users/sample1/Holdr/FinanceTracker/apps/api/data/finance.db',
      '/@vite/client', '/@id/react', '/@react-refresh', '/__open-in-editor?file=/etc/passwd',
      '/__OPEN-IN-EDITOR', '/node_modules/react/package.json', '/src/main.tsx'].map((target) => get(target, 404, 'not-found')),
    get('/index.html?raw', 200),
    ...['/.env', '/.git/config', '/apps/api/data/finance.db', '/finance.db-wal', '/backups/20261016/finance.db',
      '/FinanceTracker.tgz', '/service-token', '/vite.config.ts', '/package.json', '/manifest.json', '/public/index.html']
      .map((target) => get(target, 404, 'not-found')),
    get('/health', 200), get('/HEALTH/', 200),
    ...['/accounts', '/accounts/abc', '/ACCOUNTS/abc', '/accounts/x/y/z', '/card-sync/capabilities', '/card-sync/owner/state']
      .map((target) => get(target, 401)),
    probe('OPTIONS', '/card-sync/runs', 401), get('/export', 401), probe('POST', '/card-imports/preview', 403),
    get('/accounts//abc', 400, 'empty-path-segment'), get('/accounts/./abc', 400, 'dot-segment'),
    get('/accounts/../health', 400, 'dot-segment'), get('/accounts/%2e%2e', 400, 'non-canonical-escape'),
    get('/accounts/a%2Fb', 400, 'forbidden-escape'), get('/accounts/a%5Cb', 400, 'forbidden-escape'),
    get('/accounts/a%00b', 400, 'forbidden-escape'), get('/accounts/%C0%AE', 400, 'bad-percent-encoding'),
    get('/accounts/%zz', 400, 'bad-percent-encoding'), get('/accounts/%25', 400, 'forbidden-escape'),
    get('/%68ealth', 400, 'non-canonical-escape'), get('/symbols/%5EGSPC/history', 401),
    get('/accounts/a"b', 400, 'request-target-chars'), get('/accounts/a|b', 400, 'request-target-chars'),
    get('/health?q=a|b', 200), get('/accounts/%01', 400, 'forbidden-escape'),
    get('http://holdr.test/health', 400, 'request-target-form'), get('*', 400, 'request-target-form'),
    get('/health#x', 400, 'request-target-chars'), get('/' + 'a'.repeat(3000), 414, 'uri-too-long'),
    probe('GET', '/', 404, 'not-found', local, 'direct'), probe('GET', '/health', 200, undefined, local, 'direct'),
    probe('GET', '/', 404, 'not-found', [['Host', `localhost:${TEST_PORT}`]], 'direct'),
    probe('GET', '/', 404, 'not-found', [['Host', '127.0.0.1:4000']], 'direct'),
    probe('GET', '/', 421, 'misdirected-request', [['Host', 'holdr.test']]),
    probe('GET', '/', 400, 'proxied-request-refused', [...local, ['X-Forwarded-For', '100.1.1.1']], 'direct'),
    probe('GET', '/', 400, 'proxied-request-refused', [
      ...local, ['X-Forwarded-Host', `127.0.0.1:${TEST_PORT}`], ['X-Forwarded-Proto', 'https'], ['X-Forwarded-For', '100.1.1.1'],
    ], 'direct'),
    probe('GET', '/', 421, 'misdirected-request', replace('Host', 'evil.example')),
    probe('GET', '/', 400, 'forwarding-headers-invalid', replace('X-Forwarded-Proto')),
    probe('GET', '/', 400, 'forwarding-headers-invalid', replace('X-Forwarded-For', '100.1.1.1, 10.0.0.1')),
    probe('GET', '/', 403, 'funnel-refused', [...SERVE_HEADERS, ['Tailscale-Funnel-Request', '?1']]),
    probe('GET', '/', 400, 'forwarding-headers-invalid', [...SERVE_HEADERS, ['X-Real-IP', '1.2.3.4']]),
    probe('GET', '/', 400, 'host-invalid', [...SERVE_HEADERS, ['Host', `127.0.0.1:${TEST_PORT}`]]),
    probe('GET', '/', 200, undefined, replace('X-Forwarded-Host', 'HOLDR.TEST')),
    probe('GET', '/', 400, 'upgrade-not-supported', [...SERVE_HEADERS, ['Upgrade', 'websocket'], ['Connection', 'Upgrade']]),
  ];
}
