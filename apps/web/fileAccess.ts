import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isFileLoadingAllowed, normalizePath, type Connect, type Plugin, type ResolvedConfig } from 'vite';
import { guardHttpDispatch, parseRequestTarget } from './requestTarget';

const cleanUrl = (url: string) => url.replace(/[?#].*$/, '');
// plugin-react uses an absolute-looking virtual ID, not a file on disk.
const isFileId = (id: string) => path.isAbsolute(cleanUrl(id)) && id !== '/@react-refresh';

function inside(file: string, directory: string) {
  const relative = path.relative(directory, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function realPath(file: string) {
  try {
    return realpathSync(file);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function isDirectory(file: string) {
  try {
    return statSync(file).isDirectory();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

function allowed(config: ResolvedConfig, file: string) {
  const permits = (candidate: string) =>
    config.server.fs.allow.some((directory) => inside(candidate, directory))
    && isFileLoadingAllowed(config, normalizePath(candidate));
  if (!permits(file)) return false;
  const canonical = realPath(file);
  return canonical === undefined || permits(canonical);
}

export function fileAccessBoundary(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'holdr-file-access-boundary',
    apply: 'serve',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      if (server.httpServer && 'headersTimeout' in server.httpServer) {
        const http = server.httpServer as typeof server.httpServer & { connectionsCheckingInterval?: number };
        // Bound slow headers without shortening the existing body-upload timeout.
        http.headersTimeout = Math.min(http.headersTimeout || 20_000, http.requestTimeout || 20_000, 20_000);
        http.connectionsCheckingInterval = Math.min(http.connectionsCheckingInterval || 1000, 1000);
      }
      const hmr = typeof config.server.hmr === 'object' ? config.server.hmr : undefined;
      const sharedHmr = config.server.hmr !== false
        && (!hmr?.server || hmr.server === server.httpServer)
        && (!hmr?.port || hmr.port === config.server.port);
      if (server.httpServer) guardHttpDispatch(server.httpServer, {
        hmrPath: sharedHmr ? (hmr?.path ? path.posix.join(config.base, hmr.path) : config.base) : undefined,
      });
      // Node routes CONNECT to this event, not through Connect's HTTP middleware.
      server.httpServer?.on('connect', (_req, socket) => {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      });
      const guard: Connect.NextHandleFunction = async (req, res, next) => {
        const reject = (status = 403) => {
          res.statusCode = status;
          res.end();
        };
        try {
          // Connect extracts paths from absolute targets; never let one reach any routing or decoding.
          const originalTarget = req.originalUrl ?? req.url;
          const parsed = parseRequestTarget(req.url);
          if (!parsed || (originalTarget !== req.url && !parseRequestTarget(originalTarget))) return reject();
          const query = parsed.query;
          // Make the only supported directory entry explicit before sirv can choose "index".
          const pathname = parsed.pathname === '/' && ['GET', 'HEAD'].includes(req.method ?? '')
            ? '/index.html' : parsed.pathname;
          if (pathname !== parsed.pathname) req.url = pathname + query;
          const isId = pathname.startsWith('/@id/');
          const id = isId ? pathname.slice('/@id/'.length).replace('__x00__', '\0') : pathname;
          const isFs = id.startsWith('/@fs/');
          const file = isFs
            ? path.resolve('/', id.slice('/@fs/'.length))
            : isId
              ? (path.isAbsolute(id) ? path.normalize(id) : undefined)
              : path.resolve(config.root, `.${pathname}`);
          if (file && (!allowed(config, file) || isDirectory(file))) return reject();

          // publicDir is unused and disabled; do not turn its old URLs into successful SPA responses.
          if (!isId && !isFs && !config.publicDir && file && !existsSync(file)
            && existsSync(path.resolve(config.root, 'public', `.${pathname}`))) return reject(404);

          const resolved = await server.environments.client.pluginContainer.resolveId(id + query);
          if (resolved && isFileId(resolved.id)
            && (!allowed(config, cleanUrl(resolved.id)) || isDirectory(cleanUrl(resolved.id)))) return reject();
          if (isId && !resolved) return reject(404);
          next();
        } catch {
          reject();
        }
      };
      // Connect's root mount skips "*"; this mount rewrites req.url, so also check originalUrl.
      server.middlewares.use('*', guard);
      server.middlewares.use(guard);
      // Vite 6 rewrites extensionless/directory SPA URLs before configureServer's post hooks.
      return () => { server.middlewares.use(guard); };
    },
    load(id) {
      const file = cleanUrl(id);
      // Vite follows symlinks and automatically trusts imported safeModulePaths. Neither may expand our roots.
      if (isFileId(id) && existsSync(file) && !allowed(config, file)) {
        this.error({ code: 'HOLDR_FILE_ACCESS_DENIED', message: 'File access outside the frontend boundary is forbidden' });
      }
    },
  };
}
