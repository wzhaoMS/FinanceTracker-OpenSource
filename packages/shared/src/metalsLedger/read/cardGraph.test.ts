import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import type { CardMetalsMerchantClass } from '../../cardSpendingExclusions.js';
import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import type {
  MetalsAdmissionFacts,
  MetalsCardEvidence,
  MetalsChannel,
  MetalsNetwork,
  MetalsSource,
  MetalsTender,
} from '../model.js';
import { metalsMerchantClass as engineMerchantClass } from './cardGraph.js';
import {
  METALS_CARD_LINK_RULE,
  METALS_CARD_LINK_STATES,
  metalsCardLinks,
  metalsMerchantClass,
  type MetalsCardAccount,
  type MetalsCardBinding,
  type MetalsCardLink,
  type MetalsCardLinkGraph,
  type MetalsCardRow,
  type MetalsFundedOrder,
  type MetalsHeldOrder,
} from './cardLinks.js';

// ---------------------------------------------------------------------------------------------------------------------
// The reference: metalsCardLinks as it was before the engine was extracted (main 453283c9), frozen here unchanged but for
// one switch: `drift: 'bound-too'` is G1d's C4 parity fix, where a drifted binding also contests its last bound account
// while it exists; `'suffix-only'` is the original.
// ---------------------------------------------------------------------------------------------------------------------

function referenceMerchantClass(source: MetalsSource, channel: MetalsChannel): CardMetalsMerchantClass | null {
  if (source === 'costco') return channel === 'warehouse' ? 'costco-warehouse' : 'costco-online';
  return source === 'walmart' ? 'walmart-online' : null;
}

interface Contester {
  subject: string | null;
  amountMinor: number;
  merchantClass: CardMetalsMerchantClass;
  from: string;
  to: string;
  inScope: (accountId: string) => boolean;
}

interface Barrier {
  merchantClass: CardMetalsMerchantClass;
  from: string | null;
  to: string | null;
  capMinor: number | null;
  held: boolean;
}

const candidateRow = (row: MetalsCardRow) => row.usable && row.kind === 'purchase' && row.currency === 'USD';

function referenceCardLinks(input: {
  orders: readonly MetalsFundedOrder[];
  held: readonly MetalsHeldOrder[];
  rows: readonly MetalsCardRow[];
  accounts: readonly MetalsCardAccount[];
  bindings: readonly MetalsCardBinding[];
}, drift: 'suffix-only' | 'bound-too'): MetalsCardLinkGraph {
  const seen = new Set<string>();
  for (const order of input.orders) {
    if (seen.has(order.orderKey)) throw new RangeError('metalsCardLinks: an order is listed twice');
    seen.add(order.orderKey);
  }
  const last4ByAccount = new Map(input.accounts.map((account) => [account.id, account.last4]));
  const bindingOf = (source: MetalsSource, network: MetalsNetwork, last4: string | null) =>
    last4 === null ? undefined : input.bindings.find((binding) => binding.source === source && binding.network === network && binding.last4 === last4);
  const scopeOf = (source: MetalsSource, network: MetalsNetwork, last4: string | null): ((accountId: string) => boolean) => {
    const binding = bindingOf(source, network, last4);
    if (binding?.state === 'active') return (accountId) => accountId === binding.accountId;
    const bound = drift === 'bound-too' && binding !== undefined && last4ByAccount.has(binding.accountId) ? binding.accountId : null;
    if (last4 !== null) return (accountId) => accountId === bound || last4ByAccount.get(accountId) === last4;
    return () => true;
  };

  interface Subject {
    id: string;
    order: MetalsFundedOrder;
    evidence: MetalsCardEvidence;
    merchantClass: CardMetalsMerchantClass;
    from: string;
    to: string;
  }
  const subjects: Subject[] = [];
  const contesters: Contester[] = [];
  const barriers: Barrier[] = [];
  for (const order of input.orders) {
    const merchantClass = referenceMerchantClass(order.source, order.channel);
    const admission = metalsAdmission(order.source, order.channel, order.admission);
    if (merchantClass === null || admission === null) continue;
    const { from, to } = metalsSettlementInterval(order.date, order.channel);
    if (admission.basis === 'aggregate') {
      barriers.push({ merchantClass, from, to, capMinor: admission.capMinor, held: false });
      continue;
    }
    for (const evidence of admission.evidence) {
      const method = order.admission.methods[evidence.tender];
      const id = `${order.orderKey}#${evidence.tender}`;
      if (order.metal) subjects.push({ id, order, evidence, merchantClass, from, to });
      contesters.push({
        subject: order.metal ? id : null, amountMinor: evidence.amountMinor, merchantClass, from, to,
        inScope: scopeOf(order.source, method.network, method.last4),
      });
    }
  }
  for (const held of input.held) {
    const merchantClass = referenceMerchantClass(held.source, held.channel);
    if (merchantClass === null) continue;
    const interval = held.date === null ? null : metalsSettlementInterval(held.date, held.channel);
    barriers.push({ merchantClass, from: interval?.from ?? null, to: interval?.to ?? null, capMinor: null, held: true });
  }

  const barrierOn = (row: MetalsCardRow): 'competitor-held' | 'competitor-unknown' | null => {
    let found: 'competitor-held' | 'competitor-unknown' | null = null;
    for (const barrier of barriers) {
      if (barrier.merchantClass !== row.merchantClass) continue;
      if (barrier.from !== null && (row.date < barrier.from || row.date > barrier.to!)) continue;
      if (barrier.capMinor !== null && row.amountMinor > barrier.capMinor) continue;
      if (barrier.held) return 'competitor-held';
      found = 'competitor-unknown';
    }
    return found;
  };
  const contested = (row: MetalsCardRow, subject: string) => contesters.some((contester) => contester.subject !== subject
    && contester.merchantClass === row.merchantClass && contester.amountMinor === row.amountMinor
    && row.date >= contester.from && row.date <= contester.to && contester.inScope(row.accountId));

  const links: MetalsCardLink[] = [];
  const proofByRow = new Map<string, string>();
  for (const subject of subjects) {
    const method = subject.order.admission.methods[subject.evidence.tender];
    const base = {
      subject: subject.id, orderKey: subject.order.orderKey, tender: subject.evidence.tender, evidenceClass: subject.evidence.class,
      rule: METALS_CARD_LINK_RULE, amountMinor: subject.evidence.amountMinor,
    };
    const binding = bindingOf(subject.order.source, method.network, method.last4);
    if (!binding || binding.state !== 'active') {
      links.push({ ...base, state: binding ? 'binding-drift' : 'binding-missing', rowId: null, candidates: [], proof: false });
      continue;
    }
    const candidates = input.rows.filter((row) => candidateRow(row) && row.accountId === binding.accountId
      && row.merchantClass === subject.merchantClass && row.amountMinor === subject.evidence.amountMinor
      && row.date >= subject.from && row.date <= subject.to);
    const ids = candidates.map((row) => row.id);
    if (candidates.length !== 1) {
      links.push({ ...base, state: candidates.length === 0 ? 'no-candidate' : 'ambiguous', rowId: null, candidates: ids, proof: false });
      continue;
    }
    const [row] = candidates;
    const barrier = barrierOn(row);
    if (barrier !== null || contested(row, subject.id)) {
      links.push({ ...base, state: barrier ?? 'ambiguous', rowId: null, candidates: ids, proof: false });
      continue;
    }
    if (!subject.order.active) {
      links.push({ ...base, state: 'ineligible', rowId: row.id, candidates: ids, proof: false });
      continue;
    }
    links.push({ ...base, state: 'linked', rowId: row.id, candidates: ids, proof: true });
    proofByRow.set(row.id, subject.id);
  }
  return { links, proofByRow };
}

// ---------------------------------------------------------------------------------------------------------------------
// The differential (G1d C1): the engine-backed metalsCardLinks gives the reference's exact output for every input.
// ---------------------------------------------------------------------------------------------------------------------

/** A seeded generator (mulberry32), as cardLinks.test.ts's: deterministic, every bit in play, so small bounds vary too. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

type Outcome = { ok: true; graph: MetalsCardLinkGraph } | { ok: false; name: string; message: string };
function outcome(run: () => MetalsCardLinkGraph): Outcome {
  try {
    return { ok: true, graph: run() };
  } catch (error) {
    return error instanceof Error ? { ok: false, name: error.name, message: error.message } : { ok: false, name: 'unknown', message: String(error) };
  }
}

/** Synthetic ledgers only: invented orders, rows, accounts and last 4s. */
const card = (last4: string | null, amountMinor: number | null, network: MetalsNetwork): MetalsTender =>
  ({ kind: 'card', network, last4, amountMinor });
const day = (offset: number) => new Date(Date.UTC(2030, 2, 1) + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * One generated ledger: orders of every funding kind, their charges and stray rows, held records, accounts with duplicate
 * or missing last 4s, and bindings active or suspended, some on an account that no longer shows their last 4 (C4).
 */
function generatedLedger(next: (bound: number) => number, round: number) {
  const pick = <T>(list: readonly T[]): T => list[next(list.length)];
  const amounts = [3000, 6000];
  const networks: MetalsNetwork[] = ['visa', 'visa', 'visa', 'mastercard', 'unknown'];
  const accountOf = (last4: string | null) => (last4 === '1111' ? 'acct-a' : last4 === '2222' ? 'acct-b' : pick(['acct-c', 'acct-d']));
  const orders: MetalsFundedOrder[] = [];
  const rows: MetalsCardRow[] = [];
  const addRow = (date: string, amountMinor: number, merchantClass: CardMetalsMerchantClass | null, accountId: string, noise: boolean) => {
    rows.push({
      id: `row-${round}-${rows.length}`, accountId, date, amountMinor,
      kind: noise ? pick<MetalsCardRow['kind']>(['purchase', 'purchase', 'purchase', 'credit', 'other']) : 'purchase',
      currency: noise && next(8) === 0 ? 'CAD' : 'USD', usable: !noise || next(8) !== 0, merchantClass,
    });
  };
  for (let index = 0; index < 1 + next(5); index += 1) {
    const source = pick<MetalsSource>(['walmart', 'walmart', 'walmart', 'costco', 'costco', 'collectpure']);
    const channel: MetalsChannel = source === 'costco' && next(3) === 0 ? 'warehouse' : 'online';
    const amount = pick(amounts);
    const last4 = pick(['1111', '1111', '2222', null]);
    const network = pick(networks);
    const offset = next(30);
    const fulfilment: MetalsAdmissionFacts['fulfilment'] = channel === 'warehouse' ? 'in-store' : { shipments: 1 };
    const single: MetalsAdmissionFacts = {
      fulfilment, methods: [card(last4, amount, network)], refunded: false, cancelled: false, partlyCancelled: false,
      grossTotalMinor: amount,
    };
    const funding = next(16);
    const admission: MetalsAdmissionFacts =
      funding === 0 ? { ...single, fulfilment: channel === 'warehouse' ? 'in-store' : { shipments: 2 } }
        : funding === 1 ? { ...single, methods: [card(last4, null, network)], grossTotalMinor: null }
          : funding === 2 ? { ...single, methods: [card(last4, amount, network), card(pick(['1111', '2222']), 3000, 'visa')], grossTotalMinor: amount + 3000 }
            : funding === 3 ? { ...single, refunded: true, grossTotalMinor: amount + 3000 }
              : funding === 4 ? { ...single, methods: [{ kind: 'cash', network: 'unknown', last4: null, amountMinor: amount }] }
                : funding === 5 ? {
                  ...single, methods: [card(last4, amount + 2000, network), { kind: 'gift-card', network: 'unknown', last4: null, amountMinor: -2000 }],
                }
                  : single;
    orders.push({
      orderKey: `order-${round}-${index}`, source, channel, date: day(offset), admission, metal: next(3) !== 0, active: next(3) !== 0,
    });
    // Its own charge, more often than not: on the card its last 4 names, of its class and amount, in its window or just past it.
    if (next(3) !== 0) {
      const after = channel === 'warehouse' ? next(7) : next(32);
      addRow(day(next(30) === 0 ? offset + 40 : offset + after), amount, metalsMerchantClass(source, channel), accountOf(last4), false);
    }
  }
  for (let index = 0; index < next(4); index += 1) {
    addRow(day(next(70)), pick([...amounts, 9000]), pick<CardMetalsMerchantClass | null>(['walmart-online', 'costco-online', 'costco-warehouse',
      'bullion-dealer', null]), pick(['acct-a', 'acct-b', 'acct-c', 'acct-d']), true);
  }
  // Now and then a refused ledger: an order listed twice, or a gross total below zero. Both must refuse alike.
  if (next(40) === 0) orders.push({ ...orders[0] });
  if (next(40) === 0) orders[0] = { ...orders[0], admission: { ...orders[0].admission, grossTotalMinor: -1 } };
  const held: MetalsHeldOrder[] = [];
  for (let index = 0; index < next(4); index += 1) {
    const source = pick<MetalsSource>(['walmart', 'walmart', 'costco', 'collectpure']);
    held.push({ source, channel: source === 'costco' && next(2) === 0 ? 'warehouse' : 'online', date: next(3) === 0 ? null : day(next(40)) });
  }
  const accounts: MetalsCardAccount[] = [
    { id: 'acct-a', last4: '1111' }, { id: 'acct-b', last4: '2222' }, { id: 'acct-c', last4: pick(['1111', '3333', null]) },
    { id: 'acct-d', last4: pick(['2222', null]) },
  ];
  const usual: MetalsCardBinding[] = [
    { source: 'walmart', network: 'visa', last4: '1111', accountId: 'acct-a', state: next(5) === 0 ? 'suspended' : 'active' },
    { source: 'costco', network: 'visa', last4: '1111', accountId: 'acct-a', state: next(3) === 0 ? 'suspended' : 'active' },
    { source: 'walmart', network: 'visa', last4: '2222', accountId: 'acct-b', state: next(4) === 0 ? 'suspended' : 'active' },
  ];
  const bindings = usual.slice(0, 1 + next(3));
  for (let index = 0; index < next(3); index += 1) {
    bindings.push({
      source: pick<MetalsSource>(['walmart', 'costco']), network: pick(networks), last4: pick(['1111', '2222', '3333']),
      accountId: pick(['acct-a', 'acct-b', 'acct-c', 'acct-d']), state: next(3) === 0 ? 'suspended' : 'active',
    });
  }
  return { orders, held, rows, accounts, bindings };
}
const proofsOf = (graph: MetalsCardLinkGraph) => new Set(graph.links.filter((link) => link.proof).map((link) => `${link.subject}>${link.rowId}`));

/**
 * C4, a reissued card: acct-a shows 4444 now, so every binding to it drifted and a walmart 4444 one is active. Half the
 * orders paying with 1111 pay with 4444, and a crafted pair puts an old-number order's possible charge on a new-number
 * order's candidate.
 */
function reissued(input: ReturnType<typeof generatedLedger>, drift: (bound: number) => number, round: number): ReturnType<typeof generatedLedger> {
  const amount = drift(2) === 0 ? 3000 : 6000;
  const offset = drift(20);
  const single = (last4: string): MetalsAdmissionFacts => ({
    fulfilment: { shipments: 1 }, methods: [card(last4, amount, 'visa')], refunded: false, cancelled: false, partlyCancelled: false,
    grossTotalMinor: amount,
  });
  const newNumber = (method: MetalsTender): MetalsTender => (method.last4 === '1111' ? { ...method, last4: '4444' } : method);
  return {
    ...input,
    accounts: input.accounts.map((account) => (account.id === 'acct-a' ? { ...account, last4: '4444' } : account)),
    bindings: [
      ...input.bindings.map((binding) => (binding.accountId === 'acct-a' ? { ...binding, state: 'suspended' as const } : binding)),
      { source: 'walmart', network: 'visa', last4: '4444', accountId: 'acct-a', state: 'active' },
    ],
    orders: [
      ...input.orders.map((order) => (drift(2) === 0 ? order : { ...order, admission: { ...order.admission, methods: order.admission.methods.map(newNumber) } })),
      { orderKey: `order-${round}-old-card`, source: 'walmart', channel: 'online', date: day(offset), admission: single('1111'), metal: true, active: true },
      { orderKey: `order-${round}-new-card`, source: 'walmart', channel: 'online', date: day(offset + drift(5)), admission: single('4444'), metal: true, active: true },
    ],
    rows: [...input.rows, {
      id: `row-${round}-new-card`, accountId: 'acct-a', date: day(offset + 5 + drift(5)), amountMinor: amount, kind: 'purchase', currency: 'USD',
      usable: true, merchantClass: 'walmart-online',
    }],
  };
}

describe('the card-link engine (C1): the differential against the frozen reference', () => {
  it('keeps the exports metalsCardLinks always had', () => {
    assert.equal(METALS_CARD_LINK_RULE, 'metals-card-link-v1');
    assert.deepEqual([...METALS_CARD_LINK_STATES], [
      'linked', 'ineligible', 'ambiguous', 'no-candidate', 'competitor-unknown', 'competitor-held', 'binding-missing', 'binding-drift',
    ]);
    assert.equal(metalsMerchantClass, engineMerchantClass);
    for (const source of ['costco', 'walmart', 'collectpure'] as const) {
      for (const channel of ['online', 'warehouse'] as const) {
        assert.equal(metalsMerchantClass(source, channel), referenceMerchantClass(source, channel));
      }
    }
  });

  it('gives the reference\'s links, states and proofs for every generated ledger, with C4 (seeded, 400 rounds)', () => {
    const next = seeded(20_301);
    const drift = seeded(20_302);
    const states = new Map<string, number>();
    let thrown = 0;
    for (let round = 0; round < 400; round += 1) {
      const generatedInput = generatedLedger(next, round);
      const input = drift(3) === 0 ? reissued(generatedInput, drift, round) : generatedInput;
      const expected = outcome(() => referenceCardLinks(input, 'bound-too'));
      const actual = outcome(() => metalsCardLinks(input));
      assert.deepStrictEqual(actual, expected, `round ${round}`);
      if (expected.ok) for (const link of expected.graph.links) states.set(link.state, (states.get(link.state) ?? 0) + 1);
      else thrown += 1;
    }
    // The generator reaches every state, and a refusal or two.
    for (const state of METALS_CARD_LINK_STATES) assert.ok((states.get(state) ?? 0) > 0, `the generated ledgers reach ${state}`);
    assert.ok(thrown > 0, 'the generated ledgers include a refused one');
  });

  it('C4 is the reference\'s one change: it reaches generated ledgers, and it only ever removes proofs (seeded, 400 rounds)', () => {
    const next = seeded(20_301);
    const drift = seeded(20_302);
    let changed = 0;
    for (let round = 0; round < 400; round += 1) {
      const generatedInput = generatedLedger(next, round);
      const input = drift(3) === 0 ? reissued(generatedInput, drift, round) : generatedInput;
      const before = outcome(() => referenceCardLinks(input, 'suffix-only'));
      const after = outcome(() => referenceCardLinks(input, 'bound-too'));
      if (!before.ok || !after.ok) {
        assert.deepStrictEqual(after, before, `round ${round}: a refusal is the same refusal`);
        continue;
      }
      const kept = proofsOf(before.graph);
      for (const proof of proofsOf(after.graph)) assert.ok(kept.has(proof), `round ${round}: C4 created ${proof}`);
      if (!isDeepStrictEqual(after, before)) changed += 1;
    }
    assert.ok(changed > 0, `a drifted binding's last bound account matters in some generated ledger (${changed})`);
  });

  it('refuses a ledger that lists one order twice with the reference\'s error', () => {
    const order: MetalsFundedOrder = {
      orderKey: 'order-twice', source: 'walmart', channel: 'online', date: '2030-03-10', metal: true, active: true,
      admission: {
        fulfilment: { shipments: 1 }, methods: [card('1111', 6000, 'visa')], refunded: false, cancelled: false, partlyCancelled: false,
        grossTotalMinor: 6000,
      },
    };
    const input = { orders: [order, order], held: [], rows: [], accounts: [], bindings: [] };
    assert.deepStrictEqual(outcome(() => metalsCardLinks(input)), outcome(() => referenceCardLinks(input, 'bound-too')));
    assert.throws(() => metalsCardLinks(input), { name: 'RangeError', message: 'metalsCardLinks: an order is listed twice' });
  });
});
