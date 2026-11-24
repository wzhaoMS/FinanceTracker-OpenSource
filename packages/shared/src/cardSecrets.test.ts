import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { containsCardData } from './cardNumbers.js';
import { containsCardSecret } from './cardSecrets.js';

describe('card secret detection', () => {
  it('flags labeled security codes, tolerant of case and separators', () => {
    const texts = [
      'CVV 123', 'cvv: 123', 'CVV2=123', 'CVV2 1234', 'cvc 1234', 'CVC2: 123', 'CVN 123', 'CAV2 123',
      'CID: 1234', 'csc 123', 'C.V.V. 123', 'c v v 123', 'CVV#123', 'CVV-123', 'cvv is 123', 'CVV code: 123',
      'CVV no. 123', 'security code 1234', 'Security Code: 123', 'card security code 123',
      'Card Verification Value 1234', 'CVV 1 2 3', '(cvv 123)',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), true, text);
  });

  it('flags labeled PINs', () => {
    for (const text of ['PIN 1234', 'pin: 123456', 'PIN#4321', 'PIN code 9876', 'pin number 1234 5678', 'PIN=0000']) {
      assert.equal(containsCardSecret(text), true, text);
    }
  });

  it('flags labeled expiry dates in the usual formats', () => {
    const texts = [
      'exp 12/29', 'EXP: 12-2029', 'Exp. 1/29', 'exp date 12/29', 'Exp. Date: 12 / 2029', 'expiry 2029-12',
      'expiry date 12/29', 'Expiration: 12/2029', 'expires 12/29', 'exp 1229', 'exp Dec 2029', 'expires December 29',
      'valid thru 12/29', 'VALID THROUGH 12-29', 'good thru 12/29', 'exp:12/29',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), true, text);
  });

  it('finds secrets inside longer text and in other Unicode forms', () => {
    const texts = [
      'CVV 123; expiry 12/29',
      'card ending 0003 cvv 123',
      'note: exp 12/29 for the gold card',
      'ＣＶＶ：１２３',
      'C\u200bVV 1\u200b23',
      'cvv \u0661\u0662\u0663',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), true, JSON.stringify(text));
  });

  it('flags quoted, structured and widely spaced label/value pairs', () => {
    const texts = [
      // Review examples.
      '{"cvv":"123","expiry":"12/29"}',
      "cvv = '123'",
      'expiry_date=12/29',
      'CVV:     123',
      // JSON, escaped JSON and quoted assignments.
      "{'cvv': '123'}",
      '{"card": {"cvc": 4567}}',
      '"{\\"cvv\\":\\"123\\"}"',
      'cvv="123"',
      '"cvv" : "123"',
      'CVV:\t\t\t123',
      'cvv\n:\n123',
      'CVV::::123',
      'cvv => 123',
      'cvv -> 123',
      'cvv: [123]',
      'cvv|123',
      '\u201ccvv\u201d: \u201c123\u201d',
      // snake_case, kebab-case and camelCase labels.
      '"security_code": "1234"',
      'securityCode=1234',
      'card-security-code: 123',
      '"card_cvv":"123"',
      'cardCvv: 123',
      'cvvNumber: 123',
      '"cvv2":"123"',
      '{"pin":"1234"}',
      "pin_code = '9876'",
      'pinCode: 123456',
      '"exp_date":"12/29"',
      "expDate: '12/2029'",
      '"expiration":"2029-12"',
      'expirationDate = 12/29',
      'expiry-date: 12/29',
      '{"expMonth":12,"expYear":2029}',
      'exp_month=12',
      '"exp_year": "29"',
      'expiryYear: 2029',
      'valid_thru: 12/29',
      'validThru="12/29"',
      'mm/yy: 12/29',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), true, JSON.stringify(text));
  });

  it('flags record-delimited, bracketed and hinted label/value pairs', () => {
    const texts = [
      // Review examples.
      'cvv, 123',
      'cvv; 123',
      '(CVV): 123',
      '[CVV] = 123',
      'Expiry (MM/YY): 12/29',
      // Record delimiters, including tab and newline.
      'CVV,123',
      'cvv;123',
      'cvv\t123',
      'cvv\n123',
      'cvv,123,exp,12/29',
      'name;J DOE;pin;4321',
      'PIN; 1234',
      'expiry, 12/29',
      'valid thru; 12/29',
      'cvv \u2014 123',
      // Wrapped labels and values.
      '{CVV}: 123',
      '<cvv>123</cvv>',
      '(cvv2) 123',
      'cvv: (123)',
      '[expiry]: [12/29]',
      // Format hints after a label.
      'Expiry [mm/yy] 12/29',
      'Exp. (MM/YY) 12/29',
      'exp date (mm/yyyy): 12/2029',
      'Security code (CVV2): 1234',
      'CVV (3 digits): 123',
      'card verification value (on back) = 123',
      'Expiry (MM): 12',
      'expiry month (mm): 12',
      'Expiry Year (YYYY): 2029',
      'exp (yy) 29',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), true, JSON.stringify(text));
  });

  it('leaves ordinary merchant and statement text alone', () => {
    const texts = [
      'EXPEDIA 7284561',
      'EXPEDIA.COM 12/29',
      'CVS PHARMACY #1234',
      'CVS/PHARMACY 0123',
      'PINTEREST 1234',
      'SPINNAKER CAFE 4421',
      'PINE ST GARAGE 1234',
      'CIDER MILL 123',
      'CSC SERVICEWORKS 1234',
      'HOME SECURITY 1234',
      'SECURITY DEPOSIT REFUND 1500',
      'AMEX EXPRESS 12/29',
      'VALIDATION FEE 1229',
      'PAYMENT DUE 12/29',
      'offer expires 12/29/2026',
      'warranty expires 2026-12-29',
      'EXP REWARDS 2029',
      'PIN',
      'CVV',
      'cvv 12',
      'cvv 12345',
      'PIN 12',
      'exp 13/29',
      'ORDER 4111 1111 1111 1111',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), false, text);
  });

  it('leaves realistic statement descriptors and non-secret keys alone', () => {
    const texts = [
      'EXPRESS SCRIPTS 800-282-2881',
      'EXP REALTY LLC 12/29',
      'EXPEDIA*TRAVEL 7284561',
      'EXPO HALL PARKING 1229',
      'EXPENSIFY INC 12/29',
      'ExpensifyCard 12/29',
      'CVS/PHARMACY #08123 BOSTON MA',
      'PINKBERRY 0123',
      'PINNACLE BANK 1234',
      'SQ *PIN-UP NAILS 0423',
      'TST* SPIN PIZZA 1234',
      'PAYPAL *PINTEREST 4029357733',
      'PinPoint Pharmacy 1234',
      'CIDERHOUSE BREWING 123',
      'CIDCO 1234',
      'CSC*SERVICEWORKS 800-554-6880',
      'GOOD THRU THE WEEK 12/29',
      "MCDONALD'S F12345 06/29",
      'SAFEWAY #1229 SECURITY CAMERA',
      '{"merchant":"EXPEDIA","amount":"12.29"}',
      '{"expense":"12/29","pending":"1234","spin":"1234"}',
      '{"expected_date":"2029-12-01","pinned":true}',
      'order_id=1234, expedited=12/29',
      // Delimiters and brackets around words that are not labels.
      'PIN, INC',
      'PIN, INC 1234 MAIN ST',
      'CVS, #123',
      'CVS; #0123 BOSTON MA',
      'EXPRESS (MM) 12',
      'EXPO (MM) 12',
      'EXPENSE REPORT 12/29',
      'WALGREENS #1234, BOSTON MA',
      'NETFLIX.COM [STREAMING] 12/29',
      'UBER *TRIP; HELP.UBER.COM 1229',
      'CVS/PHARMACY, #08123',
      'PINTEREST (ADS) 1234',
      'EXPEDIA, INC 12/29',
      'CSC SERVICEWORKS; 1234',
      'SPIN, INC; 1234',
      'AMAZON.COM*2K4X95 (AMZN.COM/BILL) WA',
      'PINE ST, 1234',
      'CIDER MILL (CO), 123',
      'SECURITY (DEPOSIT), 1500',
      'VALID (PARKING), 1229',
      'GOOD (THRU) THE WEEK 12/29',
      'PIN (PAD) RENTAL, 1234',
    ];
    for (const text of texts) assert.equal(containsCardSecret(text), false, text);
  });

  it('is independent of card number detection', () => {
    assert.equal(containsCardSecret('4111111111111111'), false);
    assert.equal(containsCardData('CVV 123; expiry 12/29'), false);
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    const hostile = [
      'cvv '.repeat(100_000),
      'exp 1'.repeat(100_000),
      'pin 1 '.repeat(100_000),
      'c.v.v.'.repeat(100_000),
      `cvv${' '.repeat(500_000)}x`,
      `cvv${': '.repeat(250_000)}x`,
      `cvv${'=:-.|>([{'.repeat(50_000)}x`,
      `${'cvv'.padEnd(1_000, ':')} x `.repeat(500),
      '"cvv":"'.repeat(100_000),
      'aB'.repeat(250_000),
      'exp_month_'.repeat(50_000),
    ];
    for (const text of hostile) assert.equal(containsCardSecret(text), false);
    assert.ok(Date.now() - started < 5000, `${Date.now() - started}ms`);
  });
});
