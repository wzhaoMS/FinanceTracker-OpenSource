import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DISPOSABLE_MARKER } from '../e2e/syntheticSeed.js';
import { DISPOSABLE_MARKER_NAME, disposableStackFacts, isManagedLiveSelf, kitRoot, leaveTarget, nonLiveLayout } from './leaveTarget.js';
import { REPO_ROOT, managedLive, managedLiveRoot } from './paths.js';
import { outsideRepoDir } from './testControl.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** A HOME with the live tree, a rollback kit KR (K, KC, kit-runtime.txt) and its snapshot SNAP, as §11.3 lays them out. */
function layout() {
  const outer = outsideRepoDir('leave');
  cleanups.push(outer.cleanup);
  const home = outer.dir;
  const tree = path.join(home, 'Holdr/FinanceTracker');
  const kr = path.join(home, 'holdr-rollback/20261017T130000Z');
  const k = path.join(kr, 'FinanceTracker');
  const snap = path.join(home, 'holdr-snapshots/20261017T130000Z');
  for (const dir of [tree, k, snap, path.join(home, 'Library/Application Support/Holdr')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(kr, 'holdr.conf'), 'HOLDR_WEB_MODE=dist\nHOLDR_WEB_RELEASE=new\n', { mode: 0o600 });
  fs.writeFileSync(path.join(kr, 'kit-runtime.txt'), 'node x\n', { mode: 0o600 });
  const live = path.join(home, 'Library/Application Support/Holdr/holdr.conf');
  const env = { HOME: home };
  return { home, tree, kr, k, snap, live, env, kc: path.join(kr, 'holdr.conf') };
}

describe.skipIf(process.platform === 'win32')('what a leave validates (B1 review 2, B-D36)', () => {
  it('outside a kit: exactly the named target; the running tree only as the managed live tree with the live configuration', () => {
    const t = layout();
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code; } };
    expect(kitRoot(REPO_ROOT)).toBeNull();
    const named = ['--snap', '/s', '--target-root', '/t', '--target-config', 'none'];
    expect(leaveTarget({}, null, named)).toEqual({ kind: 'explicit', args: named });
    // B1 round-2 finding 3: no fallback to the running tree. A checkout that is not the managed live tree validates nothing.
    expect(code(() => leaveTarget({}, null, []))).toBe('E0I_LEAVE_TARGET');
    expect(code(() => leaveTarget(t.env, null, []))).toBe('E0I_LEAVE_TARGET');
    // The managed live tree validates itself with the live configuration, or with none while none exists.
    expect(leaveTarget(t.env, null, [], t.tree)).toEqual({ kind: 'self', args: [], as: 'live' });
    expect(leaveTarget({ ...t.env, HOLDR_ROOT: path.dirname(t.tree) }, null, [], t.tree)).toMatchObject({ kind: 'self', as: 'live' });
    fs.writeFileSync(t.live, 'HOLDR_WEB_MODE=dist\n', { mode: 0o600 });
    expect(code(() => leaveTarget(t.env, null, [], t.tree)), 'the live configuration exists, but this run has none').toBe('E0I_LEAVE_TARGET');
    expect(leaveTarget(t.env, t.live, [], t.tree)).toMatchObject({ kind: 'self', as: 'live' });
    expect(code(() => leaveTarget(t.env, t.kc, [], t.tree)), 'another configuration').toBe('E0I_LEAVE_TARGET');
    // HOLDR_ROOT naming another tree: this one is not the managed live tree.
    expect(code(() => leaveTarget({ ...t.env, HOLDR_ROOT: t.home }, t.live, [], t.tree))).toBe('E0I_LEAVE_TARGET');
    // A verified disposable stack (the caller's full check) validates itself.
    expect(leaveTarget({}, null, [], REPO_ROOT, { disposable: true })).toEqual({ kind: 'self', args: [], as: 'disposable' });
  });

  it('a kit with incomplete metadata, or a staging tree, never validates itself, even when its configuration names live state (B1 round-2 finding 3)', () => {
    const t = layout();
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code; } };
    fs.copyFileSync(t.kc, t.live);
    fs.rmSync(path.join(t.kr, 'kit-runtime.txt'));
    expect(kitRoot(t.k)).toBeNull();
    for (const config of [t.kc, t.live, null]) {
      expect(code(() => leaveTarget(t.env, config, [], t.k)), String(config)).toBe('E0I_LEAVE_TARGET');
      expect(code(() => leaveTarget(t.env, config, [], t.k, { disposable: true })), String(config)).toBe('E0I_LEAVE_TARGET');
    }
    // A staging tree: FinanceTracker next to its candidate holdr.conf.
    const stage = path.join(t.home, 'holdr-staging/C');
    fs.mkdirSync(path.join(stage, 'FinanceTracker'), { recursive: true });
    fs.copyFileSync(t.kc, path.join(stage, 'holdr.conf'));
    expect(code(() => leaveTarget(t.env, path.join(stage, 'holdr.conf'), [], path.join(stage, 'FinanceTracker')))).toBe('E0I_LEAVE_TARGET');
    expect(code(() => leaveTarget(t.env, t.live, [], path.join(stage, 'FinanceTracker')))).toBe('E0I_LEAVE_TARGET');
  });

  it('B1 round-3 finding 1: HOLDR_ROOT never makes a staging tree or an incomplete kit the live tree; the layout refuses first', () => {
    const t = layout();
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code; } };
    fs.copyFileSync(t.kc, t.live);
    const stage = path.join(t.home, 'holdr-staging/C');
    const C = path.join(stage, 'FinanceTracker');
    fs.mkdirSync(C, { recursive: true });
    fs.copyFileSync(t.kc, path.join(stage, 'holdr.conf'));
    // The review's repro: the staging tree's CLI, HOLDR_ROOT naming the staging parent, the real live configuration. Before the
    // fix this was {kind:'self', as:'live'} and the leased role (isManagedLiveSelf) validated the staging release.
    for (const config of [t.live, path.join(stage, 'holdr.conf'), null]) {
      expect(code(() => leaveTarget({ ...t.env, HOLDR_ROOT: stage }, config, [], C)), String(config)).toBe('E0I_LEAVE_TARGET');
      expect(code(() => leaveTarget({ ...t.env, HOLDR_ROOT: stage }, config, [], C, { disposable: true })), String(config)).toBe('E0I_LEAVE_TARGET');
      expect(isManagedLiveSelf({ ...t.env, HOLDR_ROOT: stage }, config, C), String(config)).toBe(false);
    }
    expect(nonLiveLayout(C)).toBe(stage);
    // Through a link: HOLDR_ROOT names a clean directory whose FinanceTracker is the staging tree.
    const linked = path.join(t.home, 'linked-root');
    fs.mkdirSync(linked);
    fs.symlinkSync(C, path.join(linked, 'FinanceTracker'));
    expect(isManagedLiveSelf({ ...t.env, HOLDR_ROOT: linked }, t.live, C)).toBe(false);
    expect(code(() => leaveTarget({ ...t.env, HOLDR_ROOT: linked }, t.live, [], C))).toBe('E0I_LEAVE_TARGET');
    // An incomplete kit (either pinned file missing), HOLDR_ROOT naming the kit root KR: the same refusal.
    for (const missing of ['kit-runtime.txt', 'holdr.conf']) {
      const kept = fs.readFileSync(path.join(t.kr, missing));
      fs.rmSync(path.join(t.kr, missing));
      expect(kitRoot(t.k), missing).toBeNull();
      for (const config of [t.live, t.kc, null]) {
        expect(code(() => leaveTarget({ ...t.env, HOLDR_ROOT: t.kr }, config, [], t.k)), `${missing} ${config}`).toBe('E0I_LEAVE_TARGET');
        expect(isManagedLiveSelf({ ...t.env, HOLDR_ROOT: t.kr }, config, t.k), `${missing} ${config}`).toBe(false);
      }
      fs.writeFileSync(path.join(t.kr, missing), kept, { mode: 0o600 });
    }
    // A dangling link named holdr.conf marks a staging tree too.
    fs.rmSync(path.join(stage, 'holdr.conf'));
    fs.symlinkSync(path.join(t.home, 'nowhere'), path.join(stage, 'holdr.conf'));
    expect(code(() => leaveTarget({ ...t.env, HOLDR_ROOT: stage }, t.live, [], C))).toBe('E0I_LEAVE_TARGET');
    // The refusal names the live deployment as the explicit target (§11.2 step 5).
    let message = '';
    try { leaveTarget(t.env, t.live, [], C); } catch (error) { message = (error as { detail?: string }).detail ?? ''; }
    expect(message).toContain(`--target-root ${fs.realpathSync(t.tree)}`);
    expect(message).toContain(`rollback-kit.sh snapshot --snap <SNAP> --tree ${fs.realpathSync(t.tree)}`);
    // The managed live tree itself still validates itself.
    expect(leaveTarget({ ...t.env, HOLDR_ROOT: path.dirname(t.tree) }, t.live, [], t.tree)).toMatchObject({ kind: 'self', as: 'live' });
    // A named target is exactly that, unless it is a staging tree or a kit standing in for the live deployment.
    const named = (root: string) => ['--snap', t.snap, '--target-root', root, '--target-config', 'none'];
    expect(leaveTarget(t.env, path.join(stage, 'holdr.conf'), named(t.tree), C)).toEqual({ kind: 'explicit', args: named(t.tree) });
    for (const root of [C, t.k, path.join(linked, 'FinanceTracker')]) {
      expect(code(() => leaveTarget(t.env, path.join(stage, 'holdr.conf'), named(root), C)), root).toBe('E0I_LEAVE_TARGET');
    }
  });

  it('managedLive: HOLDR_ROOT or the default, by physical path; a staging or kit layout, a relative or missing root refuse (E0I_NOT_LIVE)', () => {
    const t = layout();
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code; } };
    const base = path.dirname(t.tree);
    expect(managedLive(t.env)).toEqual({ base, tree: fs.realpathSync(t.tree) });
    expect(managedLive({ ...t.env, HOLDR_ROOT: base })).toEqual({ base, tree: fs.realpathSync(t.tree) });
    // No default and no HOLDR_ROOT: none (a development checkout); managedLiveRoot falls back to the code tree only then.
    expect(managedLive({ HOME: path.join(t.home, 'elsewhere') })).toBeNull();
    expect(managedLive({})).toBeNull();
    expect(managedLiveRoot({ HOME: path.join(t.home, 'elsewhere') }, '/code')).toBe('/code');
    for (const root of [t.kr, path.join(t.home, 'missing'), 'relative/root', `${base}/`]) {
      expect(code(() => managedLive({ ...t.env, HOLDR_ROOT: root })), root).toBe('E0I_NOT_LIVE');
      expect(code(() => managedLiveRoot({ ...t.env, HOLDR_ROOT: root }, '/code')), root).toBe('E0I_NOT_LIVE');
    }
    // Beside the default tree: refused, never treated as absent.
    for (const name of ['holdr.conf', 'kit-runtime.txt']) {
      fs.writeFileSync(path.join(base, name), '', { mode: 0o600 });
      expect(code(() => managedLive(t.env)), name).toBe('E0I_NOT_LIVE');
      expect(code(() => managedLiveRoot(t.env, '/code')), name).toBe('E0I_NOT_LIVE');
      fs.rmSync(path.join(base, name));
    }
    // The physical parent counts: a clean HOLDR_ROOT whose FinanceTracker links into a staging tree.
    const stage = path.join(t.home, 'holdr-staging/C');
    fs.mkdirSync(path.join(stage, 'FinanceTracker'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'holdr.conf'), '', { mode: 0o600 });
    const linked = path.join(t.home, 'linked-root');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(stage, 'FinanceTracker'), path.join(linked, 'FinanceTracker'));
    expect(code(() => managedLive({ ...t.env, HOLDR_ROOT: linked }))).toBe('E0I_NOT_LIVE');
    expect(managedLive(t.env)).toEqual({ base, tree: fs.realpathSync(t.tree) });
  });

  it('the leased role\'s disposable facts: a run identity, HOLDR_CONFIG=none and the seed\'s marker, a private file of this user', () => {
    const t = layout();
    const data = path.join(t.home, 'disposable');
    fs.mkdirSync(data, { mode: 0o700 });
    const env = { HOLDR_E2E_RUN_ID: 'a'.repeat(32), HOLDR_CONFIG: 'none' };
    expect(disposableStackFacts(env, null, data)).toBe(false);
    fs.writeFileSync(path.join(data, DISPOSABLE_MARKER_NAME), '', { mode: 0o600 });
    expect(disposableStackFacts(env, null, data)).toBe(true);
    expect(disposableStackFacts({ ...env, HOLDR_E2E_RUN_ID: 'x' }, null, data)).toBe(false);
    expect(disposableStackFacts({ ...env, HOLDR_CONFIG: undefined }, null, data)).toBe(false);
    expect(disposableStackFacts(env, '/some/holdr.conf', data)).toBe(false);
    fs.linkSync(path.join(data, DISPOSABLE_MARKER_NAME), path.join(t.home, 'second-link'));
    expect(disposableStackFacts(env, null, data), 'a hard-linked marker').toBe(false);
    expect(DISPOSABLE_MARKER_NAME).toBe(DISPOSABLE_MARKER);
  });

  it('from a kit: the live tree with its own code when the live configuration is the kit\'s; the revert target when it is the snapshot\'s', () => {
    const t = layout();
    expect(kitRoot(t.k)).toBe(t.kr);
    fs.copyFileSync(t.kc, t.live);
    expect(leaveTarget(t.env, t.kc, [], t.k)).toEqual({ kind: 'live', root: fs.realpathSync(t.tree), config: t.live });
    fs.writeFileSync(path.join(t.snap, 'holdr.conf'), 'HOLDR_WEB_MODE=dist\nHOLDR_WEB_RELEASE=old\n', { mode: 0o600 });
    fs.copyFileSync(path.join(t.snap, 'holdr.conf'), t.live);
    expect(leaveTarget(t.env, t.kc, [], t.k)).toEqual({ kind: 'revert', args: [
      '--snap', t.snap, '--target-root', fs.realpathSync(t.tree), '--target-config', path.join(t.snap, 'holdr.conf')] });
    // The first deployment's revert: no live file, the snapshot recorded holdr.conf.absent.
    fs.rmSync(t.live);
    fs.rmSync(path.join(t.snap, 'holdr.conf'));
    fs.writeFileSync(path.join(t.snap, 'holdr.conf.absent'), '');
    expect(leaveTarget(t.env, t.kc, [], t.k)).toMatchObject({ kind: 'revert', args: expect.arrayContaining(['--target-config', 'none']) });
    // HOLDR_ROOT names the live tree's parent like everywhere else.
    expect(leaveTarget({ ...t.env, HOLDR_ROOT: path.dirname(t.tree) }, t.kc, [], t.k)).toMatchObject({ kind: 'revert' });
  });

  it('from a kit it refuses rather than validate the kit: another configuration, an unknown live configuration, no live tree', () => {
    const t = layout();
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code; } };
    expect(code(() => leaveTarget(t.env, t.live, [], t.k))).toBe('E0I_LEAVE_TARGET');
    expect(code(() => leaveTarget(t.env, null, [], t.k))).toBe('E0I_LEAVE_TARGET');
    fs.writeFileSync(t.live, 'HOLDR_WEB_MODE=dist\nHOLDR_WEB_RELEASE=other\n', { mode: 0o600 });
    expect(code(() => leaveTarget(t.env, t.kc, [], t.k))).toBe('E0I_LEAVE_TARGET');
    fs.copyFileSync(t.kc, t.live);
    expect(code(() => leaveTarget({ HOME: t.home, HOLDR_ROOT: path.join(t.home, 'nowhere') }, t.kc, [], t.k))).toBe('E0I_LEAVE_TARGET');
    // The kit itself is never the live tree.
    expect(code(() => leaveTarget({ HOME: t.home, HOLDR_ROOT: t.kr }, t.kc, [], t.k))).toBe('E0I_LEAVE_TARGET');
    expect(code(() => leaveTarget({}, t.kc, [], t.k))).toBe('E0I_LEAVE_TARGET');
    // Not a kit without both pinned files.
    fs.rmSync(path.join(t.kr, 'kit-runtime.txt'));
    expect(kitRoot(t.k)).toBeNull();
  });
});
