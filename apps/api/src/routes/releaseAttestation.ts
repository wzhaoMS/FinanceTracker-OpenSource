import type { Request, RequestHandler, Router } from 'express';

import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import { isDirectLoopback } from '../ingress/network.js';
import { sendRefusal } from '../ingress/securityHeaders.js';
import type { ReleaseAttestation } from '../release/apiAttestation.js';
import { API_ATTESTATION_PATH } from '../release/codeIdentity.mjs';

/** What the route serves when createApp was given no attestation (tests, helpers): 503, as for a failed computation. */
const NOT_COMPUTED: ReleaseAttestation = Object.freeze({ status: 'unavailable', code: 'attestation-not-computed', ms: 0 });

/** The service principal on a direct loopback connection: the one caller the attestation is for. */
const isAttestationCaller = (req: Request): boolean => req.holdrAuth?.kind === 'service' && isDirectLoopback(req);

/**
 * GET /release/attestation (card-upload migration B-b, ROOT B3): the identity this API computed once at startup
 * (release/apiAttestation.ts), for the uploader's admission gate, which compares it with its release manifest. Identity
 * fields only: never file contents, values, tokens or secrets.
 *
 * Mounted after requireAuth, so a caller without credentials gets the 401 every protected path gives. The ingress makes
 * /release an API path only for direct loopback requests (ingress/classify.ts), and identify honours the service token
 * only on those. This router checks both again itself and refuses anything else as an unknown path (404 not-found, the
 * same bytes the app answers for a path no route serves): a signed-in session, any other principal, and every method
 * but GET, so not even Express's automatic OPTIONS answer names the route. Never 401 for a session, which the web
 * client would take for signed out. It reads no body and no repository.
 *
 * 200 is the attestation's exact bytes, the same on every request. 503 `attestation-unavailable` means it could not be
 * computed at startup; the gate then holds (`api-unavailable`) and everything else keeps working.
 */
export function createReleaseAttestationRouter(attestation: ReleaseAttestation = NOT_COMPUTED): Router {
  const router = createVerifiedRouter();
  const getOnly: RequestHandler = (req, res, next) => {
    if (req.method === 'GET') {
      next();
      return;
    }
    sendRefusal(req, res, 404, 'not-found');
  };
  const releaseAttestation: RequestHandler = (req, res) => {
    if (!isAttestationCaller(req)) {
      sendRefusal(req, res, 404, 'not-found');
      return;
    }
    if (attestation.status !== 'ready') {
      sendRefusal(req, res, 503, 'attestation-unavailable');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(attestation.body));
    res.end(attestation.body);
  };
  router.use(API_ATTESTATION_PATH, getOnly);
  router.get(API_ATTESTATION_PATH, releaseAttestation);
  return router;
}
