import type { ReactNode } from 'react';

/**
 * A read in progress: a small ring that turns, in place of what is being read or beside what is being read again.
 * The ring is hidden from screen readers; its label, visually hidden, is what they say, once, where the ring is. It is
 * never a live region, so a page of spinners is not read out all at once. It shows at once; `deferred` (only where
 * nothing is shown yet, a first read) waits a moment first, so a quick first read never flickers.
 */
export function Spinner({ label, testId, className, deferred = false }: {
  label: string;
  testId?: string;
  className?: string;
  deferred?: boolean;
}) {
  const classes = ['spinner', deferred ? 'deferred' : null, className ?? null].filter(Boolean).join(' ');
  return (
    <span className={classes} data-testid={testId}>
      <span className="spinner-ring" aria-hidden="true" />
      <span className="spinner-label visually-hidden">{label}</span>
    </span>
  );
}

/**
 * A panel's or block's heading (`children`, the heading element itself) and, while what it heads is read again, a
 * spinner beside it, outside the heading: the heading keeps its own name, and the spinner says the state.
 */
export function TitleWithSpinner({ children, busy, label = 'Updating', testId, deferred = false }: {
  children: ReactNode;
  busy: boolean;
  label?: string;
  testId?: string;
  /** Nothing is shown yet (a first read): the spinner may wait a moment. Never for figures already on screen. */
  deferred?: boolean;
}) {
  return (
    <div className="panel-title">
      {children}
      {busy ? <Spinner label={label} testId={testId} deferred={deferred} /> : null}
    </div>
  );
}
