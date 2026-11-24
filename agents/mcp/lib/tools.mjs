// The tools: what an agent can read from Holdr. Each is a few GET requests to the local API and a compact answer, a short
// summary for people and JSON for the model, cut to a size budget. None writes anything, and none returns a token, a file
// path or a full account number: investment account numbers are masked to their last four characters, cards are named by
// their last four digits only, and long digit runs in free text are masked too.
import { SERVER_VERSION } from './config.mjs';
import {
  PERIODS, ToolInputError, cleanText, fitToBudget, formatMoney, fromMinor, isIsoDate, localDate, maskAccountNumber,
  money, percentOf, ratioPercent, resolveDateRange, round, truncationNote,
} from './format.mjs';
import { HoldrApiError } from './holdr-api.mjs';
import { aggregatePositionsSafe, positionMarketValue, positionsPnLPercent } from './portfolio.mjs';

/* ------------------------------------------------------------------ */
/* Argument schemas                                                   */
/* ------------------------------------------------------------------ */

const DATE = (description) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', examples: ['2026-01-31'], description });
const MONTH = {
  type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', examples: ['2026-01'],
  description: 'One calendar month, YYYY-MM. Instead of period or from/to.',
};
const PERIOD = {
  type: 'string', enum: PERIODS,
  description: 'A date range relative to today (this computer\'s date): this-month and this-year run to today; last-month and '
    + 'last-year are the whole previous month or year; last-30-days, last-90-days and last-12-months are rolling. Instead of month or from/to.',
};
const FROM = DATE('First day to include, YYYY-MM-DD (inclusive). Instead of period or month.');
const TO = DATE('Last day to include, YYYY-MM-DD (inclusive). Instead of period or month.');
const OWNER = {
  type: 'string', enum: ['alex', 'casey', 'joint'],
  description: "Holdr's owner slot for cards: alex and casey are the household's two people (whatever names Holdr shows for them), joint their shared cards.",
};
const CARD = {
  type: 'string', minLength: 1, maxLength: 80,
  description: 'One card: its id, its last four digits, or part of its nickname or issuer (amex, chase, citi, ...).',
};
const ACCOUNT = {
  type: 'string', minLength: 1, maxLength: 80,
  description: 'Investment accounts to include: an account id, the last four characters of its number, or part of its name or '
    + 'type (e.g. "Roth IRA", "401(k)", "HSA", "Brokerage"). Every account that matches is included.',
};
const LIMIT = (fallback, maximum = 500) => ({ type: 'integer', minimum: 1, maximum, description: `How many to return (default ${fallback}, at most ${maximum}).` });
const OFFSET = { type: 'integer', minimum: 0, maximum: 1_000_000, description: 'How many matching items to skip first, for the next page (default 0).' };
const objectSchema = (properties, required = []) => ({
  type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false,
});

/* ------------------------------------------------------------------ */
/* Shared reads and labels                                            */
/* ------------------------------------------------------------------ */

const ISSUERS = { amex: 'American Express', chase: 'Chase', citi: 'Citi', discover: 'Discover', capitalone: 'Capital One', bilt: 'Bilt', wellsfargo: 'Wells Fargo' };
const issuerName = (issuer) => (typeof issuer === 'string' ? ISSUERS[issuer] ?? issuer.charAt(0).toUpperCase() + issuer.slice(1) : 'Card');
const cardEnding = (account) => (typeof account.last4 === 'string' && /^\d{4}$/.test(account.last4) ? account.last4
  : typeof account.last5 === 'string' && /^\d{5}$/.test(account.last5) ? account.last5.slice(-4) : null);

/** The household's card accounts, each with a label made of its nickname (or issuer) and its last four digits. */
async function loadCards(api, signal) {
  const body = await api.get('/card-accounts', {}, { signal });
  const cards = (Array.isArray(body.cardAccounts) ? body.cardAccounts : []).filter((account) => typeof account?.id === 'string').map((account) => {
    const ending = cardEnding(account);
    const name = cleanText(account.nickname, 60) ?? issuerName(account.issuer);
    return {
      id: account.id, name, issuer: account.issuer ?? null, owner: account.owner ?? null, ending, status: account.status ?? null,
      currency: account.currency ?? 'USD', label: ending ? `${name} …${ending}` : name,
    };
  });
  const counts = new Map();
  for (const card of cards) counts.set(card.label, (counts.get(card.label) ?? 0) + 1);
  for (const card of cards) if (counts.get(card.label) > 1) card.label = `${card.label} (${card.owner})`;
  return cards;
}

const listCards = (cards) => (cards.length ? cards.map((card) => `${card.label} [${card.id}]`).join('; ') : 'none');

function matchCards(query, cards, extra = () => []) {
  const text = query.trim();
  const lower = text.toLowerCase();
  const byId = cards.filter((card) => card.id === text);
  if (byId.length > 0) return byId;
  if (/^\d{4,5}$/.test(text)) {
    const byEnding = cards.filter((card) => card.ending === text.slice(-4));
    if (byEnding.length > 0) return byEnding;
  }
  return cards.filter((card) => [card.name, card.issuer, issuerName(card.issuer), card.label, ...extra(card)]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(lower)));
}

function resolveOneCard(query, cards, extra) {
  const matches = matchCards(query, cards, extra);
  const asked = cleanText(query, 40);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ToolInputError(`No card matches "${asked}". Cards: ${listCards(cards)}.`);
  throw new ToolInputError(`"${asked}" matches ${matches.length} cards: ${listCards(matches)}. Name one by its id or last four digits.`);
}

const accountLabel = (account) => cleanText(account.name, 80) ?? account.id;

function accountView(account) {
  return {
    id: account.id,
    name: accountLabel(account),
    type: cleanText(account.type, 40) ?? null,
    number: maskAccountNumber(account.accountNumber),
    currency: account.currency ?? 'USD',
  };
}

/** The investment accounts `query` names (all of them without one). */
function selectAccounts(accounts, query) {
  if (query === undefined) return accounts;
  const text = query.trim();
  const lower = text.toLowerCase();
  const byId = accounts.filter((account) => account.id === text);
  if (byId.length > 0) return byId;
  if (/^[A-Za-z0-9]{4}$/.test(text)) {
    const byNumber = accounts.filter((account) => maskAccountNumber(account.accountNumber)?.slice(3).toLowerCase() === lower);
    if (byNumber.length > 0) return byNumber;
  }
  const byText = accounts.filter((account) => [account.name, account.type].some((value) => typeof value === 'string' && value.toLowerCase().includes(lower)));
  if (byText.length > 0) return byText;
  throw new ToolInputError(`No investment account matches "${cleanText(query, 40)}". Accounts: ${
    accounts.map((account) => `${accountLabel(account)}${account.type ? ` (${cleanText(account.type, 40)})` : ''} [${account.id}]`).join('; ') || 'none'}.`);
}

/** Tax treatment as an account's free-form type suggests it; Holdr itself does not record one. */
export function taxTreatment(type) {
  const text = typeof type === 'string' ? type.toLowerCase() : '';
  if (!text.trim()) return 'unknown';
  if (/\bhsa\b|health savings/.test(text)) return 'HSA';
  if (/roth/.test(text)) return 'tax-free (Roth)';
  if (/\b529\b|coverdell|education/.test(text)) return 'education';
  if (/401|403|457|\bira\b|\bsep\b|simple|\btsp\b|pension|retire|rollover|traditional|keogh|profit.?sharing/.test(text)) return 'tax-deferred';
  return 'taxable';
}

const assetClass = (position) => (position.instrumentType === 'option' ? 'options' : /-USD$/i.test(position.symbol) ? 'crypto' : 'stocks, ETFs and funds');

async function loadLedger(api, signal) {
  const [accountsBody, transactionsBody] = await Promise.all([
    api.get('/accounts', {}, { signal }),
    api.get('/transactions', {}, { signal }),
  ]);
  const accounts = (Array.isArray(accountsBody.accounts) ? accountsBody.accounts : []).filter((account) => typeof account?.id === 'string');
  const transactions = (Array.isArray(transactionsBody.transactions) ? transactionsBody.transactions : [])
    .filter((transaction) => transaction && typeof transaction.symbol === 'string' && typeof transaction.date === 'string' && Number.isFinite(transaction.quantity));
  return { accounts, transactions };
}

/** Errors that end a tool call; any other HoldrApiError from an optional read becomes a note instead. */
const fatal = (error) => !(error instanceof HoldrApiError) || ['cancelled', 'token-missing', 'token-invalid', 'token-unreadable', 'token-rejected', 'api-unreachable', 'not-loopback'].includes(error.code);

/** Current quotes for `symbols` through Holdr (GET /quotes, 50 at a time): the same prices the Portfolio page shows. */
async function loadQuotes(api, symbols, signal) {
  const quotes = new Map();
  let failure = null;
  for (let index = 0; index < symbols.length; index += 50) {
    const chunk = symbols.slice(index, index + 50);
    try {
      const body = await api.get('/quotes', { symbols: chunk.join(',') }, { signal, timeoutMs: 45_000 });
      for (const quote of Array.isArray(body.quotes) ? body.quotes : []) {
        if (quote && typeof quote.symbol === 'string' && typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price >= 0) {
          quotes.set(quote.symbol, quote);
        }
      }
    } catch (error) {
      if (fatal(error)) throw error;
      failure = error.message;
    }
  }
  return { quotes, failure };
}

const quoteFreshness = (quote) => (quote.source === 'cache' ? 'stale (last stored price)' : typeof quote.freshness === 'string' ? quote.freshness : 'unknown');

/** Every selected account's positions, valued at `quotes` when given. */
function valueAccounts(accounts, transactions, quotes) {
  return accounts.map((account) => {
    const { positions, problems } = aggregatePositionsSafe(transactions.filter((transaction) => transaction.accountId === account.id));
    const rows = positions.map((position) => {
      const quote = quotes?.get(position.symbol) ?? null;
      const marketValue = quote ? positionMarketValue(position, quote.price) : null;
      return { position, quote, marketValue, gain: marketValue === null ? null : marketValue - position.costBasis };
    });
    const priced = rows.filter((row) => row.marketValue !== null);
    const positionsValue = priced.reduce((sum, row) => sum + row.marketValue, 0);
    const positionsCost = positions.reduce((sum, position) => sum + position.costBasis, 0);
    const cash = Number.isFinite(account.cashBalance) ? account.cashBalance : 0;
    const complete = quotes !== null && priced.length === rows.length;
    const gain = complete ? positionsValue - positionsCost : null;
    return {
      account, rows, problems, cash, positionsValue, positionsCost, complete,
      marketValue: positionsValue + cash,
      gain,
      gainPct: complete ? positionsPnLPercent(gain, positionsCost) : null,
      missing: rows.filter((row) => row.marketValue === null).map((row) => row.position.symbol),
    };
  });
}

function shares(entries, total) {
  return [...entries]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value)
    .map(({ key, value }) => ({ key, value: money(value), pct: percentOf(value, total) }));
}

function positionRow(account, row, accountValue) {
  const { position, quote, marketValue, gain } = row;
  return {
    accountId: account.id,
    account: accountLabel(account),
    symbol: position.symbol,
    assetClass: assetClass(position),
    quantity: round(position.quantity, 6),
    averageCost: round(position.averageCost, 4),
    costBasis: money(position.costBasis),
    price: quote ? round(quote.price, 4) : null,
    priceAsOf: quote && Number.isFinite(quote.asOf) ? new Date(quote.asOf).toISOString() : null,
    priceFreshness: quote ? quoteFreshness(quote) : null,
    marketValue: money(marketValue),
    unrealizedGain: money(gain),
    unrealizedGainPct: gain === null ? null : round(positionsPnLPercent(gain, position.costBasis), 2),
    dayChangePct: quote && Number.isFinite(quote.dayChangePercent) ? round(quote.dayChangePercent, 2) : null,
    pctOfAccount: marketValue === null ? null : percentOf(marketValue, accountValue),
    ...(position.instrumentType === 'option' ? { contractMultiplier: position.contractMultiplier } : {}),
    currency: position.currency,
  };
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

/**
 * A tool's answer: the summary, the data, and the data's JSON fitted to the size budget by cutting the lists named in
 * `keys`. `adjust(data)` updates counts that describe a list after it was cut; a `summary` function is called after that,
 * so it can say what was actually shown.
 */
const answer = (summary, data, keys = [], adjust = null) => {
  let text = fitToBudget(data, keys);
  if (adjust && data.truncated) {
    adjust(data);
    text = JSON.stringify(data);
  }
  return { summary: `${typeof summary === 'function' ? summary(data) : summary}${truncationNote(data)}`, data, text };
};

/** For paged lists: after a cut, the next page starts right after the last item shown. */
const pageAdjust = (key) => (data) => {
  if (!data.truncated?.[key]) return;
  data.shown = data[key].length;
  data.nextOffset = data.offset + data[key].length;
};

const METALS = { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' };
const METAL_NAMES = { XAU: 'gold', XAG: 'silver', XPT: 'platinum', XPD: 'palladium' };
const CASH_TYPES = ['dividend', 'interest', 'deposit', 'withdrawal', 'transfer', 'fee', 'tax', 'sweep'];
const ACTIVITY_TYPES = ['buy', 'sell', ...CASH_TYPES];

/**
 * The tool list. `options.demo` only labels answers; `now` fixes "today" for tests.
 */
export function createTools(api, { demo = false, now = () => new Date() } = {}) {
  const today = () => localDate(now());

  const health = {
    name: 'holdr_health',
    title: 'Holdr status',
    description: 'Checks that Holdr is running and that this server may read it, and reports the database version, how many '
      + 'investment accounts and trades there are, and each card account with the date range of its imported transactions '
      + '(how fresh the spending data is). Call it first when another tool fails, or to learn which cards exist.',
    inputSchema: objectSchema({}),
    async handler(_args, { signal }) {
      const status = await api.get('/health', {}, { signal });
      if (status.service !== 'holdr-api' || !Number.isSafeInteger(status.schemaVersion)) {
        throw new HoldrApiError('version-mismatch', `the service at ${api.origin} is not a Holdr API this server knows`);
      }
      const cards = await loadCards(api, signal);
      const coverage = new Map();
      try {
        const body = await api.get('/spending/coverage', {}, { signal });
        for (const card of Array.isArray(body.cards) ? body.cards : []) coverage.set(card.cardAccountId, card.transactions ?? null);
      } catch (error) {
        if (fatal(error)) throw error;
      }
      const data = {
        status: 'ok',
        holdr: {
          url: api.origin,
          demo,
          schemaVersion: status.schemaVersion,
          investmentAccounts: status.accounts ?? null,
          investmentTransactions: status.transactions ?? null,
          valueSnapshots: status.snapshots ? { enabled: status.snapshots.enabled, count: status.snapshots.count, latest: status.snapshots.latest } : null,
        },
        cards: cards.map((card) => {
          const rows = coverage.get(card.id);
          return {
            id: card.id, card: card.label, issuer: card.issuer, owner: card.owner, status: card.status, currency: card.currency,
            transactions: rows?.count ?? 0, firstDate: rows?.first ?? null, lastDate: rows?.last ?? null,
          };
        }),
        server: { name: 'holdr-mcp', version: SERVER_VERSION, readOnly: true, token: 'agent (read-only)' },
        today: today(),
      };
      const latest = data.cards.map((card) => card.lastDate).filter(Boolean).sort().at(-1);
      return answer(`Holdr is running at ${api.origin}${demo ? ' (the demo, synthetic data)' : ''}, database schema ${status.schemaVersion}: `
        + `${status.accounts ?? '?'} investment accounts with ${status.transactions ?? '?'} trades; ${cards.length} card accounts`
        + `${latest ? `, card transactions through ${latest}` : ''}. This server reads with Holdr's read-only agent token.`, data, ['cards']);
    },
  };

  const portfolioSummary = {
    name: 'get_portfolio_summary',
    title: 'Portfolio summary',
    openWorld: true,
    description: 'The investment portfolio as the Portfolio page shows it: total market value, cash, cost basis and unrealized gain, '
      + 'per account (brokerage, Roth IRA, 401(k), HSA, ...), and the allocation by account type, by tax treatment (inferred from '
      + 'the account type), by asset class and by top holding. Prices come through Holdr\'s quote service (public market data for '
      + 'the held symbols; stored prices when it is offline, as in the demo). With includePerformance, adds time- and '
      + 'money-weighted returns (YTD, 1/3/5 years, by calendar year) against QQQ and SPY. Use list_positions for each holding.',
    inputSchema: objectSchema({
      account: ACCOUNT,
      includePerformance: { type: 'boolean', description: 'Also compute returns over time (slower). Default false.' },
    }),
    async handler(args, { signal }) {
      const { accounts, transactions } = await loadLedger(api, signal);
      const selected = selectAccounts(accounts, args.account);
      const ids = new Set(selected.map((account) => account.id));
      const ledger = transactions.filter((transaction) => ids.has(transaction.accountId));
      const symbols = [...new Set(valueAccounts(selected, ledger, null).flatMap((item) => item.rows.map((row) => row.position.symbol)))];
      const { quotes, failure } = symbols.length ? await loadQuotes(api, symbols, signal) : { quotes: new Map(), failure: null };
      const valued = valueAccounts(selected, ledger, quotes);

      const total = valued.reduce((sum, item) => sum + item.marketValue, 0);
      const cash = valued.reduce((sum, item) => sum + item.cash, 0);
      const positionsValue = valued.reduce((sum, item) => sum + item.positionsValue, 0);
      const positionsCost = valued.reduce((sum, item) => sum + item.positionsCost, 0);
      const complete = valued.every((item) => item.complete);
      const pnl = valued.reduce((sum, item) => sum + item.rows.reduce((inner, row) => inner + (row.gain ?? 0), 0), 0);
      const missing = [...new Set(valued.flatMap((item) => item.missing))];

      const byType = new Map();
      const byTax = new Map();
      const byClass = new Map([['cash', cash]]);
      const byHolding = new Map();
      for (const item of valued) {
        const type = cleanText(item.account.type, 40) ?? 'unspecified';
        byType.set(type, (byType.get(type) ?? 0) + item.marketValue);
        const tax = taxTreatment(item.account.type);
        byTax.set(tax, (byTax.get(tax) ?? 0) + item.marketValue);
        for (const row of item.rows) {
          if (row.marketValue === null) continue;
          const kind = assetClass(row.position);
          byClass.set(kind, (byClass.get(kind) ?? 0) + row.marketValue);
          byHolding.set(row.position.symbol, (byHolding.get(row.position.symbol) ?? 0) + row.marketValue);
        }
      }
      const currencies = [...new Set(selected.map((account) => account.currency ?? 'USD'))];
      const data = {
        asOf: now().toISOString(),
        currency: currencies.length === 1 ? currencies[0] : 'mixed',
        totals: {
          marketValue: money(total),
          cash: money(cash),
          positionsValue: money(positionsValue),
          positionsCostBasis: money(positionsCost),
          unrealizedGain: complete ? money(positionsValue - positionsCost) : null,
          unrealizedGainPct: complete ? round(positionsPnLPercent(pnl, positionsCost), 2) : null,
          valueComplete: complete,
        },
        byAccountType: shares(byType, total).map(({ key, value, pct }) => ({ type: key, marketValue: value, pct })),
        byTaxTreatment: shares(byTax, total).map(({ key, value, pct }) => ({ treatment: key, marketValue: value, pct })),
        byAssetClass: shares(byClass, total).filter((entry) => entry.value !== 0).map(({ key, value, pct }) => ({ assetClass: key, marketValue: value, pct })),
        topHoldings: shares(byHolding, total).slice(0, 10).map(({ key, value, pct }) => ({ symbol: key, marketValue: value, pct })),
        accounts: valued.map((item) => ({
          ...accountView(item.account),
          taxTreatment: taxTreatment(item.account.type),
          marketValue: money(item.marketValue),
          cash: money(item.cash),
          positionsValue: money(item.positionsValue),
          positionsCostBasis: money(item.positionsCost),
          unrealizedGain: money(item.gain),
          unrealizedGainPct: round(item.gainPct, 2),
          positions: item.rows.length,
          ...(item.missing.length ? { missingPrices: item.missing } : {}),
          ...(item.problems.length ? { unreadable: item.problems } : {}),
        })),
        prices: {
          symbols: symbols.length,
          stale: [...quotes.values()].filter((quote) => quote.source === 'cache').map((quote) => quote.symbol),
          missing,
          ...(failure ? { error: failure } : {}),
        },
        notes: [
          'Gains are unrealized and cover positions only: cash has no gain. Percents are over the positions\' cost basis.',
          'Account types are the labels typed into Holdr; tax treatment is inferred from them.',
          ...(missing.length ? [`Totals leave out the value of positions without a price: ${missing.join(', ')}.`] : []),
        ],
      };
      if (args.includePerformance) data.performance = await performance(selected.length === accounts.length ? null : [...ids], signal);
      const gainText = complete ? `, unrealized gain ${formatMoney(positionsValue - positionsCost)} (${round(positionsPnLPercent(pnl, positionsCost), 2) ?? 0}%)` : '';
      return answer(`Portfolio${args.account ? ` (${selected.length} account${selected.length === 1 ? '' : 's'})` : ''}: `
        + `${formatMoney(total)} across ${selected.length} accounts, ${formatMoney(cash)} of it cash${gainText}.`
        + `${missing.length ? ` No price for ${missing.join(', ')}: totals leave them out.` : ''}`, data, ['topHoldings', 'accounts']);
    },
  };

  async function performance(accountIds, signal) {
    try {
      const body = await api.get('/portfolio/performance', { accounts: accountIds?.join(',') }, { signal, timeoutMs: 90_000 });
      if (body.supported !== true) return { supported: false, reason: cleanText(body.reason, 200) };
      const figures = (item) => ({
        from: item.from,
        to: item.to,
        timeWeightedPct: ratioPercent(item.timeWeighted),
        timeWeightedAnnualizedPct: ratioPercent(item.timeWeightedAnnualized),
        moneyWeightedPct: ratioPercent(item.moneyWeighted),
        moneyWeightedAnnualizedPct: ratioPercent(item.moneyWeightedAnnualized),
        gain: money(item.gain),
        netDeposits: money(item.netFlows),
        startValue: money(item.startValue),
        endValue: money(item.endValue),
        ...(item.partial ? { partial: true } : {}),
        benchmarksPct: Object.fromEntries(Object.entries(item.benchmarks ?? {}).map(([symbol, value]) => [symbol, value ? ratioPercent(value.return) : null])),
      });
      return {
        supported: true,
        asOf: body.asOf,
        inception: body.inception,
        completeFrom: body.completeFrom ?? null,
        periods: (body.periods ?? []).map((item) => ({ period: item.key, ...figures(item) })),
        years: (body.years ?? []).slice(-6).map((item) => ({ year: item.year, ...(item.ytd ? { ytd: true } : {}), ...figures(item) })),
        notes: (body.notes ?? []).map((note) => cleanText(note, 300)).filter(Boolean),
      };
    } catch (error) {
      if (fatal(error)) throw error;
      return { supported: false, error: error.message };
    }
  }

  const positions = {
    name: 'list_positions',
    title: 'Investment positions',
    openWorld: true,
    description: 'Every open holding (stocks, ETFs, funds, crypto, options) per investment account: quantity, average cost, cost '
      + 'basis, current price and its freshness, market value, unrealized gain and the day\'s change. Quantities and cost basis '
      + 'come from the recorded trades (weighted-average cost, as Holdr computes it). Filter by account or symbol.',
    inputSchema: objectSchema({
      account: ACCOUNT,
      symbol: { type: 'string', minLength: 1, maxLength: 200, description: 'Only these symbols, comma-separated (e.g. "VTI" or "AAPL,MSFT").' },
      sort: { type: 'string', enum: ['value', 'gain', 'gain-percent', 'symbol', 'account'], description: 'Order (default value, largest first).' },
      limit: LIMIT(200),
    }),
    async handler(args, { signal }) {
      const { accounts, transactions } = await loadLedger(api, signal);
      const selected = selectAccounts(accounts, args.account);
      const ids = new Set(selected.map((account) => account.id));
      const wanted = args.symbol ? new Set(args.symbol.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)) : null;
      const ledger = transactions.filter((transaction) => ids.has(transaction.accountId));
      // Every held symbol is priced, not only the ones asked for: each account's value, and so each holding's share of it,
      // needs them all.
      const unpriced = valueAccounts(selected, ledger, null);
      const symbols = [...new Set(unpriced.flatMap((item) => item.rows.map((row) => row.position.symbol)))];
      const { quotes, failure } = symbols.length ? await loadQuotes(api, symbols, signal) : { quotes: new Map(), failure: null };
      const valued = valueAccounts(selected, ledger, quotes);
      let rows = valued.flatMap((item) => item.rows
        .filter((row) => !wanted || wanted.has(row.position.symbol))
        .map((row) => positionRow(item.account, row, item.marketValue)));
      const sorters = {
        value: (a, b) => (b.marketValue ?? -Infinity) - (a.marketValue ?? -Infinity),
        gain: (a, b) => (b.unrealizedGain ?? -Infinity) - (a.unrealizedGain ?? -Infinity),
        'gain-percent': (a, b) => (b.unrealizedGainPct ?? -Infinity) - (a.unrealizedGainPct ?? -Infinity),
        symbol: (a, b) => a.symbol.localeCompare(b.symbol) || a.account.localeCompare(b.account),
        account: (a, b) => a.account.localeCompare(b.account) || (b.marketValue ?? 0) - (a.marketValue ?? 0),
      };
      rows.sort(sorters[args.sort ?? 'value']);
      const total = rows.length;
      rows = rows.slice(0, args.limit ?? 200);
      const missing = rows.filter((row) => row.price === null).map((row) => row.symbol);
      const data = {
        asOf: now().toISOString(),
        accounts: selected.map((account) => ({ ...accountView(account), cash: money(account.cashBalance) })),
        total,
        shown: rows.length,
        positions: rows,
        ...(failure ? { priceError: failure } : {}),
        ...(valued.some((item) => item.problems.length) ? { unreadable: valued.flatMap((item) => item.problems.map((problem) => ({ account: accountLabel(item.account), ...problem }))) } : {}),
      };
      const value = rows.reduce((sum, row) => sum + (row.marketValue ?? 0), 0);
      return answer((fitted) => `${total} open position${total === 1 ? '' : 's'}${wanted ? ` in ${[...wanted].join(', ')}` : ''} across `
        + `${selected.length} account${selected.length === 1 ? '' : 's'}${fitted.shown < total ? ` (${fitted.shown} shown)` : ''}, worth `
        + `${formatMoney(value)}${missing.length ? `; no price for ${[...new Set(missing)].join(', ')}` : ''}.`,
      data, ['positions'], (fitted) => { fitted.shown = fitted.positions.length; });
    },
  };

  const investmentTransactions = {
    name: 'list_investment_transactions',
    title: 'Investment activity',
    description: 'Investment account activity, newest first: trades (buy, sell; options with their open/close effect) and broker '
      + 'cash events (dividends, interest, deposits and contributions, withdrawals, transfers, fees, taxes, sweeps). Filter by '
      + 'account, symbol (trades only), type and dates; page with limit and offset.',
    inputSchema: objectSchema({
      account: ACCOUNT,
      symbol: { type: 'string', minLength: 1, maxLength: 40, description: 'Only trades in this symbol (cash events have none).' },
      types: { type: 'array', items: { type: 'string', enum: ACTIVITY_TYPES }, minItems: 1, uniqueItems: true, description: 'Only these kinds of activity (default all).' },
      period: PERIOD,
      month: MONTH,
      from: FROM,
      to: TO,
      limit: LIMIT(100),
      offset: OFFSET,
    }),
    async handler(args, { signal }) {
      const range = resolveDateRange(args, today());
      const types = new Set(args.types ?? ACTIVITY_TYPES);
      const wantsCash = !args.symbol && CASH_TYPES.some((type) => types.has(type));
      const [{ accounts, transactions }, cashBody] = await Promise.all([
        loadLedger(api, signal),
        wantsCash ? api.get('/cash-events', {}, { signal }) : Promise.resolve({ cashEvents: [] }),
      ]);
      const selected = selectAccounts(accounts, args.account);
      const byId = new Map(selected.map((account) => [account.id, account]));
      const inRange = (date) => (!range?.from || date >= range.from) && (!range?.to || date <= range.to);
      const symbol = args.symbol?.trim().toUpperCase();
      const items = [];
      for (const transaction of transactions) {
        const account = byId.get(transaction.accountId);
        const type = transaction.quantity > 0 ? 'buy' : 'sell';
        if (!account || !types.has(type) || !inRange(transaction.date) || (symbol && transaction.symbol !== symbol)) continue;
        const multiplier = transaction.instrumentType === 'option' ? transaction.contractMultiplier ?? 100 : 1;
        items.push({
          date: transaction.date,
          type,
          accountId: account.id,
          account: accountLabel(account),
          symbol: transaction.symbol,
          quantity: round(Math.abs(transaction.quantity), 6),
          price: round(transaction.pricePerUnit, 4),
          amount: money(Math.abs(transaction.quantity) * multiplier * transaction.pricePerUnit),
          fees: transaction.fees ? money(transaction.fees) : undefined,
          currency: transaction.currency ?? account.currency ?? 'USD',
          ...(transaction.instrumentType === 'option' ? { option: { effect: transaction.positionEffect, contractMultiplier: multiplier } } : {}),
          notes: cleanText(transaction.notes, 80) ?? undefined,
        });
      }
      for (const event of Array.isArray(cashBody.cashEvents) ? cashBody.cashEvents : []) {
        const account = byId.get(event?.accountId);
        if (!account || !types.has(event.eventType) || typeof event.date !== 'string' || !inRange(event.date)) continue;
        items.push({
          date: event.date,
          type: event.eventType,
          accountId: account.id,
          account: accountLabel(account),
          amount: money(event.amount),
          currency: event.currency ?? account.currency ?? 'USD',
          description: cleanText(event.description, 100) ?? undefined,
        });
      }
      items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.type.localeCompare(b.type)));
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const page = items.slice(offset, offset + limit);
      const data = {
        range: range ?? { from: null, to: null, label: 'all time' },
        total: items.length,
        offset,
        shown: page.length,
        nextOffset: offset + page.length < items.length ? offset + page.length : null,
        items: page,
        notes: ['amount is quantity x price (x the contract multiplier for options) for trades, before fees; for cash events it is signed: money in is positive.'],
      };
      return answer((fitted) => `${items.length} investment ${items.length === 1 ? 'activity' : 'activities'} match (${fitted.range.label})`
        + `${fitted.shown < items.length ? `; ${fitted.shown} shown from ${offset}` : ''}, newest first`
        + `${fitted.nextOffset === null ? '' : `; the next page starts at offset ${fitted.nextOffset}`}.`, data, ['items'], pageAdjust('items'));
    },
  };

  const metals = {
    name: 'get_metals_holdings',
    title: 'Gold and silver holdings',
    description: 'Physical precious metals (gold, silver, platinum, palladium) from Holdr\'s purchase and sale ledger: troy ounces '
      + 'held, units, cost basis, value at the latest stored spot close and the gain against cost, by form (bar, coin, round) '
      + 'and by source account; purchases and sales in the period; and the purchase lots (date, product, units, fine troy '
      + 'ounces, cost, premium over spot, delivery state). Figures carry caveats when Holdr marks them partial or unknown.',
    inputSchema: objectSchema({
      metal: { type: 'string', enum: ['all', 'gold', 'silver', 'platinum', 'palladium'], description: 'Which metal (default all that Holdr has).' },
      includeLots: { type: 'boolean', description: 'Include the purchase lots (default true).' },
      lotsLimit: LIMIT(50),
      from: DATE('Activity period start, YYYY-MM-DD (default: the first purchase).'),
      to: DATE('Activity period end, YYYY-MM-DD (default today).'),
      asOf: DATE('Value the holdings as of this day, YYYY-MM-DD, not after today (default today).'),
    }),
    async handler(args, { signal }) {
      for (const name of ['from', 'to', 'asOf']) {
        if (args[name] !== undefined && !isIsoDate(args[name])) throw new ToolInputError(`${name} must be a real date, YYYY-MM-DD`);
      }
      const query = { from: args.from, to: args.to, asOf: args.asOf };
      const first = await api.get('/metals/overview', { metal: args.metal && args.metal !== 'all' ? METALS[args.metal] : 'XAU', ...query }, { signal });
      if (first.installed === false) {
        return answer('The gold and silver ledger is not installed on this Holdr, so there are no metal holdings to report.', { installed: false });
      }
      const present = (Array.isArray(first.metals) ? first.metals : []).map((entry) => entry.metal).filter((code) => METAL_NAMES[code]);
      const codes = args.metal && args.metal !== 'all' ? [METALS[args.metal]] : present.length ? present : ['XAU'];
      const views = [];
      const lots = [];
      for (const code of codes) {
        const overview = code === first.metal ? first : await api.get('/metals/overview', { metal: code, ...query }, { signal });
        const purchases = args.includeLots === false ? null : await api.get('/metals/purchases', { metal: code, from: args.from, to: args.to }, { signal });
        const view = metalView(code, overview, purchases);
        views.push(view.summary);
        lots.push(...view.lots.slice(0, args.lotsLimit ?? 50));
      }
      const data = {
        installed: true,
        asOf: first.asOf,
        metals: views,
        ...(args.includeLots === false ? {} : { lots }),
        notes: [
          'Amounts are US dollars; troy ounces are fine metal. value and gain use the latest stored daily spot close on or before asOf.',
          'unitsKept counts units delivered and kept or still on the way; cancelled and returned units are not held.',
        ],
      };
      const lines = views.map((view) => {
        const h = view.holdings;
        const value = h.value === null ? 'value unknown' : `worth ${formatMoney(h.value)}`;
        const price = view.price.usdPerTroyOz ? ` at the ${view.price.closeDate} close (${formatMoney(view.price.usdPerTroyOz)}/oz)` : '';
        const gain = h.gain === null ? '' : `: ${h.gain >= 0 ? 'gain' : 'loss'} ${formatMoney(Math.abs(h.gain))}${h.gainPct === null ? '' : ` (${h.gainPct}%)`}`;
        return `${view.metal}: ${h.troyOz ?? '?'} troy oz in ${h.units ?? '?'} units, cost ${formatMoney(h.cost)}, ${value}${price}${gain}`;
      });
      return answer(`${lines.join('. ')}.${views.some((view) => view.caveats.length) ? ' Some figures are partial; see caveats.' : ''}`, data, ['lots']);
    },
  };

  const spendingSummary = {
    name: 'get_spending_summary',
    title: 'Card spending summary',
    description: 'Credit-card spending totals for a date range, as Holdr\'s Spending tab counts them: posted purchases, fees and '
      + 'interest less refunds and credits (card payments are transfers, not spending; pending charges are reported apart). '
      + 'Broken down by month, category, category group (e.g. "Restaurant" covers "Restaurant-Restaurant" and '
      + '"Restaurant-Bar & Café"), merchant, card and owner. Filter by card, owner, exact category name or merchant.',
    inputSchema: objectSchema({
      period: PERIOD,
      month: MONTH,
      from: FROM,
      to: TO,
      card: CARD,
      owner: OWNER,
      category: { type: 'string', minLength: 1, maxLength: 100, description: 'Exactly one category name as this tool lists them (e.g. "Restaurant-Restaurant").' },
      merchant: { type: 'string', minLength: 1, maxLength: 200, description: 'One merchant, by name (grouped as Holdr groups merchant names).' },
      groupBy: {
        type: 'array', items: { type: 'string', enum: ['month', 'category', 'categoryGroup', 'merchant', 'card', 'owner'] }, minItems: 1, uniqueItems: true,
        description: 'Which breakdowns to include (default month, categoryGroup, category and merchant).',
      },
      topMerchants: { type: 'integer', minimum: 1, maximum: 50, description: 'How many merchants to list per currency (default 15).' },
    }),
    async handler(args, { signal }) {
      const range = resolveDateRange(args, today());
      const cards = await loadCards(api, signal);
      const card = args.card ? resolveOneCard(args.card, cards) : null;
      const body = await api.get('/spending/summary', {
        cardAccountId: card?.id, owner: args.owner, category: args.category, merchant: args.merchant, from: range?.from, to: range?.to,
      }, { signal });
      const groups = new Set(args.groupBy ?? ['month', 'categoryGroup', 'category', 'merchant']);
      const labelOf = new Map(cards.map((item) => [item.id, item.label]));
      const amounts = (entry) => ({ spending: fromMinor(entry.spendingMinor, entry.currency), count: entry.count });
      const byCategory = (body.byCategory ?? [])
        .map((entry) => ({ category: entry.category, currency: entry.currency, ...amounts(entry) }))
        .sort((a, b) => (b.spending ?? 0) - (a.spending ?? 0));
      const groupTotals = new Map();
      for (const entry of body.byCategory ?? []) {
        const group = String(entry.category).split('-')[0].trim() || entry.category;
        const key = `${group}\u0000${entry.currency}`;
        const sum = groupTotals.get(key) ?? { categoryGroup: group, currency: entry.currency, spendingMinor: 0, count: 0 };
        sum.spendingMinor += entry.spendingMinor;
        sum.count += entry.count;
        groupTotals.set(key, sum);
      }
      const top = args.topMerchants ?? 15;
      const merchantRank = new Map();
      const data = {
        range: range ?? { from: null, to: null, label: 'all time' },
        filters: {
          ...(card ? { card: card.label, cardAccountId: card.id } : {}),
          ...(args.owner ? { owner: args.owner } : {}),
          ...(args.category ? { category: args.category } : {}),
          ...(args.merchant ? { merchant: args.merchant } : {}),
        },
        totals: (body.totals ?? []).map((entry) => ({
          currency: entry.currency,
          spending: fromMinor(entry.spendingMinor, entry.currency),
          charges: fromMinor(entry.chargesMinor, entry.currency),
          credits: fromMinor(entry.creditsMinor, entry.currency),
          count: entry.count,
          cardPayments: fromMinor(entry.paymentsMinor, entry.currency),
          cardPaymentCount: entry.paymentCount,
          ...(entry.assetPurchaseCount ? { assetPurchases: fromMinor(entry.assetPurchasesMinor, entry.currency), assetPurchaseCount: entry.assetPurchaseCount } : {}),
        })),
        pending: (body.pending ?? []).map((entry) => ({ currency: entry.currency, count: entry.count, net: fromMinor(entry.netMinor, entry.currency) })),
        ...(groups.has('month') ? { byMonth: (body.byMonth ?? []).map((entry) => ({ month: entry.month, currency: entry.currency, ...amounts(entry) })) } : {}),
        ...(groups.has('categoryGroup') ? {
          byCategoryGroup: [...groupTotals.values()]
            .map((entry) => ({ categoryGroup: entry.categoryGroup, currency: entry.currency, spending: fromMinor(entry.spendingMinor, entry.currency), count: entry.count }))
            .sort((a, b) => (b.spending ?? 0) - (a.spending ?? 0)),
        } : {}),
        ...(groups.has('category') ? { byCategory } : {}),
        ...(groups.has('merchant') ? {
          byMerchant: (body.byMerchant ?? []).filter((entry) => {
            const rank = (merchantRank.get(entry.currency) ?? 0) + 1;
            merchantRank.set(entry.currency, rank);
            return rank <= top;
          }).map((entry) => ({ merchant: cleanText(entry.merchant, 80), currency: entry.currency, ...amounts(entry) })),
          otherMerchants: (body.otherMerchants ?? []).map((entry) => ({ currency: entry.currency, merchants: entry.merchants, ...amounts(entry) })),
        } : {}),
        ...(groups.has('card') ? {
          byCard: (body.byCard ?? []).map((entry) => ({ card: labelOf.get(entry.cardAccountId) ?? entry.cardAccountId, cardAccountId: entry.cardAccountId, currency: entry.currency, ...amounts(entry) })),
        } : {}),
        ...(groups.has('owner') ? { byOwner: (body.byOwner ?? []).map((entry) => ({ owner: entry.owner, currency: entry.currency, ...amounts(entry) })) } : {}),
        notes: [
          'spending = posted purchases, fees and interest minus refunds and credits; card payments are transfers and pending charges are not counted.',
          'Amounts are in each row\'s currency; positive is money spent.',
        ],
      };
      const headline = data.totals.map((entry) => `${formatMoney(entry.spending, entry.currency)} in ${entry.count} posted transactions`).join('; ') || 'no spending';
      const leaders = (data.byCategoryGroup ?? byCategory.map((entry) => ({ categoryGroup: entry.category, ...entry }))).slice(0, 3)
        .map((entry) => `${entry.categoryGroup} ${formatMoney(entry.spending, entry.currency)}`).join(', ');
      return answer(`Card spending, ${data.range.label}${card ? `, ${card.label}` : ''}${args.owner ? `, owner ${args.owner}` : ''}: ${headline}`
        + `${leaders ? `. Largest: ${leaders}` : ''}.`, data, ['byMerchant', 'byCategory', 'byMonth']);
    },
  };

  const cardTransactions = {
    name: 'list_card_transactions',
    title: 'Card transactions',
    description: 'Credit-card transactions, newest first by default: date, amount (positive = charge, negative = refund, credit or '
      + 'payment), merchant, category, card, status (pending/posted) and kind (purchase, refund, payment, fee, interest, '
      + 'adjustment). Filter by dates, card, owner, exact category, merchant, kinds, statuses, or free text (search also matches '
      + 'an exact amount such as 12.34). Up to 500 per call; page with offset.',
    inputSchema: objectSchema({
      period: PERIOD,
      month: MONTH,
      from: FROM,
      to: TO,
      card: CARD,
      owner: OWNER,
      category: { type: 'string', minLength: 1, maxLength: 100, description: 'Exactly one category name (see get_spending_summary).' },
      merchant: { type: 'string', minLength: 1, maxLength: 200, description: 'One merchant, by name.' },
      search: { type: 'string', minLength: 1, maxLength: 100, description: 'Text in the description, merchant, category or notes, or an exact amount (12.34).' },
      kinds: {
        type: 'array', items: { type: 'string', enum: ['purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'] }, minItems: 1, uniqueItems: true,
        description: 'Only these kinds, as Spending reads them (default all).',
      },
      statuses: {
        type: 'array', items: { type: 'string', enum: ['pending', 'posted', 'removed'] }, minItems: 1, uniqueItems: true,
        description: 'Only these statuses (default pending and posted).',
      },
      sort: { type: 'string', enum: ['date-desc', 'date-asc', 'amount-desc', 'amount-asc'], description: 'Order (default date-desc, newest first).' },
      limit: LIMIT(50),
      offset: OFFSET,
    }),
    async handler(args, { signal }) {
      const range = resolveDateRange(args, today());
      const cards = await loadCards(api, signal);
      const card = args.card ? resolveOneCard(args.card, cards) : null;
      const labelOf = new Map(cards.map((item) => [item.id, item.label]));
      const limit = args.limit ?? 50;
      const query = {
        cardAccountId: card?.id, owner: args.owner, category: args.category, merchant: args.merchant, q: args.search,
        from: range?.from, to: range?.to, kind: args.kinds?.join(','), status: args.statuses?.join(','), sort: args.sort ?? 'date-desc',
      };
      const rows = [];
      let offset = args.offset ?? 0;
      let total = 0;
      let nextOffset = null;
      while (rows.length < limit) {
        const page = await api.get('/card-transactions', { ...query, limit: Math.min(200, limit - rows.length), offset }, { signal });
        const transactions = Array.isArray(page.transactions) ? page.transactions : [];
        total = Number.isSafeInteger(page.total) ? page.total : rows.length + transactions.length;
        rows.push(...transactions);
        nextOffset = Number.isSafeInteger(page.nextOffset) ? page.nextOffset : null;
        if (nextOffset === null || transactions.length === 0) break;
        offset = nextOffset;
      }
      const defaultRole = (kind) => (kind === 'payment' ? 'transfer' : kind === 'other' ? 'excluded' : 'spending');
      const currencies = [...new Set(rows.map((row) => row.currency))];
      const common = currencies.length === 1 ? currencies[0] : null;
      // Compact rows, so that 500 fit the size budget: fields at their usual value are left out (see notes).
      const items = rows.map((row) => {
        const merchant = cleanText(row.merchantName ?? row.merchant ?? row.description, 60);
        const description = cleanText(row.description, 60);
        return {
          date: row.transactionDate,
          ...(row.postedDate && row.postedDate !== row.transactionDate ? { postedDate: row.postedDate } : {}),
          ...(row.status !== 'posted' ? { status: row.status } : {}),
          kind: row.kind,
          ...(row.role && row.role !== defaultRole(row.kind) ? { role: row.role } : {}),
          amount: fromMinor(row.amountMinor, row.currency),
          ...(row.currency !== common ? { currency: row.currency } : {}),
          ...(Number.isFinite(row.categoryPortionMinor) && row.categoryPortionMinor !== row.amountMinor
            ? { amountInCategory: fromMinor(row.categoryPortionMinor, row.currency) } : {}),
          ...(Number.isFinite(row.originalAmountMinor) && row.originalCurrency
            ? { original: { amount: fromMinor(row.originalAmountMinor, row.originalCurrency), currency: row.originalCurrency } } : {}),
          merchant,
          ...(description && description.toLowerCase() !== merchant?.toLowerCase() ? { description } : {}),
          category: cleanText(row.category, 100),
          card: labelOf.get(row.cardAccountId) ?? row.cardAccountId,
        };
      });
      const data = {
        range: range ?? { from: null, to: null, label: 'all time' },
        filters: {
          ...(card ? { card: card.label, cardAccountId: card.id } : {}),
          ...(args.owner ? { owner: args.owner } : {}),
          ...(args.category ? { category: args.category } : {}),
          ...(args.merchant ? { merchant: args.merchant } : {}),
          ...(args.search ? { search: cleanText(args.search, 100) } : {}),
          ...(args.kinds ? { kinds: args.kinds } : {}),
          ...(args.statuses ? { statuses: args.statuses } : {}),
          sort: query.sort,
        },
        total,
        offset: args.offset ?? 0,
        shown: items.length,
        nextOffset: rows.length >= limit ? nextOffset : null,
        currency: common ?? 'mixed',
        transactions: items,
        notes: [
          'amount: positive = money spent, negative = refund, credit or card payment; in the top-level currency unless a row names its own.',
          'A row without status is posted. role (how Spending counts the row) appears only when it is not the usual one for the kind: '
          + 'payments are transfers, other rows are not counted, everything else is spending; excluded marks an asset purchase such as bullion.',
        ],
      };
      return answer((fitted) => `${total} card transaction${total === 1 ? '' : 's'} match (${fitted.range.label}${card ? `, ${card.label}` : ''}); `
        + `${fitted.shown} shown from ${fitted.offset}, ${query.sort === 'date-desc' ? 'newest first' : query.sort}`
        + `${fitted.nextOffset === null ? '' : `; the next page starts at offset ${fitted.nextOffset}`}.`,
      data, ['transactions'], pageAdjust('transactions'));
    },
  };

  const benefits = {
    name: 'get_card_benefits',
    title: 'Card benefits and credits',
    description: 'Credit-card benefits such as statement credits, Uber Cash and certificates (Amex, Chase and Citi products in '
      + 'Holdr\'s catalog): per card and benefit, the current period (month, quarter, half-year, year or cardmember year) with '
      + 'what was available, used and is left, the days until it resets, and the year\'s captured value against the annual fee '
      + '(fee coverage). Used amounts come from matched statement credits, the owner\'s marks in Holdr, or the issuer\'s tracker.',
    inputSchema: objectSchema({
      card: { ...CARD, description: 'One card: its id, last four digits, or part of its nickname, issuer or product name (e.g. "Platinum").' },
      owner: OWNER,
      year: { type: 'integer', minimum: 2000, maximum: 2100, description: 'Calendar year of the report (default this year).' },
      onlyWithRemaining: { type: 'boolean', description: 'Only benefits with something (or an unknown amount) left in the current period (default false).' },
      includePeriods: { type: 'boolean', description: 'Include every period of the year, not just the current one (default false).' },
      includeClosed: { type: 'boolean', description: 'Include closed card accounts (default false).' },
    }),
    async handler(args, { signal }) {
      const report = await api.get('/spending/benefits', { year: args.year }, { signal });
      const all = (Array.isArray(report.cards) ? report.cards : []).map((card) => ({
        raw: card,
        id: card.cardAccountId,
        name: cleanText(card.nickname, 60) ?? issuerName(card.issuer),
        issuer: card.issuer,
        owner: card.owner,
        status: card.status,
        ending: cardEnding(card),
        product: card.product ? cleanText(card.product.name, 80) : null,
        productShort: card.product ? cleanText(card.product.shortName, 60) : null,
      })).map((card) => ({ ...card, label: card.ending ? `${card.name} …${card.ending}` : card.name }));
      let cards = all.filter((card) => args.includeClosed || card.status !== 'closed');
      if (args.owner) cards = cards.filter((card) => card.owner === args.owner);
      if (args.card) {
        const matches = matchCards(args.card, cards, (card) => [card.product, card.productShort]);
        if (matches.length === 0) throw new ToolInputError(`No card matches "${cleanText(args.card, 40)}". Cards: ${listCards(cards)}.`);
        cards = matches;
      }
      const amount = (unit, value) => (value === null || value === undefined ? null : unit === 'usd' ? fromMinor(value, 'USD') : value);
      const views = cards.map(({ raw, label }) => {
        const year = raw.totals ?? {};
        const benefitsOut = (raw.benefits ?? []).filter((benefit) => !args.onlyWithRemaining
          || (benefit.current && benefit.current.active && (benefit.current.remainingMinor === null || benefit.current.remainingMinor > 0)))
          .map((benefit) => ({
            id: benefit.id,
            name: cleanText(benefit.name, 80),
            cadence: benefit.cadenceLabel,
            unit: benefit.unit === 'usd' ? 'USD' : benefit.noun ?? 'count',
            enrollmentRequired: benefit.enrollment,
            tracking: benefit.tracking === 'manual' ? `manual (${benefit.manualReason ?? 'marked by the owner'})` : 'matched statement credits',
            ...(benefit.verify ? { unverified: true } : {}),
            current: benefit.current ? {
              period: benefit.current.label,
              start: benefit.current.start,
              end: benefit.current.end,
              daysLeft: benefit.current.daysLeft,
              available: amount(benefit.unit, benefit.current.availableMinor),
              used: amount(benefit.unit, benefit.current.usedMinor),
              remaining: amount(benefit.unit, benefit.current.remainingMinor),
              usedFrom: benefit.current.source,
              ...(benefit.current.resetsSoon ? { resetsSoon: true } : {}),
            } : null,
            year: {
              captured: amount(benefit.unit, benefit.year?.capturedMinor),
              available: amount(benefit.unit, benefit.year?.availableMinor),
              ...(benefit.year?.unknownPeriods ? { periodsWithUnknownUse: benefit.year.unknownPeriods } : {}),
            },
            ...(benefit.window ? { window: benefit.window } : {}),
            ...(args.includePeriods ? {
              periods: (benefit.periods ?? []).filter((period) => period.active).map((period) => ({
                period: period.label, start: period.start, end: period.end, state: period.state,
                available: amount(benefit.unit, period.availableMinor), used: amount(benefit.unit, period.usedMinor), usedFrom: period.source,
              })),
            } : {}),
            ...(benefit.needsAnniversary ? { needsAnniversaryMonth: true } : {}),
            ...(benefit.note ? { note: cleanText(benefit.note, 160) } : {}),
          }));
        const captured = fromMinor(year.capturedMinor ?? 0, 'USD');
        const fee = fromMinor(year.annualFeesMinor ?? 0, 'USD');
        return {
          cardAccountId: raw.cardAccountId,
          card: label,
          issuer: raw.issuer,
          owner: raw.owner,
          status: raw.status,
          product: raw.product ? { name: cleanText(raw.product.name, 80), annualFee: fromMinor(raw.product.annualFeeMinor, 'USD'), ...(raw.product.feeVerify ? { feeUnverified: true } : {}) } : null,
          productFrom: raw.productSource,
          ...(raw.needsAnniversary ? { needsAnniversaryMonth: true } : {}),
          year: { captured, available: fromMinor(year.availableMinor ?? 0, 'USD'), annualFee: fee, feeCoveredPct: fee ? percentOf(captured, fee) : null },
          benefits: benefitsOut,
        };
      });
      const shownIds = new Set(cards.map((card) => card.id));
      const labelOf = new Map(all.map((card) => [card.id, card.label]));
      const household = report.household ?? {};
      const data = {
        year: report.year,
        today: report.today,
        household: {
          captured: fromMinor(household.capturedMinor ?? 0, 'USD'),
          available: fromMinor(household.availableMinor ?? 0, 'USD'),
          annualFees: fromMinor(household.annualFeesMinor ?? 0, 'USD'),
          feeCoveredPct: household.annualFeesMinor ? percentOf(household.capturedMinor ?? 0, household.annualFeesMinor) : null,
        },
        cards: views,
        resetsSoon: (report.resetsSoon ?? []).filter((item) => shownIds.has(item.cardAccountId)).map((item) => ({
          card: labelOf.get(item.cardAccountId) ?? item.cardAccountId,
          benefit: cleanText(item.benefitName, 80),
          ends: item.end,
          daysLeft: item.daysLeft,
          remaining: amount(item.unit, item.remainingMinor),
          unit: item.unit === 'usd' ? 'USD' : 'count',
        })),
        notes: [
          'USD amounts are dollars; count benefits (free nights, certificates) are counts and never in dollar totals.',
          'used is null when Holdr cannot know it (a manual benefit without the owner\'s mark); remaining is then null too.',
          'Household totals cover active cards and dollar benefits only.',
        ],
      };
      const left = views.flatMap((view) => view.benefits).reduce((sum, benefit) => sum + (benefit.unit === 'USD' && benefit.current?.remaining ? benefit.current.remaining : 0), 0);
      const scope = args.card || args.owner ? views.map((view) => view.card).join(', ') || 'no matching card' : `${views.length} cards`;
      const feeText = views.length === 1 && views[0].year.annualFee
        ? ` against a ${formatMoney(views[0].year.annualFee)} annual fee (${views[0].year.feeCoveredPct ?? 0}% covered)` : '';
      const captured = views.reduce((sum, view) => sum + (view.year.captured ?? 0), 0);
      return answer(`Card benefits ${report.year} (${scope}): ${formatMoney(captured)} captured this year${feeText}; `
        + `${formatMoney(left)} left in current periods${data.resetsSoon.length ? `; ${data.resetsSoon.length} reset soon (first: ${data.resetsSoon[0].benefit}, ${data.resetsSoon[0].daysLeft} days)` : ''}.`,
      data, ['cards']);
    },
  };

  const forecast = {
    name: 'get_spending_forecast',
    title: 'Spending forecast',
    description: 'Holdr\'s card spending forecast: this month\'s pace (spent so far, the projected month total with an 80% range, '
      + 'and a typical month), everyday spending for the next three months overall and by category (estimates with 80% and '
      + '95% ranges, backtested on complete months), recent months split into everyday spending and large one-off purchases, '
      + 'recurring bills expected in the next 60 days, and unusual spending last month. Filter by card or owner.',
    inputSchema: objectSchema({
      card: CARD,
      owner: OWNER,
      currency: { type: 'string', pattern: '^[A-Z]{3}$', examples: ['USD'], description: 'Currency to forecast (default the one most cards in view use).' },
      historyMonths: { type: 'integer', minimum: 1, maximum: 36, description: 'How many recent months to list (default 6).' },
      includeCategories: { type: 'boolean', description: 'Include the per-category forecasts (default true).' },
      categoriesLimit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many categories (default 8, largest first).' },
      includeBills: { type: 'boolean', description: 'Include upcoming recurring bills and unusual spending (default true).' },
    }),
    async handler(args, { signal }) {
      const cards = args.card ? await loadCards(api, signal) : [];
      const card = args.card ? resolveOneCard(args.card, cards) : null;
      const query = { cardAccountId: card?.id, owner: args.owner, currency: args.currency };
      const [body, patterns] = await Promise.all([
        api.get('/spending/forecast', query, { signal }),
        args.includeBills === false ? Promise.resolve(null) : api.get('/spending/patterns', query, { signal }),
      ]);
      const currency = body.currency ?? 'USD';
      const dollars = (minor) => fromMinor(minor, currency);
      const range = (item) => (item ? [dollars(item.lowerMinor), dollars(item.upperMinor)] : null);
      const series = (item) => (item ? {
        method: item.method,
        tested: item.tested,
        historyMonths: item.historyMonths,
        ...(item.thin ? { thin: true } : {}),
        recentMedian: dollars(item.recentMedianMinor),
        months: (item.months ?? []).map((month) => ({ month: month.month, estimate: dollars(month.pointMinor), range80: range(month.range80), range95: range(month.range95) })),
        ...(item.backtest ? { backtest: { months: item.backtest.months, meanAbsoluteError: dollars(item.backtest.maeMinor), mapePct: round(item.backtest.mape, 1) } } : {}),
      } : null);
      const pace = body.pace ?? {};
      const data = {
        currency,
        today: body.today,
        month: body.month,
        filters: { ...(card ? { card: card.label, cardAccountId: card.id } : {}), ...(args.owner ? { owner: args.owner } : {}) },
        thisMonth: {
          daysElapsed: pace.daysElapsed,
          daysInMonth: pace.daysInMonth,
          spentSoFar: dollars(pace.spentMinor),
          everydaySoFar: dollars(pace.everydaySpentMinor),
          oneOffsSoFar: dollars(pace.oneOffsMinor),
          pendingNotCounted: dollars(pace.pendingMinor),
          projectedTotal: dollars(pace.projectedMinor),
          projectedRange80: pace.projectedRange80 ? range(pace.projectedRange80) : null,
          typicalMonth: dollars(pace.typicalMinor),
          ...(pace.monthSoFarComplete === false ? { recordIncomplete: true } : {}),
        },
        everydayForecast: series(body.total),
        ...(args.includeCategories === false ? {} : {
          categories: (body.categories ?? []).slice(0, args.categoriesLimit ?? 8).map((item) => ({ category: item.category, ...series(item) })),
        }),
        recentMonths: (body.months ?? []).slice(-(args.historyMonths ?? 6)).map((month) => ({
          month: month.month,
          spending: dollars(month.spendingMinor),
          everyday: dollars(month.everydayMinor),
          oneOffs: dollars(month.oneOffsMinor),
          complete: month.complete,
          ...(month.inProgress ? { inProgress: true } : {}),
        })),
        oneOffThreshold: dollars(body.oneOffThresholdMinor),
        ...(patterns ? {
          bills: {
            from: patterns.bills?.from,
            to: patterns.bills?.to,
            count: patterns.bills?.count ?? 0,
            total: dollars(patterns.bills?.totalMinor),
            upcoming: (patterns.bills?.items ?? []).slice(0, 25).map((bill) => ({
              date: bill.date, merchant: cleanText(bill.merchant, 80), amount: dollars(bill.amountMinor), cadence: bill.cadence,
              ...(bill.fixed ? { fixed: true } : {}), ...(bill.late ? { late: true } : {}), ...(bill.expectedBeforeToday ? { overdue: true } : {}),
            })),
          },
          unusual: (patterns.anomalies ?? []).map((item) => ({
            category: item.category ?? 'all everyday spending', month: item.month, amount: dollars(item.amountMinor),
            median: dollars(item.medianMinor), direction: item.direction, z: item.z,
          })),
        } : {}),
        notes: [
          'Everyday spending leaves out large one-off purchases (at or above oneOffThreshold) and asset purchases such as bullion.',
          'Forecasts learn only from months whose card record is complete; estimates are not promises.',
        ],
      };
      const next = data.everydayForecast?.months?.[0];
      return answer(`Spending forecast (${currency}${card ? `, ${card.label}` : ''}): ${body.month} so far ${formatMoney(data.thisMonth.spentSoFar, currency)} `
        + `(day ${pace.daysElapsed ?? '?'} of ${pace.daysInMonth ?? '?'})${data.thisMonth.projectedTotal === null ? '' : `, heading for about ${formatMoney(data.thisMonth.projectedTotal, currency)}`}`
        + `${data.thisMonth.typicalMonth === null ? '' : ` (typical month ${formatMoney(data.thisMonth.typicalMonth, currency)})`}`
        + `${next ? `; everyday spending in ${next.month} about ${formatMoney(next.estimate, currency)}` : ''}`
        + `${data.bills ? `; ${data.bills.count} bills due by ${data.bills.to} (${formatMoney(data.bills.total, currency)})` : ''}.`,
      data, ['categories', 'recentMonths']);
    },
  };

  return [health, portfolioSummary, positions, investmentTransactions, metals, spendingSummary, cardTransactions, benefits, forecast];
}


/**
 * One metal's overview as a compact view (`summary`, with every partial or unknown figure listed in `caveats`) and its
 * purchase lots, newest first (`lots`).
 */
function metalView(code, overview, purchases) {
  const value = (measure) => (measure && typeof measure === 'object' ? measure.value ?? null : null);
  const ounces = (measure) => {
    const troy = value(measure);
    return troy && typeof troy.display === 'string' ? Number(troy.display) : null;
  };
  const caveats = [];
  const note = (label, measure) => {
    if (measure && measure.state && measure.state !== 'complete') {
      const reasons = (measure.reasons ?? []).map((reason) => `${reason.code} (${reason.records})`).join(', ');
      caveats.push(`${label} is ${measure.state}${reasons ? `: ${reasons}` : ''}`);
    }
  };
  const metal = METAL_NAMES[code] ?? code;
  const holdings = overview.holdings ?? {};
  const activity = overview.activity ?? {};
  const cost = fromMinor(value(holdings.costMinor));
  const worth = fromMinor(value(holdings.valueMinor));
  const gain = fromMinor(value(holdings.gainMinor));
  note('troy ounces held', holdings.troyOz);
  note('cost', holdings.costMinor);
  note('value', holdings.valueMinor);
  note('gain', holdings.gainMinor);
  note('realized profit', activity.profit?.valueMinor);
  const lots = (Array.isArray(purchases?.purchases) ? purchases.purchases.slice() : [])
    .sort((a, b) => (a.orderDate < b.orderDate ? 1 : a.orderDate > b.orderDate ? -1 : 0))
    .map((lot) => ({
      metal,
      orderDate: lot.orderDate,
      title: cleanText(lot.title, 100),
      form: lot.form,
      account: cleanText(lot.account?.label, 60),
      unitsOrdered: lot.units?.ordered ?? lot.quantity ?? null,
      unitsKept: lot.units ? lot.units.delivered + lot.units.awaiting : null,
      delivery: lot.delivery?.state ?? null,
      troyOz: lot.content?.known ? Number(lot.content.troyOz.display) : null,
      troyOzPerUnit: lot.content?.known ? Number(lot.content.troyOzPerUnit.display) : null,
      cost: fromMinor(value(lot.costMinor)),
      premiumPerOz: fromMinor(lot.premiumPaidPerOzMinor),
      ...(lot.quarantined ? { quarantined: true } : {}),
    }));
  const summary = {
    metal,
    code,
    asOf: overview.asOf,
    price: {
      usdPerTroyOz: overview.price?.close ? Number(overview.price.close) : null,
      closeDate: overview.price?.closeDate ?? null,
      ...(overview.price?.stale ? { stale: true } : {}),
      ...(overview.price && overview.price.fetching === false ? { pricesOff: true } : {}),
    },
    holdings: {
      troyOz: ounces(holdings.troyOz),
      units: holdings.units?.held ?? null,
      cost,
      value: worth,
      gain,
      gainPct: gain !== null && cost ? percentOf(gain, cost) : null,
      awaitingDeliveryTroyOz: ounces(holdings.awaitingTroyOz),
      ...(holdings.contentUnknown?.lots
        ? { contentUnknown: { lots: holdings.contentUnknown.lots, units: holdings.contentUnknown.units, cost: fromMinor(holdings.contentUnknown.costMinor) } }
        : {}),
    },
    byForm: (holdings.classes ?? []).map((entry) => ({
      form: entry.form,
      fineTroyOzPerUnit: entry.fineTroyOzPerUnit?.display ? Number(entry.fineTroyOzPerUnit.display) : null,
      unitsHeld: entry.units?.held ?? null,
      troyOz: ounces(entry.troyOz),
      cost: fromMinor(value(entry.costMinor)),
      value: fromMinor(value(entry.valueMinor)),
      gain: fromMinor(value(entry.gainMinor)),
    })),
    bySource: (holdings.bySource ?? []).map((entry) => ({
      account: cleanText(entry.label, 60), source: entry.source, units: entry.units, troyOz: ounces(entry.troyOz),
      cost: fromMinor(value(entry.costMinor)), value: fromMinor(value(entry.valueMinor)),
    })),
    activity: {
      from: activity.from ?? null,
      to: activity.to ?? null,
      bought: activity.bought
        ? { lots: activity.bought.lots, units: activity.bought.units, troyOz: ounces(activity.bought.troyOz), cost: fromMinor(value(activity.bought.costMinor)) }
        : null,
      sold: activity.sold ? {
        lines: activity.sold.lines,
        units: activity.sold.units,
        troyOz: ounces(activity.sold.troyOz),
        gross: fromMinor(value(activity.sold.grossMinor)),
        fees: fromMinor(value(activity.sold.feesMinor)),
        net: fromMinor(value(activity.sold.netMinor)),
      } : null,
      realizedProfit: fromMinor(value(activity.profit?.valueMinor)),
    },
    toCheck: { records: overview.toCheck?.records ?? 0, needsYou: (overview.toCheck?.needsYou ?? []).map((item) => item.code) },
    caveats,
    ...(purchases ? { lotsTotal: lots.length } : {}),
  };
  return { summary, lots };
}
