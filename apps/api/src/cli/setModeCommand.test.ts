import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfiguration, parseHoldrConf, readHoldrConf } from '../control/holdrConf.js';
import { captureIo } from '../control/testControl.js';
import { scratchDir, writePrivate } from '../control/testDirs.js';
import { resolveIngressConfig } from '../ingress/config.js';
import { runSetMode, serializeConf, targetValues } from './setModeCommand.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const D = 'ab'.repeat(32);
const D2 = 'cd'.repeat(32);
const DIST = [
  'HOLDR_WEB_MODE=dist', 'HOLDR_PUBLIC_ORIGIN=https://holdr.example.ts.net', `HOLDR_WEB_RELEASE=${D}`,
  'HOLDR_DATA_DIR=/Users/sample2/Holdr/data', 'HOLDR_CONTROL_DIR=/Users/sample2/Library/Application Support/Holdr/control',
  'HOLDR_SERVE_SOCKET=/Users/sample2/Library/Application Support/Holdr/run/ingress.sock', 'HOLDR_TAILSCALE_CLI=/opt/homebrew/bin/tailscale',
  'HOLDR_DEVICE_API=0', 'HOLDR_LEGACY_VITE_ROLLBACK=1', `HOLDR_NATIVE_COMMIT=${'c'.repeat(40)}`, `HOLDR_NATIVE_MANIFEST=${'d'.repeat(64)}`, '',
].join('\n');

function setup(text = DIST) {
  const dir = scratchDir('mode');
  cleanups.push(dir.cleanup);
  const file = path.join(dir.dir, 'holdr.conf');
  writePrivate(file, text);
  const env = { HOLDR_CONFIG: file };
  const run = (argv: string[]) => {
    const capture = captureIo();
    const code = runSetMode(argv, env, capture.io, () => new Date('2026-10-17T13:00:00.000Z'));
    return { code, out: capture.out(), err: capture.err() };
  };
  const values = () => readHoldrConf(file).values;
  return { dir: dir.dir, file, env, run, values };
}

/** What the API would make of the written file: A's rules for the mode, as `index.ts` applies them. */
const apiConfig = (env: NodeJS.ProcessEnv, nodeEnv = 'production') => resolveIngressConfig({ ...loadConfiguration(env).env, NODE_ENV: nodeEnv });

describe.skipIf(process.platform === 'win32')('holdr-ingress set-mode (§3.3, R2-7)', () => {
  it('dist -> local: the complete local key set, dist-only keys gone, the previous file kept as holdr.conf.dist', () => {
    const t = setup();
    const result = t.run(['local']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('holdr.conf: dist -> local (release abababababab)');
    expect(t.values()).toEqual({
      HOLDR_WEB_MODE: 'local', HOLDR_WEB_RELEASE: D, HOLDR_DATA_DIR: '/Users/sample2/Holdr/data',
      HOLDR_CONTROL_DIR: '/Users/sample2/Library/Application Support/Holdr/control', HOLDR_TAILSCALE_CLI: '/opt/homebrew/bin/tailscale',
      HOLDR_DEVICE_API: '0', HOLDR_LEGACY_VITE_ROLLBACK: '1', HOLDR_NATIVE_COMMIT: 'c'.repeat(40), HOLDR_NATIVE_MANIFEST: 'd'.repeat(64),
    });
    expect(fs.readFileSync(path.join(t.dir, 'holdr.conf.dist'), 'utf8')).toBe(DIST);
    for (const name of ['holdr.conf', 'holdr.conf.dist']) expect(fs.statSync(path.join(t.dir, name)).mode & 0o777).toBe(0o600);
    expect(apiConfig(t.env)).toMatchObject({ mode: 'local', ingressPort: 8888 });
    expect(fs.readdirSync(t.dir).sort()).toEqual(['holdr.conf', 'holdr.conf.dist']);
  });

  it('local -> dist restores origin, socket and the device setting from holdr.conf.dist', () => {
    const t = setup();
    t.run(['local']);
    const result = t.run(['dist']);
    expect(result.code, result.err).toBe(0);
    const values = t.values();
    expect(values).toMatchObject({
      HOLDR_WEB_MODE: 'dist', HOLDR_PUBLIC_ORIGIN: 'https://holdr.example.ts.net', HOLDR_WEB_RELEASE: D,
      HOLDR_SERVE_SOCKET: '/Users/sample2/Library/Application Support/Holdr/run/ingress.sock', HOLDR_DEVICE_API: '0',
    });
    expect(apiConfig(t.env)).toMatchObject({ mode: 'dist', publicOrigin: 'https://holdr.example.ts.net' });
  });

  it('vite needs --legacy-rollback and the legacy key; it carries no release, CLI, socket or origin; dist comes back from the companion', () => {
    const t = setup();
    expect(t.run(['vite']).code).toBe(64);
    const result = t.run(['vite', '--legacy-rollback']);
    expect(result.code, result.err).toBe(0);
    expect(t.values()).toEqual({
      HOLDR_WEB_MODE: 'vite', HOLDR_DATA_DIR: '/Users/sample2/Holdr/data',
      HOLDR_CONTROL_DIR: '/Users/sample2/Library/Application Support/Holdr/control', HOLDR_LEGACY_VITE_ROLLBACK: '1',
      HOLDR_NATIVE_COMMIT: 'c'.repeat(40), HOLDR_NATIVE_MANIFEST: 'd'.repeat(64),
    });
    expect(apiConfig(t.env, 'development')).toMatchObject({ mode: 'dev' });
    expect(t.run(['dist']).code).toBe(0);
    expect(fs.readFileSync(t.file, 'utf8').split('\n').filter((line) => line.startsWith('HOLDR_')).sort())
      .toEqual(DIST.split('\n').filter(Boolean).sort());
  });

  it('after AL1 sign-off (no legacy key) vite is refused with E0I_TCP_TARGET_RETIRED and nothing changes', () => {
    const t = setup(DIST.replace('HOLDR_LEGACY_VITE_ROLLBACK=1\n', ''));
    const before = fs.readFileSync(t.file, 'utf8');
    const result = t.run(['vite', '--legacy-rollback']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('E0I_TCP_TARGET_RETIRED');
    expect(fs.readFileSync(t.file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(t.dir, 'holdr.conf.dist'))).toBe(false);
  });

  it('a retirement in the current file survives a stale companion: no mode or release change brings the legacy key back (B2 review 7)', () => {
    const t = setup();
    // dist -> local -> dist leaves a companion that still carries the legacy key; AL1 sign-off then removes it from holdr.conf.
    expect(t.run(['local']).code).toBe(0);
    expect(t.run(['dist']).code).toBe(0);
    expect(fs.readFileSync(path.join(t.dir, 'holdr.conf.dist'), 'utf8')).toContain('HOLDR_LEGACY_VITE_ROLLBACK=1');
    fs.writeFileSync(t.file, fs.readFileSync(t.file, 'utf8').replace(/^HOLDR_LEGACY_VITE_ROLLBACK=1\n/m, ''), { mode: 0o600 });
    for (const argv of [['dist', '--release', D2], ['dist'], ['local'], ['dist']]) {
      const result = t.run(argv);
      expect(result.code, `${argv.join(' ')}: ${result.err}`).toBe(0);
      expect(t.values().HOLDR_LEGACY_VITE_ROLLBACK, argv.join(' ')).toBeUndefined();
    }
    const refused = t.run(['vite', '--legacy-rollback']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('E0I_TCP_TARGET_RETIRED');
    expect(t.values()).toMatchObject({ HOLDR_WEB_MODE: 'dist', HOLDR_WEB_RELEASE: D2 });
  });

  it('the native pins come from the current file only; the companion restores only what leaving dist or vite dropped', () => {
    const t = setup();
    expect(t.run(['vite', '--legacy-rollback']).code).toBe(0);
    // vite dropped the release and the CLI (B-D18): dist restores them, and origin, socket and device setting, from the companion.
    expect(t.run(['dist']).code).toBe(0);
    expect(t.values()).toMatchObject({ HOLDR_WEB_RELEASE: D, HOLDR_TAILSCALE_CLI: '/opt/homebrew/bin/tailscale' });
    expect(t.run(['local']).code).toBe(0);
    fs.writeFileSync(t.file, fs.readFileSync(t.file, 'utf8').replace(/^HOLDR_NATIVE_(COMMIT|MANIFEST)=.*\n/gm, ''), { mode: 0o600 });
    expect(t.run(['dist']).code).toBe(0);
    expect(t.values().HOLDR_NATIVE_COMMIT).toBeUndefined();
    expect(t.values().HOLDR_NATIVE_MANIFEST).toBeUndefined();
  });

  it('--release changes only the release; invalid values and options refuse and leave the file unchanged', () => {
    const t = setup();
    expect(t.run(['dist', '--release', D2]).code).toBe(0);
    expect(t.values()).toMatchObject({ HOLDR_WEB_RELEASE: D2, HOLDR_PUBLIC_ORIGIN: 'https://holdr.example.ts.net' });
    expect(fs.existsSync(path.join(t.dir, 'holdr.conf.dist'))).toBe(false);
    const before = fs.readFileSync(t.file, 'utf8');
    for (const argv of [['dist', '--release', 'abc'], ['dist', '--origin', 'http://holdr.example.ts.net'], ['local', '--origin', 'https://node8.example.ts.net'],
      ['dist', '--socket', 'relative/s'], ['paused'], ['dist', '--release']]) {
      const result = t.run(argv);
      expect(result.code, argv.join(' ')).not.toBe(0);
      expect(result.err).toContain('holdr.conf unchanged');
    }
    expect(fs.readFileSync(t.file, 'utf8')).toBe(before);
  });

  it('dist without a companion needs --origin and --socket; without a holdr.conf it refuses', () => {
    const t = setup(DIST.replace('HOLDR_WEB_MODE=dist', 'HOLDR_WEB_MODE=local').replace(/HOLDR_PUBLIC_ORIGIN=.*\n/, '').replace(/HOLDR_SERVE_SOCKET=.*\n/, ''));
    expect(t.run(['dist']).err).toContain('E0I_CONFIG_FILE');
    const result = t.run(['dist', '--origin', 'https://holdr.example.ts.net', '--socket', '/Users/sample2/run/ingress.sock']);
    expect(result.code, result.err).toBe(0);
    expect(apiConfig(t.env)).toMatchObject({ mode: 'dist', socketPath: '/Users/sample2/run/ingress.sock' });
    const capture = captureIo();
    expect(runSetMode(['local'], { HOLDR_CONFIG: path.join(t.dir, 'absent.conf') }, capture.io)).toBe(1);
    expect(capture.err()).toContain('E0I_CONFIG_FILE');
  });
});

// O93: the metals prices switch is mode-independent: every mode keeps it from the current file, and the file written
// carries it, so a mode change never silently turns prices off.
describe('set-mode keeps HOLDR_METALS_PRICES (O93)', () => {
  it('every target mode keeps it from the current file, and the file written carries it', () => {
    const current = parseHoldrConf(`${DIST}HOLDR_METALS_PRICES=1\n`);
    for (const [target, options] of [['local', {}], ['dist', {}], ['vite', { legacyRollback: true }]] as const) {
      const values = targetValues(target, current, null, options);
      expect(values.HOLDR_METALS_PRICES, target).toBe('1');
      expect(serializeConf(values, 'test').split('\n'), target).toContain('HOLDR_METALS_PRICES=1');
    }
    expect(targetValues('local', parseHoldrConf(DIST), null, {}).HOLDR_METALS_PRICES).toBeUndefined();
  });
});

// The owner's metals assignment policy is mode-independent too: a mode change never silently drops it.
describe('set-mode keeps HOLDR_METALS_FUNGIBLE', () => {
  it('every target mode keeps it from the current file, and the file written carries it', () => {
    const current = parseHoldrConf(`${DIST}HOLDR_METALS_PRICES=1\nHOLDR_METALS_FUNGIBLE=XAU\n`);
    for (const [target, options] of [['local', {}], ['dist', {}], ['vite', { legacyRollback: true }]] as const) {
      const values = targetValues(target, current, null, options);
      expect(values.HOLDR_METALS_FUNGIBLE, target).toBe('XAU');
      const lines = serializeConf(values, 'test').split('\n');
      expect(lines, target).toContain('HOLDR_METALS_FUNGIBLE=XAU');
      expect(lines.indexOf('HOLDR_METALS_FUNGIBLE=XAU'), target).toBe(lines.indexOf('HOLDR_METALS_PRICES=1') + 1);
    }
    expect(targetValues('local', parseHoldrConf(DIST), null, {}).HOLDR_METALS_FUNGIBLE).toBeUndefined();
  });
});

// The owner's estimate switch is mode-independent too, written right after the fungible policy.
describe('set-mode keeps HOLDR_METALS_ESTIMATE_UNMATCHED', () => {
  it('every target mode keeps it from the current file, and the file written carries it', () => {
    const current = parseHoldrConf(`${DIST}HOLDR_METALS_PRICES=1\nHOLDR_METALS_FUNGIBLE=XAU\nHOLDR_METALS_ESTIMATE_UNMATCHED=XAU\n`);
    for (const [target, options] of [['local', {}], ['dist', {}], ['vite', { legacyRollback: true }]] as const) {
      const values = targetValues(target, current, null, options);
      expect(values.HOLDR_METALS_ESTIMATE_UNMATCHED, target).toBe('XAU');
      const lines = serializeConf(values, 'test').split('\n');
      expect(lines.indexOf('HOLDR_METALS_ESTIMATE_UNMATCHED=XAU'), target).toBe(lines.indexOf('HOLDR_METALS_FUNGIBLE=XAU') + 1);
    }
    const alone = targetValues('local', parseHoldrConf(`${DIST}HOLDR_METALS_ESTIMATE_UNMATCHED=XAU,XAG\n`), null, {});
    expect([alone.HOLDR_METALS_ESTIMATE_UNMATCHED, alone.HOLDR_METALS_FUNGIBLE]).toEqual(['XAU,XAG', undefined]);
    expect(targetValues('local', parseHoldrConf(DIST), null, {}).HOLDR_METALS_ESTIMATE_UNMATCHED).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('set-mode keeps HOLDR_METALS_PRICES in the file (O93)', () => {
  it('dist -> local -> dist keeps HOLDR_METALS_PRICES=1', () => {
    const t = setup(`${DIST}HOLDR_METALS_PRICES=1\n`);
    expect(t.run(['local']).code).toBe(0);
    expect(t.values().HOLDR_METALS_PRICES).toBe('1');
    expect(t.run(['dist']).code).toBe(0);
    expect(t.values().HOLDR_METALS_PRICES).toBe('1');
  });
});
