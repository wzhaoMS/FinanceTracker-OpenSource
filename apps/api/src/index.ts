import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import {
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  USER_CLI_COMMAND,
  isLoopbackHost,
  parseAllowedOrigins,
  parsePublicOrigin,
} from './auth/http.js';
import { SERVICE_TOKEN_FILE_NAME, loadOrCreateServiceToken } from './auth/serviceToken.js';
import { AGENT_TOKEN_FILE_NAME, loadOrCreateAgentToken } from './auth/agentToken.js';
import { HoldrDbError, errorTypeAndCode, isDatabaseFailure } from './services/dbErrors.js';
import { migrateJsonToSqlite } from './services/migrateState.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { createSnapshotJob, listenerLeaseHolder, startSnapshotScheduler } from './services/snapshotJob.js';
import { fetchSessionIntradayBars, fetchWeekIntradayBars } from './providers/intradayBars.js';
import { fetchMetalSpotDailyBars, metalsPricesEnabled } from './providers/metalSpotBars.js';
import { metalsEstimateUnmatchedOf, metalsFungibleOf } from './services/metalsRead/policy.js';
import { createStoredQuoteFetcher, marketDataModeOf, type MarketDataMode } from './services/storedMarketData.js';
import { startCardSyncRetention } from './services/cardSyncRetentionScheduler.js';
import { resolveDataPaths } from './dataDir.js';
import type { E2eDataDir } from './e2e/runIdentity.js';
import { resolveIngressConfig } from './ingress/config.js';
import { resolveLanHttpsConfig } from '@finance-tracker/shared/lan-https';
import { admitDeviceRequest, deviceApiConfigured } from './ingress/deviceAdmission.js';
import { prepareIngress } from './ingress/startupChecks.js';
import { startIngressServers } from './ingress/server.js';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { describeError } from './control/errors.js';
import { createApiAuthorizationGate } from './control/apiAuthorization.js';
import { loadConfiguration, unknownHoldrNames } from './control/holdrConf.js';
import { assertNoLeaseEnv } from './control/lifecycle.js';
import { contains } from './control/paths.js';
import { acquireDevLifecycle, createProductionRuntime } from './control/runtimeIntegration.js';
import { computeReleaseAttestation, describeReleaseAttestation } from './release/apiAttestation.js';

// The data directory holds the ledger, password hashes, session digests and
// the service token: everything the API creates there is owner-only.
process.umask(0o077);

// Whatever nothing else catches (a startup step after the database opened, a
// timer) still stops the API, but SQLite's own errors are reported by type
// and code only: their messages and stacks can quote whatever the database
// holds. Holdr's own errors keep their value-free messages, such as
// `open database failed (SQLITE_ERROR)` or a newer schema's refusal.
process.on('uncaughtException', (error) => {
  const fromSqlite = isDatabaseFailure(error) && !(error instanceof HoldrDbError);
  console.error('[holdr-api] stopped:', fromSqlite ? errorTypeAndCode(error) : error);
  process.exit(1);
});

// The release attestation (card-upload migration B-b, ROOT B3), computed once, here: every module this file imports has
// loaded, and nothing (configuration, token, database, listener) has been touched yet. This process's pid and start, its
// Node, entry and preloads, and a digest of apps/api/src, packages/shared/src, the package and TypeScript configuration,
// the lockfiles and the native addon. GET /release/attestation serves it unchanged for this process's life. It cannot
// stop the API: if it cannot be computed, the route answers 503 and everything else works.
const releaseAttestation = computeReleaseAttestation();
if (releaseAttestation.status === 'ready') console.log(describeReleaseAttestation(releaseAttestation));
else console.warn(describeReleaseAttestation(releaseAttestation));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PR B: holdr.conf (design §7.1, §8.1) and the lease-variable contract come first; then A's configuration, A's release
// checks, and B's runtime integration (K17-K22, K24, K28 boot, K29, K30, K31) before any database or listener opens.
// A value-free refusal (`E0I_*` code and a local path) exits 1 with nothing opened, bound or created.
const startup = await (async () => {
  try {
    assertNoLeaseEnv(process.env);
    const configuration = loadConfiguration(process.env);
    // File keys are absent from the environment or equal to it (else E0I_CONFIG_FILE above): fill the missing ones,
    // so every later reader in this process sees the configured values.
    for (const [name, value] of Object.entries(configuration.env)) {
      if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
    }
    for (const name of unknownHoldrNames(process.env)) console.warn(`[holdr-api] unknown setting ${name} ignored`);
    const config = resolveIngressConfig(process.env);
    const runtime = config.mode === 'dev' ? null
      : createProductionRuntime({ env: process.env, config, conf: configuration.conf, log: console.log, warn: console.warn });
    const prepared = await prepareIngress(config, runtime?.integration);
    const devLease = config.mode === 'dev' ? await acquireDevLifecycle(process.env) : null;
    return { ingressConfig: config, ingress: prepared, runtime, devLease };
  } catch (error) {
    if (!(error instanceof WebReleaseError)) throw error;
    console.error(`[holdr-api] refused to start: ${describeError(error)}`);
    process.exit(1);
  }
})();
const { ingressConfig, ingress, runtime, devLease } = startup;
const configured = resolveDataPaths(process.env, path.resolve(__dirname, '..', 'data'));
console.log(`[holdr-api] data dir: ${configured.dataDir}${configured.fromEnv ? ' (HOLDR_DATA_DIR)' : ''}`);

// HOLDR_MARKET_DATA=stored (the demo): stored closes only, no provider is ever asked. Any other value than live or
// stored stops here, before anything opens, so a typo never takes an offline setup online.
let marketData: MarketDataMode;
try {
  marketData = marketDataModeOf(process.env);
} catch (error) {
  console.error(`[holdr-api] ${(error as Error).message}; refusing to start`);
  process.exit(1);
}
if (marketData === 'stored') console.log('[holdr-api] market data: stored closes only (HOLDR_MARKET_DATA=stored); no provider is asked');

// e2e only: scripts/e2e-disposable.mjs passes a random HOLDR_E2E_RUN_ID that
// /health reports, so Playwright can verify the stack before it writes. The
// e2e module loads only when the variable is set. It refuses to start on a
// data directory that is not disposable and resolves the one it checked to
// its physical path. The API then opens state.json and finance.db only in
// that directory, never through HOLDR_DATA_DIR as given (a symlink on the way
// could be retargeted after the check). It re-checks the directory before
// each open and pins the database files right after the SQLite open, and
// /health runs the same check on every request.
let e2eDataDir: E2eDataDir | null = null;
const e2eRunId = process.env.HOLDR_E2E_RUN_ID?.trim();
if (e2eRunId) {
  const { createRunIdentity } = await import('./e2e/runIdentity.js');
  try {
    e2eDataDir = createRunIdentity(e2eRunId, configured.dataDir);
  } catch (error) {
    console.error(`[holdr-api] ${(error as Error).message}`);
    process.exit(1);
  }
  console.log(`[holdr-api] e2e run identity enabled; opening only the checked data dir ${e2eDataDir.dataDir}`);
}
const { dataDir: DATA_DIR, jsonFile: JSON_FILE, dbFile: DB_FILE } = e2eDataDir ?? configured;

/** With a run identity, exit unless `step` confirms the checked data dir. */
function confirmE2eDataDir(step: (dir: E2eDataDir) => void = (dir) => dir.assertUnchanged()): void {
  if (!e2eDataDir) return;
  try {
    step(e2eDataDir);
  } catch (error) {
    console.error(`[holdr-api] ${(error as Error).message}`);
    process.exit(1);
  }
}

// The service token lives next to the database unless HOLDR_SERVICE_TOKEN_FILE
// moves it. An e2e data directory may hold nothing but SQLite's own files, so
// an API with a run identity keeps its token in memory only (nothing can use
// it) unless HOLDR_SERVICE_TOKEN_FILE names a file outside that directory.
const tokenFileSetting = process.env.HOLDR_SERVICE_TOKEN_FILE?.trim();
const SERVICE_TOKEN_FILE = tokenFileSetting
  ? path.resolve(tokenFileSetting)
  : e2eDataDir ? null : path.join(DATA_DIR, SERVICE_TOKEN_FILE_NAME);
if (e2eDataDir && SERVICE_TOKEN_FILE) {
  const tokenDir = path.dirname(SERVICE_TOKEN_FILE);
  const physicalTokenDir = fs.existsSync(tokenDir) ? fs.realpathSync(tokenDir) : tokenDir;
  // By path components, so a directory named `..token` inside the data directory counts as inside (B1 review 1).
  const inDataDir = (dir: string) => contains(e2eDataDir!.dataDir, dir);
  if (inDataDir(tokenDir) || inDataDir(physicalTokenDir)) {
    console.error('[holdr-api] with HOLDR_E2E_RUN_ID, HOLDR_SERVICE_TOKEN_FILE must be outside the e2e data directory, which may hold only SQLite files; refusing to start');
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT ?? 4000);
// Loopback only: browsers reach the API through the web proxy, local scripts connect directly with a token. Any other
// HOLDR_HOST has already stopped the start (ingress/config.ts, E0I_BIND).
const HOST = process.env.HOLDR_HOST?.trim() || '127.0.0.1';

// The origin browsers use, e.g. https://<machine>.<tailnet>.ts.net behind
// Tailscale Serve. An https value is what switches session cookies to Secure;
// request headers never do. Unset for plain-HTTP setups (local dev, tests,
// the HOLDR_LAN_HTTP opt-in).
const publicOriginSetting = process.env.HOLDR_PUBLIC_ORIGIN?.trim() ?? '';
const publicOrigin = publicOriginSetting ? parsePublicOrigin(publicOriginSetting) : null;
if (publicOriginSetting && !publicOrigin) {
  console.error(`[auth] HOLDR_PUBLIC_ORIGIN=${JSON.stringify(publicOriginSetting)} is not an origin like https://holdr.example.ts.net; refusing to start`);
  process.exit(1);
}
const secureCookies = publicOrigin?.startsWith('https://') ?? false;

// One-shot migration. Idempotent and safe on every boot.
confirmE2eDataDir();
const migration = await migrateJsonToSqlite({ jsonFile: JSON_FILE, dbFile: DB_FILE });
if (migration.performed) {
  console.log(
    `[migrate] state.json → finance.db: ${migration.accountCount} accounts, ${migration.transactionCount} transactions. ` +
    `backup=${migration.backupPath} archived=${migration.archivedPath}`,
  );
} else {
  console.log(`[migrate] skipped: ${migration.reason}`);
}

// Long-lived repo handle shared by the routers and the health check.
confirmE2eDataDir();
const repo = new SqliteStateRepo({ file: DB_FILE });
// Pin the database files SQLite just opened: /health compares them from now on.
confirmE2eDataDir((dir) => dir.recordOpened());
// Databases created before sign-in existed may still be group/world readable.
// (An e2e data directory and its files are private already: this changes nothing there.
// Mode bits say nothing on Windows, where the files have their directory's ACL.)
for (const file of process.platform === 'win32' ? [] : [DATA_DIR, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    const stat = fs.statSync(file);
    if (stat.mode & 0o077) {
      fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
      console.warn(`[auth] restricted ${file} to its owner (was ${(stat.mode & 0o777).toString(8)})`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

const serviceToken = SERVICE_TOKEN_FILE
  ? loadOrCreateServiceToken(SERVICE_TOKEN_FILE)
  : { token: randomBytes(32).toString('hex'), created: false, repairedMode: false };
if (!SERVICE_TOKEN_FILE) console.log('[auth] e2e run without HOLDR_SERVICE_TOKEN_FILE: the service token exists only in memory');
// On Windows mode bits say nothing (the file has its directory's inherited ACL), so the mode is not claimed there.
if (serviceToken.created) {
  console.log(`[auth] generated service token at ${SERVICE_TOKEN_FILE} (${process.platform === 'win32' ? "it inherits its directory's ACL" : 'mode 0600'})`);
}
if (serviceToken.repairedMode) console.warn(`[auth] ${SERVICE_TOKEN_FILE} was readable by others; reset to mode 0600`);

// The read-only agent token for AI agents (auth/agentToken.ts), always in the data directory, made the same way. An e2e
// data directory holds SQLite's files only, so a disposable stack has no agent token at all.
const AGENT_TOKEN_FILE = e2eDataDir ? null : path.join(DATA_DIR, AGENT_TOKEN_FILE_NAME);
const agentToken = AGENT_TOKEN_FILE ? loadOrCreateAgentToken(AGENT_TOKEN_FILE) : null;
if (agentToken?.created) {
  const access = process.platform === 'win32' ? "it inherits its directory's ACL" : 'mode 0600';
  console.log(`[auth] generated agent token (read-only) at ${AGENT_TOKEN_FILE} (${access})`);
}
if (agentToken?.repairedMode) console.warn(`[auth] ${AGENT_TOKEN_FILE} was readable by others; reset to mode 0600`);

// Origins allowed to send state-changing requests (Origin check on every
// POST/PUT/PATCH/DELETE). Comma-separated; defaults to the local Vite dev
// server. The public origin is always allowed.
const allowedOrigins = ingressConfig.mode === 'dev'
  ? parseAllowedOrigins(process.env.WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
  : [...ingressConfig.allowedOrigins];
if (publicOrigin && !allowedOrigins.includes(publicOrigin)) allowedOrigins.push(publicOrigin);
const lanHttps = resolveLanHttpsConfig(process.env);
if (lanHttps && !allowedOrigins.includes(lanHttps.origin)) allowedOrigins.push(lanHttps.origin);
const remoteHttpOrigins = allowedOrigins.filter((origin) => origin.startsWith('http://') && !isLoopbackHost(new URL(origin).host));

// Compute snapshotsEnabled now so /health can report it. The scheduler
// itself starts only once the API listens (below).
const isDev = process.env.NODE_ENV !== 'production';
const snapshotsExplicit = process.env.SNAPSHOTS_ENABLED;
const snapshotsEnabled =
  snapshotsExplicit === '1' ? true
  : snapshotsExplicit === '0' ? false
  : isDev;                          // implicit: on in dev, off elsewhere

// E2's authorization gate (E1b design §10 item 2) over PR B's fence and authorization.lock, with this machine's id and
// control dir from the runtime's lifecycle evidence (dist/local) or the configured dev lease. Only actual absence of a
// control dir selects the unwired gate. Startup latches mismatches and reconciles only an exact committed change.
const lifecycle = runtime?.lifecycleEvidence() ?? null;
const cardSyncGate = await createApiAuthorizationGate({
  env: process.env, dataDir: DATA_DIR, lifecycle, devLease,
  databaseGeneration: () => repo.getCardSyncAuthorizationGeneration(), log: (line) => console.warn(line),
});
try {
  await cardSyncGate.reconcile();
} catch (error) {
  console.warn(`[card-sync] device gate: the startup check could not run (${describeError(error)}); the gate stays as it is`);
}

const deviceApiEnabled = deviceApiConfigured(ingressConfig, process.env);
const { app, users, deviceMount } = createApp({
  repo,
  serviceToken: serviceToken.token,
  agentToken: agentToken?.token,
  allowedOrigins,
  secureCookies,
  ingress: ingress.web,
  snapshotsEnabled,
  // The computed 1D and 1W lines ask public chart endpoints for held symbols' prices (symbols only).
  // Off on disposable e2e stacks, which must not reach the network, with HOLDR_INTRADAY_PRICES=0, and on stored market data.
  intradayBars: e2eDataDir || process.env.HOLDR_INTRADAY_PRICES === '0' || marketData === 'stored' ? undefined : fetchSessionIntradayBars,
  intradayWeekBars: e2eDataDir || process.env.HOLDR_INTRADAY_PRICES === '0' || marketData === 'stored' ? undefined : fetchWeekIntradayBars,
  // The Gold page's daily spot closes (a metal symbol and a date range only): off unless HOLDR_METALS_PRICES=1, and
  // never on a disposable e2e stack or stored market data. Off, the metals reads value with stored closes only.
  metalSpotBars: !e2eDataDir && marketData === 'live' && metalsPricesEnabled(process.env) ? fetchMetalSpotDailyBars : undefined,
  marketData,
  // The owner's metals assignment policy (HOLDR_METALS_FUNGIBLE): unset, metals-assignment-v1 exactly.
  metalsFungible: metalsFungibleOf(process.env),
  // The owner's estimate switch (HOLDR_METALS_ESTIMATE_UNMATCHED): unset, no sold unit's cost is estimated.
  metalsEstimateUnmatched: metalsEstimateUnmatchedOf(process.env),
  // /health reports the run identity (and re-checks the data dir) on every request.
  e2eIdentity: e2eDataDir ? () => e2eDataDir!.identity() : undefined,
  // Owner pairing/approval follows the deployment switch, never a test provider or a database setting.
  cardSyncAuthorization: {
    gate: cardSyncGate,
    holdrOrigin: ingressConfig.mode === 'dist' ? ingressConfig.publicOrigin : null,
    deviceApi: deviceApiEnabled ? 'enabled' : 'disabled',
  },
  releaseAttestation,
});
if (users.countUsers() === 0) {
  console.warn(`[auth] no users yet: data routes answer 503 until you run \`${USER_CLI_COMMAND}\` on this machine`);
}
if (secureCookies) {
  const ended = users.deleteInsecureSessions();
  console.log(`[auth] HTTPS mode for ${publicOrigin}: session cookie ${SECURE_SESSION_COOKIE} (Secure)`);
  if (ended > 0) console.log(`[auth] ended ${ended} session(s) that were issued over plain HTTP`);
  if (remoteHttpOrigins.length > 0) {
    console.warn(`[auth] WEB_ORIGIN also lists plain-HTTP origins (${remoteHttpOrigins.join(', ')}); sign-in there cannot work because the session cookie is Secure`);
  }
} else {
  console.log(`[auth] session cookie ${SESSION_COOKIE} is not Secure (set HOLDR_PUBLIC_ORIGIN=https://… when browsers use HTTPS)`);
  if (remoteHttpOrigins.length > 0) {
    console.warn(`[auth] WARNING: plain-HTTP origins allowed (${remoteHttpOrigins.join(', ')}): passwords, session cookies and financial data cross that network unencrypted`);
  }
}
users.reapExpiredSessions();
const sessionReaper = setInterval(() => {
  // A failed cleanup waits for the next one; the API keeps serving.
  try {
    users.reapExpiredSessions();
  } catch (error) {
    console.warn(`[auth] expired session cleanup failed: ${errorTypeAndCode(error)}`);
  }
}, 6 * 60 * 60 * 1000);
sessionReaper.unref();

// Card sync retention (E1b design §10 item 5): now and every 10 minutes, each
// pass calling the repository again while it reports work left.
const cardSyncRetention = startCardSyncRetention({ repo });

const servers = await startIngressServers(app, ingress.listeners, { socketSafety: ingress.socketSafety, log: console.warn });
if (deviceApiEnabled && ingressConfig.mode === 'dist' && runtime && lifecycle && deviceMount) {
  const serve = servers.find((server) => server.address() === ingressConfig.socketPath);
  if (!serve) throw new WebReleaseError('E0I_DEVICE_ADMISSION');
  const admission = admitDeviceRequest({
    config: ingressConfig, env: process.env, serve, attestation: runtime.integration.admission,
    lifecycle: () => runtime.lifecycleEvidence(), source: repo,
  });
  deviceMount.install(admission, {
    controlDir: lifecycle.controlDir, machine: lifecycle.machine,
    databaseGeneration: () => repo.getCardSyncAuthorizationGeneration(), log: console.warn,
  });
}
// Attestation polls the socket identity recorded at listen; before its first success, admission stays closed.
runtime?.start();
if (ingressConfig.mode === 'dev') console.log(`[holdr-api] listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
else console.log(`[holdr-api] listening in ${ingressConfig.mode} mode (${servers.length} listener(s))`);

// Snapshot scheduler, started only now that this API listens. In dev (NODE_ENV !== 'production') it defaults ON
// so the 1D chart works out of the box. Production / test must set the env explicitly. SNAPSHOTS_ENABLED=0 forces
// off everywhere. Its lease holder is the TCP endpoint of the 'local' listener, which every mode binds, so a restarted
// API is the same holder and takes up the lease at its first tick even if the old process never released it. A
// duplicate start cannot bind that endpoint and exits above, so it never takes or shares the lease; shutdown()
// stops the scheduler before the endpoint is given up.
let snapshotScheduler: { stop: () => void } | null = null;
if (snapshotsEnabled) {
  // NaN-safe env parse. setInterval(NaN) busy-loops; clamp the value.
  const DEFAULT_MS = 5 * 60 * 1000;
  const MIN_MS = 1_000;            // floor so a typo can't DoS providers
  const MAX_MS = 60 * 60 * 1000;   // ceiling — once-per-hour is the slowest sane cadence
  const raw = process.env.SNAPSHOT_INTERVAL_MS;
  let intervalMs = DEFAULT_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_MS && parsed <= MAX_MS) {
      intervalMs = parsed;
    } else {
      console.warn(
        `[snapshots] SNAPSHOT_INTERVAL_MS=${raw} is invalid (must be a number in [${MIN_MS}, ${MAX_MS}]); using default ${DEFAULT_MS}ms`,
      );
    }
  }
  // Dev: 5s startup delay so tsx-watch reloads don't pile rows. Prod: 30s.
  const startDelayMs = isDev ? 5_000 : 30_000;
  const loopback = servers.find((_, index) => ingress.listeners[index]?.listener === 'local');
  const job = createSnapshotJob({
    state: repo,
    ...(marketData === 'stored' ? { fetchQuotes: createStoredQuoteFetcher(repo.internalGetDb()) } : {}),
  }, { intervalMs, holder: loopback && listenerLeaseHolder(loopback) });
  snapshotScheduler = startSnapshotScheduler(job, { intervalMs, startDelayMs });
  console.log(
    `[snapshots] scheduler enabled (${snapshotsExplicit === undefined ? 'dev default' : 'explicit'}), interval=${intervalMs}ms, startDelay=${startDelayMs}ms`,
  );
} else {
  console.log('[snapshots] disabled (set SNAPSHOTS_ENABLED=1 to enable)');
}

// Graceful shutdown so the SQLite handle is closed cleanly (flushes WAL). The lifecycle lease is released only after the
// database is closed (§9.3: no participant has finance.db open while a maintenance holder works). The snapshot scheduler
// stops first, while this API still holds the endpoint its lease holder names.
function shutdown() {
  if (snapshotScheduler) snapshotScheduler.stop();
  clearInterval(sessionReaper);
  cardSyncRetention.stop();
  Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(() => {
    repo.close();
    runtime?.stop();
    devLease?.release();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
