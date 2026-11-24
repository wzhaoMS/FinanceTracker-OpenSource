import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const here = new URL('./', import.meta.url);

/** The shipped card-sync sources: everything but tests and the Node-only fixture generator. */
function sources(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  for (const name of readdirSync(here)) {
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push([name, readFileSync(new URL(name, here), 'utf8')]);
  }
  for (const name of readdirSync(new URL('./__fixtures__/', here))) {
    if (name.endsWith('.ts') && name !== 'generate.ts') files.push([`__fixtures__/${name}`, readFileSync(new URL(`./__fixtures__/${name}`, here), 'utf8')]);
  }
  return files;
}

/** The card-sync sources and every shared module they import, transitively: what an extension bundle ships. */
function bundled(): Array<[string, string]> {
  const seen = new Map<string, string>();
  const queue = sources().map(([name]) => new URL(name, here));
  while (queue.length > 0) {
    const url = queue.pop()!;
    if (seen.has(url.href)) continue;
    const text = readFileSync(url, 'utf8');
    seen.set(url.href, text);
    for (const [, specifier] of text.matchAll(/from '(\.[^']+)\.js'/g)) queue.push(new URL(`${specifier}.ts`, url));
  }
  const root = new URL('../', here).href;
  return [...seen].map(([href, text]) => [href.slice(root.length), text]);
}

function code(text: string): string {
  // Comments may name things the code must not use.
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('card-sync sources', () => {
  it('use no Node-only or platform APIs, nor does any shared module they import, so the browser extension can bundle them', () => {
    const files = bundled();
    // Phase 1-3 modules the toolkit builds on are bundled too.
    for (const name of ['cardNumbers.ts', 'cardSecrets.ts', 'cardText.ts', 'cardDedupe.ts', 'cardImport.ts', 'cardImportTool/leaks.ts']) {
      assert.ok(files.some(([file]) => file === name), name);
    }
    for (const [name, text] of files) {
      const body = code(text);
      for (const banned of [/from 'node:/, /\brequire\(/, /\bBuffer\b/, /\bprocess\./, /__dirname/, /\bTextEncoder\b/, /\bcrypto\./, /\bfetch\(/, /\beval\(/, /new Function\(/]) {
        assert.doesNotMatch(body, banned, `${name}: ${banned}`);
      }
    }
  });

  it('import only Holdr’s own shared modules', () => {
    for (const [name, text] of sources()) {
      for (const [, specifier] of text.matchAll(/from '([^']+)'/g)) {
        assert.match(specifier, /^\.\.?\/(?:\.\.\/)?[A-Za-z_][\w/.-]*\.js$/, `${name}: ${specifier}`);
      }
    }
  });

  it("never call v1's sanitizeCardText (its truncation is not part of the v2 pipeline)", () => {
    for (const [name, text] of sources()) assert.doesNotMatch(code(text), /sanitizeCardText/, name);
  });

  it('never do money arithmetic in floating point', () => {
    for (const [name, text] of sources()) {
      const body = code(text);
      for (const banned of [/parseFloat/, /\*\s*100\b/, /\/\s*100\b/, /toFixed\(/, /Math\.round\(/]) assert.doesNotMatch(body, banned, `${name}: ${banned}`);
    }
  });

  it('keep the shared package free of runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', here), 'utf8'));
    assert.equal(manifest.dependencies, undefined);
  });
});
