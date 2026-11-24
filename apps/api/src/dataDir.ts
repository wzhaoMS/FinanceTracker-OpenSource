import path from 'node:path';

export interface DataPaths {
  dataDir: string;
  /** Legacy pre-SQLite state, migrated into `dbFile` on boot. */
  jsonFile: string;
  dbFile: string;
  /** True when HOLDR_DATA_DIR chose the directory. */
  fromEnv: boolean;
}

/**
 * Where the API keeps finance.db. HOLDR_DATA_DIR overrides the default
 * (apps/api/data, next to the source, which is the live database on a
 * deployed checkout) so disposable stacks such as the e2e runner never
 * open it. A relative value resolves against `cwd`; blank means unset.
 */
export function resolveDataPaths(
  env: Record<string, string | undefined>,
  defaultDir: string,
  cwd: string = process.cwd(),
): DataPaths {
  const configured = env.HOLDR_DATA_DIR?.trim();
  const dataDir = configured ? path.resolve(cwd, configured) : defaultDir;
  return { dataDir, ...dataFilesIn(dataDir), fromEnv: Boolean(configured) };
}

/** The files the API keeps in `dataDir`. */
export function dataFilesIn(dataDir: string): Pick<DataPaths, 'jsonFile' | 'dbFile'> {
  return {
    jsonFile: path.join(dataDir, 'state.json'),
    dbFile: path.join(dataDir, 'finance.db'),
  };
}
