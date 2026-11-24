import type { Runner } from './runner.js';

export interface Holder { readonly pid: number; readonly command: string }

/**
 * `lsof -nP -F pc` output, parsed completely (B1 round-2 finding 4): one process set per `p<pid>` line, exactly one
 * `c<command>` line after it, then at least one `f<descriptor>` line. Anything else (a stray line, a missing field, no final
 * newline) is null: an answer that cannot be read is never "no holders".
 */
export function parseHolders(stdout: string): Holder[] | null {
  if (stdout === '') return [];
  if (!stdout.endsWith('\n')) return null;
  const holders: Holder[] = [];
  let current: { pid: number; command?: string; files: number } | null = null;
  const close = () => {
    if (!current) return true;
    if (current.command === undefined || current.files === 0) return false;
    if (!holders.some((holder) => holder.pid === current!.pid)) holders.push({ pid: current.pid, command: current.command });
    return true;
  };
  for (const line of stdout.slice(0, -1).split('\n')) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        if (!close() || !/^[1-9][0-9]{0,9}$/.test(value)) return null;
        current = { pid: Number(value), files: 0 };
        break;
      case 'c':
        if (!current || current.command !== undefined || current.files > 0) return null;
        current.command = value;
        break;
      case 'f':
        if (!current || current.command === undefined || !/^[A-Za-z0-9]+$/.test(value)) return null;
        current.files += 1;
        break;
      default:
        return null;
    }
  }
  return close() ? holders : null;
}

/**
 * Processes holding `files` open (`lsof -nP -F pc`): pid and short command name only, or null when that is unknown.
 *
 * - `self: true`, for a caller that holds one of `files` open itself (a maintenance holder and its `lifecycle.lock`): the
 *   answer counts only when lsof succeeded, parsed completely and lists this process. An empty answer cannot show that no
 *   one else holds the file: it shows that lsof saw nothing.
 * - otherwise, where no holder is expected (quiescence before a rebuild, the database before maintenance work): exit 1 with no
 *   output is "none", and anything that does not parse completely is null.
 */
export async function openHolders(run: Runner, files: readonly string[], options: { self?: boolean } = {}): Promise<Holder[] | null> {
  if (files.length === 0) return options.self ? null : [];
  const result = await run('/usr/sbin/lsof', ['-nP', '-F', 'pc', '--', ...files]);
  if (options.self) {
    if (result.exitCode !== 0) return null;
    const holders = parseHolders(result.stdout);
    return holders && holders.some((holder) => holder.pid === process.pid) ? holders : null;
  }
  if (result.exitCode === 1 && result.stdout === '') return [];
  if (result.exitCode !== 0) return null;
  return parseHolders(result.stdout);
}

export function formatHolders(holders: readonly Holder[]): string {
  return holders.length ? holders.map((holder) => `${holder.pid} ${holder.command}`).join(', ') : 'none';
}
