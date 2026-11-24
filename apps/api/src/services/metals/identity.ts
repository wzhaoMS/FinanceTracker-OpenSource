import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { toLetterHex } from '@finance-tracker/shared';
import { METALS_SOURCES, type MetalsSource } from '@finance-tracker/shared/metals-ledger';

import { MetalsRefusal, hexOfLetters } from './common.js';

/**
 * Prevention (corrections design r6, section 2.8; ROOT): every import that creates an account pins the account's
 * identity as a keyed digest, so a capture filed in the wrong folder, or a conversion that states the wrong folder or
 * identity, is refused before the database is opened. Pure: the owner-only reads of the key and the registry are the
 * CLI's (ownerOnlyOutput.ts), and nothing here prints, logs or stores a value.
 *
 * - The identity text: `holdr.metals-identity v1`, the source, the folder and the identity last 4 (empty for a source
 *   without one), each followed by an LF, in UTF-8.
 * - The digest: HMAC-SHA256 of that text under the owner's identity key, as 64 letters a–p. Never an unkeyed hash: a last
 *   4 has ten thousand values, so a plain hash of the identity is brute-forced at once (ROOT).
 * - The key: 32 bytes from the CSPRNG, kept as 64 letters a–p and an LF in an owner-only file that never leaves the Mac.
 * - The folder registry: the owner's record of the identity each capture folder holds, an owner-only file on the Mac.
 */

export const METALS_IDENTITY_FORMAT = 'holdr.metals-identity v1';
export const METALS_FOLDER_REGISTRY_FORMAT = 'holdr.metals-folder-registry';
/** A keyed identity digest, as a GO pins it and `identity-digest` prints it. */
export const METALS_IDENTITY_DIGEST = /^[a-p]{64}$/;
/** The key file's whole text: 64 letters a–p and an LF. */
export const METALS_IDENTITY_KEY_BYTES = 65;
export const METALS_FOLDER_REGISTRY_MAX_BYTES = 1 << 20;

/** Why an owner-only identity input (the key or the registry) can't be used: a closed list (r6 section 2.8). */
export const METALS_IDENTITY_INPUT_REASONS = ['missing', 'malformed', 'not-owner-only', 'uncheckable', 'changed'] as const;
export type MetalsIdentityInputReason = (typeof METALS_IDENTITY_INPUT_REASONS)[number];

export const metalsIdentityInputUnusable = (reason: MetalsIdentityInputReason): MetalsRefusal =>
  new MetalsRefusal('metals-identity-input-unusable', { reason });

/** An account's identity as a payload states it and as the registry records it. */
export interface MetalsIdentity {
  source: MetalsSource;
  folder: string;
  identityLast4: string | null;
}

export interface MetalsFolderRegistry {
  folders: readonly MetalsIdentity[];
}

const isSource = (value: unknown): value is MetalsSource => typeof value === 'string' && (METALS_SOURCES as readonly string[]).includes(value);

/** The payload's own folder rule (payload.ts): the source, or the source and a number from 1 to 999. */
export const isMetalsFolder = (source: MetalsSource, folder: unknown): folder is string =>
  typeof folder === 'string' && new RegExp(`^${source}(?:-[1-9][0-9]{0,2})?$`).test(folder);

/** The registry's last-4 rule: four digits exactly for Costco, none for any other source. */
const isIdentityLast4 = (source: MetalsSource, value: unknown): value is string | null =>
  source === 'costco' ? typeof value === 'string' && /^[0-9]{4}$/.test(value) : value === null;

/** The canonical identity text the digest is taken over. */
export const metalsIdentityText = (identity: MetalsIdentity): string =>
  `${METALS_IDENTITY_FORMAT}\n${identity.source}\n${identity.folder}\n${identity.identityLast4 ?? ''}\n`;

/** The keyed identity digest: HMAC-SHA256 of the identity text under the 32-byte key, as 64 letters a–p. */
export function metalsIdentityDigest(key: Buffer, identity: MetalsIdentity): string {
  if (key.length !== 32) throw metalsIdentityInputUnusable('malformed');
  return toLetterHex(createHmac('sha256', key).update(metalsIdentityText(identity), 'utf8').digest());
}

/** A new identity key's file text: 32 bytes from the CSPRNG, as 64 letters a–p and an LF. */
export const newMetalsIdentityKeyText = (): string => `${toLetterHex(randomBytes(32))}\n`;

/** An identity key file's bytes: exactly 64 letters a–p and an LF, else `malformed`. */
export function parseMetalsIdentityKey(bytes: Buffer): Buffer {
  const text = bytes.toString('latin1');
  if (bytes.length !== METALS_IDENTITY_KEY_BYTES || !/^[a-p]{64}\n$/.test(text)) throw metalsIdentityInputUnusable('malformed');
  return Buffer.from(hexOfLetters(text.slice(0, 64)), 'hex');
}

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');

/**
 * A folder registry file's bytes: `{"format":"holdr.metals-folder-registry","version":1,"folders":[…]}`, each folder
 * `{"source","folder","identityLast4"}` under the payload's own rules, each source and folder at most once, and the last
 * 4 set exactly for Costco. Anything else is `malformed`, naming nothing of what it held.
 */
export function parseMetalsFolderRegistry(bytes: Buffer): MetalsFolderRegistry {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw metalsIdentityInputUnusable('malformed');
  }
  if (!exactKeys(value, ['format', 'version', 'folders']) || value.format !== METALS_FOLDER_REGISTRY_FORMAT || value.version !== 1
    || !Array.isArray(value.folders)) throw metalsIdentityInputUnusable('malformed');
  const seen = new Set<string>();
  const folders = value.folders.map((entry: unknown): MetalsIdentity => {
    if (!exactKeys(entry, ['source', 'folder', 'identityLast4']) || !isSource(entry.source) || !isMetalsFolder(entry.source, entry.folder)
      || !isIdentityLast4(entry.source, entry.identityLast4)) throw metalsIdentityInputUnusable('malformed');
    const at = `${entry.source}\n${entry.folder}`;
    if (seen.has(at)) throw metalsIdentityInputUnusable('malformed');
    seen.add(at);
    return Object.freeze({ source: entry.source, folder: entry.folder, identityLast4: entry.identityLast4 });
  });
  return Object.freeze({ folders: Object.freeze(folders) });
}

/** A registry's file text, in its folders' order: what `identity-register` writes. */
export function serializeMetalsFolderRegistry(registry: MetalsFolderRegistry): string {
  const folders = registry.folders.map((entry) => ({ source: entry.source, folder: entry.folder, identityLast4: entry.identityLast4 }));
  return `${JSON.stringify({ format: METALS_FOLDER_REGISTRY_FORMAT, version: 1, folders })}\n`;
}

/** The registry's entry for a source and folder, or null when it lists none. */
export const metalsRegisteredIdentity = (registry: MetalsFolderRegistry, source: MetalsSource, folder: string): MetalsIdentity | null =>
  registry.folders.find((entry) => entry.source === source && entry.folder === folder) ?? null;

/** Two pins, compared in constant time over their bytes. */
const samePin = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'latin1');
  const right = Buffer.from(b, 'latin1');
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The account-creating import's check, before the database is opened: the keyed digest of the registry's entry for the
 * payload's source and folder, and that of the payload's stated identity, must both equal the GO's pin. A folder the
 * registry doesn't list is `metals-identity-unregistered`; any other difference is `metals-identity-mismatch`. Both
 * digests are computed and compared before either result is used.
 */
export function checkMetalsIdentityPin(pin: string, key: Buffer, registry: MetalsFolderRegistry, stated: MetalsIdentity): void {
  if (!METALS_IDENTITY_DIGEST.test(pin)) throw new MetalsRefusal('metals-go-invalid');
  const registered = metalsRegisteredIdentity(registry, stated.source, stated.folder);
  if (registered === null) throw new MetalsRefusal('metals-identity-unregistered');
  const fromRegistry = samePin(metalsIdentityDigest(key, registered), pin);
  const fromPayload = samePin(metalsIdentityDigest(key, stated), pin);
  if (!(fromRegistry && fromPayload)) throw new MetalsRefusal('metals-identity-mismatch');
}
