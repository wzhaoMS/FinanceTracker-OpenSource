import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

/**
 * Robinhood-style odometer. Each digit slot rotates in/out independently
 * when the value changes (positive → roll up, negative → roll down),
 * with an optional color flash on the background.
 *
 * Per OQ5: animates on first mount too. The "previous" value is synthesized
 * as the same string with all digits replaced by '0', so every digit rolls
 * in the first time the component appears.
 *
 * Caveats / rules:
 *   - Non-digit characters ($, comma, period, minus) never animate.
 *   - When the formatted string length changes (e.g. $99.99 → $100.00), we
 *     do an instant swap; per-position animation requires equal lengths.
 *   - `prefers-reduced-motion: reduce` collapses the animation to a hard swap.
 *   - `flash` defaults to true. Pass false in cells whose surrounding text is
 *     already gain/loss colored (the background tint clashes with red/green
 *     text). The component's text color is always inherited; flash only
 *     affects the wrapper background.
 *   - If a new value lands mid-animation, the old animation is abandoned and
 *     a fresh one starts from the current displayed value (React's `key` on
 *     the wrapper forces a remount of the slots).
 */
export interface RollingNumberProps {
  value: number;
  format: (v: number) => string;
  /** Whether to background-flash green/red on change. Default true. */
  flash?: boolean;
  /** Animation duration in ms. Default 350 (matches Robinhood-ish). */
  durationMs?: number;
  /** Class on the outer span. Inherits font/color from the parent. */
  className?: string;
  /** Force the static (non-animated) render. Useful when another UI state
   *  takes over the headline (e.g. the chart crosshair shows hovered point). */
  freeze?: boolean;
}

export function RollingNumber({
  value,
  format,
  flash = true,
  durationMs = 350,
  className,
  freeze = false,
}: RollingNumberProps) {
  const formatted = format(value);
  const prevValueRef = useRef<number | null>(null);
  const prevFormattedRef = useRef<string>('');
  // `tick` rotates a key on the wrapper so each animation cycle remounts
  // the slot DOM — that's how we cleanly cancel a mid-animation interrupt.
  const [tick, setTick] = useState(0);
  const [from, setFrom] = useState<string>('');
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (freeze) return;
    const isFirst = prevValueRef.current === null;
    const fromStr = isFirst ? formatted.replace(/\d/g, '0') : prevFormattedRef.current;
    const toStr = formatted;
    if (fromStr === toStr) {
      // Nothing to animate; commit so the next genuine change has a baseline.
      // Safe to commit here because no in-flight animation depends on the refs.
      prevValueRef.current = value;
      prevFormattedRef.current = toStr;
      return;
    }
    if (reduced) {
      // Reduced motion: hard swap, commit immediately.
      prevValueRef.current = value;
      prevFormattedRef.current = toStr;
      return;
    }
    const dir: 'up' | 'down' = isFirst
      ? 'up'
      : value >= (prevValueRef.current ?? 0)
        ? 'up'
        : 'down';
    setFrom(fromStr);
    setDirection(dir);
    setTick((t) => t + 1);
    // Critical: do NOT commit refs in the effect body. React 19 StrictMode
    // runs effects twice in dev (setup → cleanup → setup), and committing
    // the refs in the first run would make the second run short-circuit
    // (fromStr === toStr) and never schedule the cleanup-canceled animation.
    // Commit only when the animation completes.
    const id = window.setTimeout(() => {
      prevValueRef.current = value;
      prevFormattedRef.current = toStr;
      setFrom('');
    }, durationMs + 50);
    return () => window.clearTimeout(id);
  }, [formatted, value, freeze, reduced, durationMs]);

  // Static render: used when reduced motion, when freeze is on, or between animations.
  if (freeze || reduced || !from || from.length !== formatted.length || from === formatted) {
    return <span className={className}>{formatted}</span>;
  }

  const flashClass = flash ? (direction === 'up' ? 'rolling-flash-up' : 'rolling-flash-down') : '';
  return (
    <span
      // eslint-disable-next-line react/no-array-index-key -- tick + index uniquely identifies a slot per cycle
      key={tick}
      className={[className, 'rolling-number', flashClass].filter(Boolean).join(' ')}
    >
      {Array.from(formatted).map((ch, i) => {
        const fromCh = from[i];
        if (ch === fromCh || !isDigit(ch) || !isDigit(fromCh)) {
          return (
            <span key={`s-${i}`} className="rolling-static">
              {ch}
            </span>
          );
        }
        return (
          <RollingDigit
            key={`d-${i}`}
            fromCh={fromCh}
            toCh={ch}
            direction={direction}
            durationMs={durationMs}
          />
        );
      })}
    </span>
  );
}

function RollingDigit({
  fromCh,
  toCh,
  direction,
  durationMs,
}: {
  fromCh: string;
  toCh: string;
  direction: 'up' | 'down';
  durationMs: number;
}) {
  // We render the reel in both phases of layout: 'start' positions the old
  // digit visible, 'end' positions the new digit visible. The transition
  // between them is what the user sees as a roll.
  const [phase, setPhase] = useState<'start' | 'end'>('start');
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setPhase('end'));
    return () => cancelAnimationFrame(id);
  }, []);

  // Reel order depends on direction:
  //   up   = old on top, new below; reel translates UP so new appears.
  //   down = new on top, old below; reel translates DOWN so new appears.
  const top = direction === 'up' ? fromCh : toCh;
  const bottom = direction === 'up' ? toCh : fromCh;
  const startTransform = direction === 'up' ? 'translateY(0)' : 'translateY(-1em)';
  const endTransform = direction === 'up' ? 'translateY(-1em)' : 'translateY(0)';
  const reelStyle: CSSProperties = {
    transform: phase === 'start' ? startTransform : endTransform,
    transition: `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
  };
  return (
    <span className="rolling-slot" aria-hidden="true">
      <span className="rolling-reel" style={reelStyle}>
        <span>{top}</span>
        <span>{bottom}</span>
      </span>
    </span>
  );
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function usePrefersReducedMotion(): boolean {
  const [pref, setPref] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setPref(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return pref;
}
