import { realpathSync } from 'node:fs';
import path from 'node:path';
import { normalizePath, type HotPayload, type Plugin } from 'vite';

/**
 * Web modules that hold auth, portfolio, sign-out-ledger or cache state, or store-operation tokens
 * (paths relative to apps/web). They are never hot-swapped.
 *
 * On a change, Vite re-evaluates the changed module and every importer up to the nearest module
 * that accepts the update (React Fast Refresh makes App.tsx and the components such boundaries),
 * without reloading the page. One of these modules re-evaluated that way would run as a second
 * instance next to the first: its own stores, listeners and tokens, while the old instance's
 * pending requests can still complete and nothing would reset its store.
 *
 * apps/web/hmrReload.test.ts checks that every source module with module-level state is listed here
 * or explicitly allowed, and that each module listed here guards itself (see below).
 */
export const STATEFUL_MODULES = [
  'src/stores/auth.ts',
  'src/stores/portfolio.ts',
  'src/stores/storeOp.ts',
  'src/services/browserCache.ts',
  'src/services/api.ts',
  'src/services/symbolHistoryCache.ts',
] as const;

/** The part of Vite's module graph this needs: a file and the modules that import it. */
export interface GraphNode {
  file?: string | null;
  importers: Iterable<GraphNode>;
}

/**
 * The stateful modules' files under `webRoot`, keyed as Vite keys its module graph: normalizePath(),
 * which writes `/` on every platform (`C:/…` on Windows). On POSIX that is path.normalize() alone.
 *
 * On win32 the dev server's directory can be spelled unlike the disk: another drive-letter or
 * directory case, or a junction. Vite 6.4.2 there resolves module files with fs.realpathSync(),
 * which resolves junctions but keeps the case as spelled, until its asynchronous `net use` probe
 * answers, and with fs.realpathSync.native(), which also gives the case on disk, after that. If
 * `net use` fails, it never switches. So on win32 each file is keyed both ways: under `webRoot` as
 * spelled and under its real path (onDiskRoot()).
 */
export function statefulFiles(webRoot: string): Set<string> {
  const roots = [webRoot, onDiskRoot(webRoot)];
  return new Set(roots.flatMap((root) => STATEFUL_MODULES.map((file) => normalizePath(path.join(root, file)))));
}

/**
 * On win32, `webRoot` as Vite's resolver writes module files once its `net use` probe has answered:
 * fs.realpathSync.native(), with the drive letter and every directory in their on-disk case and
 * junctions resolved. `webRoot` itself if that fails (a root that does not exist), and on POSIX.
 */
function onDiskRoot(webRoot: string): string {
  if (process.platform !== 'win32') return webRoot;
  try {
    return realpathSync.native(webRoot);
  } catch {
    return webRoot;
  }
}

/**
 * The URLs of the stateful modules, which the update gate compares. Vite serves a file as `/src/…`
 * when its path starts with the root as spelled (compared case-sensitively), and as `/@fs/<file>`
 * otherwise. On win32 a root spelled unlike the disk, or reached through a junction, is not a prefix
 * of the files' real paths, so the set there also holds `/@fs/<file>` for each of statefulFiles().
 */
export function statefulUrlSet(webRoot: string): Set<string> {
  const urls = STATEFUL_MODULES.map((file) => `/${file}`);
  if (process.platform === 'win32') urls.push(...[...statefulFiles(webRoot)].map((file) => path.posix.join('/@fs/', file)));
  return new Set(urls);
}

/**
 * The first stateful module that a hot update of `changed` could re-evaluate, or null. It walks
 * every importer, past modules that accept updates too: more than Vite's propagation, which stops
 * at those, so it may reload where a hot update would have been safe, never the other way round.
 * `stateful` holds normalizePath() files (statefulFiles()).
 */
export function statefulModuleReached(changed: Iterable<GraphNode>, stateful: ReadonlySet<string>): string | null {
  const seen = new Set<GraphNode>();
  const queue = [...changed];
  for (let node = queue.shift(); node; node = queue.shift()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.file && stateful.has(normalizePath(node.file))) return node.file;
    queue.push(...node.importers);
  }
  return null;
}

/** The part of Vite's module graph that invalidation needs: the modules of a file, by normalizePath() file. */
export interface ModulesByFile {
  getModulesByFile(file: string): Iterable<{ lastHMRTimestamp: number }> | null | undefined;
}

/**
 * Whether the update stamped `timestamp` invalidated a stateful module (one that is not its
 * boundary). `stateful` must hold Vite's own keys (statefulFiles()): a `C:\…` key never finds a
 * module on Windows, so that reload would never fire there.
 */
export function statefulInvalidatedAt(graph: ModulesByFile, stateful: ReadonlySet<string>, timestamp: number): boolean {
  return [...stateful].some((file) => [...(graph.getModulesByFile(file) ?? [])].some((mod) => mod.lastHMRTimestamp === timestamp));
}

/** One entry of an HMR `update` message: the boundary module and the module it accepted. */
export interface HotUpdateEntry {
  path: string;
  acceptedPath: string;
  timestamp: number;
}

/**
 * Whether an `update` message would make the browser evaluate a stateful module again. Every
 * stateful module accepts its own updates (hmrReload.test.ts checks this), so Vite's propagation
 * stops at it: it can only be re-evaluated as a boundary or an accepted module of the message. A
 * stateful module that the update invalidated without making it a boundary is refused as well,
 * since a later update of one of its importers would load the new copy.
 */
export function updateReplacesState(
  updates: readonly HotUpdateEntry[],
  statefulUrls: ReadonlySet<string>,
  invalidatedAt: (timestamp: number) => boolean,
): boolean {
  const stateful = (url: string) => statefulUrls.has(url.split('?')[0]);
  return updates.some((update) => stateful(update.path) || stateful(update.acceptedPath) || invalidatedAt(update.timestamp));
}

/**
 * Turns every hot update that would re-evaluate a stateful module into a full page reload, before
 * Vite sends anything to the browser. Vite 6 ignores import.meta.hot.decline() (a no-op kept for
 * compatibility), so this cannot be left to the modules. In Vite 6.4.2 four paths lead to its
 * updateModules():
 *  1. file changes (the watcher, through handleHMRUpdate): the hotUpdate hook below. The watcher
 *     has already invalidated the file's modules (moduleGraph.onFileChange) when the hook runs;
 *  2. server.reloadModule(module), which skips plugin hooks;
 *  3. server.environments.client.reloadModule(module), likewise;
 *  4. a browser's import.meta.hot.invalidate() ('vite:invalidate'), likewise.
 * Every update any of them produces reaches the browser through the client environment's
 * hot.send (the WebSocket server itself), which is gated: an update that would re-evaluate a
 * stateful module goes out as a full reload. Paths 2 and 3 still run Vite's own reloadModule()
 * first, which invalidates the module and its importers exactly as Vite does, so the reloaded page
 * gets the new code; if that sends no reload (nothing to update yet), the wrapper sends one. Each
 * stateful module also accepts its own updates, only to retire the page (dispose) and reload it,
 * in case an update ever reaches one some other way.
 */
export function reloadInsteadOfHotSwap(webRoot: string): Plugin {
  const stateful = statefulFiles(webRoot);
  const statefulUrls = statefulUrlSet(webRoot);
  return {
    name: 'holdr-reload-instead-of-hot-swap',
    apply: 'serve',
    enforce: 'pre',
    hotUpdate({ file, modules }) {
      if (this.environment.name !== 'client') return undefined;
      const reached = statefulModuleReached(modules, stateful);
      if (!reached) return undefined;
      this.environment.logger.info(
        `page reload ${path.relative(webRoot, file)} (reaches ${path.relative(webRoot, reached)}, which is never hot-swapped)`,
        { timestamp: true },
      );
      this.environment.hot.send({ type: 'full-reload' });
      return [];
    },
    configureServer(server) {
      const client = server.environments.client;
      const send = client.hot.send.bind(client.hot) as (...args: unknown[]) => void;
      /** Full reloads sent to the browser so far, by Vite or by this plugin. */
      let fullReloads = 0;
      const reloadPage = (why: string) => {
        fullReloads += 1;
        client.logger.info(`page reload ${why}, which is never hot-swapped`, { timestamp: true });
        send({ type: 'full-reload' } satisfies HotPayload);
      };

      // Vite keys its module graph by normalizePath() files: statefulFiles() are those keys (E8-M found
      // that a `C:\…` key never matched on a Windows dev server, so this reload never fired there).
      const invalidatedAt = (timestamp: number) => statefulInvalidatedAt(client.moduleGraph, stateful, timestamp);
      client.hot.send = ((...args: unknown[]) => {
        const payload = args[0] as HotPayload | string;
        if (typeof payload === 'object' && payload.type === 'update' && updateReplacesState(payload.updates, statefulUrls, invalidatedAt)) {
          return reloadPage(`(update of ${payload.updates.map((update) => update.path).join(', ')})`);
        }
        if (typeof payload === 'object' && payload.type === 'full-reload') fullReloads += 1;
        return send(...args);
      }) as typeof client.hot.send;

      // Vite's own reloadModule() runs first: it invalidates the module and its importers, then sends
      // its update through the gate above, which turns it into a full reload.
      const throughGate = <Module extends GraphNode>(reloadModule: (module: Module) => Promise<void>) => (
        async (module: Module) => {
          const reached = statefulModuleReached([module], stateful);
          const sentBefore = fullReloads;
          await reloadModule(module);
          if (reached && fullReloads === sentBefore) reloadPage(`(reloadModule reaches ${path.relative(webRoot, reached)})`);
        }
      );
      server.reloadModule = throughGate(server.reloadModule.bind(server));
      client.reloadModule = throughGate(client.reloadModule.bind(client));
    },
  };
}
