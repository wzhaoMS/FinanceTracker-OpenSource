/**
 * holdr-metals-convert --source collectpure end to end: a synthetic CollectPure account folder, its nested snapshot and
 * their private manifest in a scratch directory, converted by the registry's real CollectPure converter. Synthetic only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  syntheticCollectPureFiles,
  syntheticCollectPureSales,
  syntheticCollectPureSalesPayloadValues,
  syntheticCollectPureSalesSecrets,
  syntheticCollectPureSalesSnapshot,
} from '@finance-tracker/shared/metals-convert-fixtures';
import { validateMetalsImportPayload } from '@finance-tracker/shared/metals-ledger';

import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { METALS_CONVERT_EXIT, METALS_CONVERT_SOURCES, runMetalsConvertCli } from './metalsConvert.js';
import type { OutputAccess } from './ownerOnlyOutput.js';

/** Output places read as owner-only: their real check is metalsConvert.test.ts's. */
const USER = 'S-1-5-21-1000-1000-1000-1001';
const OWNER_ONLY: OutputAccess = {
  platform: 'win32',
  currentUserSid: () => USER,
  readAcls: (paths) => paths.map(() => ({ owner: USER, aceTypes: ['AccessAllowed'], aces: [{ sid: USER, rights: 0x1f01ff, type: 'Allow' }] })),
};

function run(argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  return runMetalsConvertCli(argv, io, METALS_CONVERT_SOURCES, OWNER_ONLY).then((status) => ({ status, ...out }));
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Writes the account folder `collectpure` (its four sales), its snapshot `collectpure/snap20261108`, and a raw file of no
 * layout in each, all listed in one manifest at the root.
 */
function writeCapture(root: string): string {
  const files: Array<{ relative: string; bytes: Uint8Array }> = [];
  const add = (folder: string, captured: Array<{ path: string; bytes: Uint8Array }>) => {
    for (const file of captured) files.push({ relative: `${folder}/${file.path}`, bytes: file.bytes });
    files.push({ relative: `${folder}/raw/sell-orders-offset0.json`, bytes: new TextEncoder().encode('{"SAMPLE":true}') });
  };
  add('collectpure', syntheticCollectPureFiles(syntheticCollectPureSales()));
  add('collectpure/snap20261108', syntheticCollectPureFiles(syntheticCollectPureSalesSnapshot()));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file.relative)), { recursive: true });
    writeFileSync(path.join(root, file.relative), file.bytes);
  }
  const manifest = path.join(root, 'manifest.private.json');
  writeFileSync(manifest, JSON.stringify({
    createdAt: '2030-01-31T00:00:00.000Z', lane: 'synthetic',
    files: files.map((file) => ({ path: file.relative, bytes: file.bytes.length, sha256: sha256(file.bytes) })),
  }));
  return manifest;
}

function assertValueFree(text: string): void {
  for (const value of [...syntheticCollectPureSalesSecrets(), ...syntheticCollectPureSalesPayloadValues()]) {
    expect(text.includes(value), `the output shows ${value}`).toBe(false);
  }
}

describe('holdr-metals-convert --source collectpure', () => {
  let root: string;
  let outRoot: string;
  beforeEach(async () => {
    root = await makeScratchDir('metals-convert-collectpure-');
    outRoot = await makeScratchDir('metals-convert-collectpure-out-');
  });
  afterEach(async () => {
    await removeScratchDir(root);
    await removeScratchDir(outRoot);
  });

  it('dry-runs an account folder through the registry, reading only its layout, and reports value-free', async () => {
    const manifest = writeCapture(root);
    const result = await run(['--source', 'collectpure', '--folder', path.join(root, 'collectpure'), '--manifest', manifest, '--dry-run']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.code).toBe('metals-convert-dry-run');
    expect(report.source).toBe('collectpure');
    expect(report.report.converter).toBe('collectpure@1');
    expect(report.report.snapshot).toBe(false);
    expect(report.report.sellOrders).toMatchObject({ listed: 4, converted: 4, held: 0 });
    // The layout's ten files: the consolidated file, four raw sell orders, two payout-history pages, three stats files.
    expect(report.report.capture.files).toBe(10);
    expect(report.payload).toMatchObject({ written: false, held: 0, orders: 4, competitors: 0 });
    assertValueFree(JSON.stringify(report.report));
  });

  it('writes the payload a new, valid file, and converts the nested snapshot on its own under its account', async () => {
    const manifest = writeCapture(root);
    const out = path.join(outRoot, 'collectpure.metals.json');
    const base = await run(['--source', 'collectpure', '--folder', path.join(root, 'collectpure'), '--manifest', manifest, '--out', out]);
    expect(base.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(JSON.parse(base.stdout).code).toBe('metals-converted');
    const written = JSON.parse(readFileSync(out, 'utf8')) as unknown;
    const checked = validateMetalsImportPayload(written);
    expect(checked.ok).toBe(true);
    const snapshot = await run(['--source', 'collectpure', '--folder', path.join(root, 'collectpure', 'snap20261108'), '--manifest', manifest, '--dry-run']);
    expect(snapshot.status).toBe(METALS_CONVERT_EXIT.ok);
    const report = JSON.parse(snapshot.stdout) as Record<string, any>;
    expect(report.report.snapshot).toBe(true);
    expect(report.report.sellOrders).toMatchObject({ listed: 4, converted: 4, held: 0 });
    assertValueFree(JSON.stringify(report.report));
  });

  it('writes nothing while a sale is held, unless --skip-held', async () => {
    const manifest = writeCapture(root);
    const folder = path.join(root, 'collectpure');
    const rawFile = readFileSync(manifest, 'utf8').match(/collectpure\/raw\/(sell-order-[A-Za-z0-9_-]+\.json)/)![1];
    rmSync(path.join(folder, 'raw', rawFile));
    const out = path.join(outRoot, 'held.metals.json');
    const held = await run(['--source', 'collectpure', '--folder', folder, '--manifest', manifest, '--out', out]);
    expect(held.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(JSON.parse(held.stdout).code).toBe('metals-held');
    expect(JSON.parse(held.stdout).report.held).toEqual({ 'raw-missing/raw-sell-order': 1 });
    expect(existsSync(out)).toBe(false);
    const skipped = await run(['--source', 'collectpure', '--folder', folder, '--manifest', manifest, '--out', out, '--skip-held']);
    expect(skipped.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(JSON.parse(skipped.stdout).payload).toMatchObject({ written: true, held: 1, orders: 3 });
    assertValueFree(`${JSON.stringify(JSON.parse(held.stdout).report)}${held.stderr}${JSON.stringify(JSON.parse(skipped.stdout).report)}${skipped.stderr}`);
  });
});
