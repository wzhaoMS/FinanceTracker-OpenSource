import type { ReactNode } from 'react';

export type AmazonCategoryTone = 'user' | 'agent' | 'mapping' | 'uncategorized' | 'unreported';

/**
 * An item's category as a tag, and who chose it. In lists, the agent's "classified from its title" repeated on nearly
 * every row, so there (`fromTitle`) the tag's dashed edge says it instead: the words stay in the tag's title (a
 * pointer's tooltip), for screen readers and in copied text, and an order's own page shows them. Every other source
 * (yours, a reviewed mapping, a default, not classified yet) is rare and always shown in words.
 */
export function AmazonCategoryTag({ name, source, tone, fromTitle = false, children }: {
  name: string;
  /** Who chose it, as a phrase ("classified from its title, 92% sure"); empty when nobody did. */
  source: string;
  tone: AmazonCategoryTone;
  /** Classified (or suggested) from the item's title, in a list: the source goes on the tag's edge. */
  fromTitle?: boolean;
  /** Marks shown after the name, such as "Suggested". */
  children?: ReactNode;
}) {
  const edge = fromTitle && source !== '';
  return (
    <span className="amazon-category" data-tone={tone} data-source={edge ? 'edge' : undefined}
      title={edge ? `${name} (${source})` : undefined}>
      <span className="amazon-category-name">{name}</span>
      {children}
      {source ? <>{' '}<span className={edge ? 'amazon-category-source visually-hidden' : 'amazon-category-source'}>({source})</span></> : null}
    </span>
  );
}

/** Said once above a list whose tags carry their source on their edge. */
export const AMAZON_AGENT_EDGE_NOTE = 'Dashed categories were classified from the item\'s title; an order\'s own page says how sure.';
