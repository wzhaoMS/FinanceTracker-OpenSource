/** Fake Citi, ISOLATED side (test build only): page state only; batches come from the MAIN observer. */
import type { IsolatedAdapter } from '../../../isolated/types.js';
import { FAKE_CITI } from '../descriptors.js';

export const FAKE_CITI_ISOLATED: IsolatedAdapter = {
  identity: {
    id: FAKE_CITI.id,
    label: FAKE_CITI.label,
    issuer: FAKE_CITI.issuer,
    source: FAKE_CITI.source,
    mode: FAKE_CITI.mode,
    parserVersion: FAKE_CITI.parserVersion,
    pageOrigin: FAKE_CITI.pageOrigin,
    pagePaths: FAKE_CITI.pagePaths,
    discoveryContract: FAKE_CITI.discoveryContract,
    transactionsContract: FAKE_CITI.transactionsContract,
    usesMainObserver: true,
  },
  pageState(doc) {
    if (doc.querySelector('form#login')) return 'auth-required';
    return doc.querySelector('#citi-app[data-ready="true"]') ? 'activity' : 'other';
  },
};
