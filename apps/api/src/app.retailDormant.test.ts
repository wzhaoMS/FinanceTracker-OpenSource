import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import type Database from 'better-sqlite3';

import { createApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { serviceRefusal } from './auth/serviceScope.js';
import { MetalsCardCheckState } from './services/metalsRead/cardCheck.js';
import {
  RETAIL_TABLES,
  RETAIL_TAXONOMY_MAPPING_FORMAT,
  importRetailTaxonomy,
  installRetailSchema,
  planRetailTaxonomyImport,
  retailDepartmentKey,
  retailProductKey,
  retailSchemaState,
  retailTaxonomyMappingOf,
  serializeRetailTaxonomyMapping,
  type RetailTaxonomyEntry,
} from './services/retail/index.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';
import { RETAIL_TEST_GO, RETAIL_TEST_NOW } from './testing/retailDb.js';
import {
  API_SRC,
  RETAIL_FULL_RECEIPTS,
  existingRouteUrls,
  moduleClosure,
  moduleSpecifiers,
  registeredGetRoutes,
  routeMatches,
  seedExistingWorld,
  seedRetailReceipts,
  sourcePath,
} from './testing/retailDormancy.js';
import { tablesAndCounts } from './testing/sqliteContents.js';

/**
 * The retail domain stays dormant outside its own read routes (Costco plan v5 §1, §10; PR 5 §7 as narrowed by the read
 * API): nothing at boot reads a `retail_` table, no existing answer changes, and only `routes/retail.ts` reads the tables,
 * on a `/retail/costco/*` request, read-only, through its read model, which resolves each line's category with the retail
 * taxonomy's resolver over the taxonomy's stored rows (Costco M1). Every existing GET route answers byte-identically, for
 * the owner's session and the service token, with the retail tables absent, present and empty, and present and full
 * (taxonomy rows included). Synthetic data only: made-up descriptors, amounts, card endings, ids and dates.
 */

const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '6f'.repeat(32);
const FAST = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'synthetic password';
const NOW = new Date('2031-03-01T12:00:00.000Z');
const STATES = ['absent', 'present and empty', 'present and full'] as const;
type State = (typeof STATES)[number];
const PRINCIPALS = ['owner', 'service'] as const;
type Principal = (typeof PRINCIPALS)[number];
/** Any SQL that so much as names a retail object (a table, its prefix, the schema check's pattern). */
const RETAIL_SQL = /retail/i;
const RETAIL_TABLE = new RegExp(`\\b(?:${RETAIL_TABLES.join('|')})\\b`);
const RETAIL_ROUTES = ['GET /retail/costco/receipts', 'GET /retail/costco/receipts/:ref', 'GET /retail/costco/summary'];
const NO_RECEIPT = `rcp-${'a'.repeat(32)}`;
/**
 * The retail domain's modules a read may load: the schema declaration with its read-only state check, the id grammar, and
 * the taxonomy's resolver with its version labels (the read model resolves each line's category on request, read-only:
 * Costco M1).
 */
const RETAIL_READ_MODULES = ['services/retail/common.ts', 'services/retail/schema.ts', 'services/retail/taxonomyFormats.ts',
  'services/retail/taxonomyResolver.ts'];
/** The domain's index (every writer) and the taxonomy's writer and tooling: never loaded by a read. */
const RETAIL_WRITE_MODULES = ['services/retail/index.ts', 'services/retail/taxonomyFiles.ts', 'services/retail/taxonomyImport.ts',
  'services/retail/taxonomyPlan.ts', 'services/retail/taxonomyWorklist.ts'];
/** A module's source without its comments. */

let repo: SqliteStateRepo;
let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  repo = new SqliteStateRepo({ file: ':memory:', now: () => NOW });
  db = repo.internalGetDb();
  // Nothing leaves the process: a route that would reach a provider finds it down.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('fetch failed');
  }));
  // The metals snapshot token (design v3.2 §8.3: overview proof, card check, roster preview) stamps SQLite's data version,
  // `data_version:schema_version:total_changes()`, which any write anywhere moves (a sign-in included), and installing the
  // retail tables moves `schema_version` by design. It is pinned to one data version in every state, as its own token
  // computes it; everything else in those answers is compared as served.
  const token = MetalsCardCheckState.prototype.token;
  vi.spyOn(MetalsCardCheckState.prototype, 'token').mockImplementation((day: string) =>
    token.call({ snapshot: { version: 'pinned' } } as unknown as MetalsCardCheckState, day));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  repo.close();
});

/** One statement the database handle was asked to prepare, run (with its parameters), execute or answer as a pragma. */
interface Sql {
  kind: 'prepare' | 'run' | 'exec' | 'pragma';
  sql: string;
  /** better-sqlite3's `statement.readonly` for a prepared statement and each run of it; null for the others. */
  readonly: boolean | null;
  /** A run's bound parameters, as JSON: a schema check names its prefix only here (`LIKE ?`). */
  params: string;
}

/** Whether an entry names a retail object, in its SQL or in a parameter bound to it. */
const namesRetail = (entry: Sql) => RETAIL_SQL.test(entry.sql) || RETAIL_SQL.test(entry.params);

/**
 * Records every statement prepared on the repository's database handle and every run of one (`get`, `all`, `iterate`,
 * `run`, with its parameters), every `exec` and every pragma, until `restore`.
 */
function recordSql(handle: Database.Database): { take(): Sql[]; restore(): void } {
  const seen: Sql[] = [];
  const { prepare, exec, pragma } = handle;
  Object.assign(handle, {
    prepare(source: string) {
      const entry: Sql = { kind: 'prepare', sql: source, readonly: null, params: '' };
      seen.push(entry);
      const statement = prepare.call(handle, source);
      entry.readonly = statement.readonly;
      for (const method of ['get', 'all', 'iterate', 'run'] as const) {
        const original = statement[method] as (...params: unknown[]) => unknown;
        Object.defineProperty(statement, method, {
          configurable: true,
          value: (...params: unknown[]) => {
            seen.push({ kind: 'run', sql: source, readonly: statement.readonly, params: JSON.stringify(params, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)) ?? '' });
            return original.apply(statement, params);
          },
        });
      }
      return statement;
    },
    exec(source: string) {
      seen.push({ kind: 'exec', sql: source, readonly: null, params: '' });
      return exec.call(handle, source);
    },
    pragma(source: string, options?: Database.PragmaOptions) {
      seen.push({ kind: 'pragma', sql: source, readonly: null, params: '' });
      return pragma.call(handle, source, options);
    },
  });
  return {
    take: () => seen.splice(0),
    restore: () => {
      for (const name of ['prepare', 'exec', 'pragma']) Reflect.deleteProperty(handle, name);
    },
  };
}

/** What a write would move: every table's row count, this connection's total_changes() and the schema's version. */
function footprint(): { tables: Array<[string, number]>; changes: number; schema: number } {
  return {
    tables: tablesAndCounts(db),
    changes: db.prepare('SELECT total_changes()').pluck().get() as number,
    schema: db.pragma('schema_version', { simple: true }) as number,
  };
}

interface Answer {
  principal: Principal;
  url: string;
  status: number;
  type: string;
  body: string;
}

interface StateRun {
  /** What creating the app prepared, executed or asked. */
  boot: Sql[];
  /** Every existing route's answers, the owner's then the service token's, in URL order. */
  answers: Answer[];
  /** What those answers prepared, executed or asked. */
  existingSql: Sql[];
  /** The retail read routes' answers, and what they prepared, executed or asked. */
  retail: Answer[];
  retailSql: Sql[];
  /** The footprint before the existing routes, after them, and after the retail routes. */
  footprints: Array<ReturnType<typeof footprint>>;
}

/** A fresh app over the repository in its current state: its boot recorded, the owner signed in, every URL asked as both principals. */
async function run(urls: string[]): Promise<StateRun> {
  const sql = recordSql(db);
  try {
    const built = createApp({
      repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, now: () => NOW, log: () => {},
      // Prices on with a provider that has nothing new: the metals reads value with the stored closes and write nothing.
      metalSpotBars: async () => [],
    });
    const boot = sql.take();
    if (built.users.countUsers() === 0) built.users.createUser('alex', await hashPassword(PASSWORD, FAST));
    const client = request(await listenLoopback(built.app));
    const login = await client.post('/auth/login').set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ username: 'alex', password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((entry) => entry.startsWith('holdr_session='))!.split(';')[0];
    const ask = async (principal: Principal, url: string): Promise<Answer> => {
      const res = principal === 'owner'
        ? await client.get(url).set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1')
        : await client.get(url).set('Authorization', ['Bearer', TOKEN].join(' '));
      const body = typeof res.text === 'string' ? res.text : Buffer.isBuffer(res.body) ? res.body.toString('base64') : JSON.stringify(res.body);
      return { principal, url, status: res.status, type: String(res.headers['content-type'] ?? ''), body };
    };

    const footprints = [footprint()];
    sql.take();
    const answers: Answer[] = [];
    for (const principal of PRINCIPALS) for (const url of urls) answers.push(await ask(principal, url));
    const existingSql = sql.take();
    footprints.push(footprint());
    sql.take();

    const listed = await ask('owner', '/retail/costco/receipts?limit=100');
    const refs = ((JSON.parse(listed.body) as { receipts?: Array<{ receiptRef: string }> }).receipts ?? []).map((row) => row.receiptRef);
    const retail = [listed];
    for (const principal of PRINCIPALS) {
      for (const url of ['/retail/costco/summary', '/retail/costco/receipts', '/retail/costco/receipts?channel=warehouse&offset=1&limit=2',
        ...[...refs, NO_RECEIPT].map((ref) => `/retail/costco/receipts/${ref}`)]) {
        retail.push(await ask(principal, url));
      }
    }
    const retailSql = sql.take();
    footprints.push(footprint());
    sql.take();
    return { boot, answers, existingSql, retail, retailSql, footprints };
  } finally {
    sql.restore();
  }
}

/** Seeds every existing domain, then asks every URL with the retail tables absent, present and empty, and present and full. */
async function runEveryState(): Promise<{ urls: string[]; runs: Record<State, StateRun> }> {
  const world = await seedExistingWorld(repo);
  const urls = Object.values(existingRouteUrls(world)).flat();
  expect(retailSchemaState(db)).toBe('absent');
  const absent = await run(urls);

  installRetailSchema(db, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO });
  expect(retailSchemaState(db)).toBe('present');
  const empty = await run(urls);

  seedRetailReceipts(db);
  expect(db.prepare(`SELECT count(*) FROM retail_receipts`).pluck().get()).toBe(RETAIL_FULL_RECEIPTS);
  expect(db.prepare(`SELECT count(*) FROM retail_memberships`).pluck().get()).toBe(2);
  expect(db.prepare(`SELECT count(*) FROM retail_receipts WHERE state = 'quarantined'`).pluck().get()).toBeGreaterThanOrEqual(1);
  expect(db.prepare(`SELECT count(*) FROM retail_held`).pluck().get()).toBeGreaterThanOrEqual(1);
  // Costco 3/7 (3b): taxonomy rows too, an owner's, an agent's precious metals and a department's, change no answer.
  const entries: RetailTaxonomyEntry[] = [
    { subjectKind: 'department', subjectKey: retailDepartmentKey('costco', 12), source: 'department-review', node: 'home-kitchen', confidenceBp: null },
    ...[
      { subjectKind: 'product', subjectKey: retailProductKey('costco', '100100'), source: 'owner', node: 'groceries', confidenceBp: null },
      { subjectKind: 'product', subjectKey: retailProductKey('costco', '200200'), source: 'agent', node: 'precious-metals', confidenceBp: 9_000 },
    ].sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1)) as RetailTaxonomyEntry[],
  ];
  const mapping = retailTaxonomyMappingOf({ format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 2, reviewed: true,
    decisionId: '1d'.repeat(16), entries });
  const mappingSha256 = createHash('sha256').update(serializeRetailTaxonomyMapping(mapping)).digest('hex');
  importRetailTaxonomy(db, mapping, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, mappingSha256,
    planDigest: planRetailTaxonomyImport(db, mapping, mappingSha256).planDigest });
  expect(db.prepare(`SELECT count(*) FROM retail_taxonomy_assignments`).pluck().get()).toBe(3);
  const full = await run(urls);
  return { urls, runs: { absent, 'present and empty': empty, 'present and full': full } };
}

const named = (answer: Answer) => `${answer.principal} ${answer.url}`;

describe('the retail domain is dormant outside its own read routes', () => {
  it('asks every registered GET route outside /retail, each URL on its own route', async () => {
    const world = await seedExistingWorld(repo);
    const routes = registeredGetRoutes(createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, log: () => {} }).app);
    expect(routes.filter((route) => route.startsWith('GET /retail/'))).toEqual(RETAIL_ROUTES);
    const table = existingRouteUrls(world);
    expect(Object.keys(table).sort()).toEqual(routes.filter((route) => !route.startsWith('GET /retail/')));
    for (const [route, urls] of Object.entries(table)) {
      expect(urls.length, route).toBeGreaterThan(0);
      expect(urls.filter((url) => !routeMatches(route, url)), route).toEqual([]);
    }
  });

  it('answers every existing GET route byte-identically, owner and service token, with the retail tables absent, present and empty, and present and full', async () => {
    const { urls, runs } = await runEveryState();
    const absent = runs.absent.answers;
    expect(absent.length).toBe(PRINCIPALS.length * urls.length);
    for (const state of STATES) {
      const answers = runs[state].answers;
      expect(answers.map(named), state).toEqual(absent.map(named));
      const differing = answers.filter((answer, index) => answer.status !== absent[index].status || answer.type !== absent[index].type
        || answer.body !== absent[index].body).map(named);
      expect(differing, state).toEqual([]);
    }

    // The answers ROOT named carry real figures for both principals: every Spending and card read answers (PR 2's set and
    // the rest), Spending's summary among them, and every metals read is installed. The service token reads only what
    // auth/serviceScope.ts lists; every other read refuses it (403), the same in every state.
    const answered = (prefix: string) => absent.filter((answer) => answer.url.startsWith(prefix));
    const inScope = (answer: Answer) => answer.principal === 'owner'
      || serviceRefusal('GET', new URL(answer.url, 'http://127.0.0.1').pathname) === null;
    expect(['/spending/', '/card-accounts', '/card-transactions'].flatMap(answered).filter(inScope).filter((answer) => answer.status !== 200)
      .map(named)).toEqual([]);
    expect(absent.filter((answer) => !inScope(answer) && (answer.status !== 403 || JSON.parse(answer.body).code !== 'principal-not-allowed'))
      .map(named)).toEqual([]);
    expect(absent.filter((answer) => !inScope(answer)).length).toBeGreaterThan(0);
    for (const principal of PRINCIPALS) {
      const summary = answered('/spending/summary').filter((answer) => answer.principal === principal);
      expect(summary.map((answer) => answer.status), principal).toEqual([200, 200]);
      const metals = answered('/metals/').filter((answer) => answer.principal === principal);
      expect(metals.length, principal).toBeGreaterThanOrEqual(19);
      expect(metals.filter(inScope).filter((answer) => answer.status !== 200 || JSON.parse(answer.body).installed === false).map(named)).toEqual([]);
    }
    const purchases = JSON.parse(absent.find((answer) => answer.url === '/metals/purchases')!.body) as { purchases: unknown[] };
    expect(purchases.purchases.length).toBeGreaterThan(0);
    // Nothing failed but what has nothing to reach in a test: the release attestation (none given).
    expect(absent.filter((answer) => answer.status >= 500 && !/^\/release\b/.test(answer.url)).map(named)).toEqual([]);
  }, 60_000);

  it('reads no retail table at boot or for an existing route, writes nothing on a read, and reads the tables only on a /retail/costco request, read-only', async () => {
    const { runs } = await runEveryState();
    for (const state of STATES) {
      const { boot, existingSql, retail, retailSql, footprints } = runs[state];
      expect(boot.filter(namesRetail).map((entry) => entry.kind), state).toEqual([]);
      expect(existingSql.filter((entry) => entry.kind === 'run').length, state).toBeGreaterThan(100);
      expect(existingSql.filter(namesRetail).map((entry) => entry.kind), state).toEqual([]);
      // No GET wrote: not a row, not a table, not a schema object, the retail routes' included.
      expect(footprints[1], state).toEqual(footprints[0]);
      expect(footprints[2], state).toEqual(footprints[0]);
      // The retail routes ask only read-only SELECTs (and read-only pragmas), and execute nothing.
      expect(retailSql.filter((entry) => entry.kind === 'exec' || ((entry.kind === 'prepare' || entry.kind === 'run') && (entry.readonly !== true
        || !/^\s*(?:SELECT|WITH)\b/i.test(entry.sql))) || (entry.kind === 'pragma' && entry.sql.includes('='))).map((entry) => entry.kind), state)
        .toEqual([]);
      expect(retail.filter((answer) => answer.principal === 'owner' && answer.url === '/retail/costco/summary').map((answer) => answer.status), state)
        .toEqual([200]);
    }
    // With receipts stored, the owner's retail reads are what read them.
    expect(runs['present and full'].retailSql.some((entry) => entry.kind === 'run' && RETAIL_TABLE.test(entry.sql))).toBe(true);
    // With taxonomy rows stored too, a receipt's detail reads them (its lines' categories), read-only as checked above.
    expect(runs['present and full'].retailSql.some((entry) => entry.kind === 'run' && /\bretail_taxonomy_assignments\b/.test(entry.sql))).toBe(true);
    // Even with the tables absent, a retail read asks for them (its schema check binds the `retail_` prefix): the check
    // above would see the same at boot or on an existing route.
    expect(runs.absent.retailSql.some((entry) => entry.kind === 'run' && namesRetail(entry))).toBe(true);
    expect(runs['present and full'].retail.filter((answer) => answer.principal === 'owner' && /\/receipts\/rcp-/.test(answer.url)
      && answer.status === 200).length).toBe(RETAIL_FULL_RECEIPTS);
  }, 60_000);

  it('loads at boot only the retail read route, its read model, the schema check and the taxonomy\'s resolver, and only they name a retail table', () => {
    const route = path.join(API_SRC, 'routes/retail.ts');
    for (const entry of ['index.ts', 'app.ts']) {
      const { files, unresolved } = moduleClosure(path.join(API_SRC, entry));
      expect(unresolved, entry).toEqual([]);
      expect(files.size, entry).toBeGreaterThan(50);
      expect(files.has(route), entry).toBe(true);
      const loaded = [...files.keys()].map(sourcePath);
      expect(loaded.filter((file) => file.startsWith('services/retail/') && !RETAIL_READ_MODULES.includes(file)), entry).toEqual([]);
      expect(loaded.filter((file) => file.startsWith('services/retail/')).sort(), entry).toEqual([...RETAIL_READ_MODULES].sort());
      // Never the domain's index, nor the taxonomy's files, plan, import or worklist: the read model loads its resolver only.
      expect(loaded.filter((file) => RETAIL_WRITE_MODULES.includes(file)), entry).toEqual([]);
      expect(loaded.filter((file) => /^cli\/retail/.test(file)), entry).toEqual([]);
      // The taxonomy's resolver names its tables to read them (on request, inside the route's one read transaction).
      const naming = [...files].filter(([, source]) => RETAIL_TABLE.test(source)).map(([file]) => sourcePath(file));
      expect(naming.filter((file) => file !== 'routes/retail.ts' && file !== 'services/retail/schema.ts' && file !== 'services/retail/taxonomyResolver.ts'
        && !file.startsWith('services/retailRead/')), entry).toEqual([]);
      expect(naming.filter((file) => file.startsWith('services/retailRead/')).length, entry).toBeGreaterThan(0);
      // Nothing else at boot imports the retail domain, so nothing else can ask for its tables (a schema check names
      // them only in a bound parameter, which no source text shows): the route, and its read model for the resolver.
      const importers = [...files].filter(([file, source]) => moduleSpecifiers(source).some((specifier) => specifier.startsWith('.')
        && /^services\/retail(?:\/|$)/.test(sourcePath(path.resolve(path.dirname(file), specifier))))).map(([file]) => sourcePath(file));
      expect(importers.filter((file) => file !== 'routes/retail.ts' && !/^services\/(?:retail|retailRead)\//.test(file)), entry).toEqual([]);
      expect(importers, entry).toContain('routes/retail.ts');
      expect(importers.filter((file) => !file.startsWith('services/retail/')).sort(), entry).toEqual(['routes/retail.ts', 'services/retailRead/receipts.ts']);
    }
  });

  it('keeps the retail read route free of every writer, converter and write statement', () => {
    const route = path.join(API_SRC, 'routes/retail.ts');
    const { files, unresolved } = moduleClosure(route, { shared: true });
    expect(unresolved).toEqual([]);
    const loaded = [...files.keys()].map(sourcePath);
    const own = loaded.filter((file) => file === 'routes/retail.ts' || file.startsWith('services/retailRead/'));
    expect(own).toContain('services/retailRead/receipts.ts');
    // Of the retail domain, the schema declaration and its state check, the id grammar, and the taxonomy's resolver with
    // its version labels only: never the importer, reviews, bindings, identity, receipts, versions, the taxonomy's files,
    // plan, import or worklist, or the domain's index; no retail operator command; no converter.
    expect(loaded.filter((file) => file.startsWith('services/retail/') && !RETAIL_READ_MODULES.includes(file))).toEqual([]);
    expect(loaded.filter((file) => RETAIL_WRITE_MODULES.includes(file))).toEqual([]);
    expect(loaded.filter((file) => /^cli\/retail/.test(file))).toEqual([]);
    expect(loaded.filter((file) => /^shared\/retailImportTool\/(?:index|costco)\.ts$|\/__fixtures__\//.test(file))).toEqual([]);
    const mentions = [...files].filter(([file]) => !sourcePath(file).startsWith('shared/')).flatMap(([file, source]) =>
      moduleSpecifiers(source, true).filter((specifier) => /retail-import-tool|retailImportTool|retailConvert|(?:^|\/)cli\/retail/.test(specifier))
        .map((specifier) => `${sourcePath(file)} -> ${specifier}`));
    expect(mentions).toEqual([]);
    // Beyond the Spending route helpers it shares with every card route (routes/cardSpending.ts's errors and query checks,
    // routes/cardTransactions.ts's title guard: modules the Spending mount loads at boot anyway), the route reaches nothing
    // of an operator command.
    const helpers = [...files].filter(([file]) => own.includes(sourcePath(file))).flatMap(([file, source]) => moduleSpecifiers(source)
      .filter((specifier) => specifier.startsWith('.')).map((specifier) => path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'))))
      .filter((file) => /^routes\/[^/]+\.ts$/.test(sourcePath(file)) && sourcePath(file) !== 'routes/retail.ts');
    const shared = new Set(helpers.flatMap((helper) => [...moduleClosure(helper, { shared: true }).files.keys()]));
    const reached = [...files.keys()].filter((file) => !shared.has(file)).map(sourcePath);
    expect(reached.filter((file) => file.startsWith('cli/'))).toEqual([]);
    expect(reached).toEqual(expect.arrayContaining(own));

    // No module it loads (but the schema declaration, which holds the install DDL) writes a retail table.
    const retailWrite = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|CREATE\s+(?:UNIQUE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+["'`[]?(?:main\.)?retail_/;
    expect([...files].filter(([file, source]) => sourcePath(file) !== 'services/retail/schema.ts' && retailWrite.test(source)).map(([file]) => sourcePath(file)))
      .toEqual([]);
    // The route and its read model hold no write statement of any kind, and never run or execute one.
    const anyWrite = /\b(?:INSERT\s|REPLACE\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+(?:UNIQUE\s+|TEMP\w*\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|VACUUM\b|ATTACH\s|DETACH\s)|\.(?:exec|run)\(/;
    expect([...files].filter(([file, source]) => own.includes(sourcePath(file)) && anyWrite.test(source)).map(([file]) => sourcePath(file))).toEqual([]);
  });
});
