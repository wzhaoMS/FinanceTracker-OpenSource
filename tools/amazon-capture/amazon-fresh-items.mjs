// Amazon Fresh Item Lists in a capture envelope: the optional top-level `fresh` section, beside structure and staging.
// Closed, bounded and self-checking; every list belongs to an order the same capture stages, so a capture without
// staged orders (a returns-only or ledger-only one) can never carry one. Used by the producer, the receiver and the
// domain importer alike (Node and browser).
export const AMAZON_FRESH_FORMAT = 'holdr.amazon-fresh-item-lists';
export const AMAZON_FRESH_RULES = Object.freeze({
  lists: 400, lines: 200, bytes: 512 * 1024, title: 2048,
  statuses: Object.freeze(['listed', 'substituted', 'missing']),
  bases: Object.freeze(['actual', 'estimated', 'unlabeled']),
  // Why a whole list was not read, or why one row of it was not.
  listReasons: Object.freeze(['root', 'heading', 'identity', 'region', 'status', 'structure', 'rows', 'header',
    'snapshot-timeout', 'navigation-disallowed']),
  rowReasons: Object.freeze(['hidden', 'shape', 'extra-text', 'image', 'struck', 'name', 'status', 'note', 'quantity', 'weight',
    'total']),
  // Row states the grammar never reads as a listed line (the injected adapter, amazon-uff.mjs, uses the same source).
  status: '(?:refund|replac|substitut|unavailab|not delivered|undeliver|missing|out of stock|cancel|return|damage|credit|adjust|removed|instead|swap)',
  // Where a list was read when it is not the order's Item List: `fopo`, the order's Whole Foods in-store receipt
  // (the capture kit's /fopo/ reader). Absent: the Item List.
  sources: Object.freeze(['fopo']),
});

const exact = (v, keys) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const usd = (v) => exact(v, ['currency', 'amountMinor']) && v.currency === 'USD' && count(v.amountMinor, 100000000);
const title = (v) => typeof v === 'string' && v.length > 0 && v.length <= AMAZON_FRESH_RULES.title
  && !/[\x00-\x1f\x7f-\x9f<>]|(?:https?:|@)/i.test(v) && v === v.replace(/\s+/g, ' ').trim();
const weight = (v) => typeof v === 'string' && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(v) && /[1-9]/.test(v);

function validateLine(line, rows, previous) {
  const need = (ok) => { if (!ok) throw Error('invalid-amazon-fresh'); };
  need(exact(line, ['lineOrdinal', 'title', 'asin', 'status', 'quantity', 'weight', 'unitPrice', 'linePrice', 'replaces'])
    && count(line.lineOrdinal, rows - 1) && line.lineOrdinal > previous && title(line.title)
    && (line.asin === null || (typeof line.asin === 'string' && /^[A-Z0-9]{10}$/.test(line.asin)))
    && AMAZON_FRESH_RULES.statuses.includes(line.status)
    && (line.quantity === null || (count(line.quantity, 999) && line.quantity > 0))
    && (line.weight === null || (exact(line.weight, ['value', 'unit', 'basis']) && weight(line.weight.value)
      && line.weight.unit === 'lb' && AMAZON_FRESH_RULES.bases.includes(line.weight.basis)))
    && (line.unitPrice === null || (exact(line.unitPrice, ['money', 'per']) && usd(line.unitPrice.money)
      && ['each', 'lb'].includes(line.unitPrice.per) && (line.unitPrice.per !== 'lb' || line.weight !== null)))
    && (line.linePrice === null ? line.status === 'missing' : usd(line.linePrice))
    && (line.replaces === null || (line.status === 'substituted' && title(line.replaces)))
    && (line.status !== 'listed' || !new RegExp(AMAZON_FRESH_RULES.status, 'i').test(line.title)));
}

/** The `fresh` section, checked whole against the capture's own staging; returns it unchanged. */
export function validateAmazonFreshItemLists(fresh, staging) {
  const need = (ok) => { if (!ok) throw Error('invalid-amazon-fresh'); };
  const r = AMAZON_FRESH_RULES;
  need(exact(fresh, ['format', 'version', 'lists', 'diagnostics']) && fresh.format === AMAZON_FRESH_FORMAT
    && fresh.version === 1 && Array.isArray(fresh.lists) && fresh.lists.length <= r.lists
    && Array.isArray(fresh.diagnostics) && fresh.diagnostics.length <= r.lists
    && new TextEncoder().encode(JSON.stringify(fresh)).length <= r.bytes
    && staging?.version === 3 && Array.isArray(staging.orders));
  const ordinals = new Map(staging.orders.map((o, ordinal) => [o.orderId, ordinal]));
  const diagnostics = new Map();
  for (const d of fresh.diagnostics) {
    need(exact(d, ['ordinal', 'status', 'reason', 'rows', 'lines', 'unread']) && count(d.ordinal, staging.orders.length - 1)
      && !diagnostics.has(d.ordinal) && ['read', 'held'].includes(d.status)
      && (d.status === 'read' ? d.reason === null && count(d.rows, r.lines) && d.rows > 0
        : r.listReasons.includes(d.reason) && count(d.rows, r.lines) && d.lines === 0)
      && count(d.lines, d.rows) && Array.isArray(d.unread) && d.unread.length <= r.rowReasons.length);
    const reasons = new Set();
    for (const entry of d.unread) {
      need(Array.isArray(entry) && entry.length === 2 && r.rowReasons.includes(entry[0]) && !reasons.has(entry[0])
        && count(entry[1], d.rows) && entry[1] > 0);
      reasons.add(entry[0]);
    }
    need(d.unread.reduce((n, [, v]) => n + v, 0) === d.rows - d.lines && (d.status === 'read' || !d.unread.length));
    diagnostics.set(d.ordinal, d);
  }
  const listed = new Set();
  for (const list of fresh.lists) {
    const sourced = !!list && typeof list === 'object' && Object.hasOwn(list, 'source');
    need(exact(list, ['orderId', 'statedCount', 'rows', 'proof', 'reconciled', 'lines', ...(sourced ? ['source'] : [])])
      && typeof list.orderId === 'string' && ordinals.has(list.orderId) && !listed.has(list.orderId)
      && (list.statedCount === null || count(list.statedCount, 999)) && count(list.rows, r.lines) && list.rows > 0
      && exact(list.proof, ['complete', 'unreadRows']) && typeof list.proof.complete === 'boolean'
      && typeof list.reconciled === 'boolean' && Array.isArray(list.lines) && list.lines.length <= list.rows
      && list.proof.unreadRows === list.rows - list.lines.length
      && list.proof.complete === (list.proof.unreadRows === 0 && (list.statedCount === null || list.statedCount === list.rows)));
    listed.add(list.orderId);
    let previous = -1;
    for (const line of list.lines) { validateLine(line, list.rows, previous); previous = line.lineOrdinal; }
    // An in-store receipt's list is read whole or not at all: every row a listed, priced line, reconciled below.
    if (sourced) need(r.sources.includes(list.source) && list.reconciled && list.lines.length === list.rows
      && list.lines.every((line) => line.status === 'listed' && line.linePrice.amountMinor > 0));
    const d = diagnostics.get(ordinals.get(list.orderId));
    need(d?.status === 'read' && d.rows === list.rows && d.lines === list.lines.length);
    if (list.reconciled) {
      // A list reconciles only when it is whole and its delivered lines add up to Amazon's own item subtotal.
      const order = staging.orders[ordinals.get(list.orderId)];
      const subtotal = (order.summary || []).filter((c) => c.kind === 'items-subtotal');
      const delivered = list.lines.filter((line) => line.status !== 'missing');
      need(list.proof.complete && delivered.length > 0 && subtotal.length === 1 && subtotal[0].money.currency === 'USD'
        && delivered.reduce((n, line) => n + line.linePrice.amountMinor, 0) === subtotal[0].money.amountMinor);
    }
  }
  for (const [ordinal, d] of diagnostics) need(d.status === 'held' || listed.has(staging.orders[ordinal].orderId));
  return fresh;
}
