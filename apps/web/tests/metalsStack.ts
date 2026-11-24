import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCardImportPayload, serializeCardImportPayload } from '@finance-tracker/shared';
import type { MetalsProduct, MetalsProductScope, MetalsProducts } from '@finance-tracker/shared/metals-api';
import { serializeMetalsImportPayload, type MetalsImportPayload } from '@finance-tracker/shared/metals-ledger';

import {
  COSTCO_PRODUCT_TITLE,
  GOLD_CARD_LAST4,
  GOLD_CARD_NICKNAME,
  WALMART_ROW,
  goldLedgerPayloads,
  shiftDate,
  type GoldLedgerPayloads,
} from '../src/components/gold/goldLedgerSeed';
import { expect, type APIRequestContext } from './fixtures';

/**
 * Loads the Gold page's synthetic precious-metals ledger (src/components/gold/goldLedgerSeed.ts) on this run's
 * disposable database through the operator's own commands, G2's holdr-metals: plan, a synthetic Root GO (copy-rehearsal),
 * install, the identity pin of each new account (identity-key, identity-register, identity-digest: #324), import,
 * bindings; as spending-card-openings.e2e.ts installs card openings. The disposable seed stores closes
 * (apps/api/src/e2e/syntheticSeed.ts), but nothing is fetched (HOLDR_METALS_PRICES stays unset), so they value nothing
 * (ROOT O110): a Holdr that fetches closes is served in the browser (goldPricesOn.ts).
 */

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
/** holdr-metals itself, as `npm run holdr-metals` runs it from apps/api. */
const METALS_MAIN = 'src/cli/metalsMain.ts';
/** Its own identity-register, on a stand-in terminal typing a synthetic Costco last 4 (tests/metalsIdentityRegister.ts). */
const TYPED_REGISTER = fileURLToPath(new URL('./metalsIdentityRegister.ts', import.meta.url));
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };
const STATE_FILE = 'metals-stack.json';
const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

export interface MetalsStack {
  /** Today in New York when the stack was loaded: every date of the ledger is relative to it. */
  today: string;
  cardAccountId: string;
  accounts: Record<'costco' | 'walmart' | 'collectpure', string>;
  dates: GoldLedgerPayloads['dates'];
}

/** This run's own disposable directory (scripts/e2e-disposable.mjs makes each run-…/ and its data/), never another. */
export function runDir(): string {
  const auth = process.env.HOLDR_E2E_AUTH_STATE;
  const dir = auth ? path.dirname(auth) : '';
  if (!auth || !path.basename(dir).startsWith('run-')) throw new Error('the metals ledger needs a disposable run (npm run test:e2e)');
  return dir;
}

/**
 * The operator's command, on this run's database only: one JSON line out, its code among `accept`. `entry` is holdr-metals
 * itself, or tests/metalsIdentityRegister.ts for the one Costco registration.
 */
function cli(args: string[], accept: readonly string[], entry = METALS_MAIN): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOLDR_CONFIG: 'none' };
  for (const name of ['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD', 'HOLDR_METALS_PRICES']) delete env[name];
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { cwd: API_DIR, env, encoding: 'utf8' });
  const line = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}';
  const out = JSON.parse(line) as Record<string, unknown>;
  expect(accept, `holdr-metals ${args.slice(0, 2).join(' ')}: ${result.stderr}${line}`).toContain(out.code);
  return out;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A synthetic Root GO for this run's database, as copy-rehearsal, written owner-only in the run directory; removed after. */
function withGo<T>(dir: string, command: string, plan: Record<string, unknown>, extra: Record<string, unknown>, use: (file: string) => T): T {
  const file = path.join(dir, `metals-go-${command}-${hex(4)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    format: 'holdr.metals-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command,
    goId: hex(16), databaseRef: plan.databaseRef, schemaDigest: plan.schemaDigest, ...extra,
  }), { mode: 0o600 });
  try {
    return use(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
const backupFile = (dir: string) => path.join(dir, `before-metals-${hex(4)}.db`);

/** The approved card and its rows: a Walmart charge for the linked bar, and one for the 10 g bar whose link a conflict removes. */
async function cardWithRows(request: APIRequestContext, ledger: GoldLedgerPayloads, today: string): Promise<string> {
  const listed = await request.get('/card-accounts');
  expect(listed.status()).toBe(200);
  const { cardAccounts } = await listed.json() as { cardAccounts: Array<{ id: string; nickname?: string | null; last4?: string | null }> };
  const existing = cardAccounts.find((item) => item.nickname === GOLD_CARD_NICKNAME && item.last4 === GOLD_CARD_LAST4);
  if (existing) return existing.id;
  const created = await request.post('/card-accounts', {
    headers: MUTATION_HEADERS, data: { issuer: 'chase', owner: 'joint', nickname: GOLD_CARD_NICKNAME, last4: GOLD_CARD_LAST4, currency: 'USD' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json() as { id: string };
  const statement = serializeCardImportPayload(buildCardImportPayload({
    source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'chase', currency: 'USD',
    coverage: { start: shiftDate(today, -160), end: shiftDate(today, -1) },
    rows: ledger.cardRows.map((row) => ({ ...row, kind: 'purchase', description: WALMART_ROW, issuerCategory: 'Shopping' })),
  }).payload);
  const committed = await request.post(`/card-imports/commit?cardAccountId=${id}`, { headers: MUTATION_HEADERS, data: statement });
  expect(committed.status(), await committed.text()).toBe(201);
  return id;
}

/**
 * One payload through `import`, as canonical bytes; returns the source account's id. A new account's GO pins its identity,
 * and `identity` names the owner-only key and registry the pin is checked against (identityPins); an import into an
 * existing account takes neither.
 */
function importPayload(dir: string, database: string, plan: Record<string, unknown>, name: string, payload: MetalsImportPayload,
  account: { label: string; identityDigest: string } | { accountId: string }, identity: readonly string[] = []): string {
  const bytes = Buffer.from(serializeMetalsImportPayload(payload), 'utf8');
  const file = path.join(dir, `metals-${name}-${hex(4)}.json`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  try {
    return withGo(dir, 'import', plan, { inputSha256: sha256(bytes), account }, (go) => String(cli(
      ['import', '--db', database, '--payload', file, '--go', go, '--backup', backupFile(dir), ...identity],
      ['metals-imported', 'metals-already-imported'],
    ).accountId));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * The identity pin each new account's import carries (#324; corrections design r6, section 2.8). It is made by the
 * operator's own commands, in this run's directory, where it stays:
 * - a new owner-only identity key (`identity-key`);
 * - a folder registry, written owner-only by `identity-register` one folder at a time, each payload's own source, folder
 *   and last 4. Costco's folder needs its membership last 4, which the CLI reads on a terminal only: it is registered by
 *   tests/metalsIdentityRegister.ts, the same command on a stand-in terminal typing the synthetic payload's own last 4;
 * - each folder's keyed digest (`identity-digest`), which its import GO pins.
 * Returns the import options naming the key and the registry, and each source's pin.
 */
function identityPins(dir: string, payloads: readonly MetalsImportPayload[]): { options: string[]; pins: Map<string, string> } {
  const key = path.join(dir, `metals-identity-${hex(4)}.key`);
  cli(['identity-key', '--out', key], ['metals-identity-key-written']);
  let registry = '';
  for (const payload of payloads) {
    const next = path.join(dir, `metals-registry-${hex(4)}.json`);
    const args = ['identity-register', '--registry', next, ...(registry ? ['--from', registry] : []),
      '--source', payload.source, '--folder', payload.account.folder];
    const last4 = payload.account.identityLast4;
    if (last4 === null) cli(args, ['metals-identity-registered']);
    else cli([...args, last4], ['metals-identity-registered'], TYPED_REGISTER);
    registry = next;
  }
  const pins = new Map(payloads.map((payload) => [payload.source, String(cli(['identity-digest', '--registry', registry,
    '--identity-key', key, '--source', payload.source, '--folder', payload.account.folder], ['metals-identity-digest']).identityDigest)]));
  return { options: ['--identity-key', key, '--identity-registry', registry], pins };
}

let loading: Promise<MetalsStack> | undefined;

/** Holdr's ingress refuses an escaped ':' (%3A): a product ref and a line key are path-safe as they are, and sent so. */
const contentPath = (scope: MetalsProductScope) => (scope.kind === 'product'
  ? `/metals/products/${scope.ref}/content` : `/metals/lots/${scope.lotKey}/content`);

/** A product-wide row of gold, by one of its titles, as the products read lists it. */
export async function productByTitle(request: APIRequestContext, title: string): Promise<MetalsProduct> {
  const answer = await request.get('/metals/products?metal=XAU');
  expect(answer.status()).toBe(200);
  const found = (await answer.json() as MetalsProducts).products
    .find((item) => item.scope.kind === 'product' && item.titles.includes(title));
  expect(found, `the product row of ${title}`).toBeTruthy();
  return found!;
}

/** The Costco bar's product row (one product, three purchases), as the products read lists it. */
export const costcoProduct = (request: APIRequestContext) => productByTitle(request, COSTCO_PRODUCT_TITLE);

/** The owner's confirmation of the Costco bar as proposed, through the API (as another tab would make it); its decision id. */
export async function confirmCostcoProduct(request: APIRequestContext): Promise<string> {
  const product = await costcoProduct(request);
  const scope = product.scope as Extract<MetalsProductScope, { kind: 'product' }>;
  const body = { fingerprint: scope.fingerprint, metal: 'XAU', troyOzPerUnit: product.proposal!.troyOzPerUnit.exact, preview: null as string | null };
  const previewed = await request.post(contentPath(scope), { headers: MUTATION_HEADERS, data: body });
  expect(previewed.status(), await previewed.text()).toBe(200);
  const { preview } = await previewed.json() as { preview: { digest: string } };
  const written = await request.post(contentPath(scope), { headers: MUTATION_HEADERS, data: { ...body, preview: preview.digest } });
  expect(written.status(), await written.text()).toBe(201);
  return (await written.json() as { decision: { id: string } }).decision.id;
}

/** Undoes whatever decision a product's row holds, previewed then revoked, so the ledger is as loaded again. */
export async function undoProduct(request: APIRequestContext, title: string): Promise<void> {
  const product = await productByTitle(request, title);
  if (!product.decision) return;
  const at = `${contentPath(product.scope)}?decision=${encodeURIComponent(product.decision.id)}`;
  const previewed = await request.delete(at, { headers: MUTATION_HEADERS });
  expect(previewed.status(), await previewed.text()).toBe(200);
  const { preview } = await previewed.json() as { preview: { digest: string } };
  const revoked = await request.delete(`${at}&preview=${encodeURIComponent(preview.digest)}`, { headers: MUTATION_HEADERS });
  expect(revoked.status(), await revoked.text()).toBe(200);
}

/** Undoes whatever decision the Costco bar's row holds. */
export const undoCostcoProduct = (request: APIRequestContext) => undoProduct(request, COSTCO_PRODUCT_TITLE);

/** A date as the page writes it: "Nov 8, 2026". */
export const longDate = (date: string) => new Date(`${date}T12:00:00Z`)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * Loads the ledger once per run; a later call (another spec, a restarted worker) reads what was loaded. In order:
 * install; the approved card and its rows (a binding proposal pins the cards, so they come first); the three sources;
 * the card binding; then the later Walmart capture that contradicts one order.
 */
export function metalsStack(request: APIRequestContext): Promise<MetalsStack> {
  loading ??= (async () => {
    const dir = runDir();
    const state = path.join(dir, STATE_FILE);
    if (fs.existsSync(state)) return JSON.parse(fs.readFileSync(state, 'utf8')) as MetalsStack;
    const database = path.join(dir, 'data', 'finance.db');
    const today = NEW_YORK_DATE.format(new Date());
    const ledger = goldLedgerPayloads(today);

    const plan = cli(['plan', '--db', database], ['metals-planned']);
    if (plan.schema !== 'present') {
      expect(plan.schema).toBe('absent');
      withGo(dir, 'install', plan, {}, (go) => cli(['install', '--db', database, '--go', go, '--backup', backupFile(dir)],
        ['metals-installed', 'metals-already-installed']));
    }
    const cardAccountId = await cardWithRows(request, ledger, today);
    // Each source's account is new, so each import pins its identity (#324).
    const identity = identityPins(dir, [ledger.costco, ledger.walmart, ledger.collectpure]);
    const pinned = (payload: MetalsImportPayload, label: string) => ({ label, identityDigest: identity.pins.get(payload.source)! });
    const accounts = {
      costco: importPayload(dir, database, plan, 'costco', ledger.costco, pinned(ledger.costco, 'Costco membership 1'), identity.options),
      walmart: importPayload(dir, database, plan, 'walmart', ledger.walmart, pinned(ledger.walmart, 'Walmart account'), identity.options),
      collectpure: importPayload(dir, database, plan, 'collectpure', ledger.collectpure, pinned(ledger.collectpure, 'CollectPure'),
        identity.options),
    };

    // Only the Walmart card is approved, to the account with its last 4; Costco's card and the payout account stay unbound.
    const proposalFile = path.join(dir, `metals-proposal-${hex(4)}.json`);
    try {
      const proposed = cli(['bindings', 'propose', '--db', database, '--out', proposalFile], ['metals-bindings-proposed']);
      const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as {
        identities: Array<{ kind: string; source: string; last4: string | null; candidates: Array<{ accountId: string }> }>;
      };
      const walmart = proposal.identities.find((item) => item.kind === 'card' && item.source === 'walmart' && item.last4 === GOLD_CARD_LAST4);
      expect(walmart?.candidates.map((item) => item.accountId)).toContain(cardAccountId);
      withGo(dir, 'bindings-approve', plan, {
        proposalSha256: sha256(fs.readFileSync(proposalFile)), inventoryDigest: proposed.inventoryDigest,
        pairs: [{ kind: 'card', source: 'walmart', network: 'visa', last4: GOLD_CARD_LAST4, accountId: cardAccountId }],
      }, (go) => cli(['bindings', 'approve', '--db', database, '--proposal', proposalFile, '--go', go, '--backup', backupFile(dir)],
        ['metals-bindings-approved', 'metals-bindings-already-active']));
    } finally {
      fs.rmSync(proposalFile, { force: true });
    }

    // A later Walmart capture contradicting the 10 g bar's price: a conflict, quarantined until a supersede.
    importPayload(dir, database, plan, 'walmart-later', ledger.walmartLater, { accountId: accounts.walmart });

    const stack: MetalsStack = { today, cardAccountId, accounts, dates: ledger.dates };
    fs.writeFileSync(state, JSON.stringify(stack), { mode: 0o600 });
    return stack;
  })();
  return loading;
}
