/**
 * Fake Wells Fargo, rendered DOM only (test build only). No network at all:
 * the adapter reads the rows the page has rendered in a verified credit-card
 * activity grid (role, product type and exact column headers), accumulates
 * them by `aria-rowindex` while a virtual list mounts and unmounts rows, and
 * emits cumulative snapshots. Unrendered rows or a visible "Load more" mean
 * `more-available`; a deposit-style table is ignored. Rows carry no issuer
 * id, so they are capture fingerprints; their kind is not given by the page
 * and stays `other`.
 */
import { parseDecimalToMinor, cardAmountFromDirection, type ProjectedTransaction } from '@finance-tracker/shared';
import type { DomIo, IsolatedAdapter } from '../../../isolated/types.js';
import { assembleBatch, coverageEntry, dayFromUsDate, last4FromMask, productHint, projectRow } from '../../../projection/project.js';
import { FAKE_WELLS_FARGO } from '../descriptors.js';

const GRID = '#activity[role="grid"][data-product-type="credit"]';
const HEADERS = ['Date', 'Description', 'Debit', 'Credit'];
const MAX_EMISSIONS = 200;
const MAX_ROWS = 2_000;

function verifiedGrid(doc: Document): HTMLElement | null {
  const grid = doc.querySelector<HTMLElement>(GRID);
  if (!grid) return null;
  const headers = [...grid.querySelectorAll('[role="columnheader"]')].map((cell) => (cell.textContent ?? '').trim());
  return headers.length === HEADERS.length && headers.every((text, index) => text === HEADERS[index]) ? grid : null;
}

function watch(io: DomIo): void {
  const doc = document;
  const accepted = new Map<number, ProjectedTransaction>();
  const rejected = new Set<number>();
  let emissions = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let discovered = false;

  const scan = (): void => {
    if (io.signal.aborted || emissions >= MAX_EMISSIONS) return;
    const grid = verifiedGrid(doc);
    if (!grid) return;
    const key = grid.getAttribute('data-account-key');
    if (!key || key.length > 64) return;
    const accountRef = io.stream.candidateRef(key);
    const last4 = last4FromMask(grid.getAttribute('data-account-mask'));
    io.stream.noteHints([last4]);
    const hints = io.stream.hints();
    const candidate = { ref: accountRef, last4, productHint: productHint(grid.getAttribute('data-product'), hints) };
    if (!discovered) {
      discovered = true;
      io.emit(assembleBatch({ contract: 'wf.rendered-accounts', streamHandle: io.stream.streamHandle, sequence: io.stream.nextSequence(), observedAt: io.stream.observedAt(), accounts: [candidate], transactions: [], coverage: [], rejectedCount: 0 }));
    }
    for (const group of grid.querySelectorAll<HTMLElement>('[role="rowgroup"][data-section]')) {
      const section = group.getAttribute('data-section');
      if (section !== 'pending' && section !== 'posted') continue;
      for (const row of group.querySelectorAll<HTMLElement>('[role="row"][aria-rowindex]')) {
        const index = Number(row.getAttribute('aria-rowindex'));
        if (!Number.isSafeInteger(index) || index < 1 || index > MAX_ROWS || accepted.has(index) || rejected.has(index)) continue;
        const cell = (name: string) => (row.querySelector(`[role="gridcell"][data-col="${name}"]`)?.textContent ?? '').trim();
        const date = dayFromUsDate(cell('date'));
        const debit = cell('debit');
        const credit = cell('credit');
        // Exactly one amount column, or the row is not readable.
        const direction = debit !== '' && credit === '' ? 'debit' : credit !== '' && debit === '' ? 'credit' : null;
        const magnitude = direction ? parseDecimalToMinor(direction === 'debit' ? debit : credit, 2, { grouping: 'comma' }) : null;
        const signed = magnitude?.ok && direction ? cardAmountFromDirection(magnitude.minor, direction) : null;
        if (!date || !signed?.ok) {
          rejected.add(index);
          continue;
        }
        const projected = projectRow(
          {
            accountRef,
            holderRef: null,
            cardLast4: null,
            transactionDate: date,
            postedDate: null,
            status: section,
            amountMinor: signed.minor,
            kind: 'other',
            description: cell('description') || null,
            merchant: null,
            issuerCategory: null,
            primaryId: null,
            secondaryIds: [],
            original: null,
          },
          'wf.rendered-activity',
          hints,
        );
        if (projected.ok) accepted.set(index, projected.row);
        else rejected.add(index);
      }
    }
    const declared = Number(grid.getAttribute('aria-rowcount'));
    const loadMoreVisible = doc.querySelector('#load-more:not([hidden])') !== null;
    const seen = accepted.size + rejected.size;
    const termination = loadMoreVisible || !Number.isSafeInteger(declared) || seen < declared ? 'more-available' : 'snapshot';
    const rows = [...accepted.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
    const coverage = (['posted', 'pending'] as const).map((status) =>
      coverageEntry(rows, { accountRef, status, requested: null, pageCount: 1, termination, rejectedCount: rejected.size }),
    );
    emissions += 1;
    io.emit(assembleBatch({ contract: 'wf.rendered-activity', streamHandle: io.stream.streamHandle, sequence: io.stream.nextSequence(), observedAt: io.stream.observedAt(), accounts: [candidate], transactions: rows, coverage, rejectedCount: rejected.size }));
  };

  const schedule = (): void => {
    if (timer !== null || io.signal.aborted) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 200);
  };

  scan();
  const grid = verifiedGrid(doc);
  if (grid) {
    observer = new MutationObserver(schedule);
    observer.observe(grid, { childList: true, subtree: true });
  }
  const more = doc.querySelector('#load-more');
  const moreObserver = more ? new MutationObserver(schedule) : null;
  if (more && moreObserver) moreObserver.observe(more, { attributes: true, attributeFilter: ['hidden'] });
  io.signal.addEventListener('abort', () => {
    observer?.disconnect();
    moreObserver?.disconnect();
    if (timer !== null) clearTimeout(timer);
  }, { once: true });
}

export const FAKE_WF_ISOLATED: IsolatedAdapter = {
  identity: {
    id: FAKE_WELLS_FARGO.id,
    label: FAKE_WELLS_FARGO.label,
    issuer: FAKE_WELLS_FARGO.issuer,
    source: FAKE_WELLS_FARGO.source,
    mode: FAKE_WELLS_FARGO.mode,
    parserVersion: FAKE_WELLS_FARGO.parserVersion,
    pageOrigin: FAKE_WELLS_FARGO.pageOrigin,
    pagePaths: FAKE_WELLS_FARGO.pagePaths,
    discoveryContract: FAKE_WELLS_FARGO.discoveryContract,
    transactionsContract: FAKE_WELLS_FARGO.transactionsContract,
    usesMainObserver: false,
  },
  pageState(doc) {
    if (doc.querySelector('form#login')) return 'auth-required';
    return verifiedGrid(doc) ? 'activity' : 'other';
  },
  watch,
};
