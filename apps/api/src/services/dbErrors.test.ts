import { describe, it, expect } from 'vitest';
import util from 'node:util';
import Database from 'better-sqlite3';

import { containsCardData, containsCardSecret } from '@finance-tracker/shared';
import { CARD_GUARD_MESSAGES } from './cardGuards.js';
import {
  HoldrDbError,
  HoldrGuardRefusal,
  HoldrRefusal,
  isCardGuardRefusal,
  toValueFreeDbError,
  valueFreeDbCode,
  withValueFreeDbErrors,
} from './dbErrors.js';

// Synthetic values only: a published test card number and a labeled code.
const PAN = '4111111111111111';
const SECRET = 'CVV 123';
const PLANTED = [PAN, SECRET];
const GUARD_MESSAGE = 'card_accounts.nickname must not contain a card number';

/** Everything a log, a response or a debugger could show of `error`. */
function serialisations(error: Error): string[] {
  return [error.message, String(error.stack), JSON.stringify(error), util.inspect(error), String(error), Object.keys(error).join()];
}

/** No planted value and nothing either card detector flags, wherever `error` could be shown; no cause. */
function expectSafe(error: Error): void {
  expect('cause' in error).toBe(false);
  for (const text of serialisations(error)) {
    for (const value of PLANTED) expect(text).not.toContain(value);
    expect(containsCardData(text), text).toBe(false);
    expect(containsCardSecret(text), text).toBe(false);
  }
}

function expectValueFreeDbError(error: Error, operation: string, code: string): void {
  expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
  expect(error.message).toBe(`${operation} failed (${code})`);
  expect(error).toMatchObject({ name: 'HoldrDbError', operation, code });
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['code', 'message', 'operation', 'stack']);
  expect(JSON.stringify(error)).toBe(JSON.stringify({ operation, code }));
  expectSafe(error);
}

function expectGuardRefusal(error: Error, message: string): void {
  expect(Object.getPrototypeOf(error)).toBe(HoldrGuardRefusal.prototype);
  expect(error).toBeInstanceOf(HoldrRefusal);
  expect(error).toMatchObject({ name: 'HoldrGuardRefusal', message, code: 'SQLITE_CONSTRAINT_TRIGGER' });
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['code', 'message', 'stack']);
  expect(isCardGuardRefusal(error)).toBe(true);
  expect(valueFreeDbCode(error)).toBe('SQLITE_CONSTRAINT_TRIGGER');
  expectSafe(error);
}

function sqliteError(message: string, code: string): Error {
  return new Database.SqliteError(message, code);
}

/** A native guard refusal that says a template but carries more: an earlier stack, a cause, other properties. */
function taintedGuardRefusal(): Error {
  const error = sqliteError(`${SECRET} ${PAN}`, 'SQLITE_CONSTRAINT_TRIGGER');
  void error.stack;
  error.message = GUARD_MESSAGE;
  return Object.assign(error, { cause: new Error(PAN), context: `${SECRET} ${PAN}` });
}

describe('toValueFreeDbError', () => {
  it('replaces SQLite messages with the operation and result code, and keeps no cause', () => {
    const cases: Array<[Error, string]> = [
      [sqliteError(`no such column: pan_${PAN}`, 'SQLITE_ERROR'), 'SQLITE_ERROR'],
      [sqliteError(SECRET, 'SQLITE_CONSTRAINT_TRIGGER'), 'SQLITE_CONSTRAINT_TRIGGER'],
      [sqliteError(`CHECK constraint failed: pan_${PAN}`, 'SQLITE_CONSTRAINT_CHECK'), 'SQLITE_CONSTRAINT_CHECK'],
      [sqliteError(`UNIQUE constraint failed: t.${PAN}`, 'SQLITE_CONSTRAINT_UNIQUE'), 'SQLITE_CONSTRAINT_UNIQUE'],
    ];
    for (const [raw, code] of cases) expectValueFreeDbError(toValueFreeDbError('open database', raw), 'open database', code);
  });

  it('accepts only well-formed SQLite result codes', () => {
    expect(valueFreeDbCode(sqliteError(PAN, `SQLITE_${PAN}`))).toBe('SQLITE_ERROR');
    expect(valueFreeDbCode(sqliteError(PAN, 'SQLITE_BUSY; CVV 123'))).toBe('SQLITE_ERROR');
    expect(valueFreeDbCode(Object.assign(new Error(PAN), { code: 'EACCES' }))).toBe('UNKNOWN');
    expect(valueFreeDbCode(Object.assign(new Error(PAN), { code: 'SQLITE_BUSY' }))).toBe('SQLITE_BUSY');
    for (const value of [PAN, SECRET, null, undefined, 42, { code: 4111 }]) expect(valueFreeDbCode(value)).toBe('UNKNOWN');
    expectValueFreeDbError(new HoldrDbError(`read ${PAN}`, `SQLITE_ERROR ${SECRET}`), 'database operation', 'UNKNOWN');
  });

  it('turns a native guard refusal into a fresh one that holds only the matching template', () => {
    const native = sqliteError(GUARD_MESSAGE, 'SQLITE_CONSTRAINT_TRIGGER');
    expect(isCardGuardRefusal(native)).toBe(true);
    expect(valueFreeDbCode(native)).toBe('SQLITE_CONSTRAINT_TRIGGER');
    const rebuilt = toValueFreeDbError('create card account', native);
    expect(rebuilt).not.toBe(native);
    expectGuardRefusal(rebuilt, GUARD_MESSAGE);
    expect(CARD_GUARD_MESSAGES.has('card_transactions.<column> must not contain a card number')).toBe(true);
  });

  it('keeps nothing else of a guard refusal: not an earlier stack, a cause or other properties', () => {
    const tainted = taintedGuardRefusal();
    expect(String(tainted.stack)).toContain(PAN);
    const rebuilt = toValueFreeDbError('create card account', tainted);
    expectGuardRefusal(rebuilt, GUARD_MESSAGE);
    expect(Object.keys(rebuilt)).toEqual(['code']);
  });

  it('never passes a message that only resembles a guard message', () => {
    const nearMisses: Error[] = [
      sqliteError(`${GUARD_MESSAGE} ${PAN}`, 'SQLITE_CONSTRAINT_TRIGGER'),
      sqliteError(`card_accounts.pan_${PAN} must not contain a card number`, 'SQLITE_CONSTRAINT_TRIGGER'),
      sqliteError(` ${GUARD_MESSAGE}`, 'SQLITE_CONSTRAINT_TRIGGER'),
      sqliteError(GUARD_MESSAGE, 'SQLITE_CONSTRAINT_CHECK'),
      Object.assign(new Error(GUARD_MESSAGE), { code: 'SQLITE_CONSTRAINT_TRIGGER' }),
    ];
    for (const error of nearMisses) {
      expect(isCardGuardRefusal(error), error.message).toBe(false);
      expect(toValueFreeDbError('create card account', error)).toBeInstanceOf(HoldrDbError);
    }
    expect(() => new HoldrGuardRefusal(`${GUARD_MESSAGE} ${PAN}`)).toThrow(TypeError);
  });

  it('pins each error\'s stack: assigning it throws in strict code, does nothing in sloppy code, and it never changes', () => {
    const sloppyAssign = new Function('error', 'value', 'error.stack = value; return error.stack;') as
      (error: Error, value: string) => unknown;
    const own: Error[] = [
      new HoldrDbError('create card account', 'SQLITE_BUSY'),
      new HoldrRefusal('nickname must not contain a card number or 13 or more consecutive digits'),
      new HoldrGuardRefusal(GUARD_MESSAGE),
    ];
    for (const error of own) {
      const before = error.stack;
      expect(before).toMatch(new RegExp(`^${error.name}: ${error.message.replace(/[()]/g, '\\$&')}\n`));
      expect(() => {
        (error as { stack?: string }).stack = `${SECRET} ${PAN}`;
      }).toThrow(TypeError);
      expect(Reflect.set(error, 'stack', PAN)).toBe(false);
      expect(sloppyAssign(error, `${SECRET} ${PAN}`)).toBe(before);
      expect(error.stack).toBe(before);
      for (const key of Reflect.ownKeys(error)) {
        const descriptor = Object.getOwnPropertyDescriptor(error, key)!;
        expect(descriptor, String(key)).toMatchObject({ writable: false, configurable: false });
        expect('get' in descriptor || 'set' in descriptor, String(key)).toBe(false);
      }
      const passed = toValueFreeDbError('create card account', error);
      expect(passed.stack).toBe(before);
      expectSafe(passed);
    }
  });

  it('freezes its own errors, so none can gain a cause or another property', () => {
    const own: Error[] = [
      new HoldrDbError('create card account', 'SQLITE_BUSY'),
      new HoldrRefusal('nickname must not contain a card number or 13 or more consecutive digits'),
      new HoldrGuardRefusal(GUARD_MESSAGE),
    ];
    for (const error of own) {
      expect(Object.isFrozen(error)).toBe(true);
      expect(() => Object.assign(error, { cause: PAN })).toThrow(TypeError);
      expect(() => Object.defineProperty(error, 'context', { value: SECRET })).toThrow(TypeError);
      expect(() => Object.setPrototypeOf(error, Error.prototype)).toThrow(TypeError);
      const passed = toValueFreeDbError('create card account', error);
      expect(passed.message).toBe(error.message);
      expect(Object.getPrototypeOf(passed)).toBe(Object.getPrototypeOf(error));
      expectSafe(passed);
    }
    for (const Class of [HoldrDbError, HoldrRefusal, HoldrGuardRefusal]) expect(Object.isFrozen(Class.prototype)).toBe(true);
  });

  it('rebuilds anything that only looks like its own errors', () => {
    class Extended extends HoldrRefusal {}
    const lookalikes: unknown[] = [
      Object.create(HoldrRefusal.prototype, {
        message: { value: `${SECRET} ${PAN}` }, stack: { value: PAN }, cause: { value: PAN },
      }),
      Object.create(HoldrGuardRefusal.prototype, {
        message: { value: GUARD_MESSAGE }, code: { value: 'SQLITE_CONSTRAINT_TRIGGER' }, stack: { value: `${SECRET} ${PAN}` },
      }),
      Object.create(HoldrDbError.prototype, {
        message: { value: PAN }, operation: { value: SECRET }, code: { value: 'SQLITE_BUSY' },
      }),
      Object.assign(new Extended(GUARD_MESSAGE), { cause: PAN }),
    ];
    for (const lookalike of lookalikes) {
      expect(isCardGuardRefusal(lookalike)).toBe(false);
      const rebuilt = toValueFreeDbError('create card account', lookalike);
      expect(Object.getPrototypeOf(rebuilt)).toBe(HoldrDbError.prototype);
      expectSafe(rebuilt);
    }
  });

  it('survives hostile thrown values', () => {
    const throwing = new Proxy({}, {
      get: () => { throw new Error(PAN); },
      getPrototypeOf: () => { throw new Error(SECRET); },
      ownKeys: () => { throw new Error(PAN); },
    });
    const hostile: unknown[] = [
      throwing,
      { get code(): string { throw new Error(PAN); }, message: GUARD_MESSAGE },
      `${SECRET} ${PAN}`,
      { pan: PAN, toString: () => SECRET },
      Symbol(PAN),
    ];
    for (const value of hostile) {
      expect(isCardGuardRefusal(value)).toBe(false);
      expect(valueFreeDbCode(value)).toBe('UNKNOWN');
      expectValueFreeDbError(toValueFreeDbError('open database', value), 'open database', 'UNKNOWN');
    }
  });

  it('takes the operation only as a literal from the call site', () => {
    const computed: string = `read ${PAN}`;
    // @ts-expect-error a computed string is not an operation
    const error = toValueFreeDbError(computed, new Error(SECRET));
    expect(error.message).toBe('database operation failed (UNKNOWN)');
  });
});

describe('withValueFreeDbErrors', () => {
  it('keeps this, arguments and results, and sends failures through the boundary', () => {
    const target = {
      base: 40,
      add(this: { base: number }, value: number): number {
        if (value === -1) throw sqliteError(`no such table: t_${PAN}`, 'SQLITE_ERROR');
        if (value === -2) throw taintedGuardRefusal();
        return this.base + value;
      },
    };
    const add = withValueFreeDbErrors('list card accounts', target.add);
    expect(add.call(target, 2)).toBe(42);
    const failures = [-1, -2].map((value) => {
      try {
        add.call(target, value);
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected a failure');
    });
    expectValueFreeDbError(failures[0], 'list card accounts', 'SQLITE_ERROR');
    expectGuardRefusal(failures[1], GUARD_MESSAGE);
  });
});
