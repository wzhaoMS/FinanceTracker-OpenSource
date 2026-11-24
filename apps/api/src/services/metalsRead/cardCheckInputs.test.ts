import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mergeCardCoverage, type CardCoverageRange } from '@finance-tracker/shared';
import type { MetalsOrder } from '@finance-tracker/shared/metals-ledger';
import { delivered, metalItem, syntheticCoverage, syntheticOrder, syntheticPayload } from '@finance-tracker/shared/metals-ledger-fixtures';

import { cardCoverageEvidence } from '../../routes/cardSpendingOverview.js';
import { cardSyncActorRef } from '../cardSyncDigests.js';
import { importMetalsPayload, installMetalsSchema, metalsPayloadSha256 } from '../metals/index.js';
import { SqliteStateRepo, type CardImportRow } from '../sqliteStateRepo.js';
import { metalsCardHistory, metalsReadSnapshot, readMetalsCardCheckReads } from './cardCheckInputs.js';
import { MetalsReadModel } from './source.js';

// Synthetic only: invented card accounts (last 4s 0001-0003), merchants, amounts, orders and GO ids, on scratch
// databases this build made, through the real card import, the real metals install and import (G2).

const NOW = '2030-03-20T16:00:00.000Z';
const LETTERS_32 = 'abcdefghijklmnop'.repeat(2);
const LETTERS_64 = LETTERS_32.repeat(2);

let dir: string;
let repo: SqliteStateRepo;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-card-check-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date(NOW) });
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const db = () => repo.internalGetDb();

const cardRow = (patch: Partial<CardImportRow>): CardImportRow => ({
  transactionDate: '2030-01-11', postedDate: null, status: 'posted', amountMinor: 101, currency: 'USD', kind: 'purchase',
  description: 'SAMPLE BULLION CO', merchant: null, issuerCategory: null, ...patch,
} as CardImportRow);

function importRows(cardAccountId: string, rows: CardImportRow[], coverage?: { start: string; end: string }): void {
  repo.importCardTransactions({ cardAccountId, source: 'test-file', parserVersion: 'test@1', rows, ...(coverage ? { coverage } : {}) });
}

/** A Walmart order of one 1 oz gold Eagle coin (content by coin specification) by the card ending 0001, delivered four days after it was ordered. */
function walmartBar(id: string, date: string): MetalsOrder {
  const deliveredOn = new Date(Date.parse(`${date}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 200000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '0001', amountMinor: 200000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000,
    },
    lines: [{
      ordinal: 0, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'walmart:400001', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle',
      quantity: 1, unitPriceMinor: 200000, events: [delivered(1, deliveredOn)], seller: 'Sample Bullion Shop',
    }],
  });
}

/** Imports one Walmart payload through G2's real importer: a new account of its folder unless one is named. */
function importWalmart(order: MetalsOrder, minute: number, account: { label: string } | { accountId: string }, folder = 'walmart'):
  { importId: string; accountId: string } {
  const payload = { ...syntheticPayload('walmart', { orders: [order], coverage: [syntheticCoverage('online', '2029-01-01', '2030-03-19', 1, 1)] }),
    account: { folder, identityLast4: null } };
  const receipt = importMetalsPayload(db(), { payload, account }, { now: `2030-03-20T12:0${minute}:00.000Z`, goId: randomBytes(16).toString('hex'),
    purpose: 'copy-rehearsal', inputSha256: metalsPayloadSha256(payload), planDigest: null });
  expect(receipt.code).toBe('metals-imported');
  const importId = db().prepare('SELECT import_id FROM metals_imports ORDER BY import_seq DESC LIMIT 1').pluck().get() as string;
  return { importId, accountId: receipt.accountId! };
}

describe('the card check\'s own reads', () => {
  // Read only inside an installed ledger's snapshot (source.ts), so always over the metals tables.
  beforeEach(() => installMetalsSchema(db()));

  it('reads Spending\'s known card coverage exactly as cardCoverageEvidence does: declared ranges and verified windows, merged', () => {
    const first = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '0001', currency: 'USD' });
    const second = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '0002', currency: 'USD' });
    const closed = repo.createCardAccount({ issuer: 'thirdbank', owner: 'joint', last4: '0003', currency: 'USD' });
    importRows(first.id, [cardRow({ transactionDate: '2030-01-11' })], { start: '2030-01-01', end: '2030-01-31' });
    importRows(first.id, [cardRow({ transactionDate: '2030-02-11', amountMinor: 102 })], { start: '2030-02-01', end: '2030-02-15' });
    importRows(first.id, [cardRow({ transactionDate: '2030-03-11', amountMinor: 103 })], { start: '2030-03-10', end: '2030-03-20' });
    importRows(closed.id, [cardRow({ transactionDate: '2029-06-11', amountMinor: 104 })], { start: '2029-06-01', end: '2029-06-30' });
    // A row outside every declared range: the days rows span never count.
    importRows(closed.id, [cardRow({ transactionDate: '2029-09-11', amountMinor: 105 })]);
    repo.updateCardAccount(closed.id, { status: 'closed' });
    const window = (cardAccountId: string, verifiedCompleteness: string, requested: { basis: string; start: string; end: string } | null) =>
      ({ cardAccountId, verifiedCompleteness, requested });
    const windows = vi.spyOn(repo, 'listCardCoverageWindows').mockReturnValue([
      // Verified complete on the transaction-date basis: counts, and fills the first card's gap between its imports.
      window(first.id, 'complete', { basis: 'transaction', start: '2030-02-16', end: '2030-03-09' }),
      window(second.id, 'complete', { basis: 'transaction', start: '2030-01-01', end: '2030-01-31' }),
      // Partial, on another basis, or with no request: never counts.
      window(second.id, 'partial', { basis: 'transaction', start: '2030-02-01', end: '2030-02-28' }),
      window(closed.id, 'complete', { basis: 'posted', start: '2029-07-01', end: '2029-07-31' }),
      window(first.id, 'complete', null),
    ] as never);

    const reads = readMetalsCardCheckReads(db(), repo);
    expect(windows.mock.calls).toEqual([[{ ledgerStates: ['committed'] }]]);
    expect(reads.cardCoverage).toEqual([
      { accountId: first.id, covered: [{ from: '2030-01-01', to: '2030-03-20' }] },
      { accountId: second.id, covered: [{ from: '2030-01-01', to: '2030-01-31' }] },
      { accountId: closed.id, covered: [{ from: '2029-06-01', to: '2029-06-30' }] },
    ].sort((a, b) => (a.accountId < b.accountId ? -1 : 1)));

    // The route's own evidence, merged per account, is the same.
    const byAccount = new Map<string, CardCoverageRange[]>();
    for (const entry of cardCoverageEvidence(repo)) byAccount.set(entry.cardAccountId, [...(byAccount.get(entry.cardAccountId) ?? []), ...entry.ranges]);
    expect(windows.mock.calls).toEqual([[{ ledgerStates: ['committed'] }], [{ ledgerStates: ['committed'] }]]);
    expect(reads.cardCoverage).toEqual([...byAccount.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([accountId, ranges]) => ({ accountId, covered: mergeCardCoverage(ranges).map((range) => ({ from: range.start, to: range.end })) })));
  });

  it('reads posted refunds as credits, in their own list: never a pending, dismissed or removed row, nor a purchase', () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '0001', currency: 'USD' });
    importRows(card.id, [
      cardRow({ transactionDate: '2030-01-11', amountMinor: 200000 }),
      cardRow({ transactionDate: '2030-01-20', amountMinor: -200000, kind: 'refund', description: 'SAMPLE BULLION CO REFUND' }),
      cardRow({ transactionDate: '2030-01-21', amountMinor: -500, kind: 'refund', status: 'pending', description: 'SAMPLE BULLION CO PENDING' }),
      cardRow({ transactionDate: '2030-01-22', amountMinor: -700, kind: 'refund', status: 'pending', description: 'SAMPLE BULLION CO DISMISSED' }),
    ]);
    const stored = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
    const dismissed = stored.find((row) => row.amountMinor === -700)!;
    repo.updateCardTransaction(dismissed.id, { status: 'removed' }, { actorRef: cardSyncActorRef('test-owner') });
    const posted = stored.find((row) => row.amountMinor === -200000)!;

    expect(readMetalsCardCheckReads(db(), repo).credits).toEqual([{
      id: posted.id, accountId: card.id, date: '2030-01-20', amountMinor: -200000, kind: 'refund', currency: 'USD', merchant: null,
      description: 'SAMPLE BULLION CO REFUND',
    }]);
  });

  it('reads every imported account, with whether a later import retired it', () => {
    const retired = importWalmart(walmartBar('r1', '2030-01-10'), 0, { label: 'Walmart account' });
    const live = importWalmart(walmartBar('r2', '2030-02-10'), 1, { label: 'Walmart second' }, 'walmart-2');
    // A void of the first import, for the wrong account, retiring it: as only a v1 command would write it.
    db().prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-account', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-account', retire_account_id = ? WHERE import_id = ?`).run(LETTERS_32, NOW, LETTERS_64, retired.accountId,
      retired.importId);
    db().prepare('UPDATE metals_accounts SET retired_by_import = ? WHERE account_id = ?').run(retired.importId, retired.accountId);

    expect(readMetalsCardCheckReads(db(), repo).importedAccounts).toEqual([
      { accountId: retired.accountId, source: 'walmart', label: 'Walmart account', retired: true },
      { accountId: live.accountId, source: 'walmart', label: 'Walmart second', retired: false },
    ].sort((a, b) => (a.accountId < b.accountId ? -1 : 1)));
  });
});

describe('the read model: the card check\'s source in the graph\'s own snapshot', () => {
  it('reads it with the graph, once per data version, and lists every card account Holdr holds for the card history', () => {
    installMetalsSchema(db());
    importWalmart(walmartBar('m1', '2030-01-10'), 0, { label: 'Walmart account' });
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '0001', currency: 'USD' });
    const unsynced = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '0002', currency: 'USD', status: 'closed' });
    importRows(card.id, [cardRow({ transactionDate: '2030-01-20', amountMinor: -200000, kind: 'refund' })], { start: '2030-01-01', end: '2030-01-31' });
    const model = new MetalsReadModel(repo);
    const read = model.ledgerSnapshot();
    if ('failed' in read.check) throw new Error('the card check\'s reads failed');
    expect(read.check.reads.credits.map((row) => row.amountMinor)).toEqual([-200000]);
    expect(metalsCardHistory(read.graph, read.check.reads)).toEqual([
      { accountId: card.id, covered: [{ from: '2030-01-01', to: '2030-01-31' }] },
      { accountId: unsynced.id, covered: [] },
    ].sort((a, b) => (a.accountId < b.accountId ? -1 : 1)));
    // The same data version is the same snapshot; a card write is a new one.
    expect(model.ledgerSnapshot()).toBe(read);
    importRows(card.id, [cardRow({ transactionDate: '2030-01-25', amountMinor: -100, kind: 'refund' })]);
    const next = model.ledgerSnapshot();
    expect(next).not.toBe(read);
    expect(next.version).not.toBe(read.version);
  });

  it('serves the graph when only the card check\'s reads fail, and keeps only the failure\'s type and code', () => {
    installMetalsSchema(db());
    importWalmart(walmartBar('m1', '2030-01-10'), 0, { label: 'Walmart account' });
    vi.spyOn(repo, 'listCardCoverage').mockImplementation(() => {
      throw new Error('synthetic failure that names SAMPLE BULLION CO');
    });
    const model = new MetalsReadModel(repo);
    const read = model.ledgerSnapshot();
    expect(read.check).toEqual({ failed: 'HoldrDbError UNKNOWN' });
    expect([...read.graph.orders.keys()]).toEqual([walmartBar('m1', '2030-01-10').key]);
    expect(model.graph()).toBe(read.graph);
  });
});

describe('the snapshot token', () => {
  it('is 64 letters a-p, the same for the same inputs, and different when any one of them changes', () => {
    const base = { dataVersion: '3:7:12', aliasPolicy: 'metals-capture-alias-v1', day: '2030-03-20' };
    const token = metalsReadSnapshot(base);
    expect(token).toMatch(/^[a-p]{64}$/);
    expect(metalsReadSnapshot({ ...base })).toBe(token);
    for (const changed of [{ dataVersion: '3:7:13' }, { aliasPolicy: 'metals-capture-alias-v2' }, { day: '2030-03-21' }]) {
      expect(metalsReadSnapshot({ ...base, ...changed }), JSON.stringify(changed)).not.toBe(token);
    }
  });
});
