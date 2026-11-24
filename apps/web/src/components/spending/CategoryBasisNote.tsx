import type { CardCategoryBasis, CardCategoryBasisMarker } from '@finance-tracker/shared';

import { Disclosure } from '../Disclosure';
import { categoryBasisText, categoryEvidenceText } from './spendingFormat';

/**
 * What the categories are based on, read from the panel's own answer, and the one-click switch between Amazon item
 * categories and the cards' own: one line, said once (Spending by category). Why, where each charge's category comes
 * from and the Amazon splits by evidence are folded under "About these categories"; the answer's revision is kept in
 * a data attribute, not said.
 */
export function CategoryBasisNote(props: {
  marker: CardCategoryBasisMarker | undefined;
  preference: CardCategoryBasis;
  onBasis: (basis: CardCategoryBasis) => void;
}) {
  const basis = categoryBasisText(props.marker, props.preference);
  const evidence = categoryEvidenceText(props.marker);
  return (
    <div className="spending-category-basis-line" data-revision={basis.revision ?? undefined}>
      <span className="spending-muted spending-category-basis">{basis.text}</span>
      <button type="button" className="spending-link" onClick={() => props.onBasis(basis.next)}>{basis.toggle}</button>
      <Disclosure className="spending-category-about" summary="About these categories">
        <p className="spending-category-why">{basis.title}</p>
        {evidence ? <p className="spending-category-evidence">{evidence}</p> : null}
      </Disclosure>
      <span className="spending-muted spending-category-basis-pending" aria-live="polite">{basis.pending ?? ''}</span>
    </div>
  );
}