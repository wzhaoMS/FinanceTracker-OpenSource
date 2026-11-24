import { CLI_TIMEOUT_MS, READINESS_CODES } from '../ingress/attestation.js';
import { runBoundedCommand } from '../ingress/boundedCommand.js';
import { parseCommandJson } from '../ingress/commandJson.js';
import { jsonObject, serveSchemaKnown, validateServeStatus, type ServeExpectations } from '../ingress/serveConfig.js';
import { ControlError, EXIT } from './errors.js';
import { isCanonicalAbsolute } from './paths.js';

/**
 * The shell side's view of Tailscale Serve (design §8.2–§8.4; `scripts/lib/serve-verdict.ts`): one bounded read of
 * `tailscale serve status --json`, or a recorded snapshot (`SNAP/serve-status.json`), judged by A2's validator, or by the
 * TCP-owner guard. The verdict is data: the caller decides. A failed or unreadable read is `error` / `unknown`, never
 * "not targeted".
 */
export interface ServeRead { readonly ok: boolean; readonly stdout: string }

export async function readServeStatus(cli: string, home: string): Promise<ServeRead> {
  const result = await runBoundedCommand(cli, ['serve', 'status', '--json'], {
    timeoutMs: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: home },
  });
  return { ok: result.exitCode === 0, stdout: result.stdout };
}

/**
 * `local` (break-glass): the codes of a refused Serve verdict that show an exposure, split exactly as A2's attestation splits
 * them for local (§8.6; B1 review 7). Readiness-only findings (an unknown schema field, an unsupported build, a down daemon)
 * warn; anything else is a known exposure and refuses.
 */
export function localExposureCodes(codes: readonly string[]): string[] {
  return codes.filter((code) => !READINESS_CODES.has(code));
}

export function serveVerdict(read: ServeRead, expectations: ServeExpectations): { verdict: string; codes: readonly string[] } {
  if (!read.ok) return { verdict: 'error', codes: ['serve-command-failed'] };
  return validateServeStatus(read.stdout, 'dist', expectations);
}

/** The TCP port a Serve proxy or forward target names, or null for `unix:` targets; 'unknown' when it cannot be told. */
function targetPort(target: unknown): number | null | 'unknown' {
  if (typeof target !== 'string' || target === '') return 'unknown';
  if (target.startsWith('unix:')) return null;
  if (/^[0-9]{1,5}$/.test(target)) return Number(target);
  try {
    const url = new URL(target.includes('://') ? target : `http://${target}`);
    if (url.port) return Number(url.port);
    if (url.protocol === 'http:') return 80;
    if (url.protocol === 'https:' || url.protocol === 'https+insecure:') return 443;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * TCP-owner guard (§8.3, round 3 B3; B-D27 as revised after the B2 review): `clear` only when a successful read of Serve's
 * own schema shows that no proxy or forward in its configuration (top level, Services and Foreground included) targets
 * `port`. A failed read, unparseable output, any field outside Serve's known schema or with the wrong type (A2's
 * `serveSchemaKnown`, the validator's own check) and any entry whose target cannot be told are `unknown`: only what is
 * recognised can show that nothing targets the port. (A missing CLI is the caller's `unknown`, never `clear`.)
 */
export function portGuard(read: ServeRead, port: number): 'clear' | 'targeted' | 'unknown' {
  if (!read.ok) return 'unknown';
  let config: unknown;
  try { config = parseCommandJson(read.stdout); } catch { return 'unknown'; }
  if (config === null) return 'clear';
  if (!jsonObject(config) || !serveSchemaKnown(config)) return 'unknown';
  let result: 'clear' | 'targeted' | 'unknown' = 'clear';
  const note = (found: number | null | 'unknown') => {
    if (found === port) result = 'targeted';
    else if (found === 'unknown' && result === 'clear') result = 'unknown';
  };
  const level = (value: unknown, depth: number): void => {
    if (depth > 16 || !jsonObject(value)) { note('unknown'); return; }
    for (const handler of Object.values(jsonObject(value.TCP) ? value.TCP : {})) {
      if (!jsonObject(handler)) { note('unknown'); continue; }
      if (handler.TCPForward !== undefined) note(targetPort(handler.TCPForward));
    }
    for (const site of Object.values(jsonObject(value.Web) ? value.Web : {})) {
      if (!jsonObject(site)) { note('unknown'); continue; }
      for (const handler of Object.values(jsonObject(site.Handlers) ? site.Handlers : {})) {
        if (!jsonObject(handler)) { note('unknown'); continue; }
        if (handler.Proxy !== undefined) note(targetPort(handler.Proxy));
      }
    }
    for (const key of ['Services', 'Foreground'] as const) {
      if (value[key] === undefined || value[key] === null) continue;
      if (!jsonObject(value[key])) { note('unknown'); continue; }
      for (const child of Object.values(value[key] as Record<string, unknown>)) level(child, depth + 1);
    }
  };
  level(config, 0);
  return result;
}

const PORT = /^[1-9][0-9]{0,4}$/;
const usage = (detail: string): never => { throw new ControlError('E0I_USAGE', EXIT.usage, detail); };

/**
 * `serve-verdict.ts (--cli <tailscale> | --file <snapshot>) --port-guard <port>` prints `clear`, `targeted` or `unknown`;
 * `serve-verdict.ts (--cli … | --file …) --host <PH> --socket <S|""> [--web-port W] [--api-port A] [--bridge-port B]` prints
 * `<verdict> <codes|->`. Both exit 0; usage errors exit 64.
 */
export async function runServeVerdict(argv: readonly string[], env: NodeJS.ProcessEnv, io: { stdout: { write(text: string): unknown } }) {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--cli', '--file', '--port-guard', '--host', '--socket', '--web-port', '--api-port', '--bridge-port'].includes(name)
      || value === undefined || options.has(name)) usage(`unexpected argument ${name}`);
    options.set(name, value);
  }
  const cli = options.get('--cli');
  const file = options.get('--file');
  if ((cli === undefined) === (file === undefined)) usage('exactly one of --cli and --file');
  if (cli !== undefined && !isCanonicalAbsolute(cli)) usage('--cli must be an absolute path');
  let read: ServeRead;
  if (cli !== undefined) read = await readServeStatus(cli, env.HOME && isCanonicalAbsolute(env.HOME) ? env.HOME : '/');
  else {
    const fs = await import('node:fs');
    try { read = { ok: true, stdout: fs.readFileSync(file!, 'utf8') }; } catch { read = { ok: false, stdout: '' }; }
  }
  const guard = options.get('--port-guard');
  if (guard !== undefined) {
    if (!PORT.test(guard) || Number(guard) > 65535) usage('--port-guard needs a port');
    io.stdout.write(`${portGuard(read, Number(guard))}\n`);
    return 0;
  }
  const host = options.get('--host');
  const socket = options.get('--socket');
  if (!host || socket === undefined) usage('--host and --socket are required for a verdict');
  const ports = (['--api-port', '--web-port', '--bridge-port'] as const).map((name) => options.get(name)).filter((value) => value !== undefined)
    .map((value) => (PORT.test(value!) && Number(value) <= 65535 ? Number(value) : usage(`invalid port ${value}`)));
  const web = options.get('--web-port');
  const result = serveVerdict(read, {
    host: host!, socketPath: socket!, holdrPorts: ports, ...(web !== undefined ? { legacyPort: Number(web) } : {}),
  });
  io.stdout.write(`${result.verdict} ${result.codes.length ? result.codes.join(',') : '-'}\n`);
  return 0;
}
