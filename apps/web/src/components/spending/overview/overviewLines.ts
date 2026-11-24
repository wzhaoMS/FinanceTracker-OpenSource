/**
 * The drill-down's last level reads every page of the list, followed through `nextOffset`, before the line's rows are
 * picked (`cardSpendingLineRows`, shared), so a line and its transactions add up to the same amount; when the pages
 * stop at their cap, no total is given for the rows read. Pure, so it can be tested.
 */

/** A page of the transaction list. */
export interface ListPage<T> {
  transactions: T[];
  total: number;
  nextOffset: number | null;
}

/** Pages read at most for one line (200 rows each). */
export const MAX_LINE_PAGES = 50;

/** How a line's rows are said against the line: a total only when every row was read, else how many are shown. */
export function lineTieOut(
  read: { complete: boolean; count: number; sumMinor: number },
  lineAmountMinor: number,
): { label: string; note: string; totalMinor: number | null } {
  const charges = `${read.count.toLocaleString('en-US')} ${read.count === 1 ? 'charge' : 'charges'}`;
  if (!read.complete) return { label: `${charges} shown`, note: 'more rows than shown here, so no total is given', totalMinor: null };
  return { label: charges, note: read.sumMinor === lineAmountMinor ? 'adds up to the line' : 'does not add up to the line: read again', totalMinor: read.sumMinor };
}

/**
 * How the merchants read behind an "N other merchants" row are said against the row: how many merchants and charges,
 * and their total only when every row was read. They add up to the row only when all three are the row's, to the cent.
 */
export function othersTieOut(
  read: { complete: boolean; merchants: number; count: number; sumMinor: number },
  row: { merchants: number; count: number; amountMinor: number },
): { label: string; note: string; totalMinor: number | null } {
  const merchants = `${read.merchants.toLocaleString('en-US')} ${read.merchants === 1 ? 'merchant' : 'merchants'}`;
  if (!read.complete) return { label: `${merchants} shown`, note: 'more rows than shown here, so no total is given', totalMinor: null };
  const charges = `${read.count.toLocaleString('en-US')} ${read.count === 1 ? 'charge' : 'charges'}`;
  const adds = read.merchants === row.merchants && read.count === row.count && read.sumMinor === row.amountMinor;
  return { label: `${merchants} · ${charges}`, note: adds ? 'adds up to the line' : 'does not add up to the line: read again', totalMinor: read.sumMinor };
}

/** Every page from offset 0, following `nextOffset`, at most `maxPages`; `complete` when the last page said there is no more. */
export async function collectPages<T>(
  fetchPage: (offset: number) => Promise<ListPage<T>>,
  maxPages = MAX_LINE_PAGES,
): Promise<{ rows: T[]; total: number; complete: boolean }> {
  const rows: T[] = [];
  let offset: number | null = 0;
  let total = 0;
  for (let pages = 0; offset !== null && pages < maxPages; pages += 1) {
    const page: ListPage<T> = await fetchPage(offset);
    rows.push(...page.transactions);
    total = page.total;
    offset = page.nextOffset;
  }
  return { rows, total, complete: offset === null };
}
