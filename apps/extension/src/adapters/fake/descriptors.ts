/**
 * Fake issuers for the test build only. They exercise the framework through
 * every mode the contract registers (isolated read, MAIN passive with a
 * cross-origin wrapper and XHR, rendered DOM) against made-up `*.e3.test`
 * sites. Their page and API shapes are invented for testing and are not the
 * issuers' real contracts; real adapters are E4–E7.
 */
import type { AdapterDescriptor } from '../types.js';

const COMMON_RISK = [
  'While enabled, this extension can read pages of this site in your signed-in session. Browser permissions are not a read-only grant: a malicious or buggy extension version could act on the site.',
  'Nothing is sent to Holdr until you review the exact preview in the extension popup and press Send.',
];

const MAIN_RISK = 'This site uses a passive observer in the page itself (MAIN world): it reads the responses the page already receives. Page scripts can forge what it sees; reconcile against statements.';

export const FAKE_CHASE: AdapterDescriptor = Object.freeze({
  id: 'fake-chase',
  issuer: 'chase',
  label: 'Chase (fake test issuer)',
  source: 'chase-api',
  mode: 'isolated-read',
  parserVersion: 'holdr-ext-fake-chase@0.1.0',
  consentVersion: 1,
  pageOrigin: 'http://chase.e3.test',
  hostPermission: 'http://chase.e3.test/*',
  pagePaths: Object.freeze(['/dashboard']),
  discoveryContract: 'chase.bootstrap',
  transactionsContract: 'chase.activity',
  scripts: Object.freeze({ isolated: 'isolated-fake-chase.js', main: null, shapeMain: 'shape-main-fake-chase.js' }),
  shapeContracts: Object.freeze({
    'chase.bootstrap': Object.freeze({
      method: 'POST',
      template: '/fake-api/accounts/list',
      names: Object.freeze(['content-type', 'tiles', 'accountId', 'mask', 'nickname', 'category']),
    }),
    'chase.activity': Object.freeze({
      method: 'GET',
      template: '/fake-api/accounts/:opaque/activity',
      names: Object.freeze([
        'start', 'end', 'count', 'cursor', 'activities', 'more', 'transactionDate', 'postDate', 'statusCode', 'amount', 'creditDebit', 'typeCode',
        'description', 'merchantName', 'category', 'sorId', 'derivedId', 'cardLast4',
      ]),
    }),
  }),
  riskNotes: Object.freeze([...COMMON_RISK, 'Reads use the site’s own activity API from the isolated extension world, at most one request at a time.']),
  testOnly: true,
});

export const FAKE_AMEX: AdapterDescriptor = Object.freeze({
  id: 'fake-amex',
  issuer: 'amex',
  label: 'American Express (fake test issuer)',
  source: 'amex-api-recent',
  mode: 'main-passive',
  parserVersion: 'holdr-ext-fake-amex@0.1.0',
  consentVersion: 1,
  pageOrigin: 'http://amex.e3.test',
  hostPermission: 'http://amex.e3.test/*',
  pagePaths: Object.freeze(['/activity']),
  discoveryContract: 'amex.overview-state',
  transactionsContract: 'amex.recent.observe',
  scripts: Object.freeze({ isolated: 'isolated-fake-amex.js', main: 'main-fake-amex.js', shapeMain: 'shape-main-fake-amex.js' }),
  shapeContracts: Object.freeze({
    'amex.recent.observe': Object.freeze({
      method: 'POST',
      template: '/ReadAccountActivity.web.v1',
      names: Object.freeze([
        'content-type', 'ce-source', 'accountToken', 'locale', 'limit', 'offset', 'view', 'transactions', 'hasMore', 'displayDate', 'description',
        'amount', 'type', 'status', 'memberName', 'cardEnding', 'category',
      ]),
    }),
  }),
  riskNotes: Object.freeze([...COMMON_RISK, MAIN_RISK]),
  testOnly: true,
});

export const FAKE_CITI: AdapterDescriptor = Object.freeze({
  id: 'fake-citi',
  issuer: 'citi',
  label: 'Citi (fake test issuer)',
  source: 'citi-api',
  mode: 'main-passive',
  parserVersion: 'holdr-ext-fake-citi@0.1.0',
  consentVersion: 1,
  pageOrigin: 'http://citi.e3.test',
  hostPermission: 'http://citi.e3.test/*',
  pagePaths: Object.freeze(['/accounts']),
  discoveryContract: 'citi.accounts.tiles.observe',
  transactionsContract: 'citi.transactions.observe',
  scripts: Object.freeze({ isolated: 'isolated-fake-citi.js', main: 'main-fake-citi.js', shapeMain: 'shape-main-fake-citi.js' }),
  shapeContracts: Object.freeze({
    'citi.accounts.tiles.observe': Object.freeze({
      method: 'GET',
      template: '/gcg-fake/v1/dashboard/tiles',
      names: Object.freeze(['creditCardAccounts', 'accountId', 'displayNumber', 'name', 'status']),
    }),
    'citi.transactions.observe': Object.freeze({
      method: 'POST',
      template: '/gcg-fake/v1/accounts/:opaque/transactions/retrieve',
      names: Object.freeze([
        'content-type', 'nextTableIndex', 'moreTransactionsFlag', 'isRedesignPage', 'pendingTransactions', 'postedTransactions', 'transactionId',
        'purchaseDate', 'postedDate', 'description', 'amount', 'transactionType', 'cardMemberName',
      ]),
    }),
  }),
  riskNotes: Object.freeze([...COMMON_RISK, MAIN_RISK]),
  testOnly: true,
});

export const FAKE_WELLS_FARGO: AdapterDescriptor = Object.freeze({
  id: 'fake-wf',
  issuer: 'wellsfargo',
  label: 'Wells Fargo (fake test issuer)',
  source: 'wf-dom',
  mode: 'dom-passive',
  parserVersion: 'holdr-ext-fake-wf@0.1.0',
  consentVersion: 1,
  pageOrigin: 'http://wf.e3.test',
  hostPermission: 'http://wf.e3.test/*',
  pagePaths: Object.freeze(['/activity']),
  discoveryContract: 'wf.rendered-accounts',
  transactionsContract: 'wf.rendered-activity',
  scripts: Object.freeze({ isolated: 'isolated-fake-wf.js', main: null, shapeMain: null }),
  shapeContracts: Object.freeze({}),
  riskNotes: Object.freeze([...COMMON_RISK, 'Only rows the page has rendered are read; rows it has not rendered are reported as not covered.']),
  testOnly: true,
});

export const FAKE_ADAPTERS: readonly AdapterDescriptor[] = Object.freeze([FAKE_CHASE, FAKE_AMEX, FAKE_CITI, FAKE_WELLS_FARGO]);
