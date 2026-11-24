/**
 * Deterministic synthetic card ledgers for identity tests: made-up merchants, amounts, dates and card ids in the
 * shapes issuers use. Never real data. Each seed gives the same rows on every run: purchases at everyday merchants,
 * fixed and varying recurring bills, warehouse-club charges and large one-offs (some filed by the owner as precious
 * metals), refunds in full and in part, fees with their reversals, interest, card payments, `other` rows, pending
 * rows, rows with no category, and a second currency.
 */
import type { CardInsightRow } from '../cardInsights.js';
import type { CardOwner } from '../types.js';

/** A row as the synthetic ledgers make them. */
export type SyntheticCardRow = CardInsightRow & { id: string };

export interface SyntheticLedger {
  rows: SyntheticCardRow[];
  cards: Array<{ id: string; owner: CardOwner; currency: string }>;
  owners: Map<string, CardOwner>;
  /** First and last YYYY-MM of the ledger. */
  firstMonth: string;
  lastMonth: string;
}

/** mulberry32: small, fast and deterministic. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addMonths(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function daysIn(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const EVERYDAY = [
  { description: 'SAMPLE GROCER #0012 SAMPLETOWN', category: 'Merchandise & Supplies-Groceries', low: 1_500, high: 16_000, perMonth: 6 },
  { description: 'SAMPLE BISTRO SAMPLETOWN', category: 'Restaurant-Restaurant', low: 1_800, high: 9_500, perMonth: 4 },
  { description: 'FOURTH COFFEE #114 SAMPLETOWN', category: 'Restaurant-Bar & Café', low: 400, high: 1_600, perMonth: 5 },
  { description: 'SAMPLE FUEL STATION 0042', category: null, low: 2_500, high: 7_000, perMonth: 2 },
  { description: 'SAMPLE HOME GOODS', category: 'Merchandise & Supplies-Furnishing', low: 2_000, high: 30_000, perMonth: 1 },
  { description: 'SAMPLE WAREHOUSE CLUB #0042', category: 'Merchandise & Supplies-Wholesale Stores', low: 8_000, high: 45_000, perMonth: 2 },
  { description: 'SAMPLE MARKETPLACE*AB12CD', category: 'Merchandise & Supplies-Internet Purchase', low: 900, high: 12_000, perMonth: 3 },
] as const;

const RECURRING = [
  { description: 'SAMPLE STREAMING', category: 'Entertainment-Other Entertainment', amount: 1_599, day: 5, varying: false },
  { description: 'SAMPLE GYM CLUB', category: 'Other-Miscellaneous', amount: 4_500, day: 1, varying: false },
  { description: 'SAMPLE PHONE CO', category: 'Communications-Mobile Telecom', amount: 6_400, day: 12, varying: true },
] as const;

const LARGE = [
  { description: 'SAMPLEWAREHOUSE.COM *ONLINE', category: 'Merchandise & Supplies-Wholesale Stores', low: 250_000, high: 900_000 },
  { description: 'SAMPLE ELECTRONICS STORE', category: 'Merchandise & Supplies-Electronics Stores', low: 120_000, high: 400_000 },
  { description: 'SAMPLE AIRLINE TICKETS', category: 'Travel-Airline', low: 80_000, high: 250_000 },
] as const;

/**
 * A ledger of `months` months starting at `start` (YYYY-MM) over two to four USD cards (and one in EUR when
 * `foreign`), each month with everyday purchases, recurring bills, sometimes a large one-off, refunds, fees, interest
 * and payments. Cards after the first join the record over the first months, as cards do when their history is
 * imported later.
 */
export function syntheticSpendingLedger(options: { seed: number; months?: number; start?: string; foreign?: boolean }): SyntheticLedger {
  const next = seededRandom(options.seed);
  const pick = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const months = options.months ?? 18;
  const start = options.start ?? '2025-04';
  const owners: CardOwner[] = ['alex', 'casey', 'joint'];
  const cardCount = 2 + Math.floor(next() * 3);
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    id: `card-syn-${options.seed}-${index}`,
    owner: owners[index % owners.length],
    currency: 'USD',
  }));
  if (options.foreign) cards.push({ id: `card-syn-${options.seed}-eur`, owner: 'joint', currency: 'EUR' });
  const rows: SyntheticCardRow[] = [];
  let sequence = 0;
  const add = (row: Omit<SyntheticCardRow, 'id' | 'currency'> & { currency?: string }) => {
    sequence += 1;
    const created: SyntheticCardRow = { id: `syn-${options.seed}-${String(sequence).padStart(5, '0')}`, currency: 'USD', ...row };
    rows.push(created);
    return created;
  };
  const usd = cards.filter((card) => card.currency === 'USD');
  const joins = new Map(usd.map((card, index) => [card.id, index === 0 ? 0 : Math.floor(next() * Math.min(6, months))]));
  const lastMonth = addMonths(start, months - 1);

  for (let offset = 0; offset < months; offset += 1) {
    const month = addMonths(start, offset);
    const length = daysIn(month);
    const dateOn = (day: number) => `${month}-${String(Math.min(length, Math.max(1, day))).padStart(2, '0')}`;
    const live = usd.filter((card) => offset >= (joins.get(card.id) ?? 0));
    const liveCard = () => live[Math.floor(next() * live.length)].id;
    for (const merchant of EVERYDAY) {
      const count = Math.max(0, merchant.perMonth + pick(-1, 1));
      for (let index = 0; index < count; index += 1) {
        const purchase = add({
          cardAccountId: liveCard(), transactionDate: dateOn(pick(1, length)), status: 'posted', kind: 'purchase',
          amountMinor: pick(merchant.low, merchant.high), description: merchant.description, merchant: null,
          issuerCategory: merchant.category,
        });
        // Some purchases come back, in full or in part, on the same card, days later.
        if (next() < 0.06) {
          add({
            cardAccountId: purchase.cardAccountId, transactionDate: addDays(purchase.transactionDate, pick(2, 30)), status: 'posted',
            kind: 'refund', amountMinor: -(next() < 0.5 ? purchase.amountMinor : Math.max(1, Math.floor(purchase.amountMinor / pick(2, 4)))),
            description: merchant.description, merchant: null, issuerCategory: merchant.category,
          });
        }
      }
    }
    for (const bill of RECURRING) {
      add({
        cardAccountId: usd[0].id, transactionDate: dateOn(bill.day + pick(0, 1)), status: 'posted', kind: 'purchase',
        amountMinor: bill.varying ? bill.amount + pick(-700, 900) : bill.amount, description: bill.description, merchant: null,
        issuerCategory: bill.category,
      });
    }
    if (next() < 0.45) {
      const large = LARGE[Math.floor(next() * LARGE.length)];
      const purchase = add({
        cardAccountId: liveCard(), transactionDate: dateOn(pick(1, length)), status: 'posted', kind: 'purchase',
        amountMinor: pick(large.low, large.high), description: large.description, merchant: null, issuerCategory: large.category,
        // The owner's word: some warehouse-club online charges were precious metals.
        userCategory: large.description.startsWith('SAMPLEWAREHOUSE') && next() < 0.35 ? 'Precious metals' : null,
      });
      if (next() < 0.2) {
        add({
          cardAccountId: purchase.cardAccountId, transactionDate: addDays(purchase.transactionDate, pick(3, 60)), status: 'posted',
          kind: 'refund', amountMinor: -(next() < 0.5 ? purchase.amountMinor : Math.floor(purchase.amountMinor / 3)),
          description: large.description, merchant: null, issuerCategory: large.category,
        });
      }
    }
    if (next() < 0.25) {
      const card = liveCard();
      const fee = add({
        cardAccountId: card, transactionDate: dateOn(pick(1, length)), status: 'posted', kind: 'fee', amountMinor: pick(500, 4_000),
        description: 'LATE FEE', merchant: null, issuerCategory: 'Fees & Adjustments-Fees & Adjustments',
      });
      if (next() < 0.5) {
        add({
          cardAccountId: card, transactionDate: addDays(fee.transactionDate, pick(1, 20)), status: 'posted', kind: 'adjustment',
          amountMinor: -fee.amountMinor, description: 'LATE FEE REVERSAL', merchant: null, issuerCategory: 'Fees & Adjustments-Fees & Adjustments',
        });
      }
    }
    if (next() < 0.15) {
      add({
        cardAccountId: liveCard(), transactionDate: dateOn(28), status: 'posted', kind: 'interest', amountMinor: pick(100, 3_000),
        description: 'INTEREST CHARGE ON PURCHASES', merchant: null, issuerCategory: null,
      });
    }
    for (const card of live) {
      add({
        cardAccountId: card.id, transactionDate: dateOn(pick(20, 28)), status: 'posted', kind: 'payment', amountMinor: -pick(50_000, 400_000),
        description: 'AUTOPAY PAYMENT THANK YOU', merchant: null, issuerCategory: null,
      });
    }
    if (next() < 0.1) {
      add({
        cardAccountId: liveCard(), transactionDate: dateOn(pick(1, length)), status: 'posted', kind: 'other', amountMinor: pick(10_000, 50_000),
        description: 'CASH ADVANCE', merchant: null, issuerCategory: null,
      });
    }
    if (options.foreign) {
      add({
        cardAccountId: cards[cards.length - 1].id, transactionDate: dateOn(pick(1, length)), status: 'posted', kind: 'purchase',
        amountMinor: pick(500, 9_000), currency: 'EUR', description: 'SAMPLE BOULANGERIE', merchant: null, issuerCategory: 'Restaurant-Restaurant',
      });
    }
  }
  // A few pending rows at the end: never spending.
  for (let index = 0; index < 3; index += 1) {
    add({
      cardAccountId: usd[0].id, transactionDate: `${lastMonth}-${String(pick(1, 20)).padStart(2, '0')}`, status: 'pending', kind: 'purchase',
      amountMinor: pick(500, 9_000), description: 'SAMPLE BISTRO SAMPLETOWN', merchant: null, issuerCategory: 'Restaurant-Restaurant',
    });
  }
  return { rows, cards, owners: new Map(cards.map((card) => [card.id, card.owner])), firstMonth: start, lastMonth };
}
