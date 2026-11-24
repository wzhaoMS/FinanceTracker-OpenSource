// The outbox: converted, redacted `holdr.card-import` v1 files waiting for you to import them in Holdr's web page
// (Spending, Import redacted JSON). One file per card and sync, named after the card's five-digit ending and the dates
// it covers. Files are written whole (a temporary file renamed into place) with owner-only permissions.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OUTBOX_NAME = /^amex-(\d{5})-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})\.json$/;
const TEMP_NAME = /^\.amex-\d{5}-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.json\.[0-9a-f]{8}\.tmp$/;

export function outboxName(last5, coverage) {
  const name = `amex-${last5}-${coverage.start}-to-${coverage.end}.json`;
  if (!OUTBOX_NAME.test(name)) throw new Error('invalid outbox file identity');
  return name;
}

/** The outbox files, oldest coverage first. A missing folder is an empty outbox. */
export function listOutbox(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const match = entry.isFile() ? OUTBOX_NAME.exec(entry.name) : null;
    return match ? [{ name: entry.name, file: path.join(directory, entry.name), last5: match[1], start: match[2], end: match[3] }] : [];
  }).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.name < b.name ? -1 : 1));
}

export function writeOutbox(directory, name, text) {
  if (!OUTBOX_NAME.test(name)) throw new Error('invalid outbox file name');
  const temp = path.join(directory, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const target = path.join(directory, name);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return target;
}

/** Deletes temporary files an interrupted write left behind. */
export function sweepOutboxTemp(directory) {
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && TEMP_NAME.test(entry.name)) {
      fs.rmSync(path.join(directory, entry.name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Earlier files of the same card whose dates the new file covers completely: the new file replaces them. */
export function supersededFiles(entries, last5, coverage, keepName) {
  return entries.filter((entry) => entry.name !== keepName && entry.last5 === last5
    && entry.start >= coverage.start && entry.end <= coverage.end);
}
