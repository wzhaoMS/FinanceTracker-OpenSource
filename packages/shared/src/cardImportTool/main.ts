#!/usr/bin/env node
/**
 * Entry point: `node packages/shared/dist/cardImportTool/main.js …` after
 * `npm run build -w @finance-tracker/shared`. The only platform access in
 * the tool's module graph is here: reading the export and writing the JSON.
 */
import { chmodSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runCardImportCli, type CliIo } from './cli.js';

function describe(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EEXIST') return 'the file exists (use --force to replace it)';
  if (code === 'EISDIR') return 'is a directory';
  return typeof code === 'string' && /^E[A-Z]{2,12}$/.test(code) ? code : 'failed';
}

const io: CliIo = {
  readFile(path, maxBytes) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY);
    } catch (error) {
      throw new Error(describe(error));
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a regular file');
      if (stat.size > maxBytes) throw new Error(`larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`);
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      return bytes.subarray(0, offset);
    } catch (error) {
      throw error instanceof Error && !(error as { code?: unknown }).code ? error : new Error(describe(error));
    } finally {
      closeSync(fd);
    }
  },
  writeFile(path, text, overwrite) {
    try {
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: overwrite ? 'w' : 'wx' });
      chmodSync(path, 0o600);
    } catch (error) {
      throw new Error(describe(error));
    }
  },
  samePath(a, b) {
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    return real(a) === real(b);
  },
  stdout(text) {
    process.stdout.write(text);
  },
  stderr(text) {
    process.stderr.write(text);
  },
};

process.exitCode = runCardImportCli(process.argv.slice(2), io);
