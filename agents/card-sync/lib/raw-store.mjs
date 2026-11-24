// Raw statement exports, as the bank sent them, live only in the private raw folder and only for as long as one card's
// sync takes: they are written there one statement at a time, read once for conversion, and deleted right after it,
// whether the conversion worked or not. Anything left over (a crash, a power cut) is deleted when the receiver starts.
// While a raw file cannot be deleted, the receiver refuses to start another sync.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** amex-<16 letters of the card's local id>-<statement end>-<random>.csv */
export const RAW_NAME = /^amex-[a-p]{16}-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv$/;

export class RawCleanupError extends Error {
  constructor() {
    super('a raw export could not be deleted from the private raw folder; syncing is paused until it is gone');
    this.name = 'RawCleanupError';
    this.code = 'raw-cleanup-failed';
  }
}

export function rawName(sourceId, end) {
  if (!/^amex-[a-p]{64}$/.test(sourceId) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('invalid raw export identity');
  return `amex-${sourceId.slice(5, 21)}-${end}-${randomBytes(4).toString('hex')}.csv`;
}

export function createRawStore(directory, {
  unlink = fs.unlinkSync, write = fs.writeFileSync, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let blocked = false;

  async function remove(file) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        unlink(file);
        return;
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        if (attempt === 4) {
          blocked = true;
          throw new RawCleanupError();
        }
        await delay(100 * (attempt + 1));
      }
    }
  }

  /** Deletes every raw export this receiver writes; other entries are reported, never touched. */
  async function sweep() {
    const unknown = [];
    let removed = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && RAW_NAME.test(entry.name)) {
        await remove(path.join(directory, entry.name));
        removed += 1;
      } else {
        unknown.push(entry.name);
      }
    }
    blocked = false;
    return { removed, unknown };
  }

  /** Writes one export into a new owner-only file (never over an existing one) and returns its path. */
  function stage(name, text) {
    if (blocked) throw new RawCleanupError();
    if (!RAW_NAME.test(name)) throw new Error('invalid raw export name');
    const file = path.join(directory, name);
    const fd = fs.openSync(file, 'wx', 0o600);
    let written = false;
    try {
      write(fd, text);
      written = true;
    } finally {
      fs.closeSync(fd);
      if (!written) {
        try {
          unlink(file);
        } catch (error) {
          if (error?.code !== 'ENOENT') blocked = true;
        }
      }
    }
    return file;
  }

  function read(file) {
    if (path.dirname(path.resolve(file)) !== path.resolve(directory) || !RAW_NAME.test(path.basename(file))) {
      throw new Error('invalid raw export path');
    }
    return fs.readFileSync(file, 'utf8');
  }

  return {
    directory,
    sweep,
    stage,
    read,
    remove,
    get blocked() { return blocked; },
  };
}
