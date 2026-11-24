import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { metalsBindingDigest, metalsBindingEvidence, metalsBindingKeyOf, metalsRosterPreviewDigest, type MetalsBindingKey } from './bindingDigest.js';
import {
  metalsCardCapture,
  type MetalsCaptureCardRow,
  type MetalsCardCaptureInput,
  type MetalsCardCaptureResult,
  type MetalsCardCaptureRow,
} from './capture.js';

/** Synthetic capture results only: invented rows, accounts and groups. */
const captureRow = (overrides: Partial<MetalsCardCaptureRow> = {}): MetalsCardCaptureRow => ({
  rowId: 'row-1', accountId: 'card-a', date: '2030-03-15', amountMinor: 25_000, merchantClass: 'walmart-online', group: 'walmart',
  scope: 'mixed-online', source: 'walmart', status: 'outside-coverage', reasons: ['outside-coverage'], explainedBy: null, ...overrides,
});
const captured = (rows: MetalsCardCaptureRow[], credits: MetalsCardCaptureResult['credits'] = []): MetalsCardCaptureResult => ({
  rule: 'metals-card-capture-v1', aliasPolicy: 'metals-capture-alias-v1', rows, credits,
  outOfScope: { warehouse: 0, samsClub: 0, store: 0, unclassed: 0 }, unchecked: [],
});
const ACCOUNTS = [{ accountId: 'acct-w', source: 'walmart' as const, retired: false }, { accountId: 'acct-c', source: 'costco' as const, retired: false }];
const digestOf = (capture: MetalsCardCaptureResult, key: MetalsBindingKey = 'source:walmart', accounts = ACCOUNTS) =>
  metalsBindingDigest(metalsBindingEvidence(capture, key, accounts));

describe('binding evidence: the canonical form (§6.5)', () => {
  it('is one JSON array with no whitespace: domain, format, rule, alias policy, key, rows, accounts', () => {
    const evidence = metalsBindingEvidence(captured([captureRow()]), 'source:walmart', ACCOUNTS);
    assert.equal(evidence.rows, 1);
    assert.equal(evidence.canonical, '["holdr.metals-binding-evidence",1,"metals-card-capture-v1","metals-capture-alias-v1","source:walmart",'
      + '[["row-1","card-a","2030-03-15",25000,"USD","purchase","walmart-online","walmart","mixed-online","unexplained",[]]],[["acct-w",false]]]');
    const group = metalsBindingEvidence(captured([captureRow({ group: 'unresolved:pm-technologies', merchantClass: null, scope: 'gold-only', source: null,
      status: 'held', reasons: ['alias-unresolved'] })]), 'group:unresolved:pm-technologies', ACCOUNTS);
    assert.equal(group.canonical, '["holdr.metals-binding-evidence",1,"metals-card-capture-v1","metals-capture-alias-v1","group:unresolved:pm-technologies",'
      + '[["row-1","card-a","2030-03-15",25000,"USD","purchase","gold-only","unresolved:pm-technologies","gold-only","held",["alias-unresolved"]]],[]]');
  });

  it('digests as lh1: letter hex of the SHA-256 of the preimage', () => {
    assert.match(digestOf(captured([captureRow()])), /^lh1:[a-p]{64}$/);
    assert.equal(metalsBindingDigest({ canonical: 'x' }), metalsBindingDigest({ canonical: 'x' }));
    assert.notEqual(metalsBindingDigest({ canonical: 'x' }), metalsBindingDigest({ canonical: 'y' }));
  });
});

describe('binding evidence: what it binds (control 13\'s digest part, control 32)', () => {
  const base = [captureRow(), captureRow({ rowId: 'row-2', date: '2030-03-20', status: 'held', reasons: ['contested'] })];

  it('is independent of row and account order', () => {
    assert.equal(digestOf(captured([...base].reverse())), digestOf(captured(base)));
    assert.equal(digestOf(captured(base), 'source:walmart', [...ACCOUNTS].reverse()), digestOf(captured(base)));
  });

  it('any change to identity, date, amount, account, status, reason, class or retirement changes it', () => {
    const changes: Array<[string, Partial<MetalsCardCaptureRow>]> = [
      ['identity', { rowId: 'row-9' }], ['date', { date: '2030-03-16' }], ['amount', { amountMinor: 25_001 }], ['account', { accountId: 'card-b' }],
      ['status', { status: 'possible-aggregate', reasons: ['aggregate'] }], ['reason', { status: 'held', reasons: ['ambiguous'] }],
      ['class', { merchantClass: null }],
    ];
    const original = digestOf(captured(base));
    for (const [label, overrides] of changes) {
      assert.notEqual(digestOf(captured([captureRow(overrides), base[1]])), original, label);
    }
    const retired = ACCOUNTS.map((account) => (account.accountId === 'acct-w' ? { ...account, retired: true } : account));
    assert.notEqual(digestOf(captured(base), 'source:walmart', retired), original, 'retirement');
    assert.notEqual(digestOf(captured(base), 'source:walmart', [...ACCOUNTS, { accountId: 'acct-w2', source: 'walmart', retired: false }]), original,
      'an account imported');
    assert.equal(digestOf(captured(base), 'source:walmart', [...ACCOUNTS, { accountId: 'acct-c2', source: 'costco', retired: false }]), original,
      'another source\'s account');
  });

  it('a group change changes it: two alias groups of one source', () => {
    const alias = (group: string) => captureRow({ group, merchantClass: null, scope: 'gold-only', source: 'collectpure', status: 'held',
      reasons: ['contested'] });
    assert.notEqual(digestOf(captured([alias('alias:sample-a')]), 'source:collectpure'), digestOf(captured([alias('alias:sample-b')]), 'source:collectpure'));
  });

  it('equal counts with a different row give a different digest', () => {
    const replaced = [captureRow({ rowId: 'row-3', date: '2030-03-25' }), base[1]];
    assert.equal(metalsBindingEvidence(captured(replaced), 'source:walmart', ACCOUNTS).rows, 2);
    assert.notEqual(digestOf(captured(replaced)), digestOf(captured(base)));
  });

  it('explained rows, credits and other groups never count', () => {
    const original = digestOf(captured(base));
    const explained = captureRow({ rowId: 'row-x', status: 'explained', reasons: [], explainedBy: 'walmart-1#0' });
    assert.equal(digestOf(captured([...base, explained])), original);
    assert.equal(metalsBindingEvidence(captured([...base, explained]), 'source:walmart', ACCOUNTS).rows, 2);
    const credit = { rowId: 'credit-1', accountId: 'card-a', date: '2030-03-22', amountMinor: -25_000, group: 'walmart', scope: 'mixed-online' as const };
    assert.equal(digestOf(captured(base, [credit])), original);
    const costco = captureRow({ rowId: 'row-c', group: 'costco', source: 'costco', merchantClass: 'costco-online' });
    const dealer = captureRow({ rowId: 'row-d', group: 'dealer:APMEX', source: null, merchantClass: 'bullion-dealer', scope: 'gold-only' });
    assert.equal(digestOf(captured([...base, costco, dealer])), original);
  });

  it('the same rows under two keys never share a digest', () => {
    const alias = captureRow({ group: 'alias:sample-a', merchantClass: null, scope: 'gold-only', source: 'collectpure', status: 'held', reasons: ['contested'] });
    assert.notEqual(digestOf(captured([alias]), 'source:collectpure', []), digestOf(captured([alias]), 'group:alias:sample-a', []));
    assert.notEqual(digestOf(captured([]), 'source:walmart', []), digestOf(captured([]), 'source:costco', []));
    assert.notEqual(digestOf(captured([]), 'group:dealer:APMEX', []), digestOf(captured([]), 'group:merchant:SAMPLE BULLION', []));
  });

  it('the coverage label is left out: a row moving between outside-coverage and no-capture-match keeps the digest', () => {
    const outside = captured([captureRow()]);
    const inside = captured([captureRow({ status: 'no-capture-match', reasons: ['no-capture-match'] })]);
    assert.equal(digestOf(inside), digestOf(outside));
  });

  it('evidence that changes and then returns reads the same again (ABA)', () => {
    const original = digestOf(captured(base));
    const changed = digestOf(captured([...base, captureRow({ rowId: 'row-new', date: '2030-04-01' })]));
    assert.notEqual(changed, original);
    assert.equal(digestOf(captured(base)), original);
  });
});

describe('the binding a row belongs to (metalsBindingKeyOf)', () => {
  it('names exactly the binding whose evidence holds each row: a mixed or alias row its source\'s, any other its group\'s', () => {
    const rows = [
      captureRow({ rowId: 'w-1' }),
      captureRow({ rowId: 'c-1', group: 'costco', source: 'costco', merchantClass: 'costco-online' }),
      captureRow({ rowId: 'a-1', group: 'alias:sample-a', merchantClass: null, scope: 'gold-only', source: 'collectpure' }),
      captureRow({ rowId: 'd-1', group: 'dealer:APMEX', merchantClass: 'bullion-dealer', scope: 'gold-only', source: null }),
      captureRow({ rowId: 'm-1', group: 'merchant:SAMPLE BULLION', merchantClass: 'bullion-dealer', scope: 'gold-only', source: null }),
      captureRow({ rowId: 'p-1', group: 'unresolved:pm-technologies', merchantClass: null, scope: 'gold-only', source: null, status: 'held', reasons: ['alias-unresolved'] }),
      captureRow({ rowId: 'x-1', status: 'explained', reasons: [], explainedBy: 'walmart-1#0' }),
    ];
    assert.deepEqual(rows.map((entry) => metalsBindingKeyOf(entry)), [
      'source:walmart', 'source:costco', 'source:collectpure', 'group:dealer:APMEX', 'group:merchant:SAMPLE BULLION',
      'group:unresolved:pm-technologies', 'source:walmart',
    ]);
    // Each key binds exactly the rows not explained that name it.
    const capture = captured(rows);
    for (const key of new Set(rows.map((entry) => metalsBindingKeyOf(entry)))) {
      assert.ok(key !== null);
      const naming = rows.filter((entry) => entry.status !== 'explained' && metalsBindingKeyOf(entry) === key).length;
      assert.equal(metalsBindingEvidence(capture, key, ACCOUNTS).rows, naming, key);
    }
    assert.equal(metalsBindingKeyOf(captureRow({ group: 'alias:sample-a', scope: 'gold-only', source: null })), null);
  });
});

describe('binding evidence over a real capture (control 32)', () => {
  const row = (id: string, date: string, description: string, amountMinor = 25_000): MetalsCaptureCardRow => ({
    id, accountId: 'card-a', date, amountMinor, kind: 'purchase', currency: 'USD', usable: true, merchant: null, description,
  });
  const input = (rows: MetalsCaptureCardRow[], overrides: Partial<MetalsCardCaptureInput> = {}): MetalsCardCaptureInput => ({
    orders: [], holds: [], rows, accounts: [{ id: 'card-a', issuer: 'chase', last4: '0001', status: 'active' }], bindings: [],
    importedAccounts: [{ accountId: 'acct-c', source: 'costco' }], coverage: [], ...overrides,
  });
  const accounts = [{ accountId: 'acct-c', source: 'costco' as const, retired: false }];
  const costcoDigest = (rows: MetalsCaptureCardRow[], overrides: Partial<MetalsCardCaptureInput> = {}) =>
    metalsBindingDigest(metalsBindingEvidence(metalsCardCapture(input(rows, overrides)), 'source:costco', accounts));
  const online = row('row-online', '2030-03-15', 'COSTCO.COM');

  it('Costco warehouse and store rows never enter source:costco', () => {
    const warehouse = row('row-warehouse', '2030-03-16', 'COSTCO WHOLESALE');
    // Costco's online class from the merchant name, a store channel from the descriptor alone.
    const store = { ...row('row-store', '2030-03-17', 'SAMPLE SHOP SAMPLETOWN WA'), merchant: 'COSTCO.COM' };
    const capture = metalsCardCapture(input([online, warehouse, store]));
    assert.deepEqual(capture.rows.map((entry) => entry.rowId), ['row-online']);
    assert.deepEqual(capture.outOfScope, { warehouse: 1, samsClub: 0, store: 1, unclassed: 0 });
    assert.equal(costcoDigest([online, warehouse, store]), costcoDigest([online]));
  });

  it('a coverage extension past an unexplained row flips its label but doesn\'t stale the digest', () => {
    const coverage = [{
      accountId: 'acct-c', source: 'costco' as const, kind: 'online' as const, from: '2030-01-01', to: '2030-12-31', complete: true, captureSchema: null,
      converterVersion: 'holdr-metals-convert 1.0.0',
    }];
    const before = metalsCardCapture(input([online]));
    const after = metalsCardCapture(input([online], { coverage }));
    assert.deepEqual([before.rows[0].status, after.rows[0].status], ['outside-coverage', 'no-capture-match']);
    assert.equal(costcoDigest([online], { coverage }), costcoDigest([online]));
  });
});

describe('the roster preview digest (§7.4)', () => {
  const bindings = [
    { key: 'source:walmart' as const, rows: 2, digest: digestOf(captured([captureRow()])) },
    { key: 'group:dealer:APMEX' as const, rows: 1, digest: digestOf(captured([]), 'group:dealer:APMEX', []) },
  ];
  const importedAccounts = [
    { source: 'walmart' as const, accountId: 'acct-w', retired: false }, { source: 'costco' as const, accountId: 'acct-c', retired: false },
  ];
  const preview = metalsRosterPreviewDigest({ bindings, importedAccounts });

  it('is lh1: letter hex, independent of order', () => {
    assert.match(preview, /^lh1:[a-p]{64}$/);
    assert.equal(metalsRosterPreviewDigest({ bindings: [...bindings].reverse(), importedAccounts: [...importedAccounts].reverse() }), preview);
  });

  it('changes with any field', () => {
    const changed = [
      { bindings: [{ ...bindings[0], rows: 3 }, bindings[1]], importedAccounts },
      { bindings: [{ ...bindings[0], digest: digestOf(captured([])) }, bindings[1]], importedAccounts },
      { bindings: [{ ...bindings[0], key: 'source:costco' as const }, bindings[1]], importedAccounts },
      { bindings: [bindings[0]], importedAccounts },
      { bindings, importedAccounts: [{ ...importedAccounts[0], retired: true }, importedAccounts[1]] },
      { bindings, importedAccounts: [{ ...importedAccounts[0], accountId: 'acct-w2' }, importedAccounts[1]] },
      { bindings, importedAccounts: [{ ...importedAccounts[0], source: 'collectpure' as const }, importedAccounts[1]] },
      { bindings, importedAccounts: [importedAccounts[0]] },
    ];
    for (const [index, input] of changed.entries()) assert.notEqual(metalsRosterPreviewDigest(input), preview, `change ${index}`);
  });

  it('is hashed as a binding digest is, under its own domain', () => {
    const empty = metalsRosterPreviewDigest({ bindings: [], importedAccounts: [] });
    assert.equal(empty, metalsBindingDigest({ canonical: '["holdr.metals-roster-preview",1,[],[]]' }));
    assert.notEqual(empty, metalsBindingDigest({ canonical: '["holdr.metals-binding-evidence",1,[],[]]' }));
    assert.equal(metalsRosterPreviewDigest({ bindings: [bindings[1]], importedAccounts: [importedAccounts[1]] }),
      metalsBindingDigest({ canonical: JSON.stringify(['holdr.metals-roster-preview', 1, [[bindings[1].key, 1, bindings[1].digest]], [['costco', 'acct-c', false]]]) }));
  });
});
