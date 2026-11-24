// This vocabulary is also the receiver boundary. Only the scoped UFF key-name exception admits source strings.
export const AMAZON_REPORT_BYTES = 32768;
// Reserving this much per page leaves room for all eight page envelopes.
export const AMAZON_PAGE_BYTES = 3800;
export const AMAZON_KINDS = ['ledger', 'orders', 'order', 'digital', 'subscription'];
export const AMAZON_CODES = ['complete', 'auth-required', 'auth-unknown', 'captcha', 'redirect-blocked', 'http-error',
  'response-too-large', 'timeout', 'aborted', 'document-changed', 'unsupported-content', 'read-failed'];
export const AMAZON_LINKS = {
  '/cpe/yourpayments/transactions': 'ledger',
  '/gp/your-account/order-history': 'orders',
  '/your-orders/orders': 'orders',
  '/gp/your-account/order-details': 'order',
  '/your-orders/order-details': 'order',
  '/gp/digital/your-account/order-summary.html': 'digital',
  '/gp/your-account/digital-orders': 'digital',
  '/hz5/yourmembershipsandsubscriptions': 'subscription',
};
export const AMAZON_PARAMS = ['pageNumber', 'startIndex', 'orderID', 'orderId', 'orderFilter'];
export const AMAZON_NAVIGATION_RULES = {
  uffPath: '/uff/your-account/order-details',
  uffQueryName: '^[A-Za-z][A-Za-z0-9_]{0,31}$', uffQueryNames: 4,
  listPaths: ['/your-orders/orders', '/gp/your-account/order-history'],
  detailPaths: ['/gp/your-account/order-details', '/your-orders/order-details',
    '/uff/your-account/order-details', '/gp/css/summary/print.html'],
  queryNames: ['orderID', 'orderId', 'timeFilter', 'orderFilter', 'startIndex', 'pageNumber',
    'ref', 'ref_', 'language', 'ie', 'unknown'],
  pathTemplates: ['/your-orders/orders', '/gp/your-account/order-history',
    '/gp/your-account/order-details', '/your-orders/order-details', '/uff/your-account/order-details',
    '/gp/css/summary/print.html', '/cpe/yourpayments/transactions', '/ap/*', '/errors/validateCaptcha', 'other', 'unknown'],
  stopLocations: ['before-snapshot', 'snapshot', 'after-snapshot'],
  requestedKinds: ['list', 'details', 'invoice', 'ledger'],
  destinationClasses: ['admitted-same-identity', 'auth-route', 'disallowed', 'unknown'],
  pathFamilies: ['your-orders-details', 'account-details', 'uff-details', 'account-summary', 'digital',
    'fopo', 'wholefoods', 'fresh', 'invoice-print', 'returns', 'track-ship', 'other', 'unknown', 'cross-origin'],
  familyPatterns: [
    ['your-orders-details', '^/your-orders/order-details(?:/|$)'],
    ['account-details', '^/gp/your-account/order-details(?:/|$)'],
    ['uff-details', '^/uff/your-account/order-details(?:/|$)'],
    ['digital', '^/gp/(?:digital|your-account/digital-orders)(?:/|$)'],
    ['fopo', '^/fopo(?:/|$)'],
    ['wholefoods', '^/(?:wholefoods|whole-foods)(?:/|$)'],
    ['fresh', '^/(?:fresh|amazonfresh)(?:/|$)'],
    ['invoice-print', '(?:^|/)(?:invoice(?:\\.html)?|print(?:\\.html)?)(?:/|$)'],
    ['account-summary', '^/gp/css/summary(?:/|$)'],
    ['returns', '^/(?:returns?|gp/(?:css|your-account)/returns?)(?:/|$)'],
    ['track-ship', '(?:^|/)(?:track|tracking|shipment|shipments|ship-track|track-package)(?:/|$)'],
  ],
};
export function amazonPathFamily(pathname) {
  if (typeof pathname !== 'string') return 'unknown';
  return AMAZON_NAVIGATION_RULES.familyPatterns.find(([, pattern]) => new RegExp(pattern).test(pathname))?.[0] || 'other';
}
export const AMAZON_SELECTORS = {
  rows: ['tr', '[role="row"]', '.transaction-row', '.order-card', '.line-item'],
  cells: ['tr > td', 'tr > th', '[role="row"] > [role="cell"]', '.transaction-row > div', '.line-item > div'],
  stableKey: ['[data-order-id]', '[data-transaction-id]', '[data-item-id]'],
  charge: ['[data-transaction-type="charge"]', '[data-field="charge"]'],
  refund: ['[data-transaction-type="refund"]', '[data-field="refund"]'],
  date: ['time', '[data-field="date"]'],
  amount: ['[data-field="amount"]', '.amount'],
  currency: ['[data-field="currency"]'],
  method: ['[data-field="payment-method"]'],
  last4: ['[data-field="last4"]'],
  quantity: ['[data-field="quantity"]', '.quantity'],
  price: ['[data-field="price"]', '.price'],
  tax: ['[data-field="tax"]'],
  shipping: ['[data-field="shipping"]'],
  discount: ['[data-field="discount"]'],
  shipment: ['[data-shipment-id]', '.shipment'],
  allocation: ['[data-field="allocation"]', '[data-charge-id][data-order-id]', '[data-order-id][data-item-id]'],
  refundStatus: ['[data-field="refund-status"]'],
  refundCard: ['[data-refund-destination="card"]'],
  refundBalance: ['[data-refund-destination="balance"]'],
  refundPoints: ['[data-refund-destination="points"]'],
  refundDestination: ['[data-field="refund-destination"]'],
  itemLink: ['a[data-item-id]'],
  coverage: ['select[name="orderFilter"]', 'input[type="date"]', '[data-field="date-range"]'],
  pagination: ['a[rel="next"]', 'a[rel="prev"]', '[aria-current="page"]'],
};
const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));
const count = (value, max = 20000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const need = (ok) => { if (!ok) throw Error('invalid-amazon-report'); };
export function validateAmazonReport(report) {
  const fields = ['format', 'version', 'scope', 'code', 'requests', 'pages'];
  const hasStop = report !== null && typeof report === 'object' && Object.hasOwn(report, 'stopStage');
  need(exact(report, hasStop ? [...fields, 'stopStage', 'stopEvidence'] : fields)
    && report.format === 'holdr.amazon-shapes' && report.version === 1
    && report.scope === 'structural-only-unobserved-is-unknown'
    && AMAZON_CODES.includes(report.code) && count(report.requests, 8)
    && (report.code !== 'auth-unknown' || hasStop)
    && Array.isArray(report.pages) && report.pages.length <= report.requests
    && (report.code !== 'complete' || report.pages.length === report.requests));
  if (hasStop) {
    const counts = report.stopEvidence;
    need(['live-document', 'response-status', 'response-document'].includes(report.stopStage)
      && ['auth-required', 'captcha', 'auth-unknown'].includes(report.code)
      && exact(counts, ['password', 'email', 'captcha', 'http401', 'http403'])
      && ['password', 'email', 'captcha'].every((key) => count(counts[key], 256))
      && counts.password + counts.email + counts.captcha <= 256
      && count(counts.http401, 1) && count(counts.http403, 1));
    if (report.stopStage === 'response-status') {
      need(report.requests > 0 && report.code === 'auth-required'
        && counts.http401 + counts.http403 === 1 && counts.password + counts.email + counts.captcha === 0);
    } else {
      need((report.stopStage === 'live-document' || report.requests > 0)
        && counts.http401 + counts.http403 === 0
        && (report.code === 'auth-unknown' || (report.code === 'captcha' ? counts.captcha > 0
          : counts.captcha === 0 && counts.password + counts.email > 0)));
    }
  }
  for (const page of report.pages) {
    need(exact(page, ['kind', 'elements', 'truncated', 'shapes', 'links', 'unknownLinks', 'unknownAttributes'])
      && AMAZON_KINDS.includes(page.kind) && count(page.elements) && typeof page.truncated === 'boolean'
      && exact(page.shapes, Object.keys(AMAZON_SELECTORS))
      && Array.isArray(page.links) && page.links.length <= 32
      && count(page.unknownLinks) && count(page.unknownAttributes));
    need(new TextEncoder().encode(JSON.stringify(page)).length <= AMAZON_PAGE_BYTES);
    for (const [field, selectors] of Object.entries(AMAZON_SELECTORS)) {
      need(Array.isArray(page.shapes[field]) && page.shapes[field].length <= selectors.length);
      const seen = new Set();
      for (const entry of page.shapes[field]) {
        need(exact(entry, ['selector', 'count']) && selectors.includes(entry.selector)
          && !seen.has(entry.selector) && count(entry.count) && entry.count > 0);
        seen.add(entry.selector);
      }
    }
    for (const link of page.links) {
      need(exact(link, ['template', 'params', 'unknownParams', 'available', 'count'])
        && Object.hasOwn(AMAZON_LINKS, link.template)
        && Array.isArray(link.params) && link.params.length <= AMAZON_PARAMS.length
        && new Set(link.params).size === link.params.length && link.params.every((p) => AMAZON_PARAMS.includes(p))
        && count(link.unknownParams, 100) && typeof link.available === 'boolean'
        && count(link.count) && link.count > 0);
    }
  }
  need(new TextEncoder().encode(JSON.stringify(report)).length <= AMAZON_REPORT_BYTES);
  return report;
}
