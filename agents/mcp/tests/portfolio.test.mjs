import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { aggregatePositions, aggregatePositionsSafe, positionsPnLPercent } from '../lib/portfolio.mjs';
import { OPTION, REPO_ROOT } from './helpers.mjs';

const trade = (accountId, symbol, date, quantity, pricePerUnit, extra = {}) => ({ id: `${symbol}-${date}-${quantity}`, accountId, symbol, date, quantity, pricePerUnit, currency: 'USD', ...extra });
const option = (date, quantity, pricePerUnit, positionEffect, extra = {}) => trade('a', OPTION, date, quantity, pricePerUnit, { instrumentType: 'option', contractMultiplier: 100, positionEffect, ...extra });

/** Synthetic ledgers that exercise every rule: averages, partial and full sells, re-opening, snapshots, options, shorts. */
const LEDGERS = {
  averages: [trade('a', 'VTI', '2026-01-05', 10, 200, { fees: 1 }), trade('a', 'VTI', '2026-03-05', 10, 220), trade('a', 'VTI', '2026-06-01', -5, 250, { fees: 2 })],
  reopened: [trade('a', 'QQQ', '2025-01-01', 3, 100), trade('a', 'QQQ', '2025-02-01', -3, 120), trade('a', 'QQQ', '2025-03-01', 2, 90)],
  unordered: [trade('a', 'SMPL', '2026-05-01', -2, 30), trade('a', 'SMPL', '2026-01-01', 5, 20)],
  orphanSell: [trade('a', 'MSFT', '2026-01-01', -4, 300), trade('a', 'AAPL', '2026-01-01', 1, 150)],
  snapshots: [
    trade('a', 'NVDA', '2026-01-01', 10, 100, { sourceFingerprint: 'pos:NVDA' }),
    trade('a', 'NVDA', '2026-01-02', 4, 110, { sourceFingerprint: 'f'.repeat(64) }),
    trade('a', 'AMD', '2026-01-01', 3, 90, { notes: 'imported from broker' }),
    trade('b', 'NVDA', '2026-01-01', 7, 100, { sourceFingerprint: 'pos:NVDA' }),
  ],
  options: [option('2026-07-01', 2, 5, 'open', { fees: 1.3 }), option('2026-08-01', -1, 7, 'close')],
  shortOption: [option('2026-07-01', -3, 4, 'open'), option('2026-07-15', 1, 2, 'close')],
  closedOption: [option('2026-07-01', 1, 5, 'open'), option('2026-07-02', -1, 6, 'close')],
};

test('positions from a hand-checked ledger: weighted-average cost, sells at the average, snapshots dropped beside activity', () => {
  assert.deepEqual(aggregatePositions(LEDGERS.averages), [{ symbol: 'VTI', quantity: 15, averageCost: 210.05, costBasis: 3148.75, currency: 'USD' }]);
  assert.deepEqual(aggregatePositions(LEDGERS.reopened), [{ symbol: 'QQQ', quantity: 2, averageCost: 90, costBasis: 180, currency: 'USD' }]);
  assert.deepEqual(aggregatePositions(LEDGERS.orphanSell).map((position) => position.symbol), ['AAPL'], 'a negative holding is an incomplete history, not a short');
  const snapshots = aggregatePositions(LEDGERS.snapshots.filter((row) => row.accountId === 'a'));
  assert.deepEqual(snapshots.map((position) => [position.symbol, position.quantity]), [['NVDA', 4], ['AMD', 3]]);
  const [contracts] = aggregatePositions(LEDGERS.options);
  assert.equal(contracts.quantity, 1);
  assert.equal(contracts.costBasis, 500.65);
  assert.deepEqual(aggregatePositions(LEDGERS.closedOption), []);
  const [short] = aggregatePositions(LEDGERS.shortOption);
  assert.equal(short.quantity, -2);
  assert.equal(positionsPnLPercent(50, 1000), 5);
  assert.equal(positionsPnLPercent(50, 0), null);
  assert.equal(positionsPnLPercent(1e-12, 1000), 0);
  assert.equal(positionsPnLPercent(50, 1000, false), null);
});

test('a ledger the shared code would refuse is reported per symbol instead of failing the account', () => {
  const broken = [...LEDGERS.averages, option('2026-07-01', 1, 5, 'close')];
  assert.throws(() => aggregatePositions(broken), /close has no open position/);
  const { positions, problems } = aggregatePositionsSafe(broken);
  assert.deepEqual(positions.map((position) => position.symbol), ['VTI']);
  assert.deepEqual(problems, [{ symbol: OPTION, problem: 'close has no open position' }]);
});

const SHARED = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'portfolio.js');

test('the same positions as packages/shared computes (when it is built)', { skip: !fs.existsSync(SHARED) && 'packages/shared is not built (npm ci builds it)' }, async () => {
  const shared = await import(pathToFileURL(SHARED).href);
  for (const [name, ledger] of Object.entries(LEDGERS)) {
    assert.deepEqual(aggregatePositions(ledger), shared.aggregatePositions(ledger), name);
  }
  assert.equal(positionsPnLPercent(123.45, -678.9), shared.positionsPnLPercent(123.45, -678.9));
});
