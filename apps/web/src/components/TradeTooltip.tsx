import { formatCurrency, type Transaction } from '@finance-tracker/shared';

interface Props {
  transaction?: Transaction;
  transactions?: Transaction[];
  accountName?: string;
  accountIdToName?: Map<string, string>;
  compact?: boolean;
}

export function TradeTooltip({ transaction, transactions, accountName, accountIdToName, compact = false }: Props) {
  const rows = transactions && transactions.length > 0 ? transactions : transaction ? [transaction] : [];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    const firstDate = rows[0].date;
    return (
      <div className={`trade-tooltip-card ${compact ? 'compact' : ''} mixed`}>
        <div className="trade-tooltip-header">
          <span className="trade-tooltip-badge mixed">{rows.length} trades</span>
          <span className="trade-tooltip-date">{formatTradeDate(firstDate)}</span>
        </div>
        <div className="trade-tooltip-list">
          {rows.map((t) => (
            <TradeTooltipLine
              key={t.id}
              transaction={t}
              accountName={accountIdToName?.get(t.accountId) ?? accountName}
            />
          ))}
        </div>
      </div>
    );
  }
  const [only] = rows;
  return (
    <div className={`trade-tooltip-card ${compact ? 'compact' : ''} ${only.quantity > 0 ? 'buy' : 'sell'}`}>
      <div className="trade-tooltip-header">
        <span className={`trade-tooltip-badge ${only.quantity > 0 ? 'buy' : 'sell'}`}>{only.quantity > 0 ? 'Buy' : 'Sell'}</span>
        <span className="trade-tooltip-date">{formatTradeDate(only.date)}</span>
      </div>
      <div className="trade-tooltip-grid">
        <span>Shares</span>
        <strong>{Math.abs(only.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong>
        <span>Price</span>
        <strong>{formatCurrency(only.pricePerUnit, only.currency)}</strong>
        <span>Amount</span>
        <strong>{formatCurrency(tradeAmount(only), only.currency)}</strong>
        {(only.fees ?? 0) > 0 ? (
          <>
            <span>Fees</span>
            <strong>{formatCurrency(only.fees ?? 0, only.currency)}</strong>
          </>
        ) : null}
        {accountName ? (
          <>
            <span>Account</span>
            <strong>{shortAccountName(accountName)}</strong>
          </>
        ) : null}
      </div>
    </div>
  );
}

function TradeTooltipLine({ transaction, accountName }: { transaction: Transaction; accountName?: string }) {
  const isBuy = transaction.quantity > 0;
  return (
    <div className="trade-tooltip-line">
      <span className={`trade-tooltip-badge ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? 'Buy' : 'Sell'}</span>
      <span className="trade-tooltip-line-date">{formatShortTradeDate(transaction.date)}</span>
      <span className="trade-tooltip-line-trade">
        <b>{transaction.symbol}</b>{' '}
        {Math.abs(transaction.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })} @ {formatCurrency(transaction.pricePerUnit, transaction.currency)}
      </span>
      <strong>{formatCurrency(tradeAmount(transaction), transaction.currency)}</strong>
      {accountName ? <em>{shortAccountName(accountName)}</em> : null}
    </div>
  );
}

function tradeAmount(transaction: Transaction): number {
  const shares = Math.abs(transaction.quantity);
  const gross = shares * transaction.pricePerUnit;
  const fees = transaction.fees ?? 0;
  return transaction.quantity > 0 ? gross + fees : gross - fees;
}

function formatShortTradeDate(date: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00Z`) : new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTradeDate(date: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00Z`) : new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortAccountName(name: string): string {
  const sep = name.indexOf(' · ');
  return sep >= 0 ? name.slice(sep + 3) : name;
}
