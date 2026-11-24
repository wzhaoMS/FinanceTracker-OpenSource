import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { MODES, MODE_LABELS, type Mode } from '../modes/route';
import { TrendUp } from './icons';

interface Props {
  mode: Mode;
  onChange: (mode: Mode) => void;
}

const HINTS: Record<Mode, string> = {
  investing: 'Portfolio, trades, brokerage cash and accounts',
  everyday: 'Card spending, review and the browser extension',
};

/** A card, for Everyday: kept here so the shared icon set stays as it is. */
function CardIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3 10h18" />
      <path d="M7 14.5h3" />
    </svg>
  );
}

/**
 * Investing | Everyday, beside the wordmark. A radio group: one tab stop,
 * arrow keys (and Home/End) move the choice, as in any set of radio buttons.
 * The thumb slides under the chosen mode; reduced motion stops the slide.
 */
export function ModeSwitch({ mode, onChange }: Props) {
  const refs = useRef(new Map<Mode, HTMLButtonElement>());
  const shown = useRef<Mode | null>(null);
  /** The mode this switch asked for last, until it shows: a change to anything else came from elsewhere. */
  const chosen = useRef<Mode | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const choose = (next: Mode) => {
    if (next === mode) return;
    chosen.current = next;
    onChange(next);
  };

  // The radios announce a change made with them. A change from elsewhere (back/forward, a link,
  // Investing's Spending entry) is said here, so a screen reader hears which mode it is now in;
  // if focus was still on the switch, it moves to the radio that is now checked.
  useEffect(() => {
    const before = shown.current;
    shown.current = mode;
    if (before === null || before === mode) return undefined;
    if (chosen.current === mode) {
      chosen.current = null;
      return undefined;
    }
    chosen.current = null;
    const checked = refs.current.get(mode);
    if (checked && checked.parentElement?.contains(document.activeElement)) checked.focus();
    setAnnouncement('');
    const timer = window.setTimeout(() => setAnnouncement(`${MODE_LABELS[mode]} mode`), 60);
    return () => window.clearTimeout(timer);
  }, [mode]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = MODES.indexOf(mode);
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MODES.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + MODES.length - 1) % MODES.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = MODES.length - 1;
    if (next === null) return;
    event.preventDefault();
    choose(MODES[next]);
    refs.current.get(MODES[next])?.focus();
  };

  return (
    <>
      <div className="mode-switch" role="radiogroup" aria-label="Mode" data-active={mode}>
        <span className="mode-switch-thumb" aria-hidden />
        {MODES.map((item) => (
          <button
            key={item}
            ref={(element) => { if (element) refs.current.set(item, element); else refs.current.delete(item); }}
            type="button"
            role="radio"
            aria-checked={mode === item}
            tabIndex={mode === item ? 0 : -1}
            className={`mode-switch-option${mode === item ? ' active' : ''}`}
            data-mode-option={item}
            title={HINTS[item]}
            onClick={() => choose(item)}
            onKeyDown={onKeyDown}
          >
            {item === 'investing' ? <TrendUp size={15} strokeWidth={1.8} /> : <CardIcon />}
            <span>{MODE_LABELS[item]}</span>
          </button>
        ))}
      </div>
      {/* aria-live without the status role, so pages that have a status region keep only theirs. */}
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
    </>
  );
}
