import { repoPaths } from './paths.js';
import type { Runner } from './runner.js';

/**
 * Holdr's process-ownership rule (start-finance-mac.sh `owns_process`, :44-58 at 8b7a9ca), for the API: owned by this user,
 * working directory `<tree>/apps/api`, command line naming `<tree>/node_modules/` and `src/index.ts`.
 */
export async function ownsApiProcess(run: Runner, pid: number, root = repoPaths().root): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const ps = await run('/bin/ps', ['-o', 'uid=', '-o', 'command=', '-p', String(pid)]);
  if (ps.exitCode !== 0) return false;
  const match = /^\s*(\d+)\s+(.*)$/.exec(ps.stdout.trim());
  if (!match || Number(match[1]) !== process.getuid?.()) return false;
  const command = match[2];
  if (!command.includes(`${root}/node_modules/`) || !command.includes('src/index.ts')) return false;
  const cwd = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (cwd.exitCode !== 0) return false;
  const directory = cwd.stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1);
  return directory === `${root}/apps/api`;
}

/** PIDs of this user's processes with a Unix socket bound to `socketPath` (`lsof -U`). */
export async function socketHolders(run: Runner, socketPath: string): Promise<number[] | null> {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const result = await run('/usr/sbin/lsof', ['-nP', '-a', '-U', '-u', String(uid), '-F', 'pn']);
  if (result.exitCode !== 0 && result.exitCode !== 1) return null;
  const pids = new Set<number>();
  let pid = 0;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && line.slice(1) === socketPath && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** K28 preflight phase: a live socket is accepted only when every holder is the running API of this tree. */
export function runningApiOwns(run: Runner, socketPath: string, root = repoPaths().root) {
  return async (): Promise<boolean> => {
    const pids = await socketHolders(run, socketPath);
    if (!pids || pids.length === 0) return false;
    for (const pid of pids) if (!await ownsApiProcess(run, pid, root)) return false;
    return true;
  };
}
