import { createHash, randomBytes } from 'node:crypto';

import { toLetterHex } from '@finance-tracker/shared';

import { HoldrRefusal } from '../dbErrors.js';

/**
 * A refusal whose message is a stable code (`metals-…`); `details` holds counts, closed codes, paths, keys and dates
 * only, never an amount, a last 4, a title or a label.
 */
export class MetalsRefusal extends HoldrRefusal {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX32 = /^[0-9a-f]{32}$/;
export const INSTANT24 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Lowercase hex (as a GO, a file or the output carries it) to letter hex (as the database stores it): 0–f become a–p. */
export function lettersOfHex(hex: string): string {
  if (!/^[0-9a-f]*$/.test(hex)) throw new MetalsRefusal('metals-digest-invalid');
  return hex.replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

/** Letter hex back to lowercase hex. */
export function hexOfLetters(letters: string): string {
  if (!/^[a-p]*$/.test(letters)) throw new MetalsRefusal('metals-digest-invalid');
  return letters.replace(/[a-p]/g, (letter) => (letter.charCodeAt(0) - 97).toString(16));
}

/** Lowercase hex SHA-256 of bytes or text. */
export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** A new id: the prefix and 128 random bits in letter hex. */
export const newMetalsId = (prefix: 'mtl-acct-' | 'mtl-imp-' | 'mtl-bind-'): string => `${prefix}${toLetterHex(randomBytes(16))}`;

/** The context every writer takes: when, under which Root GO (32 lowercase hex) and for which purpose. */
export function checkWriteContext(context: { now: string; goId: string; purpose: string }, purposes: readonly string[]): void {
  if (typeof context.now !== 'string' || !INSTANT24.test(context.now) || Number.isNaN(Date.parse(context.now))) {
    throw new MetalsRefusal('metals-time-invalid');
  }
  if (typeof context.goId !== 'string' || !HEX32.test(context.goId)) throw new MetalsRefusal('metals-go-id-invalid');
  if (!purposes.includes(context.purpose)) throw new MetalsRefusal('metals-purpose-invalid');
}
