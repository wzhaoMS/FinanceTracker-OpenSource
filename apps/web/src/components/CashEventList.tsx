import { useEffect, useId, useMemo, useState } from 'react';
import { formatShownAmount, type Account, type CashEvent, type ShownValue } from '@finance-tracker/shared';

import { api, apiFetch } from '../services/api';
import { ChevronDown, ChevronRight, Trash2 } from './icons';
import { withTone } from './tone';

interface Props {
  accounts: Account[];
  writesDisabled: boolean;
}

export function CashEventList({ accounts, writesDisabled }: Props) {
  const [events, setEvents] = useState<CashEvent[]>([]);
  // Whether the ledger has loaded once. Until it has (still loading, or the load failed) its count and net flow are
  // unknown and read "—", never "0 events · $0.00"; a later failed delete keeps what is known.
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Collapsed by default so the trade list is not pushed below hundreds of rows.
  const [expanded, setExpanded] = useState(false);
  const tableId = useId();
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const netFlows = useMemo(() => {
    const totals = new Map<string, number>();
    for (const event of events) {
      totals.set(event.currency, (totals.get(event.currency) ?? 0) + event.amount);
    }
    if (totals.size === 0) totals.set('USD', 0);
    return Array.from(totals.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [events]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ cashEvents: CashEvent[] }>('/cash-events')
      .then((result) => {
        if (!cancelled) {
          setEvents(result.cashEvents);
          setLoaded(true);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const remove = async (event: CashEvent) => {
    if (!window.confirm(`Remove this ${cashEventLabel(event.eventType).toLowerCase()} cash event? This cannot be undone.`)) {
      return;
    }
    setDeletingId(event.id);
    setError(null);
    try {
      const response = await apiFetch(`/cash-events/${encodeURIComponent(event.id)}`, { method: 'DELETE' });
      if (response.status !== 204 && response.status !== 404) {
        throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
      }
      setEvents((current) => current.filter((item) => item.id !== event.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="cash-ledger" aria-label="Cash ledger">
      <header className="cash-ledger-header">
        <div>
          <h2>
            <button
              type="button"
              className="cash-ledger-toggle"
              aria-expanded={expanded && events.length > 0}
              aria-controls={expanded && events.length > 0 ? tableId : undefined}
              title={expanded ? 'Hide cash events' : 'Show cash events'}
              disabled={events.length === 0}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Cash ledger
            </button>
          </h2>
          <p>Broker cash activity. The value chart uses broker end-of-day cash balances where available.</p>
        </div>
        <div className="cash-ledger-stats">
          {/* Until they are known, the count and net flow read "—" and are heard as unknown, never as "em dash events". */}
          {loaded
            ? <span><strong className="num">{events.length}</strong> {events.length === 1 ? 'event' : 'events'}</span>
            : <span><strong className="num"><span aria-hidden>—</span><span className="visually-hidden">Unknown number of</span></strong> events</span>}
          <span className="cash-ledger-net">
            Net cash flow{' '}
            {loaded
              ? netFlows.map(([currency, amount]) => (
                  <strong key={currency} className={withTone('num', shownCashAmount(amount, currency).tone)}>
                    {shownCashAmount(amount, currency).text}
                  </strong>
                ))
              : <strong className="num"><span aria-hidden>—</span><span className="visually-hidden">unknown</span></strong>}
          </span>
        </div>
      </header>

      {error ? <div className="cash-ledger-error" role="alert">{error}</div> : null}
      {loading ? <div className="cash-ledger-empty muted">Loading cash events...</div> : null}
      {!loading && !loaded ? (
        <div className="cash-ledger-empty muted">Cash events couldn&rsquo;t be loaded, so their count and net cash flow are unknown.</div>
      ) : null}
      {loaded && events.length === 0 ? (
        <div className="cash-ledger-empty muted">No broker cash events imported.</div>
      ) : null}
      {events.length > 0 && expanded ? (
        <div id={tableId} className="cash-ledger-table" role="table" aria-label="Imported cash events" tabIndex={0}>
          <div className="cash-ledger-row cash-ledger-column-heads" role="row">
            <span role="columnheader">Date</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Account / description</span>
            <span role="columnheader">Source</span>
            <span role="columnheader" className="num">Amount</span>
            <span role="columnheader" aria-label="Actions" />
          </div>
          {events.map((event) => {
            const account = accountById.get(event.accountId);
            return (
              <div className="cash-ledger-row" role="row" key={event.id}>
                <span className="cash-event-date" role="cell">{event.date}</span>
                <span className="cash-event-type" role="cell">{cashEventLabel(event.eventType)}</span>
                <span className="cash-event-main" role="cell">
                  <strong>{account?.name ?? 'Unknown account'}</strong>
                  <span>{event.description}</span>
                </span>
                <span
                  className="cash-event-source"
                  role="cell"
                  title={`Fingerprint ${event.sourceFingerprint}`}
                >
                  {titleCase(event.broker)} · ***{event.accountLast4}
                </span>
                <strong className={withTone('cash-event-amount num', shownCashAmount(event.amount, event.currency).tone)} role="cell">
                  {shownCashAmount(event.amount, event.currency).text}
                </strong>
                <button
                  type="button"
                  className="cash-event-remove"
                  aria-label={`Remove cash event ${event.description}`}
                  title="Remove cash event"
                  disabled={writesDisabled || deletingId === event.id}
                  onClick={() => { void remove(event); }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function cashEventLabel(type: CashEvent['eventType']): string {
  return type === 'deposit' ? 'Deposit'
    : type === 'withdrawal' ? 'Withdrawal'
      : type === 'dividend' ? 'Dividend'
        : type === 'interest' ? 'Interest'
          : type === 'transfer' ? 'Transfer'
            : type === 'fee' ? 'Fee'
              : type === 'tax' ? 'Tax'
                : 'Sweep';
}

/** A cash amount as shown: "+" before money in; one that reads zero is unsigned and in neither colour. */
function shownCashAmount(value: number, currency = 'USD'): ShownValue {
  return formatShownAmount(value, { currency, signed: true });
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}