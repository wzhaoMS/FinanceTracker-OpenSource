// The pairing key the extension and the receiver share, and the receiver's small local state. The pairing key lives in
// extension/local-key.json (git-ignored, owner-only): the extension reads it as one of its own files, which web pages
// cannot, and the receiver reads it from the same place. Neither side ever sends it. The state (receiver-state.json in
// the private imports folder) holds a salt and the dates the receiver read each statement.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isIsoDate } from './plan.mjs';
import { makePrivateFile } from './private-fs.mjs';

export const PAIRING_FORMAT = 'holdr-card-sync-pairing';
const KEY = /^[0-9a-f]{64}$/;
const SOURCE_ID = /^amex-[a-p]{64}$/;

export class PairingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PairingError';
  }
}

function writeWhole(file, text, { platform }) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    makePrivateFile(temp, { platform });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** The pairing in `file`, or null when there is none yet. */
export function readPairing(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new PairingError('the pairing file cannot be read');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PairingError('the pairing file is damaged: run the pair command with --rotate, then reload the extension');
  }
  if (!value || value.format !== PAIRING_FORMAT || value.version !== 1 || !KEY.test(value.pairingKey ?? '')
    || !Number.isInteger(value.receiverPort) || value.receiverPort < 1024 || value.receiverPort > 65535) {
    throw new PairingError('the pairing file is damaged: run the pair command with --rotate, then reload the extension');
  }
  return { pairingKey: value.pairingKey, receiverPort: value.receiverPort };
}

/**
 * Creates the pairing (or a new key with `rotate`), and keeps the receiver port in it current so that the extension
 * follows a changed --port. Returns `{ pairing, created, changed }`.
 */
export function ensurePairing(file, { port, rotate = false, platform = process.platform }) {
  const folder = path.dirname(file);
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PairingError('the extension folder was not found: set HOLDR_EXTENSION_DIR to the folder you loaded in the browser');
  }
  const existing = rotate ? null : readPairing(file);
  if (existing && existing.receiverPort === port) return { pairing: existing, created: false, changed: false };
  const pairing = { pairingKey: existing?.pairingKey ?? randomBytes(32).toString('hex'), receiverPort: port };
  writeWhole(file, `${JSON.stringify({ format: PAIRING_FORMAT, version: 1, ...pairing }, null, 2)}\n`, { platform });
  return { pairing, created: !existing, changed: Boolean(existing) };
}

/**
 * The receiver's state in the private imports folder: a random salt for the cards' local ids, and when each card's
 * statements were last read (`reads`: `{ [sourceId]: { [closing date]: { readOn, empty } } }`). A damaged or unknown record
 * is dropped, which only means that statement is read again.
 */
export function loadState(file, { platform = process.platform } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version === 1 && KEY.test(value.identitySalt ?? '')) {
      return { version: 1, identitySalt: value.identitySalt, reads: sanitizeReads(value.reads) };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const state = { version: 1, identitySalt: randomBytes(32).toString('hex'), reads: {} };
  saveState(file, state, { platform });
  return state;
}

/** Writes the state whole (a temporary file renamed into place), owner-only. */
export function saveState(file, state, { platform = process.platform } = {}) {
  writeWhole(file, `${JSON.stringify({ version: 1, identitySalt: state.identitySalt, reads: state.reads ?? {} })}\n`, { platform });
}

function sanitizeReads(value) {
  const reads = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reads;
  for (const [sourceId, statements] of Object.entries(value)) {
    if (!SOURCE_ID.test(sourceId) || !statements || typeof statements !== 'object' || Array.isArray(statements)) continue;
    const kept = {};
    for (const [end, read] of Object.entries(statements)) {
      if (isIsoDate(end) && read && isIsoDate(read.readOn) && typeof read.empty === 'boolean') kept[end] = { readOn: read.readOn, empty: read.empty };
    }
    reads[sourceId] = kept;
  }
  return reads;
}
