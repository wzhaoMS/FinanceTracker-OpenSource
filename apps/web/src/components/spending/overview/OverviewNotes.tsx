import { Disclosure } from '../../Disclosure';
import { AlertTriangle } from '../../icons';
import type { HeadlineComparison } from './headlineText';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A window that may be incomplete: said once, in a line of warning text with its icon (not a tinted pill that turns
 * into a block on a phone), why folded under it (Disclosure).
 */
export function IncompleteNote({ summary, reasons, testId }: { summary: string; reasons: readonly string[]; testId?: string }) {
  return (
    <div className="overview-note" data-testid={testId}>
      <Disclosure className="overview-note-fold" summary={<><AlertTriangle size={16} className="overview-note-icon" aria-hidden />{summary}</>}>
        <ul className="overview-note-reasons">
          {reasons.map((reason) => <li key={reason}>{capitalize(reason)}</li>)}
        </ul>
      </Disclosure>
    </div>
  );
}

type NotComparable = Extract<HeadlineComparison, { kind: 'notComparable' }>;

/**
 * Two windows that can't be compared: "Not comparable: <reason>", both figures labelled (a window with no card data
 * says so), and why folded under it. `whyAbout` keeps out what is said elsewhere (the period's own note, beside its
 * total).
 */
export function NotComparableBlock({ comparison, whyAbout, testId }: {
  comparison: NotComparable;
  whyAbout: ReadonlyArray<NotComparable['why'][number]['about']>;
  testId?: string;
}) {
  const why = comparison.why.filter((item) => whyAbout.includes(item.about));
  return (
    <div className="overview-not-comparable" data-testid={testId} data-tone="none">
      <p className="overview-not-comparable-reason" data-testid={testId ? `${testId}-reason` : undefined}>
        <strong>Not comparable:</strong> {comparison.reason}
      </p>
      <dl className="overview-figures">
        {comparison.rows.map((row) => (
          <div key={row.key} className="overview-figure" data-figure={row.key}>
            <dt>{row.label}</dt>
            <dd className="num">{row.figure}</dd>
          </div>
        ))}
      </dl>
      {why.length > 0 ? (
        <Disclosure className="overview-why" summary="Why they can't be compared">
          <ul className="overview-note-reasons">
            {why.map((item) => <li key={item.text}>{item.text}</li>)}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
