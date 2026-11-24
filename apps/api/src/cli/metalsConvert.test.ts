/**
 * holdr-metals-convert's scaffold end to end, with stand-in converters: capture folders and their private manifest
 * written to a scratch directory, and a retail payload file. Synthetic fixtures only; no source's own converter.
 * Output places are checked owner-only by a stand-in Windows ACL reader, except in the tests that say "for real".
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  METALS_CONVERTER,
  MetalsConvertError,
  metalsConvertOutput,
  type MetalsCaptureConverter,
  type MetalsCaptureFolder,
  type MetalsConverter,
  type MetalsRetailPayloadConverter,
} from '@finance-tracker/shared/metals-convert';
import {
  METALS_SOURCES,
  metalsDigest,
  serializeMetalsImportPayload,
  validateMetalsImportPayload,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsSource,
} from '@finance-tracker/shared/metals-ledger';
import { syntheticPayload, walmartAdmittedOrder } from '@finance-tracker/shared/metals-ledger-fixtures';

import { ADMINISTRATORS_SID, readCurrentUserSid, readWindowsAcls, restrictToUser, SYSTEM_SID, system32, type WindowsAcl } from '../e2e/windowsAcl.js';
import { nativeFixture } from '../ingress/nativeFixtures.js';
import type { PathObject, PathRecord } from '../ingress/socketPath.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { ALIAS_FOLDERS } from '../testing/windowsAliasPaths.js';
import { readPinnedPathcheck } from './darwinPathcheck.js';
import { METALS_CONVERT_EXIT, METALS_CONVERT_SOURCES, METALS_CONVERT_USAGE, runMetalsConvertCli } from './metalsConvert.js';
import { ownerOnlyAcl, ownerOnlyDarwinPath, platformOutputAccess, type OutputAccess } from './ownerOnlyOutput.js';

type Registry = Record<MetalsSource, MetalsConverter | null>;
const registry = (entries: Partial<Registry>): Registry => ({ costco: null, walmart: null, collectpure: null, ...entries });

/** A synthetic current user, and a synthetic other one. */
const USER = 'S-1-5-21-1000-1000-1000-1001';
const OTHER_USER = 'S-1-5-21-1000-1000-1000-2002';
const USERS_GROUP = 'S-1-5-32-545';
const EVERYONE = 'S-1-1-0';
const FULL = 0x1f01ff;
const READ = 0x120089;
const ownerOnly = (owner = USER): WindowsAcl => ({ owner, aceTypes: ['AccessAllowed'], aces: [{ sid: owner, rights: FULL, type: 'Allow' }] });
const sharedWith = (sid: string): WindowsAcl => ({
  owner: USER,
  aceTypes: ['AccessAllowed', 'AccessAllowed'],
  aces: [{ sid: USER, rights: FULL, type: 'Allow' }, { sid, rights: READ, type: 'Allow' }],
});

/**
 * A stand-in Windows owner-only check: the ACL given for directories and for files (owner-only by default, or an error
 * to throw), recording each path it is asked about and, for a file, how many bytes it held then.
 */
function fakeAccess(acls: { dir?: WindowsAcl | Error; file?: WindowsAcl | Error } = {}) {
  const checked: Array<{ kind: 'dir' | 'file'; bytes: number }> = [];
  const access: OutputAccess = {
    platform: 'win32',
    currentUserSid: () => USER,
    readAcls: (paths) => paths.map((target) => {
      const stat = statSync(target);
      const kind = stat.isDirectory() ? 'dir' : 'file';
      checked.push({ kind, bytes: stat.isDirectory() ? 0 : stat.size });
      const acl = acls[kind] ?? ownerOnly();
      if (acl instanceof Error) throw acl;
      return acl;
    }),
  };
  return { access, checked };
}

/** A synthetic current uid and another uid; on macOS everyone is gid 12, staff gid 20. */
const MAC_UID = 501;
const MAC_OTHER_UID = 502;
const EVERYONE_GID = 12;
const STAFF_GID = 20;
type MacAce = PathObject['acl'][number];
/** An ACL entry as holdr-pathcheck decodes it (list rights), with its flags. */
const macAce = (type: 'allow' | 'deny', principal: 'uid' | 'gid', id: number, flags: string[] = []): MacAce =>
  ({ type, principal, id, mask: '0x2', generic: [], perms: ['list'], flags });
interface MacFacts { uid?: number; mode?: number; acl?: MacAce[] }

/** One record as the pinned reader gives it: the path's real type, device and inode, with these owner, mode and ACL. */
function macRecord(kind: 'dir' | 'socket', at: string, { uid = MAC_UID, mode = 0o700, acl = [] }: MacFacts, identity: { dev?: string; ino?: string } = {}): PathObject {
  const stat = statSync(at, { bigint: true });
  return {
    kind, path: at, type: stat.isDirectory() ? 'dir' : 'other', uid, gid: STAFF_GID, mode, dev: identity.dev ?? stat.dev.toString(),
    ino: identity.ino ?? stat.ino.toString(), aclPresent: acl.length > 0, acl,
  };
}

/**
 * fakeAccess's macOS counterpart, a stand-in for the pinned reader: for each path, its directory and then the path
 * itself, with the facts given for directories and for files (or an error to throw). A new file's directory is the
 * output directory, read with `parentAtWrite`'s facts when given (else the directory's), or left out (`noParent`). A new
 * file can be reported with another device or inode (`fileDev`, `fileIno`). It records each path asked about and, for a
 * file, how many bytes it held then.
 */
function fakeDarwinAccess(facts: {
  dir?: MacFacts | Error; file?: MacFacts | Error; parentAtWrite?: MacFacts; fileDev?: string; fileIno?: string; noParent?: boolean;
} = {}, uid: number | Error = MAC_UID) {
  const checked: Array<{ kind: 'dir' | 'file'; bytes: number }> = [];
  const access: OutputAccess = {
    platform: 'darwin',
    currentUserSid: () => { throw new Error('no Windows SID on macOS'); },
    readAcls: () => { throw new Error('no Windows ACL on macOS'); },
    darwin: {
      currentUid: () => {
        if (uid instanceof Error) throw uid;
        return uid;
      },
      readPath: (target): PathRecord[] => {
        // As the real reader: canonical absolute paths only (holdr-pathcheck refuses `.`, `..`, `//` and links).
        if (!path.isAbsolute(target) || path.normalize(target) !== target || realpathSync.native(target) !== target) {
          throw new Error('the reader takes canonical absolute paths only');
        }
        const stat = statSync(target);
        const kind = stat.isDirectory() ? 'dir' : 'file';
        checked.push({ kind, bytes: stat.isDirectory() ? 0 : stat.size });
        const own = facts[kind] ?? {};
        if (own instanceof Error) throw own;
        const parent = kind === 'file' ? facts.parentAtWrite ?? (facts.dir instanceof Error ? {} : facts.dir ?? {}) : {};
        const identity = kind === 'file' ? { dev: facts.fileDev, ino: facts.fileIno } : {};
        const self = macRecord('socket', target, own, identity);
        return kind === 'file' && facts.noParent ? [self] : [macRecord('dir', path.dirname(target), parent), self];
      },
    },
  };
  return { access, checked };
}

function run(argv: string[], sources: Registry, access: OutputAccess = fakeAccess().access) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  return runMetalsConvertCli(argv, io, sources, access).then((status) => ({ status, ...out }));
}

const HELD: MetalsHeldRecord = { key: null, channel: 'online', date: '2030-01-05', reason: 'unreadable', check: 'record-shape' };

/** A stand-in capture converter: it records what it is given and returns a valid payload (held records on request). */
function captureConverter(source: 'walmart' | 'collectpure', options: { held?: boolean; snapshot?: RegExp } = {}) {
  const calls: MetalsCaptureFolder[] = [];
  const converter: MetalsCaptureConverter = {
    input: 'capture-folder',
    source,
    folder: new RegExp(`^${source}(?:-[1-9][0-9]{0,2})?$`),
    snapshot: options.snapshot,
    files: [
      { dir: '', name: new RegExp(`^${source}\\.json$`), required: true },
      { dir: 'raw', name: /^detail-[0-9]{1,40}\.json$/, required: false },
    ],
    convert(capture) {
      calls.push(capture);
      const payload: MetalsImportPayload = {
        ...syntheticPayload(source, { orders: source === 'walmart' ? [walmartAdmittedOrder(1)] : [], held: options.held ? [HELD] : [] }),
        account: { folder: capture.folder, identityLast4: null },
        converterVersion: capture.converterVersion,
      };
      return metalsConvertOutput(payload, { files: capture.files.length, snapshot: capture.snapshot !== null });
    },
  };
  return { converter, calls };
}

/** A stand-in retail-payload converter (Costco's input). */
function retailConverter() {
  const calls: Array<{ bytes: Uint8Array; converterVersion: string }> = [];
  const converter: MetalsRetailPayloadConverter = {
    input: 'retail-payload',
    source: 'costco',
    convert(retail) {
      calls.push(retail);
      const payload: MetalsImportPayload = {
        ...syntheticPayload('costco', {}),
        converterVersion: retail.converterVersion,
        input: { retailPayloadSha256: metalsDigest(retail.bytes), retailFormat: 3, retailPolicyVersion: 5 },
      };
      return metalsConvertOutput(payload, { read: 1 });
    },
  };
  return { converter, calls };
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Writes files under `root` and a manifest listing them (relative to `root`), and returns the manifest's path. */
function writeFiles(root: string, files: Record<string, string>, listed: (relative: string) => boolean = () => true): string {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
    if (listed(relative)) entries.push({ path: relative.split(path.sep).join('/'), bytes: Buffer.byteLength(text), sha256: sha256(text) });
  }
  const manifest = path.join(root, 'manifest.private.json');
  writeFileSync(manifest, JSON.stringify({ createdAt: '2030-01-31T00:00:00.000Z', lane: 'synthetic', files: entries }));
  return manifest;
}

/** A synthetic walmart account folder of three files: its consolidated file, a raw detail and a file of no layout. */
function walmartFiles(folder = 'walmart'): Record<string, string> {
  return {
    [`${folder}/walmart.json`]: '{"schema":"synthetic"}',
    [`${folder}/raw/detail-123.json`]: '{"order":{}}',
    [`${folder}/raw/notes.txt`]: 'SAMPLE NOTES',
  };
}

describe('holdr-metals-convert: the scaffold', () => {
  let root: string;
  let outRoot: string;
  beforeEach(async () => {
    root = await makeScratchDir('metals-convert-');
    outRoot = await makeScratchDir('metals-convert-out-');
  });
  afterEach(async () => {
    await removeScratchDir(root);
    await removeScratchDir(outRoot);
  });

  it('names every source, and answers "not yet available" for one with no converter', async () => {
    expect(Object.keys(METALS_CONVERT_SOURCES).sort()).toEqual([...METALS_SOURCES].sort());
    const manifest = writeFiles(root, walmartFiles());
    const capture = await run(['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--dry-run'], registry({}));
    expect(capture.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(capture.stderr).toBe('holdr-metals-convert: --source walmart is not yet available\n');
    expect(capture.stdout).toBe('');
    const retail = await run(['--source', 'costco', '--retail-payload', manifest, '--dry-run'], registry({}));
    expect(retail.stderr).toBe('holdr-metals-convert: --source costco is not yet available\n');
  });

  it('dry-runs a capture folder: only its layout\'s files, each checked against the manifest', async () => {
    const { converter, calls } = captureConverter('walmart');
    const manifest = writeFiles(root, walmartFiles());
    const result = await run(['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--dry-run'], registry({ walmart: converter }));
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toEqual({
      code: 'metals-convert-dry-run',
      source: 'walmart',
      converter: METALS_CONVERTER,
      report: { files: 2, snapshot: false },
      payload: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number), written: false, held: 0, orders: 1, competitors: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].folder).toBe('walmart');
    expect(calls[0].snapshot).toBeNull();
    expect(calls[0].converterVersion).toBe(METALS_CONVERTER);
    expect(calls[0].files.map((file) => file.path)).toEqual(['walmart.json', 'raw/detail-123.json']);
    expect(Buffer.from(calls[0].files[0].bytes).toString('utf8')).toBe('{"schema":"synthetic"}');
    expect(result.stdout).not.toContain(root);
  });

  it('writes the payload to a new owner-only file: the exact bytes the report digests, and the same twice', async () => {
    const { converter } = captureConverter('walmart');
    const manifest = writeFiles(root, walmartFiles());
    const argv = (out: string) => ['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--out', out];
    const out = path.join(outRoot, 'walmart.metals-import.json');
    const { access, checked: places } = fakeAccess();
    const first = await run(argv(out), registry({ walmart: converter }), access);
    expect(first.status).toBe(METALS_CONVERT_EXIT.ok);
    // The directory first, then the new file while it is still empty.
    expect(places).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
    const report = JSON.parse(first.stdout);
    expect(report.code).toBe('metals-converted');
    expect(report.payload.written).toBe(true);
    const bytes = readFileSync(out);
    expect(sha256(bytes)).toBe(report.payload.sha256);
    expect(bytes.length).toBe(report.payload.bytes);
    const checked = validateMetalsImportPayload(JSON.parse(bytes.toString('utf8')));
    expect(checked.ok).toBe(true);
    expect(bytes.toString('utf8')).toBe(serializeMetalsImportPayload((checked as { payload: MetalsImportPayload }).payload));
    await run(argv(path.join(outRoot, 'again.json')), registry({ walmart: converter }));
    expect(readFileSync(path.join(outRoot, 'again.json'))).toEqual(bytes);
  });

  it('refuses a file the manifest does not list, or lists with another size or digest', async () => {
    const { converter } = captureConverter('walmart');
    const unlisted = writeFiles(root, walmartFiles(), (relative) => !relative.includes('detail-'));
    const folder = path.join(root, 'walmart');
    const argv = (manifest: string) => ['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--dry-run'];
    const missing = await run(argv(unlisted), registry({ walmart: converter }));
    expect(missing.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(missing.stderr).toBe('holdr-metals-convert: manifest-mismatch\n');
    expect(missing.stdout).toBe('');

    const manifest = writeFiles(root, walmartFiles());
    writeFileSync(path.join(folder, 'walmart.json'), '{"schema":"changed!"}');
    expect((await run(argv(manifest), registry({ walmart: converter }))).stderr).toBe('holdr-metals-convert: manifest-mismatch\n');

    const listed = JSON.parse(readFileSync(writeFiles(root, walmartFiles()), 'utf8'));
    listed.files[0].bytes += 1;
    writeFileSync(manifest, JSON.stringify(listed));
    expect((await run(argv(manifest), registry({ walmart: converter }))).stderr).toBe('holdr-metals-convert: manifest-mismatch\n');
  });

  it('refuses a manifest it can\'t read, and a folder without its required file', async () => {
    const { converter } = captureConverter('walmart');
    const manifest = writeFiles(root, walmartFiles());
    const folder = path.join(root, 'walmart');
    const argv = ['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--dry-run'];
    for (const text of ['{ not json', '{"files":{}}', '{"files":[{"path":"a","bytes":1,"sha256":"NOT-A-DIGEST"}]}',
      `{"files":[{"path":"a","bytes":1,"sha256":"${'a'.repeat(64)}"},{"path":"a","bytes":1,"sha256":"${'a'.repeat(64)}"}]}`]) {
      writeFileSync(manifest, text);
      expect((await run(argv, registry({ walmart: converter }))).stderr).toBe('holdr-metals-convert: manifest-unreadable\n');
    }
    const fresh = writeFiles(root, walmartFiles());
    unlinkSync(path.join(folder, 'walmart.json'));
    const missing = await run(['--source', 'walmart', '--folder', folder, '--manifest', fresh, '--dry-run'], registry({ walmart: converter }));
    expect(missing.stderr).toBe('holdr-metals-convert: capture-unreadable\n');
  });

  it('never follows a link: a linked account folder or a linked directory inside it is refused', async () => {
    const { converter, calls } = captureConverter('walmart');
    const manifest = writeFiles(root, { ...walmartFiles(), 'elsewhere/detail-456.json': '{}' });
    const folder = path.join(root, 'walmart');
    const linkedFolder = path.join(outRoot, 'walmart');
    // A junction on Windows (no privilege needed); a symbolic link elsewhere, where the type is ignored.
    symlinkSync(folder, linkedFolder, 'junction');
    const linkedRaw = path.join(root, 'walmart-2');
    mkdirSync(linkedRaw);
    writeFileSync(path.join(linkedRaw, 'walmart.json'), '{"schema":"synthetic"}');
    symlinkSync(path.join(root, 'elsewhere'), path.join(linkedRaw, 'raw'), 'junction');
    try {
      const viaFolder = await run(['--source', 'walmart', '--folder', linkedFolder, '--manifest', manifest, '--dry-run'], registry({ walmart: converter }));
      expect(viaFolder.status).toBe(METALS_CONVERT_EXIT.usage);
      expect(viaFolder.stderr).toContain('--folder must be an existing directory');
      const viaRaw = await run(['--source', 'walmart', '--folder', linkedRaw, '--manifest', manifest, '--dry-run'], registry({ walmart: converter }));
      expect(viaRaw.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(viaRaw.stderr).toBe('holdr-metals-convert: capture-unreadable\n');
      expect(calls).toHaveLength(0);
    } finally {
      for (const link of [linkedFolder, path.join(linkedRaw, 'raw')]) {
        if (process.platform === 'win32') rmdirSync(link);
        else unlinkSync(link);
      }
    }
  });

  it('writes nothing when records are held, unless told to skip them', async () => {
    const { converter } = captureConverter('walmart', { held: true });
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'held.json');
    const argv = ['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--out', out];
    const held = await run(argv, registry({ walmart: converter }));
    expect(held.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(JSON.parse(held.stdout).code).toBe('metals-held');
    expect(JSON.parse(held.stdout).payload).toMatchObject({ written: false, held: 1 });
    expect(held.stderr).toBe('holdr-metals-convert: 1 record was held, so nothing was written (see the report; --skip-held writes the others)\n');
    expect(existsSync(out)).toBe(false);
    const dry = await run(['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--dry-run'], registry({ walmart: converter }));
    expect(dry.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(JSON.parse(dry.stdout).code).toBe('metals-convert-dry-run');
    const skipped = await run([...argv, '--skip-held'], registry({ walmart: converter }));
    expect(skipped.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(JSON.parse(skipped.stdout).code).toBe('metals-converted');
    expect(existsSync(out)).toBe(true);
  });
});

describe('holdr-metals-convert: usage, snapshots, retail payloads and converter faults', () => {
  let root: string;
  let outRoot: string;
  beforeEach(async () => {
    root = await makeScratchDir('metals-convert-');
    outRoot = await makeScratchDir('metals-convert-out-');
  });
  afterEach(async () => {
    await removeScratchDir(root);
    await removeScratchDir(outRoot);
  });

  it('refuses usage errors before reading anything', async () => {
    const { converter: walmart, calls } = captureConverter('walmart');
    const { converter: costco } = retailConverter();
    const sources = registry({ walmart, costco });
    const manifest = writeFiles(root, walmartFiles());
    const folder = path.join(root, 'walmart');
    const existing = path.join(outRoot, 'exists.json');
    writeFileSync(existing, '{}');
    const capture = ['--source', 'walmart', '--folder', folder, '--manifest', manifest];
    const cases: Array<[string[], string]> = [
      [['--folder', folder, '--manifest', manifest, '--dry-run'], 'give --source costco, walmart or collectpure'],
      [['--source', 'amazon', '--folder', folder, '--manifest', manifest, '--dry-run'], 'give --source costco, walmart or collectpure'],
      [capture, 'give --dry-run or --out'],
      [[...capture, '--dry-run', '--out', path.join(outRoot, 'x.json')], 'give --dry-run or --out'],
      [[...capture, '--dry-run', '--skip-held'], '--skip-held goes with --out'],
      [['--source', 'walmart', '--folder', folder, '--dry-run'], 'give --folder DIR and --manifest FILE'],
      [[...capture, '--retail-payload', manifest, '--dry-run'], '--retail-payload is not for walmart'],
      [['--source', 'costco', '--folder', folder, '--manifest', manifest, '--dry-run'], '--folder and --manifest are not for costco'],
      [['--source', 'costco', '--dry-run'], 'give --retail-payload FILE'],
      [['--source', 'costco', '--retail-payload', path.join(root, 'missing.json'), '--dry-run'], '--retail-payload must be an existing file'],
      [['--source', 'walmart', '--folder', root, '--manifest', manifest, '--dry-run'], 'a walmart account folder named walmart or walmart-N'],
      [['--source', 'walmart', '--folder', path.join(root, 'walmart-3'), '--manifest', manifest, '--dry-run'], '--folder must be an existing directory'],
      [[...capture, '--out', existing], 'already exists'],
      [[...capture, '--out', path.join(outRoot, 'missing', 'payload.json')], 'in an existing directory'],
      [[...capture, '--out', path.join(folder, 'payload.json')], 'outside the capture folder'],
      [[...capture, '--out', path.join(root, 'payload.json')], "outside the folder of the capture's manifest"],
      [[...capture, '--dry-run', 'extra'], 'unexpected argument'],
      [[...capture, '--dry-run', '--unknown'], 'unknown option'],
      [[...capture, '--dry-run', '--source', 'walmart'], '--source is given twice'],
      [['--source'], '--source needs a value'],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv, sources);
      expect(result.status, argv.join(' ')).toBe(METALS_CONVERT_EXIT.usage);
      expect(result.stderr, argv.join(' ')).toContain(message);
      expect(result.stdout).toBe('');
    }
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(folder, 'payload.json')) || existsSync(path.join(root, 'payload.json'))).toBe(false);
    expect((await run(['--version'], sources)).stdout).toBe(`${METALS_CONVERTER}\n`);
    expect((await run(['--help'], sources)).stdout).toBe(METALS_CONVERT_USAGE);
  });

  it('converts a snapshot nested in an account folder on its own, under the account\'s name', async () => {
    const { converter, calls } = captureConverter('collectpure', { snapshot: /^snap[0-9]{8}$/ });
    const manifest = writeFiles(root, {
      'collectpure/collectpure.json': '{"base":true}',
      'collectpure/snap20301108/collectpure.json': '{"snapshot":true}',
      'collectpure/snap20301108/raw/detail-7.json': '{}',
    });
    const snapshot = path.join(root, 'collectpure', 'snap20301108');
    const result = await run(['--source', 'collectpure', '--folder', snapshot, '--manifest', manifest, '--dry-run'], registry({ collectpure: converter }));
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(calls[0].folder).toBe('collectpure');
    expect(calls[0].snapshot).toBe('snap20301108');
    expect(calls[0].files.map((file) => [file.path, Buffer.from(file.bytes).toString('utf8')])).toEqual([
      ['collectpure.json', '{"snapshot":true}'], ['raw/detail-7.json', '{}'],
    ]);
    const base = await run(['--source', 'collectpure', '--folder', path.join(root, 'collectpure'), '--manifest', manifest, '--dry-run'],
      registry({ collectpure: converter }));
    expect(base.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(calls[1].snapshot).toBeNull();
    expect(calls[1].files.map((file) => file.path)).toEqual(['collectpure.json']);

    const inside = await run(['--source', 'collectpure', '--folder', snapshot, '--manifest', manifest, '--out', path.join(root, 'collectpure', 'out.json')],
      registry({ collectpure: converter }));
    expect(inside.status).toBe(METALS_CONVERT_EXIT.usage);
    expect(inside.stderr).toContain('outside the capture folder');
    mkdirSync(path.join(root, 'other', 'snap20301108'), { recursive: true });
    const stray = await run(['--source', 'collectpure', '--folder', path.join(root, 'other', 'snap20301108'), '--manifest', manifest, '--dry-run'],
      registry({ collectpure: converter }));
    expect(stray.stderr).toContain('or a snapshot folder inside one');
    const { converter: walmart } = captureConverter('walmart');
    mkdirSync(path.join(root, 'walmart', 'snap20301108'), { recursive: true });
    const noSnapshots = await run(['--source', 'walmart', '--folder', path.join(root, 'walmart', 'snap20301108'), '--manifest', manifest, '--dry-run'],
      registry({ walmart }));
    expect(noSnapshots.status).toBe(METALS_CONVERT_EXIT.usage);
  });

  it('converts a retail payload file from its bytes alone', async () => {
    const { converter, calls } = retailConverter();
    const file = path.join(root, 'costco.retail-import.json');
    writeFileSync(file, '{"format":"synthetic"}');
    const result = await run(['--source', 'costco', '--retail-payload', file, '--dry-run'], registry({ costco: converter }));
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'metals-convert-dry-run', source: 'costco', report: { read: 1 } });
    expect(Buffer.from(calls[0].bytes).toString('utf8')).toBe('{"format":"synthetic"}');
    expect(calls[0].converterVersion).toBe(METALS_CONVERTER);
    const out = path.join(outRoot, 'costco.metals-import.json');
    const written = await run(['--source', 'costco', '--retail-payload', file, '--out', out], registry({ costco: converter }));
    expect(written.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(sha256(readFileSync(out))).toBe(JSON.parse(written.stdout).payload.sha256);
    const linked = path.join(outRoot, 'linked');
    mkdirSync(path.join(root, 'dir'));
    symlinkSync(path.join(root, 'dir'), linked, 'junction');
    try {
      const viaLink = await run(['--source', 'costco', '--retail-payload', linked, '--dry-run'], registry({ costco: converter }));
      expect(viaLink.status).toBe(METALS_CONVERT_EXIT.usage);
      expect(viaLink.stderr).toContain('must be an existing file, not a link');
    } finally {
      if (process.platform === 'win32') rmdirSync(linked);
      else unlinkSync(linked);
    }
  });

  it('passes a converter\'s refusal on by its code and path only, and nothing else of any error', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const argv = ['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--dry-run'];
    const throwing = (error: Error): MetalsCaptureConverter => ({ ...captureConverter('walmart').converter, convert: () => { throw error; } });
    const refused = await run(argv, registry({ walmart: throwing(new MetalsConvertError('schema-unsupported', '$.schema')) }));
    expect(refused.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(refused.stderr).toBe('holdr-metals-convert: schema-unsupported at $.schema\n');
    const unsafe = await run(argv, registry({ walmart: throwing(new MetalsConvertError('SAMPLE VALUE 4242', 'SAMPLE VALUE')) }));
    expect(unsafe.stderr).toBe('holdr-metals-convert: converter-invalid\n');
    const failed = await run(argv, registry({ walmart: throwing(new Error('SAMPLE SECRET 4242')) }));
    expect(failed.stderr).toBe('holdr-metals-convert: failed (Error)\n');
    expect(failed.stdout).toBe('');
  });

  it('refuses a payload that is not valid, not canonical, or not its source\'s, before writing anything', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    const argv = ['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest, '--out', out];
    const returning = (output: (capture: MetalsCaptureFolder) => { payload: MetalsImportPayload; json: string }): MetalsCaptureConverter => ({
      ...captureConverter('walmart').converter,
      convert: (capture) => ({ ...output(capture), report: {} }),
    });
    const valid = (capture: MetalsCaptureFolder): MetalsImportPayload => ({
      ...syntheticPayload('walmart', { orders: [walmartAdmittedOrder(1)] }), converterVersion: capture.converterVersion,
    });
    const tampered = (capture: MetalsCaptureFolder) => {
      const payload = valid(capture);
      payload.orders[0].unattributedMinor += 1;
      return { payload, json: serializeMetalsImportPayload(payload) };
    };
    const loose = (capture: MetalsCaptureFolder) => ({ payload: valid(capture), json: JSON.stringify(valid(capture)) });
    const other = (capture: MetalsCaptureFolder) => {
      const payload: MetalsImportPayload = { ...syntheticPayload('collectpure', {}), converterVersion: capture.converterVersion };
      return { payload, json: serializeMetalsImportPayload(payload) };
    };
    const older = (capture: MetalsCaptureFolder) => {
      const payload = { ...valid(capture), converterVersion: 'holdr-metals-convert 0.9.0' };
      return { payload, json: serializeMetalsImportPayload(payload) };
    };
    for (const [output, message] of [
      [tampered, 'holdr-metals-convert: converter-invalid at $.orders[0].unattributedMinor\n'],
      [loose, 'holdr-metals-convert: converter-invalid\n'],
      [other, 'holdr-metals-convert: converter-invalid\n'],
      [older, 'holdr-metals-convert: converter-invalid at $.converterVersion\n'],
    ] as const) {
      const result = await run(argv, registry({ walmart: returning(output) }));
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr).toBe(message);
      expect(existsSync(out)).toBe(false);
    }
  });

  it('reads and writes only the files it is given: no network, child process, dynamic code or environment', () => {
    const runtime = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = (file: string) => [...source(file).matchAll(runtime)].map((match) => match[1] ?? match[2]).sort();
    expect(imports('./metalsConvert.ts')).toEqual([
      './ownerOnlyOutput.js', '@finance-tracker/shared/metals-convert', '@finance-tracker/shared/metals-ledger', 'node:crypto', 'node:fs',
      'node:path',
    ]);
    expect(imports('./metalsConvertMain.ts')).toEqual(['./metalsConvert.js']);
    // The output check reads ACLs only through the repository's reviewed readers: windowsAcl.ts (PowerShell, Windows) and,
    // on macOS, darwinPathcheck.ts, a consumer of the ingress's pinned holdr-pathcheck.
    expect(imports('./ownerOnlyOutput.ts')).toEqual(['../e2e/windowsAcl.js', './darwinPathcheck.js', 'node:fs', 'node:path']);
    expect(imports('./darwinPathcheck.ts')).toEqual(['../control/holdrConf.js', '../ingress/nativeHelper.js', '../ingress/socketPath.js', 'node:child_process']);
    const darwinPathcheck = source('./darwinPathcheck.ts');
    expect(darwinPathcheck.match(/\bspawnSync\(/g)).toHaveLength(1);
    expect(darwinPathcheck).toContain("spawnSync(binaryPath, [target], {");
    expect(darwinPathcheck).toContain("env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],");
    expect(darwinPathcheck).not.toMatch(/\bshell\s*:|\bexecSync\b|\bexec\(|\bexecFile/);
    for (const file of ['./metalsConvert.ts', './metalsConvertMain.ts', './ownerOnlyOutput.ts']) {
      expect(source(file)).not.toMatch(/\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bnew\s+Function\b|\bprocess\.env\b|\bchild_process\b/);
    }
  });
});

describe('holdr-metals-convert: owner-only output', () => {
  let root: string;
  let outRoot: string;
  beforeEach(async () => {
    root = await makeScratchDir('metals-convert-');
    outRoot = await makeScratchDir('metals-convert-out-');
  });
  afterEach(async () => {
    await removeScratchDir(root);
    await removeScratchDir(outRoot);
  });

  const argsFor = (manifest: string) => ['--source', 'walmart', '--folder', path.join(root, 'walmart'), '--manifest', manifest];

  const unsafe: Array<[string, WindowsAcl]> = [
    ['Users may read it', sharedWith(USERS_GROUP)],
    ['Everyone may read it', sharedWith(EVERYONE)],
    ['another user owns it', ownerOnly(OTHER_USER)],
    ['it has no DACL, which lets everyone in', { owner: USER, aceTypes: null, aces: [] }],
    ['it holds an entry that cannot be checked', { owner: USER, aceTypes: ['AccessAllowed', 'AccessAllowedObject'], aces: ownerOnly().aces }],
  ];
  for (const [what, acl] of unsafe) {
    it(`refuses an output directory when ${what}, before reading anything`, async () => {
      const { converter, calls } = captureConverter('walmart');
      const manifest = writeFiles(root, walmartFiles());
      const out = path.join(outRoot, 'payload.json');
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: converter }), fakeAccess({ dir: acl }).access);
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
      expect(result.stdout).toBe('');
      expect(calls).toHaveLength(0);
      expect(existsSync(out)).toBe(false);
    });
  }

  it('refuses a new file that would let someone else in, and leaves no file behind', async () => {
    const { converter, calls } = captureConverter('walmart');
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    const { access, checked } = fakeAccess({ file: sharedWith(USERS_GROUP) });
    const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: converter }), access);
    expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(result.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
    expect(calls).toHaveLength(1);
    expect(checked).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
    expect(existsSync(out)).toBe(false);
  });

  it('takes deny entries, SYSTEM and Administrators as owner-only', async () => {
    const { converter } = captureConverter('walmart');
    const manifest = writeFiles(root, walmartFiles());
    const acl: WindowsAcl = {
      owner: USER,
      aceTypes: ['AccessDenied', 'AccessAllowed', 'AccessAllowed', 'AccessAllowed'],
      aces: [
        { sid: EVERYONE, rights: READ, type: 'Deny' }, { sid: USER, rights: FULL, type: 'Allow' },
        { sid: SYSTEM_SID, rights: FULL, type: 'Allow' }, { sid: ADMINISTRATORS_SID, rights: FULL, type: 'Allow' },
      ],
    };
    const result = await run([...argsFor(manifest), '--out', path.join(outRoot, 'payload.json')], registry({ walmart: converter }),
      fakeAccess({ dir: acl, file: acl }).access);
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
  });

  it('refuses an output place it cannot check, naming no path, whether the directory or the new file', async () => {
    const manifest = writeFiles(root, walmartFiles());
    for (const acls of [{ dir: new Error(`could not read ${outRoot}`) }, { file: new Error(`could not read ${outRoot}`) }]) {
      const { converter } = captureConverter('walmart');
      const out = path.join(outRoot, 'payload.json');
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: converter }), fakeAccess(acls).access);
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr).toBe('holdr-metals-convert: output-uncheckable\n');
      expect(existsSync(out)).toBe(false);
    }
  });

  it("refuses an --out path with a name Windows reads as another file or a device, before reading anything (G1d's P3)", async () => {
    writeFiles(root, walmartFiles());
    // A manifest that can't be read: the name's refusal comes first, so the manifest is never opened.
    const unreadable = path.join(root, 'unreadable-manifest.json');
    writeFileSync(unreadable, 'not a manifest');
    for (const folder of ALIAS_FOLDERS) mkdirSync(path.join(outRoot, folder));
    const payload = path.join(outRoot, 'payload.json');
    // The file's own name, and the name of a folder on the way to it.
    const outs = [`${payload}.`, `${payload} `, path.join(outRoot, 'NUL'), path.join(outRoot, 'Com1.json'), path.join(outRoot, 'conout$.json'),
      ...ALIAS_FOLDERS.map((folder) => path.join(outRoot, folder, 'payload.json'))];
    for (const out of outs) {
      const { converter, calls } = captureConverter('walmart');
      const { access, checked } = fakeAccess();
      const result = await run([...argsFor(unreadable), '--out', out], registry({ walmart: converter }), access);
      expect(calls, out).toHaveLength(0);
      expect(checked, out).toEqual([]);
      expect(result.stderr, out).toBe('holdr-metals-convert: output-name-refused\n');
      expect(result.status, out).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stdout, out).toBe('');
    }
    expect(readdirSync(outRoot).sort()).toEqual([...ALIAS_FOLDERS].sort());
    for (const folder of ALIAS_FOLDERS) expect(readdirSync(path.join(outRoot, folder)), folder).toEqual([]);
    // The control: an ordinary name gets past the rule to the manifest, which is refused as unreadable.
    const control = await run([...argsFor(unreadable), '--out', payload], registry({ walmart: captureConverter('walmart').converter }), fakeAccess().access);
    expect(control.stderr).toBe('holdr-metals-convert: manifest-unreadable\n');
    expect(existsSync(payload)).toBe(false);
  });

  // ROOT's macOS rule, read through the pinned holdr-pathcheck: owned by the current uid, no group or other mode bits, and
  // no ACL allow entry, inherited or explicit, for anyone but the current uid itself; deny entries are fine. Each
  // refusal below has its accept control: the same place without what refuses it.
  const darwinRefusals: Array<[string, MacFacts, MacFacts]> = [
    ['an inherited allow entry for group everyone', { acl: [macAce('allow', 'gid', EVERYONE_GID, ['inherited'])] },
      { acl: [macAce('deny', 'gid', EVERYONE_GID, ['inherited'])] }],
    ['an explicit allow entry for another user', { acl: [macAce('allow', 'uid', MAC_OTHER_UID)] }, { acl: [macAce('allow', 'uid', MAC_UID)] }],
    ["an allow entry for the user's own group", { acl: [macAce('allow', 'gid', STAFF_GID)] }, { acl: [macAce('deny', 'gid', STAFF_GID)] }],
    // A group's number may equal the uid's: only a uid entry is the user.
    ['an allow entry for a group numbered as the uid', { acl: [macAce('allow', 'gid', MAC_UID)] }, { acl: [macAce('allow', 'uid', MAC_UID)] }],
    ...[0o040, 0o020, 0o010, 0o004, 0o002, 0o001].map((bit): [string, MacFacts, MacFacts] => [`mode 0${(0o600 | bit).toString(8)}`, { mode: 0o600 | bit }, { mode: 0o600 }]),
    ['another owner', { uid: MAC_OTHER_UID }, {}],
  ];
  for (const [what, refused, control] of darwinRefusals) {
    it(`on macOS, refuses an output directory with ${what} before reading anything, and takes it without`, async () => {
      const manifest = writeFiles(root, walmartFiles());
      // A manifest that can't be read: refused first by the directory, the manifest is never opened.
      const unreadable = path.join(root, 'unreadable-manifest.json');
      writeFileSync(unreadable, 'not a manifest');
      const out = path.join(outRoot, 'payload.json');
      const { converter, calls } = captureConverter('walmart');
      const result = await run([...argsFor(unreadable), '--out', out], registry({ walmart: converter }), fakeDarwinAccess({ dir: refused }).access);
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
      expect(result.stdout).toBe('');
      expect(calls).toHaveLength(0);
      expect(existsSync(out)).toBe(false);
      const accepted = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }),
        fakeDarwinAccess({ dir: control }).access);
      expect(accepted.status).toBe(METALS_CONVERT_EXIT.ok);
      expect(existsSync(out)).toBe(true);
    });

    it(`on macOS, refuses a new file with ${what} while it is empty, leaving no file behind, and takes it without`, async () => {
      const manifest = writeFiles(root, walmartFiles());
      const out = path.join(outRoot, 'payload.json');
      const { access, checked } = fakeDarwinAccess({ file: refused });
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), access);
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
      expect(checked).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
      expect(existsSync(out)).toBe(false);
      const accepted = fakeDarwinAccess({ file: control });
      const written = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), accepted.access);
      expect(written.status).toBe(METALS_CONVERT_EXIT.ok);
      expect(accepted.checked).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
      expect(existsSync(out)).toBe(true);
    });
  }

  it('on macOS, takes deny entries only, a self allow entry, or no ACL at all, for the directory and the new file', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const accepted: Array<[string, MacFacts]> = [
      ['deny-only', { acl: [macAce('deny', 'gid', EVERYONE_GID), macAce('deny', 'uid', MAC_OTHER_UID, ['inherited'])] }],
      ['self-allow', { acl: [macAce('allow', 'uid', MAC_UID, ['file_inherit', 'directory_inherit'])] }],
      ['no-acl', {}],
    ];
    for (const [what, facts] of accepted) {
      const out = path.join(outRoot, `${what}.json`);
      const { access, checked } = fakeDarwinAccess({ dir: facts, file: facts });
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), access);
      expect(result.status, what).toBe(METALS_CONVERT_EXIT.ok);
      expect(checked, what).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
      expect(existsSync(out), what).toBe(true);
    }
  });

  it('on macOS, refuses at the directory before anything is read, though the new file would pass', async () => {
    writeFiles(root, walmartFiles());
    // A manifest that can't be read: the directory's refusal comes first, and once the directory passes, the manifest's.
    const unreadable = path.join(root, 'unreadable-manifest.json');
    writeFileSync(unreadable, 'not a manifest');
    const out = path.join(outRoot, 'payload.json');
    const { converter, calls } = captureConverter('walmart');
    const { access, checked } = fakeDarwinAccess({ dir: { acl: [macAce('allow', 'gid', EVERYONE_GID, ['inherited'])] }, file: {} });
    const result = await run([...argsFor(unreadable), '--out', out], registry({ walmart: converter }), access);
    expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(result.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
    expect(calls).toHaveLength(0);
    expect(checked).toEqual([{ kind: 'dir', bytes: 0 }]);
    expect(existsSync(out)).toBe(false);
    const passed = await run([...argsFor(unreadable), '--out', out], registry({ walmart: converter }), fakeDarwinAccess().access);
    expect(passed.stderr).toBe('holdr-metals-convert: manifest-unreadable\n');
    expect(existsSync(out)).toBe(false);
  });

  it('on macOS, checks a new file by its real path, however --out names it', async () => {
    const manifest = writeFiles(root, walmartFiles());
    // The pinned reader takes canonical absolute paths only (the stand-in enforces it): `.` and `..` in --out are read
    // as the real directory joined with the name.
    const named = [`${outRoot}${path.sep}.${path.sep}dot.json`, `${outRoot}${path.sep}..${path.sep}${path.basename(outRoot)}${path.sep}dotdot.json`];
    for (const out of named) {
      const { access, checked } = fakeDarwinAccess();
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), access);
      expect(result.status, out).toBe(METALS_CONVERT_EXIT.ok);
      expect(checked, out).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
      expect(existsSync(path.join(outRoot, path.basename(out))), out).toBe(true);
    }
  });

  it('on macOS, checks the directory again with the new file, and refuses one that let someone in by then', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    const { access, checked } = fakeDarwinAccess({ parentAtWrite: { acl: [macAce('allow', 'gid', EVERYONE_GID, ['inherited'])] } });
    const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), access);
    expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(result.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
    expect(checked).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
    expect(existsSync(out)).toBe(false);
  });

  it('on macOS, refuses as uncheckable, naming no path, a directory or new file the reader cannot read, or no uid', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    const failing = new Error(`pathcheck: ${outRoot}: acl-acquisition-failed`);
    for (const access of [fakeDarwinAccess({ dir: failing }).access, fakeDarwinAccess({ file: failing }).access, fakeDarwinAccess({}, failing).access]) {
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), access);
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr).toBe('holdr-metals-convert: output-uncheckable\n');
      expect(existsSync(out)).toBe(false);
    }
  });

  it('on macOS, refuses as uncheckable a path the reader saw that is not the new file: another device, or another inode', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    for (const [what, access] of [['device', fakeDarwinAccess({ fileDev: '1' }).access], ['inode', fakeDarwinAccess({ fileIno: '1' }).access]] as const) {
      const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), access);
      expect(result.status, what).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stderr, what).toBe('holdr-metals-convert: output-uncheckable\n');
      expect(existsSync(out), what).toBe(false);
    }
  });

  it("on macOS, refuses as uncheckable a new file read without its directory's record", async () => {
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }),
      fakeDarwinAccess({ noParent: true }).access);
    expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(result.stderr).toBe('holdr-metals-convert: output-uncheckable\n');
    expect(existsSync(out)).toBe(false);
  });

  it('on macOS, refuses output as uncheckable with no macOS reader, as before', async () => {
    const manifest = writeFiles(root, walmartFiles());
    const out = path.join(outRoot, 'payload.json');
    const noReader: OutputAccess = { platform: 'darwin', currentUserSid: () => USER, readAcls: () => [] };
    const result = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), noReader);
    expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(result.stderr).toBe('holdr-metals-convert: output-uncheckable\n');
    expect(existsSync(out)).toBe(false);
  });
  it.runIf(process.platform === 'win32')('on Windows, for real: writes into a directory only the user can open, refuses one Users may read', async () => {
    const sid = readCurrentUserSid();
    const base = realpathSync.native(mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'metals-out-')));
    try {
      const own = path.join(base, 'own');
      const shared = path.join(base, 'shared');
      for (const dir of [own, shared]) {
        mkdirSync(dir);
        restrictToUser(dir, sid);
      }
      execFileSync(system32('icacls.exe'), [shared, '/grant', `*${USERS_GROUP}:(OI)(CI)R`], { stdio: 'ignore' });
      const manifest = writeFiles(root, walmartFiles());
      const written = await run([...argsFor(manifest), '--out', path.join(own, 'payload.json')], registry({ walmart: captureConverter('walmart').converter }),
        platformOutputAccess);
      expect(written.status).toBe(METALS_CONVERT_EXIT.ok);
      expect(ownerOnlyAcl(readWindowsAcls([path.join(own, 'payload.json')])[0], sid)).toBe(true);
      const refused = await run([...argsFor(manifest), '--out', path.join(shared, 'payload.json')], registry({ walmart: captureConverter('walmart').converter }),
        platformOutputAccess);
      expect(refused.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(refused.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
      expect(existsSync(path.join(shared, 'payload.json'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it.runIf(process.platform !== 'win32' && process.platform !== 'darwin')('on POSIX, for real: 0600 in a 0700 directory; refuses one others may enter', async () => {
    const manifest = writeFiles(root, walmartFiles());
    chmodSync(outRoot, 0o700);
    const out = path.join(outRoot, 'payload.json');
    const written = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), platformOutputAccess);
    expect(written.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    chmodSync(outRoot, 0o755);
    const refused = await run([...argsFor(manifest), '--out', path.join(outRoot, 'other.json')], registry({ walmart: captureConverter('walmart').converter }),
      platformOutputAccess);
    expect(refused.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
    expect(existsSync(path.join(outRoot, 'other.json'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('on macOS, for real, through the pinned reader: writes into a 0700 directory; refuses one that inherited an allow for everyone', async () => {
    // The repository's own build of holdr-pathcheck and its pin, in a short directory (the reader takes paths of 100 bytes).
    const fixture = nativeFixture();
    try {
      const reader: OutputAccess = {
        platform: 'darwin', currentUserSid: () => USER, readAcls: () => [],
        darwin: { currentUid: () => process.getuid!(), readPath: (target) => readPinnedPathcheck(target, fixture.native) },
      };
      const manifest = writeFiles(root, walmartFiles());
      const own = fixture.mkdir('own', 0o700);
      const out = path.join(own, 'p.json');
      const written = await run([...argsFor(manifest), '--out', out], registry({ walmart: captureConverter('walmart').converter }), reader);
      expect(written.status).toBe(METALS_CONVERT_EXIT.ok);
      const [, file] = readPinnedPathcheck(out, fixture.native).slice(-2) as PathObject[];
      expect(ownerOnlyDarwinPath(file, process.getuid!())).toBe(true);
      const parent = fixture.mkdir('parent', 0o700);
      fixture.acl(parent, 'group:everyone allow list,search,file_inherit,directory_inherit');
      const shared = path.join(parent, 'shared');
      mkdirSync(shared, { mode: 0o700 });
      const [sharedRecord] = readPinnedPathcheck(shared, fixture.native).slice(-1) as PathObject[];
      expect(sharedRecord.acl).toContainEqual(expect.objectContaining({ type: 'allow', principal: 'gid', flags: expect.arrayContaining(['inherited']) }));
      const refused = await run([...argsFor(manifest), '--out', path.join(shared, 'p.json')], registry({ walmart: captureConverter('walmart').converter }), reader);
      expect(refused.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(refused.stderr).toBe('holdr-metals-convert: output-not-owner-only\n');
      expect(existsSync(path.join(shared, 'p.json'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});
