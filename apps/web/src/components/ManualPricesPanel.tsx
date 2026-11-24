import { useEffect, useState } from 'react';
import { formatCurrency } from '@finance-tracker/shared';

import { api, apiFetch } from '../services/api';
import { usePortfolioStore } from '../stores/portfolio';
import './investing-entry.css';

interface ManualPriceEntry {
  symbol: string;
  date: string;
  close: number;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ListAllResponse {
  entries: ManualPriceEntry[];
}

/**
 * Phase E.7 — manual price overrides UI.
 *
 * Lets the user enter close prices on specific dates for symbols the
 * providers don't cover (employer-only funds, private placements). The
 * portfolio reconstruction prefers manual values over the daily-bar cache,
 * so unlisted holdings stop dropping out of the value chart.
 *
 * Pre-populates the symbol dropdown from the user's transactions so the
 * common case ("VANG500 has no provider data") doesn't require typing.
 *
 * Disabled in cache mode (writes off) — same as other mutators.
 */
export function ManualPricesPanel() {
  const apiStatus = usePortfolioStore((s) => s.apiStatus);
  const transactions = usePortfolioStore((s) => s.transactions);
  const symbols = Array.from(new Set(transactions.map((t) => t.symbol))).sort();

  const [entries, setEntries] = useState<ManualPriceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Form state
  const [symbol, setSymbol] = useState<string>(symbols[0] ?? '');
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [close, setClose] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const reload = async () => {
    setLoading(true); setErr(null);
    try {
      const res = await api<ListAllResponse>('/manual-prices');
      setEntries(res.entries);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load manual prices');
    } finally { setLoading(false); }
  };

  useEffect(() => { void reload(); }, []);
  // Default the symbol picker once tx-derived list arrives.
  useEffect(() => {
    if (!symbol && symbols.length > 0) setSymbol(symbols[0]);
  }, [symbols, symbol]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (apiStatus === 'cache') return;
    if (!symbol || !date) return;
    const closeNum = Number(close);
    if (!Number.isFinite(closeNum) || closeNum <= 0) {
      setErr('Close must be a positive number'); return;
    }
    setSubmitting(true); setErr(null);
    try {
      const res = await apiFetch(`/manual-prices/${encodeURIComponent(symbol)}/${date}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ close: closeNum, notes: notes || undefined }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setClose(''); setNotes('');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally { setSubmitting(false); }
  };

  const removeEntry = async (sym: string, dt: string) => {
    if (apiStatus === 'cache') return;
    if (!confirm(`Remove manual price for ${sym} on ${dt}?`)) return;
    try {
      const res = await apiFetch(`/manual-prices/${encodeURIComponent(sym)}/${dt}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`${res.status} ${res.statusText}`);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <section className="manual-prices" aria-labelledby="manual-prices-title">
      <header className="account-header">
        <div>
          <h3 id="manual-prices-title" className="account-name manual-prices-title">Manual prices</h3>
          <p className="muted manual-prices-intro">
            Enter close prices for unlisted holdings (employer-only funds, private placements). The
            portfolio chart prefers these over provider data when both exist.
          </p>
        </div>
      </header>

      <form className="manual-prices-form" onSubmit={submit}>
        <label>
          <span className="muted">Symbol</span>
          <input
            list="manual-prices-symbol-suggestions"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="VANG500"
            required
            disabled={apiStatus === 'cache'}
          />
          <datalist id="manual-prices-symbol-suggestions">
            {symbols.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label>
          <span className="muted">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            disabled={apiStatus === 'cache'}
          />
        </label>
        <label>
          <span className="muted">Close ($)</span>
          <input
            type="number" step="0.0001" min="0"
            value={close}
            onChange={(e) => setClose(e.target.value)}
            placeholder="100.00"
            required
            disabled={apiStatus === 'cache'}
          />
        </label>
        <label className="grow">
          <span className="muted">Notes (optional)</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Quarterly NAV statement"
            disabled={apiStatus === 'cache'}
          />
        </label>
        <button type="submit" className="refresh" disabled={submitting || apiStatus === 'cache'}>
          {submitting ? 'Saving…' : 'Add / update'}
        </button>
      </form>

      {err ? <div className="error">{err}</div> : null}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="muted">No manual prices yet.</div>
      ) : (
        <table className="holdings">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Date</th>
              <th className="num">Close</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.symbol}-${e.date}`}>
                <td className="sym">{e.symbol}</td>
                <td>{e.date}</td>
                <td className="num">{formatCurrency(e.close)}</td>
                <td className="muted">{e.notes ?? ''}</td>
                <td>
                  <button
                    type="button"
                    className="refresh"
                    onClick={() => removeEntry(e.symbol, e.date)}
                    disabled={apiStatus === 'cache'}
                    aria-label={`Remove manual price for ${e.symbol} on ${e.date}`}
                  >Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
