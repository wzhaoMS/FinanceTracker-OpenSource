import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_MACHINE, controlFixture } from './testControl.js';
import {
  FENCE_FILE, GENERATION, describeGate, fenceState, newGeneration, parseFence, readFence, sameFence, serializeFence, validFence,
  writeFence,
} from './syncAuthState.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const G = 'agn_' + 'a'.repeat(32);
const N = 'agn_' + 'p'.repeat(32);
const OP = '0123456789abcdef';
const base = { format: 'holdr-sync-auth-state/3', machine: TEST_MACHINE, updatedAt: '2026-10-17T13:00:00.000Z' };
const state = (fields: Record<string, unknown>) => ({ format: base.format, gate: 'blocked', reason: 'init', generation: null,
  next: null, op: null, machine: base.machine, updatedAt: base.updatedAt, ...fields });

describe('fence format 3 (§9.4)', () => {
  it.each([
    ['blocked/init', state({})],
    ['blocked/reinit', state({ reason: 'reinit' })],
    ['blocked/incident without a generation', state({ reason: 'incident' })],
    ['blocked/incident keeping G', state({ reason: 'incident', generation: G })],
    ['blocked/change', state({ reason: 'change', generation: G, next: N, op: OP })],
    ['blocked/recovery', state({ reason: 'recovery', next: N, op: OP })],
    ['blocked/recovery keeping G', state({ reason: 'recovery', generation: G, next: N, op: OP })],
    ['open G', state({ gate: 'open', reason: null, generation: G })],
  ])('accepts %s and round-trips it canonically', (_name, value) => {
    expect(validFence(value)).toBe(true);
    const text = serializeFence(value as never);
    expect(text).toBe(JSON.stringify(value) + '\n');
    expect(parseFence(Buffer.from(text))).toEqual(value);
  });

  it.each([
    ['init with a generation', state({ generation: G })],
    ['init with an op', state({ op: OP })],
    ['incident with next', state({ reason: 'incident', next: N })],
    ['change without op', state({ reason: 'change', generation: G, next: N })],
    ['change without generation', state({ reason: 'change', next: N, op: OP })],
    ['recovery without next', state({ reason: 'recovery', op: OP })],
    ['open with a reason', state({ gate: 'open', reason: 'init', generation: G })],
    ['open without generation', state({ gate: 'open', reason: null })],
    ['open with next', state({ gate: 'open', reason: null, generation: G, next: N })],
    ['unknown reason', state({ reason: 'manual' })],
    ['unknown gate', state({ gate: 'closed' })],
    ['format 2', state({ format: 'holdr-sync-auth-state/2' })],
    ['uppercase generation', state({ reason: 'incident', generation: G.toUpperCase() })],
    ['generation outside a-p', state({ reason: 'incident', generation: 'agn_' + 'q'.repeat(32) })],
    ['short machine', state({ machine: 'abc' })],
    ['non-ISO time', state({ updatedAt: '2026-10-17 13:00:00' })],
    ['impossible date', state({ updatedAt: '2026-02-30T13:00:00.000Z' })],
    ['extra key', { ...state({}), extra: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(validFence(value)).toBe(false);
  });

  it('rejects non-canonical bytes: key order, spacing, CRLF, a second line, a BOM, invalid UTF-8', () => {
    const value = state({});
    const { gate, ...rest } = value;
    const reordered = JSON.stringify({ gate, ...rest }) + '\n';
    for (const text of [reordered, JSON.stringify(value, null, 1) + '\n', JSON.stringify(value) + '\r\n',
      JSON.stringify(value) + '\n\n', JSON.stringify(value), '\uFEFF' + JSON.stringify(value) + '\n']) {
      expect(parseFence(Buffer.from(text))).toBeNull();
    }
    expect(parseFence(Buffer.from([0xff, 0x0a]))).toBeNull();
  });

  it('generations use E1b format, agn_ + 32 letters a–p', () => {
    const values = new Set(Array.from({ length: 50 }, newGeneration));
    expect(values.size).toBe(50);
    for (const value of values) expect(value).toMatch(GENERATION);
  });
});

describe.skipIf(process.platform !== 'darwin')('fence file I/O (K21, atomic writes)', () => {
  const fixture = async () => { const f = await controlFixture(); cleanups.push(f.cleanup); return f; };

  it('init writes blocked/init for this machine; reads report the closed gate and its reason', async () => {
    const { controlDir } = await fixture();
    const read = readFence(controlDir, TEST_MACHINE);
    expect(read).toMatchObject({ gate: 'closed', reason: 'blocked:init' });
    expect(describeGate(read)).toBe('blocked (init)');
    expect(readFence(controlDir, 'fedcba9876543210')).toMatchObject({ gate: 'closed', reason: 'machine-changed' });
    expect(readFence(controlDir, null)).toMatchObject({ gate: 'closed', reason: 'machine-changed' });
  });

  it('writes atomically with mode 0600 and leaves no temporary file; open reads as open with a short generation', async () => {
    const { controlDir } = await fixture();
    const open = fenceState({ gate: 'open', reason: null, generation: G, next: null, op: null, machine: TEST_MACHINE });
    writeFence(controlDir, open);
    expect(fs.statSync(path.join(controlDir, FENCE_FILE)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(controlDir).filter((name) => name.includes('.tmp.'))).toEqual([]);
    const read = readFence(controlDir, TEST_MACHINE);
    expect(read.gate).toBe('open');
    expect(describeGate(read)).toBe('open agn_aaaa…');
    expect(sameFence(read.state, open)).toBe(true);
  });

  it('content problems close the gate (missing, invalid); metadata problems are E0I_FENCE_FILE (K21)', async () => {
    const { controlDir } = await fixture();
    const file = path.join(controlDir, FENCE_FILE);
    fs.writeFileSync(file, '{"format":"x"}\n');
    expect(readFence(controlDir, TEST_MACHINE)).toEqual({ gate: 'closed', reason: 'invalid' });
    fs.unlinkSync(file);
    expect(readFence(controlDir, TEST_MACHINE)).toEqual({ gate: 'closed', reason: 'missing' });
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(() => readFence(controlDir, TEST_MACHINE)).toThrow('E0I_FENCE_FILE');
    fs.chmodSync(file, 0o600);
    fs.linkSync(file, path.join(controlDir, 'extra-link'));
    expect(() => readFence(controlDir, TEST_MACHINE)).toThrow('E0I_FENCE_FILE');
    fs.unlinkSync(path.join(controlDir, 'extra-link'));
    fs.writeFileSync(file, 'x'.repeat(4097));
    expect(() => readFence(controlDir, TEST_MACHINE)).toThrow('E0I_FENCE_FILE');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(controlDir, 'lifecycle-state'), file);
    expect(() => readFence(controlDir, TEST_MACHINE)).toThrow('E0I_FENCE_FILE');
  });
});
