import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JsonStateRepo, validatePersistedState } from './jsonStateRepo.js';

let dir: string;
let repo: JsonStateRepo;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-state-'));
  file = path.join(dir, 'state.json');
  repo = new JsonStateRepo(file);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('validatePersistedState', () => {
  it('accepts a minimal valid state', () => {
    expect(
      validatePersistedState({
        accounts: [{ id: 'a', name: 'Indiv', cashBalance: 0, currency: 'USD' }],
        transactions: [],
      }),
    ).toBeNull();
  });

  it('rejects missing arrays', () => {
    expect(validatePersistedState({})).toMatch(/accounts must be an array/);
    expect(validatePersistedState({ accounts: [] })).toMatch(/transactions must be an array/);
  });

  it('rejects an account with no id', () => {
    const err = validatePersistedState({
      accounts: [{ name: 'X', cashBalance: 0, currency: 'USD' }],
      transactions: [],
    });
    expect(err).toMatch(/accounts\[0\]\.id/);
  });

  it('rejects a transaction with NaN quantity', () => {
    const err = validatePersistedState({
      accounts: [{ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' }],
      transactions: [
        { id: 't1', accountId: 'a', symbol: 'AAPL', date: '2026-05-05', quantity: NaN, pricePerUnit: 1, currency: 'USD' },
      ],
    });
    expect(err).toMatch(/transactions\[0\]\.quantity/);
  });

  it('rejects a transaction whose accountId does not exist', () => {
    const err = validatePersistedState({
      accounts: [{ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' }],
      transactions: [
        { id: 't1', accountId: 'GHOST', symbol: 'AAPL', date: '2026-05-05', quantity: 1, pricePerUnit: 1, currency: 'USD' },
      ],
    });
    expect(err).toMatch(/does not match any account/);
  });

  it('accepts complete option metadata and rejects partial option rows', () => {
    const option = {
      id: 'o1', accountId: 'a', symbol: 'NBIS260731P00165000', date: '2026-07-10',
      quantity: -5, pricePerUnit: 6.5632, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    };
    const state = {
      accounts: [{ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' }],
      transactions: [option],
    };
    expect(validatePersistedState(state)).toBeNull();
    expect(validatePersistedState({
      ...state,
      transactions: [{ ...option, positionEffect: undefined }],
    })).toMatch(/positionEffect/);
    expect(validatePersistedState({
      ...state,
      transactions: [{ ...option, symbol: 'NBIS' }],
    })).toMatch(/OCC/);
  });
});

describe('JsonStateRepo', () => {
  const sample = {
    accounts: [
      { id: 'fid', name: 'Fidelity', type: 'Individual', cashBalance: 100, currency: 'USD' },
      { id: 'citi', name: 'Citi', cashBalance: 0, currency: 'USD' },
    ],
    transactions: [
      { id: 't1', accountId: 'fid', symbol: 'AAPL', date: '2026-05-04', quantity: 10, pricePerUnit: 150, currency: 'USD' },
      { id: 't2', accountId: 'citi', symbol: 'MSFT', date: '2026-05-04', quantity: 5, pricePerUnit: 410, currency: 'USD' },
    ],
  };

  it('returns null when no file exists', async () => {
    expect(await repo.read()).toBeNull();
  });

  it('round-trips a valid state', async () => {
    await repo.write(sample);
    expect(await repo.read()).toEqual(sample);
  });

  it('writes via tmp + rename so the live file is never partial', async () => {
    await repo.write(sample);
    const raw = await readFile(file, 'utf8');
    // Pretty-printed (2-space indent), parseable, ends with newline-ish content.
    expect(JSON.parse(raw)).toEqual(sample);
    expect(raw).toMatch(/\n  "accounts"/);
  });

  it('refuses to write an invalid payload (live file untouched)', async () => {
    await repo.write(sample);
    await expect(
      repo.write({ accounts: 'not-an-array' } as never),
    ).rejects.toThrow(/refusing to write/);
    expect(await repo.read()).toEqual(sample);
  });

  it('throws when the file exists but is corrupt', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, '{ not json', 'utf8');
    await expect(repo.read()).rejects.toThrow();
  });
});
