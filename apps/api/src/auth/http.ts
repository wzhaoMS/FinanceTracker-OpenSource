import express, { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  DEFAULT_SCRYPT_PARAMS,
  MAX_PASSWORD_LENGTH,
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParams,
} from './password.js';
import { LoginThrottle } from './loginThrottle.js';
import { RecentAuth } from './recentAuth.js';
import { serviceTokenMatches } from './serviceToken.js';
import { AGENT_TOKEN_PATTERN } from './agentToken.js';
import { agentRefusal, maskAccountNumbers } from './agentScope.js';
import { serviceRefusal } from './serviceScope.js';
import { asyncRoute } from '../asyncRoute.js';
import { normalizeUsername, usernameProblem, type LocalAuthRepo } from '../services/localAuthRepo.js';
import { isDirectLoopback, proxyClientAddress } from '../ingress/network.js';
import { sendRefusal } from '../ingress/securityHeaders.js';
import { admissionRefusal, type WebIngressOptions } from '../ingress/types.js';

export { isDirectLoopback, isLoopbackAddress, isLoopbackHost, isProxiedRequest } from '../ingress/network.js';

/**
 * HTTP side of Holdr sign-in:
 *
 *   identify     resolves the caller: service token or agent token (direct loopback only), or session cookie;
 *                the agent token reaches only the read routes in auth/agentScope.ts, with GET and HEAD, and the
 *                service token only the reads and card imports in auth/serviceScope.ts
 *   csrfGuard    every state-changing request needs an allowlisted Origin and, for cookie
 *                sessions, the X-Holdr-Request: 1 header
 *   router       POST /auth/login, POST /auth/logout, GET /auth/me, POST /auth/reverify
 *   requireAuth  everything mounted after it answers 401 (or 503 before the first user exists)
 *   requireRecentAuth  for card sync's sensitive owner routes: this session re-entered its
 *                password (POST /auth/reverify) within the last five minutes, else 403
 *
 * Cookie mode comes from configuration only (`secureCookies`, set when
 * HOLDR_PUBLIC_ORIGIN is https), never from request headers. HTTPS mode uses
 * the `__Host-holdr_session` cookie (Secure, Path=/, no Domain) and honours
 * only sessions that were issued that way.
 */

export const SESSION_COOKIE = 'holdr_session';
export const SECURE_SESSION_COOKIE = '__Host-holdr_session';
export const CSRF_HEADER = 'x-holdr-request';
/** tailscaled sets this on requests from Tailscale Funnel (the public internet) and drops client-sent copies. */
export const FUNNEL_HEADER = 'tailscale-funnel-request';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding renewal writes at most once per interval per session. */
export const SESSION_RENEW_INTERVAL_MS = 60 * 60 * 1000;
export const USER_CLI_COMMAND = 'npm run holdr-user -- add <username>';
export const SETUP_MESSAGE = `No Holdr users exist yet. On the server, run: ${USER_CLI_COMMAND}`;

export type HoldrAuth =
  | { kind: 'session'; userId: string; username: string; sessionId: string }
  | { kind: 'service' }
  /** The read-only agent token (auth/agentToken.ts): GET and HEAD on auth/agentScope.ts's routes only. */
  | { kind: 'agent' };

declare global {
  namespace Express {
    interface Request {
      holdrAuth?: HoldrAuth;
    }
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * The browser's address. The API listens on loopback only, so X-Forwarded-For
 * is trusted only from a loopback peer, and only its last hop (the one the
 * web proxy appended) is used.
 */
export function clientAddress(req: Request): string {
  return req.holdrIngress?.clientAddress ?? proxyClientAddress(req);
}

/** `scheme://host[:port]` for HOLDR_PUBLIC_ORIGIN, or null unless it is exactly an http(s) origin. */
export function parsePublicOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const bare = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    return (url.protocol === 'https:' || url.protocol === 'http:') && bare && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

/** Refuses requests that tailscaled marked as coming from Tailscale Funnel. */
export const rejectFunnel: RequestHandler = (req, res, next) => {
  if (req.headers[FUNNEL_HEADER] !== undefined) {
    res.status(403).json({ error: 'Holdr is not available over Tailscale Funnel' });
    return;
  }
  next();
};

export function readCookie(req: Request, name: string): string | null {
  const header = headerValue(req, 'cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

/** Canonical origins (`scheme://host[:port]`) from a comma-separated WEB_ORIGIN value. */
export function parseAllowedOrigins(value: string): string[] {
  const origins = new Set<string>();
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    try {
      const url = new URL(entry);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      console.warn(`[auth] ignoring invalid WEB_ORIGIN entry ${JSON.stringify(entry)}`);
    }
  }
  return [...origins];
}

function cookieHeader(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** Replace any session cookie this response already carries. */
function setSessionCookie(res: Response, name: string, header: string): void {
  const existing = res.getHeader('Set-Cookie');
  const others = (Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)])
    .filter((cookie) => !cookie.startsWith(`${name}=`));
  res.setHeader('Set-Cookie', [...others, header]);
}

function secondsUntil(expiresAt: string, now: Date): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
}

function logSafe(value: string): string {
  return JSON.stringify(value.slice(0, 64));
}

function setupRequiredBody() {
  return { error: 'Setup required', setupRequired: true, message: SETUP_MESSAGE };
}

export interface AuthOptions {
  users: LocalAuthRepo;
  serviceToken: string;
  /** The read-only agent token (auth/agentToken.ts); unset, no agent token is accepted. */
  agentToken?: string;
  /**
   * A disposable e2e stack (HOLDR_E2E_RUN_ID): the service token may also POST /import/activity-from-broker, which the
   * e2e runner uses to prove that broker pulls cannot leave the stack (auth/serviceScope.ts). Never set otherwise.
   */
  disposableE2e?: boolean;
  allowedOrigins: readonly string[];
  /** HTTPS mode: `__Host-` cookie with Secure; plain-HTTP sessions are not honoured. */
  secureCookies?: boolean;
  ingress?: WebIngressOptions;
  now?: () => Date;
  throttle?: LoginThrottle;
  /** Sessions that re-entered their password recently (POST /auth/reverify). */
  recentAuth?: RecentAuth;
  scryptParams?: ScryptParams;
  sessionTtlMs?: number;
  renewIntervalMs?: number;
  log?: (message: string) => void;
}

export interface HoldrAuthHandlers {
  identify: RequestHandler;
  csrfGuard: RequestHandler;
  requireAuth: RequestHandler;
  requireRecentAuth: RequestHandler;
  /** Revalidate the originally identified session/user/credential epoch at a write boundary; never use cached auth alone. */
  isCurrentSession(req: Request): boolean;
  router: Router;
  throttle: LoginThrottle;
  recentAuth: RecentAuth;
}

export function createAuth(options: AuthOptions): HoldrAuthHandlers {
  const { users, serviceToken, agentToken } = options;
  // The agent token's own format keeps it distinct from the service token, so nothing can mistake one for the other.
  if (agentToken !== undefined && !AGENT_TOKEN_PATTERN.test(agentToken)) {
    throw new Error('the agent token must be holdr_agent_ followed by 64 hex characters (auth/agentToken.ts)');
  }
  const allowedOrigins = new Set(options.allowedOrigins);
  const clock = options.now ?? (() => new Date());
  const throttle = options.throttle ?? new LoginThrottle();
  const recentAuth = options.recentAuth ?? new RecentAuth();
  const scryptParams = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
  const ttlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? SESSION_RENEW_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const secureCookies = options.secureCookies ?? false;
  const cookieName = secureCookies ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  const identified = new WeakMap<Request, { sessionId: string; userId: string; epoch: string }>();
  const writeSessionCookie = (res: Response, value: string, maxAgeSeconds: number) =>
    setSessionCookie(res, cookieName, cookieHeader(cookieName, value, maxAgeSeconds, secureCookies));
  /** Which token a bearer credential is, compared in constant time against both. */
  const bearerPrincipal = (presented: string): 'service' | 'agent' | null => {
    const service = serviceTokenMatches(serviceToken, presented);
    const agent = agentToken !== undefined && serviceTokenMatches(agentToken, presented);
    return service ? 'service' : agent ? 'agent' : null;
  };

  const identify: RequestHandler = (req, res, next) => {
    req.holdrAuth = undefined;
    identified.delete(req);
    const authorization = headerValue(req, 'authorization');
    if (authorization !== undefined) {
      // Explicit credentials never fall back to the cookie.
      const match = /^Bearer +(\S+) *$/i.exec(authorization);
      const principal = match && isDirectLoopback(req) ? bearerPrincipal(match[1]) : null;
      if (!principal) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      if (req.holdrIngress?.profile === 'direct' && options.ingress?.mode !== 'dev') {
        const refused = admissionRefusal(options.ingress?.admission);
        if (refused) return sendRefusal(req, res, 503, refused);
      }
      if (principal === 'agent') {
        // Read-only by construction: before any route runs, the agent token is refused every method but GET and HEAD
        // and every path that is not on its reviewed list (auth/agentScope.ts).
        const refusal = agentRefusal(req.method, req.path);
        if (refusal) {
          res.status(403).json(refusal);
          return;
        }
        maskAccountNumbers(res);
        req.holdrAuth = { kind: 'agent' };
      } else {
        // Reads and card imports only (auth/serviceScope.ts): it can never export the ledger or change investments.
        const refused = serviceRefusal(req.method, req.path, { disposableE2e: options.disposableE2e === true });
        if (refused) {
          res.status(403).json(refused);
          return;
        }
        req.holdrAuth = { kind: 'service' };
      }
      next();
      return;
    }
    if (req.holdrIngress?.profile === 'direct') {
      next();
      return;
    }
    const token = readCookie(req, cookieName);
    if (!token) {
      next();
      return;
    }
    const now = clock();
    const session = users.findSession(token, now, { secureOnly: secureCookies });
    const epoch = session ? users.sessionCredentialEpoch(session.id, session.userId, now, secureCookies) : null;
    if (!session || epoch === null) {
      writeSessionCookie(res, '', 0);
      next();
      return;
    }
    req.holdrAuth = { kind: 'session', userId: session.userId, username: session.username, sessionId: session.id };
    identified.set(req, { sessionId: session.id, userId: session.userId, epoch });
    if (now.getTime() - Date.parse(session.renewedAt) >= renewIntervalMs) {
      const expiresAt = users.renewSession(session.id, ttlMs, now);
      writeSessionCookie(res, token, secondsUntil(expiresAt, now));
    }
    next();
  };

  const csrfGuard: RequestHandler = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = headerValue(req, 'origin');
    const profile = req.holdrIngress?.profile;
    const origins = profile === 'direct' ? new Set<string>()
      : profile === 'serve' ? new Set(options.ingress?.mode === 'dist' ? [options.ingress.publicOrigin] : [])
      : profile === 'local-browser' ? new Set(options.ingress?.mode === 'local'
        ? [`http://127.0.0.1:${options.ingress.ingressPort}`, `http://localhost:${options.ingress.ingressPort}`] : [])
      : allowedOrigins;
    const originAllowed = origin !== undefined && origins.has(origin);
    if (req.holdrAuth?.kind === 'service') {
      // Browsers never attach the bearer token, so only a foreign Origin is suspicious here.
      if (origin !== undefined && !originAllowed) {
        res.status(403).json({ error: 'Cross-origin request rejected' });
        return;
      }
      next();
      return;
    }
    if (!originAllowed) {
      res.status(403).json({ error: origin === undefined ? 'Origin header required' : 'Cross-origin request rejected' });
      return;
    }
    if (headerValue(req, CSRF_HEADER) !== '1') {
      res.status(403).json({ error: 'X-Holdr-Request header required' });
      return;
    }
    next();
  };

  const requireAuth: RequestHandler = (req, res, next) => {
    if (req.holdrAuth) {
      next();
      return;
    }
    if (users.countUsers() === 0) {
      res.status(503).json(setupRequiredBody());
      return;
    }
    res.status(401).json({ error: 'Sign in required' });
  };

  /**
   * Card sync's sensitive owner routes (E1b design §10 items 9 and 14): this
   * session confirmed its password within the last five minutes. 403, never
   * 401: the web client treats any 401 as signed out (§10 item 11).
   */
  const requireRecentAuth: RequestHandler = (req, res, next) => {
    const auth = req.holdrAuth;
    if (auth?.kind !== 'session' || !recentAuth.isRecent(auth.sessionId, clock().getTime())) {
      res.status(403).json({
        error: auth !== undefined && auth.kind !== 'session' ? 'credential-not-allowed' : 'recent-auth-required',
      });
      return;
    }
    next();
  };

  const router = Router();
  router.use(express.json({ limit: '8kb' }));

  router.post('/login', asyncRoute(async (req, res, next) => {
    try {
      const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
      if (
        typeof username !== 'string' || typeof password !== 'string'
        || !username.trim() || !password
        || username.length > 256 || password.length > MAX_PASSWORD_LENGTH
      ) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
      }
      if (users.countUsers() === 0) {
        res.status(503).json(setupRequiredBody());
        return;
      }
      const name = normalizeUsername(username);
      const keys = { ip: clientAddress(req), username: name };
      const decision = throttle.begin(keys, clock().getTime());
      if (!decision.allowed) {
        const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        res.status(429).json({
          error: `Too many sign-in attempts. Try again in ${seconds} seconds.`,
          retryAfterSeconds: seconds,
        });
        return;
      }
      const user = usernameProblem(name) ? null : users.findUser(name);
      // Unknown users still pay for one scrypt so timing does not reveal which names exist.
      const valid = await verifyPassword(password, user?.passwordHash ?? await dummyPasswordHash(scryptParams));
      if (!user || !valid) {
        // Only a user's own name is logged, never what was typed: a password typed into the name box must not reach the log.
        log(`[auth] failed sign-in for ${user ? logSafe(user.username) : 'an unknown user name'} from ${keys.ip}`);
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }
      const rehashed = needsRehash(user.passwordHash, scryptParams)
        ? await hashPassword(password, scryptParams)
        : undefined;
      // The hash was read before scrypt yielded. startSession() rechecks it in the same
      // transaction that creates the session, so a reset or removal meanwhile wins.
      const now = clock();
      const session = users.startSession({
        userId: user.id,
        verifiedPasswordHash: user.passwordHash,
        rehashedPasswordHash: rehashed,
        // Never keep a session id that existed before authentication.
        replaceToken: readCookie(req, cookieName),
        ttlMs,
        now,
        secure: secureCookies,
      });
      if (!session) {
        log(`[auth] sign-in for ${logSafe(user.username)} from ${keys.ip} refused: the password changed during the check`);
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }
      throttle.succeed(keys);
      writeSessionCookie(res, session.token, secondsUntil(session.expiresAt, now));
      log(`[auth] ${user.username} signed in from ${keys.ip}`);
      res.json({ user: { username: user.username } });
    } catch (err) {
      next(err);
    }
  }));

  /**
   * POST /auth/reverify {password}: the signed-in session re-enters its
   * password (the E8-M proposal Q2) and is "recently authenticated" for
   * five minutes. Throttled with sign-in's keys and limits. A wrong password
   * answers 403 `unauthorized`, never 401 (E1b design §10 item 11), and
   * nothing about the session changes; only the session that asked counts.
   */
  router.post('/reverify', asyncRoute(async (req, res, next) => {
    try {
      const auth = req.holdrAuth;
      if (!auth) {
        res.status(users.countUsers() === 0 ? 503 : 401).json(users.countUsers() === 0 ? setupRequiredBody() : { error: 'Sign in required' });
        return;
      }
      if (auth.kind !== 'session') {
        res.status(403).json({ error: 'credential-not-allowed' });
        return;
      }
      const body = req.body as unknown;
      const password = typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 1
        ? (body as { password?: unknown }).password : undefined;
      if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
        res.status(400).json({ error: 'bad-request' });
        return;
      }
      const keys = { ip: clientAddress(req), username: normalizeUsername(auth.username) };
      const decision = throttle.begin(keys, clock().getTime());
      if (!decision.allowed) {
        const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        res.status(429).json({ error: 'rate-limited', retryAfterSeconds: seconds });
        return;
      }
      const user = usernameProblem(keys.username) ? null : users.findUser(keys.username);
      const valid = await verifyPassword(password, user?.passwordHash ?? await dummyPasswordHash(scryptParams));
      if (!user || user.id !== auth.userId || !valid) {
        log(`[auth] failed password re-check for ${logSafe(keys.username)} from ${keys.ip}`);
        res.status(403).json({ error: 'unauthorized' });
        return;
      }
      throttle.succeed(keys);
      const until = recentAuth.confirm(auth.sessionId, clock().getTime());
      res.json({ verifiedUntil: new Date(until).toISOString() });
    } catch (err) {
      next(err);
    }
  }));

  router.post('/logout', (req, res) => {
    if (req.holdrAuth?.kind === 'session') recentAuth.forget(req.holdrAuth.sessionId);
    const token = readCookie(req, cookieName);
    if (token) users.deleteSession(token);
    writeSessionCookie(res, '', 0);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    const auth = req.holdrAuth;
    if (auth?.kind === 'session') {
      res.json({ user: { username: auth.username } });
      return;
    }
    if (auth?.kind === 'service') {
      res.json({ service: true });
      return;
    }
    res.status(401).json(users.countUsers() === 0
      ? { ...setupRequiredBody(), error: 'Sign in required' }
      : { error: 'Sign in required' });
  });

  const isCurrentSession = (req: Request): boolean => {
    const original = identified.get(req);
    const auth = req.holdrAuth;
    return original !== undefined && auth?.kind === 'session' && auth.sessionId === original.sessionId && auth.userId === original.userId
      && users.sessionCredentialEpoch(original.sessionId, original.userId, clock(), secureCookies) === original.epoch;
  };
  return { identify, csrfGuard, requireAuth, requireRecentAuth, isCurrentSession, router, throttle, recentAuth };
}
