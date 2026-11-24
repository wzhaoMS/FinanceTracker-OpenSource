import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { convertCardExport } from './convert.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..', '..');
const main = join(here, 'main.ts');
const fixture = (name: string) => join(here, 'fixtures', name);
// --import takes a URL or a package name; Node on Windows refuses a drive path (C:\…) there.
const noNetwork = pathToFileURL(join(here, 'testing', 'noNetwork.mjs')).href;

/** Windows: each file's owner, group and DACL as SDDL, read by Windows PowerShell (the paths go in the environment). */
function windowsSddl(paths: string[]): string[] {
  const script = "$ErrorActionPreference = 'Stop'; foreach ($path in $env:HOLDR_SDDL_PATHS.Split('|')) { (Get-Acl -LiteralPath $path).Sddl }";
  const powerShell = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const env: NodeJS.ProcessEnv = { HOLDR_SDDL_PATHS: paths.join('|') };
  // Windows PowerShell 5.1 cannot load its modules under PowerShell 7's PSModulePath, so that one variable stays out.
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== 'psmodulepath') env[key] ??= value;
  const output = execFileSync(powerShell, args, { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return output.trim().split(/\r?\n/);
}

/** Static imports and re-exports (`from '…'`) and side-effect imports; dynamic loading is banned below. */
function specifiers(source: string): string[] {
  const pattern = /^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2]);
}

function moduleGraph(entry: string): { files: Map<string, string>; external: Set<string> } {
  const files = new Map<string, string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    const source = readFileSync(file, 'utf8');
    files.set(file, source);
    for (const specifier of specifiers(source)) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      else external.add(specifier);
    }
  };
  visit(entry);
  return { files, external };
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--import', noNetwork, main, ...args], {
    cwd: packageDir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

describe('offline tool isolation', () => {
  it('has no network, process or dynamic-code access anywhere in its module graph', () => {
    const { files, external } = moduleGraph(main);
    // Relative to src/, with '/' on every platform (Windows paths use '\').
    const names = [...files.keys()].map((file) => relative(resolve(here, '..'), file).split(sep).join('/')).sort();
    for (const expected of ['cardImportTool/cli.ts', 'cardImportTool/ofx.ts', 'cardImportTool/amexCsv.ts', 'cardImportTool/biltCsv.ts', 'cardImportTool/wfCsv.ts', 'cardNumbers.ts', 'cardDedupe.ts', 'cardImport.ts']) {
      assert.ok(names.includes(expected), expected);
    }
    // Only main.ts touches the platform: it reads the export and writes the JSON.
    assert.deepEqual([...external].sort(), ['node:fs', 'node:path']);
    const forbidden = /^(?:node:)?(?:net|http|https|http2|dns|tls|dgram|child_process|cluster|worker_threads|inspector|vm|undici)(?:\/|$)/;
    assert.deepEqual([...external].filter((specifier) => forbidden.test(specifier)), []);
    for (const [file, source] of files) {
      const apis = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\beval\s*\(|\bnew\s+Function\b|\bprocess\.binding\b|\bimport\s*\(|\brequire\s*\(|\bglobalThis\s*\[|\bprocess\.env\b/;
      assert.doesNotMatch(source, apis, file);
      // No clock, time zone or locale: whether a statement period has closed is read from the export's own dates.
      const clock = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\b|\bprocess\.hrtime\b|\bIntl\.|\.toLocale\w*String\s*\(|\bgetTimezoneOffset\s*\(|\.get(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds)\s*\(/;
      assert.doesNotMatch(source, clock, file);
    }
    // The library entry (what an extension or the API tests import) has no platform access at all.
    assert.deepEqual([...moduleGraph(join(here, 'index.ts')).external], []);
  });

  it('runs to completion with every network and process API blocked', () => {
    const result = run(['ofx', fixture('statement-ofx1.ofx'), '--issuer', 'samplebank', '--status', 'posted', '--quiet']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /blocked:/);
    assert.equal(result.stdout, convertCardExport(new Uint8Array(readFileSync(fixture('statement-ofx1.ofx'))), { format: 'ofx', issuer: 'samplebank', status: 'posted' }).json);
    // The preload really is active: the same process cannot open a socket.
    const probe = spawnSync(process.execPath, ['--import', noNetwork, '-e', "require('node:net').connect(1)"], { encoding: 'utf8' });
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /blocked: net\.connect/);
  });

  it('writes byte-identical JSON on two "computers" with different time zones and locales', () => {
    const cases: Array<[string, string[]]> = [
      ['amex-detailed.csv', ['amex-csv', fixture('amex-detailed.csv'), '--status', 'posted', '--member', 'ALEX SAMPLE=casey', '--member', 'JORDAN SAMPLE=alex', '--quiet']],
      ['amex-basic.csv', ['amex-csv', fixture('amex-basic.csv'), '--status', 'posted', '--quiet']],
      ['statement.qfx', ['ofx', fixture('statement.qfx'), '--issuer', 'samplebank', '--status', 'posted', '--expect-previous-balance', '1195.45', '--quiet']],
      ['amex-basic.csv pending', ['amex-csv', fixture('amex-basic.csv'), '--status', 'pending', '--quiet']],
      ['statement-open.qfx split', ['ofx', fixture('statement-open.qfx'), '--issuer', 'samplebank', '--closed-through', '2026-10-15', '--quiet']],
      ['bilt-activity.csv', ['bilt-csv', fixture('bilt-activity.csv'), '--status', 'export', '--loan-payments', 'not-spending', '--quiet']],
      ['wf-card.csv', ['wf-csv', fixture('wf-card.csv'), '--status', 'posted', '--from', '2026-09-22', '--to', '2026-10-22', '--quiet']],
    ];
    for (const [name, args] of cases) {
      const first = run(args, { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' });
      const second = run(args, { TZ: 'America/Los_Angeles', LANG: 'C', LC_ALL: 'C' });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      assert.ok(first.stdout.length > 100, name);
      assert.equal(first.stdout, second.stdout, name);
      assert.doesNotMatch(first.stdout, /\d{13}/);
    }
  });

  it('decides statuses and warnings alike on every computer, from the export and the options alone', () => {
    const computers = [
      { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
      { TZ: 'America/Los_Angeles', LANG: 'C', LC_ALL: 'C' },
      { TZ: 'Etc/GMT+12', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    ];
    const scratch = mkdtempSync(join(packageDir, '.card-import-test-'));
    try {
      // Made at 00:30 GMT on October 17, which is 20:30 on October 16 where its dates are written.
      const zoned = join(scratch, 'zoned.ofx');
      writeFileSync(zoned, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
        '<DTSERVER>20261017003000[0:GMT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
        '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><CCSTMTRS>',
        '<CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>XXXX-1111</ACCTID></CCACCTFROM>',
        '<BANKTRANLIST><DTSTART>20260916000000[-4:EDT]</DTSTART><DTEND>20261016203000[-4:EDT]</DTEND>',
        '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261016120000[-4:EDT]</DTPOSTED><TRNAMT>-16250.00</TRNAMT>',
        '<FITID>SYN-ORDER</FITID><NAME>CONTOSO ORDER</NAME></STMTTRN></BANKTRANLIST>',
        '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
      ].join('\n'));
      const scenarios: Array<[string, string[], number, RegExp]> = [
        ['no status', ['amex-csv', fixture('amex-basic.csv')], 1, /^holdr-card-import: error: say whether this export's statement period has closed/],
        ['posted, warned', ['ofx', zoned, '--issuer', 'samplebank', '--status', 'posted'], 0,
          /\nWarning: --status posted, but this export may include a statement period that has not closed: its dates run to 2026-10-16, on or after the day it was made \(2026-10-17 00:30 UTC\+00:00, 2026-10-16 where its dates are written\)/],
        ['cutoff refused', ['ofx', zoned, '--issuer', 'samplebank', '--closed-through', '2026-10-16'], 1,
          /--closed-through 2026-10-16 is not before the day this export was made/],
        ['split', ['ofx', fixture('statement-open.qfx'), '--issuer', 'samplebank', '--closed-through', '2026-10-15'], 0,
          /Status: --closed-through 2026-10-15: 3 rows posted on or before it are posted, 2 rows posted after it are pending/],
      ];
      for (const [name, args, status, message] of scenarios) {
        const results = computers.map((env) => run(args, env));
        for (const result of results) {
          assert.equal(result.status, status, `${name}: ${result.stderr}`);
          assert.equal(result.stdout, results[0].stdout, name);
          assert.equal(result.stderr, results[0].stderr, name);
        }
        assert.match(results[0].stderr, message, name);
        if (status !== 0) assert.equal(results[0].stdout, '', name);
      }
    } finally {
      // The tool has exited (spawnSync); Windows may still hold its files for a moment.
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('writes --out with owner-only permissions (on Windows, its folder\'s) and never replaces a file without --force', () => {
    const scratch = mkdtempSync(join(packageDir, '.card-import-test-'));
    try {
      const out = join(scratch, 'amex.json');
      const args = ['amex-csv', fixture('amex-basic.csv'), '--status', 'posted', '--out', out];
      const first = run(args);
      assert.equal(first.status, 0, first.stderr);
      if (process.platform === 'win32') {
        // Windows has no mode bits to set (Node reports 0o666 whatever the ACL), so the file gets the ACL
        // its folder passes down (docs/importing-data.md): exactly what any new file beside it gets.
        const beside = join(scratch, 'beside.json');
        writeFileSync(beside, '');
        const [written, control] = windowsSddl([out, beside]);
        assert.match(written, /D:/);
        assert.equal(written, control);
      } else {
        assert.equal(statSync(out).mode & 0o777, 0o600);
      }
      assert.equal(readFileSync(out, 'utf8'), convertCardExport(new Uint8Array(readFileSync(fixture('amex-basic.csv'))), { format: 'amex-csv', status: 'posted' }).json);
      const second = run(args);
      assert.equal(second.status, 1);
      assert.match(second.stderr, /exists/);
      assert.equal(run([...args, '--force']).status, 0);
      const self = run(['amex-csv', fixture('amex-basic.csv'), '--out', fixture('amex-basic.csv')]);
      assert.equal(self.status, 1);
      assert.match(self.stderr, /must not be the export file/);
      const directory = run(['amex-csv', scratch]);
      assert.equal(directory.status, 1);
      assert.match(directory.stderr, /not a regular file|is a directory/);
    } finally {
      // The tool has exited (spawnSync); Windows may still hold its output for a moment.
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
