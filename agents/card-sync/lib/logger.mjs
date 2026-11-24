// The receiver's log: one line per event, made only of codes, counts, dates, card endings and file names (never amounts,
// descriptions or other export content), written to the console and, with --log-file, appended to a private file. The
// file is kept under MAX_LOG_BYTES: past it, it becomes <file>.1 (replacing the one before) and a new file starts, at
// start-up and while the receiver runs.
import fs from 'node:fs';
import path from 'node:path';

import { makePrivateFile } from './private-fs.mjs';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

const clean = (value) => {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value ?? '').replace(/[^A-Za-z0-9._:/@+-]/g, '?').slice(0, 120);
};

export function formatEvent(event, at = new Date()) {
  const fields = Object.entries(event).filter(([name]) => name !== 'kind' && /^[a-zA-Z]{1,30}$/.test(name))
    .map(([name, value]) => `${name}=${clean(value)}`);
  return `[card-sync] ${at.toISOString()} ${clean(event.kind)}${fields.length ? ` ${fields.join(' ')}` : ''}`;
}

export function createLogger({ file = null, stream = process.stdout, platform = process.platform, maxBytes = MAX_LOG_BYTES } = {}) {
  let fd = null;
  let size = 0;
  let rotateAt = maxBytes;
  /** Opens the file to append, private to this account. */
  const open = () => {
    fd = fs.openSync(file, 'a', 0o600);
    size = fs.fstatSync(fd).size;
    makePrivateFile(file, { platform });
  };
  const rotate = () => {
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(file, `${file}.1`);
      rotateAt = maxBytes;
    } catch {
      // Another program holds the file open (Windows): keep appending, and try again after as much again.
      rotateAt = size + maxBytes;
    }
    open();
  };
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    open();
    if (size > maxBytes) rotate();
  }
  const write = (line) => {
    stream.write(`${line}\n`);
    if (fd !== null) {
      try {
        size += fs.writeSync(fd, `${line}\n`);
        if (size > rotateAt) rotate();
      } catch {
        // The console still has the line.
      }
    }
  };
  return {
    event: (event) => write(formatEvent(event)),
    /** A plain message written by the receiver itself (never export content). */
    info: (message) => write(`[card-sync] ${message}`),
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}
