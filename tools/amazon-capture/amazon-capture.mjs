import { validateAmazonReport, AMAZON_NAVIGATION_RULES as navigation, amazonPathFamily } from './amazon-report.mjs';
import { validateAmazonScopedReadiness } from './amazon-scoped.mjs';
import { AMAZON_FRESH_RULES, validateAmazonFreshItemLists } from './amazon-fresh-items.mjs';

export const AMAZON_CAPTURE_BYTES = 2 * 1024 * 1024;
// Per-page read limits: each page read is held to its own kind's HTML bytes, element
// count and DOM depth, else to the base (1 MiB, 20,000 elements, depth 64). A kind's raise is a change to `kinds` alone,
// never past the fixed ceiling (a test holds every entry between the two). The 16 MiB run allowance, the 2 MiB capture
// and the order-card carrier caps don't move with it.
export const AMAZON_PAGE_LIMITS = Object.freeze({
  base: Object.freeze({ bytes: 1048576, elements: 20000, depth: 64 }),
  ceiling: Object.freeze({ bytes: 2 * 1048576, elements: 40000, depth: 128 }),
  kinds: Object.freeze({ order: Object.freeze({ bytes: 1572864 }), 'fresh-items': Object.freeze({ bytes: 1572864 }) }),
});
// The capture model resolves a kind with this same expression (a test compares the two).
export const amazonPageLimits = (kind, limits = AMAZON_PAGE_LIMITS) =>
  ({ ...limits.base, ...(Object.hasOwn(limits.kinds, kind) ? limits.kinds[kind] : {}) });
// A response-too-large stop's diagnostic: the kind of page being read, which of its limits
// fired first, and the measured size over that limit. Closed values only; 'unmeasured' when only reading further would
// tell the size.
export const AMAZON_SIZE_STOP = Object.freeze({
  kinds: Object.freeze(['ledger', 'orders', 'order', 'returns', 'fresh-items']),
  limits: Object.freeze(['bytes', 'elements', 'depth', 'carriers', 'readiness']),
  buckets: Object.freeze(['to-1.25x', 'to-1.5x', 'to-2x', 'to-4x', 'over-4x', 'unmeasured']),
});
// The injected reader and capture model carry this same expression (a test compares the three).
export const amazonSizeBucket = (size, cap) => size === null ? 'unmeasured' : size * 4 <= cap * 5 ? 'to-1.25x'
  : size * 2 <= cap * 3 ? 'to-1.5x' : size <= cap * 2 ? 'to-2x' : size <= cap * 4 ? 'to-4x' : 'over-4x';
export const AMAZON_STRUCTURE_RULES = {
  name: '^[a-zA-Z][a-zA-Z_-]{0,63}$',
  class: '^(?:a|yohtmlc|order|orders|transaction|transactions|pmts|payment|payments|shipment|item|product|line|refund|pagination|page|price|quantity|amount|currency|date|value|display|container|section|row|column|button|content|js|wfm|grocery|delivery|od)(?:[-_][a-z]{1,24})*$',
  attribute: '^(?:class|role|name|type|rel|href|title|hidden|inert|style|datetime|aria-[a-z-]{1,32}|data-[a-z-]{1,48})$',
  denied: '(?:customer|recipient|address|email|password|secret|token|session|account|user|profile|phone|credential|auth|nonce|csrf)',
  entropySegment: 12, entropyMax: 3.6,
  tags: ['html', 'body', 'main', 'section', 'article', 'div', 'span', 'a', 'p', 'ul', 'ol', 'li',
    'table', 'tbody', 'thead', 'tr', 'td', 'th', 'form', 'select', 'option', 'input', 'button', 'time',
    'h1', 'h2', 'h3', 'strong', 'b', 'label', 'img', 'dl', 'dt', 'dd', 'br', 'i', 'em'],
  perSet: 64, depth: 6,
  readinessBytes: 16384, readinessCount: 20000,
  readinessFactsBytes: 2048, readinessVocabularyBytes: 8192, readinessGlobalVocabularyBytes: 4096,
  readinessStructureTags: ['dl', 'dt', 'dd', 'table', 'tr', 'td'],
  readinessStructureClasses: 8, readinessStructureBytes: 512,
  scoped: { roots: 4, depth: 6, summaryNodes: 512, dlNodes: 128, methodNodes: 64,
    nodes: 1024, rows: 192, pairs: 32, classes: 64, classBytes: 2048, shapes: 128, shapeBytes: 2048,
    bytes: 11264 },
  labels: ['order placed', 'order #', 'order number', 'total', 'order total', 'grand total',
    'view order details', 'order details', 'view invoice', 'invoice', 'payment method',
    'pending', 'charged', 'refunded', 'refund total', 'quantity', 'qty', 'unit price',
    'order summary', 'items subtotal', 'item(s) subtotal', 'shipping & handling', 'total before tax',
    'estimated tax to be collected', 'gift card', 'amazon gift card', 'refund to'],
  fields: ['order-id', 'date', 'total', 'amount', 'payment-method', 'status', 'item-title', 'quantity', 'unit-price', 'record'],
  reasons: ['missing', 'invalid', 'conflict', 'scope-budget', 'unrecognized'],
  families: ['regular', 'grocery', 'payment', 'item'],
  scopeNodes: 240, orderScopeNodes: 1024, scopeDepth: 20, scopes: 4, failures: 512,
  carrierBytes: 131072, carrierPageBytes: 1048576, carrierCount: 100,
  // The capture model's per-kind page limits travel with its rules.
  pageLimits: AMAZON_PAGE_LIMITS,
  tenderReasons: ['unknown-label', 'row-shape', 'extra-text', 'duplicate-kind', 'arithmetic', 'method-incomplete', 'multi-tender', 'no-details-link'],
  unknownLabel: "^[a-z][a-z &'-]{1,31}$", unknownLabels: 64, summaryRows: 32,
  summaryLabelDisclosure: {
    grammar: "^[a-z](?:[a-z &'()/.:\\-]{0,46}[a-z])?$",
    denied: '(?:customer|recipient|address|email|password|secret|token|session|account|user|profile|phone|credential|auth|nonce|csrf|bearer|apikey|routing|socialsecurity|ssn|iban)',
    urls: '(?:https?|ftp|www)(?:[^a-z]|$)|[a-z]\\.[a-z]{2,}',
    labels: 16, bytes: 4096, count: 20000,
  },
  gateOrders: 32, gateOrderBytes: 16384, gateBytes: 262144,
  tenderScopeDepth: 64, scopeHoldReasons: ['nodes', 'depth', 'tag', 'attributes', 'classes'],
  proofChecks: ['method-complete', 'summary-complete', 'conflict-free', 'one-card-instrument',
    'required-components', 'order-total', 'no-non-card-summary', 'summary-snapshot-match', 'summary-arithmetic'],
  conflictSources: ['unknown-label', 'summary-hold', 'method-incomplete', 'record-limit',
    'snapshot-mismatch', 'detail-conflict', 'summary-conflict', 'order-conflict'],
  summarySelectors: ['legacy-id', 'legacy-class', 'summary-class', 'summary-component', 'modern', 'uff-dl'],
  summaryComponents: ['orderSummary', 'paymentMethod', 'itemTitle', 'unitPrice'],
  listEvidence: ['hasMoney', 'hasCurrencySymbolOrCode', 'hasDecimalCents', 'hasClosedTenderLabel', 'hasClosedFinancialKeyword', 'hasOdClass'],
  itemChecks: ['bounded', 'unknown-line', 'conflict', 'summary-complete', 'conflict-free', 'items-present', 'quantity-finalized', 'subtotal-reconciled'],
  itemRegionModes: ['legacy-block', 'derived-lca', 'none'],
  itemRegionDepths: ['none', '0', '1', '2-4', '5-8', '9-16', 'over-16'],
  itemRegionElements: ['none', '0', '1-16', '17-64', '65-240', '241-1000', '1001-4000', 'over-4000'],
  itemHiddenKinds: ['duplicate-item-link', 'duplicate-price', 'decorative-ignored', 'link-blocking', 'amount-blocking', 'label-blocking'],
  itemBlockSelectors: ['shipment', 'items-component', 'order-items-component', 'order-items-class'],
  itemComponents: ['items', 'orderItems', 'item', 'itemTitle', 'unitPrice'],
  // Display-only: one validated Amazon CDN image ID per item row, never financial evidence or a URL.
  itemImage: {
    src: '^https://(?:m\\.media-amazon\\.com|images-na\\.ssl-images-amazon\\.com)/images/I/'
      + '([A-Za-z0-9][A-Za-z0-9+-]{9}[A-Za-z0-9])(?:\\.[A-Za-z0-9_,]{1,64}){0,3}\\.(?:jpg|jpeg|png|gif|webp)$',
    id: '^[A-Za-z0-9][A-Za-z0-9+-]{9}[A-Za-z0-9]$',
    images: 8,
  },
  // Displayed return/refund statuses. Each closed phrase fixes its record's [kind, status]; a return is never a refund.
  refunds: {
    records: 800, destinations: 4, items: 100, returnsPath: '/spr/returns/history',
    phrases: {
      'return-created': ['return', 'started'], 'return-started': ['return', 'started'],
      'return-requested': ['return', 'started'], 'return-in-transit': ['return', 'in-transit'],
      'return-received': ['return', 'received'], 'return-complete': ['return', 'completed'],
      'return-cancelled': ['return', 'cancelled'], 'refund-issued': ['refund', 'completed'],
      'refund-complete': ['refund', 'completed'], 'refund-processed': ['refund', 'completed'],
      refunded: ['refund', 'completed'], 'refund-for-return': ['refund', 'pending'],
      'refund-pending': ['refund', 'pending'],
    },
    // Whole normalized text of one status leaf, compared exactly (lowercase); nothing else is a status.
    statusLabels: {
      'return started': 'return-started', 'return requested': 'return-requested', 'return in transit': 'return-in-transit',
      'return received': 'return-received', 'return complete': 'return-complete', 'return completed': 'return-complete',
      'return cancelled': 'return-cancelled', 'return canceled': 'return-cancelled', 'refund issued': 'refund-issued',
      'refund complete': 'refund-complete', 'refund completed': 'refund-complete', 'refund processed': 'refund-processed',
      refunded: 'refunded', 'refund pending': 'refund-pending',
    },
    // Order-details shipment status slots (modern component, list/detail classes, legacy shipment headline).
    statusSelectors: '[data-component="shipmentStatus"],.yohtmlc-shipment-status-primaryText,'
      + '.delivery-box__primary-text,.od-status-message,.js-shipment-info-container,.shipment .a-row > span.a-text-bold',
    returnBoxes: '.a-box-group.a-spacing-extra-large',
  },
  // The Whole Foods in-store receipt a constructed details task is redirected to (the capture kit's /fopo/ reader):
  // its closed hold reasons, row reasons and vocabularies. Never a value.
  fopo: {
    reads: 48,
    // The receipt page's path (after a `/ref=` suffix is dropped); its query values are never read.
    path: '^/fopo(?:/[A-Za-z0-9_-]{1,64}){0,4}$',
    reasons: ['unfaithful', 'region', 'widgets', 'heading', 'identity', 'date', 'rows', 'row', 'summary', 'tender',
      'arithmetic', 'header', 'hidden', 'status'],
    rowReasons: ['hidden', 'shape', 'image', 'name', 'status', 'quantity', 'unit', 'amount', 'promotion', 'tare', 'struck'],
    networks: { visa: 'visa', 'prime visa': 'visa', 'amazon visa': 'visa', 'amazon prime visa': 'visa', mastercard: 'mastercard',
      'american express': 'amex', amex: 'amex', discover: 'discover' },
    // F's tax-breakout guard (2026-10-24): "Tax and Fees" is tax only when every breakout row is a tax jurisdiction.
    jurisdiction: '\\b(?:tax|taxes|county|city|state|municipal|municipality|district|transit|parish|borough|village|town'
      + '|township|sales|use)\\b',
    fees: '\\b(?:fees?|deposits?|bottles?|bags?|crv|redemption|recycl\\w*|surcharges?|service|delivery|tips?|charges?'
      + '|donations?|environmental)\\b',
    status: AMAZON_FRESH_RULES.status,
  },
  itemKeywords: {
    bytes: 8192, blockEntries: 64, rowEntries: 16, entries: 128, count: 20000,
    sources: ['exact-label', 'direct-keyword', 'ancestor-label', 'ancestor-keyword'],
    families: ['items-subtotal', 'shipping', 'tax', 'gift-card', 'promotion', 'rewards', 'grand-total',
      'before-tax', 'refund-total', 'order-total', 'tip'],
    stems: ['points', 'total', 'subtotal', 'refund', 'gift', 'balance', 'reward', 'credit', 'charge',
      'promotion', 'promo', 'discount', 'coupon', 'saving', 'tax', 'shipping'],
    depths: ['direct', '1', '2-3', '4-6', 'over-6'],
    ancestry: ['yes', 'no', 'unknown'],
  },
  pagination: {
    bytes: 8192, candidates: 16, count: 64,
    tags: ['a', 'button', 'input', 'form'],
    queryNames: ['pageNumber', 'orderID', 'orderId', 'ref', 'ref_', 'language', 'ie', 'unknown'],
    targets: ['same-origin-admitted-ledger', 'same-origin-unadmitted-ledger', 'same-origin-other',
      'cross-origin', 'absent', 'invalid'],
    methods: ['get', 'post', 'absent', 'other'],
    grammar: ['absent', 'valid', 'invalid'],
    orderGrammar: ['absent', 'valid', 'same-order', 'different-order', 'invalid'],
    positions: ['before-rows', 'after-rows', 'within-rows', 'no-rows'],
    dispositions: ['not-selected', 'unreadable', 'not-attempted', 'queued', 'seen', 'held', 'duplicate', 'capacity', 'stopped'],
    rowOrders: ['descending', 'ascending', 'mixed', 'unknown'],
    labels: ['next', 'next page', 'next transactions', 'older', 'older transactions', 'older charges'],
    pathFamilies: navigation.pathFamilies, familyPatterns: navigation.familyPatterns,
    linkQueries: navigation.queryNames,
  },
  financialCurrencies: 'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG',
};
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const need = (ok) => { if (!ok) throw Error('invalid-amazon-capture'); };
const count = (n, max = 20000) => Number.isSafeInteger(n) && n >= 0 && n <= max;
export function validateAmazonItemKeywords(value) {
  const r = AMAZON_STRUCTURE_RULES.itemKeywords;
  need(exact(value, ['version', 'status', 'block', 'rows', 'rowsOmitted']) && value.version === 1
    && ['complete', 'unknown'].includes(value.status)
    && Array.isArray(value.rows) && value.rows.length <= 100 && count(value.rowsOmitted, 400)
    && value.rows.length + value.rowsOmitted <= 400
    && new TextEncoder().encode(JSON.stringify(value)).length <= r.bytes);
  let unknown = value.rowsOmitted > 0, entries = 0;
  const bucket = (b, location, row = false) => {
    need(exact(b, ['classified', 'entries', 'omitted', 'countsCapped', ...(row ? ['ordinal'] : [])])
      && count(b.classified) && count(b.omitted) && typeof b.countsCapped === 'boolean'
      && Array.isArray(b.entries) && b.entries.length <= (row ? r.rowEntries : r.blockEntries));
    const seen = new Set();
    let hits = b.omitted;
    for (const entry of b.entries) {
      need(Array.isArray(entry) && entry.length === 7 && r.sources.includes(entry[0])
        && (entry[0].endsWith('label') ? r.families : r.stems).includes(entry[1])
        && entry[2] === location && r.depths.includes(entry[3])
        && (entry[0].startsWith('ancestor-') ? entry[3] !== 'direct' : entry[3] === 'direct')
        && r.ancestry.includes(entry[4]) && r.ancestry.includes(entry[5])
        && count(entry[6]) && entry[6] > 0 && entry[6] <= b.classified);
      const key = JSON.stringify(entry.slice(0, 6));
      need(!seen.has(key)); seen.add(key);
      hits += entry[6]; entries++;
      unknown ||= entry[4] === 'unknown' || entry[5] === 'unknown';
    }
    need(hits >= b.classified && (b.classified > 0 || (hits === 0 && !b.countsCapped)));
    if (!b.countsCapped) need(hits >= b.classified && hits <= b.classified * r.stems.length);
    else need(b.classified === r.count || b.omitted === r.count || b.entries.some((e) => e[6] === r.count));
    unknown ||= b.omitted > 0 || b.countsCapped;
  };
  bucket(value.block, 'outside-rows');
  let ordinal = -1;
  for (const row of value.rows) {
    need(count(row.ordinal, 99) && row.ordinal > ordinal && row.classified > 0);
    ordinal = row.ordinal; bucket(row, 'row', true);
  }
  need(entries <= r.entries && (!unknown || value.status === 'unknown'));
  return value;
}
export function safeAmazonStructure(kind, value) {
  if (typeof value !== 'string') return false;
  if (kind === 'paths') return value.split('>').length <= AMAZON_STRUCTURE_RULES.depth
    && value.split('>').every((s) => AMAZON_STRUCTURE_RULES.tags.includes(s));
  const highEntropy = value.split(/[-_]/).some((s) => {
    if (s.length < AMAZON_STRUCTURE_RULES.entropySegment) return false;
    const counts = [...s.toLowerCase()].reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
    return -[...counts.values()].reduce((n, v) => n + v / s.length * Math.log2(v / s.length), 0) > AMAZON_STRUCTURE_RULES.entropyMax;
  });
  return value.length <= 64 && !highEntropy && new RegExp(AMAZON_STRUCTURE_RULES.name).test(value)
    && !new RegExp(AMAZON_STRUCTURE_RULES.denied, 'i').test(value.replace(/[-_]/g, ''))
    && (kind === 'queries' || new RegExp(AMAZON_STRUCTURE_RULES[kind === 'classes' ? 'class' : 'attribute']).test(value));
}
export function safeAmazonUnknownLabel(value) {
  return typeof value === 'string' && new RegExp(AMAZON_STRUCTURE_RULES.unknownLabel).test(value)
    && value === value.replace(/\s+/g, ' ').trim()
    && safeAmazonStructure('queries', value.replace(/[ &']/g, '-'));
}
// Closed charge-free proof steps (amazon-page.mjs/amazon-native.mjs chargeFreeState): a failed layout step is
// reported alone; otherwise every failed independent step, in this order. An empty list proves the shape.
export const AMAZON_CHARGE_FREE_LAYOUT = ['summary-rows', 'summary-roots', 'charge-component', 'charge-column',
  'charge-populated'];
export const AMAZON_CHARGE_FREE_STEPS = ['method-scope', 'method-instrument', 'summary-text', 'status-unproven',
  'financial-component', 'refund-text', 'charge-text', 'amount-text', 'busy'];
const validChargeFree = (v) => Array.isArray(v) && (v.length === 1 && AMAZON_CHARGE_FREE_LAYOUT.includes(v[0])
  || v.every((step, i) => AMAZON_CHARGE_FREE_STEPS.includes(step)
    && (!i || AMAZON_CHARGE_FREE_STEPS.indexOf(v[i - 1]) < AMAZON_CHARGE_FREE_STEPS.indexOf(step))));
export function validateAmazonReadiness(d, terminal = false, stopObservation = false) {
  need(d && ['observed', 'unobserved', 'budget-held'].includes(d.status));
  const bindingKeys = terminal ? ['request', ...(d.source === 'not-admitted' ? [] : ['termination'])] : [];
  if (terminal) {
    need(count(d.request, 47));
    if (d.source !== 'not-admitted') need(['page-deadline', 'worker-watchdog'].includes(d.termination));
    if (['worker-watchdog', 'unavailable'].includes(d.source)) {
      need(d.termination === (d.source === 'worker-watchdog' ? 'worker-watchdog' : 'page-deadline'));
    }
  }
  if (d.status !== 'observed') {
    need(exact(d, ['status', 'source', ...bindingKeys]) && (d.status === 'budget-held'
      ? d.source === 'snapshot-budget'
      : ['worker-watchdog', 'not-admitted', 'unavailable'].includes(d.source)));
    return d;
  }
  const separated = Object.hasOwn(d, 'vocabulary');
  const chargeFree = Object.hasOwn(d, 'chargeFree');
  const facts = ['status', 'source', 'readyState', 'guards', 'summary', 'method', ...(chargeFree ? ['chargeFree'] : []),
    'elements', 'buckets', ...bindingKeys];
  const scoped = Object.hasOwn(d, 'scoped');
  need((!scoped || separated)
    && (!chargeFree || !stopObservation && d.scoped?.version === 2 && validChargeFree(d.chargeFree))
    && exact(d, [...facts, ...(separated ? ['vocabulary'] : ['classes', 'paths', 'truncated']), ...(scoped ? ['scoped'] : [])])
    && d.source === 'snapshot-checkpoint'
    && ['loading', 'interactive', 'complete'].includes(d.readyState)
    && exact(d.guards, ['urlUnchanged', 'authPassed', ...(terminal ? ['documentBound'] : [])])
    && d.guards.urlUnchanged === true && d.guards.authPassed === true
    && (!terminal || d.guards.documentBound === true)
    && exact(d.summary, ['roots', 'rows', 'labelRows', 'contentRows', 'populatedRows'])
    && ['roots', 'rows', 'labelRows', 'contentRows', 'populatedRows'].every((k) => count(d.summary[k]))
    && d.summary.labelRows <= d.summary.rows && d.summary.contentRows <= d.summary.rows
    && d.summary.populatedRows <= Math.min(d.summary.labelRows, d.summary.contentRows)
    && d.summary.populatedRows >= d.summary.labelRows + d.summary.contentRows - d.summary.rows
    && (!d.summary.rows || d.summary.roots > 0)
    && exact(d.method, ['blocks', 'nonbuttonContent'])
    && count(d.method.blocks) && typeof d.method.nonbuttonContent === 'boolean'
    && (!d.method.nonbuttonContent || d.method.blocks > 0)
    && (stopObservation || !(d.readyState === 'complete' && d.summary.populatedRows > 0 && d.method.nonbuttonContent))
    && !(d.readyState === 'complete' && Array.isArray(d.chargeFree) && !d.chargeFree.length)
    && (!stopObservation || d.readyState === 'complete' && d.scoped?.version === 2)
    && count(d.elements)
    && exact(d.buckets, [...AMAZON_STRUCTURE_RULES.tags, 'other'])
    && Object.values(d.buckets).every((n) => count(n))
    && Object.values(d.buckets).reduce((a, b) => a + b, 0) === d.elements
    && new TextEncoder().encode(JSON.stringify(d)).length <= AMAZON_STRUCTURE_RULES.readinessBytes);
  const v = separated ? d.vocabulary : d;
  if (separated) {
    need(new TextEncoder().encode(JSON.stringify(Object.fromEntries(facts.map((key) => [key, d[key]])))).length
      <= AMAZON_STRUCTURE_RULES.readinessFactsBytes
      && exact(v, ['status', 'classes', 'paths', 'omittedClasses', 'omittedPaths', 'countsCapped', 'truncated', 'structures'])
      && v.status === 'observed' && count(v.omittedClasses) && count(v.omittedPaths)
      && typeof v.countsCapped === 'boolean'
      && (!v.countsCapped || Math.max(v.omittedClasses, v.omittedPaths) === AMAZON_STRUCTURE_RULES.readinessCount)
      && v.truncated === (v.omittedClasses > 0 || v.omittedPaths > 0)
      && new TextEncoder().encode(JSON.stringify(v)).length <= AMAZON_STRUCTURE_RULES.readinessVocabularyBytes);
    const { structures, ...global } = v;
    need(exact(structures, AMAZON_STRUCTURE_RULES.readinessStructureTags)
      && new TextEncoder().encode(JSON.stringify(global)).length <= AMAZON_STRUCTURE_RULES.readinessGlobalVocabularyBytes);
    for (const tag of AMAZON_STRUCTURE_RULES.readinessStructureTags) {
      const s = structures[tag];
      need(exact(s, ['classes', 'omittedClasses', 'countsCapped', 'truncated'])
        && Array.isArray(s.classes) && s.classes.length <= AMAZON_STRUCTURE_RULES.readinessStructureClasses
        && new Set(s.classes).size === s.classes.length && s.classes.every((value) => safeAmazonStructure('classes', value))
        && count(s.omittedClasses) && typeof s.countsCapped === 'boolean'
        && (!s.countsCapped || s.omittedClasses === AMAZON_STRUCTURE_RULES.readinessCount)
        && s.truncated === (s.omittedClasses > 0)
        && (d.buckets[tag] > 0 || s.classes.length + s.omittedClasses === 0)
        && new TextEncoder().encode(JSON.stringify(s)).length <= AMAZON_STRUCTURE_RULES.readinessStructureBytes);
    }
  }
  need(typeof v.truncated === 'boolean');
  for (const kind of ['classes', 'paths']) need(Array.isArray(v[kind])
    && v[kind].length <= AMAZON_STRUCTURE_RULES.perSet && new Set(v[kind]).size === v[kind].length
    && v[kind].every((value) => safeAmazonStructure(kind, value)));
  if (scoped) validateAmazonScopedReadiness(d.scoped, AMAZON_STRUCTURE_RULES, safeAmazonStructure, d);
  return d;
}
export function normalizeAmazonSummaryLabel(value) {
  if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value)) return null;
  const label = value.toLowerCase().replace(/ +/g, ' ').trim();
  const r = AMAZON_STRUCTURE_RULES.summaryLabelDisclosure;
  if (!new RegExp(r.grammar).test(label) || new RegExp(r.denied).test(label.replace(/[^a-z]/g, ''))
    || new RegExp(r.urls).test(label)) return null;
  const highEntropy = label.split(/[^a-z]+/).some((s) => {
    if (s.length < AMAZON_STRUCTURE_RULES.entropySegment) return false;
    const counts = [...s].reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
    return -[...counts.values()].reduce((n, v) => n + v / s.length * Math.log2(v / s.length), 0)
      > AMAZON_STRUCTURE_RULES.entropyMax;
  });
  return highEntropy ? null : label;
}
function validateGateRoot(g, family, extra) {
  need(exact(g, ['family', 'candidateCount', 'selectedRootCount', 'rawElements', 'tightElements',
    'relation', 'ancestors', 'scope', ...extra]) && g.family === family
    && ['candidateCount', 'selectedRootCount', 'rawElements', 'tightElements'].every((k) => count(g[k]))
    && g.selectedRootCount <= g.candidateCount
    && ['contained', 'depth-held', 'absent'].includes(g.relation)
    && Array.isArray(g.ancestors) && g.ancestors.length <= AMAZON_STRUCTURE_RULES.scopeDepth);
  for (const a of g.ancestors) need(exact(a, ['tag', 'classes'])
    && [...AMAZON_STRUCTURE_RULES.tags, 'other'].includes(a.tag)
    && Array.isArray(a.classes) && a.classes.length <= 12
    && new Set(a.classes).size === a.classes.length && a.classes.every((c) => safeAmazonStructure('classes', c)));
  const s = g.scope;
  need(s && ['ok', 'absent', 'ambiguous', 'scope-budget-held'].includes(s.status)
    && (s.status !== 'absent' || g.selectedRootCount === 0)
    && (s.status !== 'ambiguous' || g.selectedRootCount > 1));
  if (s.status === 'ok') {
    need(exact(s, ['status', 'tree']));
    validateScopeTree(s.tree, family);
  } else need(exact(s, ['status', ...(s.status === 'scope-budget-held' && Object.hasOwn(s, 'reason') ? ['reason'] : [])])
    && (!Object.hasOwn(s, 'reason') || AMAZON_STRUCTURE_RULES.scopeHoldReasons.includes(s.reason)));
}
function validateScopeTree(tree, family) {
  const tender = ['summary', 'method'].includes(family);
  let nodes = 0;
  const visit = (n, depth) => {
    need(++nodes <= (['regular', 'grocery'].includes(family) ? AMAZON_STRUCTURE_RULES.orderScopeNodes
      : AMAZON_STRUCTURE_RULES.scopeNodes)
      && depth <= (tender ? AMAZON_STRUCTURE_RULES.tenderScopeDepth : AMAZON_STRUCTURE_RULES.scopeDepth));
    if (exact(n, ['type', 'label'])) {
      need(n.type === 'LABEL' && AMAZON_STRUCTURE_RULES.labels.includes(n.label));
    } else if (exact(n, ['type', 'bucket'])) {
      need(['DATE', 'MONEY', 'ORDERID', 'CARD4', 'NUM', 'TEXT'].includes(n.type)
        && ['1-4', '5-16', '17-64', '65+'].includes(n.bucket));
    } else {
      need(exact(n, ['tag', 'attributes', 'classes', 'children'])
        && (AMAZON_STRUCTURE_RULES.tags.includes(n.tag) || (tender && n.tag === 'other'))
        && Array.isArray(n.attributes) && n.attributes.length <= 16
        && Array.isArray(n.classes) && n.classes.length <= 12
        && n.attributes.every((v) => safeAmazonStructure('attributes', v))
        && n.classes.every((v) => safeAmazonStructure('classes', v))
        && Array.isArray(n.children));
      n.children.forEach((child) => visit(child, depth + 1));
    }
  };
  visit(tree, 0);
}
export function validateAmazonLedgerObservation(value) {
  const r = AMAZON_STRUCTURE_RULES.pagination;
  need(value && ['observed', 'unobserved', 'held'].includes(value.status));
  if (value.status === 'unobserved') { need(exact(value, ['status'])); return value; }
  if (value.status === 'held') {
    need(exact(value, ['status', 'reason']) && ['request-budget', 'budget', 'auth-required', 'auth-unknown',
      'captcha', 'redirect-blocked', 'response-too-large', 'timeout', 'aborted', 'document-changed',
      'read-failed', 'operation-held'].includes(value.reason));
    return value;
  }
  const counts = (v, keys) => exact(v, keys) && keys.every((k) => count(v[k], r.count));
  need(exact(value, ['status', 'counts', 'candidates', 'omittedCandidates', 'countsCapped'])
    && counts(value.counts, r.tags) && Array.isArray(value.candidates) && value.candidates.length <= r.candidates
    && count(value.omittedCandidates, r.count) && typeof value.countsCapped === 'boolean'
    && new TextEncoder().encode(JSON.stringify(value)).length <= r.bytes);
  if (!value.countsCapped) need(Object.values(value.counts).reduce((sum, n) => sum + n, 0)
    === value.candidates.length + value.omittedCandidates);
  for (const tag of r.tags) need(value.candidates.filter((c) => c?.tag === tag).length <= value.counts[tag]);
  for (const c of value.candidates) {
    need(exact(c, ['tag', 'activation', 'state', 'position', 'target']) && r.tags.includes(c.tag)
      && ['anchor', 'form', 'submit', 'unknown'].includes(c.activation)
      && ['enabled', 'disabled'].includes(c.state) && r.positions.includes(c.position) && c.position !== 'no-rows'
      && value.counts[c.tag] > 0
      && (c.activation !== 'anchor' || c.tag === 'a') && (c.tag !== 'form' || c.activation === 'form')
      && (c.activation !== 'form' || c.tag === 'form')
      && (c.activation !== 'submit' || ['button', 'input'].includes(c.tag)));
    const t = c.target;
    need(exact(t, ['class', 'method', 'queries', 'pageNumber', 'orderScope']) && r.targets.includes(t.class)
      && ['get', 'post', 'other', 'unknown'].includes(t.method) && counts(t.queries, r.queryNames)
      && [...r.grammar, 'unknown'].includes(t.pageNumber) && ['absent', 'valid', 'invalid', 'unknown'].includes(t.orderScope)
      && (t.pageNumber === 'absent') === (t.queries.pageNumber === 0)
      && (t.orderScope === 'absent') === (t.queries.orderID + t.queries.orderId === 0)
      && (c.activation !== 'anchor' || t.method === 'get')
      && (c.activation !== 'anchor' || (t.pageNumber !== 'unknown' && t.orderScope !== 'unknown'))
      && (c.activation === 'unknown') === (t.method === 'unknown'));
    if (['absent', 'invalid'].includes(t.class)) need(Object.values(t.queries).every((n) => n === 0));
    if (c.activation === 'unknown') need(t.class === 'absent');
    if (t.class === 'same-origin-admitted-ledger') need(t.queries.orderID + t.queries.orderId + t.queries.unknown
      + t.queries.ref + t.queries.ref_ + t.queries.language + t.queries.ie === 0
      && ['absent', 'valid'].includes(t.pageNumber));
  }
  return value;
}
function validatePaginationDiagnostics(value, pages, report) {
  const r = AMAZON_STRUCTURE_RULES.pagination;
  const counts = (v, keys) => exact(v, keys) && keys.every((k) => count(v[k], r.count));
  const tags = r.tags;
  const target = (t) => {
    need(exact(t, ['class', 'method', 'queries', 'pageNumber', 'orderScope'])
      && r.targets.includes(t.class) && r.methods.includes(t.method)
      && counts(t.queries, r.queryNames) && r.grammar.includes(t.pageNumber)
      && r.orderGrammar.includes(t.orderScope)
      && (t.pageNumber === 'absent') === (t.queries.pageNumber === 0)
      && (t.queries.orderID + t.queries.orderId === 0 || t.orderScope !== 'absent'));
    if (['absent', 'invalid'].includes(t.class)) need(Object.values(t.queries).every((n) => n === 0)
      && t.pageNumber === 'absent' && t.orderScope === 'absent');
    if (t.class === 'same-origin-admitted-ledger') need(t.queries.orderID + t.queries.orderId + t.queries.unknown === 0
      && t.orderScope === 'absent' && t.pageNumber !== 'invalid');
  };
  need(exact(value, ['pages', ...(value && Object.hasOwn(value, 'redirects') ? ['redirects'] : [])])
    && Array.isArray(value.pages) && value.pages.length <= pages.length
    && new TextEncoder().encode(JSON.stringify(value)).length <= r.bytes);
  const seen = new Set();
  let candidates = 0;
  let rendered = 0;
  if (Object.hasOwn(value, 'redirects')) {
    const d = value.redirects;
    need(exact(d, ['count', 'families', 'queries', 'candidates', 'omittedCandidates', 'countsCapped'])
      && count(d.count, r.count) && d.count > 0 && counts(d.families, r.pathFamilies) && counts(d.queries, r.linkQueries)
      && Array.isArray(d.candidates) && count(d.omittedCandidates, r.count) && typeof d.countsCapped === 'boolean');
    if (!d.countsCapped) need(Object.values(d.families).reduce((n, v) => n + v, 0) === d.count
      && d.candidates.length + d.omittedCandidates === d.count);
    const ordinals = new Set();
    for (const c of d.candidates) {
      need(exact(c, ['ordinal', 'family', 'queryNames']) && count(c.ordinal, 399) && !ordinals.has(c.ordinal)
        && r.pathFamilies.includes(c.family) && Array.isArray(c.queryNames)
        && new Set(c.queryNames).size === c.queryNames.length && c.queryNames.length <= r.linkQueries.length
        && c.queryNames.every((k) => r.linkQueries.includes(k)) && d.families[c.family] > 0);
      ordinals.add(c.ordinal);
    }
    candidates += d.candidates.length;
    need(candidates <= r.candidates);
  }
  for (const p of value.pages) {
    need(p && count(p.page, 47) && pages[p.page]?.kind === p.kind
      && ['ledger', 'order', 'orders'].includes(p.kind) && !seen.has(p.page)
      && ['ok', 'budget-held'].includes(p.status));
    seen.add(p.page);
    if (Object.hasOwn(p, 'rendered')) {
      need(p.kind === 'ledger' && report.progress?.mode === 'recent');
      validateAmazonLedgerObservation(p.rendered);
      if (p.rendered.status !== 'unobserved') {
        need(++rendered <= 1 && (p.rendered.reason === 'request-budget' || report.requests > pages.length));
      }
      if (p.rendered.status === 'observed') candidates += p.rendered.candidates.length;
      need(candidates <= r.candidates);
    }
    if (p.status === 'budget-held') {
      need(exact(p, ['page', 'kind', 'status', ...(Object.hasOwn(p, 'rendered') ? ['rendered'] : [])])
        && p.rendered?.status !== 'observed');
      continue;
    }
    need(exact(p, ['page', 'kind', 'status', 'candidates', 'omittedCandidates', 'countsCapped',
      ...(p.kind === 'ledger' ? ['counts', 'dates', 'rowOrder', 'comparison']
        : p.kind === 'order' ? ['presence', 'links'] : ['cards', 'families', 'orderIds']),
      ...(p.kind === 'ledger' && Object.hasOwn(p, 'rendered') ? ['rendered'] : [])])
      && Array.isArray(p.candidates) && count(p.omittedCandidates, r.count)
      && typeof p.countsCapped === 'boolean');
    candidates += p.candidates.length;
    need(candidates <= r.candidates);
    if (p.kind === 'ledger') {
      need(counts(p.counts, [...tags, 'selectedNext', 'readableNext', 'enqueuedNext'])
        && p.counts.enqueuedNext <= p.counts.readableNext && p.counts.readableNext <= p.counts.selectedNext
        && p.counts.selectedNext <= p.counts.a
        && counts(p.dates, ['inWindow', 'beforeWindow', 'afterWindow', 'invalid'])
        && r.rowOrders.includes(p.rowOrder)
        && p.comparison && ['unobserved', 'observed', 'budget-held'].includes(p.comparison.status));
      if (p.comparison.status !== 'observed') need(exact(p.comparison, ['status']));
      else need(exact(p.comparison, ['status', 'counts', 'countsCapped'])
        && counts(p.comparison.counts, tags) && typeof p.comparison.countsCapped === 'boolean');
      if (!p.countsCapped) need(tags.reduce((n, k) => n + p.counts[k], 0) === p.candidates.length + p.omittedCandidates);
      for (const c of p.candidates) {
        need(exact(c, ['tag', 'relNext', 'state', 'position', 'target', 'disposition'])
          && tags.includes(c.tag) && typeof c.relNext === 'boolean'
          && ['enabled', 'disabled'].includes(c.state) && r.positions.includes(c.position)
          && r.dispositions.includes(c.disposition));
        if (c.disposition === 'queued') need(c.tag === 'a'
          && c.target.class === 'same-origin-admitted-ledger' && c.target.method === 'get');
        target(c.target);
      }
    } else if (p.kind === 'order') {
      need(['present', 'absent'].includes(p.presence) && count(p.links, r.count)
        && (p.presence === 'present') === (p.links > 0));
      if (!p.countsCapped) need(p.links === p.candidates.length + p.omittedCandidates);
      for (const c of p.candidates) {
        need(exact(c, ['tag', 'target']) && c.tag === 'a'
          && ['same-origin-admitted-ledger', 'same-origin-unadmitted-ledger'].includes(c.target?.class)
          && c.target.method === 'get');
        target(c.target);
      }
    } else {
      const idKinds = ['attribute', 'knownParameter', 'unknownParameter'];
      need(count(p.cards, r.count) && p.cards > 0 && counts(p.families, r.pathFamilies) && counts(p.orderIds, idKinds)
        && idKinds.every((k) => p.orderIds[k] <= p.cards));
      if (!p.countsCapped) need(p.cards === p.candidates.length + p.omittedCandidates);
      const cards = new Set();
      for (const c of p.candidates) {
        need(exact(c, ['card', 'families', 'queries', 'orderIds']) && count(c.card, 399) && !cards.has(c.card)
          && counts(c.families, r.pathFamilies) && counts(c.queries, r.linkQueries)
          && exact(c.orderIds, idKinds) && idKinds.every((k) => typeof c.orderIds[k] === 'boolean'));
        cards.add(c.card);
      }
    }
  }
}
export function validateAmazonStructure(report) {
  need(exact(report, ['format', 'version', 'scope', 'code', 'requests', 'pages', 'stop',
    ...(report?.version === 3 && Object.hasOwn(report, 'navigationStop') ? ['navigationStop'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'fopoObservations') ? ['fopoObservations'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'fopoReads') ? ['fopoReads'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'navigationHolds') ? ['navigationHolds'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'tenderDiagnostics') ? ['tenderDiagnostics'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'itemDiagnostics') ? ['itemDiagnostics'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'paginationDiagnostics') ? ['paginationDiagnostics'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'progress') ? ['progress'] : []),
    ...(report?.version === 3 && Object.hasOwn(report, 'sizeStop') ? ['sizeStop'] : [])])
    && report.format === 'holdr.amazon-structure' && [2, 3].includes(report.version)
    && report.scope === 'value-free-unobserved-is-unknown' && count(report.requests, 48)
    && Array.isArray(report.pages) && report.pages.length <= report.requests
    && (report.stop === null || exact(report.stop, ['stage', 'evidence']))
    && (!['auth-required', 'auth-unknown', 'captcha'].includes(report.code) || report.stop !== null));
  if (Object.hasOwn(report, 'progress')) {
    const p = report.progress;
    need(exact(p, ['mode', 'state', 'position', 'runs', 'pagesDone', 'ordersDone', 'detailsPending',
      'yearsPending', 'terminalHeld', 'unresolvedHeld', 'ledgerPage', 'totalEstimate', 'linked', 'constructed',
      ...(Object.hasOwn(p, 'noDetailsLinkHeld') ? ['noDetailsLinkHeld'] : [])])
      && ['recent', 'backfill'].includes(p.mode) && ['in-progress', 'held', 'complete'].includes(p.state)
      && ['orders', 'details', 'payments', 'terminal-held', 'unresolved-held', 'complete'].includes(p.position)
      && ['runs', 'pagesDone', 'ordersDone', 'detailsPending', 'yearsPending', 'terminalHeld', 'unresolvedHeld', 'ledgerPage',
        'totalEstimate', 'linked', 'constructed'].every((k) => count(p[k]))
      && p.runs > 0 && p.detailsPending <= 400 && p.yearsPending <= 3 && p.terminalHeld <= 3 && p.unresolvedHeld <= 2000 && p.ledgerPage <= 999
      && (!Object.hasOwn(p, 'noDetailsLinkHeld') || (p.mode === 'backfill' && count(p.noDetailsLinkHeld, 400)
        && p.noDetailsLinkHeld <= p.unresolvedHeld))
      && (p.state !== 'complete' || (p.mode === 'backfill' && p.position === 'complete' && !p.detailsPending
        && !p.yearsPending && !p.terminalHeld && !p.unresolvedHeld && !p.ledgerPage)));
  }
  // The first page limit a response-too-large run stopped on: only with that code, and only
  // closed values, never a size or a count.
  if (Object.hasOwn(report, 'sizeStop')) {
    const s = report.sizeStop;
    need(report.code === 'response-too-large' && exact(s, ['kind', 'limit', 'bucket'])
      && AMAZON_SIZE_STOP.kinds.includes(s.kind) && AMAZON_SIZE_STOP.limits.includes(s.limit)
      && AMAZON_SIZE_STOP.buckets.includes(s.bucket));
  }
  // Reuse the existing closed authentication evidence contract without widening v1.
  validateAmazonReport({ format: 'holdr.amazon-shapes', version: 1,
    scope: 'structural-only-unobserved-is-unknown', code: report.code === 'budget' ? 'timeout' : report.code,
    requests: report.stop?.stage === 'response-status' || report.stop?.stage === 'response-document' ? 1 : 0,
    pages: [], ...(report.stop ? { stopStage: report.stop.stage, stopEvidence: report.stop.evidence } : {}) });
  const uffNames = new Set(), observationRequests = new Set();
  const validateNavigation = (d) => {
    need(exact(d, ['stopLocation', 'requestedKind', 'destinationClass',
      'finalPathTemplate', 'finalQueryNames', 'sameOrderId', 'trackingOnly', 'authPath', 'admittedPath',
      ...(d && Object.hasOwn(d, 'finalPathFamily') ? ['finalPathFamily'] : []),
      ...(d && Object.hasOwn(d, 'readiness') ? ['readiness'] : []),
      ...(d && Object.hasOwn(d, 'stopObservation') ? ['stopObservation'] : []),
      ...(d && Object.hasOwn(d, 'uffUnknownQueryNames') ? ['uffUnknownQueryNames'] : [])])
      && navigation.stopLocations.includes(d.stopLocation) && navigation.requestedKinds.includes(d.requestedKind)
      && navigation.destinationClasses.includes(d.destinationClass) && navigation.pathTemplates.includes(d.finalPathTemplate)
      && Array.isArray(d.finalQueryNames) && d.finalQueryNames.length <= navigation.queryNames.length
      && new Set(d.finalQueryNames).size === d.finalQueryNames.length
      && d.finalQueryNames.every((name) => navigation.queryNames.includes(name))
      && ['sameOrderId', 'trackingOnly', 'authPath', 'admittedPath'].every((key) => typeof d[key] === 'boolean')
      && (!Object.hasOwn(d, 'finalPathFamily') || navigation.pathFamilies.includes(d.finalPathFamily)));
    need(d.authPath === ['/ap/*', '/errors/validateCaptcha'].includes(d.finalPathTemplate)
      && d.admittedPath === [...navigation.listPaths, ...navigation.detailPaths].includes(d.finalPathTemplate)
      && (d.destinationClass !== 'auth-route' || d.authPath)
      && (d.destinationClass !== 'admitted-same-identity' || (d.admittedPath && !d.authPath))
      && (!d.sameOrderId || ['details', 'invoice'].includes(d.requestedKind)));
    if (Object.hasOwn(d, 'uffUnknownQueryNames')) need(d.stopLocation === 'before-snapshot'
      && d.requestedKind === 'details' && d.destinationClass === 'disallowed'
      && d.finalPathTemplate === navigation.uffPath && d.finalPathFamily === 'uff-details'
      && d.sameOrderId && !d.trackingOnly && !d.authPath && d.admittedPath && d.finalQueryNames.includes('unknown')
      && Array.isArray(d.uffUnknownQueryNames) && d.uffUnknownQueryNames.length > 0
      && d.uffUnknownQueryNames.length <= navigation.uffQueryNames
      && new Set(d.uffUnknownQueryNames).size === d.uffUnknownQueryNames.length
      && d.uffUnknownQueryNames.every((name) => typeof name === 'string'
        && new RegExp(navigation.uffQueryName).test(name) && !navigation.queryNames.filter((key) => key !== 'unknown').includes(name)));
    for (const name of d.uffUnknownQueryNames || []) uffNames.add(name);
    need(uffNames.size <= navigation.uffQueryNames);
    if (Object.hasOwn(d, 'stopObservation')) {
      const o = d.stopObservation;
      need(d.stopLocation === 'before-snapshot' && d.requestedKind === 'details'
        && d.destinationClass === 'disallowed' && d.finalPathFamily === 'fopo'
        && d.finalPathTemplate === 'other' && d.sameOrderId && !d.authPath && !d.admittedPath
        && !d.trackingOnly && !d.uffUnknownQueryNames && o
        && count(o.request, report.requests - 1)
        && exact(o, ['status', 'request', ...(o.status === 'observed' ? ['guards', 'readiness'] : ['reason'])]));
      if (o.status === 'observed') {
        need(exact(o.guards, ['documentBound', 'urlUnchanged', 'authPassed'])
          && Object.values(o.guards).every((v) => v === true));
        validateAmazonReadiness(o.readiness, false, true);
        need(o.readiness.status === 'observed');
      } else need(o.status === 'unobserved' && ['guard', 'budget', 'document-changed', 'unavailable'].includes(o.reason));
    }
    if (Object.hasOwn(d, 'readiness')) {
      validateAmazonReadiness(d.readiness, true);
      need(d.readiness.request < report.requests);
      need(!Object.hasOwn(d.readiness, 'chargeFree') || d.finalPathTemplate === '/your-orders/order-details');
      need(d.requestedKind === 'details' && !d.authPath && d.sameOrderId
        && (d.readiness.source === 'not-admitted'
          ? d.stopLocation === 'before-snapshot' && d.destinationClass === 'disallowed'
          : d.stopLocation === 'snapshot' && d.destinationClass === 'admitted-same-identity' && d.admittedPath
            && navigation.detailPaths.includes(d.finalPathTemplate)
            && d.finalPathTemplate !== '/gp/css/summary/print.html'
            && d.finalPathFamily === amazonPathFamily(d.finalPathTemplate)
            && d.finalQueryNames.filter((name) => ['orderID', 'orderId'].includes(name)).length === 1
            && d.finalQueryNames.every((name) => ['orderID', 'orderId', 'ref', 'ref_', 'language', 'ie'].includes(name))));
    }
  };
  if (Object.hasOwn(report, 'navigationStop')) {
    need(report.code !== 'complete');
    validateNavigation(report.navigationStop);
    if (report.navigationStop.stopObservation) need((report.code === 'redirect-blocked'
      || report.code === 'timeout' && report.navigationStop.stopObservation.status === 'unobserved'
        && report.navigationStop.stopObservation.reason === 'budget')
      && report.navigationStop.stopObservation.request === report.requests - 1);
    if (report.navigationStop.readiness) need(report.requests > 0
      && report.navigationStop.readiness.request === report.requests - 1 && report.code
      === (report.navigationStop.readiness.source === 'not-admitted' ? 'redirect-blocked' : 'timeout'));
  }
  if (Object.hasOwn(report, 'fopoObservations')) {
    const f = report.fopoObservations;
    need(exact(f, ['count', 'omitted', 'stops']) && count(f.count, report.requests) && f.count > 0
      && count(f.omitted, 48) && Array.isArray(f.stops) && f.stops.length <= 5
      && f.stops.length === Math.min(f.count, 5) && f.stops.length + f.omitted === f.count
      && report.progress?.mode === 'backfill' && f.count <= report.progress.noDetailsLinkHeld
      && new TextEncoder().encode(JSON.stringify(f)).length <= 65536);
    let previous = -1;
    const ordinals = new Set();
    for (const entry of f.stops) {
      need(exact(entry, ['ordinal', 'navigationStop']) && count(entry.ordinal, 399) && !ordinals.has(entry.ordinal));
      ordinals.add(entry.ordinal);
      const d = entry.navigationStop;
      need(d?.stopObservation && d.stopObservation.request > previous);
      validateNavigation(d);
      previous = d.stopObservation.request;
      observationRequests.add(previous);
    }
  }
  // Each /fopo/ receipt this run read for extraction: read, or held with one closed reason and,
  // for unread rows, their closed reasons counted. Counts and codes only.
  if (Object.hasOwn(report, 'fopoReads')) {
    const f = report.fopoReads, r = AMAZON_STRUCTURE_RULES.fopo;
    need(exact(f, ['count', 'reads']) && Array.isArray(f.reads) && f.reads.length > 0 && f.count === f.reads.length
      && count(f.count, Math.min(report.requests, r.reads)) && new TextEncoder().encode(JSON.stringify(f)).length <= 16384);
    const ordinals = new Set();
    for (const e of f.reads) {
      need(exact(e, ['ordinal', 'status', 'reason', 'rows', 'lines', 'unread']) && count(e.ordinal, 399) && !ordinals.has(e.ordinal)
        && ['read', 'held'].includes(e.status) && count(e.rows, 200) && Array.isArray(e.unread)
        && e.unread.length <= r.rowReasons.length
        && (e.status === 'read' ? e.reason === null && e.rows > 0 && e.lines === e.rows && !e.unread.length
          : r.reasons.includes(e.reason) && e.lines === 0 && (e.reason === 'row') === (e.unread.length > 0)));
      ordinals.add(e.ordinal);
      const reasons = new Set();
      for (const entry of e.unread) {
        need(Array.isArray(entry) && entry.length === 2 && r.rowReasons.includes(entry[0]) && !reasons.has(entry[0])
          && count(entry[1], 200) && entry[1] > 0);
        reasons.add(entry[0]);
      }
      need(e.unread.reduce((n, [, v]) => n + v, 0) <= e.rows);
    }
  }
  if (Object.hasOwn(report, 'navigationHolds')) {
    const h = report.navigationHolds;
    need(exact(h, ['count', 'orders']) && count(h.count, 5) && h.count > 0
      && Array.isArray(h.orders) && h.orders.length === h.count && h.count <= report.requests
      && (h.count < 5 || report.code === (h.orders.at(-1)?.reason === 'snapshot-timeout' ? 'timeout' : 'redirect-blocked')));
    const ordinals = new Set(), readinessRequests = new Set();
    let previousObservation = -1;
    for (const o of h.orders) {
      need(exact(o, ['ordinal', 'reason', 'navigationStop']) && count(o.ordinal, 399)
        && !ordinals.has(o.ordinal) && ['navigation-disallowed', 'snapshot-timeout'].includes(o.reason));
      ordinals.add(o.ordinal);
      validateNavigation(o.navigationStop);
      const d = o.navigationStop;
      if (d.stopObservation) {
        need(o.reason === 'navigation-disallowed' && !observationRequests.has(d.stopObservation.request)
          && d.stopObservation.request > previousObservation);
        previousObservation = d.stopObservation.request;
        observationRequests.add(d.stopObservation.request);
      }
      if (d.readiness) need(o.reason === (d.readiness.source === 'not-admitted'
        ? 'navigation-disallowed' : 'snapshot-timeout') && !readinessRequests.has(d.readiness.request)
        && [...readinessRequests].every((request) => request < d.readiness.request)
        && (!report.navigationStop?.readiness || h.count === 5
          || d.readiness.request < report.navigationStop.readiness.request));
      if (d.readiness) readinessRequests.add(d.readiness.request);
      need(['details', 'invoice'].includes(d.requestedKind) && !d.authPath && d.sameOrderId
        && (o.reason === 'navigation-disallowed'
          ? d.stopLocation === 'before-snapshot' && d.destinationClass === 'disallowed'
          : d.stopLocation === 'snapshot' && d.requestedKind === 'details'
            && d.destinationClass === 'admitted-same-identity' && d.admittedPath
            && navigation.detailPaths.filter((p) => p !== '/gp/css/summary/print.html').includes(d.finalPathTemplate)));
    }
    if (h.count === 5) need(Object.hasOwn(report, 'navigationStop')
      && Object.keys(report.navigationStop).every((k) =>
        JSON.stringify(report.navigationStop[k]) === JSON.stringify(h.orders.at(-1).navigationStop[k])));
  }
  if (report.navigationStop?.stopObservation) {
    const request = report.navigationStop.stopObservation.request;
    need([...observationRequests].every((n) => n < request || n === request
      && report.navigationHolds?.count === 5
      && report.navigationHolds.orders.at(-1).navigationStop.stopObservation?.request === request));
  }
  let failures = 0, scopes = 0;
  const families = new Set();
  for (const p of report.pages) {
    need(exact(p, ['kind', 'elements', 'truncated', 'attributes', 'classes', 'paths', 'queries',
      ...(report.version === 3 ? ['diagnostics'] : [])])
      && ['ledger', 'orders', 'order', ...(report.version === 3 ? ['returns'] : [])].includes(p.kind)
      && count(p.elements, amazonPageLimits(p.kind).elements) && typeof p.truncated === 'boolean');
    for (const kind of ['attributes', 'classes', 'paths', 'queries']) {
      need(Array.isArray(p[kind]) && p[kind].length <= 64 && new Set(p[kind]).size === p[kind].length
        && p[kind].every((v) => safeAmazonStructure(kind, v)));
    }
    if (report.version === 3) {
      const d = p.diagnostics;
      need(exact(d, ['failures', 'scopes', 'omittedScopes', 'exhausted', ...(Object.hasOwn(d, 'carrier') ? ['carrier'] : [])])
        && Array.isArray(d.failures) && Array.isArray(d.scopes) && count(d.omittedScopes)
        && typeof d.exhausted === 'boolean'
        && (!Object.hasOwn(d, 'carrier') || ['absent', 'present', 'expanded', 'held'].includes(d.carrier)));
      failures += d.failures.length; scopes += d.scopes.length;
      need(failures <= AMAZON_STRUCTURE_RULES.failures && scopes <= AMAZON_STRUCTURE_RULES.scopes);
      const records = new Set();
      for (const f of d.failures) {
        need(exact(f, ['record', 'domain', 'field', 'reason']) && count(f.record)
          && !records.has(f.record) && ['orders', 'payments', 'details', 'refunds'].includes(f.domain)
          && AMAZON_STRUCTURE_RULES.fields.includes(f.field) && AMAZON_STRUCTURE_RULES.reasons.includes(f.reason));
        records.add(f.record);
      }
      for (const s of d.scopes) {
        need(s && AMAZON_STRUCTURE_RULES.families.includes(s.family) && records.has(s.record)
          && !families.has(s.family) && ['ok', 'scope-budget-held'].includes(s.status));
        families.add(s.family);
        if (s.status === 'scope-budget-held') need(exact(s, ['record', 'family', 'status']));
        else {
          need(exact(s, ['record', 'family', 'status', 'tree']));
          validateScopeTree(s.tree, s.family);
        }
      }
    }
  }
  let itemBytes = 0;
  if (Object.hasOwn(report, 'paginationDiagnostics')) validatePaginationDiagnostics(report.paginationDiagnostics, report.pages, report);
  if (Object.hasOwn(report, 'itemDiagnostics')) {
    const d = report.itemDiagnostics;
    need(exact(d, ['orders']) && Array.isArray(d.orders) && d.orders.length <= 400);
    const ordinals = new Set();
    for (const o of d.orders) {
      need(exact(o, ['ordinal', 'observed', 'quantities', ...(Object.hasOwn(o, 'region') ? ['region'] : []),
        ...(Object.hasOwn(o, 'details') ? ['details'] : []), ...(Object.hasOwn(o, 'keywords') ? ['keywords'] : [])])
        && count(o.ordinal, d.orders.length - 1) && !ordinals.has(o.ordinal) && typeof o.observed === 'boolean'
        && exact(o.quantities, ['displayed', 'inferred'])
        && count(o.quantities.displayed, 100) && count(o.quantities.inferred, 100)
        && o.quantities.displayed + o.quantities.inferred <= 100
        && (o.observed || (o.quantities.displayed === 0 && o.quantities.inferred === 0 && !Object.hasOwn(o, 'details'))));
      ordinals.add(o.ordinal);
      if (Object.hasOwn(o, 'region')) {
        const r = o.region;
        need(o.observed);
        if (r?.status === 'budget-held') need(exact(r, ['status']));
        else {
          need(exact(r, ['mode', 'depthBucket', 'elementBucket', 'containsSummaryCandidate', 'containsMethodCandidate',
            'productLinksOutsideRows', ...(Object.hasOwn(r, 'rowKinds') ? ['rowKinds', 'itemTitlesOutsideRows'] : [])])
            && AMAZON_STRUCTURE_RULES.itemRegionModes.includes(r.mode)
            && AMAZON_STRUCTURE_RULES.itemRegionDepths.includes(r.depthBucket)
            && AMAZON_STRUCTURE_RULES.itemRegionElements.includes(r.elementBucket)
            && typeof r.containsSummaryCandidate === 'boolean' && typeof r.containsMethodCandidate === 'boolean'
            && count(r.productLinksOutsideRows)
            && (r.mode === 'derived-lca' ? r.depthBucket !== 'none' && r.elementBucket !== 'none'
              : r.depthBucket === 'none' && r.elementBucket === 'none')
            && (r.mode !== 'none' || (!r.containsSummaryCandidate && !r.containsMethodCandidate)));
          if (Object.hasOwn(r, 'rowKinds')) {
            need(exact(r.rowKinds, ['titleParent', 'containsOneTitle', 'other'])
              && Object.values(r.rowKinds).every((n) => count(n, 400))
              && Object.values(r.rowKinds).reduce((a, b) => a + b, 0) <= 400
              && count(r.itemTitlesOutsideRows));
          }
        }
      }
      if (Object.hasOwn(o, 'details')) {
        const s = o.details;
        need(o.observed && s && ['ok', 'budget-held'].includes(s.status));
        if (s.status === 'budget-held') need(exact(s, ['status']));
        else {
          need(exact(s, ['status', 'itemBlocks', 'selectors', 'items', 'snapshot', 'rejected',
            'productLinksOutsideRows', 'hidden', 'extra', 'rows', 'rowsOmitted', 'productAncestors',
            'ancestorDepthHeld', 'countsCapped', 'failed'])
            && ['itemBlocks', 'items', 'snapshot', 'rejected', 'productLinksOutsideRows', 'rowsOmitted', 'ancestorDepthHeld']
              .every((k) => count(s[k]))
            && Array.isArray(s.selectors) && s.selectors.length <= AMAZON_STRUCTURE_RULES.itemBlockSelectors.length
            && new Set(s.selectors).size === s.selectors.length
            && s.selectors.every((v) => AMAZON_STRUCTURE_RULES.itemBlockSelectors.includes(v))
            && (exact(s.hidden, ['blocking', 'ignored']) || exact(s.hidden, AMAZON_STRUCTURE_RULES.itemHiddenKinds))
            && Object.values(s.hidden).every((v) => count(v))
            && exact(s.extra, ['row', 'block']) && Object.values(s.extra).every((v) =>
              exact(v, ['amount', 'labelKeyword', 'controlIgnored', 'other']) && Object.values(v).every((n) => count(n)))
            && Array.isArray(s.rows) && s.rows.length <= 100
            && s.rows.every((r) => exact(r, ['quantity', 'price'])
              && ['displayed', 'absent', 'unparsed', 'conflict'].includes(r.quantity)
              && ['parsed', 'absent', 'unparsed', 'conflict', 'negative'].includes(r.price))
            && Array.isArray(s.productAncestors) && s.productAncestors.length <= AMAZON_STRUCTURE_RULES.itemComponents.length + 2
            && new Set(s.productAncestors.map((v) => v?.component)).size === s.productAncestors.length
            && s.productAncestors.every((v) => exact(v, ['component', 'count'])
              && [...AMAZON_STRUCTURE_RULES.itemComponents, 'none', 'other'].includes(v.component) && count(v.count))
            && typeof s.countsCapped === 'boolean'
            && Array.isArray(s.failed) && s.failed.length <= AMAZON_STRUCTURE_RULES.itemChecks.length
            && new Set(s.failed).size === s.failed.length
            && s.failed.every((v) => AMAZON_STRUCTURE_RULES.itemChecks.includes(v))
            && new TextEncoder().encode(JSON.stringify(s)).length <= AMAZON_STRUCTURE_RULES.gateOrderBytes);
        }
      }
      if (Object.hasOwn(o, 'keywords')) {
        need(o.observed);
        const k = validateAmazonItemKeywords(o.keywords);
        if (o.details?.status === 'ok') {
          const s = o.details, rows = Math.min(20000, k.rows.reduce((sum, row) => sum + row.classified, 0));
          need(k.block.classified === s.extra.block.labelKeyword && rows <= s.extra.row.labelKeyword
            && (k.rowsOmitted > 0 || rows === s.extra.row.labelKeyword)
            && k.rows.every((row) => row.ordinal < s.rows.length)
            && k.rows.length + k.rowsOmitted <= s.items
            && new TextEncoder().encode(JSON.stringify(s)).length
              + new TextEncoder().encode(JSON.stringify(k)).length <= AMAZON_STRUCTURE_RULES.gateOrderBytes);
        }
      }
      itemBytes += new TextEncoder().encode(JSON.stringify(o)).length;
    }
    need(itemBytes <= AMAZON_STRUCTURE_RULES.gateBytes);
  }
  if (Object.hasOwn(report, 'tenderDiagnostics')) {
    const d = report.tenderDiagnostics;
    const reasons = AMAZON_STRUCTURE_RULES.tenderReasons.filter((r) => r !== 'no-details-link'
      || Object.hasOwn(d?.counts || {}, r));
    need(exact(d, ['orders', 'counts', 'unknownLabels', 'unreportedUnknownLabelOrders',
      ...(Object.hasOwn(d || {}, 'summaryLabelDisclosure') ? ['summaryLabelDisclosure'] : [])])
      && Array.isArray(d.orders) && d.orders.length <= 400 && exact(d.counts, reasons)
      && Array.isArray(d.unknownLabels) && d.unknownLabels.length <= AMAZON_STRUCTURE_RULES.unknownLabels);
    const ordinals = new Set(), labels = new Set();
    let gateOrders = 0, gateBytes = itemBytes;
    if (Object.hasOwn(d, 'summaryLabelDisclosure')) {
      const b = d.summaryLabelDisclosure, r = AMAZON_STRUCTURE_RULES.summaryLabelDisclosure;
      need(exact(b, ['labels', 'suppressedRows', 'cappedRows', 'countsCapped'])
        && Array.isArray(b.labels) && b.labels.length <= r.labels
        && count(b.suppressedRows, r.count) && count(b.cappedRows, r.count)
        && typeof b.countsCapped === 'boolean'
        && (!b.countsCapped || b.suppressedRows === r.count || b.cappedRows === r.count));
      const seen = new Set();
      for (const entry of b.labels) {
        need(exact(entry, ['label', 'orders', 'money']) && typeof entry.label === 'string'
          && normalizeAmazonSummaryLabel(entry.label) === entry.label && !seen.has(entry.label)
          && count(entry.orders, d.counts['unknown-label']) && entry.orders >= 1 && entry.money === true);
        seen.add(entry.label);
      }
      const bytes = new TextEncoder().encode(JSON.stringify(b)).length;
      need(bytes <= r.bytes);
      gateBytes += bytes;
    }
    for (const o of d.orders) {
      need(exact(o, ['ordinal', 'reasons', ...(Object.hasOwn(o, 'gates') ? ['gates'] : []),
        ...(Object.hasOwn(o, 'proof') ? ['proof'] : [])])
        && count(o.ordinal, d.orders.length - 1) && !ordinals.has(o.ordinal)
        && Array.isArray(o.reasons) && o.reasons.length <= reasons.length && new Set(o.reasons).size === o.reasons.length
        && o.reasons.every((r) => reasons.includes(r)));
      ordinals.add(o.ordinal);
      if (Object.hasOwn(o, 'proof')) {
        const p = o.proof;
        need(o.reasons.length > 0 && exact(p, ['summary', 'failed', 'conflicts'])
          && exact(p.summary, ['observed', 'enteredRowLoop', 'outsideRows', 'outside', 'nestedCandidate', 'relations',
            'initialComplete268', 'hold270', 'hold286', 'evaluated286', 'legacyOutsideRows'])
          && ['observed', 'enteredRowLoop', 'outsideRows', 'nestedCandidate',
            'initialComplete268', 'hold270', 'hold286', 'evaluated286', 'legacyOutsideRows']
            .every((k) => typeof p.summary[k] === 'boolean')
          && exact(p.summary.outside, ['rows', 'labels', 'contents', 'financialLists', 'nonFinancialLists'])
          && Object.values(p.summary.outside).every((v) => count(v))
          && exact(p.summary.relations, ['ancestor', 'sibling', 'inside'])
          && Object.values(p.summary.relations).every((v) => count(v))
          && Array.isArray(p.failed) && p.failed.length > 0
          && p.failed.length <= AMAZON_STRUCTURE_RULES.proofChecks.length
          && new Set(p.failed).size === p.failed.length
          && p.failed.every((v) => AMAZON_STRUCTURE_RULES.proofChecks.includes(v))
          && Array.isArray(p.conflicts) && p.conflicts.length <= AMAZON_STRUCTURE_RULES.conflictSources.length
          && new Set(p.conflicts).size === p.conflicts.length
          && p.conflicts.every((v) => AMAZON_STRUCTURE_RULES.conflictSources.includes(v))
          && (!p.summary.enteredRowLoop || !p.summary.outsideRows)
          && p.summary.enteredRowLoop === (p.summary.initialComplete268 && !p.summary.hold270)
          && p.summary.evaluated286 === p.summary.enteredRowLoop
          && p.summary.nestedCandidate === (p.summary.relations.inside > 0)
          && (!p.summary.outsideRows || ['rows', 'labels', 'contents', 'financialLists']
            .some((k) => p.summary.outside[k] > 0))
          && (p.summary.observed || (!p.summary.enteredRowLoop && !p.summary.outsideRows
            && !p.summary.nestedCandidate && !p.summary.initialComplete268 && !p.summary.hold270
            && !p.summary.hold286 && !p.summary.evaluated286 && !p.summary.legacyOutsideRows
            && Object.values(p.summary.outside).every((v) => v === 0)
            && Object.values(p.summary.relations).every((v) => v === 0))));
        gateBytes += new TextEncoder().encode(JSON.stringify(p)).length;
        need(gateBytes <= AMAZON_STRUCTURE_RULES.gateBytes);
      }
      if (Object.hasOwn(o, 'gates')) {
        const g = o.gates;
        need(o.reasons.length > 0 && g && ['ok', 'gate-budget-held'].includes(g.status));
        if (g.status === 'gate-budget-held') { need(exact(g, ['status'])); continue; }
        need(exact(g, ['status', 'summary', 'method']) && ++gateOrders <= AMAZON_STRUCTURE_RULES.gateOrders);
        const bytes = new TextEncoder().encode(JSON.stringify(g)).length;
        gateBytes += bytes;
        need(bytes <= AMAZON_STRUCTURE_RULES.gateOrderBytes && gateBytes <= AMAZON_STRUCTURE_RULES.gateBytes);
        validateGateRoot(g.summary, 'summary', ['modernRoots', 'lists', 'allRows', 'directRows',
          'columns', 'rowsOmitted', 'extraText', ...(Object.hasOwn(g.summary, 'inspection') ? ['inspection'] : [])]);
        const s = g.summary;
        if (Object.hasOwn(s, 'inspection')) {
          const i = s.inspection;
          need(exact(i, ['candidates', 'lists', 'omittedCandidates', 'omittedLists'])
            && Array.isArray(i.candidates) && i.candidates.length <= 8
            && Array.isArray(i.lists) && i.lists.length <= 8
            && count(i.omittedCandidates) && count(i.omittedLists));
          for (const c of i.candidates) need(exact(c, ['relation', 'matchedBy', 'elements', 'outside'])
            && ['tight', 'ancestor', 'descendant', 'disjoint', 'unselected'].includes(c.relation)
            && Array.isArray(c.matchedBy) && c.matchedBy.length > 0
            && c.matchedBy.length <= AMAZON_STRUCTURE_RULES.summarySelectors.length
            && new Set(c.matchedBy).size === c.matchedBy.length
            && c.matchedBy.every((v) => AMAZON_STRUCTURE_RULES.summarySelectors.includes(v))
            && count(c.elements) && exact(c.outside, ['rows', 'labels', 'contents', 'lists'])
            && Object.values(c.outside).every((v) => count(v)));
          for (const l of i.lists) need(exact(l, ['liCount', 'textNodes', 'textNodesCapped', 'hasButton',
            'nearestComponent', ...AMAZON_STRUCTURE_RULES.listEvidence])
            && count(l.liCount) && count(l.textNodes)
            && ['textNodesCapped', 'hasButton', ...AMAZON_STRUCTURE_RULES.listEvidence].every((k) => typeof l[k] === 'boolean')
            && ['other', 'none', ...AMAZON_STRUCTURE_RULES.summaryComponents].includes(l.nearestComponent)
            && (!l.textNodesCapped || l.textNodes === 20000));
        }
        need(['modernRoots', 'lists', 'allRows', 'directRows', 'rowsOmitted'].every((k) => count(s[k]))
          && Array.isArray(s.columns) && s.columns.length <= AMAZON_STRUCTURE_RULES.summaryRows
          && Array.isArray(s.extraText) && s.extraText.length <= 4
          && new Set(s.extraText.map((p) => p?.position)).size === s.extraText.length
          && s.extraText.every((p) => exact(p, ['position', 'count'])
            && ['button', 'control', 'row-outside-columns', 'outside-rows'].includes(p.position)
            && count(p.count) && p.count > 0));
        for (const c of s.columns) need(exact(c, ['labels', 'contents', 'money'])
          && count(c.labels) && count(c.contents) && Array.isArray(c.money)
          && c.money.length === Math.min(c.contents, AMAZON_STRUCTURE_RULES.summaryRows)
          && c.money.every((v) => typeof v === 'boolean'));
        validateGateRoot(g.method, 'method', ['fragments', 'leafTag', 'networkTokens', 'markerKind',
          'markerCount', 'terminalCard', 'extraSuffix', 'prefixCard', 'exactMethodMatch']);
        const m = g.method;
        need(['fragments', 'networkTokens', 'markerCount'].every((k) => count(m[k]))
          && [...AMAZON_STRUCTURE_RULES.tags, 'none', 'other'].includes(m.leafTag)
          && ['none', 'ending-in', 'mask', 'mixed'].includes(m.markerKind)
          && ['terminalCard', 'extraSuffix', 'prefixCard', 'exactMethodMatch'].every((k) => typeof m[k] === 'boolean'));
      }
    }
    for (const reason of reasons) need(count(d.counts[reason], 400)
      && d.counts[reason] === d.orders.filter((o) => o.reasons.includes(reason)).length);
    for (const entry of d.unknownLabels) {
      need(exact(entry, ['label', 'orders']) && safeAmazonUnknownLabel(entry.label) && !labels.has(entry.label)
        && count(entry.orders, d.counts['unknown-label']) && entry.orders >= 3);
      labels.add(entry.label);
    }
    need(count(d.unreportedUnknownLabelOrders, d.counts['unknown-label']));
    need(gateBytes <= AMAZON_STRUCTURE_RULES.gateBytes);
  }
  need(new TextEncoder().encode(JSON.stringify(report)).length <= 640 * 1024);
  return report;
}
const date = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const id = (s) => typeof s === 'string' && /^\d{3}-\d{7}-\d{7}$/.test(s);
const uuid = (s) => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
export const AMAZON_PROOF_RETRY_REASONS = ['unknown-label', 'arithmetic', 'item-quantity'];
// Targeted re-reads: each order may be reserved at most this many times per cursor, by one of these selections.
export const AMAZON_REREAD_CHANCES = 2;
export const AMAZON_REREAD_SELECTIONS = ['held', 'targets'];
export const AMAZON_REREAD_TARGETS = { format: 'holdr.amazon-reread-targets', version: 1, orders: 10000, bytes: 2 * 1024 * 1024 };
export const amazonDetailOrder = (task) => typeof task === 'string'
  ? /^\/(?:your-orders\/order-details|gp\/your-account\/order-details|uff\/your-account\/order-details)\?orderI[Dd]=(\d{3}-\d{7}-\d{7})$/.exec(task)?.[1] || null : null;

// A queued or claimed retry task is exactly one closed kind: a private completed target, a consumed proof
// candidate, or a held detail task with a recorded targeted chance.
export function amazonRetryKind(c, task) {
  const r = c?.proofRetry, order = amazonDetailOrder(task);
  if (!r || !order) return null;
  if (r.targets?.some((t) => t.task === task)) return 'target';
  if (r.candidates.some((e) => e.task === task) && r.consumed.includes(order)) return 'proof';
  if (c.unresolvedHeld.includes(task) && r.rereads?.[order] >= 1) return 'held';
  return null;
}

// The operator's private, out-of-band target list: bound to one cursor, closed entries, every date in its window.
// Membership and eligibility are decided later against that cursor; a malformed list is refused whole.
export function validateAmazonRereadTargets(list, cursor) {
  const t = AMAZON_REREAD_TARGETS, ids = new Set();
  if (!exact(list, ['format', 'version', 'cursorId', 'orders']) || list.format !== t.format || list.version !== t.version
    || !cursor || list.cursorId !== cursor.id || !Array.isArray(list.orders) || !list.orders.length
    || list.orders.length > t.orders) throw Error('amazon-reread-targets-invalid');
  for (const entry of list.orders) {
    if (!exact(entry, ['orderId', 'date', 'total']) || !id(entry.orderId) || ids.has(entry.orderId) || !date(entry.date)
      || entry.date < cursor.window.from || entry.date > cursor.window.through
      || (entry.total !== null && !money(entry.total))) throw Error('amazon-reread-targets-invalid');
    ids.add(entry.orderId);
  }
  return list.orders;
}

// Only closed, validated diagnostic facts confer eligibility, never a nullable item alone.
export function amazonClosedProofReasons(input, ordinal) {
  const tender = input.structure.tenderDiagnostics?.orders.find((d) => d.ordinal === ordinal);
  const items = input.structure.itemDiagnostics?.orders.find((d) => d.ordinal === ordinal);
  return AMAZON_PROOF_RETRY_REASONS.filter((reason) => reason === 'item-quantity'
    ? items?.observed && items.details?.status === 'ok' && items.details.failed.includes('quantity-finalized')
    : tender?.reasons.includes(reason) && !!tender.proof);
}

export function amazonProofHeaderConflict(input, ordinal) {
  const order = input.staging.orders[ordinal];
  if (!order.tenderProof.conflict) return false;
  const sources = input.structure.tenderDiagnostics?.orders.find((d) => d.ordinal === ordinal)?.proof?.conflicts;
  return !sources?.length || sources.some((source) =>
    !['unknown-label', 'summary-hold', 'method-incomplete'].includes(source));
}

export function validateAmazonContinuation(c) {
  need(exact(c, ['version', 'id', 'revision', 'origin', 'window', 'queue', 'headers', 'completed', 'seen', 'signatures', 'stats',
    'terminalHeld', 'terminalRearmed', 'unresolvedHeld', 'unresolvedRearmed', 'constructedLists',
    ...['constructedDetails', 'noDetailsLinkHeld', 'proofRetry'].filter((key) => Object.hasOwn(c || {}, key))])
    && c.version === 1 && uuid(c.id) && count(c.revision, 10000)
    && ['https://amazon.com', 'https://www.amazon.com'].includes(c.origin)
    && exact(c.window, ['from', 'through', 'timeZone']) && date(c.window.from) && date(c.window.through)
    && (Date.parse(c.window.through) - Date.parse(c.window.from)) / 86400000 === 730);
  try { new Intl.DateTimeFormat('en-US', { timeZone: c.window.timeZone }); } catch { need(false); }
  need(typeof c.window.timeZone === 'string' && c.window.timeZone.length <= 64
    && /^[A-Za-z_+-]+(?:\/[A-Za-z_+0-9-]+){0,2}$/.test(c.window.timeZone));
  const task = (s) => {
    if (typeof s !== 'string' || s.length > 160) return false;
    const detail = /^\/(?:your-orders\/order-details|gp\/your-account\/order-details|uff\/your-account\/order-details)\?orderI[Dd]=(\d{3}-\d{7}-\d{7})$/.exec(s);
    if (detail) return true;
    const list = /^\/your-orders\/orders\?startIndex=(0|[1-9]\d{0,3}|10000)&timeFilter=year-(20\d{2})$/.exec(s);
    if (list) return Number(list[2]) >= Number(c.window.from.slice(0, 4)) && Number(list[2]) <= Number(c.window.through.slice(0, 4));
    return /^\/cpe\/yourpayments\/transactions(?:\?pageNumber=[1-9]\d{0,2})?$/.test(s);
  };
  for (const [key, max] of [['queue', 800], ['seen', 10000]]) need(Array.isArray(c[key]) && c[key].length <= max
    && c[key].every(task) && new Set(c[key]).size === c[key].length);
  need(c.queue.every((s) => !c.seen.includes(s)) && Array.isArray(c.completed) && c.completed.length <= 10000
    && c.completed.every(id) && new Set(c.completed).size === c.completed.length
    && Array.isArray(c.signatures) && c.signatures.length <= 10000
    && c.signatures.every((s) => typeof s === 'string' && /^(orders|payments):[a-f0-9]{16}$/.test(s))
    && new Set(c.signatures).size === c.signatures.length
    && Array.isArray(c.headers) && c.headers.length <= 400);
  need(Array.isArray(c.terminalHeld) && c.terminalHeld.length <= 3
    && new Set(c.terminalHeld.map((v) => v.year)).size === c.terminalHeld.length
    && c.terminalHeld.every((v) => exact(v, ['year', 'startIndex'])
      && Number.isSafeInteger(v.year) && v.year >= Number(c.window.from.slice(0, 4)) && v.year <= Number(c.window.through.slice(0, 4))
      && count(v.startIndex, 10000) && v.startIndex > 0)
    && Array.isArray(c.terminalRearmed) && c.terminalRearmed.length <= 3
    && new Set(c.terminalRearmed).size === c.terminalRearmed.length
    && c.terminalRearmed.every((year) => Number.isSafeInteger(year)
      && year >= Number(c.window.from.slice(0, 4)) && year <= Number(c.window.through.slice(0, 4)))
    && Array.isArray(c.constructedLists) && c.constructedLists.length <= 3
    && new Set(c.constructedLists).size === c.constructedLists.length
    && c.constructedLists.every((s) => task(s) && s.startsWith('/your-orders/orders?') && c.queue.includes(s)));
  for (const key of ['unresolvedHeld', 'unresolvedRearmed']) need(Array.isArray(c[key]) && c[key].length <= 2000
    && new Set(c[key]).size === c[key].length && c[key].every(task));
  need(c.unresolvedHeld.every((s) => !c.queue.includes(s) && !c.seen.includes(s)));
  for (const key of ['constructedDetails', 'noDetailsLinkHeld']) if (Object.hasOwn(c, key)) {
    need(Array.isArray(c[key]) && c[key].length <= 400 && new Set(c[key]).size === c[key].length
      && c[key].every((s) => task(s) && s.startsWith('/your-orders/order-details?orderID=')
        && (key === 'constructedDetails' ? c.queue.includes(s) || c.unresolvedHeld.includes(s)
          : c.unresolvedHeld.includes(s) && c.constructedDetails?.includes(s))));
  }
  const detailTasks = [...c.queue, ...c.unresolvedHeld].filter((s) => s.includes('/order-details?'));
  const headers = new Set();
  for (const h of c.headers) {
    need(exact(h, ['orderId', 'date', 'total', 'conflict']) && id(h.orderId) && !headers.has(h.orderId)
      && !c.completed.includes(h.orderId) && date(h.date) && h.date >= c.window.from && h.date <= c.window.through
      && (h.total === null || money(h.total)) && typeof h.conflict === 'boolean'
      && detailTasks.some((s) => s.endsWith('=' + h.orderId)));
    headers.add(h.orderId);
  }
  if (Object.hasOwn(c, 'proofRetry')) {
    const r = c.proofRetry;
    need(exact(r, ['candidates', 'consumed', 'queue', 'claim', 'observed',
      ...['targets', 'rereads'].filter((key) => Object.hasOwn(r || {}, key))])
      && Array.isArray(r.candidates) && r.candidates.length + c.headers.length <= 400
      && Array.isArray(r.consumed) && r.consumed.length <= 10000
      && r.consumed.every((order) => id(order) && c.completed.includes(order))
      && new Set(r.consumed).size === r.consumed.length
      && Array.isArray(r.queue) && r.queue.length + c.queue.length <= 800
      && new Set(r.queue).size === r.queue.length);
    need(r.observed && typeof r.observed === 'object' && !Array.isArray(r.observed)
      && Object.keys(r.observed).length <= 10000
      && Object.entries(r.observed).every(([order, revision]) => id(order) && c.completed.includes(order)
        && count(revision, c.revision)));
    const candidateIds = new Set();
    for (const entry of r.candidates) {
      const order = amazonDetailOrder(entry?.task), h = entry?.header;
      need(exact(entry, ['task', 'header', 'reasons']) && order && !candidateIds.has(order)
        && c.completed.includes(order) && c.seen.includes(entry.task) && Object.hasOwn(r.observed, order)
        && exact(h, ['orderId', 'date', 'total', 'conflict']) && h.orderId === order
        && date(h.date) && h.date >= c.window.from && h.date <= c.window.through
        && (h.total === null || money(h.total)) && typeof h.conflict === 'boolean'
        && Array.isArray(entry.reasons) && entry.reasons.length > 0
        && JSON.stringify(entry.reasons) === JSON.stringify(AMAZON_PROOF_RETRY_REASONS.filter((v) => entry.reasons.includes(v)))
        && ![...c.queue, ...c.unresolvedHeld].some((task) => amazonDetailOrder(task) === order));
      candidateIds.add(order);
    }
    // Targeted chances are permanent closed counts; private headers exist only for queued or claimed completed targets.
    if (Object.hasOwn(r, 'rereads')) need(r.rereads && typeof r.rereads === 'object' && !Array.isArray(r.rereads)
      && Object.keys(r.rereads).length <= 10000 && Object.entries(r.rereads).every(([order, n]) => id(order)
        && Number.isSafeInteger(n) && n >= 1 && n <= AMAZON_REREAD_CHANCES));
    if (Object.hasOwn(r, 'targets')) {
      need(Array.isArray(r.targets) && r.targets.length <= 800);
      const targetIds = new Set();
      for (const t of r.targets) {
        const order = amazonDetailOrder(t?.task), h = t?.header;
        need(exact(t, ['task', 'header']) && order && !targetIds.has(order)
          && c.completed.includes(order) && c.seen.includes(t.task) && r.rereads?.[order] >= 1
          && (r.queue.includes(t.task) || r.claim?.task === t.task)
          && exact(h, ['orderId', 'date', 'total', 'conflict']) && h.orderId === order
          && date(h.date) && h.date >= c.window.from && h.date <= c.window.through
          && (h.total === null || money(h.total)) && typeof h.conflict === 'boolean');
        targetIds.add(order);
      }
    }
    const busy = [...r.queue, ...(r.claim === null ? [] : [r.claim?.task])].map(amazonDetailOrder);
    need(r.queue.every((task) => amazonRetryKind(c, task)) && busy.every(Boolean) && new Set(busy).size === busy.length);
    if (r.claim !== null) need(exact(r.claim, ['task', 'runId']) && uuid(r.claim.runId)
      && !r.queue.includes(r.claim.task) && amazonRetryKind(c, r.claim.task));
    need(!c.unresolvedRearmed.some((task) => r.consumed.includes(amazonDetailOrder(task))));
  }
  need(detailTasks.every((s) => headers.has(s.slice(s.indexOf('=') + 1)))
    && exact(c.stats, ['pages', 'orders', 'payments', 'details', 'linked', 'constructed'])
    && Object.values(c.stats).every((n) => count(n, 20000))
    && c.stats.orders === c.completed.length + c.headers.length && c.stats.details === c.completed.length
    && new Set(detailTasks.map((s) => s.slice(s.indexOf('=') + 1))).size
      === c.headers.length
    && new TextEncoder().encode(JSON.stringify(c)).length <= 512 * 1024);
  return c;
}
const minor = (n) => Number.isSafeInteger(n) && Math.abs(n) <= 100000000;
const money = (v) => exact(v, ['currency', 'amountMinor']) && v.currency === 'USD' && minor(v.amountMinor);
const method = (m) => exact(m, ['kind', 'network', 'last4'])
  && ['card', 'balance', 'points', 'unknown'].includes(m.kind)
  && ['visa', 'mastercard', 'amex', 'discover', 'unknown'].includes(m.network)
  && (m.last4 === null || (m.kind === 'card' && typeof m.last4 === 'string' && /^\d{4}$/.test(m.last4)))
  && (m.kind === 'card' || m.network === 'unknown');
export const AMAZON_COVERAGE_REASONS = ['selector-failed', 'read-only-limit', 'budget', 'loop',
  'auth-stop', 'cancelled', 'request-failed', 'record-limit', 'unrecognized-record', 'no-details-link'];
export function validateAmazonStaging(s) {
  need(exact(s, ['format', 'version', 'source', 'window', 'coverage', 'resume', 'orders', 'payments',
    ...(s?.version === 3 ? ['runId'] : []), ...(Object.hasOwn(s || {}, 'mode') ? ['mode'] : []),
    ...(s?.version === 3 && Object.hasOwn(s || {}, 'refundEvidence') ? ['refundEvidence'] : [])])
    && s.format === 'holdr.amazon-staging' && [1, 2, 3].includes(s.version) && s.source === 'shared-household-amazon'
    && (s.version !== 3 || (typeof s.runId === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s.runId)))
    && exact(s.window, ['from', 'through', 'timeZone']) && date(s.window.from) && date(s.window.through)
    && (!Object.hasOwn(s, 'mode') || (s.version === 3 && ['recent', 'backfill'].includes(s.mode)))
    && (Date.parse(s.window.through) - Date.parse(s.window.from)) / 86400000 === (s.mode === 'backfill' ? 730 : 59)
    && typeof s.window.timeZone === 'string' && s.window.timeZone.length <= 64
    && /^[A-Za-z_+-]+(?:\/[A-Za-z_+0-9-]+){0,2}$/.test(s.window.timeZone));
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.window.timeZone }); }
  catch { need(false); }
  need(exact(s.coverage, ['orders', 'payments', 'details', 'refunds']));
  for (const [domain, c] of Object.entries(s.coverage)) {
    need(exact(c, ['status', 'reason', 'pages', 'records', 'rejected'])
      && ['held', 'partial'].includes(c.status) && AMAZON_COVERAGE_REASONS.includes(c.reason)
      && count(c.pages, 48) && count(c.records, 2000) && count(c.rejected)
      && (c.reason !== 'no-details-link' || (domain === 'details' && s.version === 3))
      && c.status === (c.records ? 'partial' : 'held'));
  }
  need(exact(s.resume, ['orders', 'payments', 'details', 'restartPayments'])
    && Array.isArray(s.resume.orders) && s.resume.orders.length <= (s.mode === 'backfill' ? 3 : 2)
    && s.resume.orders.every((v) => exact(v, ['year', 'startIndex'])
      && count(v.year, 2100) && v.year >= 2000 && count(v.startIndex, 10000))
    && (s.resume.payments === null || (exact(s.resume.payments, ['pageNumber']) && count(s.resume.payments.pageNumber, 999)
      && s.resume.payments.pageNumber > 0))
    && typeof s.resume.restartPayments === 'boolean'
    && Array.isArray(s.resume.details) && s.resume.details.length <= 400 && s.resume.details.every(id));
  need(Array.isArray(s.orders) && s.orders.length <= 400 && Array.isArray(s.payments) && s.payments.length <= 800);
  const orderIds = new Set();
  for (const o of s.orders) {
    need(exact(o, ['orderId', 'date', 'total', 'items', ...(s.version >= 2 ? ['paymentCoverage'] : []),
      ...(s.version === 3 ? ['paymentMethods', 'summary', 'tenderCoverage', 'tenderProof',
        ...(Object.hasOwn(o, 'itemProof') ? ['itemProof'] : []),
        ...(Object.hasOwn(o, 'refundSummary') ? ['refundSummary'] : []),
        ...(Object.hasOwn(o, 'chargeFree') ? ['chargeFree'] : [])] : [])])
      && id(o.orderId) && !orderIds.has(o.orderId)
      && date(o.date) && o.date >= s.window.from && o.date <= s.window.through
      && (o.total === null || money(o.total)) && Array.isArray(o.items) && o.items.length <= 100);
    orderIds.add(o.orderId);
    if (s.version >= 2) need(exact(o.paymentCoverage, ['status', 'reason'])
      && o.paymentCoverage.status === 'held' && o.paymentCoverage.reason === 'selector-failed');
    if (s.version === 3) {
      if (Object.hasOwn(o, 'refundSummary')) need(money(o.refundSummary) && o.refundSummary.amountMinor >= 0);
      // charge-free proof (#158): a closed positive no-charge status, only on an empty-details order with no total.
      if (Object.hasOwn(o, 'chargeFree')) need(exact(o.chargeFree, ['status', 'shipments'])
        && o.chargeFree.status === 'cancelled-not-charged' && count(o.chargeFree.shipments, 100) && o.chargeFree.shipments > 0
        && o.total === null && Array.isArray(o.items) && !o.items.length && Array.isArray(o.paymentMethods)
        && !o.paymentMethods.length && Array.isArray(o.summary) && !o.summary.length && !Object.hasOwn(o, 'refundSummary')
        && !Object.hasOwn(o, 'itemProof') && o.tenderCoverage === 'unknown' && !!o.tenderProof
        && Object.values(o.tenderProof).every((v) => v === false));
      need(Array.isArray(o.paymentMethods) && o.paymentMethods.length <= 8 && o.paymentMethods.every(method)
        && new Set(o.paymentMethods.map((m) => JSON.stringify(m))).size === o.paymentMethods.length
        && ['single-card-proven', 'multi-tender', 'unknown'].includes(o.tenderCoverage)
        && Array.isArray(o.summary) && o.summary.length <= 8);
      need(exact(o.tenderProof, ['methodComplete', 'summaryComplete', 'unknownMethod', 'unknownSummary', 'conflict'])
        && Object.values(o.tenderProof).every((v) => typeof v === 'boolean'));
      const kinds = new Set();
      for (const c of o.summary) {
        need(exact(c, ['kind', 'money']) && ['items-subtotal', 'shipping', 'tax', 'tip', 'gift-card', 'promotion', 'rewards', 'grand-total'].includes(c.kind)
          && !kinds.has(c.kind) && money(c.money) && (c.kind !== 'promotion' || c.money.amountMinor >= 0));
        kinds.add(c.kind);
      }
      const grand = o.summary.find((c) => c.kind === 'grand-total')?.money;
      need(!grand || !o.total || grand.amountMinor === o.total.amountMinor);
      if (o.tenderCoverage === 'single-card-proven') need(o.paymentMethods.length === 1
        && o.tenderProof.methodComplete && o.tenderProof.summaryComplete
        && !o.tenderProof.unknownMethod && !o.tenderProof.unknownSummary && !o.tenderProof.conflict
        && o.paymentMethods[0].kind === 'card' && o.paymentMethods[0].last4 !== null && o.paymentMethods[0].network !== 'unknown'
        && grand && grand.amountMinor > 0 && o.total && grand.amountMinor === o.total.amountMinor
        && !o.summary.some((c) => ['gift-card', 'rewards'].includes(c.kind))
        && ['items-subtotal', 'shipping', 'tax', 'grand-total'].every((kind) => kinds.has(kind))
        && o.summary.filter((c) => c.kind !== 'promotion').every((c) => c.money.amountMinor >= 0)
        && o.summary.filter((c) => ['items-subtotal', 'shipping', 'tax', 'tip'].includes(c.kind))
          .reduce((n, c) => n + c.money.amountMinor, 0)
          - (o.summary.find((c) => c.kind === 'promotion')?.money.amountMinor || 0) === grand.amountMinor);
    }
    const lines = new Set();
    for (const i of o.items) {
      const image = s.version === 3 && Object.hasOwn(i || {}, 'imageId');
      need(exact(i, ['itemId', 'title', 'quantity', 'unitPrice', ...(s.version === 3 ? ['lineOrdinal'] : []),
        ...(image ? ['imageId'] : [])])
        && (i.itemId === null || (typeof i.itemId === 'string' && /^[A-Z0-9]{10}$/.test(i.itemId)))
        && typeof i.title === 'string' && i.title.length > 0 && i.title.length <= (s.version === 3 ? 2048 : 240)
        && !/[\x00-\x1f<>]|(?:https?:|@)/i.test(i.title)
        && (i.quantity === null || (count(i.quantity, 999) && i.quantity > 0))
        && (i.unitPrice === null || money(i.unitPrice))
        && (!image || (typeof i.imageId === 'string' && new RegExp(AMAZON_STRUCTURE_RULES.itemImage.id).test(i.imageId))));
      if (s.version === 3) {
        need(count(i.lineOrdinal, 99) && !lines.has(i.lineOrdinal));
        lines.add(i.lineOrdinal);
      }
    }
    if (s.version === 3 && Object.hasOwn(o, 'itemProof')) {
      const p = o.itemProof;
      need(exact(p, ['complete', 'unknownLine', 'conflict']) && Object.values(p).every((v) => typeof v === 'boolean'));
      if (p.complete) need(!p.unknownLine && !p.conflict && !o.tenderProof.conflict && o.items.length > 0
        && o.items.every((i, ordinal) => i.lineOrdinal === ordinal && i.quantity !== null
          && i.unitPrice !== null && i.unitPrice.amountMinor >= 0)
        && o.items.reduce((sum, i) => sum + i.quantity * i.unitPrice.amountMinor, 0)
          === o.summary.find((c) => c.kind === 'items-subtotal')?.money.amountMinor);
    }
  }
  const occurrences = new Set();
  for (const p of s.payments) {
    need(exact(p, ['date', 'money', 'kind', 'status', 'method', 'orderIds', 'identity',
      ...(s.version === 3 ? ['provenance'] : [])])
      && date(p.date) && p.date >= s.window.from && p.date <= s.window.through && money(p.money)
      && ['charge', 'refund', 'unknown'].includes(p.kind) && ['completed', 'pending', 'unknown'].includes(p.status)
      && method(p.method) && Array.isArray(p.orderIds) && p.orderIds.length <= 20 && p.orderIds.every(id)
      && new Set(p.orderIds).size === p.orderIds.length
      && ['native-row', 'ambiguous-repeat'].includes(p.identity));
    if (s.version === 3) {
      const v = p.provenance;
      need(exact(v, ['source', 'status', 'page', 'ordinal']) && v.source === 'ledger'
        && ['Charged', 'Refunded', 'Pending'].includes(v.status) && count(v.page, 47) && count(v.ordinal, 799)
        && !occurrences.has(v.page + ':' + v.ordinal)
        && (v.status === 'Pending' ? p.status === 'pending' && p.kind === 'unknown'
          : p.status === 'completed' && p.kind === (v.status === 'Refunded' ? 'refund' : 'charge')));
      occurrences.add(v.page + ':' + v.ordinal);
    }
  }
  if (Object.hasOwn(s, 'refundEvidence')) validateAmazonRefundEvidence(s);
  need(s.coverage.orders.records === s.orders.length && s.coverage.payments.records === s.payments.length
    && s.coverage.details.records === s.orders.reduce((n, o) => n + o.items.length, 0)
    && s.coverage.refunds.records === s.payments.filter((p) => p.kind === 'refund').length
      + (s.refundEvidence || []).filter((r) => r.kind === 'refund').length);
  need(new TextEncoder().encode(JSON.stringify(s)).length <= AMAZON_CAPTURE_BYTES - 640 * 1024);
  return s;
}
// Displayed statuses only: a return carries no money; refund money/destinations appear only when stated.
// Order-details records describe that capture's own staged order and lines; Returns-page records are dated in-window.
function validateAmazonRefundEvidence(s) {
  const r = AMAZON_STRUCTURE_RULES.refunds, phrases = r.phrases, staged = new Map(s.orders.map((o) => [o.orderId, o]));
  need(s.version === 3 && Array.isArray(s.refundEvidence) && s.refundEvidence.length <= r.records);
  const occurrences = new Set();
  for (const e of s.refundEvidence) {
    const p = e?.provenance, phrase = typeof p?.phrase === 'string' && Object.hasOwn(phrases, p.phrase) ? phrases[p.phrase] : null;
    need(exact(e, ['kind', 'status', 'date', 'money', 'orderIds', 'destinations', 'items', 'provenance'])
      && exact(p, ['source', 'page', 'ordinal', 'phrase']) && ['order-details', 'returns-page'].includes(p.source)
      && count(p.page, 47) && count(p.ordinal, 799) && phrase && phrase[0] === e.kind && phrase[1] === e.status
      && !occurrences.has(p.source + ':' + p.page + ':' + p.ordinal)
      && Array.isArray(e.orderIds) && e.orderIds.length === 1 && id(e.orderIds[0])
      && (e.date === null || (date(e.date) && e.date >= s.window.from && e.date <= s.window.through))
      && Array.isArray(e.destinations) && e.destinations.length <= r.destinations
      && Array.isArray(e.items) && e.items.length <= r.items);
    occurrences.add(p.source + ':' + p.page + ':' + p.ordinal);
    if (e.kind === 'return') need(e.money === null && e.destinations.length === 0);
    else {
      const positive = (v) => money(v) && v.amountMinor > 0;
      // Only a completed refund states money, a date or destinations: a pending one is expected, never executed.
      need(e.status === 'completed' || (e.money === null && e.date === null && e.destinations.length === 0));
      need((e.money === null || positive(e.money))
        && e.destinations.every((d) => exact(d, ['method', 'money']) && method(d.method) && d.method.kind !== 'unknown'
          && (d.money === null || positive(d.money)))
        && new Set(e.destinations.map((d) => JSON.stringify(d.method))).size === e.destinations.length);
      const stated = e.destinations.reduce((n, d) => n + (d.money?.amountMinor || 0), 0);
      need(e.money === null ? stated === 0 : stated <= e.money.amountMinor
        && (!e.destinations.length || e.destinations.some((d) => d.money === null) || stated === e.money.amountMinor));
    }
    const order = staged.get(e.orderIds[0]), lines = new Set();
    // A Returns-page return is dated by its created date; its refund may not show one.
    need(p.source === 'order-details' ? !!order : e.kind === 'refund' || e.date !== null);
    for (const i of e.items) {
      need(exact(i, ['lineOrdinal', 'itemId', 'title', 'units'])
        && (i.itemId === null || (typeof i.itemId === 'string' && /^[A-Z0-9]{10}$/.test(i.itemId)))
        && (i.title === null || (typeof i.title === 'string' && i.title.length > 0 && i.title.length <= 2048
          && !/[\x00-\x1f\x7f-\x9f\u2028\u2029<>]|(?:https?:|@)/i.test(i.title)))
        && (i.units === null || (count(i.units, 999) && i.units > 0)));
      if (p.source === 'order-details') {
        const line = order.items.find((l) => l.lineOrdinal === i.lineOrdinal);
        need(count(i.lineOrdinal, 99) && line && !lines.has(i.lineOrdinal) && i.itemId === line.itemId && i.title === null);
        lines.add(i.lineOrdinal);
      } else need(i.lineOrdinal === null && (i.itemId !== null || i.title !== null));
    }
  }
}
export function validateAmazonCapture(input) {
  need(exact(input, ['structure', 'staging', ...(Object.hasOwn(input || {}, 'continuation') ? ['continuation'] : []),
    ...(Object.hasOwn(input || {}, 'fresh') ? ['fresh'] : [])]));
  validateAmazonStructure(input.structure);
  validateAmazonStaging(input.staging);
  // Amazon Fresh Item Lists (amazon-fresh-items.mjs): only for orders this capture stages.
  if (Object.hasOwn(input, 'fresh')) {
    try { validateAmazonFreshItemLists(input.fresh, input.staging); } catch { need(false); }
  }
  if (input.structure.progress) need(input.structure.progress.mode === (input.staging.mode || 'recent'));
  if (Object.hasOwn(input, 'continuation')) {
    const v = input.continuation;
    need(exact(v, ['before', 'after']) && input.staging.mode === 'backfill'
      && (v.before === null || (exact(v.before, ['id', 'revision']) && uuid(v.before.id) && count(v.before.revision, 9999))));
    validateAmazonContinuation(v.after);
    for (const entry of v.after.proofRetry?.candidates || []) {
      const ordinal = input.staging.orders.findIndex((o) => o.orderId === entry.header.orderId);
      if (ordinal < 0) continue;
      if (v.after.proofRetry.consumed.includes(entry.header.orderId)
        && !input.structure.itemDiagnostics?.orders.some((d) => d.ordinal === ordinal && d.observed)) continue;
      const order = input.staging.orders[ordinal];
      need(entry.header.orderId === order.orderId && entry.header.date === order.date
        && entry.header.conflict === amazonProofHeaderConflict(input, ordinal)
        && (entry.header.total === null ? order.total === null
          : entry.header.total.currency === order.total?.currency && entry.header.total.amountMinor === order.total?.amountMinor)
        && JSON.stringify(entry.reasons) === JSON.stringify(amazonClosedProofReasons(input, ordinal)));
    }
    need(v.after.revision === (v.before?.revision || 0) + 1 && (!v.before || v.before.id === v.after.id)
      && JSON.stringify(v.after.window) === JSON.stringify(input.staging.window));
    const p = input.structure.progress;
    const pendingYears = new Map();
    let ledgerPage = null, ledgerPending = false;
    for (const task of v.after.queue) {
      const url = new URL(task, v.after.origin);
      if (url.pathname === '/your-orders/orders') {
        const year = Number(url.searchParams.get('timeFilter').slice(5)), startIndex = Number(url.searchParams.get('startIndex'));
        if (!pendingYears.has(year) || startIndex < pendingYears.get(year)) pendingYears.set(year, startIndex);
      } else if (url.pathname === '/cpe/yourpayments/transactions') {
        ledgerPending = true;
        if (url.searchParams.has('pageNumber')) ledgerPage = Math.min(ledgerPage ?? Infinity, Number(url.searchParams.get('pageNumber')));
      }
    }
    const resume = input.staging.resume;
    need(resume.details.length === v.after.headers.length && resume.details.every((id) => v.after.headers.some((h) => h.orderId === id))
      && resume.orders.length === pendingYears.size && resume.orders.every((o) => pendingYears.get(o.year) === o.startIndex)
      && resume.restartPayments === ledgerPending && (resume.payments?.pageNumber ?? null) === ledgerPage);
    need(p?.mode === 'backfill' && p.runs === v.after.revision
      && p.detailsPending === v.after.headers.length && p.terminalHeld === v.after.terminalHeld.length
      && p.unresolvedHeld === v.after.unresolvedHeld.length
      && (p.noDetailsLinkHeld ?? 0) === (v.after.noDetailsLinkHeld?.length || 0)
      && p.ordersDone === v.after.completed.length && p.pagesDone === v.after.stats.pages
      && p.yearsPending === pendingYears.size && p.ledgerPage === (ledgerPage || 0)
      && p.totalEstimate === v.after.stats.orders && p.linked <= v.after.stats.linked && p.constructed <= v.after.stats.constructed
      && (p.state !== 'complete' || (!v.after.queue.length && !v.after.terminalHeld.length && !v.after.unresolvedHeld.length)));
  }
  // A returns-only read keeps the 730-day window but never has, reads or replaces a backfill cursor.
  const returnsOnly = input.staging.mode === 'backfill' && !Object.hasOwn(input, 'continuation')
    && !input.structure.progress && Object.hasOwn(input.staging, 'refundEvidence')
    && !input.staging.orders.length && !input.staging.payments.length
    && !input.staging.resume.orders.length && !input.staging.resume.details.length && input.staging.resume.payments === null
    && input.structure.pages.every((p) => p.kind === 'returns')
    && input.staging.refundEvidence.every((e) => e.provenance.source === 'returns-page');
  need(input.staging.mode !== 'backfill' || Object.hasOwn(input, 'continuation') || returnsOnly);
  need(returnsOnly || (input.structure.pages.every((p) => p.kind !== 'returns')
    && (input.staging.refundEvidence || []).every((e) => e.provenance.source === 'order-details')));
  if (input.structure.paginationDiagnostics?.pages.some((p) => Object.hasOwn(p, 'rendered'))) {
    need(input.staging.mode !== 'backfill' && !Object.hasOwn(input, 'continuation')
      && input.structure.progress?.mode === 'recent');
  }
  const redirects = input.structure.paginationDiagnostics?.redirects;
  if (redirects) {
    need(input.staging.mode === 'backfill' && input.structure.progress
      && redirects.count <= input.structure.requests
      && redirects.count <= input.structure.progress.noDetailsLinkHeld
      && redirects.count <= input.staging.coverage.details.rejected);
    for (const d of redirects.candidates) {
      const order = input.staging.orders[d.ordinal];
      need(order && input.staging.resume.details.includes(order.orderId)
        && input.continuation.after.noDetailsLinkHeld?.some((task) => task.endsWith('=' + order.orderId)));
    }
  }
  if (input.structure.fopoObservations) {
    const f = input.structure.fopoObservations;
    need(input.staging.mode === 'backfill' && input.continuation && redirects
      && f.count <= redirects.families.fopo && f.count <= input.staging.coverage.details.rejected);
    let missingRedirects = 0;
    for (const entry of f.stops) {
      const order = input.staging.orders[entry.ordinal];
      const redirect = redirects.candidates.find((d) => d.ordinal === entry.ordinal);
      if (!redirect) missingRedirects++;
      need(order && input.staging.resume.details.includes(order.orderId)
        && !input.continuation.after.completed.includes(order.orderId)
        && input.continuation.after.noDetailsLinkHeld?.some((task) => task.endsWith('=' + order.orderId))
        && missingRedirects <= redirects.omittedCandidates
        && (!redirect || redirect.family === 'fopo'
          && JSON.stringify([...redirect.queryNames].sort()) === JSON.stringify([...entry.navigationStop.finalQueryNames].sort())));
    }
  }
  // /fopo/ receipts: a list read from one is exactly one read of this run, and its order has the
  // in-store form (no item lines, single-card proven, its task done); a held read stages no list and its task holds.
  const fopoLists = (input.fresh?.lists || []).filter((l) => Object.hasOwn(l, 'source'));
  const fopoReads = input.structure.fopoReads?.reads || [];
  for (const list of fopoLists) {
    const ordinal = input.staging.orders.findIndex((o) => o.orderId === list.orderId), order = input.staging.orders[ordinal];
    need(fopoReads.some((e) => e.ordinal === ordinal && e.status === 'read' && e.rows === list.rows && e.lines === list.lines.length)
      && order.items.length === 0 && order.tenderCoverage === 'single-card-proven'
      && order.itemProof?.complete === false && order.itemProof.unknownLine === true && order.itemProof.conflict === false
      && !Object.hasOwn(order, 'refundSummary') && !Object.hasOwn(order, 'chargeFree')
      && !input.staging.resume.details.includes(order.orderId)
      && (!input.continuation || input.continuation.after.completed.includes(order.orderId)));
  }
  for (const e of fopoReads) {
    const order = input.staging.orders[e.ordinal];
    need(order && (e.status === 'read') === fopoLists.some((l) => l.orderId === order.orderId)
      && (e.status === 'read' || (input.staging.resume.details.includes(order.orderId)
        && (input.continuation ? !input.continuation.after.completed.includes(order.orderId)
          && !!input.continuation.after.noDetailsLinkHeld?.some((task) => task.endsWith('=' + order.orderId))
          : !!input.structure.navigationHolds?.orders.some((h) => h.ordinal === e.ordinal)))));
  }
  if (input.structure.itemDiagnostics) {
    need(input.structure.itemDiagnostics.orders.length === input.staging.orders.length);
    for (const d of input.structure.itemDiagnostics.orders) {
      const o = input.staging.orders[d.ordinal];
      const ready = o.itemProof?.complete && o.tenderCoverage === 'single-card-proven';
      need((!d.observed || ready || Object.hasOwn(d, 'details'))
        && (!o.itemProof?.complete || !d.region || d.region.status === 'budget-held'
          || (d.region.mode !== 'none' && !d.region.productLinksOutsideRows
          && (!d.region.rowKinds || (!d.region.itemTitlesOutsideRows
            && Object.values(d.region.rowKinds).reduce((a, b) => a + b, 0) === o.items.length
            && (d.region.mode !== 'derived-lca' || !d.region.rowKinds.other)))
          && (d.region.mode !== 'derived-lca' || (!d.region.containsSummaryCandidate
            && !d.region.containsMethodCandidate && d.region.elementBucket !== 'over-4000'))))
        && (!d.quantities.inferred || (o.itemProof?.complete && o.tenderProof.summaryComplete && !o.tenderProof.conflict
          && d.quantities.inferred <= o.items.filter((i) => i.quantity === 1).length))
        && (!o.itemProof?.complete || (d.observed && d.quantities.displayed + d.quantities.inferred === o.items.length)));
    }
  }
  if (input.structure.navigationHolds) {
    for (const h of input.structure.navigationHolds.orders) {
      const order = input.staging.orders[h.ordinal];
      need(order && input.staging.resume.details.includes(order.orderId));
    }
    need(input.staging.coverage.details.rejected >= input.structure.navigationHolds.count
      && input.staging.coverage.details.reason !== 'read-only-limit');
  }
  if (input.structure.tenderDiagnostics) {
    need(input.structure.tenderDiagnostics.orders.length === input.staging.orders.length);
    for (const d of input.structure.tenderDiagnostics.orders) if (d.reasons.includes('no-details-link')) {
      const order = input.staging.orders[d.ordinal];
      need(order && input.staging.resume.details.includes(order.orderId)
        && input.staging.version === 3 && order.tenderCoverage === 'unknown' && order.items.length === 0
        && !order.tenderProof.methodComplete && !order.tenderProof.summaryComplete
        && !input.structure.navigationHolds?.orders.some((h) => h.ordinal === d.ordinal));
    }
  }
  if (input.staging.coverage.details.reason === 'no-details-link') {
    need(input.structure.tenderDiagnostics?.counts['no-details-link'] > 0);
  }
  // charge-free proof (#158): only a completed, unparsed details read of this run stages it (matched by ordinal).
  for (const [ordinal, order] of input.staging.orders.entries()) if (Object.hasOwn(order, 'chargeFree')) {
    need(input.structure.itemDiagnostics?.orders.find((d) => d.ordinal === ordinal)?.observed === false
      && !input.staging.resume.details.includes(order.orderId)
      && !input.structure.navigationHolds?.orders.some((h) => h.ordinal === ordinal));
  }
  need(new TextEncoder().encode(JSON.stringify(input)).length <= AMAZON_CAPTURE_BYTES);
  return input;
}
