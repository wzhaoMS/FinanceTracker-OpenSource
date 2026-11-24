import { api } from './api';
import { onPageRetired, retirePage } from './browserCache';

const historyCache = new Map<string, Promise<unknown>>();

export function getCachedSymbolHistory<T>(symbol: string, range: string): Promise<T> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedRange = range.trim().toUpperCase();
  const key = `${normalizedSymbol}:${normalizedRange}`;
  let existing = historyCache.get(key) as Promise<T> | undefined;
  if (!existing) {
    existing = api<T>(`/symbols/${encodeURIComponent(normalizedSymbol)}/history?range=${encodeURIComponent(normalizedRange)}`)
      .catch((err) => {
        historyCache.delete(key);
        throw err;
      });
    historyCache.set(key, existing);
  }
  return existing;
}

export function clearSymbolHistoryCache(): void {
  historyCache.clear();
}

onPageRetired(() => historyCache.clear());

/** This module's hot-update dispose: retires the page (this cache included) before anything else. */
export function retireSymbolHistoryModule(): void {
  retirePage();
  historyCache.clear();
}

// Never hot-swapped (apps/web/hmrReload.ts): this cache of server data is cleared on sign-out, which
// only reaches the copy the auth store imported. An update retires the page and reloads it instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => retireSymbolHistoryModule());
  import.meta.hot.accept(() => window.location.reload());
}
