import { useRef, type KeyboardEvent } from 'react';
import { plural } from './syncFormat';
import type { OwnerSync } from './useOwnerSync';
import './sync.css';

export type SpendingArea = 'transactions' | 'benefits' | 'amazon' | 'costco' | 'sync' | 'devices';

const AREAS: Array<{ id: SpendingArea; label: string }> = [
  { id: 'transactions', label: 'Card transactions' },
  { id: 'benefits', label: 'Benefits' },
  { id: 'amazon', label: 'Amazon' },
  { id: 'costco', label: 'Costco receipts' },
  { id: 'sync', label: 'Sync & coverage' },
  { id: 'devices', label: 'Extension & devices' },
];

export const AREA_PANEL_ID = 'spending-area-panel';
export const areaTabId = (area: SpendingArea) => `spending-area-${area}`;

/**
 * The Spending tab's areas (plan §8: no second top-level tab). Arrow
 * keys move between them, as in any tab list. "Sync & coverage" carries how
 * many imports await review.
 */
export function SpendingAreaTabs({ area, onArea, sync }: { area: SpendingArea; onArea: (area: SpendingArea) => void; sync: OwnerSync }) {
  const refs = useRef(new Map<SpendingArea, HTMLButtonElement>());
  const waiting = sync.state?.queue.open ?? 0;
  const attention = sync.state ? sync.state.settings.paused || sync.state.gate === 'blocked' || sync.state.bindings.some((binding) => binding.status === 'needs-reconfirmation') : false;

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = AREAS.findIndex((item) => item.id === area);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % AREAS.length;
    if (event.key === 'ArrowLeft') next = (index + AREAS.length - 1) % AREAS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = AREAS.length - 1;
    if (next === null) return;
    event.preventDefault();
    onArea(AREAS[next].id);
    refs.current.get(AREAS[next].id)?.focus();
  };

  return (
    <div className="spending-areas" role="tablist" aria-label="Spending areas">
      {AREAS.map((item) => (
        <button
          key={item.id}
          ref={(element) => { if (element) refs.current.set(item.id, element); else refs.current.delete(item.id); }}
          id={areaTabId(item.id)}
          type="button"
          role="tab"
          aria-selected={area === item.id}
          aria-controls={AREA_PANEL_ID}
          tabIndex={area === item.id ? 0 : -1}
          className={`spending-area-tab${area === item.id ? ' active' : ''}`}
          onClick={() => onArea(item.id)}
          onKeyDown={onKey}
        >
          {item.label}
          {item.id === 'sync' && waiting > 0 ? (
            <span className="spending-area-badge"><span aria-hidden>{waiting}</span><span className="visually-hidden">, {plural(waiting, 'import')} awaiting review</span></span>
          ) : null}
          {item.id === 'devices' && attention ? (
            <span className="spending-area-dot"><span className="visually-hidden">, needs attention</span></span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** In the transactions area: the imports awaiting review, so they are never mistaken for spending. */
export function SyncWaitingNotice({ sync, onOpen }: { sync: OwnerSync; onOpen: () => void }) {
  const state = sync.state;
  if (!state || state.queue.open === 0) return null;
  const soon = state.queue.expiringWithin7Days;
  return (
    <div className="sync-banner tone-info sync-waiting" role="status">
      <strong>
        {plural(state.queue.open, 'import')} {state.queue.open === 1 ? 'is' : 'are'} awaiting review and not in these figures.
      </strong>
      <span>
        {soon > 0 ? `${soon} ${soon === 1 ? 'expires' : 'expire'} within a week. ` : ''}
        <button type="button" className="spending-link inline" onClick={onOpen}>Review them</button>
      </span>
    </div>
  );
}
