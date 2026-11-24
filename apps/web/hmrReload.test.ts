import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadConfigFromFile } from 'vite';

import { normalizePath } from 'vite';
import {
  STATEFUL_MODULES,
  statefulFiles,
  statefulInvalidatedAt,
  statefulModuleReached,
  statefulUrlSet,
  updateReplacesState,
  type GraphNode,
  type HotUpdateEntry,
} from './hmrReload';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const source = (file: string) => readFileSync(path.join(webRoot, file), 'utf8');

/**
 * Modules flagged below that may be hot-swapped, and why: their module-level state is safe to lose,
 * or what the check flags holds none. Everything else holding state must be in STATEFUL_MODULES.
 */
const HOT_SWAPPABLE_STATE: Record<string, string> = {
  'src/components/PerformancePanel.tsx':
    'loadedReports: each report keeps the store operation it was fetched under and counts only while that is current, and page retirement clears it; a new copy of the module starts with an empty map',
  'src/components/spending/spendingFormat.ts':
    'no state: NAME_SMALL_WORDS, NAME_SHORT_WORDS, NAME_ABBREVIATIONS and NAME_COMPANY_FORMS are constant sets and the rest are constant tables, only read; its maps are local to functions',
  'src/components/spending/sync/BindingEditor.tsx': 'no state: SYNC_ISSUERS is a constant set, only read',
  'src/components/spending/sync/OwnerActions.tsx':
    'no state: Context is a React context object and the provider keeps its state in React; a new copy of the module brings its own provider, hooks and ActionCancelled together',
  'src/components/spending/sync/fake/ledgerSeed.ts': 'no state: SOURCE_MOVES and VALUE_CHANGES are constant sets, only read',
  'src/components/spending/sync/ownerClient.ts':
    'no state: IDENTITY_EVENTS, MERGE_EVENTS and REVERSIBLE_EVENTS are constant sets, only read; clients come from loadOwnerClient, and useOwnerSync loads a new one when a hot update re-runs its effects',
  'src/components/spending/sync/syncFormat.ts': 'no state: MAIN_WORLD_ISSUERS is a constant set, only read',
  'src/components/spending/sync/syncStatus.ts': 'no state: OPEN is a constant set, only read',
  'src/modes/useModeRoute.ts':
    'leftAt, lastRoutes and the entry bookkeeping: where each history entry was left and which section each mode showed, no server data, auth or tokens. Its listeners and any scroll restore belong to effects that a hot update re-runs (through App.tsx), so nothing of the old copy keeps running; a new copy starts without the scroll places recorded before it',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(webRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    // `src/…` with `/` on every platform, as STATEFUL_MODULES and HOT_SWAPPABLE_STATE write them.
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [file] : [];
  });
}

/** Top-level declarations that keep state for the module's lifetime. */
const MODULE_STATE = /^(?:export )?(?:(?:let|var)\s|const \w+(?:\s*:[^=]+)?\s*=\s*(?:new (?:Map|Set|WeakMap|WeakSet)\b|create\w*\s*[<(]|signOutLedger\())/m;

test('every module with module-level state is never hot-swapped, or explicitly allowed to be', () => {
  const files = sourceFiles('src');
  // An empty list passes the check below: sourceFiles() must find the web sources, and MODULE_STATE state in them.
  assert.ok(files.length >= 50, `only ${files.length} source files found under src/`);
  for (const file of ['src/stores/auth.ts', 'src/stores/portfolio.ts', 'src/services/api.ts']) {
    assert.ok(files.includes(file), `${file} is not among the ${files.length} source files found`);
  }
  const withState = files.filter((file) => MODULE_STATE.test(source(file)));
  assert.ok(withState.length > 0, `MODULE_STATE matches none of the ${files.length} source files`);
  const unlisted = withState.filter((file) => !(STATEFUL_MODULES as readonly string[]).includes(file) && !(file in HOT_SWAPPABLE_STATE));
  assert.deepEqual(unlisted, [], 'add these to STATEFUL_MODULES (hmrReload.ts) or HOT_SWAPPABLE_STATE with a reason');
});

test('every stateful module guards itself: its dispose retires the page first, then it reloads', () => {
  for (const file of STATEFUL_MODULES) {
    const code = source(file);
    // Vite only sees a literal `import.meta.hot.accept(`; optional chaining would hide it.
    assert.doesNotMatch(code, /import\.meta\.hot\?\./, `${file}: Vite does not detect optional chaining`);
    const guard = /if \(import\.meta\.hot\) \{\s*import\.meta\.hot\.dispose\(\(\) => (retire\w+Module)\(\)\);\s*import\.meta\.hot\.accept\(\(\) => window\.location\.reload\(\)\);\s*\}/.exec(code);
    assert.ok(guard, `${file}: dispose -> retire...Module(), accept -> reload`);
    // That dispose retires the whole page before it removes anything of its own.
    const dispose = new RegExp(`export function ${guard[1]}\\([^)]*\\): void \\{\\s*retirePage\\(\\);`);
    assert.match(code, dispose, `${file}: ${guard[1]}() starts with retirePage()`);
  }
});

const entry = (path: string, acceptedPath = path, timestamp = 1): HotUpdateEntry => ({ path, acceptedPath, timestamp });
const STATEFUL_URLS = new Set(STATEFUL_MODULES.map((file) => `/${file}`));

test('an update message that would evaluate a stateful module again goes out as a full reload', () => {
  const none = () => false;
  assert.equal(updateReplacesState([entry('/src/stores/auth.ts')], STATEFUL_URLS, none), true, 'a stateful boundary');
  assert.equal(updateReplacesState([entry('/src/App.tsx', '/src/services/api.ts')], STATEFUL_URLS, none), true, 'a module accepting a stateful dependency');
  assert.equal(updateReplacesState([entry('/src/stores/portfolio.ts?import')], STATEFUL_URLS, none), true, 'with a query');
  assert.equal(updateReplacesState([entry('/src/components/Tabs.tsx'), entry('/src/stores/storeOp.ts')], STATEFUL_URLS, none), true, 'any entry');
  assert.equal(updateReplacesState([entry('/src/components/LoginScreen.tsx', '/src/components/LoginScreen.tsx', 7)], STATEFUL_URLS, (t) => t === 7), true,
    'an update that invalidated a stateful module without making it a boundary');
  assert.equal(updateReplacesState([entry('/src/components/LoginScreen.tsx')], STATEFUL_URLS, none), false);
  assert.equal(updateReplacesState([entry('/src/App.tsx', '/src/components/Tabs.tsx')], STATEFUL_URLS, none), false);
});

function graph(edges: Record<string, string[]>): Map<string, GraphNode & { importers: GraphNode[] }> {
  const nodes = new Map<string, GraphNode & { importers: GraphNode[] }>();
  const node = (file: string) => {
    if (!nodes.has(file)) nodes.set(file, { file: `/web/${file}`, importers: [] });
    return nodes.get(file)!;
  };
  for (const [file, importers] of Object.entries(edges)) node(file).importers.push(...importers.map(node));
  return nodes;
}

test('a change reaches a stateful module through any chain of importers, past boundaries too', () => {
  const nodes = graph({
    'src/services/quotes.ts': ['src/stores/portfolio.ts'],
    'src/stores/portfolio.ts': ['src/stores/auth.ts', 'src/App.tsx'],
    'src/stores/auth.ts': ['src/App.tsx', 'src/components/LoginScreen.tsx'],
    'src/components/LoginScreen.tsx': ['src/App.tsx'],
    'src/components/Tabs.tsx': ['src/App.tsx'],
    'src/App.tsx': ['src/main.tsx'],
    'shared/index.ts': ['src/components/Tabs.tsx', 'src/stores/portfolio.ts'],
  });
  const stateful = new Set(STATEFUL_MODULES.map((file) => `/web/${file}`));
  const reached = (file: string) => statefulModuleReached([nodes.get(file)!], stateful);
  assert.equal(reached('src/stores/auth.ts'), '/web/src/stores/auth.ts');
  assert.equal(reached('src/services/quotes.ts'), '/web/src/stores/portfolio.ts');
  assert.equal(reached('shared/index.ts'), '/web/src/stores/portfolio.ts');
  assert.equal(reached('src/components/LoginScreen.tsx'), null, 'a component using the stores is not imported by them');
  assert.equal(reached('src/components/Tabs.tsx'), null);
  assert.equal(reached('src/App.tsx'), null);
});

test('a dependency cycle does not keep the walk going', () => {
  const nodes = graph({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
  assert.equal(statefulModuleReached([nodes.get('a.ts')!], new Set(['/web/src/stores/auth.ts'])), null);
});

test('stateful files are keyed as Vite keys its module graph, so invalidation finds them on Windows too', () => {
  const files = statefulFiles(webRoot);
  // Vite's normalizePath(): `/` on every platform (`C:/…` on Windows). A `C:\…` key fails here on win32.
  const auth = [...files].find((file) => file.endsWith('/src/stores/auth.ts'));
  assert.ok(auth, [...files].join(', '));
  assert.doesNotMatch(auth, /\\/);
  assert.equal(statefulModuleReached([{ file: auth, importers: [] }], files), auth);
  // A module graph keyed as Vite keys it, with auth.ts invalidated by the update stamped 7. On win32
  // Vite 6.4.2 resolves a file with fs.realpathSync() (the case as spelled) until its `net use` probe
  // answers, and with fs.realpathSync.native() (the case on disk) after that. This file's path follows
  // the spelling Node was started with, so the two keys differ when that is not the case on disk.
  const authFile = path.join(webRoot, 'src', 'stores', 'auth.ts');
  const viteKeys = process.platform === 'win32' ? [realpathSync(authFile), realpathSync.native(authFile)] : [authFile];
  for (const key of viteKeys.map((file) => normalizePath(file))) {
    const modules = new Map([[key, [{ lastHMRTimestamp: 7 }]]]);
    const graph = { getModulesByFile: (file: string) => modules.get(file) };
    assert.equal(statefulModuleReached([{ file: key, importers: [] }], files), key, `the walk, keyed ${key}`);
    assert.equal(statefulInvalidatedAt(graph, files, 7), true, `an update that invalidated auth.ts, keyed ${key}`);
    assert.equal(statefulInvalidatedAt(graph, files, 8), false, 'another update');
  }
  assert.equal(statefulInvalidatedAt({ getModulesByFile: () => undefined }, files, 7), false, 'a file Vite has no module for');
});

/**
 * Runs hmrReload.ts as on Windows, on any host: a worker thread sets process.platform to 'win32'
 * before it loads Vite, which reads it once as it loads, so normalizePath() there turns `\` into `/`.
 * The start nodes reach the worker by structured clone, importers and all. It posts back
 * normalizePath(webRoot), the stateful files under webRoot and what the walk from each start reached.
 */
const WALK_ON_WINDOWS = `
const { createRequire } = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
// The inherited --import tsx registers its ESM loader on the main thread only: register it here, or
// hmrReload.ts loads only where Node strips types itself (not on Node 20).
createRequire(workerData.hmrReload)('tsx/esm/api').register();
// Vite imports rollup, whose native parser is chosen by process.platform as it loads: load this host's first.
createRequire(workerData.vite)('rollup/parseAst');
if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32' });
Promise.all([import(workerData.vite), import(workerData.hmrReload)]).then(([{ normalizePath }, { statefulFiles, statefulModuleReached }]) => {
  const stateful = statefulFiles(workerData.webRoot);
  parentPort.postMessage({
    root: normalizePath(workerData.webRoot),
    stateful: [...stateful],
    reached: workerData.starts.map((start) => statefulModuleReached([start], stateful)),
  });
});
`;

type WindowsWalk = { root: string; stateful: string[]; reached: (string | null)[] };

async function walkOnWindows(webRoot: string, starts: GraphNode[]): Promise<WindowsWalk> {
  const worker = new Worker(WALK_ON_WINDOWS, {
    eval: true,
    workerData: { vite: import.meta.resolve('vite'), hmrReload: new URL('hmrReload.ts', import.meta.url).href, webRoot, starts },
  });
  try {
    return await new Promise<WindowsWalk>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`the worker exited with code ${code} and no result`)));
    });
  } finally {
    await worker.terminate();
  }
}

test('on Windows a change reaches a stateful module however its file is written: backslashes, mixed separators, dot segments', async () => {
  // Windows spellings of module files, under webRoot as fileURLToPath() gives it there (`\` at the end). One
  // drive-letter spelling throughout: normalizePath() rewrites separators and dot segments, not case.
  const node = (file: string): GraphNode & { importers: GraphNode[] } => ({ file, importers: [] });
  const main = node('C:\\Holdr\\apps\\web\\src\\main.tsx');
  const app = node('C:\\Holdr\\apps\\web\\src\\App.tsx');
  const login = node('C:\\Holdr\\apps\\web\\src\\components\\LoginScreen.tsx');
  const auth = node('C:\\Holdr\\apps\\web\\src\\stores\\auth.ts');
  const portfolio = node('C:\\Holdr\\apps\\web/src/stores\\portfolio.ts');
  const api = node('C:\\Holdr\\apps\\web\\src\\components\\..\\services\\.\\api.ts');
  const quotes = node('C:\\Holdr\\apps\\web\\src\\services\\quotes.ts');
  const shared = node('C:\\Holdr\\packages\\shared\\src\\index.ts');
  app.importers.push(main);
  login.importers.push(app);
  auth.importers.push(app, login);
  portfolio.importers.push(auth, app);
  quotes.importers.push(portfolio);
  api.importers.push(auth, portfolio);
  shared.importers.push(login, api);

  const windows = await walkOnWindows('C:\\Holdr\\apps\\web\\', [auth, quotes, shared, login]);
  assert.equal(windows.root, 'C:/Holdr/apps/web/', 'Vite in the worker does not run as on Windows');
  // C:\Holdr does not exist on the host (on POSIX it is not even an absolute path), so
  // fs.realpathSync.native() fails and statefulFiles() keys the root as spelled only.
  assert.deepEqual(windows.stateful, STATEFUL_MODULES.map((file) => `C:/Holdr/apps/web/${file}`), 'stateful files keyed as Vite keys them');
  const [fromAuth, fromQuotes, fromShared, fromLogin] = windows.reached;
  assert.equal(fromAuth, auth.file, 'a stateful module written with \\');
  assert.equal(fromQuotes, portfolio.file, 'an importer written with mixed separators');
  assert.equal(fromShared, api.file, 'an importer written with dot segments, past one that is not stateful');
  assert.equal(fromLogin, null, 'a component using the stores is not imported by them');
});

test('on Windows the stateful files and URLs include Vite\'s however the dev server\'s directory is spelled', {
  skip: process.platform !== 'win32' && 'drive-letter case, directory case and junctions are win32 spellings',
}, () => {
  // A root whose last directory is `Web` on disk (the rest as on disk too), reached as spelled, with a
  // lowercase drive letter, all in lowercase, and through a junction (which needs no privileges).
  const scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'holdr-hmr-')));
  const root = path.join(scratch, 'Web');
  const junction = path.join(scratch, 'link');
  mkdirSync(root);
  symlinkSync(root, junction, 'junction');
  try {
    for (const spelled of [root, root[0].toLowerCase() + root.slice(1), root.toLowerCase(), junction]) {
      const files = statefulFiles(spelled);
      const urls = statefulUrlSet(spelled);
      for (const file of STATEFUL_MODULES) {
        // Vite after its `net use` probe: the real path (case on disk), as `/@fs/<file>` under a root spelled otherwise.
        const onDisk = normalizePath(path.join(root, file));
        assert.ok(files.has(onDisk), `${spelled}: ${onDisk} is not among ${[...files].join(', ')}`);
        assert.ok(urls.has(`/@fs/${onDisk}`), `${spelled}: /@fs/${onDisk}`);
        assert.equal(updateReplacesState([entry(`/@fs/${onDisk}`)], urls, () => false), true, `${spelled}: an update of /@fs/${onDisk}`);
        // Vite before it, or without `net use`: fs.realpathSync() resolves the junction but keeps the case as spelled.
        const asSpelled = normalizePath(path.join(realpathSync(spelled), file));
        assert.ok(files.has(asSpelled), `${spelled}: ${asSpelled} is not among ${[...files].join(', ')}`);
        assert.ok(urls.has(`/${file}`), `${spelled}: /${file}`);
      }
    }
  } finally {
    rmdirSync(junction); // the junction itself, never what it points to
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the dev server config loads the reload plugin', async () => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(webRoot, 'vite.config.ts'), webRoot, 'silent');
  const names = (loaded?.config.plugins ?? []).flat().map((plugin) => (plugin && typeof plugin === 'object' && 'name' in plugin ? plugin.name : null));
  assert.ok(names.includes('holdr-reload-instead-of-hot-swap'), String(names));
});
