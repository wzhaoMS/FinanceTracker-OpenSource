import { useEffect, useMemo, useRef, useState } from 'react';
import type { Quote } from '@finance-tracker/shared';
import { formatCurrency, maskAccountNumber, summarizeByAccount } from '@finance-tracker/shared';

import { usePortfolioStore } from '../stores/portfolio';
import { ManualPricesPanel } from './ManualPricesPanel';
import { ChevronDown, MoreVertical, Plus, X } from './icons';

/**
 * Accounts manager.
 *
 * Round 3 (3.B1) rewrote this surface. Previous shipping behaviour:
 *   - Every account row was permanently in edit mode with five
 *     bordered <input>s (name, type, acct #, cash, +echo) plus a
 *     red "Remove" link aligned far-right.
 *   - The "Add account" form lived ABOVE the existing accounts,
 *     mixing create + manage and pushing real data below the fold.
 *   - The audit's third-pass critique called this "the worst-looking
 *     surface on the site."
 *
 * New behaviour:
 *   - Accounts render as read-only cards by default. Tap the pencil
 *     ⋯ menu to edit, which expands the card into the legacy inline
 *     form below the read-only header. Inline so we don't introduce
 *     another modal/sheet pattern.
 *   - "Add account" hides behind a `+ New account` button at the top
 *     that opens an inline slide-down form. Doesn't conflate create
 *     with manage.
 *   - Remove is moved into the row ⋮ menu with a confirm step.
 *   - Each account header shows a `BrokerBadge` 28x28 square with
 *     a brokerage initial (no third-party favicons; we don't ship
 *     image assets and avoid CORS).
 */
export function AccountsManager({ quotes }: { quotes: Quote[] }) {
  const accounts = usePortfolioStore((s) => s.accounts);
  const transactions = usePortfolioStore((s) => s.transactions);
  const addAccount = usePortfolioStore((s) => s.addAccount);
  const renameAccount = usePortfolioStore((s) => s.renameAccount);
  const setCash = usePortfolioStore((s) => s.setCash);
  const removeAccount = usePortfolioStore((s) => s.removeAccount);
  const writesDisabled = usePortfolioStore((s) => s.apiStatus === 'cache');

  const [adderOpen, setAdderOpen] = useState(false);

  // Round 4 (4.A3): the right-hand value on each account card used to
  // render `cashBalance` only — e.g. `$26.18` for a Fidelity TOD that
  // also held $415 of TSLA. The Portfolio tab and the Accounts tab
  // disagreed about every account's value. We now compute the full
  // account total (positions priced at quote + cash) and lead with that;
  // the cash sleeve is demoted to a small meta line under the account
  // name. When quotes are missing we still show cash, but mark the
  // total as `cash only` so the user knows the positions weren't
  // valued.
  const accountTotals = useMemo(() => {
    const summary = summarizeByAccount(accounts, transactions, quotes);
    const map = new Map<string, { totalMarketValue: number; positionsMarketValue: number; missingQuotes: number; valueAvailable: boolean }>();
    for (const a of summary.accounts) {
      map.set(a.account.id, {
        totalMarketValue: a.totalMarketValue,
        positionsMarketValue: a.positionsMarketValue,
        missingQuotes: a.missingQuotes.length,
        valueAvailable: a.valueAvailable,
      });
    }
    return map;
  }, [accounts, transactions, quotes]);

  return (
    <fieldset
      className="accounts-manager"
      disabled={writesDisabled}
      style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
    >
      <div className="accounts-toolbar">
        <h2 className="accounts-heading">Accounts <span className="muted accounts-count">{accounts.length}</span></h2>
        <button
          type="button"
          className="accounts-new"
          onClick={() => setAdderOpen((v) => !v)}
          aria-expanded={adderOpen}
        >
          {adderOpen ? <X size={14} /> : <Plus size={14} />}
          {adderOpen ? 'Close' : 'New account'}
        </button>
      </div>

      {adderOpen ? (
        <NewAccountInline
          onSubmit={(payload) => {
            void addAccount(payload)
              .then(() => setAdderOpen(false))
              .catch(() => {});
          }}
          onCancel={() => setAdderOpen(false)}
        />
      ) : null}

      <div className="accounts-grid">
        {accounts.map((a) => {
          const t = accountTotals.get(a.id);
          return (
            <AccountCard
              key={a.id}
              accountId={a.id}
              name={a.name}
              type={a.type ?? ''}
              accountNumber={a.accountNumber ?? ''}
              cash={a.cashBalance}
              totalValue={t?.totalMarketValue ?? a.cashBalance}
              positionsValue={t?.positionsMarketValue ?? 0}
              missingQuoteCount={t?.missingQuotes ?? 0}
              valueAvailable={t?.valueAvailable ?? true}
              currency={a.currency}
              onRename={(patch) => { void renameAccount(a.id, patch).catch(() => {}); }}
              onCash={(v) => { void setCash(a.id, v).catch(() => {}); }}
              onRemove={() => { void removeAccount(a.id).catch(() => {}); }}
            />
          );
        })}
      </div>

      <section className="manual-prices-section">
        <ManualPricesPanel />
      </section>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* New account inline form                                            */
/* ------------------------------------------------------------------ */
function NewAccountInline({
  onSubmit,
  onCancel,
}: {
  onSubmit: (a: { name: string; type?: string; cashBalance?: number; accountNumber?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('Individual');
  const [cash, setCashInput] = useState('');
  const [acctNum, setAcctNum] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      type: type.trim() || undefined,
      cashBalance: cash ? Number(cash) : 0,
      accountNumber: acctNum.trim() || undefined,
    });
  };

  return (
    <form className="accounts-new-form" onSubmit={submit}>
      <div className="accounts-new-grid">
        <label>
          Account name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spouse · Roth IRA" autoFocus />
        </label>
        <label>
          Type
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Individual / Roth IRA / HSA / 529" />
        </label>
        <label>
          Account #
          <input
            value={acctNum}
            onChange={(e) => setAcctNum(e.target.value)}
            placeholder="full or last 4"
            inputMode="numeric"
          />
        </label>
        <label>
          Starting cash
          <input
            value={cash}
            onChange={(e) => setCashInput(e.target.value)}
            inputMode="decimal"
            placeholder="0"
          />
        </label>
      </div>
      <div className="accounts-new-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={!name.trim()}>Add account</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Account card (read-only by default; pencil menu opens edit form)   */
/* ------------------------------------------------------------------ */
function AccountCard(props: {
  accountId: string;
  name: string;
  type: string;
  accountNumber: string;
  cash: number;
  /** Account total = positions priced at last quote + cash sleeve. */
  totalValue: number;
  /** Positions-only market value (excludes cash). */
  positionsValue: number;
  /** Number of held positions whose quote is currently missing. */
  missingQuoteCount: number;
  valueAvailable: boolean;
  currency: string;
  onRename: (patch: { name?: string; type?: string; accountNumber?: string | null }) => void;
  onCash: (cash: number) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape to close the row menu, mirroring the
  // TransactionList row menu so the gesture is consistent across
  // the app.
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

  return (
    <article className={`accounts-card${editing ? ' editing' : ''}`}>
      <header className="accounts-card-header">
        <BrokerBadge name={props.name} />
        <div className="accounts-card-id">
          <div className="accounts-card-name">{props.name}</div>
          <div className="muted accounts-card-meta">
            {props.type ? <span>{props.type}</span> : null}
            {props.accountNumber ? (
              <>
                {props.type ? <span aria-hidden> · </span> : null}
                <span style={{ fontVariantNumeric: 'tabular-nums' }} title={`Account ${props.accountNumber}`}>
                  {maskAccountNumber(props.accountNumber)}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="accounts-card-cash">
          {/* Round 4 (4.A3): lead with the *total* account value so the
           * Accounts tab agrees with the Portfolio tab. Cash sleeve
           * stays on the card as a small secondary line so the user
           * still has at-a-glance visibility into how much of the
           * total is dry powder vs invested. */}
          <div className="muted accounts-card-cash-label">
            Value
          </div>
          <div className="num accounts-card-cash-value">
            {props.valueAvailable ? formatCurrency(props.totalValue, props.currency) : '—'}
          </div>
          {props.cash !== 0 && (props.positionsValue !== 0 || !props.valueAvailable) ? (
            <div className="muted accounts-card-cash-secondary">
              {props.valueAvailable ? `Includes ${formatCurrency(props.cash, props.currency)} cash` : `${formatCurrency(props.cash, props.currency)} cash`}
            </div>
          ) : null}
          {props.missingQuoteCount > 0 ? (
            <div className="muted accounts-card-cash-secondary">
              Price unavailable for {props.missingQuoteCount} {props.missingQuoteCount === 1 ? 'holding' : 'holdings'}, so no total
            </div>
          ) : null}
        </div>
        <div className="accounts-card-menu" ref={menuRef}>
          <button
            type="button"
            className="accounts-card-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Account actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreVertical size={14} />
          </button>
          {menuOpen ? (
            <div className="accounts-card-menu-popover" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); setEditing((v) => !v); }}
              >
                {editing ? 'Done editing' : 'Edit account'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMenuOpen(false);
                  if (window.confirm(`Remove ${props.name}? This cannot be undone.`)) {
                    props.onRemove();
                  }
                }}
              >
                Remove account
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {editing ? (
        <AccountEditFields
          {...props}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </article>
  );
}

/* Inline edit fields. Same controls as the legacy permanent-edit row
 * but only mounted when the user opens the pencil menu. blur-to-save
 * preserves the original keyboard ergonomics. */
function AccountEditFields(props: {
  accountId: string;
  name: string;
  type: string;
  accountNumber: string;
  cash: number;
  onRename: (patch: { name?: string; type?: string; accountNumber?: string | null }) => void;
  onCash: (cash: number) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.name);
  const [type, setType] = useState(props.type);
  const [acctNum, setAcctNum] = useState(props.accountNumber);
  const [cash, setCashLocal] = useState(String(props.cash));

  return (
    <div className="accounts-card-edit">
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== props.name && props.onRename({ name })}
        />
      </label>
      <label>
        Type
        <input
          value={type}
          placeholder="Type"
          onChange={(e) => setType(e.target.value)}
          onBlur={() => type !== props.type && props.onRename({ type })}
        />
      </label>
      <label>
        Account #
        <input
          value={acctNum}
          placeholder="last 4"
          inputMode="numeric"
          onChange={(e) => setAcctNum(e.target.value)}
          onBlur={() => {
            if (acctNum !== props.accountNumber) {
              props.onRename({ accountNumber: acctNum.trim() || null });
            }
          }}
        />
      </label>
      <label>
        Cash
        <input
          value={cash}
          inputMode="decimal"
          onChange={(e) => setCashLocal(e.target.value)}
          onBlur={() => {
            const n = Number(cash);
            if (Number.isFinite(n) && n !== props.cash) props.onCash(n);
          }}
        />
      </label>
      <div className="accounts-card-edit-actions">
        <button type="button" className="ghost" onClick={props.onClose}>
          <ChevronDown size={12} /> Done
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Brokerage badge                                                     */
/* ------------------------------------------------------------------ */
/**
 * 28x28 rounded square with the brokerage's first letter and a
 * deterministic colour seeded by the account name. We don't ship
 * brokerage logo image assets (CORS, licensing, broken-link risk),
 * so a stylised initial gives the same scannability without bringing
 * in a static-asset pipeline. Round 3 (3.C4 light version).
 */
function BrokerBadge({ name }: { name: string }) {
  // Try to detect the brokerage substring (Fidelity / Schwab / Citi /
  // Microsoft / Vanguard ...). Falls back to the first letter of the
  // account name.
  const lower = name.toLowerCase();
  const known: { match: string; label: string; tone: string }[] = [
    { match: 'fidelity', label: 'F', tone: '#115e57' },
    { match: 'schwab', label: 'S', tone: '#184e6e' },
    { match: 'citi', label: 'C', tone: '#1d447a' },
    { match: 'vanguard', label: 'V', tone: '#782930' },
    { match: 'merrill', label: 'M', tone: '#1d3a66' },
    { match: 'microsoft', label: 'M', tone: '#165369' },
    { match: 'robinhood', label: 'R', tone: '#125c4b' },
    { match: 'coinbase', label: 'C', tone: '#1d467d' },
    { match: 'wealthfront', label: 'W', tone: '#11635c' },
    { match: 'apple', label: 'A', tone: '#334155' },
    { match: 'goldman', label: 'G', tone: '#6b4d18' },
    { match: 'alex', label: 'A', tone: '#174c69' },
    { match: 'casey', label: 'C', tone: '#733f28' },
    { match: 'household', label: 'H', tone: '#115e57' },
    { match: 'joint', label: 'J', tone: '#6b4d18' },
  ];
  const hit = known.find((k) => lower.includes(k.match));
  const initial = hit?.label ?? (name.trim().charAt(0).toUpperCase() || '?');
  const tone = hit?.tone ?? colorFromName(name);
  return (
    <div
      className="broker-badge"
      title={hit?.match ? hit.match.charAt(0).toUpperCase() + hit.match.slice(1) : undefined}
      style={{ background: tone }}
      aria-hidden
    >
      {initial}
    </div>
  );
}

/* Deterministic badge color from a curated dark-harmonious muted jewel palette. */
const BADGE_PALETTE = [
  '#115e57', // Evergreen
  '#174c69', // Slate Sky
  '#733f28', // Muted Terracotta
  '#6b4d18', // Bullion Bronze
  '#1d447a', // Deep Navy Blue
  '#125c4b', // Deep Pine
  '#343c6e', // Muted Indigo
  '#6b2b40', // Muted Burgundy
];

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return BADGE_PALETTE[Math.abs(hash) % BADGE_PALETTE.length];
}
