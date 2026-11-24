import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { STATUS_CODES } from 'node:http';

import type { Metal } from '@finance-tracker/shared/metals-ledger';

import { createAuth, rejectFunnel, type HoldrAuthHandlers } from './auth/http.js';
import type { LoginThrottle } from './auth/loginThrottle.js';
import type { ScryptParams } from './auth/password.js';
import { cardSpendingAuth } from './auth/serviceScope.js';
import { createQuotesRouter } from './routes/quotes.js';
import { importRouter } from './routes/import.js';
import { createBrokerImportRouter } from './routes/brokerPull.js';
import { createActivityImportRouter } from './routes/brokerActivity.js';
import { createAccountNavRouter } from './routes/accountNav.js';
import { createCashEventsRouter } from './routes/cashEvents.js';
import { createResourceRouter } from './routes/resources.js';
import { createSymbolsRouter } from './routes/symbols.js';
import { createManualPricesRouter } from './routes/manualPrices.js';
import { createPortfolioRouter, createAccountHistoryRouter } from './routes/portfolio.js';
import { createHealthHandler, type E2eIdentityReport } from './routes/health.js';
import { createReleaseAttestationRouter } from './routes/releaseAttestation.js';
import type { ReleaseAttestation } from './release/apiAttestation.js';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './routes/cardSpending.js';
import { createCardTransactionsRouter } from './routes/cardTransactions.js';
import { createCardSpendingRulesRouter } from './routes/cardSpendingRules.js';
import { createCardSpendingOverviewRouter } from './routes/cardSpendingOverview.js';
import { createCardSpendingForecastRouter } from './routes/cardSpendingForecast.js';
import { createCardOpeningsRouter } from './routes/cardSpendingOpenings.js';
import { createCardBenefitsRouter } from './routes/cardBenefits.js';
import {
  createCardPaymentReconciliationRouter,
  type CheckingLedgerReader,
} from './routes/cardPaymentReconciliation.js';
import { createAmazonRouter } from './routes/amazon.js';
import { createCheckingRouter } from './routes/checking.js';
import { createCashPlanRouter } from './routes/cashPlan.js';
import { createBalanceChainRouter } from './routes/balanceChain.js';
import { createMetalsRouter } from './routes/metals.js';
import { createRetailRouter } from './routes/retail.js';
import { createAmazonCategoryResolver } from './services/amazon/resolver.js';
import { createCompositeCategoryResolver } from './services/categorySources.js';
import { createCheckingLedgerReader } from './services/checking/ledger.js';
import { MetalsPriceRefresher, createMetalsPriceStore } from './services/metalsRead/prices.js';
import { MetalsReadModel } from './services/metalsRead/source.js';
import type { MetalSpotBarFetcher } from './providers/metalSpotBars.js';
import { createStoredQuoteFetcher, type MarketDataMode } from './services/storedMarketData.js';
import { CardSyncCursorCodec } from './routes/cardSync/cursor.js';
import { createCardSyncOwnerRouter, type CardSyncAuthorizationGate } from './routes/cardSync/owner.js';
import { createPendingDeviceMount, type PendingDeviceMount } from './routes/cardSync/deviceMount.js';
import { deviceBodyReader } from './routes/cardSync/deviceBody.js';
import { deviceCors } from './routes/cardSync/deviceCors.js';
import { unwiredAuthorizationGateService, type CardSyncAuthorizationService } from './control/authorizationChange.js';
import { errorTypeAndCode } from './services/dbErrors.js';
import { LocalAuthRepo } from './services/localAuthRepo.js';
import type { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { createHistoryRepo } from './services/symbolHistory.js';
import { createManualPriceRepo } from './services/manualPrices.js';
import type { IntradayBarFetcher } from './providers/intradayBars.js';
import { requestTargetGuard } from './ingress/requestTarget.js';
import { createWebIngress } from './ingress/staticResponder.js';
import { securityHeaders, sendRefusal } from './ingress/securityHeaders.js';
import type { WebIngressOptions } from './ingress/types.js';
import { createVerifiedApp } from './ingress/expressIdentity.js';

export interface CreateAppOptions {
  repo: SqliteStateRepo;
  /** Bearer token accepted from direct loopback callers (see auth/serviceToken.ts). */
  serviceToken: string;
  /**
   * The read-only agent token (auth/agentToken.ts), accepted from direct loopback callers for GET and HEAD on the read
   * routes of auth/agentScope.ts only. Unset (tests, disposable e2e stacks), no agent token is accepted.
   */
  agentToken?: string;
  /** Canonical origins allowed to send state-changing requests (WEB_ORIGIN). */
  allowedOrigins: readonly string[];
  /** HTTPS mode (HOLDR_PUBLIC_ORIGIN is https): Secure `__Host-` session cookie. */
  secureCookies?: boolean;
  /** Unset keeps the current Vite/API mode. Release modes require the server dispatcher. */
  ingress?: WebIngressOptions;
  snapshotsEnabled: boolean;
  /**
   * Public 1-minute chart prices for the computed 1D portfolio line (providers/intradayBars.ts).
   * Unset (tests, disposable e2e stacks) the line uses only stored prices and fetches nothing.
   */
  intradayBars?: IntradayBarFetcher;
  /** Public 5-minute chart prices of the last five sessions, for the computed 1W line; unset as above. */
  intradayWeekBars?: IntradayBarFetcher;
  /**
   * Disposable e2e stacks only (HOLDR_E2E_RUN_ID): the run identity /health
   * reports, re-checked on every call (on Windows through PowerShell, off the
   * event loop, so it may be a promise). See the /health handler
   * (routes/health.ts) for why it is also shown without a session.
   */
  e2eIdentity?: () => E2eIdentityReport | Promise<E2eIdentityReport>;
  now?: () => Date;
  throttle?: LoginThrottle;
  scryptParams?: ScryptParams;
  log?: (message: string) => void;
  /**
   * Card sync's external authorization gate (E1b design §10 item 2), which
   * extension sets' plans and commits pin. E0-I PR B provides it (E2b); until
   * then the default answers "blocked" (routes/cardSync/owner.ts).
   */
  cardSyncGate?: CardSyncAuthorizationGate;
  /**
   * E2b's owner authorization routes (routes/cardSync/authorization.ts). `gate` is E2's generation protocol over PR B's
   * fence (control/authorizationChange.ts), which also answers E2a's source checks; without one (dev, tests) the gate is
   * unwired: always blocked, widening changes refused, narrowing ones applied. `holdrOrigin` is the HTTPS origin devices
   * pair with (`dist` only; null answers `GET /card-sync/owner/state` 404 and keeps pairing off); `deviceApi` mirrors the
   * deployment switch. Device routes independently require PR D's post-bind admission.
   */
  cardSyncAuthorization?: {
    gate?: CardSyncAuthorizationService;
    holdrOrigin?: string | null;
    deviceApi?: 'enabled' | 'disabled';
  };
  /**
   * The checking ledger's read-only reader (Wells Fargo, Fifth Third, …), for matching card payments with the checking
   * debits that paid them (routes/cardPaymentReconciliation.ts). Unset (or null), the checking import's own reader on
   * this database (services/checking/ledger.ts), which reads nothing until the checking tables are installed: until
   * then the reconciliation says `checking.installed: false`. No other route reads it.
   */
  checkingLedger?: CheckingLedgerReader | null;
  /**
   * Daily spot closes of the precious metals for the Gold page (providers/metalSpotBars.ts, CNBC; a metal symbol and a
   * date range only). Unset (the default, every test and disposable e2e stack, and HOLDR_METALS_PRICES unset or 0) the
   * metals reads value with stored closes only and fetch nothing.
   */
  metalSpotBars?: MetalSpotBarFetcher;
  /**
   * What GET /release/attestation serves (card-upload migration B-b): the identity index.ts computed once at startup
   * (release/apiAttestation.ts). Unset (tests, helpers), the route answers 503 `attestation-unavailable`.
   */
  releaseAttestation?: ReleaseAttestation;
  /**
   * The owner's metals assignment policy (`HOLDR_METALS_FUNGIBLE`, services/metalsRead/policy.ts): the metals assigned
   * oldest first across forms. Unset or empty (the default, every test and disposable e2e stack that doesn't set it),
   * metals-assignment-v1 exactly.
   */
  metalsFungible?: readonly Metal[];
  /**
   * The owner's estimate switch (`HOLDR_METALS_ESTIMATE_UNMATCHED`, services/metalsRead/policy.ts): the metals whose sold
   * units with no recorded purchase take a cost estimated from the nearest purchase of their class. Unset or empty (the
   * default, every test and disposable e2e stack that doesn't set it), nothing is estimated.
   */
  metalsEstimateUnmatched?: readonly Metal[];
  /**
   * `HOLDR_MARKET_DATA` (services/storedMarketData.ts). `stored` (the demo): quotes, price history and the Gold page's
   * valuations come from the closes stored in the database, and no provider is ever asked (quotes, history, intraday
   * bars or metal closes). Unset or `live`: providers as configured above.
   */
  marketData?: MarketDataMode;
}

export interface HoldrApp {
  app: Express;
  auth: HoldrAuthHandlers;
  users: LocalAuthRepo;
  /** Only dist reserves this position; installing routes still requires D's post-bind branded admission. */
  deviceMount?: PendingDeviceMount;
}

// API responses carry private financial data; keep them out of browser and proxy caches.
const privateResponses: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

// Root-only, after device admission and owner routing: unknown sync paths never reach the general body parser.
const cardSyncNotFound: RequestHandler = (req, res, next) => {
  if (/^\/card-sync(?:\/|$)/i.test(req.path)) sendRefusal(req, res, 404, 'not-found');
  else next();
};

type MiddlewareStage = 'before-device' | 'after-device';
const auditedMiddleware = new WeakMap<Express, WeakMap<object, MiddlewareStage>>();

/** Read-only identities of the explicitly audited ambient handlers below, never caller-supplied middleware. */
export function appDeviceMiddlewareStage(app: Express, handle: object): MiddlewareStage | undefined {
  return auditedMiddleware.get(app)?.get(handle);
}

/** A property of a thrown value, or undefined when it cannot be read. */
function property(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The app's last error handler, for every path outside card spending (whose
 * mount answers its own). JSON instead of Express's default HTML page, which
 * includes stack traces outside production, and value-free: an error's
 * message can quote the request (body parsers, undecodable paths) or the
 * database (SQLite), so none reaches a response or the log. Routes answer
 * their own validation errors (4xx with their messages) before anything gets
 * here, and pass database failures on (isDatabaseFailure). What arrives gets
 * a fixed message; the log gets only the error's type and code.
 */
function jsonErrors(log: (line: string) => void): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      // Too late for an error response: end the connection, as Express would, without logging the error itself.
      log(`[holdr-api] ${req.method} request failed after its response started: ${errorTypeAndCode(err)}`);
      req.socket.destroy();
      return;
    }
    const send = (status: number, message: string) => {
      res.status(status).json({ error: message });
    };
    const type = property(err, 'type');
    if (type === 'entity.parse.failed') return send(400, 'the request body is not valid JSON');
    if (type === 'entity.too.large') return send(413, 'the request body is too large');
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
      return send(415, 'the request body must be uncompressed UTF-8');
    }
    if (typeof type === 'string') return send(400, 'the request body could not be read');
    if (err instanceof URIError) return send(400, 'the request path is not valid URL encoding');
    const status = Number(property(err, 'status') ?? property(err, 'statusCode'));
    if (Number.isInteger(status) && status >= 400 && status < 500) return send(status, STATUS_CODES[status] ?? 'Bad request');
    log(`[holdr-api] ${req.method} request failed: ${errorTypeAndCode(err)}`);
    send(500, 'Internal server error');
  };
}

/**
 * Builds the API. For browser/session access, only GET /health (minimal without a session), POST
 * /auth/login, POST /auth/logout and GET /auth/me are reachable before
 * `requireAuth` (POST /auth/reverify is mounted there too, and answers 401
 * itself without a session); every route mounted after it needs a session cookie or one of the tokens. The service
 * token reaches only the reads and v1 card imports listed in auth/serviceScope.ts, and the agent token only the reads
 * listed in auth/agentScope.ts, with GET and HEAD: identify refuses each everything else before any route runs, and
 * card spending's mount checks both again. Card sync's
 * owner routes (/card-sync/owner) are for the signed-in session only. GET /release/attestation is for the service
 * token on a direct loopback connection only (routes/releaseAttestation.ts). Dist also reserves a
 * separate pre-identify device mount; only D's post-bind admission can populate it, and every device method runs through
 * that guard.
 */
export function createApp(options: CreateAppOptions): HoldrApp {
  const { repo } = options;
  const app = createVerifiedApp();
  const middleware = new WeakMap<object, MiddlewareStage>();
  auditedMiddleware.set(app, middleware);
  const ambient = (stage: MiddlewareStage, handler: RequestHandler | ErrorRequestHandler) => {
    middleware.set(handler, stage);
    app.use(handler);
  };
  app.disable('x-powered-by');
  const ingress = options.ingress ?? { mode: 'dev' };

  const users = new LocalAuthRepo(repo);
  const errorLog = options.log ?? ((line: string) => console.error(line));
  const auth = createAuth({
    users,
    serviceToken: options.serviceToken,
    agentToken: options.agentToken,
    // Only a disposable e2e stack has a run identity; there the e2e runner may check that broker pulls stay inside.
    disposableE2e: options.e2eIdentity !== undefined,
    allowedOrigins: options.allowedOrigins,
    secureCookies: ingress.mode === 'dist' ? true : ingress.mode === 'local' ? false : options.secureCookies,
    ingress,
    now: options.now,
    throttle: options.throttle,
    scryptParams: options.scryptParams,
    log: options.log,
  });

  ambient('before-device', requestTargetGuard);
  ambient('before-device', securityHeaders);
  ambient('before-device', createWebIngress(ingress));
  ambient('before-device', privateResponses);
  ambient('before-device', rejectFunnel);
  const deviceMount = ingress.mode === 'dist'
    ? createPendingDeviceMount({ repo, holdrOrigin: ingress.publicOrigin, log: errorLog }) : undefined;
  if (deviceMount) {
    ambient('before-device', deviceCors);
    ambient('before-device', deviceBodyReader);
    app.use('/card-sync', deviceMount.router);
  }
  ambient('after-device', auth.identify);
  ambient('after-device', auth.csrfGuard);

  app.get('/health', createHealthHandler({
    repo,
    snapshotsEnabled: options.snapshotsEnabled,
    e2eIdentity: options.e2eIdentity,
  }));

  app.use('/auth', auth.router);

  // ---- everything below requires a session or the service token ----------
  ambient('after-device', auth.requireAuth);
  // The release attestation (card-upload migration B-b, ROOT B3), in its own router: for the service principal on a
  // direct loopback connection only, every other caller and every method but GET answered as an unknown path (404).
  // The ingress makes /release an API path only for direct loopback requests. It reads no body and no repository.
  app.use(createReleaseAttestationRouter(options.releaseAttestation));
  const authorizationGate = options.cardSyncAuthorization?.gate
    ?? unwiredAuthorizationGateService({ databaseGeneration: () => repo.getCardSyncAuthorizationGeneration() });
  const clock = options.now ?? (() => new Date());
  // Owner handlers stay inside the exact owner namespace; they never gain an exemption for device paths.
  app.use('/card-sync/owner', createCardSyncOwnerRouter({
    repo,
    requireRecentAuth: auth.requireRecentAuth,
    cursors: new CardSyncCursorCodec(options.serviceToken),
    gate: options.cardSyncGate ?? authorizationGate,
    authorization: {
      gate: authorizationGate,
      currentSession: auth.isCurrentSession,
      recentlyAuthenticated: (req) => req.holdrAuth?.kind === 'session'
        && auth.recentAuth.isRecent(req.holdrAuth.sessionId, clock().getTime()),
      holdrOrigin: options.cardSyncAuthorization?.holdrOrigin ?? null,
      deviceApi: options.cardSyncAuthorization?.deviceApi ?? 'disabled',
    },
    log: errorLog,
  }));
  ambient('after-device', cardSyncNotFound);
  // Card spending routes read their own bodies (10 MiB imports, 16 KiB card
  // accounts, UTF-8 JSON only), so this parser leaves their paths alone.
  ambient('after-device', exceptCardSpendingPaths(express.json({ limit: '2mb' })));

  // Card spending: imports and card accounts (Phase 3), the Spending tab's
  // reads (Phase 4, payment suggestions included) and the Benefits tab's
  // report, settings and marks. Behind identify, csrfGuard
  // and requireAuth above; the mount runs requireAuth again for every card
  // path, with the service token limited to reads and v1 imports, and answers
  // every card path's errors itself, value-free. Spending's categories read
  // the reviewed category sources through one composite source
  // (services/categorySources.ts; read-only, one snapshot per request): so far
  // the Amazon domain's splits and card details alone, so with no Amazon data
  // imported it splits nothing. Checking accounts are read-only here (imports
  // run only through the operator CLI) and never count as spending.
  const categorySources = createCompositeCategoryResolver([createAmazonCategoryResolver(repo.internalGetDb())]);
  // Card payments against the checking debits that paid them: read per request, from the checking import's reader.
  const checkingLedger = options.checkingLedger ?? createCheckingLedgerReader(repo.internalGetDb());
  // The precious-metals ledger (the Gold page): reads over the operator-installed metals tables, computed once per data
  // version, and the owner's content confirmations; daily spot closes are fetched only when metalSpotBars is set.
  const metalsPriceStore = createMetalsPriceStore(repo.internalGetDb());
  const storedMarketData = options.marketData === 'stored';
  const metalsRouter = createMetalsRouter({
    model: new MetalsReadModel(repo),
    prices: {
      store: metalsPriceStore,
      refresher: new MetalsPriceRefresher({
        store: metalsPriceStore, fetcher: storedMarketData ? undefined : options.metalSpotBars, storedOnly: storedMarketData,
        now: clock, log: errorLog,
      }),
    },
    now: clock,
    log: errorLog,
    fungible: options.metalsFungible ?? [],
    estimateUnmatched: options.metalsEstimateUnmatched ?? [],
  });
  mountCardSpendingRoutes(app, {
    repo,
    requireAuth: cardSpendingAuth(auth.requireAuth),
    log: errorLog,
    routers: [createCardTransactionsRouter(repo, { log: errorLog, categoryResolver: categorySources }),
      createCardSpendingRulesRouter(repo, { log: errorLog }),
      createCardSpendingOverviewRouter(repo, { log: errorLog, categoryResolver: categorySources }),
      createCardSpendingForecastRouter(repo, { log: errorLog, categoryResolver: categorySources }),
      createCardOpeningsRouter(repo, { log: errorLog }),
      createCardPaymentReconciliationRouter(repo, { log: errorLog, checkingLedger }),
      // The card payment schedule (read-only; its table only through the operator's `holdr-cash install`).
      createCashPlanRouter(repo, { log: errorLog, checkingLedger }),
      // The balance-chain verifier's report (read-only; design W6 v1).
      createBalanceChainRouter(repo),
      createCardBenefitsRouter(repo, { log: errorLog }), createAmazonRouter(repo), createCheckingRouter(repo), metalsRouter,
      // The Costco receipts page (read-only, the owner's session only): the operator-installed retail tables, read on request.
      createRetailRouter(repo)],
  });

  // Stored market data: one fetcher over the stored closes stands in for the provider chain everywhere.
  const storedQuotes = storedMarketData ? createStoredQuoteFetcher(repo.internalGetDb(), clock) : undefined;
  const intradayBars = storedMarketData ? undefined : options.intradayBars;
  const intradayWeekBars = storedMarketData ? undefined : options.intradayWeekBars;
  app.use('/quotes', createQuotesRouter(repo, storedQuotes));
  app.use('/import', importRouter);
  // /import/from-broker proxies to the portfolio-bridge sidecar (Playwright Firefox).
  app.use('/import', createBrokerImportRouter({ state: repo }));
  app.use('/import', createActivityImportRouter({ state: repo }));
  app.use(createAccountNavRouter({ state: repo }));
  app.use(createCashEventsRouter(repo));
  app.use(createResourceRouter(repo));
  const historyRepo = createHistoryRepo(repo, { storedOnly: storedMarketData });
  const manualPriceRepo = createManualPriceRepo(repo);
  app.use('/symbols', createSymbolsRouter(historyRepo));
  app.use('/portfolio', createPortfolioRouter({
    state: repo, history: historyRepo, manualPrices: manualPriceRepo, intradayBars, intradayWeekBars,
    ...(storedQuotes ? { fetchQuotes: storedQuotes } : {}),
  }));
  app.use(createAccountHistoryRouter({
    state: repo, history: historyRepo, manualPrices: manualPriceRepo, intradayBars, intradayWeekBars,
    ...(storedQuotes ? { fetchQuotes: storedQuotes } : {}),
  }));
  app.use('/manual-prices', createManualPricesRouter(manualPriceRepo));

  // No route matched: a JSON 404 that, unlike Express's own page, does not repeat the path.
  const notFound: RequestHandler = (req, res) => sendRefusal(req, res, 404, 'not-found');
  ambient('after-device', notFound);
  ambient('after-device', jsonErrors(errorLog));
  return { app, auth, users, ...(deviceMount ? { deviceMount } : {}) };
}
