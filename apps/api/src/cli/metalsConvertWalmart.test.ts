/**
 * Walmart captures through holdr-metals-convert, end to end: a synthetic account folder (walmart.json, its order
 * list's pages and its raw details) and its private manifest written to a scratch directory, converted as a dry run
 * and into a payload by the registry's own Walmart converter. Synthetic fixtures only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { walmartCaptureConverter } from '@finance-tracker/shared/metals-convert';
import {
  syntheticWalmartFolder,
  syntheticWalmartMetalsSensitiveValues,
  syntheticWalmartMetalsSpec,
  type SyntheticWalmartFolder,
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

/** Writes a folder as the pull lays it out, with a manifest listing every file (or those `listed` keeps). */
function writeFolder(root: string, folder: SyntheticWalmartFolder, listed: (relative: string) => boolean = () => true) {
  const files: Record<string, string> = {
    'walmart/walmart.json': JSON.stringify(folder.consolidated),
    ...Object.fromEntries(folder.listPages.map((page) => [`walmart/raw/${page.name}`, JSON.stringify(page.json)])),
    ...Object.fromEntries(folder.rawDetails.map((detail) => [`walmart/raw/${detail.name}`, JSON.stringify(detail.json)])),
  };
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
    if (listed(relative)) entries.push({ path: relative, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
  const manifest = path.join(root, 'manifest.private.json');
  writeFileSync(manifest, JSON.stringify({ createdAt: '2030-01-31T00:00:00.000Z', lane: 'synthetic', files: entries }));
  return { folder: path.join(root, 'walmart'), manifest };
}

/** Output shows no invented value, path or file name; the payload's own digest and size are set aside first. */
function expectValueFree(stdout: string, stderr: string, root: string) {
  const parsed = stdout === '' ? null : JSON.parse(stdout);
  if (parsed !== null) {
    delete parsed.payload.sha256;
    delete parsed.payload.bytes;
  }
  const text = `${parsed === null ? '' : JSON.stringify(parsed)}${stderr}`;
  for (const value of syntheticWalmartMetalsSensitiveValues()) expect(text, `shows ${value}`).not.toContain(value);
  expect(text).not.toContain(root);
  expect(text).not.toMatch(/detail-[0-9]+|list-p[0-9]+/);
}

describe('holdr-metals-convert --source walmart', () => {
  let root: string;
  let outRoot: string;
  beforeEach(async () => {
    root = await makeScratchDir('metals-walmart-');
    outRoot = await makeScratchDir('metals-walmart-out-');
  });
  afterEach(async () => {
    await removeScratchDir(root);
    await removeScratchDir(outRoot);
  });

  it('is wired to the Walmart converter', () => {
    expect(METALS_CONVERT_SOURCES.walmart).toBe(walmartCaptureConverter);
  });

  it('dry-runs an account folder and prints counts, closed codes, dates and digests only', async () => {
    const { folder, manifest } = writeFolder(root, syntheticWalmartFolder(syntheticWalmartMetalsSpec()));
    const result = await run(['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--dry-run']);
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    const report = JSON.parse(result.stdout);
    expect(report.code).toBe('metals-convert-dry-run');
    expect(report.source).toBe('walmart');
    expect(report.report.records).toEqual({ read: 7, metal: 3, flagged: 0, competitors: 3, noCardFunding: 1, held: 0, duplicates: { identical: 0, differing: 0 } });
    expect(report.report.admission).toEqual({ qualifying: { metal: 2, other: 1 }, aggregate: { metal: 1, other: 2 }, withheld: 0 });
    expect(report.report.census).toMatchObject({ universe: 3, metal: 3, flagged: 0, drift: 0, omissions: 0 });
    expect(report.report.coverage.basis).toBe('rows read to the pager\'s end');
    expect(report.payload).toMatchObject({ written: false, held: 0, orders: 3, competitors: 3 });
    expectValueFree(result.stdout, result.stderr, root);
  });

  it('writes a payload that validates, the same bytes from the same capture', async () => {
    const { folder, manifest } = writeFolder(root, syntheticWalmartFolder(syntheticWalmartMetalsSpec()));
    const out = path.join(outRoot, 'walmart.metals-import.json');
    const first = await run(['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--out', out]);
    expect(first.status).toBe(METALS_CONVERT_EXIT.ok);
    const bytes = readFileSync(out);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(JSON.parse(first.stdout).payload.sha256);
    const checked = validateMetalsImportPayload(JSON.parse(bytes.toString('utf8')));
    expect(checked.ok).toBe(true);
    const again = path.join(outRoot, 'again.json');
    await run(['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--out', again]);
    expect(readFileSync(again)).toEqual(bytes);
    expectValueFree(first.stdout, first.stderr, root);
  });

  it('writes nothing when an order is held, unless told to skip held records', async () => {
    const spec = syntheticWalmartMetalsSpec();
    spec.orders[0] = { ...spec.orders[0], discounts: [{ label: 'Savings', cents: -500 }] };
    const { folder, manifest } = writeFolder(root, syntheticWalmartFolder(spec));
    const out = path.join(outRoot, 'held.json');
    const held = await run(['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--out', out]);
    expect(held.status).toBe(METALS_CONVERT_EXIT.refused);
    const report = JSON.parse(held.stdout);
    expect(report.code).toBe('metals-held');
    expect(report.report.heldByCheck.discounts).toBe(1);
    expect(report.report.heldByReason['field-unsupported']).toBe(1);
    expect(existsSync(out)).toBe(false);
    const skipped = await run(['--source', 'walmart', '--folder', folder, '--manifest', manifest, '--out', out, '--skip-held']);
    expect(skipped.status).toBe(METALS_CONVERT_EXIT.ok);
    const payload = JSON.parse(readFileSync(out, 'utf8'));
    expect(validateMetalsImportPayload(payload).ok).toBe(true);
    expect(payload.held).toHaveLength(1);
    expect(payload.held[0]).toMatchObject({ channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'discounts' });
    expectValueFree(held.stdout, held.stderr, root);
  });

  it('refuses a raw file the manifest does not list, and a folder of another schema', async () => {
    const unlisted = writeFolder(root, syntheticWalmartFolder(syntheticWalmartMetalsSpec()), (relative) => !relative.endsWith('list-p002.json'));
    const missing = await run(['--source', 'walmart', '--folder', unlisted.folder, '--manifest', unlisted.manifest, '--dry-run']);
    expect(missing.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(missing.stderr).toBe('holdr-metals-convert: manifest-mismatch\n');
    expect(missing.stdout).toBe('');

    const other = syntheticWalmartFolder(syntheticWalmartMetalsSpec());
    other.consolidated.schema = 'holdr-retail-capture/walmart@9';
    const second = await makeScratchDir('metals-walmart-');
    try {
      const written = writeFolder(second, other);
      const schema = await run(['--source', 'walmart', '--folder', written.folder, '--manifest', written.manifest, '--dry-run']);
      expect(schema.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(schema.stderr).toBe('holdr-metals-convert: schema-unsupported\n');
    } finally {
      await removeScratchDir(second);
    }
  });
});
