import { describe, expect, it } from 'vitest';

import { parseSchwabNavStatementText } from './accountNavStatement.js';

const SCHWAB_TEXT = `
Charles Schwab & Co. Inc.
Statement Period
April 1-30, 2025ACCOUNT HOLDER
Account Number
XXXX-2468
Schwab One Account
This Statement YTD
Beginning Account Value $10,000.00 $9,500.00
Ending Account Value $12,345.67 $12,345.67
Account Summary
Ending Account Value as of 04/30 Beginning Account Value as of 04/01
$12,345.67 $10,000.00
`;

describe('parseSchwabNavStatementText', () => {
  it('extracts the period-ending account value and provenance fields', () => {
    expect(parseSchwabNavStatementText(SCHWAB_TEXT)).toEqual({
      broker: 'schwab',
      statementPeriodStart: '2025-04-01',
      statementPeriodEnd: '2025-04-30',
      observedAt: '2025-04-30',
      nav: 12_345.67,
      currency: 'USD',
      accountLast4: '2468',
      sourcePage: 1,
    });
  });

  it('does not mistake the statement/YTD summary for the account-summary NAV', () => {
    const changed = SCHWAB_TEXT.replace('$12,345.67 $10,000.00', '$54,321.09 $10,000.00');
    expect(parseSchwabNavStatementText(changed).nav).toBe(54_321.09);
  });

  it('rejects an account-summary date that conflicts with the statement period', () => {
    const changed = SCHWAB_TEXT.replace('Ending Account Value as of 04/30', 'Ending Account Value as of 04/29');
    expect(() => parseSchwabNavStatementText(changed)).toThrow(/does not match statement period end/i);
  });

  it('rejects text that is not recognizably a Schwab statement', () => {
    expect(() => parseSchwabNavStatementText('Account Summary $1,000.00')).toThrow(/Schwab/i);
  });
});