import { Disclosure } from '../Disclosure';
import { Spinner } from '../Spinner';
import type { MetalsOverview } from './goldApi';
import { assignmentMethodText, coverageLines, dateText, fungibleFor, metalName, sourceName } from './goldText';

const CNBC_SERIES = { XAU: 'XAU=', XAG: 'XAG=', XPT: 'XPT=', XPD: 'XPD=' } as const;
const TITLE = 'Where these figures come from';

/**
 * Where these figures come from (§11), folded: per source account the dates covered, when it was captured, complete or
 * partial, and its held records; the price source; and the declared method behind every assignment. All history,
 * whatever the period. The totals' "Review coverage" opens it (`open`, `onOpenChange`). While the overview is read again
 * (`busy`), its toggle carries the spinner and keeps its own name.
 */
export function GoldSources({ overview, open, onOpenChange, sectionRef, busy = false }: {
  overview: MetalsOverview;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  sectionRef?: (node: HTMLElement | null) => void;
  busy?: boolean;
}) {
  const { metal, price } = overview;
  return (
    <section ref={sectionRef} className="gold-card gold-sources" aria-label={TITLE} data-testid="gold-sources" aria-busy={busy || undefined}>
      <Disclosure summary={busy ? <>{TITLE} <Spinner label="Updating" /></> : TITLE} label={busy ? TITLE : undefined} open={open}
        onOpenChange={onOpenChange}>
        {overview.coverage.length === 0 ? <p className="gold-help">No source has been imported yet.</p> : (
          <ul className="gold-list">
            {overview.coverage.map((entry) => (
              <li key={entry.accountId} data-testid="gold-coverage">
                <p className="gold-row-name">{entry.label === sourceName(entry.source) ? entry.label : `${entry.label} · ${sourceName(entry.source)}`}</p>
                <ul className="gold-sublist">
                  {coverageLines(entry).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <p className="gold-help">
          Prices: CNBC&apos;s US-dollar spot series for {metalName(metal)} ({CNBC_SERIES[metal]}), daily closes stored on this Holdr
          {price.fetching ? '' : ' (it doesn\'t fetch new ones)'}. A day&apos;s close counts only once that day is over in New York, and a figure
          uses the last close on or before the day it values{price.closeDate ? `; the latest here is ${dateText(price.closeDate)}` : ''}.
        </p>
        <p className="gold-help" data-testid="gold-assignment-method">{assignmentMethodText(fungibleFor(overview, metal))}</p>
        <p className="gold-help">Gold and silver stay on this page: they are not in Portfolio&apos;s totals or net worth.</p>
      </Disclosure>
    </section>
  );
}
