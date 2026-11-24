import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { ControlError } from '../control/errors.js';
import { marker, probeExclusive, writeMarker } from '../control/lifecycle.js';
import { controlFixture } from '../control/testControl.js';
import { ADMINISTRATORS_SID, SYSTEM_SID, type WindowsAcl } from '../e2e/windowsAcl.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { ALIAS_FOLDERS, ORDINARY_NAMES, windowsAliasPaths } from '../testing/windowsAliasPaths.js';
import {
  exactKeys,
  mapOutputRefusals,
  newOutputPath,
  ownerOnlyOutputDirectory,
  parseJson,
  parseOptions,
  readInputFile,
  withReadOnlyDatabase,
  withSharedRead,
  withWriterDatabase,
  type OperatorRefusals,
} from './operatorIo.js';
import { OutputRefusal, type OutputAccess } from './ownerOnlyOutput.js';

// Synthetic only: scratch files and databases this test makes, invented SIDs and a stand-in ACL reader.

/** A caller's own refusals, as a domain makes them: one for any refused input, one per output code. */
class InputRefused extends Error {}
class OutputRefused extends Error {}
const REFUSALS: OperatorRefusals = {
  input: () => new InputRefused('demo input refused'),
  output: (code) => new OutputRefused(`demo-${code}`),
};

const BASE_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD', 'HOLDR_CONFIG'].includes(name)));
const DISPOSABLE = { ...BASE_ENV, HOLDR_CONFIG: 'none' };

const USER_SID = 'S-1-5-21-111-222-333-777';
const USERS_SID = 'S-1-5-32-545';
/** A stand-in Windows ACL reader: owner-only unless `extra` adds an entry; every path it is asked about lands in `checked`. */
const standIn = (checked: string[], extra: WindowsAcl['aces'] = []): OutputAccess => ({
  platform: 'win32', currentUserSid: () => USER_SID,
  readAcls: (paths) => paths.map((target) => {
    checked.push(target);
    const aces: WindowsAcl['aces'] = [{ sid: USER_SID, rights: 0x1f01ff, type: 'Allow' }, { sid: SYSTEM_SID, rights: 0x1f01ff, type: 'Allow' },
      { sid: ADMINISTRATORS_SID, rights: 0x1f01ff, type: 'Allow' }, ...extra];
    return { owner: USER_SID, aces, aceTypes: aces.map((ace) => (ace.type === 'Allow' ? 'AccessAllowed' : 'AccessDenied')) };
  }),
});

type ErrorType = abstract new (...args: never[]) => Error;
/**
 * A check's action part: the error `fn` throws if it is one of the declared types, kept as thrown, or null when `fn`
 * returns. Anything else is re-thrown unchanged, so no catch turns an unexpected error into data for an assertion (ROOT's
 * kill standard, addendum 3(e) and ruling 8); each `expect` on its result is the assertion-only part.
 */
const declared = (fn: () => unknown, ...types: ErrorType[]): Error | null => {
  try {
    fn();
  } catch (error) {
    if (types.some((type) => error instanceof type)) return error as Error;
    throw error;
  }
  return null;
};
/** As `declared`, for a promise: what it rejects with if one of the declared types, or null when it resolves. */
const declaredRejection = async (promise: Promise<unknown>, ...types: ErrorType[]): Promise<Error | null> => {
  try {
    await promise;
  } catch (error) {
    if (types.some((type) => error instanceof type)) return error as Error;
    throw error;
  }
  return null;
};
/** The caller's input refusal `fn` throws, or null when it returns. */
const inputRefusal = (fn: () => unknown) => declared(fn, InputRefused);
/** The output code `fn` is refused with: the caller's (its message), or the shared one unmapped (`shared <code>`); null when it returns. */
const outputCode = (fn: () => unknown): string | null => {
  const error = declared(fn, OutputRefused, OutputRefusal);
  return error instanceof OutputRefusal ? `shared ${error.code}` : error?.message ?? null;
};

let dir: string;
beforeEach(async () => { dir = await makeScratchDir('operator-io-'); });
afterEach(async () => { await removeScratchDir(dir); });
const at = (name: string) => path.join(dir, name);
/** A synthetic database with a parent and a child table. */
const syntheticDb = () => {
  const file = at('demo.db');
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE demo_parent (id INTEGER PRIMARY KEY); CREATE TABLE demo_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES demo_parent (id))');
  } finally {
    db.close();
  }
  return file;
};

describe('operator inputs', () => {
  it('reads an absolute path to a regular file of at most max bytes, and refuses anything else as the caller\'s input refusal', () => {
    fs.writeFileSync(at('in.json'), '{"a":1}\n');
    fs.mkdirSync(at('folder'));
    expect(readInputFile(at('in.json'), 8, REFUSALS).toString('utf8')).toBe('{"a":1}\n');
    const relative = path.relative(process.cwd(), at('in.json'));
    expect(path.isAbsolute(relative)).toBe(false);
    for (const [file, max] of [[at('in.json'), 7], [relative, 8], [at('missing.json'), 8], [at('folder'), 8]] as const) {
      expect(inputRefusal(() => readInputFile(file, max, REFUSALS)), file).toBeInstanceOf(InputRefused);
    }
  });

  it('refuses a link where an input or a new output must be, even a link to a regular file', (context) => {
    fs.writeFileSync(at('in.json'), '{}');
    try {
      fs.symlinkSync(at('in.json'), at('link.json'), 'file');
      fs.symlinkSync(at('nowhere.db'), at('dangling.db'), 'file');
    } catch (error) {
      // Windows lets an account without the symbolic-link privilege make none.
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    expect(inputRefusal(() => readInputFile(at('link.json'), 1024, REFUSALS))).toBeInstanceOf(InputRefused);
    expect(inputRefusal(() => newOutputPath(at('dangling.db'), REFUSALS))).toBeInstanceOf(InputRefused);
  });

  it('parses UTF-8 JSON, and refuses any text that is not JSON', () => {
    expect(parseJson(Buffer.from('{"a":[1,"\u00e9"]}', 'utf8'), REFUSALS)).toEqual({ a: [1, '\u00e9'] });
    for (const text of ['', '{', '{"a":1,}', "{'a':1}", 'NaN', '\ufeff{}']) {
      expect(inputRefusal(() => parseJson(Buffer.from(text, 'utf8'), REFUSALS)), JSON.stringify(text)).toBeInstanceOf(InputRefused);
    }
  });

  it('accepts exactly the keys in any order, and refuses a missing, an extra or a merged key, and anything but an object', () => {
    const value = { b: 2, a: 1 };
    expect(exactKeys(value, ['a', 'b'], REFUSALS)).toBe(value);
    // `{ "a|b": 1 }` joins to the same text as the keys `a` and `b`: compared key by key, it is refused.
    for (const other of [{ a: 1 }, { a: 1, b: 2, c: 3 }, { 'a|b': 1 }, { a: 1, 'b|c': 2 }, [], ['a', 'b'], null, undefined, 'a', 1, true]) {
      expect(inputRefusal(() => exactKeys(other, ['a', 'b'], REFUSALS)), JSON.stringify(other)).toBeInstanceOf(InputRefused);
    }
    // An array or a string whose index keys are exactly the declared ones is still no object.
    for (const indexed of [['x', 'y'], 'xy']) expect(inputRefusal(() => exactKeys(indexed, ['0', '1'], REFUSALS)), JSON.stringify(indexed)).toBeInstanceOf(InputRefused);
  });

  it('parses --name value pairs: each declared name given once, each value checked, every required name present', () => {
    const absolute = (value: string) => path.isAbsolute(value);
    const choice = (value: string) => value === 'incoming' || value === 'active';
    // A check that would pass a missing value: a name with no value is refused all the same, before any check.
    const note = (value: string) => value !== '';
    const database = at('finance.db');
    const parse = (args: readonly string[]) => parseOptions(args, { '--db': absolute }, { '--choose': choice, '--note': note }, REFUSALS);
    expect([...parse(['--choose', 'active', '--db', database])]).toEqual([['--choose', 'active'], ['--db', database]]);
    expect([...parse(['--db', database])]).toEqual([['--db', database]]);
    // Inherited names are unknown: 'toString' (a function) first, then '__proto__' (an object), and then undeclared ones.
    const refused: string[][] = [
      [], ['--choose', 'active'], ['--db', database, '--note'], ['--db'], ['--db', database, '--db', database], ['--db', 'finance.db'],
      ['--db', database, '--choose', 'both'], ['toString', database, '--db', database], ['__proto__', database, '--db', database],
      ['--db', database, '--other', 'x'], ['plan', '--db', database],
    ];
    for (const args of refused) expect(inputRefusal(() => parse(args)), args.join(' ')).toBeInstanceOf(InputRefused);
  });

  it('accepts only a new absolute path in an existing directory as an output', () => {
    fs.writeFileSync(at('there.db'), 'x');
    expect(newOutputPath(at('new.db'), REFUSALS)).toBeUndefined();
    const relative = path.relative(process.cwd(), at('new.db'));
    expect(path.isAbsolute(relative)).toBe(false);
    for (const file of [at('there.db'), path.join(at('missing'), 'new.db'), path.join(at('there.db'), 'new.db'), relative]) {
      expect(inputRefusal(() => newOutputPath(file, REFUSALS)), file).toBeInstanceOf(InputRefused);
    }
    expect(fs.readdirSync(dir)).toEqual(['there.db']);
  });

  it('refuses a dangling link as a new output: a junction, which Windows makes without the symbolic-link privilege', () => {
    fs.symlinkSync(at('nowhere'), at('dangling'), 'junction');
    expect(inputRefusal(() => newOutputPath(at('dangling'), REFUSALS))).toBeInstanceOf(InputRefused);
  });

  it('refuses a new output path with a name Windows reads as another file or a device, as the caller\'s output-name-refused, and makes nothing', () => {
    for (const folder of ALIAS_FOLDERS) fs.mkdirSync(at(folder));
    const before = fs.readdirSync(dir).sort();
    // Every form (testing/windowsAliasPaths.ts), on every platform, before anything at the path is read.
    for (const file of windowsAliasPaths(dir)) expect(outputCode(() => newOutputPath(file, REFUSALS)), file).toBe('demo-output-name-refused');
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    for (const folder of ALIAS_FOLDERS) expect(fs.readdirSync(at(folder)), folder).toEqual([]);
    // The ordinary names beside them are new outputs still.
    for (const name of ORDINARY_NAMES) expect(newOutputPath(at(name), REFUSALS), name).toBeUndefined();
  });
});

describe('owner-only output', () => {
  it('checks the real directory an output lands in, through a link or junction, and returns it', () => {
    fs.mkdirSync(at('owned'));
    const real = fs.realpathSync.native(at('owned'));
    fs.symlinkSync(at('owned'), at('link'), 'junction');
    const checked: string[] = [];
    expect(ownerOnlyOutputDirectory(path.join(at('owned'), 'out.json'), standIn(checked), REFUSALS)).toBe(real);
    // Through the junction: no refusal, and the real directory it reaches.
    let viaLink: unknown = null;
    expect(outputCode(() => { viaLink = ownerOnlyOutputDirectory(path.join(at('link'), 'out.json'), standIn(checked), REFUSALS); })).toBeNull();
    expect(viaLink).toBe(real);
    expect(checked).toEqual([real, real]);
  });

  it('refuses, as the caller\'s codes, a directory others can open, one it cannot check, and one that is not there', () => {
    fs.mkdirSync(at('shared'));
    const target = path.join(at('shared'), 'out.json');
    expect(outputCode(() => ownerOnlyOutputDirectory(target, standIn([], [{ sid: USERS_SID, rights: 0x120089, type: 'Allow' }]), REFUSALS)))
      .toBe('demo-output-not-owner-only');
    const unreadable: OutputAccess = { ...standIn([]), readAcls: () => { throw new Error('no ACL'); } };
    expect(outputCode(() => ownerOnlyOutputDirectory(target, unreadable, REFUSALS))).toBe('demo-output-uncheckable');
    expect(outputCode(() => ownerOnlyOutputDirectory(path.join(at('missing'), 'out.json'), standIn([]), REFUSALS))).toBe('demo-output-uncheckable');
  });

  it('maps only the shared output refusals, and lets a result or any other error through unchanged', () => {
    expect(mapOutputRefusals(() => 7, REFUSALS)).toBe(7);
    expect(outputCode(() => mapOutputRefusals(() => { throw new OutputRefusal('output-not-owner-only'); }, REFUSALS)))
      .toBe('demo-output-not-owner-only');
    expect(outputCode(() => mapOutputRefusals(() => { throw new OutputRefusal('output-name-refused'); }, REFUSALS)))
      .toBe('demo-output-name-refused');
    const other = new InputRefused('other');
    expect(declared(() => mapOutputRefusals(() => { throw other; }, REFUSALS), InputRefused, OutputRefused)).toBe(other);
  });
});

describe('database handles', () => {
  it('opens the writer\'s handle read-only with query_only, or writable with foreign keys, and closes it once fn settles', async () => {
    const file = syntheticDb();
    const seen: { db?: Database.Database } = {};
    const read = await withWriterDatabase(DISPOSABLE, file, true, (db) => {
      seen.db = db;
      expect(() => db.prepare('INSERT INTO demo_parent (id) VALUES (1)').run()).toThrow();
      return [db.readonly, db.pragma('query_only', { simple: true })];
    });
    expect(read).toEqual([true, 1]);
    expect(seen.db?.open).toBe(false);
    await withWriterDatabase(DISPOSABLE, file, false, (db) => {
      seen.db = db;
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(declared(() => db.prepare('INSERT INTO demo_child (id, parent) VALUES (1, 9)').run(), Database.SqliteError)?.message).toMatch(/FOREIGN KEY/);
      db.prepare('INSERT INTO demo_parent (id) VALUES (1)').run();
    });
    expect(seen.db?.open).toBe(false);
    expect(await declaredRejection(withWriterDatabase(DISPOSABLE, file, false, async (db) => {
      seen.db = db;
      throw new InputRefused('inside');
    }), InputRefused)).toBeInstanceOf(InputRefused);
    expect(seen.db?.open).toBe(false);
    await expect(withWriterDatabase(DISPOSABLE, at('missing.db'), true, () => 0)).rejects.toThrow();
    expect(fs.existsSync(at('missing.db'))).toBe(false);
  });

  it('opens an existing database read-only, query_only, with a 10 s busy timeout, and closes it once fn returns', () => {
    const file = syntheticDb();
    const seen: { db?: Database.Database } = {};
    expect(withReadOnlyDatabase(file, (db) => {
      seen.db = db;
      return [db.readonly, db.pragma('query_only', { simple: true }), db.pragma('busy_timeout', { simple: true })];
    })).toEqual([true, 1, 10_000]);
    expect(seen.db?.open).toBe(false);
    expect(inputRefusal(() => withReadOnlyDatabase(file, (db) => {
      seen.db = db;
      throw new InputRefused('inside');
    }))).toBeInstanceOf(InputRefused);
    expect(seen.db?.open).toBe(false);
    expect(() => withReadOnlyDatabase(at('missing.db'), () => 0)).toThrow();
    expect(fs.existsSync(at('missing.db'))).toBe(false);
  });

  it('reads with no lease protocol only on a disposable stack, and otherwise gets null without opening the database', async () => {
    const file = syntheticDb();
    const read = vi.fn((db: Database.Database) => db.pragma('query_only', { simple: true }));
    expect(await withSharedRead(BASE_ENV, file, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await withSharedRead(DISPOSABLE, file, read)).toEqual({ value: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses lease variables and a malformed control dir before anything is read', async () => {
    const file = syntheticDb();
    const read = vi.fn(() => 0);
    expect(await declaredRejection(withSharedRead({ ...DISPOSABLE, HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }, file, read), ControlError))
      .toMatchObject({ code: 'E0I_LEASE_ENV' });
    expect(await declaredRejection(withSharedRead({ ...BASE_ENV, HOLDR_CONTROL_DIR: 'relative/control' }, file, read), ControlError))
      .toMatchObject({ code: 'E0I_CONTROL_DIR' });
    expect(read).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'darwin')('with a control dir configured, never falls back to a read without its lease (no lock protocol here)',
    async () => {
      const file = syntheticDb();
      const read = vi.fn(() => 0);
      expect(await declaredRejection(withSharedRead({ ...DISPOSABLE, HOLDR_CONTROL_DIR: '/holdr-synthetic/control' }, file, read), ControlError))
        .toMatchObject({ code: 'E0I_PLATFORM' });
      expect(read).not.toHaveBeenCalled();
    });

  it.runIf(process.platform === 'darwin')('reads while it holds the writer\'s shared lease, releases it after, and refuses maintenance unread',
    async () => {
      const file = syntheticDb();
      const control = await controlFixture();
      try {
        const env = { ...BASE_ENV, HOLDR_CONTROL_DIR: control.controlDir };
        expect(await withSharedRead(env, file, (db) => [probeExclusive(control.controlDir), db.pragma('query_only', { simple: true })]))
          .toEqual({ value: ['held', 1] });
        expect(probeExclusive(control.controlDir)).toBe('free');
        writeMarker(control.controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'holdr-lifecycle enter'));
        const read = vi.fn(() => 0);
        expect(await declaredRejection(withSharedRead(env, file, read), ControlError)).toMatchObject({ code: 'E0I_MAINTENANCE', exitCode: 3 });
        expect(read).not.toHaveBeenCalled();
      } finally {
        control.cleanup();
      }
    });
});
