import type { RequestHandler } from 'express';

import { AGENT_READ_ROUTES, agentRefusal, routeMatcher } from './agentScope.js';

/**
 * What the service principal (the service token, accepted only from direct loopback callers; auth/http.ts) may do. It is
 * for local programs that import card statements, chiefly the card sync agent (agents/card-sync): it may read and run
 * card imports, and nothing else. identify (auth/http.ts) checks every service request against these lists before any
 * route runs, and card spending's guard (cardSpendingAuth below) checks again; anything else answers 403
 * `principal-not-allowed`, so a route added later stays closed to the service token until it is reviewed and listed here
 * (with a test in servicePrincipal.test.ts). Each entry, and who needs it:
 *
 *   GET, HEAD on every route an agent may read (auth/agentScope.ts)
 *                    the card sync agent reads /health, /card-accounts and /spending/coverage; the disposable e2e runner
 *                    (scripts/e2e-disposable.mjs) reads /health and /accounts; nothing on that list changes anything
 *   GET /auth/me     answers { service: true }, so a script can tell that its token works
 *   GET /release/attestation
 *                    the release attestation, for the service token only (routes/releaseAttestation.ts): the hardened
 *                    macOS deployment's uploader reads it
 *   card imports     POST /card-imports/preview, /card-imports/commit and /card-imports/cutover-commit, with the cutover's
 *                    reads GET /card-imports/cutover-capability and /card-imports/cutover-receipt: v1 card imports, as
 *                    decided for card sync (E1b Q44). The card sync agent previews; the rest is its import flow.
 *   POST /import/activity-from-broker, on a disposable e2e stack only (HOLDR_E2E_RUN_ID)
 *                    the e2e runner proves with it that a broker pull cannot leave the stack before any test runs
 *
 * Refused, among everything else: the full export (/export), every change to investment accounts, trades, cash events and
 * manual prices, the investment imports (/import/...), card accounts and card transactions, benefits, rules and other
 * settings, the metals import roster (/metals/sources/roster/preview), and sign-in.
 *
 * Some routes answer every caller but their own themselves, with established refusals: card sync (/card-sync/..., 403
 * `credential-not-allowed`, Q44), Amazon orders and Costco receipts (/amazon/..., /retail/..., the owner's session only,
 * 403 `principal-not-allowed`), the release attestation (/release/..., an unknown path, 404, for every method but GET)
 * and the password re-check (POST /auth/reverify, the owner's session only, 403 `credential-not-allowed`). The service
 * principal is let through to them so that those answers stay as they are; none admits it beyond what is listed above
 * (servicePrincipal.test.ts checks every one).
 */

export const SERVICE_SCOPE_CODE = 'principal-not-allowed';
export const SERVICE_SCOPE_MESSAGE =
  'the service token may only read and import card statements through /card-imports/preview, /card-imports/commit and '
  + '/card-imports/cutover-commit';
/** The names card spending's callers know. */
export const SERVICE_CARD_SCOPE_CODE = SERVICE_SCOPE_CODE;
export const SERVICE_CARD_SCOPE_MESSAGE = SERVICE_SCOPE_MESSAGE;

/** What the service principal may read with GET and HEAD: the agent's reviewed reads, and its own. */
export const SERVICE_READ_ROUTES: readonly string[] = Object.freeze([
  ...AGENT_READ_ROUTES,
  '/auth/me',
  '/release/attestation',
  '/card-imports/cutover-capability',
  '/card-imports/cutover-receipt',
]);

/** What the service principal may POST: v1 card imports. */
export const SERVICE_IMPORT_ROUTES: readonly string[] = Object.freeze([
  '/card-imports/preview',
  '/card-imports/commit',
  '/card-imports/cutover-commit',
]);

/** What the service principal may also POST on a disposable e2e stack (HOLDR_E2E_RUN_ID), and nowhere else. */
export const SERVICE_E2E_ROUTES: readonly string[] = Object.freeze(['/import/activity-from-broker']);

/** The route families that answer the service principal themselves (see above). */
export const SERVICE_SELF_GUARDED_PREFIXES: readonly string[] = Object.freeze(['/card-sync', '/amazon', '/retail', '/release']);
/** The single routes that answer it themselves. */
export const SERVICE_SELF_GUARDED_ROUTES: readonly string[] = Object.freeze(['/auth/reverify']);

export interface ServiceRefusal {
  error: string;
  code: typeof SERVICE_SCOPE_CODE;
}

export interface ServiceScopeOptions {
  /** A disposable e2e stack (HOLDR_E2E_RUN_ID): SERVICE_E2E_ROUTES are allowed too. */
  disposableE2e?: boolean;
}

const READ_METHODS = new Set(['GET', 'HEAD']);
const isServiceRead = routeMatcher(SERVICE_READ_ROUTES);
const isServiceImport = routeMatcher(SERVICE_IMPORT_ROUTES);
const isServiceE2e = routeMatcher(SERVICE_E2E_ROUTES);
const isSelfGuardedRoute = routeMatcher(SERVICE_SELF_GUARDED_ROUTES);
const SELF_GUARDED = new RegExp(`^(?:${SERVICE_SELF_GUARDED_PREFIXES.map((prefix) => prefix.replace(/[-/]/g, '\\$&')).join('|')})(?:/|$)`, 'i');

/** Null when the service principal may send `method` to `path` (the request path, without its query); else the 403 body. */
export function serviceRefusal(method: string, path: string, options: ServiceScopeOptions = {}): ServiceRefusal | null {
  if (SELF_GUARDED.test(path) || isSelfGuardedRoute(path)) return null;
  if (READ_METHODS.has(method) && isServiceRead(path)) return null;
  if (method === 'POST' && (isServiceImport(path) || (options.disposableE2e === true && isServiceE2e(path)))) return null;
  return { error: SERVICE_SCOPE_MESSAGE, code: SERVICE_SCOPE_CODE };
}

/** True when the service principal may send `method` to the card spending `path`. */
export function serviceMayUseCardRoute(method: string, path: string): boolean {
  return serviceRefusal(method, path) === null;
}

/**
 * The authentication middleware for card spending routes: `requireAuth`
 * first, then the service and agent principals' limits, again: identify
 * checked both before any route ran. mountCardSpendingRoutes runs it for
 * every card spending path before anything reads a body or the repository.
 */
export function cardSpendingAuth(requireAuth: RequestHandler): RequestHandler {
  return (req, res, next) => {
    requireAuth(req, res, (error?: unknown) => {
      if (error !== undefined) {
        next(error);
        return;
      }
      if (req.holdrAuth?.kind === 'service' && !serviceMayUseCardRoute(req.method, req.path)) {
        res.status(403).json({ error: SERVICE_CARD_SCOPE_MESSAGE, code: SERVICE_CARD_SCOPE_CODE });
        return;
      }
      const agentRefused = req.holdrAuth?.kind === 'agent' ? agentRefusal(req.method, req.path) : null;
      if (agentRefused) {
        res.status(403).json(agentRefused);
        return;
      }
      next();
    });
  };
}
