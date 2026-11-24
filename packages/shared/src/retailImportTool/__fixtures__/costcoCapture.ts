/**
 * Synthetic Costco captures for tests: the pull's `holdr-retail-capture/costco@1` consolidated file and its raw
 * responses, built from compact specs with the field names the real capture uses. Every value is invented: barcodes,
 * order and line numbers, names, places, items, amounts and card endings. None comes from a household capture.
 *
 * Amounts in specs are integer cents; the files carry dollars, as the capture does.
 */

export const SYNTHETIC_CARD = '0007';
export const SYNTHETIC_CARD_2 = '0011';
export const SYNTHETIC_CERTIFICATE = '0099';
export const SYNTHETIC_PLACE = { warehouseName: 'SAMPLETOWN', city: 'SAMPLETOWN', state: 'ZZ', shortName: 'SMPLTWN' } as const;
export const SYNTHETIC_FIRST_NAME = 'TESTNAME';
export const SYNTHETIC_CAPTURED_AT = '2026-01-02T03:04:05.000Z';

/** A synthetic 23-digit barcode, built at run time so no long digit run is written in source. */
export const syntheticBarcode = (seed: number) => `9${'0'.repeat(14)}${String(seed).padStart(8, '0')}`;
/** A synthetic 10-digit order number. */
export const syntheticOrderNumber = (seed: number) => `8${String(seed).padStart(9, '0')}`;
/** A synthetic 10-digit line id. */
export const syntheticLineId = (order: number, line: number) => `7${String(order).padStart(5, '0')}${String(line).padStart(4, '0')}`;

export interface SyntheticItem {
  number: string;
  title: string;
  title2?: string | null;
  department?: number;
  unit?: number | null;
  /** Cents; null for an informational line. */
  amount: number | null;
  unitPrice?: number;
  taxFlag?: string | null;
  fuelGallons?: number;
  /** Dollars per gallon, as fuel receipts state them (three decimals). */
  fuelPrice?: number;
}

export interface SyntheticTender {
  name: string;
  code?: string;
  subType?: string | null;
  last4?: string | null;
  amount: number;
}

export interface SyntheticReceipt {
  seed: number;
  dateTime: string;
  gas?: boolean;
  items: SyntheticItem[];
  taxes: number;
  instantSavings?: number;
  tenders: SyntheticTender[];
  /** Overrides applied to the raw receipt only (for tests of disagreement). */
  rawOverrides?: Record<string, unknown>;
  /** Leave the raw receipt out. */
  noRaw?: boolean;
  receiptType?: string;
  documentType?: string;
  country?: string;
}

export interface SyntheticEvent {
  qty: number;
  date: string;
}

export interface SyntheticOnlineLine {
  line: number;
  number: string;
  title: string;
  qty: number;
  price: number;
  /** Defaults to qty × price; 0 for a cancelled line. */
  merch?: number;
  shipping?: number;
  feeParent?: number;
  shipMethod?: string;
  shipped?: SyntheticEvent[];
  delivered?: SyntheticEvent[];
  cancelled?: SyntheticEvent[];
  returned?: SyntheticEvent[];
  shipments?: Array<{ shipped: string | null; delivered?: string | null; estimated?: string | null; carrier?: string }>;
  pullMetal?: boolean;
}

export interface SyntheticPayment {
  type: string;
  last4: string;
  charged: number;
  gom?: boolean;
  /**
   * A wallet Shop Card payment in the one shape the captures show: bucket ShopCard in both files, the last four empty in
   * the raw details and null in the consolidated file (`type` is then normally `Wallet Shop Card`; `last4` is ignored).
   */
  shopCard?: boolean;
}

export interface SyntheticOrder {
  seed: number;
  placed: string;
  status: string;
  lines: SyntheticOnlineLine[];
  tax: number;
  discount?: number;
  /** Defaults to the computed total, the wallet Shop Card amount taken off; set to override. */
  total?: number;
  payments: SyntheticPayment[];
  noRaw?: boolean;
  /** The physical Shop Card amount applied (never seen in a real capture). */
  shopCardApplied?: number;
  /** The wallet Shop Card amount applied: the order's total leaves it out. */
  walletShopCardApplied?: number;
}

export interface SyntheticCaptureSpec {
  folder?: string;
  account?: { memberSinceYear: string; tier: string; membershipLast4: string } | null;
  receipts?: SyntheticReceipt[];
  orders?: SyntheticOrder[];
  schema?: string;
  currency?: string;
}

export interface SyntheticCapture {
  consolidated: Record<string, unknown>;
  rawReceipts: Array<{ name: string; json: Record<string, unknown> }>;
  rawDetails: Array<{ name: string; json: Record<string, unknown> }>;
}

const dollars = (cents: number) => cents / 100;
const money = (cents: number) => ({ cents, currency: 'USD', raw: dollars(cents) });
const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

function rawEvent(event: SyntheticEvent, lineId: string) {
  return {
    quantity: event.qty, transactionDate: `${event.date}T12:00:00`, orderLineItemId: lineId,
    lineItemStatusId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', orderLineItemCancelAllowed: false, orderLineItemReturnAllowed: false,
  };
}

function buildReceipt(spec: SyntheticReceipt) {
  const barcode = syntheticBarcode(spec.seed);
  const subTotal = total(spec.items.map((item) => item.amount ?? 0));
  const grandTotal = subTotal + spec.taxes;
  const gas = spec.gas === true;
  const receiptType = spec.receiptType ?? (gas ? 'Gas Station' : 'In-Warehouse');
  const documentType = spec.documentType ?? (gas ? 'FuelReceipts' : 'WarehouseReceiptDetail');
  const transactionType = grandTotal < 0 ? 'Refund' : 'Sales';
  const date = spec.dateTime.slice(0, 10);
  const items = spec.items.map((item) => ({
    itemNumber: item.number,
    itemDescription01: item.title,
    frenchItemDescription1: null,
    itemDescription02: item.title2 ?? null,
    frenchItemDescription2: null,
    itemIdentifier: null,
    itemDepartmentNumber: item.department ?? 1,
    unit: item.unit === undefined ? 1 : item.unit,
    amount: item.amount === null ? null : dollars(item.amount),
    taxFlag: item.taxFlag === undefined ? 'Y' : item.taxFlag,
    entryMethod: null,
    transDepartmentNumber: item.department ?? 1,
    fuelUnitQuantity: item.fuelGallons ?? 1,
    fuelGradeCode: item.fuelGallons !== undefined ? '1' : null,
    itemUnitPriceAmount: item.fuelPrice ?? dollars(item.unitPrice ?? item.amount ?? 0),
    fuelUomCode: item.fuelGallons !== undefined ? 'GAL' : null,
    fuelUomDescription: null,
    fuelUomDescriptionFr: null,
    fuelGradeDescription: item.fuelGallons !== undefined ? 'Regular' : null,
    fuelGradeDescriptionFr: null,
  }));
  const tenders = spec.tenders.map((tender) => ({
    tenderTypeCode: tender.code ?? '061',
    tenderSubTypeCode: tender.subType ?? null,
    tenderDescription: tender.name,
    amountTender: dollars(tender.amount),
    displayAccountNumberLast4: tender.last4 ?? undefined,
    sequenceNumber: null,
    responseCode: null,
    tenderTypeName: tender.name,
    entryMethod: null,
    tenderTypeNameFr: null,
    tenderEntryMethodDescription: null,
    walletType: null,
    storedValueBucket: null,
  }));
  const raw = {
    warehouseName: SYNTHETIC_PLACE.warehouseName,
    receiptType,
    documentType,
    transactionDateTime: spec.dateTime,
    transactionDate: date,
    companyNumber: 1,
    warehouseNumber: 999,
    operatorNumber: 12,
    warehouseShortName: SYNTHETIC_PLACE.shortName,
    registerNumber: 3,
    transactionNumber: 456,
    transactionType,
    transactionBarcode: barcode,
    total: dollars(grandTotal),
    warehouseCity: SYNTHETIC_PLACE.city,
    warehouseState: SYNTHETIC_PLACE.state,
    warehouseCountry: spec.country ?? 'US',
    totalItemCount: spec.items.length,
    subTotal: dollars(subTotal),
    taxes: dollars(spec.taxes),
    invoiceNumber: null,
    sequenceNumber: null,
    itemArray: items,
    tenderArray: tenders,
    subTaxes: { tax1: null, aTaxLegend: 'A', aTaxAmount: dollars(spec.taxes), cTaxLegend: null, cTaxAmount: null },
    instantSavings: dollars(spec.instantSavings ?? 0),
    ...spec.rawOverrides,
  };
  const consolidated = {
    barcode,
    dateTimeLocal: spec.dateTime,
    date,
    warehouseName: SYNTHETIC_PLACE.warehouseName,
    warehouseNumber: 999,
    receiptType,
    documentType,
    transactionType,
    total: money(grandTotal),
    subTotal: money(subTotal),
    taxes: money(spec.taxes),
    instantSavings: money(spec.instantSavings ?? 0),
    itemCount: spec.items.length,
    itemLines: spec.items.length,
    coupons: 0,
    tenders: spec.tenders.map((tender) => ({
      description: tender.name, typeCode: tender.code ?? '061', typeName: tender.name, last4: tender.last4 ?? null,
      amount: money(tender.amount), entryMethod: null,
    })),
    rangeLabel: 'Synthetic range',
    detailCaptured: true,
  };
  const file = {
    barcode, option: 'Synthetic range', capturedAt: SYNTHETIC_CAPTURED_AT, variables: { barcode, documentType: gas ? 'fuel' : 'warehouse' },
    status: 200, response: { data: { receiptsWithCounts: { receipts: [raw] } } },
  };
  return { consolidated, file, barcode };
}

function buildOrder(spec: SyntheticOrder) {
  const orderNumber = syntheticOrderNumber(spec.seed);
  const merchOf = (line: SyntheticOnlineLine) => line.merch ?? line.qty * line.price;
  const merchandise = total(spec.lines.map(merchOf));
  const shipping = total(spec.lines.map((line) => line.shipping ?? 0));
  const discount = spec.discount ?? 0;
  const wallet = spec.walletShopCardApplied ?? 0;
  const orderTotal = spec.total ?? merchandise + shipping + spec.tax - discount - wallet;
  const date = spec.placed.slice(0, 10);
  const rawLines = spec.lines.map((line) => {
    const id = syntheticLineId(spec.seed, line.line);
    return {
      shipToWarehousePackageStatus: '',
      orderStatus: 'Available',
      orderNumber,
      orderedDate: spec.placed,
      itemTypeId: 1,
      isFeeItem: line.feeParent !== undefined,
      orderLineItemCancelAllowed: false,
      estimatedDeliveryDate: '',
      supplierAvailabilityDate: spec.placed,
      fulfilledBy: '',
      itemNumber: line.number,
      itemDescription: line.title,
      price: dollars(line.price),
      quantity: line.qty,
      merchandiseTotalAmount: dollars(merchOf(line)),
      lineItemId: id,
      sourceLineItemId: id,
      parentOrderLineItemId: line.feeParent !== undefined ? syntheticLineId(spec.seed, line.feeParent) : '',
      itemId: 1000 + line.line,
      lineNumber: line.line,
      orderedShipMethodDescription: line.shipMethod ?? 'Standard',
      shippingChargeAmount: dollars(line.shipping ?? 0),
      returnStatus: 'Returnable',
      totalReturnedQuantity: String(total((line.returned ?? []).map((event) => event.qty))),
      itemStatus: {
        orderPlaced: null,
        readyForPickup: [],
        shipped: (line.shipped ?? []).map((event) => rawEvent(event, id)),
        cancelled: (line.cancelled ?? []).map((event) => rawEvent(event, id)),
        returned: (line.returned ?? []).map((event) => rawEvent(event, id)),
        delivered: (line.delivered ?? []).map((event) => rawEvent(event, id)),
        cancellationRequested: [],
      },
      shipment: (line.shipments ?? []).map((shipment) => ({
        lineNumber: line.line, orderNumber, packageNumber: 'PKG', trackingNumberLast4: '0000', pickUpCompletedDate: null,
        pickUpReadyDate: null, carrierName: shipment.carrier ?? 'UPS',
        shippedDate: shipment.shipped === null ? null : `${shipment.shipped}T08:00:00`,
        estimatedArrivalDate: shipment.estimated ? `${shipment.estimated}T08:00:00` : null,
        deliveredDate: shipment.delivered ? `${shipment.delivered}T08:00:00` : null,
        isDeliveryDelayed: null, isEstimatedArrivalDateEligible: false, reasonCode: 0, trackingEvent: null,
      })),
    };
  });
  const details = {
    warehouseNumber: 847,
    orderNumber,
    orderPlacedDate: spec.placed,
    status: spec.status,
    locale: 'en-US',
    orderReturnAllowed: true,
    shopCardAppliedAmount: dollars(spec.shopCardApplied ?? 0),
    walletShopCardAppliedAmount: dollars(wallet),
    giftOfMembershipAppliedAmount: 0,
    orderCancelAllowed: false,
    orderPaymentFailed: false,
    orderShippingEditAllowed: false,
    merchandiseTotal: dollars(merchandise),
    retailDeliveryFee: 0,
    shippingAndHandling: dollars(shipping),
    grocerySurcharge: 0,
    frozenSurchargeFee: 0,
    uSTaxTotal1: dollars(spec.tax),
    foreignTaxTotal1: 0,
    foreignTaxTotal2: 0,
    foreignTaxTotal3: 0,
    foreignTaxTotal4: 0,
    orderTotal: dollars(orderTotal),
    nonMemberSurchargeAmount: 0,
    discountAmount: dollars(discount),
    retailDeliveryFees: [],
    developmentFees: [],
    orderPayment: spec.payments.map((payment) => ({
      paymentType: payment.type, totalCharged: dollars(payment.charged), cardNumberLast4: payment.shopCard === true ? '' : payment.last4,
      isGOMPayment: payment.gom === true, storedValueBucket: payment.shopCard === true ? 'ShopCard' : '',
    })),
    shipToAddress: [{ isShipToWarehouse: false, addressWarehouseName: SYNTHETIC_PLACE.warehouseName, orderLineItems: rawLines }],
  };
  const consolidated = {
    orderNumber,
    orderHeaderId: `6${String(spec.seed).padStart(8, '0')}`,
    orderDate: date,
    orderPlacedRaw: spec.placed,
    rangeLabel: 'Synthetic range',
    status: spec.status,
    warehouseNumber: 847,
    total: money(orderTotal),
    merchandiseTotal: money(merchandise),
    shippingAndHandling: money(shipping),
    tax: money(spec.tax),
    discount: money(discount),
    shopCardApplied: money(spec.shopCardApplied ?? 0),
    walletShopCardApplied: money(wallet),
    retailDeliveryFee: money(0),
    nonMemberSurcharge: money(0),
    payments: spec.payments.map((payment) => ({
      type: payment.type, last4: payment.shopCard === true ? null : payment.last4, charged: money(payment.charged),
      isGiftOfMembership: payment.gom === true, storedValueBucket: payment.shopCard === true ? 'ShopCard' : null,
    })),
    flags: { cancelled: spec.status === 'Cancelled', returned: spec.status === 'Returned', refunded: null, refundNote: 'synthetic' },
    cancelledDate: null,
    returnedDate: null,
    shippedDate: null,
    deliveredDate: null,
    hasPreciousMetal: spec.lines.some((line) => line.pullMetal === true),
    lines: spec.lines.map((line) => ({
      lineItemId: syntheticLineId(spec.seed, line.line),
      itemNumber: line.number,
      itemId: 1000 + line.line,
      description: line.title,
      isFeeItem: line.feeParent !== undefined,
      qty: line.qty,
      unitPrice: money(line.price),
      merchandiseTotal: money(merchOf(line)),
      shippingCharge: money(line.shipping ?? 0),
      lineTax: null,
      status: 'Available',
      listStatus: spec.status,
      returnStatus: 'Returnable',
      returnType: null,
      returnableQuantity: '1',
      totalReturnedQuantity: String(total((line.returned ?? []).map((event) => event.qty))),
      isPreciousMetal: line.pullMetal === true,
      metal: line.pullMetal === true ? 'XAU' : null,
      weightOztPerUnit: line.pullMetal === true ? 1 : null,
      shipMethod: line.shipMethod ?? 'Standard',
      programType: 'SiteControlledInventory',
      events: {},
      shipments: [],
    })),
    detailCaptured: true,
    detailCapturedAt: SYNTHETIC_CAPTURED_AT,
  };
  const file = {
    routeOpened: '/myaccount/#/app/synthetic/orderdetails/x', orderNumber, status: 200, capturedAt: SYNTHETIC_CAPTURED_AT,
    response: { data: { getOrderDetails: details } },
  };
  return { consolidated, file, orderNumber };
}

/** A whole synthetic membership capture. */
export function syntheticCostcoCapture(spec: SyntheticCaptureSpec): SyntheticCapture {
  const folder = spec.folder ?? 'costco';
  const receipts = (spec.receipts ?? []).map(buildReceipt);
  const orders = (spec.orders ?? []).map(buildOrder);
  const provenance: Record<string, unknown> = {
    source: 'costco.com',
    capturedBy: 'synthetic',
    capturedAt: SYNTHETIC_CAPTURED_AT,
    currency: spec.currency ?? 'USD',
    dateNote: 'synthetic',
    online: {
      path: 'synthetic', how: 'synthetic', rangesOffered: 1, earliestRangeStart: '2025-01-01', latestRangeEnd: '2025-12-31',
      ranges: [{ label: 'Synthetic range', start: '2025-01-01', end: '2025-12-31', statedTotal: orders.length, rowsSeen: orders.length, pages: [1] }],
      rowsSeen: orders.length, statedTotal: orders.length,
    },
    onlineDetails: { path: 'synthetic', how: 'synthetic', captured: orders.length, of: orders.length },
    warehouse: {
      path: 'synthetic', how: 'synthetic',
      ranges: [{
        label: 'Synthetic range', start: '2025-01-01', end: '2025-12-31', rowsSeen: receipts.length,
        counts: { inWarehouse: receipts.length, gasStation: 0, carWash: 0, gasAndCarWash: 0 },
      }],
      rowsSeen: receipts.length, detailsCaptured: receipts.length,
    },
  };
  if (spec.account !== undefined) {
    provenance.accountFolder = folder;
    provenance.account = spec.account === null ? null : {
      folder, identityCheckedAt: SYNTHETIC_CAPTURED_AT, greetingFirstName: SYNTHETIC_FIRST_NAME, tier: spec.account.tier,
      memberSinceYear: spec.account.memberSinceYear, membershipLast4: spec.account.membershipLast4, membershipLast4Source: 'synthetic',
      distinctFrom: { folder: 'costco', greetingFirstName: SYNTHETIC_FIRST_NAME, memberSinceYear: '2001', onlineOrderOverlap: 0, receiptBarcodeOverlap: 0 },
    };
  }
  return {
    consolidated: {
      schema: spec.schema ?? 'holdr-retail-capture/costco@1',
      provenance,
      onlineOrders: orders.map((order) => order.consolidated),
      warehouseReceipts: receipts.map((receipt) => receipt.consolidated),
    },
    rawReceipts: receipts.filter((_, index) => spec.receipts![index].noRaw !== true)
      .map((receipt, index) => ({ name: `receipt-${String(index).padStart(4, '0')}.json`, json: receipt.file })),
    rawDetails: orders.filter((_, index) => spec.orders![index].noRaw !== true)
      .map((order) => ({ name: `detail-${order.orderNumber}.json`, json: order.file })),
  };
}

/** A small capture with one of everything: groceries with a coupon, gas, a return, a split tender, online orders. */
export function syntheticMembershipSpec(): SyntheticCaptureSpec {
  return {
    folder: 'costco-2',
    account: { memberSinceYear: '2001', tier: 'Gold Star', membershipLast4: '0042' },
    receipts: [
      {
        seed: 1,
        dateTime: '2025-03-01T10:15:00',
        items: [
          { number: '100001', title: 'KS ORGANIC EGGS', title2: '24 CT', amount: 899, department: 17 },
          { number: '100002', title: 'PAPER TOWELS', title2: '12 ROLLS', amount: 2299, department: 14 },
          { number: '300001', title: '/100002', amount: -400, unitPrice: 0, taxFlag: null, department: 14 },
        ],
        taxes: 150,
        instantSavings: 400,
        tenders: [{ name: 'VISA', last4: SYNTHETIC_CARD, amount: 899 + 2299 - 400 + 150 }],
      },
      {
        seed: 2,
        dateTime: '2025-03-04T18:02:11',
        gas: true,
        items: [{ number: '000001', title: 'REGULAR', amount: 4321, fuelGallons: 12.345, fuelPrice: 3.499, taxFlag: null }],
        taxes: 0,
        tenders: [{ name: 'VI Acct #', code: 'CreditDebit', subType: 'VisaCoBranded', last4: SYNTHETIC_CARD, amount: 4321 }],
      },
      {
        seed: 3,
        dateTime: '2025-03-09T09:00:00',
        items: [{ number: '100002', title: 'PAPER TOWELS', title2: '12 ROLLS', unit: -1, amount: -2299 }],
        taxes: -120,
        tenders: [{ name: 'RTC Whse Pur', last4: SYNTHETIC_CARD, amount: -2299 - 120 }],
      },
      {
        seed: 4,
        dateTime: '2025-04-11T13:30:00',
        items: [
          { number: '100003', title: 'ROTISSERIE CHICKEN', amount: 499 },
          { number: '100004', title: 'KS WATER', title2: '40 PK', amount: 399 },
        ],
        taxes: 0,
        tenders: [
          { name: '2% Rebate', last4: SYNTHETIC_CERTIFICATE, amount: 300 },
          { name: 'COSTCO VISA', last4: SYNTHETIC_CARD_2, amount: 598 },
        ],
      },
    ],
    orders: [
      {
        seed: 1,
        placed: '2025-05-02T21:10:00',
        status: 'Delivered',
        lines: [
          {
            line: 1, number: '2000001', title: 'Sample Tire 205/55R16', qty: 4, price: 12999,
            shipped: [{ qty: 4, date: '2025-05-04' }], delivered: [{ qty: 4, date: '2025-05-07' }],
            shipments: [{ shipped: '2025-05-04', delivered: '2025-05-07', carrier: 'UPS' }],
          },
          { line: 2, number: '2000002', title: 'Tire Installation', qty: 4, price: 2499, feeParent: 1 },
        ],
        tax: 3100,
        discount: 5000,
        payments: [
          { type: 'Visa', last4: SYNTHETIC_CARD, charged: 4 * 12999 + 4 * 2499 + 3100 - 5000 },
          { type: 'Coupon', last4: '0000', charged: 5000 },
        ],
      },
      {
        seed: 2,
        placed: '2025-06-10T08:00:00',
        status: 'Shipped',
        lines: [{
          line: 1, number: '2000003', title: '1 oz Gold Bar Sample Refinery (New in Assay)', qty: 2, price: 250000, pullMetal: true,
          shipMethod: 'Express, Signature Required', shipped: [{ qty: 2, date: '2025-06-12' }],
          shipments: [{ shipped: '2025-06-12', estimated: '2025-06-15', carrier: 'FedEx' }],
        }],
        tax: 0,
        payments: [{ type: 'Master Card', last4: SYNTHETIC_CARD_2, charged: 500000 }],
      },
      {
        seed: 3,
        placed: '2025-07-01T12:00:00',
        status: 'Cancelled',
        lines: [{ line: 1, number: '2000004', title: 'Sample Patio Set', qty: 1, price: 99999, merch: 0, cancelled: [{ qty: 1, date: '2025-07-02' }] }],
        tax: 0,
        total: 0,
        payments: [{ type: 'Visa', last4: SYNTHETIC_CARD, charged: 99999 }],
      },
    ],
  };
}

/** Every invented value of `syntheticMembershipSpec` that must never appear in a report or log. */
export function syntheticSensitiveValues(): string[] {
  return [
    syntheticBarcode(1), syntheticBarcode(2), syntheticBarcode(3), syntheticBarcode(4),
    syntheticOrderNumber(1), syntheticOrderNumber(2), syntheticOrderNumber(3),
    syntheticLineId(1, 1), syntheticLineId(2, 1),
    SYNTHETIC_CARD, SYNTHETIC_CARD_2, SYNTHETIC_CERTIFICATE, '0042',
    SYNTHETIC_PLACE.city, SYNTHETIC_PLACE.shortName, SYNTHETIC_FIRST_NAME,
    'ORGANIC EGGS', 'PAPER TOWELS', 'ROTISSERIE', 'Sample Tire', 'Gold Bar', 'Patio',
    '8.99', '22.99', '43.21', '3.499', '129.99', '2500', '5000.00',
  ];
}
