import { AMAZON_STRUCTURE_RULES } from '../amazon-capture.mjs';

// Synthetic values; tag/class relationships model the approved value-free modern skeleton.
export const modernSummary = (rows) => `<div class="a-column">
  <div class="a-row a-spacing-small"><div>Order summary</div></div>
  <ul class="a-unordered-list a-nostyle a-vertical">${rows.map(([label, amount]) =>
    `<li><span class="a-list-item"><div class="a-row od-line-item-row">
      <div class="a-column od-line-item-row-label"><span class="a-size-base"><span>${label}</span></span></div>
      <div class="a-column od-line-item-row-content a-span-last"><span class="a-size-base a-color-base">${amount}</span></div>
    </div></span></li>`).join('')}</ul></div>`;

export const modernMethod = (display = 'Synthetic Rewards Visa ending in 4242') => `<div>
  <div class="a-spacing-micro">Payment method</div><div class="a-section"><div></div><div>
    <div><div aria-label="Synthetic instrument"><div><div><div aria-label="Synthetic display">
      <div data-testid="synthetic-instrument" style=""><div role="presentation" style="" data-testid="synthetic-icon">
        <div role="presentation" style="" data-testid="synthetic-icon-body"><div style=""></div></div></div>
        <div style=""><div data-testid="synthetic-name"><div data-testid="synthetic-name-body">
          <span style="" data-testid="synthetic-network">${display}</span>
        </div></div></div></div>
    </div></div></div></div><div style=""></div><div style="" data-testid="synthetic-control">
      <button aria-label="Synthetic control" role="button" style="" type="button">
        <div data-testid="synthetic-control-icon"></div><div data-testid="synthetic-control-decoration"></div>
        <div style=""><div style="" data-testid="synthetic-control-label">Synthetic button control</div></div>
      </button></div></div>
  </div></div></div>`;

export function captureFixture() {
  return {
    structure: { format: 'holdr.amazon-structure', version: 2, scope: 'value-free-unobserved-is-unknown',
      code: 'complete', requests: 1, pages: [{ kind: 'ledger', elements: 1, truncated: false,
        attributes: ['class'], classes: ['transactions-line-item'], paths: ['div'], queries: ['timeFilter'] }], stop: null },
    staging: { format: 'holdr.amazon-staging', version: 1, source: 'shared-household-amazon',
      window: { from: '2025-11-16', through: '2026-01-14', timeZone: 'America/Los_Angeles' },
      coverage: Object.fromEntries(['orders', 'payments', 'details', 'refunds'].map((k) =>
        [k, { status: 'held', reason: 'selector-failed', pages: 0, records: 0, rejected: 0 }])),
      resume: { orders: [{ year: 2026, startIndex: 0 }], payments: null, details: [], restartPayments: true },
      orders: [], payments: [] },
  };
}

export function readinessFixture() {
  const c = captureFixture();
  c.structure.version = 3;
  c.structure.code = 'timeout';
  c.structure.pages = [];
  c.structure.navigationStop = { stopLocation: 'snapshot', requestedKind: 'details',
    destinationClass: 'admitted-same-identity', finalPathTemplate: '/your-orders/order-details',
    finalQueryNames: ['orderID'], sameOrderId: true, trackingOnly: true, authPath: false,
    admittedPath: true, finalPathFamily: 'your-orders-details',
    readiness: { status: 'observed', source: 'snapshot-checkpoint', termination: 'worker-watchdog', request: 0,
      readyState: 'complete', guards: { urlUnchanged: true, authPassed: true, documentBound: true },
      summary: { roots: 1, rows: 1, labelRows: 1, contentRows: 1, populatedRows: 1 },
      method: { blocks: 0, nonbuttonContent: false }, elements: 1, classes: ['order-summary'], paths: ['div'],
      buckets: Object.fromEntries([...AMAZON_STRUCTURE_RULES.tags, 'other'].map((tag) => [tag, tag === 'div' ? 1 : 0])),
      truncated: false } };
  return c;
}

export function separatedReadinessFixture() {
  const c = readinessFixture(), d = c.structure.navigationStop.readiness;
  const { classes, paths, truncated } = d;
  delete d.classes; delete d.paths; delete d.truncated;
  d.vocabulary = { status: 'observed', classes, paths, omittedClasses: 0, omittedPaths: 0,
    countsCapped: false, truncated,
    structures: Object.fromEntries(AMAZON_STRUCTURE_RULES.readinessStructureTags.map((tag) =>
      [tag, { classes: [], omittedClasses: 0, countsCapped: false, truncated: false }])) };
  return c;
}

export const scopedDiagnosticHtml = ({ pairs = 5, rows = 5 } = {}) =>
  '<div class="order-header">Order # 111-2222222-3333333</div>'
  + `<dl class="a-definition-list a-vertical">${Array.from({ length: pairs }, () =>
    '<div><div class="a-row"><dt class="a-list-item"><span><a>Private label</a></span></dt>'
    + '<dd class="a-list-item"><span>Private amount $12.34</span></dd></div></div>').join('')}</dl>`
  + `<div class="order-summary"><ul class="a-unordered-list a-nostyle a-vertical">${Array.from({ length: rows }, () =>
    '<li><span class="a-list-item"><div class="a-row"><div class="a-column"><span>Private label</span></div>'
    + '<div class="a-column"><span>Private amount $12.34</span></div></div></span></li>').join('')}</ul></div>`
  + '<div data-component="paymentMethod"><div><span>Payment method</span><span>Private instrument</span>'
  + '<button hidden>Hidden control</button></div></div>';

export function scopedReadinessFixture() {
  const c = separatedReadinessFixture(), d = c.structure.navigationStop.readiness;
  d.summary = { roots: 1, rows: 0, labelRows: 0, contentRows: 0, populatedRows: 0 };
  d.method = { blocks: 1, nonbuttonContent: true };
  const shapes = ['div', 'ul', 'li', 'span', 'dl', 'dt', 'dd'].map((tag) =>
    [AMAZON_STRUCTURE_RULES.tags.indexOf(tag), []]);
  const root = (matchedBy, nodes) => ({ matchedBy, relation: 'selected', shape: nodes[0][1],
    descendants: nodes.length - 1, children: [], nodes, omittedNodes: 0, depthOmitted: 0,
    rows: [], omittedRows: 0 });
  const summary = root(['summary-class'], [[-1, 0, 0, 1, 0], [0, 1, 0, 1, 0],
    [1, 2, 0, 1, 0], [2, 3, 0, 0, 0]]);
  summary.children = [[shapes[1][0], 1]];
  summary.rows = [{ node: 2, children: [[3, 1]], omittedChildren: 0 }];
  const dl = root(['definition-list'], [[-1, 4, 0, 5, 0]]);
  dl.children = [[shapes[0][0], 5]];
  dl.pairs = [];
  for (let i = 0; i < 5; i++) {
    const n = dl.nodes.length;
    dl.nodes.push([0, 0, i, 2, 0], [n, 5, 0, 0, 0], [n, 6, 1, 0, 0]);
    dl.pairs.push([n + 1, n + 2, n]);
  }
  dl.descendants = dl.nodes.length - 1;
  dl.pairing = { dt: 5, dd: 5, ownedDt: 5, ownedDd: 5, nestedDl: 0, containers: 5,
    paired: 5, nonoverlap: 5, unpairedDt: 0, unpairedDd: 0, omittedPairs: 0 };
  const method = root(['method-component'], [[-1, 0, 0, 1, 0], [0, 3, 0, 0, 0]]);
  method.children = [[shapes[3][0], 1]];
  d.elements = 22;
  Object.assign(d.buckets, { div: 7, ul: 1, li: 1, span: 2, dl: 1, dt: 5, dd: 5 });
  d.scoped = { version: 1, status: 'complete', header: 'match',
    auth: { password: false, email: false, captcha: false },
    selection: { summary: { candidates: 1, selected: 1, omittedRoots: 0 },
      dl: { candidates: 1, selected: 1, omittedRoots: 0 },
      method: { candidates: 1, selected: 1, omittedRoots: 0 } },
    roots: { summary: [summary], dl: [dl], method: [method] },
    relations: [[0, 1, 'disjoint'], [0, 2, 'disjoint'], [1, 2, 'disjoint']], vocabulary: { classes: [], shapes } };
  return c;
}

export function identityReadinessFixture() {
  const c = scopedReadinessFixture(), s = c.structure.navigationStop.readiness.scoped;
  s.version = 2;
  s.identity = { status: 'complete', distinct: 'one', visited: 1, omitted: 0, countsCapped: false, limits: [],
    occurrences: [{ equality: 'equal', label: 'order-hash', landmark: 'main', pathStatus: 'complete',
      path: [[2, []], [5, ['order-header']]],
      relations: [['summary', 0, 'disjoint'], ['dl', 0, 'disjoint'], ['method', 0, 'disjoint']] }] };
  return c;
}

export function fopoObservationFixture() {
  const c = identityReadinessFixture(), d = c.structure.navigationStop, readiness = d.readiness;
  delete readiness.request; delete readiness.termination; delete readiness.guards.documentBound;
  delete d.readiness;
  Object.assign(d, { stopLocation: 'before-snapshot', destinationClass: 'disallowed',
    finalPathTemplate: 'other', finalPathFamily: 'fopo', finalQueryNames: ['orderID', 'unknown'],
    trackingOnly: false, admittedPath: false,
    stopObservation: { status: 'observed', request: 0,
      guards: { documentBound: true, urlUnchanged: true, authPassed: true }, readiness } });
  c.structure.code = 'redirect-blocked';
  return c;
}

// Full envelopes and mutations are shared by Node, the actual MV3 validator, and central receiver proofs.
export function constructedFopoFixture() {
  const c = continuationFixture(), id = '111-2222222-3333333', task = '/your-orders/order-details?orderID=' + id;
  const cursor = c.continuation.after;
  cursor.headers = [{ orderId: id, date: c.staging.window.through, total: null, conflict: false }];
  cursor.unresolvedHeld = [task]; cursor.constructedDetails = [task]; cursor.noDetailsLinkHeld = [task];
  cursor.stats.orders = 1; cursor.stats.constructed = 1;
  c.staging.orders = [{ orderId: id, date: c.staging.window.through, total: null, items: [],
    paymentCoverage: { status: 'held', reason: 'selector-failed' }, paymentMethods: [], summary: [], tenderCoverage: 'unknown',
    tenderProof: { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false } }];
  c.staging.coverage.orders.records = 1; c.staging.coverage.orders.status = 'partial';
  c.staging.coverage.details.rejected = 1;
  c.staging.resume.details = [id];
  Object.assign(c.structure.progress, { state: 'held', position: 'unresolved-held', detailsPending: 1,
    unresolvedHeld: 1, noDetailsLinkHeld: 1, totalEstimate: 1, constructed: 1 });
  c.structure.requests = 1;
  c.structure.paginationDiagnostics = { pages: [], redirects: { count: 1, omittedCandidates: 0, countsCapped: false,
    families: Object.fromEntries(AMAZON_STRUCTURE_RULES.pagination.pathFamilies.map((f) => [f, f === 'fopo' ? 1 : 0])),
    queries: Object.fromEntries(AMAZON_STRUCTURE_RULES.pagination.linkQueries.map((f) => [f, ['orderID', 'unknown'].includes(f) ? 1 : 0])),
    candidates: [{ ordinal: 0, family: 'fopo', queryNames: ['orderID', 'unknown'] }] } };
  c.structure.fopoObservations = { count: 1, omitted: 0,
    stops: [{ ordinal: 0, navigationStop: fopoObservationFixture().structure.navigationStop }] };
  return c;
}
export function fopoTimeoutFixture() {
  const c = fopoObservationFixture();
  c.structure.code = 'timeout';
  c.structure.navigationStop.stopObservation = { status: 'unobserved', reason: 'budget', request: 0 };
  return c;
}
// A backfill slice that read one constructed task's /fopo/ Whole Foods in-store receipt: its
// order in the in-store form and the receipt's lines as one whole list marked `source: 'fopo'`. Invented values only.
export const fopoReceiptId = '111-2222222-3333333';
const usd = (amountMinor) => ({ currency: 'USD', amountMinor });
export const fopoReceiptLines = () => [
  { lineOrdinal: 0, title: 'Synthetic bananas', asin: 'B0SYNTHAA1', status: 'listed', quantity: null,
    weight: { value: '2.00', unit: 'lb', basis: 'unlabeled' }, unitPrice: { money: usd(79), per: 'lb' }, linePrice: usd(158),
    replaces: null },
  { lineOrdinal: 1, title: 'Synthetic oat milk', asin: 'B0SYNTHBB2', status: 'listed', quantity: 2, weight: null,
    unitPrice: { money: usd(250), per: 'each' }, linePrice: usd(500), replaces: null },
  { lineOrdinal: 2, title: 'Synthetic store sourdough', asin: null, status: 'listed', quantity: 1, weight: null,
    unitPrice: { money: usd(499), per: 'each' }, linePrice: usd(499), replaces: null },
  { lineOrdinal: 3, title: 'Synthetic kale', asin: 'B0SYNTHCC3', status: 'listed', quantity: null,
    weight: { value: '0.75', unit: 'lb', basis: 'unlabeled' }, unitPrice: { money: usd(399), per: 'lb' }, linePrice: usd(299),
    replaces: null },
  { lineOrdinal: 4, title: 'Synthetic pieces', asin: 'B0SYNTHDD4', status: 'listed', quantity: 1, weight: null,
    unitPrice: { money: usd(349), per: 'each' }, linePrice: usd(349), replaces: null },
];
// The receipt's own summary in the native order: Item Subtotal, Tax and Fees, the in-store receipt's shipping 0 just before
// the Grand Total, and its Total Savings last.
export const fopoReceiptSummary = () => [{ kind: 'items-subtotal', money: usd(1805) }, { kind: 'tax', money: usd(31) },
  { kind: 'shipping', money: usd(0) }, { kind: 'grand-total', money: usd(1716) }, { kind: 'promotion', money: usd(120) }];
export function fopoReadFixture() {
  const c = continuationFixture(), id = fopoReceiptId, task = '/your-orders/order-details?orderID=' + id;
  const cursor = c.continuation.after;
  cursor.completed = [id]; cursor.seen = [task];
  Object.assign(cursor.stats, { orders: 1, details: 1, constructed: 1 });
  c.staging.orders = [{ orderId: id, date: c.staging.window.through, total: usd(1716), items: [],
    paymentCoverage: { status: 'held', reason: 'selector-failed' }, paymentMethods: [{ kind: 'card', network: 'visa', last4: '9001' }],
    summary: fopoReceiptSummary(), tenderCoverage: 'single-card-proven',
    tenderProof: { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false },
    itemProof: { complete: false, unknownLine: true, conflict: false } }];
  Object.assign(c.staging.coverage.orders, { status: 'partial', reason: 'read-only-limit', records: 1 });
  c.staging.coverage.details.pages = 1;
  c.structure.requests = 1;
  Object.assign(c.structure.progress, { ordersDone: 1, totalEstimate: 1, constructed: 1 });
  c.structure.fopoReads = { count: 1, reads: [{ ordinal: 0, status: 'read', reason: null, rows: 5, lines: 5, unread: [] }] };
  c.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
    lists: [{ orderId: id, statedCount: null, rows: 5, proof: { complete: true, unreadRows: 0 }, reconciled: true,
      lines: fopoReceiptLines(), source: 'fopo' }],
    diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: 5, lines: 5, unread: [] }] };
  return c;
}
// The same constructed task, its receipt held by the grammar: nothing staged, the task held as no-details-link.
export function fopoHeldFixture() {
  const c = constructedFopoFixture();
  delete c.structure.fopoObservations;
  c.structure.fopoReads = { count: 1, reads: [{ ordinal: 0, status: 'held', reason: 'row', rows: 5, lines: 0,
    unread: [['status', 1]] }] };
  return c;
}
export const invalidFopoReadCaptures = () => [
  (c) => { delete c.structure.fopoReads; },
  (c) => { delete c.fresh.lists[0].source; },
  (c) => { c.fresh.lists[0].source = 'uff'; },
  (c) => { c.fresh.lists[0].reconciled = false; },
  (c) => { Object.assign(c.fresh.lists[0].lines[2], { status: 'substituted', replaces: 'Synthetic rye' }); },
  (c) => { c.staging.orders[0].itemProof.unknownLine = false; },
  (c) => { c.staging.orders[0].tenderCoverage = 'unknown'; },
  (c) => { c.structure.fopoReads.count = 2; },
  (c) => { c.structure.fopoReads.reads[0].lines = 4; },
  (c) => { c.structure.fopoReads.reads[0].ordinal = 1; },
  (c) => { Object.assign(c.structure.fopoReads.reads[0], { status: 'held', reason: 'summary', lines: 0 }); },
  (c) => { c.structure.fopoReads.reads[0].title = 'Synthetic bananas'; },
  (c) => { c.structure.fopoReads.reads[0].reason = 'arithmetic'; },
  (c) => { c.structure.fopoReads.reads[0].unread = [['status', 1]]; },
  (c) => { c.structure.fopoReads.reads.push({ ...c.structure.fopoReads.reads[0] }); c.structure.fopoReads.count = 2; },
];
export const invalidFopoHeldCaptures = () => [
  (c) => { c.structure.fopoReads.reads[0].reason = 'unreadable'; },
  (c) => { c.structure.fopoReads.reads[0].unread = []; },
  (c) => { c.structure.fopoReads.reads[0].unread = [['other', 1]]; },
  (c) => { c.structure.fopoReads.reads[0].unread = [['status', 6]]; },
  (c) => { c.structure.fopoReads.reads[0].unread = [['status', 1], ['status', 1]]; },
  (c) => { c.structure.fopoReads.reads[0].lines = 1; },
  (c) => { c.structure.fopoReads.reads[0].ordinal = 1; },
];
export const evidenceGapFixtures = () => [identityReadinessFixture(), fopoObservationFixture(), constructedFopoFixture(), fopoTimeoutFixture()];
export const invalidFopoCollectionCaptures = () => [
  (c) => { c.structure.fopoObservations.stops[0].ordinal = 399; },
  (c) => { c.structure.fopoObservations.stops[0].navigationStop.finalPathFamily = 'fresh'; },
  (c) => { c.structure.fopoObservations.stops[0].navigationStop.stopObservation.request = 1; },
  (c) => { c.structure.fopoObservations.omitted = 1; },
  (c) => { c.structure.fopoObservations.stops.push(c.structure.fopoObservations.stops[0]); c.structure.fopoObservations.count = 2; },
  (c) => { c.continuation.after.noDetailsLinkHeld = []; },
  (c) => { c.structure.fopoObservations.stops[0].navigationStop.stopObservation.status = 'complete'; },
  (c) => { c.structure.fopoObservations.stops[0].navigationStop.stopObservation.guards.documentBound = false; },
  (c) => { c.structure.code = 'redirect-blocked';
    c.structure.navigationStop = c.structure.fopoObservations.stops[0].navigationStop; },
  (c) => { delete c.structure.paginationDiagnostics.redirects; c.structure.fopoObservations.stops[0].ordinal = 399; },
  (c) => { delete c.structure.paginationDiagnostics; c.structure.fopoObservations.stops[0].ordinal = 399; },
  (c) => { c.structure.paginationDiagnostics.redirects.candidates[0].family = 'fresh';
    c.structure.paginationDiagnostics.redirects.families.fresh = 1; c.structure.paginationDiagnostics.redirects.families.fopo = 0; },
  (c) => {
    const orderId = '222-3333333-4444444', task = '/your-orders/order-details?orderID=' + orderId;
    const cursor = c.continuation.after;
    c.staging.orders.push({ ...structuredClone(c.staging.orders[0]), orderId });
    c.staging.resume.details.push(orderId); c.staging.coverage.orders.records++;
    cursor.headers.push({ orderId, date: c.staging.window.through, total: null, conflict: false });
    cursor.unresolvedHeld.push(task); cursor.constructedDetails.push(task); cursor.noDetailsLinkHeld.push(task);
    cursor.stats.orders++; cursor.stats.constructed++;
    for (const key of ['detailsPending', 'unresolvedHeld', 'noDetailsLinkHeld', 'totalEstimate', 'constructed']) c.structure.progress[key]++;
    c.structure.fopoObservations.stops[0].ordinal = 1;
  },
];
export const invalidEvidenceGapCaptures = () => [
  (c) => { c.structure.navigationStop.stopObservation.raw = 'private'; },
  (c) => { c.structure.navigationStop.finalPathFamily = 'fresh'; },
  (c) => { c.structure.navigationStop.destinationClass = 'admitted-same-identity'; },
  (c) => { c.structure.navigationStop.sameOrderId = false; },
  (c) => { c.structure.navigationStop.stopObservation.request = 1; },
  (c) => { c.structure.navigationStop.stopObservation.guards.documentBound = false; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.guards.authPassed = false; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.version = 1; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.distinct = '111-2222222-3333333'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].equality = 'match'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].label = 'Order #'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].path[0][1] = ['order-token']; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].path[0][1] = ['order-1234']; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].path.push(...Array(21).fill([5, []])); },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].relations[0][1] = 4; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0].relations[0][2] = 'equal'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences.push(...Array(8).fill(
    c.structure.navigationStop.stopObservation.readiness.scoped.identity.occurrences[0])); },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.countsCapped = true; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.status = 'unknown'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.distinct = 'none'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.limits = ['private']; },
  (c) => { const v = c.structure.navigationStop.stopObservation.readiness.scoped.identity;
    v.visited = 2; v.occurrences.push({ ...v.occurrences[0], equality: 'different' }); },
  (c) => { c.structure.code = 'timeout'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.distinct = 'two-to-eight'; },
  (c) => { c.structure.navigationStop.stopObservation.readiness.scoped.identity.distinct = 'over-eight'; },
  (c) => { const v = c.structure.navigationStop.stopObservation.readiness.scoped.identity; v.omitted = 1; },
];

export const invalidScopedReadiness = () => [
  (d) => { d.scoped.raw = 'private'; },
  (d) => { d.classes = []; },
  (d) => { delete d.vocabulary; },
  (d) => { d.scoped.version = 2; },
  (d) => { d.scoped.header = 'url-match'; },
  (d) => { d.scoped.auth.captcha = true; },
  (d) => { d.scoped.auth.raw = 'private'; },
  (d) => { d.scoped.selection.method.selected = 2; },
  (d) => { d.scoped.selection.method.candidates = 2; },
  (d) => { d.scoped.selection.summary.candidates = 0; },
  (d) => { d.scoped.selection.dl.omittedRoots = 1; },
  (d) => { d.scoped.vocabulary.classes = ['order-token']; },
  (d) => { d.scoped.vocabulary.classes = ['order-1234']; },
  (d) => { d.scoped.vocabulary.shapes[0][0] = 999; },
  (d) => { d.scoped.vocabulary.shapes[0][1] = [0]; },
  (d) => { d.scoped.vocabulary.shapes.push(d.scoped.vocabulary.shapes[0]); },
  (d) => { d.scoped.roots.summary[0].matchedBy = ['private']; },
  (d) => { d.scoped.roots.summary[0].matchedBy = ['summary-class', 'summary-class']; },
  (d) => { d.scoped.roots.summary[0].relation = 'private'; },
  (d) => { d.scoped.roots.summary[0].descendants++; },
  (d) => { d.scoped.roots.summary[0].nodes[0][0] = 0; },
  (d) => { d.scoped.roots.summary[0].nodes[1][0] = 1; },
  (d) => { d.scoped.roots.summary[0].nodes[1][2] = 1; },
  (d) => { d.scoped.roots.summary[0].nodes[1][1] = 999; },
  (d) => { d.scoped.roots.summary[0].nodes[0][4] = 1; },
  (d) => { d.scoped.roots.summary[0].depthOmitted = 1; },
  (d) => { d.scoped.roots.summary[0].children[0][1]++; },
  (d) => { d.scoped.roots.summary[0].rows[0].children[0][1]++; },
  (d) => { d.scoped.roots.summary[0].rows[0].omittedChildren = 1; },
  (d) => { d.scoped.roots.dl[0].pairing.ownedDt = 4; },
  (d) => { d.scoped.roots.dl[0].pairing.nonoverlap = 6; },
  (d) => { d.scoped.roots.dl[0].pairs[0][0] = 0; },
  (d) => { d.scoped.roots.dl[0].pairs[0][2] = 5; },
  (d) => { d.scoped.roots.dl[0].pairs[1] = d.scoped.roots.dl[0].pairs[0]; },
  (d) => { d.scoped.roots.dl[0].pairing.omittedPairs = 1; },
  (d) => { d.scoped.roots.dl[0].pairs[0].push(0); },
  (d) => { d.scoped.roots.method[0].rows = [{ node: 0, children: [[3, 1]], omittedChildren: 0 }]; },
  (d) => { d.scoped.status = 'truncated'; },
  (d) => { d.scoped.relations.pop(); },
  (d) => { d.scoped.relations[0][2] = 'private'; },
  (d) => { d.scoped.relations[0][1] = 0; },
  (d) => { d.scoped.relations[0][2] = 'same'; },
  (d) => { const root = d.scoped.roots.dl[0]; root.pairs = [];
    for (const key of Object.keys(root.pairing)) root.pairing[key] = 0; },
  (d) => { const root = d.scoped.roots.dl[0]; root.pairs = [[2, 3, 0]];
    Object.assign(root.pairing, { paired: 1, nonoverlap: 1, unpairedDt: 4, unpairedDd: 4 }); },
  (d) => { const root = d.scoped.roots.dl[0]; root.pairs = [];
    Object.assign(root.pairing, { paired: 0, nonoverlap: 0, unpairedDt: 5, unpairedDd: 5 }); },
  (d) => { const root = d.scoped.roots.dl[0]; root.nodes.pop(); root.omittedNodes = 1;
    root.pairs = []; for (const key of Object.keys(root.pairing)) root.pairing[key] = 0;
    d.scoped.status = 'truncated'; },
  (d) => { d.scoped.roots.summary[0].rows = []; },
  (d) => { d.scoped.roots.summary[0].rows[0].node = 0; },
];

export const invalidSeparatedReadiness = () => [
  (d) => { d.raw = 'private'; },
  (d) => { d.classes = []; },
  (d) => { d.vocabulary.raw = 'private'; },
  (d) => { d.vocabulary.status = 'unobserved'; },
  (d) => { d.vocabulary.classes = ['order-token']; },
  (d) => { d.vocabulary.classes = ['order-1234']; },
  (d) => { d.vocabulary.paths = ['div>private']; },
  (d) => { d.vocabulary.classes = Array(65).fill('order-row'); },
  (d) => { d.vocabulary.paths.push('div'); },
  (d) => { d.vocabulary.omittedClasses = -1; },
  (d) => { d.vocabulary.omittedPaths = 20001; },
  (d) => { d.vocabulary.omittedClasses = 1; },
  (d) => { d.vocabulary.truncated = true; },
  (d) => { d.vocabulary.countsCapped = true; },
  (d) => { delete d.vocabulary.structures.dl; },
  (d) => { d.vocabulary.structures.other = { classes: [] }; },
  (d) => { d.vocabulary.structures.dl.classes = ['order-row']; },
  (d) => { d.vocabulary.structures.dt.classes = ['order-token']; },
  (d) => { d.vocabulary.structures.dd.omittedClasses = 1; },
  (d) => { d.vocabulary.structures.table.countsCapped = true; },
  (d) => { d.vocabulary.structures.tr.classes = Array(9).fill('order-row'); },
  (d) => { d.vocabulary.structures.td.raw = 'private'; },
  (d) => { d.summary.rows = 20001; },
  (d) => { d.method.nonbuttonContent = true; },
  (d) => { d.elements++; },
  (d) => { d.guards.documentBound = false; },
  (d) => { d.status = 'budget-held'; d.source = 'snapshot-budget'; },
  (d) => { d.vocabulary.classes = Array.from({ length: 64 }, (_, i) => readinessClass(i));
    d.vocabulary.paths = []; },
];

const readinessClass = (i) => `order-${'a'.repeat(24)}-${'b'.repeat(24)}-cccccc${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26))}`;
export const readinessVocabularyHtml = () =>
  Array.from({ length: 100 }, (_, i) => `<div class="${readinessClass(i)}"></div>`).join('');
export const readinessBudgetHtml = () => '<div class="pmts-payments-instrument-details">Synthetic instrument</div>'.repeat(2)
  + readinessVocabularyHtml();

// Precise optional-label shape shared by Node, MV3, domain and frozen-pair checks.
export function summaryLabelDisclosureFixture() {
  const c = captureFixture();
  Object.assign(c.structure, { version: 3, requests: 0, pages: [], tenderDiagnostics: {
    orders: [{ ordinal: 0, reasons: ['unknown-label'] }],
    counts: { 'unknown-label': 1, 'row-shape': 0, 'extra-text': 0, 'duplicate-kind': 0,
      arithmetic: 0, 'method-incomplete': 0, 'multi-tender': 0, 'no-details-link': 0 },
    unknownLabels: [], unreportedUnknownLabelOrders: 1,
    summaryLabelDisclosure: { labels: [{ label: 'delivery adjustment', orders: 1, money: true }],
      suppressedRows: 0, cappedRows: 0, countsCapped: false },
  } });
  Object.assign(c.staging, { version: 3, runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orders: [{
    orderId: '111-2222222-3333333', date: '2026-01-14', total: null, items: [],
    paymentCoverage: { status: 'held', reason: 'selector-failed' },
    paymentMethods: [], summary: [], tenderCoverage: 'unknown',
    tenderProof: { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: true, conflict: true },
  }] });
  c.staging.coverage.orders.records = 1;
  c.staging.coverage.orders.status = 'partial';
  return c;
}

export const invalidSummaryLabelDisclosures = () => [
  (b) => { b.raw = 'private'; },
  (b) => { b.labels[0].raw = 'private'; },
  (b) => { b.labels[0].amount = '$1.00'; },
  (b) => { b.labels[0].money = false; },
  (b) => { b.labels[0].money = 'MONEY'; },
  (b) => { b.labels[0].orders = 0; },
  (b) => { b.labels[0].orders = 2; },
  (b) => { b.labels.push({ ...b.labels[0] }); },
  (b) => { b.labels[0].label = 'Delivery adjustment'; },
  (b) => { b.labels[0].label = 'delivery  adjustment'; },
  (b) => { b.labels[0].label = 'delivery adjustment:'; },
  (b) => { b.labels[0].label = 'delivery adjustment 12'; },
  (b) => { b.labels[0].label = 'customer name'; },
  (b) => { b.labels[0].label = 'www.example.test'; },
  (b) => { b.labels[0].label = 'fee (example.com) adjustment'; },
  (b) => { b.labels[0].label = 'delivery\u00a0adjustment'; },
  (b) => { b.labels[0].label = 'a'.repeat(49); },
  (b) => { b.labels[0].label = 'abcdefghijklmnop'; },
  (b) => { b.labels = Array.from({ length: 17 }, (_, i) => ({ label: `fee ${String.fromCharCode(97 + i)}`, orders: 1, money: true })); },
  (b) => { b.labels = 'private'; },
  (b) => { b.suppressedRows = -1; },
  (b) => { b.suppressedRows = 20001; },
  (b) => { b.cappedRows = 'one'; },
  (b) => { b.countsCapped = true; },
  (b) => { delete b.countsCapped; },
];

// Closed synthetic corpus shared by Node, MV3 and the API envelope boundary.
export function itemKeywordsFixture() {
  const c = summaryLabelDisclosureFixture();
  c.structure.itemDiagnostics = { orders: [{ ordinal: 0, observed: true,
    quantities: { displayed: 0, inferred: 0 }, details: { status: 'budget-held' }, keywords: {
      version: 1, status: 'complete', rowsOmitted: 0,
      block: { classified: 2, entries: [
        ['exact-label', 'promotion', 'outside-rows', 'direct', 'no', 'no', 1],
        ['ancestor-keyword', 'refund', 'outside-rows', '2-3', 'no', 'yes', 1],
        ['ancestor-keyword', 'credit', 'outside-rows', '2-3', 'no', 'yes', 1],
      ], omitted: 0, countsCapped: false },
      rows: [{ ordinal: 0, classified: 1, entries: [
        ['direct-keyword', 'points', 'row', 'direct', 'no', 'no', 1],
      ], omitted: 0, countsCapped: false }],
    } }] };
  return c;
}

export function validItemKeywordCaptures() {
  const captures = [itemKeywordsFixture()];
  const single = (entry, status = 'complete') => {
    const c = itemKeywordsFixture(), k = c.structure.itemDiagnostics.orders[0].keywords;
    k.status = status; k.rows = [];
    k.block = { classified: entry[6], entries: [entry], omitted: 0, countsCapped: false };
    captures.push(c);
  };
  for (const family of AMAZON_STRUCTURE_RULES.itemKeywords.families) {
    single(['exact-label', family, 'outside-rows', 'direct', 'no', 'no', 1]);
  }
  for (const stem of AMAZON_STRUCTURE_RULES.itemKeywords.stems) {
    single(['direct-keyword', stem, 'outside-rows', 'direct', 'yes', 'yes', 1]);
  }
  for (const depth of AMAZON_STRUCTURE_RULES.itemKeywords.depths.filter((d) => d !== 'direct')) {
    single(['ancestor-label', 'grand-total', 'outside-rows', depth, 'unknown', 'unknown', 1], 'unknown');
  }
  const saturated = itemKeywordsFixture(), k = saturated.structure.itemDiagnostics.orders[0].keywords;
  k.status = 'unknown'; k.rows = []; k.rowsOmitted = 400;
  k.block = { classified: 20000, entries: [], omitted: 20000, countsCapped: true };
  captures.push(saturated);
  const lastRow = itemKeywordsFixture();
  lastRow.structure.itemDiagnostics.orders[0].keywords.rows[0].ordinal = 99;
  captures.push(lastRow);
  const regionHeld = itemKeywordsFixture();
  regionHeld.structure.itemDiagnostics.orders[0].region = { status: 'budget-held' };
  captures.push(regionHeld);
  return captures;
}

export const invalidItemKeywords = () => [
  (k) => { k.raw = 'private'; },
  (k) => { k.version = 2; },
  (k) => { k.status = 'ok'; },
  (k) => { delete k.block; },
  (k) => { k.block.text = 'private'; },
  (k) => { k.block.classified = -1; },
  (k) => { k.block.classified = 20001; },
  (k) => { k.block.classified = 1.5; },
  (k) => { k.block.classified = 0; },
  (k) => { k.block.classified = 4; },
  (k) => { k.block.entries[0][0] = 'private'; },
  (k) => { k.block.entries[0][1] = 'private'; },
  (k) => { k.block.entries[0][1] = 'refund'; },
  (k) => { k.block.entries[1][1] = 'refund-total'; },
  (k) => { k.block.entries[0][2] = 'row'; },
  (k) => { k.block.entries[0][3] = '1'; },
  (k) => { k.block.entries[1][3] = 'direct'; },
  (k) => { k.block.entries[0][4] = false; },
  (k) => { k.block.entries[0][5] = 'private'; },
  (k) => { k.block.entries[0][5] = 'unknown'; },
  (k) => { k.block.entries[0][6] = 0; },
  (k) => { k.block.classified = 1; k.block.entries = [
    ['exact-label', 'promotion', 'outside-rows', 'direct', 'no', 'no', 16]]; },
  (k) => { k.block.entries[0][6] = 20001; },
  (k) => { k.block.entries[0].push('private'); },
  (k) => { k.block.entries.push([...k.block.entries[0]]); },
  (k) => { k.block.omitted = 1; },
  (k) => { k.block.countsCapped = true; },
  (k) => { k.status = 'unknown'; k.block = { classified: 20000, entries: [], omitted: 0, countsCapped: true }; },
  (k) => { k.rows[0].ordinal = 100; },
  (k) => { k.rows[0].classified = 0; },
  (k) => { k.rows.push(structuredClone(k.rows[0])); },
  (k) => { k.rows[0].entries[0][2] = 'outside-rows'; },
  (k) => { k.rowsOmitted = 1; },
  (k) => { k.rowsOmitted = 401; },
  (k) => { k.rowsOmitted = 'private'; },
  (k) => { k.status = 'unknown'; k.block.omitted = -1; },
  (k) => { k.status = 'unknown'; k.rows = Array.from({ length: 101 }, (_, ordinal) =>
    ({ ...structuredClone(k.rows[0]), ordinal })); },
  (k) => { k.status = 'unknown'; k.rowsOmitted = 400; },
  (k) => { k.status = 'unknown'; k.rows[0].entries = Array.from({ length: 17 }, (_, i) =>
    ['direct-keyword', AMAZON_STRUCTURE_RULES.itemKeywords.stems[i % 16], 'row', 'direct', 'no', i < 16 ? 'no' : 'yes', 1]);
    k.rows[0].classified = 2; },
  (k) => { k.status = 'unknown'; k.block.entries = Array.from({ length: 65 }, (_, i) =>
    ['direct-keyword', AMAZON_STRUCTURE_RULES.itemKeywords.stems[i % 16], 'outside-rows',
      'direct', i < 32 ? 'no' : 'yes', i % 32 < 16 ? 'no' : 'yes', 1]); k.block.classified = 65; },
];

export function invalidItemKeywordRegionCaptures() {
  return [{ status: 'budget-held', raw: 'private' }, { status: 'complete' }].map((region) => {
    const c = itemKeywordsFixture();
    c.structure.itemDiagnostics.orders[0].region = region;
    return c;
  });
}

// Shared new-producer shape for frozen-pair/API regressions; no live source values.
export function renderedLedgerFixture() {
  const capture = captureFixture(), page = capture.structure.pages[0];
  capture.structure.version = 3;
  capture.structure.requests = 2;
  page.diagnostics = { failures: [], scopes: [], omittedScopes: 0, exhausted: false };
  capture.structure.progress = { mode: 'recent', state: 'in-progress', position: 'payments', runs: 1,
    pagesDone: 1, ordersDone: 0, detailsPending: 0, yearsPending: 0, terminalHeld: 0, unresolvedHeld: 0,
    ledgerPage: 0, totalEstimate: 0, linked: 0, constructed: 0 };
  capture.structure.paginationDiagnostics = { pages: [{
    page: 0, kind: 'ledger', status: 'ok', candidates: [], omittedCandidates: 0, countsCapped: false,
    counts: { a: 0, button: 0, input: 0, form: 0, selectedNext: 0, readableNext: 0, enqueuedNext: 0 },
    dates: { inWindow: 0, beforeWindow: 0, afterWindow: 0, invalid: 0 }, rowOrder: 'unknown',
    comparison: { status: 'unobserved' },
    rendered: { status: 'observed', counts: { a: 1, button: 1, input: 0, form: 0 },
      omittedCandidates: 0, countsCapped: false, candidates: [
        { tag: 'a', activation: 'anchor', state: 'enabled', position: 'after-rows',
          target: { class: 'same-origin-admitted-ledger', method: 'get',
            queries: { pageNumber: 1, orderID: 0, orderId: 0, ref: 0, ref_: 0, language: 0, ie: 0, unknown: 0 },
            pageNumber: 'valid', orderScope: 'absent' } },
        { tag: 'button', activation: 'unknown', state: 'disabled', position: 'after-rows',
          target: { class: 'absent', method: 'unknown',
            queries: { pageNumber: 0, orderID: 0, orderId: 0, ref: 0, ref_: 0, language: 0, ie: 0, unknown: 0 },
            pageNumber: 'absent', orderScope: 'absent' } },
      ] },
  }] };
  return capture;
}

export function continuationFixture() {
  const c = captureFixture();
  c.structure.version = 3;
  c.structure.requests = 0; c.structure.pages = [];
  Object.assign(c.staging, { version: 3, mode: 'backfill', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    window: { from: '2024-01-15', through: '2026-01-14', timeZone: 'America/Los_Angeles' } });
  c.staging.resume.orders = [];
  c.staging.resume.restartPayments = false;
  c.continuation = { before: null, after: {
    version: 1, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 1, origin: 'https://www.amazon.com',
    window: { ...c.staging.window }, queue: [], headers: [], completed: [], seen: [], signatures: [],
    terminalHeld: [], terminalRearmed: [], unresolvedHeld: [], unresolvedRearmed: [], constructedLists: [],
    stats: { pages: 0, orders: 0, payments: 0, details: 0, linked: 0, constructed: 0 },
  } };
  c.structure.progress = { mode: 'backfill', state: 'complete', position: 'complete', runs: 1, pagesDone: 0,
    ordersDone: 0, detailsPending: 0, yearsPending: 0, terminalHeld: 0, unresolvedHeld: 0, ledgerPage: 0, totalEstimate: 0, linked: 0, constructed: 0 };
  return c;
}

// New continuation metadata only: no financial proof or retry entitlement is manufactured.
export function proofRetryFixture(count = 1) {
  const capture = continuationFixture(), cursor = capture.continuation.after;
  cursor.proofRetry = { candidates: [], consumed: [], queue: [], claim: null, observed: {} };
  for (let i = 0; i < count; i++) {
    const orderId = `111-${String(i).padStart(7, '0')}-3333333`;
    const task = `/your-orders/order-details?orderID=${orderId}`;
    cursor.completed.push(orderId);
    cursor.seen.push(task);
    cursor.proofRetry.observed[orderId] = 1;
    cursor.proofRetry.candidates.push({ task,
      header: { orderId, date: cursor.window.through, total: null, conflict: false },
      reasons: ['unknown-label', 'arithmetic', 'item-quantity'] });
  }
  cursor.stats.orders = count; cursor.stats.details = count;
  capture.structure.progress.ordersDone = count; capture.structure.progress.totalEstimate = count;
  return capture;
}

// Invented display-only image IDs and src values: only their shape follows Amazon's public image CDN
// form. Shared by the producer capture/validator tests and the API boundary; never real items.
export const itemImageCases = () => ({
  ids: {
    valid: ['91SynthAA0L', '91Synth+01L', '91Synth-02L', 'A1Synth+-3S', '11SYNTHzz9L'],
    refused: ['', '91SynthAA0', '91SynthAA00L', '-1SynthAA0L', '+1SynthAA0L', '91SynthAA0-', '91SynthAA0+',
      '91Synth_A0L', '91Synth.A0L', '91Synth/A0L', '91Synth%2BL', '91Synth A0L', '91Synth\u00c4A0L',
      '91SynthAA0L\n', null, 91, true, ['91SynthAA0L'], { id: '91SynthAA0L' }],
  },
  src: {
    valid: [
      ['https://m.media-amazon.com/images/I/91SynthAA0L._SS142_.jpg', '91SynthAA0L'],
      ['https://m.media-amazon.com/images/I/91Synth+01L.jpg', '91Synth+01L'],
      ['https://images-na.ssl-images-amazon.com/images/I/91Synth-02L._AC_UL116_SR116,116_.png', '91Synth-02L'],
      ['https://m.media-amazon.com/images/I/A1Synth+-3S.__AC_SY200_.webp', 'A1Synth+-3S'],
      ['https://m.media-amazon.com/images/I/11SYNTHzz9L._AC_._SX300_SY300_._QL70_.jpeg', '11SYNTHzz9L'],
      ['https://m.media-amazon.com/images/I/91SynthAA0L.gif', '91SynthAA0L'],
    ],
    refused: [
      'http://m.media-amazon.com/images/I/91SynthAA0L._SS142_.jpg',
      '//m.media-amazon.com/images/I/91SynthAA0L._SS142_.jpg',
      '/images/I/91SynthAA0L._SS142_.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._SS142_.jpg?width=1',
      'https://m.media-amazon.com/images/I/91SynthAA0L._SS142_.jpg#fragment',
      'https://m.media-amazon.com:443/images/I/91SynthAA0L.jpg',
      'https://user@m.media-amazon.com/images/I/91SynthAA0L.jpg',
      'https://M.MEDIA-AMAZON.COM/images/I/91SynthAA0L.jpg',
      'https://m.media-amazon.com.synthetic.invalid/images/I/91SynthAA0L.jpg',
      'https://synthetic.invalid/images/I/91SynthAA0L.jpg',
      'https://images-eu.ssl-images-amazon.com/images/I/91SynthAA0L.jpg',
      'https://m.media-amazon.com/images/G/01/91SynthAA0L.jpg',
      'https://m.media-amazon.com/images/P/B000ABC123.01._SL160_.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA00L.jpg',
      'https://m.media-amazon.com/images/I/-1SynthAA0L.jpg',
      'https://m.media-amazon.com/images/I/91Synth%2BL.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._S%2CS_.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._a_._b_._c_._d_.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._SS142_.svg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._SS142_.JPG',
      'https://m.media-amazon.com/images/I/91SynthAA0L',
      'https://m.media-amazon.com/images/I/91SynthAA0L.jpg/extra.jpg',
      'https://m.media-amazon.com/images/I/../I/91SynthAA0L.jpg',
      ' https://m.media-amazon.com/images/I/91SynthAA0L.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L.jpg\n',
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      'javascript:void(0)',
      '',
    ],
  },
});
