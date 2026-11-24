import { runBoundedCommand, type CommandResult } from './boundedCommand.js';
import { parseCommandJson } from './commandJson.js';
import { jsonObject, SERVE_CODES, validateServeStatus, type ServeExpectations } from './serveConfig.js';
import type { IngressAdmission } from './types.js';

export const ATTESTATION_TTL_NS = 45_000_000_000n;
export const MAX_ATTEMPT_NS = 16_000_000_000n;
export const ATTESTATION_POLL_MS = 15_000;
export const CLI_TIMEOUT_MS = 5000;
export interface TailscaleBuild { readonly majorMinorPatch: string; readonly long: string }
// AL1 must record and review the exact daemon/CLI long string. Never accept the prototype's placeholder.
export const SUPPORTED_TAILSCALE: readonly TailscaleBuild[] = Object.freeze([]);
export const VERIFIED_RUNTIMES = Object.freeze([Object.freeze({ platform: 'darwin', node: '22.23.3', uv: '1.51.0' })]);

export const READINESS_CODES = new Set([
  'tailscale-version-unsupported', 'tailscale-version-skew', 'tailscale-not-running', 'public-host-mismatch',
  'cert-domain-missing', 'serve-schema-unknown', 'serve-not-installed',
  'version-command-failed', 'status-command-failed', 'serve-command-failed',
  'version-output-invalid', 'status-output-invalid', 'serve-output-invalid',
]);
const RESULT_CODES = new Set([...SERVE_CODES, ...READINESS_CODES, 'socket-path-unsafe', 'socket-replaced', 'socket-missing']);
export interface AttestationResult {
  readonly kind: 'ok' | 'pending' | 'refused' | 'error';
  readonly codes: readonly string[];
  /** A complete Serve observation, needed to clear a prior local exposure refusal. */
  readonly exposureChecked: boolean;
}
export interface Attempt { readonly start: bigint }
export interface AttestationView {
  readonly name: 'unverified' | 'verified' | 'stale' | 'refused';
  readonly codes: readonly string[];
  readonly ageMs: number | null;
  readonly verified: boolean;
}
interface State {
  name: AttestationView['name'];
  codes: readonly string[];
  start?: bigint;
  deadline?: bigint;
}

export function createAttestationState(options: {
  mode?: 'dist' | 'local'; now?: () => bigint; onChange?: (view: AttestationView) => void;
} = {}) {
  const mode = options.mode ?? 'dist';
  const now = options.now ?? (() => process.hrtime.bigint());
  let state: State = { name: 'unverified', codes: [mode === 'local' ? 'break-glass' : 'start'] };
  let latest: Attempt | undefined;
  const snapshot = (time: bigint): AttestationView => Object.freeze({
    name: state.name, codes: Object.freeze([...state.codes]),
    ageMs: state.start === undefined ? null : Number((time >= state.start ? time - state.start : 0n) / 1_000_000n),
    verified: state.name === 'verified',
  });
  const change = (next: State, time: bigint) => {
    state = next;
    try { options.onChange?.(snapshot(time)); }
    catch { state = { name: 'unverified', codes: ['state-write-failed'] }; }
  };
  const time = (): bigint => {
    try {
      const value = now();
      if (typeof value === 'bigint' && value >= 0n) return value;
    } catch { /* A failed clock is never admission. */ }
    state = { name: 'unverified', codes: ['clock-invalid'] };
    return -1n;
  };
  const expire = (at: bigint) => {
    if (state.name === 'verified' && at > state.deadline!) change({ ...state, name: 'stale', codes: ['ttl'] }, at);
    else if (state.name === 'verified' && at < state.start!) change({ name: 'unverified', codes: ['clock-invalid'] }, at);
  };
  const view = () => { const at = time(); expire(at); return snapshot(at); };
  const admission: IngressAdmission = {
    refusal() {
      const current = view();
      if (current.name === 'verified' || (mode === 'local' && current.name === 'unverified' && current.codes.includes('break-glass'))) return null;
      return current.name === 'refused' ? 'ingress-refused' : 'ingress-unverified';
    },
  };
  return {
    admission,
    view,
    publish() {
      const at = time();
      expire(at);
      change({ ...state }, at);
    },
    beginAttempt(): Attempt {
      latest = Object.freeze({ start: time() });
      return latest;
    },
    record(value: unknown, attempt: Attempt): 'applied' | 'no-change' | 'attempt-too-long' {
      const at = time();
      expire(at);
      const validAttempt = latest === attempt && attempt.start >= 0n && at >= attempt.start;
      if (latest === attempt) latest = undefined;
      const result = value as AttestationResult | null;
      if (!result || !['ok', 'pending', 'refused', 'error'].includes(result.kind) || !Array.isArray(result.codes)
        || typeof result.exposureChecked !== 'boolean' || !result.codes.every((code) => RESULT_CODES.has(code))
        || (result.kind === 'refused' && result.codes.length === 0) || (result.kind === 'ok' && (result.codes.length !== 0 || !result.exposureChecked))
        || (result.kind === 'error' && result.codes.some((code) => !READINESS_CODES.has(code)))) {
        change({ name: 'unverified', codes: ['result-unknown'] }, at);
        return 'applied';
      }
      const codes = Object.freeze([...new Set(result.codes)].sort());
      const overlong = !validAttempt || at - attempt.start > MAX_ATTEMPT_NS;
      if (mode === 'local') {
        const exposure = codes.filter((code) => !READINESS_CODES.has(code));
        if (exposure.length) {
          change({ name: 'refused', codes: exposure }, at);
          return 'applied';
        }
        // A failed read cannot erase a known exposure; only a fresh complete observation can.
        if (result.exposureChecked && !overlong) {
          change({ name: 'unverified', codes: ['break-glass', ...codes] }, at);
          return 'applied';
        }
        return overlong && result.kind === 'ok' ? 'attempt-too-long' : 'no-change';
      }
      // Negative results are applied BEFORE the duration check, even with a live old lease.
      if (result.kind === 'refused') {
        change({ name: 'refused', codes }, at);
        return 'applied';
      }
      if (result.kind === 'pending') {
        change({ name: 'unverified', codes }, at);
        return 'applied';
      }
      if (result.kind === 'error') return 'no-change';
      if (overlong) return 'attempt-too-long';
      change({ name: 'verified', codes: [], start: attempt.start, deadline: attempt.start + ATTESTATION_TTL_NS }, at);
      return 'applied';
    },
    close() {
      latest = undefined;
      change({ name: 'unverified', codes: ['stopped'] }, time());
    },
  };
}

export type AttestationState = ReturnType<typeof createAttestationState>;
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;
export interface PathEvidence { readonly ok: boolean; readonly codes: readonly string[] }

export async function attestOnce(options: {
  cli: string; expectations: ServeExpectations; checkPath: () => Promise<PathEvidence>;
  supported?: readonly TailscaleBuild[]; mode?: 'dist' | 'local'; run?: CommandRunner; home?: string;
}): Promise<AttestationResult> {
  const run = options.run ?? ((file, args) => runBoundedCommand(file, args, {
    timeoutMs: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: options.home ?? process.env.HOME ?? '/' },
  }));
  const command = async (args: readonly string[]): Promise<CommandResult> => {
    try {
      const result = await run(options.cli, args);
      if (result && typeof result.stdout === 'string') return result;
    } catch { /* A runner failure never skips the other inputs. */ }
    return { exitCode: 'spawn-error', stdout: '' };
  };
  // Every input runs, even when version/status is unavailable: local exposure must not be hidden by a readiness error.
  const [socket, version, status, serve] = await Promise.all([
    Promise.resolve().then(options.checkPath).then((result): PathEvidence => {
      if (result && typeof result.ok === 'boolean' && Array.isArray(result.codes) && (!result.ok || result.codes.length === 0)) return result;
      return { ok: false, codes: ['socket-path-unsafe'] };
    }).catch(() => ({ ok: false, codes: ['socket-path-unsafe'] })),
    command(['version', '--daemon', '--json']), command(['status', '--json']), command(['serve', 'status', '--json']),
  ]);
  const refused: string[] = socket.ok ? [] : socket.codes.filter((code) => ['socket-path-unsafe', 'socket-replaced', 'socket-missing'].includes(code));
  if (!socket.ok && refused.length === 0) refused.push('socket-path-unsafe');
  const errors: string[] = [];
  const read = (result: CommandResult, name: 'version' | 'status') => {
    if (result.exitCode !== 0) { errors.push(`${name}-command-failed`); return null; }
    try {
      const parsed = parseCommandJson(result.stdout);
      if (jsonObject(parsed)) return parsed;
    } catch { /* Value-free malformed output. */ }
    errors.push(`${name}-output-invalid`);
    return null;
  };
  const meta = read(version, 'version');
  if (meta) {
    if (typeof meta.majorMinorPatch !== 'string' || typeof meta.long !== 'string' || typeof meta.daemonLong !== 'string') errors.push('version-output-invalid');
    else {
      if (!(options.supported ?? SUPPORTED_TAILSCALE).some((pin) => pin.majorMinorPatch === meta.majorMinorPatch && pin.long === meta.long)) refused.push('tailscale-version-unsupported');
      if (meta.daemonLong !== meta.long) refused.push('tailscale-version-skew');
    }
  }
  const health = read(status, 'status');
  if (health) {
    if (health.BackendState !== 'Running') refused.push('tailscale-not-running');
    if (!jsonObject(health.Self) || health.Self.DNSName !== options.expectations.host + '.') refused.push('public-host-mismatch');
    if (!Array.isArray(health.CertDomains) || !health.CertDomains.includes(options.expectations.host)) refused.push('cert-domain-missing');
  }
  let pending = false;
  let exposureChecked = false;
  if (serve.exitCode !== 0) errors.push('serve-command-failed');
  else {
    const result = validateServeStatus(serve.stdout, options.mode ?? 'dist', options.expectations);
    exposureChecked = result.verdict !== 'error';
    if (result.verdict === 'refused') refused.push(...result.codes);
    else if (result.verdict === 'error') errors.push(...result.codes);
    else if (result.verdict !== 'approved-dist') pending = true;
  }
  const codes = [...new Set([...refused, ...errors, ...(pending ? ['serve-not-installed'] : [])])].sort();
  return {
    kind: refused.length ? 'refused' : pending ? 'pending' : errors.length ? 'error' : 'ok',
    codes, exposureChecked,
  };
}

export function createAttestationPoller(state: AttestationState, attempt: () => Promise<AttestationResult>, options: {
  now?: () => bigint; log?: (line: string) => void;
} = {}) {
  const now = options.now ?? (() => process.hrtime.bigint());
  let generation = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let active: Promise<AttestationResult> | undefined;
  const pollOnce = (): Promise<AttestationResult> => {
    if (active) return active;
    const epoch = generation;
    const started = state.beginAttempt();
    active = Promise.resolve().then(attempt).catch((): AttestationResult => ({
      kind: 'error', codes: ['serve-command-failed'], exposureChecked: false,
    })).then((result) => {
      if (!stopped && epoch === generation) {
        const effect = state.record(result, started);
        const snapshot = state.view();
        try { options.log?.(`[holdr-ingress] attestation ${snapshot.name} ${effect === 'attempt-too-long' ? effect : snapshot.codes.join(',')}`); }
        catch { /* Logging is not an admission authority. */ }
      }
      return result;
    }).finally(() => { active = undefined; });
    return active;
  };
  return {
    pollOnce,
    start() {
      if (heartbeat) return;
      stopped = false;
      generation++;
      state.publish();
      const tick = async () => {
        const start = now();
        await pollOnce();
        if (!stopped) {
          timer = setTimeout(tick, Math.max(0, ATTESTATION_POLL_MS - Number((now() - start) / 1_000_000n)));
          timer.unref();
        }
      };
      heartbeat = setInterval(() => state.view(), 1000);
      heartbeat.unref();
      void tick();
    },
    stop() {
      stopped = true;
      generation++;
      clearTimeout(timer);
      clearInterval(heartbeat);
      heartbeat = undefined;
      state.close();
    },
  };
}
