import { useMemo } from 'react';
import {
  formatCurrency,
  formatGainLoss,
  summarizeBySymbol,
} from '@finance-tracker/shared';
import type { Account, Quote, Transaction } from '@finance-tracker/shared';

import { dayChangeNote } from './dayChangeNote';
import { withTone } from './tone';

interface Props {
  accounts: Account[];
  transactions: Transaction[];
  quotes: Quote[];
  /** How many top-by-market-value tickers to show. */
  limit?: number;
}

/**
 * Scrolling price-ticker banner, modelled after the gold/silver/platinum
 * marquee on collectpure.com. Difference: we don't have a fixed list of
 * commodities — the user's "best index" is *their own portfolio*. So we
 * show their top N holdings by market value, with day change.
 *
 * Implementation notes:
 *
 *  - The marquee is a single horizontally-scrolling row. To get a seamless
 *    infinite loop without JS, we render the same <ul> twice inside a flex
 *    container and translate the wrapper from 0 to -50% with a CSS keyframe.
 *    When the first copy slides off-screen the second is in the same
 *    on-screen position the first started in, and the animation restarts
 *    invisibly.
 *
 *  - Pause on hover only on devices that have a precise pointer (desktop).
 *    On touch the marquee never stops because there's no hover state.
 *
 *  - prefers-reduced-motion: render the items but skip the animation. Users
 *    who opt into reduced motion still get to see the prices, they just
 *    don't get the constant scroll movement.
 *
 *  - Render-nothing fallback: if the user hasn't imported any holdings yet
 *    or all positions are missing quotes, hide the band entirely so we
 *    don't show a 30px-tall empty bar.
 */
export function TickerBanner({ accounts, transactions, quotes, limit = 6 }: Props) {
  const items = useMemo(() => {
    if (accounts.length === 0 || quotes.length === 0) return [];
    const summary = summarizeBySymbol(accounts, transactions, quotes);
    return summary.rows
      .filter((r) => r.instrumentType !== 'option' && !r.missingQuote && r.marketPrice != null)
      .slice(0, limit);
  }, [accounts, transactions, quotes, limit]);

  if (items.length === 0) return null;
  // The demo's stored prices are invented, never live: the band says so, as the header's quote badge does (quoteStatus.ts).
  const synthetic = quotes.every((quote) => quote.source === 'synthetic');

  // Render twice for the seamless loop. aria-hidden on the dupe so screen
  // readers don't read each ticker (or its note) twice.
  //
  // Round 3 ticker polish (3.A1):
  //   - drop the literal `$` prefix on tickers (read as retail/Twitter slang)
  //   - replace the ASCII `|` separator with an empty span styled as a
  //     1px CSS hairline (uneven heights across fonts otherwise)
  //   - drop the explicit `+` sign — the gain/loss color + the dollar
  //     sign on the price already convey direction; double-cueing reads
  //     as terminal output
  const renderRow = (key: string, ariaHidden: boolean) => (
    <ul className="ticker-row" key={key} aria-hidden={ariaHidden}>
      {items.map((r) => {
        // A day change that reads zero is unsigned and in neither colour; one that is missing reads "—", never
        // "$0.00 0.00%". The tone follows the amount, or the percent when the amount reads zero or is missing.
        const shown = formatGainLoss(r.dayChange, r.dayChangePercent, { currency: r.currency });
        const unknown = r.dayChange == null && r.dayChangePercent == null;
        // What a shown change is measured over, by the holdings' rule ("after hours" is the move since today's close):
        // drawn short where the band is tight ("24h"), heard in full.
        const note = unknown ? null : dayChangeNote(r);
        return (
          <li key={`${key}-${r.symbol}`} className="ticker-item">
            <span className="ticker-symbol">{r.symbol}</span>
            <span className="ticker-price">{formatCurrency(r.marketPrice ?? 0, r.currency)}</span>
            <span className="ticker-sep" aria-hidden />
            <span className={withTone('ticker-change', shown.tone)}>
              {unknown
                ? <><span aria-hidden>—</span><span className="visually-hidden">No day change</span></>
                : `${shown.amount} ${shown.percent}`}
            </span>
            {note ? (
              <span className="ticker-note">
                {note.short === note.text
                  ? note.text
                  : <><span aria-hidden>{note.short}</span><span className="visually-hidden">{note.text}</span></>}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  // role="region" + aria-label is the accessible-name landmark pattern.
  // role="marquee" was deprecated in ARIA 1.2 and not surfaced by
  // mainstream screen readers. aria-live="off" tells AT not to
  // re-announce the loop.
  return (
    <section
      className="ticker-banner"
      role="region"
      aria-label="Top holdings ticker"
      aria-live="off"
    >
      <span className="ticker-label" aria-hidden>
        Top holdings
        <span className={synthetic ? 'ticker-label-dot synthetic' : 'ticker-label-dot'} />
        {synthetic ? <span className="ticker-label-synthetic">Synthetic</span> : <span className="ticker-label-live">Live</span>}
      </span>
      <div className="ticker-track">
        {renderRow('a', false)}
        {renderRow('b', true)}
      </div>
    </section>
  );
}
