import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOLDR_API_PATH_PREFIXES } from '@finance-tracker/shared';
import { classifyPath } from './classify.js';
import { parseIngressTarget } from './requestTarget.js';
import { releaseFixture } from './fixtures.js';

let fixture: ReturnType<typeof releaseFixture>;
beforeAll(() => { fixture = releaseFixture(); });
afterAll(() => fixture.cleanup());
function classify(method: string, target: string, withRelease = true) {
  const parsed = parseIngressTarget(target);
  if ('refuse' in parsed) throw Error(`invalid test vector: ${target}`);
  return classifyPath(method, parsed, withRelease ? fixture.release : undefined).kind;
}

// The beforeAll above loads a verified release, which Windows refuses on mode bits (Node reports every directory as
// 0o666, whatever its NTFS ACL): macOS and Linux only. With every test skipped there, vitest skips the beforeAll too.
describe.skipIf(process.platform === 'win32')('C1–C5 exact dispatcher classification', () => {
  it('counts card sync among the API prefixes', () => {
    expect(HOLDR_API_PATH_PREFIXES).toContain('card-sync');
  });
  it.each([...HOLDR_API_PATH_PREFIXES])('keeps every %s case/trailing-slash/method variant in the API', (prefix) => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const target of [`/${prefix}`, `/${prefix.toUpperCase()}/`, `/${prefix}/unknown/path?x=1`]) {
        expect(classify(method, target)).toBe('api');
      }
    }
  });
  it.each(['/', '/?raw', '/index.html', '/index.html?raw'])('serves only explicit document %s', (target) => {
    expect(classify('GET', target)).toBe('document');
    expect(classify('HEAD', target)).toBe('document');
    expect(classify('POST', target)).toBe('method-not-allowed');
    expect(classify('GET', target, false)).toBe('not-found');
  });
  it.each(['/assets/app-123.js', '/assets/app-123.js?raw', '/assets/app-123.css', '/assets/font-123.woff2'])('serves exact asset %s', (target) => {
    expect(classify('GET', target)).toBe('asset');
    expect(classify('HEAD', target)).toBe('asset');
    expect(classify('OPTIONS', target)).toBe('method-not-allowed');
    expect(classify('GET', target, false)).toBe('not-found');
  });
  it.each([
    '/foo', '/foo/bar', '/assets', '/assets/', '/ASSETS/app-123.js', '/assets/app-123.JS', '/assets/app-123.js/',
    '/assets/app-123.js.map', '/INDEX.HTML', '/index.html/', '/@fs', '/@fs/finance.db', '/@vite/client', '/@id/react',
    '/@react-refresh', '/__vite_ping', '/node_modules/react/package.json', '/src/main.tsx', '/.env', '/.env.local',
    '/.git/config', '/apps/api/data/finance.db', '/finance.db', '/finance.db-wal', '/finance.db-shm', '/backups/db/x.zip',
    '/FinanceTracker.tgz', '/service-token', '/vite.config.ts', '/package.json', '/manifest.json', '/public/index.html',
    '/favicon.ico', '/robots.txt', '/accounts;x', '/accountsmith',
  ])('never turns %s into HTML or a route prefix', (target) => {
    expect(classify('GET', target)).toBe('not-found');
    expect(classify('POST', target)).toBe('not-found');
  });
});
