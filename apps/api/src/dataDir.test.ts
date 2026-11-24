import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDataPaths } from './dataDir.js';

const DEFAULT_DIR = path.resolve('/srv/holdr/apps/api/data');

describe('resolveDataPaths', () => {
  it('keeps the in-repo default when HOLDR_DATA_DIR is unset', () => {
    expect(resolveDataPaths({}, DEFAULT_DIR)).toEqual({
      dataDir: DEFAULT_DIR,
      jsonFile: path.join(DEFAULT_DIR, 'state.json'),
      dbFile: path.join(DEFAULT_DIR, 'finance.db'),
      fromEnv: false,
    });
  });

  it('treats a blank HOLDR_DATA_DIR as unset', () => {
    expect(resolveDataPaths({ HOLDR_DATA_DIR: '   ' }, DEFAULT_DIR).dataDir).toBe(DEFAULT_DIR);
  });

  it('puts every data file under an absolute HOLDR_DATA_DIR', () => {
    const dir = path.resolve('/srv/e2e/run-1/data');
    const paths = resolveDataPaths({ HOLDR_DATA_DIR: dir }, DEFAULT_DIR);
    expect(paths).toEqual({
      dataDir: dir,
      jsonFile: path.join(dir, 'state.json'),
      dbFile: path.join(dir, 'finance.db'),
      fromEnv: true,
    });
    expect(paths.dbFile.startsWith(DEFAULT_DIR)).toBe(false);
  });

  it('resolves a relative HOLDR_DATA_DIR against the working directory', () => {
    const cwd = path.resolve('/srv/holdr/apps/api');
    expect(resolveDataPaths({ HOLDR_DATA_DIR: '../../.e2e/data ' }, DEFAULT_DIR, cwd).dataDir)
      .toBe(path.resolve('/srv/holdr/.e2e/data'));
  });
});
