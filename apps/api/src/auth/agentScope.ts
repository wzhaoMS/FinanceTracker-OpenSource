import type { Response } from 'express';

/**
 * What the agent principal may do (auth/agentToken.ts): read, and only the routes listed here. identify (auth/http.ts)
 * checks every agent request against this list before any route runs: a method other than GET and HEAD answers 403
 * `agent-read-only`, a path that is not listed answers 403 `agent-route-not-allowed` whether or not a route serves it,
 * so a refusal says nothing about which paths exist. Card spending's guard checks again (auth/serviceScope.ts).
 *
 * The list is reviewed by hand: a route is on it because it only reads the household's finances. A new route stays
 * closed to agents until someone reviews it and adds it here (with a test in agentPrincipal.test.ts). Left out on purpose:
 *
 *   /auth/...                        sign-in, sign-out, password re-checks and who is signed in
 *   /export                          the whole ledger in one download, as good as a backup
 *   /card-imports/...                card imports, their cutover capability and their receipts
 *   /card-sync/...                   card sync's owner routes: pairing, devices, plans, runs and their payloads
 *   /release/...                     the release attestation, for the hardened deployment's uploader
 *   /amazon/..., /retail/...         Amazon orders and Costco receipts, which answer the signed-in owner only
 *   /spending/rules/preview          a helper for writing categorization rules, which an agent cannot do
 *   /metals/sources/roster/preview   the gold and silver import roster and its digests
 *   /import/..., and every route that only changes data
 *
 * What an agent reads comes back as a signed-in person sees it, with one change: investment account numbers are masked
 * to their last four characters (maskAccountNumbers). Card, checking and cash routes show only the last digits anyway.
 */
export const AGENT_READ_ROUTES: readonly string[] = Object.freeze([
  '/health',
  // Investments: accounts (brokerage, IRA, 401(k), HSA), trades, cash, prices and performance.
  '/accounts',
  '/accounts/:id/transactions',
  '/accounts/:id/history',
  '/accounts/:id/nav-history',
  '/accounts/:id/cash-events',
  '/accounts/:id/cash-history',
  '/transactions',
  '/transactions/:id/cost-basis-check',
  '/cash-events',
  '/quotes',
  '/symbols/:symbol/history',
  '/portfolio/history',
  '/portfolio/performance',
  '/manual-prices',
  '/manual-prices/:symbol',
  // Cards and spending: cards, transactions, spending reports, benefits and forecasts.
  '/card-accounts',
  '/card-transactions',
  '/card-transactions/:id',
  '/spending/summary',
  '/spending/insights',
  '/spending/coverage',
  '/spending/coverage/months',
  '/spending/accounting',
  '/spending/trend',
  '/spending/compare',
  '/spending/forecast',
  '/spending/patterns',
  '/spending/benefits',
  '/spending/card-openings',
  '/spending/payment-reconciliation',
  '/spending/payment-reconciliation/payments/:id',
  '/spending/balance-chains',
  // Checking accounts and the card payment schedule.
  '/checking/accounts',
  '/checking/transactions',
  '/cash/payments',
  '/cash/owed',
  // Gold and silver.
  '/metals/overview',
  '/metals/purchases',
  '/metals/sales',
  '/metals/timeline',
  '/metals/closes',
  '/metals/products',
  '/metals/funding',
  '/metals/answers',
  '/metals/card-check',
]);

export const AGENT_READ_ONLY_CODE = 'agent-read-only';
export const AGENT_ROUTE_CODE = 'agent-route-not-allowed';

export interface AgentRefusal {
  error: string;
  code: typeof AGENT_READ_ONLY_CODE | typeof AGENT_ROUTE_CODE;
}

const READ_METHODS = new Set(['GET', 'HEAD']);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * A test for request paths (without their query) against route templates such as `/accounts/:id/history`, matched the
 * way Express matches routes: any case, one optional trailing slash, a parameter is one whole segment.
 */
export function routeMatcher(templates: readonly string[]): (path: string) => boolean {
  const patterns = templates.map((template) => new RegExp(
    `^${template.split('/').map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment))).join('/')}/?$`, 'i'));
  return (path) => patterns.some((pattern) => pattern.test(path));
}

const isAgentReadPath = routeMatcher(AGENT_READ_ROUTES);

/** Null when the agent principal may send `method` to `path` (the request path, without its query); else the 403 body. */
export function agentRefusal(method: string, path: string): AgentRefusal | null {
  if (!READ_METHODS.has(method)) {
    return { error: 'the agent token is read-only: it may only send GET and HEAD requests', code: AGENT_READ_ONLY_CODE };
  }
  if (!isAgentReadPath(path)) {
    return { error: 'the agent token may not read this route', code: AGENT_ROUTE_CODE };
  }
  return null;
}

/** `Z7418763` becomes `***8763`: the last four letters or digits, as Holdr's MCP server shows them. */
export function maskAccountNumber(value: string): string {
  return `***${value.replace(/[^0-9A-Za-z]/g, '').slice(-4)}`;
}

/** A copy of a JSON value with every string property named `accountNumber` masked. */
function maskedJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? value : JSON.parse(text, (key, item: unknown) =>
    (key === 'accountNumber' && typeof item === 'string' ? maskAccountNumber(item) : item));
}

/**
 * Masks every string property named `accountNumber` in what `res` sends: JSON from res.json (and res.send with an object,
 * which calls it), and a string or Buffer body sent with res.send, such as the JSON text /spending/balance-chains sends.
 * A string or Buffer body that is not JSON cannot be masked: it is replaced by a fixed 500 when it holds a digit, and sent
 * as it is otherwise (the status texts of res.sendStatus). identify applies it to every agent request, so a route added
 * to the list later cannot hand an agent a full account number by mistake. Streams and res.end bypass it: no route on the
 * list answers that way (agentPrincipal.test.ts reads every one).
 */
export function maskAccountNumbers(res: Response): void {
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  // res.json stringifies and calls res.send: what it sends is masked already.
  let sendingJson = false;
  const sendJson = (body: unknown) => {
    sendingJson = true;
    try {
      return json(body);
    } finally {
      sendingJson = false;
    }
  };
  res.json = ((body?: unknown) => sendJson(body === undefined ? body : maskedJson(body))) as Response['json'];
  res.send = ((body?: unknown) => {
    if (sendingJson || !(typeof body === 'string' || Buffer.isBuffer(body))) return send(body);
    const text = typeof body === 'string' ? body : body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!/\d/.test(text)) return send(body);
      res.status(500).type('application/json');
      return sendJson({ error: 'Internal server error' });
    }
    const masked = JSON.stringify(maskedJson(parsed));
    return send(typeof body === 'string' ? masked : Buffer.from(masked, 'utf8'));
  }) as Response['send'];
}
