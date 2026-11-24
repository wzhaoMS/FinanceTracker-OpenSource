import { useEffect, useState } from 'react';

/**
 * Persist a Portfolio-tab UI preference to localStorage. Tiny wrapper around
 * useState so component code doesn't repeat the same try/catch dance.
 */
export function usePortfolioPref<T extends string>(
  key: string,
  initial: T,
  isValid: (v: unknown) => v is T,
): [T, (v: T) => void] {
  const storageKey = `finance-tracker:pref:${key}`;
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw && isValid(raw)) return raw;
    } catch {
      /* ignore */
    }
    return initial;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, value);
    } catch {
      /* ignore */
    }
  }, [storageKey, value]);
  return [value, setValue];
}

export type DayChangeMode = 'absolute' | 'percent';
export const isDayChangeMode = (v: unknown): v is DayChangeMode =>
  v === 'absolute' || v === 'percent';

/**
 * Whether the overnight/weekend indicative prices are folded into the
 * Invested-Holdings + Household-value math. Off by default. This is a
 * display-only preference: it never changes server data, cost basis, or
 * snapshots, and it auto-no-ops during market hours (the server only
 * attaches indicative prices while official data is stale).
 */
export type IndicativeMode = 'on' | 'off';
export const isIndicativeMode = (v: unknown): v is IndicativeMode =>
  v === 'on' || v === 'off';
