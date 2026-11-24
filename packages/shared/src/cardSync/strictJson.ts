/**
 * Strict JSON for everything a card-sync producer may send: the wire payloads
 * in this folder and the extension's internal messages.
 *
 * `snapshotStrictJson` reads an untrusted value once and returns a detached
 * copy that is plain JSON, or value-free issues. It
 * - accepts only plain objects (prototype Object.prototype or null) and plain
 *   dense arrays, read through own property descriptors: getters and setters
 *   are refused and never invoked, and exotic objects (proxies) that throw
 *   are reported, not propagated;
 * - accepts only JSON values: no undefined, functions, symbols, bigints, NaN,
 *   infinities or -0, and (by default) integers only;
 * - refuses prototype keys (`__proto__`, `constructor`, `prototype` and the
 *   other Object.prototype member names), symbol-keyed or non-enumerable
 *   properties, cycles and unpaired surrogates (an object shared by two
 *   parents is copied twice, as JSON would write it, and counts twice
 *   against the value budget);
 * - bounds depth, keys per object, array length, total values, string and
 *   key length, and the UTF-8 size of the canonical serialization;
 * - runs Holdr's card detectors on every string, number and key, and on each
 *   key/value pair: card numbers and card-length spans that show more than
 *   four digits, 13+ digit runs, numbers of 10^11 and above (identifiers, not
 *   amounts), security codes, PINs and expiry dates;
 * - refuses keys that may never be sent, wherever they appear
 *   (`isForbiddenCardSyncKey`).
 *
 * It never throws and never echoes input: issues carry a fixed code and a
 * path whose segments are schema keys (`knownKeys`), `<key>`, or indices.
 */
import { containsCardData, isCardNumberField, isCardSecretField } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { containsLongDigitRun, normalizeCardText } from '../cardText.js';
import { jsonStringByteLength, type JsonObject, type JsonValue } from './canonical.js';
import {
  CARD_SYNC_MAX_ISSUES,
  CardSyncIssueList,
  cardSyncIndexPath,
  cardSyncKeyPath,
  type CardSyncIssue,
  type CardSyncIssueCode,
} from './issues.js';

export interface StrictJsonLimits {
  /** Deepest container nesting; the root container is depth 0. */
  maxDepth: number;
  maxKeysPerObject: number;
  maxArrayLength: number;
  /** Values of every kind, containers included. */
  maxNodes: number;
  /** UTF-16 code units per string value; longer strings are refused before any scanning. */
  maxStringLength: number;
  maxKeyLength: number;
  /** UTF-8 bytes of the canonical serialization. */
  maxBytes: number;
}

export const STRICT_JSON_DEFAULT_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
  maxDepth: 16,
  maxKeysPerObject: 64,
  maxArrayLength: 2_000,
  maxNodes: 100_000,
  maxStringLength: 4_096,
  maxKeyLength: 64,
  maxBytes: 2 * 1024 * 1024,
});

/** Hard ceilings the limits are clamped to, so a caller cannot ask for unbounded work. */
const LIMIT_CEILINGS: Readonly<StrictJsonLimits> = Object.freeze({
  maxDepth: 32,
  maxKeysPerObject: 1_024,
  maxArrayLength: 100_000,
  maxNodes: 1_000_000,
  maxStringLength: 1_000_000,
  maxKeyLength: 256,
  maxBytes: 16 * 1024 * 1024,
});

export interface StrictJsonOptions {
  limits?: Partial<StrictJsonLimits>;
  /** Keys that paths may name; any other key is shown as `<key>`. */
  knownKeys?: ReadonlySet<string>;
  /** Allow non-integer numbers. Off by default: the card-sync contract has none. */
  allowFractions?: boolean;
  maxIssues?: number;
}

export type StrictJsonResult =
  | { ok: true; value: JsonValue; byteLength: number }
  | { ok: false; issues: CardSyncIssue[] };

// ---------------------------------------------------------------------------
// Key policy
// ---------------------------------------------------------------------------

/** Own property names of Object.prototype, plus `prototype`: keys that can reach or shadow prototypes. */
export const CARD_SYNC_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__',
  '__lookupSetter__', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString',
  'valueOf',
]);

// Matched against the key in NFKC, lower case, letters and digits only, so
// `account_token`, `accountToken` and `ACCOUNT-TOKEN` read the same.
const FORBIDDEN_EXACT: ReadonlySet<string> = new Set([
  // Raw or unbounded data, including page state such as __INITIAL_STATE__.
  'meta', 'metadata', 'dump', 'har', 'html', 'body', 'request', 'response', 'snippet', 'initialstate',
  // Diagnostics.
  'debug', 'trace', 'stack', 'stacktrace', 'exception', 'errormessage', 'errortext', 'errordetail', 'errordetails',
  // Bank or Holdr credentials and routing material.
  'key', 'apikey', 'accesskey', 'accountkey', 'secretkey', 'privatekey', 'sessionkey', 'auth', 'otp', 'jwt',
  'account', 'acct', 'card', 'accountid', 'acctid', 'acctno', 'pan', 'iban', 'routingnumber',
  // People and contact details.
  'name', 'holder', 'cardholder', 'cardmember', 'member', 'profile', 'customer', 'user', 'login', 'email', 'phone',
  'address', 'zip', 'zipcode', 'postalcode', 'ssn', 'dob', 'birthdate', 'dateofbirth',
  // Network locations.
  'href', 'link', 'links', 'host', 'hostname', 'origin', 'referer', 'referrer', 'endpoint',
  // Card secrets.
  'pin', 'cvv', 'cvc', 'cvv2', 'cvc2', 'cid', 'csc', 'exp', 'expiry', 'expiration', 'expirydate', 'expirationdate',
]);
const FORBIDDEN_PREFIXES = ['raw', 'extra', 'diagnostic', 'url', 'uri'];
const FORBIDDEN_SUFFIXES = ['name', 'url', 'urls', 'uri', 'uris', 'headers', 'header'];
const FORBIDDEN_PARTS = [
  'token', 'secret', 'password', 'passwd', 'passcode', 'credential', 'cookie', 'session', 'csrf', 'xsrf', 'bearer',
  'authorization', 'header', 'selector', 'email', 'address', 'phone', 'accountnumber', 'cardnumber', 'acctnum',
  'accountid', 'acctid', 'routing', 'securitycode', 'expirationdate', 'expirydate',
];

function policyForm(key: string): string {
  return key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True for keys that may never appear in a card-sync payload or message,
 * whatever their value: raw or unbounded data (`raw*`, `extra*`, `metadata`,
 * `body`, `response`, …), diagnostics (`debug`, `stack`, `errorMessage`, …),
 * credentials and bank routing material (`*token*`, `*secret*`, `*cookie*`,
 * `*session*`, `apiKey`, `accountKey`, `accountId`, `authorization`, …),
 * people and contact details (`name`, `*Name`, `holder`, `email`, `address`,
 * `phone`, …), card numbers and secrets (`pan`, `acctid`, `cardNumber`, `cvv`,
 * `pin`, `expiry`, and every card-number or card-secret column name the
 * shared detectors know), headers and network locations (`*header*`, `*url`,
 * `href`, `origin`, …) and DOM selectors.
 */
export function isForbiddenCardSyncKey(key: string): boolean {
  if (typeof key !== 'string') return true;
  if (isCardSecretField(key) || isCardNumberField(key)) return true;
  const form = policyForm(key);
  if (FORBIDDEN_EXACT.has(form)) return true;
  if (FORBIDDEN_PREFIXES.some((prefix) => form.startsWith(prefix))) return true;
  if (FORBIDDEN_SUFFIXES.some((suffix) => form.endsWith(suffix))) return true;
  return FORBIDDEN_PARTS.some((part) => form.includes(part));
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Integers this long are identifiers, not amounts (the same line `findCardNumberPaths` draws). */
const IDENTIFIER_SIZED = 1e11;
const EMPTY_KEYS: ReadonlySet<string> = new Set();

function clampLimits(overrides: Partial<StrictJsonLimits> | undefined): StrictJsonLimits {
  const limits = { ...STRICT_JSON_DEFAULT_LIMITS };
  if (overrides) {
    for (const name of Object.keys(STRICT_JSON_DEFAULT_LIMITS) as Array<keyof StrictJsonLimits>) {
      const value = overrides[name];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) limits[name] = Math.min(value, LIMIT_CEILINGS[name]);
    }
  }
  return limits;
}

/** True when a string value carries card data or a card secret on its own. */
function stringIssue(text: string): CardSyncIssueCode | null {
  if (containsCardData(text) || containsLongDigitRun(text)) return 'card-data';
  if (containsCardSecret(text)) return 'card-secret';
  return null;
}

function keyIssue(key: string): CardSyncIssueCode | null {
  if (CARD_SYNC_PROTOTYPE_KEYS.has(key)) return 'prototype-key';
  if (containsCardData(key) || containsLongDigitRun(key)) return 'card-data';
  if (containsCardSecret(key)) return 'card-secret';
  if (isForbiddenCardSyncKey(key)) return 'forbidden-key';
  return null;
}

const ANY_DIGIT = /[0-9]/;
/**
 * Letters every card-secret label contains once separators are dropped
 * (`containsCardSecret`: CVV, CVC, CVN, CAV2, CID, CSC, security code, card
 * verification, PIN, exp…, valid thru, good thru, MM/YY).
 */
const LABEL_STEM = /cvv|cvc|cvn|cav|cid|csc|security|verification|pin|exp|valid|good|mm|yy/;

/** False only when the key cannot hold the start of a card-secret label. */
function keyMayLabel(key: string): boolean {
  return LABEL_STEM.test(key.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, ''));
}

interface KeyVerdict {
  issue: CardSyncIssueCode | null;
  secretField: boolean;
  mayLabel: boolean;
}

/**
 * A labelled secret split across a key and its value, as in {"cvv": "NNN"}
 * or {"exp": "NN/NN"} (N = digit). A label cannot span the `: ` between key and value, so
 * the label must be in the key; and every secret pattern needs a digit after
 * its label, so a value with no digit once normalized cannot complete one.
 * Labels and values wholly inside the key or the value are caught by their
 * own scans.
 */
function pairIsSecret(key: string, value: string | number, verdict: KeyVerdict): boolean {
  const text = String(value);
  if (verdict.secretField && text.trim() !== '') return true;
  if (!verdict.mayLabel) return false;
  if (typeof value === 'string' && !ANY_DIGIT.test(normalizeCardText(value))) return false;
  return containsCardSecret(`${key}: ${text}`);
}

class Walker {
  private nodes = 0;
  private bytes = 0;
  private stopped = false;
  /** Containers on the path from the root to the current value. */
  private readonly ancestors = new Set<object>();
  /** Keys repeat across rows; each distinct key is judged once per walk. */
  private readonly keyVerdicts = new Map<string, KeyVerdict>();

  constructor(
    private readonly limits: StrictJsonLimits,
    private readonly known: ReadonlySet<string>,
    private readonly allowFractions: boolean,
    readonly issues: CardSyncIssueList,
  ) {}

  get byteLength(): number {
    return this.bytes;
  }

  get failed(): boolean {
    return this.stopped || this.issues.size > 0;
  }

  private add(code: CardSyncIssueCode, path: string): void {
    this.issues.add(code, path);
  }

  /** Budget failures end the walk: nothing more is read or scanned. */
  private stop(code: CardSyncIssueCode, path: string): void {
    this.add(code, path);
    this.stopped = true;
  }

  private done(): boolean {
    return this.stopped || this.issues.full;
  }

  private spend(bytes: number, path: string): boolean {
    this.bytes += bytes;
    if (this.bytes > this.limits.maxBytes) {
      this.stop('too-large', path);
      return false;
    }
    return true;
  }

  visit(value: unknown, path: string, depth: number): JsonValue | undefined {
    if (this.done()) return undefined;
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      this.stop('too-many-nodes', path);
      return undefined;
    }
    switch (typeof value) {
      case 'string':
        return this.visitString(value, path);
      case 'number':
        return this.visitNumber(value, path);
      case 'boolean':
        return this.spend(value ? 4 : 5, path) ? value : undefined;
      case 'object':
        if (value === null) return this.spend(4, path) ? null : undefined;
        return this.visitContainer(value, path, depth);
      default:
        // undefined, function, symbol, bigint
        this.add('not-json-value', path);
        return undefined;
    }
  }

  private visitString(text: string, path: string): string | undefined {
    if (text.length > this.limits.maxStringLength) {
      this.add('string-too-long', path);
      return undefined;
    }
    if (!this.spend(jsonStringByteLength(text), path)) return undefined;
    if (LONE_SURROGATE.test(text)) {
      this.add('ill-formed-unicode', path);
      return undefined;
    }
    const problem = stringIssue(text);
    if (problem) {
      this.add(problem, path);
      return undefined;
    }
    return text;
  }

  private visitNumber(value: number, path: string): number | undefined {
    if (!Number.isFinite(value)) {
      this.add('non-finite-number', path);
      return undefined;
    }
    if (Object.is(value, -0)) {
      this.add('negative-zero', path);
      return undefined;
    }
    const text = String(value);
    if (!this.spend(text.length, path)) return undefined;
    if (Math.abs(value) >= IDENTIFIER_SIZED || containsCardData(text)) {
      this.add('card-data', path);
      return undefined;
    }
    if (!this.allowFractions && !Number.isInteger(value)) {
      this.add('not-integer', path);
      return undefined;
    }
    return value;
  }

  private visitContainer(value: object, path: string, depth: number): JsonValue | undefined {
    if (depth > this.limits.maxDepth) {
      this.add('too-deep', path);
      return undefined;
    }
    if (this.ancestors.has(value)) {
      this.add('cyclic-reference', path);
      return undefined;
    }
    this.ancestors.add(value);
    try {
      return this.visitContainerOnce(value, path, depth);
    } finally {
      this.ancestors.delete(value);
    }
  }

  private visitContainerOnce(value: object, path: string, depth: number): JsonValue | undefined {
    let isArray: boolean;
    let proto: object | null;
    try {
      isArray = Array.isArray(value);
      proto = Reflect.getPrototypeOf(value);
    } catch {
      this.add('unreadable', path);
      return undefined;
    }
    if (isArray) return this.visitArray(value as unknown[], proto, path, depth);
    if (proto !== Object.prototype && proto !== null) {
      this.add('not-plain-object', path);
      return undefined;
    }
    return this.visitObject(value, path, depth);
  }

  private visitArray(array: unknown[], proto: object | null, path: string, depth: number): JsonValue[] | undefined {
    if (proto !== Array.prototype) {
      this.add('invalid-array', path);
      return undefined;
    }
    let length: unknown;
    let keyCount: number;
    try {
      length = Reflect.getOwnPropertyDescriptor(array, 'length')?.value;
      if (typeof length === 'number' && Number.isSafeInteger(length) && length > this.limits.maxArrayLength) {
        this.add('too-many-items', path);
        return undefined;
      }
      keyCount = Reflect.ownKeys(array).length;
    } catch {
      this.add('unreadable', path);
      return undefined;
    }
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      this.add('unreadable', path);
      return undefined;
    }
    // Indices plus `length`: anything else is a hole, an extra property or a symbol.
    if (keyCount !== length + 1) {
      this.add('invalid-array', path);
      return undefined;
    }
    if (!this.spend(2 + Math.max(0, length - 1), path)) return undefined;
    const copy: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      if (this.done()) return undefined;
      const at = cardSyncIndexPath(path, index);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(array, String(index));
      } catch {
        this.add('unreadable', at);
        return undefined;
      }
      if (!descriptor) {
        this.add('invalid-array', path);
        return undefined;
      }
      if (!('value' in descriptor)) {
        this.add('accessor-property', at);
        continue;
      }
      if (!descriptor.enumerable) {
        this.add('hidden-property', at);
        continue;
      }
      const child = this.visit(descriptor.value, at, depth + 1);
      if (child !== undefined) copy.push(child);
    }
    return copy;
  }

  private visitObject(object: object, path: string, depth: number): JsonObject | undefined {
    let keys: Array<string | symbol>;
    try {
      keys = Reflect.ownKeys(object);
    } catch {
      this.add('unreadable', path);
      return undefined;
    }
    if (keys.length > this.limits.maxKeysPerObject) {
      this.add('too-many-keys', path);
      return undefined;
    }
    if (!this.spend(2 + Math.max(0, keys.length - 1), path)) return undefined;
    const copy: JsonObject = {};
    for (const key of keys) {
      if (this.done()) return undefined;
      if (typeof key === 'symbol') {
        this.add('hidden-property', `${path}.<key>`);
        continue;
      }
      if (key.length > this.limits.maxKeyLength) {
        this.add('key-too-long', `${path}.<key>`);
        continue;
      }
      if (!this.spend(jsonStringByteLength(key) + 1, path)) return undefined;
      if (LONE_SURROGATE.test(key)) {
        this.add('ill-formed-unicode', `${path}.<key>`);
        continue;
      }
      const at = cardSyncKeyPath(path, key, this.known);
      let verdict = this.keyVerdicts.get(key);
      if (!verdict) {
        verdict = { issue: keyIssue(key), secretField: isCardSecretField(key), mayLabel: keyMayLabel(key) };
        this.keyVerdicts.set(key, verdict);
      }
      if (verdict.issue) this.add(verdict.issue, `${path}.<key>`);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      } catch {
        this.add('unreadable', at);
        return undefined;
      }
      if (!descriptor) {
        this.add('unreadable', at);
        return undefined;
      }
      if (!('value' in descriptor)) {
        this.add('accessor-property', at);
        continue;
      }
      if (!descriptor.enumerable) {
        this.add('hidden-property', at);
        continue;
      }
      const before = this.issues.size;
      const child = this.visit(descriptor.value, at, depth + 1);
      if (child === undefined) continue;
      if ((typeof child === 'string' || typeof child === 'number') && this.issues.size === before && pairIsSecret(key, child, verdict)) {
        this.add('card-secret', at);
        continue;
      }
      // Keys with an issue (prototype keys among them) are never stored, so plain assignment cannot reach a setter.
      if (!verdict.issue) copy[key] = child;
    }
    return copy;
  }
}

/**
 * Reads `input` once and returns a detached plain-JSON copy with the UTF-8
 * length of its canonical serialization, or value-free issues. Never throws.
 */
export function snapshotStrictJson(input: unknown, options: StrictJsonOptions = {}): StrictJsonResult {
  const issues = new CardSyncIssueList(
    typeof options.maxIssues === 'number' && options.maxIssues >= 1 ? Math.min(options.maxIssues, 1_000) : CARD_SYNC_MAX_ISSUES,
  );
  const walker = new Walker(clampLimits(options.limits), options.knownKeys ?? EMPTY_KEYS, options.allowFractions === true, issues);
  let value: JsonValue | undefined;
  try {
    value = walker.visit(input, '$', 0);
  } catch {
    // Only an exotic object can get here (for example a proxy trap that throws inside a detector's string coercion).
    issues.add('unreadable', '$');
  }
  if (walker.failed || value === undefined) {
    if (issues.size === 0) issues.add('unreadable', '$');
    return { ok: false, issues: issues.list };
  }
  return { ok: true, value, byteLength: walker.byteLength };
}

// ---------------------------------------------------------------------------
// Exact-key helpers for schema validators (on snapshot values only)
// ---------------------------------------------------------------------------

/** A snapshot object (never an array or null). */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a snapshot object has exactly `keys`: each missing key is reported
 * by name (`missing-key`), each other key as `<key>` (`unknown-key`).
 * Returns true when the key set is exact.
 */
export function checkExactKeys(
  value: JsonObject,
  path: string,
  keys: readonly string[],
  issues: CardSyncIssueList,
): boolean {
  const allowed = new Set(keys);
  let exact = true;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.add('unknown-key', `${path}.<key>`);
      exact = false;
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.add('missing-key', `${path}.${key}`);
      exact = false;
    }
  }
  return exact;
}
