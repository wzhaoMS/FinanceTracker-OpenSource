/**
 * Canonical JSON for the card-sync wire contract: the exact bytes a producer
 * sends, Holdr stores in its receipt, and the byte budget is measured on.
 *
 * The form is RFC 8785 (JSON Canonicalization Scheme) restricted to strict
 * JSON values: object keys sorted by UTF-16 code units, no whitespace, strings
 * escaped exactly as `JSON.stringify` escapes them, numbers in ECMAScript's
 * shortest round-trip form (integers print as plain digits). Equal values give
 * byte-identical text on every engine and platform, whatever order their keys
 * were built in. Plain TypeScript only: no Node or browser APIs, no
 * dependencies. Digests over these bytes are in `digest.ts`.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Thrown only for values outside strict JSON; the message never includes the value. */
export class CanonicalJsonError extends TypeError {
  constructor() {
    super('canonical JSON accepts strict JSON values only (validate with snapshotStrictJson first)');
    this.name = 'CanonicalJsonError';
  }
}

const MAX_CANONICAL_DEPTH = 64;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** UTF-8 length of `text` as `TextEncoder` would encode it (an unpaired surrogate becomes U+FFFD). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** UTF-8 length of `JSON.stringify(text)`, computed without building it. */
export function jsonStringByteLength(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // JSON.stringify writes an unpaired surrogate as a \udxxx escape.
        bytes += 6;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function writeValue(value: unknown, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new CanonicalJsonError();
      return JSON.stringify(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError();
      return JSON.stringify(value);
    case 'object':
      return writeContainer(value as object, depth);
    default:
      throw new CanonicalJsonError();
  }
}

function dataValue(container: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new CanonicalJsonError();
  return descriptor.value;
}

function writeContainer(value: object, depth: number): string {
  if (depth >= MAX_CANONICAL_DEPTH) throw new CanonicalJsonError();
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) throw new CanonicalJsonError();
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) parts.push(writeValue(dataValue(value, String(index)), depth + 1));
    return `[${parts.join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError();
  const names: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || LONE_SURROGATE.test(key)) throw new CanonicalJsonError();
    names.push(key);
  }
  // Default sort compares UTF-16 code units, which is the RFC 8785 key order.
  names.sort();
  const parts = names.map((key) => `${JSON.stringify(key)}:${writeValue(dataValue(value, key), depth + 1)}`);
  return `{${parts.join(',')}}`;
}

/**
 * The canonical JSON text of a strict JSON value. Throws `CanonicalJsonError`
 * (whose message names no value) for anything else: undefined, functions,
 * symbols, bigints, NaN, infinities, -0, unpaired surrogates, accessors,
 * holes, non-plain objects or nesting deeper than 64. Validator results and
 * `snapshotStrictJson` values never throw.
 */
export function canonicalJson(value: JsonValue): string {
  return writeValue(value, 0);
}

/** UTF-8 byte length of `canonicalJson(value)`: the figure byte budgets are checked against. */
export function canonicalJsonByteLength(value: JsonValue): number {
  return utf8ByteLength(canonicalJson(value));
}
