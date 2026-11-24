/** Fake American Express, ISOLATED side (test build only): page state only; batches come from the MAIN observer. */
import type { IsolatedAdapter } from '../../../isolated/types.js';
import { FAKE_AMEX } from '../descriptors.js';

export const FAKE_AMEX_ISOLATED: IsolatedAdapter = {
  identity: {
    id: FAKE_AMEX.id,
    label: FAKE_AMEX.label,
    issuer: FAKE_AMEX.issuer,
    source: FAKE_AMEX.source,
    mode: FAKE_AMEX.mode,
    parserVersion: FAKE_AMEX.parserVersion,
    pageOrigin: FAKE_AMEX.pageOrigin,
    pagePaths: FAKE_AMEX.pagePaths,
    discoveryContract: FAKE_AMEX.discoveryContract,
    transactionsContract: FAKE_AMEX.transactionsContract,
    usesMainObserver: true,
  },
  pageState(doc) {
    if (doc.querySelector('form#login')) return 'auth-required';
    return doc.querySelector('#activity-app[data-ready="true"]') ? 'activity' : 'other';
  },
};
