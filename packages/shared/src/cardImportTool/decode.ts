/**
 * Bytes to text for issuer exports, without platform encoders that vary by
 * Node build: UTF-8 (with or without BOM), UTF-16 with a BOM, and
 * Windows-1252. `auto` picks UTF-8 when the bytes are valid UTF-8 and
 * Windows-1252 otherwise, so the same file decodes identically everywhere.
 */

export type ExportEncoding = 'auto' | 'utf-8' | 'windows-1252';

export interface DecodedText {
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
}

// Windows-1252 0x80–0x9F; the five undefined bytes map to the C1 control of the same value, as WHATWG does.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

export class ExportDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportDecodeError';
  }
}

function fromUnits(units: number[]): string {
  let text = '';
  for (let i = 0; i < units.length; i += 8192) text += String.fromCharCode(...units.slice(i, i + 8192));
  return text;
}

function decodeWindows1252(bytes: Uint8Array): string {
  const units: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    units[i] = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte;
  }
  return fromUnits(units);
}

/** Strict UTF-8: no overlongs, surrogates or code points above U+10FFFF. Null when invalid. */
function decodeUtf8(bytes: Uint8Array): string | null {
  const units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let code: number;
    let size: number;
    if (b0 < 0x80) {
      code = b0;
      size = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      size = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      size = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      size = 4;
    } else {
      return null;
    }
    if (i + size > bytes.length) return null;
    for (let k = 1; k < size; k += 1) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) return null;
      code = (code << 6) | (b & 0x3f);
    }
    if ((size === 3 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) || (size === 4 && (code < 0x10000 || code > 0x10ffff))) {
      return null;
    }
    if (code >= 0x10000) {
      code -= 0x10000;
      units.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      units.push(code);
    }
    i += size;
  }
  return fromUnits(units);
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  if (bytes.length % 2 !== 0) throw new ExportDecodeError('the UTF-16 file has an odd number of bytes (it may be truncated)');
  const units: number[] = new Array(bytes.length / 2);
  for (let i = 0; i < bytes.length; i += 2) {
    units[i / 2] = littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
  }
  return fromUnits(units);
}

/**
 * Decodes an export. A UTF-8 BOM forces strict UTF-8 and a UTF-16 BOM forces
 * UTF-16; otherwise `auto` tries strict UTF-8, then Windows-1252. NUL
 * characters mean the file is binary or UTF-16 without a BOM and are refused.
 */
export function decodeExport(bytes: Uint8Array, encoding: ExportEncoding = 'auto'): DecodedText {
  let decoded: DecodedText;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoded = { text: decodeUtf16(bytes.subarray(2), true), encoding: 'utf-16le' };
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoded = { text: decodeUtf16(bytes.subarray(2), false), encoding: 'utf-16be' };
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    if (encoding === 'windows-1252') throw new ExportDecodeError('the file starts with a UTF-8 byte order mark; use --encoding utf-8 or auto');
    const text = decodeUtf8(bytes.subarray(3));
    if (text === null) throw new ExportDecodeError('the file is not valid UTF-8');
    decoded = { text, encoding: 'utf-8' };
  } else if (encoding === 'windows-1252') {
    decoded = { text: decodeWindows1252(bytes), encoding: 'windows-1252' };
  } else {
    const text = decodeUtf8(bytes);
    if (text === null && encoding === 'utf-8') throw new ExportDecodeError('the file is not valid UTF-8');
    decoded = text === null ? { text: decodeWindows1252(bytes), encoding: 'windows-1252' } : { text, encoding: 'utf-8' };
  }
  if (decoded.text.includes('\u0000')) throw new ExportDecodeError('the file contains NUL bytes; it is binary or an unsupported encoding');
  return decoded;
}
