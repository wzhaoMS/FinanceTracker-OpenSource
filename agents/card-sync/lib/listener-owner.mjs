// Who runs the program listening on Holdr's port. The receiver sends Holdr's service token only to a program that runs
// under your own account: on a computer with other accounts, one of them could listen on 127.0.0.1:4000 while your Holdr
// is stopped, and collect the token. The operating system says who owns each listening socket:
// - Windows: `netstat -ano` lists every listening socket with its process, and Windows PowerShell 5.1 reads each process's
//   owner (its SID), which is compared with this account's.
// - macOS: `lsof` lists the listening sockets with their owners' user IDs, compared with this process's. Run by an ordinary
//   account, lsof shows only that account's processes, so another account's listener is never confirmed as yours.
// - Linux: /proc/net/tcp and /proc/net/tcp6 list every listening socket with its owner's user ID.
// Anything that cannot be read counts as not confirmed, and the caller then sends nothing.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { asList, system32 } from './private-fs.mjs';

const SID = /^S-1-\d+(?:-\d+)+$/;
const LOOKUP_TIMEOUT_MS = 20_000;
/** The listening addresses a connection to 127.0.0.1 can reach: Holdr's own, and the IPv4 and IPv6 wildcards. */
const REACHES_LOOPBACK = new Set(['127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1']);

/** `execFile` as a promise of its standard output, hidden and time-limited. */
export function runProgram(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...options },
      (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve(String(stdout))));
  });
}

/** `127.0.0.1:4000`, `[::]:4000` or `*:4000` as `{ address, port }`, IPv6 addresses without brackets or zone. */
export function splitEndpoint(text) {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5}|\*)$/.exec(String(text));
  if (!match) return null;
  const address = (match[1] ?? match[2]).replace(/%.*$/, '').toLowerCase();
  return { address: address === '*' ? '0.0.0.0' : address, port: match[3] === '*' ? null : Number(match[3]) };
}

/**
 * The listening TCP sockets on `port` in `netstat -ano` output, with their process IDs. A listening socket is the one whose
 * foreign address is 0.0.0.0:0 or [::]:0; the state column is not read, since Windows translates it.
 */
export function parseNetstat(output, port) {
  const listeners = [];
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP' || !['0.0.0.0:0', '[::]:0'].includes(fields[2])) continue;
    const local = splitEndpoint(fields[1]);
    const pid = fields.at(-1);
    if (local?.port === port && /^\d{1,10}$/.test(pid)) listeners.push({ address: local.address, pid: Number(pid) });
  }
  return listeners;
}

/** The listening sockets in `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpun` output: `[{ address, port, uid }]`. */
export function parseLsof(output) {
  const listeners = [];
  let uid = null;
  for (const line of String(output).split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') uid = null;
    else if (field === 'u') uid = /^\d{1,10}$/.test(value) ? Number(value) : null;
    else if (field === 'n') {
      const local = splitEndpoint(value);
      if (local) listeners.push({ ...local, uid });
    }
  }
  return listeners;
}

/** A /proc/net/tcp or tcp6 address (hexadecimal, in the kernel's byte order) as text, for the addresses that matter here. */
function procAddress(hex) {
  const v4 = (word) => [6, 4, 2, 0].map((at) => parseInt(word.slice(at, at + 2), 16)).join('.');
  if (hex.length === 8) return v4(hex);
  if (/^0{32}$/.test(hex)) return '::';
  if (hex === '00000000000000000000000001000000') return '::1';
  if (hex.startsWith('0000000000000000FFFF0000')) return `::ffff:${v4(hex.slice(24))}`;
  return 'other';
}

/** The listening sockets on `port` in /proc/net/tcp or tcp6: `[{ address, uid }]`. */
export function parseProcNet(text, port) {
  const listeners = [];
  for (const line of String(text).split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[3] !== '0A') continue;
    const [hex, portHex] = fields[1].split(':');
    if (parseInt(portHex, 16) !== port || !/^[0-9A-F]+$/i.test(hex) || !/^\d+$/.test(fields[7])) continue;
    listeners.push({ address: procAddress(hex.toUpperCase()), uid: Number(fields[7]) });
  }
  return listeners;
}

// The owner of each process ID in CARD_SYNC_PIDS, and this account's SID. Win32_Process.GetOwnerSid answers only for
// processes this account may inspect: another account's process gets no SID. Nothing reaches PowerShell's command line.
const WINDOWS_OWNERS_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owners = @(foreach ($id in ($env:CARD_SYNC_PIDS -split ',')) {
  $sid = $null
  try {
    $answer = ([wmi]"Win32_Process.Handle='$([int]$id)'").GetOwnerSid()
    if ($answer.ReturnValue -eq 0) { $sid = [string]$answer.Sid }
  } catch { }
  [pscustomobject]@{ pid = [int]$id; sid = $sid }
})
[pscustomobject]@{ me = $me; owners = $owners } | ConvertTo-Json -Depth 3 -Compress`;

/** PowerShell's answer, checked: `{ me, owners: Map<pid, sid | null> }`; anything unexpected throws. */
export function parseWindowsOwners(output) {
  const data = JSON.parse(String(output).trim());
  if (!SID.test(data?.me ?? '')) throw new Error('no account SID');
  const owners = new Map();
  for (const entry of asList(data.owners) ?? []) {
    if (!Number.isSafeInteger(entry?.pid)) throw new Error('an unreadable owner');
    owners.set(entry.pid, typeof entry.sid === 'string' && SID.test(entry.sid) ? entry.sid : null);
  }
  return { me: data.me, owners };
}

/**
 * The listening TCP sockets on `port`: `[{ address, owner }]`, where `owner` is 'you', 'other' (another account), or null
 * (not readable). Only the sockets a connection to 127.0.0.1 can reach are listed. Throws when the lookup fails.
 */
export async function listListeners(port, {
  platform = process.platform, run = runProgram, readFile = (file) => fs.promises.readFile(file, 'utf8'),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  if (platform === 'win32') {
    const sockets = parseNetstat(await run(system32('netstat.exe'), ['-ano']), port).filter((entry) => REACHES_LOOPBACK.has(entry.address));
    if (sockets.length === 0) return [];
    // Windows PowerShell 5.1 started from PowerShell 7 inherits a module path it cannot use: drop it (any letter case).
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
    const { me, owners } = parseWindowsOwners(await run(system32('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_OWNERS_SCRIPT, 'utf16le').toString('base64')],
      { env: { ...env, CARD_SYNC_PIDS: [...new Set(sockets.map((entry) => entry.pid))].join(',') } }));
    return sockets.map(({ address, pid }) => {
      const sid = owners.get(pid) ?? null;
      return { address, owner: sid === null ? null : sid === me ? 'you' : 'other' };
    });
  }
  if (uid === null) throw new Error('this system has no user IDs');
  const own = (entry) => ({ address: entry.address, owner: entry.uid === null ? null : entry.uid === uid ? 'you' : 'other' });
  if (platform === 'darwin') {
    let output;
    try {
      output = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpun']);
    } catch (error) {
      // lsof exits with 1 when it finds nothing (no listener this account can see), or with a warning besides what it found.
      if (error?.code !== 1) throw error;
      output = String(error.stdout ?? '');
    }
    return parseLsof(output).filter((entry) => entry.port === port && REACHES_LOOPBACK.has(entry.address)).map(own);
  }
  if (platform === 'linux') {
    const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readFile(file).catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    })));
    return tables.flatMap((text) => parseProcNet(text, port)).filter((entry) => REACHES_LOOPBACK.has(entry.address)).map(own);
  }
  throw new Error('no listener lookup for this system');
}

/**
 * Who runs the program a connection to 127.0.0.1:`port` reaches: `{ owner: 'you' }` when it listens on 127.0.0.1 and every
 * listener that connection could reach runs under your account; `{ owner: 'other' }` when one of them belongs to another
 * account; else `{ owner: 'unknown', why }`, where `why` is 'hidden' (no such listener this account can see), 'unreadable'
 * (the system did not say who runs it) or 'failed' (the lookup could not run).
 */
export async function listenerOwner(port, options = {}) {
  let listeners;
  try {
    listeners = await listListeners(port, options);
  } catch {
    return { owner: 'unknown', why: 'failed' };
  }
  if (listeners.some((entry) => entry.owner === 'other')) return { owner: 'other' };
  if (!listeners.some((entry) => entry.address === '127.0.0.1')) return { owner: 'unknown', why: 'hidden' };
  if (listeners.every((entry) => entry.owner === 'you')) return { owner: 'you' };
  return { owner: 'unknown', why: 'unreadable' };
}
