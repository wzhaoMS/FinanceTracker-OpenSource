import { Router } from 'express';
import type { Account } from '@finance-tracker/shared';
import { lastFour } from '@finance-tracker/shared';

import { mapTableToTransactions, type RawRow } from '../services/importMapper.js';
import { asyncRoute } from '../asyncRoute.js';

/**
 * POST /import/from-broker
 *
 * Body: { accountId?: string, broker: 'schwab' | 'fidelity' | ..., asOf?: string }
 *
 * Proxies to the portfolio-bridge sidecar (default 127.0.0.1:3003), which
 * opens a real Firefox window so the user can log in. The bridge returns a
 * { headers, rows } table. Behavior splits on whether the table contains
 * per-row `_section` markers (set when the broker page shows multiple
 * accounts on one page, e.g. Fidelity):
 *
 *   - No `_section`: legacy single-account flow. accountId is required;
 *     we return one preview shaped exactly like POST /import/positions.
 *   - With `_section`: per-section flow. We split rows by section, run
 *     importMapper on each, and fuzzy-match each section label to an
 *     existing account from the DB so the UI can suggest a target. The
 *     client commits each section explicitly to avoid mixing accounts.
 */

export interface CreateBrokerImportRouterOptions {
  /** Override for tests. Defaults to env BROKER_BRIDGE_URL or 127.0.0.1:3003. */
  bridgeUrl?: string;
  /** Override for tests so we don't need a real network. */
  fetchImpl?: typeof fetch;
  /**
   * State repo used for account matching. When omitted, account-matching
   * is disabled and per-section previews come back with no suggestion.
   * Tests pass a stub.
   */
  state?: { listAccounts: () => Account[] };
}

export function createBrokerImportRouter(opts: CreateBrokerImportRouterOptions = {}) {
  const bridgeUrl =
    opts.bridgeUrl ?? process.env.BROKER_BRIDGE_URL ?? 'http://127.0.0.1:3003';
  const doFetch = opts.fetchImpl ?? fetch;
  const state = opts.state;

  const router = Router();

  /**
   * Shared handler for `/from-broker` and `/from-bookmarklet`. Both
   * routes accept the same { accountId?, broker, asOf? } body shape
   * and produce the same response shape. They differ only in which
   * bridge endpoint they hit:
   *   /from-broker      → bridge /extract            (launch Firefox)
   *   /from-bookmarklet → bridge /extract-bookmarklet (drain stored)
   *
   * `bridgePath` is the bridge endpoint to call. `bridgeNotReadyHint`
   * is the user-facing hint shown if the bridge says "no data yet"
   * (404 from /extract-bookmarklet when the user hasn't clicked the
   * bookmarklet yet).
   */
  const runImport = async (
    req: any,
    res: any,
    bridgePath: '/extract' | '/extract-bookmarklet',
    bridgeNotReadyHint: string,
  ) => {
    const { accountId, broker, asOf } = req.body ?? {};
    if (typeof broker !== 'string' || !broker.trim()) {
      return res.status(400).json({ error: 'broker is required' });
    }
    const date =
      typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
        ? asOf
        : new Date().toISOString().slice(0, 10);

    let bridgeRes: Response;
    try {
      bridgeRes = await doFetch(`${bridgeUrl}${bridgePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker }),
      });
    } catch (err) {
      // Bridge process not running, network error, etc. Most common cause
      // by far: the user hasn't started the sidecar.
      return res.status(502).json({
        error: `bridge unreachable at ${bridgeUrl}: ${(err as Error).message}`,
        hint: 'start it with: .venv/bin/python apps/portfolio-bridge/server.py',
      });
    }

    let bridgeJson: any;
    try {
      bridgeJson = await bridgeRes.json();
    } catch {
      return res.status(502).json({ error: `bridge returned non-JSON (status ${bridgeRes.status})` });
    }

    // Bookmarklet path: 404 from the bridge means "no capture yet" —
    // surface the install hint so the user knows where to click.
    if (bridgeRes.status === 404 && bridgePath === '/extract-bookmarklet') {
      return res.status(404).json({
        error: bridgeJson?.error ?? 'no bookmarklet capture yet',
        hint: bridgeNotReadyHint,
      });
    }

    if (!bridgeRes.ok) {
      return res.status(bridgeRes.status).json({
        error: bridgeJson?.error ?? `bridge error ${bridgeRes.status}`,
        bridge: bridgeJson,
      });
    }

    if (bridgeJson?.loggedIn === false) {
      return res.status(504).json({
        error: 'login timed out — finish logging in before the timeout next time',
        bridge: bridgeJson,
      });
    }

    const table = bridgeJson?.table;
    if (
      !table ||
      !Array.isArray(table.headers) ||
      !Array.isArray(table.rows)
    ) {
      return res.status(502).json({
        error: 'bridge response missing table.headers / table.rows',
        bridge: bridgeJson,
      });
    }

    const headers = table.headers as string[];
    const rows = table.rows as Array<RawRow & { _section?: string }>;
    const hasSections = rows.some((r) => typeof r._section === 'string' && r._section);

    const sourceMeta = {
      broker,
      sourceUrl: bridgeJson?.sourceUrl ?? null,
      tableCount: bridgeJson?.tableCount ?? null,
      candidateCount: bridgeJson?.candidateCount ?? null,
    };

    if (!hasSections) {
      // Legacy single-account flow: behaves identically to /import/positions.
      if (typeof accountId !== 'string' || !accountId.trim()) {
        return res.status(400).json({
          error: 'accountId is required (the broker did not return per-section data, so the API cannot guess)',
        });
      }
      const result = mapTableToTransactions(accountId, date, headers, rows);
      return res.json({ ...result, source: sourceMeta });
    }

    // Per-section flow. Split rows by their `_section` annotation and run
    // the mapper on each chunk so transactions stay grouped by account.
    const accounts = state ? state.listAccounts() : [];
    const groups = new Map<string, Array<RawRow & { _section?: string }>>();
    const order: string[] = [];
    for (const row of rows) {
      const section = (row._section ?? '').trim();
      if (!groups.has(section)) {
        groups.set(section, []);
        order.push(section);
      }
      groups.get(section)!.push(row);
    }

    const previews = order.map((section) => {
      const groupRows = groups.get(section)!;
      // accountId hint is irrelevant per-section — we'll attach the
      // suggested-match account id below (or leave null).
      const placeholderId = '__pending__';
      const result = mapTableToTransactions(placeholderId, date, headers, groupRows);
      // Strip the placeholder so the UI can't accidentally commit before
      // assignment.
      const transactions = result.transactions.map((t) => ({
        ...t,
        accountId: '',
      }));
      const suggestion = matchAccount(section, accounts);
      return {
        section,
        suggestion,
        transactions,
        rejected: result.rejected,
        mapping: result.mapping,
      };
    });

    // Cross-owner safety net: if MOST sections in this pull confidently
    // match accounts owned by one person (per the convention
    // "<Owner> · <something>"), don't suggest a DIFFERENT owner's account
    // for the outliers — even when the fuzzy score is high. Alex logging
    // into Alex's Fidelity should never see "Casey · Microsoft 401K Plan"
    // pre-selected just because the section name happens to share tokens
    // with a Casey account. Better to show no suggestion and let the
    // user pick than to commit to the wrong household member.
    const dominantOwner = pickDominantOwner(previews, accounts);
    if (dominantOwner) {
      for (const p of previews) {
        if (!p.suggestion) continue;
        const acc = accounts.find((a) => a.id === p.suggestion!.accountId);
        const owner = ownerFromName(acc?.name);
        if (owner && owner !== dominantOwner) {
          // High confidence isn't enough when it crosses owners.
          // Last-4 hard match (confidence === 1) IS enough — that's
          // unique by construction.
          if (p.suggestion.confidence < 1) {
            p.suggestion = null;
          }
        }
      }
    }

    return res.json({
      previews,
      source: sourceMeta,
      // Pass the account list back too so the UI can build the dropdown
      // from the same source-of-truth and save a separate API call.
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        accountNumber: a.accountNumber,
      })),
    });
  };

  router.post('/from-broker', asyncRoute((req, res) =>
    runImport(
      req,
      res,
      '/extract',
      'start the bridge with `.venv/bin/python apps/portfolio-bridge/server.py`',
    ),
  ));

  // Bookmarklet flow: same response shape as /from-broker. The bridge's
  // /extract-bookmarklet endpoint drains the latest capture made by the
  // bookmarklet (which the user clicked on the broker tab beforehand).
  router.post('/from-bookmarklet', asyncRoute((req, res) =>
    runImport(
      req,
      res,
      '/extract-bookmarklet',
      'open the broker tab, click the "Capture to Holdr" bookmark, then try again',
    ),
  ));

  return router;
}

/**
 * Common financial-account acronyms expanded both ways so the section
 * label and the user's account name don't have to use the same form.
 * Without this, "Health Savings Account 413382685" and
 * "Alex · Fidelity HSA" share zero tokens.
 *
 * The replacement adds the alternate form alongside the original (it does
 * not remove anything) so other tokens still count.
 */
const ACRONYM_ALIASES: Array<[RegExp, string]> = [
  [/\bHSA\b/gi, 'HSA Health Savings Account'],
  [/\bHealth\s+Savings\s+Account\b/gi, 'HSA Health Savings Account'],
  [/\bIRA\b/gi, 'IRA Individual Retirement Account'],
  [/\bIndividual\s+Retirement\s+Account\b/gi, 'IRA Individual Retirement Account'],
  [/\b401\s*\(?k\)?\b/gi, '401k Retirement'],
  [/\bTOD\b/gi, 'TOD Transfer On Death'],
  [/\bESA\b/gi, 'ESA Education Savings Account'],
];

function expandAcronyms(s: string): string {
  let out = s;
  for (const [re, repl] of ACRONYM_ALIASES) out = out.replace(re, repl);
  return out;
}

/**
 * Tokenize a string into lowercase alphanumeric "words" of length ≥ 2.
 * Drops single-character noise so a section like "Alex · Fidelity Roth IRA"
 * doesn't get matched on stray "I"s. Used for both the broker section
 * label AND each candidate account name so the comparison is symmetric.
 */
function tokens(s: string): Set<string> {
  return new Set(
    (expandAcronyms(s).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2),
  );
}

/**
 * Score how strongly a broker section label matches an account name. We use
 * a weighted Jaccard-ish overlap so a section like "ROTH IRA 191596741"
 * matches "Alex · Fidelity Roth IRA" even though the account name has extra
 * tokens (Alex, Fidelity). Exposed for tests.
 *
 * Returns a number in [0, 1]. Values ≥ 0.4 are usually correct in practice.
 */
export function scoreMatch(section: string, accountName: string): number {
  const a = tokens(section);
  const b = tokens(accountName);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  // Reward intersection size relative to the SMALLER side. Sections from
  // brokers tend to be terse ("ROTH IRA 191596741"); accounts in our DB
  // are richer ("Alex · Fidelity Roth IRA"). We don't want to penalize an
  // account for having extra contextual tokens.
  const minSize = Math.min(a.size, b.size);
  return shared / Math.max(minSize, 1);
}

/**
 * Pick the best account for a given broker section label, with a confidence
 * score. Returns `null` when no candidate scores high enough — better to
 * make the user pick than to pre-fill the wrong account silently.
 *
 * Rule order:
 *   1. If the section label contains a recognizable last-4 (≥4 alphanumeric
 *      chars) AND exactly one stored account has the same last-4 in its
 *      `accountNumber`, return that account with confidence 1.0. This is
 *      the deterministic path: account numbers are unique across owners,
 *      so it cleanly disambiguates "Alex's Fidelity HSA" from "Casey's
 *      Fidelity HSA".
 *   2. Otherwise, fall back to the fuzzy token-overlap score.
 */
export function matchAccount(
  section: string,
  accounts: Pick<Account, 'id' | 'name' | 'accountNumber'>[],
): { accountId: string; accountName: string; confidence: number } | null {
  // Hard-match path: section's last-4 against stored accountNumber's last-4.
  const sectionTail = lastFour(section);
  if (sectionTail) {
    const hits = accounts.filter((a) => lastFour(a.accountNumber) === sectionTail);
    if (hits.length === 1) {
      return { accountId: hits[0].id, accountName: hits[0].name, confidence: 1.0 };
    }
    // If two accounts collide on the same last-4 (extremely rare), fall
    // through to fuzzy match — the token overlap will tie-break on the
    // friendly name.
  }

  let best: { accountId: string; accountName: string; confidence: number } | null = null;
  for (const acc of accounts) {
    const conf = scoreMatch(section, acc.name);
    if (conf > 0 && (!best || conf > best.confidence)) {
      best = { accountId: acc.id, accountName: acc.name, confidence: conf };
    }
  }
  // Threshold: at least 2/3 of section tokens must overlap. Below that
  // we'd rather show an empty dropdown than a misleading suggestion.
  if (!best || best.confidence < 0.5) return null;
  return best;
}

/**
 * Extract the leading owner token from an account name. Account names in
 * this codebase follow the convention "<Owner> · <Broker> <Type>" (e.g.
 * "Alex · Fidelity Roth IRA"). We treat everything before the first ` · `
 * as the owner. Returns null when the name doesn't fit the convention,
 * so we don't accidentally cluster on something that isn't an owner.
 */
export function ownerFromName(name: string | undefined): string | null {
  if (!name) return null;
  const idx = name.indexOf(' · ');
  if (idx <= 0) return null;
  const owner = name.slice(0, idx).trim();
  return owner || null;
}

/**
 * Decide which household member "owns" this multi-section pull. We count
 * how many sections confidently match each owner and return the owner
 * with a strict majority (> half of suggestion-bearing sections). Returns
 * null when no clear majority exists — falling back to the per-section
 * fuzzy match without applying the cross-owner safety rule.
 */
export function pickDominantOwner<S extends { suggestion: { accountId: string } | null }>(
  previews: S[],
  accounts: Pick<Account, 'id' | 'name'>[],
): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const p of previews) {
    if (!p.suggestion) continue;
    const acc = accounts.find((a) => a.id === p.suggestion!.accountId);
    const owner = ownerFromName(acc?.name);
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
    total += 1;
  }
  if (total < 2) return null; // need at least 2 anchors to call a majority
  let best: { owner: string; n: number } | null = null;
  for (const [owner, n] of counts.entries()) {
    if (!best || n > best.n) best = { owner, n };
  }
  if (!best) return null;
  // Strict majority — half-and-half is ambiguous (could be a joint pull).
  return best.n * 2 > total ? best.owner : null;
}
