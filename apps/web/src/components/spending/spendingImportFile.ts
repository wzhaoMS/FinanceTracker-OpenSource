/** Shown in the card import dialog when the browser cannot read the chosen file. */
export const UNREADABLE_FILE = 'The file could not be read: it may have been moved, changed or deleted after you chose it. Choose it again.';

/**
 * The chosen file's text, or the error the import dialog shows instead. The browser reads a chosen file only
 * when asked, and File.text() rejects when it cannot (the file was moved, changed or deleted after it was
 * chosen, or access to it was lost). This never rejects.
 */
export async function readChosenFile(file: Blob): Promise<{ text: string } | { error: string }> {
  try {
    return { text: await file.text() };
  } catch {
    return { error: UNREADABLE_FILE };
  }
}
