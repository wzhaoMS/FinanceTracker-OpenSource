/**
 * Opening Manage cards from anywhere on the Spending page (contract C-2): `openCardManager()` dispatches the window
 * event `holdr:open-card-manager`, and the Card picker (SpendingCardPicker.tsx) listens for it, opens Manage cards and
 * moves focus into it. A part of the page that names cards whose history stops (the months' missing history) calls it.
 */

export const OPEN_CARD_MANAGER_EVENT = 'holdr:open-card-manager';

/** Opens Manage cards, with focus in it. Nothing happens while no Card picker is on the page. */
export function openCardManager(): void {
  window.dispatchEvent(new Event(OPEN_CARD_MANAGER_EVENT));
}

/** Calls `listener` on each `openCardManager()`; returns what stops it. */
export function onOpenCardManager(listener: () => void): () => void {
  window.addEventListener(OPEN_CARD_MANAGER_EVENT, listener);
  return () => window.removeEventListener(OPEN_CARD_MANAGER_EVENT, listener);
}
