import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAttestationPoller, createAttestationState, attestOnce, ATTESTATION_TTL_NS, MAX_ATTEMPT_NS, SUPPORTED_TAILSCALE, type AttestationResult } from './attestation.js';
import { canonicalServeJson } from './serveConfig.js';
import { assertVerifiedRuntime } from './safetyProviders.js';

const result = (kind: AttestationResult['kind'], codes: string[] = []): AttestationResult => ({ kind, codes, exposureChecked: kind !== 'error' });
const ms = (value: number) => BigInt(Math.round(value * 1e6));
const frame = (mode: 'dist' | 'local' = 'dist') => {
  let now = 0n;
  const state = createAttestationState({ mode, now: () => now });
  return { state, at: (value: number) => { now = ms(value); } };
};
afterEach(() => vi.restoreAllMocks());

describe('continuous-clock attestation admission', () => {
  it('has the fixed 45s and 16s boundaries and starts closed', () => {
    expect(ATTESTATION_TTL_NS).toBe(45_000_000_000n);
    expect(MAX_ATTEMPT_NS).toBe(16_000_000_000n);
    expect(frame().state.admission.refusal()).toBe('ingress-unverified');
    expect(SUPPORTED_TAILSCALE).toEqual([]);
  });
  it.each(['refused', 'pending'] as const)('Astra regression: overlong %s closes an existing live lease at 31.001s', (kind) => {
    const { state, at } = frame();
    state.record(result('ok'), state.beginAttempt());
    at(15_000); const attempt = state.beginAttempt();
    at(31_001);
    expect(state.admission.refusal()).toBeNull();
    state.record(result(kind, [kind === 'refused' ? 'tcp-forward' : 'serve-not-installed']), attempt);
    expect(state.admission.refusal()).toBe(kind === 'refused' ? 'ingress-refused' : 'ingress-unverified');
    at(40_000); expect(state.admission.refusal()).not.toBeNull();
  });
  it.each(['refused', 'pending'] as const)('a %s observation spanning a two-hour sleep is applied, not discarded', (kind) => {
    const { state, at } = frame();
    state.record(result('ok'), state.beginAttempt());
    at(10_000); const attempt = state.beginAttempt();
    at(7_210_000);
    state.record(result(kind, [kind === 'refused' ? 'path-handler' : 'serve-not-installed']), attempt);
    expect(state.view().name).toBe(kind === 'refused' ? 'refused' : 'unverified');
  });
  it('accepts exactly 16 seconds but not one nanosecond more', () => {
    let now = 0n;
    const state = createAttestationState({ now: () => now });
    const first = state.beginAttempt();
    now = MAX_ATTEMPT_NS;
    expect(state.record(result('ok'), first)).toBe('applied');
    const next = state.beginAttempt();
    now += MAX_ATTEMPT_NS + 1n;
    expect(state.record(result('ok'), next)).toBe('attempt-too-long');
  });
  it('ignores an overlong success without extending the prior deadline', () => {
    const { state, at } = frame();
    state.record(result('ok'), state.beginAttempt());
    at(15_000); const attempt = state.beginAttempt();
    at(31_001); expect(state.record(result('ok'), attempt)).toBe('attempt-too-long');
    at(45_000); expect(state.admission.refusal()).toBeNull();
    at(45_001); expect(state.admission.refusal()).toBe('ingress-unverified');
    expect(state.view().name).toBe('stale');
  });
  it('cannot let an overlong success erase a refusal, but a fresh success can recover', () => {
    const { state, at } = frame();
    state.record(result('refused', ['path-handler']), state.beginAttempt());
    at(15_000); const attempt = state.beginAttempt();
    at(31_001); state.record(result('ok'), attempt);
    expect(state.admission.refusal()).toBe('ingress-refused');
    at(32_000); const fresh = state.beginAttempt();
    at(33_000); state.record(result('ok'), fresh);
    expect(state.admission.refusal()).toBeNull();
    at(77_000); expect(state.admission.refusal()).toBeNull();
    at(77_001); expect(state.admission.refusal()).not.toBeNull();
  });
  it.each([1000, 16_001, 7_200_000])('an error taking %ims never extends last-known-good', (duration) => {
    const { state, at } = frame();
    state.record(result('ok'), state.beginAttempt());
    at(15_000); const attempt = state.beginAttempt();
    at(15_000 + duration); state.record(result('error'), attempt);
    expect(state.admission.refusal()).toBe(duration <= 30_000 ? null : 'ingress-unverified');
    at(Math.max(45_001, 15_000 + duration)); expect(state.admission.refusal()).not.toBeNull();
  });
  it.each(['short sleep', 'long sleep', 'attempt across sleep', 'delayed timers', 'stored expiry', 'wall rollback'])('models %s without wall-clock admission', (scenario) => {
    const { state, at } = frame();
    const first = state.beginAttempt();
    if (scenario === 'attempt across sleep') {
      at(7_200_000); state.record(result('ok'), first);
      expect(state.admission.refusal()).not.toBeNull();
      return;
    }
    at(1000); state.record(result('ok'), first);
    if (scenario === 'short sleep') {
      at(11_000); expect(state.admission.refusal()).toBeNull();
      at(44_999); expect(state.admission.refusal()).toBeNull();
      at(45_001); expect(state.admission.refusal()).not.toBeNull();
      return;
    }
    if (scenario === 'wall rollback') vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('wall clock read'); });
    at(scenario === 'long sleep' ? 7_200_000 : 60_000);
    expect(state.admission.refusal()).not.toBeNull();
    expect(state.view().name).toBe('stale');
    at(1000);
    expect(state.admission.refusal()).not.toBeNull();
    expect(state.view().name).toBe('stale');
  });
  it('counts a short sleep inside an attempt from its start, not its completion', () => {
    const { state, at } = frame();
    const attempt = state.beginAttempt();
    at(6000); state.record(result('ok'), attempt);
    at(45_000); expect(state.admission.refusal()).toBeNull();
    at(45_001); expect(state.admission.refusal()).not.toBeNull();
  });
  it.each([null, { kind: 'bogus', codes: [] }, { kind: 'ok', codes: [], exposureChecked: false },
    { kind: 'ok', codes: ['tcp-forward'], exposureChecked: true },
    { kind: 'refused', codes: ['do-not-log-this-secret'], exposureChecked: true }])('unknown/inconsistent results close and do not echo input codes', (value) => {
    const { state } = frame();
    state.record(result('ok'), state.beginAttempt());
    state.record(value, state.beginAttempt());
    expect(state.admission.refusal()).toBe('ingress-unverified');
    expect(state.view().codes).toEqual(['result-unknown']);
  });
  it('will not replay an old success or accept one after shutdown', () => {
    const { state, at } = frame();
    const old = state.beginAttempt();
    state.record(result('ok'), old);
    at(1000); state.close();
    state.record(result('ok'), old);
    expect(state.admission.refusal()).not.toBeNull();
  });
  it('closes if state persistence or the clock fails', () => {
    const failed = createAttestationState({ now: () => 1n, onChange: () => { throw Error('disk error'); } });
    failed.record(result('ok'), failed.beginAttempt());
    expect(failed.admission.refusal()).toBe('ingress-unverified');
    expect(createAttestationState({ now: () => { throw Error('clock error'); } }).admission.refusal()).toBe('ingress-unverified');
  });
  it('local tolerates readiness failures, never claims verification, and retains a known exposure across read errors', () => {
    const { state, at } = frame('local');
    expect(state.admission.refusal()).toBeNull();
    state.record(result('error', ['serve-command-failed']), state.beginAttempt());
    expect(state.admission.refusal()).toBeNull();
    state.record(result('refused', ['tailscale-version-unsupported']), state.beginAttempt());
    expect(state.admission.refusal()).toBeNull();
    state.record(result('refused', ['path-handler']), state.beginAttempt());
    expect(state.admission.refusal()).toBe('ingress-refused');
    state.record(result('error', ['serve-command-failed']), state.beginAttempt());
    expect(state.admission.refusal()).toBe('ingress-refused');
    const stale = state.beginAttempt();
    at(16_001); state.record(result('pending', ['serve-not-installed']), stale);
    expect(state.admission.refusal()).toBe('ingress-refused');
    state.record(result('pending', ['serve-not-installed']), state.beginAttempt());
    expect(state.admission.refusal()).toBeNull();
    expect(state.view().verified).toBe(false);
  });
  it('enforces the reviewed runtime tuple', () => {
    expect(() => assertVerifiedRuntime({ platform: 'darwin', node: '22.23.3', uv: '1.51.0' })).not.toThrow();
    expect(() => assertVerifiedRuntime({ platform: 'darwin', node: '22.23.4', uv: '1.51.0' })).toThrow('E0I_RUNTIME_UNVERIFIED');
  });
});

describe('one complete attestation', () => {
  const expectations = { host: 'holdr.test', socketPath: '/holdr/r/s' };
  const pin = { majorMinorPatch: '1.98.3', long: 'synthetic-exact-reviewed-build' };
  const outputs = () => ({
    version: JSON.stringify({ ...pin, daemonLong: pin.long }),
    status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'holdr.test.' }, CertDomains: ['holdr.test'] }),
    serve: canonicalServeJson('dist', expectations),
  });
  async function check(mutate: (out: ReturnType<typeof outputs>) => void, fail?: string) {
    const out = outputs(); mutate(out);
    const calls: string[] = [];
    const response = await attestOnce({
      cli: '/synthetic-cli', expectations, supported: [pin],
      checkPath: async () => { calls.push('path'); return { ok: true, codes: [] }; },
      run: async (_file, args) => {
        calls.push(args[0]);
        return { exitCode: fail === args[0] ? 1 : 0, stdout: out[args[0] as keyof typeof out] };
      },
    });
    expect(calls.sort()).toEqual(['path', 'serve', 'status', 'version']);
    return response;
  }
  it('requires all four inputs, supported CLI/daemon and the exact shape', async () => {
    expect((await check(() => {})).kind).toBe('ok');
  });
  it.each([
    ['unsupported', 'tailscale-version-unsupported', (o: ReturnType<typeof outputs>) => { o.version = o.version.replaceAll(pin.long, 'unknown'); }],
    ['skew', 'tailscale-version-skew', (o: ReturnType<typeof outputs>) => { o.version = JSON.stringify({ ...pin, daemonLong: 'unknown' }); }],
    ['backend', 'tailscale-not-running', (o: ReturnType<typeof outputs>) => { o.status = o.status.replace('Running', 'Stopped'); }],
    ['host', 'public-host-mismatch', (o: ReturnType<typeof outputs>) => { o.status = o.status.replace('holdr.test.', 'other.test.'); }],
    ['cert', 'cert-domain-missing', (o: ReturnType<typeof outputs>) => { o.status = o.status.replace('["holdr.test"]', '[]'); }],
    ['config', 'path-handler', (o: ReturnType<typeof outputs>) => { o.serve = '{"Web":{"holdr.test:443":{"Handlers":{"/":{"Path":"/private"}}}}}'; }],
  ] as const)('refuses %s without skipping any other input', async (_name, code, mutate) => {
    const response = await check(mutate);
    expect(response.kind).toBe('refused');
    expect(response.codes).toContain(code);
  });
  it('a version command failure cannot hide a known exposure or pending Serve change', async () => {
    expect((await check((out) => { out.serve = '{"TCP":{"9443":{"TerminateTLS":"holdr.test"}}}'; }, 'version')).kind).toBe('refused');
    expect((await check((out) => { out.serve = '{}'; }, 'version')).kind).toBe('pending');
  });
  it.each(['version', 'status', 'serve'])('a failed %s command never constitutes a new success', async (name) => {
    expect((await check(() => {}, name)).kind).toBe('error');
  });
  it('synchronous path failures still collect every CLI result', async () => {
    const calls: string[] = [];
    const response = await attestOnce({
      cli: '/synthetic', expectations, supported: [pin], checkPath: () => { throw Error('path failed'); },
      run: async (_file, args) => { calls.push(args[0]); return { exitCode: 1, stdout: '' }; },
    });
    expect(calls.sort()).toEqual(['serve', 'status', 'version']);
    expect(response.kind).toBe('refused');
    expect(response.codes).toContain('socket-path-unsafe');
  });
});

it('poller does not overlap and late completion after stop cannot revive admission', async () => {
  const { state } = frame();
  let finish!: (result: AttestationResult) => void;
  const run = vi.fn(() => new Promise<AttestationResult>((resolve) => { finish = resolve; }));
  const poller = createAttestationPoller(state, run);
  const first = poller.pollOnce();
  const second = poller.pollOnce();
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  poller.stop();
  finish(result('ok'));
  await Promise.all([first, second]);
  expect(state.admission.refusal()).not.toBeNull();
});
