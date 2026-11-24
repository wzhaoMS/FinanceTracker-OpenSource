import { useId } from 'react';

import { TitleWithSpinner } from '../Spinner';
import type { MetalsOverview } from './goldApi';
import { Figure, LineParts, SpotFigure } from './GoldSummary';
import {
  asOfText, classMetaParts, classTitle, contentUnknownLine, fungibleFor, holdingsClassesTitle, metalUnknownLine, moneyFigure,
  reconciliationLines, sourceMetaParts, spotShown, unresolvedMetalHeldLine,
} from './goldText';

/**
 * Holdings as of a date (§11), never moved by the period: by form (each class with its reconciliation; by fine content
 * across forms where the owner's fungible policy names the metal), by source, and where it's kept, which is not recorded
 * until the owner says. While the overview is read again (`busy`), what it shows (read before) is marked as being read
 * again.
 */
export function GoldHoldings({ overview, busy = false }: { overview: MetalsOverview; busy?: boolean }) {
  const titleId = useId();
  const { holdings, metal } = overview;
  const unknown = contentUnknownLine(overview);
  const unresolved = unresolvedMetalHeldLine(overview.metalUnknown);
  const spot = spotShown(overview.price);
  const title = <h3 id={titleId}>Holdings <span className="gold-asof">{asOfText(overview.asOf)}</span></h3>;
  return (
    <section className="gold-card gold-holdings" aria-labelledby={titleId} data-testid="gold-holdings" aria-busy={busy || undefined}>
      {busy ? <TitleWithSpinner busy>{title}</TitleWithSpinner> : title}
      {unresolved ? <p className="gold-help" data-testid="gold-holdings-unresolved">{unresolved}</p> : null}
      <div className="gold-holdings-groups">
        <div className="gold-group">
          <h4>{holdingsClassesTitle(fungibleFor(overview, metal))}</h4>
          {holdings.classes.length === 0 ? <p className="gold-help">No delivered purchase of known content is recorded.</p> : (
            <ul className="gold-list">
              {holdings.classes.map((item) => (
                <li key={item.key} className="gold-class" data-testid="gold-class">
                  <p className="gold-row-name">{classTitle(item, metal)}</p>
                  <p className="gold-row-meta"><LineParts parts={classMetaParts(item)} /></p>
                  <dl className="gold-details">
                    <div><dt>Cost</dt><dd><Figure measure={item.costMinor} text={moneyFigure(item.costMinor)} /></dd></div>
                    <div><dt>Estimated value at spot</dt><dd><SpotFigure measure={item.valueMinor} spot={spot} /></dd></div>
                    <div><dt>Gain/loss at spot</dt><dd><SpotFigure measure={item.gainMinor} spot={spot} signed /></dd></div>
                  </dl>
                  <ul className="gold-reconciliation" aria-label={`How ${classTitle(item, metal)} add up`}>
                    {reconciliationLines(item.units, [], item.reconciliation.deliveryInferred).map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="gold-group">
          <h4>By source</h4>
          {holdings.bySource.length === 0 ? <p className="gold-help">No source has recorded holdings.</p> : (
            <ul className="gold-list">
              {holdings.bySource.map((source) => (
                <li key={source.accountId} data-testid="gold-source">
                  <p className="gold-row-name">{source.label}</p>
                  <p className="gold-row-meta"><LineParts parts={sourceMetaParts(source, spot)} /></p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="gold-group">
          <h4>Where it&apos;s kept</h4>
          <p className="gold-row-name" data-testid="gold-storage">Not recorded</p>
        </div>
      </div>
      {unknown ? <p className="gold-help">{unknown}</p> : null}
      {metalUnknownLine(overview.metalUnknown) ? (
        <p className="gold-help" data-testid="gold-metal-unknown">{metalUnknownLine(overview.metalUnknown)}</p>
      ) : null}
    </section>
  );
}
