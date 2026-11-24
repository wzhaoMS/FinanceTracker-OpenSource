/**
 * The positioned text of a statement PDF, for the offline converters only (cli/checkingConvert.ts for checking
 * statements, cli/cardStatementConvert.ts for card statements): pdf.js, as pdf-parse uses it, with evaluation and font
 * loading off. Never imported by the API server: raw bank files are read only on the owner's computer.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { CheckingPdfPage } from '@finance-tracker/shared/checking-import-tool';

export const MAX_STATEMENT_PAGES = 60;

interface TextItemLike {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

/** Each page's text pieces with their positions. Throws a message that names no content of the file. */
export async function pdfTextPages(data: Uint8Array): Promise<CheckingPdfPage[]> {
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    }).promise;
  } catch {
    // pdf.js's messages can quote the document (a filter or font name, say), so none of them leaves.
    throw new Error('the PDF could not be opened');
  }
  try {
    if (document.numPages > MAX_STATEMENT_PAGES) throw new Error(`the PDF has more than ${MAX_STATEMENT_PAGES} pages`);
    const pages: CheckingPdfPage[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      let items: CheckingPdfPage['items'];
      try {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        items = (content.items as TextItemLike[]).flatMap((item) => {
          const transform = item.transform;
          if (typeof item.str !== 'string' || !Array.isArray(transform) || typeof item.width !== 'number') return [];
          const [x, y] = [transform[4], transform[5]];
          return typeof x === 'number' && typeof y === 'number' ? [{ text: item.str, x, y, width: item.width }] : [];
        });
        page.cleanup();
      } catch {
        throw new Error(`page ${number} of the PDF could not be read`);
      }
      pages.push({ items });
    }
    return pages;
  } finally {
    await document.destroy();
  }
}
