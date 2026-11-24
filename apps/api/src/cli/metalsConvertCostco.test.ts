/**
 * `holdr-metals-convert --source costco`, end to end: a synthetic Costco capture through the retail converter (retail
 * policy 5, format 3), its payload written to a scratch directory, then converted as a dry run and into a metals
 * payload. Synthetic fixtures only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateMetalsImportPayload } from '@finance-tracker/shared/metals-ledger';
import { syntheticCostcoCapture, syntheticMembershipSpec, syntheticSensitiveValues } from '@finance-tracker/shared/retail-capture-fixtures';
import { convertCostcoCapture } from '@finance-tracker/shared/retail-import-tool';

import type { WindowsAcl } from '../e2e/windowsAcl.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { METALS_CONVERT_EXIT, METALS_CONVERT_SOURCES, runMetalsConvertCli } from './metalsConvert.js';
import type { OutputAccess } from './ownerOnlyOutput.js';

/** A synthetic current user. */
const USER = 'S-1-5-21-1000-1000-1000-1001';
const OWNER_ONLY: WindowsAcl = { owner: USER, aceTypes: ['AccessAllowed'], aces: [{ sid: USER, rights: 0x1f01ff, type: 'Allow' }] };

/**
 * A stand-in owner-only check (Windows, by SID), so a scratch directory can take `--out`: every path reads as owned by
 * and open to the current user only. It records each path it checks, and a file's size then.
 */
function ownerOnlyAccess() {
  const checked: Array<{ kind: 'dir' | 'file'; bytes: number }> = [];
  const access: OutputAccess = {
    platform: 'win32',
    currentUserSid: () => USER,
    readAcls: (paths) => paths.map((target) => {
      const stat = statSync(target);
      checked.push(stat.isDirectory() ? { kind: 'dir', bytes: 0 } : { kind: 'file', bytes: stat.size });
      return OWNER_ONLY;
    }),
  };
  return { access, checked };
}

function run(argv: string[], access: OutputAccess = ownerOnlyAccess().access) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  return runMetalsConvertCli(argv, io, METALS_CONVERT_SOURCES, access).then((status) => ({ status, ...out }));
}

describe('holdr-metals-convert --source costco', () => {
  let root: string;
  let retailFile: string;
  let retailJson: string;

  beforeEach(async () => {
    root = await makeScratchDir('metals-convert-costco-');
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    retailJson = convertCostcoCapture({
      folder: 'costco-2',
      consolidated: capture.consolidated,
      consolidatedDigest: 'e'.repeat(64),
      rawReceipts: capture.rawReceipts.map((file) => file.json),
      rawDetails: capture.rawDetails.map((file) => file.json),
      files: 1 + capture.rawReceipts.length + capture.rawDetails.length,
    }).json;
    retailFile = path.join(root, 'retail-payload.json');
    writeFileSync(retailFile, retailJson);
  });

  afterEach(async () => {
    await removeScratchDir(root);
  });

  it('converts one retail payload as a dry run, reporting counts and codes only', async () => {
    const result = await run(['--source', 'costco', '--retail-payload', retailFile, '--dry-run']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    const output = JSON.parse(result.stdout);
    expect(output.code).toBe('metals-convert-dry-run');
    expect(output.source).toBe('costco');
    expect(output.payload).toMatchObject({ written: false, held: 0, orders: 1, competitors: 4 });
    expect(output.report.retail).toEqual({ format: 3, policyVersion: 5, records: 7, held: 0 });
    expect(output.report.records).toEqual({ orders: 1, competitors: 4, held: 0, credits: 1, noCardFunding: 1 });
    expect(output.report.confirmations).toMatchObject({ needed: 1, neededIncludingFullyCancelledOrReturned: 1, metalUnknown: 0 });
    expect(output.report.bullion).toMatchObject({ needed: 0, includingFullyCancelledOrReturned: { needed: 0 } });
    expect(output.report.census).toEqual({
      retailMetalLines: 1, metalLinesInOrders: 1, metalLinesInHeldRecords: 0, retailFlaggedLines: 0, flaggedLinesInOrders: 0,
      flaggedLinesInHeldRecords: 0, heldMetalWordLines: 0, heldAlsoFlaggedOrders: 0,
    });
    const report = JSON.stringify(output.report);
    for (const value of syntheticSensitiveValues()) expect(report, `shows ${value}`).not.toContain(value);
    expect(result.stdout).not.toContain(root);
  });

  it('writes the payload, exactly as reported, to a new owner-only file the validator accepts', async () => {
    const out = path.join(root, 'metals-payload.json');
    const { access, checked: ownerOnlyChecks } = ownerOnlyAccess();
    const result = await run(['--source', 'costco', '--retail-payload', retailFile, '--out', out], access);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(METALS_CONVERT_EXIT.ok);
    expect(ownerOnlyChecks).toEqual([{ kind: 'dir', bytes: 0 }, { kind: 'file', bytes: 0 }]);
    const output = JSON.parse(result.stdout);
    expect(output.code).toBe('metals-converted');
    const written = readFileSync(out);
    expect(output.payload.sha256).toBe(createHash('sha256').update(written).digest('hex'));
    const checked = validateMetalsImportPayload(JSON.parse(written.toString('utf8')));
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.payload.source).toBe('costco');
  });

  it('refuses retail policies 3 and 4, by a closed code and nothing else', async () => {
    for (const [version, policyVersion] of [[1, 3], [2, 4]]) {
      writeFileSync(retailFile, JSON.stringify({ ...JSON.parse(retailJson), version, policyVersion }));
      const result = await run(['--source', 'costco', '--retail-payload', retailFile, '--dry-run']);
      expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('holdr-metals-convert: retail-policy-unsupported at $.policyVersion\n');
    }
  });

  it('refuses a file that is not a Costco retail payload', async () => {
    writeFileSync(retailFile, '{"format":"sample"}');
    const result = await run(['--source', 'costco', '--retail-payload', retailFile, '--dry-run']);
    expect(result.status).toBe(METALS_CONVERT_EXIT.refused);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('holdr-metals-convert: retail-invalid at $.format\n');
  });
});
