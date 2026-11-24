import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** The sync controls render text only, keep nothing in browser storage, never copy the pairing code, and never set a credential. */
test('the sync controls render text only and keep no secret anywhere', () => {
  const files = sources(here);
  assert.ok(files.length >= 15, `found ${files.length} files`);
  const rules: Array<[RegExp, string]> = [
    [/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, 'HTML injection'],
    [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'browser storage'],
    [/navigator\.clipboard|execCommand\(/, 'clipboard'],
    [/['"]Authorization['"]|Authorization:\s*[`'"]|HoldrDevice\s|HoldrPair\s/, 'a credential header'],
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, what] of rules) assert.doesNotMatch(text, pattern, `${path.relative(here, file)}: ${what}`);
  }
});

test('only the dev mock and the tests reach the fake Holdr', () => {
  for (const file of sources(here)) {
    const name = path.relative(here, file).replace(/\\/g, '/');
    if (name === 'devMock.ts' || name === 'fakeOwnerServer.ts' || name.startsWith('fake/')) continue;
    const text = readFileSync(file, 'utf8');
    if (name === 'ownerClientFactory.ts') {
      // The one place that may load it, behind a development-only, explicitly set flag.
      assert.match(text, /import\.meta\.env\.DEV && import\.meta\.env\.VITE_HOLDR_CARD_SYNC_MOCK === '1'/);
      assert.match(text, /await import\('\.\/devMock'\)/);
      continue;
    }
    assert.doesNotMatch(text, /from '\.\/(?:fakeOwnerServer|devMock)'|from '\.\/fake\/|import\('\.\/(?:fakeOwnerServer|devMock)'\)/, name);
  }
});
