import { describe, expect, it } from 'vitest';
import { parseIngressTarget } from './requestTarget.js';

export const ACCEPTED_TARGETS = [
  '/', '/index.html?raw', '/HEALTH/', '/ACCOUNTS/abc', '/health;x', '/symbols/%5EGSPC/history',
  '/accounts/a%20b', '/accounts/%E2%82%AC', '/accounts/a!$&\'()*+,;=:@-._~',
  '/health?q=a|b', '/health?%zz', '/health?%5C', '/health?x=1?y=2',
];

describe('T1–T7 pre-routing target parser', () => {
  it.each(ACCEPTED_TARGETS)('preserves accepted target %s exactly', (target) => {
    const parsed = parseIngressTarget(target);
    expect(parsed).not.toHaveProperty('refuse');
    if ('refuse' in parsed) return;
    expect(parsed.rawPath + parsed.query).toBe(target);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.segments)).toBe(true);
  });

  it.each([
    [undefined, 400, 'request-target-form'], ['', 400, 'request-target-form'],
    ['http://evil.example/health', 400, 'request-target-form'], ['HTTP://x/accounts/abc', 400, 'request-target-form'],
    ['http://[fe80::1%25lo0]/', 400, 'request-target-form'], ['//health', 400, 'request-target-form'],
    ['*', 400, 'request-target-form'], ['holdr.test:443', 400, 'request-target-form'],
    ['/health#x', 400, 'request-target-chars'], ['/health?a#b', 400, 'request-target-chars'],
    ['/health?a\\b', 400, 'request-target-chars'], ['/x\\y', 400, 'request-target-chars'],
    ['/a"b', 400, 'request-target-chars'], ['/a{b}', 400, 'request-target-chars'], ['/a|b', 400, 'request-target-chars'],
    ['/café', 400, 'request-target-chars'], ['/a?\x7f', 400, 'request-target-chars'],
    ['/a?\n', 400, 'request-target-chars'], ['/a? ', 400, 'request-target-chars'],
    ['/a%zz', 400, 'bad-percent-encoding'], ['/a%', 400, 'bad-percent-encoding'], ['/a%1', 400, 'bad-percent-encoding'],
    ['/accounts/a%2Fb', 400, 'forbidden-escape'], ['/accounts/a%5Cb', 400, 'forbidden-escape'],
    ['/a%25', 400, 'forbidden-escape'], ['/a%00', 400, 'forbidden-escape'], ['/a%3F', 400, 'forbidden-escape'],
    ['/a%23', 400, 'forbidden-escape'], ['/a%01', 400, 'forbidden-escape'], ['/a%7f', 400, 'forbidden-escape'],
    ['/%68ealth', 400, 'non-canonical-escape'], ['/%61ccounts/x', 400, 'non-canonical-escape'],
    ['/accounts/%2e%2e', 400, 'non-canonical-escape'], ['/a%5f', 400, 'non-canonical-escape'],
    ['/a%C0%AE', 400, 'bad-percent-encoding'], ['/a%ED%A0%80', 400, 'bad-percent-encoding'], ['/a%F4%90%80%80', 400, 'bad-percent-encoding'],
    ['/a%3Bb', 400, 'forbidden-escape'], ['/a%2Cb', 400, 'forbidden-escape'],
    ['/auth//me', 400, 'empty-path-segment'], ['/a//', 400, 'empty-path-segment'],
    ['/accounts/./x', 400, 'dot-segment'], ['/accounts/../health', 400, 'dot-segment'],
    ['/__open-in-editor', 404, 'not-found'], ['/__OPEN-IN-EDITOR-extra?file=anything', 404, 'not-found'],
    ['/' + 'a'.repeat(2048), 414, 'uri-too-long'], ['/?' + 'a'.repeat(4095), 414, 'uri-too-long'],
    ['/?' + 'é'.repeat(2048), 414, 'uri-too-long'],
  ] as const)('refuses %s before Express (%i %s)', (target, refuse, code) => {
    expect(parseIngressTarget(target)).toEqual({ refuse, code });
  });

  it('accepts the exact byte limits', () => {
    expect(parseIngressTarget('/' + 'a'.repeat(2047))).not.toHaveProperty('refuse');
    expect(parseIngressTarget('/?' + 'a'.repeat(4094))).not.toHaveProperty('refuse');
  });
});
