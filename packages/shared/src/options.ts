export interface OptionContract {
  symbol: string;
  underlyingSymbol: string;
  expirationDate: string;
  optionType: 'call' | 'put';
  strikePrice: number;
}

const OCC_PATTERN = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOccSymbol(value: string): OptionContract | null {
  const symbol = value.trim().toUpperCase();
  const match = symbol.match(OCC_PATTERN);
  if (!match) return null;
  const [, underlyingSymbol, yearPart, monthPart, dayPart, optionPart, strikePart] = match;
  const year = 2000 + Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const expiration = new Date(Date.UTC(year, month - 1, day));
  if (
    expiration.getUTCFullYear() !== year
    || expiration.getUTCMonth() !== month - 1
    || expiration.getUTCDate() !== day
  ) return null;
  const strikePrice = Number(strikePart) / 1_000;
  if (!Number.isFinite(strikePrice) || strikePrice <= 0) return null;
  return {
    symbol,
    underlyingSymbol,
    expirationDate: `${yearPart.length === 2 ? `20${yearPart}` : yearPart}-${monthPart}-${dayPart}`,
    optionType: optionPart === 'C' ? 'call' : 'put',
    strikePrice,
  };
}

export function buildOccSymbol(args: {
  underlyingSymbol: string;
  expirationDate: string;
  optionType: 'call' | 'put';
  strikePrice: number;
}): string {
  const underlying = args.underlyingSymbol.trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(underlying)) throw new Error('option underlying must be 1-6 letters');
  const dateMatch = args.expirationDate.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!dateMatch) throw new Error('option expirationDate must be YYYY-MM-DD');
  const [, year, month, day] = dateMatch;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) throw new Error('option expirationDate is not a real calendar date');
  const strikeUnits = Math.round(args.strikePrice * 1_000);
  if (
    !Number.isFinite(args.strikePrice)
    || args.strikePrice <= 0
    || Math.abs(strikeUnits / 1_000 - args.strikePrice) > 1e-9
    || strikeUnits > 99_999_999
  ) throw new Error('option strikePrice must be positive with at most 3 decimal places');
  const optionCode = args.optionType === 'call' ? 'C' : 'P';
  return `${underlying}${year.slice(2)}${month}${day}${optionCode}${String(strikeUnits).padStart(8, '0')}`;
}

export function formatOptionSymbol(value: string): string {
  const contract = parseOccSymbol(value);
  if (!contract) return value;
  const date = new Date(`${contract.expirationDate}T12:00:00Z`);
  const expiration = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(date);
  const shortYear = contract.expirationDate.slice(2, 4);
  return `${contract.underlyingSymbol} ${expiration} '${shortYear} $${contract.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${contract.optionType === 'put' ? 'Put' : 'Call'}`;
}