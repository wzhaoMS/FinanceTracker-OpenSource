import { useId, useState, type ReactNode } from 'react';

import { ChevronRight } from './icons';

/**
 * The app's one way to fold content away (Benefits now; Everyday's notes next): a toggle that says what is folded and
 * how much ("Without it in 2026: 12 of 20 compared cards"), and the content under it, rendered only while open, so a
 * long list costs nothing until asked for. The toggle is a button with aria-expanded, and aria-controls while its
 * content exists; Enter and Space work as on any button. The open state is the component's own, starting at
 * `defaultOpen`, unless `open` is given, in which case `onOpenChange` drives it (a caller that must open it from
 * elsewhere, a reminder's link say).
 */
export function Disclosure({ summary, children, defaultOpen = false, open, onOpenChange, className, label }: {
  /** What is folded away, said on the toggle. */
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled: the caller keeps the state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** The toggle's accessible name, when the summary alone would not say what it opens. */
  label?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const contentId = useId();
  const toggle = () => {
    setOwn(!isOpen);
    onOpenChange?.(!isOpen);
  };
  return (
    <div className={className ? `fold ${className}` : 'fold'} data-open={isOpen}>
      <button
        type="button"
        className="fold-toggle"
        aria-expanded={isOpen}
        aria-controls={isOpen ? contentId : undefined}
        aria-label={label}
        onClick={toggle}
      >
        <ChevronRight size={14} className="fold-chevron" />
        <span className="fold-summary">{summary}</span>
      </button>
      {isOpen ? <div id={contentId} className="fold-content">{children}</div> : null}
    </div>
  );
}

/** Lists this long or shorter stay open; longer ones fold behind their count until asked for. */
export const FOLD_AFTER = 3;
