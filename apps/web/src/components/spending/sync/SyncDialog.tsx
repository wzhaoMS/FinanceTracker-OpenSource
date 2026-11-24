import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from '../../icons';
import './sync.css';

interface Props {
  title: string;
  onClose: () => void;
  /** While true, Escape, the backdrop and the close button do nothing. */
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
  closeLabel?: string;
}

/** Open dialogs, innermost last: only the innermost one answers Escape and Tab. */
const openDialogs: Array<{ token: symbol; element: () => HTMLElement | null }> = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const usable = (element: HTMLElement | null): element is HTMLElement => element !== null && element.isConnected
  && !(element as HTMLElement & { disabled?: boolean }).disabled && element.closest('[inert]') === null;

/**
 * A modal panel in the Spending tab's style: a drawer on the desktop, full
 * screen on a phone. Focus moves into it and stays inside it: Tab wraps, focus
 * that ended up outside (a control disabled while busy) comes back, and with
 * nothing to focus the panel itself keeps it. On close, focus returns where it
 * was, or to the dialog underneath when that control is gone or disabled.
 */
export function SyncDialog({ title, onClose, busy = false, wide = false, children, closeLabel = 'Close' }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = Symbol('dialog');
    openDialogs.push({ token, element: () => ref.current });
    ref.current?.focus();
    const innermost = () => openDialogs[openDialogs.length - 1]?.token === token;
    const onKey = (event: KeyboardEvent) => {
      if (!innermost()) return;
      if (event.key === 'Escape' && !busyRef.current) {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      const dialog = ref.current;
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
      const active = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!(active instanceof Node) || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const dialog = ref.current;
      if (!innermost() || !dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      dialog.focus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      openDialogs.splice(openDialogs.findIndex((entry) => entry.token === token), 1);
      // Back where it was, unless that is gone, disabled, or outside the dialog still open underneath.
      const below = openDialogs[openDialogs.length - 1]?.element() ?? null;
      if (usable(previous) && (below === null || below.contains(previous))) previous.focus();
      else below?.focus();
    };
  }, []);

  return (
    <div className="spending-detail-backdrop" onClick={() => { if (!busyRef.current) onClose(); }}>
      <div
        ref={ref}
        className={`spending-detail sync-dialog${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="spending-detail-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="spending-icon-button" aria-label={closeLabel} disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
