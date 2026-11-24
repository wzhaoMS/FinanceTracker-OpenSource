import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether an element is laid out on screen: false while an ancestor hides it (`display: none`, as when another UI mode
 * keeps the Spending tab mounted but hidden) or it is scrolled wholly out of view. Without IntersectionObserver it is
 * always true, so nothing that depends on it stops for good.
 */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setOnScreen(latest.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}
