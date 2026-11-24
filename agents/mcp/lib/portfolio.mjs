// Positions from an investment ledger: a port of packages/shared/src/portfolio.ts (aggregatePositions and what it uses,
// plus positionsPnLPercent), so this server runs without a build of the shared package and computes exactly what the
// Portfolio page shows. tests/portfolio.test.mjs compares the two on synthetic ledgers whenever packages/shared is built.

const POSITION_EPSILON = 1e-9;
const COST_EPSILON = POSITION_EPSILON;
const ZERO_PNL_RELATIVE = 1e-9;
const OCC_PATTERN = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** Whether `value` is a valid OCC option symbol (packages/shared/src/options.ts, parseOccSymbol). */
export function isOccSymbol(value) {
  const match = String(value).trim().toUpperCase().match(OCC_PATTERN);
  if (!match) return false;
  const [, , yearPart, monthPart, dayPart, , strikePart] = match;
  const year = 2000 + Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const expiration = new Date(Date.UTC(year, month - 1, day));
  if (expiration.getUTCFullYear() !== year || expiration.getUTCMonth() !== month - 1 || expiration.getUTCDate() !== day) return false;
  return Number(strikePart) / 1_000 > 0;
}

export function positionMarketValue(position, price) {
  return position.quantity * (position.contractMultiplier ?? 1) * price;
}

export function aggregateOptionPosition(symbol, txs) {
  const optionTxs = txs
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => transaction.symbol === symbol)
    .sort((left, right) => left.transaction.date.localeCompare(right.transaction.date) || left.index - right.index)
    .map(({ transaction }) => transaction);
  if (optionTxs.length === 0) return null;
  if (!isOccSymbol(symbol)) throw new Error(`invalid OCC option symbol: ${symbol}`);

  const multiplier = optionTxs[0].contractMultiplier;
  if (typeof multiplier !== 'number' || !Number.isInteger(multiplier) || multiplier <= 0) {
    throw new Error(`option ${symbol} requires a positive integer contractMultiplier`);
  }
  const currency = optionTxs[0].currency;
  let quantity = 0;
  let costBasis = 0;

  for (const transaction of optionTxs) {
    if (transaction.instrumentType !== 'option' || transaction.contractMultiplier !== multiplier || !transaction.positionEffect) {
      throw new Error(`option ${symbol} has incomplete or inconsistent metadata`);
    }
    if (transaction.currency !== currency) throw new Error(`option ${symbol} mixes currencies`);

    const fees = transaction.fees ?? 0;
    if (transaction.positionEffect === 'open') {
      if (Math.abs(quantity) > POSITION_EPSILON && Math.sign(quantity) !== Math.sign(transaction.quantity)) {
        throw new Error(`option ${symbol} opening trade crosses the existing position`);
      }
      const grossPremium = Math.abs(transaction.quantity) * multiplier * transaction.pricePerUnit;
      costBasis += transaction.quantity > 0 ? grossPremium + fees : -grossPremium + fees;
      quantity += transaction.quantity;
      continue;
    }

    if (Math.abs(quantity) <= POSITION_EPSILON) throw new Error(`option ${symbol} close has no open position`);
    if (Math.sign(quantity) === Math.sign(transaction.quantity)) throw new Error(`option ${symbol} close does not oppose the open position`);
    const openContracts = Math.abs(quantity);
    const closingContracts = Math.abs(transaction.quantity);
    if (closingContracts > openContracts + POSITION_EPSILON) throw new Error(`option ${symbol} close exceeds the open contract count`);
    const remainingContracts = openContracts - closingContracts;
    if (remainingContracts <= POSITION_EPSILON) {
      quantity = 0;
      costBasis = 0;
    } else {
      costBasis *= remainingContracts / openContracts;
      quantity += transaction.quantity;
    }
  }

  if (Math.abs(quantity) <= POSITION_EPSILON) {
    return { symbol, quantity: 0, averageCost: 0, costBasis: 0, currency, instrumentType: 'option', contractMultiplier: multiplier };
  }
  return {
    symbol,
    quantity,
    averageCost: Math.abs(costBasis) / (Math.abs(quantity) * multiplier),
    costBasis,
    currency,
    instrumentType: 'option',
    contractMultiplier: multiplier,
  };
}

/** One symbol's position, weighted-average cost: buys add their cost and fees, sells remove shares at the average cost. */
export function aggregatePosition(symbol, txs) {
  const symbolTxs = txs.filter((t) => t.symbol === symbol);
  if (symbolTxs.length === 0) return null;
  const optionCount = symbolTxs.filter((transaction) => transaction.instrumentType === 'option').length;
  if (optionCount > 0) {
    if (optionCount !== symbolTxs.length) throw new Error(`instrument ${symbol} mixes option and equity transactions`);
    return aggregateOptionPosition(symbol, symbolTxs);
  }

  const ordered = symbolTxs.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let quantity = 0;
  let costBasis = 0;
  let runningAvgCost = 0;
  const currency = ordered[0].currency;

  for (const t of ordered) {
    const fees = t.fees ?? 0;
    if (t.quantity > 0) {
      const lotCost = t.quantity * t.pricePerUnit + fees;
      const newQty = quantity + t.quantity;
      runningAvgCost = newQty > 0 ? (quantity * runningAvgCost + lotCost) / newQty : 0;
      costBasis += lotCost;
      quantity = newQty;
    } else {
      const soldQty = -t.quantity;
      const costRemoved = soldQty * runningAvgCost + fees;
      costBasis -= costRemoved;
      quantity -= soldQty;
      if (Math.abs(quantity) < 1e-9) {
        quantity = 0;
        costBasis = 0;
        runningAvgCost = 0;
      }
    }
  }

  return { symbol, quantity, averageCost: runningAvgCost, costBasis, currency };
}

/**
 * Drops legacy "imported" snapshot rows for any (account, symbol) that also has broker activity rows, so the same shares
 * are never counted twice (the Pull positions snapshot and the Sync activity rows).
 */
export function dropImportedSnapshotsWhereActivityExists(txs) {
  const hasActivity = new Set();
  for (const t of txs) {
    const fp = t.sourceFingerprint;
    if (fp && !fp.startsWith('pos:')) hasActivity.add(`${t.accountId}\u0000${t.symbol}`);
  }
  if (hasActivity.size === 0) return txs;
  return txs.filter((t) => {
    const fp = t.sourceFingerprint;
    const isModernSnapshot = !!fp && fp.startsWith('pos:');
    const isLegacySnapshot = !fp && typeof t.notes === 'string' && /^imported\b/i.test(t.notes);
    if (!isModernSnapshot && !isLegacySnapshot) return true;
    return !hasActivity.has(`${t.accountId}\u0000${t.symbol}`);
  });
}

const isOpen = (position) => position
  && (position.instrumentType === 'option' ? Math.abs(position.quantity) > POSITION_EPSILON : position.quantity > POSITION_EPSILON);

/** One position per symbol with a holding; a negative equity quantity (an incomplete history) is not a holding. */
export function aggregatePositions(txs) {
  const filtered = dropImportedSnapshotsWhereActivityExists(txs);
  const symbols = Array.from(new Set(filtered.map((t) => t.symbol)));
  const positions = [];
  for (const symbol of symbols) {
    const position = aggregatePosition(symbol, filtered);
    if (isOpen(position)) positions.push(position);
  }
  return positions;
}

/**
 * aggregatePositions, except that a symbol whose ledger the shared code would refuse (inconsistent option rows) is reported
 * in `problems` instead of failing the whole account.
 */
export function aggregatePositionsSafe(txs) {
  const filtered = dropImportedSnapshotsWhereActivityExists(txs);
  const positions = [];
  const problems = [];
  for (const symbol of Array.from(new Set(filtered.map((t) => t.symbol)))) {
    try {
      const position = aggregatePosition(symbol, filtered);
      if (isOpen(position)) positions.push(position);
    } catch (error) {
      problems.push({ symbol, problem: error instanceof Error ? error.message.replace(/^option \S+ |^instrument \S+ /, '') : 'cannot be read' });
    }
  }
  return { positions, problems };
}

/**
 * The gain or loss percent over the positions' cost, cash left out: null when a price is missing (`known` false) or the
 * positions cost nothing; a gain within float noise of zero is exactly 0.
 */
export function positionsPnLPercent(pnl, positionsCostBasis, known = true) {
  if (!known || !Number.isFinite(pnl) || !Number.isFinite(positionsCostBasis)) return null;
  const base = Math.abs(positionsCostBasis);
  if (base < COST_EPSILON) return null;
  if (Math.abs(pnl) <= ZERO_PNL_RELATIVE * base) return 0;
  return (pnl / base) * 100;
}
