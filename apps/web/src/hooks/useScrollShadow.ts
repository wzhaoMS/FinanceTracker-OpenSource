import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Track horizontal scroll position of a scroll container so a sticky-column
 * drop-shadow can fade in only when the content has actually slid underneath.
 *
 * Why this exists:
 *
 *   At rest (`scrollLeft === 0`), the sticky symbol column sits flush against
 *   the next column. A hairline shadow makes the join read like a column
 *   boundary, not an overlay, so the user sees "QUANTITY" half-visible next
 *   to "GOOGL" and reads it as misalignment (see mobile-ui-audit-2026-05-08
 *   §1, post-ship report).
 *
 *   The standard fix (Bloomberg, Google Sheets, Apple Numbers) is a real
 *   drop-shadow on the sticky cell, faded in only when scrolled-right and
 *   faded back out when scrolled to the start. That signals depth.
 *
 * `IntersectionObserver` would be lighter than scroll listeners, but it
 * doesn't tell us "are we at scrollLeft=0" cleanly across browsers, so
 * we just use a passive scroll listener — fires at most once per frame on
 * mobile Safari and Chrome.
 *
 * Returns:
 *   ref     — attach to the scroll container.
 *   scrolled — true when scrollLeft > 0 (some right-scroll has happened).
 *   atEnd   — true when the user has scrolled to the right edge.
 *             Useful if a future caller wants to fade out the right-edge
 *             gradient too. Currently unused but cheap to compute.
 */
export function useScrollShadow<T extends HTMLElement = HTMLDivElement>(): {
  ref: RefObject<T | null>;
  scrolled: boolean;
  atEnd: boolean;
} {
  const ref = useRef<T | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      // 2px deadband: avoids flicker on subpixel rounding.
      setScrolled(el.scrollLeft > 2);
      setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
    };

    update();
    el.addEventListener('scroll', update, { passive: true });
    // Recompute on resize because clientWidth/scrollWidth change.
    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  return { ref, scrolled, atEnd };
}
