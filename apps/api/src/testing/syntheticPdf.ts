/**
 * Synthetic one-page PDFs for API tests: pdf-parse reads them as it reads a
 * real statement.
 */

/** A PDF made of `objects` (object 1 is the catalog), with a valid cross-reference table. */
export function pdfDocument(objects: readonly string[]): Buffer {
  let value = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  const size = objects.length + 1;
  value += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  value += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

/** A one-page PDF whose page content is the stream `contents` (object 5) over Helvetica (object 4). */
export function pdfPage(contents: string): Buffer {
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    contents,
  ]);
}

/** A one-page PDF whose text is `lines`, one per line. */
export function textPdf(lines: readonly string[]): Buffer {
  const text = 'BT /F1 11 Tf 50 750 Td ' + lines.map((line, i) =>
    `${i ? '0 -16 Td ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n') + ' ET';
  return pdfPage(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
}

/** A PDF of letter-size pages, each a list of `[x, y, text]` cells set in Helvetica 9 pt at those points (y grows upwards). */
export function positionedPdf(pages: ReadonlyArray<ReadonlyArray<readonly [number, number, string]>>): Buffer {
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  for (const [index, cells] of pages.entries()) {
    const text = cells.map(([x, y, value]) => `BT /F1 9 Tf 1 0 0 1 ${x} ${y} Tm (${value.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    );
  }
  return pdfDocument(objects);
}

/** The lines of a Schwab statement that parseSchwabNavStatementText accepts (April 2025, account XXXX-2468). */
export const SCHWAB_STATEMENT_LINES: readonly string[] = [
  'Charles Schwab & Co. Inc.', 'Statement Period', 'April 1-30, 2025ACCOUNT HOLDER',
  'Account Number', 'XXXX-2468', 'Account Summary',
  'Ending Account Value as of 04/30 Beginning Account Value as of 04/01', '$12,345.67 $10,000.00',
];
