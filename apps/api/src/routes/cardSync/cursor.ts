import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The owner API's list cursors (E1b design §10 items 17 and 20, Revision 7):
 * 1–64 letters `a`–`p`, never digits, each binding its kind and the resource
 * the path or query names (a set, plan or transaction id; a set list's view;
 * a run list's binding filter) to the repository's decoded continuation.
 *
 *   <kind letter><fixed-width fields><16-letter tag>
 *
 * Integers and times (milliseconds since 1970) are fixed-width hexadecimal
 * written with `a`–`p` for 0–15; ids are their 32 letters (already `a`–`p`)
 * without their prefix. The tag is the first 64 bits of HMAC-SHA-256 over
 * the kind, the resource and the fields, under a key derived from a secret
 * the server keeps across restarts (its service token), so a restart never
 * voids an open walk and a cursor for another kind or resource, or one
 * altered by hand, is refused before any read. A cursor never authorizes
 * anything: the session and the path decide, and the repository re-checks
 * every pin (a moved pin is `page-stale`, answered 409 by the routes).
 */

export type CardSyncCursorKind = 'items' | 'effects' | 'events' | 'identities' | 'merged' | 'sets' | 'runs' | 'authority';

export interface CardSyncCursorValues {
  items: { version: number; ledgerRevision: number; pastDeadline: boolean; itemKey: number };
  effects: { afterOrdinal: number };
  events: { createdAt: string; eventId: string };
  identities: { createdAt: string; identityId: string };
  merged: { removedAt: string; transactionId: string };
  sets: { acceptedAt: string; setId: string };
  runs: { createdAt: string; runId: string };
  authority: { afterRowId: number };
}

const LETTERS = 'abcdefghijklmnop';
const TAG_LETTERS = 16;
const MAX_INT32 = 2_147_483_647;
const TIME_WIDTH = 12;
const ID_LETTERS = 32;
const KEY_LABEL = 'holdr.card-sync.owner-cursor.v1';

type Field =
  | { kind: 'int'; name: string; width: number; min: number; max: number; offset?: number }
  | { kind: 'flag'; name: string }
  | { kind: 'time'; name: string }
  | { kind: 'id'; name: string; prefix: string };

const LAYOUTS: { readonly [K in CardSyncCursorKind]: { letter: string; fields: readonly Field[] } } = {
  items: { letter: 'a', fields: [
    { kind: 'int', name: 'version', width: 8, min: 1, max: MAX_INT32 },
    { kind: 'int', name: 'ledgerRevision', width: 8, min: 0, max: MAX_INT32 },
    { kind: 'flag', name: 'pastDeadline' },
    // The set-level item is key −1; rows are their ordinals 0–1999.
    { kind: 'int', name: 'itemKey', width: 3, min: -1, max: 1_999, offset: 1 },
  ] },
  // −1 is "before the first action"; ordinals are 0–9999 (ck_act_ordinal).
  effects: { letter: 'b', fields: [{ kind: 'int', name: 'afterOrdinal', width: 4, min: -1, max: 9_999, offset: 1 }] },
  events: { letter: 'c', fields: [{ kind: 'time', name: 'createdAt' }, { kind: 'id', name: 'eventId', prefix: 'card-event-' }] },
  identities: { letter: 'd', fields: [{ kind: 'time', name: 'createdAt' }, { kind: 'id', name: 'identityId', prefix: 'card-ident-' }] },
  merged: { letter: 'e', fields: [{ kind: 'time', name: 'removedAt' }, { kind: 'id', name: 'transactionId', prefix: 'card-txn-' }] },
  sets: { letter: 'f', fields: [{ kind: 'time', name: 'acceptedAt' }, { kind: 'id', name: 'setId', prefix: 'obs_' }] },
  runs: { letter: 'g', fields: [{ kind: 'time', name: 'createdAt' }, { kind: 'id', name: 'runId', prefix: 'run_' }] },
  // The authorization generation is in the MAC's resource input, never in a response/cursor's visible fields.
  authority: { letter: 'h', fields: [{ kind: 'int', name: 'afterRowId', width: 8, min: 1, max: MAX_INT32 }] },
};

const fieldWidth = (field: Field): number =>
  field.kind === 'int' ? field.width : field.kind === 'flag' ? 1 : field.kind === 'time' ? TIME_WIDTH : ID_LETTERS;

function toLetters(value: number, width: number): string {
  let text = '';
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    text = LETTERS[rest % 16] + text;
    rest = Math.floor(rest / 16);
  }
  if (rest !== 0) throw new RangeError('card sync cursor: a value does not fit its field');
  return text;
}

function fromLetters(text: string): number {
  let value = 0;
  for (const letter of text) value = value * 16 + LETTERS.indexOf(letter);
  return value;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_TAIL = /^[a-p]{32}$/;

function encodeField(field: Field, value: unknown): string {
  switch (field.kind) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.min || value > field.max) {
        throw new RangeError('card sync cursor: an integer outside its range');
      }
      return toLetters(value + (field.offset ?? 0), field.width);
    }
    case 'flag':
      if (typeof value !== 'boolean') throw new RangeError('card sync cursor: a flag that is not a boolean');
      return value ? 'b' : 'a';
    case 'time': {
      const ms = typeof value === 'string' && TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
      if (!Number.isSafeInteger(ms) || ms < 0 || new Date(ms).toISOString() !== value) {
        throw new RangeError('card sync cursor: a time that is not a stored timestamp');
      }
      return toLetters(ms, TIME_WIDTH);
    }
    case 'id': {
      const tail = typeof value === 'string' && value.startsWith(field.prefix) ? value.slice(field.prefix.length) : '';
      if (!ID_TAIL.test(tail)) throw new RangeError('card sync cursor: an id of another kind');
      return tail;
    }
  }
}

function decodeField(field: Field, text: string): unknown {
  switch (field.kind) {
    case 'int': {
      const value = fromLetters(text) - (field.offset ?? 0);
      return value >= field.min && value <= field.max ? value : undefined;
    }
    case 'flag':
      return text === 'b' ? true : text === 'a' ? false : undefined;
    case 'time': {
      const date = new Date(fromLetters(text));
      const iso = Number.isNaN(date.getTime()) ? '' : date.toISOString();
      return TIMESTAMP.test(iso) ? iso : undefined;
    }
    case 'id':
      return `${field.prefix}${text}`;
  }
}

const bodyLength = (kind: CardSyncCursorKind) => 1 + LAYOUTS[kind].fields.reduce((sum, field) => sum + fieldWidth(field), 0);

/** Encodes and decodes the owner API's cursors under one key. */
export class CardSyncCursorCodec {
  private readonly key: Buffer;

  /** `secret`: a server secret kept across restarts (the service token); only a key derived from it is held. */
  constructor(secret: string) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 16) {
      throw new TypeError('card sync cursors need a server secret of at least 16 bytes');
    }
    this.key = createHmac('sha256', secret).update(KEY_LABEL).digest();
  }

  private tag(kind: CardSyncCursorKind, resource: string, body: string): string {
    const mac = createHmac('sha256', this.key).update(`${kind}\n${resource}\n${body}`).digest();
    let letters = '';
    for (const byte of mac.subarray(0, TAG_LETTERS / 2)) letters += LETTERS[byte >> 4] + LETTERS[byte & 15];
    return letters;
  }

  /** The cursor for `values` of `kind` on `resource`. Throws (a programming error) on a value outside its field. */
  encode<K extends CardSyncCursorKind>(kind: K, resource: string, values: CardSyncCursorValues[K]): string {
    const layout = LAYOUTS[kind];
    const record = values as unknown as Record<string, unknown>;
    const body = layout.letter + layout.fields.map((field) => encodeField(field, record[field.name])).join('');
    return body + this.tag(kind, resource, body);
  }

  /**
   * The continuation a cursor carries, or null for anything that is not a
   * cursor of `kind` for `resource` this server made: malformed, another
   * kind, another resource, altered, or out of range.
   */
  decode<K extends CardSyncCursorKind>(kind: K, resource: string, cursor: unknown): CardSyncCursorValues[K] | null {
    const layout = LAYOUTS[kind];
    const length = bodyLength(kind);
    if (typeof cursor !== 'string' || cursor.length !== length + TAG_LETTERS || !/^[a-p]+$/.test(cursor)) return null;
    if (cursor[0] !== layout.letter) return null;
    const body = cursor.slice(0, length);
    if (!timingSafeEqual(Buffer.from(this.tag(kind, resource, body)), Buffer.from(cursor.slice(length)))) return null;
    const values: Record<string, unknown> = {};
    let at = 1;
    for (const field of layout.fields) {
      const width = fieldWidth(field);
      const value = decodeField(field, body.slice(at, at + width));
      if (value === undefined) return null;
      values[field.name] = value;
      at += width;
    }
    return values as unknown as CardSyncCursorValues[K];
  }
}

/** The longest cursor of any kind (the client takes 1–64 letters). */
export const CARD_SYNC_CURSOR_MAX_LENGTH = Math.max(...(Object.keys(LAYOUTS) as CardSyncCursorKind[]).map(bodyLength)) + TAG_LETTERS;
