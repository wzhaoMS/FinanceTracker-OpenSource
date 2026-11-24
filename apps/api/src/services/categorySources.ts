import type { CardCategoryResolverSnapshot } from '@finance-tracker/shared';
import type { AmazonCardDetail, AmazonResolver, OrderMatchView } from './amazon/resolver.js';

/**
 * One request's view of Spending's category sources: each card row answered by the source that answers it, and which
 * rows a source links said explicitly. Read as untrusted input by Spending, as any source is.
 */
export interface CompositeCategorySnapshot extends CardCategoryResolverSnapshot {
  /** The Amazon domain's card detail of a row: Spending's `amazon` detail. */
  readonly getCardDetail: (id: string) => AmazonCardDetail;
  readonly getOrderMatches: (orderRef: string) => OrderMatchView[];
  readonly isAmazonCharge: (id: string) => boolean;
  /** Whether a source links the row to its evidence. Spending refuses a split of a row no source links. */
  readonly isLinkedRow: (id: string) => boolean;
}

export interface CompositeCategoryResolver {
  snapshot(): CompositeCategorySnapshot;
}

/**
 * Spending's category source (Costco receipts 4/7 §9), in place of the Amazon domain's own resolver: one snapshot per
 * request over every reviewed source. The Amazon domain is its only source so far, so every answer is Amazon's, byte
 * for byte, its version included, and a row is linked exactly when Amazon's card detail links it.
 */
export function createCompositeCategoryResolver([amazon]: readonly [amazon: AmazonResolver]): CompositeCategoryResolver {
  return {
    snapshot() {
      const source = amazon.snapshot();
      return Object.freeze({
        version: source.version,
        resolve: (rows) => source.resolve(rows),
        getCardDetail: (id) => source.getCardDetail(id),
        getOrderMatches: (orderRef) => source.getOrderMatches(orderRef),
        isAmazonCharge: (id) => source.isAmazonCharge(id),
        isLinkedRow: (id) => source.getCardDetail(id).match === 'linked',
      } satisfies CompositeCategorySnapshot);
    },
  };
}
