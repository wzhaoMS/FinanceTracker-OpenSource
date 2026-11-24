import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMerchantKey, cardSpendingLineRows, cardSpendingOtherLines } from '@finance-tracker/shared';

import { collectPages, lineTieOut, othersTieOut, type ListPage } from './overviewLines';

// Synthetic rows only.

interface Row {
  id: string;
  status: string;
  role: string;
  currency: string;
  merchantKey: string;
  amountMinor: number;
  categoryPortionMinor?: number;
  split?: Array<{ category: string; amountMinor: number }>;
}

const row = (id: string, patch: Partial<Row> = {}): Row => ({
  id, status: 'posted', role: 'spending', currency: 'USD', merchantKey: cardMerchantKey('NORTHWIND GROCER'), amountMinor: 100, ...patch,
});

/** A list of `rows` served in pages of `size`, newest first, as the API pages them. */
function pager<T>(rows: readonly T[], size = 200) {
  const asked: number[] = [];
  const fetchPage = async (offset: number): Promise<ListPage<T>> => {
    asked.push(offset);
    const page = rows.slice(offset, offset + size);
    return { transactions: page, total: rows.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null };
  };
  return { fetchPage, asked };
}

const line = { key: 'NORTHWIND GROCER', itemized: false };

test('a line reads every page before it picks its rows, so it adds up to its parent', async () => {
  // 210 later EUR rows first in the list, then 205 USD rows of $1: the USD line is $205, not what the first page holds.
  const rows: Row[] = [
    ...Array.from({ length: 210 }, (_, index) => row(`eur-${index}`, { currency: 'EUR' })),
    ...Array.from({ length: 205 }, (_, index) => row(`usd-${index}`)),
  ];
  const { fetchPage, asked } = pager(rows);
  const pages = await collectPages(fetchPage);
  assert.deepEqual(asked, [0, 200, 400]);
  assert.deepEqual([pages.rows.length, pages.total, pages.complete], [415, 415, true]);
  const picked = cardSpendingLineRows(pages.rows, line, 'USD');
  assert.deepEqual([picked.rows.length, picked.sumMinor], [205, 20_500]);
});

test('a line keeps only posted spending in its currency at its merchant group, and split rows only on the items line', () => {
  const rows: Row[] = [
    row('a', { amountMinor: 5_000 }),
    row('b', { role: 'excluded', amountMinor: 400_000 }),
    row('c', { amountMinor: 9_000, categoryPortionMinor: 6_000, split: [{ category: 'Groceries', amountMinor: 6_000 }] }),
    row('d', { currency: 'EUR', amountMinor: 1_200 }),
    row('e', { amountMinor: -1_500 }),
    row('f', { status: 'pending', amountMinor: 700 }),
    // A store of the same group is on the line; another merchant is not.
    row('g', { merchantKey: cardMerchantKey('NORTHWIND GROCER PORTLAND'), amountMinor: 7_000 }),
    row('h', { merchantKey: cardMerchantKey('NORTHWIND GROCERY OUTLET'), amountMinor: 900 }),
  ];
  const whole = cardSpendingLineRows(rows, line, 'USD');
  assert.deepEqual(whole.rows.map((item) => item.id), ['a', 'e', 'g']);
  assert.equal(whole.sumMinor, 10_500);
  assert.deepEqual(cardSpendingLineRows(rows, { ...line, itemized: true }, 'USD'), { rows: [rows[2]], sumMinor: 6_000 });
});

test('a line stops at its page limit and says it is not complete', async () => {
  const rows: Row[] = Array.from({ length: 25 }, (_, index) => row(`r-${index}`));
  const { fetchPage, asked } = pager(rows, 10);
  const pages = await collectPages(fetchPage, 2);
  assert.deepEqual(asked, [0, 10]);
  assert.deepEqual([pages.rows.length, pages.total, pages.complete], [20, 25, false]);
  const empty = await collectPages(pager([]).fetchPage);
  assert.deepEqual([empty.rows.length, empty.complete], [0, true]);
});

test('a line read to its last row gives its total; one cut short at the cap gives none, only how many rows it shows', async () => {
  // 10,001 rows of $1 on one line ($10,001.00): the 50 pages of 200 read 10,000 of them and stop.
  const rows: Row[] = Array.from({ length: 10_001 }, (_, index) => row(`r-${index}`));
  const pages = await collectPages(pager(rows).fetchPage);
  assert.deepEqual([pages.rows.length, pages.total, pages.complete], [10_000, 10_001, false]);
  const picked = cardSpendingLineRows(pages.rows, line, 'USD');
  assert.deepEqual(lineTieOut({ complete: pages.complete, count: picked.rows.length, sumMinor: picked.sumMinor }, 1_000_100),
    { label: '10,000 charges shown', note: 'more rows than shown here, so no total is given', totalMinor: null });
  // One more page allowed: every row read, and the total is the line's.
  const all = await collectPages(pager(rows).fetchPage, 51);
  const whole = cardSpendingLineRows(all.rows, line, 'USD');
  assert.deepEqual(lineTieOut({ complete: all.complete, count: whole.rows.length, sumMinor: whole.sumMinor }, 1_000_100),
    { label: '10,001 charges', note: 'adds up to the line', totalMinor: 1_000_100 });
  assert.deepEqual(lineTieOut({ complete: true, count: 1, sumMinor: 5_000 }, 5_100), { label: '1 charge', note: 'does not add up to the line: read again', totalMinor: 5_000 });
});

test('"other merchants" read from every page names each merchant behind it, and adds up to its row only when all of it was read', async () => {
  // A category's rows: its one named line, then 205 charges at five other merchants, past the first page.
  const merchants = ['PROSEWARE BISTRO', 'LUCERNE OUTFITTERS', 'FOURTH COFFEE', 'TAILSPIN CINEMA', 'FABRIKAM BAKERY'];
  const rows = [
    { ...row('named', { amountMinor: 1_000 }), merchantName: 'NORTHWIND GROCER' },
    ...Array.from({ length: 205 }, (_, index) => {
      const at = index % merchants.length;
      return { ...row(`o-${index}`, { merchantKey: cardMerchantKey(merchants[at]), amountMinor: (at + 1) * 100 }), merchantName: merchants[at] };
    }),
  ];
  const pages = await collectPages(pager(rows).fetchPage);
  const rest = cardSpendingOtherLines(pages.rows, [line], 'USD');
  assert.deepEqual(rest.lines.map((item) => [item.name, item.count, item.amountMinor]), [
    ['FABRIKAM BAKERY', 41, 20_500], ['TAILSPIN CINEMA', 41, 16_400], ['FOURTH COFFEE', 41, 12_300],
    ['LUCERNE OUTFITTERS', 41, 8_200], ['PROSEWARE BISTRO', 41, 4_100],
  ]);
  const behind = { merchants: 5, count: 205, amountMinor: 61_500 };
  assert.deepEqual(othersTieOut({ complete: pages.complete, merchants: rest.lines.length, count: rest.count, sumMinor: rest.sumMinor }, behind),
    { label: '5 merchants · 205 charges', note: 'adds up to the line', totalMinor: 61_500 });
  // Any of the three not the row's: it does not add up, and says so.
  for (const read of [{ merchants: 4, count: 205, sumMinor: 61_500 }, { merchants: 5, count: 204, sumMinor: 61_500 }, { merchants: 5, count: 205, sumMinor: 61_499 }]) {
    assert.equal(othersTieOut({ complete: true, ...read }, behind).note, 'does not add up to the line: read again');
  }
  // Cut short at the cap: how many merchants are shown, and no total.
  const capped = await collectPages(pager(rows).fetchPage, 1);
  const shown = cardSpendingOtherLines(capped.rows, [line], 'USD');
  assert.equal(shown.count, 199);
  assert.deepEqual(othersTieOut({ complete: capped.complete, merchants: shown.lines.length, count: shown.count, sumMinor: shown.sumMinor }, behind),
    { label: '5 merchants shown', note: 'more rows than shown here, so no total is given', totalMinor: null });
  assert.deepEqual(othersTieOut({ complete: true, merchants: 1, count: 1, sumMinor: 0 }, { merchants: 1, count: 1, amountMinor: 0 }),
    { label: '1 merchant · 1 charge', note: 'adds up to the line', totalMinor: 0 });
});
