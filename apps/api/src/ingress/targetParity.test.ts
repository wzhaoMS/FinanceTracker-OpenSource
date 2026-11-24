import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { parseIngressTarget } from './requestTarget.js';

const acceptance = [
  '/', '/index.html?raw', '/HEALTH/', '/ACCOUNTS/abc', '/health;x', '/symbols/%5EGSPC/history',
  '/accounts/a%20b', '/accounts/%E2%82%AC', '/accounts/a!$&\'()*+,;=:@-._~',
  '/health?q=a|b', '/health?%zz', '/health?%5C', '/health?x=1?y=2',
];

it('has zero gaps against the actual #13 parser on all 139,046 deterministic prototype targets', async () => {
  const modulePath = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/requestTarget.ts')).href;
  const { parseRequestTarget } = await import(/* @vite-ignore */ modulePath) as {
    parseRequestTarget(value: string): unknown;
  };
  const hand = ['/', '/health', '/health?x=1', '/health?a\\b', '/?\\', '/x\\y', '/__open-in-editor', '/__open-in-editor?file=/etc/passwd',
    '/__OPEN-IN-EDITOR', '/__open-in-editorX', '/%5F_open-in-editor', '/./__open-in-editor', '/a/../__open-in-editor', '/@fs/etc/passwd',
    '/@vite/client', '/accounts/a%2Fb', '/accounts/%2e%2e', '/%C0%AE', '/a#b', '/a?b#c', '//x', '/a//b', '/a/', '/assets/index-abc.js',
    '/health;x', '/HEALTH', '/a%20b', '/a%3Bb', '/%41', '/a?%zz', '/a?%5C'];
  let seed = 0x5eed;
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const pieces = ['/', '/', '/', 'a', 'B', '.', '..', '%2F', '%5c', '%25', '%2e', '%41', '%C0%AE', '%E2%82%AC', '%3B', '%zz', '%', '\\', '#', '?', '?', '=', '&',
    ';', ':', '@', '~', '_', '__open-in-editor', '__OPEN-in-editor', '@fs', 'health', 'auth', '"', '{', '|', '^', '`', '<', "'", '!', '$', '*', '+', ','];
  const corpus = new Set(hand);
  for (let i = 0; i < 200_000; i++) {
    let target = '/';
    const n = 1 + rnd(7);
    for (let k = 0; k < n; k++) target += pieces[rnd(pieces.length)];
    corpus.add(target);
  }
  expect(corpus.size).toBe(139_046);
  const gaps: string[] = [];
  for (const target of corpus) {
    if (parseRequestTarget(target) === undefined && !('refuse' in parseIngressTarget(target))) gaps.push(target);
  }
  expect(gaps).toEqual([]);
  for (const target of acceptance) {
    expect(parseRequestTarget(target), target).not.toBeUndefined();
    expect(parseIngressTarget(target), target).not.toHaveProperty('refuse');
  }
});
