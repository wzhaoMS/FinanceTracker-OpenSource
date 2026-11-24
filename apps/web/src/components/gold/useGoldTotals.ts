import { fetchMetalsOverview, fetchMetalsPurchases, type GoldPeriod, type Metal } from './goldApi';
import { totalsReadsPurchases, type GoldTotalsInput } from './goldTotals';
import { useGoldRead, type GoldRead } from './useGoldRead';

/**
 * The totals' reads: each metal's overview over all recorded history to `today`, one as-of day for all of them, and,
 * whenever its estimate can stand (values show, or it needs no price: totalsReadsPurchases), its purchases over the same
 * history (the estimate's check of cancelled and returned ones). A metal not installed is left out. A failed purchases
 * read is said on the estimate, never taken as none.
 */
export function useGoldTotalsRead(metals: readonly Metal[], today: string, version: number, enabled: boolean): GoldRead<GoldTotalsInput[]> {
  return useGoldRead('totals', JSON.stringify(['totals', metals, today, version]), async () => {
    const all: GoldPeriod = { from: null, to: today };
    const inputs = await Promise.all(metals.map(async (metal): Promise<GoldTotalsInput | null> => {
      const overview = await fetchMetalsOverview(metal, all);
      if (!overview.installed) return null;
      if (!totalsReadsPurchases(overview)) return { overview, purchases: null, purchasesError: false };
      try {
        const purchases = await fetchMetalsPurchases(metal, all);
        return purchases.installed ? { overview, purchases, purchasesError: false } : { overview, purchases: null, purchasesError: true };
      } catch {
        return { overview, purchases: null, purchasesError: true };
      }
    }));
    return inputs.filter((input): input is GoldTotalsInput => input !== null);
  }, enabled);
}
