import { formatShownAmount, formatShownPercent } from '@finance-tracker/shared';
import type { QuoteSession } from '@finance-tracker/shared';
import { dayChangeNote } from './dayChangeNote';
import { RollingNumber } from './RollingNumber';
import { withTone } from './tone';
import type { DayChangeMode } from '../hooks/usePortfolioPref';

interface Props {
  changeBasis?: 'previousClose' | '24h' | 'provider' | 'open';
  dayChange?: number;
  dayChangePercent?: number;
  mode: DayChangeMode;
  currency?: string;
  /** Active US session, used to tag pre-market / after-hours changes. */
  session?: QuoteSession;
}

/**
 * A holding's day change, with what it is measured over written under it when that is not the regular session
 * against the prior close (never only in a tooltip; `dayChangeNote`, the ticker's rule too). Renders `—` with a hidden
 * reason when the change cannot be shown (callers pass `dayChangeDisplayBasis()` output as `changeBasis`).
 *
 * Animation: the value uses RollingNumber so live ticks roll the digits. `flash` is off: the text is already
 * gain/loss coloured, and a green/red background would clash (D.2 self-review #2).
 */
export function DayChangeCell({
  changeBasis,
  dayChange,
  dayChangePercent,
  mode,
  currency = 'USD',
  session,
}: Props) {
  if (!changeBasis || dayChange == null || dayChangePercent == null) {
    return (
      <span className="muted">
        <span aria-hidden>—</span>
        <span className="visually-hidden">No day change</span>
      </span>
    );
  }
  // The tone follows the value shown: a change that reads zero ("$0.00", "0.00%") is unsigned and in neither colour.
  const value = mode === 'percent' ? dayChangePercent : dayChange;
  const shown = mode === 'percent'
    ? (v: number) => formatShownPercent(v, { signed: true })
    : (v: number) => formatShownAmount(v, { currency, signed: true });
  const note = dayChangeNote({ changeBasis, session });
  return (
    <span className={withTone('day-change', shown(value).tone)}>
      <RollingNumber value={value} format={(v) => shown(v).text} flash={false} />
      {note ? <span className="day-change-note">{note.text}</span> : null}
    </span>
  );
}
