// Which user account runs the program listening on Holdr's port. Holdr's API listens on 127.0.0.1, and while Holdr is
// stopped any account on this computer can listen there instead, so before holdr-api.mjs sends the agent token it checks
// that every program listening on that port runs as the account this server runs as:
//   Windows  the owner (SID) of each listening process, through Windows PowerShell 5.1 (Get-NetTCPConnection and
//            Win32_Process.GetOwnerSid), compared with this account's SID (whoami /user)
//   macOS    the user id lsof reports for each listening process, compared with process.getuid(); lsof shows another
//            account's processes only to an administrator, so a listener it cannot see is treated as another account's
//   Linux    the user id /proc/net/tcp and /proc/net/tcp6 give each listening socket
// Anything else (another account's listener, one whose owner cannot be read, a check that cannot run) sends no token.
// The probe that tells "nothing is listening" from "something this account cannot see is listening" only connects and
// closes: it sends nothing.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const CHECK_TIMEOUT_MS = 20_000;
export const PROBE_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SID = /^S-1-\d+(?:-\d+)+$/;

/** A Windows program by its full path, so that nothing earlier on PATH can stand in for it. */
const system32 = (...parts) => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts);
export const POWERSHELL = () => system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
export const LSOF = '/usr/sbin/lsof';

/** Refused with a fixed reason: no output, path or value of the system's in the message. */
export class ListenerCheckError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ListenerCheckError';
  }
}

function validPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ListenerCheckError('the port is not a TCP port');
  return port;
}

/**
 * The Windows PowerShell 5.1 script: this account's SID, and each program listening on `port` with its owner's SID (null
 * when Windows does not say, as for another account's process seen without administrator rights), as one JSON line.
 */
export function windowsListenerScript(port) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$me = $null',
    `if ((& (Join-Path $env:SystemRoot 'System32\\whoami.exe') /user /fo csv /nh | Out-String) -match 'S-1-\\d+(-\\d+)+') { $me = $Matches[0] }`,
    `$found = @(Get-NetTCPConnection -State Listen -LocalPort ${validPort(port)} -ErrorAction SilentlyContinue)`,
    '$listeners = @(foreach ($c in $found) {',
    '  $sid = $null',
    '  try {',
    "    $p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [int]$c.OwningProcess)",
    '    if ($p) { $r = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($r.ReturnValue -eq 0) { $sid = [string]$r.Sid } }',
    '  } catch { }',
    '  [pscustomobject]@{ pid = [int]$c.OwningProcess; sid = $sid }',
    '})',
    'ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ me = $me; listeners = $listeners })',
  ].join('\n');
}

/** `[{ pid, mine }]` from the script's JSON: `mine` is true or false when the owner is known, null when it is not. */
export function parseWindowsListeners(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout).trim());
  } catch {
    throw new ListenerCheckError('Windows PowerShell gave no readable answer');
  }
  const me = typeof data?.me === 'string' && SID.test(data.me) ? data.me : null;
  if (!me) throw new ListenerCheckError("Windows did not give this account's SID");
  const entries = Array.isArray(data.listeners) ? data.listeners : data.listeners ? [data.listeners] : [];
  return entries.map((entry) => ({
    pid: Number.isInteger(entry?.pid) ? entry.pid : null,
    mine: typeof entry?.sid === 'string' && SID.test(entry.sid) ? entry.sid === me : null,
  }));
}

/** `[{ pid, mine }]` from `lsof -F pu`: a `p<pid>` line starts each process, and its `u<uid>` line follows. */
export function parseLsof(stdout, uid) {
  const listeners = [];
  let current = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) {
      current = { pid: Number(line.slice(1)), mine: null };
      listeners.push(current);
    } else if (current && /^u\d+$/.test(line)) {
      current.mine = Number(line.slice(1)) === uid;
    }
  }
  return listeners;
}

/** `[{ pid: null, mine }]` for the listening sockets (state 0A) on `port` in a /proc/net/tcp or /proc/net/tcp6 table. */
export function parseProcNetTcp(text, port, uid) {
  const listeners = [];
  for (const line of String(text).split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[3] !== '0A') continue;
    const local = fields[1];
    if (Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16) !== port) continue;
    const owner = Number(fields[7]);
    listeners.push({ pid: null, mine: /^\d+$/.test(fields[7]) ? owner === uid : null });
  }
  return listeners;
}

/** Runs a program without a shell; resolves `{ code, stdout }` whatever its exit status, rejects when it cannot run. */
export function runProgram(file, args, { timeoutMs = CHECK_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', env }, (error, stdout) => {
      if (error && (typeof error.code !== 'number' || error.killed)) {
        reject(new ListenerCheckError(error.killed ? 'the check did not finish in time' : `${path.basename(file)} could not run`));
        return;
      }
      resolve({ code: error ? error.code : 0, stdout });
    });
  });
}

/**
 * Every program listening on TCP `port` on this computer, as `[{ pid, mine }]`. Throws ListenerCheckError when the
 * check cannot run. `platform`, `run`, `readFile` and `uid` are parameters so that tests can check every platform's logic.
 */
export async function findListeners(port, {
  platform = process.platform, run = runProgram, readFile = fs.promises.readFile, uid = process.getuid?.(),
} = {}) {
  validPort(port);
  if (platform === 'win32') {
    const encoded = Buffer.from(windowsListenerScript(port), 'utf16le').toString('base64');
    // Windows PowerShell 5.1 started from PowerShell 7 inherits a module path it cannot use: drop it (any letter case).
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
    const { code, stdout } = await run(POWERSHELL(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env });
    if (code !== 0) throw new ListenerCheckError('Windows PowerShell could not list the listening programs');
    return parseWindowsListeners(stdout);
  }
  if (!Number.isInteger(uid)) throw new ListenerCheckError("this account's user id is not known");
  if (platform === 'darwin') {
    const { code, stdout } = await run(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu']);
    // lsof exits 1 when it finds nothing: no listener this account can see.
    if (code === 1 && String(stdout).trim() === '') return [];
    if (code !== 0) throw new ListenerCheckError('lsof could not list the listening programs');
    return parseLsof(stdout, uid);
  }
  if (platform === 'linux') {
    const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readFile(file, 'utf8').catch((error) => {
      if (file.endsWith('6') && error?.code === 'ENOENT') return '';
      throw new ListenerCheckError('/proc/net/tcp could not be read');
    })));
    return tables.flatMap((table) => parseProcNetTcp(table, port, uid));
  }
  throw new ListenerCheckError('this operating system is not supported');
}

/**
 * Who listens on `port`: `{ state: 'yours' | 'other' | 'unknown' | 'none', pids }`, or `{ state: 'failed', reason }` when
 * the check cannot run. 'yours' needs every listener to run as this account; one of another account's makes it 'other',
 * one whose owner cannot be read 'unknown'. 'none' means no listener this account can see.
 */
export async function checkListener(port, deps = {}) {
  let listeners;
  try {
    listeners = await findListeners(port, deps);
  } catch (error) {
    return { state: 'failed', reason: error instanceof ListenerCheckError ? error.message : 'the check could not run' };
  }
  const pids = [...new Set(listeners.map((listener) => listener.pid).filter((pid) => pid !== null))];
  if (listeners.length === 0) return { state: 'none', pids };
  if (listeners.some((listener) => listener.mine === false)) return { state: 'other', pids };
  if (listeners.some((listener) => listener.mine !== true)) return { state: 'unknown', pids };
  return { state: 'yours', pids };
}

/** Whether anything accepts a connection on 127.0.0.1:`port`: 'open', 'closed' (refused) or 'unknown'. Sends nothing. */
export function probePort(port, { host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let timer = null;
    const done = (state) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    timer = setTimeout(() => done('unknown'), timeoutMs);
    socket.once('connect', () => done('open'));
    socket.once('error', (error) => done(error?.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}
