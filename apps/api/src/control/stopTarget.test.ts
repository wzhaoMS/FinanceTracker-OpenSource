import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runStopRole } from './maintenance.js';
import { outsideRepoDir } from './testControl.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/**
 * A HOME with the live tree T, a staging tree (`holdr-staging/C/FinanceTracker` beside its holdr.conf) and a rollback kit,
 * each tree with a stand-in `scripts/holdr-stop.sh` that records its arguments: what the recovery commands' stop role is
 * aimed at, without stopping anything.
 */
function layout() {
  const outer = outsideRepoDir('stop');
  cleanups.push(outer.cleanup);
  const home = outer.dir;
  const record = path.join(home, 'stop-calls');
  const tree = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts/holdr-stop.sh'), `printf '%s %s\\n' "$0" "$*" >> "$STOP_RECORD"\n`);
    return dir;
  };
  const T = tree(path.join(home, 'Holdr/FinanceTracker'));
  const stage = path.join(home, 'holdr-staging/C');
  const C = tree(path.join(stage, 'FinanceTracker'));
  fs.writeFileSync(path.join(stage, 'holdr.conf'), 'HOLDR_WEB_MODE=dist\n', { mode: 0o600 });
  const kr = path.join(home, 'holdr-rollback/20261018T000000Z');
  const K = tree(path.join(kr, 'FinanceTracker'));
  fs.writeFileSync(path.join(kr, 'holdr.conf'), 'HOLDR_WEB_MODE=dist\n', { mode: 0o600 });
  fs.writeFileSync(path.join(kr, 'kit-runtime.txt'), 'node x\n', { mode: 0o600 });
  const env = { HOME: home, STOP_RECORD: record, PATH: '/usr/bin:/bin' };
  const calls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '');
  return { home, T, stage, C, kr, K, env, calls };
}

const outcome = async (fn: () => Promise<number>) => {
  try { return { code: await fn() }; } catch (error) { return { error: (error as { code?: string }).code } as const; }
};

describe.skipIf(process.platform === 'win32')('the recovery stop role is aimed at the managed live deployment (B1 round-3 finding 2)', () => {
  it('from the staging tree or a kit, HOLDR_ROOT unset: this tree\'s stopper with --root the live deployment, never its own parent', async () => {
    const t = layout();
    const log: string[] = [];
    for (const code of [t.C, t.K, t.T]) {
      expect(await runStopRole(t.env, null, (line) => log.push(line), code)).toBe(0);
    }
    // Each tree's own stopper (the one it ships), always aimed at T's parent.
    const root = path.dirname(t.T);
    expect(t.calls()).toBe([t.C, t.K, t.T].map((tree) => `${path.join(tree, 'scripts/holdr-stop.sh')} --root ${root}\n`).join(''));
    expect(log.filter((line) => line.startsWith(`holdr-stop --root ${root}: the managed live deployment (${fs.realpathSync(t.T)})`))).toHaveLength(3);
  });

  it('HOLDR_ROOT naming a staging tree, a kit, a link into one, or nothing: refused before any stopper runs', async () => {
    const t = layout();
    const linked = path.join(t.home, 'linked-root');
    fs.mkdirSync(linked);
    fs.symlinkSync(t.C, path.join(linked, 'FinanceTracker'));
    for (const HOLDR_ROOT of [t.stage, t.kr, linked, path.join(t.home, 'missing'), 'relative']) {
      expect(await outcome(() => runStopRole({ ...t.env, HOLDR_ROOT }, null, () => {}, t.C)), HOLDR_ROOT).toEqual({ error: 'E0I_NOT_LIVE' });
    }
    // A staging marker beside the default live tree: refused too, not taken for "no live tree".
    fs.writeFileSync(path.join(path.dirname(t.T), 'holdr.conf'), '', { mode: 0o600 });
    expect(await outcome(() => runStopRole(t.env, null, () => {}, t.C))).toEqual({ error: 'E0I_NOT_LIVE' });
    expect(t.calls()).toBe('');
  });

  it('no managed live tree at all (a development checkout): skipped, the drain and the database guard decide', async () => {
    const t = layout();
    const log: string[] = [];
    expect(await runStopRole({ ...t.env, HOME: path.join(t.home, 'elsewhere') }, null, (line) => log.push(line), t.C)).toBe(0);
    expect(log).toEqual([expect.stringMatching(/^holdr-stop skipped: no managed live tree/)]);
    expect(t.calls()).toBe('');
  });
});
