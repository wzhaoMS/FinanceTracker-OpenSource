import { useEffect, useId, useMemo, useState } from 'react';

import { usePortfolioStore } from '../stores/portfolio';
import { fetchQuotes } from '../services/api';
import type { Quote } from '@finance-tracker/shared';
import './investing-entry.css';

/**
 * The Add page: one transaction, in two groups (the trade, then its quantity and price), saved only by its one
 * button, "Add transaction".
 */
export function AddTransactionForm({ onSaved }: { onSaved?: () => void }) {
  const titleId = useId();
  const accounts = usePortfolioStore((s) => s.accounts);
  const transactions = usePortfolioStore((s) => s.transactions);
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const writesDisabled = usePortfolioStore((s) => s.apiStatus === 'cache');

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [hintQuote, setHintQuote] = useState<Quote | null>(null);
  const [saving, setSaving] = useState(false);

  // Accounts hydrate after the first render. Ensure forms mounted before
  // hydration still select a valid default instead of remaining on "" and
  // failing with "Pick an account" despite visible options.
  useEffect(() => {
    if (accounts.length === 0) {
      if (accountId) setAccountId('');
      return;
    }
    if (!accountId || !accounts.some((account) => account.id === accountId)) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  // Round 3 (3.B5): autocomplete the symbol input from the user's
  // existing holdings. The previous free-text input had no suggestions
  // so the same ticker could be typed with different casing or typos
  // (BRK.B vs BRK-B vs brkb). The portfolio is a closed-vocabulary
  // problem here: the right autocomplete corpus is "things this user
  // has already touched". Generic search hits a backend we don't
  // have today.
  const knownSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const t of transactions) if (t.symbol) set.add(t.symbol);
    return Array.from(set).sort();
  }, [transactions]);

  // Round 3 (3.B5): last-close hint under the price field. Defends
  // against fat-finger entries (typing 41396 instead of 413.96 for an
  // MSFT buy). Refetches when the symbol changes; debounced 350ms.
  useEffect(() => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) { setHintQuote(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const quotes = await fetchQuotes([sym]);
        if (cancelled) return;
        setHintQuote(quotes[0] ?? null);
      } catch {
        if (!cancelled) setHintQuote(null);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [symbol]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    const px = Number(price);
    const feeAmount = fees ? Number(fees) : undefined;
    if (!accountId) return setError('Pick an account');
    if (!symbol.trim()) return setError('Symbol is required');
    if (!Number.isFinite(qty) || qty <= 0) return setError('Quantity must be a positive number');
    if (!Number.isFinite(px) || px < 0) return setError('Price must be a non-negative number');
    if (feeAmount !== undefined && (!Number.isFinite(feeAmount) || feeAmount < 0)) {
      return setError('Fees must be a non-negative number');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Date must be YYYY-MM-DD');

    setSaving(true);
    try {
      await addTransaction({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        symbol: symbol.trim().toUpperCase(),
        date,
        quantity: side === 'buy' ? qty : -qty,
        pricePerUnit: px,
        fees: feeAmount,
        currency: 'USD',
      });
      setSymbol(''); setQuantity(''); setPrice(''); setFees('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const lastClose = hintQuote?.price ?? null;
  const matchesSymbol = hintQuote && hintQuote.symbol === symbol.trim().toUpperCase();

  return (
    <form className="add add-transaction" onSubmit={submit} aria-labelledby={titleId}>
      <h2 id={titleId} className="add-transaction-title">Add a transaction</h2>
      <fieldset className="add-group">
        <legend>Trade</legend>
        <label>
          Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.length === 0 ? <option value="">No accounts — add one first</option> : null}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.type ? ` · ${a.type}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Buy or sell
          <select value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </label>
        <label>
          Symbol
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="AAPL"
            list="add-tx-symbol-suggestions"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
          />
          <datalist id="add-tx-symbol-suggestions">
            {knownSymbols.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </fieldset>
      <fieldset className="add-group">
        <legend>Quantity and price</legend>
        <label>
          Quantity
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" placeholder="10" />
        </label>
        <label>
          Price per unit (USD)
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="150.25" />
          {matchesSymbol && lastClose != null ? (
            <div className="form-hint">
              Last close <button
                type="button"
                className="form-hint-link"
                onClick={() => setPrice(lastClose.toFixed(2))}
                aria-label={`Use the last close, $${lastClose.toFixed(2)}`}
              >${lastClose.toFixed(2)}</button>
            </div>
          ) : null}
        </label>
        <label>
          Fees (optional)
          <input value={fees} onChange={(e) => setFees(e.target.value)} inputMode="decimal" placeholder="0" />
        </label>
      </fieldset>
      {error ? <div className="error form-error" role="alert">{error}</div> : null}
      <button type="submit" disabled={writesDisabled || saving}>
        {saving ? 'Adding transaction…' : 'Add transaction'}
      </button>
    </form>
  );
}
