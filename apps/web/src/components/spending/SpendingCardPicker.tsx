import { useEffect, useId, useState } from 'react';
import type { CardAccount } from '@finance-tracker/shared';

import { CardManager } from './CardManager';
import { onOpenCardManager } from './cardManagerEvents';
import { cardOptionLabel } from './spendingFormat';

interface Props {
  accounts: CardAccount[];
  value: string;
  onChange: (id: string) => void;
  /** Each card status change the owner confirmed in Manage cards (contract C-1: the tab reads its figures again). */
  onUpdated: (account: CardAccount) => void;
  writesDisabled: boolean;
}

/** The toolbar's phone layout (styles.css): its filters are one row that scrolls sideways. */
const PHONE_TOOLBAR = '(max-width: 720px)';

function usePhoneToolbar(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_TOOLBAR).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_TOOLBAR);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

/**
 * The Card picker, with Manage cards always beside it (CardManager.tsx), and closed cards listed only once "Show closed
 * cards" is on. On a phone, Manage cards comes before the picker, so it shows in full at the start of the sideways row
 * of filters; elsewhere it follows the picker. Anything on the page can open Manage cards with `openCardManager()`
 * (cardManagerEvents.ts, contract C-2).
 */
export function SpendingCardPicker({ accounts, value, onChange, onUpdated, writesDisabled }: Props) {
  const selectId = useId();
  const phone = usePhoneToolbar();
  const [showClosed, setShowClosed] = useState(false);
  const [managing, setManaging] = useState(false);
  /** Bumped by each `openCardManager()`: focus moves into Manage cards, open or not. */
  const [focusRequest, setFocusRequest] = useState(0);
  const closed = accounts.filter((account) => account.status === 'closed');
  const selected = accounts.find((account) => account.id === value);

  useEffect(() => onOpenCardManager(() => {
    setManaging(true);
    setFocusRequest((request) => request + 1);
  }), []);

  const manage = (
    <button key="manage" type="button" className="spending-button card-picker-manage" aria-haspopup="dialog" onClick={() => setManaging(true)}>
      Manage cards
    </button>
  );
  const picker = (
    <label key="picker" className="spending-select">
      <span>Card</span>
      <select id={selectId} aria-label="Card" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All cards</option>
        {accounts.filter((account) => account.status === 'active').map((account) => (
          <option key={account.id} value={account.id}>{cardOptionLabel(account)}</option>
        ))}
        {/* Hiding closed cards must never silently change the current transaction filter. */}
        {!showClosed && selected?.status === 'closed' ? (
          <option value={selected.id}>{cardOptionLabel(selected)}</option>
        ) : null}
        {showClosed && closed.length > 0 ? (
          <optgroup label={`Closed (${closed.length})`}>
            {closed.map((account) => <option key={account.id} value={account.id}>{cardOptionLabel(account)}</option>)}
          </optgroup>
        ) : null}
      </select>
    </label>
  );

  return (
    <>
      {/* One keyed pair, reordered across the phone breakpoint: React moves the same button, so a dialog opened from it
          still returns focus to it on close. */}
      {phone ? [manage, picker] : [picker, manage]}
      {closed.length > 0 ? (
        <label className="spending-toggle">
          <input type="checkbox" checked={showClosed} aria-controls={selectId} onChange={(event) => setShowClosed(event.target.checked)} />
          <span>{`Show closed cards (${closed.length})`}</span>
        </label>
      ) : null}
      {managing ? (
        <CardManager accounts={accounts} writesDisabled={writesDisabled} onUpdated={onUpdated} onClose={() => setManaging(false)}
          focusRequest={focusRequest} />
      ) : null}
    </>
  );
}
