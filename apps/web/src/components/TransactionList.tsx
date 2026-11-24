import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { formatCurrency, formatOptionSymbol, type Account, type CostBasisCheck, type Transaction } from '@finance-tracker/shared';

import { api } from '../services/api';
import { usePortfolioStore } from '../stores/portfolio';
import { StaleOperationError } from '../stores/storeOp';
import { LineChart, MoreVertical, Trend } from './icons';
import { EmptyState } from './EmptyState';
import { CashEventList } from './CashEventList';
import { formatRoute } from '../modes/route';
import './investing-entry.css';

/** Go to another Investing section (the app follows the address). */
function goToInvesting(tab: 'accounts' | 'add' | 'import'): void {
  window.location.hash = formatRoute({ mode: 'investing', tab });
}

/** How rows are clustered. `none` = flat reverse-chronological list. */
type GroupBy = 'none' | 'account' | 'owner' | 'symbol' | 'month';

/** Buy/sell action filter chip. */
type ActionFilter = 'all' | 'buy' | 'sell';

/** Date-range presets. `all` = no filter. */
type DateRange = 'today' | '7d' | '30d' | '90d' | 'ytd' | 'all';

function transactionGrossValue(transaction: Transaction): number {
  return Math.abs(transaction.quantity)
    * transaction.pricePerUnit
    * (transaction.contractMultiplier ?? 1);
}

function transactionAction(transaction: Transaction): string {
  if (transaction.instrumentType !== 'option') return transaction.quantity > 0 ? 'Bought' : 'Sold';
  if (transaction.positionEffect === 'open') return transaction.quantity > 0 ? 'Bought to open' : 'Sold to open';
  return transaction.quantity > 0 ? 'Bought to close' : 'Sold to close';
}

/**
 * Where a trade came from, in words, read from its source fingerprint: a positions import stamps "pos:<symbol>",
 * a broker-activity import a hash of the broker's row. A trade added by hand (or by an older import) has none.
 */
function transactionSource(transaction: Transaction): string {
  const fingerprint = transaction.sourceFingerprint?.trim() ?? '';
  if (!fingerprint) return 'No import record';
  return fingerprint.startsWith('pos:') ? 'Positions import' : 'Broker activity import';
}

/* ------------------------------------------------------------------ */
/* Owner inference                                                    */
/* ------------------------------------------------------------------ */
/**
 * Owners are encoded in the account-name prefix ("Alex · ...", "Casey · ...").
 * The single source of truth for "who owns this account" is the part before
 * the first ` · ` separator. Falls back to "Other" so legacy accounts that
 * predate the convention don't disappear from the UI.
 */
function ownerOf(name: string | undefined): string {
  if (!name) return 'Other';
  const idx = name.indexOf(' · ');
  if (idx <= 0) return 'Other';
  return name.slice(0, idx);
}

/** All distinct owner labels in the current account list, sorted. */
function ownersFrom(accounts: Account[]): string[] {
  return Array.from(new Set(accounts.map((a) => ownerOf(a.name)))).sort();
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                       */
/* ------------------------------------------------------------------ */
/** Local ISO date (YYYY-MM-DD). Avoids UTC drift around local midnight. */
function isoLocalDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ISO date for "today minus N days", in YYYY-MM-DD. */
function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoLocalDate(d);
}

/** ISO date for Jan 1 of the current year. */
function isoYearStart(): string {
  return `${new Date().getFullYear()}-01-01`;
}

/** Returns the YYYY-MM bucket of a YYYY-MM-DD string. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Two-line date stamp for a transaction row. 'May 8' on top, year only
 * shown when the transaction is in a different year than today (avoids
 * the ambiguous 08/05/26 stack the reviewer flagged).
 */
function formatRowDate(date: string): { day: string; month: string; year?: string } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const d = dateOnly ? new Date(`${date}T12:00:00Z`) : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return { day: date.slice(8, 10), month: date.slice(5, 7) };
  }
  const day = String(d.getDate());
  const month = d.toLocaleDateString(undefined, { month: 'short' });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return { day, month, year: sameYear ? undefined : String(d.getFullYear()) };
}

/** "2026-05" → "May 2026". Locale-stable, avoids timezone drift. */
function formatMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number);
  if (!y || !m) return yyyymm;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

/**
 * Relative section label for a transaction date. Returns "Today",
 * "Yesterday", "Earlier this week", "Last week", or "MMM YYYY".
 * Keeps the flat (groupBy='none') list scannable — the eye lands on
 * the header, then reads down recent activity without re-parsing
 * dates row-by-row.
 */
function relativeSectionLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dLocal = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const msDay = 86_400_000;
  const diffDays = Math.round((today.getTime() - dLocal.getTime()) / msDay);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  // Current week (Mon as week start). diffDays<=6 AND same ISO week as today.
  const startOfWeek = new Date(today);
  const dow = (today.getDay() + 6) % 7; // Mon=0
  startOfWeek.setDate(today.getDate() - dow);
  if (dLocal >= startOfWeek) return 'Earlier this week';
  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfWeek.getDate() - 7);
  if (dLocal >= startOfLastWeek) return 'Last week';
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'long' });
  }
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * P2.14: realized P/L map (FIFO per account+symbol). Returns a map
 * keyed by sell-transaction id. Buys consume nothing; sells walk the
 * FIFO buy queue, summing cost-of-shares-sold. We skip sells where the
 * baseline doesn't have enough buy lots (would otherwise produce a
 * spurious "100% gain" on pre-history positions).
 */
function computeRealizedMap(transactions: Transaction[]): Map<string, number> {
  const result = new Map<string, number>();
  const sorted = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const queues = new Map<string, { qty: number; price: number }[]>();
  for (const t of sorted) {
    if (t.instrumentType === 'option') continue;
    const key = `${t.accountId}|${t.symbol}`;
    let queue = queues.get(key);
    if (!queue) { queue = []; queues.set(key, queue); }
    if (t.quantity > 0) {
      queue.push({ qty: t.quantity, price: t.pricePerUnit });
    } else if (t.quantity < 0) {
      let toSell = Math.abs(t.quantity);
      let cost = 0;
      while (toSell > 1e-9 && queue.length > 0) {
        const lot = queue[0];
        const take = Math.min(toSell, lot.qty);
        cost += take * lot.price;
        toSell -= take;
        lot.qty -= take;
        if (lot.qty <= 1e-9) queue.shift();
      }
      if (toSell <= 1e-9) {
        const proceeds = Math.abs(t.quantity) * t.pricePerUnit;
        result.set(t.id, proceeds - cost);
      }
    }
  }
  return result;
}

/** P2.11: turn rows into a CSV string (RFC 4180-ish; quotes everything). */
function toCsv(rows: Transaction[], accountById: Map<string, Account>): string {
  const header = ['date', 'symbol', 'action', 'quantity', 'price', 'value', 'currency', 'account', 'instrument_type', 'contract_multiplier', 'position_effect', 'notes', 'source_fingerprint'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const t of rows) {
    const acct = accountById.get(t.accountId);
    const action = transactionAction(t).toUpperCase().replaceAll(' ', '_');
    const qty = Math.abs(t.quantity);
    const value = transactionGrossValue(t).toFixed(2);
    lines.push([t.date, t.symbol, action, qty, t.pricePerUnit, value, t.currency, acct?.name ?? '', t.instrumentType ?? '', t.contractMultiplier ?? '', t.positionEffect ?? '', t.notes ?? '', t.sourceFingerprint ?? '']
      .map(esc).join(','));
  }
  return lines.join('\n');
}

function downloadCsv(name: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */
export function TransactionList() {
  const accounts = usePortfolioStore((s) => s.accounts);
  const transactions = usePortfolioStore((s) => s.transactions);
  const remove = usePortfolioStore((s) => s.removeTransaction);
  const beginOp = usePortfolioStore((s) => s.beginOp);
  const writesDisabled = usePortfolioStore((s) => s.apiStatus === 'cache');

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );
  const owners = useMemo(() => ownersFrom(accounts), [accounts]);

  /* ---------------- filter state ---------------- */
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all'); // 'all' | one of `owners`
  const [accountFilter, setAccountFilter] = useState<Set<string>>(new Set()); // empty = all
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [duplicateOnly, setDuplicateOnly] = useState(false);
  /* P2.10: bulk select. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  /* P2.14: realized P/L per sell (FIFO). Re-computed when txns change. */
  const realizedById = useMemo(() => computeRealizedMap(transactions), [transactions]);

  /* P3.19: heuristic duplicate detection. Groups by
   * (accountId|symbol|date|qty|price) — anything with >1 in a group is
   * flagged as a likely duplicate import. Conversion/vest events with
   * identical FMV intentionally repeat, so we exclude rows whose notes
   * contain "CONVERSION" / "vest". */
  const duplicateIds = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const t of transactions) {
      const note = (t.notes ?? '').toUpperCase();
      if (note.includes('CONVERSION') || note.includes('VEST')) continue;
      const key = `${t.accountId}|${t.symbol}|${t.date}|${t.quantity}|${t.pricePerUnit}`;
      const arr = groups.get(key) ?? [];
      arr.push(t.id);
      groups.set(key, arr);
    }
    const dups = new Set<string>();
    for (const arr of groups.values()) {
      if (arr.length > 1) for (const id of arr) dups.add(id);
    }
    return dups;
  }, [transactions]);

  /* ---------------- filter pipeline ---------------- */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dateFloor =
      dateRange === 'today' ? isoLocalDate()
      : dateRange === '7d' ? isoNDaysAgo(7)
      : dateRange === '30d' ? isoNDaysAgo(30)
      : dateRange === '90d' ? isoNDaysAgo(90)
      : dateRange === 'ytd' ? isoYearStart()
      : null;

    return transactions
      .filter((t) => {
        if (duplicateOnly && !duplicateIds.has(t.id)) return false;
        if (dateRange === 'today' && t.date !== dateFloor) return false;
        if (dateRange !== 'today' && dateFloor && t.date < dateFloor) return false;
        if (actionFilter === 'buy' && t.quantity <= 0) return false;
        if (actionFilter === 'sell' && t.quantity >= 0) return false;
        if (accountFilter.size > 0 && !accountFilter.has(t.accountId)) return false;
        if (ownerFilter !== 'all') {
          const acct = accountById.get(t.accountId);
          if (ownerOf(acct?.name) !== ownerFilter) return false;
        }
        if (q) {
          const acct = accountById.get(t.accountId);
          const hay = `${t.symbol} ${t.notes ?? ''} ${acct?.name ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }, [transactions, accountById, search, actionFilter, ownerFilter, accountFilter, dateRange, duplicateOnly, duplicateIds]);

  /* ---------------- group buckets ---------------- */
  const groups = useMemo(() => groupTransactions(filtered, groupBy, accountById), [filtered, groupBy, accountById]);

  /* ---------------- bought/sold totals for the summary line ---------------- */
  const totals = useMemo(() => {
    let bought = 0;
    let sold = 0;
    for (const t of filtered) {
      const value = transactionGrossValue(t);
      if (t.quantity > 0) bought += value;
      else if (t.quantity < 0) sold += value;
    }
    return { bought, sold };
  }, [filtered]);

  /* ---------------- P1.5: recent-trades KPI strip ---------------- */
  /* Computed off the *unfiltered* set so the strip is a stable "what
   * happened recently" anchor that doesn't disappear when the user
   * filters down to one symbol. */
  const recent = useMemo(() => {
    const today = isoLocalDate();
    const sevenAgo = isoNDaysAgo(7);
    let todayCount = 0, todayBought = 0, todaySold = 0;
    let weekBought = 0, weekSold = 0;
    for (const t of transactions) {
      const val = transactionGrossValue(t);
      if (t.date === today) {
        todayCount++;
        if (t.quantity > 0) todayBought += val; else todaySold += val;
      }
      if (t.date >= sevenAgo) {
        if (t.quantity > 0) weekBought += val; else weekSold += val;
      }
    }
    return { todayCount, todayBought, todaySold, weekBought, weekSold };
  }, [transactions]);

  const activeFilterCount =
    (search.trim() ? 1 : 0)
    + (actionFilter !== 'all' ? 1 : 0)
    + (ownerFilter !== 'all' ? 1 : 0)
    + (accountFilter.size > 0 ? 1 : 0)
    + (dateRange !== 'all' ? 1 : 0)
    + (duplicateOnly ? 1 : 0);

  const clearFilters = () => {
    setSearch('');
    setActionFilter('all');
    setOwnerFilter('all');
    setAccountFilter(new Set());
    setDateRange('all');
    setDuplicateOnly(false);
  };

  /* ---------------- P2.11: CSV export of the filtered view ---------------- */
  const exportCsv = () => {
    const csv = toCsv(filtered, accountById);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`holdr-transactions-${stamp}.csv`, csv);
  };

  /* ---------------- P2.10: bulk select + delete ---------------- */
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const selectAllFiltered = () => setSelectedIds(new Set(filtered.map((t) => t.id)));
  const bulkDelete = async () => {
    const n = selectedIds.size;
    if (n === 0) return;
    if (!window.confirm(`Remove ${n} transaction${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const ids = Array.from(selectedIds);
    // One operation for the whole batch: after a sign-out, no further delete is sent.
    const op = beginOp();
    // Sequential to keep API + repo consistent; small N so latency is fine.
    for (const id of ids) {
      try {
        await remove(id, op);
      } catch (err) {
        if (err instanceof StaleOperationError) return;
        /* swallow; loop continues */
      }
    }
    op.commit(() => setSelectedIds(new Set()));
  };

  /* ---------------- P2.12: filter presets ---------------- */
  const presets = useMemo(
    () => ([
      { key: 'today',  label: "Today's trades", apply: () => { clearFilters(); setDateRange('today'); setTimeout(() => searchRef.current?.blur(), 0); } },
      { key: 'buys7d', label: 'Buys (7D)',      apply: () => { clearFilters(); setDateRange('7d');  setActionFilter('buy'); } },
      { key: 'sells',  label: 'All sells',      apply: () => { clearFilters(); setActionFilter('sell'); } },
      { key: 'alex',    label: 'Alex only',       apply: () => { clearFilters(); setOwnerFilter('Alex'); } },
      { key: 'casey', label: 'Casey only',    apply: () => { clearFilters(); setOwnerFilter('Casey'); } },
    ]),
    [], // handlers reference setters which are stable
  );

  /* ---------------- P2.13: global keyboard shortcuts (/ and ?) ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable;
      if (e.key === '/' && !inEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearch('');
        searchRef.current?.blur();
      } else if (e.key === '?' && !inEditable) {
        e.preventDefault();
        window.alert('Keyboard shortcuts:\n / — focus search\n Esc — clear & blur search\n Enter/Space — expand focused row\n ? — show this help');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------- render ---------------- */
  if (transactions.length === 0) {
    return (
      <div className="tx-view">
        <CashEventList accounts={accounts} writesDisabled={writesDisabled} />
        {accounts.length === 0 ? (
          <EmptyState
            icon={<LineChart size={20} />}
            title="No accounts yet"
            body="Add an account first, then add or import its transactions."
            actions={[{ label: 'Add account', onAction: () => goToInvesting('accounts') }]}
          />
        ) : (
          <EmptyState
            icon={<LineChart size={20} />}
            title="No transactions yet"
            body="Add one by hand, or import them from your broker."
            actions={[
              { label: 'Add transaction', onAction: () => goToInvesting('add') },
              { label: 'Import', onAction: () => goToInvesting('import') },
            ]}
          />
        )}
      </div>
    );
  }

  return (
    <div className="tx-view">
      <CashEventList accounts={accounts} writesDisabled={writesDisabled} />
      {(recent.todayCount > 0 || recent.weekBought > 0 || recent.weekSold > 0) ? (
        <div className="tx-kpi-strip" aria-label="Recent activity">
          <div className="tx-kpi">
            <span className="tx-kpi-label">Today</span>
            <span className="tx-kpi-value num">{recent.todayCount} <span className="muted">{recent.todayCount === 1 ? 'trade' : 'trades'}</span></span>
          </div>
          <div className="tx-kpi">
            <span className="tx-kpi-label">Net deployed today</span>
            <span className="tx-kpi-value num">{formatCurrency(recent.todayBought - recent.todaySold, 'USD')}</span>
          </div>
          <div className="tx-kpi">
            <span className="tx-kpi-label">7-day bought</span>
            <span className="tx-kpi-value num verb-buy-text">{formatCurrency(recent.weekBought, 'USD')}</span>
          </div>
          <div className="tx-kpi">
            <span className="tx-kpi-label">7-day sold</span>
            <span className="tx-kpi-value num verb-sell-text">{formatCurrency(recent.weekSold, 'USD')}</span>
          </div>
        </div>
      ) : null}
      {/* P2.12: filter presets — one-click common filter combos. */}
      <div className="tx-presets" role="group" aria-label="Filter presets">
        <span className="tx-presets-label">Quick filters</span>
        {presets.map((p) => (
          <button key={p.key} type="button" className="tx-preset-chip" onClick={p.apply}>{p.label}</button>
        ))}
        {/* P2.11: export filtered list */}
        <button type="button" className="tx-preset-chip tx-export-btn" onClick={exportCsv} title="Export current filtered view as CSV">
          ↓ Export CSV
        </button>
        <span className="tx-presets-help muted">Press / to search, ? for all shortcuts</span>
      </div>
      {/* P3.19: duplicate detection banner */}
      {duplicateIds.size > 0 ? (
        <div className="tx-dup-banner" role="status">
          <span className="tx-dup-icon" aria-hidden>⚠</span>
          <span>
            Detected <strong>{duplicateIds.size}</strong> likely-duplicate transaction{duplicateIds.size === 1 ? '' : 's'}
            {' '}(same account, symbol, date, quantity & price).
          </span>
          <button
            type="button"
            className={`tx-dup-action${duplicateOnly ? ' on' : ''}`}
            onClick={() => {
              clearFilters();
              setDuplicateOnly((value) => !value);
            }}
          >
            {duplicateOnly ? 'Show all' : 'Show duplicates'}
          </button>
        </div>
      ) : null}
      <TxFilterBar
        groupBy={groupBy} setGroupBy={setGroupBy}
        search={search} setSearch={setSearch} searchRef={searchRef}
        actionFilter={actionFilter} setActionFilter={setActionFilter}
        ownerFilter={ownerFilter} setOwnerFilter={setOwnerFilter}
        accountFilter={accountFilter} setAccountFilter={setAccountFilter}
        dateRange={dateRange} setDateRange={setDateRange}
        owners={owners} accounts={accounts}
        activeFilterCount={activeFilterCount} onClear={clearFilters}
      />

      <div className="tx-summary muted">
        Showing <strong className="num">{filtered.length}</strong> of {transactions.length} transactions
        {totals.bought > 0 ? (
          <>
            {' · bought '}
            <strong className="tx-group-bought">{formatCurrency(totals.bought, 'USD')}</strong>
          </>
        ) : null}
        {totals.sold > 0 ? (
          <>
            {' · sold '}
            <strong className="tx-group-sold">{formatCurrency(totals.sold, 'USD')}</strong>
          </>
        ) : null}
        {/* Round 3 (3.B4): Net invested (bought - sold). The actual
            'how much capital did I deploy this period' figure that
            mattered is now prominent, instead of being a mental-math
            exercise on top of two unrelated dollar amounts. */}
        {totals.bought + totals.sold > 0 ? (
          <>
            {' · net invested '}
            <strong className={`num ${totals.bought - totals.sold >= 0 ? 'tx-net-positive' : 'tx-net-negative'}`}>
              {formatCurrency(totals.bought - totals.sold, 'USD')}
            </strong>
          </>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No transactions match these filters"
          body={(
            <>
              <p style={{ marginBottom: 10 }}>Try clearing one or more filters, or jump to a preset:</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="tx-preset-chip" onClick={clearFilters}>Clear all filters</button>
                <button type="button" className="tx-preset-chip" onClick={presets[0].apply}>Today's trades</button>
                <button type="button" className="tx-preset-chip" onClick={presets[2].apply}>All sells</button>
              </div>
            </>
          )}
        />
      ) : (
        <div className="tx-groups">
          {groups.map((g) => (
            <TxGroup
              key={g.key}
              group={g}
              accountById={accountById}
              groupBy={groupBy}
              onRemove={remove}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelected}
              realizedById={realizedById}
              duplicateIds={duplicateIds}
            />
          ))}
        </div>
      )}
      {/* P2.10: floating bulk action bar */}
      {selectedIds.size > 0 ? (
        <div className="tx-bulk-bar" role="region" aria-label="Bulk actions">
          <span className="tx-bulk-count num">{selectedIds.size} selected</span>
          <button type="button" className="tx-bulk-btn" onClick={selectAllFiltered} disabled={writesDisabled}>Select all filtered ({filtered.length})</button>
          <button type="button" className="tx-bulk-btn" onClick={clearSelection}>Clear</button>
          <button type="button" className="tx-bulk-btn danger" onClick={bulkDelete} disabled={writesDisabled}>Remove {selectedIds.size}</button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grouping                                                           */
/* ------------------------------------------------------------------ */
interface TxGroupBucket {
  key: string;
  label: string;
  /** Optional secondary label rendered in muted text on the right of the header. */
  sublabel?: string;
  rows: Transaction[];
}

function groupTransactions(
  rows: Transaction[],
  by: GroupBy,
  accountById: Map<string, Account>,
): TxGroupBucket[] {
  if (by === 'none') {
    return rows.length > 0
      ? [{ key: 'all', label: 'All transactions', rows }]
      : [];
  }

  const buckets = new Map<string, { label: string; sublabel?: string; rows: Transaction[]; sortKey: string }>();
  for (const t of rows) {
    const acct = accountById.get(t.accountId);
    let key: string;
    let label: string;
    let sublabel: string | undefined;
    let sortKey: string;
    if (by === 'account') {
      key = t.accountId;
      label = acct?.name ?? 'Unknown account';
      sublabel = acct?.type;
      sortKey = label.toLowerCase();
    } else if (by === 'owner') {
      key = ownerOf(acct?.name);
      label = key;
      sortKey = key.toLowerCase();
    } else if (by === 'symbol') {
      key = t.symbol || '(no symbol)';
      label = key;
      sortKey = key.toLowerCase();
    } else { // month
      key = monthOf(t.date);
      label = formatMonth(key);
      sortKey = key; // YYYY-MM sorts naturally
    }
    const existing = buckets.get(key);
    if (existing) {
      existing.rows.push(t);
    } else {
      buckets.set(key, { label, sublabel, rows: [t], sortKey });
    }
  }

  return Array.from(buckets.entries())
    .map(([key, b]) => ({
      key,
      label: b.label,
      sublabel: b.sublabel,
      rows: b.rows,
    }))
    // Month groups sort newest first; everything else alphabetical.
    .sort((a, b) =>
      by === 'month' ? b.key.localeCompare(a.key) : a.label.toLowerCase().localeCompare(b.label.toLowerCase()),
    );
}

/* ------------------------------------------------------------------ */
/* Subcomponents                                                      */
/* ------------------------------------------------------------------ */

interface TxFilterBarProps {
  groupBy: GroupBy; setGroupBy: (g: GroupBy) => void;
  search: string; setSearch: (s: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  actionFilter: ActionFilter; setActionFilter: (a: ActionFilter) => void;
  ownerFilter: string; setOwnerFilter: (o: string) => void;
  accountFilter: Set<string>; setAccountFilter: (s: Set<string>) => void;
  dateRange: DateRange; setDateRange: (d: DateRange) => void;
  owners: string[]; accounts: Account[];
  activeFilterCount: number; onClear: () => void;
}

function TxFilterBar(p: TxFilterBarProps) {
  const groupOptions: { key: GroupBy; label: string }[] = [
    { key: 'none',    label: 'Date (newest)' },
    { key: 'account', label: 'Account' },
    { key: 'owner',   label: 'Owner' },
    { key: 'symbol',  label: 'Symbol' },
    { key: 'month',   label: 'Month' },
  ];
  const actionOptions: { key: ActionFilter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'buy', label: 'Buys' }, { key: 'sell', label: 'Sells' },
  ];
  const dateOptions: { key: DateRange; label: string }[] = [
    { key: 'today', label: 'Today' }, { key: '7d',  label: '7D'  }, { key: '30d', label: '30D' },
    { key: '90d', label: '90D' }, { key: 'ytd', label: 'YTD' },
    { key: 'all', label: 'All' },
  ];

  const toggleAccount = (id: string) => {
    const next = new Set(p.accountFilter);
    if (next.has(id)) next.delete(id); else next.add(id);
    p.setAccountFilter(next);
  };

  return (
    <div className="tx-filters">
      <div className="tx-filters-row">
        <label className="tx-search">
          <span className="visually-hidden">Search transactions</span>
          <input
            ref={p.searchRef}
            type="search"
            placeholder="Search symbol, account, notes…"
            title="Press / to focus search"
            value={p.search}
            onChange={(e) => p.setSearch(e.target.value)}
          />
        </label>
        {p.activeFilterCount > 0 ? (
          <button className="tx-clear" onClick={p.onClear} type="button">
            Clear ({p.activeFilterCount})
          </button>
        ) : null}
      </div>

      <div className="tx-filters-row">
        <SegmentedControl<GroupBy>
          label="Group by"
          options={groupOptions}
          value={p.groupBy}
          onChange={p.setGroupBy}
        />
        <SegmentedControl<ActionFilter>
          label="Action"
          options={actionOptions}
          value={p.actionFilter}
          onChange={p.setActionFilter}
        />
        <SegmentedControl<DateRange>
          label="Range"
          options={dateOptions}
          value={p.dateRange}
          onChange={p.setDateRange}
        />
        {p.owners.length > 1 ? (
          <SegmentedControl<string>
            label="Owner"
            options={[{ key: 'all', label: 'All' }, ...p.owners.map((o) => ({ key: o, label: o }))]}
            value={p.ownerFilter}
            onChange={p.setOwnerFilter}
          />
        ) : null}
      </div>

      <details className="tx-account-picker">
        <summary>
          Accounts
          {p.accountFilter.size > 0 ? <span className="tx-pill">{p.accountFilter.size}</span> : null}
        </summary>
        <div className="tx-account-grid">
          {p.accounts.map((a) => {
            const checked = p.accountFilter.has(a.id);
            return (
              <label key={a.id} className={`tx-account-chip ${checked ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleAccount(a.id)}
                />
                <span>{a.name}</span>
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}

function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div className="tx-segmented" role="group" aria-label={label}>
      <span className="tx-segmented-label">{label}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`tx-seg ${value === o.key ? 'on' : ''}`}
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface TxGroupProps {
  group: TxGroupBucket;
  accountById: Map<string, Account>;
  groupBy: GroupBy;
  onRemove: (id: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  realizedById: Map<string, number>;
  duplicateIds: Set<string>;
}

function TxGroup({ group, accountById, groupBy, onRemove, selectedIds, onToggleSelect, realizedById, duplicateIds }: TxGroupProps) {
  const showHeader = groupBy !== 'none';
  const isOptionGroup = groupBy === 'symbol'
    && group.rows.length > 0
    && group.rows.every((transaction) => transaction.instrumentType === 'option');
  // Show per-side trade volumes (always positive) instead of a single
  // signed `net`. For an account that only ever buys, `net` is just the
  // negative of bought-volume and reads like a loss — it isn't, it's
  // money you spent on shares. Robinhood and Fidelity both show
  // bought/sold separately for the same reason.
  const bought = group.rows.reduce((s, t) => (t.quantity > 0 ? s + transactionGrossValue(t) : s), 0);
  const sold   = group.rows.reduce((s, t) => (t.quantity < 0 ? s + transactionGrossValue(t) : s), 0);
  // P1.6: when grouped by symbol, surface net shares + weighted-avg buy
  // cost so the header doubles as a position summary.
  const symbolStats = useMemo(() => {
    if (groupBy !== 'symbol') return null;
    let netShares = 0;
    let buyShares = 0, buyCost = 0;
    let openContracts = 0, openPremium = 0;
    for (const t of group.rows) {
      netShares += t.quantity;
      if (t.instrumentType === 'option' && t.positionEffect === 'open') {
        openContracts += Math.abs(t.quantity);
        openPremium += Math.abs(t.quantity) * t.pricePerUnit;
      }
      if (t.quantity > 0) {
        buyShares += t.quantity;
        buyCost   += t.quantity * t.pricePerUnit;
      }
    }
    return {
      netShares,
      avgBuy: buyShares > 0 ? buyCost / buyShares : null,
      avgOpen: openContracts > 0 ? openPremium / openContracts : null,
    };
  }, [group.rows, groupBy]);
  return (
    <section className="tx-group">
      {showHeader ? (
        <header className="tx-group-header">
          <div className="tx-group-title">
            <span className="tx-group-label">{group.label}</span>
            {group.sublabel ? <span className="muted tx-group-sublabel"> · {group.sublabel}</span> : null}
          </div>
          <div className="tx-group-stats muted">
            <span>{group.rows.length} {group.rows.length === 1 ? 'trade' : 'trades'}</span>
            {bought > 0 ? (
              <>
                <span> · bought </span>
                <strong className="tx-group-bought">{formatCurrency(bought, 'USD')}</strong>
              </>
            ) : null}
            {sold > 0 ? (
              <>
                <span> · sold </span>
                <strong className="tx-group-sold">{formatCurrency(sold, 'USD')}</strong>
              </>
            ) : null}
            {symbolStats ? (
              <>
                <span> · net </span>
                <strong className={symbolStats.netShares >= 0 ? 'verb-buy-text' : 'verb-sell-text'}>
                  {symbolStats.netShares >= 0 ? '+' : ''}{symbolStats.netShares.toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
                  {isOptionGroup ? `contract${Math.abs(symbolStats.netShares) === 1 ? '' : 's'}` : 'sh'}
                </strong>
                {isOptionGroup && symbolStats.avgOpen !== null ? (
                  <>
                    <span> · avg {symbolStats.netShares < 0 ? 'credit' : 'debit'} </span>
                    <strong>{formatCurrency(symbolStats.avgOpen, 'USD')}</strong>
                  </>
                ) : symbolStats.avgBuy !== null ? (
                  <>
                    <span> · avg buy </span>
                    <strong>{formatCurrency(symbolStats.avgBuy, 'USD')}</strong>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </header>
      ) : null}
      <div className="tx-rows">
        {groupBy === 'none'
          ? renderRowsWithDateDividers(group.rows, accountById, onRemove, selectedIds, onToggleSelect, realizedById, duplicateIds)
          : group.rows.map((t) => (
              <TxRow
                key={t.id}
                tx={t}
                account={accountById.get(t.accountId)}
                // When already grouped by account, suppress the account chip on each row to reduce noise.
                showAccount={groupBy !== 'account'}
                onRemove={onRemove}
                selected={selectedIds.has(t.id)}
                onToggleSelect={onToggleSelect}
                realized={realizedById.get(t.id)}
                isDuplicate={duplicateIds.has(t.id)}
              />
            ))}
      </div>
    </section>
  );
}

/**
 * For the flat (no-grouping) list, inject lightweight date-section
 * dividers ("Today", "Yesterday", "Earlier this week", "May", …) before
 * the first row of each section. Rows inside a section keep their inline
 * date stamp so the eye can still see exact day at a glance.
 */
function renderRowsWithDateDividers(
  rows: Transaction[],
  accountById: Map<string, Account>,
  onRemove: (id: string) => void,
  selectedIds: Set<string>,
  onToggleSelect: (id: string) => void,
  realizedById: Map<string, number>,
  duplicateIds: Set<string>,
): ReactNode[] {
  const out: ReactNode[] = [];
  let lastLabel: string | null = null;
  for (const t of rows) {
    const label = relativeSectionLabel(t.date);
    if (label !== lastLabel) {
      out.push(
        <div key={`section-${t.id}`} className="tx-date-section" role="presentation">
          {label}
        </div>,
      );
      lastLabel = label;
    }
    out.push(
      <TxRow
        key={t.id}
        tx={t}
        account={accountById.get(t.accountId)}
        showAccount
        onRemove={onRemove}
        selected={selectedIds.has(t.id)}
        onToggleSelect={onToggleSelect}
        realized={realizedById.get(t.id)}
        isDuplicate={duplicateIds.has(t.id)}
      />,
    );
  }
  return out;
}

interface TxRowProps {
  tx: Transaction;
  account: Account | undefined;
  showAccount: boolean;
  onRemove: (id: string) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  realized?: number;
  isDuplicate?: boolean;
}

function TxRow({ tx, account, showAccount, onRemove, selected, onToggleSelect, realized, isDuplicate }: TxRowProps) {
  const isBuy = tx.quantity > 0;
  const isOption = tx.instrumentType === 'option';
  const qty = Math.abs(tx.quantity);
  const tradeValue = transactionGrossValue(tx);
  const dateParts = formatRowDate(tx.date);
  const dateText = `${dateParts.month} ${dateParts.day}${dateParts.year ? `, ${dateParts.year}` : ''}`;
  const drawerId = useId();
  const updateTransaction = usePortfolioStore((s) => s.updateTransaction);
  const updateActionId = `updateTransaction:${tx.id}`;
  const isUpdating = usePortfolioStore((s) => s.loadingActions.includes(updateActionId));
  const updateError = usePortfolioStore((s) => s.actionErrors[updateActionId]?.error ?? null);
  const clearActionError = usePortfolioStore((s) => s.clearActionError);
  const writesDisabled = usePortfolioStore((s) => s.apiStatus === 'cache');
  // P1.7: heuristic — trades dated today are treated as pending/settling.
  // Most US brokerages mark equity trades as "Processing" until T+1.
  const isPending = tx.date === isoLocalDate();
  // P1.9: owner is encoded as the prefix before " · " in the account
  // name. Used to color a small pill that lets the eye filter by who
  // owns the trade without reading the full account name.
  const ownerLabel = account ? ownerOf(account.name) : null;
  const accountShortName = account
    ? account.name.includes(' · ')
        ? account.name.slice(account.name.indexOf(' · ') + 3)
        : account.name
    : null;
  // P1.8: row expansion. Click or tap the row's summary (not the menu) to open its drawer: quantity and price
  // (editable), source, notes and the technical details. Keyboard accessible.
  const [expanded, setExpanded] = useState(false);
  const [lastEdit, setLastEdit] = useState<Partial<Pick<Transaction, 'quantity' | 'pricePerUnit'>> | null>(null);
  // Sprint 1: row overflow menu. Destructive single-click is a footgun.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  const toggleExpand = () => setExpanded((v) => !v);
  const updateWithGuard = async (patch: Partial<Pick<Transaction, 'quantity' | 'pricePerUnit'>>) => {
    const beforeValue = transactionGrossValue(tx);
    const nextQuantity = patch.quantity ?? tx.quantity;
    const nextPrice = patch.pricePerUnit ?? tx.pricePerUnit;
    const afterValue = Math.abs(nextQuantity) * nextPrice * (tx.contractMultiplier ?? 1);
    const delta = Math.abs(afterValue - beforeValue);
    if (delta > 5_000 && !window.confirm(`This edit changes trade value by ${formatCurrency(delta, tx.currency)}. Save it?`)) {
      return;
    }
    setLastEdit({
      ...(patch.quantity !== undefined ? { quantity: tx.quantity } : {}),
      ...(patch.pricePerUnit !== undefined ? { pricePerUnit: tx.pricePerUnit } : {}),
    });
    await updateTransaction(tx.id, patch);
  };
  const undoLastEdit = async () => {
    if (!lastEdit) return;
    await updateTransaction(tx.id, lastEdit);
    setLastEdit(null);
  };
  // The row reads: the symbol, Bought or Sold and the amount; then the date and the account. The whole summary is one
  // control that opens the drawer under it (quantity, price, source and the rest). The drawer sits outside the
  // control, so its fields are never inside a button and a click in it never closes the row.
  return (
    <div className={`tx-row ${expanded ? 'is-expanded' : ''} ${selected ? 'is-selected' : ''}`}>
      <label className="tx-row-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          disabled={writesDisabled}
          onChange={() => onToggleSelect(tx.id)}
          aria-label={`Select transaction ${tx.symbol} ${tx.date}`}
        />
      </label>
      <div
        className="tx-row-main tx-row-clickable"
        role="button"
        tabIndex={0}
        onClick={toggleExpand}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); } }}
        aria-expanded={expanded}
        aria-controls={expanded ? drawerId : undefined}
      >
        <div className="tx-row-title">
          <span className="symbol">{isOption ? formatOptionSymbol(tx.symbol) : tx.symbol || '—'}</span>
          {isPending ? <span className="tx-status-badge pending">Pending</span> : null}
          {isDuplicate ? <span className="tx-status-badge dup">Possible duplicate</span> : null}
          {lastEdit ? <span className="tx-status-badge edited">Edited</span> : null}
        </div>
        <div className="tx-row-amount">
          <span className={`tx-amount-verb ${isBuy ? 'verb-buy' : 'verb-sell'}`}>{transactionAction(tx)}</span>
          {' '}
          <span className="tx-amount-value num">{formatCurrency(tradeValue, tx.currency)}</span>
        </div>
        <div className="tx-row-meta">
          <time className="tx-row-date" dateTime={tx.date}>{dateText}</time>
          {showAccount && ownerLabel ? (
            <>
              <span className="tx-row-sep" aria-hidden="true">·</span>
              <span className={`tx-owner-pill owner-${ownerLabel.toLowerCase()}`}>{ownerLabel}</span>
              {accountShortName ? <span className="tx-account-short">{accountShortName}</span> : null}
            </>
          ) : null}
        </div>
        {!isBuy && typeof realized === 'number' ? (
          <div className={`tx-realized num ${realized >= 0 ? 'verb-buy-text' : 'verb-sell-text'}`}>
            {realized >= 0 ? '+' : ''}{formatCurrency(realized, tx.currency)} realized
          </div>
        ) : null}
      </div>
      <div className="tx-row-menu" ref={menuRef}>
        <button
          type="button"
          className="tx-row-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Row actions"
          disabled={writesDisabled}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        >
          <MoreVertical size={14} />
        </button>
        {menuOpen ? (
          <div className="tx-row-menu-popover" role="menu">
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                if (window.confirm(`Remove ${tx.symbol || 'this transaction'}? This cannot be undone.`)) {
                  onRemove(tx.id);
                }
              }}
            >
              Remove transaction
            </button>
          </div>
        ) : null}
      </div>
      {expanded ? (
        <div className="tx-row-drawer" id={drawerId}>
          <dl className="tx-drawer-facts">
            <div className="tx-drawer-row">
              <dt className="tx-drawer-label">Quantity</dt>
              <dd className="tx-drawer-value num">
                {isOption ? `${qty.toLocaleString()} contract${qty === 1 ? '' : 's'}` : (
                  <InlineNumberEdit
                    label="Quantity"
                    value={qty}
                    disabled={isUpdating || writesDisabled}
                    formatValue={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    onEditStart={() => clearActionError(updateActionId)}
                    onSave={(next) => updateWithGuard({ quantity: isBuy ? next : -next })}
                  />
                )}
              </dd>
            </div>
            <div className="tx-drawer-row">
              <dt className="tx-drawer-label">Price</dt>
              <dd className="tx-drawer-value num">
                {isOption ? formatCurrency(tx.pricePerUnit, tx.currency) : (
                  <InlineNumberEdit
                    label="Price"
                    value={tx.pricePerUnit}
                    disabled={isUpdating || writesDisabled}
                    formatValue={(v) => formatCurrency(v, tx.currency)}
                    onEditStart={() => clearActionError(updateActionId)}
                    onSave={(next) => updateWithGuard({ pricePerUnit: next })}
                  />
                )}
              </dd>
            </div>
            {isOption ? (
              <>
                <div className="tx-drawer-row">
                  <dt className="tx-drawer-label">Contract</dt>
                  <dd className="tx-drawer-value">{transactionAction(tx)} · multiplier {tx.contractMultiplier}</dd>
                </div>
                <div className="tx-drawer-row">
                  <dt className="tx-drawer-label">Gross premium</dt>
                  <dd className="tx-drawer-value num">{formatCurrency(tradeValue, tx.currency)}</dd>
                </div>
                {tx.fees != null ? (
                  <div className="tx-drawer-row">
                    <dt className="tx-drawer-label">Fees</dt>
                    <dd className="tx-drawer-value num">{formatCurrency(tx.fees, tx.currency)}</dd>
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="tx-drawer-row">
              <dt className="tx-drawer-label">Source</dt>
              <dd className="tx-drawer-value">{transactionSource(tx)}</dd>
            </div>
            {tx.notes ? (
              <div className="tx-drawer-row">
                <dt className="tx-drawer-label">Notes</dt>
                <dd className="tx-drawer-value">{tx.notes}</dd>
              </div>
            ) : null}
            {account ? (
              <div className="tx-drawer-row">
                <dt className="tx-drawer-label">Account</dt>
                <dd className="tx-drawer-value">{account.name}{account.accountNumber ? ` · •••${String(account.accountNumber).slice(-4)}` : ''}</dd>
              </div>
            ) : null}
            <div className="tx-drawer-row">
              <dt className="tx-drawer-label">Trade ID</dt>
              <dd className="tx-drawer-value mono">{tx.id}</dd>
            </div>
            {tx.sourceFingerprint ? (
              <div className="tx-drawer-row">
                <dt className="tx-drawer-label">Import ID</dt>
                <dd className="tx-drawer-value mono">{tx.sourceFingerprint}</dd>
              </div>
            ) : null}
          </dl>
          {lastEdit || isUpdating || updateError ? (
            <div className="tx-drawer-edit">
              {isUpdating ? <span className="tx-edit-saving">Saving…</span> : null}
              {updateError ? <span className="tx-edit-error" role="alert">{updateError}</span> : null}
              {lastEdit && !isUpdating ? (
                <button type="button" className="tx-undo-edit" onClick={() => { void undoLastEdit().catch(() => {}); }}>
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
          {isOption ? null : <CostBasisPanel tx={tx} />}
        </div>
      ) : null}
    </div>
  );
}

function CostBasisPanel({ tx }: { tx: Transaction }) {
  const [check, setCheck] = useState<CostBasisCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<CostBasisCheck>(`/transactions/${encodeURIComponent(tx.id)}/cost-basis-check`)
      .then((res) => { if (!cancelled) setCheck(res); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tx.id, tx.pricePerUnit]);

  if (loading) {
    return (
      <div className="tx-cost-check muted">
        Checking historical price…
      </div>
    );
  }
  if (error) {
    return <div className="tx-cost-check error">Historical price check failed: {error}</div>;
  }
  if (!check) return null;
  if (check.warningLevel === 'unknown') {
    return (
      <div className="tx-cost-check muted">
        Historical price check unavailable: {check.reason ?? 'no cached data'}
      </div>
    );
  }
  const deviation = check.deviationPercent ?? 0;
  const levelClass = check.warningLevel === 'major' ? 'major' : check.warningLevel === 'minor' ? 'minor' : 'ok';
  return (
    <div className={`tx-cost-check ${levelClass}`}>
      <span className="tx-cost-label">Historical price</span>
      <span>
        Entered {formatCurrency(check.enteredPrice)} vs close {formatCurrency(check.historicalPrice ?? 0)}
        {check.historicalDate ? <> on <span className="tx-cost-date">{check.historicalDate}</span></> : ''}
        {' · '}{deviation >= 0 ? '+' : ''}{deviation.toFixed(2)}%
      </span>
      {check.warningLevel !== 'none' ? <strong>{check.warningLevel === 'major' ? 'Check this lot' : 'Review'}</strong> : <strong>Looks normal</strong>}
    </div>
  );
}

interface InlineNumberEditProps {
  label: string;
  value: number;
  disabled?: boolean;
  formatValue: (v: number) => string;
  onEditStart?: () => void;
  onSave: (value: number) => Promise<unknown>;
}

function InlineNumberEdit({ label, value, disabled, formatValue, onEditStart, onSave }: InlineNumberEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const start = () => {
    if (disabled) return;
    onEditStart?.();
    setLocalError(null);
    setDraft(String(value));
    setEditing(true);
  };

  const cancel = () => {
    setDraft(String(value));
    setLocalError(null);
    setEditing(false);
  };

  const save = async () => {
    const next = Number(draft.replace(/,/g, '').trim());
    if (!Number.isFinite(next) || next <= 0) {
      setLocalError(`${label} must be a positive number`);
      return;
    }
    if (Math.abs(next - value) < 1e-9) {
      setEditing(false);
      return;
    }
    try {
      await onSave(next);
      setEditing(false);
      setLocalError(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  if (editing) {
    return (
      <span className="tx-inline-edit" onClick={(e) => e.stopPropagation()}>
        <input
          aria-label={label}
          autoFocus
          className={localError ? 'has-error' : ''}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setLocalError(null); }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') cancel();
          }}
        />
        {localError ? <span className="tx-inline-error" role="alert">{localError}</span> : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="tx-inline-value"
      disabled={disabled}
      title={`Edit ${label.toLowerCase()}`}
      onClick={(e) => { e.stopPropagation(); start(); }}
    >
      {formatValue(value)}
    </button>
  );
}
