import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UNREADABLE_FILE, readChosenFile } from './spendingImportFile';

/** A chosen file the browser can no longer read: Chromium's File.text() rejects like this once it was moved, changed or deleted. */
class UnreadableFile extends File {
  reads = 0;

  override text(): Promise<string> {
    this.reads += 1;
    return Promise.reject(new DOMException(
      'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.',
      'NotReadableError',
    ));
  }
}

test('a file the browser cannot read gives the error the import dialog shows, and nothing is thrown', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const file = new UnreadableFile(['{}'], 'statement.json', { type: 'application/json' });
    const chosen = readChosenFile(file);
    await assert.doesNotReject(chosen);
    assert.deepEqual(await chosen, { error: UNREADABLE_FILE });
    assert.equal(file.reads, 1);
    // Node reports a rejection nobody handled once the microtasks have run.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a readable file gives its text', async () => {
  const json = '{"format":"holdr.card-import","version":1}';
  assert.deepEqual(await readChosenFile(new File([json], 'statement.json', { type: 'application/json' })), { text: json });
});
