import { useEffect, useId, useLayoutEffect, useRef } from 'react';

import type { InvestingTab } from '../modes/route';

/** Investing's tabs. "Spending" keeps its place but opens Everyday, where card spending lives now. */
const ORDER = ['portfolio', 'gold', 'transactions', 'spending', 'add', 'import', 'accounts'] as const;

type Tab = typeof ORDER[number];

interface Props {
  value: InvestingTab;
  onChange: (tab: InvestingTab) => void;
  onOpenSpending: () => void;
}

/**
 * Top-level navigation with a 1px sliding underline. Round 3 (3.B3).
 *
 * The previous tab styling was a 2px solid purple border-bottom on
 * `.tab.active` with a `transition: border-color 0.12s` — i.e. it
 * snapped from one tab to the next and the underline thickness read
 * as a 2018 default-shadcn dark theme. The new behavior:
 *
 *   - the active underline is a single `<span class="tab-indicator">`
 *     positioned absolutely beneath the `<nav>`. Its left/width are
 *     driven by CSS custom properties (`--tab-x`, `--tab-w`) that we
 *     measure in `useLayoutEffect` whenever the active tab changes
 *     or the window resizes. Switching tabs gives the Linear / Vercel
 *     "indicator slides" feel without committing to a heavyweight
 *     React-router transition library.
 *   - per-tab `border-bottom` is gone; the indicator does the work.
 *   - `prefers-reduced-motion` honored via the CSS rule on
 *     `.tab-indicator` (no transition).
 */
export function Tabs({ value, onChange, onOpenSpending }: Props) {
  const navRef = useRef<HTMLElement | null>(null);
  const buttonsRef = useRef<Map<Tab, HTMLButtonElement>>(new Map());
  const elsewhereId = useId();

  // Position the indicator under the active tab. useLayoutEffect so the
  // first paint already shows the indicator at the right spot — no
  // visible "snap from 0 to active" on mount.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const btn = buttonsRef.current.get(value);
    if (!nav || !btn) return;
    nav.style.setProperty('--tab-x', `${btn.offsetLeft}px`);
    nav.style.setProperty('--tab-w', `${btn.offsetWidth}px`);
  }, [value]);

  // Re-measure on window resize. The layout is flex-wrap so a narrow
  // viewport can re-flow the row and the indicator needs to follow.
  useEffect(() => {
    const onResize = () => {
      const nav = navRef.current;
      const btn = buttonsRef.current.get(value);
      if (!nav || !btn) return;
      nav.style.setProperty('--tab-x', `${btn.offsetLeft}px`);
      nav.style.setProperty('--tab-w', `${btn.offsetWidth}px`);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [value]);

  return (
    <nav
      ref={navRef}
      className="tabs"
      role="tablist"
      aria-label="Sections"
    >
      {ORDER.map((t) => (t === 'spending' ? (
        <button
          key={t}
          className="tab tab-elsewhere"
          onClick={onOpenSpending}
          role="tab"
          aria-selected={false}
          aria-describedby={elsewhereId}
          title="Switches to Everyday, where card spending is now"
        >
          Spending
          <svg className="tab-elsewhere-icon" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 17 17 7" />
            <path d="M8 7h9v9" />
          </svg>
        </button>
      ) : (
        <button
          key={t}
          ref={(el) => {
            if (el) buttonsRef.current.set(t, el);
            else buttonsRef.current.delete(t);
          }}
          className={`tab ${value === t ? 'active' : ''}`}
          onClick={() => onChange(t)}
          role="tab"
          aria-selected={value === t}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      )))}
      {/* Hidden, so not a child of the tab list for assistive technology; still read as the entry's description. */}
      <span id={elsewhereId} hidden>Switches to Everyday</span>
      <span className="tab-indicator" aria-hidden />
    </nav>
  );
}
