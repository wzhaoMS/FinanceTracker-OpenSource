import { useLayoutEffect, useRef, useState } from 'react';

/**
 * How long figures stay marked as updating after the new ones land: even a 50 ms read shows one brief, steady signal.
 * A little over the 300 ms asked for, so the marks never leave before it, whatever the timer's slack.
 */
export const UPDATING_HOLD_MS = 320;

/**
 * Whether figures on screen are marked as updating: at once while `retained` (the same view is being read again and its
 * last answer is still shown), and for UPDATING_HOLD_MS after the new figures land, so no number ever changes unmarked.
 * The hold starts in a layout effect, before the browser paints the swap, so no frame shows new figures without the
 * mark. A read that failed (`failed`) is not held: its error says what happened. Another `view` clears the mark at
 * once: a new view shows no earlier figures.
 */
export function useUpdatingMark(retained: boolean, options: { view?: string; failed?: boolean } = {}): boolean {
  const [held, setHeld] = useState(false);
  const wasRetained = useRef(retained);
  const shownView = useRef(options.view);
  const failed = Boolean(options.failed);
  useLayoutEffect(() => {
    if (shownView.current !== options.view) {
      shownView.current = options.view;
      wasRetained.current = retained;
      setHeld(false);
      return undefined;
    }
    if (retained) {
      wasRetained.current = true;
      return undefined;
    }
    if (!wasRetained.current) return undefined;
    wasRetained.current = false;
    if (failed) {
      setHeld(false);
      return undefined;
    }
    setHeld(true);
    const timer = setTimeout(() => setHeld(false), UPDATING_HOLD_MS);
    return () => clearTimeout(timer);
  }, [retained, options.view, failed]);
  return retained || held;
}
