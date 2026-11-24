import Database from 'better-sqlite3';

import { CARD_GUARD_MESSAGES } from './cardGuards.js';

/**
 * The value-free boundary for database errors. SQLite's own messages can
 * quote whatever a database holds: identifiers, constraint names, the text a
 * foreign trigger raises. And any thrown object can carry more than its
 * message: a stack captured earlier, a cause, other properties. So the
 * boundary never returns a foreign object. What leaves is one of this
 * module's own frozen errors: a HoldrRefusal (or a HoldrGuardRefusal) Holdr
 * raised itself, or a HoldrDbError that names only a fixed operation and
 * SQLite's result code. A route can answer a card guard refusal
 * (isCardGuardRefusal) as card data, another HoldrRefusal with its message,
 * and a HoldrDbError with a fixed message and at most its code.
 */

const SQLITE_CODE = /^SQLITE_[A-Z_]{1,40}$/;
const OPERATION = /^[a-z][a-z ]{0,62}[a-z]$/;
const GUARD_CODE = 'SQLITE_CONSTRAINT_TRIGGER';

/** The card guards' messages, each mapped to itself: what a guard refusal says is taken from here. */
const GUARD_TEMPLATES: ReadonlyMap<string, string> = new Map([...CARD_GUARD_MESSAGES].map((message) => [message, message]));

/** A string literal type; `string` itself, a value computed at run time, becomes `never`. */
type Literal<T extends string> = string extends T ? never : T;

/** Errors this module's constructors made, each with the own property values it was sealed with. */
const sealed = new WeakMap<object, ReadonlyMap<PropertyKey, unknown>>();

/**
 * Pins `error` as its constructor left it. V8 gives every Error an own
 * `stack` accessor whose setter keeps working on a frozen object, so each own
 * accessor is read once (the stack is then built from the safe message) and
 * replaced by a fixed data property, before the object is frozen and its
 * values recorded for untouched() to compare against.
 */
function seal(error: Error): void {
  if (!Object.hasOwn(error, 'stack')) {
    Object.defineProperty(error, 'stack', { value: `${error.name}: ${error.message}`, configurable: true });
  }
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!;
    const value = 'value' in descriptor ? descriptor.value : descriptor.get?.call(error);
    Object.defineProperty(error, key, {
      value,
      writable: false,
      enumerable: descriptor.enumerable ?? false,
      configurable: false,
    });
  }
  Object.freeze(error);
  sealed.set(error, new Map(Reflect.ownKeys(error).map((key) => [key, Object.getOwnPropertyDescriptor(error, key)!.value])));
}

/**
 * A database failure with nothing from the database in it. Its message is
 * `${operation} failed (${code})`, its only other own properties are
 * `operation` and `code`, it never has a `cause`, and it is frozen with a
 * fixed stack.
 */
export class HoldrDbError extends Error {
  readonly operation: string;
  readonly code: string;

  constructor(operation: string, code: string) {
    const safeOperation = OPERATION.test(operation) ? operation : 'database operation';
    const safeCode = SQLITE_CODE.test(code) ? code : 'UNKNOWN';
    super(`${safeOperation} failed (${safeCode})`);
    this.operation = safeOperation;
    this.code = safeCode;
    if (new.target === HoldrDbError) seal(this);
  }
}
HoldrDbError.prototype.name = 'HoldrDbError';

/**
 * A refusal Holdr raises itself. Its message is built only from constants,
 * field names, counts and this build's schema identifiers, never from a
 * stored or submitted value. It takes no options, so never a cause, and it
 * is frozen with a fixed stack. Never construct one from text Holdr did not
 * write.
 */
export class HoldrRefusal extends Error {
  constructor(message: string) {
    super(message);
    if (new.target === HoldrRefusal) seal(this);
  }
}
HoldrRefusal.prototype.name = 'HoldrRefusal';

/**
 * A card guard trigger's refusal, rebuilt: its message is the matching
 * template from CARD_GUARD_MESSAGES, its code SQLITE_CONSTRAINT_TRIGGER, and
 * nothing else of the original exception survives.
 */
export class HoldrGuardRefusal extends HoldrRefusal {
  readonly code = GUARD_CODE;

  constructor(template: string) {
    const message = GUARD_TEMPLATES.get(template);
    if (message === undefined) throw new TypeError('HoldrGuardRefusal takes only a card guard message');
    super(message);
    if (new.target === HoldrGuardRefusal) seal(this);
  }
}
HoldrGuardRefusal.prototype.name = 'HoldrGuardRefusal';

for (const prototype of [HoldrDbError.prototype, HoldrRefusal.prototype, HoldrGuardRefusal.prototype]) Object.freeze(prototype);

/** The own keys each of this module's errors may have; anything more means it was tampered with. */
const OWN_KEYS: ReadonlyMap<object, ReadonlySet<string>> = new Map([
  [HoldrDbError.prototype, new Set(['message', 'stack', 'operation', 'code'])],
  [HoldrRefusal.prototype, new Set(['message', 'stack'])],
  [HoldrGuardRefusal.prototype, new Set(['message', 'stack', 'code'])],
]);

/**
 * One of this module's errors exactly as its constructor left it: frozen,
 * with its class's prototype and exactly its class's own properties, each a
 * fixed data property (no getter or setter) holding the value it was sealed
 * with.
 */
function untouched(err: unknown): err is HoldrDbError | HoldrRefusal {
  if (typeof err !== 'object' || err === null) return false;
  const record = sealed.get(err);
  if (record === undefined || !Object.isFrozen(err)) return false;
  const allowed = OWN_KEYS.get(Object.getPrototypeOf(err) as object);
  const keys = Reflect.ownKeys(err);
  return allowed !== undefined && keys.length === allowed.size && record.size === allowed.size && keys.every((key) => {
    if (typeof key !== 'string' || !allowed.has(key) || !record.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(err, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.writable === false
      && descriptor.configurable === false && Object.is(descriptor.value, record.get(key));
  });
}

/** The template a native card guard refusal carries: its code and message are read once, and only matched. */
function nativeGuardTemplate(err: unknown): string | undefined {
  if (!(err instanceof Database.SqliteError)) return undefined;
  const { code, message } = err as { code: unknown; message: unknown };
  return code === GUARD_CODE && typeof message === 'string' ? GUARD_TEMPLATES.get(message) : undefined;
}

/** SQLite's result code if the error carries a well-formed one; nothing else is read from it. */
export function valueFreeDbCode(err: unknown): string {
  try {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && SQLITE_CODE.test(code)) return code;
    return err instanceof Database.SqliteError ? 'SQLITE_ERROR' : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * An error's type and SQLite (or system) code, for a log line: never its
 * message, stack or other properties, which can quote the request or the
 * database. For example `SqliteError SQLITE_BUSY`, or `TypeError`.
 */
export function errorTypeAndCode(err: unknown): string {
  const read = (key: string): unknown => {
    try {
      return typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[key] : undefined;
    } catch {
      return undefined;
    }
  };
  const name = read('name');
  const code = read('code');
  const type = typeof name === 'string' && /^\w{1,40}$/.test(name) ? name : 'Error';
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(code) ? `${type} ${code}` : type;
}

/**
 * A database failure: SQLite's own error (better-sqlite3's SqliteError) or a
 * HoldrDbError made of one. Routes never answer one with its message, which
 * can quote whatever the database holds: they pass it on to the app's
 * value-free error handler (a 500 with a fixed body; the log gets only its
 * type and code). Anything that cannot even be inspected counts as one.
 */
export function isDatabaseFailure(err: unknown): boolean {
  try {
    return err instanceof HoldrDbError
      || err instanceof Database.SqliteError
      || (err instanceof Error && err.name === 'SqliteError');
  } catch {
    return true;
  }
}

/**
 * A card guard's refusal: a HoldrGuardRefusal, or a native trigger refusal
 * (SQLITE_CONSTRAINT_TRIGGER) whose message is exactly one this build's
 * guards raise.
 */
export function isCardGuardRefusal(err: unknown): err is Error {
  try {
    return untouched(err) ? err instanceof HoldrGuardRefusal : nativeGuardTemplate(err) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The value-free form of `err`, for anything that may reach a log, a
 * response or a caller. One of this module's errors passes unchanged only if
 * its constructor made it and nothing touched it since. A native card guard
 * refusal becomes a fresh HoldrGuardRefusal with the matching template.
 * Anything else becomes a HoldrDbError naming `operation`, a literal from the
 * call site, and SQLite's result code. Nothing of a foreign object is kept:
 * not its message, stack, cause or other properties.
 */
export function toValueFreeDbError<Op extends string>(operation: Op & Literal<Op>, err: unknown): Error {
  return valueFreeError(operation, err);
}

/** `fn` behind the boundary: whatever it throws leaves through toValueFreeDbError(operation). */
export function withValueFreeDbErrors<Op extends string, This, Args extends unknown[], Result>(
  operation: Op & Literal<Op>,
  fn: (this: This, ...args: Args) => Result,
): (this: This, ...args: Args) => Result {
  return function valueFree(this: This, ...args: Args): Result {
    try {
      return fn.apply(this, args);
    } catch (error) {
      throw valueFreeError(operation, error);
    }
  };
}

function valueFreeError(operation: string, err: unknown): Error {
  try {
    if (untouched(err)) return err;
    const template = nativeGuardTemplate(err);
    if (template !== undefined) return new HoldrGuardRefusal(template);
    return new HoldrDbError(operation, valueFreeDbCode(err));
  } catch {
    // Reading a hostile object (a throwing getter or proxy trap) still ends here.
    return new HoldrDbError(operation, 'UNKNOWN');
  }
}
