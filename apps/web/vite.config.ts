import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileAccessBoundary } from './fileAccess';
import { reloadInsteadOfHotSwap } from './hmrReload';
import {
  isFunnelRequest,
  isLocalClient,
  isTailnetClient,
  parsePublicOriginHostname,
  parseTailnetAddresses,
  parseTailnetHostname,
} from './localNetwork';
import { API_PROXY_CONTEXT, DEFAULT_API_TARGET, createApiProxy } from './apiProxy';
import { resolveLanHttpsConfig } from '../../packages/shared/src/lanHttps';

const apiTarget = process.env.HOLDR_API_TARGET ?? DEFAULT_API_TARGET;
const localHostname = `${os.hostname().toLowerCase().replace(/\.local$/, '')}.local`;
const tailnetAddresses = parseTailnetAddresses(process.env.HOLDR_TAILNET_ADDRESSES);
const tailnetHostnames = parseTailnetHostname(process.env.HOLDR_TAILNET_HOSTNAME);
const publicHostnames = parsePublicOriginHostname(process.env.HOLDR_PUBLIC_ORIGIN);
const lanHttps = resolveLanHttpsConfig(process.env);
const allowedHosts = [localHostname, ...tailnetHostnames, ...publicHostnames, ...(lanHttps ? [lanHttps.ip] : [])];

/** The dev server's and the preview server's network guards: loopback or the pinned tailnet only, and never Funnel. */
function guardLocalNetwork(server: { httpServer: import('node:http').Server | import('node:http2').Http2SecureServer | null; middlewares: import('vite').Connect.Server }): void {
  server.httpServer?.prependListener('connection', (socket: import('node:net').Socket) => {
    if (!isLocalClient(socket.remoteAddress) && !isTailnetClient(socket.remoteAddress, socket.localAddress, tailnetAddresses)) socket.destroy();
  });
  // Runs before Vite's own middlewares, the API proxy included.
  server.middlewares.use((req, res, next) => {
    if (!isFunnelRequest(req.headers)) return next();
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Holdr is not available over Tailscale Funnel.\n');
  });
}

export default defineConfig({
  publicDir: false,
  // Auth, portfolio and ledger modules are never hot-swapped: an update to them reloads the page.
  plugins: [fileAccessBoundary(), reloadInsteadOfHotSwap(__dirname), react(), {
    name: 'holdr-local-network',
    configureServer: guardLocalNetwork,
    configurePreviewServer: guardLocalNetwork,
  }],
  resolve: {
    alias: [{
      find: /^@finance-tracker\/shared$/,
      replacement: path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    }],
  },
  build: {
    // Every asset (the fonts in src/fonts.css included) is its own fingerprinted file, never a data: URL,
    // which the planned font-src/img-src 'self' policy would refuse.
    assetsInlineLimit: 0,
  },
  server: {
    // Loopback only. Other devices use https://<machine>.<tailnet>.ts.net through
    // Tailscale Serve; scripts/start-finance-mac.sh passes --host :: only for the
    // plain-HTTP HOLDR_LAN_HTTP=1 opt-in.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts,
    // Same-origin app: no page on another origin needs to read dev-server or API responses.
    cors: false,
    fs: {
      strict: true,
      allow: [
        __dirname,
        path.resolve(__dirname, '../../packages/shared'),
        path.resolve(__dirname, '../../node_modules'),
        ...[path.resolve(__dirname, 'node_modules')].filter(existsSync),
      ],
      // Vite matches absolute paths: patterns containing "/" need an explicit "**/" prefix.
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
        '**/apps/api/data/**', '**/node_modules/@finance-tracker/api/**',
        '*.db', '*.db-*', '*.sqlite*', 'service-token*', 'state.json*',
        '*.tgz', '*.tar.gz', '*.zip',
        '**/backups/**', '**/.e2e-tmp/**', '**/.e2e-logs/**',
        '**/profiles/**', '**/holdr-logs/**', '*.log',
        '**/test-results/**', '**/playwright-report/**', '**/blob-report/**', '.last-run.json',
        '**/.turbo/**', '**/.expo/**', '**/.next/**',
        '**/apps/web/public/**',
      ],
    },
    // Every API route goes through this one proxy; the browser never talks to the API port.
    proxy: {
      [API_PROXY_CONTEXT]: createApiProxy(apiTarget),
    },
  },
  // `vite preview` serves a built bundle (apps/web/dist) with the dev server's guards: loopback, the same allowed hosts,
  // the same API proxy, and no Funnel. scripts/start-local.mjs uses it on Windows and macOS alike.
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts,
    cors: false,
    proxy: {
      [API_PROXY_CONTEXT]: createApiProxy(apiTarget),
    },
  },
});
