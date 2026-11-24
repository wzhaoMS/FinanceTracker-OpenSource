import { describe, it, expect } from 'vitest';

import {
  parseFidelityDate,
  parseSignedMoney,
  parseQuantity,
  parseAccountLast4,
  parseDescription,
  parseActivityRow,
  computeFingerprint,
  classifyForImport,
  roundTo4,
  type ActivityRow,
} from './activityParser.js';

describe('parseFidelityDate', () => {
  it('parses canonical Mon-DD-YYYY', () => {
    expect(parseFidelityDate('May-07-2026')).toBe('2026-05-07');
    expect(parseFidelityDate('Jan-01-2026')).toBe('2026-01-01');
    expect(parseFidelityDate('Dec-31-2099')).toBe('2099-12-31');
  });

  it('handles single-digit days', () => {
    expect(parseFidelityDate('Apr-1-2026')).toBe('2026-04-01');
  });

  it('returns null for unknown month abbreviations', () => {
    expect(parseFidelityDate('Foo-07-2026')).toBeNull();
  });

  it('returns null for non-Fidelity formats', () => {
    expect(parseFidelityDate('2026-05-07')).toBeNull();
    expect(parseFidelityDate('05/07/2026')).toBeNull();
    expect(parseFidelityDate('')).toBeNull();
  });

  it('returns null for impossible calendar dates', () => {
    expect(parseFidelityDate('Feb-30-2026')).toBeNull();
    expect(parseFidelityDate('Apr-31-2026')).toBeNull();
    expect(parseFidelityDate('Feb-29-2025')).toBeNull();
    expect(parseFidelityDate('Feb-29-2024')).toBe('2024-02-29');
  });
});

describe('parseSignedMoney', () => {
  it.each([
    ['$127.00', 127],
    ['+$127.00', 127],
    ['-$127.00', -127],
    ['+$3,434.57', 3434.57],
    ['-$13,663.00', -13663],
    ['+$152.07', 152.07],
    ['-$0.03', -0.03],
    ['$0', 0],
  ])('parses %s as %s', (input, expected) => {
    expect(parseSignedMoney(input)).toBeCloseTo(expected as number, 2);
  });

  it('returns null for unparseable input', () => {
    expect(parseSignedMoney(undefined)).toBeNull();
    expect(parseSignedMoney('')).toBeNull();
    expect(parseSignedMoney('—')).toBeNull();
    expect(parseSignedMoney('abc')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('parses positive numbers', () => {
    expect(parseQuantity('1')).toBe(1);
    expect(parseQuantity('830.462')).toBe(830.462);
    expect(parseQuantity('1,234.5')).toBe(1234.5);
  });
  it('strips a leading sign and returns the magnitude', () => {
    // Fidelity's expanded panel formats SELL shares as `-1.000`;
    // the sign convention is applied later from the action verb.
    expect(parseQuantity('+1.000')).toBe(1);
    expect(parseQuantity('-1.000')).toBe(1);
    expect(parseQuantity('-5')).toBe(5);
  });
  it('rejects zero', () => {
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('-0')).toBeNull();
  });
  it('returns null for empty / nonsense', () => {
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
    expect(parseQuantity('abc')).toBeNull();
  });
});

describe('parseAccountLast4', () => {
  it('extracts from a *** mask suffix', () => {
    expect(parseAccountLast4('BrokerageLink ***2943')).toBe('2943');
    expect(parseAccountLast4('ROTH IRA ***6741')).toBe('6741');
    expect(parseAccountLast4('Health Savings Account ***2685')).toBe('2685');
    expect(parseAccountLast4('Individual - TOD ***5841')).toBe('5841');
    expect(parseAccountLast4('MICROSOFT 401K PLAN ****3796')).toBe('3796');
  });

  it('falls back to last 4 alphanumerics when no mask', () => {
    expect(parseAccountLast4('Z85325841')).toBe('5841');
    expect(parseAccountLast4('868782943')).toBe('2943');
  });

  it('returns null when fewer than 4 alphanumerics', () => {
    expect(parseAccountLast4('a')).toBeNull();
    expect(parseAccountLast4('***')).toBeNull();
    expect(parseAccountLast4(undefined)).toBeNull();
  });
});

/**
 * The descriptions below are pulled verbatim from a real Fidelity
 * "Activity & Orders" page (see /docs screenshot 2026-05-07). If a future
 * version of Fidelity changes one of these strings, the failing test
 * tells us exactly which one to update.
 */
describe('parseDescription', () => {
  it('classifies BUY rows and extracts the ticker', () => {
    expect(parseDescription('YOU BOUGHT COREWEAVE INC COM CL A (CRWV) (Cash)')).toEqual({
      action: 'BUY',
      symbol: 'CRWV',
    });
    expect(parseDescription('YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)')).toEqual({
      action: 'BUY',
      symbol: 'NBIS',
    });
    expect(parseDescription('YOU BOUGHT MICROSOFT CORP (MSFT) (Cash)')).toEqual({
      action: 'BUY',
      symbol: 'MSFT',
    });
  });

  it('classifies SELL rows', () => {
    expect(parseDescription('YOU SOLD TESLA INC COM (TSLA) (Cash)')).toEqual({
      action: 'SELL',
      symbol: 'TSLA',
    });
  });

  it('parses the verified Fidelity sell-to-open put contract', () => {
    expect(parseDescription(
      'YOU SOLD OPENING TRANSACTION PUT (NBIS) NEBIUS GROUP N V COM JUL 31 26 $165 (100 SHS) (Cash)',
    )).toEqual({
      action: 'SELL_TO_OPEN',
      symbol: 'NBIS260731P00165000',
      instrumentType: 'option',
      contractMultiplier: 100,
      positionEffect: 'open',
    });
  });

  it('does not treat an Orders-page canceled order as completed activity', () => {
    expect(parseDescription(
      'Sell to Open 1 Contract NBIS Jul 31 2026 165 Put Limit at $7.57 (Day) Verified Canceled',
    )).toEqual({ action: 'UNKNOWN', symbol: null });
  });

  it('classifies REINVESTMENT rows', () => {
    expect(parseDescription('REINVESTMENT FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)')).toEqual({
      action: 'REINVEST',
      symbol: 'FDRXX',
    });
    expect(parseDescription('REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)')).toEqual({
      action: 'REINVEST',
      symbol: 'SPAXX',
    });
  });

  it('classifies DIVIDEND rows (no symbol extracted — cash event)', () => {
    expect(parseDescription('DIVIDEND RECEIVED FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)')).toEqual({
      action: 'DIVIDEND',
      symbol: null,
    });
    expect(parseDescription('DIVIDEND RECEIVED FIDELITY TREASURY MONEY MARKET FUND (FZFXX) (Cash)')).toEqual({
      action: 'DIVIDEND',
      symbol: null,
    });
  });

  it('classifies TRANSFER rows', () => {
    expect(parseDescription('TRANSFERRED FROM TO BROKERAGE OPTION (Cash)')).toEqual({
      action: 'TRANSFER',
      symbol: null,
    });
  });

  it('classifies CONTRIB rows', () => {
    expect(parseDescription('Contributions')).toEqual({ action: 'CONTRIB', symbol: null });
    expect(parseDescription('PARTIC CONTR CURRENT PARTICIPANT CUR YR (Cash)')).toEqual({
      action: 'CONTRIB',
      symbol: null,
    });
  });

  it('classifies ACH rows', () => {
    expect(parseDescription('Electronic Funds Transfer Paid (Cash)')).toEqual({
      action: 'ACH',
      symbol: null,
    });
    expect(parseDescription('DIRECT DEBIT CAPITAL ONE ONLINE PMT (Cash)')).toEqual({
      action: 'ACH',
      symbol: null,
    });
    expect(parseDescription('DIRECT DEBIT AMEX EPAYMENT ACH PMT (Cash)')).toEqual({
      action: 'ACH',
      symbol: null,
    });
  });

  it('returns UNKNOWN for descriptions we have not seen', () => {
    expect(parseDescription('SOMETHING WEIRD HAPPENED')).toEqual({
      action: 'UNKNOWN',
      symbol: null,
    });
    expect(parseDescription('')).toEqual({ action: 'UNKNOWN', symbol: null });
  });
});

describe('parseActivityRow', () => {
  const buy: ActivityRow = {
    date: 'May-07-2026',
    accountLabel: 'BrokerageLink ***2943',
    description: 'YOU BOUGHT COREWEAVE INC COM CL A (CRWV) (Cash)',
    amount: '-$127.00',
    quantity: '1',
    pricePerUnit: '$127.00',
  };

  it('parses a BUY end-to-end', () => {
    const p = parseActivityRow(buy);
    expect(p).toMatchObject({
      date: '2026-05-07',
      accountLast4: '2943',
      action: 'BUY',
      symbol: 'CRWV',
      quantity: 1,        // positive
      pricePerUnit: 127,
    });
  });

  it('signs SELL quantities negative', () => {
    const sell: ActivityRow = {
      date: 'May-04-2026',
      accountLabel: 'ROTH IRA ***6741',
      description: 'YOU SOLD TESLA INC COM (TSLA) (Cash)',
      amount: '+$152.07',
      quantity: '0.4',
      pricePerUnit: '$380.18',
    };
    expect(parseActivityRow(sell)).toMatchObject({
      action: 'SELL',
      symbol: 'TSLA',
      quantity: -0.4,
      pricePerUnit: 380.18,
    });
  });

  it('keeps qty/price null for cash events even if the bridge sent them', () => {
    // Imagine the bridge expanded a DIVIDEND row by accident — we still
    // shouldn't import it as a position. The classifier handles that;
    // the parser just records what was seen.
    const div: ActivityRow = {
      date: 'Apr-30-2026',
      accountLabel: 'BrokerageLink ***2943',
      description: 'DIVIDEND RECEIVED FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)',
      amount: '+$64.10',
      quantity: undefined,
      pricePerUnit: undefined,
    };
    const p = parseActivityRow(div);
    expect(p.action).toBe('DIVIDEND');
    expect(p.symbol).toBeNull();
    expect(p.quantity).toBeNull();
    expect(p.pricePerUnit).toBeNull();
  });

  it.each([
    ['4', '$6.10', '+$2,437.28', -4, 2.72],
    ['1', '$8.45', '+$844.32', -1, 0.68],
  ])('reconciles the verified option fill %s @ %s', (quantity, pricePerUnit, amount, signedQuantity, fees) => {
    const parsed = parseActivityRow({
      date: 'Jul-10-2026',
      accountLabel: 'Individual *****7142',
      description: 'YOU SOLD OPENING TRANSACTION PUT (NBIS) NEBIUS GROUP N V COM JUL 31 26 $165 (100 SHS) (Cash)',
      amount,
      quantity,
      pricePerUnit,
    });
    expect(parsed).toMatchObject({
      date: '2026-07-10',
      accountLast4: '7142',
      action: 'SELL_TO_OPEN',
      symbol: 'NBIS260731P00165000',
      quantity: signedQuantity,
      pricePerUnit: Number(pricePerUnit.slice(1)),
      fees,
      instrumentType: 'option',
      contractMultiplier: 100,
      positionEffect: 'open',
    });
    expect(classifyForImport(parsed)).toEqual({ kind: 'import' });
  });
});

describe('computeFingerprint', () => {
  const sample = {
    date: '2026-05-07',
    accountLast4: '2943',
    action: 'BUY' as const,
    symbol: 'CRWV',
    quantity: 1,
    pricePerUnit: 127,
  };

  it('is stable across re-runs (same input → same hash)', () => {
    expect(computeFingerprint(sample)).toBe(computeFingerprint(sample));
  });

  it('returns a 64-char lowercase hex string', () => {
    const fp = computeFingerprint(sample);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats price-rounding noise as identical (4-dp rounding)', () => {
    // Both round to 127.0000 — the real noise we want to absorb is
    // sub-1e-5, which is well below our 4-dp grain.
    const a = computeFingerprint({ ...sample, pricePerUnit: 127.0000049 });
    const b = computeFingerprint({ ...sample, pricePerUnit: 127.0000099 });
    expect(a).toBe(b);
  });

  it('changes when action changes', () => {
    expect(computeFingerprint(sample)).not.toBe(
      computeFingerprint({ ...sample, action: 'SELL' }),
    );
  });

  it('changes when account changes (so the same trade in another account is unique)', () => {
    expect(computeFingerprint(sample)).not.toBe(
      computeFingerprint({ ...sample, accountLast4: '6741' }),
    );
  });

  it('changes when quantity changes by >1e-4', () => {
    expect(computeFingerprint({ ...sample, quantity: 1 })).not.toBe(
      computeFingerprint({ ...sample, quantity: 2 }),
    );
  });

  it('handles missing fields without throwing', () => {
    const fp = computeFingerprint({
      date: '2026-05-07',
      accountLast4: null,
      action: 'DIVIDEND',
      symbol: null,
      quantity: null,
      pricePerUnit: null,
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('classifyForImport', () => {
  const baseImport = {
    date: '2026-05-07',
    accountLast4: '2943',
    action: 'BUY' as const,
    symbol: 'CRWV',
    quantity: 1,
    pricePerUnit: 127,
    fees: null,
    rawDescription: 'YOU BOUGHT COREWEAVE INC COM CL A (CRWV) (Cash)',
    rawAmount: '-$127.00',
  };

  it('imports a complete BUY', () => {
    expect(classifyForImport(baseImport)).toEqual({ kind: 'import' });
  });

  it('imports a SELL with negative quantity', () => {
    expect(classifyForImport({ ...baseImport, action: 'SELL', quantity: -1 })).toEqual({
      kind: 'import',
    });
  });

  it.each(['DIVIDEND', 'TRANSFER', 'CONTRIB', 'ACH'] as const)(
    'classifies %s as skip-cash',
    (action) => {
      const r = classifyForImport({ ...baseImport, action, symbol: null, quantity: null, pricePerUnit: null });
      expect(r.kind).toBe('skip-cash');
    },
  );

  it('classifies UNKNOWN as reject-unknown', () => {
    const r = classifyForImport({ ...baseImport, action: 'UNKNOWN', symbol: null });
    expect(r.kind).toBe('reject-unknown');
  });

  it('skips FDRXX/SPAXX REINVEST by default (sweep policy)', () => {
    expect(classifyForImport({ ...baseImport, action: 'REINVEST', symbol: 'FDRXX' }).kind).toBe('skip-sweep');
    expect(classifyForImport({ ...baseImport, action: 'REINVEST', symbol: 'SPAXX' }).kind).toBe('skip-sweep');
  });

  it('imports FDRXX/SPAXX REINVEST when user opts in', () => {
    expect(
      classifyForImport(
        { ...baseImport, action: 'REINVEST', symbol: 'FDRXX' },
        { importSweep: true },
      ).kind,
    ).toBe('import');
  });

  it('imports a non-sweep REINVEST as a normal buy', () => {
    expect(
      classifyForImport({ ...baseImport, action: 'REINVEST', symbol: 'AAPL' }).kind,
    ).toBe('import');
  });

  it('rejects rows the bridge could not enrich (no qty/price)', () => {
    expect(classifyForImport({ ...baseImport, quantity: null }).kind).toBe('reject-incomplete');
    expect(classifyForImport({ ...baseImport, pricePerUnit: null }).kind).toBe('reject-incomplete');
    expect(classifyForImport({ ...baseImport, pricePerUnit: 0 }).kind).toBe('reject-incomplete');
  });

  it('rejects rows with unparseable date', () => {
    const r = classifyForImport({ ...baseImport, date: '' });
    expect(r.kind).toBe('reject-incomplete');
  });
});

describe('roundTo4', () => {
  it.each([
    [1.000049, 1.0],
    [1.00005, 1.0001],
    [127.00009, 127.0001],
    [-0.00004, -0],
  ])('rounds %s to %s', (input, expected) => {
    expect(roundTo4(input as number)).toBeCloseTo(expected as number, 4);
  });
});
