/**
 * Costco captures through the owner's offline converter, end to end: a synthetic membership folder and its private
 * manifest written to a scratch directory, converted as a dry run and into a payload. Synthetic fixtures only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateRetailImportPayload } from '@finance-tracker/shared/retail-import-tool';
import {
  syntheticCostcoCapture,
  syntheticMembershipSpec,
  syntheticSensitiveValues,
  type SyntheticCaptureSpec,
} from '@finance-tracker/shared/retail-capture-fixtures';

import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { RETAIL_CONVERT_EXIT, runRetailConvertCli } from './retailConvert.js';

function run(argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  return runRetailConvertCli(argv, io).then((status) => ({ status, ...out }));
}

function expectValueFree(text: string, root: string) {
  for (const value of syntheticSensitiveValues()) expect(text, `shows ${value}`).not.toContain(value);
  expect(text).not.toContain(root);
  expect(text).not.toMatch(/detail-[0-9]+|receipt-[0-9a-f]{8}/);
}

/** Writes a capture as the pull lays it out, with a manifest of every file, and returns the paths. */
function writeCapture(root: string, spec: SyntheticCaptureSpec) {
  const folderName = spec.folder ?? 'costco';
  const capture = syntheticCostcoCapture(spec);
  const folder = path.join(root, folderName);
  mkdirSync(path.join(folder, 'raw', 'receipts'), { recursive: true });
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const write = (relative: string, json: unknown) => {
    const text = JSON.stringify(json);
    writeFileSync(path.join(root, relative), text);
    files.push({ path: relative, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  };
  write(path.join(folderName, 'costco.json'), capture.consolidated);
  capture.rawReceipts.forEach((file, index) => write(path.join(folderName, 'raw', 'receipts', `receipt-${String(index).padStart(16, 'a')}.json`), file.json));
  capture.rawDetails.forEach((file) => write(path.join(folderName, 'raw', file.name), file.json));
  const manifest = path.join(root, 'manifest.private.json');
  writeFileSync(manifest, JSON.stringify({ createdAt: '2026-01-02T03:04:05.000Z', lane: 'synthetic', root: 'synthetic', files }));
  return { folder, manifest, files };
}

describe('holdr-retail-convert', () => {
  let root: string;
  /** Where payloads go: never inside the capture, nor the folder of its manifest. */
  let outRoot: string;
  beforeEach(async () => {
    root = await makeScratchDir('retail-convert-');
    outRoot = await makeScratchDir('retail-convert-out-');
  });
  afterEach(async () => {
    await removeScratchDir(root);
    await removeScratchDir(outRoot);
  });

  it('dry-runs a membership folder and prints counts, codes and dates only', async () => {
    const { folder, manifest } = writeCapture(root, syntheticMembershipSpec());
    const result = await run(['--folder', folder, '--manifest', manifest, '--dry-run']);
    expect(result.status).toBe(RETAIL_CONVERT_EXIT.ok);
    const report = JSON.parse(result.stdout);
    expect(report.code).toBe('retail-convert-dry-run');
    expect(report.receipts.accepted).toBe(7);
    expect(report.payload.written).toBe(false);
    expect(report.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expectValueFree(result.stdout + result.stderr, root);
  });

  it('writes the payload to a new file whose SHA-256 is the report\'s, and the same bytes twice', async () => {
    const { folder, manifest } = writeCapture(root, syntheticMembershipSpec());
    const out = path.join(outRoot, 'costco-2.retail-import.json');
    const first = await run(['--folder', folder, '--manifest', manifest, '--out', out]);
    expect(first.status).toBe(RETAIL_CONVERT_EXIT.ok);
    const report = JSON.parse(first.stdout);
    expect(report.code).toBe('retail-converted');
    const bytes = readFileSync(out);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(report.payload.sha256);
    expect(validateRetailImportPayload(JSON.parse(bytes.toString('utf8'))).ok).toBe(true);
    const again = await run(['--folder', folder, '--manifest', manifest, '--out', path.join(outRoot, 'again.json')]);
    expect(readFileSync(path.join(outRoot, 'again.json'))).toEqual(bytes);
    expectValueFree(first.stdout + first.stderr + again.stdout, root);
  });

  it('refuses a file the manifest does not list, or lists with other contents', async () => {
    const { folder, manifest } = writeCapture(root, syntheticMembershipSpec());
    writeFileSync(path.join(folder, 'raw', 'detail-123456789.json'), '{}');
    const unlisted = await run(['--folder', folder, '--manifest', manifest, '--dry-run']);
    expect(unlisted.status).toBe(RETAIL_CONVERT_EXIT.refused);
    expect(unlisted.stderr).toContain('manifest-mismatch');
    expect(unlisted.stdout).toBe('');

    const second = await makeScratchDir('retail-convert-');
    try {
      const capture = writeCapture(second, syntheticMembershipSpec());
      writeFileSync(path.join(capture.folder, 'costco.json'), readFileSync(path.join(capture.folder, 'costco.json'), 'utf8').replace('Synthetic range', 'Synthetic ranges'));
      const changed = await run(['--folder', capture.folder, '--manifest', capture.manifest, '--dry-run']);
      expect(changed.status).toBe(RETAIL_CONVERT_EXIT.refused);
      expect(changed.stderr).toContain('manifest-mismatch');
      expectValueFree(changed.stderr, second);
    } finally {
      await removeScratchDir(second);
    }
  });

  it('writes nothing when a record is held, unless told to skip held records', async () => {
    const spec = syntheticMembershipSpec();
    spec.receipts![0].tenders[0].name = 'SAMPLE WALLET';
    const { folder, manifest } = writeCapture(root, spec);
    const out = path.join(outRoot, 'held.json');
    const held = await run(['--folder', folder, '--manifest', manifest, '--out', out]);
    expect(held.status).toBe(RETAIL_CONVERT_EXIT.refused);
    expect(JSON.parse(held.stdout).code).toBe('retail-held');
    expect(JSON.parse(held.stdout).receipts.heldByReason['tender-unknown']).toBe(1);
    expect(JSON.parse(held.stdout).receipts.heldByCheck['tender-name']).toBe(1);
    expect(existsSync(out)).toBe(false);
    const skipped = await run(['--folder', folder, '--manifest', manifest, '--out', out, '--skip-held']);
    expect(skipped.status).toBe(RETAIL_CONVERT_EXIT.ok);
    expect(existsSync(out)).toBe(true);
    expectValueFree(held.stdout + held.stderr + skipped.stdout, root);
  });

  it('refuses usage errors before reading anything', async () => {
    const { folder, manifest } = writeCapture(root, syntheticMembershipSpec());
    const existing = path.join(outRoot, 'exists.json');
    writeFileSync(existing, '{}');
    const cases: Array<[string[], string]> = [
      [['--folder', folder, '--manifest', manifest], 'give --dry-run or --out'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--out', path.join(outRoot, 'x.json')], 'give --dry-run or --out'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--skip-held'], '--skip-held goes with --out'],
      [['--folder', folder, '--dry-run'], 'give --folder DIR and --manifest FILE'],
      [['--folder', root, '--manifest', manifest, '--dry-run'], 'membership folder'],
      [['--folder', folder, '--manifest', manifest, '--out', existing], 'already exists'],
      [['--folder', folder, '--manifest', manifest, '--out', path.join(folder, 'payload.json')], 'outside the capture folder'],
      [['--folder', folder, '--manifest', manifest, '--out', path.join(root, 'payload.json')], "outside the folder of the capture's manifest"],
      [['--folder', folder, '--manifest', manifest, '--dry-run', 'extra'], 'unexpected argument'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--unknown'], 'unknown option'],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv);
      expect(result.status, argv.join(' ')).toBe(RETAIL_CONVERT_EXIT.usage);
      expect(result.stderr).toContain(message);
    }
    expect((await run(['--version'])).stdout).toMatch(/^holdr-retail-convert \d+\.\d+\.\d+\n$/);
  });

  it('refuses a folder of another schema with a closed code', async () => {
    const { folder, manifest } = writeCapture(root, { ...syntheticMembershipSpec(), schema: 'holdr-retail-capture/costco@9' });
    const result = await run(['--folder', folder, '--manifest', manifest, '--dry-run']);
    expect(result.status).toBe(RETAIL_CONVERT_EXIT.refused);
    expect(result.stderr).toBe('holdr-retail-convert: schema-unsupported\n');
  });

  it('refuses --out through a link or junction anywhere on its path that leads back into the capture (R4)', async () => {
    const { folder, manifest } = writeCapture(root, syntheticMembershipSpec());
    mkdirSync(path.join(folder, 'output'));
    const intoCapture = path.join(outRoot, 'alias');
    const intoRoot = path.join(outRoot, 'root-alias');
    // A junction on Windows (no privilege needed); a symbolic link elsewhere, where the type is ignored.
    symlinkSync(folder, intoCapture, 'junction');
    symlinkSync(root, intoRoot, 'junction');
    try {
      const viaCapture = await run(['--folder', folder, '--manifest', manifest, '--out', path.join(intoCapture, 'output', 'payload.json')]);
      expect(viaCapture.status).toBe(RETAIL_CONVERT_EXIT.usage);
      expect(viaCapture.stderr).toContain('outside the capture folder');
      expect(existsSync(path.join(folder, 'output', 'payload.json'))).toBe(false);
      const viaRoot = await run(['--folder', folder, '--manifest', manifest, '--out', path.join(intoRoot, 'payload.json')]);
      expect(viaRoot.status).toBe(RETAIL_CONVERT_EXIT.usage);
      expect(viaRoot.stderr).toContain("outside the folder of the capture's manifest");
      expect(existsSync(path.join(root, 'payload.json'))).toBe(false);
    } finally {
      for (const link of [intoCapture, intoRoot]) {
        if (process.platform === 'win32') rmdirSync(link);
        else unlinkSync(link);
      }
    }
  });

  it('reads and writes only the files it is given: no network, child process, dynamic code or environment', () => {
    const runtime = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = (file: string) => [...source(file).matchAll(runtime)].map((match) => match[1] ?? match[2]).sort();
    expect(imports('./retailConvert.ts')).toEqual(['@finance-tracker/shared/retail-import-tool', 'node:crypto', 'node:fs', 'node:path']);
    expect(imports('./retailConvertMain.ts')).toEqual(['./retailConvert.js']);
    for (const file of ['./retailConvert.ts', './retailConvertMain.ts']) {
      expect(source(file)).not.toMatch(/\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bnew\s+Function\b|\bprocess\.env\b|\bchild_process\b/);
    }
  });
});
