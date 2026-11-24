import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyHoldrConf, defaultConfPath, loadConfiguration, locateHoldrConf, parseHoldrConf, readDistCompanion, readHoldrConf,
  unknownHoldrNames,
} from './holdrConf.js';
import { REPO_ROOT, releaseDirFor } from './paths.js';
import { scratchDir, writePrivate } from './testDirs.js';
import { startConfig } from './startConfig.js';
import { metalsPricesEnabled } from '../providers/metalSpotBars.js';
import { metalsEstimateUnmatchedOf, metalsFungibleOf } from '../services/metalsRead/policy.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const scratch = () => { const s = scratchDir('conf'); cleanups.push(s.cleanup); return s.dir; };
const D = 'ab'.repeat(32);
/** The removed LAN modes' settings, as an older holdr.conf or environment held them (documentation addresses only). */
const LAN_SETTINGS = [
  ['HOLDR_LAN_HTTP', '1'], ['HOLDR_LAN_HTTPS_IP', '192.0.2.65'], ['HOLDR_LAN_HTTPS_CIDR', '192.0.2.0/24'],
  ['HOLDR_LAN_HTTPS_PORT', '8443'], ['HOLDR_LAN_HTTPS_CERT', '/private/holdr/leaf.pem'],
  ['HOLDR_LAN_HTTPS_KEY', '/private/holdr/leaf-key.pem'], ['HOLDR_LAN_HTTPS_CA', '/private/holdr/ca.pem'],
] as const;
/** The ControlError `fn` throws, as its code and detail. */
const refusal = (fn: () => unknown): { code?: string; detail?: string } => {
  try {
    fn();
  } catch (error) {
    return { code: (error as { code?: string }).code, detail: (error as { detail?: string }).detail };
  }
  return {};
};

describe('the removed LAN modes', () => {
  it.each(LAN_SETTINGS)('refuses %s as a holdr.conf line by its line and name, never its value', (name, value) => {
    const { code, detail } = refusal(() => parseHoldrConf(`HOLDR_WEB_MODE=vite\n${name}=${value}\n`, 'holdr.conf'));
    expect(code).toBe('E0I_LAN_REMOVED');
    expect(detail).toMatch(new RegExp(`^holdr\\.conf line 2: ${name} is no longer supported: .*Tailscale Serve`));
    expect(detail).not.toContain(value);
  });

  it.each(LAN_SETTINGS)('refuses %s from the environment, with or without a holdr.conf, and in the launcher', (name, value) => {
    const file = { path: '/private/holdr.conf', values: parseHoldrConf('HOLDR_WEB_MODE=local\n') };
    for (const conf of [null, file]) {
      const { code, detail } = refusal(() => applyHoldrConf({ [name]: value }, conf));
      expect(code).toBe('E0I_LAN_REMOVED');
      expect(detail).toMatch(new RegExp(`^${name} is no longer supported`));
    }
    const env = { HOLDR_CONFIG: 'none', HOLDR_E2E_RUN_ID: 'a'.repeat(32), [name]: value };
    // The Mac launcher accepts POSIX roots, regardless of the test host's checkout path.
    expect(refusal(() => startConfig(env, '/private/holdr/FinanceTracker', { webPort: 8888, apiPort: 4000 })).code).toBe('E0I_LAN_REMOVED');
  });

  it('accepts HOLDR_LAN_HTTP unset, empty or 0, which ask for no LAN mode, and logs none of them as unknown', () => {
    for (const value of [undefined, '', '0']) {
      const env = applyHoldrConf({ HOLDR_LAN_HTTP: value }, null);
      expect(env.HOLDR_LAN_HTTP).toBe(value);
      expect(unknownHoldrNames(env)).toEqual([]);
      const resolved = startConfig({ HOLDR_CONFIG: 'none', HOLDR_E2E_RUN_ID: 'a'.repeat(32), HOLDR_LAN_HTTP: value },
        '/private/holdr/FinanceTracker', { webPort: 8888, apiPort: 4000 });
      expect(resolved.mode).toBe('vite');
      expect(Object.keys(resolved).filter((key) => key.startsWith('lan'))).toEqual([]);
    }
    // The launcher's root is a POSIX path, whatever the test host is.
    expect(refusal(() => startConfig({ HOLDR_CONFIG: 'none', HOLDR_E2E_RUN_ID: 'a'.repeat(32) }, 'C:\\Holdr\\FinanceTracker',
      { webPort: 8888, apiPort: 4000 })).code).toBe('E0I_USAGE');
  });
});

const DIST = [
  '# Holdr start configuration. KEY=VALUE, one per line, no quotes, no spaces around "=".',
  'HOLDR_WEB_MODE=dist',
  'HOLDR_PUBLIC_ORIGIN=https://holdr.example.ts.net',
  `HOLDR_WEB_RELEASE=${D}`,
  'HOLDR_DATA_DIR=/Users/sample2/Holdr/data',
  'HOLDR_CONTROL_DIR=/Users/sample2/Library/Application Support/Holdr/control',
  'HOLDR_SERVE_SOCKET=/Users/sample2/Library/Application Support/Holdr/run/ingress.sock',
  'HOLDR_TAILSCALE_CLI=/opt/homebrew/bin/tailscale',
  'HOLDR_DEVICE_API=0',
  `HOLDR_NATIVE_COMMIT=${'c'.repeat(40)}`,
  `HOLDR_NATIVE_MANIFEST=${'d'.repeat(64)}`,
  '',
].join('\n');

describe('holdr.conf parser (§8.1)', () => {
  it('reads the documented file verbatim, spaces in paths included', () => {
    const values = parseHoldrConf(DIST);
    expect(values.HOLDR_DATA_DIR).toBe('/Users/sample2/Holdr/data');
    expect(values.HOLDR_WEB_RELEASE).toBe(D);
    expect(Object.isFrozen(values)).toBe(true);
  });

  it.each([
    ['CR line ending', 'HOLDR_WEB_MODE=dist\r\n'],
    ['NUL', 'HOLDR_WEB_MODE=dist\0\n'],
    ['quoted value', 'HOLDR_DATA_DIR="/x"\n'],
    ['space around =', 'HOLDR_WEB_MODE = dist\n'],
    ['export prefix', 'export HOLDR_WEB_MODE=dist\n'],
    ['unknown key', 'HOLDR_SOMETHING=1\n'],
    ['non-HOLDR key', 'PATH=/bin\n'],
    ['repeated key', 'HOLDR_WEB_MODE=dist\nHOLDR_WEB_MODE=dist\n'],
    ['bad mode', 'HOLDR_WEB_MODE=prod\n'],
    ['relative path', 'HOLDR_DATA_DIR=data\n'],
    ['trailing slash', 'HOLDR_DATA_DIR=/x/\n'],
    ['dot segment', 'HOLDR_DATA_DIR=/x/../y\n'],
    ['uppercase digest', `HOLDR_WEB_RELEASE=${D.toUpperCase()}\n`],
    ['short digest', 'HOLDR_WEB_RELEASE=abc\n'],
    ['device api 2', 'HOLDR_DEVICE_API=2\n'],
    ['http origin', 'HOLDR_PUBLIC_ORIGIN=http://node8.example.ts.net\n'],
    ['origin with path', 'HOLDR_PUBLIC_ORIGIN=https://node8.example.ts.net/\n'],
    ['low port', 'HOLDR_INGRESS_PORT=80\n'],
    ['legacy 0', 'HOLDR_LEGACY_VITE_ROLLBACK=0\n'],
    ['short commit', 'HOLDR_NATIVE_COMMIT=abc\n'],
    ['metals prices true', 'HOLDR_METALS_PRICES=true\n'],
    ['metals prices 2', 'HOLDR_METALS_PRICES=2\n'],
    ['metals prices empty', 'HOLDR_METALS_PRICES=\n'],
    ['metals fungible empty', 'HOLDR_METALS_FUNGIBLE=\n'],
    ['metals fungible lowercase', 'HOLDR_METALS_FUNGIBLE=xau\n'],
    ['metals fungible repeated metal', 'HOLDR_METALS_FUNGIBLE=XAU,XAU\n'],
    ['metals fungible space', 'HOLDR_METALS_FUNGIBLE=XAU, XAG\n'],
    ['metals fungible 1', 'HOLDR_METALS_FUNGIBLE=1\n'],
    ['metals estimate empty', 'HOLDR_METALS_ESTIMATE_UNMATCHED=\n'],
    ['metals estimate lowercase', 'HOLDR_METALS_ESTIMATE_UNMATCHED=xau\n'],
    ['metals estimate repeated metal', 'HOLDR_METALS_ESTIMATE_UNMATCHED=XAU,XAU\n'],
    ['metals estimate space', 'HOLDR_METALS_ESTIMATE_UNMATCHED=XAU, XAG\n'],
    ['metals estimate 1', 'HOLDR_METALS_ESTIMATE_UNMATCHED=1\n'],
    ['command substitution', 'HOLDR_DATA_DIR=$(touch /x)\n'],
  ])('refuses %s with E0I_CONFIG_FILE', (_name, text) => {
    expect(() => parseHoldrConf(text)).toThrow('E0I_CONFIG_FILE');
  });

  it('accepts comments, blank lines and a missing final newline', () => {
    expect(parseHoldrConf('# c\n\nHOLDR_WEB_MODE=local')).toEqual({ HOLDR_WEB_MODE: 'local' });
  });
});

describe.skipIf(process.platform === 'win32')('holdr.conf file and location', () => {
  it('requires a private regular file: 0600, owned, one link, no symlink', () => {
    const dir = scratch();
    const file = path.join(dir, 'holdr.conf');
    writePrivate(file, DIST);
    expect(readHoldrConf(file).values.HOLDR_WEB_MODE).toBe('dist');
    fs.chmodSync(file, 0o640);
    expect(() => readHoldrConf(file)).toThrow('E0I_CONFIG_FILE');
    fs.chmodSync(file, 0o600);
    fs.linkSync(file, path.join(dir, 'hard'));
    expect(() => readHoldrConf(file)).toThrow('E0I_CONFIG_FILE');
    fs.unlinkSync(path.join(dir, 'hard'));
    fs.symlinkSync(file, path.join(dir, 'link.conf'));
    expect(() => readHoldrConf(path.join(dir, 'link.conf'))).toThrow('E0I_CONFIG_FILE');
    expect(() => readHoldrConf(path.join(dir, 'missing.conf'))).toThrow('E0I_CONFIG_FILE');
    for (const [name, bytes] of [['bom.conf', Buffer.from('\uFEFFHOLDR_WEB_MODE=local\n')], ['latin1.conf', Buffer.from([0x48, 0xff, 0x0a])]] as const) {
      fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
      expect(() => readHoldrConf(path.join(dir, name))).toThrow('E0I_CONFIG_FILE');
    }
  });

  it('locates: explicit path, none only with a run id, default under HOME only when present', () => {
    const home = scratch();
    expect(locateHoldrConf({ HOME: home })).toEqual({ kind: 'none', reason: 'absent' });
    expect(locateHoldrConf({})).toEqual({ kind: 'none', reason: 'absent' });
    expect(() => locateHoldrConf({ HOLDR_CONFIG: 'none' })).toThrow('E0I_CONFIG_FILE');
    expect(locateHoldrConf({ HOLDR_CONFIG: 'none', HOLDR_E2E_RUN_ID: 'f'.repeat(32) })).toEqual({ kind: 'none', reason: 'disabled' });
    expect(() => locateHoldrConf({ HOLDR_CONFIG: 'relative.conf' })).toThrow('E0I_CONFIG_FILE');
    expect(() => locateHoldrConf({ HOLDR_CONFIG: '' })).toThrow('E0I_CONFIG_FILE');
    expect(locateHoldrConf({ HOLDR_CONFIG: '/x/holdr.conf' })).toEqual({ kind: 'file', path: '/x/holdr.conf', explicit: true });
    const file = defaultConfPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivate(file, 'HOLDR_WEB_MODE=local\n');
    expect(locateHoldrConf({ HOME: home })).toEqual({ kind: 'file', path: file, explicit: false });
    // A disposable stack never silently joins the production configuration (B-D4).
    expect(() => locateHoldrConf({ HOME: home, HOLDR_E2E_RUN_ID: 'f'.repeat(32) })).toThrow('E0I_CONFIG_FILE');
  });

  it('an explicit HOLDR_CONFIG that does not exist fails closed', () => {
    expect(() => loadConfiguration({ HOLDR_CONFIG: path.join(scratch(), 'missing.conf') })).toThrow('E0I_CONFIG_FILE');
  });

  it('a holdr.conf with HOLDR_METALS_PRICES=1 starts as the API starts: no refusal, no unknown setting, fetching on (O93)', () => {
    const file = path.join(scratch(), 'holdr.conf');
    writePrivate(file, `${DIST}HOLDR_METALS_PRICES=1\n`);
    // As index.ts starts: the effective environment fills what the process environment lacks, unknown names are logged,
    // and the price switch is read from the process environment.
    const proc: NodeJS.ProcessEnv = { HOLDR_CONFIG: file };
    for (const [name, value] of Object.entries(loadConfiguration(proc).env)) if (value !== undefined && proc[name] === undefined) proc[name] = value;
    expect(unknownHoldrNames(proc)).toEqual([]);
    expect(proc.HOLDR_METALS_PRICES).toBe('1');
    expect(metalsPricesEnabled(proc)).toBe(true);
  });
});

describe('effective environment (§7.1 precedence)', () => {
  const conf = (text: string) => ({ path: '/c/holdr.conf', values: parseHoldrConf(text) });

  it('fills keys from the file and derives the release dir and digest', () => {
    const env = applyHoldrConf({ PORT: '4000' }, conf(DIST));
    expect(env.HOLDR_WEB_MODE).toBe('dist');
    expect(env.HOLDR_WEB_RELEASE_DIGEST).toBe(D);
    expect(env.HOLDR_WEB_RELEASE_DIR).toBe(releaseDirFor(D));
    expect(env.HOLDR_WEB_RELEASE_DIR).toBe(path.join(REPO_ROOT, 'apps/web/releases', D.slice(0, 12)));
    expect(env.PORT).toBe('4000');
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('allows equal environment values and refuses any different one', () => {
    expect(applyHoldrConf({ HOLDR_WEB_MODE: 'dist', HOLDR_WEB_RELEASE_DIGEST: D }, conf(DIST)).HOLDR_WEB_MODE).toBe('dist');
    for (const env of [
      { HOLDR_WEB_MODE: 'local' }, { HOLDR_DATA_DIR: '/tmp/other' }, { HOLDR_WEB_RELEASE_DIGEST: '0'.repeat(64) },
      { HOLDR_WEB_RELEASE_DIR: '/x' }, { HOLDR_WEB_RELEASE: '1'.repeat(64) }, { HOLDR_DEVICE_API: '1' },
      { HOLDR_NATIVE_MANIFEST: 'e'.repeat(64) },
    ]) expect(() => applyHoldrConf(env, conf(DIST))).toThrow('E0I_CONFIG_FILE');
  });

  it('keys the file does not set may come from the environment (HOLDR_INGRESS_PORT, ports)', () => {
    const env = applyHoldrConf({ HOLDR_INGRESS_PORT: '5315', PORT: '4124' }, conf('HOLDR_WEB_MODE=local\n'));
    expect(env.HOLDR_INGRESS_PORT).toBe('5315');
    expect(env.PORT).toBe('4124');
  });

  it('vite with a holdr.conf needs HOLDR_LEGACY_VITE_ROLLBACK=1', () => {
    expect(() => applyHoldrConf({}, conf('HOLDR_DATA_DIR=/d\n'))).toThrow('E0I_CONFIG_FILE');
    expect(() => applyHoldrConf({}, conf('HOLDR_WEB_MODE=vite\n'))).toThrow('E0I_CONFIG_FILE');
    expect(applyHoldrConf({}, conf('HOLDR_WEB_MODE=vite\nHOLDR_LEGACY_VITE_ROLLBACK=1\n')).HOLDR_WEB_MODE).toBe('vite');
    expect(applyHoldrConf({}, null)).toEqual({});
  });

  it('names unknown HOLDR_* variables without values', () => {
    expect(unknownHoldrNames({ HOLDR_TYPO: 'secret', HOLDR_DATA_DIR: '/d', HOLDR_TEST_API_PORT: '1', OTHER: 'x' })).toEqual(['HOLDR_TYPO']);
  });
});

describe('the metals prices switch, HOLDR_METALS_PRICES (O93)', () => {
  const conf = (text: string) => ({ path: '/c/holdr.conf', values: parseHoldrConf(text) });

  it('is a holdr.conf key taking 1 or 0, and no unknown setting', () => {
    expect(parseHoldrConf('HOLDR_METALS_PRICES=1\n')).toEqual({ HOLDR_METALS_PRICES: '1' });
    expect(parseHoldrConf('HOLDR_METALS_PRICES=0\n')).toEqual({ HOLDR_METALS_PRICES: '0' });
    const env = applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_PRICES=1\n`));
    expect(env.HOLDR_METALS_PRICES).toBe('1');
    expect(unknownHoldrNames(env)).toEqual([]);
    expect(unknownHoldrNames({ HOLDR_METALS_PRICES: '1' })).toEqual([]);
  });

  it('reaches the price switch as every file key reaches its reader: only 1 turns fetching on', () => {
    expect(metalsPricesEnabled(applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_PRICES=1\n`)))).toBe(true);
    expect(metalsPricesEnabled(applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_PRICES=0\n`)))).toBe(false);
    expect(metalsPricesEnabled(applyHoldrConf({}, conf(DIST)))).toBe(false);
  });

  it('like every file key, a different environment value is a conflict and an equal one is allowed', () => {
    expect(() => applyHoldrConf({ HOLDR_METALS_PRICES: '0' }, conf(`${DIST}HOLDR_METALS_PRICES=1\n`))).toThrow('E0I_CONFIG_FILE');
    expect(applyHoldrConf({ HOLDR_METALS_PRICES: '1' }, conf(`${DIST}HOLDR_METALS_PRICES=1\n`)).HOLDR_METALS_PRICES).toBe('1');
  });
});

describe('the owner\'s metals assignment policy, HOLDR_METALS_FUNGIBLE', () => {
  const conf = (text: string) => ({ path: '/c/holdr.conf', values: parseHoldrConf(text) });

  it('is a holdr.conf key taking a comma list of distinct metals, and no unknown setting', () => {
    expect(parseHoldrConf('HOLDR_METALS_FUNGIBLE=XAU\n')).toEqual({ HOLDR_METALS_FUNGIBLE: 'XAU' });
    expect(parseHoldrConf('HOLDR_METALS_FUNGIBLE=XAU,XAG\n')).toEqual({ HOLDR_METALS_FUNGIBLE: 'XAU,XAG' });
    const env = applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_FUNGIBLE=XAU\n`));
    expect(env.HOLDR_METALS_FUNGIBLE).toBe('XAU');
    expect(unknownHoldrNames(env)).toEqual([]);
  });

  it('reaches the policy as every file key reaches its reader: no line is none', () => {
    expect(metalsFungibleOf(applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_FUNGIBLE=XAU\n`)))).toEqual(['XAU']);
    expect(metalsFungibleOf(applyHoldrConf({}, conf(DIST)))).toEqual([]);
    expect(() => applyHoldrConf({ HOLDR_METALS_FUNGIBLE: 'XAG' }, conf(`${DIST}HOLDR_METALS_FUNGIBLE=XAU\n`))).toThrow('E0I_CONFIG_FILE');
  });
});

describe('the owner\'s estimate switch, HOLDR_METALS_ESTIMATE_UNMATCHED', () => {
  const conf = (text: string) => ({ path: '/c/holdr.conf', values: parseHoldrConf(text) });

  it('is a holdr.conf key taking a comma list of distinct metals, and no unknown setting', () => {
    expect(parseHoldrConf('HOLDR_METALS_ESTIMATE_UNMATCHED=XAU\n')).toEqual({ HOLDR_METALS_ESTIMATE_UNMATCHED: 'XAU' });
    expect(parseHoldrConf('HOLDR_METALS_ESTIMATE_UNMATCHED=XAU,XAG\n')).toEqual({ HOLDR_METALS_ESTIMATE_UNMATCHED: 'XAU,XAG' });
    const env = applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_FUNGIBLE=XAU\nHOLDR_METALS_ESTIMATE_UNMATCHED=XAU\n`));
    expect([env.HOLDR_METALS_FUNGIBLE, env.HOLDR_METALS_ESTIMATE_UNMATCHED]).toEqual(['XAU', 'XAU']);
    expect(unknownHoldrNames(env)).toEqual([]);
  });

  it('reaches the switch as every file key reaches its reader: no line is none', () => {
    expect(metalsEstimateUnmatchedOf(applyHoldrConf({}, conf(`${DIST}HOLDR_METALS_ESTIMATE_UNMATCHED=XAU\n`)))).toEqual(['XAU']);
    expect(metalsEstimateUnmatchedOf(applyHoldrConf({}, conf(DIST)))).toEqual([]);
    expect(() => applyHoldrConf({ HOLDR_METALS_ESTIMATE_UNMATCHED: 'XAG' }, conf(`${DIST}HOLDR_METALS_ESTIMATE_UNMATCHED=XAU\n`)))
      .toThrow('E0I_CONFIG_FILE');
  });
});

describe.skipIf(process.platform === 'win32')('holdr.conf.dist for local Serve expectations (B-D2)', () => {
  it('needs a complete dist companion file', () => {
    const dir = scratch();
    const file = path.join(dir, 'holdr.conf');
    writePrivate(file, 'HOLDR_WEB_MODE=local\n');
    const current = readHoldrConf(file);
    expect(() => readDistCompanion(current)).toThrow('E0I_CONFIG_FILE');
    expect(() => readDistCompanion(null)).toThrow('E0I_CONFIG_FILE');
    writePrivate(path.join(dir, 'holdr.conf.dist'), 'HOLDR_WEB_MODE=dist\nHOLDR_PUBLIC_ORIGIN=https://holdr.example.ts.net\n');
    expect(() => readDistCompanion(current)).toThrow('E0I_CONFIG_FILE');
    fs.unlinkSync(path.join(dir, 'holdr.conf.dist'));
    writePrivate(path.join(dir, 'holdr.conf.dist'), DIST);
    expect(readDistCompanion(current)).toEqual({
      publicOrigin: 'https://holdr.example.ts.net', socketPath: '/Users/sample2/Library/Application Support/Holdr/run/ingress.sock',
    });
  });
});
